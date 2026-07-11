/**
 * Registry StorageService — env-based config, S3-first
 * Same pattern as cafe-backend/services/StorageService.js
 */
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const getDriver = () => (process.env.STORAGE_DRIVER || 's3').toLowerCase();

const _s3 = (() => {
  let client = null;
  return () => {
    if (!client) {
      client = new S3Client({
        endpoint: process.env.STORAGE_S3_ENDPOINT,
        region: process.env.STORAGE_S3_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.STORAGE_S3_KEY || '',
          secretAccessKey: process.env.STORAGE_S3_SECRET || '',
        },
        forcePathStyle: true,
      });
    }
    return client;
  };
})();

const bucket = () => process.env.STORAGE_S3_BUCKET || 'uploads';
const baseUrl = () => process.env.STORAGE_S3_URL || '';
const localBase = () => process.env.STORAGE_LOCAL_PATH || path.join(__dirname, '..', 'uploads');

async function uploadFile(namespace, filePath, buffer, contentType) {
  const key = namespace ? `${namespace}/${filePath}` : filePath;

  if (getDriver() === 's3') {
    await _s3().send(new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
      ACL: 'public-read',
    }));
    const url = `${baseUrl()}/${key}`;
    return { url, key, driver: 's3' };
  }

  // Local fallback
  const localPath = path.join(localBase(), key);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);
  return { url: `/uploads/${key}`, key, driver: 'local' };
}

async function getFile(namespace, filePath) {
  const key = namespace ? `${namespace}/${filePath}` : filePath;

  if (getDriver() === 's3') {
    const res = await _s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const buf = await res.Body.transformToByteArray();
    return { buffer: Buffer.from(buf), contentType: res.ContentType };
  }

  const localPath = path.join(localBase(), key);
  if (!fs.existsSync(localPath)) throw new Error('File tidak ditemukan');
  return { buffer: fs.readFileSync(localPath), contentType: 'application/octet-stream' };
}

async function deleteFile(namespace, filePath) {
  const key = namespace ? `${namespace}/${filePath}` : filePath;

  if (getDriver() === 's3') {
    await _s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    return { deleted: true };
  }

  const localPath = path.join(localBase(), key);
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  return { deleted: true };
}

async function listFiles(namespace, prefix = '') {
  const keyPrefix = namespace ? `${namespace}/${prefix}` : prefix;

  if (getDriver() === 's3') {
    const res = await _s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: keyPrefix }));
    return (res.Contents || []).map(o => ({ key: o.Key, size: o.Size, lastModified: o.LastModified }));
  }

  const localPath = path.join(localBase(), keyPrefix);
  if (!fs.existsSync(localPath)) return [];
  return fs.readdirSync(localPath).map(f => {
    const stat = fs.statSync(path.join(localPath, f));
    return { key: path.join(keyPrefix, f), size: stat.size, lastModified: stat.mtime };
  });
}

/**
 * Convenience: upload a base64 data URI directly
 * Returns the public URL
 */
async function uploadBase64(namespace, filename, dataUri) {
  const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid base64 data URI');
  const [, mime, b64] = matches;
  const buffer = Buffer.from(b64, 'base64');
  const result = await uploadFile(namespace, filename, buffer, mime);
  return result.url;
}

module.exports = { uploadFile, getFile, deleteFile, listFiles, uploadBase64, getDriver };
