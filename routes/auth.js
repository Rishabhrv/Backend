const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

const nodemailer = require("nodemailer");

// In-memory OTP store (use Redis in production)
const otpStore = new Map();



const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST || "smtp.gmail.com",
  port:   Number(process.env.MAIL_PORT) || 587,
  secure: Number(process.env.MAIL_PORT) === 465,  // true for 465, false for 587
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
/* ════════════════════════════════════════
   GET LOGGED IN USER
════════════════════════════════════════ */
router.get("/me", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ msg: "No token" });

  const token = authHeader.split(" ")[1];

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });

    db.query(
      "SELECT id, name, email FROM users WHERE id = ?",
      [decoded.id],
      (err, rows) => {
        if (err) return res.status(500).json({ msg: "DB error" });
        if (!rows.length) return res.status(404).json({ msg: "User not found" });
        res.json(rows[0]);
      }
    );
  });
});


/* ════════════════════════════════════════
   SEND REGISTRATION OTP
   — Checks email not already taken, then sends OTP
════════════════════════════════════════ */
router.post("/send-register-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ msg: "Email is required" });

  // Check if email already registered
  db.query("SELECT id FROM users WHERE email = ?", [email], async (err, rows) => {
    if (err) return res.status(500).json({ msg: "DB error" });
    if (rows.length > 0)
      return res.status(409).json({ msg: "Email already registered. Please login." });

    const otp       = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min

    // Store with a "register" type so it can't be reused for password reset
    otpStore.set(`register:${email}`, { otp, expiresAt });

    try {
      await transporter.sendMail({
        from:    `"AGPH Books Store" <${process.env.MAIL_USER}>`,
        to:      email,
        subject: "Verify your email — AGPH Books Store",
        html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
        style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#111827;padding:28px 32px;">
            <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">AGPH Books Store</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.55);font-size:12px;">Email Verification</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 32px;">
            <h2 style="margin:0 0 10px;font-size:20px;color:#111827;">Verify your email</h2>
            <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">
              Use the one-time code below to complete your registration. It expires in <strong>10 minutes</strong>.
            </p>

            <!-- OTP Box -->
            <div style="text-align:center;margin:0 0 28px;">
              <div style="display:inline-block;background:#f3f4f6;border:2px dashed #d1d5db;border-radius:12px;padding:20px 40px;">
                <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#111827;font-family:monospace;">${otp}</span>
              </div>
            </div>

            <p style="margin:0;font-size:13px;color:#9ca3af;">
              If you didn't create an account with AGPH Books Store, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">© ${new Date().getFullYear()} AGPH Books Store. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      });

      res.json({ msg: "OTP sent to your email" });
    } catch (emailErr) {
      console.error("Email send error:", emailErr);
      res.status(500).json({ msg: "Failed to send OTP. Try again." });
    }
  });
});


/* ════════════════════════════════════════
   REGISTER  (now requires OTP)
   Body: { name, email, password, otp }
════════════════════════════════════════ */
router.post("/register", async (req, res) => {
  const { name, email, password, otp } = req.body;

  if (!name || !email || !password || !otp)
    return res.status(400).json({ msg: "All fields including OTP are required" });

  // Verify OTP
  const key    = `register:${email}`;
  const record = otpStore.get(key);

  if (!record)
    return res.status(400).json({ msg: "OTP not found. Please request a new one." });

  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return res.status(400).json({ msg: "OTP has expired. Please request a new one." });
  }

  if (record.otp !== otp)
    return res.status(400).json({ msg: "Invalid OTP. Please check and try again." });

  // OTP valid — create the account
  otpStore.delete(key);

  const hash = await bcrypt.hash(password, 10);

  db.query(
    "INSERT INTO users (name, email, password, provider) VALUES (?, ?, ?, 'local')",
    [name, email, hash],
    (err) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY")
          return res.status(400).json({ msg: "Email already exists. Please login." });
        return res.status(500).json({ msg: "DB error" });
      }
      res.json({ msg: "Account created successfully. Please login." });
    }
  );
});


