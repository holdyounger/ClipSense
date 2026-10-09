/**
 * slide-anim.ts - 贴边滑入/滑出淡入淡出动画（CSS 合成器驱动）
 *
 * 背景：主进程逐帧 setPosition/setOpacity 的原生窗口动画在 Windows 上
 * 每帧触发分层窗口重绘，DWM 跟不上会闪烁。改为窗口 bounds 一次定位，
 * 动画由本模块通过 CSS opacity 过渡完成。
 *
 * 注意：BrowserWindow 是系统窗口，内容超出窗口 bounds 的部分会被系统裁剪，
 * 因此不能用 translateX 出屏（会被硬裁剪，看起来像「动画只在窗口内执行」）。
 * 改为窗口内淡入/淡出 + 轻微滑动（视觉上像滑出，实际在窗口内完成）。
 *
 * 主进程通过 executeJavaScript 调用 window.__clipSenseSlide(action, edge)：
 * - 'prepare'：无过渡瞬间进入起始姿态（透明+滑动偏移），窗口显示前调用
 * - 'in'：淡入+滑入到正常位置（transition 生效）
 * - 'out'：淡出+滑向边缘方向（transition 生效），动画结束后由主进程收尾
 *
 * TS 迁移（2026-10-09，第三批 #4）：IIFE 结构保持（模块私有作用域），
 * 挂载契约 window.__clipSenseSlide 为 edge-detector executeJavaScript 的
 * 字符串引用——函数签名不可变；EdgeName 联合类型收窄滑动方向。
 */
'use strict';

/** 贴边方向（决定滑动方向：right 向右滑出 / left 向左滑出） */
type EdgeName = 'left' | 'right';

/** 动作（主进程 executeJavaScript 字符串契约） */
type SlideAction = 'prepare' | 'in' | 'out';

/** window.__clipSenseSlide 挂载契约（edge-detector 经 executeJavaScript 字符串调用） */
interface Window {
  __clipSenseSlide?: (action: SlideAction, edgeName: string) => Promise<'paint-ready' | undefined>;
}

(function (): void {
  const appNode = document.getElementById('app');
  if (!appNode) return;
  const app: HTMLElement = appNode; // 守卫后窄化别名（闭包内引用不再报 possibly null）

  // 动画时长需与 edge-detector.js 的收尾 setTimeout(240/320ms) 匹配。
  const SLIDE_MS = 240;

  // 滑动距离：不能超过窗口 bounds（否则被系统裁剪），24px 足够产生方向感。
  const SLIDE_PX = 24;

  // 当前边缘，决定滑动方向（right：向右滑出；left：向左滑出）。
  let edge: EdgeName = 'right';

  function applyTransition(enabled: boolean): void {
    app.style.transition = enabled
      ? `transform ${SLIDE_MS}ms cubic-bezier(0.33, 0, 0.2, 1), opacity ${SLIDE_MS}ms ease-out`
      : 'none';
  }

  function setOffset(offscreen: boolean, transparent: boolean): void {
    // right 边缘：正向平移滑向右边缘；left 边缘：负向滑向左边缘。
    const tx = edge === 'right' ? `${SLIDE_PX}px` : `-${SLIDE_PX}px`;
    app.style.transform = offscreen ? `translateX(${tx})` : 'translateX(0)';
    app.style.opacity = transparent ? '0' : '1';
  }

  /**
   * 双 rAF + 同步 reflow：等待渲染层把当前样式真正绘制并提交一帧。
   *
   * executeJavaScript 的 Promise resolve 只代表注入脚本执行完，
   * 不代表 compositor 已出帧。主进程若在脚本执行完就 showInactive()，
   * 窗口呈现的第一帧可能是空白/未变换表面 → 实机「弹出瞬间闪烁一次」。
   * 双 rAF：第一次回调在下一帧绘制前，第二次回调确认该帧已提交。
   * 返回值经 executeJavaScript 回传主进程，showInactive 以此为准。
   */
  function waitPaintReady(): Promise<'paint-ready'> {
    // 同步强制 style/layout 计算，确保 prepare 姿态参与下一帧绘制。
    void app.offsetWidth;
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve('paint-ready'));
      });
    });
  }

  /**
   * 滑入/滑出动作入口（主进程 executeJavaScript 字符串契约：
   * window.__clipSenseSlide(action, edge)——签名/返回值不可变）。
   */
  const slideEntry = function (action: SlideAction, edgeName: string): Promise<'paint-ready' | undefined> {
    if (edgeName === 'left' || edgeName === 'right') edge = edgeName;

    switch (action) {
      case 'prepare':
        // 无过渡直接摆到起始姿态，避免显示时闪现正常内容。
        applyTransition(false);
        setOffset(true, true);
        // 合成层提升提前到隐藏态完成：显示首帧不再发生「创建 GPU 层 +
        // 纹理首次上传」——transparent 窗口首帧 DWM 合成延迟是弹出闪烁
        // 的另一来源。不在动画结束后回收（层降级本身可能引入一次可见
        // 重合成；常驻成本仅一个 340×550 层（黄金比例档，window-dims.js），且隐藏期保留可让下次弹出
        // 直接复用现成表面）。
        app.style.willChange = 'transform, opacity';
        // 返回绘制确认 Promise，主进程必须等它 resolve 才 showInactive()。
        return waitPaintReady();

      case 'in':
        applyTransition(true);
        setOffset(false, false);
        return Promise.resolve(undefined);

      case 'out':
        applyTransition(true);
        setOffset(true, true);
        return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  };
  window.__clipSenseSlide = slideEntry;
})();
