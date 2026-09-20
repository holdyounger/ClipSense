'use strict';

/**
 * search-ux.dom.test.js - 搜索体验优化（2026-09-10）DOM 桩 harness
 *
 * 依据 .ctx-lockstep/PROJECT.md 硬性结论：渲染层 UI 改动交付前必须过 DOM 桩 harness。
 * 做法：与 renderer-tags.dom.test.js 同源的最小 document/window 桩 + new Function
 * 依次加载 i18n.js → renderer.js → main.js（直接驱动真实渲染代码，不改写源码），
 * 覆盖 PRD《搜索体验优化-2026-09-10》验收点：
 *   - 点击图标展开 + focusSearch IPC + 输入框聚焦（验收 1）
 *   - 收起即清词四路径：blur / 点击 header 外 / Esc / 再点图标 toggle（验收 2，拍板 #2）
 *   - Esc 三态 + IME（isComposing）忽略；不隐藏窗口（无隐藏 IPC 可调，验收 3）
 *   - Ctrl+F 展开聚焦 / 已有词仅聚焦（光标末尾）/ 修饰键不符无动作（验收 4）
 *   - 重显自洽：词非空重显 → 视觉展开不抢焦点（验收 5）
 *   - 搜索态挂起/恢复联动：setSearchActive 序列断言（验收 6）
 *   - Esc 不清标签筛选态（拍板 #1）
 *   - i18n 中英 key 完整（验收 9）
 *
 * 桩对真实 DOM 的关键语义保真：
 *   - focus()/blur() 维护 document.activeElement，且仅在实际发生焦点转移时
 *     同步派发 focus/blur 事件（真实 DOM：已持焦 focus() / 已失焦 blur() 不再派发）；
 *   - dispatch 允许 evt 覆盖 preventDefault/stopPropagation（断言拦截行为）；
 *   - setSelectionRange 记录 _selection（光标末尾断言）；
 *   - clipboardAPI.focusSearch/blurSearch/setSearchActive 录制调用序列。
 *
 * 已知近似（不影响被测行为）：stub 中 getElementById 创建的元素互相独立（未连树），
 * 「header 内点击」用例以 header 元素自身为 target（真实 DOM 中 contains 语义一致）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
// spring-anim.js / entry-anim.js 必须先于 main.js（main 顶层 createEntryAnim + 播放链路引用）
const SOURCES = ['i18n.js', 'renderer.js', 'spring-anim.js', 'entry-anim.js', 'dock-anim.js', 'main.js']
  .map(f => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
  .join('\n;\n');

// ==================== 最小 DOM 桩（含焦点语义） ====================

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
    // （renderer.js buildDateDivider 先写 innerHTML 再 querySelector 取子节点，非空安全）
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
  // 焦点语义：维护 doc.activeElement；仅在实际转移时派发事件（真实 DOM 行为）
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
    get() { return el._innerHTML; },
    set(v) {
      el._innerHTML = String(v);
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
    _tagSettings: undefined,
    clipboardAPI: {
      getHistory: async () => win._history,
      copyItem: async () => ({ ok: true }),
      simulateInput: async () => ({ ok: true }),
      removeItem: async () => ({}),
      clearHistory: async () => ({}),
      openExternal: async () => ({ ok: true }),
      openFileLocation: async () => ({ ok: true }),
      getFileIcon: async () => null,
      // 录制型桩：focusSearch/blurSearch/setSearchActive 调用序列断言（验收 6）
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
    },
    _calls: null,
  };
  win._calls = { focusSearch: 0, blurSearch: 0, setSearchActive: [] };
  return win;
}

function loadHarness({ history = [] } = {}) {
  const document = makeDocument();
  const window = makeWindow();
  window._history = history;
  const navigator = { language: 'zh-CN' };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const factory = new Function(
    'document', 'window', 'navigator', 'localStorage', 'module',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    SOURCES + '\n;return { t, getLang, setLang, filterHistory, refresh, updateStats,'
    + ' getSearchOpen: () => searchOpen,'
    + ' getState: () => ({ searchQuery, activeTagFilter, fullHistory, tagSettings }) };',
  );
  const api = factory(
    document, window, navigator, localStorage, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
  );
  return { api, document, window };
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

// ==================== 查询/操作辅助 ====================

function findItems(listEl) {
  return listEl.children.filter(c => String(c.className).split(/\s+/).includes('item'));
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TWO_ITEMS = [
  { id: 'a', type: 'text', timestamp: NOW, text: 'alpha deploy', length: 5, tags: ['link'] },
  { id: 'b', type: 'text', timestamp: NOW - DAY, text: 'beta world', length: 5, tags: null },
];

/** 点击图标展开并等待异步链（focusSearch IPC → DOM 聚焦）完成 */
async function openViaIcon({ document: doc, window: win }) {
  const btn = doc.getElementById('searchBtn');
  btn.dispatch('click', { target: btn });
  await flushAsync();
  return btn;
}

