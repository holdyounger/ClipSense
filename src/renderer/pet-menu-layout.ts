/**
 * pet-menu-layout.ts - 桌宠环形菜单布局引擎 v2.1（2026-10-15 定稿）
 *
 * 演进：v1 散落计算 → v2 纯函数+同心环 → v3 挂父叶小扇（小M：不如 v2）→
 *       v2.1（本版）**恢复 v2 同心圆环** + 保留 v3 整体平移兜底。
 *
 * 小M 验收结论：v2 的同心环（二级叶绕主扇心内圈排布）视觉优于 v3 的父叶挂扇。
 * 最初「右侧二级菜单出界」的真实根因是扩窗时序竞争（已由方向化扩窗+目标尺寸下发修复），
 * 与布局模型无关——v2 模型本身没问题。
 *
 * 结构：
 *   主扇：5 叶绕猫 R_MAIN=88（270 上/225 左上/180 左/135 左下/90 下）
 *   二级：back 叶在父叶主扇位置（R_MAIN、父叶角），3 选项叶绕主扇心内圈 R_SUB=66
 *         （250/180/110，与主扇同圆心 = 同心圆环）
 *   兜底：整体平移（包围盒 fit 窗口，保持形状只平移，极小窗居中退化）
 */

/** 叶定义 */
export interface LeafSpec {
  key: string;
  ang: number;
  icon: string;
  hint: string;
  value?: string;
}

/** 布局输入 */
export interface LayoutInput {
  winW: number;
  winH: number;
  dirH: 'l' | 'r';
  dirV: 'u' | 'd';
  level: 'main' | 'mode';
  mode: string;
  scale: number;
  /** 猫锚点（video 视觉中心，DIP） */
  catX: number;
  catY: number;
}

/** 单叶布局结果 */
export interface LeafLayout {
  key: string;
  icon: string;
  hint: string;
  value?: string;
  x: number;
  y: number;
  size: number;
  selected: boolean;
}

/** 布局输出 */
export interface LayoutResult {
  /** 主扇心（真实坐标） */
  cx: number;
  cy: number;
  leaves: LeafLayout[];
}

const LEAF = 38;
const SUB_LEAF = 32;
const R_MAIN = 76;
const R_SUB = 62;           // 二级绕主扇心同圈（与主扇叶同轨，主扇叶此时已隐藏——2026-10-15 修子菜单压猫）
const MARGIN = 4;

/** 主扇 5 叶（基准角：90=下 135=左下 180=左 225=左上 270=上） */
const MAIN_LEAVES: LeafSpec[] = [
  { key: 'summon', ang: 250, icon: '🖥️', hint: '唤出面板' },
  { key: 'mode', ang: 200, icon: '🐱', hint: '模式' },
  { key: 'react', ang: 150, icon: '❤️', hint: '爱心' },
  { key: 'quit', ang: 100, icon: '⏻', hint: '退出' },
];

