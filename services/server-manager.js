const db = require('../config/database');

async function selectBestServer(tenantTier) {
  const [servers] = await db.query(`
    SELECT *,
      (used_ram_mb / NULLIF(total_ram_mb, 0)) AS usage_pct
    FROM servers
    WHERE status = 'active'
    ORDER BY current_tenants ASC, usage_pct ASC
  `);

  const tierResources = { free: { ram: 64, cpu: 0.25, disk: 500 }, starter: { ram: 256, cpu: 0.5, disk: 2000 }, business: { ram: 1024, cpu: 2, disk: 10000 }, enterprise: { ram: 4096, cpu: 4, disk: 50000 } };

  const needed = tierResources[tenantTier] || tierResources.free;

  return servers.find(s => (s.total_ram_mb - s.used_ram_mb) >= needed.ram
    && (s.total_cpu_cores - s.used_cpu_cores) >= needed.cpu
    && (s.total_disk_mb - s.used_disk_mb) >= needed.disk
  ) || null;
}

async function updateServerResourceUsage(serverId, deltaRam, deltaCpu, deltaDisk, deltaTenants = 1) {
  await db.query(
    `UPDATE servers SET
      used_ram_mb = GREATEST(used_ram_mb + ?, 0),
      used_cpu_cores = GREATEST(used_cpu_cores + ?, 0),
      used_disk_mb = GREATEST(used_disk_mb + ?, 0),
      current_tenants = GREATEST(current_tenants + ?, 0)
    WHERE id = ?`,
    [deltaRam, deltaCpu, deltaDisk, deltaTenants, serverId]
  );
}

async function getAutoScaleConfig() {
  const [rows] = await db.query('SELECT * FROM scaling_config');
  const config = {};
  for (const r of rows) config[r.config_key] = r.config_value;
  return config;
}

async function getScalingOverview() {
  const [servers] = await db.query('SELECT * FROM servers ORDER BY created_at ASC');
  const [tenants] = await db.query("SELECT server_id, COUNT(*) as count FROM tenants WHERE status NOT IN ('inactive','failed') GROUP BY server_id");

  const tenantMap = {};
  for (const t of tenants) tenantMap[t.server_id] = t.count;

  const overview = servers.map(s => {
    const ageHours = s.created_at ? (Date.now() - new Date(s.created_at)) / 3600000 : 0;
    return {
      id: s.id,
      hostname: s.hostname,
      ip_address: s.ip_address,
      status: s.status,
      usage_ram_pct: s.total_ram_mb > 0 ? Math.round((s.used_ram_mb / s.total_ram_mb) * 100) : 0,
      usage_cpu_pct: s.total_cpu_cores > 0 ? Math.round((s.used_cpu_cores / s.total_cpu_cores) * 100) : 0,
      usage_disk_pct: s.total_disk_mb > 0 ? Math.round((s.used_disk_mb / s.total_disk_mb) * 100) : 0,
      tenants: tenantMap[s.id] || 0,
      max_tenants: s.max_tenants,
      last_heartbeat: s.last_heartbeat,
      region: s.region,
      age_hours: Math.round(ageHours * 10) / 10,
    };
  });

  const activeServers = overview.filter(s => s.status === 'active');

  return {
    servers: overview,
    summary: {
      total: overview.length,
      active: activeServers.length,
      healthy: activeServers.filter(s => s.last_heartbeat && Date.now() - new Date(s.last_heartbeat) < 300000).length,
      draining: overview.filter(s => s.status === 'draining').length,
      provisioning: overview.filter(s => s.status === 'provisioning').length,
      failed: overview.filter(s => s.status === 'failed').length,
    },
  };
}

module.exports = { selectBestServer, updateServerResourceUsage, getAutoScaleConfig, getScalingOverview };
