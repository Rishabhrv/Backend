const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const SECRET = "MY_SECRET_KEY";
const { createAdminNotification } = require("./adminnotifications");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* 🔐 INLINE AUTH */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ==================================================
   HELPER: Get or create Razorpay Plan ID for a DB plan
   Call this once per plan (stores razorpay_plan_id in DB)
================================================== */
async function getRazorpayPlanId(plan) {
  // If already synced, return it
  if (plan.razorpay_plan_id) return plan.razorpay_plan_id;

  const amount = plan.discount_price || plan.base_price;

  // Map duration_months to Razorpay interval
  const intervalMap = { 1: "monthly", 3: "quarterly", 6: "monthly", 12: "yearly" };
  const interval = intervalMap[plan.duration_months] || "monthly";
  // For multi-month plans that aren't quarterly/yearly, we use interval_count
  const intervalCount = (plan.duration_months === 3) ? 1 : (plan.duration_months === 12) ? 1 : plan.duration_months;
  const rzpInterval = (plan.duration_months === 3) ? "quarterly" : (plan.duration_months === 12) ? "yearly" : "monthly";

  const rzpPlan = await razorpay.plans.create({
    period: rzpInterval === "quarterly" ? "monthly" : rzpInterval,
    interval: rzpInterval === "quarterly" ? 3 : intervalCount,
    item: {
      name: plan.title,
      amount: amount * 100, // in paise
      currency: "INR",
      description: plan.description || plan.title,
    },
  });

  // Save back to DB
  await new Promise((resolve, reject) =>
    db.query(
      `UPDATE subscription_plans SET razorpay_plan_id=? WHERE id=?`,
      [rzpPlan.id, plan.id],
      (err) => (err ? reject(err) : resolve())
    )
  );

  return rzpPlan.id;
}

/* ==================================================
   USER SUBSCRIPTION DETAILS
================================================== */
router.get("/me", auth, (req, res) => {
  const user_id = req.user.id;
  db.query(
    `SELECT us.id AS subscription_id, sp.title, sp.plan_key,
            us.months, us.amount_paid, us.start_date, us.end_date,
            us.status, us.razorpay_subscription_id, us.autopay_enabled
     FROM user_subscriptions us
     JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.user_id=?
     ORDER BY us.created_at DESC LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json({ active: rows.length > 0, subscription: rows[0] || null });
    }
  );
});

/* ==================================================
   USER SUBSCRIPTION PAYMENTS
================================================== */
router.get("/payments", auth, (req, res) => {
  const user_id = req.user.id;
  db.query(
    `SELECT sp.gateway_payment_id, sp.gateway_order_id,
            sp.amount, sp.status, sp.created_at
     FROM subscription_payments sp
     JOIN user_subscriptions us ON us.id = sp.user_subscription_id
     WHERE us.user_id=?
     ORDER BY sp.created_at DESC`,
    [user_id],
    (err, rows) => {
      if (err) return res.json([]);
      res.json(rows);
    }
  );
});

/* ==================================================
   CHECK PROMO ELIGIBILITY (New Users Only)
================================================== */
router.get("/eligibility", auth, (req, res) => {
  const user_id = req.user.id;
  db.query(
    `SELECT id FROM user_subscriptions WHERE user_id=? AND status IN ('active','expired','cancelled') LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json({ isNewUser: rows.length === 0 });
    }
  );
});

