const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { tenantAuth, superadminAuth } = require('../services/auth');
const { swapUiTemplate } = require('../services/provisioner');

// GET /api/templates — public list, augmented with owned/active if auth provided
router.get('/', async (req, res) => {
  try {
    let tenantId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
        if (decoded.tenantId) tenantId = decoded.tenantId;
      } catch (_) {}
    }

    const [templates] = await db.query(
      'SELECT id, slug, name, description, tier, price, image_tag, thumbnail_url, preview_url, preview_hue, tags, rating, review_count, sort_order FROM ui_templates WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
    );

    if (tenantId) {
      const [purchases] = await db.query(
        'SELECT template_id FROM tenant_templates WHERE tenant_id = ?',
        [tenantId]
      );
      const [[tenantRow]] = await db.query(
        'SELECT active_template_id FROM tenants WHERE id = ?',
        [tenantId]
      );
      const ownedIds = new Set(purchases.map(p => p.template_id));
      const activeId = tenantRow?.active_template_id;

      for (const t of templates) {
        t.owned = ownedIds.has(t.id) || t.price === 0;
        t.is_active_for_tenant = t.id === activeId;
      }
    }

    res.json({ templates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/templates/my — tenant's purchased templates
router.get('/my', tenantAuth, async (req, res) => {
  const tenantId = req.tenantUser.tenantId;
  try {
    const [[tenant]] = await db.query('SELECT active_template_id FROM tenants WHERE id = ?', [tenantId]);
    const [rows] = await db.query(`
      SELECT t.id, t.slug, t.name, t.description, t.tier, t.price, t.image_tag,
             t.thumbnail_url, t.preview_url, t.tags, t.rating,
             tt.purchased_at,
             (t.id = ?) AS is_active_for_tenant
      FROM tenant_templates tt
      JOIN ui_templates t ON t.id = tt.template_id
      WHERE tt.tenant_id = ?
      ORDER BY tt.purchased_at DESC
    `, [tenant?.active_template_id || 0, tenantId]);
    res.json({ templates: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/templates/:id/purchase — deduct balance, record ownership
router.post('/:id/purchase', tenantAuth, async (req, res) => {
  const templateId = parseInt(req.params.id);
  const tenantId = req.tenantUser.tenantId;

  try {
    const [[tpl]] = await db.query(
      'SELECT id, name, price, tier FROM ui_templates WHERE id = ? AND is_active = 1',
      [templateId]
    );
    if (!tpl) return res.status(404).json({ error: 'Template tidak ditemukan' });

    const [[existing]] = await db.query(
      'SELECT id FROM tenant_templates WHERE tenant_id = ? AND template_id = ?',
      [tenantId, templateId]
    );
    if (existing) return res.status(409).json({ error: 'Template sudah dimiliki' });

    if (tpl.price > 0) {
      const [[tenant]] = await db.query('SELECT balance FROM tenants WHERE id = ?', [tenantId]);
      if (!tenant) return res.status(404).json({ error: 'Tenant tidak ditemukan' });
      if (tenant.balance < tpl.price) {
        return res.status(402).json({ error: `Saldo tidak cukup. Dibutuhkan Rp ${tpl.price.toLocaleString('id-ID')}` });
      }
      await db.query('UPDATE tenants SET balance = balance - ? WHERE id = ?', [tpl.price, tenantId]);
    }

    await db.query(
      'INSERT INTO tenant_templates (tenant_id, template_id) VALUES (?, ?)',
      [tenantId, templateId]
    );

    res.json({ success: true, message: `Template "${tpl.name}" berhasil dibeli` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/templates/:id/activate — swap Docker container to template image_tag
router.post('/:id/activate', tenantAuth, async (req, res) => {
  const templateId = parseInt(req.params.id);
  const tenantId = req.tenantUser.tenantId;

  try {
    const [[tpl]] = await db.query(
      'SELECT id, name, price, image_tag FROM ui_templates WHERE id = ? AND is_active = 1',
      [templateId]
    );
    if (!tpl) return res.status(404).json({ error: 'Template tidak ditemukan' });

    if (tpl.price > 0) {
      const [[ownership]] = await db.query(
        'SELECT id FROM tenant_templates WHERE tenant_id = ? AND template_id = ?',
        [tenantId, templateId]
      );
      if (!ownership) return res.status(403).json({ error: 'Template belum dibeli' });
    }

    const [[tenant]] = await db.query('SELECT slug, container_status FROM tenants WHERE id = ?', [tenantId]);
    if (!tenant) return res.status(404).json({ error: 'Tenant tidak ditemukan' });

    // Swap container with new image tag
    const imageTag = tpl.image_tag || 'cafe-ui:latest';
    await swapUiTemplate(tenant.slug, imageTag);

    // Persist active template
    await db.query('UPDATE tenants SET active_template_id = ? WHERE id = ?', [templateId, tenantId]);

    res.json({ success: true, message: `Template "${tpl.name}" (${imageTag}) berhasil diaktifkan` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Superadmin routes ──

router.post('/', superadminAuth, async (req, res) => {
  const { slug, name, description, tier, price, image_tag, thumbnail_url, preview_url, preview_hue, tags, sort_order } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug dan name wajib' });
  try {
    const [result] = await db.query(
      'INSERT INTO ui_templates (slug, name, description, tier, price, image_tag, thumbnail_url, preview_url, preview_hue, tags, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [slug, name, description || '', tier || 'free', price || 0, image_tag || 'cafe-ui:latest', thumbnail_url || null, preview_url || null, preview_hue || '30', tags || '', sort_order || 0]
    );
    res.status(201).json({ id: result.insertId, success: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Slug sudah digunakan' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', superadminAuth, async (req, res) => {
  const allowed = ['name', 'description', 'tier', 'price', 'image_tag', 'thumbnail_url', 'preview_url', 'preview_hue', 'tags', 'is_active', 'sort_order', 'rating', 'review_count'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Tidak ada field yang diubah' });
  try {
    await db.query('UPDATE ui_templates SET ? WHERE id = ?', [updates, parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', superadminAuth, async (req, res) => {
  try {
    await db.query('UPDATE ui_templates SET is_active = 0 WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
