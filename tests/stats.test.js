/**
 * stats.test.js - 剪贴板统计与等级模块·纯函数层用例（2026-11-05 L3 红灯先行）
 *
 * Spec : Docs/spec-统计与等级模块-2026-11-05.md（S1-S5 自动化面）
 * 被测：src/main/stats.ts（纯函数 record/computeLevel/computeProgress/prune/summarize
 *       + StatsStore 文件 IO 容错）——零 electron 依赖，node:test 直测。
 *
 * 用例映射：S1（复制计数）/ S2（粘贴计数）/ S3（streak 语义）/ S4（滚动清理）/ S5（等级计算）
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stats = require(path.join(__dirname, '..', 'dist', 'main', 'stats.js'));

// ==================== S1/S2：计数语义 ====================

describe('S1/S2 计数语义（record 纯函数）', () => {
  test('S1：复制 N 次 → days[today].copy=N 且 total.copy=N', () => {
    let st = Stats.emptyStats();
    for (let i = 0; i < 42; i++) st = Stats.record(st, 'copy', '2026-11-05');
    assert.strictEqual(st.days['2026-11-05'].copy, 42);
    assert.strictEqual(st.total.copy, 42);
    assert.strictEqual(st.total.paste, 0);
  });

  test('S2：粘贴 +1（独立维度，不影响 copy/streak）', () => {
    let st = Stats.emptyStats();
    st = Stats.record(st, 'copy', '2026-11-05');
    const streakBefore = st.streak.current;
    st = Stats.record(st, 'paste', '2026-11-05');
    assert.strictEqual(st.days['2026-11-05'].paste, 1);
    assert.strictEqual(st.total.paste, 1);
    assert.strictEqual(st.days['2026-11-05'].copy, 1, 'paste 不得污染 copy 维度');
    assert.strictEqual(st.streak.current, streakBefore, 'paste 不续签 streak（spec：打卡锚在复制）');
  });

  test('多日分桶：不同日期键各自计数', () => {
    let st = Stats.emptyStats();
    st = Stats.record(st, 'copy', '2026-11-04');
    st = Stats.record(st, 'copy', '2026-11-05');
    st = Stats.record(st, 'copy', '2026-11-05');
    assert.strictEqual(st.days['2026-11-04'].copy, 1);
    assert.strictEqual(st.days['2026-11-05'].copy, 2);
    assert.strictEqual(st.total.copy, 3);
  });
});

// ==================== S3：streak 语义 ====================

describe('S3 streak 语义（连续/断签/峰值）', () => {
  test('连续两日有复制 → current=2', () => {
    let st = Stats.emptyStats();
    st = Stats.record(st, 'copy', '2026-11-04');
    st = Stats.record(st, 'copy', '2026-11-05');
    assert.strictEqual(st.streak.current, 2);
    assert.strictEqual(st.streak.best, 2);
    assert.strictEqual(st.streak.lastActiveDate, '2026-11-05');
  });

  test('断签（>1 天缺口）→ 清零重计 1，best 保留峰值', () => {
    let st = Stats.emptyStats();
    st = Stats.record(st, 'copy', '2026-11-01');
    st = Stats.record(st, 'copy', '2026-11-02'); // current=2 best=2
    st = Stats.record(st, 'copy', '2026-11-05'); // 断签（02→05 缺 2 天）→ 重计 1
    assert.strictEqual(st.streak.current, 1);
    assert.strictEqual(st.streak.best, 2, 'best 保留历史峰值');
  });

  test('同日多次复制不重复续签（lastActiveDate 幂等）', () => {
    let st = Stats.emptyStats();
    st = Stats.record(st, 'copy', '2026-11-05');
    st = Stats.record(st, 'copy', '2026-11-05');
    st = Stats.record(st, 'copy', '2026-11-05');
    assert.strictEqual(st.streak.current, 1);
  });
});

// ==================== S4：滚动清理 ====================

describe('S4 滚动清理（90 天护栏）', () => {
  test('91 天数据 → 保留最近 90 天，removed=1；total/streak 不受影响', () => {
    let st = Stats.emptyStats();
    // 生成 91 天（2026-08-01 起）
    const start = new Date(2026, 7, 1);
    let lastKey = '';
    for (let i = 0; i < 91; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = Stats.dateKey(d);
      st = Stats.record(st, 'copy', key);
      st = Stats.record(st, 'paste', key);
      lastKey = key;
    }
    const pr = Stats.prune(st, lastKey, Stats.DAYS_KEEP);
    assert.strictEqual(Object.keys(pr.stats.days).length, 90, '保留 90 天');
    assert.strictEqual(pr.removed, 1);
    assert.strictEqual(pr.stats.total.copy, 91, 'total 不受清理影响');
    assert.strictEqual(pr.stats.streak.current, 91, 'streak 不受清理影响');
  });
});

// ==================== S5：等级计算 ====================

describe('S5 等级计算（computeLevel/computeProgress 纯函数）', () => {
  test('阈值边界：49 → Lv1；50 → Lv2；150 → Lv3', () => {
    assert.strictEqual(Stats.computeLevel(49).level, 1);
    assert.strictEqual(Stats.computeLevel(50).level, 2);
    assert.strictEqual(Stats.computeLevel(150).level, 3);
  });

  test('封顶：2250 → Lv10；远超仍 Lv10（满环 nextNeed=0）', () => {
    const lv10 = Stats.computeLevel(2250);
    assert.strictEqual(lv10.level, 10);
    assert.strictEqual(lv10.nextNeed, 0);
    assert.strictEqual(Stats.computeLevel(99999).level, 10);
  });

  test('称号表：Lv1 收集学徒 / Lv3 整理行家 / Lv10 剪贴板传奇', () => {
    assert.strictEqual(Stats.computeLevel(0).title, '收集学徒');
    assert.strictEqual(Stats.computeLevel(150).title, '整理行家');
    assert.strictEqual(Stats.computeLevel(2250).title, '剪贴板传奇');
  });

  test('computeProgress：0.7 档进度与封顶满环', () => {
    // Lv3 起点 50，下一级需 100 → exp=120 进度 (120-50)/100 = 0.7
    assert.ok(Math.abs(Stats.computeProgress(120) - 0.7) < 1e-9);
    assert.strictEqual(Stats.computeProgress(2250), 1);
    assert.strictEqual(Stats.computeProgress(0), 0);
  });

  test('非法输入防呆：负数/NaN → Lv1 进度 0', () => {
    assert.strictEqual(Stats.computeLevel(-5).level, 1);
    assert.strictEqual(Stats.computeLevel(NaN).level, 1);
    assert.strictEqual(Stats.computeProgress(NaN), 0);
  });
});

// ==================== StatsStore 文件 IO（容错 + 原子写） ====================

describe('StatsStore 文件 IO（spec 红线：统计损坏不影响剪贴板数据）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipense-stats-'));
  const statsPath = path.join(tmpDir, 'clipboard-stats.json');

  test('load：文件不存在 → 空结构', () => {
    const store = new Stats.StatsStore(statsPath);
    const d = store.load();
    assert.strictEqual(d.total.copy, 0);
  });

  test('record → save 落盘 → 新实例 load 读回一致', () => {
    const store = new Stats.StatsStore(statsPath);
    store.load();
    store.record('copy', '2026-11-05');
    store.record('paste', '2026-11-05');
    const store2 = new Stats.StatsStore(statsPath);
    const d = store2.load();
    assert.strictEqual(d.days['2026-11-05'].copy, 1);
    assert.strictEqual(d.days['2026-11-05'].paste, 1);
  });

  test('损坏文件容错：load 解析失败 → 空结构不抛错', () => {
    fs.writeFileSync(statsPath, '{{{broken json');
    const store = new Stats.StatsStore(statsPath);
    const d = store.load();
    assert.strictEqual(d.total.copy, 0, '损坏 → 空结构重新开始（spec 红线）');
  });

  test('summarize：辅助行/hover 卡消费形态', () => {
    let st = Stats.emptyStats();
    for (let i = 0; i < 55; i++) st = Stats.record(st, 'copy', '2026-11-05'); // 55 → Lv2
    st = Stats.record(st, 'paste', '2026-11-05');
    const s = Stats.summarize(st, '2026-11-05');
    assert.strictEqual(s.level, 2);
    assert.strictEqual(s.title, '归档助手');
    assert.strictEqual(s.todayCopy, 55);
    assert.strictEqual(s.todayPaste, 1);
    assert.ok(s.progress > 0 && s.progress < 1);
  });
});
