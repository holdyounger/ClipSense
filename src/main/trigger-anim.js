/**
 * trigger-anim.js - 贴边触发条「真抽屉」收纳动画：关键帧预积分 + 注入脚本生成
 * （V0.5，2026-09-12，小M 核定「真抽屉版」；设计稿 Docs/UI方案-新条目动画-2026-09-11.md）
 *
 * 物理叙事：新内容到达 = 抽屉被拉开 → 内容塞入 → 抽屉推回关上。
 * 三段式状态迁移（开→合），收尾有明确「关好了」语义 = 「已收纳」的确认感。
 *   ① 拉开：条体（抽屉前板）沿屏幕横向向屏内滑出 DRAWER.travel px，
 *      露出柜内亮光（#cavity 渐变，透明度随拉开进度上升）
 *   ② 塞入：光珠 spring 自条顶上方坠入缝隙，撞击后被吸收（缩小渐隐）
 *   ③ 推回：抽屉弹簧回位（420/30，与主窗口推入波同刚度），初速固定朝关闭方向，
 *      缝隙光随关闭指数收熄——「咔哒」关上，静息无二次抖动
 *
 * 窗口扩缩（真抽屉的前提，小M 豁免 5b92598「窗口宽度=命中区」约束）：
 *   静止态窗口保持 6px（命中区=可见条不变）；动画期间由主进程临时扩宽
 *   travel px（拉出空间），播完缩回。扩缩编排在本模块导出的常量支撑下由
 *   index.js 的 window-entry-pulse 处理器执行（本模块只管关键帧与脚本）。
 *
 * 硬约束：
 *   - 只写 transform/opacity（合成层友好），不触发 layout
 *   - 关键帧预积分一次性完成；回放结束 reset 到静息并 cancel rAF，不驻留合成层
 *   - 不新增窗口；总时长 ≤ 520ms（MAX_FRAMES=32 兜底）
 *   - 连续多条到达：重触发经 __clipSenseBarStop 复位重放（每条各开合一次）
 *
 * 触发条是 data:URL 独立文档，无法 require 渲染层 spring-anim.js——本模块在
 * 主进程侧用同源半隐式欧拉积分器预积分，生成注入回放脚本（~25 行 rAF 回放），
 * 且积分器可在 node:test 直接单测（tests/trigger-anim.test.js）。
 */

/** 积分步长（ms）：关键帧按 60fps 网格生成，回放按时间索引（与刷新率解耦） */
const DT_MS = 1000 / 60;
/** 总帧数上限（48 帧 ≈ 800ms），防参数异常时无界回放；
 *  V0.5.1 节奏放缓（小M 反馈「太快，要顺滑」）后三段总时长 ≈650ms，需更大兑底 */
const MAX_FRAMES = 48;

/** 抽屉几何与拉开弹簧：刚度 340→200、阻尼 26→20（软化 = 更慢更柔的拉开弧线） */
const DRAWER = { travel: 18, restWidth: 6, openStiffness: 200, openDamping: 20 };
/** 光珠（新内容具象）下落吸附弹簧：软化下落弧线，初速略增补回下落存在感 */
const BEAD = { from: -24, velocity: 80, stiffness: 220, damping: 16 };
/** 光珠起落延迟帧：3→6（缝隙完全打开后再塞入，叙事更从容） */
const BEAD_START = 6;
/** 推回弹簧：420/30/-150 → 240/24/-90（去冲击感：从「砸关」变「推合」，
 *  收尾依旧机械限位钳制 + 过阻尼停靠） */
const CLOSE = { stiffness: 240, damping: 24, velocity: -90 };
/** 柜内亮光包络：衰减时间常数 5→8 帧（关屋后余辉拖长，过渡更顺滑） */
const GLOW = { peak: 0.95, tau: 8 };
/** 光珠吸收渐隐时间常数（帧）：3→4.5 */
const BEAD_FADE_TAU = 4.5;

/**
 * 半隐式欧拉 spring 积分（与渲染层 spring-anim.js 同源算法）：
 * 先更新速度、再更新位移；位移与速度同时进入阈值视为收敛，
 * 补一帧精确落位（避免末帧残差）。
 *
 * @param {object} o
 * @param {number} o.from       起始值（px）
 * @param {number} o.to         目标值
 * @param {number} [o.velocity] 初速（px/s，符号即方向）
 * @param {number} o.stiffness  刚度
 * @param {number} o.damping    阻尼
 * @param {number} [o.mass]     质量
 * @param {number} [o.maxFrames] 最大帧数
 * @param {number} [o.settlePos] 位移收敛阈值（px）
 * @param {number} [o.settleVel] 速度收敛阈值（px/s）
 * @returns {Array<{x:number,v:number}>} 逐帧状态
 */
