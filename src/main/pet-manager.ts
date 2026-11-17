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
  // 拖拽保底 LEAF 可见（2026-10-15 语义：用户故意把猫拖到屏幕边缘藏起来是合法用法，拖不丢）；
  // 互动菜单打开时的可见性由 expand-ctx 的临时拉回保障（2026-11-15 v5.1）
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
/**
 * 互动菜单拉回（2026-11-15 v5.3 纯移动，修 v5.2 死代码 + 出屏不可点）：
 * v5.2 的拉回+扩窗从未生效——expand-ctx 处理器以 _petCtxOpen 早退，而真实链路
 * 「右键开主扇 → 点互动才发 expand-ctx」中菜单态已置位，守卫恒真。
 * v5.3 撤扩窗（v4 教训：改窗口几何 → left:50%/bottom:0 锚定的猫必移动+叶错位），
 * 只做纯移动：把越出 workArea 的部分拉回屏内，窗口尺寸不变。
 * 返回 moved=false 表示窗口已完整屏内（调用方可跳过 setBounds）。
 */
function computeCtxPullBack(
  bounds: StageBounds,
  display: PetDisplay,
): { x: number; y: number; moved: boolean } {
  const wa = display.workArea;
  const maxX = Math.max(wa.x, wa.x + wa.width - bounds.width);
  const maxY = Math.max(wa.y, wa.y + wa.height - bounds.height);
  const x = Math.round(Math.min(Math.max(bounds.x, wa.x), maxX));
  const y = Math.round(Math.min(Math.max(bounds.y, wa.y), maxY));
  const moved = x !== bounds.x || y !== bounds.y;
  return { x, y, moved };
}

/**
 * 托盘「桌宠专属项」可见性（2026-11-16 小M：非宠物模式不应有桌宠相关）：
 * 桌宠大小 / 桌宠形象 / 点击桌宠时唤出面板 / 桌宠 DevTools 只在 pet 模式展示；
 * edge/hidden 模式下这些项对当前用户无意义（无桌宠可调），收敛掉降低托盘噪音。
 * 模式切换入口（隐藏模式子菜单含「桌宠（实验）」）不在此列——那是切入宠物的唯一托盘入口。
 */
function shouldShowPetTrayItems(hideMode: unknown): boolean {
  return hideMode === 'pet';
}

/**
 * 调试入口许可（2026-11-16 小M：调试模式只能在 start:dev 出现，start 不出现）：
 * npm start = `electron .`（NODE_ENV 未设 / 继承环境）；
 * npm run start:dev = `set NODE_ENV=development&& electron .`（NODE_ENV=development）。
 * 两者都不打包（isPackaged=false），故不能用 !isPackaged 判定——必须看 NODE_ENV 显式标记。
 * 打包版即便误带 development 也不放行（双条件）。
 * 统一接线点：托盘两项调试 visible、F12 快捷键、DevTools 自动打开。
 */
function isDebugMenuAllowed(isPackaged: boolean, nodeEnv: string | undefined): boolean {
  return !isPackaged && nodeEnv === 'development';
}

export = { STAGE, SCALE_MIN, SCALE_MAX, stageSizeFor, normalizeScale, normalizeHideMode, buildPetStageBounds, clampPetPosition, shouldAutoRespawn, computePetIgnore, shouldDeferPetStage, computeCtxPullBack, shouldShowPetTrayItems, isDebugMenuAllowed };
