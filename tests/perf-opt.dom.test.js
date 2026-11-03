'use strict';

/**
 * perf-opt.dom.test.js - 性能与体验优化（2026-11-02）红灯测试（TDD 先行）
 *
 * Spec: Docs/spec-性能与体验优化-2026-11-02.md（验收 S1/S2/S6）
 * Plan: Docs/plan-性能与体验优化-2026-11-02.md（T1 搜索防抖 / T4 空状态区分）
 *
 * 【红灯性质】本文件在实现（架构师+开发）开始前编写，按当前代码（HEAD 34b9fe4，
 * 输入处理器无防抖、空态文案固定复用 t('empty')）应当失败——失败输出即红灯证据，
 * 留档于 Docs/测试用例-性能与体验优化-2026-11-02.md 附录。
 *
 * 覆盖点：
 *   - S1（T1，红灯）：连续输入 10 字符（每键间隔 <50ms，假计时器模拟：键间不推进
 *     时间轴），停顿 200ms 后 renderHistory 调用次数 ≤3。当前实现每键同步直调
 *     renderHistory（dist/renderer/main.js:629 input 处理器），10 键 = 10 次 → 红灯。
 *   - S2（T1，守卫）：停顿 200ms 后列表内容 = 按最终关键词过滤的结果。当前同步
 *     过滤已满足（绿灯），作为防抖改造的回归守卫——改造后防抖不得破坏最终态。
 *     另含「输入回显同步」守卫：searchQuery 赋值必须保留在防抖之外（plan T1 方案）。
 *   - S6（T4，红灯）：搜索无结果时空态文案含「未找到匹配」与关键词回显，且不含
 *     「暂无剪贴板历史」。当前实现 renderHistory 空态分支固定渲染 t('empty')
 *     （renderer.ts:517，i18n.ts:27 =「暂无剪贴板历史」）→ 三条断言全红。
 *   - 空态基线守卫（T4）：真空历史（无搜索词）仍显示「暂无剪贴板历史」——当前
 *     绿灯，T4 区分两种空态后不得回归。
 *
 * harness：与权威样板 tests/search-ux.dom.test.js 同构（最小 document/window 桩 +
 * new Function 装配 dist/renderer 编译产物 i18n.js → renderer.js → … → main.js），
 * 两处必要扩展：
 *   1. innerHTML setter 增加 _innerHTMLSets 计数（renderHistory 对容器的每次调用
 *      恰好一次 innerHTML 赋值：空态分支 1 次、非空分支 innerHTML='' 1 次，其余
 *      渲染均走 appendChild/子元素，不污染 #list 计数），以此作为 renderHistory
 *      调用数的观测通道（mock 计数，spec S1 要求的验证方式）；
 *   2. loadHarness 支持注入假计时器（setTimeout/clearTimeout 由工厂参数注入，
 *      main.js 闭包内调用走注入实现），提供 advance/clearAll 控制时间轴——
 *      防抖（plan T1：debounce(fn, 150)，setTimeout 系）在测试内可控触发。
 *      注意：防抖若改用 requestAnimationFrame 等非 setTimeout 调度，本 harness
 *      需同步扩展（当前按 plan 设计的 setTimeout 系断言）。
 *
 * 已知近似（同样板）：stub 元素互不连树；getElementsByTagName/解析 innerHTML
 * 不支持——故 S6 断言走 innerHTML 字符串包含性（stub 未解析 HTML，字符串即真实
 * 产物），「清空搜索快捷操作」按钮的点击行为留手动用例（见测试用例文档 M-S6-01）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'dist', 'renderer');
// 与 search-ux.dom.test.js 同源装配顺序：spring-anim.js / entry-anim.js 必须先于
// main.js（main 顶层 createEntryAnim + 播放链路引用）
const SOURCES = ['i18n.js', 'renderer.js', 'spring-anim.js', 'header-hover-ui.js', 'entry-anim.js', 'dock-anim.js', 'main.js']
  .map(f => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
  .join('\n;\n');

// ==================== 最小 DOM 桩（含焦点语义 + innerHTML 计数） ====================

function makeClassList(el) {
  const read = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(' '); };
  return {
    add(...cs) { const s = read(); cs.forEach(c => s.add(c)); write(s); },
    remove(...cs) { const s = read(); cs.forEach(c => s.delete(c)); write(s); },
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
    title: '',
    type: '',
    value: '',
    placeholder: '',
    hidden: false,
    scrollTop: 0,
    style: {},
    dataset: {},
    isConnected: true,
    listeners: {},
    _innerHTML: '',
    _innerHTMLSets: 0, // renderHistory 调用数观测通道（见文件头注释 1）
    _selection: null,
  };
  el.classList = makeClassList(el);

  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = () => {};
  el.dispatch = (type, evt) => {
    const base = { target: el, currentTarget: el, stopPropagation() {}, preventDefault() {} };
    for (const fn of (el.listeners[type] || [])) fn(Object.assign(base, evt || {}));
  };
  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.closest = (sel) => {
    if (typeof sel !== 'string') return null;
    const match = (n) => {
      if (!n) return false;
      if (sel.startsWith('.')) return String(n.className || '').split(/\s+/).includes(sel.slice(1));
      if (sel.startsWith('#')) return n.id === sel.slice(1);
      return n.tagName === sel.toUpperCase();
    };
    let node = el;
    while (node) {
      if (match(node)) return node;
      node = node.parentNode;
    }
    return null;
  };
  el.contains = (node) => { let n = node; while (n) { if (n === el) return true; n = n.parentNode; } return false; };
  el.querySelector = (sel) => {
    if (typeof sel !== 'string' || !sel.startsWith('.')) return null;
    const cls = sel.slice(1);
    const walk = (node) => {
      for (const c of node.children) {
        if (String(c.className || '').split(/\s+/).includes(cls)) return c;
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    const found = walk(el);
    // innerHTML 桩不解析 HTML：已有 innerHTML 的元素按需生成占位子元素
    if (!found && el._innerHTML) {
      const auto = makeElement('span', docRef);
      auto.className = cls;
      el.appendChild(auto);
      return auto;
    }
    return found;
  };
  el.querySelectorAll = () => [];
  el.setAttribute = (k, v) => { if (k === 'title') el.title = v; };
  el.getAttribute = (k) => (k === 'title' ? el.title : null);
  el.focus = () => {
    if (docRef && docRef.activeElement === el) return;
    if (docRef) docRef.activeElement = el;
    el.dispatch('focus');
  };
  el.blur = () => {
    const was = !!(docRef && docRef.activeElement === el);
    if (was) docRef.activeElement = null;
    if (was) el.dispatch('blur');
  };
  el.setSelectionRange = (start, end) => { el._selection = [start, end]; };
  el.scrollTo = () => {};
  el.remove = () => {};
  Object.defineProperty(el, 'innerHTML', {
    configurable: true, // 允许个别用例按需包计数探针
    get() { return el._innerHTML; },
    set(v) {
      el._innerHTML = String(v);
      el._innerHTMLSets += 1;
      if (!el._innerHTML) el.children.length = 0;
    },
  });
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
        const el = makeElement('div', doc);
        el.id = id;
        registry.set(id, el);
      }
      return registry.get(id);
    },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelectorAll: () => [],
    dispatch(type, evt) {
      const base = { target: doc.body, stopPropagation() {}, preventDefault() {} };
      for (const fn of (doc.listeners[type] || [])) fn(Object.assign(base, evt || {}));
    },
  };
  doc.body = makeElement('body', doc);
  return doc;
}

function makeWindow() {
  const handlers = {};
  const win = {
    _handlers: handlers,
    _history: [],
    clipboardAPI: {
      getHistory: async () => win._history,
      copyItem: async () => ({ ok: true }),
      simulateInput: async () => ({ ok: true }),
      removeItem: async () => ({}),
      clearHistory: async () => ({}),
      openExternal: async () => ({ ok: true }),
      openFileLocation: async () => ({ ok: true }),
      getFileIcon: async () => null,
      focusSearch: async () => { win._calls.focusSearch += 1; return true; },
      blurSearch: async () => { win._calls.blurSearch += 1; return true; },
      setSearchActive: (active) => { win._calls.setSearchActive.push(active); },
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
      onHistoryUpdated: (cb) => { handlers.historyUpdated = cb; },
      onCountdownUpdate: (cb) => { handlers.countdownUpdated = cb; },
      getTagSettings: async () => (win._tagSettings === undefined ? null : win._tagSettings),
      onTagSettingsUpdated: (cb) => { handlers.tagSettingsUpdated = cb; },
      onLangChanged: (cb) => { handlers.langChanged = cb; },
      getLang: async () => 'zh-CN',
      setLang: async (lang) => ({ ok: true, lang }),
      // Welcome 引导模块容错依赖（缺省即「不阻塞主流程」降级；显式桩掉避免红灯输出噪音）
      getWelcomeState: async () => null,
    },
    _calls: null,
  };
  win._calls = { focusSearch: 0, blurSearch: 0, setSearchActive: [] };
  return win;
}

// ==================== 假计时器（防抖时间轴控制） ====================

/**
 * setTimeout/clearTimeout 假实现：注入工厂后 main.js 闭包内的定时器全部可控。
 * - 键间不 advance = 模拟「每键间隔 <50ms」且未超过防抖窗口；
 * - advance(ms) 触发所有到期定时器（按到期序，回调先摘除再执行，支持回调内重挂）；
 * - clearAll() 丢弃初始化期挂起的动画/UI 定时器，隔离打字窗口（见 S1 用例内注释）。
 */
