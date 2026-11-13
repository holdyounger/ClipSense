<#
 绿幕成片 -> 桌宠 pet-moves/<move>.webm 一键部署
 用法：
   仅生成 WebM（不改桌宠）：
     powershell -File deploy_greenscreen.ps1 -RawMp4 <绿幕.mp4> -Move d1
   生成并部署到桌宠项目：
     powershell -File deploy_greenscreen.ps1 -RawMp4 <绿幕.mp4> -Move d1 -PetProject <桌宠项目根>
 步骤：
   1. OpenCV 绿幕色键抠像 -> RGBA 帧（frame_%04d.png）
   2. ffmpeg 编码 VP9 alpha WebM（yuva420p）
   3.（可选）备份并替换 <PetProject> 的 src + dist 的 pet-moves/<move>.webm
 说明：
   - 仓库根由脚本位置自动推导（$PSScriptRoot 上两级），无需写死路径。
   - 桌宠项目路径必须由 -PetProject 提供，不硬编码机器私有路径。
   - 若 PetProject 在当前 workspace 之外，写入需用户授权。
#>
param(
  [Parameter(Mandatory=$true)][string]$RawMp4,
  [string]$Move = 'd1',
  [string]$PetProject = '',
  [int]$Crf = 30
)

$ErrorActionPreference = 'Stop'
# 仓库根 = 本脚本所在目录(scripts/pet_pipeline)上两级
$root   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$frames = Join-Path $root ("out\aiclipmaxx\" + $Move + "\gs-frames-" + $Move)
$webm   = Join-Path $root ("out\aiclipmaxx\" + $Move + "\" + $Move + "-gs.webm")
$spike  = $PetProject

if (-not (Test-Path $RawMp4)) { throw "raw mp4 not found: $RawMp4" }

Write-Host "[1/3] greenscreen matte -> $frames"
Remove-Item -Recurse -Force $frames -ErrorAction SilentlyContinue
& python (Join-Path $root 'scripts\pet_pipeline\greenscreen_matte.py') $RawMp4 $frames
if ($LASTEXITCODE -ne 0) { throw "matte failed" }

Write-Host "[2/3] encode VP9 alpha webm -> $webm"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\pet_pipeline\encode_webm.ps1') `
    -FramesDir $frames -Output $webm -Crf $Crf
if ($LASTEXITCODE -ne 0) { throw "encode failed" }
$size = (Get-Item $webm).Length
Write-Host "  webm ready: $size bytes"

if ($spike) {
  Write-Host "[3/3] deploy to pet project: $spike"
  foreach ($base in @('src\renderer\pet-moves', 'dist\renderer\pet-moves')) {
    $dst = Join-Path $spike $base
    if (-not (Test-Path $dst)) { Write-Host "  skip (missing): $dst"; continue }
    $target = Join-Path $dst ($Move + '.webm')
    if (Test-Path $target) {
      $bak = $target + ".before-gs-" + (Get-Date -Format 'yyyyMMddHHmmss')
      Copy-Item $target $bak -Force
      Write-Host "  backup -> $bak"
    }
    Copy-Item $webm $target -Force
    Write-Host "  deployed -> $target ($size bytes)"
  }
  Write-Host "DONE. Restart the pet app to pick up the new asset."
} else {
  Write-Host "[3/3] no -PetProject given; skip deploy. WebM at: $webm"
}
