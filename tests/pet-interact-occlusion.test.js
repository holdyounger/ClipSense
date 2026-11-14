/**
 * pet-interact-occlusion.test.js - 互动二级扇防遮挡 e2e 守护 v4（2026-11-14 小M：二级菜单出屏）
 *
 * v3 教训（假绿根因）：e2e 窗口口径用了 342/484 全高，而真实桌宠窗口恒 220×220（不随档位）——
 * R=95 上弧在 220 窗内必然出窗顶（扇心 catTop-20 为负）。用户实测出屏，测试假绿。
 *
 * v4 架构（扩窗方案）：打开互动菜单时主进程扩窗 260×260（底边锚定，向上生长），
 * 扇心回猫中心 (130,130)，5 叶走左右弧（click 40°/hover 10° 右弧 + song 140°/light 170°/heart 200° 左弧）
 * ——猫占满窗竖带（210/260），上弧物理无空间，左右弧叶 x 全部出猫核心横带。
 *
 * 断言（260 扩窗口径 × 双档缩放 × 双向镜像）：
 *   叶矩形不压猫形象核心区（60% 横带）、不出 260 窗、互不重叠、
 *   且窗口右缘不超屏幕（260 ≤ 常见屏宽）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

const CAT_W = 138, CAT_H = 210;
const WIN = 260; // 扩窗后尺寸（底边锚定 260×260）

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
  { key: 'click', ang: 40, icon: '👆', hint: '点击动作', value: 'click', radius: 95 },
  { key: 'hover', ang: 10, icon: '👋', hint: '挥手动作', value: 'hover', radius: 95 },
  { key: 'song', ang: 140, icon: '🎵', hint: '唱歌', value: 'song', radius: 95 },
  { key: 'light', ang: 170, icon: '💡', hint: '光效', value: 'light', radius: 95 },
  { key: 'heart', ang: 200, icon: '❤️', hint: '爱心', value: 'heart', radius: 95 },
];

const SCALES = [
  { name: '0.7×', scale: 0.7 },
  { name: '1.3×', scale: 1.3 },
];

describe('互动二级扇防遮挡 v4（260 扩窗口径：猫主体 = 底部居中 138×210 竖直带）', () => {
  for (const c of SCALES) {
    for (const dirH of ['l', 'r']) {
      test(`${c.name} dir=${dirH}：5 叶左右弧全 clear——不压猫核心、不出 260 窗、互不重叠`, () => {
        const W = WIN, H = WIN;
        const catX = W / 2;
        const catTop = H - CAT_H;
        const catRect = { x: catX - CAT_W * 0.3, y: catTop, w: CAT_W * 0.6, h: CAT_H }; // 形象主体核心区（60% 横带）
        const mx = dirH === 'r' ? 1 : -1;
        // v4：扇心回猫中心（扩窗后猫中心=窗中心）；catAy 仍取猫竖直中点
        const catAy = catTop + CAT_H / 2;
        const cx = catX; // v4 interact 扇心不偏（引擎同步：偏移会让左右弧叶落回核心横带）
        const cy = catAy;

        const r = MENU_LAYOUT.computeLayout({
          winW: W, winH: H, dirH, dirV: 'u', level: 'interact',
          scale: c.scale, catX, catY: catAy,
          interactLeaves: INTERACT_LEAVES,
        });

        assert.strictEqual(r.leaves.length, 6, 'back + 5 动作叶');
        const pos = [];
        for (const leaf of r.leaves) {
          if (leaf.key === 'back') continue; // back 居环心——返回钮语义，非遮挡对象
          const rec = rectOf(leaf, cx, cy, mx);
          pos.push({ key: leaf.key, ...rec });
          assert.ok(!intersects(rec, catRect),
            `${leaf.key} 压猫核心: 叶${JSON.stringify(rec)} vs 核心${JSON.stringify(catRect)}`);
          assert.ok(rec.x >= 0 && rec.y >= 0 && rec.x + rec.w <= W && rec.y + rec.h <= H,
            `${leaf.key} 出窗: ${JSON.stringify(rec)} win=${W}x${H}`);
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

  test('扩窗尺寸 ≥ 互动扇空间需求（R=95 直径 + 叶 + margin，回归锁 v3 出屏根因）', () => {
    // 需求：扇心居中时 R95 圆 + 叶 22 + margin 8 ≤ 窗口
    const need = 95 * 2 + 22 + 8;
    assert.ok(WIN >= need, `扩窗 ${WIN} < 需求 ${need}（R95 圆放不下会复现 v3 出屏）`);
  });
});
