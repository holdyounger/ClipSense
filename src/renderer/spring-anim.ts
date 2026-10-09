/**
 * spring-anim.ts - WAAPI spring 物理动画工具（新条目入场动画，2026-09-11 方案 B →
 * 2026-09-12 V0.3「文档入柜/标签插纸」物理叙事，小M 定稿）
 *
 * 设计稿固定 spring 参数，不要改动数值：
 *   stiffness 180 / damping 14 / mass 1（半隐式欧拉积分）
 *   V0.3 入场（文档入柜）：translateY -34→0（初速 -320，落下动量）、translateX 12→0
 *   （对齐漂移）、scale 0.97→1、rotate 1.5°→0（入槽摆正）、opacity 0→1（前 120ms）
 *   推入波弹簧 420/30（比入场硬：让位必须先于落位，否则文档砸在未让开的纸上）
 *
 * 实现路线：JS 逐帧积分输出关键帧 → element.animate()（WAAPI，合成器线程渲染），
 * 每帧只写 transform/opacity；onfinish 后 cancel 释放，不驻留合成层。
 * 积分器独立于 DOM，可在 node:test 直接单测（tests/entry-anim.dom.test.js）。
 *
 * TS 迁移示范（2026-09-30）——脚本风格约定（渲染层经典 script 加载的关键约束）：
 *   1. 本文件不用 export/import（保持全局脚本语义）：tsc 对无导入/导出的脚本文件
 *      透传编译，顶层 function 声明在经典 script 下仍是 window 全局——main.js 的
 *      引用方式（typeof springFrames === 'function'）才能继续工作
 *   2. 尾部守卫式 module.exports 供 node:test 的 require 加载（与 .js 版一致）
 *   3. interface 编译期擦除，零运行时成本
 */
'use strict';

/** 设计稿 B 固定物理参数 */
const SPRING_ENTRY = { stiffness: 180, damping: 14, mass: 1 };

const ENTRY_DT = 1 / 60;      // 积分步长（s），≈60fps
const ENTRY_MAX_FRAMES = 90;  // 积分上限 1.5s，防参数异常时无限积分
const ENTRY_OPACITY_MS = 120; // opacity 快速淡入窗口（设计稿：前 120ms 完成）

/** springFrames 参数（依赖注入接口即类型接口） */
interface SpringFrameOptions {
  from: number;        // 起始值（px 或比例）
  to: number;          // 目标值
  velocity?: number;   // 初速（单位/s，符号即方向）
  stiffness?: number;  // 刚度（默认设计稿 180）
  damping?: number;    // 阻尼（默认设计稿 14）
  mass?: number;       // 质量（默认设计稿 1）
  dt?: number;         // 步长（s）
  maxFrames?: number;  // 最大帧数
  settlePos?: number;  // 位移收敛阈值
  settleVel?: number;  // 速度收敛阈值
}

/** 单帧积分状态 */
interface SpringFrameState {
  x: number;
  v: number;
}

/** WAAPI 关键帧（索引签名兼容 lib.dom 的 Keyframe：string | number | null | undefined） */
interface WAAPIKeyframe {
  transform: string;
  opacity?: number;
  [key: string]: string | number | null | undefined;
}

/** 入场动画回调（推入波需与下落同步起跑） */
interface EntryAnimOptions {
  onStart?: () => void;
  onLand?: () => void;
}

/** 入场关键帧集（frames + 自适应时长） */
interface EntryFramesResult {
  frames: WAAPIKeyframe[];
  durationMs: number;
}

/**
 * 半隐式欧拉 spring 积分：x 从 from 出发（初速 velocity）向 to 收敛。
 * 先更新速度、再更新位移，稳定性优于显式欧拉；位移与速度同时进入阈值即视为
 * 收敛，并补一帧精确落位（避免 WAAPI 末帧残差抖动）。
 */
