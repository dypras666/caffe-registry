const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth, tenantAuth } = require('../services/auth');

// GET /api/payment/methods — active payment methods (public/tenant)
router.get('/methods', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, type, account_name, account_number, icon, instructions, sort_order FROM payment_methods WHERE is_active = 1 ORDER BY sort_order ASC'
    );
    res.json({ methods: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payment/methods/all — all methods (superadmin)
router.get('/methods/all', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM payment_methods ORDER BY sort_order ASC'
    );
    res.json({ methods: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/methods — create (superadmin)
router.post('/methods', superadminAuth, async (req, res) => {
  try {
    const { name, type, account_name, account_number, provider, icon, instructions, is_active, sort_order } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Nama dan tipe wajib' });
    const r = await db.query(
      'INSERT INTO payment_methods (name, type, account_name, account_number, provider, icon, instructions, is_active, sort_order) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, type, account_name || '', account_number || '', provider || '', icon || '', instructions || '', is_active !== false ? 1 : 0, sort_order || 0]
    );
    res.status(201).json({ id: r[0].insertId, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/payment/methods/:id — update (superadmin)
router.put('/methods/:id', superadminAuth, async (req, res) => {
  try {
    const { name, type, account_name, account_number, provider, icon, instructions, is_active, sort_order } = req.body;
    await db.query(
      'UPDATE payment_methods SET name=?, type=?, account_name=?, account_number=?, provider=?, icon=?, instructions=?, is_active=?, sort_order=? WHERE id=?',
      [name, type, account_name, account_number, provider, icon, instructions, is_active ? 1 : 0, sort_order || 0, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/payment/methods/:id — delete (superadmin)
router.delete('/methods/:id', superadminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
