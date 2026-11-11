'use strict';

/**
 * live2d-backend.dom.test.js - 桌宠 Live2D 后端接入·红灯用例（2026-11-03 L3 第三角色轮）
 *
 * Spec : Docs/spec-桌宠Live2D后端-2026-11-03.md（L5 自动化部分 + 红线 3 命中/上报链）
 * Plan  : Docs/plan-桌宠Live2D后端-2026-11-03.md（T1/T2/T3 红灯用例要点）
 * 用例总表：Docs/测试用例-桌宠Live2D-2026-11-03.md
 *
 * harness：权威样板 tests/search-ux.dom.test.js / tests/perf-opt-rerun.dom.test.js
 * 同款模式（最小 document/window 桩 + new Function 装配 dist 编译产物）。被测对象是
 * dist/renderer/pet-stage.html 的内联经典脚本——pet-stage 无独立 .js 编译产物
 * （copy-assets 原样拷贝 src→dist，2026-11-03 md5 比对一致），故从 dist 提取
 * <script> 块装配。vrm module 段（three importmap）不装配：node 无 DOM/WebGL，
 * 且 plan 已定 live2d 走经典 script 路线，与被测面无交集。
 *
 * ============================ 红灯契约（C1-C4，测试先行定义） ============================
 * 红灯阶段 live2d 功能未实现，以下为实现轮须满足的最小可观测契约（改动须同步本文件并说明）：
 *   C1  window.__petLive2dAttempted（boolean）：live2d 尝试发生即置 true（含 PIXI.live2d
 *       缺失的同步判定失败），且不得被 webm 资产检查短路（对齐点 A1）。
 *   C2  window.__petMode（既有）：终态 'live2d' | 'webm' | 'sprite'。
 *   C3  window.__petBackendChain（string[]）：按尝试顺序 push 的后端启动链
 *       （live2d 尝试必在链上；sprite 兜底也记录）。
 *   C4  失败留痕：失败路径必有 pet:diag 消息，内容同时含 'live2d' 与失败语义
 *       （fail/缺失/回退/fallback/不可用/error/超时 任一）。
 *
 * ============================ 对齐点（红灯评审需实现轮拍板） ============================
 *   A1  spec 启动链图（live2d 是第一环）vs plan「enterLive2dMode 插在 :766 之前」：
 *       现状 start() 里 blob 预载失败会早退进 sprite（:760-765），若早退先于 live2d
 *       尝试，TC-103 无法满足。本套用例按 spec 语义编码（live2d 首环不受 webm 资产
 *       检查短路）；实现轮若维持 plan 插入点语义，须在红灯评审提出并修订用例。
 *   A2  config 通道：约定 ipcRenderer.invoke('pet:get-config') → { petLive2dModel?: string }，
 *       缺省/null → 'hiyori'。实现轮可换通道名，改则同步本文件。
 *   A3  focusController 归一化口径：focus((x/W)-0.5, (y/H)-0.5) ∈ [-0.5, 0.5]（plan T2①）。
 *
 * ============================ 覆盖点（8 条红灯用例） ============================
 *   TC-L2D-101 T1-a：PIXI.live2d 缺失 → 6s 内回退 webm + 尝试可观测（C1/C3/C4）
 *   TC-L2D-102 T1-b：Live2DModel.from reject → 回退 webm，且回退后 [input]/
 *              pet:body-rect 链路仍通（红线 3）
 *   TC-L2D-103 T1-c：webm 资产也失败（blob 预载抛错）→ 落 sprite 兜底，live2d 首环不丢
 *   TC-L2D-201 T2-a：mode==='live2d' 下 mousemove → focusController.focus 被调且参数
 *              归一化（A3）
 *   TC-L2D-202 T2-b：live2d 模式 cursorHit 走模型包围盒分支——video 矩形置哨兵值
 *              （900,900）且 videoWidth=0，包围盒内命中/包围盒外不命中（vrm 教训
 *              video-rect-0 回归锁，pet-stage.html:322 教训沉淀）
 *   TC-L2D-203 T2-c：pet:body-rect 上报值来自模型包围盒而非 video 矩形（红线 3）
 *   TC-L2D-301 T3-a：config 缺省 → 加载 hiyori（from 收到 hiyori model3.json 路径）
 *   TC-L2D-302 T3-b：config 指向不存在模型 → from 收到该模型名 → 加载失败 → 回退 webm
 *
 * ============================ 门禁口径 ============================
 * 红灯阶段：本文件单独跑（node --test tests/live2d-backend.dom.test.js），预期 8 fail
 * ——这是红灯证据，不是回归事故；不计入全量回归门禁（排除命令见用例文档 §5）。
 * 全量回归基线 698/698 绿（2026-11-03 已核实）在红灯期须保持。
 * 绿灯后本文件并入全量 glob（node --test tests/*.test.js）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIST_STAGE = path.join(__dirname, '..', 'dist', 'renderer', 'pet-stage.html');

// ==================== pet-stage 内联脚本提取（dist 编译产物，纪律口径） ====================

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
  // 主逻辑段以 function start( 为指纹（bridge 段只有 __petIpc 桥）
  const main = blocks.find((b) => !b.module && b.code.includes('function start('));
  if (!main) throw new Error('dist/renderer/pet-stage.html 主逻辑段提取失败（先 npm run build:ts）');
  return main.code;
}

const MAIN_CODE = loadMainScript();
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

// ==================== 最小 DOM 桩（样板同构 + video/媒体语义扩展） ====================

function makeClassList(el) {
  const read = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(' '); };
  return {
    add(...cs) { const s = read(); cs.forEach((c) => s.add(c)); write(s); },
    remove(...cs) { const s = read(); cs.forEach((c) => s.delete(c)); write(s); },
    toggle(c, force) {
      const s = read();
      const has = s.has(c);
      const target = force === undefined ? !has : !!force;
      if (target) s.add(c); else s.delete(c);
      write(s);
      return target;
    },
    contains(c) { return read().has(c); },
  };
}

function makeElement(tagName, docRef) {
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    textContent: '',
    hidden: false,
    style: {},
    dataset: {},
    isConnected: true,
    listeners: {},
    _innerHTML: '',
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
  el.dispatch = (type, evt) => {
    const base = { target: el, currentTarget: el, stopPropagation() {}, preventDefault() {} };
    for (const fn of (el.listeners[type] || []).slice()) fn(Object.assign(base, evt || {}));
  };
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
  el.setAttribute = () => {};
  el.getAttribute = () => null;
  el.remove = () => { el.isConnected = false; };
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); if (!el._innerHTML) el.children.length = 0; },
  });
  return el;
}

/** video 桩：媒体属性 + 哨兵矩形（900,900 ≠ live2d 包围盒 60,40）——误读 video 矩形即红 */
function makeVideoStub(doc, id) {
  const el = makeElement('video', doc);
  el.id = id;
  el.videoWidth = 0; el.videoHeight = 0;   // 无解码帧（vrm 教训语义：video 隐藏/未就绪）
  el.readyState = 0; el.paused = true; el.loop = false; el.muted = true;
  el._rect = { left: 900, top: 900, right: 1120, bottom: 1120, width: 220, height: 220, x: 900, y: 900 };
  el.play = () => {
    el.paused = false;
    return { then(f) { if (typeof f === 'function') f(); return { catch() {} }; }, catch() {} };
  };
  el.pause = () => { el.paused = true; };
  el.load = () => {};
  return el;
}

