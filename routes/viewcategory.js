const express = require("express");
const router = express.Router();
const db = require("../db");

/* ======================================================
   GET ALL CATEGORIES (SIDEBAR)
====================================================== */
router.get("/", (req, res) => {
  const sql = `
    SELECT 
      id,
      name,
      parent_id,
      slug,
      status
    FROM categories
    WHERE status = 'active'
    ORDER BY name ASC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Category fetch error:", err);
      return res.status(500).json({ message: "Database error" });
    }
    res.json(results);
  });
});

/* ======================================================
   GET PRODUCTS BY CATEGORY SLUG (CATEGORY PAGE)
   Supports: price filter + sorting + pagination
   URL: /api/categories/:slug/products
====================================================== */
router.get("/:slug/products", (req, res) => {
  const { slug } = req.params;

  const {
    min = 0,
    max = 999999,
    sort = "latest",
    page = 1,
    limit = 12,
  } = req.query;

  const offset = (page - 1) * limit;

  let orderBy = "p.created_at DESC";
  if (sort === "price_low") orderBy = "p.sell_price ASC";
  if (sort === "price_high") orderBy = "p.sell_price DESC";

  const sql = `
    SELECT 
      SQL_CALC_FOUND_ROWS
      p.id,
      p.title,
      p.slug,
      p.price,
      p.sell_price,
      p.stock,
      p.product_type,
      p.main_image,
      p.created_at
    FROM products p
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE c.slug = ?
      AND p.status = 'published'
      AND p.sell_price BETWEEN ? AND ?
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  db.query(
    sql,
    [slug, min, max, Number(limit), Number(offset)],
    (err, rows) => {
      if (err) {
        console.error("Category products error:", err);
        return res.status(500).json({ message: "Database error" });
      }

      db.query("SELECT FOUND_ROWS() AS total", (err2, count) => {
        if (err2) {
          return res.status(500).json({ message: "Count error" });
        }

        res.json({
          products: rows,
          total: count[0].total,
          page: Number(page),
          totalPages: Math.ceil(count[0].total / limit),
        });
      });
    }
  );
});

/* ======================================================
   BEST SELLERS (OPTIONAL SIDEBAR)
====================================================== */
router.get("/best-sellers/list", (req, res) => {
  const sql = `
    SELECT 
      p.id,
      p.title,
      p.main_image,
      SUM(oi.quantity) AS total_sold
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    GROUP BY oi.product_id
    ORDER BY total_sold DESC
    LIMIT 5
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Best sellers error:", err);
      return res.status(500).json({ message: "Database error" });
    }
    res.json(rows);
  });
});

/* ======================================================
   ADD CATEGORY (ADMIN)
====================================================== */
router.post("/", (req, res) => {
  const { name, slug, status, parent_id } = req.body;

  const sql = `
    INSERT INTO categories (name, slug, status, parent_id)
    VALUES (?, ?, ?, ?)
  `;

  db.query(
    sql,
    [name, slug, status, parent_id || null],
    (err, result) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") {
          return res.status(409).json({ message: "Slug already exists" });
        }
        return res.status(500).json(err);
      }

      res.json({
        message: "Category added successfully",
        id: result.insertId,
      });
    }
  );
});

/* ======================================================
   UPDATE CATEGORY (ADMIN)
====================================================== */
router.put("/:id", (req, res) => {
  const { id } = req.params;
  const { name, slug, status, parent_id } = req.body;

  const sql = `
    UPDATE categories
    SET name = ?, slug = ?, status = ?, parent_id = ?
    WHERE id = ?
  `;

  db.query(
    sql,
    [name, slug, status, parent_id || null, id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "Category updated successfully" });
    }
  );
});

/* ======================================================
   DELETE CATEGORY (ADMIN)
====================================================== */
router.delete("/:id", (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM categories WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ message: "Category deleted successfully" });
  });
});

module.exports = router;
