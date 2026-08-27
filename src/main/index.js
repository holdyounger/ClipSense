/**
 * index.js - 剪贴板 spike demo 主进程入口
 *
 * 目的：验证核心链路
 *   1. ClipboardMonitor 轮询监听剪贴板变化
 *   2. 面板展示历史
 *   3. 点击条目回写剪贴板
 *
 * 附加（同步自 KeySense）：
 *   - 窗口贴边 / 定时隐藏 / 鼠标靠边缘唤出（EdgeDetector）
 *   - 全局快捷键 Ctrl+Shift+V 切换显示
 */

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const ClipboardMonitor = require('./clipboard-monitor');
const EdgeDetector = require('./edge-detector');

class ClipboardSpikeApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.monitor = new ClipboardMonitor({ intervalMs: 600, maxHistory: 100 });
    this.edgeDetector = null;
  }

  createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const windowWidth = 360;

    this.mainWindow = new BrowserWindow({
      width: windowWidth,
      height: 480,
      // x: width - windowWidth,
      // y: 0,
      frame: false,          // 无边框（配合边缘吸附）
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../renderer/preload.js'),
      },
    });

    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    
    // 开发模式判断：用 app.isPackaged（打包后为 true），不依赖环境变量
    const isDev = !app.isPackaged;
    console.log(`[Spike] 当前环境: ${isDev ? 'development（未打包）' : 'production（已打包）'}`);
    if (isDev) {
      // this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
      console.log('[Spike] 生产模式，关闭菜单栏');
      this.mainWindow.removeMenu();
    }
  }

  initTray() {
    // 托盘图标（16x16，Windows 推荐；@2x 供高分屏）
    const iconPath = path.join(__dirname, '../renderer/tray-icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'win32') {
      icon = icon.resize({ width: 16, height: 16 });
    }
    // 兜底：图标加载失败时用空图标（避免崩溃）
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }
    this.tray = new Tray(icon);
    this.tray.setToolTip('ClipSense');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示/隐藏', click: () => this.toggleWindow() },
      {
        label: '固定窗口',
        type: 'checkbox',
        checked: this.edgeDetector ? this.edgeDetector.isPinned : false,
        click: (menuItem) => {
          if (this.edgeDetector) {
            this.edgeDetector.setPinned(menuItem.checked);
          }
        },
      },
      { type: 'separator' },
      {
        label: '自动隐藏倒计时',
        submenu: this._buildHideDelaySubmenu(),
      },
      { type: 'separator' },
      { label: '退出', click: () => app.exit(0) },
    ]));
    this.tray.on('click', () => this.toggleWindow());
  }

  /**
   * 构建「自动隐藏倒计时」子菜单
   */
  _buildHideDelaySubmenu() {
    const options = [
      { label: '3 秒', value: 3000 },
      { label: '5 秒', value: 5000 },
      { label: '10 秒', value: 10000 },
      { label: '15 秒', value: 15000 },
      { label: '30 秒', value: 30000 },
    ];
    const current = this.edgeDetector ? this.edgeDetector.hideDelay : 3000;
    return options.map(opt => ({
      label: opt.label,
      type: 'radio',
      checked: current === opt.value,
      click: () => {
        if (this.edgeDetector) this.edgeDetector.setHideDelay(opt.value);
      },
    }));
  }

  toggleWindow() {
    if (this.edgeDetector) {
      this.edgeDetector.toggle();
      return;
    }
    if (!this.mainWindow) return;
    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.mainWindow.show();
    }
  }

  registerShortcut() {
    // Ctrl+Shift+V 唤出（V = clipboard 语义）
    const ok = globalShortcut.register('CommandOrControl+Shift+V', () => {
      if (this.edgeDetector) {
        this.edgeDetector.toggle();
        if (this.edgeDetector.isWindowVisible) this.pushHistory();
      } else {
        this.toggleWindow();
      }
    });
    console.log(`[Spike] 全局快捷键 Ctrl+Shift+V 注册${ok ? '成功' : '失败'}`);
  }

  setupIPC() {
    // 渲染进程拉取历史
    ipcMain.handle('get-history', () => {
      return this.monitor.getHistory();
    });

    // 点击条目：回写剪贴板（按类型分类处理）
    ipcMain.handle('copy-item', (event, id) => {
      const item = this.monitor.getHistory().find(h => h.id === id);
      if (item) {
        const ok = this.monitor.copyToClipboard(item);
        console.log(`[Spike] 已回写剪贴板(${item.type}): ${item.preview}`);
        return ok ? { ok: true } : { ok: false, error: '回写失败' };
      }
      return { ok: false, error: '未找到该条目' };
    });

    // 删除单条
    ipcMain.handle('remove-item', (event, id) => {
      this.monitor.remove(id);
      return this.monitor.getHistory();
    });

    // 清空
    ipcMain.handle('clear-history', () => {
      this.monitor.clear();
      return this.monitor.getHistory();
    });

    // ========== 倒计时 ==========

    // 查询当前倒计时状态
    ipcMain.handle('get-countdown', () => {
      return this.edgeDetector ? this.edgeDetector.getCountdown()
        : { isCountingDown: false, remainingMs: null };
    });

    // ========== 窗口固定 ==========

    ipcMain.handle('set-pinned', (event, pinned) => {
      if (this.edgeDetector) this.edgeDetector.setPinned(pinned);
      return true;
    });

    ipcMain.handle('verify-pinned', () => {
      return this.edgeDetector ? this.edgeDetector.isPinned : false;
    });

    // ========== 窗口定位 / 鼠标事件（edge-detector） ==========

    // 鼠标进入窗口
    ipcMain.on('mouse-enter', () => {
      if (this.edgeDetector) this.edgeDetector.onMouseEnter();
    });

    // 鼠标离开窗口
    ipcMain.on('mouse-leave', () => {
      if (this.edgeDetector) this.edgeDetector.onMouseLeave();
    });

    // 获取窗口 bounds（拖拽用）
    ipcMain.handle('get-window-bounds', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        return this.mainWindow.getBounds();
      }
      return null;
    });

    // 更新拖拽后的窗口位置
    ipcMain.handle('update-dragged-position', (event, x, y) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        // 只 setPosition，不动 size（避免拖拽期间窗口尺寸漂移）
        this.mainWindow.setPosition(Math.round(x), Math.round(y));
      }
      if (this.edgeDetector) this.edgeDetector.updateDraggedPosition(Math.round(x), Math.round(y));
      return true;
    });

    // 拖拽开始：暂停边缘检测（防止 _showWindow/_hideWindow 干扰拖拽）
    ipcMain.handle('drag-start', () => {
      if (this.edgeDetector) this.edgeDetector.setDragging(true);
      return true;
    });

    // 拖拽结束：恢复边缘检测
    ipcMain.handle('drag-end', () => {
      if (this.edgeDetector) this.edgeDetector.setDragging(false);
      return true;
    });
  }

  // 把当前历史推送给渲染进程
  pushHistory() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('history-updated', this.monitor.getHistory());
    }
  }

  async init() {
    this.createWindow();
    this.initTray();
    this.registerShortcut();
    this.setupIPC();

    // 初始化边缘检测器（贴边 / 自动隐藏 / 鼠标唤出）
    this.edgeDetector = new EdgeDetector(this.mainWindow);
    this.edgeDetector.setOnHidden(() => {
      // 隐藏时无额外操作
    });
    this.edgeDetector.start();

    // 剪贴板变化 → 推送给渲染进程
    this.monitor.setOnChange((item, history) => {
      console.log(`[Spike] 剪贴板变化: ${item.preview}`);
      this.pushHistory();
    });
    this.monitor.start();

    console.log('[Spike] 剪贴板监听已启动（轮询间隔 600ms）');
    console.log('[Spike] 边缘唤出已启动（鼠标靠右边缘 5px 唤出）');
    console.log('[Spike] 现在复制任何文本，会自动出现在面板里');
  }
}

const spikeApp = new ClipboardSpikeApp();

app.whenReady().then(async () => {
  await spikeApp.init();
});

app.on('window-all-closed', () => {
  // 有托盘，保持后台；spike 也允许通过托盘退出
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  spikeApp.monitor.stop();
  if (spikeApp.edgeDetector) spikeApp.edgeDetector.stop();
});

module.exports = ClipboardSpikeApp;
