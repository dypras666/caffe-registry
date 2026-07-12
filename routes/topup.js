const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/database');
const { tenantAuth, superadminAuth } = require('../services/auth');
const queue = require('../services/queue');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../public/uploads/proofs');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const QRIS_EXPIRY_MINUTES = 5;

// Generate a unique code (1–999) so that transfer_amount = amount + code is
// globally unique across ALL pending requests today (not just same base amount).
async function generateUniqueCode(amount) {
  const today = new Date().toISOString().split('T')[0];

  // Fetch all transfer_amounts already used today (pending, regardless of base amount)
  const [rows] = await db.query(
    `SELECT transfer_amount FROM topup_requests
     WHERE DATE(created_at) = ? AND status = 'pending'`,
    [today]
  );
  const usedAmounts = new Set(rows.map(r => r.transfer_amount));

  // Try random first for distribution
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = Math.floor(Math.random() * 999) + 1;
    if (!usedAmounts.has(amount + code)) return code;
  }
  // Sequential fallback
  for (let code = 1; code <= 999; code++) {
    if (!usedAmounts.has(amount + code)) return code;
  }
  throw new Error('Tidak bisa generate kode unik — terlalu banyak topup pending hari ini');
}

// GET /api/topup/requests — member lists their requests  ← MUST be before /:id routes
router.get('/requests', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT tr.*, pm.name as payment_method_name, pm.type as payment_method_type,
              pm.qris_type, pm.account_name, pm.account_number, pm.instructions, pm.icon,
              pm.bca_config_id
       FROM topup_requests tr LEFT JOIN payment_methods pm ON tr.payment_method_id = pm.id
       WHERE tr.tenant_id = ? ORDER BY tr.created_at DESC LIMIT 20`,
      [req.tenantUser.tenantId]
    );
    res.json({ requests: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/request — member submits topup request with unique code
router.post('/request', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const { amount, payment_method_id } = req.body;
    if (!amount || amount < 10000) return res.status(400).json({ error: 'Minimal topup Rp 10.000' });
    if (!payment_method_id) return res.status(400).json({ error: 'Pilih metode pembayaran' });

    // Get payment method type
    const [[pm]] = await db.query('SELECT type, qris_type, use_unique_code FROM payment_methods WHERE id = ?', [payment_method_id]);
    if (!pm) return res.status(400).json({ error: 'Metode pembayaran tidak ditemukan' });

    // Gateway types (midtrans, tripay, duitku) don't need unique code — they use their own payment flow
    const isGateway = ['midtrans', 'tripay', 'duitku', 'virtual_account'].includes(pm.type);

    let unique_code = 0;
    // Cek unique code dari DB (bisa toggle per method)
    const useCode = pm.use_unique_code === 1 || pm.use_unique_code === undefined;
    let transfer_amount = amount;
    let qris_expires_at = null;

    if (useCode) {
      unique_code = await generateUniqueCode(amount);
      if (unique_code) transfer_amount = amount + unique_code;
    }

    // Set QRIS expiry (+5 min from now) for BCA QRIS
    if (pm.type === 'qris' && pm.qris_type === 'bca') {
      qris_expires_at = new Date(Date.now() + QRIS_EXPIRY_MINUTES * 60 * 1000);
    }

    const [r] = await db.query(
      'INSERT INTO topup_requests (tenant_id, amount, unique_code, transfer_amount, payment_method_id, status, qris_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, amount, unique_code, transfer_amount, payment_method_id, 'pending', qris_expires_at]
    );
    res.status(201).json({
      success: true,
      id: r.insertId,
      unique_code,
      transfer_amount,
      qris_expires_at: qris_expires_at?.toISOString() || null,
      is_gateway: isGateway,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/proof — member uploads payment proof
router.post('/:id/proof', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'File tidak ditemukan' });

    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Request sudah diproses' });

    const matches = image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Format gambar tidak valid' });
    const ext = matches[1].split('/')[1].replace('jpeg', 'jpg');
    if (!['jpg', 'png', 'webp'].includes(ext)) return res.status(400).json({ error: 'Format hanya JPG/PNG/WEBP' });
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Ukuran maksimal 3MB' });

    const filename = `proof_${tenantId}_${req.params.id}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    const proof_url = `/uploads/proofs/${filename}`;

    await db.query('UPDATE topup_requests SET proof_url = ? WHERE id = ?', [proof_url, req.params.id]);
    res.json({ success: true, proof_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/check — poll BCA mutations for matching transfer
router.post('/:id/check', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') {
      return res.json({ matched: reqRow.status === 'confirmed', status: reqRow.status });
    }

    const result = await checkAndConfirmTopup(reqRow);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/topup/:id/qris — generate dynamic QRIS for this pending topup
// QRIS is valid for QRIS_EXPIRY_MINUTES from request creation.
// Calling this endpoint refreshes qris_expires_at to now + 5 min.
router.get('/:id/qris', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      `SELECT tr.*, pm.qris_type, pm.bca_config_id, pm.type as payment_method_type, pm.name as pm_name
       FROM topup_requests tr
       LEFT JOIN payment_methods pm ON tr.payment_method_id = pm.id
       WHERE tr.id = ? AND tr.tenant_id = ?`,
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Topup sudah diproses' });

    const bcaSvc = require('../services/bca');

    // Resolve BCA config
    let config, sdk;
    if (reqRow.bca_config_id) {
      const [[cfgRow]] = await db.query(
        'SELECT * FROM bca_merchant_config WHERE id = ? AND is_active = 1',
        [reqRow.bca_config_id]
      );
      if (cfgRow) { config = cfgRow; sdk = bcaSvc.buildSDK(cfgRow); }
    }
    if (!config) {
      try { ({ config, sdk } = await bcaSvc.getActiveSDK()); }
      catch (e) { return res.status(400).json({ error: 'BCA belum dikonfigurasi. Hubungi admin.' }); }
    }

    // Get outlet: prefer default
    const [[outlet]] = await db.query(
      'SELECT mid, name FROM bca_qris_outlets WHERE config_id = ? AND is_default = 1 LIMIT 1',
      [config.id]
    ).catch(() => [[null]]);
    const [[anyOutlet]] = await db.query(
      'SELECT mid, name FROM bca_qris_outlets WHERE config_id = ? LIMIT 1',
      [config.id]
    ).catch(() => [[null]]);
    const outletRow = outlet || anyOutlet;
    if (!outletRow) return res.status(400).json({ error: 'Outlet BCA belum disinkronkan. Hubungi admin.' });

    const amount = reqRow.transfer_amount || reqRow.amount;

    // Generate fresh QRIS + set new expiry
    const expiresAt = new Date(Date.now() + QRIS_EXPIRY_MINUTES * 60 * 1000);
    const base64 = await sdk.generateDynamicQRISImage(outletRow.mid, amount);

    await db.query(
      'UPDATE topup_requests SET qris_expires_at = ? WHERE id = ?',
      [expiresAt, reqRow.id]
    );

    // Merchant name from outlet or config label
    const merchantName = outletRow.name || config.label || 'BCA Merchant';

    res.json({
      success: true,
      image: `data:image/png;base64,${base64}`,
      amount,
      mid: outletRow.mid,
      merchant_name: merchantName,
      expires_at: expiresAt.toISOString(),
      expires_minutes: QRIS_EXPIRY_MINUTES,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/topup/:id/status — lightweight status poll (no BCA call)
router.get('/:id/status', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      'SELECT id, status, amount, unique_code, transfer_amount, auto_confirmed, matched_ref, confirmed_at, snap_token, snap_redirect_url FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Not found' });
    res.json({ request: reqRow });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/topup/superadmin/requests — superadmin lists all requests
router.get('/superadmin/requests', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT tr.*, pm.name as payment_method_name, pm.type as payment_method_type, pm.account_name, pm.account_number,
              t.name as tenant_name, t.slug as tenant_slug
       FROM topup_requests tr
       LEFT JOIN payment_methods pm ON tr.payment_method_id = pm.id
       JOIN tenants t ON tr.tenant_id = t.id
       ORDER BY CASE tr.status WHEN 'pending' THEN 0 ELSE 1 END, tr.created_at DESC LIMIT 100`
    );
    // Override account_number + account_name from system_settings for bank_transfer
    const [[manualNum]] = await db.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'payment_manual_account_number'"
    );
    const [[manualName]] = await db.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'payment_manual_account_holder'"
    );
    if (manualNum || manualName) {
      for (const r of rows) {
        if (r.payment_method_type === 'bank_transfer') {
          if (manualNum) r.account_number = manualNum.setting_value;
          if (manualName) r.account_name = manualName.setting_value;
        }
      }
    }
    res.json({ requests: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/superadmin/scan — scan BCA mutations and auto-confirm all matching pending requests
router.post('/superadmin/scan', superadminAuth, async (req, res) => {
  try {
    const confirmed = await scanAndConfirmAll();
    res.json({ success: true, confirmed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/superadmin/:id/check — superadmin force-check one request
router.post('/superadmin/:id/check', superadminAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query('SELECT * FROM topup_requests WHERE id = ?', [req.params.id]);
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.json({ matched: false, status: reqRow.status });
    const result = await checkAndConfirmTopup(reqRow);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/superadmin/:id/confirm — manual confirm (existing)
router.post('/superadmin/:id/confirm', superadminAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query('SELECT * FROM topup_requests WHERE id = ?', [req.params.id]);
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Request sudah diproses' });

    // Use transfer_amount if available (includes unique code), else base amount
    const depositAmount = reqRow.transfer_amount || reqRow.amount;
    await confirmTopup(reqRow, depositAmount, null, req.user?.id || 0, false);
    res.json({ success: true, amount: depositAmount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/superadmin/:id/reject — manual reject (existing)
router.post('/superadmin/:id/reject', superadminAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    await db.query(
      "UPDATE topup_requests SET status = 'rejected', notes = ? WHERE id = ? AND status = 'pending'",
      [reason || 'Ditolak', req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/midtrans-charge — create Snap transaction for Midtrans VA
router.post('/:id/midtrans-charge', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      `SELECT tr.*, t.name as tenant_name, t.admin_email
       FROM topup_requests tr JOIN tenants t ON tr.tenant_id = t.id
       WHERE tr.id = ? AND tr.tenant_id = ?`,
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Topup sudah diproses' });

    const cfg = await getSettings('payment_midtrans_');
    if (!cfg.payment_midtrans_server_key)
      return res.status(400).json({ error: 'Midtrans belum dikonfigurasi. Hubungi admin.' });

    const isProd = cfg.payment_midtrans_is_production === '1';
    const baseUrl = isProd ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com';
    const auth = Buffer.from(cfg.payment_midtrans_server_key + ':').toString('base64');

    const orderId = `TOPUP-${reqRow.id}-${Date.now()}`;
    const snapBody = {
      transaction_details: {
        order_id: orderId,
        gross_amount: reqRow.transfer_amount || reqRow.amount,
      },
      credit_card: { secure: true },
      customer_details: {
        first_name: reqRow.tenant_name || '',
        email: reqRow.admin_email || '',
      },
    };

    const snapRes = await fetch(baseUrl + '/snap/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + auth,
      },
      body: JSON.stringify(snapBody),
    });
    const snapResult = await snapRes.json();

    if (!snapRes.ok) {
      return res.status(400).json({
        error: snapResult.error_message || 'Gagal membuat transaksi Midtrans',
        details: snapResult,
      });
    }

    // Save snap token + redirect to topup_requests
    await db.query(
      'UPDATE topup_requests SET snap_token = ?, snap_redirect_url = ?, snap_order_id = ?, updated_at = NOW() WHERE id = ?',
      [snapResult.token || null, snapResult.redirect_url || null, orderId, reqRow.id]
    );

    res.json({
      success: true,
      snap_token: snapResult.token,
      redirect_url: snapResult.redirect_url,
      client_key: cfg.payment_midtrans_client_key || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/tripay-charge — create Tripay transaction
router.post('/:id/tripay-charge', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      `SELECT tr.*, t.name as tenant_name, t.admin_email
       FROM topup_requests tr JOIN tenants t ON tr.tenant_id = t.id
       WHERE tr.id = ? AND tr.tenant_id = ?`,
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Topup sudah diproses' });

    const cfg = await getSettings('payment_tripay_');
    if (!cfg.payment_tripay_merchant_code || !cfg.payment_tripay_api_key || !cfg.payment_tripay_private_key)
      return res.status(400).json({ error: 'Tripay belum dikonfigurasi. Hubungi admin.' });

    const isProd = cfg.payment_tripay_is_production === '1';
    const baseUrl = isProd ? 'https://tripay.co.id' : 'https://payment.tripay.co.id';
    const merchantCode = cfg.payment_tripay_merchant_code;
    const apiKey = cfg.payment_tripay_api_key;
    const privateKey = cfg.payment_tripay_private_key;

    const orderId = `TOPUP-${reqRow.id}-${Date.now()}`;
    const amount = reqRow.transfer_amount || reqRow.amount;
    const signature = crypto
      .createHmac('sha256', privateKey)
      .update(merchantCode + orderId + amount)
      .digest('hex');

    const tripayBody = {
      method: 'BRIVA', // default, can be changed
      merchant_ref: orderId,
      amount: amount,
      customer_name: reqRow.tenant_name || 'Customer',
      customer_email: reqRow.admin_email || 'customer@example.com',
      customer_phone: '080000000000',
      callback_url: `${process.env.SITE_URL || 'https://caffe.id'}/api/topup/tripay-callback`,
      return_url: `${process.env.SITE_URL || 'https://caffe.id'}/tenant-billing`,
      expired_time: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      signature: signature,
    };

    const tripayRes = await fetch(baseUrl + '/api-sandbox/transaction/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(tripayBody),
    });
    const tripayResult = await tripayRes.json();

    if (!tripayRes.ok || !tripayResult.success) {
      return res.status(400).json({
        error: tripayResult.message || 'Gagal membuat transaksi Tripay',
        details: tripayResult,
      });
    }

    // Save tripay reference
    await db.query(
      'UPDATE topup_requests SET tripay_ref = ?, tripay_payment_url = ?, updated_at = NOW() WHERE id = ?',
      [tripayResult.data.reference, tripayResult.data.payment_url, reqRow.id]
    );

    res.json({
      success: true,
      redirect_url: tripayResult.data.payment_url,
      reference: tripayResult.data.reference,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/duitku-charge — create Duitku transaction
router.post('/:id/duitku-charge', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      `SELECT tr.*, t.name as tenant_name, t.admin_email
       FROM topup_requests tr JOIN tenants t ON tr.tenant_id = t.id
       WHERE tr.id = ? AND tr.tenant_id = ?`,
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Request tidak ditemukan' });
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Topup sudah diproses' });

    const cfg = await getSettings('payment_duitku_');
    if (!cfg.payment_duitku_merchant_code || !cfg.payment_duitku_api_key)
      return res.status(400).json({ error: 'Duitku belum dikonfigurasi. Hubungi admin.' });

    const isProd = cfg.payment_duitku_is_production === '1';
    const baseUrl = isProd ? 'https://passport.duitku.com' : 'https://sandbox.duitku.com';
    const merchantCode = cfg.payment_duitku_merchant_code;
    const apiKey = cfg.payment_duitku_api_key;

    const orderId = `TOPUP-${reqRow.id}-${Date.now()}`;
    const amount = reqRow.transfer_amount || reqRow.amount;
    // Duitku signature: merchantCode + amount + merchantOrderId + apiKey (SHA256)
    const signature = crypto
      .createHash('sha256')
      .update(merchantCode + amount + orderId + apiKey)
      .digest('hex');

    const duitkuBody = {
      merchantCode: merchantCode,
      paymentAmount: amount,
      merchantOrderId: orderId,
      productDetails: `Topup ${reqRow.tenant_name || 'Caffe.id'}`,
      email: reqRow.admin_email || 'customer@example.com',
      phoneNumber: '080000000000',
      callbackUrl: `${process.env.SITE_URL || 'https://caffe.id'}/api/topup/duitku-callback`,
      returnUrl: `${process.env.SITE_URL || 'https://caffe.id'}/tenant-billing`,
      signature: signature,
    };

    const duitkuRes = await fetch(baseUrl + '/webapi/api/merchant/v1/inquiry/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(duitkuBody),
    });
    const duitkuResult = await duitkuRes.json();

    if (!duitkuRes.ok || duitkuResult.statusCode !== '00') {
      return res.status(400).json({
        error: duitkuResult.statusMessage || 'Gagal membuat transaksi Duitku',
        details: duitkuResult,
      });
    }

    // Save Duitku reference
    await db.query(
      'UPDATE topup_requests SET duitku_ref = ?, duitku_payment_url = ?, updated_at = NOW() WHERE id = ?',
      [duitkuResult.reference, duitkuResult.paymentUrl, reqRow.id]
    );

    res.json({
      success: true,
      redirect_url: duitkuResult.paymentUrl,
      reference: duitkuResult.reference,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/duitku-callback — Duitku webhook callback (no auth required)
router.post('/duitku-callback', async (req, res) => {
  try {
    const { merchantCode, amount, merchantOrderId, productDetail, additionalParam, paymentCode, resultCode, merchantUserId, reference, signature } = req.body;

    const cfg = await getSettings('payment_duitku_');
    const apiKey = cfg.payment_duitku_api_key;

    // Verify signature: sha256(merchantCode + amount + merchantOrderId + apiKey)
    const expectedSig = crypto
      .createHash('sha256')
      .update(merchantCode + amount + merchantOrderId + apiKey)
      .digest('hex');

    if (signature !== expectedSig) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    // Find the topup request
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE duitku_ref = ?',
      [reference]
    );
    if (!reqRow) return res.json({ success: false, error: 'Request not found' });
    if (reqRow.status !== 'pending') return res.json({ success: true });

    // Duitku resultCode 00 = success
    if (resultCode === '00') {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await db.query('UPDATE tenants SET balance = balance + ? WHERE id = ?',
        [depositAmount, reqRow.tenant_id]);
      await db.query(
        `UPDATE topup_requests SET status = 'confirmed', confirmed_at = NOW(),
         auto_confirmed = 1, matched_ref = ? WHERE id = ?`,
        [reference, reqRow.id]
      );

      // Queue confirmation email
      const queue = require('../services/queue');
      const [[tenant]] = await db.query(
        'SELECT admin_email, name, slug FROM tenants WHERE id = ?',
        [reqRow.tenant_id]
      );
      if (tenant?.admin_email) {
        queue.enqueue('email.topup_confirm', {
          to: tenant.admin_email,
          name: tenant.name || tenant.slug,
          amount: depositAmount,
          balance: depositAmount,
          slug: tenant.slug,
        }).catch(() => {});
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/check-duitku — check Duitku transaction status
router.post('/:id/check-duitku', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Not found' });
    if (reqRow.status !== 'pending') {
      return res.json({ matched: reqRow.status === 'confirmed', status: reqRow.status });
    }
    if (!reqRow.duitku_ref) {
      return res.json({ matched: false, status: 'pending', error: 'Belum ada transaksi Duitku' });
    }

    const cfg = await getSettings('payment_duitku_');
    const isProd = cfg.payment_duitku_is_production === '1';
    const baseUrl = isProd ? 'https://passport.duitku.com' : 'https://sandbox.duitku.com';
    const merchantCode = cfg.payment_duitku_merchant_code;
    const apiKey = cfg.payment_duitku_api_key;

    // Check transaction status
    const checkBody = {
      merchantCode: merchantCode,
      reference: reqRow.duitku_ref,
      signature: crypto
        .createHash('sha256')
        .update(merchantCode + reqRow.duitku_ref + apiKey)
        .digest('hex'),
    };

    const statusRes = await fetch(baseUrl + '/webapi/api/merchant/v1/inquiry/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checkBody),
    });
    const statusData = await statusRes.json();

    if (!statusRes.ok || statusData.statusCode !== '00') {
      return res.json({ matched: false, status: 'pending', error: statusData.statusMessage });
    }

    const txStatus = statusData.paymentStatus;
    let confirmed = false;
    if (txStatus === '00' || txStatus === '01') confirmed = true; // 00 = success, 01 = pending

    if (confirmed) {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await confirmTopup(reqRow, depositAmount, reqRow.duitku_ref, null, true);
      res.json({ matched: true, status: 'confirmed', amount: depositAmount });
    } else {
      res.json({ matched: false, status: txStatus || 'pending' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/tripay-callback — Tripay webhook callback (no auth required)
router.post('/tripay-callback', async (req, res) => {
  try {
    const { reference, merchant_ref, status, total_amount, signature } = req.body;
    
    const cfg = await getSettings('payment_tripay_');
    const privateKey = cfg.payment_tripay_private_key;
    
    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', privateKey)
      .update(reference + merchant_ref + status + total_amount)
      .digest('hex');
    
    if (signature !== expectedSig) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    // Find the topup request
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE tripay_ref = ?',
      [reference]
    );
    if (!reqRow) return res.json({ success: false, error: 'Request not found' });
    if (reqRow.status !== 'pending') return res.json({ success: true });

    // Tripay status: PAID = success
    if (status === 'PAID') {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await db.query('UPDATE tenants SET balance = balance + ? WHERE id = ?',
        [depositAmount, reqRow.tenant_id]);
      await db.query(
        `UPDATE topup_requests SET status = 'confirmed', confirmed_at = NOW(),
         auto_confirmed = 1, matched_ref = ? WHERE id = ?`,
        [reference, reqRow.id]
      );
      const [[tenant]] = await db.query(
        'SELECT admin_email, name, slug FROM tenants WHERE id = ?',
        [reqRow.tenant_id]
      );
      if (tenant?.admin_email) {
        const queue = require('../services/queue');
        queue.enqueue('email.topup_confirm', {
          to: tenant.admin_email, name: tenant.name || tenant.slug,
          amount: depositAmount, balance: depositAmount, slug: tenant.slug,
        }).catch(() => {});
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/check-tripay — check Tripay transaction status
router.post('/:id/check-tripay', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Not found' });
    if (reqRow.status !== 'pending') {
      return res.json({ matched: reqRow.status === 'confirmed', status: reqRow.status });
    }
    if (!reqRow.tripay_ref) {
      return res.json({ matched: false, status: 'pending', error: 'Belum ada transaksi Tripay' });
    }

    const cfg = await getSettings('payment_tripay_');
    if (!cfg.payment_tripay_merchant_code || !cfg.payment_tripay_api_key)
      return res.json({ matched: false, status: 'pending', error: 'Tripay not configured' });

    const isProd = cfg.payment_tripay_is_production === '1';
    const baseUrl = isProd ? 'https://tripay.co.id' : 'https://payment.tripay.co.id';
    const apiKey = cfg.payment_tripay_api_key;

    const statusRes = await fetch(`${baseUrl}/api-sandbox/transaction/detail?reference=${reqRow.tripay_ref}`, {
      headers: { 'Authorization': 'Bearer ' + apiKey },
    });
    const statusData = await statusRes.json();

    if (!statusRes.ok || !statusData.success) {
      return res.json({ matched: false, status: 'pending', error: statusData.message });
    }

    const txStatus = statusData.data.status;
    if (txStatus === 'PAID') {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await db.query('UPDATE tenants SET balance = balance + ? WHERE id = ?',
        [depositAmount, reqRow.tenant_id]);
      await db.query(
        `UPDATE topup_requests SET status = 'confirmed', confirmed_at = NOW(),
         auto_confirmed = 1, matched_ref = ? WHERE id = ?`,
        [reqRow.tripay_ref, reqRow.id]
      );
      const [[tenant]] = await db.query(
        'SELECT admin_email, name, slug FROM tenants WHERE id = ?',
        [reqRow.tenant_id]
      );
      if (tenant?.admin_email) {
        const queue = require('../services/queue');
        queue.enqueue('email.topup_confirm', {
          to: tenant.admin_email, name: tenant.name || tenant.slug,
          amount: depositAmount, balance: depositAmount, slug: tenant.slug,
        }).catch(() => {});
      }
      res.json({ matched: true, status: 'confirmed', amount: depositAmount });
    } else {
      res.json({ matched: false, status: txStatus || 'pending' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/check-midtrans — check Midtrans transaction status
router.post('/:id/check-midtrans', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Not found' });
    if (reqRow.status !== 'pending') {
      return res.json({ matched: reqRow.status === 'confirmed', status: reqRow.status });
    }
    if (!reqRow.snap_order_id) {
      return res.json({ matched: false, status: 'pending', error: 'Belum ada transaksi Midtrans' });
    }

    const cfg = await getSettings('payment_midtrans_');
    if (!cfg.payment_midtrans_server_key)
      return res.json({ matched: false, status: 'pending', error: 'Midtrans not configured' });

    const isProd = cfg.payment_midtrans_is_production === '1';
    const baseUrl = isProd ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
    const auth = Buffer.from(cfg.payment_midtrans_server_key + ':').toString('base64');

    const statusRes = await fetch(`${baseUrl}/v2/${reqRow.snap_order_id}/status`, {
      headers: { 'Authorization': 'Basic ' + auth },
    });
    const statusData = await statusRes.json();

    const txStatus = statusData.transaction_status;
    const fraudStatus = statusData.fraud_status;

    let confirmed = false;
    if (txStatus === 'capture' && fraudStatus === 'accept') confirmed = true;
    else if (txStatus === 'settlement') confirmed = true;

    if (confirmed) {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await db.query('UPDATE tenants SET balance = balance + ? WHERE id = ?',
        [depositAmount, reqRow.tenant_id]);
      await db.query(
        `UPDATE topup_requests SET status = 'confirmed', confirmed_at = NOW(),
         auto_confirmed = 1, matched_ref = ? WHERE id = ?`,
        [statusData.transaction_id || reqRow.snap_order_id, reqRow.id]
      );
      const [[tenant]] = await db.query(
        'SELECT admin_email, name, slug FROM tenants WHERE id = ?',
        [reqRow.tenant_id]
      );
      if (tenant?.admin_email) {
        const queue = require('../services/queue');
        queue.enqueue('email.topup_confirm', {
          to: tenant.admin_email, name: tenant.name || tenant.slug,
          amount: depositAmount, balance: depositAmount, slug: tenant.slug,
        }).catch(() => {});
      }
      res.json({ matched: true, status: 'confirmed', amount: depositAmount });
    } else {
      res.json({ matched: false, status: txStatus || 'pending' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Confirm a topup request: add balance (transfer_amount) + mark confirmed.
 */
async function confirmTopup(reqRow, depositAmount, matchedRef, confirmedBy, autoConfirmed) {
  await db.query(
    'UPDATE tenants SET balance = balance + ? WHERE id = ?',
    [depositAmount, reqRow.tenant_id]
  );
  await db.query(
    `UPDATE topup_requests
     SET status = 'confirmed', confirmed_by = ?, confirmed_at = NOW(),
         auto_confirmed = ?, matched_ref = ?
     WHERE id = ?`,
    [confirmedBy || 0, autoConfirmed ? 1 : 0, matchedRef || null, reqRow.id]
  );
  // Queue confirmation email
  const [[tenant]] = await db.query(
    'SELECT admin_email, name, slug FROM tenants WHERE id = ?',
    [reqRow.tenant_id]
  );
  if (tenant?.admin_email) {
    queue.enqueue('email.topup_confirm', {
      to: tenant.admin_email,
      name: tenant.name || tenant.slug,
      amount: depositAmount,
      balance: depositAmount,
      slug: tenant.slug,
    }).catch(() => {});
  }
}

/**
 * Check BCA mutations for a single pending topup request.
 * Uses bca_config_id from the payment method, falls back to active config.
 * Returns { matched, status, matched_ref? }
 */
async function checkAndConfirmTopup(reqRow) {
  let bcaSvc;
  try {
    bcaSvc = require('../services/bca');
  } catch (e) {
    return { matched: false, status: 'pending', error: 'BCA service not available' };
  }

  // Resolve BCA config: prefer the one linked to the payment method
  let config, sdk;
  try {
    if (reqRow.payment_method_id) {
      const [[pm]] = await db.query(
        'SELECT qris_type, bca_config_id FROM payment_methods WHERE id = ?',
        [reqRow.payment_method_id]
      );
      // Only scan BCA if method is qris_type=bca and has linked config
      if (!pm || pm.qris_type !== 'bca') {
        return { matched: false, status: 'pending', error: 'Metode pembayaran ini tidak menggunakan BCA auto-check' };
      }
      if (pm.bca_config_id) {
        const [[cfgRow]] = await db.query(
          'SELECT * FROM bca_merchant_config WHERE id = ? AND is_active = 1',
          [pm.bca_config_id]
        );
        if (!cfgRow) return { matched: false, status: 'pending', error: 'BCA config tidak aktif' };
        config = cfgRow;
        sdk = bcaSvc.buildSDK(cfgRow);
      }
    }
    // Fallback: use global active config
    if (!config) {
      ({ config, sdk } = await bcaSvc.getActiveSDK());
    }
  } catch (e) {
    return { matched: false, status: 'pending', error: `BCA config error: ${e.message}` };
  }

  const targetAmount = reqRow.transfer_amount || reqRow.amount;
  const today = new Date().toISOString().split('T')[0];
  // Only search transactions from the day the request was created up to today
  const startDate = reqRow.created_at
    ? new Date(reqRow.created_at).toISOString().split('T')[0]
    : today;

  // Get default mid or first available outlet
  const [[defaultOutlet]] = await db.query(
    'SELECT mid FROM bca_qris_outlets WHERE config_id = ? AND is_default = 1 LIMIT 1',
    [config.id]
  ).catch(() => [[null]]);
  const [[anyOutlet]] = await db.query(
    'SELECT mid FROM bca_qris_outlets WHERE config_id = ? LIMIT 1',
    [config.id]
  ).catch(() => [[null]]);
  const mid = defaultOutlet?.mid || anyOutlet?.mid;

  if (!mid) return { matched: false, status: 'pending', error: 'Outlet BCA tidak ditemukan' };

  // Fetch real-time mutations from BCA
  let transactions = [];
  try {
    const result = await sdk.getTransactions(mid, startDate, today);
    transactions = result.output_schema?.transaction || [];
  } catch (e) {
    return { matched: false, status: 'pending', error: `BCA error: ${e.message}` };
  }

  // Look for transaction with exact transfer_amount + within ±30min window of request creation
  const sorted = [...transactions].sort((a, b) =>
    new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  );

  const reqTime = new Date(reqRow.created_at).getTime();
  const WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  // Check if this amount was already matched by another request today
  const [[alreadyMatched]] = await db.query(
    `SELECT id FROM topup_requests
     WHERE status = 'confirmed' AND transfer_amount = ? AND id != ? AND DATE(created_at) = ?`,
    [targetAmount, reqRow.id, today]
  ).catch(() => [[null]]);

  if (alreadyMatched) {
    return { matched: false, status: 'pending', error: 'Amount already matched by another request' };
  }

  const match = sorted.find(tx => {
    const txAmount = Math.round(parseFloat(tx.amount || '0'));
    if (txAmount !== targetAmount) return false;
    // Check time window: transaction should be within ±30min of request creation
    const txTime = new Date(tx.date || tx.transaction_date || 0).getTime();
    if (reqTime && txTime && Math.abs(txTime - reqTime) > WINDOW_MS) return false;
    return true;
  });

  if (match) {
    // Upsert into mutation log
    await db.query(
      `INSERT IGNORE INTO bca_mutation_log
         (config_id, mid, reference_number, amount, date, payment_method, payer_name, payer_phone, approval_code, raw_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id, mid, match.reference_number,
        Math.round(parseFloat(match.amount || '0')),
        match.date?.substring(0, 10) || today,
        match.payment_method || '', match.payer_name || '',
        match.payer_phone || '', match.approval_code || '',
        JSON.stringify(match),
      ]
    ).catch(() => {});

    await confirmTopup(reqRow, targetAmount, match.reference_number, null, true);
    return { matched: true, status: 'confirmed', matched_ref: match.reference_number, amount: targetAmount };
  }

  return { matched: false, status: 'pending' };
}

/**
 * Scan all pending requests today and auto-confirm matches.
 * Called by superadmin /scan endpoint or scheduled job.
 */
async function scanAndConfirmAll() {
  const today = new Date().toISOString().split('T')[0];
  const [pending] = await db.query(
    `SELECT tr.*, pm.qris_type, pm.bca_config_id
     FROM topup_requests tr
     LEFT JOIN payment_methods pm ON tr.payment_method_id = pm.id
     WHERE tr.status = 'pending' AND DATE(tr.created_at) = ?
       AND pm.qris_type = 'bca' AND pm.bca_config_id IS NOT NULL`,
    [today]
  );
  const results = [];
  for (const req of pending) {
    const r = await checkAndConfirmTopup(req).catch(e => ({ matched: false, error: e.message }));
    if (r.matched) results.push({ id: req.id, amount: req.transfer_amount, ref: r.matched_ref });
  }
  return results;
}

module.exports = router;
module.exports.scanAndConfirmAll = scanAndConfirmAll;

// ── Tripay callback handler ──────────────────────────────────────
// POST /api/topup/tripay-callback
router.post('/tripay-callback', async (req, res) => {
  try {
    const { reference, merchant_ref, status, amount, signature } = req.body;
    
    // Verify signature
    const cfg = await getSettings('payment_tripay_');
    const privateKey = cfg.payment_tripay_private_key;
    const expectedSig = crypto
      .createHmac('sha256', privateKey)
      .update(cfg.payment_tripay_merchant_code + merchant_ref + amount)
      .digest('hex');
    
    if (signature !== expectedSig) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }
    
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE tripay_ref = ?', [reference]
    );
    if (!reqRow) return res.json({ success: true }); // Idempotent
    
    if (status === 'PAID' && reqRow.status === 'pending') {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await confirmTopup(reqRow, depositAmount, reference, null, true);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/topup/:id/check-tripay — check Tripay transaction status
router.post('/:id/check-tripay', tenantAuth, async (req, res) => {
  try {
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantUser.tenantId]
    );
    if (!reqRow) return res.status(404).json({ error: 'Not found' });
    if (reqRow.status !== 'pending') {
      return res.json({ matched: reqRow.status === 'confirmed', status: reqRow.status });
    }
    if (!reqRow.tripay_ref) {
      return res.json({ matched: false, status: 'pending', error: 'Belum ada transaksi Tripay' });
    }

    const cfg = await getSettings('payment_tripay_');
    const isProd = cfg.payment_tripay_is_production === '1';
    const baseUrl = isProd ? 'https://tripay.co.id' : 'https://payment.tripay.co.id';
    const apiKey = cfg.payment_tripay_api_key;

    const statusRes = await fetch(`${baseUrl}/api-sandbox/transaction/detail?reference=${reqRow.tripay_ref}`, {
      headers: { 'Authorization': 'Bearer ' + apiKey },
    });
    const statusData = await statusRes.json();

    if (!statusData.success) {
      return res.json({ matched: false, status: 'pending', error: statusData.message });
    }

    const txStatus = statusData.data.status;
    let confirmed = false;
    if (txStatus === 'PAID') confirmed = true;

    if (confirmed) {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;
      await confirmTopup(reqRow, depositAmount, reqRow.tripay_ref, null, true);
      res.json({ matched: true, status: 'confirmed', amount: depositAmount });
    } else {
      res.json({ matched: false, status: txStatus || 'pending' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Midtrans helpers ───────────────────────────────────────────
async function getSettings(prefix) {
  const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE ?", [prefix + '%']);
  const cfg = {};
  for (const r of rows) cfg[r.setting_key] = r.setting_value;
  return cfg;
}
