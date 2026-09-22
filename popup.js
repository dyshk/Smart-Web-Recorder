/* ==========================================================================
   智能听力录音机 — 扩展弹窗逻辑
   ==========================================================================
   功能：
     1. 获取当前活跃标签页信息并显示
     2. 点击"打开录音窗口"按钮后，将标签页信息发送给 background.js，
        然后打开 recorder.html 作为独立窗口

   浏览器兼容：
     - Chrome / Edge：使用 chrome.* API
     - Firefox：使用 browser.* API（Promise-based）
   ========================================================================== */

/*
  浏览器 API 兼容层
  Firefox 使用 browser 对象（基于 Promise），Chrome / Edge 使用 chrome 对象（基于回调）。
  这里统一获取可用的 API 对象。
*/
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

const tabTitle = document.querySelector('#tabTitle');
const tabUrl = document.querySelector('#tabUrl');
const statusText = document.querySelector('#status');
const openRecorder = document.querySelector('#openRecorder');

let activeTab = null;

/**
 * 获取当前窗口中活跃的标签页
 * @returns {Promise<chrome.tabs.Tab>} 活跃标签页对象
 */
async function getActiveTab() {
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * 初始化弹窗：获取当前标签页信息并更新 UI
 */
async function initialize() {
  activeTab = await getActiveTab();

  // 浏览器内部页面（chrome://, edge://, about:）无法被录制
  if (
    !activeTab?.id ||
    activeTab.url?.startsWith('chrome://') ||
    activeTab.url?.startsWith('edge://') ||
    activeTab.url?.startsWith('about:')
  ) {
    tabTitle.textContent = '此页面无法录制';
    tabUrl.textContent = activeTab?.url || '';
    statusText.textContent = '请打开普通网页中的视频或音频后再试。';
    return;
  }

  tabTitle.textContent = activeTab.title || '未命名网页';
  tabUrl.textContent = activeTab.url || '';
  statusText.textContent = '可以打开录音窗口。';
  openRecorder.disabled = false;
}

/**
 * "打开录音窗口"按钮点击事件
 * 将当前标签页信息发送给 background.js，然后打开 recorder.html 独立窗口
 */
openRecorder.addEventListener('click', async () => {
  if (!activeTab) return;

  // 将目标标签页信息发送给 background.js 存储
  await browserAPI.runtime.sendMessage({ type: 'set-target-tab', tab: activeTab });

  // 构建录音窗口的 URL，附带标签页 ID 参数
  const recorderUrl = browserAPI.runtime.getURL(`recorder.html?tabId=${activeTab.id}`);

  // 创建独立窗口（popup 类型：无浏览器工具栏的独立窗口）
  await browserAPI.windows.create({
    url: recorderUrl,
    type: 'popup',
    width: 520,
    height: 700
  });

  // 关闭弹窗（弹窗在独立窗口打开后不再需要）
  window.close();
});

// 启动初始化
initialize().catch((error) => {
  tabTitle.textContent = '准备失败';
  statusText.textContent = error.message;
});
