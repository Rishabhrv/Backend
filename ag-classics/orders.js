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

/* ================= MY ORDERS ================= */
router.get("/", auth, (req, res) => {
  const sql = `
    SELECT id, total_amount, status, payment_status, created_at
    FROM orders
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/* ================= PAID ORDERS GROUPED BY DATE ================= */
router.get("/by-date", auth, (req, res) => {
  const sql = `
   SELECT 
      o.id AS order_id,
      o.total_amount,
      o.created_at,
      DATE(o.created_at) AS order_date,
      COUNT(DISTINCT oi.id) AS items_count,
      COALESCE(s.shipping_cost, 0) AS shipping_cost
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products pr ON pr.id = oi.product_id
    INNER JOIN product_categories pc ON pc.product_id = pr.id
    INNER JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agclassics'
    LEFT JOIN shipping s ON s.order_id = o.id
    WHERE o.user_id = ?
      AND o.payment_status = 'success'
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

router.get("/:orderId/shipping", auth, (req, res) => {
  const { orderId } = req.params;

  db.query(
    `SELECT *
     FROM shipping
     WHERE order_id = ?`,
    [orderId],
    (err, rows) => {
      if (err || !rows.length) {
        return res.json({
          status: "confirmed",
          confirmed_at: new Date(),
        });
      }

      res.json(rows[0]);
    }
  );
});


/* ================= ORDER DETAILS ================= */
router.get("/:orderId", auth, (req, res) => {
  const userId = req.user.id;
  const orderId = req.params.orderId;

  const sql = `
    SELECT 
      o.id AS order_id,
      o.total_amount,
      o.status,
      o.payment_status,
      o.created_at,
  
      p.transaction_id,
      p.payment_method,
      p.amount AS paid_amount,
  
      oi.product_id,
      oi.quantity,
      oi.price,
      oi.format,
  
      pr.title,
      pr.main_image,
  
      COALESCE(s.shipping_cost, 0) AS shipping_cost,
  
      oa.first_name,
      oa.last_name,
      oa.address,
      oa.city,
      oa.state,
      oa.pincode,
      oa.phone,
      oa.email AS shipping_email
  
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products pr ON pr.id = oi.product_id
    LEFT JOIN payments p ON p.order_id = o.id
    LEFT JOIN shipping s ON s.order_id = o.id
    LEFT JOIN order_address oa ON oa.order_id = o.id
    INNER JOIN product_categories pc ON pc.product_id = pr.id
    INNER JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agclassics'
  
    WHERE o.id = ?
    AND o.user_id = ?
  `;

  db.query(sql, [orderId, userId], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/*
  GET /api/orders/check-ebook-ownership/:productId
  Checks if the authenticated user has already purchased the ebook format of a specific product.
*/
router.get("/check-ebook-ownership/:productId", auth, async (req, res) => {
  try {
    const userId = req.user.id; // Assumes your 'auth' middleware attaches req.user
    const { productId } = req.params;

    // Look for an order item matching the product and format 'ebook'
    // tied to a successfully paid order for this user.
    const query = `
      SELECT COUNT(oi.id) as count 
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.user_id = ? 
        AND oi.product_id = ? 
        AND oi.format = 'ebook' 
        AND o.payment_status = 'success'
    `;

    const [rows] = await db.promise().query(query, [userId, productId]);

    // If count > 0, the user owns the ebook
    res.status(200).json({
      success: true,
      owned: rows[0].count > 0
    });

  } catch (error) {
    console.error("Check Ownership Error:", error);
    res.status(500).json({ success: false, message: "Server error checking ownership" });
  }
});



module.exports = router;
