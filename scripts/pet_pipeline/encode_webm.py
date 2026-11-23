# -*- coding: utf-8 -*-
"""RGBA PNG 帧序列 -> VP9 alpha WebM（跨平台，替代旧 encode_webm.ps1）

用法：
  python scripts/pet_pipeline/encode_webm.py --frames-dir <dir> --output <out.webm>
         [--fps 24] [--crf 28] [--ffmpeg ffmpeg.exe]

输入帧命名 frame_%04d.png（greenscreen_matte.py 的输出）。
输出 VP9 + yuva420p（4:2:0 alpha）、WebM、无音轨。
ffmpeg 查找顺序：--ffmpeg > 环境变量 FFMPEG > PATH。
"""
import argparse
import os
import shutil
import subprocess
import sys


def find_ffmpeg(cli):
    if cli:
        return cli
    env = os.environ.get('FFMPEG')
    if env:
        return env
    found = shutil.which('ffmpeg')
    if found:
        return found
    raise SystemExit('ffmpeg 未找到：用 --ffmpeg 指定，或设置 FFMPEG 环境变量，或加入 PATH')


def main():
    p = argparse.ArgumentParser(description='RGBA 帧序列编码为 VP9 alpha WebM')
    p.add_argument('--frames-dir', required=True, help='帧序列目录（含 frame_0001.png ...）')
    p.add_argument('--output', required=True, help='输出 .webm 路径')
    p.add_argument('--fps', type=int, default=24)
    p.add_argument('--crf', type=int, default=28)
    p.add_argument('--ffmpeg', default=None)
    a = p.parse_args()

    ffmpeg = find_ffmpeg(a.ffmpeg)
    frames = os.path.join(os.path.abspath(a.frames_dir), 'frame_%04d.png')
    if not os.path.exists(os.path.abspath(a.frames_dir)):
        raise SystemExit('帧目录不存在: ' + a.frames_dir)

    out = os.path.abspath(a.output)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    cmd = [ffmpeg, '-y', '-v', 'error',
           '-framerate', str(a.fps), '-i', frames,
           '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', str(a.crf),
           '-row-mt', '1', '-threads', '4', '-auto-alt-ref', '0', '-an', out]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0 or not os.path.exists(out):
        raise SystemExit('ffmpeg 编码失败: ' + (r.stdout or '')[:400])

    print('encoded: %s (%d bytes)' % (out, os.path.getsize(out)))


if __name__ == '__main__':
    main()
