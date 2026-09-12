const mysql = require('mysql2/promise');
require('dotenv').config({ path: '/opt/caffe-registry/.env' });

async function run() {
  try {
    const db = await mysql.createConnection({
      host: process.env.REGISTRY_DB_HOST || '127.0.0.1',
      port: process.env.REGISTRY_DB_PORT || 3306,
      user: process.env.REGISTRY_DB_USER || 'root',
      password: process.env.REGISTRY_DB_PASS || '',
      database: process.env.REGISTRY_DB_NAME || 'cafe_registry'
    });

    const [tenants] = await db.query("SELECT * FROM tenants WHERE slug='demo-cafe-baru'");
    if (tenants.length === 0) return console.log("Tenant not found");
    const tenant = tenants[0];
    
    console.log("Tenant DB:", tenant.db_name);
    const bcrypt = require('bcryptjs');
    
    // Connect to tenant DB
    const tenantConn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 3910, // Assuming shared DB port
      user: 'root',
      password: process.env.SHARED_DB_ROOT_PASS || 'f7ee4e881225768d6fa025f4',
      database: tenant.db_name
    });

    const demoPass = await bcrypt.hash('demo1234', 10);
    const roles = [
      { role: 'admin', email: `owner@${tenant.slug}.id`, name: 'Owner Demo' },
      { role: 'kasir', email: `kasir@${tenant.slug}.id`, name: 'Kasir Demo' },
      { role: 'waiter', email: `waiter@${tenant.slug}.id`, name: 'Waiter Demo' },
      { role: 'member', email: `member@${tenant.slug}.id`, name: 'Member Demo' }
    ];

    for (const r of roles) {
      const [exists] = await tenantConn.query('SELECT id FROM users WHERE email = ?', [r.email]);
      if (exists.length > 0) {
        await tenantConn.query('UPDATE users SET password = ?, role = ?, status="active" WHERE email = ?', [demoPass, r.role, r.email]);
        console.log(`Updated ${r.email}`);
      } else {
        await tenantConn.query('INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, "active")', [r.name, r.email, demoPass, r.role]);
        console.log(`Inserted ${r.email}`);
      }
    }
    await tenantConn.end();
    await db.end();
    console.log("Done seeding");
  } catch(e) { console.error(e); }
}
run();
