/**
 * paste-bridge.js - Electron 主进程内 FFI 直调 user32.dll（koffi）
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
 */

const BUSY_WAIT_MS = 25;           // Ditto 同款忙等上限
const MODIFIER_WAIT_MS = 1500;     // 等用户松开修饰键的上限（CopyQ 模型）

// user32 常量
const SW_RESTORE = 9;
const SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2001;
const SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
const SPIF_SENDCHANGE = 0x02;
const VK_LCONTROL = 0xA2;
const VK_LSHIFT = 0xA0;
const VK_LMENU = 0xA4;
const VK_LWIN = 0x5B;
const VK_V = 0x56;
const VK_INSERT = 0x2D;
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

let _user32 = null;   // 惰性绑定的 user32 函数集
let _kernel32 = null; // kernel32：GetCurrentThreadId 在这里，不在 user32
let _inputSize = 0;   // INPUT 结构体尺寸（x64 = 40）

function _bindUser32() {
  if (_user32) return;
  const koffi = require('koffi');

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  _kernel32 = {
    GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    GetCurrentProcessId: kernel32.func('uint32 __stdcall GetCurrentProcessId()'),
  };

  // INPUT 用手写 Buffer（真实 x64 布局，见顶部注释），不注册 koffi.struct，
  // 避免 Duplicate type name 与 sizeof 错误双重坑。
  _inputSize = INPUT_SIZE_X64;

  _user32 = {
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 nInputs, void *pInputs, int cbSize)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, uint32 *pid)'),
    AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
    BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hWnd)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int nVirtKey)'),
    SystemParametersInfoW: user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, void *pvParam, uint32 fWinIni)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, uint16 *lpClassName, int nMaxCount)'),
    GetCurrentProcessId: kernel32.func('uint32 __stdcall GetCurrentProcessId()'),
  };
}

class PasteBridge {
  constructor() {
    // 惰性绑定：首次 pasteTo/captureForeground 时 require koffi + load user32
    this._ready = false;
  }

  _ensure() {
    if (!this._ready) {
      _bindUser32();
      this._ready = true;
    }
  }

  captureForeground() {
    if (process.platform !== 'win32') return 0;
    try {
      this._ensure();
      const hwnd = Number(_user32.GetForegroundWindow());
      if (!hwnd) return 0;
      return hwnd;
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', err.message);
      return 0;
    }
  }

  /**
   * 带重试的抓前台（双击粘贴专用）：窗口切换瞬间系统处于「无前台」真空态，
   * GetForegroundWindow 会合法返回 0（已踩坑：同一调用栈几毫秒后就有值）。
   * 15ms 间隔轮询，最多 120ms；仍为 0 则放弃（回退 tracked 由调用方决定）。
   * @returns {number} hwnd；仍无前台返回 0
   */
  captureForegroundRetry(maxMs = 120) {
    if (process.platform !== 'win32') return 0;
    try {
      this._ensure();
      const deadline = Date.now() + maxMs;
      let hwnd = 0;
      let attempts = 0;
      while (Date.now() < deadline) {
        hwnd = Number(_user32.GetForegroundWindow());
        if (hwnd) return hwnd;
        attempts++;
        this._sleep(15);
      }
      console.log(`[PasteBridge] captureForeground: 重试 ${attempts} 次仍无前台（真空态超过 ${maxMs}ms）`);
      return 0;
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', err.message);
      return 0;
    }
  }

  /**
   * 同步抓取当前前台窗口（带判定原因），供诊断与过滤
   * @returns {{hwnd: number, pid?: number, cls?: string, reason?: string}}
   */
  captureForegroundVerbose() {
    const fail = (reason, extra = {}) => ({ hwnd: 0, reason, ...extra });
    if (process.platform !== 'win32') return fail('non-win32');
    try {
      this._ensure();
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
      const TRANSIENT = new Set([
        'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
        '#32768', 'tooltips_class32',
        'MSCTFIME UI', 'Default IME', 'IME', 'CyberHelper',
      ]);
      if (TRANSIENT.has(cls)) {
        return fail('shell-or-transient', { pid: winPid, cls });
      }
      console.log(`[PasteBridge] captureForeground: 记录 hwnd=${hwnd} pid=${winPid} class=${cls}`);
      return { hwnd, pid: winPid, cls };
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', err.message);
      return fail('error:' + err.message);
    }
  }

