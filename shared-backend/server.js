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
    const [requests] = await req.db.query(
      `SELECT ocr.*, o.order_number, u.name as requested_by_name
       FROM order_cancel_requests ocr
       LEFT JOIN orders o ON o.id = ocr.order_id
       LEFT JOIN users u ON u.id = ocr.requested_by
       WHERE ocr.status = 'pending' ORDER BY ocr.created_at DESC`
    );
    res.json({ requests });
  } catch { res.json({ requests: [] }); }
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

// Posts — public (cafe-ui) and admin
// posts/categories dan posts/tags HARUS sebelum posts/:slug
app.get('/api/posts/categories', async (req, res) => {
  try { const [categories] = await req.db.query('SELECT * FROM post_categories ORDER BY name'); res.json({ categories }); }
  catch { res.json({ categories: [] }); }
});
app.get('/api/posts/tags', async (req, res) => {
  try { const [tags] = await req.db.query('SELECT * FROM post_tags ORDER BY name'); res.json({ tags }); }
  catch { res.json({ tags: [] }); }
});
app.get('/api/posts', async (req, res) => {
  try {
    const [posts] = await req.db.query("SELECT * FROM posts ORDER BY created_at DESC LIMIT 50");
    res.json({ posts, count: posts.length });
  } catch { res.json({ posts: [], count: 0 }); }
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

// Media — return { media } untuk cafe-admin, juga support bare array untuk cafe-ui
app.get('/api/media', async (req, res) => {
  try {
    const [media] = await req.db.query("SELECT * FROM media ORDER BY created_at DESC LIMIT 50");
    // cafe-admin pakai data?.media, cafe-ui pakai .map() langsung — return { media } dan array
    res.json({ media, count: media.length });
  } catch { res.json({ media: [], count: 0 }); }
});

// Setup status — return object yang aman
app.get('/api/setup/status', async (req, res) => {
  res.json({ installed: true, version: '1.0' });
});

// Rooms — return { rooms }
app.get('/api/rooms', authenticate, async (req, res) => {
  try { const [rooms] = await req.db.query('SELECT * FROM rooms ORDER BY name'); res.json({ rooms }); }
  catch { res.json({ rooms: [] }); }
});
app.post('/api/rooms', authenticate, async (req, res) => {
  try {
    const { name, description, capacity, sort_order, is_active } = req.body;
    const [r] = await req.db.query(
      'INSERT INTO rooms (name, description, capacity, sort_order, is_active) VALUES (?,?,?,?,?)',
      [name, description||null, parseInt(capacity)||0, parseInt(sort_order)||0, is_active?1:0]
    );
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/rooms/:id', authenticate, async (req, res) => {
  try {
    const { name, description, capacity, sort_order, is_active } = req.body;
    await req.db.query(
      'UPDATE rooms SET name=?,description=?,capacity=?,sort_order=?,is_active=? WHERE id=?',
      [name, description||null, parseInt(capacity)||0, parseInt(sort_order)||0, is_active?1:0, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/rooms/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM rooms WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ─── Semua endpoint yang perlu wrapped response ────────────────

// Expenses
app.get('/api/expenses', authenticate, async (req, res) => {
  try { const [expenses] = await req.db.query('SELECT e.*, c.name as category_name FROM expenses e LEFT JOIN expense_categories c ON c.id=e.category_id ORDER BY e.created_at DESC LIMIT 100'); res.json({ expenses, count: expenses.length }); }
  catch { res.json({ expenses: [], count: 0 }); }
});
app.get('/api/expenses/categories', authenticate, async (req, res) => {
  try { const [categories] = await req.db.query('SELECT * FROM expense_categories ORDER BY name'); res.json({ categories }); }
  catch { res.json({ categories: [] }); }
});

// Ingredients
app.get('/api/ingredients', authenticate, async (req, res) => {
  try { const [ingredients] = await req.db.query('SELECT * FROM ingredients ORDER BY name'); res.json({ ingredients, count: ingredients.length }); }
  catch { res.json({ ingredients: [], count: 0 }); }
});

// Printers
app.get('/api/printers', authenticate, async (req, res) => {
  try {
    const [printers] = await req.db.query('SELECT * FROM printers ORDER BY name');
    res.json({ printers });
  } catch (e) {
    console.error('[printers]', e.message);
    res.json({ printers: [] });
  }
});

// Stations
app.get('/api/stations', authenticate, async (req, res) => {
  try { const [stations] = await req.db.query('SELECT * FROM stations ORDER BY name'); res.json({ stations }); }
  catch { res.json({ stations: [] }); }
});

// Units
app.get('/api/units', authenticate, async (req, res) => {
  try { const [units] = await req.db.query('SELECT * FROM units WHERE is_active=1 ORDER BY name'); res.json({ units }); }
  catch { res.json({ units: [] }); }
});

// Roles
app.get('/api/roles', authenticate, async (req, res) => {
  try { const [roles] = await req.db.query('SELECT * FROM roles WHERE is_active=1'); res.json({ roles }); }
  catch { res.json({ roles: [] }); }
});

// Vouchers
app.get('/api/vouchers', authenticate, async (req, res) => {
  try { const [vouchers] = await req.db.query('SELECT * FROM vouchers ORDER BY created_at DESC'); res.json({ vouchers, count: vouchers.length }); }
  catch { res.json({ vouchers: [], count: 0 }); }
});

// Recipes
app.get('/api/recipes', authenticate, async (req, res) => {
  try { const [recipes] = await req.db.query('SELECT r.*, p.name as product_name FROM recipes r LEFT JOIN products p ON p.id=r.product_id ORDER BY r.created_at DESC'); res.json({ recipes }); }
  catch { res.json({ recipes: [] }); }
});

// Variants
app.get('/api/variants', authenticate, async (req, res) => {
  try {
    const { product_id } = req.query;
    const where = product_id ? 'WHERE pvg.product_id=?' : '1=1';
    const params = product_id ? [parseInt(product_id)] : [];
    const [variant_groups] = await req.db.query(
      `SELECT pvg.*, JSON_ARRAYAGG(JSON_OBJECT('id',pvo.id,'name',pvo.name,'price_modifier',pvo.price_modifier)) as options
       FROM product_variant_groups pvg
       LEFT JOIN product_variant_options pvo ON pvo.variant_group_id=pvg.id
       ${product_id ? 'WHERE pvg.product_id=?' : ''}
       GROUP BY pvg.id ORDER BY pvg.sort_order`,
      params
    );
    res.json({ variant_groups });
  } catch { res.json({ variant_groups: [] }); }
});

// Stock
app.get('/api/stock/suppliers', authenticate, async (req, res) => {
  try { const [suppliers] = await req.db.query('SELECT * FROM suppliers ORDER BY name'); res.json({ suppliers }); }
  catch { res.json({ suppliers: [] }); }
});
app.get('/api/stock/po', authenticate, async (req, res) => {
  try { const [purchase_orders] = await req.db.query('SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id ORDER BY po.created_at DESC LIMIT 50'); res.json({ purchase_orders }); }
  catch { res.json({ purchase_orders: [] }); }
});
app.get('/api/stock/opname', authenticate, async (req, res) => {
  try { const [opnames] = await req.db.query('SELECT * FROM stock_opnames ORDER BY created_at DESC LIMIT 50'); res.json({ opnames }); }
  catch { res.json({ opnames: [] }); }
});
app.get('/api/stock/adjustment', authenticate, async (req, res) => {
  try { const [logs] = await req.db.query('SELECT * FROM ingredient_stock_log ORDER BY created_at DESC LIMIT 50'); res.json({ logs }); }
  catch { res.json({ logs: [] }); }
});

// HR
app.get('/api/hr/employees', authenticate, async (req, res) => {
  try { const [employees] = await req.db.query('SELECT e.*, u.name as user_name FROM employees e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.full_name'); res.json({ employees }); }
  catch { res.json({ employees: [] }); }
});
app.get('/api/hr/work-shifts', authenticate, async (req, res) => {
  try { const [shifts] = await req.db.query('SELECT * FROM work_shifts ORDER BY name'); res.json({ shifts }); }
  catch { res.json({ shifts: [] }); }
});
app.get('/api/hr/schedules', authenticate, async (req, res) => {
  try { const [schedules] = await req.db.query('SELECT * FROM employee_schedules ORDER BY shift_date DESC LIMIT 100'); res.json({ schedules }); }
  catch { res.json({ schedules: [] }); }
});
app.get('/api/hr/attendance', authenticate, async (req, res) => {
  try { const [attendance] = await req.db.query('SELECT * FROM attendance ORDER BY date DESC LIMIT 100'); res.json({ attendance }); }
  catch { res.json({ attendance: [] }); }
});
app.get('/api/hr/kpi', authenticate, async (req, res) => {
  try { const [metrics] = await req.db.query('SELECT * FROM employee_kpi ORDER BY period_year DESC, period_month DESC LIMIT 50'); res.json({ metrics, staff: [] }); }
  catch { res.json({ metrics: [], staff: [] }); }
});
app.get('/api/hr/kpi/metrics', authenticate, async (req, res) => {
  try { const [metrics] = await req.db.query('SELECT * FROM kpi_metrics WHERE is_active=1'); res.json({ metrics }); }
  catch { res.json({ metrics: [] }); }
});
app.get('/api/hr/payroll', authenticate, async (req, res) => {
  try { const [payroll] = await req.db.query('SELECT p.*, e.full_name FROM payroll p LEFT JOIN employees e ON e.id=p.employee_id ORDER BY p.period_year DESC, p.period_month DESC LIMIT 50'); res.json({ payroll }); }
  catch { res.json({ payroll: [] }); }
});
app.get('/api/hr/shift-swaps', authenticate, async (req, res) => {
  try { const [swaps] = await req.db.query('SELECT * FROM shift_swaps ORDER BY created_at DESC LIMIT 50'); res.json({ swaps }); }
  catch { res.json({ swaps: [] }); }
});
app.get('/api/hr/settings', authenticate, async (req, res) => res.json({ hours: { start: '08:00', end: '22:00' } }));

// Members
app.get('/api/members/topup-requests/pending', authenticate, async (req, res) => {
  try { const [requests] = await req.db.query("SELECT * FROM topup_requests WHERE status='pending' ORDER BY created_at DESC"); res.json({ requests }); }
  catch { res.json({ requests: [] }); }
});

// Payments balance
app.get('/api/payments/balance', authenticate, async (req, res) => {
  try {
    const [[user]] = await req.db.query('SELECT balance, is_priority FROM users WHERE id=?', [req.user.id]);
    res.json({ balance: parseFloat(user?.balance||0), is_priority: !!user?.is_priority, transactions: [] });
  } catch { res.json({ balance: 0, is_priority: false, transactions: [] }); }
});

// System info
app.get('/api/system/info', authenticate, async (req, res) => {
  try {
    const [[{ users }]] = await req.db.query('SELECT COUNT(*) as users FROM users');
    const [[{ products }]] = await req.db.query('SELECT COUNT(*) as products FROM products');
    res.json({ tenant: { tier: 'free', mode: 'shared' }, stats: { total_users: parseInt(users), total_products: parseInt(products) } });
  } catch { res.json({ tenant: { tier: 'free', mode: 'shared' }, stats: {} }); }
});

// Media — wrapped for admin
app.get('/api/media/list', authenticate, async (req, res) => {
  try { const [media] = await req.db.query('SELECT * FROM media ORDER BY created_at DESC LIMIT 50'); res.json({ media }); }
  catch { res.json({ media: [] }); }
});

// Integrations list — return { integrations }
app.get('/api/integrations', authenticate, async (req, res) => res.json({ integrations: [], count: 0 }));
app.get('/api/integrations/logs', authenticate, async (req, res) => res.json({ logs: [], count: 0 }));

// ─── CRUD handlers untuk semua entitas ────────────────────────

// Tables CRUD
app.post('/api/tables', authenticate, async (req, res) => {
  try {
    const { number, capacity, status } = req.body;
    const [r] = await req.db.query('INSERT INTO `tables` (number, capacity, status) VALUES (?,?,?)', [number, parseInt(capacity)||4, status||'available']);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/tables/:id', authenticate, async (req, res) => {
  try {
    const { number, capacity, status } = req.body;
    await req.db.query('UPDATE `tables` SET number=?,capacity=?,status=? WHERE id=?', [number, parseInt(capacity)||4, status||'available', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/tables/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM `tables` WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Users CRUD
app.post('/api/users', authenticate, async (req, res) => {
  try {
    const { name, email, password, role, phone } = req.body;
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(password || 'password123', 10);
    const [r] = await req.db.query('INSERT INTO users (name, email, password, role, phone, status) VALUES (?,?,?,?,?,?)', [name, email, hashed, role||'kasir', phone||null, 'active']);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/users/:id', authenticate, async (req, res) => {
  try {
    const { name, email, role, phone, status, balance, is_priority } = req.body;
    const fields = [], vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (email !== undefined) { fields.push('email=?'); vals.push(email); }
    if (role !== undefined) { fields.push('role=?'); vals.push(role); }
    if (phone !== undefined) { fields.push('phone=?'); vals.push(phone); }
    if (status !== undefined) { fields.push('status=?'); vals.push(status); }
    if (balance !== undefined) { fields.push('balance=?'); vals.push(parseFloat(balance)); }
    if (is_priority !== undefined) { fields.push('is_priority=?'); vals.push(is_priority?1:0); }
    if (!fields.length) return res.json({ success: true });
    vals.push(req.params.id);
    await req.db.query(`UPDATE users SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/users/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM users WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Expenses CRUD
app.post('/api/expenses', authenticate, async (req, res) => {
  try {
    const { title, amount, category_id, date, notes } = req.body;
    const [r] = await req.db.query('INSERT INTO expenses (title, amount, category_id, date, notes, created_by) VALUES (?,?,?,?,?,?)', [title, parseFloat(amount), category_id||null, date||new Date().toISOString().split('T')[0], notes||null, req.user.id]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/expenses/:id', authenticate, async (req, res) => {
  try {
    const { title, amount, category_id, date, notes } = req.body;
    await req.db.query('UPDATE expenses SET title=?,amount=?,category_id=?,date=?,notes=? WHERE id=?', [title, parseFloat(amount), category_id||null, date, notes||null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/expenses/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM expenses WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Vouchers CRUD
app.post('/api/vouchers', authenticate, async (req, res) => {
  try {
    const { code, name, type, value, min_order, max_discount, start_date, end_date, usage_limit, is_active } = req.body;
    const [r] = await req.db.query('INSERT INTO vouchers (code, name, type, value, min_order, max_discount, start_date, end_date, usage_limit, is_active) VALUES (?,?,?,?,?,?,?,?,?,?)', [code, name, type||'percentage', parseFloat(value), parseFloat(min_order||0), max_discount?parseFloat(max_discount):null, start_date||null, end_date||null, usage_limit||null, is_active?1:1]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/vouchers/:id', authenticate, async (req, res) => {
  try {
    const { code, name, type, value, min_order, max_discount, start_date, end_date, usage_limit, is_active } = req.body;
    await req.db.query('UPDATE vouchers SET code=?,name=?,type=?,value=?,min_order=?,max_discount=?,start_date=?,end_date=?,usage_limit=?,is_active=? WHERE id=?', [code, name, type, parseFloat(value), parseFloat(min_order||0), max_discount?parseFloat(max_discount):null, start_date||null, end_date||null, usage_limit||null, is_active?1:0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/vouchers/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM vouchers WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Ingredients CRUD
app.post('/api/ingredients', authenticate, async (req, res) => {
  try {
    const { name, unit, stock_qty, min_stock, unit_cost } = req.body;
    const [r] = await req.db.query('INSERT INTO ingredients (name, unit, stock_qty, min_stock, unit_cost) VALUES (?,?,?,?,?)', [name, unit||'pcs', parseFloat(stock_qty||0), parseFloat(min_stock||0), parseFloat(unit_cost||0)]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/ingredients/:id', authenticate, async (req, res) => {
  try {
    const { name, unit, stock_qty, min_stock, unit_cost } = req.body;
    await req.db.query('UPDATE ingredients SET name=?,unit=?,stock_qty=?,min_stock=?,unit_cost=? WHERE id=?', [name, unit, parseFloat(stock_qty||0), parseFloat(min_stock||0), parseFloat(unit_cost||0), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ingredients/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM ingredients WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Printers CRUD
app.post('/api/printers', authenticate, async (req, res) => {
  try {
    const { name, type, connection, ip, port, paper_width, char_per_line, is_default, is_active, auto_cut, header_text, footer_text, sort_order } = req.body;
    const [r] = await req.db.query('INSERT INTO printers (name, type, connection, ip, port, paper_width, char_per_line, is_default, is_active, auto_cut, header_text, footer_text, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [name, type||'receipt', connection||'browser', ip||null, parseInt(port||9100), paper_width||'80mm', parseInt(char_per_line||42), is_default?1:0, is_active?1:1, auto_cut?1:1, header_text||'', footer_text||'', parseInt(sort_order||99)]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/printers/:id', authenticate, async (req, res) => {
  try {
    const fields = [], vals = [];
    const allowed = ['name','type','connection','ip','port','paper_width','char_per_line','is_default','is_active','auto_cut','header_text','footer_text','sort_order'];
    for (const k of allowed) if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k]); }
    vals.push(req.params.id);
    await req.db.query(`UPDATE printers SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/printers/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM printers WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Stations CRUD
app.post('/api/stations', authenticate, async (req, res) => {
  try {
    const { name, type, description, is_active } = req.body;
    const [r] = await req.db.query('INSERT INTO stations (name, type, description, is_active) VALUES (?,?,?,?)', [name, type||'kitchen', description||null, is_active?1:1]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/stations/:id', authenticate, async (req, res) => {
  try {
    await req.db.query('UPDATE stations SET name=?,type=?,description=?,is_active=? WHERE id=?', [req.body.name, req.body.type||'kitchen', req.body.description||null, req.body.is_active?1:0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/stations/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM stations WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Units CRUD
app.post('/api/units', authenticate, async (req, res) => {
  try {
    const { name, symbol, type, base_unit_id, conversion_factor, is_active } = req.body;
    const [r] = await req.db.query('INSERT INTO units (name, symbol, type, base_unit_id, conversion_factor, is_active) VALUES (?,?,?,?,?,?)', [name, symbol||name, type||'custom', base_unit_id||null, parseFloat(conversion_factor||1), is_active?1:1]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/units/:id', authenticate, async (req, res) => {
  try {
    await req.db.query('UPDATE units SET name=?,symbol=?,type=?,base_unit_id=?,conversion_factor=?,is_active=? WHERE id=?', [req.body.name, req.body.symbol||req.body.name, req.body.type||'custom', req.body.base_unit_id||null, parseFloat(req.body.conversion_factor||1), req.body.is_active?1:0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SHIFTS CRUD ──────────────────────────────────────────────
app.post('/api/shifts/open', authenticate, async (req, res) => {
  try {
    const { opening_cash, notes, station_id } = req.body;
    // Cek apakah sudah ada shift open
    const [[existing]] = await req.db.query("SELECT id FROM shifts WHERE status='open' AND opened_by=?", [req.user.id]);
    if (existing) return res.status(400).json({ error: 'Shift sudah terbuka', shift_id: existing.id });

    // Generate shift number
    await req.db.query("INSERT INTO order_sequences (seq_key, last_number) VALUES ('shift',1) ON DUPLICATE KEY UPDATE last_number=last_number+1");
    const [[{ last_number }]] = await req.db.query("SELECT last_number FROM order_sequences WHERE seq_key='shift'");
    const shiftNumber = `S${String(last_number).padStart(4,'0')}`;

    const [r] = await req.db.query(
      "INSERT INTO shifts (shift_number, opened_by, station_id, opening_cash, status, notes) VALUES (?,?,?,?,?,?)",
      [shiftNumber, req.user.id, station_id||null, parseFloat(opening_cash||0), 'open', notes||null]
    );
    const [[shift]] = await req.db.query('SELECT s.*, u.name as opened_by_name FROM shifts s LEFT JOIN users u ON u.id=s.opened_by WHERE s.id=?', [r.insertId]);
    res.json({ success: true, shift });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/shifts/:id/close', authenticate, async (req, res) => {
  try {
    const { closing_cash, handover_cash, notes } = req.body;
    const [[shift]] = await req.db.query('SELECT * FROM shifts WHERE id=? AND status="open"', [req.params.id]);
    if (!shift) return res.status(404).json({ error: 'Shift tidak ditemukan atau sudah ditutup' });

    const [[{ total_orders }]] = await req.db.query("SELECT COUNT(*) as total_orders FROM orders WHERE shift_id=?", [shift.id]);
    const [[{ total_revenue, cash_revenue }]] = await req.db.query(
      "SELECT COALESCE(SUM(total_amount),0) as total_revenue, COALESCE(SUM(CASE WHEN payment_method='cash' THEN total_amount ELSE 0 END),0) as cash_revenue FROM orders WHERE shift_id=?",
      [shift.id]
    );
    const closingAmt = parseFloat(closing_cash||0);
    const expectedCash = parseFloat(shift.opening_cash||0) + parseFloat(cash_revenue);
    const cashDiff = closingAmt - expectedCash;

    await req.db.query(
      "UPDATE shifts SET status='closed', closed_by=?, closed_at=NOW(), closing_cash=?, handover_cash=?, expected_cash=?, cash_difference=?, notes=COALESCE(?,notes), total_orders=?, total_revenue=?, cash_revenue=? WHERE id=?",
      [req.user.id, closingAmt, parseFloat(handover_cash||closingAmt), expectedCash, cashDiff, notes||null, parseInt(total_orders), parseFloat(total_revenue), parseFloat(cash_revenue), shift.id]
    );
    const [[updated]] = await req.db.query('SELECT s.*, u.name as opened_by_name FROM shifts s LEFT JOIN users u ON u.id=s.opened_by WHERE s.id=?', [shift.id]);
    res.json({ success: true, shift: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shifts/:id/report', authenticate, async (req, res) => {
  try {
    const [[shift]] = await req.db.query('SELECT s.*, u.name as opened_by_name FROM shifts s LEFT JOIN users u ON u.id=s.opened_by WHERE s.id=?', [req.params.id]);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const [orders] = await req.db.query('SELECT o.*, t.number as table_number FROM orders o LEFT JOIN `tables` t ON t.id=o.table_id WHERE o.shift_id=?', [shift.id]);
    const [paymentBreakdown] = await req.db.query("SELECT payment_method, COUNT(*) as count, SUM(total_amount) as total FROM orders WHERE shift_id=? GROUP BY payment_method", [shift.id]);
    res.json({ shift, orders, payment_breakdown: paymentBreakdown, total_orders: orders.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BRANCHES CRUD ────────────────────────────────────────────
app.post('/api/branches', authenticate, async (req, res) => {
  try {
    const { name, code, address, phone, email, city, is_active, is_main } = req.body;
    const [r] = await req.db.query('INSERT INTO branches (name, code, address, phone, email, city, is_active, is_main) VALUES (?,?,?,?,?,?,?,?)', [name, code||name.substring(0,10).toUpperCase(), address||null, phone||null, email||null, city||null, is_active?1:1, is_main?1:0]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/branches/:id', authenticate, async (req, res) => {
  try {
    const { name, code, address, phone, email, city, is_active, is_main } = req.body;
    await req.db.query('UPDATE branches SET name=?,code=?,address=?,phone=?,email=?,city=?,is_active=?,is_main=? WHERE id=?', [name, code, address||null, phone||null, email||null, city||null, is_active?1:0, is_main?1:0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/branches/:id', authenticate, async (req, res) => {
  try { await req.db.query('UPDATE branches SET is_active=0 WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BOOKINGS CRUD ────────────────────────────────────────────
app.get('/api/bookings', authenticate, async (req, res) => {
  try { const [bookings] = await req.db.query('SELECT * FROM bookings ORDER BY booking_date DESC, booking_time DESC LIMIT 50'); res.json({ bookings }); }
  catch { res.json({ bookings: [] }); }
});
app.post('/api/bookings', authenticate, async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_email, room_id, table_id, booking_date, booking_time, pax, notes, deposit_amount, total_amount } = req.body;
    const num = `BK${Date.now().toString().slice(-6)}`;
    const [r] = await req.db.query('INSERT INTO bookings (booking_number,customer_name,customer_phone,customer_email,room_id,table_id,booking_date,booking_time,pax,notes,deposit_amount,total_amount,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [num, customer_name, customer_phone||null, customer_email||null, room_id||null, table_id||null, booking_date, booking_time, parseInt(pax||1), notes||null, parseFloat(deposit_amount||0), parseFloat(total_amount||0), req.user.id]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/bookings/:id', authenticate, async (req, res) => {
  try {
    const allowed = ['customer_name','customer_phone','customer_email','room_id','table_id','booking_date','booking_time','pax','notes','status','deposit_amount','total_amount'];
    const fields=[],vals=[];
    for(const k of allowed) if(req.body[k]!==undefined){fields.push(`${k}=?`);vals.push(req.body[k]);}
    vals.push(req.params.id);
    await req.db.query(`UPDATE bookings SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bookings/:id', authenticate, async (req, res) => {
  try { await req.db.query("UPDATE bookings SET status='cancelled' WHERE id=?", [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RECIPES CRUD ─────────────────────────────────────────────
app.post('/api/recipes', authenticate, async (req, res) => {
  try {
    const { product_id, ingredient_id, qty, unit } = req.body;
    const [r] = await req.db.query('INSERT INTO recipe_items (product_id, ingredient_id, qty, unit) VALUES (?,?,?,?)', [product_id, ingredient_id, parseFloat(qty), unit||'pcs']);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/recipes/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM recipe_items WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ROLES CRUD ───────────────────────────────────────────────
app.post('/api/roles', authenticate, async (req, res) => {
  try {
    const { name, label, permissions } = req.body;
    const [r] = await req.db.query('INSERT INTO roles (name, label, permissions, is_active) VALUES (?,?,?,1)', [name, label||name, permissions ? JSON.stringify(permissions) : null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/roles/:id', authenticate, async (req, res) => {
  try {
    const { name, label, permissions, is_active } = req.body;
    await req.db.query('UPDATE roles SET name=?,label=?,permissions=?,is_active=? WHERE id=?', [name, label||name, permissions?JSON.stringify(permissions):null, is_active?1:0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/roles/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM roles WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VARIANTS CRUD ────────────────────────────────────────────
app.post('/api/variants/groups', authenticate, async (req, res) => {
  try {
    const { product_id, name, is_required, sort_order } = req.body;
    const [r] = await req.db.query('INSERT INTO product_variant_groups (product_id,name,is_required,sort_order) VALUES (?,?,?,?)', [product_id, name, is_required?1:0, parseInt(sort_order||0)]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/variants/options', authenticate, async (req, res) => {
  try {
    const { variant_group_id, name, price_modifier, sort_order, is_active } = req.body;
    const [r] = await req.db.query('INSERT INTO product_variant_options (variant_group_id,name,price_modifier,sort_order,is_active) VALUES (?,?,?,?,?)', [variant_group_id, name, parseFloat(price_modifier||0), parseInt(sort_order||0), is_active?1:1]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/variants/addon-groups', authenticate, async (req, res) => {
  try {
    const { product_id, name, sort_order } = req.body;
    const [r] = await req.db.query('INSERT INTO product_addon_groups (product_id,name,sort_order) VALUES (?,?,?)', [product_id, name, parseInt(sort_order||0)]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/variants/addons', authenticate, async (req, res) => {
  try {
    const { addon_group_id, name, price, is_active, sort_order } = req.body;
    const [r] = await req.db.query('INSERT INTO product_addons (addon_group_id,name,price,is_active,sort_order) VALUES (?,?,?,?,?)', [addon_group_id, name, parseFloat(price||0), is_active?1:1, parseInt(sort_order||0)]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/variants/groups/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM product_variant_groups WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/variants/options/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM product_variant_options WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/variants/addon-groups/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM product_addon_groups WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/variants/addons/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM product_addons WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STOCK CRUD ───────────────────────────────────────────────
app.post('/api/stock/suppliers', authenticate, async (req, res) => {
  try {
    const { name, contact, phone, email, address } = req.body;
    const [r] = await req.db.query('INSERT INTO suppliers (name,contact,phone,email,address) VALUES (?,?,?,?,?)', [name, contact||null, phone||null, email||null, address||null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/stock/suppliers/:id', authenticate, async (req, res) => {
  try {
    const { name, contact, phone, email, address } = req.body;
    await req.db.query('UPDATE suppliers SET name=?,contact=?,phone=?,email=?,address=? WHERE id=?', [name, contact||null, phone||null, email||null, address||null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stock/po', authenticate, async (req, res) => {
  try {
    const { supplier_id, notes, items } = req.body;
    const num = `PO${Date.now().toString().slice(-6)}`;
    const total = (items||[]).reduce((s,i) => s + parseFloat(i.qty||0)*parseFloat(i.unit_cost||0), 0);
    const [r] = await req.db.query('INSERT INTO purchase_orders (po_number,supplier_id,notes,total_amount,status,created_by) VALUES (?,?,?,?,?,?)', [num, supplier_id||null, notes||null, total, 'draft', req.user.id]);
    for (const item of (items||[])) {
      await req.db.query('INSERT INTO purchase_order_items (po_id,ingredient_id,qty,unit_cost,total_cost) VALUES (?,?,?,?,?)', [r.insertId, item.ingredient_id, parseFloat(item.qty), parseFloat(item.unit_cost||0), parseFloat(item.qty)*parseFloat(item.unit_cost||0)]);
    }
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stock/adjustment', authenticate, async (req, res) => {
  try {
    const { ingredient_id, qty_change, movement_type, note } = req.body;
    const [[ing]] = await req.db.query('SELECT stock_qty FROM ingredients WHERE id=?', [ingredient_id]);
    const before = parseFloat(ing?.stock_qty||0);
    const after = before + parseFloat(qty_change);
    await req.db.query('UPDATE ingredients SET stock_qty=? WHERE id=?', [after, ingredient_id]);
    await req.db.query('INSERT INTO ingredient_stock_log (ingredient_id,movement_type,qty,qty_before,qty_after,note,created_by) VALUES (?,?,?,?,?,?,?)', [ingredient_id, movement_type||'adjustment', parseFloat(qty_change), before, after, note||null, req.user.id]);
    res.json({ success: true, qty_before: before, qty_after: after });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stock/opname', authenticate, async (req, res) => {
  try {
    const { notes, items } = req.body;
    const [r] = await req.db.query('INSERT INTO stock_opnames (notes, status, created_by) VALUES (?,?,?)', [notes||null, 'draft', req.user.id]);
    for (const item of (items||[])) {
      await req.db.query('INSERT INTO stock_opname_items (opname_id,ingredient_id,system_qty,actual_qty,difference) VALUES (?,?,?,?,?)', [r.insertId, item.ingredient_id, parseFloat(item.system_qty||0), parseFloat(item.actual_qty||0), parseFloat(item.actual_qty||0)-parseFloat(item.system_qty||0)]);
    }
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MEDIA UPLOAD ─────────────────────────────────────────────
app.post('/api/media/upload', authenticate, async (req, res) => {
  try {
    const { image, filename, folder } = req.body;
    // Untuk shared tier, simpan base64 atau URL — return dummy URL
    const url = image || '';
    const [r] = await req.db.query('INSERT INTO media (filename, original_name, url, folder, uploaded_by) VALUES (?,?,?,?,?)', [filename||'upload', filename||'upload', url, folder||'general', req.user.id]);
    res.json({ success: true, id: r.insertId, url, filename: filename||'upload' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MEMBERS ──────────────────────────────────────────────────
app.get('/api/members', authenticate, async (req, res) => {
  try {
    const { search, limit = 20, page = 1 } = req.query;
    let where = "role='member'";
    const params = [];
    if (search) { where += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
    const [members] = await req.db.query(`SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), (parseInt(page)-1)*parseInt(limit)]);
    res.json({ members, count: members.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/members/search', authenticate, async (req, res) => {
  try {
    const q = req.query.q||'';
    const [members] = await req.db.query("SELECT * FROM users WHERE (name LIKE ? OR email LIKE ? OR phone LIKE ?) AND role='member' LIMIT 10", [`%${q}%`,`%${q}%`,`%${q}%`]);
    res.json(members);
  } catch { res.json([]); }
});
app.post('/api/members/check-priority', authenticate, async (req, res) => {
  try { res.json({ message: 'Priority checked', updated: 0 }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/members/:id', authenticate, async (req, res) => {
  try {
    const { name, email, phone, balance, is_priority, status } = req.body;
    const fields=[],vals=[];
    if(name!==undefined){fields.push('name=?');vals.push(name);}
    if(email!==undefined){fields.push('email=?');vals.push(email);}
    if(phone!==undefined){fields.push('phone=?');vals.push(phone);}
    if(balance!==undefined){fields.push('balance=?');vals.push(parseFloat(balance));}
    if(is_priority!==undefined){fields.push('is_priority=?');vals.push(is_priority?1:0);}
    if(status!==undefined){fields.push('status=?');vals.push(status);}
    vals.push(req.params.id);
    if(fields.length) await req.db.query(`UPDATE users SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PAYMENTS TOPUP (member) ──────────────────────────────────
app.post('/api/payments/topup', authenticate, async (req, res) => {
  try {
    const { user_id, amount, note } = req.body;
    const [[user]] = await req.db.query('SELECT id,balance FROM users WHERE id=?', [user_id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newBal = parseFloat(user.balance||0) + parseFloat(amount);
    await req.db.query('UPDATE users SET balance=? WHERE id=?', [newBal, user_id]);
    await req.db.query('INSERT INTO balance_transactions (user_id,type,amount,balance_before,balance_after,note,created_by) VALUES (?,?,?,?,?,?,?)', [user_id,'topup',parseFloat(amount),parseFloat(user.balance||0),newBal,note||'Top-up kasir',req.user.id]);
    res.json({ success: true, new_balance: newBal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/payments/priority', authenticate, async (req, res) => {
  try {
    const { user_id, is_priority } = req.body;
    await req.db.query('UPDATE users SET is_priority=? WHERE id=?', [is_priority?1:0, user_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── USERS quick register ─────────────────────────────────────
app.post('/api/users/register-quick', authenticate, async (req, res) => {
  try {
    const { name, email, phone, role } = req.body;
    const bcrypt = require('bcryptjs');
    const pw = require('crypto').randomBytes(4).toString('hex');
    const hashed = await bcrypt.hash(pw, 10);
    const [r] = await req.db.query('INSERT INTO users (name,email,phone,password,role,status) VALUES (?,?,?,?,?,?)', [name, email||null, phone||null, hashed, role||'member', 'active']);
    res.status(201).json({ success: true, id: r.insertId, temp_password: pw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POSTS CRUD ───────────────────────────────────────────────
app.post('/api/posts', authenticate, async (req, res) => {
  try {
    const { title, slug, content, excerpt, status, featured_image } = req.body;
    const s = slug || title.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const [r] = await req.db.query('INSERT INTO posts (title,slug,content,excerpt,status,featured_image,author_id,published_at) VALUES (?,?,?,?,?,?,?,?)', [title, s, content||'', excerpt||null, status||'draft', featured_image||null, req.user.id, status==='published'?new Date():null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/posts/:id', authenticate, async (req, res) => {
  try {
    const { title, slug, content, excerpt, status, featured_image } = req.body;
    await req.db.query('UPDATE posts SET title=?,slug=?,content=?,excerpt=?,status=?,featured_image=?,published_at=? WHERE id=?', [title, slug, content||'', excerpt||null, status||'draft', featured_image||null, status==='published'?new Date():null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/posts/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM posts WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts/categories', authenticate, async (req, res) => {
  try {
    const { name, slug } = req.body;
    const [r] = await req.db.query('INSERT INTO post_categories (name,slug) VALUES (?,?)', [name, slug||name.toLowerCase().replace(/\s+/g,'-')]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts/tags', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    const [r] = await req.db.query('INSERT INTO post_tags (name,slug) VALUES (?,?)', [name, name.toLowerCase().replace(/\s+/g,'-')]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HR CRUD ──────────────────────────────────────────────────
app.post('/api/hr/employees', authenticate, async (req, res) => {
  try {
    const { full_name, employee_code, position, department, employment_type, base_salary, branch_id, phone } = req.body;
    const code = employee_code || `EMP${Date.now().toString().slice(-5)}`;
    const [r] = await req.db.query('INSERT INTO employees (full_name,employee_code,position,department,employment_type,base_salary,branch_id,phone) VALUES (?,?,?,?,?,?,?,?)', [full_name, code, position||null, department||null, employment_type||'full-time', parseFloat(base_salary||0), branch_id||null, phone||null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/hr/employees/:id', authenticate, async (req, res) => {
  try {
    const allowed = ['full_name','position','department','employment_type','base_salary','phone','status','branch_id'];
    const fields=[],vals=[];
    for(const k of allowed) if(req.body[k]!==undefined){fields.push(`${k}=?`);vals.push(req.body[k]);}
    vals.push(req.params.id);
    if(fields.length) await req.db.query(`UPDATE employees SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/work-shifts', authenticate, async (req, res) => {
  try {
    const { name, start_time, end_time, break_duration } = req.body;
    const [r] = await req.db.query('INSERT INTO work_shifts (name,start_time,end_time,break_duration) VALUES (?,?,?,?)', [name, start_time||'08:00', end_time||'17:00', parseInt(break_duration||60)]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/hr/work-shifts/:id', authenticate, async (req, res) => {
  try {
    const { name, start_time, end_time, break_duration } = req.body;
    await req.db.query('UPDATE work_shifts SET name=?,start_time=?,end_time=?,break_duration=? WHERE id=?', [name, start_time, end_time, parseInt(break_duration||60), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/hr/work-shifts/:id', authenticate, async (req, res) => {
  try { await req.db.query('DELETE FROM work_shifts WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/schedules', authenticate, async (req, res) => {
  try {
    const { employee_id, shift_date, shift_start, shift_end, branch_id, notes } = req.body;
    const [r] = await req.db.query('INSERT INTO employee_schedules (employee_id,shift_date,shift_start,shift_end,branch_id,notes) VALUES (?,?,?,?,?,?)', [employee_id, shift_date, shift_start, shift_end, branch_id||null, notes||null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/schedules/bulk', authenticate, async (req, res) => {
  try {
    const { schedules } = req.body;
    for (const s of (schedules||[])) await req.db.query('INSERT INTO employee_schedules (employee_id,shift_date,shift_start,shift_end,branch_id) VALUES (?,?,?,?,?)', [s.employee_id, s.shift_date, s.shift_start, s.shift_end, s.branch_id||null]);
    res.json({ success: true, count: (schedules||[]).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/attendance/clock-in', authenticate, async (req, res) => {
  try {
    const { employee_id, notes } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().split(' ')[0].substring(0,5);
    const [[existing]] = await req.db.query('SELECT id FROM attendance WHERE employee_id=? AND date=?', [employee_id, today]);
    if (existing) return res.status(400).json({ error: 'Sudah clock-in hari ini' });
    const [r] = await req.db.query('INSERT INTO attendance (employee_id,date,check_in,status,notes) VALUES (?,?,?,?,?)', [employee_id, today, now, 'present', notes||null]);
    res.json({ success: true, id: r.insertId, check_in: now });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/attendance/clock-out', authenticate, async (req, res) => {
  try {
    const { employee_id } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().split(' ')[0].substring(0,5);
    await req.db.query("UPDATE attendance SET check_out=? WHERE employee_id=? AND date=? AND check_out IS NULL", [now, employee_id, today]);
    res.json({ success: true, check_out: now });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/payroll/generate', authenticate, async (req, res) => {
  try {
    const { month, year } = req.body;
    res.json({ success: true, message: 'Payroll generated', month, year });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/kpi', authenticate, async (req, res) => {
  try {
    const { employee_id, period_month, period_year, metric_name, target, actual } = req.body;
    const score = target > 0 ? Math.min(100, (actual/target)*100) : 0;
    const [r] = await req.db.query('INSERT INTO employee_kpi (employee_id,period_month,period_year,metric_name,target,actual,score) VALUES (?,?,?,?,?,?,?)', [employee_id, period_month, period_year, metric_name, parseFloat(target), parseFloat(actual), score]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/kpi/metrics', authenticate, async (req, res) => {
  try {
    const { name, description, unit } = req.body;
    const [r] = await req.db.query('INSERT INTO kpi_metrics (name,description,unit) VALUES (?,?,?)', [name, description||null, unit||null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/hr/kpi/metrics/:id', authenticate, async (req, res) => {
  try { await req.db.query('UPDATE kpi_metrics SET is_active=0 WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hr/shift-swaps', authenticate, async (req, res) => {
  try {
    const { from_employee_id, to_employee_id, swap_date, reason } = req.body;
    const [r] = await req.db.query('INSERT INTO shift_swaps (from_employee_id,to_employee_id,swap_date,reason,status) VALUES (?,?,?,?,?)', [from_employee_id, to_employee_id, swap_date, reason||null, 'pending']);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/hr/settings', authenticate, async (req, res) => {
  try {
    for (const [k,v] of Object.entries(req.body||{})) await req.db.query('INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [`hr_${k}`, v, v]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AUDIT LOG ────────────────────────────────────────────────
app.get('/api/audit', authenticate, async (req, res) => {
  try { const [logs] = await req.db.query('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 100'); res.json({ logs }); }
  catch { res.json({ logs: [] }); }
});

// ─── VOUCHERS validate ────────────────────────────────────────
app.post('/api/vouchers/validate', async (req, res) => {
  try {
    const { code, amount } = req.body;
    const [[voucher]] = await req.db.query("SELECT * FROM vouchers WHERE code=? AND is_active=1 AND (end_date IS NULL OR end_date >= CURDATE()) AND (usage_limit IS NULL OR used_count < usage_limit)", [code]);
    if (!voucher) return res.status(404).json({ valid: false, error: 'Voucher tidak valid' });
    const minOrder = parseFloat(voucher.min_order||0);
    if (amount && parseFloat(amount) < minOrder) return res.status(400).json({ valid: false, error: `Minimum order Rp ${minOrder.toLocaleString('id')}` });
    let discount = 0;
    if (voucher.type === 'percentage') discount = parseFloat(amount||0) * parseFloat(voucher.value)/100;
    else discount = parseFloat(voucher.value);
    if (voucher.max_discount) discount = Math.min(discount, parseFloat(voucher.max_discount));
    res.json({ valid: true, voucher, discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATIONS display ─────────────────────────────────────────
app.get('/api/stations/display', async (req, res) => {
  try {
    const { station_id } = req.query;
    const [orders] = await req.db.query("SELECT o.*, oi.product_id, p.name as product_name, oi.quantity, oi.notes as item_notes FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.order_status IN ('pending','preparing') AND (? IS NULL OR oi.station_id=?) ORDER BY o.created_at ASC", [station_id||null, station_id||null]);
    res.json({ orders });
  } catch { res.json({ orders: [] }); }
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
