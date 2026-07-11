// routes/bca.js — BCA Merchant QRIS management

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth } = require('../services/auth');
const bcaSvc = require('../services/bca');

// ── GET /api/bca/config — get current config (credentials masked) ────────────
router.get('/config', superadminAuth, async (req, res) => {
  try {
    const [[config]] = await db.query(
      'SELECT id, label, default_mid, is_active, last_sync_at, created_at FROM bca_merchant_config ORDER BY id LIMIT 1'
    );
    // Return masked email
    let email = null;
    if (config) {
      try { email = bcaSvc.decrypt(config.email_enc || ''); } catch {}
      // Mask: keep first 2 chars + domain
      if (email) {
        const [user, domain] = email.split('@');
        email = user.substring(0, 2) + '***@' + (domain || '');
      }
    }
    res.json({ config: config ? { ...config, email_masked: email } : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bca/config — save/update credentials (encrypted) ───────────────
router.post('/config', superadminAuth, async (req, res) => {
  try {
    const { email, password, label } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib' });

    const email_enc = bcaSvc.encrypt(email.trim());
    const password_enc = bcaSvc.encrypt(password);

    const [[existing]] = await db.query('SELECT id FROM bca_merchant_config LIMIT 1');
    if (existing) {
      await db.query(
        'UPDATE bca_merchant_config SET email_enc=?, password_enc=?, label=?, is_active=1 WHERE id=?',
        [email_enc, password_enc, label || 'BCA QRIS', existing.id]
      );
      // Clear cached tokens so next call forces fresh login
      await db.query(
        "DELETE FROM system_settings WHERE setting_key = ?",
        [`bca_token_${existing.id}`]
      ).catch(() => {});
      res.json({ success: true, id: existing.id });
    } else {
      const [r] = await db.query(
        'INSERT INTO bca_merchant_config (email_enc, password_enc, label) VALUES (?,?,?)',
        [email_enc, password_enc, label || 'BCA QRIS']
      );
      res.json({ success: true, id: r.insertId });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bca/test-login — verify credentials work ───────────────────────
router.post('/test-login', superadminAuth, async (req, res) => {
  try {
    const { config, sdk } = await bcaSvc.getActiveSDK();
    const status = sdk.getTokenStatus();
    // If no valid token yet, force login
    const token = await sdk.login
      ? await sdk.tokenManager.getValidAccessToken()
      : null;
    res.json({ success: true, message: 'Login berhasil' });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ── POST /api/bca/sync — sync outlets from BCA ───────────────────────────────
router.post('/sync', superadminAuth, async (req, res) => {
  try {
    const { config, sdk } = await bcaSvc.getActiveSDK();
    const merchants = await bcaSvc.syncOutlets(config, sdk);
    res.json({ success: true, count: merchants.length, merchants });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/bca/outlets — list cached outlets ────────────────────────────────
router.get('/outlets', superadminAuth, async (req, res) => {
  try {
    const [[config]] = await db.query(
      'SELECT id, default_mid FROM bca_merchant_config WHERE is_active=1 LIMIT 1'
    );
    if (!config) return res.json({ outlets: [] });

    const [outlets] = await db.query(
      'SELECT id, mid, name, nmid, qris_image_url, is_default, synced_at FROM bca_qris_outlets WHERE config_id=? ORDER BY is_default DESC, name ASC',
      [config.id]
    );
    res.json({ outlets, default_mid: config.default_mid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/bca/outlets/:mid/default — set default QRIS outlet ──────────────
router.put('/outlets/:mid/default', superadminAuth, async (req, res) => {
  try {
    const [[config]] = await db.query(
      'SELECT id FROM bca_merchant_config WHERE is_active=1 LIMIT 1'
    );
    if (!config) return res.status(404).json({ error: 'Konfigurasi tidak ditemukan' });

    await db.query(
      'UPDATE bca_qris_outlets SET is_default=0 WHERE config_id=?',
      [config.id]
    );
    await db.query(
      'UPDATE bca_qris_outlets SET is_default=1 WHERE config_id=? AND mid=?',
      [config.id, req.params.mid]
    );
    await db.query(
      'UPDATE bca_merchant_config SET default_mid=? WHERE id=?',
      [req.params.mid, config.id]
    );
    res.json({ success: true, default_mid: req.params.mid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/bca/qris/:mid — get QRIS image (fresh from BCA) ─────────────────
router.get('/qris/:mid', superadminAuth, async (req, res) => {
  try {
    const { sdk } = await bcaSvc.getActiveSDK();
    const base64 = await sdk.downloadQRISImage(req.params.mid);
    if (!base64) return res.status(404).json({ error: 'QRIS tidak ditemukan' });
    res.json({ success: true, image: `data:image/png;base64,${base64}`, mid: req.params.mid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/bca/mutations — paginated mutation log ───────────────────────────
router.get('/mutations', superadminAuth, async (req, res) => {
  try {
    const { mid, start, end, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = '1=1';
    const params = [];
    if (mid) { where += ' AND mid=?'; params.push(mid); }
    if (start) { where += ' AND date >= ?'; params.push(start); }
    if (end) { where += ' AND date <= ?'; params.push(end); }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM bca_mutation_log WHERE ${where}`, params
    );
    const [rows] = await db.query(
      `SELECT id, mid, reference_number, amount, date, payment_method, payer_name, payer_phone, approval_code, fetched_at
       FROM bca_mutation_log WHERE ${where}
       ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({ mutations: rows, total, page: Number(page), limit: Number(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bca/mutations/fetch — pull fresh transactions from BCA ──────────
router.post('/mutations/fetch', superadminAuth, async (req, res) => {
  try {
    const { mid, date, end_date } = req.body;
    if (!mid) return res.status(400).json({ error: 'mid wajib diisi' });

    const today = new Date().toISOString().split('T')[0];
    const { config, sdk } = await bcaSvc.getActiveSDK();
    const result = await bcaSvc.syncTransactions(config, sdk, mid, date || today, end_date || today);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
