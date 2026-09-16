@echo off
setlocal
cd /d "%~dp0"

rem ===========================================================
rem  WARDOGS Artillery Calculator - offline launcher
rem  Serves this folder on 127.0.0.1 and opens the browser.
rem  No internet connection is required.
rem
rem  Chinese documentation: docs\offline.md
rem  Stop the server with Ctrl+C or by closing this window.
rem  Extra options are passed through, e.g.:
rem      offline launch  --port 8100
rem ===========================================================

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js 18 or newer is required but "node" was not found.
    echo         Download: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

node scripts\offline-server.mjs %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo The offline server exited with code %EXITCODE%.
    echo.
    pause
)

endlocal
