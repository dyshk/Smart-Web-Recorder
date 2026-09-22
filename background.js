/* ==========================================================================
   Smart Web Detector / 智能网页探测器 — Background Service Worker v2.0.0
   ==========================================================================
   Features / 功能:
     1. Store target tab info / 存储目标标签页信息
     2. Return target tab info to recorder.js / 返回标签页信息
     3. Call tabCapture.getMediaStreamId for recording / 获取音频流 ID（录制用）
     4. [v2.0.0] detect-media: inject script to scan page for ALL downloadable media
        v2.0.0 新增：注入脚本扫描页面中的所有可下载媒体元素和文件链接
     5. [v2.0.0] download-media: download media file directly via downloads API
        v2.0.0 新增：通过 downloads API 直接下载媒体文件

   Note: MV3 Service Worker sleeps when idle but wakes on messages.
   ========================================================================== */

const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

let targetTab = null;

/**
 * [v2.0.0] Function injected into the target page to detect ALL downloadable media.
 * This function runs in the PAGE context, not the extension context.
 * It scans for <audio>, <video>, <source>, <a> elements, poster images,
 * and Performance API resources.
 *
 * IMPORTANT: This function is serialized and injected into the page.
 * It CANNOT access any variables from the extension scope.
 * All helper data must be defined INSIDE this function.
 *
 * v2.0.0 注入到目标页面的检测函数。
 * 在页面上下文中运行，扫描所有可下载的媒体元素和文件链接。
 * 重要：此函数被序列化后注入页面，不能访问扩展作用域的变量。
 * 所有辅助数据必须在函数内部定义。
 *
 * @returns {Array} list of detected downloadable sources / 检测到的可下载源列表
 */
