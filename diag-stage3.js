const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 220, height: 220, x: 620, y: 500,
    frame: false, transparent: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, sandbox: false },
  });
  win.webContents.on('console-message', (_e, _l, msg) => { if (/Spike|Pet|leaf|ERR/i.test(msg)) console.log('[RENDER]', msg.slice(0, 140)); });
  await win.loadFile(path.join(__dirname, 'dist', 'renderer', 'pet-stage.html'));
  await new Promise(r => setTimeout(r, 1500));
  const probe = await win.webContents.executeJavaScript(`
    JSON.stringify({
      innerW: window.innerWidth, innerH: window.innerHeight,
      leafCount: document.querySelectorAll('.leaf').length,
      menuClass: document.getElementById('ctxMenu').className,
      videoN: document.querySelectorAll('video').length,
      errCapture: window.__lastErr || null,
    })
  `).catch(e => 'EVAL-ERR ' + e.message);
  console.log('PROBE:', probe);
  win.webContents.send('pet:ctx-show', { mode: 'pet', scale: 1, dirH: 'l', dirV: 'u' });
  await new Promise(r => setTimeout(r, 800));
  const probe2 = await win.webContents.executeJavaScript(`
    JSON.stringify({
      leafCount: document.querySelectorAll('.leaf').length,
      leafList: [...document.querySelectorAll('.leaf')].map(l => (l.dataset.leaf||l.dataset.opt)+'@'+l.style.left+','+l.style.top),
      menuClass: document.getElementById('ctxMenu').className,
    })
  `).catch(e => 'EVAL-ERR2 ' + e.message);
  console.log('PROBE2:', probe2);
  app.quit();
});
