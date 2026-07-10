const db = require('../config/database');
const { getAutoScaleConfig } = require('./server-manager');

let scalingInterval = null;
let lastScaleUpAt = 0;

function startAutoScaler() {
  console.log('[AutoScaler] Starting...');
  if (scalingInterval) clearInterval(scalingInterval);
  scalingInterval = setInterval(checkScaling, 60_000);
  checkScaling();
}

function stopAutoScaler() {
  if (scalingInterval) {
    clearInterval(scalingInterval);
    scalingInterval = null;
  }
}

async function checkScaling() {
  try {
    const config = await getAutoScaleConfig();
    const ramThreshold = parseFloat(config.ram_threshold_pct) || 80;
    const cpuThreshold = parseFloat(config.cpu_threshold_pct) || 75;
    const diskThreshold = parseFloat(config.disk_threshold_pct) || 85;
    const maxTenants = parseInt(config.max_tenants_per_server) || 20;
    const maxServers = parseInt(config.max_servers) || 10;
    const cooldownMin = parseInt(config.scale_cooldown_minutes) || 30;
    const heartbeatTimeout = parseInt(config.heartbeat_timeout_seconds) || 300;

    const [servers] = await db.query('SELECT * FROM servers WHERE status = ? OR status = ?', ['active', 'draining']);

    const now = Date.now();

    // --- Scale-Up Check ---
    const needsScaleUp = servers.some(s => {
      if (s.status !== 'active') return false;
      const ramPct = s.total_ram_mb > 0 ? (s.used_ram_mb / s.total_ram_mb) * 100 : 0;
      const cpuPct = s.total_cpu_cores > 0 ? (s.used_cpu_cores / s.total_cpu_cores) * 100 : 0;
      const diskPct = s.total_disk_mb > 0 ? (s.used_disk_mb / s.total_disk_mb) * 100 : 0;
      const tenantCount = s.current_tenants;

      return ramPct > ramThreshold
        || cpuPct > cpuThreshold
        || diskPct > diskThreshold
        || tenantCount >= (maxTenants - 2);
    });

    const [activeCount] = await db.query("SELECT COUNT(*) as count FROM servers WHERE status = 'active'");

    if (needsScaleUp && activeCount[0].count < maxServers && (now - lastScaleUpAt) > cooldownMin * 60_000) {
      console.log('[AutoScaler] Triggering scale-up...');
      await triggerScaleUp(config);
      lastScaleUpAt = now;
    }

    // --- Scale-Down Check (auto-drain underutilized servers) ---
    const autoDrainHours = parseInt(config.auto_drain_hours) || 24;
    const drainBelowPct = parseFloat(config.drain_usage_below_pct) || 20;

    for (const s of servers) {
      if (s.status !== 'active') continue;

      const ageHours = s.created_at ? (now - new Date(s.created_at)) / 3600000 : 0;
      const ramPct = s.total_ram_mb > 0 ? (s.used_ram_mb / s.total_ram_mb) * 100 : 0;

      if (ageHours > autoDrainHours && ramPct < drainBelowPct && s.current_tenants === 0) {
        console.log(`[AutoScaler] Draining idle server ${s.hostname}`);
        await db.query("UPDATE servers SET status = 'draining' WHERE id = ?", [s.id]);
      }
    }

    // --- Mark dead servers ---
    for (const s of servers) {
      if (s.status === 'active' && s.last_heartbeat) {
        const lastBeat = new Date(s.last_heartbeat).getTime();
        if (now - lastBeat > heartbeatTimeout * 1000) {
          console.log(`[AutoScaler] Server ${s.hostname} missed heartbeat, marking inactive`);
          await db.query("UPDATE servers SET status = 'inactive' WHERE id = ?", [s.id]);
        }
      }
    }

  } catch (error) {
    console.error('[AutoScaler] Error:', error.message);
  }
}

async function triggerScaleUp(config) {
  console.log('[AutoScaler] scale-up triggered');
  return { triggered: true, message: 'Scale-up dipicu. Periksa /api/servers untuk server baru.' };
}

module.exports = { startAutoScaler, stopAutoScaler, checkScaling, triggerScaleUp };
