/**
 * skills-service.ts - 形象工坊：Skills 预览与多平台导入（2026-11-18 小M）
 *
 * 职责边界（与 pet-manager/header-hover/modifier-passthrough 同构）：
 *   Skill 发现、frontmatter 解析、平台目录检测、导入复制的纯逻辑层，零 electron
 *   依赖，node --test 直测；窗口与 IPC 由 index.ts 执行。
 *
 * 安全纪律（个人目录写入）：
 *   - 只在调用方给定的目标 skills 目录内创建 <skill-name>/ 子目录；
 *   - skill 名经白名单清洗，杜绝 .. / 路径分隔符穿越；
 *   - 目标已存在时先时间戳备份再复制，绝不删除任何既有文件；
 *   - 平台目录是否存在由 detectPlatforms 判定，不存在的平台不参与导入。
 *
 * 导出形态：export = 单导出（与 paste-bridge/pet-manager 同构；模块内接口/类型
 * 仅作类型面，经 typeof import 对外推导）。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const os: typeof import('os') = require('os');

/** AI 平台定义：id / 展示名 / skills 目录相对用户 home 的路径 */
interface PlatformDef {
  id: string;
  name: string;
  rel: string;
}

/** 已知平台清单（按用户机器实测；macOS 同结构由 os.homedir 天然覆盖） */
const PLATFORM_DEFS: PlatformDef[] = [
  { id: 'codex', name: 'Codex', rel: '.codex/skills' },
  { id: 'copilot', name: 'GitHub Copilot', rel: '.copilotCode/skills' },
  { id: 'workbuddy', name: 'WorkBuddy', rel: '.workbuddy/skills' },
  { id: 'wiscode', name: 'Wiscode', rel: '.wiscode/skills' },
  { id: 'claude', name: 'Claude Code', rel: '.claude/skills' },
  { id: 'cursor', name: 'Cursor', rel: '.cursor/skills' },
];

/** SKILL.md frontmatter 解析结果 */
interface SkillMeta {
  name: string;
  description: string;
  raw: string;
}

/** 本地 skill 摘要（列表消费） */
interface SkillSummary {
  id: string;
  name: string;
  description: string;
  dir: string;
  skillFile: string;
}

/** 平台检测结果（渲染层消费） */
interface PlatformStatus {
  id: string;
  name: string;
  dir: string;
  available: boolean;
}

/** 导入结果 */
interface ImportResult {
  ok: boolean;
  dest?: string;
  backedUp?: string;
  error?: string;
}

/** 目录条目最小面（便于测试注入） */
interface DirEntryLike { name: string; isDirectory: () => boolean; }

/** 可注入的 fs 面：生产用 node fs，测试用内存桩 */
interface SkillFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (p: string, opts: { withFileTypes: true }) => DirEntryLike[];
  mkdirSync: (p: string, opts: { recursive: true }) => void;
  cpSync: (src: string, dest: string, opts: { recursive: true }) => void;
  renameSync: (from: string, to: string) => void;
}

const nodeFs: SkillFs = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc as BufferEncoding) as unknown as string,
  readdirSync: (p, opts) => fs.readdirSync(p, opts as Parameters<typeof fs.readdirSync>[1]) as unknown as DirEntryLike[],
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  cpSync: (src, dest, opts) => fs.cpSync(src, dest, opts),
  renameSync: (from, to) => fs.renameSync(from, to),
};

/** 解析 SKILL.md 的 YAML frontmatter（只需 name/description 两键；
 *  值去首尾单/双引号，内部中文引号保留）。无 frontmatter 时 name 回落 untitled。 */