function makeDocument() {
  const registry = new Map();
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    listeners: {},
    body: null,
    createElement: (tag) => makeElement(tag, doc),
    getElementById(id) {
      if (!registry.has(id)) {
        const el = (id === 'petVideo' || id === 'petVideo2')
          ? makeVideoStub(doc, id)
          : makeElement('div', doc);
        el.id = id;
        registry.set(id, el);
      }
      return registry.get(id);
    },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch() {},
  };
  doc.body = makeElement('body', doc);
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
  };
  // 对齐点 A2：config 通道约定（实现轮可改，改则同步本文件）
  ipc.invoke = async (ch) => (ch === 'pet:get-config') ? (winRef().__petTestConfig || {}) : null;
  return ipc;
}

function makeWindow(doc, opts, ipc) {
  const listeners = {};
  const win = {
    innerWidth: 220, innerHeight: 220, screenX: 100, screenY: 200,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    dispatch(type, evt) {
      const e = Object.assign({
        target: win, stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {},
      }, evt || {});
      for (const fn of (listeners[type] || []).slice()) fn(e);
    },
  };
  win.__petIpc = ipc;
  win.__petMovesDir = '/mock/pet-moves';
  win.__petReadMove = opts.readMoveThrows
    ? () => { throw new Error('mock: pet-moves 资产读取失败'); }
    : (name) => new Blob([name]);
  if (opts.pixi) win.PIXI = opts.pixi;
  win.__petTestConfig = opts.config || null;
  return win;
}

