/**
 * i18n.js - 轻量国际化字典（零依赖）
 *
 * 支持语言：zh-CN（默认）、en
 * 自动检测 navigator.language，也可手动切换。
 */

const I18N = {
  'zh-CN': {
    title: 'ClipSense',
    hintHtml: '现在复制任意文本（Ctrl+C），会自动出现在下方列表<br><small>全局快捷键 <kbd>Ctrl+Shift+V</kbd> 唤出窗口</small>',
    hintSmallHtml: '<small>全局快捷键 <kbd>Ctrl+Shift+V</kbd> 唤出窗口</small>',
    empty: '暂无剪贴板历史',
    copy: '复制',
    expand: '展开',
    collapse: '收起',
    chars: (n) => `${n} 字符`,
    image: '图片',
    file: '文件',
    richText: '富文本',
    menuLang: '切换语言 (EN)',
    menuClear: '清空历史',
    searchPlaceholder: '搜索...',
    statCount: (n) => `${n} 项`,
    statFiltered: (shown, total) => `${shown} / ${total} 项`,
  },
  en: {
    title: 'ClipSense',
    hintHtml: 'Copy any text (Ctrl+C) and it will appear below<br><small>Global shortcut <kbd>Ctrl+Shift+V</kbd> toggles the window</small>',
    hintSmallHtml: '<small>Global shortcut <kbd>Ctrl+Shift+V</kbd> toggles the window</small>',
    empty: 'No clipboard history yet',
    copy: 'Copy',
    expand: 'Expand',
    collapse: 'Collapse',
    chars: (n) => `${n} chars`,
    image: 'Image',
    file: 'File',
    richText: 'Rich text',
    menuLang: 'Switch language (中文)',
    menuClear: 'Clear history',
    searchPlaceholder: 'Search...',
    statCount: (n) => `${n} items`,
    statFiltered: (shown, total) => `${shown} / ${total} items`,
  },
};

let currentLang = 'zh-CN';

/** 本地存储 key（持久化语言偏好） */
const LANG_STORAGE_KEY = 'clipboard-spike-lang';

/**
 * 检测语言：优先 navigator.language，非中文则用 en
 */
function detectLang() {
  const nav = (navigator.language || 'zh-CN').toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  return 'en';
}

/**
 * 从本地存储读取已保存的语言偏好
 * @returns {string|null}
 */
function loadSavedLang() {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && I18N[saved]) return saved;
  } catch (err) {
    // localStorage 不可用时静默降级
  }
  return null;
}

/**
 * 初始化语言（持久化优先，否则自动检测）
 */
function initLang() {
  const saved = loadSavedLang();
  currentLang = saved || detectLang();
}

/**
 * 取文案（key 支持函数类型）
 */
function t(key, ...args) {
  const dict = I18N[currentLang] || I18N['zh-CN'];
  const val = dict[key];
  if (typeof val === 'function') return val(...args);
  return val;
}

/**
 * 切换语言（持久化 + 返回新语言）
 */
function setLang(lang) {
  if (I18N[lang]) currentLang = lang;
  // 持久化
  try {
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch (err) {
    // 忽略存储失败
  }
  return currentLang;
}

/**
 * 获取当前语言
 */
function getLang() {
  return currentLang;
}

if (typeof window !== 'undefined') {
  window.I18N = { I18N, t, setLang, getLang, initLang, detectLang };
}
