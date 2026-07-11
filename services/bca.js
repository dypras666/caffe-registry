// services/bca.js — BCA Merchant SDK wrapper + credential encryption

const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('crypto');
const BCAMerchantSDK = require('@nds-stack/bca-merchant-sdk');
const db = require('../config/database');

// Encryption key derived from APP_SECRET env var (must be set in production)
const APP_SECRET = process.env.APP_SECRET || 'caffe-saas-secret-change-in-production';
const ENC_KEY = scryptSync(APP_SECRET, 'bca-cred-salt', 32); // 256-bit key

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns: iv:authTag:ciphertext (all hex)
 */
function encrypt(plaintext) {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt AES-256-GCM ciphertext produced by encrypt().
 */
function decrypt(encryptedStr) {
  const [ivHex, authTagHex, dataHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Build a BCAMerchantSDK instance with DB-backed token storage for a config row.
 */
function buildSDK(configRow) {
  const email = decrypt(configRow.email_enc);
  const password = decrypt(configRow.password_enc);

  // DB-backed token storage — stores tokens per config_id
  const storage = {
    save: async (tokens) => {
      const val = JSON.stringify(tokens);
      await db.query(
        `INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public)
         VALUES (?, ?, 'text', 'bca', 'BCA Token', 0)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [`bca_token_${configRow.id}`, val]
      ).catch(() => {});
      return tokens;
    },
    load: async () => {
      try {
        const [[row]] = await db.query(
          `SELECT setting_value FROM system_settings WHERE setting_key = ?`,
          [`bca_token_${configRow.id}`]
        );
        return row ? JSON.parse(row.setting_value) : null;
      } catch { return null; }
    },
    clear: async () => {
      await db.query(
        `DELETE FROM system_settings WHERE setting_key = ?`,
        [`bca_token_${configRow.id}`]
      ).catch(() => {});
    },
  };

  return new BCAMerchantSDK({ storage, credentials: { email, password } });
}

/**
 * Get the active BCA config + SDK instance.
 * Throws if not configured.
 */
async function getActiveSDK() {
  const [[config]] = await db.query(
    'SELECT * FROM bca_merchant_config WHERE is_active = 1 ORDER BY id LIMIT 1'
  );
  if (!config) throw new Error('BCA Merchant belum dikonfigurasi');
  return { config, sdk: buildSDK(config) };
}

/**
 * Sync merchants/outlets from BCA and cache in bca_qris_outlets.
 */
async function syncOutlets(config, sdk) {
  const merchants = await sdk.getMerchantsWithQRIS();

  for (const m of merchants) {
    await db.query(
      `INSERT INTO bca_qris_outlets (config_id, mid, name, nmid, qris_image_url, raw_data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         nmid = VALUES(nmid),
         qris_image_url = VALUES(qris_image_url),
         raw_data = VALUES(raw_data),
         synced_at = NOW()`,
      [config.id, m.mid, m.name, m.nmid, m.qris_image, JSON.stringify(m)]
    );
  }

  await db.query(
    'UPDATE bca_merchant_config SET last_sync_at = NOW() WHERE id = ?',
    [config.id]
  );

  return merchants;
}

/**
 * Fetch transactions for a mid+date range and upsert into bca_mutation_log.
 */
async function syncTransactions(config, sdk, mid, startDate, endDate) {
  const result = await sdk.getTransactions(mid, startDate, endDate);
  const transactions = result.output_schema?.transaction || [];

  for (const tx of transactions) {
    await db.query(
      `INSERT IGNORE INTO bca_mutation_log
         (config_id, mid, reference_number, amount, date, payment_method, payer_name, payer_phone, approval_code, raw_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id,
        tx.mid || mid,
        tx.reference_number,
        Math.round(parseFloat(tx.amount || '0')),
        tx.date?.substring(0, 10) || startDate,
        tx.payment_method || '',
        tx.payer_name || '',
        tx.payer_phone || '',
        tx.approval_code || '',
        JSON.stringify(tx),
      ]
    );
  }

  return {
    total: transactions.length,
    summary: result.output_schema?.summary,
  };
}

module.exports = { encrypt, decrypt, buildSDK, getActiveSDK, syncOutlets, syncTransactions };
