const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const path = require("path");

const mammoth = require("mammoth");
const Epub = require("epub-gen");
const pandoc = require("node-pandoc");
const { spawn } = require("child_process");
const fs = require("fs");

/* ================= STORAGE ================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = "";

    if (file.fieldname === "image" || file.fieldname === "ebook_cover") {
      uploadPath = process.env.UPLOAD_PRODUCTS;
    } 
    else if (file.fieldname === "ebook" || file.fieldname === "file") {
      uploadPath = process.env.UPLOAD_EBOOKS;
    } 
    else if (file.fieldname === "gallery") {
      uploadPath = process.env.UPLOAD_GALLERY;
    }

    if (!uploadPath) {
      return cb(new Error("Invalid upload field"));
    }

    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

/* ================= HELPERS ================= */
function convertDocxToEpub(options, callback) {
  const { originalPath, uploadPath, ebookFile, title } = options;

  const epubFilename = ebookFile.filename.replace(".docx", ".epub");
  const epubPath = path.join(uploadPath, epubFilename);
  const mediaDir = path.join(uploadPath, "media");
  const luaFilterPath = path.join(uploadPath, "chapter-numbering.lua");
  const cssPath = path.join(uploadPath, "epub-styles.css");

  const pandocPath = process.env.PANDOC_PATH;
  console.log("Using pandoc path:", pandocPath);

  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  const customCSS = `
body { text-align: justify; text-justify: inter-word; }
p { text-align: justify; text-justify: inter-word; margin: 0.5em 0; line-height: 1.5; }
.math { font-family: 'Times New Roman', serif; font-size: 1.1em; }
span.math.display { display: block; text-align: center; margin: 1em 0; }
span.math.inline { display: inline; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
table, th, td { border: 1px solid #000; }
th, td { padding: 0.5em; text-align: left; }
th { background-color: #f0f0f0; font-weight: bold; }
div.bordered-box, .bordered-box { border: 2px solid #000; padding: 1em; margin: 1em 0; background-color: #f5f5f5; text-align: justify; }
blockquote { border: 1px solid #666; padding: 1em; margin: 1em 0; background-color: #f9f9f9; text-align: justify; }
p.box-header { font-weight: bold; margin-bottom: 0.5em; text-align: left; }
h1, h2, h3, h4, h5, h6 { text-align: left; margin-top: 1em; margin-bottom: 0.5em; }
h2 { font-size: 1.3em; margin-top: 1.2em; }
h3 { font-size: 1.1em; margin-top: 1em; }
ul, ol { text-align: justify; margin: 0.5em 0; padding-left: 2em; }
li { text-align: justify; margin-bottom: 0.3em; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
figcaption { text-align: center; font-style: italic; margin-top: 0.5em; }
`;
  fs.writeFileSync(cssPath, customCSS, "utf8");

  const luaFilter = `
local chapter_count = 0
local h2_count = 0
local h3_count = 0
local excluded_headings = { "About the Book", "Preface", "Table of Content", "Table of Contents", "Introduction", "Acknowledgement", "Acknowledgements", "Foreword", "Dedication", "Contents", "Bibliography", "References", "Index", "Appendix", "Glossary" }

function is_excluded(text)
  local lower_text = text:lower()
  for _, excluded in ipairs(excluded_headings) do
    if lower_text:match("^" .. excluded:lower()) then return true end
  end
  return false
end

local first_h1_seen = false

function Header(elem)
  if elem.level == 1 then
    local text = pandoc.utils.stringify(elem)
    if not first_h1_seen then
      first_h1_seen = true
      return elem
    end
    if text:match("^[Cc][Hh][Aa][Pp][Tt][Ee][Rr]") or is_excluded(text) then return elem end
    chapter_count = chapter_count + 1
    h2_count = 0
    h3_count = 0
    local prefix = pandoc.Str("Chapter " .. chapter_count .. ": ")
    table.insert(elem.content, 1, prefix)
    return elem
  elseif elem.level == 2 then
    h2_count = h2_count + 1
    h3_count = 0
    if chapter_count > 0 then
      local prefix = pandoc.Str(chapter_count .. "." .. h2_count .. " ")
      table.insert(elem.content, 1, prefix)
    end
    return elem
  elseif elem.level == 3 then
    h3_count = h3_count + 1
    if chapter_count > 0 and h2_count > 0 then
      local prefix = pandoc.Str(chapter_count .. "." .. h2_count .. "." .. h3_count .. " ")
      table.insert(elem.content, 1, prefix)
    end
    return elem
  end
  return elem
end

function Table(tbl)
  tbl.attributes = tbl.attributes or {}
  tbl.attributes.border = "1"
  tbl.attributes.style = "border-collapse: collapse; border: 1px solid black;"
  return tbl
end

function Div(div)
  if div.attributes and div.attributes.style then
    if div.attributes.style:match("border") then
      div.classes = {"bordered-box"}
      return div
    end
  end
  return div
end
`;
  fs.writeFileSync(luaFilterPath, luaFilter, "utf8");

  if (!fs.existsSync(originalPath)) {
    return callback(new Error("Input file not found"));
  }

  const toEpub = spawn(pandocPath, [
    originalPath,
    "-o",
    epubPath,
    "--split-level=1",
    "--metadata=lang:en",
    "--standalone",
    "--epub-title-page=false",
    `--extract-media=${mediaDir}`,
    "--preserve-tabs",
    `--lua-filter=${luaFilterPath}`,
    `--css=${cssPath}`,
    "--from=docx+styles",
    "--mathml"
  ]);

  let stderrOutput = "";

  const timeout = setTimeout(() => {
    toEpub.kill();
    callback(new Error("Conversion timeout"));
  }, 30000);

  toEpub.stderr.on("data", (data) => {
    console.error("Pandoc STDERR:", data.toString());
    stderrOutput += data.toString();
  });

  toEpub.on("error", (error) => {
    clearTimeout(timeout);
    callback(error);
  });

  toEpub.on("close", (code) => {
    console.log("Pandoc exit code:", code);
    clearTimeout(timeout);
    if (code !== 0) {
      return callback(new Error(stderrOutput));
    }
    fs.unlink(luaFilterPath, () => {});
    fs.unlink(cssPath, () => {});
    callback(null, { epubFilename, epubPath });
  });
}

