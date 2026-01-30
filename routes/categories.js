const express = require("express");
const router = express.Router();
const db = require("../db");


/* GET ALL CATEGORIES */
router.get("/", (req, res) => {
  const sql = `
    SELECT 
      c.id,
      c.name,
      c.parent_id,
      c.slug,
      c.status
    FROM categories c
    ORDER BY c.name ASC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Category fetch error:", err);
      return res.status(500).json({ message: "DB error" });
    }

    res.json(results);
  });
});

/* ================= GET PRODUCTS BY CATEGORY SLUG ================= */
router.get("/:slug/products", (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.price,
      p.sell_price,
      p.stock,
      p.product_type,
      p.status,
      p.main_image
    FROM products p
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE c.slug = ?
      AND p.status = 'published'
    ORDER BY p.created_at DESC
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) {
      console.error("Category products error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    res.json(rows);
  });
});


/* ADD CATEGORY */
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

/* UPDATE CATEGORY */
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

/* DELETE CATEGORY */
router.delete("/:id", (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM categories WHERE id = ?";

  db.query(sql, [id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ message: "Category deleted successfully" });
  });
});







module.exports = router;
