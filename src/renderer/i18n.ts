/**
 * i18n.ts - 轻量国际化字典（零依赖）
 *
 * 支持语言：zh-CN（默认）、en
 * 自动检测 navigator.language，也可手动切换。
 *
 * TS 迁移（2026-10-09，第三批）：脚本风格 TS（无 export/import——渲染层经典
 * script 加载依赖顶层 function/const 挂全局，main.js 直接引用 t/I18N 等）；
 * 守卫式 window.I18N 挂载与 .js 版同构；字典值类型 string | 格式化函数。
 */
'use strict';

/** 字典值类型：纯文案 string 或格式化函数（参数即插值） */
type I18nValue = string | ((...args: never[]) => string);

/** 单语言字典（key 集合两表严格一致；新增 key 时中英同步） */
type I18nDict = Record<string, I18nValue>;

/** 支持的语言代码 */
type LangCode = 'zh-CN' | 'en';

const I18N: Record<LangCode, I18nDict> = {
  'zh-CN': {
    title: 'ClipSense',
    hintHtml: '现在复制任意文本（Ctrl+C），会自动出现在下方列表<br><small>全局快捷键 <kbd>Alt+V</kbd> 唤出窗口</small>',
    hintSmallHtml: '<small>全局快捷键 <kbd>Alt+V</kbd> 唤出窗口</small>',
    empty: '暂无剪贴板历史',
    copy: '复制',
    copyPath: '复制路径',
    openPath: '打开路径',
    menuUpToDate: '当前已是最新版本',
    timesCopied: '此内容已复制 {n} 次',
    expand: '展开',
    collapse: '收起',
    chars: (n: number) => `${n} 字符` as string,
    image: '图片',
    file: '文件',
    richText: '富文本',
    menuLang: '切换语言 (EN)',
    menuClear: '清空历史',
    // 轻量升级链路（2026-09-20）
    menuCheckUpdate: '检查更新',
    updateChecking: '检查中…',
    updateUpToDate: '已是最新版本',
    updateUpToDateTip: (v: string) => `已是最新版本 v${v}` as string,
    updateDownloadBtn: (v: string) => `下载升级 v${v}` as string,
    updateDownloading: (p: number) => `下载中 ${p}%` as string,
    updateDownloadFailed: '下载失败，点击重试',
    updateNoAsset: '安装包尚未发布',
    today: '今天',
    yesterday: '昨天',
    backTop: '返回顶部',
    searchPlaceholder: '搜索 内容或日期（date:昨天）...',
    searchBtn: '搜索',
    statCount: (n: number) => `${n} 项` as string,
    statFiltered: (shown: number, total: number) => `${shown} / ${total} 项` as string,
    // 自动打标签（2026-09-09）：标签名与筛选条文案
    tagLink: '链接',
    tagEmail: '邮箱',
    tagOtp: '验证码',
    tagSnippet: '代码',
    tagSensitive: '敏感',
    // v2 扩展（2026-09-10）：命令行/堆栈日志/配置/IP 地址/哈希指纹/漏洞编号/文件路径
    tagCmd: '命令行',
    tagStack: '堆栈日志',
    tagConfig: '配置',
    tagIp: 'IP 地址',
    tagHash: '哈希指纹',
    tagVuln: '漏洞编号',
    tagPath: '文件路径',
    // v1.0.7 通用化 10 类（2026-09-30 PRD §2）
    tagUrlcred: '账号凭据',
    tagBankcard: '银行卡',
    tagIdcard: '身份证',
    tagTracking: '快递单号',
    tagPhone: '手机号',
    tagMeeting: '会议日程',
    tagTodo: '待办',
    tagUuid: 'UUID',
    tagColor: '颜色值',
    tagAddress: '地址',
    filterAll: '全部',
    // Header 可变高度辅助行（方案 A 2026-09-28 拍板：共 N 条 · 上次复制时间）
    headerMeta: (total: number, rel: string) => `共 ${total} 条 · 上次复制 ${rel}` as string,
  },
  en: {
    title: 'ClipSense',
    hintHtml: 'Copy any text (Ctrl+C) and it will appear below<br><small>Global shortcut <kbd>Alt+V</kbd> toggles the window</small>',
    hintSmallHtml: '<small>Global shortcut <kbd>Alt+V</kbd> toggles the window</small>',
    empty: 'No clipboard history yet',
    copy: 'Copy',
    copyPath: 'Copy path',
    openPath: 'Open path',
    menuUpToDate: 'Up to date',
    timesCopied: 'Copied {n} times',
    expand: 'Expand',
    collapse: 'Collapse',
    chars: (n: number) => `${n} chars` as string,
    image: 'Image',
    file: 'File',
    richText: 'Rich text',
    menuLang: 'Switch language (中文)',
    menuClear: 'Clear history',
    // Lightweight updater (2026-09-20)
    menuCheckUpdate: 'Check for updates',
    updateChecking: 'Checking…',
    updateUpToDate: 'You are up to date',
    updateUpToDateTip: (v: string) => `You are up to date (v${v})` as string,
    updateDownloadBtn: (v: string) => `Download v${v}` as string,
    updateDownloading: (p: number) => `Downloading ${p}%` as string,
    updateDownloadFailed: 'Download failed, click to retry',
    updateNoAsset: 'Installer not published yet',
    today: 'Today',
    yesterday: 'Yesterday',
    backTop: 'Back to top',
    searchPlaceholder: 'Search text or date (date:yesterday)...',
    searchBtn: 'Search',
    statCount: (n: number) => `${n} items` as string,
    statFiltered: (shown: number, total: number) => `${shown} / ${total} items` as string,
    // Auto tags (2026-09-09): tag names and filter bar labels
    tagLink: 'Link',
    tagEmail: 'Email',
    tagOtp: 'OTP',
    tagSnippet: 'Code',
    tagSensitive: 'Sensitive',
    // v2 expansion (2026-09-10): Command/Stack/Config/IP/Hash/Vuln ID/Path
    tagCmd: 'Command',
    tagStack: 'Stack',
    tagConfig: 'Config',
    tagIp: 'IP',
    tagHash: 'Hash',
    tagVuln: 'Vuln ID',
    tagPath: 'Path',
    // v1.0.7 generalization (PRD §2)
    tagUrlcred: 'Credentials',
    tagBankcard: 'Bank Card',
    tagIdcard: 'ID Card',
    tagTracking: 'Tracking No.',
    tagPhone: 'Phone',
    tagMeeting: 'Meeting',
    tagTodo: 'Todo',
    tagUuid: 'UUID',
    tagColor: 'Color',
    tagAddress: 'Address',
    filterAll: 'All',
    // Header hover meta line (Plan A, 2026-09-28)
    headerMeta: (total: number, rel: string) => `${total} items · last copy ${rel}` as string,
  },
};

