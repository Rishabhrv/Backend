const express = require("express");
const router = express.Router();
const db = require("../db");

/*
  GET /api/ag-classics
  Lists all products whose category AND imprint = 'agclassics'
*/
router.get("/", async (req, res) => {
  try {
    const { format, sort = "newest", page = 1, limit = 24 } = req.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(48, Math.max(1, parseInt(limit) || 24));
    const offset   = (pageNum - 1) * limitNum;

    const sortMap = {
      newest:     "p.created_at DESC",
      price_asc:  "p.sell_price ASC",
      price_desc: "p.sell_price DESC",
    };
    const orderBy = sortMap[sort] || "p.created_at DESC";

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

        -- Ebook-specific pricing (lowest sell_price across pdf/epub variants)
        MIN(e.price)      AS ebook_price,
        MIN(e.sell_price) AS ebook_sell_price,

        CONCAT('[', IFNULL(GROUP_CONCAT(
          DISTINCT JSON_OBJECT('id', a.id, 'name', a.name, 'slug', a.slug)
        ), ''), ']') AS authors,

        ROUND(AVG(r.rating), 1) AS avg_rating,
        COUNT(DISTINCT r.id)    AS review_count

      FROM products p
      JOIN product_categories pc ON p.id = pc.product_id
      JOIN categories c
        ON pc.category_id = c.id
        AND c.imprint = 'agclassics'

      LEFT JOIN ebooks e          ON e.product_id = p.id
      LEFT JOIN product_authors pa ON p.id = pa.product_id
      LEFT JOIN authors a         ON pa.author_id = a.id
      LEFT JOIN reviews r         ON p.id = r.product_id AND r.status = 'approved'

      WHERE p.status = 'published'
      ${formatClause}

      GROUP BY p.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM products p
      JOIN product_categories pc ON p.id = pc.product_id
      JOIN categories c
        ON pc.category_id = c.id
        AND c.imprint = 'agclassics'
      WHERE p.status = 'published'
      ${formatClause}
    `;

    const [[rows], [[{ total }]]] = await Promise.all([
      db.promise().query(dataQuery, [limitNum, offset]),
      db.promise().query(countQuery, []),
    ]);

    const products = rows.map((row) => ({
      ...row,
      authors:          row.authors          ? JSON.parse(row.authors) : [],
      avg_rating:       row.avg_rating        ? parseFloat(row.avg_rating)   : null,
      review_count:     row.review_count      ? parseInt(row.review_count)   : 0,
      // ebook_price / ebook_sell_price are null when the product has no ebook entry
      ebook_price:      row.ebook_price       ? parseFloat(row.ebook_price)      : null,
      ebook_sell_price: row.ebook_sell_price  ? parseFloat(row.ebook_sell_price) : null,
    }));

    res.status(200).json({
      success: true,
      count:   products.length,
      total:   parseInt(total),
      page:    pageNum,
      pages:   Math.ceil(total / limitNum),
      products,
    });

  } catch (error) {
    console.error("AG Classics Error:", error);
    res.status(500).json({ success: false, message: "Server error while fetching AG Classics" });
  }
});

/*
  GET /api/ag-classics/:slug
  Single product — must belong to ag-classics category WITH imprint = 'agclassics'
*/
router.get("/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const query = `
      SELECT
        p.id,
        p.title,
        p.slug,
        p.sku,
        p.isbn,
        p.price,
        p.sell_price,
        p.main_image,
        p.description,
        p.stock,
        p.product_type,
        p.created_at,

        -- Authors
        CONCAT('[', IFNULL(GROUP_CONCAT(
          DISTINCT JSON_OBJECT(
            'id', a.id, 'name', a.name,
            'slug', a.slug, 'profile_image', a.profile_image,
            'bio', a.bio
          )
        ), ''), ']') AS authors,

        -- Gallery
        CONCAT('[', IFNULL(GROUP_CONCAT(
          DISTINCT JSON_OBJECT(
            'id', pg.id, 'image_path', pg.image_path, 'sort_order', pg.sort_order
          )
        ), ''), ']') AS gallery,

        -- Ebook files with their individual prices
        CONCAT('[', IFNULL(GROUP_CONCAT(
          DISTINCT JSON_OBJECT(
            'id', e.id, 'file_type', e.file_type,
            'price', e.price, 'sell_price', e.sell_price
          )
        ), ''), ']') AS ebook_files,

        -- Attributes (pages, language, edition, etc.)
        CONCAT('[', IFNULL(GROUP_CONCAT(
          DISTINCT JSON_OBJECT(
            'name', attr.name, 'value', pa.value
          )
        ), ''), ']') AS attributes,

        ROUND(AVG(r.rating), 1) AS avg_rating,
        COUNT(DISTINCT r.id)    AS review_count

      FROM products p
      JOIN product_categories pc ON p.id = pc.product_id
      JOIN categories c
        ON pc.category_id = c.id
        AND c.imprint = 'agclassics'

      LEFT JOIN product_authors pa2  ON p.id = pa2.product_id
      LEFT JOIN authors a            ON pa2.author_id = a.id
      LEFT JOIN product_gallery pg   ON p.id = pg.product_id
      LEFT JOIN ebooks e             ON p.id = e.product_id
      LEFT JOIN product_attributes pa ON p.id = pa.product_id
      LEFT JOIN attributes attr      ON pa.attribute_id = attr.id
      LEFT JOIN reviews r            ON p.id = r.product_id AND r.status = 'approved'

      WHERE p.slug   = ?
        AND p.status = 'published'

      GROUP BY p.id
    `;

    const [rows] = await db.promise().query(query, [slug]);

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Product not found in AG Classics" });
    }

    const row = rows[0];

    let gallery = row.gallery ? JSON.parse(row.gallery) : [];
    gallery = gallery
      .filter((g) => g.image_path)
      .sort((a, b) => a.sort_order - b.sort_order);

    const ebook_files = row.ebook_files ? JSON.parse(row.ebook_files) : [];

    res.status(200).json({
      success: true,
      product: {
        ...row,
        authors:      row.authors    ? JSON.parse(row.authors) : [],
        gallery,
        ebook_files,
        attributes:   row.attributes ? JSON.parse(row.attributes) : [],
        avg_rating:   row.avg_rating   ? parseFloat(row.avg_rating)   : null,
        review_count: row.review_count ? parseInt(row.review_count)   : 0,
      },
    });

  } catch (error) {
    console.error("Single AG Classic Error:", error);
    res.status(500).json({ success: false, message: "Server error while fetching product" });
  }
});

/*
  GET /api/ag-classics/:slug/reviews
  Paginated approved reviews for a product
*/
router.get("/:slug/reviews", async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 10));
    const offset   = (pageNum - 1) * limitNum;

    const [rows] = await db.promise().query(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              u.name AS user_name,
              GROUP_CONCAT(ri.image_path) AS images
       FROM reviews r
       JOIN products p   ON r.product_id = p.id AND p.slug = ?
       JOIN users u      ON r.user_id = u.id
       LEFT JOIN review_images ri ON r.id = ri.review_id
       WHERE r.status = 'approved'
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [slug, limitNum, offset]
    );

    const [[{ total }]] = await db.promise().query(
      `SELECT COUNT(r.id) AS total
       FROM reviews r
       JOIN products p ON r.product_id = p.id AND p.slug = ?
       WHERE r.status = 'approved'`,
      [slug]
    );

    res.status(200).json({
      success: true,
      reviews: rows.map((r) => ({
        ...r,
        images: r.images ? r.images.split(",") : [],
      })),
      total:   parseInt(total),
      page:    pageNum,
      pages:   Math.ceil(total / limitNum),
    });

  } catch (error) {
    console.error("Reviews Error:", error);
    res.status(500).json({ success: false, message: "Error fetching reviews" });
  }
});

module.exports = router;