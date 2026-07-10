jest.mock('../config/database', () => ({
  query: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({
      Body: { transformToByteArray: jest.fn().mockResolvedValue(new Uint8Array([116, 101, 115, 116])) },
      ContentType: 'text/plain',
      Contents: [{ Key: 'test/file.txt', Size: 100, LastModified: new Date() }],
    }),
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { uploadFile, getFile, deleteFile, listFiles, getDriver } = require('../services/storage');

process.env.STORAGE_LOCAL_PATH = '/tmp/storage-test';
const DB_PATH = process.env.STORAGE_LOCAL_PATH;

beforeEach(() => {
  jest.clearAllMocks();
  try { fs.rmSync(DB_PATH, { recursive: true, force: true }); } catch (_) {}
});

afterAll(() => {
  try { fs.rmSync(DB_PATH, { recursive: true, force: true }); } catch (_) {}
});

describe('getDriver', () => {
  it('returns local driver by default', async () => {
    db.query.mockResolvedValue([[]]);
    const driver = await getDriver();
    expect(driver).toBe('local');
  });

  it('returns s3 when configured', async () => {
    db.query.mockResolvedValue([[{ setting_value: 's3' }]]);
    const driver = await getDriver();
    expect(driver).toBe('s3');
  });
});

describe('uploadFile (local)', () => {
  it('saves file to local disk', async () => {
    db.query.mockResolvedValue([[]]);
    const result = await uploadFile('tenant-slug', 'images/logo.png', Buffer.from('test'), 'image/png');
    expect(result.driver).toBe('local');
    expect(result.key).toBe('tenant-slug/images/logo.png');
    expect(fs.existsSync(path.join(DB_PATH, 'tenant-slug/images/logo.png'))).toBe(true);
  });
});

describe('getFile (local)', () => {
  it('reads file from local disk', async () => {
    db.query.mockResolvedValue([[]]);
    await uploadFile('tenant-slug', 'test.txt', Buffer.from('hello'), 'text/plain');
    const result = await getFile('tenant-slug', 'test.txt');
    expect(result.buffer.toString()).toBe('hello');
  });

  it('throws for missing file', async () => {
    db.query.mockResolvedValue([[]]);
    await expect(getFile('tenant-slug', 'nope.txt')).rejects.toThrow('File tidak ditemukan');
  });
});

describe('deleteFile (local)', () => {
  it('deletes file from disk', async () => {
    db.query.mockResolvedValue([[]]);
    await uploadFile('tenant-slug', 'delete.txt', Buffer.from('bye'), 'text/plain');
    const before = fs.existsSync(path.join(DB_PATH, 'tenant-slug/delete.txt'));
    await deleteFile('tenant-slug', 'delete.txt');
    const after = fs.existsSync(path.join(DB_PATH, 'tenant-slug/delete.txt'));
    expect(before).toBe(true);
    expect(after).toBe(false);
  });
});

describe('listFiles (local)', () => {
  it('returns files for tenant', async () => {
    db.query.mockResolvedValue([[]]);
    await uploadFile('tenant-slug', 'a.txt', Buffer.from('a'));
    await uploadFile('tenant-slug', 'b.txt', Buffer.from('b'));
    const files = await listFiles('tenant-slug');
    expect(files).toHaveLength(2);
    expect(files.map(f => f.key)).toContain('tenant-slug/a.txt');
    expect(files.map(f => f.key)).toContain('tenant-slug/b.txt');
  });

  it('returns empty array for missing prefix', async () => {
    db.query.mockResolvedValue([[]]);
    const files = await listFiles('nonexistent');
    expect(files).toEqual([]);
  });
});

describe('uploadFile (s3)', () => {
  it('uploads to S3 when driver is s3', async () => {
    db.query
      .mockResolvedValueOnce([[{ setting_value: 's3' }]])    // getDriver
      .mockResolvedValueOnce([[{ setting_key: 's3_endpoint', setting_value: 'http://s3.test.com' }, { setting_key: 's3_bucket', setting_value: 'my-bucket' }]]); // getConfig
    const result = await uploadFile('tenant-slug', 'file.pdf', Buffer.from('pdf'), 'application/pdf');
    expect(result.driver).toBe('s3');
    expect(result.key).toBe('tenant-slug/file.pdf');
  });
});
