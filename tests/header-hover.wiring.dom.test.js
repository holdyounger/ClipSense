'use strict';

/**
 * header-hover.wiring.dom.test.js - Header 可变高度（方案 A）接线与边界补测
 * （2026-09-28 测试闭环审计；header-hover.dom.test.js 45 条纯函数层用例的补强，不重复）
 *
 * 新增覆盖（审计发现的缺口）：
 *   A. 渲染层接线（DOM 桩 harness 直驱 main.js，模式同 search-ux.dom.test.js）：
 *      - 'header:hover' IPC → .header--hover class 切换（onHeaderHover 桥）
 *      - FLIP 同帧时序在真实装配链路中成立（Invert 同步写 + rAF Play，只动 transform）
 *      - 强制展开（约束 4）：search-open / 菜单打开锁高，IPC false 期间不让位；
 *        关闭后回归 hover 判定
 *      - window.__clipSenseHeaderSnap 滑出复位桥（清 class + transform + IPC 态）
 *   B. 边界与异常专项（任务书第 3 项）：
 *      - DPI 缩放：非整数 bounds（分数坐标）判定 + 半像素实测钳制
 *      - 多显示器：副屏正坐标 / 负坐标虚拟桌面 / 跨屏光标
 *      - IPC 乱序：离开先于到达（防抖撤销）/ 迟到旧帧（now 回退）不破坏状态
 *      - markShown 重入：抑制窗口刷新
 *   C. FLIP 与列表重建竞争精细化：
 *      - 重建窗口内 hover 切换零动画副作用
 *      - 飞行中 FLIP 遇重建 → 下一帧切换走 snap 分支 cancel 在飞动画
 *      - 未决 Invert transform 的同步清除
 *   D. 落盘静态断言：CSS 两态常量 + header 本体禁 transition + reduced-motion 块 +
 *      辅助行规格 / HTML 结构与脚本顺序 / preload 桥 / i18n 双语 /
 *      edge-detector + main.js 接线要素
 *
 * 已知偏离（详见 Docs/测试报告-header可变高度-2026-09-28.md）以 test.todo 标注（D-1）。
 *
 * 运行：node --test tests/header-hover.wiring.dom.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  isCursorInHeaderRegion, clampHeaderHeight, createHeaderHoverState,
} = require(path.join(__dirname, '..', 'src', 'main', 'header-hover.js'));

const {
  createHeaderHoverUi,
} = require(path.join(__dirname, '..', 'src', 'renderer', 'header-hover-ui.js'));

const springFrames = require(path.join(__dirname, '..', 'src', 'renderer', 'spring-anim.js')).springFrames;

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
// 加载顺序同 search-ux.dom.test.js：spring-anim / entry-anim 必须先于 main.js
const SOURCES = ['i18n.js', 'renderer.js', 'spring-anim.js', 'header-hover-ui.js', 'entry-anim.js', 'dock-anim.js', 'main.js']
  .map((f) => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
  .join('\n;\n');

// ==================== 最小 DOM 桩（复制自 search-ux.dom.test.js 同源模式） ====================

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
  el.closest = () => null;
  el.contains = (node) => { let n = node; while (n) { if (n === el) return true; n = n.parentNode; } return false; };
  el.querySelector = () => null;
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
    _reduced: false, // reduced-motion 开关注入点（window.matchMedia 桩读取）
    matchMedia: (q) => ({ matches: win._reduced, media: String(q || '') }),
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
      // 方案 A 桥：录制主进程 'header:hover' 推送回调（接线测试入口）
      onHeaderHover: (cb) => { handlers.headerHover = cb; },
    },
    _calls: { focusSearch: 0, blurSearch: 0, setSearchActive: [] },
  };
  return win;
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

/** 有界排空 rAF 队列（防意外自续队列死循环） */
function drainQueue(queue) {
  let n = 0;
  while (queue.length && n++ < 200) queue.shift()();
}

/**
 * 装配真实渲染层（main.js 顶层执行），返回接线测试操作柄。
 * listEl 的 getBoundingClientRect 按 header class 模拟两态 layout：
 * 静止 32 / 展开 60（与 main.css 常量一致），FLIP Δ 仍 ±28（60-32=28）。
 */
