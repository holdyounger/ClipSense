/**
 * tray-menu-mode-gating.test.js - 托盘菜单模式门控（2026-11-16 小M）
 *
 * 需求：
 *  ① 非宠物模式（edge/hidden）下托盘不应有桌宠相关项（桌宠大小/形象/点击唤出/桌宠 DevTools）；
 *  ② 调试模式只能在 start:dev（NODE_ENV=development 且未打包）出现，npm start 不出现。
 *
 * 断言面（沿用 pin-top / pet-ctx-pullback 的「纯函数直测 + wiring 静态守卫」双口径）：
 *   1) 纯函数面：dist/main/pet-manager.js 导出 shouldShowPetTrayItems / isDebugMenuAllowed，
 *      覆盖 pet/edge/hidden、start/start:dev/打包版各组合；
 *   2) wiring 静态守卫：index.ts 托盘模板桌宠专属项挂 visible、调试项走 _debugAllowed()、
 *      F12 与 DevTools 自动打开同口径，杜绝残留旧 !app.isPackaged 判定。
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const pm = require(path.join(ROOT, 'dist', 'main', 'pet-manager.js'));

describe('shouldShowPetTrayItems 纯函数面（桌宠项仅 pet 模式可见）', () => {
  test('导出存在且为函数', () => {
    assert.strictEqual(typeof pm.shouldShowPetTrayItems, 'function');
  });

  test('pet 模式 → 展示桌宠项', () => {
    assert.strictEqual(pm.shouldShowPetTrayItems('pet'), true);
  });

  test('edge / hidden 模式 → 收敛桌宠项', () => {
    assert.strictEqual(pm.shouldShowPetTrayItems('edge'), false);
    assert.strictEqual(pm.shouldShowPetTrayItems('hidden'), false);
  });

  test('非法/缺省值 → 安全收敛（不展示）', () => {
    assert.strictEqual(pm.shouldShowPetTrayItems(undefined), false);
    assert.strictEqual(pm.shouldShowPetTrayItems(null), false);
    assert.strictEqual(pm.shouldShowPetTrayItems('PET'), false);
    assert.strictEqual(pm.shouldShowPetTrayItems(0), false);
  });
});

describe('isDebugMenuAllowed 纯函数面（调试入口仅 start:dev）', () => {
  test('导出存在且为函数', () => {
    assert.strictEqual(typeof pm.isDebugMenuAllowed, 'function');
  });

  test('start:dev：未打包 + NODE_ENV=development → 允许', () => {
    assert.strictEqual(pm.isDebugMenuAllowed(false, 'development'), true);
  });

  test('npm start：未打包但 NODE_ENV 未设/其它值 → 拒绝（本次核心修复）', () => {
    assert.strictEqual(pm.isDebugMenuAllowed(false, undefined), false);
    assert.strictEqual(pm.isDebugMenuAllowed(false, ''), false);
    assert.strictEqual(pm.isDebugMenuAllowed(false, 'production'), false);
  });

  test('打包版即便误带 development → 仍拒绝（双条件）', () => {
    assert.strictEqual(pm.isDebugMenuAllowed(true, 'development'), false);
    assert.strictEqual(pm.isDebugMenuAllowed(true, undefined), false);
  });
});

describe('wiring 静态守卫（index.ts 接线）', () => {
  const src = read('src/main/index.ts');

  test('require 解构引入两个新纯函数', () => {
    assert.match(src, /shouldShowPetTrayItems/);
    assert.match(src, /isDebugMenuAllowed/);
  });

  test('_debugAllowed / _petTrayItemsVisible 成员方法存在且走纯函数', () => {
    assert.match(src, /_debugAllowed\(\): boolean[\s\S]{0,120}isDebugMenuAllowed\(app\.isPackaged, process\.env\.NODE_ENV\)/);
    assert.match(src, /_petTrayItemsVisible\(\): boolean[\s\S]{0,120}shouldShowPetTrayItems\(this\._getHideMode\(\)\)/);
  });

  test('桌宠专属三项均挂 visible: _petTrayItemsVisible()', () => {
    // 点击桌宠时唤出面板 / 桌宠大小 / 桌宠形象 各带 visible 门控
    const hover = /label: '点击桌宠时唤出面板',\s*visible: this\._petTrayItemsVisible\(\)/;
    const size = /label: '桌宠大小',\s*visible: this\._petTrayItemsVisible\(\)/;
    const model = /label: '桌宠形象',\s*visible: this\._petTrayItemsVisible\(\)/;
    assert.match(src, hover, '点击桌宠时唤出面板须按模式门控');
    assert.match(src, size, '桌宠大小须按模式门控');
    assert.match(src, model, '桌宠形象须按模式门控');
  });

  test('模式切换入口「桌宠（实验）」保留（切入宠物的唯一托盘入口）', () => {
    assert.match(src, /label: '桌宠（实验）', type: 'radio', checked: this\._getHideMode\(\) === 'pet'/);
  });

  test('两项调试 visible 走 _debugAllowed()，桌宠调试额外要求 pet 模式', () => {
    assert.match(src, /label: '调试模式（主面板 DevTools）',\s*visible: this\._debugAllowed\(\)/);
    assert.match(src, /label: '调试模式（桌宠 DevTools）',\s*visible: this\._debugAllowed\(\) && this\._petTrayItemsVisible\(\)/);
  });

  test('F12 快捷键守卫改为 _debugAllowed()（不再用 app.isPackaged 裸判）', () => {
    assert.match(src, /if \(!this\._debugAllowed\(\)\) return;[\s\S]{0,120}const mw = this\.mainWindow/);
  });

  test('DevTools 自动打开叠加 _debugAllowed() 双门槛', () => {
    assert.match(src, /const dbg = this\._debugAllowed\(\) && this\._petDebugMode;/);
  });

  test('托盘模板内不再残留裸 !app.isPackaged 调试判定', () => {
    // initTray 区段（565~760 行）不应再有 visible: !app.isPackaged
    const trayBody = src.slice(src.indexOf('initTray() {'), src.indexOf('_debugAllowed(): boolean'));
    assert.doesNotMatch(trayBody, /visible:\s*!app\.isPackaged/);
  });
});
