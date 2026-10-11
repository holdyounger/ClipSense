/**
 * crash-dump.ts - 异常快照采集（2026-10-11）
 *
 * 两层设计（互补覆盖所有异常面）：
 *  1. 原生崩溃（主/渲染/GPU 进程崩溃、native 模块如 koffi 段错误）
 *     → crashReporter（Windows = Crashpad）自动落 .dmp minidump，
 *       本地保存不上传；标准 Windows dump，WinDbg 可直接分析
 *  2. JS 层异常（主进程 uncaughtException / unhandledRejection）
 *     → 结构化快照日志（错误堆栈 + 应用状态 JSON）落 crash-logs/
 *
 * 使用约定：
 *  - startCrashReporter() 尽早调用（先于 app ready，覆盖面最大）
 *  - setupExceptionCapture() 在应用对象可用后调用（快照带应用状态）
 *  - 渲染进程/子进程异常由主进程 render-process-gone / child-process-gone
 *    事件驱动（index.ts 接线），经 writeTextSnapshot 落盘
 *
 * 测试：buildExceptionLines / writeTextSnapshot / rotateCrashLogs 为纯函数
 * （fs + 参数注入），tests/crash-dump.test.js 覆盖；startCrashReporter 需
 * electron 桩（crashReporter spy）。
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

/** 快照采集参数 */
export interface CrashCaptureOptions {
  /** 快照日志目录（通常 userData/crash-logs） */
  logDir: string;
  /** 应用状态采集器（返回值 JSON 序列化进快照） */
  getState?: () => Record<string, unknown>;
  /** 快照日志保留数量上限（超过按名称倒序保留最新 N 个，默认 50） */
  keep?: number;
}

/**
 * 启动 Crashpad 原生崩溃采集：本地 .dmp，不上传。
 * 必须尽早调用（先于 app ready）——覆盖主/渲染/GPU/native 崩溃。
 */
export function startCrashReporter(): void {
  // 惰性 require：让单元测试能用 electron 桩（crashReporter spy）驱动
  const { crashReporter } = require('electron') as {
    crashReporter: { start: (options: Record<string, unknown>) => void };
  };
  crashReporter.start({
    uploadToServer: false, // 本地保存 .dmp，隐私数据不出机器
  });
}

/**
 * 构建异常快照的文本行（纯函数，可单测）。
 * @param kind 异常类型（uncaughtException / unhandledRejection / render-process-gone 等）
 * @param err 错误对象（Error 取 stack；其他 String 化）
 * @param state 应用状态（JSON 序列化；undefined 则省略状态段）
 */
export function buildExceptionLines(
  kind: string,
  err: unknown,
  state?: Record<string, unknown>
): string[] {
  const lines: string[] = [];
  lines.push('=== ClipSense 异常快照 ===');
  lines.push(`时间: ${new Date().toISOString()}`);
  lines.push(`类型: ${kind}`);
  if (err instanceof Error) {
    lines.push(`错误: ${err.name}: ${err.message}`);
    if (err.stack) {
      lines.push('堆栈:');
      lines.push(err.stack);
    }
  } else if (err !== undefined) {
    lines.push(`详情: ${String(err)}`);
  }
  if (state) {
    lines.push('=== 应用状态 ===');
    try {
      lines.push(JSON.stringify(state, null, 2));
    } catch (e) {
      lines.push(`(状态序列化失败: ${String(e)})`);
    }
  }
  lines.push('=========================');
  return lines;
}

/**
 * 写快照文本文件（纯函数，可单测）。文件名带毫秒时间戳避免同秒覆盖。
 * @returns 写入的完整路径
 */
export function writeTextSnapshot(
  logDir: string,
  baseName: string,
  lines: string[]
): string {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-') // 文件名安全（Windows 禁 : ）
    .replace('T', '_')
    .replace(/-\d+Z$/, '');
  const file = path.join(logDir, `${baseName}_${stamp}.log`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/**
 * 快照日志轮转：按文件名倒序保留最新 keep 个，超出删除（纯函数，可单测）。
 * 只处理 logDir 下 .log 文件，不碰子目录与其他扩展名。
 */
export function rotateCrashLogs(logDir: string, keep = 50): void {
  if (!fs.existsSync(logDir)) return;
  const logs = fs
    .readdirSync(logDir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse(); // 文件名含 ISO 时间戳，字典序倒序 = 新→旧
  for (const stale of logs.slice(keep)) {
    try {
      fs.unlinkSync(path.join(logDir, stale));
    } catch (_) {
      /* 单个删除失败不阻断 */
    }
  }
}

/**
 * 接线 JS 层异常采集（uncaughtException / unhandledRejection）。
 * 语义：记录完整快照后**保持应用存活**（托盘常驻工具单点 JS 异常不应整体退出）；
 * 原生崩溃不走这里（Crashpad 直接接管，见 startCrashReporter）。
 */
export function setupExceptionCapture(opts: CrashCaptureOptions): void {
  const keep = opts.keep ?? 50;
  const snapshot = (kind: string, err: unknown): void => {
    try {
      const state = opts.getState ? opts.getState() : undefined;
      writeTextSnapshot(opts.logDir, kind, buildExceptionLines(kind, err, state));
      rotateCrashLogs(opts.logDir, keep);
    } catch (_) {
      /* 快照自身失败不二次抛出（避免 handler 内崩溃循环） */
    }
  };
  process.on('uncaughtException', (err: Error) => snapshot('uncaughtException', err));
  process.on('unhandledRejection', (reason: unknown) => snapshot('unhandledRejection', reason));
}
