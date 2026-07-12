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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://static.cloudflareinsights.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://fonts.googleapis.com'],
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://akas.is3.cloudhost.id',
        'https://*.is3.cloudhost.id',
        'https://*.cloudhost.id',
        'https://resend.com',
        ...(process.env.APP_DOMAIN ? [`https://*.${process.env.APP_DOMAIN}`] : []),
      ],
      connectSrc: ["'self'", ...(process.env.APP_DOMAIN ? [`https://*.${process.env.APP_DOMAIN}`] : [])],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
}));
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

// GET /api/tenant/me — current tenant profile from token
app.get('/api/tenant/me', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, slug, email, status, container_status, pricing_tier, admin_url, admin_email, ram_mb, cpu_cores, disk_mb, custom_domain, balance, created_at FROM tenants WHERE id = ?',
      [req.tenantUser.tenantId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/tenant/me — update current tenant profile
app.put('/api/tenant/me', tenantAuth, async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'custom_domain'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields' });
    await db.query('UPDATE tenants SET ? WHERE id = ?', [updates, req.tenantUser.tenantId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== TENANT STATS ==========

// Get tenant statistics (for dashboard)
app.get('/api/tenant/:id/stats', tenantAuth, async (req, res) => {
  try {
    const [tenants] = await db.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }

    const tenant = tenants[0];

    const stats = { tables: 0, orders: 0, products: 0, users: 0, revenue_today: 0, revenue_month: 0 };

    let tenantConn;
    try {
      const mysql = require('mysql2/promise');
      tenantConn = await mysql.createConnection({
        host: '127.0.0.1',
        user: (tenant.db_name || '').replace('cafe_', 'cafe_').substring(0, 16),
        password: process.env.TENANT_DB_PASS || tenant.db_pass || '',
        database: tenant.db_name,
        connectTimeout: 3000,
      });
    } catch (_) {
      return res.json({ stats: { ...stats, error: 'DB not available' } });
    }

    try {
      const [tables] = await tenantConn.query("SHOW TABLES");
      stats.tables = tables.length;
      const tableNames = tables.map(t => Object.values(t)[0]);

      if (tableNames.includes('orders')) {
        const [orderCount] = await tenantConn.query('SELECT COUNT(*) as count FROM orders');
        stats.orders = orderCount[0].count;
        const [todayRevenue] = await tenantConn.query("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE DATE(created_at) = CURDATE() AND status != 'cancelled'");
        stats.revenue_today = todayRevenue[0].sum;
        const [monthRevenue] = await tenantConn.query("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE()) AND status != 'cancelled'");
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
    } catch (_) {}

    if (tenantConn) await tenantConn.end();

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
    const siteUrl = process.env.SITE_URL || `https://${process.env.APP_DOMAIN || 'caffe.id'}`;
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
    const allowed = ['name', 'email', 'phone', 'status', 'pricing_tier', 'admin_email', 'admin_password', 'balance', 'auto_suspend', 'custom_domain', 'container_status'];
    const updates = [], values = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        if (field === 'admin_password') {
          updates.push(`${field} = ?`);
          values.push(require('bcryptjs').hashSync(req.body[field], 10));
        } else {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
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

// Superadmin - Redeploy with health check loop
app.post('/api/superadmin/tenants/:id/redeploy', superadminAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT id, slug, backend_port, server_id, container_id FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });

    // Restart — allow failure (process may not exist yet)
    try { await restartTenant(t.slug); } catch (_) {}

    // Health check loop — poll up to 30s
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (t.container_id) {
          // Docker mode
          const [serverRows] = await db.query('SELECT ip_address, ssh_user, ssh_password FROM servers WHERE id = ?', [t.server_id]);
          if (serverRows.length) {
            const s = serverRows[0];
            const { execSync } = require('child_process');
            const prefix = s.ssh_password
              ? `sshpass -p '${s.ssh_password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@${s.ip_address}`
              : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@${s.ip_address}`;
            const out = execSync(`${prefix} "docker inspect -f '{{.State.Status}}' ${t.container_id} 2>/dev/null || echo 'missing'"`, { encoding: 'utf8', timeout: 5000 }).trim();
            if (out === 'running') { healthy = true; break; }
          } else break;
        } else {
          // Non-docker — check port
          const http = require('http');
          await new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${t.backend_port}/api/settings/public`, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                if (response.statusCode === 200) healthy = true;
                resolve();
              });
            });
            req.on('error', () => resolve());
            req.setTimeout(2000, () => { req.destroy(); resolve(); });
          });
          if (healthy) break;
        }
      } catch { continue; }
    }

    // Update container_status
    await db.query('UPDATE tenants SET container_status = ? WHERE id = ?', [healthy ? 'running' : 'failed', req.params.id]);

    res.json({ success: true, healthy, container_status: healthy ? 'running' : 'failed' });
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

// Superadmin - Get tenant env vars
app.get('/api/superadmin/tenants/:id/env', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, var_key, var_value, is_secret FROM tenant_env_vars WHERE tenant_id = ? ORDER BY var_key', [req.params.id]);
    res.json({ vars: rows });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Save tenant env vars (replace all)
app.put('/api/superadmin/tenants/:id/env', superadminAuth, async (req, res) => {
  try {
    const { vars } = req.body;
    if (!Array.isArray(vars)) return res.status(400).json({ error: 'vars harus array' });
    await db.query('DELETE FROM tenant_env_vars WHERE tenant_id = ?', [req.params.id]);
    for (const v of vars) {
      if (!v.key) continue;
      await db.query(
        'INSERT INTO tenant_env_vars (tenant_id, var_key, var_value, is_secret) VALUES (?, ?, ?, ?)',
        [req.params.id, v.key, v.value ?? '', v.is_secret ? 1 : 0]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Get tenant container info (DB, network, ports, container status)
app.get('/api/superadmin/tenants/:id/container', superadminAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT id, slug, backend_port, ui_port, admin_port FROM tenants WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant not found' });
    const execSync = require('child_process').execSync;
    const net = `tenant-${t.slug}`;
    const netExist = execSync(`docker network ls --filter name=${net} --format {{.Name}}`, { encoding:'utf8', timeout:5000 }).trim();
    const [netRow] = await db.query('SELECT * FROM tenant_networks WHERE tenant_id=?', [t.id]);
    const containers = {};
    for (const name of [`${t.slug}-backend`, `${t.slug}-ui`, `${t.slug}-admin`, `${t.slug}-db`]) {
      try {
        const raw = execSync(`docker inspect ${name} --format '{{json .State}}' 2>/dev/null || echo "null"`, { encoding:'utf8', timeout:5000 }).trim();
        const state = JSON.parse(raw);
        containers[name.replace(t.slug+'-','')] = state && state.Status ? {
          status: state.Status, running: state.Running, startedAt: state.StartedAt, exitCode: state.ExitCode,
        } : null;
      } catch { containers[name.replace(t.slug+'-','')] = null; }
    }
    res.json({
      slug: t.slug, network: netExist || null,
      ports: { backend: t.backend_port, ui: t.ui_port, admin: t.admin_port },
      db: netRow ? { container: netRow.db_container_id, port: netRow.db_port, db_name: `cafe_${t.slug.replace(/-/g, '_')}` } : null,
      containers,
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Execute command in container
app.post('/api/superadmin/tenants/:id/container/exec', superadminAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug FROM tenants WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant not found' });
    const { container, command } = req.body;
    if (!container || !command) return res.status(400).json({ error: 'container dan command wajib' });
    const allowed = ['backend', 'ui', 'admin', 'db'];
    if (!allowed.includes(container)) return res.status(400).json({ error: `Container must be one of: ${allowed.join(', ')}` });
    const cName = container === 'db' ? `${t.slug}-db` : `${t.slug}-${container}`;
    const output = require('child_process').execSync(
      `docker exec -i ${cName} sh -c '${command.replace(/'/g, "'\\''")}' 2>&1`,
      { encoding:'utf8', timeout:15000 }
    ).trim();
    res.json({ output, container: cName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Superadmin - Get tenant DB info (credentials, connection string)
app.get('/api/superadmin/tenants/:id/db-info', superadminAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug, db_name, db_user, db_pass FROM tenants WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant not found' });
    const [netRow] = await db.query('SELECT * FROM tenant_networks WHERE tenant_id=?', [req.params.id]);
    res.json({
      slug: t.slug, database: t.db_name, user: t.db_user, password: t.db_pass,
      db_container: netRow?.db_container_id || null,
      root_password: netRow?.db_root_password || null,
      connection_string: `mysql -u ${t.db_user} -p'${t.db_pass}' -h ${netRow?.db_container_id || '???'} -P 3306 ${t.db_name}`,
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Domain info (default subdomains + DNS check)
app.get('/api/superadmin/tenants/:id/domain', superadminAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug, custom_domain FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    const dns = require('dns');
    const appDomain = process.env.APP_DOMAIN || 'caffe.id';
    const defaultDomains = {
      customer: `https://${t.slug}.${appDomain}`,
      admin: `https://office-${t.slug}.${appDomain}`,
    };
    // DNS check helper
    const checkDNS = (domain) => new Promise(resolve => {
      dns.resolveCname(domain.replace('https://',''), (err, cnames) => {
        if (!err && cnames.length) return resolve({ resolved: true, type: 'CNAME', target: cnames[0] });
        dns.resolve4(domain.replace('https://',''), (err2, addrs) => {
          if (!err2 && addrs.length) return resolve({ resolved: true, type: 'A', target: addrs[0] });
          resolve({ resolved: false, type: null, target: null });
        });
      });
    });
    const checks = {
      customer: await checkDNS(defaultDomains.customer),
      admin: await checkDNS(defaultDomains.admin),
    };
    if (t.custom_domain) {
      checks.custom = await checkDNS(t.custom_domain);
    }
    res.json({
      slug: t.slug,
      appDomain,
      defaultDomains,
      customDomain: t.custom_domain || null,
      dns: checks,
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Superadmin - Set custom domain
app.put('/api/superadmin/tenants/:id/domain', superadminAuth, async (req, res) => {
  try {
    const { custom_domain } = req.body;
    if (custom_domain && typeof custom_domain === 'string') {
      await db.query('UPDATE tenants SET custom_domain = ? WHERE id = ?', [custom_domain.trim(), req.params.id]);
    } else {
      await db.query('UPDATE tenants SET custom_domain = NULL WHERE id = ?', [req.params.id]);
    }
    res.json({ success: true, custom_domain: custom_domain?.trim() || null });
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
const bcaRouter = require('./routes/bca');
const settingsRouter = require('./routes/settings');
const queueRouter = require('./routes/queue');
const backupRouter = require('./routes/backup');
const addonsRouter = require('./routes/addons');
const { startAutoScaler } = require('./services/autoscaler');
const { sendWelcome, sendForgotPassword, sendLoginInfo } = require('./services/email');

// Queue already initialized at top of file

app.use('/api/servers', serversRouter);
app.use('/api/autoscaler', autoscalerRouter);
app.use('/api/bca', bcaRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/topup', topupRouter);
app.use('/api/billing', billingRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/queue', queueRouter);
app.use('/api/backup', backupRouter);
app.use('/api/addons', addonsRouter);

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
    const adminUrl = `https://office-${slug}.${process.env.APP_DOMAIN || 'caffe.id'}/admin`;
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
      message: 'Tenant sedang diproses. Ini membutuhkan waktu 3-5 menit.',
      warning: 'Subdomain tidak bisa diubah setelah registrasi. Pastikan slug sudah benar.',
      note: 'Nama cafe akan sesuai dengan nama yang didaftarkan.'
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
      'SELECT id, name, slug, status, container_status, pricing_tier, admin_url, admin_email, ram_mb, cpu_cores, disk_mb, custom_domain, created_at FROM tenants WHERE id = ?',
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

// Custom domain
app.put('/api/tenant/:id/domain', tenantAuth, async (req, res) => {
  try {
    const { custom_domain } = req.body;
    if (!custom_domain || typeof custom_domain !== 'string') {
      return res.status(400).json({ error: 'custom_domain required' });
    }
    await db.query('UPDATE tenants SET custom_domain = ? WHERE id = ?', [custom_domain.trim(), req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset container password
app.post('/api/tenant/:id/reset-password', tenantAuth, async (req, res) => {
  try {
    const [[t]] = await db.query('SELECT slug FROM tenants WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    const crypto = require('crypto');
    const newPassword = crypto.randomBytes(12).toString('hex');
    await db.query('UPDATE tenants SET container_password = ? WHERE id = ?', [newPassword, req.params.id]);
    // TODO: actual container password update via provisioner
    res.json({ success: true, new_password: newPassword });
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
      customer_details: { first_name: 'Test', email: 'test@example.com' },
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
          customer_email: 'test@example.com',
          order_items: [{ sku: 'TEST', name: 'Test Payment', price: 10000, quantity: 1 }],
          signature,
          return_url: process.env.SITE_URL || `https://${process.env.APP_DOMAIN || 'caffe.id'}`,
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

// POST /api/payment/test/duitku — test connection & create dummy transaction
app.post('/api/payment/test/duitku', superadminAuth, async (req, res) => {
  try {
    const cfg = await getSettings('payment_duitku_');
    if (!cfg.payment_duitku_api_key || !cfg.payment_duitku_merchant_code) {
      return res.status(400).json({ error: 'Konfigurasi Duitku belum lengkap (Merchant Code & API Key)' });
    }
    const isProd = cfg.payment_duitku_is_production === '1';
    const baseUrl = isProd ? 'https://passport.duitku.com' : 'https://sandbox.duitku.com';
    const merchantCode = cfg.payment_duitku_merchant_code;
    const apiKey = cfg.payment_duitku_api_key;

    // Create dummy transaction
    const orderId = 'TEST-' + Date.now();
    const amount = 10000;
    // Duitku signature: sha256(merchantCode + amount + merchantOrderId + apiKey)
    const signature = crypto
      .createHash('sha256')
      .update(merchantCode + amount + orderId + apiKey)
      .digest('hex');

    const duitkuBody = {
      merchantCode: merchantCode,
      paymentAmount: amount,
      merchantOrderId: orderId,
      productDetails: 'Test Payment',
      email: 'test@example.com',
      phoneNumber: '080000000000',
      callbackUrl: `${process.env.SITE_URL || 'https://caffe.id'}/api/topup/duitku-callback`,
      returnUrl: `${process.env.SITE_URL || 'https://caffe.id'}/tenant-billing`,
      signature: signature,
    };

    const duitkuRes = await fetch(baseUrl + '/webapi/api/merchant/v1/inquiry/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(duitkuBody),
    });
    const duitkuResult = await duitkuRes.json();

    if (!duitkuRes.ok || duitkuResult.statusCode !== '00') {
      return res.json({ success: false, message: duitkuResult.statusMessage || 'Gagal membuat transaksi Duitku', detail: duitkuResult });
    }

    res.json({
      success: true,
      message: 'Koneksi ke Duitku berhasil',
      payment_url: duitkuResult.paymentUrl,
      reference: duitkuResult.reference,
      order_id: orderId,
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

// ─── Midtrans Notification Webhook ─────────────────────────────
// Midtrans sends POST with JSON body { transaction_status, order_id, ... }
// Use express.raw() or express.json() — already configured for JSON
app.post('/api/payment/midtrans/notification', async (req, res) => {
  try {
    const notif = req.body;
    const orderId = notif.order_id;

    // Find the topup request by snap_order_id
    const [[reqRow]] = await db.query(
      'SELECT * FROM topup_requests WHERE snap_order_id = ? AND status = ?',
      [orderId, 'pending']
    );
    if (!reqRow) {
      // Maybe already confirmed — still respond OK to Midtrans
      return res.status(200).json({ status: 'ignored', message: 'Request not found or already processed' });
    }

    const transactionStatus = notif.transaction_status;
    const fraudStatus = notif.fraud_status;

    let confirmed = false;

    // Transaction success conditions
    if (transactionStatus === 'capture') {
      // capture hanya untuk credit card
      if (fraudStatus === 'accept') confirmed = true;
    } else if (transactionStatus === 'settlement') {
      // settlement untuk transfer bank, VA
      confirmed = true;
    }

    if (confirmed) {
      const depositAmount = reqRow.transfer_amount || reqRow.amount;

      const { confirmTopup } = require('./routes/topup');
      // confirmTopup needs to be accessible — inline it since it's in the same file scope
      // Actually we just call it via db directly

      await db.query(
        'UPDATE tenants SET balance = balance + ? WHERE id = ?',
        [depositAmount, reqRow.tenant_id]
      );
      await db.query(
        `UPDATE topup_requests SET status = 'confirmed', confirmed_at = NOW(),
         auto_confirmed = 1, matched_ref = ? WHERE id = ?`,
        [notif.transaction_id || orderId, reqRow.id]
      );

      // Queue email
      const [[tenant]] = await db.query(
        'SELECT admin_email, name, slug FROM tenants WHERE id = ?',
        [reqRow.tenant_id]
      );
      if (tenant?.admin_email) {
        const queue = require('./services/queue');
        queue.enqueue('email.topup_confirm', {
          to: tenant.admin_email,
          name: tenant.name || tenant.slug,
          amount: depositAmount,
          balance: depositAmount,
          slug: tenant.slug,
        }).catch(() => {});
      }

      console.log(`[Midtrans] Topup #${reqRow.id} confirmed via notification: ${depositAmount}`);
      res.status(200).json({ status: 'confirmed' });
    } else {
      // Mark as pending payment (might be expired/denied/etc)
      if (['deny', 'cancel', 'expire', 'failure'].includes(transactionStatus)) {
        await db.query(
          "UPDATE topup_requests SET status = 'expired', notes = ? WHERE id = ?",
          [`Midtrans: ${transactionStatus}`, reqRow.id]
        );
      }
      res.status(200).json({ status: transactionStatus, fraud: fraudStatus });
    }
  } catch (e) {
    console.error('[Midtrans Notification Error]', e);
    // Always return 200 to Midtrans
    res.status(200).json({ status: 'error', message: e.message });
  }
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

// ─── AI CHAT ──────────────────────────────────────────────────
app.post('/api/ai/chat', async (req, res) => {
  const { messages, system } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI not configured' });
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20000); // 20s hard timeout

  try {
    const aiBase = process.env.AI_BASE_URL || 'https://api.anthropic.com/v1';
    const model = process.env.AI_MODEL || 'commandcode';
    const isOpenAICompat = !aiBase.includes('anthropic.com');

    const reqBody = isOpenAICompat
      ? { model, max_tokens: 300, stream: true, messages: [{ role: 'system', content: system || '' }, ...messages.slice(-6)] }
      : { model, max_tokens: 300, system: system || '', messages: messages.slice(-6) };

    const headers = isOpenAICompat
      ? { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

    const response = await fetch(`${aiBase}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(reqBody), signal: abort.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    // Stream-read the response body chunk by chunk, parse SSE
    let reply = '';
    let buf = '';
    const decoder = new TextDecoder();

    for await (const chunk of response.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { buf = ''; break; }
        try {
          const parsed = JSON.parse(raw);
          reply += parsed.choices?.[0]?.delta?.content
            || parsed.content?.[0]?.delta?.text
            || '';
        } catch { /* skip */ }
      }
    }

    clearTimeout(timeout);
    res.json({ reply: reply.trim() });
  } catch (err) {
    clearTimeout(timeout);
    console.error('[AI] Error:', err.message);
    res.status(500).json({ error: 'AI error', detail: err.message });
  }
});

// 404 for unknown API routes
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Registry running on http://0.0.0.0:${PORT}`);
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
