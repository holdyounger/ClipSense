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

  // ========== 窗口固定 ==========
  setPinned: (pinned) => ipcRenderer.invoke('set-pinned', pinned),
  verifyPinned: () => ipcRenderer.invoke('verify-pinned'),
  blurSearch: () => ipcRenderer.invoke('blur-search'),
  focusSearch: () => ipcRenderer.invoke('focus-search'),

  // ========== 诊断（命中偏移排查，定位后可移除） ==========
  diagHit: (data) => ipcRenderer.send('diag-hit', data),
});
