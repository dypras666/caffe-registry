const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const _getLocalPath = () => process.env.STORAGE_LOCAL_PATH || '/opt/cafe-registry/uploads';

let s3Client = null;

async function getConfig() {
  try {
    const db = require('../config/database');
    const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 's3_%'");
    const cfg = {};
    for (const r of rows) cfg[r.setting_key] = r.setting_value;
    return cfg;
  } catch {
    return {};
  }
}

function getS3Client(config) {
  if (s3Client) return s3Client;

  const endpoint = config.s3_endpoint || process.env.S3_ENDPOINT;
  const region = config.s3_region || process.env.S3_REGION || 'auto';
  const accessKey = config.s3_access_key || process.env.S3_ACCESS_KEY;
  const secretKey = config.s3_secret_key || process.env.S3_SECRET_KEY;

  s3Client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  return s3Client;
}

async function getDriver() {
  const db = require('../config/database');
  const [rows] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'storage_driver'");
  return rows.length ? rows[0].setting_value : 'local';
}

async function uploadFile(tenantSlug, filePath, buffer, contentType) {
  const driver = await getDriver();
  const key = `${tenantSlug}/${filePath}`;

  if (driver === 's3') {
    const config = await getConfig();
    const client = getS3Client(config);
    const bucket = config.s3_bucket || 'cafe-azzura';

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    }));

    const endpoint = config.s3_endpoint || '';
    const publicUrl = endpoint ? `${endpoint}/${bucket}/${key}` : `/api/storage/${key}`;
    return { url: publicUrl, key, driver: 's3' };
  }

  // Local fallback
  const localPath = path.join(_getLocalPath(), key);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);
  return { url: `/api/storage/${key}`, key, driver: 'local' };
}

async function getFile(tenantSlug, filePath) {
  const driver = await getDriver();
  const key = `${tenantSlug}/${filePath}`;

  if (driver === 's3') {
    const config = await getConfig();
    const client = getS3Client(config);
    const bucket = config.s3_bucket || 'cafe-azzura';

    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buffer = await response.Body.transformToByteArray();
    return { buffer: Buffer.from(buffer), contentType: response.ContentType };
  }

  const localPath = path.join(_getLocalPath(), key);
  if (!fs.existsSync(localPath)) throw new Error('File tidak ditemukan');
  return { buffer: fs.readFileSync(localPath), contentType: 'application/octet-stream' };
}

async function deleteFile(tenantSlug, filePath) {
  const driver = await getDriver();
  const key = `${tenantSlug}/${filePath}`;

  if (driver === 's3') {
    const config = await getConfig();
    const client = getS3Client(config);
    const bucket = config.s3_bucket || 'cafe-azzura';
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { deleted: true };
  }

  const localPath = path.join(_getLocalPath(), key);
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  return { deleted: true };
}

async function listFiles(tenantSlug, prefix = '') {
  const driver = await getDriver();
  const keyPrefix = tenantSlug ? `${tenantSlug}/${prefix}` : prefix;

  if (driver === 's3') {
    const config = await getConfig();
    const client = getS3Client(config);
    const bucket = config.s3_bucket || 'cafe-azzura';

    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: keyPrefix,
    }));

    return (response.Contents || []).map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
    }));
  }

  const localPath = path.join(_getLocalPath(), keyPrefix);
  if (!fs.existsSync(localPath)) return [];
  return fs.readdirSync(localPath).map(f => {
    const stat = fs.statSync(path.join(localPath, f));
    return { key: path.join(keyPrefix, f), size: stat.size, lastModified: stat.mtime };
  });
}

module.exports = { uploadFile, getFile, deleteFile, listFiles, getDriver };
