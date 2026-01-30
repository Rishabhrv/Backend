const express = require("express");
const db = require("../db");
const router = express.Router();

/* ================= GLOBAL SEARCH ================= */

router.get("/", (req, res) => {
  const q = req.query.q;

  if (!q || q.trim() === "") {
    return res.json({ products: [], authors: [] });
  }

  const search = `%${q}%`;

  const productSql = `
    SELECT 
      id,
      title,
      slug,
      main_image
    FROM products
    WHERE status = 'published'
      AND title LIKE ?
    ORDER BY created_at DESC
    LIMIT 5
  `;

  const authorSql = `
    SELECT 
      id,
      name,
      slug,
      profile_image
    FROM authors
    WHERE status = 'active'
      AND name LIKE ?
    ORDER BY name ASC
    LIMIT 5
  `;

  db.query(productSql, [search], (err, products) => {
    if (err) {
      console.error("Product search error:", err);
      return res.status(500).json({ msg: "Product search failed" });
    }

    db.query(authorSql, [search], (err, authors) => {
      if (err) {
        console.error("Author search error:", err);
        return res.status(500).json({ msg: "Author search failed" });
      }

      res.json({ products, authors });
    });
  });
});

module.exports = router;
