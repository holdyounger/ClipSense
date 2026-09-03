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

function timeStr(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // 非今天的条目带日期：昨天 10 点和今天 10 点不能看着一样（2026-09-03 用户反馈）
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return isToday ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}

function flashItem(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 300);
}

/**
 * 按搜索词过滤历史
 */
function filterHistory(history) {
  const q = searchQuery.toLowerCase().trim();
  if (!q) return history;
  return history.filter(item => {
    const text = (item.text || item.preview || item.name || '').toLowerCase();
    return text.includes(q);
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

// ========== 窗口拖拽 ==========
// 使用 CSS -webkit-app-region: drag 原生拖拽（同步 KeySense），
// 由 Electron 系统原生管理窗口位置/尺寸，不会出现 JS 手动 setPosition 的漂移变大问题。
// 无需 JS 手动 mousedown/mousemove 拖拽。

refresh();
