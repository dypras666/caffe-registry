const express = require('express');
const router = express.Router();
const { superadminAuth } = require('../services/auth');
const backupSvc = require('../services/backup');
const queue = require('../services/queue');

// GET /api/backup — list backup files
router.get('/', superadminAuth, async (_req, res) => {
  try {
    const backups = await backupSvc.listBackups();
    res.json({ backups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/backup/run — trigger manual backup
router.post('/run', superadminAuth, async (_req, res) => {
  try {
    queue.enqueue('backup.database', { manual: true, triggered_by: 'superadmin' });
    res.json({ success: true, message: 'Backup dijadwalkan — akan diproses dalam beberapa detik' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/backup/run-now — run backup synchronously (for testing)
router.get('/run-now', superadminAuth, async (_req, res) => {
  try {
    const result = await backupSvc.runBackup();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
