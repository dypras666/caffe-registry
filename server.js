require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

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

// Get all pricing plans
app.get('/api/pricing', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM pricing_plans WHERE is_active = TRUE ORDER BY price_monthly ASC');
    res.json({ plans: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    const resetUrl = `https://${tenant.slug}.caffe.my.id/admin/reset-password?token=${token}`;

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
    const { status, pricing_tier } = req.body;
    const updates = [];
    const values = [];
    
    if (status) { updates.push('status = ?'); values.push(status); }
    if (pricing_tier) { updates.push('pricing_tier = ?'); values.push(pricing_tier); }
    
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    
    values.push(req.params.id);
    await db.query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`, values);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Superadmin - Delete tenant
app.delete('/api/superadmin/tenants/:id', superadminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM tenants WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
const settingsRouter = require('./routes/settings');
const queueRouter = require('./routes/queue');
const { startAutoScaler } = require('./services/autoscaler');
const { sendWelcome, sendForgotPassword, sendLoginInfo } = require('./services/email');

// Queue already initialized at top of file

app.use('/api/servers', serversRouter);
app.use('/api/autoscaler', autoscalerRouter);
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
    const [rows] = await db.query('SELECT slug FROM tenants WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }
    
    await restartTenant(rows[0].slug);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

function safeError(err) {
  return process.env.NODE_ENV === 'production' ? 'Terjadi kesalahan server' : err.message;
}

// ========== STATIC FILES ==========

// Serve landing page for root
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/landing.html');
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: safeError(err) });
});

// 404 handler - must be LAST
app.use((req, res) => {
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Registry running on http://0.0.0.0:${PORT}`);
});
