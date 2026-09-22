/* ==========================================================================
   智能听力录音机 — 录音窗口逻辑
   ==========================================================================
   功能概述：
     1. 捕获当前浏览器标签页的音频流
     2. 实时录制并绘制波形可视化
     3. 支持拖动选区、试听片段、导出 WAV/WEBM/MP3
     4. 支持固定窗口置顶（新增）
     5. 兼容主流浏览器（Chrome / Edge / Firefox）

   代码结构：
     §1  浏览器 API 兼容层
     §2  DOM 元素引用
     §3  状态变量
     §4  工具函数
     §5  固定窗口置顶功能（新增）
     §6  音频捕获（兼容多浏览器）
     §7  音频录制与数据采集
     §8  波形绘制（优化版 — 渐变色 + 频率多样化 + 缩小面积）
     §9  时间轴交互（拖动选区）
     §10 音频导出（WAV / WEBM / MP3）
     §11 事件监听绑定
     §12 初始化
   ========================================================================== */

/* ===== §1 浏览器 API 兼容层 =============================================== */

/*
  统一获取扩展 API 对象。
  - Chrome / Edge：使用全局 chrome 对象
  - Firefox：使用全局 browser 对象（Promise-based，更符合标准）
  二者的方法签名略有差异，但在此扩展中使用的大部分 API 行为一致。
*/
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

/*
  统一消息发送函数。
  Firefox 的 browser.runtime.sendMessage 返回 Promise，
  Chrome 的 chrome.runtime.sendMessage 使用回调。
  此函数将两种风格统一为 Promise 返回值，方便调用方使用 async/await。
*/
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const result = browserAPI.runtime.sendMessage(message, (response) => {
      // Chrome 回调模式：lastError 存在时表示出错
      if (browserAPI.runtime.lastError) {
        reject(new Error(browserAPI.runtime.lastError.message));
        return;
      }
      resolve(response);
    });

    // Firefox Promise 模式：返回值是 Promise
    if (result && typeof result.then === 'function') {
      result.then(resolve, reject);
    }
  });
}

/* ===== §2 DOM 元素引用 ==================================================== */

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
const pinButton = document.querySelector('#pinButton'); // 固定窗口按钮（新增）

/* ===== §3 状态变量 ======================================================== */

// 从 URL 参数中获取目标标签页 ID（由 popup.js 打开录音窗口时传入）
const params = new URLSearchParams(location.search);
const targetTabId = Number(params.get('tabId'));

// 音频相关
let audioContext = null;     // AudioContext 实例，用于音频处理
let sourceNode = null;       // 音频源节点，连接自 MediaStream
let processorNode = null;    // 脚本处理器节点，用于逐块读取音频数据
let monitorGain = null;      // 监听增益节点，控制是否播放声音
let silentGain = null;       // 静音增益节点，将处理器输出静音（仅用于驱动处理）
let stream = null;           // MediaStream，来自标签页音频捕获
let analyser = null;         // AnalyserNode，用于实时频率分析（新增，增强波形动态效果）

// 录制状态
let animationId = 0;         // requestAnimationFrame 返回的 ID
let totalSamples = 0;        // 已录制的总采样数
let sampleRate = 48000;      // 采样率（由 AudioContext 提供）
let recording = false;       // 是否正在录制
let chunks = [];             // 音频数据块数组，每个元素含 { startSample, endSample, left, right }
let peaks = [];              // 波形峰值数据数组，每个元素为 { min, max, rms, peak }（优化版）
let selectionStart = 0;      // 选区起始时间（秒）
let selectionEnd = 0;        // 选区结束时间（秒）
let dragMode = null;         // 拖动模式：'start' | 'end' | 'move' | null
let dragOffset = 0;          // 拖动偏移量（移动模式用）
let previewUrl = '';         // 试听音频的 Blob URL

// 固定窗口状态（新增）
let isPinned = false;        // 窗口是否固定置顶
let recorderWindowId = null; // 当前录音窗口的 ID

/*
  每个音频块分成多少个子块来记录峰值。
  值越大，波形越细腻、频率变化越丰富。
  设为 4 使波形细节提升 4 倍，有效解决"频率都相同"的问题。
*/
const SUB_PEAKS = 4;

/* ===== §4 工具函数 ======================================================== */

/** 设置底部状态栏文字 */
function setStatus(message) {
  statusText.textContent = message;
}

