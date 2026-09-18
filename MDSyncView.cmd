@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo [MDSyncView] 未找到 Node.js，请安装 Node.js 24 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo [MDSyncView] 正在安装依赖...
  call npm install --no-audit --no-fund || exit /b 1
)
if not exist "dist\client\index.html" (
  echo [MDSyncView] 正在构建前端...
  call npm run build || exit /b 1
)
echo [MDSyncView] 启动中... 关闭此窗口即可退出。
node --no-warnings server\src\index.ts %*
