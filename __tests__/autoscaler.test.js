jest.mock('../config/database');
jest.mock('../services/server-manager', () => ({
  ...jest.requireActual('../services/server-manager'),
  getAutoScaleConfig: jest.fn(),
}));

const db = require('../config/database');
const { getAutoScaleConfig } = require('../services/server-manager');
const { checkScaling, triggerScaleUp, startAutoScaler, stopAutoScaler } = require('../services/autoscaler');

describe('checkScaling', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('marks server inactive when heartbeat is stale', async () => {
    const staleDate = new Date(Date.now() - 600_000);
    getAutoScaleConfig.mockResolvedValue({
      ram_threshold_pct: '80',
      cpu_threshold_pct: '75',
      disk_threshold_pct: '85',
      max_tenants_per_server: '20',
      max_servers: '10',
      scale_cooldown_minutes: '30',
      heartbeat_timeout_seconds: '300',
      auto_drain_hours: '24',
      drain_usage_below_pct: '20',
    });
    db.query.mockImplementation(async (query, params) => {
      if (query.includes('FROM servers WHERE')) return [[{ id: 1, hostname: 'vps-1', status: 'active', total_ram_mb: 1024, used_ram_mb: 300, total_cpu_cores: 2, used_cpu_cores: 0.5, total_disk_mb: 10000, used_disk_mb: 1000, current_tenants: 2, max_tenants: 20, last_heartbeat: staleDate, created_at: new Date() }]];
      if (query.includes("WHERE status = 'active' AND")) return [[{ count: 3 }]];
      if (query.includes('UPDATE')) return [{}];
      if (query.includes('SELECT COUNT')) return [[{ count: 0 }]];
      return [[]];
    });
    await checkScaling();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'inactive'"), [1]);
  });

  it('does not mark server if heartbeat is fresh', async () => {
    const freshDate = new Date();
    getAutoScaleConfig.mockResolvedValue({
      ram_threshold_pct: '80',
      cpu_threshold_pct: '75',
      disk_threshold_pct: '85',
      max_tenants_per_server: '20',
      max_servers: '10',
      scale_cooldown_minutes: '30',
      heartbeat_timeout_seconds: '300',
      auto_drain_hours: '24',
      drain_usage_below_pct: '20',
    });
    let updateCalled = false;
    db.query.mockImplementation(async (query, params) => {
      if (query.includes('FROM servers WHERE')) return [[{ id: 1, hostname: 'vps-1', status: 'active', total_ram_mb: 1024, used_ram_mb: 300, total_cpu_cores: 2, used_cpu_cores: 0.5, total_disk_mb: 10000, used_disk_mb: 1000, current_tenants: 2, max_tenants: 20, last_heartbeat: freshDate, created_at: new Date() }]];
      if (query.includes("WHERE status = 'active' AND")) return [[{ count: 3 }]];
      if (query.includes('UPDATE')) { updateCalled = true; return [{}]; }
      if (query.includes('SELECT COUNT')) return [[{ count: 0 }]];
      return [[]];
    });
    await checkScaling();
    expect(updateCalled).toBe(false);
  });
});

describe('triggerScaleUp', () => {
  it('returns triggered status', async () => {
    const result = await triggerScaleUp({});
    expect(result.triggered).toBe(true);
  });
});

describe('startAutoScaler / stopAutoScaler', () => {
  it('sets and clears interval', () => {
    jest.useFakeTimers();
    startAutoScaler();
    expect(jest.getTimerCount()).toBe(1);
    stopAutoScaler();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
