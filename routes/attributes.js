const express = require("express");
const router = express.Router();
const db = require("../db");

/* GET ALL ATTRIBUTES */
router.get("/", (req, res) => {
  db.query(
    "SELECT id, name FROM attributes ORDER BY name ASC",
    (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "DB error" }); 
      }
      res.json(results);
    }
  );
});

/* CREATE ATTRIBUTE (if not exists) */
router.post("/", (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Attribute name required" });
  }

  db.query(
    "INSERT IGNORE INTO attributes (name) VALUES (?)",
    [name],
    (err, result) => {
      if (err) return res.status(500).json(err);

      // fetch ID (important for product_attributes)
      db.query(
        "SELECT id FROM attributes WHERE name = ?",
        [name],
        (err2, rows) => {
          if (err2) return res.status(500).json(err2);
          res.json(rows[0]);
        }
      );
    }
  );
});


router.get("/:productId/attributes", (req, res) => {
  const { productId } = req.params;

  db.query(
    `
    SELECT 
      a.id,
      a.name,
      pa.value
    FROM product_attributes pa
    JOIN attributes a ON pa.attribute_id = a.id
    WHERE pa.product_id = ?
    `,
    [productId],
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    }
  );
});


module.exports = router;
