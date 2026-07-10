/**
 * Unit tests for services/queue.js
 */

const mockQuery = jest.fn();
const mockGetConnection = jest.fn();

jest.mock('../config/database', () => {
  const pool = {
    query: mockQuery,
    getPool: () => pool,
    getConnection: mockGetConnection,
  };
  return pool;
});

// Reset between tests
beforeEach(() => {
  jest.clearAllMocks();
});

let q;
beforeAll(() => {
  q = require('../services/queue');
});

afterEach(() => {
  q.stopWorker();
  jest.clearAllMocks();
});

// ─── ensureTable ─────────────────────────────────────────────

describe('queue.ensureTable', () => {
  it('executes CREATE TABLE IF NOT EXISTS', async () => {
    mockQuery.mockResolvedValue([{}]);
    await q.ensureTable();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS job_queue'));
  });
});

// ─── enqueue ─────────────────────────────────────────────────

describe('queue.enqueue', () => {
  it('inserts a job with type and payload', async () => {
    mockQuery.mockResolvedValue([{ insertId: 42 }]);
    const id = await q.enqueue('email.welcome', { to: 'a@b.com', name: 'Test' });
    expect(id).toBe(42);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO job_queue'),
      expect.arrayContaining(['email.welcome', expect.any(String)])
    );
  });

  it('serialises payload as JSON string', async () => {
    mockQuery.mockResolvedValue([{ insertId: 1 }]);

    const payload = { to: 'x@y.com', amount: 50000 };
    await q.enqueue('email.topup_confirm', payload);
    const callArgs = mockQuery.mock.calls[0][1];
    const payloadArg = callArgs[1];
    expect(() => JSON.parse(payloadArg)).not.toThrow();
    expect(JSON.parse(payloadArg)).toMatchObject(payload);
  });

  it('respects custom runAt', async () => {
    mockQuery.mockResolvedValue([{ insertId: 5 }]);

    const future = new Date(Date.now() + 60_000);
    await q.enqueue('billing.daily_deduct', {}, { runAt: future });
    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs[2]).toEqual(future);
  });
});

// ─── register + processBatch ──────────────────────────────────

describe('queue.processBatch', () => {
  const makeConn = (jobs = []) => {
    const conn = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn()
        .mockResolvedValueOnce([jobs])   // SELECT FOR UPDATE
        .mockResolvedValue([{}]),        // subsequent UPDATEs
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    };
    mockGetConnection.mockResolvedValue(conn);
    return conn;
  };

  it('returns 0 when no pending jobs', async () => {
    const conn = makeConn([]);

    const n = await q.processBatch(10);
    expect(n).toBe(0);
    expect(conn.rollback).toHaveBeenCalled(); // no jobs → rollback
  });

  it('calls registered handler for matching job type', async () => {
    const job = { id: 1, type: 'test.job2', payload: JSON.stringify({ x: 1 }), attempts: 0, max_attempts: 3 };
    const conn = makeConn([job]);
    mockQuery.mockResolvedValue([{}]);


    const handler = jest.fn().mockResolvedValue(undefined);
    q.register('test.job2', handler);

    await q.processBatch(10);

    expect(handler).toHaveBeenCalledWith(
      { x: 1 },
      expect.objectContaining({ id: 1, type: 'test.job2' })
    );
  });

  it('marks job as failed when max attempts reached', async () => {
    const job = { id: 7, type: 'test.fail2', payload: '{}', attempts: 3, max_attempts: 3 };
    makeConn([job]);
    mockQuery.mockResolvedValue([{}]); // for UPDATE failed call

    q.register('test.fail2', jest.fn().mockRejectedValue(new Error('boom')));

    await q.processBatch(10);

    // db.query called to update job (error path uses status=? with 'failed' as param)
    const failCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE job_queue SET status=?') &&
      Array.isArray(c[1]) && c[1].includes('failed')
    );
    expect(failCall).toBeTruthy();
  });

  it('marks job as failed when no handler registered', async () => {
    const job = { id: 9, type: 'type.with.no.handler.xyz', payload: '{}', attempts: 0, max_attempts: 3 };
    makeConn([job]);
    mockQuery.mockResolvedValue([{}]); // for the UPDATE failed call

    await q.processBatch(10);

    // db.query (mockQuery) is called to set status=failed with error msg
    const failCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('failed')
    );
    expect(failCall).toBeTruthy();
  });
});

// ─── getStats ─────────────────────────────────────────────────

describe('queue.getStats', () => {
  it('returns stats keyed by status', async () => {
    mockQuery.mockResolvedValue([[
      { status: 'pending', cnt: '3' },
      { status: 'done', cnt: '10' },
      { status: 'failed', cnt: '1' },
    ]]);

    const stats = await q.getStats();
    expect(stats).toEqual({ pending: 3, done: 10, failed: 1 });
  });
});

// ─── retryFailed ─────────────────────────────────────────────

describe('queue.retryFailed', () => {
  it('resets failed jobs to pending and returns count', async () => {
    mockQuery.mockResolvedValue([{ affectedRows: 5 }]);

    const n = await q.retryFailed();
    expect(n).toBe(5);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status='pending'")
    );
  });
});

// ─── getHistory ───────────────────────────────────────────────

describe('queue.getHistory', () => {
  it('returns job list', async () => {
    const rows = [{ id: 1, type: 'email.welcome', status: 'done' }];
    mockQuery.mockResolvedValue([rows]);

    const jobs = await q.getHistory({ limit: 10 });
    expect(jobs).toEqual(rows);
  });

  it('filters by type when provided', async () => {
    mockQuery.mockResolvedValue([[]]);

    await q.getHistory({ limit: 5, type: 'email.welcome' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE type = ?'),
      expect.arrayContaining(['email.welcome'])
    );
  });
});

// ─── scheduleRecurring ────────────────────────────────────────

describe('queue.scheduleRecurring', () => {
  it('enqueues billing.daily_deduct if none pending for tomorrow', async () => {
    // First call: check existing daily job → empty
    // Second call: check warning job → empty
    // Third + fourth: enqueue calls
    mockQuery
      .mockResolvedValueOnce([[]])  // check daily job
      .mockResolvedValueOnce([[]])  // check warning job
      .mockResolvedValue([{ insertId: 1 }]); // enqueue calls


    await q.scheduleRecurring();

    const enqueueCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO job_queue')
    );
    const types = enqueueCalls.map(c => {
      const params = c[1];
      return params[0]; // type is first param
    });
    expect(types).toContain('billing.daily_deduct');
  });

  it('does not duplicate billing.daily_deduct if already pending', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 99 }]])  // daily job already exists
      .mockResolvedValueOnce([[]])             // warning check
      .mockResolvedValue([{ insertId: 1 }]);


    await q.scheduleRecurring();

    const enqueueCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO job_queue')
    );
    const types = enqueueCalls.map(c => c[1][0]);
    expect(types).not.toContain('billing.daily_deduct');
  });
});
