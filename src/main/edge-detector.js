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
    this.hideTimerId = null;
    this.isActive = false;
    this.isWindowVisible = false;
    this.edgeWidth = 5;
    /** 隐藏后仍保留在屏幕边缘的鼠标触发条宽度 */
    /** 触发条真实命中宽度；不能把透明外壳扩展成整段屏幕区域 */
    this.triggerWidth = 6;
    this.hideDelay = 3000;       // 鼠标离开后 3s 隐藏
    this.checkInterval = 100;
    /** 与 KeySense 一致：记录最近一次鼠标是否在面板内，避免边界事件抖动误隐藏 */
    this._lastIsOverPanel = false;
    this._lastDraggedPos = null;
    this._hiddenAtPos = null;
    /** 最近一次隐藏时所在的屏幕边缘（只在该边缘触发恢复） */
    this._hiddenEdge = 'right';
    /** 拖拽期间冻结边缘检测（防止窗口变大/漂移） */
    this._isDragging = false;
    /** 隐藏倒计时截止时间戳（ms） */
    this._hideDeadline = null;
    /** 是否正在倒计时中 */
    this.isCountingDown = false;
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
    this._cancelHideTimer();
    this._cancelHideAnimation();
    this._cancelShowAnimation();
    console.log('[EdgeDetector] 停止边缘检测');
  }

  onMouseEnter() {
    if (this._isHiding) return;
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

  onMouseLeave() {
    if (this._isHiding) return;
    this._lastIsOverPanel = false;
    if (this.isPinned) return;
    if (this.isWindowVisible) {
      this._startHideTimer();
    }
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
        this._lastIsOverPanel = false;
        this._cancelHideTimer();
        if (!this.isWindowVisible) this._showWindow(display);
      } else if (this.isWindowVisible) {
        this._lastIsOverPanel = isOverPanel;
        if (!isOverPanel) this._startHideTimer();
        else this._cancelHideTimer();
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
    if (this._hiddenAtPos) {
      targetX = this._hiddenAtPos.x;
      targetY = this._hiddenAtPos.y;
    } else if (this._lastDraggedPos) {
      targetX = this._lastDraggedPos.x;
      targetY = this._lastDraggedPos.y;
    } else {
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
    const distance = this._hiddenAtPos ? windowWidth : 22;
    const startX = edge === 'right'
      ? targetX + distance
      : targetX - distance;
    const startedAt = Date.now();
    const durationMs = this._hiddenAtPos ? 300 : 220;
    this.mainWindow.setPosition(Math.round(startX), Math.round(targetY));
    this.mainWindow.setOpacity(0);
    this.mainWindow.showInactive();
    this.isWindowVisible = true;
    this._lastIsOverPanel = false;

    const animate = () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        this._showAnimationId = null;
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      // ease-out：快速离开边缘，接近目标位置时柔和停下。
      const eased = 1 - Math.pow(1 - progress, 3);
      this.mainWindow.setPosition(
        Math.round(startX + (targetX - startX) * eased),
        Math.round(targetY),
      );
      this.mainWindow.setOpacity(Math.min(1, eased));

      if (progress < 1) {
        this._showAnimationId = setTimeout(animate, 16);
      } else {
        this._showAnimationId = null;
        this.mainWindow.setPosition(Math.round(targetX), Math.round(targetY));
        this.mainWindow.setOpacity(1);
        // 这次隐藏位置已被消费，后续手动唤出使用拖拽后的位置。
        this._hiddenAtPos = null;
      }
    };

    console.log(`[EdgeDetector] 弹出窗口 (x=${targetX}, y=${targetY}, edge=${edge})`);
    animate();
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
    const exitX = targetEdge === 'right'
      ? display.workArea.x + display.workAreaSize.width
      : display.workArea.x - currentBounds.width;

    // 侧向推出并淡出，避免窗口突然消失；动画结束后再贴边并 hide。
    const startX = currentBounds.x;
    const startY = currentBounds.y;
    const startOpacity = this.mainWindow.getOpacity();
    const durationMs = 240;
    const startedAt = Date.now();
    this._isHiding = true;

    const animate = () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        this._finishHideAnimation();
        return;
      }

      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      // ease-in：开始平稳，结束时快速推出
      const eased = progress * progress * (3 - 2 * progress);
      this.mainWindow.setPosition(
        Math.round(startX + (exitX - startX) * eased),
        startY,
      );
      this.mainWindow.setOpacity(Math.max(0, startOpacity * (1 - eased)));

      if (progress < 1) {
        this._hideAnimationId = setTimeout(animate, 16);
      } else {
        this._finishHideAnimation(targetEdge, snapX, startY, currentBounds.height);
      }
    };

    console.log(`[EdgeDetector] 开始推出动画（方向: ${targetEdge}）`);
    animate();
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
    this.mainWindow.hide();
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.setBounds({
        x: Math.round(triggerX),
        y: Math.round(y),
        width: this.triggerWidth,
        height: height || 480,
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
    console.log(`[EdgeDetector] 推出完成，隐藏窗口（贴边: ${targetEdge || 'unknown'}）`);
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
      this.mainWindow.setOpacity(1);
      this.mainWindow.hide();
    }
    if (this.triggerWindow && !this.triggerWindow.isDestroyed()) {
      this.triggerWindow.hide();
    }
  }

  _startHideTimer() {
    if (this.isPinned || this._isHiding) return;
    if (this.hideTimerId) return;
    if (this._lastIsOverPanel) return;

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
        if (this.mainWindow.getOpacity() < 1) this.mainWindow.setOpacity(1);
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
    if (this.isWindowVisible) this.forceHide();
    else this.forceShow();
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
