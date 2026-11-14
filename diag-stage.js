// 诊断专用：启动桌宠窗口 → 自动打开互动菜单 → 3s 后截屏退出
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('user-data-dir', process.env.DIAG_USER_DATA || 'C:\\Users\\Public\\clipboardsense-diag');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 220, height: 220,
    x: 620, y: 500,   // 屏幕中下位置（模拟用户场景）
    frame: false, transparent: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, 'dist', 'renderer', 'pet-stage.html'));
  await new Promise(r => setTimeout(r, 1200));
  // 模拟 pet:ctx-show（打开菜单）+ 互动叶（webm 分支由渲染层内部状态机处理——直接发 ctx-show）
  win.webContents.send('pet:ctx-show', { mode: 'pet', scale: 1 });
  await new Promise(r => setTimeout(r, 600));
  // 触发互动叶（渲染层内部右键菜单打开主扇后需点 react——直接发 ctx-show 两次模拟二级？）
  // 直接执行渲染层函数：renderInteractSub
  await win.webContents.executeJavaScript('typeof renderInteractSub === "function" && renderInteractSub(); "ok"').catch(e => console.log('EVAL-ERR', e.message));
  await new Promise(r => setTimeout(r, 1500));
  // 截屏（capturePage）
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync('C:\\Users\\Public\\pet-menu-diag.png', img.toPNG());
  console.log('DIAG-SAVED', img.getSize());
  // 顺带导出叶坐标
  const leaves = await win.webContents.executeJavaScript(
    'JSON.stringify([...document.querySelectorAll(".leaf")].map(l => ({k: l.dataset.leaf || l.dataset.opt, x: l.style.left, y: l.style.top, s: l.style.width})))'
  ).catch(e => 'EVAL-ERR ' + e.message);
  console.log('LEAVES:', leaves);
  app.quit();
});
