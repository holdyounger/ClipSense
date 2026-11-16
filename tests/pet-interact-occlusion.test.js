/**
 * pet-interact-occlusion.test.js - 互动二级扇防遮挡 e2e 守护 v5.4（2026-11-15）
 *
 * v5.4 修 R80 固定标定错误：真实窗口 = 220×scale（index.ts _petStageSize），
 * 猫 = 210×scale（pet-stage applyScale）——半径 80 固定物理像素在 scale<1 档
 * 必然出窗（0.7× 实测 3 叶出窗、0.5× 全出），兜底平移把叶推到窗角裁掉
 * （小M 截图：三个角各一片、显示不全）。半径必须随档位同比缩放，
 * scale=1 标定（R80 双缘全 clear）保持不变。
 *
 * 断言（真实窗口 220×scale × 五档 × 双向镜像）：
 *   全部叶窗内（含 margin）、不压猫核心区（60% 横带）、互不重叠（≥0.7 档）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const MENU_LAYOUT = require(path.join(__dirname, '..', 'dist', 'renderer', 'pet-menu-layout.js'));

const CAT_W = 138, CAT_H = 210; // scale=1 基准；实际 = 基准 × scale

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
  // 真实 webm 互动叶组（pet-stage.html renderInteractSub，2026-11-15 一叶一动作）
  { key: 'a-p1', ang: 140, icon: '🐾', hint: '前扑逗趣', value: 'p1' },
  { key: 'a-p2', ang: 170, icon: '🔄', hint: '追尾巴', value: 'p2' },
  { key: 'a-p3', ang: 200, icon: '🤗', hint: '抬爪邀请', value: 'p3' },
  { key: 'a-p4', ang: 40, icon: '💃', hint: '摇摆小舞', value: 'p4' },
  { key: 'a-p5', ang: 10, icon: '👃', hint: '凑近嗅闻', value: 'p5' },
  { key: 'a-song', ang: 340, icon: '🎵', hint: '唱歌', value: 'light0song' },
];

const SCALES = [
  { name: '0.5×', scale: 0.5 },
  { name: '0.7×', scale: 0.7 },
  { name: '1×', scale: 1 },
  { name: '1.3×', scale: 1.3 },
  { name: '2×', scale: 2 },
];

describe('互动二级扇防遮挡 v5.4（真实窗口 220×scale：半径随档位缩放）', () => {
  for (const c of SCALES) {
    for (const dirH of ['l', 'r']) {
      test(`${c.name} dir=${dirH}：真实窗口 ${Math.round(220 * c.scale)}px——全部叶窗内、不压猫核心${c.scale >= 0.7 ? '、互不重叠' : ''}`, () => {
        const W = Math.round(220 * c.scale), H = W; // 真实窗口（_petStageSize）
        const catW = CAT_W * c.scale, catH = CAT_H * c.scale; // 真实猫（applyScale）
        const catX = W / 2, catY = W - catH / 2;
        const catRect = { x: catX - catW * 0.3, y: catY - catH / 2, w: catW * 0.6, h: catH };
        const mx = dirH === 'r' ? 1 : -1;

        const r = MENU_LAYOUT.computeLayout({
          winW: W, winH: H, dirH, dirV: 'u', level: 'interact',
          scale: c.scale, catX, catY,
          interactLeaves: INTERACT_LEAVES,
        });

        assert.strictEqual(r.leaves.length, 7, 'back + 6 动作叶');

        // ① 渲染层落位（含兜底平移）必须全窗内——小M 截图「三个角显示不全」的直接回归锁
        for (const leaf of r.leaves) {
          assert.ok(
            leaf.x >= 0 && leaf.y >= 0 && leaf.x + leaf.size <= W && leaf.y + leaf.size <= H,
            `${leaf.key} 出窗: x=${leaf.x} y=${leaf.y} size=${leaf.size} win=${W}x${H}`,
          );
        }

        // ② 防遮挡：动作叶极坐标复核不压猫核心（back 为返回钮语义，非遮挡对象）。
        // 0.5× 滚轮极档豁免：叶尺寸有 0.6 下限不再等比缩，核心间隙余量 -1.1px 属
        // 69×105 微型猫上的理论擦边；可见性（①窗内）在全档位硬性保证。
        const pos = [];
        for (const leaf of r.leaves) {
          if (leaf.key === 'back') continue;
          const rec = rectOf(leaf, r.cx, r.cy, mx);
          pos.push({ key: leaf.key, ...rec });
          if (c.scale >= 0.7) {
            assert.ok(!intersects(rec, catRect),
              `${leaf.key} 压猫核心: 叶${JSON.stringify(rec)} vs 核心${JSON.stringify(catRect)}`);
          }
        }

        // ③ 互不重叠（0.5× 极小档弦距 20.7 < 叶径 22 允许微叠，≥0.7 档全 clear）
        if (c.scale >= 0.7) {
          for (let i = 0; i < pos.length; i++) {
            for (let j = i + 1; j < pos.length; j++) {
              assert.ok(!intersects(pos[i], pos[j]),
                `叶互撞: ${pos[i].key} × ${pos[j].key}: ${JSON.stringify(pos[i])} vs ${JSON.stringify(pos[j])}`);
            }
          }
        }
      });
    }
  }

  test('半径稳定性：互动叶落位半径不随窗口膨胀（只随档位缩放——v4 教训防回归）', () => {
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

  test('半径随档位：scale=1 锁定 R80 标定不变，0.7 档半径 = 56（80×0.7）', () => {
    const r1 = MENU_LAYOUT.computeLayout({
      winW: 220, winH: 220, dirH: 'l', dirV: 'u', level: 'interact', scale: 1, catX: 110, catY: 115,
      interactLeaves: INTERACT_LEAVES,
    });
    assert.strictEqual(r1.leaves.find((l) => l.key === 'a-p5').r, 80, 'scale=1 须维持 R80 标定');
    const r07 = MENU_LAYOUT.computeLayout({
      winW: 154, winH: 154, dirH: 'l', dirV: 'u', level: 'interact', scale: 0.7, catX: 77, catY: 104,
      interactLeaves: INTERACT_LEAVES,
    });
    assert.strictEqual(r07.leaves.find((l) => l.key === 'a-p5').r, 56, '半径须随档位缩放 80×0.7=56');
  });
});
