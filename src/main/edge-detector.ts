/**
 * edge-detector.ts - 边缘悬停 + 自动隐藏模块（移植自 KeySense）
 *
 * 功能：
 * - 鼠标靠近屏幕右边缘（5px）唤出窗口
 * - 鼠标离开窗口后定时自动隐藏
 * - 隐藏时贴边（滑动 + 淡出动画）
 * - 重新显示时恢复位置
 *
 * 为剪贴板 spike 做的精简移植，去掉欢迎页、固定、复杂状态机，
 * 保留核心：贴边 + 定时隐藏 + 鼠标唤出。
 *
 * TS 迁移（2026-10-10，第五批 #3）：CommonJS 模块（export = 与 .js
 * module.exports 同形，require 方零改动）；BrowserWindow/screen 以最小
 * 接口建模；_showWindow(display?) 保留 .js 无参兜底路径语义（display!
 * 断言，缺省时与 .js 同点抛 TypeError）；_showAnimationId 兼容 'pending'
 * 占位字符串（过渡锁先行立起）；死代码 rightEdge/width/displayX 移除
 * （noUnusedLocals 强制，grep 证实零引用）；检测/动画/倒计时逻辑零改动。
 */

// ==================== TS 类型（第五批 #3，2026-10-10） ====================
/** 平面坐标/矩形（与 header-hover.ts CursorPoint/WindowBounds 同形） */
interface EdgePoint { x: number; y: number; }
interface EdgeRect { x: number; y: number; width: number; height: number; }

/** electron screen 子集 */
interface EdgeScreenApi {
  getCursorScreenPoint: () => EdgePoint;
  getDisplayNearestPoint: (point: EdgePoint) => EdgeDisplay;
}

/** electron Display 子集（本模块消费 workArea/workAreaSize） */
interface EdgeDisplay {
  workArea: EdgeRect;
  workAreaSize: { width: number; height: number };
}

/** electron WebContents 子集 */
interface EdgeWebContents {
  send: (channel: string, ...args: unknown[]) => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  sendInputEvent: (event: { type: string; x: number; y: number }) => void;
}

/** electron BrowserWindow 子集（主窗口消费面） */
interface EdgeMainWindow {
  isDestroyed: () => boolean;
  getBounds: () => EdgeRect;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  hide: () => void;
  showInactive: () => void;
  setBounds: (bounds: EdgeRect) => void;
  setMinimumSize: (minWidth: number, minHeight: number) => void;
  setIgnoreMouseEvents: (ignore: boolean) => void;
  webContents: EdgeWebContents;
}

/** 触发条窗口（主窗口面 + index.js/本模块写入的动态贴边标记） */
interface EdgeTriggerWindow extends EdgeMainWindow {
  _edge?: 'left' | 'right';
}

/** header hover 状态机最小面（createHeaderHoverState 返回值同构） */
interface EdgeHeaderHoverMachine {
  update: (inHeader: boolean) => { changed: boolean; state: boolean };
  markShown: () => void;
  reset: () => void;
}

/** 倒计时状态（getCountdown / countdown-update 频道） */
interface EdgeCountdownState {
  isCountingDown: boolean;
  remainingMs: number | null;
}

const { screen } = require('electron') as { screen: EdgeScreenApi };
const { DRAWER } = require('./trigger-anim') as { DRAWER: { travel: number; restWidth: number } };
// Header 可变高度（方案 A，2026-09-28）：hover 判定纯逻辑 + 高度常量（header-hover）
const {
  isCursorInHeaderRegion, clampHeaderHeight, createHeaderHoverState,
  HEADER_REST_HEIGHT,
  HEADER_DRAG_RESUME_MS,
} = require('./header-hover') as {
  isCursorInHeaderRegion: (point: EdgePoint, wb: EdgeRect) => boolean;
  clampHeaderHeight: (h: number) => number;
  createHeaderHoverState: () => EdgeHeaderHoverMachine;
  HEADER_REST_HEIGHT: number;
  HEADER_DRAG_RESUME_MS: number;
};
const { computeOpacity } = require('./window-opacity') as {
  computeOpacity: (state?: { pinned: boolean; isCountingDown: boolean; remainingMs: number; totalMs: number }) => number;
};
const { WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_HALF_WIDTH } = require('./window-dims') as {
  WINDOW_WIDTH: number;
  WINDOW_HEIGHT: number;
  WINDOW_HALF_WIDTH: number;
};

class EdgeDetector {
  mainWindow: EdgeMainWindow;
  triggerWindow: EdgeTriggerWindow | null;
  intervalId: NodeJS.Timeout | null;
  _searchActive: boolean;
  hideTimerId: NodeJS.Timeout | null;
  isActive: boolean;
  isWindowVisible: boolean;
  edgeWidth: number;
  triggerWidth: number;
  triggerHeight: number;
  hideDelay: number;
  checkInterval: number;
  _lastIsOverPanel: boolean;
  _lastDraggedPos: { x: number; y: number } | null;
  _hiddenAtPos: { x: number; y: number } | null;
  _hiddenEdge: 'left' | 'right';
  _headerHeight: number;
  _dragResumeAt: number;
  _headerHover: EdgeHeaderHoverMachine;
  _headerHoverLast: boolean;
  _onWindowVisibilityChanged: ((visible: boolean) => void) | null;
  _appliedOpacity: number | null;
  _isDragging: boolean;
  _hideDeadline: number | null;
  isCountingDown: boolean;
  _hiddenCompletedAt: number;
  _wasOverTrigger: boolean;
  _suppressTriggerUntilLeave: boolean;
  _mouseLeaveDebounceId: NodeJS.Timeout | null;
  isPinned: boolean;
  _hideAnimationId: NodeJS.Timeout | null;
  /** 过渡锁兼动画定时器：'pending' 占位（prepare 前先行立起，clearTimeout 对字符串无害） */
  _showAnimationId: NodeJS.Timeout | string | null;
  _showGeneration: number;
  _isHiding: boolean;
  /** 隐藏完成回调（setOnHidden 注入；null = 未注入） */
  _onHidden: (() => void) | null = null;
  /** 弹出回调（setOnShown 注入） */
  _onShown: (() => void) | null = null;

