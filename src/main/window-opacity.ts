/**
 * window-opacity.ts - 固定/倒计时两段式窗口透明度（2026-09-30）
 *
 * 规则（小M 2026-09-30）：
 *   1. 固定模式开启 → 窗口整体透明度降为 60%
 *   2. 非固定的贴边倒计时（鼠标离开）→ 随倒计时线性降低，倒计时结束时达到
 *      「不影响观察窗口下方内容」的可透视档（OPACITY_GHOST，默认 40%）
 *
 * 代码事实（实现依据）：
 *   - pinned 状态下不存在倒计时：setPinned(true) 会取消隐藏计时器，
 *     _startHideTimer 对 pinned 直接短路——两段规则互斥，不存在叠加
 *   - 透明度经渲染层 CSS alpha 实现：主进程推 `window:opacity` IPC → 渲染层写
 *     `--win-alpha` 变量（原生 setOpacity 整窗缩放无法做「悬停 item 恢复 100%」）
 *
 * 已知取舍（实机确认点）：
 *   - 倒计时中途鼠标重新进入 → _cancelHideTimer 恢复 100%（固定则 60%），
 *     再次离开则重新从 100% 起降
 *
 * TS 迁移示范（2026-09-30）：主进程 CommonJS 模块，export 语法直出（与渲染层
 * 脚本风格不同——主进程模块经 require 加载，无全局挂载需求）。
 */

/** 固定模式透明度：整体降到 60%（小M 实机调参定案，原 80% 偏浅） */
export const OPACITY_PINNED = 0.6;
/** 倒计时终点「可透视」档：40%，可调 */
export const OPACITY_GHOST = 0.4;
/** 完全不透明 */
export const OPAQUE = 1;

/** computeOpacity 参数（两段规则的输入状态） */
export interface ComputeOpacityState {
  pinned?: boolean;          // 固定模式
  isCountingDown?: boolean;  // 贴边倒计时进行中
  remainingMs?: number;      // 倒计时剩余 ms
  totalMs?: number;          // 倒计时总时长 ms
}

/**
 * 两段式透明度计算（纯函数，node:test 可直测）。
 *
 * 线性插值口径：倒计时启动（remaining = total）→ 1.0（不透明）；
 * 倒计时终点（remaining = 0）→ OPACITY_GHOST。中间按剩余比例线性。
 */
export function computeOpacity(s?: ComputeOpacityState): number {
  const { pinned, isCountingDown, remainingMs, totalMs } = s ?? {};
  if (pinned) return OPACITY_PINNED; // 规则 1：固定 → 60%
  if (!isCountingDown) return OPAQUE;
  const total = totalMs && totalMs > 0 ? totalMs : 0; // truthy 检查即窄化 number（排除 undefined/0/NaN）
  if (!total) return OPACITY_GHOST; // 无基准：按终点处理（保守透视显著）
  const remaining = remainingMs !== undefined ? Math.min(Math.max(remainingMs, 0), total) : 0;
  const ratio = remaining / total; // 1 → 0
  return OPAQUE - (OPAQUE - OPACITY_GHOST) * (1 - ratio);
}
