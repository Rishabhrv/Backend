const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* =====================================================
   🔐 ADMIN AUTH  — sets req.user so detail routes work
===================================================== */
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ msg: "Admin only" });
    }
    req.user = decoded; // ✅ makes req.user.id available downstream
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* =====================================================
   💰 ALL PAYMENTS  —  GET /api/admin/payments
===================================================== */
router.get("/payments", adminAuth, (req, res) => {
  const sql = `
    SELECT
      'order'                        AS type,
      o.id                           AS id,
      o.user_id,
      o.razorpay_payment_id          AS payment_id,
      o.total_amount                 AS amount,
      o.payment_status               AS status,
      o.created_at,
      u.name,
      u.email,
      GROUP_CONCAT(DISTINCT c.imprint) AS imprints
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN order_items oi         ON oi.order_id   = o.id
    LEFT JOIN products p             ON p.id           = oi.product_id
    LEFT JOIN product_categories pc  ON pc.product_id  = p.id
    LEFT JOIN categories c           ON c.id           = pc.category_id
    WHERE o.payment_status = 'success'
    GROUP BY o.id, o.user_id, o.razorpay_payment_id,
             o.total_amount, o.payment_status, o.created_at,
             u.name, u.email

    UNION ALL

    SELECT
      'subscription'                 AS type,
      sp.id                          AS id,
      us.user_id,
      sp.gateway_payment_id          AS payment_id,
      sp.amount,
      sp.status,
      sp.created_at,
      u.name,
      u.email,
      NULL                           AS imprints
    FROM subscription_payments sp
    JOIN user_subscriptions us ON us.id = sp.user_subscription_id
    JOIN users u ON u.id = us.user_id
    WHERE sp.status = 'success'

    ORDER BY created_at DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows.map(r => ({
      ...r,
      imprints: r.imprints ? r.imprints.split(",") : [],
    })));
  });
});

/* =====================================================
   📊 PAYMENT STATS  —  GET /api/admin/payments/stats
   ⚠️  Must be declared BEFORE /:orderId to avoid
       Express treating "stats" as an orderId param.
===================================================== */
router.get("/payments/stats", adminAuth, (req, res) => {
  const sql = `
    SELECT
      DATE(created_at) AS date,
      SUM(amount)      AS total
    FROM (
      SELECT total_amount AS amount, created_at
      FROM orders
      WHERE payment_status = 'success'

      UNION ALL

      SELECT amount, created_at
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

/* =====================================================
   📦 ORDER DETAIL  —  GET /api/admin/:orderId
   Admin can view any order (no user_id filter needed).
===================================================== */
router.get("/:orderId", adminAuth, (req, res) => {
  const orderId = req.params.orderId;

  const sql = `
    SELECT
      o.id               AS order_id,
      o.total_amount,
      o.status,
      o.payment_status,
      o.created_at,

      o.razorpay_payment_id          AS transaction_id,
      NULL                           AS payment_method,
      o.total_amount                 AS paid_amount,

      oi.product_id,
      oi.quantity,
      oi.price,
      oi.format,

      pr.title,
      pr.main_image,

      COALESCE(s.shipping_cost, 0)   AS shipping_cost,

      oa.first_name,
      oa.last_name,
      oa.address,
      oa.city,
      oa.state,
      oa.pincode,
      oa.phone,
      oa.email                       AS shipping_email

    FROM orders o
    JOIN order_items oi   ON oi.order_id  = o.id
    JOIN products pr      ON pr.id        = oi.product_id
    LEFT JOIN shipping s  ON s.order_id   = o.id
    LEFT JOIN order_address oa ON oa.order_id = o.id

    WHERE o.id = ?
  `;

  db.query(sql, [orderId], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

/* =====================================================
   👑 SUBSCRIPTION DETAIL  —  GET /api/admin/subscription/:paymentId
   ⚠️  Must be declared BEFORE /:orderId  OR use a
       prefix that won't match the generic param.
       Easiest fix: mount it via /payments/subscription/
       so it never conflicts with /:orderId.
       Here we keep /subscription/:paymentId and rely
       on Express ordering (declared after /payments/* 
       but the path literal "subscription" won't be
       confused with a numeric orderId).
===================================================== */
router.get("/subscription/:paymentId", adminAuth, async (req, res) => {
  const { paymentId } = req.params;

  try {
    const [rows] = await db.promise().query(
      `
      SELECT
        us.id            AS subscription_id,
        us.start_date,
        us.end_date,
        us.status,
        us.months,
        us.amount_paid,
        p.title
      FROM subscription_payments sp
      JOIN user_subscriptions us  ON us.id  = sp.user_subscription_id
      JOIN subscription_plans p   ON p.id   = us.plan_id
      WHERE sp.id = ?
      `,
      [paymentId]
    );

    if (!rows.length) {
      return res.status(404).json({ msg: "Subscription not found" });
    }

    const subscription = rows[0];

    const [payments] = await db.promise().query(
      `
      SELECT
        gateway_payment_id,
        amount,
        status,
        created_at
      FROM subscription_payments
      WHERE user_subscription_id = ?
      ORDER BY created_at DESC
      `,
      [subscription.subscription_id]
    );

    res.json({ subscription, payments });
  } catch (err) {
    console.error("Subscription detail error:", err);
    res.status(500).json({ msg: "Failed to load subscription details" });
  }
});

module.exports = router;