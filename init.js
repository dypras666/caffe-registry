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
      config_value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Insert default scaling config
  const scalingDefaults = [
    ['ram_threshold_pct', '80'],
    ['cpu_threshold_pct', '75'],
    ['disk_threshold_pct', '85'],
    ['max_tenants_per_server', '20'],
    ['min_servers', '1'],
    ['max_servers', '10'],
    ['scale_cooldown_minutes', '30'],
    ['heartbeat_timeout_seconds', '300'],
    ['auto_drain_hours', '24'],
    ['drain_usage_below_pct', '20'],
  ];
  for (const [key, val] of scalingDefaults) {
    await db.query(
      "INSERT IGNORE INTO scaling_config (config_key, config_value) VALUES (?, ?)",
      [key, val]
    );
  }

  // Add server_id and container_id to tenants
  try {
    await db.query("ALTER TABLE tenants ADD COLUMN server_id INT AFTER id");
  } catch (_) {}
  try {
    await db.query("ALTER TABLE tenants ADD COLUMN container_id VARCHAR(64) AFTER backend_port");
  } catch (_) {}
  try {
    await db.query("ALTER TABLE tenants ADD COLUMN container_status VARCHAR(20) DEFAULT 'pending' AFTER status");
  } catch (_) {}
  try {
    await db.query("ALTER TABLE tenants MODIFY COLUMN status ENUM('pending','provisioning','active','inactive','failed','migrating') DEFAULT 'pending'");
  } catch (_) {}

  // Superadmin table
  await db.query(`
    CREATE TABLE IF NOT EXISTS superadmins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert default superadmin if not exists
  const bcrypt = require('bcryptjs');
  const defaultPass = await bcrypt.hash('CafeAzzura2024!', 10);
  await db.query(`
    INSERT IGNORE INTO superadmins (email, password, name) VALUES (?, ?, ?)
  `, ['admin@caffe.my.id', defaultPass, 'Super Admin']);

  // Support tickets tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      subject VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      priority ENUM('low','normal','high','urgent') DEFAULT 'normal',
      status ENUM('open','replied','resolved','closed') DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ticket_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      sender ENUM('tenant','admin') NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Add balance column to tenants if missing
  await db.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS balance DECIMAL(12,2) DEFAULT 0").catch(() => {});
  await db.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_suspend TINYINT DEFAULT 1").catch(() => {});
  await db.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_balance_warning DATETIME NULL").catch(() => {});

  console.log('Registry database initialized with pricing plans and tickets!');
  process.exit(0);
}

init().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
