/**
 * window-opacity.js - 固定/倒计时两段式窗口透明度（2026-09-30）
 *
 * 规则（小M 2026-09-30）：
 *   1. 固定模式开启 → 窗口整体透明度降为 80%
 *   2. 非固定的贴边倒计时（鼠标离开）→ 随倒计时线性降低，倒计时结束时达到
 *      「不影响观察窗口下方内容」的可透视档（OPACITY_GHOST，默认 40%）
 *
 * 代码事实（实现依据）：
 *   - pinned 状态下不存在倒计时：setPinned(true) 会取消隐藏计时器，
 *     _startHideTimer 对 pinned 直接短路——两段规则互斥，不存在叠加
 *   - 主进程原生 setOpacity 驱动：渲染层 innerHTML 全量重建 / 滑入滑出
 *     CSS 动画均不受影响（零渲染层改动）
 *
 * 已知取舍（实机确认点）：
 *   - 倒计时中途鼠标重新进入 → _cancelHideTimer 恢复 100%（固定则 80%），
 *     再次离开则重新从 100% 起降
 */
'use strict';

/** 固定模式透明度：整体降到 80%（小M 拍板） */
const OPACITY_PINNED = 0.8;
/** 倒计时终点「可透视」档：40%，可调 */
const OPACITY_GHOST = 0.4;
/** 完全不透明 */
const OPAQUE = 1;

/**
 * 两段式透明度计算（纯函数，node:test 可直测）。
 *
 * 线性插值口径：倒计时启动（remaining = total）→ 1.0（不透明）；
 * 倒计时终点（remaining = 0）→ OPACITY_GHOST。中间按剩余比例线性。
 *
 * @param {object} [s]
 * @param {boolean} [s.pinned]        固定模式
 * @param {boolean} [s.isCountingDown] 贴边倒计时进行中
 * @param {number} [s.remainingMs]    倒计时剩余 ms
 * @param {number} [s.totalMs]        倒计时总时长 ms
 * @returns {number} [0,1] 内的透明度
 */
function computeOpacity(s) {
  const { pinned, isCountingDown, remainingMs, totalMs } = s || {};
  if (pinned) return OPACITY_PINNED; // 规则 1：固定 → 80%
  if (!isCountingDown) return OPAQUE;
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  if (!total) return OPACITY_GHOST; // 无基准：按终点处理（保守透视显著）
  const remaining = Number.isFinite(remainingMs) ? Math.min(Math.max(remainingMs, 0), total) : 0;
  const ratio = remaining / total; // 1 → 0
  return OPAQUE - (OPAQUE - OPACITY_GHOST) * (1 - ratio);
}

module.exports = { OPACITY_PINNED, OPACITY_GHOST, OPAQUE, computeOpacity };
