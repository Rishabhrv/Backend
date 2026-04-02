const express = require("express");
const router  = express.Router();
const db      = require("../db");
const jwt     = require("jsonwebtoken");
const path    = require("path");
const fs      = require("fs");
const multer  = require("multer");

const SECRET = process.env.JWT_SECRET || "MY_SECRET_KEY";

// ─── Admin auth ───────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ msg: "Admin only" });
    }
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

// ─── Multer ───────────────────────────────────────────────────────────────────
// Your server.js serves:  app.use("/uploads", express.static("uploads"))
// So files must go into  <project_root>/uploads/ads/
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "ads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPEG, PNG, GIF and WebP images are allowed"));
  },
});

// ─── Validation ───────────────────────────────────────────────────────────────
const VALID = {
  ad_type:         ["popup", "top_banner", "bottom_banner", "sidebar"],
  show_on:         ["all", "home", "category", "product"],
  target_imprint:  ["all", "agph", "agclassics"],
  link_target:     ["_self", "_blank"],
  popup_frequency: ["every_visit", "once_per_session", "once_ever"],
  status:          ["active", "inactive", "scheduled"],
};

function validateAd(body, isCreate = true) {
  const errors = [];
  if (isCreate && !body.title?.trim()) errors.push("title is required");
  if (body.ad_type         && !VALID.ad_type.includes(body.ad_type))
    errors.push(`ad_type must be one of: ${VALID.ad_type.join(", ")}`);
  if (body.show_on         && !VALID.show_on.includes(body.show_on))
    errors.push(`show_on must be one of: ${VALID.show_on.join(", ")}`);
  if (body.target_imprint  && !VALID.target_imprint.includes(body.target_imprint))
    errors.push(`target_imprint must be one of: ${VALID.target_imprint.join(", ")}`);
  if (body.link_target     && !VALID.link_target.includes(body.link_target))
    errors.push("link_target must be _self or _blank");
  if (body.popup_frequency && !VALID.popup_frequency.includes(body.popup_frequency))
    errors.push(`popup_frequency must be one of: ${VALID.popup_frequency.join(", ")}`);
  if (body.status          && !VALID.status.includes(body.status))
    errors.push(`status must be one of: ${VALID.status.join(", ")}`);
  if (body.status === "scheduled") {
    if (!body.start_date) errors.push("start_date is required when status is scheduled");
    if (!body.end_date)   errors.push("end_date is required when status is scheduled");
    if (body.start_date && body.end_date && body.start_date > body.end_date)
      errors.push("end_date must be after start_date");
  }
  return errors;
}


/* 🔐 POST /api/admin/ads/upload */
router.post("/ads/upload", adminAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ msg: "No file uploaded" });
  // Returns a URL the browser can load directly via the static /uploads mount
  const file_path = `/uploads/ads/${req.file.filename}`;
  return res.json({ file_path, original_name: req.file.originalname });
});

/* 🔐 POST /api/admin/ads */
router.post("/ads", adminAuth, (req, res) => {
  const errors = validateAd(req.body, true);
  if (errors.length) return res.status(422).json({ errors });

  const {
    title,
    ad_type,
    image_url           = null,
    alt_text            = null,
    link_url            = null,
    link_target         = "_blank",
    html_content        = null,
    popup_delay_seconds = 3,
    popup_frequency     = "once_per_session",
    show_on             = "all",
    target_imprint      = "all",
    start_date          = null,
    end_date            = null,
    priority            = 0,
    status              = "inactive",
  } = req.body;

  const sql = `
    INSERT INTO ads
      (title, ad_type, image_url, alt_text, link_url, link_target,
       html_content, popup_delay_seconds, popup_frequency,
       show_on, target_imprint, start_date, end_date, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const vals = [
    title.trim(), ad_type,
    image_url, alt_text, link_url, link_target, html_content,
    Number(popup_delay_seconds), popup_frequency,
    show_on, target_imprint,
    start_date || null, end_date || null,
    Number(priority), status,
  ];

  db.query(sql, vals, (err, result) => {
    if (err) return res.status(500).json(err);
    db.query("SELECT * FROM ads WHERE id = ?", [result.insertId], (err2, rows) => {
      if (err2) return res.status(500).json(err2);
      return res.status(201).json(rows[0]);
    });
  });
});

/* 🔐 GET /api/admin/ads */
router.get("/ads", adminAuth, (req, res) => {
  const { status, ad_type, page = 1, limit = 20 } = req.query;

  let where = "WHERE 1=1";
  const vals = [];

  if (status  && VALID.status.includes(status))   { where += " AND status = ?";  vals.push(status); }
  if (ad_type && VALID.ad_type.includes(ad_type)) { where += " AND ad_type = ?"; vals.push(ad_type); }

  const offset = (Number(page) - 1) * Number(limit);

  db.query(`SELECT COUNT(*) AS total FROM ads ${where}`, vals, (err, countRows) => {
    if (err) return res.status(500).json(err);
    const total = countRows[0].total;
    db.query(
      `SELECT * FROM ads ${where} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...vals, Number(limit), offset],
      (err2, rows) => {
        if (err2) return res.status(500).json(err2);
        return res.json({ total, page: Number(page), limit: Number(limit), data: rows });
      }
    );
  });
});

