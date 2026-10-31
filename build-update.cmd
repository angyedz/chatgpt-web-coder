@echo off
setlocal
if not exist "%~dp0scripts\build-update.ps1" (
  echo Build script not found. Run this file from the complete project folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-update.ps1" %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%BUILD_EXIT_CODE%"=="0" (echo Update build failed with exit code %BUILD_EXIT_CODE%.) else (echo Update build completed.)
echo.
pause
exit /b %BUILD_EXIT_CODE%
