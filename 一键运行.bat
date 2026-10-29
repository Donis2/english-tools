@echo off
chcp 65001 >nul
setlocal
title English Tool
cd /d "%~dp0"

set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY (
  where py >nul 2>&1 && set "PY=py -3"
)

if not defined PY (
  echo.
  echo [ERROR] Python 3 not found.
  echo Install Python 3 and check "Add to PATH".
  echo https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

if not exist "site\index.html" (
  echo.
  echo [ERROR] site\index.html not found.
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================
echo    English Tool - starting local server
echo   ============================================
echo.
echo   A free port will be chosen and the browser will open.
echo   Close this window to stop the server.
echo.

%PY% "%~dp0start.py" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [ERROR] Startup failed. See the message above.
)

echo.
echo Server stopped.
pause
endlocal
