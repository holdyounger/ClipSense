'use strict';

/**
 * tag-utils.test.js - 自动打标签识别管线单元测试（node:test，零依赖）
 *
 * 运行：node --test tests/
 * 规格：Docs/架构设计-自动打标签-2026-09-09.md §4（识别器）/ §9（性能预算）/ §10（测试设计）
 *
 * ⚠ 测试输入设计约束：识别输入按规格截断到 64KB。所有超长用例必须使用
 * 「中文/英文/标点/数字混排」的现实填充文本——禁止 'x'.repeat(64KB) 这类
 * 单一字符类连续长跑：邮箱正则对「无 @ 的超长字符类连续段」逐位回扫会
 * 退化为平方级，测试自身成为病态样本。生产剪贴板以混排文本为主，
 * 线性预算按现实分布验证（另设无 @ 十六进制长跑用例守护快速跳过路径）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const tagUtils = require('../src/common/tag-utils');
const { extractLinks } = require('../src/common/link-utils');
const { BATTERY } = require('../temp/tag-v2-validation-20260910/battery');
const ClipboardMonitor = require('../src/main/clipboard-monitor');

const { computeTags, luhnCheck, MAX_TAGS, TAG_PRIORITY } = tagUtils;

// ==================== 工具 ====================

/** 现实混排填充：中/英/标点/数字混合，破坏单一字符类长跑 */
const FILLER = '普通中文句子 with english words, 123 numbers; done. ';

function buildFiller(targetLength) {
  const repeat = Math.ceil(targetLength / FILLER.length);
  return FILLER.repeat(repeat).slice(0, targetLength);
}

/** 64KB 混合样本（多行，含代码/SQL/CLI/URL/邮箱/中文，贴近真实剪贴板分布） */
function build64KBText() {
  const para = [
    'const value = compute(input);',
    'SELECT id, name FROM users LIMIT 10;',
    'git push origin main',
    '这是一段普通中文文本，没有任何特殊内容。',
    'user@example.com 与 https://example.com/path?q=1 混排',
    '    indented code line here',
    '}',
  ].join('\n');
  let out = '';
  while (out.length < 64 * 1024) out += para + '\n';
  return out.slice(0, 64 * 1024);
}

/** 断言 tags 包含指定标签 */
function includesTag(text, id, msg) {
  const tags = computeTags(text);
  assert.ok(Array.isArray(tags) && tags.includes(id), msg || `期望含 ${id}，实得 ${JSON.stringify(tags)}：${JSON.stringify(String(text).slice(0, 60))}`);
  return tags;
}

/** 断言 tags 不含指定标签 */
function excludesTag(text, id, msg) {
  const tags = computeTags(text);
  assert.ok(!Array.isArray(tags) || !tags.includes(id), msg || `期望不含 ${id}，实得 ${JSON.stringify(tags)}：${JSON.stringify(String(text).slice(0, 60))}`);
  return tags;
}

// ==================== 公共约定 ====================

describe('公共约定', () => {
  test('导出与常量（§4.0；v2 扩展 12 类，方案 §3.3）', () => {
    assert.equal(typeof computeTags, 'function');
    assert.equal(typeof luhnCheck, 'function');
    assert.equal(MAX_TAGS, 8);
    assert.deepStrictEqual(TAG_PRIORITY, [
      'sensitive', 'vuln', 'otp', 'cmd', 'stack', 'config',
      'ip', 'hash', 'link', 'email', 'snippet', 'path',
    ]);
  });

  test('零进程通信/零联网：源码审计（PRD 验收 6）', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../src/common/tag-utils'), 'utf8');
    for (const banned of ['ipcMain', 'ipcRenderer', 'electron', 'fetch(', 'http.request', 'net.connect', 'XMLHttpRequest', 'require(\'electron\')']) {
      assert.ok(!src.includes(banned), `tag-utils 不得引用 ${banned}`);
    }
  });
});

// ==================== link（复用 extractLinks） ====================

