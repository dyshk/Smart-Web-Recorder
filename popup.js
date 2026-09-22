/* ==========================================================================
   Smart Web Detector / 智能网页探测器 — Popup Script v2.0.0
   ==========================================================================
   Features / 功能:
     1. Get current active tab info and display / 获取当前标签页信息并显示
     2. Send tab info to background.js, then open recorder window / 发送标签页信息并打开录音窗口

   Browser Compatibility / 浏览器兼容:
     - Chrome / Edge: chrome.* API
     - Firefox: browser.* API (Promise-based)
   ========================================================================== */

/*
  Browser API compatibility layer / 浏览器 API 兼容层
*/
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

const tabTitle = document.querySelector('#tabTitle');
const tabUrl = document.querySelector('#tabUrl');
const statusText = document.querySelector('#status');
const openRecorder = document.querySelector('#openRecorder');

let activeTab = null;

/**
 * Get the active tab in current window / 获取当前窗口中的活跃标签页
 * @returns {Promise<chrome.tabs.Tab>} active tab object
 */
async function getActiveTab() {
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Initialize popup: get current tab info and update UI
 * 初始化弹窗：获取当前标签页信息并更新 UI
 */
async function initialize() {
  activeTab = await getActiveTab();

  // Browser internal pages cannot be captured / 浏览器内部页面无法录制
  if (
    !activeTab?.id ||
    activeTab.url?.startsWith('chrome://') ||
    activeTab.url?.startsWith('edge://') ||
    activeTab.url?.startsWith('about:')
  ) {
    tabTitle.textContent = '此页面无法录制 / Cannot record this page';
    tabUrl.textContent = activeTab?.url || '';
    statusText.innerHTML = '请打开包含音视频或可下载文件的网页后再试。<br>Please open a webpage with audio, video, or downloadable files.';
    return;
  }

  tabTitle.textContent = activeTab.title || '未命名网页 / Untitled';
  tabUrl.textContent = activeTab.url || '';
  statusText.innerHTML = '可以打开录音窗口。<br>Ready to open recorder window.';
  openRecorder.disabled = false;
}

/**
 * "Open Recorder" button click handler
 * Send tab info to background.js, then open recorder.html as a standalone window
 *
 * "打开录音窗口"按钮点击事件
 * 将标签页信息发送给 background.js，然后打开 recorder.html 独立窗口
 */
openRecorder.addEventListener('click', async () => {
  if (!activeTab) return;

  // Send target tab info to background.js / 发送目标标签页信息
  await browserAPI.runtime.sendMessage({ type: 'set-target-tab', tab: activeTab });

  // Build recorder URL with tab ID parameter / 构建录音窗口 URL
  const recorderUrl = browserAPI.runtime.getURL(`recorder.html?tabId=${activeTab.id}`);

  // Create standalone window (popup type: no browser toolbar)
  // 创建独立窗口（popup 类型：无浏览器工具栏）
  await browserAPI.windows.create({
    url: recorderUrl,
    type: 'popup',
    width: 520,
    height: 760
  });

  // Close popup (no longer needed after recorder window opens)
  // 关闭弹窗（录音窗口打开后不再需要）
  window.close();
});

// Start initialization / 启动初始化
initialize().catch((error) => {
  tabTitle.textContent = '准备失败 / Init failed';
  statusText.textContent = error.message;
});
