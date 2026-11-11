'use strict';

/**
 * pet-menu-audit-verif-20261104.test.js - 菜单重构验证轮·独立审计用例（测试工程师，2026-11-04）
 *
 * 定位：不动产品代码，不改既有测试契约。以可运行 DOM 桩验证「纯函数单测覆盖不到的
 * 渲染层视觉/交互缺陷」，focus：
 *   A1 主扇 3 叶 DOM 完整性（mode/react/quit，无 summon 叶——R5 死分支佐证）
 *   A2 quit 确认气泡：顶部居中公式在 0.7/1.3/2.2 三档窗口（154/286/484px）下的出窗/遮挡判定
 *   A3 react 叶点击链路：triggerReact → __petLive2dAction('react') → model.motion 实调
 *   A4 live2d pending 期右键兜底（Bug-B2）：__l2d 未就绪时 contextmenu 仍发 pet:open-ctx
 *   A5 PIXI canvas z-index=1 钉底 + cm-confirm z-index 200 静态契约
 *   A6 hidden 确认气泡（旧锚定公式）三档几何推演（遮挡/出窗）
 *
 * harness 同构 tests/live2d-backend.dom.test.js（最小 DOM 桩 + new Function 装配
 * dist/renderer/pet-stage.html 经典脚本段）。几何判定补充见
 * temp/verify-20261104/audit-bubble-geometry.js（纯数值推演）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIST_STAGE = path.join(__dirname, '..', 'dist', 'renderer', 'pet-stage.html');
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

// ==================== 内联脚本提取（样板同构 live2d-backend.dom.test.js） ====================

function extractInlineScripts(html) {
  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/type=\s*["']importmap["']/.test(attrs)) continue;
    if (/\bsrc\s*=/.test(attrs)) continue;
    blocks.push({ module: /type=\s*["']module["']/.test(attrs), code: m[2] });
  }
  return blocks;
}

function loadMainScript() {
  const blocks = extractInlineScripts(fs.readFileSync(DIST_STAGE, 'utf8'));
  const main = blocks.find((b) => !b.module && b.code.includes('function start('));
  if (!main) throw new Error('dist/renderer/pet-stage.html 主逻辑段提取失败（先 npm run build:ts）');
  return main.code;
}

const MAIN_CODE = loadMainScript();
const STAGE_HTML = fs.readFileSync(DIST_STAGE, 'utf8');

// ==================== 最小 DOM 桩 ====================

function makeClassList(el) {
  const read = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(' '); };
  return {
    add(...cs) { const s = read(); cs.forEach((c) => s.add(c)); write(s); },
    remove(...cs) { const s = read(); cs.forEach((c) => s.delete(c)); write(s); },
    contains(c) { return read().has(c); },
  };
}

function makeElement(tagName) {
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    textContent: '',
    style: {},
    dataset: {},
    isConnected: true,
    listeners: {},
    offsetLeft: 0,
    offsetTop: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 },
  };
  el.classList = makeClassList(el);
  el.getBoundingClientRect = () => el._rect;
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.contains = (node) => { let n = node; while (n) { if (n === el) return true; n = n.parentNode; } return false; };
  el.querySelector = (sel) => (el.querySelectorAll(sel) || [])[0] || null;
  el.querySelectorAll = (sel) => {
    if (typeof sel !== 'string' || !sel.startsWith('.')) return [];
    const cls = sel.slice(1);
    const out = [];
    const walk = (node) => { for (const c of node.children) { if (String(c.className || '').split(/\s+/).includes(cls)) out.push(c); walk(c); } };
    walk(el);
    return out;
  };
  el.remove = () => { el.isConnected = false; };
  // closest 桩（叶点击委托需要；沿 parentNode 链匹配选择器）
  el.closest = (sel) => {
    const cls = String(sel).replace(/^\./, '');
    let n = el;
    while (n) {
      if (String(n.className || '').split(/\s+/).includes(cls)) return n;
      n = n.parentNode;
    }
    return null;
  };
  return el;
}

function makeVideoStub(doc, id) {
  const el = makeElement('video');
  el.id = id;
  el.videoWidth = 0; el.videoHeight = 0;
  el.readyState = 0; el.paused = true; el.loop = false; el.muted = true;
  el._rect = { left: 900, top: 900, right: 1120, bottom: 1120, width: 220, height: 220, x: 900, y: 900 };
  el.play = () => {
    el.paused = false;
    return { then(f) { if (typeof f === 'function') f(); return { catch() {} }; }, catch() {} };
  };
  el.pause = () => { el.paused = true; };
  return el;
}

function makeDocument() {
  const registry = new Map();
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    body: null,
    createElement: (tag) => makeElement(tag),
    getElementById(id) {
      if (!registry.has(id)) {
        const el = (id === 'petVideo' || id === 'petVideo2')
          ? makeVideoStub(doc, id)
          : makeElement('div');
        el.id = id;
        registry.set(id, el);
      }
      return registry.get(id);
    },
    addEventListener() {},
    removeEventListener() {},
    dispatch() {},
  };
  doc.body = makeElement('body');
  return doc;
}

function makeIpc(winRef) {
  const sent = [];
  const subs = {};
  const ipc = {
    sent,
    subs,
    send(channel, ...args) { sent.push({ channel, args }); },
    on(channel, fn) { (subs[channel] = subs[channel] || []).push(fn); return ipc; },
    emit(channel, ...args) { for (const fn of (subs[channel] || []).slice()) fn({ sender: null }, ...args); },
    invoke: async (ch) => (ch === 'pet:get-config') ? (winRef().__petTestConfig || {}) : null,
  };
  return ipc;
}

function makeWindow(doc, opts, ipc) {
  const listeners = {};
  const win = {
    innerWidth: 220, innerHeight: 220, screenX: 100, screenY: 200,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, evt) {
      const e = Object.assign({
        target: win, stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {},
      }, evt || {});
      for (const fn of (listeners[type] || []).slice()) fn(e);
    },
  };
  win.__petIpc = ipc;
  win.__petMovesDir = '/mock/pet-moves';
  win.__petReadMove = (name) => new Blob([name]);
  if (opts.pixi) win.PIXI = opts.pixi;
  win.__petTestConfig = opts.config || null;
  return win;
}

function makeTimers() {
  const timers = new Map();
  let now = 0;
  let seq = 1;
  const setTimeout = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + (ms || 0) }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const setInterval = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + (ms || 0), interval: ms || 1 }); return id; };
  const clearInterval = (id) => { timers.delete(id); };
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        if (t.interval) timers.set(id, { fn: t.fn, at: now + t.interval, interval: t.interval });
        t.fn();
      }
    }
  };
  return { setTimeout, clearTimeout, setInterval, clearInterval, advance, now: () => now };
}

function makeRAF() {
  const queue = [];
  const raf = (fn) => { queue.push(fn); return queue.length; };
  raf.flush = () => {
    const cur = queue.splice(0);
    for (const fn of cur) fn(performance.now());
  };
  return raf;
}

// ==================== PIXI.live2d mock ====================

function makeModel(winRef) {
  const motions = [];
  const events = {};
  const model = {
    internalModel: { focusController: { focus() {} } },
    motion(group, index) { motions.push([group, index]); },
    on(type, fn) { (events[type] = events[type] || []).push(fn); return model; },
    // harness 口径修正（2026-11-04 A6 1.3× 遮挡误报根因）：原固定 (60,40,100,180)
    // 不随窗口缩放，虚构出「扇形在窗口高位」的几何。真实运行时 layoutLive2d 铺满语义
    // = 模型铺满窗口高 ×0.7 宽比、底边锚定——bounds 跟随窗口推导，还原真实几何。
    getBounds() {
      const W = winRef() ? winRef().innerWidth : 220;
      const H = winRef() ? winRef().innerHeight : 220;
      return { x: W * 0.15, y: H * 0.15, width: W * 0.7, height: H * 0.85 };
    },
    scale: { set() {} },
    position: { set() {} },
    anchor: { set() {} },
    __motions: motions,
    __events: events,
  };
  return model;
}

function makePIXI(from, winRef) {
  class MockApplication {
    constructor() {
      this.stage = { addChild() {}, interactive: false, hitArea: null };
      this.view = makeElement('canvas');
      this.ticker = { add() {}, start() {}, stop() {} };
      this.renderer = { resize() {}, destroy() {}, plugins: {} };
    }
    destroy() {}
  }
  return { Application: MockApplication, live2d: { Live2DModel: { from } } };
}

// ==================== 装配 ====================

const flushAsync = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await flushAsync(); }

function assemble(opts = {}) {
  const timers = makeTimers();
  const raf = makeRAF();
  const doc = makeDocument();
  let winRef = null;
  const ipc = makeIpc(() => winRef);
  const win = makeWindow(doc, opts, ipc);
  winRef = win;
  const requireStub = (mod) => {
    if (mod === './pet-menu-layout') return MENU_LAYOUT;
    if (mod === 'electron') return { ipcRenderer: ipc };
    throw new Error('harness: 未预期的 require ' + mod);
  };
  const URLStub = { createObjectURL: () => 'blob:mock', revokeObjectURL() {} };
  const factory = new Function(
    'document', 'window', 'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'performance', 'URL', 'Blob', 'console', '__dirname',
    MAIN_CODE,
  );
  factory(
    doc, win, requireStub, timers.setTimeout, timers.clearTimeout, timers.setInterval, timers.clearInterval,
    raf, performance, URLStub, Blob, console, '/mock/renderer',
  );
  return { doc, window: win, ipc, timers, raf };
}

// ==================== 观测辅助 ====================

const sent = (h, ch) => h.ipc.sent.filter((s) => s.channel === ch).map((s) => s.args);

/** 在 ctxMenu 上直接派发 click（桩无事件冒泡，直接调用委托监听器） */
function clickLeaf(h, leaf) {
  const menu = h.doc.getElementById('ctxMenu');
  const fns = menu.listeners['click'] || [];
  const evt = {
    target: leaf,
    stopPropagation() {},
    preventDefault() {},
  };
  for (const fn of fns) fn(evt);
}

