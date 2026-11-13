# A-01 桌宠素材管线

当前已落地离线步骤：

1. `matte.py`：对浅灰背景角色帧做 OpenCV alpha 抠像，输出 RGBA PNG 和棋盘预览；
2. `encode_webm.ps1`：将 24fps RGBA PNG 序列编码为 VP9 alpha WebM。

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

```powershell
.\scripts\pet_pipeline\encode_webm.ps1 `
  -FramesDir .\out\d1 `
  -Output .\src\renderer\pet-moves\d1.webm
```

验收要求：24fps、`yuva420p`、VP9、无音轨、透明边缘自然，文件名与现有 `pet-moves` 池保持一致。
