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