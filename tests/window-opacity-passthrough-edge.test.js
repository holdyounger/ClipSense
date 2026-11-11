'use strict';

/**
 * window-opacity-passthrough-edge.test.js - Alt 穿透透明度边界用例（2026-11-02 快速通道验证）
 *
 * 独立测试工程师补充（小M 授权测试文件新增，不改 src/）：
 * 覆盖开发侧 5 用例之外的边界：
 *   1. reset() 后 isActive()=false → computeOpacity 不含穿透项（与真实
 *      状态机联动，模拟「窗口隐藏/模块停用 → 复位不透明」链路）；
 *   2. passthroughActive 与 pinned 同时激活 → 取小值 0.5（穿透优先）；
 *   3. 防抖未确认（tick 中间拍）不影响透明度口径 —— isActive() 语义锚定。
 * 直测 dist 编译产物（统一切换后口径：改 .ts 后先 tsc 再测，与既有测试同构）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { computeOpacity, OPACITY_PASSTHROUGH, OPACITY_GHOST } = require(
  path.join(__dirname, '..', 'dist', 'main', 'window-opacity.js')
);
const { createModifierPassthrough } = require(
  path.join(__dirname, '..', 'dist', 'main', 'modifier-passthrough.js')
);

describe('Alt 穿透透明度边界用例（独立验证补充）', () => {
  test('reset() 后 isActive()=false → computeOpacity 不含穿透项（复位回归不透明）', () => {
    const sm = createModifierPassthrough();
    // 先确认激活：连续 2 拍 isDown=true（MODIFIER_DEBOUNCE_TICKS=2）
    sm.tick({ isDown: () => true });
    sm.tick({ isDown: () => true });
    assert.strictEqual(sm.isActive(), true, '前置：2 拍后应确认激活');
    assert.strictEqual(
      computeOpacity({ passthroughActive: sm.isActive() }),
      OPACITY_PASSTHROUGH,
      '激活中 → 0.5'
    );
    // reset（窗口隐藏/模块停用链路）
    sm.reset();
    assert.strictEqual(sm.isActive(), false, 'reset 后应回到未激活');
    assert.strictEqual(
      computeOpacity({ passthroughActive: sm.isActive() }),
      1,
      'reset 后透出原值：不含穿透项 → 不透明 1.0'
    );
  });

  test('passthroughActive 与 pinned 同时激活 → 取小值 0.5（穿透优先于固定 0.6）', () => {
    assert.strictEqual(
      computeOpacity({ pinned: true, passthroughActive: true }),
      Math.min(0.6, OPACITY_PASSTHROUGH)
    );
    assert.strictEqual(computeOpacity({ pinned: true, passthroughActive: true }), 0.5);
  });

  test('防抖中间拍（1/2 拍）不确认 → isActive()=false → 透明度不降', () => {
    const sm = createModifierPassthrough();
    sm.tick({ isDown: () => true }); // 第 1 拍：pending，未确认
    assert.strictEqual(sm.isActive(), false, '防抖未满 2 拍不确认');
    assert.strictEqual(computeOpacity({ passthroughActive: sm.isActive() }), 1);
  });

  test('穿透激活 + 倒计时起点（remaining=total=1.0）→ 取小值 0.5', () => {
    assert.strictEqual(
      computeOpacity({ isCountingDown: true, remainingMs: 5000, totalMs: 5000, passthroughActive: true }),
      0.5
    );
  });

  test('OPACITY_PASSTHROUGH 落在既有档位之间（0.4 < 0.5 < 0.6）', () => {
    assert.ok(OPACITY_GHOST < OPACITY_PASSTHROUGH && OPACITY_PASSTHROUGH < 0.6);
  });
});
