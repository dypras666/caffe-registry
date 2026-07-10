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

const TEMPLATE_DIR = '/opt/cafe-registry/templates';
const TENANTS_DIR = '/opt/cafe-azzura/tenants';
const RELEASES_DIR = '/opt/cafe-registry/releases';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', timeout: 300000 });

function sshPrefix(server) {
  const user = server.ssh_user || 'root';
  const host = server.ip_address;
  const port = server.ssh_port || 22;
  const opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=15';
  if (server.ssh_password) {
    const escaped = server.ssh_password.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `sshpass -p '${escaped}' ssh ${opts} ${user}@${host} -p ${port}`;
  }
  return `ssh ${opts} -i ${server.ssh_key_path || '~/.ssh/id_rsa'} ${user}@${host} -p ${port}`;
}

function sshRun(server, cmd) {
  return run(`${sshPrefix(server)} "${cmd.replace(/"/g, '\\"')}"`);
}

function getLatestRelease(component) {
  const releasePath = `${RELEASES_DIR}/${component}`;
  const latestLink = `${releasePath}/latest.tar.gz`;
  if (fs.existsSync(latestLink)) {
    return latestLink;
  }
  return null;
}

async function provisionTenant(tenantId, slug, email, password) {
  console.log(`[${slug}] Starting provisioning...`);

  try {
    const [rows] = await db.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    if (rows.length === 0) throw new Error('Tenant not found');

    const tenant = rows[0];

    // Select server
    const server = await selectBestServer(tenant.pricing_tier || 'free');
    if (server) {
      await db.query('UPDATE tenants SET server_id = ?, container_status = ? WHERE id = ?', [server.id, 'provisioning', tenantId]);
    }

    // Generate credentials
    const dbName = `cafe_${slug.replace(/-/g, '_')}`;
    const dbUser = `cafe_${slug.replace(/-/g, '_').substring(0, 12)}`;
    const dbPass = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');

    // Allocate ports
    const [portRows] = await db.query('SELECT MAX(backend_port) as maxPort FROM tenants');
    const basePort = Math.max(3200, (portRows[0]?.maxPort || 3100) + 10);
    const backendPort = basePort;

    await db.query(
      'UPDATE tenants SET backend_port=?, db_name=?, db_user=?, db_pass=?, secret=? WHERE id=?',
      [backendPort, dbName, dbUser, dbPass, secret, tenantId]
    );

    const dbHost = server ? server.ip_address : '127.0.0.1';
    const backendDir = `${TENANTS_DIR}/${slug}/backend`;

    // 1. Create database
    console.log(`[${slug}] Creating database...`);
    mysqlExec(`DROP USER IF EXISTS '${dbUser}'@'localhost'; DROP USER IF EXISTS '${dbUser}'@'%';`);
    mysqlExec(`CREATE DATABASE IF NOT EXISTS \\\`${dbName}\\\`; CREATE USER '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}'; GRANT ALL PRIVILEGES ON \\\`${dbName}\\\`.* TO '${dbUser}'@'localhost'; FLUSH PRIVILEGES;`);

    // 2. Setup directories
    console.log(`[${slug}] Setting up directories...`);
    run(`mkdir -p ${backendDir}/public/admin ${backendDir}/public/ui`);

    // 3. Deploy backend from release
    console.log(`[${slug}] Deploying backend...`);
    const backendRelease = getLatestRelease('backend');
    if (backendRelease) {
      run(`cp ${backendRelease} ${backendDir}/release.tar.gz && cd ${backendDir} && tar -xzf release.tar.gz && rm release.tar.gz`);
    } else {
      run(`cp -r ${TEMPLATE_DIR}/backend/. ${backendDir}/`);
    }

    // Create .env
    const backendEnv = `NODE_ENV=production\nPORT=${backendPort}\nDB_HOST=${dbHost}\nDB_USER=${dbUser}\nDB_PASSWORD=${dbPass}\nDB_NAME=${dbName}\nJWT_SECRET=${secret}\nTENANT_SLUG=${slug}\n`;
    run(`cat > ${backendDir}/.env << 'ENVEOF'\n${backendEnv}\nENVEOF`);

    // 4. Deploy admin UI from release
    console.log(`[${slug}] Deploying admin UI...`);
    const adminRelease = getLatestRelease('admin');
    if (adminRelease) {
      run(`cd ${backendDir}/public/admin && tar -xzf ${adminRelease} --strip-components=1`);
    } else {
      run(`cp -r ${TEMPLATE_DIR}/admin/. ${backendDir}/public/admin/`);
    }

    // 5. Deploy customer UI from release
    console.log(`[${slug}] Deploying customer UI...`);
    const uiRelease = getLatestRelease('ui');
    if (uiRelease) {
      run(`cd ${backendDir}/public/ui && tar -xzf ${uiRelease} --strip-components=1`);
    } else {
      run(`cp -r ${TEMPLATE_DIR}/ui/. ${backendDir}/public/ui/`);
    }

    // 6. Install backend deps
    console.log(`[${slug}] Installing dependencies...`);
    run(`cd ${backendDir} && npm install --production 2>&1 | tail -5`);

    // 7. Initialize database
    console.log(`[${slug}] Initializing database...`);

    // Write seed config as JSON (safe from shell injection)
    const seedConfig = JSON.stringify({ adminPassword: password, adminEmail: email });
    run(`cat > ${backendDir}/seed.json << 'SEEDEOF'\n${seedConfig}\nSEEDEOF`);

    const initSQL = `
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const seed = require('./seed.json');

async function init() {
  const conn = await mysql.createConnection({
    host: '${dbHost}',
    user: '${dbUser}',
    password: '${dbPass}',
    database: '${dbName}'
  });

  await conn.query(\`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      is_active TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await conn.query(\`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      category_id INT,
      price DECIMAL(10,0) NOT NULL,
      description TEXT,
      is_available TINYINT DEFAULT 1,
      image_url VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  \`);

  await conn.query(\`
    CREATE TABLE IF NOT EXISTS tables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      number INT NOT NULL UNIQUE,
      capacity INT DEFAULT 4,
      status VARCHAR(20) DEFAULT 'available'
    )
  \`);

  await conn.query(\`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'cashier',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await conn.query(\`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      table_id INT,
      customer_name VARCHAR(100),
      total DECIMAL(10,0) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      payment_method VARCHAR(20),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await conn.query(\`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT,
      product_id INT,
      quantity INT DEFAULT 1,
      price DECIMAL(10,0),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  \`);

  // Seed categories
  await conn.query("INSERT INTO categories (name) VALUES ('Minuman'), ('Makanan'), ('Snack')");

  // Seed tables
  for (let i = 1; i <= 10; i++) {
    await conn.query("INSERT IGNORE INTO tables (number) VALUES (?)", [i]);
  }

  // Create admin user
  const hashedPassword = await bcrypt.hash(seed.adminPassword, 10);
  await conn.query("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
    ['Admin', seed.adminEmail, hashedPassword, 'admin']);

  await conn.end();
  console.log('Database initialized');
}

init().catch(e => { console.error(e); process.exit(1); });
`;

    run(`cat > ${backendDir}/init-db.js << 'INITSQLEOF'\n${initSQL}\nINITSQLEOF`);
    run(`cd ${backendDir} && node init-db.js 2>&1`);

    // 8. Start backend
    console.log(`[${slug}] Starting backend...`);
    run(`cd ${backendDir} && PORT=${backendPort} nohup node server.js > /var/log/tenant-${slug}.log 2>&1 &`);
    run(`sleep 5`);

    // 9. Update status
    const adminUrl = `https://office-${slug}.caffe.my.id/admin`;
    await db.query("UPDATE tenants SET status='active', admin_url=? WHERE id=?", [adminUrl, tenantId]);

    console.log(`[${slug}] Provisioning complete! Admin: ${adminUrl}`);

  } catch (error) {
    console.error(`[${slug}] Provisioning failed:`, error.message);
    await db.query("UPDATE tenants SET status='failed' WHERE id=?", [tenantId]);
    throw error;
  }
}

