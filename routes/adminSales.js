const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "MY_SECRET_KEY"; // Just mimicking what might be there, adminCoupons used "MY_SECRET_KEY"

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

// GET all sales
router.get("/discount/manage-sales", adminAuth, async (req, res) => {
    try {
        const promiseDb = db.promise();

        // Fetch sales
        const [sales] = await promiseDb.query("SELECT * FROM sales ORDER BY id DESC");

        // For each sale, fetch attached products/categories
        for (let sale of sales) {
            if (sale.applicable_on === "product") {
                const [products] = await promiseDb.query("SELECT p.id, p.title FROM sale_products sp JOIN products p ON sp.product_id = p.id WHERE sp.sale_id = ?", [sale.id]);
                sale.products = products;
            } else if (sale.applicable_on === "category") {
                const [categories] = await promiseDb.query("SELECT c.id, c.name FROM sale_categories sc JOIN categories c ON sc.category_id = c.id WHERE sc.sale_id = ?", [sale.id]);
                sale.categories = categories;
            }
        }

        res.json(sales);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

// POST a new sale
router.post("/discount/manage-sales", adminAuth, async (req, res) => {
    const {
        name,
        discount_type,
        discount_value,
        start_date,
        end_date,
        applicable_on,
        product_ids,
        category_ids,
        usage_limit_per_user,
        timer_duration_hours
    } = req.body;

    try {
        const promiseDb = db.promise();
        const [result] = await promiseDb.query(
            `INSERT INTO sales (name, discount_type, discount_value, start_date, end_date, applicable_on, usage_limit_per_user, timer_duration_hours) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, discount_type, discount_value, start_date, end_date, applicable_on, usage_limit_per_user || null, timer_duration_hours || null]
        );

        const saleId = result.insertId;

        if (applicable_on === "product" && Array.isArray(product_ids)) {
            for (const pid of product_ids) {
                await promiseDb.query("INSERT INTO sale_products (sale_id, product_id) VALUES (?, ?)", [saleId, pid]);
            }
        } else if (applicable_on === "category" && Array.isArray(category_ids)) {
            for (const cid of category_ids) {
                await promiseDb.query("INSERT INTO sale_categories (sale_id, category_id) VALUES (?, ?)", [saleId, cid]);
            }
        }

        res.status(201).json({ msg: "Sale created successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

// DELETE a sale
router.delete("/discount/manage-sales/:id", adminAuth, async (req, res) => {
    try {
        const promiseDb = db.promise();
        await promiseDb.query("DELETE FROM sales WHERE id = ?", [req.params.id]);
        res.json({ msg: "Sale deleted" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

// PUT (Toggle status)
router.put("/discount/manage-sales/:id/status", adminAuth, async (req, res) => {
    try {
        const promiseDb = db.promise();
        const { status } = req.body;
        await promiseDb.query("UPDATE sales SET status = ? WHERE id = ?", [status, req.params.id]);
        res.json({ msg: "Sale status updated" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

// PUT (Edit sale)
router.put("/discount/manage-sales/:id", adminAuth, async (req, res) => {
    const { id } = req.params;
    const {
        name,
        discount_type,
        discount_value,
        start_date,
        end_date,
        applicable_on,
        product_ids,
        category_ids,
        usage_limit_per_user,
        timer_duration_hours
    } = req.body;

    try {
        const promiseDb = db.promise();
        
        await promiseDb.query(
            `UPDATE sales 
             SET name=?, discount_type=?, discount_value=?, start_date=?, end_date=?, applicable_on=?, usage_limit_per_user=?, timer_duration_hours=?
             WHERE id=?`,
            [name, discount_type, discount_value, start_date, end_date, applicable_on, usage_limit_per_user || null, timer_duration_hours || null, id]
        );

        await promiseDb.query("DELETE FROM sale_products WHERE sale_id = ?", [id]);
        if (applicable_on === "product" && Array.isArray(product_ids)) {
            for (const pid of product_ids) {
                await promiseDb.query("INSERT INTO sale_products (sale_id, product_id) VALUES (?, ?)", [id, pid]);
            }
        }

        await promiseDb.query("DELETE FROM sale_categories WHERE sale_id = ?", [id]);
        if (applicable_on === "category" && Array.isArray(category_ids)) {
            for (const cid of category_ids) {
                await promiseDb.query("INSERT INTO sale_categories (sale_id, category_id) VALUES (?, ?)", [id, cid]);
            }
        }

        res.json({ msg: "Sale updated successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

module.exports = router;