let currentLang: LangCode = 'zh-CN';

/** window.I18N 挂载契约（main.js 经 window.I18N.t 引用文案；TS 迁移类型声明） */
interface Window {
  I18N?: {
    I18N: Record<LangCode, I18nDict>;
    t: typeof t;
    setLang: typeof setLang;
    getLang: typeof getLang;
    initLang: typeof initLang;
    detectLang: typeof detectLang;
  };
}

/** 本地存储 key（持久化语言偏好） */
const LANG_STORAGE_KEY = 'clipboard-spike-lang';

/**
 * 检测语言：优先 navigator.language，非中文则用 en
 */
function detectLang(): LangCode {
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || 'zh-CN').toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  return 'en';
}

/**
 * 从本地存储读取已保存的语言偏好
 */
function loadSavedLang(): LangCode | null {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && saved in I18N) return saved as LangCode;
  } catch {
    // localStorage 不可用时静默降级
  }
  return null;
}

/**
 * 初始化语言（持久化优先，否则自动检测）
 */
function initLang(): void {
  const saved = loadSavedLang();
  currentLang = saved || detectLang();
}

/**
 * 标签 id → i18n key（link → tagLink；字典为驼峰命名）
 */
function tagI18nKey(id: string): string {
  return 'tag' + String(id).charAt(0).toUpperCase() + String(id).slice(1);
}

/**
 * 取文案（key 支持函数类型）
 */
function t(key: string, ...args: unknown[]): string {
  const dict = I18N[currentLang] || I18N['zh-CN'];
  const val = dict[key];
  if (typeof val === 'function') return val(...(args as never[]));
  return val;
}

/**
 * 切换语言（持久化 + 返回新语言）
 */
function setLang(lang: string): LangCode {
  if (lang in I18N) currentLang = lang as LangCode;
  // 持久化
  try {
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch {
    // 忽略存储失败
  }
  return currentLang;
}

/**
 * 获取当前语言
 */
function getLang(): LangCode {
  return currentLang;
}

if (typeof window !== 'undefined') {
  window.I18N = { I18N, t, setLang, getLang, initLang, detectLang };
}
