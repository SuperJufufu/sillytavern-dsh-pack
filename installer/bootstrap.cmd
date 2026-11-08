@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
set "SELF=%~f0"
set "PACK_ARGS=%*"
set "TMPD=%TEMP%\ST-DSH-Pack-%RANDOM%%RANDOM%"
echo.
echo   ============================================
echo    SillyTavern DSH Pack - Setup (bootstrap)
echo   ============================================
echo.
if not exist "%TMPD%" mkdir "%TMPD%" >nul 2>nul
echo   [1/2] Extracting installer payload ...
set "PSB64=@@PSB64@@"
powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand %PSB64%
set "RC=%ERRORLEVEL%"
if exist "%TMPD%" rmdir /s /q "%TMPD%" >nul 2>nul
echo.
if not "%RC%"=="0" (
  echo   Installer exited with code %RC%.
  echo   Logs: %TEMP%\dsh-pack-install-*.log
  pause
)
exit /b %RC%
::PAYLOAD
