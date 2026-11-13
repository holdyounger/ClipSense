---
name: verification
description: 绿幕 WebM 素材的透明质量验证：抠像 alpha 统计、棋盘/深色合成目检、编码容器校验、桌宠实机验证命令与判定标准。
---

# 透明质量验证

WebM alpha 是否达标，分四层判定，逐层通过再进下一层。

## 1. 抠像 alpha 统计（确定性）

对抠像帧序列抽样统计 alpha 分布：

```python
import cv2, numpy as np
img = cv2.imread('frame_0001.png')  # RGBA
a = img[:, :, 3]
print('opaque',   (a > 250).mean())
print('transparent', (a < 5).mean())
print('semi',     ((a > 5) & (a < 250)).mean())
```

判定：
- 全透明 + 全不透明应占**绝大多数**（>90%）。
- 半透明过渡带（semi）应**很薄**（通常 <10%）。过渡带过大 = 羽化过度或边缘抖动。
- 若 opaque 区域出现“洞”（透明斑点），多为色键阈值把主体误判成绿——调低 `--sat-min` 或收紧 `--hue-lo/--hue-hi`。

## 2. 棋盘/深色合成目检（视觉）

把抠像帧叠到棋盘格或深色底上，肉眼确认边缘：

```python
import cv2, numpy as np
from PIL import Image
fg = Image.open('frame_0001.png').convert('RGBA')
W, H = fg.size
xx, yy = np.meshgrid(np.arange(W), np.arange(H))
ck = np.where(((xx // 24 + yy // 24) % 2) == 0, 210, 235).astype(np.uint8)
bg = np.stack([ck] * 3, axis=-1)
f = np.array(fg); al = f[:, :, 3:4].astype(np.float32) / 255
comp = (f[:, :, :3] * al + bg * (1 - al)).astype(np.uint8)
Image.fromarray(comp).save('check.png')
```

硬失败（任一出现即不达标，需回第 1 步调参）：
- 角色外圈残留**绿边**（未去净 spill）→ 调大 `--despill` / `--shrink`。
- 边缘**锯齿/毛刺** → 检查羽化，`greenscreen_matte.py` 的 `GaussianBlur` 是否生效。
- 主体**斑驳/掉毛**（白毛里出现透明孔）→ 色键阈值问题。
- 残留**灰底/灰地板** → 源视频背景不纯，回上游重新生成绿幕。

## 3. 编码容器校验（确定性）

```
ffmpeg -i <out.webm> -frames:v 1 -f null -
```

或查看流信息，确认：
- 编码 `vp9`
- 像素格式 `yuva420p`（**必须有 alpha 平面**）
- 无音频流（`-an`）
- 时长与帧率符合预期（如 5s / 24fps）

> 注意：不要仅用 `ffmpeg extractplanes` 的读数判定 alpha 丢失。某些构建对 VP9 隐藏 alpha 层的读取会误报；以**容器流信息（yuva420p）+ 浏览器/桌面实机渲染**为准。

## 4. 桌宠实机验证（最终验收）

1. 确认目标 `pet-moves/<move>.webm` 已更新（大小/时间戳）。
2. 重启桌宠应用（旧实例仍加载替换前素材，**必须重启**）。
3. 观察对应动作（待机/点击/拖拽）播放。
4. **把宠物移到深色背景前**（黑色窗口/深色壁纸）——这是透明真正生效的关键判据：边缘应完全融入背景，无灰框、无绿边、无白边。

实机通过 = 透明质量验收完成。
