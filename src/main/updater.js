/**
 * updater.js - ClipSense 轻量升级链路（零依赖，2026-09-20）
 *
 * 自研实现（禁用 electron-updater，保持项目零新增运行时依赖）：
 *   1. checkForUpdate()  调 GitHub Releases API 检测新版本
 *      GET https://api.github.com/repos/holdyounger/ClipSense/releases/latest
 *      （User-Agent 必须带，GitHub API 要求）
 *   2. downloadUpdate()  流式下载 NSIS 安装包到系统临时目录（onProgress 上报进度）
 *   3. installUpdate()   以 NSIS 静默参数 /S 拉起安装包后退出应用
 *
 * 版本比较自实现 compareVersion（三段数字），不引 semver 库。
 * 纯函数 compareVersion / parseTagName / pickInstallerAsset 可在纯 Node
 * 环境单测（tests/updater.test.js），因此 electron 依赖必须按需引入：
 * 纯 Node 下 require('electron') 会成功但返回二进制路径字符串（非 API），
 * 若顶层解构 { app, net } 会直接得到 undefined。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/** ClipSense 公开仓库（GitHub API latest 端点） */
const RELEASE_API_URL = 'https://api.github.com/repos/holdyounger/ClipSense/releases/latest';
/** 网页版 releases/latest：302 到 /tag/vX.Y.Z，从 Location 拿版本号——不走 API 配额（403 降级通道） */
const RELEASE_WEB_URL = 'https://github.com/holdyounger/ClipSense/releases/latest';
/** Atom feed：无 API 配额、200 直出 XML（首条 entry = 最新 release）——403 降级首选 */
const RELEASE_ATOM_URL = 'https://github.com/holdyounger/ClipSense/releases.atom';

// ========== electron API 按需获取（懒加载，见文件头注释） ==========

let _electron = null;
function electronApi() {
  if (_electron === null) {
    try {
      const e = require('electron');
      _electron = (e && typeof e === 'object') ? e : null;
    } catch (err) {
      _electron = null;
    }
  }
  return _electron;
}

function getApp() {
  const e = electronApi();
  return (e && e.app) || null;
}

function getNet() {
  const e = electronApi();
  return (e && e.net) || null;
}

// ========== 纯函数（可单测） ==========

/**
 * 三段版本号比较（1.2.3 语义）
 * @param {string} a
 * @param {string} b
 * @returns {number} a>b → 1；a<b → -1；相等 → 0
 */
function compareVersion(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i] || '0', 10) || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 剥掉 tag_name 的 v 前缀（v1.0.4 → 1.0.4）
 * @param {string} tag
 * @returns {string}
 */
function parseTagName(tag) {
  if (typeof tag !== 'string') return '';
  return tag.replace(/^v/i, '').trim();
}

/**
 * 从 release assets 中匹配 NSIS 安装包
 * （electron-builder 命名：ClipSense-*Setup*.exe，见 package.json build.win.target=nsis）
 * @param {Array} assets - GitHub API release.assets
 * @returns {object|null} { name, downloadUrl }；无匹配返回 null
 */
function pickInstallerAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const found = assets.find(
    (a) => a && typeof a.name === 'string' && /ClipSense.*Setup.*\.exe$/i.test(a.name)
  );
  if (!found) return null;
  return { name: found.name, downloadUrl: found.browser_download_url };
}

// ========== 网络链路 ==========

/**
 * 基于 electron net 模块的 GET（需在 app ready 后调用）。
 * 返回 electron IncomingMessage（Node 流风格：statusCode/headers/on('data')/pipe）。
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<object>}
 */
function requestViaNet(url, headers = {}, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const net = getNet();
    if (!net) {
      reject(new Error('electron net 模块不可用'));
      return;
    }
    const req = net.request({ method: 'GET', url, ...extraOptions });
    // GitHub API 要求：所有请求必须携带 User-Agent
    req.setHeader('User-Agent', 'ClipSense-Updater');
    for (const [k, v] of Object.entries(headers || {})) req.setHeader(k, v);
    req.on('response', (res) => resolve(res));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * 读取响应完整 body 文本
 */
function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (err) => reject(err));
  });
}

/**
 * 从下载 URL 提取目标临时文件名（优先版本号段：ClipSense-update-<version>.exe）
 * @param {string} url
 * @returns {string}
 */
function tempFileNameFromUrl(url) {
  try {
    const name = path.basename(new URL(url).pathname);
    const m = name.match(/(\d+\.\d+\.\d+)/);
    if (m) return `ClipSense-update-${m[1]}.exe`;
    if (/\.exe$/i.test(name)) return name;
  } catch (err) { /* URL 解析失败走兜底 */ }
  return `ClipSense-update-${Date.now()}.exe`;
}

/**
 * 从 Atom feed XML 解析最新版本号（首条 entry = 最新 release，feed 倒序）。
 * 实测 GitHub Atom 首条含 <id>tag:github.com,2008:Repository/<repoId>/v1.0.2</id>
 * 与 <link ... href=".../releases/tag/v1.0.2"/>，两种形态都兼容。
 * @param {string} xml
 * @returns {string} 版本号（如 "1.0.2"）；解析失败返回 ''
 */
