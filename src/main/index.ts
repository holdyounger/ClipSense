/**
 * index.ts - 剪贴板 spike demo 主进程入口
 *
 * 目的：验证核心链路
 *   1. ClipboardMonitor 轮询监听剪贴板变化
 *   2. 面板展示历史
 *   3. 点击条目回写剪贴板；双击条目回写选中内容并发送 Ctrl+V
 *
 * 附加（同步自 KeySense）：
 *   - 窗口贴边 / 定时隐藏 / 鼠标靠边缘唤出（EdgeDetector）
 *   - 全局快捷键 Alt+V 切换显示
 *
 * TS 迁移（2026-10-10，第六批 #2，渐进迁移收尾）：主进程入口——
 *   - electron 解构以结构化最小接口收窄（ipcMain 注册面给 handler 回调
 *     上下文类型，其余 any 与 .js 一致）；本地模块 require 以 typeof import
 *     断言取真实类型；ClipboardMonitor 例外保持 any（其 MonitorStorageLike
 *     与 HistoryStorage 的 StorageItem 结构互斥，断言会误报 storage 注入）
 *   - _readConfig/_writeConfig/_targetHwnd 私有成员被本文件外部直用是既有
 *     债务，以纯结构接口 + as unknown as 显式收口（交叉类型遇 private 同名
 *     成员会整体坍缩为 never——编译实证；运行时零改动）
 *   - createWindow/init 的「创建即用」路径以 ! 断言表达赋值先于访问的
 *     既有顺序不变量（any 赋值不产生窄化）
 *   - 10 处 catch 错误消息按项目惯例收窄为 (err as Error).message
 *   - 启动/托盘/IPC/快捷键/升级链路逻辑零改动
 */

// ==================== TS 类型（第六批 #2，2026-10-10） ====================
/** 通用矩形（Electron Rectangle 结构化视图） */
interface IndexBounds { x: number; y: number; width: number; height: number; }

/** WebContents 消费面（index.js 用到的子集） */
interface IndexWebContents {
  send: (channel: string, ...args: unknown[]) => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  /** EdgeDetector 注入合成 mousemove 用（其 EdgeWebContents 契约要求此成员） */
  sendInputEvent: (input: { type: string; x: number; y: number }) => void;
  focus: () => void;
  openDevTools: (options?: { mode?: string }) => void;
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  isDestroyed: () => boolean;
}

/**
 * 主窗口消费面（与 edge-detector 的 EdgeMainWindow 结构同构兼容；
 * require('electron') 保持 .js 的 any 语义——new BrowserWindow() 产物可直接赋值）
 */
interface IndexMainWindow {
  isDestroyed: () => boolean;
  getBounds: () => IndexBounds;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  hide: () => void;
  show: () => void;
  showInactive: () => void;
  focus: () => void;
  moveTop: () => void;
  setPosition: (x: number, y: number) => void;
  setBounds: (bounds: IndexBounds) => void;
  setMinimumSize: (minWidth: number, minHeight: number) => void;
  setIgnoreMouseEvents: (ignore: boolean) => void;
  removeMenu: () => void;
  loadFile: (filePath: string) => unknown;
  loadURL: (url: string) => unknown;
  destroy: () => void;
  webContents: IndexWebContents;
}

/** 触发条舞台窗口（主窗口面 + 贴边标记动态写入） */
interface IndexTriggerWindow extends IndexMainWindow {
  _edge?: 'left' | 'right';
}

/** 托盘消费面 */
interface IndexTray {
  setToolTip: (tip: string) => void;
  setContextMenu: (menu: unknown) => void;
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  isDestroyed: () => boolean;
  displayBalloon: (options: { title: string; content: string; icon: string; iconType: string }) => void;
}

/** 标签设置（storage.getTagSettings 返回的结构化视图；TagSettings 本体在 storage.ts 模块作用域） */
interface IndexTagSettings {
  enabled: boolean;
  tags: Record<string, boolean>;
}

/** captureForegroundVerbose 结构化视图（本体在 paste-bridge.ts 模块作用域） */
interface IndexCaptureVerbose {
  hwnd: number;
  pid?: number;
  cls?: string;
  reason?: string;
}

type EdgeDetectorInstance = InstanceType<typeof import('./edge-detector')>;
type ClipboardMonitorInstance = InstanceType<typeof import('./clipboard-monitor')>;
type PasteBridgeInstance = InstanceType<(typeof import('./paste-bridge'))['PasteBridge']>;

/**
 * storage 消费面（公共 API + 本文件直用的私有配置读写）。
 * 注：私有成员不能用交叉类型收口——同名成员在多成分中且其一为 private 时，
 * 整个交集被 TS 降为 never（编译实证）；纯结构接口 + as unknown as 断言。
 * 外部直写 storage 私有方法是既有债务，运行时零改动。
 */
