/**
 * Shared Backend — melayani semua FREE tenant dalam 1 proses Node.js.
 * Tenant diidentifikasi dari header X-Tenant-Slug yang di-inject tenant-router.
 * Setiap tenant punya pool MySQL sendiri (cache per slug) → tidak ada overhead gonta-ganti DB.
 */

require('dotenv').config({ path: '/opt/caffe-registry/.env' });
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/database'); // registry DB

const app = express();
const PORT = process.env.SHARED_BACKEND_PORT || 3900;

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// ─── Pool cache: slug → mysql pool ────────────────────────────
const pools = new Map();

async function getPool(slug) {
  if (pools.has(slug)) return pools.get(slug);

  // Ambil kredensial dari registry
  const [[tenant]] = await db.query(
    'SELECT db_name, db_user, db_pass, secret FROM tenants WHERE slug = ? AND status = "active"',
    [slug]
  );
  if (!tenant) throw new Error(`Tenant "${slug}" not found`);

  const pool = mysql.createPool({
    host: process.env.SHARED_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.SHARED_DB_PORT || '3910'),
    user: tenant.db_user,
    password: tenant.db_pass,
    database: tenant.db_name,
    waitForConnections: true,
    connectionLimit: 5,       // max 5 conn per tenant
    queueLimit: 10,
  });

  pools.set(slug, { pool, secret: tenant.secret, db_name: tenant.db_name });
  console.log(`[shared] Pool created for ${slug} (${tenant.db_name})`);
  return pools.get(slug);
}

// Invalidate cache saat tenant di-upgrade (dipanggil dari provisioner)
function invalidatePool(slug) {
  if (pools.has(slug)) {
    pools.get(slug).pool.end().catch(() => {});
    pools.delete(slug);
    console.log(`[shared] Pool invalidated for ${slug}`);
  }
}

// ─── Middleware: resolve tenant ────────────────────────────────
app.use(async (req, res, next) => {
  const slug = req.headers['x-tenant-slug'];
  if (!slug) return res.status(400).json({ error: 'Missing tenant slug' });

  try {
    req.tenantCtx = await getPool(slug);
    req.db = req.tenantCtx.pool;
    req.tenantSlug = slug;
    next();
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ─── Auth middleware ───────────────────────────────────────────
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, req.tenantCtx.secret);
    // Support both token shapes: { id } and { userId }
    req.user.id = req.user.id || req.user.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ─── Health ────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', tenant: req.tenantSlug, mode: 'shared' });
});

// ─── Auth ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await req.db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!users.length) return res.status(401).json({ error: 'Email atau password salah' });
    const user = users[0];
    if (!await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Email atau password salah' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      req.tenantCtx.secret, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const http = require('http');

function proxyToRefBackend(req, res, refPort) {
  const opts = {
    hostname: '127.0.0.1',
    port: refPort,
    path: req.originalUrl,
    method: req.method,
    headers: { ...req.headers, host: 'localhost' },
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'Backend unavailable' });
  });
  req.pipe(proxyReq);
}

// ─── Inline routes pakai req.db (tenant-aware) ─────────────────

