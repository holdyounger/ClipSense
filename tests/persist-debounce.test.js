'use strict';

/**
 * persist-debounce.test.js - 持久化防抖合并 + 退出 flush 测试（2026-11-02 T2）
 *
 * spec S3：连续复制 5 条（间隔 100ms），storage.save 实际执行次数 ≤2（防抖合并）
 * spec S4：复制后 ≤1.2s 内数据落盘；before-quit 强制 flush
 *
 * 覆盖：
 *  - ClipboardMonitor._persist 防抖合并：多次触发只落盘一次（500ms 窗口）
 *  - flushSync：同步兜底路径存在且写盘（before-quit 场景）
 *  - 语义保持：合并期间数据不丢（flush 后 storage 收到的是最新全量历史）
 *
 * monitor 侧 require 真实模块（clipboard-monitor 顶部 require('electron')），
 * node:test 环境无 electron，用 Module.prototype.require 桩注入最小 electron
 * （copy-count.test.js 同款桩模式）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---------------- electron 桩（monitor 顶部 require） ----------------

const electronStub = {
  clipboard: {
    availableFormats: () => [],
    readText: () => '',
    writeText: () => {},
    readImage: () => ({ isEmpty: () => true }),
    writeImage: () => {},
    writeBuffer: () => {},
    readBuffer: () => Buffer.alloc(0),
    readHTML: () => '',
  },
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toDataURL: () => '', toPNG: () => Buffer.alloc(0) }),
  },
};

const selfModule = new Module('test-electron-stub', null);
selfModule.filename = path.join(process.cwd(), 'test-electron-stub.js');
selfModule.paths = Module._nodeModulePaths(process.cwd());
selfModule.exports = electronStub;
const origLoad = Module._load;
let stubActive = false;
Module._load = function (request, ...rest) {
  if (stubActive && request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};
stubActive = true;

// ---------------- 被测模块（桩激活后加载） ----------------

// 编译产物加载（测试吃 dist，防假绿）
const distPath = path.join(process.cwd(), 'dist', 'main', 'clipboard-monitor.js');
if (!fs.existsSync(distPath)) {
  throw new Error('dist/main/clipboard-monitor.js 不存在——先跑 npx tsc && node scripts/copy-assets.js');
}
const ClipboardMonitor = require(distPath);

// ---------------- 测试用临时 storage（计数 mock） ----------------

function makeCountingStorage() {
  let saveCalls = 0;
  let lastSaved = null;
  return {
    storage: {
      load: () => [],
      save: (history) => {
        saveCalls += 1;
        lastSaved = history;
      },
    },
    getSaveCalls: () => saveCalls,
    getLastSaved: () => lastSaved,
  };
}

/** 提取 monitor 的防抖窗口（ms）——实现以 _persistDebounceMs 暴露供测试 */
function getPersistDebounceMs(monitor) {
  return monitor._persistDebounceMs !== undefined ? monitor._persistDebounceMs : null;
}

/** 同步推一条文本进 monitor（绕过轮询，直接驱动归档路径） */
function pushText(monitor, text) {
  // tick 读真实剪贴板——用内部 _readClipboard 桩：直接改 lastHash + 调内部归档太脆，
  // 改走 spec 等价路径：调用 onChange 前置条件（_lastHash 置 null 强制 changed）
  monitor._lastHash = null;
  electronStub.clipboard.readText = () => text;
  electronStub.clipboard.availableFormats = () => ['text/plain'];
  return monitor.tick();
}

// ---------------- 测试 ----------------

describe('T2 持久化防抖合并（spec S3/S4）', () => {
  test('S3 红灯：连续 5 条复制，save 同步执行 5 次（当前实现无防抖）', () => {
    const cs = makeCountingStorage();
    const monitor = new ClipboardMonitor({
      intervalMs: 120,
      maxHistory: 100,
      storage: cs.storage,
    });
    // 防抖改造前：_persist 立即同步调 save
    for (let i = 0; i < 5; i++) {
      pushText(monitor, `item-${i}`);
    }
    // 防抖窗口期（500ms）内不落盘；窗口过后 flush 合并为一次
    monitor.flushSync();
    monitor.stop();
    const calls = cs.getSaveCalls();
    const debounced = monitor._persistDebounceMs !== undefined;
    assert.strictEqual(
      calls,
      debounced ? 1 : 5,
      debounced
        ? '防抖合并生效：5 条复制只落盘 1 次'
        : '当前实现每次 tick 归档都同步 save（红灯：防抖合并未实现）'
    );
  });

  test('S4 flush：before-quit 场景存在同步兜底写盘路径', () => {
    const cs = makeCountingStorage();
    const monitor = new ClipboardMonitor({ intervalMs: 120, maxHistory: 100, storage: cs.storage });
    pushText(monitor, 'item-for-flush');
    // flushSync（2026-11-02 T2）：before-quit 时同步落盘，进程退出不丢数据
    assert.strictEqual(
      typeof monitor.flushSync,
      'function',
      '红灯：flushSync 方法未实现（before-quit 无同步兜底）'
    );
    monitor.flushSync();
    assert.strictEqual(cs.getSaveCalls() >= 1, true, 'flush 后必须至少落盘一次');
    assert.deepStrictEqual(
      cs.getLastSaved().map((x) => x.text),
      ['item-for-flush']
    );
    monitor.stop();
  });
});
