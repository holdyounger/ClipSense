/**
 * 密文编码 hex→base64（2026-11-03 L3 快速通道，spec 调研结论 #3 补落地）
 *
 * 背景：调研报告 #3「加密 hex 编码体积翻倍」——encryptString 转 hex 存储，
 * 每字节膨胀 2 字符（100%）；实测 clipboard-history.json 2.38MB（真实数据 ~1.2MB）。
 * T2 防抖已降写盘频率，单次体积膨胀成为剩余主要矛盾。
 *
 * 修复：新密文 `b64:` 前缀 + base64（膨胀 ~33%）；decodeCipher 兼容三态：
 * ① `b64:` 前缀 → base64 解码；② 无前缀纯偶长 hex → 存量格式兼容；
 * ③ 其余（明文 JSON 等）→ 抛错，调用方既有 catch 走明文兜底（行为不变）。
 * 迁移语义：旧文件可读（hex 路径），首次 save 全量重写自然迁移到 b64:。
 *
 * 红灯：当前 dist 无 encodeCipher/decodeCipher 静态方法 → 4 fail。
 * （safeStorage 为 electron 运行时 API，node:test 不可用——编解码层抽成纯静态
 * 函数直测；加解密本体在 load/save 链路已有行为覆盖。）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Storage = require(path.join(__dirname, '..', 'dist', 'main', 'storage.js'));

describe('密文编码 hex→base64（2026-11-03）', () => {
  test('encodeCipher：b64: 前缀 + base64，膨胀 <40%（hex 为 100%）', () => {
    const buf = Buffer.from('a'.repeat(1200)); // 接近真实密文量级
    const enc = Storage.encodeCipher(buf);
    assert.ok(enc.startsWith('b64:'), '新密文必须带 b64: 前缀');
    const body = enc.length - 4;
    assert.ok(body < buf.length * 1.4, `base64 膨胀应 <40%，实际 ${(body / buf.length * 100).toFixed(1)}%`);
    assert.ok(body < buf.length * 2, '必须严格小于 hex 的 100% 膨胀');
  });

  test('decodeCipher roundtrip：新格式回读一致', () => {
    const buf = Buffer.from('roundtrip-payload-\xc0\xde\xbe\xef-1234567890');
    const out = Storage.decodeCipher(Storage.encodeCipher(buf));
    assert.ok(out.equals(buf), 'b64: 前缀格式解码必须还原原字节');
  });

  test('decodeCipher 兼容存量 hex（无前缀，2026-11-03 前的磁盘数据）', () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    const out = Storage.decodeCipher(buf.toString('hex'));
    assert.ok(out.equals(buf), '无前缀纯偶长 hex 必须按存量格式解码');
  });

  test('decodeCipher 明文 JSON → 抛错（调用方 catch 走明文兜底，行为不变）', () => {
    assert.throws(() => Storage.decodeCipher('[{"id":"x"}]'), /unrecognized cipher/);
    assert.throws(() => Storage.decodeCipher(''), /unrecognized cipher/);
  });
});
