jest.mock('../config/database');

const db = require('../config/database');
const { selectBestServer, updateServerResourceUsage, getAutoScaleConfig, getScalingOverview } = require('../services/server-manager');

describe('selectBestServer', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns the server with lowest usage for free tier', async () => {
    db.query.mockResolvedValueOnce([[{ id: 2, hostname: 'vps-2', total_ram_mb: 1024, used_ram_mb: 128, total_cpu_cores: 2, used_cpu_cores: 0.5, total_disk_mb: 10000, used_disk_mb: 500, current_tenants: 1, status: 'active' }, { id: 1, hostname: 'vps-1', total_ram_mb: 1024, used_ram_mb: 900, total_cpu_cores: 2, used_cpu_cores: 1, total_disk_mb: 10000, used_disk_mb: 2000, current_tenants: 5, status: 'active' }]]);
    const result = await selectBestServer('free');
    expect(result.id).toBe(2);
  });

  it('returns null when no server has enough free RAM', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, hostname: 'vps-1', total_ram_mb: 512, used_ram_mb: 500, total_cpu_cores: 2, used_cpu_cores: 0.5, total_disk_mb: 10000, used_disk_mb: 1000, current_tenants: 3, status: 'active' }]]);
    const result = await selectBestServer('starter');
    expect(result).toBeNull();
  });

  it('skips inactive servers', async () => {
    db.query.mockResolvedValueOnce([[{ id: 2, hostname: 'vps-2', total_ram_mb: 1024, used_ram_mb: 128, total_cpu_cores: 2, used_cpu_cores: 0.5, total_disk_mb: 10000, used_disk_mb: 500, current_tenants: 1, status: 'active' }, { id: 3, hostname: 'vps-3', total_ram_mb: 2048, used_ram_mb: 100, total_cpu_cores: 4, used_cpu_cores: 0.25, total_disk_mb: 20000, used_disk_mb: 200, current_tenants: 0, status: 'inactive' }]]);
    const result = await selectBestServer('free');
    expect(result.id).toBe(2);
    expect(result.hostname).toBe('vps-2');
  });

  it('returns the only available server when it has enough resources', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, hostname: 'vps-1', total_ram_mb: 2048, used_ram_mb: 512, total_cpu_cores: 4, used_cpu_cores: 1, total_disk_mb: 50000, used_disk_mb: 5000, current_tenants: 3, status: 'active' }]]);
    const result = await selectBestServer('business');
    expect(result).not.toBeNull();
    expect(result.id).toBe(1);
  });
});

describe('updateServerResourceUsage', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('increments resource usage', async () => {
    db.query.mockResolvedValue([{}]);
    await updateServerResourceUsage(1, 256, 0.5, 2000, 1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('used_ram_mb = GREATEST(used_ram_mb + ?, 0)'), [256, 0.5, 2000, 1, 1]);
  });

  it('decrements resource usage', async () => {
    db.query.mockResolvedValue([{}]);
    await updateServerResourceUsage(1, -128, -0.25, -500, -1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('GREATEST'), [-128, -0.25, -500, -1, 1]);
  });
});

describe('getAutoScaleConfig', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns config as key-value object', async () => {
    db.query.mockResolvedValueOnce([[{ config_key: 'ram_threshold_pct', config_value: '80' }, { config_key: 'max_servers', config_value: '10' }]]);
    const config = await getAutoScaleConfig();
    expect(config).toEqual({ ram_threshold_pct: '80', max_servers: '10' });
  });
});

describe('getScalingOverview', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns summary with correct counts', async () => {
    db.query.mockImplementation((query) => {
      if (query.includes('FROM servers')) return [[{ id: 1, hostname: 'vps-a', status: 'active', total_ram_mb: 1024, used_ram_mb: 512, total_cpu_cores: '2.0', used_cpu_cores: '0.5', total_disk_mb: 10000, used_disk_mb: 2000, max_tenants: 20, current_tenants: 2, region: 'sg', last_heartbeat: new Date(), created_at: new Date() }]];
      if (query.includes('GROUP BY server_id')) return [[{ server_id: 1, count: 2 }]];
      return [[]];
    });
    const result = await getScalingOverview();
    expect(result.summary.total).toBe(1);
    expect(result.summary.active).toBe(1);
    expect(result.servers[0].tenants).toBe(2);
  });

  it('handles empty server list', async () => {
    db.query.mockImplementation((query) => {
      if (query.includes('FROM servers')) return [[]];
      if (query.includes('GROUP BY server_id')) return [[]];
      return [[]];
    });
    const result = await getScalingOverview();
    expect(result.summary.total).toBe(0);
    expect(result.servers).toEqual([]);
  });
});
