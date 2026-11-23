"""Video matting pipeline: MP4 on uniform gray background -> RGBA frame sequence.

Reuses the same border-background estimation as matte.py, applied per frame.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np


def alpha_from_border(src: np.ndarray, low: float = 12.0, high: float = 30.0) -> np.ndarray:
    b = 8
    border = np.concatenate([
        src[:b].reshape(-1, 3), src[-b:].reshape(-1, 3),
        src[:, :b].reshape(-1, 3), src[:, -b:].reshape(-1, 3),
    ])
    bg = np.median(border, axis=0)
    dist = np.linalg.norm(src.astype(np.float32) - bg, axis=2)
    return np.clip((dist - low) / (high - low), 0.0, 1.0)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: python matte_video.py <input.mp4> <out_dir>")
        return 2
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        print("cannot open", src)
        return 1

    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        alpha = alpha_from_border(frame)
        rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = (alpha * 255).astype(np.uint8)
        cv2.imwrite(str(out_dir / f"frame_{n:04d}.png"), rgba)
        n += 1
    cap.release()
    print(f"frames: {n} -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