describe('link 识别器', () => {
  const positives = [
    'https://github.com/holdyounger/ClipSense',
    'www.example.com/a?b=1',
    'http://localhost:3000/dashboard',
    '192.168.1.10:8080/admin',
    'ftp://files.example.org/pub/readme.txt',
    '发布页 https://example.com/release 求关注',
    '两个链接 https://a.com/one 和 https://b.com/two',
    'https://example.com',
  ];
  for (const text of positives) {
    test(`正例：${text.slice(0, 40)}`, () => includesTag(text, 'link'));
  }

  const negatives = [
    'hello world',
    'dev@example.com',
    'example.com',
    '123456',
    '不是链接的中文句子',
    'user:pass@host',
  ];
  for (const text of negatives) {
    test(`负例：${text.slice(0, 40)}`, () => excludesTag(text, 'link'));
  }
});

// ==================== email ====================

describe('email 识别器', () => {
  const positives = [
    'dev@example.com',
    'user.name+tag@sub.domain.co',
    '联系 foo_bar-baz@test.org 谢谢',
    'a1@b2.cn',
    'FIRST.LAST@COMPANY.COM',
    'x%y@host.io',
    '邮件发我 admin@site.dev 好吗',
    'a@b.co 和 c@d.org 两个邮箱',
  ];
  for (const text of positives) {
    test(`正例：${text.slice(0, 40)}`, () => includesTag(text, 'email'));
  }

  const negatives = [
    'user@localhost',
    'a@b',
    '1.2.3',
    '@example.com',
    'user@',
    'foo@bar.c',
    'test@exa mple.com',
    'no email here',
  ];
  for (const text of negatives) {
    test(`负例：${text.slice(0, 40)}`, () => excludesTag(text, 'email'));
  }
});

// ==================== sensitive ====================

describe('sensitive 识别器', () => {
  const positives = [
    ['PEM RSA 私钥头', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...'],
    ['PEM PKCS#8 私钥头', '-----BEGIN PRIVATE KEY-----'],
    ['AWS Access Key', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub PAT', 'ghp_' + 'a1B2'.repeat(9)],
    ['OpenAI 风格 key', 'sk-' + 'a'.repeat(20)],
    ['Slack token', 'xoxb-1234567890-abcdef'],
    ['Google API key', 'AIza' + 'x'.repeat(35)],
    ['JWT 三段式', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'],
    ['Bearer 头', 'Authorization: Bearer abcdefghijklmnopqrst'],
    ['URL 内嵌凭据', 'https://user:pass@example.com/api'],
    ['URL token 参数', 'https://vpn.corp.example/login?token=deadbeef123'],
    ['16 位卡号（Luhn ✓）', '4111111111111111'],
    ['分段卡号（Luhn ✓）', '4111 1111 1111 1111'],
    ['密码赋值（英文）', 'password = hunter2you'],
    ['密码赋值（中文）', '数据库密码: Tr0ub4dor'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'sensitive'));
  }

  const negatives = [
    ['16 位数字但 Luhn ✗', '1234567812345678'],
    ['密码无赋值形态', '我的密码忘了'],
    ['掩码值', 'password: ********'],
    ['占位符值', '密码: <your-password-here>'],
    ['AWS 前缀过短', 'AKIA12345'],
    ['sk- 过短', 'sk-short'],
    ['GitHub PAT 35 位（差 1 位）', 'ghp_' + 'x'.repeat(35)],
    ['Bearer token 过短', 'Bearer abc'],
    ['普通聊天', '普通聊天内容，没有凭据'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'sensitive'));
  }

  test('Luhn 纯函数单测（§10）', () => {
    assert.equal(luhnCheck('4111111111111111'), true);
    assert.equal(luhnCheck('1234567812345678'), false);
    assert.equal(luhnCheck('5555555555554444'), true);
    assert.equal(luhnCheck(''), false);
    assert.equal(luhnCheck('12ab'), false);
  });
});

// ==================== snippet ====================

describe('snippet 识别器', () => {
  const positives = [
    ['S1 多行缩进', 'def foo():\n    x = compute(1)\n    return x'],
    ['S2 JSON 对象', '{"name": "clip", "tags": [1, 2]}'],
    ['S2 JSON 数组', '[1, 2, 3]'],
    ['S3 SELECT…FROM', 'SELECT id, name FROM users WHERE age > 18'],
    ['S3 INSERT INTO', 'INSERT INTO logs (id, msg) VALUES (1, \'hi\')'],
    ['S3 UPDATE…SET', 'UPDATE users SET name = \'a\' WHERE id = 1'],
    ['S3 DELETE FROM', 'DELETE FROM sessions WHERE expired = 1'],
    ['S4 git', 'git push -f origin main'],
    ['S4 npm', 'npm run build --prod'],
    ['S4 kubectl', 'kubectl get pods -n prod'],
    ['S5 单行括号+=>', 'const f = (x) => { return x; };'],
    ['W1+W4 弱信号组合', 'if (a > 0) {\n  doThing();\n}'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'snippet'));
  }

  const negatives = [
    ['中文散文（全角括号）', '我们明天开会（下午三点）讨论上线'],
    ['独立词 npm（无参数）', 'npm'],
    ['多行散文无缩进', '第一行散句\n第二行散句\n第三行散句'],
    ['日常句子', '今天天气不错，适合散步'],
    ['英文句子', 'hello world'],
    ['祈使句', '请从列表里选择一项'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'snippet'));
  }
});

