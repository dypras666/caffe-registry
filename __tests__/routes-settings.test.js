jest.mock('../config/database');
jest.mock('jsonwebtoken', () => {
  const actual = jest.requireActual('jsonwebtoken');
  return { ...actual, verify: jest.fn() };
});
jest.mock('../services/email', () => ({ sendMail: jest.fn().mockResolvedValue({ sent: true }), invalidateCache: jest.fn() }));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const settingsRouter = require('../routes/settings');

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);

const mockToken = 'mock-token';
beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: 1, email: 'admin@test.com', role: 'superadmin' });
});

describe('GET /api/settings', () => {
  it('returns all settings keyed by name', async () => {
    db.query.mockResolvedValue([[{ setting_key: 'app_name', setting_value: 'Cafe Azzura', description: 'App name' }, { setting_key: 'smtp_host', setting_value: 'smtp.test.com', description: 'SMTP host' }]]);
    const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.app_name.value).toBe('Cafe Azzura');
    expect(res.body.smtp_host.description).toBe('SMTP host');
  });
});

describe('PUT /api/settings', () => {
  it('updates multiple settings', async () => {
    db.query.mockResolvedValue([{}]);
    const res = await request(app).put('/api/settings').set('Authorization', `Bearer ${mockToken}`).send({ app_name: 'Test Cafe', smtp_host: 'mail.test.com' });
    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/settings/templates', () => {
  it('lists templates', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'welcome.html', subject: 'Welcome', html_preview: '<html>...', updated_at: new Date() }]]);
    const res = await request(app).get('/api/settings/templates').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
  });
});

describe('GET /api/settings/templates/:name', () => {
  it('returns full template', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'welcome.html', subject: 'Welcome', html: '<html>...</html>' }]]);
    const res = await request(app).get('/api/settings/templates/welcome.html').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(200);
    expect(res.body.html).toBe('<html>...</html>');
  });

  it('returns 404 for missing template', async () => {
    db.query.mockResolvedValue([[]]);
    const res = await request(app).get('/api/settings/templates/unknown.html').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/settings/templates/:name', () => {
  it('updates template subject and html', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }]]);
    db.query.mockResolvedValueOnce([{}]);
    const res = await request(app).put('/api/settings/templates/welcome.html').set('Authorization', `Bearer ${mockToken}`).send({ subject: 'New Subject', html: '<p>New</p>' });
    expect(res.status).toBe(200);
  });

  it('returns 404 for missing template', async () => {
    db.query.mockResolvedValue([[]]);
    const res = await request(app).put('/api/settings/templates/nope.html').set('Authorization', `Bearer ${mockToken}`).send({ subject: 'Nope' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/settings/templates/:name/test', () => {
  it('sends a test email', async () => {
    const res = await request(app).post('/api/settings/templates/welcome.html/test').set('Authorization', `Bearer ${mockToken}`).send({ to: 'test@test.com' });
    expect(res.status).toBe(200);
  });

  it('rejects missing email', async () => {
    const res = await request(app).post('/api/settings/templates/welcome.html/test').set('Authorization', `Bearer ${mockToken}`).send({});
    expect(res.status).toBe(400);
  });
});

describe('auth guard', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-superadmin role', async () => {
    jwt.verify.mockReturnValue({ id: 1, email: 'user@test.com', role: 'user' });
    const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${mockToken}`);
    expect(res.status).toBe(403);
  });
});