/** 按叶子 key 找当前 DOM 叶 */
function leafByKey(h, key) {
  const menu = h.doc.getElementById('ctxMenu');
  return (menu.querySelectorAll('.leaf') || []).find((l) => l.dataset.leaf === key || l.dataset.opt === key) || null;
}

function leafRect(l) {
  // 叶位置由 applyLayout 写入 style.left/top/width（px 整数）
  const x = parseInt(l.style.left, 10);
  const y = parseInt(l.style.top, 10);
  const s = parseInt(l.style.width, 10);
  return { x, y, w: s, h: s };
}

function rectIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 三缩放档：主进程 _petStageSize = round(220*scale)（src/main/index.ts:844） */
const SCALE_CASES = [
  { name: '0.7×', scale: 0.7, win: 154 },
  { name: '1.3×', scale: 1.3, win: 286 },
  { name: '2.2×', scale: 2.2, win: 484 },
];

/** boot 到 live2d ok（from resolve）——A3 react 链路前置 */
async function bootLive2dOk(opts = {}) {
  // winHolder 惰性接线：assemble 创建 window 后回填——getBounds 在 ctx-show 时
  // 才被 catAnchor 求值，届时 innerWidth 已设为目标档位（还原真实几何时序）
  const winHolder = { win: null };
  const model = makeModel(() => winHolder.win);
  const pixi = makePIXI(() => Promise.resolve(model));
  const h = assemble(Object.assign({ pixi }, opts));
  winHolder.win = h.window;
  await settle();
  return { h, model };
}