// ==================== otp ====================

describe('otp 识别器', () => {
  const positives = [
    '验证码 582914，5 分钟内有效',
    'Your code is 492031',
    'G-123456 是您的 Google 验证代码',
    '【ClipSense】校验码 246810，请勿泄露',
    'verification code: 738291',
    'Your one-time password is 813245',
    'security code 902143',
    '动态码 445566，2 分钟内有效',
    'passcode: 736251',
    'otp: 615243',
  ];
  for (const text of positives) {
    test(`正例：${text.slice(0, 30)}`, () => includesTag(text, 'otp'));
  }

  const negatives = [
    ['订单号（无关键词）', '订单号 582914 已发货'],
    ['裸数字（无上下文）', '582914'],
    ['代码赋值（无英文短语）', 'const code = 1234'],
    ['HH:MM 时间', '会议改到 14:30，验证资料已发'],
    ['关键词无 token', '验证码已过期，请重新获取'],
    ['关键词无 token（英文）', 'your code will arrive shortly'],
    ['11 位手机号（天然排除）', '验证码已发送至 13812345678'],
    ['唯一 token 是年份', '验证码于 2026 年全年有效'],
    ['金额前缀', '消费 ¥582914 已完成，未发送验证码'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'otp'));
  }

  test('年份跳过取下一个 token', () => {
    includesTag('验证码 2026 年前有效，本次 582914', 'otp');
  });

  test('G1：snippet 命中时 otp 让位（const code 类源码由本门拦截）', () => {
    assert.deepStrictEqual(computeTags('{"msg": "验证码 582914"}'), ['snippet']);
  });

  test('G2：text > 300 字符不打 otp（v2 注：x 长跑属 hash 识别域，此处只断言 otp 排除）', () => {
    const long = '验证码 582914。' + 'x'.repeat(300);
    assert.ok(long.trim().length > 300);
    const tags = computeTags(long);
    assert.ok(!Array.isArray(tags) || !tags.includes('otp'), `期望不含 otp，实得 ${JSON.stringify(tags)}`);
  });
});

// ==================== computeTags 聚合 ====================

