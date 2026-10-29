@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title English Tool - Push
cd /d "%~dp0"

set "DRY=0"
if /I "%~1"=="--dry-run" set "DRY=1"
set "NOPAUSE=0"
if /I "%~2"=="--no-pause" set "NOPAUSE=1"

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] git not found. Install Git for Windows first.
  echo.
  pause
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] This folder is not a Git repository.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set "REMOTE=%%r"

if not defined REMOTE (
  echo.
  echo [ERROR] No "origin" remote configured.
  echo Run: git remote add origin ^<repository-url^>
  echo.
  pause
  exit /b 1
)

echo.
echo   Branch: %BRANCH%
echo   Remote: %REMOTE%
echo.

set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain') do set "DIRTY=1"

if defined DIRTY (
  echo   Uncommitted changes:
  echo.
  git -c core.quotepath=false status --short
  echo.

  if "%DRY%"=="1" (
    echo   [dry-run] Skip commit and push.
    goto :done
  )

  set "MSG="
  set /p "MSG=Commit message (Enter for default): "
  if not defined MSG set "MSG=Update project %date% %time%"

  echo.
  echo   Committing ...
  git add -A
  if errorlevel 1 (
    echo   [ERROR] git add failed.
    pause
    exit /b 1
  )

  git commit -m "!MSG!"
  if errorlevel 1 (
    echo   [ERROR] git commit failed.
    pause
    exit /b 1
  )
) else (
  echo   No uncommitted changes. Push existing commits directly.
)

echo.
echo   Pushing to GitHub ...
if "%DRY%"=="1" (
  git push --dry-run
  echo   [dry-run] Checked only. Nothing was pushed.
) else (
  git push -u origin "%BRANCH%"
  if errorlevel 1 (
    echo.
    echo   [ERROR] git push failed. Check network, login and permissions.
    pause
    exit /b 1
  )
)

echo.
where netlify >nul 2>&1
if errorlevel 1 (
  echo   [INFO] netlify CLI not found. Skipped online deploy.
  echo   Install it to deploy automatically: npm install -g netlify-cli
  echo   Or deploy manually: netlify deploy --prod --dir site --functions netlify/functions
) else (
  echo   Deploying to Netlify ...
  if "%DRY%"=="1" (
    echo   [dry-run] netlify deploy --prod --dir site --functions netlify/functions
  ) else (
    netlify deploy --prod --dir site --functions netlify/functions
    if errorlevel 1 (
      echo.
      echo   [WARN] Netlify deploy failed. GitHub push already succeeded.
    )
  )
)

:done
echo.
echo   Done.
if "%NOPAUSE%"=="0" pause
endlocal
