/**
 * copy-assets.js - 复制 src/renderer 静态资源到 dist/renderer
 *
 * 统一切换（2026-10-10）：运行时改加载 dist TS 产物后，html/css/图片等
 * 非 .js/.ts 资源不参与 tsc 编译，需随构建复制到 dist 才能被 loadFile/
 * 托盘图标等相对路径命中（src/main/index.ts 的 ../renderer/* 全部落 dist）。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const DEST = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (entry.isDirectory()) continue; // 渲染层当前为平面结构；子目录出现时在此扩展
  if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) continue; // 代码由 tsc emit
  fs.copyFileSync(path.join(SRC, entry.name), path.join(DEST, entry.name));
  copied++;
}
console.log(`[copy-assets] 复制 ${copied} 个静态资源 → dist/renderer/`);
