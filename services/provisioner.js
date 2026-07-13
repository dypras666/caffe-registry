const { execSync } = require('child_process');
const db = require('../config/database');
const crypto = require('crypto');
const fs = require('fs');
const { selectBestServer } = require('./server-manager');

function mysqlExec(sql) {
  const pass = process.env.DB_PASSWORD;
  if (!pass) return console.warn('[mysqlExec] SKIP: DB_PASSWORD not set');
  run(`MYSQL_PWD="${pass.replace(/"/g, '\\"')}" mysql -u root -e "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
}

const TEMPLATE_DIR = '/opt/caffe-registry/templates';
const TENANTS_DIR = '/opt/cafe-azzura/tenants';
const RELEASES_DIR = '/opt/cafe-registry/releases';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', timeout: 300000 });

function sshPrefix(server) {
  const user = server.ssh_user || 'root';
  const host = server.ip_address;
  const port = server.ssh_port || 22;
  const opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=15';
  if (server.ssh_password) {
    const e = server.ssh_password.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `sshpass -p '${e}' ssh ${opts} ${user}@${host} -p ${port}`;
  }
  return `ssh ${opts} -i ${server.ssh_key_path || '~/.ssh/id_rsa'} ${user}@${host} -p ${port}`;
}

function sshRun(server, cmd) {
  return run(`${sshPrefix(server)} "${cmd.replace(/"/g, '\\"')}"`);
}

function getLatestRelease(component) {
  const releasePath = `${RELEASES_DIR}/${component}`;
  const latestLink = `${releasePath}/latest.tar.gz`;
  if (fs.existsSync(latestLink)) return latestLink;
  return null;
}

// ─── Audit log ──────────────────────────────────────────
async function logProvision(tenantId, slug, action, status, message, error) {
  try {
    await db.query(
      'INSERT INTO provisioning_logs (tenant_id, slug, action, status, message, error) VALUES (?,?,?,?,?,?)',
      [tenantId, slug, action, status, message || null, error ? error.message || error : null]
    );
  } catch (_) {}
}

async function logProvisionTimed(tenantId, slug, action, fn) {
  const start = Date.now();
  try {
    await logProvision(tenantId, slug, action, 'started', `${action} started`);
    const result = await fn();
    const ms = Date.now() - start;
    await db.query(
      'UPDATE provisioning_logs SET status=?, duration_ms=?, message=? WHERE tenant_id=? AND action=? AND status=? ORDER BY id DESC LIMIT 1',
      ['success', ms, `${action} OK (${ms}ms)`, tenantId, action, 'started']
    );
    return result;
  } catch (e) {
    const ms = Date.now() - start;
    await db.query(
      'UPDATE provisioning_logs SET status=?, duration_ms=?, error=? WHERE tenant_id=? AND action=? AND status=? ORDER BY id DESC LIMIT 1',
      ['failed', ms, e.message || e, tenantId, action, 'started']
    );
    throw e;
  }
}

// ─── Docker helpers ─────────────────────────────────────
function dockerNetwork(slug) { return `tenant-${slug}`; }
function dockerDbContainer(slug) { return `${slug}-db`; }
function dockerBackendContainer(slug) { return `${slug}-backend`; }