/* ==================================================
   1️⃣  CREATE RAZORPAY SUBSCRIPTION (with Autopay)
================================================== */
router.post("/create", auth, async (req, res) => {
  const user_id = req.user.id;
  const { plan_key } = req.body;

  if (!plan_key) return res.status(400).json({ msg: "Missing plan key" });

  try {
    // Block if already active
    const [activeRows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT id FROM user_subscriptions WHERE user_id=? AND status='active' AND end_date >= CURDATE() LIMIT 1`,
        [user_id],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );
    if (activeRows.length > 0)
      return res.status(400).json({ msg: "You already have an active subscription" });

    // Check promo eligibility
    const [historyRows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT id FROM user_subscriptions WHERE user_id=? AND status IN ('active','expired','cancelled') LIMIT 1`,
        [user_id],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );
    const isNewUser = historyRows.length === 0;

    // Fetch plan from DB
    const [planRows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT id, title, description, base_price, discount_price, duration_months, razorpay_plan_id
         FROM subscription_plans WHERE plan_key=? AND status='active' LIMIT 1`,
        [plan_key],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );
    if (!planRows.length) return res.status(400).json({ msg: "Invalid or inactive plan" });

    const plan = planRows[0];
    const amount = parseFloat(plan.discount_price) || parseFloat(plan.base_price);

    // Get or create Razorpay Plan
    const razorpayPlanId = await getRazorpayPlanId(plan);

    // Fetch user email & name for Razorpay
    const [userRows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT name, email, phone FROM users WHERE id=? LIMIT 1`,
        [user_id],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );
    const user = userRows[0] || {};

    // Calculate total billing cycles
    // If new user gets 1 free month, we add 1 extra cycle at start via addon OR
    // simply extend end_date by 1 month and let Razorpay handle billing from cycle 2
    // Simplest approach: use addons for the promo free month, billing starts after
    const startAt = Math.floor(Date.now() / 1000) + 60; // starts in 1 minute

    const subscriptionPayload = {
      plan_id: razorpayPlanId,
      total_count: 120, // max cycles (10 years) — cancellation stops it
      quantity: 1,
      customer_notify: 1,
      notify_info: {
        notify_phone: user.phone || undefined,
        notify_email: user.email || undefined,
      },
    };

    // Create Razorpay Subscription
    const rzpSub = await razorpay.subscriptions.create(subscriptionPayload);

    // Compute initial end_date
    const start = new Date();
    const end = new Date();
    end.setMonth(end.getMonth() + plan.duration_months + (isNewUser ? 1 : 0));

    // Cancel any existing pending subscription for this user
    await new Promise((resolve) =>
      db.query(
        `UPDATE user_subscriptions SET status='cancelled' WHERE user_id=? AND status='pending'`,
        [user_id],
        () => resolve()
      )
    );

    // Save pending subscription to DB
    const insertId = await new Promise((resolve, reject) =>
      db.query(
        `INSERT INTO user_subscriptions
         (user_id, plan_id, months, amount_paid, start_date, end_date, status, razorpay_subscription_id, autopay_enabled)
         VALUES (?,?,?,?,?,?,'pending',?,1)`,
        [user_id, plan.id, plan.duration_months, amount, start, end, rzpSub.id],
        (err, result) => (err ? reject(err) : resolve(result.insertId))
      )
    );

    res.json({
      subscription_id: insertId,
      razorpay_subscription_id: rzpSub.id,
      amount,
      is_new_user: isNewUser,
    });
  } catch (err) {
    console.error("Create subscription error:", err);
    res.status(500).json({ msg: err.error?.description || "Failed to create subscription" });
  }
});

