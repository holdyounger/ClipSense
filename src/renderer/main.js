/**
 * main.js - 渲染进程逻辑
 *
 * 只负责：数据获取、交互接入、窗口/倒计时/拖拽/固定等 UI 状态。
 * 列表的 DOM 构建委托给 renderer.js（类型化渲染，支持扩展多内容类型）。
 */
const listEl = document.getElementById('list');
const clearBtn = document.getElementById('clearBtn');
const langBtn = document.getElementById('langBtn');
const pinBtn = document.getElementById('pinBtn');

let isPinned = false;
let countdownInterval = null;

// 初始化国际化
initLang();
applyStaticText();

/**
 * 应用静态文案（标题、清空按钮、提示、空状态等）
 */
function applyStaticText() {
  const titleEl = document.getElementById('title');
  const hintEl = document.getElementById('hint');
  const clearBtn = document.getElementById('clearBtn');

  titleEl.textContent = t('title');
  hintEl.innerHTML = t('hintHtml');
  clearBtn.textContent = t('clear');
  clearBtn.title = t('clearTitle');

  // 语言切换按钮文案：显示"目标语言"
  langBtn.textContent = getLang() === 'zh-CN' ? 'EN' : '中文';
  langBtn.title = getLang() === 'zh-CN' ? 'Switch to English' : '切换为中文';

  // 空状态（如果当前是空列表）
  if (listEl.querySelector('.empty')) {
    refresh();
  }
}

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
  onRemove: async (item) => {
    await window.clipboardAPI.removeItem(item.id);
    await refresh();
  },
};

function timeStr(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function flashItem(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 300);
}

async function refresh() {
  const history = await window.clipboardAPI.getHistory();
  renderHistory(listEl, history, renderHandlers, renderCtx);
}

clearBtn.addEventListener('click', async () => {
  await window.clipboardAPI.clearHistory();
  await refresh();
});

// 语言切换
langBtn.addEventListener('click', () => {
  const next = getLang() === 'zh-CN' ? 'en' : 'zh-CN';
  setLang(next);
  applyStaticText();
  refresh(); // 重新渲染列表文案（时间/字符数等）
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
  renderHistory(listEl, history, renderHandlers, renderCtx);
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
