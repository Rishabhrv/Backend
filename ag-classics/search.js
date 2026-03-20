const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/", (req, res) => {
  const q = req.query.q;

  if (!q || q.trim() === "") {
    return res.json({ products: [], authors: [] });
  }

  const search = `%${q}%`;

const productSql = `
  SELECT DISTINCT
    p.id,
    p.title,
    p.slug,
    p.main_image
  FROM products p
  LEFT JOIN product_categories pc ON pc.product_id = p.id
  LEFT JOIN categories cat ON cat.id = pc.category_id
  WHERE p.status = 'published'
    AND p.title LIKE ?
    AND LOWER(cat.imprint) = 'agclassics'
  ORDER BY p.created_at DESC
  LIMIT 5
`;

  const authorSql = `
    SELECT DISTINCT
      a.id,
      a.name,
      a.slug,
      a.profile_image
    FROM authors a
    JOIN product_authors pa ON pa.author_id = a.id
    JOIN product_categories pc ON pc.product_id = pa.product_id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE a.status = 'active'
      AND a.name LIKE ?
      AND cat.imprint = 'agclassics'
    ORDER BY a.name ASC
    LIMIT 5
  `;

  db.query(productSql, [search], (err, products) => {
    if (err) return res.status(500).json({ msg: "Product search failed" });

    db.query(authorSql, [search], (err, authors) => {
      if (err) return res.status(500).json({ msg: "Author search failed" });

      res.json({ products, authors });
    });
  });
});

module.exports = router;