// ==================== 假计时器 / rAF 队列（确定性驱动 6s 回退时序） ====================

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

// ==================== PIXI.live2d / Live2DModel mock ====================

function makeModel() {
  const focusCalls = [];
  const motions = [];
  const events = {};
  const model = {
    internalModel: { focusController: { focus(x, y) { focusCalls.push([x, y]); } } },
    motion(group, index) { motions.push([group, index]); },
    on(type, fn) { (events[type] = events[type] || []).push(fn); return model; },
    getBounds() { return { x: 60, y: 40, width: 100, height: 180 }; },
    scale: { set() {} },
    position: { set() {} },
    anchor: { set() {} },
    destroyed: false,
    destroy() { model.destroyed = true; },
    __focusCalls: focusCalls,
    __motions: motions,
    __events: events,
  };
  return model;
}

function makePIXI(from) {
  class MockApplication {
    constructor(opts) {
      MockApplication.lastOpts = opts;
      this.stage = { addChild() {} };
      this.view = makeElement('canvas', null);
      this.ticker = { add() {}, start() {}, stop() {} };
      this.renderer = { resize() {}, destroy() {} };
    }
    destroy() { MockApplication.destroyCalls += 1; }
  }
  MockApplication.lastOpts = null;
  MockApplication.destroyCalls = 0;
  return { Application: MockApplication, live2d: { Live2DModel: { from } }, __mockApp: MockApplication };
}

// ==================== 装配（样板 loadHarness 同构） ====================

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
  let blobSeq = 0;
  const URLStub = { createObjectURL: () => 'blob:mock-' + (++blobSeq), revokeObjectURL() {} };
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

const diagTexts = (h) => h.ipc.sent.filter((s) => s.channel === 'pet:diag').map((s) => String(s.args[0]));
const bodyRects = (h) => h.ipc.sent.filter((s) => s.channel === 'pet:body-rect').map((s) => s.args[0]);
const cursorHits = (h) => h.ipc.sent.filter((s) => s.channel === 'pet:cursor-hit').map((s) => s.args[0]);

// ==================== T1 渲染接入 + 三级回退链（L5，红灯契约 C1-C4） ====================

