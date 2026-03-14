const express = require("express");
const router = express.Router();
const db = require("../db");

/*
  GET /api/products
  ─────────────────────────────────────────────────────────
  Generic product listing endpoint, filterable by category slug.

  Query params:
    category  – category slug (required for filtered results)
    format    – "ebook" | "physical" (optional)
    sort      – "newest" | "price_asc" | "price_desc"  (default: newest)
    page      – page number (default: 1)
    limit     – results per page (default: 24, max: 48)
*/
router.get("/", async (req, res) => {
  try {
    const {
      category,
      format,
      sort  = "newest",
      page  = 1,
      limit = 24,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(48, Math.max(1, parseInt(limit) || 24));
    const offset   = (pageNum - 1) * limitNum;

    const sortMap = {
      newest:     "p.created_at DESC",
      price_asc:  "p.sell_price ASC",
      price_desc: "p.sell_price DESC",
    };
    const orderBy = sortMap[sort] || "p.created_at DESC";

    /* ── Format filter ── */
    let formatClause = "";
    if (format === "ebook")    formatClause = "AND p.product_type IN ('ebook','both')";
    else if (format === "physical") formatClause = "AND p.product_type IN ('physical','both')";

    /* ── Category filter (optional) ── */
    const categoryJoin = category
      ? `JOIN product_categories pc ON p.id = pc.product_id
         JOIN categories c ON pc.category_id = c.id AND c.slug = ?`
      : "";

    const categoryParam = category ? [category] : [];

    const dataQuery = `
      SELECT
        p.id,
        p.title,
        p.slug,
        p.sku,
        p.price,
        p.sell_price,
        p.main_image,
        p.stock,
        p.product_type,
        p.created_at,

        -- Ebook-specific pricing (lowest across pdf/epub variants)
        -- NULL when the product has no row in the ebooks table
        MIN(e.price)      AS ebook_price,
        MIN(e.sell_price) AS ebook_sell_price,

        CONCAT('[', IFNULL(GROUP_CONCAT(
          DISTINCT JSON_OBJECT('id', a.id, 'name', a.name, 'slug', a.slug)
        ), ''), ']') AS authors,

        ROUND(AVG(r.rating), 1) AS avg_rating,
        COUNT(DISTINCT r.id)    AS review_count

      FROM products p
      ${categoryJoin}
      LEFT JOIN ebooks e          ON e.product_id = p.id
      LEFT JOIN product_authors pa ON p.id = pa.product_id
      LEFT JOIN authors a          ON pa.author_id = a.id
      LEFT JOIN reviews r          ON p.id = r.product_id AND r.status = 'approved'

      WHERE p.status = 'published'
      ${formatClause}

      GROUP BY p.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM products p
      ${categoryJoin}
      WHERE p.status = 'published'
      ${formatClause}
    `;

    const queryParams = [...categoryParam, limitNum, offset];
    const countParams = [...categoryParam];

    const [[rows], [[{ total }]]] = await Promise.all([
      db.promise().query(dataQuery, queryParams),
      db.promise().query(countQuery, countParams),
    ]);

    const products = rows.map((row) => ({
      ...row,
      authors:          row.authors          ? JSON.parse(row.authors)          : [],
      avg_rating:       row.avg_rating        ? parseFloat(row.avg_rating)       : null,
      review_count:     row.review_count      ? parseInt(row.review_count)       : 0,
      // Ebook-specific prices — null when no ebooks row exists
      ebook_price:      row.ebook_price       ? parseFloat(row.ebook_price)      : null,
      ebook_sell_price: row.ebook_sell_price  ? parseFloat(row.ebook_sell_price) : null,
    }));

    res.status(200).json({
      success:  true,
      count:    products.length,
      total:    parseInt(total),
      page:     pageNum,
      pages:    Math.ceil(total / limitNum),
      category: category || null,
      products,
    });
  } catch (error) {
    console.error("Products API Error:", error);
    res.status(500).json({ success: false, message: "Server error while fetching products" });
  }
});

module.exports = router;