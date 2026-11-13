param(
  [Parameter(Mandatory=$true)][string]$FramesDir,
  [Parameter(Mandatory=$true)][string]$Output,
  [int]$Fps = 24,
  [int]$Crf = 32,
  [string]$Ffmpeg = ''
)

$ifPath = $null
if ($Ffmpeg) {
  $ifPath = $Ffmpeg
} else {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { $ifPath = $cmd.Source }
  else {
    $fallback = "$env:TEMP\ffmpeg\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe"
    if (Test-Path $fallback) { $ifPath = $fallback }
  }
}
if (-not $ifPath) { throw "ffmpeg not found. Pass -Ffmpeg or install ffmpeg." }

$frames = Join-Path (Resolve-Path $FramesDir) 'frame_%04d.png'
& $ifPath -y -framerate $Fps -i $frames `
  -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf $Crf `
  -row-mt 1 -threads 4 -an -loop 0 $Output
if ($LASTEXITCODE -ne 0) { throw "ffmpeg exited with code $LASTEXITCODE" }

Write-Output "encoded: $Output"