  constructor(mainWindow: EdgeMainWindow, triggerWindow: EdgeTriggerWindow | null = null) {
    this.mainWindow = mainWindow;
    this.triggerWindow = triggerWindow;
    this.intervalId = null;
    this._searchActive = false;   // 搜索输入中（挂起自动隐藏）
    this.hideTimerId = null;
    this.isActive = false;
    this.isWindowVisible = false;
    this.edgeWidth = 5;
    /** 触发条真实命中宽度；不能把透明外壳扩展成整段屏幕区域 */
    this.triggerWidth = 6;
    /** 贴边触发条高度兜底：静止态 header 常量（方案 A 硬前提，32 替代旧实测兜底 56） */
    this.triggerHeight = HEADER_REST_HEIGHT;
    this.hideDelay = 3000;       // 鼠标离开后 3s 隐藏
    this.checkInterval = 100;
    /** 与 KeySense 一致：记录最近一次鼠标是否在面板内，避免边界事件抖动误隐藏 */
    this._lastIsOverPanel = false;
    this._lastDraggedPos = null;
    this._hiddenAtPos = null;
    /** 最近一次隐藏时所在的屏幕边缘（只在该边缘触发恢复） */
    this._hiddenEdge = 'right';
    /** header 高度（px），贴边触发条按此对齐 header。方案 A：常量 32 起步，
     *  滑出时实测仅做 Math.min(h, 36) 钳制采信（DPI 兜底），杜绝展开态污染 */
    this._headerHeight = HEADER_REST_HEIGHT;
    /** header hover 状态机（方案 A）：进入即时/离开防抖 180ms/弹出抑制 400ms */
    this._dragResumeAt = 0; // D-2：拖拽结束恢复缓冲时点（0=无待命缓冲）
    this._headerHover = createHeaderHoverState();
    /** 上一次推送给渲染层的 hover 态（去重：changed 才 send） */
    this._headerHoverLast = false;
    /** 窗口可见性变化回调（2026-09-30）：渲染层贴边 gate 的权威来源 */
    this._onWindowVisibilityChanged = null;
    /** 两段式窗口透明度（2026-09-30）：上次应用值（null=未知，强制重设） */
    this._appliedOpacity = null;
    /** 拖拽期间冻结边缘检测（防止窗口变大/漂移） */
    this._isDragging = false;
    /** 隐藏倒计时截止时间戳（ms） */
    this._hideDeadline = null;
    /** 是否正在倒计时中 */
    this.isCountingDown = false;
    /** 隐藏完成时间戳：防止隐藏后光标仍停在触发条上立刻重新唤出（bounce） */
    this._hiddenCompletedAt = 0;
    /** 防抖状态：隐藏后光标仍停在触发条上时，需先离开再进入才唤出 */
    this._wasOverTrigger = false;
    this._suppressTriggerUntilLeave = false;
    /** mouse-leave 防抖定时器：面板内快速划过子元素时不误启动倒计时 */
    this._mouseLeaveDebounceId = null;
    /** 是否固定（固定后不自动隐藏） */
    this.isPinned = false;
    /** 当前推出/弹入动画定时器，避免窗口动画重复触发 */
    this._hideAnimationId = null;
    this._showAnimationId = null;
    /**
     * 弹出代际令牌：每次 _showWindow 递增。prepare 确认/rAF 链的异步回调
     * 靠比对 gen 判断自己是否仍属当前轮弹出，防止旧回调操纵新一轮动画。
     */
    this._showGeneration = 0;
    this._isHiding = false;
  }

