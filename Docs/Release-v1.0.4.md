# ClipSense v1.0.4 Release Note

发布日期：2026-09-20

本版本聚焦**自升级能力（GitHub Releases 链路）**与**一批实机体验修复**：弹出闪烁根治、磁吸辉光、重复内容计数、搜索结果条目交互修复。测试基线 258 → 432 条，全量绿。

## ✨ 新特性

### 自升级（GitHub Releases，零新增运行时依赖）
- 面板菜单「检查更新」三态：检查中… → 下载升级 vX.Y.Z → 下载中 N% → 拉起安装器；
  托盘同步提供「检查更新」入口（balloon 通知反馈）
- `src/main/updater.js` 轻量升级链路：semver 三段比较（自实现，不引 semver 库）、
  NSIS 安装包识别（`ClipSense*Setup*.exe`）、流式下载 + 进度上报、静默安装（`/S` + detached + 退出）
- **403 限流降级**：未认证 GitHub API 配额仅 60 次/h/IP，耗尽后自动切换
  `releases.atom` 无配额通道解析最新版本（HTML 兜底），检测不因限流不可用
- 无更新时菜单项显示「当前已是最新版本」，3 秒后恢复
- i18n 中英文案齐备；preload 三通道桥接 + 下载进度订阅

### 磁吸辉光（dock 方案 A）
- 光标沿列表纵向移动时，邻近条目**左右两缘**浮出紫色 accent bar，
  亮度/露出高度按「光标 Y ↔ 条目中心距离」余弦窗连续衰减；移出后平滑回落
- JS 每帧只写一个 CSS 变量 `--dock-i`，文本零变形；容器委托（innerHTML 全量重建不丢监听）；
  `prefers-reduced-motion` 全程 no-op
- 调参集中在 `dock-anim.js` 的 `DOCK_DEFAULTS`（radius 140 / restEase 0.2）

### 重复内容计数
- 同一剪贴板内容再次被复制 → 条目 meta 行尾部显示 `×N`（≥2 次才出现），
  悬停显示「此内容已复制 N 次」（中英）
- 语义对齐 Ditto/CopyQ：面板内复制/双击粘贴走回写抑制**不计次**，只有剪贴板层新复制才递增
- 计数随条目持久化，重启保留；旧数据无字段自动兼容（首个重复从 ×2 起算）

## 🐛 问题修复

### 主面板弹出闪烁 + 动画不流畅（根治）
- 根因：`executeJavaScript('prepare')` 的 Promise resolve ≠ 渲染层已绘制提交一帧，
  `showInactive()` 首帧可能是空白/未变换表面；16ms 定时器触发滑入与实际帧不对齐
- 修复（paint-verified show）：prepare 返回「双 rAF + 强制 reflow」绘制确认后才显示窗口；
  滑入触发改双 rAF 与实际帧对齐；代际令牌封死异步链期间重入；
  `backgroundThrottling: false` 保证隐藏态 rAF 不被冻结
- 附带移除显示路径的 1px 窗口抖动（transparent 窗口可见态 setBounds 触发 DWM
  表面重分配，本身就是闪烁源）

### 搜索结果条目无法点击展开/复制
- 根因：点击条目 mousedown → 输入框 blur → 收起清词同步重建列表 → mouseup 时
  原按钮已销毁，click 不再派发到条目处理器
- 修复：列表内 mousedown 阻止默认聚焦转移（与搜索图标同款模式），
  收起由 click-outside 处理器在条目处理器之后执行，「收起即清词」规则不变

### 升级通知图标模糊
- 根因两层：`displayBalloon` 不传 icon 时 Windows 取托盘 16×16 小图放大；
  `iconType:'info'` 会用系统信息图标覆盖自定义 icon（`custom` 才消费 icon 参数）
- 修复：显式传高清 `app-icon.png` + `iconType: 'custom'`

## 🧪 测试与工程

- 新增六套测试文件：tag-search（22）/ entry-anim（40）/ trigger-anim（18）/
  dock-anim（12）/ copy-count（4）/ updater（31）；search-ux 扩至 45 条
- 全量 **432 / 432 绿**（node --test 逐文件指定）
- `focus-debug` 临时诊断埋点清理（主进程 3 处 + 渲染层 2 处），守护测试反转为「埋点不存在」
- 测试夹具内网 IP 脱敏（10.18.132.214 → 192.168.10.20）

## 📦 工程与发布流程

- **CI 版本同步**：tag `v*` 触发时自动把 tag 名剥 `v` 写回 `package.json`——
  修复「Release 页面挂 0.1.0 安装包」的 tag/产物版本脱节（electron-builder 只认 package.json）
- **CI 语法检查清单补齐**：updater/trigger-anim 及渲染层 spring/entry/dock 动画模块
- **Docs 白名单出库**：默认本地（调研/测试报告/设计稿），仅 `Release-*.md` 同步远程；
  安装包不再打包 Docs
- version 1.0.3 → 1.0.4

## ⚠️ 已知事项

- 升级链路**未做安装包签名/哈希校验**（TLS 是唯一完整性保障）；后续可校验 release
  附带的 sha512 或启用代码签名
- 下载不支持断点续传；无自动定时检查（手动触发）
- GitHub API 未认证限流 60 次/h/IP（403 已有降级通道，降级路径拿不到 releaseNotes）
- 搜索框标签自动补全（Tab/浮层）仍为预留 TODO

## 📌 升级说明

- 无破坏性变更，历史数据与配置完全兼容
- 本版本起可使用应用内「检查更新」完成后续升级（v1.0.4 是首个带自升级能力的版本）
- 发布锚点：git tag `v1.0.4`（package.json version 已同步）

---

*发布日期：2026-09-20 · 爪爪（Zhuazhua）*
