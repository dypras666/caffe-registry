const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth, tenantAuth } = require('../services/auth');
const mysql = require('mysql2');

// ─── Tenant config ─────────────────────────────────────

// GET /api/addons/gojek/config — tenant lihat config
router.get('/config', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT merchant_id, is_active FROM gojek_configs WHERE tenant_id=?', [req.tenantUser.tenantId]);
    const config = rows[0] || { merchant_id: '', is_active: 0 };
    res.json({ config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/addons/gojek/config — tenant update config
router.put('/config', tenantAuth, async (req, res) => {
  try {
    const { merchant_id, api_key, webhook_secret } = req.body;
    const tid = req.tenantUser.tenantId;
    await db.query(
      'INSERT INTO gojek_configs (tenant_id, merchant_id, api_key, webhook_secret, is_active) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE merchant_id=COALESCE(?,merchant_id), api_key=COALESCE(?,api_key), webhook_secret=COALESCE(?,webhook_secret), is_active=1',
      [tid, merchant_id, api_key, webhook_secret, merchant_id, api_key, webhook_secret]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/addons/gojek/webhook-url — tenant lihat webhook URL
router.get('/webhook-url', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT slug FROM tenants WHERE id=?', [req.tenantUser.tenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    const baseUrl = process.env.APP_URL || 'https://caffe.id';
    res.json({ webhook_url: `${baseUrl}/api/addons/gojek/webhook/${rows[0].slug}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Webhook — Gojek panggil ini pas ada order ─────────

// POST /api/addons/gojek/webhook/:slug
router.post('/webhook/:slug', async (req, res) => {
  try {
    // Cari tenant by slug
    const [tenants] = await db.query('SELECT id, slug, db_name, db_user, db_pass FROM tenants WHERE slug=?', [req.params.slug]);
    if (!tenants.length) return res.status(404).json({ error: 'Tenant tidak ditemukan' });

    const tenant = tenants[0];

    // Cek config gojek
    const [configs] = await db.query('SELECT * FROM gojek_configs WHERE tenant_id=? AND is_active=1', [tenant.id]);
    if (!configs.length) return res.status(400).json({ error: 'Gojek integration tidak aktif' });

    const config = configs[0];
    const payload = req.body;

    // Validasi signature sederhana (webhook_secret = shared secret)
    const signature = req.headers['x-gojek-signature'] || '';
    if (config.webhook_secret && signature !== config.webhook_secret) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Simpan order masuk
    const items = payload.items || payload.products || [];
    const subtotal = parseFloat(payload.subtotal || payload.total || 0);
    const deliveryFee = parseFloat(payload.delivery_fee || 0);
    const total = parseFloat(payload.total || payload.subtotal || 0);

    const gojekOrderId = payload.order_id || payload.id || `gojek-${Date.now()}`;
    const customerName = payload.customer?.name || payload.customer_name || 'Gojek Customer';
    const customerPhone = payload.customer?.phone || payload.customer_phone || '';

    await db.query(
      `INSERT INTO gojek_orders (tenant_id, gojek_order_id, customer_name, customer_phone, items, subtotal, delivery_fee, total, order_status, raw_payload)
       VALUES (?,?,?,?,?,?,?,?,'pending',?)
       ON DUPLICATE KEY UPDATE order_status='pending', items=?, subtotal=?, delivery_fee=?, total=?, raw_payload=?`,
      [tenant.id, gojekOrderId, customerName, customerPhone, JSON.stringify(items), subtotal, deliveryFee, total, JSON.stringify(payload),
       JSON.stringify(items), subtotal, deliveryFee, total, JSON.stringify(payload)]
    );

    // Insert order ke tenant DB (cafe-backend) kalo ada koneksi
    let localOrderId = null;
    if (tenant.db_name && tenant.db_user && tenant.db_pass) {
      try {
        const conn = mysql.createConnection({
          host: '127.0.0.1',
          user: tenant.db_user,
          password: tenant.db_pass,
          database: tenant.db_name,
          port: 3306,
        });
        const dbp = conn.promise();

        // Cari produk berdasarkan nama (simplifikasi — idealnya mapping)
        // Buat order header dulu
        const [orderResult] = await dbp.query(
          `INSERT INTO orders (order_number, customer_name, customer_phone, order_type, status, subtotal, delivery_fee, total, source, payment_status, created_at)
           VALUES (?,?,?,'delivery','confirmed',?,?,?,'gojek','pending', NOW())`,
          [gojekOrderId, customerName, customerPhone, subtotal, deliveryFee, total]
        );
        localOrderId = orderResult.insertId;

        // Insert order items
        for (const item of items) {
          const qty = parseInt(item.qty || item.quantity || 1);
          const price = parseFloat(item.price || item.subtotal || 0);
          const productName = item.name || item.product_name || 'Produk Gojek';
          // Cari product_id berdasarkan nama di tenant DB
          const [products] = await dbp.query('SELECT id, price FROM products WHERE name=? OR name LIKE ? LIMIT 1', [productName, `%${productName}%`]);
          const productId = products.length ? products[0].id : null;
          const productPrice = products.length ? parseFloat(products[0].price) : (qty > 0 ? price / qty : 0);

          await dbp.query(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, subtotal)
             VALUES (?,?,?,?,?,?)`,
            [localOrderId, productId, productName, qty, productPrice, price]
          );
        }

        await conn.end();

        // Update gojek_orders dengan local_order_id
        await db.query('UPDATE gojek_orders SET local_order_id=? WHERE gojek_order_id=?', [localOrderId, gojekOrderId]);

        console.log(`[gojek] Order ${gojekOrderId} → tenant ${tenant.slug} order #${localOrderId}`);
      } catch (dbErr) {
        console.error(`[gojek] Gagal insert ke tenant DB ${tenant.slug}: ${dbErr.message}`);
        // Tetap balik sukses — order udah tercatat di gojek_orders
      }
    }

    res.json({ success: true, gojek_order_id: gojekOrderId, local_order_id: localOrderId });

  } catch (e) {
    console.error('[gojek] Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── History ────────────────────────────────────────────

// GET /api/addons/gojek/orders — tenant lihat history
router.get('/orders', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, gojek_order_id, customer_name, items, total, order_status, local_order_id, received_at FROM gojek_orders WHERE tenant_id=? ORDER BY received_at DESC LIMIT 50',
      [req.tenantUser.tenantId]
    );
    res.json({ orders: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
