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

// ─── Mount route files (sama persis dengan cafe-backend) ───────
// Shared backend re-use route files dari template backend
// Route files di /opt/cafe-azzura/shared-backend/routes/
const routeNames = [
  'shifts', 'payments', 'orders', 'products', 'categories',
  'tables', 'users', 'dashboard', 'bookings', 'members',
  'reports', 'settings', 'ingredients', 'stock', 'expenses',
  'vouchers', 'roles', 'media', 'printers', 'stations',
  'variants', 'recipes', 'units', 'hr', 'branches',
];

const ROUTES_DIR = process.env.SHARED_ROUTES_DIR || '/opt/cafe-azzura/shared-backend/routes';

for (const name of routeNames) {
  try {
    const r = require(`${ROUTES_DIR}/${name}`);
    app.use(`/api/${name}`, r);
  } catch {
    // fallback stub jika route file belum ada
    app.get(`/api/${name}`, authenticate, (req, res) => res.json([]));
    app.post(`/api/${name}`, authenticate, (req, res) => res.json({ id: 0 }));
    app.put(`/api/${name}/:id`, authenticate, (req, res) => res.json({ success: true }));
    app.delete(`/api/${name}/:id`, authenticate, (req, res) => res.json({ success: true }));
  }
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
