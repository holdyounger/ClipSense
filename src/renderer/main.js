/**
 * main.js - 渲染进程逻辑
 *
 * 只负责：数据获取、交互接入、窗口/倒计时/拖拽/固定等 UI 状态。
 * 列表的 DOM 构建委托给 renderer.js（类型化渲染，支持扩展多内容类型）。
 */
const listEl = document.getElementById('list');
const pinBtn = document.getElementById('pinBtn');
const menuBtn = document.getElementById('menuBtn');
const dropdownMenu = document.getElementById('dropdownMenu');
const menuLangBtn = document.getElementById('menuLangBtn');
const menuClearBtn = document.getElementById('menuClearBtn');
const searchInput = document.getElementById('searchInput');
const statCount = document.getElementById('statCount');
const hintEl = document.getElementById('hint');
const backTopBtn = document.getElementById('backTopBtn');

let isPinned = false;
let countdownInterval = null;
let searchQuery = '';
let fullHistory = []; // 完整历史（未过滤）

// ========== 自动打标签（2026-09-09） ==========
const tagFilterEl = document.getElementById('tagFilter');
// 标签展示顺序（与 src/common/tag-utils.js 的 TAG_PRIORITY 保持一致，v2 12 类）
const TAG_ORDER = [
  'sensitive', 'vuln', 'otp', 'cmd', 'stack', 'config',
  'ip', 'hash', 'link', 'email', 'snippet', 'path',
];
let activeTagFilter = null; // null | tagId；窗口隐藏不销毁页面，visibilitychange 时显式重置
let tagSettings = null;     // 最近一次 { enabled, tags }；null = 尚未拉取（全部视为可用，降级开放）

// 初始化国际化
initLang();
applyStaticText();

/**
 * 应用静态文案（标题、提示、空状态、下拉菜单等）
 */
function applyStaticText() {
  const titleEl = document.getElementById('title');

  titleEl.textContent = t('title');
  hintEl.classList.remove('hint--compact');
  hintEl.innerHTML = t('hintHtml');

  // 设置为不可选中，避免误触发选中状态
  hintEl.style.userSelect = 'none';
  hintEl.style.MozUserSelect = 'none';

  // 下拉菜单文案
  menuLangBtn.textContent = t('menuLang');
  menuClearBtn.textContent = t('menuClear');
  searchInput.placeholder = t('searchPlaceholder');
  // 搜索入口 tooltip（经 getElementById 取用：applyStaticText 在脚本顶部即被调用，
  // 此时下方搜索区的 const searchBtn 尚在 TDZ，不能直接引用）
  const searchBtnEl = document.getElementById('searchBtn');
  if (searchBtnEl) searchBtnEl.title = t('searchBtn');
  backTopBtn.title = t('backTop');
  backTopBtn.setAttribute('aria-label', t('backTop'));

  // 空状态（如果当前是空列表）
  if (listEl.querySelector('.empty')) {
    refresh();
  }
  updateStats();
}

// 提示条默认收起；鼠标移入时展开，移出后恢复为可触碰的细条。
// 快速划过不展开：mouseenter 后延迟判定，只有鼠标真正停留才展开；
// 停留不够就划走则取消展开，不会闪。
const HINT_EXPAND_DELAY_MS = 150;  // 鼠标停留超过此时长才展开
const HINT_COLLAPSE_DELAY_MS = 200; // 移出后延迟收起，避免边缘抖动
let hintExpandTimer = null;
let hintCollapseTimer = null;

function expandHint() {
  hintEl.classList.remove('hint--compact');
  hintEl.innerHTML = t('hintHtml');
}

function collapseHint() {
  hintEl.classList.add('hint--compact');
  hintEl.innerHTML = t('hintSmallHtml');
}

hintEl.addEventListener('mouseenter', () => {
  if (hintCollapseTimer) {
    clearTimeout(hintCollapseTimer);
    hintCollapseTimer = null;
  }
  // 已展开则无需动作；正在等待展开则保持。
  if (!hintEl.classList.contains('hint--compact')) return;
  if (hintExpandTimer) return;
  hintExpandTimer = setTimeout(() => {
    hintExpandTimer = null;
    expandHint();
  }, HINT_EXPAND_DELAY_MS);
});

