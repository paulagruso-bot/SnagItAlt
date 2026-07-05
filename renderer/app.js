// OpenSnag — application shell: views, capture triggers, video recorder,
// source picker and the capture library.

(function () {
  'use strict';

  const api = window.opensnag;

  // ------------------------------------------------------------------ toast

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ------------------------------------------------------------ modal prompt
  // window.prompt() is unsupported in Electron renderers, so provide a
  // minimal in-app replacement. Returns null when cancelled.

  window.appPrompt = function (title, defaultValue = '') {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.id = 'prompt-backdrop';
      backdrop.innerHTML = `
        <div id="prompt-box">
          <div class="prompt-title"></div>
          <input type="text" id="prompt-input" />
          <div class="prompt-actions">
            <button class="btn" id="prompt-cancel">Cancel</button>
            <button class="btn primary" id="prompt-ok">OK</button>
          </div>
        </div>`;
      backdrop.querySelector('.prompt-title').textContent = title;
      document.body.appendChild(backdrop);
      const input = backdrop.querySelector('#prompt-input');
      input.value = defaultValue;
      const done = (val) => { backdrop.remove(); resolve(val); };
      backdrop.querySelector('#prompt-ok').addEventListener('click', () => done(input.value));
      backdrop.querySelector('#prompt-cancel').addEventListener('click', () => done(null));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(input.value);
        if (e.key === 'Escape') done(null);
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  };

  // ------------------------------------------------------------- navigation

  function showView(name) {
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.nav-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === name));
    if (name === 'library') refreshLibrary();
  }

  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view)));

  // ---------------------------------------------------------- image capture

  const delaySel = () => +document.getElementById('capture-delay').value || 0;

  document.getElementById('btn-region').addEventListener('click', () => {
    api.captureRegion({ delayMs: delaySel() });
  });

  document.getElementById('btn-fullscreen').addEventListener('click', async () => {
    const displays = await api.getDisplays();
    if (displays.length <= 1) {
      api.captureFullscreen({ delayMs: delaySel() });
      return;
    }
    // Multiple monitors: let the user pick which one.
    const chosen = await pickSource(
      'Choose a display',
      (await api.listScreenSources()).map((s) => ({
        id: s.displayId, name: s.name, thumbnail: s.thumbnail
      }))
    );
    if (chosen) api.captureFullscreen({ displayId: chosen.id, delayMs: delaySel() });
  });

  document.getElementById('btn-window').addEventListener('click', async () => {
    const sources = await api.listWindowSources();
    if (!sources.length) { toast('No windows available to capture'); return; }
    const chosen = await pickSource('Choose a window', sources);
    if (chosen) api.captureWindow({ sourceId: chosen.id, delayMs: delaySel() });
  });

  document.getElementById('btn-panoramic').addEventListener('click', () => {
    api.capturePanoramic();
  });

  document.getElementById('btn-webpage').addEventListener('click', async () => {
    const url = await window.appPrompt('Web page URL to capture:', 'https://');
    if (!url || url === 'https://') return;
    toast('Loading page…');
    const result = await api.captureWebPage(url);
    if (result && result.error) toast('Web capture failed: ' + result.error);
  });

  // Captures arrive from main (hotkeys or buttons) and open in the editor.
  api.onCaptureComplete(async ({ dataUrl }) => {
    showView('editor'); // before open() so zoom-to-fit sees real dimensions
    await window.EditorAPI.open(dataUrl);
    toast('Capture added to library');
  });

  // Panoramic frames arrive after the user hits Finish; stitch them here.
  api.onPanoramicFrames(async (frames) => {
    if (!frames.length) return;
    toast(`Stitching ${frames.length} frames…`);
    try {
      const stitched = await window.Stitcher.stitch(frames);
      const file = await api.autosaveImage(stitched);
      showView('editor');
      await window.EditorAPI.open(stitched);
      toast(file ? 'Panoramic capture added to library' : 'Panoramic capture ready');
    } catch (err) {
      toast('Stitching failed: ' + err.message);
    }
  });

  // ------------------------------------------------------------ source picker

  function pickSource(title, sources) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('modal-backdrop');
      const grid = document.getElementById('source-grid');
      document.getElementById('source-modal-title').textContent = title;
      grid.innerHTML = '';

      const close = (result) => {
        backdrop.style.display = 'none';
        grid.innerHTML = '';
        document.getElementById('source-modal-close').onclick = null;
        backdrop.onclick = null;
        resolve(result);
      };

      for (const s of sources) {
        const btn = document.createElement('button');
        btn.className = 'source-item';
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = s.thumbnail;
        const name = document.createElement('div');
        name.className = 'name';
        if (s.appIcon) {
          const icon = document.createElement('img');
          icon.src = s.appIcon;
          name.appendChild(icon);
        }
        name.appendChild(document.createTextNode(s.name));
        btn.appendChild(img);
        btn.appendChild(name);
        btn.addEventListener('click', () => close(s));
        grid.appendChild(btn);
      }

      document.getElementById('source-modal-close').onclick = () => close(null);
      backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
      backdrop.style.display = 'flex';
    });
  }

  // ---------------------------------------------------------- video capture

  const rec = {
    source: null,        // {id, name}
    stream: null,
    recorder: null,
    chunks: [],
    blob: null,
    libraryPath: null,   // where the autosaved copy lives
    startedAt: 0,
    pausedTotal: 0,
    pauseStart: 0,
    timerId: null
  };

  const btnPick = document.getElementById('btn-pick-source');
  const btnRecord = document.getElementById('btn-record');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');
  const recTimer = document.getElementById('rec-timer');
  const preview = document.getElementById('video-preview');
  const playback = document.getElementById('video-playback');
  const resultBox = document.getElementById('video-result');

  btnPick.addEventListener('click', async () => {
    const screens = (await api.listScreenSources()).map((s) => ({
      id: s.id, name: s.name, thumbnail: s.thumbnail
    }));
    const windows = await api.listWindowSources();
    const chosen = await pickSource('Choose what to record', [...screens, ...windows]);
    if (!chosen) return;
    rec.source = chosen;
    document.getElementById('video-source-label').textContent = chosen.name;
    btnRecord.disabled = false;
  });

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  function tickTimer() {
    const elapsed = Date.now() - rec.startedAt - rec.pausedTotal;
    recTimer.textContent = fmtTime(elapsed);
  }

  btnRecord.addEventListener('click', async () => {
    if (!rec.source) return;
    try {
      const wantSys = document.getElementById('chk-sysaudio').checked;
      api.selectVideoSource({ sourceId: rec.source.id, systemAudio: wantSys });

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: wantSys
      });

      if (document.getElementById('chk-mic').checked) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          for (const track of mic.getAudioTracks()) stream.addTrack(track);
        } catch {
          toast('Microphone unavailable — recording without narration');
        }
      }

      rec.stream = stream;
      rec.chunks = [];
      rec.blob = null;
      resultBox.style.display = 'none';
      preview.style.display = 'block';
      preview.srcObject = stream;

      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';
      rec.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
      rec.recorder.onstop = onRecordingStopped;
      rec.recorder.start(500);

      rec.startedAt = Date.now();
      rec.pausedTotal = 0;
      rec.timerId = setInterval(tickTimer, 250);
      recTimer.classList.add('live');
      btnRecord.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
      btnPick.disabled = true;
    } catch (err) {
      console.error(err);
      toast('Could not start recording: ' + err.message);
    }
  });

  btnPause.addEventListener('click', () => {
    if (!rec.recorder) return;
    if (rec.recorder.state === 'recording') {
      rec.recorder.pause();
      rec.pauseStart = Date.now();
      btnPause.textContent = '▶ Resume';
    } else if (rec.recorder.state === 'paused') {
      rec.recorder.resume();
      rec.pausedTotal += Date.now() - rec.pauseStart;
      btnPause.textContent = '⏸ Pause';
    }
  });

  btnStop.addEventListener('click', () => {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  });

  function onRecordingStopped() {
    clearInterval(rec.timerId);
    recTimer.classList.remove('live');
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    preview.srcObject = null;
    preview.style.display = 'none';

    rec.blob = new Blob(rec.chunks, { type: 'video/webm' });
    rec.chunks = [];
    playback.src = URL.createObjectURL(rec.blob);
    resultBox.style.display = 'flex';
    document.getElementById('video-saved-label').textContent = '';

    btnRecord.disabled = false;
    btnPause.disabled = true;
    btnPause.textContent = '⏸ Pause';
    btnStop.disabled = true;
    btnPick.disabled = false;

    // Keep a copy in the library right away.
    autosaveRecording();
  }

  async function autosaveRecording() {
    if (!rec.blob) return;
    rec.libraryPath = null;
    const buf = await rec.blob.arrayBuffer();
    rec.libraryPath = await api.autosaveVideo(buf);
    document.getElementById('video-saved-label').textContent =
      'Auto-saved to library';
    toast('Recording added to library');
  }

  document.getElementById('btn-save-video').addEventListener('click', async () => {
    if (!rec.blob) return;
    // Make sure the autosave finished (it is the source of the export copy).
    if (!rec.libraryPath) {
      const buf = await rec.blob.arrayBuffer();
      rec.libraryPath = await api.autosaveVideo(buf);
    }
    const saved = await api.exportVideo(rec.libraryPath);
    if (saved) {
      document.getElementById('video-saved-label').textContent = 'Saved to ' + saved;
      toast('Recording saved');
    }
  });

  document.getElementById('btn-edit-recording').addEventListener('click', () => {
    if (!rec.blob) return;
    showView('videoedit');
    window.VideoEdit.open(URL.createObjectURL(rec.blob));
  });

  document.getElementById('ve-open-file').addEventListener('click', async () => {
    const dataUrl = await api.openVideoDialog();
    if (dataUrl) window.VideoEdit.open(dataUrl);
  });

  api.onHotkey((name) => {
    if (name === 'toggle-recording') {
      showView('video');
      if (rec.recorder && rec.recorder.state !== 'inactive') btnStop.click();
      else if (!btnRecord.disabled) btnRecord.click();
      else btnPick.click();
    }
  });

  // --------------------------------------------------------------- editor IO

  document.getElementById('btn-open-image').addEventListener('click', async () => {
    const dataUrl = await api.openImageDialog();
    if (dataUrl) {
      showView('editor');
      await window.EditorAPI.open(dataUrl);
    }
  });

  // Drag & drop image files anywhere onto the app -> open in editor.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = [...(e.dataTransfer.files || [])].find((f) => /^image\//.test(f.type));
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      showView('editor');
      await window.EditorAPI.open(reader.result);
      toast('Image opened');
    };
    reader.readAsDataURL(file);
  });

  // --------------------------------------------------------------- OCR

  const ocrBackdrop = document.getElementById('ocr-backdrop');
  document.getElementById('ocr-close').addEventListener('click', () => {
    ocrBackdrop.style.display = 'none';
  });
  document.getElementById('ocr-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById('ocr-text').value);
    toast('Text copied to clipboard');
  });

  document.getElementById('btn-ocr').addEventListener('click', async () => {
    const url = window.EditorAPI.exportDataUrl();
    if (!url) return;
    ocrBackdrop.style.display = 'flex';
    document.getElementById('ocr-text').value = '';
    document.getElementById('ocr-status').textContent = 'Recognizing text…';
    const result = await api.ocrImage(url);
    if (result && result.text != null) {
      document.getElementById('ocr-text').value = result.text.trim();
      document.getElementById('ocr-status').textContent =
        result.text.trim() ? 'Done' : 'No text found';
    } else {
      document.getElementById('ocr-status').textContent =
        'OCR failed' + (result && result.error ? ': ' + result.error : '');
    }
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    const url = window.EditorAPI.exportDataUrl();
    if (!url) return;
    const saved = await api.saveImage(url, null);
    if (saved) toast('Saved to ' + saved);
  });

  document.getElementById('btn-copy').addEventListener('click', async () => {
    const url = window.EditorAPI.exportDataUrl();
    if (!url) return;
    await api.copyImage(url);
    toast('Image copied to clipboard');
  });

  window.addEventListener('keydown', async (e) => {
    const inEditor = document.getElementById('view-editor').classList.contains('active');
    if (!inEditor || !(e.ctrlKey || e.metaKey)) return;
    if (document.activeElement === document.getElementById('text-input')) return;
    if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      document.getElementById('btn-save').click();
    } else if (e.key.toLowerCase() === 'c' && !window.getSelection().toString()) {
      e.preventDefault();
      document.getElementById('btn-copy').click();
    }
  });

  // ---------------------------------------------------------------- library

  async function refreshLibrary() {
    const grid = document.getElementById('library-grid');
    grid.innerHTML = '';
    const items = await api.listCaptures();
    if (!items.length) {
      grid.innerHTML = '<p class="muted">Nothing here yet — take a capture!</p>';
      return;
    }

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'lib-item';

      const thumb = document.createElement('div');
      thumb.className = 'lib-thumb';
      card.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'lib-meta';
      const when = new Date(item.mtime).toLocaleString();
      meta.textContent = `${item.name} — ${when}`;
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';

      if (item.type === 'image') {
        const openBtn = document.createElement('button');
        openBtn.className = 'btn';
        openBtn.textContent = 'Edit';
        openBtn.addEventListener('click', async () => {
          const dataUrl = await api.readCapture(item.path);
          if (dataUrl) {
            showView('editor');
            await window.EditorAPI.open(dataUrl);
          }
        });
        actions.appendChild(openBtn);
        thumb.addEventListener('click', () => openBtn.click());
      } else if (item.type === 'video') {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn';
        editBtn.textContent = 'Edit video';
        editBtn.addEventListener('click', async () => {
          const dataUrl = await api.readCapture(item.path);
          if (dataUrl) {
            showView('videoedit');
            window.VideoEdit.open(dataUrl);
          }
        });
        actions.appendChild(editBtn);
      }

      const folderBtn = document.createElement('button');
      folderBtn.className = 'btn';
      folderBtn.textContent = 'Show file';
      folderBtn.addEventListener('click', () => api.showInFolder(item.path));
      actions.appendChild(folderBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        await api.deleteCapture(item.path);
        refreshLibrary();
      });
      actions.appendChild(delBtn);
      card.appendChild(actions);

      // Load thumbnail lazily.
      api.readCapture(item.path).then((dataUrl) => {
        if (!dataUrl) return;
        if (item.type === 'video') {
          const v = document.createElement('video');
          v.src = dataUrl;
          v.muted = true;
          v.controls = true;
          thumb.appendChild(v);
        } else {
          const img = document.createElement('img');
          img.src = dataUrl;
          thumb.appendChild(img);
        }
      });

      grid.appendChild(card);
    }
  }

  // -------------------------------------------------------------- boot

  // Shared surface for the other renderer modules (video editor, etc.)
  window.AppShell = {
    toast,
    showView,
    openInEditor: async (dataUrl) => {
      showView('editor');
      await window.EditorAPI.open(dataUrl);
    }
  };

  showView('capture');
})();
