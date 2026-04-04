// routes/agclassics/checkout.js
// ─── API prefix: /api/ag-classics/checkout ───────────────────────────────────

const express    = require("express");
const router     = express.Router();
const Razorpay   = require("razorpay");
const crypto     = require("crypto");
const jwt        = require("jsonwebtoken");
const db         = require("../db");
const nodemailer = require("nodemailer");

const SECRET          = process.env.JWT_SECRET        || "MY_SECRET_KEY";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const IMPRINT         = "agclassics";

const razorpay = new Razorpay({
  key_id:     RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_SECRET,
});


const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST || "smtp.gmail.com",
  port:   Number(process.env.MAIL_PORT) || 587,
  secure: Number(process.env.MAIL_PORT) === 465,  // true for 465, false for 587
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ═══════════════════ AUTH ═══════════════════ */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ success: false, message: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ═══════════════════════════════════════════════════════
   GET /api/ag-classics/checkout/me
   Returns user profile + saved address for form prefill.
   Mirrors AGPH reference checkout GET /me
═══════════════════════════════════════════════════════ */
router.get("/me", auth, (req, res) => {
  const sql = `
    SELECT
      u.id,
      u.name,
      u.email,
      u.phone,
      a.address,
      a.city,
      a.state,
      a.pincode,
      a.country
    FROM users u
    LEFT JOIN user_addresses a ON a.user_id = u.id
    WHERE u.id = ?
  `;
  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error" });
    const row = rows[0] || {};
    res.json({
      success: true,
      name:    row.name    || "",
      email:   row.email   || "",
      phone:   row.phone   || "",
      address: row.address || "",
      city:    row.city    || "",
      state:   row.state   || "",
      pincode: row.pincode || "",
      country: row.country || "India",
    });
  });
});

