/**
 * Invoice Route  —  GET /api/orders/:orderId/invoice
 *
 * Install:  npm install pdfkit
 *
 * Register in app.js BEFORE the existing orders router:
 *   const invoiceRouter = require('./routes/invoice');
 *   app.use('/api/orders', invoiceRouter);
 */

const express     = require("express");
const router      = express.Router();
const PDFDocument = require("pdfkit");
const db          = require("../db");
const jwt         = require("jsonwebtoken");

const SECRET = "MY_SECRET_KEY";

/* ─── AUTH ─────────────────────────────────────────────── */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid token" });
    req.user = decoded;
    next();
  });
};

/* ─── HELPERS ───────────────────────────────────────────── */
const rs  = (n) => `Rs. ${Number(n).toFixed(2)}`;

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });

/* ─── ROUTE ─────────────────────────────────────────────── */
router.get("/:orderId/invoice", auth, (req, res) => {
  const userId  = req.user.id;
  const orderId = req.params.orderId;

  const sql = `
    SELECT
      o.id               AS order_id,
      o.total_amount,
      o.payment_status,
      o.created_at,
      o.coupon_code,
      o.coupon_discount,
      o.razorpay_payment_id,

      p.payment_method,
      p.transaction_id,
      p.amount           AS paid_amount,

      oi.product_id,
      oi.quantity,
      oi.price,
      oi.format,

      pr.title,

      COALESCE(s.shipping_cost, 0) AS shipping_cost,

      oa.first_name,
      oa.last_name,
      oa.address,
      oa.city,
      oa.state,
      oa.pincode,
      oa.phone,
      oa.email AS shipping_email

    FROM orders o
    JOIN order_items oi        ON oi.order_id    = o.id
    JOIN products pr           ON pr.id          = oi.product_id
    LEFT JOIN payments p       ON p.order_id     = o.id
    LEFT JOIN shipping s       ON s.order_id     = o.id
    LEFT JOIN order_address oa ON oa.order_id    = o.id
    INNER JOIN product_categories pc ON pc.product_id = pr.id
    INNER JOIN categories cat  ON cat.id = pc.category_id AND cat.imprint = 'agph'

    WHERE o.id = ? AND o.user_id = ?
  `;

  db.query(sql, [orderId, userId], (err, rows) => {
    if (err)          return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ msg: "Order not found" });

    const o     = rows[0];
    const items = rows;

    /* Resolve payment ID from payments table or orders table */
    const txnId = o.transaction_id || o.razorpay_payment_id || "N/A";

    /* ── Document setup ── */
    const doc = new PDFDocument({ margin: 0, size: "A4", bufferPages: true });

    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${orderId}.pdf"`);
    doc.pipe(res);

    /* ── Layout constants ── */
    const PW = 595.28;
    const PH = 841.89;
    const ML = 48;          // left margin
    const MR = PW - 48;     // right margin
    const CW = MR - ML;     // 499 pts usable

    /* ── Palette ── */
    const C_DARK   = "#111827";
    const C_ACCENT = "#4F46E5";   // indigo
    const C_MUTED  = "#6B7280";
    const C_BORDER = "#E5E7EB";
    const C_ALT    = "#F8FAFC";
    const C_WHITE  = "#FFFFFF";
    const C_TEXT   = "#374151";

    /* ─── util ─── */
    const hline = (y, color = C_BORDER, w = 0.5) =>
      doc.save().strokeColor(color).lineWidth(w)
         .moveTo(ML, y).lineTo(MR, y).stroke().restore();

    const labelVal = (label, value, lx, vx, y, vw = 180) => {
      doc.font("Helvetica").fontSize(8).fillColor(C_MUTED)
         .text(label, lx, y, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C_DARK)
         .text(value, vx, y, { width: vw, lineBreak: false });
    };

    /* ══════════════════════════════════════
       1.  TOP STRIPE  (thin indigo line)
    ══════════════════════════════════════ */
    doc.rect(0, 0, PW, 5).fill(C_ACCENT);

    /* ══════════════════════════════════════
       2.  HEADER
    ══════════════════════════════════════ */
    let y = 24;

    /* Company name */
    doc.font("Helvetica-Bold").fontSize(20).fillColor(C_DARK)
       .text("AGPH Books", ML, y);

    doc.font("Helvetica").fontSize(8).fillColor(C_MUTED)
       .text("www.agphbooks.com  ·  editor@agphbooks.com", ML, y + 24);

    /* Invoice badge – top right */
    const bdgW = 110, bdgH = 30;
    doc.roundedRect(MR - bdgW, y, bdgW, bdgH, 5).fill(C_ACCENT);
    doc.font("Helvetica-Bold").fontSize(14).fillColor(C_WHITE)
       .text("INVOICE", MR - bdgW, y + 8, { width: bdgW, align: "center" });

    /* Invoice number under badge */
    doc.font("Helvetica").fontSize(8).fillColor(C_MUTED)
       .text(`#${o.order_id}`, MR - bdgW, y + bdgH + 5, { width: bdgW, align: "center" });

    y += 58;
    hline(y, C_BORDER, 1);

    /* ══════════════════════════════════════
       3.  BILLED-TO  +  ORDER DETAILS  (two columns)
    ══════════════════════════════════════ */
    y += 16;
    const RX = ML + CW * 0.52;  // right column start

    /* ── Left: Billed to ── */
    doc.font("Helvetica-Bold").fontSize(7).fillColor(C_ACCENT)
       .text("BILLED TO", ML, y);
    y += 13;

    const fullName = `${o.first_name || ""} ${o.last_name || ""}`.trim() || "Customer";
    doc.font("Helvetica-Bold").fontSize(10).fillColor(C_DARK).text(fullName, ML, y);
    y += 13;

    doc.font("Helvetica").fontSize(8.5).fillColor(C_TEXT);
    if (o.address)        { doc.text(o.address,                              ML, y, { width: CW * 0.48 }); y += 12; }
    if (o.city)           { doc.text(`${o.city}, ${o.state} – ${o.pincode}`, ML, y); y += 12; }
    if (o.phone)          { doc.text(`Phone: ${o.phone}`,                    ML, y); y += 12; }
    if (o.shipping_email) { doc.text(`Email: ${o.shipping_email}`,           ML, y); y += 12; }

    /* ── Right: Order info ── */
    let ry = y - (12 * (4 + (o.address ? 1 : 0))) - 13;  // align with name
    ry = 98;  // fixed starting Y for right column (below the divider)

    doc.font("Helvetica-Bold").fontSize(7).fillColor(C_ACCENT)
       .text("ORDER DETAILS", RX, ry);
    ry += 13;

    const details = [
      ["Invoice No.",     `#${o.order_id}`],
      ["Date",            fmtDate(o.created_at)],
      ["Payment Method",  o.payment_method || "Razorpay"],
      ["Transaction ID",  txnId],
      ["Status",          (o.payment_status || "").toUpperCase()],
    ];

    details.forEach(([lbl, val]) => {
      doc.font("Helvetica").fontSize(8).fillColor(C_MUTED)
         .text(lbl, RX, ry, { width: 90 });
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C_DARK)
         .text(val, RX + 95, ry, { width: CW * 0.48 - 95 });
      ry += 15;
    });

    /* Adjust y to the taller of the two columns */
    y = Math.max(y, ry) + 10;
    hline(y, C_BORDER, 1);

    /* ══════════════════════════════════════
       4.  ITEMS TABLE
    ══════════════════════════════════════ */
    y += 12;

    /* Column layout (x positions, widths) */
    const C = {
      no:     { x: ML,       w: 20,  align: "center" },
      title:  { x: ML + 24,  w: 215, align: "left"   },
      fmt:    { x: ML + 243, w: 64,  align: "center" },
      qty:    { x: ML + 311, w: 32,  align: "center" },
      price:  { x: ML + 347, w: 70,  align: "right"  },
      total:  { x: ML + 420, w: 79,  align: "right"  },
    };

    const HDR_H = 22;
    doc.rect(ML, y, CW, HDR_H).fill(C_DARK);

    const hdrLabels = [
      ["#",       C.no],
      ["Item",    C.title],
      ["Format",  C.fmt],
      ["Qty",     C.qty],
      ["Unit Price", C.price],
      ["Amount",  C.total],
    ];

    hdrLabels.forEach(([txt, col]) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C_WHITE)
         .text(txt, col.x, y + 7, { width: col.w, align: col.align, lineBreak: false });
    });

    y += HDR_H;

    /* ── Row renderer ── */
    items.forEach((item, idx) => {
      /* Measure title height to determine row height */
      const titleH = doc.font("Helvetica").fontSize(8.5)
                        .heightOfString(item.title, { width: C.title.w });
      const RH = Math.max(24, titleH + 12);

      /* Alternating background */
      doc.rect(ML, y, CW, RH).fill(idx % 2 === 0 ? C_WHITE : C_ALT);

      const midY = y + RH / 2 - 5;
      const rowAmt = Number(item.price) * Number(item.quantity);

      doc.font("Helvetica").fontSize(8.5).fillColor(C_MUTED)
         .text(idx + 1, C.no.x, midY, { width: C.no.w, align: "center", lineBreak: false });

      /* Title – wrapped */
      doc.font("Helvetica").fontSize(8.5).fillColor(C_DARK)
         .text(item.title, C.title.x, y + 6, { width: C.title.w });

      doc.font("Helvetica").fontSize(8).fillColor(C_MUTED)
         .text(item.format.toUpperCase(), C.fmt.x, midY, { width: C.fmt.w, align: "center", lineBreak: false });

      doc.font("Helvetica").fontSize(8.5).fillColor(C_TEXT)
         .text(item.quantity, C.qty.x, midY, { width: C.qty.w, align: "center", lineBreak: false });

      doc.font("Helvetica").fontSize(8.5).fillColor(C_TEXT)
         .text(rs(item.price), C.price.x, midY, { width: C.price.w, align: "right", lineBreak: false });

      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C_DARK)
         .text(rs(rowAmt), C.total.x, midY, { width: C.total.w, align: "right", lineBreak: false });

      y += RH;
    });

    /* Bottom border of table */
    doc.rect(ML, y, CW, 1).fill(C_BORDER);
    y += 14;

    /* ══════════════════════════════════════
       5.  TOTALS BLOCK  (right side)
    ══════════════════════════════════════ */
    const TBLOCK_X  = MR - 220;
    const LABEL_W   = 110;
    const VAL_X     = TBLOCK_X + LABEL_W + 8;
    const VAL_W     = 220 - LABEL_W - 8;

    const subtotal   = Number(o.total_amount)
                     - Number(o.shipping_cost)
                     + Number(o.coupon_discount || 0);
    const shipping   = Number(o.shipping_cost);
    const discount   = Number(o.coupon_discount || 0);
    const grandTotal = Number(o.total_amount);

    const totRow = (lbl, val, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5)
         .fillColor(C_MUTED)
         .text(lbl, TBLOCK_X, y, { width: LABEL_W, align: "right" });
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5)
         .fillColor(bold ? C_DARK : C_TEXT)
         .text(val, VAL_X, y, { width: VAL_W, align: "right" });
      y += 16;
    };

    totRow("Subtotal",   rs(subtotal));
    if (shipping > 0)  totRow("Shipping",                         rs(shipping));
    if (discount  > 0) totRow(`Coupon (${o.coupon_code || ""})`,  `- ${rs(discount)}`);

    hline(y, C_BORDER, 0.5);
    y += 8;

    /* Grand total */
    doc.rect(TBLOCK_X - 8, y - 4, MR - TBLOCK_X + 8, 28).fill(C_ACCENT);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C_WHITE)
       .text("TOTAL AMOUNT", TBLOCK_X - 8, y + 4, { width: LABEL_W + 8, align: "right" });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(C_WHITE)
       .text(rs(grandTotal), VAL_X, y + 3, { width: VAL_W, align: "right" });

    y += 36;

    /* Payment confirmed badge (left side, same row as totals) */
    if (o.payment_status === "success") {
      doc.roundedRect(ML, y - 36 + 4, 150, 22, 4).fill("#ECFDF5");
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#065F46")
         .text("✓  Payment Confirmed", ML + 10, y - 36 + 11);
    }

    /* ══════════════════════════════════════
       6.  THANK-YOU NOTE
    ══════════════════════════════════════ */
    y += 10;
    hline(y, C_BORDER, 1);
    y += 10;
    doc.font("Helvetica").fontSize(8).fillColor(C_MUTED)
       .text(
         "Thank you for shopping with AGPH Books. For any queries, reach us at editor@agphbooks.com",
         ML, y, { width: CW }
       );

    /* ══════════════════════════════════════
       7.  FOOTER  (pinned to bottom of page)
    ══════════════════════════════════════ */
    doc.rect(0, PH - 30, PW, 30).fill(C_DARK);
    doc.font("Helvetica").fontSize(7.5).fillColor("#9CA3AF")
       .text(
         "AGPH Books  ·  Computer-generated invoice  ·  No signature required",
         0, PH - 18,
         { width: PW, align: "center" }
       );

    doc.end();
  });
});

module.exports = router;