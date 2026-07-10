const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth } = require('../services/auth');

// GET /api/autoscaler/config
router.get('/config', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM scaling_config ORDER BY config_key');
    const config = {};
    for (const r of rows) config[r.config_key] = r.config_value;
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/autoscaler/config
router.put('/config', superadminAuth, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await db.query(
        'INSERT INTO scaling_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
        [key, String(value), String(value)]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/autoscaler/status — current scaling overview
router.get('/status', superadminAuth, async (req, res) => {
  try {
    const [servers] = await db.query('SELECT * FROM servers ORDER BY created_at ASC');
    const [tenants] = await db.query("SELECT server_id, COUNT(*) as count FROM tenants WHERE status NOT IN ('inactive','failed') GROUP BY server_id");

    const tenantMap = {};
    for (const t of tenants) tenantMap[t.server_id] = t.count;

    const overview = servers.map(s => ({
      id: s.id,
      hostname: s.hostname,
      status: s.status,
      usage_ram_pct: s.total_ram_mb > 0 ? Math.round((s.used_ram_mb / s.total_ram_mb) * 100) : 0,
      usage_cpu_pct: s.total_cpu_cores > 0 ? Math.round((s.used_cpu_cores / s.total_cpu_cores) * 100) : 0,
      usage_disk_pct: s.total_disk_mb > 0 ? Math.round((s.used_disk_mb / s.total_disk_mb) * 100) : 0,
      tenants: tenantMap[s.id] || 0,
      max_tenants: s.max_tenants,
      last_heartbeat: s.last_heartbeat,
      region: s.region,
    }));

    const activeServers = overview.filter(s => s.status === 'active');
    const healthy = overview.filter(s => s.status === 'active' && s.last_heartbeat && new Date() - new Date(s.last_heartbeat) < 300000);

    res.json({
      servers: overview,
      summary: {
        total: overview.length,
        active: activeServers.length,
        healthy: healthy.length,
        draining: overview.filter(s => s.status === 'draining').length,
        provisioning: overview.filter(s => s.status === 'provisioning').length,
        failed: overview.filter(s => s.status === 'failed').length,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
