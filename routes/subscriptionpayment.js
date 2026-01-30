const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

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
   USER SUBSCRIPTION DETAILS
================================================== */
router.get("/me", auth, (req, res) => {
  const user_id = req.user.id;

  db.query(
    `SELECT 
       us.id AS subscription_id,
       sp.title,
       sp.plan_key,
       us.months,
       us.amount_paid,
       us.start_date,
       us.end_date,
       us.status
     FROM user_subscriptions us
     JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.user_id=?
     ORDER BY us.created_at DESC
     LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ msg: "DB error" });
      }

      res.json({
        active: rows.length > 0,
        subscription: rows[0] || null,
      });
    }
  );
});


/* ==================================================
   USER SUBSCRIPTION PAYMENTS
================================================== */
router.get("/payments", auth, (req, res) => {
  const user_id = req.user.id;

  db.query(
    `SELECT 
       sp.gateway_payment_id,
       sp.gateway_order_id,
       sp.amount,
       sp.status,
       sp.created_at
     FROM subscription_payments sp
     JOIN user_subscriptions us ON us.id = sp.user_subscription_id
     WHERE us.user_id=?
     ORDER BY sp.created_at DESC`,
    [user_id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.json([]);
      }

      res.json(rows);
    }
  );
});


/* ==================================================
   1️⃣ CREATE SUBSCRIPTION (PRE-PAY)
================================================== */
router.post("/create", auth, (req, res) => {
  const user_id = req.user.id;
  const { plan, months } = req.body;

  if (!plan || !months) {
    return res.status(400).json({ msg: "Missing fields" });
  }

  /* 1️⃣ BLOCK IF USER ALREADY HAS ACTIVE SUBSCRIPTION */
  db.query(
    `SELECT id FROM user_subscriptions
     WHERE user_id=? AND status='active'
       AND end_date >= CURDATE()
     LIMIT 1`,
    [user_id],
    (err, activeRows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ msg: "DB error" });
      }

      if (activeRows.length > 0) {
        return res.status(400).json({
          msg: "You already have an active subscription",
        });
      }

      /* 2️⃣ FETCH PLAN DETAILS */
      db.query(
        `SELECT id, base_price
         FROM subscription_plans
         WHERE plan_key=? AND status='active'
         LIMIT 1`,
        [plan],
        (err, planRows) => {
          if (err || planRows.length === 0) {
            return res.status(400).json({ msg: "Invalid plan" });
          }

          const plan_id = planRows[0].id;
          const pricePerMonth = planRows[0].base_price;
          const amount = pricePerMonth * months;

          const start = new Date();
          const end = new Date();
          end.setMonth(end.getMonth() + months);

          /* 3️⃣ CHECK EXISTING PENDING SUBSCRIPTION */
          db.query(
            `SELECT id FROM user_subscriptions
             WHERE user_id=? AND status='pending'
             ORDER BY created_at DESC
             LIMIT 1`,
            [user_id],
            (err, pendingRows) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ msg: "DB error" });
              }

              /* ♻️ REUSE PENDING SUBSCRIPTION */
              if (pendingRows.length > 0) {
                return res.json({
                  subscription_id: pendingRows[0].id,
                  amount,
                  reused: true,
                });
              }

              /* 4️⃣ CREATE NEW PENDING SUBSCRIPTION */
              db.query(
                `INSERT INTO user_subscriptions
                 (user_id, plan_id, months, amount_paid, start_date, end_date, status)
                 VALUES (?,?,?,?,?,?,'pending')`,
                [user_id, plan_id, months, amount, start, end],
                (err, result) => {
                  if (err) {
                    console.error(err);
                    return res.status(500).json({ msg: "DB error" });
                  }

                  res.json({
                    subscription_id: result.insertId,
                    amount,
                    reused: false,
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});


/* ==================================================
   2️⃣ PAYMENT SUCCESS (RAZORPAY)
================================================== */
router.post("/success", auth, (req, res) => {
  const user_id = req.user.id;
  const { subscription_id, payment_id, order_id, amount } = req.body;

  if (!subscription_id || !payment_id) {
    return res.status(400).json({ msg: "Missing payment data" });
  }

  /* 1️⃣ VERIFY SUBSCRIPTION BELONGS TO USER & IS PENDING */
  db.query(
    `SELECT id, user_id, end_date
     FROM user_subscriptions
     WHERE id=? AND user_id=? AND status='pending'
     LIMIT 1`,
    [subscription_id, user_id],
    (err, rows) => {
      if (err || rows.length === 0) {
        return res.status(400).json({
          msg: "Invalid or already processed subscription",
        });
      }

      /* 2️⃣ PREVENT DUPLICATE PAYMENT */
      db.query(
        `SELECT id FROM subscription_payments
         WHERE user_subscription_id=?
         LIMIT 1`,
        [subscription_id],
        (err, payRows) => {
          if (payRows.length > 0) {
            return res.json({ success: true, duplicate: true });
          }

          /* 3️⃣ SAVE PAYMENT */
          db.query(
            `INSERT INTO subscription_payments
             (user_subscription_id, gateway_payment_id, gateway_order_id, amount, status)
             VALUES (?,?,?,?, 'success')`,
            [subscription_id, payment_id, order_id, amount],
            (err) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ msg: "Payment save failed" });
              }

              /* 4️⃣ ACTIVATE SUBSCRIPTION */
              db.query(
                `UPDATE user_subscriptions
                 SET status='active'
                 WHERE id=?`,
                [subscription_id],
                () => {

                  /* 5️⃣ GRANT ACCESS */
                  db.query(
                    `INSERT INTO user_subscription_access
                     (user_id, subscription_id, expires_at, status)
                     VALUES (?, ?, ?, 'active')
                     ON DUPLICATE KEY UPDATE
                     expires_at=VALUES(expires_at),
                     status='active'`,
                    [user_id, subscription_id, rows[0].end_date],
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


/* ==================================================
   3️⃣ CHECK ACTIVE SUBSCRIPTION
================================================== */
router.get("/check", auth, (req, res) => {
  const user_id = req.user.id;

  db.query(
    `SELECT *
     FROM user_subscription_access
     WHERE user_id=?
       AND status='active'
       AND expires_at >= CURDATE()
     LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err) return res.json({ active: false });

      res.json({
        active: rows.length > 0,
        subscription: rows[0] || null,
      });
    }
  );
});

module.exports = router;