/** 模式二级 3 叶（绕主扇心内圈，250/180/110） */
const MODE_LEAVES: Array<LeafSpec & { value: string }> = [
  { key: 'pet', ang: 245, icon: '🐱', hint: '桌宠模式', value: 'pet' },
  { key: 'edge', ang: 180, icon: '📌', hint: '贴边模式', value: 'edge' },
  { key: 'hidden', ang: 115, icon: '🌙', hint: '纯隐藏', value: 'hidden' },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 计算布局（纯函数）。
 *  主扇绕猫 R_MAIN；二级同心内环绕主扇心 R_SUB（back 叶在父叶主扇位置）；
 *  最后整体包围盒平移进窗口（形状不变）。 */
export function computeLayout(input: LayoutInput): LayoutResult {
  const { winW, winH, dirH, dirV, level, mode } = input;
  const sub = level !== 'main';
  const mx = dirH === 'l' ? 1 : -1;
  const my = dirV === 'u' ? 1 : -1;

  // 菜单随宠物档位等比缩放（2026-10-15 小M 两点反馈：0.5× 猫配 1× 环 → 环远离小猫
  // 且固定弦距 33px < 叶径 38px 互相重叠）。k = 档位系数：0.5× 猫 → R=38 叶=23 环抱小猫。
  // BUG2 修复（2026-10-15 小M：缩放需上下限、符合视觉）：k∈[0.7,1.15]——
  // 0.5× 档叶不低于 27px（可点），2× 档叶不超 42px（不夸张）
  const k = clamp(input.scale, 0.7, 1.15);
  const effRMain = Math.round(R_MAIN * k);
  const effRSub = Math.round(R_SUB * k);
  const effLeaf = Math.round(LEAF * Math.max(0.6, k));
  const effSubLeaf = Math.round(SUB_LEAF * Math.max(0.6, k));

  // 主扇心 = 猫向展开方向偏移 (effRMain-10)，包络钳制（叶横/纵伸出 R+half）
  const cx = clamp(
    input.catX - mx * (effRMain - 10),
    MARGIN + effRMain,
    Math.max(MARGIN + effRMain, winW - MARGIN)
  );
  const cy = clamp(
    input.catY,
    MARGIN + effRMain,
    Math.max(MARGIN + effRMain, winH - MARGIN - effRMain)
  );

  let specs: Array<LeafSpec & { value?: string }>;
  if (!sub) {
    specs = MAIN_LEAVES;
  } else {
    const parent = MAIN_LEAVES.find((l) => l.key === 'mode')!;
    // back 叶在父叶的主扇位置（R_MAIN、父叶角）——点它回主扇
    const back: LeafSpec & { value?: string; backAtParent?: boolean } = {
      key: 'back',
      ang: parent.ang,
      icon: '↩',
      hint: '返回',
      backAtParent: true,
    };
    specs = [back].concat(MODE_LEAVES);
  }

  const leaves: LeafLayout[] = specs.map((spec) => {
    const isBack = (spec as { backAtParent?: boolean }).backAtParent === true;
    const r = isBack ? 0 : effRSub; // back 居环心（2026-10-15：父叶位与内圈 180° 叶仅距 26px < 叶径 32px，重叠实证；居中返回钮距选项叶恒为 R_SUB，几何不可能重叠）
    const size = isBack ? effLeaf : effSubLeaf;
    const szHalf = size / 2;
    const ang = spec.ang * (Math.PI / 180);
    const x = cx + mx * r * Math.cos(ang) - szHalf;
    const y = cy + my * r * Math.sin(ang) - szHalf;
    const selected = level === 'mode' && spec.value === mode;
    return {
      key: spec.key, icon: spec.icon, hint: spec.hint, value: spec.value,
      x: Math.round(x), y: Math.round(y), size, selected,
    };
  });

  // 整体平移兜底：包围盒 fit 进窗口（保持形状只平移；极小窗居中退化）
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of leaves) {
    minX = Math.min(minX, l.x);
    minY = Math.min(minY, l.y);
    maxX = Math.max(maxX, l.x + l.size);
    maxY = Math.max(maxY, l.y + l.size);
  }
  const lo = MARGIN;
  let tx = 0;
  let ty = 0;
  if (minX < lo) tx = lo - minX;
  else if (maxX > winW - lo) tx = winW - lo - maxX;
  if (minY < lo) ty = lo - minY;
  else if (maxY > winH - lo) ty = winH - lo - maxY;
  if (maxX - minX > winW - lo * 2) tx = (winW - (maxX - minX)) / 2 - minX;
  if (maxY - minY > winH - lo * 2) ty = (winH - (maxY - minY)) / 2 - minY;

  for (const l of leaves) {
    l.x = Math.round(l.x + tx);
    l.y = Math.round(l.y + ty);
  }

  return { cx: Math.round(cx), cy: Math.round(cy), leaves };
}

/** 菜单打开所需扩窗尺寸（主进程 setBounds 用） */
export function menuWindowSize(): { W: number; H: number } {
  return { W: R_MAIN * 2 + LEAF + MARGIN * 2, H: R_MAIN * 2 + LEAF + MARGIN * 2 };
}
