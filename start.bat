@echo off
title Reel Radar — Instagram Viral Intelligence
cd /d "%~dp0"

echo ============================================================
echo            REEL RADAR — Instagram Viral Intelligence        
echo ============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Error: Node.js is not installed or not in your PATH.
  echo Please download and install Node.js from: https://nodejs.org/
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
  echo Installing pnpm...
  call npm install -g pnpm
)

if not exist "node_modules" (
  echo First-time setup: Installing dependencies...
  call pnpm install
)

if not exist "apify-key.txt" if not exist ".env" if not exist "config.json" (
  echo ------------------------------------------------------------
  echo Notice: No 'apify-key.txt' file detected yet.
  echo You can either:
  echo   1. Paste your key in 'apify-key.txt'
  echo   2. Or enter it directly in the Web UI Settings!
  echo ------------------------------------------------------------
)

echo Starting Reel Radar on http://127.0.0.1:3000 ...
start http://127.0.0.1:3000

call pnpm dev
pause
