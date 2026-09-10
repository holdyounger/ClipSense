'use strict';

/**
 * renderer-tags.dom.test.js - 渲染层自动打标签 DOM 桩 harness
 *
 * 依据 .ctx-lockstep/PROJECT.md 硬性结论：
 *   - 列表渲染是 innerHTML 全量重建：交互监听必须挂容器（委托）
 *   - 渲染层 UI 改动交付前必须过 DOM 桩 harness（node --check 查不出运行时错误）
 *
 * 做法：以最小 document/window 桩 + new Function 依次加载
 * i18n.js → renderer.js → main.js（直接驱动真实渲染代码，不改写源码），覆盖：
 *   - meta 行结构（meta-text + tag-chips + "+N" 溢出）
 *   - 筛选条容器委托点击与 active 态（同 chip 再点取消）
 *   - 空标签隐藏 / disabled 标签隐藏（chip 与筛选项两层）
 *   - filterHistory 三重交集（标签 ∩ 子串 ∩ date:）
 *   - visibilitychange 筛选态重置（桩 visibilityState）
 *   - 设置订阅链路（onTagSettingsUpdated → 重渲染）
 *
 * 桩的已知近似（对被测行为无影响）：
 *   - innerHTML 不做 HTML 解析；置空时清空 children（全量重建语义）。
 *     对「先写 innerHTML 再 querySelector 取子节点」的既有用法
 *     （buildDateDivider）按需自动生成占位子元素。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const SOURCES = ['i18n.js', 'renderer.js', 'main.js']
  .map(f => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
  .join('\n;\n');

// ==================== 最小 DOM 桩 ====================

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

function makeElement(tagName) {
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
      const auto = makeElement('span');
      auto.className = cls;
      el.appendChild(auto);
      return auto;
    }
    return found;
  };
  el.querySelectorAll = () => [];
  el.setAttribute = (k, v) => { if (k === 'title') el.title = v; };
  el.getAttribute = (k) => (k === 'title' ? el.title : null);
  el.focus = () => {};
  el.blur = () => {};
  el.scrollTo = () => {};
  el.remove = () => {};
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) {
      el._innerHTML = String(v);
      // 模拟真实 DOM：innerHTML 置空清空子节点（renderTagFilter/renderHistory 全量重建依赖）
      if (!el._innerHTML) el.children.length = 0;
    },
  });
  return el;
}

function makeDocument() {
  const registry = new Map();
  const doc = {
    visibilityState: 'visible',
    listeners: {},
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    getElementById(id) {
      if (!registry.has(id)) {
        const el = makeElement('div');
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
      onCountdownUpdate: () => {},
      getTagSettings: async () => (win._tagSettings === undefined ? null : win._tagSettings),
      onTagSettingsUpdated: (cb) => { handlers.tagSettingsUpdated = cb; },
    },
  };
  return win;
}

/**
 * 加载真实渲染源码（i18n → renderer → main），返回作用域内函数句柄与桩。
 * module 形参传 undefined：屏蔽 renderer.js 尾部的 module.exports 分支。
 */
