@echo off
setlocal
if not exist "%~dp0scripts\install-windows.ps1" (
  echo.
  echo The installer files are missing. Extract the entire ZIP before running install.cmd.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%INSTALL_EXIT_CODE%"=="0" (
  echo Installation failed with exit code %INSTALL_EXIT_CODE%.
  echo See the error above and the log in %%LOCALAPPDATA%%\chatgpt-coder\logs.
) else (
  echo Installation finished successfully.
)
echo.
pause
exit /b %INSTALL_EXIT_CODE%
