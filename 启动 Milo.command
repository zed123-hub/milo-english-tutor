#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先从 https://nodejs.org 安装 Node.js 22.13 或更高版本，再重新打开。'
  read '?按回车关闭…'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm ci
fi
npm run build
echo '打开浏览器访问 http://localhost:3000/。关闭这个终端会停止导师服务。'
npm start
