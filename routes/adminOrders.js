const express    = require("express");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const router     = express.Router();
const db         = require("../db");

const SECRET = "MY_SECRET_KEY";

/* ─────────────────────────────────────
   NODEMAILER SETUP
   .env keys: MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, MAIL_FROM
   ───────────────────────────────────── */
const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST || "smtp.gmail.com",
  port:   Number(process.env.MAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ════════════════════════════════════════════════════════
   EMAIL TEMPLATE
   Accepts items[] = [{ title, format, quantity, price }]
════════════════════════════════════════════════════════ */
function shippingEmailTemplate(status, customer, order, tracking, courier, items = []) {
  const statusConfig = {
    confirmed: {
      subject:  `Order #${order.id} Confirmed — Thank you, ${customer.name}!`,
      headline: "Your order is confirmed 🎉",
      body:     `We've received your order and it's being processed. You'll get another update once it ships.`,
      color:    "#2563eb",
    },
    shipped: {
      subject:  `Order #${order.id} has been Shipped!`,
      headline: "Your order is on its way 📦",
      body:     `Great news! Your order has been handed over to <strong>${courier || "our courier partner"}</strong>.${
                  tracking ? ` Use tracking ID <strong>${tracking}</strong> to follow your package.` : ""
                }`,
      color:    "#7c3aed",
    },
    out_for_delivery: {
      subject:  `Order #${order.id} is Out for Delivery!`,
      headline: "Out for delivery 🚚",
      body:     `Your package is on its way and will arrive today. Please be available to receive it.`,
      color:    "#d97706",
    },
    delivered: {
      subject:  `Order #${order.id} Delivered Successfully`,
      headline: "Delivered! 🎊",
      body:     `Your order has been delivered. We hope you enjoy your purchase! If you have any issues please contact our support.`,
      color:    "#16a34a",
    },
  };

  const cfg = statusConfig[status];
  if (!cfg) return null;

  /* ── Items rows ── */
  const itemRowsHTML = items.map((item, idx) => {
    const bg    = idx % 2 === 0 ? "#ffffff" : "#fafafa";
    const badge = item.format === "ebook"
      ? `<span style="background:#ede9fe;color:#7c3aed;font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;">eBook</span>`
      : `<span style="background:#dcfce7;color:#16a34a;font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;">Paperback</span>`;
    const lineTotal = `₹${(Number(item.price) * Number(item.quantity)).toFixed(2)}`;
    return `
      <tr style="border-top:1px solid #e5e7eb;background:${bg};">
        <td style="padding:12px 8px 12px 0;font-size:13px;color:#111827;font-weight:500;vertical-align:middle;">${item.title}</td>
        <td style="padding:12px 16px;font-size:13px;color:#6b7280;text-align:center;vertical-align:middle;">×&nbsp;${item.quantity}</td>
        <td style="padding:12px 16px;font-size:13px;color:#111827;font-weight:600;text-align:right;vertical-align:middle;white-space:nowrap;">${lineTotal}</td>
      </tr>`;
  }).join("");

  const itemsTableHTML = items.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px;border-collapse:collapse;">
      <tr style="background:#f3f4f6;">
        <td style="padding:10px 16px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;">Items Ordered</td>
        <td style="padding:10px 16px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;text-align:center;">Qty</td>
        <td style="padding:10px 16px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;text-align:right;">Total</td>
      </tr>
      ${itemRowsHTML}
    </table>` : "";

  /* ── Order summary ── */
  const orderDate = order.created_at
    ? new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

  const summaryHTML = `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;border-collapse:collapse;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;">Order Summary</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:4px 0;">Order ID</td>
              <td style="font-size:13px;color:#111827;font-weight:600;text-align:right;">#${order.id}</td>
            </tr>
            ${orderDate ? `
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:4px 0;">Order Date</td>
              <td style="font-size:13px;color:#111827;font-weight:600;text-align:right;">${orderDate}</td>
            </tr>` : ""}
            ${courier ? `
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:4px 0;">Courier</td>
              <td style="font-size:13px;color:#111827;font-weight:600;text-align:right;">${courier}</td>
            </tr>` : ""}
            ${tracking ? `
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:4px 0;">Tracking ID</td>
              <td style="font-size:13px;color:#111827;font-weight:600;text-align:right;font-family:monospace;">${tracking}</td>
            </tr>` : ""}
            <tr>
              <td colspan="2" style="padding-top:12px;border-top:1px solid #e5e7eb;"></td>
            </tr>
            <tr>
              <td style="font-size:14px;font-weight:700;color:#111827;padding:4px 0;">Order Total</td>
              <td style="font-size:14px;font-weight:700;color:#111827;text-align:right;">₹${order.total_amount}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return {
    subject: cfg.subject,
    html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
          style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:${cfg.color};padding:24px 32px;">
              <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">AGPH Books</p>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:12px;">Order #${order.id}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 8px;font-size:22px;color:#111827;">${cfg.headline}</h1>
              <p style="margin:0 0 6px;font-size:14px;color:#6b7280;">Hello <strong>${customer.name}</strong>,</p>
              <p style="margin:0 0 28px;font-size:14px;color:#374151;line-height:1.6;">${cfg.body}</p>

              ${itemsTableHTML}
              ${summaryHTML}

              <p style="margin:0;font-size:13px;color:#9ca3af;">
                If you have any questions, reply to this email or contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">© ${new Date().getFullYear()} AGPH Books. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}

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

/* ════════════════════════════════════════
   GET /api/admin/orders
════════════════════════════════════════ */
router.get("/orders", adminAuth, (req, res) => {
  db.query(
    `SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
            u.name AS user_name,
            s.courier, s.tracking_number, s.status AS shipping_status
     FROM orders o
     LEFT JOIN users    u ON u.id = o.user_id
     LEFT JOIN shipping s ON s.order_id = o.id
     ORDER BY o.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});

/* ════════════════════════════════════════
   GET /api/admin/orders/:id
════════════════════════════════════════ */
router.get("/orders/:id", adminAuth, (req, res) => {
  const orderId = req.params.id;

  db.query(
    `SELECT o.id, o.total_amount, o.status, o.payment_status,
            o.razorpay_order_id, o.razorpay_payment_id,
            o.coupon_code, o.coupon_discount, o.created_at,
            u.id AS user_id, u.name, u.email, u.phone
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = ? LIMIT 1`,
    [orderId],
    (err, orderRows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (!orderRows.length) return res.status(404).json({ msg: "Order not found" });

      const order = orderRows[0];

      db.query(`SELECT * FROM user_addresses WHERE user_id = ? LIMIT 1`, [order.user_id], (err, addrRows) => {
        if (err) return res.status(500).json({ msg: "DB error" });

        db.query(
          `SELECT p.title, p.main_image, oi.quantity, oi.price, oi.format
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = ?`,
          [orderId],
          (err, items) => {
            if (err) return res.status(500).json({ msg: "DB error" });

            db.query(`SELECT * FROM shipping WHERE order_id = ? LIMIT 1`, [orderId], (err, shipRows) => {
              if (err) return res.status(500).json({ msg: "DB error" });

              res.json({
                order: {
                  id: order.id, status: order.status,
                  payment_status: order.payment_status,
                  total_amount: order.total_amount,
                  created_at: order.created_at,
                  razorpay_order_id: order.razorpay_order_id,
                  razorpay_payment_id: order.razorpay_payment_id,
                  coupon_code: order.coupon_code,
                  coupon_discount: order.coupon_discount,
                },
                customer: { name: order.name, email: order.email, phone: order.phone },
                billing:  addrRows[0] || {},
                shipping: shipRows[0] || {},
                items,
              });
            });
          }
        );
      });
    }
  );
});

/* ════════════════════════════════════════
   PUT /api/admin/orders/:id/status
════════════════════════════════════════ */
router.put("/orders/:id/status", adminAuth, (req, res) => {
  const { status } = req.body;
  const valid = ["pending", "paid", "shipped", "completed", "cancelled"];
  if (!valid.includes(status)) return res.status(400).json({ msg: "Invalid status" });

  db.query(`UPDATE orders SET status = ? WHERE id = ?`, [status, req.params.id], (err) => {
    if (err) return res.status(500).json({ msg: "Update failed" });
    res.json({ msg: "Order status updated" });
  });
});

/* ════════════════════════════════════════
   POST /api/admin/orders/:id/shipping
   1. Upsert shipping row
   2. Fetch order + customer + items
   3. Send HTML email with full item list
════════════════════════════════════════ */
router.post("/orders/:id/shipping", adminAuth, async (req, res) => {
  const orderId = req.params.id;
  const { courier, tracking_number, status } = req.body;

  const columnMap = {
    confirmed:        "confirmed_at",
    shipped:          "shipped_at",
    out_for_delivery: "out_for_delivery_at",
    delivered:        "delivered_at",
  };

  const timeColumn = columnMap[status];
  if (!timeColumn) return res.status(400).json({ msg: "Invalid shipping status" });

  /* 1. Upsert shipping */
  db.query(
    `INSERT INTO shipping (order_id, courier, tracking_number, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       courier         = VALUES(courier),
       tracking_number = VALUES(tracking_number),
       status          = VALUES(status),
       ${timeColumn}   = NOW()`,
    [orderId, courier, tracking_number, status],
    async (err) => {
      if (err) return res.status(500).json({ msg: "Shipping update failed" });

      /* 2. Fetch order + customer */
      db.query(
        `SELECT o.id, o.total_amount, o.created_at, u.name, u.email
         FROM orders o
         JOIN users u ON u.id = o.user_id
         WHERE o.id = ? LIMIT 1`,
        [orderId],
        async (err, orderRows) => {
          if (err || !orderRows.length) {
            return res.json({ msg: "Shipping updated (email skipped: order not found)" });
          }

          const row      = orderRows[0];
          const customer = { name: row.name, email: row.email };
          const order    = { id: row.id, total_amount: row.total_amount, created_at: row.created_at };

          /* 3. Fetch order items */
          db.query(
            `SELECT p.title, oi.format, oi.quantity, oi.price
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id
             WHERE oi.order_id = ?`,
            [orderId],
            async (err, items) => {
              const safeItems = (!err && Array.isArray(items)) ? items : [];

              /* 4. Build + send email */
              const template = shippingEmailTemplate(
                status, customer, order,
                tracking_number, courier,
                safeItems       // ← items now included
              );

              if (template && customer.email) {
                try {
                  await transporter.sendMail({
                    from:    `"AGPH Books" <${process.env.MAIL_USER}>`,
                    to:      customer.email,
                    subject: template.subject,
                    html:    template.html,
                  });
                } catch (mailErr) {
                  console.error("Mail send error:", mailErr.message);
                  // still return success — shipping was saved
                }
              }

              res.json({ msg: "Shipping updated and customer notified" });
            }
          );
        }
      );
    }
  );
});

module.exports = router;