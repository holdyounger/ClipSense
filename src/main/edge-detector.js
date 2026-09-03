/**
 * edge-detector.js - 边缘悬停 + 自动隐藏模块（移植自 KeySense）
 *
 * 功能：
 * - 鼠标靠近屏幕右边缘（5px）唤出窗口
 * - 鼠标离开窗口后定时自动隐藏
 * - 隐藏时贴边（滑动 + 淡出动画）
 * - 重新显示时恢复位置
 *
 * 为剪贴板 spike 做的精简移植，去掉欢迎页、固定、复杂状态机，
 * 保留核心：贴边 + 定时隐藏 + 鼠标唤出。
 */

const { screen } = require('electron');

class EdgeDetector {
  constructor(mainWindow, triggerWindow = null) {
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
    /** 贴边触发条高度：与主面板 header 一致，热区只覆盖 header 部分（测量值见 _headerHeight） */
    this.triggerHeight = 56;
    this.hideDelay = 3000;       // 鼠标离开后 3s 隐藏
    this.checkInterval = 100;
    /** 与 KeySense 一致：记录最近一次鼠标是否在面板内，避免边界事件抖动误隐藏 */
    this._lastIsOverPanel = false;
    this._lastDraggedPos = null;
    this._hiddenAtPos = null;
    /** 最近一次隐藏时所在的屏幕边缘（只在该边缘触发恢复） */
    this._hiddenEdge = 'right';
    /** 从渲染进程实测的 header 高度（px），贴边触发条按此对齐 header */
    this._headerHeight = null;
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
    this._isHiding = false;
  }

