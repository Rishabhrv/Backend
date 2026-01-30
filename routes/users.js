const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");
const SECRET = "MY_SECRET_KEY";

/* 🔐 INLINE ADMIN AUTH MIDDLEWARE */
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ msg: "No authorization header" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ msg: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({ msg: "Admin access only" });
    }

    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ msg: "Invalid or expired token" });
  }
}

/* 👥 GET ALL USERS (ADMIN ONLY) */
router.get("/users", adminAuth, (req, res) => {
  db.query(
    `SELECT id, name, email, phone, role, status, provider, created_at
     FROM users
     ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ msg: "Database error" });
      }

      res.json(rows);
    }
  );
});

module.exports = router;

