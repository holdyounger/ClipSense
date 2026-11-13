---
name: pet-webm-pipeline
description: 当用户要求“给桌宠生成透明 WebM 素材”“把绿幕视频抠成透明 WebM”“替换宠物待机/点击/拖拽素材（pet-moves/*.webm）”“桌宠 WebM 素材管线”“把视频转成 VP9 alpha WebM”时，使用本 Skill。
---

# pet-webm-pipeline

ClipSense 桌宠（Electron 透明窗口，`<video>` 直接渲染 WebM alpha）的透明 WebM 素材管线。输入一段**绿幕（纯绿背景）视频**，产出可直接替换 `pet-moves/` 对应素材的 VP9 alpha WebM。

## 适用范围与边界

- **本 Skill 主流程（稳定、可复用）**：给定绿幕视频，完成 抠像 → 编码 →（可选）部署 → 验证。确定性步骤，只依赖 Python/OpenCV + ffmpeg。
- **绿幕视频怎么来（AIGC 环节）**：依赖外部视频生成服务与本地浏览器，属环境相关步骤。两条路：
  1. **手动**：流程与提示词模板见 [references/greenscreen-source.md](references/greenscreen-source.md)（单条生成）。
  2. **批量脚本**：`scripts/pet-generate/a01-batch.ps1`（CDP 驱动 Edge 驱动片刻网 aiclipmaxx 批量提交/下载，动作清单在 `a01-actions.json`，参考图 `docs/pet-characters/a01-greenscreen.png`）——前置：Edge 带远程调试端口 9222 并已登录站点；用法见脚本头部注释。批产出接下方部署步。
  环境相关步骤**不得把外部服务凭证、账号登录态、机器特定逻辑写进仓库**（脚本只用 CDP 通用命令，不含登录态）。

## 执行步骤

### 0. 环境

- Python 3 + `opencv-python`、`numpy`（抠像）；ffmpeg（含 `libvpx-vp9`）。
- 系统未装 ffmpeg 时用 `-Ffmpeg <path>` 指定便携版。环境不确定时先 `inspect_development_environment` 核实，不臆断。

### 1. 抠像（绿幕 → RGBA 帧序列）

```
python scripts/pet_pipeline/greenscreen_matte.py <绿幕.mp4> <frames_dir>
```

- 输出 `frame_%04d.png`（RGBA）帧序列，编码就绪。
- 关键参数（默认针对“纯绿幕 + 白毛角色”调好，边缘发绿/斑驳时再调）：
  - `--hue-lo/--hue-hi`：绿色色相区间（OpenCV HSV，默认 35–92）
  - `--sat-min/--val-min`：绿色饱和度/明度阈值（默认 60/30）
  - `--despill`：去绿 spill 强度（默认 0.6，白毛发绿时调大）
  - `--shrink`：边缘收缩像素（默认 1，外圈绿边时调 2）
- 帧数多时先 `--max-frames 30` 抽帧验证参数，再跑全量。

### 2. 编码（RGBA 帧 → VP9 alpha WebM）

```
powershell -File scripts/pet_pipeline/encode_webm.ps1 -FramesDir <frames_dir> -Output <out.webm> -Crf 30 [-Ffmpeg <ffmpeg.exe>]
```

- 输出 VP9 + `yuva420p`（4:2:0 alpha）、WebM 容器、无音轨。
- `Crf` 建议 28–33（越小质量越高、文件越大）。

### 3. 部署（可选：替换桌宠项目素材，一键）

```
powershell -File scripts/pet_pipeline/deploy_greenscreen.ps1 -RawMp4 <绿幕.mp4> -Move d1 [-PetProject <桌宠项目根>] [-Crf 30]
```

- 本脚本内部自动执行第 1 + 第 2 步并部署；参数不便调时用它，需要精调参数时按第 1→2 步手动执行。
- `-Move` 为 `pet-moves/` 下的素材名：`d1–d4` 待机池、`p1–p5` 点击池、`z1–z3` 悬停、`t1` 拖拽、`heart1` 反馈。
- `-PetProject` 为**桌宠运行项目根目录**（含 `src/renderer/pet-moves` 与 `dist/renderer/pet-moves`）。不传时仅抠像 + 编码，生成 `<out>/<move>-gs.webm`，不写任何外部项目。
- 部署会对原文件做时间戳备份（`.before-gs-*`）再覆盖。若桌宠项目在当前 workspace 之外，写入需用户授权。

### 4. 验证

1. **透明校验**：棋盘格/深色背景合成，确认角色边缘干净、无绿边、无灰底、无灰地板。
2. **alpha 统计**：查看帧 alpha 分布，全透明 + 全不透明应占主导，半透明过渡带应很薄。
3. **实机**：重启桌宠应用，确认新素材生效，并把宠物移到深色背景前观察边缘透明。

验证命令与判定见 [references/verification.md](references/verification.md)。

## 安全边界

- 任何脚本与文档中不写入外部服务 API Key、Token、登录凭证。
- 桌宠项目路径、ffmpeg 路径等一律来自参数或环境变量，不硬编码机器私有绝对路径。
- 部署只覆盖 `pet-moves/<move>.webm` 对应素材，且先备份。

## 资产

- `scripts/pet_pipeline/greenscreen_matte.py`——绿幕 HSV 色键 + 去绿 spill + 边缘羽化/收缩
- `scripts/pet_pipeline/encode_webm.ps1`——VP9 alpha WebM 编码
- `scripts/pet_pipeline/deploy_greenscreen.ps1`——抠像 + 编码 + 部署一键