interface IndexStorageApi {
  getMaxHistory: () => number;
  setMaxHistory: (max: number) => void;
  getTagSettings: () => IndexTagSettings;
  setTagSettings: (settings: IndexTagSettings) => void;
  getLastShownVersion: () => string;
  setLastShownVersion: (v: string) => void;
  isEncryptionAvailable: () => boolean;
  _readConfig: () => Record<string, unknown>;
  _writeConfig: (patch: Record<string, unknown>) => void;
}

/** FocusTracker 消费面（公共 API + _diagCapture 直写的私有字段；收口方式同上） */
interface IndexFocusTrackerApi {
  getHwnd: () => number;
  refresh: () => boolean;
  clear: () => void;
  _targetHwnd: number;
  _trackedAt: number;
}

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen, shell } = require('electron') as {
  app: any;
  BrowserWindow: any;
  globalShortcut: any;
  /** IPC 注册面：handler 回调经此获得上下文类型（event/负载 any——与 .js 一致） */
  ipcMain: {
    handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
  };
  Tray: any;
  Menu: any;
  nativeImage: any;
  screen: any;
  shell: any;
};
const fs = require('fs');
const path = require('path');
// ClipboardMonitor 保持 .js require 的 any 语义：其 MonitorStorageLike 与 HistoryStorage 的
// StorageItem 在 links/tags 可空性与 files 形状上结构互斥（运行时 JSON 序列化天然兼容），
// typeof import 断言会误报下方 storage 注入——条目模型统一属后续专项，本批不扩散。
const ClipboardMonitor = require('./clipboard-monitor');
const EdgeDetector = require('./edge-detector') as typeof import('./edge-detector');
const HistoryStorage = require('./storage') as typeof import('./storage');
const { PasteBridge } = require('./paste-bridge') as typeof import('./paste-bridge');
const { buildTriggerScript, DRAWER } = require('./trigger-anim') as typeof import('./trigger-anim');
const { FocusTracker } = require('./focus-tracker') as typeof import('./focus-tracker');
const updater = require('./updater') as typeof import('./updater');
const { WINDOW_WIDTH, WINDOW_HEIGHT } = require('./window-dims') as typeof import('./window-dims');

class ClipboardSpikeApp {
  mainWindow: IndexMainWindow | null;
  triggerWindow: IndexTriggerWindow | null = null; // .js 构造器不初始化（undefined）；null 同 falsy 语义
  tray: IndexTray | null;
  storage: IndexStorageApi;
  monitor: ClipboardMonitorInstance;
  pasteBridge: PasteBridgeInstance | null = null;   // init() 创建（.js 为 undefined，null 同 falsy 语义）
  focusTracker: IndexFocusTrackerApi | null = null; // 同上
  edgeDetector: EdgeDetectorInstance | null;

  constructor() {
    this.mainWindow = null;
    this.tray = null;
    // 配置读写私有方法被本文件直用为既有债务，结构接口 + 断言收口（运行时零改动）
    this.storage = new HistoryStorage() as unknown as IndexStorageApi;
    this.monitor = new ClipboardMonitor({
      intervalMs: 600,
      maxHistory: this.storage.getMaxHistory(),
      storage: this.storage,
      // 自动打标签设置注入（2026-09-09）：识别时 disabled 类直接跳过
      tagOptions: this.storage.getTagSettings(),
    });
    this.edgeDetector = null;
  }

  createWindow() {
    // （TS 迁移注）原此处解构 workAreaSize 的 width/height 已是死代码（仅注释引用），
    // noUnusedLocals 下移除；窗口尺寸恒用 WINDOW_WIDTH/WINDOW_HEIGHT 常量
    const windowWidth = WINDOW_WIDTH; // 黄金比例常量（window-dims，340×550 ≈ φ）

    this.mainWindow = new BrowserWindow({
      width: windowWidth,
      height: WINDOW_HEIGHT,
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
      // 2026-09-10 焦点模型回切：改回标准可聚焦窗口——实机三轮验证不夺焦模型
      //（NOACTIVATE + setFocusable 按需切换）与搜索键盘交互根本冲突：Ctrl+F/
      // 打字/输入法全部不可达。粘贴不受影响：PasteBridge 在面板显示前记录原
      // 前台窗口，双击时原子恢复+注入（2026-09-02 恢复路径保留并回归验证）；
      // 边缘自动显示仍走 showInactive 不抢焦点。
      // focusable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 弹出时序依赖隐藏态 rAF：EdgeDetector._showWindow 先让渲染层
        // prepare（双 rAF 绘制确认）再 showInactive。默认节流会冻结隐藏
        // 窗口的 rAF，确认链只能走兜底定时器，首帧就绪无法保证。
        backgroundThrottling: false,
        preload: path.join(__dirname, '../renderer/preload.js'),
      },
    });

