; ClipSense NSIS 自定义安装脚本（electron-builder include）
; 目的：消除「静默升级后新版本不自动启动」的代际限制——
;   任何旧版本静默升级安装完成后，安装器直接拉起新版本（不依赖新包自带的重启脚本）。
; 机制：electron-builder NSIS 的 !macro customInstall 会在安装收尾阶段执行；
;   /S 静默模式同样执行（Electron Builder 文档明确 customInstall 在 silent 也会跑）。
; 守卫：仅静默模式（/S）自动启动——交互式安装用户有「运行 ClipSense」勾选项，避免双开。

!macro customInstall
  ; 2026-09-30 实机修正（v1.0.8→v1.0.9 静默升级未自动启动）：isUpdated 的语义是
  ; 「覆盖安装」（同版本重装/降级），版本号递增的正式升级 isUpdated=false——
  ; 旧守卫 ${ifNot} ${isUpdated} 恰好排除了唯一的自动启动场景。
  ; 新守卫：仅交互模式跳过（向导自带运行勾选）；静默模式（/S）一律启动新版本。
  ${ifNot} ${Silent}
    ; 交互式安装：安装向导最后自带「运行应用」复选框，不做额外启动
  ${else}
    Exec '"$INSTDIR\ClipSense.exe"'
  ${endIf}
!macroend