/** 模拟输入搜索词（走真实 input 事件链） */
function typeWord(doc, word) {
  const input = doc.getElementById('searchInput');
  input.value = word;
  input.dispatch('input');
  return input;
}

const preventSpy = () => {
  const spy = { called: false };
  return [spy, () => { spy.called = true; }];
};

// ==================== 用例 ====================

describe('搜索图标展开（验收 1；拍板 #3 header-actions 最左）', () => {
  test('点击图标 → 展开态 + focusSearch IPC + 输入框聚焦 + 挂起自动隐藏', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const header = document.getElementById('header');
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('searchBtn');
    const [spy, fn] = preventSpy();

    // pointerdown 阻止默认聚焦转移（避免 blur 先行收起的竞态）
    btn.dispatch('pointerdown', { target: btn, preventDefault: fn });
    assert.equal(spy.called, true, 'pointerdown preventDefault 已调用');

    btn.dispatch('click', { target: btn });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, '进入展开态');
    assert.ok(header.classList.contains('search-open'), 'header 挂 search-open class');
    assert.equal(document.activeElement, input, '输入框已聚焦');
    assert.ok(window._calls.focusSearch >= 1, 'focusSearch IPC 已调用');
    assert.deepEqual(window._calls.setSearchActive, [true], 'focus 事件 → setSearchActive(true) 挂起自动隐藏');
    assert.equal(findItems(document.getElementById('list')).length, 2, '展开本身不动列表');
  });

  test('点击输入框（重显态）→ focusSearch 链路保留', async () => {
    const { document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.dispatch('pointerdown', { target: input });
    await flushAsync();
    assert.equal(window._calls.focusSearch, 1, '原 pointerdown → focusSearch 链路不变');
  });
});

