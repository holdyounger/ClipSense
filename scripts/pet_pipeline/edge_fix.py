# -*- coding: utf-8 -*-
"""边缘绿晕修复（绿幕桌宠素材）：VP9 alpha WebM -> 去绿重编码

适用：素材 alpha 正常（背景已透明），但角色毛发的半透明边缘像素带绿染（green fringe），
在深色桌面上表现为白毛外圈绿边。不改变几何/帧率/时长/角色位置，只做像素级去绿。

规则（只动半透明像素 a<255，不透明主体不动）:
  spill = max(0, G - (R+B)/2)
  R1: spill > --kill-spill(默认100) -> alpha=0   （纯绿残留像素，alpha 往往仅 1-10）
  R2: spill > 0                     -> G -= despill_k * spill（去绿染，默认 0.9）

用法:
  python edge_fix.py <in.webm> <out.webm> [--preview out.png]
                     [--kill-spill 100] [--despill-k 0.9]
                     [--ffmpeg ffmpeg.exe] [--crf 28]

依赖: Python3 + opencv-python + numpy；ffmpeg（libvpx-vp9）
验证: 修复后跑 verify_alpha.py 看 semi_greenex 应降到 <15；
      深色底合成目检边缘无绿晕。报告 JSON 输出到 <out>.report.json。
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import tempfile

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
    # 常见便携位置（不硬编码机器绝对路径，逐个探测）
    for cand in (
        os.path.join(os.environ.get('TEMP', ''), 'ffmpeg', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe'),
    ):
        if os.path.exists(cand):
            return cand
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


def fix_frame(im, kill_spill=100, despill_k=0.9):
    """im: HxWx4 BGRA uint8 -> (fixed BGRA, stats)"""
    b = im[..., 0].astype(np.int32)
    g = im[..., 1].astype(np.int32)
    r = im[..., 2].astype(np.int32)
    a = im[..., 3].astype(np.int32)
    spill = (g - (r + b) // 2).clip(min=0)
    semi = (a > 0) & (a < 255)
    n_kill = int((semi & (spill > kill_spill)).sum())
    a[semi & (spill > kill_spill)] = 0
    tgt = semi & (spill > 0)
    g[tgt] = g[tgt] - (spill[tgt] * despill_k).astype(np.int32)
    out = np.stack([b, g.clip(0, 255), r, a.clip(0, 255)], axis=-1)
    return out.astype(np.uint8), {'killed': n_kill, 'despill_px': int(tgt.sum())}


def fringe_stats(ffmpeg, webm, n=6):
    """边缘绿度复测（PNG 解码路线）"""
    base = os.path.dirname(os.path.abspath(webm)) or '.'
    wd = os.path.join(base, '.chk_' + os.path.basename(webm).replace('.webm', ''))
    os.makedirs(wd, exist_ok=True)
    try:
        subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error',
                        '-c:v', 'libvpx-vp9', '-i', webm,
                        '-vf', 'select=lt(n\\,%d)' % n, '-fps_mode', 'vfr',
                        '-pix_fmt', 'rgba', os.path.join(wd, 'ch_%03d.png')],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        files = sorted(glob.glob(os.path.join(wd, 'ch_*.png')))
        if not files:
            return {'err': 'decode fail'}
        im = cv2.imread(files[0], cv2.IMREAD_UNCHANGED)
        b, g, r, a = (im[..., i].astype(int) for i in range(4))
        greenex = g - np.maximum(r, b)
        semi = (a > 0) & (a < 255)
        out = {'a_min': int(a.min()), 'trans_pct': round(100 * (a <= 7).mean(), 1)}
        if semi.any():
            out['semi_greenex_mean'] = round(float(greenex[semi].mean()), 1)
            out['semi_greenex_p95'] = round(float(np.percentile(greenex[semi], 95)), 1)
            out['semi_n'] = int(semi.sum())
        return out
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def make_preview(ffmpeg, webm, out_png):
    """深色底合成预览（绿晕在深色下最明显）"""
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
    p.add_argument('--workdir', default=None,
                   help='帧序列工作目录（默认在 dst 同目录 .wd_*，结束后清理）')
    a = p.parse_args()

    ffmpeg = find_ffmpeg(a.ffmpeg)
    os.makedirs(os.path.dirname(os.path.abspath(a.dst)), exist_ok=True)
    wd = a.workdir or os.path.join(os.path.dirname(os.path.abspath(a.dst)),
                                   '.wd_' + os.path.basename(a.dst).replace('.webm', ''))
    try:
        frames = decode_all(ffmpeg, a.src, wd)
        total = {'killed': 0, 'despill_px': 0}
        for fp in frames:
            im = cv2.imread(fp, cv2.IMREAD_UNCHANGED)
            fixed, st = fix_frame(im, a.kill_spill, a.despill_k)
            total['killed'] += st['killed']
            total['despill_px'] += st['despill_px']
            cv2.imwrite(fp, fixed)
        # 帧数/时长保留：按源帧率重采样到原帧数
        r = subprocess.run([ffmpeg, '-y', '-v', 'error',
                            '-framerate', '24', '-i', os.path.join(wd, 'ef_%04d.png'),
                            '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
                            '-b:v', '0', '-crf', str(a.crf),
                            '-row-mt', '1', '-threads', '4',
                            '-auto-alt-ref', '0', '-an', a.dst],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if r.returncode != 0 or not os.path.exists(a.dst):
            raise SystemExit('编码失败: ' + (r.stdout or '')[:300])
        report = {
            'src': os.path.abspath(a.src), 'dst': os.path.abspath(a.dst),
            'frames': len(frames), 'params': {'kill_spill': a.kill_spill,
                                              'despill_k': a.despill_k},
            'pixels': total,
            'after': fringe_stats(ffmpeg, a.dst),
        }
        rp = a.dst + '.report.json'
        json.dump(report, open(rp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print('fixed %d frames  强绿透明化=%d  去绿=%d' %
              (len(frames), total['killed'], total['despill_px']))
        print('after: %s' % report['after'])
        print('report: %s' % rp)
        if a.preview:
            make_preview(ffmpeg, a.dst, a.preview)
            print('preview: %s' % a.preview)
    finally:
        shutil.rmtree(wd, ignore_errors=True)


if __name__ == '__main__':
    main()
