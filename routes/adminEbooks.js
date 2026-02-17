const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const SECRET = "MY_SECRET_KEY";

/* ================= ADMIN AUTH ================= */


/* 🔐 ADMIN AUTH */
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


/* ============================================================
   ===================== ADMIN PREVIEW =========================
   ============================================================ */

/* 🔐 ADMIN READ EPUB */
router.get("/ebooksperview/:slug/read", adminAuth, (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT e.file_path
    FROM ebooks e
    JOIN products p ON p.id = e.product_id
    WHERE p.slug = ?
    LIMIT 1
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length)
      return res.status(404).json({ msg: "Book not found" });

    const epubPath = path.join(__dirname, "..", rows[0].file_path);

    if (!fs.existsSync(epubPath)) {
      return res.status(404).json({ msg: "EPUB file not found" });
    }

    res.setHeader("Content-Type", "application/epub+zip");
    res.sendFile(epubPath);
  });
});

/* 🔐 ADMIN META */
router.get("/ebooksperview/:slug/meta", adminAuth, (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT p.title
    FROM products p
    WHERE p.slug = ?
    LIMIT 1
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length)
      return res.status(404).json({ msg: "Book not found" });

    res.json(rows[0]);
  });
});

module.exports = router;
