const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const router = express.Router();
const db = require("../db");

const SECRET = process.env.JWT_SECRET || "MY_SECRET_KEY";

// ─── Transporter Setup ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:           process.env.MAIL_HOST || "smtp.gmail.com",
  port:           Number(process.env.MAIL_PORT) || 587,
  secure:         Number(process.env.MAIL_PORT) === 465,
  pool:           true,
  maxConnections: 1,
  rateDelta:      2000,
  rateLimit:      3,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// ─── Admin Auth Middleware ────────────────────────────────────────────────────
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

/* ════════════════════════════════════════
   GET /api/admin/abandoned-carts
════════════════════════════════════════ */
router.get("/abandoned-carts/all", adminAuth, (req, res) => {
  const query = `
    SELECT 
      u.id AS user_id, 
      u.name AS customerName, 
      u.email, 
      u.phone,
      c.created_at,
      COALESCE(p.sell_price, p.price) AS price,
      p.title, 
      c.format, 
      c.quantity
    FROM cart c
    JOIN users u ON c.user_id = u.id
    JOIN products p ON c.product_id = p.id
    ORDER BY c.created_at DESC
  `;

  db.query(query, (err, rows) => {
    if (err) return res.status(500).json({ msg: "Database error" });
    
    const cartsMap = {};
    rows.forEach(row => {
      if (!cartsMap[row.user_id]) {
        cartsMap[row.user_id] = {
          user_id: row.user_id, customerName: row.customerName, email: row.email,
          phone: row.phone, lastActive: row.created_at, totalValue: 0, items: [], status: "pending"
        };
      }
      cartsMap[row.user_id].totalValue += (row.price * row.quantity);
      cartsMap[row.user_id].items.push({ title: row.title, format: row.format, quantity: row.quantity });
    });

    // ─────────────────────────────────────────────────────────────────
    // FIX: Re-sort the grouped items by `lastActive` descending
    // ─────────────────────────────────────────────────────────────────
    const sortedCarts = Object.values(cartsMap).sort((a, b) => {
      return new Date(b.lastActive) - new Date(a.lastActive);
    });

    res.json(sortedCarts);
  });
});

/* ════════════════════════════════════════
   DELETE /api/admin/abandoned-carts/:userId
════════════════════════════════════════ */
router.delete("/abandoned-carts/:userId", adminAuth, (req, res) => {
  db.query(`DELETE FROM cart WHERE user_id = ?`, [req.params.userId], (err) => {
    if (err) return res.status(500).json({ msg: "Database error" });
    res.json({ msg: "Cart cleared successfully" });
  });
});

/* ════════════════════════════════════════
   POST /api/admin/abandoned-carts/remind
   Bulk send recovery emails
════════════════════════════════════════ */
router.post("/abandoned-carts/remind", adminAuth, (req, res) => {
  const { userIds } = req.body;

  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ msg: "An array of user IDs is required" });
  }

  // 1. Fetch carts specifically for the selected users
  const query = `
    SELECT c.user_id, u.email, u.name, p.title, c.format, c.quantity, COALESCE(p.sell_price, p.price) as price
    FROM cart c
    JOIN products p ON c.product_id = p.id
    JOIN users u ON c.user_id = u.id
    WHERE c.user_id IN (?)
  `;

  db.query(query, [userIds], async (err, rows) => {
    if (err) return res.status(500).json({ msg: "Database error" });
    if (!rows.length) return res.status(404).json({ msg: "No carts found for selected users" });

    // 2. Group the results by user
    const usersMap = {};
    rows.forEach(row => {
      if (!usersMap[row.user_id]) {
        usersMap[row.user_id] = { email: row.email, name: row.name, items: [], total: 0 };
      }
      usersMap[row.user_id].items.push(row);
      usersMap[row.user_id].total += (row.price * row.quantity);
    });

    // 3. Loop through users and construct/send emails
    let sentCount = 0;
    
    for (const [userId, userData] of Object.entries(usersMap)) {
      const itemRowsHTML = userData.items.map(item => `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #1e293b;">
            <strong>${item.title}</strong> <span style="color: #64748b; font-size: 12px;">(${item.format})</span>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center; color: #64748b;">x${item.quantity}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 600; color: #1e293b;">₹${(item.price * item.quantity).toFixed(2)}</td>
        </tr>
      `).join("");

      const cartTotal = userData.total.toFixed(2);
      const checkoutLink = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://store.agphbooks.com'}/cart`;

      const mailOptions = {
        from: `"AGPH Books Store" <${process.env.MAIL_USER}>`,
        to: userData.email,
        subject: "You left something in your cart! 🛒",
        html: `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #2563eb; padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Did you forget something?</h1>
            </div>
            <div style="padding: 30px;">
              <p style="font-size: 16px; color: #334155; line-height: 1.6;">Hi ${userData.name},</p>
              <p style="font-size: 16px; color: #334155; line-height: 1.6;">We noticed you left some great books in your cart. They are still waiting for you, but stock moves fast!</p>
              <table width="100%" cellspacing="0" cellpadding="0" style="margin: 20px 0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <tr style="background-color: #f8fafc;">
                  <th align="left" style="padding: 12px; font-size: 12px; color: #64748b; text-transform: uppercase;">Product</th>
                  <th align="center" style="padding: 12px; font-size: 12px; color: #64748b; text-transform: uppercase;">Qty</th>
                  <th align="right" style="padding: 12px; font-size: 12px; color: #64748b; text-transform: uppercase;">Total</th>
                </tr>
                ${itemRowsHTML}
                <tr>
                  <td colspan="2" style="padding: 16px 12px; text-align: right; font-weight: 600; color: #64748b;">Cart Total:</td>
                  <td style="padding: 16px 12px; text-align: right; font-weight: 800; font-size: 16px; color: #2563eb;">₹${cartTotal}</td>
                </tr>
              </table>
              <div style="text-align: center; margin-top: 30px;">
                <a href="${checkoutLink}" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 700; font-size: 16px;">Return to Checkout</a>
              </div>
            </div>
          </div>
        `
      };

      // 4. Send Email sequentially (prevents overwhelming the SMTP pool)
      try {
        await transporter.sendMail(mailOptions);
        sentCount++;
      } catch (mailErr) {
        console.error(`Failed to send abandoned cart email to ${userData.email}:`, mailErr);
      }
    }

    res.json({ msg: `Sent reminders to ${sentCount} user(s).` });
  });
});

module.exports = router;