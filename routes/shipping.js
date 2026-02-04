const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");

const SECRET = "MY_SECRET_KEY";

/* 🔐 ADMIN AUTH */
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ msg: "No token" });

  const token = authHeader.split(" ")[1];
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

/* ============================
   🚚 GET ALL SHIPPING ZONES
============================ */
router.get("/zones", adminAuth, (req, res) => {
  db.query(
    `
    SELECT 
      z.id,
      z.zone_name,
      GROUP_CONCAT(DISTINCT r.region_name SEPARATOR ', ') AS regions,
      GROUP_CONCAT(
        DISTINCT 
        CASE 
          WHEN sm.method_type = 'free' AND sm.enabled = 1 THEN 'Free Shipping'
          WHEN sm.method_type = 'weight' AND sm.enabled = 1 THEN 'Weight Based Shipping'
        END
        SEPARATOR ', '
      ) AS methods
    FROM shipping_zones z
    LEFT JOIN shipping_zone_regions r ON r.zone_id = z.id
    LEFT JOIN shipping_methods sm ON sm.zone_id = z.id
    GROUP BY z.id
    ORDER BY z.id DESC
    `,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});


/* ============================
   ➕ ADD SHIPPING ZONE
============================ */
router.post("/zones", adminAuth, (req, res) => {
  const { zone_name, regions } = req.body;

  if (!zone_name) {
    return res.status(400).json({ msg: "Zone name required" });
  }

  // 1️⃣ Insert zone
  db.query(
    `INSERT INTO shipping_zones (zone_name) VALUES (?)`,
    [zone_name],
    (err, result) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      const zoneId = result.insertId;

      // 2️⃣ Insert regions (if any)
      if (!Array.isArray(regions) || regions.length === 0) {
        return res.json({ success: true });
      }

      const values = regions.map((r) => [zoneId, r]);

      db.query(
        `INSERT INTO shipping_zone_regions (zone_id, region_name)
         VALUES ?`,
        [values],
        (err) => {
          if (err) return res.status(500).json({ msg: "DB error" });
          res.json({ success: true });
        }
      );
    }
  );
});


/* ============================
   ❌ DELETE SHIPPING ZONE
============================ */
router.delete("/zones/:id", adminAuth, (req, res) => {
  const zoneId = req.params.id;

  db.query(
    `DELETE FROM shipping_zones WHERE id = ?`,
    [zoneId],
    (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json({ success: true });
    }
  );
});


router.put("/zones/:id", adminAuth, (req, res) => {
  const zoneId = req.params.id;
  const { zone_name, regions } = req.body;

  db.query(
    `UPDATE shipping_zones SET zone_name = ? WHERE id = ?`,
    [zone_name, zoneId],
    (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      db.query(
        `DELETE FROM shipping_zone_regions WHERE zone_id = ?`,
        [zoneId],
        (err) => {
          if (err) return res.status(500).json({ msg: "DB error" });

          if (!regions?.length) return res.json({ success: true });

          const values = regions.map((r) => [zoneId, r]);
          db.query(
            `INSERT INTO shipping_zone_regions (zone_id, region_name)
             VALUES ?`,
            [values],
            () => res.json({ success: true })
          );
        }
      );
    }
  );
});


/* ============================
   💳 SAVE SHIPPING METHODS
============================ */
router.post("/zones/:id/methods", adminAuth, (req, res) => {
  const zoneId = req.params.id;
  const { methods } = req.body; 
  // methods = [{ method_type: 'free', enabled: 1 }, { method_type: 'weight', enabled: 1 }]

  // remove old methods
  db.query(
    `DELETE FROM shipping_methods WHERE zone_id = ?`,
    [zoneId],
    (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      if (!Array.isArray(methods) || !methods.length) {
        return res.json({ success: true });
      }

      const values = methods.map((m) => [
        zoneId,
        m.method_type,
        m.method_type === "free"
          ? "Free Shipping"
          : "Weight Based Shipping",
        m.enabled ? 1 : 0,
      ]);

      db.query(
        `INSERT INTO shipping_methods
         (zone_id, method_type, title, enabled)
         VALUES ?`,
        [values],
        (err) => {
          if (err) return res.status(500).json({ msg: "DB error" });
          res.json({ success: true });
        }
      );
    }
  );
});


