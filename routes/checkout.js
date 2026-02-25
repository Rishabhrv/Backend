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
    const { shipping = 0, couponCode, address } = req.body;


    const cartSql = `
      SELECT 
        c.product_id,
        c.format,
        c.quantity,
        p.sell_price AS paperback_price,
        e.sell_price AS ebook_price,
        p.product_type
      FROM cart c
      JOIN products p ON p.id = c.product_id
      LEFT JOIN ebooks e ON e.product_id = p.id
      INNER JOIN product_categories pc ON pc.product_id = p.id
      INNER JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agph'
      WHERE c.user_id = ?
      GROUP BY c.id
    `;

  db.query(cartSql, [user_id], (err, items) => {
    if (err) return res.status(500).json(err);
    if (!items || items.length === 0)
      return res.status(400).json({ msg: "Cart empty" });

    let subtotal = 0;

    items.forEach((i) => {
      if (i.format === "ebook") {
        subtotal += Number(i.ebook_price) * Number(i.quantity || 1);
      } else {
        subtotal += Number(i.paperback_price) * Number(i.quantity);
      }
    });

    const processOrder = (discount = 0, coupon_id = null) => {
      const total = subtotal + Number(shipping) - discount;

      const orderSql = `
        INSERT INTO orders 
        (user_id, total_amount, coupon_code, coupon_discount, status, payment_status)
        VALUES (?, ?, ?, ?, 'pending', 'pending')
      `;

      db.query(
        orderSql,
        [user_id, total, couponCode || null, discount],
        (err, result) => {
          if (err) return res.status(500).json(err);

          const order_id = result.insertId;

          const orderItems = items.map((i) => [
            order_id,
            i.product_id,
            i.format,
            i.format === "ebook" ? i.ebook_price : i.paperback_price,
            i.format === "ebook" ? 1 : i.quantity
          ]);

db.query(
            `INSERT INTO order_items 
             (order_id, product_id, format, price, quantity) 
             VALUES ?`,
            [orderItems],
            () => {

              // Save coupon usage
              if (coupon_id) {
                db.query(
                  `INSERT INTO coupon_usage (coupon_id, user_id, order_id)
                   VALUES (?, ?, ?)`,
                  [coupon_id, user_id, order_id]
                );
              }

              if (Number(shipping) > 0) {
                db.query(
                  `INSERT INTO shipping (order_id, shipping_cost)
                   VALUES (?, ?)
                   ON DUPLICATE KEY UPDATE shipping_cost = VALUES(shipping_cost)`,
                  [order_id, Number(shipping)],
                  (err) => {
                    if (err) console.error("Shipping cost save error:", err);
                  }
                );
              }

              // ── Save order address ────────────────────────────────
              if (address && address.address) {
                db.query(
                  `INSERT INTO order_address
                   (order_id, first_name, last_name, address, city, state, pincode, phone, email)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    order_id,
                    address.first_name || "",
                    address.last_name  || "",
                    address.address    || "",
                    address.city       || "",
                    address.state      || "",
                    address.pincode    || "",
                    address.phone      || "",
                    address.email      || "",
                  ],
                  (err) => {
                    if (err) console.error("Order address save error:", err);
                  }
                );
              }

              res.json({
                msg: "Order created",
                order_id,
                subtotal,
                shipping,
                discount,
                total,
              });
            }
          );
        }
      );
    };

    /* =======================
       APPLY COUPON AGAIN
    ======================= */

    if (!couponCode) {
      return processOrder(0, null);
    }

    db.query(
      `SELECT * FROM coupons
       WHERE code = ?
       AND status = 'active'
       AND start_date <= CURDATE()
       AND expiry_date >= CURDATE()`,
      [couponCode],
      (err, rows) => {
        if (err || !rows.length) {
          return processOrder(0, null);
        }

        const coupon = rows[0];

        let discount =
          coupon.discount_type === "percent"
            ? (subtotal * coupon.discount_value) / 100
            : coupon.discount_value;

        if (coupon.max_discount) {
          discount = Math.min(discount, coupon.max_discount);
        }

        processOrder(Number(discount.toFixed(2)), coupon.id);
      }
    );
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
      INNER JOIN product_categories pc ON pc.product_id = c.product_id
      INNER JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agph'
      WHERE c.user_id = ?
      AND c.format = 'paperback'
      GROUP BY c.id
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


/* ================= APPLY COUPON ================= */
router.post("/apply-coupon", auth, (req, res) => {
  const userId = req.user.id;
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ msg: "Coupon code required" });
  }

  /* 1️⃣ FETCH COUPON */
  db.query(
    `SELECT * FROM coupons
     WHERE code = ?
       AND status = 'active'
       AND start_date <= CURDATE()
       AND expiry_date >= CURDATE()`,
    [code],
    (err, coupons) => {
      if (err) {
        console.error("Coupon fetch error:", err);
        return res.status(500).json({ msg: "Database error" });
      }

      if (!coupons.length) {
        return res.status(400).json({
          reason: "invalid",
          msg: "Invalid or expired coupon",
        });
      }

      const coupon = coupons[0];

      /* 2️⃣ GLOBAL USAGE CHECK */
      db.query(
        `SELECT COUNT(*) AS total_used
         FROM coupon_usage
         WHERE coupon_id = ?`,
        [coupon.id],
        (err, totalRows) => {
          if (err) {
            console.error("Global usage error:", err);
            return res.status(500).json({ msg: "Database error" });
          }

          if (
            coupon.usage_limit !== null &&
            totalRows[0].total_used >= coupon.usage_limit
          ) {
            return res.status(400).json({
              reason: "limit",
              msg: "Coupon usage limit reached",
            });
          }

          /* 3️⃣ USER USAGE CHECK */
          db.query(
            `SELECT COUNT(*) AS used
             FROM coupon_usage
             WHERE coupon_id = ? AND user_id = ?`,
            [coupon.id, userId],
            (err, rows) => {
              if (err) {
                console.error("Coupon usage error:", err);
                return res.status(500).json({ msg: "Database error" });
              }

              if (
                coupon.usage_per_user !== null &&
                rows[0].used >= coupon.usage_per_user
              ) {
                return res.status(400).json({
                  reason: "usage",
                  msg: "You have already used this coupon",
                });
              }

              /* 4️⃣ LOAD CART */
              db.query(
                `
                SELECT 
                  c.product_id,
                  c.format,
                  c.quantity,
                  p.title,
                  p.product_type,
                  CASE 
                    WHEN c.format = 'ebook' THEN e.sell_price
                    ELSE p.sell_price
                  END AS price,
                  GROUP_CONCAT(DISTINCT pc.category_id) AS categories
                FROM cart c
                JOIN products p ON p.id = c.product_id
                LEFT JOIN ebooks e ON e.product_id = p.id
                INNER JOIN product_categories pc ON pc.product_id = p.id
                INNER JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agph'
                WHERE c.user_id = ?
                GROUP BY c.product_id, c.format, price
                `,
                [userId],
                (err, items) => {
                  if (err) {
                    console.error("Cart load error:", err);
                    return res.status(500).json({ msg: "Database error" });
                  }

                  if (!items.length) {
                    return res.status(400).json({
                      reason: "empty",
                      msg: "Your cart is empty",
                    });
                  }

                  /* 5️⃣ LOAD COUPON MAPPINGS */
                  const loadMappings = () =>
                    new Promise((resolve) => {
                      if (coupon.applicable_on === "product") {
                        return db.query(
                          `SELECT product_id FROM coupon_products WHERE coupon_id = ?`,
                          [coupon.id],
                          (err, rows) =>
                            resolve({ products: rows || [], categories: [] })
                        );
                      }

                      if (coupon.applicable_on === "category") {
                        return db.query(
                          `SELECT category_id FROM coupon_categories WHERE coupon_id = ?`,
                          [coupon.id],
                          (err, rows) =>
                            resolve({ categories: rows || [], products: [] })
                        );
                      }

                      resolve({ products: [], categories: [] });
                    });

                  loadMappings().then(({ products, categories }) => {
                    let eligibleSubtotal = 0;
                    const eligibleItems = [];

                    items.forEach((item) => {
                      const qty = item.quantity || 1;
                      const itemTotal = Number(item.price || 0) * qty;

                      /* PRODUCT TYPE FILTER */
                      if (
                        coupon.product_type !== "all" &&
                        coupon.product_type !== item.product_type &&
                        !(coupon.product_type === "physical" &&
                          item.format === "paperback")
                      ) {
                        return;
                      }

                      /* APPLY ALL */
                      if (coupon.applicable_on === "all") {
                        eligibleSubtotal += itemTotal;
                        eligibleItems.push(item.title);
                        return;
                      }

                      /* APPLY PRODUCT */
                      if (coupon.applicable_on === "product") {
                        const allowedIds = products.map(p => p.product_id);
                        if (allowedIds.includes(item.product_id)) {
                          eligibleSubtotal += itemTotal;
                          eligibleItems.push(item.title);
                        }
                        return;
                      }

                      /* APPLY CATEGORY */
                      if (coupon.applicable_on === "category") {
                        const itemCats = (item.categories || "")
                          .split(",")
                          .map(Number);
                        const allowedCats = categories.map(c => c.category_id);

                        if (itemCats.some(c => allowedCats.includes(c))) {
                          eligibleSubtotal += itemTotal;
                          eligibleItems.push(item.title);
                        }
                      }
                    });

                    if (!eligibleSubtotal) {
                      return res.status(400).json({
                        reason: coupon.applicable_on,
                        msg: "Coupon not applicable to selected items",
                      });
                    }

                    if (eligibleSubtotal < coupon.min_cart_value) {
                      return res.status(400).json({
                        reason: "min_cart",
                        msg: `Add ₹${(
                          coupon.min_cart_value - eligibleSubtotal
                        ).toFixed(2)} more to apply this coupon`,
                      });
                    }

                    /* 6️⃣ CALCULATE DISCOUNT */
                    let discount =
                      coupon.discount_type === "percent"
                        ? (eligibleSubtotal * coupon.discount_value) / 100
                        : coupon.discount_value;

                    if (coupon.max_discount) {
                      discount = Math.min(discount, coupon.max_discount);
                    }

                    return res.json({
                      discount: Number(discount.toFixed(2)),
                      eligible_items: eligibleItems,
                      applicable_on: coupon.applicable_on,
                    });
                  });
                }
              );
            }
          );
        }
      );
    }
  );
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
