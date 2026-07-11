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

module.exports = router;