const generateSlug = (text) => {
  return text
    .toString()
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
};

const generateUniqueSlug = (baseSlug, callback) => {
  let slug = baseSlug;
  let counter = 1;
  const checkSlug = () => {
    db.query("SELECT id FROM products WHERE slug = ?", [slug], (err, results) => {
      if (err) return callback(err);
      if (results.length === 0) {
        return callback(null, slug);
      }
      slug = `${baseSlug}-${counter++}`;
      checkSlug();
    });
  };
  checkSlug();
};

// HELPER: Convert JS dates like 14/01/2026 or 14-01-2026 to MySQL YYYY-MM-DD safely
function parseDate(d) {
  if (!d) return null;
  d = d.trim();
  if (d.includes('/')) {
      const p = d.split('/');
      if (p.length === 3) return `${p[2]}-${p[1]}-${p[0]}`;
  } else if (d.includes('-')) {
      const p = d.split('-');
      if (p.length === 3) {
          return p[0].length === 4 ? d : `${p[2]}-${p[1]}-${p[0]}`;
      }
  }
  return null;
}

/* ================= ADD PRODUCT ================= */
router.post(
  "/",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "ebook", maxCount: 1 },
    { name: "ebook_cover", maxCount: 1 },
    { name: "gallery", maxCount: 9 },
  ]),
  (req, res) => {
    let {
      title, description, price, sell_price, stock, sku, product_type,
      status, weight, length, width, height, ebook_price, ebook_sell_price, book_id
    } = req.body;

    price = price || null;
    sell_price = sell_price || null;
    stock = stock || null;
    weight = weight || null;
    length = length || null;
    width = width || null;
    height = height || null;
    ebook_price = ebook_price || null;
    ebook_sell_price = ebook_sell_price || null;
    description = description || null;
    sku = sku || null;
    book_id = book_id || null;

    const imagePath = req.files.image ? `/uploads/products/${req.files.image[0].filename}` : (req.body.image_url || null);
    const ebookCoverPath = req.files?.ebook_cover ? `/uploads/products/${req.files.ebook_cover[0].filename}` : null;

    const slug = generateSlug(title);

    // ── NEW: Extract Fixed Attributes Before Insert ──
    let isbn = null;
    let no_of_pages = null;
    let publication_date = null;

    if (req.body.attributes) {
      const parsedAttrs = JSON.parse(req.body.attributes);
      
      const isbnAttr = parsedAttrs.find(a => a.name?.toLowerCase() === "isbn");
      if (isbnAttr?.values?.trim()) isbn = isbnAttr.values.trim();

      const pagesAttr = parsedAttrs.find(a => a.name?.toLowerCase() === "no. of pages");
      if (pagesAttr?.values?.trim()) no_of_pages = parseInt(pagesAttr.values.trim(), 10) || null;

      const dateAttr = parsedAttrs.find(a => a.name?.toLowerCase() === "publication date");
      if (dateAttr?.values?.trim()) publication_date = parseDate(dateAttr.values);
    }

    // Include the 3 new fields in the insert query
    const productSql = `
      INSERT INTO products
      (title, slug, description, price, sell_price, stock, sku, product_type, status, main_image, book_id, isbn, no_of_pages, publication_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      productSql,
      [title, slug, description, price, sell_price, stock, sku, product_type, status, imagePath, book_id || null, isbn, no_of_pages, publication_date],
      (err, result) => {
        if (err) return res.status(500).json({ message: err.message });

        const productId = result.insertId;

        const saveRelatedData = () => {
          if (product_type === "physical" || product_type === "both") {
            db.query(`INSERT INTO shipping_details (product_id, weight, length, width, height) VALUES (?, ?, ?, ?, ?)`, [productId, weight, length, width, height]);
          }
          if (req.body.attributes) {
            const attributes = JSON.parse(req.body.attributes);
            attributes.forEach((attr) => {
              const name = attr.name?.trim();
              const value = attr.values?.trim();
              if (!name || !value) return;
              db.query("INSERT IGNORE INTO attributes (name) VALUES (?)", [name], () => {
                db.query("SELECT id FROM attributes WHERE name = ?", [name], (err, rows) => {
                  if (err || !rows.length) return;
                  db.query(`INSERT INTO product_attributes (product_id, attribute_id, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`, [productId, rows[0].id, value]);
                });
              });
            });
            // REMOVED old ISBN UPDATE QUERY here since it's now handled in the main INSERT above
          }
          if (req.body.categories) {
            const categories = JSON.parse(req.body.categories);
            categories.forEach((categoryId) => {
              db.query(`INSERT IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)`, [productId, categoryId]);
            });
          }
          if (req.files.gallery) {
            req.files.gallery.forEach((file, index) => {
              db.query(`INSERT INTO product_gallery (product_id, image_path, sort_order) VALUES (?, ?, ?)`, [productId, `/uploads/gallery/${file.filename}`, index]);
            });
          }
          if (req.body.galleryUrls) {
            const galleryUrls = JSON.parse(req.body.galleryUrls);
            galleryUrls.forEach((urlPath, index) => {
              db.query(`INSERT INTO product_gallery (product_id, image_path, sort_order) VALUES (?, ?, ?)`, [productId, urlPath, index]);
            });
          }
          if (req.body.subjects) {
            const subjects = JSON.parse(req.body.subjects);
            subjects.forEach((subjectId) => {
              db.query(`INSERT IGNORE INTO product_subjects (product_id, subject_id) VALUES (?, ?)`, [productId, subjectId]);
            });
          }
          const { meta_title, meta_description, keywords } = req.body;
          if (meta_title || meta_description || keywords) {
            db.query(`INSERT INTO seo_meta (page_type, page_id, meta_title, meta_description, keywords) VALUES (?, ?, ?, ?, ?)`, ["product", productId, meta_title || null, meta_description || null, keywords || null]);
          }
          if (req.body.authors) {
            const authors = JSON.parse(req.body.authors);
            authors.forEach((authorId) => {
              db.query(`INSERT IGNORE INTO product_authors (product_id, author_id) VALUES (?, ?)`, [productId, authorId]);
            });
          }
        };

        if (req.files.ebook) {
          const ebookFile = req.files.ebook[0];
          const ext = path.extname(ebookFile.originalname).toLowerCase();
          const uploadPath = path.join(__dirname, "..", "uploads/ebooks");
          const originalPath = path.join(uploadPath, ebookFile.filename);

          if (ext === ".epub") {
            db.query(
              `INSERT INTO ebooks (product_id, file_path, file_type, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?, ?, ?)`,
              [productId, `/uploads/ebooks/${ebookFile.filename}`, "epub", ebook_price || null, ebook_sell_price || null, ebookCoverPath],
              function (err) {
                if (err) { console.error(err); return res.status(500).json({ message: "Ebook save failed" }); }
                saveRelatedData();
                return res.json({ message: "Product created", productId });
              }
            );
          } else if (ext === ".docx") {
            mammoth.convertToHtml({ path: originalPath }, {
              convertImage: mammoth.images.inline(function (element) {
                return element.read("base64").then(function (imageBuffer) { return { src: "data:" + element.contentType + ";base64," + imageBuffer }; });
              })
            }).then(function (result) {
              const htmlContent = result.value;
              const epubFilename = ebookFile.filename.replace(".docx", ".epub");
              const epubPath = path.join(uploadPath, epubFilename);
              const options = { title: title, author: "Unknown", content: [{ title: title, data: htmlContent }] };
              return new Epub(options, epubPath).promise.then(function () {
                fs.unlink(originalPath, function () {});
                db.query(
                  `INSERT INTO ebooks (product_id, file_path, file_type, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?, ?, ?)`,
                  [productId, `/uploads/ebooks/${epubFilename}`, "epub", ebook_price || null, ebook_sell_price || null, ebookCoverPath],
                  function (err) {
                    if (err) { console.error(err); return res.status(500).json({ message: "Ebook save failed" }); }
                    saveRelatedData();
                    return res.json({ message: "Product created", productId });
                  }
                );
              });
            }).catch(function (err) {
              console.error("DOCX conversion error:", err);
              return res.status(500).json({ message: "DOCX conversion failed" });
            });
          } else {
            return res.status(400).json({ message: "Only .docx or .epub allowed" });
          }
        } else {
          // Fallback: IF no document file, but they provided prices/cover
          if (ebookCoverPath || ebook_price || ebook_sell_price) {
             db.query(
               `INSERT INTO ebooks (product_id, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?)`,
               [productId, ebook_price || null, ebook_sell_price || null, ebookCoverPath]
             );
          }
          saveRelatedData();
          return res.json({ message: "Product created", productId });
        }
      }
    );
  }
);

/* ================= GET PRODUCTS LIST ================= */
router.get("/", (req, res) => {
  const sql = `
SELECT 
  p.id, p.title AS name, p.main_image AS image, p.sku, p.stock, p.slug, p.description, p.price, p.sell_price, p.status, p.product_type, p.created_at AS date, p.updated_at,
  GROUP_CONCAT(DISTINCT c.name) AS categories,
  GROUP_CONCAT(DISTINCT c.imprint) AS imprints,
  MAX(sm.meta_title) AS meta_title,
  MAX(sm.meta_description) AS meta_description,
  MAX(sm.keywords) AS keywords
FROM products p
LEFT JOIN product_categories pc ON pc.product_id = p.id
LEFT JOIN categories c ON c.id = pc.category_id
LEFT JOIN seo_meta sm ON sm.page_type = 'product' AND sm.page_id = p.id
WHERE p.status = 'published'
GROUP BY p.id, p.title, p.main_image, p.sku, p.stock, p.slug, p.description, p.price, p.sell_price, p.status, p.product_type, p.created_at, p.updated_at
ORDER BY p.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "DB error" });
    const formatted = results.map((p) => ({
      ...p,
      categories: p.categories ? p.categories.split(",") : [],
      meta_title: p.meta_title || "", meta_description: p.meta_description || "", keywords: p.keywords || "",
      description: p.description || "", imprints: p.imprints ? p.imprints.split(",") : [],
    }));
    res.json(formatted);
  });
});

