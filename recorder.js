/* ==========================================================================
   Smart Web Detector / 智能网页探测器 — Recorder Logic v2.0.0
   ==========================================================================
   Features / 功能:
     1. Capture tab audio via tabCapture (Chrome/Edge) / 录制标签页音频
     2. Real-time waveform visualization / 实时波形可视化
     3. Drag-to-select clip, preview, export WAV/WEBM/MP3 / 选区试听导出
     4. Pin window on top / 固定窗口置顶
     5. [v2.0.0] Quick Download: detect ALL downloadable media on the page
        (audio, video, documents, archives, images) and download source files
        directly. When audio is not downloadable (MSE/stream), video and other
        files are offered instead.
        v2.0.0 新增：一键探测下载——检测页面中所有可下载的媒体
        （音频、视频、文档、压缩包、图片），直接下载源文件。
        当音频不可下载时（MSE/流媒体），自动改为提供视频和其他文件。

   Code Structure / 代码结构:
     §1  Browser API compatibility / 浏览器 API 兼容
     §2  DOM references / DOM 元素引用
     §3  State variables / 状态变量
     §4  Utility functions / 工具函数
     §5  Pin window on top / 固定窗口置顶
     §6  Audio capture (tabCapture only) / 音频捕获（仅 tabCapture）
     §7  Audio recording & data collection / 音频录制与数据采集
     §8  Waveform drawing / 波形绘制
     §9  Timeline interaction / 时间轴交互
     §10 Quick download: media detection & direct download (v2.0.0)
         一键探测下载：媒体检测与直接下载
     §11 Audio export (WAV/WEBM/MP3) / 音频导出
     §12 Event listeners / 事件监听
     §13 Initialization / 初始化
   ========================================================================== */

/* ===== §1 Browser API Compatibility ==================================== */

/*
  Unified extension API access.
  Chrome/Edge: chrome object; Firefox: browser object.
  统一扩展 API，兼容 Chrome/Edge/Firefox
*/
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

