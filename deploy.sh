#!/bin/bash
# Deploy releases to all tenants
# Usage: ./deploy.sh

RELEASES_DIR="/opt/cafe-registry/releases"
TENANTS_DIR="/opt/cafe-azzura/tenants"

echo "=== Deploying Releases to Tenants ==="

# Extract releases
echo "Extracting backend..."
cd "$TENANTS_DIR"
for tenant in */; do
  tenant="${tenant%/}"
  backend_dir="$TENANTS_DIR/$tenant/backend"
  
  if [ -d "$backend_dir" ]; then
    echo "Deploying to $tenant..."
    
    # Deploy admin
    if [ -f "$RELEASES_DIR/admin/latest.tar.gz" ]; then
      mkdir -p "$backend_dir/public/admin"
      tar -xzf "$RELEASES_DIR/admin/latest.tar.gz" -C "$backend_dir/public/admin" --strip-components=1 2>/dev/null || true
    fi
    
    # Deploy ui
    if [ -f "$RELEASES_DIR/ui/latest.tar.gz" ]; then
      mkdir -p "$backend_dir/public/ui"
      tar -xzf "$RELEASES_DIR/ui/latest.tar.gz" -C "$backend_dir/public/ui" --strip-components=1 2>/dev/null || true
    fi
    
    echo "  ✓ $tenant"
  fi
done

echo ""
echo "=== Done ==="
