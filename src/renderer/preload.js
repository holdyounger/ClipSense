/**
 * preload.js - 暴露剪贴板历史 API
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipboardAPI', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  copyItem: (id) => ipcRenderer.invoke('copy-item', id),
  getFileIcon: (path) => ipcRenderer.invoke('get-file-icon', path),
  removeItem: (id) => ipcRenderer.invoke('remove-item', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  onHistoryUpdated: (callback) => {
    ipcRenderer.on('history-updated', (event, history) => callback(history));
  },

  // ========== 窗口定位 / 鼠标事件 ==========
  mouseEnter: () => ipcRenderer.send('mouse-enter'),
  mouseLeave: () => ipcRenderer.send('mouse-leave'),
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
});
