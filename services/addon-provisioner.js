const { exec } = require('child_process');
const db = require('../config/database');

const run = (cmd) => new Promise((resolve, reject) => {
  exec(cmd, { shell: '/bin/bash', timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) return reject(err);
    resolve(stdout.trim());
  });
});

async function provision(tenantId, tenantAddonId, addon) {
  const [tenants] = await db.query('SELECT * FROM tenants WHERE id=?', [tenantId]);
  if (!tenants.length) throw new Error('Tenant not found');
  const tenant = tenants[0];
  if (!addon.image) return;

  const slug = tenant.slug;
  const subdomain = `${addon.subdomain_prefix || addon.slug}-${slug}`;

  await db.query("UPDATE tenant_addons SET provision_status='provisioning', subdomain=? WHERE id=?", [subdomain, tenantAddonId]);

  const [usedPorts] = await db.query('SELECT MAX(container_port_real) AS mx FROM tenant_addons WHERE container_port_real IS NOT NULL');
  const hostPort = (usedPorts[0]?.mx || 3002) + 1;

  const envs = [];
  try {
    const parsed = JSON.parse(addon.env_vars || '{}');
    for (const [k, v] of Object.entries(parsed))
      envs.push('-e', `${k}=${v}`);
  } catch {}
  const adminPass = require('crypto').randomBytes(12).toString('hex');
  envs.push('-e', `ADMIN_PASSWORD=${adminPass}`);

  const name = `addon-${slug}-${addon.slug}`;
  const img = `${addon.image}:${addon.image_tag || 'latest'}`;

  // Run in background — don't block
  run(`docker rm -f ${name} 2>/dev/null; true && docker pull ${img} 2>&1 | tail -1 && docker run -d --restart unless-stopped --name ${name} -p ${hostPort}:${addon.container_port} ${envs.join(' ')} ${img}`).then(async (output) => {
    const containerId = output.split('\n').pop().trim();
    console.log(`[addon-provision] ${subdomain}: container=${containerId} port=${hostPort}`);
    await db.query("UPDATE tenant_addons SET provision_status='running', container_id=?, container_port_real=? WHERE id=?", [containerId, hostPort, tenantAddonId]);
  }).catch(async (e) => {
    console.error(`[addon-provision] FAIL ${subdomain}: ${e.message}`);
    await db.query("UPDATE tenant_addons SET provision_status='error' WHERE id=?", [tenantAddonId]);
  });
}

async function deprovision(tenantAddonId) {
  const [rows] = await db.query(`
    SELECT ta.*, t.slug AS tenant_slug, a.slug AS addon_slug
    FROM tenant_addons ta
    JOIN tenants t ON ta.tenant_id=t.id
    JOIN addons a ON ta.addon_id=a.id
    WHERE ta.id=?`, [tenantAddonId]);
  if (!rows.length) return;
  const row = rows[0];

  if (row.container_id) {
    run(`docker rm -f ${row.container_id} 2>/dev/null`).catch(() => {});
  }

  await db.query(
    "UPDATE tenant_addons SET provision_status='attached', container_id=NULL, container_port_real=NULL, subdomain=NULL WHERE id=?",
    [tenantAddonId]
  );
}

module.exports = { provision, deprovision };