function loadWiring({ history = [], reduced = false } = {}) {
  const rafQueue = [];
  const raf = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  const document = makeDocument();
  const window = makeWindow();
  window._reduced = reduced;
  window._history = history;
  // animate 侦桩：记录 WAAPI 调用（真实 listEl 无内建 animate，等价旧环境降级路径的反向）
  const anims = [];
  const listEl = document.getElementById('list');
  const headerEl = document.getElementById('header');
  listEl.animate = (frames, opts) => {
    const a = { frames, opts, onfinish: null, _cancelled: false, cancel() { this._cancelled = true; } };
    anims.push(a);
    return a;
  };
  listEl.getBoundingClientRect = () => ({
    top: headerEl.classList.contains('header--hover') ? 60 : 32,
    height: 0,
  });

  const navigator = { language: 'zh-CN' };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const factory = new Function(
    'document', 'window', 'navigator', 'localStorage', 'module',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    SOURCES + '\n;return {};',
  );
  factory(
    document, window, navigator, localStorage, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval, raf,
  );

  const settle = async () => {
    await flushAsync();      // refresh() 等异步链落地
    drainQueue(rafQueue);    // 启动期 markListRebuilt 清除链等
  };

  return { document, window, headerEl, listEl, rafQueue, anims, handlers: window._handlers, settle };
}

// ==================== A. IPC 驱动接线（真实 main.js 装配链路） ====================

describe('A. IPC 驱动接线：header:hover → .header--hover（补测：既有用例未覆盖 IPC 层）', () => {
  test('A1 preload 桥注册 + 推送 true/false 驱动 class 挂/摘', async () => {
    const h = loadWiring();
    await h.settle();
    assert.strictEqual(typeof h.handlers.headerHover, 'function', 'onHeaderHover 回调已注册');
    assert.ok(!h.headerEl.classList.contains('header--hover'), '初始静止态');
    h.handlers.headerHover(true);
    assert.ok(h.headerEl.classList.contains('header--hover'));
    h.handlers.headerHover(false);
    assert.ok(!h.headerEl.classList.contains('header--hover'));
  });

  test('A2 FLIP 同帧时序（装配级）：Invert 同步写 + rAF Play spring 归零，只动 transform', async () => {
    const h = loadWiring();
    await h.settle();
    const base = h.anims.length;
    h.handlers.headerHover(true);
    // 同步段：class 已切 + Invert 钉回旧位（展开 list 下移 28 → translateY(-28px)）
    assert.ok(h.headerEl.classList.contains('header--hover'));
    assert.strictEqual(h.listEl.style.transform, 'translateY(-28px)');
    // Play 段：rAF 后 WAAPI 关键帧
    drainQueue(h.rafQueue);
    assert.strictEqual(h.anims.length, base + 1, 'Play 恰好一次 animate');
    const anim = h.anims[h.anims.length - 1];
    assert.ok(anim.frames.length >= 2);
    for (const f of anim.frames) {
      assert.deepStrictEqual(Object.keys(f), ['transform'], '帧只含 transform（性能红线）');
    }
    assert.strictEqual(anim.frames[0].transform, 'translateY(-28.00px)', '首帧 = Invert 值');
    assert.strictEqual(anim.frames[anim.frames.length - 1].transform, 'translateY(0.00px)', '末帧精确落位');
    // onfinish 清理：cancel + 不驻留内联 transform
    anim.onfinish();
    assert.strictEqual(h.listEl.style.transform, '');
  });

  test('A3 强制展开·搜索（约束 4）：search-open 锁高，IPC false 不让位；Esc 收起后回归 hover 判定', async () => {
    const h = loadWiring();
    await h.settle();
    const btn = h.document.getElementById('searchBtn');
    btn.dispatch('click', { target: btn });
    await flushAsync();
    drainQueue(h.rafQueue);
    assert.ok(h.headerEl.classList.contains('search-open'), '搜索展开');
    assert.ok(h.headerEl.classList.contains('header--hover'), '强制挂展开高度');
    h.handlers.headerHover(false); // 主进程判定：光标已离开 header 带
    drainQueue(h.rafQueue);
    assert.ok(h.headerEl.classList.contains('header--hover'), '搜索期间 hover 让位，锁定展开');
    // Esc 收起（收起即清词链路）→ 回归 hover 判定（当前 false → 塌回静止）
    const animsBeforeEsc = h.anims.length;
    const input = h.document.getElementById('searchInput');
    input.dispatch('keydown', { key: 'Escape' });
    await flushAsync();
    drainQueue(h.rafQueue); // 收起 FLIP Play 执行
    assert.ok(!h.headerEl.classList.contains('search-open'));
    assert.ok(!h.headerEl.classList.contains('header--hover'), '搜索关闭后回归 hover 判定');
    // 收起动画播完（WAAPI finish → onfinish 清理）后无残留
    const closeAnim = h.anims[h.anims.length - 1];
    assert.strictEqual(h.anims.length, animsBeforeEsc + 1, 'Esc 后恰有一次收起 FLIP 动画');
    closeAnim.onfinish();
    assert.strictEqual(h.listEl.style.transform, '', '无 FLIP 残留');
  });

  test('A4 强制展开·搜索（约束 4 剩余面；菜单已取消迁托盘 2026-09-30）', async () => {
    // 原 A4 验证「菜单打开锁高」——菜单迁托盘后强制展开仅剩 search-open 一路。
    // 搜索展开锁高已在 openSearch/collapseSearch 内经 syncHeaderExpanded 覆盖，
    // 此处验证 hover 信号与 search-open 的交互：搜索未开时 hover=false → header 回落。
    const h = loadWiring();
    await h.settle();
    h.handlers.headerHover(true);
    assert.ok(h.headerEl.classList.contains('header--hover'), 'hover 信号驱动展开');
    h.handlers.headerHover(false);
    assert.ok(!h.headerEl.classList.contains('header--hover'), 'hover 信号消失后回落');
  });

  test('A5 snap 复位桥（约束 4 面板即将收起）：清 class/transform/IPC 态，可重新进入', async () => {
    const h = loadWiring();
    await h.settle();
    h.handlers.headerHover(true);
    drainQueue(h.rafQueue);
    assert.ok(h.headerEl.classList.contains('header--hover'));
    h.window.__clipSenseHeaderSnap(); // 主进程滑出收尾调用
    assert.ok(!h.headerEl.classList.contains('header--hover'));
    assert.strictEqual(h.listEl.style.transform, '');
    assert.strictEqual(h.headerEl.className.indexOf('header--hover'), -1);
    // 复位后不锁死：下一轮 IPC true 正常展开
    h.handlers.headerHover(true);
    assert.ok(h.headerEl.classList.contains('header--hover'));
  });
});

