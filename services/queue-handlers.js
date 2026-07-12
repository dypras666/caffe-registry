/**
 * Job handlers — register all job types to the queue worker
 */

const queue = require('./queue');
const emailSvc = require('./email');
const db = require('../config/database');
const { sshPrefix, run } = require('./provisioner');

const FMT_RP = (v) => `Rp ${Number(v || 0).toLocaleString('id-ID')}`;

// ─── Email: welcome on registration ──────────────────────────
queue.register('email.welcome', async ({ to, name, adminUrl, email, password, plan }) => {
  await emailSvc.sendWelcome({ to, name, adminUrl, email, password, plan });
});

// ─── Email: forgot password ───────────────────────────────────
queue.register('email.forgot_password', async ({ to, name, resetUrl }) => {
  await emailSvc.sendForgotPassword({ to, name, resetUrl });
});

// ─── Email: topup confirmation ────────────────────────────────
queue.register('email.topup_confirm', async ({ to, name, amount, balance, slug }) => {
  await emailSvc.sendMail({
    to,
    subject: '✅ Topup Saldo Berhasil — Cafe Azzura',
    template: 'topup-confirm.html',
    vars: {
      name,
      amount: FMT_RP(amount),
      balance: FMT_RP(balance),
      slug,
      date: new Date().toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' }),
    },
  });
});

// ─── Email: low balance warning ───────────────────────────────
queue.register('email.balance_warning', async ({ to, name, slug, balance, dailyCost, daysLeft, topupUrl }) => {
  await emailSvc.sendBillingWarning({ to, name, slug, balance: FMT_RP(balance), dailyCost: FMT_RP(dailyCost), daysLeft, topupUrl });
});

// ─── Email: account suspended ─────────────────────────────────
queue.register('email.suspended', async ({ to, name, slug, topupUrl }) => {
  await emailSvc.sendSuspended({ to, name, slug, topupUrl });
});

// ─── Email: subscription expiry reminder ─────────────────────
queue.register('email.expiry_reminder', async ({ to, name, slug, expiryDate, daysLeft, renewUrl }) => {
  await emailSvc.sendMail({
    to,
    subject: `⏰ Langganan Anda Akan Berakhir ${daysLeft} Hari Lagi`,
    template: 'expiry-reminder.html',
    vars: { name, slug, expiryDate, daysLeft, renewUrl },
  });
});

// ─── Email: login info ────────────────────────────────────────
queue.register('email.login_info', async ({ to, name, cafeName, adminUrl, email, role }) => {
  await emailSvc.sendLoginInfo({ to, name, cafeName, adminUrl, email, role });
});

// ─── Email: provisioning complete ────────────────────────────
queue.register('email.provision_complete', async ({ to, name, slug, adminUrl, cafeUrl, email }) => {
  await emailSvc.sendMail({
    to,
    subject: 'Cafe Anda Sudah Siap! — Caffe.id',
    template: 'provision-complete.html',
    vars: {
      name, slug, adminUrl, cafeUrl, email,
      subdomainWarning: 'Subdomain ' + slug + '.caffe.id tidak bisa diubah setelah ini.',
    },
  });
});

// ─── Email: provisioning failed ───────────────────────────────
queue.register('email.provision_failed', async ({ to, name, slug, error }) => {
  await emailSvc.sendMail({
    to,
    subject: '⚠️ Gagal Deploy Cafe — Caffe.id',
    template: 'provision-failed.html',
    vars: { name, slug, error: error || 'Unknown error' },
  });
});

