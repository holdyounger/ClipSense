'use strict';

/**
 * stats-today-ui.test.js - 徽章弹窗「今日」页签 图标与动效 契约测试（2026-11-20）
 *
 * 契约（与等级/趋势页签对齐的 HUD 风格）：
 *   1. 图标：4 瓦片 emoji（📥📤🔥⚡）→ Lucide 线性 SVG（viewBox 24, stroke currentColor），
 *      指标分色（复制=紫 / 粘贴=青，继承趋势图 tr-b-copy/tr-b-paste 既定配色；连续=琥珀；经验=金）。
 *   2. 动效：瓦片弹跳错峰入场（scs-tile-pop，4 档）；数值变化打卡跳动（.scs-tile-tick，
 *      JS 变更检测驱动，首次推送只落位不跳）；连续火焰微闪（scs-flame-flick，断签 is-cold 熄灭）；
 *      prefers-reduced-motion 全停（统计模块此前未覆盖）。
 *   3. 死代码清理：HTML 中 CSS 不存在的 scs-num 类移除；shc-pulse 升级脉冲补 CSS（此前 JS 加类无样式）。
 *
 * 口径：A 段静态契约直读 src（HTML/CSS）；B 段行为直测 dist/renderer/main.js
 *       （先 npm run build:ts，与 stats-trend / renderer-tags 同口径：最小 DOM 桩加载真实渲染源码）。
 * 运行（本机 node --test 须逐文件指定）：
 *   node --test tests/stats-today-ui.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const DIST_DIR = path.join(ROOT, 'dist', 'renderer');

// ==================== A 静态契约（src HTML/CSS） ====================

describe('A 今日页签 · 图标契约（Lucide SVG + 指标分色）', () => {
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(RENDERER_DIR, 'main.css'), 'utf8');
  const todayBlock = html.slice(
    html.indexOf('id="scsTodayTab"'),
    html.indexOf('id="scsTrendTab"'),
  );

  test('HTML：今日面板 4 瓦片全部内联 Lucide SVG（viewBox 24 / stroke currentColor）', () => {
    assert.ok(todayBlock.length > 0, 'scsTodayTab 面板存在');
    const svgs = todayBlock.match(/class="scs-tile-svg"/g) || [];
    assert.strictEqual(svgs.length, 4, '4 个瓦片各 1 个 scs-tile-svg');
    const vb = todayBlock.match(/<svg class="scs-tile-svg" viewBox="0 0 24 24"/g) || [];
    assert.strictEqual(vb.length, 4, '全部 SVG 使用 viewBox 0 0 24 24');
    assert.ok(todayBlock.includes('stroke="currentColor"'), 'SVG 走 currentColor 着色（CSS 分色前提）');
  });

  test('HTML：今日面板 emoji（📥📤⚡）已移除（🔥 保留于 streak chip/等级页）', () => {
    assert.ok(!todayBlock.includes('\u{1F4E5}'), '📥 残留');
    assert.ok(!todayBlock.includes('\u{1F4E4}'), '📤 残留');
    assert.ok(!todayBlock.includes('\u{26A1}'), '⚡ 残留');
  });

  test('HTML：指标 class 与瓦片一一对应（copy/paste/streak/exp）+ data-num 关联', () => {
    for (const m of ['scs-tile--copy', 'scs-tile--paste', 'scs-tile--streak', 'scs-tile--exp']) {
      assert.ok(todayBlock.includes('class="scs-tile ' + m + '"'), m + ' 瓦片缺失');
    }
    for (const id of ['shcCopy', 'shcPaste', 'shcStreak', 'shcTotalExp']) {
      assert.ok(todayBlock.includes('data-num="' + id + '"'), 'data-num=' + id + ' 缺失');
    }
  });

  test('HTML：死类名 scs-num 清理（CSS 中无 .scs-num 规则）', () => {
    assert.ok(!html.includes('scs-num'), 'scs-num 残留');
    assert.ok(!/\.scs-num\b/.test(css), 'CSS .scs-num 不应存在');
  });

  test('CSS：4 指标色 token + 图标圆底盘 + 分色规则', () => {
    for (const t of ['--scs-c-copy', '--scs-c-paste', '--scs-c-streak', '--scs-c-exp']) {
      assert.ok(css.includes(t + ':'), t + ' token 缺失');
    }
    assert.ok(css.includes('.scs-tile-ic {'), '图标底盘规则缺失');
    for (const sel of ['.scs-tile--copy .scs-tile-svg', '.scs-tile--paste .scs-tile-svg',
      '.scs-tile--streak .scs-tile-svg', '.scs-tile--exp .scs-tile-svg']) {
      assert.ok(css.includes(sel), sel + ' 分色规则缺失');
    }
  });

  test('CSS：弹跳错峰入场 scs-tile-pop + 4 档 delay（0.06/0.12/0.18s）', () => {
    assert.ok(css.includes('@keyframes scs-tile-pop'), '入场关键帧缺失');
    assert.ok(/animation:\s*scs-tile-pop/.test(css), '瓦片入场绑定缺失');
    for (const d of ['0.06s', '0.12s', '0.18s']) {
      assert.ok(css.includes('animation-delay: ' + d), '错峰 delay ' + d + ' 缺失');
    }
  });

  test('CSS：数值打卡跳动 .scs-tile-tick（数字+图标）+ 火焰微闪 + 断签 is-cold', () => {
    assert.ok(css.includes('.scs-tile-tick .scs-tile-num'), '数字跳动规则缺失');
    assert.ok(css.includes('.scs-tile-tick .scs-tile-ic'), '图标跳动规则缺失');
    assert.ok(css.includes('@keyframes scs-flame-flick'), '火焰微闪关键帧缺失');
    assert.ok(css.includes('.scs-tile--streak.is-cold'), '断签熄灭规则缺失');
  });

  test('CSS：reduced-motion 降级覆盖统计模块（瓦片/跳动/滑轨/弹窗）', () => {
    const blocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
    const statsBlock = blocks.find((b) => b.includes('.scs-'));
    assert.ok(statsBlock, 'reduced-motion 未覆盖统计模块');
    assert.ok(statsBlock.includes('.scs-tile'), '瓦片入场未降级');
    assert.ok(statsBlock.includes('.scs-tile-tick'), '数值跳动未降级');
    assert.ok(statsBlock.includes('.scs-tab-glider'), '流光滑轨未降级');
    assert.ok(statsBlock.includes('.stats-popover'), '弹窗过渡未降级');
  });

  test('CSS：shc-pulse 升级脉冲补齐（此前 JS 加类无样式 = 死动画）', () => {
    assert.ok(css.includes('.shc-pulse'), 'shc-pulse 样式缺失');
    assert.ok(css.includes('@keyframes shc-pulse'), 'shc-pulse 关键帧缺失');
  });
});

// ==================== B 行为（dist main.js，需先 build:ts） ====================

const RENDERER_SRC = ['i18n.js', 'renderer.js', 'spring-anim.js', 'entry-anim.js', 'dock-anim.js', 'main.js'];

if (fs.existsSync(path.join(DIST_DIR, 'main.js'))) {
  const SOURCES = RENDERER_SRC
    .map((f) => fs.readFileSync(path.join(DIST_DIR, f), 'utf8'))
    .join('\n;\n');

  // ---- 最小 DOM 桩（镜像 renderer-tags.dom.test.js 已验证口径，补 matchMedia） ----
  function makeClassList(el) {
    const read = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
    const write = (set) => { el.className = [...set].join(' '); };
    return {
      add(...cs) { const s = read(); cs.forEach((c) => s.add(c)); write(s); },
      remove(...cs) { const s = read(); cs.forEach((c) => s.delete(c)); write(s); },
      toggle(c, force) {
        const s = read();
        const target = force === undefined ? !s.has(c) : !!force;
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
      children: [], parentNode: null, className: '', id: '',
      textContent: '', title: '', type: '', value: '', placeholder: '',
      hidden: false, scrollTop: 0, style: {}, dataset: {},
      isConnected: true, listeners: {}, offsetWidth: 0, offsetLeft: 0,
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
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
      while (node) { if (match(node)) return node; node = node.parentNode; }
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
      return walk(el);
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
          if (id === 'statsBadge') el.className = 'footer-stats';
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
      matchMedia: () => ({ matches: false }),
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
  function loadHarness() {
    const document = makeDocument();
    const window = makeWindow();
    const navigator = { language: 'zh-CN' };
    const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const factory = new Function(
      'document', 'window', 'navigator', 'localStorage', 'module',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame',
      SOURCES + '\n;return { applyStatsSummary };',
    );
    const api = factory(
      document, window, navigator, localStorage, undefined,
      setTimeout, clearTimeout, setInterval, clearInterval,
      () => 0, () => {},
    );
    return { api, document };
  }

  describe('B 今日页签 · 数值变更检测（applyStatsSummary → scs-tile-tick）', () => {
    test('首次推送只落位不跳；变更 → 数字更新 + 瓦片 scs-tile-tick；同值幂等', () => {
      const { api, document } = loadHarness();
      assert.strictEqual(typeof api.applyStatsSummary, 'function', 'main.js 应导出 applyStatsSummary');

      // 桩 registry 为占位元素、无真实父子关系：按真实 DOM 语义手动关联 瓦片→数值
      const copyTile = document.createElement('div');
      copyTile.className = 'scs-tile scs-tile--copy';
      copyTile.appendChild(document.getElementById('shcCopy'));
      const pasteTile = document.createElement('div');
      pasteTile.className = 'scs-tile scs-tile--paste';
      pasteTile.appendChild(document.getElementById('shcPaste'));
      const copyNum = document.getElementById('shcCopy');
      const pasteNum = document.getElementById('shcPaste');

      const s0 = {
        level: 2, title: '归档助手', nextNeed: 100, progress: 0.15,
        todayCopy: 15, todayPaste: 0, streakCurrent: 1, streakBest: 3, exp: 40,
      };

      api.applyStatsSummary(s0);
      assert.strictEqual(copyNum.textContent, '15', '首次推送数值落位');
      assert.ok(!copyTile.classList.contains('scs-tile-tick'), '首次推送不触发跳动（copy）');
      assert.ok(!pasteTile.classList.contains('scs-tile-tick'), '首次推送不触发跳动（paste）');

      api.applyStatsSummary({ ...s0, todayCopy: 16, todayPaste: 2 });
      assert.strictEqual(copyNum.textContent, '16', '变更推送数值更新（copy）');
      assert.strictEqual(pasteNum.textContent, '2', '变更推送数值更新（paste）');
      assert.ok(copyTile.classList.contains('scs-tile-tick'), 'copy 瓦片触发 scs-tile-tick');
      assert.ok(pasteTile.classList.contains('scs-tile-tick'), 'paste 瓦片触发 scs-tile-tick');

      api.applyStatsSummary({ ...s0, todayCopy: 16, todayPaste: 2 });
      assert.strictEqual(copyNum.textContent, '16', '同值推送数值不变');
      assert.strictEqual(pasteNum.textContent, '2', '同值推送数值不变（paste）');
    });

    test('断签（streakCurrent=0）→ streak 瓦片 is-cold；恢复 → 移除', () => {
      const { api, document } = loadHarness();
      const streakTile = document.createElement('div');
      streakTile.className = 'scs-tile scs-tile--streak';
      streakTile.appendChild(document.getElementById('shcStreak'));

      const base = {
        level: 2, title: '归档助手', nextNeed: 100, progress: 0.15,
        todayCopy: 3, todayPaste: 1, streakCurrent: 2, streakBest: 5, exp: 90,
      };
      api.applyStatsSummary(base);
      assert.ok(!streakTile.classList.contains('is-cold'), '连签中无 is-cold');

      api.applyStatsSummary({ ...base, streakCurrent: 0 });
      assert.ok(streakTile.classList.contains('is-cold'), '断签触发 is-cold');

      api.applyStatsSummary({ ...base, streakCurrent: 1 });
      assert.ok(!streakTile.classList.contains('is-cold'), '恢复连签移除 is-cold');
    });
  });
} else {
  test('dist/renderer/main.js 缺失 —— 先运行 npm run build:ts（B 段行为测试需编译产物）', () => {
    assert.fail('需先 build:ts 再运行本测试');
  });
}
