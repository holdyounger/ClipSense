/**
 * entry-anim.ts - 新条目入场动画：触发判定 + 贴边态补播（方案 B，2026-09-11）
 *
 * 设计稿：Docs/UI方案-新条目动画-2026-09-11.md「方案 B」+「触发判定（三案共用）」。
 *
 * 触发判定（设计稿固定，不要改语义）：
 *   id 变化且新条目 timestamp 距 now < 10s → 播放入场动画（真·新内容）
 *   id 不变（rebase/普通刷新/粘贴后重建/bump 置顶）→ 不播
 *   id 变化但 timestamp 陈旧（历史装载/导入）→ 不播
 *   首次基线渲染（lastTopId 为 null）→ 不播（启动装载天然落此分支）
 *
 * 贴边态：面板贴边收起 = 主窗口 hide()（可见性判定见 header-hover.ts 迁移说明——
 * visibilityState 在 backgroundThrottling:false 下失灵，渲染层以主进程
 * window:visibility 频道为唯一权威，经 deps.visibility 注入）。
 * 收起期间到达的新条目：
 *   - 触发条（triggerWindow #bar）一次性脉冲 ≈180ms + 置 pending 状态标记
 *     （脉冲经 main.js 的 onPulse 钩子 → IPC → 主进程对 triggerWindow executeJavaScript）
 *   - 下次展开（权威信号回 'visible'）→ main.js 的 visibilitychange 分支调
 *     playPending(listEl)：顶部条目命中 pending id → 补播一次 → 清标记；
 *     展开后的渲染 tick（refresh/onHistoryUpdated）同样可消费该标记（双保险）
 *
 * 注意：renderHistory 会在列表顶部插日期分组线，取顶部条目必须跳过无 _itemData
 * 的节点（见 topEntryOf）。
 *
 * TS 迁移（2026-09-30，第三批 #1）：脚本风格（无 export，顶层 function 挂全局），
 * 守卫式 module.exports 双端挂载与 .js 版同构；interface 编译期擦除零成本。
 */
'use strict';

const ENTRY_MAX_AGE_MS = 10 * 1000; // 设计稿：timestamp 距 now < 10s 才算真新增

/** 剪贴板历史条目（打标后含 tags；字段按需，id/timestamp 必备） */
interface HistoryItem {
  id: string;
  timestamp: number;
  tags?: string[];
  [key: string]: unknown;
}

/** 渲染后的列表条目节点（main.js 在重建时挂 _itemData；el 为挂载数据的任意节点） */
interface RenderedEntry {
  el: unknown;
  item: HistoryItem;
}

/** 渲染子节点（main.js 重建时挂 _itemData 数据引用） */
interface RenderedChild {
  _itemData?: HistoryItem;
}

/** 列表容器最小接口（array-like children 即可，测试桩传普通数组） */
interface EntryListContainer {
  children?: ArrayLike<RenderedChild | null>;
}

/** topEntryOf 返回（el + 数据引用） */
interface TopEntry {
  el: unknown; // 挂了 _itemData 的任意节点（.js 同构）；内部仅透传给 play 回调
  item: HistoryItem;
}

/** createEntryAnim 依赖（依赖注入接口即类型接口） */
interface EntryAnimDeps {
  play: (entry: TopEntry) => void;
  visibility: () => 'visible' | 'hidden' | 'prerender' | 'unloaded';
  onPulse?: (id: string) => void;
}

/** 状态快照（测试断言用） */
interface EntryAnimState {
  lastTopId: string | null;
  pendingEntryId: string | null;
  pulseFiredFor: string | null;
}

/**
 * 从已渲染列表取顶部条目（跳过日期分组线等无 _itemData 的前置节点）。
 */
function topEntryOf(container: EntryListContainer | null): TopEntry | null {
  if (!container) return null;
  // 真实 DOM 的 children 是 HTMLCollection（非数组）；测试桩传普通数组。
  // 统一按 array-like 处理：只要可索引（有 length）就遍历——
  // 用 Array.isArray 守卫会导致真实环境恒返回 null、动画永不触发（2026-09-12 实测）。
  const kids = container.children;
  if (!kids || typeof kids.length !== 'number') return null;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child && child._itemData) {
      return { el: child as unknown as HTMLElement, item: child._itemData };
    }
  }
  return null;
}

