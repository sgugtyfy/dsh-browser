@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem ============================================================
rem  用「带调试端口」的方式启动 Edge，登录态沿用你日常的 profile
rem  原理同 launch-chrome.cmd：用 junction 换一种路径写法，
rem  绕过 Chromium 136+ 对「默认 profile 目录」的调试端口封锁。
rem ============================================================

set PORT=9334
set EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set UDD=%LOCALAPPDATA%\Microsoft\Edge\User Data
set LINKDIR=%USERPROFILE%\.dsh-browser-links
set LINK=%LINKDIR%\edge-userdata
set PROFILE=Profile 7

if not exist "%EXE%" (
  echo [错误] 找不到 Edge: "%EXE%"
  pause & exit /b 1
)

tasklist /fi "imagename eq msedge.exe" 2>nul | find /i "msedge.exe" >nul
if not errorlevel 1 (
  echo [提示] 检测到 Edge 正在运行。Chromium 是单实例的，
  echo        如果现在这波 Edge 不是带调试端口启动的，本脚本不会生效。
  echo.
  choice /c YN /m "结束所有 Edge 进程并继续吗（未保存的表单会丢）"
  if errorlevel 2 ( echo 已取消。& pause & exit /b 1 )
  taskkill /f /im msedge.exe /t >nul 2>&1
  timeout /t 2 >nul
)

if not exist "%LINKDIR%" mkdir "%LINKDIR%"
if not exist "%LINK%\." (
  mklink /J "%LINK%" "%UDD%" >nul
  if errorlevel 1 (
    echo [错误] 创建目录联接失败：%LINK%
    pause & exit /b 1
  )
  echo 已创建目录联接: %LINK%  --^>  %UDD%
)

echo 正在启动 Edge（真实 profile + 调试端口 %PORT%）...
start "" "%EXE%" --remote-debugging-port=%PORT% --user-data-dir="%LINK%" --profile-directory="%PROFILE%" --no-first-run --no-default-browser-check

echo 等待端口就绪（最多 20 秒）...
for /l %%i in (1,1,20) do (
  timeout /t 1 >nul
  for /f %%s in ('curl -s -o NUL -w "%%{http_code}" http://127.0.0.1:%PORT%/json/version 2^>nul') do set CODE=%%s
  if "!CODE!"=="200" goto :ready
)

echo.
echo [失败] Edge 起来了但 %PORT% 端口没开出来。
echo 常见原因：还有 msedge.exe 残留进程占着 profile，或企业策略禁用了远程调试。
netstat -ano | findstr ":%PORT%"
pause
exit /b 1

:ready
echo.
echo [成功] Edge 调试端口已就绪：http://127.0.0.1:%PORT%/json/version
timeout /t 3 >nul
exit /b 0
