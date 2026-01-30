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

  if (!product_id || !format)
    return res.status(400).json({ msg: "Invalid data" });

  const qty = format === "ebook" ? 1 : Math.max(quantity || 1, 1);

  const sql = `
    INSERT INTO cart (user_id, product_id, format, quantity)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      quantity = IF(format='ebook', 1, quantity + VALUES(quantity))
  `;

  db.query(sql, [user_id, product_id, format, qty], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ msg: "Added to cart" });
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
      CASE 
        WHEN c.format = 'ebook' THEN e.sell_price
        ELSE p.sell_price
      END AS price
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

  db.query(
    "UPDATE cart SET quantity=? WHERE id=? AND format='paperback'",
    [quantity, req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ msg: "Updated" });
    }
  );
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
    "SELECT SUM(quantity) AS count FROM cart WHERE user_id=?",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ count: 0 });
      res.json({ count: rows[0].count || 0 });
    }
  );
});


/* 🔥 THIS WAS MISSING */
module.exports = router;