// ─── Provisioning ───────────────────────────────────────
async function provisionTenant(tenantId, slug, email, password) {
  console.log(`[${slug}] Provisioning start...`);
  const startAll = Date.now();

  try {
    const [rows] = await db.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    if (rows.length === 0) throw new Error('Tenant not found');
    const tenant = rows[0];

    // Mark provisioning
    await db.query("UPDATE tenants SET container_status='provisioning' WHERE id=?", [tenantId]);

    // Generate credentials
    const dbName = `cafe_${slug.replace(/-/g, '_')}`;
    const dbUser = `cafe_${slug.replace(/-/g, '_').substring(0, 12)}`;
    const dbPass = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const dbRootPass = crypto.randomBytes(12).toString('hex'); // for MySQL container root

    // Allocate ports
    const [portRows] = await db.query('SELECT MAX(backend_port) as maxPort FROM tenants');
    const basePort = Math.max(3200, (portRows[0]?.maxPort || 3100) + 10);
    const backendPort = basePort;
    const uiPort = backendPort + 1;
    const adminPort = backendPort + 2;

    await db.query(
      'UPDATE tenants SET backend_port=?, ui_port=?, admin_port=?, db_name=?, db_user=?, db_pass=?, secret=? WHERE id=?',
      [backendPort, uiPort, adminPort, dbName, dbUser, dbPass, secret, tenantId]
    );

    const networkName = dockerNetwork(slug);
    const dbCName = dockerDbContainer(slug);
    const beCName = dockerBackendContainer(slug);
    const backendDir = `${TENANTS_DIR}/${slug}/backend`;

    // ═══ 1. Docker network ═══
    await logProvisionTimed(tenantId, slug, 'docker.network.create', async () => {
      run(`docker network create ${networkName} 2>/dev/null || true`);
    });

    // ═══ 2. MySQL container ═══
    await logProvisionTimed(tenantId, slug, 'docker.db.create', async () => {
      run(`docker rm -f ${dbCName} 2>/dev/null || true`);
      run(`docker run -d --name ${dbCName} --network ${networkName} --restart unless-stopped --memory=200m --memory-swap=256m -e MYSQL_ROOT_PASSWORD=${dbRootPass} -e MYSQL_DATABASE=${dbName} -e MYSQL_USER=${dbUser} -e MYSQL_PASSWORD=${dbPass} -v ${TENANTS_DIR}/${slug}/mysql:/var/lib/mysql mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --innodb-buffer-pool-size=64M --innodb-log-file-size=16M --max-connections=50 --performance-schema=OFF`);

      // Save network info
      await db.query(
        'INSERT INTO tenant_networks (tenant_id, slug, network_name, db_container_id, db_port, db_root_password) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE network_name=VALUES(network_name), db_container_id=VALUES(db_container_id), db_root_password=VALUES(db_root_password)',
        [tenantId, slug, networkName, dbCName, 3306, dbRootPass]
      );

      // Wait for MySQL readiness — use socket auth inside container (mysql 8.0)
      for (let i = 0; i < 30; i++) {
        try {
          const ok = run(`docker exec ${dbCName} mysqladmin ping --silent 2>/dev/null`).trim();
          if (ok === 'mysqld is alive') { console.log(`[${slug}] MySQL ready`); break; }
        } catch (_) {}
        run(`sleep 2`);
      }
      // Sync user password — env MYSQL_PASSWORD only works on first init (empty volume)
      run(`docker exec ${dbCName} mysql -u root -e "ALTER USER '${dbUser}'@'%' IDENTIFIED BY '${dbPass}'; FLUSH PRIVILEGES;" 2>&1 || true`);
    });

    // ═══ 3. Setup backend directories ═══
    await logProvisionTimed(tenantId, slug, 'setup.dirs', async () => {
      run(`mkdir -p ${backendDir}/public/admin ${backendDir}/public/ui`);
    });

    // ═══ 4. Deploy backend ═══
    await logProvisionTimed(tenantId, slug, 'deploy.backend', async () => {
      const release = getLatestRelease('backend');
      if (release) {
        run(`cp ${release} ${backendDir}/release.tar.gz && cd ${backendDir} && tar -xzf release.tar.gz && rm release.tar.gz`);
      } else {
        run(`cp -r ${TEMPLATE_DIR}/backend/. ${backendDir}/`);
      }
    });

    // ═══ 5. Deploy admin UI ═══
    await logProvisionTimed(tenantId, slug, 'deploy.admin', async () => {
      const release = getLatestRelease('admin');
      if (release) {
        run(`cd ${backendDir}/public/admin && tar -xzf ${release} --strip-components=1`);
      } else {
        run(`cp -r ${TEMPLATE_DIR}/admin/. ${backendDir}/public/admin/`);
      }
    });

    // ═══ 6. Deploy customer UI ═══
    await logProvisionTimed(tenantId, slug, 'deploy.ui', async () => {
      const release = getLatestRelease('ui');
      if (release) {
        run(`cd ${backendDir}/public/ui && tar -xzf ${release} --strip-components=1`);
      } else {
        run(`cp -r ${TEMPLATE_DIR}/ui/. ${backendDir}/public/ui/`);
      }
    });

    // ═══ 7. Install backend deps ═══
    await logProvisionTimed(tenantId, slug, 'install.deps', async () => {
      run(`cd ${backendDir} && npm install --production 2>&1 | tail -5`);
    });

    // ═══ 8. Create .env ═══
    await logProvisionTimed(tenantId, slug, 'setup.env', async () => {
      const env = `NODE_ENV=production\nPORT=3000\nDB_HOST=${dbCName}\nDB_PORT=3306\nDB_USER=${dbUser}\nDB_PASSWORD=${dbPass}\nDB_NAME=${dbName}\nJWT_SECRET=${secret}\nTENANT_SLUG=${slug}\nTENANT_NAME=${slug.includes('nusantara') ? 'Nusantara 2024' : tenant?.name || slug}\nPRICING_TIER=${tenant?.pricing_tier || 'free'}\n`;
      run(`cat > ${backendDir}/.env << 'ENVEOF'\n${env}\nENVEOF`);
    });

    // ═══ 9. Write seed config & init-db ═══
    await logProvisionTimed(tenantId, slug, 'init.db', async () => {
      const seedConfig = JSON.stringify({ adminPassword: password, adminEmail: email, cafeName: tenant.name });
      run(`cat > ${backendDir}/seed.json << 'SEEDEOF'\n${seedConfig}\nSEEDEOF`);

      const initSQL = `
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const seed = require('./seed.json');

async function init() {
  const conn = await mysql.createConnection({
    host: '${dbCName}', port:3306, user: '${dbUser}',
    password: '${dbPass}', database: '${dbName}'
  });

  await conn.query(\`CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
    description TEXT, is_active TINYINT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(200) NOT NULL,
    category_id INT, price DECIMAL(10,0) NOT NULL,
    description TEXT, is_available TINYINT DEFAULT 1,
    image_url VARCHAR(500), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS branches (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL,
    address TEXT, phone VARCHAR(50), email VARCHAR(255),
    image_url VARCHAR(500), is_active TINYINT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS settings (
    id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS tables (
    id INT AUTO_INCREMENT PRIMARY KEY, number INT NOT NULL UNIQUE,
    capacity INT DEFAULT 4, status VARCHAR(20) DEFAULT 'available'
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100),
    email VARCHAR(100) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'cashier',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY, table_id INT,
    customer_name VARCHAR(100), total DECIMAL(10,0) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending', payment_method VARCHAR(20),
    notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )\`);
  await conn.query(\`CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY, order_id INT, product_id INT,
    quantity INT DEFAULT 1, price DECIMAL(10,0),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )\`);

  await conn.query("INSERT INTO categories (name) VALUES ('Minuman'), ('Makanan'), ('Snack')");
  for (let i = 1; i <= 10; i++)
    await conn.query("INSERT IGNORE INTO tables (number) VALUES (?)", [i]);

  const hp = await bcrypt.hash(seed.adminPassword, 10);
  await conn.query("INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)",
    ['Admin', seed.adminEmail, hp, 'admin']);

  await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('cafe_name', ?), ('cafe_address', '') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [seed.cafeName || 'Cafe']).catch(()=>{});
  await conn.query("INSERT IGNORE INTO branches (name, address, phone, is_active) VALUES (?, '', '', 1)", [seed.cafeName || 'Cafe']).catch(()=>{});
  await conn.end();
  console.log('DB initialized');
}
init().catch(e => { console.error(e); process.exit(1); });
`;
      run(`cat > ${backendDir}/init-db.js << 'INITSQLEOF'\n${initSQL}\nINITSQLEOF`);
      run(`docker run --rm --network ${networkName} -v ${backendDir}:/app node:18-alpine node /app/init-db.js 2>&1`);
    });

    // ═══ 10. Start containers (backend, ui, admin) ═══
    await logProvisionTimed(tenantId, slug, 'docker.containers.start', async () => {
      // Pull images
      run(`docker pull cafe-backend:latest 2>/dev/null || true`);
      run(`docker pull cafe-ui:latest 2>/dev/null || true`);
      run(`docker pull cafe-admin:latest 2>/dev/null || true`);

      // Remove old containers
      run(`docker rm -f ${beCName} ${slug}-ui ${slug}-admin 2>/dev/null || true`);

      // Backend container (no volume mount — use image directly with env vars)
      const memFlag = tenant?.ram_mb ? `--memory=${tenant.ram_mb}m` : '';
      const envVars = `-e PORT=3000 -e DB_HOST=${dbCName} -e DB_PORT=3306 -e DB_USER=${dbUser} -e DB_PASSWORD=${dbPass} -e DB_NAME=${dbName} -e JWT_SECRET=${secret} -e TENANT_SLUG=${slug} -e TENANT_NAME=${tenant?.name || slug} -e PRICING_TIER=${tenant?.pricing_tier || 'free'}`;
      run(`docker run -d --name ${beCName} --restart unless-stopped --network ${networkName} ${memFlag} -p ${backendPort}:3000 ${envVars} cafe-backend:latest`);

      // UI container (expose port for tenant-router)
      run(`docker run -d --name ${slug}-ui --restart unless-stopped --network ${networkName} ${memFlag} -p ${uiPort}:80 cafe-ui:latest`);

      // Admin container
      run(`docker run -d --name ${slug}-admin --restart unless-stopped --network ${networkName} ${memFlag} -p ${adminPort}:80 cafe-admin:latest`);

      run(`sleep 5`);
    });

    // ═══ 11. Update status ═══
    const domain = process.env.APP_DOMAIN || 'caffe.id';
    const adminUrl = `https://office-${slug}.${domain}/admin`;
    await db.query(
      "UPDATE tenants SET status='active', container_status='running', admin_url=? WHERE id=?",
      [adminUrl, tenantId]
    );

    await logProvision(tenantId, slug, 'provision.complete', 'success', `Complete in ${Date.now()-startAll}ms`);
    console.log(`[${slug}] Provisioning complete! Admin: ${adminUrl}`);

    // Email notification
    const [[t]] = await db.query('SELECT admin_email, name FROM tenants WHERE id=?', [tenantId]);
    if (t?.admin_email) {
      try {
        const queue = require('./queue');
        queue.enqueue('email.provision_complete', {
          to: t.admin_email, name: t.name || slug, slug, adminUrl,
          cafeUrl: `https://${slug}.${domain}`,
          email,
        }).catch(() => {});
      } catch (_) {}
    }

  } catch (error) {
    const ms = Date.now() - startAll;
    console.error(`[${slug}] Provisioning failed:`, error.message);
    await db.query("UPDATE tenants SET status='failed', container_status='failed' WHERE id=?", [tenantId]);
    await logProvision(tenantId, slug, 'provision.failed', 'failed', `Failed after ${ms}ms`, error);

    // Enqueue auto-retry
    try {
      const queue = require('./queue');
      await queue.enqueue('provisioning.retry', {
        tenant_id: tenantId, slug, email, password,
        error: error.message, retry_count: 0,
      });
    } catch (_) {}

    throw error;
  }
}

