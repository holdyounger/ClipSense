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
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.intervalId = null;
    this.hideTimerId = null;
    this.isActive = false;
    this.isWindowVisible = false;
    this.edgeWidth = 5;
    this.hideDelay = 3000;       // 鼠标离开后 3s 隐藏
    this.checkInterval = 100;
    this._lastDraggedPos = null;
    this._hiddenAtPos = null;
    /** 拖拽期间冻结边缘检测（防止窗口变大/漂移） */
    this._isDragging = false;
    /** 隐藏倒计时截止时间戳（ms） */
    this._hideDeadline = null;
    /** 是否正在倒计时中 */
    this.isCountingDown = false;
    /** 是否固定（固定后不自动隐藏） */
    this.isPinned = false;
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
    console.log('[EdgeDetector] 停止边缘检测');
  }

  onMouseEnter() {
    if (this.isPinned) return;
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
    if (this.isPinned) return;
    if (this.isWindowVisible) {
      this._startHideTimer();
    }
  }

  _checkMousePosition() {
    if (this._isDragging) return; // 拖拽期间跳过
    try {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      const { width } = display.workAreaSize;
      const { x: displayX } = display.workArea;

      const rightEdge = displayX + width;
      const distanceFromRight = rightEdge - point.x;

      const wb = this.mainWindow.getBounds();
      const isOverPanel = (
        point.x >= wb.x && point.x <= wb.x + wb.width &&
        point.y >= wb.y && point.y <= wb.y + wb.height
      );

      if (distanceFromRight <= this.edgeWidth && distanceFromRight >= 0) {
        this._cancelHideTimer();
        if (!this.isWindowVisible) this._showWindow(display);
      } else if (this.isWindowVisible) {
        if (!isOverPanel) this._startHideTimer();
        else this._cancelHideTimer();
      }
    } catch (err) {
      console.error(`[EdgeDetector] 检测错误: ${err.message}`);
    }
  }

  _showWindow(display) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const { width, height } = display.workAreaSize;
    // 固定窗口尺寸，避免拖拽/重复显示时尺寸漂移
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

    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    if (!this.mainWindow.isVisible()) this.mainWindow.show();
    this.mainWindow.setOpacity(1);
    this.mainWindow.setBounds({
      x: Math.round(targetX),
      y: Math.round(targetY),
      width: windowWidth,
      height: windowHeight,
    });
    this.isWindowVisible = true;
    console.log(`[EdgeDetector] 显示窗口 (x=${targetX}, y=${targetY})`);
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
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const currentBounds = this.mainWindow.getBounds();
    this._hiddenAtPos = { x: currentBounds.x, y: currentBounds.y };

    const targetEdge = this._getNearestEdge();
    const display = screen.getDisplayNearestPoint({ x: currentBounds.x, y: currentBounds.y });
    const snapX = targetEdge === 'right'
      ? display.workArea.x + display.workAreaSize.width - currentBounds.width
      : display.workArea.x;

    // 简单实现：直接隐藏 + 贴边定位（spike 不做 300ms 动画，保持精简）
    this.mainWindow.setPosition(snapX, currentBounds.y);
    this.mainWindow.hide();
    this.isWindowVisible = false;
    console.log(`[EdgeDetector] 隐藏窗口（贴边: ${targetEdge}）`);
    if (this._onHidden) this._onHidden();
  }

  _startHideTimer() {
    if (this.isPinned) return;
    if (this.hideTimerId) return;

    const deadline = Date.now() + this.hideDelay;
    this._hideDeadline = deadline;
    this.isCountingDown = true;
    this._notifyRendererCountdown();

    this.hideTimerId = setTimeout(() => {
      this._hideWindow();
      this.hideTimerId = null;
      this._hideDeadline = null;
      this.isCountingDown = false;
      this._notifyRendererCountdown();
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
    this.isPinned = pinned;
    if (pinned) {
      this._cancelHideTimer();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        if (!this.mainWindow.isVisible()) this.mainWindow.show();
        if (this.mainWindow.getOpacity() < 1) this.mainWindow.setOpacity(1);
      }
      console.log('[EdgeDetector] 已固定');
    } else {
      console.log('[EdgeDetector] 已取消固定');
    }
  }

  updateDraggedPosition(x, y) {
    this._lastDraggedPos = { x, y };
    console.log(`[EdgeDetector] 记录拖拽位置: (${x}, ${y})`);
  }

  toggle() {
    if (this.isWindowVisible) this.forceHide();
    else this.forceShow();
  }

  forceShow(display = null) {
    if (!display) {
      const point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    }
    this._cancelHideTimer();
    this._showWindow(display);
  }

  forceHide() {
    this._cancelHideTimer();
    this._hideWindow();
  }

  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }
}

module.exports = EdgeDetector;
