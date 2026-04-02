const express = require("express");
const db = require("../db");

const router = express.Router();

/* ================= GET PUBLIC ADS ================= */
/* GET /api/public-ads?page_type=home&target_imprint=agph */

router.get("/", (req, res) => {
  const page_type = req.query.page_type || 'all';
  const target_imprint = req.query.target_imprint || 'all';

  // Fetch only ACTIVE ads, checking if the current date is within the schedule
  const sql = `
    SELECT 
        id, title, ad_type, image_url, alt_text, 
        link_url, link_target, html_content, 
        popup_delay_seconds, popup_frequency
    FROM ads 
    WHERE status = 'active'
      AND (start_date IS NULL OR start_date <= CURDATE())
      AND (end_date IS NULL OR end_date >= CURDATE())
      AND (show_on = 'all' OR show_on = ?)
      AND (target_imprint = 'all' OR target_imprint = ?)
    ORDER BY priority DESC
  `;

  db.query(sql, [page_type, target_imprint], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/* ================= TRACK IMPRESSION (VIEW) ================= */
/* POST /api/public-ads/:adId/view */

router.post("/:adId/view", (req, res) => {
  const { adId } = req.params;

  // Insert a new row for today, OR if today's row exists, increment impressions by +1
  const sql = `
    INSERT INTO ad_stats (ad_id, stat_date, impressions, clicks) 
    VALUES (?, CURDATE(), 1, 0)
    ON DUPLICATE KEY UPDATE impressions = impressions + 1
  `;

  db.query(sql, [adId], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ status: "impression_tracked" });
  });
});


/* ================= TRACK CLICK ================= */
/* POST /api/public-ads/:adId/click */

router.post("/:adId/click", (req, res) => {
  const { adId } = req.params;

  // Insert a new row for today, OR if today's row exists, increment clicks by +1
  const sql = `
    INSERT INTO ad_stats (ad_id, stat_date, impressions, clicks) 
    VALUES (?, CURDATE(), 0, 1)
    ON DUPLICATE KEY UPDATE clicks = clicks + 1
  `;

  db.query(sql, [adId], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ status: "click_tracked" });
  });
});

module.exports = router;