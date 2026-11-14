/**
 * pet-interact-occlusion.test.js - 互动二级扇防遮挡 e2e 守护 v5（2026-11-14 小M：扩窗致桌宠移动+菜单错位）
 *
 * v4 教训：扩窗改窗口几何 → left:50%/bottom:0 锚定的猫必然随窗移动（用户实测「桌宠位置会移动」）
 * + 叶相对猫错位（「全部挪到上边」）。窗口几何是渲染层锚定的根，不可动。
 *
 * v5 架构：窗口恒 220×220 不动；互动叶走左右弧（click 40°/hover 10° 右弧 + song 140°/light 170°/heart 200° 左弧），
 * 半径由引擎自适应反推 R88（可用半宽 - 叶半 - margin，双档同值），叶 x 全部出猫核心横带。
 *
 * 断言（220 真实窗口径 × 双档 × 双向镜像）：
 *   叶矩形不压猫形象核心区（60% 横带）、不出 220 窗（含 4px margin）、互不重叠。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

const CAT_W = 138, CAT_H = 210;
const WIN = 220; // 真实桌宠窗口（恒定，不随档位/菜单变化——v4 扩窗已撤）

function rectOf(leaf, cx, cy, mx) {
  const size = leaf.size || 32;
  return {
    x: cx + mx * leaf.r * Math.cos(leaf.ang * Math.PI / 180) - size / 2,
    y: cy + leaf.r * Math.sin(leaf.ang * Math.PI / 180) - size / 2,
    w: size, h: size,
  };
}
function intersects(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

const INTERACT_LEAVES = [
  { key: 'click', ang: 40, icon: '👆', hint: '点击动作', value: 'click' },
  { key: 'hover', ang: 10, icon: '👋', hint: '挥手动作', value: 'hover' },
  { key: 'song', ang: 140, icon: '🎵', hint: '唱歌', value: 'song' },
  { key: 'light', ang: 170, icon: '💡', hint: '光效', value: 'light' },
  { key: 'heart', ang: 200, icon: '❤️', hint: '爱心', value: 'heart' },
];

const SCALES = [
  { name: '0.7×', scale: 0.7 },
  { name: '1.3×', scale: 1.3 },
];

describe('互动二级扇防遮挡 v5（220 真实窗口径：猫主体 = 底部居中 138×210 竖直带）', () => {
  for (const c of SCALES) {
    for (const dirH of ['l', 'r']) {
      test(`${c.name} dir=${dirH}：5 叶左右弧全 clear——不压猫核心、不出 220 窗、互不重叠`, () => {
        const W = WIN, H = WIN;
        const catX = W / 2;
        const catTop = H - CAT_H;
        const catRect = { x: catX - CAT_W * 0.3, y: catTop, w: CAT_W * 0.6, h: CAT_H }; // 形象主体核心区（60% 横带）
        const mx = dirH === 'r' ? 1 : -1;
        const catAy = catTop + CAT_H / 2;

        const r = MENU_LAYOUT.computeLayout({
          winW: W, winH: H, dirH, dirV: 'u', level: 'interact',
          scale: c.scale, catX, catY: catAy,
          interactLeaves: INTERACT_LEAVES,
        });

        assert.strictEqual(r.leaves.length, 6, 'back + 5 动作叶');
        const pos = [];
        for (const leaf of r.leaves) {
          if (leaf.key === 'back') continue; // back 居环心——返回钮语义，非遮挡对象
          const rec = rectOf(leaf, r.cx, r.cy, mx);
          pos.push({ key: leaf.key, ...rec });
          assert.ok(!intersects(rec, catRect),
            `${leaf.key} 压猫核心: 叶${JSON.stringify(rec)} vs 核心${JSON.stringify(catRect)}`);
          assert.ok(rec.x >= 4 && rec.y >= 4 && rec.x + rec.w <= W - 4 && rec.y + rec.h <= H - 4,
            `${leaf.key} 出窗(含margin): ${JSON.stringify(rec)} win=${W}x${H}`);
        }
        for (let i = 0; i < pos.length; i++) {
          for (let j = i + 1; j < pos.length; j++) {
            assert.ok(!intersects(pos[i], pos[j]),
              `叶互撞: ${pos[i].key} × ${pos[j].key}: ${JSON.stringify(pos[i])} vs ${JSON.stringify(pos[j])}`);
          }
        }
      });
    }
  }

  test('窗口尺寸回归锁：互动叶落位不得依赖窗口扩窗（v4 教训——扩窗致猫移动）', () => {
    // 引擎在 220 窗与 342 窗下对同角度叶的落位半径应一致（自适应半径不随窗口膨胀）
    const r220 = MENU_LAYOUT.computeLayout({
      winW: 220, winH: 220, dirH: 'l', dirV: 'u', level: 'interact', scale: 1, catX: 110, catY: 115,
      interactLeaves: INTERACT_LEAVES,
    });
    const r342 = MENU_LAYOUT.computeLayout({
      winW: 342, winH: 552, dirH: 'l', dirV: 'u', level: 'interact', scale: 1, catX: 110, catY: 115,
      interactLeaves: INTERACT_LEAVES,
    });
    for (const l220 of r220.leaves) {
      const l342 = r342.leaves.find((l) => l.key === l220.key);
      assert.strictEqual(l220.r, l342.r, `${l220.key} 半径不应随窗口变化（radius 稳定性）`);
    }
  });
});