// ==================== A1 主扇 3 叶 DOM 完整性 ====================

describe('A1 主扇 3 叶 DOM 完整性（R5/R2 二次修正后契约）', () => {
  for (const c of SCALE_CASES) {
    test(`${c.name}（窗口 ${c.win}px）：3 叶 mode/react/quit、无 summon 叶、icon 正确`, async () => {
      const { h } = await bootLive2dOk();
      h.window.innerWidth = c.win;
      h.window.innerHeight = c.win;
      h.ipc.emit('pet:ctx-show', {}, { mode: 'pet', scale: c.scale, winW: c.win, winH: c.win });
      const menu = h.doc.getElementById('ctxMenu');
      const leaves = menu.querySelectorAll('.leaf') || [];
      assert.strictEqual(leaves.length, 3, `实际叶: ${leaves.map((l) => l.dataset.leaf).join(',')}`);
      const keys = leaves.map((l) => l.dataset.leaf).sort();
      assert.deepStrictEqual(keys, ['mode', 'quit', 'react']);
      assert.ok(!keys.includes('summon'), 'summon 叶必须不存在（R5 已删）');
      const byKey = Object.fromEntries(leaves.map((l) => [l.dataset.leaf, l]));
      assert.strictEqual(byKey.mode.textContent, '🐱');
      assert.strictEqual(byKey.react.textContent, '❤️');
      assert.strictEqual(byKey.quit.textContent, '⏻');
      // 叶全部在窗内（DOM 层复核纯函数契约）
      for (const l of leaves) {
        const r = leafRect(l);
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= c.win && r.y + r.h <= c.win,
          `${l.dataset.leaf} 出窗: ${JSON.stringify(r)} win=${c.win}`);
      }
    });
  }
});

