@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem ============================================================
rem  启动 Chrome 并开好调试端口（使用插件自带的【独立 profile】）
rem
rem  为什么不直接用你日常的 profile：
rem  Chromium 136+ 会拒绝「默认 profile 目录」的调试端口。早期版本用 junction
rem  换路径写法绕过 —— 实测那会让 Chromium 清空 cookie（登录态全丢），已废弃。
rem  独立 profile 只需要在里面登录一次，之后长期有效，且与你日常浏览器互不影响。
rem ============================================================

set PORT=9333
set EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
set UDD=%~dp0profiles\chrome

if not exist "%EXE%" (
  echo [错误] 找不到 Chrome: "%EXE%"
  pause & exit /b 1
)
if not exist "%UDD%" mkdir "%UDD%"

tasklist /fi "imagename eq chrome.exe" 2>nul | find /i "chrome.exe" >nul
if not errorlevel 1 (
  echo [提示] 检测到 Chrome 正在运行。Chromium 是单实例的，本脚本不会生效。
  echo.
  choice /c YN /m "结束所有 Chrome 进程并继续吗（未保存的表单会丢）"
  if errorlevel 2 ( echo 已取消。& pause & exit /b 1 )
  taskkill /f /im chrome.exe /t >nul 2>&1
  timeout /t 2 >nul
)

echo 正在启动 Chrome
echo   独立 profile: %UDD%
start "" "%EXE%" --remote-debugging-port=%PORT% --user-data-dir="%UDD%" --no-first-run --no-default-browser-check https://www.bing.com

echo 等待端口就绪（最多 20 秒）...
for /l %%i in (1,1,20) do (
  timeout /t 1 >nul
  for /f %%s in ('curl -s -o NUL -w "%%{http_code}" http://127.0.0.1:%PORT%/json/version 2^>nul') do set CODE=%%s
  if "!CODE!"=="200" goto :ready
)

echo.
echo [失败] Chrome 起来了但 %PORT% 端口没开出来。
netstat -ano | findstr ":%PORT%"
pause
exit /b 1

:ready
echo.
echo [成功] 调试端口已就绪：http://127.0.0.1:%PORT%/json/version
echo.
echo 这个窗口用的是独立 profile。需要 AI 帮你操作哪个网站，
echo 就在这里登录一次（登录状态会长期保留，跟你日常浏览器互不影响）。
timeout /t 5 >nul
exit /b 0
