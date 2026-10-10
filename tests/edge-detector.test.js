/**
 * edge-detector.test.js - EdgeDetector 销毁防护回归
 *
 * 背景（2026-10-10 实机报错）：托盘应用关窗后 mainWindow 已销毁、应用驻留托盘，
 * 100ms 轮询继续跑——_checkMousePosition 入口无 isDestroyed 早退时，
 * 每拍在 getBounds() 抛 "Object has been destroyed"，控制台被
 * [EdgeDetector] 检测错误 刷屏。
 * 本文件锚定：销毁后轮询早退空转（不触碰窗口对象）；存活路径不受影响。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// ---------------- electron 桩（edge-detector 顶层 require screen） ----------------
const screenStub = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1080 },
  }),
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  return id === 'electron' ? { screen: screenStub } : origRequire.apply(this, arguments);
};
const EdgeDetector = require(path.join(__dirname, '..', 'dist', 'main', 'edge-detector.js'));
Module.prototype.require = origRequire;

/** 窗口桩：记录 getBounds 触达次数；destroyed 控制销毁态 */
function makeWindowStub(destroyed) {
  let boundsCalls = 0;
  return {
    isDestroyed: () => destroyed,
    getBounds: () => { boundsCalls++; return { x: 100, y: 100, width: 340, height: 550 }; },
    get boundsCalls() { return boundsCalls; },
    webContents: { send: () => {}, executeJavaScript: () => Promise.resolve(0) },
  };
}

describe('EdgeDetector 销毁防护（2026-10-10 报错修复）', () => {
  test('mainWindow 已销毁：轮询早退空转，不触碰 getBounds', () => {
    const det = new EdgeDetector(makeWindowStub(true), null);
    assert.doesNotThrow(() => det._checkMousePosition());
    assert.strictEqual(det.mainWindow.boundsCalls, 0, '销毁后不得触碰 getBounds');
  });

  test('mainWindow 存活：轮询照常执行（getBounds 被触达）', () => {
    const det = new EdgeDetector(makeWindowStub(false), null);
    assert.doesNotThrow(() => det._checkMousePosition());
    assert.ok(det.mainWindow.boundsCalls >= 1, '存活窗口轮询行为不变');
  });

  test('mainWindow 为 null：轮询早退不抛错', () => {
    const det = new EdgeDetector(null, null);
    assert.doesNotThrow(() => det._checkMousePosition());
  });

  test('销毁后 stop() 复位路径不抛错（before-quit 清理安全）', () => {
    const det = new EdgeDetector(makeWindowStub(true), null);
    det.start();
    assert.doesNotThrow(() => det.stop());
  });
});
