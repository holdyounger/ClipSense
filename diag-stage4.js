const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 220, height: 220, x: 620, y: 500,
    frame: false, transparent: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'dist', 'renderer', 'preload.js'),
      nodeIntegration: true, contextIsolation: false, sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, _l, msg) => { if (/leaf|ERR|Spike/i.test(msg)) console.log('[RENDER]', msg.slice(0, 160)); });
  await win.loadFile(path.join(__dirname, 'dist', 'renderer', 'pet-stage.html'));
  await new Promise(r => setTimeout(r, 1500));
  win.webContents.send('pet:ctx-show', { mode: 'pet', scale: 1, dirH: 'l', dirV: 'u' });
  await new Promise(r => setTimeout(r, 600));
  const clickRes = await win.webContents.executeJavaScript(`
    (function () {
      const react = document.querySelector('.leaf[data-leaf="react"]');
      if (!react) return 'no-react-leaf:' + document.querySelectorAll('.leaf').length;
      react.click();
      return 'clicked';
    })()
  `).catch(e => 'EVAL-ERR ' + e.message);
  console.log('CLICK:', clickRes);
  await new Promise(r => setTimeout(r, 1000));
  const leaves = await win.webContents.executeJavaScript(
    'JSON.stringify([...document.querySelectorAll(".leaf")].map(l => ({k:(l.dataset.leaf||l.dataset.opt), left:l.style.left, top:l.style.top, w:l.style.width})))'
  ).catch(e => 'EVAL-ERR ' + e.message);
  console.log('LEAVES:', leaves);
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync('C:\\Users\\Public\\pet-menu-diag4.png', img.toPNG());
  console.log('DIAG4-SAVED', JSON.stringify(img.getSize()));
  app.quit();
});
