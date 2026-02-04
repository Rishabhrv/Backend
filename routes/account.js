const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const bcrypt = require("bcryptjs");

const router = express.Router();  
const SECRET = "MY_SECRET_KEY";

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* PROFILE */
router.get("/profile", auth, (req, res) => {
  db.query(
    "SELECT id, name, email, phone, google_id FROM users WHERE id = ?",
    [req.user.id],
    (err, rows) => res.json(rows[0])
  );
});

router.put("/profile", auth, (req, res) => {
  const { name, phone } = req.body;

  db.query(
    "UPDATE users SET name = ?, phone = ? WHERE id = ?",
    [name, phone, req.user.id],
    () => res.json({ msg: "Updated" })
  );
});

/* ADDRESS */
router.get("/address", auth, (req, res) => {
  db.query(
    "SELECT * FROM user_addresses WHERE user_id = ?",
    [req.user.id],
    (err, rows) => res.json(rows[0] || null)
  );
});


router.post("/update-profile", auth, (req, res) => {
  const { name, phone } = req.body;

  db.query(
    "UPDATE users SET name=?, phone=? WHERE id=?",
    [name, phone, req.user.id],
    () => res.json({ msg: "Profile updated" })
  );
});




/* ================= PASSWORD UPDATE ================= */
router.put("/password", auth, async (req, res) => {
  const { password } = req.body;

  if (!password || password.length < 6) {
    return res.status(400).json({
      msg: "Password must be at least 6 characters",
    });
  }

  try {
    // 🔐 HASH PASSWORD
    const hashedPassword = await bcrypt.hash(password, 10);

    db.query(
      "UPDATE users SET password = ? WHERE id = ?",
      [hashedPassword, req.user.id],
      (err) => {
        if (err) {
          console.error("Password update error:", err);
          return res.status(500).json({ msg: "Database error" });
        }

        res.json({ msg: "Password updated successfully" });
      }
    );
  } catch (err) {
    console.error("Hash error:", err);
    res.status(500).json({ msg: "Failed to update password" });
  }
});



router.put("/address", auth, (req, res) => {
  const { address, city, state, country, pincode } = req.body;

  db.query(
    "SELECT id FROM user_addresses WHERE user_id = ?",
    [req.user.id],
    (err, rows) => {
      if (rows.length) {
        db.query(
          `UPDATE user_addresses 
           SET address=?, city=?, state=?, country=?, pincode=?
           WHERE user_id=?`,
          [address, city, state, country, pincode, req.user.id]
        );
      } else {
        db.query(
          `INSERT INTO user_addresses
           (user_id, address, city, state, country, pincode)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.user.id, address, city, state, country, pincode]
        );
      }

      res.json({ msg: "Saved" });
    }
  );
});

module.exports = router;
