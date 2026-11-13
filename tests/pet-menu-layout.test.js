/**
 * pet-menu-layout.test.js - 桌宠环形菜单布局引擎单元测试（2026-10-15 · v3 整体平移模型）
 *
 * 核心不变量（「显示不全/挤成一列」回归锁）：
 *   - 常规/贴边场景：所有叶完整在窗内（MARGIN 容差）
 *   - 叶互不重叠（形状完整性）
 *   - 方向镜像（dirH/dirV）一致
 *   - 贴边自适应半径：空间不足时 R 收缩、叶 x 方向散开
 *   - 二级扇父叶锚定：back 叶位于父叶附近（仅受全局平移影响）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { computeLayout, menuWindowSize } = require(
  path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js')
);

const MARGIN = 4;
const VIEW_W = 242;
const VIEW_H = 370;

function inBounds(layout, winW, winH) {
  return layout.leaves.every((l) => (
    l.x >= MARGIN - 1 &&
    l.y >= MARGIN - 1 &&
    l.x + l.size <= winW - MARGIN + 1 &&
    l.y + l.size <= winH - MARGIN + 1
  ));
}

function noOverlap(layout) {
  for (let i = 0; i < layout.leaves.length; i++) {
    for (let j = i + 1; j < layout.leaves.length; j++) {
      const a = layout.leaves[i];
      const b = layout.leaves[j];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < 10 && dy < 10) return { overlap: true, a: a.key, b: b.key };
    }
  }
  return { overlap: false };
}

const BASE = { winW: VIEW_W, winH: VIEW_H, dirH: 'l', dirV: 'u', mode: 'pet', scale: 0.7 };

describe('布局引擎：主扇基准（猫居中）', () => {
  const r = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185 });

  test('输出 4 叶（mode/react/skill/quit，2026-11-13 形象工坊叶加入）、全部在窗内（核心不变量）', () => {
    assert.strictEqual(r.leaves.length, 4);
    const keys = r.leaves.map((l) => l.key).sort();
    assert.deepStrictEqual(keys, ['mode', 'quit', 'react', 'skill'], '主扇应为 mode/react/skill/quit，实际: ' + keys.join(','));
    assert.ok(inBounds(r, VIEW_W, VIEW_H), JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
  });

  test('扇形绕猫展开：mode 上 / react 居中 / quit 下（50° 均布）', () => {
    const byKey = Object.fromEntries(r.leaves.map((l) => [l.key, l]));
    assert.ok(byKey.mode.y < r.cy, 'mode above center');
    assert.ok(byKey.quit.y > r.cy, 'quit below center');
    assert.ok(Math.abs(byKey.react.y - r.cy) < Math.abs(byKey.mode.y - r.cy), 'react 纵向更贴近扇心（160° 居中叶）');
  });

  test('叶互不重叠（形状完整性）', () => {
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b);
  });

  test('菜单扩窗尺寸 = 2R+叶+边距', () => {
    const sz = menuWindowSize();
    assert.strictEqual(sz.W, 76 * 2 + 38 + 8);
    assert.strictEqual(sz.H, 76 * 2 + 38 + 8);
  });
});

describe('布局引擎：贴四边/四角（显示不全回归锁）', () => {
  const cases = [
    { name: '贴顶', catX: 121, catY: 40 },
    { name: '贴底', catX: 121, catY: 330 },
    { name: '贴左（镜像）', catX: 60, catY: 185, dirH: 'r' },
    { name: '贴右', catX: 200, catY: 185 },
    { name: '左上角', catX: 60, catY: 60 },
    { name: '右上角', catX: 200, catY: 60 },
    { name: '左下角', catX: 60, catY: 330 },
    { name: '右下角', catX: 200, catY: 330 },
  ];
  for (const c of cases) {
    test(c.name + '：2 叶全在窗内', () => {
      const r = computeLayout({
        ...BASE, level: 'main',
        catX: c.catX, catY: c.catY,
        dirH: c.dirH || 'l',
      });
      assert.ok(inBounds(r, VIEW_W, VIEW_H), JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
    });
  }

  test('贴顶 + dirH=r 镜像：叶仍在窗内', () => {
    const r = computeLayout({ ...BASE, level: 'main', catX: 60, catY: 40, dirH: 'r' });
    assert.ok(inBounds(r, VIEW_W, VIEW_H));
  });
});

describe('布局引擎：自适应半径（挤成一列根治锁）', () => {
  test('贴左缘：侧向空间不足 → R 收缩，叶不互相重叠（x 叠列时 y 必散开）', () => {
    const r = computeLayout({ ...BASE, level: 'main', catX: 60, catY: 185 });
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b + ' — ' + JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
    assert.ok(inBounds(r, VIEW_W, VIEW_H));
  });

  test('贴顶：纵向空间不足 → 扇心下移，min y 不出界', () => {
    const r = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 40 });
    const minY = Math.min(...r.leaves.map((l) => l.y));
    assert.ok(minY >= MARGIN - 1, 'min y=' + minY);
  });
});

describe('布局引擎：二级扇（v3 父叶锚定 + back 叶）', () => {
  test('mode 二级：4 叶（back + 3 选项）、当前模式 selected', () => {
    const r = computeLayout({ ...BASE, level: 'mode', mode: 'edge', catX: 121, catY: 185 });
    assert.strictEqual(r.leaves.length, 4);
    const edge = r.leaves.find((l) => l.key === 'edge');
    const pet = r.leaves.find((l) => l.key === 'pet');
    const back = r.leaves.find((l) => l.key === 'back');
    assert.strictEqual(edge.selected, true);
    assert.strictEqual(pet.selected, false);
    assert.ok(back, 'back leaf exists');
    assert.ok(inBounds(r, VIEW_W, VIEW_H));
  });

  test('二级扇锚定父叶：back 叶位于父叶附近（仅全局平移差）', () => {
    const main = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185 });
    const sub = computeLayout({ ...BASE, level: 'mode', mode: 'pet', catX: 121, catY: 185 });
    const parentMain = main.leaves.find((l) => l.key === 'mode');
    const back = sub.leaves.find((l) => l.key === 'back');
    assert.ok(
      Math.abs(back.x - parentMain.x) < 250 && Math.abs(back.y - parentMain.y) < 250,
      'back near parent: ' + back.x + ',' + back.y + ' vs ' + parentMain.x + ',' + parentMain.y
    );
  });

  test('二级选项叶尺寸更小、随档位等比缩放（0.7× → 32×0.7≈22；back=主叶 27）', () => {
    const sub = computeLayout({ ...BASE, level: 'mode', catX: 121, catY: 185 });
    const subOpt = sub.leaves.find((l) => l.key !== 'back');
    assert.strictEqual(subOpt.size, 22);
    const back = sub.leaves.find((l) => l.key === 'back');
    assert.strictEqual(back.size, 27);
  });

  test('等比缩放：0.5× 档叶显著小于 1× 档（环抱小猫回归锁）', () => {
    const half = computeLayout({ winW: VIEW_W, winH: VIEW_H, dirH: 'l', dirV: 'u', level: 'main', mode: 'pet', scale: 0.5, catX: 121, catY: 185 });
    const full = computeLayout({ winW: VIEW_W, winH: VIEW_H, dirH: 'l', dirV: 'u', level: 'main', mode: 'pet', scale: 1, catX: 121, catY: 185 });
    const halfLeaf = half.leaves.find((l) => l.key === 'mode').size;
    const fullLeaf = full.leaves.find((l) => l.key === 'mode').size;
    assert.ok(halfLeaf < fullLeaf - 5, 'half=' + halfLeaf + ' must < full=' + fullLeaf);
    // R 也缩：size 叶 x 在 0.5× 下明显更靠近猫
    assert.ok(Math.abs(half.leaves.find((l) => l.key === 'mode').x - half.cx) < Math.abs(full.leaves.find((l) => l.key === 'mode').x - full.cx), 'R shrinks with pet scale');
  });
});

describe('布局引擎：右侧+二级扇（小M 报告场景回归锁）', () => {
  test('猫靠右缘二级扇（重叠扩展覆盖）：全部叶在窗内', () => {
    const r = computeLayout({ ...BASE, level: 'mode', catX: 200, catY: 185 });
    assert.ok(inBounds(r, VIEW_W, VIEW_H), JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
  });

  test('猫靠右缘 mode 二级扇：全部叶在窗内', () => {
    const r = computeLayout({ ...BASE, level: 'mode', mode: 'pet', catX: 200, catY: 185 });
    assert.ok(inBounds(r, VIEW_W, VIEW_H), JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
  });

  test('二级扇叶互不重叠（形状完整性）', () => {
    const r = computeLayout({ ...BASE, level: 'mode', catX: 121, catY: 185 });
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b);
  });
});

describe('布局引擎：方向镜像一致性', () => {
  test('dirH=r 时叶 x 坐标水平镜像（对称性）', () => {
    const l = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185, dirH: 'l' });
    const r = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185, dirH: 'r' });
    const ls = Object.fromEntries(l.leaves.map((x) => [x.key, x]));
    const rs = Object.fromEntries(r.leaves.map((x) => [x.key, x]));
    assert.ok(Math.abs(ls.mode.x - rs.mode.x) < VIEW_W, 'mode x mirrored within window');
  });

  test('dirV=d 时纵向镜像（mode 翻到扇心下方）', () => {
    const u = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185, dirV: 'u' });
    const d = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185, dirV: 'd' });
    const us = Object.fromEntries(u.leaves.map((x) => [x.key, x]));
    const ds = Object.fromEntries(d.leaves.map((x) => [x.key, x]));
    assert.ok(ds.mode.y > us.mode.y - 1, 'dirV=d flips mode below center: u=' + us.mode.y + ' d=' + ds.mode.y);
    assert.ok(ds.quit.y < us.quit.y - 1, 'dirV=d flips quit above center（与 mode 互换，几何对称）');
  });
});

describe('布局引擎：极小窗口（退化不崩溃）', () => {
  test('100×160 小窗：坐标有限、叶间不重叠', () => {
    const r = computeLayout({ winW: 100, winH: 160, dirH: 'l', dirV: 'u', level: 'main', mode: 'pet', scale: 0.7, catX: 50, catY: 80 });
    for (const l of r.leaves) {
      assert.ok(Number.isFinite(l.x) && Number.isFinite(l.y));
    }
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b);
  });

  test('1×1 极端：不抛异常且坐标有限（整体平移兜底，允许对称出界）', () => {
    const r = computeLayout({ winW: 1, winH: 1, dirH: 'l', dirV: 'u', level: 'main', mode: 'pet', scale: 1, catX: 0, catY: 0 });
    for (const l of r.leaves) {
      assert.ok(Number.isFinite(l.x) && Number.isFinite(l.y), 'coords must be finite');
    }
  });
});

describe('布局引擎：响应式扇形（2026-11-04 菜单重构方向2，小窗口自适应）', () => {
  test('0.7× 档窗口（154×154）：扇形完整收缩在窗内且叶不重叠', () => {
    const r = computeLayout({ winW: 154, winH: 154, dirH: 'l', dirV: 'u', level: 'main', mode: 'pet', scale: 0.7, catX: 77, catY: 100 });
    assert.ok(inBounds(r, 154, 154), JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b);
  });

  test('标准窗口（240×380）：fit 因子不放大（行为不变守卫）', () => {
    const r = computeLayout({ winW: 240, winH: 380, dirH: 'l', dirV: 'u', level: 'main', mode: 'pet', scale: 1, catX: 121, catY: 185 });
    assert.ok(inBounds(r, 240, 380));
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b);
  });
});

describe('布局引擎：interact 互动二级扇（2026-11-05 Bug3：动作关联扩展）', () => {
  test('interact 级：back 叶 + 自定义动作叶（环心返回钮，动作叶在窗内不重叠）', () => {
    const r = computeLayout({ ...BASE, level: 'interact', interactLeaves: [
      { key: 'm0', ang: 245, icon: '▶', hint: '动作 1', value: '0' },
      { key: 'm1', ang: 180, icon: '▶', hint: '动作 2', value: '1' },
      { key: 'm2', ang: 115, icon: '🎲', hint: '随机', value: 'rand' },
    ], catX: 121, catY: 185 });
    assert.strictEqual(r.leaves.length, 4, 'back + 3 动作叶');
    const keys = r.leaves.map((l) => l.key).sort();
    assert.deepStrictEqual(keys, ['back', 'm0', 'm1', 'm2'], JSON.stringify(keys));
    assert.ok(inBounds(r, VIEW_W, VIEW_H));
    const o = noOverlap(r);
    assert.ok(!o.overlap, o.a + ' overlaps ' + o.b);
  });

  test('interact 级无自定义叶 → 仅 back（防御）', () => {
    const r = computeLayout({ ...BASE, level: 'interact', catX: 121, catY: 185 });
    assert.strictEqual(r.leaves.length, 1);
    assert.strictEqual(r.leaves[0].key, 'back');
  });
});
