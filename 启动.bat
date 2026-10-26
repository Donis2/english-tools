@echo off
title English Tool
cd /d "%~dp0"

set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY ( where py >nul 2>&1 && set "PY=py -3" )

if not defined PY (
  echo.
  echo [Error] Python 3 not found.
  echo Install it from https://www.python.org/downloads/  ^(check "Add to PATH"^)
  echo.
  pause
  exit /b 1
)

:: start.py: picks a free port automatically and opens the browser at the hub page.
:: No need to edit the port or type a URL by hand.
%PY% "%~dp0start.py" --port 8090

echo.
echo Server stopped.
pause >nul
