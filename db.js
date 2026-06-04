const mysql = require("mysql2");
require("dotenv").config();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  timezone: '+05:30',
  waitForConnections: true,
  connectionLimit: 50,   // adjust if needed
  queueLimit: 0,
  keepAliveInitialDelay: 0,
  enableKeepAlive: true,
});

// OPTIONAL: check pool once on startup
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ MySQL Pool Connection Failed:", err.message);
  } else {
    console.log("✅ MySQL Pool Connected");
    connection.release();
  }
});

// GLOBAL DB ERROR HANDLING (VERY IMPORTANT)
db.on("error", (err) => {
  console.error("🔥 MySQL Pool Error:", err);
});

module.exports = db;
