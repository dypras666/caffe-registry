require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./config/database');
const jwt = require('jsonwebtoken');
const { provisionTenant, checkAvailability, restartTenant } = require('./services/provisioner');
const nodemailer = require('nodemailer');
const { superadminAuth } = require('./services/auth');
// Queue must be required early so all routes can use it
const queue = require('./services/queue');
require('./services/queue-handlers');

const app = express();

const corsWhitelist = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : [/\.caffe\.my\.id$/, /^https?:\/\/localhost(:[0-9]+)?$/];

app.use(cors({ origin: corsWhitelist, credentials: true }));
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, try again later' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });

const smtpHost = process.env.SMTP_HOST;
const smtpPort = parseInt(process.env.SMTP_PORT) || 465;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

// Email transporter
const transporter = smtpUser ? nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: { user: smtpUser, pass: smtpPass },
}) : null;

// ========== PRICING PLANS ==========

// GET /api/pricing — public, returns all active plans
app.get('/api/pricing', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM pricing_plans ORDER BY price_monthly ASC');
    res.json({ plans: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/pricing/:tier — superadmin update plan
app.put('/api/pricing/:tier', superadminAuth, async (req, res) => {
  try {
    const { name, price_monthly, ram_mb, cpu_cores, disk_mb, features, is_active } = req.body;
    const allowed = { name, price_monthly, ram_mb, cpu_cores, disk_mb, features, is_active };
    const updates = [], values = [];
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) { updates.push(`${k}=?`); values.push(v); }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields' });
    values.push(req.params.tier);
    await db.query(`UPDATE pricing_plans SET ${updates.join(',')} WHERE tier=?`, values);
    const [[plan]] = await db.query('SELECT * FROM pricing_plans WHERE tier=?', [req.params.tier]);
    res.json({ plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upgrade tenant tier
app.post('/api/tenant/:id/upgrade', async (req, res) => {
  try {
    const { tier } = req.body;
    const [plans] = await db.query('SELECT * FROM pricing_plans WHERE tier = ? AND is_active = TRUE', [tier]);
    
    if (plans.length === 0) {
      return res.status(400).json({ error: 'Plan tidak ditemukan' });
    }
    
    const plan = plans[0];
    const [tenants] = await db.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }

    // Update tenant tier
    await db.query(
      'UPDATE tenants SET pricing_tier = ?, ram_mb = ?, cpu_cores = ?, disk_mb = ? WHERE id = ?',
      [tier, plan.ram_mb, plan.cpu_cores, plan.disk_mb, req.params.id]
    );

    res.json({ success: true, message: `Berhasil upgrade ke ${plan.name}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const JWT_SECRET = () => process.env.JWT_SECRET;

const tenantAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    if (decoded.role !== 'owner' && decoded.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    req.tenantUser = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== TENANT STATS ==========

// Get tenant statistics (for dashboard)
app.get('/api/tenant/:id/stats', tenantAuth, async (req, res) => {
  try {
    const [tenants] = await db.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }
    
    const tenant = tenants[0];
    
    // Connect to tenant DB to get stats
    const mysql = require('mysql2/promise');
    const tenantConn = await mysql.createConnection({
      host: '127.0.0.1',
      user: tenant.db_name.replace('cafe_', 'cafe_').substring(0, 16),
      password: process.env.TENANT_DB_PASS || tenant.admin_password,
      database: tenant.db_name
    });

    // Get table counts
    let stats = {
      tables: 0,
      orders: 0,
      products: 0,
      users: 0,
      revenue_today: 0,
      revenue_month: 0
    };

    try {
      const [tables] = await tenantConn.query("SHOW TABLES");
      stats.tables = tables.length;

      // Check if orders table exists and get counts
      const tableNames = tables.map(t => Object.values(t)[0]);
      
      if (tableNames.includes('orders')) {
        const [orderCount] = await tenantConn.query('SELECT COUNT(*) as count FROM orders');
        stats.orders = orderCount[0].count;
        
        const [todayRevenue] = await tenantConn.query(
          "SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE DATE(created_at) = CURDATE() AND status != 'cancelled'"
        );
        stats.revenue_today = todayRevenue[0].sum;
        
        const [monthRevenue] = await tenantConn.query(
          "SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE()) AND status != 'cancelled'"
        );
        stats.revenue_month = monthRevenue[0].sum;
      }
      
      if (tableNames.includes('products')) {
        const [productCount] = await tenantConn.query('SELECT COUNT(*) as count FROM products');
        stats.products = productCount[0].count;
      }
      
      if (tableNames.includes('users')) {
        const [userCount] = await tenantConn.query('SELECT COUNT(*) as count FROM users');
        stats.users = userCount[0].count;
      }
    } catch (e) {
      // Tables might not exist yet
    }

    await tenantConn.end();
    
    res.json({
      ...stats,
      tier: tenant.pricing_tier,
      ram_mb: tenant.ram_mb,
      cpu_cores: tenant.cpu_cores,
      disk_mb: tenant.disk_mb
    });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// ========== AUTH & PASSWORD RESET ==========

// Forgot password
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    const [tenants] = await db.query('SELECT * FROM tenants WHERE admin_email = ?', [email]);
    if (tenants.length === 0) {
      // Don't reveal if email exists
      return res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim' });
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      'UPDATE tenants SET reset_token = ?, reset_token_exp = ? WHERE admin_email = ?',
      [token, expires, email]
    );

    // Send email
    const tenant = tenants[0];
    const siteUrl = process.env.SITE_URL || 'https://caffe.my.id';
    const resetUrl = `${siteUrl}/reset-password?token=${token}`;

    queue.enqueue('email.forgot_password', {
      to: email,
      name: tenant.name || tenant.slug,
      resetUrl,
    }).catch(console.error);

    res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim' });
  }
});

// Reset password with token
app.post('/api/auth/reset', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token dan password wajib diisi' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter' });
    }

    const [tenants] = await db.query(
      'SELECT * FROM tenants WHERE reset_token = ? AND reset_token_exp > NOW()',
      [token]
    );

    if (tenants.length === 0) {
      return res.status(400).json({ error: 'Token tidak valid atau kadaluarsa' });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      'UPDATE tenants SET admin_password = ?, reset_token = NULL, reset_token_exp = NULL WHERE id = ?',
      [hashedPassword, tenants[0].id]
    );

    res.json({ success: true, message: 'Password berhasil direset' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify reset token
app.get('/api/auth/verify-reset/:token', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, slug FROM tenants WHERE reset_token = ? AND reset_token_exp > NOW()',
      [req.params.token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ valid: false });
    }

    res.json({ valid: true, tenantId: rows[0].id, slug: rows[0].slug });
  } catch (error) {
    res.status(500).json({ valid: false });
  }
});

// ========== SUPERADMIN AUTH ==========

// Superadmin Login
app.post('/api/superadmin/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const [admins] = await db.query('SELECT * FROM superadmins WHERE email = ? AND is_active = 1', [email]);
    
    if (!admins.length) return res.status(401).json({ error: 'Email atau password salah' });
    
    const bcrypt = require('bcryptjs');
    const admin = admins[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Email atau password salah' });
    
    const token = jwt.sign({ id: admin.id, email: admin.email, role: 'superadmin' }, JWT_SECRET(), { expiresIn: '7d' });
    
    res.json({ token, user: { id: admin.id, email: admin.email, name: admin.name, role: 'superadmin' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Superadmin middleware (imported from services/auth)

// Superadmin - Get all tenants
app.get('/api/superadmin/tenants', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.json({ tenants: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Superadmin - Get tenant details
app.get('/api/superadmin/tenants/:id', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Superadmin - Update tenant
app.put('/api/superadmin/tenants/:id', superadminAuth, async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'status', 'pricing_tier', 'admin_email', 'balance', 'auto_suspend'];
    const updates = [], values = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    await db.query(`UPDATE tenants SET ${updates.join(', ')}, updated_at=NOW() WHERE id = ?`, values);
    const [[updated]] = await db.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    res.json({ success: true, tenant: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Superadmin - Delete tenant (blocked if active)
app.delete('/api/superadmin/tenants/:id', superadminAuth, async (req, res) => {
  try {
    const [[tenant]] = await db.query('SELECT id, slug, status FROM tenants WHERE id = ?', [req.params.id]);
    if (!tenant) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    if (tenant.status === 'active') {
      return res.status(400).json({ error: 'Tidak bisa hapus tenant yang masih aktif. Suspend atau nonaktifkan dulu.' });
    }
    await db.query('DELETE FROM tenants WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: `Tenant ${tenant.slug} dihapus` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Superadmin - Reprovision tenant
app.post('/api/superadmin/tenants/:id/reprovision', superadminAuth, async (req, res) => {
  try {
    const [[tenant]] = await db.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (!tenant) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    const bcrypt = require('bcryptjs');
    const newPassword = crypto.randomBytes(4).toString('hex');
    // Stop existing process
    try {
      const { stopTenant } = require('./services/provisioner');
      await stopTenant(tenant.slug);
    } catch (_) {}
    await db.query("UPDATE tenants SET status='provisioning', admin_password=?, container_status='provisioning' WHERE id=?", [
      await bcrypt.hash(newPassword, 10), req.params.id
    ]);
    const { provisionTenant } = require('./services/provisioner');
    provisionTenant(tenant.id, tenant.slug, tenant.admin_email, newPassword)
      .then(() => console.log(`[${tenant.slug}] Reprovision success`))
      .catch(e => console.error(`[${tenant.slug}] Reprovision failed:`, e.message));
    res.json({ success: true, message: 'Reprovisioning dimulai (3-5 menit)', new_password: newPassword });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Get tenant logs
app.get('/api/superadmin/tenants/:id/logs', superadminAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    const { getTenantLogs } = require('./services/provisioner');
    const lines = parseInt(req.query.lines) || 100;
    const logs = await getTenantLogs(t.slug, lines);
    res.json({ logs });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Statistics
app.get('/api/superadmin/stats', superadminAuth, async (req, res) => {
  try {
    const [total] = await db.query('SELECT COUNT(*) as count FROM tenants');
    const [active] = await db.query("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'");
    const [byTier] = await db.query('SELECT pricing_tier, COUNT(*) as count FROM tenants GROUP BY pricing_tier');
    const [revenue] = await db.query("SELECT SUM(p.price_monthly) as total FROM pricing_plans p JOIN tenants t ON t.pricing_tier = p.tier WHERE t.status = 'active'");
    
    res.json({
      totalTenants: total[0].count,
      activeTenants: active[0].count,
      monthlyRevenue: revenue[0].total || 0,
      byTier: byTier.reduce((acc, row) => { acc[row.pricing_tier] = row.count; return acc; }, {})
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== TENANT AUTH (proxy to tenant backend) ==========

// Login (proxied)
// Alias: POST /api/auth/login (for frontend compatibility)
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib' });

    const [tenants] = await db.query(
      "SELECT * FROM tenants WHERE admin_email = ? AND status != 'inactive'",
      [email]
    );
    if (!tenants.length) return res.status(401).json({ error: 'Email atau password salah' });

    const bcrypt = require('bcryptjs');
    const tenant = tenants[0];
    if (!await bcrypt.compare(password, tenant.admin_password)) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }

    const token = jwt.sign(
      { tenantId: tenant.id, slug: tenant.slug, role: 'owner', email: tenant.admin_email, pricing_tier: tenant.pricing_tier },
      JWT_SECRET(), { expiresIn: '7d' }
    );
    res.json({ token, user: { id: tenant.id, email: tenant.admin_email, role: 'owner', slug: tenant.slug, pricing_tier: tenant.pricing_tier } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenant/:slug/login', authLimiter, async (req, res) => {
  try {
    const { slug } = req.params;
    const { email, password } = req.body;

    // Verify tenant exists and is active
    const [tenants] = await db.query('SELECT * FROM tenants WHERE slug = ? AND status = "active"', [slug]);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }

    // Simple password check (for demo - in production, proxy to tenant backend)
    const bcrypt = require('bcryptjs');
    const tenant = tenants[0];

    if (email === tenant.admin_email && await bcrypt.compare(password, tenant.admin_password)) {
      const token = jwt.sign(
        { tenantId: tenant.id, role: 'owner' },
        JWT_SECRET(),
        { expiresIn: '7d' }
      );
      return res.json({ token, user: { email: tenant.admin_email, role: 'owner' } });
    }

    res.status(401).json({ error: 'Email atau password salah' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== AUTO-SCALING ROUTES ==========
const serversRouter = require('./routes/servers');
const autoscalerRouter = require('./routes/autoscaler');
const billingRouter = require('./routes/billing');
const paymentRouter = require('./routes/payment');
const topupRouter = require('./routes/topup');
const settingsRouter = require('./routes/settings');
const queueRouter = require('./routes/queue');
const { startAutoScaler } = require('./services/autoscaler');
const { sendWelcome, sendForgotPassword, sendLoginInfo } = require('./services/email');

// Queue already initialized at top of file

app.use('/api/servers', serversRouter);
app.use('/api/autoscaler', autoscalerRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/topup', topupRouter);
app.use('/api/billing', billingRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/queue', queueRouter);

startAutoScaler();

// Start DB-backed queue worker (replaces billing scheduler)
(async () => {
  try {
    await queue.ensureTable();
    await queue.scheduleRecurring();
    queue.startWorker({ intervalMs: 10_000, batchSize: 10 });
    console.log('[Queue] Worker started');
  } catch (e) {
    console.error('[Queue] Init error:', e.message);
  }
})();

// ========== LEGACY ROUTES ==========

// Check slug availability
app.get('/api/check/:slug', async (req, res) => {
  try {
    const result = await checkAvailability(req.params.slug);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Register new tenant
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { name, slug, email, password, phone } = req.body;
    
    // Validation
    if (!name || !slug || !email || !password) {
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug hanya huruf kecil, angka, dan strip' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter' });
    }
    
    // Check availability
    const avail = await checkAvailability(slug);
    if (!avail.available) {
      return res.status(400).json({ error: avail.error || 'Slug sudah digunakan' });
    }
    
    // Get free tier defaults
    const [plans] = await db.query("SELECT * FROM pricing_plans WHERE tier = 'free'");
    const freePlan = plans[0];

    // Create tenant record
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const tenantId = await db.query(
      'INSERT INTO tenants (name, slug, email, phone, status, pricing_tier, ram_mb, cpu_cores, disk_mb, admin_email, admin_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, slug, email, phone || null, 'provisioning', 'free', freePlan.ram_mb, freePlan.cpu_cores, freePlan.disk_mb, email, hashedPassword]
    ).then(r => r[0].insertId);
    
    // Trigger provisioning asynchronously
    provisionTenant(tenantId, slug, email, password).catch(console.error);

    // Send welcome email
    const adminUrl = `https://office-${slug}.caffe.my.id/admin`;
    queue.enqueue('email.welcome', {
      to: email,
      name,
      adminUrl,
      email,
      password,
      plan: freePlan.name,
    }).catch(console.error);
    
    res.json({
      success: true,
      tenantId,
      slug,
      message: 'Tenant sedang diproses. Ini membutuhkan waktu 3-5 menit.'
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
});

// Get tenant status
app.get('/api/tenant/:id/status', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, slug, status, pricing_tier, admin_url, admin_email, ram_mb, cpu_cores, disk_mb, created_at FROM tenants WHERE id = ?',
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Restart tenant
app.post('/api/tenant/:id/restart', tenantAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    await restartTenant(t.slug);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop tenant
app.post('/api/tenant/:id/stop', tenantAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    const { stopTenant } = require('./services/provisioner');
    await stopTenant(t.slug);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tenant logs
app.get('/api/tenant/:id/logs', tenantAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    const { getTenantLogs } = require('./services/provisioner');
    const lines = parseInt(req.query.lines) || 100;
    const logs = await getTenantLogs(t.slug, lines);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Tickets ─────────────────────────────────────────────────
// GET /api/tickets — list tenant's tickets
app.get('/api/tickets', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const [rows] = await db.query(
      'SELECT * FROM support_tickets WHERE tenant_id=? ORDER BY created_at DESC',
      [tenantId]
    );
    res.json({ tickets: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tickets — create ticket
app.post('/api/tickets', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const { subject, message, priority = 'normal' } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'subject dan message wajib' });
    const [r] = await db.query(
      "INSERT INTO support_tickets (tenant_id, subject, message, priority, status) VALUES (?,?,?,?,'open')",
      [tenantId, subject, message, priority]
    );
    const [[ticket]] = await db.query('SELECT * FROM support_tickets WHERE id=?', [r.insertId]);
    res.status(201).json({ ticket });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tickets/:id — get ticket + replies
app.get('/api/tickets/:id', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const [[ticket]] = await db.query(
      'SELECT * FROM support_tickets WHERE id=? AND tenant_id=?', [req.params.id, tenantId]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket tidak ditemukan' });
    const [replies] = await db.query(
      'SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at ASC', [req.params.id]
    );
    res.json({ ticket, replies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tickets/:id/reply — tenant reply
app.post('/api/tickets/:id/reply', tenantAuth, async (req, res) => {
  try {
    const tenantId = req.tenantUser.tenantId;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message wajib' });
    const [[ticket]] = await db.query(
      'SELECT * FROM support_tickets WHERE id=? AND tenant_id=?', [req.params.id, tenantId]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket tidak ditemukan' });
    await db.query(
      "INSERT INTO ticket_replies (ticket_id, sender, message) VALUES (?,?,?)",
      [req.params.id, 'tenant', message]
    );
    await db.query("UPDATE support_tickets SET updated_at=NOW() WHERE id=?", [req.params.id]);
    res.status(201).json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/tickets/:id/reply — admin reply
app.post('/api/superadmin/tickets/:id/reply', superadminAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message wajib' });
    await db.query(
      "INSERT INTO ticket_replies (ticket_id, sender, message) VALUES (?,?,?)",
      [req.params.id, 'admin', message]
    );
    await db.query("UPDATE support_tickets SET status='replied', updated_at=NOW() WHERE id=?", [req.params.id]);
    res.status(201).json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/superadmin/tickets — all tickets
app.get('/api/superadmin/tickets', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT st.*, t.name AS tenant_name, t.slug
       FROM support_tickets st LEFT JOIN tenants t ON t.id=st.tenant_id
       ORDER BY st.created_at DESC LIMIT 100`
    );
    res.json({ tickets: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/superadmin/tickets/:id — single ticket + replies (superadmin sees all)
app.get('/api/superadmin/tickets/:id', superadminAuth, async (req, res) => {
  try {
    const [[ticket]] = await db.query(
      `SELECT st.*, t.name AS tenant_name, t.slug
       FROM support_tickets st LEFT JOIN tenants t ON t.id=st.tenant_id
       WHERE st.id=?`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket tidak ditemukan' });
    const [replies] = await db.query(
      'SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ ticket, replies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/superadmin/tickets/:id/status — update ticket status
app.put('/api/superadmin/tickets/:id/status', superadminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['open', 'replied', 'resolved', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
    await db.query(
      'UPDATE support_tickets SET status=?, updated_at=NOW() WHERE id=?',
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tenant count
app.get('/api/stats', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'");
    const [revenue] = await db.query("SELECT SUM(price_monthly) as total FROM pricing_plans p JOIN tenants t ON t.pricing_tier = p.tier WHERE t.status = 'active'");
    res.json({ 
      activeTenants: rows[0].count,
      monthlyRevenue: revenue[0].total || 0
    });
  } catch (error) {
    res.json({ activeTenants: 0, monthlyRevenue: 0 });
  }
});

// ─── QRIS Image Upload (base64) ──────────────────────────────
// ─── Generic media upload (S3) ────────────────────────────────
const { uploadBase64, uploadFile: storageUpload } = require('./services/storage');

// POST /api/media/upload — base64 image → S3, returns URL
// Body: { image: "data:image/...;base64,...", namespace?: "qris"|"logo"|"favicon"|"ticket", filename?: "custom.png" }
app.post('/api/media/upload', superadminAuth, async (req, res) => {
  try {
    const { image, namespace = 'uploads', filename: customName, setting_key } = req.body;
    if (!image) return res.status(400).json({ error: 'image wajib (base64 data URI)' });

    const matches = image.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Format tidak valid — gunakan data URI base64' });

    const [, mime, b64] = matches;
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Maksimal 5MB' });

    const ext = mime.split('/')[1]?.replace('jpeg','jpg') || 'bin';
    const fname = customName || `${namespace}-${Date.now()}.${ext}`;
    const result = await storageUpload(namespace, fname, buffer, mime);

    // Optionally save to settings
    if (setting_key) {
      await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
        [setting_key, result.url, result.url]
      );
    }

    res.json({ success: true, url: result.url, key: result.key, driver: result.driver });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// POST /api/media/upload-qris — backward compat, forwards to /api/media/upload
app.post('/api/media/upload-qris', superadminAuth, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Data gambar diperlukan' });
    const result = await storageUpload('qris', `qris-${Date.now()}.jpg`, Buffer.from(image.split(',')[1] || image, 'base64'), 'image/jpeg');
    await db.query(
      "INSERT INTO system_settings (setting_key, setting_value) VALUES ('payment_qris_image', ?) ON DUPLICATE KEY UPDATE setting_value=?",
      [result.url, result.url]
    );
    res.json({ success: true, url: result.url });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// ─── Payment Gateway Tests ───────────────────────────────────
async function getSettings(prefix) {
  const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE ?", [prefix + '%']);
  const cfg = {};
  for (const r of rows) cfg[r.setting_key] = r.setting_value;
  return cfg;
}

// POST /api/payment/test/midtrans — test connection & create dummy transaction
app.post('/api/payment/test/midtrans', superadminAuth, async (req, res) => {
  try {
    const cfg = await getSettings('payment_midtrans_');
    if (!cfg.payment_midtrans_server_key) return res.status(400).json({ error: 'Server Key Midtrans belum dikonfigurasi' });
    const isProd = cfg.payment_midtrans_is_production === '1';
    const baseUrl = isProd ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com';
    const auth = Buffer.from(cfg.payment_midtrans_server_key + ':').toString('base64');
    const orderId = 'TEST-' + Date.now();
    const snapBody = {
      transaction_details: { order_id: orderId, gross_amount: 10000 },
      credit_card: { secure: true },
      customer_details: { first_name: 'Test', email: 'test@caffe.my.id' },
    };
    const snapRes = await fetch(baseUrl + '/snap/v1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth },
      body: JSON.stringify(snapBody),
    });
    const snapResult = await snapRes.json();
    res.json({
      success: snapRes.ok,
      order_id: orderId,
      amount: 10000,
      message: snapRes.ok ? 'Transaksi test berhasil dibuat' : (snapResult.error_message || 'Gagal'),
      transaction: snapResult,
      payment_url: snapResult.redirect_url || null,
      token: snapResult.token || null,
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// POST /api/payment/test/tripay — test connection & create dummy transaction
app.post('/api/payment/test/tripay', superadminAuth, async (req, res) => {
  try {
    const cfg = await getSettings('payment_tripay_');
    if (!cfg.payment_tripay_api_key || !cfg.payment_tripay_merchant_code) {
      return res.status(400).json({ error: 'Konfigurasi Tripay belum lengkap (API Key & Merchant Code)' });
    }
    const isProd = cfg.payment_tripay_is_production === '1';
    const baseUrl = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';
    // 1. Test connection: get payment channels
    const channelRes = await fetch(baseUrl + '/merchant/payment-channel', {
      headers: { 'Authorization': 'Bearer ' + cfg.payment_tripay_api_key },
    });
    const channels = await channelRes.json();
    if (!channelRes.ok) {
      return res.json({ success: false, message: channels.message || 'Gagal terkoneksi ke Tripay', detail: channels });
    }
    // 2. Create dummy transaction if private key exists
    let transaction = null;
    if (cfg.payment_tripay_private_key) {
      const timestamp = Math.floor(Date.now() / 1000);
      const merchantRef = 'TEST-' + Date.now();
      const signature = crypto.createHmac('sha256', cfg.payment_tripay_private_key)
        .update(merchantRef + 10000 + 'TEST')
        .digest('hex');
      const txRes = await fetch(baseUrl + '/transaction/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.payment_tripay_api_key },
        body: JSON.stringify({
          method: 'BRIVA',
          merchant_ref: merchantRef,
          amount: 10000,
          customer_name: 'Test User',
          customer_email: 'test@caffe.my.id',
          order_items: [{ sku: 'TEST', name: 'Test Payment', price: 10000, quantity: 1 }],
          signature,
          return_url: 'https://caffe.my.id',
        }),
      });
      transaction = await txRes.json();
    }
    res.json({
      success: true,
      message: 'Koneksi ke Tripay berhasil',
      channels: channels.data || [],
      transaction,
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// POST /api/payment/test/callback — simulate test callback from gateway
app.post('/api/payment/test/callback', superadminAuth, async (req, res) => {
  try {
    const { gateway, payload } = req.body;
    res.json({
      success: true,
      message: `Callback ${gateway} diterima (simulasi)`,
      received: { gateway, payload },
      processed: {
        status: 'pending',
        note: 'Callback handler belum terintegrasi penuh — data tersimpan di log.',
      },
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

function safeError(err) {
  return process.env.NODE_ENV === 'production' ? 'Terjadi kesalahan server' : err.message;
}

// ========== STATIC FILES ==========
// Serve cafe-saas React SPA (built to public/)
app.use(express.static(__dirname + '/public'));

// SPA catch-all — serve index.html for all non-API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const idx = __dirname + '/public/index.html';
  const fs = require('fs');
  if (fs.existsSync(idx)) {
    res.sendFile(idx);
  } else {
    res.status(404).send('Frontend not built. Run: cd cafe-saas && npm run build');
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: safeError(err) });
});

// 404 for unknown API routes
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  // SPA fallback already handled above
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Registry running on http://0.0.0.0:${PORT}`);
});
