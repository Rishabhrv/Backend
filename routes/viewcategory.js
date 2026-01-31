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
    search = "",
    rating = 0,
    author = "",
    sort = "latest",
    page = 1,
    limit = 12,
  } = req.query;

  const offset = (page - 1) * limit;

  let orderBy = "p.created_at DESC";
  if (sort === "price_low") orderBy = "p.sell_price ASC";
  if (sort === "price_high") orderBy = "p.sell_price DESC";

  const productSql = `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.price,
      p.sell_price,
      p.main_image,
      COALESCE(ROUND(AVG(r.rating),1), 0) AS rating
    FROM products p
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    LEFT JOIN product_authors pa ON pa.product_id = p.id
    LEFT JOIN reviews r 
      ON r.product_id = p.id AND r.status = 'approved'
    WHERE c.slug = ?
      AND p.status = 'published'
      AND p.sell_price BETWEEN ? AND ?
      AND p.title LIKE ?
      AND (? = '' OR pa.author_id = ?)
    GROUP BY p.id
    HAVING rating >= ?
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT p.id
      FROM products p
      JOIN product_categories pc ON pc.product_id = p.id
      JOIN categories c ON c.id = pc.category_id
      LEFT JOIN product_authors pa ON pa.product_id = p.id
      LEFT JOIN reviews r 
        ON r.product_id = p.id AND r.status = 'approved'
      WHERE c.slug = ?
        AND p.status = 'published'
        AND p.sell_price BETWEEN ? AND ?
        AND p.title LIKE ?
        AND (? = '' OR pa.author_id = ?)
      GROUP BY p.id
      HAVING COALESCE(ROUND(AVG(r.rating),1),0) >= ?
    ) t
  `;

  db.query(
    productSql,
    [slug, min, max, `%${search}%`, author, author, rating, Number(limit), Number(offset)],
    (err, products) => {
      if (err) return res.status(500).json(err);

      db.query(
        countSql,
        [slug, min, max, `%${search}%`, author, author, rating],
        (err2, count) => {
          if (err2) return res.status(500).json(err2);

          res.json({
            products,
            total: count[0].total,
          });
        }
      );
    }
  );
});


/* ======================================================
   BEST SELLERS (OPTIONAL SIDEBAR)
====================================================== */
router.get("/:slug/best-sellers", (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.main_image,
      SUM(oi.quantity) AS total_sold
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE c.slug = ?
      AND p.status = 'published'
    GROUP BY p.id
    ORDER BY total_sold DESC
    LIMIT 5
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

/* ===========================
   CATEGORY LIST WITH PRODUCT COUNT
=========================== */
/* ===========================
   CATEGORY LIST WITH PRODUCT COUNT (WITH PARENT)
=========================== */
router.get("/counts", (req, res) => {
  const sql = `
    SELECT 
      c.id,
      c.parent_id,
      c.name,
      c.slug,
      COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN product_categories pc 
      ON pc.category_id = c.id
    LEFT JOIN products p 
      ON p.id = pc.product_id
      AND p.status = 'published'
    WHERE c.status = 'active'
    GROUP BY c.id, c.parent_id
    ORDER BY c.parent_id IS NULL DESC, c.name ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Category count error:", err);
      return res.status(500).json({ message: "Database error" });
    }
    res.json(rows);
  });
});





/* ===========================
   RATING COUNTS (CATEGORY)
=========================== */
router.get("/:slug/rating-counts", (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT 
      CASE
        WHEN AVG(r.rating) >= 5 THEN 5
        WHEN AVG(r.rating) >= 4 THEN 4
        WHEN AVG(r.rating) >= 3 THEN 3
        WHEN AVG(r.rating) >= 2 THEN 2
        WHEN AVG(r.rating) >= 1 THEN 1
        ELSE 0
      END AS rating,
      COUNT(*) AS product_count
    FROM products p
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    LEFT JOIN reviews r 
      ON r.product_id = p.id 
      AND r.status = 'approved'
    WHERE c.slug = ?
      AND p.status = 'published'
    GROUP BY p.id
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) {
      console.error("Rating count error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    rows.forEach(r => {
      if (r.rating >= 1) counts[r.rating] += r.product_count;
    });

    res.json(counts);
  });
});


router.get("/:slug/top-authors", (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT 
      a.id,
      a.name,
      a.profile_image,
      COUNT(DISTINCT p.id) AS product_count
    FROM authors a
    JOIN product_authors pa ON pa.author_id = a.id
    JOIN products p ON p.id = pa.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE c.slug = ?
      AND p.status = 'published'
    GROUP BY a.id
    ORDER BY product_count DESC
    LIMIT 5
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) {
      console.error("Top authors error:", err);
      return res.status(500).json({ message: "Database error" });
    }
    res.json(rows);
  });
});


/* ===========================
   AUTHOR SEARCH (CATEGORY)
=========================== */
router.get("/:slug/authors", (req, res) => {
  const { slug } = req.params;
  const { search = "" } = req.query;

  const sql = `
    SELECT 
      a.id,
      a.name,
      a.profile_image,
      COUNT(DISTINCT p.id) AS product_count
    FROM authors a
    JOIN product_authors pa ON pa.author_id = a.id
    JOIN products p ON p.id = pa.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE c.slug = ?
      AND p.status = 'published'
      AND a.name LIKE ?
    GROUP BY a.id
    ORDER BY product_count DESC
  `;

  db.query(sql, [slug, `%${search}%`], (err, rows) => {
    if (err) {
      console.error("Author search error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    res.json(rows);
  });
});




module.exports = router;
