/**
 * pet-interaction.test.js - 桌宠交互决策单元测试（2026-10-30）
 *
 * 背景：桌宠交互链路（单击/菜单/拖拽）与双击粘贴在动态穿透/启动时序/目标选择
 * 上连续回归，本套测试把「决策点」收敛为纯函数并锁死行为，防止循环返工。
 * 直测 dist 编译产物（与 pet-manager.test.js 同口径：改 .ts 后先 npm run build:ts 再测）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const pm = require(path.join(__dirname, '..', 'dist', 'main', 'pet-manager.js'));
const pb = require(path.join(__dirname, '..', 'dist', 'main', 'paste-bridge.js'));
const tu = require(path.join(__dirname, '..', 'dist', 'common', 'tag-utils.js'));

describe('computePetIgnore 命中穿透决策（2026-11-03 B2：透明区占位修复）', () => {
  // 语义（小M 2026-11-03 批准推翻 34b9fe4 恒交互）：本体命中/菜单打开/拖拽中 → 交互；
  // 透明区 → 穿透放行；Alt 恒不参与（34b9fe4 真正根因修复保留：桌宠绝不跟 Alt）。
  // dragging 是新增守卫位——拖拽中一律交互，杜绝 150ms 轮询翻转吞 mousedown。
  test('本体命中 → 交互；透明区 → 穿透', () => {
    assert.strictEqual(pm.computePetIgnore({ cursorOnModel: true }), false);
    assert.strictEqual(pm.computePetIgnore({ cursorOnModel: false }), true);
  });

  test('菜单打开 → 恒交互（无论光标在哪）', () => {
    assert.strictEqual(pm.computePetIgnore({ ctxOpen: true, cursorOnModel: false }), false);
    assert.strictEqual(pm.computePetIgnore({ ctxOpen: true, cursorOnModel: true }), false);
  });

  test('拖拽中 → 恒交互（B2 新守卫：拖拽路径绝不翻转穿透）', () => {
    assert.strictEqual(pm.computePetIgnore({ dragging: true, cursorOnModel: false }), false);
    assert.strictEqual(pm.computePetIgnore({ dragging: true, cursorOnModel: true }), false);
  });

  test('Alt 恒不参与穿透决策（34b9fe4 根因修复保留：假阳性探针不再影响桌宠）', () => {
    assert.strictEqual(pm.computePetIgnore({ altActive: true, cursorOnModel: false }), true);
    assert.strictEqual(pm.computePetIgnore({ altActive: true, cursorOnModel: true }), false);
  });

  test('透明区 + Alt/宽限叠加 → 仍穿透（除 dragging/ctx 外无一票交互）', () => {
    assert.strictEqual(pm.computePetIgnore({ altActive: true, cursorOnModel: false }), true);
  });
});

describe('computePetHit 光标命中判定（2026-11-19 显示后鼠标延迟根因修复）', () => {
  const bounds = { x: 100, y: 200, width: 220, height: 220 };
  // 本体矩形：窗口相对 (20,30) 起、180x160
  const rect = { x: 20, y: 30, w: 180, h: 160 };

  test('body-rect 未上报 → 回退整窗命中（显示瞬间光标在窗内即可交互，不再全窗穿透等半天）', () => {
    // 光标在窗口中心 → 命中
    assert.strictEqual(pm.computePetHit({ x: 210, y: 310 }, bounds, null, false), true);
    // 光标在窗口外 → 不命中（整窗兜底也不该让窗外光标命中）
    assert.strictEqual(pm.computePetHit({ x: 50, y: 50 }, bounds, null, false), false);
    assert.strictEqual(pm.computePetHit({ x: 400, y: 400 }, bounds, null, false), false);
  });

  test('本体矩形就绪 → 未命中需深入 3px 才进入（迟滞，防边界抖动）', () => {
    // 矩形内（离边界 >3px）
    assert.strictEqual(pm.computePetHit({ x: 130, y: 250 }, bounds, rect, false), true);
    // 矩形左边界内 1px（120+1=121 < 120+3）→ 未命中态不进入
    assert.strictEqual(pm.computePetHit({ x: 121, y: 250 }, bounds, rect, false), false);
    // 刚好深入 3px（120+3=123）→ 进入
    assert.strictEqual(pm.computePetHit({ x: 123, y: 250 }, bounds, rect, false), true);
  });

  test('本体矩形就绪 → 已命中需离界 6px 才离开（迟滞）', () => {
    // 矩形左边界外 2px（120-2=118 > 120-6=114）→ 已命中态仍保持
    assert.strictEqual(pm.computePetHit({ x: 118, y: 250 }, bounds, rect, true), true);
    // 离界超过 6px（120-7=113 < 114）→ 离开
    assert.strictEqual(pm.computePetHit({ x: 113, y: 250 }, bounds, rect, true), false);
  });

  test('本体矩形就绪 → 透明区（矩形外）不命中', () => {
    // 窗口左上角透明区
    assert.strictEqual(pm.computePetHit({ x: 105, y: 205 }, bounds, rect, false), false);
  });

  test('坐标口径：rect 为窗口相对、cursor/bounds 为屏幕绝对（100+20=120, 200+30=230）', () => {
    // 本体左下角内侧 (120+2, 230+2) 未命中态需深入 3px → 不入
    assert.strictEqual(pm.computePetHit({ x: 122, y: 232 }, bounds, rect, false), false);
    // (123, 233) 刚好深入 → 命中
    assert.strictEqual(pm.computePetHit({ x: 123, y: 233 }, bounds, rect, false), true);
  });
});

describe('isInPetShowGrace 显示后交互宽限期（2026-11-19 二次修复：显示后鼠标从别处移入首次点击被吞）', () => {
  const GRACE = 900;
  const shownAt = 10000;

  test('show 后宽限期内 → true（强制整窗交互，保证首次点击必达）', () => {
    assert.strictEqual(pm.isInPetShowGrace(shownAt, shownAt, GRACE), true);   // 边界：刚好显示
    assert.strictEqual(pm.isInPetShowGrace(shownAt + 899, shownAt, GRACE), true); // 到期前 1ms
  });

  test('宽限期到期/之后 → false（交回轮廓命中，透明区恢复让行）', () => {
    assert.strictEqual(pm.isInPetShowGrace(shownAt + 900, shownAt, GRACE), false); // 边界：恰好到期
    assert.strictEqual(pm.isInPetShowGrace(shownAt + 5000, shownAt, GRACE), false);
  });

  test('未显示（shownAt=0）/ 非法参数 / 非法 grace → false（防呆，默认不进宽限期）', () => {
    assert.strictEqual(pm.isInPetShowGrace(100, 0, GRACE), false);
    assert.strictEqual(pm.isInPetShowGrace(NaN, shownAt, GRACE), false);
    assert.strictEqual(pm.isInPetShowGrace(100, NaN, GRACE), false);
    assert.strictEqual(pm.isInPetShowGrace(shownAt, shownAt, 0), false);
    assert.strictEqual(pm.isInPetShowGrace(shownAt, shownAt, -1), false);
  });

  test('时钟回拨（now < shownAt）→ false（不误入宽限期）', () => {
    assert.strictEqual(pm.isInPetShowGrace(shownAt - 100, shownAt, GRACE), false);
  });
});

describe('shouldDeferPetStage 启动延迟登场（面板优先语义回归锁）', () => {
  test('桌宠模式 + 面板在场 → 延迟登场（启动优先展示主面板）', () => {
    assert.strictEqual(pm.shouldDeferPetStage({ petMode: true, panelVisible: true }), true);
  });
  test('桌宠模式 + 面板不在场 → 立即创建', () => {
    assert.strictEqual(pm.shouldDeferPetStage({ petMode: true, panelVisible: false }), false);
  });
  test('非桌宠模式 → 永不延迟（贴边/纯隐藏各走各路）', () => {
    assert.strictEqual(pm.shouldDeferPetStage({ petMode: false, panelVisible: true }), false);
    assert.strictEqual(pm.shouldDeferPetStage({ petMode: false, panelVisible: false }), false);
  });
});

describe('resolvePasteTarget 双击粘贴目标决策', () => {
  test('前台抓取优先（自身/瞬态已在上游过滤，非 0 即用）', () => {
    assert.strictEqual(pb.resolvePasteTarget(41885236, 16585736), 41885236);
  });
  test('fgNow=0（真空态/自身过滤）→ 回退 tracked', () => {
    assert.strictEqual(pb.resolvePasteTarget(0, 16585736), 16585736);
  });
  test('双 0 → 0（调用方拒绝注入，宁可不动不贴错）', () => {
    assert.strictEqual(pb.resolvePasteTarget(0, 0), 0);
  });
});

describe('pickBarTag 类型高亮条标签（2026-10-30 UI v3）', () => {
  test('内置标签逐一取色', () => {
    assert.strictEqual(tu.pickBarTag(['link']), 'link');
    assert.strictEqual(tu.pickBarTag(['email']), 'email');
    assert.strictEqual(tu.pickBarTag(['otp']), 'otp');
    assert.strictEqual(tu.pickBarTag(['snippet']), 'snippet');
  });
  test('多标签取优先序首个（link > email > otp > snippet）', () => {
    assert.strictEqual(tu.pickBarTag(['snippet', 'link']), 'link');
    assert.strictEqual(tu.pickBarTag(['email', 'otp']), 'email');
  });
  test('无内置标签/非数组 → null（纯文本条目无色条）', () => {
    assert.strictEqual(tu.pickBarTag(['sensitive']), null);
    assert.strictEqual(tu.pickBarTag([]), null);
    assert.strictEqual(tu.pickBarTag(null), null);
    assert.strictEqual(tu.pickBarTag(undefined), null);
  });
});

describe('显示后交互宽限期 wiring 守卫（index.ts 静态，2026-11-19 二次修复）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');

  test('引入并应用 isInPetShowGrace（纯函数口径一致，不另写判定）', () => {
    assert.match(src, /computePetHit, isInPetShowGrace,/);
    assert.match(src, /isInPetShowGrace\(Date\.now\(\), this\._petShownAt, this\._petShowGraceMs\)/);
    assert.match(src, /const ignore = inGrace \? false : computePetIgnore\(/);
  });

  test('show 时记录显示时刻开宽限期', () => {
    assert.match(src, /this\._petShownAt = Date\.now\(\);/);
  });

  test('轮询间隔 150→50ms + 宽限期结束边沿强制重判（透明区恢复让行）', () => {
    assert.match(src, /if \(this\._petGraceWasActive && !graceNow\) \{\s*this\._applyPetIgnore\(\);/);
    assert.match(src, /\}, 50\);/, '命中轮询降到 50ms');
    assert.doesNotMatch(src, /\}, 150\);/, '不得残留 150ms 命中轮询');
  });
});