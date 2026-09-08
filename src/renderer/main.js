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
  const q = searchQuery.toLowerCase().trim();
  if (!q) return history;

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

  return history.filter(item => {
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

async function refresh() {
  fullHistory = await window.clipboardAPI.getHistory();
  const shown = filterHistory(fullHistory);
  renderHistory(listEl, shown, renderHandlers, renderCtx);
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

// ========== 搜索 ==========
// 主窗口默认 focusable:false；用户点击搜索框时按需开启焦点。
searchInput.addEventListener('pointerdown', () => {
  window.clipboardAPI.focusSearch();
});

// 失焦时通知主进程关回 focusable，双击粘贴不再依赖 simulate-input 里的补救。
searchInput.addEventListener('blur', () => {
  window.clipboardAPI.blurSearch();
  // 搜索结束：恢复自动隐藏（若鼠标仍在外则立即走正常倒计时）
  window.clipboardAPI.setSearchActive(false);
});

// 聚焦/输入期间挂起自动隐藏：用户正在打字，鼠标移出不应隐藏面板（18:42）
searchInput.addEventListener('focus', () => {
  window.clipboardAPI.setSearchActive(true);
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  const shown = filterHistory(fullHistory);
  renderHistory(listEl, shown, renderHandlers, renderCtx);
  updateStats();
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
  updateStats();
});

// ========== 倒计时显示（同步 KeySense） ==========
const countdownBadge = document.getElementById('countdownBadge');
const countdownNumber = document.getElementById('countdownNumber');

function handleCountdownUpdate(data) {
  const isCountingDown = data.isCountingDown;
  const remaining = data.remainingMs;

  if (isCountingDown && remaining !== null && remaining > 0) {
    countdownBadge.classList.add('visible');
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
  countdownNumber.textContent = Math.max(0, Math.ceil(remainingMs / 1000));
}

function hideCountdown() {
  countdownBadge.classList.remove('visible');
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

refresh();