function detectMediaInPage() {
  const mediaList = [];
  const seen = new Set(); // dedup by URL / 按去重

  /*
   * File extension → category mapping.
   * Defined INSIDE the function because this runs in the PAGE context.
   *
   * 文件扩展名 → 类别映射。
   * 必须定义在函数内部，因为此函数在页面上下文中运行。
   */
  const FILE_CATEGORIES = {
    '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio',
    '.aac': 'audio', '.flac': 'audio', '.opus': 'audio', '.wma': 'audio',
    '.aiff': 'audio', '.amr': 'audio',
    '.mp4': 'video', '.avi': 'video', '.mov': 'video', '.mkv': 'video',
    '.webm': 'video', '.flv': 'video', '.wmv': 'video', '.m4v': 'video',
    '.mpeg': 'video', '.mpg': 'video', '.3gp': 'video',
    '.pdf': 'document', '.doc': 'document', '.docx': 'document',
    '.xls': 'document', '.xlsx': 'document', '.ppt': 'document',
    '.pptx': 'document', '.txt': 'document', '.csv': 'document', '.rtf': 'document',
    '.zip': 'archive', '.rar': 'archive', '.7z': 'archive',
    '.tar': 'archive', '.gz': 'archive', '.bz2': 'archive', '.xz': 'archive',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
    '.bmp': 'image', '.svg': 'image', '.webp': 'image', '.tiff': 'image',
    '.ico': 'image', '.avif': 'image',
  };

  /*
   * Extensions to SKIP in Performance API scan.
   * .ts = HLS stream segments (useless individually, need VLC to play).
   * .m3u8/.mpd = playlist files (not media, just manifests).
   *
   * 在 Performance API 扫描中跳过的扩展名。
   * .ts = HLS 流分片（单独下载无用，需要 VLC 播放）。
   * .m3u8/.mpd = 播放列表文件（不是媒体，只是清单）。
   */
  const SKIP_EXTS = ['.ts', '.m3u8', '.mpd', '.m3u'];

  /**
   * Strip .avif / .webp suffix to get original format URL.
   * B站 CDN serves modern formats by appending .avif/.webp to original URLs.
   * e.g. "hash.jpg.avif" → "hash.jpg" (server serves original JPEG)
   * e.g. "hash.png.webp" → "hash.png" (server serves original PNG)
   * Windows Photo Viewer can't open .avif/.webp, so we download original format.
   *
   * 剥离 .avif/.webp 后缀获取原始格式 URL。
   * B站 CDN 通过在原始 URL 后加 .avif/.webp 提供现代格式。
   * Windows 图片查看器无法打开 .avif/.webp，所以下载原始格式。
   */
  function stripBadFormat(url) {
    if (!url) return url;
    const lower = url.toLowerCase();
    if (lower.endsWith('.avif')) return url.slice(0, -5);
    if (lower.endsWith('.webp')) return url.slice(0, -5);
    return url;
  }

  /**
   * Extract a readable filename from a URL.
   * Strips CDN processing parameters (everything after @).
   * Strips .avif suffix to get original extension.
   *
   * 从 URL 中提取可读文件名。
   * 去除 CDN 处理参数（@ 之后的部分）。
   * 剥离 .avif 后缀获取原始扩展名。
   */
  function extractFilename(url) {
    try {
      let name = new URL(url).pathname.split('/').pop();
      if (!name) return '';
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
      // e.g. "hash.jpg.webp" → "hash.jpg" (server serves original JPEG)
      if (name.toLowerCase().endsWith('.webp')) {
        name = name.slice(0, -5);
      }
      return name;
    } catch {
      return '';
    }
  }

  /**
   * Check if a filename looks like a hash (unreadable).
   * CDN hash names are long alphanumeric strings with no readable words.
   *
   * 判断文件名是否为哈希串（不可读）。
   * CDN 哈希名是长字母数字串，无可读单词。
   */
  function isHashName(name) {
    if (!name) return true;
    // Remove all extensions / 去除所有扩展名
    const base = name.replace(/\.[a-z0-9]+$/i, '');
    // Any string > 12 chars, all hex = hash / 超过12字符的纯 hex 串 = 哈希
    if (base.length > 12 && /^[a-f0-9]{12,}$/i.test(base)) return true;
    // Any string > 20 chars, all alphanumeric, no spaces = likely hash
    // 超过20字符的纯字母数字串（无空格）= 可能是哈希
    if (base.length > 20 && !/\s/.test(base) && /^[a-z0-9]+$/i.test(base)) return true;
    // Any string > 30 chars = too long, probably hash/UUID
    // 超过30字符 = 太长，可能是哈希/UUID
    if (base.length > 30) return true;
    return false;
  }

  /**
   * Generate a readable label for a media item.
   * ALWAYS uses page title + type + number when filename is a hash.
   * This ensures labels are human-readable, not random strings.
   *
   * 为媒体项生成可读标签。
   * 当文件名是哈希串时，始终使用页面标题 + 类型 + 序号。
   * 确保标签人类可读，而非随机字符串。
   */
  function makeLabel(url, type, index, fallbackLabel) {
    const typeNames = {
      audio: '音频', video: '视频', document: '文档',
      archive: '压缩包', image: '图片', other: '文件'
    };
    const typeName = typeNames[type] || '文件';
    const pageNum = index + 1;
    const title = (document.title || '').trim().slice(0, 30) || '网页';

    // Check if fallback label is readable (not a hash itself)
    // 检查后备标签本身是否可读（不是哈希串）
    if (fallbackLabel) {
      const trimmed = fallbackLabel.trim();
      if (trimmed.length > 0 && trimmed.length <= 80 && !isHashName(trimmed)) {
        return trimmed;
      }
    }

    // Check if URL filename is readable
    // 检查 URL 文件名是否可读
    const filename = extractFilename(url);
    if (filename && !isHashName(filename)) {
      return filename;
    }

    // Hash filename → always use page title + type + number
    // 哈希文件名 → 始终使用页面标题 + 类型 + 序号
    return `${title} - ${typeName} ${pageNum}`;
  }

  /*
   * 1. Scan <audio> and <video> elements / 扫描 audio/video 元素
   * Check .src property, <source> children, and poster attribute.
   *
   * MSE handling / MSE 处理:
   *   - blob: URL on <video> → MSE stream → SKIP entirely (can't download)
   *   - blob: URL on <audio> → might be real audio blob → try download
   *   - HTTP URL → directly downloadable
   *
   * MSE 流媒体处理:
   *   - <video> 的 blob: URL = MSE 流 → 完全跳过（无法下载）
   *   - <audio> 的 blob: URL = 可能是真实音频 → 尝试下载
   *   - HTTP URL = 可直接下载
   */
  const elements = document.querySelectorAll('audio, video');
  elements.forEach((el, index) => {
    if (el.src && !seen.has(el.src)) {
      seen.add(el.src);
      const isBlobUrl = el.src.startsWith('blob:');
      const isVideo = el.tagName.toLowerCase() === 'video';
      const isMSE = isBlobUrl && isVideo;
      const isStream = el.src.includes('.m3u8') || el.src.includes('.mpd');

      // Skip MSE blob: URLs entirely — they can't be downloaded
      // and only confuse users with unusable "video" entries.
      // 完全跳过 MSE blob: URL — 无法下载，
      // 只会让用户看到不能下载的"视频"项而困惑。
      if (isMSE) return;

      mediaList.push({
        url: el.src,
        label: makeLabel(el.src, isVideo ? 'video' : 'audio', index,
          el.title || el.getAttribute('aria-label')),
        type: isVideo ? 'video' : 'audio',
        isBlob: isBlobUrl,
        isStream: isStream,
        isMSE: false,
        downloadable: !isStream
      });
    }

    // Check poster attribute on <video> / 检查 <video> 的 poster 属性
    // Poster images are cover/thumbnail images, should be 'image' type
    // poster 是封面/缩略图，应为 image 类型
    if (el.tagName.toLowerCase() === 'video') {
      const posterUrl = el.getAttribute('poster');
      if (posterUrl && !seen.has(posterUrl)) {
        seen.add(posterUrl);
        const pUrl = posterUrl.startsWith('http')
          ? posterUrl
          : new URL(posterUrl, location.href).href;
        if (!seen.has(pUrl)) {
          seen.add(pUrl);
          mediaList.push({
            url: pUrl,
            label: makeLabel(pUrl, 'image', index, '视频封面'),
            type: 'image', // poster is always an image / poster 始终是图片
            isBlob: false,
            isStream: false,
            isMSE: false,
            downloadable: true
          });
        }
      }
    }

    // Check <source> children / 检查 <source> 子元素
    el.querySelectorAll('source').forEach((source, sIndex) => {
      if (source.src && !seen.has(source.src)) {
        seen.add(source.src);
        const isBlobUrl = source.src.startsWith('blob:');
        const isVideo = el.tagName.toLowerCase() === 'video';
        const isMSE = isBlobUrl && isVideo;
        const isStream = source.src.includes('.m3u8') || source.src.includes('.mpd');

        // Skip MSE source URLs — can't download / 跳过 MSE source URL
        if (isMSE) return;

        mediaList.push({
          url: source.src,
          label: makeLabel(source.src, isVideo ? 'video' : 'audio', index,
            source.title),
          type: isVideo ? 'video' : 'audio',
          mimeType: source.type || '',
          isBlob: isBlobUrl,
          isStream: isStream,
          isMSE: false,
          downloadable: !isStream
        });
      }
    });
  });

  /*
   * 2. Scan <a> tags for downloadable file links / 扫描 <a> 标签文件链接
   * Finds links to audio, video, documents, archives, and image files.
   * Also catches <a download> links regardless of extension.
   * Strips .avif suffix to get original format URL for download.
   *
   * 查找指向音频、视频、文档、压缩包、图片文件的链接。
   * 同时也捕获带 download 属性的 <a> 标签（不限扩展名）。
   * 剥离 .avif 后缀获取原始格式 URL 以便下载。
   */
  const links = document.querySelectorAll('a[href]');
  links.forEach((a, index) => {
    const href = a.href;
    if (!href || seen.has(href)) return;

    // Skip internal/page anchors / 跳过页内锚点
    if (href.startsWith('#') || href.startsWith('javascript:')) return;

    // Check if it's a downloadable file by extension / 按扩展名判断是否为可下载文件
    let category = null;
    const lowerHref = href.toLowerCase();

    for (const ext in FILE_CATEGORIES) {
      if (lowerHref.includes(ext)) {
        category = FILE_CATEGORIES[ext];
        break;
      }
    }

    // Also include <a download> links regardless of extension / 包含带 download 属性的链接
    if (!category && a.hasAttribute('download')) {
      // Try to guess type from link text or URL / 尝试从链接文本或 URL 猜测类型
      const linkText = (a.textContent || '').toLowerCase();
      if (linkText.includes('mp3') || linkText.includes('audio') || linkText.includes('音乐') || linkText.includes('歌曲')) {
        category = 'audio';
      } else if (linkText.includes('mp4') || linkText.includes('video') || linkText.includes('视频')) {
        category = 'video';
      } else {
        category = 'other';
      }
    }

    if (category) {
      // Strip .avif/.webp to download original format (JPEG/PNG instead of AVIF/WebP)
      // 剥离 .avif/.webp 下载原始格式（JPEG/PNG 而非 AVIF/WebP）
      const cleanUrl = stripBadFormat(href);
      seen.add(href);
      if (cleanUrl !== href) seen.add(cleanUrl);
      const linkText = a.textContent.trim() || a.title ||
                       a.getAttribute('aria-label') || '';
      mediaList.push({
        url: cleanUrl,
        label: makeLabel(cleanUrl, category, index, linkText),
        type: category,
        isBlob: false,
        isStream: false,
        isMSE: false,
        downloadable: true
      });
    }
  });

  /*
   * 3. Scan Performance API resource entries / 扫描 Performance API 资源
   * Catches media files loaded dynamically via fetch/XHR.
   * Skips .ts segments (HLS fragments, useless individually).
   * Strips .avif suffix to download original format.
   *
   * 捕获通过 fetch/XHR 动态加载的媒体文件。
   * 跳过 .ts 分片（HLS 片段，单独下载无用）。
   * 剥离 .avif 后缀下载原始格式。
   */
  try {
    const entries = performance.getEntriesByType('resource');
    let resIndex = 0;
    entries.forEach(entry => {
      const url = entry.name;
      if (seen.has(url)) return;
      const lower = url.toLowerCase();

      // Skip HLS/DASH playlist and .ts segments / 跳过 HLS/DASH 清单和 .ts 分片
      if (SKIP_EXTS.some(ext => lower.includes(ext))) return;

      let cat = null;
      for (const ext in FILE_CATEGORIES) {
        if (lower.includes(ext)) { cat = FILE_CATEGORIES[ext]; break; }
      }

      if (cat) {
        // Strip .avif/.webp for download / 剥离 .avif/.webp 用于下载
        const cleanUrl = stripBadFormat(url);
        seen.add(url);
        if (cleanUrl !== url) seen.add(cleanUrl);
        const label = makeLabel(cleanUrl, cat, resIndex, null);
        mediaList.push({
          url: cleanUrl,
          label: label,
          type: cat,
          isBlob: false,
          isStream: false,
          isMSE: false,
          downloadable: true
        });
        resIndex++;
      }
    });
  } catch {}

  return mediaList;
}

