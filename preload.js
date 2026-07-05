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
  onCaptureComplete: (fn) => ipcRenderer.on('capture-complete', (e, payload) => fn(payload)),
  onHotkey: (fn) => ipcRenderer.on('hotkey', (e, name) => fn(name)),

  // Video
  selectVideoSource: (opts) => ipcRenderer.send('select-video-source', opts),
  autosaveVideo: (buffer) => ipcRenderer.invoke('autosave-video', buffer),
  exportVideo: (libraryPath) => ipcRenderer.invoke('export-video', libraryPath),

  // Editor output
  saveImage: (dataUrl, defaultName) =>
    ipcRenderer.invoke('save-image', { dataUrl, defaultName }),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),

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