/* ================= GET PRODUCTS LIST (TABLE) ================= */
router.get("/table-product", (req, res) => {
  const sql = `
SELECT 
  p.id, p.title AS name, p.main_image AS image, p.sku, p.book_id, p.stock, p.slug, p.description, p.price, p.sell_price, p.status, p.product_type, p.created_at AS date, p.updated_at,
  GROUP_CONCAT(DISTINCT c.name) AS categories,
  GROUP_CONCAT(DISTINCT c.imprint) AS imprints,
  MAX(sm.meta_title) AS meta_title,
  MAX(sm.meta_description) AS meta_description,
  MAX(sm.keywords) AS keywords
FROM products p
LEFT JOIN product_categories pc ON pc.product_id = p.id
LEFT JOIN categories c ON c.id = pc.category_id
LEFT JOIN seo_meta sm ON sm.page_type = 'product' AND sm.page_id = p.id
GROUP BY p.id, p.title, p.main_image, p.sku, p.book_id, p.stock, p.slug, p.description, p.price, p.sell_price, p.status, p.product_type, p.created_at, p.updated_at
ORDER BY p.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "DB error" });
    const formatted = results.map((p) => ({
      ...p,
      categories: p.categories ? p.categories.split(",") : [],
      meta_title: p.meta_title || "", meta_description: p.meta_description || "", keywords: p.keywords || "",
      description: p.description || "", imprints: p.imprints ? p.imprints.split(",") : [],
    }));
    res.json(formatted);
  });
});

/* ================= GET RANDOM FEATURED PRODUCT ================= */
router.get("/random/featured", (req, res) => {
  const sql = `
    SELECT 
      p.id, p.title, p.slug, p.description, p.price, p.sell_price, p.main_image,
      GROUP_CONCAT(DISTINCT a.name ORDER BY a.id SEPARATOR '||') AS authors,
      GROUP_CONCAT(DISTINCT a.slug ORDER BY a.id SEPARATOR '||') AS author_slugs,
      ROUND(AVG(r.rating), 1) AS avg_rating,
      COUNT(DISTINCT r.id) AS review_count
    FROM products p
    LEFT JOIN product_authors pa ON pa.product_id = p.id
    LEFT JOIN authors a ON a.id = pa.author_id
    LEFT JOIN reviews r ON r.product_id = p.id AND r.status = 'approved'
    INNER JOIN product_categories pc ON pc.product_id = p.id
    INNER JOIN categories c ON c.id = pc.category_id AND c.imprint = 'agph'
    WHERE p.status = 'published'
    GROUP BY p.id
    ORDER BY RAND()
    LIMIT 1
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    if (!rows.length) return res.json(null);
    const row = rows[0];
    const names = row.authors ? row.authors.split("||") : [];
    const slugs = row.author_slugs ? row.author_slugs.split("||") : [];
    const authors = names.map((name, i) => ({ name, slug: slugs[i] || null }));
    res.json({
      ...row, authors,
      avg_rating: row.avg_rating ? parseFloat(row.avg_rating) : 0,
      review_count: row.review_count ? parseInt(row.review_count) : 0,
    });
  });
});

