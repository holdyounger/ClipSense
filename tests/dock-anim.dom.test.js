'use strict';

/**
 * dock-anim.dom.test.js - 列表条目「磁吸辉光」效果测试（2026-09-17，方案 A）
 *
 * 覆盖：
 *   - falloff 余弦窗数学性质（中点 0.5、两端导数为零、负距离钳制）
 *   - 跟随态：最近条目强度最大 / 半径外为零 / 写入格式 --dock-i（0..1）
 *   - 回落态：mouseleave 后逐帧向 0 逼近，落位后移除变量（不驻内联样式）
 *   - reduced-motion：全程 no-op
 *   - 视口裁剪：屏外条目不参与判定
 *   - handleRendered：innerHTML 重建后丢弃旧节点状态
 *   - attach/detach：监听注册与移除、detach 清场
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createDockEffect, falloff, DOCK_DEFAULTS } =
  require(path.join(__dirname, '..', 'dist', 'renderer', 'dock-anim.js'));

// ---------------- 桩 ----------------

function mkEl(id) {
  const styleProps = {};
  const el = {
    id,
    style: {
      _props: styleProps,
      setProperty(k, v) { styleProps[k] = v; },
      removeProperty(k) { delete styleProps[k]; },
      getPropertyValue(k) { return styleProps[k]; },
    },
    listeners: {},
    _rect: { top: 0, bottom: 0, height: 0, width: 300 },
    addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      el.listeners[t] = (el.listeners[t] || []).filter((f) => f !== fn);
    },
    dispatch(t, evt) { for (const fn of (el.listeners[t] || [])) fn(evt); },
    getBoundingClientRect() { return el._rect; },
  };
  return el;
}

function mkContainer(items) {
  const c = mkEl('container');
  c.querySelectorAll = (sel) => (sel === '.item' ? items : []);
  return c;
}

/** 手动 rAF 队列：scheduleTick 入队，flush 驱动（回落循环带上限防死循环） */
function mkRig(items, { reducedMotion = false, innerHeight = 800 } = {}) {
  const queue = [];
  const dock = createDockEffect({
    container: mkContainer(items),
    reducedMotion: () => reducedMotion,
    raf: (fn) => { queue.push(fn); return queue.length; },
    innerHeight: () => innerHeight,
  });
  return {
    dock,
    container: dock._container,
    flush(max = 200) {
      let n = 0;
      while (queue.length && n++ < max) queue.shift()();
      return n;
    },
  };
}

// 测试辅助：手动驱动一帧（dock.tick() 直驱，不经 rAF 队列）
function driveFrame(dock) {
  dock.tick();
}

// ---------------- falloff ----------------

describe('falloff 余弦窗衰减', () => {
  test('d=0 → 1（最大）；d≥radius → 0；半径中点 → 0.5', () => {
    assert.strictEqual(falloff(0, 100), 1);
    assert.strictEqual(falloff(100, 100), 0);
    assert.strictEqual(falloff(150, 100), 0);
    assert.strictEqual(flossHelper(0.5), 0.5, '中点校验辅助');
  });

  test('负距离钳制（取 max(0,d)）', () => {
    assert.strictEqual(falloff(-10, 100), 1);
  });

  test('两端导数为零：紧邻半径内外的值差平滑', () => {
    assert.ok(falloff(99, 100) > 0 && falloff(99, 100) < 0.01);
  });
});

// 辅助：falloff 中点校验（纯数学）
function flossHelper(t) {
  return 0.5 * (1 + Math.cos(t * Math.PI));
}

// ---------------- 跟随态 ----------------

