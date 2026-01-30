const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

/* ================= AUTH MIDDLEWARE ================= */

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token)
    return res.status(401).json({ msg: "No token" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err)
      return res.status(401).json({ msg: "Invalid token" });

    req.user = decoded;
    next();
  });
};

/* ================= TOGGLE WISHLIST ================= */
/* POST /api/wishlist/:productId */

router.post("/:productId", auth, (req, res) => {
  const { productId } = req.params;

  db.query(
    "SELECT 1 FROM wishlist WHERE user_id=? AND product_id=?",
    [req.user.id, productId],
    (err, rows) => {
      if (err) return res.status(500).json(err);

      if (rows.length) {
        db.query(
          "DELETE FROM wishlist WHERE user_id=? AND product_id=?",
          [req.user.id, productId],
          () => res.json({ status: "removed" })
        );
      } else {
        db.query(
          "INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)",
          [req.user.id, productId],
          () => res.json({ status: "added" })
        );
      }
    }
  );
});

/* ================= GET MY WISHLIST ================= */
/* GET /api/wishlist/my */

router.get("/my", auth, (req, res) => {
  db.query(
    `SELECT 
        p.id, 
        p.title, 
        p.slug, 
        p.sell_price, 
        p.main_image
     FROM wishlist w
     JOIN products p ON p.id = w.product_id
     WHERE w.user_id = ?`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

/* ================= REMOVE ITEM ================= */
/* DELETE /api/wishlist/remove/:productId */

router.delete("/remove/:productId", auth, (req, res) => {
  db.query(
    "DELETE FROM wishlist WHERE user_id=? AND product_id=?",
    [req.user.id, req.params.productId],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ msg: "Removed" });
    }
  );
});

/* ================= CHECK ITEM ================= */
/* GET /api/wishlist/check/:productId */

router.get("/check/:productId", auth, (req, res) => {
  db.query(
    "SELECT 1 FROM wishlist WHERE user_id=? AND product_id=?",
    [req.user.id, req.params.productId],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json({ liked: rows.length > 0 });
    }
  );
});

module.exports = router;