// ==================== B. 边界与异常专项（任务书第 3 项） ====================

describe('B. 边界专项：DPI 缩放 / 多显示器（补测：既有用例仅整数坐标单屏）', () => {
  test('B1 DPI 缩放：非整数 bounds + 分数光标坐标判定正确（125%/150% 常见）', () => {
    const bounds = { x: 100.5, y: 50.25, width: 360.25, height: 559.75 };
    // 判定带：x ∈ [98.5, 462.75]，y ∈ [48.25, 120.5]
    assert.strictEqual(isCursorInHeaderRegion({ x: 200.8, y: 100.1 }, bounds), true, '带内分数坐标');
    assert.strictEqual(isCursorInHeaderRegion({ x: 200.8, y: 121 }, bounds), false, '带下沿外 0.5px');
    assert.strictEqual(isCursorInHeaderRegion({ x: 200.8, y: 300 }, bounds), false, '窗内但不在带内');
    assert.strictEqual(isCursorInHeaderRegion({ x: 462.7, y: 80 }, bounds), true, '贴右容差内（462.75）');
    assert.strictEqual(isCursorInHeaderRegion({ x: 463, y: 80 }, bounds), false, '右容差外 0.25px');
  });

  test('B2 多显示器：副屏正坐标 / 负坐标虚拟桌面 / 跨屏光标', () => {
    const sub = { x: 1920, y: 0, width: 360, height: 560 }; // 主屏右侧副屏
    assert.strictEqual(isCursorInHeaderRegion({ x: 2100, y: 30 }, sub), true, '副屏 header 带内');
    assert.strictEqual(isCursorInHeaderRegion({ x: 100, y: 30 }, sub), false, '主屏上的光标不误判');
    const neg = { x: -1920, y: 0, width: 360, height: 560 }; // 负坐标虚拟桌面（左屏），窗口 x ∈ [-1920,-1560]
    assert.strictEqual(isCursorInHeaderRegion({ x: -1700, y: 30 }, neg), true, '负坐标屏 header 带内');
    assert.strictEqual(isCursorInHeaderRegion({ x: -1922, y: 30 }, neg), true, '左缘容差内（-1922）');
    assert.strictEqual(isCursorInHeaderRegion({ x: -1559, y: 30 }, neg), true, '右缘容差内（-1558）');
    assert.strictEqual(isCursorInHeaderRegion({ x: -1555, y: 30 }, neg), false, '右缘容差外');
    assert.strictEqual(isCursorInHeaderRegion({ x: -100, y: 30 }, neg), false, '负坐标系下出窗判 false');
  });

  test('B3 半像素实测钳制：round 后再 min(h,36)，越界/非法回退常量 32', () => {
    assert.strictEqual(clampHeaderHeight(32.4), 32);
    assert.strictEqual(clampHeaderHeight(32.6), 33);
    assert.strictEqual(clampHeaderHeight(36.4), 36);
    assert.strictEqual(clampHeaderHeight(36.5), 36, '36.5 → round 37 → 钳回 36');
    assert.strictEqual(clampHeaderHeight(Infinity), 32, '非法回退常量');
    assert.strictEqual(clampHeaderHeight('abc'), 32, '非数值字符串回退');
  });
});

