/**
 * paste-bridge.ts - Electron 主进程内 FFI 直调 user32.dll（koffi）
 *
 * 2026-09-02 架构重设计（Docs/双击粘贴架构重设计-2026-09-02.md）：
 * 废弃常驻 PowerShell 进程路线，焦点恢复 + SendInput 在主进程内一次同步原子调用。
 *
 * 竞品同构实现（源码级核验）：
 * - Ditto ExternalWindowTracker.cpp：SPI_SETFOREGROUNDLOCKTIMEOUT 临时清零 +
 *   AttachThreadInput + BringWindowToTop/SetForegroundWindow + 忙等验证（≤25ms 无固定 Sleep）
 * - CopyQ winplatformwindow.cpp：SendInput 一次 4 条 INPUT + GetKeyState 等修饰键松开
 *
 * 目标时序：IPC 后 pasteTo 全程 2–30ms（忙等上限 50ms 硬兜底）。
 * 仅 Windows；koffi 预编译 win32-x64，无需 MSVC/node-gyp。
 *
 * TS 迁移（2026-10-09，第四批 #4）：CommonJS export = 单导出（类本身，require 形态与
 * .js 原版一致）。FFI 边界诚实弱类型：koffi 绑定声明为结构化最小接口（非 any——
 * 函数签名已知的字段如实建模），Buffer 手写段保持 Buffer（FFI 边界本就弱类型，
 * 诚实标注比伪装强类型更可维护）；公共 API（captureForeground/pasteTo 等）返回
 * 结构强类型建模。
 */


/** 忙等上限（Ditto 同款） */
const BUSY_WAIT_MS = 25;
/** 等用户松开修饰键的上限（CopyQ 模型） */
const MODIFIER_WAIT_MS = 1500;

// ==================== macOS 常量（CoreGraphics 事件注入） ====================
/** 当前平台判定（模块级缓存，避免热路径重复读 process.platform） */
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
/** macOS 虚拟键码：V（kVK_ANSI_V） */
const MAC_VK_V = 0x09;
/** CGEventFlags：Command / Shift / Control / Option */
const CG_FLAG_COMMAND = 0x00100000;
const CG_FLAG_SHIFT = 0x00020000;
const CG_FLAG_CONTROL = 0x00040000;
const CG_FLAG_ALTERNATE = 0x00080000;
/** kCGHIDEventTap：把事件投递到 HID 层（等同真实按键） */
const CG_HID_EVENT_TAP = 0;
/** kCGEventSourceStateCombinedSessionState：读取全局修饰键状态 */
const CG_SOURCE_STATE_COMBINED = 0;

// user32 常量
const SW_RESTORE = 9;
const SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2001;
const SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
const VK_LCONTROL = 0xa2;
const VK_LSHIFT = 0xa0;
const VK_LMENU = 0xa4;
const VK_LWIN = 0x5b;
const VK_V = 0x56;
const VK_INSERT = 0x2d;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;

// 真实 x64 INPUT 布局（union 含 MOUSEINPUT 的 8 字节对齐指针成员，结构起始必须 8 对齐）：
//   offset 0 : type (uint32)
//   offset 4 : 4 字节填充（union 8 对齐）
//   offset 8 : wVk (uint16)
//   offset 10: wScan (uint16)
//   offset 12: dwFlags (uint32)
//   offset 16: time (uint32)
//   offset 20: 4 字节填充（指针 8 对齐）
//   offset 24: dwExtraInfo (uintptr 8 字节)
//   sizeof = 40。用 koffi.struct 简化定义会漏掉 union 填充算出 24，cbSize=24 时
//   SendInput 直接拒绝（sent=0）——已踩坑，故不再用 struct，手写 Buffer。
const INPUT_SIZE_X64 = 40;
const OFF_TYPE = 0;
const OFF_WVK = 8;
const OFF_WSCAN = 10;
const OFF_FLAGS = 12;
const OFF_TIME = 16;
const OFF_EXTRA = 24;

/** koffi func 句柄（无返回值语义） */
interface KoffiFunc {
  (...args: unknown[]): unknown;
}