describe('computeTags 聚合', () => {
  test('展示优先级排序（v2 价值序：sensitive → link → email，方案 §3.3 拍板 #4）', () => {
    const tags = computeTags('打开 https://x.com/reset?token=abc123def 或邮件 admin@corp.com');
    assert.deepStrictEqual(tags, ['sensitive', 'link', 'email']);
  });

  test('结果数不超过 MAX_TAGS', () => {
    const samples = [
      '打开 https://x.com/reset?token=abc123def 或邮件 admin@corp.com',
      'SELECT id, name FROM users;',
      '验证码 582914',
      'git push origin main',
    ];
    for (const s of samples) {
      const tags = computeTags(s);
      if (Array.isArray(tags)) assert.ok(tags.length <= MAX_TAGS);
    }
  });

  test('enabled 过滤：单项关闭直接跳过识别', () => {
    assert.equal(computeTags('AKIAIOSFODNN7EXAMPLE', { enabled: { enabled: true, tags: { sensitive: false } } }), null);
    assert.deepStrictEqual(computeTags('AKIAIOSFODNN7EXAMPLE'), ['sensitive']);
  });

  test('enabled 过滤：总开关关闭全部跳过', () => {
    assert.equal(computeTags('https://example.com', { enabled: { enabled: false } }), null);
    assert.equal(computeTags('AKIAIOSFODNN7EXAMPLE', { enabled: { enabled: false, tags: { sensitive: true } } }), null);
  });

  test('links 复用：传入值权威，undefined 才内部补算（§4.1）', () => {
    // 传入已有 links（即使文本里没有 URL）→ 尊重调用方
    assert.deepStrictEqual(computeTags('plain text no url', { links: ['https://given.example.com/a'] }), ['link']);
    // 传入空数组（已算、无链接）→ 不打 link
    assert.equal(computeTags('https://real.example.com/path', { links: [] }), null);
    // 未传 → 内部补算
    assert.deepStrictEqual(computeTags('https://real.example.com/path'), ['link']);
    // 传入显式 null（已算、无链接）→ 不打 link
    assert.equal(computeTags('plain text no url', { links: null }), null);
  });

  test('null-vs-undefined 幂等语义（§5.1）', () => {
    // 无命中 → null（不是 undefined）
    assert.strictEqual(computeTags('普通文本，什么都不是'), null);
    // 纯函数：同输入同输出（迁移幂等的根基）
    const t1 = computeTags('https://example.com');
    const t2 = computeTags('https://example.com');
    assert.deepStrictEqual(t1, t2);
  });
});

// ==================== 边界 ====================

describe('边界输入（PRD 验收 9）', () => {
  test('空串/纯空白/非字符串 → null 不抛错', () => {
    assert.equal(computeTags(''), null);
    assert.equal(computeTags('   \n\t  '), null);
    assert.equal(computeTags(null), null);
    assert.equal(computeTags(undefined), null);
    assert.equal(computeTags(12345), null);
  });

  test('emoji 混排不抛错、正常识别', () => {
    assert.deepStrictEqual(computeTags('😀🎉 验证码 123456 😀🎉'), ['otp']);
    assert.equal(computeTags('😀🎉👍'), null);
  });

  test('64KB+ 截断：截断点之后不参与识别', () => {
    // 邮箱在 64KB 之外 → 截断后不可见 → null
    const overText = buildFiller(64 * 1024) + ' dev@example.com';
    assert.ok(overText.length > 64 * 1024);
    assert.equal(computeTags(overText), null);
    // 恰好 64KB 之内 → 正常命中
    const innerText = buildFiller(64 * 1024 - 7) + ' c@d.io';
    assert.ok(innerText.length <= 64 * 1024);
    assert.deepStrictEqual(computeTags(innerText), ['email']);
  });
});

// ==================== 性能冒烟（§9 预算） ====================

