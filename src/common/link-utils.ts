/**
 * link-utils.ts - 链接识别工具（主进程/渲染进程共用，无 DOM 依赖）
 * 渲染进程通过 window.__clipSenseLinkUtils 访问；主进程直接 require。
 *
 * TS 迁移（2026-09-30）：IIFE + 双端挂载结构与 .js 版逐行同构——
 * IIFE 内常量/函数保持模块私有，api 对象显式收口后挂两端。
 */

/** 链接识别 API（双端共用收口对象） */
interface LinkUtilsApi {
  extractLinks: (text: string) => string[] | null;
  isValidIpUrl: (url: string) => boolean;
  RE_WHOLE_URL: RegExp;
  RE_WHOLE_BARE: RegExp;
  RE_EXTRACT: RegExp;
  /** 文本条目「打开路径」按钮的形态判定（2026-10-10） */
  isPathLikeText: (text: string) => boolean;
}

(function (): void {
  const URL_HOST = String.raw`(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})`;
  const URL_PATH = String.raw`(?::\d{1,5})?(?:[/?#]\S*)?`;

  // ① 有协议：整条即链接（trim 后全匹配）
  const RE_WHOLE_URL = /^(?:https?|ftp):\/\/\S+$/i;

  // ② 无协议 www / localhost / IP:port：整条即链接
  const RE_WHOLE_BARE = new RegExp(
    String.raw`^(?:https?:\/\/)?(?:www\.${URL_HOST}${URL_PATH}|localhost${URL_PATH}|(?:\d{1,3}\.){3}\d{1,3}${URL_PATH})$`, 'i');

  // ③ 长文本内嵌 URL 提取（排除常见中文标点结尾）
  const RE_EXTRACT = new RegExp(
    String.raw`(?:https?|ftp):\/\/[^\s<>"'）)\]}，。；]+|(?:https?:\/\/)?(?:www\.)${URL_HOST}${URL_PATH}`, 'gi');

  /** IP 每段 ≤255 校验（正则只限了位数，需要数值校验） */
  function isValidIpUrl(url: string): boolean {
    const m = url.match(/(?:\d{1,3}\.){3}\d{1,3}/);
    if (!m) return true;
    return m[0].split('.').every(n => Number(n) <= 255);
  }

  /**
   * 链接识别
   * @param text 条目文本
   * @returns 命中的 URL 数组；非链接条目返回 null
   */
  function extractLinks(text: string): string[] | null {
    if (!text || typeof text !== 'string') return null;
    if (/^\s+$/.test(text)) return null; // 空白条目跳过
    const trimmed = text.trim();

    if (RE_WHOLE_URL.test(trimmed) || RE_WHOLE_BARE.test(trimmed)) {
      if (!isValidIpUrl(trimmed)) return null;
      return [trimmed];
    }

    const found = [...new Set((trimmed.match(RE_EXTRACT) || [])
      .filter(u => isValidIpUrl(u)))];
    return found.length > 0 ? found : null;
  }

  /**
   * 文本条目「打开路径」按钮形态判定（2026-10-10）：
   * 整条文本（trim 后）就是一个可打开的本地路径——严格整条匹配，不做包含检测
   * （长文本里含路径归内容文本，不打按钮）。支持：盘符（C:\\ / C:/）、UNC、
   * file:/// URI、受限 POSIX 顶层（/usr|etc|var|opt|home|root|mnt|tmp|proc|srv|Users）。
   * URL 归 🌐 按钮不判；裸盘符（C:）/裸顶层（/tmp）不判（误报面大）；
   * 存在性校验在主进程点击时做（fs），形态匹配 ≠ 可访问。
   */
  function isPathLikeText(text: string): boolean {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (!t || t.length > 500 || /\r?\n/.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return false; // URL 归 🌐 按钮
    if (/^file:\/\//i.test(t)) return true;     // file URI（openPath 前 fileURLToPath）
    if (/^[A-Za-z]:[\\/]/.test(t)) return true;  // 盘符路径 C:\\ 或 C:/
    if (/^\\\\[^\\]+\\/.test(t)) return true;   // UNC \\\\server\\share
    if (/^\/(?:usr|etc|var|opt|home|root|mnt|tmp|proc|srv|Users)(?:\/\S+)/.test(t)) return true;
    return false;
  }

  const api: LinkUtilsApi = { extractLinks, isValidIpUrl, RE_WHOLE_URL, RE_WHOLE_BARE, RE_EXTRACT, isPathLikeText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__clipSenseLinkUtils = api;
  }
})();