/** koffi func（int 返回：GetClassNameW 字符数 / GetAsyncKeyState 键态） */
interface KoffiFuncInt {
  (...args: unknown[]): number;
}

/** user32 函数集（绑定后字段与签名一一对应） */
interface User32Funcs {
  SendInput: KoffiFunc;
  GetForegroundWindow: KoffiFunc;
  GetWindow: KoffiFunc;
  SetForegroundWindow: KoffiFunc;
  ShowWindow: KoffiFunc;
  IsWindow: KoffiFunc;
  IsIconic: KoffiFunc;
  GetWindowThreadProcessId: KoffiFunc;
  AttachThreadInput: KoffiFunc;
  BringWindowToTop: KoffiFunc;
  GetAsyncKeyState: KoffiFuncInt;
  SystemParametersInfoW: KoffiFunc;
  GetClassNameW: KoffiFuncInt;
  GetWindowTextW: KoffiFuncInt;
}

/** kernel32 函数集 */
interface Kernel32Funcs {
  GetCurrentThreadId: KoffiFunc;
  GetCurrentProcessId: KoffiFuncInt;
}

/** koffi 模块最小接口（FFI 边界诚实弱类型） */
interface KoffiModule {
  load: (name: string) => KoffiLib;
  func: (signature: string) => KoffiFunc;
}

/** koffi.load 返回的 DLL 模块句柄（func 按签名串绑定） */
interface KoffiLib {
  func: (signature: string) => KoffiFunc;
}

let _user32: User32Funcs | null = null;   // 惰性绑定的 user32 函数集
let _kernel32: Kernel32Funcs | null = null; // kernel32：GetCurrentThreadId 在这里，不在 user32

/** 修饰键 VK 清单（Alt+V 手指残留污染防护） */
const MODIFIER_VKS = [VK_LCONTROL, VK_LSHIFT, VK_LMENU, VK_LWIN];

function _bindUser32(): void {
  if (_user32) return;
  // FFI 边界：koffi 模块按需 require（惰性），签名串在此固定
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as KoffiModule;

  const user32 = koffi.load('user32.dll') as KoffiLib;
  const kernel32 = koffi.load('kernel32.dll') as KoffiLib;

  _kernel32 = {
    GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    GetCurrentProcessId: (kernel32.func('uint32 __stdcall GetCurrentProcessId()') as unknown as KoffiFuncInt),
  };

  _user32 = {
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 nInputs, void *pInputs, int cbSize)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32 nCmd)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, uint32 *pid)'),
    AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
    BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hWnd)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int nVirtKey)') as unknown as KoffiFuncInt,
    SystemParametersInfoW: user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, void *pvParam, uint32 fWinIni)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, uint16 *lpClassName, int nMaxCount)') as unknown as KoffiFuncInt,
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, uint16 *lpString, int nMaxCount)') as unknown as KoffiFuncInt,
  };
}

/** Shell/瞬态窗口类名（前台抓取过滤，verbose 与 captureForeground 共享；2026-10-29 双击粘贴修复） */
const TRANSIENT_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  '#32768', 'tooltips_class32',
  'MSCTFIME UI', 'Default IME', 'IME', 'CyberHelper',
]);

/** macOS CoreGraphics 函数集（koffi 惰性绑定；签名与 dylib 导出一一对应） */
interface MacFfi {
  CGEventSourceCreate: (state: number) => unknown;
  CGEventCreateKeyboardEvent: (src: unknown, vk: number, down: boolean) => unknown;
  CGEventSetFlags: (ev: unknown, flags: number) => void;
  CGEventPost: (tap: number, ev: unknown) => void;
  CGEventSourceFlagsState: (state: number) => number;
  AXIsProcessTrusted: () => boolean;
  CFRelease: (obj: unknown) => void;
}

let _mac: MacFfi | null = null;

/**
 * macOS 惰性绑定：CoreGraphics（键态读取 / 键盘事件注入）+ ApplicationServices
 * （AXIsProcessTrusted：辅助功能授权探测——未授权时 CGEventPost 会被系统静默丢弃）。
 */
