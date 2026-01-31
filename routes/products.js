const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const path = require("path");




/* STORAGE */
const fs = require("fs");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = "";

    if (file.fieldname === "image") {
      uploadPath = "uploads/products";
    } else if (file.fieldname === "ebook") {
      uploadPath = "uploads/ebooks";
    }

    if (file.fieldname === "gallery") {
      uploadPath = "uploads/gallery";
    }

    // ✅ AUTO CREATE FOLDER IF NOT EXISTS
    fs.mkdirSync(uploadPath, { recursive: true });

    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});


const upload = multer({ storage });

const generateSlug = (text) => {
  return text
    .toString()
    .normalize("NFC") // ✅ VERY IMPORTANT for Hindi
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "") // ✅ KEEP matras
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
};


const generateUniqueSlug = (baseSlug, callback) => {
  let slug = baseSlug;
  let counter = 1;

  const checkSlug = () => {
    db.query(
      "SELECT id FROM products WHERE slug = ?",
      [slug],
      (err, results) => {
        if (err) return callback(err);

        if (results.length === 0) {
          return callback(null, slug); // ✅ unique
        }

        slug = `${baseSlug}-${counter++}`;
        checkSlug();
      }
    );
  };

  checkSlug();
};


/* ADD PRODUCT */
router.post(
  "/",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "ebook", maxCount: 1 },
    { name: "gallery", maxCount: 9 },
  ]),
  (req, res) => {
    const {
      title,
      description,
      price,
      sell_price,
      stock,
      sku,
      product_type,
      status,
      weight,
      length,
      width,
      height,
      ebook_price,
      ebook_sell_price
    } = req.body;

    const imagePath = req.files.image
      ? `/uploads/products/${req.files.image[0].filename}`
      : null;

    const slug = generateSlug(title); // ✅ your Hindi-safe slug

    const productSql = `
      INSERT INTO products
      (title, slug, description, price, sell_price, stock, sku, product_type, status, main_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      productSql,
      [title, slug, description, price, sell_price, stock, sku, product_type, status, imagePath],
      (err, result) => {
        if (err) return res.status(500).json(err);

        const productId = result.insertId;

        /* ---------- EBOOK SAVE ---------- */
        if (req.files.ebook) {
          const ebookFile = req.files.ebook[0];
          const fileType = path.extname(ebookFile.originalname).replace(".", "");

          db.query(
            `INSERT INTO ebooks 
             (product_id, file_path, file_type, price, sell_price)
             VALUES (?, ?, ?, ?, ?)`,
            [
              productId,
              `/uploads/ebooks/${ebookFile.filename}`,
              fileType,
              ebook_price || null,
              ebook_sell_price || null
            ]
          );
        }

        /* ---------- SHIPPING SAVE ---------- */
        if (product_type === "physical" || product_type === "both") {
          db.query(
            `INSERT INTO shipping_details
             (product_id, weight, length, width, height)
             VALUES (?, ?, ?, ?, ?)`,
            [productId, weight, length, width, height]
          );
        }

        /* ---------- SAVE PRODUCT ATTRIBUTES ---------- */
        if (req.body.attributes) {
          const attributes = JSON.parse(req.body.attributes);
        
          attributes.forEach((attr) => {
            const name = attr.name?.trim();
            const value = attr.values?.trim();
        
            if (!name || !value) return;
        
            db.query(
              "INSERT IGNORE INTO attributes (name) VALUES (?)",
              [name],
              () => {
                db.query(
                  "SELECT id FROM attributes WHERE name = ?",
                  [name],
                  (err, rows) => {
                    if (err || !rows.length) return;
        
                    db.query(
                      `INSERT INTO product_attributes
                       (product_id, attribute_id, value)
                       VALUES (?, ?, ?)
                       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
                      [productId, rows[0].id, value]
                    );
                  }
                );
              }
            );
          });
        }

        /* ---------- SAVE PRODUCT CATEGORIES ---------- */
        if (req.body.categories) {
          const categories = JSON.parse(req.body.categories);
        
          categories.forEach((categoryId) => {
            db.query(
              `INSERT IGNORE INTO product_categories
               (product_id, category_id)
               VALUES (?, ?)`,
              [productId, categoryId]
            );
          });
        }

        /* ---------- PRODUCT GALLERY ---------- */
        if (req.files.gallery) {
          req.files.gallery.forEach((file, index) => {
            db.query(
              `INSERT INTO product_gallery
              (product_id, image_path, sort_order)
              VALUES (?, ?, ?)`,
              [
                productId,
                `/uploads/gallery/${file.filename}`,
                index,
              ]
            );
          });
        }
        /* ---------- SAVE SEO META ---------- */
        const { meta_title, meta_description, keywords } = req.body;
        
        if (meta_title || meta_description || keywords) {
          db.query(
            `INSERT INTO seo_meta
            (page_type, page_id, meta_title, meta_description, keywords)
            VALUES (?, ?, ?, ?, ?)`,
            [
              "product",
              productId,
              meta_title || null,
              meta_description || null,
              keywords || null,
            ]
          );
        }

        /* ---------- SAVE PRODUCT AUTHORS ---------- */
        if (req.body.authors) {
          const authors = JSON.parse(req.body.authors);
        
          authors.forEach((authorId) => {
            db.query(
              `INSERT IGNORE INTO product_authors
               (product_id, author_id)
               VALUES (?, ?)`,
              [productId, authorId]
            );
          });
        }




        res.json({ message: "Product created", productId });
      }
    );
  }
);


