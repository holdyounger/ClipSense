/**
 * input-simulator.js - Windows Ctrl+V 快捷键注入
 *
 * 通过 PowerShell 临时调用 user32!keybd_event，避免为 spike 引入原生 npm 依赖。
 */

const { execFile } = require('child_process');

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ClipSensePaste {
    // keybd_event 不需要手动编排 INPUT 结构体，兼容性好；Windows 仍会把它作为键盘事件分发。
    [DllImport("user32.dll", SetLastError = true)]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    public static void Key(byte virtualKey, uint flags) {
        keybd_event(virtualKey, 0, flags, UIntPtr.Zero);
    }
}
'@

# KEYEVENTF_KEYUP = 0x0002
[ClipSensePaste]::Key(0x11, 0)
try {
    Start-Sleep -Milliseconds 30
    [ClipSensePaste]::Key(0x56, 0)
    Start-Sleep -Milliseconds 30
    [ClipSensePaste]::Key(0x56, 0x0002)
} finally {
    [ClipSensePaste]::Key(0x11, 0x0002)
}
`;

function simulatePaste() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: '仅支持 Windows Ctrl+V' });
  }

  const encodedScript = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedScript,
    ], { windowsHide: true, timeout: 15000 }, (error, _stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: stderr.trim() || error.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

module.exports = { simulatePaste };
