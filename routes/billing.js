const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { topUpBalance, getBillingStatus } = require('../services/billing');
const { superadminAuth, tenantAuth } = require('../services/auth');
const queue = require('../services/queue');

// GET /api/billing/tenants — list all tenant balances
router.get('/tenants', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, name, slug, status, balance, auto_suspend, suspended_at, pricing_tier, admin_email FROM tenants ORDER BY balance ASC"
    );
    const dailyRate = { free: 0, starter: 1000, business: 2500, enterprise: 5000 };
    const result = rows.map(t => ({
      ...t,
      daily_cost: dailyRate[t.pricing_tier] || 0,
      days_left: (dailyRate[t.pricing_tier] || 0) > 0 ? Math.floor((t.balance || 0) / (dailyRate[t.pricing_tier] || 1)) : 999,
      is_suspended: t.status === 'suspended',
      warning: (t.balance || 0) <= (dailyRate[t.pricing_tier] || 0) * 3,
    }));
    res.json({ tenants: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/billing/tenant/:id — single tenant billing status
router.get('/tenant/:id', superadminAuth, async (req, res) => {
  try {
    const result = await getBillingStatus(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// GET /api/billing/my — tenant's own billing status (member)
router.get('/my', tenantAuth, async (req, res) => {
  try {
    const result = await getBillingStatus(req.tenantUser.tenantId);
    res.json(result);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// POST /api/billing/tenant/:id/topup — top up balance
router.post('/tenant/:id/topup', superadminAuth, async (req, res) => {
  try {
    const { amount, payment_method_id } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah top up harus lebih dari 0' });

    const tenant = await topUpBalance(req.params.id, amount);

    // Record payment method if provided
    if (payment_method_id) {
      await db.query(
        'INSERT INTO topup_transactions (tenant_id, amount, payment_method_id, status, notes) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, amount, payment_method_id, 'completed', 'Topup via superadmin']
      );
    }

    // Queue topup confirmation email
    if (tenant.admin_email) {
      queue.enqueue('email.topup_confirm', {
        to: tenant.admin_email,
        name: tenant.name || tenant.slug,
        amount,
        balance: tenant.balance,
        slug: tenant.slug,
      }).catch(() => {});
    }

    res.json({ success: true, balance: tenant.balance, status: tenant.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/billing/tenant/:id/toggle-suspend — enable/disable auto-suspend
router.post('/tenant/:id/toggle-suspend', superadminAuth, async (req, res) => {
  try {
    const { auto_suspend } = req.body;
    await db.query('UPDATE tenants SET auto_suspend = ? WHERE id = ?', [auto_suspend ? 1 : 0, req.params.id]);
    res.json({ success: true, auto_suspend: !!auto_suspend });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/billing/check — trigger billing check now
router.post('/check', superadminAuth, async (req, res) => {
  try {
    const { checkBilling } = require('../services/billing');
    checkBilling().catch(console.error);
    res.json({ success: true, message: 'Billing check triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
