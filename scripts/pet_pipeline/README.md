# A-01 桌宠素材管线

脚本全部为 **Python 跨平台实现**（Windows / macOS / Linux 通用），不依赖 PowerShell。
统一依赖：Python 3 + `opencv-python` + `numpy`；ffmpeg（含 `libvpx-vp9`）；批量生成额外需要 `websocket-client` + `requests`。

## 脚本清单

1. `matte.py`：对浅灰背景角色帧做 OpenCV alpha 抠像，输出 RGBA PNG 和棋盘预览；
2. `greenscreen_matte.py`：绿幕 HSV 色键抠像（默认参数针对纯绿幕 + 白毛角色）；
3. `encode_webm.py`：将 24fps RGBA PNG 序列编码为 VP9 alpha WebM（替代旧 `.ps1`）；
4. `deploy_greenscreen.py`：抠像 + 编码 + 可选部署一键（替代旧 `.ps1`）；
5. `alpha_repair.py`：已有透明 WebM 的 a=0 绿残留 + 半透明绿边修复（一次重编码）；
6. `edge_fix.py`：历史半透明去绿脚本（不碰 a=0，已被 alpha_repair 覆盖）。

## 已生成的 A-01 测试资产

在 `docs/pet-characters/`：

- `a01-alpha.png`
- `a01-idle-alpha.png`
- `a01-click-alpha.png`
- `a01-react-alpha.png`

## 生成完整动作的约定

云视频生成服务恢复后，每个动作生成 PNG 帧序列，统一命名为：

```text
frame_0001.png ... frame_0096.png
```

4 秒动作固定 96 帧；长表演动作使用 360 帧。然后执行：

```bash
python scripts/pet_pipeline/encode_webm.py \
  --frames-dir ./out/d1 \
  --output ./src/renderer/pet-moves/d1.webm
```

ffmpeg 不在 PATH 时加 `--ffmpeg <path>` 或设置 `FFMPEG` 环境变量。

验收要求：24fps、`yuva420p`、VP9、无音轨、`alpha_mode=1`、透明边缘自然，文件名与现有 `pet-moves` 池保持一致。alpha 是否真存在必须用 webm→PNG→cv2 读第 4 通道判定（见 `skills/pet-webm-pipeline/references/verification.md`）。