  /**
   * 同步抓取当前前台窗口句柄（面板显示前调用）
   * 过滤规则（2026-09-02「只能粘贴一次」修复）：
   *  - 排除自身进程窗口（面板/触发条）——粘贴到自己无意义
   *  - 排除 Shell 桌面（Progman/WorkerW）——从触发条唤出时前台常是桌面，
   *    旧版记录桌面句柄导致第二次粘贴落到桌面（表现为"句柄无效/粘贴失效"）
   * @returns {number} hwnd；失败/被过滤/非 win32 返回 0
   */
  captureForeground() {
    if (process.platform !== 'win32') return 0;
    try {
      this._ensure();
      const hwnd = Number(_user32.GetForegroundWindow());
      if (!hwnd) {
        console.log('[PasteBridge] captureForeground: GetForegroundWindow 返回 0（无前台）');
        return 0;
      }

      // 现场信息（无论是否过滤都先解析出来）
      const pidBuf = Buffer.alloc(4);
      _user32.GetWindowThreadProcessId(hwnd, pidBuf);
      const winPid = pidBuf.readUInt32LE(0);
      const nameBuf = Buffer.alloc(512);
      const n = _user32.GetClassNameW(hwnd, nameBuf, 256);
      const cls = n > 0 ? nameBuf.toString('utf16le', 0, n * 2) : '?';

      // ① 排除自身进程窗口
      if (winPid === _kernel32.GetCurrentProcessId()) {
        console.log(`[PasteBridge] captureForeground: 跳过自身进程窗口 hwnd=${hwnd} class=${cls}`);
        return 0;
      }

      // ② 排除 Shell 桌面 + 瞬态窗口（按类名）
      const TRANSIENT = new Set([
        'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
        '#32768',                        // 菜单弹窗
        'tooltips_class32',              // tooltip
        'MSCTFIME UI', 'Default IME',    // IME 候选/输入法
        'IME', 'CyberHelper',            // 常见 IME 组件
      ]);
      if (TRANSIENT.has(cls)) {
        console.log(`[PasteBridge] captureForeground: 跳过 Shell/瞬态窗口 class=${cls} hwnd=${hwnd}`);
        return 0;
      }

      console.log(`[PasteBridge] captureForeground: 记录 hwnd=${hwnd} pid=${winPid} class=${cls}`);
      return hwnd;
    } catch (err) {
      console.warn('[PasteBridge] captureForeground 失败:', err.message);
      return 0;
    }
  }

  /**
   * 目标句柄是否仍然有效（可见的顶层窗口）
   * @param {number} hwnd
   */
  isAlive(hwnd) {
    if (!hwnd || process.platform !== 'win32') return false;
    try {
      this._ensure();
      return !!_user32.IsWindow(hwnd);
    } catch {
      return false;
    }
  }

  /**
   * 等待用户松开修饰键（CopyQ waitForModifiersReleased 模型）。
   * 场景：Ctrl+Shift+V 唤出面板后立即双击，用户手指还没离开修饰键，
   * 此时注入的 Ctrl+V 会被用户按着的 Shift 等污染成 Ctrl+Shift+V。
   * @returns {boolean} true=已全部松开；false=超时仍有按住（放弃注入更安全）
   */
  _waitForModifiersReleased() {
    const start = Date.now();
    const mods = [VK_LCONTROL, VK_LSHIFT, VK_LMENU, VK_LWIN];
    while (Date.now() - start < MODIFIER_WAIT_MS) {
      let any = false;
      for (const vk of mods) {
        // 必须用 GetAsyncKeyState（物理键全局态）：GetKeyState 只反映本线程
        // 消息队列——Electron 主进程收不到用户按键，永远返回 0（已踩坑修正）。
        // int16 返回值先转无符号再取最高位。
        const state = _user32.GetAsyncKeyState(vk) & 0xFFFF;
        if (state & 0x8000) { any = true; break; }
      }
      if (!any) return true;
      // 忙等间隔：用 Atomics.wait 不可行（主线程），短 Sleep 模拟
      this._sleep(15);
    }
    return false;
  }

  /** 主线程内短休眠（同步，仅用于修饰键等待；忙等轮询用 GetTickCount） */
  _sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 自旋：spike 可接受，产品化可换 MsgWaitForMultipleObjects */ }
  }

  /**
   * 恢复焦点 + 注入粘贴键，一次同步原子调用
   * @param {number} hwnd 目标窗口句柄（focusTracker 记录）
   * @param {{key?: 'ctrl-v'|'shift-insert'}} [opts]
   * @returns {{ok: boolean, restored?: string, error?: string}}
   */
  pasteTo(hwnd, opts = {}) {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'non-win32' };
    }
    try {
      this._ensure();

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
          console.log(`[PasteBridge] 需要切焦点: 目标=${hwnd} 当前前台=${fgHwnd}(${fgCls})`);

          const fgTidVal = _user32.GetWindowThreadProcessId(fgHwnd, null);
          const tgtTidVal = _user32.GetWindowThreadProcessId(hwnd, null);
          let attached = false;
          if (fgTidVal && tgtTidVal && fgTidVal !== tgtTidVal) {
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

        // --- 修饰键等待（CopyQ 模型，防 Ctrl+Shift+V 手指残留污染） ---
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
        console.log(`[PasteBridge] pasteTo 完成: hwnd=${hwnd} restored=${restored} sent=${sent} key=${chord.vk === VK_V ? 'ctrl-v' : 'shift-insert'}`);
        if (!sent || sent < 4) {
          return { ok: false, restored, error: 'sendinput-failed' };
        }
        return { ok: true, restored };
      } finally {
        // 恢复原前台锁定超时
        _user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, timeoutBuf, 0);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** SendInput 组合键：modifier down → key down → key up → modifier up（4 条 INPUT 一帧） */
  _sendChord(modVk, keyVk) {
    this._ensure();
    const size = _inputSize;
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
    return _user32.SendInput(4, buf, size);
  }

  /** SendInput 单键 down/up（ALT-tap 等解锁手法用） */
  _sendSingleKey(vk, keyUp) {
    this._ensure();
    const size = _inputSize;
    const buf = Buffer.alloc(size);
    buf.writeUInt32LE(INPUT_KEYBOARD, OFF_TYPE);
    buf.writeUInt16LE(vk, OFF_WVK);
    buf.writeUInt16LE(0, OFF_WSCAN);
    buf.writeUInt32LE(keyUp ? KEYEVENTF_KEYUP : 0, OFF_FLAGS);
    buf.writeUInt32LE(0, OFF_TIME);
    buf.writeBigInt64LE(0n, OFF_EXTRA);
    return _user32.SendInput(1, buf, size);
  }
}

module.exports = { PasteBridge };
