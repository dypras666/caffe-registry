const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api', limiter);

let db;
async function initDB() {
  db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
  });
}

const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); }
};

// ── PUBLIC ──
app.get('/api/settings/public', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_key, setting_value FROM settings");
    const obj = {};
    for (const r of rows) obj[r.setting_key] = r.setting_value;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/branches', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT id, name, address, phone, email, image_url, is_active FROM branches WHERE is_active=1 ORDER BY id");
    res.json({ branches: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT p.id, p.name, p.price, p.description, p.is_available, p.image_url, p.category_id, c.name as category FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.is_available=1 ORDER BY c.name, p.name");
    res.json({ products: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT id, name, description FROM categories WHERE is_active=1 ORDER BY name");
    res.json({ categories: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTH ──
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!users.length || !(await bcrypt.compare(password, users[0].password)))
      return res.status(401).json({ error: 'Email atau password salah' });
    const token = jwt.sign({ id: users[0].id, email: users[0].email, role: users[0].role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: users[0].id, name: users[0].name, email: users[0].email, role: users[0].role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const [users] = await db.query('SELECT id, name, email, role, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!users.length) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ user: users[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: categories ──
app.get('/api/categories/manage', auth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM categories ORDER BY name");
    res.json({ categories: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categories', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama kategori wajib' });
    const [r] = await db.query('INSERT INTO categories (name, description) VALUES (?,?)', [name, description || null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/categories/:id', auth, async (req, res) => {
  try {
    const { name, description, is_active } = req.body;
    await db.query('UPDATE categories SET name=COALESCE(?,name), description=COALESCE(?,description), is_active=COALESCE(?,is_active) WHERE id=?', [name||null, description??null, is_active??null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/categories/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM categories WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: products ──
app.get('/api/products/manage', auth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT p.*, c.name as category FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY c.name, p.name");
    res.json({ products: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', auth, async (req, res) => {
  try {
    const { name, category_id, price, description, image_url } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama produk wajib' });
    const [r] = await db.query('INSERT INTO products (name, category_id, price, description, image_url) VALUES (?,?,?,?,?)', [name, category_id||null, price||0, description||null, image_url||null]);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', auth, async (req, res) => {
  try {
    const { name, category_id, price, description, is_available, image_url } = req.body;
    await db.query('UPDATE products SET name=COALESCE(?,name), category_id=COALESCE(?,category_id), price=COALESCE(?,price), description=COALESCE(?,description), is_available=COALESCE(?,is_available), image_url=COALESCE(?,image_url) WHERE id=?',
      [name||null, category_id??null, price??null, description??null, is_available??null, image_url??null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: orders ──
app.get('/api/orders', auth, async (req, res) => {
  try {
    const { status, date } = req.query;
    let sql = "SELECT * FROM orders WHERE 1=1";
    const params = [];
    if (status) { sql += " AND status=?"; params.push(status); }
    if (date) { sql += " AND DATE(created_at)=?"; params.push(date); }
    sql += " ORDER BY created_at DESC LIMIT 100";
    const [rows] = await db.query(sql, params);
    res.json({ orders: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/orders/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status wajib' });
    await db.query('UPDATE orders SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/daily-summary', auth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(total_amount),0) as revenue FROM orders WHERE status!='cancelled' GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30");
    res.json({ daily: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: users ──
app.get('/api/users', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, email, role, created_at FROM users ORDER BY name');
    res.json({ users: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password wajib' });
    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.query('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)', [name, email, hash, role||'cashier']);
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', auth, async (req, res) => {
  try {
    const { name, email, role } = req.body;
    await db.query('UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), role=COALESCE(?,role) WHERE id=?', [name||null, email||null, role||null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: settings ──
app.get('/api/settings', auth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM settings ORDER BY id");
    const obj = {};
    for (const r of rows) obj[r.setting_key] = r.setting_value;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, String(v), String(v)]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: media upload ──
app.use('/uploads', express.static(path.join(__dirname, 'public')));
app.post('/api/media/upload', auth, async (req, res) => {
  try {
    const busboy = require('busboy');
    const bb = busboy({ headers: req.headers });
    let filePromise;
    bb.on('file', (fieldname, stream, info) => {
      const ext = path.extname(info.filename);
      const name = crypto.randomBytes(12).toString('hex') + ext;
      const filePath = path.join(__dirname, 'public', name);
      filePromise = new Promise((resolve, reject) => {
        const ws = require('fs').createWriteStream(filePath);
        stream.pipe(ws);
        ws.on('finish', () => resolve({ url: `/uploads/${name}`, filename: info.filename }));
        ws.on('error', reject);
      });
    });
    req.pipe(bb);
    const result = await filePromise;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TABLES (admin) ──
app.get('/api/tables', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tables ORDER BY number');
    res.json({ tables: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tables/:id', auth, async (req, res) => {
  try {
    const { number, capacity, status } = req.body;
    await db.query('UPDATE tables SET number=COALESCE(?,number), capacity=COALESCE(?,capacity), status=COALESCE(?,status) WHERE id=?', [number||null, capacity||null, status||null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CUSTOMER API ──
app.get('/api/menu', async (req, res) => {
  try {
    const [categories] = await db.query("SELECT id, name FROM categories WHERE is_active=1 ORDER BY name");
    const [products] = await db.query("SELECT id, name, price, description, image_url, category_id FROM products WHERE is_available=1 ORDER BY name");
    res.json({ categories, products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { items, customer_name, note, table_number } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Minimal 1 item' });
    let total = 0;
    for (const item of items) {
      const [[p]] = await db.query('SELECT price FROM products WHERE id=?', [item.product_id]);
      if (!p) return res.status(400).json({ error: `Produk ${item.product_id} tidak ditemukan` });
      total += p.price * (item.qty || 1);
    }
    const [r] = await db.query('INSERT INTO orders (items, customer_name, note, total_amount, table_number, status) VALUES (?,?,?,?,?,?)',
      [JSON.stringify(items), customer_name||'Guest', note||null, total, table_number||null, 'pending']);
    res.status(201).json({ success: true, id: r.insertId, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM orders WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order tidak ditemukan' });
    res.json({ order: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ──
async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
}
start();