  /**
   * 设置拖拽状态（拖拽期间暂停边缘检测）
   * @param {boolean} dragging
   */
  setDragging(dragging) {
    this._isDragging = dragging;
    if (!dragging) {
      // 拖拽结束，记录最终位置
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const b = this.mainWindow.getBounds();
        if (b) this._lastDraggedPos = { x: b.x, y: b.y };
      }
    }
  }

  setOnHidden(callback) {
    this._onHidden = callback;
  }

  setOnShown(callback) {
    this._onShown = callback;
  }

  start() {
    if (this.isActive) return;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const b = this.mainWindow.getBounds();
      if (b) this._lastDraggedPos = { x: b.x, y: b.y };
    }

    this.isActive = true;
    this.intervalId = setInterval(() => this._checkMousePosition(), this.checkInterval);
    console.log('[EdgeDetector] 启动边缘检测');
  }

  stop() {
    if (!this.isActive) return;
    clearInterval(this.intervalId);
    this.isActive = false;
    if (this._mouseLeaveDebounceId) {
      clearTimeout(this._mouseLeaveDebounceId);
      this._mouseLeaveDebounceId = null;
    }
    this._cancelHideTimer();
    this._cancelHideAnimation();
    this._cancelShowAnimation();
    console.log('[EdgeDetector] 停止边缘检测');
  }

  onMouseEnter() {
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
  onMouseLeaveDebounced() {
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

  _checkMousePosition() {
    if (this._isDragging || this._isHiding || this._showAnimationId) return; // 拖拽/动画期间跳过
    try {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      const { width } = display.workAreaSize;
      const { x: displayX } = display.workArea;

      const rightEdge = displayX + width;
      const wb = this.mainWindow.getBounds();
      const isOverPanel = (
        point.x >= wb.x && point.x <= wb.x + wb.width &&
        point.y >= wb.y && point.y <= wb.y + wb.height
      );

      // 只有隐藏后的独立 triggerWindow 才是唤出热区。
      // 面板显示时不再把主窗口贴边区域当作触发条，避免 hover 整个窗口边框触发逻辑。
      const triggerBounds = !this.isWindowVisible && this.triggerWindow
        && !this.triggerWindow.isDestroyed()
        ? this.triggerWindow.getBounds()
        : null;
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
    } catch (err) {
      console.error(`[EdgeDetector] 检测错误: ${err.message}`);
    }
  }

  _showWindow(display) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.isWindowVisible && !this._showAnimationId) return;

    // 在 show() 抢走焦点之前记录原目标窗口，供双击粘贴恢复。
    if (this._onShown) this._onShown();

    const { width, height } = display.workAreaSize;
    const windowWidth = 360;
    const windowHeight = Math.min(560, height);

    let targetX, targetY;
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
      targetX = display.workArea.x + width - windowWidth;
      targetY = display.workArea.y;
    }

    if (this._showAnimationId) {
      clearTimeout(this._showAnimationId);
      this._showAnimationId = null;
    }
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.hide();
    }
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();

    // 恢复正常面板前解除触发条阶段的最小尺寸限制。
    this.mainWindow.setMinimumSize(0, 0);
    this.mainWindow.setIgnoreMouseEvents(false);
    this.mainWindow.setBounds({
      x: Math.round(targetX),
      y: Math.round(targetY),
      width: windowWidth,
      height: windowHeight,
    });

    const edge = this._hiddenAtPos ? this._hiddenEdge : this._getNearestEdgeForPoint(targetX, display);

    // 方案 B：窗口一次定位到目标位置，滑入/淡入全部由渲染进程 CSS transform 完成。
    // 不再逐帧 setPosition/setOpacity（原生窗口动画在 Windows 上每帧重绘会闪烁）。
    // 1. 先在隐藏状态下准备好起始姿态（内容平移出屏+透明，无过渡），
    //    必须等 prepare 执行完再显示窗口，否则会闪现正常内容。
    this.mainWindow.webContents.executeJavaScript(
      `window.__clipSenseSlide && window.__clipSenseSlide('prepare','${edge}')`
    ).then(() => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
      this.mainWindow.showInactive();
      this.isWindowVisible = true;
      this._lastIsOverPanel = false;

      // 2. 显示后下一帧滑入，CSS transition 接管动画。
      // _showAnimationId 兼作过渡锁（toggle 用它判断动画中）。
      this._showAnimationId = setTimeout(() => {
        this.mainWindow.webContents.executeJavaScript(
          `window.__clipSenseSlide && window.__clipSenseSlide('in','${edge}')`
        ).catch(() => {});
        this._showAnimationId = setTimeout(() => {
          this._showAnimationId = null;
          // 这次隐藏位置已被消费，后续手动唤出使用拖拽后的位置。
          this._hiddenAtPos = null;
        }, 320);
      }, 16);
    }).catch(() => {
      // executeJavaScript 失败（页面未就绪等）：直接无动画显示，保证功能可用。
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
      this._showAnimationId = null;
      this._hiddenAtPos = null;
      this.mainWindow.showInactive();
      this.isWindowVisible = true;
    });

    console.log(`[EdgeDetector] 弹出窗口 (x=${targetX}, y=${targetY}, edge=${edge})`);
  }

  _getNearestEdgeForPoint(x, display) {
    const { x: dx, width: dw } = display.workArea;
    return (x + 180 - dx) <= ((dx + dw) - (x + 180)) ? 'left' : 'right';
  }

  _getNearestEdge() {
    const b = this.mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const { x: dx, width: dw } = display.workArea;
    const centerX = b.x + b.width / 2;
    return (centerX - dx) <= ((dx + dw) - centerX) ? 'left' : 'right';
  }

  _hideWindow() {
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

    // 实测 header 高度：贴边触发条只保留 header 那一段，而不是整个面板高度。
    // CSS min-height:56px 只是布局下限，DPI 缩放后可能更高，这里以实测为准。
    this.mainWindow.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.header'); return el ? el.getBoundingClientRect().height : 0; })()`
    ).then((h) => {
      if (h > 0) this._headerHeight = Math.round(h);
    }).catch(() => {});

    // 通知渲染进程开始滑出动画，结束后主进程完成收尾（贴边、隐藏、显示触发条）。
    this.mainWindow.webContents.executeJavaScript(
      `window.__clipSenseSlide && window.__clipSenseSlide('out','${targetEdge}')`
    ).catch(() => {});

    this._hideAnimationId = setTimeout(() => {
      this._finishHideAnimation(targetEdge, snapX, startY, currentBounds.height);
    }, durationMs);

    console.log(`[EdgeDetector] 开始推出动画（方向: ${targetEdge}）`);
  }

  _finishHideAnimation(targetEdge, snapX, y, height) {
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
    const triggerX = targetEdge === 'right'
      ? triggerDisplay.workArea.x + triggerDisplay.workAreaSize.width - this.triggerWidth
      : triggerDisplay.workArea.x;
    // 高度与主面板 header 一致：贴边热区只有 header 部分。
    const triggerHeight = this._headerHeight || this.triggerHeight;
    this.mainWindow.hide();
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.setBounds({
        x: Math.round(triggerX),
        y: Math.round(y),
        width: this.triggerWidth,
        height: triggerHeight,
      });
      this.triggerWindow._edge = targetEdge;
      this.triggerWindow.webContents.executeJavaScript(
        `document.getElementById('bar').className = '${targetEdge === 'right' ? 'right' : 'left'}'`
      ).catch(() => {});
      this.triggerWindow.setIgnoreMouseEvents(false);
      this.triggerWindow.showInactive();
    }
    this.isWindowVisible = false;
    this._isHiding = false;
    this._lastIsOverPanel = false;
    // 记录隐藏完成时间，短窗口期内忽略触发条 hover，防止刚隐藏就弹回。
    this._hiddenCompletedAt = Date.now();
    console.log(`[EdgeDetector] 推出完成，隐藏窗口（贴边: ${targetEdge || 'unknown'}, 触发条: ${this.triggerWidth}x${triggerHeight}）`);
    if (this._onHidden) this._onHidden();
  }

  _cancelShowAnimation() {
    if (this._showAnimationId) {
      clearTimeout(this._showAnimationId);
      this._showAnimationId = null;
    }
  }

  _cancelHideAnimation() {
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
  setSearchActive(active) {
    this._searchActive = !!active;
    if (active) {
      this._cancelHideTimer();
    } else if (this.isWindowVisible && !this.isPinned && !this._lastIsOverPanel) {
      // 恢复时鼠标仍不在面板上：按正常流程启动倒计时
      this._startHideTimer();
    }
  }

  _startHideTimer() {
    if (this.isPinned || this._isHiding) return;
    if (this.hideTimerId) return;
    if (this._lastIsOverPanel) return;
    // 搜索输入期间挂起自动隐藏：用户正在打字，键盘活跃优先于鼠标离开
    if (this._searchActive) return;

    const deadline = Date.now() + this.hideDelay;
    this._hideDeadline = deadline;
    this.isCountingDown = true;
    this._notifyRendererCountdown();

    this.hideTimerId = setTimeout(() => {
      this.hideTimerId = null;
      this._hideDeadline = null;
      this.isCountingDown = false;
      this._notifyRendererCountdown();
      if (!this.isPinned && !this._lastIsOverPanel) this._hideWindow();
    }, this.hideDelay);
  }

  _cancelHideTimer() {
    if (this.hideTimerId) {
      clearTimeout(this.hideTimerId);
      this.hideTimerId = null;
      this._hideDeadline = null;
      this.isCountingDown = false;
      this._notifyRendererCountdown();
    }
    // 与 KeySense 一致：鼠标重新进入时立即取消未完成的推出动画。
    this._cancelHideAnimation();
  }

  /**
   * 向渲染进程推送倒计时状态
   */
  _notifyRendererCountdown() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send('countdown-update', {
      isCountingDown: this.isCountingDown,
      remainingMs: this.isCountingDown && this._hideDeadline
        ? Math.max(0, this._hideDeadline - Date.now())
        : null,
    });
  }

  /**
   * 获取倒计时状态（供 IPC 查询）
   */
  getCountdown() {
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
  setHideDelay(delay) {
    this.hideDelay = Math.max(1000, Math.min(30000, delay));
    console.log(`[EdgeDetector] 隐藏倒计时更新为: ${this.hideDelay / 1000}秒`);
  }

  /**
   * 设置窗口固定状态
   */
  setPinned(pinned) {
    this.isPinned = Boolean(pinned);
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

  updateDraggedPosition(x, y) {
    const currentY = this._lastDraggedPos ? this._lastDraggedPos.y : y;
    this._lastDraggedPos = {
      x,
      y: y !== undefined ? y : currentY,
    };
    console.log(`[EdgeDetector] 记录拖拽位置: (${x}, ${y})`);
  }

  toggle() {
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
   * 快捷键弹出后重置鼠标位置状态：快捷键弹出绕过了触发条 hover 流程，
   * 若弹出瞬间鼠标恰在触发条热区上，_wasOverTrigger/_suppressTriggerUntilLeave
   * 会卡在 true（系统在等一个永远不会发生的「离开触发条」事件），
   * 轮询用错误状态持续干扰交互 → 固定按钮/菜单点不动（18:21 实验证实）。
   * 弹出后面板就在鼠标下，鼠标位置状态以实际为准：全部重置。
   */
  resetMouseStateAfterShortcutShow() {
    this._suppressTriggerUntilLeave = false;
    this._wasOverTrigger = false;
    // 注意：不置 _lastIsOverPanel=true、不清 hideTimer——
    // 若鼠标不在面板上（快捷键弹出但鼠标没动），置 true 会让轮询永远认为
    // 鼠标在面板上，自动隐藏永不触发 → Alt+V 隐藏体验回帰（18:26 回归）。
    // 只清触发条相关的卡死状态（17:52 实锤的按钮点不动根因），其余交给轮询
    // 的 isOverPanel 实时判定（它用 getBounds 算，不受快捷键路径影响）。
  }

  forceShow(display = null) {
    this._cancelHideAnimation();
    if (!display) {
      const point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    }
    this._cancelHideTimer();
    this._showWindow(display);
  }

  forceHide() {
    this._cancelHideTimer();
    this._cancelHideAnimation();
    this._hideWindow();
  }

  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }
}

module.exports = EdgeDetector;