/* ================= GET PRODUCTS LIST ================= */
router.get("/", (req, res) => {
  const sql = `
    SELECT 
      p.id,
      p.title AS name,
      p.main_image AS image,
      p.sku,
      p.stock,
      p.price,
      p.sell_price,
      p.status,
      p.created_at AS date,
      GROUP_CONCAT(c.name) AS categories
    FROM products p
    LEFT JOIN product_categories pc ON pc.product_id = p.id
    LEFT JOIN categories c ON c.id = pc.category_id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Product fetch error:", err);
      return res.status(500).json({ message: "DB error" });
    }

    const formatted = results.map((p) => ({
      ...p,
      categories: p.categories ? p.categories.split(",") : [],
    }));

    res.json(formatted);
  });
});





/* ================= GET RANDOM FEATURED PRODUCT ================= */
router.get("/random/featured", (req, res) => {
  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.description,
      p.price,
      p.sell_price,
      p.main_image,

      GROUP_CONCAT(a.name SEPARATOR ', ') AS authors

    FROM products p

    LEFT JOIN product_authors pa 
      ON pa.product_id = p.id

    LEFT JOIN authors a 
      ON a.id = pa.author_id

    WHERE p.status = 'published'

    GROUP BY p.id
    ORDER BY RAND()
    LIMIT 1
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Random product error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    if (!rows.length) {
      return res.json(null);
    }

    res.json(rows[0]);
  });
});


/* ================= GET PRODUCT BY SLUG (PUBLIC STORE) ================= */
router.get("/slug/:slug", (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.description,
      p.price,
      p.sell_price,
      p.stock,
      p.product_type,
      p.main_image,

      MAX(sd.weight) AS weight,
      MAX(sd.length) AS length,
      MAX(sd.width) AS width,
      MAX(sd.height) AS height,
      
      MAX(e.file_path) AS ebook_path,
      MAX(e.price) AS ebook_price,
      MAX(e.sell_price) AS ebook_sell_price,

      GROUP_CONCAT(DISTINCT a.id) AS author_ids,
      GROUP_CONCAT(DISTINCT a.name) AS author_names,
      GROUP_CONCAT(DISTINCT a.profile_image) AS author_images,
      GROUP_CONCAT(DISTINCT a.bio) AS author_bios,

      GROUP_CONCAT(DISTINCT c.id) AS category_ids,
      GROUP_CONCAT(DISTINCT c.name) AS category_names,
      GROUP_CONCAT(DISTINCT c.slug) AS category_slugs

      FROM products p
      LEFT JOIN shipping_details sd ON sd.product_id = p.id
      LEFT JOIN ebooks e ON e.product_id = p.id
      LEFT JOIN product_authors pa ON pa.product_id = p.id
      LEFT JOIN authors a ON a.id = pa.author_id
      LEFT JOIN product_categories pc ON pc.product_id = p.id
      LEFT JOIN categories c ON c.id = pc.category_id
      WHERE p.slug = ?
      GROUP BY p.id
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) {
      console.error("Product slug error:", err);
      return res.status(500).json({ message: "DB error" });
    }

    if (!rows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = rows[0];

    /* ================= BUILD AUTHORS ================= */
    product.authors = product.author_ids
      ? product.author_ids.split(",").map((id, i) => ({
          id: Number(id),
          name: product.author_names?.split(",")[i] || "",
          image: product.author_images?.split(",")[i] || null,
          bio: product.author_bios?.split(",")[i] || null,
        }))
      : [];

    /* ================= BUILD CATEGORIES ================= */
    product.categories = product.category_ids
      ? product.category_ids.split(",").map((id, i) => ({
          id: Number(id),
          name: product.category_names?.split(",")[i] || "",
          slug: product.category_slugs?.split(",")[i] || "",
        }))
      : [];

    /* ================= CLEAN TEMP FIELDS ================= */
    delete product.author_ids;
    delete product.author_names;
    delete product.author_images;
    delete product.author_bios;

    delete product.category_ids;
    delete product.category_names;
    delete product.category_slugs;

    /* ================= ATTRIBUTES ================= */
    db.query(
      `
      SELECT 
        a.name,
        pa.value
      FROM product_attributes pa
      JOIN attributes a 
        ON a.id = pa.attribute_id
      WHERE pa.product_id = ?
      `,
      [product.id],
      (err, attributes) => {
        if (err) {
          console.error("Attributes error:", err);
          return res.status(500).json({ message: "Attribute fetch failed" });
        }

        product.attributes = attributes || [];

        /* ================= GALLERY ================= */
        db.query(
          `
          SELECT image_path
          FROM product_gallery
          WHERE product_id = ?
          ORDER BY sort_order ASC
          `,
          [product.id],
          (err, gallery) => {
            if (err) {
              console.error("Gallery error:", err);
              return res.status(500).json({ message: "Gallery fetch failed" });
            }

            product.gallery = gallery || [];

            res.json(product);
          }
        );
      }
    ); 
  }); 
});




/*============== GET SINGLE PRODUCT============== */
router.get("/:id", (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.description,
      p.price,
      p.sell_price,
      p.stock,
      p.sku,
      p.status,
      p.product_type,
      p.main_image,

      sd.weight,
      sd.length,
      sd.width,
      sd.height,

      sm.meta_title,
      sm.meta_description,
      sm.keywords,

      e.file_path AS ebook_path,
      e.file_type AS ebook_type,
      e.price AS ebook_price,
      e.sell_price AS ebook_sell_price,

      GROUP_CONCAT(pc.category_id) AS category_ids

    FROM products p

    LEFT JOIN shipping_details sd 
      ON sd.product_id = p.id

    LEFT JOIN seo_meta sm 
      ON sm.page_type = 'product' 
      AND sm.page_id = p.id

    LEFT JOIN ebooks e 
      ON e.product_id = p.id

    LEFT JOIN product_categories pc 
      ON pc.product_id = p.id

    WHERE p.id = ?
    GROUP BY p.id
  `;

  db.query(sql, [id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length)
      return res.status(404).json({ message: "Product not found" });

    const product = rows[0];

    product.category_ids = product.category_ids
      ? product.category_ids.split(",").map(Number)
      : [];

    res.json(product);
  });
});


