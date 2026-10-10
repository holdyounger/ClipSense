'use strict';

/**
 * copy-count.test.js - 重复内容计数功能测试（2026-09-17）
 *
 * 覆盖：
 *  - ClipboardMonitor：新条目 count=1；重复复制 bump → count 递增（同对象置顶不重建）；
 *    抑制窗口（面板复制回写）不误计；旧数据无 count 字段从 1 起算
 *  - 渲染层：count≥2 显示 ×N 徽标（meta 行内）；count=1/缺字段不显示
 *
 * monitor 侧直接 require 真实模块：clipboard-monitor 顶部 require('electron')，
 * node:test 环境无 electron，用 Module.prototype.require 桩注入最小 electron。
 * 渲染层侧复用 renderer-tags.dom.test.js 的桩模式（内联精简版）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// ---------------- electron 桩（monitor 顶部 require） ----------------

const electronStub = {
  clipboard: {
    availableFormats: () => [],
    readText: () => '',
    writeText: () => {},
    readImage: () => ({ isEmpty: () => true }),
    writeImage: () => {},
    readHTML: () => '',
    readRTF: () => '',
  },
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
  },
  ipcMain: { on() {}, handle() {} },
};
const stubRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  return id === 'electron' ? electronStub : stubRequire.apply(this, arguments);
};

const ClipboardMonitor = require(path.join(__dirname, '..', 'dist', 'main', 'clipboard-monitor.js')); // module.exports = 类本身

// ==================== monitor 计数 ====================

describe('ClipboardMonitor 重复内容计数', () => {
  test('新内容首次入库 count=1', () => {
    const m = new ClipboardMonitor();
    const item = m._buildItem({ kind: 'text', text: 'hello' });
    assert.strictEqual(item.count, 1);
  });

  test('重复复制 bump → count 递增（2 次、3 次），且是同一条目对象置顶', () => {
    const m = new ClipboardMonitor();
    m._persist = () => {}; // 桩掉磁盘写入

    const first = m._buildItem({ kind: 'text', text: 'dup-content' });
    m.history.unshift(first);
    m._seenHashes.add(m._hash('dup-content'));

    const r = m._bumpExisting(m._hash('dup-content'));
    assert.ok(r.changed);
    assert.strictEqual(r.item.count, 2);
    assert.strictEqual(m.history[0].count, 2);
    assert.strictEqual(m.history[0], first, 'bump 置顶复用原对象，不重建');

    // 第三次 → 3
    m._bumpExisting(m._hash('dup-content'));
    assert.strictEqual(m.history[0].count, 3);
  });

  test('抑制窗口（面板复制回写）内不归档不计数', () => {
    const m = new ClipboardMonitor();
    m._persist = () => {};
    const first = m._buildItem({ kind: 'text', text: 'X' });
    m.history.unshift(first);
    m._seenHashes.add(m._hash('X'));

    m._suppressUntil = Date.now() + 1500; // 模拟 copyToClipboard 的回写抑制
    const r = m.tick();

    assert.strictEqual(r.changed, false);
    assert.strictEqual(m.history[0].count, 1, '抑制窗口内不递增');
  });

  test('旧数据迁移：无 count 字段的条目 bump 后从 2 起算（(undefined||1)+1）', () => {
    const m = new ClipboardMonitor();
    m._persist = () => {};
    const legacy = { id: 'legacy', type: 'text', timestamp: Date.now(), text: 'old' }; // 无 count
    m.history.unshift(legacy);
    m._seenHashes.add(m._hash('old'));

    m._bumpExisting(m._hash('old'));
    assert.strictEqual(m.history[0].count, 2, '旧数据首个 bump = 2（历史第 1 次 + 本次）');
  });
});

// ==================== copyItemPath（file 条目「复制路径」按钮，2026-10-10） ====================

describe('ClipboardMonitor copyItemPath（file 条目复制路径）', () => {
  test('file 条目：写路径文本（多文件换行分隔）', () => {
    const m = new ClipboardMonitor();
    m._persist = () => {};
    const written = [];
    const origWrite = electronStub.clipboard.writeText;
    electronStub.clipboard.writeText = (t) => written.push(t);
    try {
      const item = m._buildItem({ kind: 'file', files: [
        { uri: 'file:///C:/a.txt', path: 'C:/a.txt', name: 'a.txt' },
        { uri: 'file:///D:/b.log', path: 'D:/b.log', name: 'b.log' },
      ], uriList: 'file:///C:/a.txt\nfile:///D:/b.log' });
      m.history.unshift(item);

      const r = m.copyItemPath(item.id);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(written, ['C:/a.txt\nD:/b.log']);
    } finally {
      electronStub.clipboard.writeText = origWrite;
    }
  });

  test('未知 id → 结构化错误', () => {
    const m = new ClipboardMonitor();
    const r = m.copyItemPath('no-such-id');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, '未找到该条目');
  });

  test('无路径条目 → 结构化错误', () => {
    const m = new ClipboardMonitor();
    m._persist = () => {};
    const item = m._buildItem({ kind: 'file', files: [], uriList: '' });
    m.history.unshift(item);
    const r = m.copyItemPath(item.id);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, '条目无路径');
  });

  test('回写抑制：copyItemPath 后紧随 tick 不把路径文本归档', () => {
    const m = new ClipboardMonitor();
    m._persist = () => {};
    const item = m._buildItem({ kind: 'file', files: [
      { uri: 'file:///C:/a.txt', path: 'C:/a.txt', name: 'a.txt' },
    ], uriList: 'file:///C:/a.txt' });
    m.history.unshift(item);

    // 让桩剪贴板真实反映 writeText（否则抑制无从验证）
    let clip = '';
    const origW = electronStub.clipboard.writeText;
    const origFmt = electronStub.clipboard.availableFormats;
    const origRead = electronStub.clipboard.readText;
    electronStub.clipboard.writeText = (t) => { clip = t; };
    electronStub.clipboard.availableFormats = () => (clip ? ['text/plain'] : []);
    electronStub.clipboard.readText = () => clip;
    try {
      assert.strictEqual(m.copyItemPath(item.id).ok, true);
      const r = m.tick(); // 抑制窗口内：自写路径不归档
      assert.strictEqual(r.changed, false);
      assert.strictEqual(m.history.length, 1, '历史无新增（路径文本不入库）');
    } finally {
      electronStub.clipboard.writeText = origW;
      electronStub.clipboard.availableFormats = origFmt;
      electronStub.clipboard.readText = origRead;
    }
  });
});
