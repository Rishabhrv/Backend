const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

/* ================= AUTH ================= */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ================= GET APPROVED REVIEWS ================= */
router.get("/product/:productId", (req, res) => {
  const { productId } = req.params;

  const sql = `
    SELECT 
      r.id,
      r.rating,
      r.comment,
      r.created_at,
      u.name AS user_name
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ?
      AND r.status = 'approved'
    ORDER BY r.created_at DESC
  `;

  db.query(sql, [productId], (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });
});

/* ================= ADD / UPDATE REVIEW ================= */
router.post("/", auth, (req, res) => {
  const { product_id, rating, comment } = req.body;
  const user_id = req.user.id;

  if (!rating || !comment) {
    return res.status(400).json({ message: "Invalid data" });
  }

  const sql = `
    INSERT INTO reviews (product_id, user_id, rating, comment, status)
    VALUES (?, ?, ?, ?, 'pending')
    ON DUPLICATE KEY UPDATE
      rating = VALUES(rating),
      comment = VALUES(comment),
      status = 'pending',
      created_at = CURRENT_TIMESTAMP
  `;

  db.query(sql, [product_id, user_id, rating, comment], (err) => {
    if (err) return res.status(500).json({ message: "Failed" });

    res.json({
      message: "Review submitted for approval",
      status: "pending",
    });
  });
});

module.exports = router;
