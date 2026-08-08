const db = require("../db");

/**
 * Given an array of items (each needing product_id, price), 
 * computes the final sale price if an active sale applies.
 */
async function applySalesToItems(userId, items) {
    if (!items || items.length === 0) return items;

    const promiseDb = db.promise();

    // Get all active sales
    const [sales] = await promiseDb.query(`
    SELECT * FROM sales 
    WHERE status = 'active' 
      AND start_date <= NOW() 
      AND end_date >= NOW()
    ORDER BY discount_value DESC
  `);

    if (sales.length === 0) return items; // No active sales

    // Get products mappings
    const [saleProducts] = await promiseDb.query("SELECT sale_id, product_id FROM sale_products");
    const [saleCategories] = await promiseDb.query("SELECT sale_id, category_id FROM sale_categories");

    // Extract category info for items
    const productIds = items.map(i => i.product_id);
    const [productCategories] = await promiseDb.query(
        "SELECT product_id, category_id FROM product_categories WHERE product_id IN (?)",
        [productIds.length > 0 ? productIds : [0]]
    );

    // Extract usage counts for the user
    const [usages] = await promiseDb.query(
        "SELECT sale_id, product_id, COUNT(*) as count FROM sale_usage WHERE user_id = ? GROUP BY sale_id, product_id",
        [userId]
    );

    const usageMap = {}; // "saleId-productId" -> count
    usages.forEach(u => {
        usageMap[`${u.sale_id}-${u.product_id}`] = u.count;
    });

    return items.map(item => {
        // Find applicable sales for this item
        const itemCats = productCategories.filter(pc => pc.product_id === item.product_id).map(pc => pc.category_id);

        // Find the best sale
        let bestSale = null;
        let bestPrice = Number(item.price);

        for (const sale of sales) {
            // Check applicability
            let applies = false;
            if (sale.applicable_on === 'all') applies = true;
            else if (sale.applicable_on === 'product') {
                applies = saleProducts.some(sp => sp.sale_id === sale.id && sp.product_id === item.product_id);
            } else if (sale.applicable_on === 'category') {
                applies = saleCategories.some(sc => sc.sale_id === sale.id && itemCats.includes(sc.category_id));
            }

            if (!applies) continue;

            // Check usage limit
            if (sale.usage_limit_per_user !== null) {
                const usageCount = usageMap[`${sale.id}-${item.product_id}`] || 0;
                if (usageCount >= sale.usage_limit_per_user) {
                    continue; // User exceeded limit for this product on this sale
                }
            }

            // Calculate price
            let currentPrice = Number(item.price);
            let newPrice = currentPrice;

            if (sale.discount_type === 'percent') {
                newPrice = currentPrice - (currentPrice * sale.discount_value / 100);
            } else if (sale.discount_type === 'flat') {
                newPrice = currentPrice - sale.discount_value;
            }

            if (newPrice < 0) newPrice = 0;

            if (newPrice < bestPrice) {
                bestPrice = newPrice;
                bestSale = sale;
            }
        }

        return {
            ...item,
            original_price: item.price,
            price: bestPrice,
            sale_id: bestSale ? bestSale.id : null,
            sale: bestSale // Optional full object
        };
    });
}

/**
 * Record sale usage after successful checkout
 */
async function recordSaleUsage(userId, orderId, items) {
    const promiseDb = db.promise();
    for (const item of items) {
        if (item.sale_id) {
            // Record one usage per quantity (or just one per order row, usually sales are limited by quantity anyway)
            // Here we record exactly how many were bought. Wait, if user buys 2, should it count as 2 usages? Yes.
            for (let q = 0; q < item.quantity; q++) {
                await promiseDb.query(
                    "INSERT INTO sale_usage (sale_id, user_id, product_id, order_id) VALUES (?, ?, ?, ?)",
                    [item.sale_id, userId, item.product_id, orderId]
                );
            }
        }
    }
}

module.exports = {
    applySalesToItems,
    recordSaleUsage
};


