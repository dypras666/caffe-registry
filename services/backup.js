const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { execSync } = require('child_process');
const db = require('../config/database');
const fs = require('fs');

const BACKUP_PREFIX = 'backups/database/';
const RETENTION_DAYS = 30;

let _s3 = null;
function getS3() {
  if (_s3) return _s3;
  _s3 = new S3Client({
    endpoint: process.env.STORAGE_S3_ENDPOINT,
    region: process.env.STORAGE_S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.STORAGE_S3_KEY || '',
      secretAccessKey: process.env.STORAGE_S3_SECRET || '',
    },
    forcePathStyle: true,
  });
  return _s3;
}

function getDumpCmd(dbName, socket) {
  const user = process.env.DB_USER || 'root';
  const pass = process.env.DB_PASSWORD || 'CafeAzzura2024';
  const host = process.env.DB_HOST || (socket ? undefined : '127.0.0.1');
  let cmd = `MYSQL_PWD="${pass.replace(/"/g, '\\"')}" mysqldump`;
  if (socket) cmd += ` --socket=${socket}`;
  else if (host) cmd += ` -h ${host}`;
  const port = process.env.DB_PORT;
  if (port && !socket) cmd += ` -P ${port}`;
  cmd += ` -u ${user} --single-transaction --quick --compress ${dbName} 2>/dev/null`;
  return cmd;
}

async function runBackup() {
  const s3 = getS3();
  const bucket = process.env.STORAGE_S3_BUCKET || 'uploads';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const socket = process.env.DB_SOCKET || undefined;

  const [rows] = await db.query("SHOW DATABASES");
  const exclude = new Set(['information_schema','performance_schema','mysql','sys']);
  const dbs = rows.map(r => r.Database).filter(d => !exclude.has(d));

  const results = [];

  for (const database of dbs) {
    const filename = `${database}_${timestamp}.sql.gz`;
    const key = `${BACKUP_PREFIX}${filename}`;
    const tmpPath = `/tmp/${filename}`;

    try {
      const cmd = `${getDumpCmd(database, socket)} | gzip > ${tmpPath}`;
      execSync(cmd, { shell: '/bin/bash', timeout: 600000, maxBuffer: 500 * 1024 * 1024 });
      const buffer = fs.readFileSync(tmpPath);

      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: 'application/gzip',
      }));

      results.push({ database, key, size: buffer.length, success: true });
      fs.unlinkSync(tmpPath);
    } catch (e) {
      results.push({ database, key, success: false, error: e.message });
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  const deleted = await cleanupOldBackups(s3, bucket);
  return { timestamp, databases: results, total: results.length, success_count: results.filter(r => r.success).length, deleted };
}

async function listBackups() {
  const s3 = getS3();
  const bucket = process.env.STORAGE_S3_BUCKET || 'uploads';
  const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: BACKUP_PREFIX }));
  return (response.Contents || []).map(obj => ({
    key: obj.Key,
    database: obj.Key.split('/').pop()?.split('_')[0] || 'unknown',
    filename: obj.Key.split('/').pop(),
    size: obj.Size,
    lastModified: obj.LastModified,
  })).sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
}

async function cleanupOldBackups(s3, bucket) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: BACKUP_PREFIX }));
  const toDelete = (response.Contents || []).filter(obj => obj.LastModified < cutoff);
  let deletedCount = 0;
  for (const obj of toDelete) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
      deletedCount++;
    } catch (_) {}
  }
  return deletedCount;
}

module.exports = { runBackup, listBackups };
