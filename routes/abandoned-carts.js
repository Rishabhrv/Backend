const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const router = express.Router();
const db = require("../db");

const SECRET = process.env.JWT_SECRET || "MY_SECRET_KEY";

// ─── Transporter Setup (AGPH - Default) ───────────────────────────────────────
const agphTransporter = nodemailer.createTransport({
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

// ─── Transporter Setup (AG Classics) ──────────────────────────────────────────
const agclassicsTransporter = nodemailer.createTransport({
  host:           process.env.MAIL_HOST || "smtp.gmail.com", 
  port:           Number(process.env.MAIL_PORT) || 587,
  secure:         Number(process.env.MAIL_PORT) === 465,
  pool:           true,
  maxConnections: 1,
  rateDelta:      2000,
  rateLimit:      3,
  auth: {
    user: process.env.MAIL_AGUSER,
    pass: process.env.MAIL_AGPASS,
  },
});

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
   Grouped by user_id AND imprint
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
      c.quantity,
      COALESCE((
        SELECT cat.imprint 
        FROM product_categories pc 
        JOIN categories cat ON pc.category_id = cat.id 
        WHERE pc.product_id = p.id 
        LIMIT 1
      ), 'agph') AS imprint
    FROM cart c
    JOIN users u ON c.user_id = u.id
    JOIN products p ON c.product_id = p.id
    ORDER BY c.created_at DESC
  `;

  db.query(query, (err, rows) => {
    if (err) return res.status(500).json({ msg: "Database error" });
    
    const cartsMap = {};
    rows.forEach(row => {
      // Create a unique key per user + imprint combination
      const key = `${row.user_id}_${row.imprint}`;
      
      if (!cartsMap[key]) {
        cartsMap[key] = {
          cart_group_id: key,
          user_id: row.user_id,
          imprint: row.imprint,
          customerName: row.customerName, 
          email: row.email,
          phone: row.phone, 
          lastActive: row.created_at, 
          totalValue: 0, 
          items: [], 
          status: "pending"
        };
      }
      cartsMap[key].totalValue += (row.price * row.quantity);
      cartsMap[key].items.push({ title: row.title, format: row.format, quantity: row.quantity });
    });

    const sortedCarts = Object.values(cartsMap).sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
    res.json(sortedCarts);
  });
});

/* ════════════════════════════════════════
   DELETE /api/admin/abandoned-carts/:userId/:imprint
════════════════════════════════════════ */
router.delete("/abandoned-carts/:userId/:imprint", adminAuth, (req, res) => {
  const { userId, imprint } = req.params;
  const query = `
    DELETE c FROM cart c
    JOIN products p ON c.product_id = p.id
    WHERE c.user_id = ? AND COALESCE((
      SELECT cat.imprint 
      FROM product_categories pc 
      JOIN categories cat ON pc.category_id = cat.id 
      WHERE pc.product_id = p.id 
      LIMIT 1
    ), 'agph') = ?
  `;

  db.query(query, [userId, imprint], (err) => {
    if (err) return res.status(500).json({ msg: "Database error" });
    res.json({ msg: "Cart cleared successfully" });
  });
});

/* ════════════════════════════════════════
   POST /api/admin/abandoned-carts/remind
   Bulk send imprint-specific recovery emails
════════════════════════════════════════ */
router.post("/abandoned-carts/remind", adminAuth, (req, res) => {
  const { targets } = req.body; // Array of { userId, imprint }

  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ msg: "An array of targets is required" });
  }

  const userIds = [...new Set(targets.map(t => t.userId))];

  const query = `
    SELECT c.user_id, u.email, u.name, p.title, c.format, c.quantity, COALESCE(p.sell_price, p.price) as price,
      COALESCE((
        SELECT cat.imprint 
        FROM product_categories pc 
        JOIN categories cat ON pc.category_id = cat.id 
        WHERE pc.product_id = p.id 
        LIMIT 1
      ), 'agph') AS imprint
    FROM cart c
    JOIN products p ON c.product_id = p.id
    JOIN users u ON c.user_id = u.id
    WHERE c.user_id IN (?)
  `;

  db.query(query, [userIds], async (err, rows) => {
    if (err) return res.status(500).json({ msg: "Database error" });
    if (!rows.length) return res.status(404).json({ msg: "No carts found" });

    const emailsToSend = {};

    rows.forEach(row => {
      // Ensure we only process targets explicitly requested by the admin
      if (!targets.some(t => String(t.userId) === String(row.user_id) && t.imprint === row.imprint)) return;

      const key = `${row.user_id}_${row.imprint}`;
      if (!emailsToSend[key]) {
        emailsToSend[key] = {
          userId: row.user_id,
          imprint: row.imprint,
          email: row.email,
          name: row.name,
          items: [],
          total: 0
        };
      }
      emailsToSend[key].items.push(row);
      emailsToSend[key].total += (row.price * row.quantity);
    });

    let sentCount = 0;
    
    for (const data of Object.values(emailsToSend)) {
      const isClassics = data.imprint === 'agclassics';
      
      // Theme Configuration based on Imprint
      const theme = {
        storeName: isClassics ? "AG Classics" : "AGPH Books",
        fromEmail: isClassics ? process.env.MAIL_AGUSER : process.env.MAIL_USER,
        bgColor: isClassics ? "#06060a" : "#ffffff",
        textColor: isClassics ? "#f5f0e8" : "#334155",
        brandColor: isClassics ? "#c9a84c" : "#2563eb",
        borderColor: isClassics ? "rgba(201,168,76,0.2)" : "#e2e8f0",
        tableHeaderBg: isClassics ? "#111113" : "#f8fafc",
        footerBg: isClassics ? "#0a0a0c" : "#f8fafc",
        footerText: isClassics ? "#8a8a8e" : "#64748b",
        supportEmail: isClassics ? "orders@agclassics.in" : "support@agphbooks.com",
        checkoutUrl: isClassics 
          ? (process.env.NEXT_PUBLIC_AG_CLASSICS_URL || 'https://agclassics.in') + '/cart'
          : (process.env.NEXT_PUBLIC_SITE_URL || 'https://store.agphbooks.com') + '/cart'
      };

      const itemRowsHTML = data.items.map(item => `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid ${theme.borderColor}; font-size: 14px; color: ${theme.textColor};">
            <strong>${item.title}</strong> <span style="color: ${isClassics ? '#c9a84c' : '#64748b'}; font-size: 12px;">(${item.format})</span>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid ${theme.borderColor}; text-align: center; color: ${theme.textColor};">x${item.quantity}</td>
          <td style="padding: 12px; border-bottom: 1px solid ${theme.borderColor}; text-align: right; font-weight: 600; color: ${theme.textColor};">₹${(item.price * item.quantity).toFixed(2)}</td>
        </tr>
      `).join("");

      const mailOptions = {
        from: `"${theme.storeName}" <${theme.fromEmail}>`,
        to: data.email,
        subject: `Your ${theme.storeName} cart is waiting for you! 📚`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: ${theme.bgColor}; border: 1px solid ${theme.borderColor}; border-radius: 4px; overflow: hidden; color: ${theme.textColor};">
            
            <div style="background-color: ${theme.brandColor}; padding: 30px; text-align: center;">
              <h1 style="color: ${isClassics ? '#000000' : '#ffffff'}; margin: 0; font-size: 24px; font-family: ${isClassics ? 'Georgia, serif' : 'Arial, sans-serif'};">Did you forget something?</h1>
            </div>
            
            <div style="padding: 30px;">
              <p style="font-size: 16px; line-height: 1.6;">Dear ${data.name},</p>
              <p style="font-size: 16px; line-height: 1.6;">We noticed you left some great books in your cart at <strong>${theme.storeName}</strong>. Return to checkout to secure them.</p>
              
              <table width="100%" cellspacing="0" cellpadding="0" style="margin: 20px 0; border: 1px solid ${theme.borderColor}; border-radius: 4px; overflow: hidden;">
                <tr style="background-color: ${theme.tableHeaderBg};">
                  <th align="left" style="padding: 12px; font-size: 12px; color: ${isClassics ? '#c9a84c' : '#64748b'}; text-transform: uppercase;">Title</th>
                  <th align="center" style="padding: 12px; font-size: 12px; color: ${isClassics ? '#c9a84c' : '#64748b'}; text-transform: uppercase;">Qty</th>
                  <th align="right" style="padding: 12px; font-size: 12px; color: ${isClassics ? '#c9a84c' : '#64748b'}; text-transform: uppercase;">Total</th>
                </tr>
                ${itemRowsHTML}
                <tr>
                  <td colspan="2" style="padding: 16px 12px; text-align: right; font-weight: 600;">Cart Total:</td>
                  <td style="padding: 16px 12px; text-align: right; font-weight: 800; font-size: 16px; color: ${theme.brandColor};">₹${data.total.toFixed(2)}</td>
                </tr>
              </table>
              
              <div style="text-align: center; margin-top: 30px; margin-bottom: 10px;">
                <a href="${theme.checkoutUrl}" style="display: inline-block; background-color: ${theme.brandColor}; color: ${isClassics ? '#000000' : '#ffffff'}; text-decoration: none; padding: 14px 28px; border-radius: 4px; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Return to Checkout</a>
              </div>
            </div>

            <div style="background-color: ${theme.footerBg}; border-top: 1px solid ${theme.borderColor}; padding: 24px 30px; text-align: center; font-size: 12px; color: ${theme.footerText};">
              <p style="margin: 0 0 10px 0;">
                Need help? Contact us at <a href="mailto:${theme.supportEmail}" style="color: ${theme.brandColor}; text-decoration: none; font-weight: bold;">${theme.supportEmail}</a>
              </p>
              <p style="margin: 0 0 16px 0;">
                &copy; ${new Date().getFullYear()} ${theme.storeName}. All rights reserved.
              </p>
              <p style="margin: 0; font-size: 10px; opacity: 0.8; line-height: 1.5;">
                You received this email because you left items in your cart on our website. This is an automated message, please do not reply directly to this email.
              </p>
            </div>

          </div>
        `
      };

      try {
        // ✅ FIXED: Now properly using the agphTransporter instead of the missing 'transporter' variable
        const activeTransporter = isClassics ? agclassicsTransporter : agphTransporter;
        await activeTransporter.sendMail(mailOptions);
        sentCount++;
      } catch (mailErr) {
        console.error(`Failed to send email to ${data.email}:`, mailErr);
      }
    }

    res.json({ msg: `Sent reminders for ${sentCount} cart(s).` });
  });
});

module.exports = router;