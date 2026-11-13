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

/** NativeImage 最小面（临时验证截图用，2026-10-14） */
interface IndexNativeImage {
  toPNG: () => Buffer;
  getSize: () => { width: number; height: number };
}

/** WebContents 消费面（index.js 用到的子集） */
interface IndexWebContents {
  send: (channel: string, ...args: unknown[]) => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  /** EdgeDetector 注入合成 mousemove 用（其 EdgeWebContents 契约要求此成员） */
  sendInputEvent: (input: { type: string; x: number; y: number }) => void;
  focus: () => void;
  openDevTools: (options?: { mode?: string }) => void;
  closeDevTools: () => void;
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  isDestroyed: () => boolean;
  /** 临时验证（2026-10-14 UI 验收）：菜单打开态渲染内容截图 */
  capturePage: (opts?: { x?: number; y?: number }) => Promise<IndexNativeImage>;
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
  isFocused: () => boolean;
  blur: () => void;
  setVisibleOnAllWorkspaces: (visible: boolean, options?: { visibleOnFullScreen?: boolean }) => void;
  setAlwaysOnTop: (flag: boolean, level?: string) => void;
  removeMenu: () => void;
  loadFile: (filePath: string) => unknown;
  loadURL: (url: string) => unknown;
  destroy: () => void;
  webContents: IndexWebContents;
  /** 原生 HWND（Z 序回退抓粘贴目标用，win x64 为 8 字节指针 Buffer） */
  getNativeWindowHandle: () => Buffer;}

/** 触发条舞台窗口（主窗口面 + 贴边标记动态写入） */
interface IndexTriggerWindow extends IndexMainWindow {
  _edge?: 'left' | 'right';
}

/** 桌宠舞台窗口（P0 spike）：主窗口面 + forward 语义的穿透开关 + getPosition（拖拽/持久化） */
interface PetStageWindow {
  isDestroyed: () => boolean;
  hide: () => void;
  showInactive: () => void;
  isVisible: () => boolean;
  moveTop: () => void;
  setAlwaysOnTop: (flag: boolean, level?: 'screen-saver') => void;
  isAlwaysOnTop: () => boolean;
  getNativeWindowHandle: () => Buffer;
  getBounds: () => { x: number; y: number; width: number; height: number };
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  getPosition: () => number[];
  setPosition: (x: number, y: number) => void;
  setIgnoreMouseEvents: (ignore: boolean, opts?: { forward?: boolean }) => void;
  loadFile: (filePath: string) => unknown;
  destroy: () => void;
  webContents: IndexWebContents;
}

/** 托盘消费面 */
interface IndexTray {
  setToolTip: (tip: string) => void;
  setContextMenu: (menu: unknown) => void;
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  isDestroyed: () => boolean;
  destroy: () => void;
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
  getAltPassTipShown: () => boolean;
  setAltPassTipShown: () => void;
  getPetPosition: () => { x: number; y: number } | null;
  setPetPosition: (pos: { x: number; y: number }) => void;
  getPetScale: () => number;
  setPetScale: (scale: number) => void;
  isEncryptionAvailable: () => boolean;
  getCustomRules: () => Array<{ id: string; name: string; pattern: string; enabled: boolean; createdAt: number }>;
  setCustomRules: (rules: Array<{ id: string; name: string; pattern: string; enabled: boolean; createdAt: number }>) => void;
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

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen, shell, powerMonitor, dialog } = require('electron') as {
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
  powerMonitor: any;
  dialog: any;
};
// 置顶保活配套（2026-10-14，对照网易云桌宠取证）：禁用 Windows 遮挡计算，防止置顶
// 透明小窗被 Chromium 判「被完全遮挡」后停渲染/降帧（桌宠动画莫名停帧第一嫌疑）。
// 必须先于 app ready 注册；未知 feature 名被 Chromium 静默忽略，无副作用。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
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
const crashDump = require('./crash-dump') as typeof import('./crash-dump');
const { normalizeScale, normalizeHideMode, buildPetStageBounds, clampPetPosition, computePetIgnore } = require('./pet-manager') as typeof import('./pet-manager');
const StatsModule = require('./stats') as typeof import('./stats');

// ==================== 修饰键键态探针（2026-10-13，Alt 按住穿透） ====================
// 面板 WS_EX_NOACTIVATE 不夺焦：用户按 Alt 时系统焦点在目标应用，渲染层收不到
// keydown/keyup（GetKeyState 也只反映本线程队列）——必须 GetAsyncKeyState 全局态。
// koffi 惰性绑定：首次探针调用才 require；绑定失败/非 win32 恒 false = 功能自动禁用。
// VK_MENU(0x12) = Alt：左右 Alt 共享同一虚键码，一次查询覆盖两键。
const VK_MENU = 0x12;
let _modUser32: { GetAsyncKeyState: (vk: number) => number } | null = null;
let _modBindLogged = false; // 一次性诊断：绑定失败静默 = 整条链路死掉且无提示
let _lastRawMod: boolean | null = null; // 原始键态变化检测（仅在变化拍落盘，不刷屏）