describe('T1 渲染接入 + 三级回退链（spec L5，红灯阶段预期全 fail）', () => {
  test('TC-L2D-101 T1-a：PIXI.live2d 缺失 → 6s 内回退 webm，live2d 尝试可观测（C1/C3/C4）', async () => {
    const h = assemble({}); // window.PIXI 不注入 = 库缺失
    await settle();
    h.timers.advance(6000); // 6s 回退超时窗

    assert.strictEqual(h.window.__petMode, 'webm', '终态须为 webm（C2）');
    assert.strictEqual(h.window.__petLive2dAttempted, true, 'C1：live2d 尝试标记缺失（功能未实现）');
    const chain = h.window.__petBackendChain || [];
    assert.ok(chain.includes('live2d'), 'C3：启动链首环 live2d 缺失（功能未实现）');
    const diags = diagTexts(h);
    assert.ok(
      diags.some((t) => /live2d/i.test(t) && /fail|缺失|回退|fallback|不可用|error|超时/i.test(t)),
      'C4：失败路径 pet:diag 未留痕（功能未实现），实际 diag：' + JSON.stringify(diags),
    );
  });

  test('TC-L2D-102 T1-b：Live2DModel.from reject → 回退 webm，回退后 [input]/pet:body-rect 链路仍通', async () => {
    const fromCalls = [];
    const pixi = makePIXI((url) => {
      fromCalls.push(url);
      return Promise.reject(new Error('mock: Live2DModel.from reject'));
    });
    const h = assemble({ pixi });
    await settle();
    h.timers.advance(6000);

    assert.ok(fromCalls.length >= 1, '红灯：Live2DModel.from 未被尝试调用（功能未实现）');
    assert.strictEqual(h.window.__petMode, 'webm', 'from reject 后终态须为 webm（C2）');
    assert.strictEqual(h.window.__petLive2dAttempted, true, 'C1：live2d 尝试标记缺失（功能未实现）');

    // 红线 3：回退后现役交互链路必须完整可用
    h.window.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100, screenX: 100, screenY: 100 });
    assert.ok(
      diagTexts(h).some((t) => t.includes('[input] mousedown')),
      '红线 3：回退后 [input] 诊断链路必须仍通',
    );
    h.ipc.emit('pet:scale', {}, 1);
    assert.ok(bodyRects(h).length >= 1, '红线 3：回退后 pet:body-rect 上报链路必须仍通');
  });

  test('TC-L2D-103 T1-c：webm 资产也失败 → 落 sprite 兜底，live2d 首环不被资产检查短路（对齐点 A1）', async () => {
    const h = assemble({ readMoveThrows: true }); // blob 预载全失败（无 PIXI）
    await settle();
    h.timers.advance(6000);

    assert.strictEqual(h.window.__petMode, 'sprite', 'webm 资产失败 → sprite 兜底（既有行为）');
    assert.strictEqual(h.window.__petLive2dAttempted, true,
      'C1（对齐点 A1）：live2d 首环尝试不得被 webm 资产检查短路（功能未实现）');
    const chain = h.window.__petBackendChain || [];
    assert.ok(chain.includes('live2d') && chain.includes('sprite'),
      'C3：启动链须同时含 live2d 尝试与 sprite 兜底（功能未实现），实际 ' + JSON.stringify(chain));
  });
});

// ==================== T2 交互映射（L2/L3/L4 自动化面，vrm 教训回归锁） ====================

