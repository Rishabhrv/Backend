const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* ── Admin Auth ── */
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ msg: "Admin only" });
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* ── Helper: auto-generate slug ── */
function makeSlug(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* =====================================================
   GET /api/subjects/public  —  All active subjects (NO auth)
   ⚠️  MUST be before /:id to avoid Express matching "public" as an id
===================================================== */
router.get("/public", (req, res) => {
  db.query(
    "SELECT id, name, slug FROM subjects WHERE status = 'active' ORDER BY name ASC",
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

/* =====================================================
   GET /api/subjects/product/:productId  —  Subjects for a product (NO auth)
   ⚠️  MUST be before /:id to avoid Express matching "product" as an id
===================================================== */
router.get("/product/:productId", (req, res) => {
  db.query(
    `SELECT s.id, s.name, s.slug
     FROM product_subjects ps
     JOIN subjects s ON s.id = ps.subject_id
     WHERE ps.product_id = ?`,
    [req.params.productId],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

/* =====================================================
   GET /api/subjects  —  All subjects with product count (admin)
===================================================== */
router.get("/", adminAuth, (req, res) => {
  const sql = `
    SELECT s.*, COUNT(ps.product_id) AS product_count
    FROM subjects s
    LEFT JOIN product_subjects ps ON ps.subject_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

/* =====================================================
   GET /api/subjects/:id  —  Single subject (admin)
===================================================== */
router.get("/:id", adminAuth, (req, res) => {
  db.query("SELECT * FROM subjects WHERE id = ?", [req.params.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ message: "Subject not found" });
    res.json(rows[0]);
  });
});

/* =====================================================
   POST /api/subjects  —  Create subject
===================================================== */
router.post("/", adminAuth, (req, res) => {
  const { name, status = "active" } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: "Name is required" });

  const slug = makeSlug(name);

  db.query("SELECT id FROM subjects WHERE slug = ?", [slug], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (rows.length) return res.status(409).json({ message: "A subject with this name already exists" });

    db.query(
      "INSERT INTO subjects (name, slug, status) VALUES (?, ?, ?)",
      [name.trim(), slug, status],
      (err, result) => {
        if (err) return res.status(500).json(err);
        db.query("SELECT * FROM subjects WHERE id = ?", [result.insertId], (err, rows) => {
          if (err) return res.status(500).json(err);
          res.status(201).json(rows[0]);
        });
      }
    );
  });
});

/* =====================================================
   PUT /api/subjects/:id  —  Update subject
===================================================== */
router.put("/:id", adminAuth, (req, res) => {
  const { name, status } = req.body;
  const { id } = req.params;

  if (!name?.trim()) return res.status(400).json({ message: "Name is required" });

  const slug = makeSlug(name);

  db.query("SELECT id FROM subjects WHERE slug = ? AND id != ?", [slug, id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (rows.length) return res.status(409).json({ message: "A subject with this name already exists" });

    db.query(
      "UPDATE subjects SET name = ?, slug = ?, status = ? WHERE id = ?",
      [name.trim(), slug, status, id],
      (err, result) => {
        if (err) return res.status(500).json(err);
        if (result.affectedRows === 0) return res.status(404).json({ message: "Subject not found" });
        db.query("SELECT * FROM subjects WHERE id = ?", [id], (err, rows) => {
          if (err) return res.status(500).json(err);
          res.json(rows[0]);
        });
      }
    );
  });
});

/* =====================================================
   PATCH /api/subjects/:id/toggle-status  —  Toggle active/inactive
===================================================== */
router.patch("/:id/toggle-status", adminAuth, (req, res) => {
  db.query("SELECT * FROM subjects WHERE id = ?", [req.params.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ message: "Subject not found" });

    const newStatus = rows[0].status === "active" ? "inactive" : "active";

    db.query("UPDATE subjects SET status = ? WHERE id = ?", [newStatus, req.params.id], (err) => {
      if (err) return res.status(500).json(err);
      res.json({ id: Number(req.params.id), status: newStatus });
    });
  });
});

/* =====================================================
   DELETE /api/subjects/:id  —  Delete subject
===================================================== */
router.delete("/:id", adminAuth, (req, res) => {
  db.query("DELETE FROM subjects WHERE id = ?", [req.params.id], (err, result) => {
    if (err) return res.status(500).json(err);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Subject not found" });
    res.json({ message: "Subject deleted" });
  });
});

module.exports = router;