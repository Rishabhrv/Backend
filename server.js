require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

/* ROUTES */
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/adminAuth"));
app.use("/api/categories", require("./routes/categories")); 
app.use("/api/viewcategory", require("./routes/viewcategory")); 
app.use("/api/products", require("./routes/products"));
app.use("/uploads", express.static("uploads"));
app.use("/api/media", require("./routes/media"));
app.use("/api/attributes", require("./routes/attributes"));
app.use("/api/authors", require("./routes/authors"));
app.use("/api/account", require("./routes/account"));
app.use("/api/search", require("./routes/search"));
app.use("/api/wishlist", require("./routes/wishlist"));
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/cart", require("./routes/cart"));
app.use("/api/checkout", require("./routes/checkout"));
app.use("/api/payment", require("./routes/payment"));
app.use("/api/ebooks", require("./routes/ebooks"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/my-books", require("./routes/myBooks"));
app.use("/api/subscription-payment", require("./routes/subscriptionpayment"));
app.use("/api/subscriptions", require("./routes/subscriptions"));
app.use("/api/seo", require("./routes/seoroutes"));
app.use("/api/admin", require("./routes/adminnotifications").router);
app.use("/api/admin", require("./routes/adminEbooks"));
app.use("/api/admin", require("./routes/adminReviews"));
app.use("/api/admin", require("./routes/users"));
app.use("/api/admin", require("./routes/adminOrders"));
app.use("/api/admin", require("./routes/adminSubscriptions"));
app.use("/api/admin", require("./routes/adminCoupons"));
app.use("/api/admin", require("./routes/adminPayments"));
app.use("/api/subjects", require("./routes/subjects"));
app.use("/api/mylibrary", require("./routes/mylibrary"));
app.use("/api/payment-history", require("./routes/payment-history"));
app.use("/api/coupons", require("./routes/coupons"))
app.use("/api/order-confirmed", require("./routes/order-confirmed"));
app.use('/api/invoice', require('./routes/invoice'));
app.use("/api/shipping", require("./routes/shipping"));
app.use("/api/stock-notifications", require("./routes/stockNotifications"));

// AG Classics
app.use('/api/ag-classics/invoice', require('./ag-classics/invoice'));
app.use("/api/ag-classics/authors", require("./ag-classics/authors"));
app.use("/api/ag-classics/my-books", require("./ag-classics/myBooks"));
app.use("/api/ag-classics/orders", require("./ag-classics/orders"));
app.use("/api/ag-classics/bestseller", require("./ag-classics/bestseller"));
app.use("/api/ag-classics/products", require("./ag-classics/products"));
app.use("/api/ag-classics/ebooks", require("./ag-classics/ebooks"));
app.use("/api/ag-classics/viewcategory", require("./ag-classics/viewcategory")); 
app.use("/api/ag-classics/search", require("./ag-classics/search"));
app.use("/api/ag-classics/checkout", require("./ag-classics/checkout"));
app.use("/api/ag-classics/coupons",  require("./ag-classics/checkout"));
app.use("/api/ag-classics/cart", require("./ag-classics/cart"));
app.use("/api/ag-classics/wishlist", require("./ag-classics/wishlist"));
app.use("/api/ag-classics", require("./ag-classics/agclassic"));



// GLOBAL ERROR HANDLER (LAST MIDDLEWARE)
app.use((err, req, res, next) => {
  console.error("🔥 GLOBAL ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    message: "Something went wrong. Please try again later.",
  });
});


process.on("uncaughtException", (err) => {
  console.error("💥 UNCAUGHT EXCEPTION:", err);
  // DO NOT exit in production
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 UNHANDLED PROMISE REJECTION:", reason);
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
