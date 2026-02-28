const express = require("express");
const db = require("../db");
const router = express.Router();

/* ═══════════════════════════════════════════════════════════════════
   GET /api/ebooks
   Query params:
     - page        (default 1)
     - limit       (default 12)
     - search      (title / author name)
     - category    (category slug)
     - file_type   ("pdf" | "epub")
     - sort        ("newest" | "price_asc" | "price_desc" | "rating" | "popular")
   ═══════════════════════════════════════════════════════════════════ */
router.get("/", (req, res) => {
  const page      = Math.max(1, parseInt(req.query.page)  || 1);
  const limit     = Math.min(50, parseInt(req.query.limit) || 12);
  const offset    = (page - 1) * limit;
  const search    = req.query.search    || "";
  const category  = req.query.category  || "";
  const file_type = req.query.file_type || "";
  const sort      = req.query.sort      || "newest";

  // ── Build WHERE conditions ────────────────────────────────────────
  const conditions = [
    "p.status = 'published'",
    "(p.product_type = 'ebook' OR p.product_type = 'both')",
    "c.imprint = 'agph'", // ← only agph categories
  ];

  const params = [];

  if (search) {
    conditions.push("(p.title LIKE ? OR a.name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  if (category) {
    conditions.push("c.slug = ?");
    params.push(category);
  }

  if (file_type === "pdf" || file_type === "epub") {
    conditions.push("e.file_type = ?");
    params.push(file_type);
  }

  const whereClause = "WHERE " + conditions.join(" AND ");

  // ── Build ORDER BY ────────────────────────────────────────────────
  const orderMap = {
    newest:     "p.created_at DESC",
    price_asc:  "COALESCE(e.sell_price, p.sell_price) ASC",
    price_desc: "COALESCE(e.sell_price, p.sell_price) DESC",
    rating:     "avg_rating DESC",
    popular:    "review_count DESC",
  };
  const orderBy = orderMap[sort] || orderMap.newest;

  // ── Count total (for pagination) ──────────────────────────────────
  const countSql = `
    SELECT COUNT(DISTINCT p.id) AS total
    FROM products p
    LEFT JOIN ebooks e ON e.product_id = p.id
    LEFT JOIN product_categories pc ON pc.product_id = p.id
    LEFT JOIN categories c ON c.id = pc.category_id
    LEFT JOIN product_authors pa ON pa.product_id = p.id
    LEFT JOIN authors a ON a.id = pa.author_id
    ${whereClause}
  `;

  db.query(countSql, params, (err, countResult) => {
    if (err) {
      console.error("Ebook count error:", err);
      return res.status(500).json({ message: "DB error" });
    }

    const total      = countResult[0].total;
    const totalPages = Math.ceil(total / limit);

    // ── Fetch page of ebooks ────────────────────────────────────────
    const dataSql = `
      SELECT
        p.id,
        p.title,
        p.slug,
        p.main_image,
        p.product_type,
        p.stock,
        p.price,
        p.sell_price,
        p.created_at,

        -- ebook-specific prices
        e.price        AS ebook_price,
        e.sell_price   AS ebook_sell_price,
        e.file_type,

        -- author (first one if multiple)
        MIN(a.name)    AS author_name,

        -- categories (comma-separated)
        GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',') AS categories,
        GROUP_CONCAT(DISTINCT c.slug ORDER BY c.name SEPARATOR ',') AS category_slugs,

        -- rating
        ROUND(AVG(r.rating), 1)  AS avg_rating,
        COUNT(DISTINCT r.id)     AS review_count

      FROM products p
      LEFT JOIN ebooks e            ON e.product_id = p.id
      LEFT JOIN product_categories pc ON pc.product_id = p.id
      LEFT JOIN categories c        ON c.id = pc.category_id
      LEFT JOIN product_authors pa  ON pa.product_id = p.id
      LEFT JOIN authors a           ON a.id = pa.author_id
      LEFT JOIN reviews r           ON r.product_id = p.id AND r.status = 'approved'
      ${whereClause}
      GROUP BY
        p.id, p.title, p.slug, p.main_image, p.product_type,
        p.stock, p.price, p.sell_price, p.created_at,
        e.price, e.sell_price, e.file_type
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    db.query(dataSql, [...params, limit, offset], (err2, rows) => {
      if (err2) {
        console.error("Ebook fetch error:", err2);
        return res.status(500).json({ message: "DB error" });
      }

      res.json({
        ebooks: rows,
        total,
        page,
        totalPages,
        limit,
      });
    });
  });
});

router.get("/hero-stats", (req, res) => {
  const sql = `
    SELECT
      COUNT(DISTINCT p.id) AS total_ebooks,
      COUNT(DISTINCT a.id) AS total_authors
    FROM products p

    INNER JOIN product_categories pc 
      ON pc.product_id = p.id

    INNER JOIN categories c 
      ON c.id = pc.category_id

    LEFT JOIN ebooks e 
      ON e.product_id = p.id

    LEFT JOIN product_authors pa 
      ON pa.product_id = p.id

    LEFT JOIN authors a 
      ON a.id = pa.author_id

    WHERE p.status = 'published'
      AND (p.product_type = 'ebook' OR p.product_type = 'both')
      AND c.imprint = 'agph'
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ message: "DB error" });
    res.json(rows[0]);
  });
});


/* ═══════════════════════════════════════════════════════════════════
   GET /api/ebooks/:slug  — single ebook detail
   ═══════════════════════════════════════════════════════════════════ */
router.get("/:slug", (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.main_image,
      p.description,
      p.product_type,
      p.stock,
      p.price,
      p.sell_price,
      p.created_at,

      e.id           AS ebook_id,
      e.price        AS ebook_price,
      e.sell_price   AS ebook_sell_price,
      e.file_type,

      GROUP_CONCAT(DISTINCT a.name  ORDER BY a.name  SEPARATOR ', ') AS authors,
      GROUP_CONCAT(DISTINCT c.name  ORDER BY c.name  SEPARATOR ', ') AS categories,
      GROUP_CONCAT(DISTINCT c.slug  ORDER BY c.name  SEPARATOR ', ') AS category_slugs,

      ROUND(AVG(r.rating), 1)  AS avg_rating,
      COUNT(DISTINCT r.id)     AS review_count

    FROM products p
    LEFT JOIN ebooks e            ON e.product_id = p.id
    LEFT JOIN product_categories pc ON pc.product_id = p.id
    LEFT JOIN categories c        ON c.id = pc.category_id
    LEFT JOIN product_authors pa  ON pa.product_id = p.id
    LEFT JOIN authors a           ON a.id = pa.author_id
    LEFT JOIN reviews r           ON r.product_id = p.id AND r.status = 'approved'
    WHERE p.slug = ?
      AND p.status = 'published'
      AND (p.product_type = 'ebook' OR p.product_type = 'both')
    GROUP BY
      p.id, p.title, p.slug, p.main_image, p.description,
      p.product_type, p.stock, p.price, p.sell_price, p.created_at,
      e.id, e.price, e.sell_price, e.file_type
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) {
      console.error("Ebook detail error:", err);
      return res.status(500).json({ message: "DB error" });
    }
    if (!rows.length) return res.status(404).json({ message: "eBook not found" });
    res.json(rows[0]);
  });
});




module.exports = router;