/* ================= GET PRODUCT BY SLUG (PUBLIC STORE) ================= */
router.get("/slug/:slug", (req, res) => {
  const { slug } = req.params;
  const sql = `
    SELECT 
      p.id, p.title, p.slug, p.description, p.price, p.sell_price, p.stock, 
      p.product_type, p.main_image, p.updated_at,
      MAX(sd.weight) AS weight, MAX(sd.length) AS length, 
      MAX(sd.width) AS width, MAX(sd.height) AS height,
      MAX(e.file_path) AS ebook_path,
      MAX(e.price) AS ebook_price,
      MAX(e.sell_price) AS ebook_sell_price,
      MAX(e.ebook_cover) AS ebook_cover 
    FROM products p
    LEFT JOIN shipping_details sd ON sd.product_id = p.id
    LEFT JOIN ebooks e ON e.product_id = p.id
    WHERE p.slug = ? AND p.status = 'published'
    GROUP BY p.id
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) return res.status(500).json({ message: "DB error" });
    if (!rows.length) return res.status(404).json({ message: "Product not found" });

    const product = rows[0];

    db.query(`SELECT c.id, c.name, c.slug, c.imprint FROM product_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.product_id = ?`, [product.id], (err, categories) => {
      if (err) return res.status(500).json({ message: "Category fetch failed" });
      const imprints = categories.map((c) => c.imprint);
      if (!imprints.includes("agph")) return res.status(404).json({ message: "Product not found" });
      product.categories = categories || [];

      db.query(`SELECT a.id, a.name, a.profile_image AS image, a.bio, a.slug FROM product_authors pa JOIN authors a ON a.id = pa.author_id WHERE pa.product_id = ?`, [product.id], (err, authors) => {
        if (err) return res.status(500).json({ message: "Author fetch failed" });
        product.authors = authors || [];

        db.query(`SELECT a.name, pa.value FROM product_attributes pa JOIN attributes a ON a.id = pa.attribute_id WHERE pa.product_id = ?`, [product.id], (err, attributes) => {
          if (err) return res.status(500).json({ message: "Attribute fetch failed" });
          product.attributes = attributes || [];

          db.query(`SELECT image_path FROM product_gallery WHERE product_id = ? ORDER BY sort_order ASC`, [product.id], (err, gallery) => {
            if (err) return res.status(500).json({ message: "Gallery fetch failed" });
            product.gallery = gallery || [];

            db.query(`SELECT s.id, s.name, s.slug FROM product_subjects ps JOIN subjects s ON s.id = ps.subject_id WHERE ps.product_id = ?`, [product.id], (err, subjects) => {
              if (err) return res.status(500).json({ message: "Subject fetch failed" });
              product.subjects = subjects || [];
              res.json(product);
            });
          });
        });
      });
    });
  });
});

/* ================= GET SINGLE PRODUCT ================= */
router.get("/:id", (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT 
      p.id, p.book_id, p.title, p.slug, p.description, p.price, p.sell_price, p.stock, p.sku, p.status, p.product_type, p.main_image, p.updated_at,
      MAX(sd.weight) AS weight, MAX(sd.length) AS length, MAX(sd.width) AS width, MAX(sd.height) AS height,
      MAX(sm.meta_title) AS meta_title, MAX(sm.meta_description) AS meta_description, MAX(sm.keywords) AS keywords,
      MAX(e.file_path) AS ebook_path, MAX(e.file_type) AS ebook_type, MAX(e.price) AS ebook_price, MAX(e.sell_price) AS ebook_sell_price,
      MAX(e.ebook_cover) AS ebook_cover,
      GROUP_CONCAT(DISTINCT pc.category_id) AS category_ids
    FROM products p
    LEFT JOIN shipping_details sd ON sd.product_id = p.id
    LEFT JOIN seo_meta sm ON sm.page_type = 'product' AND sm.page_id = p.id
    LEFT JOIN ebooks e ON e.product_id = p.id
    LEFT JOIN product_categories pc ON pc.product_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `;

  db.query(sql, [id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ message: "Product not found" });

    const product = rows[0];
    product.category_ids = product.category_ids ? product.category_ids.split(",").map(Number) : [];
    res.json(product);
  });
});