/* ==================================================
   2️⃣  PAYMENT SUCCESS (First charge authorized)
================================================== */
router.post("/success", auth, async (req, res) => {
  const user_id = req.user.id;
  const { subscription_id, payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

  if (!subscription_id || !payment_id || !razorpay_subscription_id || !razorpay_signature)
    return res.status(400).json({ msg: "Missing payment data" });

  // ✅ Verify Razorpay signature
  const payload = `${payment_id}|${razorpay_subscription_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(payload)
    .digest("hex");

  if (expectedSignature !== razorpay_signature)
    return res.status(400).json({ msg: "Payment signature verification failed" });

  try {
    // Verify subscription belongs to user
    const [rows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT id, user_id, end_date, amount_paid FROM user_subscriptions
         WHERE id=? AND user_id=? AND status='pending' LIMIT 1`,
        [subscription_id, user_id],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );
    if (!rows.length)
      return res.status(400).json({ msg: "Invalid or already processed subscription" });

    const sub = rows[0];

    // Prevent duplicate payments
    const [payRows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT id FROM subscription_payments WHERE user_subscription_id=? LIMIT 1`,
        [subscription_id],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );
    if (payRows.length) return res.json({ success: true, duplicate: true });

    // Save payment record
    await new Promise((resolve, reject) =>
      db.query(
        `INSERT INTO subscription_payments
         (user_subscription_id, gateway_payment_id, gateway_order_id, amount, status)
         VALUES (?,?,?,?,'success')`,
        [subscription_id, payment_id, razorpay_subscription_id, sub.amount_paid],
        (err) => (err ? reject(err) : resolve())
      )
    );

    // Activate subscription
    await new Promise((resolve, reject) =>
      db.query(
        `UPDATE user_subscriptions SET status='active' WHERE id=?`,
        [subscription_id],
        (err) => (err ? reject(err) : resolve())
      )
    );

    // Grant access
    await new Promise((resolve, reject) =>
      db.query(
        `INSERT INTO user_subscription_access
         (user_id, subscription_id, expires_at, status)
         VALUES (?,?,?,'active')
         ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at), status='active'`,
        [user_id, subscription_id, sub.end_date],
        (err) => (err ? reject(err) : resolve())
      )
    );

    // Notify admin
    db.query(
      `SELECT u.name, sp.title AS plan_title FROM users u
       JOIN user_subscriptions us ON us.id=?
       JOIN subscription_plans sp ON sp.id=us.plan_id
       WHERE u.id=?`,
      [subscription_id, user_id],
      (err, infoRows) => {
        const name = (!err && infoRows.length) ? infoRows[0].name : "A user";
        const plan = (!err && infoRows.length) ? infoRows[0].plan_title : "a plan";
        createAdminNotification(
          "subscription",
          "New Subscription Purchased (Autopay Enabled)",
          `${name} subscribed to ${plan} — ₹${sub.amount_paid} (recurring)`,
          subscription_id
        );
      }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Success handler error:", err);
    res.status(500).json({ msg: "Something went wrong" });
  }
});

/* ==================================================
   3️⃣  RAZORPAY WEBHOOK — handles auto-renewals
   Add this URL in Razorpay Dashboard → Webhooks
   URL: https://yourdomain.com/api/subscription-payment/webhook
   Events: subscription.charged, subscription.cancelled, subscription.completed
================================================== */
router.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  // ✅ Verify webhook authenticity
  const expectedSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(req.body)
    .digest("hex");

  if (expectedSig !== signature) {
    console.warn("Webhook signature mismatch");
    return res.status(400).json({ msg: "Invalid signature" });
  }

  const event = JSON.parse(req.body.toString());
  const { event: eventName, payload } = event;

  if (eventName === "subscription.charged") {
    // Auto-renewal payment succeeded — extend access
    const rzpSubId = payload.subscription?.entity?.id;
    const paymentId = payload.payment?.entity?.id;
    const amountPaid = (payload.payment?.entity?.amount || 0) / 100;

    if (!rzpSubId) return res.json({ ok: true });

    db.query(
      `SELECT us.id, us.user_id, us.months, us.end_date, sp.duration_months
       FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.razorpay_subscription_id=? AND us.status='active'
       ORDER BY us.created_at DESC LIMIT 1`,
      [rzpSubId],
      (err, rows) => {
        if (err || !rows.length) return res.json({ ok: true });

        const sub = rows[0];
        const currentEnd = new Date(sub.end_date);
        const newEnd = new Date(currentEnd);
        newEnd.setMonth(newEnd.getMonth() + sub.duration_months);

        // Extend end_date
        db.query(
          `UPDATE user_subscriptions SET end_date=? WHERE id=?`,
          [newEnd, sub.id],
          (err) => {
            if (err) console.error("Failed to extend subscription:", err);
          }
        );

        // Extend access
        db.query(
          `UPDATE user_subscription_access SET expires_at=? WHERE subscription_id=?`,
          [newEnd, sub.id],
          (err) => {
            if (err) console.error("Failed to extend access:", err);
          }
        );

        // Log renewal payment
        db.query(
          `INSERT INTO subscription_payments
           (user_subscription_id, gateway_payment_id, gateway_order_id, amount, status)
           VALUES (?,?,?,'auto_renewal','success')`,
          [sub.id, paymentId, rzpSubId, amountPaid],
          (err) => {
            if (err) console.error("Failed to log renewal payment:", err);
          }
        );

        // Notify admin
        createAdminNotification(
          "subscription",
          "Subscription Auto-Renewed",
          `Auto-renewal for subscription #${sub.id} — ₹${amountPaid}`,
          sub.id
        );
      }
    );
  }

  if (eventName === "subscription.cancelled" || eventName === "subscription.completed") {
    const rzpSubId = payload.subscription?.entity?.id;
    if (!rzpSubId) return res.json({ ok: true });

    db.query(
      `UPDATE user_subscriptions SET autopay_enabled=0 WHERE razorpay_subscription_id=?`,
      [rzpSubId],
      (err) => {
        if (err) console.error("Failed to update autopay status:", err);
      }
    );
  }

  res.json({ ok: true });
});

/* ==================================================
   4️⃣  CANCEL AUTOPAY (User request)
================================================== */
router.post("/cancel-autopay", auth, async (req, res) => {
  const user_id = req.user.id;

  try {
    const [rows] = await new Promise((resolve, reject) =>
      db.query(
        `SELECT id, razorpay_subscription_id FROM user_subscriptions
         WHERE user_id=? AND status='active' AND autopay_enabled=1
         ORDER BY created_at DESC LIMIT 1`,
        [user_id],
        (err, rows) => (err ? reject(err) : resolve([rows]))
      )
    );

    if (!rows.length)
      return res.status(400).json({ msg: "No active autopay subscription found" });

    const { id, razorpay_subscription_id } = rows[0];

    // Cancel on Razorpay (cancel_at_cycle_end=1 means it won't renew after current period)
    await razorpay.subscriptions.cancel(razorpay_subscription_id, { cancel_at_cycle_end: 1 });

    // Mark autopay as disabled (access remains until end_date)
    await new Promise((resolve, reject) =>
      db.query(
        `UPDATE user_subscriptions SET autopay_enabled=0 WHERE id=?`,
        [id],
        (err) => (err ? reject(err) : resolve())
      )
    );

    res.json({ success: true, msg: "Autopay cancelled. Your access continues until the current period ends." });
  } catch (err) {
    console.error("Cancel autopay error:", err);
    res.status(500).json({ msg: err.error?.description || "Failed to cancel autopay" });
  }
});

/* ==================================================
   5️⃣  CHECK ACTIVE SUBSCRIPTION
================================================== */
router.get("/check", auth, (req, res) => {
  const user_id = req.user.id;
  db.query(
    `SELECT * FROM user_subscription_access
     WHERE user_id=? AND status='active' AND expires_at >= CURDATE() LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err) return res.json({ active: false });
      res.json({ active: rows.length > 0, subscription: rows[0] || null });
    }
  );
});

module.exports = router;