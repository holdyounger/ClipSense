/**
 * storage.js - 剪贴板历史持久化模块
 *
 * 职责：
 *   1. 将 ClipboardMonitor 的 history 数组持久化到磁盘（重启不丢失）
 *   2. 使用 Electron safeStorage（OS 钥匙串托管密钥）加密落盘
 *   3. 图片等大二进制内容分离存为独立加密文件，history.json 只存引用
 *
 * 存储结构（userData 目录下）：
 *   clipboard-history.json       —— 历史元数据（加密后的 JSON 字符串）
 *   clip-images/<id>.bin         —— 图片数据文件（加密后的字节）
 *
 * 设计要点：
 *   - 原子写：先写 .tmp 再 rename，避免写一半崩溃损坏
 *   - 图片分离：dataUrl(base64) 不塞进主 JSON，避免单文件膨胀
 *   - 加密：safeStorage.encryptString / decryptString（密钥由 OS 托管，不落地）
 *
 * 注意：safeStorage 在 WSL2 等无钥匙串后端的环境下不可用，本模块不做降级，
 *       遇到不可用会抛错由上层处理（目标环境为真实 Windows）。
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

class HistoryStorage {
  constructor(options = {}) {
    /** 主 JSON 文件名 */
    this.metaFile = options.metaFile || 'clipboard-history.json';
    /** 图片目录名 */
    this.imageDir = options.imageDir || 'clip-images';
    /** 是否启用加密（默认 true） */
    this.enableEncryption = options.enableEncryption !== false;
    /** 历史上限（供外部读取默认值，实际裁剪由 ClipboardMonitor 控制） */
    this.maxHistory = options.maxHistory || 500;
  }

  /**
   * 获取存储根目录（app.getPath('userData')），确保目录存在
   */
  _ensureDirs() {
    const base = app.getPath('userData');
    const imageDir = path.join(base, this.imageDir);
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
    }
    return { base, imageDir };
  }

  /**
   * 检查加密能力是否可用
   */
  isEncryptionAvailable() {
    if (!this.enableEncryption) return false;
    try {
      return safeStorage.isEncryptionAvailable();
    } catch (err) {
      return false;
    }
  }

  /**
   * 加密一个字符串 → Buffer（hex 字符串存储，便于 JSON 序列化）
   * @param {string} plain
   * @returns {string} hex 编码的密文
   */
  encryptString(plain) {
    const buf = safeStorage.encryptString(plain);
    return buf.toString('hex');
  }

  /**
   * 解密 hex 密文 → 原始字符串
   * @param {string} hex
   * @returns {string}
   */
  decryptString(hex) {
    const buf = Buffer.from(hex, 'hex');
    return safeStorage.decryptString(buf);
  }

  /**
   * 加密一个 Buffer（用于图片等二进制）→ Buffer
   * @param {Buffer} plain
   * @returns {Buffer}
   */
  encryptBuffer(plain) {
    return safeStorage.encryptString(plain.toString('base64'));
  }

  /**
   * 解密 Buffer → 原始 Buffer
   * @param {Buffer} cipher
   * @returns {Buffer}
   */
  decryptBuffer(cipher) {
    const b64 = safeStorage.decryptString(cipher);
    return Buffer.from(b64, 'base64');
  }

  /**
   * 原子写文件（tmp + rename）
   * @param {string} filePath
   * @param {Buffer|string} data
   */
  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  }

  /**
   * 将 history 数组持久化到磁盘
   *
   * 图片条目的 dataUrl 会被抽离 → 单独加密写入 clip-images/<id>.bin，
   * 元数据里用 { imageFile } 引用替换 dataUrl，避免主 JSON 膨胀。
   *
   * @param {Array} history ClipboardMonitor 的 history 数组
   */
  save(history) {
    const { imageDir } = this._ensureDirs();
    const encrypt = this.isEncryptionAvailable();

    // 收集需要保留的图片文件 id（用于清理孤儿文件）
    const liveImageIds = new Set();

    // 预处理：抽离图片 dataUrl，序列化其余字段
    const metaItems = history.map(item => {
      if (item.type === 'image' && item.dataUrl) {
        const imageFile = `${item.id}.bin`;
        liveImageIds.add(item.id);
        // 抽离 dataUrl，避免主 JSON 膨胀
        const { dataUrl, ...rest } = item;
        return { ...rest, imageFile };
      }
      return item;
    });

    // 1. 写图片数据文件
    for (const item of history) {
      if (item.type === 'image' && item.dataUrl) {
        const filePath = path.join(imageDir, `${item.id}.bin`);
        // dataUrl 形如 "data:image/png;base64,xxxx"，取 base64 部分
        const b64 = item.dataUrl.includes(',') ? item.dataUrl.split(',')[1] : item.dataUrl;
        const raw = Buffer.from(b64, 'base64');
        const payload = encrypt ? this.encryptBuffer(raw) : raw;
        this._atomicWrite(filePath, payload);
      }
    }

    // 2. 清理孤儿图片文件（历史里已删除但仍残留磁盘的）
    this._cleanOrphanImages(liveImageIds);

    // 3. 写主 JSON（内容统一为字符串：密文 hex 或明文 JSON）
    const json = JSON.stringify(metaItems, null, 2);
    const payload = encrypt ? this.encryptString(json) : json;
    const metaPath = path.join(app.getPath('userData'), this.metaFile);
    this._atomicWrite(metaPath, payload);
  }

  /**
   * 清理图片目录中不属于当前历史的孤儿文件
   * @param {Set<string>} liveIds 当前历史中图片条目的 id 集合
   */
  _cleanOrphanImages(liveIds) {
    const { imageDir } = this._ensureDirs();
    let files = [];
    try {
      files = fs.readdirSync(imageDir);
    } catch (e) {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.bin')) continue;
      const id = f.slice(0, -4); // 去掉 .bin
      if (!liveIds.has(id)) {
        try {
          fs.unlinkSync(path.join(imageDir, f));
        } catch (e) { /* 忽略删除失败 */ }
      }
    }
  }

  /**
   * 从磁盘加载历史
   * @returns {Array} 恢复后的 history 数组（图片条目重新挂回 dataUrl）
   */
  load() {
    const { imageDir } = this._ensureDirs();
    const metaPath = path.join(app.getPath('userData'), this.metaFile);

    // 无历史文件 → 空数组（首次启动）
    if (!fs.existsSync(metaPath)) {
      return [];
    }

    let raw;
    try {
      raw = fs.readFileSync(metaPath, 'utf8');
    } catch (err) {
      console.error(`[Storage] 读取历史文件失败: ${err.message}`);
      return [];
    }

    // 解密（若启用且内容为密文）
    let jsonStr = raw;
    if (this.isEncryptionAvailable()) {
      try {
        jsonStr = this.decryptString(raw);
      } catch (err) {
        // 可能是明文（加密被关闭后遗留）或解密失败
        console.warn(`[Storage] 解密失败，尝试按明文解析: ${err.message}`);
      }
    }

    let items;
    try {
      items = JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[Storage] 解析历史 JSON 失败: ${err.message}`);
      return [];
    }

    if (!Array.isArray(items)) return [];

    // 图片条目：从独立文件读回 dataUrl
    const encrypt = this.isEncryptionAvailable();
    return items.map(item => {
      if (item.type === 'image' && item.imageFile) {
        const filePath = path.join(imageDir, item.imageFile);
        if (fs.existsSync(filePath)) {
          try {
            const buf = fs.readFileSync(filePath);
            const rawBuf = encrypt ? this.decryptBuffer(buf) : buf;
            const mime = item.mimeType || 'image/png';
            const dataUrl = `data:${mime};base64,${rawBuf.toString('base64')}`;
            const { imageFile, ...rest } = item;
            return { ...rest, dataUrl };
          } catch (err) {
            console.error(`[Storage] 读取图片文件失败(${item.imageFile}): ${err.message}`);
            return item; // 图片损坏则保留元数据（无 dataUrl）
          }
        }
        return item; // 图片文件缺失
      }
      return item;
    });
  }

  /**
   * 配置文件路径（clip-history-config.json，与历史数据分离的轻量配置）
   */
  _getConfigPath() {
    return path.join(app.getPath('userData'), 'clip-history-config.json');
  }

  /**
   * 读取配置文件（read-modify-write 的读半）。
   * 文件缺失/损坏/非法 JSON → 返回 {}（调用方各自回落默认值）。
   * @returns {Object}
   */
  _readConfig() {
    const configPath = this._getConfigPath();
    if (!fs.existsSync(configPath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.error(`[Storage] 读取配置失败: ${err.message}`);
    }
    return {};
  }

  /**
   * 合并写入配置（read-modify-write 的写半，复用原子写）。
   * 修复历史隐患：旧 setMaxHistory 用 { maxHistory } 整文件覆写，
   * 同文件其他配置（如 tagSettings）会被清掉；统一走本方法后不再发生。
   * @param {Object} patch 要合并的增量字段
   */
  _writeConfig(patch) {
    const config = { ...this._readConfig(), ...patch };
    try {
      this._atomicWrite(this._getConfigPath(), JSON.stringify(config, null, 2));
    } catch (err) {
      console.error(`[Storage] 保存配置失败: ${err.message}`);
    }
  }

  /**
   * 更新最大历史上限（持久化到独立配置，供用户选择）
   * @param {number} max
   */
  setMaxHistory(max) {
    this.maxHistory = max;
    this._writeConfig({ maxHistory: max });
  }

  /**
   * 读取历史上限配置（无配置文件则返回默认值）
   * @returns {number}
   */
  getMaxHistory() {
    const config = this._readConfig();
    if (config && typeof config.maxHistory === 'number') {
      return config.maxHistory;
    }
    return this.maxHistory;
  }

  /**
   * 自动打标签默认设置（总开关 + 逐标签开关，2026-09-09；
   * v2 2026-09-10 扩到 12 类，方案 §3.2/§3.3，全部默认开）
   */
  static get DEFAULT_TAG_SETTINGS() {
    return {
      enabled: true,
      tags: {
        link: true, email: true, otp: true, snippet: true, sensitive: true,
        vuln: true, cmd: true, stack: true, config: true,
        ip: true, hash: true, path: true,
      },
    };
  }

  /**
   * 读取标签设置（与默认值合并，存量/手改配置缺 key 时回落默认）。
   * v2 存量兼容：老配置只存 5 键 → 展开后 7 个新键自动补 true（缺省即开）。
   * @returns {{enabled: boolean, tags: Object<string, boolean>}}
   */
  getTagSettings() {
    const def = HistoryStorage.DEFAULT_TAG_SETTINGS;
    const saved = this._readConfig().tagSettings;
    const src = (saved && typeof saved === 'object') ? saved : {};
    const savedTags = (src.tags && typeof src.tags === 'object') ? src.tags : {};
    return {
      enabled: src.enabled !== false,
      tags: {
        ...def.tags,
        ...savedTags,
      },
    };
  }

  /**
   * 保存标签设置（合并写入，不影响同文件其他配置）
   * @param {{enabled: boolean, tags: Object<string, boolean>}} settings
   */
  setTagSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    this._writeConfig({ tagSettings: settings });
  }

  /**
   * 标签 schema 版本（2026-09-10 v2 标签集扩展引入，方案 §5）。
   * 语义：缺省视为 1（v1 五类引擎产物）；v2 全量重迁移完成后写 2，
   * 二次启动读到 ≥2 直接跳过迁移（幂等，验收 5）。
   * @returns {number}
   */
  getTagSchemaVersion() {
    const v = this._readConfig().tagSchemaVersion;
    return (typeof v === 'number' && v >= 1) ? v : 1;
  }

  /**
   * 写入标签 schema 版本（合并写入，不影响同文件其他配置）
   * @param {number} v
   */
  setTagSchemaVersion(v) {
    if (typeof v !== 'number' || v < 1) return;
    this._writeConfig({ tagSchemaVersion: v });
  }
}

module.exports = HistoryStorage;
