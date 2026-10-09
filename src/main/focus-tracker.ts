/**
 * focus-tracker.ts - 原目标窗口记录（基于 PasteBridge 同步 FFI 抓取）
 *
 * 2026-09-02 架构重设计（Docs/双击粘贴架构重设计-2026-09-02.md）：
 * - capture 改为同步调用 PasteBridge.captureForeground()（FFI GetForegroundWindow，微秒级）
 *   消灭旧版异步 PS 调用的 _pendingTrack 竞态
 * - restore() 删除：恢复动作已内联进 PasteBridge.pasteTo()（原子调用）
 * - 对外 API（capture/getHwnd/clear）不变，index.js 调用点零改动
 *
 * 模型不变（Ditto/CopyQ，2026-08-28 源码调研）：
 *   显示面板前记录前台窗口 → 粘贴时由 PasteBridge 恢复焦点并注入
 *
 * TS 迁移（2026-10-09，第四批 #3）：CommonJS export = 单导出（require 形态与
 * .js 原版一致：类本身而非 { FocusTracker }）；PasteBridge 桥接口最小化声明
 * （仅 captureForeground 一个方法——本类只消费这一个能力）。
 */

/** PasteBridge 桥最小接口（本类只消费 captureForeground） */
interface FocusBridge {
  captureForeground: () => number;
}

/** 原目标窗口追踪器（显示面板前记录前台 → 粘贴时恢复焦点） */
class FocusTracker {
  private _bridge: FocusBridge | null;
  /** 记录的原前台窗口句柄 */
  private _targetHwnd = 0;
  private _trackedAt = 0;

  /**
   * @param bridge PasteBridge 实例（captureForeground 由 koffi FFI 同步实现）
   */
  constructor(bridge: FocusBridge) {
    this._bridge = bridge;
  }

  /**
   * 记录当前前台窗口（面板显示前调用；同步，无 Promise）
   * 若前台被过滤（自身进程/Shell），会**清空**旧记录——宁可无目标也不贴错窗口。
   * @returns 是否成功记录
   */
  capture(): boolean {
    const hwnd = this._bridge ? this._bridge.captureForeground() : 0;
    if (hwnd > 0) {
      this._targetHwnd = hwnd;
      this._trackedAt = Date.now();
      return true;
    }
    // 前台不可用作目标：主动清空，避免 getHwnd() 返回陈旧句柄
    this._targetHwnd = 0;
    this._trackedAt = 0;
    return false;
  }

  /**
   * 面板抢焦前刷新目标（2026-09-11 双击粘贴回归修复）：
   * 焦点模型回切后窗口恒可聚焦 + 全局 pointerdown→focusSearch 会在点击面板瞬间
   * 把前台抢成自身窗口，双击时 captureForeground 被自身过滤→只能回退 tracked。
   * 因此每次面板即将抢焦（focus-search IPC）都先同步刷一次目标：
   * 抓到有效窗口则刷新（覆盖用户切窗后的陈旧记录），抓到 0（前台已是自身/瞬态）
   * 则保留旧记录——与 capture() 不同，**绝不清空**。
   * @returns 是否刷新成功
   */
  refresh(): boolean {
    const hwnd = this._bridge ? this._bridge.captureForeground() : 0;
    if (hwnd > 0) {
      this._targetHwnd = hwnd;
      this._trackedAt = Date.now();
      return true;
    }
    return false;
  }

  /** 取当前记录的目标窗口句柄（未记录/过期返回 0）；不清除记录 */
  getHwnd(): number {
    if (!this._targetHwnd) return 0;
    // 过期句柄不再返回（与 restore 的过期策略一致）
    if (Date.now() - this._trackedAt > 5 * 60 * 1000) return 0;
    return this._targetHwnd;
  }

  /** 清除记录（粘贴完成后调用，避免残留旧句柄） */
  clear(): void {
    this._targetHwnd = 0;
    this._trackedAt = 0;
  }
}

// 命名导出（与 .js 原版 module.exports = { FocusTracker } 契约一致；
// index.js 消费方式：const { FocusTracker } = require('./focus-tracker')）
export { FocusTracker };
