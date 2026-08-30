const tabTitle = document.querySelector("#tabTitle");
const tabUrl = document.querySelector("#tabUrl");
const statusText = document.querySelector("#status");
const openRecorder = document.querySelector("#openRecorder");

let activeTab = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function initialize() {
  activeTab = await getActiveTab();

  if (!activeTab?.id || activeTab.url?.startsWith("chrome://") || activeTab.url?.startsWith("edge://")) {
    tabTitle.textContent = "此页面无法录制";
    tabUrl.textContent = activeTab?.url || "";
    statusText.textContent = "请打开普通网页中的视频或音频后再试。";
    return;
  }

  tabTitle.textContent = activeTab.title || "未命名网页";
  tabUrl.textContent = activeTab.url || "";
  statusText.textContent = "可以打开录音窗口。";
  openRecorder.disabled = false;
}

openRecorder.addEventListener("click", async () => {
  if (!activeTab) return;

  await chrome.runtime.sendMessage({ type: "set-target-tab", tab: activeTab });
  const recorderUrl = chrome.runtime.getURL(`recorder.html?tabId=${activeTab.id}`);

  await chrome.windows.create({
    url: recorderUrl,
    type: "popup",
    width: 520,
    height: 700
  });

  window.close();
});

initialize().catch((error) => {
  tabTitle.textContent = "准备失败";
  statusText.textContent = error.message;
});
