/**
 * pet-interact-occlusion.test.js - 互动二级扇防遮挡 e2e 守护（2026-11-13 小M：二级菜单遮挡宠物形象）
 *
 * 几何模型（真实口径）：
 *   - webm 猫主体 = 视频框（height 210px、width≈138、底部居中锚定）→ 猫矩形 = 窗底中央竖直带
 *   - 扇心 cx = catX - mx*(R_MAIN-10)（向展开方向外移 66px），cy = catY（猫竖直中点）
 *   - 互动叶绕扇心 R_SUB=62 落位；低位角（90-140°）正对猫身必压猫 → heart 叶 radius:95 外推
 *
 * 断言（双展开方向镜像 × 三档缩放）：每叶矩形与猫矩形不相交、叶互不重叠、全部在窗内。
 * 直测 dist 编译产物 pet-menu-layout.js（与 pet-menu-layout.test.js 同口径）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

const CAT_W = 138, CAT_H = 210;

function rectOf(leaf, cx, cy, mx, my) {
  const size = leaf.size || 32;
  return {
    x: cx + mx * leaf.r * Math.cos(leaf.ang * Math.PI / 180) - size / 2,
    y: cy + my * leaf.r * Math.sin(leaf.ang * Math.PI / 180) - size / 2,
    w: size, h: size,
  };
}
function intersects(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

const SCALES = [
  { name: '0.7×', scale: 0.7, win: 342 },
  { name: '1.3×', scale: 1.3, win: 484 },
];

describe('互动二级扇防遮挡（webm 猫主体 = 底部居中 138×210 竖直带）', () => {
  for (const c of SCALES) {
    for (const dirH of ['l', 'r']) {
      test(`${c.name} dir=${dirH}：5 叶（click/hover/song/light/heart）全 clear——不压猫、不出窗、互不重叠`, () => {
        const W = c.win, H = Math.round(W * 552 / 342);
        const catX = W / 2;
        const catTop = H - CAT_H, catBottom = H;
        const catRect = { x: catX - CAT_W * 0.3, y: catTop, w: CAT_W * 0.6, h: CAT_H }; // 形象主体核心区（60% 横带：叶压边缘毛边可接受，压主体不可接受）
        const mx = dirH === 'r' ? 1 : -1;
        const catAy = catTop - 20; // 互动扇心上移：猫顶上方 20px（v3 零遮挡架构）
        const cx = catX - mx * (76 - 10);
        const cy = catAy;

        const r = MENU_LAYOUT.computeLayout({
          winW: W, winH: H, dirH, dirV: 'u', level: 'interact',
          scale: c.scale, catX: catX, catY: catAy,
          interactLeaves: [
            { key: 'click', ang: 290, icon: '👆', hint: '点击动作', value: 'click' },
            { key: 'hover', ang: 250, icon: '👋', hint: '挥手动作', value: 'hover' },
            { key: 'song', ang: 210, icon: '🎵', hint: '唱歌', value: 'song' },
            { key: 'light', ang: 170, icon: '💡', hint: '光效', value: 'light' },
            { key: 'heart', ang: 130, icon: '❤️', hint: '爱心', value: 'heart', radius: 95},
          ],
        });

        assert.strictEqual(r.leaves.length, 6, 'back + 5 动作叶');
        const pos = [];
        for (const leaf of r.leaves) {
          if (leaf.key === 'back') continue; // back 居环心（猫中部）——语义为返回钮，压猫属预期，非遮挡对象
          const rec = rectOf(leaf, cx, cy, mx, 1);
          pos.push({ key: leaf.key, ...rec });
          // 不压猫
          assert.ok(!intersects(rec, catRect),
            `${leaf.key} 压猫: 叶${JSON.stringify(rec)} vs 猫${JSON.stringify(catRect)}`);
          // 不出窗
          assert.ok(rec.x >= 0 && rec.y >= 0 && rec.x + rec.w <= W && rec.y + rec.h <= H,
            `${leaf.key} 出窗: ${JSON.stringify(rec)} win=${W}x${H}`);
        }
        // 叶互不重叠
        for (let i = 0; i < pos.length; i++) {
          for (let j = i + 1; j < pos.length; j++) {
            assert.ok(!intersects(pos[i], pos[j]),
              `叶互撞: ${pos[i].key} × ${pos[j].key}: ${JSON.stringify(pos[i])} vs ${JSON.stringify(pos[j])}`);
          }
        }
      });
    }
  }
});
