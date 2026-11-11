/**
 * stats-trend.test.js - 趋势 tab 数据纯函数测试（2026-11-11）
 *
 * 直测 dist 编译产物（与 pet-interaction.test.js 同口径：先 npm run build:ts 再测）。
 * last7Days：today 在前、缺失日补零、日期严格递减；summarize 载荷携带 last7。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const st = require(path.join(__dirname, '..', 'dist', 'main', 'stats.js'));

const DKEY = '2026-11-11';
const mkStats = (days) => ({
  version: 1,
  days: days,
  total: { copy: 10, paste: 4 },
  streak: { current: 2, best: 5, lastActiveDate: DKEY },
});

describe('last7Days 趋势数据（趋势 tab 数据源）', () => {
  test('返回 7 条、今天在前、日期严格递减', () => {
    const out = st.last7Days(mkStats({}), DKEY);
    assert.strictEqual(out.length, 7);
    assert.strictEqual(out[0].key, DKEY);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].key > out[i].key, '日期应严格递减');
    }
  });

  test('缺失日补零；命中日映射 copy/paste', () => {
    const out = st.last7Days(
      mkStats({ [DKEY]: { copy: 3, paste: 1 }, '2026-11-09': { copy: 2, paste: 5 } }),
      DKEY,
    );
    assert.strictEqual(out[0].copy, 3);
    assert.strictEqual(out[0].paste, 1);
    const d09 = out.find((x) => x.key === '2026-11-09');
    assert.strictEqual(d09.copy, 2);
    assert.strictEqual(d09.paste, 5);
    const d10 = out.find((x) => x.key === '2026-11-10');
    assert.strictEqual(d10.copy, 0);
    assert.strictEqual(d10.paste, 0);
  });

  test('summarize 载荷携带 last7（趋势 tab 数据源）', () => {
    const s = st.summarize(mkStats({ [DKEY]: { copy: 3, paste: 1 } }), DKEY);
    assert.ok(Array.isArray(s.last7) && s.last7.length === 7);
    assert.strictEqual(s.last7[0].copy, 3);
  });
});
