const express = require("express");
const router = express.Router();
const db = require("../db");

// Helper to safely build the source filter for SQL queries
const getSourceSql = (req) => {
  const { source } = req.query;
  if (!source || source === "all") return "";
  return ` AND source = ${db.escape(source)} `;
};

// ─────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/live
// ─────────────────────────────────────────────────────────────────
router.get("/analytics/live", async (req, res) => {
  try {
    const sourceSql = getSourceSql(req);

    // 1. Users active in the last 5 minutes (online right now)
    const [[{ onlineNow }]] = await db.promise().query(`
      SELECT COUNT(DISTINCT session_id) AS onlineNow
      FROM visitor_logs
      WHERE last_visited_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
      ${sourceSql}
    `);

    // 2. Users active in the last 30 minutes
    const [[{ activeLast30m }]] = await db.promise().query(`
      SELECT COUNT(DISTINCT session_id) AS activeLast30m
      FROM visitor_logs
      WHERE last_visited_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
      ${sourceSql}
    `);

    // 3. Unique sessions today
    const [[{ todayUnique }]] = await db.promise().query(`
      SELECT COUNT(DISTINCT session_id) AS todayUnique
      FROM visitor_logs
      WHERE DATE(last_visited_at) = CURDATE()
      ${sourceSql}
    `);

    // 4. New visitors today
    const [[{ newVisitors }]] = await db.promise().query(`
      SELECT COUNT(*) AS newVisitors
      FROM (
        SELECT session_id, MIN(DATE(last_visited_at)) AS first_day
        FROM visitor_logs
        WHERE 1=1 ${sourceSql}
        GROUP BY session_id
        HAVING first_day = CURDATE()
      ) t
    `);

    // 5. Returning visitors today
    const [[{ returningVisitors }]] = await db.promise().query(`
      SELECT COUNT(*) AS returningVisitors
      FROM (
        SELECT session_id, MIN(DATE(last_visited_at)) AS first_day
        FROM visitor_logs
        WHERE 1=1 ${sourceSql}
        GROUP BY session_id
        HAVING first_day < CURDATE()
          AND session_id IN (
            SELECT DISTINCT session_id
            FROM visitor_logs
            WHERE DATE(last_visited_at) = CURDATE()
            ${sourceSql}
          )
      ) t
    `);

    // 6. Top 5 countries right now (last 5 min)
    const [topLiveCountries] = await db.promise().query(`
      SELECT country, COUNT(DISTINCT session_id) AS count
      FROM visitor_logs
      WHERE last_visited_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        AND country != 'Unknown'
        ${sourceSql}
      GROUP BY country
      ORDER BY count DESC
      LIMIT 5
    `);

    // 7. Peak concurrent visitors today
    const [[{ peakToday }]] = await db.promise().query(`
      SELECT COALESCE(MAX(bucket_count), 0) AS peakToday
      FROM (
        SELECT
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(last_visited_at) / 300) * 300) AS bucket,
          COUNT(DISTINCT session_id) AS bucket_count
        FROM visitor_logs
        WHERE DATE(last_visited_at) = CURDATE()
        ${sourceSql}
        GROUP BY bucket
      ) buckets
    `);

    res.json({
      success: true,
      onlineNow,
      activeLast30m,
      todayUnique,
      newVisitors,
      returningVisitors,
      topLiveCountries,
      peakToday,
    });
  } catch (error) {
    console.error("Live Analytics Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/locations?period=week|month|all&source=apgh
// ─────────────────────────────────────────────────────────────────
router.get("/analytics/locations", async (req, res) => {
  try {
    const { period = "all" } = req.query;
    const sourceSql = getSourceSql(req);

    // Build WHERE clause
    let dateFilter = "WHERE 1=1";
    if (period === "week") {
      dateFilter += " AND last_visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)";
    } else if (period === "month") {
      dateFilter += " AND last_visited_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)";
    }

    const query = `
      SELECT
        country,
        state,
        COUNT(CASE WHEN user_id IS NOT NULL THEN 1 END) AS knownUsers,
        COUNT(CASE WHEN user_id IS NULL     THEN 1 END) AS unknownUsers
      FROM visitor_logs
      ${dateFilter} ${sourceSql}
      GROUP BY country, state
      ORDER BY COUNT(*) DESC
    `;

    const [rows] = await db.promise().query(query);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Admin Analytics Locations Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 1. Hourly Traffic Today ───────────────────────────────────────────────────
router.get("/analytics/hourly", async (req, res) => {
  try {
    const sourceSql = getSourceSql(req);
    const [rows] = await db.promise().query(`
      SELECT
        HOUR(last_visited_at) AS hour,
        COUNT(DISTINCT session_id) AS sessions
      FROM visitor_logs
      WHERE DATE(last_visited_at) = CURDATE() ${sourceSql}
      GROUP BY HOUR(last_visited_at)
      ORDER BY hour ASC
    `);

    const map = Object.fromEntries(rows.map(r => [r.hour, r.sessions]));
    const data = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      sessions: map[h] ?? 0,
    }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 2. Daily Unique Sessions (last N days) ────────────────────────────────────
router.get("/analytics/daily", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const sourceSql = getSourceSql(req);

    const [rows] = await db.promise().query(`
      SELECT
        DATE(last_visited_at) AS date,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(DISTINCT user_id)    AS knownSessions
      FROM visitor_logs
      WHERE last_visited_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ${sourceSql}
      GROUP BY DATE(last_visited_at)
      ORDER BY date ASC
    `, [days]);

    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 3. Conversion Funnel ──────────────────────────────────────────────────────
router.get("/analytics/funnel", async (req, res) => {
  try {
    const sourceSql = getSourceSql(req);

    const [[{ visitors }]] = await db.promise().query(`
      SELECT COUNT(DISTINCT session_id) AS visitors 
      FROM visitor_logs WHERE 1=1 ${sourceSql}
    `);

    // Note: If you want 'registered', 'ordered', and 'subscribed' split by source, 
    // you must also add a 'source' column to your users, orders, and user_subscriptions tables.
    // For now, these 3 queries remain untouched.
    const [[{ registered }]] = await db.promise().query(
      `SELECT COUNT(*) AS registered FROM users WHERE role = 'customer'`
    );
    const [[{ ordered }]] = await db.promise().query(
      `SELECT COUNT(DISTINCT user_id) AS ordered FROM orders WHERE payment_status = 'success'`
    );
    const [[{ subscribed }]] = await db.promise().query(
      `SELECT COUNT(DISTINCT user_id) AS subscribed FROM user_subscriptions WHERE status = 'active'`
    );

    res.json({ success: true, visitors, registered, ordered, subscribed });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 4. Revenue by Region ──────────────────────────────────────────────────────
router.get("/analytics/revenue-region", async (req, res) => {
  try {
    // Note: To filter revenue by site, the `orders` table needs a `source` column.
    const [rows] = await db.promise().query(`
      SELECT
        oa.state,
        oa.country,
        COUNT(DISTINCT o.id)     AS orders,
        SUM(o.total_amount - COALESCE(o.coupon_discount, 0)) AS revenue
      FROM orders o
      JOIN order_address oa ON oa.order_id = o.id
      WHERE o.payment_status = 'success'
        AND oa.state IS NOT NULL
        AND oa.state != ''
      GROUP BY oa.state, oa.country
      ORDER BY revenue DESC
      LIMIT 20
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 5. State Drill-Down ───────────────────────────────────────────────────────
router.get("/analytics/state-drill", async (req, res) => {
  try {
    const sourceSql = getSourceSql(req);
    const [rows] = await db.promise().query(`
      SELECT
        country,
        state,
        COUNT(DISTINCT session_id) AS sessions
      FROM visitor_logs
      WHERE country != 'Unknown'
        AND state   != 'Unknown'
        AND state   != ''
        ${sourceSql}
      GROUP BY country, state
      ORDER BY sessions DESC
    `);

    const countryTotals = {};
    const countryStates = {};

    rows.forEach(({ country, state, sessions }) => {
      if (!countryTotals[country]) countryTotals[country] = 0;
      countryTotals[country] += sessions;
      if (!countryStates[country]) countryStates[country] = [];
      countryStates[country].push({ state, sessions });
    });

    const topCountries = Object.entries(countryTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c]) => c);

    const data = {};
    topCountries.forEach(c => {
      data[c] = (countryStates[c] || []).slice(0, 8);
    });

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 6. Login Provider Split ───────────────────────────────────────────────────
router.get("/analytics/provider", async (req, res) => {
  try {
    const [[{ local, google }]] = await db.promise().query(`
      SELECT
        SUM(provider = 'local')  AS local,
        SUM(provider = 'google') AS google
      FROM users
      WHERE role = 'customer'
    `);
    res.json({ success: true, local: local ?? 0, google: google ?? 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 7. Day-of-Week Traffic ────────────────────────────────────────────────────
router.get("/analytics/dow", async (req, res) => {
  try {
    const sourceSql = getSourceSql(req);
    const [rows] = await db.promise().query(`
      SELECT
        DAYOFWEEK(last_visited_at) AS dow_num,
        DAYNAME(last_visited_at)   AS day_name,
        COUNT(DISTINCT session_id) / COUNT(DISTINCT DATE(last_visited_at)) AS sessions
      FROM visitor_logs
      WHERE last_visited_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      ${sourceSql}
      GROUP BY dow_num, day_name
      ORDER BY dow_num ASC
    `);

    const ORDER = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
    const SHORT  = { Monday:"Mon", Tuesday:"Tue", Wednesday:"Wed", Thursday:"Thu", Friday:"Fri", Saturday:"Sat", Sunday:"Sun" };

    const map = Object.fromEntries(rows.map(r => [r.day_name, Math.round(r.sessions)]));
    const data = ORDER.map(d => ({ day: SHORT[d], sessions: map[d] ?? 0 }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;