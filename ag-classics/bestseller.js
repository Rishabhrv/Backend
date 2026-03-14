const express = require("express");
const router  = express.Router();
const db      = require("../db");

/*
  GET /api/products/bestsellers
  ─────────────────────────────────────────────────────────────
  Returns products ranked by total units sold (order_items sum).

  Query params:
    format  – "ebook" | "physical"  (optional)
    sort    – "bestseller" (default) | "top_rated" | "newest" | "price_asc" | "price_desc"
    page    – page number  (default: 1)
    limit   – per page     (default: 24, max: 48)
*/
router.get("/", async (req, res) => {
  try {
    const {
      format,
      sort  = "bestseller",
      page  = 1,
      limit = 24,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(48, Math.max(1, parseInt(limit) || 24));
    const offset   = (pageNum - 1) * limitNum;

    /* ── Sort map ── */
    const orderMap = {
      bestseller: "total_sold DESC, p.created_at DESC",
      top_rated:  "avg_rating DESC, review_count DESC",
      newest:     "p.created_at DESC",
      price_asc:  "p.sell_price ASC",
      price_desc: "p.sell_price DESC",
    };
    const orderBy = orderMap[sort] || orderMap.bestseller;

    /* ── Format filter ── */
    let formatClause = "";
    if (format === "ebook")    formatClause = "AND p.product_type IN ('ebook','both')";
    else if (format === "physical") formatClause = "AND p.product_type IN ('physical','both')";

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

    COALESCE(SUM(oi.quantity), 0) AS total_sold,

    CONCAT('[', IFNULL(GROUP_CONCAT(
      DISTINCT JSON_OBJECT('id', a.id, 'name', a.name, 'slug', a.slug)
      ORDER BY a.name SEPARATOR ','
    ), ''), ']') AS authors,

    ROUND(AVG(r.rating), 1) AS avg_rating,
    COUNT(DISTINCT r.id) AS review_count

  FROM products p

  JOIN product_categories pc ON p.id = pc.product_id
  JOIN categories c ON pc.category_id = c.id

  LEFT JOIN order_items oi ON p.id = oi.product_id
  LEFT JOIN orders o
    ON oi.order_id = o.id
    AND o.payment_status = 'success'
    AND o.status NOT IN ('cancelled')

  LEFT JOIN product_authors pa ON p.id = pa.product_id
  LEFT JOIN authors a ON pa.author_id = a.id

  LEFT JOIN reviews r ON p.id = r.product_id AND r.status = 'approved'

  WHERE p.status = 'published'
  AND c.imprint = 'agclassics'
  ${formatClause}

  GROUP BY p.id
  ORDER BY ${orderBy}
  LIMIT ? OFFSET ?
`;

const countQuery = `
  SELECT COUNT(DISTINCT p.id) AS total
  FROM products p
  JOIN product_categories pc ON p.id = pc.product_id
  JOIN categories c ON pc.category_id = c.id
  WHERE p.status = 'published'
  AND c.imprint = 'agclassics'
  ${formatClause}
`;

    const [[rows], [[{ total }]]] = await Promise.all([
      db.promise().query(dataQuery, [limitNum, offset]),
      db.promise().query(countQuery),
    ]);

    const products = rows.map((row, idx) => ({
      ...row,
      rank:         offset + idx + 1,
      total_sold:   parseInt(row.total_sold)   || 0,
      authors:      row.authors      ? JSON.parse(row.authors)    : [],
      avg_rating:   row.avg_rating   ? parseFloat(row.avg_rating) : null,
      review_count: row.review_count ? parseInt(row.review_count) : 0,
    }));

    res.status(200).json({
      success:  true,
      count:    products.length,
      total:    parseInt(total),
      page:     pageNum,
      pages:    Math.ceil(total / limitNum),
      sort,
      format:   format || "all",
      products,
    });

  } catch (error) {
    console.error("Bestsellers API Error:", error);
    res.status(500).json({ success: false, message: "Server error fetching bestsellers" });
  }
});

module.exports = router;