/*
  Unified message sender (Promise-based for both callback and Promise styles).
  统一消息发送，回调与 Promise 风格兼容。
*/
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const result = browserAPI.runtime.sendMessage(message, (response) => {
      if (browserAPI.runtime.lastError) {
        reject(new Error(browserAPI.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
    if (result && typeof result.then === 'function') {
      result.then(resolve, reject);
    }
  });
}

/* ===== §2 DOM References =============================================== */

const startButton = document.querySelector('#startButton');
const stopButton = document.querySelector('#stopButton');
const discardButton = document.querySelector('#discardButton');
const previewButton = document.querySelector('#previewButton');
const downloadFullButton = document.querySelector('#downloadFullButton');
const downloadClipButton = document.querySelector('#downloadClipButton');
const formatSelect = document.querySelector('#formatSelect');
const muteMonitor = document.querySelector('#muteMonitor');
const pageUrl = document.querySelector('#pageUrl');
const pageTitle = document.querySelector('#pageTitle');
const clock = document.querySelector('#clock');
const statusText = document.querySelector('#status');
const clipStartText = document.querySelector('#clipStartText');
const clipEndText = document.querySelector('#clipEndText');
const previewAudio = document.querySelector('#previewAudio');
const levelBar = document.querySelector('#levelBar');
const timeline = document.querySelector('#timeline');
const canvasContext = timeline.getContext('2d');
const pinButton = document.querySelector('#pinButton');

// v2.0.0 Quick download elements / 一键下载相关元素
const detectMediaButton = document.querySelector('#detectMediaButton');
const downloadAllButton = document.querySelector('#downloadAllButton');
const mediaListContainer = document.querySelector('#mediaList');
const quickStatus = document.querySelector('#quickStatus');

/* ===== §3 State Variables ============================================== */

const params = new URLSearchParams(location.search);
const targetTabId = Number(params.get('tabId'));

// Audio / 音频
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let monitorGain = null;
let silentGain = null;
let stream = null;

// Recording / 录制
let animationId = 0;
let totalSamples = 0;
let sampleRate = 48000;
let recording = false;
let chunks = [];
let peaks = [];
let selectionStart = 0;
let selectionEnd = 0;
let dragMode = null;
let dragOffset = 0;
let previewUrl = '';

// Pin window / 固定窗口
let isPinned = false;
let recorderWindowId = null;

// v2.0.0: detected media sources from page / 检测到的页面媒体源
let detectedMedia = [];

// Sub-peak count for waveform detail / 波形子峰值数
const SUB_PEAKS = 4;

/* ===== §4 Utility Functions ============================================ */

function setStatus(msg) { statusText.textContent = msg; }
function setQuickStatus(msg) { quickStatus.textContent = msg; }

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.max(0, seconds - m * 60);
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function getDuration() { return totalSamples / sampleRate; }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function secondsToX(seconds) {
  const d = Math.max(getDuration(), 0.1);
  return (seconds / d) * timeline.width;
}

function xToSeconds(clientX) {
  const rect = timeline.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  return ratio * getDuration();
}

function clearPreview() {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  previewAudio.classList.remove('has-audio');
}

function updateSelectionLabels() {
  clipStartText.textContent = `起点 ${formatTime(selectionStart)}`;
  clipEndText.textContent = `终点 ${formatTime(selectionEnd)}`;
}

function normalizeSelection() {
  const d = getDuration();
  selectionStart = clamp(selectionStart, 0, d);
  selectionEnd = clamp(selectionEnd, 0, d);
  if (d > 0 && selectionEnd <= selectionStart) {
    selectionStart = 0;
    selectionEnd = d;
  }
  updateSelectionLabels();
}

function updateControls() {
  const hasAudio = totalSamples > 0;
  startButton.disabled = recording;
  stopButton.disabled = !recording;
  discardButton.disabled = !hasAudio && !recording;
  previewButton.disabled = !hasAudio;
  downloadFullButton.disabled = !hasAudio;
  downloadClipButton.disabled = !hasAudio;
  formatSelect.disabled = !hasAudio;
}

/**
 * Default file extensions by media type.
 * 按媒体类型的默认文件扩展名。
 */
const DEFAULT_EXTENSIONS = {
  audio: 'mp3',
  video: 'mp4',
  document: 'pdf',
  archive: 'zip',
  image: 'png',
  other: 'bin'
};

/**
 * Extract a filename from a URL or label.
 * Cleans CDN processing parameters (e.g. @336w_190h_1c_!web).
 * Strips .avif suffix to get original extension (e.g. .jpg).
 * Falls back to readable label when URL filename is a hash.
 * ALWAYS ensures the filename ends with a proper extension.
 *
 * 从 URL 或标签中提取文件名。
 * 清理 CDN 处理参数（如 @336w_190h_1c_!web）。
 * 剥离 .avif 后缀获取原始扩展名（如 .jpg）。
 * 当 URL 文件名为哈希串时，使用可读标签。
 * 始终确保文件名以正确的扩展名结尾。
 */
function getFilename(url, label, type) {
  // For blob URLs, use label or timestamp / blob URL 用标签或时间戳
  if (url.startsWith('blob:')) {
    const clean = (label || '').replace(/[<>:"/\\|?*]/g, '_').trim();
    const ext = DEFAULT_EXTENSIONS[type] || 'bin';
    return clean ? `${clean}.${ext}` : `media_${Date.now()}.${ext}`;
  }
  try {
    const pathname = new URL(url).pathname;
    let name = pathname.split('/').pop();
    const defaultExt = `.${DEFAULT_EXTENSIONS[type] || 'bin'}`;

    if (name && name.includes('.')) {
      // Strip CDN processing params / 去除 CDN 处理参数
      // e.g. "hash@336w_190h_1c_!web-progressive.jpg" → "hash.jpg"
      if (name.includes('@')) {
        const before = name.split('@')[0];
        const extMatch = name.match(/\.[a-z0-9]+$/i);
        name = before + (extMatch ? extMatch[0] : '');
      }

      // Strip .avif suffix / 剥离 .avif 后缀
      // e.g. "hash.jpg.avif" → "hash.jpg"
      if (name.toLowerCase().endsWith('.avif')) {
        name = name.slice(0, -5);
      }

      // Strip .webp suffix / 剥离 .webp 后缀
      // e.g. "hash.png.webp" → "hash.png" (Windows can't open WebP)
      if (name.toLowerCase().endsWith('.webp')) {
        name = name.slice(0, -5);
      }

      // Check if name is a hash (unreadable) / 检查是否为哈希串
      const base = name.replace(/\.[a-z0-9]+$/i, '');
      const isHash = (base.length > 12 && /^[a-f0-9]{12,}$/i.test(base)) ||
                     (base.length > 20 && !/\s/.test(base) && /^[a-z0-9]+$/i.test(base)) ||
                     (base.length > 30);

      if (isHash && label) {
        // Use readable label instead of hash / 用可读标签替代哈希
        const cleanLabel = label.replace(/[<>:"/\\|?*]/g, '_').trim();
        const ext = name.match(/\.[a-z0-9]+$/i)?.[0] || defaultExt;
        return cleanLabel + ext;
      }

      return name;
    }

    // No extension in URL — force append type-based extension
    // URL 中无扩展名 — 强制追加类型对应的扩展名
    // This prevents Chrome from using server's Content-Type (e.g. text/plain → .txt)
    // 这会防止 Chrome 用服务器的 Content-Type（如 text/plain → .txt）
    const cleanLabel = (label || 'media').replace(/[<>:"/\\|?*]/g, '_').trim();
    return cleanLabel + defaultExt;
  } catch {
    const ext = DEFAULT_EXTENSIONS[type] || 'bin';
    return `media_${Date.now()}.${ext}`;
  }
}

/* ===== §5 Pin Window on Top ============================================ */

function initPinFeature() {
  try {
    browserAPI.windows.getCurrent((win) => { recorderWindowId = win.id; });
  } catch (e) {
    pinButton.disabled = true;
    pinButton.title = 'Not supported / 不支持';
  }

  try {
    browserAPI.windows.onFocusChanged.addListener((windowId) => {
      if (!isPinned || !recorderWindowId) return;
      if (windowId !== recorderWindowId) {
        browserAPI.windows.update(recorderWindowId, { focused: true });
      }
    });
  } catch (e) {
    pinButton.disabled = true;
  }
}

function togglePin() {
  isPinned = !isPinned;
  pinButton.classList.toggle('active', isPinned);
  pinButton.setAttribute('aria-pressed', String(isPinned));
  pinButton.title = isPinned ? '点击取消 / Click to unpin' : '固定置顶 / Pin on top';
  if (isPinned) {
    setStatus('窗口已固定 / Window pinned');
    if (recorderWindowId) browserAPI.windows.update(recorderWindowId, { focused: true });
  } else {
    setStatus('已取消固定 / Unpinned');
  }
}

/* ===== §6 Audio Capture (tabCapture only) ============================== */

/**
 * Get target tab info from background.
 * 从 background 获取目标标签页信息。
 */
async function getTargetTab() {
  const response = await sendMessage({ type: 'get-target-tab' });
  if (!response.ok && !targetTabId) {
    throw new Error('未选择录制网页 / No tab selected');
  }
  return response.targetTab;
}

/**
 * Capture tab audio stream using tabCapture API (Chrome/Edge).
 * Uses getMediaStreamId + getUserMedia with chromeMediaSource:'tab'.
 *
 * 使用 tabCapture 捕获标签页音频（Chrome/Edge）。
 * 通过 getMediaStreamId + getUserMedia 获取标签页音频流。
 *
 * @returns {Promise<MediaStream>} audio stream / 音频流
 */
async function getCaptureStream() {
  // tabCapture: get stream ID from background / 从 background 获取流 ID
  const response = await sendMessage({ type: 'get-stream-id', tabId: targetTabId });

  if (!response.ok || !response.streamId) {
    throw new Error(
      '无法捕获音频。录制功能需要 Chrome 或 Edge 浏览器。\n' +
      'Recording requires Chrome or Edge.\n' +
      '提示：可使用下方"探测媒体"直接下载音频/视频/文件。'
    );
  }

  // Use stream ID to get actual MediaStream / 用流 ID 获取实际音频流
  return await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: response.streamId
      }
    },
    video: false
  });
}

/* ===== §7 Audio Recording & Data Collection ============================ */

function cloneChannel(inputBuffer, channelIndex) {
  const source = inputBuffer.getChannelData(
    Math.min(channelIndex, inputBuffer.numberOfChannels - 1)
  );
  return new Float32Array(source);
}

/**
 * Audio processing callback (ScriptProcessorNode.onaudioprocess).
 * Splits each block into SUB_PEAKS(=4) sub-blocks for richer waveform detail.
 *
 * 音频处理回调。每块分 4 子块记录峰值，提升波形细节。
 */
function recordAudio(event) {
  if (!recording) return;

  const inputBuffer = event.inputBuffer;
  const left = cloneChannel(inputBuffer, 0);
  const right = cloneChannel(inputBuffer, 1);
  const startSample = totalSamples;

  chunks.push({ startSample, endSample: startSample + left.length, left, right });
  totalSamples += left.length;
  selectionEnd = getDuration();

  // Sub-peak calculation / 子块峰值计算
  const subSize = Math.max(1, Math.floor(left.length / SUB_PEAKS));
  let overallPeak = 0;

  for (let s = 0; s < SUB_PEAKS; s++) {
    let max = 0, min = 0, sumSq = 0;
    const start = s * subSize;
    const end = Math.min(start + subSize, left.length);
    const count = end - start;

    for (let i = start; i < end; i++) {
      if (left[i] > max) max = left[i];
      if (left[i] < min) min = left[i];
      if (right[i] > max) max = right[i];
      if (right[i] < min) min = right[i];
      sumSq += left[i] * left[i] + right[i] * right[i];
    }

    const rms = count > 0 ? Math.sqrt(sumSq / (count * 2)) : 0;
    const peak = Math.max(Math.abs(max), Math.abs(min));
    overallPeak = Math.max(overallPeak, peak);
    peaks.push({ max, min, rms, peak });
  }

  levelBar.style.width = `${Math.min(100, Math.round(overallPeak * 140))}%`;
}

/* ===== §8 Waveform Drawing ============================================= */

function drawEmptyTimeline(width, height) {
  canvasContext.fillStyle = 'rgba(255, 255, 255, 0.12)';
  canvasContext.fillRect(0, height / 2 - 1, width, 2);
  canvasContext.fillStyle = 'rgba(255, 255, 255, 0.85)';
  canvasContext.font = '700 15px Microsoft YaHei, Segoe UI, sans-serif';
  canvasContext.textAlign = 'center';
  canvasContext.fillText('录制后可拖动选择片段 / Drag to select after recording', width / 2, height / 2 - 16);
}

function drawSelection(width, height) {
  const startX = secondsToX(selectionStart);
  const endX = secondsToX(selectionEnd);

  canvasContext.fillStyle = 'rgba(255, 255, 255, 0.2)';
  canvasContext.fillRect(0, 0, startX, height);
  canvasContext.fillRect(endX, 0, width - endX, height);

  canvasContext.fillStyle = 'rgba(255, 238, 96, 0.22)';
  canvasContext.fillRect(startX, 0, endX - startX, height);

  canvasContext.strokeStyle = '#fff15a';
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();
  canvasContext.moveTo(startX, 12);
  canvasContext.lineTo(startX, height - 12);
  canvasContext.moveTo(endX, 12);
  canvasContext.lineTo(endX, height - 12);
  canvasContext.stroke();

  const handleH = Math.min(50, height * 0.42);
  const handleY = (height - handleH) / 2;
  canvasContext.fillStyle = '#fff15a';
  canvasContext.fillRect(startX - 4, handleY, 8, handleH);
  canvasContext.fillRect(endX - 4, handleY, 8, handleH);
}

function drawTimeline() {
  const width = timeline.width;
  const height = timeline.height;
  canvasContext.clearRect(0, 0, width, height);

  if (peaks.length === 0) {
    drawEmptyTimeline(width, height);
    updateSelectionLabels();
    return;
  }

  const step = Math.max(1, Math.ceil(peaks.length / width));

  // Vertical gradient: coral → orange → dark red → orange → coral / 垂直渐变
  const grad = canvasContext.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, 'rgba(255, 204, 188, 0.85)');
  grad.addColorStop(0.25, 'rgba(255, 87, 34, 0.95)');
  grad.addColorStop(0.5, 'rgba(163, 12, 8, 1)');
  grad.addColorStop(0.75, 'rgba(255, 87, 34, 0.95)');
  grad.addColorStop(1, 'rgba(255, 204, 188, 0.85)');
  canvasContext.fillStyle = grad;

  const barWidth = 2, gap = 1, centerY = height / 2, maxRatio = 0.42;

  for (let x = 0; x < width; x += barWidth + gap) {
    const sIdx = Math.floor(x * step);
    const eIdx = Math.floor((x + barWidth + gap) * step);
    const slice = peaks.slice(sIdx, Math.max(sIdx + 1, eIdx));
    if (!slice.length) continue;

    let maxVal = 0, minVal = 0;
    for (const p of slice) {
      if (p.max > maxVal) maxVal = p.max;
      if (p.min < minVal) minVal = p.min;
    }

    const topH = Math.max(1, Math.abs(maxVal) * height * maxRatio);
    const botH = Math.max(1, Math.abs(minVal) * height * maxRatio);
    canvasContext.fillRect(x, centerY - topH, barWidth, topH + botH);
  }

  canvasContext.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  canvasContext.lineWidth = 1;
  canvasContext.beginPath();
  canvasContext.moveTo(0, centerY);
  canvasContext.lineTo(width, centerY);
  canvasContext.stroke();

  normalizeSelection();
  drawSelection(width, height);
}

function tick() {
  clock.textContent = formatTime(getDuration());
  drawTimeline();
  animationId = requestAnimationFrame(tick);
}

/** Start recording / 开始录制 */
async function startCapture() {
  try {
    clearPreview();
    chunks = [];
    peaks = [];
    totalSamples = 0;
    selectionStart = 0;
    selectionEnd = 0;

    stream = await getCaptureStream();

    const AC = window.AudioContext || window.webkitAudioContext;
    audioContext = new AC();
    sampleRate = audioContext.sampleRate;

    sourceNode = audioContext.createMediaStreamSource(stream);
    processorNode = audioContext.createScriptProcessor(4096, 2, 2);
    monitorGain = audioContext.createGain();
    silentGain = audioContext.createGain();
    monitorGain.gain.value = muteMonitor.checked ? 0 : 1;
    silentGain.gain.value = 0;

    sourceNode.connect(monitorGain);
    monitorGain.connect(audioContext.destination);
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    processorNode.onaudioprocess = recordAudio;

    recording = true;
    updateControls();
    setStatus('正在录制 / Recording...');
    tick();
  } catch (error) {
    setStatus(error.message);
  }
}

/** Stop recording / 停止录制 */
function stopCapture() {
  recording = false;
  cancelAnimationFrame(animationId);

  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (monitorGain) monitorGain.disconnect();
  if (silentGain) silentGain.disconnect();
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioContext) audioContext.close();
  stream = null;

  levelBar.style.width = '0%';
  clock.textContent = formatTime(getDuration());
  selectionEnd = getDuration();
  drawTimeline();
  updateControls();
  setStatus(`已录制 ${formatTime(getDuration())} / Recorded`);
}

/** Discard recording / 丢弃录音 */
function discardRecording() {
  if (recording) stopCapture();
  clearPreview();
  chunks = [];
  peaks = [];
  totalSamples = 0;
  selectionStart = 0;
  selectionEnd = 0;
  levelBar.style.width = '0%';
  clock.textContent = '00:00.0';
  drawTimeline();
  updateControls();
  setStatus('已丢弃 / Discarded');
}

/* ===== §9 Timeline Interaction ========================================= */

function getDragMode(event) {
  const x = event.offsetX * (timeline.width / timeline.clientWidth);
  const startX = secondsToX(selectionStart);
  const endX = secondsToX(selectionEnd);
  const hw = 18;

  if (Math.abs(x - startX) <= hw) return 'start';
  if (Math.abs(x - endX) <= hw) return 'end';
  if (x > startX && x < endX) {
    dragOffset = xToSeconds(event.clientX) - selectionStart;
    return 'move';
  }

  selectionStart = xToSeconds(event.clientX);
  selectionEnd = clamp(selectionStart + Math.min(5, getDuration() - selectionStart), selectionStart, getDuration());
  return 'end';
}

function updateSelectionFromDrag(event) {
  if (!dragMode) return;
  const d = getDuration();
  const ps = xToSeconds(event.clientX);
  const minGap = Math.min(0.1, d);

  if (dragMode === 'start') selectionStart = clamp(ps, 0, selectionEnd - minGap);
  if (dragMode === 'end') selectionEnd = clamp(ps, selectionStart + minGap, d);
  if (dragMode === 'move') {
    const len = selectionEnd - selectionStart;
    const ns = clamp(ps - dragOffset, 0, Math.max(0, d - len));
    selectionStart = ns;
    selectionEnd = ns + len;
  }

  clearPreview();
  drawTimeline();
}

/* ===== §10 Quick Download: Media Detection & Direct Download (v2.0.0) ==
  ==========================================================================
  This is the core v2.0.0 feature. It does NOT record audio — instead it
  detects ALL downloadable media on the target page (audio, video, documents,
  archives, images) and downloads the source files directly.
  When audio is not downloadable (MSE/stream), video and other files
  are automatically offered instead.

  这是 v2.0.0 核心功能。不是录音——而是检测页面中所有可下载的媒体
  （音频、视频、文档、压缩包、图片），直接下载源文件。
  当音频不可下载时（MSE/流媒体），自动改为提供视频和其他可下载文件。
  ========================================================================== */

/**
 * Icon map for each media type.
 * 每种媒体类型的图标映射。
 */
const TYPE_ICONS = {
  audio:    '🎵',
  video:    '🎬',
  document: '📄',
  archive:  '📦',
  image:    '🖼️',
  other:    '📎',
  resource: '🔗'
};

/**
 * Detect media elements on the target page.
 * Sends 'detect-media' message to background, which injects a script
 * into the target tab to scan for <audio>/<video>/<a> elements and resources.
 *
 * 检测目标页面中的所有可下载媒体。
 * 向 background 发送 'detect-media' 消息，background 注入脚本
 * 扫描目标标签页中的 <audio>/<video>/<a> 元素和 Performance API 资源。
 *
 * @returns {Promise<Array>} list of detected media / 检测到的媒体列表
 */
async function detectMedia() {
  const response = await sendMessage({ type: 'detect-media', tabId: targetTabId });
  if (!response.ok) {
    throw new Error(response.error || 'Detection failed / 探测失败');
  }
  return response.mediaList || [];
}

/**
 * MIME type mapping for each media category.
 * Used when fetching as Blob to set correct Content-Type,
 * preventing Chrome from using server's text/plain → .txt.
 *
 * 各媒体类别对应的 MIME 类型。
 * 用于 fetch 为 Blob 时设置正确的 Content-Type，
 * 防止 Chrome 使用服务器的 text/plain → .txt。
 */
const MIME_TYPES = {
  audio: 'audio/mpeg',
  video: 'video/mp4',
  document: 'application/octet-stream',
  archive: 'application/octet-stream',
  image: 'image/jpeg',
  other: 'application/octet-stream'
};

/**
 * Download a specific media file.
 * For HTTP/HTTPS URLs: fetches as Blob with correct MIME type, then downloads.
 * For blob: URLs: injects a download function into the page.
 *
 * 下载指定媒体文件。
 * HTTP/HTTPS URL：先 fetch 为带正确 MIME 类型的 Blob，再下载。
 * blob: URL：注入下载函数到页面。
 *
 * @param {string} url - media URL / 媒体 URL
 * @param {string} label - display label for filename / 显示标签（用于文件名）
 * @param {string} type - media type for default extension / 媒体类型（用于默认扩展名）
 */
async function downloadMedia(url, label, type) {
  const filename = getFilename(url, label, type);
  const mimeType = MIME_TYPES[type] || 'application/octet-stream';
  const response = await sendMessage({
    type: 'download-media',
    url: url,
    filename: filename,
    mimeType: mimeType,
    tabId: targetTabId
  });

  if (!response.ok) {
    throw new Error(response.error || 'Download failed / 下载失败');
  }
}

/**
 * Render the detected media list in the UI.
 * Each item shows an icon, label, URL, and a download button.
 * Supports all media types: audio, video, document, archive, image, other.
 * Non-downloadable items (MSE/stream) show a "use recording" hint instead.
 *
 * 在 UI 中渲染检测到的媒体列表。
 * 每项显示图标、标签、URL 和下载按钮。
 * 支持所有媒体类型：音频、视频、文档、压缩包、图片、其他。
 * 不可下载项（MSE/流媒体）显示"请使用录制"提示。
 *
 * @param {Array} mediaList - detected media items / 检测到的媒体项
 */
function renderMediaList(mediaList) {
  detectedMedia = mediaList;
  mediaListContainer.innerHTML = '';

  // Enable/disable "Download All" button / 启用/禁用"一键下载全部"按钮
  const downloadableItems = mediaList.filter(m => m.downloadable !== false);
  downloadAllButton.disabled = downloadableItems.length === 0;

  if (mediaList.length === 0) {
    // No media found / 未找到任何媒体
    const empty = document.createElement('div');
    empty.className = 'media-empty';
    empty.textContent = '未探测到可下载的媒体。可尝试播放后再次探测，或使用上方录制功能。\nNo downloadable media detected. Try playing media first, or use recording above.';
    mediaListContainer.appendChild(empty);
    setQuickStatus('未找到媒体 / No media found');
    return;
  }

  // Categorize items / 按类别分类
  const downloadable = mediaList.filter(m => m.downloadable !== false);
  const notDownloadable = mediaList.filter(m => m.downloadable === false);

  // Check if audio specifically is not downloadable / 检查音频是否不可下载
  const audioDownloadable = downloadable.filter(m => m.type === 'audio');
  const videoDownloadable = downloadable.filter(m => m.type === 'video');
  const otherDownloadable = downloadable.filter(m =>
    m.type !== 'audio' && m.type !== 'video'
  );

  // Build status message / 构建状态消息
  let statusParts = [`探测到 ${mediaList.length} 个媒体源 / ${mediaList.length} source(s)`];

  if (downloadable.length > 0) {
    statusParts.push(`${downloadable.length} 个可下载 / ${downloadable.length} downloadable`);
  }

  // Show category breakdown when audio is missing but video/files exist
  // 当音频缺失但有视频/文件时，显示分类明细
  if (audioDownloadable.length === 0 && (videoDownloadable.length > 0 || otherDownloadable.length > 0)) {
    statusParts.push('无音频·已改为提供视频/文件 / No audio→video/files instead');
  }

  if (notDownloadable.length > 0) {
    statusParts.push(`${notDownloadable.length} 个需录制 / ${notDownloadable.length} need recording`);
  }

  setQuickStatus(statusParts.join('，'));

  // Sort: downloadable first, then non-downloadable / 可下载的排前面
  const sorted = [...downloadable, ...notDownloadable];

  // Create a row for each detected media item / 为每个检测到的媒体项创建一行
  sorted.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'media-item';

    // Icon by type / 按类型显示图标
    const icon = document.createElement('span');
    icon.className = 'media-icon';
    if (item.isMSE || item.isStream) {
      icon.textContent = '📡';
    } else {
      icon.textContent = TYPE_ICONS[item.type] || '🔗';
    }

    // Text: label + URL / 文本：标签 + URL
    const text = document.createElement('div');
    text.className = 'media-text';

    const labelEl = document.createElement('div');
    labelEl.className = 'media-label';
    let labelText = item.label || `${item.type || 'media'} ${index + 1}`;

    // Show type badge / 显示类型标识
    if (item.isMSE) {
      labelText += ' (MSE流·需录制 / MSE·record)';
    } else if (item.isStream) {
      labelText += ' (流媒体 / Stream)';
    } else if (item.type && item.type !== 'audio') {
      // Show type label for non-audio items / 为非音频项显示类型
      const typeLabels = {
        video: '视频', document: '文档', archive: '压缩包',
        image: '图片', other: '文件', resource: '资源'
      };
      const tl = typeLabels[item.type];
      if (tl) labelText += ` (${tl} / ${item.type})`;
    }

    labelEl.textContent = labelText;

    const urlEl = document.createElement('div');
    urlEl.className = 'media-url';
    // Show domain + short path, not the full long URL
    // 显示域名 + 简短路径，不显示完整长 URL
    let displayUrl = item.url;
    try {
      const u = new URL(item.url);
      // Show "domain/.../filename" format / 显示"域名/.../文件名"格式
      const parts = u.pathname.split('/');
      const filename = parts[parts.length - 1];
      if (filename && u.pathname.length > 40) {
        displayUrl = `${u.hostname}/.../${filename}`;
      } else {
        displayUrl = `${u.hostname}${u.pathname}`;
      }
    } catch {}
    // Still truncate if too long / 仍然截断过长的 URL
    if (displayUrl.length > 60) displayUrl = displayUrl.slice(0, 57) + '...';
    urlEl.textContent = displayUrl;
    urlEl.title = item.url;

    text.appendChild(labelEl);
    text.appendChild(urlEl);

    // Download button / 下载按钮
    const dlBtn = document.createElement('button');
    dlBtn.className = 'media-download-btn';
    dlBtn.type = 'button';

    // MSE and stream files can't be directly downloaded / MSE 和流媒体无法直接下载
    if (item.isMSE) {
      dlBtn.disabled = true;
      dlBtn.textContent = '🎬';
      dlBtn.title = 'MSE流媒体（B站/YouTube等）无法直接下载，请点击上方"开始录制"按钮录制音频\nMSE stream (Bilibili/YouTube): use recording instead';
    } else if (item.isStream) {
      dlBtn.disabled = true;
      dlBtn.textContent = '🎬';
      dlBtn.title = '流媒体无法直接下载，请使用录制\nStream: use recording instead';
    } else {
      dlBtn.textContent = '⬇';
      dlBtn.title = '下载 / Download';
      // Click handler for download / 下载点击处理
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = '...';
        try {
          await downloadMedia(item.url, item.label, item.type);
          setQuickStatus(`已开始下载: ${item.label} / Download started`);
        } catch (error) {
          setQuickStatus(`下载失败: ${error.message} / Download failed`);
        } finally {
          dlBtn.disabled = false;
          dlBtn.textContent = '⬇';
        }
      });
    }

    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(dlBtn);
    mediaListContainer.appendChild(row);
  });
}