function _bindMac(): void {
  if (_mac) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as KoffiModule;
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics') as KoffiLib;
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation') as KoffiLib;
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices') as KoffiLib;
  _mac = {
    CGEventSourceCreate: cg.func('void* CGEventSourceCreate(int32 stateID)'),
    CGEventCreateKeyboardEvent: cg.func('void* CGEventCreateKeyboardEvent(void* source, uint16 virtualKey, bool keyDown)'),
    CGEventSetFlags: cg.func('void CGEventSetFlags(void* event, uint64 flags)'),
    CGEventPost: cg.func('void CGEventPost(uint32 tap, void* event)'),
    CGEventSourceFlagsState:
      cg.func('uint64 CGEventSourceFlagsState(int32 stateID)') as unknown as (state: number) => number,
    AXIsProcessTrusted: ax.func('bool AXIsProcessTrusted()') as unknown as () => boolean,
    CFRelease: cf.func('void CFRelease(void* obj)'),
  };
  console.log('[PasteBridge] macOS CoreGraphics 绑定成功（CGEvent / 修饰键 / AX 授权）');
}

/** captureForegroundVerbose 返回（带判定原因，供诊断与过滤） */
interface CaptureVerboseResult {
  hwnd: number;
  pid?: number;
  cls?: string;
  reason?: string;
}

/** pasteTo 返回（restored 记录焦点恢复路径，供诊断） */
interface PasteToResult {
  ok: boolean;
  restored?: string;
  error?: string;
}

/** pasteTo 参数（key 缺省 ctrl-v） */
interface PasteToOptions {
  key?: 'ctrl-v' | 'shift-insert';
}

/** 惰性绑定：首次 pasteTo/captureForeground 时 require koffi + load user32 */
class PasteBridge {
  /** 惰性绑定：首次 pasteTo/captureForeground 时 require koffi + load user32 */
  private _ready = false;

  constructor() {
    // 惰性绑定：首次 pasteTo/captureForeground 时 require koffi + load user32
    this._ready = false;
  }

  /** 惰性绑定入口 */
  private _ensure(): void {
    if (!this._ready) {
      if (IS_MAC) _bindMac();
      else _bindUser32();
      this._ready = true;
    }
  }

  /**
   * 带重试的抓前台（双击粘贴专用）：窗口切换瞬间系统处于「无前台」真空态，
   * GetForegroundWindow 会合法返回 0（已踩坑：同一调用栈几毫秒后就有值）。
   * 15ms 间隔轮询，最多 120ms；仍为 0 则放弃（回退 tracked 由调用方决定）。
   * @returns hwnd；仍无前台返回 0
   */
  captureForegroundRetry(maxMs = 120): number {
    // macOS：目标由「面板失焦归还前台」确定，1 表示存在可粘贴目标（无需句柄）
    if (IS_MAC) return 1;
    if (!IS_WIN) return 0;
    try {
      this._ensure();
      if (!_user32 || !_kernel32) return 0;
      const deadline = Date.now() + maxMs;
      let hwnd = 0;
      let attempts = 0;
      while (Date.now() < deadline) {
        hwnd = Number(_user32.GetForegroundWindow());
        if (hwnd) {
          // 2026-09-11 20:40 双击粘贴回归根因修复：焦点模型回切（窗口恒可聚焦）后，
          // 双击瞬间前台就是面板自身窗口。旧版只判 hwnd 非零就直接返回 →
          // fgNow=面板自身 → pasteTo 对自己 Ctrl+V，表现为「粘贴没生效」。
          // 自身进程窗口等待无意义（面板保持前台直到 pasteTo 切焦），立即返回 0，
          // 由调用方回退 tracked（focus-search 抢焦前 refresh 保持新鲜）。
          const selfPidBuf = Buffer.alloc(4);
          _user32.GetWindowThreadProcessId(hwnd, selfPidBuf);
          if (selfPidBuf.readUInt32LE(0) === _kernel32.GetCurrentProcessId()) {
            console.log('[PasteBridge] captureForegroundRetry: 前台=自身进程窗口，返回 0（tracked 兜底）');
            return 0;
          }
          return hwnd;
        }
        attempts++;
        this._sleep(15);
      }
      console.log(`[PasteBridge] captureForeground: 重试 ${attempts} 次仍无前台（真空态超过 ${maxMs}ms）`);
      return 0;
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', (err as Error).message);
      return 0;
    }
  }

