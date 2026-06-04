const express = require("express");
const router = express.Router();
const geoip = require("geoip-lite");
const db = require("../db"); 

router.post("/track", async (req, res) => {
  try {
    const { sessionId, userId, source } = req.body;
    
    if (!sessionId) return res.status(400).json({ success: false });

    // 1. Check a wider variety of headers used by live servers/CDNs
   let rawIp = 
      req.headers["cf-connecting-ip"] || 
      req.headers["x-real-ip"] ||        
      req.headers["x-forwarded-for"] ||  
      req.socket.remoteAddress || 
      "";

    let ip = rawIp.split(",")[0].trim();
    if (ip.startsWith("::ffff:")) {
      ip = ip.replace("::ffff:", "");
    }

    // 👇 ADD THIS BLOCK FOR LOCAL TESTING 👇
    // If the IP is localhost, fake it with a public IP (e.g., Google's 8.8.8.8)
    if (ip === "::1" || ip === "127.0.0.1") {
        ip = "8.8.8.8"; 
    }
    // 👆 REMOVE THIS BEFORE GOING TO PRODUCTION 👆

    // Convert IP to Location
    const geo = geoip.lookup(ip);
    // --------------------------------

    const country = geo?.country || "Unknown";
    const state = geo?.region || "Unknown";
    
    const appSource = source || "agph";

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
    
    await db.promise().query(query, [sessionId, userId || null, ip, country, state, appSource]);

    res.json({ success: true });
  } catch (error) {
    console.error("Tracking Error:", error);
    res.status(500).json({ success: false });
  }
});

module.exports = router;