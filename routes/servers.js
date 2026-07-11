const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { provisionServer, drainServer, migrateTenant } = require('../services/provisioner');
const { superadminAuth } = require('../services/auth');

// SSE auth middleware — accepts token from query param (EventSource limitation)
const sseAuth = (req, res, next) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).end();
  try {
    const jwt = require('jsonwebtoken');
    const { getSecret } = require('../services/auth');
    const decoded = jwt.verify(token, getSecret());
    if (decoded.role !== 'superadmin') return res.status(403).end();
    req.user = decoded;
    next();
  } catch { res.status(401).end(); }
};

// GET /api/servers/stream — SSE realtime server stats
// Must be before /:id to avoid route conflict
router.get('/stream', sseAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/caddy buffering
  res.flushHeaders();

  const send = async () => {
    try {
      const [servers] = await db.query(`
        SELECT s.*,
          COUNT(t.id) AS tenant_count,
          TIMESTAMPDIFF(SECOND, s.last_heartbeat, NOW()) AS seconds_since_hb
        FROM servers s
        LEFT JOIN tenants t ON t.server_id = s.id AND t.status NOT IN ('inactive','failed')
        GROUP BY s.id
        ORDER BY s.created_at ASC
      `);

      // Enrich with live ping for each active server
      const enriched = await Promise.all(servers.map(async (s) => {
        let ping_ms = null;
        if (s.status === 'active' && s.ip_address) {
          const start = Date.now();
          try {
            const http = require('http');
            await new Promise((resolve, reject) => {
              const req = http.get(
                `http://${s.ip_address}:${s.ssh_port || 22}`,
                { timeout: 2000 },
                resolve
              );
              req.on('error', resolve); // TCP connect/refuse = server reachable
              req.on('timeout', reject);
              setTimeout(resolve, 2000); // max 2s
            });
            ping_ms = Date.now() - start;
          } catch { ping_ms = null; }
        }

        return {
          id: s.id,
          hostname: s.hostname,
          ip_address: s.ip_address,
          status: s.status,
          region: s.region,
          docker_version: s.docker_version,
          total_ram_mb: s.total_ram_mb,
          used_ram_mb: s.used_ram_mb,
          total_cpu_cores: s.total_cpu_cores,
          used_cpu_cores: s.used_cpu_cores,
          total_disk_mb: s.total_disk_mb,
          used_disk_mb: s.used_disk_mb,
          max_tenants: s.max_tenants,
          current_tenants: parseInt(s.tenant_count || 0),
          last_heartbeat: s.last_heartbeat,
          seconds_since_hb: s.seconds_since_hb,
          ping_ms,
          online: s.seconds_since_hb !== null && s.seconds_since_hb < 120,
        };
      }));

      res.write(`data: ${JSON.stringify({ servers: enriched, ts: Date.now() })}\n\n`);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
  };

  // Send immediately then every 5 seconds
  send();
  const interval = setInterval(send, 5000);

  // Cleanup on disconnect
  req.on('close', () => clearInterval(interval));
  res.on('close', () => clearInterval(interval));
});

