/**
 * dock-anim.ts - 列表条目「磁吸辉光」效果（2026-09-17，方案 A；小M 参考 GSAP dock demo 提出，
 * 实测纵向全宽卡片上 scale 放大压字 → 改为不伤文本的邻近感应信号）
 *
 * 效果：光标沿列表移动时，邻近条目左缘浮出紫色 accent bar——强度（露出高度/亮度/辉光）
 * 按「光标 Y ↔ 条目中心 Y 距离」余弦窗衰减；移出列表后弹性回落。保留 dock 的
 * 「界面回应光标位置」的磁吸感，文本零变形。
 *
 * 实现机制：每个 .item 写一个 CSS 自定义属性 --dock-i（0..1 强度），
 * 条左缘 accent bar 的 transform: scaleY + opacity 由 CSS 消费该变量——
 * JS 每帧只写一个变量，合成层友好，无 layout 触发。
 *
 * 硬约束对齐（.ctx-lockstep/PROJECT.md）：
 *   - 容器委托：监听挂 listEl——innerHTML 全量重建不丢监听
 *   - 动画结束清理内联变量，不驻留合成层
 *   - 零新增运行时依赖（余弦窗衰减自实现）
 *   - prefers-reduced-motion 命中 → 完全 no-op（每帧动态判定）
 *
 * 调参：DOCK_DEFAULTS（radius 影响半径 / restEase 回落速率）。
 *
 * TS 迁移（2026-10-09，第三批 #2）：脚本风格 TS（无 export，顶层 function 挂全局），
 * 守卫式 module.exports 双端挂载与 .js 版同构；interface 编译期擦除零成本。
 */
'use strict';

/** 调参区（改这里即可调手感） */
const DOCK_DEFAULTS = {
  radius: 140,   // 影响半径 px（光标到条目中心距离超过即无感应）
  restEase: 0.2, // 移出列表后的回落速率（每帧向 0 逼近的比例）
};

/** 条目元素最小接口（getBoundingClientRect + style，测试桩可注入） */
interface DockItemElement {
  style: CSSStyleDeclaration;
  getBoundingClientRect(): { top: number; bottom: number; height: number; width?: number };
}

/** 容器元素最小接口（委托监听 + 选择器，测试桩可注入） */
interface DockContainerElement {
  style: CSSStyleDeclaration;
  addEventListener(type: string, fn: (e?: unknown) => void, opts?: unknown): void;
  removeEventListener(type: string, fn: (e?: unknown) => void): void;
  querySelectorAll(selector: string): ArrayLike<DockItemElement>;
}

/** createDockEffect 参数（依赖注入接口即类型接口；container 必需） */
interface CreateDockEffectOptions {
  container: DockContainerElement;
  radius?: number;
  restEase?: number;
  reducedMotion?: () => boolean;
  raf?: (fn: () => void) => number;
  innerHeight?: () => number;
}

/** dock 控制器返回（attach/detach 生命周期 + 测试辅助） */
interface DockEffectController {
  attach: () => void;
  detach: () => void;
  handleRendered: () => void;
  tick: () => void;
  _container: DockContainerElement | null;
  _intensities: Map<DockItemElement, number>;
}

/**
 * 余弦窗衰减：d=0 → 1（最大），d≥radius → 0，两端导数为零（无接缝感）。
 */
function falloff(d: number, radius: number): number {
  if (d >= radius) return 0;
  const t = Math.max(0, d) / radius;
  return 0.5 * (1 + Math.cos(t * Math.PI));
}

/**
 * 创建磁吸辉光效果控制器。
 */
