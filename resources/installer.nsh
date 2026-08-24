; resources/installer.nsh — H11: human-readable installation detail lines.
; Shown in the NSIS wizard's "Show details" area so users always know what
; the installer is doing (v0.3.0 feedback: a bare progress bar felt like a
; half-finished installer).
!macro customInstall
  DetailPrint "Installing DshCockpit application files..."
  DetailPrint "Bundling the pinned Harness runtime (one-time, ~140 MB)..."
  DetailPrint "Registering per-user shortcuts (Start Menu / Desktop)..."
  DetailPrint "Your data lives in %APPDATA%\dsh-cockpit and survives reinstalls."
  DetailPrint "Almost done..."
!macroend

!macro customUnInstall
  DetailPrint "Removing DshCockpit application files..."
  DetailPrint "Your data in %APPDATA%\dsh-cockpit has been kept."
!macroend
