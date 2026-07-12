const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth, tenantAuth } = require('../services/auth');

// GET /api/payment/methods — active payment methods for tenant topup
router.get('/methods', async (req, res) => {
  try {
    // First, fetch which gateways are enabled in settings
    const [settingsRows] = await db.query(
      "SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'payment_%_active'"
    );
    const activeGateways = new Set();
    for (const row of settingsRows) {
      if (row.setting_value === '1' || row.setting_value === 'true') {
        const match = row.setting_key.match(/payment_(.+)_active/);
        if (match) activeGateways.add(match[1]); // 'midtrans', 'tripay', 'qris', 'manual'
      }
    }

    // Map gateway -> payment_method.type
    const gatewayToType = {
      midtrans: 'virtual_account',
      tripay: 'tripay',
      duitku: 'duitku',
      qris: 'qris',
      manual: 'bank_transfer',
    };

    const allowedTypes = [...activeGateways].map(g => gatewayToType[g]).filter(Boolean);

    // Build query with type filter
    let whereClause = 'pm.is_active = 1';
    const params = [];
    if (allowedTypes.length > 0) {
      const placeholders = allowedTypes.map(() => '?').join(',');
      whereClause += ` AND pm.type IN (${placeholders})`;
      params.push(...allowedTypes);
    }

    // Fetch all methods, then deduplicate in JS (MySQL 5.7 compatible)
    const [rows] = await db.query(
      `SELECT pm.id, pm.name, pm.type, pm.qris_type, pm.account_name, pm.account_number,
              pm.icon, pm.instructions, pm.sort_order,
              CASE WHEN pm.qris_type = 'bca' AND bmc.is_active = 1 THEN 1
                   WHEN pm.qris_type = 'bca' THEN 0
                   ELSE 1
              END AS available
       FROM payment_methods pm
       LEFT JOIN bca_merchant_config bmc ON pm.bca_config_id = bmc.id
       WHERE ${whereClause}
       ORDER BY pm.sort_order ASC, pm.id ASC`,
      params
    );

    // Deduplicate: keep first (highest priority) per type
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      if (!seen.has(r.type)) {
        seen.add(r.type);
        // Override account_number from system_settings for bank_transfer
        // (fetch full payment_manual settings)
        const [manualSettings] = await db.query(
          "SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'payment_manual_%'"
        );
        if (r.type === 'bank_transfer') {
          const setting = manualSettings.find(s => s.setting_key === 'payment_manual_account_number');
          if (setting) r.account_number = setting.setting_value;
        }
        deduped.push(r);
      }
    }

    res.json({ methods: deduped });
  } catch (e) {
    console.error('[payment/methods] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payment/methods/all — all methods (superadmin)
router.get('/methods/all', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT pm.*, bmc.label as bca_label, bmc.is_active as bca_is_active
       FROM payment_methods pm
       LEFT JOIN bca_merchant_config bmc ON pm.bca_config_id = bmc.id
       ORDER BY pm.sort_order ASC`
    );
    res.json({ methods: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/methods — create (superadmin)
router.post('/methods', superadminAuth, async (req, res) => {
  try {
    const { name, type, qris_type, bca_config_id, account_name, account_number, provider, icon, instructions, is_active, sort_order } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Nama dan tipe wajib' });
    const [r] = await db.query(
      'INSERT INTO payment_methods (name, type, qris_type, bca_config_id, account_name, account_number, provider, icon, instructions, is_active, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [name, type, qris_type || 'static', bca_config_id || null, account_name || '', account_number || '', provider || '', icon || '', instructions || '', is_active !== false ? 1 : 0, sort_order || 0]
    );
    res.status(201).json({ id: r.insertId, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/payment/methods/:id — update (superadmin)
router.put('/methods/:id', superadminAuth, async (req, res) => {
  try {
    const { name, type, qris_type, bca_config_id, account_name, account_number, provider, icon, instructions, is_active, sort_order } = req.body;
    await db.query(
      'UPDATE payment_methods SET name=?, type=?, qris_type=?, bca_config_id=?, account_name=?, account_number=?, provider=?, icon=?, instructions=?, is_active=?, sort_order=? WHERE id=?',
      [name, type, qris_type || 'static', bca_config_id || null, account_name, account_number, provider, icon, instructions, is_active ? 1 : 0, sort_order || 0, req.params.id]
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

// GET /api/payment/test/:gateway — test gateway connectivity
router.get('/test/duitku', async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'payment_duitku_%'"
    );
    const cfg = {};
    for (const r of rows) cfg[r.setting_key] = r.setting_value;

    const merchantCode = cfg.payment_duitku_merchant_code;
    const apiKey = cfg.payment_duitku_api_key;
    const isProd = cfg.payment_duitku_is_production === '1' || cfg.payment_duitku_is_production === 'true';
    const active = cfg.payment_duitku_active === '1' || cfg.payment_duitku_active === 'true';

    if (!merchantCode || !apiKey) {
      return res.status(400).json({ error: 'Duitku not configured', active, merchantCode: !!merchantCode, apiKey: !!apiKey });
    }

    // Minimal test — create a dummy transaction
    const baseUrl = isProd ? 'https://passport.duitku.com' : 'https://sandbox.duitku.com';
    const apiPath = '/webapi/api/merchant/v2/inquiry';
    const paymentAmount = 10000;
    const merchantOrderId = 'TEST-' + Date.now();
    const productDetails = 'Test Payment';
    const customerVaName = 'Test User';
    const email = 'test@test.com';
    const returnUrl = 'https://caffe.my.id';
    const callbackUrl = 'https://caffe.my.id/api/payment/duitku/callback';

    const md5 = require('crypto').createHash('md5');
    const signature = md5.update(merchantCode + merchantOrderId + paymentAmount + apiKey).digest('hex');

    const body = JSON.stringify({
      merchantCode,
      paymentAmount,
      merchantOrderID: merchantOrderId,
      productDetails,
      customerVaName,
      email,
      returnUrl,
      callbackUrl,
      signature,
      expiryPeriod: 60,
      paymentMethod: 'VA',  // Mandiri VA by default
    });

    const http = require('https');
    const r = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    res.json({ success: true, active, isProduction: isProd, duitkuStatus: r.status, duitkuResponse: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
