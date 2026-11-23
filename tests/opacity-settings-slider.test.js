/**
 * opacity-settings-slider.test.js - 统一托盘菜单浮窗 + 内嵌透明度滑块（2026-11-16 小M）
 *
 * 形态演进：原生托盘菜单（不支持滑块）→ 独立滑块弹窗 → 托盘锚定浮层 → 最终
 * 「整份托盘菜单 HTML 浮窗化」：托盘右键弹 tray-menu.html（沿用圆角阴影弹窗观感），
 * 整份菜单项 + 两条透明度滑块（可拖/点位可点）都在同一个浮窗里，视觉统一。
 *
 * 覆盖四处：
 *  ① computeOpacity 自定义 pinnedOpacity（固定档 60% 硬编码 → 可配置）；
 *  ② 纯函数防呆（非法 pinnedOpacity 回落默认，与 passthroughOpacity 同口径）；
 *  ③ 浮窗渲染层 tray-menu.html：菜单树渲染 + 两条内嵌 range 滑块 + 点位 + 即时写回；
 *  ④ wiring 静态守卫：菜单模板序列化 + action 分发 + 浮窗形态与定位 + opacity IPC +
 *     配置持久化 + 桌宠形象回退「比熊（内置）」不为空 + 原生菜单已弃用。
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const { computeOpacity, OPACITY_PINNED } = require(
  path.join(ROOT, 'dist', 'main', 'window-opacity.js')
);

describe('computeOpacity 自定义固定档（pinnedOpacity）', () => {
  test('固定态默认仍为 60%（既有契约不破）', () => {
    assert.strictEqual(computeOpacity({ pinned: true }), OPACITY_PINNED);
    assert.strictEqual(computeOpacity({ pinned: true }), 0.6);
  });

  test('固定态自定义值覆盖默认', () => {
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 0.35 }), 0.35);
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 0.9 }), 0.9);
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 1 }), 1);
  });

  test('非法 pinnedOpacity 防呆回落默认', () => {
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 0 }), 0.6);
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: -0.5 }), 0.6);
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 1.5 }), 0.6);
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: NaN }), 0.6);
  });

  test('非固定态 pinnedOpacity 不生效', () => {
    assert.strictEqual(computeOpacity({ pinned: false, pinnedOpacity: 0.3 }), 1);
  });

  test('固定 + 穿透同时激活：自定义固定档仍与穿透取小值', () => {
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 0.35, passthroughActive: true, passthroughOpacity: 0.5 }), 0.35);
    assert.strictEqual(computeOpacity({ pinned: true, pinnedOpacity: 0.8, passthroughActive: true, passthroughOpacity: 0.5 }), 0.5);
  });
});

describe('统一托盘菜单浮窗渲染层（tray-menu.html）', () => {
  const html = read('dist/renderer/tray-menu.html');

  test('产物存在 + 圆角阴影卡片 + 透明底 + 滚动', () => {
    assert.match(html, /background: transparent/, '窗体透明底');
    assert.match(html, /\.card, \.subpanel\s*\{[^}]*border-radius/, '卡片圆角');
    assert.match(html, /box-shadow:/, '卡片阴影');
    assert.match(html, /overflow-y:\s*auto/, '菜单项多时内部滚动');
  });

  test('渲染菜单树：普通/radio/checkbox/子菜单/分隔线', () => {
    assert.match(html, /node\.type === 'separator'/);
    assert.match(html, /node\.type === 'checkbox'/);
    assert.match(html, /node\.type === 'radio'/);
    assert.match(html, /node\.hasSubmenu/, '子菜单展开');
    assert.match(html, /node\.action/);
  });

  test('勾选/单选控件化 + checked 回传（修复开关不生效）', () => {
    assert.match(html, /\.item \.mark\.checkbox, \.item \.mark\.radio/, '方框/圆框控件样式');
    assert.match(html, /function syncMark\(mark, node\)/, '标记外观统一同步函数');
    assert.match(html, /mark\.className = 'mark checkbox' \+ \(node\.checked \? ' on' : ''\)/, 'checkbox 选中态类');
    assert.match(html, /checkedArg = !node\.checked/, 'checkbox 点击取反');
    assert.match(html, /checkedArg = true;[\s\S]{0,60}node\.checked = true/, 'radio 点击选中');
    assert.match(html, /sib\._menuNode\.type === 'radio'/, '同组 radio 互斥');
    assert.match(html, /ipcRenderer\.send\('tray-menu:action', node\.action, checkedArg\)/,
      '新 checked 随 action 回传主进程');
    assert.match(html, /row\._menuNode = node/, '节点回挂供互斥定位');
  });

  test('两条内嵌透明度滑块（range + 固定点位 + 拖动）', () => {
    assert.match(html, /node\.type === 'slider'/, '滑块作为菜单节点内嵌');
    assert.match(html, /const STOPS = \[[^\]]{10,}\]/, '固定点位多档');
    assert.match(html, /input type=\\?"range\\?"/, 'range 滑块');
    assert.match(html, /input\.addEventListener\('input'/);
    assert.match(html, /b\.addEventListener\('click'/, '点位可点');
  });

  test('滑块即时写回 + 默认值 null 回落语义', () => {
    assert.match(html, /ipcRenderer\.send\('opacity:set'/);
    assert.match(html, /DEFAULT = \{ pinned: 60, passthrough: 50 \}/);
    assert.match(html, /\? null : pctToValue/, '默认档写 null');
  });

  test('菜单动作回传 + Esc 关闭 + 接收 init 模型', () => {
    assert.match(html, /ipcRenderer\.send\('tray-menu:action'/);
    assert.match(html, /ipcRenderer\.send\('tray-menu:close'/);
    assert.match(html, /ipcRenderer\.on\('tray-menu:init'/);
    assert.match(html, /e\.key === 'Escape'/);
  });

  test('聚合编排：扁平项编排成常驻项 + 4 个分组（一页显示）', () => {
    assert.match(html, /function compose\(items\)/, '存在编排函数');
    assert.match(html, /const TOP_LABELS = \['显示\/隐藏', '固定窗口'\]/, '高频项常驻顶层');
    assert.match(html, /const TAIL_LABELS = \['退出'\]/, '退出置底');
    assert.match(html, /key: 'opacity', label: '透明度'/, '透明度分组');
    assert.match(html, /key: 'window', label: '窗口与界面'/);
    assert.match(html, /key: 'pet', label: '桌宠'/);
    assert.match(html, /key: 'system', label: '系统与调试'/);
    assert.match(html, /if \(!placed\) rest\.push\(n\)/, '未识别项兜底不丢');
    assert.match(html, /n\.type === 'separator'\) return/, '原分隔线由分组边界取代');
  });

  test('侧飞展开：分组头点开右侧子面板，主列表不内嵌撑高', () => {
    assert.match(html, /function renderGroup\(node\)/, '分组渲染函数');
    assert.match(html, /node\.type === 'group'\) return renderGroup\(node\)/, 'group 节点走分组渲染');
    assert.match(html, /class="card" id="card"/, '主列表容器');
    assert.match(html, /class="subpanel" id="subpanel" hidden/, '侧飞子面板默认隐藏');
    assert.match(html, /panelStack = \[\{ label: node\.label, children: node\.children/, '点分组压入面板栈');
    assert.match(html, /function renderPanel\(\)/, '子面板渲染函数');
    assert.doesNotMatch(html, /kids\.style\.display = node\.open/, '不再内嵌下展撑高主列表');
    assert.match(html, /active-group/, '当前分组高亮');
  });

  test('侧飞下钻与返回：hasSubmenu 压栈、back 弹栈、Esc 逐层收起', () => {
    assert.match(html, /panelStack\.push\(\{ label: node\.label, children: node\.children/, '子菜单下钻');
    assert.match(html, /panelStack\.pop\(\)/, '返回弹栈');
    assert.match(html, /back-text|\\u2039 返回/, '返回按钮');
    assert.match(html, /if \(panelStack\.length\) \{ panelStack\.pop\(\); renderPanel\(\); measure\(\); \}/, 'Esc 先收起子面板');
  });

  test('内容尺寸实测回传：贴合内容 + 消除底部空白', () => {
    assert.match(html, /function measure\(\)/, '测量函数');
    assert.match(html, /document\.body\.scrollWidth/, '实测宽');
    assert.match(html, /document\.body\.scrollHeight/, '实测高');
    assert.match(html, /ipcRenderer\.send\('tray-menu:resize'/, '回传主进程收缩窗口');
    assert.match(html, /requestAnimationFrame/, '布局后测量');
  });

  test('二级菜单左展：主列表右缘贴托盘不位移（row-reverse + 左向箭头）', () => {
    assert.match(html, /display:\s*inline-flex;\s*flex-direction:\s*row-reverse/,
      'flex 主轴反转：subpanel 视觉在左、card 在右，窗口右缘锚定使 card 坐标恒定');
    assert.match(html, /<div class="card" id="card"><\/div>\s*<div class="subpanel" id="subpanel"/,
      'DOM 顺序仍是 card→subpanel，靠 row-reverse 反转视觉（右缘 = card 右缘不漂移）');
    assert.match(html, /caret\.textContent = '\\u25C4'/,
      '分组头与子菜单项展开箭头朝左，与向左弹出的二级面板方向一致');
    assert.doesNotMatch(html, /caret\.textContent = '\\u25B6'/,
      '不得残留朝右箭头（与左展方向矛盾）');
  });

  test('透明度两条滑块合并进同一分组（regex 匹配两入口 label）', () => {
    assert.match(html, /\/透明度…\$\/\.test\(l\)/, '透明度分组按 label 正则归并两入口');
    assert.match(html, /makeSlider\(node\.kind/, '分组子项仍走滑块渲染');
  });
});

describe('wiring 静态守卫（index.ts）', () => {
  const src = read('src/main/index.ts');

  test('托盘右键弹统一浮窗（原生 setContextMenu 已弃用）', () => {
    assert.match(src, /this\.tray!\.on\('right-click', \(\) => this\._showTrayMenu\(\)\)/);
    assert.doesNotMatch(src, /this\.tray!\.setContextMenu\(Menu\.buildFromTemplate/);
    assert.match(src, /_showTrayMenu\(\): void/);
  });

  test('菜单模板抽成数据方法（原 click 业务逻辑保留）', () => {
    assert.match(src, /_trayTemplate\(\): any\[\] \{/);
    assert.match(src, /label: '显示\/隐藏', click: \(\) => this\.toggleWindow\(\)/);
    assert.match(src, /label: '退出', click: \(\) => app\.exit\(0\)/);
  });

  test('序列化 + action 分发（click 跨 IPC 零重写）', () => {
    assert.match(src, /_serializeTrayTemplate\(\): Record<string, unknown>\[\]/);
    assert.match(src, /this\._trayActions\[id\] = it\.click/, 'click 存入 action 表');
    assert.match(src, /node\.action = id/);
    assert.match(src, /_dispatchTrayAction\(id: unknown, checked\?: unknown\)/);
    assert.match(src, /this\._trayActions\[id\]/);
    assert.match(src, /if \(typeof checked === 'boolean'\) fn\(\{ checked: checked \}\)/,
      'checkbox/radio 的 checked 合成 menuItem 传入 click 回调');
    assert.match(src, /_trayActions: Record<string, \(menuItem\?: \{ checked: boolean \}\) => void>/,
      'action 表签名允许 menuItem 参数');
  });

  test('透明度入口序列化为 slider 节点（内嵌）', () => {
    assert.match(src, /\/透明度…\$\/\.test\(it\.label\)/);
    assert.match(src, /type: 'slider', kind:/);
    assert.match(src, /label: '固定透明度…'/);
    assert.match(src, /label: '穿透透明度…'/);
  });

  test('浮窗形态：无边框/透明/不入任务栏/延迟显示 + 加载 tray-menu.html', () => {
    assert.match(src, /loadFile\(path\.join\(__dirname, '\.\.\/renderer\/tray-menu\.html'\)\)/);
    assert.match(src, /frame: false/);
    assert.match(src, /transparent: true/);
    assert.match(src, /skipTaskbar: true/);
    assert.match(src, /show: false/);
  });

  test('浮窗定位：托盘图标锚点 + 右缘对齐 + 越屏 clamp', () => {
    assert.match(src, /_positionTrayPopup\(win\)/, '显示前调用定位');
    assert.match(src, /this\.tray.*getBounds\(\)/, '以托盘矩形为锚点');
    assert.match(src, /ar = tb\.x \+ tb\.width/, '记录托盘右缘');
    assert.match(src, /let x = ar \? ar - w : ax - w \/ 2/, '菜单右缘对齐图标右缘，避免居中左偏');
    assert.match(src, /let y = ay - h - GAP/, '底边贴图标上方');
    assert.match(src, /getDisplayMatching\(anchor\)/, '取所在显示器工作区');
    assert.match(src, /Math\.max\(wa\.x, Math\.min\(x, wa\.x \+ wa\.width - w\)\)/, '水平越屏收拢');
  });

  test('尺寸自适应：渲染回传实测尺寸，贴合内容收缩窗口', () => {
    assert.match(src, /ipcMain\.on\('tray-menu:resize'/, '注册尺寸回传 IPC');
    assert.match(src, /_resizeTrayPopup\(size\.width, size\.height\)/, '接线到处理方法');
    assert.match(src, /_resizeTrayPopup\(w: unknown, h: unknown\): void/, '处理方法存在');
    assert.match(src, /Math\.max\(240, Math\.min\(560, Math\.round\(w\)\)\)/, '宽度上限保护');
    assert.match(src, /_computeTrayPopupRect\(w: number, h: number\)/, '定位计算抽成纯函数供 resize 复用');
    assert.match(src, /const \{ x, y \} = this\._computeTrayPopupRect\(width, height\)/, '按新尺寸算目标坐标');
    assert.match(src, /win\.setBounds\(\{ x, y, width, height \}\)/, '单次 setBounds 落地尺寸+坐标（消除两跳抖动）');
    assert.doesNotMatch(src, /setBounds\(\{ x: b\.x, y: b\.y, width, height \}\);\s*\n\s*this\._positionTrayPopup/,
      'resize 路径不得再「旧坐标 setBounds → 另一次 setPosition」两次几何变更');
    assert.match(src, /height: 440/, '初始窗高按内容收缩，非固定 520');
  });

  test('浮窗关闭：失焦隐藏 + Esc/关闭 IPC', () => {
    assert.match(src, /win\.on\('blur', \(\) => \{[^}]*win\.hide\(\)/, '失焦即隐藏');
    assert.match(src, /ipcMain\.on\('tray-menu:close'/);
  });

  test('tray-menu:action / opacity:get / opacity:set IPC 接线', () => {
    assert.match(src, /ipcMain\.on\('tray-menu:action', \(_event: unknown, id: unknown, checked\?: unknown\)/,
      'IPC handler 接收渲染层回传的 checked');
    assert.match(src, /this\._dispatchTrayAction\(id, checked\)/);
    assert.match(src, /ipcMain\.handle\('opacity:get'/);
    assert.match(src, /ipcMain\.on\('opacity:set'/);
    assert.match(src, /this\._setPinnedOpacity\(value\)/);
    assert.match(src, /this\._setPassthroughOpacity\(value\)/);
  });

  test('固定档配置持久化 + 启动应用', () => {
    assert.match(src, /_getPinnedOpacity\(\): number \| null/);
    assert.match(src, /_writeConfig\(\{ pinnedOpacity: v \}\)/);
    assert.match(src, /this\.edgeDetector\.setPinnedOpacity\(this\._getPinnedOpacity\(\)\)/);
  });

  test('edge-detector 接 pinnedOpacity 透传给 computeOpacity', () => {
    const ed = read('src/main/edge-detector.ts');
    assert.match(ed, /_pinnedOpacity: number \| null = null/);
    assert.match(ed, /setPinnedOpacity\(v: number \| null\)/);
    assert.match(ed, /pinnedOpacity: this\._pinnedOpacity \?\? undefined/);
  });

  test('桌宠形象回退内置比熊（菜单不为空）', () => {
    assert.match(src, /const builtin = '比熊（内置）'/);
    assert.match(src, /return \[builtin, \.\.\.filtered\]/);
    assert.match(src, /name === '比熊（内置）' \? null : name/, '选中内置比熊清除 Live2D 覆盖');
  });
});