// GET /api/servers — list all servers
router.get('/', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM servers ORDER BY created_at DESC');
    res.json({ servers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id — detail
router.get('/:id', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });
    const server = rows[0];

    const [tenants] = await db.query(
      'SELECT id, name, slug, status, pricing_tier, backend_port, container_status FROM tenants WHERE server_id = ?',
      [req.params.id]
    );

    res.json({ ...server, tenants });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers — register a new server
router.post('/', superadminAuth, async (req, res) => {
  try {
    const { hostname, ip_address, ssh_port, ssh_user, ssh_key_path, max_tenants, region, labels } = req.body;

    if (!hostname || !ip_address) {
      return res.status(400).json({ error: 'hostname dan ip_address wajib' });
    }

    const [existing] = await db.query('SELECT id FROM servers WHERE hostname = ? OR ip_address = ?', [hostname, ip_address]);
    if (existing.length) return res.status(409).json({ error: 'Server dengan hostname atau IP tersebut sudah terdaftar' });

    const [result] = await db.query(
      `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, ssh_key_path, ssh_password, max_tenants, region, labels, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning')`,
      [hostname, ip_address, ssh_port || 22, ssh_user || 'root', ssh_key_path || null, req.body.ssh_password || null, max_tenants || 20, region || 'default', labels || null]
    );

    const serverId = result.insertId;
    res.status(201).json({ id: serverId, hostname, ip_address, status: 'provisioning' });

    // Auto-provision di background
    provisionServer(serverId).catch(err => console.error(`[Provision] Server ${serverId} failed:`, err.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/servers/:id — update server
router.put('/:id', superadminAuth, async (req, res) => {
  try {
    const fields = ['hostname', 'ip_address', 'ssh_port', 'ssh_user', 'ssh_key_path', 'ssh_password', 'max_tenants', 'region', 'status', 'labels'];
    const updates = [];
    const values = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(req.body[f]);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    await db.query(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`, values);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers/:id/heartbeat — update resource usage (called by agent)
router.post('/:id/heartbeat', (req, res, next) => {
  const expected = process.env.AGENT_API_KEY || process.env.JWT_SECRET;
  if (!expected) return res.status(500).json({ error: 'AGENT_API_KEY not configured' });
  const key = req.headers['x-api-key'];
  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}, async (req, res) => {
  try {
    const { used_ram_mb, used_cpu_cores, used_disk_mb, current_tenants, docker_version } = req.body;

    const updates = ['last_heartbeat = NOW()'];
    const values = [];

    if (used_ram_mb !== undefined) { updates.push('used_ram_mb = ?'); values.push(used_ram_mb); }
    if (used_cpu_cores !== undefined) { updates.push('used_cpu_cores = ?'); values.push(used_cpu_cores); }
    if (used_disk_mb !== undefined) { updates.push('used_disk_mb = ?'); values.push(used_disk_mb); }
    if (current_tenants !== undefined) { updates.push('current_tenants = ?'); values.push(current_tenants); }
    if (docker_version !== undefined) { updates.push('docker_version = ?'); values.push(docker_version); }

    values.push(req.params.id);
    await db.query(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`, values);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers/:id/drain — drain server with auto-migration
router.post('/:id/drain', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, hostname FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });

    res.json({ success: true, message: 'Drain sedang diproses di background...' });

    drainServer(req.params.id).catch(err =>
      console.error(`[Drain] Server ${req.params.id} error:`, err.message)
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers/:id/migrate/:tenantId — migrate single tenant to this server
router.post('/:id/migrate/:tenantId', superadminAuth, async (req, res) => {
  try {
    const result = await migrateTenant(req.params.tenantId, req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id/tenants — list tenants on this server
router.get('/:id/tenants', superadminAuth, async (req, res) => {
  try {
    const [tenants] = await db.query(
      `SELECT id, name, slug, status, pricing_tier, balance, backend_port, created_at
       FROM tenants WHERE server_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ tenants });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/servers/:id/logs — provisioning log file
router.get('/:id/logs', superadminAuth, async (req, res) => {
  try {
    const [[server]] = await db.query('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // Try to get recent tenant provisioning logs on this server
    const [tenants] = await db.query(
      "SELECT slug FROM tenants WHERE server_id = ? AND status IN ('active','failed') ORDER BY updated_at DESC LIMIT 5",
      [req.params.id]
    );

    const fs = require('fs');
    const lines = parseInt(req.query.lines) || 200;
    const logs = [];

    // Registry-level log
    const registryLog = '/var/log/cafe-registry.log';
    if (fs.existsSync(registryLog)) {
      const { execSync } = require('child_process');
      try {
        const content = execSync(`tail -${lines} ${registryLog} 2>/dev/null`).toString();
        logs.push({ source: 'registry', content });
      } catch (_) {}
    }

    // Per-tenant logs
    for (const t of tenants) {
      const logFile = `/var/log/tenant-${t.slug}.log`;
      if (fs.existsSync(logFile)) {
        const { execSync } = require('child_process');
        try {
          const content = execSync(`tail -50 ${logFile} 2>/dev/null`).toString();
          logs.push({ source: `tenant:${t.slug}`, content });
        } catch (_) {}
      }
    }

    res.json({ server, logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/servers/:id — decommission
router.delete('/:id', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });

    // Check if any tenants assigned
    const [tenants] = await db.query("SELECT COUNT(*) AS cnt FROM tenants WHERE server_id = ? AND status NOT IN ('inactive','failed')", [req.params.id]);
    if (tenants[0].cnt > 0) return res.status(400).json({ error: 'Server masih memiliki tenant. Pindahkan tenant dulu.' });

    await db.query('DELETE FROM servers WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Server dihapus' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers/:id/activate — set active
router.post('/:id/activate', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });
    await db.query("UPDATE servers SET status = 'active' WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: 'Server diaktifkan' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/servers/:id/deactivate — set inactive
router.post('/:id/deactivate', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });
    await db.query("UPDATE servers SET status = 'inactive' WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: 'Server dinonaktifkan' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/servers/:id/refresh — ping server, detect OS, update stats live
router.post('/:id/refresh', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });
    const s = rows[0];
    if (!s.ip_address) return res.status(400).json({ error: 'No IP address' });

    const { execSync } = require('child_process');
    const user = s.ssh_user || 'root';
    const port = s.ssh_port || 22;
    const opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=10';
    let prefix;
    if (s.ssh_password) {
      const esc = s.ssh_password.replace(/\\/g,'\\\\\\\\').replace(/'/g,"'\\''").replace(/"/g,'\\\\"').replace(/`/g,'\\\\`').replace(/\$/g,'\\\\$');
      prefix = `sshpass -p '${esc}' ssh ${opts} ${user}@${s.ip_address} -p ${port}`;
    } else {
      prefix = `ssh ${opts} -i ${s.ssh_key_path || '~/.ssh/id_rsa'} ${user}@${s.ip_address} -p ${port}`;
    }

    const script = Buffer.from(
`echo "OS=$(cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2 | tr -d '\"')"
echo "CPU=$(nproc)"
echo "RAM_TOTAL=$(grep MemTotal /proc/meminfo | awk '{print $2}')"
echo "RAM_USED=$(awk '/MemTotal/{t=$2} /MemFree/{f=$2} /Cached/{c=$2} /Buffers/{b=$2} END{print t-f-c-b}' /proc/meminfo)"
echo "DISK_TOTAL=$(df -m / | tail -1 | awk '{print $2}')"
echo "DISK_USED=$(df -m / | tail -1 | awk '{print $3}')"
echo "DOCKER=$(docker --version 2>/dev/null || echo 'none')"
echo "HOSTNAME=$(hostname -f 2>/dev/null || hostname)"`
    ).toString('base64');

    const out = execSync(`${prefix} "echo ${script} | base64 -d | bash"`, { encoding: 'utf8', timeout: 15000 });
    const data = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^(\w+)=(.+)/);
      if (m) data[m[1]] = m[2].trim();
    }

    const ramTotal = parseInt(data.RAM_TOTAL) || 0;
    const ramUsed = parseInt(data.RAM_USED) || 0;
    const diskTotal = parseInt(data.DISK_TOTAL) || 0;
    const diskUsed = parseInt(data.DISK_USED) || 0;
    const cpuCores = parseFloat(data.CPU) || 0;
    const osName = data.OS || s.os || null;

    await db.query(`
      UPDATE servers SET
        used_ram_mb = ?, used_disk_mb = ?, total_ram_mb = ?,
        total_cpu_cores = ?, total_disk_mb = ?,
        docker_version = ?, os = ?,
        hostname = COALESCE(NULLIF(?, ''), hostname),
        last_heartbeat = NOW(), status = 'active'
      WHERE id = ?
    `, [
      Math.round(ramUsed / 1024), diskUsed, Math.round(ramTotal / 1024),
      cpuCores, diskTotal, data.DOCKER || null, osName,
      data.HOSTNAME || null, req.params.id
    ]);

    // Count containers for CPU estimate
    try {
      const cOut = execSync(`${prefix} "docker ps -q 2>/dev/null | wc -l"`, { encoding: 'utf8', timeout: 5000 }).trim();
      const cc = parseInt(cOut) || 0;
      const usedCpu = Math.min(Math.max(cc * 0.1, 0.25), cpuCores * 0.9);
      await db.query('UPDATE servers SET used_cpu_cores = ? WHERE id = ?', [usedCpu, req.params.id]);
    } catch {}

    const [updated] = await db.query('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    res.json({ success: true, server: updated[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
