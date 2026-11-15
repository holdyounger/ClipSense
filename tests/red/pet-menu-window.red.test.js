/**
 * pet-menu-window.red.test.js - 桌宠互动二级菜单独立窗口化 · 红灯测试（2026-11-15）
 *
 * L3 第 2 站红灯先行：当前代码未实现独立菜单窗 → 本文件 11 项断言全部失败（红灯 ✓）。
 * 实现后（T1 骨架 → T3 IPC → copy-assets）逐面转绿。
 *
 * 隔离纪律（铁律 2）：放 tests/red/ 子目录，全量门禁 glob（node --test tests/*.test.js）
 * 不递归子目录 → 不会被误扫；单独跑：node --test tests/red/
 *
 * 用例映射：Docs/测试用例-互动菜单独立窗口-2026-11-15.md（每条断言标注 WIN-* 编号）
 * 断言面 1 → WIN-02 / WIN-M2 / WIN-R1 / WIN-R2 / WIN-E2（menuWindow BrowserWindow 规格）
 * 断言面 2 → WIN-M1 / WIN-M5 / WIN-M8 / WIN-M9（三通道注册）
 * 断言面 3 → WIN-M1 / WIN-08（渲染层 pet-menu:show + menu-window.html 资产）
 * 断言面 4 → WIN-02（dist 产物 5 叶 DOM）
 *
 * 口径依据：
 * - 菜单窗规格 260×260：spec §4.1（固定 DIP 不随 scale）+ plan T1
 * - 窗口选项：plan T1 原文（transparent, frame:false, alwaysOnTop 'screen-saver',
 *   skipTaskbar, focusable:false, resizable:false, show:false）
 * - 三通道：plan T3（pet-menu:show/action/close）
 * - 5 叶：webm 互动叶 click/hover/song/light/heart（pet-stage.html L671-677 现值）
 * - 静态断言（源码/产物 grep），非运行时 e2e——真窗口径 e2e 属 P5 验证轮（WIN-R4 红线）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DIST_MAIN = path.join(ROOT, 'dist', 'main', 'index.js');
const SRC_STAGE = path.join(ROOT, 'src', 'renderer', 'pet-stage.html');
const SRC_MENU_ASSET = path.join(ROOT, 'src', 'renderer', 'menu-window.html');
const DIST_MENU_WIN = path.join(ROOT, 'dist', 'renderer', 'menu-window.html');

function readOrNull(p, label) {
  if (!fs.existsSync(p)) {
    assert.fail(`红灯[${label}] 文件不存在: ${path.relative(ROOT, p)}`);
  }
  return fs.readFileSync(p, 'utf8');
}

describe('断言面 1：menuWindow BrowserWindow 创建规格（260×260）', () => {
  const src = readOrNull(DIST_MAIN, '面1 dist/main/index.js');
  const m = src.match(/menuWindow\s*=\s*new\s+BrowserWindow\(/);

  test('WIN-M2/T1：dist/main/index.js 含 menuWindow = new BrowserWindow 创建', () => {
    assert.ok(m, '红灯[WIN-M2] dist/main/index.js 未找到 menuWindow = new BrowserWindow（独立菜单窗未创建）');
  });

  test('WIN-02/E2：菜单窗固定尺寸 260×260（DIP 恒定，不随档位缩放）', () => {
    assert.ok(m, '红灯[WIN-02] menuWindow 创建缺失，无法断言尺寸');
    const opts = src.slice(m.index, m.index + 1200);
    assert.match(opts, /width:\s*260/, '红灯[WIN-02] 菜单窗宽度须为 260');
    assert.match(opts, /height:\s*260/, '红灯[WIN-02] 菜单窗高度须为 260');
  });

  test('WIN-R2：透明无框 + screen-saver 置顶带（transparent + frame:false + alwaysOnTop）', () => {
    assert.ok(m, '红灯[WIN-R2] menuWindow 创建缺失，无法断言窗口选项');
    const opts = src.slice(m.index, m.index + 1200);
    assert.match(opts, /transparent:\s*true/, '红灯[WIN-R2] 菜单窗须 transparent:true（与 petStage 同配方）');
    assert.match(opts, /frame:\s*false/, '红灯[WIN-R2] 菜单窗须 frame:false');
    assert.ok(
      /['"]screen-saver['"]/.test(opts) || /setAlwaysOnTop\(\s*true\s*,\s*['"]screen-saver['"]/.test(src),
      '红灯[WIN-R2] 菜单窗须落在 screen-saver 置顶带（alwaysOnTop level）',
    );
  });

  test('WIN-R2/M4：不夺焦不进任务栏不 resize 不自显（skipTaskbar/focusable:false/resizable:false/show:false）', () => {
    assert.ok(m, '红灯[WIN-R2] menuWindow 创建缺失，无法断言焦点选项');
    const opts = src.slice(m.index, m.index + 1200);
    assert.match(opts, /skipTaskbar:\s*true/, '红灯[WIN-R2] 菜单窗须 skipTaskbar:true');
    assert.match(opts, /focusable:\s*false/, '红灯[WIN-R2] 菜单窗须 focusable:false（禁键盘焦点链，NOACTIVATE 正交维度）');
    assert.match(opts, /resizable:\s*false/, '红灯[WIN-R2] 菜单窗须 resizable:false（永不 resize——透明窗 resize 闪烁教训）');
    assert.match(opts, /show:\s*false/, '红灯[WIN-M4] 菜单窗须 show:false（池化 hide/show，按需 showInactive）');
  });
});

describe('断言面 2：IPC 三频道注册（pet-menu:show / action / close）', () => {
  const src = readOrNull(DIST_MAIN, '面2 dist/main/index.js');

  test('WIN-M1：主进程注册/消费 pet-menu:show（猫几何+档位 → 菜单窗定位）', () => {
    assert.ok(
      src.includes('pet-menu:show'),
      '红灯[WIN-M1] dist/main/index.js 未发现 pet-menu:show 通道（主进程中继缺失）',
    );
  });

  test('WIN-M5：主进程注册 pet-menu:action（叶点击回传 → 转发 petStage 播放）', () => {
    assert.ok(
      src.includes('pet-menu:action'),
      '红灯[WIN-M5] dist/main/index.js 未发现 pet-menu:action 通道（动作回传链路缺失）',
    );
  });

  test('WIN-M8：主进程注册/消费 pet-menu:close（关闭原因 + petStage 状态复位）', () => {
    assert.ok(
      src.includes('pet-menu:close'),
      '红灯[WIN-M8] dist/main/index.js 未发现 pet-menu:close 通道（关闭状态复位链路缺失）',
    );
  });
});

describe('断言面 3：渲染层接线（pet-stage 发 pet-menu:show 含猫几何 + menu-window.html 资产）', () => {
  test('WIN-M1：src/renderer/pet-stage.html 发 pet-menu:show 且载荷含猫几何标记', () => {
    const stage = readOrNull(SRC_STAGE, '面3 src/renderer/pet-stage.html');
    const idx = stage.indexOf('pet-menu:show');
    assert.ok(idx >= 0, '红灯[WIN-M1] pet-stage.html 未发送 pet-menu:show（仍停留旧 pet:open-ctx 单窗链路）');
    const vicinity = stage.slice(Math.max(0, idx - 200), idx + 600);
    assert.match(
      vicinity,
      /catX|catY|bodyRect|getBounds|anchor/i,
      '红灯[WIN-M1] pet-menu:show 载荷未含猫几何（catX/catY/bodyRect/anchor 任一标记）',
    );
  });

  test('WIN-08：src/renderer/menu-window.html 资产存在（copy-assets 源 → dist 产物前置）', () => {
    assert.ok(
      fs.existsSync(SRC_MENU_ASSET),
      '红灯[WIN-08] src/renderer/menu-window.html 不存在（copy-assets 无源可复制，dist 产物无从落地）',
    );
  });
});

describe('断言面 4：dist 产物 menu-window.html（copy-assets 同步 + 5 叶 DOM）', () => {
  test('WIN-02：dist/renderer/menu-window.html 存在', () => {
    assert.ok(
      fs.existsSync(DIST_MENU_WIN),
      '红灯[WIN-02] dist/renderer/menu-window.html 不存在（菜单窗加载目标缺失）',
    );
  });

  test('WIN-02：5 动作叶 DOM 完整（click/hover/song/light/heart）', () => {
    const html = readOrNull(DIST_MENU_WIN, '面4 dist/renderer/menu-window.html');
    const leaves = ['click', 'hover', 'song', 'light', 'heart'];
    for (const k of leaves) {
      const leafDef = new RegExp(
        `(key|value|data-leaf|data-opt|dataset\\.opt|dataset\\.leaf)['"]?\\s*[:=]\\s*['"]${k}['"]`,
      );
      assert.match(
        html,
        leafDef,
        `红灯[WIN-02] menu-window.html 缺互动叶「${k}」的 DOM/叶定义（5 叶须完整迁移）`,
      );
    }
  });
});
