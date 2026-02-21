const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs"); // ← bcryptjs
const router = express.Router();
const db = require("../db");
const SECRET = "MY_SECRET_KEY";
const nodemailer = require("nodemailer");
const adminOtpStore = new Map();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ─── Admin Auth Middleware ─── */
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ msg: "Admin only" });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* ════════════════════════
   USERS
════════════════════════ */

/* GET all users */
router.get("/users", adminAuth, (req, res) => {
  db.query(
    `SELECT id, name, email, phone, role, status, provider, created_at
     FROM users ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});

/* GET single user */
router.get("/users/:id", adminAuth, (req, res) => {
  db.query(
    `SELECT id, name, email, phone, role, status, provider, created_at
     FROM users WHERE id = ?`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (!rows.length) return res.status(404).json({ msg: "Not found" });
      res.json(rows[0]);
    }
  );
});

/* PUT update user (name, email, phone, role, status, optional password) */
router.put("/users/:id", adminAuth, async (req, res) => {
  const { name, email, phone, role, status, password } = req.body;

  try {
    let sql, params;

    if (password) {
      const hashedPw = await bcrypt.hash(password, 10);
      sql    = `UPDATE users SET name=?, email=?, phone=?, role=?, status=?, password=? WHERE id=?`;
      params = [name, email, phone, role, status, hashedPw, req.params.id];
    } else {
      sql    = `UPDATE users SET name=?, email=?, phone=?, role=?, status=? WHERE id=?`;
      params = [name, email, phone, role, status, req.params.id];
    }

    db.query(sql, params, (err) => {
      if (err) return res.status(500).json({ msg: "Update failed" });
      res.json({ msg: "User updated" });
    });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

/* DELETE user */
router.delete("/users/:id", adminAuth, (req, res) => {
  db.query("DELETE FROM users WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ msg: "Delete failed" });
    res.json({ msg: "User deleted" });
  });
});

/* ════════════════════════
   ADDRESSES
════════════════════════ */

/* GET addresses for user */
router.get("/users/:id/addresses", adminAuth, (req, res) => {
  db.query(
    `SELECT * FROM user_addresses WHERE user_id = ? LIMIT 1`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows); // frontend takes [0]
    }
  );
});

/* POST add address */
router.post("/users/:id/addresses", adminAuth, (req, res) => {
  const { address, city, state, country, pincode } = req.body;
  db.query(
    `INSERT INTO user_addresses (user_id, address, city, state, country, pincode)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.params.id, address, city, state, country, pincode],
    (err, result) => {
      if (err) return res.status(500).json({ msg: "Insert failed" });
      res.json({ id: result.insertId, user_id: Number(req.params.id), address, city, state, country, pincode });
    }
  );
});

/* PUT update address */
router.put("/users/:id/addresses/:addrId", adminAuth, (req, res) => {
  const { address, city, state, country, pincode } = req.body;
  db.query(
    `UPDATE user_addresses SET address=?, city=?, state=?, country=?, pincode=?
     WHERE id=? AND user_id=?`,
    [address, city, state, country, pincode, req.params.addrId, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "Update failed" });
      res.json({ msg: "Address updated" });
    }
  );
});

/* DELETE address */
router.delete("/users/:id/addresses/:addrId", adminAuth, (req, res) => {
  db.query(
    `DELETE FROM user_addresses WHERE id=? AND user_id=?`,
    [req.params.addrId, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "Delete failed" });
      res.json({ msg: "Address deleted" });
    }
  );
});

