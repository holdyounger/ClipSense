/**
 * clipboard-monitor.js - 剪贴板轮询监听模块（spike 核心验证点）
 *
 * 验证结论：Electron clipboard 模块无跨平台 change 事件，
 * 需通过「轮询 + hash 比对」检测剪贴板变化。
 *
 * 本模块：
 * - 定时读取剪贴板文本
 * - 与上次内容做 hash 比对，变化则归档一条历史
 * - 图片暂记 size 标记（本 spike 只验证文本链路）
 */

const { clipboard, nativeImage } = require('electron');
const crypto = require('crypto');

class ClipboardMonitor {
  constructor(options = {}) {
    /** 轮询间隔 ms */
    this.intervalMs = options.intervalMs || 600;
    /** 最大历史条数 */
    this.maxHistory = options.maxHistory || 100;
    /** 历史记录数组（新→旧） */
    this.history = [];
    /** 上次剪贴板内容 hash（用于去重比对） */
    this._lastHash = null;
    /** 内容去重 Set（hash），防止同一内容重复归档 */
    this._seenHashes = new Set();
    /** 定时器 ID */
    this.intervalId = null;
    /** 持久化存储实例（可选，注入后启用持久化） */
    this.storage = options.storage || null;
    /** 变化后的持久化回调（由外部注入 storage 后自动设置） */
    this._onPersist = null;
  }

