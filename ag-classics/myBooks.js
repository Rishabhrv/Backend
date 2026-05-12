const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const SECRET = "MY_SECRET_KEY";

/* 🔐 AUTH */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ===============================================
   1️⃣  MY EBOOKS  (agclassics only)
=============================================== */
router.get("/", auth, (req, res) => {
  const sql = `
    SELECT DISTINCT
      p.id          AS product_id,
      p.title,
      p.slug,
      p.main_image,
      oi.price,
      o.created_at  AS purchased_at
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p     ON p.id = oi.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE o.user_id          = ?
      AND o.payment_status   = 'success'
      AND oi.format          = 'ebook'
      AND cat.imprint        = 'agclassics'   -- ✅ agclassics only
      AND cat.status         = 'active'
      AND p.status           = 'published'
    ORDER BY o.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

/* ===============================================
   2️⃣  READ EPUB  (agclassics only)
=============================================== */
router.get("/:slug/read", auth, (req, res) => {
  const { slug } = req.params;
  const user_id = req.user.id;

  const sql = `
    SELECT e.file_path
    FROM ebooks e
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE p.slug        = ?
      AND cat.imprint   = 'agclassics'        -- ✅ agclassics only
      AND cat.status    = 'active'
      AND p.status      = 'published'
      AND (
        /* 🛒 PURCHASED */
        EXISTS (
          SELECT 1
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.user_id          = ?
            AND o.payment_status   = 'success'
            AND oi.product_id      = p.id
            AND oi.format          = 'ebook'
        )
        OR
        /* 📚 SUBSCRIPTION */
        EXISTS (
          SELECT 1
          FROM user_subscription_access usa
          WHERE usa.user_id    = ?
            AND usa.status     = 'active'
            AND usa.expires_at >= CURDATE()
        )
      )
    LIMIT 1
  `;

  db.query(sql, [slug, user_id, user_id], (err, rows) => {
    if (err || !rows.length) {
      return res.status(403).json({ msg: "Access denied" });
    }

    const epubPath = path.join(__dirname, "..", rows[0].file_path);

    if (!fs.existsSync(epubPath)) {
      return res.status(404).json({ msg: "EPUB file not found" });
    }

    res.setHeader("Content-Type", "application/epub+zip");
    res.sendFile(epubPath);
  });
});

/* ===============================================
   3️⃣  BOOK META  (agclassics only)
=============================================== */
router.get("/:slug/meta", auth, (req, res) => {
  const user_id = req.user.id;
  const { slug } = req.params;

  const sql = `
    SELECT p.title, p.main_image, e.ebook_cover
    FROM products p
    LEFT JOIN ebooks e ON e.product_id = p.id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
      AND cat.status  = 'active'
      AND p.status    = 'published'
      AND (
        EXISTS (
          SELECT 1
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.user_id          = ?
            AND o.payment_status   = 'success'
            AND oi.product_id      = p.id
            AND oi.format          = 'ebook'
        )
        OR EXISTS (
          SELECT 1
          FROM user_subscription_access usa
          WHERE usa.user_id    = ?
            AND usa.status     = 'active'
            AND usa.expires_at >= CURDATE()
        )
      )
    LIMIT 1
  `;

  // Three parameters: slug, user_id (for purchases), user_id (for subscription)
  db.query(sql, [slug, user_id, user_id], (err, rows) => {
    if (err || !rows.length) {
      return res.status(403).json({ msg: "Access denied" });
    }
    res.json(rows[0]); // ✅ Now returns BOTH main_image and ebook_cover
  });
});

/* ===============================================
   4️⃣  SAVE READING PROGRESS
=============================================== */
router.post("/:slug/progress", auth, (req, res) => {
  const { cfi } = req.body;
  const user_id = req.user.id;
  const { slug } = req.params;

  const sql = `
    INSERT INTO ebook_progress (user_id, ebook_id, last_cfi)
    SELECT ?, e.id, ?
    FROM ebooks e
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
    LIMIT 1
    ON DUPLICATE KEY UPDATE
      last_cfi   = VALUES(last_cfi),
      updated_at = CURRENT_TIMESTAMP
  `;

  db.query(sql, [user_id, cfi, slug], (err) => {
    if (err) return res.status(500).json({ msg: "Failed" });
    res.json({ success: true });
  });
});


/* ===============================================
   5️⃣  CONTINUE READING  (agclassics only)
=============================================== */
router.get("/continue", auth, (req, res) => {
  const sql = `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.main_image,
      ep.last_cfi,
      ep.updated_at
    FROM ebook_progress ep
    JOIN ebooks e   ON e.id = ep.ebook_id
    JOIN products p ON p.id = e.product_id
    WHERE ep.user_id = ?
      AND p.status = 'published'
      -- ✅ Using EXISTS prevents duplicates without needing GROUP BY
      AND EXISTS (
          SELECT 1 
          FROM product_categories pc
          JOIN categories cat ON cat.id = pc.category_id
          WHERE pc.product_id = p.id
            AND cat.imprint = 'agclassics'
            AND cat.status = 'active'
      )
    ORDER BY ep.updated_at DESC
    LIMIT 10
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) {
      console.error("Continue Reading API Error:", err); // 👈 Always log the error for debugging!
      return res.status(500).json([]);
    }
    res.json(rows);
  });
});

