/**
 * entry-anim.js - 新条目入场动画：触发判定 + 贴边态补播（方案 B，2026-09-11）
 *
 * 设计稿：Docs/UI方案-新条目动画-2026-09-11.md「方案 B」+「触发判定（三案共用）」。
 *
 * 触发判定（设计稿固定，不要改语义）：
 *   id 变化且新条目 timestamp 距 now < 10s → 播放入场动画（真·新内容）
 *   id 不变（rebase/普通刷新/粘贴后重建/bump 置顶）→ 不播
 *   id 变化但 timestamp 陈旧（历史装载/导入）→ 不播
 *   首次基线渲染（lastTopId 为 null）→ 不播（启动装载天然落此分支）
 *
 * 贴边态：面板贴边收起 = 主窗口 hide()（document.visibilityState 变 'hidden'，
 * EdgeDetector 既有体系，零新检测代码）。收起期间到达的新条目：
 *   - 触发条（triggerWindow #bar）一次性脉冲 ≈180ms + 置 pending 状态标记
 *     （脉冲经 main.js 的 onPulse 钩子 → IPC → 主进程对 triggerWindow executeJavaScript）
 *   - 下次展开（visibilityState 回 'visible'）→ main.js 的 visibilitychange 分支调
 *     playPending(listEl)：顶部条目命中 pending id → 补播一次 → 清标记；
 *     展开后的渲染 tick（refresh/onHistoryUpdated）同样可消费该标记（双保险）
 *
 * 注意：renderHistory 会在列表顶部插日期分组线，取顶部条目必须跳过无 _itemData
 * 的节点（见 topItemOf）。
 */
'use strict';

const ENTRY_MAX_AGE_MS = 10 * 1000; // 设计稿：timestamp 距 now < 10s 才算真新增

/**
 * 从已渲染列表取顶部条目（跳过日期分组线等无 _itemData 的前置节点）。
 * @returns {{el: HTMLElement, item: Object}|null}
 */
function topEntryOf(container) {
  if (!container) return null;
  // 真实 DOM 的 children 是 HTMLCollection（非数组）；测试桩传普通数组。
  // 统一按 array-like 处理：只要可索引（有 length）就遍历——
  // 用 Array.isArray 守卫会导致真实环境恒返回 null、动画永不触发（2026-09-12 实测）。
  const kids = container.children;
  if (!kids || typeof kids.length !== 'number') return null;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child && child._itemData) return { el: child, item: child._itemData };
  }
  return null;
}

/**
 * 创建入场动画控制器（main.js 持有一个实例；node:test 直接注入桩驱动）。
 *
 * @param {object} deps
 * @param {({el,item})=>void} deps.play     播放入场动画（生产=playEntryAnimIfAllowed，
 *                                          内含 reduced-motion 跳过；测试注录制桩）
 * @param {()=>string}        deps.visibility  document.visibilityState（测试注桩）
 * @param {(id:string)=>void} [deps.onPulse]   贴边新内容到达的触发条脉冲钩子
 */
function createEntryAnim(deps) {
  const { play, visibility, onPulse } = deps;

  let lastTopId = null;     // 上一次渲染的顶部条目 id
  let pendingEntry = null;  // 贴边收起期间到达、待补播的条目 id
  let pulseFiredFor = null; // 已发过脉冲的条目 id（同一收起期同一条目只脉冲一次）

  return {
    /** 状态快照（测试断言用） */
    getState() {
      return {
        lastTopId,
        pendingEntryId: pendingEntry,
        pulseFiredFor,
      };
    },

    /**
     * 每次列表全量重建后调用（refresh / onHistoryUpdated 两处；搜索/筛选的重渲染
     * 不接此钩子——搜索过滤顶部的 timestamp 多为旧条目，陈旧判定天然不播）。
     * @param {HTMLElement} container 列表容器
     * @returns {boolean} 是否播发了入场动画
     */
    handleRendered(container) {
      const entry = topEntryOf(container);
      const id = entry ? entry.item.id : null;
      const prevId = lastTopId;
      lastTopId = id;

      if (id === null) {
        // 列表清空（清空历史/全部过滤掉）：顺带清理贴边待办，避免悬挂标记
        pendingEntry = null;
        pulseFiredFor = null;
        return false;
      }
      if (id === prevId || prevId === null) {
        // 兑底补播：visibilitychange 的 playPending 因时序未命中（如标签筛选重渲染
        // 竞态）时，后续渲染 tick 顶部命中待播条目则补播（仅 visible 态；标记语义
        // 为「下次展开补播一次」，不重验 timestamp 时效）
        if (pendingEntry && id === pendingEntry && visibility() !== 'hidden') {
          pendingEntry = null;
          pulseFiredFor = null;
          play(entry);
          return true;
        }
        return false; // rebase/刷新/置顶/基线：不播
      }

      const ts = entry.item && typeof entry.item.timestamp === 'number'
        ? entry.item.timestamp : NaN;
      if (!Number.isFinite(ts) || Date.now() - ts >= ENTRY_MAX_AGE_MS) return false; // 陈旧装载

      if (visibility() === 'hidden') {
        // 贴边收起态：一次性脉冲 + 置标记，展开后补播（本 tick 不播）
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
     * 窗口重显（visibilitychange → visible）后补播贴边期待播条目。
     * 幂等：无待办 / 顶部条目不匹配时不动作（后者留给后续渲染 tick 消费）。
     * @param {HTMLElement} container 列表容器
     * @returns {boolean} 是否补播
     */
    playPending(container) {
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

if (typeof module !== 'undefined') {
  module.exports = { createEntryAnim, topEntryOf, ENTRY_MAX_AGE_MS };
}