describe('收起即清词（验收 2；拍板 #2 统一规则）', () => {
  test('路径一：输入框 blur → 清词收起 + blurSearch + setSearchActive(false) + 列表复位', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    const input = typeWord(document, 'alpha');
    assert.equal(api.getState().searchQuery, 'alpha');
    assert.equal(findItems(document.getElementById('list')).length, 1, '过滤生效');

    input.blur(); // 真实 blur 事件 → 收起
    await flushAsync();

    assert.equal(api.getSearchOpen(), false, '已收起');
    assert.ok(!document.getElementById('header').classList.contains('search-open'));
    assert.equal(api.getState().searchQuery, '', 'searchQuery 已清');
    assert.equal(input.value, '', 'input.value 已清');
    assert.equal(findItems(document.getElementById('list')).length, 2, '列表回到未过滤态');
    assert.ok(window._calls.blurSearch >= 1, 'blurSearch IPC 已调用');
    assert.equal(window._calls.setSearchActive[window._calls.setSearchActive.length - 1], false, '恢复自动隐藏');
  });

  test('路径二：点击 header 外区域 → 清词收起', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    // 展开 + 持焦态：直接对 document 派发 header 外点击（真实链路由 blur 先行，此处幂等）
    document.dispatch('click', { target: document.getElementById('list') });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false);
    assert.equal(api.getState().searchQuery, '');
    assert.equal(findItems(document.getElementById('list')).length, 2);
  });

  test('路径二b：展开未持焦（重显态）点击 header 外 → 清词收起', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');
    document.activeElement = null; // 模拟焦点已不在输入框（无 blur 可走）

    document.dispatch('click', { target: document.getElementById('list') });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false);
    assert.equal(api.getState().searchQuery, '');
  });

  test('路径二c：点击 header 内（pinBtn 区域语义）不触发外点收起', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    document.dispatch('click', { target: document.getElementById('header') });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, 'header 内点击不收起');
    assert.equal(api.getState().searchQuery, 'alpha');
  });

  test('路径三：Esc（有词）→ 清词收起 + preventDefault（详见 Esc 组）', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    const input = typeWord(document, 'alpha');
    const [spy, fn] = preventSpy();

    input.dispatch('keydown', { key: 'Escape', preventDefault: fn });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false);
    assert.equal(api.getState().searchQuery, '');
    assert.equal(spy.called, true, 'preventDefault 已调用');
    assert.equal(findItems(document.getElementById('list')).length, 2);
  });

  test('路径四（toggle）：展开且持焦时再点图标 → 清词收起', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const btn = await openViaIcon({ document, window });
    typeWord(document, 'alpha');
    assert.equal(document.activeElement, document.getElementById('searchInput'));

    btn.dispatch('click', { target: btn });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false, 'toggle 收起');
    assert.equal(api.getState().searchQuery, '');
    assert.equal(findItems(document.getElementById('list')).length, 2);
  });
});

describe('Esc 三态 + IME（验收 3）', () => {
  test('展开态无词 → 仅收起（等效清词规则）+ preventDefault', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    const input = document.getElementById('searchInput');
    const [spy, fn] = preventSpy();

    input.dispatch('keydown', { key: 'Escape', preventDefault: fn });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false, '无词收起');
    assert.equal(api.getState().searchQuery, '');
    assert.equal(spy.called, true);
    assert.ok(window._calls.blurSearch >= 1, '恢复自动隐藏');
  });

  test('未展开 → 无动作（不 preventDefault、状态不变）', async () => {
    const { api, document } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const [spy, fn] = preventSpy();

    document.dispatch('keydown', { key: 'Escape', preventDefault: fn });

    assert.equal(api.getSearchOpen(), false, '保持收起');
    assert.equal(spy.called, false, '未展开不 preventDefault');
  });

  test('IME 组合中（isComposing）→ 忽略，展开态与词保持', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    const input = typeWord(document, 'alpha');
    const [spy, fn] = preventSpy();

    input.dispatch('keydown', { key: 'Escape', isComposing: true, preventDefault: fn });
    document.dispatch('keydown', { key: 'Escape', isComposing: true, preventDefault: fn });

    assert.equal(api.getSearchOpen(), true, '仍展开');
    assert.equal(api.getState().searchQuery, 'alpha', '词保留');
    assert.equal(spy.called, false, 'IME 组合中不触发');
  });

  test('展开但未持焦（重显态）Esc → 兜底收起（document 级）', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');
    document.activeElement = null;

    document.dispatch('keydown', { key: 'Escape' });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false);
    assert.equal(api.getState().searchQuery, '');
  });
});

