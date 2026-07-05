# OpenSnag

A **free, open-source, installable** screen capture and recording tool with a built-in
image editor — an alternative to [TechSmith SnagIt](https://www.techsmith.com/snagit/).
Runs locally on **Windows, macOS and Linux** (built with Electron). No account, no
subscription, no telemetry.

![capture](docs/screenshot-capture.png)
![editor](docs/screenshot-editor.png)

## Features

### Image capture
- **Region capture** — full-screen freeze-frame overlay with crosshair, live pixel
  dimensions and drag-to-select (like SnagIt's all-in-one capture)
- **Full screen capture** — with a display picker on multi-monitor setups
- **Window capture** — pick any open application window from a thumbnail grid
- **Timed capture** — 3 / 5 / 10-second delay to set up menus and tooltips
- **Global hotkeys** — `PrtScn` (region), `Ctrl+Shift+PrtScn` (full screen),
  `Ctrl+Alt+V` (start/stop recording); `Ctrl+Alt+R` / `Ctrl+Alt+F` as fallbacks
- **Tray icon** — the app keeps running in the background; closing the window
  minimizes to the tray, just like SnagIt's capture widget

### Video capture
- Record any **screen or window** to WebM (VP9, 30 fps, high bitrate)
- **Microphone narration** (toggle)
- **System audio** on Windows (loopback, toggle)
- **Pause / resume**, live recording timer, instant in-app playback
- Recordings are auto-saved to the library and can be exported anywhere

### Editor (annotations stay editable until export)
| Tool | Description |
|------|-------------|
| Select | move, resize, recolor or delete any annotation; double-click to edit text |
| Arrow / Line | SnagIt-style arrows, `Shift` snaps to 45° |
| Rectangle / Ellipse | outline, solid or translucent fill, optional drop shadow |
| Pen | smooth freehand drawing |
| Highlighter | translucent multiply highlight |
| Text | multi-line text in any color/size |
| Callout | speech-bubble with tail (drag the tail handle to re-point it) |
| Step numbers | auto-incrementing numbered badges for tutorials |
| Blur | pixelate/redact sensitive info (passwords, keys, faces) |
| Crop | drag to crop the image |

Plus: **undo/redo** (50 levels), zoom (`Ctrl` + wheel, fit-to-window), and one-click
**effects** — border, drop shadow, rounded corners, rotate, flip, grayscale, resize.

Export: **Save as PNG/JPEG** (`Ctrl+S`) or **copy to clipboard** (`Ctrl+C`).

### Library
Every capture and recording is automatically kept in a local library
(`<user data>/Captures`) with thumbnails — re-open any image in the editor,
reveal it on disk, or delete it.

## Install / Run

Requires [Node.js](https://nodejs.org) 18+ only for building; end users just run the installer.

```bash
git clone <this repo>
cd SnagItAlt
npm install

# run from source
npm start

# build installers into ./dist
npm run dist:win     # Windows: NSIS installer (.exe) + portable .exe
npm run dist:mac     # macOS: .dmg (build on a Mac)
npm run dist:linux   # Linux: AppImage + .deb
```

`npm run dist` builds for the current platform. The Windows installer supports
per-user install, desktop + start-menu shortcuts, and a chosen install directory.

### Platform notes
- **Wayland (Linux):** screen capture uses the desktop portal; if sources come up
  empty, launch with `--ozone-platform=x11` or use an X11 session.
- **macOS:** grant *Screen Recording* permission on first use
  (System Settings → Privacy & Security → Screen Recording).
- **System audio capture** is Windows-only (Chromium loopback); on macOS/Linux
  record microphone audio or use a virtual audio device.

## Keyboard shortcuts (editor)

`V` select · `A` arrow · `L` line · `R` rectangle · `E` ellipse · `P` pen ·
`H` highlighter · `T` text · `C` callout · `S` step · `B` blur · `X` crop ·
`Del` delete selection · `Ctrl+Z`/`Ctrl+Y` undo/redo · `Esc` deselect

## Architecture

```
main.js         Electron main process: tray, global hotkeys, desktopCapturer
                screenshots, region-overlay window, library on disk, dialogs
preload.js      contextBridge IPC surface (no nodeIntegration in renderers)
overlay/        frameless full-screen region selector (frozen screenshot + crosshair)
renderer/       app shell (capture / video / editor / library views)
  editor.js     vector-object annotation editor over the raster capture;
                objects stay editable until flattened at export time
```

## Roadmap ideas
- Scrolling/panoramic capture
- GIF export (ffmpeg post-processing)
- OCR text grab
- Sharing integrations

## License

MIT — free for personal and commercial use.