/**
 * 创建入场动画控制器（main.js 持有一个实例；node:test 直接注入桩驱动）。
 */
function createEntryAnim(deps: EntryAnimDeps) {
  const { play, visibility, onPulse } = deps;

  let lastTopId: string | null = null;     // 上一次渲染的顶部条目 id
  let pendingEntry: string | null = null;  // 贴边收起期间到达、待补播的条目 id
  let pulseFiredFor: string | null = null; // 已发过脉冲的条目 id（同一收起期同一条目只脉冲一次）

  return {
    /** 状态快照（测试断言用） */
    getState(): EntryAnimState {
      return {
        lastTopId,
        pendingEntryId: pendingEntry,
        pulseFiredFor,
      };
    },

    /**
     * 每次列表全量重建后调用（refresh / onHistoryUpdated 两处；搜索/筛选的重渲染
     * 不接此钩子——搜索过滤顶部的 timestamp 多为旧条目，陈旧判定天然不播）。
     * @param container 列表容器
     * @returns 是否播发了入场动画
     */
    handleRendered(container: EntryListContainer | null): boolean {
      const entry = topEntryOf(container);
      const id: string | null = entry ? entry.item.id : null;
      const prevId = lastTopId;

      if (id === null) {
        // 列表清空（清空历史/全部过滤掉）：顺带清理贴边待办，避免悬挂标记
        lastTopId = null;
        pendingEntry = null;
        pulseFiredFor = null;
        return false;
      }

      lastTopId = id;

      // 兑底补播：visibilitychange 的 playPending 因时序未命中（如标签筛选重渲染
      // 竞态）时，后续渲染 tick 顶部命中待播条目则补播（仅可见态；标记语义
      // 为「下次展开补播一次」，不重验 timestamp 时效）
      if (id === prevId || prevId === null) {
        // prevId === null = 首渲染基线：只记录不播（.ts 迁移时曾丢失此分支，
        // 2026-10-10 统一切换测试到产物后被 12 条电池捕获——回归实证）
        if (pendingEntry && id === pendingEntry && visibility() !== 'hidden' && entry) {
          pendingEntry = null;
          pulseFiredFor = null;
          play(entry);
          return true;
        }
        return false; // rebase/普通刷新/粘贴后重建/bump 置顶/基线：不播
      }

      // id 变化：区分真新增（timestamp 距 now < 10s）与陈旧装载
      // entry 非 null 由 id !== null 保证（id 取自 entry.item.id），显式断言供 TS 窄化
      if (!entry) return false;
      const item: HistoryItem = entry.item;
      const ts = typeof item.timestamp === 'number' ? item.timestamp : NaN;
      if (!Number.isFinite(ts) || Date.now() - ts >= ENTRY_MAX_AGE_MS) {
        return false; // 陈旧装载/导入：不播
      }

      if (visibility() === 'hidden') {
        // 贴边收起：一次性脉冲 + 置标记，展开后补播（本 tick 不播）
        if (pulseFiredFor !== id) {
          pulseFiredFor = id;
          if (onPulse) onPulse(id);
        }
        pendingEntry = id;
        return false;
      }

      play(entry);
      return true;
    },

    /**
     * 窗口重显（visibilityState 回 'visible'）后补播贴边期待播条目。
     * 幂等：无待办 / 顶部条目不匹配时不动作（后者留给后续渲染 tick 消费）。
     */
    playPending(container: EntryListContainer | null): boolean {
      if (!pendingEntry) return false;
      const entry = topEntryOf(container);
      if (!entry || entry.item.id !== pendingEntry) return false;
      pendingEntry = null;
      pulseFiredFor = null;
      play(entry);
      return true;
    },
  };
}

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = { ENTRY_MAX_AGE_MS, topEntryOf, createEntryAnim };
}