  /**
   * 设置拖拽状态（拖拽期间暂停边缘检测）
   * @param {boolean} dragging
   */
  setDragging(dragging: boolean): void {
    this._isDragging = dragging;
    if (!dragging) {
      // D-2（设计稿 §约束 4）：拖拽结束 200ms 后恢复 hover 判定——结束瞬间光标
      // 通常仍压在 header 上，立即恢复会与「弹出即抖动」同构（测试报告 D-2）。
      this._dragResumeAt = Date.now() + HEADER_DRAG_RESUME_MS;
      // 拖拽结束，记录最终位置
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const b = this.mainWindow.getBounds();
        if (b) this._lastDraggedPos = { x: b.x, y: b.y };
      }
    }
  }

  setOnHidden(callback: () => void): void {
    this._onHidden = callback;
  }

  setOnShown(callback: () => void): void {
    this._onShown = callback;
  }

  /** 窗口可见性变化回调注册（渲染层贴边 gate 的权威来源，2026-09-30） */
  setOnVisibilityChanged(callback: ((visible: boolean) => void) | null): void {
    this._onWindowVisibilityChanged = typeof callback === 'function' ? callback : null;
  }

  start(): void {
    if (this.isActive) return;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const b = this.mainWindow.getBounds();
      if (b) this._lastDraggedPos = { x: b.x, y: b.y };
    }

    this.isActive = true;
    this.intervalId = setInterval(() => this._checkMousePosition(), this.checkInterval);
    console.log('[EdgeDetector] 启动边缘检测');
  }

  stop(): void {
    if (!this.isActive) return;
    // isActive 已保证 intervalId 在手；断言仅类型收窄
    clearInterval(this.intervalId!);
    this.isActive = false;
    if (this._mouseLeaveDebounceId) {
      clearTimeout(this._mouseLeaveDebounceId);
      this._mouseLeaveDebounceId = null;
    }
    this._cancelHideTimer();
    this._cancelHideAnimation();
    this._cancelShowAnimation();
    this._appliedOpacity = null;
    this._syncWindowOpacity(); // 模块停用：复位不透明，不留残效
    console.log('[EdgeDetector] 停止边缘检测');
  }

  onMouseEnter(): void {
    if (this._isHiding) return;
    // 鼠标回到面板：取消待执行的 leave 防抖，避免误启动倒计时。
    if (this._mouseLeaveDebounceId) {
      clearTimeout(this._mouseLeaveDebounceId);
      this._mouseLeaveDebounceId = null;
    }
    this._lastIsOverPanel = true;
    if (this.isPinned) {
      this._cancelHideTimer();
      return;
    }
    if (!this.isWindowVisible) {
      try {
        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        this._showWindow(display);
      } catch (err) {
        this._showWindow();
      }
    }
    this._cancelHideTimer();
  }

  /**
   * 鼠标在面板内快速划过时（如划过 hintEl），渲染进程会瞬时上报 mouse-leave
   * 又即将 mouse-enter。这里加短延迟确认：真正离开才启动倒计时，
   * 避免 hintEl 划过时倒计时徽章闪烁。
   *
   * 注意：只防抖渲染进程的瞬时 mouse-leave 上报；轮询路径直接调
   * _startHideTimer（见 _checkMousePosition），否则轮询每 100ms 重置
   * 防抖定时器会导致倒计时永远无法启动。
   */
  onMouseLeaveDebounced(): void {
    if (this._isHiding) return;
    this._lastIsOverPanel = false;
    if (this.isPinned || !this.isWindowVisible) return;
    if (this._mouseLeaveDebounceId) return; // 已有待执行防抖，不重置（关键！）
    this._mouseLeaveDebounceId = setTimeout(() => {
      this._mouseLeaveDebounceId = null;
      if (!this._lastIsOverPanel && !this.isPinned && this.isWindowVisible) {
        this._startHideTimer();
      }
    }, 120);
  }

  _checkMousePosition(): void {
    if (this._isDragging || this._isHiding || this._showAnimationId) return; // 拖拽/动画期间跳过
    // 窗口已销毁（关窗驻托盘 / before-quit 销毁窗口与 stop() 的时间差）：
    // 轮询还在跑但不能触碰已销毁的 BrowserWindow——否则每拍在下方
    // getBounds() 抛 "Object has been destroyed"，控制台被
    // [EdgeDetector] 检测错误 刷屏（2026-10-10 实机）。早退空转即可。
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      // （TS 迁移注）原此处有 rightEdge = displayX + width 及其两个独占来源
      // width/displayX——grep 证实全文件零引用的死代码，noUnusedLocals 下移除
      const wb = this.mainWindow.getBounds();
      const isOverPanel = (
        point.x >= wb.x && point.x <= wb.x + wb.width &&
        point.y >= wb.y && point.y <= wb.y + wb.height
      );

      // 只有隐藏后的独立 triggerWindow 才是唤出热区。
      // 面板显示时不再把主窗口贴边区域当作触发条，避免 hover 整个窗口边框触发逻辑。
      // V1.0.4：舞台窗口固定 24px 后，唤出热区不再等于物理窗口——仍按屏缘
      // triggerWidth(6px) 锚定（条体静止可见区），避免 18px 预留区误触发热区。
      let triggerBounds: EdgeRect | null = null;
      if (!this.isWindowVisible && this.triggerWindow && !this.triggerWindow.isDestroyed()) {
        const tb = this.triggerWindow.getBounds();
        const anchoredLeft = this.triggerWindow._edge === 'left';
        triggerBounds = {
          x: anchoredLeft ? tb.x : tb.x + tb.width - this.triggerWidth,
          y: tb.y,
          width: this.triggerWidth,
          height: tb.height,
        };
      }
      const isOverTrigger = triggerBounds && (
        point.x >= triggerBounds.x && point.x < triggerBounds.x + triggerBounds.width &&
        point.y >= triggerBounds.y && point.y < triggerBounds.y + triggerBounds.height
      );

      if (isOverTrigger) {
        // 隐藏刚完成时鼠标往往仍停在边缘（触发条位置）。要求「离开触发条后再进入」
        // 才允许唤出，避免隐藏后立刻弹回（bounce）。
        const justHidden = Date.now() - this._hiddenCompletedAt < 400;
        if (justHidden && !this._wasOverTrigger) {
          this._suppressTriggerUntilLeave = true;
        }
        this._wasOverTrigger = true;
        if (!this._suppressTriggerUntilLeave) {
          this._suppressTriggerUntilLeave = false;
          this._lastIsOverPanel = false;
          this._cancelHideTimer();
          if (!this.isWindowVisible) this._showWindow(display);
        }
      } else {
        if (this._wasOverTrigger) {
          this._wasOverTrigger = false;
          this._suppressTriggerUntilLeave = false; // 已离开，解除抑制
        }
        if (this.isWindowVisible) {
          this._lastIsOverPanel = isOverPanel;
          if (!isOverPanel) this.onMouseLeaveDebounced();
          else this._cancelHideTimer();
        }
      }

      // ===== Header 可变高度（方案 A，2026-09-28）=====
      // 复用本轮询（100ms）判定光标是否落在 header 区（窗口顶部 60px 带，
      // 外扩 2px 容差）。进入即时、离开防抖 180ms、弹出后 400ms 抑制
      //（以上均在 header-hover.js 状态机内）；状态翻转才走 IPC。
      // drag 区吞 DOM 鼠标事件（约束 1），渲染层 :hover 不可靠 → 判定必须在主进程。
      if (this.isWindowVisible && !this._isHiding
          && Date.now() >= (this._dragResumeAt || 0)) { // D-2：拖拽结束 200ms 缓冲内冻结判定
        const inHeader = isCursorInHeaderRegion(point, wb);
        const { changed, state } = this._headerHover.update(inHeader);
        if (changed && state !== this._headerHoverLast) {
          this._headerHoverLast = state;
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('header:hover', state);
          }
        }
      }

      // ===== 两段式窗口透明度（2026-09-30）：固定 80% / 倒计时线性降至可透视档 =====
      if (this.isWindowVisible && !this._isHiding) {
        this._syncWindowOpacity();
      }
    } catch (err) {
      console.error(`[EdgeDetector] 检测错误: ${(err as Error).message}`);
    }
  }

  _showWindow(display?: EdgeDisplay): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.isWindowVisible && !this._showAnimationId) return;

    // 同步置可见标记：原先在异步 prepare 回调里才置 true，
    // 轮询的 100ms 空窗期内鼠标若静止在触发条热区上，会用 getBounds()（隐藏窗口也能取到）
    // 误判 isOverTrigger → 重复重入 _showWindow，prepare/'in' 动画链互踩。
    this.isWindowVisible = true;
    if (this._onWindowVisibilityChanged) { try { this._onWindowVisibilityChanged(true); } catch (_) { /* 回调异常不阻断 */ } }
    // 触发条状态与实际对齐（原 resetMouseStateAfterShortcutShow 下沉至此，
    // 覆盖所有弹出路径：启动/边缘触发/快捷键/托盘）。若弹出前鼠标恰在热区上，
    // _wasOverTrigger/_suppressTriggerUntilLeave 卡住会让轮询持续干扰交互
    // → 固定按钮/菜单点不动（18:21 实验证实的机制）。
    this._suppressTriggerUntilLeave = false;
    this._wasOverTrigger = false;

    // 弹出即进入 header hover 抑制窗口（400ms）：唤出瞬间光标常停在 header 区，
    // 立即展开会造成「弹出即抖动」（约束 4）。
    this._headerHover.markShown();
    this._headerHoverLast = false;

    // 在 show() 抢走焦点之前记录原目标窗口，供双击粘贴恢复。
    if (this._onShown) this._onShown();

    const { width, height } = display!.workAreaSize;
    const windowWidth = WINDOW_WIDTH; // 黄金比例常量（window-dims.js）
    const windowHeight = Math.min(WINDOW_HEIGHT, height);

    let targetX: number | undefined;
    let targetY: number | undefined;
    // 防御：残留的 _hiddenAtPos 若落在工作区外（异常中断残留），直接丢弃，
    // 回退到拖拽位置/默认位置，避免窗口唤出到屏幕外。
    if (this._hiddenAtPos) {
      const wa = screen.getDisplayNearestPoint(this._hiddenAtPos).workArea;
      const p = this._hiddenAtPos;
      const inside = p.x >= wa.x - 40 && p.x <= wa.x + wa.width
        && p.y >= wa.y - 10 && p.y <= wa.y + wa.height;
      if (inside) {
        targetX = p.x;
        targetY = p.y;
      } else {
        console.log('[EdgeDetector] 丢弃工作区外的残留隐藏位置:', p);
        this._hiddenAtPos = null;
      }
    }
    if (targetX === undefined && this._lastDraggedPos) {
      targetX = this._lastDraggedPos.x;
      targetY = this._lastDraggedPos.y;
    }
    if (targetX === undefined) {
      targetX = display!.workArea.x + width - windowWidth;
      targetY = display!.workArea.y;
    }

    if (this._showAnimationId) {
      clearTimeout(this._showAnimationId);
    }
    // 过渡锁同步置位：prepare 确认（executeJavaScript 往返 + 双 rAF）与
    // show 后 rAF 链期间，toggle/_checkMousePosition 必须视为动画中。
    // 旧时序锁在 showInactive 后才立起，存在可重入空窗；新时序锁提前到
    // prepare 之前（占位字符串，clearTimeout 对其无害）。
    const gen = ++this._showGeneration;
    this._showAnimationId = 'pending';
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.hide();
    }
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();

    // 恢复正常面板前解除触发条阶段的最小尺寸限制。
    this.mainWindow.setMinimumSize(0, 0);
    this.mainWindow.setIgnoreMouseEvents(false);
    this.mainWindow.setBounds({
      x: Math.round(targetX),
      // targetX/Y 由三条路径成对赋值（隐藏位/拖拽位/工作区回退），逻辑上恒同时有值
      y: Math.round(targetY!),
      width: windowWidth,
      height: windowHeight,
    });

    const edge = this._hiddenAtPos ? this._hiddenEdge : this._getNearestEdgeForPoint(targetX, display!);

    // 方案 B：窗口一次定位到目标位置，滑入/淡入全部由渲染进程 CSS transform 完成。
    // 不再逐帧 setPosition/setOpacity（原生窗口动画在 Windows 上每帧重绘会闪烁）。
    // 1. 先在隐藏状态下准备好起始姿态（内容平移+透明，无过渡），并等渲染层
    //    真正把该姿态绘制并提交一帧后才显示窗口。
    //    关键：executeJavaScript 的 Promise resolve ≠ 渲染层已 paint。
    //    旧版 resolve 即 showInactive()，窗口首帧可能是空白/未变换表面 →
    //    实机「弹出瞬间闪烁一次」+ 首帧合成后才开始 transition → 不流畅。
    //    渲染层 prepare 现在返回双 rAF 绘制确认；showInactive() 以它为准，
    //    50ms 兕底防止确认链异常时窗口永远弹不出来（降级为旧行为）。
    //    前提：index.js 已对该窗口设 backgroundThrottling:false，隐藏态
    //    rAF 正常走帧；否则渲染层会被系统冻结，只能走兕底定时器。
    this.mainWindow.webContents.executeJavaScript(
      `(window.__clipSenseSlide
          ? window.__clipSenseSlide('prepare','${edge}')
          : Promise.resolve())
        .then(() => 'paint-ready')
        .catch(() => 'paint-fallback')`
    ).then((ack) => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
      this._showAfterPrepare(gen, ack === 'paint-ready', edge);
    }).catch(() => {
      // executeJavaScript 失败（页面未就绪等）：直接无动画显示，保证功能可用。
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
      this._showAfterPrepare(gen, false, edge);
    });

    console.log(`[EdgeDetector] 弹出窗口 (x=${targetX}, y=${targetY}, edge=${edge})`);
  }

  /**
   * prepare 绘制确认后的显示后半段：showInactive → hover 刷新 → rAF 对齐滑入。
   * @param {number} gen 调用方 _showWindow 的代际令牌（局部 const，跨异步边界传参）
   * @param {boolean} paintConfirmed 渲染层 prepare 姿态是否已确认绘制
   * @param {string} edge 滑入方向边缘
   */
  _showAfterPrepare(gen: number, paintConfirmed: boolean, edge: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (gen !== this._showGeneration) return; // 已被 stop()/新一轮弹出取代
    if (paintConfirmed) {
      this._beginShowTransition(gen, edge);
      return;
    }
    // 兕底路径：渲染层未确认（未就绪/rAF 冻结）。多等一帧窗口期后直接显示，
    // 大概率 prepare 已落盘；最坏情况回退旧行为（可能闪一次），但功能可用。
    setTimeout(() => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
      if (gen !== this._showGeneration) return; // 已被取代
      this._beginShowTransition(gen, edge);
    }, 50);
  }

  /**
   * 显示后半段公共路径：showInactive + hover 刷新 + 双 rAF 对齐滑入。
   * 旧版用 16ms setTimeout 触发 'in'：与渲染层实际帧不对齐——若落在两帧
   * 之间，'in' 样式变更要等下一帧才开始 transition，首帧推进量随机，
   * 动画观感不流畅。改为双 rAF：第一次回调进入下一帧绘制前，第二次回调
   * 确认当前姿态已提交，此刻应用 'in' 样式，transition 从已知首帧起步。
   */
  _beginShowTransition(gen: number, edge: string): void {
    if (gen !== this._showGeneration) return; // 已被 stop()/新一轮弹出取代
    this.mainWindow.showInactive();
    this._appliedOpacity = null; // 滑出期间透明度残值作废，按当前状态重设（首帧即正确）
    this._syncWindowOpacity();
    this._lastIsOverPanel = false;
    // 弹出在静止光标下方时，Windows 不会给新可见窗口补发 WM_MOUSEMOVE，
    // 渲染层 mouseenter 不触发、OS hover 命中不刷新 → 顶部按钮点击无响应
    // （移出再移回才恢复）。合成 mousemove 已足够（1px 抖动已移除，勿恢复）。
    this._forceCursorHoverRefresh();

    // 'in' 滑入：_showAnimationId 兼作过渡锁（toggle 用它判断动画中）。
    // 隐藏态 rAF 未被节流（backgroundThrottling:false），双 rAF 等效 ~2 帧。
    const startIn = () => {
      if (gen !== this._showGeneration) return; // 锁已被 stop() 清除
      this.mainWindow.webContents.executeJavaScript(
        `window.__clipSenseSlide && window.__clipSenseSlide('in','${edge}')`
      ).catch(() => {});
      this._showAnimationId = setTimeout(() => {
        this._showAnimationId = null;
        // 这次隐藏位置已被消费，后续手动唤出使用拖拽后的位置。
        this._hiddenAtPos = null;
      }, 320);
    };
    this.mainWindow.webContents.executeJavaScript(
      `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
    ).then(startIn).catch(() => {
      // rAF 注入失败（页面异常）：退化为直接滑入，保证面板可见。
      startIn();
    });
  }

  /**
   * 弹出后若光标恰好落在窗口范围内（弹出界面在鼠标 hover 区域），
   * Windows 对「新出现在静止光标下方的窗口」不会主动补发 WM_MOUSEMOVE，
   * 导致渲染层收不到 mouseenter、OS hover 命中也不刷新，固定按钮/菜单栏
   * 点击无响应（鼠标移出再移回才能恢复）。
   *
   * 修复（V1.0.4 修订）：仅注入合成 mousemove（sendInputEvent，零几何变更）。
 * 旧版附带的「窗口 1px 水平抖动再复位」已移除——transparent 窗口可见态
 * setBounds 触发 DWM 表面重分配，是实机「显示闪烁一次 + 动画不流畅」的根因；
 * 且它在滑入动画首帧注入 1px 位移，本身即一次可见抖动。
   */
  _forceCursorHoverRefresh(): void {
    if (process.platform !== 'win32') return;
    try {
      const point = screen.getCursorScreenPoint();
      const b = this.mainWindow.getBounds();
      const inside = point.x >= b.x && point.x <= b.x + b.width
        && point.y >= b.y && point.y <= b.y + b.height;
      if (!inside) return; // 光标不在窗口上，无需刷新
      // ① Chromium 输入注入：绕过 OS stale hit-test，直接给渲染层合成 mousemove
      // → mouseenter/mouseover 正常触发，hover/交互状态立即对齐
      try {
        this.mainWindow.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(point.x - b.x),
          y: Math.round(point.y - b.y),
        });
      } catch (e) { /* 注入失败不阻断 */ }
      // ② （V1.0.4 已移除）旧版此处 1px 水平抖动再复位：两次可见态 setBounds
      // 各触发一次 DWM 表面重分配（显示闪烁），32ms 间隔又在滑入首帧引入
      // 一次可见 1px 跳变。合成 mousemove 已足够对齐渲染层交互状态；
      // 若实机回归「按钮点不动」，回滚本提交恢复抖动并另行排查。
    } catch (err) {
      // 刷新失败不影响显示，静默降级
    }
  }

  _getNearestEdgeForPoint(x: number, display: EdgeDisplay): 'left' | 'right' {
    const { x: dx, width: dw } = display.workArea;
    return (x + WINDOW_HALF_WIDTH - dx) <= ((dx + dw) - (x + WINDOW_HALF_WIDTH)) ? 'left' : 'right';
  }

  _getNearestEdge(): 'left' | 'right' {
    const b = this.mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const { x: dx, width: dw } = display.workArea;
    const centerX = b.x + b.width / 2;
    return (centerX - dx) <= ((dx + dw) - centerX) ? 'left' : 'right';
  }

  _hideWindow(): void {
    if (this.isPinned) {
      console.log('[EdgeDetector] 已固定，拒绝隐藏');
      return;
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed() || this._isHiding) return;

    const currentBounds = this.mainWindow.getBounds();
    this._hiddenAtPos = { x: currentBounds.x, y: currentBounds.y };

    const targetEdge = this._getNearestEdge();
    this._hiddenEdge = targetEdge;
    const display = screen.getDisplayNearestPoint({ x: currentBounds.x, y: currentBounds.y });
    const snapX = targetEdge === 'right'
      ? display.workArea.x + display.workAreaSize.width - currentBounds.width
      : display.workArea.x;

    // 方案 B：窗口位置不动，滑出/淡出全部由渲染进程 CSS transform 完成。
    const startY = currentBounds.y;
    const durationMs = 240;
    this._isHiding = true;

    // 触发条高度 = 静止态 header（方案 A 硬前提）：常量 32 起步，实测值仅做
    // Math.min(h, 36) 钳制采信——滑出由「鼠标离开窗体」触发，那一刻 header 很可能
    // 处于展开态（60px），旧版直接采信会污染触发条高度（约束 2 坑 1）。
    this.mainWindow.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.header'); return el ? el.getBoundingClientRect().height : 0; })()`
    ).then((h) => {
      // executeJavaScript 契约返回 header 高度（number）；断言仅为类型收窄
      this._headerHeight = clampHeaderHeight(h as number);
    }).catch(() => {
      this._headerHeight = HEADER_REST_HEIGHT; // 测量失败回退常量（结构化兜底，禁未处理 rejection）
    });

    // 通知渲染进程开始滑出动画，结束后主进程完成收尾（贴边、隐藏、显示触发条）。
    this.mainWindow.webContents.executeJavaScript(
      `window.__clipSenseSlide && window.__clipSenseSlide('out','${targetEdge}')`
    ).catch(() => {});

    this._hideAnimationId = setTimeout(() => {
      this._finishHideAnimation(targetEdge, snapX, startY, currentBounds.height);
    }, durationMs);

    console.log(`[EdgeDetector] 开始推出动画（方向: ${targetEdge}）`);
  }

  _finishHideAnimation(targetEdge: 'left' | 'right', snapX: number, y: number, height: number): void {
    if (this._hideAnimationId) {
      clearTimeout(this._hideAnimationId);
      this._hideAnimationId = null;
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this._isHiding = false;
      return;
    }

    // 主面板完全隐藏，独立触发窗口负责边缘唤出。
    const triggerDisplay = screen.getDisplayNearestPoint({ x: snapX, y });
    // triggerWindow 只占据可见触发条本身，透明区域不会成为命中热区。
    // V1.0.4 抽屉舞台：物理窗口固定 restWidth + travel（24px），条体锚定屏缘；
    // 静止态可见条 6px，多余 18px 为抽屉拉出预留空间且点击穿透。
    const stageWidth = DRAWER.restWidth + DRAWER.travel;
    const triggerX = targetEdge === 'right'
      ? triggerDisplay.workArea.x + triggerDisplay.workAreaSize.width - stageWidth
      : triggerDisplay.workArea.x;
    // 高度与主面板静止态 header 一致：贴边热区只有 header 部分
    //（方案 A：_headerHeight 常量化 40 + 钳制 ≤44，滑出时 hover 态强制复位）。
    const triggerHeight = this._headerHeight || this.triggerHeight;
    // 滑出即收起 header（约束 4「面板即将收起」规则：跳过收起补间直接 snap），
    // 并复位 hover 状态机，防止下次弹出前残留 true。
    this._headerHover.reset();
    this._headerHoverLast = false;
    this.mainWindow.webContents.executeJavaScript(
      `window.__clipSenseHeaderSnap && window.__clipSenseHeaderSnap()`
    ).catch(() => {});
    this.mainWindow.hide();
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.setBounds({
        x: Math.round(triggerX),
        y: Math.round(y),
        width: stageWidth,
        height: triggerHeight,
      });
      this.triggerWindow._edge = targetEdge;
      // 边样式（className/cavity 渐变方向/光珠锚点）统一走注入脚本的
      // __clipSenseBarApplyEdge（V0.5 真抽屉：单一来源，左右贴边同构）
      this.triggerWindow.webContents.executeJavaScript(
        `window.__clipSenseBarApplyEdge
           ? window.__clipSenseBarApplyEdge('${targetEdge === 'right' ? 'right' : 'left'}')
           : (document.getElementById('bar').className = '${targetEdge === 'right' ? 'right' : 'left'}')`
      ).catch(() => {});
      this.triggerWindow.setIgnoreMouseEvents(true); // 舞台 24px 点击穿透；唤出走主进程轮询
      this.triggerWindow.showInactive();
    }
    this.isWindowVisible = false;
    this._isHiding = false;
    this._lastIsOverPanel = false;
    if (this._onWindowVisibilityChanged) { try { this._onWindowVisibilityChanged(false); } catch (_) { /* 回调异常不阻断 */ } }
    // 记录隐藏完成时间，短窗口期内忽略触发条 hover，防止刚隐藏就弹回。
    this._hiddenCompletedAt = Date.now();
    console.log(`[EdgeDetector] 推出完成，隐藏窗口（贴边: ${targetEdge || 'unknown'}, 触发条: ${this.triggerWidth}x${triggerHeight}）`);
    if (this._onHidden) this._onHidden();
  }

  _cancelShowAnimation(): void {
    // 递增代际：作废所有还在飞行的 prepare 确认/rAF 链回调，
    // 防止 stop() 之后旧回调重新立锁或触发 'in'。
    this._showGeneration++;
    if (this._showAnimationId) {
      clearTimeout(this._showAnimationId);
      this._showAnimationId = null;
    }
  }

  _cancelHideAnimation(): void {
    if (this._hideAnimationId) {
      clearTimeout(this._hideAnimationId);
      this._hideAnimationId = null;
    }
    if (!this._isHiding) return;
    this._isHiding = false;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // 窗口从未移动/淡出（CSS 动画方案），只需通知渲染进程取消滑出动画。
      this.mainWindow.webContents.executeJavaScript(
        `window.__clipSenseSlide && window.__clipSenseSlide('in','${this._hiddenEdge || 'right'}')`
      ).catch(() => {});
    }
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.hide();
    }
  }

  /**
   * 搜索输入期间挂起/恢复自动隐藏（18:42：搜索时鼠标移出导致打字中面板被隐藏）。
   * 挂起时取消已在倒计时的定时器；恢复时若鼠标仍在外则走正常隐藏流程。
   */
  setSearchActive(active: boolean): void {
    this._searchActive = !!active;
    if (active) {
      this._cancelHideTimer();
    } else if (this.isWindowVisible && !this.isPinned && !this._lastIsOverPanel) {
      // 恢复时鼠标仍不在面板上：按正常流程启动倒计时
      this._startHideTimer();
    }
  }

  _startHideTimer(): void {
    if (this.isPinned || this._isHiding) return;
    if (this.hideTimerId) return;
    if (this._lastIsOverPanel) return;
    // 搜索输入期间挂起自动隐藏：用户正在打字，键盘活跃优先于鼠标离开
    if (this._searchActive) return;

    const deadline = Date.now() + this.hideDelay;
    this._hideDeadline = deadline;
    this.isCountingDown = true;
    this._notifyRendererCountdown();
    this._syncWindowOpacity(); // 倒计时启动即回不透明起点（随后每拍线性下降）

    this.hideTimerId = setTimeout(() => {
      this.hideTimerId = null;
      this._hideDeadline = null;
      this.isCountingDown = false;
      this._notifyRendererCountdown();
      if (!this.isPinned && !this._lastIsOverPanel) this._hideWindow();
    }, this.hideDelay);
  }

  _cancelHideTimer(): void {
    if (this.hideTimerId) {
      clearTimeout(this.hideTimerId);
      this.hideTimerId = null;
      this._hideDeadline = null;
      this.isCountingDown = false;
      this._notifyRendererCountdown();
    }
    // 与 KeySense 一致：鼠标重新进入时立即取消未完成的推出动画。
    this._cancelHideAnimation();
    this._syncWindowOpacity(); // 透明度立即恢复（不透明/固定 80%），不等下一拍
  }

  /**
   * 向渲染进程推送倒计时状态
   */
  _notifyRendererCountdown(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send('countdown-update', {
      isCountingDown: this.isCountingDown,
      remainingMs: this.isCountingDown && this._hideDeadline
        ? Math.max(0, this._hideDeadline - Date.now())
        : null,
    });
  }

  /**
   * 两段式窗口透明度（2026-09-30）：按当前状态计算并应用。
   * 规则：固定 → 80%；非固定倒计时 → 随剩余时间线性降至可透视档；
   * 其余 → 不透明。去重：与上次推送值差 <0.01 不重复发 IPC（渲染层写 --win-alpha）。
   */
  _syncWindowOpacity(): void {
    const target = computeOpacity({
      pinned: this.isPinned,
      isCountingDown: this.isCountingDown && this._hideDeadline != null,
      remainingMs: this._hideDeadline ? this._hideDeadline - Date.now() : 0,
      totalMs: this.hideDelay,
    });
    this._applyWindowOpacity(target);
  }

  _applyWindowOpacity(target: number): void {
    if (this._appliedOpacity !== null && Math.abs(target - this._appliedOpacity) < 0.01) return;
    this._appliedOpacity = target;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // 渲染层 CSS alpha（2026-09-30 改造）：原生 setOpacity 是 OS 合成层整体缩放，
      // 子元素无法超越窗口透明度——「悬停 item 恢复 100%」要求透视在渲染层实现。
      // 主进程只推送目标值，渲染层写 --win-alpha 变量（#app 底色 + .item 元素透明度消费）。
      try { this.mainWindow.webContents.send('window:opacity', target); } catch (err) { /* 销毁竞态：静默 */ }
    }
  }

  /**
   * 获取倒计时状态（供 IPC 查询）
   */
  getCountdown(): EdgeCountdownState {
    return {
      isCountingDown: this.isCountingDown,
      remainingMs: this.isCountingDown && this._hideDeadline
        ? Math.max(0, this._hideDeadline - Date.now())
        : null,
    };
  }

  /**
   * 设置隐藏倒计时时长（ms）
   */
  setHideDelay(delay: number): void {
    this.hideDelay = Math.max(1000, Math.min(30000, delay));
    console.log(`[EdgeDetector] 隐藏倒计时更新为: ${this.hideDelay / 1000}秒`);
  }

  /**
   * 设置窗口固定状态
   */
  setPinned(pinned: boolean): void {
    this.isPinned = Boolean(pinned);
    this._appliedOpacity = null;
    this._syncWindowOpacity(); // 规则 1：固定 → 80%；取消固定 → 按当前状态回归
    if (this.isPinned) {
      // 固定时立即终止倒计时和推出动画，并确保面板恢复完整显示。
      this._cancelHideTimer();
      this._cancelHideAnimation();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        if (!this.mainWindow.isVisible()) this.mainWindow.showInactive();
        // CSS 动画方案下恢复显示：通知渲染进程取消滑出动画。
        this.mainWindow.webContents.executeJavaScript(
          `window.__clipSenseSlide && window.__clipSenseSlide('in','${this._hiddenEdge || 'right'}')`
        ).catch(() => {});
      }
      console.log('[EdgeDetector] 已固定');
      return;
    }

    // 与 KeySense 一致：取消固定后，如果鼠标已离开面板，立即重新进入隐藏流程。
    if (this.isWindowVisible && !this._lastIsOverPanel) {
      this._startHideTimer();
    }
    console.log('[EdgeDetector] 已取消固定');
  }

  updateDraggedPosition(x: number, y: number | undefined): void {
    const currentY = this._lastDraggedPos ? this._lastDraggedPos.y : y;
    // 防御路径（实际调用方恒传 number）：currentY 理论 undefined 由调用契约排除
    this._lastDraggedPos = {
      x,
      y: y !== undefined ? y : (currentY as number),
    };
    console.log(`[EdgeDetector] 记录拖拽位置: (${x}, ${y})`);
  }

  toggle(): void {
    // 过渡锁：弹出/隐藏动画未结束时忽略 toggle，防止快速连按导致动画互踩。
    // 尤其是隐藏动画中再触发 hide，会把屏幕外退出坐标记入 _hiddenAtPos，
    // 导致下次唤出位置错乱（窗口跑到屏幕外无法显示）。
    if (this._isHiding || this._showAnimationId) {
      console.log('[EdgeDetector] toggle 忽略：上一次过渡动画尚未结束');
      return;
    }
    if (this.isWindowVisible) this.forceHide();
    else this.forceShow();
  }

  /**
   * 快捷键弹出后重置鼠标位置状态（2026-09-08 已下沉到 _showWindow 统一执行，
   * 此处保留为幂等兜底，行为一致：只清触发条相关卡死状态）。
   * 注意：不置 _lastIsOverPanel=true、不清 hideTimer——
   * 若鼠标不在面板上（快捷键弹出但鼠标没动），置 true 会让轮询永远认为
   * 鼠标在面板上，自动隐藏永不触发 → Alt+V 隐藏体验回帰（18:26 回归）。
   * 只清触发条相关的卡死状态（17:52 实锤的按钮点不动根因），其余交给轮询
   * 的 isOverPanel 实时判定（它用 getBounds 算，不受快捷键路径影响）。
   */
  resetMouseStateAfterShortcutShow(): void {
    this._suppressTriggerUntilLeave = false;
    this._wasOverTrigger = false;
    // 注意：不置 _lastIsOverPanel=true、不清 hideTimer——
    // 若鼠标不在面板上（快捷键弹出但鼠标没动），置 true 会让轮询永远认为
    // 鼠标在面板上，自动隐藏永不触发 → Alt+V 隐藏体验回帰（18:26 回归）。
    // 只清触发条相关的卡死状态（17:52 实锤的按钮点不动根因），其余交给轮询
    // 的 isOverPanel 实时判定（它用 getBounds 算，不受快捷键路径影响）。
  }

  forceShow(display: EdgeDisplay | null = null): void {
    this._cancelHideAnimation();
    if (!display) {
      const point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    }
    this._cancelHideTimer();
    this._showWindow(display);
  }

  forceHide(): void {
    this._cancelHideTimer();
    this._cancelHideAnimation();
    this._hideWindow();
  }

  setMainWindow(mainWindow: EdgeMainWindow): void {
    this.mainWindow = mainWindow;
  }
}

export = EdgeDetector;
