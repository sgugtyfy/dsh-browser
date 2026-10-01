@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  dsh-browser 一键安装（双击即可）
rem
rem  默认装到 desktop profile；要装到别的 profile：
rem      install.cmd --profile web
rem  只想看会改什么、不动手：
rem      install.cmd --dry-run
rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node。请先安装 Node.js（https://nodejs.org/），或把 node 加进 PATH。
  echo.
  pause
  exit /b 1
)

echo 正在安装 dsh-browser 插件...
echo.
node "%~dp0install.mjs" %*
echo.
echo 按任意键关闭本窗口。
pause >nul
exit /b 0
