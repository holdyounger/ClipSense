# ClipSense v1.0.0

ClipSense 是一款基于 Electron 的剪贴板历史助手，支持自动记录剪贴板内容、历史搜索、指定条目粘贴以及窗口边缘唤出。

## ✨ 主要功能

- 📋 自动监听系统剪贴板，默认每 `600ms` 检查一次
- 🗂️ 支持文本、富文本、图片和文件历史记录
- 🔍 支持搜索剪贴板历史内容
- 📌 双击历史条目即可：
  1. 将指定条目写入系统剪贴板
  2. 向目标窗口发送一次 `Ctrl+V`
  3. 粘贴被选中的历史内容
- 🖼️ 支持图片历史持久化
- 📁 支持文件条目预览和 Windows Explorer 定位
- 🧾 空格、Tab、换行等空白内容可视化显示
- 🖱️ 支持窗口贴边、拖拽和边缘触发
- ⏱️ 支持鼠标离开后的自动隐藏倒计时
- 📌 支持固定窗口，防止自动隐藏
- 🔒 使用 Electron `safeStorage` 加密历史数据和图片
- 🎨 新增卡通风格应用 Logo 和托盘图标
- 🪟 支持 Windows 系统托盘运行
- ⚙️ 新增 GitHub Actions 自动构建和 Release workflow

## 🖥️ Windows 构建

```bash
npm install
npm run build:win
```

构建产物位于：

```text
build/
```

包含 Windows NSIS 安装包和未打包应用目录。

## ⌨️ 快捷操作

| 操作 | 方式 |
|------|------|
| 唤出 / 隐藏面板 | `Ctrl+Shift+V` |
| 搜索历史 | 点击搜索框后输入关键词 |
| 复制历史条目 | 点击条目复制操作 |
| 粘贴指定条目 | 双击历史条目 |
| 定位文件 | 单击文件条目 |
| 固定窗口 | 点击固定按钮 |
| 退出应用 | 托盘菜单 → 退出 |

## 🔐 数据与隐私

剪贴板历史保存在 Electron `userData` 目录中，主要包括：

```text
clipboard-history.json
clip-images/<id>.bin
clip-history-config.json
```

如果系统支持 `safeStorage`，历史元数据和图片会进行加密存储。若系统不支持安全存储，程序会降级为明文存储并输出警告。

## ⚠️ 已知限制

- 当前主要面向 Windows 环境。
- 双击粘贴会暂时覆盖系统剪贴板，尚未实现粘贴完成后的自动恢复。
- 图片、富文本和文件粘贴仍需根据不同目标应用进行兼容性验证。
- `Ctrl+V` 键盘注入、Explorer 文件粘贴和窗口焦点行为需要在 Windows 实机确认。
- 尚未实现真正意义上的 Windows 多虚拟桌面全局显示。
- `safeStorage` 不可用时会降级为明文存储。

## 🧪 验证状态

已完成：

- JavaScript 语法检查
- Git diff 格式检查
- Windows Electron 安装包构建
- Windows NSIS 打包配置
- GitHub Actions 构建 workflow 配置

建议在 Windows 上继续验证：

- 文本、富文本、图片和文件粘贴
- `.exe` 文件粘贴
- 搜索框获取焦点后双击粘贴
- 原目标窗口焦点恢复
- 左右边缘触发条
- 多虚拟桌面切换
- 粘贴后恢复原剪贴板

---

**版本**：`v1.0.0`  
**项目**：ClipSense  
**许可证**：MIT License
