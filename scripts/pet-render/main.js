/**
 * pet-render/main.js - 桌宠资产离线渲染入口（2026-10-14，网易 WebM 方案）
 *
 * 用法：npx electron scripts/pet-render/main.js
 * 流程：离屏窗口加载 index.html → three.js 渲染 GLB 猫动画 → 逐帧 PNG 落盘
 *       → （外部）ffmpeg 合成 VP9 alpha WebM → src/renderer/pet-idle/jump.webm
 * 渲染与运行分离（网易架构）：质量在制作期锁定，运行时只播视频。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 300,
    height: 380,
    useContentSize: true,
    x: -700,              // 屏外：合成器照常渲染，不遮挡用户桌面
    y: 100,
    show: true,
    frame: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false, // 屏外窗口 rAF 不降速
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  ipcMain.on('render-done', (_e, summary) => {
    console.log('[render] done:', summary || '');
    setTimeout(() => app.exit(0), 400);
  });
  ipcMain.on('render-progress', (_e, line) => {
    console.log('[render]', line);
  });

  // 超时保底（3 分钟）
  setTimeout(() => {
    console.error('[render] timeout, exiting');
    app.exit(1);
  }, 180000);
});
