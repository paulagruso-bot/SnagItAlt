// OpenSnag — preload bridge (shared by the main window and the region overlay)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opensnag', {
  // Capture
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  listWindowSources: () => ipcRenderer.invoke('list-window-sources'),
  listScreenSources: () => ipcRenderer.invoke('list-screen-sources'),
  captureFullscreen: (opts) => ipcRenderer.send('capture-fullscreen', opts || {}),
  captureWindow: (opts) => ipcRenderer.send('capture-window', opts),
  captureRegion: (opts) => ipcRenderer.send('capture-region', opts || {}),
  capturePanoramic: () => ipcRenderer.send('capture-panoramic'),
  captureWebPage: (url) => ipcRenderer.invoke('capture-web-page', url),
  onCaptureComplete: (fn) => ipcRenderer.on('capture-complete', (e, payload) => fn(payload)),
  onPanoramicFrames: (fn) => ipcRenderer.on('panoramic-frames', (e, frames) => fn(frames)),
  onHotkey: (fn) => ipcRenderer.on('hotkey', (e, name) => fn(name)),

  // Hotkey configuration
  platform: process.platform,
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  setHotkey: (id, accelerator) => ipcRenderer.invoke('set-hotkey', { id, accelerator }),
  resetHotkeys: () => ipcRenderer.invoke('reset-hotkeys'),

  // Panoramic control panel (used by panel window only)
  panoSnap: () => ipcRenderer.send('pano-snap'),
  panoFinish: () => ipcRenderer.send('pano-finish'),
  panoCancel: () => ipcRenderer.send('pano-cancel'),
  onPanoCount: (fn) => ipcRenderer.on('pano-count', (e, n) => fn(n)),

  // Video
  selectVideoSource: (opts) => ipcRenderer.send('select-video-source', opts),
  autosaveVideo: (buffer) => ipcRenderer.invoke('autosave-video', buffer),
  exportVideo: (libraryPath) => ipcRenderer.invoke('export-video', libraryPath),

  // Editor output
  saveImage: (dataUrl, defaultName) =>
    ipcRenderer.invoke('save-image', { dataUrl, defaultName }),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  autosaveImage: (dataUrl) => ipcRenderer.invoke('autosave-image', dataUrl),
  saveGif: (buffer) => ipcRenderer.invoke('save-gif', buffer),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  openVideoDialog: () => ipcRenderer.invoke('open-video-dialog'),
  ocrImage: (dataUrl) => ipcRenderer.invoke('ocr-image', dataUrl),

  // Library
  listCaptures: () => ipcRenderer.invoke('list-captures'),
  readCapture: (path) => ipcRenderer.invoke('read-capture', path),
  deleteCapture: (path) => ipcRenderer.invoke('delete-capture', path),
  showInFolder: (path) => ipcRenderer.send('show-in-folder', path),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Region overlay
  onOverlayInit: (fn) => ipcRenderer.on('overlay-init', (e, payload) => fn(payload)),
  regionSelected: (rect) => ipcRenderer.send('region-selected', rect),
  regionCancelled: () => ipcRenderer.send('region-cancelled')
});
