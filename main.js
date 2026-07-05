// OpenSnag — main process
// Handles windows, tray, global hotkeys, screen capture, region overlay,
// the capture library on disk, and all privileged operations via IPC.

const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut,
  Tray, Menu, nativeImage, clipboard, dialog, shell, session
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isQuitting = false;

// Source id handed to setDisplayMediaRequestHandler when a video recording starts.
let pendingVideoSourceId = null;
let pendingVideoWithSystemAudio = false;

const capturesDir = () => {
  const dir = path.join(app.getPath('userData'), 'Captures');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const timestampName = (prefix, ext) => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`;
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    title: 'OpenSnag',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#1b1d23',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of quitting, SnagIt-style.
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Capture engine
// ---------------------------------------------------------------------------

// Grab a full-resolution screenshot of one display as a nativeImage.
async function captureDisplay(display) {
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });
  // Match by display_id when available; fall back to index order.
  let source = sources.find((s) => String(s.display_id) === String(display.id));
  if (!source) {
    const displays = screen.getAllDisplays();
    const idx = displays.findIndex((d) => d.id === display.id);
    source = sources[idx] || sources[0];
  }
  return source ? source.thumbnail : null;
}

async function hideForCapture() {
  const wasVisible = mainWindow && mainWindow.isVisible();
  if (wasVisible) {
    mainWindow.hide();
    await delay(300); // give the compositor time to remove the window
  }
  return wasVisible;
}

function deliverCapture(dataUrl, kind) {
  // Auto-save every capture into the library, then hand it to the editor.
  const file = path.join(capturesDir(), timestampName('Capture', 'png'));
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    fs.writeFileSync(file, img.toPNG());
  } catch (err) {
    console.error('Autosave failed:', err);
  }
  showMainWindow();
  mainWindow.webContents.send('capture-complete', { dataUrl, kind, file });
}

async function captureFullScreen(displayId) {
  const displays = screen.getAllDisplays();
  const display =
    displays.find((d) => String(d.id) === String(displayId)) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  await hideForCapture();
  const img = await captureDisplay(display);
  if (img && !img.isEmpty()) deliverCapture(img.toDataURL(), 'fullscreen');
  else showMainWindow();
}

async function captureWindowById(sourceId) {
  await hideForCapture();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 3840, height: 2160 }
  });
  const source = sources.find((s) => s.id === sourceId);
  if (source && !source.thumbnail.isEmpty()) {
    deliverCapture(source.thumbnail.toDataURL(), 'window');
  } else {
    showMainWindow();
  }
}

// Region capture: freeze the screen into an overlay window, let the user
// drag a rectangle, then crop the frozen screenshot.
let regionContext = null; // { display, image }

async function startRegionCapture() {
  if (overlayWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  await hideForCapture();
  const image = await captureDisplay(display);
  if (!image || image.isEmpty()) {
    showMainWindow();
    return;
  }
  regionContext = { display, image };

  overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    fullscreen: process.platform !== 'darwin',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('overlay-init', {
      screenshot: regionContext.image.toDataURL(),
      bounds: display.bounds,
      scaleFactor: display.scaleFactor
    });
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function closeOverlay() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

ipcMain.on('region-selected', (e, rect) => {
  const ctx = regionContext;
  closeOverlay();
  if (!ctx || !rect || rect.width < 2 || rect.height < 2) {
    showMainWindow();
    return;
  }
  const sf = ctx.display.scaleFactor;
  const imgSize = ctx.image.getSize();
  const crop = {
    x: Math.max(0, Math.round(rect.x * sf)),
    y: Math.max(0, Math.round(rect.y * sf)),
    width: Math.round(rect.width * sf),
    height: Math.round(rect.height * sf)
  };
  crop.width = Math.min(crop.width, imgSize.width - crop.x);
  crop.height = Math.min(crop.height, imgSize.height - crop.y);
  const cropped = ctx.image.crop(crop);
  regionContext = null;
  deliverCapture(cropped.toDataURL(), 'region');
});

ipcMain.on('region-cancelled', () => {
  regionContext = null;
  closeOverlay();
  showMainWindow();
});

// ---------------------------------------------------------------------------
// IPC: capture requests from the renderer
// ---------------------------------------------------------------------------

ipcMain.handle('get-displays', () => {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Display ${i + 1} (${d.size.width}×${d.size.height})${d.id === primary.id ? ' — primary' : ''}`
  }));
});

ipcMain.handle('list-window-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true
  });
  return sources
    .filter((s) => s.name && s.name !== 'OpenSnag')
    .map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }));
});

