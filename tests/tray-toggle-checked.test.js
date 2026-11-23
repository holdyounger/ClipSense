/**
 * tray-toggle-checked.test.js - 托盘开关勾选态跨 IPC 回传（2026-11-19）
 *
 * 背景：托盘菜单 HTML 浮窗化后，原生 Menu 的 checkbox/radio 由 OS 维护 checked
 * 并回调 click(menuItem)。HTML 浮窗没有 OS 菜单，旧实现点击只发 action id、不带
 * checked，主进程 _dispatchTrayAction 无参调用 → 依赖 menuItem.checked 的开关
 * （如「点击桌宠时唤出面板」）全部 TypeError 被静默吞掉、功能 100% 失效。
 *
 * 本测试真执行两段代码验证修复链路：
 *   ① tray-menu.html 内联脚本：checkbox 勾选/取消、radio 选中+同组互斥都正确回传 checked；
 *   ② main/index.ts 的 _dispatchTrayAction：把 checked 合成 menuItem 传给 click 回调。
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const script = read('dist/renderer/tray-menu.html').match(/<script>([\s\S]*?)<\/script>/)[1];

function mkEl(tag) {
  const L = {}, C = [];
  let html = '';
  const e = {
    tagName: tag || 'div', dataset: {}, textContent: '', value: '',
    style: { setProperty() {} },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
    },
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    children: C, parentNode: null,
    appendChild(c) { C.push(c); c.parentNode = e; return c; },
    querySelector() { return mkEl('div'); }, querySelectorAll() { return []; },
    addEventListener(t, f) { (L[t] = L[t] || []).push(f); },
    dispatch(t, ev) { (L[t] || []).forEach((f) => f(ev || { stopPropagation() {} })); },
  };
  return e;
}

/** 每次加载都得到干净的 closing 状态，等价于「重新打开一次托盘菜单」 */
function fresh() {
  const sent = [];
  const doc = {
    documentElement: mkEl('html'), getElementById: () => mkEl('div'),
    createElement: (t) => mkEl(t), addEventListener() {}, querySelector: () => null,
  };
  const fakeRequire = (n) => n === 'electron'
    ? { ipcRenderer: { on() {}, send(ch, d1, d2) { sent.push([ch, d1, d2]); }, invoke: () => Promise.resolve(null) } }
    : require(n);
  const api = new Function('require', 'document', script + ';return {renderNode, syncMark};')(fakeRequire, doc);
  return { api, sent };
}
const actionOf = (sent) => sent.find((s) => s[0] === 'tray-menu:action');

describe('托盘 checkbox/radio 勾选态回传（tray-menu.html 真执行）', () => {
  test('未勾选 → 点「点击桌宠时唤出面板」回传 checked=true', () => {
    const { api, sent } = fresh();
    const cb = { label: '点击桌宠时唤出面板', type: 'checkbox', checked: false, action: 'act_1' };
    api.renderNode(cb).dispatch('click');
    const s = actionOf(sent);
    assert.ok(s, '应发出 tray-menu:action');
    assert.strictEqual(s[1], 'act_1');
    assert.strictEqual(s[2], true, '新勾选态 true 应回传');
    assert.strictEqual(cb.checked, true, '节点数据同步为已勾选');
  });

  test('已勾选 → 点击回传 checked=false', () => {
    const { api, sent } = fresh();
    const cb = { label: '点击桌宠时唤出面板', type: 'checkbox', checked: true, action: 'act_1' };
    api.renderNode(cb).dispatch('click');
    assert.strictEqual(actionOf(sent)[2], false, '取消勾选回传 false');
    assert.strictEqual(cb.checked, false);
  });

  test('radio 点击回传 true，且同组其他 radio 取消勾选', () => {
    const { api, sent } = fresh();
    const parent = mkEl('div');
    const r1 = { label: '桌宠（实验）', type: 'radio', checked: true, action: 'act_r1' };
    const r2 = { label: '贴边', type: 'radio', checked: false, action: 'act_r2' };
    const row1 = api.renderNode(r1), row2 = api.renderNode(r2);
    parent.appendChild(row1); parent.appendChild(row2);
    row2.dispatch('click');
    assert.strictEqual(actionOf(sent)[2], true, 'radio 选中回传 true');
    assert.strictEqual(r2.checked, true);
    assert.strictEqual(r1.checked, false, '同组互斥：r1 取消勾选');
  });

  test('普通菜单项不传 checked（第三参数 undefined）', () => {
    const { api, sent } = fresh();
    const normal = { label: '显示/隐藏', type: 'normal', action: 'act_n' };
    api.renderNode(normal).dispatch('click');
    const s = actionOf(sent);
    assert.strictEqual(s[1], 'act_n');
    assert.strictEqual(s[2], undefined, '普通项不构造 checked');
  });
});

describe('主进程 _dispatchTrayAction 合成 menuItem（index.ts 真执行）', () => {
  const src = read('src/main/index.ts');
  const m = src.match(/_dispatchTrayAction\(id: unknown, checked\?: unknown\): void \{([\s\S]*?)\n  \}/);
  const body = m[1]
    .replace(/this\._trayActions/g, 'ctx._trayActions');
  const run = new Function('ctx', 'id', 'checked', body);

  test('checked=true/false 合成 {checked} 传给 click(menuItem)', () => {
    let got = null, called = 0;
    const ctx = { _trayActions: { a: (mi) => { called++; got = mi; } } };
    run(ctx, 'a', true);
    assert.strictEqual(called, 1);
    assert.deepStrictEqual(got, { checked: true });
    run(ctx, 'a', false);
    assert.deepStrictEqual(got, { checked: false });
  });

  test('普通项无参调用；checked 非 boolean 走防呆无参分支', () => {
    let argc = -1;
    const ctx = { _trayActions: { a: function () { argc = arguments.length; } } };
    run(ctx, 'a', undefined);
    assert.strictEqual(argc, 0);
    run(ctx, 'a', 'true');
    assert.strictEqual(argc, 0, '字符串 true 不得当成 checked');
  });
});
