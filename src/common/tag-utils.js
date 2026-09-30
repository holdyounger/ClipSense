/**
 * tag-utils.js - 自动打标签识别管线（纯本地规则，主进程/渲染进程共用）
 *
 * 规格：Docs/架构设计-自动打标签-2026-09-09.md §4；v2 扩展：Docs/产品方案-标签适配优化-2026-09-10.md §3
 * 硬规则：
 *   - 所有正则线性（无嵌套量词），防灾难性回溯；识别输入 64KB 截断
 *   - v2 性能三招（方案 §3.4，64KB 病态输入 1.77ms 实测）：栈帧行首锚定 /
 *     异常识别字面前缀分裂 / hex·base64 无上界贪婪 + \b 边界界定
 *   - 零进程通信、零联网引用（PRD 验收 6：打标 100% 本地）
 *   - 逐识别器 try/catch 隔离：单类失败只损失该类标签，不中断整体
 *   - link 识别复用 link-utils 的 extractLinks 结果，禁止另起 URL 判定
 *
 * 双端挂载沿 link-utils 惯例：module.exports / window.__clipSenseTagUtils
 */
(function () {
  'use strict';

  /** 识别输入截断上限 */
  const MAX_INPUT_LENGTH = 64 * 1024;
  /** 存储标签数上限（展示层再截 2；2026-09-10 v2 扩展 5→8，方案 §3.3，真实数据 0 条超 8） */
  const MAX_TAGS = 8;
  /** 展示优先级（识别执行顺序 ≠ 展示优先级）。
   *  v2 扩展为 12 类价值序：安全 > 漏洞 > 验证码 → 开发结构类 → 通用类 → 粗桶/路径。
   *  link 自 v1 第 1 降至第 9（拍板 #4：多标签条目下 ip/vuln/hash 信息量更高）。 */
  const TAG_PRIORITY = [
    'sensitive', 'vuln', 'otp', 'urlcred',
    'bankcard', 'idcard', 'tracking', 'phone',
    'cmd', 'stack', 'config', 'meeting', 'todo',
    'ip', 'hash', 'uuid', 'color', 'address',
    'link', 'email', 'snippet', 'path',
  ];

  // ==================== email ====================
  // local part 限 RFC 5321 上限 64：超长无 @ 文本（哈希/证书链）逐位回扫不超线性
  const RE_EMAIL = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

  // ==================== sensitive（高置信规则族，宁缺勿滥） ====================
  const RE_PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/;
  const RE_AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/;
  const RE_GITHUB_PAT = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/;
  const RE_OPENAI_KEY = /\bsk-[A-Za-z0-9]{20,}\b/;
  const RE_SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]+\b/;
  const RE_GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/;
  const RE_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
  const RE_BEARER = /\bBearer\s+[A-Za-z0-9._-]{20,}\b/;
  const RE_URL_CREDS = /:\/\/[^/\s:]+:[^/\s@]+@|[?&](?:token|key|secret|password|sig|sig2)=/i;
  // 命中候选后必须过 Luhn；分段格式（空格/连字符分隔）由第二分支覆盖
  const RE_CARD = /\b\d{13,19}\b|\b(?:\d{4}[ -]){3}\d{1,7}\b/g;
  // 密码赋值上下文：值排除空白与掩码符（* •）。
  // 2026-09-10 修复：补 /i（架构 §4.3 规格本就带 /i，v1 实现只有 /g，
  // PascalCase `Password=` 漏检——电池 sens-pwd 样本实证）
  const RE_PASSWORD_CTX = /(?:密码|password|passwd|pwd)\s*[:：=]\s*([^\s*•]{3,})/gi;
  // 占位值（<your-password>、[password]、xxxx、.... 等）不算真实凭据
  const RE_PLACEHOLDER_VALUE = /^(?:<[^<>]{0,64}>|\[[^\[\]]{0,64}\]|【[^【】]{0,64}】|x{3,}|X{3,}|\.{3,}|\?{3,})$/;

  // ==================== snippet（窄判定：强信号任一 或 弱信号 ≥2） ====================
  // S1：≥2 空格或 tab 的前导缩进
  const RE_INDENT_LINE_2 = /^[ \t]{2,}\S/;
  // W1：任意前导缩进
  const RE_INDENT_LINE_ANY = /^[ \t]+\S/;
  // W2：行首锚定代码关键字；行内还需出现代码形态字符（(){};=: 或数字），
  //     抵抗英文散文行首 if/for/while 的误命中（PRD 散文负例方向）
  const RE_CODE_KEYWORD_LINE = /^[ \t]*(?:function|const|let|var|class|def|import|export|return|if|for|while|public|private|async|await)\b[^\n]*[(){};=:0-9]/gm;
  // S3：SQL 关键词对（间隙 ≤300 字符，有界不灾难回溯）
  const SQL_PAIR_RES = [
    /\bSELECT\b[\s\S]{0,300}?\bFROM\b/i,
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\b[\s\S]{0,300}?\bSET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bCREATE\s+TABLE\b/i,
  ];
  // S4：命令行动词表（首 token 精确匹配）
  const CLI_VERBS = new Set([
    'git', 'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3', 'node',
    'docker', 'kubectl', 'ssh', 'scp', 'curl', 'wget', 'sudo', 'cd', 'ls', 'mkdir',
    'rm', 'cp', 'mv', 'chmod', 'grep', 'awk', 'sed', 'winget', 'choco',
  ]);
  const RE_ASCII_PRINTABLE = /^[\x20-\x7E]+$/;
  const RE_CLI_LINE = /^([A-Za-z0-9_-]+)[ \t]+(\S[\s\S]*)$/;

  // ==================== otp（三重门控：G1 snippet 未命中 / G2 ≤300 / 关键词+token 邻近） ====================
  const RE_OTP_KEYWORD = /验证码|校验码|动态码|验证代码|动态密码|短信口令|verification code|security code|one[- ]time (?:code|password)|\bpasscode\b|\botp\b|your code|\bcode\s*(?:is|:|：)/gi;
  const RE_OTP_TOKEN_DIGIT = /\b\d{4,8}\b/g;
  const RE_OTP_TOKEN_ALNUM = /\b[A-Za-z0-9]{5,8}\b/g;
  const RE_YEAR_SUFFIX = /^\s{0,2}年/;
  const CURRENCY_CHARS = '¥￥$€£';

  // ==================== v2 新增 7 类（2026-09-10 标签集扩展，方案 §3.2） ====================
  // 移植自 temp/tag-v2-validation-20260910/prototype-recognizers.js（电池 98.1% 命中实证），
  // 逐条按 §3.4 性能三招核对，见各类注释。

  // ---------- vuln 漏洞编号（高置信、零误报面） ----------
  // GHSA 后缀为 base32 字符集（无 0/1/8 等易混字符），有界 {4}×3
  const RE_VULN_ID = /\b(?:CVE|QVD|CNVD|CVD|DVB)-\d{4}-\d{3,8}\b|\b360V-\d{4}-\d{6,8}\b|\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/i;

  function detectVuln(text) {
    return RE_VULN_ID.test(text);
  }

  // ---------- ip 内网地址（仅三类高置信形态，裸公网 IP 不打，防版本号误报） ----------
  const RE_PRIVATE_IP = /\b(?:(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
  const RE_IP_PORT = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\b/;
  const RE_URL_HOST_IP = /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i;

  function detectIp(text) {
    return RE_PRIVATE_IP.test(text) || RE_IP_PORT.test(text) || RE_URL_HOST_IP.test(text);
  }

  // ---------- hash 哈希/指纹/编码 ----------
  // 性能三招之③：无上界贪婪 + \b 边界界定（单趟 O(n)）。
  // 禁用 {32,64} 型有界量词：长 hex 串上逐位回溯是 64KB 冒烟超预算根因之一。
  const RE_HEX_RUN = /\b[a-fA-F0-9]{32,}\b/;
  const RE_GUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
  const RE_HEX_BYTES = /\b(?:[0-9a-fA-F]{2}[ \t]){7,}[0-9a-fA-F]{2}\b/;
  // 无 lookaround、无上界：长 alnum run 一趟吃尽 O(n)；28 位下界的误报面由负例电池守住
  const RE_B64 = /[A-Za-z0-9+\/]{28,}/;

  function detectHash(text) {
    // 顺序即性能：单趟贪婪的 HEX_RUN/B64 先跑（长文本 O(n) 短路），带回溯成本的 GUID 最后
    return RE_HEX_RUN.test(text) || RE_B64.test(text) || RE_HEX_BYTES.test(text) || RE_GUID.test(text);
  }

  // ---------- path 文件路径（盘符 / UNC / 受限顶层目录 POSIX） ----------
  const RE_WIN_PATH = /\b[A-Za-z]:\\[^\r\n"']{2,200}/;
  const RE_UNC_PATH = /\\\\[\w.\-]{1,64}\\[^\r\n"']{1,200}/;
  // 边界界定（^ 或空白/引号/括号前）排除 URL 路径段（/usr 前是字母则不命中）
  const RE_POSIX_PATH = /(?:^|[\s"'(=<>])\/(?:usr|etc|var|opt|home|root|mnt|tmp|proc|srv|Users)(?:\/[\w.\-@+]{1,64}){1,12}/;

  function detectPath(text) {
    return RE_WIN_PATH.test(text) || RE_UNC_PATH.test(text) || RE_POSIX_PATH.test(text);
  }

  // ---------- cmd 命令行 ----------
  // 两档动词：safe（动词+任意非空参数即命中）/ risky（英文常用词，须有 flag/路径/重定向特征）
  const CLI_VERBS_SAFE = new Set([
    'git', 'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3', 'node',
    'deno', 'bun', 'docker', 'kubectl', 'helm', 'ssh', 'scp', 'sftp', 'curl', 'wget',
    'sudo', 'grep', 'rg', 'awk', 'sed', 'xargs', 'tee', 'diff', 'patch', 'tar', 'zip',
    'unzip', '7z', 'gzip', 'make', 'cmake', 'gcc', 'g++', 'clang', 'java', 'javac',
    'mvn', 'gradle', 'dotnet', 'csc', 'msbuild', 'vbc', 'svn', 'hg', 'powershell',
    'pwsh', 'wsl', 'cdb', 'ntsd', 'windbg', 'kd', 'dumpbin', 'objdump', 'nm', 'md5sum',
    'sha1sum', 'sha256sum', 'shasum', 'certutil', 'tasklist', 'taskkill', 'netstat',
    'ipconfig', 'ping', 'tracert', 'nslookup', 'systeminfo', 'whoami', 'hostname',
    'netsh', 'wmic', 'nohup', 'disown', 'pkill', 'apt', 'apt-get', 'yum', 'dnf',
    'brew', 'choco', 'winget', 'scoop', 'systemctl', 'mount', 'readlink', 'realpath',
  ]);
  const CLI_VERBS_RISKY = new Set([
    'cd', 'ls', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'chmod', 'chown',
    'find', 'head', 'tail', 'cat', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr',
    'file', 'strings', 'stat', 'du', 'df', 'umount', 'kill', 'ps', 'top', 'htop',
    'env', 'export', 'set', 'source', 'echo', 'printf', 'touch', 'basename', 'dirname',
    'sc', 'reg', 'dir', 'del', 'copy', 'move', 'type', 'ren', 'md5', 'service',
  ]);
  const RE_CLI_TAIL = /^([A-Za-z0-9_.+\-]+)[ \t]+(\S[\s\S]*)$/;
  const RE_PROMPT_PS = /^(?:PS\s+)?[A-Za-z]:\\[^>\n]{0,80}>\s*/;
  const RE_PROMPT_SHELL = /^\$\s*/;
  // PowerShell Verb-Noun 形态（无需动词表）
  const RE_CMDLET = /^[A-Z][a-z]+-[A-Z][A-Za-z0-9]+\b/;
  // risky 动词的佐证特征：flag / 盘符路径 / 受限 POSIX 顶层 / 分隔重定向符
  const RE_RISKY_TRIGGER = /(?:^|\s)(?:--?[A-Za-z][\w-]*|[A-Za-z]:\\|\/(?:usr|etc|var|opt|home|mnt|tmp|proc|Users)\b|[\\\/:=><|&;])/;

  /** 单行命令判定：返回 'cli' | 'prompt' | null */
  function classifyCliLine(line) {
    if (!line) return null;
    const t = line.trim();
    if (!t || t.length > 200) return null; // 超长行不可能是单条命令，直接跳过（线性保障）
    let rest = t;
    let isPrompt = false;
    const ps = RE_PROMPT_PS.exec(t);
    if (ps) { rest = t.slice(ps[0].length); isPrompt = true; }
    else {
      const sh = RE_PROMPT_SHELL.exec(t);
      if (sh) { rest = t.slice(sh[0].length); isPrompt = true; }
    }
    rest = rest.trim();
    if (RE_CMDLET.test(rest)) return 'cli';
    const m = RE_CLI_TAIL.exec(rest);
    if (!m) return isPrompt ? 'prompt' : null;
    const verb = m[1].toLowerCase();
    const args = m[2];
    if (CLI_VERBS_SAFE.has(verb)) return 'cli';
    if (CLI_VERBS_RISKY.has(verb) && RE_RISKY_TRIGGER.test(args)) return 'cli';
    return isPrompt ? 'prompt' : null;
  }

  function detectCmd(text) {
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    let cli = 0, prompt = 0;
    for (const l of lines) {
      const r = classifyCliLine(l);
      if (r === 'cli') cli++;
      else if (r === 'prompt') prompt++;
    }
    if (cli >= 2) return true;                       // 命令序列
    if (cli >= 1 && lines.length === 1) return true; // 单行命令
    if (cli >= 1 && prompt >= 1) return true;        // 提示符 + 命令
    if (prompt >= 2) return true;                    // 纯提示符/交互记录
    return false;
  }

  // ---------- stack 堆栈/日志 ----------
  // 性能三招之①：栈帧/日志/调试器正则一律行首锚定（^ + m）——
  // 裸扫时 \w{0,63} 型贪婪回溯会在长文本上 O(64n)（64KB 冒烟 11ms 超预算根因）。
  const RE_AT_FRAME = /^[ \t]{0,8}at\s+[\w$.<>`\\/:]+(?:\s*\(|:\d)/gm;
  const RE_BANG_FRAME = /^[ \t]*[A-Za-z_]\w{0,63}![\w.]{1,96}\+0x[0-9a-fA-F]{1,16}\b/gm;
  const RE_MODOFF_LINE = /^[ \t]*[A-Za-z_][\w.-]{1,47}\+0x[0-9a-fA-F]{2,16}[ \t]*$/gm;
  // 性能三招之②：异常识别字面前缀分裂——限定 System./java.lang. 前缀 + 有界中段，
  // 避免 [\w$.]{0,64}Exception 逐位回溯；裸 Exception: 为弱信号（仍需 ≥1 栈帧才命中）
  const RE_EXCEPTION_QUALIFIED = /\b(?:System|java\.lang)\.[\w.]{1,64}(?:Exception|Abort)\b/;
  const RE_EXCEPTION_BARE = /\bException:/;
  const RE_WINDBG_PROMPT = /^[ \t]*\d{1,4}:\d{3}>[ \t]*\S+/gm;
  const RE_LOG_LINE = /^[ \t]*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?[ \t]+\S+.*\b(?:ERROR|FATAL|WARN|INFO|DEBUG|TRACE)\b/gim;
  const RE_LOG_TIME = /^[ \t]*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/gm;

  /** 带上限的匹配计数（cap 后提前返回，长日志不超线性） */
  function countMatches(re, text, cap) {
    re.lastIndex = 0;
    let n = 0, m;
    while ((m = re.exec(text)) !== null) {
      n++;
      if (n >= cap) return cap;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return n;
  }

  function detectStack(text) {
    const atFrames = countMatches(RE_AT_FRAME, text, 3);
    const bangFrames = countMatches(RE_BANG_FRAME, text, 3);
    const modOff = countMatches(RE_MODOFF_LINE, text, 3);
    const frames = atFrames + bangFrames + modOff;
    const windbg = countMatches(RE_WINDBG_PROMPT, text, 3);
    const logLevelLines = countMatches(RE_LOG_LINE, text, 3);
    const logTimeLines = countMatches(RE_LOG_TIME, text, 3);
    const hasException = RE_EXCEPTION_QUALIFIED.test(text) || RE_EXCEPTION_BARE.test(text);

    if (frames >= 2) return true;                    // ≥2 栈帧
    if (windbg >= 2) return true;                    // 调试器交互记录
    if (logLevelLines >= 2) return true;             // ≥2 条带级别日志
    if (hasException && frames >= 1) return true;    // 异常类型 + 栈帧
    if (frames >= 1 && (windbg >= 1 || logLevelLines >= 1)) return true;
    if (logTimeLines >= 3 && logLevelLines >= 1) return true; // 多行时间戳日志
    return false;
  }

  // ---------- config 配置文件 ----------
  const RE_INI_SECTION = /^[ \t]*\[[\w.\-]{1,64}\][ \t]*$/m;
  const RE_KV_LINE = /^[ \t]*[\w.$\-]{1,64}[ \t]*[:=][ \t]*\S{1,80}(?:[ \t]+\S{1,80}){0,4}[ \t]*$/gm;
  const RE_YAML_KEY_EMPTY = /^[ \t]*[\w.\-]{1,64}:[ \t]*$/gm;
  const RE_INDENT_ANY = /^[ \t]+\S/m;
  // JSON 片段：补 v1 JSON.parse 对截断片段的盲区（完整 JSON 由 snippet S2 覆盖，重叠无害）
  const RE_JSON_FRAGMENT = /"[^"\n]{1,64}"[ \t]*:[ \t]*(?:"[^"\n]*"|[\-0-9.{\[tfn])/g;

  function detectConfig(text) {
    if (RE_INI_SECTION.test(text)) return true;
    if (countMatches(RE_JSON_FRAGMENT, text, 2) >= 2) return true;
    if (countMatches(RE_KV_LINE, text, 3) >= 3) return true;                    // INI/属性 k=v 行
    if (countMatches(RE_YAML_KEY_EMPTY, text, 2) >= 2 && RE_INDENT_ANY.test(text)) return true; // YAML 键树
    return false;
  }

  /** Luhn 校验（纯函数，无依赖）。入参为纯数字串。 */
  function luhnCheck(digits) {
    if (!/^\d{2,}$/.test(digits)) return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /** 惰性取 extractLinks（CommonJS 直接 require；浏览器走 window 挂载） */
  // ==================== v1.0.7 通用化 10 类（2026-09-30 PRD §2） ====================
  // 纪律：强特征正则/结构化校验，误报率目标 <1%，宁可漏打不打错；单遍 O(n)。

  /** 去分隔符：数字类识别前统一剥掉空格/横线（卡号/单号/证件号的常见书写变体） */
  function stripDigitsSep(s) {
    return String(s).replace(/[ -]/g, '');
  }

  /** tracking 快递单号：前缀白名单 + 长度（PRD §2.1 tracking 行） */
  const RE_TRACKING = /\b(SF\d{12,16}|YT\d{13,16}|JD\d{13,16}|JDVE\d{11,13}|EMS\d{13}|9[0-9]{12,16})\b/;

  /** phone：中国大陆手机号，容忍 +86/86 前缀；前后非数字（避免从长串里截取） */
  const RE_PHONE = /(?:\+?86[- ]?)?\b1[3-9]\d{9}\b/;

  /** idcard：仅 18 位（含 X 校验位），15 位旧号不启用（PRD §2.1 误报决策） */
  const RE_IDCARD_RAW = /\b\d{17}[\dXx]\b/;

  /** uuid：8-4-4-4-12 标准十六进制（大小写不敏感） */
  const RE_UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;

  /** color：#hex（3/4/6/8 位）或 rgb/rgba/hsl 完整语法 */
  const RE_COLOR = /(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\brgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+)\s*)?\)|\bhsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\))/;

  /** urlcred：账号/密码凭据键值对（对齐 otp 邻近窗口思路：键与值同段共现） */
  const RE_URLCRED_PAIR = /(?:账号|帐号|用户名|password|passwd|pwd|密码)\s*[:：=]\s*\S{3,}/i;

  /** meeting：时间词 + 会议动词同段共现（120 字符窗口内） */
  // 时刻收紧（neg-prose-zh 误报教训）：裸日期词（明天/周X/X月X日）在叙事文本里是
  // 高频词，单独出现不算时间点——必须与「X点/X:XX」显式时刻结构之一共现
  const RE_MEETING_DAY = /(周[一二三四五六日天]|明天|后天|今天|\d{1,2}月\d{1,2}[日号]?)/;
  const RE_MEETING_CLOCK = /(\b\d{1,2}:\d{2}\b)|[上午下午]?\s*[零一二三四五六七八九十两点]+\s*点(?:\s*[零一二三四五六七八九十]+分)?/;
  const RE_MEETING_VERB = /开会|会议(?!室)|评审|例会|复盘|站会|面试|meeting|review|standup|call|interview/i; /* 会议(?!室)：排除「会议室」场所词 */

  /** todo：行首勾选/待办符号或清单结构 */
  const RE_TODO_MARK = /(?:^|\n)\s*(?:-\s*\[ \]|\[ \]|TODO[:：]|待办[:：]|TODO\b)/;
  const RE_TODO_LIST = /(?:^|\n)\s*\d+[.、)]\s*\S+(?:\n\s*\d+[.、)]\s*\S+){1,}/;

  /** address：省/市开头 + ≥2 个地址关键词 + 长度 ≥10 */
  const RE_ADDRESS_HEAD = /[\u4e00-\u9fa5]{2,8}?(?:省|自治区|市)/;
  const RE_ADDRESS_PARTS = /(?:[\u4e00-\u9fa5]{2,8}?(?:省|市|自治区))[　\s]*(?:[\u4e00-\u9fa5]{2,8}?(?:市|区|县|州|盟))?[　\s]*(?:[\u4e00-\u9fa5]{2,10}?(?:路|街|巷|道|镇|乡))?[\u4e00-\u9fa50-9]*(?:号|栋|幢|号楼|单元|室|层|座)/;

  /** GB 11643 身份证校验位（18 位） */
  const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const ID_CHECK = { 0: '1', 1: '0', 2: 'X', 3: '9', 4: '8', 5: '7', 6: '6', 7: '5', 8: '4', 9: '3', 10: '2' };

  function isValidIdCard18(raw) {
    const id = stripDigitsSep(raw).toUpperCase();
    if (!/^\d{17}[\dX]$/.test(id)) return false;
    // 省份码粗校验（1-6 开头为合法省级行政区划首位的超集）
    if (!/^[1-6]/.test(id)) return false;
    // 出生日期合理性
    const y = +id.slice(6, 10), mo = +id.slice(10, 12), d = +id.slice(12, 14);
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    // GB 11643 加权校验
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(id[i]) * ID_WEIGHTS[i];
    return ID_CHECK[sum % 11] === id[17];
  }

  /** 银行卡候选提取：13-19 位数字段（容忍空格/横线分隔变体） */
  const RE_BANKCARD_RAW = /\b(?:\d[ -]?){12,18}\d\b/g;

  /** 银行卡：先提取候选片段，去分隔符后 13-19 位 + Luhn（两步模式，同 idcard） */
  function isBankCard(text) {
    RE_BANKCARD_RAW.lastIndex = 0;
    let m;
    while ((m = RE_BANKCARD_RAW.exec(text)) !== null) {
      const digits = stripDigitsSep(m[0]);
      if (/^\d{13,19}$/.test(digits) && luhnCheck(digits)) return true;
    }
    return false;
  }

  function detectTracking(text) {
    return RE_TRACKING.test(text);
  }

  function detectPhone(text) {
    return RE_PHONE.test(text);
  }

  function detectIdCard(text) {
    const m = text.match(RE_IDCARD_RAW);
    if (!m) return false;
    return isValidIdCard18(m[0]);
  }

  function detectUuid(text) {
    return RE_UUID.test(text);
  }

  function detectColor(text) {
    return RE_COLOR.test(text);
  }

  function detectUrlCred(text) {
    return RE_URLCRED_PAIR.test(text);
  }

  function detectMeeting(text) {
    // 双条件：日期词 + 显式时刻（HH:MM 或「X点」）——只有日期或只有时刻不判
    return RE_MEETING_DAY.test(text) && RE_MEETING_CLOCK.test(text) && RE_MEETING_VERB.test(text);
  }

  function detectTodo(text) {
    return RE_TODO_MARK.test(text) || RE_TODO_LIST.test(text);
  }

  function detectAddress(text) {
    if (text.length < 10) return false;
    return RE_ADDRESS_HEAD.test(text) && RE_ADDRESS_PARTS.test(text);
  }

  function getExtractLinks() {
    try {
      if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
        const m = require('./link-utils');
        if (m && typeof m.extractLinks === 'function') return m.extractLinks;
      }
    } catch (err) { /* fallthrough */ }
    if (typeof window !== 'undefined' && window.__clipSenseLinkUtils &&
        typeof window.__clipSenseLinkUtils.extractLinks === 'function') {
      return window.__clipSenseLinkUtils.extractLinks;
    }
    return null;
  }

  /** 设置归一化：缺省视为全开；语义 = AND(总开关, 单项) */
  function normalizeEnabled(settings) {
    const s = (settings && typeof settings === 'object') ? settings : null;
    const masterOn = !s || s.enabled !== false;
    const per = (s && s.tags && typeof s.tags === 'object') ? s.tags : {};
    const on = (id) => masterOn && per[id] !== false;
    return {
      sensitive: on('sensitive'),
      vuln: on('vuln'),
      otp: on('otp'),
      cmd: on('cmd'),
      stack: on('stack'),
      config: on('config'),
      ip: on('ip'),
      hash: on('hash'),
      link: on('link'),
      email: on('email'),
      snippet: on('snippet'),
      path: on('path'),
      // v1.0.7 通用化 10 类（2026-09-30 PRD §2，默认全开可关）
      urlcred: on('urlcred'),
      bankcard: on('bankcard'),
      idcard: on('idcard'),
      tracking: on('tracking'),
      phone: on('phone'),
      meeting: on('meeting'),
      todo: on('todo'),
      uuid: on('uuid'),
      color: on('color'),
      address: on('address'),
    };
  }

  /**
   * sensitive 识别：高置信规则族任一命中即 true
   * 信用卡候选逐个过 Luhn；密码赋值上下文排除掩码/占位值
   */
  function detectSensitive(text) {
    if (RE_PEM_KEY.test(text)) return true;
    if (RE_AWS_KEY.test(text)) return true;
    if (RE_GITHUB_PAT.test(text)) return true;
    if (RE_OPENAI_KEY.test(text)) return true;
    if (RE_SLACK_TOKEN.test(text)) return true;
    if (RE_GOOGLE_KEY.test(text)) return true;
    if (RE_JWT.test(text)) return true;
    if (RE_BEARER.test(text)) return true;
    if (RE_URL_CREDS.test(text)) return true;

    // 信用卡：候选数字段逐个过 Luhn（任一通过即命中）
    RE_CARD.lastIndex = 0;
    let m;
    while ((m = RE_CARD.exec(text)) !== null) {
      if (luhnCheck(m[0].replace(/[ -]/g, ''))) return true;
      if (m.index === RE_CARD.lastIndex) RE_CARD.lastIndex++; // 防零宽循环（防御性）
    }

    // 密码赋值上下文：排除全掩码值与占位值
    RE_PASSWORD_CTX.lastIndex = 0;
    while ((m = RE_PASSWORD_CTX.exec(text)) !== null) {
      const val = m[1].trim();
      if (val.length >= 3 && !/^[*•]+$/.test(val) && !RE_PLACEHOLDER_VALUE.test(val)) {
        return true;
      }
      if (m.index === RE_PASSWORD_CTX.lastIndex) RE_PASSWORD_CTX.lastIndex++;
    }
    return false;
  }

  /** S4 命令行：单行 ≤120 字符、首 token 精确等于动词、其余 ASCII 可打印且非空 */
  function detectCliLine(line) {
    if (!line || line.length > 120) return false;
    const m = RE_CLI_LINE.exec(line);
    if (!m) return false; // 独立词 npm（无参数）不打标
    if (!CLI_VERBS.has(m[1])) return false;
    const rest = m[2].trim();
    return rest.length > 0 && RE_ASCII_PRINTABLE.test(rest);
  }

  /** snippet 识别（窄判定） */
  function detectSnippet(text) {
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    const trimmed = text.trim();

    // S1 多行且 ≥2 行有前导缩进（≥2 空格或 tab）
    if (lines.length >= 2) {
      let indented2 = 0;
      for (const l of lines) {
        if (RE_INDENT_LINE_2.test(l)) indented2++;
        if (indented2 >= 2) return true;
      }
    }

    // S2 JSON（try/catch 成本低、判定准）
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return true;
      } catch (err) { /* 非 JSON，继续 */ }
    }

    // S3 SQL 关键词对
    for (const re of SQL_PAIR_RES) {
      if (re.test(text)) return true;
    }

    // S4 命令行（仅单行文本）
    if (lines.length === 1 && detectCliLine(trimmed)) return true;

    // S5 单行内同时含 { 和 } 且含 ; 或 =>
    for (const l of lines) {
      if (l.includes('{') && l.includes('}') && (l.includes(';') || l.includes('=>'))) {
        return true;
      }
    }

    // 弱信号（≥2 才命中）
    let weak = 0;

    // W1 行首缩进行 ≥1 且总行数 ≥3
    if (lines.length >= 3) {
      for (const l of lines) {
        if (RE_INDENT_LINE_ANY.test(l)) { weak++; break; }
      }
    }

    // W2 行首代码关键字 ≥2 次
    RE_CODE_KEYWORD_LINE.lastIndex = 0;
    let kwCount = 0;
    while (RE_CODE_KEYWORD_LINE.exec(text) !== null) {
      kwCount++;
      if (kwCount >= 2) break;
    }
    if (kwCount >= 2) weak++;

    // W3 以分号结尾的行 ≥2
    let semiLines = 0;
    for (const l of lines) {
      if (/;\s*$/.test(l)) semiLines++;
      if (semiLines >= 2) break;
    }
    if (semiLines >= 2) weak++;

    // W4 括号对与换行共存
    const hasParenPair = (text.includes('(') && text.includes(')')) ||
      (text.includes('{') && text.includes('}')) ||
      (text.includes('[') && text.includes(']'));
    if (hasParenPair && text.includes('\n')) weak++;

    return weak >= 2;
  }

  /**
   * 在邻近窗口内找第一个通过排除项的 token。
   * 排除：紧随「年」的年份（跳过取下一个）、货币符号前缀（金额）。
   * 说明：HH:MM 由 token 形态天然排除（\b\d{4,8}\b 无法跨「:」匹配，
   * 且时/分仅 2 位不满足 4 位下界）；11 位手机号被词边界天然排除。
   */
  function findOtpToken(windowText) {
    const cands = [];
    RE_OTP_TOKEN_DIGIT.lastIndex = 0;
    let m;
    while ((m = RE_OTP_TOKEN_DIGIT.exec(windowText)) !== null) {
      cands.push({ tok: m[0], idx: m.index });
      if (m.index === RE_OTP_TOKEN_DIGIT.lastIndex) RE_OTP_TOKEN_DIGIT.lastIndex++;
    }
    RE_OTP_TOKEN_ALNUM.lastIndex = 0;
    while ((m = RE_OTP_TOKEN_ALNUM.exec(windowText)) !== null) {
      const tok = m[0];
      if (/[0-9]/.test(tok) && /[A-Za-z]/.test(tok)) {
        cands.push({ tok, idx: m.index });
      }
      if (m.index === RE_OTP_TOKEN_ALNUM.lastIndex) RE_OTP_TOKEN_ALNUM.lastIndex++;
    }
    cands.sort((a, b) => (a.idx - b.idx) || (b.tok.length - a.tok.length));
    for (const c of cands) {
      const after = windowText.slice(c.idx + c.tok.length, c.idx + c.tok.length + 3);
      if (RE_YEAR_SUFFIX.test(after)) continue; // 年份：跳过取下一个
      if (c.idx > 0 && CURRENCY_CHARS.includes(windowText[c.idx - 1])) continue; // 金额
      return true;
    }
    return false;
  }

  /** otp 识别：三重门控 + 关键词邻近窗口（前 24 / 后 48 字符） */
  function detectOtp(text, snippetHit) {
    if (snippetHit) return false;          // G1
    if (text.length > 300) return false;   // G2（trim 后短文本）
    RE_OTP_KEYWORD.lastIndex = 0;
    let kw;
    while ((kw = RE_OTP_KEYWORD.exec(text)) !== null) {
      const start = Math.max(0, kw.index - 24);
      const end = Math.min(text.length, kw.index + kw[0].length + 48);
      if (findOtpToken(text.slice(start, end))) return true;
      if (kw.index === RE_OTP_KEYWORD.lastIndex) RE_OTP_KEYWORD.lastIndex++;
    }
    return false;
  }

  /**
   * 自动打标签主入口（同步纯函数）
   * @param {string} text 条目文本
   * @param {Object} [options]
   * @param {string[]|null} [options.links] 已算好的 extractLinks 结果；undefined 时内部补算
   * @param {{enabled: boolean, tags: Object<string, boolean>}} [options.enabled]
   *        设置对象；缺省视为全开。disabled 类直接跳过识别。
   * @returns {string[]|null} 按 TAG_PRIORITY 排序的标签数组；无命中/无可识别文本返回 null
   */
  function computeTags(text, options = {}) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null; // 空串/纯空白不打标
    const input = text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text;
    const t0 = input.trim();
    if (!t0) return null;

    const enabled = normalizeEnabled(options.enabled);
    const hits = [];
    const add = (id) => { if (!hits.includes(id)) hits.push(id); };

    // ① link —— 复用 extractLinks 结果（传入值权威：null = 已算、无链接）
    if (enabled.link) {
      try {
        let links = options.links;
        if (links === undefined) {
          const extract = getExtractLinks();
          links = extract ? extract(input) : null;
        }
        if (Array.isArray(links) && links.length > 0) add('link');
      } catch (err) { /* 单识别器隔离 */ }
    }

    // ② email（无 @ 直接跳过：超长无 @ 文本避免逐位回扫）
    if (enabled.email) {
      try {
        if (t0.includes('@') && RE_EMAIL.test(t0)) add('email');
      } catch (err) { /* 单识别器隔离 */ }
    }

    // ③ sensitive
    if (enabled.sensitive) {
      try {
        if (detectSensitive(t0)) add('sensitive');
      } catch (err) { /* 单识别器隔离 */ }
    }

    // ④ snippet
    let snippetHit = false;
    if (enabled.snippet) {
      try {
        snippetHit = detectSnippet(input);
        if (snippetHit) add('snippet');
      } catch (err) { /* 单识别器隔离 */ }
    }

    // ⑤ otp（G1 = snippet 未命中；G2 = ≤300）
    if (enabled.otp) {
      try {
        if (detectOtp(t0, snippetHit)) add('otp');
      } catch (err) { /* 单识别器隔离 */ }
    }

    // ⑥⑦ v2 新增 7 类（2026-09-10，方案 §3.2）：与既有 5 类并列，逐个 try/catch 隔离。
    // 执行顺序按成本排列：单正则的 vuln/ip/hash/path 先跑，逐行扫描的 cmd/stack/config 后跑。
    if (enabled.vuln) {
      try { if (detectVuln(t0)) add('vuln'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.ip) {
      try { if (detectIp(t0)) add('ip'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.hash) {
      try { if (detectHash(t0)) add('hash'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.path) {
      try { if (detectPath(t0)) add('path'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.cmd) {
      try { if (detectCmd(input)) add('cmd'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.stack) {
      try { if (detectStack(input)) add('stack'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.config) {
      try { if (detectConfig(input)) add('config'); } catch (err) { /* 单识别器隔离 */ }
    }

    // ⑧ v1.0.7 通用化 10 类（2026-09-30 PRD §2）：与既有类并列，逐个 try/catch 隔离。
    // 顺序按成本排列：单正则的 urlcred/bankcard/idcard/tracking/phone/uuid/color 先跑，
    // 组合正则的 meeting/todo/address 后跑。
    if (enabled.urlcred) {
      try { if (detectUrlCred(t0)) add('urlcred'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.bankcard) {
      try { if (isBankCard(input)) add('bankcard'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.idcard) {
      try { if (detectIdCard(input)) add('idcard'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.tracking) {
      try { if (detectTracking(input)) add('tracking'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.phone) {
      try { if (detectPhone(input)) add('phone'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.uuid) {
      try { if (detectUuid(input)) add('uuid'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.color) {
      try { if (detectColor(input)) add('color'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.meeting) {
      try { if (detectMeeting(input)) add('meeting'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.todo) {
      try { if (detectTodo(input)) add('todo'); } catch (err) { /* 单识别器隔离 */ }
    }
    if (enabled.address) {
      try { if (detectAddress(input)) add('address'); } catch (err) { /* 单识别器隔离 */ }
    }

    // 聚合：按展示优先级排序、去重、截断至 MAX_TAGS；空集返回 null
    const ordered = TAG_PRIORITY.filter(id => hits.includes(id)).slice(0, MAX_TAGS);
    return ordered.length > 0 ? ordered : null;
  }

  const api = {
    computeTags, luhnCheck, MAX_INPUT_LENGTH, MAX_TAGS, TAG_PRIORITY,
    // v2 新增识别器单独导出（测试/诊断用；computeTags 内部已带隔离与 enabled 门控）
    detectVuln, detectCmd, detectStack, detectConfig, detectIp, detectHash, detectPath,
    // v1.0.7 通用化识别器单独导出（测试/诊断用）
    detectUrlCred, isBankCard, detectIdCard, detectTracking, detectPhone,
    detectMeeting, detectTodo, detectUuid, detectColor, detectAddress,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.__clipSenseTagUtils = api;
  }
})();
