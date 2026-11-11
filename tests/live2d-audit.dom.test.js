'use strict';

/**
 * live2d-audit.dom.test.js - 桌宠 Live2D 验证轮·补充审计用例（2026-11-03 L3 第四角色轮）
 *
 * 性质：特征钉死（characterization）——用运行证据固化验证轮静态复核发现的两个疑点，
 * 供测试报告引用。断言描述的是**当前实现行为**（含已知偏差），非验收期望。
 * 修复后如行为改变，须同步修订本文件并在报告登记。
 *
 * 审计点：
 *   AUD-1（GAP-1 钉死）：live2d 异步加载失败（from reject → 6s 超时兜底）后，webm 回退
 *          仅 setMode，未走 preloadBlobs/playIdle 启动链 —— BLOBS 空、video 无 src，
 *          webm 实际不可播（静态结论 pet-stage.html:897 enterWebmMode 缺启动链）。
 *   AUD-2（GAP-2 钉死）：petLive2dEnabled=false 总开关只检查 window.__petTestConfig
 *          （测试桩直驱），真实环境唯一路径 ipcRenderer.invoke('pet:get-config')
 *          返回的 petLive2dEnabled 不被消费 —— from 仍被调用（pet-stage.html:847-849）。
 *
 * harness 与 live2d-backend.dom.test.js 同构（最小 DOM 桩 + new Function 装配 dist 产物）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIST_STAGE = path.join(__dirname, '..', 'dist', 'renderer', 'pet-stage.html');

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
  if (!main) throw new Error('dist/renderer/pet-stage.html 主逻辑段提取失败');
  return main.code;
}

const MAIN_CODE = loadMainScript();
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

// ==================== 最小 DOM 桩（与 live2d-backend.dom.test.js 同构） ====================

function makeClassList(el) {
  const read = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(' '); };
  return {
    add(...cs) { const s = read(); cs.forEach((c) => s.add(c)); write(s); },
    remove(...cs) { const s = read(); cs.forEach((c) => s.delete(c)); write(s); },
    toggle(c, force) { const s = read(); const has = s.has(c); const t2 = force === undefined ? !has : !!force; if (t2) s.add(c); else s.delete(c); write(s); return t2; },
    contains(c) { return read().has(c); },
  };
}

function makeElement(tagName) {
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [], parentNode: null, className: '', id: '', textContent: '',
    hidden: false, style: {}, dataset: {}, isConnected: true, listeners: {},
    _innerHTML: '', offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0,
    _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 },
  };
  el.classList = makeClassList(el);
  el.getBoundingClientRect = () => el._rect;
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.contains = (node) => { let n = node; while (n) { if (n === el) return true; n = n.parentNode; } return false; };
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
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

function makeVideoStub(id) {
  const el = makeElement('video');
  el.id = id;
  el.videoWidth = 0; el.videoHeight = 0; el.readyState = 0; el.paused = true;
  el.loop = false; el.muted = true; el.src = undefined;
  el._srcSetLog = [];
  el.play = () => { el.paused = false; return { then(f) { if (typeof f === 'function') f(); return { catch() {} }; }, catch() {} }; };
  el.pause = () => { el.paused = true; };
  el.load = () => {};
  // 钉死 src 赋值（play() 内 incoming.src = BLOBS[name]）
  Object.defineProperty(el, 'src', {
    configurable: true,
    get() { return el._srcVal; },
    set(v) { el._srcVal = v; if (v !== undefined) el._srcSetLog.push(String(v)); },
  });
  return el;
}

function makeDocument() {
  const registry = new Map();
  const doc = {
    visibilityState: 'visible', activeElement: null, listeners: {}, body: null,
    createElement: (tag) => makeElement(tag),
    getElementById(id) {
      if (!registry.has(id)) {
        const el = (id === 'petVideo' || id === 'petVideo2') ? makeVideoStub(id) : makeElement('div');
        el.id = id; registry.set(id, el);
      }
      return registry.get(id);
    },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  doc.body = makeElement('body');
  return doc;
}

function makeIpc(invokeImpl, winRef) {
  const sent = [];
  const ipc = {
    sent,
    send(channel, ...args) { sent.push({ channel, args }); },
    on(channel, fn) { (ipc._subs[channel] = ipc._subs[channel] || []).push(fn); return ipc; },
    _subs: {},
    emit(channel, ...args) { for (const fn of (ipc._subs[channel] || []).slice()) fn({ sender: null }, ...args); },
  };
  ipc.invoke = (ch) => invokeImpl(ch, winRef);
  return ipc;
}

function makeWindow(doc, opts, ipc) {
  const listeners = {};
  const win = {
    innerWidth: 220, innerHeight: 220, screenX: 100, screenY: 200,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, evt) {
      const e = Object.assign({ target: win, stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {} }, evt || {});
      for (const fn of (listeners[type] || []).slice()) fn(e);
    },
  };
  win.__petIpc = ipc;
  win.__petMovesDir = '/mock/pet-moves';
  win.__petReadMove = opts.readMoveThrows
    ? () => { throw new Error('mock: pet-moves 资产读取失败'); }
    : (name) => new Blob([name]);
  if (opts.pixi) win.PIXI = opts.pixi;
  if (opts.testConfig !== undefined) win.__petTestConfig = opts.testConfig;
  return win;
}

function makeTimers() {
  const timers = new Map();
  let now = 0; let seq = 1;
  const setTimeout = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + (ms || 0) }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const setInterval = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + (ms || 0), interval: ms || 1 }); return id; };
  const clearInterval = (id) => { timers.delete(id); };
  const advance = (ms) => {
    now += ms;
    for (const [id, t2] of [...timers]) {
      if (t2.at <= now) {
        timers.delete(id);
        if (t2.interval) timers.set(id, { fn: t2.fn, at: now + t2.interval, interval: t2.interval });
        t2.fn();
      }
    }
  };
  return { setTimeout, clearTimeout, setInterval, clearInterval, advance };
}

function makeModel() {
  const model = {
    internalModel: { focusController: { focus() {} } },
    motion() {}, on() { return model; },
    getBounds() { return { x: 60, y: 40, width: 100, height: 180 }; },
    scale: { set() {} }, position: { set() {} }, anchor: { set() {} },
    destroyed: false, destroy() { model.destroyed = true; },
  };
  return model;
}

function makePIXI(from) {
  const fromCalls = [];
  const wrappedFrom = (url) => { fromCalls.push(url); return from(url); };
  class MockApplication {
    constructor(opts) { this.stage = { addChild() {} }; this.view = makeElement('canvas'); this.ticker = { add() {}, start() {}, stop() {} }; this.renderer = { resize() {}, destroy() {} }; }
    destroy() {}
  }
  return { Application: MockApplication, live2d: { Live2DModel: { from: wrappedFrom } }, __fromCalls: fromCalls };
}

// ==================== 装配 ====================

const flushAsync = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await flushAsync(); }

function assemble(opts = {}) {
  const timers = makeTimers();
  // rAF 队列桩（与 live2d-backend.dom.test.js makeRAF 同构；同步递归桩会让
  // tick 的 requestAnimationFrame(tick) 立即自调，栈溢出）
  const rafQueue = [];
  const raf = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  const doc = makeDocument();
  let winRef = null;
  const ipc = makeIpc(opts.invoke || (() => Promise.resolve(null)), () => winRef);
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
  return { doc, window: win, ipc, timers, pixi: opts.pixi, flushRaf: () => { const cur = rafQueue.splice(0); for (const fn of cur) fn(performance.now()); } };
}

const diagTexts = (h) => h.ipc.sent.filter((s) => s.channel === 'pet:diag').map((s) => String(s.args[0]));
const videoOf = (h, id) => h.doc.getElementById(id);

// ==================== 审计用例（特征钉死，非验收期望） ====================

describe('Live2D 验证轮补充审计（特征钉死：AUD-1 异步回退 webm 启动链 / AUD-2 总开关真实通道）', () => {

  test('AUD-1：from reject → 6s 超时回退 webm 后，blob 未预载、video 无 src（GAP-1 行为钉死）', async () => {
    const pixi = makePIXI(() => Promise.reject(new Error('mock: from reject')));
    const h = assemble({ pixi });
    await settle();
    h.flushRaf();
    h.timers.advance(6000);

    assert.strictEqual(h.window.__petMode, 'webm', '当前行为：终态 webm（与专项 TC-102 一致）');
    assert.strictEqual(h.window.__petLive2dAttempted, true, '当前行为：尝试标记已置位');
    assert.strictEqual(h.pixi.__fromCalls.length, 1, '当前行为：from 恰被调用一次');

    // GAP-1 修复验证（断言取反，2026-11-03 开发侧整改）：异步回退后 webm 必须
    // 走完整启动链（startWebmRuntime）——预载 + 首播，spec L5「回退后全部现役行为可用」
    const preloadDiag = diagTexts(h).find((t2) => t2.includes('动作库预载'));
    assert.ok(preloadDiag,
      'GAP-1 修复后：异步回退路径必须走 preloadBlobs（有「动作库预载」diag）');
    assert.ok(videoOf(h, 'petVideo')._srcSetLog.length >= 1 || videoOf(h, 'petVideo2')._srcSetLog.length >= 1,
      'GAP-1 修复后：video 至少一路被赋 src（playIdle 首播）');
  });

  test('AUD-1b：对照——同步回退路径（PIXI.live2d 缺失）有预载有首播（证明 GAP-1 为异步路径特有）', async () => {
    const h = assemble({}); // 无 PIXI = 库缺失 → enterLive2dMode 同步 fail → enterWebmMode
    await settle();
    h.flushRaf();
    h.timers.advance(6000);

    assert.strictEqual(h.window.__petMode, 'webm', '终态 webm');
    // 同步路径：enterLive2dMode 内 enterWebmMode 后 return 'fail' → start() 继续落回
    // 既有 webm 启动链（preloadBlobs + playIdle）
    const preloadDiag = diagTexts(h).find((t2) => t2.includes('动作库预载'));
    assert.ok(preloadDiag, '同步路径应走 preloadBlobs（对照证据）');
    assert.strictEqual(videoOf(h, 'petVideo')._srcSetLog.length >= 1
      || videoOf(h, 'petVideo2')._srcSetLog.length >= 1, true, '同步路径 video 应已赋 src（对照证据）');
  });

  test('AUD-2：真实通道 invoke(pet:get-config) 返回 petLive2dEnabled=false —— from 仍被调（GAP-2 行为钉死）', async () => {
    const pixi = makePIXI(() => Promise.resolve(makeModel()));
    const h = assemble({
      pixi,
      // 不注入 __petTestConfig（模拟真实环境），invoke 走真实通道返回总开关=false
      invoke: (ch) => (ch === 'pet:get-config')
        ? Promise.resolve({ petLive2dModel: null, petLive2dEnabled: false })
        : Promise.resolve(null),
    });
    await settle();
    h.flushRaf();
    h.timers.advance(6000);

    // GAP-2 修复验证（断言取反，2026-11-03 开发侧整改）：真实通道 petLive2dEnabled=false
    // 必须被消费——from 不被调、6s 超时后终态 webm（AUD-2 回归锁生效）
    assert.strictEqual(h.pixi.__fromCalls.length, 0,
      'GAP-2 修复后：总开关 false 经真实通道被消费 —— Live2DModel.from 不得被调用');
    assert.strictEqual(h.window.__petMode, 'webm',
      'GAP-2 修复后：总开关 false → 终态 webm（走回退链）');
  });
});