/**
 * [v2.0.0] Function injected into the page to download a blob: URL.
 * Blob URLs are page-specific, so must be downloaded from within the page.
 *
 * v2.0.0 注入页面下载 blob: URL 的函数。
 * blob URL 是页面私有的，必须在页面内下载。
 *
 * @param {string} blobUrl - the blob: URL to download / 要下载的 blob URL
 * @param {string} filename - download filename / 下载文件名
 */
function downloadBlobInPage(blobUrl, filename) {
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename || 'downloaded_media';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Message listener / 消息监听器
 */
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // === Store target tab / 存储目标标签页 ===
  if (message.type === 'set-target-tab') {
    targetTab = {
      id: message.tab.id,
      title: message.tab.title || 'Untitled',
      url: message.tab.url || ''
    };
    sendResponse({ ok: true, targetTab });
    return false;
  }

  // === Return target tab info / 返回标签页信息 ===
  if (message.type === 'get-target-tab') {
    sendResponse({ ok: Boolean(targetTab), targetTab });
    return false;
  }

  // === Get tabCapture stream ID (Chrome / Edge) ===
  if (message.type === 'get-stream-id') {
    const tabId = Number(message.tabId || targetTab?.id);
    const consumerTabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab selected' });
      return false;
    }
    if (!consumerTabId) {
      sendResponse({ ok: false, error: 'Cannot identify recorder window' });
      return false;
    }

    browserAPI.tabCapture.getMediaStreamId(
      { targetTabId: tabId, consumerTabId },
      (streamId) => {
        if (browserAPI.runtime.lastError || !streamId) {
          sendResponse({
            ok: false,
            error: browserAPI.runtime.lastError?.message || 'Cannot capture tab'
          });
          return;
        }
        sendResponse({ ok: true, streamId });
      }
    );
    return true; // async / 异步
  }

  // === [v2.0.0] Detect media elements in target page ===
  // === v2.0.0 新增：检测目标页面中的所有可下载媒体 ===
  if (message.type === 'detect-media') {
    const tabId = Number(message.tabId || targetTab?.id);
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab selected' });
      return false;
    }

    // Inject detection function into the target tab / 注入检测函数到目标标签页
    browserAPI.scripting.executeScript({
      target: { tabId },
      func: detectMediaInPage
    }).then(results => {
      const mediaList = results[0]?.result || [];
      sendResponse({ ok: true, mediaList });
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true; // async / 异步
  }

  // === [v2.0.0] Download a media file ===
  // === v2.0.0 新增：下载媒体文件 ===
  if (message.type === 'download-media') {
    const { url, filename } = message;

    // For blob: URLs, inject download function into the page
    // blob: URL 需要在页面内下载
    if (url.startsWith('blob:')) {
      const tabId = Number(message.tabId || targetTab?.id);
      browserAPI.scripting.executeScript({
        target: { tabId },
        func: downloadBlobInPage,
        args: [url, filename]
      }).then(() => {
        sendResponse({ ok: true });
      }).catch(error => {
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }

    // For HTTP/HTTPS URLs: use downloads API directly.
    //
    // The filename parameter with correct extension (.mp3, .jpg, etc.)
    // is respected by Chrome's download dialog. No fetch needed —
    // fetching large files into memory as Blob caused black screen
    // issues on some systems due to memory spikes.
    //
    // HTTP/HTTPS URL 直接用 downloads API 下载。
    // filename 参数中包含正确的扩展名（.mp3, .jpg 等），
    // Chrome 下载对话框会尊重。不需要 fetch —
    // 将大文件 fetch 到内存为 Blob 会导致内存暴涨，
    // 部分系统上触发黑屏。
    browserAPI.downloads.download({
      url: url,
      filename: filename || 'downloaded_media',
      saveAs: true
    }).then(downloadId => {
      sendResponse({ ok: true, downloadId });
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});