  /**
   * 读取当前剪贴板内容，自动探测格式并分类返回
   *
   * 返回值：
   *   { kind: 'empty' }                                     —— 剪贴板为空
   *   { kind: 'image', dataUrl, size, width, height }       —— 图片
   *   { kind: 'file', files[], uriList }                    —— 文件（text/uri-list）
   *   { kind: 'text', text }                                —— 纯文本
   *   { kind: 'rich-text', html, plainText }                —— 富文本（仅无纯文本时）
   *
   * 探测优先级：图片 > 文件 > 纯文本 > 富文本
   */
  _readClipboard() {
    try {
      const formats = clipboard.availableFormats();

      console.log(`[Monitor] availableFormats: ${formats.join(', ')}`);

      // availableFormats 可能返回空数组，用 readText 兜底
      const has = (needle) => formats.some(f => f.toLowerCase().includes(needle));

      // 1. 图片（image/png、image/jpeg 等）
      if (has('image')) {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) {
          const size = img.getSize();
          return {
            kind: 'image',
            dataUrl: img.toDataURL(),
            size: img.toPNG ? img.toPNG().length : 0,
            width: size.width,
            height: size.height,
          };
        }
      }

      // 2. 文件（text/uri-list / FileNameW / CF_HDROP）
      if (has('uri-list') || has('filename') || has('hdrop')) {
        const files = this._readFileUris();
        if (files.length > 0) {
          return {
            kind: 'file',
            files,
            uriList: files.map(f => f.uri).join('\n'),
          };
        }
      }

      // 3. 纯文本（优先级高于富文本：绝大多数复制都带 text/plain，最干净）
      const text = clipboard.readText();
      if (text) {
        // 特殊情况：文本内容是 file:// 路径（首次启动时格式已冲刷，只剩纯文本）
        // 此时把它识别为「文件」而非普通文本
        const fileEntries = this._parseFileUriText(text);
        if (fileEntries.length > 0) {
          return {
            kind: 'file',
            files: fileEntries,
            uriList: fileEntries.map(f => f.uri).join('\n'),
          };
        }
        return { kind: 'text', text };
      }

      // 4. 富文本（仅当没有纯文本、但有 html 时才用）
      if (has('html')) {
        const html = clipboard.readHTML();
        if (html && html.trim()) {
          return { kind: 'rich-text', html, plainText: '' };
        }
      }

      return { kind: 'empty' };
    } catch (err) {
      // 读取失败时降级为纯文本兜底
      try {
        const text = clipboard.readText();
        return text ? { kind: 'text', text } : { kind: 'empty' };
      } catch (e) {
        return { kind: 'empty' };
      }
    }
  }

  /**
   * 从剪贴板读取文件列表，解析成 { uri, path, name }[]
   *
   * 跨平台处理：
   * - macOS / Linux：text/uri-list，readText() 返回 file:///... 换行分隔
   * - Windows：FileNameW（UTF-16 路径，\0 分隔）或 CF_HDROP
   */
  _readFileUris() {
    // 方式 1：Windows FileNameW（UTF-16LE 编码，\0 分隔多文件）
    // 必须用 readBuffer 读原始字节 + utf16le 解码，不能直接 read()
    // （read() 返回的字符串里残留 UTF-16 的空字节，会被误当成分隔符）
    try {
      const fnwBuf = clipboard.readBuffer('FileNameW');
      if (fnwBuf && fnwBuf.length > 0) {
        const paths = fnwBuf.toString('utf16le')
          .split('\0')
          .map(s => s.trim())
          .filter(Boolean);
        if (paths.length > 0) {
          return paths.map(p => this._fileEntryFromPath(p));
        }
      }
    } catch (e) { /* 忽略，尝试下一方式 */ }

    // 方式 2：text/uri-list（macOS/Linux）
    const raw = clipboard.readText();
    if (raw) {
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const files = [];
      for (const line of lines) {
        if (!line.startsWith('file://')) continue;
        let pathPart = line.slice('file://'.length);
        let filePath;
        try {
          filePath = decodeURIComponent(pathPart);
        } catch (e) {
          filePath = pathPart;
        }
        // Windows 路径规范化：/C:/xxx -> C:/xxx
        if (/^\/[A-Za-z]:\//.test(filePath)) {
          filePath = filePath.slice(1);
        }
        const name = filePath.split(/[\\/]/).pop() || filePath;
        files.push({ uri: line, path: filePath, name });
      }
      if (files.length > 0) return files;
    }

    return [];
  }

  /**
   * 从纯路径（Windows FileNameW 解析出的）构造文件条目
   */
  _fileEntryFromPath(p) {
    // 统一反斜杠为正斜杠用于展示，但保留原路径供回写
    const name = p.split(/[\\/]/).pop() || p;
    const uri = 'file:///' + p.replace(/\\/g, '/');
    return { uri, path: p, name };
  }

  /**
   * 判断一段纯文本是否「整体是 file:// 路径」（首次启动残留的文件 URI 文本）
   * 是则解析成文件条目数组，否则返回空数组。
   *
   * 触发场景：首次启动时剪贴板里残留的是 file:///C:/... 纯文本，
   * 但格式已被冲刷，只剩 text/plain（读不到 FileNameW / uri-list）。
   */
  _parseFileUriText(text) {
    const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    // 所有非空行都必须是 file:// 开头，才认定为文件（避免误判普通文本）
    const allAreFileUri = lines.every(line => line.startsWith('file://'));
    if (!allAreFileUri) return [];

    const files = [];
    for (const line of lines) {
      let pathPart = line.slice('file://'.length);
      let filePath;
      try {
        filePath = decodeURIComponent(pathPart);
      } catch (e) {
        filePath = pathPart;
      }
      // Windows 路径规范化：/C:/xxx -> C:/xxx；以及 file://C:/xxx 的变体
      if (/^\/[A-Za-z]:\//.test(filePath)) {
        filePath = filePath.slice(1);
      } else if (/^\/[A-Za-z]\//.test(filePath)) {
        filePath = filePath.slice(1);
      }
      const name = filePath.split(/[\\/]/).pop() || filePath;
      files.push({ uri: line, path: filePath, name });
    }
    return files;
  }

  /**
   * 计算 hash（支持字符串或 Buffer）
   */  _hash(data) {
    const input = Buffer.isBuffer(data) ? data : String(data);
    return crypto.createHash('md5').update(input).digest('hex');
  }

  /**
   * 单次检测：读剪贴板，变化则归档
   * @returns {{changed: boolean, item: Object|null}}
   */
  tick() {
    const result = this._readClipboard();
    if (result.kind === 'empty') return { changed: false, item: null };

    // 生成用于去重的 hash（各类型用各自的内容源）
    const hashSource = result.kind === 'image'
      ? result.dataUrl
      : result.kind === 'file'
        ? result.uriList
        : result.kind === 'rich-text'
          ? (result.html || result.plainText)
          : result.text;
    const hash = this._hash(hashSource);

    if (hash === this._lastHash) {
      return { changed: false, item: null };
    }
    this._lastHash = hash;

    // 去重：整个会话内已出现过的内容不再重复归档
    if (this._seenHashes.has(hash)) {
      return { changed: false, item: null };
    }
    this._seenHashes.add(hash);

    // 按类型构造 item
    const item = this._buildItem(result);
    if (!item) return { changed: false, item: null };

    this.history.unshift(item);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }

    this._persist();

    return { changed: true, item };
  }

  /**
   * 根据读取结果构造历史条目
   * @param {Object} result _readClipboard 的返回值
   * @returns {Object|null}
   */
  _buildItem(result) {
    const base = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    switch (result.kind) {
      case 'text': {
        const text = result.text;
        return {
          ...base,
          type: 'text',
          text,
          preview: text.length > 80 ? text.slice(0, 80) + '…' : text,
          length: text.length,
        };
      }
      case 'image': {
        return {
          ...base,
          type: 'image',
          dataUrl: result.dataUrl,
          mimeType: this._mimeFromDataUrl(result.dataUrl),
          size: result.size,
          width: result.width,
          height: result.height,
          preview: `[图片 ${result.width}×${result.height}]`,
        };
      }
      case 'file': {
        const names = result.files.map(f => f.name);
        return {
          ...base,
          type: 'file',
          files: result.files,
          uriList: result.uriList,
          name: names.join(', '),
          path: result.files[0] ? result.files[0].path : '',
          preview: names.length === 1
            ? `📄 ${names[0]}`
            : `📄 ${names[0]} 等 ${names.length} 个文件`,
        };
      }
      case 'rich-text': {
        const plainText = result.plainText || '';
        return {
          ...base,
          type: 'rich-text',
          html: result.html,
          plainText,
          text: plainText,
          length: plainText.length,
          preview: plainText.length > 80 ? plainText.slice(0, 80) + '…' : plainText,
        };
      }
      default:
        return null;
    }
  }

  /**
   * 将某个历史条目写回系统剪贴板（按类型分类处理）
   * @param {Object} item
   * @returns {boolean} 是否成功
   */
  copyToClipboard(item) {
    try {
      switch (item.type) {
        case 'image': {
          if (item.dataUrl) {
            const img = nativeImage.createFromDataURL(item.dataUrl);
            if (!img.isEmpty()) {
              clipboard.writeImage(img);
              return true;
            }
          }
          return false;
        }
        case 'rich-text': {
          // 富文本：写 HTML（Electron 会把 text 也一起写入）
          if (item.html) {
            clipboard.writeHTML(item.html);
            return true;
          }
          // 降级为纯文本
          clipboard.writeText(item.plainText || item.text || '');
          return true;
        }
        case 'file': {
          // Explorer 需要 CF_HDROP / FileNameW，单纯写入 URI 文本只会粘贴成路径字符串。
          const paths = (item.files || [])
            .map(file => file.path)
            .filter(path => typeof path === 'string' && path.length > 0);
          if (paths.length === 0 && item.path) paths.push(item.path);
          if (paths.length === 0) return false;

          // FileNameW 是 Windows 文件拖放/复制使用的 UTF-16LE 路径列表格式。
          const fileNameW = Buffer.from(`${paths.join('\0')}\0\0`, 'utf16le');
          clipboard.writeBuffer('FileNameW', fileNameW);
          return true;
        }
        case 'text':
        default: {
          clipboard.writeText(item.text || '');
          return true;
        }
      }
    } catch (err) {
      console.error(`[Monitor] 回写剪贴板失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 根据 dataUrl 提取 mime 类型
   * @param {string} dataUrl
   * @returns {string}
   */
  _mimeFromDataUrl(dataUrl) {
    if (!dataUrl) return 'image/png';
    const m = /^data:([^;,]+)/.exec(dataUrl);
    return m ? m[1] : 'image/png';
  }

  /**
   * 启动轮询
   */
  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      const result = this.tick();
      if (result.changed && this.onChange) {
        this.onChange(result.item, this.history);
      }
    }, this.intervalMs);
  }

  /**
   * 停止轮询
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 变化回调（由主进程注入）
   * @param {Function} cb - (item, history) => void
   */
  setOnChange(cb) {
    this.onChange = cb;
  }

  /**
   * 获取当前全部历史
   */
  getHistory() {
    return this.history;
  }

  /**
   * 删除单条
   */
  remove(id) {
    this.history = this.history.filter(h => h.id !== id);
    this._persist();
  }

  /**
   * 清空
   */
  clear() {
    this.history = [];
    this._seenHashes.clear();
    this._persist();
  }

  /**
   * 触发持久化（若已注入 storage）
   */
  _persist() {
    if (this.storage && typeof this.storage.save === 'function') {
      try {
        this.storage.save(this.history);
      } catch (err) {
        console.error(`[Monitor] 持久化失败: ${err.message}`);
      }
    }
  }

  /**
   * 从 storage 加载历史（启动时调用），恢复 history + 去重集合
   * @returns {number} 恢复的条目数
   */
  loadFromStorage() {
    if (!this.storage || typeof this.storage.load !== 'function') return 0;
    try {
      const items = this.storage.load();
      this.history = Array.isArray(items) ? items : [];
      // 重建去重集合：恢复的条目不应在下次复制时被重复归档
      this._seenHashes = new Set();
      for (const item of this.history) {
        const hashSource = item.type === 'image'
          ? item.dataUrl
          : item.type === 'file'
            ? item.uriList
            : item.type === 'rich-text'
              ? (item.html || item.plainText)
              : item.text;
        if (hashSource !== undefined && hashSource !== null && hashSource !== '') {
          this._seenHashes.add(this._hash(hashSource));
        }
      }
      // 首次轮询比对基准：保持 null，让启动时的立即 tick() 能把系统剪贴板
      // 里「未同步过的新内容」归档进来（已同步的由 _seenHashes 去重，保持原位）
      this._lastHash = null;
      console.log(`[Monitor] 从存储恢复了 ${this.history.length} 条历史`);
      return this.history.length;
    } catch (err) {
      console.error(`[Monitor] 加载历史失败: ${err.message}`);
      return 0;
    }
  }

  /**
   * 立即执行一次剪贴板同步（启动时调用）
   *
   * 目的：每次启动都检查系统剪贴板，把「历史里没有的新数据」同步进来。
   * 依赖 tick() 的去重逻辑：
   *   - _lastHash 为 null（尚未读过），读到剪贴板内容会走到 _seenHashes 判断
   *   - 内容已同步过 → _seenHashes 命中，跳过（保持原位）
   *   - 内容是新的 → 归档到顶部
   *
   * @returns {{changed: boolean, item: Object|null}}
   */
  syncNow() {
    const result = this.tick();
    if (result.changed && this.onChange) {
      this.onChange(result.item, this.history);
    }
    return result;
  }

  /**
   * 设置历史上限（可配置），超限时自动裁剪
   * @param {number} max
   */
  setMaxHistory(max) {
    this.maxHistory = max;
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
      this._persist();
    }
  }
}

module.exports = ClipboardMonitor;
