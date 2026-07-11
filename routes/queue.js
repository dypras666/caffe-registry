const express = require('express');
const router = express.Router();
const queue = require('../services/queue');
const { superadminAuth } = require('../services/auth');

// GET /api/queue/stats
router.get('/stats', superadminAuth, async (req, res) => {
  try {
    const stats = await queue.getStats();
    res.json({ stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/queue/history?limit=50&type=email.welcome
router.get('/history', superadminAuth, async (req, res) => {
  try {
    const jobs = await queue.getHistory({
      limit: parseInt(req.query.limit) || 50,
      type: req.query.type || null,
    });
    res.json({ jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/queue/retry-failed
router.post('/retry-failed', superadminAuth, async (req, res) => {
  try {
    const n = await queue.retryFailed();
    res.json({ message: `${n} job(s) di-retry`, count: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/queue/enqueue — manual enqueue (for testing)
router.post('/enqueue', superadminAuth, async (req, res) => {
  try {
    const { type, payload, runAt } = req.body;
    if (!type) return res.status(400).json({ error: 'type wajib' });
    const id = await queue.enqueue(type, payload || {}, { runAt });
    res.status(201).json({ message: 'Job ditambahkan', id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/queue/test-email/:type — test specific email
router.post('/test-email/:type', superadminAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to (email) wajib' });

  const siteUrl = process.env.SITE_URL || 'https://caffe.id';
  const domain  = process.env.APP_DOMAIN || 'caffe.id';
  const samples = {
    'welcome':          { type: 'email.welcome',         payload: { to, name: 'Test User', adminUrl: `https://office-test.${domain}/admin`, email: to, password: 'test123', plan: 'starter' } },
    'forgot_password':  { type: 'email.forgot_password',  payload: { to, name: 'Test User', resetUrl: `${siteUrl}/reset-password?token=abc123` } },
    'topup_confirm':    { type: 'email.topup_confirm',    payload: { to, name: 'Test User', amount: 50000, balance: 150000, slug: 'test-cafe' } },
    'balance_warning':  { type: 'email.balance_warning',  payload: { to, name: 'Test User', slug: 'test-cafe', balance: 3000, dailyCost: 1000, daysLeft: 3, topupUrl: `${siteUrl}/tenant-billing` } },
    'suspended':        { type: 'email.suspended',        payload: { to, name: 'Test User', slug: 'test-cafe', topupUrl: `${siteUrl}/tenant-billing` } },
    'expiry_reminder':  { type: 'email.expiry_reminder',  payload: { to, name: 'Test User', slug: 'test-cafe', expiryDate: '31 Des 2026', daysLeft: 7, renewUrl: `${siteUrl}/tenant-billing` } },
    'login_info':       { type: 'email.login_info',       payload: { to, name: 'Test User', cafeName: 'Test Cafe', adminUrl: `https://office-test.${domain}/admin`, email: to, role: 'admin' } },
  };

  const sample = samples[req.params.type];
  if (!sample) return res.status(400).json({ error: 'Type tidak valid', valid: Object.keys(samples) });

  try {
    const id = await queue.enqueue(sample.type, sample.payload);
    res.json({ message: `Test job ${sample.type} dijadwalkan`, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
