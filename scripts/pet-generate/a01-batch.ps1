<#
 A-01 比熊 绿幕视频批量生成（aiclipmaxx 片刻网，CDP 驱动 Edge）

 前置条件：
   1. Edge 已以远程调试启动：msedge --remote-debugging-port=9222（保持登录片刻网 aiclipmaxx.com）
   2. 参考图存在：docs/pet-characters/a01-greenscreen.png（绿幕定妆图，已审核）

 用法（在仓库根目录执行）：
   # 阶段1：批量提交 13 个任务进免费队列（可中断重跑，自动跳过已提交）
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pet-generate/a01-batch.ps1 -Phase submit -SettleSec 45

   # 阶段2：队列出片后下载并映射（每 90s 轮询，Ctrl+C 可随时退出，重跑续传）
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pet-generate/a01-batch.ps1 -Phase download

   # 只看队列状态
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pet-generate/a01-batch.ps1 -Phase status

 规格（与 d1 已验证管线一致）：图生视频 / 1:1 / 480p / 5 秒 / 纯绿幕背景 / 参考图统一
 出片后接：scripts/pet_pipeline/deploy_greenscreen.ps1 -RawMp4 <mp4> -Move <id>
#>
param(
  [ValidateSet('submit','download','status')][string]$Phase = 'status',
  [int]$SettleSec = 45,
  [int]$PollSec = 90,
  [switch]$Limit1
)

$ErrorActionPreference = 'Stop'
$repo   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$cdp    = Join-Path $repo 'scripts\cdp\eval.js'
$actions = Join-Path $repo 'scripts\pet-generate\a01-actions.json'
$refImg = Join-Path $repo 'docs\pet-characters\a01-greenscreen.png'
$progFile = Join-Path $repo 'out\aiclipmaxx\batch\progress.json'
$outDir = Join-Path $repo 'out\aiclipmaxx\batch'

