/**
 * storage.ts - 剪贴板历史持久化模块
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
 *
 * TS 迁移（2026-09-30，第四批）：主进程 class 模块，export 直出（require 加载，
 * 与 trigger-anim.ts / window-opacity.ts 同款）。
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** 剪贴板历史条目（四类型联合的公共字段 + 各自可选字段） */
interface StorageItem {
  id: string;
  type?: 'text' | 'image' | 'file' | 'rich-text';
  timestamp: number;
  length?: number;
  count?: number;
  text?: string;
  html?: string;
  plainText?: string;
  dataUrl?: string;
  imageFile?: string;
  mimeType?: string;
  path?: string;
  name?: string;
  files?: Array<{ path?: string }>;
  links?: string[];
  width?: number;
  height?: number;
  tags?: string[];
  /** 展开状态持久化到 item 对象：列表重渲染传入同一引用，状态不丢 */
  _expanded?: boolean;
}

/** 构造参数（storage.js 原版 options 形态） */
interface StorageOptions {
  metaFile?: string;
  imageDir?: string;
  enableEncryption?: boolean;
  maxHistory?: number;
}

/** 存储目录对（_ensureDirs 返回） */
interface StorageDirs {
  base: string;
  imageDir: string;
}

/** 标签设置（总开关 + 逐标签开关，2026-09-09） */
interface TagSettings {
  enabled: boolean;
  tags: Record<string, boolean>;
}

/** 自动打标签默认设置（v2 2026-09-10 扩到 12 类，全部默认开） */
const DEFAULT_TAG_SETTINGS: TagSettings = {
  enabled: true,
  tags: {
    link: true, email: true, otp: true, snippet: true, sensitive: true,
    vuln: true, cmd: true, stack: true, config: true,
    ip: true, hash: true, path: true,
  },
};

/**
 * 剪贴板历史持久化
 */
class HistoryStorage {
  /** 主 JSON 文件名 */
  metaFile: string;
  /** 图片目录名 */
  imageDir: string;
  /** 是否启用加密（默认 true） */
  enableEncryption: boolean;
  /** 历史上限（供外部读取默认值，实际裁剪由 ClipboardMonitor 控制） */
  maxHistory: number;

  constructor(options: StorageOptions = {}) {
    this.metaFile = options.metaFile || 'clipboard-history.json';
    this.imageDir = options.imageDir || 'clip-images';
    this.enableEncryption = options.enableEncryption !== false;
    this.maxHistory = options.maxHistory || 500;
  }