function createDockEffect(opts: CreateDockEffectOptions): DockEffectController {
  const { container } = { ...opts };
  const {
    radius = DOCK_DEFAULTS.radius,
    restEase = DOCK_DEFAULTS.restEase,
    reducedMotion = (): boolean => (typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    raf = (fn: () => void): number => requestAnimationFrame(fn),
    innerHeight = (): number => (typeof window !== 'undefined' ? window.innerHeight : 0),
  } = opts ?? {};

  let mouseY = 0;
  let inside = false;        // 光标是否在容器内
  let tickScheduled = false; // rAF 合帧标记
  const intensities = new Map<DockItemElement, number>(); // el -> 当前强度（回落循环的状态载体）

  function scheduleTick(): void {
    if (tickScheduled) return;
    tickScheduled = true;
    raf(() => {
      tickScheduled = false;
      tick();
    });
  }

  function items(): DockItemElement[] {
    if (!container || !container.querySelectorAll) return [];
    return Array.prototype.slice.call(container.querySelectorAll('.item')) as DockItemElement[];
  }

  /** 写强度（i<=0 时移除变量，内联样式不残留） */
  function apply(el: DockItemElement, i: number): void {
    if (i > 0.01) {
      el.style.setProperty('--dock-i', i.toFixed(3));
      intensities.set(el, i);
    } else {
      el.style.removeProperty('--dock-i');
      intensities.delete(el);
    }
  }

  function clearAll(): void {
    for (const [el] of intensities) {
      if (el && el.style) el.style.removeProperty('--dock-i');
    }
    intensities.clear();
  }

  function tick(): void {
    if (reducedMotion()) {
      // 系统减弱动效：清场回到静止态（幂等）
      if (intensities.size) clearAll();
      return;
    }
    const els = items();
    if (!els.length) {
      if (!inside && intensities.size) clearAll();
      return;
    }
    const vh = typeof innerHeight === 'function' ? innerHeight() : 0;

    // 读全部 → 写全部（无布局抖动）
    const rects = els.map((el) => el.getBoundingClientRect());
    let needReturn = false;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const r = rects[i];
      if (inside && r) {
        // 视口裁剪：屏外条目跳过判定（rect 读已付出，只省变量写）
        const onScreen = !vh || (r.bottom > 0 && r.top < vh);
        if (onScreen) {
          const d = Math.abs(mouseY - (r.top + r.height / 2));
          apply(el, falloff(d, radius));
          continue;
        }
      }
      if (inside) {
        // 屏外且光标在容器内：强度归零
        apply(el, 0);
        continue;
      }
      // 回落态（光标已移出）：向 0 指数逼近
      const cur = intensities.has(el) ? intensities.get(el) ?? 0 : 0;
      const next = cur + (0 - cur) * restEase;
      if (next < 0.01) {
        el.style.removeProperty('--dock-i');
        intensities.delete(el);
      } else {
        intensities.set(el, next);
        el.style.setProperty('--dock-i', next.toFixed(3));
        needReturn = true;
      }
    }
    if (inside) return; // 跟随态由下一次 mousemove/scroll 驱动
    if (needReturn) {
      scheduleTick(); // 回落未完成：继续下一帧
    } else {
      clearAll(); // 全部落位：清内联样式，不驻合成层
    }
  }

  function onMouseMove(e?: unknown): void {
    if (!e || typeof (e as { clientY?: unknown }).clientY !== 'number') return;
    mouseY = (e as { clientY: number }).clientY;
    inside = true;
    scheduleTick();
  }

  function onLeave(): void {
    if (!inside) return;
    inside = false;
    if (intensities.size) scheduleTick(); // 启动回落循环（tick 内自续）
  }

  /**
   * 渲染重建后的状态对齐：新节点无内联变量，仅需丢弃旧节点回落状态。
   * （main.js 在 renderHistory 后调用；不 cancel rAF——对旧节点写样式无害）
   */
  function handleRendered(): void {
    intensities.clear();
  }

  function attach(): void {
    if (!container || !container.addEventListener) return;
    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mouseleave', onLeave);
    container.addEventListener('scroll', scheduleTick, { passive: true });
  }

  function detach(): void {
    if (!container || !container.removeEventListener) return;
    container.removeEventListener('mousemove', onMouseMove);
    container.removeEventListener('mouseleave', onLeave);
    container.removeEventListener('scroll', scheduleTick);
    inside = false;
    clearAll();
  }

  return {
    attach, detach, handleRendered,
    /** 测试/调试：手动驱动一帧（不经 rAF） */
    tick,
    _container: container,
    /** 测试：当前强度快照 */
    _intensities: intensities,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createDockEffect, falloff, DOCK_DEFAULTS };
}
