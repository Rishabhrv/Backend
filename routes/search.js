const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/", (req, res) => {
  try {
    const q = req.query.q;

    // ✅ Empty query handling
    if (!q || q.trim() === "") {
      return res.json({ products: [], authors: [] });
    }

    const search = `%${q.trim()}%`;

    // ✅ FIXED: safer query (LEFT JOIN + GROUP BY instead of DISTINCT)
    const productSql = `
      SELECT 
        p.id,
        p.title,
        p.slug,
        p.main_image
      FROM products p
      LEFT JOIN product_categories pc ON pc.product_id = p.id
      LEFT JOIN categories cat ON cat.id = pc.category_id
      WHERE p.status = 'published'
        AND p.title LIKE ?
        AND (cat.imprint = 'agph' OR cat.imprint IS NULL)
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 5
    `;

    const authorSql = `
      SELECT 
        a.id,
        a.name,
        a.slug,
        a.profile_image
      FROM authors a
      LEFT JOIN product_authors pa ON pa.author_id = a.id
      LEFT JOIN product_categories pc ON pc.product_id = pa.product_id
      LEFT JOIN categories cat ON cat.id = pc.category_id
      WHERE a.status = 'active'
        AND a.name LIKE ?
        AND (cat.imprint = 'agph' OR cat.imprint IS NULL)
      GROUP BY a.id
      ORDER BY a.name ASC
      LIMIT 5
    `;

    // ✅ Execute product query
    db.query(productSql, [search], (err, products) => {
      if (err) {
        console.error("PRODUCT ERROR:", err);
        return res.status(500).json({
          msg: "Product search failed",
          error: err.message
        });
      }

      // ✅ Execute author query
      db.query(authorSql, [search], (err, authors) => {
        if (err) {
          console.error("AUTHOR ERROR:", err);
          return res.status(500).json({
            msg: "Author search failed",
            error: err.message
          });
        }

        // ✅ Final response
        res.json({
          products: products || [],
          authors: authors || []
        });
      });
    });

  } catch (error) {
    console.error("UNEXPECTED ERROR:", error);
    res.status(500).json({
      msg: "Unexpected server error",
      error: error.message
    });
  }
});

module.exports = router;