/* ════════════════════════
   ORDERS
════════════════════════ */
router.get("/users/:id/orders", adminAuth, (req, res) => {
  db.query(
    `SELECT id, total_amount, status, payment_status,
            coupon_code, coupon_discount, razorpay_order_id, created_at
     FROM orders
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});

/* ════════════════════════
   SUBSCRIPTIONS
════════════════════════ */
router.get("/users/:id/subscriptions", adminAuth, (req, res) => {
  db.query(
    `SELECT us.id, sp.plan_key, sp.title, us.months,
            us.amount_paid, us.start_date, us.end_date, us.status
     FROM user_subscriptions us
     JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.user_id = ?
     ORDER BY us.created_at DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});

/* ════════════════════════
   REVIEWS
════════════════════════ */
router.get("/users/:id/reviews", adminAuth, (req, res) => {
  db.query(
    `SELECT r.id, p.title AS product_title, r.rating, r.comment, r.status, r.created_at
     FROM reviews r
     JOIN products p ON p.id = r.product_id
     WHERE r.user_id = ?
     ORDER BY r.created_at DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});

/* PUT update review status */
router.put("/reviews/:reviewId", adminAuth, (req, res) => {
  const { status } = req.body;
  if (!["approved", "pending"].includes(status))
    return res.status(400).json({ msg: "Invalid status" });

  db.query(
    `UPDATE reviews SET status=? WHERE id=?`,
    [status, req.params.reviewId],
    (err) => {
      if (err) return res.status(500).json({ msg: "Update failed" });
      res.json({ msg: "Review updated" });
    }
  );
});



/* ─────────────────────────────────────────────
   POST /api/admin/send-change-password-otp
   Admin requests OTP to change their password
───────────────────────────────────────────── */
router.post("/send-change-password-otp", adminAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ msg: "Email is required" });

  // Verify the email belongs to the requesting admin
  db.query(
    "SELECT id, role FROM users WHERE email = ? AND id = ?",
    [email, req.admin.id],
    async (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (!rows.length) return res.status(403).json({ msg: "Email does not match your admin account" });
      if (rows[0].role !== "admin") return res.status(403).json({ msg: "Admin only" });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

      adminOtpStore.set(email, { otp, expiresAt, adminId: req.admin.id });

      try {
        await transporter.sendMail({
          from: `"AGPH Admin" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "Admin Password Change OTP",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
              <h2 style="color: #1d4ed8;">Admin Password Change Request</h2>
              <p>Use the OTP below to change your admin password. It expires in <strong>10 minutes</strong>.</p>
              <div style="font-size: 36px; font-weight: bold; letter-spacing: 10px; text-align: center; padding: 24px; background: #eff6ff; border-radius: 12px; color: #1e40af; margin: 20px 0;">
                ${otp}
              </div>
              <p style="color: #6b7280; font-size: 13px;">If you didn't request this, your account may be at risk. Please contact support immediately.</p>
            </div>
          `,
        });

        res.json({ msg: "OTP sent to your admin email" });
      } catch (emailErr) {
        console.error("Email error:", emailErr);
        res.status(500).json({ msg: "Failed to send OTP email" });
      }
    }
  );
});


/* ─────────────────────────────────────────────
   POST /api/admin/verify-change-password-otp
   Verify the OTP (without resetting yet)
───────────────────────────────────────────── */
router.post("/verify-change-password-otp", adminAuth, (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ msg: "Email and OTP are required" });

  const record = adminOtpStore.get(email);

  if (!record)
    return res.status(400).json({ msg: "OTP not found. Please request a new one." });
  if (record.adminId !== req.admin.id)
    return res.status(403).json({ msg: "Unauthorized" });
  if (Date.now() > record.expiresAt) {
    adminOtpStore.delete(email);
    return res.status(400).json({ msg: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp)
    return res.status(400).json({ msg: "Invalid OTP" });

  res.json({ msg: "OTP verified" });
});


/* ─────────────────────────────────────────────
   POST /api/admin/reset-password-with-otp
   Set new password after OTP verified
───────────────────────────────────────────── */
router.post("/reset-password-with-otp", adminAuth, async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ msg: "All fields are required" });

  const record = adminOtpStore.get(email);

  if (!record)
    return res.status(400).json({ msg: "OTP not found. Please request a new one." });
  if (record.adminId !== req.admin.id)
    return res.status(403).json({ msg: "Unauthorized" });
  if (Date.now() > record.expiresAt) {
    adminOtpStore.delete(email);
    return res.status(400).json({ msg: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp)
    return res.status(400).json({ msg: "Invalid OTP" });

  try {
    const hash = await bcrypt.hash(newPassword, 10);

    db.query(
      "UPDATE users SET password = ? WHERE email = ? AND id = ? AND role = 'admin'",
      [hash, email, req.admin.id],
      (err, result) => {
        if (err) return res.status(500).json({ msg: "DB error" });
        if (result.affectedRows === 0)
          return res.status(403).json({ msg: "Admin account not found" });

        adminOtpStore.delete(email); // clear OTP
        res.json({ msg: "Password updated successfully" });
      }
    );
  } catch {
    res.status(500).json({ msg: "Server error" });
  }
});


module.exports = router;