function springFrames(o) {
  const {
    from, to, velocity = 0, stiffness, damping, mass = 1,
    maxFrames = MAX_FRAMES, settlePos = 0.3, settleVel = 6,
  } = o;
  const frames = [];
  let x = from;
  let v = velocity;
  for (let i = 0; i < maxFrames; i++) {
    const a = (-stiffness * (x - to) - damping * v) / mass;
    v += a * (1 / 60);
    x += v * (1 / 60);
    frames.push({ x, v });
    if (Math.abs(x - to) < settlePos && Math.abs(v) < settleVel) {
      frames.push({ x: to, v: 0 }); // 精确落位帧
      break;
    }
  }
  return frames;
}

/**
 * 预积分「真抽屉」三段关键帧。
 * 帧字段：dx=抽屉拉出量(px，0=关闭，正值=向屏内拉出；方向由回放器按边镜像)；
 *        g=柜内亮光不透明度；y=光珠 translateY(px)；s=光珠 scale；o=光珠 opacity。
 * @returns {{frames:Array, beadImpactFrame:number, beadImpactVelocity:number, durationMs:number}}
 */
function buildKeyframes() {
  // ① 拉开：0 → travel，软化弹簧（更慢更柔的拉开弧线）；上限放宽防中途截断；
  //    同样机械限位 [0, travel]（软化后 ≈1px 过冲被柜框挡住，不出窗）
  const open = springFrames({
    from: 0, to: DRAWER.travel, velocity: 0,
    stiffness: DRAWER.openStiffness, damping: DRAWER.openDamping,
    maxFrames: 28, settlePos: 0.2, settleVel: 4,
  });
  // ② 光珠下落（延迟 BEAD_START 帧起落，等缝隙露出）
  const bead = springFrames({
    from: BEAD.from, to: 0, velocity: BEAD.velocity,
    stiffness: BEAD.stiffness, damping: BEAD.damping,
    maxFrames: 32, settlePos: 0.4, settleVel: 8,
  });
  let impact = bead.findIndex((f) => f.x >= 0);
  if (impact < 0) impact = bead.length - 1;
  const beadImpactVelocity = bead[impact].v;
  const beadEnd = BEAD_START + impact; // 光珠抵达缝内的全局帧

  // ③ 推回：塞入后立刻启动，初速朝关闭（塞入动量推回），软化弹簧压住回弹
  const closeStart = beadEnd + 1;
  const close = springFrames({
    from: DRAWER.travel, to: 0, velocity: CLOSE.velocity,
    stiffness: CLOSE.stiffness, damping: CLOSE.damping,
    maxFrames: 32, settlePos: 0.2, settleVel: 4,
  });

  const total = Math.min(MAX_FRAMES, closeStart + close.length);
  const frames = [];
  for (let i = 0; i < total; i++) {
    // 抽屉位移：拉开段走 open；closeStart 起走 close（衔接帧取 open 当前值，
    // 与 close 起点几乎重合，无跳变）。dx 钉在 [0, travel]：关上后的微小
    // 弹簧过冲被柜体框架挡住（机械限位），不会把条推出屏外被窗口裁剪；
    // 拉开段同钳（软化后 ≈1px 过冲不出窗，视觉为「开满短暂持住」）。
    let dx;
    if (i < closeStart) {
      dx = Math.max(0, Math.min(DRAWER.travel, open[Math.min(i, open.length - 1)].x));
    } else {
      dx = Math.max(0, Math.min(DRAWER.travel, close[i - closeStart].x));
    }
    // 柜内亮光：拉开段随开口增大渐亮，推回段按指数收熄（能量被封闭在柜内）
    let g;
    if (i <= closeStart) {
      const rise = i / Math.max(1, closeStart);
      g = GLOW.peak * Math.pow(rise, 1.4);
    } else {
      g = GLOW.peak * Math.exp(-(i - closeStart) / GLOW.tau);
    }
    // 光珠：延迟起落 → 坠入 → 撞击后被吸收（缩小渐隐）
    let y = 0, s = 0, o = 0;
    if (i >= BEAD_START) {
      const bi = i - BEAD_START;
      const bf = bead[Math.min(bi, bead.length - 1)];
      y = bf.x;
      if (bi <= impact) {
        const rise = impact > 0 ? bi / impact : 1;
        o = rise;
        s = 0.6 + 0.6 * rise;
      } else {
        const t = bi - impact;
        o = Math.max(0, Math.exp(-t / BEAD_FADE_TAU));
        s = 1.2 * Math.exp(-t / 3.5);
      }
    }
    frames.push({
      dx: Number(dx.toFixed(2)),
      g: Number(g.toFixed(3)),
      y: Number(y.toFixed(2)),
      s: Number(s.toFixed(3)),
      o: Number(o.toFixed(3)),
    });
  }
  // 收尾帧精确静息（抽屉关严、缝隙光收熄、光珠被吞）
  const last = frames[frames.length - 1];
  last.dx = 0; last.g = 0; last.y = 0; last.s = 0; last.o = 0;
  return {
    frames,
    impactFrame: beadEnd,
    beadImpactVelocity,
    durationMs: frames.length * DT_MS,
  };
}

