@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8710"

set "FOUND=0"
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% " ^| findstr /i "LISTENING"') do (
  echo   killing pid %%p on port %PORT%
  taskkill /PID %%p /F /T >nul 2>nul
  set "FOUND=1"
)

if "!FOUND!"=="0" (
  echo   nothing is listening on port %PORT%
) else (
  echo   port %PORT% released
)
echo.
pause >nul
