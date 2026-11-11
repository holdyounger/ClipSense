/**
 * stats.ts - 剪贴板统计与等级模块（2026-11-05 spec-统计与等级模块-2026-11-05）
 *
 * 职责边界（与 pet-manager/header-hover 同构）：纯数据层——记录/查询/滚动清理/等级计算
 * 零 electron 依赖，node --test 直测；文件 IO 由轻封装承担（fs 同步，小文件）。
 *
 * 设计要点（spec §一/§二）：
 *   - 数据被动积累：复制入库 +1 copy、双击粘贴成功 +1 paste，零主动采集
 *   - clipboard-stats.json 独立文件（与历史文件解耦：统计损坏不影响剪贴板数据）
 *   - days 滚动保留 90 天（启动/写入时清理，体积恒定）
 *   - streak：当日有行为 +1，断签清零重计，best 保留峰值
 *   - 等级：exp = total.copy，线性曲线 Lv n→n+1 需 50×n，上限 Lv10（累计 2250）
 *
 * 导出形态：export = 单导出（与 storage/pet-manager 同构）。
 */

const fs = require('fs');

const STATS_VERSION = 1;
const DAYS_KEEP = 90;       // days 滚动保留天数
const LEVEL_MAX = 10;       // 等级上限
const LEVEL_STEP = 50;      // 每级递增基数：Lv n→n+1 需 50×n

/** 等级称号表（index 0 = Lv1；ClipSense 剪贴板拟物主题命名） */
const LEVEL_TITLES = [
  '收集学徒', '归档助手', '整理行家', '效率专员', '剪贴达人',
  '流水大师', '信息管家', '剪贴专家', '极速档案官', '剪贴板传奇',
];

/** 当日日期键（本地时区 YYYY-MM-DD；可注入替换用于测试） */
function dateKey(d?: Date): string {
  const dt = d instanceof Date ? d : new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 等级纯函数：exp（累计复制数）→ { level, title, curBase, nextNeed }；封顶 Lv10 满环 */
function computeLevel(exp: number): { level: number; title: string; curBase: number; nextNeed: number } {
  const e = typeof exp === 'number' && isFinite(exp) && exp > 0 ? Math.floor(exp) : 0;
  let level = 1;
  let acc = 0; // 进入 level 所需累计
  while (level < LEVEL_MAX && e >= acc + LEVEL_STEP * level) {
    acc += LEVEL_STEP * level;
    level += 1;
  }
  const nextNeed = level >= LEVEL_MAX ? 0 : LEVEL_STEP * level;
  return {
    level: level,
    title: LEVEL_TITLES[level - 1],
    curBase: acc,               // 当前等级起点累计
    nextNeed: nextNeed,         // 距下一级还需（0 = 已封顶）
  };
}

/** 升级进度纯函数：0..1（环 dashoffset / 进度条共用）；封顶恒 1 */
function computeProgress(exp: number): number {
  if (typeof exp !== 'number' || !isFinite(exp)) return 0; // 防呆（红灯 S5：NaN 透传 Math.min/max）
  const lv = computeLevel(exp);
  if (lv.nextNeed === 0) return 1;
  return Math.min(1, Math.max(0, (exp - lv.curBase) / lv.nextNeed));
}

/** 空统计结构 */
function emptyStats() {
  return {
    version: STATS_VERSION,
    days: {},
    total: { copy: 0, paste: 0 },
    streak: { current: 0, best: 0, lastActiveDate: null },
  };
}

/**
 * 记录一次行为（纯函数核心：输入旧 stats + 行为 + 日期键 → 新 stats）。
 * kind: 'copy' | 'paste'。streak 仅由 copy 驱动（paste 不续签——打卡心智锚在「今天用了剪贴板」）。
 */
function record(old: StatsData | null, kind: 'copy' | 'paste', dkey: string): StatsData {
  const st: StatsData = old && typeof old === 'object' && old.days ? old : emptyStats();
  const next: StatsData = {
    version: STATS_VERSION,
    days: Object.assign({}, st.days),
    total: { copy: st.total ? st.total.copy || 0 : 0, paste: st.total ? st.total.paste || 0 : 0 },
    streak: Object.assign({}, st.streak || { current: 0, best: 0, lastActiveDate: null }),
  };
  const day: DayCount = next.days[dkey] || { copy: 0, paste: 0 };
  if (kind === 'copy') {
    day.copy += 1;
    next.total.copy += 1;
    // streak 推进：当日已计过则不动；昨日活跃 → +1；断签（>1 天缺口）→ 重计 1
    if (next.streak.lastActiveDate !== dkey) {
      const yesterday = shiftKey(dkey, -1);
      if (next.streak.lastActiveDate === yesterday) next.streak.current += 1;
      else next.streak.current = 1;
      next.streak.lastActiveDate = dkey;
      if (next.streak.current > next.streak.best) next.streak.best = next.streak.current;
    }
  } else {
    day.paste += 1;
    next.total.paste += 1;
  }
  next.days[dkey] = day;
  return next;
}

/** 滚动清理（纯函数）：仅保留 keepDays 天；返回 { stats, removed } */
function prune(old: StatsData | null, todayKey: string, keepDays?: number): { stats: StatsData; removed: number } {
  const st: StatsData = old && old.days ? old : emptyStats();
  const keep = typeof keepDays === 'number' && keepDays > 0 ? keepDays : DAYS_KEEP;
  // 含当日口径：保留「最近 keepDays 天」→ cutoff = today-(keep-1)
  //（红灯 S4 实证：-keep 口径把 cutoff 当天也保留，91≠90）
  const cutoff = shiftKey(todayKey, -(keep - 1));
  const days: Record<string, DayCount> = {};
  let removed = 0;
  for (const k of Object.keys(st.days)) {
    if (k >= cutoff) days[k] = st.days[k];
    else removed += 1;
  }
  return {
    stats: {
      version: STATS_VERSION, days: days,
      total: st.total || { copy: 0, paste: 0 },
      streak: st.streak || { current: 0, best: 0, lastActiveDate: null },
    },
    removed: removed,
  };
}

/** 日期键位移（yesterday 计算；dkey 'YYYY-MM-DD' + delta 天） */
function shiftKey(dkey: string, deltaDays: number): string {
  const [y, m, d] = dkey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateKey(dt);
}

/**
 * 文件 IO 轻封装（load/save；损坏容错：读失败/解析失败 → 空结构重新开始，
 * spec 红线：统计损坏不影响剪贴板数据）。
 */
interface DayCount { copy: number; paste: number }
interface StatsData {
  version: number;
  days: Record<string, DayCount>;
  total: { copy: number; paste: number };
  streak: { current: number; best: number; lastActiveDate: string | null };
}
class StatsStore {
  private filePath: string;
  data: StatsData;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = emptyStats();
  }

  load(): StatsData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.days) this.data = parsed;
      }
    } catch (_) { /* 损坏容错：空结构重新开始 */ }
    // 启动即滚动清理（体积护栏）
    const pr = prune(this.data, dateKey(), DAYS_KEEP);
    this.data = pr.stats;
    return this.data;
  }

  record(kind: 'copy' | 'paste', dkey?: string): StatsData {
    this.data = record(this.data, kind, dkey || dateKey());
    try {
      const pr = prune(this.data, dkey || dateKey(), DAYS_KEEP);
      this.data = pr.stats;
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath); // 原子写（tmp+rename，storage 同款）
    } catch (_) { /* 写失败静默：统计不阻断主流程 */ }
    return this.data;
  }
}