/* ═══════════════════════════════════════════════════════
   POST /api/ag-classics/checkout/save-address
   Upsert user's saved address (one row per user).
   Mirrors AGPH reference checkout POST /save-address
═══════════════════════════════════════════════════════ */
router.post("/save-address", auth, (req, res) => {
  const { address, city, state, pincode, country = "India" } = req.body;
  if (!address || !city || !state || !pincode)
    return res.status(400).json({ success: false, message: "address, city, state, pincode required" });

  db.query("SELECT id FROM user_addresses WHERE user_id = ?", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error" });

    if (rows.length > 0) {
      db.query(
        `UPDATE user_addresses SET address=?, city=?, state=?, pincode=?, country=? WHERE user_id=?`,
        [address, city, state, pincode, country, req.user.id],
        (err) => {
          if (err) return res.status(500).json({ success: false, message: "Update failed" });
          res.json({ success: true, message: "Address updated" });
        }
      );
    } else {
      db.query(
        `INSERT INTO user_addresses (user_id, address, city, state, pincode, country) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, address, city, state, pincode, country],
        (err) => {
          if (err) return res.status(500).json({ success: false, message: "Insert failed" });
          res.json({ success: true, message: "Address saved" });
        }
      );
    }
  });
});

/* ═══════════════════════════════════════════════════════
   POST /api/ag-classics/checkout/shipping-cost
   Weight-based dynamic shipping cost calculation.
   Mirrors AGPH reference shipping-cost route exactly —
   only imprint changed from 'agph' → 'agclassics'.
═══════════════════════════════════════════════════════ */
router.post("/shipping-cost", auth, (req, res) => {
  const { state } = req.body;
  if (!state) return res.status(400).json({ success: false, message: "State required" });

  /* 1️⃣ Paperback cart items with their weights */
  const cartSql = `
    SELECT c.quantity, sd.weight
    FROM cart c
    JOIN shipping_details sd ON sd.product_id = c.product_id
    JOIN product_categories pc ON pc.product_id = c.product_id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE c.user_id = ?
      AND c.format = 'paperback'
      AND cat.imprint = ?
  `;
  db.query(cartSql, [req.user.id, IMPRINT], (err, items) => {
    if (err) return res.status(500).json({ success: false, message: "DB error" });
    if (!items.length) return res.json({ success: true, shipping: 0 });

    /* 2️⃣ Total weight */
    let totalWeight = 0;
    items.forEach(i => { totalWeight += Number(i.weight) * Number(i.quantity); });

    /* 3️⃣ Find zone for this state */
    db.query(
      `SELECT z.id FROM shipping_zones z
       JOIN shipping_zone_regions r ON r.zone_id = z.id
       WHERE r.region_name = ? AND z.status = 'active'
       LIMIT 1`,
      [state],
      (err, zones) => {
        if (err || !zones.length) return res.json({ success: true, shipping: 0 });
        const zoneId = zones[0].id;

        /* 4️⃣ Get weight-based method for this zone */
        db.query(
          `SELECT id FROM shipping_methods
           WHERE zone_id = ? AND method_type = 'weight' AND enabled = 1
           LIMIT 1`,
          [zoneId],
          (err, methods) => {
            if (err || !methods.length) return res.json({ success: true, shipping: 0 });
            const methodId = methods[0].id;

            /* 5️⃣ Match weight rule */
            db.query(
              `SELECT * FROM weight_shipping_rules
               WHERE shipping_method_id = ?
                 AND weight_from <= ?
                 AND (weight_to IS NULL OR weight_to >= ?)
               ORDER BY weight_from DESC LIMIT 1`,
              [methodId, totalWeight, totalWeight],
              (err, rules) => {
                if (err || !rules.length) return res.json({ success: true, shipping: 0 });

                const r = rules[0];
                let cost = 0;

                switch (r.charge_type) {
                  case "free":             cost = 0; break;
                  case "flat":             cost = Number(r.flat_cost); break;
                  case "progressive":      cost = totalWeight * Number(r.per_kg_cost); break;
                  case "flat_progressive":
                    cost = totalWeight <= r.base_weight
                      ? Number(r.base_cost)
                      : Number(r.base_cost) + (totalWeight - r.base_weight) * Number(r.extra_cost_per_kg);
                    break;
                }

                res.json({ success: true, shipping: Math.round(cost), totalWeight });
              }
            );
          }
        );
      }
    );
  });
});

/* ═══════════════════ CART HELPER ═══════════════════ */
function getCartItems(userId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT
        c.id, c.product_id, c.format, c.quantity, p.title,
        p.price AS product_price, p.sell_price AS product_sell_price,
        p.stock, p.product_type,
        MIN(e.price)      AS ebook_price,
        MIN(e.sell_price) AS ebook_sell_price,
        CASE
          WHEN c.format = 'ebook' THEN COALESCE(MIN(e.sell_price), p.sell_price)
          ELSE p.sell_price
        END AS effective_price,
        CASE
          WHEN c.format = 'ebook' THEN COALESCE(MIN(e.price), p.price)
          ELSE p.price
        END AS effective_original_price,
        GROUP_CONCAT(DISTINCT pc2.category_id) AS category_ids
      FROM cart c
      JOIN products p ON p.id = c.product_id
      JOIN product_categories pc ON pc.product_id = p.id
      JOIN categories cat ON cat.id = pc.category_id
      LEFT JOIN ebooks e ON e.product_id = p.id
      LEFT JOIN product_categories pc2 ON pc2.product_id = p.id
      WHERE c.user_id = ? AND p.status = 'published' AND cat.imprint = ?
      GROUP BY c.id
    `;
    db.query(sql, [userId, IMPRINT], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/* ═══════════════════ EMAIL (fire-and-forget) ═══════════════════ */
async function sendOrderConfirmedEmail(orderId) {
  try {
    const orderRows = await new Promise((resolve, reject) =>
      db.query(
        `SELECT o.id, o.total_amount, o.created_at, u.name, u.email
         FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ? LIMIT 1`,
        [orderId], (err, rows) => (err ? reject(err) : resolve(rows))
      )
    );
    if (!orderRows?.length) return;
    const row = orderRows[0];

    const items = await new Promise((resolve, reject) =>
      db.query(
        `SELECT p.title, oi.format, oi.quantity, oi.price
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ?`,
        [orderId], (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    );

    const itemsHtml = items.map(i => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2d;font-size:13px;color:#f5f0e8;">${i.title}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2d;font-size:12px;color:#6b6b70;text-align:center;">
          ${i.format === "ebook" ? "E-Book" : `Paperback × ${i.quantity}`}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2d;font-size:13px;color:#c9a84c;text-align:right;">
          ₹${Math.round(Number(i.price) * i.quantity).toLocaleString("en-IN")}
        </td>
      </tr>
    `).join("");

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0b;">
      <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="text-align:center;margin-bottom:32px;">
          <p style="font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#c9a84c;margin:0 0 8px;">AG Classics</p>
          <h1 style="font-family:Georgia,serif;font-size:32px;font-weight:300;font-style:italic;color:#f5f0e8;margin:0;">Order Confirmed</h1>
        </div>
        <p style="font-size:13px;color:#6b6b70;line-height:1.8;margin-bottom:24px;">
          Dear ${row.name || "Valued Customer"},<br/>
          Your order <strong style="color:#c9a84c;">#${row.id}</strong> has been confirmed.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0"
          style="border-collapse:collapse;background:#1c1c1e;border:1px solid rgba(201,168,76,0.15);margin-bottom:24px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(201,168,76,0.2);">
              <th style="padding:10px 12px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b6b70;text-align:left;">Item</th>
              <th style="padding:10px 12px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b6b70;text-align:center;">Format</th>
              <th style="padding:10px 12px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b6b70;text-align:right;">Price</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="background:#1c1c1e;border:1px solid rgba(201,168,76,0.15);padding:16px 20px;margin-bottom:24px;">
          <div style="display:flex;justify-content:space-between;">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6b70;">Total Paid</span>
            <span style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#c9a84c;">
              ₹${Math.round(Number(row.total_amount)).toLocaleString("en-IN")}
            </span>
          </div>
        </div>
        <p style="font-size:11px;color:#6b6b70;text-align:center;line-height:1.8;">
          Track your order at
          <a href="${process.env.FRONTEND_URL || "#"}/orders" style="color:#c9a84c;">My Orders</a>.
        </p>
      </div>
    </body></html>`;

    await transporter.sendMail({
      from: `"AG Classics" <${process.env.MAIL_USER}>`,
      to: row.email,
      subject: `Order Confirmed — #${row.id} · AG Classics`,
      html,
    });
    console.log(`✅ Email sent → ${row.email} (order #${orderId})`);
  } catch (err) {
    console.error("❌ Email failed:", err.message);
  }
}

/* ═══════════════════ COUPON VALIDATION ═══════════════════ */
async function validateCoupon(code, userId, cartItems) {
  const coupons = await new Promise((resolve, reject) =>
    db.query(
      `SELECT * FROM coupons WHERE code = ? AND status = 'active'
       AND start_date <= CURDATE() AND expiry_date >= CURDATE()`,
      [code], (err, rows) => (err ? reject(err) : resolve(rows))
    )
  );
  if (!coupons.length) return { valid: false, message: "Invalid or expired coupon" };
  const coupon = coupons[0];

  const [{ total_used }] = await new Promise((resolve, reject) =>
    db.query("SELECT COUNT(*) AS total_used FROM coupon_usage WHERE coupon_id = ?",
      [coupon.id], (err, rows) => (err ? reject(err) : resolve(rows)))
  );
  if (coupon.usage_limit !== null && total_used >= coupon.usage_limit)
    return { valid: false, message: "Coupon usage limit reached" };

  const [{ used }] = await new Promise((resolve, reject) =>
    db.query("SELECT COUNT(*) AS used FROM coupon_usage WHERE coupon_id = ? AND user_id = ?",
      [coupon.id, userId], (err, rows) => (err ? reject(err) : resolve(rows)))
  );
  if (coupon.usage_per_user !== null && used >= coupon.usage_per_user)
    return { valid: false, message: "You have already used this coupon" };

  let allowedProductIds = [], allowedCategoryIds = [];
  if (coupon.applicable_on === "product") {
    const rows = await new Promise((resolve, reject) =>
      db.query("SELECT product_id FROM coupon_products WHERE coupon_id = ?",
        [coupon.id], (err, rows) => (err ? reject(err) : resolve(rows || [])))
    );
    allowedProductIds = rows.map(r => r.product_id);
  }
  if (coupon.applicable_on === "category") {
    const rows = await new Promise((resolve, reject) =>
      db.query("SELECT category_id FROM coupon_categories WHERE coupon_id = ?",
        [coupon.id], (err, rows) => (err ? reject(err) : resolve(rows || [])))
    );
    allowedCategoryIds = rows.map(r => r.category_id);
  }

  let eligibleSubtotal = 0;
  const eligibleTitles = [];
  for (const item of cartItems) {
    const itemTotal = Number(item.effective_price || 0) * (item.quantity || 1);
    if (coupon.product_type !== "all") {
      if (coupon.product_type === "ebook"    && item.format !== "ebook")     continue;
      if (coupon.product_type === "physical" && item.format !== "paperback") continue;
    }
    if (coupon.applicable_on === "all") {
      eligibleSubtotal += itemTotal; eligibleTitles.push(item.title); continue;
    }
    if (coupon.applicable_on === "product") {
      if (allowedProductIds.includes(item.product_id)) { eligibleSubtotal += itemTotal; eligibleTitles.push(item.title); }
      continue;
    }
    if (coupon.applicable_on === "category") {
      const itemCatIds = (item.category_ids || "").split(",").map(Number);
      if (itemCatIds.some(c => allowedCategoryIds.includes(c))) { eligibleSubtotal += itemTotal; eligibleTitles.push(item.title); }
    }
  }

  if (!eligibleSubtotal)
    return { valid: false, message: "Coupon not applicable to items in your cart" };

  if (coupon.min_cart_value && eligibleSubtotal < coupon.min_cart_value)
    return { valid: false, message: `Add ₹${(coupon.min_cart_value - eligibleSubtotal).toFixed(0)} more to apply this coupon` };

  let discount = coupon.discount_type === "percent"
    ? (eligibleSubtotal * coupon.discount_value) / 100
    : coupon.discount_value;
  if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);

  return { valid: true, discount: Math.round(discount), coupon_id: coupon.id, eligible_items: eligibleTitles, applicable_on: coupon.applicable_on };
}

/* ═══════════════════ COUPON CHECK ═══════════════════ */
router.post("/coupon-check", auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false, message: "Coupon code required" });
  try {
    const cartItems = await getCartItems(req.user.id);
    if (!cartItems.length)
      return res.status(400).json({ success: false, message: "Your cart is empty" });
    const result = await validateCoupon(code, req.user.id, cartItems);
    if (!result.valid)
      return res.status(400).json({ success: false, message: result.message });
    res.json({ success: true, discount: result.discount, eligible_items: result.eligible_items, applicable_on: result.applicable_on });
  } catch (err) {
    console.error("coupon-check error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ═══════════════════ CREATE ORDER ═══════════════════ */
router.post("/create-order", auth, async (req, res) => {
  /* Frontend sends shipping value it fetched from /shipping-cost */
  const { address, coupon_code, shipping: clientShipping } = req.body;

  const required = ["first_name","last_name","email","phone","address","city","state","pincode"];
  for (const field of required) {
    if (!address?.[field]?.toString().trim())
      return res.status(400).json({ success: false, message: `${field} is required` });
  }
  if (!/^\d{10}$/.test(address.phone))
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  if (!/^\d{6}$/.test(address.pincode))
    return res.status(400).json({ success: false, message: "Invalid PIN code" });

  try {
    const cartItems = await getCartItems(req.user.id);
    if (!cartItems.length)
      return res.status(400).json({ success: false, message: "Cart is empty" });

    for (const item of cartItems) {
      if (item.format === "paperback" && item.stock < item.quantity)
        return res.status(400).json({ success: false, message: `"${item.title}" has insufficient stock` });
    }

    const subtotal = cartItems.reduce((s, i) => s + parseFloat(i.effective_price) * i.quantity, 0);

    /* Use the shipping value the frontend computed via /shipping-cost */
    const shipping = Number(clientShipping) || 0;

    let couponDiscount = 0, couponId = null, usedCouponCode = null;
    if (coupon_code) {
      const result = await validateCoupon(coupon_code, req.user.id, cartItems);
      if (!result.valid)
        return res.status(400).json({ success: false, message: result.message });
      couponDiscount = result.discount;
      couponId       = result.coupon_id;
      usedCouponCode = coupon_code;
    }

    const total = Math.max(0, Math.round(subtotal + shipping - couponDiscount));

    const orderInsert = await new Promise((resolve, reject) =>
      db.query(
        `INSERT INTO orders (user_id, total_amount, status, payment_status, coupon_code, coupon_discount)
         VALUES (?, ?, 'pending', 'pending', ?, ?)`,
        [req.user.id, total, usedCouponCode, couponDiscount],
        (err, result) => (err ? reject(err) : resolve(result))
      )
    );
    const orderId = orderInsert.insertId;

    await new Promise((resolve, reject) => {
      const values = cartItems.map(i => [orderId, i.product_id, i.format, i.effective_price, i.quantity]);
      db.query("INSERT INTO order_items (order_id, product_id, format, price, quantity) VALUES ?",
        [values], (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) =>
      db.query(
        `INSERT INTO order_address
           (order_id, first_name, last_name, address, city, state, pincode, phone, email, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, address.first_name, address.last_name, address.address,
         address.city, address.state, address.pincode,
         address.phone, address.email, address.country || "India"],
        (err) => (err ? reject(err) : resolve())
      )
    );

    if (shipping > 0) {
      await new Promise((resolve) =>
        db.query(
          `INSERT INTO shipping (order_id, shipping_cost, status) VALUES (?, ?, 'confirmed')
           ON DUPLICATE KEY UPDATE shipping_cost = VALUES(shipping_cost)`,
          [orderId, shipping], () => resolve()
        )
      );
    } else {
      await new Promise((resolve) =>
        db.query("INSERT INTO shipping (order_id, status) VALUES (?, 'confirmed')",
          [orderId], () => resolve())
      );
    }

    if (couponId) {
      await new Promise((resolve) =>
        db.query("INSERT INTO coupon_usage (coupon_id, user_id, order_id) VALUES (?, ?, ?)",
          [couponId, req.user.id, orderId], () => resolve())
      );
    }

    const rzpOrder = await razorpay.orders.create({
      amount: total * 100, currency: "INR",
      receipt: `agc_order_${orderId}`,
      notes: { order_id: String(orderId), user_id: String(req.user.id) },
    });

    await new Promise((resolve, reject) =>
      db.query("UPDATE orders SET razorpay_order_id = ? WHERE id = ?",
        [rzpOrder.id, orderId], (err) => (err ? reject(err) : resolve()))
    );

    res.json({ success: true, order_id: orderId, razorpay_order_id: rzpOrder.id, razorpay_amount: rzpOrder.amount, total });

  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ success: false, message: "Order creation failed", error: err.message });
  }
});

/* ═══════════════════ VERIFY ═══════════════════ */
router.post("/verify", auth, async (req, res) => {
  const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!order_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ success: false, message: "Missing payment details" });

  try {
    const expected = crypto
      .createHmac("sha256", RAZORPAY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      await new Promise((resolve) =>
        db.query("UPDATE orders SET payment_status='failed' WHERE id=? AND user_id=?",
          [order_id, req.user.id], () => resolve())
      );
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    const [order] = await new Promise((resolve, reject) =>
      db.query("SELECT * FROM orders WHERE id=? AND user_id=? AND payment_status='pending'",
        [order_id, req.user.id], (err, rows) => (err ? reject(err) : resolve(rows)))
    );
    if (!order)
      return res.status(404).json({ success: false, message: "Order not found or already processed" });

    await new Promise((resolve, reject) =>
      db.query(
        `UPDATE orders SET payment_status='success', status='paid', razorpay_payment_id=? WHERE id=?`,
        [razorpay_payment_id, order_id], (err) => (err ? reject(err) : resolve())
      )
    );

    await new Promise((resolve) =>
      db.query(
        `UPDATE products p JOIN order_items oi ON oi.product_id = p.id
         SET p.stock = GREATEST(0, p.stock - oi.quantity)
         WHERE oi.order_id = ? AND oi.format = 'paperback'`,
        [order_id], (err) => { if (err) console.error("Stock error:", err); resolve(); }
      )
    );

    await new Promise((resolve) =>
      db.query("DELETE FROM cart WHERE user_id = ?", [req.user.id], () => resolve())
    );

    await new Promise((resolve) =>
      db.query(
        `INSERT INTO admin_notifications (type, title, message, ref_id)
         VALUES ('order', 'New Order — AG Classics', ?, ?)`,
        [`Order #${order_id} — ₹${order.total_amount} — Payment confirmed`, order_id],
        () => resolve()
      )
    );

    sendOrderConfirmedEmail(order_id); // fire-and-forget

    res.json({ success: true, message: "Payment verified", order_id });

  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ success: false, message: "Verification failed", error: err.message });
  }
});

module.exports = router;