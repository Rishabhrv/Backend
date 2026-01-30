const express = require("express");
const router = express.Router();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const db = require("../db");
const jwt = require("jsonwebtoken");

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

/* 🔑 RAZORPAY INSTANCE */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});



/* ================= CREATE RAZORPAY ORDER ================= */
router.post("/create-order", auth, (req, res) => {
  const { order_id } = req.body;

  db.query(
    "SELECT total_amount FROM orders WHERE id=? AND user_id=?",
    [order_id, req.user.id],
    (err, rows) => {
      if (err || !rows.length)
        return res.status(400).json({ msg: "Invalid order" });

      const amount = rows[0].total_amount;

      const options = {
        amount: Math.round(amount * 100),
        currency: "INR",
        receipt: "receipt_" + order_id,
      };

      razorpay.orders.create(options, (err, order) => {
        if (err) return res.status(500).json(err);

        db.query(
          "UPDATE orders SET razorpay_order_id=? WHERE id=?",
          [order.id, order_id],
          () => res.json(order)
        );
      });
    }
  );
});



/* ================= VERIFY PAYMENT ================= */
router.post("/verify", auth, (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    order_id,
  } = req.body;

  const body = razorpay_order_id + "|" + razorpay_payment_id;

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ msg: "Invalid signature" });
  }

  // ✅ SAVE PAYMENT ID + MARK PAID
  db.query(
    `UPDATE orders 
     SET payment_status='success',
         status='paid',
         razorpay_payment_id=?
     WHERE id=?`,
    [razorpay_payment_id, order_id],
    () => {
      db.query(
        "DELETE FROM cart WHERE user_id=?",
        [req.user.id],
        () => res.json({ msg: "Payment verified & order completed" })
      );
    }
  );
});




module.exports = router;