describe('B. IPC 乱序与抑制窗口（补测：事件序异常下的状态机稳健性）', () => {
  test('B4 乱序：离开先于到达处理 → 防抖撤销，状态不受损；迟到旧帧（now 回退）不破坏状态', () => {
    const s = createHeaderHoverState();
    // 常规进入
    s.update(true, 1000);
    // 乱序①：离开事件（t=1005）先处理，到达事件（t=1010）后到
    assert.strictEqual(s.update(false, 1005).state, true, '离开启动防抖，未到期仍 true');
    assert.strictEqual(s.update(true, 1010).state, true, '到达撤销离开计时');
    assert.strictEqual(s.update(true, 1015).state, true);
    // 乱序②：迟到的「到达」旧帧（now 小于上次时间戳）→ 幂等保持 true
    assert.strictEqual(s.update(true, 990).state, true);
    // 乱序③：迟到的「离开」旧帧（now 回退）→ 仅把防抖起点后移，不立即翻转
    s.update(true, 3000);
    assert.strictEqual(s.update(false, 2950).state, true, '迟到离开帧不立即翻转');
    assert.strictEqual(s.update(false, 3010).state, true, '自迟到帧起 60ms < 180ms');
    assert.strictEqual(s.update(false, 3130).state, false, '防抖满 180ms 正常收起');
  });

  test('B5 markShown 重入：抑制窗口刷新（旧窗口到期不生效，新窗口边界精确翻转）', () => {
    const s = createHeaderHoverState();
    s.markShown(0);            // 抑制至 400
    assert.strictEqual(s.update(true, 300).suppress, true);
    s.markShown(350);          // 弹出重入 → 抑制至 750
    assert.strictEqual(s.update(true, 500).state, false, '原窗口已过但新窗口未过，仍抑制');
    const r = s.update(true, 750);
    assert.strictEqual(r.suppress, false);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.state, true, '新抑制窗口期满，下一拍即时进入');
  });
});

// ==================== C. FLIP 与列表重建竞争精细化（补测：时序组合既有用例未覆盖） ====================

function mkCtlEl() {
  const el = {
    className: '', style: {}, _anims: [],
    getBoundingClientRect() { return { top: el.classList.contains('header--hover') ? 60 : 32 }; },
  };
  el.classList = makeClassList(el);
  el.animate = (frames, opts) => {
    const a = { frames, opts, onfinish: null, _cancelled: false, cancel() { a._cancelled = true; } };
    el._anims.push(a);
    return a;
  };
  return el;
}

function mkCtl({ reduced = false } = {}) {
  const headerEl = mkCtlEl();
  const listEl = mkCtlEl();
  // 两态 layout 模拟：list top 依 header class（32/60，同 main.css 常量）
  listEl.getBoundingClientRect = () => ({
    top: headerEl.classList.contains('header--hover') ? 60 : 32,
  });
  const rafQueue = [];
  const ui = createHeaderHoverUi({
    headerEl, listEl, springFrames,
    reducedMotion: () => reduced,
    raf: (fn) => rafQueue.push(fn),
  });
  const drain = () => drainQueue(rafQueue);
  return { headerEl, listEl, ui, rafQueue, drain };
}