  /**
   * 同步抓取当前前台窗口（带判定原因），供诊断与过滤
   */
  captureForegroundVerbose(): CaptureVerboseResult {
    const fail = (reason: string, extra: Partial<CaptureVerboseResult> = {}): CaptureVerboseResult =>
      ({ hwnd: 0, reason, ...extra });
    if (IS_MAC) return { hwnd: 1, reason: 'mac-focus-release' };
    if (!IS_WIN) return fail('non-win32');
    try {
      this._ensure();
      if (!_user32 || !_kernel32) return fail('not-bound');
      const hwnd = Number(_user32.GetForegroundWindow());
      if (!hwnd) return fail('no-foreground');

      const pidBuf = Buffer.alloc(4);
      _user32.GetWindowThreadProcessId(hwnd, pidBuf);
      const winPid = pidBuf.readUInt32LE(0);
      const nameBuf = Buffer.alloc(512);
      const n = _user32.GetClassNameW(hwnd, nameBuf, 256);
      const cls = n > 0 ? nameBuf.toString('utf16le', 0, n * 2) : '?';

      if (winPid === _kernel32.GetCurrentProcessId()) {
        return fail('self-process', { pid: winPid, cls });
      }
      if (TRANSIENT_CLASSES.has(cls)) {
        return fail('shell-or-transient', { pid: winPid, cls });
      }
      console.log(`[PasteBridge] captureForeground: 记录 hwnd=${hwnd} pid=${winPid} class=${cls}`);
      return { hwnd, pid: winPid, cls };
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', (err as Error).message);
      return fail(`error:${(err as Error).message}`);
    }
  }

  /**
   * 同步抓取当前前台窗口句柄（面板显示前调用）
   * 过滤规则（2026-09-02「只能粘贴一次」修复）：
   *  - 排除自身进程窗口（面板/触发条）——粘贴到自己无意义
   *  - 排除 Shell 桌面（Progman/WorkerW）——从触发条唤出时前台常是桌面，
   *    旧版记录桌面句柄导致第二次粘贴落到桌面（表现为“句柄无效/粘贴失效”）
   * @returns hwnd；失败/被过滤/非 win32 返回 0
   */
  captureForeground(): number {
    if (IS_MAC) return 1; // 见 captureForegroundRetry
    if (!IS_WIN) return 0;
    try {
      this._ensure();
      if (!_user32 || !_kernel32) return 0;
      const hwnd = Number(_user32.GetForegroundWindow());
      if (!hwnd) return 0;
      // 过滤实现补齐（2026-10-29 双击粘贴修复）：文档一直声称排除自身/Shell，
      // 实现却裸返回——面板获得焦点后 refresh() 把自己记成目标 → target-is-self。
      // 现与 captureForegroundVerbose 同规则：自身进程 / Shell 瞬态类 → 0（调用方保留旧记录）。
      const pidBuf = Buffer.alloc(4);
      _user32.GetWindowThreadProcessId(hwnd, pidBuf);
      if (pidBuf.readUInt32LE(0) === _kernel32.GetCurrentProcessId()) return 0;
      const nb = Buffer.alloc(512);
      const cn = _user32.GetClassNameW(hwnd, nb, 256);
      const clsName = cn > 0 ? nb.toString('utf16le', 0, cn * 2) : '?';
      if (TRANSIENT_CLASSES.has(clsName)) return 0;
      return hwnd;
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', (err as Error).message);
      return 0;
    }
  }

