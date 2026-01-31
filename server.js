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
app.use("/api/attributes", require("./routes/attributes"));
app.use("/api/authors", require("./routes/authors"));
app.use("/api/account", require("./routes/account"));
app.use("/api/search", require("./routes/search"));
app.use("/api/wishlist", require("./routes/wishlist"));
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/cart", require("./routes/cart"));
app.use("/api/checkout", require("./routes/checkout"));
app.use("/api/payment", require("./routes/payment"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/my-books", require("./routes/myBooks"));
app.use("/api/subscription-payment", require("./routes/subscriptionpayment"));
app.use("/api/subscriptions", require("./routes/subscriptions"));

app.use("/api/admin", require("./routes/users"));
app.use("/api/admin", require("./routes/adminOrders"));

app.use("/api/mylibrary", require("./routes/mylibrary"));
app.use("/api/payment-history", require("./routes/payment-history"));


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