describe('Ctrl+F 直达搜索（验收 4；不做 globalShortcut）', () => {
  test('收起态 Ctrl+F → 展开聚焦 + preventDefault', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const [spy, fn] = preventSpy();

    document.dispatch('keydown', { ctrlKey: true, code: 'KeyF', preventDefault: fn });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true);
    assert.equal(document.activeElement, document.getElementById('searchInput'));
    assert.equal(spy.called, true, 'preventDefault 已调用');
    assert.ok(window._calls.focusSearch >= 1);
  });

  test('已有词时 Ctrl+F → 仅重新聚焦（光标末尾），不清词', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    const input = typeWord(document, 'alpha');
    const focusCountBefore = window._calls.focusSearch;

    document.dispatch('keydown', { ctrlKey: true, code: 'KeyF' });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, '保持展开');
    assert.equal(api.getState().searchQuery, 'alpha', '词不清');
    assert.equal(input.value, 'alpha', 'input 值不变');
    assert.ok(window._calls.focusSearch > focusCountBefore, 'focusSearch 重新调用');
    assert.deepEqual(input._selection, [5, 5], '光标到末尾');
  });

  test('修饰键不符（Ctrl+Alt+F / Ctrl+Shift+F / 单独 F）→ 无动作不拦截', async () => {
    const { api, document } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const [spy, fn] = preventSpy();

    document.dispatch('keydown', { ctrlKey: true, altKey: true, code: 'KeyF', preventDefault: fn });
    document.dispatch('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyF', preventDefault: fn });
    document.dispatch('keydown', { code: 'KeyF', preventDefault: fn });

    assert.equal(api.getSearchOpen(), false, '未展开');
    assert.equal(spy.called, false, '未拦截');
  });

  test('IME 组合中 Ctrl+F → 忽略', async () => {
    const { api, document } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const [spy, fn] = preventSpy();

    document.dispatch('keydown', { ctrlKey: true, code: 'KeyF', isComposing: true, preventDefault: fn });

    assert.equal(api.getSearchOpen(), false);
    assert.equal(spy.called, false);
  });
});

describe('重显自洽（验收 5）', () => {
  test('词非空重新可见 → 视觉展开但不抢焦点（不调 focusSearch / setSearchActive）', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');
    const focusCountBefore = window._calls.focusSearch;
    const sasCountBefore = window._calls.setSearchActive.length;

    // 窗口隐藏 → 重新可见（隐藏侧无行为；可见侧触发重显自洽）
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    assert.equal(api.getSearchOpen(), true, '隐藏侧无行为');

    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    await flushAsync();

    assert.ok(document.getElementById('header').classList.contains('search-open'), '搜索框视觉展开');
    assert.equal(api.getState().searchQuery, 'alpha', '词保留（隐藏不是收起路径）');
    assert.equal(window._calls.focusSearch, focusCountBefore, '不调 focusSearch，不抢焦点');
    assert.equal(window._calls.setSearchActive.length, sasCountBefore, '不触发 setSearchActive');
    assert.equal(findItems(document.getElementById('list')).length, 1, '过滤态保持，与搜索框可见性强一致');
  });

  test('词非空但焦点已失（模拟隐藏期间失焦）→ 仍视觉展开不聚焦', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');
    document.activeElement = null;
    const focusCountBefore = window._calls.focusSearch;

    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    await flushAsync();

    assert.ok(document.getElementById('header').classList.contains('search-open'));
    assert.equal(api.getState().searchQuery, 'alpha');
    assert.equal(window._calls.focusSearch, focusCountBefore);
  });

  test('词为空重新可见 → 不展开（维持收起态），标签筛选照旧重置', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    // 不输入词直接隐藏/重显
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, '展开态本身保持（未收起过）');
    const { api: api2, document: doc2 } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    doc2.visibilityState = 'visible';
    doc2.dispatch('visibilitychange');
    assert.equal(api2.getSearchOpen(), false, '从未展开过则保持收起');
  });
});

describe('搜索态挂起/恢复联动（验收 6）', () => {
  test('setSearchActive 序列：开 true → 收 false → 再开 true → Esc false；blurSearch 配对', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const input = document.getElementById('searchInput');
    const btn = await openViaIcon({ document, window });
    assert.deepEqual(window._calls.setSearchActive, [true], '开：挂起');

    input.blur();
    await flushAsync();
    assert.deepEqual(window._calls.setSearchActive, [true, false], '收：恢复');

    btn.dispatch('click', { target: btn });
    await flushAsync();
    assert.deepEqual(window._calls.setSearchActive, [true, false, true], '再开：挂起');

    input.dispatch('keydown', { key: 'Escape' });
    await flushAsync();
    assert.deepEqual(window._calls.setSearchActive, [true, false, true, false], 'Esc：恢复');

    assert.equal(window._calls.focusSearch, 2, 'focusSearch 与两次展开配对');
    assert.equal(window._calls.blurSearch, 2, 'blurSearch 与两次收起配对（双保险链路）');
    assert.equal(api.getSearchOpen(), false);
  });
});

