const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const db = require("../db");

/* ─── Resolve upload folder path ─────────────────────────────────────────── */
function getUploadPath(folder) {
  return path.join(process.cwd(), "uploads", folder);
}



/* ─── Storage config ─────────────────────────────────────────────────────── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {

    let folder = "products";

    // ✅ Use query param instead
    if (req.query.folder === "gallery") {
      folder = "gallery";
    }

    const uploadPath = getUploadPath(folder);
    fs.mkdirSync(uploadPath, { recursive: true });

    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() + "-" + Math.round(Math.random() * 1e9);

    cb(null, uniqueName + path.extname(file.originalname));
  },
});





const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpeg|jpg|png|gif|webp|avif)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

/* ─── Helper: read image dimensions from file bytes ─────────────────────── */
function getImageSize(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/media?folder=products|gallery&productId=123&q=search&page=1
   
   - If productId is given:
       folder=products  → returns only that product's main_image
       folder=gallery   → returns only that product's gallery images
   - If no productId (add mode):
       returns empty [] — no images shown until product is saved
─────────────────────────────────────────────────────────────────────────── */
router.get("/", (req, res) => {
  const folder    = req.query.folder === "gallery" ? "gallery" : "products";
  const productId = req.query.productId ? parseInt(req.query.productId) : null;
  const q         = (req.query.q || "").toLowerCase();
  const page      = Math.max(1, parseInt(req.query.page) || 1);
  const limit     = Math.min(100, Math.max(1, parseInt(req.query.limit) || 40));

  // No productId → add mode, return empty
  if (!productId) {
    return res.json({ images: [], total: 0, page, limit, totalPages: 0 });
  }

  // ── GALLERY: fetch from product_gallery table ──────────────────────────
  if (folder === "gallery") {
    const countSql = `SELECT COUNT(*) as total FROM product_gallery WHERE product_id = ?`;
    const dataSql  = `
      SELECT id, image_path, sort_order
      FROM product_gallery
      WHERE product_id = ?
      ${q ? "AND image_path LIKE ?" : ""}
      ORDER BY sort_order ASC
      LIMIT ? OFFSET ?
    `;

    db.query(countSql, [productId], (err, countRows) => {
      if (err) return res.status(500).json({ message: "DB error" });

      const total      = countRows[0].total;
      const totalPages = Math.ceil(total / limit) || 1;
      const offset     = (page - 1) * limit;
      const params     = q
        ? [productId, `%${q}%`, limit, offset]
        : [productId, limit, offset];

      db.query(dataSql, params, (err, rows) => {
        if (err) return res.status(500).json({ message: "DB error" });

        const images = rows.map((row) => {
          const filename   = path.basename(row.image_path);
          const uploadPath = getUploadPath("gallery");
          const filePath   = path.join(uploadPath, filename);
          let size = null;
          let dims = null;
          try {
            const stat = fs.statSync(filePath);
            size = stat.size;
            dims = getImageSize(filePath);
          } catch {}

          return {
            id:         String(row.id), // gallery row id
            url:        row.image_path,
            filename,
            size,
            width:      dims?.width  || null,
            height:     dims?.height || null,
            created_at: null,
          };
        });

        res.json({ images, total, page, limit, totalPages });
      });
    });

    return;
  }

  // ── PRODUCTS: fetch only this product's main_image ────────────────────
  db.query(
    `SELECT id, main_image, created_at FROM products WHERE id = ? AND main_image IS NOT NULL`,
    [productId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "DB error" });

      if (!rows.length || !rows[0].main_image) {
        return res.json({ images: [], total: 0, page: 1, limit, totalPages: 0 });
      }

      const row      = rows[0];
      const filename = path.basename(row.main_image);

      // Apply search filter
      if (q && !filename.toLowerCase().includes(q)) {
        return res.json({ images: [], total: 0, page: 1, limit, totalPages: 0 });
      }

      const uploadPath = getUploadPath("products");
      const filePath   = path.join(uploadPath, filename);
      let size = null;
      let dims = null;
      try {
        const stat = fs.statSync(filePath);
        size = stat.size;
        dims = getImageSize(filePath);
      } catch {}

      res.json({
        images: [{
          id:         filename,
          url:        row.main_image,
          filename,
          size,
          width:      dims?.width  || null,
          height:     dims?.height || null,
          created_at: row.created_at,
        }],
        total:      1,
        page:       1,
        limit,
        totalPages: 1,
      });
    }
  );
});