function springFrames(o: SpringFrameOptions): SpringFrameState[] {
  const {
    from, to, velocity = 0,
    stiffness = SPRING_ENTRY.stiffness,
    damping = SPRING_ENTRY.damping,
    mass = SPRING_ENTRY.mass,
    dt = ENTRY_DT,
    maxFrames = ENTRY_MAX_FRAMES,
    settlePos = 1,
    settleVel = 10,
  } = o;
  const frames: SpringFrameState[] = [];
  let x = from;
  let v = velocity;
  for (let i = 0; i < maxFrames; i++) {
    const a = (-stiffness * (x - to) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    frames.push({ x, v });
    if (Math.abs(x - to) < settlePos && Math.abs(v) < settleVel) {
      frames.push({ x: to, v: 0 }); // 精确落位帧
      break;
    }
  }
  return frames;
}

/**
 * 方案 B 入场关键帧：translateY + scale 同步 spring，opacity 前 120ms 线性淡入。
 * V0.3 物理叙事（小M 定稿「文档入柜」）：新条目 = 一张纸从柜口垂直插入顶层槽位。
 */
function entryFrames(): EntryFramesResult {
  const y = springFrames({ from: -34, to: 0, velocity: -320, settlePos: 1, settleVel: 10 });
  const x = springFrames({ from: 12, to: 0, velocity: -40, settlePos: 1, settleVel: 10 });
  const s = springFrames({ from: 0.97, to: 1, velocity: 0, settlePos: 0.005, settleVel: 0.05 });
  const r = springFrames({ from: 1.5, to: 0, velocity: 0, settlePos: 0.05, settleVel: 0.5 });
  const n = Math.max(y.length, x.length, s.length, r.length);
  const frames: WAAPIKeyframe[] = [];
  for (let i = 0; i < n; i++) {
    // 较早收敛的轨道保持在最终值（其末帧即精确落位帧）
    const yf = y[Math.min(i, y.length - 1)];
    const xf = x[Math.min(i, x.length - 1)];
    const sf = s[Math.min(i, s.length - 1)];
    const rf = r[Math.min(i, r.length - 1)];
    const tMs = (i + 1) * ENTRY_DT * 1000;
    frames.push({
      transform: `translateY(${yf.x.toFixed(2)}px) translateX(${xf.x.toFixed(2)}px) scale(${sf.x.toFixed(4)}) rotate(${rf.x.toFixed(2)}deg)`,
      opacity: Math.min(1, tMs / ENTRY_OPACITY_MS),
    });
  }
  return { frames, durationMs: Math.round(n * ENTRY_DT * 1000) };
}

/**
 * 对元素播放入场动画（WAAPI，V0.3 文档入柜落纸）。reduced-motion 判定由调用方负责。
 * @returns 是否成功启动
 */
function playEntryAnim(el: HTMLElement | null, opts: EntryAnimOptions = {}): boolean {
  if (!el || typeof el.animate !== 'function') return false;
  const { frames, durationMs } = entryFrames();
  if (!frames || frames.length < 2) return false;
  let anim: Animation | null = null;
  try {
    anim = el.animate(frames, { duration: durationMs, easing: 'linear', fill: 'both' });
  } catch {
    return false; // WAAPI 异常不阻塞渲染
  }
  // onStart：入场启动即回调（文档入柜的推入波与下落同步起跑，V0.3）
  if (typeof opts.onStart === 'function') {
    try { opts.onStart(); } catch { /* 不阻塞入场 */ }
  }
  // onfinish → 触发落位回调（光晕）+ cancel 释放 fill 与合成层，不驻留
  anim.onfinish = () => {
    try { anim.cancel(); } catch { /* 已释放 */ }
    if (typeof opts.onLand === 'function') {
      try { opts.onLand(); } catch { /* 光晕失败不阻塞 */ }
    }
  };
  return true;
}

/**
 * 落位光晕（方案 C ②，2026-09-12）：顶部条目卡片底部泛起一圈紫色光晕脉冲。
 * CSS 实现见 main.css 的 .item-landing::after；这里只负责 class 挂载与清理。
 */
function playLandingGlow(el: HTMLElement | null, opts: { removeAfterMs?: number } = {}): boolean {
  if (!el || typeof el.classList === 'undefined' ||
      typeof el.classList.add !== 'function') return false;
  const removeAfterMs = Number.isFinite(opts.removeAfterMs) ? opts.removeAfterMs : 420;
  el.classList.remove('item-landing');
  if (typeof el.offsetWidth === 'number') void el.offsetWidth; // 强制 reflow 重启动画
  el.classList.add('item-landing');
  setTimeout(() => {
    try { el.classList.remove('item-landing'); } catch { /* 节点已被重建 */ }
  }, removeAfterMs);
  return true;
}

/** 推入波弹簧参数（420/30 硬于入场 180/14：让位先于落位，物理约束） */
const PUSH_SPRING = { stiffness: 420, damping: 30, velocity: 300 };
/** 推入波波形参数 */
const WAVE = { heightPx: 72, stepMs: 24, startDelayMs: 120, maxItems: 8, marginBottom: 6 };

/** playSettleWave 参数（heightPx 覆盖实测为测试用） */
interface SettleWaveOptions {
  heightPx?: number;
  startDelayMs?: number;
  stepMs?: number;
  maxItems?: number;
}

/** 最小容器桩接口（children 可枚举即可，测试注入桩用） */
interface SettleWaveContainer {
  children?: ArrayLike<Record<string, unknown>>;
}

/**
 * 旧条目推入波（V0.3「文档入柜」物理运动，2026-09-12 重做）。
 * 位移 = 新条目实测高度（offsetHeight + margin），力来自文档本身——
 * 下面一叠纸被插入的文档真实地推下去，不是装饰性抖动。
 * 调用时机 = 入场动画 onStart（与下落同步起跑），非 onLand。
 * @returns 实际启动推入动画的条目数
 */
function playSettleWave(container: SettleWaveContainer | null, opts: SettleWaveOptions = {}): number {
  const stepMs = opts.stepMs ?? WAVE.stepMs;
  const startDelayMs = opts.startDelayMs ?? WAVE.startDelayMs;
  const maxItems = opts.maxItems ?? WAVE.maxItems;
  if (!container || typeof container.children === 'undefined') return 0;
  const children = Array.from(container.children || []) as Array<Record<string, unknown>>;
  // 锚点：新条目 = 第一个带 _itemData 的节点（顶部可能先插日期分组线，
  // 与 entry-anim.topEntryOf 同一约定）。找不到锚点不播，避免把新条目自身推下去。
  let anchorIdx = -1;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c && typeof c === 'object' && '_itemData' in c) { anchorIdx = i; break; }
  }
  if (anchorIdx === -1) return 0;

  // 位移 = 新条目实高（入柜推动量来自文档本身）；NaN = 实测失败回退 WAVE.heightPx
  let heightPx: number = opts.heightPx ?? NaN;
  if (!Number.isFinite(heightPx)) {
    const anchor = children[anchorIdx] as { offsetHeight?: number } | undefined;
    const h = anchor && typeof anchor.offsetHeight === 'number' ? anchor.offsetHeight : NaN;
    heightPx = Number.isFinite(h) && h > 0 ? h + WAVE.marginBottom : WAVE.heightPx;
  }

  // 推入弹簧帧：每条从「被压缩的槽位」（-heightPx）被推回原位（0）。
  // 首帧精确 -heightPx（fill:backwards 反向持帧不跳变），spring 落位帧精确 0。
  const push = springFrames({ from: -heightPx, to: 0, settlePos: 1, settleVel: 10, ...PUSH_SPRING });
  const framesAll: WAAPIKeyframe[] = [
    { transform: `translateY(${(-heightPx).toFixed(2)}px)` },
    ...push.map((f) => ({ transform: `translateY(${f.x.toFixed(2)}px)` })),
  ];
  const durationMs = Math.round(framesAll.length * (1000 / 60));

  let fired = 0;
  for (let i = anchorIdx + 1; i < children.length && fired < maxItems; i++) {
    const child = children[i] as { animate?: unknown } | undefined;
    if (!child || typeof child.animate !== 'function') continue;
    try {
      const el = child as unknown as HTMLElement;
      const a = el.animate(framesAll, {
        duration: durationMs,
        delay: startDelayMs + fired * stepMs,
        easing: 'linear',
        fill: 'backwards',
      });
      a.onfinish = () => { try { a.cancel(); } catch { /* 已释放 */ } };
      fired++;
    } catch { /* 单条失败不影响整体 */ }
  }
  return fired;
}

