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

// Security
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rate limit
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api', limiter);

// Database
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
  console.log('Database connected');
}

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== PUBLIC ROUTES ==========

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', tenant: process.env.TENANT_SLUG || 'unknown' });
});

// Auth - Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    
    if (!users.length) return res.status(401).json({ error: 'Email atau password salah' });
    
    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email atau password salah' });
    
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auth - Forgot Password
app.post('/api/auth/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    
    // Always return success to prevent email enumeration
    if (!users.length) {
      return res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim' });
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query('UPDATE users SET reset_token = ?, reset_token_exp = ? WHERE email = ?', [token, expires, email]);

    // In production, send email here
    console.log(`Reset token for ${email}: ${token}`);

    res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auth - Reset Password
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token dan password wajib diisi' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter' });
    }

    const [users] = await db.query('SELECT * FROM users WHERE reset_token = ? AND reset_token_exp > NOW()', [token]);

    if (users.length === 0) {
      return res.status(400).json({ error: 'Token tidak valid atau kadaluarsa' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = ?, reset_token = NULL, reset_token_exp = NULL WHERE id = ?', [hashedPassword, users[0].id]);

    res.json({ success: true, message: 'Password berhasil direset' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auth - Verify Reset Token
app.get('/api/auth/verify-reset/:token', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM users WHERE reset_token = ? AND reset_token_exp > NOW()', [req.params.token]);

    if (rows.length === 0) {
      return res.status(400).json({ valid: false });
    }

    res.json({ valid: true, userId: rows[0].id });
  } catch (e) {
    res.status(500).json({ valid: false });
  }
});

// ========== PROTECTED ROUTES ==========

// Dashboard Stats
app.get('/api/dashboard/stats', auth, async (req, res) => {
  try {
    const [revToday] = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = 'paid' AND DATE(created_at) = CURDATE()");
    const [revMonth] = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = 'paid' AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())");
    const [ordRows] = await db.query("SELECT COUNT(*) as cnt FROM orders WHERE DATE(created_at) = CURDATE()");
    const [tblRows] = await db.query("SELECT COUNT(*) as cnt FROM tables");
    const [prdRows] = await db.query("SELECT COUNT(*) as cnt FROM products");
    const [usrRows] = await db.query("SELECT COUNT(*) as cnt FROM users WHERE role = 'customer'");
    
    res.json({
      revenue_today: revToday[0]?.total || 0,
      revenue_month: revMonth[0]?.total || 0,
      orders: ordRows[0]?.cnt || 0,
      tables: tblRows[0]?.cnt || 0,
      products: prdRows[0]?.cnt || 0,
      users: usrRows[0]?.cnt || 0,
      tier: process.env.PRICING_TIER || 'free',
      ram_mb: parseInt(process.env.RAM_MB || '64'),
      cpu_cores: parseFloat(process.env.CPU_CORES || '0.25')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Categories (public - no auth required)
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM categories WHERE is_active = 1');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Products (public - no auth required)
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.is_available = 1');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create Category (admin only)
app.post('/api/categories', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const [result] = await db.query('INSERT INTO categories (name, description) VALUES (?, ?)', [name, description]);
    res.json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create Product (admin only)
app.post('/api/products', auth, async (req, res) => {
  try {
    const { name, category_id, price, description } = req.body;
    const [result] = await db.query('INSERT INTO products (name, category_id, price, description) VALUES (?, ?, ?, ?)', [name, category_id, price, description]);
    res.json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tables
app.get('/api/tables', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tables');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Orders
app.get('/api/orders', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT o.*, t.number as table_number FROM orders o LEFT JOIN tables t ON o.table_id = t.id ORDER BY o.created_at DESC LIMIT 50');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders', auth, async (req, res) => {
  try {
    const { table_id, customer_name, items, payment_method, notes } = req.body;
    
    let total = 0;
    for (const item of items) {
      total += item.price * item.quantity;
    }
    
    const [result] = await db.query(
      'INSERT INTO orders (table_id, customer_name, total_amount, payment_method, notes, status, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [table_id, customer_name, total, payment_method || 'cash', notes, 'pending', 'unpaid']
    );
    
    for (const item of items) {
      await db.query(
        'INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?, ?)',
        [result.insertId, item.product_id, item.name, item.quantity, item.price, item.price * item.quantity]
      );
    }
    
    res.json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== STATIC FILES ==========

const publicDir = path.join(__dirname, 'public');
app.use('/admin', express.static(path.join(publicDir, 'admin')));
app.use(express.static(publicDir));

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin', 'index.html'));
});

app.get('*', (req, res) => {
  const uiIndex = path.join(publicDir, 'ui', 'index.html');
  if (require('fs').existsSync(uiIndex)) {
    res.sendFile(uiIndex);
  } else {
    res.send('Cafe Azzura - Tenant Ready');
  }
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cafe Backend running on port ${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
