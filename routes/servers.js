const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { provisionServer, drainServer, migrateTenant } = require('../services/provisioner');
const { superadminAuth } = require('../services/auth');

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
    const fields = ['hostname', 'ip_address', 'ssh_port', 'ssh_user', 'ssh_key_path', 'max_tenants', 'region', 'status', 'labels'];
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

// DELETE /api/servers/:id — decommission
router.delete('/:id', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, current_tenants FROM servers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Server not found' });
    if (rows[0].current_tenants > 0) return res.status(400).json({ error: 'Server masih memiliki tenant. Drain terlebih dahulu.' });

    await db.query("UPDATE servers SET status = 'inactive' WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: 'Server dinonaktifkan' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
