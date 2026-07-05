// OpenSnag — panoramic capture control panel.
// Scroll the target content between snaps; frames are stitched on Finish.

document.getElementById('snap').addEventListener('click', () => window.opensnag.panoSnap());
document.getElementById('finish').addEventListener('click', () => window.opensnag.panoFinish());
document.getElementById('cancel').addEventListener('click', () => window.opensnag.panoCancel());

window.opensnag.onPanoCount((n) => {
  document.getElementById('count').textContent = `${n} frame${n === 1 ? '' : 's'}`;
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.opensnag.panoCancel();
  if (e.key === 'Enter') window.opensnag.panoFinish();
  if (e.key === ' ') window.opensnag.panoSnap();
});