/** 标签插纸参数（V0.3 物理叙事） */
const TAG_INSERT = { distancePx: 16, rotateDeg: -8, durationMs: 260, stepMs: 45, maxChips: 6 };

/** playTagInsert 参数 */
interface TagInsertOptions {
  distancePx?: number;
  rotateDeg?: number;
  durationMs?: number;
  stepMs?: number;
  maxChips?: number;
}

/**
 * 标签插入文档（V0.3 物理叙事，2026-09-12）：新条目落位后，tag chips 像索引标签
 * 依次插进纸张右缘——从右侧 16px、微旋 -8° 滑入卡位，带一次过冲回正。
 * 仅动 transform/opacity；onfinish cancel 不驻留。无 chips/无能力 → 0。
 * @returns 实际启动插纸动画的 chips 数
 */
function playTagInsert(el: HTMLElement | null, opts: TagInsertOptions = {}): number {
  const dist = opts.distancePx ?? TAG_INSERT.distancePx;
  const rot = opts.rotateDeg ?? TAG_INSERT.rotateDeg;
  const durationMs = opts.durationMs ?? TAG_INSERT.durationMs;
  const stepMs = opts.stepMs ?? TAG_INSERT.stepMs;
  const maxChips = opts.maxChips ?? TAG_INSERT.maxChips;
  if (!el || typeof el.querySelectorAll !== 'function') return 0;
  let chips: NodeListOf<Element>;
  try { chips = el.querySelectorAll('.tag-chip'); } catch { return 0; }
  if (!chips || typeof chips.length !== 'number') return 0;
  const n = Math.min(chips.length, maxChips);
  let fired = 0;
  for (let i = 0; i < n; i++) {
    const chip = chips[i] as HTMLElement;
    if (!chip || typeof chip.animate !== 'function') continue;
    try {
      const a = chip.animate([
        { transform: `translateX(${dist}px) rotate(${rot}deg)`, opacity: 0 },
        { transform: 'translateX(-2px) rotate(2deg)', opacity: 1, offset: 0.7 },
        { transform: 'translateX(0px) rotate(0deg)', opacity: 1 },
      ], { duration: durationMs, delay: fired * stepMs, easing: 'ease-out', fill: 'backwards' });
      a.onfinish = () => { try { a.cancel(); } catch { /* 已释放 */ } };
      fired++;
    } catch { /* 单个 chip 失败不影响其余 */ }
  }
  return fired;
}

// ==================== 双端挂载（与 .js 版同构） ====================
// 经典 script：顶层 function 声明自动挂 window 全局（main.js 直接引用）
// node:test：require('./spring-anim.js') 走此守卫
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = {
    springFrames, entryFrames, playEntryAnim, playLandingGlow,
    playSettleWave, playTagInsert, SPRING_ENTRY, PUSH_SPRING, WAVE, TAG_INSERT,
  };
}