describe('C. FLIP × 列表重建竞争精细化（补测：设计稿 A-3 风险条的组合时序）', () => {
  test('C1 重建窗口内 hover 切换：零动画副作用（无 Invert / 无 Play 排队 / 无 WAAPI）', () => {
    const { headerEl, listEl, ui, rafQueue } = mkCtl();
    ui.markListRebuilt();
    const q0 = rafQueue.length; // 1（外层清除链）
    ui.applyHover(true);
    assert.ok(headerEl.classList.contains('header--hover'), 'class 瞬切照常');
    assert.strictEqual(listEl.style.transform, '', '不写 Invert transform');
    assert.strictEqual(rafQueue.length, q0, '无 FLIP Play 排队');
    assert.strictEqual(listEl._anims.length, 0, '不启动 WAAPI');
  });

  test('C2 飞行中 FLIP 遇重建：下一帧切换走 snap 分支，cancel 在飞动画；窗口过后恢复 FLIP', () => {
    const { headerEl, listEl, ui, drain } = mkCtl();
    ui.applyHover(true);
    drain(); // Play 执行 → 动画在飞
    const anim = listEl._anims[listEl._anims.length - 1];
    assert.ok(anim && !anim._cancelled, '动画已启动');
    ui.markListRebuilt(); // 600ms tick 重建 → 瞬切窗口开启
    ui.applyHover(false);
    assert.strictEqual(anim._cancelled, true, '在飞动画被 cancel（不留影子）');
    assert.ok(!headerEl.classList.contains('header--hover'));
    assert.strictEqual(listEl.style.transform, '');
    drain(); // 重建清除链两帧走完
    ui.applyHover(true); // 窗口过后恢复正常 FLIP
    assert.strictEqual(listEl.style.transform, 'translateY(-28px)', 'FLIP 恢复');
  });

  test('C3 未决 Invert 的同步清除：applyHover 后 rAF 未执行即 snap → transform 立即归零', () => {
    const { headerEl, listEl, ui } = mkCtl();
    ui.applyHover(true); // Invert 已同步写入，Play 尚未执行
    assert.strictEqual(listEl.style.transform, 'translateY(-28px)');
    ui.snap();
    assert.strictEqual(listEl.style.transform, '', 'snap 同步清除未决 Invert');
    assert.ok(!headerEl.classList.contains('header--hover'));
    // 注意：此处不 drain —— Play rAF 仍挂着，属缺陷 D-1（见 todo 用例与测试报告）
  });

  test('D-1 修复验证（2026-09-28 代际令牌）：applyHover 后未 drain 即 snap → drain 后无影子动画', () => {
    const { headerEl, listEl, ui, rafQueue, drain } = mkCtl();
    ui.applyHover(true); // Invert 已同步写入，Play rAF 排队未执行
    assert.strictEqual(listEl.style.transform, 'translateY(-28px)');
    ui.snap();           // playGen++ 作废未决 Play
    assert.strictEqual(listEl.style.transform, '', 'snap 同步清除 Invert');
    const animsBefore = listEl._anims.length;
    drain();             // 未决 Play 在此执行——若无防护会以 -28 起播影子动画
    assert.strictEqual(listEl.style.transform, '', '影子动画未污染 transform');
    assert.strictEqual(listEl._anims.length, animsBefore, '无影子 WAAPI 起播');
    assert.ok(!headerEl.classList.contains('header--hover'), '保持静止态');
    // 代际语义不破坏复用：snap 后新一轮 FLIP 正常起播
    ui.applyHover(true);
    drain();
    assert.strictEqual(listEl._anims.length, animsBefore + 1, '新一轮 FLIP 正常');
  });
});

// ==================== D. 落盘静态断言（两态/CSS 红线/接线要素） ====================

