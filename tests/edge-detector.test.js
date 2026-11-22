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

// ==================== setOverlayActive（关于/欢迎页挂起，2026-10-11 BUG1） ====================

describe('setOverlayActive：模态 overlay 挂起自动隐藏', () => {
  test('active 时 _startHideTimer 不创建定时器', () => {
    const det = new EdgeDetector(makeWindowStub(false), null);
    det.isWindowVisible = true;
    det.setOverlayActive(true);
    det._startHideTimer();
    assert.strictEqual(det.hideTimerId, null);
  });

  test('active 取消已在跑的倒计时；关闭且鼠标在外恢复', () => {
    const det = new EdgeDetector(makeWindowStub(false), null);
    det.isWindowVisible = true;
    det._lastIsOverPanel = false;
    det._startHideTimer();
    assert.ok(det.hideTimerId, '前置：倒计时已启动');
    det.setOverlayActive(true);
    assert.strictEqual(det.hideTimerId, null, 'overlay 打开取消倒计时');
    det.setOverlayActive(false);
    assert.ok(det.hideTimerId, '关闭且鼠标在外恢复倒计时');
    det._cancelHideTimer(); // 清理句柄，避免 node:test 挂在定时器上
  });

  test('关闭且鼠标在面板上：不恢复倒计时', () => {
    const det = new EdgeDetector(makeWindowStub(false), null);
    det.isWindowVisible = true;
    det._lastIsOverPanel = true;
    det.setOverlayActive(true);
    det.setOverlayActive(false);
    assert.strictEqual(det.hideTimerId, null);
  });
});

// ==================== prepare 硬超时（2026-11-22 启动面板不弹出回归） ====================
// 实机证据：macOS 27.2 上 _showWindow 的 prepare 双 rAF 确认间歇性冻结 9s~146s
//（正常 0.79s），_showAnimationId 恒为 'pending' → 窗口永不 show + 轮询冻结
// →「启动后主面板不主动弹出」。prepare Promise 只处理 reject 不处理"永不 resolve"，
// 本组测试锚定：prepare 不确认时弹出链必须有界兜底，窗口必被显示。

function makeShowChainStub() {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    setMinimumSize: () => {},
    setIgnoreMouseEvents: () => {},
    setBounds: () => {},
    getBounds: () => ({ x: 100, y: 100, width: 340, height: 550 }),
    showInactive: () => calls.push('showInactive'),
    hide: () => {},
    webContents: {
      send: () => {},
      executeJavaScript: () => new Promise(() => {}), // 永不 resolve = prepare 卡死
    },
  };
  return { win, calls };
}

describe('prepare 硬超时：渲染层确认冻结时弹出链必须有界兜底（2026-11-22 回归）', () => {
  test('prepare 永不 resolve：show 链 ~800ms 内完成 showInactive + 过渡锁解除', async () => {
    const { win, calls } = makeShowChainStub();
    const det = new EdgeDetector(win, null);
    det.prepareFallbackMs = 80; // 测试加速；生产默认 900
    det.forceShow();
    // 最坏路径：80ms prepare 兜底 → +50ms → showInactive(~130ms) → 'in' 400ms 硬
    // 超时 → startIn 立 320ms 过渡锁 → ~850ms 解除。等 950ms 断言整条链有界完成。
    await new Promise((r) => setTimeout(r, 950));
    assert.ok(calls.includes('showInactive'), 'prepare 冻结时必须兜底 show 窗口（实际调用: ' + JSON.stringify(calls) + '）');
    assert.strictEqual(det._showAnimationId, null, '过渡锁须解除（轮询恢复）');
  });

  test('prepare 正常 resolve：走原链路，不受超时兜底影响', async () => {
    const { win, calls } = makeShowChainStub();
    win.webContents.executeJavaScript = () => Promise.resolve('paint-ready');
    const det = new EdgeDetector(win, null);
    det.forceShow();
    await new Promise((r) => setTimeout(r, 450)); // 等 320ms 过渡锁到期
    assert.ok(calls.includes('showInactive'), '正常确认路径照常显示');
    assert.strictEqual(det._showAnimationId, null, '过渡锁正常解除');
  });

  test('forceHide 在 prepare 冻结中：作废在途兜底，不误显示', async () => {
    const { win, calls } = makeShowChainStub();
    const det = new EdgeDetector(win, null);
    det.prepareFallbackMs = 80;
    det.forceShow();
    await new Promise((r) => setTimeout(r, 20));
    det.forceHide(); // 用户显式收起：代际递增后兜底不得再 show
    await new Promise((r) => setTimeout(r, 160));
    assert.ok(!calls.includes('showInactive'), 'forceHide 后在途兜底必须作废');
  });
});
