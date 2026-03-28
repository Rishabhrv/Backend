const express = require("express");
const router = express.Router();
const db = require("../db");
const slugify = require("slugify");

const multer = require("multer");
const fs = require("fs");
const path = require("path");

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
      status
    FROM authors
    ORDER BY name ASC
    `,
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

router.get("/home-author", (req, res) => {
  db.query(
    `
    SELECT DISTINCT 
      a.id, 
      a.name, 
      a.slug, 
      a.profile_image, 
      a.bio, 
      a.status
    FROM authors a
    JOIN product_authors pa ON a.id = pa.author_id
    JOIN product_categories pc ON pa.product_id = pc.product_id
    JOIN categories c ON pc.category_id = c.id
    WHERE c.imprint = 'agph'
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
  const { name, bio } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Author name required" });
  }

  const slug = slugify(name, { lower: true, strict: true });

  const imagePath = req.file
    ? `/uploads/authors/${req.file.filename}`
    : null;

  db.query(
    `INSERT INTO authors (name, slug, profile_image, bio)
     VALUES (?, ?, ?, ?)`,
    [name, slug, imagePath, bio || null],
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
      });
    }
  );
});


// GET AUTHORS FOR A PRODUCT
router.get("/:productId/authors", (req, res) => {
  const { productId } = req.params;

  db.query(
    `
    SELECT a.id, a.name, a.profile_image
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

/* UPDATE AUTHOR */
router.put("/:id", upload.single("profile_image"), (req, res) => {
  const { id } = req.params;
  const { name, bio, status } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Author name required" });
  }

  const slug = slugify(name, { lower: true, strict: true });

  const imagePath = req.file
    ? `/uploads/authors/${req.file.filename}`
    : null;

  const sql = `
    UPDATE authors SET
      name = ?,
      slug = ?,
      bio = ?,
      status = ?
      ${imagePath ? ", profile_image = ?" : ""}
    WHERE id = ?
  `;

  const params = imagePath
    ? [name, slug, bio || null, status || "active", imagePath, id]
    : [name, slug, bio || null, status || "active", id];

  db.query(sql, params, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "Author already exists" });
      }
      return res.status(500).json(err);
    }

    res.json({ message: "Author updated successfully" });
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


/* ─── ADD THIS ROUTE TO YOUR author.js ─── */

/* GET SINGLE AUTHOR BY SLUG + THEIR BOOKS */
router.get("/slug/:slug", (req, res) => {
  const { slug } = req.params;

  // First get the author
  db.query(
    `SELECT id, name, slug, profile_image, bio, status, created_at
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