function parseFrontmatter(md: unknown): SkillMeta {
  const raw = typeof md === 'string' ? md : '';
  let name = '';
  let description = '';
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (block) {
    for (const line of block[1].split(/\r?\n/)) {
      const m = line.match(/^\s*(name|description)\s*:\s*(.*)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^['"]/, '').replace(/['"]$/, '');
      if (m[1] === 'name') name = val;
      else description = val;
    }
  }
  return { name: name || 'untitled-skill', description, raw };
}

/** skill 名清洗与合法性判定：
 *  - 含路径分隔符（/ 或 \\）或连续点 .. 的输入直接拒绝（返回空串）——比静默改成另一个名字更安全：
 *    用户传 ../evil 时若悄悄落成 evil，会误以为导入了目标名，属语义错误；
 *  - 合法字符仅 [A-Za-z0-9_.-]，首尾的点/连字符去除；
 *  - 清洗后为空或超长截断后为空则拒绝。
 *  调用方以返回空串判定非法并拒绝导入。 */
function sanitizeSkillName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const raw = name.trim();
  if (!raw || /[\\/]/.test(raw) || raw.includes('..')) return '';
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return cleaned.slice(0, 64);
}

/** 列出 skillsRoot 下所有含 SKILL.md 的子目录（id 取目录名）。
 *  目录不存在/读取失败返回空数组，不抛错（首启无 skills 目录也正常）。 */
function listLocalSkills(skillsRoot: string, io: SkillFs = nodeFs): SkillSummary[] {
  let entries: DirEntryLike[];
  try {
    entries = io.readdirSync(skillsRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(skillsRoot, e.name);
    const skillFile = path.join(dir, 'SKILL.md');
    if (!io.existsSync(skillFile)) continue;
    let meta: SkillMeta;
    try {
      meta = parseFrontmatter(io.readFileSync(skillFile, 'utf-8'));
    } catch (_) {
      meta = parseFrontmatter('');
    }
    out.push({ id: e.name, name: meta.name || e.name, description: meta.description, dir, skillFile });
  }
  return out;
}

/** 读取单个 skill 详情（id 为目录名，先清洗再拼接，杜绝穿越）。 */
function readSkill(skillsRoot: string, id: unknown, io: SkillFs = nodeFs): { ok: boolean; meta?: SkillMeta; skillFile?: string; error?: string } {
  const safe = sanitizeSkillName(id);
  if (!safe) return { ok: false, error: '非法 Skill 标识' };
  const skillFile = path.join(skillsRoot, safe, 'SKILL.md');
  if (!io.existsSync(skillFile)) return { ok: false, error: 'Skill 不存在' };
  try {
    return { ok: true, meta: parseFrontmatter(io.readFileSync(skillFile, 'utf-8')), skillFile };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 检测已知 AI 平台：平台存在 = 其 skills 目录已存在（可导入）。
 *  homeDir 可注入，便于测试；缺省 os.homedir()。 */
function detectPlatforms(homeDir: string = os.homedir(), io: SkillFs = nodeFs): PlatformStatus[] {
  return PLATFORM_DEFS.map((p) => {
    const dir = path.join(homeDir, p.rel);
    return { id: p.id, name: p.name, dir, available: io.existsSync(dir) };
  });
}

/** 把一个 skill 目录复制到目标平台的 skills 目录：
 *  dest/<safeName>/。目标已存在先 rename 备份为 <safeName>.bak-<ts>，再复制。
 *  只写目标 skill 子目录，不触碰平台 skills 目录下的其他条目。 */
function importSkill(srcDir: string, destSkillsDir: string, skillName: unknown, io: SkillFs = nodeFs, nowMs: number = Date.now()): ImportResult {
  const safe = sanitizeSkillName(skillName);
  if (!safe) return { ok: false, error: '非法 Skill 名称' };
  if (!io.existsSync(path.join(srcDir, 'SKILL.md'))) return { ok: false, error: '源 Skill 缺少 SKILL.md' };
  const dest = path.join(destSkillsDir, safe);
  let backedUp: string | undefined;
  try {
    if (io.existsSync(dest)) {
      backedUp = path.join(destSkillsDir, `${safe}.bak-${nowMs}`);
      io.renameSync(dest, backedUp);
    }
    io.mkdirSync(destSkillsDir, { recursive: true });
    io.cpSync(srcDir, dest, { recursive: true });
    return { ok: true, dest, backedUp };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export = {
  PLATFORM_DEFS,
  parseFrontmatter,
  sanitizeSkillName,
  listLocalSkills,
  readSkill,
  detectPlatforms,
  importSkill,
};