/* 🔐 GET /api/admin/ads/:id/stats  — must be BEFORE /:id to avoid conflict */
router.get("/ads/:id/stats", adminAuth, (req, res) => {
  db.query("SELECT id FROM ads WHERE id = ?", [req.params.id], (err, check) => {
    if (err)           return res.status(500).json(err);
    if (!check.length) return res.status(404).json({ msg: "Ad not found" });

    db.query(
      `SELECT COALESCE(SUM(impressions),0) AS total_impressions,
              COALESCE(SUM(clicks),0)      AS total_clicks
       FROM ad_stats WHERE ad_id = ?`,
      [req.params.id],
      (err2, totals) => {
        if (err2) return res.status(500).json(err2);
        db.query(
          `SELECT stat_date, impressions, clicks FROM ad_stats
           WHERE ad_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           ORDER BY stat_date ASC`,
          [req.params.id],
          (err3, daily) => {
            if (err3) return res.status(500).json(err3);
            return res.json({ ...totals[0], daily });
          }
        );
      }
    );
  });
});

/* 🔐 GET /api/admin/ads/:id */
router.get("/ads/:id", adminAuth, (req, res) => {
  db.query("SELECT * FROM ads WHERE id = ?", [req.params.id], (err, rows) => {
    if (err)          return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ msg: "Ad not found" });
    return res.json(rows[0]);
  });
});

/* 🔐 PUT /api/admin/ads/:id */
router.put("/ads/:id", adminAuth, (req, res) => {
  const errors = validateAd(req.body, false);
  if (errors.length) return res.status(422).json({ errors });

  const ALLOWED_FIELDS = [
    "title", "ad_type", "image_url", "alt_text", "link_url", "link_target",
    "html_content", "popup_delay_seconds", "popup_frequency",
    "show_on", "target_imprint", "start_date", "end_date", "priority", "status",
  ];

  const setClauses = [];
  const vals = [];

  ALLOWED_FIELDS.forEach((field) => {
    if (req.body[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      vals.push(req.body[field] === "" ? null : req.body[field]);
    }
  });

  if (!setClauses.length) return res.status(400).json({ msg: "Nothing to update" });

  vals.push(req.params.id);

  db.query("SELECT id FROM ads WHERE id = ?", [req.params.id], (err, check) => {
    if (err)           return res.status(500).json(err);
    if (!check.length) return res.status(404).json({ msg: "Ad not found" });

    db.query(
      `UPDATE ads SET ${setClauses.join(", ")} WHERE id = ?`,
      vals,
      (err2) => {
        if (err2) return res.status(500).json(err2);
        db.query("SELECT * FROM ads WHERE id = ?", [req.params.id], (err3, rows) => {
          if (err3) return res.status(500).json(err3);
          return res.json(rows[0]);
        });
      }
    );
  });
});

/* 🔐 DELETE /api/admin/ads/:id */
router.delete("/ads/:id", adminAuth, (req, res) => {
  db.query("SELECT id, image_url FROM ads WHERE id = ?", [req.params.id], (err, rows) => {
    if (err)          return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ msg: "Ad not found" });

    // Delete the image file from disk
    const imgPath = rows[0].image_url; // e.g. /uploads/ads/filename.jpg
    if (imgPath) {
      const fullPath = path.join(__dirname, "..", imgPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }

    db.query("DELETE FROM ads WHERE id = ?", [req.params.id], (err2) => {
      if (err2) return res.status(500).json(err2);
      return res.json({ success: true });
    });
  });
});

module.exports = router;