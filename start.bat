@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Making AI
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js 가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo  ^(또는 이 폴더 안 node\node.exe 위치에 휴대용 Node 를 넣어도 됩니다^)
  echo.
  pause
  exit /b 1
)
"%NODE%" server.js
pause
