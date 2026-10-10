# ClipSense v1.0.12 Release Note

发布日期：2026-10-10

本版本为 **TypeScript 全量迁移落地版**：渲染层与主进程 22 个模块全部迁移至 TypeScript（strict 模式零错误），运行时从 src 源码切换为 dist 编译产物，CI 构建链纳入类型检查与产物编译。应用功能与 v1.0.11 一致，含一项动画修复。

## 🐛 修复

- 新条目入场动画：修复首渲染基线分支丢失导致的**首条目误播**（基线渲染只记录不播，恢复 v1.0.11 前语义；该回归由「测试切换到 TS 产物」当日捕获）

## 🔧 内部工程（对用户透明）

- TS 全量迁移：src 下 22 个模块 .ts 单一事实源，strict 零错误；src .js 退役
- 运行时切换：package.json main → dist/main/index.js，静态资源（html/css/图标）随构建复制到 dist
- 测试全面切换：行为电池加载编译产物，结构断言锚定 .ts 源（537 条全绿）
- CI：逐文件 node --check → tsc --noEmit 类型检查；构建前置编译（build:ts）
- devDependencies 新增 typescript ^5.9.3

## 📌 升级说明

- 无破坏性变更，历史数据与配置完全兼容
- 从 v1.0.11「检查更新」升级，静默安装后自动启动照常（v1.0.7+ NSIS customInstall 链路）
- 发布锚点：git tag `v1.0.12`（package.json version 已同步）

---

*发布日期：2026-10-10 · 爪爪（Zhuazhua）*