describe('性能冒烟', () => {
  const PERF_BUILDERS = [
    (i) => `会议纪要第 ${i} 条：今天讨论了发布计划，下周三评审。`,
    (i) => `https://example.com/item/${i}?ref=clipboard`,
    (i) => `联系人 user${i}@example.com 请查收`,
    (i) => `function handler${i}() {\n  return ${i};\n}`,
    (i) => `git commit -m "fix bug ${i}"`,
    (i) => `验证码 ${100000 + i}，5 分钟内有效`,
    (i) => `数据库密码: Str0ngPass${i}`,
    (i) => `SELECT id, name FROM users WHERE id = ${i}`,
    (i) => `这是一段较长的普通文本。`.repeat(50) + ` 编号 ${i}`,
    (i) => `{"id": ${i}, "name": "item", "ok": true}`,
  ];

  test('500 条混合长度存量迁移 < 1s（§9：现实分布 ~50-100ms，病态上界 2-4s）', () => {
    const items = [];
    for (let i = 0; i < 500; i++) {
      const text = PERF_BUILDERS[i % PERF_BUILDERS.length](i);
      items.push({ type: 'text', text, links: extractLinks(text) });
    }
    const t0 = process.hrtime.bigint();
    for (const item of items) {
      item.tags = computeTags(item.text, { links: item.links }); // 仿真 _migrateTags
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`    [perf] 500 条混合迁移实测 ${ms.toFixed(1)}ms`);
    // 断言取 1s：位于现实预算（~100ms）与病态上界（2-4s）之间，给 CI 抖动留余量
    assert.ok(ms < 1000, `500 条迁移耗时 ${ms.toFixed(1)}ms ≥ 1000ms`);
  });

  test('单条 64KB 混合文本打标 < 5ms（§9 预算上界）', () => {
    const big = build64KBText();
    assert.equal(big.length, 64 * 1024);
    computeTags(big, {});
    computeTags(big, {}); // JIT 预热
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      computeTags(big, {});
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const best = Math.min(...times);
    console.log(`    [perf] 单条 64KB 打标 min-of-3 ${best.toFixed(2)}ms`);
    assert.ok(best < 5, `单条 64KB 打标 ${best.toFixed(2)}ms ≥ 5ms`);
  });

  test('64KB 无 @ 十六进制长跑（哈希/证书类）不退化（守护 email 快速跳过；v2 起该形态按设计命中 hash）', () => {
    const blob = '5a3f9c1d'.repeat(8192); // 65536 个字符全在邮箱字符类内且无 @
    assert.equal(blob.length, 64 * 1024);
    computeTags(blob, {});
    const t0 = process.hrtime.bigint();
    const tags = computeTags(blob, {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`    [perf] 64KB 无 @ 长跑 ${ms.toFixed(2)}ms`);
    assert.deepStrictEqual(tags, ['hash']); // v2：长 hex 串属 hash 识别域（方案 §3.2）
    assert.ok(ms < 5, `无 @ 长跑 ${ms.toFixed(2)}ms ≥ 5ms（回扫未消除？）`);
  });
});

// ==================== v2 样本电池（方案 §6 验收 1：64 样本转入，命中率 ≥98%） ====================

describe('v2 样本电池（temp/tag-v2-validation-20260910，64 样本转入）', () => {
  const positives = BATTERY.filter(s => s.cat !== 'negative' && s.cat !== 'gap');
  const negatives = BATTERY.filter(s => s.cat === 'negative');
  const gaps = BATTERY.filter(s => s.cat === 'gap');
  // 缺口样本的断言范围 = v2 新增 7 类（方案 §3.2「已知残余缺口」的语境）。
  // 裸公网 IP 会被 v1 link-utils 判为 link（§3.1 已核实的既有行为，本期 scope 纪律不改 link-utils），
  // 因此不能断言「无任何标签」，只能断言新识别器不接管这些样本。
  const NEW_TAG_IDS = ['vuln', 'cmd', 'stack', 'config', 'ip', 'hash', 'path'];

  for (const s of positives) {
    test(`${s.id}（${s.cat}）：期望标签全部命中`, () => {
      const tags = computeTags(s.text);
      assert.ok(Array.isArray(tags), `${s.id} 期望含 ${JSON.stringify(s.v2Expect)}，实得 null`);
      const missing = s.v2Expect.filter(id => !tags.includes(id));
      assert.deepStrictEqual(
        missing, [],
        `${s.id} 漏识别 ${JSON.stringify(missing)}，实得 ${JSON.stringify(tags)}`);
    });
  }

  for (const s of negatives) {
    test(`${s.id}（负例）：0 误报`, () => {
      assert.equal(computeTags(s.text), null, `${s.id} 误报${s.note ? '：' + s.note : ''}`);
    });
  }

  for (const s of gaps) {
    test(`${s.id}（已知残余缺口）：v2 新识别器按设计不打标`, () => {
      const tags = computeTags(s.text) || [];
      const leaked = tags.filter(id => NEW_TAG_IDS.includes(id));
      assert.deepStrictEqual(
        leaked, [],
        `${s.id} 意外获得 v2 新标签（设计上不打，残余缺口如实记录）：${JSON.stringify(tags)}`);
    });
  }

  test('电池整体命中率 ≥98%（54 画像正样本口径，方案 §6 验收 1）', () => {
    const hit = positives.filter(s => {
      const tags = computeTags(s.text) || [];
      return s.v2Expect.some(id => tags.includes(id));
    }).length;
    const rate = hit / positives.length;
    console.log(`    [battery] v2 命中率 ${hit}/${positives.length} = ${(rate * 100).toFixed(1)}%`);
    assert.ok(rate >= 0.98, `电池命中率 ${(rate * 100).toFixed(1)}% < 98%`);
  });
});

// ==================== v2 新增 7 类：逐类补充正/负例（架构 §10 标准：每类 ≥8 正 + ≥6 负） ====================
// 电池样本已入上一节；本节按类补齐到 ≥8/≥6 标准线。

describe('vuln 识别器（补充）', () => {
  const positives = [
    ['CVE 单条录入', 'CVE-2025-12345 单条编号录入'],
    ['CVD 简报', 'CVD-2026-00001 简报归档'],
    ['GHSA 升级', '升级 GHSA-4f9x-v96m-6h6q 后回归通过'],
    ['CVE 两条', '扫描发现 CVE-2026-24890 与 CVE-2026-24891 两个'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'vuln'));
  }

  const negatives = [
    ['serial 2 位过短', 'CVE-2026-12'],
    ['无 serial', 'CVE-2026-'],
    ['缺连字符', 'CVE2026-12345'],
    ['GHSA 非法字符（a/b 不在 base32 集）', 'GHSA-aaaa-bbbb-cccc'],
    ['无编号形态', 'CVE 2026 年汇总表'],
    ['中文无编号', 'cve 编号未定'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'vuln'));
  }
});

