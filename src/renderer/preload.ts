/**
 * preload.ts - 暴露剪贴板历史 API
 *
 * Electron preload 脚本：经 contextBridge 将 clipboardAPI 暴露给渲染层。
 * 所有 invoke/send/on 频道名与主进程 setupIPC 注册的 handler 一一对应。
 *
 * 说明：链接识别（extractLinks）只在主进程入库时执行并存为 item.links，
 * 渲染层直接读取该字段即可，无需引入 link-utils。
 * （Electron sandbox 模式下 preload 的 require 不支持跨目录相对路径）
 *
 * TS 迁移（2026-10-09，第四批 #5）：类型化 IPC 桥契约——
 *   - IpcRenderer/ContextBridge 最小接口（preload 沙箱可用子集）
 *   - invoke 返回 Promise<T>（各频道返回类型按主进程 handler 建模）
 *   - on 系列回调参数类型化（history-updated/countdown-update 等）
 *   - clipboardAPI 对象先组装再整体 expose（与 .js 内联字面量行为等价）
 *   - onHeaderHover 保留原版 !!expanded 布尔强制（不走 subscribe 直透）
 */
'use strict';

/** electron ipcRenderer 子集（preload 沙箱可用） */
interface PreloadIpcRenderer {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void;
}

/** electron contextBridge 子集（preload 沙箱可用） */
interface PreloadContextBridge {
  exposeInMainWorld: (apiKey: string, api: unknown) => void;
}

const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: PreloadContextBridge;
  ipcRenderer: PreloadIpcRenderer;
};

// ==================== 类型定义 ====================

/** 历史条目（渲染层消费的最小字段集；完整字段见 storage.ts StorageItem）。
 * 命名避开 entry-anim.ts 的全局 HistoryItem：脚本风格 interface 处于全局作用域，
 * 两处同名且都带索引签名会声明合并 → TS2374 重复索引签名。 */
interface PreloadHistoryItem {
  id: string;
  type?: string;
  timestamp: number;
  tags?: string[];
  links?: string[];
  count?: number;
  [key: string]: unknown;
}

/** 倒计时状态（get-countdown / countdown-update 频道） */
interface CountdownState {
  isCountingDown: boolean;
  remainingMs: number | null;
}

/** 下载进度（update-download-progress 频道） */
interface DownloadProgressEvent {
  receivedBytes: number;
  totalBytes: number;
  percent: number;
}

/** 标签设置（get-tag-settings / tag-settings-updated 频道） */
interface TagSettingsEvent {
  enabled: boolean;
  tags: Record<string, boolean>;
}