/**
 * Handle "Download All" button click.
 * Downloads all downloadable media items sequentially.
 * MSE/stream items are skipped automatically.
 *
 * 处理"一键下载全部"按钮点击。
 * 依次下载所有可下载的媒体项。
 * MSE/流媒体项自动跳过。
 */
async function handleDownloadAll() {
  const items = detectedMedia.filter(m => m.downloadable !== false);
  if (items.length === 0) return;

  downloadAllButton.disabled = true;
  detectMediaButton.disabled = true;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    setQuickStatus(`正在下载 ${i + 1}/${items.length}: ${item.label}... / Downloading...`);
    try {
      await downloadMedia(item.url, item.label, item.type);
      successCount++;
      // Small delay between downloads to avoid browser throttling
      // 下载间隔，避免浏览器限流
      await new Promise(r => setTimeout(r, 300));
    } catch (error) {
      failCount++;
    }
  }

  // Final status / 最终状态
  if (failCount === 0) {
    setQuickStatus(`全部下载完成！${successCount} 个文件 / All done! ${successCount} files`);
  } else {
    setQuickStatus(`完成: ${successCount} 成功, ${failCount} 失败 / ${successCount} ok, ${failCount} failed`);
  }

  downloadAllButton.disabled = false;
  detectMediaButton.disabled = false;
}

