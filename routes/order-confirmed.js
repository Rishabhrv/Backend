const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* 🔐 AUTH */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ================= GET ORDER FOR CONFIRMATION PAGE ================= */
router.get("/:orderId", auth, (req, res) => {
  const orderId = req.params.orderId;
  const userId  = req.user.id;

  // 1️⃣ Core order row + shipping row
  const orderSql = `
    SELECT
      o.id,
      o.total_amount,
      o.status,
      o.payment_status,
      o.razorpay_payment_id,
      o.coupon_code,
      o.coupon_discount,
      o.created_at,
      COALESCE(s.status, NULL)       AS shipping_status,
      COALESCE(s.shipping_cost, 0)   AS shipping_cost,
      s.courier,
      s.tracking_number,
      s.confirmed_at,
      s.shipped_at,
      s.out_for_delivery_at,
      s.delivered_at
    FROM orders o
    LEFT JOIN shipping s ON s.order_id = o.id
    WHERE o.id = ? AND o.user_id = ?
    LIMIT 1
  `;

  db.query(orderSql, [orderId, userId], (err, orders) => {
    if (err)            return res.status(500).json({ msg: "DB error" });
    if (!orders.length) return res.status(404).json({ msg: "Order not found" });

    const order = orders[0];

    // 2️⃣ Order items
    db.query(
      `SELECT
         oi.product_id,
         oi.format,
         oi.price,
         oi.quantity,
         p.title,
         p.main_image
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?`,
      [orderId],
      (err, items) => {
        if (err) return res.status(500).json({ msg: "Items fetch failed" });

        order.items = items || [];

        // 3️⃣ Delivery address
        db.query(
          `SELECT first_name, last_name, address, city, state, pincode, phone, email
           FROM order_address
           WHERE order_id = ?
           LIMIT 1`,
          [orderId],
          (err, addresses) => {
            if (err) return res.status(500).json({ msg: "Address fetch failed" });

            order.address = addresses.length ? addresses[0] : null;
            res.json(order);
          }
        );
      }
    );
  });
});

module.exports = router;