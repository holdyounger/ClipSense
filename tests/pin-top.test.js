/**
 * pin-top.red.test.js - 置顶功能红灯测试（2026-11-11，L3 第 2 站测试角色）
 *
 * 转绿记录（2026-11-11）：实现完成后已从 tests/red/ 移入 tests/ 根目录，进全量门禁。
 * 断言面（spec FR1-FR7 / plan D1-D6 的机器可验子集，映射见
 * Docs/测试用例-置顶功能-2026-11-11.md 红灯覆盖映射）：
 *   1) 纯函数面：dist/main/pin-utils.js 导出 applyPinToggle / trimWithPinned
 *      （置顶 toggle 与容量裁剪收敛为无 electron 依赖纯函数——同
 *      pet-interaction / tag-utils 先例，dist 直测）
 *   2) wiring 静态守卫：preload / main(index) / main.ts / main.css / storage.ts
 *      的置顶接线（同 css-resize-perf 静态断言口径）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// 纯函数模块（红灯：dist/main/pin-utils.js 尚不存在 → require 失败 → 全断言红灯）
let pu = {};
try {
  pu = require(path.join(ROOT, 'dist', 'main', 'pin-utils.js'));
} catch {
  pu = {};
}

describe('置顶纯函数面（FR5/D5+D6：toggle 与容量豁免收敛为纯函数）', () => {
  test('pin-utils 导出 applyPinToggle（置顶 toggle：上限 10 / 重复取消）', () => {
    assert.strictEqual(typeof pu.applyPinToggle, 'function');
  });

  test('pin-utils 导出 trimWithPinned（LRU 裁剪跳过 pinned 条目）', () => {
    assert.strictEqual(typeof pu.trimWithPinned, 'function');
  });

  test('applyPinToggle：未置顶→置顶成功 {ok:true,pinned:true,count}，写 pinnedAt', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: 'a' + i, timestamp: i }));
    const r = pu.applyPinToggle(items, 'a0', 10, 1700000000000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pinned, true);
    assert.strictEqual(r.count, 1);
    const it = r.items.find((x) => x.id === 'a0');
    assert.strictEqual(it.pinned, true);
    assert.strictEqual(it.pinnedAt, 1700000000000);
  });

  test('applyPinToggle：已置顶→取消 {ok:true,pinned:false}，pinnedAt 清除', () => {
    const items = [{ id: 'x', timestamp: 1, pinned: true, pinnedAt: 123 }];
    const r = pu.applyPinToggle(items, 'x', 10, 1700000000000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pinned, false);
    assert.strictEqual(r.count, 0);
    const it = r.items.find((x) => x.id === 'x');
    assert.strictEqual(it.pinned, false);
    assert.ok(!it.pinnedAt);
  });

  test('applyPinToggle：满 10 条再置顶第 11 条→拒绝 {ok:false}', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: 'a' + i, timestamp: i }));
    const full = items.map((x, i) => (i < 10 ? { ...x, pinned: true, pinnedAt: i } : x));
    const r = pu.applyPinToggle(full, 'a10', 10, 1700000000000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.count, 10);
  });

  test('trimWithPinned：裁剪到上限时置顶条目永不被剔除', () => {
    const items = [
      { id: 'p1', timestamp: 1, pinned: true },
      { id: 'p2', timestamp: 2, pinned: true },
      ...Array.from({ length: 6 }, (_, i) => ({ id: 'n' + i, timestamp: 100 + i })),
    ];
    const out = pu.trimWithPinned(items, 4);
    assert.strictEqual(out.length, 4);
    assert.ok(out.find((x) => x.id === 'p1'), '置顶 p1 必须保留');
    assert.ok(out.find((x) => x.id === 'p2'), '置顶 p2 必须保留');
  });

  test('trimWithPinned：无置顶时行为退化为普通 LRU 裁剪', () => {
    // monitor.history 语义：最新在前（unshift），尾部即最旧——合成数据同步该序
    const items = Array.from({ length: 6 }, (_, i) => ({ id: 'n' + i, timestamp: 10 - i }));
    const out = pu.trimWithPinned(items, 3);
    assert.strictEqual(out.length, 3);
    assert.ok(out.every((x) => x.timestamp >= 8), '保留最新 timestamp（尾部淘汰）');
  });
});

describe('置顶 wiring 静态守卫（FR1/FR2/FR3/FR6/D1/D2/D6）', () => {
  test('preload 暴露 togglePin（clipboard:toggle-pin 频道）', () => {
    assert.ok(/toggle-pin|togglePin/.test(read('src/renderer/preload.ts')), 'preload 应含 toggle-pin 通路');
  });

  test('main 进程 setupIPC 注册 clipboard:toggle-pin handler', () => {
    assert.ok(/toggle-pin/.test(read('src/main/index.ts')), '主进程应注册 toggle-pin');
  });

  test('渲染层置顶分组接线（已置顶 分组线 + pinned 字段消费）', () => {
    // 分组线文案在 renderHistory（renderer.ts）；pinned 筛选豁免在 main.ts
    assert.ok(/已置顶/.test(read('src/renderer/renderer.ts')), 'renderHistory 应有置顶分组线文案');
    assert.ok(/pinned/.test(read('src/renderer/main.ts')), 'main.ts 应消费 pinned 字段（筛选豁免）');
  });

  test('main.css 置顶样式（.item-pin 按钮 + 置顶分组线）', () => {
    const css = read('src/renderer/main.css');
    assert.ok(/\.item-pin/.test(css), '应有 .item-pin 样式');
    assert.ok(/pin-group|pinned-group|已置顶/.test(css), '应有置顶分组线样式');
  });

  test('storage 持久化 pinned 字段（StorageItem 增量）', () => {
    assert.ok(/pinned/.test(read('src/main/storage.ts')), 'StorageItem 应含 pinned');
  });
});