/**
 * Handle "Detect Media" button click.
 * Scans the target page for all downloadable media and displays results.
 *
 * 处理"探测媒体"按钮点击。
 * 扫描目标页面所有可下载媒体并显示结果。
 */
async function handleDetectMedia() {
  detectMediaButton.disabled = true;
  setQuickStatus('正在探测媒体源... / Detecting...');

  try {
    const mediaList = await detectMedia();
    renderMediaList(mediaList);

    // If no downloadable items found, show helpful hint
    // 如果没有找到可下载项，显示提示
    const downloadable = mediaList.filter(m => m.downloadable !== false);
    if (downloadable.length === 0) {
      setQuickStatus('未探测到可直接下载的文件。B站/YouTube等使用MSE流媒体的网站无法直接下载视频，请使用上方录音功能。\nNo downloadable files. MSE sites (Bilibili/YouTube) cannot be downloaded directly — use recording above.');
    } else {
      const hasVideo = downloadable.some(m => m.type === 'video');
      if (!hasVideo) {
        // Check if page has <video> (likely MSE) but no downloadable video
        // 检查页面是否有 <video>（可能是 MSE）但无可下载视频
        setQuickStatus(`探测到 ${downloadable.length} 个可下载文件（未含完整视频）。B站/YouTube等使用MSE流媒体的网站，视频被拆分成无数小片段，浏览器扩展无法直接下载完整视频，请使用录音功能录制音频。\n${downloadable.length} files found (no complete video). MSE sites split video into segments — use recording for audio.`);
      }
    }
  } catch (error) {
    setQuickStatus(`探测失败: ${error.message} / Failed`);
    mediaListContainer.innerHTML = '';
    downloadAllButton.disabled = true;
  } finally {
    detectMediaButton.disabled = false;
  }
}