// ==================== A2 quit 确认气泡三档几何（重点审计：小M 报告问题2 修复） ====================

describe('A2 quit 确认气泡：顶部居中公式三档推演（遮挡修复验证）', () => {
  // 气泡宽：桩 offsetWidth=0 → 代码回退 || 180；实机 nowrap 实际可能 ~190（报告中标注待实机量测）
  const BUBBLE_W = 180;
  const BUBBLE_H = 52; // 两行文案+按钮保守估值

  for (const c of SCALE_CASES) {
    test(`${c.name}：点击 quit 叶 → 气泡显示、顶部居中、与 3 叶均不相交、不出窗`, async () => {
      const { h } = await bootLive2dOk();
      h.window.innerWidth = c.win;
      h.window.innerHeight = c.win;
      h.ipc.emit('pet:ctx-show', {}, { mode: 'pet', scale: c.scale, winW: c.win, winH: c.win });
      const quit = leafByKey(h, 'quit');
      assert.ok(quit, 'quit 叶存在');
      clickLeaf(h, quit);

      const confirm = h.doc.getElementById('cmConfirm');
      assert.strictEqual(confirm.style.display, 'block', '确认气泡应显示');
      const bx = parseInt(confirm.style.left, 10);
      const by = parseInt(confirm.style.top, 10);
      assert.strictEqual(by, 10, '气泡 top 恒 10px（窗口顶部）');
      // 2026-11-04 修复后分档口径（与 A6 同构）：
      // 0.7× 档窗口 154 < 回退宽 180 → 出窗/盖叶数学不可兼得，钳左 6（F1 挂账）——
      // 气泡 z-index 200 在叶之上，可读可点非功能性遮挡；
      // 1.3×/2.2× 档 → 严格居中、不出窗、不遮叶。
      const menu = h.doc.getElementById('ctxMenu');
      const bubble = { x: bx, y: by, w: BUBBLE_W, h: BUBBLE_H };
      if (c.win < BUBBLE_W) {
        assert.strictEqual(bx, 6, '0.7× 档：右缘钳左 left=6（F1 挂账口径）');
      } else {
        const expectLeft = Math.max(6, Math.round((c.win - BUBBLE_W) / 2));
        assert.strictEqual(bx, expectLeft, `居中公式 left=${expectLeft}`);
        const outRight = bx + BUBBLE_W > c.win;
        const outBottom = by + BUBBLE_H > c.win;
        assert.ok(!outRight && !outBottom,
          `气泡出窗: right=${bx + BUBBLE_W} bottom=${by + BUBBLE_H} win=${c.win}x${c.win}`);
        const hits = (menu.querySelectorAll('.leaf') || [])
          .map((l) => ({ key: l.dataset.leaf, ...leafRect(l) }))
          .filter((r) => rectIntersect(bubble, r));
        assert.deepStrictEqual(hits, [], `气泡遮挡叶: ${JSON.stringify(hits)}`);
      }
    });
  }

  test('0.7× 档气泡宽超过窗口时公式钳到 left=6（右缘溢出须如实报告，不静默通过）', async () => {
    // 独立数值断言：154px 窗 - 180px 气泡 = 负余量 → left=6 仍溢出 32px。
    // 本用例固化当前行为为「已知发现」：公式只钳左缘不钳右缘。
    const winW = 154;
    const left = Math.max(6, Math.round((winW - 180) / 2));
    assert.strictEqual(left, 6);
    assert.ok(left + 180 > winW, '0.7× 档 180px 宽气泡确实溢出右缘（审计发现，非回归噪声）');
  });
});

