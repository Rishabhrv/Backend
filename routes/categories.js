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
  const { product_type, limit } = req.query;

  const params = [slug];
  let typeFilter = "";

  // ── Filter by product_type if provided ──────────────────────────────────
  if (product_type === "ebook") {
    typeFilter = `AND (p.product_type = 'ebook' OR p.product_type = 'both')`;
  } else if (product_type === "physical") {
    typeFilter = `AND (p.product_type = 'physical' OR p.product_type = 'both')`;
  }

  const limitClause = limit ? `LIMIT ${parseInt(limit)}` : "";

  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.price         AS price,
      p.sell_price    AS sell_price,
      e.price         AS ebook_price,
      e.sell_price    AS ebook_sell_price,
      p.stock,
      p.product_type,
      p.status,
      p.main_image
    FROM products p
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    LEFT JOIN ebooks e ON e.product_id = p.id
    WHERE c.slug = ?
      AND p.status = 'published'
      ${typeFilter}
    ORDER BY p.created_at DESC
    ${limitClause}
  `;

  db.query(sql, params, (err, rows) => {
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

  db.query(
    "DELETE FROM categories WHERE id = ?",
    [id],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(409).json({
          message: "Cannot delete category. It may be in use."
        });
      }

      res.json({ success: true });
    }
  );
});



router.post("/bulk-delete", (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  db.query(
    "DELETE FROM categories WHERE id IN (?)",
    [ids],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(409).json({
          message: "Some categories cannot be deleted"
        });
      }

      res.json({ success: true });
    }
  );
});

/* BULK STATUS UPDATE */
router.post("/bulk-status", (req, res) => {
  const { ids, status } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  db.query(
    `UPDATE categories SET status = ? WHERE id IN (?)`,
    [status, ids],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Bulk update failed" });
      }

      res.json({ success: true });
    }
  );
});








module.exports = router;
