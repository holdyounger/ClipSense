'use strict';

/**
 * trigger-anim.test.js - 贴边触发条 V0.5「真抽屉」收纳动画测试（2026-09-12）
 *
 * 覆盖 src/main/trigger-anim.js（主进程侧预积分 + 注入脚本生成）：
 *  - springFrames：收敛、精确落位帧、无 NaN、无界积分防护
 *  - buildKeyframes 三段物理：拉开（dx 0→travel）、塞入（光珠坠入缝内）、
 *    推回（收敛到 0 + 机械限位钳制 [0,travel]）、时长预算、末帧精确静息、
 *    柜内亮光包络（g 峰值/收熄）
 *  - buildTriggerScript：协议兼容（无参调用 / __clipSenseBarStop 复位 /
 *    __clipSenseBarApplyEdge）、node --check 语法等价、
 *    无模板字面量残留 / 无 </script> 截断
 *
 * 运行：node --test tests/trigger-anim.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  springFrames, buildKeyframes, buildTriggerScript,
  DRAWER, BEAD, CLOSE, GLOW, DT_MS, MAX_FRAMES,
} = require('../src/main/trigger-anim');

describe('springFrames 半隐式欧拉积分', () => {
  test('从初速出发收敛到目标并补精确落位帧', () => {
    const f = springFrames({ from: -30, to: 0, velocity: 40, stiffness: 300, damping: 18, maxFrames: 60 });
    assert.ok(f.length >= 2);
    const last = f[f.length - 1];
    assert.strictEqual(last.x, 0);
    assert.strictEqual(last.v, 0);
    for (const fr of f) {
      assert.ok(Number.isFinite(fr.x) && Number.isFinite(fr.v), 'no NaN/Infinity');
    }
  });

  test('无初速的欠阻尼弹簧仍产生一次过冲回弹（真物理，非 tween）', () => {
    const f = springFrames({ from: 10, to: 0, stiffness: 180, damping: 14, maxFrames: 60 });
    const min = Math.min(...f.map((fr) => fr.x));
    assert.ok(min < -0.5, `expect overshoot below 0, got ${min}`);
  });

  test('maxFrames 兜底：异常参数不无限积分', () => {
    const f = springFrames({ from: -100, to: 0, stiffness: 0.001, damping: 0, maxFrames: 10 });
    assert.ok(f.length <= 11); // 10 步 + 落位帧
  });
});

describe('buildKeyframes V0.5 真抽屉三段运动', () => {
  const { frames, impactFrame, beadImpactVelocity, durationMs } = buildKeyframes();

  test('时长 ≤ MAX_FRAMES 兜底且 ≥ 300ms（三段叙事需要可读帧数）', () => {
    assert.ok(durationMs >= 300, `duration ${durationMs}ms < 300ms`);
    assert.ok(durationMs <= MAX_FRAMES * DT_MS, `duration ${durationMs}ms > cap`);
    assert.strictEqual(frames.length, Math.round(durationMs / DT_MS));
  });

  test('拉开段：首帧起 dx 递增（抽屉被拉出，不是瞬移）', () => {
    assert.ok(frames[0].dx > 0 && frames[1].dx > frames[0].dx, 'opening must progress');
  });

  test('推回段：dx 被机械限位钳制在 [0, travel]，末帧关严', () => {
    for (const f of frames) {
      assert.ok(f.dx >= 0, `dx ${f.dx} must not escape cabinet (negative)`);
      assert.ok(f.dx <= DRAWER.travel, `dx ${f.dx} exceeds travel ${DRAWER.travel}`);
    }
    assert.strictEqual(frames[frames.length - 1].dx, 0, 'drawer fully closed at end');
  });

  test('光珠纵向位移不越过 56px 窗口（|y| ≤ 28px）', () => {
    for (const f of frames) {
      assert.ok(Math.abs(f.y) <= 28, `bead y ${f.y}px escapes 56px window`);
    }
  });

  test('光珠在缝隙露出后才起落（BEAD_START 前不可见），撞击动量朝下', () => {
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(frames[i].o, 0, `frame ${i}: bead must be hidden before gap opens`);
    }
    assert.ok(impactFrame > 0, 'impact happens during playback');
    assert.ok(beadImpactVelocity > 0, 'downward momentum into the drawer');
  });

  test('柜内亮光：峰值不超过 GLOW.peak，末帧收熄为 0', () => {
    const peak = Math.max(...frames.map((f) => f.g));
    assert.ok(peak <= GLOW.peak + 1e-9, `glow peak ${peak} exceeds cap`);
    assert.strictEqual(frames[frames.length - 1].g, 0, 'glow extinguished at rest');
  });

  test('末帧精确静息：抽屉关严、光珠被吞、缝隙光收熄', () => {
    const last = frames[frames.length - 1];
    assert.deepStrictEqual(last, { dx: 0, g: 0, y: 0, s: 0, o: 0 });
  });

  test('所有字段有限且 opacity ∈ [0,1]', () => {
    for (const f of frames) {
      for (const [k, v] of Object.entries(f)) {
        assert.ok(Number.isFinite(v), `${k} finite`);
      }
      assert.ok(f.o >= 0 && f.o <= 1, `opacity ${f.o} in range`);
    }
  });
});

describe('buildTriggerScript 注入脚本', () => {
  const script = buildTriggerScript();

  test('暴露协议入口 __clipSenseBarPulse（无参调用兼容旧 IPC）', () => {
    assert.match(script, /window\.__clipSenseBarPulse = function \(\) \{/);
  });

  test('提供 __clipSenseBarApplyEdge：边样式单一来源（className+cavity+bead）', () => {
    assert.ok(script.includes('window.__clipSenseBarApplyEdge = function'));
    assert.ok(script.includes("bar.className = (edge === 'left') ? 'left' : 'right'"));
    assert.ok(script.includes('cav.style.background'), 'gradient direction per edge');
    assert.ok(script.includes('bead.style'), 'bead anchor per edge');
  });

  test('连续重触发：提供 __clipSenseBarStop 复位钩子 + cleanup 取消 rAF', () => {
    assert.ok(script.includes('window.__clipSenseBarStop = cleanup'));
    assert.ok(script.includes('cancelAnimationFrame'));
    assert.match(script, /function cleanup\(\)/);
  });

  test('回放结束复位样式（不驻留合成层）', () => {
    assert.ok(script.includes("bar.style.transform = ''"));
    assert.ok(script.includes("cav.style.opacity = '0'"));
  });

  test('不含宿主模板字面量冲突字符与 </script> 截断', () => {
    assert.ok(!script.includes('`'), 'backtick breaks index.js template literal');
    assert.ok(!script.includes('${'), 'dollar-brace breaks template literal');
    assert.ok(!script.includes('</script'), 'script-close tag truncates inline HTML');
  });

  test('生成的脚本通过 node --check 语法校验（等价浏览器解析）', () => {
    const tmp = path.join(os.tmpdir(), `trigger-anim-inject-${process.pid}.js`);
    fs.writeFileSync(tmp, script);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('关键帧数据完整内嵌（rAF 回放无需二次计算）', () => {
    const { frames } = buildKeyframes();
    assert.ok(script.includes(JSON.stringify(frames)));
  });
});
