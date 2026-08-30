const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const discardButton = document.querySelector("#discardButton");
const previewButton = document.querySelector("#previewButton");
const downloadFullButton = document.querySelector("#downloadFullButton");
const downloadClipButton = document.querySelector("#downloadClipButton");
const formatSelect = document.querySelector("#formatSelect");
const muteMonitor = document.querySelector("#muteMonitor");
const pageUrl = document.querySelector("#pageUrl");
const pageTitle = document.querySelector("#pageTitle");
const clock = document.querySelector("#clock");
const statusText = document.querySelector("#status");
const clipStartText = document.querySelector("#clipStartText");
const clipEndText = document.querySelector("#clipEndText");
const previewAudio = document.querySelector("#previewAudio");
const levelBar = document.querySelector("#levelBar");
const timeline = document.querySelector("#timeline");
const canvasContext = timeline.getContext("2d");

const params = new URLSearchParams(location.search);
const targetTabId = Number(params.get("tabId"));

let audioContext = null;
let sourceNode = null;
let processorNode = null;
let monitorGain = null;
let silentGain = null;
let stream = null;
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
let previewUrl = "";

function setStatus(message) {
  statusText.textContent = message;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.max(0, seconds - minutes * 60);
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(1).padStart(4, "0")}`;
}

function getDuration() {
  return totalSamples / sampleRate;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function secondsToX(seconds) {
  const duration = Math.max(getDuration(), 0.1);
  return (seconds / duration) * timeline.width;
}

function xToSeconds(clientX) {
  const rect = timeline.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  return ratio * getDuration();
}

function clearPreview() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = "";
  }
  previewAudio.pause();
  previewAudio.removeAttribute("src");
  previewAudio.classList.remove("has-audio");
}

function updateSelectionLabels() {
  clipStartText.textContent = `起点 ${formatTime(selectionStart)}`;
  clipEndText.textContent = `终点 ${formatTime(selectionEnd)}`;
}

function normalizeSelection() {
  const duration = getDuration();
  selectionStart = clamp(selectionStart, 0, duration);
  selectionEnd = clamp(selectionEnd, 0, duration);

  if (duration > 0 && selectionEnd <= selectionStart) {
    selectionStart = 0;
    selectionEnd = duration;
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

async function getTargetTab() {
  const response = await chrome.runtime.sendMessage({ type: "get-target-tab" });
  if (!response.ok && !targetTabId) {
    throw new Error("未选择录制网页，请从扩展弹窗打开录音窗口。");
  }

  return response.targetTab;
}

async function getCaptureStream() {
  const response = await chrome.runtime.sendMessage({
    type: "get-stream-id",
    tabId: targetTabId
  });

  if (!response.ok) {
    throw new Error(response.error || "无法捕获当前网页声音。");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: response.streamId
      }
    },
    video: false
  });
}

function cloneChannel(inputBuffer, channelIndex) {
  const source = inputBuffer.getChannelData(Math.min(channelIndex, inputBuffer.numberOfChannels - 1));
  return new Float32Array(source);
}

function recordAudio(event) {
  if (!recording) return;

  const inputBuffer = event.inputBuffer;
  const left = cloneChannel(inputBuffer, 0);
  const right = cloneChannel(inputBuffer, 1);
  const startSample = totalSamples;

  chunks.push({
    startSample,
    endSample: startSample + left.length,
    left,
    right
  });

  totalSamples += left.length;
  selectionEnd = getDuration();

  let peak = 0;
  for (let index = 0; index < left.length; index += 1) {
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }
  peaks.push(peak);
  levelBar.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
}

function drawEmptyTimeline(width, height) {
  canvasContext.fillStyle = "rgba(255, 255, 255, 0.12)";
  canvasContext.fillRect(0, height / 2 - 1, width, 2);
  canvasContext.fillStyle = "rgba(255, 255, 255, 0.85)";
  canvasContext.font = "700 15px Microsoft YaHei, Segoe UI, sans-serif";
  canvasContext.textAlign = "center";
  canvasContext.fillText("录制后可在这里拖动选择片段", width / 2, height / 2 - 16);
}

function drawSelection(width, height) {
  const startX = secondsToX(selectionStart);
  const endX = secondsToX(selectionEnd);

  canvasContext.fillStyle = "rgba(255, 255, 255, 0.2)";
  canvasContext.fillRect(0, 0, startX, height);
  canvasContext.fillRect(endX, 0, width - endX, height);

  canvasContext.fillStyle = "rgba(255, 238, 96, 0.22)";
  canvasContext.fillRect(startX, 0, endX - startX, height);

  canvasContext.strokeStyle = "#fff15a";
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();
  canvasContext.moveTo(startX, 18);
  canvasContext.lineTo(startX, height - 18);
  canvasContext.moveTo(endX, 18);
  canvasContext.lineTo(endX, height - 18);
  canvasContext.stroke();

  canvasContext.fillStyle = "#fff15a";
  canvasContext.fillRect(startX - 4, 58, 8, 74);
  canvasContext.fillRect(endX - 4, 58, 8, 74);
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
  canvasContext.strokeStyle = "#a30c08";
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();

  for (let x = 0; x < width; x += 1) {
    const peakSlice = peaks.slice(x * step, x * step + step);
    const peak = peakSlice.length ? Math.max(...peakSlice) : 0;
    const barHeight = Math.max(1, peak * height * 0.82);
    canvasContext.moveTo(x, height / 2 - barHeight / 2);
    canvasContext.lineTo(x, height / 2 + barHeight / 2);
  }

  canvasContext.stroke();

  canvasContext.strokeStyle = "rgba(255, 255, 255, 0.65)";
  canvasContext.lineWidth = 1;
  canvasContext.beginPath();
  canvasContext.moveTo(0, height / 2);
  canvasContext.lineTo(width, height / 2);
  canvasContext.stroke();

  normalizeSelection();
  drawSelection(width, height);
}

function tick() {
  clock.textContent = formatTime(getDuration());
  drawTimeline();
  animationId = requestAnimationFrame(tick);
}

async function startCapture() {
  try {
    clearPreview();
    chunks = [];
    peaks = [];
    totalSamples = 0;
    selectionStart = 0;
    selectionEnd = 0;
    stream = await getCaptureStream();
    audioContext = new AudioContext();
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
    setStatus("正在录制网页声音");
    tick();
  } catch (error) {
    setStatus(error.message);
  }
}

function stopCapture() {
  recording = false;
  cancelAnimationFrame(animationId);

  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (monitorGain) monitorGain.disconnect();
  if (silentGain) silentGain.disconnect();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();

  levelBar.style.width = "0%";
  clock.textContent = formatTime(getDuration());
  selectionEnd = getDuration();
  drawTimeline();
  updateControls();
  setStatus(`已录制 ${formatTime(getDuration())}`);
}

function discardRecording() {
  if (recording) stopCapture();
  clearPreview();
  chunks = [];
  peaks = [];
  totalSamples = 0;
  selectionStart = 0;
  selectionEnd = 0;
  levelBar.style.width = "0%";
  clock.textContent = "00:00.0";
  drawTimeline();
  updateControls();
  setStatus("已丢弃录音");
}

function extractSamples(startSeconds, endSeconds) {
  const startSample = Math.max(0, Math.floor(startSeconds * sampleRate));
  const endSample = Math.min(totalSamples, Math.floor(endSeconds * sampleRate));
  const length = Math.max(0, endSample - startSample);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (const chunk of chunks) {
    if (chunk.endSample <= startSample || chunk.startSample >= endSample) continue;

    const readStart = Math.max(startSample, chunk.startSample);
    const readEnd = Math.min(endSample, chunk.endSample);
    const sourceOffset = readStart - chunk.startSample;
    const targetOffset = readStart - startSample;
    left.set(chunk.left.subarray(sourceOffset, sourceOffset + readEnd - readStart), targetOffset);
    right.set(chunk.right.subarray(sourceOffset, sourceOffset + readEnd - readStart), targetOffset);
  }

  return { left, right };
}

function floatToInt16(sample) {
  const clipped = Math.max(-1, Math.min(1, sample));
  return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function createWaveBlob(left, right) {
  const bytesPerSample = 2;
  const channelCount = 2;
  const frameCount = left.length;
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < frameCount; index += 1) {
    view.setInt16(offset, floatToInt16(left[index]), true);
    offset += 2;
    view.setInt16(offset, floatToInt16(right[index]), true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function getSelectedSamples() {
  if (selectionEnd <= selectionStart) {
    throw new Error("请选择有效片段");
  }

  const samples = extractSamples(selectionStart, selectionEnd);
  if (!samples.left.length) {
    throw new Error("选区内没有音频");
  }

  return samples;
}

function getSelectedBlob() {
  const samples = getSelectedSamples();
  return createWaveBlob(samples.left, samples.right);
}

function createAudioBufferFromSamples(context, samples) {
  const buffer = context.createBuffer(2, samples.left.length, sampleRate);
  buffer.copyToChannel(samples.left, 0);
  buffer.copyToChannel(samples.right, 1);
  return buffer;
}

function getMimeForFormat(format) {
  if (format === "webm") {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  }

  if (format === "mp3") {
    if (MediaRecorder.isTypeSupported("audio/mpeg")) return "audio/mpeg";
    if (MediaRecorder.isTypeSupported("audio/mp3")) return "audio/mp3";
  }

  return "";
}

function recordBufferWithMediaRecorder(samples, format) {
  return new Promise((resolve, reject) => {
    const mimeType = getMimeForFormat(format);
    if (!mimeType) {
      reject(new Error("当前浏览器不支持直接导出该格式，请选择 WAV 或 WEBM。"));
      return;
    }

    const renderContext = new AudioContext({ sampleRate });
    const destination = renderContext.createMediaStreamDestination();
    const source = renderContext.createBufferSource();
    const recordedParts = [];
    const recorder = new MediaRecorder(destination.stream, { mimeType });

    source.buffer = createAudioBufferFromSamples(renderContext, samples);
    source.connect(destination);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedParts.push(event.data);
    };
    recorder.onerror = () => {
      renderContext.close();
      reject(new Error("导出音频时出错。"));
    };
    recorder.onstop = () => {
      renderContext.close();
      resolve(new Blob(recordedParts, { type: mimeType }));
    };

    recorder.start();
    source.start();
    source.onended = () => recorder.stop();
  });
}

async function createBlobForFormat(samples, format) {
  if (format === "wav") {
    return createWaveBlob(samples.left, samples.right);
  }

  return recordBufferWithMediaRecorder(samples, format);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveSelectedClip() {
  try {
    const format = formatSelect.value;
    const samples = getSelectedSamples();
    const blob = await createBlobForFormat(samples, format);
    downloadBlob(blob, `听力片段.${format}`);
    setStatus("片段已保存");
  } catch (error) {
    setStatus(error.message);
  }
}

async function saveFullRecording() {
  try {
    const format = formatSelect.value;
    const samples = extractSamples(0, getDuration());
    if (!samples.left.length) {
      setStatus("没有可保存的录音");
      return;
    }

    const blob = await createBlobForFormat(samples, format);
    downloadBlob(blob, `完整录音.${format}`);
    setStatus("完整录音已保存");
  } catch (error) {
    setStatus(error.message);
  }
}

function previewSelectedClip() {
  try {
    clearPreview();
    previewUrl = URL.createObjectURL(getSelectedBlob());
    previewAudio.src = previewUrl;
    previewAudio.classList.add("has-audio");
    previewAudio.play();
    setStatus("正在试听片段");
  } catch (error) {
    setStatus(error.message);
  }
}

function getDragMode(event) {
  const x = event.offsetX * (timeline.width / timeline.clientWidth);
  const startX = secondsToX(selectionStart);
  const endX = secondsToX(selectionEnd);
  const handleWidth = 18;

  if (Math.abs(x - startX) <= handleWidth) return "start";
  if (Math.abs(x - endX) <= handleWidth) return "end";
  if (x > startX && x < endX) {
    dragOffset = xToSeconds(event.clientX) - selectionStart;
    return "move";
  }

  selectionStart = xToSeconds(event.clientX);
  selectionEnd = clamp(selectionStart + Math.min(5, getDuration() - selectionStart), selectionStart, getDuration());
  return "end";
}

function updateSelectionFromDrag(event) {
  if (!dragMode) return;

  const duration = getDuration();
  const pointerSeconds = xToSeconds(event.clientX);
  const minGap = Math.min(0.1, duration);

  if (dragMode === "start") {
    selectionStart = clamp(pointerSeconds, 0, selectionEnd - minGap);
  }

  if (dragMode === "end") {
    selectionEnd = clamp(pointerSeconds, selectionStart + minGap, duration);
  }

  if (dragMode === "move") {
    const selectionLength = selectionEnd - selectionStart;
    const nextStart = clamp(pointerSeconds - dragOffset, 0, Math.max(0, duration - selectionLength));
    selectionStart = nextStart;
    selectionEnd = nextStart + selectionLength;
  }

  clearPreview();
  drawTimeline();
}

startButton.addEventListener("click", startCapture);
stopButton.addEventListener("click", stopCapture);
discardButton.addEventListener("click", discardRecording);
previewButton.addEventListener("click", previewSelectedClip);
downloadClipButton.addEventListener("click", saveSelectedClip);
downloadFullButton.addEventListener("click", saveFullRecording);
formatSelect.addEventListener("change", () => {
  if (formatSelect.value === "mp3" && !getMimeForFormat("mp3")) {
    setStatus("当前浏览器通常不能直接编码 MP3，可先保存 WAV 或 WEBM。");
    return;
  }

  setStatus(`已选择 ${formatSelect.options[formatSelect.selectedIndex].textContent}`);
});
muteMonitor.addEventListener("change", () => {
  if (monitorGain) monitorGain.gain.value = muteMonitor.checked ? 0 : 1;
});

timeline.addEventListener("pointerdown", (event) => {
  if (!totalSamples) return;
  timeline.setPointerCapture(event.pointerId);
  dragMode = getDragMode(event);
  updateSelectionFromDrag(event);
});

timeline.addEventListener("pointermove", updateSelectionFromDrag);
timeline.addEventListener("pointerup", (event) => {
  dragMode = null;
  timeline.releasePointerCapture(event.pointerId);
});
timeline.addEventListener("pointercancel", () => {
  dragMode = null;
});

getTargetTab()
  .then((tab) => {
    pageTitle.value = tab?.title || `网页 ${targetTabId}`;
    pageUrl.value = tab?.url || "";
  })
  .catch((error) => {
    pageTitle.value = "未选择网页";
    pageUrl.value = "";
    setStatus(error.message);
  });

updateSelectionLabels();
updateControls();
drawTimeline();
