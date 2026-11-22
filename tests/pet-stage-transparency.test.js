const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Evaluate the real constructor options without launching the clipboard service.
const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
const start = source.indexOf('const win = new BrowserWindow({', source.indexOf('/** 创建桌宠舞台'));
const end = source.indexOf('\n    this.petStage = win;', start);
const constructor = source.slice(start, end);
function options(platform) {
  let result;
  new Function('BrowserWindow', 'process', 'petHostSize', constructor)(function (value) { result = value; }, { platform }, platform === 'darwin' ? 360 : 220);
  return result;
}
test('macOS transparent pet stage uses a normal focusable window, not a non-focusable panel', () => {
  const value = options('darwin');
  assert.equal(value.transparent, true);
  assert.equal(value.backgroundColor, '#00000000');
  assert.equal(value.focusable, true);
  assert.equal(value.hasShadow, false);
  assert.equal(value.roundedCorners, false);
});
test('Windows pet stage retains non-activating transparent window behavior', () => {
  const value = options('win32');
  assert.equal(value.transparent, true);
  assert.equal(value.backgroundColor, '#00000000');
  assert.equal(value.focusable, false);
});