ipcMain.handle('list-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 200 }
  });
  const displays = screen.getAllDisplays();
  return sources.map((s, i) => ({
    id: s.id,
    displayId: String(s.display_id || (displays[i] && displays[i].id) || ''),
    name: s.name || `Screen ${i + 1}`,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

ipcMain.on('capture-fullscreen', (e, { displayId, delayMs }) => {
  setTimeout(() => captureFullScreen(displayId), delayMs || 0);
});

ipcMain.on('capture-window', (e, { sourceId, delayMs }) => {
  setTimeout(() => captureWindowById(sourceId), delayMs || 0);
});

ipcMain.on('capture-region', (e, { delayMs } = {}) => {
  setTimeout(() => startRegionCapture(), delayMs || 0);
});

// ---------------------------------------------------------------------------
// Video recording: renderer calls getDisplayMedia(); we satisfy the request
// with the source the user picked in the in-app source picker.
// ---------------------------------------------------------------------------

ipcMain.on('select-video-source', (e, { sourceId, systemAudio }) => {
  pendingVideoSourceId = sourceId;
  pendingVideoWithSystemAudio = !!systemAudio;
});

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        });
        const source =
          sources.find((s) => s.id === pendingVideoSourceId) ||
          sources.find((s) => s.id.startsWith('screen')) ||
          sources[0];
        const response = { video: source };
        // System (loopback) audio is only supported on Windows.
        if (pendingVideoWithSystemAudio && process.platform === 'win32') {
          response.audio = 'loopback';
        }
        callback(response);
      } catch (err) {
        console.error('display media handler failed:', err);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

// Write a finished recording straight into the library (no dialog).
ipcMain.handle('autosave-video', async (e, buffer) => {
  const libFile = path.join(capturesDir(), timestampName('Recording', 'webm'));
  await fsp.writeFile(libFile, Buffer.from(buffer));
  return libFile;
});

// Export a library recording to a user-chosen location.
ipcMain.handle('export-video', async (e, libraryPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save recording',
    defaultPath: path.join(app.getPath('videos'), path.basename(libraryPath)),
    filters: [{ name: 'WebM video', extensions: ['webm'] }]
  });
  if (canceled || !filePath) return null;
  await fsp.copyFile(libraryPath, filePath);
  return filePath;
});

// ---------------------------------------------------------------------------
// IPC: editor output
// ---------------------------------------------------------------------------

ipcMain.handle('save-image', async (e, { dataUrl, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save image',
    defaultPath: path.join(app.getPath('pictures'), defaultName || timestampName('Capture', 'png')),
    filters: [
      { name: 'PNG image', extensions: ['png'] },
      { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }
    ]
  });
  if (canceled || !filePath) return null;
  const img = nativeImage.createFromDataURL(dataUrl);
  const ext = path.extname(filePath).toLowerCase();
  const buf = ext === '.jpg' || ext === '.jpeg' ? img.toJPEG(92) : img.toPNG();
  await fsp.writeFile(filePath, buf);
  return filePath;
});

ipcMain.handle('copy-image', (e, dataUrl) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  return true;
});

// ---------------------------------------------------------------------------
// IPC: capture library
// ---------------------------------------------------------------------------

ipcMain.handle('list-captures', async () => {
  const dir = capturesDir();
  const names = await fsp.readdir(dir);
  const items = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webm'].includes(ext)) continue;
    const full = path.join(dir, name);
    const stat = await fsp.stat(full);
    items.push({
      path: full,
      name,
      type: ext === '.webm' ? 'video' : 'image',
      mtime: stat.mtimeMs,
      size: stat.size
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
});

ipcMain.handle('read-capture', async (e, filePath) => {
  // Only serve files that live inside the library directory.
  const dir = capturesDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(dir)) return null;
  const buf = await fsp.readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === '.webm' ? 'video/webm' : ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
});

ipcMain.handle('delete-capture', async (e, filePath) => {
  const dir = capturesDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(dir)) return false;
  await fsp.unlink(resolved);
  return true;
});

ipcMain.on('show-in-folder', (e, filePath) => shell.showItemInFolder(filePath));
ipcMain.on('open-external', (e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Tray + global hotkeys
// ---------------------------------------------------------------------------

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('OpenSnag — screen capture');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OpenSnag', click: showMainWindow },
      { type: 'separator' },
      { label: 'Capture region\tPrtScn', click: () => startRegionCapture() },
      { label: 'Capture full screen\tCtrl+Shift+PrtScn', click: () => captureFullScreen() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ])
  );
  tray.on('click', showMainWindow);
}

function registerHotkeys() {
  const tryRegister = (accel, fn) => {
    try {
      return globalShortcut.register(accel, fn);
    } catch {
      return false;
    }
  };
  // SnagIt-style PrintScreen hooks, with portable fallbacks.
  tryRegister('PrintScreen', () => startRegionCapture());
  tryRegister('CommandOrControl+Shift+PrintScreen', () => captureFullScreen());
  tryRegister('CommandOrControl+Alt+R', () => startRegionCapture());
  tryRegister('CommandOrControl+Alt+F', () => captureFullScreen());
  tryRegister('CommandOrControl+Alt+V', () => {
    showMainWindow();
    mainWindow.webContents.send('hotkey', 'toggle-recording');
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    createMainWindow();
    createTray();
    registerHotkeys();
    installDisplayMediaHandler();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
