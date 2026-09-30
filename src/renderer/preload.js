/**
 * preload.js - 暴露剪贴板历史 API
 */
const { contextBridge, ipcRenderer } = require('electron');

// 说明：链接识别（extractLinks）只在主进程入库时执行并存为 item.links，
// 渲染层直接读取该字段即可，无需引入 link-utils。
// （Electron sandbox 模式下 preload 的 require 不支持跨目录相对路径）

contextBridge.exposeInMainWorld('clipboardAPI', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  copyItem: (id) => ipcRenderer.invoke('copy-item', id),
  simulateInput: (id) => ipcRenderer.invoke('simulate-input', id),
  getFileIcon: (path) => ipcRenderer.invoke('get-file-icon', path),
  openFileLocation: (path) => ipcRenderer.invoke('open-file-location', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  removeItem: (id) => ipcRenderer.invoke('remove-item', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  onHistoryUpdated: (callback) => {
    ipcRenderer.on('history-updated', (event, history) => callback(history));
  },

  // ========== Header 可变高度（方案 A，2026-09-28）==========
  // 主进程 100ms 轮询判定光标在/离 header 区（进入即时/离开防抖 180ms/
  // 弹出后 400ms 抑制），状态翻转推送 bool；渲染层据此切 .header--hover。
  onHeaderHover: (callback) => {
    ipcRenderer.on('header:hover', (event, expanded) => callback(!!expanded));
  },

  // ========== 窗口定位 / 鼠标事件 ==========
  mouseEnter: () => ipcRenderer.send('mouse-enter'),
  mouseLeave: () => ipcRenderer.send('mouse-leave'),
  setSearchActive: (active) => ipcRenderer.send('set-search-active', active),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  updateDraggedPosition: (x, y) => ipcRenderer.invoke('update-dragged-position', x, y),
  dragStart: () => ipcRenderer.invoke('drag-start'),
  dragEnd: () => ipcRenderer.invoke('drag-end'),

  // ========== 倒计时 ==========
  getCountdown: () => ipcRenderer.invoke('get-countdown'),
  onCountdownUpdate: (callback) => {
    ipcRenderer.on('countdown-update', (event, data) => callback(data));
  },

  // ========== 轻量升级链路（2026-09-20，自研） ==========
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: (url) => ipcRenderer.invoke('update-download', url),
  updateInstall: (filePath) => ipcRenderer.invoke('update-install', filePath),
  // 两段式窗口透明度（2026-09-30）：主进程推送目标值，渲染层写 --win-alpha 变量
  onWindowOpacity: (callback) => { ipcRenderer.on('window:opacity', (e, v) => callback(v)); },
  // 窗口可见性权威信号（2026-09-30）：backgroundThrottling:false 下 visibilityState 失灵
  onWindowVisibility: (callback) => { ipcRenderer.on('window:visibility', (e, v) => callback(v)); },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (event, progress) => callback(progress));
  },

  // ========== 窗口固定 ==========
  setPinned: (pinned) => ipcRenderer.invoke('set-pinned', pinned),
  verifyPinned: () => ipcRenderer.invoke('verify-pinned'),
  blurSearch: () => ipcRenderer.invoke('blur-search'),
  focusSearch: () => ipcRenderer.invoke('focus-search'),

  // ========== 自动打标签设置（2026-09-09） ==========
  getTagSettings: () => ipcRenderer.invoke('get-tag-settings'),
  onTagSettingsUpdated: (callback) => {
    ipcRenderer.on('tag-settings-updated', (event, settings) => callback(settings));
  },

  // ========== 新条目动画：贴边态触发条脉冲（2026-09-11，方案 B） ==========
  // 渲染层在面板隐藏（贴边收起）期间收到新内容时通知一次；主进程对 triggerWindow
  // executeJavaScript 脉冲 180ms。id 仅作日志/未来扩展，脉冲本身与条目无关。
  requestEntryPulse: (id) => ipcRenderer.send('window-entry-pulse', id),

  // ========== 诊断（命中偏移排查，定位后可移除） ==========
  diagHit: (data) => ipcRenderer.send('diag-hit', data),
});
