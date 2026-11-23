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
interface MenuWindowWindow {
  isDestroyed: () => boolean;
  hide: () => void;
  close: () => void;
  showInactive: () => void;
  show: () => void;
  focus: () => void;
  isVisible: () => boolean;
  /** 2026-11-16：drag-and-drop 带内重顶，确保盖过桌宠窗 */
  moveTop: () => void;
  setAlwaysOnTop: (flag: boolean, level?: 'screen-saver' | 'drag-and-drop') => void;
  isAlwaysOnTop: () => boolean;
  getBounds: () => { x: number; y: number; width: number; height: number };
  setBounds: (b: { x: number; y: number; width: number; height: number }) => void;
  setPosition: (x: number, y: number) => void;
  center: () => void;
  loadFile: (filePath: string) => unknown;
  /** 窗口级事件（blur 失焦隐藏用） */
  on: (event: string, listener: (...args: any[]) => void) => void;
  webContents: {
    send: (channel: string, payload?: unknown) => void;
    /** 首开防竞态：loadFile 异步，isLoading 时挂 did-finish-load 再下发载荷（2026-11-15） */
    isLoading: () => boolean;
    once: (event: string, listener: (...args: any[]) => void) => void;
    /** 2026-11-16 诊断强化：load 生命周期取证 */
    getURL: () => string;
    on: (event: string, listener: (...args: any[]) => void) => void;
  };
}

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
  /** 托盘图标屏幕矩形：浮层定位锚点（2026-11-16 透明度浮层） */
  getBounds: () => { x: number; y: number; width: number; height: number };
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

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, nativeImage, screen, shell, powerMonitor, dialog } = require('electron') as {
  app: any;
  BrowserWindow: any;
  globalShortcut: any;
  /** IPC 注册面：handler 回调经此获得上下文类型（event/负载 any——与 .js 一致） */
  ipcMain: {
    handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
  };
  Tray: any;
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
// macOS（2026-11-22 启动不弹面板回归配套）：本应用是无 Dock 图标的后台工具，
// macOS 会对其施加 App Nap（定时器合流/渲染帧限频）——主面板弹出链依赖隐藏态
// 双 rAF 绘制确认，纳管冻结下 rAF 间歇停摆（实测 9s~146s，正常 0.8s）。
// 显式豁免；Windows/无此 API 的平台静默跳过。
if (process.platform === 'darwin' && typeof (app as any).setAppNapEnabled === 'function') {
  try { (app as any).setAppNapEnabled(false); } catch (_) { /* 老版本 Electron 无此 API */ }
}
// macOS（2026-11-18 实机修复「桌宠白色背景板」根因）：桌面 GPU 路径下 VP9 视频走
// VideoToolbox 硬件解码，macOS 27 + Chromium 120（Electron 28）组合丢失 WebM alpha
// 副通道 → 整帧不透明 → 露出素材白色 RGB 底（狗站在白卡片上）。CPU 软解路径 alpha
// 完好（沙箱无 GPU 取证：76% 全透 + 四角 alpha=0）。桌宠视频全在 petStage 渲染，
// 软解 1-2 路 220px 小视频 CPU 开销可忽略。Windows 无此问题，保持不变。
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
}
// macOS（2026-11-18 白底修复第二轮）：视频软解后桌面仍白卡 → 嫌疑上移到 GPU 合成器：
// Chromium 120 的 GPU 合成路径在 macOS 27 上传视频纹理时丢失 alpha（YUVA→RGBA 纹理
// 转换），软解开关只换解码器不换合成路径。整体 GPU 合成软件化（SwiftShader/Skia 软光
// 栅），本应用为小面板+小视频，性能影响可忽略。Windows 不变。
// 2026-11-20 白底根治第三轮：素材已重编码为真 alpha（绿幕+黑边洪泛抠像，yuva420p
// BlockAdditional），不再依赖 GPU 路径保留 alpha。且 Chromium 软件合成路径同样会丢
// 视频 alpha（disable-gpu 反而引入新白底风险），故回退本开关，保留软解开关。
// if (process.platform === 'darwin') {
//   app.commandLine.appendSwitch('disable-gpu');
// }
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
const skillsService = require('./skills-service') as typeof import('./skills-service');
const { WINDOW_WIDTH, WINDOW_HEIGHT } = require('./window-dims') as typeof import('./window-dims');
const crashDump = require('./crash-dump') as typeof import('./crash-dump');
const { normalizeScale, normalizeHideMode, buildPetStageBounds, clampPetPosition, computePetIgnore, computePetHit, isInPetShowGrace, computeCtxPullBack, shouldShowPetTrayItems, isDebugMenuAllowed } = require('./pet-manager') as typeof import('./pet-manager');
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