/** 便捷汇总（辅助行/hover 卡消费）：{ exp, level, title, progress, today, streak } */
/** 近 7 日按日数据（2026-11-11 趋势 tab FR）：today 在前，缺失日补零 */
function last7Days(st: StatsData, dkey?: string): Array<{ key: string; copy: number; paste: number }> {
  const dk: string = dkey || dateKey();
  const base = new Date(dk + 'T00:00:00');
  const out: Array<{ key: string; copy: number; paste: number }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const day = st.days[key] || { copy: 0, paste: 0 };
    out.push({ key, copy: day.copy, paste: day.paste });
  }
  return out;
}

function summarize(stats: StatsData | null, dkey?: string): Record<string, unknown> {
  const st: StatsData = stats || emptyStats();
  const dk: string = dkey || dateKey();
  const today: DayCount = st.days[dk] || { copy: 0, paste: 0 };
  const lv = computeLevel(st.total.copy);
  return {
    exp: st.total.copy,
    level: lv.level,
    title: lv.title,
    nextNeed: lv.nextNeed,
    progress: computeProgress(st.total.copy),
    todayCopy: today.copy,
    todayPaste: today.paste,
    streakCurrent: st.streak ? st.streak.current : 0,
    streakBest: st.streak ? st.streak.best : 0,
    last7: last7Days(st, dk),
  };
}

// export = 单导出（与 storage/pet-manager 同构；TS 文件中 module.exports 不构成模块——TS2306 教训）
export = {
  STATS_VERSION: STATS_VERSION,
  DAYS_KEEP: DAYS_KEEP,
  LEVEL_MAX: LEVEL_MAX,
  LEVEL_TITLES: LEVEL_TITLES,
  dateKey: dateKey,
  computeLevel: computeLevel,
  computeProgress: computeProgress,
  emptyStats: emptyStats,
  record: record,
  prune: prune,
  StatsStore: StatsStore,
  summarize: summarize,
  last7Days: last7Days,
};
