const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

/* GET LOGGED IN USER */
router.get("/me", (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({ msg: "No token" });

  const token = authHeader.split(" ")[1];

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });

    db.query(
      "SELECT id, name, email FROM users WHERE id = ?",
      [decoded.id],
      (err, rows) => {
        if (err) return res.status(500).json({ msg: "DB error" });
        if (!rows.length)
          return res.status(404).json({ msg: "User not found" });

        res.json(rows[0]);
      }
    );
  });
});


/* REGISTER */
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;

  const hash = await bcrypt.hash(password, 10);

  db.query(
    "INSERT INTO users (name, email, password, provider) VALUES (?, ?, ?, 'local')",
    [name, email, hash],
    (err) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") {
          return res.status(400).json({
            msg: "Email already exists. Please login.",
          });
        }
        return res.status(500).json({ msg: "DB error" });
      }

      res.json({ msg: "Registered successfully" });
    }
  );
});


/* LOGIN */
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT id, password, provider FROM users WHERE email = ?",
    [email],
    async (err, result) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      if (result.length === 0) {
        return res.status(400).json({ msg: "User not found" });
      }

      const user = result[0];

      // 🔥 VERY IMPORTANT
      if (user.provider !== "local") {
        return res.status(400).json({
          msg: "This email is registered with Google login.",
        });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(400).json({ msg: "Wrong password" });
      }

      const token = jwt.sign(
        { id: user.id },
        SECRET,
        { expiresIn: "1h" }
      );

      res.json({ token });
    }
  );
});


router.post("/google/login", (req, res) => {
  const { email, google_id } = req.body;

  if (!email || !google_id)
    return res.status(400).json({ msg: "Invalid Google data" });

  db.query(
    "SELECT id, provider FROM users WHERE email = ?",
    [email],
    (err, users) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      if (users.length === 0) {
        return res.status(404).json({
          msg: "Account not found. Please sign up first.",
        });
      }

      if (users[0].provider !== "google") {
        return res.status(400).json({
          msg: "This email is registered with password login.",
        });
      }

      const token = jwt.sign(
        { id: users[0].id, email },
        SECRET,
        { expiresIn: "1h" }
      );

      res.json({ token });
    }
  );
});



router.post("/google/register", (req, res) => {
  const { email, name, google_id } = req.body;

  if (!email || !google_id)
    return res.status(400).json({ msg: "Invalid Google data" });

  db.query(
    "SELECT id FROM users WHERE email = ?",
    [email],
    (err, users) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      if (users.length > 0) {
        return res.status(409).json({
          msg: "Account already exists. Please login.",
        });
      }

      db.query(
        `INSERT INTO users (name, email, google_id, provider)
         VALUES (?, ?, ?, 'google')`,
        [name || "Google User", email, google_id],
        (err, result) => {
          if (err) return res.status(500).json({ msg: "Insert failed" });

          const token = jwt.sign(
            { id: result.insertId, email },
            SECRET,
            { expiresIn: "1h" }
          );

          res.json({ token });
        }
      );
    }
  );
});


/* GET FULL PROFILE */
router.get("/profile", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ msg: "No token" });

  const token = authHeader.split(" ")[1];

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });

    const sql = `
      SELECT 
        u.id, u.name, u.email, u.phone, u.role, u.status, u.provider,
        a.address, a.city, a.state, a.country, a.pincode
      FROM users u
      LEFT JOIN user_addresses a ON a.user_id = u.id
      WHERE u.id = ?
    `;

    db.query(sql, [decoded.id], (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows[0]);
    });
  });
});





module.exports = router;
