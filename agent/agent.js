const http = require('http');
const os = require('os');
const { execSync } = require('child_process');

const REGISTRY_URL = process.env.REGISTRY_URL || 'http://127.0.0.1:3000';
const SERVER_ID = process.env.SERVER_ID;
const INTERVAL = parseInt(process.env.INTERVAL) || 60; // seconds

if (!SERVER_ID) {
  console.error('SERVER_ID environment variable required');
  process.exit(1);
}

function getResourceUsage() {
  const totalRam = os.totalmem() / (1024 * 1024); // MB
  const freeRam = os.freemem() / (1024 * 1024);
  const usedRam = totalRam - freeRam;

  const cpus = os.cpus();
  const cpuCores = cpus.length;

  // Simple CPU usage (over 1 sec)
  const idle1 = cpus.reduce((s, c) => s + c.times.idle, 0);
  const total1 = cpus.reduce((s, c) => s + Object.values(c.times).reduce((a, b) => a + b, 0), 0);

  const start = Date.now();
  while (Date.now() - start < 1000) { /* wait 1s */ }

  const cpus2 = os.cpus();
  const idle2 = cpus2.reduce((s, c) => s + c.times.idle, 0);
  const total2 = cpus2.reduce((s, c) => s + Object.values(c.times).reduce((a, b) => a + b, 0), 0);

  const cpuUsage = 1 - ((idle2 - idle1) / (total2 - total1));

  // Disk usage
  let diskUsage = 0;
  try {
    const df = execSync('df -k / | tail -1', { encoding: 'utf8' });
    const parts = df.trim().split(/\s+/);
    diskUsage = parseInt(parts[2]) / 1024; // MB used
  } catch (_) {}

  // Docker info
  let dockerVersion = '';
  try {
    dockerVersion = execSync('docker --version', { encoding: 'utf8' }).trim();
  } catch (_) {}

  return {
    used_ram_mb: Math.round(usedRam),
    used_cpu_cores: Math.round(cpuUsage * cpuCores * 10) / 10,
    used_disk_mb: Math.round(diskUsage),
    docker_version: dockerVersion,
  };
}

function sendHeartbeat() {
  const usage = getResourceUsage();

  const data = JSON.stringify({
    ...usage,
    current_tenants: 0, // will be updated from registry
  });

  const req = http.request(`${REGISTRY_URL}/api/servers/${SERVER_ID}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error(`Heartbeat failed: ${res.statusCode} ${body}`);
      }
    });
  });

  req.on('error', (err) => console.error('Heartbeat error:', err.message));
  req.write(data);
  req.end();
}

console.log(`Agent started. Server ID: ${SERVER_ID}, Interval: ${INTERVAL}s`);
sendHeartbeat();
setInterval(sendHeartbeat, INTERVAL * 1000);