/** 取证日志（§5-③）：console 在打包版/窗口隐藏期不可见，落盘 userData 逐站编号 */
function _modDiag(line: string): void {
  try {
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron') as { app?: { getPath: (p: string) => string } };
    if (!app) return;
    const file = path.join(app.getPath('userData'), 'modifier-passthrough-diag.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch (err) { /* 诊断失败不影响功能 */ }
}

function _isAltPhysicallyDown(): boolean {
  if (process.platform === 'darwin') return _isMacOptionDown();
  if (process.platform !== 'win32') return false;
  try {
    if (!_modUser32) {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      _modUser32 = {
        GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int nVirtKey)'),
      };
      console.log('[AltPass] user32 探针绑定成功（GetAsyncKeyState/VK_MENU）');
      _modDiag('[S1] koffi user32 绑定成功（VK_MENU/Alt）');
    }
    // int16 → 无符号 → 最高位 = 物理按下（paste-bridge 同款判定位）
    const raw = _modUser32.GetAsyncKeyState(VK_MENU) & 0xffff;
    const down = (raw & 0x8000) !== 0;
    if (down !== _lastRawMod) {
      _lastRawMod = down;
      _modDiag(`[S2] GetAsyncKeyState 原始值变化 → down=${down} (raw=0x${raw.toString(16)})`);
    }
    return down;
  } catch (err) {
    if (!_modBindLogged) {
      _modBindLogged = true;
      console.log('[AltPass] 探针绑定失败，穿透禁用:', err);
      _modDiag(`[S1] 绑定失败: ${(err as Error).message}`);
    }
    return false;
  }
}
// macOS：CGEventSourceFlagsState 读取 Option 物理键态（读取不需要辅助功能授权）
let _modMacFlags: (() => number) | null = null;
let _modMacBindLogged = false;
function _isMacOptionDown(): boolean {
  try {
    if (!_modMacFlags) {
      const koffi = require('koffi');
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      const fn = cg.func('uint64 CGEventSourceFlagsState(int32 stateID)') as (state: number) => number;
      _modMacFlags = () => fn(0);
      console.log('[AltPass] macOS CGEventSourceFlagsState 绑定成功（Option 键态）');
      _modDiag('[S1] macOS CGEventSourceFlagsState 绑定成功');
    }
    // kCGEventFlagMaskAlternate = 0x00080000（左/右 Option 同位）
    const down = (_modMacFlags() & 0x00080000) !== 0;
    if (down !== _lastRawMod) {
      _lastRawMod = down;
      _modDiag(`[S2] CGEventSourceFlagsState 变化 → down=${down}`);
    }
    return down;
  } catch (err) {
    if (!_modMacBindLogged) {
      _modMacBindLogged = true;
      console.log('[AltPass] macOS 键态探针绑定失败，穿透禁用:', (err as Error).message);
      _modDiag(`[S1] macOS 绑定失败: ${(err as Error).message}`);
    }
    return false;
  }
}

// 尽早启动 Crashpad：覆盖主/渲染/GPU/native 崩溃，本地 .dmp 不上传（先于 app ready）
crashDump.startCrashReporter();

class ClipboardSpikeApp {
  mainWindow: IndexMainWindow | null;
  triggerWindow: IndexTriggerWindow | null = null; // .js 构造器不初始化（undefined）；null 同 falsy 语义
  tray: IndexTray | null;
  storage: IndexStorageApi;
  monitor: ClipboardMonitorInstance;
  pasteBridge: PasteBridgeInstance | null = null;   // init() 创建（.js 为 undefined，null 同 falsy 语义）
  focusTracker: IndexFocusTrackerApi | null = null; // 同上
  edgeDetector: EdgeDetectorInstance | null;
  /** macOS 辅助功能引导只弹一次（避免连点重复弹窗） */
  _accessibilityPrompted = false;
  // 桌宠（P0 spike，2026-10-13）：舞台窗口与模式状态（_applyHideMode 驱动，PRD-桌宠系统 V0.2）
  petStage: PetStageWindow | null = null;
  _petModeOn: boolean = false;
  _petPaintReady: boolean = false; // 渲染层双 rAF 首帧确认（paint-verified show，09-17 模式继承）
  _petShowFallback: ReturnType<typeof setTimeout> | null = null; // 确认链异常兑底直显定时器
  _petDragOffset: { dx: number; dy: number } | null = null;
  _petAltActive: boolean = false;
  _petLastIgnoreApplied: boolean | null = null;
  /** 宠物本体矩形（渲染层上报，窗口相对 DIP；2026-10-23 命中穿透 v2） */
  _petBodyRect: { x: number; y: number; w: number; h: number } | null = null;
  _petHitPollId: ReturnType<typeof setInterval> | null = null;   // Alt 穿透态（edge-detector 边沿回调写入）
  _petCursorOnModel: boolean = false; // 最近一次轮廓命中上报（未命中前默认 false = 忽略鼠标）
  _petScale: number = 1;            // 桌宠缩放系数（2026-10-14 大小可调：滚轮/托盘，持久化）
  _petCtxSaved: { x: number; y: number; width: number; height: number } | null = null; // 右键菜单扩窗前的舞台 bounds
  _trayScaleNearest: number = -1; // 托盘单选态最近档位缓存（滚轮步进防托盘闪烁，2026-11-04）
  _orphanNudgeAt: number = 0; // orphan-up nudge 冷却锚（2026-11-05：菜单会话连环触发限频）
  _petStageCreatedOnce: boolean = false; // 舞台是否曾创建（区分启动首次 vs 运行期切 pet，2026-11-04 Bug1）
  statsStore: InstanceType<typeof StatsModule.StatsStore> | null = null; // 统计与等级模块（2026-11-05 spec）
  _petDebugMode: boolean = false; // 桌宠调试模式（DevTools 开关，config 持久化）
  /** 点击桌宠是否同时唤出主面板（2026-11-13 动作/窗口解耦开关）。
   *  缺省 false：单击桌宠只播反应动作，不弹主面板窗口。显式入口（Alt+V / 托盘 /
   *  贴边热区 / 右键「显示面板」）不受此开关影响；托盘可重新勾选恢复旧行为。 */
  _petClickSummon: boolean = false;
  _petCtxOpen: boolean = false;            // 右键菜单打开中（全窗可交互，渲染层 mouseleave 关闭）
  _petCtxPollId: ReturnType<typeof setInterval> | null = null;
  _petCtxHold: boolean = false; // 临时验证用：true 时失焦轮询暂停
  _altRescueId: ReturnType<typeof setInterval> | null = null; // Alt 残留自愈轮询（2026-10-15）
  _petCtxDir: { dirH: 'l' | 'r'; dirV: 'u' | 'd' } = { dirH: 'l', dirV: 'u' }; // 菜单打开期间的固定边方向（2026-10-15）

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
    // 自定义标签规则注入（标签体系二期，2026-10-11）
    this.monitor.setCustomRules(this.storage.getCustomRules());
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
    // macOS：跨 Space 常驻 + 浮动层级置顶（全屏应用之上仍可唤出；不占 Dock/Cmd+Tab）
    if (process.platform === 'darwin') {
      this.mainWindow!.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.mainWindow!.setAlwaysOnTop(true, 'floating');
    }
    // 2026-09-10 焦点模型回切：不再强制 NOACTIVATE——实机三轮验证不夺焦模型
    // 与搜索键盘交互（Ctrl+F/打字/输入法）根本冲突。双击粘贴的焦点恢复由
    // PasteBridge 原子恢复+注入承担。如需回滚：恢复下一行调用即可。
    // this._applyNoActivate(this.mainWindow);

    // 独立的边缘触发条窗口。Windows: 24px 抽屉舞台；macOS(2026-11-11 原生化):
    // 14px 舞台(把手 4 + 边距 2 + 脉冲扩宽余量 8),样式/脚本/窗口参数按平台分支。
    const isMacBar = process.platform === 'darwin';
    const MAC_STAGE_WIDTH = 26; // 胶囊 18 + 边距 4 + 悬停退让 2 + 光晕余量 2
    this.triggerWindow = new BrowserWindow({
      // V1.0.4 抽屉舞台（2026-09-17 动画卡顿+闪烁优化）：物理窗口固定 24px
      // = DRAWER.restWidth(6) + DRAWER.travel(18)，动画全程零 resize——
      // transparent 窗口 setBounds 触发 DWM 表面重分配，是实机「弹出动画
      // 卡顿 + 闪烁一次」的根因。多余 18px 点击穿透（见下方 setIgnoreMouseEvents）。
      width: isMacBar ? MAC_STAGE_WIDTH : DRAWER.restWidth + DRAWER.travel,
      height: 56,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      // macOS（2026-11-11 实机修复「小白框」）：focusable:false 在 darwin 走
      // NSPanel 路径，透明舞台在 NSPanel 上渲染白底。改普通窗口：showInactive
      // 不夺焦 + setIgnoreMouseEvents(true) 点击穿透，行为等价；显式关阴影
      // 与系统圆角。Windows 保持 focusable:false 不变（抽屉舞台焦点模型）。
      focusable: !isMacBar,
      ...(isMacBar ? { hasShadow: false, roundedCorners: false } : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    // 贴边条平台化样式与脚本（2026-11-11 mac 原生化）：mac 走低饱和半透明把手 +
    // 呼吸脉冲；Windows 保留原渐变辉光条与真抽屉动画（buildTriggerScript 原样消费）。
    // 注入字符串约束同 trigger-anim：不得含反引号 / ${（宿主为模板字面量）。
    const barCss = isMacBar
      ? `/* macOS 原生克制风（2026-11-11）：低饱和半透明把手，热区 hover 点亮加宽；
   新内容动画走呼吸脉冲（见脚本覆盖段），真抽屉视觉元素隐藏。 */
#cavity, #bead { display:none; }
#bar { position:fixed; top:6px; bottom:6px; right:4px; left:auto; width:18px; border-radius:9px; background:rgba(255,255,255,.55); box-shadow:0 1px 4px rgba(0,0,0,.12), inset 0 0 0 .5px rgba(255,255,255,.6); opacity:.18; display:flex; align-items:center; justify-content:center; transform-origin:right center; transition:opacity .25s ease, transform .25s ease, box-shadow .25s ease, background .25s ease; will-change:opacity, transform; }
#bar::after { content:'›'; font-size:15px; font-weight:600; color:rgba(60,60,67,.45); margin-right:1px; transition:color .22s ease, transform .22s ease; }
#bar.left::after { content:'‹'; margin-right:0; margin-left:1px; }
#bar.right { left:auto; right:4px; }
#bar.left { right:auto; left:4px; }
#bar.hover { opacity:1; background:rgba(255,255,255,.9); transform:translateX(-2px); box-shadow:0 2px 8px rgba(0,0,0,.16), inset 0 0 0 .5px rgba(255,255,255,.8); }
#bar.hover::after { color:rgba(94,92,230,.9); transform:translateX(-1px); }
@keyframes clipSenseBarPulse { 0% { opacity:.18; } 16% { opacity:1; background:rgba(255,255,255,.9); box-shadow:0 0 0 2px rgba(94,92,230,.35), 0 2px 10px rgba(94,92,230,.25); } 50% { opacity:.9; box-shadow:0 0 0 1.5px rgba(94,92,230,.22), 0 2px 8px rgba(94,92,230,.15); } 100% { opacity:.18; } }
#bar.pulse { animation:clipSenseBarPulse 1.1s ease; }
@keyframes clipSenseChevPulse { 0%,100% { transform:translateX(0); color:rgba(60,60,67,.45); } 16% { transform:translateX(-4px); color:rgba(94,92,230,.95); } 50% { transform:translateX(-1px); color:rgba(94,92,230,.7); } }
#bar.pulse::after { animation:clipSenseChevPulse 1.1s ease; }`
      : `#bar { position:fixed; top:0; bottom:0; left:0; width:6px; background:linear-gradient(180deg,#a29bfe,#6c5ce7); border-radius:0 6px 6px 0; box-shadow:0 0 8px rgba(108,92,231,.8); }
#bar.right { left:auto; right:0; border-radius:6px 0 0 6px; transform-origin:right center; }
#bar.left { left:0; border-radius:0 6px 6px 0; transform-origin:left center; }`;
    const barScriptOverride = isMacBar
      ? `/* macOS 原生化覆盖：新内容到达 = 呼吸亮起（替代真抽屉动画）+ 热区 hover 反馈。
   协议不变：__clipSenseBarPulse() 无参、__clipSenseBarStop 复位、连续触发重放。 */
window.__clipSenseBarPulse = function () {
  var bar = document.getElementById('bar');
  if (!bar) return;
  if (window.__clipSenseBarStop) window.__clipSenseBarStop();
  bar.classList.remove('pulse');
  void bar.offsetWidth;
  bar.classList.add('pulse');
  window.__clipSenseBarStop = function () {
    bar.classList.remove('pulse');
    window.__clipSenseBarStop = null;
  };
};
window.__clipSenseBarHover = function (on) {
  var bar = document.getElementById('bar');
  if (bar) bar.classList.toggle('hover', !!on);
};`
      : '';
    this.triggerWindow!.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html><html><head><style>
        html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
        ${barCss}
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
        ${barScriptOverride}
      </script></body></html>
    `)}`);
    // 舞台多余 18px 不拦截点击：唤出判定走主进程轮询（OS 光标 vs 屏缘 6px 热区），
    // 与窗口命中无关；纯点击穿透，下层窗口在贴边条区域正常可交互。
    if (process.platform === 'darwin') {
      this.triggerWindow!.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.triggerWindow!.setAlwaysOnTop(true, 'floating');
    }
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
      // npm start 不自动开 DevTools（2026-11-05 小M：调试模式通过托盘/F12 手动切换）
      console.log('[Spike] dev mode: use F12 or tray toggle for DevTools');
    } else {
      console.log('[Spike] 生产模式，关闭菜单栏');
      this.mainWindow!.removeMenu();
    }
  }

  initTray() {
    // 幂等守卫（2026-10-13 桌宠模式引入重建）：模式切换刷新单选态需重建菜单，
    // 销毁旧托盘防图标泄漏（原实现一次性创建，重建语义随桌宠功能引入）
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    // 托盘图标（16x16，Windows 推荐；@2x 供高分屏）
    const iconPath = path.join(__dirname, '../renderer/tray-icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'win32') {
      icon = icon.resize({ width: 16, height: 16 });
    } else if (process.platform === 'darwin') {
      // macOS 菜单栏：18×18（系统按 Retina 缩放；彩色图标不启用 template 模式）
      icon = icon.resize({ width: 18, height: 18 });
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
        label: '隐藏模式',
        submenu: [
          { label: '桌宠（实验）', type: 'radio', checked: this._getHideMode() === 'pet', click: () => this._setHideMode('pet') },
          { label: '贴边', type: 'radio', checked: this._getHideMode() === 'edge', click: () => this._setHideMode('edge') },
          { label: '纯隐藏', type: 'radio', checked: this._getHideMode() === 'hidden', click: () => this._setHideMode('hidden') },
        ],
      },
      {
        // 动作/窗口解耦（2026-11-13）：关掉后单击桌宠只播反应动作，不再弹出主面板窗口
        label: '点击桌宠时唤出面板',
        type: 'checkbox',
        checked: this._petClickSummon,
        click: (menuItem: { checked: boolean }) => {
          this._petClickSummon = menuItem.checked;
          try { this.storage._writeConfig({ petClickSummon: menuItem.checked }); } catch (_) { }
          _modDiag('[Pet] petClickSummon=' + menuItem.checked);
        },
      },
      {
        label: '桌宠大小',
        submenu: [
          { label: '小（0.7×）', type: 'radio', checked: Math.abs(this._getPetScale() - 0.7) < 0.05, click: () => this._setPetScalePreset(0.7) },
          { label: '标准（1×）', type: 'radio', checked: Math.abs(this._getPetScale() - 1) < 0.05, click: () => this._setPetScalePreset(1) },
          { label: '大（1.3×）', type: 'radio', checked: Math.abs(this._getPetScale() - 1.3) < 0.05, click: () => this._setPetScalePreset(1.3) },
          { label: '特大（1.6×）', type: 'radio', checked: Math.abs(this._getPetScale() - 1.6) < 0.05, click: () => this._setPetScalePreset(1.6) },
          { label: '巨大（2×）', type: 'radio', checked: Math.abs(this._getPetScale() - 2) < 0.05, click: () => this._setPetScalePreset(2) },
        ],
      },
      {
        // P-B 形象选择器（2026-11-04 市场调研裁决添加）：models/ 目录枚举，
        // 热切换（重建舞台走既有回退链，加载失败自动回 hiyori）
        label: '桌宠形象',
        submenu: this._listPetModels().map((m) => ({
          label: m,
          type: 'radio' as const,
          checked: this._getPetModel() === m,
          click: () => this._setPetModel(m),
        })),
      },
      {
        // 调试模式（2026-11-05 小M「调试模式不生效」修复）：petStage DevTools 手动开关——
        // dev 模式自动开（did-finish-load 路径），打包版/生产模式下经此开关排查桌宠渲染问题
        // 2026-11-12 小M：调试模式仅限开发（未打包）——打包版不展示（发布包不带调试入口）
        label: '调试模式（主面板 DevTools）',
        visible: !app.isPackaged,
        type: 'checkbox',
        checked: this._petDebugMode,
        click: (menuItem: { checked: boolean }) => {
          this._petDebugMode = menuItem.checked;
          try { this.storage._writeConfig({ petDebugMode: menuItem.checked }); } catch (_) { }
          const mw = this.mainWindow;
          if (mw && !mw.isDestroyed()) {
            if (menuItem.checked) {
              mw.webContents.openDevTools({ mode: 'detach' });
              _modDiag('[MainPanel] DevTools opened (tray debug toggle)');
            }
            else {
              try { mw.webContents.closeDevTools(); } catch (_) { }
              _modDiag('[MainPanel] DevTools closed (tray debug toggle)');
            }
          }
        },
      },
      {
        // 2026-11-12 小M：调试模式仅限开发（未打包）——打包版不展示（发布包不带调试入口）
        label: '调试模式（桌宠 DevTools）',
        visible: !app.isPackaged,
        type: 'checkbox',
        checked: this._petDebugMode,
        click: (menuItem: { checked: boolean }) => {
          this._petDebugMode = menuItem.checked;
          // 窗口弹出治理（2026-11-13）：旧实现漏写回 config，取消勾选后舞台重载
          // 仍会按 config.petDebugMode=true 自动 openDevTools → 又跳出一个窗口。
          try { this.storage._writeConfig({ petDebugMode: menuItem.checked }); } catch (_) { }
          const w = this.petStage;
          if (w && !w.isDestroyed()) {
            if (menuItem.checked) {
              w.webContents.openDevTools({ mode: 'detach' });
              _modDiag('[PetStage] DevTools opened (tray debug toggle)');
            } else {
              try { w.webContents.closeDevTools(); } catch (_) {}
              _modDiag('[PetStage] DevTools closed (tray debug toggle)');
            }
          }
        },
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
        label: '穿透透明度',
        submenu: this._buildPassthroughOpacitySubmenu(),
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
    // macOS：setContextMenu 后左键单击即弹出菜单（原生行为），再绑 toggle 会同时
    // 开关面板，语义冲突；因此仅在 Windows/Linux 上保留左键切换面板。
    if (process.platform !== 'darwin') {
      this.tray!.on('click', () => this.toggleWindow());
    }
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

  // ==================== 桌宠模式（P0 spike，2026-10-13，PRD-桌宠系统 V0.2） ====================

  /** 隐藏模式（决策 1：缺省 edge 不惊扰存量用户；旧配置无此键同样回落 edge） */
  _getHideMode(): 'pet' | 'edge' | 'hidden' {
    try { return normalizeHideMode(this.storage._readConfig().hideMode); } catch (_) { return 'edge'; }
  }

  /** 切换隐藏模式：持久化 → 应用 → 重建托盘单选态 */
  _setHideMode(mode: 'pet' | 'edge' | 'hidden'): void {
    try { this.storage._writeConfig({ hideMode: mode }); } catch (_) { /* 持久化失败不阻断切换 */ }
    this._applyHideMode();
    this.initTray(); // 重建单选态（幂等守卫已内置，先 destroy 旧托盘）
  }

  // ==================== 桌宠大小可调（2026-10-14）：滚轮 + 托盘档位 ====================

  /** 读缩放系数（storage 缺省 1，normalize 钳入档位边界） */
  _getPetScale(): number {
    try { return normalizeScale(this.storage.getPetScale()); } catch (_) { return 1; }
  }

  /** 设置缩放：持久化 → 重设舞台尺寸（底边锚定，防缩放时“脚下打滑”）→ 推送渲染层 */
  _setPetScale(scale: number): void {
    this._petScale = normalizeScale(scale);
    try { this.storage.setPetScale(this._petScale); } catch (_) { /* 持久化失败不影响当次生效 */ }
    // 窗口随缩放长大（2026-11-04 显示不全修复）：220 固定窗口在大档裁掉模型头顶
    //（小M 截图实证）。底边锚定：getBounds 底边 = y + h 保持不动，窗口向上生长。
    const win = this.petStage;
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      this._setPetBoundsAnchored(b.x, b.y + b.height);
    } catch (_) { /* 销毁竞态 */ }
    try { win.webContents.send('pet:scale', this._petScale); } catch (_) { /* 销毁竞态 */ }
    // 托盘闪烁修复（2026-11-04 小M）：滚轮连续步进（step 0.06）逐档 initTray 重建 =
    // 任务栏托盘图标持续闪烁。托盘 radio 视觉只在「最近档位」变化时才改变——
    // 仅跨档时重建；同带内静默（持久化照旧）。
    const presets = [0.7, 1, 1.3, 1.6, 2];
    const nearest = presets.reduce((a, b) => (Math.abs(b - this._petScale) < Math.abs(a - this._petScale) ? b : a));
    if (nearest !== this._trayScaleNearest) {
      this._trayScaleNearest = nearest;
      this.initTray(); // 重建单选态（仅跨档时）
    }
  }

  /** 托盘档位入口（离散档，直观可逆） */
  _setPetScalePreset(v: number): void {
    this._setPetScale(v);
  }

  /**
   * 应用隐藏模式（幂等，可重复调用）：桌宠 ⟷ 贴边/纯隐藏互斥切换。
   * 轮询恒运行（Alt 探针 tick/面板自动隐藏依赖）；模式只改变「热区唤出/贴边条回归」。
   */
  _applyHideMode(): void {
    const mode = this._getHideMode();
    this._petModeOn = mode === 'pet';
    const ed = this.edgeDetector;
    if (!ed) return; // init 早于 edgeDetector 创建时不会发生（调用点在 start() 后）
    ed.setMode(mode);
    ed.setTriggerSuppressed(mode !== 'edge');
    if (mode === 'pet') {
      // 启动首次（舞台从未创建）vs 运行期切换（舞台有过）——Bug1 根因修正
      // （2026-11-04）：原实现启动时 !wasPet 分支无条件 hide 主面板，把
      // 「启动优先展示主面板」压掉，且 defer 判定读到已 hide 面板恒不生效。
      if (!this._petStageCreatedOnce) {
        // 启动首次进入 pet 模式：优先展示主面板（小M 需求），桌宠延迟登场——
        // 面板收起（setOnHidden）时经补口首次创建舞台
        ed.notifyExternalHide(); // 状态对账（面板将走 forceShow 正常显示周期）
        ed.forceShow();
        console.log('[Pet] 启动首次 → 优先主面板，桌宠延迟登场（收起后创建）');
        return;
      }
      // 运行期切换到 pet：收面板 + 收贴边条，桌宠立即接管（原语义保留）
      ed.notifyExternalHide();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.hide();
      if (this.triggerWindow && !this.triggerWindow.isDestroyed()) this.triggerWindow.hide();
      this._createPetStage();
    } else {
      this._destroyPetStage();
      if (mode === 'edge') {
        // 贴边回归：面板显式唤出一次 → 鼠标离开自动隐藏 → 隐藏动画恢复贴边条
        //（_finishHideAnimation 的 suppressed 门已解除，贴边条自然回归）
        ed.forceShow();
      } else {
        // 纯隐藏：全收，仅 Alt+V/托盘 toggle 显式唤出
        ed.notifyExternalHide(); // 同上状态对账
        if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.hide();
        if (this.triggerWindow && !this.triggerWindow.isDestroyed()) this.triggerWindow.hide();
      }
    }
    console.log(`[Pet] 隐藏模式 → ${mode}`);
  }

  /** 创建桌宠舞台（幂等）：loadFile pet-stage.html → did-finish-load 后定位+等待首帧 */
  _createPetStage(): void {
    this._petStageCreatedOnce = true; // Bug1：启动/运行期分界的里程碑
    if (this.petStage && !this.petStage.isDestroyed()) {
      this._positionAndShowPet();
      return;
    }
    const win = new BrowserWindow({
      width: 220,
      height: 220,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      focusable: false, // 全程不夺焦（focus-tracker 链路安全）
      webPreferences: {
        // 卡顿修复（2026-10-29）：永不夺焦窗口在部分场景被判后台 → rAF/定时器节流；
        // 与离线渲染探针同款关闭（探针 main.js 早已验证 backgroundThrottling 必要性）
        backgroundThrottling: false,
        // petStage 需 require('three')（CJS 产物）+ ipcRenderer：直开 node 集成，
        // 舞台加载的是仓库内置页面，无远程内容（PRD §2.1 本地依赖策略）
        nodeIntegration: true,
        contextIsolation: false,
        // 必须显式关 sandbox：Electron 20+ 默认 sandbox=true，其下 require('three')
        // 直接抛错（仅白名单 electron 子集可 require）——实机「团子不可见」根因：
        // 顶层 require 死掉 → paint-ready 不发 → 兑底显示了一个全透明空窗
        sandbox: false,
        // Live2D 资产加载（2026-10-14）：file:// 页面下 XHR/fetch 拉取 moc3/纹理被
        // webSecurity 拦截——本窗口只加载仓库内置内容（无远程页面），关闭安全策略
        // 是 spike 期的务实解；正式化时换自定义 privileged protocol
        webSecurity: false,
      },
    });
    this.petStage = win;
    win.loadFile(path.join(__dirname, '../renderer/pet-stage.html'));
    // v8 取证网（2026-10-14）：渲染层零输出的情况下，把 console（含未捕获错误）
    // 转发落盘 + 3s 后探询内部状态，断点必须能从日志读出
    win.webContents.on('console-message', (_e: unknown, level: unknown, message: string, line: number, sourceId: string) => {
      try {
        const short = String(sourceId || '').split(/[\\/]/).pop() || '?';
        _modDiag(`[PetStage:console:L${line}] ${message} (${short})`);
      } catch (_) {}
      void level;
    });
    win.webContents.on('did-fail-load', (_e: unknown, code: number, desc: string) => {
      _modDiag(`[PetStage] loadFile 失败 code=${code} ${desc}`);
    });
    win.webContents.on('did-finish-load', () => {
      // 调试模式判定（2026-11-05 小M「调试模式不生效」）：dev 构建（isPackaged=false）
      // 或 config.petDebugMode=true（托盘开关）均自动打开 petStage DevTools
      // npm start 不自动开 petStage DevTools（2026-11-05 小M）；托盘开关/F12 手动控制
      // 单一来源（2026-11-13 窗口弹出治理）：_petDebugMode 在 init() 由 config 初始化，
      // 托盘开关同时写回内存 + config。旧实现此处直接读 config，而「桌宠 DevTools」
      // 托盘项取消勾选时不写回 config → 舞台每次重载仍自动弹一个 detach DevTools 窗口。
      const dbg = this._petDebugMode;
      if (dbg) {
        try { win.webContents.openDevTools({ mode: 'detach' }); _modDiag('[PetStage] DevTools opened (config)'); } catch (_) {}
      }
      // 调试通道（2026-11-05 小M「调试模式不生效」修复）：petStage 是调试盲区——
      // isDev 只给 mainWindow 开 DevTools。dev 模式下 detached 打开 petStage DevTools
      // （Live2D 渲染/穿透/动作链路可断点排查）；打包版不开。
      _modDiag('[PetStage] did-finish-load（页面加载完成）');
      // 大小可调（2026-10-14）：重启后把持久化缩放系数推给渲染层（窗口尺寸主进程已按其定位）
      try { win.webContents.send('pet:scale', this._petScale); } catch (_) { /* 销毁竞态 */ }
      setTimeout(() => {
        try {
          win.webContents.executeJavaScript(
            'JSON.stringify({booted: !!window.__petBooted, pixi: !!window.PIXI,'
            + ' live2d: !!(window.PIXI && window.PIXI.live2d),'
            + ' core: !!window.Live2DCubismCore, mode: window.__petMode || "none"})'
          ).then((s: unknown) => {
            _modDiag(`[PetStage] 状态探询 ${String(s)}`);
          }).catch((err: Error) => {
            _modDiag(`[PetStage] 状态探询失败: ${err.message}`);
          });
        } catch (_) {}
      }, 3000);
      this._positionAndShowPet();
    });
  }

  /** 定位（持久化位 → clamp；首次用右下默认位）+ 等待 paint-ready（确认链异常 1200ms 兑底直显） */
  _positionAndShowPet(): void {
    const win = this.petStage;
    if (!win || win.isDestroyed()) return;
    const display = screen.getPrimaryDisplay();
    const saved = this.storage.getPetPosition();
    let bx: number, by: number;
    if (saved) {
      const c = clampPetPosition(saved.x, saved.y, display, this._petScale);
      bx = c.x; by = c.y;
    } else {
      const b = buildPetStageBounds(display, this._petScale);
      bx = b.x; by = b.y;
    }
    {
      const { w, h } = this._petStageSize();
      win.setBounds({ x: bx, y: by, width: w, height: h });
    }
    this._petCursorOnModel = false; // 重置命中缓存：新定位后旧命中态作废
    this._petPaintReady = false;
    if (this._petShowFallback) clearTimeout(this._petShowFallback);
    // paint-verified show（09-17 模式继承）：渲染层双 rAF 确认后才 showInactive；
    // 确认链异常（WebGL 失败兜底路径自带 50ms 兜底，此处是终极保底）不白屏
    this._petShowFallback = setTimeout(() => this._showPetWindow(), 1200);
  }

  /** paint-ready 兑底/正常两路汇聚：显示舞台 + 应用命中语义 */
  _showPetWindow(): void {
    if (this._petShowFallback) { clearTimeout(this._petShowFallback); this._petShowFallback = null; }
    const win = this.petStage;
    if (!win || win.isDestroyed()) return;
    _modDiag('[Pet] _showPetWindow entered visibleBefore=' + (win.isVisible() ? 'Y' : 'N')); // B1b：路径证实
    win.showInactive();
    // show 后重申置顶（2026-10-14 置顶修复；2026-10-20 二次修复）：hide→show 周期不保证保留
    // topmost 带成员资格。'screen-saver' 等级强制 SetWindowPos(HWND_TOPMOST) 重新入带；
    // 随后 _applyNoActivate 单次原子写 NOACTIVATE|TOPMOST（避免两处读改写互相覆盖掉 TOPMOST 位——
    // 2026-10-20 小M 实测：模式切换后 TOPMOST=False 桌宠被压到文档窗口下）
    win.setAlwaysOnTop(true, 'screen-saver');
    this._applyNoActivate(win);
    this._diagExStyle(win, 'after _showPetWindow'); // B1 取证：hide→show 后 NOACTIVATE/TRANSPARENT 残留检查
    // 输入面失同步预防（2026-11-03 定性：EXSTYLE 正常仍吞 down = Chromium 层问题）：
    // showInactive 后立即 setBounds 自碰（零几何变化）强制输入面重评估。
    // 上游通行 workaround；这是「第二次点击无响应」的直接预防点。
    try {
      const wb = win.getBounds();
      win.setBounds({ x: wb.x, y: wb.y, width: wb.width, height: wb.height });
      win.moveTop();
      _modDiag('[Pet] _showPetWindow input-surface nudge applied');
    } catch (_) { /* 竞态静默 */ }
    this._applyPetIgnore();
  }

  /** 统计汇总推送（2026-11-05 spec §3.1 终版 footer 方案）：footer 徽章常驻消费 */
  _pushStatsSummary(): void {
    if (!this.statsStore || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const summary = StatsModule.summarize(this.statsStore.data);
      try { summary.petStatsBadge = this.storage._readConfig().petStatsBadge !== false; } catch (_) {}
      this.mainWindow.webContents.send('stats:summary', summary);
    } catch (_) { /* 推送失败静默：统计不阻断主流程 */ }
  }

  /**
   * B1 诊断（2026-11-03，零行为变更）：读回窗口 EXSTYLE 落盘。目标：Bug1（二次唤出后
   * 桌宠吞 mousedown）的两大候选机制鉴别——(a) NOACTIVATE 位在 hide→show 后丢失（点击被
   * 激活逻辑吞噬）；(b) WS_EX_TRANSPARENT=0x20 残留（OS 级穿透吞 down 不吞 up）。
   * 读数落 modifier-passthrough-diag.log，与 [input] mousedown 序列对时轴即定根因。
   */
  _diagExStyle(win: { getNativeWindowHandle: () => Buffer; isDestroyed?: () => boolean }, tag: string): void {
    if (process.platform !== 'win32') return;
    if (win.isDestroyed && win.isDestroyed()) return;
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)');
      const GWL_EXSTYLE = -20;
      const WS_EX_NOACTIVATE = 0x08000000;
      const WS_EX_TRANSPARENT = 0x00000020;
      const WS_EX_TOPMOST = 0x00000008;
      const hwnd = win.getNativeWindowHandle().readBigInt64LE(0);
      const stRaw = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      // koffi intptr_t 本机实测返回 number（非 BigInt）—— number & BigInt 抛 TypeError
      // （2026-11-03 首轮探针静默翻车根因；顺带坐实 _applyNoActivate 同款写法恐同病）
      const st = typeof stRaw === 'bigint' ? stRaw : BigInt(stRaw);
      _modDiag('[Pet] EXSTYLE(' + tag + ') typeof=' + typeof stRaw + ' 0x' + st.toString(16)
        + ' NOACTIVATE=' + ((st & BigInt(WS_EX_NOACTIVATE)) !== 0n)
        + ' TRANSPARENT=' + ((st & BigInt(WS_EX_TRANSPARENT)) !== 0n)
        + ' TOPMOST=' + ((st & BigInt(WS_EX_TOPMOST)) !== 0n));
    } catch (err) { _modDiag('[Pet] EXSTYLE probe failed(' + tag + '): ' + (err as Error).message); }
  }

  /**
   * 舞台命中语义（唯一写入口）：
   * - Alt 按住 → 整窗穿透无 forward（与面板同语义：彻底惰性）；
   * - 常态 → 轮廓命中驱动（命中形象区才接收鼠标，透明区 forward 转发保 hover 链路）。
   * 注意与面板穿透相反：此处常态需要 forward:true（桌宠 hover 反馈/视线跟随依赖
   * mousemove 镜像），面板 v1 的「forward 镜像致视觉反应」教训不适用于此窗口。
   */
  /**
   * 可用 Live2D 模型枚举（2026-11-04 P-B 形象选择器）：扫描 models/<name>/<name>.model3.json
   * 目录约定；hiyori 恒在首位（内置兜底）。fs.readdirSync 同步安全（小目录，托盘构建期）。
   */
  _listPetModels(): string[] {
    const out: string[] = [];
    try {
      const dir = path.join(__dirname, '../renderer/models');
      for (const name of fs.readdirSync(dir)) {
        try {
          const p = path.join(dir, name, name + '.model3.json');
          if (fs.existsSync(p)) out.push(name);
        } catch (_) { /* 单项失败不影响其余 */ }
      }
    } catch (_) { /* 目录缺失：空表 */ }
    if (out.indexOf('hiyori') !== -1) {
      const i = out.indexOf('hiyori');
      out.splice(i, 1);
      out.unshift('hiyori'); // 内置兜底恒首位
    }
    return out;
  }

  _getPetModel(): string {
    try {
      const m = this.storage._readConfig().petLive2dModel;
      if (typeof m === 'string' && m) return m;
    } catch (_) { /* 回落默认 */ }
    return 'hiyori';
  }

  /** 切换形象：持久化 → 重建舞台（loadFile 重新走 enterLive2dMode，from 失败自动回 hiyori） */
  _setPetModel(name: string): void {
    if (typeof name !== 'string' || !name) return;
    try { this.storage._writeConfig({ petLive2dModel: name }); } catch (_) { /* 持久化失败不阻断 */ }
    // 舞台重建 = 最简热切换（模型加载失败时渲染层既有回退链自动落 hiyori/webm）
    if (this.petStage && !this.petStage.isDestroyed()) {
      this._destroyPetStage();
    }
    if (this._petModeOn) this._createPetStage();
    this.initTray(); // 重建单选态
  }

  /** 舞台逻辑尺寸（2026-11-04 显示不全修复）：220 × petScale，随缩放增长；
   *  live2d 大档（2.0/2.2）模型高度超 220 窗口 → 头顶被裁（小M 实机截图实证）。
   *  底边锚定不变：调用方 setBounds 的 y = 旧底边 - 新高度。 */
  _petStageSize(): { w: number; h: number } {
    const s = Math.round(220 * (this._petScale || 1));
    return { w: s, h: s };
  }

  /** 底边锚定的 setBounds（x 同参；y 按新高度上移，窗口底边保持在原位） */
  _setPetBoundsAnchored(x: number, bottomY: number): void {
    if (!this.petStage || this.petStage.isDestroyed()) return;
    const { w, h } = this._petStageSize();
    this.petStage.setBounds({ x: Math.round(x), y: Math.round(bottomY - h), width: w, height: h });
  }

  _applyPetIgnore(): void {
    // 命中穿透 v2（2026-10-23 小M 复测：forward 转发两次实测失活→看门狗回退整窗，
    // 220x220 透明区重新挡鼠标 ~250px）。v2 主进程自持轮询驱动（无 forward 依赖）：
    // 光标 vs 本体矩形 → 命中=整窗交互 / 未命中=整窗穿透（透明区让行下层）。
    // hover 链路：命中沿变化时 sendInputEvent 合成 mousemove（不经 OS 转发，
    // 免疫 GPU 崩溃场景的静默失效）。附带置顶自愈。
    const win = this.petStage;
    if (!win || win.isDestroyed()) return;
    // 恒交互终审（2026-11-02 拖拽失效根因闭环）：GetAsyncKeyState(VK_MENU) 探针在
    // 鼠标事件期间假阳性（raw=0x8000，今日 10+ 次）→ petStage 跟随切穿透 →
    // mousedown 被 OS 吞（全天 mousedown=1 合成/44 mouseup 真实）→ 拖拽失效。
    // petStage 恒交互（ignore 恒 false）；Alt 穿透保留于主面板（edge-detector 不变）。
    // 命中穿透 v3（2026-11-03 B2，小M 批准推翻 34b9fe4 恒交互——透明区 81% 占位修复）：
    // 决策收敛到 pet-manager.computePetIgnore 纯函数（可测）。三重守卫防丢 mousedown：
    // ① dragging 一票交互（新增，v2 缺失即 34b9fe4 消防的根因）；
    // ② ctxOpen 一票交互（菜单点击不被穿透吞）；
    // ③ Alt 恒不参与（34b9fe4 真正根因=探针假阳性，由「永不跟 Alt」结构性保留，
    //    与主面板 Alt 穿透完全解耦——edge-detector 不变）。
    const ignore = computePetIgnore({
      altActive: this._petAltActive,
      ctxOpen: this._petCtxOpen,
      cursorOnModel: this._petCursorOnModel,
      dragging: this._petDragOffset != null,
    });
    try {
      if (ignore !== this._petLastIgnoreApplied) {
        this._petLastIgnoreApplied = ignore;
        _modDiag('[Pet] 穿透模式 → ' + (ignore ? '穿透（透明区让行）' : '交互（宠物本体命中）')
          + ' [onModel=' + this._petCursorOnModel + ' ctx=' + this._petCtxOpen + ' drag=' + (this._petDragOffset != null) + ']');
        this._diagExStyle(win, 'flip→' + (ignore ? '透' : '互')); // B1b：翻转时刻的 Win32 风格实证
      }
      win.setIgnoreMouseEvents(ignore); // 无 forward：hover 由主进程合成 mousemove 驱动
    } catch (_) { /* 销毁竞态静默 */ }
    this._ensurePetHitPoll();
  }

  /** 命中穿透轮询（150ms，惰性启动）：光标 vs 本体矩形 + 置顶自愈（2026-10-23） */
  _ensurePetHitPoll(): void {
    if (this._petHitPollId) return;
    this._petHitPollId = setInterval(() => {
      const win = this.petStage;
      if (!win || win.isDestroyed()) return;
      // 置顶自愈：模式切换/hide→show 周期可能掉出 topmost 带，150ms 内补回
      if (!win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, 'screen-saver');
      }
      // 显隐自愈（2026-11-04 Bug：桌宠不稳定不显示/疑似未置顶）：取证 TOPMOST 恒 true，
      // 非置顶不成立；主嫌疑是 setOnShown 隐藏 ↔ setOnHidden 召回的时序缝隙。
      // 面板已收起但舞台不可见 → 幂等重 show（showInactive 不夺焦，150ms 内自愈）。
      if (!win.isVisible()) {
        const panelVisibleNow = this.edgeDetector ? this.edgeDetector.isWindowVisible : false;
        if (!panelVisibleNow) {
          this._showPetWindow();
        }
      }
      if (this._petCtxOpen || this._petAltActive) return; // 交互/Alt 态由既有逻辑管
      if (this._petDragOffset) return; // B2 守卫：拖拽手势中轮询不翻转穿透（150ms 翻转吞 mousedown 即 v2 缺陷）
      const r = this._petBodyRect;
      if (!r) return;
      const cur = screen.getCursorScreenPoint();
      const b = win.getBounds();
      // 迟滞命中（2026-10-29 卡顿/交互抖动修复）：150ms 轮询在矩形边缘高频翻转
      // 穿透/交互（日志实锤 150ms 连续翻转，每翻一次 setIgnoreMouseEvents+合成事件）——
      // 进入需深入 3px，离开需离界 6px，消除边界抖动
      const inShrunk = cur.x >= b.x + r.x + 3 && cur.x <= b.x + r.x + r.w - 3
        && cur.y >= b.y + r.y + 3 && cur.y <= b.y + r.y + r.h - 3;
      const inExpanded = cur.x >= b.x + r.x - 6 && cur.x <= b.x + r.x + r.w + 6
        && cur.y >= b.y + r.y - 6 && cur.y <= b.y + r.y + r.h + 6;
      const hit = this._petCursorOnModel ? inExpanded : inShrunk;
      if (hit !== this._petCursorOnModel) {
        this._petCursorOnModel = hit;
        this._applyPetIgnore();
        _modDiag('[Pet] poll hit=' + hit + ' cur=(' + cur.x + ',' + cur.y + ') win=(' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height + ') body=' + JSON.stringify(r));
        // hover 链路：命中沿变化合成 mousemove（渲染层 reportHit 触发进入/离开语义）
        try {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(cur.x - b.x), y: Math.round(cur.y - b.y) });
        } catch (_) { /* 竞态静默 */ }
      }
    }, 150);
  }

  /** 销毁桌宠舞台（切回贴边/纯隐藏时；拖拽中间态一并清） */
  _destroyPetStage(): void {
    if (this._petHitPollId) { clearInterval(this._petHitPollId); this._petHitPollId = null; }
    this._petBodyRect = null;
    this._petDragOffset = null;
    this._petDragOffset = null;
    if (this._petShowFallback) { clearTimeout(this._petShowFallback); this._petShowFallback = null; }
    if (this.petStage && !this.petStage.isDestroyed()) this.petStage.destroy();
    this.petStage = null;
    this._petAltActive = false;
    this._petCursorOnModel = false;
  }

  /** 桌宠右键菜单（原生 Menu，popup 于舞台窗口） */
  /** 桌宠右键菜单已迁移到渲染层 HTML 实现（pet:open-ctx / pet:close-ctx + pet:ctx-show）——
   *  原生 Menu 无法「失去鼠标焦点自动关闭」（2026-10-14 小M 需求） */

  /** 关于页（2026-09-30）：复用欢迎 overlay（渲染层 about 模式）；窗口不可用回退原生对话框 */
  _showAboutDialog() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // BUG1（2026-10-11）：托盘触发时面板可能贴边收起——先唤出主界面再发 IPC，
      // 否则 about:show 发进隐藏窗口什么都看不到；forceShow 兼取消在跑的隐藏倒计时
      if (this.edgeDetector) {
        this.edgeDetector.forceShow();
      } else {
        this.mainWindow.show();
      }
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
  /**
   * 构建「穿透透明度」子菜单（2026-11-02，小M 提出）：Alt 穿透激活时面板降到的
   * 透明度档位。持久化 storage config.passthroughOpacity（null=默认 0.5，菜单显示「默认」单选）。
   * 档位设计：0.7（浅，仅轻微提示）/ 0.5（默认）/ 0.35（深，近似倒计时透视档）。
   * 文案沿托盘既有惯例硬编码中文。
   */
  _getPassthroughOpacity(): number | null {
    try {
      const v = this.storage._readConfig().passthroughOpacity;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) return v;
    } catch (_) { /* 读取失败回落默认 */ }
    return null;
  }

  _setPassthroughOpacity(v: number | null): void {
    try { this.storage._writeConfig({ passthroughOpacity: v }); } catch (_) { /* 持久化失败不阻断 */ }
    if (this.edgeDetector) this.edgeDetector.setPassthroughOpacity(v);
    this.initTray(); // 重建单选态（幂等守卫已内置）
  }

  _buildPassthroughOpacitySubmenu() {
    const options = [
      { label: '浅（70%）', value: 0.7 },
      { label: '默认（50%）', value: 0.5 },
      { label: '深（35%）', value: 0.35 },
    ];
    const current = this._getPassthroughOpacity();
    return options.map(opt => ({
      label: opt.label,
      type: 'radio' as const,
      checked: current === null ? opt.value === 0.5 : Math.abs(current - opt.value) < 0.01,
      click: () => this._setPassthroughOpacity(opt.value === 0.5 ? null : opt.value),
    }));
  }

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
    const items: Array<Record<string, unknown>> = [
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

    // 自定义标签规则（二期 P2，2026-10-11）：动态区（托盘硬编码 zh 为既有惯例）
    const customRules = this.storage.getCustomRules();
    if (customRules.length > 0) {
      items.push({
        label: '自定义标签',
        submenu: [
          ...customRules.map(r => ({
            label: `${r.name}${r.enabled ? '' : '（已关）'}`,
            type: 'checkbox',
            checked: r.enabled,
            click: (menuItem: { checked: boolean }) => {
              const cur = this.storage.getCustomRules();
              const next = cur.map(x => x.id === r.id ? { ...x, enabled: menuItem.checked } : x);
              this.storage.setCustomRules(next);
              this.monitor.setCustomRules(next);
              this.pushHistory();
              this._broadcastTagRulesUpdated();
            },
          })),
          { label: '打开管理面板', click: () => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('tag-rules-manager:open');
            }
          } },
        ],
      });
    }
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
    // F12 调试切换（2026-11-05 小M「调试模式不生效」辅助）：切换主面板 DevTools，
    // 无需进托盘翻菜单。生产模式同样可用（排查需要）。
    globalShortcut.register('F12', () => {
      // 2026-11-12 小M：调试快捷键仅限开发（未打包）——发布版不带调试入口
      if (app.isPackaged) return;
      const mw = this.mainWindow;
      if (!mw || mw.isDestroyed()) return;
      // isDevTC：DevTools 是否已开（webContents.capturePage 不可靠，用 devToolsWebContents 判定）
      const devOpen = (mw.webContents as unknown as { devToolsWebContents?: { isDestroyed(): boolean } }).devToolsWebContents
        && !(mw.webContents as unknown as { devToolsWebContents: { isDestroyed(): boolean } }).devToolsWebContents.isDestroyed();
      if (devOpen) { mw.webContents.closeDevTools(); }
      else { mw.webContents.openDevTools({ mode: 'detach' }); }
    });
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
      // IPC 载荷瘦身（2026-10-22）：同 pushHistory——图片只送 thumbnail
      return this.monitor.getHistory().map((it) =>
        it.type === 'image' && it.thumbnail ? { ...it, dataUrl: it.thumbnail } : it
      );
    });

    // 用默认浏览器打开 URL（协议白名单：仅 http/https）
    // 安全：shell.openExternal 对未过滤协议可能拉起任意已注册 handler，
    // file:/javascript:/自定义协议一律拒绝。
    // 形象工坊（2026-11-13 小M）：桌宠菜单 🎨 入口 → 用系统浏览器打开仓库内的
    // pet-webm-pipeline Skill 文档（用户按 Skill 生成自己的桌宠形象素材）
    ipcMain.handle('pet:open-skill', async () => {
      try {
        const skillPath = path.join(__dirname, '../../skills/pet-webm-pipeline/SKILL.md');
        const skillUrl = 'https://github.com/holdyounger/ClipSense/blob/main/skills/pet-webm-pipeline/SKILL.md';
        // 本地存在则优先开本地文件（离线可用）；异常回落 GitHub 在线版
        if (fs.existsSync(skillPath)) {
          await shell.openExternal('file:///' + skillPath.replace(/\\/g, '/'));
        } else {
          await shell.openExternal(skillUrl);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

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

    // file 条目「复制路径」按钮：写路径文本而非文件本体（回写抑制在 monitor 内）
    ipcMain.handle('copy-item-path', (event, id) => this.monitor.copyItemPath(id));

    // 置顶 toggle（2026-11-11 FR1/FR5）：monitor.togglePin 收敛于 pin-utils 纯函数
    ipcMain.handle('toggle-pin', (event, id: string) => this.monitor.togglePin(id));

    // 自定义标签规则（标签体系二期，2026-10-11）：CRUD 存 storage，变更广播渲染层
    ipcMain.handle('get-tag-rules', () => this.storage.getCustomRules());
    ipcMain.handle('set-tag-rules', (event, rules) => {
      if (!Array.isArray(rules)) return { ok: false, error: '规则表格式错误' };
      const clean = rules
        .filter((r: any) => r && typeof r.id === 'string' && typeof r.name === 'string'
          && typeof r.pattern === 'string' && r.pattern.length > 0 && r.pattern.length <= 200)
        .map((r: any) => ({
          id: r.id, name: String(r.name).slice(0, 40), pattern: r.pattern,
          enabled: r.enabled !== false,
          createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
        }));
      this.storage.setCustomRules(clean);
      this.monitor.setCustomRules(clean);
      this._broadcastTagRulesUpdated();
      return { ok: true, count: clean.length };
    });
    ipcMain.handle('validate-tag-rule', (event, pattern) => {
      try {
        const { validateCustomRule } = require('../common/tag-utils');
        return validateCustomRule(typeof pattern === 'string' ? pattern : '');
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // 文本条目「打开路径」按钮：shell.openPath 用系统关联程序打开（目录则资源管理器）；
    // file:// URI 先 fileURLToPath；存在性校验在此（fs），路径失效返回结构化错误
    ipcMain.handle('open-path', async (event, rawPath) => {
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        return { ok: false, error: '路径为空' };
      }
      let p = rawPath.trim();
      if (/^file:\/\//i.test(p)) {
        try {
          p = fileURLToPath(p);
        } catch (_) { /* 非法 URI 保留原串，交给 existsSync 判定 */ }
      }
      const normalized = process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
      if (!fs.existsSync(normalized)) {
        return { ok: false, error: '路径不存在或已失效' };
      }
      try {
        const errMsg = await shell.openPath(normalized);
        return errMsg ? { ok: false, error: errMsg } : { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
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

      // macOS：面板持焦时先让出焦点——系统把前台归还给上一个应用，⌘V 才会落到目标。
      // blur 后仍持焦（极少数场景）则 hide 兜底，保证注入不回到面板自身。
      if (process.platform === 'darwin' && this.mainWindow && !this.mainWindow.isDestroyed()) {
        if (this.mainWindow.isFocused()) {
          this.mainWindow.blur();
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (this.mainWindow.isFocused()) {
            this.mainWindow.hide();
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
        }
      }

      // 取目标句柄（16:34 根因修复）：双击瞬间重新抓前台；fgNow 被自身/瞬态过滤时
      // 回退 tracked（焦点模型回切后 tracked 由 focus-search 抢焦前 refresh 保持新鲜，
      // 2026-09-11 双击粘贴回归修复）。
      // fgNow=0 是窗口切换真空态（合法瞬态），用 captureForegroundRetry 忙等重试。
      const fgNow = this.pasteBridge ? this.pasteBridge.captureForegroundRetry() : 0;
      const trackedHwnd = this.focusTracker ? this.focusTracker.getHwnd() : 0;
      // 双 0 兑底（2026-11-11 守护用例锁定）：唤出时前台=桌面/任务栏且 tracked 过期/为 0
      // → Z 序下探面板正下方压着的顶层窗口（Ditto 同款），命中回写 tracked 供同显示周期复用
      let restoreHwnd = fgNow > 0 ? fgNow : trackedHwnd;
      if (!restoreHwnd && this.mainWindow && !this.mainWindow.isDestroyed() && this.pasteBridge) {
        try {
          const hb = this.mainWindow.getNativeWindowHandle();
          const panelHwnd = Number(hb.readBigUInt64LE(0));
          const below = this.pasteBridge.captureBelow(panelHwnd);
          if (below > 0) {
            restoreHwnd = below;
            if (this.focusTracker) {
              this.focusTracker._targetHwnd = below;
              this.focusTracker._trackedAt = Date.now();
            }
            console.log(`[Spike] paste target z-fallback: below=${below}`);
          }
        } catch { /* 下探失败维持 0 */ }
      }
      // 无目标短路（不白跑注入）
      if (!restoreHwnd) return { ok: false, error: 'no-target' };
      console.log(`[Spike] paste target: fgNow=${fgNow} tracked=${trackedHwnd} -> use=${restoreHwnd}`);
      _modDiag(`[Paste] target fgNow=${fgNow} tracked=${trackedHwnd} use=${restoreHwnd}`);

      // ① 先粘贴（面板 NOACTIVATE 不抢焦点，目标窗口仍在前台）
      // 初始化顺序保证调用时已创建（早调用与 .js 同点 TypeError）；! 为类型收窄
      let result = this.pasteBridge!.pasteTo(restoreHwnd);
      // CopyQ 同款降级：Ctrl+V 被吞（RDP/远程桌面等场景）时尝试 Shift+Insert。
      if (!result.ok && restoreHwnd && process.platform !== 'darwin'
        && result.error !== 'restore-denied' && result.error !== 'modifiers-held') {
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
        _modDiag(`[Paste] FAILED error=${result.error} restored=${result.restored || ''}`);
        // macOS：未授权「辅助功能」时 CGEvent 注入被系统静默丢弃，需显式引导
        if (result.error === 'accessibility-required') this._promptAccessibility();
      } else {
        console.log(`[Spike] 已粘贴选中条目: ${item.type} ${item.preview} (restored=${result.restored})`);
        _modDiag(`[Paste] OK restored=${result.restored}`);
        // S2 埋点（2026-11-05 spec §一）：双击粘贴成功 +1（失败不加——成功回调语义）
        try { if (this.statsStore) { this.statsStore.record('paste'); this._pushStatsSummary(); } } catch (_) {}
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
      // Alt 穿透功能提示一次性标记（2026-10-13）：独立于版本号，
      // 覆盖「同版本已看过欢迎页、但未见过 Alt 提示」的存量用户
      showAltPassTip: !this.storage.getAltPassTipShown(),
    }));
    ipcMain.handle('set-welcome-shown', () => {
      this.storage.setLastShownVersion(app.getVersion());
      return { ok: true };
    });
    ipcMain.handle('set-alt-pass-tip-shown', () => {
      this.storage.setAltPassTipShown();
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
      // 桌宠模式路由（P0 spike）：新条目反应走舞台渲染层事件，不再脉冲贴边条
      if (this._petModeOn) {
        if (this.petStage && !this.petStage.isDestroyed()) {
          this.petStage.webContents.send('pet:react');
        }
        return;
      }
      const tw = this.triggerWindow;
      if (!tw || tw.isDestroyed()) return;
      tw.webContents.executeJavaScript(
        'window.__clipSenseBarPulse && window.__clipSenseBarPulse()'
      ).catch(() => {});
    });

    // ========== 桌宠舞台 IPC（P0 spike，2026-10-13） ==========
    // paint-ready：渲染层双 rAF 首帧确认（兑底定时器见 _positionAndShowPet）
    ipcMain.on('pet-paint-ready', () => {
      this._petPaintReady = true;
      this._showPetWindow();
    });
    // 轮廓命中上报：驱动 ignore 语义切换（forward 转发保 hover 链路）
    ipcMain.on('pet:cursor-hit', (_event: unknown, hit: boolean) => {
      // 渲染层命中回报（交互态）：与主进程轮询双驱动（一致收敛）
      this._petCursorOnModel = !!hit;
      this._applyPetIgnore();
    });
    ipcMain.on('pet:body-rect', (_event: unknown, rect: { x: number; y: number; w: number; h: number }) => {
      // 宠物本体矩形（渲染层按视频宽高比计算上报；2026-10-23 命中穿透 v2）
      if (rect && typeof rect.x === 'number') this._petBodyRect = rect;
    });
    // 渲染层诊断上报（2026-10-13 实机返工）：装配/WebGL 失败落盘取证
    ipcMain.on('pet:diag', (_event: unknown, msg: unknown) => {
      _modDiag(`[PetStage] ${String(msg).split('\n').join(' | ')}`);
    });
    // Live2D 后端配置通道（2026-11-03 T3，A2 约定）：模型热插拔 + 总开关。
    // petLive2dModel 缺省 null → 渲染层回落 hiyori；petLive2dEnabled 缺省 true。
    ipcMain.handle('pet:get-config', () => {
      try {
        const cfg = this.storage._readConfig();
        const model = cfg.petLive2dModel;
        return {
          petLive2dModel: typeof model === 'string' && model ? model : null,
          petLive2dEnabled: cfg.petLive2dEnabled !== false,
          models: this._listPetModels(), // P-B：形象选择 UI 的枚举源
        };
      } catch (_) {
        return { petLive2dModel: null, petLive2dEnabled: true };
      }
    });
    // B1b（2026-11-03）：孤儿 mouseup 采样——渲染层收到左 up 而无 down（Bug1 失败签名）时，
    // 当场 dump EXSTYLE + 穿透状态机快照。失败时刻的 Win32 风格实证，三选一定性：
    // TRANSPARENT 残留（样式失同步）/ NOACTIVATE 丢失（激活路径吞 down）/ 两者皆正常（Electron 输入面失活）。
    ipcMain.on('pet:orphan-up', (_event: unknown, p: { x?: number; y?: number; hit?: boolean; ctx?: boolean }) => {
      const w = this.petStage;
      if (!w || w.isDestroyed()) return;
      // 限频（2026-11-05 Bug1）：菜单会话（ctx）内 nudge 与 setBounds 链互相触发连环
      // （昨夜日志 20+ 连环）——菜单期完全禁用；非会话期 400ms 冷却。
      const now = Date.now();
      if (p.ctx || this._petCtxOpen || now - this._orphanNudgeAt < 400) return;
      const q = (p && typeof p === 'object') ? p : ({} as { x?: number; y?: number; hit?: boolean; ctx?: boolean });
      _modDiag('[Pet] orphan-up x=' + q.x + ' y=' + q.y + ' hit=' + q.hit + ' ctx=' + q.ctx
        + ' lastApplied=' + this._petLastIgnoreApplied + ' onModel=' + this._petCursorOnModel);
      this._diagExStyle(w, 'orphan-up');
      // 自愈 v2（2026-11-03 终版）：EXSTYLE 取证已排除 OS 样式失同步（失败期
      // NOACTIVATE/TOPMOST/TRANSPARENT 全正常），透→互往返亦未治愈且其 150ms 穿透窗
      // 反噬下一次真点击——撤。改上游通行 workaround：setBounds 自碰强制 Chromium
      // 重评估透明窗口输入面（hide→showInactive 后 down 被吞 = 输入面失同步，
      // electron upstream 已知问题类）+ moveTop 重申命中带。零几何变化，无副作用。
      try {
        const bb = w.getBounds();
        w.setBounds({ x: bb.x, y: bb.y, width: bb.width, height: bb.height });
        w.moveTop();
        this._orphanNudgeAt = Date.now();
        this._diagExStyle(w, 'after-nudge');
        _modDiag('[Pet] orphan-up healed: setBounds self-nudge applied');
      } catch (_) { /* 销毁竞态静默 */ }
    });
    // 左键点击：唤出面板（等价贴边热区；Alt+V 同链路）
    // 动作/窗口解耦（2026-11-13）：petClickSummon=false 时单击桌宠仍播 heart1 反应动作
    // （渲染层 mouseup 独立调用 triggerReact），只是不再唤出主面板窗口；面板改由
    // Alt+V / 托盘「显示/隐藏」/ 贴边热区唤出。托盘「点击桌宠时唤出面板」可实时切换。
    ipcMain.on('pet:summon', (_event: unknown, force?: boolean) => {
      // force=true 来自用户显式入口（右键「显示面板」），不受自动解耦开关限制。
      if (force !== true && !this._petClickSummon) {
        _modDiag('[Pet] summon suppressed by petClickSummon=false');
        return;
      }
      if (this.edgeDetector) this.edgeDetector.forceShow();
    });
    // 右键：原生上下文菜单
    // 右键菜单改为渲染层 HTML 实现（2026-10-14 小M 需求：失去鼠标焦点自动关闭，
    // 原生 Menu 做不到且样式不可控）——主进程只负责扩窗/还原与状态/动作 IPC
    ipcMain.on('pet:open-ctx', () => {
      _modDiag('[Pet] open-ctx received (mode=' + this._getHideMode() + ', scale=' + this._petScale + ')');
      const win = this.petStage;
      if (!win || win.isDestroyed()) { _modDiag('[Pet] open-ctx abort: petStage missing'); return; }
      // 去 resize 化（2026-10-20 小M：右击闪烁+瞬移根因 = transparent 窗口 resize）：
      // 窗口恒定 220x220（菜单全尺寸），右键纯渲染层展开，主进程零窗口操作。
      // 宠物常驻居中锚定（渲染层 fromCenter），拖拽走 setBounds 纯 move（无 resize）。
      if (!this._petCtxOpen) {
        const b0 = win.getBounds();
        this._petCtxSaved = { x: b0.x, y: b0.y, width: b0.width, height: b0.height };
        this._petCtxOpen = true;
        this._applyPetIgnore(); // 菜单打开：全窗可交互（渲染层 cursorHit 反向控制穿透）
      }
      if (this._petCtxPollId) clearInterval(this._petCtxPollId);
      this._petCtxPollId = setInterval(() => {
        const w2 = this.petStage;
        if (!w2 || w2.isDestroyed() || !this._petCtxOpen || this._petCtxHold) {
          if (this._petCtxPollId) { clearInterval(this._petCtxPollId); this._petCtxPollId = null; }
          return;
        }
        const cur = screen.getCursorScreenPoint();
        const bb = w2.getBounds();
        const outside = cur.x < bb.x || cur.x > bb.x + bb.width || cur.y < bb.y || cur.y > bb.y + bb.height;
        if (outside) {
          this._petCtxOpen = false;
          if (this._petCtxPollId) { clearInterval(this._petCtxPollId); this._petCtxPollId = null; }
          const saved2 = this._petCtxSaved;
          this._petCtxSaved = null;
          if (saved2) w2.setBounds(saved2);
          this._applyPetIgnore();
          try { w2.webContents.send('pet:ctx-hide'); } catch (_) { /* 销毁竞态 */ }
          console.log('[Pet] 菜单随光标出界自动关闭');
        }
      }, 120);
      try { win.webContents.send('pet:ctx-show', { mode: this._getHideMode(), scale: this._getPetScale() }); } catch (_) {}
    });
    ipcMain.on('pet:close-ctx', () => {
      const win = this.petStage;
      const saved = this._petCtxSaved;
      this._petCtxSaved = null;
      this._petCtxOpen = false;
      if (this._petCtxPollId) { clearInterval(this._petCtxPollId); this._petCtxPollId = null; }
      if (win && !win.isDestroyed()) {
        if (saved) win.setBounds(saved);
        this._applyPetIgnore(); // 恢复轮廓命中语义
      }
    });
    ipcMain.handle('pet:get-menu-state', () => ({ mode: this._getHideMode(), scale: this._getPetScale() }));
    ipcMain.on('pet:set-hide-mode', (_event: unknown, mode: string) => {
      if (mode === 'pet' || mode === 'edge' || mode === 'hidden') this._setHideMode(mode);
    });
    ipcMain.on('pet:set-scale', (_event: unknown, v: unknown) => {
      const n = Number(v);
      if (isFinite(n) && n > 0) this._setPetScalePreset(n);
    });
    ipcMain.on('pet:quit', () => app.exit(0));
    // 拖拽三段：start 记录偏移（并临时全穿透防鼠标出窗断链）/ move 30Hz 节流跟随 /
    // end clamp 落位 + 持久化 + 恢复命中语义。拖拽是用户手势非动画，渐进 setPosition
    // 是舞台纪律的记录在案例外（PRD §pet-manager 注）。
    ipcMain.on('pet:drag-start', (_event: unknown, sx: number, sy: number) => {
      if (!this.petStage || this.petStage.isDestroyed()) return;
      const pos = this.petStage.getPosition();
      this._petDragOffset = { dx: sx - pos[0], dy: sy - pos[1] };
      // B2：拖拽起点整窗穿透（手势必需，鼠标可出窗）；drag-end 经 _applyPetIgnore 恢复。
      // 手势期间 _ensurePetHitPoll 的 dragging 守卫保证轮询不中途翻转。
      try { this.petStage.setIgnoreMouseEvents(true); this._petLastIgnoreApplied = true; } catch (_) { /* 竞态静默 */ }
    });
    ipcMain.on('pet:drag-move', (_event: unknown, sx: number, sy: number) => {
      if (!this.petStage || this.petStage.isDestroyed() || !this._petDragOffset) return;
      const c = clampPetPosition(sx - this._petDragOffset.dx, sy - this._petDragOffset.dy, screen.getPrimaryDisplay());
      // 拖拽变大 bug（2026-10-13 实机）：Electron Windows DPI 缩放下 setPosition 只传坐标，
      // 窗口尺寸经 DIP↔物理像素往返取整逐次漂移（30Hz 拖拽数秒 = 肉眼可见「一直变大」）。
      // 修法：setBounds 每拍显式钉死宽高，取整误差无从累积；漂移取证日志实锤根因。
      const b = this.petStage.getBounds();
      // 窗口尺寸 = 220 × petScale（2026-11-04：随缩放长大；DPI 防漂移钉死语义保留）
      const size = this._petStageSize();
      if (b.width !== size.w || b.height !== size.h) {
        _modDiag(`[Pet] 拖拽尺寸漂移 ${b.width}x${b.height} → 钉回 ${size.w}x${size.h}（DPI 取整实锤）`);
      }
      this.petStage.setBounds({ x: c.x, y: c.y, width: size.w, height: size.h });
    });
    ipcMain.on('pet:drag-end', () => {
      if (!this.petStage || this.petStage.isDestroyed()) { this._petDragOffset = null; return; }
      const pos = this.petStage.getPosition();
      const b = this.petStage.getBounds();
      const c = clampPetPosition(pos[0], b.y + b.height - Math.round(220 * this._petScale), screen.getPrimaryDisplay(), this._petScale);
      const { w, h } = this._petStageSize();
      this.petStage.setBounds({ x: c.x, y: c.y, width: w, height: h });
      this.storage.setPetPosition({ x: c.x, y: c.y });
      this._petDragOffset = null;
      this._petLastIgnoreApplied = null; // B2：强制下次同步实际生效值（拖拽中已置 true）
      this._applyPetIgnore(); // 恢复命中语义
    });


    // 滚轮缩放（2026-10-14）：渲染层在轮廓命中时上报，主进程累加步进并落地
    ipcMain.on('pet:scale-wheel', (_event: unknown, deltaY: number) => {
      const cur = this._petScale;
      const step = 0.06;
      const next = normalizeScale(cur + (deltaY > 0 ? -step : step)); // 滚轮向下 = 缩小
      if (Math.abs(next - cur) < 0.001) return; // 到边界后静默
      this._setPetScale(next);
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

    // 模态 overlay（关于/欢迎页）开关上报：挂起/恢复自动隐藏（2026-10-11 BUG1）
    ipcMain.on('set-overlay-active', (event, active) => {
      if (this.edgeDetector) this.edgeDetector.setOverlayActive(active);
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
      // IPC 载荷瘦身（2026-10-22 小M 面板卡顿）：图片条目只送 thumbnail（高 96px），
      // 全尺寸 dataUrl 不出主进程（渲染层列表只显示缩略图；复制走 copy-item 主进程链路）
      const slim = this.monitor.getHistory().map((it) =>
        it.type === 'image' && it.thumbnail ? { ...it, dataUrl: it.thumbnail } : it
      );
      this.mainWindow.webContents.send('history-updated', slim);
    }
  }

  /** 自定义标签规则变更广播（托盘开关/管理面板保存共用，2026-10-11） */
  _broadcastTagRulesUpdated(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('tag-rules-updated', this.storage.getCustomRules());
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
      // 修复（2026-11-11）：koffi 3.1.6 intptr_t 本机实测返回 number（非 BigInt，
      // 见 842 诊断区注释与今日 run3 日志 TypeError）——number & BigInt 抛
      // "Cannot mix BigInt and other types"，致 NOACTIVATE 一直未生效。
      // 读写类型自适应归一（EXSTYLE 实际都在低 32 位，Number 化安全）。
      const curRaw = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as number | bigint;
      const cur = typeof curRaw === 'bigint' ? curRaw : BigInt(Math.round(curRaw));
      // NOACTIVATE + TOPMOST（alwaysOnTop 在 Electron 内部也设 TOPMOST，这里补齐以防重置）
      const newStyle = (cur | BigInt(WS_EX_NOACTIVATE) | BigInt(WS_EX_TOPMOST));
      const newStyleOut = typeof curRaw === 'bigint' ? newStyle : Number(newStyle);
      SetWindowLongPtrW(hwnd, GWL_EXSTYLE, newStyleOut);
      const afterRaw = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as number | bigint;
      const after = typeof afterRaw === 'bigint' ? afterRaw : BigInt(Math.round(afterRaw));
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
    _modDiag(`[Paste] capture hwnd=${r.hwnd} reason=${r.reason || 'ok'} cls=${r.cls || ''}`);
    if (r.hwnd > 0) {
      ft._targetHwnd = r.hwnd;
      ft._trackedAt = Date.now();
    } else {
      // Z 序回退（2026-10-29 双击粘贴修复第二幕）：唤出时前台是任务栏/桌面
      //（Shell_TrayWnd 等被过滤 → tracked=0）时，面板正下方压着的顶层窗口
      // 就是用户刚才在用的应用——Ditto 同款 GW_HWNDPREV 下探补抓
      let fb = 0;
      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed() && this.pasteBridge) {
          const hb = this.mainWindow.getNativeWindowHandle();
          const panelHwnd = Number(hb.readBigUInt64LE(0));
          fb = this.pasteBridge.captureBelow(panelHwnd);
        }
      } catch { /* 回退失败保持 0 */ }
      if (fb > 0) _modDiag(`[Paste] capture z-fallback hwnd=${fb}`);
      // 修复（2026-11-11 守护用例锁定）：fb 命中时必须写回 tracked，否则「唤出时前台=桌面/任务栏」
      // 场景 tracked 恒 0 → 双击无目标必失效；此前 fb 只落日志、随后被无条件清零
      if (fb > 0) {
        ft._targetHwnd = fb;
        ft._trackedAt = Date.now();
      } else {
        ft._targetHwnd = 0;
        ft._trackedAt = 0;
      }
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.executeJavaScript(
        `console.log('[FocusTracker] capture: hwnd=${r.hwnd} ${r.reason || ''} ${r.cls ? 'class=' + r.cls : ''} pid=${r.pid || 0}')`
      ).catch(() => {});
    }
  }

  /**
   * macOS：辅助功能未授权时的引导。
   * CGEventPost 在未授权时无异常也无返回码，只能靠 AXIsProcessTrusted 提前判定并提示。
   */
  _promptAccessibility(): void {
    if (this._accessibilityPrompted) return;
    this._accessibilityPrompted = true;
    dialog.showMessageBox({
      type: 'warning',
      title: '需要「辅助功能」权限',
      message: 'ClipSense 需要「辅助功能」权限才能自动粘贴',
      detail: '打开「系统设置 → 隐私与安全性 → 辅助功能」，勾选 ClipSense（开发模式为 Electron）后重试。授权后无需重启应用。',
      buttons: ['打开系统设置', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then((result: { response: number }) => {
      if (result.response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
    }).catch(() => {});
  }

  async init() {
    this.createWindow();
    this.initTray();
    this.registerShortcut();
    this.setupIPC();

    // 初始化边缘检测器（贴边 / 自动隐藏 / 鼠标唤出）
    // createWindow() 已同步创建两窗口；! 为类型收窄（运行时恒非空）
    this.edgeDetector = new EdgeDetector(this.mainWindow!, this.triggerWindow!);
    // 穿透透明度持久化（2026-11-02 托盘菜单）：启动应用 config.passthroughOpacity（null=默认 0.5）
    this.edgeDetector.setPassthroughOpacity(this._getPassthroughOpacity());
    // 修饰键（Alt）按住穿透（2026-10-13）：注入全局键态探针（koffi 惰性绑定，非 win32 恒 false）+
    // 取证日志句柄（§5-③：落盘 userData，逐站编号定位链路断点）
    this.edgeDetector.setModifierProbe(() => _isAltPhysicallyDown(), _modDiag);
    this.edgeDetector.setOnShown(() => {
      // capture 主进程日志用户看不到；把每次 capture 的判定结果推送到渲染层 console
      this._diagCapture();
      // 桌宠模式：面板可见期隐藏舞台（alwaysOnTop 会盖住面板），收起时再召回
      if (this._petModeOn && this.petStage && !this.petStage.isDestroyed()) {
        this.petStage.hide();
      }
    });
    this.edgeDetector.setOnHidden(() => {
      // 面板收起后句柄生命周期结束：下次唤出时重新 capture。
      // （双击不收面板，同一显示周期内句柄持续有效，支持连续粘贴多条目）
      this.focusTracker!.clear(); // 回调触发时 init 已完成创建（运行时恒非空）
      // 桌宠模式：面板收起 → 舞台回归。改走 _showPetWindow（show 后重申置顶）：
      // hide→show 周期是掉 topmost 带的高频路径——置顶丢失的主要场景
      if (this._petModeOn && (!this.petStage || this.petStage.isDestroyed())) {
        // 启动延迟登场（2026-11-03 Bug1）补口：面板在场时舞台未创建（petStage=null），
        // 收起瞬间在这里首次创建——否则桌宠永不出现
        this._createPetStage();
      } else if (this._petModeOn && this.petStage && !this.petStage.isDestroyed()) {
        this._showPetWindow();
      }
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
    // setOnShown 单槽回调：桌宠面板可见期隐藏舞台的逻辑已在上方注册处合并
    //（两处注册会相互覆盖，2026-10-13 去重）
    this.edgeDetector.start();
    // 统计与等级模块（2026-11-05 spec §一）：独立 clipboard-stats.json，与历史文件解耦；
    // load 内含 90 天滚动清理与损坏容错（统计损坏不影响剪贴板数据）
    try {
      this.statsStore = new StatsModule.StatsStore(path.join(app.getPath('userData'), 'clipboard-stats.json'));
      this.statsStore.load();
      // 启动静默推送（2026-11-05 footer 终版）：面板徽章数据就绪即常驻显示。
      // 延迟 1.5s 等渲染层订阅就绪（did-finish-load 后 onStatsSummary 才挂上）。
      setTimeout(() => { try { this._pushStatsSummary(); } catch (_) {} }, 1500);
    } catch (_) { this.statsStore = null; }
    // 桌宠模式接线（P0 spike）：Alt 穿透边沿联动舞台 + 启动时应用持久化模式
    //（决策 1：缺省/旧配置 = edge，存量用户零感知）
    this.edgeDetector.setOnModifierEdge((active) => {
      this._petAltActive = active;
      this._applyPetIgnore();
    });
    // 置顶保活（2026-10-14 置顶修复）：睡眠/恢复后显示拓扑重建，topmost 带成员
    // 资格不保证保留——resume 重申全部置顶窗口（幂等尽力而为，失败静默）
    powerMonitor.on('resume', () => {
      if (this.petStage && !this.petStage.isDestroyed()) this.petStage.setAlwaysOnTop(true);
      if (this.triggerWindow && !this.triggerWindow.isDestroyed()) this.triggerWindow.setAlwaysOnTop(true);
    });
    // Alt 残留自愈（2026-10-15 发现）：测试脚本/异常路径可能让物理 Alt 态残留
    // （S3 持续 active=true 但用户没按 Alt）→ 桌宠完全穿透不可交互。每 5s 复查
    // GetAsyncKeyState，若 Alt 已物理释放但状态机仍 active 则强制复位。
    this._altRescueId = setInterval(() => {
      try {
        if (this._petAltActive && !this.edgeDetector) return;
        const stillDown = _isAltPhysicallyDown();
        if (this._petAltActive && !stillDown) {
          _modDiag('[Pet] Alt 残留自愈触发：物理已释放但状态机仍 active，强制复位');
          this._petAltActive = false;
          this._applyPetIgnore();
        }
      } catch (_) { /* 取证失败不影响 */ }
    }, 5000);
    // 大小可调（2026-10-14）：启动时应用持久化缩放系数（默认 1）
    this._petScale = this._getPetScale();
    // 窗口行为开关（2026-11-13）：点击桌宠是否唤出主面板 + 调试 DevTools 是否自动弹出。
    // 统一由 config 初始化，保证托盘 checkbox 显示态与实际行为一致（旧实现
    // _petDebugMode 恒 false 起步、did-finish-load 却直读 config，二者失配）。
    try {
      const cfg = this.storage._readConfig();
      // 缺省「不弹」：只有配置里显式 true 才恢复点击唤出面板，避免历史配置缺键时
      // 又退回「点一下就弹主面板 + 桌宠被遮半截」的旧行为。
      this._petClickSummon = cfg.petClickSummon === true;
      this._petDebugMode = cfg.petDebugMode === true;
    } catch (_) { /* 读配置失败保持缺省值 */ }
    this._applyHideMode();

    // 异常快照接线（2026-10-11）：渲染进程/子进程异常落盘；原生崩溃的 .dmp 由 Crashpad 接管
    app.on('render-process-gone', (_event: unknown, webContents: any, details: any) => {
      crashDump.writeTextSnapshot(
        crashLogDir,
        'render-process-gone',
        crashDump.buildExceptionLines('render-process-gone', `${details.reason} (exitCode=${details.exitCode})`, {
          url: webContents.getURL(),
        })
      );
      crashDump.rotateCrashLogs(crashLogDir);
    });
    app.on('child-process-gone', (_event: unknown, details: any) => {
      crashDump.writeTextSnapshot(
        crashLogDir,
        `child-process-gone-${details.type}`,
        crashDump.buildExceptionLines('child-process-gone', `${details.reason} (exitCode=${details.exitCode})`)
      );
      crashDump.rotateCrashLogs(crashLogDir);
    });
    try {
      console.log(`[Spike] 崩溃转储目录(dmp): ${app.getPath('crashDumps')}`);
    } catch (_) { /* 尚未就绪时忽略 */ }
    console.log(`[Spike] 异常快照目录: ${crashLogDir}`);
    // 初次显示也使用非激活方式，并在抢焦点前记录原目标窗口。
    // 桌宠/纯隐藏模式不开机弹面板（桌宠模式_ applyHideMode 会接管隐藏态）
    if (this._getHideMode() === 'edge') this.edgeDetector.forceShow();
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
      // S1 埋点（2026-11-05 spec §一）：复制入库 +1（被动积累，零主动采集）
      try { if (this.statsStore) { this.statsStore.record('copy'); this._pushStatsSummary(); } } catch (_) {}
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

// JS 层异常快照接线（2026-10-11）：uncaughtException/unhandledRejection 记录完整快照后
// 保持应用存活（托盘常驻工具单点 JS 异常不应整体退出）；原生崩溃由 Crashpad 接管
const crashLogDir = path.join(app.getPath('userData'), 'crash-logs');
crashDump.setupExceptionCapture({
  logDir: crashLogDir,
  keep: 50,
  getState: () => ({
    version: app.getVersion(),
    uptimeSec: Math.round(process.uptime()),
    heapUsed: process.memoryUsage().heapUsed,
    mainWindowAlive: !!spikeApp.mainWindow && !spikeApp.mainWindow.isDestroyed(),
    panelVisible: spikeApp.edgeDetector ? spikeApp.edgeDetector.isWindowVisible : null,
    historyCount: (() => { try { return spikeApp.monitor.getHistory().length; } catch (_) { return null; } })(),
  }),
});

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
    // macOS：菜单栏常驻工具形态——隐藏 Dock 图标（等同 Windows skipTaskbar；
    // 打包配置里的 LSUIElement 也会兜底，开发模式靠 runtime API）
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.hide(); } catch (_) { /* 无 dock（headless/CI）时忽略 */ }
    }
    await spikeApp.init();
  });
}

app.on('window-all-closed', () => {
  // 有托盘，保持后台；spike 也允许通过托盘退出
});

app.on('activate', () => {
  // macOS：点击 Dock 图标（若可见）时唤出面板
  if (spikeApp.mainWindow && !spikeApp.mainWindow.isDestroyed()) {
    spikeApp.mainWindow.show();
  }
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
