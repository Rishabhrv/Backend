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
 

  const shipping = req.body.shipping || 0;
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


/* ================================
   🚚 CALCULATE SHIPPING COST
================================ */
router.post("/shipping-cost", auth, (req, res) => {
  const userId = req.user.id;
  const { state } = req.body;

  if (!state) {
    return res.status(400).json({ msg: "State required" });
  }

  // 1️⃣ Get cart with weights
  const cartSql = `
    SELECT 
      c.quantity,
      sd.weight
    FROM cart c
    JOIN shipping_details sd ON sd.product_id = c.product_id
    WHERE c.user_id = ?
    AND c.format = 'paperback'
  `;

  db.query(cartSql, [userId], (err, items) => {
    if (err) return res.status(500).json(err);
    if (!items.length) return res.json({ shipping: 0 });

    // 2️⃣ Total weight
    let totalWeight = 0;
    items.forEach(i => {
      totalWeight += Number(i.weight) * Number(i.quantity);
    });

    // 3️⃣ Find shipping zone by state
    const zoneSql = `
      SELECT z.id
      FROM shipping_zones z
      JOIN shipping_zone_regions r ON r.zone_id = z.id
      WHERE r.region_name = ?
      AND z.status = 'active'
      LIMIT 1
    `;

    db.query(zoneSql, [state], (err, zones) => {
      if (err || !zones.length) {
        return res.json({ shipping: 0 });
      }

      const zoneId = zones[0].id;

      // 4️⃣ Get weight shipping method
      const methodSql = `
        SELECT id FROM shipping_methods
        WHERE zone_id = ?
        AND method_type = 'weight'
        AND enabled = 1
        LIMIT 1
      `;

      db.query(methodSql, [zoneId], (err, methods) => {
        if (err || !methods.length) {
          return res.json({ shipping: 0 });
        }

        const methodId = methods[0].id;

        // 5️⃣ Match weight rule
        const ruleSql = `
          SELECT *
          FROM weight_shipping_rules
          WHERE shipping_method_id = ?
          AND weight_from <= ?
          AND (weight_to IS NULL OR weight_to >= ?)
          ORDER BY weight_from DESC
          LIMIT 1
        `;

        db.query(ruleSql, [methodId, totalWeight, totalWeight], (err, rules) => {
          if (err || !rules.length) {
            return res.json({ shipping: 0 });
          }

          const r = rules[0];
          let cost = 0;

          switch (r.charge_type) {
            case "free":
              cost = 0;
              break;

            case "flat":
              cost = Number(r.flat_cost);
              break;

            case "progressive":
              cost = totalWeight * Number(r.per_kg_cost);
              break;

            case "flat_progressive":
              if (totalWeight <= r.base_weight) {
                cost = Number(r.base_cost);
              } else {
                cost =
                  Number(r.base_cost) +
                  (totalWeight - r.base_weight) *
                    Number(r.extra_cost_per_kg);
              }
              break;
          }

          res.json({
            shipping: Math.round(cost),
            totalWeight,
          });
        });
      });
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
