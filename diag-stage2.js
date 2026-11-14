const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 220, height: 220, x: 620, y: 500,
    frame: false, transparent: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, 'dist', 'renderer', 'pet-stage.html'));
  await new Promise(r => setTimeout(r, 1200));
  // 主进程下发 ctx-show（渲染层监听 → openCtx → 主扇）
  win.webContents.send('pet:ctx-show', { mode: 'pet', scale: 1, dirH: 'l', dirV: 'u' });
  await new Promise(r => setTimeout(r, 500));
  // 模拟点击 react 叶（DOM click → renderInteractSub）
  await win.webContents.executeJavaScript(`
    (function () {
      const react = document.querySelector('.leaf[data-leaf="react"]');
      if (!react) return 'no-react-leaf';
      react.click();
      return 'clicked';
    })()
  `).then(v => console.log('CLICK:', v)).catch(e => console.log('EVAL-ERR', e.message));
  await new Promise(r => setTimeout(r, 1200));
  // 导出叶坐标 + 截屏
  const leaves = await win.webContents.executeJavaScript(
    'JSON.stringify([...document.querySelectorAll(".leaf")].map(l => ({k: (l.dataset.leaf||l.dataset.opt), left: l.style.left, top: l.style.top, w: l.style.width})))'
  ).catch(e => 'EVAL-ERR ' + e.message);
  console.log('LEAVES:', leaves);
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync('C:\\Users\\Public\\pet-menu-diag2.png', img.toPNG());
  console.log('DIAG2-SAVED', JSON.stringify(img.getSize()));
  app.quit();
});
