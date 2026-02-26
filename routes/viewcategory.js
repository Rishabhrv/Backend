const express = require("express");
const router = express.Router();
const db = require("../db");

/* ======================================================
   GET ALL CATEGORIES (SIDEBAR) — agph only
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
      AND imprint = 'agph'
    ORDER BY name ASC
  `;

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "Database error" });
    res.json(results);
  });
});

/* ======================================================
   GET PRODUCTS BY CATEGORY SLUG
   ✅ If slug is a PARENT category → includes all child category products too
   ✅ Only agph categories
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

  const offset = (Number(page) - 1) * Number(limit);

  let orderBy = "p.created_at DESC";
  if (sort === "price_low")  orderBy = "p.sell_price ASC";
  if (sort === "price_high") orderBy = "p.sell_price DESC";

  // First resolve the category id and check if it has children
  db.query(
    `SELECT id, parent_id FROM categories WHERE slug = ? AND imprint = 'agph' LIMIT 1`,
    [slug],
    (err, cats) => {
      if (err) return res.status(500).json(err);
      if (!cats.length) return res.json({ products: [], total: 0 });

      const cat = cats[0];

      // Build the category condition:
      // If this category has children → use all child IDs
      // If it has no children → use its own ID
      const catResolveSql = `
        SELECT id FROM categories
        WHERE imprint = 'agph'
          AND (
            id = ?
            OR parent_id = ?
          )
      `;

      db.query(catResolveSql, [cat.id, cat.id], (err2, catRows) => {
        if (err2) return res.status(500).json(err2);

        const catIds = catRows.map(c => c.id);
        if (!catIds.length) return res.json({ products: [], total: 0 });

        const productSql = `
        SELECT
          p.id,
          p.title,
          p.slug,
          p.price,
          p.sell_price,
          p.stock,
          p.product_type,
          p.main_image,
          MAX(e.price)        AS ebook_price,
          MAX(e.sell_price)   AS ebook_sell_price,
          COALESCE(ROUND(AVG(r.rating), 1), 0) AS rating
        FROM products p
        JOIN product_categories pc ON pc.product_id = p.id
        LEFT JOIN ebooks e ON e.product_id = p.id
        LEFT JOIN product_authors pa ON pa.product_id = p.id
        LEFT JOIN reviews r
          ON r.product_id = p.id AND r.status = 'approved'
        WHERE pc.category_id IN (?)
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
            LEFT JOIN product_authors pa ON pa.product_id = p.id
            LEFT JOIN reviews r
              ON r.product_id = p.id AND r.status = 'approved'
            WHERE pc.category_id IN (?)
              AND p.status = 'published'
              AND p.sell_price BETWEEN ? AND ?
              AND p.title LIKE ?
              AND (? = '' OR pa.author_id = ?)
            GROUP BY p.id
            HAVING COALESCE(ROUND(AVG(r.rating), 1), 0) >= ?
          ) t
        `;

        const commonParams = [
          catIds, min, max, `%${search}%`, author, author, rating
        ];

        db.query(
          productSql,
          [...commonParams, Number(limit), Number(offset)],
          (err3, products) => {
            if (err3) return res.status(500).json(err3);

            db.query(countSql, commonParams, (err4, count) => {
              if (err4) return res.status(500).json(err4);

              res.json({
                products,
                total: count[0].total,
              });
            });
          }
        );
      });
    }
  );
});

/* ======================================================
   BEST SELLERS — agph only, includes child categories
====================================================== */
router.get("/:slug/best-sellers", (req, res) => {
  const { slug } = req.params;

  db.query(
    `SELECT id FROM categories WHERE slug = ? AND imprint = 'agph' LIMIT 1`,
    [slug],
    (err, cats) => {
      if (err) return res.status(500).json(err);
      if (!cats.length) return res.json([]);

      const catId = cats[0].id;

      db.query(
        `SELECT id FROM categories WHERE imprint = 'agph' AND (id = ? OR parent_id = ?)`,
        [catId, catId],
        (err2, catRows) => {
          if (err2) return res.status(500).json(err2);
          const catIds = catRows.map(c => c.id);

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
            WHERE pc.category_id IN (?)
              AND p.status = 'published'
            GROUP BY p.id
            ORDER BY total_sold DESC
            LIMIT 5
          `;

          db.query(sql, [catIds], (err3, rows) => {
            if (err3) return res.status(500).json(err3);
            res.json(rows);
          });
        }
      );
    }
  );
});

/* ======================================================
   CATEGORY LIST WITH PRODUCT COUNT — agph only
   ✅ Parent shows combined count of all its children
====================================================== */
router.get("/counts", (req, res) => {
  const sql = `
    SELECT 
      c.id,
      c.parent_id,
      c.name,
      c.slug,
      COUNT(DISTINCT p.id) AS product_count
    FROM categories c
    LEFT JOIN product_categories pc ON pc.category_id = c.id
    LEFT JOIN products p
      ON p.id = pc.product_id AND p.status = 'published'
    WHERE c.status = 'active'
      AND c.imprint = 'agph'
    GROUP BY c.id
    ORDER BY c.parent_id IS NULL DESC, c.name ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });

    // For parent categories, sum up all children's product counts
    const childMap = {};
    rows.forEach(r => {
      if (r.parent_id) {
        childMap[r.parent_id] = (childMap[r.parent_id] || 0) + r.product_count;
      }
    });

    const result = rows.map(r => ({
      ...r,
      product_count: r.parent_id === null
        ? (childMap[r.id] || 0) + r.product_count  // parent = own + children
        : r.product_count,
    }));

    res.json(result);
  });
});