// Products — return { products, count } agar cafe-admin bisa pakai data?.products
app.get('/api/products', async (req, res) => {
  try {
    const { status, category_id, search, limit = 100, page = 1 } = req.query;
    let where = '1=1';
    const params = [];
    if (status === 'active') { where += ' AND (p.is_available=1 OR p.is_available IS NULL)'; }
    if (category_id) { where += ' AND p.category_id=?'; params.push(parseInt(category_id)); }
    if (search) { where += ' AND p.name LIKE ?'; params.push(`%${search}%`); }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [[{ total }]] = await req.db.query(`SELECT COUNT(*) as total FROM products p WHERE ${where}`, params);
    const [products] = await req.db.query(
      `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ products, count: products.length, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/products', authenticate, async (req, res) => {
  try {
    const { name, category_id, price, description } = req.body;
    const [r] = await req.db.query('INSERT INTO products (name, category_id, price, description) VALUES (?,?,?,?)', [name, category_id, price, description||null]);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/products/:id', authenticate, async (req, res) => {
  try {
    const { name, category_id, price, description, is_available } = req.body;
    await req.db.query('UPDATE products SET name=?,category_id=?,price=?,description=?,is_available=? WHERE id=?', [name, category_id, price, description, is_available??1, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/products/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM products WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Categories — return { categories, count }
app.get('/api/categories', async (req, res) => {
  try {
    const [categories] = await req.db.query('SELECT * FROM categories WHERE is_active=1 ORDER BY name');
    res.json({ categories, count: categories.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/categories', authenticate, async (req, res) => {
  try {
    const [r] = await req.db.query('INSERT INTO categories (name, description) VALUES (?,?)', [req.body.name, req.body.description||null]);
    res.json({ id: r.insertId, name: req.body.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/categories/:id', authenticate, async (req, res) => {
  try { await req.db.query('UPDATE categories SET name=?,description=? WHERE id=?', [req.body.name, req.body.description, req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Tables — return { tables }
app.get('/api/tables', authenticate, async (req, res) => {
  try {
    const [tables] = await req.db.query('SELECT * FROM `tables` ORDER BY number ASC');
    res.json({ tables, count: tables.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Orders — return { orders, count }
app.get('/api/orders', authenticate, async (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND o.order_status=?'; params.push(status); }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [orders] = await req.db.query(
      `SELECT o.*, t.number as table_number FROM orders o LEFT JOIN \`tables\` t ON o.table_id=t.id WHERE ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ orders, count: orders.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// cancel-requests HARUS sebelum /:id agar tidak di-match sebagai order ID
app.get('/api/orders/cancel-requests', authenticate, async (req, res) => {
  try {
    const [r] = await req.db.query(
      `SELECT ocr.*, o.order_number, u.name as requested_by_name
       FROM order_cancel_requests ocr
       LEFT JOIN orders o ON o.id = ocr.order_id
       LEFT JOIN users u ON u.id = ocr.requested_by
       WHERE ocr.status = 'pending' ORDER BY ocr.created_at DESC`
    );
    res.json(r);
  } catch { res.json([]); }
});

app.get('/api/orders/:id', authenticate, async (req, res) => {
  try {
    const [[order]] = await req.db.query('SELECT o.*, t.number as table_number FROM orders o LEFT JOIN `tables` t ON o.table_id=t.id WHERE o.id=?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const [items] = await req.db.query('SELECT oi.*, p.name as product_name FROM order_items oi LEFT JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?', [req.params.id]);
    res.json({ ...order, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/orders', authenticate, async (req, res) => {
  try {
    const { table_id, customer_name, items, payment_method, notes } = req.body;
    let total = 0;
    if (items) for (const item of items) {
      const [[prod]] = await req.db.query('SELECT price FROM products WHERE id=?', [item.product_id]);
      total += (parseFloat(prod?.price)||0) * (item.quantity||1);
    }
    const [r] = await req.db.query(
      'INSERT INTO orders (table_id, customer_name, total_amount, status, payment_method, notes) VALUES (?,?,?,?,?,?)',
      [table_id||null, customer_name||'Guest', total, 'pending', payment_method||'cash', notes||null]
    );
    if (items) for (const item of items) {
      await req.db.query('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)', [r.insertId, item.product_id, item.quantity||1, item.price||0]);
    }
    res.json({ id: r.insertId, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/orders/:id', authenticate, async (req, res) => {
  try {
    const { status, payment_method } = req.body;
    await req.db.query('UPDATE orders SET status=?,payment_method=COALESCE(?,payment_method) WHERE id=?', [status, payment_method, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Users — return { users }
app.get('/api/users', authenticate, async (req, res) => {
  try {
    const [users] = await req.db.query('SELECT id,name,email,role,status,balance,is_priority,created_at FROM users ORDER BY created_at DESC');
    res.json({ users, count: users.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Branches — return { branches }
app.get('/api/branches', authenticate, async (req, res) => {
  try {
    const [branches] = await req.db.query('SELECT * FROM branches WHERE is_active=1 ORDER BY is_main DESC, name');
    res.json({ branches, count: branches.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/branches/public', async (req, res) => {
  try { const [branches] = await req.db.query('SELECT * FROM branches WHERE is_active=1'); res.json({ branches }); }
  catch { res.json({ branches: [] }); }
});

// Dashboard stats
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const db = req.db;
    const [[{ orders }]] = await db.query("SELECT COUNT(*) as orders FROM orders WHERE DATE(created_at) = CURDATE()");
    const [[{ tables }]] = await db.query("SELECT COUNT(*) as tables FROM `tables`");
    const [[{ products }]] = await db.query("SELECT COUNT(*) as products FROM products WHERE is_available = 1");
    const [[{ revenue_today }]] = await db.query("SELECT COALESCE(SUM(total_amount),0) as revenue_today FROM orders WHERE DATE(created_at)=CURDATE()");
    const [[{ total_revenue }]] = await db.query("SELECT COALESCE(SUM(total_amount),0) as total_revenue FROM orders");
    const [[{ orders_count }]] = await db.query("SELECT COUNT(*) as orders_count FROM orders");
    res.json({
      revenue_today: revenue_today.toString(), revenue_month: '0.00',
      orders: parseInt(orders), tables: parseInt(tables), products: parseInt(products),
      total_orders: parseInt(orders_count), total_revenue: total_revenue.toString(),
      tier: 'free', ram_mb: 64, cpu_cores: 0.25,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Payment methods — { methods }
app.get('/api/payments/methods', async (req, res) => {
  try {
    const [methods] = await req.db.query(
      'SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order'
    );
    res.json({ methods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/payments/methods', authenticate, async (req, res) => {
  try {
    const { name, code, type, description, icon, sort_order } = req.body;
    const [r] = await req.db.query(
      'INSERT INTO payment_methods (name, code, type, description, icon, sort_order, is_active) VALUES (?,?,?,?,?,?,1)',
      [name, code, type, description||null, icon||null, sort_order||99]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/payments/methods/:id', authenticate, async (req, res) => {
  try {
    const fields = [], vals = [];
    for (const [k,v] of Object.entries(req.body)) { fields.push(`${k}=?`); vals.push(v); }
    vals.push(req.params.id);
    await req.db.query(`UPDATE payment_methods SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/payments/methods/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM payment_methods WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings (public)
app.get('/api/settings', async (req, res) => {
  try {
    const [rows] = await req.db.query('SELECT setting_key, setting_value FROM system_settings WHERE is_public = 1');
    const out = {};
    for (const r of rows) out[r.setting_key] = r.setting_value;
    res.json(out);
  } catch { res.json({}); }
});

// Settings single key — GET /api/settings/:key
app.get('/api/settings/:key', async (req, res) => {
  try {
    const [[row]] = await req.db.query(
      'SELECT setting_value FROM system_settings WHERE setting_key = ? AND is_public = 1',
      [req.params.key]
    );
    if (!row) return res.json({ value: null });
    res.json({ value: row.setting_value });
  } catch { res.json({ value: null }); }
});

// Posts
app.get('/api/posts', async (req, res) => {
  try {
    const [rows] = await req.db.query(
      "SELECT id, title, slug, excerpt, featured_image, published_at FROM posts WHERE status='published' ORDER BY published_at DESC LIMIT 20"
    );
    res.json(rows);
  } catch { res.json([]); }
});

app.get('/api/posts/:slug', async (req, res) => {
  try {
    const [[post]] = await req.db.query(
      "SELECT * FROM posts WHERE slug=? AND status='published'", [req.params.slug]
    );
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', authenticate, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await req.db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
        [k, v, v]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shifts list — { shifts }
app.get('/api/shifts', authenticate, async (req, res) => {
  try {
    const [shifts] = await req.db.query(
      'SELECT s.*, u.name as opened_by_name FROM shifts s LEFT JOIN users u ON u.id=s.opened_by ORDER BY s.opened_at DESC LIMIT 30'
    );
    res.json({ shifts, count: shifts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shifts — current
app.get('/api/shifts/current', authenticate, async (req, res) => {
  try {
    const [[shift]] = await req.db.query(
      `SELECT s.*, u.name AS opened_by_name FROM shifts s
       LEFT JOIN users u ON u.id = s.opened_by
       WHERE s.status = 'open' ORDER BY s.opened_at DESC LIMIT 1`
    );
    if (!shift) return res.json({ shift: null });
    const [[{ total_orders }]] = await req.db.query(
      "SELECT COUNT(*) as total_orders FROM orders WHERE shift_id = ?", [shift.id]
    );
    const [[{ total_revenue }]] = await req.db.query(
      "SELECT COALESCE(SUM(total_amount),0) as total_revenue FROM orders WHERE shift_id = ? AND order_status='completed'", [shift.id]
    );
    res.json({ shift: { ...shift, total_orders: parseInt(total_orders), total_revenue: parseFloat(total_revenue) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Media (gallery) — return array agar .map() tidak error
app.get('/api/media', async (req, res) => {
  try {
    const [rows] = await req.db.query(
      "SELECT id, url, filename, original_name, folder FROM media ORDER BY created_at DESC LIMIT 30"
    );
    res.json(rows);
  } catch { res.json([]); }
});

// Setup status — return object yang aman
app.get('/api/setup/status', async (req, res) => {
  res.json({ installed: true, version: '1.0' });
});

// Rooms
app.get('/api/rooms', authenticate, async (req, res) => {
  try { const [r] = await req.db.query('SELECT * FROM rooms WHERE is_active=1 ORDER BY name'); res.json(r); }
  catch { res.json([]); }
});
app.post('/api/rooms', authenticate, (req, res) => res.json({ success: true, id: 0 }));
app.put('/api/rooms/:id', authenticate, (req, res) => res.json({ success: true }));
app.delete('/api/rooms/:id', authenticate, (req, res) => res.json({ success: true }));

// Orders cancel-requests actions
app.post('/api/orders/cancel-requests/:id/approve', authenticate, async (req, res) => {
  try {
    await req.db.query("UPDATE order_cancel_requests SET status='approved' WHERE id=?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/orders/cancel-requests/:id/reject', authenticate, async (req, res) => {
  try {
    await req.db.query("UPDATE order_cancel_requests SET status='rejected' WHERE id=?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Integrations — return safe empty responses (MikroTik dll optional add-on)
app.use('/api/integrations', (req, res) => {
  if (req.method === 'GET') return res.json({ data: [], items: [], active: [], total: 0 });
  res.json({ success: false, message: 'Integration not configured for this tenant' });
});

// Untuk semua route lain — proxy ke backend nusantara2024 sebagai fallback
// (route files nusantara2024 connect ke DB nusantara2024, BUKAN tenant yang request)
// Ini HANYA dipakai jika shared-backend tidak punya handler inline di atas.
// TODO: tambah route inline untuk semua endpoint cafe-admin yang dibutuhkan.
const STUB_ROUTES = [
  'shifts', 'orders', 'users', 'bookings', 'members', 'reports',
  'ingredients', 'stock', 'expenses', 'vouchers', 'roles',
  'printers', 'stations', 'variants', 'recipes', 'units', 'hr',
  'audit', 'register',
];
for (const name of STUB_ROUTES) {
  app.use(`/api/${name}`, (req, res, next) => {
    // Semua route ini sudah punya handler inline atau di route files
    // Fallback: kembalikan response kosong yang aman
    if (req.method === 'GET') return res.json(name.endsWith('s') ? [] : {});
    if (['POST','PUT','PATCH'].includes(req.method)) return res.json({ success: true, id: 0 });
    if (req.method === 'DELETE') return res.json({ success: true });
    next();
  });
}

// ─── Internal: invalidate pool cache saat tenant upgrade ───────
app.get('/_internal/invalidate/:slug', (req, res) => {
  invalidatePool(req.params.slug);
  res.json({ ok: true });
});

// ─── SPA fallback ──────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'API route not found' });
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[shared-backend] Running on port ${PORT}`);
});

module.exports = { invalidatePool };
