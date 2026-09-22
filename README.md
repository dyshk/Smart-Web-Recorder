# 智能听力录音机 / Smart Web Recorder

> 浏览器扩展：录制网页声音 + 一键探测下载音频文件  
> 兼容 Chrome、Edge、Firefox | English: [README_EN.md](README_EN.md)

## 功能特性

### 录制功能
- **标签页音频录制** — 通过 tabCapture 捕获当前标签页声音（Chrome/Edge）
- **波形可视化** — 实时渐变色波形，4 倍子峰值采样，频率细节丰富
- **片段选择** — 在时间轴上拖动选择，试听并导出指定片段
- **多格式导出** — 支持 WAV、WEBM、MP3 格式保存
- **固定窗口置顶** — 录音窗口保持在浏览器最前面

### 一键探测下载（v2.0.0 新增）
- **直接下载音频文件** — 检测网页中的 `<audio>`/`<video>` 元素，直接下载源音频文件，**不是录音**
- **多源探测** — 同时扫描 HTML 媒体元素和 Performance API 资源，发现所有可下载的音频
- **多源选择** — 探测到多个音频源时列表展示，逐个下载
- **blob URL 支持** — 支持 blob: 开头的音频 URL 下载
- **流媒体识别** — 自动识别 m3u8/mpd 流媒体，提示使用录制功能
- **跨浏览器** — 探测下载功能兼容 Chrome/Edge/Firefox

## 安装方法

### Chrome / Edge
1. 下载或克隆本仓库
2. 打开 `chrome://extensions`（Chrome）或 `edge://extensions`（Edge）
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择项目文件夹

### Firefox
1. 下载或克隆本仓库
2. 打开 `about:debugging#/runtime/this-firefox`
3. 点击 **临时加载附加组件**
4. 选择项目文件夹中的 `manifest.json`

## 使用说明

### 录制标签页音频
1. 打开正在播放音频或视频的网页
2. 点击工具栏中的扩展图标
3. 点击 **打开录音窗口**
4. 点击 **开始录制**
5. 录制完成后点击 **停止**
6. 在波形时间轴上拖动选择片段
7. 点击 **保存片段** 或 **保存完整录音**

### 一键探测下载
1. 在有音频播放的网页上打开录音窗口
2. 扩展自动探测页面中的音频源（也可点击"探测音频"手动刷新）
3. 列表显示所有检测到的音频文件
4. 点击每项右侧的 **⬇** 按钮直接下载
5. 浏览器会弹出保存对话框，选择位置即可

> **注意：** 流媒体（m3u8/mpd）无法直接下载，请使用录制功能。

## 文件结构

```
Smart-Web-Recorder/
├── manifest.json       # 扩展清单（MV3）
├── background.js       # Service Worker — 标签页管理、tabCapture、媒体探测注入、下载
├── popup.html          # 弹窗 UI
├── popup.css           # 弹窗样式
├── popup.js            # 弹窗逻辑 — 获取当前标签页 & 打开录音窗口
├── recorder.html       # 录音窗口 UI
├── recorder.css        # 录音窗口样式
├── recorder.js         # 核心逻辑 — 录制、波形、探测下载
├── README.md           # 中文说明（本文件）
└── README_EN.md        # English documentation
```

## 浏览器兼容性

| 功能 | Chrome 88+ | Edge 88+ | Firefox 112+ |
|---|---|---|---|
| 录制标签页音频 | ✅ tabCapture | ✅ tabCapture | ⚠️ 可能不支持 |
| 波形可视化 | ✅ | ✅ | ✅ |
| WAV/WEBM 导出 | ✅ | ✅ | ✅ |
| 一键探测下载 | ✅ | ✅ | ✅ |
| 固定窗口置顶 | ✅ | ✅ | ✅ |

## 技术原理

### 一键探测下载（v2.0.0）

1. `recorder.js` 发送 `detect-media` 消息到 `background.js`
2. `background.js` 使用 `chrome.scripting.executeScript()` 注入检测函数到目标标签页
3. 检测函数扫描页面中所有 `<audio>`/`<video>`/`<source>` 元素
4. 同时通过 `performance.getEntriesByType('resource')` 发现动态加载的音频资源
5. 结果返回到录音窗口，以列表形式展示
6. 用户点击下载时：
   - HTTP/HTTPS URL → `chrome.downloads.download()` 直接下载
   - blob: URL → 注入下载函数到页面，在页面上下文中创建 `<a download>` 点击下载

### 波形可视化

每个 4096 采样块分成 4 个子块，各自记录 min/max/RMS/peak，4 倍数据量使波形呈现更丰富的频率变化。垂直渐变色 + 上下不对称波形条。

### 录制

通过 `tabCapture.getMediaStreamId()` 获取流 ID，再用 `getUserMedia` 配合 `chromeMediaSource:'tab'` 获取音频流。ScriptProcessorNode 逐块读取采样数据。

## License

MIT
