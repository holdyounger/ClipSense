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
// 递归复制（2026-10-14 Live2D 接入）：live2d/（运行时库）与 hiyori/（模型资产）
// 是子目录，原实现 readdirSync 后 isDirectory 即 continue 会整目录漏掉。
// .js 跳过规则仅限渲染层根目录（源码由 tsc emit）；子目录的 .js 是 vendor 库
//（pixi.min.js 等），必须随包分发（v8 实机教训：跳过规则误伤 → PIXI 插件未加载）
function copyDir(srcDir, destDir, isRoot) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, false);
    } else {
      if (isRoot && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) continue;
      fs.copyFileSync(s, d);
      copied++;
    }
  }
}
copyDir(SRC, DEST, true);
console.log(`[copy-assets] 复制 ${copied} 个静态资源（含子目录） → dist/renderer/`);
