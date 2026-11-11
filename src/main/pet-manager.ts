/**
 * pet-manager.ts - 桌宠模式纯逻辑（P0 spike，2026-10-13）
 *
 * 职责边界（与 header-hover/modifier-passthrough 同构）：几何计算与模式判定
 * 的纯函数层，零 electron 依赖，node --test 直测；窗口操作由 index.ts 执行。
 *
 * 舞台纪律继承（2026-09-17）：桌宠动作全程窗口内变换，唯一 setBounds 发生在
 * 模式切换定位时（一次性，非动画路径）；拖拽移动走渐进 setPosition 的例外
 * 见 index.ts（拖拽是用户手势，非动画，DWM 重分配可接受——与抽屉动画的
 * 「动画期零 resize」约束不冲突）。
 *
 * 导出形态：export = 单导出（与 paste-bridge/edge-detector 同构；export = 模块内
 * 不得混用具名 export——接口/类型仅模块内类型面，经 ReturnType/typeof import 对外推导）。
 */

/** 舞台基准常量（DIP）：网易黑猫素材适配档；实际舞台 = 基准 × petSizeScale（2026-10-14 大小可调） */
const STAGE = { W: 170, H: 224, LEAF: 8 };

/** 缩放档边界：滚轮/托盘共用；超出范围钳制 */
const SCALE_MIN = 0.5;
const SCALE_MAX = 2.2;

/**
 * 按缩放系数计算舞台尺寸：基准 × scale，取整。
 * scale=1 即历史基准档（170×224）。
 */
function stageSizeFor(scale: number): { W: number; H: number } {
  const s = normalizeScale(scale);
  return { W: Math.round(STAGE.W * s), H: Math.round(STAGE.H * s) };
}

/** 规范化缩放系数：非法值回落 1，合法值钳入 [SCALE_MIN, SCALE_MAX] */
function normalizeScale(v: unknown): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!isFinite(n) || n <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

/** electron Display 最小面（消费 workArea 与 workAreaSize 兜底） */
interface PetDisplay {
  workArea: { x: number; y: number; width: number; height: number };
  workAreaSize?: { width: number; height: number };
}

/** 隐藏模式（决策 1：默认 edge 不惊扰存量用户） */
type HideMode = 'pet' | 'edge' | 'hidden';

/** 隐藏态舞台窗口 bounds（DIP，取整防 DPI 半像素漂移） */
interface StageBounds { x: number; y: number; width: number; height: number }

/**
 * 隐藏态桌宠舞台定位：贴右下角（首次默认位），留 LEAF 叶子边距。
 * workAreaSize 缺省时回退 workArea 宽高（electron Display 两者恒至少其一存在）。
 */
function buildPetStageBounds(display: PetDisplay, scale: number = 1): StageBounds {
  const wa = display.workArea;
  const size = display.workAreaSize || { width: wa.width, height: wa.height };
  const dim = stageSizeFor(scale);
  return {
    x: Math.round(wa.x + size.width - dim.W - STAGE.LEAF),
    y: Math.round(wa.y + size.height - dim.H - STAGE.LEAF),
    width: dim.W,
    height: dim.H,
  };
}

/** 规范化 hideMode：未知/缺省值安全回落 'edge'（旧配置文件无此键） */
function normalizeHideMode(v: unknown): HideMode {
  return v === 'pet' || v === 'hidden' || v === 'edge' ? v : 'edge';
}

/**
 * 桌宠拖拽落点 clamp：保证舞台至少 LEAF px 留在 workArea 内（拖不丢）。
 */
function clampPetPosition(x: number, y: number, display: PetDisplay, scale: number = 1): { x: number; y: number } {
  const wa = display.workArea;
  const dim = stageSizeFor(scale);
  const minX = wa.x - dim.W + STAGE.LEAF;
  const maxX = wa.x + wa.width - STAGE.LEAF;
  const minY = wa.y - dim.H + STAGE.LEAF;
  const maxY = wa.y + wa.height - STAGE.LEAF;
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

/**
 * 桌宠自动回位判定：唤出面板时若桌宠舞台与面板显示区重叠过深（中心点被面板覆盖），
 * 唤出后桌宠重生到右下默认位，避免「桌宠藏在自己面板后面找不到」。
 */
function shouldAutoRespawn(petX: number, petY: number, panelBounds: { x: number; y: number; width: number; height: number }): boolean {
  const cx = petX + STAGE.W / 2;
  const cy = petY + STAGE.H / 2;
  return (
    cx >= panelBounds.x && cx <= panelBounds.x + panelBounds.width &&
    cy >= panelBounds.y && cy <= panelBounds.y + panelBounds.height
  );
}

/** 命中穿透决策 v3（2026-11-03 B2，小M 批准推翻 34b9fe4 恒交互，可测纯函数）：
 *  本体命中/菜单打开/拖拽中 → 交互（false）；透明区 → 穿透放行（true，修 81% 占位）。
 *  Alt 恒不参与（34b9fe4 真正根因——假阳性探针——由「桌宠永不跟 Alt」保留，与穿透决策解耦）。
 *  dragging 一票交互：拖拽是用户手势，150ms 轮询不得在手势中翻转穿透（丢 mousedown 缝隙的唯一
 *  现役场景即「轮询在手势中途切穿透」；2026-10-23 v2 无此守卫，本次补上）。
 *  ctxOpen 一票交互：菜单渲染层命中判定以菜单 DOM 为准，穿透会让菜单点击落空。 */
function computePetIgnore(state: { altActive?: boolean; ctxOpen?: boolean; cursorOnModel?: boolean; dragging?: boolean }): boolean {
  const s = state ?? {};
  if (s.dragging) return false;   // 拖拽手势：恒交互（最高优先）
  if (s.ctxOpen) return false;    // 菜单打开：恒交互
  return !s.cursorOnModel;        // 本体=交互 / 透明区=穿透
}

/** 桌宠延迟登场判定（2026-10-30 可测纯函数）：桌宠模式且面板在场 → 不创建舞台，
 *  待面板收起（setOnHidden）后再登场（启动优先展示主面板的需求语义）。 */
function shouldDeferPetStage(opts: { petMode: boolean; panelVisible: boolean }): boolean {
  return !!opts.petMode && !!opts.panelVisible;
}
export = { STAGE, SCALE_MIN, SCALE_MAX, stageSizeFor, normalizeScale, normalizeHideMode, buildPetStageBounds, clampPetPosition, shouldAutoRespawn, computePetIgnore, shouldDeferPetStage };
