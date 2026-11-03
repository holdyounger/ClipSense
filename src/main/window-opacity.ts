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
/** Alt 穿透档（2026-11-02 快速通道）：窗口未隐藏时按住 Alt 触发穿透 → 降至此值，
 *  给用户「当前鼠标事件直达下层」的可感知反馈（0.5 介于固定 0.6 与透视 0.4 之间） */
export const OPACITY_PASSTHROUGH = 0.5;

/** computeOpacity 参数（两段规则 + 穿透的输入状态） */
export interface ComputeOpacityState {
  pinned?: boolean;          // 固定模式
  isCountingDown?: boolean;  // 贴边倒计时进行中
  remainingMs?: number;      // 倒计时剩余 ms
  totalMs?: number;          // 倒计时总时长 ms
  /** Alt 穿透激活（2026-11-02）：与两段式结果取小值（穿透优先，可感知性最高） */
  passthroughActive?: boolean;
  /** 穿透档位自定义（2026-11-02 托盘菜单）：覆盖 OPACITY_PASSTHROUGH；非法值回落默认 */
  passthroughOpacity?: number;
}

/**
 * 两段式透明度计算（纯函数，node:test 可直测）。
 *
 * 线性插值口径：倒计时启动（remaining = total）→ 1.0（不透明）；
 * 倒计时终点（remaining = 0）→ OPACITY_GHOST。中间按剩余比例线性。
 */
export function computeOpacity(s?: ComputeOpacityState): number {
  const { pinned, isCountingDown, remainingMs, totalMs, passthroughActive, passthroughOpacity } = s ?? {};
  let base: number;
  if (pinned) {
    base = OPACITY_PINNED; // 规则 1：固定 → 60%
  } else if (!isCountingDown) {
    base = OPAQUE;
  } else {
    const total = totalMs && totalMs > 0 ? totalMs : 0; // truthy 检查即窄化 number（排除 undefined/0/NaN）
    if (!total) {
      base = OPACITY_GHOST; // 无基准：按终点处理（保守透视显著）
    } else {
      const remaining = remainingMs !== undefined ? Math.min(Math.max(remainingMs, 0), total) : 0;
      const ratio = remaining / total; // 1 → 0
      base = OPAQUE - (OPAQUE - OPACITY_GHOST) * (1 - ratio);
    }
  }
  // Alt 穿透（2026-11-02）：与两段式取小值——穿透需要「明显变淡」的可感知反馈，
  // 但既有倒计时终点（0.4）已更深时不回弹（取小值语义，状态机不打架）。
  // 档位可配置（2026-11-02 托盘菜单）：合法 [0,1] 数值覆盖默认，否则防呆回落
  let ptLevel = OPACITY_PASSTHROUGH;
  if (typeof passthroughOpacity === 'number' && Number.isFinite(passthroughOpacity)
      && passthroughOpacity > 0 && passthroughOpacity <= 1) {
    ptLevel = passthroughOpacity;
  }
  return passthroughActive ? Math.min(base, ptLevel) : base;
}
