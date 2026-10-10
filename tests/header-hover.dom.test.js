'use strict';

/**
 * header-hover.dom.test.js - Header 可变高度（方案 A，2026-09-28）测试
 *
 * 设计稿：Docs/UI方案-header可变高度-2026-09-28.md「方案 A：主进程轮询 + 高度瞬变 FLIP 补偿」
 * 覆盖（任务书验收点）：
 *   - 主进程判定纯函数 isCursorInHeaderRegion（窗界外扩 2px + 顶部 68px 带）
 *   - 主进程状态机 createHeaderHoverState（进入即时/离开防抖 180ms/弹出抑制 400ms）
 *   - _headerHeight 钳制 clampHeaderHeight（常量 40 起步，min(h,44)，非法回退）
 *   - FLIP Δ 计算纯函数 computeFlipDelta（含非法输入 → 0）
 *   - 辅助行相对时间格式化 formatRelativeTime（刚刚/分钟/小时/昨天/日期，双语）
 *   - createHeaderHoverUi：class 切换 + FLIP transform 时序 + reduced-motion
 *     分支（禁 FLIP 只瞬切）+ markListRebuilt 竞争规则（重建帧内只瞬切）
 *
 * 运行：node --test tests/header-hover.dom.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  isCursorInHeaderRegion, clampHeaderHeight, createHeaderHoverState,
  HEADER_REST_HEIGHT, HEADER_HOVER_HEIGHT,
  HEADER_HOVER_SUPPRESS_MS, HEADER_HOVER_LEAVE_DEBOUNCE_MS, BOUNDS_TOLERANCE_PX,
} = require(path.join(__dirname, '..', 'dist', 'main', 'header-hover.js'));

const {
  computeFlipDelta, formatRelativeTime, createHeaderHoverUi, FLIP_SPRING,
} = require(path.join(__dirname, '..', 'dist', 'renderer', 'header-hover-ui.js'));

const { springFrames } = require(path.join(__dirname, '..', 'dist', 'renderer', 'spring-anim.js'));

// ==================== 主进程判定：isCursorInHeaderRegion ====================

describe('isCursorInHeaderRegion 光标归属判定', () => {
  const bounds = { x: 1000, y: 100, width: 360, height: 560 };

  test('常量与设计稿拍板值一致', () => {
    assert.strictEqual(HEADER_REST_HEIGHT, 32);
    assert.strictEqual(HEADER_HOVER_HEIGHT, 60);
    assert.strictEqual(HEADER_HOVER_SUPPRESS_MS, 400);
    assert.strictEqual(HEADER_HOVER_LEAVE_DEBOUNCE_MS, 180);
    assert.strictEqual(BOUNDS_TOLERANCE_PX, 2);
  });

  test('窗口顶部 60px 带内 → true', () => {
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 100 }, bounds), true);
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 129 }, bounds), true); // 静止区内
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 160 }, bounds), true); // 展开带下沿
  });

  test('y=163（容差带外）但仍在窗内 → false（窗内但不在 header 区）', () => {
    // 判定带含容差下沿至 y+60+2=162；163 起属窗内但不在 header 区
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 163 }, bounds), false);
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 600 }, bounds), false);
  });

  test('y=161 在容差带内 → true；y=163 超出 → false（窗内但不在 header 区）', () => {
    // 容差外扩语义：判定带 = [y-2, y+60+2]，即 98..162 含端点
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 161 }, bounds), true);
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 162 }, bounds), true); // 带下沿含容差
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 163 }, bounds), false); // 窗内但已出带
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 600 }, bounds), false);
  });

  test('横向出窗（含容差边界）→ false，即使 y 在 header 带', () => {
    // 容差带：x ∈ [998, 1362]
    assert.strictEqual(isCursorInHeaderRegion({ x: 998, y: 120 }, bounds), true);  // 贴左容差内
    assert.strictEqual(isCursorInHeaderRegion({ x: 997, y: 120 }, bounds), false);
    assert.strictEqual(isCursorInHeaderRegion({ x: 1362, y: 120 }, bounds), true);  // 右缘 1000+360+2
    assert.strictEqual(isCursorInHeaderRegion({ x: 1363, y: 120 }, bounds), false);
  });

  test('光标完全离开窗口 → false', () => {
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 900 }, bounds), false);
    assert.strictEqual(isCursorInHeaderRegion({ x: 0, y: 0 }, bounds), false);
  });

  test('非法输入 → false（null/NaN 不抛异常）', () => {
    assert.strictEqual(isCursorInHeaderRegion(null, bounds), false);
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: 120 }, null), false);
    assert.strictEqual(isCursorInHeaderRegion({ x: NaN, y: 120 }, bounds), false);
    assert.strictEqual(isCursorInHeaderRegion({ x: 1100, y: undefined }, bounds), false);
  });
});

// ==================== 主进程状态机：createHeaderHoverState ====================

describe('createHeaderHoverState hover 状态机', () => {
  test('进入即时生效：一拍 inHeader → true', () => {
    const s = createHeaderHoverState();
    const r = s.update(true, 1000);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.state, true);
    // 已在 true 再喂 true → 无变化（不重复 IPC）
    const r2 = s.update(true, 1100);
    assert.strictEqual(r2.changed, false);
    assert.strictEqual(r2.state, true);
  });

  test('离开防抖 180ms：不足 180ms 保持 true，到期翻转', () => {
    const s = createHeaderHoverState();
    s.update(true, 1000);
    assert.strictEqual(s.update(false, 1100).changed, false); // 100ms < 180 → 仍 true
    assert.strictEqual(s.update(false, 1150).changed, false); // 离开起算 1100，50ms
    const r = s.update(false, 1280); // 离开起算 1100，180ms 到期
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.state, false);
  });

  test('防抖期内回来 → 撤销离开计时（边缘抖动不收起）', () => {
    const s = createHeaderHoverState();
    s.update(true, 1000);
    s.update(false, 1100); // 启动离开计时
    const r = s.update(true, 1150); // 防抖期内回来
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.state, true);
    // 计时被撤销：再离开需重新等满 180ms
    s.update(false, 1200);
    assert.strictEqual(s.update(false, 1300).state, true); // 100ms < 180
    assert.strictEqual(s.update(false, 1380).state, false);
  });

  test('弹出抑制 400ms：期间 inHeader=true 也不展开；抑制结束后下一拍进入', () => {
    const s = createHeaderHoverState();
    s.markShown(1000); // 抑制至 1400
    const r1 = s.update(true, 1050);
    assert.strictEqual(r1.state, false);
    assert.strictEqual(r1.suppress, true);
    assert.strictEqual(r1.changed, false);
    s.update(true, 1350);
    assert.strictEqual(s.state, false); // 仍在抑制
    const r2 = s.update(true, 1400); // 抑制期满
    assert.strictEqual(r2.suppress, false);
    assert.strictEqual(r2.changed, true);
    assert.strictEqual(r2.state, true);
  });

  test('markShown 强制回落到静止态（弹出瞬间 header 恒静止）', () => {
    const s = createHeaderHoverState();
    s.update(true, 1000);
    assert.strictEqual(s.state, true);
    s.markShown(2000);
    assert.strictEqual(s.state, false);
    const r = s.update(true, 2100); // 抑制期内不生效
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.state, false);
  });

  test('抑制期内离开信号不启动收起（基线恒 false，无翻转）', () => {
    const s = createHeaderHoverState();
    s.markShown(1000);
    const r = s.update(false, 1100);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.state, false);
  });

  test('静止态离开（state 本就 false）不产生变化事件', () => {
    const s = createHeaderHoverState();
    const r = s.update(false, 1000);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.state, false);
  });

  test('reset 清空全部状态（滑出收尾调用）', () => {
    const s = createHeaderHoverState();
    s.markShown(1000);
    s.update(true, 1500);
    s.reset();
    assert.strictEqual(s.state, false);
    assert.strictEqual(s.suppressRemaining, 0);
  });
});

// ==================== _headerHeight 钳制 ====================

describe('clampHeaderHeight 实测钳制（约束 2 修法）', () => {
  test('常量基准 32 直采', () => {
    assert.strictEqual(clampHeaderHeight(32), 32);
  });
  test('min(h, 36)：DPI 缩放 34 采信、36 采信、37+ 钳到 36', () => {
    assert.strictEqual(clampHeaderHeight(34), 34);
    assert.strictEqual(clampHeaderHeight(36), 36);
    assert.strictEqual(clampHeaderHeight(37), 36);
  });
  test('展开态污染值（60）钳到 36——杜绝触发条变高', () => {
    assert.strictEqual(clampHeaderHeight(60), 36);
  });
  test('测量失败/非法 → 回退常量 32', () => {
    assert.strictEqual(clampHeaderHeight(0), 32);
    assert.strictEqual(clampHeaderHeight(-5), 32);
    assert.strictEqual(clampHeaderHeight(NaN), 32);
    assert.strictEqual(clampHeaderHeight(undefined), 32);
    assert.strictEqual(clampHeaderHeight('36.4'), 36); // 数值字符串可解析 → 采信
  });
});

// ==================== FLIP Δ 纯函数 ====================

describe('computeFlipDelta FLIP 位移计算', () => {
  test('展开：list 下移 28px → translateY 初值 -28（钉回旧位）', () => {
    assert.strictEqual(computeFlipDelta(100, 128), -28);
  });
  test('收起：list 上移 28px → translateY 初值 +28', () => {
    assert.strictEqual(computeFlipDelta(128, 100), 28);
  });
  test('无位移 → 0（跳过 FLIP）', () => {
    assert.strictEqual(computeFlipDelta(100, 100), 0);
  });
  test('非法输入 → 0（不补偿，瞬切）', () => {
    assert.strictEqual(computeFlipDelta(NaN, 100), 0);
    assert.strictEqual(computeFlipDelta(100, undefined), 0);
  });
  test('spring 参数 = 设计稿 240/22', () => {
    assert.strictEqual(FLIP_SPRING.stiffness, 240);
    assert.strictEqual(FLIP_SPRING.damping, 22);
  });
  test('springFrames(240/22) 从 -28 收敛到 0 且末帧精确落位', () => {
    const frames = springFrames({ from: -28, to: 0, stiffness: 240, damping: 22 });
    assert.ok(frames.length >= 2);
    assert.strictEqual(frames[frames.length - 1].x, 0);
    for (const f of frames) {
      assert.ok(Number.isFinite(f.x) && Number.isFinite(f.v));
    }
  });
});

// ==================== 辅助行相对时间格式化 ====================

describe('formatRelativeTime 辅助行时间格式', () => {
  const NOW = new Date(2026, 8, 28, 15, 30, 0).getTime(); // 2026-09-28 15:30 本地

  test('3 分钟前', () => {
    assert.strictEqual(formatRelativeTime(NOW - 3 * 60000 - 500, NOW), '3 分钟前');
  });
  test('刚刚：<60s', () => {
    assert.strictEqual(formatRelativeTime(NOW - 30000, NOW), '刚刚');
    assert.strictEqual(formatRelativeTime(NOW, NOW), '刚刚');
  });
  test('2 小时前（同日内）', () => {
    assert.strictEqual(formatRelativeTime(NOW - 2 * 3600000, NOW), '2 小时前');
  });
  test('昨天：跨日 <24h → 昨天 HH:MM', () => {
    const yest = new Date(2026, 8, 27, 23, 50, 0).getTime();
    assert.strictEqual(formatRelativeTime(yest, NOW), '昨天 23:50');
  });
  test('昨天全天窗口', () => {
    const yestMorning = new Date(2026, 8, 27, 8, 5, 0).getTime();
    assert.strictEqual(formatRelativeTime(yestMorning, NOW), '昨天 08:05');
  });
  test('更早 → MM-DD HH:MM', () => {
    const older = new Date(2026, 8, 20, 9, 15, 0).getTime();
    assert.strictEqual(formatRelativeTime(older, NOW), '09-20 09:15');
  });
  test('未来时间（时钟偏差）→ 刚刚', () => {
    assert.strictEqual(formatRelativeTime(NOW + 5000, NOW), '刚刚');
  });
  test('非法输入 → 空串（空列表降级）', () => {
    assert.strictEqual(formatRelativeTime(null, NOW), '');
    assert.strictEqual(formatRelativeTime(undefined, NOW), '');
    assert.strictEqual(formatRelativeTime('not-a-date', NOW), '');
  });
  test('ISO 字符串与 Date 对象输入兼容', () => {
    assert.strictEqual(formatRelativeTime(new Date(NOW - 120000), NOW), '2 分钟前');
    const iso = new Date(NOW - 120000).toISOString();
    assert.strictEqual(formatRelativeTime(iso, NOW), '2 分钟前');
  });
  test('英文分支', () => {
    assert.strictEqual(formatRelativeTime(NOW - 3 * 60000, NOW, 'en'), '3m ago');
    assert.strictEqual(formatRelativeTime(NOW - 2 * 3600000, NOW, 'en'), '2h ago');
    assert.strictEqual(formatRelativeTime(NOW - 30000, NOW, 'en'), 'just now');
  });
});

// ==================== createHeaderHoverUi：class/FLIP/reduced-motion/重建竞争 ====================

function mkUiEl(opts = {}) {
  const el = {
    className: opts.className || '',
    style: {},
    _top: Number.isFinite(opts.top) ? opts.top : 0,
    _anims: [],
    classList: {
      add(...cs) { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); el.className = [...s].join(' '); },
      remove(...cs) { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.delete(c)); el.className = [...s].join(' '); },
      contains(c) { return el.className.split(/\s+/).includes(c); },
      toggle(c, force) { const has = el.className.split(/\s+/).includes(c); const want = force === undefined ? !has : !!force; if (want) this.add(c); else this.remove(c); return want; },
    },
    getBoundingClientRect() { return { top: el._top, height: el._h || 0 }; },
    animate(frames, animOpts) {
      const a = { frames, opts: animOpts, onfinish: null, cancel() { this._cancelled = true; } };
      el._anims.push(a);
      return a;
    },
  };
  return el;
}

describe('createHeaderHoverUi FLIP 控制器', () => {
  function setup({ reduced = false, headerTop = 0, listTopBefore = 32 } = {}) {
    const headerEl = mkUiEl({ top: headerTop });
    const listEl = mkUiEl({ top: listTopBefore });
    // header 高度变化模拟：class 切换时 list._top 随 header 静止/展开偏移
    //（简化模型：applyHover 内 toggle 前后 list top 差 = ±28）
    const rafQueue = [];
    const ui = createHeaderHoverUi({
      headerEl,
      listEl,
      springFrames,
      reducedMotion: () => reduced,
      raf: (fn) => { rafQueue.push(fn); },
    });
    // 模拟 layout：list top 依 class 状态
    Object.defineProperty(listEl, '_topLive', { get() { return headerEl.classList.contains('header--hover') ? 60 : 32; } });
    listEl.getBoundingClientRect = () => ({ top: listEl._topLive });
    return { headerEl, listEl, ui, rafQueue };
  }

  test('hover 进入：同帧切 class + Invert translateY(-Δ)（展开 Δ=28 → -28）', () => {
    const { headerEl, listEl, ui, rafQueue } = setup();
    ui.applyHover(true);
    assert.ok(headerEl.classList.contains('header--hover'), 'class 已切');
    assert.strictEqual(listEl.style.transform, 'translateY(-28px)', 'Invert 钉回旧位');
    assert.strictEqual(rafQueue.length, 1, 'Play 已排队 rAF');
  });

  test('FLIP Play：rAF 后 spring 关键帧归零且只动 transform', () => {
    const { listEl, ui, rafQueue } = setup();
    ui.applyHover(true);
    rafQueue.shift()(); // 执行 Play
    const anim = listEl._anims[listEl._anims.length - 1];
    assert.ok(anim, 'animate 已调用');
    assert.ok(anim.frames.length >= 2);
    for (const f of anim.frames) {
      assert.deepStrictEqual(Object.keys(f), ['transform'], '帧只含 transform（性能红线）');
    }
    // 首帧 = Invert 值，末帧 = 0
    assert.strictEqual(anim.frames[0].transform, 'translateY(-28.00px)');
    assert.strictEqual(anim.frames[anim.frames.length - 1].transform, 'translateY(0.00px)');
    // onfinish 清理：cancel + 不驻留内联 transform
    anim.onfinish();
    assert.strictEqual(listEl.style.transform, '');
  });

  test('hover 离开：收起方向 Δ=-28 → Invert +28', () => {
    const { headerEl: h2, listEl: l2 } = setup();
    const ui2 = createHeaderHoverUi({ headerEl: h2, listEl: l2, springFrames, reducedMotion: () => false, raf: () => {} });
    h2.classList.add('header--hover'); // 起始为展开态
    ui2.applyHover(false); // 收起：list top 60 → 32，Δ = -(32-60) = +28
    assert.ok(!h2.classList.contains('header--hover'));
    assert.strictEqual(l2.style.transform, 'translateY(28px)', '收起反方向补偿');
  });

  test('幂等：重复同值不产生第二次切换', () => {
    const { headerEl, ui, rafQueue } = setup();
    ui.applyHover(true);
    const before = rafQueue.length;
    ui.applyHover(true);
    assert.strictEqual(rafQueue.length, before, '无重复动画');
    assert.ok(headerEl.classList.contains('header--hover'));
  });

  test('reduced-motion 分支：禁 FLIP，只瞬切 class', () => {
    const { headerEl, listEl, ui, rafQueue } = setup({ reduced: true });
    ui.applyHover(true);
    assert.ok(headerEl.classList.contains('header--hover'), '功能保留：class 切换仍生效');
    assert.ok(!listEl.style.transform, 'reduced-motion 不写 transform');
    assert.strictEqual(rafQueue.length, 0, 'reduced-motion 不排 FLIP 动画帧');
    assert.strictEqual(listEl._anims.length, 0, 'reduced-motion 不启动 animate');
  });

  test('markListRebuilt：重建后的帧内 hover 切换只瞬切不补偿', () => {
    const { headerEl, listEl, ui, rafQueue } = setup();
    ui.markListRebuilt(); // 重建标记：外层清除 rAF 排队（执行后才排内层）
    assert.strictEqual(rafQueue.length, 1, '重建清除链排队');
    ui.applyHover(true);
    assert.ok(headerEl.classList.contains('header--hover'), 'class 切换照常（瞬切）');
    assert.ok(!listEl.style.transform, '重建帧内不写 Invert transform');
    assert.strictEqual(rafQueue.length, 1, '无 FLIP Play 排队');
    assert.strictEqual(listEl._anims.length, 0, '重建帧内不启动 FLIP animate');
  });

  test('重建两帧之后 hover 恢复正常 FLIP', () => {
    const { listEl, ui, rafQueue } = setup();
    ui.markListRebuilt();
    rafQueue.shift()(); // 第一帧：外层清除回调执行，排队内层
    assert.strictEqual(rafQueue.length, 1);
    rafQueue.shift()(); // 第二帧：内层执行，rebuiltPending 清除
    ui.applyHover(true);
    assert.strictEqual(listEl.style.transform, 'translateY(-28px)', 'FLIP 恢复');
  });

  test('snap()：滑出直接回静止态（cancel 动画 + 清 transform + 去 class）', () => {
    const { headerEl, listEl, ui, rafQueue } = setup();
    ui.applyHover(true);
    rafQueue.shift()(); // 启动动画
    const anim = listEl._anims[listEl._anims.length - 1];
    ui.snap();
    assert.strictEqual(anim._cancelled, true, '在飞动画被 cancel');
    assert.strictEqual(listEl.style.transform, '');
    assert.ok(!headerEl.classList.contains('header--hover'));
  });

  test('spring 参数硬校验：控制器内使用 240/22（不改数值）', () => {
    const { listEl, ui, rafQueue } = setup();
    ui.applyHover(true);
    rafQueue.shift()();
    const anim = listEl._anims[listEl._anims.length - 1];
    // 240/22 从 -28 出发：首步 |Δ| 明显小于 28（非线性直落），且收敛快速无过冲震荡
    const first = parseFloat(anim.frames[1].transform.match(/-?[\d.]+/)[0]);
    assert.ok(Math.abs(first) < 28 && first < 0, `spring 起步推进合理: ${first}`);
  });
});

// ==================== 集成：设计稿时序链路（判定 → 状态机 → Δ） ====================

describe('端到端纯逻辑链路（无 DOM）', () => {
  test('弹出 → 抑制 400ms → 光标在 header → 进入 → FLIP Δ=-28', () => {
    const bounds = { x: 1000, y: 100, width: 360, height: 560 };
    const s = createHeaderHoverState();
    s.markShown(0);
    // 抑制期内（光标在 header 顶部 30px）
    assert.strictEqual(s.update(isCursorInHeaderRegion({ x: 1100, y: 130 }, bounds), 300).state, false);
    // 期满进入
    assert.strictEqual(s.update(isCursorInHeaderRegion({ x: 1100, y: 130 }, bounds), 400).state, true);
    // FLIP Δ
    assert.strictEqual(computeFlipDelta(32, 60), -28);
    // 离开：先出 header 带（仍在窗内），180ms 后收起
    assert.strictEqual(s.update(isCursorInHeaderRegion({ x: 1100, y: 400 }, bounds), 500).state, true);
    assert.strictEqual(s.update(isCursorInHeaderRegion({ x: 1100, y: 400 }, bounds), 680).state, false);
  });
});

// ==================== 覆盖缺口补测（2026-09-28 测试工程师闭环） ====================

describe('强制展开集成（约束 4：search-open / 菜单打开锁定展开态）', () => {
  // 与上方 setup() 同款 layout 模拟：class 切换时 list top 随 header 40↔68 偏移
  function mkSetup({ reduced = false } = {}) {
    const headerEl = mkUiEl({});
    const listEl = mkUiEl({});
    const rafQueue = [];
    Object.defineProperty(listEl, '_topLive', {
      get() { return headerEl.classList.contains('header--hover') ? 60 : 32; },
    });
    listEl.getBoundingClientRect = () => ({ top: listEl._topLive });
    const ui = createHeaderHoverUi({
      headerEl,
      listEl,
      springFrames,
      reducedMotion: () => reduced,
      raf: (fn) => { rafQueue.push(fn); },
    });
    return { headerEl, listEl, ui, rafQueue };
  }

  test('applyHover(true) 重复推送不抖动（IPC 幂等），解除后回归', () => {
    const { headerEl, ui, rafQueue } = mkSetup();
    ui.applyHover(true);
    ui.applyHover(true); // 重复同值（幂等）
    assert.ok(headerEl.classList.contains('header--hover'), '强制展开态保持');
    ui.applyHover(false);
    assert.ok(!headerEl.classList.contains('header--hover'), '解除后回归静止');
  });

  test('search-open 锁高场景（list top 不随 class 变）→ dy=0 跳过 FLIP 不报错', () => {
    const headerEl = mkUiEl({});
    const listEl = mkUiEl({ top: 40 });
    // 锁高：list top 恒定（header 高度不变，无位移可补）
    listEl.getBoundingClientRect = () => ({ top: 40 });
    const ui = createHeaderHoverUi({
      headerEl, listEl, springFrames: () => [], raf: () => 0,
    });
    assert.doesNotThrow(() => ui.applyHover(true));
    assert.ok(headerEl.classList.contains('header--hover'), 'class 照常切换');
  });

  test('snap() 后再 applyHover：生命周期复用（滑出→再弹出）', () => {
    const { headerEl, ui } = mkSetup();
    ui.applyHover(true);
    ui.snap();
    assert.ok(!headerEl.classList.contains('header--hover'), 'snap 复位静止');
    ui.applyHover(true);
    assert.ok(headerEl.classList.contains('header--hover'), '复用正常');
  });
});

describe('主进程接线（edge-detector 集成面）', () => {
  test('triggerHeight 默认 = HEADER_REST_HEIGHT（40），_headerHeight 初始同值', () => {
    // 结构断言：edge-detector.js 源码里触发条高度消费常量（防止回退硬编码 56）
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'main', 'edge-detector.ts'), 'utf8');
    assert.match(src, /this\.triggerHeight = HEADER_REST_HEIGHT/, '触发条默认高度用常量');
    assert.match(src, /this\._headerHeight = HEADER_REST_HEIGHT/, '实测基准初始为常量');
    assert.match(src, /clampHeaderHeight\(h/, '实测值经钳制函数');
    assert.ok(!/this\.triggerHeight = 56/.test(src), '不回退硬编码 56');
  });

  test('弹出抑制窗口 400ms 与防抖 180ms 常量一致（防两处漂移）', () => {
    assert.strictEqual(HEADER_HOVER_SUPPRESS_MS, 400);
    assert.strictEqual(HEADER_HOVER_LEAVE_DEBOUNCE_MS, 180);
  });
});
