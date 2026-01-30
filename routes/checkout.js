const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* 🔐 AUTH MIDDLEWARE */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

router.get("/me", auth, (req, res) => {
  const userId = req.user.id;

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

  db.query(sql, [userId], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows[0]);
  });
});


router.post("/save-address", auth, (req, res) => {
  const userId = req.user.id;
  const { address, city, state, pincode } = req.body;

  const checkSql = `SELECT id FROM user_addresses WHERE user_id=?`;

  db.query(checkSql, [userId], (err, rows) => {
    if (err) return res.status(500).json(err);

    if (rows.length > 0) {
      // UPDATE
      db.query(
        `UPDATE user_addresses 
         SET address=?, city=?, state=?, pincode=?, country='India'
         WHERE user_id=?`,
        [address, city, state, pincode, userId],
        () => res.json({ msg: "Address updated" })
      );
    } else {
      // INSERT
      db.query(
        `INSERT INTO user_addresses 
         (user_id, address, city, state, pincode, country)
         VALUES (?, ?, ?, ?, ?, 'India')`,
        [userId, address, city, state, pincode],
        () => res.json({ msg: "Address saved" })
      );
    }
  });
});


/* ================= CREATE ORDER ================= */
router.post("/create", auth, (req, res) => {
  const user_id = req.user.id;

  const cartSql = `
    SELECT 
      c.product_id,
      c.format,
      c.quantity,
      p.sell_price AS paperback_price,
      e.sell_price AS ebook_price
    FROM cart c
    JOIN products p ON p.id = c.product_id
    LEFT JOIN ebooks e ON e.product_id = p.id
    WHERE c.user_id = ?
  `;

  db.query(cartSql, [user_id], (err, items) => {
    if (err || items.length === 0)
      return res.status(400).json({ msg: "Cart empty" });

let subtotal = 0;
let hasPaperback = false;

items.forEach((i) => {
  if (i.format === "ebook") {
    subtotal += Number(i.ebook_price) * Number(i.quantity || 1);
  } else {
    subtotal += Number(i.paperback_price) * Number(i.quantity);
    hasPaperback = true;
  }
});


const shipping = hasPaperback ? 129 : 0;
const total = subtotal + shipping;


    const orderSql = `
      INSERT INTO orders (user_id, total_amount, status, payment_status)
      VALUES (?, ?, 'pending', 'pending')
    `;

    db.query(orderSql, [user_id, total], (err, result) => {
      if (err) return res.status(500).json(err);

      const order_id = result.insertId;

      const orderItems = items.map((i) => [
        order_id,
        i.product_id,
        i.format, // ✅ NEW
        i.format === "ebook" ? i.ebook_price : i.paperback_price,
        i.format === "ebook" ? 1 : i.quantity
      ]);
      
      db.query(
        `INSERT INTO order_items 
         (order_id, product_id, format, price, quantity) 
         VALUES ?`,
        [orderItems],
        () => {
          res.json({
            msg: "Order created",
            order_id,
            subtotal,
            shipping,
            total,
          });
        }
      );

    });
  });
});

/* ================= CLEAR CART ================= */
router.delete("/clear", auth, (req, res) => {
  db.query(
    "DELETE FROM cart WHERE user_id = ?",
    [req.user.id],
    () => res.json({ msg: "Cart cleared" })
  );
});

module.exports = router;
