'use strict';

/**
 * header-hover-ui.js - Header 可变高度·渲染层纯逻辑（方案 A，2026-09-28）
 *
 * 设计稿：Docs/UI方案-header可变高度-2026-09-28.md「方案 A：主进程轮询 + 高度瞬变 FLIP 补偿」
 * 职责边界（本文件只放可直测的纯函数 + 控制器工厂）：
 *   - computeFlipDelta：FLIP 位移 Δ 计算（切换同帧前后 getBoundingClientRect().top 差值）
 *   - formatRelativeTime：辅助行「上次复制时间」相对时间格式化（3 分钟前/2 小时前/昨天）
 *   - createHeaderHoverUi：class 切换 + FLIP 补偿控制器（reduced-motion 分支：禁 FLIP 只瞬切）
 *
 * FLIP 物理参数（设计稿固定，不改数值）：spring 240/22（stiffness/damping），
 * 复用 spring-anim.js 的 springFrames 积分器；补偿只动 transform，height 瞬切
 * 是唯一允许的 layout 变更（性能红线零豁免）。
 *
 * 竞争规则（设计稿 A-3 风险条 + 任务书）：列表 innerHTML 重建后的帧内不做 FLIP
 * 补偿（重建本身重排，再补一道反而脏）——main.js 在重建点调 markListRebuilt()，
 * 其后一帧内的 hover 切换只瞬切。
 */

/** FLIP 补偿 spring 参数（设计稿 A-2：spring 240/22） */
const FLIP_SPRING = { stiffness: 240, damping: 22 };

/**
 * FLIP 位移 Δ：header 切换前后 #list 顶边位置差（px）。
 * 展开：list.top 下移 Δ>0 → 先 translateY(-Δ) 钉回旧位再 spring 归零；
 * 收起：Δ<0 同理。返回值即 translateY 初值（-Δ）。
 * 非法输入（NaN/Infinity）→ 0（不补偿，瞬切）。
 *
 * @param {number} topBefore 切换同帧读取的 list 顶边（px）
 * @param {number} topAfter  class 切换后（强制 reflow 后）读取的 list 顶边（px）
 * @returns {number} FLIP 起始 translateY 值 = -(topAfter - topBefore)
 */
function computeFlipDelta(topBefore, topAfter) {
  if (!Number.isFinite(topBefore) || !Number.isFinite(topAfter)) return 0;
  const d = -(topAfter - topBefore);
  return d === 0 ? 0 : d; // 规范 -0 → 0（避免下游零值判断歧义）
}

/**
 * 相对时间格式化（辅助行「上次复制时间」）：
 *   <60s → 「刚刚」；<60m → 「N 分钟前」；<24h 且今天 → 「N 小时前」；
 *   昨天 → 「昨天 HH:MM」；更早 → 「MM-DD HH:MM」。
 * 语言：zh-CN 中文（默认）；en 走英文等价（just now / Nm ago / Nh ago / yesterday / 日期）。
 * 纯函数（now 注入），node --test 可直测。
 *
 * @param {number|string|Date} ts   history[0].timestamp（epoch ms / ISO / Date）
 * @param {number} [now]            当前 epoch ms（注入用）
 * @param {string} [lang]           'zh-CN' | 'en'
 * @returns {string} 空/非法输入 → ''
 */
function formatRelativeTime(ts, now = Date.now(), lang = 'zh-CN') {
  const t0 = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : Date.parse(ts));
  if (!Number.isFinite(t0)) return '';
  const zh = lang !== 'en';
  const diff = now - t0;
  if (diff < 0) return zh ? '刚刚' : 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return zh ? '刚刚' : 'just now';
  if (min < 60) return zh ? `${min} 分钟前` : `${min}m ago`;
  const hour = Math.floor(min / 60);
  const d = new Date(t0);
  const nowD = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 同一天（含 <24h 但跨零点的按小时口径统一：先判同日）
  const sameDay = d.getFullYear() === nowD.getFullYear()
    && d.getMonth() === nowD.getMonth() && d.getDate() === nowD.getDate();
  if (sameDay) return zh ? `${hour} 小时前` : `${hour}h ago`;
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  const isYesterday = d.getFullYear() === yest.getFullYear()
    && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate();
  if (isYesterday || hour < 24) {
    return zh ? `昨天 ${hm}` : `yesterday ${hm}`;
  }
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return zh ? `${md} ${hm}` : `${md} ${hm}`;
}

/**
 * hover 展开/收起控制器（渲染层 main.js 组装；DOM/定时器/rAF 均可注入，便于桩测）。
 *
 * 时序（交付汇报口径）：主进程判定 → IPC 'header:hover' → applyHover(bool)
 *   → 同帧：读 list.top → classList 切 .header--hover → 读 list.top' → 
 *   transform:translateY(-(Δ)) 钉回 → 双 rAF 后 spring(240/22) 过渡归零（只动 transform）。
 * reduced-motion：跳过 FLIP，class 瞬切（CSS 侧过渡也已禁用）。
 * 列表重建竞争：markListRebuilt() 后下一帧内的 applyHover 只瞬切不补偿。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.headerEl
 * @param {HTMLElement} deps.listEl
 * @param {Function} deps.springFrames  spring-anim.js 积分器注入
 * @param {()=>boolean} [deps.reducedMotion]
 * @param {(fn:Function)=>void} [deps.raf]  默认 requestAnimationFrame
 * @param {(el:HTMLElement, frames:Array, opts:object)=>*} [deps.animate]  WAAPI 注入点
 * @returns {{applyHover:Function, markListRebuilt:Function, snap:Function}}
 */