/* ================= GET PRODUCT GALLERY ================= */
router.get("/:id/gallery", (req, res) => {
  const { id } = req.params;
  db.query(`SELECT id, image_path, sort_order FROM product_gallery WHERE product_id = ? ORDER BY sort_order ASC`, [id], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});



/* ================= UPDATE PRODUCT ================= */
router.put(
  "/:id",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "ebook", maxCount: 1 },
    { name: "ebook_cover", maxCount: 1 },
    { name: "gallery", maxCount: 9 },
  ]),
  (req, res) => {
    const { id } = req.params;
    
    let {
      title, slug, description, price, sell_price, stock, sku, product_type, status,
      weight, length, width, height, meta_title, meta_description, keywords,
      categories, attributes, authors, ebook_price, ebook_sell_price, book_id,
    } = req.body;

    price = price || null;
    sell_price = sell_price || null;
    stock = stock || null;
    weight = weight || null;
    length = length || null;
    width = width || null;
    height = height || null;
    ebook_price = ebook_price || null;
    ebook_sell_price = ebook_sell_price || null;
    description = description || null;
    sku = sku || null;
    book_id = book_id || null;

    const imagePath = req.files?.image ? `/uploads/products/${req.files.image[0].filename}` : null;
    const ebookCoverPath = req.files?.ebook_cover ? `/uploads/products/${req.files.ebook_cover[0].filename}` : null;

    // ── NEW: Extract Fixed Attributes Before Update ──
    let isbn = null;
    let no_of_pages = null;
    let publication_date = null;

    if (attributes) {
      const parsedAttrs = JSON.parse(attributes);
      
      const isbnAttr = parsedAttrs.find(a => a.name?.toLowerCase() === "isbn");
      if (isbnAttr?.values?.trim()) isbn = isbnAttr.values.trim();

      const pagesAttr = parsedAttrs.find(a => a.name?.toLowerCase() === "no. of pages");
      if (pagesAttr?.values?.trim()) no_of_pages = parseInt(pagesAttr.values.trim(), 10) || null;

      const dateAttr = parsedAttrs.find(a => a.name?.toLowerCase() === "publication date");
      if (dateAttr?.values?.trim()) publication_date = parseDate(dateAttr.values);
    }

    const updateSql = `
      UPDATE products SET
        title = ?, slug = ?, description = ?, price = ?, sell_price = ?, stock = ?, sku = ?, product_type = ?, status = ?, book_id = ?, updated_at = NOW(),
        isbn = ?, no_of_pages = ?, publication_date = ?
        ${imagePath ? ", main_image = ?" : ""}
      WHERE id = ?
    `;

    const params = imagePath
      ? [title, slug, description, price, sell_price, stock, sku, product_type, status, book_id || null, isbn, no_of_pages, publication_date, imagePath, id]
      : [title, slug, description, price, sell_price, stock, sku, product_type, status, book_id || null, isbn, no_of_pages, publication_date, id];

    db.query(`SELECT stock FROM products WHERE id = ?`, [id], (err, stockRows) => {
      const wasOutOfStock = !err && stockRows.length && Number(stockRows[0].stock) === 0;

      db.query(updateSql, params, (err) => {
        if (err) return res.status(500).json(err);

        if (wasOutOfStock && stock && parseInt(stock) > 0) {
          fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/stock-notifications/notify/${id}`, { method: "POST" })
          .catch((e) => console.error("Notify trigger failed:", e.message));
        }

        /* ---------------- SHIPPING ---------------- */
        db.query(`DELETE FROM shipping_details WHERE product_id = ?`, [id], () => {
          if (product_type === "physical" || product_type === "both") {
            db.query(`INSERT INTO shipping_details (product_id, weight, length, width, height) VALUES (?, ?, ?, ?, ?)`, [id, weight, length, width, height]);
          }
        });

        /* ---------------- SEO ---------------- */
        db.query(`DELETE FROM seo_meta WHERE page_type='product' AND page_id=?`, [id], () => {
          if (meta_title || meta_description || keywords) {
            db.query(`INSERT INTO seo_meta (page_type, page_id, meta_title, meta_description, keywords) VALUES ('product', ?, ?, ?, ?)`, [id, meta_title, meta_description, keywords]);
          }
        });

        /* ---------------- CATEGORIES ---------------- */
        db.query(`DELETE FROM product_categories WHERE product_id = ?`, [id], () => {
          if (categories) {
            JSON.parse(categories).forEach((catId) => {
              db.query(`INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)`, [id, catId]);
            });
          }
        });

        /* ---------------- ATTRIBUTES ---------------- */
        db.query(`DELETE FROM product_attributes WHERE product_id = ?`, [id], () => {
          if (attributes) {
            JSON.parse(attributes).forEach((attr) => {
              if (!attr.name || !attr.values) return;
              db.query(`INSERT IGNORE INTO attributes (name) VALUES (?)`, [attr.name], () => {
                db.query(`SELECT id FROM attributes WHERE name = ?`, [attr.name], (err, rows) => {
                  if (!rows?.length) return;
                  db.query(`INSERT INTO product_attributes (product_id, attribute_id, value) VALUES (?, ?, ?)`, [id, rows[0].id, attr.values]);
                });
              });
            });
            // REMOVED old ISBN UPDATE QUERY here since it's now handled in the main UPDATE above
          }
        });

        /* ---------------- AUTHORS ---------------- */
        db.query(`DELETE FROM product_authors WHERE product_id = ?`, [id], () => {
          if (authors) {
            JSON.parse(authors).forEach((authorId) => {
              db.query(`INSERT INTO product_authors (product_id, author_id) VALUES (?, ?)`, [id, authorId]);
            });
          }
        });

        /* ---------------- SUBJECTS ---------------- */
        db.query(`DELETE FROM product_subjects WHERE product_id = ?`, [id], () => {
          if (req.body.subjects) {
            JSON.parse(req.body.subjects).forEach((subjectId) => {
              db.query(`INSERT IGNORE INTO product_subjects (product_id, subject_id) VALUES (?, ?)`, [id, subjectId]);
            });
          }
        });

        /* ---------------- EBOOK ---------------- */
        if (product_type === "ebook" || product_type === "both") {
          // Fetch existing cover to make sure we don't accidentally wipe it
          db.query(`SELECT ebook_cover FROM ebooks WHERE product_id = ?`, [id], (err, coverRows) => {
            const existingCover = coverRows?.length ? coverRows[0].ebook_cover : null;
            const finalCoverPath = ebookCoverPath || existingCover;

            if (req.files?.ebook) {
              const ebookFile = req.files.ebook[0];
              const ext = path.extname(ebookFile.originalname).toLowerCase();
              const uploadPath = path.join(__dirname, "..", "uploads/ebooks");
              const originalPath = path.join(uploadPath, ebookFile.filename);

              db.query(`DELETE FROM ebooks WHERE product_id = ?`, [id], function () {
                if (ext === ".epub") {
                  db.query(
                    `INSERT INTO ebooks (product_id, file_path, file_type, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?, ?, ?)`,
                    [id, `/uploads/ebooks/${ebookFile.filename}`, "epub", ebook_price || null, ebook_sell_price || null, finalCoverPath]
                  );
                } else if (ext === ".docx") {
                  convertDocxToEpub({ originalPath, uploadPath, ebookFile, title }, function (error, result) {
                    if (error) return res.status(500).json({ message: "EPUB conversion failed", error: error.message });
                    fs.unlink(originalPath, () => {});
                    db.query(
                      `INSERT INTO ebooks (product_id, file_path, file_type, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?, ?, ?)`,
                      [id, `/uploads/ebooks/${result.epubFilename}`, "epub", ebook_price || null, ebook_sell_price || null, finalCoverPath],
                      function (err) {
                        if (err) return res.status(500).json({ message: "DB insert failed" });
                        res.json({ message: "Product fully updated", epub_created: true });
                      }
                    );
                  });
                } else {
                  console.log("Unsupported ebook format");
                }
              });
            } else {
              // Updates price and optionally cover if a new cover was uploaded without a new ebook file
              if (coverRows?.length > 0) {
                 db.query(
                   `UPDATE ebooks SET price = ?, sell_price = ?, ebook_cover = ? WHERE product_id = ?`, 
                   [ebook_price || null, ebook_sell_price || null, finalCoverPath, id]
                 );
              } else {
                 db.query(
                   `INSERT INTO ebooks (product_id, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?)`,
                   [id, ebook_price || null, ebook_sell_price || null, finalCoverPath]
                 );
              }
            }
          });
        }

        /* ---------------- GALLERY ---------------- */
        if (req.body.deletedGallery) {
          const deleted = JSON.parse(req.body.deletedGallery);
          if (deleted.length) {
            db.query(`DELETE FROM product_gallery WHERE id IN (?) AND product_id = ?`, [deleted, id]);
          }
        }

        if (req.body.existingGallery) {
          const existing = JSON.parse(req.body.existingGallery);
          existing.forEach(img => {
            db.query(`UPDATE product_gallery SET sort_order = ? WHERE id = ? AND product_id = ?`, [img.sort_order, img.id, id]);
          });
        }

        if (req.files?.gallery) {
          db.query(`SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM product_gallery WHERE product_id = ?`, [id], (err, rows) => {
            let start = rows[0].maxOrder + 1;
            req.files.gallery.forEach((file, index) => {
              db.query(`INSERT INTO product_gallery (product_id, image_path, sort_order) VALUES (?, ?, ?)`, [id, `/uploads/gallery/${file.filename}`, start + index]);
            });
          });
        }

        if (!req.files?.ebook || (req.files.ebook[0].originalname && !req.files.ebook[0].originalname.endsWith('.docx'))) {
           res.json({ message: "Product fully updated" });
        }
      });
    });
  }
);

/* ================= TRASH / DELETE ================= */
router.put("/:id/trash", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE products SET status = 'trash', updated_at = NOW() WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ message: "Failed to move to trash" });
    res.json({ message: "Product moved to trash" });
  });
});

router.delete("/:id", (req, res) => {
  const { id } = req.params;
  db.query("SELECT main_image FROM products WHERE id = ? AND status = 'trash'", [id], (err, rows) => {
    if (err) return res.status(500).json(err);
    if (!rows.length) return res.status(400).json({ message: "Only trashed products can be permanently deleted" });

    const imagePath = rows[0].main_image;
    db.query("DELETE FROM products WHERE id = ?", [id], (err) => {
      if (err) return res.status(500).json(err);
      if (imagePath) {
        const fullPath = path.join(__dirname, "..", imagePath);
        fs.unlink(fullPath, (err) => {
          if (err) console.log("Image delete error (maybe already deleted):", err.message);
        });
      }
      res.json({ message: "Product permanently deleted" });
    });
  });
});

/* ================= BULK ACTIONS ================= */
router.post("/bulk-status", (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: "No product IDs provided" });
  db.query(`UPDATE products SET status = ?, updated_at = NOW() WHERE id IN (?)`, [status, ids], (err) => {
    if (err) return res.status(500).json({ message: "Bulk status update failed" });
    res.json({ success: true });
  });
});

router.post("/bulk-category", (req, res) => {
  const { ids, categoryId } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: "No product IDs provided" });
  if (!categoryId) return res.status(400).json({ message: "No category selected" });

  db.query(`DELETE FROM product_categories WHERE product_id IN (?)`, [ids], (err) => {
    if (err) return res.status(500).json({ message: "Failed to update categories" });
    const values = ids.map((id) => [id, categoryId]);
    db.query(`INSERT INTO product_categories (product_id, category_id) VALUES ?`, [values], (err) => {
      if (err) return res.status(500).json({ message: "Failed to assign category" });
      
      // Force the updated_at timestamp to refresh
      db.query(`UPDATE products SET updated_at = NOW() WHERE id IN (?)`, [ids]);
      res.json({ success: true, message: "Categories updated" });
    });
  });
});

/* ================= CONVERT DOC (STANDALONE) ================= */
router.post("/convert-doc", upload.fields([{ name: "file", maxCount: 1 }, { name: "ebook_cover", maxCount: 1 }]), (req, res) => {
  const file = req.files?.file ? req.files.file[0] : null;
  if (!file) return res.status(400).json({ message: "No file uploaded" });

  const productId = req.body.product_id ? Number(req.body.product_id) : null;
  const isEdit = !!productId;

  const {
    title, description, price, sell_price, stock, sku, product_type, status,
    weight, length, width, height, ebook_price, ebook_sell_price, meta_title,
    meta_description, keywords, book_id
  } = req.body;

  const ebookCoverPath = req.files?.ebook_cover ? `/uploads/products/${req.files.ebook_cover[0].filename}` : null;
  const categories = JSON.parse(req.body.categories || "[]");
  const authors = JSON.parse(req.body.authors || "[]");
  const attributes = JSON.parse(req.body.attributes || "[]");

  const generateDraftSlugIfNeeded = (callback) => {
    if (req.body.slug && req.body.slug.trim() !== "") return callback(req.body.slug.trim());
    db.query("SELECT COUNT(*) as total FROM products WHERE status = 'draft'", (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      callback(`draft-${result[0].total + 1}`);
    });
  };

  if (isEdit) {
    return convertDocxToEpub({ originalPath: file.path, uploadPath: path.dirname(file.path), ebookFile: file, title }, function (error, result) {
      if (error) return res.status(500).json({ message: "Conversion failed", error: error.message });
      const epubPath = `/uploads/ebooks/${result.epubFilename}`;

      db.query(`UPDATE products SET product_type = ?, updated_at = NOW() WHERE id = ?`, [product_type, productId], function (err) {
        if (err) return res.status(500).json({ message: err.message });
        
        db.query(`SELECT id, ebook_cover FROM ebooks WHERE product_id = ?`, [productId], function (err, rows) {
          if (err) return res.status(500).json({ message: err.message });

          const finalCover = ebookCoverPath || (rows.length > 0 ? rows[0].ebook_cover : null);

          if (rows.length > 0) {
            db.query(
              `UPDATE ebooks SET file_path=?, file_type='epub', price=?, sell_price=?, ebook_cover=? WHERE product_id=?`,
              [epubPath, ebook_price || null, ebook_sell_price || null, finalCover, productId],
              function (err) {
                if (err) return res.status(500).json({ message: err.message });
                fs.unlink(file.path, () => {});
                return res.json({ message: "Ebook converted & updated", epubPath, productId });
              }
            );
          } else {
            db.query(
              `INSERT INTO ebooks (product_id, file_path, file_type, price, sell_price, ebook_cover) VALUES (?, ?, 'epub', ?, ?, ?)`,
              [productId, epubPath, ebook_price || null, ebook_sell_price || null, finalCover],
              function (err) {
                if (err) return res.status(500).json({ message: err.message });
                fs.unlink(file.path, () => {});
                return res.json({ message: "Ebook converted & inserted", epubPath, productId });
              }
            );
          }
        });
      });
    });
  }

  createProductIfNeeded((finalProductId) => {
    db.query(`INSERT INTO shipping_details (product_id, weight, length, width, height) VALUES (?, ?, ?, ?, ?)`, [finalProductId, weight || null, length || null, width || null, height || null]);
    categories.forEach(catId => db.query(`INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)`, [finalProductId, catId]));
    authors.forEach(author => db.query(`INSERT INTO product_authors (product_id, author_id) VALUES (?, ?)`, [finalProductId, author.id]));
    attributes.forEach(attr => db.query(`INSERT INTO product_attributes (product_id, attribute_id, value) VALUES (?, ?, ?)`, [finalProductId, attr.id, attr.value]));
    db.query(`INSERT INTO seo_meta (page_type, page_id, meta_title, meta_description, keywords) VALUES ('product', ?, ?, ?, ?)`, [finalProductId, meta_title || null, meta_description || null, keywords || null]);

    convertDocxToEpub({ originalPath: file.path, uploadPath: path.dirname(file.path), ebookFile: file, title }, function (error, result) {
      if (error) return res.status(500).json({ message: "Conversion failed", error: error.message });
      const epubPath = `/uploads/ebooks/${result.epubFilename}`;
      
      db.query(
        `INSERT INTO ebooks (product_id, file_path, file_type, price, sell_price, ebook_cover) VALUES (?, ?, ?, ?, ?, ?)`,
        [finalProductId, epubPath, "epub", ebook_price || null, ebook_sell_price || null, ebookCoverPath],
        function (err) {
          if (err) return res.status(500).json({ message: err.message });
          res.json({ message: "Product created & converted", epubPath, productId: finalProductId });
        }
      );
    });
  });

  function createProductIfNeeded(callback) {
    if (productId) return callback(productId);
    
    let isbn = null;
    let no_of_pages = null;
    let publication_date = null;

    if (attributes) {
      const isbnAttr = attributes.find(a => a.name?.toLowerCase() === "isbn");
      if (isbnAttr?.value?.trim()) isbn = isbnAttr.value.trim();

      const pagesAttr = attributes.find(a => a.name?.toLowerCase() === "no. of pages");
      if (pagesAttr?.value?.trim()) no_of_pages = parseInt(pagesAttr.value.trim(), 10) || null;

      const dateAttr = attributes.find(a => a.name?.toLowerCase() === "publication date");
      if (dateAttr?.value?.trim()) publication_date = parseDate(dateAttr.value);
    }

    generateDraftSlugIfNeeded((finalSlug) => {
      db.query(
        `INSERT INTO products (title, slug, description, price, sell_price, stock, sku, product_type, status, book_id, isbn, no_of_pages, publication_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, finalSlug, description, price || null, sell_price || null, stock || null, sku || null, product_type, "draft", book_id || null, isbn, no_of_pages, publication_date],
        (err, result) => {
          if (err) return res.status(500).json({ message: err.message });
          callback(result.insertId);
        }
      );
    });
  }
});

module.exports = router;