describe('Esc 与标签筛选独立（拍板 #1）', () => {
  test('Esc 清词收起后，标签筛选态保留', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const tagFilter = document.getElementById('tagFilter');
    assert.equal(tagFilter.hidden, false);
    tagFilter.dispatch('click', { target: tagFilter.children[1] }); // 选中「链接」
    assert.equal(api.getState().activeTagFilter, 'link');

    await openViaIcon({ document, window });
    const input = typeWord(document, 'alpha');
    input.dispatch('keydown', { key: 'Escape' });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false, '搜索已收起');
    assert.equal(api.getState().activeTagFilter, 'link', '标签筛选态不被 Esc 清除');
    assert.deepEqual(
      api.filterHistory(api.getState().fullHistory).map(i => i.id),
      ['a'],
      '列表 = 标签交集（词已清）',
    );
    assert.ok(tagFilter.children[1].className.includes('active'), 'chip 高亮保持');
  });
});

describe('i18n（验收 9）', () => {
  test('searchBtn / searchPlaceholder 中英齐全', async () => {
    const { api } = loadHarness();
    await flushAsync();
    assert.equal(api.t('searchBtn'), '搜索');
    assert.ok(api.t('searchPlaceholder'), 'zh placeholder 非空');
    api.setLang('en');
    assert.equal(api.t('searchBtn'), 'Search');
    assert.ok(api.t('searchPlaceholder'), 'en placeholder 非空');
    api.setLang('zh-CN');
  });

  test('applyStaticText 设置搜索按钮 tooltip（语言切换跟随）', async () => {
    const { api, document } = loadHarness();
    await flushAsync();
    const btn = document.getElementById('searchBtn');
    assert.equal(btn.title, '搜索', '初始 zh tooltip');
    const menuLangBtn = document.getElementById('menuLangBtn');
    menuLangBtn.dispatch('click'); // zh → en（菜单 handler 内部 setLang + applyStaticText）
    await flushAsync();
    assert.equal(api.getLang(), 'en');
    assert.equal(btn.title, 'Search', '切换 en 后 tooltip 跟随');
    menuLangBtn.dispatch('click'); // en → zh
    await flushAsync();
    assert.equal(btn.title, '搜索');
  });
});

// ==================== Header 改造（方案 B 环形入固定 + 公共修正基线，2026-09-10） ====================