function createHeaderHoverUi(deps) {
  const { headerEl, listEl, springFrames } = deps;
  const reducedMotion = typeof deps.reducedMotion === 'function'
    ? deps.reducedMotion
    : () => (typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const raf = typeof deps.raf === 'function' ? deps.raf
    : (typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : null);
  const topOf = (el) => {
    try { return el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().top : NaN; }
    catch (_) { return NaN; }
  };

  let rebuiltPending = false; // 列表重建后、下一帧前的瞬切窗口
  let activeAnim = null;
  let playGen = 0; // D-1：Play 代际令牌——snap/新一轮 FLIP 作废未决 Play 回调（防影子动画）

  /** main.js 重建列表后调用：此后第一帧内的 hover 切换不做 FLIP（只瞬切） */
  function markListRebuilt() {
    rebuiltPending = true;
    if (typeof raf === 'function') {
      raf(() => { raf(() => { rebuiltPending = false; }); });
    } else {
      rebuiltPending = false;
    }
  }

  /** 滑出 snap：窗口在滑走，跳过收起补间直接回静止态（约束 4） */
  function snap() {
    playGen++; // D-1 修复：作废未决 Play rAF（否则下一帧以旧 Invert 值起播影子动画）
    if (activeAnim) { try { activeAnim.cancel(); } catch (_) { /* 已释放 */ } activeAnim = null; }
    if (listEl && listEl.style) listEl.style.transform = '';
    if (headerEl && headerEl.classList) headerEl.classList.remove('header--hover');
  }

  /**
   * 应用 hover 态（IPC 'header:hover' 回调入口）。
   * @param {boolean} expanded
   */
  function applyHover(expanded) {
    if (!headerEl || !headerEl.classList) return;
    const was = headerEl.classList.contains('header--hover');
    if (was === !!expanded) return; // 幂等短路

    const flip = !reducedMotion() && !rebuiltPending && typeof raf === 'function'
      && typeof springFrames === 'function';

    if (!flip) {
      // 瞬切分支（reduced-motion / 重建竞争帧 / 无 rAF 环境）
      snap();
      headerEl.classList.toggle('header--hover', !!expanded);
      return;
    }

    // FLIP：First（切换前读 top）
    const topBefore = topOf(listEl);
    headerEl.classList.toggle('header--hover', !!expanded);
    // Last（classList 变更强制同步布局后读 top'）
    const topAfter = topOf(listEl);
    const dy = computeFlipDelta(topBefore, topAfter);
    if (!Number.isFinite(dy) || dy === 0) return; // 无位移（search-open 锁高等场景）

    // Invert：钉回旧位
    if (listEl.style) listEl.style.transform = `translateY(${dy}px)`;
    // Play：下一帧起 spring 归零（只动 transform）
    if (activeAnim) { try { activeAnim.cancel(); } catch (_) { /* 已释放 */ } }
    const myGen = ++playGen; // D-1 修复：作废更早的未决 Play
    raf(() => {
      if (myGen !== playGen) return; // 已被 snap/新一轮 FLIP 接管——影子动画防护
      const frames = springFrames({
        from: dy, to: 0, velocity: 0,
        stiffness: FLIP_SPRING.stiffness, damping: FLIP_SPRING.damping,
        settlePos: 0.5, settleVel: 8,
      }).map((f) => ({ transform: `translateY(${f.x.toFixed(2)}px)` }));
      if (!frames || frames.length < 2) {
        if (listEl.style) listEl.style.transform = '';
        return;
      }
      frames.unshift({ transform: `translateY(${dy.toFixed(2)}px)` });
      const durationMs = Math.round(frames.length * (1000 / 60));
      try {
        const anim = listEl.animate
          ? listEl.animate(frames, { duration: durationMs, easing: 'linear', fill: 'none' })
          : null;
        activeAnim = anim;
        if (anim) {
          anim.onfinish = () => {
            try { anim.cancel(); } catch (_) { /* 已释放 */ }
            if (listEl.style) listEl.style.transform = '';
            activeAnim = null;
          };
        } else if (listEl.style) {
          listEl.style.transform = ''; // 无 WAAPI：瞬落位
        }
      } catch (_) {
        if (listEl.style) listEl.style.transform = '';
        activeAnim = null;
      }
    });
  }

  return { applyHover, markListRebuilt, snap };
}

if (typeof module !== 'undefined') {
  module.exports = { computeFlipDelta, formatRelativeTime, createHeaderHoverUi, FLIP_SPRING };
}
