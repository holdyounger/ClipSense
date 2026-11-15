/**
 * tests/red/index.js - 红灯测试目录入口
 *
 * 用途：`node --test tests/red/` 显式传目录时，Node v24 不做测试文件扫描、
 * 直接按 CJS require 目录 → 命中本 index 入口，再挂载红灯用例。
 *
 * 隔离纪律：全量门禁 glob `node --test tests/*.test.js` 不递归子目录、
 * 也不含本文件（index.js 非 *.test.js）→ 红灯组永不进全量门禁。
 */
require('./pet-menu-window.red.test.js');
