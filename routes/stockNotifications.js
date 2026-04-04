const express = require("express");
const router = express.Router();
const db = require("../db");
const nodemailer = require("nodemailer");


const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST || "smtp.gmail.com",
  port:   Number(process.env.MAIL_PORT) || 587,
  secure: Number(process.env.MAIL_PORT) === 465,  // true for 465, false for 587
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ── POST /api/stock-notifications ── user subscribes ── */
router.post("/", (req, res) => {
  const { product_id, email } = req.body;
  if (!product_id || !email)
    return res.status(400).json({ message: "product_id and email required" });

  db.query(
    `INSERT INTO stock_notifications (product_id, email)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE created_at = created_at`,
    [product_id, email.toLowerCase().trim()],
    (err) => {
      if (err) return res.status(500).json({ message: "DB error" });
      res.json({ success: true });
    }
  );
});

/* ── POST /api/stock-notifications/notify/:productId ── send emails ── */
router.post("/notify/:productId", (req, res) => {
  const { productId } = req.params;

  db.query(
    `SELECT p.title, p.slug, p.main_image,
            sn.id AS sub_id, sn.email
     FROM products p
     JOIN stock_notifications sn ON sn.product_id = p.id
     WHERE p.id = ? AND sn.notified_at IS NULL`,
    [productId],
    async (err, rows) => {
      if (err) return res.status(500).json({ message: "DB error" });
      if (!rows.length) return res.json({ sent: 0 });

      const { title, slug, main_image } = rows[0];
      const productUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/product/${slug}`;
      const imageUrl = main_image
        ? `${process.env.NEXT_PUBLIC_API_URL}${main_image}`
        : null;

      let sent = 0;
      const notifiedIds = [];

      for (const row of rows) {
        try {
          await transporter.sendMail({
            from: `"AGPH Books Store" <${process.env.MAIL_USER}>`,
            to: row.email,
            subject: `"${title}" is back in stock!`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
                <h2 style="margin:0 0 12px;color:#111827;">${title} is back in stock!</h2>
                <p style="color:#6b7280;margin:0 0 20px;">
                  Good news — the product you were waiting for is available again.
                  Grab it before it sells out.
                </p>
                <a href="${productUrl}"
                   style="display:inline-block;padding:12px 28px;background:#111827;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">
                  Buy Now →
                </a>
                <p style="margin-top:28px;font-size:11px;color:#9ca3af;">
                  You're receiving this because you signed up for a stock alert on our website.
                </p>
              </div>
            `,
          });
          notifiedIds.push(row.sub_id);
          sent++;
        } catch (mailErr) {
          console.error("Mail failed for", row.email, mailErr.message);
        }
      }

      if (notifiedIds.length) {
        db.query(
          `UPDATE stock_notifications SET notified_at = NOW() WHERE id IN (?)`,
          [notifiedIds]
        );
      }

      res.json({ sent });
    }
  );
});

module.exports = router;