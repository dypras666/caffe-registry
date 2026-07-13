/**
 * DB-backed job queue for cafe-registry
 *
 * Jobs are stored in `job_queue` table and processed by a polling loop.
 * No Redis needed — works with existing MySQL.
 *
 * Job types:
 *   email.welcome          — send welcome email on tenant registration
 *   email.forgot_password  — send reset password link
 *   email.topup_confirm    — confirm topup success
 *   email.balance_warning  — warn low balance (3 days left)
 *   email.suspended        — account suspended due to zero balance
 *   email.expiry_reminder  — subscription expiring soon
 *   email.login_info       — send login credentials
 *   billing.daily_deduct   — deduct daily cost from all tenants
 *   billing.check_warnings — scan and send low-balance warnings
 */

const db = require('../config/database');

// ─── Schema init ─────────────────────────────────────────────
async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      type        VARCHAR(100) NOT NULL,
      payload     JSON NOT NULL,
      status      ENUM('pending','processing','done','failed') DEFAULT 'pending',
      attempts    INT DEFAULT 0,
      max_attempts INT DEFAULT 3,
      run_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at  DATETIME NULL,
      done_at     DATETIME NULL,
      error       TEXT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status_run (status, run_at),
      INDEX idx_type (type)
    ) ENGINE=InnoDB
  `);
}

// ─── Enqueue ──────────────────────────────────────────────────
async function enqueue(type, payload, { runAt = null, maxAttempts = 3 } = {}) {
  const run = runAt ? new Date(runAt) : new Date();
  const [r] = await db.query(
    'INSERT INTO job_queue (type, payload, run_at, max_attempts) VALUES (?, ?, ?, ?)',
    [type, JSON.stringify(payload), run, maxAttempts]
  );
  return r.insertId;
}

// ─── Worker: claim + process one batch ───────────────────────
const handlers = {};

function register(type, fn) {
  handlers[type] = fn;
}

async function processBatch(batchSize = 10) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // Claim pending jobs that are due
    const [jobs] = await conn.query(
      `SELECT * FROM job_queue
       WHERE status = 'pending' AND run_at <= NOW()
       ORDER BY run_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );

    if (!jobs.length) { await conn.rollback(); return 0; }

    const ids = jobs.map(j => j.id);
    await conn.query(
      `UPDATE job_queue SET status='processing', started_at=NOW(), attempts=attempts+1 WHERE id IN (?)`,
      [ids]
    );
    await conn.commit();

    // Process outside transaction
    let processed = 0;
    for (const job of jobs) {
      const handler = handlers[job.type];
      if (!handler) {
        await db.query(
          "UPDATE job_queue SET status='failed', done_at=NOW(), error=? WHERE id=?",
          [`No handler for type: ${job.type}`, job.id]
        );
        continue;
      }

      try {
        const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
        const timeoutMs = 30000; // 30s max per job handler
        await Promise.race([
          handler(payload, job),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Handler timeout')), timeoutMs)),
        ]);
        await db.query(
          "UPDATE job_queue SET status='done', done_at=NOW() WHERE id=?",
          [job.id]
        );
        processed++;
      } catch (err) {
        console.error(`[Queue] Job ${job.id} (${job.type}) failed:`, err.message);
        const failed = job.attempts >= job.max_attempts;
        await db.query(
          `UPDATE job_queue SET status=?, done_at=?, error=?,
           run_at = CASE WHEN ? THEN run_at ELSE DATE_ADD(NOW(), INTERVAL ? SECOND) END
           WHERE id=?`,
          [
            failed ? 'failed' : 'pending',
            failed ? new Date() : null,
            err.message,
            failed, failed ? 0 : Math.pow(2, job.attempts) * 30, // exponential backoff
            job.id,
          ]
        );
      }
    }
    return processed;
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[Queue] processBatch error:', err.message);
    return 0;
  } finally {
    conn.release();
  }
}

// ─── Polling loop ─────────────────────────────────────────────
let _pollTimer = null;

function startWorker({ intervalMs = 10000, batchSize = 10 } = {}) {
  if (_pollTimer) return;
  console.log(`[Queue] Worker started (poll every ${intervalMs}ms)`);

  const tick = async () => {
    try {
      const n = await processBatch(batchSize);
      if (n > 0) console.log(`[Queue] Processed ${n} job(s)`);
    } catch (e) {
      console.error('[Queue] tick error:', e.message);
    }
  };

  tick(); // immediate first run
  _pollTimer = setInterval(tick, intervalMs);
}

function stopWorker() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ─── Scheduled jobs (cron-like) ───────────────────────────────
// Called once at startup — idempotent via run_at
async function scheduleRecurring() {
  // Daily billing deduction — runs at midnight
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 1, 0);

  // Only enqueue if no pending daily job for tomorrow
  const [existing] = await db.query(
    "SELECT id FROM job_queue WHERE type='billing.daily_deduct' AND status='pending' AND DATE(run_at)=DATE(?)",
    [tomorrow]
  );
  if (!existing.length) {
    await enqueue('billing.daily_deduct', {}, { runAt: tomorrow });
    console.log('[Queue] Scheduled billing.daily_deduct for', tomorrow.toISOString());
  }

  // Balance warning check — every 6 hours
  const [warn] = await db.query(
    "SELECT id FROM job_queue WHERE type='billing.check_warnings' AND status='pending' AND run_at > NOW()"
  );
  if (!warn.length) {
    const in6h = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await enqueue('billing.check_warnings', {}, { runAt: in6h });
  }

  // BCA mutation scan — every 5 minutes (only if pending topup requests exist today)
  const [bcaScan] = await db.query(
    "SELECT id FROM job_queue WHERE type='bca.scan_topup' AND status='pending' AND run_at > NOW()"
  );
  if (!bcaScan.length) {
    const in5m = new Date(Date.now() + 5 * 60 * 1000);
    await enqueue('bca.scan_topup', {}, { runAt: in5m, maxAttempts: 1 });
  }

}

// ─── Queue stats ──────────────────────────────────────────────
async function getStats() {
  const [rows] = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM job_queue GROUP BY status`
  );
  return rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.cnt) }), {});
}

async function getHistory({ limit = 50, type = null } = {}) {
  let sql = 'SELECT id, type, status, attempts, run_at, done_at, error, created_at FROM job_queue';
  const params = [];
  if (type) { sql += ' WHERE type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const [rows] = await db.query(sql, params);
  return rows;
}

async function retryFailed() {
  const [r] = await db.query(
    "UPDATE job_queue SET status='pending', attempts=0, run_at=NOW(), error=NULL WHERE status='failed'"
  );
  return r.affectedRows;
}

module.exports = {
  ensureTable, enqueue, register,
  processBatch, // exported for unit testing
  startWorker, stopWorker,
  scheduleRecurring,
  getStats, getHistory, retryFailed,
};
