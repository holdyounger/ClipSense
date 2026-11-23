"""A-01 pet asset offline matting pipeline.

Input: generated character frames on a uniform light-gray background.
Output: RGBA PNG (alpha matte), cropped to content bbox, plus checkerboard preview.

This runs with OpenCV only, no ffmpeg required.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

CHECKER = 16
CHECKER_A = (58, 62, 70)
CHECKER_B = (86, 92, 102)


def matte_frame(src: np.ndarray) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """Estimate background from image border and produce an alpha matte."""
    b = 8
    border = np.concatenate([
        src[:b].reshape(-1, 3), src[-b:].reshape(-1, 3),
        src[:, :b].reshape(-1, 3), src[:, -b:].reshape(-1, 3),
    ])
    bg = np.median(border, axis=0)

    dist = np.linalg.norm(src.astype(np.float32) - bg, axis=2)
    # Soft threshold: >= high is fully opaque, <= low is background.
    low, high = 14.0, 34.0
    alpha = np.clip((dist - low) / (high - low), 0.0, 1.0)

    # Keep the largest foreground component to remove stray speckles.
    mask = (alpha > 0.35).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n > 2:
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep = 1 + int(np.argmax(areas))
        alpha[labels != keep] = 0

    rgba = cv2.cvtColor(src, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = (alpha * 255).astype(np.uint8)

    ys, xs = np.where(alpha > 0.5)
    if len(xs) == 0:
        return rgba, (0, 0, src.shape[1], src.shape[0])
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    return rgba, (x0, y0, x1, y1)


def checkerboard(w: int, h: int) -> np.ndarray:
    canvas = np.zeros((h, w, 3), np.uint8)
    for y in range(0, h, CHECKER):
        for x in range(0, w, CHECKER):
            c = CHECKER_A if ((x // CHECKER + y // CHECKER) % 2 == 0) else CHECKER_B
            canvas[y:y + CHECKER, x:x + CHECKER] = c
    return canvas


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python matte.py <input.png> [output.png]")
        return 2
    src_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else src_path.with_name(src_path.stem + "-alpha.png")

    src = cv2.imread(str(src_path), cv2.IMREAD_COLOR)
    if src is None:
        print(f"cannot read {src_path}")
        return 1

    rgba, (x0, y0, x1, y1) = matte_frame(src)
    pad = 24
    h, w = src.shape[:2]
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(w, x1 + pad), min(h, y1 + pad)
    cropped = rgba[y0:y1, x0:x1]

    cv2.imwrite(str(out_path), cropped)
    preview = checkerboard(cropped.shape[1], cropped.shape[0])
    blend = cropped[:, :, :3].copy()
    a = cropped[:, :, 3:4].astype(np.float32) / 255.0
    blend = (blend * a + preview * (1 - a)).astype(np.uint8)
    cv2.imwrite(str(out_path.with_name(out_path.stem + "-preview.jpg")), blend)

    opaque = int((cropped[:, :, 3] > 200).sum())
    total = cropped.shape[0] * cropped.shape[1]
    print(f"{out_path.name}: size={cropped.shape[1]}x{cropped.shape[0]}, opaque={opaque / total:.1%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
