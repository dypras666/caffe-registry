#!/bin/bash
# Auto-deploy cafe-registry (backend)
set -e

DIR="/opt/cafe-registry"
LOG="/var/log/cafe-deploy.log"

echo "[$(date +'%Y-%m-%d %H:%M:%S')] Deploy starting..." >> "$LOG"

cd "$DIR"
git fetch origin main 2>&1 >> "$LOG"
git reset --hard origin/main 2>&1 >> "$LOG"

npm install --production 2>&1 >> "$LOG"

# Kill old server
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# Start new server — survives SSH disconnect
setsid node server.js >> /var/log/cafe-registry.log 2>&1 &
PID=$!
sleep 2

if kill -0 $PID 2>/dev/null; then
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] Deploy OK — PID $PID" >> "$LOG"
  echo "Deploy OK — PID $PID"
else
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] Deploy FAIL — server not running" >> "$LOG"
  echo "FAIL"
  exit 1
fi
