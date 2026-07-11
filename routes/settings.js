const express = require('express');
const router = express.Router();
const db = require('../config/database');
const fs = require('fs');
const path = require('path');
const { superadminAuth } = require('../services/auth');

// ==================== SYSTEM SETTINGS ====================

// GET /api/settings — returns array format for frontend + public GET without auth
router.get('/', async (req, res) => {
  try {
    // Check if superadmin — return all; else return only public
    let rows;
    const authHeader = req.headers.authorization;
    let isAdmin = false;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const { getSecret } = require('../services/auth');
        const decoded = jwt.verify(authHeader.replace('Bearer ', ''), getSecret());
        isAdmin = decoded.role === 'superadmin';
      } catch (_) {}
    }

    if (isAdmin) {
      [rows] = await db.query('SELECT * FROM system_settings ORDER BY setting_group, setting_key');
    } else {
      [rows] = await db.query('SELECT id, setting_key, setting_value, setting_type, setting_group, label FROM system_settings WHERE is_public=1 ORDER BY setting_group, setting_key');
    }

    res.json({ settings: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings — batch update { settings: [{key,value}] }
router.put('/', superadminAuth, async (req, res) => {
  try {
    const items = req.body.settings || Object.entries(req.body).map(([key, value]) => ({ key, value }));
    for (const item of items) {
      const key = item.key || item.setting_key;
      const value = String(item.value ?? item.setting_value ?? '');
      await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
        [key, value, value]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EMAIL TEMPLATES ====================

// GET /api/settings/templates — list all templates
router.get('/templates', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, subject, LEFT(html, 300) AS html_preview, updated_at FROM system_templates ORDER BY name');
    res.json({ templates: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/templates/:name — get full template
router.get('/templates/:name', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM system_templates WHERE name = ?', [req.params.name]);
    if (!rows.length) return res.status(404).json({ error: 'Template tidak ditemukan' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings/templates/:name — update template
router.put('/templates/:name', superadminAuth, async (req, res) => {
  try {
    const { subject, html } = req.body;
    const [existing] = await db.query('SELECT id FROM system_templates WHERE name = ?', [req.params.name]);
    if (!existing.length) return res.status(404).json({ error: 'Template tidak ditemukan' });

    await db.query(
      'UPDATE system_templates SET subject = COALESCE(?, subject), html = COALESCE(?, html) WHERE name = ?',
      [subject || null, html || null, req.params.name]
    );

    // Invalidate cache in email service
    try {
      const emailService = require('../services/email');
      if (emailService.invalidateCache) emailService.invalidateCache(req.params.name);
    } catch (_) {}

    res.json({ success: true, name: req.params.name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/templates/:name/test — send test email
router.post('/templates/:name/test', superadminAuth, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Email tujuan wajib diisi' });

    const { sendMail } = require('../services/email');
    const result = await sendMail({
      to,
      subject: `[TEST] Template ${req.params.name}`,
      template: req.params.name,
      vars: {
        name: 'Test User',
        slug: 'test-cafe',
        email: 'admin@test.com',
        password: 'TestPass123',
        plan: 'Gratis',
        adminUrl: 'https://office-test.caffe.my.id/admin',
        resetUrl: 'https://office-test.caffe.my.id/admin/reset?token=test123',
        cafeName: 'Test Cafe',
        role: 'Admin',
        balance: '7.500',
        dailyCost: '2.500',
        daysLeft: '3',
        topupUrl: 'https://office-test.caffe.my.id/admin/billing',
      },
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/templates/reset — reset all templates to defaults from file
router.post('/templates/reset', superadminAuth, async (req, res) => {
  try {
    const templateDir = path.join(__dirname, '..', 'templates');
    const files = fs.readdirSync(templateDir).filter(f => f.endsWith('.html'));

    const subjectMap = {
      'welcome.html': '☕ Selamat Datang di Cafe Azzura!',
      'forgot-password.html': '🔐 Reset Password Cafe Azzura',
      'login-info.html': '🔑 Informasi Login Cafe Azzura',
      'balance-warning.html': '⚠️ Saldo Cafe Azzura Hampir Habis',
      'suspended.html': '⛔ Layanan Cafe Azzura Dihentikan',
    };

    for (const file of files) {
      const html = fs.readFileSync(path.join(templateDir, file), 'utf8');
      const subject = subjectMap[file] || 'Cafe Azzura Notification';
      await db.query(
        'INSERT INTO system_templates (name, subject, html) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE subject = ?, html = ?',
        [file, subject, html, subject, html]
      );
    }

    // Invalidate cache
    try {
      const emailService = require('../services/email');
      if (emailService.invalidateCache) emailService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, reset: files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SMTP PROVIDERS ====================

// GET /api/settings/smtp/providers — list all SMTP providers
router.get('/smtp/providers', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_providers'");
    const providers = rows.length && rows[0].setting_value ? JSON.parse(rows[0].setting_value) : [];
    res.json({ providers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings/smtp/providers — replace all providers
router.put('/smtp/providers', superadminAuth, async (req, res) => {
  try {
    const { providers } = req.body;
    if (!Array.isArray(providers) || !providers.length) {
      return res.status(400).json({ error: 'providers wajib array dengan minimal 1 provider' });
    }
    for (const p of providers) {
      if (!p.host || !p.user || !p.pass) {
        return res.status(400).json({ error: `Provider "${p.name || '?'}" — host, user, dan pass wajib diisi` });
      }
    }
    await db.query(
      "INSERT INTO system_settings (setting_key, setting_value, description) VALUES ('smtp_providers', ?, 'JSON array of SMTP providers') ON DUPLICATE KEY UPDATE setting_value = ?",
      [JSON.stringify(providers), JSON.stringify(providers)]
    );
    res.json({ success: true, count: providers.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/smtp/test — test a specific provider or all providers
router.post('/smtp/test', superadminAuth, async (req, res) => {
  try {
    const { to, provider } = req.body;
    if (!to) return res.status(400).json({ error: 'Email tujuan wajib diisi' });

    const nodemailer = require('nodemailer');

    if (provider) {
      // Test single provider
      const transporter = nodemailer.createTransport({
        host: provider.host,
        port: provider.port || 465,
        secure: (provider.port || 465) === 465,
        auth: { user: provider.user, pass: provider.pass },
      });
      await transporter.sendMail({
        from: `"Cafe Azzura" <${provider.from || 'noreply@cafeazzura.com'}>`,
        to,
        subject: `[TEST SMTP] ${provider.name || provider.host}`,
        html: '<p>Test email dari Cafe Azzura</p>',
      });
      return res.json({ success: true, provider: provider.name || provider.host });
    }

    // Test all providers from DB
    const { sendMail } = require('../services/email');
    const result = await sendMail({
      to,
      subject: '[TEST] SMTP Combo Cafe Azzura',
      template: 'welcome.html',
      vars: {
        name: 'Test Combo',
        slug: 'test-cafe',
        email: 'admin@test.com',
        password: 'TestPass123',
        plan: 'Gratis',
        adminUrl: 'https://office-test.caffe.my.id/admin',
        resetUrl: 'https://office-test.caffe.my.id/admin/reset?token=test123',
        cafeName: 'Cafe Azzura',
        role: 'Superadmin',
      },
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