describe('D. 落盘静态断言（方案 A 参数与红线的文件级锚定）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('D1 main.css：静止 32 / 展开 60 常量；header 本体禁 transition（height 瞬切红线）', () => {
    const css = readRoot('src/renderer/main.css');
    const headerBlock = css.match(/\.header\s*\{[^}]*\}/);
    assert.ok(headerBlock, '.header 块存在');
    assert.ok(/height:\s*32px/.test(headerBlock[0]), '静止态常量 32px');
    assert.ok(!/transition/.test(headerBlock[0]), 'header 本体无 transition（height 瞬切）');
    const hoverBlock = css.match(/\.header--hover\s*\{[^}]*\}/);
    assert.ok(hoverBlock, '.header--hover 块存在');
    assert.ok(/height:\s*60px/.test(hoverBlock[0]), '展开态常量 60px');
    assert.ok(!/transition/.test(hoverBlock[0]), '展开态块无 height transition');
  });

  test('D2 main.css：辅助行规格（2026-09-30 行中部常驻/绝对定位/搜索展开隐藏）', () => {
    const css = readRoot('src/renderer/main.css');
    const metaBase = css.match(/\.header-meta\s*\{[^}]*\}/);
    assert.ok(metaBase && /position:\s*absolute/.test(metaBase[0]), '绝对定位（不占 flex 流）');
    assert.ok(metaBase && /opacity:\s*1/.test(metaBase[0]), '常驻显示（opacity 1）');
    assert.ok(metaBase && /pointer-events:\s*none/.test(metaBase[0]), '不挡交互');
    assert.ok(metaBase && /text-overflow:\s*ellipsis/.test(metaBase[0]), '超长省略');
    const rowBlock = css.match(/\.header-row\s*\{[^}]*\}/);
    assert.ok(rowBlock && /position:\s*relative/.test(rowBlock[0]), 'header-row 为绝对定位包含块');
    const searchHide = css.match(/\.header\.search-open \.header-meta\s*\{[^}]*\}/);
    assert.ok(searchHide && /opacity:\s*0/.test(searchHide[0]), '搜索展开时隐藏');
  });

  test('D3 main.css：reduced-motion 块覆盖 .header（补间去除，功能保留）', () => {
    const css = readRoot('src/renderer/main.css');
    const idx = css.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(idx >= 0, 'reduced-motion 媒体查询存在');
    const chunk = css.slice(idx, idx + 400);
    assert.ok(/\.header\b/.test(chunk), '覆盖 .header');
    assert.ok(/transition:\s*none/.test(chunk), '补间去除');
  });

  test('D4 index.html：headerMeta 容器 + header-hover-ui.js 先于 main.js 加载', () => {
    const html = readRoot('src/renderer/index.html');
    assert.ok(html.includes('<div class="header-meta" id="headerMeta">'), '辅助行容器');
    const iRow = html.indexOf('class="header-row"');
    const iMeta = html.indexOf('id="headerMeta"');
    const iSearch = html.indexOf('class="header-search"');
    assert.ok(iMeta > iRow && iMeta < iSearch, 'meta 位于 header-row 内、搜索框之前（2026-09-30 行中置）');
    const iUi = html.indexOf('header-hover-ui.js');
    const iMain = html.indexOf('src="main.js"');
    assert.ok(iUi >= 0 && iMain > iUi, 'header-hover-ui.js 必须先于 main.js（main 顶层引用其工厂）');
  });

  test('D5 preload 桥 + i18n 双语辅助行 key', () => {
    const preload = readRoot('src/renderer/preload.js');
    assert.ok(preload.includes('onHeaderHover'), 'preload 暴露 onHeaderHover');
    assert.ok(preload.includes("'header:hover'"), 'preload 订阅 header:hover 频道');
    const i18n = readRoot('src/renderer/i18n.js');
    assert.ok(i18n.includes('`共 ${total} 条 · 上次复制 ${rel}`'), '中文辅助行文案');
    assert.ok(i18n.includes('`${total} items · last copy ${rel}`'), '英文辅助行文案');
  });

  test('D6 edge-detector 接线：收起/拖拽/动画期悬挂防护（任务书第 3 项锚定）', () => {
    const ed = readRoot('src/main/edge-detector.js');
    // 收起瞬间悬挂：滑出中（_isHiding）与不可见期不再喂状态机，避免收起动画期间
    // 光标恰在 header 带上导致误展开/IPC 抖动
    assert.ok(/isWindowVisible && !this\._isHiding/.test(ed),
      'hover 判定仅在可见且非滑出中执行（_isHiding 悬挂防护）');
    assert.ok(/_showAnimationId\) return/.test(ed),
      '滑入动画期间同样跳过判定（弹出抑制与动画互斥）');
    // 拖拽中：约束 4「拖拽开始即冻结」——轮询整体跳过，状态机不喂入
    assert.ok(/_isDragging \|\| this\._isHiding \|\| this\._showAnimationId\) return/.test(ed),
      '拖拽/滑出/滑入期间轮询整体冻结');
  });
  test('D7 edge-detector 接线六要素 + main.js 强制展开/重建标记/snap 桥', () => {
    const ed = readRoot('src/main/edge-detector.js');
    assert.ok(ed.includes('this._headerHeight = HEADER_REST_HEIGHT'), '触发条高度常量 32 起步（约束 2）');
    assert.ok(/clampHeaderHeight\(/.test(ed), '滑出实测走钳制（min(h,44)）');
    assert.ok(ed.includes('this._headerHover.markShown()'), '弹出抑制 400ms 覆盖所有弹出路径');
    assert.ok(ed.includes('this._headerHover.reset()'), '滑出复位状态机');
    assert.ok(ed.includes("send('header:hover'"), '状态翻转才走 IPC');
    assert.ok(ed.includes('__clipSenseHeaderSnap'), '滑出通知渲染层 snap');
    assert.ok(/isWindowVisible && !this\._isHiding/.test(ed), '仅可见且非滑出中判定（收起瞬间悬挂防护）');
    const mj = readRoot('src/renderer/main.js');
    assert.ok(mj.includes('window.__clipSenseHeaderSnap'), '渲染层 snap 桥落盘');
    assert.ok(mj.includes('const force = searchOpen;'), '强制展开汇总：搜索（菜单已取消，单一来源）');
    // 2026-09-30 菜单取消：强制展开汇总仅剩搜索一路（菜单迁托盘）
    assert.ok(!mj.includes('dropdownMenu'), 'dropdownMenu 引用已清（迁托盘）');
    const marks = (mj.match(/markListRebuilt\(\)/g) || []).length;
    assert.ok(marks >= 3, `markListRebuilt 调用点 ${marks} ≥ 3（refresh/搜索收起/两处重建点）`);
    const syncs = (mj.match(/syncHeaderExpanded\(\)/g) || []).length;
    assert.ok(syncs >= 6, `syncHeaderExpanded 调用点 ${syncs} ≥ 6（数据/搜索/菜单联动）`);
  });
});


// ==================== E. D-2 修复验证（2026-09-28 拖拽恢复缓冲） ====================

describe('E. D-2 修复验证：拖拽结束 200ms 恢复缓冲（设计稿 §约束 4）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('edge-detector：drag-end 设 _dragResumeAt；轮询判定带恢复门禁；常量 200ms 单一来源', () => {
    const src = readRoot('src/main/edge-detector.js');
    assert.match(src, /this\._dragResumeAt = Date\.now\(\) \+ HEADER_DRAG_RESUME_MS/,
      'drag-end 设置恢复时点');
    assert.match(src, /Date\.now\(\) >= \(this\._dragResumeAt \|\| 0\)/,
      '轮询判定带恢复门禁（缓冲期内冻结）');
    const hh = readRoot('src/main/header-hover.js');
    assert.match(hh, /HEADER_DRAG_RESUME_MS = 200/, '缓冲常量 200ms（设计稿口径）');
    assert.match(src, /HEADER_DRAG_RESUME_MS/, 'edge-detector 引用常量而非字面量');
  });
});

