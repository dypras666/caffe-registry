const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { superadminAuth, tenantAuth } = require('../services/auth');
const { provision, deprovision } = require('../services/addon-provisioner');

// ─── SUPERADMIN: CRUD addons ──────────────────────────────────

// GET /api/addons — all addons (superadmin)
router.get('/', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM addons ORDER BY sort_order, name');
    res.json({ addons: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/addons/available — active addons (tenant-facing)
router.get('/available', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, slug, description, price_monthly, icon FROM addons WHERE is_active=1 ORDER BY sort_order, name');
    res.json({ addons: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/addons — create
router.post('/', superadminAuth, async (req, res) => {
  try {
    const { name, slug, description, price_monthly, icon, image, image_tag, container_port, subdomain_prefix, env_vars } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name dan slug wajib' });
    const r = await db.query(
      'INSERT INTO addons (name, slug, description, price_monthly, icon, image, image_tag, container_port, subdomain_prefix, env_vars) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [name, slug, description || '', price_monthly || 0, icon || 'extension', image || null, image_tag || 'latest', container_port || 80, subdomain_prefix || null, env_vars || null]
    );
    res.status(201).json({ success: true, id: r[0].insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/addons/:id — update full including image
router.put('/:id', superadminAuth, async (req, res) => {
  try {
    const { name, description, price_monthly, icon, is_active, image, image_tag, container_port, subdomain_prefix, env_vars } = req.body;
    await db.query(
      `UPDATE addons SET
        name=COALESCE(?,name), description=COALESCE(?,description),
        price_monthly=COALESCE(?,price_monthly), icon=COALESCE(?,icon),
        is_active=COALESCE(?,is_active), image=COALESCE(?,image),
        image_tag=COALESCE(?,image_tag), container_port=COALESCE(?,container_port),
        subdomain_prefix=COALESCE(?,subdomain_prefix), env_vars=COALESCE(?,env_vars)
      WHERE id=?`,
      [name||null, description??null, price_monthly??null, icon||null, is_active??null, image??null, image_tag??null, container_port??null, subdomain_prefix??null, env_vars??null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/addons/:id
router.delete('/:id', superadminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM addons WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SUPERADMIN: provision/deprovision per tenant ────────────

// POST /api/addons/superadmin/provision/:tenantAddonId
router.post('/superadmin/provision/:id', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT ta.*, a.* FROM tenant_addons ta JOIN addons a ON ta.addon_id=a.id WHERE ta.id=?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await provision(rows[0].tenant_id, rows[0].id, rows[0]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/addons/superadmin/deprovision/:tenantAddonId
router.post('/superadmin/deprovision/:id', superadminAuth, async (req, res) => {
  try {
    await deprovision(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SUPERADMIN: tenant addon status ─────────────────────────

// GET /api/addons/superadmin/tenants — all tenants with their addons
router.get('/superadmin/tenants', superadminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ta.id AS ta_id, ta.tenant_id, ta.subdomain, ta.container_id,
             ta.container_port_real, ta.provision_status, ta.attached_at,
             a.id AS addon_id, a.name, a.slug, a.icon, a.image,
             t.slug AS tenant_slug
      FROM tenant_addons ta
      JOIN addons a ON ta.addon_id=a.id
      JOIN tenants t ON ta.tenant_id=t.id
      ORDER BY t.slug, a.name`);
    res.json({ tenantAddons: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TENANT: attached addons ────────────────────────────────

// GET /api/addons/my — tenant's active addons
router.get('/my', tenantAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.id, a.name, a.slug, a.description, a.price_monthly, a.icon,
              ta.status, ta.provision_status, ta.attached_at,
              ta.subdomain, ta.container_id
       FROM tenant_addons ta JOIN addons a ON ta.addon_id = a.id
       WHERE ta.tenant_id = ? AND a.is_active=1
       ORDER BY a.sort_order, a.name`,
      [req.tenantUser.tenantId]
    );
    res.json({ addons: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/addons/attach — tenant attaches addon → auto-provision
router.post('/attach', tenantAuth, async (req, res) => {
  try {
    const { addon_id } = req.body;
    if (!addon_id) return res.status(400).json({ error: 'addon_id wajib' });
    const [[addon]] = await db.query('SELECT * FROM addons WHERE id=? AND is_active=1', [addon_id]);
    if (!addon) return res.status(404).json({ error: 'Addon tidak ditemukan' });
    const [[existing]] = await db.query('SELECT id FROM tenant_addons WHERE tenant_id=? AND addon_id=?', [req.tenantUser.tenantId, addon_id]);
    if (existing) return res.status(400).json({ error: 'Addon sudah terpasang' });
    // Check balance
    if (addon.price_monthly > 0) {
      const [[tenant]] = await db.query('SELECT balance FROM tenants WHERE id=?', [req.tenantUser.tenantId]);
      if (!tenant || Number(tenant.balance) < addon.price_monthly) {
        return res.status(400).json({ error: 'Saldo tidak cukup. Top-up dulu minimal Rp ' + addon.price_monthly.toLocaleString('id') });
      }
    }
    // Insert
    const r = await db.query('INSERT INTO tenant_addons (tenant_id, addon_id) VALUES (?,?)', [req.tenantUser.tenantId, addon_id]);
    const taId = r[0].insertId;
    // Debit
    if (addon.price_monthly > 0) {
      await db.query('UPDATE tenants SET balance = balance - ? WHERE id=?', [addon.price_monthly, req.tenantUser.tenantId]);
    }
    // Auto-provision if has image
    if (addon.image) {
      await provision(req.tenantUser.tenantId, taId, addon).catch(e => {
        console.error('[addon] auto-provision failed:', e.message);
        // still return success so user sees the addon is attached
      });
    }
    res.status(201).json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/addons/detach — tenant detaches → deprovision
router.post('/detach', tenantAuth, async (req, res) => {
  try {
    const { addon_id } = req.body;
    const [rows] = await db.query('SELECT id FROM tenant_addons WHERE tenant_id=? AND addon_id=?', [req.tenantUser.tenantId, addon_id]);
    if (rows.length) {
      await deprovision(rows[0].id).catch(() => {});
      await db.query('DELETE FROM tenant_addons WHERE id=?', [rows[0].id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
