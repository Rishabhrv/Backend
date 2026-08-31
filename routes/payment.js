const express = require("express");
const router = express.Router();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const db = require("../db");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// ✅ Reuse the exact same template function from adminorder.js — no duplication
const { buildEmailsForOrder } = require("./adminOrders");
const { createAdminNotification } = require("./adminnotifications");

// Helper to hash user data for Meta CAPI
function hashData(data) {
  if (!data) return undefined;
  return crypto.createHash('sha256').update(data.trim().toLowerCase()).digest('hex');
}

// Fire-and-forget function to send Server Event to Meta
async function sendMetaCAPIEvent(order_id, userObj, amount, req) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return;

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const clientIpAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const clientUserAgent = req.headers['user-agent'];

  const cleanPhone = userObj.phone ? userObj.phone.replace(/\D/g, '') : '';
  const finalPhone = cleanPhone.length > 0 ? (cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone) : '';

  const eventData = {
    data: [
      {
        event_name: 'Purchase',
        event_time: currentTimestamp,
        action_source: 'website',
        event_id: String(order_id),
        user_data: {
          em: userObj.email ? [hashData(userObj.email)] : undefined,
          ph: finalPhone ? [hashData(finalPhone)] : undefined,
          fn: userObj.first_name ? [hashData(userObj.first_name)] : undefined,
          ln: userObj.last_name ? [hashData(userObj.last_name)] : undefined,
          ct: userObj.city ? [hashData(userObj.city)] : undefined,
          st: userObj.state ? [hashData(userObj.state)] : undefined,
          zp: userObj.pincode ? [hashData(userObj.pincode)] : undefined,
          country: userObj.country ? [hashData(userObj.country)] : undefined,
          fbp: userObj.fbp || undefined,
          fbc: userObj.fbc || undefined,
          client_ip_address: clientIpAddress,
          client_user_agent: clientUserAgent,
        },
        custom_data: {
          currency: 'INR',
          value: parseFloat(Number(amount).toFixed(2))
        }
      }
    ]
  };

  const testEventCode = process.env.META_TEST_EVENT_CODE;
  if (testEventCode) {
    eventData.test_event_code = testEventCode;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData)
    });
    const result = await response.json();
    if (result.error) {
      console.error("Meta CAPI Error:", result.error);
    }
  } catch (error) {
    console.error("Meta CAPI Request Failed:", error);
  }
}

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
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ── MAILER (same config as adminorder.js) ── */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.MAIL_PORT) || 587,
  secure: Number(process.env.MAIL_PORT) === 465,  // true for 465, false for 587
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

    const row = orderRows[0];
    const customer = { name: row.name, email: row.email };
    const order = { id: row.id, total_amount: row.total_amount, created_at: row.created_at };

    // 2️⃣ Get order items including imprint for correct email routing
    const items = await new Promise((resolve, reject) =>
      db.query(
        `SELECT oi.id, oi.product_id, oi.quantity, oi.price, oi.format,
                p.title, p.main_image,
                GROUP_CONCAT(DISTINCT c.imprint) AS imprint
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_categories pc ON pc.product_id = p.id
         LEFT JOIN categories c ON c.id = pc.category_id
         WHERE oi.order_id = ?
         GROUP BY oi.id`,
        [orderId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    );

    // 3️⃣ Build emails using buildEmailsForOrder
    //    status = "confirmed" | no courier/tracking at payment stage
    const emails = buildEmailsForOrder(
      "confirmed", customer, order,
      /*tracking=*/ null,
      /*courier=*/  null,
      items
    );

    if (!emails || emails.length === 0 || !customer.email) return;

    // Send an email for each brand
    for (const email of emails) {
      await transporter.sendMail({
        from: `"AGPH Books Store" <${process.env.MAIL_USER}>`,
        to: customer.email,
        subject: email.subject,
        html: email.html,
      });
      console.log(`✅ Confirmed email sent → ${customer.email} (order #${orderId}, brand: ${email.brand})`);
    }

    // 🔔 Send a beautiful custom email to the Admin (only once per order)
    if (process.env.ADMIN_MAIL) {
      const itemRowsAdmin = items.map(item => `
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#0f172a;font-weight:600;">${item.title}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:center;">${item.format === "ebook" ? "eBook" : "Paperback"}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:center;text-transform:capitalize;">${item.imprint || 'Agph'}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:center;">× ${item.quantity}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;font-weight:700;text-align:right;">₹${(Number(item.price) * Number(item.quantity)).toFixed(2)}</td>
        </tr>`).join("");

      const adminSubject = `[New Order] #${order.id} — ₹${order.total_amount} — ${customer.name}`;

      await transporter.sendMail({
        from: `"AGPH Books Store" <${process.env.MAIL_USER}>`,
        to: process.env.ADMIN_MAIL,
        subject: adminSubject,
        html: `
          <div style="font-family:sans-serif;max-width:640px;margin:auto;background:#f8fafc;">
            <div style="background:#0f172a;padding:20px 28px;border-radius:10px 10px 0 0;">
              <p style="margin:0;font-size:18px;font-weight:800;color:#fff;">🛒 New Order Received</p>
              <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;font-family:monospace;">Order #${order.id}</p>
            </div>
            <div style="background:#fff;border:2px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:24px 8px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr><td style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:10px;" colspan="2">Customer Details</td></tr>
                <tr><td style="font-size:13px;color:#64748b;padding:4px 0;width:120px;">Name</td><td style="font-size:13px;color:#0f172a;font-weight:700;">${customer.name}</td></tr>
                <tr><td style="font-size:13px;color:#64748b;padding:4px 0;">Email</td><td style="font-size:13px;color:#0f172a;">${customer.email}</td></tr>
                <tr><td style="font-size:13px;color:#64748b;padding:4px 0;">Order Total</td><td style="font-size:14px;color:#2563eb;font-weight:800;">₹${order.total_amount}</td></tr>
              </table>
              <p style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 10px;">Items Ordered</p>
              <table width="100%" cellpadding="0" cellspacing="0"
                style="border:2px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;margin-bottom:24px;">
                <thead>
                  <tr style="background:#0f172a;">
                    <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Title</td>
                    <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Format</td>
                    <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Imprint</td>
                    <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Qty</td>
                    <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:right;">Total</td>
                  </tr>
                </thead>
                <tbody style="background:#fff;">${itemRowsAdmin}</tbody>
              </table>
              <p style="margin:0;font-size:12px;color:#94a3b8;">Automated notification · AGPH Books Admin</p>
            </div>
          </div>`,
      });
      console.log(`✅ Admin email sent → ${process.env.ADMIN_MAIL}`);
    }

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
          amount: Math.round(rows[0].total_amount * 100),
          currency: "INR",
          receipt: "receipt_" + order_id,
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
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    order_id,
    is_buy_now,
    fbp,
    fbc,
  } = req.body;

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

      // ─────────────────────────────────────────────────────────────────
      // NEW: Trigger Notification ONLY on successful payment verification
      // ─────────────────────────────────────────────────────────────────
      db.query(
        `SELECT o.total_amount, u.email, o.coupon_code,
                a.first_name, a.last_name, a.phone, a.city, a.state, a.pincode, a.country
         FROM orders o 
         JOIN users u ON u.id = o.user_id 
         LEFT JOIN order_address a ON a.order_id = o.id
         WHERE o.id = ?`,
        [order_id],
        (err, rows) => {
          if (!err && rows.length > 0) {
            createAdminNotification(
              "order",
              "New Order Received",
              `Order #${order_id} placed by ${rows[0].email} — ₹${rows[0].total_amount}`,
              order_id
            );

            const userObj = {
              email: rows[0].email,
              first_name: rows[0].first_name,
              last_name: rows[0].last_name,
              phone: rows[0].phone,
              city: rows[0].city,
              state: rows[0].state,
              pincode: rows[0].pincode,
              country: rows[0].country,
              fbp: fbp,
              fbc: fbc
            };
            sendMetaCAPIEvent(order_id, userObj, rows[0].total_amount, req);

            // Log coupon usage upon successful payment
            if (rows[0].coupon_code) {
              db.query(
                `INSERT INTO coupon_usage (coupon_id, user_id, order_id)
                 SELECT id, ?, ? FROM coupons WHERE code = ? LIMIT 1`,
                [req.user.id, order_id, rows[0].coupon_code]
              );
            }
          }
        }
      );

      // 3. Deduct stock for paperback items
      db.query(
        `UPDATE products p
         JOIN order_items oi ON oi.product_id = p.id
         SET p.stock = GREATEST(0, p.stock - oi.quantity)
         WHERE oi.order_id = ? AND oi.format = 'paperback'`,
        [order_id],
        (err) => {
          if (err) console.error("Stock deduction error:", err);

          // 4. Insert into shipping table
          db.query(
            `INSERT INTO shipping (order_id, status, confirmed_at)
             VALUES (?, 'confirmed', NOW())
             ON DUPLICATE KEY UPDATE status = 'confirmed', confirmed_at = NOW()`,
            [order_id],
            (err) => {
              if (err) console.error("Shipping insert error:", err);

              // 5. Clear cart ONLY IF NOT Buy Now
              const finishOrder = () => {
                // 6. Send confirmed email — fire and forget, never blocks this response
                sendOrderConfirmedEmail(order_id);

                // 7. Respond to frontend with order_id for redirect
                res.json({ msg: "Payment verified", order_id });
              };

              if (!is_buy_now) {
                db.query("DELETE FROM cart WHERE user_id = ?", [req.user.id], finishOrder);
              } else {
                finishOrder();
              }
            }
          );
        }
      );
    }
  );
});


