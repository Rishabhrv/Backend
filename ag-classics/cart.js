const express = require("express");
const router  = express.Router();
const db      = require("../db");
const jwt     = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ── GET CART ── */
router.get("/", auth, (req, res) => {
  const sql = `
    SELECT
      c.id,
      c.product_id,
      c.format,
      c.quantity,
      p.title,
      p.slug,
      p.main_image,
      p.price,
      p.sell_price,
      p.stock,
      p.product_type,

      -- Ebook-specific pricing (lowest across pdf/epub variants)
      MIN(e.price)      AS ebook_price,
      MIN(e.sell_price) AS ebook_sell_price

    FROM cart c
    JOIN products p ON p.id = c.product_id
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories cat ON cat.id = pc.category_id

    LEFT JOIN ebooks e ON e.product_id = p.id

    WHERE c.user_id = ?
      AND cat.imprint = 'agclassics'

    GROUP BY c.id
    ORDER BY c.created_at DESC
  `;

  db.query(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json(err);

    const cart = rows.map((r) => ({
      ...r,
      ebook_price:      r.ebook_price      ? parseFloat(r.ebook_price)      : null,
      ebook_sell_price: r.ebook_sell_price  ? parseFloat(r.ebook_sell_price) : null,
    }));

    res.json({ success: true, cart });
  });
});

/* ── ADD TO CART ── */
router.post("/", auth, (req, res) => {
  const { product_id, format = "paperback", quantity = 1 } = req.body;
  if (!product_id) return res.status(400).json({ success: false, message: "product_id required" });

  /* 1️⃣ Validate product exists and belongs to agclassics imprint */
  db.query(
    `SELECT p.id, p.stock
     FROM products p
     JOIN product_categories pc ON pc.product_id = p.id
     JOIN categories c ON c.id = pc.category_id
     WHERE p.id = ? AND p.status = 'published' AND c.imprint = 'agclassics'`,
    [product_id],
    (err, rows) => {
      if (err) return res.status(500).json(err);

      const product = rows[0];
      if (!product) return res.status(404).json({ success: false, message: "Product not found" });

      /* Stock check — paperback only */
      if (format === "paperback" && product.stock === 0)
        return res.status(400).json({ success: false, message: "Out of stock" });

      /* 2️⃣ Check if the SAME product + format already exists in this user's cart */
      db.query(
        `SELECT id FROM cart
         WHERE user_id = ? AND product_id = ? AND format = ?`,
        [req.user.id, product_id, format],
        (err, existing) => {
          if (err) return res.status(500).json(err);

          /* Already in cart — return a clear flag so the frontend can react */
          if (existing.length > 0) {
            return res.status(409).json({
              success:         false,
              already_in_cart: true,
              message:         format === "ebook"
                ? "This eBook is already in your cart"
                : "This paperback is already in your cart",
            });
          }

          /* 3️⃣ Not in cart yet — insert fresh row */
          db.query(
            `INSERT INTO cart (user_id, product_id, format, quantity)
             VALUES (?, ?, ?, ?)`,
            [req.user.id, product_id, format, quantity],
            (err) => {
              if (err) return res.status(500).json(err);

              /* Return updated cart count */
              db.query(
                `SELECT COUNT(*) AS count FROM cart WHERE user_id = ?`,
                [req.user.id],
                (err, countRows) => {
                  if (err) return res.status(500).json(err);
                  res.json({
                    success:    true,
                    message:    "Added to cart",
                    cart_count: countRows[0].count,
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

/* ── UPDATE QUANTITY ── */
router.patch("/:id", auth, (req, res) => {
  const { quantity } = req.body;
  if (!quantity || quantity < 1) return res.status(400).json({ message: "Invalid quantity" });

  db.query(
    "UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?",
    [quantity, req.params.id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      if (result.affectedRows === 0) return res.status(404).json({ message: "Cart item not found" });
      res.json({ success: true, message: "Cart updated" });
    }
  );
});

/* ── DELETE ITEM ── */
router.delete("/:id", auth, (req, res) => {
  db.query(
    "DELETE FROM cart WHERE id = ? AND user_id = ?",
    [req.params.id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      if (result.affectedRows === 0) return res.status(404).json({ message: "Cart item not found" });
      res.json({ success: true, message: "Item removed" });
    }
  );
});

/* ── CLEAR CART ── */
router.delete("/", auth, (req, res) => {
  db.query("DELETE FROM cart WHERE user_id = ?", [req.user.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true, message: "Cart cleared" });
  });
});

module.exports = router;