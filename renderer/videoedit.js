// OpenSnag — video editor.
// Non-destructive edit settings (trim / crop / speed / mute / text overlays)
// applied by re-encoding through a canvas + MediaRecorder pipeline.
// Also exports animated GIFs (seek-driven, via GifEncoder) and grabs frames
// into the image editor.

(function () {
  'use strict';

  const state = {
    src: null,          // data:, blob: or file: URL of the source video
    duration: 0,
    width: 0,
    height: 0,
    trimStart: 0,
    trimEnd: 0,
    crop: null,         // {x,y,w,h} in source pixels
    speed: 1,
    mute: false,
    overlayText: '',
    overlayPos: 'bottom',
    overlayColor: '#ffffff',
    exporting: false
  };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- helpers

  function loadVideoEl(src) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.onerror = () => reject(new Error('cannot load video'));
      v.onloadedmetadata = async () => {
        // MediaRecorder blobs report Infinity until forced to scan.
        if (!isFinite(v.duration)) {
          await new Promise((r) => {
            const onDur = () => {
              if (isFinite(v.duration)) { v.removeEventListener('durationchange', onDur); r(); }
            };
            v.addEventListener('durationchange', onDur);
            v.currentTime = 1e9;
          });
          v.currentTime = 0;
        }
        resolve(v);
      };
      v.src = src;
    });
  }

  function seekTo(v, t) {
    return new Promise((resolve) => {
      const done = () => { v.removeEventListener('seeked', done); resolve(); };
      v.addEventListener('seeked', done);
      v.currentTime = Math.min(t, Math.max(0, v.duration - 0.01));
    });
  }

  function outputRect() {
    return state.crop || { x: 0, y: 0, w: state.width, h: state.height };
  }

  function drawFrame(ctx, video, outW, outH) {
    const r = outputRect();
    ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, outW, outH);
    if (state.overlayText) {
      const size = Math.max(16, Math.round(outH / 14));
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      const x = outW / 2;
      const y = state.overlayPos === 'top' ? size * 1.4 : outH - size * 0.7;
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(state.overlayText, x, y);
      ctx.fillStyle = state.overlayColor;
      ctx.fillText(state.overlayText, x, y);
    }
  }

  function fmt(t) {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1);
    return `${m}:${s.padStart(4, '0')}`;
  }

  function setProgress(frac, label) {
    const bar = $('ve-progress');
    bar.style.display = frac == null ? 'none' : 'block';
    if (frac != null) {
      $('ve-progress-fill').style.width = Math.round(frac * 100) + '%';
      $('ve-progress-label').textContent = label || '';
    }
  }

  // ------------------------------------------------------------ UI wiring

  function refreshUI() {
    $('ve-trim-start').max = $('ve-trim-end').max = state.duration;
    $('ve-trim-start').value = state.trimStart;
    $('ve-trim-end').value = state.trimEnd;
    $('ve-trim-label').textContent =
      `${fmt(state.trimStart)} → ${fmt(state.trimEnd)}  (of ${fmt(state.duration)})`;
    $('ve-crop-label').textContent = state.crop
      ? `${Math.round(state.crop.w)}×${Math.round(state.crop.h)} @ ${Math.round(state.crop.x)},${Math.round(state.crop.y)}`
      : 'Full frame';
  }

  function bindOnce() {
    if (bindOnce.done) return;
    bindOnce.done = true;

    const player = $('ve-player');

    $('ve-trim-start').addEventListener('input', (e) => {
      state.trimStart = Math.min(+e.target.value, state.trimEnd - 0.1);
      player.currentTime = state.trimStart;
      refreshUI();
    });
    $('ve-trim-end').addEventListener('input', (e) => {
      state.trimEnd = Math.max(+e.target.value, state.trimStart + 0.1);
      player.currentTime = state.trimEnd;
      refreshUI();
    });
    $('ve-set-start').addEventListener('click', () => {
      state.trimStart = Math.min(player.currentTime, state.trimEnd - 0.1);
      refreshUI();
    });
    $('ve-set-end').addEventListener('click', () => {
      state.trimEnd = Math.max(player.currentTime, state.trimStart + 0.1);
      refreshUI();
    });

    // preview loops inside the trim window
    player.addEventListener('timeupdate', () => {
      if (player.currentTime > state.trimEnd + 0.05 || player.currentTime < state.trimStart - 0.5) {
        if (!player.paused) player.currentTime = state.trimStart;
      }
    });

    $('ve-speed').addEventListener('change', (e) => {
      state.speed = +e.target.value;
      player.playbackRate = state.speed;
    });
    $('ve-mute').addEventListener('change', (e) => {
      state.mute = e.target.checked;
      player.muted = state.mute;
    });
    $('ve-text').addEventListener('input', (e) => { state.overlayText = e.target.value; });
    $('ve-text-pos').addEventListener('change', (e) => { state.overlayPos = e.target.value; });
    $('ve-text-color').addEventListener('input', (e) => { state.overlayColor = e.target.value; });

    // ---- crop by dragging over the preview
    const cropLayer = $('ve-crop-layer');
    let cropDrag = null;

    $('ve-crop-btn').addEventListener('click', () => {
      cropLayer.style.display = 'block';
      cropLayer.classList.add('arming');
      $('ve-crop-hint').style.display = 'block';
      player.pause();
    });
    $('ve-crop-clear').addEventListener('click', () => {
      state.crop = null;
      refreshUI();
    });

    cropLayer.addEventListener('mousedown', (e) => {
      const rect = cropLayer.getBoundingClientRect();
      cropDrag = { x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: 0, y1: 0, rect };
    });
    cropLayer.addEventListener('mousemove', (e) => {
      if (!cropDrag) return;
      const rect = cropDrag.rect;
      cropDrag.x1 = e.clientX - rect.left;
      cropDrag.y1 = e.clientY - rect.top;
      const box = $('ve-crop-box');
      box.style.display = 'block';
      box.style.left = Math.min(cropDrag.x0, cropDrag.x1) + 'px';
      box.style.top = Math.min(cropDrag.y0, cropDrag.y1) + 'px';
      box.style.width = Math.abs(cropDrag.x1 - cropDrag.x0) + 'px';
      box.style.height = Math.abs(cropDrag.y1 - cropDrag.y0) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!cropDrag) return;
      const d = cropDrag;
      cropDrag = null;
      cropLayer.style.display = 'none';
      $('ve-crop-box').style.display = 'none';
      $('ve-crop-hint').style.display = 'none';
      const px = Math.abs(d.x1 - d.x0);
      const py = Math.abs(d.y1 - d.y0);
      if (px < 10 || py < 10) return;
      // convert layer coords to source pixels (video is object-fit: contain,
      // but we size the layer to the displayed video box, so plain scaling works)
      const scaleX = state.width / d.rect.width;
      const scaleY = state.height / d.rect.height;
      state.crop = {
        x: Math.max(0, Math.min(d.x0, d.x1) * scaleX),
        y: Math.max(0, Math.min(d.y0, d.y1) * scaleY),
        w: Math.min(state.width, px * scaleX),
        h: Math.min(state.height, py * scaleY)
      };
      refreshUI();
    });

    $('ve-grab-frame').addEventListener('click', grabFrame);
    $('ve-export-webm').addEventListener('click', exportWebM);
    $('ve-export-gif').addEventListener('click', exportGif);
  }

  // -------------------------------------------------------------- actions

  async function grabFrame() {
    const player = $('ve-player');
    const r = outputRect();
    const c = document.createElement('canvas');
    c.width = Math.round(r.w);
    c.height = Math.round(r.h);
    drawFrame(c.getContext('2d'), player, c.width, c.height);
    window.AppShell.openInEditor(c.toDataURL('image/png'));
    window.AppShell.toast('Frame sent to image editor');
  }

  async function exportWebM() {
    if (state.exporting) return;
    state.exporting = true;
    try {
      const video = await loadVideoEl(state.src);
      const r = outputRect();
      const c = document.createElement('canvas');
      c.width = Math.round(r.w / 2) * 2;   // even dimensions for encoders
      c.height = Math.round(r.h / 2) * 2;
      const ctx = c.getContext('2d');
      const stream = c.captureStream(30);

      let audioCtx = null;
      if (!state.mute) {
        try {
          audioCtx = new AudioContext();
          const srcNode = audioCtx.createMediaElementSource(video);
          const dest = audioCtx.createMediaStreamDestination();
          srcNode.connect(dest); // not connected to speakers: silent export
          const track = dest.stream.getAudioTracks()[0];
          if (track) stream.addTrack(track);
          video.muted = false;
          video.volume = 1;
        } catch { /* video without audio track */ }
      }

      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { recorder.onstop = res; });

      await seekTo(video, state.trimStart);
      video.playbackRate = state.speed;

      let raf;
      const span = state.trimEnd - state.trimStart;
      const tick = () => {
        drawFrame(ctx, video, c.width, c.height);
        setProgress(Math.min(1, (video.currentTime - state.trimStart) / span), 'Encoding video…');
        if (video.currentTime >= state.trimEnd || video.ended) {
          recorder.stop();
          video.pause();
          return;
        }
        raf = requestAnimationFrame(tick);
      };

      recorder.start(500);
      await video.play();
      tick();
      await stopped;
      cancelAnimationFrame(raf);
      if (audioCtx) audioCtx.close();

      const blob = new Blob(chunks, { type: 'video/webm' });
      const buf = await blob.arrayBuffer();
      const libPath = await window.opensnag.autosaveVideo(buf);
      const saved = await window.opensnag.exportVideo(libPath);
      window.AppShell.toast(saved ? 'Video exported to ' + saved : 'Edited video kept in library');
    } catch (err) {
      console.error(err);
      window.AppShell.toast('Export failed: ' + err.message);
    } finally {
      setProgress(null);
      state.exporting = false;
    }
  }

  async function exportGif() {
    if (state.exporting) return;
    state.exporting = true;
    try {
      const fps = +$('ve-gif-fps').value;
      const maxW = +$('ve-gif-width').value;
      const video = await loadVideoEl(state.src);
      const r = outputRect();
      const scale = maxW ? Math.min(1, maxW / r.w) : 1;
      const c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(r.w * scale));
      c.height = Math.max(2, Math.round(r.h * scale));
      const ctx = c.getContext('2d');

      const frames = [];
      const step = 1 / fps;
      const span = state.trimEnd - state.trimStart;
      const total = Math.max(1, Math.floor(span / step));
      for (let i = 0; i < total; i++) {
        await seekTo(video, state.trimStart + i * step);
        drawFrame(ctx, video, c.width, c.height);
        frames.push(ctx.getImageData(0, 0, c.width, c.height));
        setProgress((i / total) * 0.7, `Sampling frames… ${i + 1}/${total}`);
      }

      setProgress(0.75, 'Encoding GIF…');
      // Yield so the progress bar paints before the CPU-heavy encode.
      await new Promise((res) => setTimeout(res, 30));
      const gif = window.GifEncoder.encode(frames, {
        delayMs: (step / state.speed) * 1000
      });

      setProgress(0.95, 'Saving…');
      const saved = await window.opensnag.saveGif(gif.buffer);
      window.AppShell.toast(saved ? 'GIF saved to ' + saved : 'GIF kept in library');
    } catch (err) {
      console.error(err);
      window.AppShell.toast('GIF export failed: ' + err.message);
    } finally {
      setProgress(null);
      state.exporting = false;
    }
  }

  // ------------------------------------------------------------ public API

  window.VideoEdit = {
    async open(srcUrl) {
      bindOnce();
      const probe = await loadVideoEl(srcUrl);
      state.src = srcUrl;
      state.duration = probe.duration;
      state.width = probe.videoWidth;
      state.height = probe.videoHeight;
      state.trimStart = 0;
      state.trimEnd = probe.duration;
      state.crop = null;
      state.speed = 1;
      state.mute = false;

      const player = $('ve-player');
      player.src = srcUrl;
      player.playbackRate = 1;
      player.muted = false;
      $('ve-empty').style.display = 'none';
      $('ve-workspace').style.display = 'flex';
      $('ve-speed').value = '1';
      $('ve-mute').checked = false;
      refreshUI();
    },
    isOpen: () => !!state.src,
    // exposed for tests
    _exportWebM: exportWebM,
    _state: state
  };
})();
