@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================
echo   RiftBroadcast Windows 打包
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 安装依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 依赖已安装，跳过 npm install。
)

echo [2/2] 生成 NSIS 安装包...
call npm run dist
if errorlevel 1 (
  echo [警告] NSIS 安装包生成失败，尝试生成免安装目录 release\win-unpacked ...
  call npm run dist:dir
  if errorlevel 1 (
    echo [错误] 打包失败。请检查网络（electron-builder 首次打包需下载 NSIS 组件）。
    pause
    exit /b 1
  )
  echo.
  echo [完成] 已生成免安装版本：release\win-unpacked\RiftBroadcast.exe
  echo [注意] NSIS 安装包未生成，请把失败原因记录到 DEVELOPMENT_LOG.md。
  pause
  exit /b 0
)

echo.
echo [完成] 安装包位于 release 目录（RiftBroadcast Setup *.exe）。
pause