hintEl.addEventListener('mouseleave', () => {
  // 划走时取消待展开：停留不够则根本不展开。
  if (hintExpandTimer) {
    clearTimeout(hintExpandTimer);
    hintExpandTimer = null;
  }
  if (hintCollapseTimer) clearTimeout(hintCollapseTimer);
  // 只有当前是展开状态才需要延迟收起；未展开（被取消了）则什么都不做。
  if (hintEl.classList.contains('hint--compact')) return;
  hintCollapseTimer = setTimeout(collapseHint, HINT_COLLAPSE_DELAY_MS);
});

// ========== 渲染上下文与事件手柄（交给 renderer.js） ==========
const renderCtx = {
  t,
  timeStr,
  flashItem,
  enabledTags: null, // Set<tagId> | null（null = 全部可用）；由 applyTagSettings 维护
};

const renderHandlers = {
  onCopy: async (item, el) => {
    const res = await window.clipboardAPI.copyItem(item.id);
    if (res.ok) {
      flashItem(el);
    }
  },
  onSimulateInput: async (item, el) => {
    const res = await window.clipboardAPI.simulateInput(item.id);
    if (res.ok) {
      flashItem(el);
      return;
    }
    console.warn(`[Spike] 模拟输入未执行: ${res.error}`);
  },
  onRemove: async (item) => {
    await window.clipboardAPI.removeItem(item.id);
    await refresh();
  },
};

const pad2 = n => String(n).padStart(2, '0');