    this.mainWindow!.loadFile(path.join(__dirname, '../renderer/index.html'));
    // 2026-09-10 焦点模型回切：不再强制 NOACTIVATE——实机三轮验证不夺焦模型
    // 与搜索键盘交互（Ctrl+F/打字/输入法）根本冲突。双击粘贴的焦点恢复由
    // PasteBridge 原子恢复+注入承担。如需回滚：恢复下一行调用即可。
    // this._applyNoActivate(this.mainWindow);

    // 独立的边缘触发条窗口。窗口本身只有 6px 宽、与 header 同高，命中区域与可见条完全一致。
    this.triggerWindow = new BrowserWindow({
      // V1.0.4 抽屉舞台（2026-09-17 动画卡顿+闪烁优化）：物理窗口固定 24px
      // = DRAWER.restWidth(6) + DRAWER.travel(18)，动画全程零 resize——
      // transparent 窗口 setBounds 触发 DWM 表面重分配，是实机「弹出动画
      // 卡顿 + 闪烁一次」的根因。多余 18px 点击穿透（见下方 setIgnoreMouseEvents）。
      width: DRAWER.restWidth + DRAWER.travel,
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
    this.triggerWindow!.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html><html><head><style>
        html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
        #bar { position:fixed; top:0; bottom:0; left:0; width:6px; background:linear-gradient(180deg,#a29bfe,#6c5ce7); border-radius:0 6px 6px 0; box-shadow:0 0 8px rgba(108,92,231,.8); }
        #bar.right { left:auto; right:0; border-radius:6px 0 0 6px; transform-origin:right center; }
        #bar.left { left:0; border-radius:0 6px 6px 0; transform-origin:left center; }
        /* 新条目动画·贴边态 V0.5「真抽屉」（2026-09-12，小M 核定）：
           新内容到达 = 抽屉拉开 → 内容塞入 → 抽屉推回关上（三段状态迁移，
           「关好了」=「已收纳」的确认感）。窗口静止 6px（命中区决策不变），
           动画期间由主进程临时扩宽 DRAWER.travel px 给横向拉出空间，播完缩回。
           #cavity = 柜内亮光层：抽屉拉开后露出的柜体内辉（#bar 下层，
           拉开段随开口渐亮，推回段指数收熄——能量被封闭在柜内）。
           #bead = 光珠（新内容具象）：坠入缝隙被吞。方向由回放器按 bar.className
           镜像（right 边向左拉出 = -dx，left 边向右拉出 = +dx）。 */
        #cavity {
          position:fixed; top:4px; bottom:4px; width:24px; pointer-events:none;
          border-radius:4px; opacity:0;
        }
        #bead {
          position:fixed; top:50%; margin-top:-2px;
          width:4px; height:4px; border-radius:50%; pointer-events:none;
          background:radial-gradient(circle, rgba(255,255,255,.95), rgba(162,155,254,.55) 45%, transparent 72%);
          opacity:0;
        }
      </style></head><body><div id="cavity"></div><div id="bead"></div><div id="bar"></div>
      <script>
        // 关键帧与回放器由主进程 trigger-anim.js 预积分生成（buildTriggerScript）：
        // __clipSenseBarPulse() 协议不变（无参调用，连续重触发由 __clipSenseBarStop 复位）。
        ${buildTriggerScript()}
      </script></body></html>
    `)}`);
    // 舞台多余 18px 不拦截点击：唤出判定走主进程轮询（OS 光标 vs 屏缘 6px 热区），
    // 与窗口命中无关；纯点击穿透，下层窗口在贴边条区域正常可交互。
    this.triggerWindow!.setIgnoreMouseEvents(true);
    // did-finish-load 触发时舞台窗口已同步创建（赋值先于 loadURL 返回）；! 收窄闭包内访问
    this.triggerWindow!.webContents.on('did-finish-load', () => {
      // 边样式（className/cavity 渐变方向/光珠锚点）统一由注入脚本的
      // __clipSenseBarApplyEdge 设置（trigger-anim 单一来源，左右贴边同构）
      const tw = this.triggerWindow!;
      const edge = tw._edge || 'right';
      tw.webContents.executeJavaScript(
        `window.__clipSenseBarApplyEdge
           ? window.__clipSenseBarApplyEdge('${edge}')
           : (document.getElementById('bar').className = '${edge}')`
      ).catch(() => {});
    });

    // 开发模式判断：用 app.isPackaged（打包后为 true），不依赖环境变量
    const isDev = !app.isPackaged;
    console.log(`[Spike] 当前环境: ${isDev ? 'development（未打包）' : 'production（已打包）'}`);
    if (isDev) {
      this.mainWindow!.webContents.openDevTools({ mode: 'detach' });
    } else {
      console.log('[Spike] 生产模式，关闭菜单栏');
      this.mainWindow!.removeMenu();
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
    this.tray!.setToolTip('ClipSense');
    this.tray!.setContextMenu(Menu.buildFromTemplate([
      { label: '显示/隐藏', click: () => this.toggleWindow() },
      { label: '检查更新', click: () => this._checkUpdateFromTray() },
      {
        label: '语言 / Language',
        submenu: [
          { label: '中文', type: 'radio', checked: this._getTrayLang() === 'zh-CN', click: () => this._switchLang('zh-CN') },
          { label: 'English', type: 'radio', checked: this._getTrayLang() === 'en', click: () => this._switchLang('en') },
        ],
      },
      {
        label: '关于 ClipSense',
        click: () => this._showAboutDialog(),
      },
      {
        label: '清空历史',
        click: () => {
          this.monitor.clear();
          this.pushHistory();
        },
      },
      {
        label: '固定窗口',
        type: 'checkbox',
        checked: this.edgeDetector ? this.edgeDetector.isPinned : false,
        click: (menuItem: { checked: boolean }) => {
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
      {
        label: '自动打标签',
        submenu: this._buildTagSettingsSubmenu(),
      },
      { type: 'separator' },
      { type: 'separator' },
      { label: '退出', click: () => app.exit(0) },
    ]));
    this.tray!.on('click', () => this.toggleWindow());
  }

  /** 读托盘语言单选态（storage config.lang，缺省 zh-CN） */
  _getTrayLang() {
    // config.lang 在 _readConfig 返回的 Record<string, unknown> 上，运行时恒为语言串
    try { return (this.storage._readConfig().lang as string) || 'zh-CN'; } catch (_) { return 'zh-CN'; }
  }

  /** 托盘切换语言：持久化 + 推送渲染层应用 */
  _switchLang(lang: string): void {
    try { this.storage._writeConfig({ lang }); } catch (_) { /* 持久化失败不阻断 */ }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('lang-changed', lang);
    }
  }

  /** 关于页（2026-09-30）：复用欢迎 overlay（渲染层 about 模式）；窗口不可用回退原生对话框 */
  _showAboutDialog() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('about:show', app.getVersion());
      return;
    }
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'info',
      title: '关于 ClipSense',
      message: `ClipSense v${app.getVersion()}`,
      detail: '剪贴板历史助手\n复制内容自动归档，搜索历史剪贴板，并将选中的内容快速粘贴到原目标窗口。\n\n© 小M & 爪爪 🐾',
      buttons: ['确定'],
    });
  }

  /**
   * 托盘「检查更新」入口：走同一链路，结果用系统通知反馈（简单优先）。
   * 检查 → （有更新）直接后台下载 → 下载完成后再次通知用户手动触发安装
   * 失败路径全部结构化捕获，不允许未处理 rejection。
   */
  async _checkUpdateFromTray() {
    const notify = (msg: string): void => {
      try {
        if (this.tray && !this.tray.isDestroyed()) {
          // BUG1（2026-09-20 实机）+ 二次反馈修复：① 不传 icon → Windows 取托盘
          // 16×16 小图放大 → 模糊；② iconType:'info' → 系统信息图标覆盖自定义
          // icon（custom 才消费 icon 参数）。两项都对齐：高清 logo + iconType:'custom'。
          this.tray.displayBalloon({
            title: 'ClipSense',
            content: msg,
            icon: path.join(__dirname, '../renderer/app-icon.png'),
            iconType: 'custom',
          });
        }
      } catch (err) { /* 通知失败不影响主流程 */ }
      console.log(`[Spike][Updater] ${msg}`);
    };

    notify('正在检查更新…');
    try {
      const r = await updater.checkForUpdate();
      if (!r.ok) { notify(`检查失败：${r.error}`); return; }
      if (!r.hasUpdate) {
        notify(r.reason === 'no-installer-asset'
          ? `发现新版本 v${r.latestVersion}，但安装包尚未发布`
          : `已是最新版本 v${r.currentVersion}`);
        return;
      }
      notify(`发现新版本 v${r.latestVersion}，开始下载…（完成后将自动安装并重启）`);
      // hasUpdate 分支契约保证 downloadUrl 存在（pickInstallerAsset 命中）
      const dl = await updater.downloadUpdate(r.downloadUrl!);
      if (!dl.ok) { notify(`下载失败：${dl.error}`); return; }
      notify(`下载完成，正在静默安装 v${r.latestVersion}…完成后将自动重启`);
      // dl.ok 已短路检查；filePath 在 ok 分支恒存在（DownloadResult 契约）
      const inst = updater.installUpdate(dl.filePath!);
      if (!inst.ok) notify(`安装失败：${inst.error}`);
    } catch (err) {
      notify(`检查更新失败：${(err as Error).message}`);
    }
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

  /**
   * 构建「自动打标签」子菜单（总开关 + 分隔线 + 12 标签三组独立开关，v2 2026-09-10）
   *
   * 分组：基础（链接/邮箱/验证码）｜开发（命令行/堆栈日志/配置/IP 地址/哈希指纹/文件路径）｜安全（敏感信息/漏洞编号）。
   * 语义 = AND(总开关, 单项)；不做动态置灰（避免整菜单重建复杂度）。
   * 关闭语义：仅影响「展示与继续打标」，已打数据保留，重开即恢复。
   * 文案沿托盘既有惯例硬编码中文（托盘当前无 i18n，既有债务，不在本期扩散）。
   */
  _buildTagSettingsSubmenu() {
    const s = this.storage.getTagSettings();
    const apply = (next: IndexTagSettings): void => {
      this.storage.setTagSettings(next);
      this.monitor.setTagOptions(next);
      this.pushHistory();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('tag-settings-updated', next);
      }
    };
    const items = [
      {
        label: '总开关',
        type: 'checkbox',
        checked: s.enabled !== false,
        click: (menuItem: { checked: boolean }) => {
          const cur = this.storage.getTagSettings();
          apply({ ...cur, enabled: menuItem.checked });
        },
      },
      { type: 'separator' },
    ];
    // 标签分组（拍板 #3：平铺 + 分隔线，非二级菜单）。
    // 2026-09-30 通用化扩展：v2 12 类 + v1.0.7 新增 10 类 = 22 类，五组分隔线。
    // ⚠️ 维护提示：新增标签类型时必须同步本清单 + tag-utils.js 的 TAG_PRIORITY
    //   + normalizeEnabled 开关 + i18n 的 tagXxx key（四处，缺一处即托盘/筛选/UI 失联）。
    const tagGroups = [
      [ // 基础（v1 通用类；代码片段为 v1 粗桶，随 v1 标签留在本组）
        { id: 'link', label: '链接' },
        { id: 'email', label: '邮箱' },
        { id: 'otp', label: '验证码' },
        { id: 'snippet', label: '代码片段' },
      ],
      [ // 生活通用（v1.0.7 新增，PRD §2.1）
        { id: 'tracking', label: '快递单号' },
        { id: 'phone', label: '手机号' },
        { id: 'meeting', label: '会议日程' },
        { id: 'todo', label: '待办' },
        { id: 'address', label: '地址' },
      ],
      [ // 开发（结构类，v2 新增除 path 外含 cmd/stack/config/ip/hash）
        { id: 'cmd', label: '命令行' },
        { id: 'stack', label: '堆栈日志' },
        { id: 'config', label: '配置' },
        { id: 'ip', label: 'IP 地址' },
        { id: 'hash', label: '哈希指纹' },
        { id: 'path', label: '文件路径' },
      ],
      [ // 设计与标识（v1.0.7 新增）
        { id: 'uuid', label: 'UUID' },
        { id: 'color', label: '颜色值' },
      ],
      [ // 安全与凭据
        { id: 'sensitive', label: '敏感信息' },
        { id: 'vuln', label: '漏洞编号' },
        { id: 'urlcred', label: '账号凭据' },
        { id: 'bankcard', label: '银行卡' },
        { id: 'idcard', label: '身份证' },
      ],
    ];
    tagGroups.forEach((group, gi) => {
      if (gi > 0) items.push({ type: 'separator' });
      for (const def of group) {
        items.push({
          label: def.label,
          type: 'checkbox',
          checked: !s.tags || s.tags[def.id] !== false,
          click: (menuItem: { checked: boolean }) => {
            const cur = this.storage.getTagSettings();
            apply({ ...cur, tags: { ...cur.tags, [def.id]: menuItem.checked } });
          },
        });
      }
    });
    return items;
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
    // Alt+V 唤出（V = clipboard 语义）
    const ok = globalShortcut.register('Alt+V', () => {
      if (this.edgeDetector) {
        this.edgeDetector.toggle();
        if (this.edgeDetector.isWindowVisible) {
          this.pushHistory();
          // 2026-09-10 焦点模型回切：显式唤出（Alt+V）后面板持键盘焦点——
          // Ctrl+F/打字立即可用；双击粘贴由 PasteBridge 原子恢复目标前台。
          if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.focus();
          // 快捷键弹出可能覆盖鼠标当前位置：重置触发条抑制/悬停状态，
          // 否则弹出位置恰在鼠标覆盖区域时按钮点不动（18:21 实验证实的卡死机制）
          this.edgeDetector.resetMouseStateAfterShortcutShow();
        }
      } else {
        this.toggleWindow();
      }
    });
    console.log(`[Spike] 全局快捷键 Alt+V 注册${ok ? '成功' : '失败'}`);
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
        console.warn(`[Spike] 打开链接失败: ${(err as Error).message} (url=${rawUrl})`);
        return { ok: false, error: (err as Error).message };
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
        console.warn(`[Spike] 打开文件位置失败: ${(err as Error).message} (path=${normalized})`);
        return { ok: false, error: (err as Error).message };
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
          // console.log(`[Spike] getFileIcon 成功: ${filePath}`);
          return icon.toDataURL();
        }
        console.warn(`[Spike] getFileIcon 返回空图标: ${filePath}`);
        return null;
      } catch (err) {
        console.warn(`[Spike] 获取文件图标失败: ${(err as Error).message} (path=${filePath})`);
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

      // 取目标句柄（16:34 根因修复）：双击瞬间重新抓前台；fgNow 被自身/瞬态过滤时
      // 回退 tracked（焦点模型回切后 tracked 由 focus-search 抢焦前 refresh 保持新鲜，
      // 2026-09-11 双击粘贴回归修复）。
      // fgNow=0 是窗口切换真空态（合法瞬态），用 captureForegroundRetry 忙等重试。
      const fgNow = this.pasteBridge ? this.pasteBridge.captureForegroundRetry() : 0;
      const trackedHwnd = this.focusTracker ? this.focusTracker.getHwnd() : 0;
      const restoreHwnd = fgNow > 0 ? fgNow : trackedHwnd;
      console.log(`[Spike] paste target: fgNow=${fgNow} tracked=${trackedHwnd} -> use=${restoreHwnd}`);

      // ① 先粘贴（面板 NOACTIVATE 不抢焦点，目标窗口仍在前台）
      // 初始化顺序保证调用时已创建（早调用与 .js 同点 TypeError）；! 为类型收窄
      let result = this.pasteBridge!.pasteTo(restoreHwnd);
      // CopyQ 同款降级：Ctrl+V 被吞（RDP/远程桌面等场景）时尝试 Shift+Insert。
      if (!result.ok && restoreHwnd && result.error !== 'restore-denied' && result.error !== 'modifiers-held') {
        console.warn(`[Spike] Ctrl+V 失败(${result.error || 'unknown'})，降级 Shift+Insert 重试`);
        result = this.pasteBridge!.pasteTo(restoreHwnd, { key: 'shift-insert' });
      }

      // ② 双击不收面板（用户决策 2026-09-02）：保留面板支持连续操作；
      // 句柄生命周期跟面板走（setOnHidden 时 clear），不随单次粘贴清除。
      // 5 分钟过期由 getHwnd 内部处理；外部窗口切换由 pasteTo 的 IsWindow 校验兜底。
      // 2026-09-10 焦点模型回切：窗口恒为可聚焦，粘贴后不再切回不可聚焦。
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

    // 自动打标签设置（渲染层启动拉取；变更经 tag-settings-updated 广播）
    ipcMain.handle('get-tag-settings', () => this.storage.getTagSettings());

    // ========== 倒计时 ==========

    // 查询当前倒计时状态
    ipcMain.handle('get-countdown', () => {
      return this.edgeDetector ? this.edgeDetector.getCountdown()
        : { isCountingDown: false, remainingMs: null };
    });

    // 搜索框需要键盘焦点。2026-09-10 焦点模型回切：窗口恒为可聚焦，show() 保证
    // 从后台唤起场景的前台激活，focus() 聚焦渲染层视图。
    ipcMain.handle('focus-search', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      // 双击粘贴回归修复（2026-09-11）：show/focus 抢焦前同步刷新粘贴目标。
      // 抢焦后前台变自身窗口，captureForeground 会被过滤，双击时只能回退 tracked；
      // 不在此刷新则搜索/点击交互后 tracked 陈旧或被清空 → 粘贴焦点留在面板。
      if (this.focusTracker) this.focusTracker.refresh();
      this.mainWindow.show();
      this.mainWindow.moveTop();
      this.mainWindow.focus();
      this.mainWindow.webContents.focus();
      // BUG1（2026-09-11 实机）修复：此处不再兜底 setSearchActive(true)——
      // 自「面板任意 pointerdown 都走 focusSearch」（2026-09-10 焦点模型）后，
      // 无条件挂起会把「点击过面板」误标成「搜索输入中」，固定→解锁后
      // _startHideTimer 被 _searchActive 卡死，倒计时永不启动（实机复现 BUG1）。
      // 挂起改由渲染层 searchInput 的 focus 事件统一触发（真实输入框聚焦才挂起）。
      return true;
    });

    // 搜索框失焦：恢复自动隐藏（2026-09-10 焦点模型回切：不再切回不可聚焦——
    // setFocusable(false) 会让下一次 focusSearch 重新走不可靠的激活路径）。
    ipcMain.handle('blur-search', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      // 搜索结束：恢复自动隐藏（与渲染层 blur 事件双保险，18:42）
      if (this.edgeDetector) this.edgeDetector.setSearchActive(false);
      return true;
    });

    // ========== 升级欢迎页（2026-09-30）：版本变化 → 渲染层展示欢迎 overlay ==========
    // 判定：app.getVersion() !== config.lastShownVersion（首次安装/升级均触发）
    // 状态：欢迎展示关闭时渲染层回写 set-welcome-shown，config.lastShownVersion = 当前版本
    const currentVersion = app.getVersion();
    const lastShown = this.storage.getLastShownVersion();
    if (currentVersion !== lastShown) {
      console.log(`[Spike] 检测到版本变化（${lastShown || '首次安装'} → ${currentVersion}），将展示欢迎页`);
    }
    ipcMain.handle('get-welcome-state', () => ({
      shouldShow: app.getVersion() !== this.storage.getLastShownVersion(),
      version: app.getVersion(),
    }));
    ipcMain.handle('set-welcome-shown', () => {
      this.storage.setLastShownVersion(app.getVersion());
      return { ok: true };
    });

    // ========== 语言切换（托盘驱动，2026-09-30 二级菜单取消后迁入托盘） ==========
    // 渲染层 localStorage 不可达（托盘无页面），持久化走 storage 配置（lang 字段）
    ipcMain.handle('get-lang', () => this.storage._readConfig().lang || 'zh-CN');
    ipcMain.handle('set-lang', (event, lang) => {
      if (lang !== 'zh-CN' && lang !== 'en') return { ok: false, error: 'unsupported lang' };
      this.storage._writeConfig({ lang });
      return { ok: true, lang };
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

    // ========== 新条目动画：贴边态触发条脉冲（V1.0.4 零几何变更版，2026-09-17） ==========
    // 触发条物理窗口固定 24px「抽屉舞台」（创建处 width = DRAWER.restWidth + DRAWER.travel）：
    // 抽屉拉出 / 光珠坠入 / 推回全程在窗口表面内以 CSS transform 回放，动画期零 setBounds——
    // transparent 窗口 resize 的 DWM 表面重分配是实机「弹出卡顿 + 闪烁一次」的根因。
    // 命中区与舞台宽度解耦：唤出热区仍按屏缘 6px 锚定判定（edge-detector 轮询），
    // 舞台多余 18px 点击穿透。连续到达时上一轮回放由 __clipSenseBarStop 复位重开。
    // 面板可见时渲染层不会发送此事件；触发条隐藏时仅回放（不可见无视觉副作用）。
    ipcMain.on('window-entry-pulse', () => {
      const tw = this.triggerWindow;
      if (!tw || tw.isDestroyed()) return;
      tw.webContents.executeJavaScript(
        'window.__clipSenseBarPulse && window.__clipSenseBarPulse()'
      ).catch(() => {});
    });


    // ========== 命中偏移诊断（2026-09-08，定位后可移除） ==========
    // 对比三层坐标系：OS 物理光标 → screen API (DIP) → Chromium 输入事件
    // delta 非零 = 某层换算错位；正常时完全静默
    ipcMain.on('diag-hit', (event, d) => {
      try {
        const cursor = screen.getCursorScreenPoint();
        // 与 .js 同语义：null 时同点 TypeError，由本 handler try/catch 兜底
        const b = this.mainWindow!.getBounds();
        const expClientX = cursor.x - b.x;
        const expClientY = cursor.y - b.y;
        const dClientX = d.clientX - expClientX;
        const dClientY = d.clientY - expClientY;
        const dScreenX = d.screenX - cursor.x;
        const dScreenY = d.screenY - cursor.y;
        const dWinX = d.winScreenX - b.x;
        const dWinY = d.winScreenY - b.y;
        if (Math.abs(dClientX) > 1 || Math.abs(dClientY) > 1
          || Math.abs(dScreenX) > 1 || Math.abs(dScreenY) > 1 || Math.abs(dWinX) > 1) {
          const line = `[DiagHit] 偏移! clientΔ=(${dClientX},${dClientY}) screenΔ=(${dScreenX},${dScreenY}) winΔ=(${dWinX},${dWinY}) `
            + `client=(${d.clientX},${d.clientY}) cursorMain=(${cursor.x},${cursor.y}) winBounds=(${b.x},${b.y},${b.width}x${b.height}) `
            + `dpr=${d.dpr} el=${d.el}`;
          console.log(line);
          event.sender.executeJavaScript(`console.log(${JSON.stringify(line)})`).catch(() => {});
        }
      } catch (err) { /* 诊断失败不影响功能 */ }
    });

    // 搜索输入期间挂起自动隐藏（键盘活跃优先于鼠标离开，18:42）
    ipcMain.on('set-search-active', (event, active) => {
      if (this.edgeDetector) this.edgeDetector.setSearchActive(active);
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

    // ========== 轻量升级链路（2026-09-20，自研：不引 electron-updater） ==========

    // 检测新版本（GitHub Releases latest）
    ipcMain.handle('update-check', async () => {
      try {
        // 总超时守卫（2026-09-30）：403 降级链为串行请求（API + Atom + 探测），
        // 极端网络下最坏可累积数分钟——60s 封顶返回结构化错误，避免菜单项「检查中…」久挂。
        const TIMEOUT_MS = 60000;
        return await Promise.race([
          updater.checkForUpdate(),
          new Promise((resolve) => setTimeout(
            () => resolve({ ok: false, error: '检查超时（60s），请检查网络后重试' }),
            TIMEOUT_MS
          )),
        ]);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // 下载升级包（渲染层传 checkForUpdate 返回的 downloadUrl；进度经
    // update-download-progress 推给渲染层）
    ipcMain.handle('update-download', async (event, downloadUrl) => {
      const sender = event.sender;
      const sendProgress = (p: { receivedBytes: number; totalBytes: number; percent: number }): void => {
        if (sender && !sender.isDestroyed()) {
          try { sender.send('update-download-progress', p); } catch (err) { /* 渲染层已关 */ }
        }
      };
      try {
        return await updater.downloadUpdate(downloadUrl, (p) => sendProgress(p));
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // 拉起安装包并退出应用
    ipcMain.handle('update-install', async (event, filePath) => {
      try {
        return updater.installUpdate(filePath);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
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
  _applyNoActivate(win: { getNativeWindowHandle: () => Buffer }) {
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
      console.warn('[Spike] WS_EX_NOACTIVATE 应用失败:', (err as Error).message);
    }
  }

  /**
   * 诊断版 capture：抓前台现场（hwnd/pid/class）+ 过滤判定，结果推送到渲染层 console。
   * 目标窗口可用则记录，否则清空（宁可无目标不贴错）。
   */
  _diagCapture() {
    const r: IndexCaptureVerbose = this.pasteBridge ? this.pasteBridge.captureForegroundVerbose() : { hwnd: 0, reason: 'no-bridge' };
    // 诊断直写 focusTracker 私有字段（既有债务，类型面经 FocusTrackerDiagnostics 收口）
    const ft = this.focusTracker!;
    if (r.hwnd > 0) {
      ft._targetHwnd = r.hwnd;
      ft._trackedAt = Date.now();
    } else {
      ft._targetHwnd = 0;
      ft._trackedAt = 0;
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
    // createWindow() 已同步创建两窗口；! 为类型收窄（运行时恒非空）
    this.edgeDetector = new EdgeDetector(this.mainWindow!, this.triggerWindow!);
    this.edgeDetector.setOnHidden(() => {
      // 面板收起后句柄生命周期结束：下次唤出时重新 capture。
      // （双击不收面板，同一显示周期内句柄持续有效，支持连续粘贴多条目）
      this.focusTracker!.clear(); // 回调触发时 init 已完成创建（运行时恒非空）
    });
    // Ditto/CopyQ 模型：面板显示前记录原前台窗口，双击粘贴时由 PasteBridge 原子恢复+注入。
    // FFI 同步抓取（微秒级），无 PS 冷启动，消除「唤出后立即双击」的时序竞争。
    this.pasteBridge = new PasteBridge();
    // 诊断直写面经结构接口收口（FocusTracker 私有字段外部直写为既有债务，运行时零改动）
    this.focusTracker = new FocusTracker(this.pasteBridge) as unknown as IndexFocusTrackerApi;
    // 窗口可见性权威推送（2026-09-30）：backgroundThrottling:false（弹出闪烁修复引入）
    // 的副作用是 document.visibilityState 恒 'visible'（窗口隐藏也不变），渲染层贴边
    // 动画 gate 依赖 visibilityState==='hidden' 判定 → 永不进入贴边态，动画播进隐藏
    // 窗口（不可见）且 onPulse 不触发。改以主进程 isWindowVisible 为唯一权威。
    this.edgeDetector.setOnVisibilityChanged((v) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('window:visibility', v);
      }
    });
    this.edgeDetector.setOnShown(() => {
      // capture 主进程日志用户看不到；把每次 capture 的判定结果推送到渲染层 console
      this._diagCapture();
    });
    this.edgeDetector.start();
    // 初次显示也使用非激活方式，并在抢焦点前记录原目标窗口。
    this.edgeDetector.forceShow();
    // 2026-09-10 焦点模型回切：窗口恒为可聚焦（原 setFocusable(false) 移除）。

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
      console.log(`[Spike] 剪贴板变化: ${item!.preview}`); // changed=true 分支 item 恒非空（tick 契约）
      this.pushHistory();
    });

    // 启动同步：恢复历史后，立即检查系统剪贴板，把未同步的新数据同步进来
    const syncResult = this.monitor.syncNow();
    if (syncResult.changed) {
      console.log(`[Spike] 启动同步：已将系统剪贴板内容归档: ${syncResult.item!.preview}`); // changed 分支 item 恒非空
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

// 单实例锁（2026-09-11 22:24）：双实例并行会争抢全局快捷键与剪贴板监听，
// 粘贴目标跟踪互相污染（实测 21:22 起双实例并行）。抢不到锁 = 已有实例在跑，直接退出。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 重复启动尝试：唤出已有实例的面板（未初始化完成时静默）
    if (spikeApp.mainWindow && !spikeApp.mainWindow.isDestroyed()) {
      spikeApp.mainWindow.show();
    }
  });
  app.whenReady().then(async () => {
    await spikeApp.init();
  });
}

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

export = ClipboardSpikeApp;
