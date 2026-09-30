'use strict';

/**
 * updater.test.js - 轻量升级链路纯函数测试（2026-09-20）
 *
 * 覆盖（零网络依赖）：
 *  - compareVersion：三段数字比较矩阵（大于/小于/相等/补零/多段）
 *  - parseTagName：v 前缀剥离（v1.0.4 / V2.0.0 / 无前缀 / 非法输入）
 *  - pickInstallerAsset：electron-builder NSIS 命名匹配（ClipSense.*Setup*.exe）
 *  - 错误结构：checkForUpdate / downloadUpdate / installUpdate 的 { ok, error } 形态
 *    （electron 桩注入，不触发真实网络/文件系统）
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// ---------------- electron 桩（updater 顶层按需 require） ----------------

const electronStub = {
  app: {
    getVersion: () => '1.0.3',
    getPath: (name) => path.join(osTmp(), 'clipsense-test-temp', name),
    quit: () => {},
  },
  net: null, // 不提供 net：网络调用应走错误路径而非崩溃
};

function osTmp() {
  return require('node:os').tmpdir();
}

const stubRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  return id === 'electron' ? electronStub : stubRequire.apply(this, arguments);
};

const updater = require(path.join(__dirname, '..', 'src', 'main', 'updater.js'));

// ==================== compareVersion ====================

describe('BUG2 降级通道（2026-09-20）', () => {
  test('assetUrlCandidates：连字符命名（latest.yml 惯例）为首选', () => {
    const urls = updater.assetUrlCandidates('1.0.4');
    assert.ok(Array.isArray(urls) && urls.length >= 2);
    assert.strictEqual(
      urls[0],
      'https://github.com/holdyounger/ClipSense/releases/download/v1.0.4/ClipSense-Setup-1.0.4.exe'
    );
  });

  test('assetUrlCandidates：空格命名候选用 encodeURIComponent 编码', () => {
    const urls = updater.assetUrlCandidates('1.0.4');
    assert.ok(urls[1].includes('ClipSense%20Setup%201.0.4.exe'), urls[1]);
  });

  test('RELEASE_WEB_URL 常量指向网页版 latest（非 API 端点）', () => {
    assert.strictEqual(
      updater.RELEASE_WEB_URL,
      'https://github.com/holdyounger/ClipSense/releases/latest'
    );
    assert.ok(updater.RELEASE_WEB_URL !== updater.RELEASE_API_URL);
  });

  test('无 electron net（桩 net:null）→ fetchLatestVersionFallback 走错误路径而非崩溃', async () => {
    // electronStub.net = null：requestViaNet reject('electron net 模块不可用')
    const r = await updater.fetchLatestVersionFallback().then(
      () => 'resolved', (err) => `rejected: ${err.message}`
    );
    // 两通道（Atom + HTML）都因无 net 失败 → 抛聚合错误而非崩溃/未处理 rejection
    assert.match(r, /rejected: GitHub 网页降级通道不可用/);
  });

  test('parseLatestVersionFromAtom：实测 feed 首条 entry 提取版本号', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      '  <title>Release notes from ClipSense</title>',
      '  <entry>',
      '    <id>tag:github.com,2008:Repository/1348354895/v1.0.2</id>',
      '    <link rel="alternate" type="text/html" href="https://github.com/holdyounger/ClipSense/releases/tag/v1.0.2"/>',
      '    <title>Release v1.0.2</title>',
      '  </entry>',
      '  <entry>',
      '    <id>tag:github.com,2008:Repository/1348354895/v1.0.1</id>',
      '    <title>Release v1.0.1</title>',
      '  </entry>',
      '</feed>',
    ].join('\n');
    assert.strictEqual(updater.parseLatestVersionFromAtom(xml), '1.0.2', '首条 entry = 最新');
  });

  test('parseLatestVersionFromAtom：空 feed / 无版本 → 空串', () => {
    assert.strictEqual(updater.parseLatestVersionFromAtom('<feed></feed>'), '');
    assert.strictEqual(updater.parseLatestVersionFromAtom(''), '');
    assert.strictEqual(updater.parseLatestVersionFromAtom(null), '');
  });

  test('无 electron net → probeAssetUrl 返回 false（不抛异常）', async () => {
    const r = await updater.probeAssetUrl('https://example.com/x.exe');
    assert.strictEqual(r, false);
  });
});

describe('compareVersion 三段版本比较', () => {
  const cases = [
    ['1.0.4', '1.0.3', 1],
    ['1.1.0', '1.0.3', 1],
    ['2.0.0', '1.0.3', 1],
    ['1.0.3', '1.0.3', 0],
    ['0.9.9', '1.0.3', -1],
    ['1.0.2', '1.0.3', -1],
    ['0.9.9', '0.9.10', -1],      // 逐段数字比较而非字典序
    ['1.10.0', '1.9.9', 1],
    ['1.0.3', '1.0.3.0', 0],      // 长度不齐补零
    ['1.0', '1.0.0', 0],
  ];

  for (const [a, b, expected] of cases) {
    test(`compareVersion(${a}, ${b}) === ${expected}`, () => {
      assert.strictEqual(updater.compareVersion(a, b), expected);
    });
  }
});

// ==================== parseTagName ====================

describe('parseTagName v 前缀剥离', () => {
  test('v1.0.4 → 1.0.4', () => {
    assert.strictEqual(updater.parseTagName('v1.0.4'), '1.0.4');
  });

  test('V2.10.3 → 2.10.3（大写 V 亦剥离）', () => {
    assert.strictEqual(updater.parseTagName('V2.10.3'), '2.10.3');
  });

  test('1.0.3 → 1.0.3（无前缀原样返回）', () => {
    assert.strictEqual(updater.parseTagName('1.0.3'), '1.0.3');
  });

  test('非字符串 / 空值 → 空字符串', () => {
    assert.strictEqual(updater.parseTagName(undefined), '');
    assert.strictEqual(updater.parseTagName(null), '');
    assert.strictEqual(updater.parseTagName(''), '');
  });
});

// ==================== pickInstallerAsset ====================

describe('pickInstallerAsset 安装包匹配', () => {
  const assets = (names) => names.map((name) => ({ name, browser_download_url: `https://example.com/${name}` }));

  test('标准 NSIS 命名：ClipSense-1.0.4-Setup.exe 命中', () => {
    const a = assets(['checksums.txt', 'ClipSense-1.0.4-Setup.exe', 'latest.yml']);
    const got = updater.pickInstallerAsset(a);
    assert.ok(got);
    assert.strictEqual(got.name, 'ClipSense-1.0.4-Setup.exe');
    assert.strictEqual(got.downloadUrl, 'https://example.com/ClipSense-1.0.4-Setup.exe');
  });

  test('Setup 在版本号前的命名：ClipSense Setup 1.0.4.exe 命中', () => {
    const got = updater.pickInstallerAsset(assets(['ClipSense Setup 1.0.4.exe']));
    assert.ok(got);
    assert.strictEqual(got.name, 'ClipSense Setup 1.0.4.exe');
  });

  test('大小写不敏感：clipsense-1.0.4-setup.EXE 命中', () => {
    const got = updater.pickInstallerAsset(assets(['clipsense-1.0.4-setup.EXE']));
    assert.ok(got);
  });

  test('portable / zip / yml / sha512 等非安装包 asset 不命中', () => {
    assert.strictEqual(updater.pickInstallerAsset(assets([
      'ClipSense-1.0.4-portable.zip',
      'ClipSense-1.0.4-win.zip',
      'latest.yml',
      'latest.sha512',
    ])), null);
  });

  test('纯 exe 但名字不含 ClipSense+Setup 组合不命中', () => {
    assert.strictEqual(updater.pickInstallerAsset(assets(['installer.exe', 'ClipSense.exe'])), null);
  });

  test('assets 为空数组 / null / 缺 browser_download_url 字段', () => {
    assert.strictEqual(updater.pickInstallerAsset([]), null);
    assert.strictEqual(updater.pickInstallerAsset(null), null);
    assert.strictEqual(updater.pickInstallerAsset('not-an-array'), null);
    const noUrl = updater.pickInstallerAsset([{ name: 'ClipSense-1.0.4-Setup.exe' }]);
    assert.ok(noUrl);
    assert.strictEqual(noUrl.downloadUrl, undefined);
  });
});

// ==================== 错误结构（electron 桩不提供 net → 走错误路径，零网络） ====================

describe('升级链路错误结构', () => {
  test('checkForUpdate：net 不可用时返回 { ok:false, error } 而非抛出', async () => {
    const r = await updater.checkForUpdate();
    assert.strictEqual(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
    assert.strictEqual(r.hasUpdate, undefined);
  });

  test('downloadUpdate：无效 URL 返回 { ok:false, error }', async () => {
    for (const bad of ['', null, undefined, 'ftp://x/y.exe', 'http://insecure.invalid/ClipSense-9.9.9-Setup.exe']) {
      const r = await updater.downloadUpdate(bad);
      assert.strictEqual(r.ok, false, `bad=${JSON.stringify(bad)}`);
      assert.ok(r.error, `bad=${JSON.stringify(bad)} 应有 error`);
      assert.strictEqual(r.filePath, undefined);
    }
  });

  test('tempFileNameFromUrl：从 URL 提取版本号段文件名', () => {
    assert.strictEqual(
      updater.tempFileNameFromUrl('https://example.com/download/ClipSense-1.0.4-Setup.exe'),
      'ClipSense-update-1.0.4.exe'
    );
    assert.strictEqual(
      updater.tempFileNameFromUrl('https://example.com/download/ClipSense-Setup-2.3.10.exe'),
      'ClipSense-update-2.3.10.exe'
    );
  });

  test('installUpdate：文件不存在时返回结构化错误且不拉起进程', () => {
    const r = updater.installUpdate('');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);

    const missing = updater.installUpdate('/nonexistent/path/ClipSense-update-9.9.9.exe');
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.error);
  });
});

// ==================== 升级自动重启脚本（2026-09-30 体验断点修复） ====================

describe('buildRestartScript 安装后自动重启', () => {
  const { buildRestartScript } = updater;

  test('脚本结构：CRLF 换行 + 轮询等待安装器退出 + start 拉起新版本', () => {
    const script = buildRestartScript('C:\\Temp\\ClipSense-update-1.0.5.exe', 'C:\\Programs\\clipboard-spike\\ClipSense.exe');
    assert.ok(script.includes('\r\n'), 'Windows CRLF 换行');
    assert.ok(script.startsWith('@echo off'));
    assert.ok(script.includes('tasklist'), '轮询安装器进程');
    assert.ok(script.includes(':wait_loop'), '等待循环');
    const starts = script.split('\r\n').filter((l) => l.startsWith('start '));
    assert.strictEqual(starts.length, 2, 'done 与 giveup 两路都拉起新版本');
    assert.ok(script.includes('ClipSense.exe'), '拉起目标为新版本主程序');
  });

  test('脚本不含裸 LF（纯 CRLF，cmd 解析要求）', () => {
    const script = buildRestartScript('a.exe', 'b.exe');
    const lfOnly = script.replace(/\r\n/g, '');
    assert.ok(!lfOnly.includes('\n'), '不允许裸 LF');
  });

  test('上限保护：120s 超时后仍拉起新版本（giveup 路径）', () => {
    const script = buildRestartScript('a.exe', 'b.exe');
    assert.ok(script.includes('gtr 120'), '120s 上限');
    assert.ok(script.includes(':giveup'), 'giveup 分支存在');
  });
});

// ==================== N. NSIS customInstall 自动启动（取代应用侧重启脚本） ====================

describe('installer.nsh 静默升级自动启动（取代 buildRestartScript）', () => {
  const ROOT = path.join(__dirname, '..');
  const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('N1 installer.nsh：customInstall 宏存在，静默升级（isUpdated）拉起新版本', () => {
    const nsh = readRoot('build/installer.nsh');
    assert.match(nsh, /!macro\s+customInstall/, 'customInstall 宏定义');
    assert.match(nsh, /\$\{ifNot\}\s*\$\{isUpdated\}/, '交互式安装守卫（不双开）');
    assert.match(nsh, /Exec ['"]{2}\$INSTDIR\\ClipSense\.exe['"]{2}/, '静默升级后启动新版本（单引号+双引号包裹）');
  });

  test('N2 package.json：build.nsis.include 挂载 installer.nsh（CI 构建必须读到）', () => {
    const pkg = JSON.parse(readRoot('package.json'));
    assert.strictEqual(pkg.build.nsis.include, 'build/installer.nsh');
  });

  test('N3 installUpdate：不再生成应用侧重启脚本（clipsense-restart.cmd 零引用）', () => {
    const src = readRoot('src/main/updater.js');
    assert.ok(!src.includes('clipsense-restart.cmd'), '不写 restart 脚本文件');
    assert.ok(!src.includes("spawn('cmd.exe'"), '不再 spawn cmd 轮询');
    assert.ok(typeof updater.buildRestartScript === 'function', '兼容导出仍在');
  });
});
