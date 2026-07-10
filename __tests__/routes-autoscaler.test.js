jest.mock('../config/database');
jest.mock('jsonwebtoken');

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const autoscalerRouter = require('../routes/autoscaler');

const app = express();
app.use(express.json());
app.use('/api/autoscaler', autoscalerRouter);

const mockToken = 'mock-token';
beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: 1, email: 'admin@test.com', role: 'superadmin' });
});

describe('GET /api/autoscaler/config', () => {
  it('returns config as object', async () => {
    db.query.mockResolvedValue([[{ config_key: 'ram_threshold_pct', config_value: '80' }, { config_key: 'max_servers', config_value: '10' }]]);
    const res = await request(app).get('/api/autoscaler/config').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ram_threshold_pct).toBe('80');
  });
});

describe('PUT /api/autoscaler/config', () => {
  it('upserts config values', async () => {
    db.query.mockImplementation(async (query, params) => {
      if (query.includes('ON DUPLICATE KEY')) return [{}];
      return [[]];
    });
    const res = await request(app).put('/api/autoscaler/config').set('Authorization', `Bearer ${mockToken}`).send({ max_servers: '15', min_servers: '2' });
    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/autoscaler/status', () => {
  it('returns overview with summary', async () => {
    db.query.mockImplementation(async (query) => {
      if (query.includes('FROM servers')) return [[{ id: 1, hostname: 'vps-1', status: 'active', total_ram_mb: 1024, used_ram_mb: 512, total_cpu_cores: '2.0', used_cpu_cores: '0.5', total_disk_mb: 10000, used_disk_mb: 2000, max_tenants: 20, last_heartbeat: new Date(), region: 'sg', created_at: new Date() }, { id: 2, hostname: 'vps-2', status: 'draining', total_ram_mb: 2048, used_ram_mb: 256, total_cpu_cores: '4.0', used_cpu_cores: '1.0', total_disk_mb: 50000, used_disk_mb: 5000, max_tenants: 30, last_heartbeat: null, region: 'us', created_at: new Date() }]];
      if (query.includes('GROUP BY server_id')) return [[{ server_id: 1, count: 3 }]];
      return [[]];
    });
    const res = await request(app).get('/api/autoscaler/status').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.active).toBe(1);
    expect(res.body.summary.draining).toBe(1);
    expect(res.body.servers[0].tenants).toBe(3);
  });
});