async function checkAvailability(slug) {
  try {
    const [rows] = await db.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
    if (rows.length > 0) return { available: false, error: 'Slug sudah terdaftar' };

    const reserved = ['www', 'api', 'admin', 'mail', 'ftp', 'caffe', 'greister', 'localhost', 'office'];
    if (reserved.includes(slug.toLowerCase())) {
      return { available: false, error: 'Subdomain ini tidak tersedia' };
    }

    return { available: true, slug };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

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

    await db.query(`
      UPDATE servers SET status = 'active', docker_version = ?,
        total_ram_mb = ?, total_cpu_cores = ?, total_disk_mb = ?,
        used_ram_mb = ?, used_disk_mb = ?
      WHERE id = ?
    `, [dockerVersion, Math.round(totalRamKb / 1024), cpuCores, totalDisk, Math.round(memUsedKb / 1024), usedDisk, serverId]);

  } catch (error) {
    console.error(`[Provision] ${server.hostname} — Gagal:`, error.message);
    await db.query("UPDATE servers SET status = 'failed' WHERE id = ?", [serverId]);
  }
}

async function restartTenant(slug) {
  const [rows] = await db.query('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (rows.length === 0) throw new Error('Tenant not found');

  const tenant = rows[0];
  const backendDir = `${TENANTS_DIR}/${slug}/backend`;

  if (tenant.server_id && tenant.container_id) {
    const [server] = await db.query('SELECT * FROM servers WHERE id = ?', [tenant.server_id]);
    if (server.length) {
      sshRun(server[0], `docker restart ${tenant.container_id}`);
    }
  } else {
    run(`cd ${backendDir} && pkill -f "PORT=${tenant.backend_port}" 2>/dev/null; PORT=${tenant.backend_port} nohup node server.js > /var/log/tenant-${slug}.log 2>&1 &`);
    run(`sleep 2`);
  }

  return { success: true };
}

async function migrateTenant(tenantId, targetServerId) {
  const [tenants] = await db.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (!tenants.length) throw new Error(`Tenant ${tenantId} tidak ditemukan`);
  const tenant = tenants[0];

  const [targets] = await db.query('SELECT * FROM servers WHERE id = ? AND status = ?', [targetServerId, 'active']);
  if (!targets.length) throw new Error(`Server target ${targetServerId} tidak aktif`);
  const target = targets[0];

  console.log(`[Migrate] ${tenant.slug} → ${target.hostname}...`);
  await db.query("UPDATE tenants SET container_status = 'migrating' WHERE id = ?", [tenantId]);

  if (tenant.server_id) {
    const [oldServers] = await db.query('SELECT * FROM servers WHERE id = ?', [tenant.server_id]);
    if (oldServers.length && tenant.container_id) {
      try { sshRun(oldServers[0], `docker stop ${tenant.container_id} && docker rm ${tenant.container_id}`); }
      catch (e) { console.log(`[Migrate] ${tenant.slug} — Stop warning: ${e.message}`); }
    }
  }

  const containerName = `tenant-${tenant.slug}`;
  const dbHost = target.ip_address;
  const backendDir = `${TENANTS_DIR}/${tenant.slug}/backend`;

  try {
    sshRun(target, `mkdir -p ${TENANTS_DIR}/${tenant.slug}`);
    run(`rsync -avz --delete -e "ssh -o StrictHostKeyChecking=no" ${TENANTS_DIR}/${tenant.slug}/ ${target.ssh_user}@${target.ip_address}:${TENANTS_DIR}/${tenant.slug}/`);
  } catch (e) {
    console.log(`[Migrate] ${tenant.slug} — Rsync warning: ${e.message}`);
  }

  const dockerRun = `docker run -d --name ${containerName} --restart unless-stopped \
    --memory "${tenant.ram_mb || 64}m" --cpus "${tenant.cpu_cores || 0.25}" \
    -p ${tenant.backend_port}:3000 -v ${TENANTS_DIR}/${tenant.slug}/backend:/app -w /app \
    -e PORT=3000 -e DB_HOST=${dbHost} -e DB_USER=${tenant.db_user} -e DB_PASSWORD=${tenant.db_pass} \
    -e DB_NAME=${tenant.db_name} -e JWT_SECRET=${tenant.secret} -e TENANT_SLUG=${tenant.slug} \
    node:20-alpine node server.js`;

  const containerId = sshRun(target, dockerRun).trim();

  await db.query('UPDATE tenants SET server_id = ?, container_id = ?, container_status = ? WHERE id = ?',
    [targetServerId, containerId, 'running', tenantId]);

  console.log(`[Migrate] ${tenant.slug} — Selesai.`);
  return { success: true, containerId };
}

async function drainServer(serverId) {
  const [servers] = await db.query('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!servers.length) throw new Error(`Server ${serverId} tidak ditemukan`);

  console.log(`[Drain] ${servers[0].hostname} — Memindahkan tenant...`);
  await db.query("UPDATE servers SET status = 'draining' WHERE id = ?", [serverId]);

  const [tenants] = await db.query("SELECT * FROM tenants WHERE server_id = ? AND status NOT IN ('inactive','failed')", [serverId]);

  if (!tenants.length) {
    await db.query("UPDATE servers SET status = 'inactive' WHERE id = ?", [serverId]);
    return { success: true, message: 'Server dinonaktifkan (0 tenant)' };
  }

  const { updateServerResourceUsage } = require('./server-manager');

  for (const tenant of tenants) {
    const target = await selectBestServer(tenant.pricing_tier || 'free');
    if (!target) {
      console.log(`[Drain] Tidak ada server tujuan untuk ${tenant.slug}`);
      continue;
    }
    try {
      await migrateTenant(tenant.id, target.id);
      if (tenant.server_id) {
        await updateServerResourceUsage(tenant.server_id, -(tenant.ram_mb || 64), -(tenant.cpu_cores || 0.25), -500, -1);
      }
      await updateServerResourceUsage(target.id, tenant.ram_mb || 64, tenant.cpu_cores || 0.25, 500, 1);
    } catch (e) {
      console.error(`[Drain] Migrate ${tenant.slug} gagal:`, e.message);
    }
  }

  const [remaining] = await db.query("SELECT COUNT(*) as count FROM tenants WHERE server_id = ? AND status NOT IN ('inactive','failed')", [serverId]);
  if (remaining[0].count === 0) {
    await db.query("UPDATE servers SET status = 'inactive' WHERE id = ?", [serverId]);
  }

  return { success: true, migrated: tenants.length };
}

module.exports = { provisionTenant, provisionServer, checkAvailability, restartTenant, migrateTenant, drainServer, sshRun };
