; Tauri NSIS installer hooks: installs the prerequisites the app needs besides
; WebView2 (handled by Tauri's bootstrapper, see bundle.windows.webviewInstallMode).
; redist/ is filled by scripts/fetch-redist.mjs before every build.

; Resolved here, at include time: inside the macros __FILEDIR__ would point at
; the generated installer.nsi.
!define LT_REDIST_DIR "${__FILEDIR__}\redist"

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Microsoft Visual C++ 2015-2022 Redistributable (x64), only if missing.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView lastused
  ${If} $0 != 1
    DetailPrint "Installazione di Microsoft Visual C++ Redistributable…"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${LT_REDIST_DIR}\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
    ; 0 = ok, 1638 = a newer version is already there, 3010 = ok, reboot needed
    ${If} $1 != 0
    ${AndIf} $1 != 1638
    ${AndIf} $1 != 3010
      DetailPrint "Visual C++ Redistributable: codice di uscita $1"
    ${EndIf}
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
