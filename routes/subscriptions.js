const express = require("express");
const router = express.Router();
const db = require("../db");


/* GET ALL PLANS */
router.get("/plans", (req, res) => {
  db.query(
    "SELECT * FROM subscription_plans WHERE status='active'",
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});



module.exports = router;
