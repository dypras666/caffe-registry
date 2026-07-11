#!/bin/bash
# Auto-sync local changes to production server
# Usage: ./sync.sh [file|dir]  or  ./sync.sh (sync all)

SERVER="root@46.8.226.36"
PASS="h8I8odYa5fzi"
REMOTE="/opt/cafe-registry"
SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password"
RSYNC="sshpass -p '$PASS' rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' -e 'ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password'"

sync_file() {
  local file="$1"
  local remote_path="$REMOTE/${file}"
  echo "→ Syncing: $file"
  eval "$RSYNC '$file' $SERVER:$remote_path"
}

sync_dir() {
  local dir="$1"
  echo "→ Syncing dir: $dir"
  eval "$RSYNC '$dir/' $SERVER:$REMOTE/$dir/"
}

restart_registry() {
  echo "→ Restarting registry..."
  eval "$SSH $SERVER 'PID=\$(ss -tlnp | grep 3001 | grep -oP \"pid=\K[0-9]+\" | head -1); [ -n \"\$PID\" ] && kill \$PID && sleep 1; cd $REMOTE && PORT=3001 nohup node server.js > /var/log/cafe-registry.log 2>&1 & sleep 4 && ss -tlnp | grep 3001 && echo UP || echo FAIL'" 2>/dev/null | grep -v "WARNING\|post-quantum\|session"
}

# If specific file/dir passed
if [ -n "$1" ]; then
  if [ -d "$1" ]; then
    sync_dir "$1"
  else
    sync_file "$1"
  fi

  # Auto-restart if JS file
  if [[ "$1" == *.js ]] || [[ "$1" == *.json ]]; then
    restart_registry
  fi
else
  # Sync all key directories
  echo "=== Full sync to $SERVER ==="
  for dir in routes services templates; do
    sync_dir "$dir"
  done
  for file in server.js init.js; do
    sync_file "$file"
  done

  # Sync frontend build
  if [ -d "public" ]; then
    sync_dir "public"
    echo "→ Frontend deployed"
  fi

  restart_registry
fi

echo "✅ Sync complete"
