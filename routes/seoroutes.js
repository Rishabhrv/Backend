const express = require("express");
const router  = express.Router();
const db      = require("../db");
const jwt     = require("jsonwebtoken");
const SECRET  = "MY_SECRET_KEY";

/* ─── Admin Auth ─────────────────────────────────────────────────────────── */
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

/* ════════════════════════════════════════
   GET /api/seo/product/:productId
   Public — used by generateMetadata
════════════════════════════════════════ */
router.get("/product/:productId", (req, res) => {
  db.query(
    `SELECT meta_title, meta_description, keywords
     FROM seo_meta
     WHERE page_type = 'product' AND page_id = ?
     LIMIT 1`,
    [req.params.productId],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      // Return null-ish object if not found — frontend handles fallback
      res.json(rows[0] || null);
    }
  );
});



module.exports = router;


[{
	"resource": "/c:/Users/rc/Desktop/My Work/E Book/backend/server.js",
	"owner": "typescript",
	"code": "1149",
	"severity": 8,
	"message": "File name 'c:/Users/rc/Desktop/My Work/E Book/backend/routes/seoroutes.js' differs from already included file name 'c:/Users/rc/Desktop/My Work/E Book/backend/routes/Seoroutes.js' only in casing.\n  The file is in the program because:\n    Root file specified for compilation\n    Imported via \"./routes/seoroutes\" from file 'c:/Users/rc/Desktop/My Work/E Book/backend/server.js'",
	"source": "ts",
	"startLineNumber": 34,
	"startColumn": 29,
	"endLineNumber": 34,
	"endColumn": 49,
	"modelVersionId": 1,
	"origin": "extHost1"
}]