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

router.get("/", auth, async (req, res) => {
  const userId = req.user.id;

  try {
    /* ================= PRODUCT PAYMENTS ================= */
    const productSql = `
      SELECT
        o.id AS ref_id,
        'product' AS payment_type,
        o.total_amount AS amount,
        'INR' AS currency,
        o.payment_status AS status,
        o.created_at AS date,
        'Product Purchase' AS title,
        o.razorpay_payment_id AS payment_id
      FROM orders o
      WHERE o.user_id = ?
        AND o.payment_status = 'success'
    `;

    /* ================= SUBSCRIPTION PAYMENTS ================= */
    const subscriptionSql = `
      SELECT
        sp.id AS ref_id,
        'subscription' AS payment_type,
        sp.amount,
        sp.currency,
        sp.status,
        sp.created_at AS date,
        CONCAT(p.title, ' (', us.months, ' months)') AS title,
        sp.gateway_payment_id AS payment_id
      FROM subscription_payments sp
      JOIN user_subscriptions us 
        ON us.id = sp.user_subscription_id
      JOIN subscription_plans p 
        ON p.id = us.plan_id
      WHERE us.user_id = ?
        AND sp.status = 'success'
    `;

    const [products] = await db.promise().query(productSql, [userId]);
    const [subscriptions] = await db.promise().query(subscriptionSql, [userId]);

    const history = [...products, ...subscriptions].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json(history);
  } catch (err) {
    console.error("Payment history error:", err);
    res.status(500).json({ msg: "Failed to load payment history" });
  }
});


router.get("/subscription/:paymentId", auth, async (req, res) => {
  const userId = req.user.id;
  const { paymentId } = req.params;

  try {
    // 1️⃣ Get subscription linked to this payment
    const [rows] = await db.promise().query(
      `
      SELECT 
        us.id AS subscription_id,
        us.start_date,
        us.end_date,
        us.status,
        us.months,
        us.amount_paid,
        p.title
      FROM subscription_payments sp
      JOIN user_subscriptions us ON us.id = sp.user_subscription_id
      JOIN subscription_plans p ON p.id = us.plan_id
      WHERE sp.id = ?
        AND us.user_id = ?
      `,
      [paymentId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ msg: "Subscription not found" });
    }

    const subscription = rows[0];

    // 2️⃣ Get all payments of this subscription
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

    res.json({
      subscription,
      payments,
    });
  } catch (err) {
    console.error("Subscription detail error:", err);
    res.status(500).json({ msg: "Failed to load subscription details" });
  }
});


module.exports = router;
