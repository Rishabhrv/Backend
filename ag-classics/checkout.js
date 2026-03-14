// routes/checkout.js
const express  = require("express");
const router   = express.Router();
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const jwt      = require("jsonwebtoken");
const db       = require("../db");

const SECRET          = process.env.JWT_SECRET  || "MY_SECRET_KEY";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const razorpay = new Razorpay({
  key_id:     RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_SECRET,
});

/* ═══════════════════ AUTH MIDDLEWARE ═══════════════════ */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ success: false, message: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ═══════════════════ HELPERS ═══════════════════ */

// Fetch cart items for the user with full product details
function getCartItems(userId) {
  return new Promise((resolve, reject) => {
        const sql = `
          SELECT
            c.id,
            c.product_id,
            c.format,
            c.quantity,
            p.title,
            p.price,
            p.sell_price,
            p.stock,
            p.product_type
          FROM cart c
          JOIN products p ON p.id = c.product_id
          JOIN product_categories pc ON pc.product_id = p.id
          JOIN categories cat ON cat.id = pc.category_id
          WHERE c.user_id = ?
            AND p.status = 'published'
            AND cat.imprint = 'agclassics'
        `;
    db.query(sql, [userId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Apply coupon and return discount amount
function applyCoupon(code, cartTotal, userId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * FROM coupons
      WHERE code = ?
        AND status = 'active'
        AND start_date  <= CURDATE()
        AND expiry_date >= CURDATE()
        AND (usage_limit IS NULL OR usage_limit > (
          SELECT COUNT(*) FROM coupon_usage WHERE coupon_id = coupons.id
        ))
        AND min_cart_value <= ?
    `;
    db.query(sql, [code, cartTotal], (err, rows) => {
      if (err) return reject(err);
      if (!rows.length) return resolve({ valid: false, discount: 0, message: "Invalid or expired coupon" });

      const coupon = rows[0];

      // Check per-user limit
      db.query(
        "SELECT COUNT(*) AS used FROM coupon_usage WHERE coupon_id = ? AND user_id = ?",
        [coupon.id, userId],
        (err2, used) => {
          if (err2) return reject(err2);
          if (coupon.usage_per_user && used[0].used >= coupon.usage_per_user) {
            return resolve({ valid: false, discount: 0, message: "Coupon usage limit reached" });
          }

          let discount = 0;
          if (coupon.discount_type === "percent") {
            discount = (cartTotal * coupon.discount_value) / 100;
            if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
          } else {
            discount = coupon.discount_value;
          }

          resolve({ valid: true, discount: Math.round(discount), coupon_id: coupon.id });
        }
      );
    });
  });
}

/* ═══════════════════ ROUTES ═══════════════════ */

/**
 * POST /api/checkout/create-order
 * Creates a Razorpay order after validating cart & coupon
 */
router.post("/create-order", auth, async (req, res) => {
  const { address, coupon_code } = req.body;

  // 1. Validate address fields
  const required = ["first_name", "last_name", "email", "phone", "address", "city", "state", "pincode"];
  for (const field of required) {
    if (!address?.[field]?.toString().trim()) {
      return res.status(400).json({ success: false, message: `${field} is required` });
    }
  }

  if (!/^\d{10}$/.test(address.phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  if (!/^\d{6}$/.test(address.pincode)) {
    return res.status(400).json({ success: false, message: "Invalid PIN code" });
  }

  try {
    // 2. Fetch cart
    const cartItems = await getCartItems(req.user.id);
    if (!cartItems.length) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    // 3. Validate stock
    for (const item of cartItems) {
      if (item.format === "paperback" && item.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `"${item.title}" has insufficient stock`,
        });
      }
    }

    // 4. Calculate totals
    const subtotal = cartItems.reduce((s, i) => s + parseFloat(i.sell_price) * i.quantity, 0);
    const shipping = subtotal >= 499 ? 0 : 49;

    // 5. Apply coupon
    let couponDiscount = 0;
    let couponId       = null;
    let usedCouponCode = null;

    if (coupon_code) {
      const couponResult = await applyCoupon(coupon_code, subtotal, req.user.id);
      if (!couponResult.valid) {
        return res.status(400).json({ success: false, message: couponResult.message });
      }
      couponDiscount = couponResult.discount;
      couponId       = couponResult.coupon_id;
      usedCouponCode = coupon_code;
    }

    const total = Math.max(0, Math.round(subtotal + shipping - couponDiscount));

    // 6. Create DB order (pending)
    const orderInsert = await new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO orders
           (user_id, total_amount, status, payment_status, coupon_code, coupon_discount)
         VALUES (?, ?, 'pending', 'pending', ?, ?)`,
        [req.user.id, total, usedCouponCode, couponDiscount],
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
    });
    const orderId = orderInsert.insertId;

    // 7. Insert order items
    await new Promise((resolve, reject) => {
      const values = cartItems.map((i) => [
        orderId, i.product_id, i.format, i.sell_price, i.quantity,
      ]);
      db.query(
        "INSERT INTO order_items (order_id, product_id, format, price, quantity) VALUES ?",
        [values],
        (err) => { if (err) return reject(err); resolve(); }
      );
    });

    // 8. Save order address
    await new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO order_address
           (order_id, first_name, last_name, address, city, state, pincode, phone, email, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          address.first_name, address.last_name, address.address,
          address.city,       address.state,      address.pincode,
          address.phone,      address.email,       address.country || "India",
        ],
        (err) => { if (err) return reject(err); resolve(); }
      );
    });

    // 9. Create Razorpay order
    const rzpOrder = await razorpay.orders.create({
      amount:   total * 100,   // paise
      currency: "INR",
      receipt:  `order_${orderId}`,
      notes:    { order_id: String(orderId), user_id: String(req.user.id) },
    });

    // 10. Store Razorpay order ID in DB
    await new Promise((resolve, reject) => {
      db.query(
        "UPDATE orders SET razorpay_order_id = ? WHERE id = ?",
        [rzpOrder.id, orderId],
        (err) => { if (err) return reject(err); resolve(); }
      );
    });

    // Create initial shipping record
    await new Promise((resolve) => {
      db.query(
        "INSERT INTO shipping (order_id, status) VALUES (?, 'confirmed')",
        [orderId],
        () => resolve() // non-fatal if fails
      );
    });

    // Track coupon usage (pre-emptively; delete if payment fails)
    if (couponId) {
      await new Promise((resolve) => {
        db.query(
          "INSERT INTO coupon_usage (coupon_id, user_id, order_id) VALUES (?, ?, ?)",
          [couponId, req.user.id, orderId],
          () => resolve()
        );
      });
    }

    res.json({
      success:          true,
      order_id:         orderId,
      razorpay_order_id: rzpOrder.id,
      razorpay_amount:  rzpOrder.amount,
      total,
    });

  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ success: false, message: "Order creation failed", error: err.message });
  }
});


