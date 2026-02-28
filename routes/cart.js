const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* ================= AUTH ================= */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ================= ADD TO CART ================= */
router.post("/add", auth, (req, res) => {
  const { product_id, format, quantity } = req.body;
  const user_id = req.user.id;

  const productSql = `
    SELECT product_type, stock
    FROM products
    WHERE id = ?
  `;

  db.query(productSql, [product_id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length)
      return res.status(404).json({ msg: "Product not found" });

    const { product_type, stock } = rows[0];

    let finalFormat;
    let finalQty;

    // ✅ EBOOK ONLY
    if (product_type === "ebook") {
      finalFormat = "ebook";
      finalQty = 1;
    }

    // ✅ PHYSICAL ONLY
    else if (product_type === "physical") {
      if (stock <= 0) {
        return res.status(400).json({ msg: "OUT_OF_STOCK" });
      }
      finalFormat = "paperback";
      finalQty = Math.min(quantity || 1, stock);
    }

    // ✅ BOTH
    else if (product_type === "both") {
      if (format === "ebook") {
        finalFormat = "ebook";
        finalQty = 1;
      } else {
        if (stock <= 0) {
          return res.status(400).json({ msg: "OUT_OF_STOCK" });
        }
        finalFormat = "paperback";
        finalQty = Math.min(quantity || 1, stock);
      }
    }

    const sql = `
      INSERT INTO cart (user_id, product_id, format, quantity)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        quantity = IF(
          format='ebook',
          1,
          LEAST(quantity + VALUES(quantity), ?)
        )
    `;

    db.query(
      sql,
      [user_id, product_id, finalFormat, finalQty, stock],
      (err) => {
        if (err) return res.status(500).json(err);
        res.json({ msg: "Added", format: finalFormat });
      }
    );
  });
});


/* ================= GET MY CART ================= */
router.get("/my", auth, (req, res) => {
  const sql = `
    SELECT 
      c.id,
      c.product_id,
      c.format,
      c.quantity,
      p.title,
      p.slug,
      p.main_image,
      p.stock,
      CASE 
        WHEN c.format = 'ebook' THEN e.sell_price
        ELSE p.sell_price
      END AS price,
      (
        SELECT GROUP_CONCAT(DISTINCT cat.imprint)
        FROM product_categories pc
        JOIN categories cat ON cat.id = pc.category_id
        WHERE pc.product_id = p.id
      ) AS category_imprints
    FROM cart c
    JOIN products p ON p.id = c.product_id
    LEFT JOIN ebooks e ON e.product_id = p.id
    WHERE c.user_id = ?
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

/* ================= UPDATE QUANTITY ================= */
router.put("/update/:id", auth, (req, res) => {
  const { quantity } = req.body;
  const cartId = req.params.id;

  const sql = `
    UPDATE cart c
    JOIN products p ON p.id = c.product_id
    SET c.quantity = LEAST(?, p.stock)
    WHERE c.id = ? AND c.format = 'paperback'
  `;

  db.query(sql, [quantity, cartId], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json({ msg: "Updated" });
  });
});


/* ================= REMOVE ITEM ================= */
router.delete("/remove/:id", auth, (req, res) => {
  db.query(
    "DELETE FROM cart WHERE id=? AND user_id=?",
    [req.params.id, req.user.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ msg: "Removed" });
    }
  );
});

router.get("/count", auth, (req, res) => {
  db.query(
    `SELECT SUM(c.quantity) AS count 
    FROM cart c
    JOIN product_categories pc ON pc.product_id = c.product_id
    JOIN categories cat ON cat.id = pc.category_id AND cat.imprint = 'agph'
    WHERE c.user_id = ?`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ count: 0 });
      res.json({ count: rows[0].count || 0 });
    }
  );
});


/* 🔥 THIS WAS MISSING */
module.exports = router;
