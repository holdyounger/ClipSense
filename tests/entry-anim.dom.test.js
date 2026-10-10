'use strict';

/**
 * entry-anim.dom.test.js - 新条目入场动画（方案 C 拟物化飞入）测试
 *
 * 覆盖：
 *  - springFrames / entryFrames：积分收敛、无 NaN、末帧落位、opacity 窗口
 *  - createEntryAnim 触发判定矩阵：真新增/重放/陈旧/粘贴 rebase/基线/清空
 *  - 贴边态：hidden → 脉冲一次 + pending 置位 → 展开 playPending 补播 → 清标记/幂等
 *  - reduced-motion：matchMedia 命中时跳过（经 playEntryAnimIfAllowed 桩验证逻辑）
 *
 * 运行（本机 node --test 必须逐文件指定）：
 *   node --test tests/entry-anim.dom.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'dist', 'renderer');
const {
  springFrames,
  entryFrames,
  playEntryAnim,
  playLandingGlow,
  playSettleWave,
  playTagInsert,
  SPRING_ENTRY,
  WAVE,
} = require(path.join(RENDERER_DIR, 'spring-anim.js'));
const {
  createEntryAnim,
  topEntryOf,
  ENTRY_MAX_AGE_MS,
} = require(path.join(RENDERER_DIR, 'entry-anim.js'));

// ---------------- 工具 ----------------

function mkHarness(visibility = 'visible') {
  const state = { visibility };
  const played = [];
  const pulsed = [];
  const anim = createEntryAnim({
    play: ({ item }) => played.push(item.id),
    visibility: () => state.visibility,
    onPulse: (id) => pulsed.push(id),
  });
  return { anim, played, pulsed, state };
}

function mkItem(id, ageMs = 1000) {
  return { id, timestamp: Date.now() - ageMs, content: 'c' + id };
}

function mkList(...items) {
  return { children: items.map((it) => ({ _itemData: it })) };
}

// ---------------- spring 积分器 ----------------

describe('springFrames 积分', () => {
  test('设计稿固定参数', () => {
    assert.deepStrictEqual(SPRING_ENTRY, { stiffness: 180, damping: 14, mass: 1 });
  });

  test('从 -24 出发（初速 -300）收敛到 0，无 NaN，末帧精确落位', () => {
    const frames = springFrames({ from: -24, to: 0, velocity: -300 });
    assert.ok(frames.length > 2, '应有多帧');
    for (const f of frames) {
      assert.ok(Number.isFinite(f.x), 'x 必须有限');
      assert.ok(Number.isFinite(f.v), 'v 必须有限');
    }
    assert.strictEqual(frames[frames.length - 1].x, 0);
    assert.strictEqual(frames[frames.length - 1].v, 0);
  });

  test('存在过冲（越过目标一次以上采样点）且有回落', () => {
    const frames = springFrames({ from: -24, to: 0, velocity: -300 });
    const peak = Math.max(...frames.map((f) => f.x));
    assert.ok(peak > 0, '应有过冲（x > to）');
    assert.ok(frames[frames.length - 1].x === 0, '最终落位');
  });

  test('收敛时长在 0.3s ~ 1.5s 之间（60fps 步长）', () => {
    const frames = springFrames({ from: -24, to: 0, velocity: -300 });
    const durationMs = frames.length * (1000 / 60);
    assert.ok(durationMs >= 300 && durationMs <= 1500, `实际 ${durationMs}ms`);
  });

  test('maxFrames 截断：异常参数不会无限积分', () => {
    const frames = springFrames({ from: -10000, to: 0, velocity: 0, maxFrames: 5 });
    assert.ok(frames.length <= 6);
  });
});

describe('entryFrames 关键帧', () => {
  test('首帧接近起始位移，末帧精确落位，opacity 递增封顶 1', () => {
    const { frames, durationMs } = entryFrames();
    assert.ok(frames.length > 2);
    assert.ok(durationMs > 0 && durationMs < 2000);
    assert.match(frames[0].transform, /translateY\(-\d/);
    assert.match(frames[frames.length - 1].transform,
      /translateY\(0\.00px\) translateX\(0\.00px\) scale\(1\.0000\) rotate\(0\.00deg\)/);
    assert.strictEqual(frames[frames.length - 1].opacity, 1);
  });

  test('opacity 单调不减且封顶 1（120ms 窗口）', () => {
    const { frames } = entryFrames();
    let prev = 0;
    for (const f of frames) {
      assert.ok(f.opacity >= prev - 1e-9, 'opacity 不得回退');
      prev = f.opacity;
    }
    const i120 = Math.min(Math.ceil(120 / (1000 / 60)) - 1, frames.length - 1);
    assert.strictEqual(frames[i120].opacity, 1);
  });
});

describe('playEntryAnim', () => {
  test('无 animate 能力 → false，不抛错', () => {
    assert.strictEqual(playEntryAnim(null), false);
    assert.strictEqual(playEntryAnim({}), false);
  });

  test('有 animate → 启动，且 onfinish 后 cancel', () => {
    let cancelled = false;
    const el = {
      animate(frames, opts) {
        assert.ok(Array.isArray(frames) && frames.length >= 2);
        assert.ok(opts.duration > 0);
        return {
          cancel() { cancelled = true; },
          onfinish: null,
        };
      },
    };
    const ok = playEntryAnim(el);
    assert.strictEqual(ok, true);
  });
});

// ---------------- 触发判定矩阵 ----------------

describe('createEntryAnim 触发判定', () => {
  test('首次基线渲染（lastTopId=null）→ 不播', () => {
    const { anim, played } = mkHarness();
    const played0 = anim.handleRendered(mkList(mkItem('a', 100)));
    assert.strictEqual(played0, false);
    assert.deepStrictEqual(played, []);
  });

  test('id 变化 + timestamp 新鲜 → 播放一次', () => {
    const { anim, played } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    const played2 = anim.handleRendered(mkList(mkItem('b', 100)));
    assert.strictEqual(played2, true);
    assert.deepStrictEqual(played, ['b']);
  });

  test('id 不变（rebase / 普通刷新 / 粘贴后重建）→ 不播', () => {
    const { anim, played } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    const played2 = anim.handleRendered(mkList(mkItem('a', 100)));
    assert.strictEqual(played2, false);
    assert.deepStrictEqual(played, []);
  });

  test('id 变化但 timestamp 陈旧（历史装载 / 导入）→ 不播', () => {
    const { anim, played } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    const played2 = anim.handleRendered(mkList(mkItem('old', 60 * 60 * 1000)));
    assert.strictEqual(played2, false);
    assert.deepStrictEqual(played, []);
  });

  test('timestamp 距 now 恰为 10s 边界（>= 10s）→ 不播', () => {
    const { anim, played } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    const played2 = anim.handleRendered(mkList(mkItem('edge', ENTRY_MAX_AGE_MS)));
    assert.strictEqual(played2, false);
    assert.deepStrictEqual(played, []);
  });

  test('timestamp 非数值（缺失/NaN）→ 不播', () => {
    const { anim, played } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    const bad = { children: [{ _itemData: { id: 'b', timestamp: 'oops' } }] };
    assert.strictEqual(anim.handleRendered(bad), false);
    assert.deepStrictEqual(played, []);
  });

  test('列表清空 → 清理 pending 标记，不播', () => {
    const { anim, state, played, pulsed } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    anim.handleRendered(mkList(mkItem('b', 100))); // hidden：置 pending
    assert.strictEqual(anim.getState().pendingEntryId, 'b');
    assert.strictEqual(pulsed.length, 1);
    anim.handleRendered(mkList()); // 清空
    assert.strictEqual(anim.getState().pendingEntryId, null);
    assert.strictEqual(anim.getState().pulseFiredFor, null);
    assert.deepStrictEqual(played, []);
  });

  test('topEntryOf 跳过日期分组线等无 _itemData 的前置节点', () => {
    const item = { id: 'real', timestamp: Date.now() };
    const container = {
      children: [
        { className: 'date-header' },
        { _itemData: null },
        { _itemData: item },
      ],
    };
    const r = topEntryOf(container);
    assert.strictEqual(r.item.id, 'real');
    assert.strictEqual(topEntryOf(null), null);
    assert.strictEqual(topEntryOf({}), null);
    assert.strictEqual(topEntryOf({ children: [] }), null);
  });
});

// ---------------- 贴边态：hidden → 脉冲 → 补播 ----------------

describe('贴边态（hidden 收起 → 脉冲 + pending → 展开/渲染 tick 补播）', () => {
  test('hidden 下真新增：不播 + pending 置位 + onPulse 一次', () => {
    const { anim, played, pulsed, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    const list = mkList(mkItem('b', 100));
    assert.strictEqual(anim.handleRendered(list), false);
    assert.strictEqual(anim.getState().pendingEntryId, 'b');
    assert.strictEqual(pulsed.length, 1, '脉冲只发一次');
    assert.deepStrictEqual(played, []);
  });

  test('hidden 下多次渲染同一条目 → 脉冲不重复（pulseFiredFor 去重）', () => {
    const { anim, pulsed, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    anim.handleRendered(mkList(mkItem('b', 100)));
    anim.handleRendered(mkList(mkItem('b', 100)));
    anim.handleRendered(mkList(mkItem('b', 100)));
    assert.strictEqual(pulsed.filter((x) => x === 'b').length, 1);
  });

  test('不同条目到达 → 各自脉冲一次', () => {
    const { anim, pulsed, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    anim.handleRendered(mkList(mkItem('b', 100)));
    anim.handleRendered(mkList(mkItem('c', 100)));
    assert.deepStrictEqual(pulsed, ['b', 'c']);
    assert.strictEqual(anim.getState().pendingEntryId, 'c');
  });

  test('playPending：visible 且顶部命中 → 补播一次 + 清标记；再调幂等 false', () => {
    const { anim, played, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    const list = mkList(mkItem('b', 100));
    anim.handleRendered(list);
    state.visibility = 'visible';
    assert.strictEqual(anim.playPending(list), true);
    assert.deepStrictEqual(played, ['b']);
    assert.strictEqual(anim.getState().pendingEntryId, null);
    assert.strictEqual(anim.playPending(list), false);
  });

  test('playPending 顶部 id 不匹配 → 不清标记，交由后续渲染 tick 兑底', () => {
    const { anim, played, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    anim.handleRendered(mkList(mkItem('b', 100)));
    state.visibility = 'visible';
    const otherList = mkList(mkItem('c', 100));
    assert.strictEqual(anim.playPending(otherList), false);
    assert.strictEqual(anim.getState().pendingEntryId, 'b');
    assert.deepStrictEqual(played, []);
  });

  test('visible 下 id===prevId 但 pendingEntry 命中 → 兑底补播（渲染 tick 双保险）', () => {
    const { anim, played, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'hidden';
    const list = mkList(mkItem('b', 100));
    anim.handleRendered(list);
    state.visibility = 'visible';
    // 不走 playPending，直接下一次渲染 tick（顶部仍是 b）
    const played2 = anim.handleRendered(list);
    assert.strictEqual(played2, true);
    assert.deepStrictEqual(played, ['b']);
    assert.strictEqual(anim.getState().pendingEntryId, null);
  });

  test('visible 下正常渲染不触发补播路径污染', () => {
    const { anim, played, state } = mkHarness();
    anim.handleRendered(mkList(mkItem('a', 100)));
    state.visibility = 'visible';
    anim.handleRendered(mkList(mkItem('b', 100)));
    assert.deepStrictEqual(played, ['b']);
    assert.strictEqual(anim.getState().pendingEntryId, null);
  });
});

// ==================== ② reduced-motion（经真实渲染层 harness） ====================

describe('reduced-motion 跳过 + 动画接线（main.js，DOM 桩 harness）', () => {
  // 与 tag-search.dom.test.js 同源的最小桩：加载 i18n+renderer+spring+entry+main 全文
  const SOURCES = ['i18n.js', 'renderer.js', 'spring-anim.js', 'entry-anim.js', 'dock-anim.js', 'main.js']
    .map((f) => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
    .join('\n;\n');

  function loadRenderer({ reducedMotion, history = [] }) {
    // 复用 tag-search harness 的同构桩（此处内联精简版，避免测试间互相 require）
    const mod = { exports: {} };
    const listeners = {};
    const made = [];
    function makeEl(tag) {
      const el = {
        tagName: String(tag).toUpperCase(), children: [], parentNode: null,
        className: '', id: '', textContent: '', title: '', type: '', value: '',
        placeholder: '', hidden: false, scrollTop: 0, style: {}, dataset: {},
        _l: {},
        classList: {
          add() {}, remove() {}, toggle() { return false; }, contains() { return false; },
        },
        addEventListener(t, fn) { (el._l[t] = el._l[t] || []).push(fn); },
        removeEventListener() {},
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        closest() { return null; }, contains() { return false; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return null; },
        focus() {}, blur() {}, setSelectionRange() {}, scrollTo() {}, remove() {},
        _html: '',
        animate() { el._animated = (el._animated || 0) + 1; return { set onfinish(f) {} }; },
      };
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(v) { el._html = String(v); if (!v) el.children.length = 0; },
      });
      made.push(el);
      return el;
    }
    const registry = new Map();
    const document = {
      visibilityState: 'visible',
      activeElement: null,
      body: makeEl('body'),
      createElement: makeEl,
      getElementById(id) {
        if (!registry.has(id)) { const e = makeEl('div'); e.id = id; registry.set(id, e); }
        return registry.get(id);
      },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener() {},
      querySelectorAll: () => [],
    };
    const win = {
      _history: history,
      matchMedia: (q) => ({ matches: reducedMotion && /reduced-motion/.test(q) }),
      requestAnimationFrame: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      location: { href: '' },
    };
    win.window = win;
    win.document = document;
    win.navigator = { language: 'zh-CN' };
    win.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    win.clipboardAPI = {
      getHistory: async () => win._history,
      copyItem: async () => ({ ok: true }),
      simulateInput: async () => ({ ok: true }),
      removeItem: async () => ({}),
      clearHistory: async () => ({}),
      openExternal: async () => ({ ok: true }),
      openFileLocation: async () => ({ ok: true }),
      getFileIcon: async () => null,
      focusSearch: async () => true,
      blurSearch: async () => true,
      setSearchActive: () => {},
      setPinned: async () => true,
      verifyPinned: async () => false,
      getCountdown: async () => ({ isCountingDown: false, remainingMs: null }),
      mouseEnter: () => {},
      mouseLeave: () => {},
      diagHit: () => {},
      getWindowBounds: async () => null,
      updateDraggedPosition: async () => true,
      dragStart: async () => true,
      dragEnd: async () => true,
      onHistoryUpdated: () => {},
      onCountdownUpdate: () => {},
      getTagSettings: async () => null,
      onTagSettingsUpdated: () => {},
      requestEntryPulse: () => { win._pulses = (win._pulses || 0) + 1; },
    };
    // main.js 里大量裸标识符（document/window/localStorage...）经 this 注入
    const fn = new Function(
      'window', 'document', 'navigator', 'localStorage', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'requestAnimationFrame', 'location', 'module',
      `"use strict";\n${SOURCES}\n;return { get entryAnim() { return typeof entryAnim !== "undefined" ? entryAnim : null; }, get playEntryAnimIfAllowed() { return typeof playEntryAnimIfAllowed !== "undefined" ? playEntryAnimIfAllowed : null; } };`
    );
    const api = fn(win, document, win.navigator, win.localStorage, win.setTimeout,
      win.clearTimeout, win.setInterval, win.clearInterval, win.requestAnimationFrame,
      win.location, undefined);
    return { api, document, win, registry };
  }

  test('playEntryAnimIfAllowed：reduced-motion 命中 → false 且不调 animate', () => {
    const { api, document } = loadRenderer({ reducedMotion: true });
    const el = document.getElementById('some-el');
    assert.strictEqual(api.playEntryAnimIfAllowed(el, { id: 'x' }), false);
    assert.ok(!el._animated, '减弱动效下不得触发 WAAPI');
  });

  test('playEntryAnimIfAllowed：正常动效 → true 且触发 animate', () => {
    const { api, document } = loadRenderer({ reducedMotion: false });
    const el = document.getElementById('some-el-2');
    assert.strictEqual(api.playEntryAnimIfAllowed(el, { id: 'x' }), true);
    assert.strictEqual(el._animated, 1);
  });

  test('main.js 已接线：entryAnim 控制器实例存在（渲染层集成点活着）', () => {
    const { api } = loadRenderer({ reducedMotion: false });
    assert.ok(api.entryAnim && typeof api.entryAnim.handleRendered === 'function');
    assert.ok(typeof api.entryAnim.playPending === 'function');
  });
});

// ---------------- topEntryOf 真实 DOM 兼容（2026-09-12 实机回归） ----------------

describe('topEntryOf children 类型兼容', () => {
  test('children 为 HTMLCollection 型 array-like（非数组）时仍可取顶部条目', () => {
    const item = mkItem('a', 100);
    // 模拟真实 DOM：children 是 array-like（可索引 + length），但不是 Array
    const collection = { length: 2, 0: {}, 1: { _itemData: item } };
    Object.setPrototypeOf(collection, null); // 排除断言 Array.isArray 残留的可能
    const entry = topEntryOf({ children: collection });
    assert.ok(entry, 'array-like children 必须能取到顶部条目（真实 DOM 场景）');
    assert.strictEqual(entry.item.id, 'a');
  });

  test('children 非法（null / 无 length）→ null 不抛错', () => {
    assert.strictEqual(topEntryOf({ children: null }), null);
    assert.strictEqual(topEntryOf({}), null);
    assert.strictEqual(topEntryOf(null), null);
  });
});

// ---------------- 方案 C 拟物化（2026-09-12） ----------------

describe('playLandingGlow 落位光晕', () => {
  test('无 classList 能力 → false 不抛错', () => {
    assert.strictEqual(playLandingGlow(null), false);
    assert.strictEqual(playLandingGlow({}), false);
  });

  test('挂 class 后超时清理（不驻留）', async () => {
    const added = [];
    const el = {
      classList: {
        add(c) { added.push('+' + c); },
        remove(c) { added.push('-' + c); },
        contains() { return false; },
      },
      offsetWidth: 100,
    };
    const ok = playLandingGlow(el, { removeAfterMs: 5 });
    assert.strictEqual(ok, true);
    // 实现顺序：先 remove 旧 class（可重启）→ reflow → add → 超时后 remove
    assert.deepStrictEqual(added, ['-item-landing', '+item-landing']);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(added, ['-item-landing', '+item-landing', '-item-landing'],
      '超时后必须清理 class');
  });
});

describe('playSettleWave 文档入柜推入波（V0.3 物理叙事）', () => {
  function mkChild(animatable, withData = true) {
    const c = {};
    if (withData) c._itemData = { id: 'i' + Math.random() };
    if (animatable) {
      c.animate = (frames, opts) => {
        mkChild.calls.push({ frames, opts });
        return { onfinish: null, cancel() {} };
      };
    }
    return c;
  }
  mkChild.calls = [];

  test('推入波位移 = 新条目实高（测试桩无 offsetHeight → 回退 WAVE.heightPx）', () => {
    mkChild.calls.length = 0;
    const container = { children: [
      mkChild(false, false), // 日期分组线（无 _itemData，顶部前置）
      mkChild(true),         // 新条目（锚点，不入波）
      mkChild(true),
      mkChild(true),
    ] };
    const fired = playSettleWave(container);
    assert.strictEqual(fired, 2, '锚点之后的 2 条旧条目入波');
    const f0 = mkChild.calls[0].frames[0].transform;
    assert.ok(f0.includes(`translateY(-${WAVE.heightPx.toFixed(2)}px)`),
      `首帧应为回退实高 -${WAVE.heightPx}px，实际 ${f0}`);
    assert.strictEqual(mkChild.calls[0].opts.delay, WAVE.startDelayMs);
    assert.strictEqual(mkChild.calls[1].opts.delay, WAVE.startDelayMs + WAVE.stepMs);
  });

  test('heightPx 覆盖实测：位移随新条目实高变化（力来自文档本身）', () => {
    mkChild.calls.length = 0;
    const anchor = mkChild(true);
    anchor.offsetHeight = 96; // 高条目（如长文本展开态）
    const container = { children: [anchor, mkChild(true)] };
    playSettleWave(container, { startDelayMs: 0 });
    assert.ok(mkChild.calls[0].frames[0].transform.includes('translateY(-102.00px)'),
      '位移 = 96 + 6 margin = 102px');
  });

  test('推入弹簧硬于入场弹簧（420/30 vs 180/14）：让位先于落位', () => {
    const push = springFrames({ from: -72, to: 0, settlePos: 1, settleVel: 10, stiffness: 420, damping: 30 });
    const entry = springFrames({ from: -34, to: 0, velocity: -320, settlePos: 1, settleVel: 10 });
    assert.ok(push.length < entry.length,
      `推入收敛帧数（${push.length}）应少于入场（${entry.length}）`);
  });

  test('无锚点（空列表）→ 0', () => {
    assert.strictEqual(playSettleWave({ children: [mkChild(false, false)] }), 0);
    assert.strictEqual(playSettleWave(null), 0);
  });

  test('maxItems 截断长列表（默认 8）', () => {
    mkChild.calls.length = 0;
    const children = [mkChild(true)];
    for (let i = 0; i < 20; i++) children.push(mkChild(true));
    const fired = playSettleWave({ children });
    assert.strictEqual(fired, 8);
  });

  test('不可动画的旧条目跳过但不占波浪名额', () => {
    mkChild.calls.length = 0;
    const container = { children: [mkChild(true), mkChild(false), mkChild(true), mkChild(true)] };
    const fired = playSettleWave(container);
    assert.strictEqual(fired, 2);
    assert.strictEqual(mkChild.calls[1].opts.delay, WAVE.startDelayMs + WAVE.stepMs,
      '延迟按实际入波序号递增');
  });
});

describe('playTagInsert 标签插纸', () => {
  function mkChip(animatable) {
    const chip = {};
    if (animatable) {
      chip.animate = (frames, opts) => {
        mkChip.calls.push({ frames, opts });
        return { onfinish: null, cancel() {} };
      };
    }
    return chip;
  }
  mkChip.calls = [];

  function mkCard(chips) {
    return { querySelectorAll: (sel) => (sel === '.tag-chip' ? chips : []) };
  }

  test('chips 依次插纸：位移 16px、微旋 -8°、45ms 递增', () => {
    mkChip.calls.length = 0;
    const el = mkCard([mkChip(true), mkChip(true), mkChip(true)]);
    const fired = playTagInsert(el);
    assert.strictEqual(fired, 3);
    assert.strictEqual(mkChip.calls[0].opts.delay, 0);
    assert.strictEqual(mkChip.calls[1].opts.delay, 45);
    assert.match(mkChip.calls[0].frames[0].transform, /translateX\(16px\) rotate\(-8deg\)/);
  });

  test('无 chips / 无 querySelector 能力 → 0 不抛错', () => {
    assert.strictEqual(playTagInsert(mkCard([])), 0);
    assert.strictEqual(playTagInsert(null), 0);
    assert.strictEqual(playTagInsert({}), 0);
  });

  test('maxChips 截断（默认 6）', () => {
    mkChip.calls.length = 0;
    const chips = [];
    for (let i = 0; i < 12; i++) chips.push(mkChip(true));
    assert.strictEqual(playTagInsert(mkCard(chips)), 6);
  });
});
