/**
 * link-utils.test.js - isPathLikeText 形态判定（文本条目「打开路径」按钮，2026-10-10）
 *
 * 加载 dist 编译产物（统一切换后测试锚定产物）；
 * extractLinks 冒烟顺带覆盖（回归防护）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const linkUtils = require(path.join(__dirname, '..', 'dist', 'common', 'link-utils.js'));
const { isPathLikeText, extractLinks } = linkUtils;

describe('isPathLikeText 形态判定（「打开路径」按钮）', () => {
  // 正例
  const positives = [
    ['盘符反斜杠', 'C:\\logs\\app.log'],
    ['盘符正斜杠', 'C:/data/a.txt'],
    ['盘符+尾空格 trim', '  D:\\x\\y.png  '],
    ['UNC', '\\\\server\\share\\doc.docx'],
    ['file URI win', 'file:///C:/x.png'],
    ['file URI posix', 'file:///home/u/i.jpg'],
    ['POSIX 受限顶层', '/usr/local/bin/node'],
    ['POSIX /mnt', '/mnt/d/Montarius/source'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => assert.strictEqual(isPathLikeText(text), true));
  }

  // 负例
  const negatives = [
    ['URL 归 🌐', 'https://example.com/a.png'],
    ['http 忽略大小写', 'HTTP://x.com/f'],
    ['裸盘符', 'C:'],
    ['C: 后接中文（非路径形态）', 'C: 盘空间不足'],
    ['裸 POSIX 顶层', '/tmp'],
    ['含换行（两行路径）', 'C:\\a.txt\nD:\\b.txt'],
    ['不以路径开头（长文本含路径）', '今天看了 /usr/bin 下的文件'],
    ['相对路径', '../src/common/tag-utils.js'],
    ['纯文本', 'hello world'],
    ['空串', ''],
    ['纯空白', '   '],
    ['非字符串', null],
    ['超长（>500）', 'C:\\' + 'a'.repeat(600)],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => assert.strictEqual(isPathLikeText(text), false));
  }
});

describe('extractLinks 冒烟（回归防护）', () => {
  test('URL 提取仍正常', () => {
    assert.deepStrictEqual(extractLinks('看 https://example.com/x'), ['https://example.com/x']);
    assert.strictEqual(extractLinks('无链接'), null);
  });
});