describe('cmd 识别器（补充）', () => {
  const positives = [
    ['kubectl', 'kubectl get pods -n prod'],
    ['docker compose', 'docker compose up -d --build'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'cmd'));
  }

  const negatives = [
    ['独立词 git', 'git'],
    ['独立词 npm', 'npm'],
    ['英文动词句（copy 无佐证特征）', 'copy this sentence to the clipboard and send it back to me later please'],
    ['礼貌祈使句', 'please copy the file for me'],
    ['中文散文含 git 词', '回头发你 git 记录'],
    ['英文散文', 'The quick brown fox jumps over the lazy dog'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'cmd'));
  }
});

describe('stack 识别器（补充）', () => {
  const positives = [
    ['Java 异常+帧', 'java.lang.NullPointerException: msg\n\tat com.example.Foo.bar(Foo.java:42)'],
    ['双条带级别日志（括号级别形态，同电池 stk-log）', '2026-09-10 10:00:00 [ERROR] boot failed\n2026-09-10 10:00:01 [WARN] retry'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'stack'));
  }

  const negatives = [
    ['单条 at 帧无异常', 'at com.example.Foo.bar(Foo.java:1)'],
    ['单条 module!func+off 帧', 'ntdll!RtlpCallOutOfProcDebugger+0x73'],
    ['无时间戳单条 ERROR', 'ERROR something failed badly'],
    ['单条时间戳日志', '2026-09-10 10:00:00 INFO started'],
    ['中文散文', '今天调试了一下午堆栈问题'],
    ['裸 Exception 无帧', 'Exception: 无帧的异常文本'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'stack'));
  }
});

describe('config 识别器（补充）', () => {
  const positives = [
    ['INI section', '[hooks]\nenable_x = 1\ntimeout = 30'],
    ['KV 三行', 'host=localhost\nport=5432\ndbname=app'],
    ['YAML 两级键树', 'server:\n  port: 8080\nlogging:\n  level: info'],
    ['截断 JSON 片段', '{"level": "warn", "count": 42, "msg": "trun'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'config'));
  }

  const negatives = [
    ['单行 KV', 'key: value'],
    ['两行 KV', 'a=1\nb=2'],
    ['全角冒号中文', '提醒：下午三点评审\n注意：带好纸笔'],
    ['URL 查询串', 'https://example.com/a?b=1&c=2'],
    ['时间冒号', '会议 12:30 开始'],
    ['引号非 JSON', '他说"配置"要改'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'config'));
  }
});

