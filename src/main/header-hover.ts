'use strict';

/**
 * header-hover.ts - Header 可变高度·主进程判定纯逻辑（方案 A，2026-09-28）
 *
 * 设计稿：Docs/UI方案-header可变高度-2026-09-28.md「方案 A：主进程轮询 + 高度瞬变 FLIP 补偿」
 * 拍板定案参数（2026-09-29 缩减档：静止 32 / 展开 60，Δ=28 不变）；离开防抖 180ms；
 * 弹出后抑制窗口 400ms；窗界外扩 2px 容差；_headerHeight 实测钳制 min(h, 36)。
 *
 * 本文件零 electron 依赖：判定纯函数 + 状态机（update 接受可注入 now），
 * node --test 可直测。edge-detector.js 在既有 100ms 轮询内喂入光标归属，
 * 状态翻转时由调用方 webContents.send('header:hover', bool) 推送渲染层。
 *
 * TS 迁移（2026-10-09，第四批 #2）：CommonJS export 直出（主进程模块，require 加载）。
 * 接口化：CursorPoint/WindowBounds/HeaderHoverUpdateResult/HeaderHoverState。
 */

/** 静止态 header 高度（px）：设计稿硬前提，_headerHeight 常量与触发条对齐基准 */
export const HEADER_REST_HEIGHT = 32;
/** 展开态 header 高度（px）：主进程 hover 判定带与渲染层 --hover 高度同源 */
export const HEADER_HOVER_HEIGHT = 60;
/** 实测高度钳制上限（px）：DPI 缩放兜底（min(h, 36)，2026-09-29 缩减档） */
export const HEADER_HEIGHT_CLAMP_MAX = 36;
/** 弹出后抑制窗口（ms）：期间不发 true，防「唤出即展开」抖动 */
export const HEADER_HOVER_SUPPRESS_MS = 400;
/** 离开防抖（ms）：进入即时、离开延迟，防边缘抖动 */
export const HEADER_HOVER_LEAVE_DEBOUNCE_MS = 180;
/** 拖拽结束后的 hover 判定恢复缓冲（设计稿 §约束 4：拖拽结束 200ms 后恢复，D-2） */
export const HEADER_DRAG_RESUME_MS = 200;
/** 窗界外扩容差（px）：抵消坐标取整偏差 */
export const BOUNDS_TOLERANCE_PX = 2;

/** 屏幕坐标点（screen.getCursorScreenPoint() 结果） */
export interface CursorPoint {
  x: number;
  y: number;
}

/** 窗口 bounds（getBounds 结果） */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** isCursorInHeaderRegion 参数（判定带高度可覆盖，默认 60） */
export interface HeaderRegionOptions {
  tolerance?: number;
  headerHeight?: number;
}

/**
 * 光标（屏幕坐标点）是否落在 header 区。
 * 判定复合两条件（设计稿 A-2）：光标 ∈ windowBounds 外扩 2px 容差
 * → 且光标 y ∈ [bounds.y, bounds.y + 60]（窗口顶部展开高度带内）。
 * 横向不需要额外判定：面板宽恒 360，in-bounds 已含 x 范围。
 */
export function isCursorInHeaderRegion(
  point: CursorPoint | null,
  bounds: WindowBounds | null,
  tolerance: number = BOUNDS_TOLERANCE_PX,
  headerHeight: number = HEADER_HOVER_HEIGHT
): boolean {
  if (!point || !bounds) return false;
  const { x, y, width, height } = bounds;
  if (![point.x, point.y, x, y, width, height].every(Number.isFinite)) return false;
  const inBounds =
    point.x >= x - tolerance && point.x <= x + width + tolerance &&
    point.y >= y - tolerance && point.y <= y + height + tolerance;
  if (!inBounds) return false;
  return point.y >= y - tolerance && point.y <= y + headerHeight + tolerance;
}

/**
 * 钳制实测 header 高度（约束 2 修法）：常量 32 为主，实测值仅在
 * (0, 36] 区间采信（Math.min(h, 36)），越界/非法回退常量。
 */
