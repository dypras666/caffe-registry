const express = require('express');
const router = express.Router();
const db = require('../config/database');
const fs = require('fs');
const path = require('path');
const { getSecret } = require('../services/auth');

// ─── SYSTEM SETTINGS ───────────────────────────────────────────

// GET /api/settings — get all settings (public or admin)
router.get('/', async (req, res) => {
  try {
    let rows;
    const authHeader = req.headers.authorization;
    let isAdmin = false;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.replace('Bearer ', ''), getSecret());
        isAdmin = decoded.role === 'superadmin';
      } catch {}
    }

    if (isAdmin) {
      [rows] = await db.query('SELECT * FROM system_settings ORDER BY setting_group, setting_key');
    } else {
      [rows] = await db.query('SELECT setting_key, setting_value, label, description, setting_type, setting_group, is_public FROM system_settings WHERE is_public=1 ORDER BY setting_group, setting_key');
    }

    res.json({ settings: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings — bulk update settings (superadmin only)
router.put('/', async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : (req.body.settings || []);
    for (const item of items) {
      const key = item.key || item.setting_key;
      if (!key) continue;
      const val = String(item.value ?? item.setting_value ?? '');
      await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [key, val, val]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/tracking — return tracking settings as key-value object
router.get('/tracking', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?, ?, ?, ?)',
      ['fb_pixel_id', 'tiktok_pixel_id', 'ga_id', 'gtm_id']
    );
    const settings = {};
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/:key — return single setting
router.get('/:key', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT setting_value, is_public FROM system_settings WHERE setting_key = ?', [req.params.key]);
    if (rows.length === 0) return res.status(404).json({ error: 'Setting not found' });
    
    const setting = rows[0];
    if (!setting.is_public) {
      // Basic check for admin auth if not public
      const authHeader = req.headers.authorization;
      let isAdmin = false;
      if (authHeader) {
        try {
          const jwt = require('jsonwebtoken');
          const decoded = jwt.verify(authHeader.replace('Bearer ', ''), getSecret());
          isAdmin = decoded.role === 'superadmin';
        } catch {}
      }
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    }
    
    res.json({ value: setting.setting_value, setting: { setting_value: setting.setting_value } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
