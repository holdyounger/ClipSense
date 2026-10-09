/**
 * updater.ts - ClipSense 轻量升级链路（零依赖，2026-09-20）
 *
 * 自研实现（禁用 electron-updater，保持项目零新增运行时依赖）：
 *   1. checkForUpdate()  调 GitHub Releases API 检测新版本
 *      GET https://api.github.com/repos/holdyounger/ClipSense/releases/latest
 *      （User-Agent 必须带，GitHub API 要求）
 *   2. downloadUpdate()  流式下载 NSIS 安装包到系统临时目录（onProgress 上报进度）
 *   3. installUpdate()   以 NSIS 静默参数 /S 拉起安装包后退出应用；
 *      安装收尾的「自动启动新版本」由 NSIS customInstall 负责（build/installer.nsh）
 *
 * 版本比较自实现 compareVersion（三段数字），不引 semver 库。
 * 纯函数 compareVersion / parseTagName / pickInstallerAsset 可在纯 Node
 * 环境单测（tests/updater.test.js），因此 electron 依赖必须按需引入：
 * 纯 Node 下 require('electron') 会成功但返回二进制路径字符串（非 API），
 * 若顶层解构 { app, net } 会直接得到 undefined。
 *
 * TS 迁移（2026-10-09，第四批 #3）：CommonJS 命名导出（与 .js 原版
 * module.exports = { ... } 形状一致，tests 直接 require .js 源不受影响）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

/** ClipSense 公开仓库（GitHub API latest 端点） */
export const RELEASE_API_URL = 'https://api.github.com/repos/holdyounger/ClipSense/releases/latest';
/** 网页版 releases/latest：302 到 /tag/vX.Y.Z，从 Location 拿版本号——不走 API 配额（403 降级通道） */
export const RELEASE_WEB_URL = 'https://github.com/holdyounger/ClipSense/releases/latest';
/** Atom feed：无 API 配额、200 直出 XML（首条 entry = 最新 release）——403 降级首选 */
export const RELEASE_ATOM_URL = 'https://github.com/holdyounger/ClipSense/releases.atom';

// ========== electron API 按需获取（懒加载，见文件头注释） ==========

/** electron app 子集（本模块消费 getVersion/getPath/quit） */
interface ElectronAppApi {
  getVersion?: () => string;
  getPath?: (name: string) => string;
  quit?: () => void;
  isPackaged?: boolean;
}

/** electron net request 对象子集（setHeader/on/end——发请求阶段用） */
interface ElectronRequestWritable {
  setHeader: (name: string, value: string) => void;
  on: (event: 'response' | 'error', cb: (arg?: unknown) => void) => void;
  end: () => void;
}

/** electron net IncomingMessage 子集（响应对象：statusCode/headers/流式读取） */
interface ElectronIncomingMessage {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  // 重载式签名：'data' → Buffer / 'end' → 无参 / 'error' → Error（TS 重载仅声明侧，
  // 实现侧以联合签名 + 内部窄化承载）
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  pipe: (dest: { end: () => void }) => void;
  resume?: () => void;
}

/** electron net 子集（request 发起请求） */
interface ElectronNetApi {
  request: (options: { method: string; url: string } & Record<string, unknown>) => ElectronRequestWritable;
}

/** electron API 子集（懒加载后可能为 null） */
interface ElectronApi {
  app?: ElectronAppApi;
  net?: ElectronNetApi;
}

let _electron: ElectronApi | null = null;
function electronApi(): ElectronApi | null {
  if (_electron === null) {
    try {
      const e = require('electron') as unknown;
      _electron = (e && typeof e === 'object') ? (e as ElectronApi) : null;
    } catch {
      _electron = null;
    }
  }
  return _electron;
}

function getApp(): ElectronAppApi | null {
  const e = electronApi();
  return (e && e.app) || null;
}

function getNet(): ElectronNetApi | null {
  const e = electronApi();
  return (e && e.net) || null;
}

// ========== 纯函数（可单测） ==========