describe('ip 识别器（补充）', () => {
  const positives = [
    ['回环地址', '服务起在 127.0.0.1 本地'],
    ['172.16 段', '跳板机 172.16.5.4 可用'],
    ['IP:port URL 主机', '监控 http://10.0.0.5:9090/metrics'],
    ['ssh 到内网机', 'ssh admin@192.168.10.2'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'ip'));
  }

  const negatives = [
    ['版本号点分', '版本 4.8.9337.0'],
    ['浏览器 UA', 'Chrome/140.0.7339.82 Safari/537.36'],
    ['公网 IP', '8.8.8.8'],
    ['公网 IP 无端口', '1.2.3.4'],
    ['超界八位组', '999.1.1.1'],
    ['日期点分形态', '在 2026.09.10 发布'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'ip'));
  }
});

describe('hash 识别器（补充）', () => {
  const positives = [
    ['SHA-1', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['base64 样本', 'Q2xpcFNlbnNlIHRhZyB2MiBlbmNvZGluZyBzYW1wbGU='],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'hash'));
  }

  const negatives = [
    ['短词', 'hello world'],
    ['短 hex', 'e3b0c4'],
    ['GUID 不完整', 'd6729a3d-cfc1-495f-bbce'],
    ['订单号', '订单号 582914 已发货'],
    ['少于 8 字节的 hex dump', '68 88 00'],
    ['版本串', 'v1.0.2-beta'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'hash'));
  }
});

describe('path 识别器（补充）', () => {
  const positives = [
    ['D 盘深路径', 'D:\\Montarius\\source\\clipboard-spike\\src\\common\\tag-utils.js'],
    ['etc 配置', '/etc/nginx/nginx.conf 修改了'],
    ['var 日志', '看下 /var/log/app/error.log 的最后 100 行'],
    ['UNC 共享', '\\\\fileserver\\public\\report.docx'],
  ];
  for (const [name, text] of positives) {
    test(`正例：${name}`, () => includesTag(text, 'path'));
  }

  const negatives = [
    ['URL 路径段', 'https://example.com/usr/local'],
    ['盘符无反斜杠', 'C: 盘空间不足'],
    ['裸反斜杠', '转义符 \\ 后面没有盘符'],
    ['home 单词无前导斜杠', 'home 目录下找一下'],
    ['普通斜杠词', 'and/or 关系'],
    ['相对路径', '../src/common/tag-utils.js'],
  ];
  for (const [name, text] of negatives) {
    test(`负例：${name}`, () => excludesTag(text, 'path'));
  }
});

// ==================== sensitive /i 修复（v2 P0，方案 §3.1：v1 实现偏差补齐） ====================

describe('sensitive /i 修复（RE_PASSWORD_CTX 补 /i）', () => {
  test('PascalCase Password= 命中（电池 sens-pwd 同构最小样本，v1 漏检回归）', () => {
    includesTag('Password=S3cret!2026', 'sensitive');
  });

  test('PassWord 冒号形态命中', () => {
    includesTag('PassWord: hunter2abc', 'sensitive');
  });

  test('全大写 PASSWORD= 命中', () => {
    includesTag('PASSWORD=hunter2abc', 'sensitive');
  });

  test('小写原行为不回归', () => {
    includesTag('password = hunter2you', 'sensitive');
  });

  test('掩码/占位排除不因 /i 放开', () => {
    excludesTag('Password: ********', 'sensitive');
    excludesTag('PASSWORD: <your-password-here>', 'sensitive');
  });
});

// ==================== 性能冒烟 v2（方案 §3.4 病态输入预算） ====================

