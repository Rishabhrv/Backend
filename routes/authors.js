const express = require("express");
const router = express.Router();
const db = require("../db");
const slugify = require("slugify");

const multer = require("multer");
const fs = require("fs");
const path = require("path");
const generateSlug = (text) => {
  return text
    .toString()
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "uploads/authors";
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });


/* GET ALL AUTHORS (FOR TABLE) */
router.get("/", (req, res) => {
  db.query(
    `
    SELECT 
      id,
      name,
      slug,
      profile_image,
      bio,
      status,
      is_featured
    FROM authors
    ORDER BY name ASC
    `,
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

/* GET FEATURED HOME AUTHORS */
router.get("/home-author", (req, res) => {
  db.query(
    `
    SELECT DISTINCT 
      a.id, 
      a.name, 
      a.slug, 
      a.profile_image, 
      a.bio, 
      a.status,
      a.is_featured
    FROM authors a
    WHERE a.is_featured = 1
      AND a.status = 'active'
    ORDER BY a.name ASC
    `,
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});



/* ADD NEW AUTHOR */
router.post("/", upload.single("profile_image"), (req, res) => {
  const { name, bio, is_featured } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Author name required" });
  }

  const slug = generateSlug(name);
  const featuredVal = (is_featured === "true" || is_featured === true || is_featured === 1 || is_featured === "1") ? 1 : 0;

  const imagePath = req.file
    ? `/uploads/authors/${req.file.filename}`
    : null;

  db.query(
    `INSERT INTO authors (name, slug, profile_image, bio, is_featured)
     VALUES (?, ?, ?, ?, ?)`,
    [name, slug, imagePath, bio || null, featuredVal],
    (err, result) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") {
          return res.status(409).json({ message: "Author already exists" });
        }
        return res.status(500).json(err);
      }

      res.json({
        id: result.insertId,
        name,
        profile_image: imagePath,
        is_featured: featuredVal,
      });
    }
  );
});


// GET AUTHORS FOR A PRODUCT
router.get("/:productId/authors", (req, res) => {
  const { productId } = req.params;

  db.query(
    `
    SELECT a.id, a.bio, a.name, a.profile_image, a.is_featured
    FROM product_authors pa
    JOIN authors a ON a.id = pa.author_id
    WHERE pa.product_id = ?
    `,
    [productId],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

/* TOGGLE FEATURED (FOR TABLE TOGGLE BUTTON) */
router.patch("/:id/toggle-featured", (req, res) => {
  const { id } = req.params;
  const { is_featured } = req.body || {};

  let query;
  let params;

  if (typeof is_featured !== "undefined") {
    const val = (is_featured === true || is_featured === 1 || is_featured === "1" || is_featured === "true") ? 1 : 0;
    query = "UPDATE authors SET is_featured = ? WHERE id = ?";
    params = [val, id];
  } else {
    query = "UPDATE authors SET is_featured = IF(is_featured = 1, 0, 1) WHERE id = ?";
    params = [id];
  }

  db.query(query, params, (err) => {
    if (err) {
      console.error("Toggle featured error:", err);
      return res.status(500).json({ message: "Failed to update featured status" });
    }
    db.query("SELECT id, name, is_featured FROM authors WHERE id = ?", [id], (err2, rows) => {
      if (err2 || !rows.length) return res.json({ success: true, id: Number(id) });
      res.json({ 
        success: true, 
        id: rows[0].id, 
        name: rows[0].name, 
        is_featured: rows[0].is_featured === 1 
      });
    });
  });
});

/* UPDATE AUTHOR */
router.put("/:id", upload.single("profile_image"), (req, res) => {
  const { id } = req.params;
  // Extract slug and is_featured from req.body
  const { name, bio, status, slug, is_featured } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Author name required" });
  }

  // Use the provided slug, OR generate a new one if it's missing
  const finalSlug = slug ? slug : generateSlug(name);

  const imagePath = req.file
    ? `/uploads/authors/${req.file.filename}`
    : null;

  const hasFeatured = typeof is_featured !== "undefined";
  const featuredVal = hasFeatured ? ((is_featured === "true" || is_featured === true || is_featured === 1 || is_featured === "1") ? 1 : 0) : null;

  let sql = `
    UPDATE authors SET
      name = ?,
      slug = ?,
      bio = ?,
      status = ?
      ${hasFeatured ? ", is_featured = ?" : ""}
      ${imagePath ? ", profile_image = ?" : ""}
    WHERE id = ?
  `;

  const params = [name, finalSlug, bio || null, status || "active"];
  if (hasFeatured) params.push(featuredVal);
  if (imagePath) params.push(imagePath);
  params.push(id);

  db.query(sql, params, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "Author already exists" });
      }
      return res.status(500).json(err);
    }

    res.json({ 
      message: "Author updated successfully",
      profile_image: imagePath,
      is_featured: featuredVal
    });
  });
});


/* DELETE AUTHOR */
router.delete("/:id", (req, res) => {
  const { id } = req.params;

  db.query(
    "DELETE FROM authors WHERE id = ?",
    [id],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Delete failed" });
      }
      res.json({ success: true });
    }
  );
});


/* BULK DELETE AUTHORS */
router.post("/bulk-delete", (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  db.query(
    "DELETE FROM authors WHERE id IN (?)",
    [ids],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Bulk delete failed" });
      }
      res.json({ success: true });
    }
  );
});


/* BULK STATUS UPDATE */
router.post("/bulk-status", (req, res) => {
  const { ids, status } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  db.query(
    "UPDATE authors SET status = ? WHERE id IN (?)",
    [status, ids],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Bulk update failed" });
      }
      res.json({ success: true });
    }
  );
});

/* BULK FEATURED UPDATE */
router.post("/bulk-featured", (req, res) => {
  const { ids, is_featured } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  const val = (is_featured === true || is_featured === 1 || is_featured === "1" || is_featured === "true") ? 1 : 0;

  db.query(
    "UPDATE authors SET is_featured = ? WHERE id IN (?)",
    [val, ids],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Bulk featured update failed" });
      }
      res.json({ success: true, updatedCount: ids.length, is_featured: val });
    }
  );
});


/* GET SINGLE AUTHOR BY SLUG + THEIR BOOKS */
router.get("/slug/:slug", (req, res) => {
  const { slug } = req.params;

  // First get the author
  db.query(
    `SELECT id, name, slug, profile_image, bio, status, is_featured, created_at
     FROM authors WHERE slug = ? AND status = 'active'`,
    [slug],
    (err, authors) => {
      if (err) return res.status(500).json({ message: "DB error" });
      if (!authors.length) return res.status(404).json({ message: "Author not found" });

      const author = authors[0];

      // Then get their books
      db.query(
        `
        SELECT 
          p.id,
          p.title,
          p.slug,
          p.main_image AS image,
          p.price,
          p.sell_price,
          p.stock,
          p.product_type,
          p.status,
          MAX(e.price)      AS ebook_price,
          MAX(e.sell_price) AS ebook_sell_price
        FROM product_authors pa
        JOIN products p ON p.id = pa.product_id
        LEFT JOIN ebooks e ON e.product_id = p.id
        INNER JOIN product_categories pc ON pc.product_id = p.id
        INNER JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agph'
        WHERE pa.author_id = ? 
          AND p.status = 'published'
        GROUP BY p.id
        ORDER BY p.created_at DESC`,
        [author.id],
        (err2, books) => {
          if (err2) return res.status(500).json({ message: "DB error" });
          res.json({ author, books });
        }
      );
    }
  );
});

module.exports = router;
