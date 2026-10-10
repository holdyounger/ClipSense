'use strict';

/**
 * tag-search.dom.test.js - 标签搜索（2026-09-11，[ClipSense] 标签搜索支持）DOM 桩 harness
 *
 * 与 search-ux.dom.test.js 同源的最小 document/window 桩 + new Function 依次加载
 * i18n.js → renderer.js → main.js（直接驱动真实渲染代码，不改写源码），覆盖：
 *   - #tag 前缀解析：#显示名 / #tagid / 大小写不敏感 / #tag query 组合 / 多 #tag 交集
 *   - 未知 #tag → 无匹配（对齐 date: 非日期语义）；裸 # 视为无效
 *   - #tag ∩ date: ∩ 内容子串 全部交集组合（如 `#验证码 date:昨天`）
 *   - 普通查询标签内容匹配：无 # 前缀查询命中条目标签显示名（OR 合并，内容优先）
 *   - 与筛选条 chip（activeTagFilter）交集兼容；空查询直通
 *   - date: 既有语义不回归（非日期开头无匹配/时间定位串不受标签名匹配影响）
 *
 * 294 既有用例零回归约束下的追加覆盖；不 commit 不 push。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'dist', 'renderer');
// spring-anim.js / entry-anim.js 必须先于 main.js（main 顶层 createEntryAnim + 播放链路引用）
const SOURCES = ['i18n.js', 'renderer.js', 'spring-anim.js', 'entry-anim.js', 'dock-anim.js', 'main.js']
  .map(f => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
  .join('\n;\n');

// ==================== 最小 DOM 桩（与 search-ux.dom.test.js 同源） ====================

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
      onHistoryUpdated: (cb) => { handlers.historyUpdated = cb; },
      onCountdownUpdate: (cb) => { handlers.countdownUpdated = cb; },
      getTagSettings: async () => (win._tagSettings === undefined ? null : win._tagSettings),
      onTagSettingsUpdated: (cb) => { handlers.tagSettingsUpdated = cb; },
    },
  };
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
    SOURCES + '\n;return { t, getLang, setLang, filterHistory, parseTagQuery, getTagDisplayName,'
    + ' refresh, updateStats, getSearchOpen: () => searchOpen,'
    + ' getState: () => ({ searchQuery, activeTagFilter, fullHistory, tagSettings }) };',
  );
  const api = factory(
    document, window, navigator, localStorage, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
  );
  return { api, document, window };
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

// ==================== 数据 ====================

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const HISTORY = [
  // 内容含「验证码」字样，无标签
  { id: 'plain-otp-word', type: 'text', timestamp: NOW, text: '您的验证码是 123456', length: 10, tags: null },
  // 正文不含验证码，otp 标签条目（标签内容匹配目标）
  { id: 'otp-tagged', type: 'text', timestamp: NOW, text: '624191', length: 6, tags: ['otp'] },
  // 链接标签条目，昨天入库（#tag ∩ date: 用例）
  { id: 'link-yesterday', type: 'text', timestamp: NOW - DAY, text: 'https://example.com/a', length: 10, tags: ['link'] },
  // 链接标签条目，今天入库（date: 交集排除项）
  { id: 'link-today', type: 'text', timestamp: NOW, text: 'https://example.com/b', length: 10, tags: ['link'] },
  // 链接标签 + 内容含 alpha（#tag ∩ 内容子串用例）
  { id: 'link-alpha', type: 'text', timestamp: NOW, text: 'alpha deploy https://a.dev', length: 20, tags: ['link'] },
  // 双标签条目（多 #tag 交集用例：link ∩ email 命中）
  { id: 'link-email', type: 'text', timestamp: NOW, text: 'contact a@b.c', length: 10, tags: ['link', 'email'] },
  // email 单标签（多 #tag 交集排除项）
  { id: 'email-only', type: 'text', timestamp: NOW, text: 'x@y.z', length: 5, tags: ['email'] },
  // 命令行标签（tag id 匹配用例）
  { id: 'cmd-item', type: 'text', timestamp: NOW, text: 'git push origin main', length: 19, tags: ['cmd'] },
];

function idsOf(list) {
  return list.map(i => i.id);
}

describe('#tag 前缀解析（parseTagQuery 纯函数）', () => {
  test('#显示名（中文）→ tag id', () => {
    const { api } = loadHarness();
    const r = api.parseTagQuery('#验证码');
    assert.deepEqual(r.tagIds, ['otp']);
    assert.equal(r.textQ, '');
    assert.equal(r.invalid, false);
  });

  test('#tagid → tag id（大小写不敏感）', () => {
    const { api } = loadHarness();
    assert.deepEqual(api.parseTagQuery('#cmd').tagIds, ['cmd']);
    assert.deepEqual(api.parseTagQuery('#LINK').tagIds, ['link']);
  });

  test('#tag + query → tagIds 与剩余文本', () => {
    const { api } = loadHarness();
    const r = api.parseTagQuery('#链接 alpha');
    assert.deepEqual(r.tagIds, ['link']);
    assert.equal(r.textQ, 'alpha');
  });

  test('多 #tag → 去重收集（交集语义由 filterHistory 执行）', () => {
    const { api } = loadHarness();
    const r = api.parseTagQuery('#链接 #邮箱 #link');
    assert.deepEqual(r.tagIds, ['link', 'email']);
  });

  test('未知 #词 → invalid=true（上层无匹配）', () => {
    const { api } = loadHarness();
    const r = api.parseTagQuery('#不存在的标签');
    assert.equal(r.invalid, true);
    assert.deepEqual(r.tagIds, []);
  });

  test('裸 #（无名字）→ invalid=true', () => {
    const { api } = loadHarness();
    assert.equal(api.parseTagQuery('#').invalid, true);
  });

  test('date: 段不参与 # 解析（互不吞噬）', () => {
    const { api } = loadHarness();
    const r = api.parseTagQuery('#验证码 date:昨天');
    assert.deepEqual(r.tagIds, ['otp']);
    assert.equal(r.textQ, 'date:昨天');
  });
});

describe('#tag 前缀过滤（filterHistory 集成）', () => {
  test('单 #tag → 该标签全部条目', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync(); // 等待 refresh() 完成 fullHistory 填充
    const input = document.getElementById('searchInput');
    input.value = '#链接';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)),
      ['link-yesterday', 'link-today', 'link-alpha', 'link-email']);
  });

  test('多 #tag → 交集', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = '#链接 #邮箱';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['link-email']);
  });

  test('#tag + query → tag ∩ 内容子串', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = '#链接 alpha';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['link-alpha']);
  });

  test('#tag ∩ date:（任务示例形态 #验证码 date:昨天）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    // otp 标签今天入库 → date:昨天 交集为空；换成 link 验证命中
    input.value = '#链接 date:昨天';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['link-yesterday']);

    input.value = '#链接 date:今天';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)).sort(),
      ['link-alpha', 'link-email', 'link-today'].sort());
  });

  test('未知 #tag → 空结果（对齐 date: 非日期语义，不静默 fallback）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = '#不存在的标签';
    input.dispatch('input');
    assert.deepEqual(api.filterHistory(api.getState().fullHistory), []);
  });

  test('#tag ∩ 标签筛选条 chip 交集兼容（两层交集叠加）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    // 先点筛选条「链接」chip（children[0] = 全部，children[1] = 第一个 chip）
    const tagFilter = document.getElementById('tagFilter');
    const linkChip = tagFilter.children.find(c => c.dataset.tag === 'link');
    tagFilter.dispatch('click', { target: linkChip });
    assert.equal(api.getState().activeTagFilter, 'link');

    // 搜索 #邮箱 → chip(link) ∩ #email = link-email
    const input = document.getElementById('searchInput');
    input.value = '#邮箱';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['link-email']);
  });
});

describe('标签内容匹配（普通查询 OR 标签显示名）', () => {
  test('搜「验证码」→ 内容命中 + otp 标签命中（OR 合并）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = '验证码';
    input.dispatch('input');
    const got = idsOf(api.filterHistory(api.getState().fullHistory));
    assert.ok(got.includes('plain-otp-word'), '内容命中分支');
    assert.ok(got.includes('otp-tagged'), '标签显示名命中分支（正文不含验证码）');
    assert.equal(got.length, 2);
  });

  test('搜「链接」→ 标签名为 link 的条目命中（正文不含「链接」二字）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = '链接';
    input.dispatch('input');
    const got = idsOf(api.filterHistory(api.getState().fullHistory));
    assert.deepEqual(got.sort(),
      ['link-alpha', 'link-email', 'link-today', 'link-yesterday'].sort());
  });

  test('搜「命令行」→ cmd 标签条目命中；英文显示名 en 语言同样命中', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    let input = document.getElementById('searchInput');
    input.value = '命令行';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['cmd-item']);

    // 切英文：Command
    api.setLang('en');
    input.value = 'command';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['cmd-item']);
    api.setLang('zh-CN');
  });

  test('内容命中优先级不变：内容含「链接」字样文本条目仍走内容分支', async () => {
    const { api, document } = loadHarness({
      history: [{ id: 'lit', type: 'text', timestamp: NOW, text: '友情链接交换', length: 6, tags: null }],
    });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = '链接';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['lit']);
  });
});

describe('兼容性：既有语义零回归（294 基线保护）', () => {
  test('date: 非日期开头仍无匹配；date: 仍可组合内容与时间串', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    input.value = 'date:前天';
    input.dispatch('input');
    assert.deepEqual(api.filterHistory(api.getState().fullHistory), [], '非日期 = 无匹配');

    input.value = 'date:今天 alpha';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['link-alpha']);
  });

  test('纯日期串自动识别不受 # 解析影响', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    const ymd = new Date(NOW - DAY);
    const mmdd = `${ymd.getMonth() + 1}-${ymd.getDate()}`;
    input.value = mmdd;
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['link-yesterday']);
  });

  test('无词直通（q 为空 → 原列表返回，含标签筛选交集）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const tagFilter = document.getElementById('tagFilter');
    const emailChip = tagFilter.children.find(c => c.dataset.tag === 'email');
    tagFilter.dispatch('click', { target: emailChip });
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)),
      ['link-email', 'email-only']);
  });

  test('时间定位串匹配仍生效（内容/标签名都未命中时按 HH:MM:SS 定位）', async () => {
    const { api, document } = loadHarness({
      history: [{ id: 't1', type: 'text', timestamp: NOW, text: 'hello world', length: 5, tags: null }],
    });
    await flushAsync();
    const input = document.getElementById('searchInput');
    const d = new Date(NOW);
    const hms = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    input.value = hms;
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), ['t1']);
  });

  test('搜索词若为标签 id 形态子串不误伤内容匹配语义（# 前缀必须显式）', async () => {
    const { api, document } = loadHarness({ history: HISTORY });
    await flushAsync();
    const input = document.getElementById('searchInput');
    // 无 # 的「otp」按内容/标签名子串匹配：otp-tagged 标签名「验证码」不含 otp，
    // 但内容「624191」不含 → 应为空（id 不参与普通查询匹配，仅 # 前缀与显示名双轨）
    input.value = 'otp';
    input.dispatch('input');
    assert.deepEqual(idsOf(api.filterHistory(api.getState().fullHistory)), []);
  });
});
