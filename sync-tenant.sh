#!/bin/bash
# Sync tenant backend for nusantara2024
# Usage: ./sync-tenant.sh nusantara2024

TENANT="${1:-nusantara2024}"
SERVER="root@46.8.226.36"
TENANT_DIR="/opt/cafe-azzura/tenants/$TENANT/backend"

echo "=== Syncing $TENANT backend ==="

# Build release
cd ~/development/cafe-backend
tar --exclude='node_modules' --exclude='.git' --exclude='coverage' --exclude='__tests__' -czf /tmp/tenant-backend.tar.gz .

# Upload
sshpass -p 'h8I8odYa5fzi' scp -o StrictHostKeyChecking=no /tmp/tenant-backend.tar.gz "$SERVER:$TENANT_DIR/"

# Extract and restart
sshpass -p 'h8I8odYa5fzi' ssh -o StrictHostKeyChecking=no "$SERVER" "
  cd $TENANT_DIR
  tar -xzf tenant-backend.tar.gz
  rm tenant-backend.tar.gz
  npm install 2>&1 | tail -3
  pkill -f 'node.*server' 2>/dev/null
  sleep 2
  nohup node server.js > /var/log/${TENANT}.log 2>&1 &
  sleep 6
  curl -s http://localhost:\$(grep ^PORT .env | cut -d= -f2)/api/health
"

echo "=== Done ==="
