jest.mock('../config/database');
jest.mock('jsonwebtoken');
jest.mock('../services/provisioner', () => ({
  provisionServer: jest.fn().mockResolvedValue({}),
  drainServer: jest.fn().mockResolvedValue({ success: true }),
  migrateTenant: jest.fn().mockResolvedValue({ success: true, containerId: 'abc123' }),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const serversRouter = require('../routes/servers');

const app = express();
app.use(express.json());
app.use('/api/servers', serversRouter);

const mockToken = 'mock-superadmin-token';
beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: 1, email: 'admin@test.com', role: 'superadmin' });
});

describe('GET /api/servers', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/servers');
    expect(res.status).toBe(401);
  });

  it('returns server list with auth', async () => {
    db.query.mockResolvedValue([[{ id: 1, hostname: 'vps-1', status: 'active' }]]);
    const res = await request(app).get('/api/servers').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.servers).toHaveLength(1);
  });
});

describe('GET /api/servers/:id', () => {
  it('returns 404 for unknown server', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/servers/999').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(404);
  });

  it('returns server detail with tenants', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, hostname: 'vps-1', ip_address: '10.0.0.1', status: 'active' }]]);
    db.query.mockResolvedValueOnce([[{ id: 10, name: 'Tenant A', slug: 'tenant-a', status: 'active', pricing_tier: 'free', backend_port: 3200, container_status: 'running' }]]);
    const res = await request(app).get('/api/servers/1').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].name).toBe('Tenant A');
  });
});

describe('POST /api/servers', () => {
  it('returns 400 if hostname is missing', async () => {
    const res = await request(app).post('/api/servers').set('Authorization', `Bearer ${mockToken}`).send({ ip_address: '10.0.0.1' });
    expect(res.status).toBe(400);
  });

  it('returns 409 if hostname already exists', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }]]);
    const res = await request(app).post('/api/servers').set('Authorization', `Bearer ${mockToken}`).send({ hostname: 'dup', ip_address: '10.0.0.1' });
    expect(res.status).toBe(409);
  });

  it('creates server and triggers provision in background', async () => {
    db.query.mockResolvedValueOnce([[]]);
    db.query.mockResolvedValueOnce([{ insertId: 5 }]);
    const res = await request(app).post('/api/servers').set('Authorization', `Bearer ${mockToken}`).send({ hostname: 'vps-5', ip_address: '10.0.0.5', ssh_password: 'secret123', region: 'sg' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(5);
    expect(res.body.status).toBe('provisioning');
  });
});

describe('POST /api/servers/:id/heartbeat', () => {
  beforeAll(() => { process.env.AGENT_API_KEY = 'test-agent-key'; });
  afterAll(() => { delete process.env.AGENT_API_KEY; });

  it('rejects without API key', async () => {
    const res = await request(app).post('/api/servers/1/heartbeat').send({ used_ram_mb: 512 });
    expect(res.status).toBe(401);
  });

  it('accepts with valid API key', async () => {
    db.query.mockResolvedValue([{}]);
    const res = await request(app).post('/api/servers/1/heartbeat').set('x-api-key', 'test-agent-key').send({ used_ram_mb: 512, used_cpu_cores: 1.5 });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/servers/:id/drain', () => {
  it('returns 404 for unknown server', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/api/servers/999/drain').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(404);
  });

  it('triggers drain for known server', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, hostname: 'vps-1' }]]);
    const res = await request(app).post('/api/servers/1/drain').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('DELETE /api/servers/:id', () => {
  it('returns 400 if server still has tenants', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, current_tenants: 2 }]]);
    const res = await request(app).delete('/api/servers/1').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(400);
  });

  it('deactivates server with no tenants', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, current_tenants: 0 }]]);
    db.query.mockResolvedValue([{}]);
    const res = await request(app).delete('/api/servers/1').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