function parseLatestVersionFromAtom(xml) {
  if (typeof xml !== 'string') return '';
  const m = xml.match(/(?:releases\/tag\/|Repository\/\d+\/)v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : '';
}

/**
 * BUG2 降级通道（2026-09-20 实机修复）：未认证 GitHub API 配额 60 次/h/IP，
 * 403 后走无配额数据源解析最新版本号。
 *
 * 通道 A（首选）：releases.atom——200 直出 XML，无重定向语义，解析首条 entry。
 *   （v1 首版用 releases/latest 网页 redirect:'manual'，实测失败——Electron net
 *    的 manual 模式需监听 'redirect' 事件并 followRedirect，否则请求中止，
 *    与 curl 的跟随/裸 302 语义不同，照搬 curl 心智模型踩的坑）
 * 通道 B：releases/latest 200 HTML 里解析 tag 链接（Chromium 默认跟随重定向）。
 *
 * @returns {Promise<string>} 版本号（如 "1.0.4"）；解析失败返回 ''
 */
async function fetchLatestVersionFallback() {
  // 通道 A：Atom feed
  try {
    const res = await requestViaNet(RELEASE_ATOM_URL, { Accept: 'application/atom+xml' });
    if (res.statusCode === 200) {
      const xml = await readBody(res);
      const v = parseLatestVersionFromAtom(xml);
      if (v) return v;
    }
  } catch (err) { /* Atom 不可用 → 落到 HTML 通道 */ }

  // 通道 B：网页 HTML（默认 follow 重定向，最终 200 页面里含 tag 链接）
  try {
    const res = await requestViaNet(RELEASE_WEB_URL, { Accept: 'text/html' });
    if (res.statusCode === 200) {
      const html = await readBody(res);
      const v = parseLatestVersionFromAtom(html);
      if (v) return v;
    }
  } catch (err) { /* 两个通道都失败 → 抛最后一个错误 */ }
  const e = new Error('GitHub 网页降级通道不可用');
  throw e;
}

/**
 * BUG2 降级通道：按 electron-builder 命名惯例枚举安装包直链候选。
 * （latest.yml 记录连字符命名「ClipSense-Setup-x.y.z.exe」；部分构建产物为空格命名）
 * @param {string} version
 * @returns {string[]}
 */
function assetUrlCandidates(version) {
  const base = 'https://github.com/holdyounger/ClipSense/releases/download';
  return [
    `${base}/v${version}/ClipSense-Setup-${version}.exe`,
    `${base}/v${version}/${encodeURIComponent(`ClipSense Setup ${version}.exe`)}`,
  ];
}

/**
 * BUG2 降级通道：轻量探测 asset 直链是否存在（Range 只取 1 字节，不下载全文）。
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function probeAssetUrl(url) {
  try {
    const res = await requestViaNet(url, { Range: 'bytes=0-0', Accept: 'application/octet-stream' });
    try { if (typeof res.resume === 'function') res.resume(); } catch (_) { /* ignore */ }
    return res.statusCode === 200 || res.statusCode === 206 || res.statusCode === 302;
  } catch (err) {
    return false;
  }
}

/**
 * 检测新版本
 * @returns {Promise<{ok:boolean, hasUpdate?:boolean, latestVersion?:string, currentVersion?:string,
 *   downloadUrl?:string, releaseNotes?:string, htmlUrl?:string, reason?:string, error?:string}>}
 *   无更新 / 无匹配安装包 asset 时返回 hasUpdate:false + reason 标记（属正常路径，非错误）；
 *   网络失败 / 非 200 / JSON 解析失败返回 { ok:false, error }。
 */
