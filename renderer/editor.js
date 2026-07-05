// OpenSnag — image editor.
// A vector-object annotation editor over a raster base image.
// Objects stay editable (select / move / resize / delete) until export,
// when everything is flattened into the output bitmap.

(function () {
  'use strict';

  const canvas = document.getElementById('editor-canvas');
  const wrap = document.getElementById('canvas-wrap');
  const stage = document.getElementById('editor-stage');
  const emptyMsg = document.getElementById('editor-empty');
  const textInput = document.getElementById('text-input');
  const ctx = canvas.getContext('2d');

  const HANDLE = 7; // px, screen-space size of resize handles

  const state = {
    baseImage: null,      // HTMLImageElement (current flattened background)
    objects: [],          // vector annotation objects, drawn in order
    selected: null,       // reference into objects
    tool: 'select',
    zoom: 1,
    stepCounter: 1,
    // in-progress interaction
    action: null,         // 'draw' | 'move' | 'resize' | 'endpoint' | 'crop' | 'tail'
    draft: null,          // object being drawn
    dragStart: null,
    resizeHandle: null,
    cropRect: null,
    // style props (bound to the toolbar)
    color: '#e91e63',
    fill: 'none',
    strokeWidth: 4,
    fontSize: 24,
    shadow: true,
    stampEmoji: '✅',
    adjustPreview: null, // live filter preview from the Enhance panel
    history: [],
    future: []
  };

  // ------------------------------------------------------------------ utils

  const deepClone = (o) => JSON.parse(JSON.stringify(o));

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function normRect(o) {
    return {
      x: Math.min(o.x, o.x + o.w),
      y: Math.min(o.y, o.y + o.h),
      w: Math.abs(o.w),
      h: Math.abs(o.h)
    };
  }

  function objBounds(o) {
    switch (o.type) {
      case 'arrow':
      case 'line':
        return {
          x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
          w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1)
        };
      case 'pen': {
        const xs = o.points.map((p) => p.x);
        const ys = o.points.map((p) => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      case 'text': {
        const m = measureText(o);
        return { x: o.x, y: o.y, w: m.w, h: m.h };
      }
      case 'step': {
        const r = o.r;
        return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
      }
      case 'stamp': {
        const s = o.size * 0.62;
        return { x: o.x - s, y: o.y - s, w: s * 2, h: s * 2 };
      }
      default:
        return normRect(o);
    }
  }

  function measureText(o) {
    ctx.save();
    ctx.font = `600 ${o.fontSize}px system-ui, sans-serif`;
    const lines = (o.text || '').split('\n');
    let w = 0;
    for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
    ctx.restore();
    return { w: Math.max(w, 10), h: Math.max(lines.length * o.fontSize * 1.3, o.fontSize) };
  }

  // --------------------------------------------------------------- history

  function pushHistory() {
    state.history.push({
      base: state.baseImage ? state.baseImage.src : null,
      objects: deepClone(state.objects),
      stepCounter: state.stepCounter
    });
    if (state.history.length > 50) state.history.shift();
    state.future = [];
  }

  async function restore(snapshot) {
    if (snapshot.base && (!state.baseImage || state.baseImage.src !== snapshot.base)) {
      state.baseImage = await loadImage(snapshot.base);
      sizeCanvas();
    }
    state.objects = deepClone(snapshot.objects);
    state.stepCounter = snapshot.stepCounter;
    state.selected = null;
    render();
  }

  async function undo() {
    if (!state.history.length) return;
    state.future.push({
      base: state.baseImage ? state.baseImage.src : null,
      objects: deepClone(state.objects),
      stepCounter: state.stepCounter
    });
    await restore(state.history.pop());
  }

  async function redo() {
    if (!state.future.length) return;
    state.history.push({
      base: state.baseImage ? state.baseImage.src : null,
      objects: deepClone(state.objects),
      stepCounter: state.stepCounter
    });
    await restore(state.future.pop());
  }

  // -------------------------------------------------------------- rendering

  function sizeCanvas() {
    if (!state.baseImage) return;
    canvas.width = state.baseImage.naturalWidth;
    canvas.height = state.baseImage.naturalHeight;
    applyZoom();
  }

  function applyZoom() {
    if (!state.baseImage) return;
    canvas.style.width = Math.round(canvas.width * state.zoom) + 'px';
    canvas.style.height = Math.round(canvas.height * state.zoom) + 'px';
    document.getElementById('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  }

  function pixelateRegion(c, r) {
    const rect = normRect(r);
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const w = Math.min(Math.round(rect.w), c.canvas.width - x);
    const h = Math.min(Math.round(rect.h), c.canvas.height - y);
    if (w < 2 || h < 2) return;
    const block = Math.max(6, Math.round(Math.max(c.canvas.width, c.canvas.height) / 140));
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.ceil(w / block));
    tmp.height = Math.max(1, Math.ceil(h / block));
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(c.canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    c.imageSmoothingEnabled = true;
  }

  function withShadow(c, o, fn) {
    c.save();
    if (o.shadow) {
      c.shadowColor = 'rgba(0,0,0,0.45)';
      c.shadowBlur = 6;
      c.shadowOffsetX = 2;
      c.shadowOffsetY = 2;
    }
    fn();
    c.restore();
  }

  function roundRectPath(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function fillStyleFor(o) {
    if (o.fill === 'solid') return o.color;
    if (o.fill === 'translucent') {
      const c = o.color;
      const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
      return `rgba(${r},${g},${b},0.25)`;
    }
    return null;
  }

  function drawObject(c, o) {
    switch (o.type) {
      case 'blur':
        pixelateRegion(c, o);
        break;

      case 'highlight': {
        const r = normRect(o);
        c.save();
        c.globalCompositeOperation = 'multiply';
        c.fillStyle = o.color;
        c.globalAlpha = 0.45;
        c.fillRect(r.x, r.y, r.w, r.h);
        c.restore();
        break;
      }

      case 'rect': {
        const r = normRect(o);
        withShadow(c, o, () => {
          const fill = fillStyleFor(o);
          if (fill) { c.fillStyle = fill; c.fillRect(r.x, r.y, r.w, r.h); }
          c.strokeStyle = o.color;
          c.lineWidth = o.width;
          c.strokeRect(r.x, r.y, r.w, r.h);
        });
        break;
      }

      case 'ellipse': {
        const r = normRect(o);
        withShadow(c, o, () => {
          c.beginPath();
          c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          const fill = fillStyleFor(o);
          if (fill) { c.fillStyle = fill; c.fill(); }
          c.strokeStyle = o.color;
          c.lineWidth = o.width;
          c.stroke();
        });
        break;
      }

      case 'line':
        withShadow(c, o, () => {
          c.strokeStyle = o.color;
          c.lineWidth = o.width;
          c.lineCap = 'round';
          c.beginPath();
          c.moveTo(o.x1, o.y1);
          c.lineTo(o.x2, o.y2);
          c.stroke();
        });
        break;

      case 'arrow': {
        withShadow(c, o, () => {
          const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
          const headLen = Math.max(o.width * 3.2, 14);
          const bx = o.x2 - Math.cos(angle) * headLen * 0.8;
          const by = o.y2 - Math.sin(angle) * headLen * 0.8;
          c.strokeStyle = o.color;
          c.fillStyle = o.color;
          c.lineWidth = o.width;
          c.lineCap = 'round';
          c.beginPath();
          c.moveTo(o.x1, o.y1);
          c.lineTo(bx, by);
          c.stroke();
          c.beginPath();
          c.moveTo(o.x2, o.y2);
          c.lineTo(o.x2 - Math.cos(angle - 0.44) * headLen, o.y2 - Math.sin(angle - 0.44) * headLen);
          c.lineTo(o.x2 - Math.cos(angle + 0.44) * headLen, o.y2 - Math.sin(angle + 0.44) * headLen);
          c.closePath();
          c.fill();
        });
        break;
      }

      case 'pen': {
        if (o.points.length < 2) break;
        withShadow(c, o, () => {
          c.strokeStyle = o.color;
          c.lineWidth = o.width;
          c.lineCap = 'round';
          c.lineJoin = 'round';
          c.beginPath();
          c.moveTo(o.points[0].x, o.points[0].y);
          for (let i = 1; i < o.points.length - 1; i++) {
            const mx = (o.points[i].x + o.points[i + 1].x) / 2;
            const my = (o.points[i].y + o.points[i + 1].y) / 2;
            c.quadraticCurveTo(o.points[i].x, o.points[i].y, mx, my);
          }
          const last = o.points[o.points.length - 1];
          c.lineTo(last.x, last.y);
          c.stroke();
        });
        break;
      }

      case 'text': {
        withShadow(c, o, () => {
          c.font = `600 ${o.fontSize}px system-ui, sans-serif`;
          c.fillStyle = o.color;
          c.textBaseline = 'top';
          const lines = (o.text || '').split('\n');
          lines.forEach((line, i) => c.fillText(line, o.x, o.y + i * o.fontSize * 1.3));
        });
        break;
      }

      case 'callout': {
        const r = normRect(o);
        withShadow(c, o, () => {
          // tail
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          c.fillStyle = '#ffffff';
          c.strokeStyle = o.color;
          c.lineWidth = o.width;
          c.beginPath();
          const ang = Math.atan2(o.tailY - cy, o.tailX - cx);
          const spread = 0.35;
          c.moveTo(o.tailX, o.tailY);
          c.lineTo(cx + Math.cos(ang + spread) * Math.min(r.w, r.h) * 0.35,
                   cy + Math.sin(ang + spread) * Math.min(r.w, r.h) * 0.35);
          c.lineTo(cx + Math.cos(ang - spread) * Math.min(r.w, r.h) * 0.35,
                   cy + Math.sin(ang - spread) * Math.min(r.w, r.h) * 0.35);
          c.closePath();
          c.fill();
          c.stroke();
          // bubble
          roundRectPath(c, r.x, r.y, r.w, r.h, 10);
          c.fill();
          c.stroke();
        });
        // text
        c.save();
        c.font = `600 ${o.fontSize}px system-ui, sans-serif`;
        c.fillStyle = '#20232a';
        c.textBaseline = 'top';
        const lines = (o.text || '').split('\n');
        const totalH = lines.length * o.fontSize * 1.3;
        lines.forEach((line, i) => {
          const lw = c.measureText(line).width;
          c.fillText(line,
            r.x + (r.w - lw) / 2,
            r.y + (r.h - totalH) / 2 + i * o.fontSize * 1.3);
        });
        c.restore();
        break;
      }

      case 'cutout': { // only ever drawn as an in-progress draft
        const r = normRect(o);
        c.save();
        c.fillStyle = 'rgba(233, 30, 99, 0.25)';
        c.fillRect(r.x, r.y, r.w, r.h);
        c.setLineDash([8, 6]);
        c.strokeStyle = '#e91e63';
        c.lineWidth = 2;
        c.strokeRect(r.x, r.y, r.w, r.h);
        c.restore();
        break;
      }

      case 'spotlight': {
        const r = normRect(o);
        c.save();
        c.fillStyle = `rgba(0,0,0,${o.dim ?? 0.55})`;
        c.beginPath();
        c.rect(0, 0, c.canvas.width, c.canvas.height);
        c.rect(r.x, r.y, r.w, r.h);
        c.fill('evenodd');
        c.restore();
        break;
      }

      case 'magnify': {
        const r = normRect(o);
        if (r.w < 4 || r.h < 4 || !state.baseImage) break;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const zoom = o.zoom || 2;
        const sw = r.w / zoom, sh = r.h / zoom;
        c.save();
        c.beginPath();
        c.ellipse(cx, cy, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        c.clip();
        c.imageSmoothingQuality = 'high';
        c.drawImage(state.baseImage, cx - sw / 2, cy - sh / 2, sw, sh, r.x, r.y, r.w, r.h);
        c.restore();
        withShadow(c, o, () => {
          c.beginPath();
          c.ellipse(cx, cy, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          c.strokeStyle = o.color;
          c.lineWidth = o.width;
          c.stroke();
        });
        break;
      }

      case 'stamp': {
        withShadow(c, o, () => {
          c.font = `${o.size}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(o.emoji, o.x, o.y);
        });
        break;
      }

      case 'step': {
        withShadow(c, o, () => {
          c.beginPath();
          c.arc(o.x, o.y, o.r, 0, Math.PI * 2);
          c.fillStyle = o.color;
          c.fill();
          c.strokeStyle = '#ffffff';
          c.lineWidth = 3;
          c.stroke();
        });
        c.save();
        c.font = `700 ${Math.round(o.r * 1.1)}px system-ui, sans-serif`;
        c.fillStyle = '#fff';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(o.n), o.x, o.y + o.r * 0.06);
        c.restore();
        break;
      }
    }
  }

  function render(forExport) {
    if (!state.baseImage) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.adjustPreview) ctx.filter = adjustFilterString(state.adjustPreview);
    ctx.drawImage(state.baseImage, 0, 0);
    ctx.filter = 'none';
    for (const o of state.objects) drawObject(ctx, o);
    if (state.draft) drawObject(ctx, state.draft);
    if (forExport) return;

    // selection chrome
    if (state.selected) drawSelection(state.selected);
    if (state.cropRect) drawCropOverlay();
  }

  function drawSelection(o) {
    const b = objBounds(o);
    const s = 1 / state.zoom;
    ctx.save();
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 1.5 * s;
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    ctx.setLineDash([]);
    ctx.fillStyle = '#4fc3f7';
    for (const h of selectionHandles(o)) {
      ctx.fillRect(h.x - HANDLE * s / 2, h.y - HANDLE * s / 2, HANDLE * s, HANDLE * s);
    }
    ctx.restore();
  }

  function selectionHandles(o) {
    if (o.type === 'line' || o.type === 'arrow') {
      return [
        { id: 'p1', x: o.x1, y: o.y1 },
        { id: 'p2', x: o.x2, y: o.y2 }
      ];
    }
    if (o.type === 'callout') {
      const b = objBounds(o);
      return [
        { id: 'nw', x: b.x, y: b.y }, { id: 'ne', x: b.x + b.w, y: b.y },
        { id: 'sw', x: b.x, y: b.y + b.h }, { id: 'se', x: b.x + b.w, y: b.y + b.h },
        { id: 'tail', x: o.tailX, y: o.tailY }
      ];
    }
    if (['rect', 'ellipse', 'highlight', 'blur', 'spotlight', 'magnify'].includes(o.type)) {
      const b = objBounds(o);
      return [
        { id: 'nw', x: b.x, y: b.y }, { id: 'ne', x: b.x + b.w, y: b.y },
        { id: 'sw', x: b.x, y: b.y + b.h }, { id: 'se', x: b.x + b.w, y: b.y + b.h }
      ];
    }
    return [];
  }

  function drawCropOverlay() {
    const r = normRect(state.cropRect);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    const s = 1 / state.zoom;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * s;
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // ------------------------------------------------------------ hit testing

  function hitTest(x, y) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type === 'line' || o.type === 'arrow') {
        if (distToSegment(x, y, o.x1, o.y1, o.x2, o.y2) < Math.max(o.width, 8)) return o;
      } else {
        const b = objBounds(o);
        const pad = 6;
        if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return o;
      }
    }
    return null;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function handleAt(o, x, y) {
    const s = 1 / state.zoom;
    const tol = HANDLE * s;
    for (const h of selectionHandles(o)) {
      if (Math.abs(x - h.x) <= tol && Math.abs(y - h.y) <= tol) return h.id;
    }
    return null;
  }

  // --------------------------------------------------------- text editing

  let editingTextObj = null;

  function openTextInput(o, isNew) {
    editingTextObj = o;
    o._editing = true;
    textInput.value = o.text || '';
    textInput.style.display = 'block';
    textInput.style.fontSize = o.fontSize * state.zoom + 'px';
    textInput.style.color = o.type === 'callout' ? '#20232a' : o.color;
    const b = o.type === 'callout' ? normRect(o) : { x: o.x, y: o.y };
    textInput.style.left = b.x * state.zoom + 'px';
    textInput.style.top = b.y * state.zoom + 'px';
    textInput.style.width = Math.max(120, (o.type === 'callout' ? normRect(o).w : 160) * state.zoom) + 'px';
    textInput.dataset.isNew = isNew ? '1' : '';
    autoGrow();
    setTimeout(() => textInput.focus(), 0);
    render();
  }

  function autoGrow() {
    textInput.style.height = 'auto';
    textInput.style.height = textInput.scrollHeight + 'px';
  }
  textInput.addEventListener('input', autoGrow);

  function commitTextInput(cancel) {
    if (!editingTextObj) return;
    const o = editingTextObj;
    editingTextObj = null;
    delete o._editing;
    textInput.style.display = 'none';
    const value = textInput.value.replace(/\s+$/, '');
    if (cancel || !value) {
      // Remove brand-new empty objects; keep existing ones as they were.
      if (textInput.dataset.isNew) {
        state.objects = state.objects.filter((x) => x !== o);
        state.history.pop();
      }
    } else {
      o.text = value;
    }
    state.selected = null;
    render();
  }

  textInput.addEventListener('blur', () => commitTextInput(false));
  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') commitTextInput(true);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitTextInput(false);
  });

  // ---------------------------------------------------------- mouse events

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / state.zoom,
      y: (e.clientY - rect.top) / state.zoom
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!state.baseImage || e.button !== 0) return;
    if (editingTextObj) { textInput.blur(); return; }
    const p = canvasPoint(e);
    const t = state.tool;

    if (t === 'select') {
      if (state.selected) {
        const h = handleAt(state.selected, p.x, p.y);
        if (h) {
          pushHistory();
          state.action = h === 'p1' || h === 'p2' ? 'endpoint' : h === 'tail' ? 'tail' : 'resize';
          state.resizeHandle = h;
          state.dragStart = p;
          return;
        }
      }
      const hit = hitTest(p.x, p.y);
      state.selected = hit;
      if (hit) {
        pushHistory();
        state.action = 'move';
        state.dragStart = p;
      }
      render();
      return;
    }

    if (t === 'crop') {
      state.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
      state.action = 'crop';
      state.dragStart = p;
      return;
    }

    if (t === 'text') {
      pushHistory();
      const o = { type: 'text', x: p.x, y: p.y, text: '', color: state.color, fontSize: state.fontSize, shadow: state.shadow };
      state.objects.push(o);
      openTextInput(o, true);
      return;
    }

    if (t === 'step') {
      pushHistory();
      state.objects.push({
        type: 'step', x: p.x, y: p.y,
        r: Math.max(14, state.fontSize * 0.75),
        n: state.stepCounter++,
        color: state.color, shadow: state.shadow
      });
      render();
      return;
    }

    if (t === 'stamp') {
      pushHistory();
      state.objects.push({
        type: 'stamp', x: p.x, y: p.y,
        size: state.fontSize * 2.2,
        emoji: state.stampEmoji,
        shadow: state.shadow
      });
      render();
      return;
    }

    // drag-to-draw tools
    pushHistory();
    state.action = 'draw';
    state.dragStart = p;
    if (t === 'pen') {
      state.draft = { type: 'pen', points: [p], color: state.color, width: state.strokeWidth, shadow: state.shadow };
    } else if (t === 'line' || t === 'arrow') {
      state.draft = { type: t, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: state.color, width: state.strokeWidth, shadow: state.shadow };
    } else if (t === 'highlight') {
      state.draft = { type: 'highlight', x: p.x, y: p.y, w: 0, h: 0, color: '#ffee33' };
    } else if (t === 'blur') {
      state.draft = { type: 'blur', x: p.x, y: p.y, w: 0, h: 0 };
    } else if (t === 'spotlight') {
      state.draft = { type: 'spotlight', x: p.x, y: p.y, w: 0, h: 0, dim: 0.55 };
    } else if (t === 'magnify') {
      state.draft = { type: 'magnify', x: p.x, y: p.y, w: 0, h: 0, zoom: 2, color: state.color, width: Math.max(3, state.strokeWidth), shadow: state.shadow };
    } else if (t === 'cutout') {
      state.draft = { type: 'cutout', x: p.x, y: p.y, w: 0, h: 0 };
    } else if (t === 'callout') {
      state.draft = {
        type: 'callout', x: p.x, y: p.y, w: 0, h: 0,
        tailX: p.x - 30, tailY: p.y + 60,
        text: '', color: state.color, width: Math.max(2, state.strokeWidth * 0.6),
        fontSize: state.fontSize, shadow: state.shadow
      };
    } else { // rect / ellipse
      state.draft = { type: t, x: p.x, y: p.y, w: 0, h: 0, color: state.color, fill: state.fill, width: state.strokeWidth, shadow: state.shadow };
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.baseImage || !state.action) return;
    const p = canvasPoint(e);

    if (state.action === 'draw' && state.draft) {
      const d = state.draft;
      if (d.type === 'pen') {
        d.points.push(p);
      } else if (d.type === 'line' || d.type === 'arrow') {
        d.x2 = p.x; d.y2 = p.y;
        if (e.shiftKey) { // snap to 45°
          const ang = Math.atan2(d.y2 - d.y1, d.x2 - d.x1);
          const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
          d.x2 = d.x1 + Math.cos(snap) * len;
          d.y2 = d.y1 + Math.sin(snap) * len;
        }
      } else {
        d.w = p.x - d.x;
        d.h = p.y - d.y;
        if (e.shiftKey) { const m = Math.max(Math.abs(d.w), Math.abs(d.h)); d.w = Math.sign(d.w || 1) * m; d.h = Math.sign(d.h || 1) * m; }
        if (d.type === 'callout') { d.tailX = d.x - 30; d.tailY = d.y + Math.abs(d.h) + 50; }
      }
      render();
      return;
    }

    if (state.action === 'crop' && state.cropRect) {
      state.cropRect.w = p.x - state.cropRect.x;
      state.cropRect.h = p.y - state.cropRect.y;
      render();
      return;
    }

    const o = state.selected;
    if (!o) return;
    const dx = p.x - state.dragStart.x;
    const dy = p.y - state.dragStart.y;
    state.dragStart = p;

    if (state.action === 'move') {
      moveObject(o, dx, dy);
    } else if (state.action === 'endpoint') {
      if (state.resizeHandle === 'p1') { o.x1 += dx; o.y1 += dy; }
      else { o.x2 += dx; o.y2 += dy; }
    } else if (state.action === 'tail') {
      o.tailX += dx; o.tailY += dy;
    } else if (state.action === 'resize') {
      resizeObject(o, state.resizeHandle, dx, dy);
    }
    render();
  });

  function moveObject(o, dx, dy) {
    if (o.type === 'line' || o.type === 'arrow') {
      o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
    } else if (o.type === 'pen') {
      for (const pt of o.points) { pt.x += dx; pt.y += dy; }
    } else if (o.type === 'callout') {
      o.x += dx; o.y += dy; o.tailX += dx; o.tailY += dy;
    } else {
      o.x += dx; o.y += dy;
    }
  }

  function resizeObject(o, handle, dx, dy) {
    // Normalize first so handles behave predictably.
    const r = normRect(o);
    let { x, y, w, h } = r;
    if (handle.includes('n')) { y += dy; h -= dy; }
    if (handle.includes('s')) { h += dy; }
    if (handle.includes('w')) { x += dx; w -= dx; }
    if (handle.includes('e')) { w += dx; }
    o.x = x; o.y = y; o.w = w; o.h = h;
  }

  window.addEventListener('mouseup', async (e) => {
    if (!state.baseImage || !state.action) return;
    const action = state.action;
    state.action = null;
    state.resizeHandle = null;

    if (action === 'draw' && state.draft) {
      const d = state.draft;
      state.draft = null;
      const big = (v) => Math.abs(v) >= 4;
      const keep =
        d.type === 'pen' ? d.points.length > 2 :
        d.type === 'line' || d.type === 'arrow' ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 6 :
        big(d.w) && big(d.h);
      if (keep && d.type === 'cutout') {
        await applyCutout(normRect(d));
        return;
      }
      if (keep) {
        state.objects.push(d);
        if (d.type === 'callout') openTextInput(d, true);
      } else {
        state.history.pop(); // nothing drawn — drop the snapshot
      }
      render();
      return;
    }

    if (action === 'crop' && state.cropRect) {
      const r = normRect(state.cropRect);
      state.cropRect = null;
      if (r.w >= 8 && r.h >= 8) await applyCrop(r);
      else render();
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    if (state.tool !== 'select') return;
    const p = canvasPoint(e);
    const hit = hitTest(p.x, p.y);
    if (hit && (hit.type === 'text' || hit.type === 'callout')) {
      pushHistory();
      state.selected = hit;
      openTextInput(hit, false);
    }
  });

  // ---------------------------------------------------------- base editing

  async function applyCrop(r) {
    pushHistory();
    const off = document.createElement('canvas');
    off.width = Math.round(r.w);
    off.height = Math.round(r.h);
    off.getContext('2d').drawImage(state.baseImage, -Math.round(r.x), -Math.round(r.y));
    state.baseImage = await loadImage(off.toDataURL('image/png'));
    // Shift annotations so they stay glued to the image content.
    for (const o of state.objects) moveObject(o, -r.x, -r.y);
    state.selected = null;
    sizeCanvas();
    render();
    setTool('select');
  }

  // Remove a horizontal or vertical band and join the remaining halves
  // (SnagIt's "cut out"). History was already pushed on mousedown.
  async function applyCutout(r) {
    await flatten();
    const img = state.baseImage;
    const w = img.naturalWidth, h = img.naturalHeight;
    const horizontal = r.w >= r.h; // wide drag removes rows, tall drag removes columns
    const off = document.createElement('canvas');
    const c = off.getContext('2d');
    if (horizontal) {
      const y0 = Math.max(0, Math.round(r.y));
      const y1 = Math.min(h, Math.round(r.y + r.h));
      off.width = w;
      off.height = Math.max(1, h - (y1 - y0));
      c.drawImage(img, 0, 0, w, y0, 0, 0, w, y0);
      c.drawImage(img, 0, y1, w, h - y1, 0, y0, w, h - y1);
    } else {
      const x0 = Math.max(0, Math.round(r.x));
      const x1 = Math.min(w, Math.round(r.x + r.w));
      off.width = Math.max(1, w - (x1 - x0));
      off.height = h;
      c.drawImage(img, 0, 0, x0, h, 0, 0, x0, h);
      c.drawImage(img, x1, 0, w - x1, h, x0, 0, w - x1, h);
    }
    state.baseImage = await loadImage(off.toDataURL('image/png'));
    sizeCanvas();
    render();
    setTool('select');
  }

  // ------------------------------------------------- enhance / adjustments

  function adjustFilterString(a) {
    return `brightness(${a.brightness}%) contrast(${a.contrast}%) ` +
           `saturate(${a.saturate}%) hue-rotate(${a.hue}deg)` +
           (a.blur > 0 ? ` blur(${a.blur}px)` : '');
  }

  function sharpenImageData(imgData, amount) {
    // Unsharp-style 3x3 kernel: center 1+4k, cross -k.
    const k = amount;
    const { width: w, height: h, data: src } = imgData;
    const out = new Uint8ClampedArray(src);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const v =
            src[i + ch] * (1 + 4 * k) -
            k * (src[i - 4 + ch] + src[i + 4 + ch] +
                 src[i - w * 4 + ch] + src[i + w * 4 + ch]);
          out[i + ch] = v;
        }
      }
    }
    return new ImageData(out, w, h);
  }

  async function applyAdjustments(a) {
    if (!state.baseImage) return;
    pushHistory();
    const img = state.baseImage;
    const off = document.createElement('canvas');
    off.width = img.naturalWidth;
    off.height = img.naturalHeight;
    const c = off.getContext('2d');
    c.filter = adjustFilterString(a);
    c.drawImage(img, 0, 0);
    c.filter = 'none';
    if (a.sharpen > 0) {
      const d = c.getImageData(0, 0, off.width, off.height);
      c.putImageData(sharpenImageData(d, a.sharpen / 100), 0, 0);
    }
    state.baseImage = await loadImage(off.toDataURL('image/png'));
    state.adjustPreview = null;
    sizeCanvas();
    render();
  }

  // Flatten current annotations into the base image (used before effects).
  async function flatten() {
    if (!state.objects.length) return;
    render(true);
    state.baseImage = await loadImage(canvas.toDataURL('image/png'));
    state.objects = [];
    state.selected = null;
  }

  async function applyEffect(effect) {
    if (!state.baseImage) return;

    // Collect any user input BEFORE flattening, so cancelling leaves the
    // document untouched (annotations still editable, no history entry).
    let inputText = null;
    let newWidth = 0;
    if (effect === 'caption' || effect === 'watermark') {
      inputText = await window.appPrompt(effect === 'caption' ? 'Caption text:' : 'Watermark text:');
      if (!inputText) return;
    } else if (effect === 'resize') {
      const answer = await window.appPrompt('New width in pixels:', String(state.baseImage.naturalWidth));
      newWidth = parseInt(answer, 10);
      if (!newWidth || newWidth < 8 || newWidth > 20000) return;
    }

    pushHistory();
    await flatten();
    const img = state.baseImage;
    const w = img.naturalWidth, h = img.naturalHeight;
    const off = document.createElement('canvas');
    const c = off.getContext('2d');

    switch (effect) {
      case 'border': {
        const bw = Math.max(4, Math.round(Math.max(w, h) * 0.008));
        off.width = w + bw * 2; off.height = h + bw * 2;
        c.fillStyle = state.color;
        c.fillRect(0, 0, off.width, off.height);
        c.drawImage(img, bw, bw);
        break;
      }
      case 'shadow': {
        const pad = Math.max(24, Math.round(Math.max(w, h) * 0.03));
        off.width = w + pad * 2; off.height = h + pad * 2;
        c.shadowColor = 'rgba(0,0,0,0.5)';
        c.shadowBlur = pad * 0.6;
        c.shadowOffsetY = pad * 0.25;
        c.fillStyle = '#fff';
        c.fillRect(pad, pad, w, h);
        c.shadowColor = 'transparent';
        c.drawImage(img, pad, pad);
        break;
      }
      case 'rounded': {
        off.width = w; off.height = h;
        roundRectPath(c, 0, 0, w, h, Math.max(12, Math.round(Math.min(w, h) * 0.03)));
        c.clip();
        c.drawImage(img, 0, 0);
        break;
      }
      case 'rotate': {
        off.width = h; off.height = w;
        c.translate(h, 0);
        c.rotate(Math.PI / 2);
        c.drawImage(img, 0, 0);
        break;
      }
      case 'flip-h': {
        off.width = w; off.height = h;
        c.translate(w, 0); c.scale(-1, 1);
        c.drawImage(img, 0, 0);
        break;
      }
      case 'flip-v': {
        off.width = w; off.height = h;
        c.translate(0, h); c.scale(1, -1);
        c.drawImage(img, 0, 0);
        break;
      }
      case 'grayscale': {
        off.width = w; off.height = h;
        c.filter = 'grayscale(1)';
        c.drawImage(img, 0, 0);
        break;
      }
      case 'resize': {
        const nh = Math.round(h * (newWidth / w));
        off.width = newWidth; off.height = nh;
        c.imageSmoothingQuality = 'high';
        c.drawImage(img, 0, 0, newWidth, nh);
        break;
      }
      case 'caption': {
        const text = inputText;
        const fs = Math.max(16, Math.round(w / 32));
        const barH = Math.round(fs * 2.2);
        off.width = w; off.height = h + barH;
        c.drawImage(img, 0, 0);
        c.fillStyle = '#1c1e24';
        c.fillRect(0, h, w, barH);
        c.fillStyle = '#f2f3f6';
        c.font = `600 ${fs}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(text, w / 2, h + barH / 2, w - 24);
        break;
      }
      case 'watermark': {
        const text = inputText;
        off.width = w; off.height = h;
        c.drawImage(img, 0, 0);
        c.save();
        c.translate(w / 2, h / 2);
        c.rotate(-Math.PI / 7);
        c.globalAlpha = 0.16;
        c.fillStyle = state.color;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        let fs = Math.round(w / 6);
        c.font = `700 ${fs}px system-ui, sans-serif`;
        // shrink until it fits the diagonal
        while (fs > 12 && c.measureText(text).width > w * 1.1) {
          fs = Math.round(fs * 0.9);
          c.font = `700 ${fs}px system-ui, sans-serif`;
        }
        c.fillText(text, 0, 0);
        c.restore();
        break;
      }
      default:
        state.history.pop();
        return;
    }

    state.baseImage = await loadImage(off.toDataURL('image/png'));
    sizeCanvas();
    render();
  }

  // ------------------------------------------------------------- tool state

  function setTool(tool) {
    state.tool = tool;
    state.selected = null;
    state.cropRect = null;
    document.querySelectorAll('.tool-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.tool === tool));
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    if (state.baseImage) render();
  }

  document.querySelectorAll('.tool-btn').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  // property bindings
  document.getElementById('prop-color').addEventListener('input', (e) => {
    state.color = e.target.value;
    if (state.selected && state.selected.color) { state.selected.color = state.color; render(); }
  });
  document.getElementById('prop-fill').addEventListener('change', (e) => {
    state.fill = e.target.value;
    if (state.selected && 'fill' in state.selected) { state.selected.fill = state.fill; render(); }
  });
  document.getElementById('prop-width').addEventListener('input', (e) => {
    state.strokeWidth = +e.target.value;
    if (state.selected && state.selected.width) { state.selected.width = state.strokeWidth; render(); }
  });
  document.getElementById('prop-fontsize').addEventListener('change', (e) => {
    state.fontSize = +e.target.value;
    if (state.selected && state.selected.fontSize) { state.selected.fontSize = state.fontSize; render(); }
  });
  document.getElementById('prop-shadow').addEventListener('change', (e) => {
    state.shadow = e.target.checked;
    if (state.selected && 'shadow' in state.selected) { state.selected.shadow = state.shadow; render(); }
  });
  document.getElementById('prop-stamp').addEventListener('change', (e) => {
    state.stampEmoji = e.target.value;
    if (state.selected && state.selected.type === 'stamp') { state.selected.emoji = state.stampEmoji; render(); }
  });

  // ------------------------------------------------------ enhance panel

  const adjustPanel = document.getElementById('adjust-panel');
  const adjustDefaults = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, sharpen: 0 };

  function readAdjustSliders() {
    return {
      brightness: +document.getElementById('adj-brightness').value,
      contrast: +document.getElementById('adj-contrast').value,
      saturate: +document.getElementById('adj-saturate').value,
      hue: +document.getElementById('adj-hue').value,
      blur: +document.getElementById('adj-blur').value,
      sharpen: +document.getElementById('adj-sharpen').value
    };
  }

  function resetAdjustSliders() {
    for (const [k, v] of Object.entries(adjustDefaults)) {
      document.getElementById('adj-' + k).value = v;
    }
  }

  document.getElementById('btn-adjust').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.baseImage) return;
    const open = adjustPanel.classList.toggle('open');
    if (open) {
      resetAdjustSliders();
      state.adjustPreview = null;
      render();
    }
  });
  adjustPanel.addEventListener('click', (e) => e.stopPropagation());

  for (const k of Object.keys(adjustDefaults)) {
    document.getElementById('adj-' + k).addEventListener('input', () => {
      // sharpen is convolution-only, so it isn't part of the live preview
      state.adjustPreview = readAdjustSliders();
      render();
    });
  }

  document.getElementById('adj-apply').addEventListener('click', async () => {
    adjustPanel.classList.remove('open');
    const a = readAdjustSliders();
    state.adjustPreview = null;
    const changed = Object.entries(adjustDefaults).some(([k, v]) => a[k] !== v);
    if (changed) await applyAdjustments(a);
    else render();
  });

  document.getElementById('adj-cancel').addEventListener('click', () => {
    adjustPanel.classList.remove('open');
    state.adjustPreview = null;
    render();
  });

  // undo / redo / zoom buttons
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
  document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
  document.getElementById('btn-zoom-fit').addEventListener('click', zoomFit);

  function setZoom(z) {
    state.zoom = Math.min(8, Math.max(0.1, z));
    applyZoom();
  }

  function zoomFit() {
    if (!state.baseImage) return;
    const availW = stage.clientWidth - 60;
    const availH = stage.clientHeight - 60;
    if (availW <= 0 || availH <= 0) { setZoom(1); return; } // stage hidden
    setZoom(Math.min(1, availW / canvas.width, availH / canvas.height));
  }

  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  // effects menu
  const effectsMenu = document.getElementById('effects-menu');
  document.getElementById('btn-effects').addEventListener('click', (e) => {
    e.stopPropagation();
    effectsMenu.classList.toggle('open');
  });
  window.addEventListener('click', () => {
    effectsMenu.classList.remove('open');
    // Note: the enhance panel keeps its preview until Apply/Cancel, but close
    // it on outside clicks and drop the preview so the canvas matches reality.
    if (adjustPanel.classList.contains('open')) {
      adjustPanel.classList.remove('open');
      state.adjustPreview = null;
      render();
    }
  });
  effectsMenu.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      effectsMenu.classList.remove('open');
      applyEffect(b.dataset.effect);
    }));

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (editingTextObj) return;
    const inEditor = document.getElementById('view-editor').classList.contains('active');
    if (!inEditor || !state.baseImage) return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      pushHistory();
      state.objects = state.objects.filter((o) => o !== state.selected);
      state.selected = null;
      render();
      return;
    }
    if (e.key === 'Escape') { state.selected = null; state.cropRect = null; render(); return; }
    if (mod) return;
    const keys = { v: 'select', a: 'arrow', l: 'line', r: 'rect', e: 'ellipse', p: 'pen', h: 'highlight', t: 'text', c: 'callout', s: 'step', b: 'blur', x: 'crop', i: 'stamp', o: 'spotlight', m: 'magnify', u: 'cutout' };
    const tool = keys[e.key.toLowerCase()];
    if (tool) setTool(tool);
  });

  // ------------------------------------------------------------- public API

  window.EditorAPI = {
    async open(dataUrl) {
      state.baseImage = await loadImage(dataUrl);
      state.objects = [];
      state.selected = null;
      state.history = [];
      state.future = [];
      state.stepCounter = 1;
      state.draft = null;
      state.cropRect = null;
      emptyMsg.style.display = 'none';
      wrap.style.display = 'block';
      sizeCanvas();
      zoomFit();
      render();
      setTool('select');
    },
    isOpen() {
      return !!state.baseImage;
    },
    exportDataUrl(type = 'image/png', quality) {
      if (!state.baseImage) return null;
      render(true);              // draw without selection chrome
      const url = canvas.toDataURL(type, quality);
      render();                  // put the chrome back
      return url;
    }
  };
})();
