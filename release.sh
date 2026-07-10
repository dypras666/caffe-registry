#!/bin/bash
# Release script - Build and deploy cafe-azura apps to server
# Usage: ./release.sh [server]

set -e

SERVER="${1:-root@46.8.226.36}"
RELEASES_DIR="/opt/cafe-registry/releases"
TEMP_DIR="/tmp/cafe-release-$$"

echo "=== Cafe Azzura Release Script ==="
echo "Target: $SERVER"

echo ""
echo "=== Building Components ==="

# Backend
echo "Building backend..."
BACKEND_DIR="$HOME/development/cafe-backend"
cd "$BACKEND_DIR"

# Admin
echo "Building admin..."
ADMIN_DIR="$HOME/development/cafe-admin"
cd "$ADMIN_DIR"
npm install 2>&1 | tail -3
npm run build 2>&1 | tail -5

# UI - symlink vite if needed
echo "Building ui..."
UI_DIR="$HOME/development/cafe-ui"
cd "$UI_DIR"

if [ ! -d "node_modules/vite" ]; then
  mkdir -p node_modules
  ln -sf "$HOME/development/cafe-admin/node_modules/vite" node_modules/vite
  mkdir -p node_modules/@vitejs
  ln -sf "$HOME/development/cafe-admin/node_modules/@vitejs/plugin-react" node_modules/@vitejs/plugin-react
fi

echo "VITE_API_URL=" > .env
npm run build 2>&1 | tail -5

echo ""
echo "=== Creating Release Packages ==="

mkdir -p "$TEMP_DIR"
rm -rf "$TEMP_DIR"/*

# Package backend
echo "Packaging backend..."
mkdir -p "$TEMP_DIR/backend"
cp -r "$BACKEND_DIR"/* "$TEMP_DIR/backend/" 2>/dev/null || true
cd "$TEMP_DIR/backend" && tar -czf "$TEMP_DIR/backend.tar.gz" --exclude='node_modules/.cache' --exclude='.git' . && cd - > /dev/null

# Package admin
echo "Packaging admin..."
mkdir -p "$TEMP_DIR/admin"
cp -r "$ADMIN_DIR/dist/"* "$TEMP_DIR/admin/" 2>/dev/null || true
cd "$TEMP_DIR/admin" && tar -czf "$TEMP_DIR/admin.tar.gz" . && cd - > /dev/null

# Package ui
echo "Packaging ui..."
mkdir -p "$TEMP_DIR/ui"
cp -r "$UI_DIR/dist/"* "$TEMP_DIR/ui/" 2>/dev/null || true
cd "$TEMP_DIR/ui" && tar -czf "$TEMP_DIR/ui.tar.gz" . && cd - > /dev/null

echo ""
echo "=== Deploying to Server ==="

# Create remote releases dir
sshpass -p 'h8I8odYa5fzi' ssh -o StrictHostKeyChecking=no "$SERVER" "mkdir -p $RELEASES_DIR/{backend,admin,ui}"

# Upload packages
echo "Uploading backend..."
sshpass -p 'h8I8odYa5fzi' scp -o StrictHostKeyChecking=no "$TEMP_DIR/backend.tar.gz" "$SERVER:$RELEASES_DIR/backend/latest.tar.gz"

echo "Uploading admin..."
sshpass -p 'h8I8odYa5fzi' scp -o StrictHostKeyChecking=no "$TEMP_DIR/admin.tar.gz" "$SERVER:$RELEASES_DIR/admin/latest.tar.gz"

echo "Uploading ui..."
sshpass -p 'h8I8odYa5fzi' scp -o StrictHostKeyChecking=no "$TEMP_DIR/ui.tar.gz" "$SERVER:$RELEASES_DIR/ui/latest.tar.gz"

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "=== Release Complete ==="
echo "Run deploy.sh on server to deploy to all tenants"
