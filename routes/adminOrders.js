const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");

const SECRET = "MY_SECRET_KEY";

/* 🔐 ADMIN AUTH */
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ msg: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ msg: "Admin only" });
    }
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });  
  }
}

/* ============================
   📦 GET ALL ORDERS
============================ */
router.get("/orders", adminAuth, (req, res) => {
  db.query(
    `SELECT 
       o.id,
       o.total_amount,
       o.status,
       o.payment_status,
       o.created_at,
       u.name AS user_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});

/* ============================
   📄 GET SINGLE ORDER (FULL)
============================ */
router.get("/orders/:id", adminAuth, (req, res) => {
  const orderId = req.params.id;

  /* 1️⃣ ORDER + USER */
  db.query(
    `SELECT 
       o.id,
       o.total_amount,
       o.status,
       o.payment_status,
       o.razorpay_order_id,
       o.razorpay_payment_id,
       o.created_at,
       u.id AS user_id,
       u.name,
       u.email,
       u.phone
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = ?
     LIMIT 1`,
    [orderId],
    (err, orderRows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (!orderRows.length)
        return res.status(404).json({ msg: "Order not found" });

      const order = orderRows[0];

      /* 2️⃣ ADDRESS */
      db.query(
        `SELECT * FROM user_addresses WHERE user_id = ? LIMIT 1`,
        [order.user_id],
        (err, addressRows) => {
          if (err) return res.status(500).json({ msg: "DB error" });
          const address = addressRows[0] || {};

          /* 3️⃣ ITEMS + PRODUCT MAIN IMAGE + FORMAT */
          db.query(
            `SELECT 
               p.title,
               p.main_image AS main_image,
               oi.quantity,
               oi.price,
               oi.format
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id
             WHERE oi.order_id = ?`,
            [orderId],
            (err, items) => {
              if (err) return res.status(500).json({ msg: "DB error" });

          /* continue payment + shipping */


              /* 4️⃣ PAYMENT */
              db.query(
                `SELECT * FROM payments WHERE order_id = ? LIMIT 1`,
                [orderId],
                (err, paymentRows) => {
                  if (err) return res.status(500).json({ msg: "DB error" });

                  /* 5️⃣ SHIPPING */
                  db.query(
                    `SELECT * FROM shipping WHERE order_id = ? LIMIT 1`,
                    [orderId],
                    (err, shippingRows) => {
                      if (err)
                        return res.status(500).json({ msg: "DB error" });

                      res.json({
                        order: {
                          id: order.id,
                          status: order.status,
                          payment_status: order.payment_status,
                          total_amount: order.total_amount,
                          created_at: order.created_at,
                          razorpay_order_id: order.razorpay_order_id,
                          razorpay_payment_id: order.razorpay_payment_id,
                        },
                        customer: {
                          name: order.name,
                          email: order.email,
                          phone: order.phone,
                        },
                        billing: address,
                        shipping: shippingRows[0] || {},
                        payment: paymentRows[0] || {},
                        items,
                      });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});


router.post("/orders/:id/shipping", adminAuth, (req, res) => {
  const orderId = req.params.id;
  const { courier, tracking_number, status } = req.body;

  const columnMap = {
    confirmed: "confirmed_at",
    shipped: "shipped_at",
    out_for_delivery: "out_for_delivery_at",
    delivered: "delivered_at",
  };

  const timeColumn = columnMap[status];
  if (!timeColumn) {
    return res.status(400).json({ msg: "Invalid status" });
  }

  db.query(
    `INSERT INTO shipping (order_id, courier, tracking_number, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       courier = VALUES(courier),
       tracking_number = VALUES(tracking_number),
       status = VALUES(status),
       ${timeColumn} = NOW()`,
    [orderId, courier, tracking_number, status],
    () => res.json({ success: true })
  );
});


module.exports = router;
