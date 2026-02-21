const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");
const SECRET = "MY_SECRET_KEY";

/* ─── Admin Auth ─── */
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ msg: "Admin only" });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* ════════════════════════════════════════
   GET /api/admin/reviews
   All reviews with user + product info
════════════════════════════════════════ */
router.get("/reviews", adminAuth, (req, res) => {
  db.query(
    `SELECT
       r.id,
       u.name  AS user_name,
       u.email AS user_email,
       p.id    AS product_id,
       p.title AS product_title,
       p.slug  AS slug,            
       r.rating,
       r.comment,
       r.status,
       r.created_at
     FROM reviews r
     JOIN users    u ON u.id = r.user_id
     JOIN products p ON p.id = r.product_id
     ORDER BY r.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});


/* ════════════════════════════════════════
   PUT /api/admin/reviews/:id
   Update rating, comment, and/or status
════════════════════════════════════════ */
router.put("/reviews/:id", adminAuth, (req, res) => {
  const { rating, comment, status } = req.body;

  // validate
  if (status && !["approved", "pending"].includes(status))
    return res.status(400).json({ msg: "Invalid status" });
  if (rating && (rating < 1 || rating > 5))
    return res.status(400).json({ msg: "Rating must be 1–5" });

  // build dynamic update
  const fields = [];
  const values = [];

  if (rating  !== undefined) { fields.push("rating = ?");  values.push(rating); }
  if (comment !== undefined) { fields.push("comment = ?"); values.push(comment); }
  if (status  !== undefined) { fields.push("status = ?");  values.push(status); }

  if (fields.length === 0)
    return res.status(400).json({ msg: "Nothing to update" });

  values.push(req.params.id);

  db.query(
    `UPDATE reviews SET ${fields.join(", ")} WHERE id = ?`,
    values,
    (err) => {
      if (err) return res.status(500).json({ msg: "Update failed" });
      res.json({ msg: "Review updated" });
    }
  );
});

/* ════════════════════════════════════════
   DELETE /api/admin/reviews/:id
════════════════════════════════════════ */
router.delete("/reviews/:id", adminAuth, (req, res) => {
  db.query(
    `DELETE FROM reviews WHERE id = ?`,
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "Delete failed" });
      res.json({ msg: "Review deleted" });
    }
  );
});

module.exports = router;