/** GitHub release asset（name/browser_download_url；值以 JSON 反序列化为准） */
interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/**
 * 三段版本号比较（1.2.3 语义）
 * @returns a>b → 1；a<b → -1；相等 → 0
 */
export function compareVersion(a: string, b: string): number {
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
 */
export function parseTagName(tag: unknown): string {
  if (typeof tag !== 'string') return '';
  return tag.replace(/^v/i, '').trim();
}

/**
 * 从 release assets 中匹配 NSIS 安装包
 * （electron-builder 命名：ClipSense-*Setup*.exe，见 package.json build.win.target=nsis）
 * @returns { name, downloadUrl }；无匹配返回 null
 */
export function pickInstallerAsset(
  assets: ReleaseAsset[] | null | undefined
): { name: string; downloadUrl: string } | null {
  if (!Array.isArray(assets)) return null;
  const found = assets.find(
    (a) => a && typeof a.name === 'string' && /ClipSense.*Setup.*\.exe$/i.test(a.name)
  );
  if (!found) return null;
  const name: string = found.name;
  const downloadUrl: string = found.browser_download_url;
  return { name, downloadUrl };
}

// ========== 网络链路 ==========

/**
 * 基于 electron net 模块的 GET（需在 app ready 后调用）。
 * 返回 electron IncomingMessage（Node 流风格：statusCode/headers/on('data')/pipe）。
 */
function requestViaNet(
  url: string,
  headers: Record<string, string> = {},
  extraOptions: Record<string, unknown> = {}
): Promise<ElectronIncomingMessage> {
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
    req.on('response', (res: unknown) => resolve(res as ElectronIncomingMessage));
    req.on('error', (err: unknown) => reject(err));
    req.end();
  });
}

/**
 * 读取响应完整 body 文本
 */
function readBody(res: ElectronIncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => { if (chunk) chunks.push(chunk); });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (err) => reject(err));
  });
}

/**
 * 从下载 URL 提取目标临时文件名（优先版本号段：ClipSense-update-<version>.exe）
 */
export function tempFileNameFromUrl(url: string): string {
  try {
    const name = path.basename(new URL(url).pathname);
    const m = name.match(/(\d+\.\d+\.\d+)/);
    if (m) return `ClipSense-update-${m[1]}.exe`;
    if (/\.exe$/i.test(name)) return name;
  } catch { /* URL 解析失败走兜底 */ }
  return `ClipSense-update-${Date.now()}.exe`;
}

/**
 * 从 Atom feed XML 解析最新版本号（首条 entry = 最新 release，feed 倒序）。
 * 实测 GitHub Atom 首条含 <id>tag:github.com,2008:Repository/<repoId>/v1.0.2</id>
 * 与 <link ... href=".../releases/tag/v1.0.2"/>，两种形态都兼容。
 * @returns 版本号（如 "1.0.2"）；解析失败返回 ''
 */