/* ══════════════════════════════════════════════════════════
   RAZORPAY WEBHOOK (FOR LATE AUTHORIZATIONS)
══════════════════════════════════════════════════════════ */
router.post("/webhook", (req, res) => {
  console.log("=================================");
  console.log("RAZORPAY WEBHOOK RECEIVED");
  console.log("Time:", new Date().toISOString());
  console.log("Event:", req.body?.event);
  console.log("Raw body exists:", !!req.rawBody);
  console.log("Signature exists:", !!req.headers["x-razorpay-signature"]);
  console.log("=================================");
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  if (!req.rawBody) {
    console.error("Webhook Error: req.rawBody is missing.");
    return res.status(400).json({ msg: "Invalid request payload" });
  }

  const expectedSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("hex");

  if (expectedSig !== signature) {
    console.warn("Webhook signature mismatch");
    return res.status(400).json({ msg: "Invalid signature" });
  }

  const event = req.body;
  const { event: eventName, payload } = event;

  if (eventName === "order.paid" || eventName === "payment.captured") {
    const razorpay_order_id = payload.payment?.entity?.order_id || payload.order?.entity?.id;
    const razorpay_payment_id = payload.payment?.entity?.id;

    if (!razorpay_order_id) return res.json({ ok: true });

    db.query(
      `SELECT id, payment_status, total_amount, user_id, coupon_code 
       FROM orders 
       WHERE razorpay_order_id = ?`,
      [razorpay_order_id],
      (err, rows) => {
        if (err || !rows.length) return res.json({ ok: true });

        const order = rows[0];
        const order_id = order.id;

        // Idempotency: If already success, skip processing
        if (order.payment_status === 'success') {
          return res.json({ ok: true, msg: "Already processed" });
        }

        // Mark paid
        db.query(
          `UPDATE orders
           SET payment_status      = 'success',
               status              = 'paid',
               razorpay_payment_id = ?
           WHERE id = ?`,
          [razorpay_payment_id, order_id],
          () => {
            // Trigger Notification ONLY on successful payment verification
            db.query(
              `SELECT o.total_amount, u.email, o.coupon_code,
                      a.first_name, a.last_name, a.phone, a.city, a.state, a.pincode, a.country
               FROM orders o 
               JOIN users u ON u.id = o.user_id 
               LEFT JOIN order_address a ON a.order_id = o.id
               WHERE o.id = ?`,
              [order_id],
              (err, userRows) => {
                if (!err && userRows.length > 0) {

                  const userObj = {
                    email: userRows[0].email,
                    first_name: userRows[0].first_name,
                    last_name: userRows[0].last_name,
                    phone: userRows[0].phone,
                    city: userRows[0].city,
                    state: userRows[0].state,
                    pincode: userRows[0].pincode,
                    country: userRows[0].country,
                    fbp: undefined,
                    fbc: undefined
                  };

                  sendMetaCAPIEvent(order_id, userObj, userRows[0].total_amount, req);

                  if (userRows[0].coupon_code) {
                    db.query(
                      `INSERT INTO coupon_usage (coupon_id, user_id, order_id)
                       SELECT id, ?, ? FROM coupons WHERE code = ? LIMIT 1`,
                      [order.user_id, order_id, userRows[0].coupon_code]
                    );
                  }
                }
              }
            );

            // Deduct stock for paperback items
            db.query(
              `UPDATE products p
               JOIN order_items oi ON oi.product_id = p.id
               SET p.stock = GREATEST(0, p.stock - oi.quantity)
               WHERE oi.order_id = ? AND oi.format = 'paperback'`,
              [order_id],
              (err) => {
                if (err) console.error("Stock deduction error:", err);

                // Insert into shipping table
                db.query(
                  `INSERT INTO shipping (order_id, status, confirmed_at)
                   VALUES (?, 'confirmed', NOW())
                   ON DUPLICATE KEY UPDATE status = 'confirmed', confirmed_at = NOW()`,
                  [order_id],
                  (err) => {
                    if (err) console.error("Shipping insert error:", err);

                    // Clear the cart for this user since they completed an order.
                    db.query("DELETE FROM cart WHERE user_id = ?", [order.user_id]);

                    // Send confirmed email
                    sendOrderConfirmedEmail(order_id);
                  }
                );
              }
            );
          }
        );

        return res.json({ ok: true, msg: "Order updated via webhook" });
      }
    );
  } else {
    // Unhandled event
    res.json({ ok: true });
  }
});

module.exports = router;