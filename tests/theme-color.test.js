/**
 * theme-color.test.js - 托盘菜单用户自定义主题色（2026-11-19）
 *
 * 覆盖三层：
 *   ① 主进程纯函数（dist/main/theme.js）：色号规范化防呆、派生色、注入脚本、预定义色板；
 *   ② 托盘选择器真实执行：把 tray-menu.html 内联脚本喂给 DOM/electron 桩，
 *      断言色板点击 / RGB 输入 / 恢复默认都正确回传 theme:set，且派生口径与主进程一致；
 *   ③ wiring 静态守卫：index.ts 的持久化 + IPC + 全窗口注入钩子 + 托盘入口序列化。
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const theme = require(path.join(ROOT, 'dist', 'main', 'theme.js'));

// ---------------- ① 纯函数 ----------------

describe('主题色纯函数（main/theme.ts）', () => {
  test('normalizeHex 接受 #RRGGBB / RRGGBB / #RGB / rgb()', () => {
    assert.strictEqual(theme.normalizeHex('#6C5CE7'), '#6c5ce7');
    assert.strictEqual(theme.normalizeHex('6c5ce7'), '#6c5ce7');
    assert.strictEqual(theme.normalizeHex('#abc'), '#aabbcc');
    assert.strictEqual(theme.normalizeHex('rgb(255, 0, 128)'), '#ff0080');
    assert.strictEqual(theme.normalizeHex(' #123456 '), '#123456');
  });

  test('normalizeHex 防呆：命名色 / rgba / 越界 / 注入串一律 null', () => {
    for (const bad of ['red', 'rgba(1,2,3,.5)', 'rgb(256,0,0)', 'rgb(-1,0,0)',
      '#12', '#gggggg', 'javascript:alert(1)', '', null, 123, {}]) {
      assert.strictEqual(theme.normalizeHex(bad), null, '应拒绝 ' + String(bad));
    }
  });

  test('deriveTheme 默认色 = 现有紫色令牌，不传/非法都回落', () => {
    for (const input of [null, 'not-a-color', undefined, '#zzzzzz']) {
      const d = theme.deriveTheme(input);
      assert.strictEqual(d.accent, '#6c5ce7');
      assert.strictEqual(d.brand, '#6c5ce7');
      assert.strictEqual(d.accentHover, '#a29bfe'); // 与 main.css 现值一致
      assert.strictEqual(d.accentSoft, 'rgba(108, 92, 231, 0.2)');
    }
  });

  test('deriveTheme 自定义色：主色/提亮/透明填充口径正确', () => {
    const d = theme.deriveTheme('#ff0000');
    assert.strictEqual(d.accent, '#ff0000');
    assert.strictEqual(d.accentHover, '#ff4040'); // 255→255, 0→64
    assert.strictEqual(d.brandSoft, '#ff5959');
    assert.strictEqual(d.hover, 'rgba(255, 0, 0, 0.09)');
  });

  test('rgbOf 解通道正确', () => {
    assert.deepStrictEqual(theme.rgbOf('#0ea5a5'), [14, 165, 165]);
    assert.deepStrictEqual(theme.rgbOf('not-a-color'), [108, 92, 231]); // 非法回落默认
  });

  test('themeInjectScript 覆盖两套变量前缀，且值不含注入面', () => {
    const script = theme.themeInjectScript(theme.deriveTheme('#3b82f6'));
    for (const v of ['--accent', '--accent-hover', '--accent-soft', '--brand', '--brand-soft', '--hover']) {
      assert.ok(script.includes(v), '应注入 ' + v);
    }
    assert.ok(script.includes('#3b82f6'));
    assert.doesNotMatch(script, /</, '不得产生 HTML/脚本注入片段');
    assert.doesNotMatch(script, /javascript:/);
  });

  test('预定义色板齐全且全部合法（无脏色号）', () => {
    assert.strictEqual(theme.THEME_PRESETS.length, 8);
    for (const p of theme.THEME_PRESETS) {
      assert.ok(p.name && p.hex, '色板项需有 name/hex');
      assert.strictEqual(theme.normalizeHex(p.hex), p.hex.toLowerCase());
    }
  });
});

// ---------------- ② 托盘选择器真实执行 ----------------

function mkEl(tag) {
  const listeners = {};
  const children = [];
  const queried = {};
  let html = '';
  const el = {
    tagName: tag || 'div',
    dataset: {},
    title: '',
    value: '',
    min: '',
    max: '',
    textContent: '',
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      getPropertyValue(k) { return this._props[k] || ''; },
      background: '',
    },
    classList: {
      _set: new Set(),
      toggle(c, force) { force ? this._set.add(c) : this._set.delete(c); },
      add(c) { this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    set innerHTML(v) { html = v; },
    get innerHTML() { return html; },
    children,
    appendChild(c) { children.push(c); return c; },
    querySelector(sel) {
      if (!queried[sel]) queried[sel] = mkEl('div');
      return queried[sel];
    },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatch(t, evt) {
      for (const fn of (listeners[t] || [])) fn(evt || { stopPropagation() {} });
    },
    _children: children,
    _listeners: listeners,
  };
  return el;
}

/** 把 tray-menu.html 的内联脚本真实跑起来，暴露主题相关函数与 IPC 桩 */
function loadTrayScript() {
  const script = read('dist/renderer/tray-menu.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  const sent = [];
  const rootEl = mkEl('html');
  const doc = {
    documentElement: rootEl,
    getElementById: () => mkEl('div'),
    createElement: (tag) => mkEl(tag),
    addEventListener() {},
    querySelector: () => null,
  };
  const fakeRequire = (n) => n === 'electron'
    ? { ipcRenderer: { on() {}, send(ch, data) { sent.push([ch, data]); }, invoke: () => Promise.resolve(null) } }
    : require(n);
  // 用函数参数注入 require/document：闭包长期持有，不依赖调用时的 global 状态
  const api = new Function('require', 'document',
    script + ';return {makeThemePicker, themeVars, normalizeHex, applyThemeVars, compose, GROUPS};'
  )(fakeRequire, doc);
  return { api, sent, rootEl };
}

describe('托盘主题色选择器（tray-menu.html 真实执行）', () => {
  test('内联脚本语法正确且能创建选择器', () => {
    const { api } = loadTrayScript();
    assert.strictEqual(typeof api.makeThemePicker, 'function');
    const picker = api.makeThemePicker();
    assert.strictEqual(picker.tagName, 'div');
    assert.ok(picker.innerHTML.includes('theme-swatch'), '应有当前色预览');
    assert.ok(picker.innerHTML.includes('type="color"'), '应有原生取色器');
    assert.ok(picker.innerHTML.includes('type="number"'), '应有 RGB 数字输入');
    assert.ok(picker.innerHTML.includes('恢复默认紫色'));
  });

  test('渲染层派生口径与主进程一致（防两边规则漂移）', () => {
    const { api } = loadTrayScript();
    for (const hex of ['#ff0000', '#3b82f6', '#0ea5a5', '#6c5ce7']) {
      const ui = api.themeVars(hex);
      const main = theme.deriveTheme(hex);
      for (const k of Object.keys(main)) {
        assert.strictEqual(ui['--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())], main[k], hex + ' ' + k);
      }
    }
  });

  test('预定义色板色块：8 个，点击即回传 theme:set', () => {
    const { api, sent } = loadTrayScript();
    const picker = api.makeThemePicker();
    const swatches = picker.querySelector('.theme-swatches').children;
    assert.strictEqual(swatches.length, 8);
    swatches[2].dispatch('click'); // 青碧 #0ea5a5
    const call = sent.find((c) => c[0] === 'theme:set');
    assert.ok(call, '应发送 theme:set');
    assert.deepStrictEqual(call[1], { color: '#0ea5a5' });
  });

  test('RGB 输入：应用按钮提交规范色号，越界通道钳制到 0..255', () => {
    const { api, sent } = loadTrayScript();
    const picker = api.makeThemePicker();
    picker.querySelector('.rgb-r').value = '255';
    picker.querySelector('.rgb-g').value = '999'; // 越界 → 255
    picker.querySelector('.rgb-b').value = '-5';  // 越界 → 0
    picker.querySelector('.rgb-apply').dispatch('click');
    const call = sent.find((c) => c[0] === 'theme:set');
    assert.deepStrictEqual(call[1], { color: '#ffff00' });
  });

  test('恢复默认：回传 color=null', () => {
    const { api, sent } = loadTrayScript();
    const picker = api.makeThemePicker();
    picker.querySelector('.theme-reset').dispatch('click');
    const call = sent.find((c) => c[0] === 'theme:set');
    assert.deepStrictEqual(call[1], { color: null });
  });

  test('主题色入口归入「窗口与界面」组，不被当成普通 action 项丢弃', () => {
    const { api } = loadTrayScript();
    const out = api.compose([
      { label: '显示/隐藏' }, { label: '主题色…', type: 'theme' }, { label: '退出' },
    ]);
    const win = out.find((n) => n.type === 'group' && n.key === 'window');
    assert.ok(win, '应有窗口与界面分组');
    assert.strictEqual(win.children[0].label, '主题色…');
  });
});

// ---------------- ③ wiring 静态守卫 ----------------

describe('wiring 静态守卫', () => {
  test('index.ts：色号持久化 + theme:get/theme:set IPC + 全窗口注入', () => {
    const src = read('src/main/index.ts');
    assert.match(src, /_getThemeColor\(\): string \| null/);
    assert.match(src, /_writeConfig\(\{ themeColor: hex \}\)/);
    assert.match(src, /ipcMain\.handle\('theme:get'/);
    assert.match(src, /ipcMain\.on\('theme:set'/);
    assert.match(src, /this\._setThemeColor\(/);
    assert.match(src, /app\.on\('browser-window-created'/);
    assert.match(src, /_hookThemeInjection\(win\)/);
    assert.match(src, /_applyThemeToWindows\(\)/);
    assert.match(src, /w\.webContents\.send\('theme:changed', hex\)/);
  });

  test('index.ts：托盘模板入口 + 序列化为 theme 节点 + init 下发色号与色板', () => {
    const src = read('src/main/index.ts');
    assert.match(src, /label: '主题色…'/);
    assert.match(src, /it\.label === '主题色…'/);
    assert.match(src, /type: 'theme', label: it\.label/);
    assert.match(src, /themeColor: this\._getThemeColor\(\)/);
    assert.match(src, /themePresets: THEME_PRESETS/);
  });

  test('tray-menu.html：主题节点渲染 + 色板/RGB/取色器 + 广播同步', () => {
    const html = read('src/renderer/tray-menu.html');
    assert.match(html, /node\.type === 'theme'/);
    assert.match(html, /makeThemePicker\(\)/);
    assert.match(html, /ipcRenderer\.on\('theme:changed'/);
    assert.match(html, /ipcRenderer\.send\('theme:set'/);
    assert.match(html, /class="theme-swatches"/);
    assert.match(html, /type="color" class="theme-native"/);
    assert.match(html, /type="number" class="rgb-r"/);
    assert.match(html, /applyThemeVars\(themeColor\)/);
  });

  test('main.css：注入目标变量存在（--accent 系为默认令牌）', () => {
    const css = read('src/renderer/main.css');
    assert.match(css, /--accent:\s*#6c5ce7/);
    assert.match(css, /--accent-hover:\s*#a29bfe/);
    assert.match(css, /--accent-soft:\s*rgba\(108, 92, 231, 0\.2\)/);
  });
});
