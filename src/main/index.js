/**
 * index.js - 剪贴板 spike demo 主进程入口
 *
 * 目的：验证核心链路
 *   1. ClipboardMonitor 轮询监听剪贴板变化
 *   2. 面板展示历史
 *   3. 点击条目回写剪贴板；双击条目回写选中内容并发送 Ctrl+V
 *
 * 附加（同步自 KeySense）：
 *   - 窗口贴边 / 定时隐藏 / 鼠标靠边缘唤出（EdgeDetector）
 *   - 全局快捷键 Ctrl+Shift+V 切换显示
 */

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const ClipboardMonitor = require('./clipboard-monitor');
const EdgeDetector = require('./edge-detector');
const HistoryStorage = require('./storage');
const { PasteBridge } = require('./paste-bridge');
const { FocusTracker } = require('./focus-tracker');

class ClipboardSpikeApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.storage = new HistoryStorage();
    this.monitor = new ClipboardMonitor({
      intervalMs: 600,
      maxHistory: this.storage.getMaxHistory(),
      storage: this.storage,
    });
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
      resizable: true,
      skipTaskbar: true,
      // 透明窗口：渲染层 #app 自带圆角背景（--bg），原生层不绘制任何背景。
      // 否则滑出动画时 CSS transform 把 #app 移走，原生白底残留在原地直到 hide()。
      // 注意：backgroundColor 只接受 hex（Electron 会忽略 'transparent' 字符串），
      // 全透必须配合 transparent: true。
      transparent: true,
      backgroundColor: '#00000000',
      // 先不抢占启动时的前台窗口；由 EdgeDetector.showInactive() 显示。
      show: false,
      // 不成为前台窗口：鼠标点击面板时，原目标窗口仍保持焦点，Ctrl+V 可直接发送给它。
      focusable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../renderer/preload.js'),
      },
    });

    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    // 鼠标点击不激活面板：目标窗口自始至终保持焦点（用户洞察 2026-09-02，
    // 这是「双击粘贴失败」的本质修复——之前全部恢复逻辑都在为被抢走焦点打补丁）。
    this._applyNoActivate(this.mainWindow);

    // 独立的边缘触发条窗口。窗口本身只有 6px 宽、与 header 同高，命中区域与可见条完全一致。
    this.triggerWindow = new BrowserWindow({
      width: 6,
      height: 56,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      focusable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    this.triggerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html><html><head><style>
        html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
        #bar { position:fixed; top:0; bottom:0; left:0; width:6px; background:linear-gradient(180deg,#a29bfe,#6c5ce7); border-radius:0 6px 6px 0; box-shadow:0 0 8px rgba(108,92,231,.8); }
        #bar.right { left:auto; right:0; border-radius:6px 0 0 6px; }
        #bar.left { left:0; border-radius:0 6px 6px 0; }
      </style></head><body><div id="bar"></div></body></html>
    `)}`);
    this.triggerWindow.setIgnoreMouseEvents(false);
    this.triggerWindow.webContents.on('did-finish-load', () => {
      const edge = this.triggerWindow._edge || 'right';
      this.triggerWindow.webContents.executeJavaScript(
        `document.getElementById('bar').className = '${edge}'`
      ).catch(() => {});
    });

    // 开发模式判断：用 app.isPackaged（打包后为 true），不依赖环境变量
    const isDev = !app.isPackaged;
    console.log(`[Spike] 当前环境: ${isDev ? 'development（未打包）' : 'production（已打包）'}`);
    if (isDev) {
      this.mainWindow.webContents.openDevTools({ mode: 'detach' });
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
      {
        label: '历史上限',
        submenu: this._buildMaxHistorySubmenu(),
      },
      { type: 'separator' },
      { label: '退出', click: () => app.exit(0) },
    ]));
    this.tray.on('click', () => this.toggleWindow());
  }

  /**
   * 构建「历史上限」子菜单
   */
  _buildMaxHistorySubmenu() {
    const options = [100, 200, 500, 1000, 5000];
    const current = this.monitor ? this.monitor.maxHistory : 500;
    return options.map(opt => ({
      label: `${opt} 条`,
      type: 'radio',
      checked: current === opt,
      click: () => {
        this.monitor.setMaxHistory(opt);
        this.storage.setMaxHistory(opt);
        this.pushHistory();
      },
    }));
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

    // 用默认浏览器打开 URL（协议白名单：仅 http/https）
    // 安全：shell.openExternal 对未过滤协议可能拉起任意已注册 handler，
    // file:/javascript:/自定义协议一律拒绝。
    ipcMain.handle('open-external', async (event, rawUrl) => {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        return { ok: false, error: 'URL 为空' };
      }
      let url = rawUrl.trim();
      // 无协议补全：localhost / IP 补 http，其余补 https
      if (!/^https?:\/\//i.test(url)) {
        const prefix = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(url) ? 'http://' : 'https://';
        url = prefix + url;
      }
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: '仅支持 http/https 链接' };
      }
      try {
        // 二次校验：URL 解析后协议必须是 http/https
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, error: '仅支持 http/https 协议' };
        }
        await shell.openExternal(parsed.href);
        console.log(`[Spike] 已在默认浏览器打开: ${parsed.href}`);
        return { ok: true, url: parsed.href };
      } catch (err) {
        console.warn(`[Spike] 打开链接失败: ${err.message} (url=${rawUrl})`);
        return { ok: false, error: err.message };
      }
    });

    // 获取文件的真实系统图标（异步，返回 dataURL）
    ipcMain.handle('open-file-location', async (event, filePath) => {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, error: '文件路径为空' };
      }
      const normalized = process.platform === 'win32'
        ? filePath.replace(/\//g, '\\')
        : filePath;
      try {
        if (!fs.existsSync(normalized)) {
          return { ok: false, error: '文件不存在或已被移动' };
        }
        shell.showItemInFolder(normalized);
        return { ok: true };
      } catch (err) {
        console.warn(`[Spike] 打开文件位置失败: ${err.message} (path=${normalized})`);
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('get-file-icon', async (event, filePath) => {
      try {
        if (!filePath || typeof filePath !== 'string') return null;
        // Windows 上 getFileIcon 需要反斜杠正规路径；正斜杠可能失败
        let normalized = filePath;
        if (process.platform === 'win32') {
          normalized = filePath.replace(/\//g, '\\');
        }
        console.log(`[Spike] getFileIcon 入参: "${filePath}" -> 规范化为 "${normalized}"`);
        const icon = await app.getFileIcon(normalized, { size: 'normal' });
        if (icon && !icon.isEmpty()) {
          console.log(`[Spike] getFileIcon 成功: ${filePath}`);
          return icon.toDataURL();
        }
        console.warn(`[Spike] getFileIcon 返回空图标: ${filePath}`);
        return null;
      } catch (err) {
        console.warn(`[Spike] 获取文件图标失败: ${err.message} (path=${filePath})`);
        return null;
      }
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

    // 双击条目（Ditto/CopyQ 模型，2026-09-02 对齐竞品实现）：
    //   写入系统剪贴板 → 恢复目标窗口焦点 → Ctrl+V → 隐藏面板（Ditto 实际顺序）
    // 15:59 实机教训：先收面板会在 hide 瞬间触发系统前台重分配——
    // 从 VSCode 终端启动的子进程，收起后前台特权关联窗口（VSCode）抢先拿走焦点，
    // 粘贴时前台已不是目标窗口。改为先粘贴后收面板：粘贴时前台未变，
    // restored=same 直接发键，无竞争窗口。
    ipcMain.handle('simulate-input', async (event, id) => {
      const item = this.monitor.getHistory().find(h => h.id === id);
      if (!item) return { ok: false, error: '未找到该条目' };

      // Ctrl+V 没有“指定历史条目”的参数；选中 item 必须先成为系统剪贴板内容。
      const copied = this.monitor.copyToClipboard(item);
      if (!copied) return { ok: false, error: '写入系统剪贴板失败' };

      // 取目标句柄（16:34 根因修复）：双击瞬间重新抓前台——NOACTIVATE 面板不抢焦点，
      // 此刻前台就是真实目标窗口；弹出时冻结记录的 tracked 句柄仅作兜底。
      // fgNow=0 是窗口切换真空态（合法瞬态），用 captureForegroundRetry 忙等重试。
      const fgNow = this.pasteBridge ? this.pasteBridge.captureForegroundRetry() : 0;
      const trackedHwnd = this.focusTracker ? this.focusTracker.getHwnd() : 0;
      const restoreHwnd = fgNow > 0 ? fgNow : trackedHwnd;
      console.log(`[Spike] paste target: fgNow=${fgNow} tracked=${trackedHwnd} -> use=${restoreHwnd}`);

      // ① 先粘贴（面板 NOACTIVATE 不抢焦点，目标窗口仍在前台）
      let result = this.pasteBridge.pasteTo(restoreHwnd);
      // CopyQ 同款降级：Ctrl+V 被吞（RDP/远程桌面等场景）时尝试 Shift+Insert。
      if (!result.ok && restoreHwnd && result.error !== 'restore-denied' && result.error !== 'modifiers-held') {
        console.warn(`[Spike] Ctrl+V 失败(${result.error || 'unknown'})，降级 Shift+Insert 重试`);
        result = this.pasteBridge.pasteTo(restoreHwnd, { key: 'shift-insert' });
      }

      // ② 双击不收面板（用户决策 2026-09-02）：保留面板支持连续操作；
      // 句柄生命周期跟面板走（setOnHidden 时 clear），不随单次粘贴清除。
      // 5 分钟过期由 getHwnd 内部处理；外部窗口切换由 pasteTo 的 IsWindow 校验兜底。
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.setFocusable(false);
      }
      if (!result.ok) {
        // 粘贴失败时面板保持显示：用户可直接重试或改用单击复制，不打断操作流
        console.warn(`[Spike] 选中条目粘贴失败: ${result.error}`);
      } else {
        console.log(`[Spike] 已粘贴选中条目: ${item.type} ${item.preview} (restored=${result.restored})`);
        // 粘贴成功后抑制轮询归档+重建基线：否则 600ms 轮询把刚粘贴的内容当新复制
        // 处理 → pushHistory → 渲染层全量重建 → 连续双击的 DOM 元素被销毁，
        // 第二击事件丢失（16:50「只有第一条成功」根因）
        this.monitor.rebaseAfterPaste();
      }
      return result;
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

    // 搜索框需要键盘焦点；仅在用户明确点击搜索框时临时允许主窗口获取焦点。
    ipcMain.handle('focus-search', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      this.mainWindow.setFocusable(true);
      this.mainWindow.focus();
      return true;
    });

    // 搜索框失焦后关回不可聚焦，恢复“面板不抢焦点”常态（Ditto/CopyQ 模型的辅助措施）。
    ipcMain.handle('blur-search', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      this.mainWindow.setFocusable(false);
      return true;
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
      if (this.edgeDetector) this.edgeDetector.onMouseLeaveDebounced();
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

  /**
   * 给窗口加 WS_EX_NOACTIVATE 样式：鼠标点击不激活窗口、不抢前台。
   * 这是 Ditto/uTools 类工具「点击不夺焦」的标准实现（Electron 无直接参数）。
   * focusable:false 只禁键盘焦点链，鼠标点击默认仍会触发 WM_MOUSEACTIVATE 激活；
   * NOACTIVATE 从源头禁掉，目标窗口自始至终保持焦点。
   */
  _applyNoActivate(win) {
    if (process.platform !== 'win32') return;
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)');
      const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)');
      const GWL_EXSTYLE = -20;
      const WS_EX_NOACTIVATE = 0x08000000;
      const WS_EX_TOPMOST = 0x00000008;
      const hwnd = win.getNativeWindowHandle().readBigInt64LE(0);
      const cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      // NOACTIVATE + TOPMOST（alwaysOnTop 在 Electron 内部也设 TOPMOST，这里补齐以防重置）
      // 注意：句柄是 64 位，EXSTYLE 读写都在低 32 位，但传参必须保持完整 intptr_t 宽度，
      // 先 BigInt 运算再整体转 Number 会丢高 32 位（句柄高位非零时窗口句柄错乱），
      // 因此 SetWindowLongPtrW 直接收 BigInt（koffi intptr_t 原生支持）。
      const newStyle = (cur | BigInt(WS_EX_NOACTIVATE) | BigInt(WS_EX_TOPMOST));
      SetWindowLongPtrW(hwnd, GWL_EXSTYLE, newStyle);
      const after = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      const applied = (after & BigInt(WS_EX_NOACTIVATE)) !== 0n;
      console.log(`[Spike] WS_EX_NOACTIVATE ${applied ? '已应用' : '应用失败'}: hwnd=${hwnd} exstyle 0x${cur.toString(16)} -> 0x${after.toString(16)}`);
    } catch (err) {
      console.warn('[Spike] WS_EX_NOACTIVATE 应用失败:', err.message);
    }
  }

  /**
   * 诊断版 capture：抓前台现场（hwnd/pid/class）+ 过滤判定，结果推送到渲染层 console。
   * 目标窗口可用则记录，否则清空（宁可无目标不贴错）。
   */
  _diagCapture() {
    const r = this.pasteBridge ? this.pasteBridge.captureForegroundVerbose() : { hwnd: 0, reason: 'no-bridge' };
    if (r.hwnd > 0) {
      this.focusTracker._targetHwnd = r.hwnd;
      this.focusTracker._trackedAt = Date.now();
    } else {
      this.focusTracker._targetHwnd = 0;
      this.focusTracker._trackedAt = 0;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.executeJavaScript(
        `console.log('[FocusTracker] capture: hwnd=${r.hwnd} ${r.reason || ''} ${r.cls ? 'class=' + r.cls : ''} pid=${r.pid || 0}')`
      ).catch(() => {});
    }
  }

  async init() {
    this.createWindow();
    this.initTray();
    this.registerShortcut();
    this.setupIPC();

    // 初始化边缘检测器（贴边 / 自动隐藏 / 鼠标唤出）
    this.edgeDetector = new EdgeDetector(this.mainWindow, this.triggerWindow);
    this.edgeDetector.setOnHidden(() => {
      // 面板收起后句柄生命周期结束：下次唤出时重新 capture。
      // （双击不收面板，同一显示周期内句柄持续有效，支持连续粘贴多条目）
      this.focusTracker.clear();
    });
    // Ditto/CopyQ 模型：面板显示前记录原前台窗口，双击粘贴时由 PasteBridge 原子恢复+注入。
    // FFI 同步抓取（微秒级），无 PS 冷启动，消除「唤出后立即双击」的时序竞争。
    this.pasteBridge = new PasteBridge();
    this.focusTracker = new FocusTracker(this.pasteBridge);
    this.edgeDetector.setOnShown(() => {
      // capture 主进程日志用户看不到；把每次 capture 的判定结果推送到渲染层 console
      this._diagCapture();
    });
    this.edgeDetector.start();
    // 初次显示也使用非激活方式，并在抢焦点前记录原目标窗口。
    this.edgeDetector.forceShow();
    // 默认不抢目标窗口焦点；搜索框点击时由 focus-search IPC 按需开启。
    this.mainWindow.setFocusable(false);

    // 启动时从磁盘恢复历史（重启不丢失）
    const restoredCount = this.monitor.loadFromStorage();
    if (restoredCount > 0) {
      console.log(`[Spike] 已从存储恢复 ${restoredCount} 条历史`);
    }

    // 加密状态提示
    if (!this.storage.isEncryptionAvailable()) {
      console.warn('[Spike] ⚠ safeStorage 加密不可用（可能为 WSL/无钥匙串环境），历史将以明文落盘');
    } else {
      console.log('[Spike] ✅ 历史加密已启用（safeStorage / OS 钥匙串）');
    }

    // 剪贴板变化 → 推送给渲染进程
    this.monitor.setOnChange((item, history) => {
      console.log(`[Spike] 剪贴板变化: ${item.preview}`);
      this.pushHistory();
    });

    // 启动同步：恢复历史后，立即检查系统剪贴板，把未同步的新数据同步进来
    const syncResult = this.monitor.syncNow();
    if (syncResult.changed) {
      console.log(`[Spike] 启动同步：已将系统剪贴板内容归档: ${syncResult.item.preview}`);
    } else {
      console.log('[Spike] 启动同步：系统剪贴板无新内容（已在历史中或为空）');
    }

    this.monitor.start();

    // 恢复 + 同步后，推一次给渲染进程（避免窗口先加载空列表）
    this.pushHistory();

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
  if (spikeApp.triggerWindow && !spikeApp.triggerWindow.isDestroyed()) {
    spikeApp.triggerWindow.destroy();
  }
  spikeApp.monitor.stop();
  if (spikeApp.edgeDetector) spikeApp.edgeDetector.stop();
});

module.exports = ClipboardSpikeApp;
