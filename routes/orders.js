const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* 🔐 AUTH */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ================= MY ORDERS ================= */
router.get("/", auth, (req, res) => {
  const sql = `
    SELECT id, total_amount, status, payment_status, created_at
    FROM orders
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/* ================= PAID ORDERS GROUPED BY DATE ================= */
router.get("/by-date", auth, (req, res) => {
  const sql = `
    SELECT 
      o.id AS order_id,
      o.total_amount,
      o.created_at,
      DATE(o.created_at) AS order_date,
      COUNT(oi.id) AS items_count
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = ?
      AND o.payment_status = 'success'
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/* ================= ORDER DETAILS ================= */
router.get("/:orderId", auth, (req, res) => {
  const { orderId } = req.params;

  const sql = `
    SELECT 
      o.id AS order_id,
      o.total_amount,
      o.status,
      o.payment_status,
      o.created_at,

      oi.product_id,
      oi.format,
      oi.price,
      oi.quantity,

      p.title,
      p.slug,
      p.main_image
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    WHERE o.id = ? AND o.user_id = ?
  `;

  db.query(sql, [orderId, req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ msg: "Order not found" });

    res.json(rows);
  });
});



module.exports = router;