/**
 * POST /api/checkout/verify
 * Verifies Razorpay payment signature and marks order as paid
 */
router.post("/verify", auth, async (req, res) => {
  const {
    order_id,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = req.body;

  if (!order_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: "Missing payment details" });
  }

  try {
    // 1. Verify HMAC signature
    const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac("sha256", RAZORPAY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      // Mark order as payment failed
      await new Promise((resolve) => {
        db.query(
          "UPDATE orders SET payment_status='failed' WHERE id=? AND user_id=?",
          [order_id, req.user.id],
          () => resolve()
        );
      });
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    // 2. Fetch the order to confirm it belongs to this user & is still pending
    const [order] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT * FROM orders WHERE id=? AND user_id=? AND payment_status='pending'",
        [order_id, req.user.id],
        (err, rows) => { if (err) return reject(err); resolve(rows); }
      );
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found or already processed" });
    }

    // 3. Update order to paid
    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE orders
         SET payment_status    = 'success',
             status            = 'paid',
             razorpay_payment_id = ?
         WHERE id = ?`,
        [razorpay_payment_id, order_id],
        (err) => { if (err) return reject(err); resolve(); }
      );
    });

    // 4. Deduct stock for paperback items
    const cartItems = await new Promise((resolve, reject) => {
      db.query(
        "SELECT * FROM order_items WHERE order_id = ?",
        [order_id],
        (err, rows) => { if (err) return reject(err); resolve(rows); }
      );
    });

    for (const item of cartItems) {
      if (item.format === "paperback") {
        await new Promise((resolve) => {
          db.query(
            "UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?",
            [item.quantity, item.product_id],
            () => resolve()
          );
        });
      }
    }

    // 5. Clear the user's cart
    await new Promise((resolve) => {
      db.query("DELETE FROM cart WHERE user_id = ?", [req.user.id], () => resolve());
    });

    // 6. Create admin notification
    await new Promise((resolve) => {
      db.query(
        `INSERT INTO admin_notifications (type, title, message, ref_id)
         VALUES ('order', 'New Order Received', ?, ?)`,
        [`Order #${order_id} — ₹${order.total_amount} — Payment confirmed`, order_id],
        () => resolve()
      );
    });

    res.json({
      success:    true,
      message:    "Payment verified",
      order_id,
    });

  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ success: false, message: "Verification failed", error: err.message });
  }
});


/**
 * POST /api/coupons/apply
 * Check and preview a coupon discount (no usage recorded)
 */
router.post("/coupon-check", auth, async (req, res) => {
  const { code, cart_total } = req.body;
  if (!code || !cart_total) {
    return res.status(400).json({ success: false, message: "code and cart_total required" });
  }
  try {
    const result = await applyCoupon(code, cart_total, req.user.id);
    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({ success: true, discount: result.discount });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;