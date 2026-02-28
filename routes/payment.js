const express    = require("express");
const router     = express.Router();
const Razorpay   = require("razorpay");
const crypto     = require("crypto");
const db         = require("../db");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// ✅ Reuse the exact same template function from adminorder.js — no duplication
const { shippingEmailTemplate } = require("./adminOrders");

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

/* ── RAZORPAY ── */
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ── MAILER (same config as adminorder.js) ── */
const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST || "smtp.gmail.com",
  port:   Number(process.env.MAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ══════════════════════════════════════════════════════════
   HELPER — fetch order data then send "confirmed" email
   Called without await (fire-and-forget) so it never
   delays the HTTP response back to the frontend.
══════════════════════════════════════════════════════════ */
async function sendOrderConfirmedEmail(orderId) {
  try {
    // 1️⃣ Get customer + order row
    const orderRows = await new Promise((resolve, reject) =>
      db.query(
        `SELECT o.id, o.total_amount, o.created_at, u.name, u.email
         FROM orders o
         JOIN users u ON u.id = o.user_id
         WHERE o.id = ? LIMIT 1`,
        [orderId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      )
    );

    if (!orderRows?.length) return;

    const row      = orderRows[0];
    const customer = { name: row.name, email: row.email };
    const order    = { id: row.id, total_amount: row.total_amount, created_at: row.created_at };

    // 2️⃣ Get order items
    const items = await new Promise((resolve, reject) =>
      db.query(
        `SELECT p.title, oi.format, oi.quantity, oi.price
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ?`,
        [orderId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    );

    // 3️⃣ Build email using the same shippingEmailTemplate as adminorder.js
    //    status = "confirmed" | no courier/tracking at payment stage
    const template = shippingEmailTemplate(
      "confirmed", customer, order,
      /*tracking=*/ null,
      /*courier=*/  null,
      items
    );

    if (!template || !customer.email) return;

    await transporter.sendMail({
      from:    `"AGPH Books" <${process.env.MAIL_USER}>`,
      to:      customer.email,
      subject: template.subject,
      html:    template.html,
    });

    console.log(`✅ Confirmed email sent → ${customer.email} (order #${orderId})`);

  } catch (err) {
    // Non-fatal — payment already verified, never crash the response
    console.error("❌ Confirmed email failed:", err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   CREATE RAZORPAY ORDER
══════════════════════════════════════════════════════════ */
router.post("/create-order", auth, (req, res) => {
  const { order_id } = req.body;

  db.query(
    "SELECT total_amount FROM orders WHERE id=? AND user_id=?",
    [order_id, req.user.id],
    (err, rows) => {
      if (err || !rows.length) return res.status(400).json({ msg: "Invalid order" });

      razorpay.orders.create(
        {
          amount:   Math.round(rows[0].total_amount * 100),
          currency: "INR",
          receipt:  "receipt_" + order_id,
        },
        (err, rpOrder) => {
          if (err) return res.status(500).json(err);
          db.query(
            "UPDATE orders SET razorpay_order_id=? WHERE id=?",
            [rpOrder.id, order_id],
            () => res.json(rpOrder)
          );
        }
      );
    }
  );
});

/* ══════════════════════════════════════════════════════════
   VERIFY PAYMENT
   Steps:
     1. Verify Razorpay HMAC signature
     2. Mark order as paid in DB
     3. Deduct stock for paperback items
     4. Clear user's cart
     5. Fire-and-forget "Order Confirmed" email  ← NEW
     6. Return order_id so frontend can redirect
══════════════════════════════════════════════════════════ */
router.post("/verify", auth, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body;

  // 1. Signature check
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");

  if (expected !== razorpay_signature)
    return res.status(400).json({ msg: "Invalid signature" });

  // 2. Mark paid
  db.query(
    `UPDATE orders
     SET payment_status      = 'success',
         status              = 'paid',
         razorpay_payment_id = ?
     WHERE id = ?`,
    [razorpay_payment_id, order_id],
    () => {

      // 3. Deduct stock for paperback items
      db.query(
        `UPDATE products p
         JOIN order_items oi ON oi.product_id = p.id
         SET p.stock = GREATEST(0, p.stock - oi.quantity)
         WHERE oi.order_id = ? AND oi.format = 'paperback'`,
        [order_id],
        (err) => {
          if (err) console.error("Stock deduction error:", err);

          // 4. Clear cart
          db.query("DELETE FROM cart WHERE user_id = ?", [req.user.id], () => {

            // 5. Send confirmed email — fire and forget, never blocks this response
            sendOrderConfirmedEmail(order_id);

            // 6. Respond to frontend with order_id for redirect
            res.json({ msg: "Payment verified", order_id });
          });
        }
      );
    }
  );
});

module.exports = router;