/* ======================================================
   RATING COUNTS — agph only, includes child categories
====================================================== */
router.get("/:slug/rating-counts", (req, res) => {
  const { slug } = req.params;

  db.query(
    `SELECT id FROM categories WHERE slug = ? AND imprint = 'agph' LIMIT 1`,
    [slug],
    (err, cats) => {
      if (err) return res.status(500).json(err);
      if (!cats.length) return res.json({ 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 });

      const catId = cats[0].id;

      db.query(
        `SELECT id FROM categories WHERE imprint = 'agph' AND (id = ? OR parent_id = ?)`,
        [catId, catId],
        (err2, catRows) => {
          if (err2) return res.status(500).json(err2);
          const catIds = catRows.map(c => c.id);

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
            LEFT JOIN reviews r
              ON r.product_id = p.id AND r.status = 'approved'
            WHERE pc.category_id IN (?)
              AND p.status = 'published'
            GROUP BY p.id
          `;

          db.query(sql, [catIds], (err3, rows) => {
            if (err3) return res.status(500).json(err3);

            const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
            rows.forEach(r => {
              if (r.rating >= 1) counts[r.rating] += r.product_count;
            });

            res.json(counts);
          });
        }
      );
    }
  );
});

/* ======================================================
   TOP AUTHORS — agph only, includes child categories
====================================================== */
router.get("/:slug/top-authors", (req, res) => {
  const { slug } = req.params;

  db.query(
    `SELECT id FROM categories WHERE slug = ? AND imprint = 'agph' LIMIT 1`,
    [slug],
    (err, cats) => {
      if (err) return res.status(500).json(err);
      if (!cats.length) return res.json([]);

      const catId = cats[0].id;

      db.query(
        `SELECT id FROM categories WHERE imprint = 'agph' AND (id = ? OR parent_id = ?)`,
        [catId, catId],
        (err2, catRows) => {
          if (err2) return res.status(500).json(err2);
          const catIds = catRows.map(c => c.id);

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
            WHERE pc.category_id IN (?)
              AND p.status = 'published'
            GROUP BY a.id
            ORDER BY product_count DESC
            LIMIT 5
          `;

          db.query(sql, [catIds], (err3, rows) => {
            if (err3) return res.status(500).json(err3);
            res.json(rows);
          });
        }
      );
    }
  );
});

/* ======================================================
   AUTHOR SEARCH — agph only, includes child categories
====================================================== */
router.get("/:slug/authors", (req, res) => {
  const { slug } = req.params;
  const { search = "" } = req.query;

  db.query(
    `SELECT id FROM categories WHERE slug = ? AND imprint = 'agph' LIMIT 1`,
    [slug],
    (err, cats) => {
      if (err) return res.status(500).json(err);
      if (!cats.length) return res.json([]);

      const catId = cats[0].id;

      db.query(
        `SELECT id FROM categories WHERE imprint = 'agph' AND (id = ? OR parent_id = ?)`,
        [catId, catId],
        (err2, catRows) => {
          if (err2) return res.status(500).json(err2);
          const catIds = catRows.map(c => c.id);

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
            WHERE pc.category_id IN (?)
              AND p.status = 'published'
              AND a.name LIKE ?
            GROUP BY a.id
            ORDER BY product_count DESC
          `;

          db.query(sql, [catIds, `%${search}%`], (err3, rows) => {
            if (err3) return res.status(500).json(err3);
            res.json(rows);
          });
        }
      );
    }
  );
});

module.exports = router;