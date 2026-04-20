const express = require("express");
const router = express.Router();
const db = require("../db"); // Adjust path if necessary

/* ===============================
   GET ALL PLANS (For the public frontend)
================================ */
router.get("/subscription-plans", (req, res) => {
  const sql = `SELECT * FROM subscription_plans ORDER BY duration_months ASC`;
  
  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Error fetching plans:", err);
      return res.status(500).json({ msg: "Database error" });
    }

    // CRITICAL FIX: Parse the features JSON string into a real array
    const plansWithFeatures = rows.map(row => {
      let parsedFeatures = [];
      if (row.features) {
        try {
          // If it's a string, parse it. If it's already an array, keep it.
          parsedFeatures = typeof row.features === 'string' ? JSON.parse(row.features) : row.features;
        } catch (e) {
          parsedFeatures = [];
        }
      }
      return {
        ...row,
        features: parsedFeatures
      };
    });

    res.json(plansWithFeatures);
  });
});

/* ===============================
   CREATE NEW PLAN
================================ */
router.post("/subscription-plans", (req, res) => {
  // CRITICAL FIX: Added 'features' to the destructured body
  const { plan_key, title, base_price, duration_months, description, status, features } = req.body;

  // Turn the array into a JSON string for the database
  const featuresJson = JSON.stringify(features || []);

  // 1. Check if a plan with this key already exists
  const checkSql = `SELECT id FROM subscription_plans WHERE plan_key = ?`;
  db.query(checkSql, [plan_key], (err, rows) => {
    if (err) return res.status(500).json(err);
    
    // If it exists, block the creation
    if (rows.length > 0) {
      return res.status(400).json({ msg: `A ${plan_key} plan already exists. You can only have one.` });
    }

    // 2. If it doesn't exist, create it (Added features column)
    const insertSql = `
      INSERT INTO subscription_plans (plan_key, title, base_price, duration_months, description, status, features)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      insertSql,
      [plan_key, title, base_price, duration_months, description, status || 'active', featuresJson],
      (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ success: true, id: result.insertId });
      }
    );
  });
});

module.exports = router;