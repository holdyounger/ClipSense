---
name: verification
description: 绿幕 / 透明 WebM 素材的质量验证：alpha 读数的唯一可靠路线（webm→PNG→cv2）、a=0 RGB 绿残留检查、premultiplied 渲染路径验证、半透明 greenex 指标、编码容器校验、实机判定标准。
---

# 透明质量验证

WebM alpha 是否达标，分层判定，逐层通过再进下一层。**最容易踩的坑是 alpha 读数路线选错导致误判，以及只查半透明、漏查 a=0 的绿残留。**

## 0. alpha 读数：唯一可靠路线（先读这一节）

判定 VP9 alpha WebM 是否真透明，**必须**走 `webm → PNG(rgba) → cv2 读第 4 通道`：

```
ffmpeg -c:v libvpx-vp9 -i in.webm -vf select=lt(n\,6) -fps_mode vfr -pix_fmt rgba f_%03d.png
```

```python
import cv2
im = cv2.imread('f_001.png', cv2.IMREAD_UNCHANGED)  # BGRA
a = im[:, :, 3]                                    # 第 4 通道才是 alpha
print('a_min', a.min(), '透明占比', (a == 0).mean())
```

以下读数**不可靠，会误报“alpha 全不透明”或“没有 alpha”**，不要用来下结论：

- `ffmpeg -i in.webm -f rawvideo -pix_fmt rgba`：部分构建不重建 superframe 的 alpha 层。
- `ffprobe` 的 `pix_fmt`：base 层显示 `yuv420p` 是正常的（alpha 在 superframe 里），不能据此判定无 alpha。
- `ffmpeg extractplanes=alpha`：某些构建同样读不到隐藏 alpha 层。

辅助证据（非决定性的旁证）：流/容器带 `alpha_mode=1` 标签；alpha 版文件比同内容无 alpha 版大约 40–60%。

## 1. alpha 分布 + a=0 绿残留（确定性，核心）

```python
import cv2, numpy as np
im = cv2.imread('f_001.png', cv2.IMREAD_UNCHANGED)  # BGRA
b, g, r, a = (im[:, :, i].astype(np.int32) for i in range(4))
a0   = a == 0
semi = (a > 0) & (a < 255)
opq  = a >= 250
greenex = g - np.maximum(r, b)                       # G 相对 R/B 的过量 = 绿染强度

print('opaque%%   ', round(100 * opq.mean(), 1))
print('trans%%    ', round(100 * a0.mean(), 1))
print('semi%%     ', round(100 * semi.mean(), 1))
print('a_min      ', a.min())
print('a=0 平均G  ', round(float(g[a0].mean()), 1) if a0.any() else None)   # ← 必须为 0
print('semi greenex mean / p95',
      round(float(greenex[semi].mean()), 1),
      round(float(np.percentile(greenex[semi], 95)), 1))
```

判定：

- `a_min == 0`、透明 + 不透明占绝大多数（>90%）、半透明带很薄（通常 <10%）。
- **a=0 像素的平均 G 必须 = 0**（或 ≤2 的编码噪声）。这是最容易被忽略、后果最严重的一项：a=0 区域残留的绿幕绿在 premultiplied-alpha 渲染路径下会整片透出，形成淡绿背景/绿边。`edge_fix.py` 不检查也不修复这一项。
- `semi_greenex_mean < 15` 为达标；`semi_greenex_p95` 约 40 属正常下限（VP9 4:2:0 色度渗色），超过 100 说明有纯绿残留没清掉。
- opaque 区域出现“洞”（透明斑点）＝色键阈值把主体误判成绿，回抠像步骤调 `--sat-min` / `--hue-lo/--hue-hi`。

## 2. premultiplied-alpha 渲染路径验证（定位“深底淡绿”）

标准 straight-alpha 合成（RGB×alpha + 背景×(1-alpha)）下绿残留常常**看不出来**，问题只在 premult 路径暴露。用下面的模拟确认修复是否彻底：

```python
import cv2, numpy as np
# 模拟渲染器误把存储 RGB 当已预乘值：直接加到背景上
im = cv2.imread('f_001.png', cv2.IMREAD_UNCHANGED)       # BGRA
af = im[:, :, 3].astype(np.float32) / 255
bg = np.full_like(im[:, :, :3].astype(np.float32), 32)
pmbug = np.clip(im[:, :, :3].astype(np.float32) + bg * (1 - af[:, :, None]), 0, 255).astype(np.uint8)
b, g, r = (pmbug[:, :, i].astype(int) for i in range(3))
green_frac = ((g > 150) & (g - np.maximum(r, b) > 80)).mean()
cv2.imwrite('premult_check.png', pmbug)
print('绿背景占比', round(green_frac, 3))                 # 修复后应为 0
```

判定：修复后绿背景占比应降到 **0**。修复前常见 0.2–0.75（实测 p10=74.7%、z2=27%），这就是用户看到“淡淡绿色区域”的来源。

## 3. 棋盘/深色合成目检（视觉）

把抠像帧叠到棋盘格或深色底上，肉眼确认边缘：

```python
import cv2, numpy as np
from PIL import Image
fg = Image.open('f_001.png').convert('RGBA')
W, H = fg.size
xx, yy = np.meshgrid(np.arange(W), np.arange(H))
ck = np.where(((xx // 24 + yy // 24) % 2) == 0, 210, 235).astype(np.uint8)
bg = np.stack([ck] * 3, axis=-1)
f = np.array(fg); al = f[:, :, 3:4].astype(np.float32) / 255
comp = (f[:, :, :3] * al + bg * (1 - al)).astype(np.uint8)
Image.fromarray(comp).save('check.png')
```

硬失败（任一出现即不达标）：

- 角色外圈残留**绿边**（未去净 spill）→ 提高去绿强度 / 收缩边缘。
- 边缘**锯齿/毛刺** → 检查羽化是否生效。
- 主体**斑驳/掉毛**（白毛里出现透明孔）→ 色键阈值问题。
- 残留**灰底/灰地板** → 源视频背景不纯，回上游重新生成绿幕。

## 4. 编码容器与帧完整性校验（确定性）

```
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_read_frames,pix_fmt \
  -show_entries stream_tags=alpha_mode -of json in.webm
```

确认：

- 编码 `vp9`，alpha 流 `alpha_mode=1`。
- 帧数、帧率、分辨率与源一致（如 124 帧 / 24fps）——修复不能丢帧。
- 无音频流；时长符合预期。

> `pix_fmt` 显示 `yuv420p`（base 层）是正常的，不要据此判定 alpha 丢失——回到第 0 节的正确读数路线。

## 5. 修复部署校验（批量）

对批量修复并部署到桌宠项目的场景：

- 逐文件比对 `src` 与 `dist` 的 SHA256，全部一致。
- 备份（`.before-<stage>-<ts>`）全部存在且内容是修复前的原件。
- report.json 的帧数 = 源帧数；复测 `a=0 平均G=0`、`semi_greenex_mean<15`。
- 清单文件的 `verified` 为 N/N（src+dist 双份），无 hash_ok=false。

## 6. 桌宠实机验证（最终验收）

1. 确认目标 `pet-moves/<move>.webm` 已更新（大小/时间戳）。
2. **重启桌宠应用**（旧实例仍加载替换前素材，必须重启）。
3. 观察对应动作（待机/点击/拖拽）播放。
4. **把宠物移到深色背景前**（黑色窗口/深色壁纸）——透明真正生效的关键判据：边缘完全融入背景，无灰框、无绿边、无淡绿区域、无白边。

实机通过 = 透明质量验收完成。