// ==================== F. 窗口透明度渲染层迁移（2026-09-30：悬停 item 恢复 100%） ====================

describe('F. 窗口透明度渲染层迁移（CSS alpha 替代原生 setOpacity）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('F1 edge-detector：推送 window:opacity 而非原生 setOpacity（子元素需能超越窗口透明度）', () => {
    const ed = readRoot('src/main/edge-detector.js');
    assert.ok(ed.includes("webContents.send('window:opacity'"), '推送透明度 IPC');
    assert.ok(!ed.includes('.setOpacity('), '不再整窗缩放（子元素无法超越）');
  });

  test('F2 preload/main：onWindowOpacity 桥 + --win-alpha 变量写入（旧桩静默降级）', () => {
    const preload = readRoot('src/renderer/preload.js');
    assert.ok(preload.includes("on('window:opacity'"), 'preload 订阅 window:opacity');
    const main = readRoot('src/renderer/main.js');
    assert.match(main, /onWindowOpacity/, '渲染层订阅存在');
    assert.match(main, /--win-alpha/, '写入 --win-alpha 变量');
  });

  test('F3 main.css：#app 半透明底 + .item 随窗衰减 + 悬停恢复 100%', () => {
    const css = readRoot('src/renderer/main.css');
    assert.match(css, /--win-alpha:\s*1/, '变量默认不透明');
    const appBlock = css.match(/#app\s*\{[^}]*\}/);
    assert.ok(appBlock && /rgba\(30,\s*30,\s*35,\s*var\(--win-alpha/.test(appBlock[0]), '#app 背景消费 --win-alpha');
    const itemBlock = css.match(/\.item\s*\{[^}]*\}/);
    assert.ok(itemBlock && /opacity:\s*var\(--win-alpha/.test(itemBlock[0]), '.item 随窗口衰减');
    const hoverBlock = css.match(/\.item:hover\s*\{[^}]*\}/);
    assert.ok(hoverBlock && /opacity:\s*1/.test(hoverBlock[0]), '悬停 item 恢复 100%');
    const headerBlock2 = css.match(/\.header\s*\{[^}]*\}/);
    assert.ok(headerBlock2 && /rgba\(108,\s*92,\s*231,\s*var\(--win-alpha/.test(headerBlock2[0]), 'header 渐变消费 --win-alpha');
    assert.ok(/rgba\(42,\s*42,\s*50,\s*0\.25\)/.test(css), 'hint 固定低 alpha（#app 已承载 win-alpha，不得二次乘算）');
    assert.ok(!/calc\(0\.96\s*\*\s*var\(--win-alpha/.test(css), '禁止双层叠加（回归防护）');
  });
});

// ==================== G. 贴边动画 gate 可见性源迁移（2026-09-30 根因修复） ====================

describe('G. 贴边动画 gate 可见性源迁移（backgroundThrottling:false 下 visibilityState 失灵）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('G1 edge-detector：可见性回调注册 + 两个状态写点均触发通知', () => {
    const ed = readRoot('src/main/edge-detector.js');
    assert.match(ed, /setOnVisibilityChanged\(callback\)/, '回调注册方法存在');
    assert.match(ed, /this\._onWindowVisibilityChanged\(true\)/, '滑出写点通知 false→true');
    assert.match(ed, /this\._onWindowVisibilityChanged\(false\)/, '收起写点通知 true→false');
  });

  test('G2 index.js：可见性变化推送 window:visibility 频道', () => {
    const main = readRoot('src/main/index.js');
    assert.match(main, /setOnVisibilityChanged/, '主进程已注册回调');
    assert.match(main, /send\('window:visibility'/, '推送频道存在');
  });

  test('G3 渲染层：贴边 gate 改用主进程权威可见性（不再依赖 visibilityState）', () => {
    const main = readRoot('src/renderer/main.js');
    assert.match(main, /let winVisibleFromMain = true/, '权威状态变量存在');
    assert.match(main, /visibility: \(\) => \(winVisibleFromMain \? 'visible' : 'hidden'\)/, 'entryAnim gate 消费权威状态（字符串语义与 visibilityState 同构）');
    assert.match(main, /onWindowVisibility/, '订阅权威信号');
    assert.match(main, /entryAnim\.playPending\(listEl\)/, '重显时贴边补播');
  });

  test('G4 preload：onWindowVisibility 桥', () => {
    const preload = readRoot('src/renderer/preload.js');
    assert.match(preload, /onWindowVisibility/, '桥接存在');
    assert.match(preload, /'window:visibility'/, '频道一致');
  });
});


// ==================== H. footer 压缩（2026-09-30：statCount/tagFilter 两行太高） ====================

describe('H. footer 压缩（statCount/tagFilter 行高）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('H1 footer：gap 2 / padding 4 / tag-filter min-height 22（压缩档锚定）', () => {
    const css = readRoot('src/renderer/main.css');
    const footerBlock = css.match(/\.footer\s*\{[^}]*\}/);
    assert.ok(footerBlock && /gap:\s*2px/.test(footerBlock[0]), 'footer gap 2px');
    assert.ok(footerBlock && /padding:\s*4px\s+12px/.test(footerBlock[0]), 'footer padding 4px 12px');
    const tf = css.match(/\.tag-filter\s*\{[^}]*\}/);
    assert.ok(tf && /min-height:\s*22px/.test(tf[0]), 'tag-filter min-height 22px');
  });
});

