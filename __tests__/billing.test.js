jest.mock('../config/database');
jest.mock('../services/email', () => ({ sendMail: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/provisioner', () => ({ sshRun: jest.fn(), provisionTenant: jest.fn() }));

const db = require('../config/database');
const { processTenantBilling, topUpBalance, getBillingStatus, checkBilling } = require('../services/billing');

describe('processTenantBilling', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('suspends active tenant with balance <= 0', async () => {
    const tenant = { id: 1, slug: 'test-cafe', name: 'Test Cafe', status: 'active', balance: 0, auto_suspend: 1, pricing_tier: 'starter', server_id: 1, container_id: 'abc', admin_email: 'a@b.com', last_balance_warning: null };
    db.query.mockResolvedValue([{}]);
    db.query.mockResolvedValueOnce([[{ id: 1, hostname: 'vps-1', ip_address: '10.0.0.1', ssh_user: 'root', ssh_password: 'pass' }]]);
    const { sshRun } = require('../services/provisioner');
    sshRun.mockReturnValue('');
    const { sendMail } = require('../services/email');

    await processTenantBilling(tenant);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'suspended'"), [1]);
  });

  it('reactivates suspended tenant with positive balance', async () => {
    const tenant = { id: 1, slug: 'test-cafe', name: 'Test Cafe', status: 'suspended', balance: 5000, auto_suspend: 1, pricing_tier: 'starter', server_id: 1, container_id: null, admin_email: 'a@b.com', last_balance_warning: null };
    db.query.mockResolvedValue([[{ id: 1, name: 'Test Cafe' }]]);
    db.query.mockResolvedValueOnce([{}]);

    await processTenantBilling(tenant);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'active'"), [1]);
  });

  it('does nothing for active tenant with sufficient balance', async () => {
    const tenant = { id: 1, slug: 'test-cafe', status: 'active', balance: 50000, auto_suspend: 1, pricing_tier: 'starter', last_balance_warning: new Date() };
    const initialCalls = db.query.mock.calls.length;
    await processTenantBilling(tenant);
    expect(db.query.mock.calls.length).toBe(initialCalls);
  });

  it('skips tenant without auto_suspend', async () => {
    const tenant = { id: 1, slug: 'test-cafe', status: 'active', balance: 0, auto_suspend: 0, pricing_tier: 'starter', last_balance_warning: null };
    const initialCalls = db.query.mock.calls.length;
    await processTenantBilling(tenant);
    expect(db.query.mock.calls.length).toBe(initialCalls);
  });
});

describe('topUpBalance', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('adds balance to tenant', async () => {
    db.query.mockResolvedValueOnce([[{ affectedRows: 1 }]]);
    db.query.mockResolvedValueOnce([[{ id: 1, name: 'Test', slug: 'test', balance: 15000, status: 'active' }]]);
    const result = await topUpBalance(1, 10000);
    expect(result.balance).toBe(15000);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('balance = balance + ?'), [10000, 1]);
  });

  it('rejects non-positive amount', async () => {
    await expect(topUpBalance(1, -500)).rejects.toThrow('Jumlah top up harus lebih dari 0');
  });

  it('rejects zero amount', async () => {
    await expect(topUpBalance(1, 0)).rejects.toThrow('Jumlah top up harus lebih dari 0');
  });
});

describe('getBillingStatus', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns billing info including days left', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'Test', slug: 'test', status: 'active', balance: 5000, auto_suspend: 1, suspended_at: null, pricing_tier: 'starter' }]]);
    const result = await getBillingStatus(1);
    expect(result.daily_cost).toBe(1000);
    expect(result.days_left).toBe(5);
    expect(result.is_suspended).toBe(false);
  });

  it('shows suspended tenant correctly', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'Test', slug: 'test', status: 'suspended', balance: 0, auto_suspend: 1, suspended_at: new Date(), pricing_tier: 'free' }]]);
    const result = await getBillingStatus(1);
    expect(result.is_suspended).toBe(true);
    expect(result.needs_recharge).toBe(true);
  });

  it('throws for unknown tenant', async () => {
    db.query.mockResolvedValue([[]]);
    await expect(getBillingStatus(999)).rejects.toThrow('Tenant tidak ditemukan');
  });
});