export function clampHeaderHeight(h: number | string): number {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return HEADER_REST_HEIGHT;
  return Math.min(Math.round(n), HEADER_HEIGHT_CLAMP_MAX);
}

/** update 返回（状态翻转信号 + 当前态 + 抑制标记） */
export interface HeaderHoverUpdateResult {
  changed: boolean;
  state: boolean;
  suppress: boolean;
}

/** hover 状态机（update 逐拍喂入；无内部定时器，防抖以 leftSince 时间戳实现） */
export interface HeaderHoverStateMachine {
  /** 弹出（_showWindow）后调用：进入抑制窗口，期间永不置 true */
  markShown(now?: number): void;
  /**
   * 每拍喂入。
   * @param inHeader 光标是否在 header 判定带（isCursorInHeaderRegion）
   * @param now 可注入时钟（测试用）
   */
  update(inHeader: boolean, now?: number): HeaderHoverUpdateResult;
  readonly state: boolean;
  readonly suppressRemaining: number;
  /** 窗口隐藏/停止时复位 */
  reset(): void;
}

/** createHeaderHoverState 参数（防抖/抑制窗口可覆盖，测试用） */
export interface HeaderHoverStateOptions {
  leaveDebounceMs?: number;
  suppressMs?: number;
}

/**
 * hover 状态机（轮询逐拍喂入；无内部定时器，防抖以 _leftSince 时间戳实现，
 * 判定粒度 = 轮询周期 100ms 的取整，符合设计稿「100ms 轮询下判定」语义）。
 *
 * update(inHeader, now) → { changed, state, suppress }
 *   - inHeader=true 且不在抑制窗口：立即置 true（撤销离开计时）
 *   - inHeader=false：启动/维持 180ms 离开计时，到期才置 false
 *   - 抑制窗口（弹出后 400ms）：强制 false 基线，且视为「未离开」，
 *     抑制结束时光标若仍在 header 区由下一拍自然进入
 */
export function createHeaderHoverState(opts: HeaderHoverStateOptions = {}): HeaderHoverStateMachine {
  // ?? 窄化（TS 要求）；.js 语义差异：Number.isFinite(NaN)===false 会回落默认，
  // ?? 仅对 null/undefined 回落——NaN 会穿透。状态机入参来自内部调用链，无 NaN 注入面。
  const leaveDebounceMs = opts.leaveDebounceMs ?? HEADER_HOVER_LEAVE_DEBOUNCE_MS;
  const suppressMs = opts.suppressMs ?? HEADER_HOVER_SUPPRESS_MS;

  let state = false;
  let suppressUntil = 0;
  let leftSince: number | null = null; // state=true 且离开中的起始时间戳

  return {
    /** 弹出（_showWindow）后调用：进入抑制窗口，期间永不置 true */
    markShown(now: number = Date.now()): void {
      suppressUntil = now + suppressMs;
      state = false;
      leftSince = null;
    },
    /**
     * 每拍喂入。
     */
    update(inHeader: boolean, now: number = Date.now()): HeaderHoverUpdateResult {
      const suppress = now < suppressUntil;
      const prev = state;

      if (suppress) {
        // 抑制期：恒静止态；抑制结束时光标若仍在 header 区，下一拍即时进入。
        state = false;
        leftSince = null;
      } else if (inHeader) {
        state = true;
        leftSince = null;
      } else if (state) {
        if (leftSince === null) leftSince = now;
        else if (now - leftSince >= leaveDebounceMs) {
          state = false;
          leftSince = null;
        }
      } else {
        leftSince = null;
      }

      return { changed: state !== prev, state, suppress };
    },
    get state() { return state; },
    get suppressRemaining(): number {
      const left = suppressUntil - Date.now();
      return left > 0 ? left : 0;
    },
    /** 窗口隐藏/停止时复位 */
    reset(): void {
      state = false;
      suppressUntil = 0;
      leftSince = null;
    },
  };
}