/**
 * 将秒数格式化为 MM:SS.s 格式
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间字符串，如 "01:23.4"
 */
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.max(0, seconds - minutes * 60);
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(1).padStart(4, '0')}`;
}

/** 获取当前已录制的总时长（秒） */
function getDuration() {
  return totalSamples / sampleRate;
}

/**
 * 将数值限制在 [min, max] 范围内
 * @param {number} value - 输入值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} 限制后的值
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 将时间（秒）转换为画布上的 X 坐标
 * @param {number} seconds - 时间（秒）
 * @returns {number} 画布上的 X 坐标（像素）
 */
function secondsToX(seconds) {
  const duration = Math.max(getDuration(), 0.1);
  return (seconds / duration) * timeline.width;
}

/**
 * 将鼠标 clientX 坐标转换为时间（秒）
 * @param {number} clientX - 鼠标的 clientX 坐标
 * @returns {number} 对应的时间（秒）
 */
function xToSeconds(clientX) {
  const rect = timeline.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  return ratio * getDuration();
}

/** 清除试听预览，释放 Blob URL */
function clearPreview() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  previewAudio.classList.remove('has-audio');
}

/** 更新选区起止时间标签 */
function updateSelectionLabels() {
  clipStartText.textContent = `起点 ${formatTime(selectionStart)}`;
  clipEndText.textContent = `终点 ${formatTime(selectionEnd)}`;
}

/**
 * 规范化选区：确保起止点在有效范围内，
 * 如果选区无效（终点 <= 起点）则自动选全部
 */
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

/** 根据当前状态更新按钮的启用/禁用 */
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

/* ===== §5 固定窗口置顶功能（新增） ========================================= */

/*
  实现原理：
  Chrome / Edge / Firefox 的扩展 API 均未提供原生的"窗口始终置顶"功能。
  此处通过监听 windows.onFocusChanged 事件来模拟：
  - 当窗口固定（isPinned = true）时，一旦检测到其他窗口获得焦点，
    立即调用 windows.update 将录音窗口重新聚焦到最前面。
  - 这种方式有极短的切换延迟（通常 <100ms），实际体验接近原生置顶。

  注意：此功能需要 "windows" 权限（已在 manifest.json 中声明）。
*/

/**
 * 初始化固定窗口功能
 * 获取当前窗口 ID，并注册焦点变化监听器
 */
function initPinFeature() {
  // 获取当前录音窗口的 ID
  try {
    browserAPI.windows.getCurrent((win) => {
      recorderWindowId = win.id;
    });
  } catch (e) {
    // 某些浏览器环境下可能无法获取窗口 ID，此时固定功能不可用
    pinButton.disabled = true;
    pinButton.title = '当前浏览器不支持窗口固定';
  }

  // 监听窗口焦点变化
  try {
    browserAPI.windows.onFocusChanged.addListener((windowId) => {
      // windowId 为 chrome.windows.WINDOW_ID_NONE (-1) 表示所有窗口失去焦点
      // 当固定开启且焦点转移到其他窗口时，重新聚焦录音窗口
      if (!isPinned || !recorderWindowId) return;
      if (windowId !== recorderWindowId) {
        browserAPI.windows.update(recorderWindowId, { focused: true });
      }
    });
  } catch (e) {
    pinButton.disabled = true;
    pinButton.title = '当前浏览器不支持窗口固定';
  }
}

/**
 * 切换固定窗口状态
 * 点击按钮时调用，在固定/取消固定之间切换
 */
function togglePin() {
  isPinned = !isPinned;
  pinButton.classList.toggle('active', isPinned);
  pinButton.setAttribute('aria-pressed', String(isPinned));
  pinButton.title = isPinned ? '点击取消固定' : '固定窗口置顶';

  if (isPinned) {
    setStatus('窗口已固定置顶');
    // 立即聚焦一次，确保当前处于最前
    if (recorderWindowId) {
      browserAPI.windows.update(recorderWindowId, { focused: true });
    }
  } else {
    setStatus('已取消固定');
  }
}

/* ===== §6 音频捕获（兼容多浏览器） ========================================= */

/**
 * 从 background.js 获取目标标签页信息
 * @returns {Promise<object>} 目标标签页对象
 */
async function getTargetTab() {
  const response = await sendMessage({ type: 'get-target-tab' });
  if (!response.ok && !targetTabId) {
    throw new Error('未选择录制网页，请从扩展弹窗打开录音窗口。');
  }
  return response.targetTab;
}

/**
 * 获取标签页音频流（兼容多浏览器）
 *
 * 兼容策略：
 *   方式一（Chrome / Edge）：通过 background.js 调用 tabCapture.getMediaStreamId
 *     获取 streamId，再用 getUserMedia 配合 chromeMediaSource:'tab' 获取音频流。
 *   方式二（Firefox / 通用回退）：使用 getDisplayMedia 让用户手动选择标签页，
 *     浏览器会弹出选择器让用户选择要共享的标签页并勾选"分享音频"。
 *
 * @returns {Promise<MediaStream>} 包含音频轨道的 MediaStream
 */
async function getCaptureStream() {
  /*
   * 方式一：Chrome / Edge 的 tabCapture 方式
   * 这是最无缝的体验——用户无需手动选择标签页。
   */
  if (browserAPI.tabCapture && browserAPI.tabCapture.getMediaStreamId) {
    try {
      const response = await sendMessage({
        type: 'get-stream-id',
        tabId: targetTabId
      });

      if (response.ok && response.streamId) {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            // Chrome 专有约束：指定使用标签页音频源
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: response.streamId
            }
          },
          video: false
        });
      }
      // 如果获取 streamId 失败，回退到方式二
      if (!response.ok) {
        console.warn('tabCapture 方式失败：', response.error, '，尝试 getDisplayMedia 回退。');
      }
    } catch (e) {
      console.warn('tabCapture 方式异常：', e.message, '，尝试 getDisplayMedia 回退。');
    }
  }

  /*
   * 方式二：通用的 getDisplayMedia 方式（Firefox / 回退）
   * 浏览器会弹出共享选择器，用户需要：
   *   1. 选择"标签页"共享
   *   2. 选中正在播放音频的标签页
   *   3. 勾选"分享标签页音频"复选框
   * 注意：此方式要求用户手动操作，但兼容性最好。
   */
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    setStatus('请在弹出的共享选择器中选择标签页，并勾选"分享音频"');
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,  // getDisplayMedia 要求 video 为 true，但我们会丢弃视频轨道
      audio: true   // 请求标签页音频
    });

    // 丢弃视频轨道，只保留音频
    displayStream.getVideoTracks().forEach((track) => track.stop());

    // 检查是否成功获取到音频轨道
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('未获取到音频，请确认在共享选择器中勾选了"分享标签页音频"。');
    }

    // 创建只含音频轨道的新 MediaStream
    return new MediaStream(audioTracks);
  }

  // 两种方式都不可用
  throw new Error('当前浏览器不支持标签页音频捕获。请使用 Chrome 88+、Edge 88+ 或 Firefox 112+。');
}

/* ===== §7 音频录制与数据采集 =============================================== */

/**
 * 从 AudioBuffer 中复制指定声道的数据
 * @param {AudioBuffer} inputBuffer - 输入音频缓冲区
 * @param {number} channelIndex - 声道索引（0=左, 1=右）
 * @returns {Float32Array} 该声道数据的副本
 */
function cloneChannel(inputBuffer, channelIndex) {
  const source = inputBuffer.getChannelData(
    Math.min(channelIndex, inputBuffer.numberOfChannels - 1)
  );
  return new Float32Array(source);
}

/**
 * 音频处理回调函数（由 ScriptProcessorNode.onaudioprocess 触发）
 *
 * 核心优化点（解决"频率都相同"问题）：
 *   - 将每个 4096 采样块分成 SUB_PEAKS(=4) 个子块
 *   - 每个子块独立记录 min、max、rms、peak 四个值
 *   - 这样波形数据量提升 4 倍，能够呈现更细腻的频率与振幅变化
 *   - 同时使用 min/max 实现上下不对称的波形条，更接近真实音频特征
 *
 * 注意：createScriptProcessor 已被 W3C 标记为废弃，
 *       推荐替代方案为 AudioWorklet（需要单独的 worklet 文件）。
 *       此处出于兼容性考虑继续使用，所有主流浏览器仍正常支持。
 *
 * @param {AudioProcessingEvent} event - 音频处理事件
 */
function recordAudio(event) {
  if (!recording) return;

  const inputBuffer = event.inputBuffer;
  const left = cloneChannel(inputBuffer, 0);
  const right = cloneChannel(inputBuffer, 1);
  const startSample = totalSamples;

  // 将原始采样数据存入 chunks 数组，供后续导出使用
  chunks.push({
    startSample,
    endSample: startSample + left.length,
    left,
    right
  });

  totalSamples += left.length;
  selectionEnd = getDuration();

  /*
   * 计算子块峰值数据
   * 将 4096 个采样分成 4 个子块（每块约 1024 个采样）
   * 每个子块独立统计 min/max/rms/peak，使波形呈现更丰富的细节
   */
  const subSize = Math.max(1, Math.floor(left.length / SUB_PEAKS));
  let overallPeak = 0; // 整个块的最大峰值，用于驱动电平条

  for (let s = 0; s < SUB_PEAKS; s++) {
    let max = 0;       // 最大瞬时值（正方向）
    let min = 0;       // 最小瞬时值（负方向）
    let sumSq = 0;     // 平方和累加器，用于计算 RMS
    const start = s * subSize;
    const end = Math.min(start + subSize, left.length);
    const count = end - start;

    for (let i = start; i < end; i++) {
      // 同时检查左右声道，取最大/最小值
      if (left[i] > max) max = left[i];
      if (left[i] < min) min = left[i];
      if (right[i] > max) max = right[i];
      if (right[i] < min) min = right[i];
      sumSq += left[i] * left[i] + right[i] * right[i];
    }

    // RMS（均方根）能更好地反映人耳感知的响度
    const rms = count > 0 ? Math.sqrt(sumSq / (count * 2)) : 0;
    // 峰值 = max(|max|, |min|)，用于电平条显示
    const peak = Math.max(Math.abs(max), Math.abs(min));
    overallPeak = Math.max(overallPeak, peak);

    // 存入峰值数组（现在是对象而非单个数字）
    peaks.push({ max, min, rms, peak });
  }

  // 更新顶部电平条宽度（0-100%）
  levelBar.style.width = `${Math.min(100, Math.round(overallPeak * 140))}%`;
}

/* ===== §8 波形绘制（优化版） =============================================== */

/**
 * 绘制空状态时间轴（尚未录制时显示的提示文字）
 * @param {number} width - 画布宽度
 * @param {number} height - 画布高度
 */
function drawEmptyTimeline(width, height) {
  // 绘制中心基准线
  canvasContext.fillStyle = 'rgba(255, 255, 255, 0.12)';
  canvasContext.fillRect(0, height / 2 - 1, width, 2);

  // 绘制提示文字
  canvasContext.fillStyle = 'rgba(255, 255, 255, 0.85)';
  canvasContext.font = '700 15px Microsoft YaHei, Segoe UI, sans-serif';
  canvasContext.textAlign = 'center';
  canvasContext.fillText('录制后可在这里拖动选择片段', width / 2, height / 2 - 16);
}

/**
 * 绘制选区高亮（黄色半透明区域 + 两侧拖拽把手）
 * @param {number} width - 画布宽度
 * @param {number} height - 画布高度
 */
function drawSelection(width, height) {
  const startX = secondsToX(selectionStart);
  const endX = secondsToX(selectionEnd);

  // 选区外遮罩（两侧半透明白色）
  canvasContext.fillStyle = 'rgba(255, 255, 255, 0.2)';
  canvasContext.fillRect(0, 0, startX, height);
  canvasContext.fillRect(endX, 0, width - endX, height);

  // 选区内高亮（黄色半透明）
  canvasContext.fillStyle = 'rgba(255, 238, 96, 0.22)';
  canvasContext.fillRect(startX, 0, endX - startX, height);

  // 选区边界线
  canvasContext.strokeStyle = '#fff15a';
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();
  canvasContext.moveTo(startX, 12);
  canvasContext.lineTo(startX, height - 12);
  canvasContext.moveTo(endX, 12);
  canvasContext.lineTo(endX, height - 12);
  canvasContext.stroke();

  // 两侧拖拽把手（黄色竖条），高度按画布高度自适应
  const handleHeight = Math.min(50, height * 0.42);
  const handleY = (height - handleHeight) / 2;
  canvasContext.fillStyle = '#fff15a';
  canvasContext.fillRect(startX - 4, handleY, 8, handleHeight);
  canvasContext.fillRect(endX - 4, handleY, 8, handleHeight);
}

/**
 * 主绘制函数：绘制完整波形时间轴
 *
 * 优化要点（使波形更美观、频率多样化）：
 *   1. 使用 min/max 双值绘制上下不对称的波形条，更贴近真实音频
 *   2. 采用垂直渐变色（浅珊瑚 → 橙红 → 深红 → 橙红 → 浅珊瑚），
 *      使波形具有层次感和视觉吸引力
 *   3. 条形以 2px 宽 + 1px 间距绘制，比原来的逐像素线条更精致
 *   4. 画布高度从 190px 缩小到 120px，减少空间占用
 *   5. 利用 SUB_PEAKS=4 产生的 4 倍数据量，呈现更丰富的频率变化
 */
function drawTimeline() {
  const width = timeline.width;
  const height = timeline.height;
  canvasContext.clearRect(0, 0, width, height);

  // 未录制时显示空状态
  if (peaks.length === 0) {
    drawEmptyTimeline(width, height);
    updateSelectionLabels();
    return;
  }

  // 计算每个像素对应多少个峰值数据点
  const step = Math.max(1, Math.ceil(peaks.length / width));

  /*
   * 创建垂直渐变色
   * 从上到下：浅珊瑚 → 橙红 → 深红 → 橙红 → 浅珊瑚
   * 这种对称渐变使波形两端柔和、中间鲜明，视觉效果最佳
   */
  const gradient = canvasContext.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(255, 204, 188, 0.85)');
  gradient.addColorStop(0.25, 'rgba(255, 87, 34, 0.95)');
  gradient.addColorStop(0.5, 'rgba(163, 12, 8, 1)');
  gradient.addColorStop(0.75, 'rgba(255, 87, 34, 0.95)');
  gradient.addColorStop(1, 'rgba(255, 204, 188, 0.85)');

  canvasContext.fillStyle = gradient;

  // 波形条参数
  const barWidth = 2;   // 每条波形宽度（像素）
  const gap = 1;        // 条间距（像素）
  const centerY = height / 2;
  // 最大波形高度占画布高度的 42%（上下各 42%，总占比 84%）
  const maxBarRatio = 0.42;

  /*
   * 逐条绘制波形
   * 每条波形覆盖 barWidth + gap 个像素宽度，
   * 从 peaks 数组中取出对应范围的数据，计算 max/min 值，
   * 绘制上下不对称的竖条
   */
  for (let x = 0; x < width; x += barWidth + gap) {
    const startIdx = Math.floor(x * step);
    const endIdx = Math.floor((x + barWidth + gap) * step);
    const slice = peaks.slice(startIdx, Math.max(startIdx + 1, endIdx));

    if (!slice.length) continue;

    // 在当前像素范围内找出最大值和最小值
    let maxVal = 0;
    let minVal = 0;
    for (const p of slice) {
      if (p.max > maxVal) maxVal = p.max;
      if (p.min < minVal) minVal = p.min;
    }

    // 计算上下两半的波形高度（不对称，反映真实音频特征）
    const topHeight = Math.max(1, Math.abs(maxVal) * height * maxBarRatio);
    const bottomHeight = Math.max(1, Math.abs(minVal) * height * maxBarRatio);

    // 绘制波形条（从中心向上向下延伸）
    canvasContext.fillRect(x, centerY - topHeight, barWidth, topHeight + bottomHeight);
  }

  // 绘制中心基准线（半透明白色水平线）
  canvasContext.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  canvasContext.lineWidth = 1;
  canvasContext.beginPath();
  canvasContext.moveTo(0, centerY);
  canvasContext.lineTo(width, centerY);
  canvasContext.stroke();

  // 绘制选区
  normalizeSelection();
  drawSelection(width, height);
}

/**
 * requestAnimationFrame 回调：更新计时器并重绘波形
 */
function tick() {
  clock.textContent = formatTime(getDuration());
  drawTimeline();
  animationId = requestAnimationFrame(tick);
}

/**
 * 开始捕获并录制音频
 * 依次执行：清除旧数据 → 获取音频流 → 创建 AudioContext → 连接节点 → 开始录制
 */
async function startCapture() {
  try {
    clearPreview();
    chunks = [];
    peaks = [];
    totalSamples = 0;
    selectionStart = 0;
    selectionEnd = 0;

    // 获取标签页音频流（兼容多浏览器）
    stream = await getCaptureStream();

    // 创建 AudioContext（兼容 webkit 前缀）
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    sampleRate = audioContext.sampleRate;

    // 创建音频处理节点
    sourceNode = audioContext.createMediaStreamSource(stream);
    // createScriptProcessor 已废弃但仍被所有主流浏览器支持
    // 参数：(缓冲区大小, 输入声道数, 输出声道数)
    processorNode = audioContext.createScriptProcessor(4096, 2, 2);
    monitorGain = audioContext.createGain();
    silentGain = audioContext.createGain();

    // 设置增益：monitorGain 控制是否播放声音，silentGain 始终为 0（仅驱动处理器）
    monitorGain.gain.value = muteMonitor.checked ? 0 : 1;
    silentGain.gain.value = 0;

    // 连接音频处理图：
    // source → monitor → destination（监听播放）
    // source → processor → silent → destination（驱动处理器，不产生声音）
    sourceNode.connect(monitorGain);
    monitorGain.connect(audioContext.destination);
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    processorNode.onaudioprocess = recordAudio;

    recording = true;
    updateControls();
    setStatus('正在录制网页声音');
    tick();
  } catch (error) {
    setStatus(error.message);
  }
}

/**
 * 停止录制：断开所有音频节点，释放资源
 */
function stopCapture() {
  recording = false;
  cancelAnimationFrame(animationId);

  // 按照连接顺序的逆序断开节点
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (monitorGain) monitorGain.disconnect();
  if (silentGain) silentGain.disconnect();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();

  levelBar.style.width = '0%';
  clock.textContent = formatTime(getDuration());
  selectionEnd = getDuration();
  drawTimeline();
  updateControls();
  setStatus(`已录制 ${formatTime(getDuration())}`);
}

/**
 * 丢弃当前录音，清空所有数据
 */
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
  setStatus('已丢弃录音');
}

/* ===== §9 时间轴交互（拖动选区） =========================================== */

/**
 * 判断鼠标在时间轴上的拖动模式
 * @param {PointerEvent} event - 指针事件
 * @returns {'start'|'end'|'move'} 拖动模式
 */
function getDragMode(event) {
  // 将鼠标 offsetX 转换为画布内部坐标
  const x = event.offsetX * (timeline.width / timeline.clientWidth);
  const startX = secondsToX(selectionStart);
  const endX = secondsToX(selectionEnd);
  const handleWidth = 18; // 把手检测区域宽度（像素）

  // 靠近起点把手
  if (Math.abs(x - startX) <= handleWidth) return 'start';
  // 靠近终点把手
  if (Math.abs(x - endX) <= handleWidth) return 'end';
  // 在选区内部 → 整体移动
  if (x > startX && x < endX) {
    dragOffset = xToSeconds(event.clientX) - selectionStart;
    return 'move';
  }

  // 在选区外部点击 → 从点击位置开始新建选区（默认 5 秒长度）
  selectionStart = xToSeconds(event.clientX);
  selectionEnd = clamp(
    selectionStart + Math.min(5, getDuration() - selectionStart),
    selectionStart,
    getDuration()
  );
  return 'end';
}

/**
 * 根据拖动模式更新选区
 * @param {PointerEvent} event - 指针事件
 */
function updateSelectionFromDrag(event) {
  if (!dragMode) return;

  const duration = getDuration();
  const pointerSeconds = xToSeconds(event.clientX);
  const minGap = Math.min(0.1, duration); // 选区最小间距（秒）

  if (dragMode === 'start') {
    // 拖动起点把手
    selectionStart = clamp(pointerSeconds, 0, selectionEnd - minGap);
  }

  if (dragMode === 'end') {
    // 拖动终点把手
    selectionEnd = clamp(pointerSeconds, selectionStart + minGap, duration);
  }

  if (dragMode === 'move') {
    // 整体移动选区
    const selectionLength = selectionEnd - selectionStart;
    const nextStart = clamp(pointerSeconds - dragOffset, 0, Math.max(0, duration - selectionLength));
    selectionStart = nextStart;
    selectionEnd = nextStart + selectionLength;
  }

  clearPreview();
  drawTimeline();
}

/* ===== §10 音频导出（WAV / WEBM / MP3） ==================================== */

/**
 * 从 chunks 数组中提取指定时间范围内的采样数据
 * @param {number} startSeconds - 起始时间（秒）
 * @param {number} endSeconds - 结束时间（秒）
 * @returns {{left: Float32Array, right: Float32Array}} 左右声道采样数据
 */
function extractSamples(startSeconds, endSeconds) {
  const startSample = Math.max(0, Math.floor(startSeconds * sampleRate));
  const endSample = Math.min(totalSamples, Math.floor(endSeconds * sampleRate));
  const length = Math.max(0, endSample - startSample);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  // 遍历所有数据块，将落在目标范围内的数据复制到结果数组
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

/**
 * 将浮点采样值转换为 16 位有符号整数（PCM 编码用）
 * @param {number} sample - 浮点采样值（-1.0 ~ 1.0）
 * @returns {number} 16 位有符号整数（-32768 ~ 32767）
 */
function floatToInt16(sample) {
  const clipped = Math.max(-1, Math.min(1, sample));
  return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
}

/**
 * 向 DataView 中写入 ASCII 字符串
 * @param {DataView} view - 数据视图
 * @param {number} offset - 写入偏移量
 * @param {string} text - 要写入的 ASCII 字符串
 */
function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * 将左右声道采样数据编码为 WAV 格式的 Blob
 * WAV 格式：RIFF / WAVE 容器，PCM 编码，16 位深度，双声道
 *
 * @param {Float32Array} left - 左声道采样数据
 * @param {Float32Array} right - 右声道采样数据
 * @returns {Blob} WAV 格式的音频 Blob
 */
function createWaveBlob(left, right) {
  const bytesPerSample = 2;  // 16 位 = 2 字节
  const channelCount = 2;    // 双声道
  const frameCount = left.length;
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize); // 44 字节 WAV 头 + 音频数据
  const view = new DataView(buffer);

  // === RIFF 头 ===
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);  // 文件大小 - 8
  writeAscii(view, 8, 'WAVE');

  // === fmt 子块 ===
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt 子块大小（固定 16）
  view.setUint16(20, 1, true);             // 音频格式：1 = PCM
  view.setUint16(22, channelCount, true);  // 声道数
  view.setUint32(24, sampleRate, true);    // 采样率
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true); // 字节率
  view.setUint16(32, channelCount * bytesPerSample, true); // 块对齐
  view.setUint16(34, 16, true);            // 位深度：16 位

  // === data 子块 ===
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);      // 数据大小

  // 写入交错的双声道 PCM 数据：L R L R L R ...
  let offset = 44;
  for (let index = 0; index < frameCount; index += 1) {
    view.setInt16(offset, floatToInt16(left[index]), true);
    offset += 2;
    view.setInt16(offset, floatToInt16(right[index]), true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

/**
 * 获取选区内的采样数据，如果选区无效则抛出异常
 * @returns {{left: Float32Array, right: Float32Array}} 采样数据
 */
function getSelectedSamples() {
  if (selectionEnd <= selectionStart) {
    throw new Error('请选择有效片段');
  }

  const samples = extractSamples(selectionStart, selectionEnd);
  if (!samples.left.length) {
    throw new Error('选区内没有音频');
  }

  return samples;
}

/**
 * 获取选区内的 WAV Blob（用于试听）
 * @returns {Blob} WAV 格式的音频 Blob
 */
function getSelectedBlob() {
  const samples = getSelectedSamples();
  return createWaveBlob(samples.left, samples.right);
}

/**
 * 从采样数据创建 AudioBuffer（用于 MediaRecorder 编码）
 * @param {AudioContext} context - AudioContext 实例
 * @param {{left: Float32Array, right: Float32Array}} samples - 采样数据
 * @returns {AudioBuffer} 包含采样数据的 AudioBuffer
 */
function createAudioBufferFromSamples(context, samples) {
  const buffer = context.createBuffer(2, samples.left.length, sampleRate);
  buffer.copyToChannel(samples.left, 0);
  buffer.copyToChannel(samples.right, 1);
  return buffer;
}

/**
 * 根据目标格式获取支持的 MIME 类型
 * 通过 MediaRecorder.isTypeSupported 检测浏览器是否支持该编码
 *
 * @param {string} format - 目标格式：'webm' | 'mp3'
 * @returns {string} MIME 类型字符串，不支持时返回空字符串
 */
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

/**
 * 使用 MediaRecorder 将采样数据编码为目标格式
 * 原理：创建 AudioBufferSourceNode 播放采样数据 → MediaStreamDestination 接收 →
 *       MediaRecorder 录制 → 收集 Blob 片段 → 合并为最终文件
 *
 * @param {{left: Float32Array, right: Float32Array}} samples - 采样数据
 * @param {string} format - 目标格式：'webm' | 'mp3'
 * @returns {Promise<Blob>} 编码后的音频 Blob
 */
function recordBufferWithMediaRecorder(samples, format) {
  return new Promise((resolve, reject) => {
    const mimeType = getMimeForFormat(format);
    if (!mimeType) {
      reject(new Error('当前浏览器不支持直接导出该格式，请选择 WAV 或 WEBM。'));
      return;
    }

    const renderContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
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
      reject(new Error('导出音频时出错。'));
    };
    recorder.onstop = () => {
      renderContext.close();
      resolve(new Blob(recordedParts, { type: mimeType }));
    };

    // 开始播放和录制，播放结束后自动停止录制
    recorder.start();
    source.start();
    source.onended = () => recorder.stop();
  });
}

/**
 * 根据格式创建音频 Blob
 * @param {{left: Float32Array, right: Float32Array}} samples - 采样数据
 * @param {string} format - 目标格式：'wav' | 'webm' | 'mp3'
 * @returns {Promise<Blob>} 音频 Blob
 */
async function createBlobForFormat(samples, format) {
  if (format === 'wav') {
    return createWaveBlob(samples.left, samples.right);
  }
  return recordBufferWithMediaRecorder(samples, format);
}

/**
 * 触发浏览器下载 Blob 为文件
 * @param {Blob} blob - 要下载的 Blob 数据
 * @param {string} filename - 文件名
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 保存选区片段为音频文件
 */
async function saveSelectedClip() {
  try {
    const format = formatSelect.value;
    const samples = getSelectedSamples();
    const blob = await createBlobForFormat(samples, format);
    downloadBlob(blob, `听力片段.${format}`);
    setStatus('片段已保存');
  } catch (error) {
    setStatus(error.message);
  }
}

/**
 * 保存完整录音为音频文件
 */
async function saveFullRecording() {
  try {
    const format = formatSelect.value;
    const samples = extractSamples(0, getDuration());
    if (!samples.left.length) {
      setStatus('没有可保存的录音');
      return;
    }

    const blob = await createBlobForFormat(samples, format);
    downloadBlob(blob, `完整录音.${format}`);
    setStatus('完整录音已保存');
  } catch (error) {
    setStatus(error.message);
  }
}

/**
 * 试听选区片段
 * 创建 WAV Blob 并通过 <audio> 元素播放
 */
function previewSelectedClip() {
  try {
    clearPreview();
    previewUrl = URL.createObjectURL(getSelectedBlob());
    previewAudio.src = previewUrl;
    previewAudio.classList.add('has-audio');
    previewAudio.play();
    setStatus('正在试听片段');
  } catch (error) {
    setStatus(error.message);
  }
}

/* ===== §11 事件监听绑定 ==================================================== */

// 固定窗口按钮（新增）
pinButton.addEventListener('click', togglePin);

// 录制控制按钮
startButton.addEventListener('click', startCapture);
stopButton.addEventListener('click', stopCapture);
discardButton.addEventListener('click', discardRecording);

// 试听与保存按钮
previewButton.addEventListener('click', previewSelectedClip);
downloadClipButton.addEventListener('click', saveSelectedClip);
downloadFullButton.addEventListener('click', saveFullRecording);

// 格式选择变化时检查浏览器是否支持
formatSelect.addEventListener('change', () => {
  if (formatSelect.value === 'mp3' && !getMimeForFormat('mp3')) {
    setStatus('当前浏览器通常不能直接编码 MP3，可先保存 WAV 或 WEBM。');
    return;
  }
  setStatus(`已选择 ${formatSelect.options[formatSelect.selectedIndex].textContent}`);
});

// 静音监听复选框
muteMonitor.addEventListener('change', () => {
  if (monitorGain) monitorGain.gain.value = muteMonitor.checked ? 0 : 1;
});

/*
  时间轴拖动交互
  使用 Pointer Events（pointerdown / pointermove / pointerup），
  同时支持鼠标、触摸屏和手写笔操作，兼容移动端浏览器
*/
timeline.addEventListener('pointerdown', (event) => {
  if (!totalSamples) return;
  timeline.setPointerCapture(event.pointerId);
  dragMode = getDragMode(event);
  updateSelectionFromDrag(event);
});

timeline.addEventListener('pointermove', updateSelectionFromDrag);

timeline.addEventListener('pointerup', (event) => {
  dragMode = null;
  timeline.releasePointerCapture(event.pointerId);
});

timeline.addEventListener('pointercancel', () => {
  dragMode = null;
});

/* ===== §12 初始化 ========================================================== */

// 初始化固定窗口功能（新增）
initPinFeature();

// 获取目标标签页信息并显示
getTargetTab()
  .then((tab) => {
    pageTitle.value = tab?.title || `网页 ${targetTabId}`;
    pageUrl.value = tab?.url || '';
  })
  .catch((error) => {
    pageTitle.value = '未选择网页';
    pageUrl.value = '';
    setStatus(error.message);
  });

// 初始化 UI 状态
updateSelectionLabels();
updateControls();
drawTimeline();
