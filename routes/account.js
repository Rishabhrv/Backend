const express    = require("express");
const jwt        = require("jsonwebtoken");
const db         = require("../db");
const bcrypt     = require("bcryptjs");
const nodemailer = require("nodemailer");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

/* ─── In-memory OTP store (use Redis in prod) ─── */
const otpStore = new Map();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

/* ─── Auth middleware ─── */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ════════════════════════════════════════
   GET /api/account/profile
════════════════════════════════════════ */
router.get("/profile", auth, (req, res) => {
  db.query(
    "SELECT id, name, email, phone, google_id FROM users WHERE id = ?",
    [req.user.id],
    (err, rows) => res.json(rows[0])
  );
});

/* ════════════════════════════════════════
   PUT /api/account/profile  (name + phone only)
════════════════════════════════════════ */
router.put("/profile", auth, (req, res) => {
  const { name, phone } = req.body;
  db.query(
    "UPDATE users SET name = ?, phone = ? WHERE id = ?",
    [name, phone, req.user.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json({ msg: "Profile updated" });
    }
  );
});

/* ════════════════════════════════════════
   GET /api/account/address
════════════════════════════════════════ */
router.get("/address", auth, (req, res) => {
  db.query(
    "SELECT * FROM user_addresses WHERE user_id = ?",
    [req.user.id],
    (err, rows) => res.json(rows[0] || null)
  );
});

/* ════════════════════════════════════════
   PUT /api/account/address
════════════════════════════════════════ */
router.put("/address", auth, (req, res) => {
  const { address, city, state, country, pincode } = req.body;

  db.query(
    "SELECT id FROM user_addresses WHERE user_id = ?",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      const sql = rows.length
        ? `UPDATE user_addresses SET address=?, city=?, state=?, country=?, pincode=? WHERE user_id=?`
        : `INSERT INTO user_addresses (address, city, state, country, pincode, user_id) VALUES (?,?,?,?,?,?)`;

      db.query(sql, [address, city, state, country, pincode, req.user.id], (err) => {
        if (err) return res.status(500).json({ msg: "DB error" });
        res.json({ msg: "Address saved" });
      });
    }
  );
});

/* ════════════════════════════════════════
   PUT /api/account/password
════════════════════════════════════════ */
router.put("/password", auth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6)
    return res.status(400).json({ msg: "Password must be at least 6 characters" });

  try {
    const hash = await bcrypt.hash(password, 10);
    db.query("UPDATE users SET password = ? WHERE id = ?", [hash, req.user.id], (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json({ msg: "Password updated successfully" });
    });
  } catch {
    res.status(500).json({ msg: "Failed to update password" });
  }
});

/* ════════════════════════════════════════
   POST /api/account/send-email-otp
   — Sends OTP to the NEW email the user wants to use.
   — Checks the new email isn't already taken.
════════════════════════════════════════ */
router.post("/send-email-otp", auth, async (req, res) => {
  const { newEmail } = req.body;
  if (!newEmail) return res.status(400).json({ msg: "New email is required" });

  // Make sure the new email isn't already in use by someone else
  db.query(
    "SELECT id FROM users WHERE email = ? AND id != ?",
    [newEmail, req.user.id],
    async (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (rows.length)
        return res.status(409).json({ msg: "This email is already associated with another account." });

      const otp       = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min

      otpStore.set(`email-change:${req.user.id}`, { otp, newEmail, expiresAt });

      try {
        await transporter.sendMail({
          from:    `"AGPH Books" <${process.env.MAIL_USER}>`,
          to:      newEmail,
          subject: "Verify your new email — AGPH Books",
          html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
        style="max-width:480px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#111827;padding:28px 32px;">
            <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">AGPH Books</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.55);font-size:12px;">Email Change Verification</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px;">
            <h2 style="margin:0 0 10px;font-size:20px;color:#111827;">Verify your new email</h2>
            <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">
              Use the code below to confirm this email address on your account. It expires in <strong>10 minutes</strong>.
            </p>
            <div style="text-align:center;margin:0 0 28px;">
              <div style="display:inline-block;background:#f3f4f6;border:2px dashed #d1d5db;border-radius:12px;padding:20px 40px;">
                <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#111827;font-family:monospace;">${otp}</span>
              </div>
            </div>
            <p style="margin:0;font-size:13px;color:#9ca3af;">
              If you didn't request this change, your account may be at risk — please contact support immediately.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">© ${new Date().getFullYear()} AGPH Books. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
        });

        res.json({ msg: "Verification code sent to your new email" });
      } catch (mailErr) {
        console.error("Mail error:", mailErr);
        res.status(500).json({ msg: "Failed to send verification email" });
      }
    }
  );
});

/* ════════════════════════════════════════
   PUT /api/account/email
   — Verifies OTP then updates the email
   Body: { otp }
════════════════════════════════════════ */
router.put("/email", auth, (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ msg: "OTP is required" });

  const key    = `email-change:${req.user.id}`;
  const record = otpStore.get(key);

  if (!record)
    return res.status(400).json({ msg: "No pending email change. Please request a new code." });

  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return res.status(400).json({ msg: "Code has expired. Please request a new one." });
  }

  if (record.otp !== String(otp).trim())
    return res.status(400).json({ msg: "Invalid code. Please try again." });

  // OTP valid — update email
  db.query(
    "UPDATE users SET email = ? WHERE id = ?",
    [record.newEmail, req.user.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      otpStore.delete(key);
      res.json({ msg: "Email updated successfully", email: record.newEmail });
    }
  );
});

module.exports = router;