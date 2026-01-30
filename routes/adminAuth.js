const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db"); // your mysql connection

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

/**
 * ADMIN LOGIN
 * POST /api/admin/login
 */
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ msg: "Email and password required" });
  }

  db.query(
    `SELECT id, name, email, password, role, status 
     FROM users 
     WHERE email = ? AND role = 'admin' 
     LIMIT 1`,
    [email],
    async (err, rows) => {
      if (err) return res.status(500).json({ msg: "Database error" });

      if (rows.length === 0) {
        return res.status(403).json({
          msg: "Admin access only",
        });
      }

      const admin = rows[0];

      if (admin.status !== "active") {
        return res.status(403).json({
          msg: "Admin account is blocked",
        });
      }

      const isMatch = await bcrypt.compare(password, admin.password);
      if (!isMatch) {
        return res.status(401).json({ msg: "Invalid credentials" });
      }

      // ✅ ADMIN TOKEN
      const token = jwt.sign(
        {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: "admin",
        },
        SECRET,
        { expiresIn: "1d" }
      );

      res.json({
        token,
        admin: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
        },
      });
    }
  );
});

module.exports = router;
