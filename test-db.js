const db = require('./config/database');

async function test() {
  const rows = await db.query('SELECT slug FROM tenants');
  console.log('DB rows:', rows);
  
  const avail = await db.query('SELECT slug FROM tenants WHERE slug = ?', ['cafebaru2024']);
  console.log('Check cafebaru2024:', avail);
}

test().catch(console.error);
