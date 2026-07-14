#!/bin/bash
# Setup shared MySQL + shared-backend service untuk FREE tenants
# Jalankan sekali saat deploy awal

set -e

SHARED_DB_ROOT_PASS="${SHARED_DB_ROOT_PASS:-$(openssl rand -hex 12)}"
SHARED_DB_PORT="${SHARED_DB_PORT:-3910}"
SHARED_BACKEND_PORT="${SHARED_BACKEND_PORT:-3900}"
DATA_DIR="/opt/cafe-azzura/shared-mysql"

echo "[shared] Starting shared MySQL on port $SHARED_DB_PORT..."

mkdir -p "$DATA_DIR"

# Stop jika sudah ada
docker stop cafe-shared-db 2>/dev/null || true
docker rm   cafe-shared-db 2>/dev/null || true

docker run -d \
  --name cafe-shared-db \
  --restart unless-stopped \
  --memory=300m --memory-swap=400m \
  -p 127.0.0.1:${SHARED_DB_PORT}:3306 \
  -e MYSQL_ROOT_PASSWORD="${SHARED_DB_ROOT_PASS}" \
  -v "${DATA_DIR}:/var/lib/mysql" \
  mysql:8.0 \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_unicode_ci \
  --innodb-buffer-pool-size=128M \
  --max-connections=200 \
  --performance-schema=OFF

echo "[shared] Waiting for MySQL..."
for i in $(seq 1 30); do
  if docker exec cafe-shared-db mysqladmin ping --silent 2>/dev/null; then
    echo "[shared] MySQL ready"
    break
  fi
  sleep 2
done

# Simpan password ke .env registry (jika belum ada)
ENV_FILE="/opt/caffe-registry/.env"
if ! grep -q "SHARED_DB_ROOT_PASS" "$ENV_FILE"; then
  echo "" >> "$ENV_FILE"
  echo "# Shared tier (FREE tenants)" >> "$ENV_FILE"
  echo "SHARED_DB_HOST=127.0.0.1" >> "$ENV_FILE"
  echo "SHARED_DB_PORT=${SHARED_DB_PORT}" >> "$ENV_FILE"
  echo "SHARED_DB_ROOT_PASS=${SHARED_DB_ROOT_PASS}" >> "$ENV_FILE"
  echo "SHARED_BACKEND_PORT=${SHARED_BACKEND_PORT}" >> "$ENV_FILE"
  echo "SHARED_ROUTES_DIR=/opt/cafe-azzura/shared-backend/routes" >> "$ENV_FILE"
  echo "[shared] Env vars written to $ENV_FILE"
fi

# Systemd service untuk shared-backend
cat > /etc/systemd/system/cafe-shared-backend.service << EOF
[Unit]
Description=Caffe.id Shared Backend (FREE tenants)
After=network.target mariadb.service docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/caffe-registry/shared-backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/caffe-registry/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cafe-shared-backend
systemctl restart cafe-shared-backend

echo "[shared] Setup complete!"
echo "  MySQL: 127.0.0.1:${SHARED_DB_PORT} (root pass: ${SHARED_DB_ROOT_PASS})"
echo "  Backend: http://localhost:${SHARED_BACKEND_PORT}"
