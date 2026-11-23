/**
 * skills-workshop.test.js - 形象工坊：Skills 预览 + 多平台导入（2026-11-18 小M）
 *
 * 断言面（沿用「纯函数直测 + wiring 静态守卫」双口径）：
 *   1) 纯函数面：dist/main/skills-service.js 的 frontmatter 解析、名称清洗（防穿越）、
 *      Skill 发现、平台检测、导入（含已存在备份 / 绝不删其他文件 / 非法名拒绝）；
 *      用内存 fs 桩注入，零真实磁盘写入；
 *   2) wiring 静态守卫：index.ts 的 pet:open-skill 改为应用内窗口、新增 4 个 IPC、
 *      skills-window.html 的预览渲染 + 平台卡片 + 链接白名单 IPC。
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const svc = require(path.join(ROOT, 'dist', 'main', 'skills-service.js'));

// ============ 内存 fs 桩（支持 exists/readdir/read/mkdir/cp/rename） ============
function makeFs(files) {
  // files: { '<abs path>': 'content' }，目录由路径隐含。
  // Windows 下 path.join 产反斜杠，桩内统一归一到正斜杠再存取，跨平台一致。
  const N = (p) => String(p).replace(/\\/g, '/');
  const store = new Map(Object.entries(files).map(([k, v]) => [N(k), v]));
  const dirOf = (p) => N(p).replace(/\/[^/]*$/, '');
  const dirs = new Set();
  for (const p of [...store.keys()]) {
    let d = dirOf(p);
    while (d && d !== '.') { dirs.add(d); d = dirOf(d); }
  }
  return {
    store, dirs,
    existsSync: (p) => store.has(N(p)) || dirs.has(N(p)),
    readFileSync: (p) => {
      const k = N(p);
      if (!store.has(k)) throw new Error('ENOENT ' + k);
      return store.get(k);
    },
    readdirSync: (p) => {
      const base = N(p);
      const prefix = base + (base.endsWith('/') ? '' : '/');
      const children = new Map();
      for (const key of [...store.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest || rest.includes('/')) continue;
        const isDir = dirs.has(key) || [...dirs].some((d) => d.startsWith(prefix + rest + '/'));
        children.set(rest, { name: rest, isDirectory: () => isDir });
      }
      return [...children.values()];
    },
    mkdirSync: (p) => { dirs.add(N(p)); },
    cpSync: (src, dest) => {
      const s = N(src), d = N(dest);
      for (const [k, v] of [...store.entries()]) {
        if (k === s || k.startsWith(s + '/')) store.set(d + k.slice(s.length), v);
      }
      dirs.add(d);
    },
    renameSync: (from, to) => {
      const f = N(from), t = N(to);
      for (const [k, v] of [...store.entries()]) {
        if (k === f || k.startsWith(f + '/')) { store.set(t + k.slice(f.length), v); store.delete(k); }
      }
    },
  };
}

describe('parseFrontmatter 解析', () => {
  test('导出存在且为函数', () => assert.strictEqual(typeof svc.parseFrontmatter, 'function'));

  test('正常 frontmatter：取 name / description，中文引号保留', () => {
    const md = '---\nname: pet-webm-pipeline\ndescription: "当用户要求“生成透明 WebM”时使用"\n---\n# 正文';
    const m = svc.parseFrontmatter(md);
    assert.strictEqual(m.name, 'pet-webm-pipeline');
    assert.strictEqual(m.description, '当用户要求“生成透明 WebM”时使用');
    assert.match(m.raw, /# 正文/);
  });

  test('单引号值去壳', () => {
    const m = svc.parseFrontmatter("---\nname: 'demo'\ndescription: 'hello'\n---\n");
    assert.strictEqual(m.name, 'demo');
    assert.strictEqual(m.description, 'hello');
  });

  test('无 frontmatter：name 回落 untitled，原文保留', () => {
    const m = svc.parseFrontmatter('# 无头\n正文');
    assert.strictEqual(m.name, 'untitled-skill');
    assert.strictEqual(m.description, '');
    assert.match(m.raw, /正文/);
  });

  test('非字符串 / 空值不抛错', () => {
    assert.strictEqual(svc.parseFrontmatter(undefined).name, 'untitled-skill');
    assert.strictEqual(svc.parseFrontmatter(null).raw, '');
  });
});

describe('sanitizeSkillName 名称清洗（防目录穿越）', () => {
  test('合法名原样保留', () => {
    assert.strictEqual(svc.sanitizeSkillName('pet-webm-pipeline'), 'pet-webm-pipeline');
    assert.strictEqual(svc.sanitizeSkillName('plantuml_skill.v2'), 'plantuml_skill.v2');
  });
  test('路径分隔符 / 点时拒绝或清洗', () => {
    assert.strictEqual(svc.sanitizeSkillName('../evil'), '');
    assert.strictEqual(svc.sanitizeSkillName('..'), '');
    assert.strictEqual(svc.sanitizeSkillName('a..b'), '');
    assert.strictEqual(svc.sanitizeSkillName(''), '');
    assert.strictEqual(svc.sanitizeSkillName(123), '');
  });
  test('非法字符替换为连字符、去首尾', () => {
    assert.strictEqual(svc.sanitizeSkillName('  My Skill!  '), 'My-Skill');
  });
  test('超长名截断至 64', () => {
    assert.strictEqual(svc.sanitizeSkillName('a'.repeat(100)).length, 64);
  });
});

describe('listLocalSkills 发现', () => {
  test('只列出含 SKILL.md 的子目录，id 取目录名', () => {
    const io = makeFs({
      '/root/a/SKILL.md': '---\nname: alpha\ndescription: A skill\n---\n# A',
      '/root/b/SKILL.md': '---\nname: beta\ndescription: B skill\n---\n# B',
      '/root/c/readme.txt': 'no skill here',
      '/root/stray.md': 'top level',
    });
    const list = svc.listLocalSkills('/root', io);
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list.map((s) => s.id).sort(), ['a', 'b']);
    const a = list.find((s) => s.id === 'a');
    assert.strictEqual(a.name, 'alpha');
    assert.strictEqual(a.description, 'A skill');
  });
  test('skillsRoot 不存在返回空数组，不抛错', () => {
    const io = makeFs({});
    assert.deepStrictEqual(svc.listLocalSkills('/missing', io), []);
  });
});

describe('readSkill 读取详情', () => {
  test('正常读取全文', () => {
    const io = makeFs({ '/root/a/SKILL.md': '---\nname: alpha\n---\n# 内容' });
    const r = svc.readSkill('/root', 'a', io);
    assert.strictEqual(r.ok, true);
    assert.match(r.meta.raw, /# 内容/);
  });
  test('非法 id / 不存在拒绝', () => {
    const io = makeFs({ '/root/a/SKILL.md': '---\nname: alpha\n---\n# 内容' });
    assert.strictEqual(svc.readSkill('/root', '../evil', io).ok, false);
    assert.strictEqual(svc.readSkill('/root', 'notthere', io).ok, false);
  });
});

describe('readReference 引用文档读取（安全）', () => {
  const io = makeFs({
    '/root/a/SKILL.md': '---\nname: alpha\n---\n# 内容',
    '/root/a/references/verification.md': '# 验证\n正文',
  });
  test('正常读取相对引用文档', () => {
    const r = svc.readReference('/root', 'a', 'references/verification.md', io);
    assert.strictEqual(r.ok, true);
    assert.match(r.raw, /# 验证/);
  });
  test('.. 穿越 / 绝对路径 / 非 md 拒绝', () => {
    assert.strictEqual(svc.readReference('/root', 'a', '../b/secret.md', io).ok, false);
    assert.strictEqual(svc.readReference('/root', 'a', '/etc/passwd', io).ok, false);
    assert.strictEqual(svc.readReference('/root', 'a', 'references/x.txt', io).ok, false);
  });
  test('非法 id / 不存在的引用拒绝', () => {
    assert.strictEqual(svc.readReference('/root', '../evil', 'references/verification.md', io).ok, false);
    assert.strictEqual(svc.readReference('/root', 'a', 'references/missing.md', io).ok, false);
  });
});

describe('detectPlatforms 平台检测', () => {
  test('存在的目录标 available，不存在标 false', () => {
    const io = makeFs({});
    io.dirs.add('/home/.codex/skills');
    io.dirs.add('/home/.workbuddy/skills');
    const ps = svc.detectPlatforms('/home', io);
    const codex = ps.find((p) => p.id === 'codex');
    const copilot = ps.find((p) => p.id === 'copilot');
    const wb = ps.find((p) => p.id === 'workbuddy');
    assert.strictEqual(codex.available, true);
    assert.strictEqual(codex.dir, path.join('/home', '.codex', 'skills'));
    assert.strictEqual(wb.available, true);
    assert.strictEqual(copilot.available, false);
  });
  test('清单含主流平台，id 唯一', () => {
    const ids = svc.PLATFORM_DEFS.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const must of ['codex', 'copilot', 'workbuddy', 'wiscode']) {
      assert.ok(ids.includes(must), '应含 ' + must);
    }
  });
});

describe('importSkill 导入（安全写入 + 备份）', () => {
  const src = '/proj/skills/pet-webm-pipeline';
  const srcFiles = {
    [src + '/SKILL.md']: '---\nname: pet-webm-pipeline\n---\n# 教程',
    [src + '/references/a.md']: 'ref-a',
  };

  test('首次导入：复制到 dest/<name>/，含子文件', () => {
    const io = makeFs({ ...srcFiles });
    const r = svc.importSkill(src, '/home/.codex/skills', 'pet-webm-pipeline', io, 1000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dest, path.join('/home', '.codex', 'skills', 'pet-webm-pipeline'));
    assert.strictEqual(r.backedUp, undefined);
    assert.strictEqual(io.store.get('/home/.codex/skills/pet-webm-pipeline/SKILL.md'), srcFiles[src + '/SKILL.md']);
    assert.strictEqual(io.store.get('/home/.codex/skills/pet-webm-pipeline/references/a.md'), 'ref-a');
  });

  test('重复导入：先把旧目录时间戳备份再覆盖', () => {
    const io = makeFs({
      ...srcFiles,
      '/home/.codex/skills/pet-webm-pipeline/SKILL.md': '旧版本',
      '/home/.codex/skills/pet-webm-pipeline/keep.txt': '其他文件',
    });
    const r = svc.importSkill(src, '/home/.codex/skills', 'pet-webm-pipeline', io, 4242);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.backedUp, path.join('/home', '.codex', 'skills', 'pet-webm-pipeline.bak-4242'));
    assert.strictEqual(io.store.get('/home/.codex/skills/pet-webm-pipeline.bak-4242/SKILL.md'), '旧版本');
    assert.strictEqual(io.store.get('/home/.codex/skills/pet-webm-pipeline/SKILL.md'), srcFiles[src + '/SKILL.md']);
  });

  test('绝不删除平台 skills 目录下的其他 skill', () => {
    const io = makeFs({
      ...srcFiles,
      '/home/.codex/skills/other-skill/SKILL.md': '别人的 skill',
    });
    svc.importSkill(src, '/home/.codex/skills', 'pet-webm-pipeline', io, 1);
    assert.strictEqual(io.store.get('/home/.codex/skills/other-skill/SKILL.md'), '别人的 skill');
  });

  test('非法名 / 源缺 SKILL.md 拒绝，且不写目标', () => {
    const io = makeFs({ ...srcFiles });
    const bad = svc.importSkill(src, '/home/.codex/skills', '../evil', io, 1);
    assert.strictEqual(bad.ok, false);
    const noSrc = svc.importSkill('/empty', '/home/.codex/skills', 'x', io, 1);
    assert.strictEqual(noSrc.ok, false);
    assert.strictEqual([...io.store.keys()].some((k) => k.startsWith('/home/.codex/skills/')), false);
  });
});

// ============ wiring 静态守卫 ============
describe('主进程接线（index.ts）静态守卫', () => {
  const src = read('src/main/index.ts');
  test('pet:open-skill 改为应用内窗口（不再系统浏览器打开 md）', () => {
    assert.match(src, /ipcMain\.handle\('pet:open-skill'[\s\S]{0,300}_showSkillsWindow\(\)/);
  });
  test('新增 skills 数据面 IPC', () => {
    for (const ch of ['skills:detail', 'skills:reference', 'skills:platforms', 'skills:import', 'skills:close']) {
      assert.ok(src.includes("'" + ch + "'"), '应注册 ' + ch);
    }
  });
  test('reference IPC 调 skillsService.readReference', () => {
    assert.match(src, /skillsService\.readReference/);
  });
  test('导入前检测平台可用 + 清洗 id + 调 skillsService', () => {
    assert.match(src, /detectPlatforms\(\)\.find/);
    assert.match(src, /skillsService\.sanitizeSkillName/);
    assert.match(src, /skillsService\.importSkill/);
  });
  test('引入 skills-service 模块', () => {
    assert.match(src, /require\('\.\/skills-service'\)/);
  });
});

describe('渲染层（skills-window.html）静态守卫', () => {
  const html = read('src/renderer/skills-window.html');
  test('监听 skills:init 并渲染列表/平台', () => {
    assert.match(html, /ipcRenderer\.on\('skills:init'/);
    assert.match(html, /renderSkills\(\)/);
    assert.match(html, /renderPlats\(\)/);
  });
  test('调用 detail / reference / import / close IPC', () => {
    assert.match(html, /invoke\('skills:detail'/);
    assert.match(html, /invoke\('skills:reference'/);
    assert.match(html, /invoke\('skills:import'/);
    assert.match(html, /send\('skills:close'\)/);
  });
  test('Markdown 渲染支持表格（表头/分隔行/数据行）', () => {
    assert.match(html, /function isSepRow\(/);
    assert.match(html, /function splitRow\(/);
    assert.ok(html.includes('<table><thead><tr>'), '生成 table HTML');
    assert.ok(html.includes('<tbody>'), '生成 tbody');
  });
  test('相对引用链接可点击 + 返回主文档', () => {
    assert.match(html, /data-ref=/);
    assert.match(html, /function showReference\(/);
    assert.match(html, /id="refBack"/);
  });
  test('Markdown 先转义防注入，外链走 open-external 白名单', () => {
    assert.match(html, /function esc\(/);
    assert.ok(html.includes(".replace(/&/g, '&amp;')"), 'HTML 转义实现存在');
    assert.match(html, /invoke\('open-external'/);
    assert.ok(html.includes('https?:\\/\\/'), '外链正则仅放行 http(s)');
  });
  test('平台卡片展示已安装状态 + 导入按钮', () => {
    assert.match(html, /已安装/);
    assert.match(html, /未安装/);
    assert.match(html, /data-imp/);
  });
  test('Esc / 关闭按钮可关闭窗口', () => {
    assert.match(html, /ev\.key === 'Escape'/);
    assert.match(html, /closeBtn/);
  });
});