export function parseLatestVersionFromAtom(xml: unknown): string {
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
 * @returns 版本号（如 "1.0.4"）；解析失败返回 ''
 */
export async function fetchLatestVersionFallback(): Promise<string> {
  // 通道 A：Atom feed
  try {
    const res = await requestViaNet(RELEASE_ATOM_URL, { Accept: 'application/atom+xml' });
    if (res.statusCode === 200) {
      const xml = await readBody(res);
      const v = parseLatestVersionFromAtom(xml);
      if (v) return v;
    }
  } catch { /* Atom 不可用 → 落到 HTML 通道 */ }

  // 通道 B：网页 HTML（默认 follow 重定向，最终 200 页面里含 tag 链接）
  try {
    const res = await requestViaNet(RELEASE_WEB_URL, { Accept: 'text/html' });
    if (res.statusCode === 200) {
      const html = await readBody(res);
      const v = parseLatestVersionFromAtom(html);
      if (v) return v;
    }
  } catch { /* 两个通道都失败 → 抛最后一个错误 */ }
  throw new Error('GitHub 网页降级通道不可用');
}

/**
 * BUG2 降级通道：按 electron-builder 命名惯例枚举安装包直链候选。
 * （latest.yml 记录连字符命名「ClipSense-Setup-x.y.z.exe」；部分构建产物为空格命名）
 */
export function assetUrlCandidates(version: string): string[] {
  const base = 'https://github.com/holdyounger/ClipSense/releases/download';
  return [
    `${base}/v${version}/ClipSense-Setup-${version}.exe`,
    `${base}/v${version}/${encodeURIComponent(`ClipSense Setup ${version}.exe`)}`,
  ];
}

/**
 * BUG2 降级通道：轻量探测 asset 直链是否存在（Range 只取 1 字节，不下载全文）。
 */
export async function probeAssetUrl(url: string): Promise<boolean> {
  try {
    const res = await requestViaNet(url, { Range: 'bytes=0-0', Accept: 'application/octet-stream' });
    try { if (typeof res.resume === 'function') res.resume(); } catch { /* ignore */ }
    return res.statusCode === 200 || res.statusCode === 206 || res.statusCode === 302;
  } catch {
    return false;
  }
}

/** checkForUpdate 返回（结构化结果；hasUpdate:false + reason 属正常路径非错误） */
export interface CheckUpdateResult {
  ok: boolean;
  hasUpdate?: boolean;
  latestVersion?: string;
  currentVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  htmlUrl?: string;
  reason?: string;
  error?: string;
  /** 降级通道标记（releaseNotes 拿不到） */
  degraded?: boolean;
}

/**
 * 检测新版本
 */
export async function checkForUpdate(): Promise<CheckUpdateResult> {
  let res: ElectronIncomingMessage;
  try {
    res = (await requestViaNet(RELEASE_API_URL, { Accept: 'application/vnd.github+json' })) as ElectronIncomingMessage;
  } catch (err) {
    return { ok: false, error: `网络请求失败: ${(err as Error).message}` };
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
      } catch { /* 降级也失败 → 落到下方结构化 403 错误 */ }
      return { ok: false, error: 'GitHub API 限流（403），降级通道不可用；请稍后再试' };
    }
    return { ok: false, error: `GitHub API 返回 HTTP ${res.statusCode}` };
  }

  let release: { tag_name?: unknown; assets?: unknown; body?: unknown; html_url?: unknown };
  try {
    release = JSON.parse(await readBody(res));
  } catch (err) {
    return { ok: false, error: `响应 JSON 解析失败: ${(err as Error).message}` };
  }

  const latestVersion = parseTagName(release && release.tag_name);
  const currentVersion = getAppVersion();
  if (!latestVersion) {
    return { ok: true, hasUpdate: false, latestVersion: '', currentVersion, reason: 'invalid-tag' };
  }
  if (compareVersion(latestVersion, currentVersion) <= 0) {
    return { ok: true, hasUpdate: false, latestVersion, currentVersion, reason: 'up-to-date' };
  }

  const asset = pickInstallerAsset(release.assets as ReleaseAsset[] | null | undefined);
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
function getAppVersion(): string {
  const app = getApp();
  try {
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch { /* ignore */ }
  return '';
}

/** 下载进度上报 */
export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  percent: number;
}

/** 下载结果 */
export interface DownloadResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/**
 * 流式下载安装包到临时目录，经 onProgress 上报进度
 */
