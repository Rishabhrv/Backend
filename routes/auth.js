const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

const nodemailer = require("nodemailer");

// In-memory OTP store (use Redis in production)
const otpStore = new Map();

// Configure your email transporter
const transporter = nodemailer.createTransport({
  service: "gmail", // or use SMTP config
  auth: {
    user: process.env.MAIL_USER,   // your email
    pass: process.env.MAIL_PASS,   // app password
  },
});

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
      // if (user.provider !== "local") {
      //   return res.status(400).json({
      //     msg: "This email is registered with Google login.",
      //   });
      // }

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




/* FORGOT PASSWORD - Send OTP */
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ msg: "Email is required" });

  // Check if user exists
  db.query("SELECT id FROM users WHERE email = ?", [email], async (err, rows) => {
    if (err) return res.status(500).json({ msg: "DB error" });
    if (!rows.length) return res.status(404).json({ msg: "No account found with this email" });

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(email, { otp, expiresAt });

    // Send OTP email
    try {
      await transporter.sendMail({
        from: `"AGPH Support" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Your Password Reset OTP",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
            <h2>Password Reset</h2>
            <p>Use the OTP below to reset your password. It expires in <strong>10 minutes</strong>.</p>
            <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background: #f4f4f4; border-radius: 8px;">
              ${otp}
            </div>
            <p style="color: #888; margin-top: 16px;">If you didn't request this, please ignore this email.</p>
          </div>
        `,
      });

      res.json({ msg: "OTP sent to your email" });
    } catch (emailErr) {
      console.error("Email send error:", emailErr);
      res.status(500).json({ msg: "Failed to send OTP email" });
    }
  });
});


/* VERIFY OTP */
router.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ msg: "Email and OTP are required" });

  const record = otpStore.get(email);

  if (!record) return res.status(400).json({ msg: "OTP not found. Please request a new one." });
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ msg: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp) return res.status(400).json({ msg: "Invalid OTP" });

  // OTP is valid — don't delete yet, needed for reset-password verification
  res.json({ msg: "OTP verified" });
});


/* RESET PASSWORD */
router.post("/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ msg: "All fields are required" });

  const record = otpStore.get(email);

  if (!record) return res.status(400).json({ msg: "OTP not found. Please request a new one." });
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ msg: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp) return res.status(400).json({ msg: "Invalid OTP" });

  // Hash new password
  const hash = await bcrypt.hash(newPassword, 10);

  db.query("UPDATE users SET password = ? WHERE email = ?", [hash, email], (err) => {
    if (err) return res.status(500).json({ msg: "DB error" });

    otpStore.delete(email); // Clear OTP after successful reset
    res.json({ msg: "Password reset successfully" });
  });
});



module.exports = router;
