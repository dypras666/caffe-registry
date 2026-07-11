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

  // Seed default payment methods
  const defaultMethods = [
    ['BCA Transfer', 'bank_transfer', 'PT Cafe Azzura', '1234567890', 'BCA', 'account_balance', 'Transfer ke rekening BCA a.n PT Cafe Azzura', 1, 1],
    ['Mandiri Transfer', 'bank_transfer', 'PT Cafe Azzura', '9876543210', 'Mandiri', 'account_balance', 'Transfer ke rekening Mandiri a.n PT Cafe Azzura', 1, 2],
    ['BRI Transfer', 'bank_transfer', 'PT Cafe Azzura', '5678901234', 'BRI', 'account_balance', 'Transfer ke rekening BRI a.n PT Cafe Azzura', 1, 3],
    ['GoPay', 'e_wallet', 'Cafe Azzura', '08123456789', 'Gojek', 'account_balance_wallet', 'Pembayaran via GoPay', 1, 4],
    ['OVO', 'e_wallet', 'Cafe Azzura', '08123456789', 'OVO', 'account_balance_wallet', 'Pembayaran via OVO', 1, 5],
    ['DANA', 'e_wallet', 'Cafe Azzura', '08123456789', 'DANA', 'account_balance_wallet', 'Pembayaran via DANA', 1, 6],
    ['QRIS', 'qris', '', '', 'QRIS', 'qr_code', 'Scan QRIS via aplikasi pembayaran apapun', 1, 7],
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

  // Add balance column if missing (migration for existing DBs)
  try { await db.query('ALTER TABLE tenants ADD COLUMN balance INT DEFAULT 0'); } catch (e) {}
  try { await db.query('ALTER TABLE tenants ADD COLUMN auto_suspend BOOLEAN DEFAULT TRUE'); } catch (e) {}
  try { await db.query('ALTER TABLE tenants ADD COLUMN suspended_at TIMESTAMP NULL'); } catch (e) {}

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
