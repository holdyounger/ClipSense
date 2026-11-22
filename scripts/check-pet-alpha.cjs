// Real Electron smoke: decode the actual stage, then inspect its composited alpha.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const output = path.join(root, 'out', 'pet-alpha');
app.commandLine.appendSwitch('disable-accelerated-video-decode');
ipcMain.handle('pet:get-config', () => ({ petLive2dModel: '__alpha_smoke_missing__' }));
const timeout = setTimeout(() => { console.error('stage timeout'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(output, { recursive: true });
    const win = new BrowserWindow({
      width: 220, height: 220, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, roundedCorners: false,
      focusable: process.platform === 'darwin',
      show: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false,
        sandbox: false, webSecurity: false, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_event, _level, message) => console.log('[stage]', message));
    await win.loadFile(path.join(root, 'dist/renderer/pet-stage.html'));
    await new Promise(resolve => setTimeout(resolve, 8500));
    const decoded = await win.webContents.executeJavaScript(`(() => {
      const v = [...document.querySelectorAll('video')].find(v => v.readyState >= 2 && !v.paused);
      if (!v) throw new Error('no playing video');
      const c = document.createElement('canvas'); c.width = c.height = 110;
      const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 110, 110);
      const pixels = ctx.getImageData(0, 0, 110, 110).data;
      let transparent = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 16) transparent++;
      return { mode: window.__petMode, transparent: transparent / (110 * 110) };
    })()`);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output, 'stage.png'), image.toPNG());
    const bitmap = image.toBitmap();
    let transparent = 0, opaque = 0;
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] < 16) transparent++;
      if (bitmap[i] > 240) opaque++;
    }
    const result = { decoded, composited: { transparent: transparent / (bitmap.length / 4),
      opaque: opaque / (bitmap.length / 4) }, platform: process.platform,
      electron: process.versions.electron };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    assert.equal(decoded.mode, 'webm');
    assert.ok(decoded.transparent > 0.5, 'asset must contain a transparent background');
    assert.ok(result.composited.transparent > 0.5, 'composited stage must retain transparency');
    assert.ok(result.composited.opaque > 0.05, 'pet must remain visible');
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
