const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'CafeAzzura2024',
  database: process.env.DB_NAME || 'cafe_registry',
  port: process.env.DB_PORT || 3306,
  socketPath: process.env.DB_SOCKET || undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const db = pool;

db.getPool = () => pool;

module.exports = db;
