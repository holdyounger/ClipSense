"""绿幕视频 -> RGBA 帧（VP9 alpha WebM 前处理）

管线：
1. HSV 色键（绿幕）生成 alpha，比 ffmpeg chromakey 更可控
2. despill：去掉边缘残留绿色（防白毛染绿）
3. 边缘羽化（alpha 高斯模糊）去锯齿/绿边
4. 可选：边缘收缩吃掉最外圈半透明绿

用法：
  python greenscreen_matte.py <input.mp4> <output_dir> [--max-frames 60]
  逐帧写 RGBA PNG（帧数多时先抽帧验证参数）
"""
import argparse
import os
import cv2
import numpy as np


def key_frame(bgr: np.ndarray, hue_lo=35, hue_hi=92, sat_min=60, val_min=30):
    """单帧色键：返回 alpha (0-255, 255=保留主体)"""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    green = (h >= hue_lo) & (h <= hue_hi) & (s >= sat_min) & (v >= val_min)
    alpha = np.where(green, 0, 255).astype(np.uint8)
    # 硬边 -> 1-2px 软过渡（羽化去锯齿）
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.1)
    return np.clip(alpha, 0, 255).astype(np.uint8)


def despill(bgr: np.ndarray, alpha: np.ndarray, strength=0.6):
    """去绿 spill：主体内绿色通道向 (R+B)/2 收敛，消除白毛边缘绿染"""
    out = bgr.astype(np.int32)
    b, g, r = out[..., 0], out[..., 1], out[..., 2]
    spill = np.clip(g - (r + b) // 2, 0, None) * strength
    keep = alpha > 16
    out[..., 1] = np.where(keep, g - spill, g).clip(0, 255)
    return out.astype(np.uint8)


def shrink_alpha(alpha: np.ndarray, px=1):
    """alpha 轻度收缩，吃掉最外圈半透明绿边"""
    if px <= 0:
        return alpha
    k = 2 * px + 1
    er = cv2.erode(alpha, np.ones((k, k), np.uint8))
    # 与原始取均值：既收边又不吃毛发细节
    blended = (alpha.astype(np.float32) * 0.5 + er.astype(np.float32) * 0.5)
    return np.clip(blended, 0, 255).astype(np.uint8)


def process(src, dst, hue_lo=35, hue_hi=92, sat_min=60, val_min=30,
            despill_strength=0.6, shrink_px=1, max_frames=0, start=0):
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise SystemExit('cannot open ' + src)
    os.makedirs(dst, exist_ok=True)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    i = 0
    count = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i < start:
            i += 1
            continue
        alpha = key_frame(frame, hue_lo, hue_hi, sat_min, val_min)
        frame = despill(frame, alpha, despill_strength)
        alpha = shrink_alpha(alpha, shrink_px)
        rgba = np.dstack([frame, alpha])
        # 与 encode_webm.ps1 约定的 frame_%04d.png 命名保持一致
        cv2.imwrite(os.path.join(dst, 'frame_%04d.png' % (i + 1)), rgba)
        i += 1
        count += 1
        if max_frames and count >= max_frames:
            break
        if count % 24 == 0:
            print('frame', i, '/', n)
    cap.release()
    print('done: %d frames -> %s (fps=%.1f)' % (count, dst, fps))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('dst')
    p.add_argument('--max-frames', type=int, default=0)
    p.add_argument('--start', type=int, default=0)
    p.add_argument('--hue-lo', type=int, default=35)
    p.add_argument('--hue-hi', type=int, default=92)
    p.add_argument('--sat-min', type=int, default=60)
    p.add_argument('--val-min', type=int, default=30)
    p.add_argument('--despill', type=float, default=0.6)
    p.add_argument('--shrink', type=int, default=1)
    a = p.parse_args()
    process(a.src, a.dst, a.hue_lo, a.hue_hi, a.sat_min, a.val_min,
            a.despill, a.shrink, a.max_frames, a.start)