/* ===== §11 Audio Export (WAV/WEBM/MP3) ================================ */

function extractSamples(startSec, endSec) {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(totalSamples, Math.floor(endSec * sampleRate));
  const len = Math.max(0, end - start);
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  for (const chunk of chunks) {
    if (chunk.endSample <= start || chunk.startSample >= end) continue;
    const rs = Math.max(start, chunk.startSample);
    const re = Math.min(end, chunk.endSample);
    const so = rs - chunk.startSample;
    const to = rs - start;
    left.set(chunk.left.subarray(so, so + re - rs), to);
    right.set(chunk.right.subarray(so, so + re - rs), to);
  }
  return { left, right };
}

function floatToInt16(s) {
  const c = Math.max(-1, Math.min(1, s));
  return c < 0 ? c * 0x8000 : c * 0x7fff;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function createWaveBlob(left, right) {
  const bps = 2, ch = 2, frames = left.length;
  const ds = frames * ch * bps;
  const buf = new ArrayBuffer(44 + ds);
  const v = new DataView(buf);

  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + ds, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * bps, true);
  v.setUint16(32, ch * bps, true);
  v.setUint16(34, 16, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, ds, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    v.setInt16(off, floatToInt16(left[i]), true); off += 2;
    v.setInt16(off, floatToInt16(right[i]), true); off += 2;
  }
  return new Blob([v], { type: 'audio/wav' });
}