/* ─── POST /api/media/upload ─────────────────────────────────────────────── */
router.post("/upload", (req, res) => {
  upload.single("image")(req, res, function (err) {

    if (err instanceof multer.MulterError) {
      return res.status(400).json({ message: err.message });
    }
    if (err) {
      return res.status(500).json({ message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    const folder = req.query.folder === "gallery" ? "gallery" : "products";
    const productId = req.body.productId ? parseInt(req.body.productId) : null;

    const { filename } = req.file;
    const imagePath = `/uploads/${folder}/${filename}`;

    // 🔥 If no productId → just return file info (add mode)
    if (!productId) {
      return res.json({
        id: filename,
        url: imagePath,
        filename,
      });
    }

    // 🔥 PRODUCTS FOLDER → update main_image
    if (folder === "products") {

      db.query(
        `UPDATE products SET main_image = ? WHERE id = ?`,
        [imagePath, productId],
        function (err) {

          if (err) {
            return res.status(500).json({ message: "DB update failed" });
          }

          return res.json({
            id: filename,
            url: imagePath,
            filename,
          });

        }
      );

      return;
    }

    // 🔥 GALLERY FOLDER → insert into product_gallery
    if (folder === "gallery") {

      db.query(
        `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder 
         FROM product_gallery 
         WHERE product_id = ?`,
        [productId],
        (err, rows) => {

          if (err) {
            return res.status(500).json({ message: "DB error" });
          }

          const nextOrder = rows[0].maxOrder + 1;

          db.query(
            `INSERT INTO product_gallery
             (product_id, image_path, sort_order)
             VALUES (?, ?, ?)`,
            [productId, imagePath, nextOrder],
            function (err, result) {

              if (err) {
                return res.status(500).json({ message: "Gallery insert failed" });
              }

              return res.json({
                id: result.insertId, // 🔥 IMPORTANT: return DB id
                url: imagePath,
                filename,
              });

            }
          );

        }
      );

      return;
    }

  });
});


/* ─── GET /api/media/product-images/:productId ───────────────────────────
   Returns all images for a product (main + gallery) with alt_text from
   media_files table. Used by SeoPanel to check image alt coverage.
   Response: [{ file_path, alt_text, source: "main"|"gallery" }]
─────────────────────────────────────────────────────────────────────────── */
router.get("/product-images/:productId", (req, res) => {
  const productId = parseInt(req.params.productId);
  if (!productId) return res.json([]);

  // Fetch main image
  db.query(
    `SELECT
       p.main_image AS file_path,
       mf.alt_text,
       'main' AS source
     FROM products p
     LEFT JOIN media_files mf ON mf.file_path = p.main_image
     WHERE p.id = ? AND p.main_image IS NOT NULL`,
    [productId],
    (err, mainRows) => {
      if (err) return res.status(500).json({ message: "DB error (main image)" });

      // Fetch gallery images
      db.query(
        `SELECT
           pg.image_path AS file_path,
           mf.alt_text,
           'gallery' AS source
         FROM product_gallery pg
         LEFT JOIN media_files mf ON mf.file_path = pg.image_path
         WHERE pg.product_id = ?
         ORDER BY pg.sort_order ASC`,
        [productId],
        (err, galleryRows) => {
          if (err) return res.status(500).json({ message: "DB error (gallery)" });

          res.json([...mainRows, ...galleryRows]);
        }
      );
    }
  );
});

router.put("/rename", (req, res) => {
  const { old_path, new_name } = req.body;

  if (!old_path || !new_name) {
    return res.status(400).json({ message: "Missing data" });
  }

  const folder = old_path.includes("/gallery/")
    ? "gallery"
    : "products";

  const oldFileName = path.basename(old_path);
  const ext = path.extname(oldFileName);
  const newFileName = new_name + ext;

  const uploadDir = path.join(process.cwd(), "uploads", folder);

  const oldFullPath = path.join(uploadDir, oldFileName);
  const newFullPath = path.join(uploadDir, newFileName);

  // ✅ CHECK DUPLICATE
  if (fs.existsSync(newFullPath)) {
    return res.status(400).json({
      message: "File name already exists"
    });
  }

  try {
    fs.renameSync(oldFullPath, newFullPath);
  } catch (err) {
    return res.status(500).json({
      message: "File rename failed"
    });
  }

  const newPath = `/uploads/${folder}/${newFileName}`;

  // ✅ Update products main_image
  db.query(
    "UPDATE products SET main_image = ? WHERE main_image = ?",
    [newPath, old_path]
  );

  // ✅ Update gallery image_path
  db.query(
    "UPDATE product_gallery SET image_path = ? WHERE image_path = ?",
    [newPath, old_path]
  );

  // ✅ Update media table
  db.query(
    "UPDATE media_files SET file_path = ? WHERE file_path = ?",
    [newPath, old_path]
  );

  res.json({ success: true, newPath });
});


router.put("/alt", (req, res) => {
  const { file_path, alt_text } = req.body;

  if (!file_path) {
    return res.status(400).json({ message: "Missing file path" });
  }

  // 1️⃣ Check if record exists
  db.query(
    "SELECT id FROM media_files WHERE file_path = ?",
    [file_path],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ message: "DB error" });
      }

      // 2️⃣ If exists → UPDATE
      if (rows.length > 0) {
        db.query(
          "UPDATE media_files SET alt_text = ? WHERE file_path = ?",
          [alt_text, file_path],
          (err) => {
            if (err) {
              return res.status(500).json({ message: "Update failed" });
            }
            return res.json({ success: true, action: "updated" });
          }
        );
      } 
      
      // 3️⃣ If not exists → INSERT
      else {
        db.query(
          "INSERT INTO media_files (file_path, alt_text) VALUES (?, ?)",
          [file_path, alt_text],
          (err) => {
            if (err) {
              return res.status(500).json({ message: "Insert failed" });
            }
            return res.json({ success: true, action: "inserted" });
          }
        );
      }
    }
  );
});

/* ─── GET ALT TEXT ───────────────────────────────────────────── */
router.get("/alt", (req, res) => {
  const { file_path } = req.query;

  if (!file_path) {
    return res.status(400).json({ message: "Missing file path" });
  }

  db.query(
    "SELECT alt_text FROM media_files WHERE file_path = ? LIMIT 1",
    [file_path],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ message: "DB error" });
      }

      if (!rows.length) {
        return res.json({ alt_text: "" }); // no record → empty alt
      }

      res.json({ alt_text: rows[0].alt_text || "" });
    }
  );
});



module.exports = router;