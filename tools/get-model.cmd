@echo off
rem Double-click to download the Kindgleam assistant model (about 1.1 GB) into Kindgleam's own folder.
rem When Kindgleam is installed in Program Files this asks for administrator rights.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-model.ps1" %*
pause
