@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem ============================================================
rem  启动 Edge 并开好远程调试端口（插件作为「桥」连上来）
rem
rem  这是给 AI 用的浏览器：用户在窗口里登录一次，登录态长期保留。
rem  （不用你日常那个 profile —— Chromium 136+ 会拒绝在默认目录上开调试端口，
rem    而用 junction 之类绕过会清空 cookie，实测事故，已废弃。）
rem ============================================================

set PORT=9334
set EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set UDD=%USERPROFILE%\.dsh-browser-profiles\edge
set OLD=%~dp0profiles\edge

if not exist "%EXE%" (
  echo [错误] 找不到 Edge: "%EXE%"
  pause & exit /b 1
)

rem 旧版本把 profile 放在插件包内，这里自动搬一次
if not exist "%UDD%\." if exist "%OLD%\." (
  echo 迁移旧的独立 profile: %OLD%  --^>  %UDD%
  if not exist "%USERPROFILE%\.dsh-browser-profiles" mkdir "%USERPROFILE%\.dsh-browser-profiles"
  move "%OLD%" "%UDD%" >nul
)
if not exist "%UDD%" mkdir "%UDD%"

tasklist /fi "imagename eq msedge.exe" 2>nul | find /i "msedge.exe" >nul
if not errorlevel 1 (
  echo [提示] 检测到 Edge 正在运行。Chromium 是单实例的，本脚本不会生效。
  echo.
  choice /c YN /m "结束所有 Edge 进程并继续吗（未保存的表单会丢）"
  if errorlevel 2 ( echo 已取消。& pause & exit /b 1 )
  taskkill /f /im msedge.exe /t >nul 2>&1
  timeout /t 2 >nul
)

echo 正在启动 Edge（调试端口 %PORT%）
echo   profile: %UDD%
start "" "%EXE%" --remote-debugging-port=%PORT% --user-data-dir="%UDD%" --no-first-run --no-default-browser-check https://www.bilibili.com

echo 等待端口就绪（最多 20 秒）...
for /l %%i in (1,1,20) do (
  timeout /t 1 >nul
  for /f %%s in ('curl -s -o NUL -w "%%{http_code}" http://127.0.0.1:%PORT%/json/version 2^>nul') do set CODE=%%s
  if "!CODE!"=="200" goto :ready
)

echo.
echo [失败] Edge 起来了但 %PORT% 端口没开出来。
netstat -ano | findstr ":%PORT%"
pause
exit /b 1

:ready
echo.
echo [成功] 调试端口已就绪：http://127.0.0.1:%PORT%/json/version
echo.
echo 现在 DSH 里的 AI 可以直接连上这个浏览器了。
echo 需要 AI 帮你操作哪个网站，就在这里登录一次（登录态长期保留）。
timeout /t 5 >nul
exit /b 0