  /** 窗口标题（截断 80 字符，取证用：区分同类名 Electron 窗口归属） */
  private _windowTitle(hwnd: number): string {
    try {
      if (!_user32 || !hwnd) return '?';
      const buf = Buffer.alloc(256);
      const n = _user32.GetWindowTextW(hwnd, buf, 128);
      const t = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
      return t.length > 80 ? t.slice(0, 80) + '…' : (t || '(空)');
    } catch { return '?'; }
  }
  /**
   * Z 序回退抓目标（2026-10-29 双击粘贴修复第二幕）：
   * 唤出面板时前台可能是任务栏/桌面（无有效粘贴目标，tracked=0）。
   * Ditto 同款思路：面板正下方压着的顶层窗口就是用户刚才在用的应用——
   * 从 panelHwnd 沿 Z 序下探（GW_HWNDPREV），跳过自身/Shell 瞬态，取第一个合法者。
   */
  captureBelow(panelHwnd: number): number {
    if (process.platform !== 'win32') return 0;
    try {
      this._ensure();
      if (!_user32 || !_kernel32) return 0;
      let cur = panelHwnd;
      for (let depth = 0; depth < 8; depth++) {
        cur = Number(_user32.GetWindow(cur, 4 /* GW_HWNDPREV */));
        if (!cur) return 0;
        const pidBuf = Buffer.alloc(4);
        _user32.GetWindowThreadProcessId(cur, pidBuf);
        if (pidBuf.readUInt32LE(0) === _kernel32.GetCurrentProcessId()) continue;
        const nb = Buffer.alloc(512);
        const cn = _user32.GetClassNameW(cur, nb, 256);
        const cls = cn > 0 ? nb.toString('utf16le', 0, cn * 2) : '?';
        if (TRANSIENT_CLASSES.has(cls)) continue;
        return cur;
      }
      return 0;
    } catch {
      return 0;
    }
  }
  /**
   * 目标句柄是否仍然有效（可见的顶层窗口）
   */
  isAlive(hwnd: number): boolean {
    if (IS_MAC) return hwnd > 0;
    if (!hwnd || !IS_WIN) return false;
    try {
      this._ensure();
      if (!_user32) return false;
      return !!_user32.IsWindow(hwnd);
    } catch {
      return false;
    }
  }

  /**
   * 等待用户松开修饰键（CopyQ waitForModifiersReleased 模型）。
   * 场景：Alt+V 唤出面板后立即双击，用户手指还没离开修饰键，
   * 此时注入的 Ctrl+V 会被用户按着的 Alt 等污染成 Ctrl+Alt+V。
   * @returns true=已全部松开；false=超时仍有按住（放弃注入更安全）
   */
  private _waitForModifiersReleased(): boolean {
    if (IS_MAC) return this._waitMacModifiersReleased();
    const start = Date.now();
    while (Date.now() - start < MODIFIER_WAIT_MS) {
      let any = false;
      for (const vk of MODIFIER_VKS) {
        // 必须用 GetAsyncKeyState（物理键全局态）：GetKeyState 只反映本线程
        // 消息队列——Electron 主进程收不到用户按键，永远返回 0（已踩坑修正）。
        // int16 返回值先转无符号再取最高位。
        if (!_user32) break;
        const state = _user32.GetAsyncKeyState(vk) & 0xffff;
        if (state & 0x8000) { any = true; break; }
      }
      if (!any) return true;
      // 忙等间隔：用 Atomics.wait 不可行（主线程），短 Sleep 模拟
      this._sleep(15);
    }
    return false;
  }

