/**
 * pin-utils.ts - 置顶纯函数（2026-11-11 FR1-FR5/D4-D5）
 *
 * 无 electron 依赖（同 tag-utils 先例）：置顶 toggle 与容量裁剪收敛为纯函数，
 * 便于 node:test 直测 dist（tests/red/pin-top.red.test.js → 转绿后入全量门禁）。
 * 语义来源：spec-置顶功能-2026-11-11.md FR5（上限 10 + LRU 豁免）。
 */

/** 置顶位上限（spec FR5：超出拒绝并提示） */
export const PIN_LIMIT = 10;

/** 最小置顶数据面（MonitorHistoryItem / StorageItem 均满足该结构子集） */
interface PinItem {
  id: string;
  timestamp: number;
  pinned?: boolean;
  pinnedAt?: number;
}

export interface PinToggleResult<T> {
  ok: boolean;
  pinned: boolean;
  count: number;
  items: T[];
  /** ok=false 时给出原因（'pin-limit' = 置顶位已满；'not-found' = id 不存在） */
  error?: string;
}

function countPinned<T extends PinItem>(items: T[]): number {
  let n = 0;
  for (const i of items) if (i.pinned) n++;
  return n;
}

/**
 * 置顶 toggle（FR1/FR5）：已置顶→取消；未置顶→置顶（超限拒绝）。
 * 返回新数组（不原地改参），pinnedAt 记录置顶时间（D4 排序用）。
 */
export function applyPinToggle<T extends PinItem>(
  items: T[],
  id: string,
  limit: number = PIN_LIMIT,
  now: number = Date.now(),
): PinToggleResult<T> {
  const target = items.find((i) => i.id === id);
  if (!target) {
    return { ok: false, pinned: false, count: countPinned(items), items, error: 'not-found' };
  }

  if (target.pinned) {
    // 取消置顶：清标记与时间戳（undefined 序列化时自然丢弃）
    const next = items.map((i) => (i.id === id ? { ...i, pinned: false, pinnedAt: undefined } : i));
    return { ok: true, pinned: false, count: countPinned(next), items: next };
  }

  const count = countPinned(items);
  if (count >= limit) {
    return { ok: false, pinned: false, count, items, error: 'pin-limit' };
  }

  const next = items.map((i) => (i.id === id ? { ...i, pinned: true, pinnedAt: now } : i));
  return { ok: true, pinned: true, count: count + 1, items: next };
}

/**
 * 容量裁剪（FR5）：从最旧端（数组尾部）淘汰普通条目直到 ≤max；
 * 置顶条目豁免——永不被裁（若 pinned 本身超 max，保 pinned 舍 normal）。
 * 保持原数组顺序（monitor.history 为时间倒序，顺序即展示序）。
 */
export function trimWithPinned<T extends PinItem>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out = items.slice();
  let excess = out.length - max;
  for (let i = out.length - 1; i >= 0 && excess > 0; i--) {
    if (!out[i].pinned) {
      out.splice(i, 1);
      excess--;
    }
  }
  return out;
}
