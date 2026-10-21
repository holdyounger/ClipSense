/**
 * pet-manager.test.js - 桌宠模式纯逻辑单元测试（P0 spike，2026-10-13）
 *
 * 覆盖 pet-manager 全部导出：舞台定位（右下角 + 叶子边距 + workAreaSize 兜底）、
 * 模式规范化（旧配置无键回落 edge）、拖拽 clamp（拖不丢 + 取整）、自动回位判定。
 * 直测 dist 编译产物（统一切换后口径：改 .ts 后先 tsc 再测）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { STAGE, buildPetStageBounds, normalizeHideMode, clampPetPosition, shouldAutoRespawn } = require(
  path.join(__dirname, '..', 'dist', 'main', 'pet-manager.js')
);

const DISPLAY_1920 = {
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  workAreaSize: { width: 1920, height: 1040 },
};
const DISPLAY_NEG = { // 副屏负坐标虚拟桌面
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
  workAreaSize: { width: 1920, height: 1040 },
};

describe('桌宠舞台定位 buildPetStageBounds', () => {
  test('主屏右下角：贴 workArea 右缘 + 下缘，留 LEAF 边距，尺寸 = STAGE', () => {
    const b = buildPetStageBounds(DISPLAY_1920);
    assert.strictEqual(b.x, 1920 - STAGE.W - STAGE.LEAF, 'x = 右缘 - 舞台宽 - 叶子距');
    assert.strictEqual(b.y, 1040 - STAGE.H - STAGE.LEAF, 'y = 下缘 - 舞台高 - 叶子距');
    assert.strictEqual(b.width, STAGE.W);
    assert.strictEqual(b.height, STAGE.H);
  });

  test('负坐标副屏：锚定该屏 workArea 右下（不漂到主屏）', () => {
    const b = buildPetStageBounds(DISPLAY_NEG);
    assert.strictEqual(b.x, -1920 + 1920 - STAGE.W - STAGE.LEAF);
    assert.strictEqual(b.y, 1040 - STAGE.H - STAGE.LEAF);
  });

  test('workAreaSize 缺省：回退 workArea 宽高（electron Display 两形态兼容）', () => {
    const b = buildPetStageBounds({ workArea: { x: 10, y: 20, width: 800, height: 600 } });
    assert.strictEqual(b.x, 10 + 800 - STAGE.W - STAGE.LEAF);
    assert.strictEqual(b.y, 20 + 600 - STAGE.H - STAGE.LEAF);
  });

  test('坐标取整：非整数 workArea 不产生半像素漂移', () => {
    const b = buildPetStageBounds({ workArea: { x: 0.5, y: 0.5, width: 1000.4, height: 800.6 } });
    assert.ok(Number.isInteger(b.x) && Number.isInteger(b.y), 'x/y 恒整数');
  });
});

describe('隐藏模式规范化 normalizeHideMode', () => {
  test('三合法值原样通过', () => {
    assert.strictEqual(normalizeHideMode('pet'), 'pet');
    assert.strictEqual(normalizeHideMode('edge'), 'edge');
    assert.strictEqual(normalizeHideMode('hidden'), 'hidden');
  });
  test('非法/缺省值安全回落 edge（旧配置文件无 hideMode 键）', () => {
    assert.strictEqual(normalizeHideMode(undefined), 'edge');
    assert.strictEqual(normalizeHideMode(null), 'edge');
    assert.strictEqual(normalizeHideMode(''), 'edge');
    assert.strictEqual(normalizeHideMode('PET'), 'edge', '大小写敏感，防意外宽匹配');
    assert.strictEqual(normalizeHideMode(42), 'edge');
  });
});

describe('桌宠拖拽 clampPetPosition', () => {
  test('屏内正常落点原样返回（取整）', () => {
    const p = clampPetPosition(500.4, 300.6, DISPLAY_1920);
    assert.deepStrictEqual(p, { x: 500, y: 301 });
  });

  test('拖出右缘：钳回保底 LEAF 可见', () => {
    const p = clampPetPosition(1920 + 500, 300, DISPLAY_1920);
    assert.strictEqual(p.x, 1920 - STAGE.LEAF, '右缘钳制 = workArea 右缘 - LEAF');
  });

  test('拖出左缘：舞台大部分在外仍保 LEAF 条可见（拖不丢）', () => {
    const p = clampPetPosition(-STAGE.W, 300, DISPLAY_1920);
    assert.strictEqual(p.x, -STAGE.W + STAGE.LEAF);
  });

  test('拖出下缘/上缘同理', () => {
    const bottom = clampPetPosition(500, 1040 + 400, DISPLAY_1920);
    assert.strictEqual(bottom.y, 1040 - STAGE.LEAF);
    const top = clampPetPosition(500, -STAGE.H, DISPLAY_1920);
    assert.strictEqual(top.y, -STAGE.H + STAGE.LEAF);
  });

  test('负坐标副屏：clamp 以该屏 workArea 为基准', () => {
    const p = clampPetPosition(-1920 - 999, 300, DISPLAY_NEG);
    assert.strictEqual(p.x, -1920 - STAGE.W + STAGE.LEAF);
  });
});

describe('自动回位判定 shouldAutoRespawn', () => {
  const PANEL = { x: 1500, y: 200, width: 340, height: 550 };

  test('桌宠中心被面板覆盖：回位', () => {
    const petX = 1500 + 100, petY = 200 + 200; // 中心落在面板内
    assert.strictEqual(shouldAutoRespawn(petX, petY, PANEL), true);
  });

  test('桌宠在面板外：不回位', () => {
    assert.strictEqual(shouldAutoRespawn(100, 800, PANEL), false);
  });

  test('仅边缘搭接（中心在面板外）：不回位', () => {
    const petX = PANEL.x + PANEL.width - 10, petY = PANEL.y + PANEL.height - 10;
    assert.strictEqual(shouldAutoRespawn(petX, petY, PANEL), false);
  });
});
