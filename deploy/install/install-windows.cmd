@echo off
rem Workspace installer for Windows. Requests administrator rights itself.
rem Paths in arguments (for example -AnswersFile) must be absolute.
net session >/dev/null 2>&1
if errorlevel 1 (
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  ) else (
    powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '%*'"
  )
  exit /b
)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
echo.
pause
