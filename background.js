let targetTab = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "set-target-tab") {
    targetTab = {
      id: message.tab.id,
      title: message.tab.title || "未命名网页",
      url: message.tab.url || ""
    };
    sendResponse({ ok: true, targetTab });
    return false;
  }

  if (message.type === "get-target-tab") {
    sendResponse({ ok: Boolean(targetTab), targetTab });
    return false;
  }

  if (message.type === "get-stream-id") {
    const tabId = Number(message.tabId || targetTab?.id);
    const consumerTabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "未选择录制网页。" });
      return false;
    }

    if (!consumerTabId) {
      sendResponse({ ok: false, error: "无法确认录音窗口，请重新打开录音窗口。" });
      return false;
    }

    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId, consumerTabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError?.message || "无法录制当前网页。"
        });
        return;
      }

      sendResponse({ ok: true, streamId });
    });
    return true;
  }

  return false;
});
