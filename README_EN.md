# Smart Web Recorder

> A browser extension to record tab audio and one-click detect/download media files.  
> Works with Chrome, Edge, and Firefox. | 中文文档: [README.md](README.md)

## Features

### Recording
- **Tab Audio Recording** — Captures audio from the current tab via tabCapture (Chrome/Edge)
- **Waveform Visualization** — Real-time gradient waveform with 4x sub-peak detail
- **Clip Selection** — Drag on timeline to select, preview, and export segments
- **Multi-Format Export** — Save as WAV, WEBM, or MP3
- **Pin Window on Top** — Keep the recorder window above other browser windows

### Quick Download (v2.0.0)
- **Direct Audio Download** — Detects `<audio>`/`<video>` elements on the page and downloads the actual source audio files directly (NOT recording)
- **Multi-Source Detection** — Scans both HTML media elements and Performance API resource entries
- **Multiple Sources** — Lists all detected audio sources; download each individually
- **Blob URL Support** — Handles blob: audio URLs by injecting a download function into the page
- **Stream Detection** — Identifies m3u8/mpd streams and suggests recording instead
- **Cross-Browser** — Quick download works on Chrome, Edge, and Firefox

## Installation

### Chrome / Edge
1. Download or clone this repository
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge)
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder

### Firefox
1. Download or clone this repository
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select `manifest.json` in the project folder

## Usage

### Recording Tab Audio
1. Open a web page that plays audio or video
2. Click the extension icon in your toolbar
3. Click **Open Recorder**
4. Click **Record**
5. Click **Stop** when done
6. Drag on the waveform timeline to select a clip
7. Click **Save Clip** or **Save Full**

### Quick Download
1. Open the recorder window on a page with audio
2. The extension auto-detects media sources (or click "Detect Audio" to refresh)
3. All detected audio files appear in a list
4. Click the **⬇** button next to any item to download
5. The browser save dialog appears — choose location and save

> **Note:** Streams (m3u8/mpd) cannot be downloaded directly. Use the recording feature instead.

## File Structure

```
Smart-Web-Recorder/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker — tab management, tabCapture, media detection injection, downloads
├── popup.html          # Popup UI
├── popup.css           # Popup styles
├── popup.js            # Popup logic — get active tab & open recorder
├── recorder.html       # Recorder window UI
├── recorder.css        # Recorder styles
├── recorder.js         # Core logic — recording, waveform, quick download
├── README.md           # Chinese documentation
└── README_EN.md        # This file
```

## Browser Compatibility

| Feature | Chrome 88+ | Edge 88+ | Firefox 112+ |
|---|---|---|---|
| Tab audio recording | ✅ tabCapture | ✅ tabCapture | ⚠️ May not work |
| Waveform visualization | ✅ | ✅ | ✅ |
| WAV/WEBM export | ✅ | ✅ | ✅ |
| Quick download | ✅ | ✅ | ✅ |
| Pin window on top | ✅ | ✅ | ✅ |

## How It Works

### Quick Download (v2.0.0)

1. `recorder.js` sends a `detect-media` message to `background.js`
2. `background.js` uses `chrome.scripting.executeScript()` to inject a detection function into the target tab
3. The function scans all `<audio>`, `<video>`, and `<source>` elements on the page
4. It also checks `performance.getEntriesByType('resource')` for dynamically loaded audio resources
5. Results are returned to the recorder window and displayed as a list
6. When the user clicks download:
   - HTTP/HTTPS URLs → `chrome.downloads.download()` directly
   - blob: URLs → injects a function that creates an `<a download>` element and clicks it in the page context

### Waveform Visualization

Each 4096-sample block is divided into 4 sub-blocks, each recording min/max/RMS/peak independently. This 4x detail produces a richer waveform. Uses vertical gradient colors and asymmetric min/max bars.

### Recording

Uses `tabCapture.getMediaStreamId()` to get a stream ID, then `getUserMedia` with `chromeMediaSource: 'tab'` to obtain the audio stream. ScriptProcessorNode reads sample data block by block.

## License

MIT
