const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* 🔐 ADMIN AUTH */
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

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


/* ================= GET ALL COUPONS ================= */
router.get("/coupons", adminAuth, (req, res) => {
  db.query(
    `SELECT * FROM coupons ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

/* ================= CREATE COUPON ================= */
router.post("/coupons", adminAuth, (req, res) => {
  const {
    code,
    discount_type,
    discount_value,
    min_cart_value,
    max_discount,
    product_type,
    applicable_on,              // ✅ NEW
    selected_products = [],     // ✅ NEW
    selected_categories = [],   // ✅ NEW
    start_date,
    expiry_date,
    usage_limit,
    usage_per_user,
    status,
  } = req.body;

  const sql = `
    INSERT INTO coupons
    (code, discount_type, discount_value, min_cart_value, max_discount,
     applicable_on, product_type, start_date, expiry_date,
     usage_limit, usage_per_user, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `;

  db.query(
    sql,
    [
      code,
      discount_type,
      discount_value,
      min_cart_value || 0,
      max_discount || null,
      applicable_on || "all",
      product_type || "all",
      start_date,
      expiry_date,
      usage_limit || null,
      usage_per_user || 1,
      status || "active",
    ],
    (err, result) => {
      if (err) return res.status(500).json(err);

      const couponId = result.insertId;

      /* ================= PRODUCT MAPPING ================= */
      if (applicable_on === "product" && selected_products.length) {
        selected_products.forEach((pid) => {
          db.query(
            "INSERT INTO coupon_products (coupon_id, product_id) VALUES (?,?)",
            [couponId, pid]
          );
        });
      }

      /* ================= CATEGORY MAPPING ================= */
      if (applicable_on === "category" && selected_categories.length) {
        selected_categories.forEach((cid) => {
          db.query(
            "INSERT INTO coupon_categories (coupon_id, category_id) VALUES (?,?)",
            [couponId, cid]
          );
        });
      }

      res.json({ msg: "Coupon created successfully" });
    }
  );
});

/* ================= GET SINGLE COUPON (WITH MAPPINGS) ================= */
router.get("/coupons/:id", adminAuth, (req, res) => {
  const { id } = req.params;

  const couponSql = `SELECT * FROM coupons WHERE id = ?`;

  db.query(couponSql, [id], (err, coupons) => {
    if (err || !coupons.length) {
      return res.status(404).json({ msg: "Coupon not found" });
    }

    const coupon = coupons[0];

    /* GET PRODUCT MAPPINGS */
    const productSql = `
      SELECT product_id
      FROM coupon_products
      WHERE coupon_id = ?
    `;

    /* GET CATEGORY MAPPINGS */
    const categorySql = `
      SELECT category_id
      FROM coupon_categories
      WHERE coupon_id = ?
    `;

    db.query(productSql, [id], (err, products) => {
      db.query(categorySql, [id], (err, categories) => {
        res.json({
          ...coupon,
          selected_products: products.map(p => p.product_id),
          selected_categories: categories.map(c => c.category_id),
        });
      });
    });
  });
});


/* ================= UPDATE COUPON ================= */
router.put("/coupons/:id", adminAuth, (req, res) => {
  const { id } = req.params;
  const {
    selected_products = [],
    selected_categories = [],
    ...couponData
  } = req.body;

  db.query(`UPDATE coupons SET ? WHERE id = ?`, [couponData, id], (err) => {
    if (err) return res.status(500).json(err);

    /* RESET OLD MAPPINGS */
    db.query(`DELETE FROM coupon_products WHERE coupon_id = ?`, [id]);
    db.query(`DELETE FROM coupon_categories WHERE coupon_id = ?`, [id]);

    /* INSERT NEW MAPPINGS */
    selected_products.forEach(pid => {
      db.query(
        `INSERT INTO coupon_products (coupon_id, product_id) VALUES (?,?)`,
        [id, pid]
      );
    });

    selected_categories.forEach(cid => {
      db.query(
        `INSERT INTO coupon_categories (coupon_id, category_id) VALUES (?,?)`,
        [id, cid]
      );
    });

    res.json({ msg: "Coupon updated successfully" });
  });
});


/* ================= DELETE COUPON ================= */
router.delete("/coupons/:id", adminAuth, (req, res) => {
  db.query(
    `DELETE FROM coupons WHERE id = ?`,
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ msg: "Coupon deleted" });
    }
  );
});

module.exports = router;