function EvalCdp([string]$Expr) {
  $r = & node $cdp 'auto' 'eval' $Expr 2>&1
  $r | Out-String | TrimEnd
}
function FindPage() {
  try {
    $list = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/list' -UseBasicParsing -TimeoutSec 5).Content
  } catch { throw 'CDP 9222 不可用：确认 Edge 已带 --remote-debugging-port=9222 启动' }
  $m = [regex]::Matches($list, '"id"\s*:\s*"([0-9A-F]+)"[^}]*?"url"\s*:\s*"(https://aiclipmaxx\.com[^"]*)"')
  foreach ($mm in $m) { return $mm.Groups[1].Value }
  $m2 = [regex]::Matches($list, '"url"\s*:\s*"(https://aiclipmaxx\.com[^"]*)"[^}]*?"id"\s*:\s*"([0-9A-F]+)"')
  foreach ($mm in $m2) { return $mm.Groups[2].Value }
  throw '未找到 aiclipmaxx 页面（请在 Edge 中打开并登录 aiclipmaxx.com）'
}
function ClickByText([string]$Text) {
  $js = @"
  (function(){var els=document.querySelectorAll('button,div,span');for(var i=0;i<els.length;i++){var t=(els[i].innerText||'').trim();if(t==='$($Text -replace "'","''")'&&els[i].offsetWidth>0){els[i].click();return 'ok'};}}
  return 'nf';})()
"@
  EvalCdp $js
}
function ProgressLoad() {
  if (Test-Path $progFile) { return (Get-Content $progFile -Raw | ConvertFrom-Json) }
  return @{ submitted = @{} }
}
function ProgressSave($p) {
  New-Item -ItemType Directory -Force (Split-Path $progFile) | Out-Null
  $p | ConvertTo-Json -Depth 5 | Set-Content $progFile -Encoding UTF8
}

if (Test-Path $cdp) {} else { throw "cdp eval.js not found: $cdp" }
if (-not (Test-Path $refImg)) { throw "参考图不存在: $refImg" }

$data = Get-Content $actions -Raw | ConvertFrom-Json
$page = FindPage
Write-Host "[cdp] aiclipmaxx page: $page"

# ---------- JS 片段（页面 DOM 依赖，改版时优先改这里） ----------
$jsOpenImg2v = "(function(){var els=document.querySelectorAll('div,button,span');for(var i=0;i<els.length;i++){var t=(els[i].innerText||'').trim();if(t==='图生视频'&&els[i].offsetWidth>0){els[i].click();return 'ok'}}return 'nf'})()"
$jsHasFileInput = "(function(){var el=document.querySelector('input[type=file]');return el?'1':'0'})()"
$jsFileCount = "(function(){var el=document.querySelector('input[type=file]');return el&&el.files?el.files.length:0})()"
$jsRemoveUploaded = "(function(){var els=document.querySelectorAll('div,button,span');for(var i=0;i<els.length;i++){var t=(els[i].innerText||'').trim();if(t==='移除'&&els[i].offsetWidth>0){els[i].click();return 'ok'}}return 'nf'})()"
$jsFillPrompt = @"
(function(){var ta=document.querySelector('textarea');if(!ta)return 'no-ta';var proto=Object.getPrototypeOf(ta);var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(ta,"@
$jsFillPromptEnd = @");ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()
"@

if ($Phase -in @('submit','status')) {
  $prog = ProgressLoad
  # status 阶段不需要点表单
  if ($Phase -eq 'submit') {
    $r = ClickByText '图生视频'
    if ($r -notmatch 'ok') { Write-Warning "未点中「图生视频」(返回 $r)，若页面已在图生视频模式可忽略" }
    Start-Sleep -Seconds 2
  }
}

# ---------- 队列状态查询（最近作品卡片） ----------
$jsScanJobs = @'
(function(){var cards=[];var els=document.querySelectorAll('*');
for(var i=0;i<els.length;i++){var e=els[i];if(e.children.length>25)continue;var t=(e.innerText||'');
if(t.indexOf('图生视频')>=0&&t.indexOf('秒')>=0&&t.length<900&&t.length>25){
var dl=e.querySelector('a[download]');
cards.push({dl:dl?(dl.href.split('/').slice(-2).join('/')):null,txt:t.replace(/\s+/g,' ').slice(0,120)});
}}
return JSON.stringify(cards)})()
'@
function ScanJobs() {
  $raw = EvalCdp $jsScanJobs
  if (-not $raw -or $raw -notmatch '\[') { return @() }
  try { return ($raw | ConvertFrom-Json) } catch { Write-Warning "scan 解析失败: $($raw.Substring(0,[Math]::Min(120,$raw.Length)))"; return @() }
}
function IsDoneCard([string]$Txt) {
  return ($Txt -match '用时') -and ($Txt -notmatch '预计') -and ($Txt -notmatch '取消')
}

# ---------- STATUS ----------
if ($Phase -eq 'status') {
  $jobs = ScanJobs
  $done = @($jobs | Where-Object { IsDoneCard $_.txt })
  Write-Host "最近作品卡片: $($jobs.Count)  已完成(可下载): $($done.Count)"
  foreach ($j in $jobs) {
    $tag = if (IsDoneCard $j.txt) { 'DONE ' } else { 'queue' }
    Write-Host ("  [{0}] {1} {2}" -f $tag, ($j.dl ?? '-'), ($j.txt.Substring(0, [Math]::Min(70, $j.txt.Length))))
  }
  return
}

# ---------- SUBMIT ----------
if ($Phase -eq 'submit') {
  $list = [System.Collections.ArrayList]@()
  foreach ($a in $data.actions) { $list += $a }
  if ($Limit1) { $list = $list[0..0] }
  foreach ($a in $list) {
    if ($prog.submitted.ContainsKey($a.id)) {
      Write-Host "[skip] $($a.id) 已提交 ($($prog.submitted[$a.id].submittedAt))"
      continue
    }
    Write-Host "`n==== $($a.id) $($a.label) ===="
    if ($jsHasFileInput -ne '1' -and (EvalCdp $jsHasFileInput) -ne '1') {
      Write-Host "[warn] 未见 file input（可能在上传中），继续尝试"
    }
    # 清掉上一个动作的参考图
    if ((EvalCdp $jsFileCount) -match '1') {
      ClickByText '移除' | Out-Null
      Start-Sleep -Seconds 1.5
    }
    & node $cdp $page 'upload' $refImg 'input[type=file]' | Out-Null
    # 等上传完成（「移除」按钮出现）
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 2
      if ((ClickByText '移除') -match 'ok') { $ok = $true; break }
    }
    if (-not $ok) { Write-Host "[fail] $($a.id) 上传未确认，重跑本阶段可续传"; continue }
    Start-Sleep -Seconds 1
    $escaped = $a.prompt -replace '\\','\\' -replace '"','\"'
    $fillJs = $jsFillPrompt + $escaped + $jsFillPromptEnd
    $fr = EvalCdp $fillJs
    if ($fr -ne 'ok') { Write-Host "[fail] $($a.id) 填提示词失败: $fr"; continue }
    Start-Sleep -Seconds 1
    ClickByText '480p' | Out-Null; Start-Sleep -Seconds 0.5
    ClickByText '5 秒'  | Out-Null; Start-Sleep -Seconds 1
    $sr = ClickByText '生成视频'
    if ($sr -ne 'ok') { Write-Host "[fail] $($a.id) 未点中「生成视频」(返回 $sr)，请人工检查页面"; continue }
    # 指纹：动作描述首句（提示词公共前缀之后的前 14 字），用于下载阶段映射
    $fp = ($a.prompt -split '做', 2)[1]
    $fp = $fp.Substring(0, [Math]::Min(14, $fp.Length))
    if (-not $prog.submitted.PSObject.Properties.Contains($a.id)) { $prog.submitted | Add-Member -NotePropertyName $a.id -NotePropertyValue (@{} ) -Force }
    $prog.submitted[$a.id] = @{
      label = $a.label
      fp = $fp
      submittedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      status = 'submitted'
    }
    ProgressSave $prog
    Write-Host "[ok] $($a.id) 已提交 (fp=$fp)"
    Write-Host "[settle] 等 ${SettleSec}s 让页面/队列稳定…"
    Start-Sleep -Seconds $SettleSec
  }
  $done13 = @($data.actions | Where-Object { $prog.submitted.ContainsKey($_.id) }).Count
  Write-Host "`n==== 提交阶段结束：$done13/$($data.actions.Count) 已提交。等待免费队列出片后运行 -Phase download ===="
  return
}

# ---------- DOWNLOAD ----------
if ($Phase -eq 'download') {
  New-Item -ItemType Directory -Force $outDir | Out-Null
  $prog = ProgressLoad
  while ($true) {
    $jobs = ScanJobs
    $missing = @()
    foreach ($a in $data.actions) {
      $p = $null
      if ($prog.submitted.PSObject.Properties.Contains($a.id)) { $p = $prog.submitted[$a.id] }
      if ($null -eq $p) { $missing += $a; continue }
      if ($p.status -eq 'downloaded') { continue }
      if ($p.status -eq 'missing') { continue }
      # 找匹配的已完成卡片（卡片文本含指纹）
      $card = $jobs | Where-Object { $_.txt -like "*$($p.fp)*" -and (IsDoneCard $_.txt) -and $_.dl } | Select-Object -First 1
      if (-not $card) { $missing += $a; continue }
      Write-Host "`n[dl] $($a.id) $($a.label) <- $($card.dl)"
      $jobId = ($card.dl -split '/')[0]
      $dest = Join-Path $outDir ("aiclipmaxx-" + $jobId + "." + $a.id + ".mp4")
      if (Test-Path $dest) {
        $p.status = 'downloaded'; $p.file = $dest; $p.jobId = $jobId; ProgressSave $prog; continue
      }
      $clickJs = "(function(){var a=document.querySelector('a[download*=`"$jobId`"]');if(a){a.click();return 'ok'}return 'nf'})()"
      if ((EvalCdp $clickJs) -ne 'ok') { Write-Host "[warn] 未找到 $jobId 下载链接"; continue }
      # 等浏览器落盘
      $got = $false
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        $dl = Get-ChildItem 'D:\Montarius\Downloads' -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -like "*$jobId*" } |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($dl -and $dl.Length -gt 100000) {
          Move-Item $dl.FullName $dest -Force
          $got = $true; break
        }
      }
      if ($got) {
        $p.status = 'downloaded'; $p.file = $dest; $p.jobId = $jobId
        Write-Host "[ok] saved: $dest ($((Get-Item $dest).Length) bytes)"
      } else {
        Write-Host "[warn] 下载未在 60s 内落盘，下轮重试"
      }
      ProgressSave $prog
      Start-Sleep -Seconds 3
    }
    $doneN = @($data.actions | Where-Object { $prog.submitted.PSObject.Properties.Contains($_.id) -and $prog.submitted[$_.id].status -eq 'downloaded' }).Count
    if ($doneN -ge $data.actions.Count) {
      Write-Host "`n==== 全部 $doneN/$($data.actions.Count) 下载完成 -> $outDir ===="
      return
    }
    $missTxt = ($missing | ForEach-Object { $_.id }) -join ', '
    Write-Host "[poll] 已完成 $doneN/$($data.actions.Count)，等待中: $missTxt （${PollSec}s 后重试，Ctrl+C 退出可重跑续传）"
    Start-Sleep -Seconds $PollSec
  }
}
