const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");
const SECRET = "MY_SECRET_KEY"; // same secret as your other routes

/* ─── Admin Auth ─── */
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ msg: "Admin only" });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* ════════════════════════════════════════════════════════
   HELPER  — call this from your order / review /
             subscription routes to create a notification
════════════════════════════════════════════════════════ */
function createAdminNotification(type, title, message, refId = null) {
  db.query(
    `INSERT INTO admin_notifications (type, title, message, ref_id)
     VALUES (?, ?, ?, ?)`,
    [type, title, message, refId],
    (err) => {
      if (err) console.error("[Notification Error]", err.message);
    }
  );
}

/* ════════════════════════════════════════
   GET /api/admin/notifications
   All notifications, newest first
════════════════════════════════════════ */
router.get("/adminnotifications", adminAuth, (req, res) => {
  const limit  = parseInt(req.query.limit)  || 20;
  const offset = parseInt(req.query.offset) || 0;

  db.query(
    `SELECT * FROM admin_notifications
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      db.query(
        `SELECT COUNT(*) AS total FROM admin_notifications`,
        (err2, totalRows) => {
          if (err2) return res.status(500).json({ msg: "DB error" });

          db.query(
            `SELECT COUNT(*) AS unread FROM admin_notifications WHERE is_read = 0`,
            (err3, unreadRows) => {
              if (err3) return res.status(500).json({ msg: "DB error" });

              res.json({
                notifications : rows,
                total         : totalRows[0].total,
                unread        : unreadRows[0].unread,
              });
            }
          );
        }
      );
    }
  );
});

/* ════════════════════════════════════════
   GET /api/admin/notifications/unread-count
   Lightweight poll endpoint
════════════════════════════════════════ */
router.get("/adminnotifications/unread-count", adminAuth, (req, res) => {
  db.query(
    `SELECT COUNT(*) AS unread FROM admin_notifications WHERE is_read = 0`,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json({ unread: rows[0].unread });
    }
  );
});

/* ════════════════════════════════════════
   PATCH /api/admin/notifications/mark-all-read
   NOTE: must be defined BEFORE /:id routes
════════════════════════════════════════ */
router.delete("/adminnotifications/mark-all-read", adminAuth, (req, res) => {
  db.query(
    `DELETE FROM admin_notifications`,
    (err) => {
      if (err) return res.status(500).json({ msg: "Delete failed" });
      res.json({ msg: "All notifications deleted" });
    }
  );
});

/* ════════════════════════════════════════
   PATCH /api/admin/notifications/:id/read
   Mark a single notification as read
════════════════════════════════════════ */
router.patch("/adminnotifications/:id/read", adminAuth, (req, res) => {
  db.query(
    `UPDATE admin_notifications SET is_read = 1 WHERE id = ?`,
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "Update failed" });
      res.json({ msg: "Notification marked as read" });
    }
  );
});

/* ════════════════════════════════════════
   DELETE /api/admin/notifications/:id
════════════════════════════════════════ */
router.delete("/adminnotifications/:id", adminAuth, (req, res) => {
  db.query(
    `DELETE FROM admin_notifications WHERE id = ?`,
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json({ msg: "Delete failed" });
      res.json({ msg: "Notification deleted" });
    }
  );
});


module.exports = { router, createAdminNotification };


/* ══════════════════════════════════════════════════════════════════
   HOW TO WIRE THIS UP
   ══════════════════════════════════════════════════════════════════

   1. In your main app.js / server.js:

        const { router: notifRouter } = require("./routes/notificationRoutes");
        app.use("/api/admin", notifRouter);


   2. In your ORDER creation route, after the INSERT succeeds:

        const { createAdminNotification } = require("./routes/notificationRoutes");

        createAdminNotification(
          "order",
          "New Order Received",
          `Order #${orderId} placed by ${userEmail} — Rs.${totalAmount}`,
          orderId
        );


   3. In your REVIEW creation route, after the INSERT succeeds:

        createAdminNotification(
          "review",
          "New Review Submitted",
          `A review was submitted for "${productTitle}" and is pending approval.`,
          reviewId
        );


   4. In your SUBSCRIPTION creation route, after the INSERT succeeds:

        createAdminNotification(
          "subscription",
          "New Subscription Purchased",
          `${userName} subscribed to the ${planTitle} plan for Rs.${amountPaid}.`,
          subscriptionId
        );

══════════════════════════════════════════════════════════════════ */