# -*- coding: utf-8 -*-
"""透明 WebM 边缘/透明区修复（a=0 绿残留 + 半透明绿边，两阶段一次重编码）

背景 / 为什么需要：
  edge_fix.py 只处理半透明像素（0<a<255），从不碰完全透明像素（a=0）的 RGB。
  抠像后 a=0 像素里往往仍存着绿幕绿（G 可达 87~234）。标准 straight-alpha 合成
  看不出问题，但 premultiplied-alpha 渲染路径（WebGL/Canvas/部分 compositor）会把
  存储的 RGB 当成已预乘值直接使用，绿幕整片透出 —— 表现为深底上的淡绿区域/绿边。

修复规则（只动 a<255，不透明主体一律不动）：
  R1  a == 0            -> RGB 全清零（消除 pre-mult 路径的绿残留，不影响 alpha）
  R2  0<a<255 且 spill>kill_spill(默认100) -> alpha=0（纯绿残留像素）
  R3  0<a<255 且 spill>0 -> G -= despill_k*spill（保留羽化，只去绿）
  spill = max(0, G - (R+B)/2)

一次解码、一次编码，避免 edge_fix + clear-a0 分开跑造成的两次有损重编码。

用法：
  python alpha_repair.py <in.webm> <out.webm> [--preview out.png]
                         [--kill-spill 100] [--despill-k 0.9]
                         [--ffmpeg ffmpeg.exe] [--crf 28] [--fps 24]
产出 <out>.report.json（帧数、各阶段像素数、复测 greenex / a0 绿度 / alpha 统计）。

依赖：Python3 + opencv-python + numpy；ffmpeg（libvpx-vp9）。
验证：见 references/verification.md —— semi_greenex_mean 应 <15，a=0 平均 G 应 =0。
"""
import argparse
import glob
import json
import os
import shutil
import subprocess

import cv2
import numpy as np


def find_ffmpeg(cli):
    if cli:
        return cli
    env = os.environ.get('FFMPEG')
    if env:
        return env
    c = shutil.which('ffmpeg')
    if c:
        return c
    raise SystemExit('ffmpeg 未找到：用 --ffmpeg 指定或设置 FFMPEG 环境变量')


def decode_all(ffmpeg, webm, wd):
    os.makedirs(wd, exist_ok=True)
    for old in glob.glob(os.path.join(wd, 'ef_*.png')):
        os.remove(old)
    r = subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error',
                        '-c:v', 'libvpx-vp9', '-i', webm,
                        '-pix_fmt', 'rgba', os.path.join(wd, 'ef_%04d.png')],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0:
        raise SystemExit('解码失败: ' + (r.stdout or '')[:300])
    return sorted(glob.glob(os.path.join(wd, 'ef_*.png')))