// 启动取证（2026-11-22）：进程一进入 main 就落盘一行。出现「拿锁后零日志」的
// 僵尸实例（11:18 实锤：NSApplication 注册后 JS 未推进 whenReady）时，有此行
// = JS 顶层跑过、卡点在 whenReady/init 内（看后续阶段标记）；无此行 = 原生
// 初始化即挂（对照 .ips 崩溃报告）。
_modDiag('[Boot] main 进程进入（pid=' + process.pid + ' ppid=' + process.ppid
  + ' platform=' + process.platform + '）');

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
  /** 桌宠显示时刻（Date.now，2026-11-19 二次修复）：show 后 ~900ms 宽限期强制整窗交互，
   *  防「显示后鼠标从别处移入时首次 mousedown 落在穿透窗被吞」。0 = 无宽限期。 */
  _petShownAt: number = 0;
  _petShowGraceMs: number = 900;
  _petGraceWasActive: boolean = false; // 上一 tick 是否处于显示宽限期（检测结束边沿用）
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
  menuWindow: MenuWindowWindow | null = null; // 互动二级菜单独立窗（2026-11-15 L3 pet-menu-window，懒创建）
  trayMenuWindow: MenuWindowWindow | null = null; // 统一托盘菜单浮窗（2026-11-16，懒创建单例，含透明度滑块）
  skillsWindow: MenuWindowWindow | null = null; // 形象工坊：Skills 预览 + 多平台导入浮窗（2026-11-18，懒创建单例）
  _menuShownAt: number = 0;
  _menuWinPollId: ReturnType<typeof setInterval> | null = null; // 菜单窗出界关闭轮询（2026-11-16 主进程接管）
  _menuWinReveal: (() => void) | null = null; // 菜单窗显示回调（loadFile promise / did-finish-load 双路触发）
  /** v14.3：猫心相对桌宠窗左上角的局部偏移，拖拽时据此换算新猫心 → 菜单跟随重排。 */
  _menuCatOffsetInPet: { x: number; y: number } | null = null;
  /** v14.3：拖拽期间的菜单跟随节流时间戳（30Hz，与桌宠 drag-move 同频）。 */
  _menuReflowAt: number = 0;
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
    // 统一 HTML 浮窗菜单（2026-11-16 小M）：原生 Menu.buildFromTemplate 不支持滑块与
    // 自定义外观，托盘菜单整体改由 tray-menu.html 浮窗承载（透明度滑块内嵌其中）。
    // 菜单项数据经 _trayTemplate() + _traySerialize() 下发，click 经 action id 分发回原函数。
    this.tray!.on('right-click', () => this._showTrayMenu());
    if (process.platform === 'darwin') {
      // macOS：原生行为是左键弹菜单，改为左键弹浮窗
      this.tray!.on('click', () => this._showTrayMenu());
    } else {
      // Windows/Linux：保留左键切换面板，右键弹浮窗菜单
      this.tray!.on('click', () => this.toggleWindow());
    }
  }

  /** 托盘菜单模板（原 Menu.buildFromTemplate 数组原地搬移，click 业务逻辑零改动）。
   *  由 _traySerialize() 转成可下发模型；透明度两入口在序列化时转为内嵌滑块节点。 */
  _trayTemplate(): any[] {
    return [
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
        // 2026-11-16 小M：桌宠专属项，仅 pet 模式展示（edge/hidden 无桌宠可调）
        label: '点击桌宠时唤出面板',
        visible: this._petTrayItemsVisible(),
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
        visible: this._petTrayItemsVisible(),
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
        visible: this._petTrayItemsVisible(),
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
        // 2026-11-16 小M：调试入口仅限 start:dev（NODE_ENV=development 且未打包）
        // npm start（未打包但无 NODE_ENV）不展示；旧口径 !app.isPackaged 会误放行 start
        label: '调试模式（主面板 DevTools）',
        visible: this._debugAllowed(),
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
        // 2026-11-16 小M：桌宠 DevTools 双门槛——start:dev 且 pet 模式（无桌宠时该入口无意义）
        label: '调试模式（桌宠 DevTools）',
        visible: this._debugAllowed() && this._petTrayItemsVisible(),
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
      {
        // 2026-11-16 小M：固定档透明度滑块（序列化为 slider 节点内嵌到统一浮窗）
        label: '固定透明度…',
      },
      { type: 'separator' },
      {
        label: '自动隐藏倒计时',
        submenu: this._buildHideDelaySubmenu(),
      },
      {
        // 2026-11-16 小M：穿透档透明度滑块（序列化为 slider 节点内嵌到统一浮窗）
        label: '穿透透明度…',
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
    ];
  }

  /** 调试入口许可（2026-11-16 小M）：仅 start:dev（NODE_ENV=development 且未打包）。
   *  托盘调试项 visible / F12 快捷键 / DevTools 自动打开三处统一走此判定，
   *  杜绝 npm start（未设 NODE_ENV）也冒出调试入口。 */
  _debugAllowed(): boolean {
    return isDebugMenuAllowed(app.isPackaged, process.env.NODE_ENV);
  }

  /** 托盘桌宠专属项可见性（2026-11-16 小M）：仅 pet 模式；edge/hidden 收敛掉。 */
  _petTrayItemsVisible(): boolean {
    return shouldShowPetTrayItems(this._getHideMode());
  }

  /**
   * 序列化托盘菜单模板为可下发模型（2026-11-16 小M）。
   * 原生 template 的 click 函数无法跨 IPC 传递：为每个可点项分配 action id，
   * 函数存入 _trayActions 表，渲染层点击时带 id 回传，由 _dispatchTrayAction 执行。
   * 透明度两入口（label 含「透明度…」）转成 slider 节点，内嵌到浮窗菜单里。
   */
  /** click 回调签名：原生 checkbox/radio 的 click 会收到 menuItem（含 checked），
   *  其余项无参。HTML 浮窗化后由渲染层回传 checked，_dispatchTrayAction 合成
   *  menuItem 传入，避免依赖 menuItem.checked 的开关全部 TypeError。 */
  _trayActions: Record<string, (menuItem?: { checked: boolean }) => void> = {};
  _serializeTrayTemplate(): Record<string, unknown>[] {
    this._trayActions = {};
    let seq = 0;
    const serialize = (items: any[]): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      for (const it of items) {
        if (it && it.visible === false) continue; // 模式门控：不可见项直接剔除
        if (it && it.type === 'separator') { out.push({ type: 'separator' }); continue; }
        // 透明度入口 → 内嵌滑块节点（focus 令牌用于打开时高亮）
        if (it && typeof it.label === 'string' && /透明度…$/.test(it.label)) {
          out.push({ type: 'slider', kind: it.label.indexOf('固定') === 0 ? 'pinned' : 'passthrough', label: it.label });
          continue;
        }
        const node: Record<string, unknown> = {
          label: it && it.label ? String(it.label) : '',
          type: it && it.type ? it.type : 'normal',
          checked: !!(it && it.checked),
          hasSubmenu: !!(it && Array.isArray(it.submenu) && it.submenu.length > 0),
        };
        if (it && typeof it.click === 'function') {
          const id = 'act_' + (seq++);
          this._trayActions[id] = it.click;
          node.action = id;
        }
        if (it && Array.isArray(it.submenu) && it.submenu.length > 0) {
          node.children = serialize(it.submenu);
        }
        out.push(node);
      }
      return out;
    };
    return serialize(this._trayTemplate());
  }

  /** 执行渲染层回传的菜单动作（经 action id 查表，复用原 template click 函数）。
   *  checkbox/radio 项由渲染层带 checked 回传，这里合成 menuItem 传入，
   *  让 click:(menuItem)=>menuItem.checked 的开关真正生效（原生菜单语义对齐）。 */
  _dispatchTrayAction(id: unknown, checked?: unknown): void {
    if (typeof id !== 'string') return;
    const fn = this._trayActions[id];
    if (typeof fn === 'function') {
      try {
        if (typeof checked === 'boolean') fn({ checked: checked });
        else fn();
      } catch (_) { /* 单项动作异常不阻断菜单 */ }
    }
  }

  /** 统一托盘菜单浮窗（2026-11-16 小M）：整份托盘菜单 HTML 化，沿用透明度弹窗观感。
   *  无边框 + 透明 + 不入任务栏，锚定托盘图标弹出，失焦隐藏、Esc 关闭。
   *  菜单模型由 _serializeTrayTemplate() 生成（含内嵌透明度滑块），action 经 IPC 分发。
   *  2026-11-16 定位修正：初始窗高按内容收缩（避免固定 520 造成底部空白），
   *  渲染层实测内容后经 tray-menu:resize 回传真实尺寸再重定位。 */
  _showTrayMenu(): void {
    if (!this.trayMenuWindow || this.trayMenuWindow.isDestroyed()) {
      const win = new BrowserWindow({
        width: 320,
        height: 440,
        frame: false,
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        show: false,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          sandbox: false,
        },
      });
      win.loadFile(path.join(__dirname, '../renderer/tray-menu.html'));
      win.on('closed', () => { this.trayMenuWindow = null; });
      win.on('blur', () => { if (!win.isDestroyed()) win.hide(); });
      this.trayMenuWindow = win;
    }
    const win = this.trayMenuWindow!;
    const payload = {
      items: this._serializeTrayTemplate(),
      pinned: this._getPinnedOpacity() ?? 0.6,
      passthrough: this._getPassthroughOpacity() ?? 0.5,
    };
    const deliver = () => { if (!win.isDestroyed()) win.webContents.send('tray-menu:init', payload); };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
    else deliver();
    this._positionTrayPopup(win);
    win.show();
    win.focus();
  }

  /** 计算托盘浮窗目标坐标（纯计算，无窗口副作用）：以托盘图标矩形为锚点，贴图标上方弹出；
   *  菜单右缘对齐图标右缘（托盘在屏幕右下角，水平居中会整体左偏）；高度取传入内容高，
   *  底边紧贴图标上方；上下 clamp 防越出物理屏。
   *  2026-11-17 抖动修复：从定位方法里抽出，供 resize 复用——先用「新尺寸」算好目标坐标，
   *  再一次 setBounds({x,y,w,h}) 落地，消除旧实现「setBounds 旧坐标 → setPosition 新坐标」
   *  两次几何变更导致的透明窗 DWM 表面重分配「右扩→左移」抖动。 */
  _computeTrayPopupRect(w: number, h: number): { x: number; y: number } {
    let ax = 0, ay = 0, ar = 0; // 锚点（托盘图标中心 x/y + 右缘 x）
    try {
      const tb = this.tray && !this.tray.isDestroyed() ? this.tray.getBounds() : null;
      if (tb && tb.width > 0 && tb.height > 0) {
        ax = tb.x + tb.width / 2;
        ay = tb.y + tb.height / 2;
        ar = tb.x + tb.width;
      }
    } catch (_) { /* 托盘取矩形失败：回落屏幕右下角 */ }

    // 取锚点所在显示器工作区（无托盘锚点时用主显示器）
    let wa = { x: 0, y: 0, width: 0, height: 0 };
    try {
      const anchor = (ax || ay) ? { x: Math.round(ax), y: Math.round(ay), width: 1, height: 1 } : { x: 0, y: 0, width: 1, height: 1 };
      const d = screen.getDisplayMatching(anchor);
      wa = d && d.workArea ? d.workArea : wa;
    } catch (_) { /* 保留全屏兜底 */ }
    if (!wa.width || !wa.height) {
      try { wa = screen.getPrimaryDisplay().workArea; } catch (_) { /* 保留零值兜底 */ }
    }

    const GAP = 8; // 弹窗底边与托盘图标的间距
    // 水平：菜单右缘对齐托盘图标右缘（无锚点时回落居中），靠右下角托盘不会被裁切
    let x = ar ? ar - w : ax - w / 2;
    // 垂直：底边贴图标上方
    let y = ay - h - GAP;
    // 上方空间不足（任务栏在顶部）时翻到图标下方
    if (wa.height && y < wa.y) y = ay + GAP;
    // clamp 到工作区（物理屏可视范围）
    if (wa.width) x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    if (wa.height) y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    return { x: Math.round(x), y: Math.round(y) };
  }

  /** 托盘菜单浮窗定位（首次显示）：按当前窗口尺寸算目标坐标后 setPosition。 */
  _positionTrayPopup(win: MenuWindowWindow): void {
    const { width: w, height: h } = win.getBounds();
    const { x, y } = this._computeTrayPopupRect(w, h);
    win.setPosition(x, y);
  }

  /** 渲染层实测内容尺寸后回传（2026-11-16）：贴合内容收缩窗口 + 重新定位，
   *  消除固定高造成的底部空白。带上限保护，异常值忽略，同尺寸幂等。 */
  _resizeTrayPopup(w: unknown, h: unknown): void {
    const win = this.trayMenuWindow;
    if (!win || win.isDestroyed()) return;
    if (typeof w !== 'number' || !Number.isFinite(w) || typeof h !== 'number' || !Number.isFinite(h)) return;
    const width = Math.max(240, Math.min(560, Math.round(w)));
    const height = Math.max(160, Math.min(560, Math.round(h)));
    const b = win.getBounds();
    if (b.width === width && b.height === height) return;
    // 抖动修复：用「新尺寸」先算好目标坐标，新尺寸 + 新坐标在单次 setBounds 里一起落地。
    // 透明窗只触发一次几何变更/表面重分配，不再「旧坐标扩张 → 再左移对齐」两跳。
    const { x, y } = this._computeTrayPopupRect(width, height);
    win.setBounds({ x, y, width, height });
  }

  /** 形象工坊窗口：居中显示于锚点所在显示器工作区，clamp 防越屏。
   *  内容型窗口（非贴托盘），按当前 bounds 居中。 */
  _positionSkillsWindow(win: MenuWindowWindow): void {
    const b = win.getBounds();
    let wa = { x: 0, y: 0, width: 0, height: 0 };
    try { wa = screen.getPrimaryDisplay().workArea; } catch (_) { /* 零值兜底 */ }
    if (!wa.width || !wa.height) { win.center(); return; }
    let x = wa.x + (wa.width - b.width) / 2;
    let y = wa.y + (wa.height - b.height) / 2;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - b.width));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - b.height));
    win.setPosition(Math.round(x), Math.round(y));
  }

  /** 形象工坊（2026-11-18）：打开应用内 Skills 预览 + 多平台导入浮窗。
   *  懒创建单例；无边框 + 透明 + 不入任务栏；失焦隐藏、Esc 关闭（渲染层）。
   *  数据经 skills:init 下发（本地 skill 列表 + 平台检测结果）。 */
  _showSkillsWindow(): void {
    if (!this.skillsWindow || this.skillsWindow.isDestroyed()) {
      const win = new BrowserWindow({
        width: 880,
        height: 620,
        minWidth: 560,
        minHeight: 400,
        frame: false,
        transparent: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: false,
        show: false,
        backgroundColor: '#f5f6fa',
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          sandbox: false,
        },
      }) as unknown as MenuWindowWindow;
      win.loadFile(path.join(__dirname, '../renderer/skills-window.html'));
      win.on('closed', () => { this.skillsWindow = null; });
      win.on('blur', () => { if (!win.isDestroyed()) win.hide(); });
      this.skillsWindow = win;
    }
    const win = this.skillsWindow!;
    const deliver = () => {
      if (win.isDestroyed()) return;
      const skillsRoot = path.join(__dirname, '../../skills');
      win.webContents.send('skills:init', {
        skills: skillsService.listLocalSkills(skillsRoot),
        platforms: skillsService.detectPlatforms(),
        skillsRoot,
      });
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
    else deliver();
    this._positionSkillsWindow(win);
    win.show();
    win.focus();
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
        // 显示兜底由 EdgeDetector 的 prepare 硬超时承担（2026-11-22）：此处曾加同步
        // showInactive 兜底，实测无效——页面未就绪时显示的是 prepare 透明态/空白窗，
        // 且绕过 _beginShowTransition 会错置 _petAwaitPanelEnter，已移除。
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
    // macOS Electron 对 220px 左右的小型透明窗口存在原生表面变白问题
    //（Electron #38630/#44884）。宿主放大但渲染层宠物仍保持 210px，绕开该路径。
    const petHostSize = process.platform === 'darwin' ? 360 : 220;
    const win = new BrowserWindow({
      width: petHostSize,
      height: petHostSize,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      // macOS（2026-11-17 实机修复「桌宠白色背景」根因）：focusable:false 在 darwin
      // 走 NSPanel 路径，透明舞台在 NSPanel 上渲染白底（整块白色背景的真正来源）——
      // 与 triggerWindow 2026-11-11「小白框」同源（同注释）。triggerWindow 的成功修法：
      // mac 改普通窗口 + showInactive 不夺焦 + 点击穿透，行为等价。petStage 显示本就
      // 走 showInactive（_showPetWindow），命中穿透由 setIgnoreMouseEvents 自持轮询驱动，
      // 与 focusable 无关，故 macOS 置 focusable:true 即可消除 NSPanel 白底。
      // Windows 保持 focusable:false 不变（无 NSPanel 路径；focus-tracker 链路安全）。
      focusable: process.platform === 'darwin',
      // 系统圆角+阴影一并关（darwin 下 frame:false 仍保留 Cocoa 强制圆角/投影，
      // 透明舞台表现为圆角灰白描边）。两开关仅 darwin 生效，其余平台无行为变化。
      ...(process.platform === 'darwin' ? { hasShadow: false, roundedCorners: false } : {}),
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
    // macOS 不夺焦守卫（2026-11-17，配套 focusable 普通窗口化）：普通窗口点击会被
    // 系统激活（夺走用户当前应用焦点），破坏「桌宠永不跟焦」架构（focus-tracker 的
    // 粘贴目标跟踪依赖前台窗口稳定）。聚焦后延迟释放——延迟窗口内渲染层仍可收
    // keydown（右键菜单 Esc 关闭在普通窗口下恢复可用）；fire 时拖拽已开始则豁免
    // （mousedown→dragstart 间隙立即 blur 会扰动手势输入面）。等价 Windows 侧
    // _applyNoActivate 的 NOACTIVATE 语义（mac 无该样式，用 blur 兜底）。
    if (process.platform === 'darwin') {
      let _petBlurTimer: ReturnType<typeof setTimeout> | null = null;
      const _petCreatedAt = Date.now();
      // 启动宽限（2026-11-22 回归修复）：启动后 ~1.5s 内 petStage 的 showInactive/
      // setBounds 自碰会激活窗口并触发 focus → 120ms 后 blur。若此期间主面板正在
      // 走「启动优先展示」焦点链（forceShow→prepare→show→focus），blur 会把焦点
      // 释放给前一个应用、打断面板弹出（实机：今天起启动后主面板不主动弹出）。
      // 宽限期内不抢也不释放——该窗口期的夺焦由主面板自身流程接管；宽限期后
      // blur 守卫恢复「永不跟焦」语义（点击穿透自持，与启动无关）。
      const _startupGraceUntil = _petCreatedAt + 1500;
      win.on('focus', () => {
        if (Date.now() < _startupGraceUntil) return;
        if (_petBlurTimer) clearTimeout(_petBlurTimer);
        _petBlurTimer = setTimeout(() => {
          _petBlurTimer = null;
          if (this._petDragOffset == null && !win.isDestroyed()) {
            try { win.blur(); } catch (_) { /* 竞态静默 */ }
          }
        }, 120);
      });
    }
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
      // 调试模式判定（2026-11-16 小M 收紧）：仅 start:dev（NODE_ENV=development）且
      // config.petDebugMode=true 才自动打开 petStage DevTools。
      // 旧口径只看 _petDebugMode（config 持久化）——npm start 若历史勾选过调试，
      // 重启仍会自动弹 DevTools；现加 _debugAllowed() 双门槛，start/打包版一律不开。
      // 单一来源（2026-11-13 窗口弹出治理）：_petDebugMode 在 init() 由 config 初始化，
      // 托盘开关同时写回内存 + config。
      const dbg = this._debugAllowed() && this._petDebugMode;
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
    // [ALPHA-PROBE-MAIN 2026-11-18] 白底修复取证（验收后移除）：窗口 show 后 8s 抓
    // petStage 合成画面落盘——capturePage 走窗口合成路径，与渲染层 canvas 探针（2D
    // 解码路径）对照，可区分「解码丢 alpha」vs「合成丢 alpha」。fire-once。
    if (!(this as any)._alphaProbeDone) {
      (this as any)._alphaProbeDone = true;
      const _probeLog = (m: string): void => { try { require('fs').appendFileSync('/tmp/pet-stage-capture.log', new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} };
      _probeLog('probe scheduled (showPetWindow)');
      setTimeout(() => {
        try {
          _probeLog('fire: destroyed=' + win.isDestroyed() + ' visible=' + win.isVisible());
          if (!win.isDestroyed()) {
            win.webContents.capturePage().then((img) => {
              try { require('fs').writeFileSync('/tmp/pet-stage-capture.png', img.toPNG()); _probeLog('capturePage saved'); }
              catch (e) { _probeLog('save fail: ' + String(e)); }
            }).catch((e) => _probeLog('capturePage reject: ' + String(e)));
          }
        } catch (e) { _probeLog('outer fail: ' + String(e)); }
      }, 8000);
    }
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
    // 显示后立即同步探测一次命中（2026-11-19 鼠标延迟根因修复）：
    // 旧实现显示后 cursorOnModel 恒 false → 整窗穿透，必须等 150ms 轮询且 body-rect
    // 已上报才翻回交互；视频首帧未就绪时轮询短路 → 鼠标"等半天"没响应。
    // 现在 show 当场按当前光标位置判一次（body-rect 未就绪回退整窗命中），即时可点；
    // 后续 body-rect 到位/轮询会再精判，收敛到真实轮廓。
    // 2026-11-19 二次修复：仅"显示瞬间鼠标恰在窗口内"仍不够——真实场景是显示后鼠标
    // 从别处移入，穿透态吞掉首次 mousedown。记录显示时刻开宽限期，窗口强制整窗交互
    // ~900ms，保证首次点击必达；宽限期过后交回轮廓命中（透明区恢复让行）。
    this._petShownAt = Date.now();
    this._probePetCursorHit();
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
  /** 桌宠形象列表（2026-11-16 小M「形象不应为空，内置比熊」修复）：
   *  实际发行版不含 Live2D models/ 目录（该目录从未随包分发），旧实现读它恒空 →
   *  托盘「桌宠形象」子菜单永远空白。真实内置形象是 webm 比熊（pet-moves/ 22 动作，
   *  白色比熊 + 浅蓝围巾）。故无 Live2D 模型时回退列出内置比熊项；若用户后续放入
   *  Live2D 模型，则按名列出（内置比熊仍恒在首位作为可切回的默认形象）。 */
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
    } catch (_) { /* 目录缺失：走内置比熊回退 */ }
    // 内置比熊（webm）恒首位；移除旧的 hiyori 占位（其模型文件并不存在）
    const builtin = '比熊（内置）';
    const filtered = out.filter((n) => n !== builtin && n !== 'hiyori');
    return [builtin, ...filtered];
  }

  /** 内置比熊标识（webm 形象，清除 Live2D 覆盖走默认回退链） */
  static readonly PET_MODEL_BUILTIN = '比熊（内置）';

  _getPetModel(): string {
    try {
      const m = this.storage._readConfig().petLive2dModel;
      if (typeof m === 'string' && m) return m;
    } catch (_) { /* 回落默认 */ }
    // 无覆盖 = 内置比熊（webm 回退链），与菜单单选态一致
    return '比熊（内置）';
  }

  /** 切换形象：持久化 → 重建舞台（loadFile 重新走 enterLive2dMode，from 失败自动回退 webm 比熊） */
  _setPetModel(name: string): void {
    if (typeof name !== 'string' || !name) return;
    // 内置比熊 = 清除 Live2D 覆盖（petLive2dModel=null → 渲染层回落默认 → webm 比熊）
    const writeValue = name === '比熊（内置）' ? null : name;
    try { this.storage._writeConfig({ petLive2dModel: writeValue }); } catch (_) { /* 持久化失败不阻断 */ }
    // 舞台重建 = 最简热切换（模型加载失败时渲染层既有回退链自动落 hiyori/webm）
    if (this.petStage && !this.petStage.isDestroyed()) {
      this._destroyPetStage();
    }
    if (this._petModeOn) this._createPetStage();
    this.initTray(); // 重建单选态
  }

  /** 舞台逻辑尺寸：macOS 使用 360px 透明宿主（绕开小窗口白底），其他平台 220px；
   *  live2d 大档（2.0/2.2）模型高度超 220 窗口 → 头顶被裁（小M 实机截图实证）。
   *  底边锚定不变：调用方 setBounds 的 y = 旧底边 - 新高度。 */
  _petStageSize(): { w: number; h: number } {
    const base = process.platform === 'darwin' ? 360 : 220;
    const s = Math.round(base * (this._petScale || 1));
    return { w: s, h: s };
  }

  /** 底边锚定的 setBounds（x 同参；y 按新高度上移，窗口底边保持在原位） */
  /** 互动菜单窗隐藏（2026-11-15 L3 pet-menu-window） */
  _hideMenuWindow(): void {
    if (this.menuWindow && !this.menuWindow.isDestroyed()) this.menuWindow.hide();
  }

  /** 互动菜单窗会话收尾（2026-11-15 接线补全）：隐菜单窗 + 桌宠侧菜单态同步收尾
   *  （pet:ctx-hide 清渲染层态；还原拖拽位 + 穿透语义，与 pet:close-ctx 同语义） */
  _closeMenuSession(): void {
    // 销毁式关闭（2026-11-16 小M「第二次展开点不动」根因修复）：原 hide 复用——
    // Windows 透明无边框窗 hide→showInactive 循环后鼠标命中区域失效（Electron 已知
    // 问题类别），第二次展开看得见点不动。改 close() 销毁，第二次必走已实测可点击的
    // 新建路径（loadFile 有 did-finish-load/promise/did-fail-load/1.5s 四路 reveal 保险）。
    if (this.menuWindow && !this.menuWindow.isDestroyed()) this.menuWindow.close();
    this.menuWindow = null;
    this._menuWinReveal = null;
    if (this._menuWinPollId) { clearInterval(this._menuWinPollId); this._menuWinPollId = null; }
    const win = this.petStage;
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('pet:ctx-hide'); } catch (_) { /* 销毁竞态 */ }
    const saved = this._petCtxSaved;
    this._petCtxSaved = null;
    this._petCtxOpen = false;
    if (this._petCtxPollId) { clearInterval(this._petCtxPollId); this._petCtxPollId = null; }
    if (saved) win.setBounds(saved);
    this._applyPetIgnore();
  }

  /** 互动菜单窗懒创建（透明环形窗，尺寸随环半径自适应，drag-and-drop 置顶带，不夺焦）
   *  2026-11-16 诊断强化：全量挂载 load 生命周期诊断（did-fail-load / render-process-gone /
   *  renderer console-message 转发落盘）——09:56 实测「互动点击后菜单窗渲染进程已创建
   *  （no-sandbox renderer client-id 7 与点击时刻吻合）但 did-finish-load 从未触发 →
   *  reveal 永不执行 → 窗口永 show:false」。此前 load 失败完全静默，无法取证。 */
  _ensureMenuWindow(): void {
    if (this.menuWindow && !this.menuWindow.isDestroyed()) return;
    const mw = new BrowserWindow({
      width: 240,
      height: 240,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        backgroundThrottling: false,
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });
    // 置顶等级 'drag-and-drop'（2026-11-16 小M「菜单不可见」第三根因）：桌宠窗同为
    // 'screen-saver' 带，同级带内 petStage 的显隐/置顶自愈会把它顶到菜单窗之上——
    // 菜单窗（130×130）与桌宠窗（112×115）中心重合，被盖即全盲。drag-and-drop 是
    // Electron 最高置顶等级，严格高于 screen-saver，免疫桌宠侧任何重申。
    mw.setAlwaysOnTop(true, 'drag-and-drop');
    // load 生命周期诊断（先挂监听再 loadFile，杜绝事件先于监听的竞态）
    mw.webContents.on('did-finish-load', () => {
      _modDiag('[MenuWin] did-finish-load isLoading=' + mw.webContents.isLoading());
      try { this._menuWinReveal?.(); } catch (_) { /* reveal 内部自有诊断 */ }
    });
    mw.webContents.on('did-fail-load', (_e: unknown, code: number, desc: string, url: string) => {
      _modDiag(`[MenuWin] did-fail-load code=${code} desc=${desc} url=${url}`);
    });
    mw.webContents.on('render-process-gone', (_e: unknown, details: { reason: string }) => {
      _modDiag(`[MenuWin] render-process-gone reason=${details && details.reason}`);
    });
    mw.webContents.on('console-message', (_e: unknown, level: number, message: string) => {
      _modDiag(`[MenuWin:console:L${level}] ${String(message).split('\n').join(' | ').slice(0, 300)}`);
    });
    // loadFile promise 直接触发 reveal（2026-11-16 第二保险）：不依赖 webContents 事件派发
    mw.loadFile(path.join(__dirname, '../renderer/menu-window.html'))
      .then(() => {
        _modDiag('[MenuWin] loadFile promise resolved');
        try { this._menuWinReveal?.(); } catch (_) { /* reveal 内部自有诊断 */ }
      })
      .catch((err: unknown) => _modDiag(`[MenuWin] loadFile promise REJECTED: ${err instanceof Error ? err.message : String(err)}`));
    this.menuWindow = mw; // v5.4 缺失实锤（小M：菜单全不可见）：未回填则本字段永 null，
    // 后续 mw.setBounds 即抛 TypeError，菜单窗从未显示
    _modDiag('[MenuWin] 窗口已创建，loadFile 已发起');
  }

  /** 菜单窗定位 + 显示（拉回后调用）：中心对齐猫屏幕坐标，clamp 工作区；
   *  首开时 loadFile 异步——isLoading 时挂 did-finish-load 再下发载荷/显示（防 send 丢失）。
   *  出界关闭轮询主进程接管（2026-11-16）：渲染层 menu-window.html 原自轮询两处硬伤——
   *  ① petArea 从未赋值（恒 null → 桌宠区判定恒 false）；② cursorIn 拿 screenX/screenY
   *  比视口客户区 rect（坐标系错位 → 菜单区判定恒 false）→ show 后 ~300ms 必自关
   *  （小M 实测「动作管理不可见」根因）。主进程 getCursorScreenPoint 直读屏幕坐标，
   *  菜单窗 bounds ∪ 桌宠窗 bounds 联合判定，出界 300ms 关（与 _petCtxPollId 同构）。 */
  /** v14.3 菜单布局纯计算：给定猫心屏幕坐标与半径，算菜单窗 bounds + 扇形中轴 + 四边余量。
   *  弹出与拖拽跟随共用同一份口径，避免两处公式漂移（D8 确定性规则）。 */
  _computeMenuLayout(catXInt: number, catYInt: number, radius: number): {
    mx: number; my: number; mW: number; mH: number;
    fanMid: number; catLocal: { x: number; y: number };
    gaps: { gapL: number; gapR: number; gapT: number; gapB: number };
  } {
    const { screen } = require('electron');
    const mW = Math.round(2 * (radius + 78)), mH = mW;
    const wa = screen.getDisplayMatching({ x: catXInt, y: catYInt, width: 10, height: 10 }).workArea;
    const mx = Math.round(Math.min(Math.max(catXInt - mW / 2, wa.x + 4), wa.x + wa.width - mW - 4));
    const my = Math.round(Math.min(Math.max(catYInt - mH / 2, wa.y + 4), wa.y + wa.height - mH - 4));
    const gapL = catXInt - wa.x, gapR = wa.x + wa.width - catXInt;
    const gapT = catYInt - wa.y, gapB = wa.y + wa.height - catYInt;
    const gaps = [gapR, gapB, gapL, gapT]; // 对应角度 0(右)/90(下)/180(左)/270(上)
    const maxGap = Math.max.apply(null, gaps);
    const secondGap = Math.max.apply(null, gaps.filter((g) => g < maxGap));
    let fanMid = 0; // 默认右半圆
    if (maxGap - secondGap >= 40) fanMid = gaps.indexOf(maxGap) * 90;
    return {
      mx, my, mW, mH, fanMid,
      catLocal: { x: catXInt - mx, y: catYInt - my },
      gaps: { gapL, gapR, gapT, gapB },
    };
  }

  /** v14.3 拖拽跟随：菜单窗跟随桌宠新位置重定位 + 重算扇形朝向，补一帧轻量 reflow。
   *  不重播展开动画、不重建叶子，只平移窗口 + 更新环心/中轴/半径并让渲染层重新 place()。 */
  _followMenuToPet(): void {
    const mw = this.menuWindow;
    const win = this.petStage;
    if (!mw || mw.isDestroyed() || !mw.isVisible()) return;
    if (!win || win.isDestroyed() || !this._menuCatOffsetInPet) return;
    const b = win.getBounds();
    const catXInt = Math.round(b.x + this._menuCatOffsetInPet.x);
    const catYInt = Math.round(b.y + this._menuCatOffsetInPet.y);
    const s = Math.min(Math.max(this._getPetScale() || 1, 0.5), 2.2);
    const radius = Math.round(105 * s + 32);
    const L = this._computeMenuLayout(catXInt, catYInt, radius);
    mw.setBounds({ x: L.mx, y: L.my, width: L.mW, height: L.mH });
    // 轻量 reflow：渲染层只更新环心/中轴/半径并 place()，不动叶子/动画/确认态。
    mw.webContents.send('pet-menu:reflow', {
      radius, fanMid: L.fanMid, catLocal: L.catLocal,
    });
    mw.moveTop(); // 拖到新位置保持盖过桌宠窗
  }

  _openMenuWindowAt(catScreenX: number, catScreenY: number, petBounds: { x: number; y: number; width: number; height: number }, level: 'main' | 'mode' | 'interact' = 'interact', mode: 'pet' | 'edge' | 'hidden' = 'pet'): void {
    this._ensureMenuWindow();
    const mw = this.menuWindow;
    if (!mw || mw.isDestroyed()) { _modDiag('[MenuWin] openMenuWindowAt 退出：菜单窗不在场'); return; }
    // Electron 28 gin 原生 Rect 转换要求整数成员（2026-11-16 实锤根因）：猫心锚改
    // getBoundingClientRect 中心后坐标含小数，getDisplayMatching({x,y,…}) 收到浮点直接抛
    // "Error processing argument at index 0, conversion failure"，且被全局异常快照
    // （setupExceptionCapture 保活不退出）静默吞掉 → reveal 从未调度 → 菜单窗永不显示。
    // 所有 crash-logs/uncaughtException_*.log 每次点互动一条，全部是本处。
    const catXInt = Math.round(catScreenX);
    const catYInt = Math.round(catScreenY);
    const { screen } = require('electron');
    // 布局 v3（2026-11-16 终版：极简环形 + 展开动画）：v1 环形 R=40 压猫身（0.5×
    // 猫视觉半宽 52px）被遮；v2 卡片面板可用但丢掉极简交互。v3 回归环形悬浮叶，
    // 关键修正 = 环半径随猫视觉尺寸放大到猫身外围：R = 视频半宽(105×s) + 叶半宽(18)
    // + 间隙(14)，0.5× 档 R≈85、1× 档 R≈137，叶完整环抱猫身互不遮挡。
    // 菜单窗透明、尺寸随环自适应（可大于桌宠窗，不影响视觉），中心对齐猫心；
    // catLocal 下发猫在窗内的实际坐标（窗口被工作区 clamp 后仍精确环抱）。
    const s = Math.min(Math.max(this._getPetScale() || 1, 0.5), 2.2);
    const radius = Math.round(105 * s + 32);
    // 留白 78：一级 4 叶正下方一叶 hover 后叶半宽+标签下探 ≈72px，任意档位完整在窗内。
    // v14.3：布局口径抽到 _computeMenuLayout（弹出/拖拽共用），并记录猫心相对桌宠窗的
    // 局部偏移——拖拽时据此换算新猫心，菜单窗才能跟着猫同步平移与重排扇形。
    const L = this._computeMenuLayout(catXInt, catYInt, radius);
    const { mx, my, mW, mH, fanMid, catLocal } = L;
    this._menuCatOffsetInPet = {
      x: catXInt - petBounds.x,
      y: catYInt - petBounds.y,
    };
    mw.setBounds({ x: mx, y: my, width: mW, height: mH });
    const { gapL, gapR, gapT, gapB } = L.gaps;
    _modDiag(`[MenuWin] 扇形朝向 mid=${fanMid}° 余量 L=${gapL} R=${gapR} T=${gapT} B=${gapB}`);
    const reveal = () => {
      _modDiag(`[MenuWin] reveal 进入 isDestroyed=${mw.isDestroyed()}`);
      if (mw.isDestroyed()) return;
      // 打开瞬间光标屏幕坐标（菜单窗初始化联合出界判定——{-1,-1} 哨兵会误判出界闪灭）
      const cursor = screen.getCursorScreenPoint();
      mw.webContents.send('pet-menu:show', { petBounds, cursor, radius, catLocal, level, mode, fanMid });
      mw.showInactive();
      mw.moveTop(); // drag-and-drop 带内再顶一次，确保盖过桌宠窗（2026-11-16）
      // show 后 250ms 验证（取证 isVisible/实际 bounds，杜绝「显示了但看不见」的盲区）
      setTimeout(() => {
        if (mw.isDestroyed()) { _modDiag('[MenuWin] show后250ms 窗口已销毁'); return; }
        const vb = mw.getBounds();
        _modDiag(`[MenuWin] show后250ms isVisible=${mw.isVisible()} bounds=(${vb.x},${vb.y} ${vb.width}x${vb.height}) alwaysOnTop=${mw.isAlwaysOnTop()}`);
      }, 250);
      this._menuShownAt = Date.now();
      _modDiag(`[Pet] 菜单窗显示 (${mx},${my} ${mW}x${mH} 环R=${radius} s=${s}) 猫心=(${Math.round(catScreenX)},${Math.round(catScreenY)}) 桌宠窗=(${petBounds.x},${petBounds.y} ${petBounds.width}x${petBounds.height})`);
      // 出界关闭轮询（主进程接管）：覆盖旧轮询
      if (this._menuWinPollId) clearInterval(this._menuWinPollId);
      let outSince = 0;
      this._menuWinPollId = setInterval(() => {
        const w3 = this.menuWindow;
        if (!w3 || w3.isDestroyed() || !w3.isVisible()) {
          if (this._menuWinPollId) { clearInterval(this._menuWinPollId); this._menuWinPollId = null; }
          return;
        }
        const cur = screen.getCursorScreenPoint();
        const mb = w3.getBounds();
        const inMenu = cur.x >= mb.x && cur.x <= mb.x + mb.width && cur.y >= mb.y && cur.y <= mb.y + mb.height;
        const pb = (this.petStage && !this.petStage.isDestroyed()) ? this.petStage.getBounds() : petBounds;
        // z-order 维持（2026-11-16 小M 截图实锤：7 叶只露出左侧 4 叶，右侧 3 叶被猫盖住）：
        // 仅靠窗口创建时的 drag-and-drop 等级不足——桌宠侧的置顶自愈会重排 topmost 带。
        // 会话存活期每 120ms moveTop 一次，保证菜单叶始终压在桌宠窗之上。
        w3.moveTop();
        const inPet = cur.x >= pb.x && cur.x <= pb.x + pb.width && cur.y >= pb.y && cur.y <= pb.y + pb.height;
        if (!inMenu && !inPet) {
          if (!outSince) outSince = Date.now();
          else if (Date.now() - outSince > 300) {
            _modDiag(`[Pet] 菜单窗出界自动关闭 cur=(${cur.x},${cur.y}) 菜单窗=(${mb.x},${mb.y} ${mb.width}x${mb.height})`);
            this._closeMenuSession();
          }
        } else {
          outSince = 0;
        }
      }, 120);
    };
    // reveal-once（2026-11-16）：did-finish-load / loadFile promise / did-fail-load /
    // 1.5s 兜底定时器四路触发，任一路先到即显示
    let revealed = false;
    const revealOnce = () => {
      _modDiag(`[MenuWin] revealOnce 进入 revealed=${revealed} isDestroyed=${mw.isDestroyed()}`);
      if (revealed) return;
      revealed = true;
      try {
        reveal();
      } catch (err) {
        _modDiag(`[MenuWin] reveal 抛异常: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
      }
    };
    this._menuWinReveal = revealOnce; // 供 _ensureMenuWindow 的 loadFile promise / did-finish-load 触发
    mw.webContents.once('did-finish-load', revealOnce);
    mw.webContents.once('did-fail-load', (_e: unknown, code: number, desc: string) => {
      _modDiag(`[MenuWin] reveal 等待期间 did-fail-load code=${code} desc=${desc}（降级仍显示）`);
      revealOnce();
    });
    setTimeout(() => {
      _modDiag(`[MenuWin] 1.5s 兜底检查 revealed=${revealed} isDestroyed=${mw.isDestroyed()} isLoading=${mw.webContents.isLoading()}`);
      if (!revealed && !mw.isDestroyed()) revealOnce();
    }, 1500);
    if (!mw.webContents.isLoading()) revealOnce(); // 已加载完成（窗口复用）立即显示
  }

  /** 底边锚定 setBounds（2026-11-15 v5.3：可选 forceSize——形象工坊扩窗 260 用） */
  _setPetBoundsAnchored(x: number, bottomY: number, forceSize?: number): void {
    if (!this.petStage || this.petStage.isDestroyed()) return;
    const size = forceSize ?? this._petStageSize().w;
    this.petStage.setBounds({ x: Math.round(x), y: Math.round(bottomY - size), width: size, height: size });
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
    // 显示后宽限期（2026-11-19 二次修复）：show 后 ~900ms 强制整窗交互，
    // 覆盖「显示后鼠标从别处移入、首次 mousedown 落在穿透窗被吞」的场景。
    // 宽限期只压 ignore（让鼠标进得来），不改 _petCursorOnModel 轮廓语义；
    // 到期后自然回落 computePetIgnore 轮廓判定，透明区继续让行。
    const inGrace = isInPetShowGrace(Date.now(), this._petShownAt, this._petShowGraceMs);
    const ignore = inGrace ? false : computePetIgnore({
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

  /**
   * 同步探测一次光标命中并（沿变化时）翻转穿透态（2026-11-19 桌宠显示后鼠标延迟修复）。
   * 三个调用点共用：显示瞬间同步探测 / body-rect 到位立即重判 / 150ms 兜底轮询——
   * 判定统一收敛到 computePetHit 纯函数，杜绝三处口径分叉。
   * 关键兜底：body-rect 尚未上报时 computePetHit 回退整窗命中——保证显示瞬间
   * 鼠标就在窗口内时立即判为交互（旧实现轮询 `if(!bodyRect) return` 短路 → 全窗穿透）。
   */
  _probePetCursorHit(): void {
    const win = this.petStage;
    if (!win || win.isDestroyed()) return;
    if (this._petCtxOpen || this._petAltActive) return; // 交互/Alt 态由既有逻辑管
    if (this._petDragOffset) return; // B2 守卫：拖拽手势中不翻转（150ms 翻转吞 mousedown）
    const cur = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const hit = computePetHit(cur, b, this._petBodyRect, this._petCursorOnModel);
    if (hit !== this._petCursorOnModel) {
      this._petCursorOnModel = hit;
      _modDiag('[Pet] probe hit=' + hit + ' cur=(' + cur.x + ',' + cur.y + ') win=(' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height + ') body=' + JSON.stringify(this._petBodyRect));
      this._applyPetIgnore();
      // hover 链路：命中沿变化合成 mousemove（渲染层 reportHit 触发进入/离开语义）
      try {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(cur.x - b.x), y: Math.round(cur.y - b.y) });
      } catch (_) { /* 竞态静默 */ }
    }
  }

  /** 命中穿透轮询（150ms，惰性启动）：置顶/显隐自愈 + 命中兜底探测（2026-10-23 / 11-19） */
  _ensurePetHitPoll(): void {
    if (this._petHitPollId) return;
    this._petHitPollId = setInterval(() => {
      const win = this.petStage;
      if (!win || win.isDestroyed()) return;
      // 置顶自愈：模式切换/hide→show 周期可能掉出 topmost 带，50ms 内补回
      if (!win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, 'screen-saver');
      }
      // 显隐自愈（2026-11-04 Bug：桌宠不稳定不显示/疑似未置顶）：取证 TOPMOST 恒 true，
      // 非置顶不成立；主嫌疑是 setOnShown 隐藏 ↔ setOnHidden 召回的时序缝隙。
      // 面板已收起但舞台不可见 → 幂等重 show（showInactive 不夺焦）。
      if (!win.isVisible()) {
        const panelVisibleNow = this.edgeDetector ? this.edgeDetector.isWindowVisible : false;
        if (!panelVisibleNow) {
          this._showPetWindow();
        }
      }
      // 命中判定（含迟滞 + body-rect 兜底），与显示瞬间探测同口径。
      // 轮询间隔 150→50ms（2026-11-19 二次修复）：鼠标从别处移入本体后更快翻回交互，
      // 降低「等半天」感知；置顶/显隐自愈同频受益。
      this._probePetCursorHit();
      // 显示宽限期结束边沿（2026-11-19 二次修复）：宽限期内 ignore 被强制 false，
      // 若光标一直在透明区，probe 因 hit 未变不会重判 → 透明区长期不穿透。
      // 检测 true→false 边沿，到期强制重算一次 ignore，恢复轮廓让行语义。
      const graceNow = isInPetShowGrace(Date.now(), this._petShownAt, this._petShowGraceMs);
      if (this._petGraceWasActive && !graceNow) {
        this._applyPetIgnore();
      }
      this._petGraceWasActive = graceNow;
    }, 50);
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

  /** 固定档透明度（2026-11-16 滑块窗）：读 config，null=默认 60% */
  _getPinnedOpacity(): number | null {
    try {
      const v = this.storage._readConfig().pinnedOpacity;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) return v;
    } catch (_) { /* 读取失败回落默认 */ }
    return null;
  }

  _setPinnedOpacity(v: number | null): void {
    try { this.storage._writeConfig({ pinnedOpacity: v }); } catch (_) { /* 持久化失败不阻断 */ }
    if (this.edgeDetector) this.edgeDetector.setPinnedOpacity(v);
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
      // 2026-11-16 小M：F12 调试快捷键仅限 start:dev（与托盘调试项同口径）
      // npm start（未设 NODE_ENV）与打包版均不注册生效——杜绝 start 模式冒出调试入口
      if (!this._debugAllowed()) return;
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
    // 形象工坊（2026-11-18 升级）：桌宠菜单 🎨 入口 → 打开应用内 Skills 预览 + 多平台导入浮窗。
    // 旧版（2026-11-13）是用系统浏览器打开 SKILL.md，现由 skills-window 承载预览与导入。
    ipcMain.handle('pet:open-skill', async () => {
      try {
        this._showSkillsWindow();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // 形象工坊数据面：读取单个 Skill 全文（供预览窗切换选中项时拉取）
    ipcMain.handle('skills:detail', (_e: unknown, id: unknown) => {
      const skillsRoot = path.join(__dirname, '../../skills');
      return skillsService.readSkill(skillsRoot, id);
    });

    // 形象工坊：重新检测平台（导入后刷新可用状态）
    ipcMain.handle('skills:platforms', () => skillsService.detectPlatforms());

    // 形象工坊：把一个 Skill 导入到指定 AI 平台（只写目标 skill 子目录，存在先备份）
    ipcMain.handle('skills:import', (_e: unknown, payload: unknown) => {
      const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const id = p.skillId;
      const platformId = p.platformId;
      if (typeof id !== 'string' || typeof platformId !== 'string') {
        return { ok: false, error: '参数缺失' };
      }
      const platform = skillsService.detectPlatforms().find((x) => x.id === platformId);
      if (!platform || !platform.available) return { ok: false, error: '目标平台未安装' };
      const skillsRoot = path.join(__dirname, '../../skills');
      const safeId = skillsService.sanitizeSkillName(id);
      if (!safeId) return { ok: false, error: '非法 Skill 标识' };
      const srcDir = path.join(skillsRoot, safeId);
      return skillsService.importSkill(srcDir, platform.dir, id);
    });

    // 形象工坊：关闭浮窗
    ipcMain.on('skills:close', () => {
      if (this.skillsWindow && !this.skillsWindow.isDestroyed()) this.skillsWindow.hide();
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

    // ========== 统一托盘菜单浮窗 IPC（2026-11-16 小M） ==========
    // 渲染层点击菜单项：带 action id 回传，主进程查表执行原 template click 函数
    ipcMain.on('tray-menu:action', (_event: unknown, id: unknown, checked?: unknown) => {
      this._dispatchTrayAction(id, checked);
    });
    // Esc / 失焦关闭整个托盘菜单浮窗
    ipcMain.on('tray-menu:close', () => {
      if (this.trayMenuWindow && !this.trayMenuWindow.isDestroyed()) this.trayMenuWindow.hide();
    });
    // 渲染层实测内容尺寸后回传：贴合内容收缩窗口 + 重新锚定托盘（消除底部空白）
    ipcMain.on('tray-menu:resize', (_event: unknown, size: { width: number; height: number }) => {
      if (size) this._resizeTrayPopup(size.width, size.height);
    });
    // 菜单内嵌滑块读取当前两档值（init 亦推送，invoke 供渲染层主动对账）
    ipcMain.handle('opacity:get', () => ({
      pinned: this._getPinnedOpacity() ?? 0.6,
      passthrough: this._getPassthroughOpacity() ?? 0.5,
    }));
    // 菜单内嵌滑块写值：kind=pinned|passthrough，value∈(0,1]，null 回落默认
    ipcMain.on('opacity:set', (_event: unknown, p: { kind: 'pinned' | 'passthrough'; value: number | null }) => {
      if (!p || (p.kind !== 'pinned' && p.kind !== 'passthrough')) return;
      const raw = p.value;
      const value = (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) ? raw : null;
      if (p.kind === 'pinned') {
        this._setPinnedOpacity(value);
      } else {
        this._setPassthroughOpacity(value);
      }
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
      if (!rect || typeof rect.x !== 'number' || !(rect.w > 0) || !(rect.h > 0)) return;
      this._petBodyRect = rect;
      // body-rect 到位/变化后立即重判一次（2026-11-19 鼠标延迟修复）：
      // 显示瞬间若 body-rect 未就绪，探测走"整窗命中"兜底；首帧矩形到达后必须
      // 立即收敛到真实轮廓（否则要等下一个 150ms tick，且期间轮廓透区挡鼠标）。
      this._probePetCursorHit();
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
    ipcMain.on('pet:open-ctx', (_event: unknown, payload?: { mode?: string; catX?: number; catY?: number }) => {
      _modDiag('[Pet] open-ctx received (mode=' + this._getHideMode() + ', scale=' + this._petScale + ') payload=' + JSON.stringify(payload || {}));
      const win = this.petStage;
      if (!win || win.isDestroyed()) { _modDiag('[Pet] open-ctx abort: petStage missing'); return; }
      // v4 统一菜单窗（2026-11-16）：非 live2d 的一级菜单改走独立透明环形窗——
      // 桌宠窗仅 220×s（0.5× 档 110px）物理上放不下环形叶+中文标签，这正是旧窗内
      // 菜单「看不清/显示不全」的根源。独立窗环半径随猫视觉尺寸自适应，三套菜单
      // （main/mode/interact）共用同一框架。live2d 模式保留窗内旧链路（不动历史）。
      const renderMode = payload && payload.mode;
      if (renderMode && renderMode !== 'live2d') {
        const b = win.getBounds();
        const catX = (typeof payload?.catX === 'number' && isFinite(payload.catX)) ? b.x + payload.catX : b.x + b.width / 2;
        const catY = (typeof payload?.catY === 'number' && isFinite(payload.catY)) ? b.y + payload.catY : b.y + b.height / 2;
        this._openMenuWindowAt(catX, catY, { x: b.x, y: b.y, width: b.width, height: b.height }, 'main', this._getHideMode());
        return;
      }
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
        // 2026-11-15 小M：自动关闭临时停用（调试期叶出窗导致误关，devtools 无法排查）；修复后再启用
        const autoCloseEnabled = false;
        if (outside && autoCloseEnabled) {
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
    // 互动菜单拉回 v5.3（2026-11-15，修 v5.2 死代码 + 互动二级菜单出屏不可点）：
    // 根因：本处理器原以 `if (this._petCtxOpen) return;` 早退——真实链路「右键开主扇
    // （open-ctx 已置 _petCtxOpen=true）→ 点互动才发 expand-ctx」守卫恒真，拉回从未执行。
    // v5.3 纯移动拉回（v4 教训：扩窗改窗口几何 → left:50%/bottom:0 锚定的猫必移动+叶错位，
    // 窗口几何是渲染层锚定的根不可动）：尺寸不变，只把越出 workArea 的部分拉回屏内；
    // 不覆写 _petCtxSaved（open-ctx 已存用户拖拽位，close-ctx 原样还原）。
    // v5.4 独立菜单窗（2026-11-15 L3，小M 批准）：二级扇迁独立窗——桌宠窗零几何变化（猫不动），
    // 菜单窗 260×260 中心对齐猫屏幕中心并 clamp 到所在屏工作区；showInactive 不夺焦。
    // 叶动作回传：pet-menu:action → 转发 petStage 播放；关闭：pet-menu:close → 隐菜单窗。
    ipcMain.on('pet:expand-ctx', () => {
      const win = this.petStage;
      if (!win || win.isDestroyed()) return;
      const { screen } = require('electron');
      const b = win.getBounds();
      const display = screen.getDisplayMatching(b);
      const pulled = computeCtxPullBack(b, display);
      if (pulled.moved) {
        win.setBounds({ x: pulled.x, y: pulled.y, width: b.width, height: b.height });
        _modDiag(`[Pet] expand-ctx 拉回屏内: (${b.x},${b.y}) -> (${pulled.x},${pulled.y})`);
      }
      // 猫屏幕中心（2026-11-16 修硬编码 110/105——那是 scale=1 口径，窗口/视频都随档位
      // 缩放：窗=220×s，视频高=210×s 底边锚定 → 心=(W/2, H-105×s)。webm 主链路
      // pet-menu:show 载荷为准，此处仅为 expand-ctx 直通路径的等价兜底）
      const s = this._getPetScale() || 1;
      this._openMenuWindowAt(b.x + b.width / 2, b.y + b.height - 105 * s, { x: b.x, y: b.y, width: b.width, height: b.height });
    });
    // 互动菜单窗打开（2026-11-15 L3 pet-menu-window 最终通道）：react 叶点击（pet-stage）
    // 发 pet-menu:show，载荷 catX/catY = pet-stage 窗口内 CSS 坐标（catAnchor 真实猫几何，
    // webm/live2d 通吃——expand-ctx 硬编码 webm 居中锚的旧口径退役）。行为与 expand-ctx
    // 同构：纯移动拉回（v5.3）→ 菜单窗中心对齐猫 + clamp 工作区 → showInactive 不夺焦。
    // 此前主进程无此处理器：点互动发 show 无人听，菜单窗根本不出现（小M 实测断链）。
    ipcMain.on('pet-menu:show', (_event: unknown, payload?: { catX?: number; catY?: number }) => {
      const win = this.petStage;
      if (!win || win.isDestroyed()) { _modDiag('[Pet] pet-menu:show 丢弃：petStage 不在场'); return; }
      const { screen } = require('electron');
      const b0 = win.getBounds();
      _modDiag(`[Pet] pet-menu:show 收到 payload=${JSON.stringify(payload || {})} 桌宠窗=(${b0.x},${b0.y} ${b0.width}x${b0.height})`);
      const display = screen.getDisplayMatching(b0);
      const pulled = computeCtxPullBack(b0, display);
      const b = pulled.moved
        ? { x: pulled.x, y: pulled.y, width: b0.width, height: b0.height }
        : b0;
      if (pulled.moved) {
        win.setBounds(b);
        _modDiag(`[Pet] 菜单窗打开前拉回屏内: (${b0.x},${b0.y}) -> (${pulled.x},${pulled.y})`);
      }
      const catX = typeof payload?.catX === 'number' && isFinite(payload.catX) ? payload.catX : 110;
      const catY = typeof payload?.catY === 'number' && isFinite(payload.catY) ? payload.catY : b.height - 105;
      this._openMenuWindowAt(b.x + catX, b.y + catY, { x: b.x, y: b.y, width: b.width, height: b.height });
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
    // 互动菜单窗动作回传（2026-11-15 L3 迁移接线补全 + 一叶一动作）：act = 具体素材名
    // （p1…/light0song，menu-window.html 叶子 data-act），直传 petStage 播放——
    // 渲染层 playAction 已支持直接素材名（POOLS 无此键时按单素材播放）。
    // 此前 L3 只迁了 UI：pet-menu:action 在主进程无处理器，点叶子不会播放（小M 实测）。
    ipcMain.on('pet-menu:action', (_event: unknown, payload: { act?: string }) => {
      const act = payload && typeof payload.act === 'string' ? payload.act : '';
      if (!act) return;
      const win = this.petStage;
      if (win && !win.isDestroyed()) win.webContents.send('pet:play-action', { act });
      this._closeMenuSession(); // 动作即播即收（与原窗内叶 closeCtx 语义对齐）
    });
    ipcMain.on('pet-menu:close', () => this._closeMenuSession());
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
      // v14.3 菜单会话中拖拽桌宠：菜单窗跟随新位置平移 + 重算扇形朝向/环心（30Hz 节流），
      // 让「弹出后拖动」时菜单始终环抱猫、且开口朝新的空旷侧，不会被屏幕边缘裁掉。
      // 用 33ms 节流与渲染层 drag-move 同频，避免每拍 setBounds+reflow 造成抖动。
      const now = Date.now();
      if (this.menuWindow && !this.menuWindow.isDestroyed() && this.menuWindow.isVisible()
          && this._menuCatOffsetInPet && now - this._menuReflowAt >= 33) {
        this._menuReflowAt = now;
        this._followMenuToPet();
      }
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
    // 固定档透明度持久化（2026-11-16 滑块窗）：启动应用 config.pinnedOpacity（null=默认 0.6）
    this.edgeDetector.setPinnedOpacity(this._getPinnedOpacity());
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
    // 启动审计：把两个窗口弹出相关开关的落地值写进诊断日志，避免「改了但没生效」
    // 只能靠肉眼猜（2026-11-13 复现：config 缺键 + 缺省 true 导致开关形同虚设）。
    _modDiag('[Pet] init flags: petClickSummon=' + this._petClickSummon
      + ' petDebugMode=' + this._petDebugMode + ' petScale=' + this._petScale);
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
  // 2026-11-22：抢锁失败=已有实例占锁。曾发生僵尸实例（init 卡死）持锁 40 分钟，
  // 期间用户所有启动都被此分支静默吞掉，表象=「启动后什么都不弹」。留痕便于归因。
  _modDiag('[Boot] 抢单实例锁失败 → 退出（已有实例持锁，若其无响应需手动结束旧进程）');
  app.quit();
} else {
  app.on('second-instance', () => {
    // 重复启动尝试：唤出已有实例的面板（未初始化完成时静默）
    _modDiag('[Boot] second-instance 事件（重复启动尝试）');
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
    _modDiag('[Boot] app ready → init 开始（pid=' + process.pid + '）');
    await spikeApp.init();
    _modDiag('[Boot] init 完成 → 启动自检（pid=' + process.pid
      + ' panelVisible=' + (spikeApp.edgeDetector ? spikeApp.edgeDetector.isWindowVisible : 'n/a') + '）');
    // 启动自检（2026-11-22）：init 完成后面板应已在显示链中（edge 模式 forceShow /
    // pet 模式 _applyHideMode forceShow）。1.5s 后仍未可见 = 显示链异常，落盘现场。
    setTimeout(() => {
      try {
        const ed = spikeApp.edgeDetector;
        const mw = spikeApp.mainWindow;
        _modDiag('[Boot] 启动自检 1.5s：panelVisible=' + (mw && !mw.isDestroyed() ? mw.isVisible() : 'no-win')
          + ' isWindowVisible=' + (ed ? ed.isWindowVisible : 'n/a') + ' showLock=' + (ed ? String(ed._showAnimationId) : 'n/a'));
      } catch (e) { _modDiag('[Boot] 启动自检异常: ' + String(e)); }
    }, 1500);
    // 菜单窗全链路自检（CLIPSENSE_MENU_SELFTEST=1 时启用，2026-11-16 调试工具）：
    // 启动 8s 后用桌宠窗真实 bounds 自动触发一次 pet-menu:show → 定位 → reveal，
    // 日志可完整取证 reveal/isVisible/z-order，无需人工点击。
    if (process.env.CLIPSENSE_MENU_SELFTEST === '1') {
      let selfTestTries = 0;
      const selfTestTimer = setInterval(() => {
        const win = spikeApp.petStage;
        if (win && !win.isDestroyed() && win.isVisible()) {
          clearInterval(selfTestTimer);
          const b = win.getBounds();
          _modDiag(`[SelfTest] 触发菜单窗自检 桌宠窗=(${b.x},${b.y} ${b.width}x${b.height})`);
          spikeApp._openMenuWindowAt(b.x + b.width / 2, b.y + b.height / 2, b);
        } else if (++selfTestTries > 30) {
          clearInterval(selfTestTimer);
          _modDiag('[SelfTest] 30s 内桌宠窗未就绪，自检中止');
        }
      }, 1000);
    }
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