/* ===============================================
   6️⃣  ADD BOOKMARK
=============================================== */
router.post("/:slug/bookmark", auth, (req, res) => {
  const { cfi, label, note } = req.body;
  const user_id = req.user.id;
  const { slug } = req.params;

  // Scope to agclassics products only
  const findSql = `
    SELECT e.id
    FROM ebooks e
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
    LIMIT 1
  `;

  db.query(findSql, [slug], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ msg: "DB error" });
    }
    if (!rows.length) return res.status(404).json({ msg: "Ebook not found" });

    const ebook_id = rows[0].id;

    const insertSql = `
      INSERT INTO ebook_bookmarks (user_id, ebook_id, cfi, label, note)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        label = VALUES(label),
        note  = VALUES(note)
    `;

    db.query(insertSql, [user_id, ebook_id, cfi, label, note], (err2) => {
      if (err2) {
        console.error(err2);
        return res.status(500).json({ msg: "Bookmark failed" });
      }
      res.json({ success: true });
    });
  });
});

/* ===============================================
   7️⃣  GET BOOKMARKS FOR A BOOK  (agclassics only)
=============================================== */
router.get("/:slug/bookmarks", auth, (req, res) => {
  const sql = `
    SELECT eb.id, eb.cfi, eb.label, eb.note
    FROM ebook_bookmarks eb
    JOIN ebooks e   ON e.id = eb.ebook_id
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE eb.user_id  = ?
      AND p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
    ORDER BY eb.created_at DESC
  `;

  db.query(sql, [req.user.id, req.params.slug], (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});

/* ===============================================
   8️⃣  DELETE BOOKMARK
=============================================== */
router.delete("/:slug/bookmark", auth, (req, res) => {
  const { cfi } = req.body;

  const sql = `
    DELETE eb
    FROM ebook_bookmarks eb
    JOIN ebooks e   ON e.id = eb.ebook_id
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE eb.user_id  = ?
      AND eb.cfi      = ?
      AND p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
  `;

  db.query(sql, [req.user.id, cfi, req.params.slug], (err) => {
    if (err) return res.status(500).json({ msg: "Failed" });
    res.json({ success: true });
  });
});

/* ===============================================
   9️⃣  ALL BOOKMARKS (agclassics only)
=============================================== */
router.get("/bookmarks/all", auth, (req, res) => {
  const sql = `
    SELECT
      p.title,
      p.slug,
      eb.cfi,
      eb.label,
      eb.created_at
    FROM ebook_bookmarks eb
    JOIN ebooks e   ON e.id = eb.ebook_id
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE eb.user_id  = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
      AND cat.status  = 'active'
    ORDER BY eb.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});

/* ===============================================
   🔟  ALL FAVORITES  (agclassics only)
=============================================== */
router.get("/favorites", auth, (req, res) => {
  const sql = `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.main_image
    FROM ebook_favorites ef
    JOIN ebooks e   ON e.id = ef.ebook_id
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE ef.user_id  = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
      AND cat.status  = 'active'
      AND p.status    = 'published'
    GROUP BY p.id
    ORDER BY ef.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});

/* ===============================================
   1️⃣1️⃣  CHECK FAVORITE  (agclassics only)
=============================================== */
router.get("/:slug/favorite", auth, (req, res) => {
  const sql = `
    SELECT 1
    FROM ebook_favorites ef
    JOIN ebooks e   ON e.id = ef.ebook_id
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE ef.user_id  = ?
      AND p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
    LIMIT 1
  `;

  db.query(sql, [req.user.id, req.params.slug], (err, rows) => {
    res.json({ favorite: rows?.length > 0 });
  });
});

/* ===============================================
   1️⃣2️⃣  ADD FAVORITE  (agclassics only)
=============================================== */
router.post("/:slug/favorite", auth, (req, res) => {
  const sql = `
    INSERT IGNORE INTO ebook_favorites (user_id, ebook_id)
    SELECT ?, e.id
    FROM ebooks e
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
    LIMIT 1
  `;

  db.query(sql, [req.user.id, req.params.slug], (err) => {
    if (err) return res.status(500).json({ msg: "Failed" });
    res.json({ status: "added" });
  });
});

/* ===============================================
   1️⃣3️⃣  REMOVE FAVORITE  (agclassics only)
=============================================== */
router.delete("/:slug/favorite", auth, (req, res) => {
  const sql = `
    DELETE ef
    FROM ebook_favorites ef
    JOIN ebooks e   ON e.id = ef.ebook_id
    JOIN products p ON p.id = e.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id
    WHERE ef.user_id  = ?
      AND p.slug      = ?
      AND cat.imprint = 'agclassics'          -- ✅ agclassics only
  `;

  db.query(sql, [req.user.id, req.params.slug], (err) => {
    if (err) return res.status(500).json({ msg: "Failed" });
    res.json({ status: "removed" });
  });
});

module.exports = router;