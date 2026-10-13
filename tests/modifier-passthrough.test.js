/**
 * modifier-passthrough.test.js - 修饰键按住穿透状态机单元测试（2026-10-13）
 *
 * 覆盖 createModifierPassthrough 纯逻辑：2 拍防抖确认、快速点按抖动吸收、
 * 边沿只在翻转拍报告、异常/非布尔探针值归一 false、reset 清态。
 * 状态机键位无关（探针注入）：当前触发键 = Alt（index.ts 探针决定），
 * 本文件不锚定键位——换键无需改这里。
 * 直测 dist 编译产物（统一切换后口径：改 .ts 后先 tsc 再测）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createModifierPassthrough, MODIFIER_DEBOUNCE_TICKS } = require(
  path.join(__dirname, '..', 'dist', 'main', 'modifier-passthrough.js')
);

/** 便捷：按序列喂拍，返回 changed 序列 */
function feedTicks(smb, seq) {
  return seq.map((down) => smb.tick({ isDown: () => down }));
}

describe('修饰键穿透状态机：防抖与边沿', () => {
  test('常量：防抖拍数为 2（100ms 轮询 × 2 = 200ms 确认窗）', () => {
    assert.strictEqual(MODIFIER_DEBOUNCE_TICKS, 2);
  });

  test('按住 2 拍确认开启；第 1 拍不翻转（防抖窗）', () => {
    const smb = createModifierPassthrough();
    const r1 = smb.tick({ isDown: () => true });
    assert.equal(r1.changed, false, '第 1 拍未达防抖拍数，不翻转');
    assert.equal(r1.active, false);
    const r2 = smb.tick({ isDown: () => true });
    assert.equal(r2.changed, true, '第 2 拍确认翻转');
    assert.equal(r2.active, true);
    assert.equal(smb.isActive(), true);
  });

  test('开启后持续按住：边沿只报告一次，后续拍 changed=false', () => {
    const smb = createModifierPassthrough();
    feedTicks(smb, [true, true]);
    const results = feedTicks(smb, [true, true, true]);
    assert.ok(results.every((r) => r.changed === false), '持续同态不重复报告边沿');
    assert.ok(results.every((r) => r.active === true));
  });

  test('释放 2 拍确认关闭', () => {
    const smb = createModifierPassthrough();
    feedTicks(smb, [true, true]);
    const r1 = smb.tick({ isDown: () => false });
    assert.equal(r1.changed, false, '释放第 1 拍不翻转');
    const r2 = smb.tick({ isDown: () => false });
    assert.equal(r2.changed, true, '释放第 2 拍确认关闭');
    assert.equal(r2.active, false);
    assert.equal(smb.isActive(), false);
  });

  test('快速点按抖动（<200ms 单拍脉冲）全程不翻转', () => {
    const smb = createModifierPassthrough();
    // 按一拍松一拍交替：每段都不满连续 2 拍，confirmed 恒 false
    const results = feedTicks(smb, [true, false, true, false, true, false, true, false]);
    assert.ok(results.every((r) => r.changed === false), '抖动不得触发透传切换');
    assert.equal(smb.isActive(), false);
  });

  test('按住 → 抖动一次 → 继续按住：确认不被抖动清零重计', () => {
    const smb = createModifierPassthrough();
    feedTicks(smb, [true, true]); // 已确认开启
    const mid = feedTicks(smb, [false, true]); // 单拍抖动
    assert.ok(mid.every((r) => r.changed === false), '开启态下单拍抖动不翻转');
    assert.equal(smb.isActive(), true, '生效态保持');
  });

  test('非布尔返回值归一 false（探针异常时功能自动禁用）', () => {
    const smb = createModifierPassthrough();
    const results = feedTicks(smb, [undefined, null, 0, '']);
    assert.ok(results.every((r) => r.changed === false && r.active === false),
      'undefined/null/0/空串均按未按下处理');
  });

  test('reset() 清态：确认态归零，重新确认需再满 2 拍', () => {
    const smb = createModifierPassthrough();
    feedTicks(smb, [true, true]);
    assert.equal(smb.isActive(), true);
    smb.reset();
    assert.equal(smb.isActive(), false, 'reset 后立即查询为未生效');
    const r1 = smb.tick({ isDown: () => true });
    assert.equal(r1.changed, false, 'reset 后第 1 拍不确认（残留拍数不跨越）');
    const r2 = smb.tick({ isDown: () => true });
    assert.equal(r2.changed, true, 'reset 后仍需满 2 拍才确认');
  });

  test('reset 后残留 pending 计数不导致单拍误确认（窗口隐藏复位语义）', () => {
    const smb = createModifierPassthrough();
    smb.tick({ isDown: () => true }); // pending 计 1 拍（未确认）
    smb.reset(); // 模拟窗口隐藏复位
    const r = smb.tick({ isDown: () => true });
    assert.equal(r.changed, false, 'reset 必须清掉 pending 计数：单拍不得跨越确认');
  });
});