router.get("/zones/:id/methods", adminAuth, (req, res) => {
  db.query(
    `SELECT method_type, enabled
     FROM shipping_methods
     WHERE zone_id = ?`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});


/* ============================
   💾 SAVE WEIGHT SHIPPING RULES
============================ */
router.post(
  "/methods/:methodId/weight-rules",
  adminAuth,
  (req, res) => {
    const { methodId } = req.params;
    const { rules } = req.body;

    if (!Array.isArray(rules)) {
      return res.status(400).json({ msg: "Invalid rules" });
    }

    // Remove old rules
    db.query(
      `DELETE FROM weight_shipping_rules WHERE shipping_method_id = ?`,
      [methodId],
      (err) => {
        if (err) return res.status(500).json({ msg: "DB error" });

        if (!rules.length) return res.json({ success: true });

        const values = rules.map((r) => [
          methodId,
          r.min,
          r.max,
          r.type,
          r.flatCost || null,
          r.perKgCost || null,
          r.baseCost || null,
          r.baseWeight || null,
          r.extraCost || null,
        ]);

        db.query(
          `
          INSERT INTO weight_shipping_rules
          (shipping_method_id, weight_from, weight_to, charge_type,
           flat_cost, per_kg_cost, base_cost, base_weight, extra_cost_per_kg)
          VALUES ?
          `,
          [values],
          (err) => {
            if (err) return res.status(500).json({ msg: "DB error" });
            res.json({ success: true });
          }
        );
      }
    );
  }
);


/* ============================
   📦 GET WEIGHT RULES
============================ */
/* ============================
   ⚖️ GET WEIGHT RULES
============================ */
router.get("/methods/:methodId/weight-rules", adminAuth, (req, res) => {
  const methodId = req.params.methodId;

  db.query(
    `SELECT * FROM weight_shipping_rules
     WHERE shipping_method_id = ?
     ORDER BY weight_from ASC`,
    [methodId],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows);
    }
  );
});


/* ============================
   💾 SAVE WEIGHT RULES
============================ */
router.post("/methods/:methodId/weight-rules", adminAuth, (req, res) => {
  const methodId = req.params.methodId;
  const { rules } = req.body;

  if (!Array.isArray(rules)) {
    return res.status(400).json({ msg: "Invalid rules" });
  }

  // Remove old rules
  db.query(
    `DELETE FROM weight_shipping_rules WHERE shipping_method_id = ?`,
    [methodId],
    (err) => {
      if (err) return res.status(500).json({ msg: "DB error" });

      if (!rules.length) return res.json({ success: true });

      const values = rules.map((r) => [
        methodId,
        r.min,
        r.max,
        r.type,
        r.flatCost ?? null,
        r.perKgCost ?? null,
        r.baseCost ?? null,
        r.baseWeight ?? null,
        r.extraCost ?? null,
      ]);

      db.query(
        `INSERT INTO weight_shipping_rules
        (
          shipping_method_id,
          weight_from,
          weight_to,
          charge_type,
          flat_cost,
          per_kg_cost,
          base_cost,
          base_weight,
          extra_cost_per_kg
        )
        VALUES ?`,
        [values],
        (err) => {
          if (err) return res.status(500).json({ msg: "DB error" });
          res.json({ success: true });
        }
      );
    }
  );
});


router.get("/zones/:id/weight-method", adminAuth, (req, res) => {
  db.query(
    `SELECT id FROM shipping_methods
     WHERE zone_id = ?
     AND method_type = 'weight'
     AND enabled = 1
     LIMIT 1`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows[0] || null);
    }
  );
});



module.exports = router;
