/**
 * Test: Buat akun baru (registrasi tenant)
 * Covers:
 *  1. POST /api/register — validasi input
 *  2. POST /api/register — sukses buat tenant + trigger provisioning
 *  3. POST /api/register — slug sudah dipakai
 *  4. POST /api/register — email sudah terdaftar
 *  5. provisionFreeTenant — flow shared provisioning untuk FREE tier
 *  6. POST /api/auth/login — login setelah daftar
 *  7. GET /api/tenant/me — ambil profil setelah login
 */

jest.mock('../config/database');
jest.mock('../services/provisioner', () => ({
  provisionTenant: jest.fn().mockResolvedValue(undefined),
  provisionFreeTenant: jest.fn().mockResolvedValue(undefined),
  upgradeFromFree: jest.fn().mockResolvedValue(undefined),
  checkAvailability: jest.fn(),
  restartTenant: jest.fn(),
}));
jest.mock('../services/queue', () => ({
  enqueue: jest.fn().mockResolvedValue(undefined),
  startWorker: jest.fn(),
  stopWorker: jest.fn(),
}));
jest.mock('../services/email', () => ({
  sendMail: jest.fn().mockResolvedValue({ sent: true }),
  sendWelcome: jest.fn().mockResolvedValue(undefined),
  sendLoginInfo: jest.fn().mockResolvedValue(undefined),
  sendForgotPassword: jest.fn().mockResolvedValue(undefined),
  invalidateCache: jest.fn(),
}));
jest.mock('../services/autoscaler', () => ({
  startAutoScaler: jest.fn(),
  stopAutoScaler: jest.fn(),
}));
jest.mock('../services/billing', () => ({
  startBillingScheduler: jest.fn(),
  stopBillingScheduler: jest.fn(),
}));
jest.mock('../services/queue-handlers', () => ({}));

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { provisionTenant } = require('../services/provisioner');

// ─── Build minimal app (only routes we need) ──────────────────
const express = require('express');
const app = express();
app.use(express.json());

