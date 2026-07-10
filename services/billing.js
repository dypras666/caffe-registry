const db = require('../config/database');
const { sshRun } = require('./provisioner');
const { sendMail, sendLoginInfo } = require('./email');

let billingInterval = null;

function startBillingScheduler() {
  console.log('[Billing] Starting scheduler...');
  if (billingInterval) clearInterval(billingInterval);
  billingInterval = setInterval(checkBilling, 300_000);
  checkBilling();
}

function stopBillingScheduler() {
  if (billingInterval) {
    clearInterval(billingInterval);
    billingInterval = null;
  }
}

async function checkBilling() {
  try {
    const [tenants] = await db.query(
      "SELECT t.*, s.hostname, s.ip_address, s.ssh_user, s.ssh_port, s.ssh_key_path, s.ssh_password FROM tenants t LEFT JOIN servers s ON t.server_id = s.id WHERE t.status IN ('active','suspended')"
    );

    for (const tenant of tenants) {
      await processTenantBilling(tenant);
    }
  } catch (error) {
    console.error('[Billing] Error:', error.message);
  }
}

async function processTenantBilling(tenant) {
  const balance = tenant.balance || 0;

  // Pricing per tier per day
  const dailyRate = { free: 0, starter: 1000, business: 2500, enterprise: 5000 };
  const cost = dailyRate[tenant.pricing_tier] || 0;

  // Low balance warning thresholds
  const warningSent = tenant.last_balance_warning
    ? new Date(tenant.last_balance_warning).getTime()
    : 0;
  const now = Date.now();

  // Status: active + balance <= 0 → suspend
  if (tenant.status === 'active' && balance <= 0 && tenant.auto_suspend) {
    console.log(`[Billing] ${tenant.slug} — Balance habis (${balance}), suspending...`);

    if (tenant.server_id && tenant.container_id) {
      const [servers] = await db.query('SELECT * FROM servers WHERE id = ?', [tenant.server_id]);

      if (servers.length) {
        try {
          sshRun(servers[0], `docker stop ${tenant.container_id} 2>/dev/null; docker rm ${tenant.container_id} 2>/dev/null`);
        } catch (e) {
          console.log(`[Billing] ${tenant.slug} — Stop container warning: ${e.message}`);
        }
      }
    }

    await db.query("UPDATE tenants SET status = 'suspended', suspended_at = NOW() WHERE id = ?", [tenant.id]);

    // Send suspension notification
    if (tenant.admin_email) {
      sendMail({
        to: tenant.admin_email,
        subject: '⛔ Layanan Cafe Azzura Dihentikan',
        template: 'suspended.html',
        vars: {
          name: tenant.name || tenant.slug,
          slug: tenant.slug,
          topupUrl: `https://office-${tenant.slug}.caffe.my.id/admin/billing`,
        },
      }).catch(() => {});
    }

    return;
  }

  // Status: suspended + balance > 0 → reactivate
  if (tenant.status === 'suspended' && balance > 0) {
    console.log(`[Billing] ${tenant.slug} — Balance terisi (${balance}), reactivating...`);

    const [result] = await db.query("UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = ?", [tenant.id]);

    if (tenant.server_id) {
      try {
        const { provisionTenant } = require('./provisioner');
        await provisionTenant(tenant.id, tenant.slug, tenant.admin_email, null);
      } catch (e) {
        console.log(`[Billing] ${tenant.slug} — Reactivation warning: ${e.message}`);
      }
    }
    return;
  }

  // Active + balance low → send warning (once per 24h)
  if (tenant.status === 'active' && balance > 0 && balance <= cost * 3) {
    if (now - warningSent > 86400000) {
      console.log(`[Billing] ${tenant.slug} — Balance rendah (${balance}), mengirim warning...`);

      if (tenant.admin_email) {
        const dailyRate = { free: 0, starter: 1000, business: 2500, enterprise: 5000 };
        const cost = dailyRate[tenant.pricing_tier] || 0;
        const daysLeft = cost > 0 ? Math.floor(balance / cost) : 999;

        await sendMail({
          to: tenant.admin_email,
          subject: '⚠️ Saldo Cafe Azzura Hampir Habis',
          template: 'balance-warning.html',
          vars: {
            name: tenant.name || tenant.slug,
            slug: tenant.slug,
            balance: balance.toLocaleString('id-ID'),
            dailyCost: cost.toLocaleString('id-ID'),
            daysLeft: String(daysLeft),
            topupUrl: `https://office-${tenant.slug}.caffe.my.id/admin/billing`,
          },
        });
      }

      await db.query('UPDATE tenants SET last_balance_warning = NOW() WHERE id = ?', [tenant.id]);
    }
  }
}

async function topUpBalance(tenantId, amount) {
  if (amount <= 0) throw new Error('Jumlah top up harus lebih dari 0');

  const [result] = await db.query(
    'UPDATE tenants SET balance = balance + ? WHERE id = ?',
    [amount, tenantId]
  );

  if (result.affectedRows === 0) throw new Error('Tenant tidak ditemukan');

  const [tenants] = await db.query('SELECT id, name, slug, balance, status FROM tenants WHERE id = ?', [tenantId]);
  const tenant = tenants[0];

  // If suspended and balance now positive, trigger immediate reactivation
  if (tenant.status === 'suspended' && tenant.balance > 0) {
    processTenantBilling(tenant).catch(() => {});
  }

  return tenant;
}

async function getBillingStatus(tenantId) {
  const [tenants] = await db.query(
    'SELECT id, name, slug, status, balance, auto_suspend, suspended_at, pricing_tier FROM tenants WHERE id = ?',
    [tenantId]
  );
  if (!tenants.length) throw new Error('Tenant tidak ditemukan');

  const tenant = tenants[0];
  const dailyRate = { free: 0, starter: 1000, business: 2500, enterprise: 5000 };
  const cost = dailyRate[tenant.pricing_tier] || 0;

  const daysLeft = cost > 0 ? Math.floor(tenant.balance / cost) : 999;

  return {
    ...tenant,
    daily_cost: cost,
    days_left: daysLeft,
    is_suspended: tenant.status === 'suspended',
    needs_topup: tenant.balance <= cost * 3,
    needs_recharge: tenant.balance <= 0,
  };
}

module.exports = { startBillingScheduler, stopBillingScheduler, checkBilling, processTenantBilling, topUpBalance, getBillingStatus };
