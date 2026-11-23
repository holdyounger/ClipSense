# -*- coding: utf-8 -*-
"""绿幕成片 -> 桌宠 pet-moves/<move>.webm 一键部署（跨平台，替代旧 deploy_greenscreen.ps1）

用法：
  # 仅生成 WebM（不改桌宠）
  python scripts/pet_pipeline/deploy_greenscreen.py --raw-mp4 <绿幕.mp4> --move d1

  # 生成并部署到桌宠项目（src + dist）
  python scripts/pet_pipeline/deploy_greenscreen.py --raw-mp4 <绿幕.mp4> --move d1 \
      --pet-project <桌宠项目根> [--crf 28] [--ffmpeg <ffmpeg.exe>]

步骤：
  1. OpenCV 绿幕色键抠像 -> RGBA 帧（greenscreen_matte.py）
  2. ffmpeg 编码 VP9 alpha WebM（encode_webm.py）
  3.（可选）时间戳备份并替换 <pet-project> 的 src + dist 的 pet-moves/<move>.webm

约定：
  - 仓库根由脚本位置推导（scripts/pet_pipeline 上两级），无需写死路径。
  - 桌宠项目路径必须由 --pet-project 提供，不硬编码机器私有绝对路径。
  - 只覆盖 pet-moves/<move>.webm，且先备份；目录缺失则跳过。
"""
import argparse
import datetime
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def run(cmd, label):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0:
        raise SystemExit('%s 失败: %s' % (label, (r.stdout or '')[:400]))
    return r.stdout or ''


def main():
    p = argparse.ArgumentParser(description='绿幕成片 -> 桌宠透明 WebM 一键部署')
    p.add_argument('--raw-mp4', required=True, help='绿幕源视频 mp4')
    p.add_argument('--move', default='d1', help='pet-moves 下的素材名（d1/p1/z1/...）')
    p.add_argument('--pet-project', default='', help='桌宠运行项目根目录；不传则仅生成不部署')
    p.add_argument('--crf', type=int, default=28)
    p.add_argument('--fps', type=int, default=24)
    p.add_argument('--ffmpeg', default=None)
    a = p.parse_args()

    raw = os.path.abspath(a.raw_mp4)
    if not os.path.exists(raw):
        raise SystemExit('绿幕视频不存在: ' + raw)
    py = sys.executable
    frames = os.path.join(ROOT, 'out', 'aiclipmaxx', a.move, 'gs-frames-' + a.move)
    webm = os.path.join(ROOT, 'out', 'aiclipmaxx', a.move, a.move + '-gs.webm')
    os.makedirs(os.path.dirname(webm), exist_ok=True)

    print('[1/3] 抠像 -> %s' % frames)
    if os.path.isdir(frames):
        shutil.rmtree(frames)
    run([py, os.path.join(HERE, 'greenscreen_matte.py'), raw, frames], '抠像')

    print('[2/3] 编码 -> %s' % webm)
    enc = [py, os.path.join(HERE, 'encode_webm.py'), '--frames-dir', frames,
           '--output', webm, '--crf', str(a.crf), '--fps', str(a.fps)]
    if a.ffmpeg:
        enc += ['--ffmpeg', a.ffmpeg]
    run(enc, '编码')
    size = os.path.getsize(webm)
    print('  webm ready: %d bytes' % size)

    if not a.pet_project:
        print('[3/3] 未指定 --pet-project，跳过部署。WebM 位于: %s' % webm)
        return

    print('[3/3] 部署到桌宠项目: %s' % a.pet_project)
    for rel in ('src/renderer/pet-moves', 'dist/renderer/pet-moves'):
        dst_dir = os.path.join(os.path.abspath(a.pet_project), *rel.split('/'))
        if not os.path.isdir(dst_dir):
            print('  skip (missing): ' + dst_dir)
            continue
        target = os.path.join(dst_dir, a.move + '.webm')
        if os.path.exists(target):
            ts = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
            bak = target + '.before-gs-' + ts
            shutil.copy2(target, bak)
            print('  backup -> ' + bak)
        shutil.copy2(webm, target)
        print('  deployed -> %s (%d bytes)' % (target, size))
    print('DONE. 重启桌宠应用以加载新素材。')


if __name__ == '__main__':
    main()