function makeFakeTimers() {
  let seq = 0;
  let now = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pendingCount: () => pending.size,
    clearAll: () => pending.clear(),
    advance(ms) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        if (!pending.has(id)) continue; // 更早回调内已被 clearTimeout
        pending.delete(id);
        t.fn();
      }
      return due.length;
    },
  };
}

function loadHarness({ history = [], timers } = {}) {
  const document = makeDocument();
  const window = makeWindow();
  window._history = history;
  const navigator = { language: 'zh-CN' };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const timerArgs = timers || { setTimeout, clearTimeout };

  const factory = new Function(
    'document', 'window', 'navigator', 'localStorage', 'module',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    SOURCES + '\n;return { t, getLang, setLang, filterHistory, refresh, updateStats,'
    + ' getSearchOpen: () => searchOpen,'
    + ' getState: () => ({ searchQuery, activeTagFilter, fullHistory, tagSettings }) };',
  );
  const api = factory(
    document, window, navigator, localStorage, undefined,
    timerArgs.setTimeout, timerArgs.clearTimeout, setInterval, clearInterval,
  );
  return { api, document, window, handlers: window._handlers, timers };
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

// ==================== 查询/操作辅助 ====================

function findItems(listEl) {
  return listEl.children.filter(c => String(c.className).split(/\s+/).includes('item'));
}

/** renderHistory 调用数观测：容器每次调用恰一次 innerHTML 赋值（见文件头注释 1） */
function renderCallCount(listEl) {
  return listEl._innerHTMLSets;
}

/** 模拟输入搜索词（走真实 input 事件链） */
function typeWord(doc, word) {
  const input = doc.getElementById('searchInput');
  input.value = word;
  input.dispatch('input');
  return input;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TWO_ITEMS = [
  { id: 'a', type: 'text', timestamp: NOW, text: 'alpha deploy', length: 5, tags: ['link'] },
  { id: 'b', type: 'text', timestamp: NOW - DAY, text: 'beta world', length: 5, tags: null },
];

// ==================== T1 搜索防抖（S1 红灯 / S2 守卫） ====================

describe('T1/S1 搜索防抖（spec S1；红灯：当前每键直调 filterHistory+renderHistory）', () => {
  test('连续输入 10 字符（键间隔<50ms）→ 停顿 200ms 后 renderHistory ≤3 次', async () => {
    const timers = makeFakeTimers();
    const { api, document } = loadHarness({ history: TWO_ITEMS, timers });
    await flushAsync(); // 初始 getHistory 装载 + 首次渲染完成

    const list = document.getElementById('list');
    const baseline = renderCallCount(list);
    // 隔离打字窗口：丢弃初始化期挂起的动画/UI 定时器（entry-anim 等），使其不计入
    // 防抖时间轴。打字链路自身的定时器只可能在此之后创建。
    timers.clearAll();

    // 模拟连续打字：每键「间隔<50ms」= 键间不推进假时间轴（间隔 0 < 50），
    // 任何防抖实现（窗口 ≥50ms）都不应在键间触发渲染。
    const input = document.getElementById('searchInput');
    const word = 'abcdefghij';
    for (let i = 1; i <= word.length; i++) {
      input.value = word.slice(0, i);
      input.dispatch('input');
    }
    // 回显同步守卫（plan T1 方案：searchQuery 赋值保留同步，仅过滤+渲染走防抖）：
    // 打字停止时（防抖未触发）搜索词已可见，Esc/blur 等路径读到的不得是旧值。
    assert.equal(api.getState().searchQuery, word, '输入回显必须同步（防抖不得吞掉 searchQuery 赋值）');

    timers.advance(200); // spec S1/S2：停顿 200ms 后防抖已触发
    const calls = renderCallCount(list) - baseline;
    assert.ok(
      calls <= 3,
      `renderHistory 调用 ${calls} 次 > 3 —— 防抖未生效（当前实现每键同步渲染，10 键 = 10 次）`,
    );
  });
});

describe('T1/S2 防抖最终态（守卫：当前绿灯，防抖改造不得破坏最终态）', () => {
  test('输入 alpha 停顿 200ms → 列表 = 按最终关键词过滤的结果', async () => {
    const timers = makeFakeTimers();
    const { api, document } = loadHarness({ history: TWO_ITEMS, timers });
    await flushAsync();
    timers.clearAll();

    const input = typeWord(document, 'alpha');
    assert.equal(api.getState().searchQuery, 'alpha', '回显同步');
    timers.advance(200);

    const list = document.getElementById('list');
    assert.deepEqual(
      findItems(list).length,
      1,
      '停顿后列表应只剩匹配「alpha」的条目（当前同步过滤已满足；防抖化后由 150ms 定时器触发，同样必须满足）',
    );
    // 与 filterHistory 权威口径交叉验证
    assert.deepEqual(
      api.filterHistory(api.getState().fullHistory).map(i => i.id),
      ['a'],
    );
    assert.ok(input, 'input 引用存活（无过早 GC 语义问题）');
  });
});

// ==================== T4 空状态区分（S6 红灯 / 基线守卫） ====================

describe('T4/S6 空态文案区分（spec S6；红灯：无匹配复用「暂无剪贴板历史」）', () => {
  test('搜索 xyzxyz（无匹配）→ 文案含「未找到匹配」+ 关键词回显，不含「暂无剪贴板历史」', async () => {
    const timers = makeFakeTimers();
    const { document } = loadHarness({ history: TWO_ITEMS, timers });
    await flushAsync();
    timers.clearAll();

    typeWord(document, 'xyzxyz');
    timers.advance(200); // T1 防抖落地后仍需推进时间轴；当前同步渲染不受影响

    const html = document.getElementById('list').innerHTML;
    assert.ok(html.includes('未找到匹配'),
      '空态文案应含「未找到匹配」（当前错误显示「' + html.slice(0, 60) + '」）');
    assert.ok(html.includes('xyzxyz'),
      '空态文案应回显关键词（spec S6：「未找到匹配 “xyzxyz” 的条目」）');
    assert.ok(!html.includes('暂无剪贴板历史'),
      '无匹配结果不得复用「暂无剪贴板历史」（历史为空才有此语义）');
  });
});

describe('T4 空态基线守卫（当前绿灯；T4 区分两种空态后不得回归）', () => {
  test('真空历史（无搜索词）→ 仍显示「暂无剪贴板历史」', async () => {
    const { document } = loadHarness({ history: [] });
    await flushAsync();

    const list = document.getElementById('list');
    assert.equal(findItems(list).length, 0);
    assert.ok(list.innerHTML.includes('暂无剪贴板历史'),
      '无历史 + 无搜索词 = 「暂无剪贴板历史」语义，T4 改造后必须保留');
    assert.ok(!list.innerHTML.includes('未找到匹配'),
      '非搜索场景不得出现「未找到匹配」文案');
  });

  test('清词后（Esc/清词路径）恢复「暂无剪贴板历史」语义', async () => {
    const timers = makeFakeTimers();
    const { api, document } = loadHarness({ history: [] });
    await flushAsync();
    timers.clearAll();

    typeWord(document, 'xyzxyz');
    timers.advance(200);
    const input = document.getElementById('searchInput');
    input.dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
    timers.advance(200); // 清词若走防抖链同样需推进；同步实现不受影响

    assert.equal(api.getState().searchQuery, '', 'Esc 已清词');
    const html = document.getElementById('list').innerHTML;
    assert.ok(html.includes('暂无剪贴板历史'), '清词后回到「无历史」空态');
    assert.ok(!html.includes('未找到匹配'), '清词后不得残留「未找到匹配」');
  });
});
