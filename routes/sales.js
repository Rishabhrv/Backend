const express = require("express");
const router = express.Router();
const db = require("../db");

// GET active sale for a product
router.get("/active/:productId", async (req, res) => {
    try {
        const productId = req.params.productId;
        const promiseDb = db.promise();

        // First, find the product's categories if we need to check category-wide sales
        const [productCategories] = await promiseDb.query("SELECT category_id FROM product_categories WHERE product_id = ?", [productId]);
        const categoryIds = productCategories.map(c => c.category_id);

        // Find active sales that match this product
        // 1. site-wide (applicable_on = 'all')
        // 2. product-specific (sale_products)
        // 3. category-specific (sale_categories)

        let query = `
      SELECT s.* 
      FROM sales s
      WHERE s.status = 'active'
        AND s.start_date <= NOW()
        AND s.end_date >= NOW()
        AND (
          s.applicable_on = 'all'
          OR (s.applicable_on = 'product' AND s.id IN (SELECT sale_id FROM sale_products WHERE product_id = ?))
          OR (s.applicable_on = 'category' AND s.id IN (SELECT sale_id FROM sale_categories WHERE category_id IN (?)))
        )
      ORDER BY s.discount_value DESC
      LIMIT 1
    `;

        // Handle empty categories array for IN clause
        const catQueryVal = categoryIds.length > 0 ? categoryIds : [0];

        const [sales] = await promiseDb.query(query, [productId, catQueryVal]);

        if (sales.length > 0) {
            res.json(sales[0]);
        } else {
            res.json(null); // No active sale
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

module.exports = router;





