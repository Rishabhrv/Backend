const express = require("express");
const router = express.Router();
const db = require("../db"); // Adjust path to your db connection
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ msg: "Admin only" });
    }
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* ===============================================
   GET /api/admin/ebook-analytics/data
=============================================== */
router.get("/ebook-analytics/data", adminAuth, async (req, res) => {
  const { timeframe = "all", imprint = "all", userId = "" } = req.query;

  let timeCondition = "";
  if (timeframe === "day") timeCondition = "AND ers.created_at >= NOW() - INTERVAL 1 DAY";
  else if (timeframe === "week") timeCondition = "AND ers.created_at >= NOW() - INTERVAL 1 WEEK";
  else if (timeframe === "month") timeCondition = "AND ers.created_at >= NOW() - INTERVAL 1 MONTH";

  // Use EXISTS to prevent row duplication if a book has multiple categories
  let imprintCondition = "";
  let imprintParams = [];
  if (imprint !== "all") {
    imprintCondition = `
      AND EXISTS (
        SELECT 1 FROM product_categories pc
        JOIN categories c ON pc.category_id = c.id
        WHERE pc.product_id = e.product_id AND c.imprint = ?
      )
    `;
    imprintParams.push(imprint);
  }

  let userCondition = "";
  let userParams = [];
  if (userId) {
    userCondition = "AND ers.user_id = ?";
    userParams.push(userId);
  }

  const baseParams = [...imprintParams, ...userParams];

  try {
    // 1. Most Read Books
    const booksSql = `
      SELECT p.id, p.title, p.main_image, SUM(ers.duration_seconds) AS total_seconds
      FROM ebook_reading_sessions ers
      JOIN ebooks e ON ers.ebook_id = e.id
      JOIN products p ON e.product_id = p.id
      WHERE 1=1 ${timeCondition} ${imprintCondition} ${userCondition}
      GROUP BY p.id
      ORDER BY total_seconds DESC
      LIMIT 10
    `;

    // 2. Top Readers
    const usersSql = `
      SELECT u.id, u.name, u.email, 
             SUM(ers.duration_seconds) AS total_seconds,
             COUNT(DISTINCT ers.ebook_id) AS unique_books_read
      FROM ebook_reading_sessions ers
      JOIN users u ON ers.user_id = u.id
      JOIN ebooks e ON ers.ebook_id = e.id
      WHERE 1=1 ${timeCondition} ${imprintCondition} ${userCondition}
      GROUP BY u.id
      ORDER BY total_seconds DESC
      LIMIT 10
    `;

    // 3. Recent Reading Logs (Who read what)
    const logsSql = `
      SELECT ers.id, u.name AS user_name, u.email, p.title AS book_title, 
             ers.duration_seconds, ers.created_at
      FROM ebook_reading_sessions ers
      JOIN users u ON ers.user_id = u.id
      JOIN ebooks e ON ers.ebook_id = e.id
      JOIN products p ON e.product_id = p.id
      WHERE 1=1 ${timeCondition} ${imprintCondition} ${userCondition}
      ORDER BY ers.created_at DESC
      LIMIT 50
    `;

    // Execute queries concurrently
    const [topBooks, topUsers, logs] = await Promise.all([
      new Promise((res, rej) => db.query(booksSql, baseParams, (err, rows) => err ? rej(err) : res(rows))),
      new Promise((res, rej) => db.query(usersSql, baseParams, (err, rows) => err ? rej(err) : res(rows))),
      new Promise((res, rej) => db.query(logsSql, baseParams, (err, rows) => err ? rej(err) : res(rows)))
    ]);

    res.json({ topBooks, topUsers, logs });

  } catch (error) {
    console.error("Ebook Analytics Error:", error);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

module.exports = router;