/** 通用 IPC 结果（主进程 handler 返回的 { ok, error } 形态） */
interface IpcResult {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** 回调提取器：包装 ipcRenderer.on 的泛型辅助（消免每处 listener 签名重复） */
function subscribe<T>(
  channel: string,
  callback: (payload: T) => void
): void {
  // Electron listener 签名为 (event, ...payloads)：rest[0]=event 对象、rest[1]=首个负载。
  // 与 .js 原版 `(event, x) => callback(x)` 取参位置一致——绝不能取 rest[0]！
  ipcRenderer.on(channel, (...rest: unknown[]) => callback(rest[1] as T));
}

// ==================== clipboardAPI 组装 ====================

/** 剪贴板 API 完整契约（先组装为常量再整体 expose——与 .js 内联字面量行为等价） */
const clipboardAPI = {
  // ========== 历史 ==========
  getHistory: (): Promise<PreloadHistoryItem[]> =>
    ipcRenderer.invoke('get-history') as Promise<PreloadHistoryItem[]>,
  copyItem: (id: string): Promise<IpcResult> =>
    ipcRenderer.invoke('copy-item', id) as Promise<IpcResult>,
  copyItemPath: (id: string): Promise<IpcResult> =>
    ipcRenderer.invoke('copy-item-path', id) as Promise<IpcResult>,
  openPath: (path: string): Promise<IpcResult> =>
    ipcRenderer.invoke('open-path', path) as Promise<IpcResult>,
  simulateInput: (id: string): Promise<IpcResult> =>
    ipcRenderer.invoke('simulate-input', id) as Promise<IpcResult>,
  getFileIcon: (path: string): Promise<string | null> =>
    ipcRenderer.invoke('get-file-icon', path) as Promise<string | null>,
  openFileLocation: (path: string): Promise<IpcResult | null> =>
    ipcRenderer.invoke('open-file-location', path) as Promise<IpcResult | null>,
  openExternal: (url: string): Promise<IpcResult | null> =>
    ipcRenderer.invoke('open-external', url) as Promise<IpcResult | null>,
  removeItem: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('remove-item', id),
  clearHistory: (): Promise<unknown> =>
    ipcRenderer.invoke('clear-history'),
  onHistoryUpdated: (callback: (history: PreloadHistoryItem[]) => void): void =>
    subscribe<PreloadHistoryItem[]>('history-updated', callback),

  // ========== Header 可变高度（方案 A，2026-09-28） ==========
  // 主进程 100ms 轮询判定光标在/离 header 区（进入即时/离开防抖 180ms/
  // 弹出后 400ms 抑制），状态翻转推送 bool；渲染层据此切 .header--hover。
  onHeaderHover: (callback: (expanded: boolean) => void): void =>
    // 原版 !!expanded 布尔强制保留；rest[0]=event、rest[1]=负载
    ipcRenderer.on('header:hover', (...rest: unknown[]) => callback(Boolean(rest[1]))),

  // ========== 窗口定位 / 鼠标事件 ==========
  mouseEnter: (): void => ipcRenderer.send('mouse-enter'),
  mouseLeave: (): void => ipcRenderer.send('mouse-leave'),
  setSearchActive: (active: boolean): void => ipcRenderer.send('set-search-active', active),
  getWindowBounds: (): Promise<unknown> =>
    ipcRenderer.invoke('get-window-bounds'),
  updateDraggedPosition: (x: number, y: number): Promise<boolean> =>
    ipcRenderer.invoke('update-dragged-position', x, y) as Promise<boolean>,
  dragStart: (): Promise<boolean> => ipcRenderer.invoke('drag-start') as Promise<boolean>,
  dragEnd: (): Promise<boolean> => ipcRenderer.invoke('drag-end') as Promise<boolean>,

  // ========== 倒计时 ==========
  getCountdown: (): Promise<CountdownState> =>
    ipcRenderer.invoke('get-countdown') as Promise<CountdownState>,
  onCountdownUpdate: (callback: (data: CountdownState) => void): void =>
    subscribe<CountdownState>('countdown-update', callback),

  // ========== 轻量升级链路（2026-09-20，自研） ==========
  updateCheck: (): Promise<unknown> => ipcRenderer.invoke('update-check'),
  updateDownload: (url: string): Promise<unknown> => ipcRenderer.invoke('update-download', url),
  updateInstall: (filePath: string): Promise<unknown> => ipcRenderer.invoke('update-install', filePath),
  // 两段式窗口透明度（2026-09-30）：主进程推送目标值，渲染层写 --win-alpha 变量
  onWindowOpacity: (callback: (alpha: number) => void): void =>
    subscribe<number>('window:opacity', callback),
  // 窗口可见性权威信号（2026-09-30）：backgroundThrottling:false 下 visibilityState 失灵
  onWindowVisibility: (callback: (visible: boolean) => void): void =>
    subscribe<boolean>('window:visibility', callback),
  // 语言切换（2026-09-30 二级菜单取消后迁托盘）：托盘 _switchLang 推送新语言
  onLangChanged: (callback: (lang: string) => void): void =>
    subscribe<string>('lang-changed', callback),
  getLang: (): Promise<string> => ipcRenderer.invoke('get-lang') as Promise<string>,
  setLang: (lang: string): Promise<string> => ipcRenderer.invoke('set-lang', lang) as Promise<string>,
  // 升级欢迎页（2026-09-30）：版本变化检测 + 已展示回写
  getWelcomeState: (): Promise<unknown> => ipcRenderer.invoke('get-welcome-state'),
  setWelcomeShown: (): Promise<void> => ipcRenderer.invoke('set-welcome-shown') as Promise<void>,
  // 关于页（2026-09-30）：复用欢迎 overlay，托盘「关于」触发
  onAboutShow: (callback: (version: string) => void): void =>
    subscribe<string>('about:show', callback),
  onUpdateDownloadProgress: (callback: (progress: DownloadProgressEvent) => void): void =>
    subscribe<DownloadProgressEvent>('update-download-progress', callback),

  // ========== 窗口固定 ==========
  setPinned: (pinned: boolean): Promise<boolean> => ipcRenderer.invoke('set-pinned', pinned) as Promise<boolean>,
  verifyPinned: (): Promise<boolean> => ipcRenderer.invoke('verify-pinned') as Promise<boolean>,
  blurSearch: (): Promise<boolean> => ipcRenderer.invoke('blur-search') as Promise<boolean>,
  focusSearch: (): Promise<boolean> => ipcRenderer.invoke('focus-search') as Promise<boolean>,

  // ========== 自动打标签设置（2026-09-09） ==========
  getTagSettings: (): Promise<TagSettingsEvent> =>
    ipcRenderer.invoke('get-tag-settings') as Promise<TagSettingsEvent>,
  onTagSettingsUpdated: (callback: (settings: TagSettingsEvent) => void): void =>
    subscribe<TagSettingsEvent>('tag-settings-updated', callback),

  // ========== 新条目动画：贴边态触发条脉冲（2026-09-11，方案 B） ==========
  // 渲染层在面板隐藏（贴边收起）期间收到新内容时通知一次；主进程对 triggerWindow
  // executeJavaScript 脉冲 180ms。id 仅作日志/未来扩展，脉冲本身与条目无关。
  requestEntryPulse: (id: string): void => ipcRenderer.send('window-entry-pulse', id),

  // ========== 诊断（命中偏移排查，定位后可移除） ==========
  diagHit: (data: Record<string, unknown>): void => ipcRenderer.send('diag-hit', data),
} as const;

contextBridge.exposeInMainWorld('clipboardAPI', clipboardAPI);