export async function downloadUpdate(
  downloadUrl: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  if (typeof downloadUrl !== 'string' || !/^https:\/\//i.test(downloadUrl)) {
    return { ok: false, error: '无效的下载地址' };
  }

  let res: ElectronIncomingMessage;
  try {
    res = (await requestViaNet(downloadUrl, { Accept: 'application/octet-stream' })) as ElectronIncomingMessage;
  } catch (err) {
    return { ok: false, error: `网络请求失败: ${(err as Error).message}` };
  }
  if (res.statusCode !== 200) {
    return { ok: false, error: `下载返回 HTTP ${res.statusCode}` };
  }

  const cl = res.headers['content-length'];
  const totalBytes = parseInt((typeof cl === 'string' ? cl : undefined) || '0', 10) || 0;
  let tempDir: string;
  try {
    const app = getApp();
    tempDir = (app && typeof app.getPath === 'function')
      ? app.getPath('temp')
      : os.tmpdir();
  } catch {
    tempDir = os.tmpdir();
  }
  const filePath = path.join(tempDir, tempFileNameFromUrl(downloadUrl));

  try {
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let receivedBytes = 0;
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) {
          try { file.destroy(); } catch { /* ignore */ }
          reject(err);
        } else {
          resolve();
        }
      };

      res.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              receivedBytes,
              totalBytes,
              percent: totalBytes ? (receivedBytes / totalBytes) * 100 : 0,
            });
          } catch { /* 进度回调失败不影响下载 */ }
        }
      });
      res.on('error', (err) => settle(err));
      file.on('error', (err) => settle(err));
      file.on('finish', () => settle());
      res.pipe(file);
    });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch { /* 临时文件清理失败可忽略 */ }
    return { ok: false, error: `下载失败: ${(err as Error).message}` };
  }

  return { ok: true, filePath };
}

/** 安装结果 */
export interface InstallResult {
  ok: boolean;
  error?: string;
}

/**
 * 拉起 NSIS 静默安装器（/S）后退出应用。安装收尾的「自动启动新版本」由
 * NSIS customInstall 负责（build/installer.nsh），本模块不再安排应用侧重启脚本
 *（2026-09-30 实机缺陷：cmd 轮询脚本卡死在 find 循环，已废弃，见 buildRestartScript）。
 *
 * 执行前用 fs.accessSync 确认安装包存在，避免「升级点击 → 拉起失败 → 应用未退出」。
 */
export function installUpdate(filePath: string): InstallResult {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '安装包路径为空' };
  }
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
  } catch {
    return { ok: false, error: '安装包不存在或已被清理' };
  }

  // NSIS 静默安装会先检测运行中的应用；本进程退出与安装器启动存在竞态，
  // 由安装器自身的关闭检测兜底（customInstall 负责装后自动启动）。
  try {
    const child = spawn(filePath, ['/S'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, error: `启动安装包失败: ${(err as Error).message}` };
  }

  // 拉起安装器后退出应用。安装收尾的自动启动由 NSIS customInstall 负责
  //（build/installer.nsh：静默升级完成后 Exec 启动新版本——比应用侧脚本更可靠，
  //  v1.0.5.1 曾用应用侧 cmd 轮询脚本替代，实机卡死在 find 轮询已废弃）。
  try {
    const app = getApp();
    if (app && app.quit) app.quit();
  } catch { /* 退出失败不影响安装器继续执行 */ }

  return { ok: true };
}

/**
 * 【已废弃 2026-09-30】buildRestartScript：应用侧 cmd 轮询重启脚本。
 * 实机缺陷：脚本里 tasklist | find 的轮询在部分环境死循环（PID 44900 卡死取证），
 * 且与 NSIS customInstall 自动启动职责重叠。保留函数仅为 API 兼容，不再被调用。
 * @deprecated 由 build/installer.nsh 的 customInstall 自动启动取代
 */
export function buildRestartScript(installerPath: string, exePath: string): string {
  return [
    '@echo off',
    'rem ClipSense 升级自动重启（静默安装等待 + 拉起新版本）',
    'set /a tries=0',
    ':wait_loop',
    'ping -n 2 127.0.0.1 >nul', /* 1s 延时：timeout 需要控制台 stdin，detached stdio:ignore 下会立即报错退出 */
    'set /a tries+=1',
    'if %tries% gtr 120 goto :giveup',
    `if not exist "${installerPath}" goto :done`,
    `tasklist /FI "IMAGENAME eq ${path.basename(installerPath)}" 2>nul | find /I "${path.basename(installerPath)}" >nul`,
    'if not errorlevel 1 goto :wait_loop',
    'goto :done',
    ':done',
    `start "" "${exePath}"`,
    'exit /b 0',
    ':giveup',
    `start "" "${exePath}"`,
    'exit /b 0',
  ].join('\r\n');
}
