/* ==========================================================================
   智能听力录音机 — 后台 Service Worker
   ==========================================================================
   功能：
     1. 存储用户选中的目标标签页信息（由 popup.js 发送）
     2. 响应录音窗口的请求：返回目标标签页信息
     3. 响应录音窗口的请求：调用 tabCapture.getMediaStreamId 获取音频流 ID
        （仅 Chrome / Edge 支持；Firefox 需通过 getDisplayMedia 回退）

   浏览器兼容：
     - Chrome / Edge：chrome.tabCapture.getMediaStreamId 可用
     - Firefox 112+：browser.tabCapture.getMediaStreamId 可用（行为类似）
     - 不支持的浏览器：recorder.js 会自动回退到 getDisplayMedia

   注意：MV3 的 Service Worker 会在空闲时被浏览器休眠，
         但消息事件会唤醒它，因此无需特殊处理。
   ========================================================================== */

/*
  浏览器 API 兼容层
  在 Service Worker 中，Firefox 使用 browser 对象，Chrome / Edge 使用 chrome 对象。
*/
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

// 存储用户选中的目标标签页信息
let targetTab = null;

/**
 * 消息监听器
 * 处理来自 popup.js 和 recorder.js 的消息
 *
 * 消息类型：
 *   - 'set-target-tab'：来自 popup.js，存储目标标签页信息
 *   - 'get-target-tab'：来自 recorder.js，获取目标标签页信息
 *   - 'get-stream-id'：来自 recorder.js，获取标签页音频流 ID（Chrome/Edge 专有）
 */
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // === 存储目标标签页 ===
  if (message.type === 'set-target-tab') {
    targetTab = {
      id: message.tab.id,
      title: message.tab.title || '未命名网页',
      url: message.tab.url || ''
    };
    sendResponse({ ok: true, targetTab });
    return false; // 同步响应，无需保持通道
  }

  // === 返回目标标签页信息 ===
  if (message.type === 'get-target-tab') {
    sendResponse({ ok: Boolean(targetTab), targetTab });
    return false;
  }

  // === 获取标签页音频流 ID（Chrome / Edge 专有） ===
  if (message.type === 'get-stream-id') {
    const tabId = Number(message.tabId || targetTab?.id);
    // sender.tab.id 是发起消息的标签页（即录音窗口）的 ID
    const consumerTabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: '未选择录制网页。' });
      return false;
    }

    if (!consumerTabId) {
      sendResponse({
        ok: false,
        error: '无法确认录音窗口，请重新打开录音窗口。'
      });
      return false;
    }

    /*
      调用 tabCapture.getMediaStreamId 获取音频流 ID
      参数：
        - targetTabId：要捕获音频的标签页 ID
        - consumerTabId：使用该流 ID 的标签页（录音窗口）ID
      返回的 streamId 会被 recorder.js 传给 getUserMedia 来获取实际音频流。

      注意：此 API 仅在 Chrome / Edge 中可用。
      Firefox 虽然也支持 tabCapture，但 recorder.js 中已有 getDisplayMedia 回退方案。
    */
    browserAPI.tabCapture.getMediaStreamId(
      { targetTabId: tabId, consumerTabId },
      (streamId) => {
        if (browserAPI.runtime.lastError || !streamId) {
          sendResponse({
            ok: false,
            error: browserAPI.runtime.lastError?.message || '无法录制当前网页。'
          });
          return;
        }

        sendResponse({ ok: true, streamId });
      }
    );

    return true; // 异步响应，保持消息通道开启
  }

  return false;
});
