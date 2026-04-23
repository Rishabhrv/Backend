// routes/adminPermissions.js
const express = require("express");
const router  = express.Router();
const db      = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

const ALL_PAGES = [
  "products", "orders", "category", "subject",
  "author", "users", "reviews", "shipping",
  "subscriptions", "payment", "coupons", "ads",
];

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ msg: "Admin only" });
    }
    req.user = decoded; // ✅ makes req.user.id available downstream
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* =====================================================
   GET /api/admin/permissions/my-permissions
   Returns the pages the currently logged-in admin
   is allowed to access. Super admin (id=1) gets all.
===================================================== */
router.get("/my-permissions", adminAuth, (req, res) => {
  const userId = req.user.id;

  // Super admin → return everything immediately
  if (userId === 1) {
    return res.json({ pages: ALL_PAGES, isSuperAdmin: true });
  }

  db.query(
    "SELECT page_key FROM admin_permissions WHERE admin_user_id = ?",
    [userId],
    (err, rows) => {
      if (err) {
        console.error("my-permissions error:", err);
        return res.status(500).json({ msg: "DB error" });
      }

      res.json({
        pages: rows.map((r) => r.page_key),
        isSuperAdmin: false,
      });
    }
  );
});

/* =====================================================
   GET /api/admin/permissions/user/:userId
   Super admin reads another admin's permissions.
===================================================== */
router.get("/user/:userId", adminAuth, (req, res) => {
  // Only super admin can read others' permissions
  if (req.user.id !== 1) {
    return res.status(403).json({ msg: "Super admin only" });
  }

  // Extract from URL params instead of query
  const userId = req.params.userId; 

  if (!userId) return res.status(400).json({ msg: "userId is required" });

  db.query(
    "SELECT page_key FROM admin_permissions WHERE admin_user_id = ?",
    [Number(userId)], // Cast to Number to prevent DB type conflicts
    (err, rows) => {
      if (err) {
        console.error("get permissions error:", err);
        return res.status(500).json({ msg: "DB error" });
      }
      res.json({ pages: rows.map((r) => r.page_key) });
    }
  );
});

/* =====================================================
   POST /api/admin/permissions
   Super admin sets (replaces) another admin's pages.

   Body: { userId: number, pages: string[] }
===================================================== */
router.post("/", adminAuth, async (req, res) => {
  if (req.user.id !== 1) {
    return res.status(403).json({ msg: "Super admin only" });
  }

  const { userId, pages } = req.body;

  if (!userId || !Array.isArray(pages)) {
    return res.status(400).json({ msg: "userId and pages[] required" });
  }

  // Reject unknown page keys silently (only keep valid ones)
  const valid = pages.filter((p) => ALL_PAGES.includes(p));

  // Cannot edit super admin's permissions
  if (Number(userId) === 1) {
    return res.status(400).json({ msg: "Cannot restrict super admin" });
  }

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Wipe existing permissions for this admin
    await conn.query(
      "DELETE FROM admin_permissions WHERE admin_user_id = ?",
      [userId]
    );

    // Insert the new set (if any)
    if (valid.length > 0) {
      const values = valid.map((p) => [userId, p]);
      await conn.query(
        "INSERT INTO admin_permissions (admin_user_id, page_key) VALUES ?",
        [values]
      );
    }

    await conn.commit();
    res.json({ success: true, userId, pages: valid });
  } catch (err) {
    await conn.rollback();
    console.error("set permissions error:", err);
    res.status(500).json({ msg: "DB error" });
  } finally {
    conn.release();
  }
});

/* =====================================================
   GET /api/admin/permissions/all-admins
   Super admin fetches list of all admin users with
   their current permission sets (for a management UI).
===================================================== */
router.get("/all-admins", adminAuth, (req, res) => {
  if (req.user.id !== 1) {
    return res.status(403).json({ msg: "Super admin only" });
  }

  const sql = `
    SELECT
      u.id,
      u.name,
      u.email,
      u.status,
      GROUP_CONCAT(ap.page_key ORDER BY ap.page_key SEPARATOR ',') AS pages
    FROM users u
    LEFT JOIN admin_permissions ap ON ap.admin_user_id = u.id
    WHERE u.role = 'admin' AND u.id != 1
    GROUP BY u.id, u.name, u.email, u.status
    ORDER BY u.name ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("all-admins error:", err);
      return res.status(500).json({ msg: "DB error" });
    }

    res.json(
      rows.map((r) => ({
        ...r,
        pages: r.pages ? r.pages.split(",") : [],
      }))
    );
  });
});

module.exports = router;