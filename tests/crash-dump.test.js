/**
 * crash-dump.test.js - 异常快照采集（2026-10-11）
 *
 * 纯函数（buildExceptionLines/writeTextSnapshot/rotateCrashLogs）直接单测；
 * startCrashReporter 用 electron 桩（crashReporter spy）验证 uploadToServer=false。
 * 加载 dist 编译产物（统一切换后测试锚定产物）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const crashDump = require(path.join(__dirname, '..', 'dist', 'main', 'crash-dump.js'));

// ---------------- startCrashReporter（electron 桩） ----------------

test('startCrashReporter：本地保存不上传（隐私数据不出机器）', () => {
  let called = null;
  const electronStub = { crashReporter: { start: (o) => { called = o; } } };
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electronStub : orig.apply(this, arguments);
  };
  try {
    crashDump.startCrashReporter();
    assert.ok(called, 'crashReporter.start 被调用');
    assert.strictEqual(called.uploadToServer, false);
  } finally {
    Module.prototype.require = orig;
  }
});

// ---------------- buildExceptionLines ----------------

describe('buildExceptionLines 快照构建', () => {
  test('Error 对象：含类型/消息/堆栈', () => {
    const lines = crashDump.buildExceptionLines('uncaughtException', new TypeError('x is not a function'));
    const text = lines.join('\n');
    assert.match(text, /类型: uncaughtException/);
    assert.match(text, /错误: TypeError: x is not a function/);
    assert.match(text, /堆栈:/);
  });

  test('非 Error 详情 + 应用状态 JSON', () => {
    const lines = crashDump.buildExceptionLines('render-process-gone', 'killed (exitCode=7)', { version: '1.0.12' });
    const text = lines.join('\n');
    assert.match(text, /详情: killed \(exitCode=7\)/);
    assert.match(text, /"version": "1\.0\.12"/);
  });

  test('无状态时省略状态段', () => {
    const text = crashDump.buildExceptionLines('t', new Error('e')).join('\n');
    assert.ok(!text.includes('应用状态'), '无 state 则无状态段');
  });
});

// ---------------- writeTextSnapshot / rotateCrashLogs ----------------

describe('writeTextSnapshot / rotateCrashLogs', () => {
  test('写入带时间戳文件名并返回路径，内容完整', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-test-'));
    try {
      const file = crashDump.writeTextSnapshot(dir, 'uncaughtException', ['line1', 'line2']);
      assert.ok(file.startsWith(dir), '落在 logDir 内');
      assert.ok(/\.log$/.test(file), '.log 扩展名');
      assert.ok(fs.readFileSync(file, 'utf8').includes('line2'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('轮转：按文件名倒序保留最新 keep 个', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-test-'));
    try {
      // 构造字典序递增的时间戳命名（与 writeTextSnapshot 命名规则同构）
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(dir, `uncaughtException_2020-01-0${i}_00-00-00-000.log`), 'x');
      }
      crashDump.rotateCrashLogs(dir, 2);
      const left = fs.readdirSync(dir).sort();
      assert.deepStrictEqual(left, [
        'uncaughtException_2020-01-04_00-00-00-000.log',
        'uncaughtException_2020-01-05_00-00-00-000.log',
      ], '只留最新 2 个');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('轮转：目录不存在时不抛错', () => {
    assert.doesNotThrow(() => crashDump.rotateCrashLogs(path.join(os.tmpdir(), 'no-such-dir-xyz'), 2));
  });
});