// ================GET PRODUCT GALLERY================

router.get("/:id/gallery", (req, res) => {
  const { id } = req.params;

  db.query(
    `
    SELECT id, image_path, sort_order
    FROM product_gallery
    WHERE product_id = ?
    ORDER BY sort_order ASC
    `,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});





/* UPDATE PRODUCT */


router.put(
  "/:id",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "ebook", maxCount: 1 },
    { name: "gallery", maxCount: 9 },
  ]),
  (req, res) => {
    const { id } = req.params;

    const {
      title,
      slug,
      description,
      price,
      sell_price,
      stock,
      sku, 
      product_type,
      status,
      weight,
      length,
      width,
      height,
      meta_title,
      meta_description,
      keywords,
      categories,
      attributes,
      authors,
      ebook_price,
      ebook_sell_price,
    } = req.body;

    /* ---------------- UPDATE PRODUCT ---------------- */
    const imagePath = req.files?.image
      ? `/uploads/products/${req.files.image[0].filename}`
      : null;

    const updateSql = `
      UPDATE products SET
        title = ?,
        slug = ?,
        description = ?,
        price = ?,
        sell_price = ?,
        stock = ?,
        sku = ?,
        product_type = ?,
        status = ?
        ${imagePath ? ", main_image = ?" : ""}
      WHERE id = ?
    `;

    const params = imagePath
      ? [title, slug, description, price, sell_price, stock, sku, product_type, status, imagePath, id]
      : [title, slug, description, price, sell_price, stock, sku, product_type, status, id];

    db.query(updateSql, params, (err) => {
      if (err) return res.status(500).json(err);

      /* ---------------- SHIPPING ---------------- */
      db.query(`DELETE FROM shipping_details WHERE product_id = ?`, [id], () => {
        if (product_type === "physical" || product_type === "both") {
          db.query(
            `INSERT INTO shipping_details
             (product_id, weight, length, width, height)
             VALUES (?, ?, ?, ?, ?)`,
            [id, weight, length, width, height]
          );
        }
      });

      /* ---------------- SEO ---------------- */
      db.query(
        `DELETE FROM seo_meta WHERE page_type='product' AND page_id=?`,
        [id],
        () => {
          if (meta_title || meta_description || keywords) {
            db.query(
              `INSERT INTO seo_meta
              (page_type, page_id, meta_title, meta_description, keywords)
              VALUES ('product', ?, ?, ?, ?)`,
              [id, meta_title, meta_description, keywords]
            );
          }
        }
      );

      /* ---------------- CATEGORIES ---------------- */
      db.query(`DELETE FROM product_categories WHERE product_id = ?`, [id], () => {
        if (categories) {
          JSON.parse(categories).forEach((catId) => {
            db.query(
              `INSERT INTO product_categories (product_id, category_id)
               VALUES (?, ?)`,
              [id, catId]
            );
          });
        }
      });

      /* ---------------- ATTRIBUTES ---------------- */
      db.query(`DELETE FROM product_attributes WHERE product_id = ?`, [id], () => {
        if (attributes) {
          JSON.parse(attributes).forEach((attr) => {
            if (!attr.name || !attr.values) return;

            db.query(
              `INSERT IGNORE INTO attributes (name) VALUES (?)`,
              [attr.name],
              () => {
                db.query(
                  `SELECT id FROM attributes WHERE name = ?`,
                  [attr.name],
                  (err, rows) => {
                    if (!rows?.length) return;

                    db.query(
                      `INSERT INTO product_attributes
                      (product_id, attribute_id, value)
                      VALUES (?, ?, ?)`,
                      [id, rows[0].id, attr.values]
                    );
                  }
                );
              }
            );
          });
        }
      });

      /* ---------------- AUTHORS ---------------- */
      db.query(`DELETE FROM product_authors WHERE product_id = ?`, [id], () => {
        if (authors) {
          JSON.parse(authors).forEach((authorId) => {
            db.query(
              `INSERT INTO product_authors (product_id, author_id)
               VALUES (?, ?)`,
              [id, authorId]
            );
          });
        }
      });

      /* ---------------- EBOOK ---------------- */
      if (req.files?.ebook) {
        const ebook = req.files.ebook[0];

        db.query(`DELETE FROM ebooks WHERE product_id = ?`, [id], () => {
          db.query(
            `INSERT INTO ebooks 
             (product_id, file_path, file_type, price, sell_price)
             VALUES (?, ?, ?, ?, ?)`,
            [
              id,
              `/uploads/ebooks/${ebook.filename}`,
              path.extname(ebook.originalname).replace(".", ""),
              ebook_price || null,
              ebook_sell_price || null
            ]
          );
        });
      }

      /* ---------------- GALLERY ---------------- */
      /* DELETE REMOVED IMAGES */
if (req.body.deletedGallery) {
  const deleted = JSON.parse(req.body.deletedGallery);
  if (deleted.length) {
    db.query(
      `DELETE FROM product_gallery WHERE id IN (?) AND product_id = ?`,
      [deleted, id]
    );
  }
}

/* UPDATE ORDER */
if (req.body.existingGallery) {
  const existing = JSON.parse(req.body.existingGallery);
  existing.forEach(img => {
    db.query(
      `UPDATE product_gallery SET sort_order = ? WHERE id = ? AND product_id = ?`,
      [img.sort_order, img.id, id]
    );
  });
}

/* INSERT NEW FILES */
if (req.files?.gallery) {
  db.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM product_gallery WHERE product_id = ?`,
    [id],
    (err, rows) => {
      let start = rows[0].maxOrder + 1;

      req.files.gallery.forEach((file, index) => {
        db.query(
          `INSERT INTO product_gallery (product_id, image_path, sort_order)
           VALUES (?, ?, ?)`,
          [id, `/uploads/gallery/${file.filename}`, start + index]
        );
      });
    }
  );
}


      res.json({ message: "Product fully updated" });
    });
  }
);



// =============Delete=============

router.delete("/:id", (req, res) => {
  const { id } = req.params;

  db.query(
    "DELETE FROM products WHERE id = ?",
    [id],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Delete failed" });
      }
      res.json({ message: "Product deleted" });
    }
  );
});



module.exports = router;