describe('方案 B：pin 三态 + 环形进度（倒计时入固定按钮）', () => {
  test('倒计时运行 → .cd-running + 环心秒数 + dashoffset 同步（比例 = 剩余/总量）', () => {
    const { document, window } = loadHarness({ history: TWO_ITEMS });
    const pinBtn = document.getElementById('pinBtn');
    const num = document.getElementById('pinCdNum');
    const ring = document.getElementById('pinRingProgress');

    // 首拍即总量：5000ms → 满环（dashoffset 0）
    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 5000 });
    assert.ok(pinBtn.classList.contains('cd-running'), '进入 cd-running 态');
    assert.equal(num.textContent, '5', '环心秒数');
    assert.equal(ring.style.strokeDashoffset, '0.00', '满环 dashoffset = 0');

    // 中段：2500/5000 → dashoffset = 75.4 × (1 − 0.5) = 37.70
    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 2500 });
    assert.equal(ring.style.strokeDashoffset, '37.70');

    // 尾段：1250/5000 → dashoffset = 75.4 × 0.75 = 56.55
    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 1250 });
    assert.equal(ring.style.strokeDashoffset, '56.55');
  });

  test('紧迫感分级：≤10s .cd-warn、≤5s .cd-urgent（隐含 warn）、>10s 两者皆无', () => {
    const { document, window } = loadHarness({ history: TWO_ITEMS });
    const pinBtn = document.getElementById('pinBtn');

    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 12000 });
    assert.equal(pinBtn.classList.contains('cd-warn'), false, '>10s 无 warn');
    assert.equal(pinBtn.classList.contains('cd-urgent'), false, '>10s 无 urgent');

    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 9500 });
    assert.equal(pinBtn.classList.contains('cd-warn'), true, '≤10s warn');
    assert.equal(pinBtn.classList.contains('cd-urgent'), false, 'warn 态不含 urgent');

    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 4000 });
    assert.equal(pinBtn.classList.contains('cd-warn'), true, '≤5s 仍 warn');
    assert.equal(pinBtn.classList.contains('cd-urgent'), true, '≤5s urgent');
  });

  test('倒计时结束 → 三态类清理回图标态；已固定（pinned）同样清理', () => {
    const { document, window } = loadHarness({ history: TWO_ITEMS });
    const pinBtn = document.getElementById('pinBtn');
    const ring = document.getElementById('pinRingProgress');

    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 5000 });
    assert.ok(pinBtn.classList.contains('cd-running'));

    window._handlers.countdownUpdated({ isCountingDown: false, remainingMs: null });
    assert.equal(pinBtn.classList.contains('cd-running'), false, '静止态：cd-running 清理');
    assert.equal(pinBtn.classList.contains('cd-warn'), false);
    assert.equal(pinBtn.classList.contains('cd-urgent'), false);
    assert.equal(ring.style.strokeDashoffset, '0', '进度环复位');

    // 再运行后点击固定 → pinned 态 + 环形类清理（updatePinUI → hideCountdown）
    window._handlers.countdownUpdated({ isCountingDown: true, remainingMs: 5000 });
    pinBtn.dispatch('click', { target: pinBtn });
    assert.ok(pinBtn.classList.contains('pinned'), '已固定态');
    assert.equal(pinBtn.classList.contains('cd-running'), false, '固定后环形类清理');
  });
});

describe('Header 改造落盘断言（公共修正基线 + 方案 B 静态结构）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('index.html：pin-ring 双圆 dasharray 75.4 + rotate(-90) / menu 3 点 SVG / 徽标移除', () => {
    const html = readRoot('src/renderer/index.html');
    assert.ok(html.includes('class="pin-ring"'), 'pin-ring svg 存在');
    assert.ok(html.includes('stroke-dasharray="75.4"'), '进度圆 dasharray = 周长 75.4');
    assert.ok(html.includes('rotate(-90 14 14)'), '12 点起点顺时针消退');
    assert.ok(html.includes('id="pinCdNum"'), '环心秒数元素');
    assert.ok(!html.includes('countdownBadge'), '倒计时徽标已从 header-actions 移除');
    const menuBlock = html.slice(html.indexOf('id="menuBtn"'), html.indexOf('id="dropdownMenu"'));
    assert.equal((menuBlock.match(/<circle /g) || []).length, 3, 'menu 3 点 SVG');
  });

  test('main.css：28×28 / 圆角 7 / gap 8 / focus-visible / 环形三态 / 徽标样式清理', () => {
    const css = readRoot('src/renderer/main.css');
    assert.ok(/\.header-actions\s*\{[^}]*gap:\s*8px/.test(css), 'header-actions gap 8px');
    for (const cls of ['search-btn', 'pin-btn', 'menu-btn']) {
      const re = new RegExp('\\.' + cls + '\\s*\\{[^}]*width:\\s*28px;[^}]*height:\\s*28px');
      assert.ok(re.test(css), cls + ' 容器 28×28');
    }
    assert.ok(/\.header button:focus-visible/.test(css), 'focus-visible 焦点环');
    assert.ok(/\.pin-btn\.cd-running/.test(css), 'cd-running 三态 CSS');
    assert.ok(/\.cd-warn/.test(css) && css.includes('#ff9999'), '≤10s 警示红');
    assert.ok(/animation-duration:\s*0\.5s/.test(css), '≤5s 脉冲加速 0.5s');
    assert.ok(!css.includes('.countdown-badge'), '徽标样式已清理');
  });

  test('focus-debug 临时埋点已清理（2026-09-20 验收后移除）；焦点链本身保持', () => {
    const mainProc = readRoot('src/main/index.js');
    assert.ok(/focus-search[\s\S]*?webContents\.focus\(\)/.test(mainProc),
      'focus-search 交付 WebContents 键盘焦点');
    assert.ok(/focus-search[\s\S]*?this\.mainWindow\.show\(\)/.test(mainProc),
      'focus-search 含 show() 重新激活（NOACTIVATE 移除后必须）');
    assert.ok(/focus-search[\s\S]*?moveTop\(\)/.test(mainProc), 'moveTop 组合');
    assert.ok(!/setFocusable\(true\)/.test(mainProc), '焦点模型回切：不再按需切换 setFocusable');
    // 临时埋点已随验收移除（2026-09-20，辉光/计数实机验证齐后清埋点）：
    assert.ok(!(mainProc.includes('[focus-debug]')), '主进程 focus-debug 埋点已清理');
    const rendererMain = readRoot('src/renderer/main.js');
    assert.ok(!rendererMain.includes('[focus-debug]'), '渲染层 focus-debug 埋点已清理');
  });
});

