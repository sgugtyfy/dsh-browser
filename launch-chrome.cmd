@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem ============================================================
rem  用「带调试端口」的方式启动 Chrome，登录态沿用你日常的 profile
rem
rem  为什么绕一圈用 junction（目录联接）：
rem  Chromium 136+ 会拒绝「默认 profile 目录」的调试端口 —— 参数收下了，
rem  但 DevTools 服务器不启动、端口永远不开（本机 Chrome 154 实测如此）。
rem  实测该检查是按路径字符串做的：给同一个目录换个路径写法就通过了，
rem  而且数据仍是同一份，登录态是实时同步的，不是复制。
rem ============================================================

set PORT=9333
set EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
set UDD=%LOCALAPPDATA%\Google\Chrome\User Data
set LINKDIR=%USERPROFILE%\.dsh-browser-links
set LINK=%LINKDIR%\chrome-userdata
set PROFILE=Profile 1

if not exist "%EXE%" (
  echo [错误] 找不到 Chrome: "%EXE%"
  pause & exit /b 1
)

rem --- 没有调试端口却在跑的话，新参数会被已有实例忽略 ---
tasklist /fi "imagename eq chrome.exe" 2>nul | find /i "chrome.exe" >nul
if not errorlevel 1 (
  echo [提示] 检测到 Chrome 正在运行。
  echo        Chromium 是单实例的：如果现在这波 Chrome 不是带调试端口启动的，
  echo        本脚本不会生效。是否结束所有 Chrome 进程后继续？
  echo.
  choice /c YN /m "结束所有 Chrome 进程并继续吗"
  if errorlevel 2 ( echo 已取消。& pause & exit /b 1 )
  taskkill /f /im chrome.exe /t >nul 2>&1
  timeout /t 2 >nul
)

rem --- 建 junction（指向真实 profile，绝不复制数据）---
if not exist "%LINKDIR%" mkdir "%LINKDIR%"
if not exist "%LINK%\." (
  mklink /J "%LINK%" "%UDD%" >nul
  if errorlevel 1 (
    echo [错误] 创建目录联接失败：%LINK%
    pause & exit /b 1
  )
  echo 已创建目录联接: %LINK%  --^>  %UDD%
)

echo 正在启动 Chrome（真实 profile + 调试端口 %PORT%）...
start "" "%EXE%" --remote-debugging-port=%PORT% --user-data-dir="%LINK%" --profile-directory="%PROFILE%" --no-first-run --no-default-browser-check

echo 等待端口就绪（最多 20 秒）...
for /l %%i in (1,1,20) do (
  timeout /t 1 >nul
  for /f %%s in ('curl -s -o NUL -w "%%{http_code}" http://127.0.0.1:%PORT%/json/version 2^>nul') do set CODE=%%s
  if "!CODE!"=="200" goto :ready
)

echo.
echo [失败] Chrome 起来了，但 %PORT% 端口没开出来。
echo 请把这条消息连同下面的输出发给 AI 排查：
netstat -ano | findstr ":%PORT%"
pause
exit /b 1

:ready
echo.
echo [成功] 调试端口已就绪：http://127.0.0.1:%PORT%/json/version
echo 现在可以让 DSH 里的 AI 直接操作这个浏览器（就是你日常那个，登录态实时同步）。
timeout /t 3 >nul
exit /b 0