def repair_frame(im, kill_spill=100.0, despill_k=0.9):
    """im: HxWx4 BGRA uint8 -> (fixed BGRA, stats)"""
    b = im[..., 0].astype(np.int32)
    g = im[..., 1].astype(np.int32)
    r = im[..., 2].astype(np.int32)
    a = im[..., 3].astype(np.int32)
    spill = (g - (r + b) // 2).clip(min=0)
    semi = (a > 0) & (a < 255)

    out = im.copy()
    # R1: 全透明像素 RGB 清零（关键：消除 pre-mult 渲染路径的绿幕透出）
    a0 = a == 0
    n_a0 = int(a0.sum())
    out[a0, :3] = 0
    # R2: 半透明纯绿残留 -> alpha=0（其 RGB 也一并清零）
    kill = semi & (spill > kill_spill)
    n_kill = int(kill.sum())
    out[kill, 3] = 0
    out[kill, :3] = 0
    # R3: 半透明去绿染
    tgt = semi & (spill > 0)
    g2 = g.copy()
    g2[tgt] = g2[tgt] - (spill[tgt] * despill_k).astype(np.int32)
    out[..., 1] = g2.clip(0, 255).astype(np.uint8)
    return out, {'a0_cleared': n_a0, 'killed': n_kill, 'despill_px': int(tgt.sum())}


def fringe_stats(ffmpeg, webm, n=6):
    """复测（PNG 解码路线，唯一可靠的 alpha 读数）：a=0 绿度 / 半透明 greenex / alpha 分布"""
    base = os.path.dirname(os.path.abspath(webm)) or '.'
    wd = os.path.join(base, '.chk_' + os.path.basename(webm).replace('.webm', ''))
    os.makedirs(wd, exist_ok=True)
    try:
        r = subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error',
                            '-c:v', 'libvpx-vp9', '-i', webm,
                            '-vf', 'select=lt(n\\,%d)' % n, '-fps_mode', 'vfr',
                            '-pix_fmt', 'rgba', os.path.join(wd, 'ch_%03d.png')],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        files = sorted(glob.glob(os.path.join(wd, 'ch_*.png')))
        if not files:
            return {'err': 'decode fail'}
        im = cv2.imread(files[0], cv2.IMREAD_UNCHANGED)
        b, g, rr, a = (im[..., i].astype(np.int32) for i in range(4))
        greenex = g - np.maximum(rr, b)
        a0 = a == 0
        semi = (a > 0) & (a < 255)
        opq = a >= 250
        out = {
            'a_min': int(a.min()),
            'a0_g_mean': round(float(g[a0].mean()), 1) if a0.any() else None,
            'trans_pct': round(100 * float(a0.mean()), 1),
            'opaque_pct': round(100 * float(opq.mean()), 1),
        }
        if semi.any():
            out['semi_greenex_mean'] = round(float(greenex[semi].mean()), 1)
            out['semi_greenex_p95'] = round(float(np.percentile(greenex[semi], 95)), 1)
        return out
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def make_preview(ffmpeg, webm, out_png):
    """深色底合成预览（pre-mult 绿残留在此路径下也会暴露）"""
    base = os.path.dirname(os.path.abspath(out_png)) or '.'
    wd = os.path.join(base, '.prev_' + os.path.basename(webm).replace('.webm', ''))
    os.makedirs(wd, exist_ok=True)
    try:
        subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error',
                        '-c:v', 'libvpx-vp9', '-i', webm,
                        '-vf', 'select=lt(n\\,2)', '-fps_mode', 'vfr',
                        '-pix_fmt', 'rgba', os.path.join(wd, 'pv_%03d.png')],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        files = sorted(glob.glob(os.path.join(wd, 'pv_*.png')))
        if not files:
            return
        im = cv2.imread(files[0], cv2.IMREAD_UNCHANGED)
        H, W = im.shape[:2]
        y, x = np.mgrid[0:H, 0:W]
        rad = np.clip(1 - np.hypot(x - W / 2, y - H / 2) / (W * 0.7), 0, 1)
        bg = np.zeros((H, W, 3), np.float32)
        bg[..., 0] = 28 + 22 * rad
        bg[..., 1] = 33 + 26 * rad
        bg[..., 2] = 46 + 34 * rad
        a = im[..., 3:4].astype(np.float32) / 255.0
        comp = (im[..., :3].astype(np.float32) * a + bg * (1 - a)).astype(np.uint8)
        m = im[..., 3] > 16
        ys, xs = np.where(m)
        pad = 32
        y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, H)
        x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, W)
        cv2.imwrite(out_png, comp[y0:y1, x0:x1])
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('dst')
    p.add_argument('--preview')
    p.add_argument('--kill-spill', type=float, default=100)
    p.add_argument('--despill-k', type=float, default=0.9)
    p.add_argument('--ffmpeg')
    p.add_argument('--crf', type=int, default=28)
    p.add_argument('--fps', type=int, default=24)
    a = p.parse_args()

    ffmpeg = find_ffmpeg(a.ffmpeg)
    os.makedirs(os.path.dirname(os.path.abspath(a.dst)), exist_ok=True)
    wd = os.path.join(os.path.dirname(os.path.abspath(a.dst)),
                      '.wd_' + os.path.basename(a.dst).replace('.webm', ''))
    try:
        frames = decode_all(ffmpeg, a.src, wd)
        total = {'a0_cleared': 0, 'killed': 0, 'despill_px': 0}
        for fp in frames:
            im = cv2.imread(fp, cv2.IMREAD_UNCHANGED)
            fixed, st = repair_frame(im, a.kill_spill, a.despill_k)
            for k in total:
                total[k] += st[k]
            cv2.imwrite(fp, fixed)
        r = subprocess.run([ffmpeg, '-y', '-v', 'error',
                            '-framerate', str(a.fps), '-i', os.path.join(wd, 'ef_%04d.png'),
                            '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
                            '-b:v', '0', '-crf', str(a.crf),
                            '-row-mt', '1', '-threads', '4',
                            '-auto-alt-ref', '0', '-an', a.dst],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if r.returncode != 0 or not os.path.exists(a.dst):
            raise SystemExit('编码失败: ' + (r.stdout or '')[:300])
        report = {
            'src': os.path.abspath(a.src), 'dst': os.path.abspath(a.dst),
            'frames': len(frames),
            'params': {'kill_spill': a.kill_spill, 'despill_k': a.despill_k,
                       'crf': a.crf, 'fps': a.fps},
            'pixels': total,
            'after': fringe_stats(ffmpeg, a.dst),
        }
        rp = a.dst + '.report.json'
        json.dump(report, open(rp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print('fixed %d frames  a0清零=%d  强绿透明化=%d  去绿=%d' %
              (len(frames), total['a0_cleared'], total['killed'], total['despill_px']))
        print('after: %s' % report['after'])
        print('report: %s' % rp)
        if a.preview:
            make_preview(ffmpeg, a.dst, a.preview)
            print('preview: %s' % a.preview)
    finally:
        shutil.rmtree(wd, ignore_errors=True)


if __name__ == '__main__':
    main()