  /** 主线程内短休眠（同步，仅用于修饰键等待；忙等轮询用 GetTickCount） */
  private _sleep(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 自旋：spike 可接受，产品化可换 MsgWaitForMultipleObjects */ }
  }

  /**
   * 恢复焦点 + 注入粘贴键，一次同步原子调用
   * @param hwnd 目标窗口句柄（focusTracker 记录）
   * @param opts.key 缺省 ctrl-v
   */
  pasteTo(hwnd: number, opts: PasteToOptions = {}): PasteToResult {
    if (IS_MAC) return this._pasteMac(opts);
    if (!IS_WIN) {
      return { ok: false, error: 'non-win32' };
    }
    try {
      this._ensure();
      if (!_user32 || !_kernel32) return { ok: false, error: 'not-bound' };

      // R6 防御：句柄过期/已关闭 → 宁可不粘贴也不贴错窗口
      if (!hwnd || !_user32.IsWindow(hwnd)) {
        // 失败现场完整带回：句柄是否非零、窗口类名是什么——类名能直接指认
        // 记录的到底是谁（目标应用 / IME / 已销毁的宿主窗口）
        let cls = '?';
        if (hwnd) {
          try {
            const nb = Buffer.alloc(512);
            const cn = _user32.GetClassNameW(hwnd, nb, 256);
            if (cn > 0) cls = nb.toString('utf16le', 0, cn * 2);
          } catch { /* ignore */ }
        }
        console.log(`[PasteBridge] pasteTo 放弃: hwnd=${hwnd} IsWindow=${!!(hwnd && _user32.IsWindow(hwnd))} class=${cls}`);
        return { ok: false, restored: 'dead', error: `target-window-closed(hwnd=${hwnd},class=${cls})` };
      }

      // R7 防御（2026-09-11 双击粘贴回归）：目标绝不能是自身进程窗口。
      // 粘贴到自己无意义；宁可拒绝也不把 Ctrl+V 发进面板。
      {
        const selfPidBuf = Buffer.alloc(4);
        _user32.GetWindowThreadProcessId(hwnd, selfPidBuf);
        if (selfPidBuf.readUInt32LE(0) === _kernel32.GetCurrentProcessId()) {
          console.log(`[PasteBridge] pasteTo 拒绝: 目标 hwnd=${hwnd} 是自身进程窗口`);
          return { ok: false, error: 'target-is-self' };
        }
      }

      // R5：前台锁定超时临时清零，用完恢复（Ditto 同款：读旧值→置 0→finally 恢复）
      const timeoutBuf = Buffer.alloc(4);
      _user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, timeoutBuf, 0);
      const zeroBuf = Buffer.alloc(4);
      zeroBuf.writeUInt32LE(0, 0);
      try {
        _user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, zeroBuf, 0);

        // --- 焦点恢复（Ditto ActivateTarget 同款） ---
        const selfTid = _kernel32.GetCurrentThreadId();
        const fgHwnd = Number(_user32.GetForegroundWindow());
        let restored = 'none';
        if (fgHwnd === hwnd) {
          restored = 'same';
        } else {
          // 需要切焦点：打出现场（目标=X 当前前台=Y），切错窗口时对日志即可归因
          let fgCls = '?';
          try {
            const fb = Buffer.alloc(512);
            const fn = _user32.GetClassNameW(fgHwnd, fb, 256);
            if (fn > 0) fgCls = fb.toString('utf16le', 0, fn * 2);
          } catch { /* ignore */ }
          console.log('[PasteBridge] 需要切焦点: 目标=' + hwnd + '(' + this._windowTitle(hwnd) + ') 当前前台=' + fgHwnd + '(' + fgCls + ')');

          const fgTidVal = _user32.GetWindowThreadProcessId(fgHwnd, null);
          const tgtTidVal = _user32.GetWindowThreadProcessId(hwnd, null);
          let attached = false;
          // 自附加守卫（2026-11-11 守护用例锁定）：fg 线程就是自身线程时 AttachThreadInput 自我附加
          // 会死锁输入队列——跳过附加（同线程无需附加即可操作焦点）
          if (fgTidVal && tgtTidVal && fgTidVal !== tgtTidVal && fgTidVal !== selfTid) {
            attached = !!_user32.AttachThreadInput(fgTidVal, selfTid, true);
          }
          try {
            if (_user32.IsIconic(hwnd)) _user32.ShowWindow(hwnd, SW_RESTORE);
            _user32.BringWindowToTop(hwnd);
            _user32.SetForegroundWindow(hwnd);
          } finally {
            if (attached) _user32.AttachThreadInput(fgTidVal, selfTid, false);
          }
          // --- 忙等验证（Ditto WaitForActiveWnd 同款，无固定 Sleep） ---
          const deadline = Date.now() + BUSY_WAIT_MS;
          while (Date.now() < deadline) {
            if (Number(_user32.GetForegroundWindow()) === hwnd) { restored = 'ok'; break; }
            this._sleep(2);
          }
          if (restored !== 'ok') {
            // ALT-tap 解锁重试一次（权威手法，SendInput VK_MENU）
            this._sendSingleKey(VK_LMENU, false);
            this._sleep(10);
            this._sendSingleKey(VK_LMENU, true);
            _user32.SetForegroundWindow(hwnd);
            if (Number(_user32.GetForegroundWindow()) === hwnd) {
              restored = 'ok-alt';
            } else {
              restored = 'denied';
            }
          }
        }

        if (restored === 'denied') {
          // 焦点没切过去：不发键（宁可不动也不贴错窗口）
          console.log(`[PasteBridge] 焦点恢复被拒: hwnd=${hwnd} fg=${Number(_user32.GetForegroundWindow())}`);
          return { ok: false, restored, error: 'restore-denied' };
        }

        // Electron 目标（VSCode 等 Chromium 系）激活后需要短暂稳定期：
        // OS 前台已切换但内部 webview 焦点还在回置，立即注入的键会被吞
        //（2026-10-29 VSCode 双击无内容取证修复）。'same' 路径无切换，不加延迟。
        if (restored !== 'same') this._sleep(35);
        // --- 修饰键等待（CopyQ 模型，防 Alt+V 手指残留污染） ---
        const modsReleased = this._waitForModifiersReleased();
        if (!modsReleased) {
          console.log('[PasteBridge] 修饰键 1500ms 内未松开，放弃注入');
          return { ok: false, restored, error: 'modifiers-held' };
        }

        // --- SendInput 一次 4 条 INPUT（CopyQ 同款） ---
        const chord = opts.key === 'shift-insert'
          ? { mod: VK_LSHIFT, vk: VK_INSERT }
          : { mod: VK_LCONTROL, vk: VK_V };
        const sent = this._sendChord(chord.mod, chord.vk);
        console.log('[PasteBridge] pasteTo 完成: hwnd=' + hwnd + '(' + this._windowTitle(hwnd) + ') restored=' + restored + ' sent=' + sent + ' key=' + (chord.vk === VK_V ? 'ctrl-v' : 'shift-insert'));
        if (!sent || sent < 4) {
          return { ok: false, restored, error: 'sendinput-failed' };
        }
        return { ok: true, restored };
      } finally {
        // 恢复原前台锁定超时
        _user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, timeoutBuf, 0);
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * macOS：是否已获得「辅助功能」授权。
   * CGEventPost 在未授权时被系统静默丢弃（无异常、无返回码），必须显式探测。
   */
  isAccessibilityTrusted(): boolean {
    if (!IS_MAC) return true;
    try {
      this._ensure();
      return _mac ? !!_mac.AXIsProcessTrusted() : false;
    } catch {
      return false;
    }
  }

  /**
   * macOS 粘贴：调用方已让面板失焦（blur/hide），向当前前台应用投递 ⌘V。
   * 目标窗口的「身份」由系统焦点归还保证，不依赖窗口句柄。
   */
  private _pasteMac(opts: PasteToOptions): PasteToResult {
    try {
      this._ensure();
      if (!_mac) return { ok: false, error: 'not-bound' };
      if (!_mac.AXIsProcessTrusted()) return { ok: false, error: 'accessibility-required' };
      if (!this._waitMacModifiersReleased()) {
        console.log('[PasteBridge] macOS 修饰键 1500ms 内未松开，放弃注入');
        return { ok: false, error: 'modifiers-held' };
      }
      const src = _mac.CGEventSourceCreate(CG_SOURCE_STATE_COMBINED);
      const down = _mac.CGEventCreateKeyboardEvent(src, MAC_VK_V, true);
      const up = _mac.CGEventCreateKeyboardEvent(src, MAC_VK_V, false);
      if (!down || !up) {
        if (down) _mac.CFRelease(down);
        if (up) _mac.CFRelease(up);
        if (src) _mac.CFRelease(src);
        return { ok: false, error: 'event-create-failed' };
      }
      _mac.CGEventSetFlags(down, CG_FLAG_COMMAND);
      _mac.CGEventSetFlags(up, CG_FLAG_COMMAND);
      _mac.CGEventPost(CG_HID_EVENT_TAP, down);
      this._sleep(12);
      _mac.CGEventPost(CG_HID_EVENT_TAP, up);
      _mac.CFRelease(down);
      _mac.CFRelease(up);
      if (src) _mac.CFRelease(src);
      console.log('[PasteBridge] pasteTo(mac) 完成: ⌘V 已投递');
      return { ok: true, restored: opts.key === 'shift-insert' ? 'mac-shift-insert' : 'mac-focus-release' };
    } catch (err) {
      console.warn('[PasteBridge] pasteTo(mac) 失败:', (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
  }

  /** macOS：轮询 CGEventSourceFlagsState，等待所有修饰键松开（防 ⌥ 唤出后键位污染） */
  private _waitMacModifiersReleased(): boolean {
    const start = Date.now();
    const mask = CG_FLAG_COMMAND | CG_FLAG_SHIFT | CG_FLAG_CONTROL | CG_FLAG_ALTERNATE;
    while (Date.now() - start < MODIFIER_WAIT_MS) {
      if (!_mac) return true;
      const flags = _mac.CGEventSourceFlagsState(CG_SOURCE_STATE_COMBINED);
      if ((flags & mask) === 0) return true;
      this._sleep(15);
    }
    return false;
  }

  /** SendInput 组合键：modifier down → key down → key up → modifier up（4 条 INPUT 一帧） */
  private _sendChord(modVk: number, keyVk: number): number {
    this._ensure();
    if (!_user32) return 0;
    const size = INPUT_SIZE_X64;
    const buf = Buffer.alloc(size * 4);
    const inputs = [
      { type: INPUT_KEYBOARD, wVK: modVk, dwFlags: 0 },
      { type: INPUT_KEYBOARD, wVK: keyVk, dwFlags: 0 },
      { type: INPUT_KEYBOARD, wVK: keyVk, dwFlags: KEYEVENTF_KEYUP },
      { type: INPUT_KEYBOARD, wVK: modVk, dwFlags: KEYEVENTF_KEYUP },
    ];
    inputs.forEach((inp, i) => {
      const off = i * size;
      buf.writeUInt32LE(inp.type, off + OFF_TYPE);
      buf.writeUInt16LE(inp.wVK, off + OFF_WVK);
      buf.writeUInt16LE(0, off + OFF_WSCAN);          // wScan
      buf.writeUInt32LE(inp.dwFlags, off + OFF_FLAGS);
      buf.writeUInt32LE(0, off + OFF_TIME);           // time
      buf.writeBigInt64LE(0n, off + OFF_EXTRA);       // dwExtraInfo
    });
    return _user32.SendInput(4, buf, size) as number;
  }

  /** SendInput 单键 down/up（ALT-tap 等解锁手法用） */
  private _sendSingleKey(vk: number, keyUp: boolean): number {
    this._ensure();
    if (!_user32) return 0;
    const size = INPUT_SIZE_X64;
    const buf = Buffer.alloc(size);
    buf.writeUInt32LE(INPUT_KEYBOARD, OFF_TYPE);
    buf.writeUInt16LE(vk, OFF_WVK);
    buf.writeUInt16LE(0, OFF_WSCAN);
    buf.writeUInt32LE(keyUp ? KEYEVENTF_KEYUP : 0, OFF_FLAGS);
    buf.writeUInt32LE(0, OFF_TIME);
    buf.writeBigInt64LE(0n, OFF_EXTRA);
    return _user32.SendInput(1, buf, size) as number;
  }
}

// CJS 单导出：require('./paste-bridge') 得到 { PasteBridge }（与 .js 原版形状一致）
/** 双击粘贴目标决策（2026-10-30 可测纯函数）：前台抓取优先（自身/瞬态已被过滤为 0），
 *  回退 tracked（唤出面板时记录的原前台）。双 0 = 无目标（调用方拒绝注入）。 */
function resolvePasteTarget(fgNow: number, trackedHwnd: number): number {
  return fgNow > 0 ? fgNow : trackedHwnd;
}
export = { PasteBridge, resolvePasteTarget };