// ==================== A3 react 叶点击链路完整性（重点审计：互动叶误删修复） ====================

describe('A3 react 叶链路（2026-11-05 Bug3 新契约：二级动作点播扇）', () => {
  test('点击 react 叶 → 打开 interact 二级扇（back + 动作叶）；点动作叶 → model.motion 实调', async () => {
    const { h, model } = await bootLive2dOk();
    h.ipc.emit('pet:ctx-show', {}, { mode: 'pet', scale: 1, winW: 220, winH: 220 });
    const react = leafByKey(h, 'react');
    assert.ok(react, 'react 叶存在');
    clickLeaf(h, react); // 第一跳：开二级扇
    const m0 = leafByKey(h, 'm0');
    assert.ok(m0, 'interact 二级扇应有动作叶 m0（uniform 采样）');
    const before = model.__motions.length;
    clickLeaf(h, m0); // 第二跳：点动作叶 → motion 实调
    assert.ok(model.__motions.length > before,
      `动作叶点选应触发 motion（前 ${before} 后 ${model.__motions.length}）`);
    const last = model.__motions[model.__motions.length - 1];
    assert.strictEqual(last[0], 'Idle');
    assert.strictEqual(h.window.__petMode, 'live2d', '点选后回到 live2d 模式');
  });

  test('IPC pet:react 通道 → triggerReact 同链路可用（自动反应回归锁）', async () => {
    const { h, model } = await bootLive2dOk();
    const before = model.__motions.length;
    h.ipc.emit('pet:react', {});
    assert.ok(model.__motions.length > before, 'pet:react → motion 实调');
  });

  test('mode 二级 3 叶 icon 语义重选（R6）：🐾/📐/💤', async () => {
    const { h } = await bootLive2dOk();
    h.ipc.emit('pet:ctx-show', {}, { mode: 'pet', scale: 1, winW: 220, winH: 220 });
    clickLeaf(h, leafByKey(h, 'mode'));
    const menu = h.doc.getElementById('ctxMenu');
    const leaves = menu.querySelectorAll('.leaf') || [];
    const byKey = Object.fromEntries(leaves.map((l) => [l.dataset.opt || l.dataset.leaf, l]));
    assert.strictEqual(byKey.pet.textContent, '🐾');
    assert.strictEqual(byKey.edge.textContent, '📐');
    assert.strictEqual(byKey.hidden.textContent, '💤');
    assert.strictEqual(byKey.pet.textContent !== '🐱', true, 'pet 叶不得再用 🐱（与主扇 mode 混淆）');
  });
});

// ==================== A4 live2d pending 期右键兜底（Bug-B2 修复） ====================

describe('A4 live2d pending 期右键兜底', () => {
  test('__l2d 未就绪 + 模型区内右键 → 仍发 pet:open-ctx（不 return）', async () => {
    // from 永不 resolve → pending 态持续（不 advance 6s 兜底计时）
    const pixi = makePIXI(() => new Promise(() => {}));
    const h = assemble({ pixi });
    await settle();
    assert.strictEqual(h.window.__petMode, 'live2d');
    assert.strictEqual(h.window.__petBooted, undefined, '尚未 booted（pending）');
    const openBefore = sent(h, 'pet:open-ctx').length;
    h.window.dispatch('contextmenu', { button: 2, clientX: 110, clientY: 130 });
    const opens = sent(h, 'pet:open-ctx');
    assert.ok(opens.length > openBefore, `pending 期右键须发 pet:open-ctx（${opens.length}/${openBefore}）`);
    // ctx-show 也应到达（主进程回包在真机链路；渲染层已请求即兜底生效）
  });

  test('live2d 就绪后：包围盒内右键 → pet:open-ctx；包围盒外右键 → 不弹（命中区收缩仍生效）', async () => {
    const { h } = await bootLive2dOk();
    const inBefore = sent(h, 'pet:open-ctx').length;
    h.window.dispatch('contextmenu', { button: 2, clientX: 100, clientY: 120 }); // bounds {60,40,100,180} 内
    assert.ok(sent(h, 'pet:open-ctx').length > inBefore, '包围盒内右键弹菜单');
    const outBefore = sent(h, 'pet:open-ctx').length;
    h.window.dispatch('contextmenu', { button: 2, clientX: 5, clientY: 5 }); // 包围盒外
    assert.strictEqual(sent(h, 'pet:open-ctx').length, outBefore, '包围盒外右键不弹菜单');
  });
});

