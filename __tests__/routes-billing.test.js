jest.mock('../config/database');
jest.mock('jsonwebtoken');

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const billingRouter = require('../routes/billing');

const app = express();
app.use(express.json());
app.use('/api/billing', billingRouter);

const mockToken = 'mock-token';
beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: 1, email: 'admin@test.com', role: 'superadmin' });
});

describe('GET /api/billing/tenants', () => {
  it('returns all tenants with balance info', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'Cafe A', slug: 'cafe-a', status: 'active', balance: 5000, auto_suspend: 1, suspended_at: null, pricing_tier: 'starter', admin_email: 'a@b.com' }, { id: 2, name: 'Cafe B', slug: 'cafe-b', status: 'suspended', balance: 0, auto_suspend: 1, suspended_at: new Date(), pricing_tier: 'free', admin_email: null }]]);
    const res = await request(app).get('/api/billing/tenants').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(2);
    expect(res.body.tenants[0].daily_cost).toBe(1000);
    expect(res.body.tenants[1].is_suspended).toBe(true);
  });
});

describe('GET /api/billing/tenant/:id', () => {
  it('returns billing status', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'Test', slug: 'test', status: 'active', balance: 10000, auto_suspend: 1, suspended_at: null, pricing_tier: 'enterprise' }]]);
    const res = await request(app).get('/api/billing/tenant/1').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.daily_cost).toBe(5000);
    expect(res.body.days_left).toBe(2);
  });
});

describe('POST /api/billing/tenant/:id/topup', () => {
  it('rejects invalid amount', async () => {
    const res = await request(app).post('/api/billing/tenant/1/topup').set('Authorization', `Bearer ${mockToken}`).send({ amount: -100 });
    expect(res.status).toBe(400);
  });

  it('accepts valid topup', async () => {
    db.query.mockResolvedValueOnce([[{ affectedRows: 1 }]]);
    db.query.mockResolvedValueOnce([[{ id: 1, name: 'Test', slug: 'test', balance: 20000, status: 'active' }]]);
    const res = await request(app).post('/api/billing/tenant/1/topup').set('Authorization', `Bearer ${mockToken}`).send({ amount: 10000 });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(20000);
  });
});

describe('POST /api/billing/tenant/:id/toggle-suspend', () => {
  it('toggles auto_suspend on', async () => {
    db.query.mockResolvedValue([{}]);
    const res = await request(app).post('/api/billing/tenant/1/toggle-suspend').set('Authorization', `Bearer ${mockToken}`).send({ auto_suspend: true });
    expect(res.status).toBe(200);
    expect(res.body.auto_suspend).toBe(true);
  });

  it('toggles auto_suspend off', async () => {
    db.query.mockResolvedValue([{}]);
    const res = await request(app).post('/api/billing/tenant/1/toggle-suspend').set('Authorization', `Bearer ${mockToken}`).send({ auto_suspend: false });
    expect(res.status).toBe(200);
    expect(res.body.auto_suspend).toBe(false);
  });
});

describe('POST /api/billing/check', () => {
  it('triggers billing check', async () => {
    const res = await request(app).post('/api/billing/check').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
