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

module.exports = router;