function timeStr(ts) {
  const d = new Date(ts);
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  // 非今天的条目带日期：昨天 10 点和今天 10 点不能看着一样（2026-09-03 用户反馈）
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return isToday ? hms : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hms}`;
}

function flashItem(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 300);
}

/**
 * 解析日期查询片段（搜索用）。
 * 支持：今天/昨天（含英文 today/yesterday）、YYYY-MM-DD、MM-DD、YYYY。
 * 返回 { key: 'y-mm-dd' } 按自然日过滤，或 { year } 按年过滤，null = 不可识别。
 */
function parseDateQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  const now = new Date();
  const dayKey = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

  const lower = q.toLowerCase();
  if (q === '今天' || lower === 'today') {
    return { key: dayKey(now.getFullYear(), now.getMonth() + 1, now.getDate()) };
  }
  if (q === '昨天' || lower === 'yesterday') {
    const yd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { key: dayKey(yd.getFullYear(), yd.getMonth() + 1, yd.getDate()) };
  }
  let m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { key: dayKey(+m[1], +m[2], +m[3]) };
  m = q.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return { key: dayKey(now.getFullYear(), +m[1], +m[2]) };
  m = q.match(/^(\d{4})$/);
  if (m) return { year: +m[1] };
  return null;
}

/** 条目入库时间的自然日 key（与 parseDateQuery 返回的 key 同构） */
function itemDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 按搜索词过滤历史：
 * 1) `date:` 前缀 → 第一个词必须是日期（今天/昨天/YY-MM-DD/YYYY-MM-DD/YYYY），
 *    不是日期 → 无匹配；是日期 → 剩余词继续内容过滤（可组合：date:昨天 评审、
 *    date:今天 10:30 —— 内容不含时附带匹配入库时间串，实现按时间定位）
 * 2) 输入整体是日期串（YYYY-MM-DD / MM-DD）→ 自动按日期过滤
 * 3) 其余按内容文本匹配
 */
function filterHistory(history) {
  let list = history;
  // 标签筛选（前置交集）：标签 ∩ 搜索子串 ∩ date:（2026-09-09 自动打标签）
  if (activeTagFilter) {
    list = list.filter(item => Array.isArray(item.tags) && item.tags.includes(activeTagFilter));
  }
  const q = searchQuery.toLowerCase().trim();
  if (!q) return list;

  let dateCond = null;
  let textQ = q;

  if (q.startsWith('date:')) {
    const rest = q.slice(5).trim();
    const firstToken = rest.split(/\s+/)[0] || '';
    const dateParsed = parseDateQuery(firstToken);
    // date: 模式必须日期开头，非日期 = 无匹配（2026-09-03 用户定）
    if (!dateParsed) return [];
    dateCond = dateParsed;
    // 剩余词作为内容过滤（可为空 = 只按日期）
    textQ = rest.slice(firstToken.length).trim();
  } else if (/^(\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})$/.test(q)) {
    dateCond = parseDateQuery(q);
    textQ = '';
  }

  return list.filter(item => {
    if (dateCond) {
      if (dateCond.key) {
        if (itemDayKey(item.timestamp) !== dateCond.key) return false;
      } else if (new Date(item.timestamp).getFullYear() !== dateCond.year) {
        return false;
      }
    }
    if (!textQ) return true;
    const text = (item.text || item.preview || item.name || '').toLowerCase();
    if (text.includes(textQ)) return true;
    // 内容未命中 → 尝试入库时间文本（YYYY-MM-DD HH:MM:SS），支持按时间定位条目
    const d = new Date(item.timestamp);
    const fullTime = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    return fullTime.includes(textQ);
  });
}

/**
 * 更新底部统计（总数 + 过滤后数量）
 */
function updateStats() {
  const total = fullHistory.length;
  const shown = filterHistory(fullHistory).length;
  if (searchQuery.trim()) {
    statCount.textContent = t('statFiltered', shown, total);
  } else {
    statCount.textContent = t('statCount', total);
  }
}

// ========== 自动打标签：筛选条与设置（2026-09-09） ==========

/**
 * 计算当前启用的标签集合
 * @returns {Set<string>|null} null = 设置未拉取，降级视为全部可用
 */
function computeEnabledTagIds() {
  if (!tagSettings) return null;
  if (tagSettings.enabled === false) return new Set();
  const tags = tagSettings.tags || {};
  const enabled = new Set();
  for (const id of TAG_ORDER) {
    if (tags[id] !== false) enabled.add(id);
  }
  return enabled;
}

/**
 * 渲染底部标签筛选条（全量重建 + 容器委托，PROJECT.md 硬性结论）。
 * chip 集 = fullHistory 实际存在标签 ∩ enabled 设置；「全部」恒在；无 chip 时整体 hidden。
 */
function renderTagFilter() {
  if (!tagFilterEl) return;
  const present = new Set();
  for (const item of fullHistory) {
    if (Array.isArray(item.tags)) {
      for (const id of item.tags) {
        if (TAG_ORDER.includes(id)) present.add(id);
      }
    }
  }
  const enabled = computeEnabledTagIds();
  const ids = TAG_ORDER.filter(id => present.has(id) && (!enabled || enabled.has(id)));
  if (ids.length === 0) {
    tagFilterEl.hidden = true;
    tagFilterEl.innerHTML = '';
    return;
  }
  tagFilterEl.hidden = false;
  tagFilterEl.innerHTML = ''; // 全量重建
  const mkChip = (id, label) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-filter-chip' + (activeTagFilter === id ? ' active' : '');
    chip.dataset.tag = id || '';
    chip.textContent = label;
    return chip;
  };
  tagFilterEl.appendChild(mkChip(null, t('filterAll')));
  for (const id of ids) {
    tagFilterEl.appendChild(mkChip(id, t(tagI18nKey(id))));
  }
}

/**
 * 应用标签设置（启动拉取 / 托盘变更广播共用入口）：
 * 更新渲染上下文可见集 → 筛选条与列表重渲染；
 * 当前筛选的标签被禁用时自动回到「全部」。
 */
function applyTagSettings(settings) {
  tagSettings = (settings && typeof settings === 'object') ? settings : null;
  const enabled = computeEnabledTagIds();
  renderCtx.enabledTags = enabled;
  if (activeTagFilter && (!enabled || !enabled.has(activeTagFilter))) {
    activeTagFilter = null;
  }
  renderTagFilter();
  renderHistory(listEl, filterHistory(fullHistory), renderHandlers, renderCtx);
  updateStats();
}

/** 启动时拉取一次标签设置（失败降级为全部可用，不阻塞列表） */
async function initTagSettings() {
  try {
    if (!window.clipboardAPI || typeof window.clipboardAPI.getTagSettings !== 'function') return;
    const s = await window.clipboardAPI.getTagSettings();
    applyTagSettings(s);
  } catch (err) {
    console.warn('[Tags] 读取标签设置失败（按全部可用降级）:', err && err.message);
  }
}

async function refresh() {
  fullHistory = await window.clipboardAPI.getHistory();
  const shown = filterHistory(fullHistory);
  renderHistory(listEl, shown, renderHandlers, renderCtx);
  renderTagFilter();
  updateStats();
}

// ========== 下拉菜单 ==========
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  dropdownMenu.classList.toggle('open');
});

// 点击菜单外部关闭
document.addEventListener('click', (e) => {
  if (!dropdownMenu.contains(e.target) && !menuBtn.contains(e.target)) {
    dropdownMenu.classList.remove('open');
  }
});

// 菜单：切换语言
menuLangBtn.addEventListener('click', () => {
  dropdownMenu.classList.remove('open');
  const next = getLang() === 'zh-CN' ? 'en' : 'zh-CN';
  setLang(next);
  applyStaticText();
  refresh();
});

// 菜单：清空历史
menuClearBtn.addEventListener('click', async () => {
  dropdownMenu.classList.remove('open');
  await window.clipboardAPI.clearHistory();
  await refresh();
});

// ========== 搜索（2026-09-10 体验优化：入口上移 header，图标点击展开） ==========
// 主窗口默认 focusable:false（src/main/index.js 零改动）；键盘输入只在 focus-search
// IPC 之后到达渲染层，自动隐藏联动复用 focusSearch / blurSearch / setSearchActive 链路。
//
// 状态机：收起态（输入框 0 宽不可达）⇄ 展开态（输入框 flex 占满 header 中部，
// title/倒计时徽标让位，main.css .header.search-open）。
//
// 收起即清词（拍板 #2 统一规则）：输入框 blur / 点击 header 外区域 / Esc / 再点图标——
// 任何收起路径一律 searchQuery='' + input.value='' + refresh()，列表回到未过滤态，
// 杜绝「列表被过滤但看不到搜索框」的隐形过滤不一致。不隐藏窗口。
const headerEl = document.getElementById('header');
const searchBtn = document.getElementById('searchBtn');
let searchOpen = false; // header 搜索展开态

/** 光标移到输入框末尾（Ctrl+F 语义：已有词仅重新聚焦，不清词） */
function setCursorToEnd() {
  const len = searchInput.value.length;
  if (typeof searchInput.setSelectionRange === 'function') {
    try { searchInput.setSelectionRange(len, len); } catch (_) { /* 非可编辑元素等场景忽略 */ }
  }
}

/**
 * 进入展开态。
 * @param {object} [opts]
 * @param {boolean} [opts.focus=true] 是否走 focusSearch IPC + 输入框聚焦；
 *   false = 仅视觉展开（重显自洽规则），绝不抢焦点、不触发 setSearchActive。
 */
async function openSearch({ focus = true } = {}) {
  if (!searchOpen) {
    searchOpen = true;
    headerEl.classList.add('search-open');
  }
  if (!focus) return;
  // 先等主进程 setFocusable(true)+focus() 完成，再做 DOM 聚焦（不夺焦架构的时序要求）
  try {
    await window.clipboardAPI.focusSearch();
  } catch (_) { /* IPC 异常不阻塞聚焦尝试 */ }
  // [focus-debug] 临时埋点（2026-09-10 实机 Ctrl+F/输入不响应排查：定位焦点链断点，验收后移除）
  const _aeBefore = document.activeElement;
  console.log('[focus-debug] renderer: before input.focus(), activeElement =',
    _aeBefore ? (_aeBefore.id || _aeBefore.tagName) : 'null');
  searchInput.focus();
  const _aeAfter = document.activeElement;
  console.log('[focus-debug] renderer: after input.focus(), activeElement =',
    _aeAfter ? (_aeAfter.id || _aeAfter.tagName) : 'null');
  setCursorToEnd();
}

/**
 * 收起并清词（任何收起路径统一出口；幂等，可重入）。
 * blurSearch + setSearchActive(false) 恢复自动隐藏倒计时（与主进程双保险链路一致）。
 */
function collapseSearch() {
  if (!searchOpen && searchQuery === '') return; // 幂等短路（blur 重入不再重复走 IPC）
  searchOpen = false;
  searchQuery = '';
  headerEl.classList.remove('search-open');
  searchInput.value = '';
  refresh(); // 列表回到未过滤态（async，fire-and-forget）
  // 输入框若仍持焦则主动失焦（真实 DOM：已失焦时 .blur() 不再派发 blur 事件，无重入）
  searchInput.blur();
  window.clipboardAPI.blurSearch();
  window.clipboardAPI.setSearchActive(false);
}

/**
 * Esc：展开态 = 清词+收起+恢复自动隐藏（一次完成）；未展开 = 无动作；
 * IME 组合中（e.isComposing）忽略；标签筛选态不受影响（独立维度，拍板 #1）。
 */
function handleSearchEscape(e) {
  // 仅响应 Esc（2026-09-10 实机 BUG2 根因：此函数挂在输入框 keydown 上却缺按键
  // 检查——打字的每个字母都触发清词收起。不夺焦时代按键不可达故潜伏，焦点模型
  // 回切后引爆）。keyCode 27 兼容旧派发路径。
  if (e.key !== 'Escape' && e.keyCode !== 27) return;
  if (e.isComposing) return;
  if (!searchOpen) return;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  collapseSearch();
}

// 主窗口默认 focusable:false；点击输入框时按需开启焦点（原链路保留：
// 覆盖重显自洽态下直接点输入框的场景）
searchInput.addEventListener('pointerdown', () => {
  window.clipboardAPI.focusSearch();
});

// 聚焦/输入期间挂起自动隐藏：用户正在打字，鼠标移出不应隐藏面板（18:42）
searchInput.addEventListener('focus', () => {
  window.clipboardAPI.setSearchActive(true);
});

// 失焦 → 收起即清词（collapseSearch 内部完成 blurSearch + setSearchActive(false)）。
// 例外：blur 落在搜索图标上（pointerdown preventDefault 失效时的兜底），
// 由图标 click toggle 接管，避免「blur 先收起、click 再展开」竞态。
// 失焦 → 收起即清词（collapseSearch 内部完成 blurSearch + setSearchActive(false)）。
// 例外一：blur 落在搜索图标上（pointerdown preventDefault 失效时的兑底）。
// 例外二（2026-09-10 实机 BUG2「任意输入都收起」）：IME 组合、窗口失活、
// setFocusable(true⇄false) 激活切换都会在输入框持焦期间派发 blur，但 DOM 焦点
// 实际未转移（activeElement 仍是输入框或仍在 header 内）——这类「伪 blur」不收起，
// 避免打字/输入法过程被误清词。真实焦点转移（activeElement 离开 header）才收起；
// 鼠标点击 header 外的非焦点区由 document click-outside 处理器兑底收起。
searchInput.addEventListener('blur', () => {
  if (document.activeElement === searchBtn) return;
  if (document.activeElement === searchInput) return;
  if (document.activeElement && headerEl.contains(document.activeElement)) return;
  collapseSearch();
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  const shown = filterHistory(fullHistory);
  renderHistory(listEl, shown, renderHandlers, renderCtx);
  updateStats();
});

// Esc：输入框持焦时直接接住；document 级兕底覆盖「展开但未持焦」（重显自洽态）。
// 两处都触发时，先到者已把 searchOpen 置 false，后者幂等短路，单次执行。
searchInput.addEventListener('keydown', handleSearchEscape);

// document 级键盘：
// 1) Esc 兕底（见上，未展开时 handleSearchEscape 内部直接返回，无动作）；
// 2) Ctrl+F 直达搜索——面板持键盘焦点期间生效（不夺焦架构属性：无焦点时按键物理
//    不可达属预期，落到前台应用；不做 globalShortcut，不做唤出自动聚焦）。
//    已有词时仅重新聚焦（光标到末尾），不清词。
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.keyCode === 27) handleSearchEscape(e);
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyF' && !e.isComposing) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    openSearch();
  }
});

// 搜索图标：pointerdown 阻止默认聚焦转移（避免输入框 blur 先行收起、click 再展开
// 的竞态；取消 pointerdown 不影响 click 派发）；click 做 toggle——
// 展开且持焦 = 收起（清词），否则展开/恢复主动搜索并聚焦。
searchBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
});

searchBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // 不冒泡到「header 外点击收起」逻辑
  if (searchOpen && document.activeElement === searchInput) {
    collapseSearch();
  } else {
    openSearch();
  }
});

// 面板任意处按下 → 按需启用键盘焦点（2026-09-10 实机 BUG1「Ctrl+F 不响应」修复）：
// 不夺焦架构下键盘事件只在面板持焦后可达，此前仅搜索框/图标两条路径启用——用户
// 唤出后直接按 Ctrl+F 或点击列表再按，物理不可达。现扩展为面板任意 pointerdown
// 都走 focusSearch（幂等：setFocusable(true)+focus+webContents.focus 重复调用无
// 副作用）。不夺焦承诺不变：Alt+V 唤出仍不自动聚焦，仅用户显式点击面板才启用；
// 双击粘贴由 paste-bridge 双击瞬间重抓目标前台，不受影响（实机回归项）。
document.addEventListener('pointerdown', () => {
  window.clipboardAPI.focusSearch();
});

// 点击 header 外区域收起（展开但未持焦态的主要收起路径；持焦态由 blur 先行收起，
// 此处幂等）。header 内点击（含 pin/menu/输入框/图标本身）不在此收起。
document.addEventListener('click', (e) => {
  if (!searchOpen) return;
  if (headerEl.contains(e.target)) return;
  collapseSearch();
});

// ========== 标签筛选条：容器委托点击（全量重建不丢监听） ==========
// 同 chip 再点取消回全部；条目上的 tag-chip 是纯展示 span，不参与点击。
tagFilterEl.addEventListener('click', (e) => {
  const chip = e.target && e.target.closest ? e.target.closest('.tag-filter-chip') : null;
  if (!chip || !tagFilterEl.contains(chip)) return;
  const id = chip.dataset.tag || null;
  activeTagFilter = (id && activeTagFilter !== id) ? id : null;
  renderTagFilter();
  renderHistory(listEl, filterHistory(fullHistory), renderHandlers, renderCtx);
  updateStats();
});

// ========== 筛选态重置（visibilitychange，零新 IPC） ==========
// 窗口 hide()/show() 触发 Chromium 页面可见性事件：重新可见时清空标签筛选态
// 并重渲染（边缘唤出短交互不保留筛选，PRD）。
// ⚠ Windows 实机验证点；若不触发，fallback = 主进程 show 路径推 window-shown IPC。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // 重显自洽（2026-09-10 拍板 #2 配套规则）：搜索词非空 → 搜索框自动视觉展开
  // 但不抢焦点（不调 focusSearch、不触发 setSearchActive），保证
  // 「列表过滤态与搜索框可见性」强一致；窗口隐藏不是收起路径，词保留。
  if (searchQuery.trim() !== '') {
    openSearch({ focus: false });
  }
  const had = activeTagFilter !== null;
  activeTagFilter = null;
  renderTagFilter();
  if (had) {
    renderHistory(listEl, filterHistory(fullHistory), renderHandlers, renderCtx);
    updateStats();
  }
});

// ========== 返回顶部 ==========
// 监听挂在 listEl 上（renderHistory 只重建 innerHTML，容器本身不重建，监听不丢）。
// 阈值 120px：列表 barely 滚动时不出按钮，避免和条目操作区视觉拥挤。
const BACK_TOP_THRESHOLD = 120;

listEl.addEventListener('scroll', () => {
  backTopBtn.classList.toggle('visible', listEl.scrollTop > BACK_TOP_THRESHOLD);
}, { passive: true });

backTopBtn.addEventListener('click', () => {
  listEl.scrollTo({ top: 0, behavior: 'smooth' });
});

// ========== 窗口固定 ==========
async function togglePin() {
  isPinned = !isPinned;
  updatePinUI();
  await window.clipboardAPI.setPinned(isPinned);
}

function updatePinUI() {
  if (isPinned) {
    pinBtn.classList.add('pinned');
    pinBtn.setAttribute('aria-pressed', 'true');
    pinBtn.title = getLang() === 'zh-CN' ? '已固定 · 点击取消（恢复自动隐藏）' : 'Pinned · click to unpin (resume auto-hide)';
    hideCountdown();
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  } else {
    pinBtn.classList.remove('pinned');
    pinBtn.setAttribute('aria-pressed', 'false');
    pinBtn.title = getLang() === 'zh-CN' ? '未固定 · 点击固定（保持显示）' : 'Not pinned · click to pin (keep visible)';
  }
}

pinBtn.addEventListener('click', togglePin);

window.clipboardAPI.onHistoryUpdated((history) => {
  fullHistory = history;
  const shown = filterHistory(fullHistory);
  renderHistory(listEl, shown, renderHandlers, renderCtx);
  renderTagFilter();
  updateStats();
});

// ========== 倒计时显示（方案 B：环形入固定按钮，2026-09-10） ==========
// 倒计时徽标已从 header-actions 移除（空洞根治）；倒计时改由 pinBtn 三态表达：
// .cd-running（环形进度 + 环心秒数）/ 静止（空心 icon，现状）/.pinned（实心紫+光晕，现状）。
// 主进程协议零改动：仍消费 countdown-update（isCountingDown/remainingMs）。
const pinRingProgress = document.getElementById('pinRingProgress');
const pinCdNum = document.getElementById('pinCdNum');
const PIN_RING_CIRCUMFERENCE = 75.4; // 2π×12，与 index.html 进度圆 dasharray 保持一致
let countdownTotalMs = 0; // 本次倒计时总时长（首拍记录，续期取 max；静止/固定时清零）

function handleCountdownUpdate(data) {
  const isCountingDown = data.isCountingDown;
  const remaining = data.remainingMs;

  if (isCountingDown && remaining !== null && remaining > 0) {
    // 环形比例基准：倒计时启动（或续期延长）时记录总时长，max 兜底保持比例不越界
    countdownTotalMs = Math.max(countdownTotalMs, remaining);
    updateCountdownDisplay(remaining);

    if (!countdownInterval) {
      countdownInterval = setInterval(async () => {
        const info = await window.clipboardAPI.getCountdown();
        if (!info.isCountingDown || info.remainingMs === null) {
          hideCountdown();
          clearInterval(countdownInterval);
          countdownInterval = null;
          return;
        }
        updateCountdownDisplay(info.remainingMs);
      }, 200);
    }
  } else {
    hideCountdown();
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }
}

function updateCountdownDisplay(remainingMs) {
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  pinCdNum.textContent = String(secs); // 环心秒数
  // 环形进度：dashoffset = 周长 × (1 − 剩余比例)，从 12 点顺时针消退（rotate(-90) 固化在 SVG 属性）
  if (pinRingProgress && countdownTotalMs > 0) {
    const ratio = Math.min(1, Math.max(0, remainingMs / countdownTotalMs));
    pinRingProgress.style.strokeDashoffset = (PIN_RING_CIRCUMFERENCE * (1 - ratio)).toFixed(2);
  }
  // 三态 + 紧迫感分级：≤10s .cd-warn；≤5s .cd-urgent（隐含 warn，CSS 里只改脉冲时长）
  pinBtn.classList.add('cd-running');
  pinBtn.classList.toggle('cd-warn', secs <= 10);
  pinBtn.classList.toggle('cd-urgent', secs <= 5);
}

function hideCountdown() {
  // 回到静止/已固定图标态：清理环形三态类并复位进度环
  pinBtn.classList.remove('cd-running', 'cd-warn', 'cd-urgent');
  countdownTotalMs = 0;
  if (pinRingProgress) pinRingProgress.style.strokeDashoffset = '0';
}

window.clipboardAPI.onCountdownUpdate(handleCountdownUpdate);

// ========== 鼠标进入/离开上报（用于自动隐藏） ==========
// 快速划过 hintEl 时倒计时徽章闪现的修复在主进程：
// EdgeDetector.onMouseLeaveDebounced() 对 mouse-leave 加 120ms 防抖，
// 轮询纠偏（isOverPanel=true）或 mouse-enter 都会取消待执行的倒计时。
// 注：mouseenter/mouseleave 本身不冒泡，无需 stopPropagation。
const appEl = document.getElementById('app');
appEl.addEventListener('mouseenter', () => {
  window.clipboardAPI.mouseEnter();
});
appEl.addEventListener('mouseleave', () => {
  window.clipboardAPI.mouseLeave();
});

// ========== 命中偏移诊断（2026-09-08，定位后可移除） ==========
// 目的：对比「渲染层认为的光标位置」与「OS 实际光标位置」，
// delta 非零 = 输入坐标换算错位（DPI/child hwnd/命中缓存类问题）。
let _diagLast = 0;
document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - _diagLast < 400) return;
  _diagLast = now;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  window.clipboardAPI.diagHit({
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    winScreenX: window.screenX,
    winScreenY: window.screenY,
    dpr: window.devicePixelRatio,
    el: el ? `${el.tagName}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}` : 'null',
  });
}, { passive: true });

// ========== 窗口拖拽 ==========
// 使用 CSS -webkit-app-region: drag 原生拖拽（同步 KeySense），
// 由 Electron 系统原生管理窗口位置/尺寸，不会出现 JS 手动 setPosition 的漂移变大问题。
// 无需 JS 手动 mousedown/mousemove 拖拽。

// 自动打标签：启动拉取设置 + 订阅变更（托盘开关下发），随后首刷列表
initTagSettings();
if (window.clipboardAPI && window.clipboardAPI.onTagSettingsUpdated) {
  window.clipboardAPI.onTagSettingsUpdated((s) => applyTagSettings(s));
}

refresh();
