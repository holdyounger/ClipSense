/**
 * paste-target.test.js - 双击粘贴目标决策结构断言（2026-11-11 修复守护）
 *
 * 背景：双击粘贴失效两处根因（2026-11-11 分析）：
 *  1. index._diagCapture 的 Z 序回退 captureBelow 结果只落日志、随后被无条件清零
 *     → 「唤出时前台=桌面/任务栏」场景 tracked 恒 0 → 双击无目标必失效
 *  2. simulate-input 双 0 时直接 pasteTo(0) 白跑注入；无自附加守卫
 *
 * 本测试锚定 .ts 源结构（同仓既有约定：行为测试跑编译产物，结构断言锚源码）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('paste-target: _diagCapture 必须把 Z 序回退目标写入 tracked（不许只落日志）', () => {
  const src = readSrc('src/main/index.ts');
  const m = src.match(/_diagCapture\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, '_diagCapture 方法体可定位');
  const body = m[0];
  // 回退目标 fb 必须写回 focusTracker 字段（修复前只 _modDiag 后无条件清零）
  assert.ok(
    /fb > 0\)[\s\S]*?_targetHwnd = fb/.test(body),
    'fb>0 分支必须含 _targetHwnd = fb 回写'
  );
  // 清零只允许出现在 else（fb 无效）分支
  const elseIdx = body.indexOf('} else {');
  assert.ok(elseIdx > -1, 'fb 分支存在 else');
  const afterElse = body.slice(elseIdx);
  assert.ok(afterElse.includes('_targetHwnd = 0'), 'else 分支保留清零语义');
  // 修复前形态：if (fb > 0) 单行日志后紧跟无条件清零 —— 守护回归
  assert.ok(
    !/_modDiag\(`\[Paste\] capture z-fallback hwnd=\$\{fb\}`\);\s*\n\s*ft\._targetHwnd = 0;/.test(body),
    '禁止回归到「只落日志随后清零」的旧形态'
  );
});

test('paste-target: simulate-input 双 0 时 Z 序下探兜底且无目标短路', () => {
  const src = readSrc('src/main/index.ts');
  const m = src.match(/ipcMain\.handle\('simulate-input'[\s\S]*?\n    \}\);/);
  assert.ok(m, 'simulate-input handler 可定位');
  const body = m[0];
  assert.ok(body.includes('captureBelow'), '双 0 兜底必须做 Z 序下探');
  assert.ok(body.includes("'no-target'"), '无目标必须短路返回 no-target（不白跑注入）');
  // 下探命中要回写 tracked（同显示周期复用）
  assert.ok(
    /_targetHwnd = below/.test(body),
    '下探命中必须回写 tracked'
  );
});

test('paste-target: pasteTo 补 AttachThreadInput 自附加守卫', () => {
  const src = readSrc('src/main/paste-bridge.ts');
  const m = src.match(/AttachThreadInput\(fgTidVal, selfTid, true\)/);
  assert.ok(m, 'attach 调用存在');
  // 守卫条件：fg 线程不得是自身线程
  assert.ok(
    /fgTidVal !== selfTid\)\s*\{\s*\n\s*attached = !!_user32\.AttachThreadInput/.test(src),
    'attach 前必须守卫 fgTidVal !== selfTid'
  );
});

test('paste-target: 焦点恢复日志仍保留（归因链不退化）', () => {
  const src = readSrc('src/main/index.ts');
  assert.ok(src.includes("[Paste] target fgNow="), '目标决策日志保留');
  const bridge = readSrc('src/main/paste-bridge.ts');
  assert.ok(bridge.includes("restored="), 'pasteTo restored 归因日志保留');
});
