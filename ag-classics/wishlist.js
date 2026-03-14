// routes/wishlist.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* ================= AUTH ================= */
const auth = (req, res, next) => {

  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ msg: "No token" });
  }

  jwt.verify(token, SECRET, (err, decoded) => {

    if (err) {
      return res.status(401).json({ msg: "Invalid token" });
    }

    req.user = decoded;
    next();

  });

};


/* ================= GET WISHLIST ================= */
router.get("/", auth, (req, res) => {

  const sql = `
    SELECT 
      p.id,
      p.title,
      p.slug,
      p.main_image,
      p.price,
      p.sell_price,
      p.stock,
      p.product_type,
      p.created_at
    FROM wishlist w
    JOIN products p ON p.id = w.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE w.user_id = ?
    AND c.imprint = 'agclassics'
    ORDER BY p.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {

    if (err) return res.status(500).json(err);

    res.json({
      success: true,
      wishlist: rows
    });

  });

});


/* ================= GET WISHLIST IDS ================= */
router.get("/ids", auth, (req, res) => {

  db.query(
    `
    SELECT w.product_id
    FROM wishlist w
    JOIN product_categories pc ON pc.product_id = w.product_id
    JOIN categories c ON c.id = pc.category_id
    WHERE w.user_id = ?
    AND c.imprint = 'agclassics'
    `,
    [req.user.id],
    (err, rows) => {

      if (err) return res.status(500).json(err);

      const ids = rows.map(r => r.product_id);

      res.json({
        success: true,
        ids: ids
      });

    }
  );

});


/* ================= ADD TO WISHLIST ================= */
router.post("/", auth, (req, res) => {

  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({
      success: false,
      message: "product_id is required"
    });
  }

  db.query(
    "SELECT id FROM products WHERE id = ? AND status='published'",
    [product_id],
    (err, rows) => {

      if (err) return res.status(500).json(err);

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Product not found"
        });
      }

      db.query(
        "INSERT IGNORE INTO wishlist (user_id, product_id) VALUES (?, ?)",
        [req.user.id, product_id],
        (err) => {

          if (err) return res.status(500).json(err);

          db.query(
            "SELECT COUNT(*) AS count FROM wishlist WHERE user_id = ?",
            [req.user.id],
            (err, rows) => {

              if (err) return res.status(500).json(err);

              res.json({
                success: true,
                message: "Added to wishlist",
                wishlist_count: rows[0].count
              });

            }
          );

        }
      );

    }
  );

});


/* ================= REMOVE FROM WISHLIST ================= */
router.delete("/", auth, (req, res) => {

  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({
      success: false,
      message: "product_id is required"
    });
  }

  db.query(
    "DELETE FROM wishlist WHERE user_id = ? AND product_id = ?",
    [req.user.id, product_id],
    (err, result) => {

      if (err) return res.status(500).json(err);

      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Item not in wishlist"
        });
      }

      res.json({
        success: true,
        message: "Removed from wishlist"
      });

    }
  );

});

module.exports = router;