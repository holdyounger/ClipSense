# ClipSense v1.0.6 Release Note

发布日期：2026-09-30

本版本聚焦**自动升级体验闭环**（自动重启 + 全程反馈）与 **UI 细节打磨**（header 缩减档/按钮两态/辅助行中置）。测试基线 521 → 530 条，全量绿。

## ✨ 新特性

### 升级自动重启（消除「装完没反应」体验断点）
- v1.0.5 实测升级成功但静默无感知——NSIS 静默模式无完成提示，新版本装好后不自动启动
- 修复（VS Code/Slack 同款）：应用退出前 spawn detached 的 cmd 重启脚本——轮询等待
  安装器进程退出（上限 120s）后自动拉起新版本，全程无需手动干预
- 升级流程每步 balloon 反馈：「开始下载…（完成后将自动安装并重启）」→「正在静默安装…
  完成后将自动重启」

### Header 缩减档与按钮两态
- header 静止 40→32px、悬停展开 68→60px（高度差保持 28，FLIP 补偿与断言零影响）
- 右上三键随 header 两态缩放：静止 20×20（圆角 5）/ 悬停恢复 24×24（圆角 6）；
  图标与倒计时数字同步缩放；倒计时环 viewBox 自适应，进度语义不变

### 辅助行常驻行中置
- 「共 N 条 · 上次复制时间」移入 header 行中部常驻显示（绝对定位真居中，不再仅 hover 可见）
- 搜索展开时淡出让位（输入框占满行中部）；`pointer-events: none` 不挡交互；超长省略号截断

## 🐛 问题修复

### 贴边抽屉动画失效（根治）
- 症状：面板贴边收起后复制内容，贴边触发条的抽屉动画不再播放
- 根因：v1.0.4 的 `backgroundThrottling: false` 使 `document.visibilityState` 恒
  `'visible'`——贴边动画 gate 依赖 `visibilityState === 'hidden'` 判定贴边态，从此永不进入
- 修复：可见性源迁移——主进程 `isWindowVisible` 为唯一权威（`setOnVisibilityChanged`
  回调 + `window:visibility` 频道），渲染层贴边 gate 与重显动作（筛选重置/搜索态恢复/
  贴边补播）全部迁移到权威信号
- 取证方式：userData 落盘诊断日志（五站埋点），复现一次即锁定「数据源到达、gate 零放行」

### 透明度三问题（固定模式 footer/backtop/计数重复）
- 固定模式 footer 不透明：`.footer` 背景消费 `--win-alpha`
- backtop 按钮透明适配：背景/border `calc(0.85|0.4 × --win-alpha)`，hover 同步
- footer 计数与 headerMeta 重复：移除 footer 统计行，计数唯一展示位收敛为 header 辅助行
  （同步清理 JS 引用，防 DOM 删除后残留 TypeError）

## 🧪 测试与工程

- 新增三套测试：header-hover（50 条）+ wiring（含 G 组可见性迁移/I 组透明度覆盖收敛/
  H 组 footer 压缩锚定）+ window-opacity（10 条）；全量 **530 / 530 绿**（521 → 530）
- pulse-diag 五站诊断埋点完成使命后全部移除；v1.0.4 文档误损坏已还原

## ⚠️ 已知事项 / 行为变化

- **透明度为渲染层 CSS alpha**：header/列表/提示条随窗口状态衰减，文字/图标/搜索框保持
  全不透明；**悬停条目恢复 100%**（渲染层 alpha 架构特有能力，原生 setOpacity 无法实现）
- 升级链路无签名/哈希校验（同 v1.0.4/1.0.5）；下载不支持断点续传
- 底部统计行已移除，条数统计唯一展示位为 header 辅助行

## 📌 升级说明

- 无破坏性变更，历史数据与配置完全兼容
- **从 v1.0.4/v1.0.5 升级后，本版本起的后续升级将全自动重启**（v1.0.5 的升级仍需手动启动新版本）
- 发布锚点：git tag `v1.0.6`（package.json version 已同步）

---

*发布日期：2026-09-30 · 爪爪（Zhuazhua）*