/**
 * 生成注入触发条 data:URL 的回放脚本。
 * 协议：window.__clipSenseBarPulse() 无参调用（旧调用兼容）；
 *       连续重触发经 window.__clipSenseBarStop 复位，不叠加。
 * 约束：不得含反引号 / ${（宿主是 index.js 的模板字面量）/ </script>。
 * @returns {string}
 */
function buildTriggerScript() {
  const { frames } = buildKeyframes();
  return `window.__clipSenseBarFrames = ${JSON.stringify(frames)};
window.__clipSenseBarApplyEdge = function (edge) {
  var bar = document.getElementById('bar');
  var cav = document.getElementById('cavity');
  var bead = document.getElementById('bead');
  if (!bar) return;
  bar.className = (edge === 'left') ? 'left' : 'right';
  if (!cav || !bead) return;
  if (edge === 'left') {
    cav.style.left = '0px'; cav.style.right = 'auto';
    cav.style.background = 'linear-gradient(90deg, rgba(162,155,254,.85), rgba(255,255,255,.5) 55%, transparent)';
    bead.style.left = '2px'; bead.style.right = 'auto';
  } else {
    cav.style.right = '0px'; cav.style.left = 'auto';
    cav.style.background = 'linear-gradient(270deg, rgba(162,155,254,.85), rgba(255,255,255,.5) 55%, transparent)';
    bead.style.right = '2px'; bead.style.left = 'auto';
  }
};
window.__clipSenseBarPulse = function () {
  var bar = document.getElementById('bar');
  var cav = document.getElementById('cavity');
  var bead = document.getElementById('bead');
  var frames = window.__clipSenseBarFrames;
  if (!bar || !cav || !bead || !frames || !frames.length) return;
  if (window.__clipSenseBarStop) window.__clipSenseBarStop();
  var dir = (bar.className === 'left') ? 1 : -1;
  var raf = 0, start = 0;
  function reset() {
    bar.style.transform = '';
    cav.style.opacity = '0';
    bead.style.transform = 'translateY(0px) scale(0)';
    bead.style.opacity = '0';
  }
  function cleanup() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    reset();
    window.__clipSenseBarStop = null;
  }
  window.__clipSenseBarStop = cleanup;
  function step(ts) {
    if (start === 0) start = ts;
    var idx = Math.min(frames.length - 1, Math.floor((ts - start) / ${DT_MS}));
    var f = frames[idx];
    bar.style.transform = 'translateX(' + (dir * f.dx).toFixed(2) + 'px)';
    cav.style.opacity = String(f.g);
    bead.style.transform = 'translateY(' + f.y + 'px) scale(' + f.s + ')';
    bead.style.opacity = String(f.o);
    if (idx >= frames.length - 1) { cleanup(); return; }
    raf = requestAnimationFrame(step);
  }
  reset();
  raf = requestAnimationFrame(step);
};`;
}

/** 预积分总时长（主进程编排扩窗回缩用；纯函数，模块加载时算一次） */
const TOTAL_MS = buildKeyframes().durationMs;

module.exports = {
  springFrames, buildKeyframes, buildTriggerScript,
  DRAWER, BEAD, BEAD_START, CLOSE, GLOW, BEAD_FADE_TAU, DT_MS, MAX_FRAMES, TOTAL_MS,
};