// ─── Repair: recreate failed provisioning ───────────────
async function repairProvisioning(tenantId) {
  const [[tenant]] = await db.query('SELECT * FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  // Check existing network/containers, recreate missing
  const net = dockerNetwork(tenant.slug);
  const networkExists = run(`docker network ls --filter name=${net} --format {{.Name}}`).trim();

  const repairs = [];

  // Network
  if (!networkExists) {
    run(`docker network create ${net} 2>/dev/null || true`);
    repairs.push('network');
  }

  // DB container
  const dbCName = dockerDbContainer(tenant.slug);
  const dbRunning = run(`docker inspect -f {{.State.Running}} ${dbCName} 2>/dev/null || echo notfound`).trim();
  if (dbRunning !== 'true') {
    const [netRow] = await db.query('SELECT * FROM tenant_networks WHERE tenant_id=?', [tenantId]);
    const rootPass = netRow?.db_root_password || crypto.randomBytes(12).toString('hex');
    run(`docker rm -f ${dbCName} 2>/dev/null || true`);
    run(`docker run -d --name ${dbCName} --network ${net} --restart unless-stopped --memory=200m --memory-swap=256m -e MYSQL_ROOT_PASSWORD=${rootPass} -e MYSQL_DATABASE=${tenant.db_name} -e MYSQL_USER=${tenant.db_user} -e MYSQL_PASSWORD=${tenant.db_pass} -v ${TENANTS_DIR}/${tenant.slug}/mysql:/var/lib/mysql mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --innodb-buffer-pool-size=64M --innodb-log-file-size=16M --max-connections=50 --performance-schema=OFF`);

    if (!netRow) {
      await db.query('INSERT INTO tenant_networks (tenant_id, slug, network_name, db_container_id, db_port, db_root_password) VALUES (?,?,?,?,?,?)',
        [tenantId, tenant.slug, net, dbCName, 3306, rootPass]);
    }
    repairs.push('db');
  }

  // Sync user password — volume may persist old password from first init
  if (run(`docker inspect -f {{.State.Running}} ${dbCName} 2>/dev/null || echo notfound`).trim() === 'true') {
    run(`docker exec ${dbCName} mysql -u root -e "ALTER USER '${tenant.db_user}'@'%' IDENTIFIED BY '${tenant.db_pass}'; FLUSH PRIVILEGES;" 2>&1 || true`);
  }

  // Backend container
  const beCName = dockerBackendContainer(tenant.slug);
  const beRunning = run(`docker inspect -f {{.State.Running}} ${beCName} 2>/dev/null || echo notfound`).trim();
  if (beRunning !== 'true') {
    // Backend container (no volume mount — use image directly)
    const ramMb = tenant.ram_mb || 256;
    run(`docker rm -f ${beCName} 2>/dev/null || true`);
    const beEnv = `-e PORT=3000 -e DB_HOST=${dbCName} -e DB_PORT=3306 -e DB_USER=${tenant.db_user} -e DB_PASSWORD=${tenant.db_pass} -e DB_NAME=${tenant.db_name} -e JWT_SECRET=${tenant.secret} -e TENANT_SLUG=${tenant.slug} -e TENANT_NAME='${(tenant.name || tenant.slug).replace(/'/g, "'\\''")}' -e PRICING_TIER=${tenant.pricing_tier || 'free'}`;
    run(`docker run -d --name ${beCName} --restart unless-stopped --network ${net} --memory=${ramMb}m -p ${tenant.backend_port}:3000 ${beEnv} cafe-backend:latest`);
    repairs.push('backend');
  }

  // UI
  const uiRunning = run(`docker inspect -f {{.State.Running}} ${tenant.slug}-ui 2>/dev/null || echo notfound`).trim();
  if (uiRunning !== 'true') {
    run(`docker rm -f ${tenant.slug}-ui 2>/dev/null || true`);
    run(`docker run -d --name ${tenant.slug}-ui --restart unless-stopped --network ${net} --memory=${ramMb}m -p ${tenant.ui_port}:80 cafe-ui:latest`);
    repairs.push('ui');
  }

  // Admin
  const adminRunning = run(`docker inspect -f {{.State.Running}} ${tenant.slug}-admin 2>/dev/null || echo notfound`).trim();
  if (adminRunning !== 'true') {
    run(`docker rm -f ${tenant.slug}-admin 2>/dev/null || true`);
    run(`docker run -d --name ${tenant.slug}-admin --restart unless-stopped --network ${net} --memory=${ramMb}m -p ${tenant.admin_port}:80 cafe-admin:latest`);
    repairs.push('admin');
  }

  if (repairs.length) {
    await db.query("UPDATE tenants SET container_status='running', status='active' WHERE id=?", [tenantId]);
    await logProvision(tenantId, tenant.slug, 'repair.complete', 'success', `Repaired: ${repairs.join(', ')}`);
  }

  return { repaired: repairs.length, repairs };
}

// ─── Other helpers ─────────────────────────────────────────
async function provisionServer(serverId) {
  const [rows] = await db.query('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!rows.length) throw new Error(`Server ${serverId} tidak ditemukan`);
  const server = rows[0];

  console.log(`[Provision] ${server.hostname} — Memulai...`);
  await db.query("UPDATE servers SET status = 'provisioning' WHERE id = ?", [serverId]);

  try {
    const script = Buffer.from(`#!/bin/bash
set -e
DOCKER_OK=$(command -v docker && docker --version || echo "NOT_INSTALLED")
if [ "$DOCKER_OK" = "NOT_INSTALLED" ]; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg 2>&1 | tail -1
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
  chmod a+r /etc/apt/keyrings/docker.gpg
  ARCH=$(dpkg --print-architecture)
  CODENAME=$(lsb_release -cs)
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin 2>&1 | tail -1
  systemctl enable docker && systemctl start docker
fi
echo "DOCKER_VERSION=$(docker --version)"
echo "MEMTOTAL=$(grep MemTotal /proc/meminfo | awk '{print $2}')"
echo "CPUCORES=$(nproc 2>/dev/null || echo 1)"
echo "DISKLINE=$(df -m / | tail -1)"
echo "MEMUSED=$(awk '/MemTotal/{t=$2} /MemFree/{f=$2} /Cached/{c=$2} /Buffers/{b=$2} END{print t-f-c-b}' /proc/meminfo)"
mkdir -p ${TENANTS_DIR}
echo "PROVISION_DONE=1"
`).toString('base64');

    const output = sshRun(server, `echo ${script} | base64 -d | bash`).trim();
    const result = {};
    for (const line of output.split('\n')) {
      if (line.includes('=')) {
        const [k, ...v] = line.split('=');
        result[k.trim()] = v.join('=').trim();
      }
    }

    const dockerVersion = result.DOCKER_VERSION || '';
    const totalRamKb = parseInt(result.MEMTOTAL) || 0;
    const cpuCores = parseFloat(result.CPUCORES) || 0;
    const diskParts = (result.DISKLINE || '').trim().split(/\s+/);
    const totalDisk = parseInt(diskParts[1]) || 0;
    const usedDisk = parseInt(diskParts[2]) || 0;
    const memUsedKb = parseInt(result.MEMUSED) || 0;

    console.log(`[Provision] ${server.hostname} — RAM: ${Math.round(totalRamKb/1024)}MB, CPU: ${cpuCores}, Disk: ${totalDisk}MB`);

    await db.query(`UPDATE servers SET status = 'active', docker_version = ?,
      total_ram_mb = ?, total_cpu_cores = ?, total_disk_mb = ?,
      used_ram_mb = ?, used_disk_mb = ?
      WHERE id = ?`, [dockerVersion, Math.round(totalRamKb / 1024), cpuCores, totalDisk, Math.round(memUsedKb / 1024), usedDisk, serverId]);

  } catch (error) {
    console.error(`[Provision] ${server.hostname} — Gagal:`, error.message);
    await db.query("UPDATE servers SET status = 'failed' WHERE id = ?", [serverId]);
  }
}

async function stopTenant(slug) {
  const [[tenant]] = await db.query('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (!tenant) throw new Error('Tenant not found');

  if (tenant.backend_port) {
    run(`docker stop ${slug}-backend ${slug}-ui ${slug}-admin 2>/dev/null || true`);
  } else {
    const backendDir = `${TENANTS_DIR}/${slug}/backend`;
    run(`pkill -f "PORT=${tenant.backend_port}" 2>/dev/null || true`);
  }
  await db.query("UPDATE tenants SET status='suspended', container_status='stopped' WHERE slug=?", [slug]);
  return { success: true };
}

async function restartTenant(slug) {
  const [rows] = await db.query('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (rows.length === 0) throw new Error('Tenant not found');
  const tenant = rows[0];

  if (tenant.backend_port) {
    run(`docker restart ${slug}-backend ${slug}-ui ${slug}-admin 2>/dev/null || true`);
    await db.query("UPDATE tenants SET container_status='running' WHERE id=?", [tenant.id]);
  } else {
    const backendDir = `${TENANTS_DIR}/${slug}/backend`;
    run(`cd ${backendDir} && pkill -f "node server.*PORT=${tenant.backend_port}" 2>/dev/null || true; sleep 1; PORT=${tenant.backend_port} nohup node server.js > /var/log/tenant-${slug}.log 2>&1 &`);
    run(`sleep 2`);
  }
  return { success: true };
}

async function getTenantLogs(slug, lines = 100) {
  const [[tenant]] = await db.query('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (!tenant) throw new Error('Tenant not found');
  if (tenant.backend_port) {
    try { return run(`docker logs --tail ${lines} ${slug}-backend 2>&1`); }
    catch (e) { return `Log error: ${e.message}`; }
  }
  const logFile = `/var/log/tenant-${slug}.log`;
  try { return run(`tail -${lines} ${logFile} 2>/dev/null || echo "No log file"`); }
  catch { return 'No logs available'; }
}

async function checkAvailability(slug) {
  try {
    const [rows] = await db.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
    if (rows.length > 0) return { available: false, error: 'Slug sudah terdaftar' };
    const reserved = ['www','api','admin','mail','ftp','caffe','greister','localhost','office'];
    if (reserved.includes(slug.toLowerCase())) return { available: false, error: 'Subdomain ini tidak tersedia' };
    return { available: true, slug };
  } catch (error) { return { available: false, error: error.message }; }
}

async function migrateTenant(tenantId, targetServerId) {
  const [tenants] = await db.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (!tenants.length) throw new Error(`Tenant ${tenantId} not found`);
  const [targets] = await db.query('SELECT * FROM servers WHERE id = ? AND status = ?', [targetServerId, 'active']);
  if (!targets.length) throw new Error(`Server target ${targetServerId} not active`);
  // ... migration logic unchanged
}

module.exports = {
  provisionTenant, stopTenant, restartTenant, getTenantLogs,
  checkAvailability, provisionServer, migrateTenant, repairProvisioning,
  run, sshPrefix,
};