/* ════════════════════════════════════════
   LOGIN
════════════════════════════════════════ */
router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const identifier = email?.toLowerCase().trim();

  if (!identifier) return res.status(400).json({ msg: "Email is required." });

  const windowStart = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000);

  // 1. Count recent failed attempts
  db.query(
    `SELECT COUNT(*) AS attempts FROM login_attempts
     WHERE identifier = ? AND attempted_at > ?`,
    [identifier, windowStart],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      const attempts = rows[0].attempts;

      if (attempts >= MAX_ATTEMPTS) {
        // Find when the oldest attempt in the window expires
        db.query(
          `SELECT attempted_at FROM login_attempts
           WHERE identifier = ? AND attempted_at > ?
           ORDER BY attempted_at ASC LIMIT 1`,
          [identifier, windowStart],
          (err2, oldest) => {
            if (err2) return res.status(500).json({ msg: "DB error" });
            const unlockAt    = new Date(new Date(oldest[0].attempted_at).getTime() + LOCKOUT_MINUTES * 60 * 1000);
            const minutesLeft = Math.ceil((unlockAt - Date.now()) / 60000);
            return res.status(429).json({
              msg: `Too many failed attempts. Please try again in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}.`,
              locked: true,
              minutesLeft,
            });
          }
        );
        return;
      }

      // 2. Fetch user
      db.query(
        "SELECT id, password, provider, status FROM users WHERE email = ?",
        [identifier],
        async (err3, result) => {
          if (err3) return res.status(500).json({ msg: "DB error" });

          const user = result[0];
          const valid = user ? await bcrypt.compare(password, user.password) : false;

          if (!user || !valid) {
            // Record failed attempt
            db.query(`INSERT INTO login_attempts (identifier) VALUES (?)`, [identifier]);

            const remaining = MAX_ATTEMPTS - attempts - 1;
            return res.status(400).json({
              msg: remaining > 0
                ? `Incorrect email or password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`
                : `Too many failed attempts. Please try again in ${LOCKOUT_MINUTES} minutes.`,
              remaining,
            });
          }

          if (user.status !== "active") {
            return res.status(403).json({ msg: "Your account has been blocked. Please contact support." });
          }

          // Success — clear attempts
          db.query(`DELETE FROM login_attempts WHERE identifier = ?`, [identifier]);

          const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: "24h" });
          res.json({ token });
        }
      );
    }
  );
});


/* ════════════════════════════════════════
   GOOGLE LOGIN
════════════════════════════════════════ */
router.post("/google/login", (req, res) => {
  const { email, google_id } = req.body;
  if (!email || !google_id)
    return res.status(400).json({ msg: "Invalid Google data" });

  db.query(
    "SELECT id, provider, status FROM users WHERE email = ?",
    [email],
    (err, users) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (users.length === 0)
        return res.status(404).json({ msg: "Account not found. Please sign up first." });

      const user = users[0];

      if (user.status !== "active") {
        return res.status(403).json({
          msg: "Your account has been blocked. Please contact support.",
        });
      }

      if (user.provider !== "google")
        return res.status(400).json({ msg: "This email is registered with password login." });

      const token = jwt.sign({ id: user.id, email }, SECRET, { expiresIn: "1h" });
      res.json({ token });
    }
  );
});


/* ════════════════════════════════════════
   GOOGLE REGISTER
════════════════════════════════════════ */
router.post("/google/register", (req, res) => {
  const { email, name, google_id } = req.body;
  if (!email || !google_id)
    return res.status(400).json({ msg: "Invalid Google data" });

  db.query("SELECT id FROM users WHERE email = ?", [email], (err, users) => {
    if (err) return res.status(500).json({ msg: "DB error" });
    if (users.length > 0)
      return res.status(409).json({ msg: "Account already exists. Please login." });

    db.query(
      "INSERT INTO users (name, email, google_id, provider) VALUES (?, ?, ?, 'google')",
      [name || "Google User", email, google_id],
      (err, result) => {
        if (err) return res.status(500).json({ msg: "Insert failed" });
        const token = jwt.sign({ id: result.insertId, email }, SECRET, { expiresIn: "1h" });
        res.json({ token });
      }
    );
  });
});


/* ════════════════════════════════════════
   GET FULL PROFILE
════════════════════════════════════════ */
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


/* ════════════════════════════════════════
   FORGOT PASSWORD — Send OTP
════════════════════════════════════════ */
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ msg: "Email is required" });

  db.query("SELECT id FROM users WHERE email = ?", [email], async (err, rows) => {
    if (err) return res.status(500).json({ msg: "DB error" });
    if (!rows.length) return res.status(404).json({ msg: "No account found with this email" });

    const otp       = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, { otp, expiresAt });

    try {
      await transporter.sendMail({
        from:    `"AGPH Support" <${process.env.MAIL_USER}>`,
        to:      email,
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


/* ════════════════════════════════════════
   VERIFY OTP  (for password reset)
════════════════════════════════════════ */
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

  res.json({ msg: "OTP verified" });
});


/* ════════════════════════════════════════
   RESET PASSWORD
════════════════════════════════════════ */
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

  const hash = await bcrypt.hash(newPassword, 10);

  db.query("UPDATE users SET password = ? WHERE email = ?", [hash, email], (err) => {
    if (err) return res.status(500).json({ msg: "DB error" });
    otpStore.delete(email);
    res.json({ msg: "Password reset successfully" });
  });
});


module.exports = router;