describe('T2 交互映射（spec L2/L4 + 红线 3，红灯阶段预期全 fail）', () => {
  /** 前置：mock PIXI.live2d 全成功装配；红灯期 mode 恒为 webm → 前置断言即红灯 */
  async function bootLive2d() {
    const fromCalls = [];
    const pixi = makePIXI((url) => {
      fromCalls.push(url);
      return Promise.resolve(makeModel());
    });
    const h = assemble({ pixi });
    await settle();
    return { h, fromCalls };
  }

  test('TC-L2D-201 T2-a：mousemove → focusController.focus 被调且参数归一化（[-0.5,0.5]，A3）', async () => {
    const { h } = await bootLive2d();
    assert.strictEqual(h.window.__petMode, 'live2d', '红灯：mock 全成功应进入 live2d 模式（功能未实现）');

    h.window.dispatch('mousemove', { clientX: 165, clientY: 110, screenX: 265, screenY: 310 });
    h.raf.flush(); // 合帧节流可能经 rAF（plan T2①）

    const model = h.window.PIXI.__lastModel;
    assert.ok(model, '红灯：mock 模型未注册（实现须在 from 成功后记录 __lastModel，或经 PIXI.live2d 提供）');
    const calls = model.__focusCalls;
    assert.ok(calls.length >= 1, '红灯：mousemove 未触发 focusController.focus（功能未实现）');
    const [nx, ny] = calls[calls.length - 1];
    // (165/220 - 0.5, 110/220 - 0.5) = (0.25, 0)
    assert.ok(Math.abs(nx - 0.25) < 1e-6, `归一化 x 须为 0.25，实际 ${nx}（A3）`);
    assert.ok(Math.abs(ny - 0) < 1e-6, `归一化 y 须为 0，实际 ${ny}（A3）`);
    assert.ok(Math.abs(nx) <= 0.5 && Math.abs(ny) <= 0.5, '参数须落在 [-0.5, 0.5]（A3）');
  });

  test('TC-L2D-202 T2-b：live2d 模式 cursorHit 走包围盒分支（video 哨兵矩形/videoWidth=0 不得误判）', async () => {
    const { h } = await bootLive2d();
    assert.strictEqual(h.window.__petMode, 'live2d', '红灯：mock 全成功应进入 live2d 模式（功能未实现）');
    // video 桩矩形为哨兵 (900,900) 且 videoWidth=0；模型包围盒 (60,40,100,180)——
    // 若实现误读 video 矩形（vrm 教训 :322 video-rect-0），下列断言必失败
    h.window.dispatch('mousemove', { clientX: 100, clientY: 100 }); // 包围盒内
    h.raf.flush();
    let hits = cursorHits(h);
    assert.ok(hits.length >= 1, 'live2d 模式 mousemove 须上报 pet:cursor-hit');
    assert.strictEqual(hits[hits.length - 1], true, '包围盒内 (100,100) 须命中——video 哨兵矩形误判即红');

    h.window.dispatch('mousemove', { clientX: 200, clientY: 200 }); // 包围盒外（窗内）
    h.raf.flush();
    hits = cursorHits(h);
    assert.strictEqual(hits[hits.length - 1], false, '包围盒外 (200,200) 不得命中');
  });

  test('TC-L2D-203 T2-c：pet:body-rect 上报值来自模型包围盒而非 video（红线 3）', async () => {
    const { h } = await bootLive2d();
    assert.strictEqual(h.window.__petMode, 'live2d', '红灯：mock 全成功应进入 live2d 模式（功能未实现）');

    h.ipc.emit('pet:scale', {}, 1); // 既有 body-rect 触发通道（applyScale → reportBodyRect）
    const rects = bodyRects(h);
    assert.ok(rects.length >= 1, 'pet:scale 触发后须有 pet:body-rect 上报');
    // 模型包围盒 getBounds()={x:60,y:40,width:100,height:180}；video 哨兵矩形 (900,900)——
    // deepStrictEqual 双向鉴别：误读 video 矩形/沿用 webm 分支均即红
    assert.deepStrictEqual(rects[rects.length - 1], { x: 60, y: 40, w: 100, h: 180 },
      'body-rect 须等于模型包围盒 {x:60,y:40,w:100,h:180}（Math.round），不得来自 video 哨兵矩形');
  });
});

// ==================== T3 模型热插拔（L6，config 约定） ====================

describe('T3 模型热插拔（spec L6，config.petLive2dModel，红灯阶段预期全 fail）', () => {
  test('TC-L2D-301 T3-a：config 缺省 → 加载 hiyori（from 收到 hiyori model3.json）', async () => {
    const fromCalls = [];
    const pixi = makePIXI((url) => {
      fromCalls.push(url);
      return Promise.resolve(makeModel());
    });
    const h = assemble({ pixi }); // 不注入 config = 缺省
    await settle();

    assert.ok(fromCalls.length >= 1, '红灯：Live2DModel.from 未被调用（功能未实现）');
    assert.ok(
      fromCalls.some((u) => /hiyori[^\\/]*\.model3\.json/.test(String(u))),
      '缺省模型须为 hiyori（config 缺省 → hiyori.model3.json），实际 from 入参：'
        + JSON.stringify(fromCalls),
    );
    assert.strictEqual(h.window.__petMode, 'live2d', '红灯：hiyori 加载成功应进入 live2d 模式（功能未实现）');
  });

  test('TC-L2D-302 T3-b：config 指向不存在模型 → from 收到该模型名 → 加载失败 → 回退 webm（A2）', async () => {
    const fromCalls = [];
    const pixi = makePIXI((url) => {
      fromCalls.push(url);
      return /ghost-model/.test(String(url))
        ? Promise.reject(new Error('mock: model not found'))
        : Promise.resolve(makeModel());
    });
    const h = assemble({ pixi, config: { petLive2dModel: 'ghost-model' } });
    await settle();
    h.timers.advance(6000);

    assert.ok(
      fromCalls.some((u) => String(u).includes('ghost-model')),
      '红灯：config.petLive2dModel 未透传至 from 入参（A2 通道未实现），实际：'
        + JSON.stringify(fromCalls),
    );
    assert.strictEqual(h.window.__petMode, 'webm', '不存在模型 → 6s 内回退 webm（C2）');
  });
});
