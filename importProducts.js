require("dotenv").config();
const fs = require("fs");
const csv = require("csv-parser");
const db = require("./db");

/* ---------------- HELPERS ---------------- */

const slugify = (s = "") =>
  s
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0900-\u097F]+/g, "-") // ✅ include Hindi Unicode range in slug
    .replace(/(^-|-$)/g, "");

const query = (...args) => db.promise().query(...args);

const extractImagePath = (url) => {
  if (!url) return null;
  const filename = url.split("/").pop(); // get "Screenshot-2024-06-25-131421.jpg"
  return `/uploads/products/${filename}`;
};

async function getOrCreate(table, data, uniqueKey, value) {
  const [rows] = await query(
    `SELECT id FROM ${table} WHERE ${uniqueKey} = ?`,
    [value]
  );

  if (rows.length) return rows[0].id;

  const [res] = await query(`INSERT INTO ${table} SET ?`, data);
  return res.insertId;
}

/* ---------------- MAIN IMPORT ---------------- */

(async () => {
  console.log("🚀 Product import started...");

  const stream = fs
    .createReadStream("./filtered_no_duplicates.csv", { encoding: "utf8" }) // ✅ FIX 1: explicit UTF-8
    .pipe(
      csv({
        mapHeaders: ({ header }) =>
          header
            .replace(/^\uFEFF/, "") // strip BOM
            .trim()
            .toLowerCase(), // ✅ FIX 3: normalize all headers to lowercase
      })
    );

  for await (const row of stream) {

    // Helper to read headers case-insensitively (handles "No. Of Pages" vs "No. of Pages")
    const col = (name) => row[name.toLowerCase()] ?? null;

    /* ================= PRODUCT ================= */

    const productName = col("name");
    if (!productName) continue; // skip empty rows

    const slug = col("slug") || slugify(productName);

    const [productRes] = await query(
      `INSERT INTO products
      (title, slug, sku, main_image, description, price, sell_price, stock, product_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [
        productName,
        slug,
        col("sku") || null,
        col("images") ? extractImagePath(col("images").split(",")[0].trim()) : null,
        col("description") || null,
        col("regular price") || 0,
        col("regular price") || 0,
        col("stock") || 0,
        "physical",
        col("published") === "1" ? "published" : "draft",
      ]
    );

    const productId = productRes.insertId;

    /* ================= SHIPPING ================= */

    await query(
      `INSERT INTO shipping_details
      (product_id, weight, length, width, height)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        weight = VALUES(weight),
        length = VALUES(length),
        width  = VALUES(width),
        height = VALUES(height)`,
      [
        productId,
        col("weight (kg)") || null,
        col("length (cm)") || null,
        col("width (cm)") || null,
        col("height (cm)") || null,
      ]
    );

    /* ================= CATEGORIES ================= */

    const categories = col("categories");
    if (categories) {
      for (const cat of categories.split(",")) {
        let parentId = null;

        for (const level of cat.split(">").map((v) => v.trim())) {
          parentId = await getOrCreate(
            "categories",
            {
              name: level,
              slug: slugify(level),
              parent_id: parentId,
              status: "active",
            },
            "slug",
            slugify(level)
          );
        }

        await query(
          `INSERT IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)`,
          [productId, parentId]
        );
      }
    }

    /* ================= ATTRIBUTES + AUTHORS ================= */

    for (let i = 1; i <= 4; i++) {
      const attrName = col(`attribute ${i} name`);
      const attrValue = col(`attribute ${i} value(s)`);

      if (!attrName || !attrValue) continue;

      // AUTHOR
      if (attrName.toLowerCase().includes("author")) {
        const cleanedValue = attrValue.replace(/\\,/g, ",");

        for (const authorName of cleanedValue
          .split(/\n|,/)
          .map((a) => a.trim())
          .filter(Boolean)) {

          const authorId = await getOrCreate(
            "authors",
            { name: authorName, slug: slugify(authorName), status: "active" },
            "slug",
            slugify(authorName)
          );

          await query(
            `INSERT IGNORE INTO product_authors (product_id, author_id) VALUES (?, ?)`,
            [productId, authorId]
          );
        }

        continue;
      }

      // NORMAL ATTRIBUTE
      const attributeId = await getOrCreate(
        "attributes",
        { name: attrName.trim() },
        "name",
        attrName.trim()
      );

      await query(
        `INSERT INTO product_attributes
        (product_id, attribute_id, value)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [productId, attributeId, attrValue.trim()]
      );
    }

    /* ================= SEO META ================= */

    const seoTitle = col("meta: _yoast_wpseo_title");
    const seoDesc = col("meta: _yoast_wpseo_metadesc");
    const seoKw = col("meta: _yoast_wpseo_focuskw");

    if (seoTitle || seoDesc || seoKw) {
      await query(
        `INSERT INTO seo_meta
        (page_type, page_id, meta_title, meta_description, keywords)
        VALUES ('product', ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          meta_title = VALUES(meta_title),
          meta_description = VALUES(meta_description),
          keywords = VALUES(keywords)`,
        [productId, seoTitle || productName, seoDesc || null, seoKw || null]
      );
    }

    console.log(`✅ Imported: ${productName}`);
  } // ✅ FIX 2: row only logged inside the loop

  console.log("🎉 PRODUCT IMPORT COMPLETED");
  process.exit(0);

})().catch((err) => {
  console.error("❌ IMPORT FAILED:", err);
  process.exit(1);
});