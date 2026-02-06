const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

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

/* =====================================================
   💰 ALL PAYMENTS (ORDERS + SUBSCRIPTIONS)
===================================================== */
router.get("/payments", adminAuth, (req, res) => {
  const sql = `
    /* ================= ORDER PAYMENTS ================= */
    SELECT
      'order' AS type,
      o.id AS id,
      o.user_id AS user_id,              -- ✅ FIX
      o.razorpay_payment_id AS payment_id,
      o.total_amount AS amount,
      o.payment_status AS status,
      o.created_at,
      u.name,
      u.email
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.payment_status = 'success'

    UNION ALL

    /* ================= SUBSCRIPTION PAYMENTS ================= */
    SELECT
      'subscription' AS type,
      sp.id AS id,
      us.user_id AS user_id,             -- ✅ FIX
      sp.gateway_payment_id AS payment_id,
      sp.amount,
      sp.status,
      sp.created_at,
      u.name,
      u.email
    FROM subscription_payments sp
    JOIN user_subscriptions us ON us.id = sp.user_subscription_id
    JOIN users u ON u.id = us.user_id
    WHERE sp.status = 'success'

    ORDER BY created_at DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/* =====================================================
   📊 PAYMENT STATS (FOR CHARTS)
===================================================== */
router.get("/payments/stats", adminAuth, (req, res) => {
  const sql = `
    SELECT
      DATE(created_at) AS date,
      SUM(amount) AS total
    FROM (
      /* ORDERS */
      SELECT
        total_amount AS amount,
        created_at
      FROM orders
      WHERE payment_status = 'success'

      UNION ALL

      /* SUBSCRIPTIONS */
      SELECT
        amount,
        created_at
      FROM subscription_payments
      WHERE status = 'success'
    ) t
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json(err);
    }
    res.json(rows);
  });
});


module.exports = router;
