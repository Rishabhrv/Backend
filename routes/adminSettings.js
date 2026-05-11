const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const SECRET = "MY_SECRET_KEY";

/* 🔐 ADMIN AUTH */
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

/* ===============================
   👑 GET SUPER ADMIN DETAILS
================================ */
router.get("/settings/admin", adminAuth, (req, res) => {
  const sql = `
    SELECT id, name, email, phone, role, status, created_at 
    FROM users 
    WHERE id = 1 
    LIMIT 1
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length) {
      return res.status(404).json({ msg: "Super admin not found" });
    }
    res.json({ success: true, data: rows[0] });
  });
});

/* ===============================
   📩 GET NOTIFICATION SETTINGS
================================ */
router.get("/settings/notifications", adminAuth, (req, res) => {
  // Returns the current environment variable
  res.json({ 
    success: true, 
    adminMail: process.env.ADMIN_MAIL || "" 
  });
});

/* ===============================
   📝 UPDATE NOTIFICATION SETTINGS
================================ */
router.put("/settings/notifications", adminAuth, (req, res) => {
  const { adminMail } = req.body;

  if (!adminMail) {
    return res.status(400).json({ msg: "Email is required" });
  }

  // 1. Update the variable in the running Node.js memory
  // This makes sure your adminorder.js file sees the new email immediately
  process.env.ADMIN_MAIL = adminMail;

  // 2. Update the .env file so the change survives a server restart
  // NOTE: Adjust '../.env' if your .env file is in a different directory relative to this file
  const envFilePath = path.resolve(__dirname, '../.env'); 

  try {
    if (fs.existsSync(envFilePath)) {
      let envContent = fs.readFileSync(envFilePath, "utf8");

      // Check if ADMIN_MAIL already exists in the file
      const regex = /^ADMIN_MAIL=.*$/m;
      
      if (regex.test(envContent)) {
        // Replace existing line
        envContent = envContent.replace(regex, `ADMIN_MAIL=${adminMail}`);
      } else {
        // Append to bottom if it doesn't exist
        envContent += `\nADMIN_MAIL=${adminMail}\n`;
      }

      fs.writeFileSync(envFilePath, envContent, "utf8");
    } else {
      console.warn(".env file not found. Variables updated in memory only.");
    }
    
    res.json({ success: true, msg: "Notification email updated successfully" });
  } catch (error) {
    console.error("Error writing to .env file:", error);
    // We still return success because it updated successfully in memory
    res.json({ success: true, msg: "Updated temporarily, but failed to write to .env file" });
  }
});

module.exports = router;