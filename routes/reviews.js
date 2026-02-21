const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SECRET = "MY_SECRET_KEY";

const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/reviews/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage });


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

/* ================= GET APPROVED REVIEWS ================= */
router.get("/product/:productId", (req, res) => {
  const { productId } = req.params;

  const sql = `
    SELECT 
      r.id,
      r.rating,
      r.comment,
      r.created_at,
      u.name AS user_name
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ?
      AND r.status = 'approved'
    ORDER BY r.created_at DESC
  `;

  db.query(sql, [productId], (err, reviews) => {
    if (err) return res.status(500).json([]);

    if (reviews.length === 0) return res.json([]);

    const reviewIds = reviews.map(r => r.id);

    db.query(
      `SELECT review_id, image_path 
       FROM review_images 
       WHERE review_id IN (?)`,
      [reviewIds],
      (err2, images) => {
        if (err2) return res.json(reviews);

        const grouped = {};
        images.forEach(img => {
          if (!grouped[img.review_id]) grouped[img.review_id] = [];
          grouped[img.review_id].push(img.image_path);
        });

        const finalData = reviews.map(r => ({
          ...r,
          images: grouped[r.id] || []
        }));

        res.json(finalData);
      }
    );
  });
});


/* ================= ADD / UPDATE REVIEW ================= */
router.post("/", auth, upload.array("images", 5), (req, res) => {
  const { product_id, rating, comment } = req.body;
  const user_id = req.user.id;

  if (!rating || !comment) {
    return res.status(400).json({ message: "Invalid data" });
  }

  const insertReview = `
    INSERT INTO reviews (product_id, user_id, rating, comment, status)
    VALUES (?, ?, ?, ?, 'pending')
    ON DUPLICATE KEY UPDATE
      rating = VALUES(rating),
      comment = VALUES(comment),
      status = 'pending',
      created_at = CURRENT_TIMESTAMP
  `;

  db.query(
    insertReview,
    [product_id, user_id, rating, comment],
    (err, result) => {
      if (err) return res.status(500).json({ message: "Failed" });

      const reviewId = result.insertId || result.insertId;

      // Save images if uploaded
      if (req.files && req.files.length > 0) {
        const imageValues = req.files.map(file => [
          reviewId,
          "/uploads/reviews/" + file.filename
        ]);

        db.query(
          "INSERT INTO review_images (review_id, image_path) VALUES ?",
          [imageValues],
          () => {
            res.json({
              message: "Review submitted with images",
              status: "pending"
            });
          }
        );
      } else {
        res.json({
          message: "Review submitted",
          status: "pending"
        });
      }
    }
  );
});

router.get("/latest", (req, res) => {

  const sql = `
    SELECT 
      r.id,
      r.rating,
      r.comment,
      r.created_at,
      r.product_id,
      u.name AS user_name,
      p.title AS product_title,
      p.main_image AS product_image
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    JOIN products p ON p.id = r.product_id
    WHERE r.status = 'approved'
    ORDER BY r.created_at DESC
    LIMIT 5
  `;

  db.query(sql, (err, reviews) => {
    if (err) return res.status(500).json([]);

    if (reviews.length === 0) return res.json([]);

    const reviewIds = reviews.map(r => r.id);

    db.query(
      `SELECT review_id, image_path 
       FROM review_images 
       WHERE review_id IN (?)`,
      [reviewIds],
      (err2, images) => {
        if (err2) return res.json(reviews);

        const grouped = {};
        images.forEach(img => {
          if (!grouped[img.review_id]) grouped[img.review_id] = [];
          grouped[img.review_id].push(img.image_path);
        });

        const finalData = reviews.map(r => ({
          ...r,
          images: grouped[r.id] || []
        }));

        res.json(finalData);
      }
    );
  });
});


module.exports = router;