// ========== 实机 BUG 修复回归（2026-09-10：伪 blur 过滤 + 面板级焦点启用） ==========
describe('实机 BUG 修复回归：伪 blur 过滤 + 面板级焦点启用（2026-09-10）', () => {
  test('BUG2：伪 blur（activeElement 仍是输入框）→ 不收起不清词', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    const input = document.getElementById('searchInput');
    document.activeElement = input; // 模拟 IME/窗口失活伪 blur：DOM 焦点未转移
    input.dispatch('blur', { relatedTarget: null });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, '展开态保持');
    assert.equal(api.getState().searchQuery, 'alpha', '词保留');
  });

  test('BUG2：伪 blur（焦点转移到 header 自身）→ 不收起', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    const header = document.getElementById('header');
    const input = document.getElementById('searchInput');
    document.activeElement = header; // 焦点仍在 header 内
    input.dispatch('blur', { relatedTarget: header });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, '展开态保持');
    assert.equal(api.getState().searchQuery, 'alpha', '词保留');
  });

  test('真实转移对照：activeElement 离开 header → 收起清词', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    const input = document.getElementById('searchInput');
    const list = document.getElementById('list');
    document.activeElement = list; // 焦点真实离开 header
    input.dispatch('blur', { relatedTarget: list });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false, '真实转移才收起');
    assert.equal(api.getState().searchQuery, '', '清词');
  });

  test('BUG1：面板任意 pointerdown → focusSearch 启用键盘焦点', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    const before = window._calls.focusSearch;

    document.dispatch('pointerdown', { target: document.getElementById('list') });
    await flushAsync();

    assert.ok(window._calls.focusSearch > before, '面板点击即启用键盘焦点');
  });
});

