/**
 * theme.ts - 用户自定义主题色（2026-11-19）
 *
 * 需求：托盘菜单里让用户自定义主题色——提供 RGB 输入与预定义色号，
 * 改动即时应用到所有窗口（主面板 / 托盘浮窗 / 技能窗口 / 桌宠舞台）。
 *
 * 设计：
 *   - 持久化只存一个规范化的 #rrggbb 字符串（config.themeColor），null = 默认紫；
 *   - 派生色（hover / soft）由纯函数算，不落盘——规则改动即全量生效，无迁移负担；
 *   - 注入走 webContents.executeJavaScript 写 document.documentElement 的 CSS 变量，
 *     覆盖各窗口 :root 的硬编码默认值，无需改动每个 HTML（tray-menu/skills-window
 *     用 --brand 系，main.css 用 --accent 系，一次性两边都写）；
 *   - 无平台特定依赖（Windows/macOS/Linux 同构）。
 */

/** 默认主题色（与 main.css/tray-menu.html 的 :root 默认值一致） */
export const DEFAULT_ACCENT = '#6c5ce7';

export interface ThemePreset {
  name: string;
  hex: string;
}

/** 预定义色板（托盘菜单展示用；name 供 tooltip / 无障碍标签） */
export const THEME_PRESETS: ThemePreset[] = [
  { name: '暮光紫', hex: '#6c5ce7' },
  { name: '海蓝', hex: '#3b82f6' },
  { name: '青碧', hex: '#0ea5a5' },
  { name: '松绿', hex: '#22a06b' },
  { name: '暖橙', hex: '#f59e0b' },
  { name: '珊瑚红', hex: '#ef4444' },
  { name: '樱粉', hex: '#ec4899' },
  { name: '石墨', hex: '#64748b' },
];

export interface ThemeColors {
  accent: string;       // 主色（main.css --accent / tray --brand）
  accentHover: string;  // 提亮态
  accentSoft: string;   // 主色的低透明填充（rgba）
  brand: string;        // 托盘/技能窗口的 --brand（与 accent 同值）
  brandSoft: string;    // 托盘 --brand-soft
  hover: string;        // 托盘/技能窗口 --hover（低透明填充）
}

/**
 * 严格规范化外部输入的色号 → #rrggbb；非法一律返回 null（不猜、不吞错）。
 * 接受：#RGB / #RRGGBB / RRGGBB / rgb(r,g,b)；大小写不敏感。
 * 拒绝：命名色、带 alpha 的 rgba、越界通道、注入串。
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m) return '#' + m[1].toLowerCase();
  m = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (m) return '#' + m[1].split('').map((c) => c + c).join('').toLowerCase();
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
  if (m) {
    const parts = [m[1], m[2], m[3]].map(Number);
    if (parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
      return '#' + parts.map((v) => v.toString(16).padStart(2, '0')).join('');
    }
  }
  return null;
}

/** #rrggbb → [r,g,b]（normalizeHex 已保证形态，内部直解） */
export function rgbOf(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? DEFAULT_ACCENT;
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

/** 向白色混合 t（0..1）得到提亮色，保持色相、提升暗色背景上的可读性 */
function lighten(hex: string, t: number): string {
  return '#' + rgbOf(hex).map((c) => Math.round(c + (255 - c) * t)
    .toString(16).padStart(2, '0')).join('');
}

/**
 * 由用户色号派生全部 CSS 变量值。null / 非法 → 默认紫。
 * 提亮比例：accentHover 0.25（按钮 hover）、brandSoft 0.35（描边/图标）——
 * 与既有紫色默认值 #a29bfe 的观感接近。
 */
export function deriveTheme(input: string | null): ThemeColors {
  const hex = normalizeHex(input) ?? DEFAULT_ACCENT;
  const [r, g, b] = rgbOf(hex);
  // 默认色精确沿用既有令牌（#a29bfe），确保「未自定义」时外观零变化；
  // 自定义色才走统一 lighten 派生（原令牌并非单一提亮比例可复现）。
  const isDefault = hex === DEFAULT_ACCENT;
  return {
    accent: hex,
    accentHover: isDefault ? '#a29bfe' : lighten(hex, 0.25),
    accentSoft: `rgba(${r}, ${g}, ${b}, 0.2)`,
    brand: hex,
    brandSoft: isDefault ? '#a29bfe' : lighten(hex, 0.35),
    hover: `rgba(${r}, ${g}, ${b}, 0.09)`,
  };
}

/**
 * 生成注入脚本文本：在窗口 document 根元素上覆盖主题 CSS 变量。
 * 变量值全部来自 deriveTheme（只含 #hex 与 rgba 数字），无脚本注入面。
 */
export function themeInjectScript(colors: ThemeColors): string {
  const vars: Array<[string, string]> = [
    ['--accent', colors.accent],
    ['--accent-hover', colors.accentHover],
    ['--accent-soft', colors.accentSoft],
    ['--brand', colors.brand],
    ['--brand-soft', colors.brandSoft],
    ['--hover', colors.hover],
  ];
  const sets = vars.map(([k, v]) => `s.setProperty('${k}',${JSON.stringify(v)})`).join(';');
  return `(function(){var s=document.documentElement.style;${sets}})()`;
}
