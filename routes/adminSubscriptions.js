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

/* ===============================
   📋 ALL USER SUBSCRIPTIONS
================================ */
router.get("/subscriptions", adminAuth, (req, res) => {
  const sql = `
    SELECT
      us.id AS subscription_id,
      u.id AS user_id,
      u.name,
      u.email,

      sp.title AS plan_title,
      sp.plan_key,

      us.amount_paid,
      us.start_date,
      us.end_date,
      us.status,
      us.created_at

    FROM user_subscriptions us
    JOIN users u ON u.id = us.user_id
    JOIN subscription_plans sp ON sp.id = us.plan_id
    ORDER BY us.created_at DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

/* ===============================
   📄 SINGLE SUBSCRIPTION DETAIL
================================ */
router.get("/subscriptions/:id", adminAuth, (req, res) => {
  const subscriptionId = req.params.id;

  const sql = `
    SELECT
      us.id AS subscription_id,
      us.amount_paid,
      us.start_date,
      us.end_date,
      us.status,

      u.id AS user_id,
      u.name,
      u.email,
      u.phone,

      sp.title AS plan_title,
      sp.plan_key,
      sp.duration_months,
      sp.description

    FROM user_subscriptions us
    JOIN users u ON u.id = us.user_id
    JOIN subscription_plans sp ON sp.id = us.plan_id
    WHERE us.id = ?
    LIMIT 1
  `;

  db.query(sql, [subscriptionId], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length)
      return res.status(404).json({ msg: "Subscription not found" });

    res.json(rows[0]);
  });
});

/* ===============================
   💳 SUBSCRIPTION PAYMENTS
================================ */
router.get("/subscriptions/:id/payments", adminAuth, (req, res) => {
  const subscriptionId = req.params.id;

  const sql = `
    SELECT
      id,
      payment_gateway,
      gateway_order_id,
      gateway_payment_id,
      amount,
      currency,
      status,
      created_at
    FROM subscription_payments
    WHERE user_subscription_id = ?
    ORDER BY created_at DESC
  `;

  db.query(sql, [subscriptionId], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});



/* ===============================
   ➕ ADMIN ADD SUBSCRIPTION
================================ */
router.post("/subscriptions/create", adminAuth, (req, res) => {
  const { user_id, plan_key, months, amount_paid, payment_id } = req.body;

  if (!user_id || !plan_key || !months) {
    return res.status(400).json({ msg: "Missing fields" });
  }

  db.query(
    `SELECT id FROM user_subscriptions
     WHERE user_id=? AND status='active'
       AND end_date >= CURDATE()
     LIMIT 1`,
    [user_id],
    (err, active) => {
      if (active.length) {
        return res.status(400).json({
          msg: "User already has an active subscription",
        });
      }

      db.query(
        `SELECT id, base_price
         FROM subscription_plans
         WHERE plan_key=? AND status='active'
         LIMIT 1`,
        [plan_key],
        (err, plans) => {
          if (!plans.length) {
            return res.status(400).json({ msg: "Invalid plan" });
          }

          const plan_id = plans[0].id;
          const price =
            amount_paid !== null && amount_paid !== undefined
              ? amount_paid
              : plans[0].base_price * months;

          const start = new Date();
          const end = new Date();
          end.setMonth(end.getMonth() + months);

          db.query(
            `INSERT INTO user_subscriptions
             (user_id, plan_id, months, amount_paid, start_date, end_date, status)
             VALUES (?,?,?,?,?,?,'active')`,
            [user_id, plan_id, months, price, start, end],
            (err, result) => {
              if (err) return res.status(500).json(err);

              const subscriptionId = result.insertId;

              // 💳 ADMIN PAYMENT RECORD (WITH PAYMENT ID)
              db.query(
                `INSERT INTO subscription_payments
                 (user_subscription_id, payment_gateway, gateway_payment_id, amount, status)
                 VALUES (?,?,?,?, 'success')`,
                [
                  subscriptionId,
                  "admin",
                  payment_id || "ADMIN-MANUAL",
                  price,
                ],
                () => {
                  // 🔓 ACCESS GRANT
                  db.query(
                    `INSERT INTO user_subscription_access
                     (user_id, subscription_id, expires_at, status)
                     VALUES (?, ?, ?, 'active')
                     ON DUPLICATE KEY UPDATE
                       subscription_id=VALUES(subscription_id),
                       expires_at=VALUES(expires_at),
                       status='active'`,
                    [user_id, subscriptionId, end],
                    () => {
                      res.json({ success: true });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});


/* ===============================
   🗑 DELETE SUBSCRIPTION (ADMIN)
================================ */
router.delete("/subscriptions/:id", adminAuth, (req, res) => {
  const subscriptionId = req.params.id;

  // 1️⃣ Get user_id for access cleanup
  db.query(
    `SELECT user_id FROM user_subscriptions WHERE id=?`,
    [subscriptionId],
    (err, rows) => {
      if (err || !rows.length) {
        return res.status(404).json({ msg: "Subscription not found" });
      }

      const userId = rows[0].user_id;

      // 2️⃣ Delete payments
      db.query(
        `DELETE FROM subscription_payments WHERE user_subscription_id=?`,
        [subscriptionId],
        () => {
          // 3️⃣ Delete access
          db.query(
            `DELETE FROM user_subscription_access WHERE subscription_id=?`,
            [subscriptionId],
            () => {
              // 4️⃣ Delete subscription
              db.query(
                `DELETE FROM user_subscriptions WHERE id=?`,
                [subscriptionId],
                () => {
                  res.json({ success: true });
                }
              );
            }
          );
        }
      );
    }
  );
});


/* ===============================
   👥 GET USERS (FOR SUBSCRIPTION)
================================ */
router.get("/users", adminAuth, (req, res) => {
  const sql = `
    SELECT id, name, email
    FROM users
    WHERE role='customer' AND status='active'
    ORDER BY name ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


module.exports = router;
