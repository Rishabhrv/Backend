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



module.exports = router;
