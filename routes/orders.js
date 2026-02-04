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

router.get("/:orderId/shipping", auth, (req, res) => {
  const { orderId } = req.params;

  db.query(
    `SELECT *
     FROM shipping
     WHERE order_id = ?`,
    [orderId],
    (err, rows) => {
      if (err || !rows.length) {
        return res.json({
          status: "confirmed",
          confirmed_at: new Date(),
        });
      }

      res.json(rows[0]);
    }
  );
});


/* ================= ORDER DETAILS ================= */
router.get("/:orderId", auth, (req, res) => {
  const userId = req.user.id;
  const orderId = req.params.orderId;

  const sql = `
    SELECT 
      o.id AS order_id,
      o.total_amount,
      o.status,
      o.payment_status,
      o.created_at,

      p.transaction_id,
      p.payment_method,
      p.amount AS paid_amount,

      oi.product_id,
      oi.quantity,
      oi.price,
      oi.format,

      pr.title,
      pr.main_image

    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products pr ON pr.id = oi.product_id
    LEFT JOIN payments p ON p.order_id = o.id

    WHERE o.id = ?
    AND o.user_id = ?
  `;

  db.query(sql, [orderId, userId], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});







module.exports = router;
