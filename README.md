# 智能听力录音机

这是一个 Edge/Chromium 扩展，用来录制当前网页标签页的声音，并把音频片段保存为 WAV 文件。
<p align="center">
  <img width="500" height="809" alt="16394745a0d1e6244e33cf89f4a120c2" src="https://github.com/user-attachments/assets/5a216bc7-673a-4c30-9b5d-7bb32e39d3f2" />
  <img width="497" height="738" alt="d360f20df7590274a05a37a6a0f60da0" src="https://github.com/user-attachments/assets/f1035692-49bc-40e8-861e-e0d25186fd5c" />
  <img width="494" height="745" alt="017a133f2e4f5e230a281561f5d9e6e2" src="https://github.com/user-attachments/assets/1de4e69a-a123-4af1-9382-86a811bc54ae" />
</p>


## 在 Microsoft Edge 中安装
点击Code——Download ZIP——解压缩
1. 打开浏览器扩展。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择此解压后的文件夹：`edge-audio-capture-extension`。

## 使用方法

1. 打开正在播放英语听力音频或视频的普通网页。
2. 点击扩展图标，再点击“打开录音窗口”。
3. 在录音窗口点击“开始录制”。
4. 录制完成后，拖动波形上的左右黄色把手选择片段，也可以拖动黄色选区整体移动。
5. 点击“试听片段”确认内容，再选择格式并点击“保存片段”下载。

## 注意事项

- `edge://extensions`、`chrome://extensions` 等浏览器内部页面不能被录制。
- 录制时请保持录音窗口打开。
- 长录音会暂存在内存中，保存或关闭窗口前不会写入文件。
- 当前版本支持保存 WAV 和 WEBM；MP3 会尝试使用浏览器原生编码，如果 Edge 不支持，会提示先保存 WAV 或 WEBM。
- 如果 B 站等视频网页没有录到声音，请确认是从目标视频页点击扩展图标打开录音窗口，并在视频开始播放后再点“开始录制”。
- 请确认你有权保存所录制的媒体内容。
