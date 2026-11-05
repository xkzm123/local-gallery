@echo off
chcp 65001 >nul
title Local Gallery
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

set "PORT=8710"
set "LIB=%~1"

rem 拖文件夹到 bat 上时 %~1 带尾反斜杠，拼成 --root="D:\pics\" 后引号会被当转义符，
rem Node 收到的路径末尾多一个引号，目录就被静默忽略了。这里先归一成绝对路径。
if not "%LIB%"=="" call :abs "%LIB%"

echo.
echo   [1/2] Freeing port %PORT% ...
call :killport %PORT%
echo   [2/2] Starting server ...
echo.

if "%LIB%"=="" (
  node server.js --port=%PORT%
) else (
  node server.js --port=%PORT% --root="%LIB%"
)

echo.
echo   Server stopped.
pause >nul
exit /b 0

:killport
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%~1 " ^| findstr /i "LISTENING"') do (
  echo         - killing pid %%p
  taskkill /F /PID %%p /T >nul 2>nul
)
exit /b 0

:abs
rem pushd 会把路径规范化成不带尾反斜杠的绝对路径（UNC 也吃）
pushd "%~1" 2>nul || exit /b 0
set "LIB=%CD%"
popd
exit /b 0

:nonode
echo.
echo   [x] Node.js not found in PATH.
echo       Install LTS from https://nodejs.org and run this again.
echo.
pause
exit /b 1
