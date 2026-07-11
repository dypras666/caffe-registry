#!/usr/bin/env node
/**
 * Standalone database backup script — run via cron.
 * Usage: /opt/cafe-registry/scripts/backup-cron.js
 *
 * Depends on: @aws-sdk/client-s3 (from cafe-registry/node_modules)
 * Reads .env from /opt/cafe-registry/.env
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Load .env ─────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[1].includes('PASSWORD') ? m[2] : m[2].replace(/^["']|["']$/g, '');
  }
}

const required = ['DB_USER', 'DB_PASSWORD', 'STORAGE_S3_ENDPOINT', 'STORAGE_S3_KEY', 'STORAGE_S3_SECRET'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`[backup] Missing env: ${k}`);
    process.exit(1);
  }
}

const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require(
  path.join(__dirname, '..', 'node_modules', '@aws-sdk', 'client-s3')
);

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASSWORD;
const DB_SOCKET = process.env.DB_SOCKET || undefined;
const BUCKET = process.env.STORAGE_S3_BUCKET || 'uploads';
const PREFIX = 'backups/database/';
const RETENTION_DAYS = 30;

const s3 = new S3Client({
  endpoint: process.env.STORAGE_S3_ENDPOINT,
  region: process.env.STORAGE_S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.STORAGE_S3_KEY,
    secretAccessKey: process.env.STORAGE_S3_SECRET,
  },
  forcePathStyle: true,
});

function run(cmd) {
  return execSync(cmd, { shell: '/bin/bash', timeout: 600000, maxBuffer: 500 * 1024 * 1024 }).toString();
}

function getDatabases() {
  const socket = DB_SOCKET ? `--socket=${DB_SOCKET}` : `-h ${DB_HOST}`;
  const port = process.env.DB_PORT || '3306';
  const cmd = `MYSQL_PWD="${DB_PASS.replace(/"/g, '\\"')}" mysql ${socket} -u ${DB_USER} -P ${port} -e "SHOW DATABASES" 2>/dev/null`;
  const output = run(cmd);
  const exclude = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'Database']);
  return output.trim().split('\n').filter(d => !exclude.has(d.trim())).map(d => d.trim());
}

async function uploadToS3(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer, ContentType: 'application/gzip',
  }));
}

async function cleanupOld() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
  let count = 0;
  for (const obj of (resp.Contents || [])) {
    if (obj.LastModified < cutoff) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
      count++;
    }
  }
  return count;
}

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dbs = getDatabases();
  console.log(`[backup] ${dbs.length} database(s) found: ${dbs.join(', ')}`);

  let success = 0;

  for (const db of dbs) {
    const filename = `${db}_${timestamp}.sql.gz`;
    const key = `${PREFIX}${filename}`;
    const tmpPath = `/tmp/${filename}`;

    try {
      const socket = DB_SOCKET ? `--socket=${DB_SOCKET}` : `-h ${DB_HOST}`;
      const port = process.env.DB_PORT || '3306';
      const dumpCmd = `MYSQL_PWD="${DB_PASS.replace(/"/g, '\\"')}" mysqldump ${socket} -u ${DB_USER} -P ${port} --single-transaction --quick --compress ${db} 2>/dev/null | gzip > ${tmpPath}`;
      run(dumpCmd);

      const buffer = fs.readFileSync(tmpPath);
      await uploadToS3(key, buffer);
      fs.unlinkSync(tmpPath);

      const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
      console.log(`[backup] ✓ ${db} → ${key} (${sizeMB} MB)`);
      success++;
    } catch (e) {
      console.error(`[backup] ✗ ${db}: ${e.message}`);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  const deleted = await cleanupOld();
  console.log(`[backup] Done: ${success}/${dbs.length} databases, ${deleted} old backups cleaned`);
  process.exit(success > 0 ? 0 : 1);
}

main().catch(e => { console.error('[backup] Fatal:', e.message); process.exit(1); });
