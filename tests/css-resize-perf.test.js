/**
 * CSS resize 性能守卫（2026-11-02，小M 报告：item 列表过多时调整主面板尺寸卡顿）
 *
 * 根因：.item 无渲染包含（containment）——resizable+transparent 窗口每帧 resize
 * 触发全列表 relayout+repaint（500 条 × ::before/::after 辉光伪元素）。
 * 修复：.item 挂 content-visibility: auto + contain-intrinsic-size（视口外跳过）。
 *
 * 断言方式：静态读取 src/renderer/main.css（与 perf-opt-rerun 的 dist 静态守卫同款）。
 * 红灯：修复前 main.css 无 content-visibility → 2 fail。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'main.css');
const css = fs.readFileSync(cssPath, 'utf-8');

/** 抠出 .item 规则体（非 ::before/::after 伪元素块） */
function extractItemRule() {
  const m = css.match(/^\.item \{([\s\S]*?)\n\}/m);
  return m ? m[1] : '';
}

describe('resize 性能守卫：.item 渲染包含（content-visibility）', () => {
  test('.item 挂 content-visibility: auto（视口外跳过布局/绘制）', () => {
    const rule = extractItemRule();
    assert.ok(rule, '.item 规则块应存在');
    assert.ok(
      /content-visibility:\s*auto/.test(rule),
      '.item 应包含 content-visibility: auto，实际规则体：' + rule.slice(0, 200)
    );
  });

  test('.item 挂 contain-intrinsic-size（滚动高度估算基准，进度环/滚动条不漂移）', () => {
    const rule = extractItemRule();
    assert.ok(
      /contain-intrinsic-size:\s*auto\s+\d+px/.test(rule),
      '.item 应包含 contain-intrinsic-size: auto <N>px'
    );
  });
});
