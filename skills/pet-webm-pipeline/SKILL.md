---
name: pet-webm-pipeline
description: 当用户要求“给桌宠生成透明 WebM 素材”“把绿幕视频抠成透明 WebM”“替换宠物待机/点击/拖拽素材（pet-moves/*.webm）”“桌宠 WebM 素材管线”“把视频转成 VP9 alpha WebM”“修复/清理已有 WebM 的绿边、绿幕残留、淡绿区域、透明通道没转干净”时，使用本 Skill。
---

# pet-webm-pipeline

ClipSense 桌宠（Electron 透明窗口，`<video>` 直接渲染 WebM alpha）的透明 WebM 素材管线。覆盖两条路径：

- **新素材生成**：首选在 AIGC 生成阶段就**直接产出透明背景**（带真 alpha 通道）→ 转码/编码 →（可选）部署 → 验证，**省掉抠像**；仅当生成服务拿不到真 alpha 时，才退回 绿幕 → 抠像 → 编码。
- **已有素材修复**：对已生成的 WebM 清理透明区绿残留、半透明绿边（边缘发绿 / 深底上淡绿区域 / “透明通道没转干净”）。

抠像/修复/编码/验证是确定性的，只依赖 Python/OpenCV + ffmpeg；生成环节属环境相关步骤。

## 路径选择（先判断再动手）

| 手里有什么 / 想要什么 | 路径 | 主脚本 |
| --- | --- | --- |
| 要**新素材**，且生成服务能**直接导出带 alpha 的透明背景** | **首选**：直接生成透明背景 → 转码（第 1A→2→3 步） | AIGC 提示词（见 `greenscreen-source.md`）+ `encode_webm.py` |
| 要新素材，但生成服务**只给绿幕/纯色底**（导出无 alpha） | 兜底：绿幕 → 抠像（第 1B→2→3 步） | `greenscreen_matte.py` + `encode_webm.py` |
| 素材**已经是透明 WebM**，但深底上有绿边 / 淡绿区域 / 绿幕没清干净 | 已有素材修复（第 5 步） | `alpha_repair.py` |

> **为什么优先直接生成透明背景**：抠像（色键）是从 RGB 反推 alpha，天然会在毛发/半透明边缘留下绿幕绿；这些残留正是后续绿边和“淡淡绿色区域”的源头。让生成阶段直接给出真 alpha，等于从源头消除绿幕污染——既省掉抠像步骤，也免掉 `alpha_repair.py` 这类返工。
>
> **前提：必须确认导出的是“真 alpha”，不是“看起来透明”。** 很多生成服务的预览是棋盘格，但导出 MP4/H.264 时 alpha 会被丢弃、透明区变成黑底/白底。只有 **WebM VP9（yuva420p）、ProRes 4444 MOV、PNG 序列** 等格式才真正承载 alpha；H.264/普通 MP4 不行。拿不准时按 [references/greenscreen-source.md](references/greenscreen-source.md) 的导出要求做，并用 [references/verification.md](references/verification.md) 的 PNG→cv2 路线验证 alpha——**验证通过才算省掉抠像**，否则退回兜底路径。

> 关键认知（2026-11-18 实测）：桌宠 / WebGL / Canvas 的 **premultiplied-alpha 渲染路径**会把 WebM 里存储的 RGB 当作已预乘值直接使用。抠像后**完全透明像素（a=0）的 RGB 里残留的绿幕绿**会在这条路径下整片透出，表现为深色背景上的淡绿区域。半透明去绿（`edge_fix.py`）碰不到 a=0 区域，因此**只做半透明去绿不彻底**——必须同时清零 a=0 的 RGB。判定素材是否干净一定要查 a=0 像素的 RGB，详见 [references/verification.md](references/verification.md)。这条坑主要来自抠像路径；直接生成真 alpha 可从源头规避。

## 适用范围与边界

- **透明管线主流程（稳定、可复用）**：抠像、修复、编码、部署、验证。确定性步骤。
- **源视频怎么来（AIGC 环节）**：依赖外部视频生成服务与本地浏览器，属环境相关步骤。生成时**优先直接要求透明背景**（真 alpha，省掉抠像）；服务不支持时再退回绿幕。流程、提示词模板与导出要求见 [references/greenscreen-source.md](references/greenscreen-source.md)。两种操作方式：
  1. **手动**：单条生成，按 reference 的提示词与导出要求操作。
  2. **批量脚本**：`scripts/pet-generate/a01_batch.py`（Python 直连 CDP，驱动 Chrome/Edge 在片刻网 aiclipmaxx 批量提交/下载，动作清单在 `a01-actions.json`，参考图由清单 `reference` 字段指定）——前置：浏览器带远程调试端口 9222（`--remote-debugging-port=9222`）并已登录站点，装 `websocket-client` + `requests`；用法见脚本头部注释。当前动作提示词面向绿幕（历史资产），要改透明背景需调整 `a01-actions.json` 的动作提示词与导出格式。批产出接下方部署步。
  环境相关步骤**不得把外部服务凭证、账号登录态、机器特定逻辑写进仓库**（脚本只用 CDP 通用命令，不含登录态）。

## 执行步骤

### 0. 环境

- Python 3 + `opencv-python`、`numpy`（抠像 / 修复）；ffmpeg（含 `libvpx-vp9`）。
- 系统未装 ffmpeg 时用 `--ffmpeg <path>` 指定便携版，或设置 `FFMPEG` 环境变量、把 ffmpeg 加入 PATH。环境不确定时先 `inspect_development_environment` 核实，不臆断。

### 1A. 直接生成透明背景（首选，免抠像）

在 AIGC 生成阶段就要求角色置于**透明背景**上，并**导出带真 alpha 的格式**——提示词模板与导出格式要求见 [references/greenscreen-source.md](references/greenscreen-source.md)。

- 若导出已是目标格式（WebM VP9 `yuva420p`、24fps、无音轨），**可直接进入部署**，无需转码；先按第 4 步验证 alpha 与 a=0 干净。
- 若导出是 ProRes 4444 / PNG 序列等其他带 alpha 格式，转成帧序列后走第 2 步编码。
- **关键陷阱**：生成服务的棋盘格预览 ≠ 真 alpha。导出为 MP4/H.264 会丢掉 alpha。**必须**用第 4 步的 PNG→cv2 路线确认 `a_min=0` 且透明占比合理；若 alpha 丢失（全不透明），说明这次导出没带 alpha，退回 1B 绿幕路径。
- 直接生成的透明背景若仍有少量绿边/绿残留，按第 5 步 `alpha_repair.py` 清理即可（通常比抠像干净得多）。

### 1B. 绿幕抠像（兜底，仅当拿不到真 alpha）

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
- 抠像容易在 a=0 与半透明区留绿残留，编码后建议按第 5 步 `alpha_repair.py` 过一遍，避免桌宠 pre-mult 路径透绿。

### 2. 编码（RGBA 帧 → VP9 alpha WebM）

```
python scripts/pet_pipeline/encode_webm.py --frames-dir <frames_dir> --output <out.webm> --crf 28 [--fps 24] [--ffmpeg <ffmpeg.exe>]
```

- 输出 VP9 + `yuva420p`（4:2:0 alpha）、WebM 容器、无音轨。
- `Crf` 建议 28–33（越小质量越高、文件越大）；与既有素材统一用 28。
- VP9 alpha 重编码带 `-auto-alt-ref 0`（无副作用；VP8 不带会直接报错）。

### 3. 部署（可选：替换桌宠项目素材，一键）

```
python scripts/pet_pipeline/deploy_greenscreen.py --raw-mp4 <绿幕.mp4> --move d1 [--pet-project <桌宠项目根>] [--crf 28] [--ffmpeg <ffmpeg.exe>]
```

- 本脚本内部自动执行第 1B（绿幕抠像）+ 第 2 步并部署，是**兜底路径的一键版**；参数不便调时用它，需要精调参数时按第 1→2 步手动执行。走 1A 直接透明背景的素材不需要这个脚本（跳过抠像，直接编码后部署即可）。
- `-Move` 为 `pet-moves/` 下的素材名：`d1–d4` 待机池、`p1–p5` 点击池、`z1–z3` 悬停、`t1` 拖拽、`heart1` 反馈。
- `-PetProject` 为**桌宠运行项目根目录**（含 `src/renderer/pet-moves` 与 `dist/renderer/pet-moves`）。不传时仅抠像 + 编码，生成 `<out>/<move>-gs.webm`，不写任何外部项目。
- 部署会对原文件做时间戳备份（`.before-gs-*`）再覆盖。若桌宠项目在当前 workspace 之外，写入需用户授权。
- `dist/renderer/pet-moves` 是 gitignore 的生成目录，应与 `src` 保持一致；两者都要更新，避免源码与运行产物不一致。

### 4. 验证

1. **透明校验**：棋盘格/深色背景合成，确认角色边缘干净、无绿边、无灰底、无灰地板。
2. **alpha 统计**：查看帧 alpha 分布，全透明 + 全不透明应占主导，半透明过渡带应很薄。
3. **a=0 绿残留检查**：必须确认全透明像素的平均 G = 0，否则 premult 路径仍会透绿。
4. **实机**：重启桌宠应用，确认新素材生效，并把宠物移到深色背景前观察边缘透明。

验证命令与判定（含唯一的 alpha 读数可靠路线）见 [references/verification.md](references/verification.md)。

### 5. 已有素材修复（绿边 / 绿幕残留 / 透明没转干净）

当素材已经是透明 WebM，但在桌宠里深底发绿、边缘有淡绿区域时，用整合修复脚本 `alpha_repair.py`。它**一次解码、一次编码**，同时完成 a=0 清零 + 半透明去绿（避免分两次跑的二次有损重编码）。

```
python scripts/pet_pipeline/alpha_repair.py <in.webm> <out.webm> [--preview out.png] [--ffmpeg ffmpeg.exe] [--crf 28] [--fps 24]
```

修复规则（只动 `a<255`，不透明主体一律不动）：

| 条件 | 动作 | 目的 |
| --- | --- | --- |
| `a == 0` | RGB 全清零 | 消除 pre-mult 渲染路径的绿幕透出（关键） |
| `0<a<255` 且 `spill > 100` | `alpha=0`，RGB 清零 | 去掉纯绿残留像素，不伤主体 |
| `0<a<255` 且 `spill > 0` | `G -= 0.9 * spill` | 保留羽化，只去绿染 |

其中 `spill = max(0, G - (R+B)/2)`。参数 `--kill-spill`（默认 100）、`--despill-k`（默认 0.9）可调。

- 产出 `<out>.report.json`：帧数、各阶段像素数、复测 greenex / a=0 绿度 / alpha 统计；`--preview` 生成深色底合成预览图。
- 判定：复测 `a=0 平均 G = 0`、`semi_greenex_mean < 15`；`semi_greenex_p95` 约 40 属正常（VP9 4:2:0 色度渗色下限）。
- 编码参数为 24fps / crf 28 / `yuva420p` / `-auto-alt-ref 0`，与既有素材一致；帧数、alpha_mode=1 应无损。
- 部署时先备份原文件（`.before-<stage>-<ts>`），再把修复版同步到 `src` 与 `dist`，并逐文件校验 SHA256。

> `edge_fix.py`（历史脚本）只做半透明去绿，不碰 a=0 RGB；仅在确认素材 a=0 本就干净时单独使用。绝大多数“绿幕没转干净”的场景应直接用 `alpha_repair.py`。

## 安全边界

- 任何脚本与文档中不写入外部服务 API Key、Token、登录凭证。
- 桌宠项目路径、ffmpeg 路径等一律来自参数或环境变量，不硬编码机器私有绝对路径。
- 部署只覆盖 `pet-moves/<move>.webm` 对应素材，且先备份。
- 修复/部署写入当前 workspace 之外的桌宠项目时，需先获得用户授权；备份失败或 SHA256 不一致时应中止并报告。

## 资产

- `scripts/pet_pipeline/greenscreen_matte.py`——绿幕 HSV 色键 + 去绿 spill + 边缘羽化/收缩
- `scripts/pet_pipeline/encode_webm.py`——VP9 alpha WebM 编码（跨平台）
- `scripts/pet_pipeline/deploy_greenscreen.py`——抠像 + 编码 + 部署一键（跨平台）
- `scripts/pet-generate/a01_batch.py`——CDP 批量生成（Python 直连，跨平台）
- `scripts/pet_pipeline/alpha_repair.py`——**已有素材透明修复**（a=0 清零 + 半透明去绿，一次重编码）
- `scripts/pet_pipeline/edge_fix.py`——半透明绿边修复（历史脚本，不碰 a=0）
- `scripts/pet_pipeline/matte.py`、`matte_video.py`——抠像辅助脚本
- `references/verification.md`——透明质量验证（含 alpha 读数唯一可靠路线、a=0 检查、premult 验证）
- `references/greenscreen-source.md`——源视频生成：透明背景直出（首选）与绿幕（兜底）的提示词、导出格式、AIGC 操作要点