// ─── Billing: daily cost deduction ───────────────────────────
queue.register('billing.daily_deduct', async (_payload, job) => {
  const DAILY_RATE = { free: 0, starter: 1000, business: 2500, enterprise: 5000 };

  const [tenants] = await db.query(
    "SELECT * FROM tenants WHERE status IN ('active','suspended')"
  );

  let deducted = 0;
  for (const t of tenants) {
    const cost = DAILY_RATE[t.pricing_tier] || 0;
    if (cost === 0) continue;

    const newBalance = (parseFloat(t.balance) || 0) - cost;
    await db.query(
      'UPDATE tenants SET balance = ?, updated_at = NOW() WHERE id = ?',
      [Math.max(newBalance, -cost), t.id]
    );

    // Log transaction
    await db.query(
      `INSERT INTO balance_transactions (tenant_id, type, amount, balance_after, note)
       VALUES (?, 'deduct', ?, ?, 'Daily billing')
       ON DUPLICATE KEY UPDATE amount=amount`,
      [t.id, cost, Math.max(newBalance, -cost)]
    ).catch(() => {}); // table may not exist yet

    deducted++;
  }

  console.log(`[Queue] billing.daily_deduct: deducted from ${deducted} tenants`);

  // Reschedule for tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 1, 0);
  await queue.enqueue('billing.daily_deduct', {}, { runAt: tomorrow });
});

// ─── Billing: check balance warnings ─────────────────────────
queue.register('billing.check_warnings', async () => {
  const DAILY_RATE = { free: 0, starter: 1000, business: 2500, enterprise: 5000 };

  const [tenants] = await db.query(
    "SELECT * FROM tenants WHERE status = 'active' AND admin_email IS NOT NULL"
  );

  const now = Date.now();
  let warned = 0;

  for (const t of tenants) {
    const balance = parseFloat(t.balance) || 0;
    const dailyCost = DAILY_RATE[t.pricing_tier] || 0;
    if (dailyCost === 0) continue;

    const daysLeft = Math.floor(balance / dailyCost);

    // Warn at 3 days, 1 day
    const warnThresholds = [3, 1];
    for (const threshold of warnThresholds) {
      if (daysLeft !== threshold) continue;

      const lastWarn = t.last_balance_warning ? new Date(t.last_balance_warning).getTime() : 0;
      const cooldownMs = 20 * 60 * 60 * 1000; // 20 hours cooldown
      if (now - lastWarn < cooldownMs) continue;

      await queue.enqueue('email.balance_warning', {
        to: t.admin_email,
        name: t.name || t.slug,
        slug: t.slug,
        balance,
        dailyCost,
        daysLeft,
        topupUrl: `${process.env.SITE_URL || 'https://caffe.id'}/tenant-billing`,
      });

      await db.query('UPDATE tenants SET last_balance_warning = NOW() WHERE id = ?', [t.id]);
      warned++;
    }

    // Zero balance → suspend + notify
    if (balance <= 0 && t.auto_suspend !== false) {
      await db.query("UPDATE tenants SET status='suspended', suspended_at=NOW() WHERE id=?", [t.id]);
      await queue.enqueue('email.suspended', {
        to: t.admin_email,
        name: t.name || t.slug,
        slug: t.slug,
        topupUrl: `${process.env.SITE_URL || 'https://caffe.id'}/tenant-billing`,
      });
    }
  }

  console.log(`[Queue] billing.check_warnings: warned ${warned} tenants`);

  // Reschedule every 6 hours
  const in6h = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await queue.enqueue('billing.check_warnings', {}, { runAt: in6h });
});

// ─── BCA: scan pending topup requests vs mutations ────────────
queue.register('bca.scan_topup', async () => {
  const today = new Date().toISOString().split('T')[0];

  // Skip if no pending topup requests today
  const [[{ cnt }]] = await db.query(
    "SELECT COUNT(*) AS cnt FROM topup_requests WHERE status='pending' AND DATE(created_at) = ?",
    [today]
  );
  if (parseInt(cnt) === 0) {
    // Reschedule and exit
    const in5m = new Date(Date.now() + 5 * 60 * 1000);
    await queue.enqueue('bca.scan_topup', {}, { runAt: in5m, maxAttempts: 1 });
    return;
  }

  try {
    const { scanAndConfirmAll } = require('../routes/topup');
    const confirmed = await scanAndConfirmAll();
    if (confirmed.length > 0) {
      console.log(`[BCA Scan] Auto-confirmed ${confirmed.length} topup(s):`, confirmed.map(c => `#${c.id} Rp${c.amount}`).join(', '));
    }
  } catch (e) {
    console.warn('[BCA Scan] Skipped:', e.message);
  }

  // Always reschedule every 5 minutes
  const in5m = new Date(Date.now() + 5 * 60 * 1000);
  await queue.enqueue('bca.scan_topup', {}, { runAt: in5m, maxAttempts: 1 });
});