// ==================== A5 z-index 静态契约（遮挡修复的层结构） ====================

describe('A5 z-index / 层结构静态契约', () => {
  test('cm-confirm z-index 200 高于叶 120（遮挡修复：不再依赖 DOM 顺序）', () => {
    assert.match(STAGE_HTML, /#ctxMenu \.cm-confirm\s*\{[\s\S]*?z-index:\s*200/, 'cm-confirm 须显式 z-index 200');
    const leafBlock = STAGE_HTML.match(/#ctxMenu \.leaf,\s*#ctxMenu \.cm-confirm\s*\{[\s\S]*?\}/);
    assert.ok(leafBlock && /z-index:\s*120/.test(leafBlock[0]), '叶层 z-index 120');
  });

  test('PIXI canvas zIndex=1 钉底（live2d 挂载层不遮挡菜单）', async () => {
    const { h } = await bootLive2dOk();
    const canvas = h.window.PIXI && null; // view 由装配内部创建；从 body children 找
    const body = h.doc.body;
    const cv = (body.children || []).find((c) => c.tagName === 'CANVAS');
    assert.ok(cv, 'live2d canvas 已挂载 body');
    assert.strictEqual(cv.style.zIndex, '1', 'canvas z-index 钉底');
    assert.strictEqual(cv.style.pointerEvents, 'none', 'canvas 不拦截鼠标');
  });

  test('气泡重排兜底仍在：openCtx 末尾 appendChild(cmHint/cmConfirm)（z-index 双保险）', () => {
    assert.match(STAGE_HTML, /appendChild\(cmHint\)/);
    assert.match(STAGE_HTML, /appendChild\(cmConfirm\)/);
  });
});

// ==================== A6 hidden 确认气泡（旧锚定公式）三档推演 ====================

describe('A6 hidden 确认气泡（2026-11-04 修复后：统一顶部居中+双缘钳制）三档几何', () => {
  // 修复后语义：hidden 气泡与 quit 同用 bubbleTopCenterX（代码回退宽 180）；
  // 0.7× 档窗口 154 < 180 → 钳左 6 + 右缘溢出挂账（F1 同口径例外）；
  // 1.3×/2.2× 档 → 居中且不出窗（原发现固化断言已因修复过期，取反）。
  const CODE_FALLBACK_W = 180; // bubbleTopCenterX 的回退宽度
  const HIDDEN_BUBBLE_H = 52;

  for (const c of SCALE_CASES) {
    test(`${c.name}：hidden 叶点击 → 气泡显示、顶部定位、按档位出窗/遮挡判定`, async () => {
      const { h } = await bootLive2dOk();
      h.window.innerWidth = c.win;
      h.window.innerHeight = c.win;
      h.ipc.emit('pet:ctx-show', {}, { mode: 'pet', scale: c.scale, winW: c.win, winH: c.win });
      clickLeaf(h, leafByKey(h, 'mode')); // 进二级
      const hidden = leafByKey(h, 'hidden');
      assert.ok(hidden, 'hidden 叶存在');
      const r = leafRect(hidden);
      hidden._rect = { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y };
      clickLeaf(h, hidden);

      const confirm = h.doc.getElementById('cmConfirm');
      assert.strictEqual(confirm.style.display, 'block', 'hidden 确认气泡应显示');
      const bx = parseInt(confirm.style.left, 10);
      const by = parseInt(confirm.style.top, 10);
      assert.strictEqual(by, 10, '气泡 top 恒 10px');
      const bubble = { x: bx, y: by, w: CODE_FALLBACK_W, h: HIDDEN_BUBBLE_H };
      const out = bx + CODE_FALLBACK_W > c.win || by + HIDDEN_BUBBLE_H > c.win;
      const menu = h.doc.getElementById('ctxMenu');
      const hits = (menu.querySelectorAll('.leaf') || [])
        .map((l) => ({ key: l.dataset.opt || l.dataset.leaf, ...leafRect(l) }))
        .filter((lf) => rectIntersect(bubble, lf));
      const finding = { scale: c.name, win: c.win, bubble, outOfWindow: out, overlaps: hits.map((x) => x.key) };
      if (c.win < CODE_FALLBACK_W) {
        assert.strictEqual(bx, 6, '0.7× 档：右缘钳左 left=6（F1 挂账口径）');
      } else {
        const expectLeft = Math.max(6, Math.round((c.win - CODE_FALLBACK_W) / 2));
        assert.strictEqual(bx, expectLeft, `居中公式 left=${expectLeft}`);
        assert.ok(!out, `1.3×/2.2× 档修复后不应出窗: ${JSON.stringify(finding)}`);
        assert.deepStrictEqual(hits, [], `1.3×/2.2× 档修复后不应遮挡叶: ${JSON.stringify(finding)}`);
      }
    });
  }
});

// ==================== A7 死代码/残留静态审计 ====================

describe('A7 死代码与残留静态审计（声明核对佐证）', () => {
  test('size 死代码：渲染分支与点击分支均无 pet:set-scale / minus/plus', () => {
    assert.ok(!STAGE_HTML.includes('pet:set-scale'), 'pet:set-scale 渲染层链应删净');
    assert.ok(!/dataset\.leaf === 'minus'/.test(STAGE_HTML) && !/'plus'/.test(STAGE_HTML), 'minus/plus 叶分支应删净');
  });

  test('menuWindowSize() 恒 198 但主进程窗口已改 220×scale（导出失去消费方，记录为发现）', () => {
    const sz = MENU_LAYOUT.menuWindowSize();
    assert.strictEqual(sz.W, 198);
    assert.strictEqual(sz.H, 198);
    // 主进程实际用 _petStageSize()（220×scale）；本导出仅测试消费 = 死导出（报告记录）
  });

  test('quit 点击分支仍含 summon 死分支（不可达代码，报告记录）', () => {
    assert.match(STAGE_HTML, /k === 'summon'/, 'summon 点击分支残留（不可达，叶已删）——审计发现固化');
  });

  test('pet:scale 监听器内 applyScale 双重调用（残留重复行，报告记录）', () => {
    const block = STAGE_HTML.match(/ipcRenderer\.on\('pet:scale'[\s\S]*?\}\);/);
    assert.ok(block, 'pet:scale 监听器存在');
    const calls = (block[0].match(/applyScale\(/g) || []).length;
    assert.strictEqual(calls, 2, 'applyScale 在单监听器内被调用 2 次（冗余，不可达注释残留）');
  });
});

// ==================== A8 hint 区弹出互斥（2026-11-09 位置错乱修复验证） ====================
// 修复语义：stats-pop 弹出时 hintText 隐藏（CSS .stats-pop-active），淡出后恢复——双向互斥
describe('A8 footer 常驻徽章 + hint 区（2026-11-09 footer 方案终版契约）', () => {
  test('DOM：footer 常驻徽章（footer-stats/statsBadge）与 hintText span 共存于 index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    assert.ok(html.includes('id="statsFooter"'), 'footer 底栏存在');
    assert.ok(html.includes('class="footer-stats stats-show" id="statsBadge"'), 'footer 徽章存在');
    assert.ok(html.includes('id="hintText"'), 'hintText 文字 span 存在（hint 区纯文案还原）');
    assert.ok(!html.includes('stats-pop '), 'hint 区弹出方案已废弃（stats-pop CSS 类零残留；stats-popover 为新类名不误匹配）');
  });

  test('CSS：footer-stats 常驻显示链 + hover 展开卡（footer 内向上弹出）', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main.css'), 'utf8');
    assert.ok(/\.footer-stats\{/.test(css) || css.includes('.footer-stats {'), '.footer-stats 基态存在');
    assert.ok(css.includes('.footer-stats.stats-show'), 'stats-show 切换规则存在');
    assert.ok(css.includes('.footer-stats:hover .stats-popover'), 'hover 展开卡规则存在（stats-popover 容器）');
    assert.ok(css.includes('.scs-progress-fill'), '进度条填充规则存在（HUD 重设计 scs-progress-fill）');
  });

  test('弹出语义退役：main.ts 无 stats-pop-show 切换残留（废弃语义零残留）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main.ts'), 'utf8');
    assert.ok(!js.includes('stats-pop-show') && !js.includes('_statsPopTimer'),
      '废弃弹出语义零残留（stats-pop-show/_statsPopTimer 均已清除）');
  });
});

