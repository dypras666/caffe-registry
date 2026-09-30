const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { provisionTenant, checkAvailability } = require('../services/provisioner');
const queue = require('../services/queue');

const router = express.Router();

// Simple API Key middleware for integration
function integrationAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing integration API key' });
  }
  
  const token = authHeader.split(' ')[1];
  const validKey = process.env.INTEGRATION_API_KEY; // We'll need to set this in .env
  
  if (!validKey || token !== validKey) {
    return res.status(403).json({ error: 'Invalid integration API key' });
  }
  
  next();
}

// POST /api/integrations/provision
// Dipanggil oleh cafe-meter untuk otomatis membuat tenant backend.
router.post('/provision', integrationAuth, async (req, res) => {
  try {
    const { name, slug, email, password, phone } = req.body;

    if (!name || !slug || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, email, password' });
    }

    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase alphanumeric and hyphens only' });
    }

    // Check availability
    const avail = await checkAvailability(slug);
    if (!avail.available) {
      return res.status(400).json({ error: avail.error || 'Slug is already used' });
    }

    // Get free tier defaults
    const [plans] = await db.query("SELECT * FROM pricing_plans WHERE tier = 'free'");
    const freePlan = plans[0] || { ram_mb: 64, cpu_cores: 0.25, disk_mb: 500, name: 'Free Plan' };

    // Hash admin password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert into tenants
    const tenantId = await db.query(
      'INSERT INTO tenants (name, slug, email, phone, status, pricing_tier, ram_mb, cpu_cores, disk_mb, admin_email, admin_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, slug, email, phone || null, 'provisioning', 'free', freePlan.ram_mb, freePlan.cpu_cores, freePlan.disk_mb, email, hashedPassword]
    ).then(r => r[0].insertId);

    // Trigger provisioning in background
    provisionTenant(tenantId, slug, email, password).catch(console.error);

    // Send welcome email via queue
    const adminUrl = `https://office-${slug}.${process.env.APP_DOMAIN || 'caffe.id'}/admin`;
    queue.enqueue('email.welcome', {
      to: email,
      name,
      adminUrl,
      email,
      password,
      plan: freePlan.name,
    }).catch(console.error);

    res.status(201).json({
      success: true,
      tenant_id: tenantId,
      slug,
      admin_url: adminUrl,
      message: 'Provisioning started successfully'
    });
  } catch (error) {
    console.error('[Integration Provision]', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