function loadHarness({ history = [], tagSettings = undefined } = {}) {
  const document = makeDocument();
  const window = makeWindow();
  window._history = history;
  window._tagSettings = tagSettings;
  const navigator = { language: 'zh-CN' };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const factory = new Function(
    'document', 'window', 'navigator', 'localStorage', 'module',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    SOURCES + '\n;return { t, getLang, setLang, tagI18nKey, filterHistory, renderTagFilter,'
    + ' renderHistory, buildTagChips, updateStats, refresh, applyTagSettings,'
    + ' initTagSettings,'
    + ' getState: () => ({ activeTagFilter, searchQuery, fullHistory, tagSettings }) };',
  );
  const api = factory(
    document, window, navigator, localStorage, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
  );
  return { api, document, window };
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

// ==================== 查询辅助 ====================

function findItems(listEl) {
  return listEl.children.filter(c => String(c.className).split(/\s+/).includes('item'));
}

function findMeta(itemEl) {
  return itemEl.children.find(c => String(c.className).split(/\s+/).includes('meta'));
}

function findChipsWrap(metaEl) {
  return metaEl.children.find(c => String(c.className).split(/\s+/).includes('tag-chips'));
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// ==================== 用例 ====================

describe('meta 行 chip 渲染（renderer.js）', () => {
  test('meta-text + tag-chips（按优先级前 2 个）+ "+N" 溢出', async () => {
    const { document } = loadHarness({
      history: [{
        id: 'a', type: 'text', timestamp: NOW, text: 'hello world', length: 11,
        tags: ['link', 'email', 'snippet'],
      }],
    });
    await flushAsync();
    const item = findItems(document.getElementById('list'))[0];
    assert.ok(item, '条目已渲染');
    const meta = findMeta(item);
    assert.ok(meta, 'meta 行存在');
    const metaText = meta.children.find(c => c.className === 'meta-text');
    assert.ok(metaText, 'meta-text span 存在');
    assert.match(metaText.textContent, /·/, 'meta-text 保留「时间 · 字数」结构');
    const chips = findChipsWrap(meta);
    assert.ok(chips, 'tag-chips 容器存在');
    assert.equal(chips.children.length, 3, '前 2 个 chip + 1 个溢出计数');
    assert.equal(chips.children[0].textContent, '链接');
    assert.equal(chips.children[1].textContent, '邮箱');
    assert.equal(chips.children[2].textContent, '+1');
    assert.ok(chips.children[2].className.includes('tag-chip--more'));
    // chip 是纯展示 span（非 button），PRD：筛选入口只有筛选条
    assert.equal(chips.children[0].tagName, 'SPAN');
  });

  test('sensitive chip 带琥珀色 modifier class', async () => {
    const { document } = loadHarness({
      history: [{
        id: 's', type: 'text', timestamp: NOW, text: 'AKIAIOSFODNN7EXAMPLE', length: 20,
        tags: ['sensitive'],
      }],
    });
    await flushAsync();
    const chips = findChipsWrap(findMeta(findItems(document.getElementById('list'))[0]));
    assert.equal(chips.children[0].textContent, '敏感');
    assert.ok(chips.children[0].className.includes('tag-chip--sensitive'));
  });

  test('无标签条目不渲染 chips；历史无任何标签时筛选条整体隐藏', async () => {
    const { document } = loadHarness({
      history: [{ id: 'p', type: 'text', timestamp: NOW, text: 'plain', length: 5, tags: null }],
    });
    await flushAsync();
    const meta = findMeta(findItems(document.getElementById('list'))[0]);
    assert.ok(!findChipsWrap(meta), '无 tags → 无 chip 容器');
    const tagFilter = document.getElementById('tagFilter');
    assert.equal(tagFilter.hidden, true);
    assert.equal(tagFilter.children.length, 0);
  });

  test('disabled 标签：chip 与筛选项都隐藏（PRD 验收 4）', async () => {
    const { document } = loadHarness({
      history: [{
        id: 's1', type: 'text', timestamp: NOW, text: 'secret', length: 6,
        tags: ['sensitive'],
      }],
      tagSettings: { enabled: true, tags: { sensitive: false } },
    });
    await flushAsync();
    const meta = findMeta(findItems(document.getElementById('list'))[0]);
    assert.ok(!findChipsWrap(meta), 'sensitive 被禁用 → chip 不渲染');
    const tagFilter = document.getElementById('tagFilter');
    assert.equal(tagFilter.hidden, true, '唯一存在的标签被禁用 → 筛选条隐藏');
  });
});

describe('标签筛选条（main.js，容器委托）', () => {
  test('委托点击筛选、active 态、同 chip 再点取消回全部', async () => {
    const { api, document } = loadHarness({
      history: [
        { id: 'l1', type: 'text', timestamp: NOW, text: 'https://a.com', length: 5, tags: ['link'] },
        { id: 'p1', type: 'text', timestamp: NOW, text: 'plain text', length: 5, tags: null },
      ],
    });
    await flushAsync();
    const tagFilter = document.getElementById('tagFilter');
    assert.equal(tagFilter.hidden, false);
    assert.equal(tagFilter.children.length, 2, '「全部」恒在 + 链接');
    assert.equal(tagFilter.children[0].textContent, '全部');
    assert.equal(tagFilter.children[1].textContent, '链接');
    assert.ok(tagFilter.children[0].className.includes('active'), '默认全部高亮');

    // 容器委托：点击「链接」chip（target 为 chip 元素，冒泡到容器）
    tagFilter.dispatch('click', { target: tagFilter.children[1] });
    assert.equal(api.getState().activeTagFilter, 'link');
    assert.equal(findItems(document.getElementById('list')).length, 1, '只显示链接条目');
    assert.ok(tagFilter.children[1].className.includes('active'));
    assert.ok(!tagFilter.children[0].className.includes('active'));

    // 再点同一 chip → 取消回全部
    tagFilter.dispatch('click', { target: tagFilter.children[1] });
    assert.equal(api.getState().activeTagFilter, null);
    assert.equal(findItems(document.getElementById('list')).length, 2);
    assert.ok(tagFilter.children[0].className.includes('active'));
  });

  test('filterHistory 三重交集：标签 ∩ 子串 ∩ date:', async () => {
    const { api, document } = loadHarness({
      history: [
        { id: 'A', type: 'text', timestamp: NOW, text: 'alpha deploy', length: 5, tags: ['link'] },
        { id: 'B', type: 'text', timestamp: NOW, text: 'beta world', length: 5, tags: ['link'] },
        { id: 'C', type: 'text', timestamp: NOW - DAY, text: 'alpha world', length: 5, tags: null },
      ],
    });
    await flushAsync();
    const tagFilter = document.getElementById('tagFilter');
    const searchInput = document.getElementById('searchInput');
    const ids = () => api.filterHistory(api.getState().fullHistory).map(i => i.id);

    // ① 标签
    tagFilter.dispatch('click', { target: tagFilter.children[1] });
    assert.deepStrictEqual(ids(), ['A', 'B']);
    // ② 标签 ∩ 子串
    searchInput.value = 'alpha';
    searchInput.dispatch('input');
    assert.deepStrictEqual(ids(), ['A']);
    // ③ 标签 ∩ 子串 ∩ date:
    searchInput.value = 'date:今天 alpha';
    searchInput.dispatch('input');
    assert.deepStrictEqual(ids(), ['A']);
    searchInput.value = 'date:昨天 alpha';
    searchInput.dispatch('input');
    assert.deepStrictEqual(ids(), [], 'C 无链接标签，被标签维度排除');
    // 清理：搜索清空 + 再点取消 → 全量
    searchInput.value = '';
    searchInput.dispatch('input');
    tagFilter.dispatch('click', { target: tagFilter.children[1] });
    assert.equal(api.getState().activeTagFilter, null);
    assert.deepStrictEqual(ids(), ['A', 'B', 'C']);
  });

  test('visibilitychange：窗口重新可见时清空筛选态并重渲染', async () => {
    const { api, document } = loadHarness({
      history: [
        { id: 'l1', type: 'text', timestamp: NOW, text: 'https://a.com', length: 5, tags: ['link'] },
        { id: 'p1', type: 'text', timestamp: NOW, text: 'plain', length: 5, tags: null },
      ],
    });
    await flushAsync();
    const tagFilter = document.getElementById('tagFilter');
    tagFilter.dispatch('click', { target: tagFilter.children[1] });
    assert.equal(api.getState().activeTagFilter, 'link');

    // 隐藏：不清（只在重新可见时重置）
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    assert.equal(api.getState().activeTagFilter, 'link');

    // 重新可见：清空 + 重渲染（PRD：边缘唤出短交互不保留筛选）
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    assert.equal(api.getState().activeTagFilter, null);
    assert.equal(findItems(document.getElementById('list')).length, 2);
    assert.ok(tagFilter.children[0].className.includes('active'));
  });

  test('设置订阅：onTagSettingsUpdated → disabled chip 隐藏、重开恢复', async () => {
    const { document, window } = loadHarness({
      history: [{
        id: 's1', type: 'text', timestamp: NOW, text: 'secret', length: 6,
        tags: ['sensitive'],
      }],
    });
    await flushAsync();
    const metaOf = () => findMeta(findItems(document.getElementById('list'))[0]);
    assert.ok(findChipsWrap(metaOf()), '默认全开 → chip 可见');

    window._handlers.tagSettingsUpdated({ enabled: true, tags: { sensitive: false } });
    assert.ok(!findChipsWrap(metaOf()), '关闭 sensitive → chip 消失');
    assert.equal(document.getElementById('tagFilter').hidden, true);

    window._handlers.tagSettingsUpdated({ enabled: true, tags: { sensitive: true } });
    assert.ok(findChipsWrap(metaOf()), '重开 → chip 恢复（已打数据保留）');
    assert.equal(document.getElementById('tagFilter').hidden, false);
  });
});

describe('i18n（PRD 验收 11）', () => {
  test('6 个新 key 中英齐全，id→key 映射正确', async () => {
    const { api } = loadHarness();
    await flushAsync();
    // 映射：link → tagLink（i18n 字典为驼峰命名）
    assert.equal(api.tagI18nKey('link'), 'tagLink');
    assert.equal(api.tagI18nKey('otp'), 'tagOtp');
    assert.equal(api.t('tagLink'), '链接');
    assert.equal(api.t('tagEmail'), '邮箱');
    assert.equal(api.t('tagOtp'), '验证码');
    assert.equal(api.t('tagSnippet'), '代码');
    assert.equal(api.t('tagSensitive'), '敏感');
    assert.equal(api.t('filterAll'), '全部');
    api.setLang('en');
    assert.equal(api.t('tagLink'), 'Link');
    assert.equal(api.t('tagEmail'), 'Email');
    assert.equal(api.t('tagOtp'), 'OTP');
    assert.equal(api.t('tagSnippet'), 'Code');
    assert.equal(api.t('tagSensitive'), 'Sensitive');
    assert.equal(api.t('filterAll'), 'All');
    api.setLang('zh-CN');
  });
});
