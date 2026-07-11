const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { tenantAuth, superadminAuth } = require('../services/auth');
const queue = require('../services/queue');

// POST /api/topup/request — member submits topup request (pending)
router.post('/request', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const { amount, payment_method_id } = req.body;
    if (!amount || amount < 10000) return res.status(400).json({ error: 'Minimal topup Rp 10.000' });
    if (!payment_method_id) return res.status(400).json({ error: 'Pilih metode pembayaran' });

    const r = await db.query(
      'INSERT INTO topup_requests (tenant_id, amount, payment_method_id, status) VALUES (?, ?, ?, ?)',
      [tenantId, amount, payment_method_id, 'pending']
    );
    res.status(201).json({ success: true, id: r[0].insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/topup/requests — member lists their requests
router.get('/requests', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT tr.*, pm.name as payment_method_name, pm.account_name, pm.account_number, pm.instructions, pm.icon
       FROM topup_requests tr LEFT JOIN payment_methods pm ON tr.payment_method_id = pm.id
       WHERE tr.tenant_id = ? ORDER BY tr.created_at DESC LIMIT 20`,
      [req.tenantUser.tenantId]
    );
    res.json({ requests: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/superadmin/topup/requests — superadmin lists all pending
router.get('/superadmin/requests', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT tr.*, pm.name as payment_method_name, pm.account_name, pm.account_number,
              t.name as tenant_name, t.slug as tenant_slug
       FROM topup_requests tr
       LEFT JOIN payment_methods pm ON tr.payment_method_id = pm.id
       JOIN tenants t ON tr.tenant_id = t.id
       ORDER BY CASE tr.status WHEN 'pending' THEN 0 ELSE 1 END, tr.created_at DESC LIMIT 50`
    );
    res.json({ requests: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/superadmin/topup/:id/confirm — superadmin confirms & adds balance
router.post('/superadmin/:id/confirm', superadminAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query('SELECT * FROM topup_requests WHERE id = ?', [req.params.id]);
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Request sudah diproses' });

    await db.query(
      'UPDATE tenants SET balance = balance + ? WHERE id = ?',
      [reqRow.amount, reqRow.tenant_id]
    );
    await db.query(
      "UPDATE topup_requests SET status = 'confirmed', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?",
      [req.user?.id || 0, req.params.id]
    );

    // Queue email
    const [[tenant]] = await db.query('SELECT admin_email, name, slug FROM tenants WHERE id = ?', [reqRow.tenant_id]);
    if (tenant?.admin_email) {
      queue.enqueue('email.topup_confirm', {
        to: tenant.admin_email,
        name: tenant.name || tenant.slug,
        amount: reqRow.amount,
        balance: reqRow.amount,
        slug: tenant.slug,
      }).catch(() => {});
    }

    res.json({ success: true, amount: reqRow.amount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/superadmin/topup/:id/reject — superadmin rejects
router.post('/superadmin/:id/reject', superadminAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    await db.query("UPDATE topup_requests SET status = 'rejected', notes = ? WHERE id = ? AND status = 'pending'",
      [reason || 'Ditolak', req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