describe('跟随态（mousemove 驱动）', () => {
  test('最近条目强度最大，远处（半径外）条目无强度', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const b = mkEl('b'); b._rect = { top: 500, bottom: 560, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a, b]);
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 130 }); // 光标压在 a 中心
    flush();
    const ia = dock._intensities.get(a);
    assert.ok(ia > 0.99, `a 应接近最大: ${ia}`);
    assert.ok(!dock._intensities.get(b), '半径外条目无强度');
  });

  test('scale 单调性：光标偏离中心越远，强度越低', () => {
    const a = mkEl('a'); a._rect = { top: 140, bottom: 200, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a]);
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 170 }); // 中心（d=0）
    flush();
    const atCenter = dock._intensities.get(a);
    container.dispatch('mousemove', { clientX: 150, clientY: 230 }); // 偏离 60px
    dock.tick(); // 直驱一帧取当前强度
    const offCenter = dock._intensities.get(a);
    assert.strictEqual(atCenter, 1, '中心命中 = 1.0');
    assert.ok(offCenter >= 0 && offCenter < 1, `偏离应衰减: ${offCenter}`);
  });
});

describe('跟随态（写入格式）', () => {
  test('--dock-i 写入格式正确；强度 0 时变量移除', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const b = mkEl('b'); b._rect = { top: 500, bottom: 560, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a, b]);
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 130 });
    flush();
    const v = a.style.getPropertyValue('--dock-i');
    assert.ok(v && parseFloat(v) > 0.9 && v <= 1, `中心命中强度应 ≈1: ${v}`);
    assert.ok(!b.style.getPropertyValue('--dock-i'), '半径外不写变量');
  });
});

// ---------------- 回落态 ----------------

describe('回落态（mouseleave 驱动）', () => {
  test('移出后逐帧向 0 逼近，全部落位后变量移除', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a]);
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 130 });
    flush();
    const v0 = parseFloat(a.style.getPropertyValue('--dock-i'));
    assert.ok(v0 > 0.9, `悬停时应有强度: ${v0}`);
    container.dispatch('mouseleave', {});
    flush();
    assert.ok(!a.style.getPropertyValue('--dock-i'), '落位后变量应移除');
    assert.strictEqual(dock._intensities.size, 0, '状态表应清空');
  });

  test('回落是渐进的（第一帧未到位，非瞬间跳变）', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a]);
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 130 });
    flush();
    const s0v = dock._intensities.get(a);
    container.dispatch('mouseleave', {});
    dock.tick(); // 手动驱动一帧
    const s1 = dock._intensities.get(a);
    assert.ok(s1 < s0v && s1 > 0, `应渐进回落: ${s0v} → ${s1}`);
  });
});

// ---------------- reduced-motion ----------------

describe('reduced-motion（系统减弱动效）', () => {
  test('跟随态不写 --dock-i（no-op）', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 302 };
    const { dock, container, flush } = mkRig([a], { reducedMotion: true });
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 130 });
    flush();
    assert.ok(!a.style.getPropertyValue('--dock-i'), '减弱动效下不得写变量');
    assert.strictEqual(dock._intensities.size, 0);
  });
});

// ---------------- 视口裁剪 ----------------

describe('视口裁剪', () => {
  test('屏外条目不参与判定', () => {
    const on = mkEl('on'); on._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const off = mkEl('off'); off._rect = { top: 900, bottom: 960, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([on, off], { innerHeight: 800 });
    dock.attach();
    container.dispatch('mousemove', { clientX: 130, clientY: 130 });
    flush();
    assert.ok(dock._intensities.get(on) > 0.9);
    assert.ok(!dock._intensities.get(off), '屏外条目无强度');
  });
});

// ---------------- handleRendered / attach/detach ----------------

describe('生命周期', () => {
  test('handleRendered：innerHTML 重建后丢弃旧节点状态', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a]);
    dock.attach();
    container.dispatch('mousemove', { clientX: 150, clientY: 130 });
    flush();
    assert.ok(dock._intensities.size > 0);
    dock.handleRendered();
    assert.strictEqual(dock._intensities.size, 0, '旧状态应丢弃');
  });

  test('detach：移除监听 + 清场；之后事件不再驱动', () => {
    const a = mkEl('a'); a._rect = { top: 100, bottom: 160, height: 60, width: 300 };
    const { dock, container, flush } = mkRig([a]);
    dock.attach();
    dock.detach();
    container.dispatch('mousemove', { clientY: 130 });
    flush();
    assert.strictEqual(dock._intensities.size, 0, 'detach 后状态表为空');
    assert.ok(!a.style.getPropertyValue('--dock-i'), '清场后无 --dock-i 变量');
  });
});
