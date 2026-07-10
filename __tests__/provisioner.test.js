jest.mock('../config/database');
jest.mock('child_process');
jest.mock('../services/server-manager', () => ({
  selectBestServer: jest.fn(),
  updateServerResourceUsage: jest.fn(),
}));

const { execSync } = require('child_process');
const db = require('../config/database');
const serverManager = require('../services/server-manager');
const { checkAvailability, provisionTenant } = require('../services/provisioner');

describe('checkAvailability', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns available for unused slug', async () => {
    db.query.mockResolvedValue([[]]);
    const result = await checkAvailability('my-cafe');
    expect(result.available).toBe(true);
    expect(result.slug).toBe('my-cafe');
  });

  it('returns unavailable for taken slug', async () => {
    db.query.mockResolvedValue([[{ id: 1 }]]);
    const result = await checkAvailability('taken-cafe');
    expect(result.available).toBe(false);
  });

  it('returns unavailable for reserved slug', async () => {
    db.query.mockResolvedValue([[]]);
    const result = await checkAvailability('www');
    expect(result.available).toBe(false);
  });

  it('returns unavailable for system reserved slug', async () => {
    const result = await checkAvailability('admin');
    expect(result.available).toBe(false);
  });
});

describe('provisionTenant', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('fails if tenant not found', async () => {
    db.query.mockResolvedValue([[]]);
    await expect(provisionTenant(999, 'nonexistent', 'a@b.com', 'pass123')).rejects.toThrow('Tenant not found');
  });

  it('selects best server and completes provisioning', async () => {
    const mockTenant = { id: 1, name: 'Test Cafe', pricing_tier: 'free', ram_mb: 64, cpu_cores: 0.25 };
    const mockServer = { id: 2, hostname: 'vps-2', ip_address: '10.0.0.2', ssh_user: 'root', ssh_key_path: '~/.ssh/id_rsa' };

    db.query.mockImplementation(async (query, params) => {
      if (query.includes('SELECT * FROM tenants')) return [[mockTenant]];
      if (query.includes('SELECT MAX(backend_port)')) return [[{ maxPort: 3200 }]];
      if (query.includes('UPDATE tenants SET server_id')) return [{}];
      if (query.includes('UPDATE tenants SET backend_port')) return [{}];
      if (query.includes("UPDATE tenants SET status='active'")) return [{}];
      if (query.includes('UPDATE tenants SET container_id')) return [{}];
      return [[]];
    });

    serverManager.selectBestServer.mockResolvedValue(mockServer);
    execSync.mockReturnValue('container-id-123\n');

    await provisionTenant(1, 'test-cafe', 'admin@test.com', 'password123');

    expect(serverManager.selectBestServer).toHaveBeenCalledWith('free');
    expect(execSync).toHaveBeenCalled();
  });
});
