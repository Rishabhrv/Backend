const express = require("express");
const router  = express.Router();
const db      = require("../db");
const jwt     = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* ── Auth ── */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ══════════════════════════════════════════════════════════════
   GET /api/payments
   Returns combined list of order payments + subscription payments
   sorted by date desc.
══════════════════════════════════════════════════════════════ */
router.get("/", auth, async (req, res) => {
  const userId = req.user.id;

  try {
    /* ── 1. Order / Product Payments ── */
    const orderSql = `
      SELECT
        o.id            AS ref_id,
        'order'         AS payment_type,
        o.total_amount  AS amount,
        'INR'           AS currency,
        o.payment_status AS status,
        o.created_at    AS date,
        'Product Purchase' AS title,
        o.razorpay_payment_id AS payment_id,
        NULL            AS plan_key
      FROM orders o
      WHERE o.user_id = ?
        AND o.payment_status = 'success'
        AND EXISTS (
          SELECT 1
          FROM order_items oi
          JOIN product_categories pc ON pc.product_id = oi.product_id
          JOIN categories cat        ON cat.id = pc.category_id
          WHERE oi.order_id = o.id
            AND cat.imprint = 'agclassics'
        )
    `;

    /* ── 2. Subscription Payments ── */
    const subSql = `
      SELECT
        sp.id                     AS ref_id,
        'subscription'            AS payment_type,
        sp.amount                 AS amount,
        sp.currency               AS currency,
        sp.status                 AS status,
        sp.created_at             AS date,
        CONCAT(spl.title, ' — ', us.months, ' Month', IF(us.months>1,'s','')) AS title,
        sp.gateway_payment_id     AS payment_id,
        spl.plan_key              AS plan_key
      FROM subscription_payments sp
      JOIN user_subscriptions us   ON us.id  = sp.user_subscription_id
      JOIN subscription_plans spl  ON spl.id = us.plan_id
      WHERE us.user_id = ?
        AND sp.status = 'success'
    `;

    const [[orders], [subs]] = await Promise.all([
      db.promise().query(orderSql, [userId]),
      db.promise().query(subSql,   [userId]),
    ]);

    const history = [...orders, ...subs].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json(history);
  } catch (err) {
    console.error("Payment history error:", err);
    res.status(500).json({ msg: "Failed to load payment history" });
  }
});


/* ══════════════════════════════════════════════════════════════
   GET /api/payments/subscription/:paymentId
   Detail view for a single subscription payment
══════════════════════════════════════════════════════════════ */
router.get("/subscription/:paymentId", auth, async (req, res) => {
  const userId    = req.user.id;
  const { paymentId } = req.params;

  try {
    const [rows] = await db.promise().query(
      `SELECT
         us.id AS subscription_id,
         us.start_date, us.end_date,
         us.status, us.months, us.amount_paid,
         spl.title
       FROM subscription_payments sp
       JOIN user_subscriptions us   ON us.id  = sp.user_subscription_id
       JOIN subscription_plans spl  ON spl.id = us.plan_id
       WHERE sp.id = ? AND us.user_id = ?`,
      [paymentId, userId]
    );

    if (!rows.length) return res.status(404).json({ msg: "Subscription not found" });

    const [payments] = await db.promise().query(
      `SELECT gateway_payment_id, amount, status, created_at
       FROM subscription_payments
       WHERE user_subscription_id = ?
       ORDER BY created_at DESC`,
      [rows[0].subscription_id]
    );

    res.json({ subscription: rows[0], payments });
  } catch (err) {
    console.error("Subscription detail error:", err);
    res.status(500).json({ msg: "Failed to load subscription details" });
  }
});


module.exports = router;