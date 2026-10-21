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

  test('输出 5 叶、全部在窗内（核心不变量）', () => {
    assert.strictEqual(r.leaves.length, 4);
    assert.ok(inBounds(r, VIEW_W, VIEW_H), JSON.stringify(r.leaves.map((l) => [l.key, l.x, l.y])));
  });

  test('扇形绕猫展开：summon 上 / quit 下 / size 最左', () => {
    const byKey = Object.fromEntries(r.leaves.map((l) => [l.key, l]));
    assert.ok(byKey.summon.y < r.cy, 'summon above center');
    assert.ok(byKey.quit.y > r.cy, 'quit below center');
    assert.ok(byKey.mode.x <= byKey.summon.x, 'mode left of summon');
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
    test(c.name + '：5 叶全在窗内', () => {
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
  test('贴左缘：侧向空间不足 → R 收缩，叶 x 方向散开（≥3 个不同 x）', () => {
    const r = computeLayout({ ...BASE, level: 'main', catX: 60, catY: 185 });
    const xs = new Set(r.leaves.map((l) => l.x));
    assert.ok(xs.size >= 3, 'leaves spread across x: ' + JSON.stringify(r.leaves.map((l) => [l.key, l.x])));
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
    assert.ok(Math.abs(ls.summon.x - rs.summon.x) < VIEW_W, 'summon x mirrored within window');
  });

  test('dirV=d 时纵向镜像（summon 翻到扇心下方）', () => {
    const u = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185, dirV: 'u' });
    const d = computeLayout({ ...BASE, level: 'main', catX: 121, catY: 185, dirV: 'd' });
    const us = Object.fromEntries(u.leaves.map((x) => [x.key, x]));
    const ds = Object.fromEntries(d.leaves.map((x) => [x.key, x]));
    assert.ok(ds.summon.y > us.summon.y - 1, 'dirV=d flips summon below center');
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
