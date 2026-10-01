@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  dsh-browser 一键卸载（双击即可）
rem
rem  默认只摘除插件本体，保留给浏览器用的目录联接，也不动你的浏览器数据。
rem  想连浏览器目录联接一起清掉：
rem      uninstall.cmd --purge
rem  只想看会改什么、不动手：
rem      uninstall.cmd --dry-run
rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node。请先安装 Node.js（https://nodejs.org/），或把 node 加进 PATH。
  echo.
  pause
  exit /b 1
)

echo 即将卸载 dsh-browser 插件。
echo （只摘除插件与链接，不会删除你的浏览器数据。）
echo.
choice /c YN /m "确定继续吗"
if errorlevel 2 (
  echo 已取消。
  timeout /t 2 >nul
  exit /b 1
)

echo.
node "%~dp0uninstall.mjs" %*
echo.
echo 按任意键关闭本窗口。
pause >nul
exit /b 0
