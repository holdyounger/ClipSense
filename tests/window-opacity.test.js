'use strict';

/**
 * window-opacity.test.js - 两段式窗口透明度纯函数测试（2026-09-30）
 *
 * 规则：固定 → 80%；非固定倒计时 → 1.0 线性降至 0.4（可透视档）；其余不透明。
 * computeOpacity 为纯函数，node:test 直测（无 electron 依赖）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  OPACITY_PINNED, OPACITY_GHOST, OPAQUE, computeOpacity,
} = require(path.join(__dirname, '..', 'src', 'main', 'window-opacity.js'));

const EPS = 1e-9;

describe('常量（拍板值锚定）', () => {
  test('固定 0.6 / 可透视 0.4 / 不透明 1', () => {
    assert.strictEqual(OPACITY_PINNED, 0.6);
    assert.strictEqual(OPACITY_GHOST, 0.4);
    assert.strictEqual(OPAQUE, 1);
  });
});

describe('computeOpacity 规则 1：固定 → 80%', () => {
  test('pinned=true 恒 0.6（即使倒计时字段异常也优先固定）', () => {
    assert.strictEqual(computeOpacity({ pinned: true }), 0.6);
    assert.strictEqual(computeOpacity({ pinned: true, isCountingDown: true, remainingMs: 500, totalMs: 3000 }), 0.6);
    assert.strictEqual(computeOpacity({ pinned: true, isCountingDown: true, remainingMs: NaN, totalMs: -1 }), 0.6);
  });
});

describe('computeOpacity 规则 2：倒计时线性 1.0 → 0.4', () => {
  const T = 3000;
  test('起点 remaining=total → 1.0（不透明）', () => {
    assert.ok(Math.abs(computeOpacity({ isCountingDown: true, remainingMs: T, totalMs: T }) - 1) < EPS);
  });

  test('中点 remaining=total/2 → 0.7（线性插值）', () => {
    assert.ok(Math.abs(computeOpacity({ isCountingDown: true, remainingMs: T / 2, totalMs: T }) - 0.7) < EPS);
  });

  test('终点 remaining=0 → 0.4（可透视档）', () => {
    assert.ok(Math.abs(computeOpacity({ isCountingDown: true, remainingMs: 0, totalMs: T }) - 0.4) < EPS);
  });

  test('remaining 越界钳制：>total 按 1.0、<0 按 0.4', () => {
    assert.ok(Math.abs(computeOpacity({ isCountingDown: true, remainingMs: T + 9999, totalMs: T }) - 1) < EPS);
    assert.ok(Math.abs(computeOpacity({ isCountingDown: true, remainingMs: -50, totalMs: T }) - 0.4) < EPS);
  });

  test('不同总时长同比例同结果（3s vs 30s 均为线性）', () => {
    const a = computeOpacity({ isCountingDown: true, remainingMs: 1500, totalMs: 3000 });
    const b = computeOpacity({ isCountingDown: true, remainingMs: 15000, totalMs: 30000 });
    assert.ok(Math.abs(a - b) < EPS);
  });
});

describe('computeOpacity 非固定非倒计时 → 不透明', () => {
  test('空参/false 场景恒 1', () => {
    assert.strictEqual(computeOpacity({}), 1);
    assert.strictEqual(computeOpacity({ isCountingDown: false }), 1);
    assert.strictEqual(computeOpacity(undefined), 1);
    assert.strictEqual(computeOpacity(null), 1);
  });

  test('isCountingDown=true 但 totalMs 非法 → 按终点保守处理（0.4）', () => {
    assert.strictEqual(computeOpacity({ isCountingDown: true, remainingMs: 100, totalMs: 0 }), 0.4);
    assert.strictEqual(computeOpacity({ isCountingDown: true, remainingMs: 100, totalMs: NaN }), 0.4);
    assert.strictEqual(computeOpacity({ isCountingDown: true }), 0.4);
  });

  test('输出恒在 [0.4, 1] 区间（扫描采样）', () => {
    for (let ms = -500; ms <= 3500; ms += 100) {
      const v = computeOpacity({ isCountingDown: true, remainingMs: ms, totalMs: 3000 });
      assert.ok(v >= OPACITY_GHOST - EPS && v <= OPAQUE + EPS, `ms=${ms} → ${v}`);
    }
  });
});
