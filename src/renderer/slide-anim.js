/**
 * slide-anim.js - 贴边滑入/滑出淡入淡出动画（CSS 合成器驱动）
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
 */

(function () {
  const app = document.getElementById('app');
  if (!app) return;

  // 动画时长需与 edge-detector.js 的收尾 setTimeout(240/320ms) 匹配。
  const SLIDE_MS = 240;

  // 滑动距离：不能超过窗口 bounds（否则被系统裁剪），24px 足够产生方向感。
  const SLIDE_PX = 24;

  // 当前边缘，决定滑动方向（right：向右滑出；left：向左滑出）。
  let edge = 'right';

  function applyTransition(enabled) {
    app.style.transition = enabled
      ? `transform ${SLIDE_MS}ms cubic-bezier(0.33, 0, 0.2, 1), opacity ${SLIDE_MS}ms ease-out`
      : 'none';
  }

  function setOffset(offscreen, transparent) {
    // right 边缘：正向平移滑向右边缘；left 边缘：负向滑向左边缘。
    const tx = edge === 'right' ? `${SLIDE_PX}px` : `-${SLIDE_PX}px`;
    app.style.transform = offscreen ? `translateX(${tx})` : 'translateX(0)';
    app.style.opacity = transparent ? '0' : '1';
  }

  window.__clipSenseSlide = function (action, edgeName) {
    if (edgeName === 'left' || edgeName === 'right') edge = edgeName;

    switch (action) {
      case 'prepare':
        // 无过渡直接摆到起始姿态，避免显示时闪现正常内容。
        applyTransition(false);
        setOffset(true, true);
        // 强制 reflow，确保起始姿态立即生效，后续 transition 才能触发。
        void app.offsetWidth;
        break;

      case 'in':
        applyTransition(true);
        setOffset(false, false);
        break;

      case 'out':
        applyTransition(true);
        setOffset(true, true);
        break;
    }
  };
})();
