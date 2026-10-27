#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "============================================================"
echo "           REEL RADAR — Instagram Viral Intelligence        "
echo "============================================================"
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in your PATH."
  echo "Please install Node.js (LTS version) from: https://nodejs.org/"
  exit 1
fi

# Check for pnpm (or install / enable via corepack or npx)
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not detected globally, attempting to enable via corepack..."
  corepack enable || npm install -g pnpm || true
fi

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "First-time setup: Installing required dependencies..."
  pnpm install || npm install
fi

# Check if Apify key file or .env exists
if [ ! -f "apify-key.txt" ] && [ ! -f ".env" ] && [ ! -f "config.json" ]; then
  echo "------------------------------------------------------------"
  echo "Notice: No 'apify-key.txt' file detected yet."
  echo "You can either:"
  echo "  1. Paste your key in 'apify-key.txt' (from apify-key.example.txt)"
  echo "  2. Or paste it directly in the Web UI Settings once opened!"
  echo "------------------------------------------------------------"
fi

echo "Starting Reel Radar on http://127.0.0.1:3000 ..."
echo "Press Ctrl+C to stop the server."
echo ""

# Try opening the browser in background after 1.5 seconds
(sleep 1.5 && (open "http://127.0.0.1:3000" 2>/dev/null || xdg-open "http://127.0.0.1:3000" 2>/dev/null || true)) &

pnpm dev