function getSelectedSamples() {
  if (selectionEnd <= selectionStart) throw new Error('请选择有效片段 / Select a valid clip');
  const s = extractSamples(selectionStart, selectionEnd);
  if (!s.left.length) throw new Error('选区内没有音频 / No audio in selection');
  return s;
}

function getSelectedBlob() {
  return createWaveBlob(...Object.values(getSelectedSamples()));
}

function getMimeForFormat(format) {
  if (format === 'webm') {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  }
  if (format === 'mp3') {
    if (MediaRecorder.isTypeSupported('audio/mpeg')) return 'audio/mpeg';
    if (MediaRecorder.isTypeSupported('audio/mp3')) return 'audio/mp3';
  }
  return '';
}

function recordBufferWithMediaRecorder(samples, format) {
  return new Promise((resolve, reject) => {
    const mime = getMimeForFormat(format);
    if (!mime) {
      reject(new Error('不支持此格式 / Format not supported. Try WAV or WEBM.'));
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    const parts = [];
    const rec = new MediaRecorder(dest.stream, { mimeType: mime });

    src.buffer = ctx.createBuffer(2, samples.left.length, sampleRate);
    src.buffer.copyToChannel(samples.left, 0);
    src.buffer.copyToChannel(samples.right, 1);
    src.connect(dest);

    rec.ondataavailable = e => { if (e.data.size > 0) parts.push(e.data); };
    rec.onerror = () => { ctx.close(); reject(new Error('导出错误 / Export error')); };
    rec.onstop = () => { ctx.close(); resolve(new Blob(parts, { type: mime })); };

    rec.start();
    src.start();
    src.onended = () => rec.stop();
  });
}

async function createBlobForFormat(samples, format) {
  if (format === 'wav') return createWaveBlob(samples.left, samples.right);
  return recordBufferWithMediaRecorder(samples, format);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function saveSelectedClip() {
  try {
    const fmt = formatSelect.value;
    const blob = await createBlobForFormat(getSelectedSamples(), fmt);
    downloadBlob(blob, `clip.${fmt}`);
    setStatus('片段已保存 / Clip saved');
  } catch (e) { setStatus(e.message); }
}

async function saveFullRecording() {
  try {
    const fmt = formatSelect.value;
    const s = extractSamples(0, getDuration());
    if (!s.left.length) { setStatus('没有录音 / No recording'); return; }
    const blob = await createBlobForFormat(s, fmt);
    downloadBlob(blob, `recording.${fmt}`);
    setStatus('录音已保存 / Recording saved');
  } catch (e) { setStatus(e.message); }
}

function previewSelectedClip() {
  try {
    clearPreview();
    previewUrl = URL.createObjectURL(getSelectedBlob());
    previewAudio.src = previewUrl;
    previewAudio.classList.add('has-audio');
    previewAudio.play();
    setStatus('试听中 / Previewing');
  } catch (e) { setStatus(e.message); }
}

/* ===== §12 Event Listeners ============================================= */

pinButton.addEventListener('click', togglePin);

startButton.addEventListener('click', startCapture);
stopButton.addEventListener('click', stopCapture);
discardButton.addEventListener('click', discardRecording);

previewButton.addEventListener('click', previewSelectedClip);
downloadClipButton.addEventListener('click', saveSelectedClip);
downloadFullButton.addEventListener('click', saveFullRecording);

formatSelect.addEventListener('change', () => {
  if (formatSelect.value === 'mp3' && !getMimeForFormat('mp3')) {
    setStatus('MP3 不支持，请用 WAV 或 WEBM / MP3 not supported. Try WAV/WEBM.');
    return;
  }
  setStatus(`格式: ${formatSelect.value}`);
});

muteMonitor.addEventListener('change', () => {
  if (monitorGain) monitorGain.gain.value = muteMonitor.checked ? 0 : 1;
});

// v2.0.0: Detect media & download all buttons / 探测媒体 & 一键下载全部按钮
detectMediaButton.addEventListener('click', handleDetectMedia);
downloadAllButton.addEventListener('click', handleDownloadAll);

// Timeline drag / 时间轴拖动
timeline.addEventListener('pointerdown', (e) => {
  if (!totalSamples) return;
  timeline.setPointerCapture(e.pointerId);
  dragMode = getDragMode(e);
  updateSelectionFromDrag(e);
});

timeline.addEventListener('pointermove', updateSelectionFromDrag);

timeline.addEventListener('pointerup', (e) => {
  dragMode = null;
  timeline.releasePointerCapture(e.pointerId);
});

timeline.addEventListener('pointercancel', () => { dragMode = null; });

/* ===== §13 Initialization ============================================= */

initPinFeature();

getTargetTab()
  .then((tab) => {
    pageTitle.value = tab?.title || `Tab ${targetTabId}`;
    pageUrl.value = tab?.url || '';
  })
  .catch((error) => {
    pageTitle.value = '未选择网页 / No tab';
    pageUrl.value = '';
    setStatus(error.message);
  });

updateSelectionLabels();
updateControls();
drawTimeline();

// v2.0.0: Auto-detect all media on load / 加载时自动探测所有可下载媒体
setTimeout(() => { handleDetectMedia(); }, 500);
