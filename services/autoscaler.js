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

    // ─── Collect live resource usage from all active servers ───
    await collectServerStats();

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

// ─── Live resource collector via SSH ─────────────────────────
function sshPrefix(server) {
  const user = server.ssh_user || 'root';
  const host = server.ip_address;
  const port = server.ssh_port || 22;
  const opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=10';
  if (server.ssh_password) {
    const esc = server.ssh_password.replace(/\\/g,'\\\\\\\\').replace(/'/g,"'\\''").replace(/"/g,'\\\\"').replace(/`/g,'\\\\`').replace(/\$/g,'\\\\$');
    return `sshpass -p '${esc}' ssh ${opts} ${user}@${host} -p ${port}`;
  }
  return `ssh ${opts} -i ${server.ssh_key_path || '~/.ssh/id_rsa'} ${user}@${host} -p ${port}`;
}

function sshRun(server, cmd) {
  const { execSync } = require('child_process');
  return execSync(`${sshPrefix(server)} "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 15000 });
}

async function collectServerStats() {
  const [servers] = await db.query("SELECT * FROM servers WHERE status IN ('active','draining') AND ip_address IS NOT NULL");
  for (const s of servers) {
    try {
      const script = Buffer.from(`echo "CPU=$(nproc)"
echo "RAM_TOTAL=$(grep MemTotal /proc/meminfo | awk '{print $2}')"
echo "RAM_USED=$(awk '/MemTotal/{t=$2} /MemFree/{f=$2} /Cached/{c=$2} /Buffers/{b=$2} END{print t-f-c-b}' /proc/meminfo)"
echo "DISK_TOTAL=$(df -m / | tail -1 | awk '{print $2}')"
echo "DISK_USED=$(df -m / | tail -1 | awk '{print $3}')"
echo "DOCKER=$(docker --version 2>/dev/null || echo 'none')"
echo "HEARTBEAT=$(date +%s)"`).toString('base64');
      const out = sshRun(s, `echo ${script} | base64 -d | bash`);

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
      const dockerVer = data.DOCKER || s.docker_version;

      await db.query(`
        UPDATE servers SET
          used_ram_mb = ?, used_cpu_cores = ?, used_disk_mb = ?,
          total_ram_mb = ?, total_cpu_cores = ?, total_disk_mb = ?,
          docker_version = ?, last_heartbeat = NOW()
        WHERE id = ?
      `, [Math.round(ramUsed/1024), null, null, Math.round(ramTotal/1024), cpuCores, diskTotal, dockerVer, s.id]);

      // Update used cpu roughly: count running docker containers
      try {
        const containerOut = sshRun(s, `docker ps -q 2>/dev/null | wc -l`).trim();
        const containerCount = parseInt(containerOut) || 0;
        const cpuPerContainer = cpuCores > 0 ? Math.min(cpuCores * 0.1, 2) : 0.25;
        const usedCpu = Math.min(cpuPerContainer * containerCount, cpuCores * 0.9);
        await db.query('UPDATE servers SET used_cpu_cores = ? WHERE id = ?', [usedCpu, s.id]);
      } catch {}

    } catch (e) {
      console.error(`[AutoScaler] stat collect failed for ${s.hostname}: ${e.message}`);
      await db.query("UPDATE servers SET last_heartbeat = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?", [s.id]);
    }
  }
}

module.exports = { startAutoScaler, stopAutoScaler, checkScaling, triggerScaleUp };
