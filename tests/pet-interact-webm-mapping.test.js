/**
 * pet-interact-webm-mapping.test.js - 互动二级菜单与 webm 素材内容对应（2026-11-15）
 *
 * 小M 反馈：二级菜单「挥手、点击等和 webm 的内容对应不上」。
 * 根因（两层）：
 *   ① 叶子是池语义（点击动作=随机 p1-p13、挥手动作=随机 z1-z3），而素材权威语义表
 *      （scripts/pet-generate/a01-actions.json）里根本没有「挥手」动作——标签与内容必然脱节；
 *   ② 2026-11-15 L3 独立菜单窗（menu-window.html）迁移后，pet-menu:action 回传在主进程
 *      无处理器——点叶子根本不会播放。
 *
 * 修复契约（独立菜单窗架构 + 一叶一动作）：
 *   1) menu-window.html 叶子 data-act=具体素材名、title=权威动作名（一叶一动作）；
 *   2) 主进程 pet-menu:action → 转发 petStage（pet:play-action）；pet-menu:close → 隐窗；
 *   3) pet-stage 收 pet:play-action 后 playAction(act)（playAction 支持直接素材名）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const menuHtml = read('src/renderer/menu-window.html');
const stageHtml = read('src/renderer/pet-stage.html');
const index = read('src/main/index.ts');

// a01-actions.json = 素材权威语义表（id -> 「组别：动作名」）
const spec = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'scripts', 'pet-generate', 'a01-actions.json'), 'utf-8'));
const LABELS = {};
for (const a of spec.actions) {
  const m = a.label.match(/^[^：]+：(.+)$/);
  LABELS[a.id] = m ? m[1] : a.label;
}
// 派生素材不在 a01 语义表中（pet-stage.html 头注释：由 a01 语义零积分派生），显式命名
const DERIVED = { light0song: '唱歌' };

// 互动菜单窗点播的素材与其真实动作名
const EXPECTED_LEAVES = [
  { act: 'p1', hint: LABELS.p1 },
  { act: 'p2', hint: LABELS.p2 },
  { act: 'p3', hint: LABELS.p3 },
  { act: 'p4', hint: LABELS.p4 },
  { act: 'p5', hint: LABELS.p5 },
  { act: 'light0song', hint: DERIVED.light0song },
];

describe('互动菜单窗叶子 ↔ webm 素材对应（一叶一动作）', () => {
  test('MENUS.interact 每个动作叶 act 指向具体素材名，lb 为真实动作名（动态数组结构）', () => {
    // v13+ 菜单窗叶子改为 MENUS 常量数组动态构建（{act, ic, lb}）
    const menusBlock = menuHtml.match(/const MENUS = \{[\s\S]*?\n\};/);
    assert.ok(menusBlock, 'menu-window.html 须有 MENUS 菜单定义');
    const interactBlock = menusBlock[0].match(/interact:\s*\[[\s\S]*?\]/);
    assert.ok(interactBlock, 'MENUS 须含 interact 二级定义');
    for (const { act, hint } of EXPECTED_LEAVES) {
      assert.ok(hint, `素材 ${act} 须有权威动作名（a01-actions.json 或派生命名）`);
      const leafDef = interactBlock[0].match(new RegExp(`act:\\s*'${act}'[^}]*lb:\\s*'([^']+)'`));
      assert.ok(leafDef, `MENUS.interact 缺少素材叶 ${act}`);
      assert.ok(
        leafDef[1].includes(hint) || hint.includes(leafDef[1]),
        `叶子 ${act} 的 lb「${leafDef[1]}」须与真实动作名「${hint}」对应`,
      );
    }
  });

  test('泛化标签退役：不再出现与素材内容无关的「挥手动作」「点击动作」叶', () => {
    assert.ok(!menuHtml.includes("act: 'hover'"), '「挥手动作」叶须移除（素材库无挥手动作）');
    assert.ok(!menuHtml.includes("act: 'click'"), '「点击动作」叶须移除（池语义与内容不对应）');
    assert.ok(!menuHtml.includes('挥手动作'), '挥手动作字样须移除');
    assert.ok(!menuHtml.includes('点击动作'), '点击动作字样须移除');
  });

  test('菜单窗懒创建必须回填 this.menuWindow（v5.4 缺失实锤：永 null → 打开即抛错，菜单全不可见）', () => {
    const fn = index.match(/_ensureMenuWindow\(\): void \{[\s\S]*?\n  \}/);
    assert.ok(fn, '_ensureMenuWindow 方法须存在');
    assert.ok(/this\.menuWindow\s*=\s*mw/.test(fn[0]), '_ensureMenuWindow 须把新窗口赋给 this.menuWindow');
  });

  test('主进程接线：pet-menu:show → 拉回 + 打开菜单窗（react 叶点击通道）', () => {
    const handler = index.match(/ipcMain\.on\('pet-menu:show'[\s\S]*?\n    \}\);/);
    assert.ok(handler, '主进程须有 pet-menu:show 处理器（react 叶点击通道，此前无人监听=断链）');
    assert.ok(handler[0].includes('computeCtxPullBack'), '打开菜单窗前须纯移动拉回屏内（v5.3 语义）');
    assert.ok(handler[0].includes('_openMenuWindowAt'), '处理器须经 _openMenuWindowAt 打开菜单窗');
    const opener = index.match(/_openMenuWindowAt\([\s\S]*?\n  \}/);
    assert.ok(opener && opener[0].includes("send('pet-menu:show'"), '打开器须向菜单窗下发 show 载荷');
    assert.ok(opener && opener[0].includes('showInactive'), '菜单窗须 showInactive 显示（不夺焦）');
  });

  test('联合出界判定：迁主进程（真实光标直读），渲染层不保留失真轮询', () => {
    // 小M 实测「菜单全不可见」实机根因：渲染层轮询三处结构性缺陷——
    // ① cursorIn 视口 rect 与屏幕坐标错位；② lastCursor {-1,-1} 哨兵，打开瞬间未动
    // 鼠标即全 false；③ 光标离开本窗后 mousemove 不再到达，lastCursor 冻结。
    // → 300ms 误判出界，菜单窗闪现即灭（2026-11-16 终版：判定迁主进程）。
    const opener = index.match(/_openMenuWindowAt\([\s\S]*?\n  \}/);
    assert.ok(
      opener && opener[0].includes('getCursorScreenPoint'),
      '出界判定须用主进程 getCursorScreenPoint 直读真实光标（不依赖渲染层 mousemove）',
    );
    assert.ok(
      opener && opener[0].includes('getBounds') && opener[0].includes('_menuWinPollId'),
      '出界判定须以菜单窗/桌宠窗屏幕 bounds 联合比较（主进程轮询）',
    );
    assert.ok(
      !menuHtml.includes("reason: 'mouseleave'"),
      '渲染层不得再保留出界关闭轮询（mousemove 冻结导致判定失真）',
    );
  });

  test('主进程接线：pet-menu:action → 转发 petStage（pet:play-action）', () => {
    const handler = index.match(/ipcMain\.on\('pet-menu:action'[\s\S]*?\}\);/);
    assert.ok(handler, '主进程须有 pet-menu:action 处理器（L3 迁移遗留缺口）');
    assert.ok(handler[0].includes("pet:play-action"), '处理器须转发 pet:play-action 给 petStage');
    assert.ok(handler[0].includes('payload.act'), '处理器须读取叶子回传的 act');
  });

  test('主进程接线：pet-menu:close → 会话收尾（隐窗 + 桌宠侧菜单态）', () => {
    const handler = index.match(/ipcMain\.on\('pet-menu:close'[\s\S]*?\}\);/);
    assert.ok(handler, '主进程须有 pet-menu:close 处理器');
    assert.ok(handler[0].includes('_closeMenuSession'), '关闭须走会话收尾 _closeMenuSession');
  });

  test('菜单窗会话收尾必须销毁窗口，禁止 hide 复用（第二次展开点不动的根因）', () => {
    // 小M 实测：第一次菜单窗（新建）可点击；出界/动作关闭走 hide 复用后，
    // 第二次展开看得见但 Windows 透明窗鼠标命中区域失效（Electron 透明窗
    // hide→showInactive 循环已知问题）→ 点叶子无反应。
    // 收尾须 close() 销毁，第二次走已实测可点击的新建路径（loadFile 有四路 reveal 保险）。
    const fn = index.match(/_closeMenuSession\(\): void \{[\s\S]*?\n  \}/);
    assert.ok(fn, '_closeMenuSession 方法须存在');
    assert.ok(fn[0].includes('this.menuWindow.close()'), '菜单窗收尾须 close() 销毁（不得 hide 复用）');
    assert.ok(fn[0].includes('this.menuWindow = null'), '销毁后须清空 menuWindow 引用');
    assert.ok(!fn[0].includes('_hideMenuWindow'), '收尾不得走 _hideMenuWindow（hide 复用）');
  });

  test('pet-stage 接收 pet:play-action 并按素材名播放', () => {
    assert.ok(stageHtml.includes("'pet:play-action'"), 'pet-stage 须监听 pet:play-action');
    assert.ok(
      /POOLS\[poolName\]\s*\|\|\s*\[poolName\]/.test(stageHtml),
      'playAction 须支持直接素材名播放（POOLS[poolName] || [poolName]）',
    );
    const listener = stageHtml.match(/on\('pet:play-action'[\s\S]*?\}\);/);
    assert.ok(listener && listener[0].includes('playAction('), '监听器须经 playAction 播放');
  });
});
