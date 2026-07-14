require('dotenv').config();
const db = require('./config/database');

async function init() {
  console.log('Initializing registry database...');
  
  // Create registry database
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'CafeAzzura2024',
    socketPath: process.env.DB_SOCKET || undefined
  });
  
  await conn.query('CREATE DATABASE IF NOT EXISTS cafe_registry CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await conn.end();

  // System settings table
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setting_key VARCHAR(100) NOT NULL UNIQUE,
      setting_value TEXT,
      setting_type VARCHAR(30) DEFAULT 'text',
      setting_group VARCHAR(50) DEFAULT 'general',
      label VARCHAR(200),
      description TEXT,
      is_public TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_key (setting_key),
      INDEX idx_public (is_public)
    ) ENGINE=InnoDB
  `);

  // Tenants table with pricing tiers
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50),
      status ENUM('pending','provisioning','active','inactive','failed') DEFAULT 'pending',
      pricing_tier ENUM('free','starter','business','enterprise') DEFAULT 'free',
      ram_mb INT DEFAULT 64,
      cpu_cores DECIMAL(3,1) DEFAULT 0.25,
      disk_mb INT DEFAULT 2048,
      admin_email VARCHAR(255),
      admin_password VARCHAR(255),
      db_name VARCHAR(100),
      backend_port INT,
      admin_port INT,
      ui_port INT,
      admin_url VARCHAR(500),
      balance INT DEFAULT 0,
      auto_suspend BOOLEAN DEFAULT TRUE,
      suspended_at TIMESTAMP NULL,
      reset_token VARCHAR(255),
      reset_token_exp TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_slug (slug),
      INDEX idx_status (status)
    )
  `);

  // Pricing plans table
  await db.query(`
    CREATE TABLE IF NOT EXISTS pricing_plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tier ENUM('free','starter','business','enterprise') UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      price_monthly INT DEFAULT 0,
      ram_mb INT NOT NULL,
      cpu_cores DECIMAL(3,1) NOT NULL,
      disk_mb INT NOT NULL,
      features TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert default pricing plans
  const plans = [
    ['free', 'Gratis', 0, 64, 0.25, 2048, 'RAM 64MB|CPU 0.25 Core|Disk 2GB|Maksimal 100 menu'],
    ['starter', 'Starter', 30000, 128, 0.5, 2048, 'RAM 128MB|CPU 0.5 Core|Disk 2GB|Maksimal 500 menu'],
    ['business', 'Business', 75000, 256, 1.0, 5120, 'RAM 256MB|CPU 1 Core|Disk 5GB|Maksimal 2000 menu'],
    ['enterprise', 'Enterprise', 150000, 512, 2.0, 10240, 'RAM 512MB|CPU 2 Core|Disk 10GB|Unlimited menu']
  ];

  for (const plan of plans) {
    await db.query(`
      INSERT IGNORE INTO pricing_plans (tier, name, price_monthly, ram_mb, cpu_cores, disk_mb, features)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, plan);
  }

  // Servers table (auto-scaling)
  await db.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hostname VARCHAR(255) UNIQUE NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      ssh_port INT DEFAULT 22,
      ssh_user VARCHAR(100) DEFAULT 'root',
      ssh_key_path VARCHAR(500),
      status ENUM('provisioning','active','draining','inactive','failed') DEFAULT 'provisioning',
      docker_version VARCHAR(50),
      total_ram_mb INT DEFAULT 0,
      total_cpu_cores DECIMAL(5,1) DEFAULT 0,
      total_disk_mb INT DEFAULT 0,
      used_ram_mb INT DEFAULT 0,
      used_cpu_cores DECIMAL(5,1) DEFAULT 0,
      used_disk_mb INT DEFAULT 0,
      max_tenants INT DEFAULT 20,
      current_tenants INT DEFAULT 0,
      region VARCHAR(50) DEFAULT 'default',
      last_heartbeat TIMESTAMP NULL,
      labels TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_region (region)
    )
  `);

  // Auto-scaling config table
  await db.query(`
    CREATE TABLE IF NOT EXISTS scaling_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      config_key VARCHAR(100) UNIQUE NOT NULL,
      config_value JSON,
      description VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Tickets / support table
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      subject VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      priority ENUM('normal','high','urgent') DEFAULT 'normal',
      status ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ticket_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT,
      admin_id INT,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    )
  `);

  // Tenant env vars
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_env_vars (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      var_key VARCHAR(100) NOT NULL,
      var_value TEXT,
      is_secret TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      UNIQUE KEY uq_tenant_key (tenant_id, var_key)
    ) ENGINE=InnoDB
  `);

  // Queue / email jobs table
  await db.query(`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(100) NOT NULL,
      payload JSON,
      status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
      retries INT DEFAULT 0,
      max_retries INT DEFAULT 3,
      error TEXT,
      scheduled_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,
      INDEX idx_status (status),
      INDEX idx_type (type)
    )
  `);

  // Payment methods table
  await db.query(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type ENUM('bank_transfer','e_wallet','qris','virtual_account','convenience_store') NOT NULL,
      account_name VARCHAR(200),
      account_number VARCHAR(100),
      provider VARCHAR(100),
      icon VARCHAR(50),
      instructions TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_active (is_active)
    )
  `);

  // Seed default payment methods (only QRIS by default — admin adds bank accounts via dashboard)
  const defaultMethods = [
    ['QRIS', 'qris', '', '', 'QRIS', 'qr_code', 'Scan QRIS via aplikasi pembayaran apapun', 1, 0],
  ];
  for (const m of defaultMethods) {
    await db.query(
      `INSERT IGNORE INTO payment_methods (name, type, account_name, account_number, provider, icon, instructions, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m
    );
  }

  // Topup transactions table
  await db.query(`
    CREATE TABLE IF NOT EXISTS topup_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      amount INT NOT NULL,
      payment_method_id INT,
      status ENUM('pending','completed','failed') DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id),
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status)
    )
  `);

  // Topup requests table (manual payment flow with proof upload + unique code)
  await db.query(`
    CREATE TABLE IF NOT EXISTS topup_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      amount INT NOT NULL,
      unique_code SMALLINT NOT NULL DEFAULT 0,
      transfer_amount INT NOT NULL DEFAULT 0,
      payment_method_id INT,
      status ENUM('pending','confirmed','rejected') DEFAULT 'pending',
      auto_confirmed BOOLEAN DEFAULT FALSE,
      matched_ref VARCHAR(100) NULL,
      proof_url VARCHAR(500) NULL,
      notes TEXT NULL,
      confirmed_by INT NULL,
      confirmed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id),
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status),
      INDEX idx_transfer_amount (transfer_amount, status)
    )
  `);
  // Migrations for existing topup_requests tables
  try { await db.query('ALTER TABLE topup_requests ADD COLUMN unique_code SMALLINT NOT NULL DEFAULT 0'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD COLUMN transfer_amount INT NOT NULL DEFAULT 0'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD COLUMN auto_confirmed BOOLEAN DEFAULT FALSE'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD COLUMN matched_ref VARCHAR(100) NULL'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD COLUMN uuid VARCHAR(36) NULL'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD COLUMN qris_expires_at DATETIME NULL'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD INDEX idx_transfer_amount (transfer_amount, status)'); } catch (e) {}
  try { await db.query('ALTER TABLE topup_requests ADD UNIQUE KEY uk_transfer_date (transfer_amount, DATE(created_at))'); } catch (e) {}

  // BCA Merchant QRIS config (one row per slot, max 1 for now)
  await db.query(`
    CREATE TABLE IF NOT EXISTS bca_merchant_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(100) NOT NULL DEFAULT 'BCA QRIS',
      email_enc TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      default_mid VARCHAR(50) NULL,
      is_active BOOLEAN DEFAULT TRUE,
      last_sync_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // BCA QRIS outlets cache
  await db.query(`
    CREATE TABLE IF NOT EXISTS bca_qris_outlets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      config_id INT NOT NULL,
      mid VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      nmid VARCHAR(100),
      qris_image_url VARCHAR(500),
      is_default BOOLEAN DEFAULT FALSE,
      raw_data JSON,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_config_mid (config_id, mid),
      INDEX idx_config (config_id)
    )
  `);

  // BCA mutation log
  await db.query(`
    CREATE TABLE IF NOT EXISTS bca_mutation_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      config_id INT NOT NULL,
      mid VARCHAR(50) NOT NULL,
      reference_number VARCHAR(100),
      amount BIGINT NOT NULL,
      date VARCHAR(20) NOT NULL,
      payment_method VARCHAR(100),
      payer_name VARCHAR(200),
      payer_phone VARCHAR(50),
      approval_code VARCHAR(100),
      raw_data JSON,
      fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_config_mid (config_id, mid),
      INDEX idx_date (date),
      INDEX idx_ref (reference_number)
    )
  `);

  // Link payment method to BCA config (for QRIS BCA auto-check)
  try { await db.query('ALTER TABLE payment_methods ADD COLUMN bca_config_id INT NULL'); } catch (e) {}
  try { await db.query('ALTER TABLE payment_methods ADD COLUMN qris_type ENUM("static","bca") DEFAULT "static"'); } catch (e) {}

  // Add balance column if missing (migration for existing DBs)
  try { await db.query('ALTER TABLE tenants ADD COLUMN balance INT DEFAULT 0'); } catch (e) {}
  try { await db.query('ALTER TABLE tenants ADD COLUMN auto_suspend BOOLEAN DEFAULT TRUE'); } catch (e) {}
  try { await db.query('ALTER TABLE tenants ADD COLUMN suspended_at TIMESTAMP NULL'); } catch (e) {}

  // UI templates marketplace
  await db.query(`
    CREATE TABLE IF NOT EXISTS ui_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      tier ENUM('free','premium','exclusive') DEFAULT 'free',
      price INT DEFAULT 0,
      image_tag VARCHAR(200) DEFAULT 'cafe-ui:latest',
      thumbnail_url VARCHAR(500),
      preview_url VARCHAR(500),
      preview_hue VARCHAR(10) DEFAULT '30',
      tags VARCHAR(300),
      rating DECIMAL(3,1) DEFAULT 0.0,
      review_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tier (tier),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB
  `);
  try { await db.query("ALTER TABLE ui_templates ADD COLUMN image_tag VARCHAR(200) DEFAULT 'cafe-ui:latest' AFTER price"); } catch (e) {}

  // Tenant template purchases
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      template_id INT NOT NULL,
      is_active BOOLEAN DEFAULT FALSE,
      purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_tenant_template (tenant_id, template_id),
      INDEX idx_tenant (tenant_id),
      FOREIGN KEY (template_id) REFERENCES ui_templates(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Seed default templates
  await db.query(`
    INSERT IGNORE INTO ui_templates (slug, name, description, tier, price, image_tag, preview_url, preview_hue, tags, rating, review_count, sort_order) VALUES
    ('classic-landing', 'Classic Landing', 'Landing page klasik dengan hero animasi kopi dan menu showcase.', 'free', 0, 'cafe-ui:latest', NULL, '30', 'minimal,classic,dark', 4.5, 128, 1),
    ('premium-coffee', 'Premium Coffee', 'Modern single-page dengan animasi cangkir kopi 3D, warm palette, typografi minimalis premium.', 'premium', 75000, 'cafe-ui:v2', NULL, '25', '3d,premium,modern,warm', 4.9, 47, 2),
    ('urban-brew', 'Urban Brew', 'Dark & bold aesthetic untuk coffee shop bergaya industrial-urban.', 'premium', 65000, 'cafe-ui:v3', NULL, '200', 'dark,urban,bold,industrial', 4.7, 31, 3),
    ('botanical-cafe', 'Botanical Café', 'Light & airy design dengan aksen hijau, cocok untuk café berkonsep nature.', 'exclusive', 120000, 'cafe-ui:v4', NULL, '120', 'light,botanical,nature,green', 5.0, 19, 4)
  `);

  // Add active_template_id column to tenants if missing
  try { await db.query('ALTER TABLE tenants ADD COLUMN active_template_id INT NULL'); } catch (e) {}
  try { await db.query('ALTER TABLE tenants ADD CONSTRAINT fk_active_template FOREIGN KEY (active_template_id) REFERENCES ui_templates(id) ON DELETE SET NULL'); } catch (e) {}

  // Seed app_domain setting so frontend can read it
  const appDomain = process.env.APP_DOMAIN || 'caffe.id';
  const siteUrl   = process.env.SITE_URL || `https://${appDomain}`;
  await db.query(
    'INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
    ['app_domain', appDomain, 'text', 'general', 'Domain Aplikasi', 1]
  ).catch(() => {});
  await db.query(
    'INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
    ['site_url', siteUrl, 'text', 'general', 'URL Situs', 1]
  ).catch(() => {});

  console.log('Registry database initialized.');
  process.exit(0);
}

init().catch(e => { console.error(e); process.exit(1); });
