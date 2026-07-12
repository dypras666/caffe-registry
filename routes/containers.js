const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth } = require('../services/auth');
const { execSync } = require('child_process');

// ─── Container name map ────────────────────────────────────
const CONTAINER_META = {
  db:         { name: 'db',         type: 'mysql', image: 'mysql:8.0' },
  'cafe-backend': { name: 'cafe-backend', type: 'node',  image: 'node:20-alpine' },
  'cafe-ui':      { name: 'cafe-ui',      type: 'node',  image: 'node:20-alpine' },
  'cafe-admin':   { name: 'cafe-admin',   type: 'node',  image: 'node:20-alpine' },
};

function containerDockerName(slug, key) {
  const map = { db: `${slug}-db`, 'cafe-backend': `${slug}-backend`, 'cafe-ui': `${slug}-ui`, 'cafe-admin': `${slug}-admin` };
  return map[key];
}

// ─── SSH helpers ───────────────────────────────────────────
function sshPrefix(server) {
  const user = server.ssh_user || 'root';
  const host = server.ip_address;
  const port = server.ssh_port || 22;
  const opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=10';
  if (server.ssh_password) {
    const e = server.ssh_password.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `sshpass -p '${e}' ssh ${opts} ${user}@${host} -p ${port}`;
  }
  return `ssh ${opts} -i ${server.ssh_key_path || '~/.ssh/id_rsa'} ${user}@${host} -p ${port}`;
}

function sshRun(server, cmd) {
  return execSync(
    `${sshPrefix(server)} "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', timeout: 15000 }
  ).trim();
}

// ─── Helpers ───────────────────────────────────────────────
async function getTenantServer(id) {
  const [[t]] = await db.query(
    'SELECT id, slug, ram_mb, backend_port, ui_port, admin_port, server_id FROM tenants WHERE id = ?', [id]
  );
  if (!t) throw new Error('Tenant not found');
  if (!t.server_id) throw new Error('Tenant has no server assigned');
  const [[s]] = await db.query('SELECT * FROM servers WHERE id = ?', [t.server_id]);
  if (!s) throw new Error('Server not found');
  return { tenant: t, server: s };
}

function validateContainer(name) {
  if (!CONTAINER_META[name]) throw new Error(`Unknown container "${name}". Valid: ${Object.keys(CONTAINER_META).join(', ')}`);
}

// ─── GET /api/tenants/:id/containers — list 4 containers ───
router.get('/:id/containers', superadminAuth, async (req, res) => {
  try {
    const { tenant, server } = await getTenantServer(req.params.id);
    const portMap = { db: 3366, 'cafe-backend': tenant.backend_port || 3002, 'cafe-ui': tenant.ui_port || 3003, 'cafe-admin': tenant.admin_port || 3004 };
    const names = ['db', 'cafe-backend', 'cafe-ui', 'cafe-admin'];

    const result = await Promise.all(names.map(async (key) => {
      const dn = containerDockerName(tenant.slug, key);
      let status = 'unknown';
      let cpu = null, memPerc = null, memUsage = null;
      try {
        const out = sshRun(server, `docker inspect -f '{{.State.Status}}' ${dn} 2>/dev/null || echo 'missing'`);
        status = out === 'missing' ? 'stopped' : out;
      } catch { status = 'unknown'; }

      // Get realtime stats via docker stats + memory limit
      let memUsed = null, memLimit = null;
      try {
        const raw = sshRun(server, `docker stats ${dn} --no-stream --format '{{.CPUPerc}}|{{.MemPerc}}|{{.MemUsage}}' 2>/dev/null || true`);
        if (raw && !raw.startsWith('docker:')) {
          const parts = raw.split('|');
          cpu = parts[0] || null;
          memPerc = parts[1] || null;
          if (parts[2]) {
            const m = parts[2].match(/^([\d.]+ ?\w+)/);
            memUsed = m ? m[1] : null;
          }
        }
      } catch { /* stats n/a */ }

      // Memory limit from tenant ram_mb
      memLimit = tenant.ram_mb ? `${tenant.ram_mb}MiB` : null;

      return { ...CONTAINER_META[key], port: portMap[key], status, docker_name: dn, cpu, memPerc, memUsed, memLimit };
    }));

    res.json({ containers: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/tenants/:id/containers/:name/stats — CPU/RAM/disk ───
router.get('/:id/containers/:name/stats', superadminAuth, async (req, res) => {
  try {
    const { tenant, server } = await getTenantServer(req.params.id);
    validateContainer(req.params.name);
    const dn = containerDockerName(tenant.slug, req.params.name);

    let cpu = null, memPerc = null, memUsage = null;
    try {
      const raw = sshRun(server, `docker stats ${dn} --no-stream --format '{{.CPUPerc}}|{{.MemPerc}}|{{.MemUsage}}' 2>/dev/null || true`);
      if (raw) {
        const parts = raw.split('|');
        cpu = parts[0] || null;
        memPerc = parts[1] || null;
        memUsage = parts[2] || null;
      }
    } catch { /* stats not available */ }

    let diskMb = null;
    try {
      const df = sshRun(server, `docker exec ${dn} df -m / 2>/dev/null | tail -1 || true`);
      if (df) {
        const cols = df.trim().split(/\s+/);
        diskMb = { total: parseInt(cols[1]) || null, used: parseInt(cols[2]) || null, available: parseInt(cols[3]) || null };
      }
    } catch { /* disk not available */ }

    res.json({ container: dn, cpu, memPerc, memUsage, diskMb });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/tenants/:id/containers/:name/restart — restart container via SSH ───
router.post('/:id/containers/:name/restart', superadminAuth, async (req, res) => {
  try {
    const { tenant, server } = await getTenantServer(req.params.id);
    validateContainer(req.params.name);
    const dn = containerDockerName(tenant.slug, req.params.name);

    sshRun(server, `docker restart ${dn} 2>&1 || true`);
    res.json({ success: true, container: dn, action: 'restarted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/tenants/:id/containers/:name/logs — tail logs ───
router.get('/:id/containers/:name/logs', superadminAuth, async (req, res) => {
  try {
    const { tenant, server } = await getTenantServer(req.params.id);
    validateContainer(req.params.name);
    const dn = containerDockerName(tenant.slug, req.params.name);
    const lines = parseInt(req.query.lines) || 100;
    const capped = Math.min(lines, 500);

    let logs = '';
    try {
      logs = sshRun(server, `docker logs --tail ${capped} ${dn} 2>&1 || true`);
    } catch { logs = 'No logs available'; }

    res.json({ container: dn, logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/tenants/:id/env — update env vars (DB only, no SSH) ───
router.put('/:id/env', superadminAuth, async (req, res) => {
  try {
    const { vars } = req.body;
    if (!Array.isArray(vars)) return res.status(400).json({ error: 'vars harus array' });

    const [[t]] = await db.query('SELECT id FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant not found' });

    await db.query('DELETE FROM tenant_env_vars WHERE tenant_id = ?', [req.params.id]);
    for (const v of vars) {
      if (!v.key) continue;
      await db.query(
        'INSERT INTO tenant_env_vars (tenant_id, var_key, var_value, is_secret) VALUES (?, ?, ?, ?)',
        [req.params.id, v.key, v.value ?? '', v.is_secret ? 1 : 0]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