// ========== 实机 BUG 修复回归二（2026-09-11：Escape 按键检查 + 输入框 no-drag） ==========
describe('实机 BUG 修复回归二：Escape 按键检查 + 输入框 no-drag（2026-09-11）', () => {
  test('BUG2 回归：字母/Ctrl 组合 keydown（展开态持焦）→ 不收起不清词', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    const input = document.getElementById('searchInput');
    // 实机 BUG2 复现路径：输入框持焦后按任意键 → 旧代码 handleSearchEscape 缺
    // Escape 按键检查，每个 keydown 都触发清词收起（不夺焦时代按键不可达故潜伏）
    input.dispatch('keydown', { key: 'b', code: 'KeyB' });
    input.dispatch('keydown', { key: 'F', code: 'KeyF', ctrlKey: true });
    await flushAsync();

    assert.equal(api.getSearchOpen(), true, '展开态保持');
    assert.equal(api.getState().searchQuery, 'alpha', '词保留');
  });

  test('BUG2 回归：Esc 仍正常收起（按键检查不误伤）', async () => {
    const { api, document, window } = loadHarness({ history: TWO_ITEMS });
    await flushAsync();
    await openViaIcon({ document, window });
    typeWord(document, 'alpha');

    const input = document.getElementById('searchInput');
    input.dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
    await flushAsync();

    assert.equal(api.getSearchOpen(), false, 'Esc 收起正常');
    assert.equal(api.getState().searchQuery, '', '清词正常');
  });

  test('CSS 结构：.header-search 容器带 no-drag（展开态输入框可点击）', () => {
    // 注意：readRoot 定义在其他 describe 作用域内，此处用 fs 直读（__dirname 相对路径）
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main.css'), 'utf8');
    const m = css.match(/\.header-search \{[^}]*\}/);
    assert.ok(m, '.header-search 规则存在');
    assert.ok(/-webkit-app-region:\s*no-drag/.test(m[0]),
      '容器必须 no-drag——drag 区点击等于拖窗口，输入框无法聚焦');
  });
});

// ========== 标签搜索（2026-09-11：#tag 语法 + 标签内容匹配，[ClipSense] 标签搜索支持） ==========
describe('标签搜索：#tag 语法 + 标签内容匹配（2026-09-11）', () => {
  // 夹具：d 条目文本不含「验证码」但有 otp 标签——专测标签名命中分支
  const TAGGED = [
    { id: 'a', type: 'text', timestamp: NOW, text: 'https://github.com/x', length: 5, tags: ['link'] },
    { id: 'b', type: 'text', timestamp: NOW - DAY, text: '582914', length: 6, tags: ['otp'] },
    { id: 'c', type: 'text', timestamp: NOW - DAY, text: 'beta world', length: 5, tags: null },
    { id: 'd', type: 'text', timestamp: NOW, text: 'git push origin main', length: 5, tags: ['cmd'] },
  ];

  test('#中文显示名 → 对应标签过滤', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '#验证码');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, 'b');
  });

  test('#tag id（英文）→ 同样命中，大小写不敏感', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '#OTP');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, 'b');
  });

  test('#tag + 文本 query 交集', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '#链接 github');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, 'a');
  });

  test('多 #tag → 交集（无同时命中的条目 → 空）', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '#链接 #验证码');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 0);
  });

  test('#tag + date: 组合（全交集）', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    // b 是昨天 + otp：#验证码 date:昨天 → 命中 b
    typeWord(document, '#验证码 date:昨天');
    const shown1 = api.filterHistory(TAGGED);
    assert.equal(shown1.length, 1);
    assert.equal(shown1[0].id, 'b');
    // #验证码 date:今天 → b 是昨天 → 空
    typeWord(document, '#验证码 date:今天');
    const shown2 = api.filterHistory(TAGGED);
    assert.equal(shown2.length, 0);
  });

  test('未知 #tag → 空结果（对齐 date: 非日期语义）', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '#不存在的标签');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 0);
  });

  test('裸 # → 空结果（invalid）', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '#');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 0);
  });

  test('标签内容匹配：搜「验证码」命中 otp 标签条目（正文不含该词）', () => {
    const { api, document } = loadHarness({ history: TAGGED });
    typeWord(document, '验证码');
    const shown = api.filterHistory(TAGGED);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, 'b');
  });

  test('DOM 全链路：#tag 输入 → 列表只渲染命中条目', async () => {
    const { api, document } = loadHarness({ history: TAGGED });
    await flushAsync(); // 初始 getHistory 异步装载 fullHistory
    typeWord(document, '#链接'); // input 事件同步触发 renderHistory
    const list = document.getElementById('list');
    assert.equal(findItems(list).length, 1);
  });
});