async function checkForUpdate() {
  let res;
  try {
    res = await requestViaNet(RELEASE_API_URL, { Accept: 'application/vnd.github+json' });
  } catch (err) {
    return { ok: false, error: `网络请求失败: ${err.message}` };
  }

  if (res.statusCode !== 200) {
    // BUG2（2026-09-20 实机）：403 = 未认证 API 配额耗尽（60 次/h/IP）。
    // 降级：releases/latest 网页重定向拿版本号 + 命名惯例探测安装包直链。
    if (res.statusCode === 403) {
      try {
        const fbVersion = await fetchLatestVersionFallback();
        const currentVersion = getAppVersion();
        if (fbVersion) {
          if (compareVersion(fbVersion, currentVersion) > 0) {
            for (const candidate of assetUrlCandidates(fbVersion)) {
              if (await probeAssetUrl(candidate)) {
                return {
                  ok: true, hasUpdate: true, latestVersion: fbVersion, currentVersion,
                  downloadUrl: candidate, releaseNotes: '',
                  htmlUrl: `https://github.com/holdyounger/ClipSense/releases/tag/v${fbVersion}`,
                  degraded: true, // 标记降级通道（releaseNotes 拿不到）
                };
              }
            }
            return { ok: true, hasUpdate: false, latestVersion: fbVersion, currentVersion, reason: 'no-installer-asset', degraded: true };
          }
          return { ok: true, hasUpdate: false, latestVersion: fbVersion, currentVersion, reason: 'up-to-date', degraded: true };
        }
      } catch (err) { /* 降级也失败 → 落到下方结构化 403 错误 */ }
      return { ok: false, error: 'GitHub API 限流（403），降级通道不可用；请稍后再试' };
    }
    return { ok: false, error: `GitHub API 返回 HTTP ${res.statusCode}` };
  }

  let release;
  try {
    release = JSON.parse(await readBody(res));
  } catch (err) {
    return { ok: false, error: `响应 JSON 解析失败: ${err.message}` };
  }

  const latestVersion = parseTagName(release && release.tag_name);
  const currentVersion = getAppVersion();
  if (!latestVersion) {
    return { ok: true, hasUpdate: false, latestVersion: '', currentVersion, reason: 'invalid-tag' };
  }
  if (compareVersion(latestVersion, currentVersion) <= 0) {
    return { ok: true, hasUpdate: false, latestVersion, currentVersion, reason: 'up-to-date' };
  }

  const asset = pickInstallerAsset(release.assets);
  if (!asset) {
    return { ok: true, hasUpdate: false, latestVersion, currentVersion, reason: 'no-installer-asset' };
  }

  return {
    ok: true,
    hasUpdate: true,
    latestVersion,
    currentVersion,
    downloadUrl: asset.downloadUrl,
    releaseNotes: typeof release.body === 'string' ? release.body : '',
    htmlUrl: typeof release.html_url === 'string' ? release.html_url : '',
  };
}

/**
 * 读取当前应用版本（package.json version；非 electron 环境返回 ''）
 */
function getAppVersion() {
  const app = electronApi() && electronApi().app;
  try {
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch (err) { /* ignore */ }
  return '';
}

/**
 * 流式下载安装包到临时目录，经 onProgress({receivedBytes,totalBytes,percent}) 上报进度
 * @param {string} downloadUrl - checkForUpdate 返回的下载地址
 * @param {Function} [onProgress]
 * @returns {Promise<{ok:boolean, filePath?:string, error?:string}>}
 */
async function downloadUpdate(downloadUrl, onProgress) {
  if (typeof downloadUrl !== 'string' || !/^https:\/\//i.test(downloadUrl)) {
    return { ok: false, error: '无效的下载地址' };
  }

  let res;
  try {
    res = await requestViaNet(downloadUrl, { Accept: 'application/octet-stream' });
  } catch (err) {
    return { ok: false, error: `网络请求失败: ${err.message}` };
  }
  if (res.statusCode !== 200) {
    return { ok: false, error: `下载返回 HTTP ${res.statusCode}` };
  }

  const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
  let tempDir;
  try {
    const app = electronApi() && electronApi().app;
    tempDir = (app && typeof app.getPath === 'function')
      ? app.getPath('temp')
      : os.tmpdir();
  } catch (err) {
    tempDir = os.tmpdir();
  }
  const filePath = path.join(tempDir, tempFileNameFromUrl(downloadUrl));

  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let receivedBytes = 0;
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          try { file.destroy(); } catch (e2) { /* ignore */ }
          reject(err);
        } else {
          resolve();
        }
      };

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              receivedBytes,
              totalBytes,
              percent: totalBytes ? (receivedBytes / totalBytes) * 100 : 0,
            });
          } catch (err) { /* 进度回调失败不影响下载 */ }
        }
      });
      res.on('error', (err) => settle(err));
      file.on('error', (err) => settle(err));
      file.on('finish', () => settle(null));
      res.pipe(file);
    });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch (e2) { /* 临时文件清理失败可忽略 */ }
    return { ok: false, error: `下载失败: ${err.message}` };
  }

  return { ok: true, filePath };
}

/**
 * 拉起安装包（NSIS 静默参数 /S），detached + unref 后退出应用。
 * 执行前用 fs.accessSync 确认安装包存在，避免「升级点击 → 拉起失败 → 应用未退出」。
 * @param {string} filePath - downloadUpdate 返回的安装包路径
 * @returns {{ok:boolean, error?:string}}
 */
function installUpdate(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '安装包路径为空' };
  }
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
  } catch (err) {
    return { ok: false, error: '安装包不存在或已被清理' };
  }

  try {
    const child = spawn(filePath, ['/S'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, error: `启动安装包失败: ${err.message}` };
  }

  // 拉起安装器后退出应用（NSIS 安装器接管后续流程）
  try {
    const app = electronApi() && electronApi().app;
    if (app) app.quit();
  } catch (err) { /* 退出失败不影响安装器继续执行 */ }

  return { ok: true };
}

module.exports = {
  RELEASE_API_URL,
  RELEASE_WEB_URL,
  RELEASE_ATOM_URL,
  fetchLatestVersionFallback,
  parseLatestVersionFromAtom,
  assetUrlCandidates,
  probeAssetUrl,
  compareVersion,
  parseTagName,
  pickInstallerAsset,
  tempFileNameFromUrl,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
};
