const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* ============================
   🔐 INLINE AUTH (JWT)
============================ */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ============================
   🔒 SUBSCRIPTION CHECK
============================ */
const checkSubscription = (req, res, next) => {
  const user_id = req.user.id;

  db.query(
    `SELECT *
     FROM user_subscription_access
     WHERE user_id=?
       AND status='active'
       AND expires_at >= CURDATE()
     LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err || rows.length === 0) {
        return res.status(403).json({
          msg: "Subscription required",
        });
      }

      next();
    }
  );
};

router.get("/category/:slug", auth, (req, res) => {
  const { slug } = req.params;

  db.query(
    `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.main_image
    FROM categories c
    JOIN product_categories pc ON pc.category_id = c.id
    JOIN products p ON p.id = pc.product_id
    WHERE
      c.slug = ?
      AND c.status = 'active'
      AND p.status = 'published'
      AND p.product_type IN ('ebook','both')
    ORDER BY p.created_at DESC
    `,
    [slug],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json([]);
      }
      res.json(rows);
    }
  );
});


/* ==================================================
   1️⃣ GET USER INFO (FOR HEADER)
================================================== */
router.get("/me", auth, checkSubscription, (req, res) => {
  const user_id = req.user.id;

  db.query(
    `SELECT id, name, email
     FROM users
     WHERE id=? LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err || !rows.length) {
        return res.status(404).json({ msg: "User not found" });
      }

      res.json(rows[0]);
    }
  );
});

// routes/mylibrary.js
router.get("/categories", auth, (req, res) => {
  db.query(
    `
    SELECT DISTINCT c.id, c.name, c.slug
    FROM categories c
    JOIN product_categories pc ON pc.category_id = c.id
    JOIN products p ON p.id = pc.product_id
    WHERE
      c.status = 'active'
      AND p.status = 'published'
      AND p.product_type IN ('ebook','both')
    ORDER BY c.name
    `,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.json([]);
      }
      res.json(rows);
    }
  );
});


/* ============================
   📂 CATEGORY META
============================ */
router.get("/category/:slug/meta", auth, (req, res) => {
  db.query(
    `SELECT name FROM categories
     WHERE slug = ? AND status='active'
     LIMIT 1`,
    [req.params.slug],
    (err, rows) => {
      if (err || !rows.length) {
        return res.json({ name: "" });
      }
      res.json(rows[0]);
    }
  );
});



/* ==================================================
   2️⃣ GET USER LIBRARY (EBOOKS ONLY)
================================================== */
router.get("/books", auth, checkSubscription, (req, res) => {
  const user_id = req.user.id;

  /*
    LOGIC:
    - Only ebooks
    - Only published
    - Subscription gives access to ALL ebooks
  */
  db.query(
    `SELECT 
        p.id,
        p.title,
        p.slug,
        p.main_image,
        p.description
     FROM products p
     WHERE p.product_type IN ('ebook','both')
       AND p.status='published'
     ORDER BY p.created_at DESC`,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ msg: "DB error" });
      }

      res.json(rows);
    }
  );
});

/* ==================================================
   3️⃣ CHECK ACCESS (GUARD)
================================================== */
router.get("/check-access", auth, (req, res) => {
  const user_id = req.user.id;

  db.query(
    `SELECT *
     FROM user_subscription_access
     WHERE user_id=?
       AND status='active'
       AND expires_at >= CURDATE()
     LIMIT 1`,
    [user_id],
    (err, rows) => {
      if (err) return res.json({ access: false });

      res.json({
        access: rows.length > 0,
        expires_at: rows[0]?.expires_at || null,
      });
    }
  );
});


/* ==================================================
   🔍 SEARCH LIBRARY BOOKS
================================================== */
router.get("/search", auth, checkSubscription, (req, res) => {
  const q = req.query.q;

  if (!q) {
    return res.json([]);
  }

  db.query(
    `
    SELECT DISTINCT
      p.id,
      p.title,
      p.slug,
      p.main_image
    FROM products p
    LEFT JOIN product_categories pc ON pc.product_id = p.id
    LEFT JOIN categories c ON c.id = pc.category_id
    WHERE
      p.status = 'published'
      AND p.product_type IN ('ebook','both')
      AND (
        p.title LIKE ?
        OR p.description LIKE ?
        OR c.name LIKE ?
      )
    ORDER BY p.created_at DESC
    `,
    [`%${q}%`, `%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) {
        console.error("Search error:", err);
        return res.status(500).json([]);
      }

      res.json(rows);
    }
  );
});


module.exports = router;