describe('性能冒烟 v2（§3.4：64KB 病态 base64/hex 长文）', () => {
  test('64KB 病态 base64 长文 < 5ms', () => {
    const body = 'eJzt3E1rIzAMBfDnLLm2FZPZOZgeAxEI99BLL7300kuvvfTSS6+99NpLL7302ksvvfTSS6+99NJrL7300ksvvfbaSy+99A4='.repeat(729);
    const blob = body.slice(0, 64 * 1024 - 1) + 'g'; // 尾部词字符收口
    assert.equal(blob.length, 64 * 1024);
    computeTags(blob, {});
    computeTags(blob, {}); // JIT 预热
    const t0 = process.hrtime.bigint();
    const tags = computeTags(blob, {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`    [perf] 64KB 病态 base64 ${ms.toFixed(2)}ms`);
    assert.deepStrictEqual(tags, ['hash']);
    assert.ok(ms < 5, `病态 base64 ${ms.toFixed(2)}ms ≥ 5ms（无上界贪婪未生效？）`);
  });

  test('64KB 病态 hex 长文（尾部词字符收口，迫使 {32,}\\b 全程回溯）< 5ms', () => {
    const blob = '5a3f9c1d'.repeat(8192).slice(0, 64 * 1024 - 1) + 'g';
    assert.equal(blob.length, 64 * 1024);
    computeTags(blob, {});
    computeTags(blob, {}); // JIT 预热
    const t0 = process.hrtime.bigint();
    const tags = computeTags(blob, {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`    [perf] 64KB 病态 hex+词尾 ${ms.toFixed(2)}ms`);
    assert.deepStrictEqual(tags, ['hash']);
    assert.ok(ms < 5, `病态 hex ${ms.toFixed(2)}ms ≥ 5ms（无上界贪婪+边界界定未生效？）`);
  });
});

// ==================== v2 重迁移 _migrateTagsV2（方案 §5，验收 5） ====================
// clipboard-monitor 顶层 require('electron') 在纯 node 下解构得 undefined（不抛错），
// 类体与 _migrateTagsV2 不触任何 electron API，可用桩 storage 直接验证迁移逻辑。

describe('v2 重迁移 _migrateTagsV2（clipboard-monitor + 桩 storage）', () => {
  function makeMonitor(items) {
    const m = new ClipboardMonitor({});
    m.history = items;
    const calls = { save: 0, setVersion: 0, version: 1 };
    m.storage = {
      getTagSchemaVersion: () => calls.version,
      setTagSchemaVersion: (v) => { calls.setVersion++; calls.version = v; },
      save: () => { calls.save++; },
    };
    return { m, calls };
  }

  test('v1 数据（无 tagSchemaVersion）→ 全量重算 + 版本写 2 + 一次性 save', () => {
    const items = [
      { type: 'text', text: 'https://example.com', links: ['https://example.com'] },
      { type: 'text', text: '普通文本，什么都不是' },
      { type: 'text', text: '10.18.132.214 内网机', links: null, tags: ['link'] }, // v1 旧值被重算
      { type: 'image', dataUrl: 'data:image/png;base64,xxx' }, // 非 text 跳过
    ];
    const { m, calls } = makeMonitor(items);
    assert.equal(m._migrateTagsV2(), 3);
    assert.deepStrictEqual(items[0].tags, ['link']);
    assert.strictEqual(items[1].tags, null); // 已识别无命中 → 显式 null
    assert.deepStrictEqual(items[2].tags, ['ip']); // links=null 权威 → 不打 link，重算为 ip
    assert.equal(calls.save, 1, '末尾一次性 save');
    assert.equal(calls.setVersion, 1);
    assert.equal(calls.version, 2);
  });

  test('幂等：tagSchemaVersion=2 二次启动不重算不回写（验收 5）', () => {
    const items = [{ type: 'text', text: '10.18.132.214', links: null, tags: null }];
    const { m, calls } = makeMonitor(items);
    calls.version = 2;
    assert.equal(m._migrateTagsV2(), 0);
    assert.strictEqual(items[0].tags, null, '条目未被改动');
    assert.equal(calls.save, 0);
    assert.equal(calls.setVersion, 0);
  });

  test('失败静默降级：save 抛错不阻塞、不写版本（下次启动重试自愈）', () => {
    const items = [{ type: 'text', text: 'https://example.com' }];
    const { m, calls } = makeMonitor(items);
    m.storage.save = () => { throw new Error('disk full'); };
    assert.doesNotThrow(() => m._migrateTagsV2());
    assert.equal(calls.setVersion, 0, '未写版本号 → 下次启动重试');
  });

  test('存储缺 getTagSchemaVersion（旧 storage 注入）→ 按版本 1 处理且不崩', () => {
    const m = new ClipboardMonitor({});
    m.history = [{ type: 'text', text: 'https://example.com' }];
    m.storage = { save: () => {} }; // 无 schema 版本方法
    assert.doesNotThrow(() => m._migrateTagsV2());
    assert.deepStrictEqual(m.history[0].tags, ['link']);
  });
});