// ─── Container: check all running containers ─────────────────────
queue.register('container.check_status', async () => {
  const [tenants] = await db.query(
    "SELECT id, slug, container_status, backend_port FROM tenants WHERE status IN ('active','provisioning') AND backend_port IS NOT NULL"
  );
  if (!tenants.length) {
    const [legacy] = await db.query("SELECT id, slug, container_status, container_id, server_id FROM tenants WHERE server_id IS NOT NULL AND container_id IS NOT NULL");
    if (!legacy.length) { console.log('[Queue] container.check_status: no tenants with containers'); return; }
  }

  // Local Docker check (cafe-azzura containers named {slug}-backend)
  let running = new Map();
  try {
    const out = run('docker ps --format "{{.Names}}|{{.Status}}|{{.ID}}" 2>/dev/null || true');
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [name, status, id] = line.split('|');
      if (name && name.endsWith('-backend')) {
        const slug = name.replace('-backend', '');
        running.set(slug, { id: id ? id.substring(0, 12) : null, status, containerName: name });
      }
    }
  } catch (e) {
    console.error('[Queue] docker ps error:', e.message);
  }

  // Update tenant statuses
  for (const t of tenants) {
    const found = running.get(t.slug);
    const dockerOk = found && found.status.startsWith('Up');
    const newStatus = dockerOk ? 'running' : (found ? 'error' : 'stopped');
    if (t.container_status !== newStatus) {
      await db.query('UPDATE tenants SET container_status = ?, container_id = ?, updated_at = NOW() WHERE id = ?',
        [newStatus, dockerOk ? found.id : null, t.id]);
    }
  }

  // Also check legacy tenants by container_id
  const [legacyTenants] = await db.query("SELECT id, slug, container_status, container_id FROM tenants WHERE server_id IS NOT NULL AND container_id IS NOT NULL AND backend_port IS NULL");
  for (const t of legacyTenants) {
    const found = running.get(t.slug);
    const newStatus = found && found.status.startsWith('Up') ? 'running' : 'stopped';
    if (t.container_status !== newStatus) {
      await db.query('UPDATE tenants SET container_status = ? WHERE id = ?', [newStatus, t.id]);
    }
  }

  // Reschedule every 2 minutes
  const in2m = new Date(Date.now() + 2 * 60 * 1000);
  await queue.enqueue('container.check_status', {}, { runAt: in2m, maxAttempts: 1 });
});

// ─── Provisioning: auto-retry failed ──────────────────────────
queue.register('provisioning.retry', async (job) => {
  const { tenant_id, slug, email, password, retry_count = 0, error: lastError } = job;
  const maxRetries = 3;

  if (retry_count >= maxRetries) {
    console.error(`[AUTO-RETRY] ${slug} — max retries (${maxRetries}) reached. Last error: ${lastError}`);
    await db.query('UPDATE tenants SET container_status = ? WHERE id = ?', ['failed', tenant_id]);
    return;
  }

  console.log(`[AUTO-RETRY] ${slug} — attempt ${retry_count + 1}/${maxRetries}`);

  try {
    const { repairProvisioning } = require('./provisioner');
    const result = await repairProvisioning(tenant_id);
    if (result.repaired === 0) {
      // No repair needed — retry full provision
      await db.query("UPDATE tenants SET status=? WHERE id=?", ['provisioning', tenant_id]);
      await require('./provisioner').provisionTenant(tenant_id, slug, email, password);
    }
  } catch (e) {
    console.error(`[AUTO-RETRY] ${slug} — attempt ${retry_count + 1} failed:`, e.message);
    // Re-enqueue with backoff
    const backoff = Math.pow(2, retry_count) * 30 * 1000; // 30s, 60s, 120s
    const runAt = new Date(Date.now() + backoff);
    await queue.enqueue('provisioning.retry', {
      tenant_id, slug, email, password,
      retry_count: retry_count + 1,
      error: e.message,
    }, { runAt, maxAttempts: 1 });
  }
});

module.exports = {}; // side-effects only — handlers auto-registered above
