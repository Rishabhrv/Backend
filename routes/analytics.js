const express = require("express");
const router = express.Router();
const geoip = require("geoip-lite");
const db = require("../db"); 

router.post("/track", async (req, res) => {
  try {
    // 1. Extract 'source' from req.body
    const { sessionId, userId, source } = req.body;
    
    if (!sessionId) return res.status(400).json({ success: false });

    // Grab IP address
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (ip && ip.includes(",")) ip = ip.split(",")[0].trim();

    // Convert IP to Location
    const geo = geoip.lookup(ip);
    
    const country = geo?.country || "Unknown";
    const state = geo?.region || "Unknown";
    
    // 2. Default to 'Unknown' if source wasn't provided by an older client
    const appSource = source || "agph";

    // 3. Update the query to include the new 'source' column
    const query = `
      INSERT INTO visitor_logs (session_id, user_id, ip_address, country, state, source)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        user_id = COALESCE(VALUES(user_id), user_id),
        ip_address = VALUES(ip_address),
        country = VALUES(country),
        state = VALUES(state),
        last_visited_at = CURRENT_TIMESTAMP
    `;
    
    // 4. Pass appSource into the query parameters
    await db.promise().query(query, [sessionId, userId || null, ip, country, state, appSource]);

    res.json({ success: true });
  } catch (error) {
    console.error("Tracking Error:", error);
    res.status(500).json({ success: false });
  }
});

module.exports = router;