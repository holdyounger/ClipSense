/**
 * pet-ctx-pullback.test.js - 互动二级菜单出屏修复 v5.3（2026-11-15，TDD 红灯先行）
 *
 * 根因（v5.2 死代码实锤）：pet:expand-ctx 处理器以 `if (this._petCtxOpen) return;` 早退，
 * 而真实链路是「右键 → pet:open-ctx 置 _petCtxOpen=true → 主扇 → 点互动 → 才发 expand-ctx」
 * ——守卫恒真，拉回/扩窗从未执行 → 窗口部分出屏时互动叶不可见不可点。
 *
 * v5.3 语义：纯移动拉回（v4 教训：扩窗改窗口几何 → left:50%/bottom:0 锚定的猫必移动 +
 * 叶错位；窗口几何是渲染层锚定的根，不可动）。窗口尺寸/几何不动，只把越屏部分拉回工作区。
 *
 * 断言面：
 *   1) 纯函数面：dist/main/pet-manager.js 导出 computeCtxPullBack（屏内不动/四向拉回/
 *      负坐标副屏/窗大于屏兜底/纯移动不产尺寸）
 *   2) wiring 静态守卫：渲染层发 expand-ctx；主进程处理器无早退守卫、无 260 扩窗、
 *      不覆写 _petCtxSaved（close-ctx 仍还原用户拖拽位）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// 纯函数模块（红灯：computeCtxPullBack 尚不存在 → undefined → 全断言红灯）
const pm = require(path.join(ROOT, 'dist', 'main', 'pet-manager.js'));

const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const DISPLAY = { workArea: WA, workAreaSize: { width: WA.width, height: WA.height } };

describe('computeCtxPullBack 纯函数面（v5.3 纯移动拉回）', () => {
  test('导出存在且为函数', () => {
    assert.strictEqual(typeof pm.computeCtxPullBack, 'function', 'pet-manager 须导出 computeCtxPullBack');
  });

  test('窗口完全屏内：原位不动（moved=false）', () => {
    const b = { x: 1000, y: 600, width: 220, height: 220 };
    const r = pm.computeCtxPullBack(b, DISPLAY);
    assert.deepStrictEqual(r, { x: 1000, y: 600, moved: false });
  });

  test('右缘出屏：左拉到工作区右缘内侧', () => {
    const b = { x: 1800, y: 600, width: 220, height: 220 }; // 右缘 2020 > 1920
    const r = pm.computeCtxPullBack(b, DISPLAY);
    assert.strictEqual(r.x, 1920 - 220, 'x 钳到 wa.x+wa.width-W');
    assert.strictEqual(r.y, 600, 'y 不动');
    assert.strictEqual(r.moved, true);
  });

  test('底缘出屏：上拉到工作区下缘内侧', () => {
    const b = { x: 1000, y: 950, width: 220, height: 220 }; // 底缘 1170 > 1040
    const r = pm.computeCtxPullBack(b, DISPLAY);
    assert.strictEqual(r.x, 1000, 'x 不动');
    assert.strictEqual(r.y, 1040 - 220, 'y 钳到 wa.y+wa.height-H');
    assert.strictEqual(r.moved, true);
  });

  test('左/上出屏（负坐标）：拉到工作区左/上缘', () => {
    const r = pm.computeCtxPullBack({ x: -100, y: -50, width: 220, height: 220 }, DISPLAY);
    assert.strictEqual(r.x, 0);
    assert.strictEqual(r.y, 0);
    assert.strictEqual(r.moved, true);
  });

  test('负坐标副屏：相对该屏 workArea 钳制，屏内方向不漂移', () => {
    const NEG = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
    // x∈[-1800,-1580] 完全在副屏 [-1920,0] 内 → x 不动；y 底缘出屏 → 上拉
    const r = pm.computeCtxPullBack({ x: -1800, y: 900, width: 220, height: 220 }, NEG);
    assert.strictEqual(r.x, -1800, 'x 已屏内，不动');
    assert.strictEqual(r.y, 1040 - 220, 'y 钳到副屏下缘内侧');
    assert.strictEqual(r.moved, true);
    // 右缘出副屏：钳到副屏右缘（不漂到主屏 x>0）
    const r2 = pm.computeCtxPullBack({ x: -100, y: 500, width: 220, height: 220 }, NEG);
    assert.strictEqual(r2.x, -220, 'x 钳到副屏右缘内侧');
    assert.strictEqual(r2.y, 500, 'y 已屏内不动');
  });

  test('窗口大于工作区：钉到 workArea 左上角（兜底不丢）', () => {
    const SMALL = { workArea: { x: 0, y: 0, width: 200, height: 200 } };
    const r = pm.computeCtxPullBack({ x: 50, y: 50, width: 440, height: 440 }, SMALL);
    assert.strictEqual(r.x, 0);
    assert.strictEqual(r.y, 0);
    assert.strictEqual(r.moved, true);
  });

  test('纯移动语义：结果只含 x/y/moved，不含尺寸字段（窗口几何不可动）', () => {
    const r = pm.computeCtxPullBack({ x: 1800, y: 950, width: 220, height: 220 }, DISPLAY);
    assert.deepStrictEqual(Object.keys(r).sort(), ['moved', 'x', 'y']);
  });

  test('取整：入参小数落点返回整数（DIP 取整防 DPI 漂移，同 clampPetPosition 口径）', () => {
    const r = pm.computeCtxPullBack({ x: 1800.4, y: 950.6, width: 220, height: 220 }, DISPLAY);
    assert.strictEqual(r.x, Math.round(r.x));
    assert.strictEqual(r.y, Math.round(r.y));
  });
});

describe('expand-ctx wiring 静态守卫（v5.3：处理器可达 + 纯移动）', () => {
  const html = read('src/renderer/pet-stage.html');
  const index = read('src/main/index.ts');

  const handlerBlock = (() => {
    const start = index.indexOf("ipcMain.on('pet:expand-ctx'");
    assert.ok(start !== -1, 'index.ts 须保留 pet:expand-ctx 处理器');
    const end = index.indexOf("ipcMain.on('pet:close-ctx'", start);
    return index.slice(start, end);
  })();

  test('渲染层互动二级入口发送 pet:expand-ctx', () => {
    assert.ok(html.includes("ipcRenderer.send('pet:expand-ctx')"), 'renderInteractSub 须发 expand-ctx');
  });

  test('处理器不再以 _petCtxOpen 早退（v5.2 死代码根因）', () => {
    assert.ok(!/_petCtxOpen[^]*?return\s*;/.test(handlerBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
      'expand-ctx 处理器不得包含 _petCtxOpen 早退守卫——真实链路菜单已开，守卫恒真导致拉回永不执行');
  });

  test('处理器调用 computeCtxPullBack（纯移动拉回）', () => {
    assert.ok(handlerBlock.includes('computeCtxPullBack'), '处理器须经 computeCtxPullBack 计算落点');
  });

  test('处理器无 260 扩窗残留（v4 教训：扩窗致猫移动+叶错位）', () => {
    assert.ok(!handlerBlock.includes('260'), 'expand-ctx 不得再扩窗 260（窗口几何不可动）');
    assert.ok(!handlerBlock.includes('_setPetBoundsAnchored'), 'expand-ctx 不得走锚定扩窗路径');
  });

  test('处理器不覆写 _petCtxSaved（close-ctx 须还原用户拖拽位）', () => {
    assert.ok(!handlerBlock.includes('this._petCtxSaved ='), 'expand-ctx 不得覆写 _petCtxSaved');
  });
});
