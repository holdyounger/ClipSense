# Clipboard Spike — 剪贴板程序可行性验证 Demo

> **目的（spike）**：验证「基于 KeySense 框架实现剪贴板程序」的核心技术链路是否可行，不做完整产品。

## 一、验证目标

一次性验证核心链路：

1. **剪贴板轮询监听** —— Electron `clipboard` 模块没有跨平台 change 事件，需用「轮询 + hash 比对」检测变化（`clipboard-monitor.js`）
2. **历史面板展示** —— 复制内容自动出现在列表
3. **点击回写** —— 点击历史条目写回剪贴板
4. **窗口交互（同步自 KeySense）** —— 贴边 / 定时隐藏 / 鼠标靠边缘唤出 / 拖拽（`edge-detector.js`）

## 二、运行方式

```bash
cd /mnt/d/Montarius/source/clipboard-spike
npm install          # 只装 electron
npm start            # 普通运行
# 或开发模式（自动开 DevTools）
npm run start:dev
```

> 需要 Node 环境。首次 `npm install` 会下载 Electron（约几十 MB）。

## 三、验证步骤（手动操作清单）

### 剪贴板核心链路

1. 运行后出现「📋 剪贴板历史」无边框窗口（靠右边缘）
2. 到任意编辑器 / 浏览器复制一段文字（Ctrl+C）
3. **等待 ≤ 0.6 秒**，该文字自动出现在列表顶部（轮询间隔 600ms）
4. 再复制另一段文字，列表新增第二条
5. 点击某条目的「复制」按钮 → 该内容写回剪贴板，条目高亮闪烁
6. 在别处 Ctrl+V，验证粘贴出来的是刚点的内容
7. 点「✕」删除单条 / 点顶部「清空」清空所有

### 窗口交互（同步自 KeySense）

8. 全局按 `Ctrl+Shift+V` 唤出/隐藏窗口
9. **鼠标靠屏幕右边缘**（5px 内）→ 窗口自动唤出
10. **鼠标移出窗口** → 约 3 秒后自动淡出隐藏并贴边
11. **拖拽窗口 header** → 可拖动到任意位置；隐藏再唤出后回到拖拽位置

## 四、核心实现说明

### clipboard-monitor.js（关键验证点）

```
tick() → clipboard.readText() → md5 hash → 与上次比对
       → 变化则 unshift 进 history（环形裁剪到 maxHistory）
```

- 去重：同一内容会话内只归档一次（`_seenHashes`）
- 环形缓冲：超出 `maxHistory`（100）自动裁剪
- 轮询间隔 600ms，可调

### 结论落点

| 验证项 | 结论 |
|--------|------|
| 轮询监听可行 | ✅ 预期可跑通 |
| 面板展示可行 | ✅ |
| 点击回写可行 | ✅ `clipboard.writeText()` 原生支持 |
| 图片剪贴板 | ⚠️ 本 demo 只做文本，图片需二期（`readImage()` + `nativeImage`） |
| 富文本 | ⚠️ 二期（CSP + 渲染安全需处理） |

### 持久化（storage.js，重启不丢失）

- 历史数组 + 图片数据**加密落盘**到 `app.getPath('userData')`：
  - `clipboard-history.json` —— 元数据（safeStorage 加密）
  - `clip-images/<id>.bin` —— 图片数据（safeStorage 加密，dataUrl 从主 JSON 抽离）
- 加密用 Electron `safeStorage`（密钥由 OS 钥匙串托管，不落地）；WSL2 无钥匙串时降级明文（仅告警）
- 历史上限可配置（托盘菜单「历史上限」：100/200/500/1000/5000 条）

## 五、遗留 / 待验证

- 网络盘 `/mnt/d` 下 Electron 能否正常启动 GUI（需在真实 Windows 或 WSLg 环境验证）
- 图片、富文本、文件复制留待二期（图片已支持持久化，但复制的图片链路待二期完善）

---

> 详见调研报告：`../shortcut-guide/docs/剪贴板程序可行性方案与需求调研.md`
