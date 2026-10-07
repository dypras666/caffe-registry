const mysql = require('mysql2/promise');

const REGISTRY = {
  host: '127.0.0.1', port: 3306, user: 'root', password: 'CafeAzzura2024', database: 'cafe_registry'
};
const SHARED = {
  host: '127.0.0.1', port: 3910, user: 'root', password: 'f7ee4e881225768d6fa025f4'
};

async function run() {
  const reg = await mysql.createConnection(REGISTRY);
  const [tenants] = await reg.query("SELECT db_name FROM tenants WHERE status = 'active'");
  await reg.end();

  const shared = await mysql.createConnection(SHARED);
  for (const t of tenants) {
    const db = t.db_name;
    console.log(`Patching ${db}...`);
    try {
      await shared.query(`USE \`${db}\``);
      // Posts table
      try {
        await shared.query(`ALTER TABLE posts ADD COLUMN created_by INT(11) NULL AFTER author_id, ADD COLUMN updated_by INT(11) NULL AFTER created_by;`);
      } catch (e) {
        if (!e.message.includes('Duplicate column')) console.log(`  Posts error: ${e.message}`);
      }
      
      // Vouchers table
      try {
        await shared.query(`ALTER TABLE vouchers CHANGE start_date valid_from DATETIME NULL, CHANGE end_date valid_until DATETIME NULL, ADD COLUMN member_only TINYINT(1) DEFAULT 0, ADD COLUMN usage_per_member INT DEFAULT 1, ADD COLUMN applicable_products JSON NULL;`);
      } catch (e) {
        if (!e.message.includes('Duplicate column') && !e.message.includes('Unknown column')) console.log(`  Vouchers error: ${e.message}`);
      }
      // If start_date doesn't exist, maybe we just ADD them
      try {
         await shared.query(`ALTER TABLE vouchers ADD COLUMN valid_from DATETIME NULL, ADD COLUMN valid_until DATETIME NULL;`);
      } catch(e) {}
    } catch(err) {
      console.log(`Error on ${db}: ${err.message}`);
    }
  }
  await shared.end();
  console.log('Done!');
}
run();