  /**
   * 获取存储根目录（app.getPath('userData')），确保目录存在
   */
  private _ensureDirs(): StorageDirs {
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
  isEncryptionAvailable(): boolean {
    if (!this.enableEncryption) return false;
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * 加密一个字符串 → hex 字符串存储（便于 JSON 序列化）
   */
  encryptString(plain: string): string {
    const buf = safeStorage.encryptString(plain);
    return buf.toString('hex');
  }

  /**
   * 解密 hex 密文 → 原始字符串
   */
  decryptString(hex: string): string {
    const buf = Buffer.from(hex, 'hex');
    return safeStorage.decryptString(buf);
  }

  /**
   * 加密一个 Buffer（用于图片等二进制）→ Buffer
   */
  encryptBuffer(plain: Buffer): Buffer {
    return safeStorage.encryptString(plain.toString('base64'));
  }

  /**
   * 解密 Buffer → 原始 Buffer
   */
  decryptBuffer(cipher: Buffer): Buffer {
    const b64 = safeStorage.decryptString(cipher);
    return Buffer.from(b64, 'base64');
  }

  /**
   * 原子写文件（tmp + rename）
   */
  private _atomicWrite(filePath: string, data: Buffer | string): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  }

  /**
   * 将 history 数组持久化到磁盘
   *
   * 图片条目的 dataUrl 会被抽离 → 单独加密写入 clip-images/<id>.bin，
   * 元数据里用 { imageFile } 引用替换 dataUrl，避免主 JSON 膨胀。
   */
  save(history: StorageItem[]): void {
    const { imageDir } = this._ensureDirs();
    const encrypt = this.isEncryptionAvailable();

    // 收集需要保留的图片文件 id（用于清理孤儿文件）
    const liveImageIds = new Set<string>();

    // 预处理：抽离图片 dataUrl，序列化其余字段
    const metaItems = history.map((item: StorageItem) => {
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
   */
  private _cleanOrphanImages(liveIds: Set<string>): void {
    const { imageDir } = this._ensureDirs();
    let files: string[];
    try {
      files = fs.readdirSync(imageDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.bin')) continue;
      const id = f.slice(0, -4); // 去掉 .bin
      if (!liveIds.has(id)) {
        try {
          fs.unlinkSync(path.join(imageDir, f));
        } catch { /* 忽略删除失败 */ }
      }
    }
  }

  /**
   * 从磁盘加载历史
   * @returns 恢复后的 history 数组（图片条目重新挂回 dataUrl）
   */
  load(): StorageItem[] {
    const { imageDir } = this._ensureDirs();
    const metaPath = path.join(app.getPath('userData'), this.metaFile);

    // 无历史文件 → 空数组（首次启动）
    if (!fs.existsSync(metaPath)) {
      return [];
    }

    let raw: string;
    try {
      raw = fs.readFileSync(metaPath, 'utf8');
    } catch (err) {
      console.error(`[Storage] 读取历史文件失败: ${(err as Error).message}`);
      return [];
    }

    // 解密（若启用且内容为密文）
    let jsonStr = raw;
    if (this.isEncryptionAvailable()) {
      try {
        jsonStr = this.decryptString(raw);
      } catch (err) {
        // 可能是明文（加密被关闭后遗留）或解密失败
        console.warn(`[Storage] 解密失败，尝试按明文解析: ${(err as Error).message}`);
      }
    }

    let items: StorageItem[];
    try {
      items = JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[Storage] 解析历史 JSON 失败: ${(err as Error).message}`);
      return [];
    }

    if (!Array.isArray(items)) return [];

    // 图片条目：从独立文件读回 dataUrl
    const encrypt = this.isEncryptionAvailable();
    return items.map((item: StorageItem & { imageFile?: string }) => {
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
            console.error(`[Storage] 读取图片文件失败(${item.imageFile}): ${(err as Error).message}`);
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
  private _getConfigPath(): string {
    return path.join(app.getPath('userData'), 'clip-history-config.json');
  }

  /**
   * 读取配置文件（read-modify-write 的读半）。
   * 文件缺失/损坏/非法 JSON → 返回 {}（调用方各自回落默认值）。
   */
  private _readConfig(): Record<string, unknown> {
    const configPath = this._getConfigPath();
    if (!fs.existsSync(configPath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      console.error(`[Storage] 读取配置失败: ${(err as Error).message}`);
    }
    return {};
  }

  /**
   * 合并写入配置（read-modify-write 的写半，复用原子写）。
   * 修复历史隐患：旧 setMaxHistory 用 { maxHistory } 整文件覆写，
   * 同文件其他配置（如 tagSettings）会被清掉；统一走本方法后不再发生。
   */
  private _writeConfig(patch: Record<string, unknown>): void {
    const config = { ...this._readConfig(), ...patch };
    try {
      this._atomicWrite(this._getConfigPath(), JSON.stringify(config, null, 2));
    } catch (err) {
      console.error(`[Storage] 保存配置失败: ${(err as Error).message}`);
    }
  }

  /**
   * 更新最大历史上限（持久化到独立配置，供用户选择）
   */
  setMaxHistory(max: number): void {
    this.maxHistory = max;
    this._writeConfig({ maxHistory: max });
  }

  /**
   * 读取历史上限配置（无配置文件则返回默认值）
   */
  getMaxHistory(): number {
    const config = this._readConfig();
    if (config && typeof config.maxHistory === 'number') {
      return config.maxHistory;
    }
    return this.maxHistory;
  }

  /**
   * 读取标签设置（与默认值合并，存量/手改配置缺 key 时回落默认）。
   * v2 存量兼容：老配置只存 5 键 → 展开后 7 个新键自动补 true（缺省即开）。
   */
  getTagSettings(): TagSettings {
    const def = DEFAULT_TAG_SETTINGS;
    const saved = this._readConfig().tagSettings;
    const src = (saved && typeof saved === 'object') ? saved as Record<string, unknown> : {};
    const savedTags = (src.tags && typeof src.tags === 'object') ? src.tags as Record<string, boolean> : {};
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
   */
  setTagSettings(settings: TagSettings): void {
    if (!settings || typeof settings !== 'object') return;
    this._writeConfig({ tagSettings: settings });
  }

  /**
   * 标签 schema 版本（2026-09-10 v2 标签集扩展引入，方案 §5）。
   * 语义：缺省视为 1（v1 五类引擎产物）；v2 全量重迁移完成后写 2，
   * 二次启动读到 ≥2 直接跳过迁移（幂等，验收 5）。
   */
  getTagSchemaVersion(): number {
    const v = this._readConfig().tagSchemaVersion;
    return (typeof v === 'number' && v >= 1) ? v : 1;
  }

  /**
   * 写入标签 schema 版本（合并写入，不影响同文件其他配置）
   */
  setTagSchemaVersion(v: number): void {
    if (typeof v !== 'number' || v < 1) return;
    this._writeConfig({ tagSchemaVersion: v });
  }

  /**
   * 读取「已展示过欢迎页」的版本（2026-09-30 升级欢迎页）
   * 语义：缺省视为空串（首次安装从未展示过）
   */
  getLastShownVersion(): string {
    const v = this._readConfig().lastShownVersion;
    return typeof v === 'string' ? v : '';
  }

  /**
   * 写入「已展示过欢迎页」的版本（合并写入，不影响同文件其他配置）
   */
  setLastShownVersion(v: string): void {
    if (typeof v !== 'string' || !v) return;
    this._writeConfig({ lastShownVersion: v });
  }
}

// CJS 单导出：require('./storage') 直接得到类本身（与 .js 原版 module.exports 形状一致）
export = HistoryStorage;