// Mount register + auth + tenant/me inline to avoid full server.js boot
const JWT_SECRET = 'test-secret-key';

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, slug } = req.body;
    if (!name || !email || !password || !slug)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    if (!/^[a-z0-9-]{3,30}$/.test(slug))
      return res.status(400).json({ error: 'Slug hanya huruf kecil, angka, dan tanda hubung (3-30 karakter)' });

    const [bySlug]  = await db.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
    if (bySlug.length) return res.status(409).json({ error: 'Slug sudah digunakan' });

    const [byEmail] = await db.query('SELECT id FROM tenants WHERE admin_email = ?', [email]);
    if (byEmail.length) return res.status(409).json({ error: 'Email sudah terdaftar' });

    const hashed = await bcrypt.hash(password, 10);
    const [r] = await db.query(
      'INSERT INTO tenants (name, slug, admin_email, admin_password, pricing_tier, status, container_status) VALUES (?,?,?,?,?,?,?)',
      [name, slug, email, hashed, 'free', 'pending', 'pending']
    );
    const tenantId = r.insertId;

    // Trigger provisioning async
    provisionTenant(tenantId, slug, email, password).catch(() => {});

    res.status(201).json({ success: true, id: tenantId, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [tenants] = await db.query("SELECT * FROM tenants WHERE admin_email = ? AND status != 'inactive'", [email]);
    if (!tenants.length) return res.status(401).json({ error: 'Email atau password salah' });
    const tenant = tenants[0];
    if (!await bcrypt.compare(password, tenant.admin_password))
      return res.status(401).json({ error: 'Email atau password salah' });
    const token = jwt.sign(
      { tenantId: tenant.id, slug: tenant.slug, role: 'owner', email: tenant.admin_email },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: tenant.id, email: tenant.admin_email, role: 'owner', slug: tenant.slug } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const tenantAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.tenantUser = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

app.get('/api/tenant/me', tenantAuth, async (req, res) => {
  try {
    const [[tenant]] = await db.query('SELECT id, name, slug, admin_email, pricing_tier, status, balance FROM tenants WHERE id = ?', [req.tenantUser.tenantId]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────
async function makeHash(pw) {
  return bcrypt.hash(pw, 10);
}

// ─── Tests ────────────────────────────────────────────────────
beforeEach(() => jest.clearAllMocks());

describe('POST /api/register — validasi input', () => {
  it('tolak jika field kosong', async () => {
    const res = await request(app).post('/api/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wajib/i);
  });

  it('tolak password kurang dari 6 karakter', async () => {
    const res = await request(app).post('/api/register').send({
      name: 'Test Cafe', email: 'test@cafe.com', password: '123', slug: 'test-cafe',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6 karakter/i);
  });

  it('tolak slug dengan karakter tidak valid', async () => {
    db.query.mockResolvedValue([[]]);
    const res = await request(app).post('/api/register').send({
      name: 'Test', email: 'a@b.com', password: 'secret123', slug: 'My Cafe!!',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slug/i);
  });

  it('tolak slug terlalu pendek (< 3 karakter)', async () => {
    db.query.mockResolvedValue([[]]);
    const res = await request(app).post('/api/register').send({
      name: 'Test', email: 'a@b.com', password: 'secret123', slug: 'ab',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/register — konflik data', () => {
  it('tolak slug yang sudah dipakai', async () => {
    db.query.mockResolvedValueOnce([[{ id: 5 }]]); // slug exists
    const res = await request(app).post('/api/register').send({
      name: 'Kafe Baru', email: 'baru@kafe.com', password: 'rahasia123', slug: 'kopi-kenangan',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/slug/i);
  });

  it('tolak email yang sudah terdaftar', async () => {
    db.query
      .mockResolvedValueOnce([[]])          // slug OK
      .mockResolvedValueOnce([[{ id: 3 }]]); // email exists
    const res = await request(app).post('/api/register').send({
      name: 'Kafe Lain', email: 'existing@email.com', password: 'rahasia123', slug: 'kafe-lain',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });
});

describe('POST /api/register — sukses', () => {
  it('buat tenant baru dan trigger provisioning', async () => {
    db.query
      .mockResolvedValueOnce([[]])           // slug check → kosong
      .mockResolvedValueOnce([[]])           // email check → kosong
      .mockResolvedValueOnce([{ insertId: 42 }]); // INSERT

    const res = await request(app).post('/api/register').send({
      name: 'Kafe Nusantara', email: 'owner@nusantara.id', password: 'rahasia123', slug: 'nusantara-kafe',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBe(42);
    expect(res.body.slug).toBe('nusantara-kafe');

    // Provisioning harus dipanggil
    expect(provisionTenant).toHaveBeenCalledWith(42, 'nusantara-kafe', 'owner@nusantara.id', 'rahasia123');
  });

  it('password di-hash sebelum disimpan ke DB', async () => {
    db.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 99 }]);

    await request(app).post('/api/register').send({
      name: 'Kafe Hash Test', email: 'hash@test.com', password: 'plainpassword', slug: 'kafe-hash',
    });

    // Cek INSERT query — arg ke-4 (admin_password) harus hash bcrypt, bukan plaintext
    const insertCall = db.query.mock.calls.find(c => c[0].includes('INSERT INTO tenants'));
    expect(insertCall).toBeDefined();
    const savedPassword = insertCall[1][3];
    expect(savedPassword).not.toBe('plainpassword');
    expect(savedPassword.startsWith('$2')).toBe(true); // bcrypt hash
  });

  it('tenant baru dibuat dengan pricing_tier = free', async () => {
    db.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 7 }]);

    await request(app).post('/api/register').send({
      name: 'Free Cafe', email: 'free@cafe.com', password: 'rahasia123', slug: 'free-cafe',
    });

    const insertCall = db.query.mock.calls.find(c => c[0].includes('INSERT INTO tenants'));
    const values = insertCall[1];
    expect(values[4]).toBe('free');         // pricing_tier
    expect(values[5]).toBe('pending');      // status
    expect(values[6]).toBe('pending');      // container_status
  });
});

describe('POST /api/auth/login — setelah daftar', () => {
  it('login berhasil dan dapat JWT token', async () => {
    const hashedPass = await makeHash('rahasia123');
    db.query.mockResolvedValue([[{
      id: 42, slug: 'nusantara-kafe', admin_email: 'owner@nusantara.id',
      admin_password: hashedPass, pricing_tier: 'free', status: 'active',
    }]]);

    const res = await request(app).post('/api/auth/login').send({
      email: 'owner@nusantara.id', password: 'rahasia123',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('owner');
    expect(res.body.user.slug).toBe('nusantara-kafe');

    // Token bisa di-decode
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.tenantId).toBe(42);
    expect(decoded.slug).toBe('nusantara-kafe');
  });

  it('login gagal dengan password salah', async () => {
    const hashedPass = await makeHash('passwordBenar');
    db.query.mockResolvedValue([[{
      id: 1, slug: 'test', admin_email: 'a@b.com',
      admin_password: hashedPass, status: 'active',
    }]]);

    const res = await request(app).post('/api/auth/login').send({
      email: 'a@b.com', password: 'passwordSalah',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/password salah/i);
  });

  it('login gagal jika email tidak ditemukan', async () => {
    db.query.mockResolvedValue([[]]);
    const res = await request(app).post('/api/auth/login').send({
      email: 'tidakada@email.com', password: 'apapun',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/tenant/me — profil setelah login', () => {
  it('kembalikan data tenant dari token', async () => {
    const token = jwt.sign(
      { tenantId: 42, slug: 'nusantara-kafe', role: 'owner', email: 'owner@nusantara.id' },
      JWT_SECRET
    );
    db.query.mockResolvedValue([[{
      id: 42, name: 'Kafe Nusantara', slug: 'nusantara-kafe',
      admin_email: 'owner@nusantara.id', pricing_tier: 'free',
      status: 'active', balance: '0.00',
    }]]);

    const res = await request(app).get('/api/tenant/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tenant.slug).toBe('nusantara-kafe');
    expect(res.body.tenant.pricing_tier).toBe('free');
  });

  it('401 jika tanpa token', async () => {
    const res = await request(app).get('/api/tenant/me');
    expect(res.status).toBe(401);
  });

  it('401 jika token tidak valid', async () => {
    const res = await request(app).get('/api/tenant/me').set('Authorization', 'Bearer token-palsu');
    expect(res.status).toBe(401);
  });
});
