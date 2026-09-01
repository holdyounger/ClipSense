/**
 * link-utils.js - 链接识别工具（主进程/渲染进程共用，无 DOM 依赖）
 * 渲染进程通过 window.__clipSenseLinkUtils 访问；主进程直接 require。
 */
(function () {
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
  function isValidIpUrl(url) {
    const m = url.match(/(?:\d{1,3}\.){3}\d{1,3}/);
    if (!m) return true;
    return m[0].split('.').every(n => Number(n) <= 255);
  }

  /**
   * 链接识别
   * @param {string} text 条目文本
   * @returns {string[]|null} 命中的 URL 数组；非链接条目返回 null
   */
  function extractLinks(text) {
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

  const api = { extractLinks, isValidIpUrl, RE_WHOLE_URL, RE_WHOLE_BARE, RE_EXTRACT };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.__clipSenseLinkUtils = api;
  }
})();
