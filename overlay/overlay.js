// OpenSnag — region selection overlay.
// Shows the frozen screenshot, lets the user drag a rectangle,
// then reports the rect (in CSS/device-independent pixels) to main.

const shot = document.getElementById('shot');
const veil = document.getElementById('veil');
const dims = document.getElementById('dims');
const hint = document.getElementById('hint');
const ctx = veil.getContext('2d');

let bounds = { width: window.innerWidth, height: window.innerHeight };
let dragging = false;
let moved = false;
let start = { x: 0, y: 0 };
let cur = { x: 0, y: 0 };
let mouse = { x: -100, y: -100 };

window.opensnag.onOverlayInit(({ screenshot, bounds: b }) => {
  shot.src = screenshot;
  bounds = b;
  resize();
});

function resize() {
  veil.width = window.innerWidth * devicePixelRatio;
  veil.height = window.innerHeight * devicePixelRatio;
  veil.style.width = window.innerWidth + 'px';
  veil.style.height = window.innerHeight + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

function selectionRect() {
  const x = Math.min(start.x, cur.x);
  const y = Math.min(start.y, cur.y);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.abs(cur.x - start.x)),
    height: Math.round(Math.abs(cur.y - start.y))
  };
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, w, h);

  if (dragging && moved) {
    const r = selectionRect();
    // Punch a clear hole where the selection is.
    ctx.clearRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = '#e91e63';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
    // Corner handles
    ctx.fillStyle = '#e91e63';
    for (const [hx, hy] of [
      [r.x, r.y], [r.x + r.width, r.y],
      [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]
    ]) {
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
    }
  } else {
    // Crosshair guides that follow the mouse.
    ctx.strokeStyle = 'rgba(233, 30, 99, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mouse.x + 0.5, 0);
    ctx.lineTo(mouse.x + 0.5, h);
    ctx.moveTo(0, mouse.y + 0.5);
    ctx.lineTo(w, mouse.y + 0.5);
    ctx.stroke();
  }
}

function updateDims() {
  if (!dragging || !moved) {
    dims.style.display = 'none';
    return;
  }
  const r = selectionRect();
  dims.textContent = `${r.width} × ${r.height}`;
  dims.style.display = 'block';
  const dx = Math.min(r.x + r.width + 10, window.innerWidth - 90);
  const dy = Math.min(r.y + r.height + 10, window.innerHeight - 30);
  dims.style.left = dx + 'px';
  dims.style.top = dy + 'px';
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  start = cur = { x: e.clientX, y: e.clientY };
  hint.style.display = 'none';
  draw();
});

window.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (dragging) {
    cur = { x: e.clientX, y: e.clientY };
    if (Math.abs(cur.x - start.x) > 3 || Math.abs(cur.y - start.y) > 3) moved = true;
  }
  draw();
  updateDims();
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !dragging) return;
  dragging = false;
  cur = { x: e.clientX, y: e.clientY };
  const r = selectionRect();
  if (moved && r.width >= 3 && r.height >= 3) {
    window.opensnag.regionSelected(r);
  } else {
    // A plain click without a drag: reset and keep the overlay open.
    moved = false;
    hint.style.display = 'block';
    draw();
    updateDims();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.opensnag.regionCancelled();
  } else if (e.key === 'Enter') {
    // Whole frozen screen.
    window.opensnag.regionSelected({
      x: 0, y: 0,
      width: window.innerWidth,
      height: window.innerHeight
    });
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.opensnag.regionCancelled();
});
