; ClipSense NSIS 自定义安装脚本（electron-builder include）
; 目的：消除「静默升级后新版本不自动启动」的代际限制——
;   任何旧版本静默升级安装完成后，安装器直接拉起新版本（不依赖新包自带的重启脚本）。
; 机制：electron-builder NSIS 的 !macro customInstall 会在安装收尾阶段执行；
;   /S 静默模式同样执行（Electron Builder 文档明确 customInstall 在 silent 也会跑）。
; 守卫：仅静默模式（/S）自动启动——交互式安装用户有「运行 ClipSense」勾选项，避免双开。

!macro customInstall
  ${ifNot} ${isUpdated}
    ; 交互式安装：安装向导最后自带「运行应用」复选框，不做额外启动
  ${else}
    ; 静默升级：安装完成后直接启动新版本
    ;（ExecWait 不可用——会阻塞安装收尾；用 Exec 异步拉起即可）
    Exec '"$INSTDIR\ClipSense.exe"'
  ${endIf}
!macroend
