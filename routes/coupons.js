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

/* ===============================================================
   GET /api/coupons/available
   Returns all active coupons the user can still use, with:
   - how many times they've used it
   - whether it's still usable
   - applicable products / category names
================================================================ */
router.get("/available", auth, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1️⃣ Fetch all active, non-expired coupons (exclude subscription coupons)
    const [coupons] = await db.promise().query(
      `SELECT c.*
       FROM coupons c
       WHERE c.status = 'active'
         AND c.is_hidden = 0
         AND c.start_date <= CURDATE()
         AND c.expiry_date >= CURDATE()
         AND c.applicable_on != 'subscription'
         AND (
           NOT EXISTS (SELECT 1 FROM coupon_users cu WHERE cu.coupon_id = c.id)
           OR EXISTS (SELECT 1 FROM coupon_users cu WHERE cu.coupon_id = c.id AND cu.user_id = ?)
         )
       ORDER BY c.created_at DESC`,
       [userId]
    );

    if (!coupons.length) return res.json([]);

    const couponIds = coupons.map(c => c.id);

    // 2️⃣ Per-user usage counts
    const [usageRows] = await db.promise().query(
      `SELECT coupon_id, COUNT(*) AS used
       FROM coupon_usage
       WHERE user_id = ? AND coupon_id IN (?)
       GROUP BY coupon_id`,
      [userId, couponIds]
    );
    const usageMap = {};
    usageRows.forEach(r => { usageMap[r.coupon_id] = r.used; });

    // 3️⃣ Global usage counts
    const [globalRows] = await db.promise().query(
      `SELECT coupon_id, COUNT(*) AS total_used
       FROM coupon_usage
       WHERE coupon_id IN (?)
       GROUP BY coupon_id`,
      [couponIds]
    );
    const globalMap = {};
    globalRows.forEach(r => { globalMap[r.coupon_id] = r.total_used; });

    // 4️⃣ Fetch product names for product-specific coupons
    const [cpRows] = await db.promise().query(
      `SELECT cp.coupon_id, p.title
       FROM coupon_products cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.coupon_id IN (?)`,
      [couponIds]
    );
    const productMap = {};
    cpRows.forEach(r => {
      if (!productMap[r.coupon_id]) productMap[r.coupon_id] = [];
      productMap[r.coupon_id].push(r.title);
    });

    // 5️⃣ Fetch category names for category-specific coupons
    const [ccRows] = await db.promise().query(
      `SELECT cc.coupon_id, c.name
       FROM coupon_categories cc
       JOIN categories c ON c.id = cc.category_id
       WHERE cc.coupon_id IN (?)`,
      [couponIds]
    );
    const categoryMap = {};
    ccRows.forEach(r => {
      if (!categoryMap[r.coupon_id]) categoryMap[r.coupon_id] = [];
      categoryMap[r.coupon_id].push(r.name);
    });

    // 6️⃣ Build response
    const result = coupons.map(c => {
      const userUsed   = usageMap[c.id]  || 0;
      const totalUsed  = globalMap[c.id] || 0;

      const userLimitHit   = c.usage_per_user !== null && userUsed >= c.usage_per_user;
      const globalLimitHit = c.usage_limit    !== null && totalUsed >= c.usage_limit;
      const usable = !userLimitHit && !globalLimitHit;

      return {
        id:              c.id,
        code:            c.code,
        discount_type:   c.discount_type,
        discount_value:  c.discount_value,
        max_discount:    c.max_discount,
        min_cart_value:  c.min_cart_value,
        applicable_on:   c.applicable_on,
        product_type:    c.product_type,
        expiry_date:     c.expiry_date,
        usable,
        user_used:       userUsed,
        usage_per_user:  c.usage_per_user,
        // Human-readable scope labels
        scope_items: c.applicable_on === "product"
          ? (productMap[c.id]  || [])
          : c.applicable_on === "category"
          ? (categoryMap[c.id] || [])
          : [],
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Coupons available error:", err);
    res.status(500).json({ msg: "Failed to load coupons" });
  }
});

module.exports = router;