// ==================== I. 透明度覆盖收敛（2026-09-30：footer/backtop 消费 --win-alpha + 计数唯一化） ====================

describe('I. 透明度覆盖收敛（footer/backtop/计数唯一位）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('I1 footer 背景消费 --win-alpha（bg2 RGB + 变量 alpha，无实色残留）', () => {
    const css = readRoot('src/renderer/main.css');
    const footerBlock = css.match(/\.footer\s*\{[^}]*\}/);
    assert.ok(footerBlock, '.footer 规则存在');
    assert.ok(
      /background:\s*rgba\(\s*42,\s*42,\s*50,\s*var\(--win-alpha,\s*1\)\)/.test(footerBlock[0]),
      'footer background = rgba(42,42,50,var(--win-alpha,1))'
    );
    assert.ok(!/background:\s*var\(--bg2\)/.test(footerBlock[0]), '无实色 --bg2 背景残留');
  });

  test('I2 index.html 无 footer-main/statCount/stats 容器残留，tag-filter 保留原地', () => {
    const html = readRoot('src/renderer/index.html');
    assert.ok(!html.includes('footer-main'), '无 footer-main 残留');
    assert.ok(!html.includes('statCount'), '无 statCount 残留');
    assert.ok(!/class="stats"/.test(html), '无 .stats 容器残留');
    assert.ok(html.includes('id="tagFilter"'), 'tag-filter 保留原地');
  });

  test('I3 main.js 无 statCount 引用（声明+两处赋值同步删除，防 null TypeError）；headerMeta 更新保留', () => {
    const js = readRoot('src/renderer/main.js');
    assert.ok(!js.includes('statCount'), 'main.js 无 statCount 残留');
    const updateStats = js.match(/function updateStats\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(updateStats, 'updateStats 函数体可提取');
    assert.ok(updateStats[0].includes("getElementById('headerMeta')"), 'headerMeta 更新保留');
  });

  test('I4 backtop 背景/border 消费 --win-alpha（calc 乘算，0.85/0.4 基调不变）', () => {
    const css = readRoot('src/renderer/main.css');
    const btn = css.match(/\.back-top-btn\s*\{[^}]*\}/);
    assert.ok(btn, '.back-top-btn 规则存在');
    assert.ok(
      /background:\s*rgba\(\s*108,\s*92,\s*231,\s*calc\(0\.85\s*\*\s*var\(--win-alpha,\s*1\)\)\)/.test(btn[0]),
      'background = rgba(108,92,231,calc(0.85 * --win-alpha))'
    );
    assert.ok(
      /border:\s*1px solid rgba\(\s*162,\s*155,\s*254,\s*calc\(0\.4\s*\*\s*var\(--win-alpha,\s*1\)\)\)/.test(btn[0]),
      'border = rgba(162,155,254,calc(0.4 * --win-alpha))'
    );
    assert.ok(!/rgba\(108,\s*92,\s*231,\s*0\.85\)/.test(btn[0]), '无固定 alpha 旧值残留');
  });

  test('I5 backtop hover 态消费 --win-alpha（accent-hover 实色改变量 alpha）', () => {
    const css = readRoot('src/renderer/main.css');
    const hover = css.match(/\.back-top-btn:hover\s*\{[^}]*\}/);
    assert.ok(hover, ':hover 规则存在');
    assert.ok(
      /background:\s*rgba\(\s*162,\s*155,\s*254,\s*var\(--win-alpha,\s*1\)\)/.test(hover[0]),
      'hover background = rgba(162,155,254,var(--win-alpha,1))'
    );
    assert.ok(!/var\(--accent-hover\)/.test(hover[0]), '无实色 --accent-hover 残留');
  });
});
