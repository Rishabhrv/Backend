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
const rs      = (n) => `Rs. ${Number(n).toFixed(2)}`;
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
    INNER JOIN categories cat  ON cat.id = pc.category_id AND cat.imprint = 'agclassics'
    WHERE o.id = ? AND o.user_id = ?
  `;

  db.query(sql, [orderId, userId], (err, rows) => {
    if (err)          return res.status(500).json(err);
    if (!rows.length) return res.status(404).json({ msg: "Order not found" });

    const o     = rows[0];
    const items = rows;
    const txnId = o.transaction_id || o.razorpay_payment_id || "N/A";

    /* ── PDFKit: (0,0) = TOP-LEFT, y increases DOWNWARD ── */
    const doc = new PDFDocument({ margin: 0, size: "A4", bufferPages: true });
    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${orderId}.pdf"`);
    doc.pipe(res);

    const PW = 595.28;
    const PH = 841.89;
    const ML = 48;
    const MR = PW - 48;
    const CW = MR - ML;

    /* ── Palette ── */
    const BG       = "#0a0a0b";
    const SURFACE  = "#141416";
    const SURFACE2 = "#1a1a1c";
    const GOLD     = "#c9a84c";
    const GOLD_DIM = "#3a3220";
    const WHITE    = "#f5f0e8";
    const MUTED    = "#5a5660";
    const GREEN    = "#4ade80";
    const GREEN_BG = "#0d2b1a";
    const RED_SOFT = "#f87171";

    /* ── Drawing helpers — all Y measured from TOP ── */
    const fillRect = (x, y, w, h, color) =>
      doc.save().rect(x, y, w, h).fill(color).restore();

    const strokeRect = (x, y, w, h, color, lw = 0.5) =>
      doc.save().lineWidth(lw).rect(x, y, w, h).stroke(color).restore();

    const hline = (y, color = GOLD_DIM, lw = 0.5, x1 = ML, x2 = MR) =>
      doc.save().moveTo(x1, y).lineTo(x2, y)
         .strokeColor(color).lineWidth(lw).stroke().restore();

    const diamond = (cx, cy, size = 3) =>
      doc.save().fillColor(GOLD)
         .moveTo(cx, cy - size).lineTo(cx + size, cy)
         .lineTo(cx, cy + size).lineTo(cx - size, cy)
         .closePath().fill().restore();

    const dot = (cx, cy, r = 1.3) =>
      doc.save().circle(cx, cy, r).fill(GOLD).restore();

    /* Text helper — x,y = TOP-LEFT of text block */
    const t = (text, x, y, opts = {}) => {
      const { font = "Helvetica", size = 8.5, color = WHITE,
              align = "left", width = 200 } = opts;
      doc.save()
         .font(font).fontSize(size).fillColor(color)
         .text(String(text), x, y, { width, align, lineBreak: false })
         .restore();
    };

    /* ════════════════════════════════════
       FULL PAGE BACKGROUND
    ════════════════════════════════════ */
    fillRect(0, 0, PW, PH, BG);

    /* Subtle side gutter accents */
    doc.save().fillColor(GOLD).fillOpacity(0.025).rect(0, 0, 6, PH).fill().restore();
    doc.save().fillColor(GOLD).fillOpacity(0.025).rect(PW - 6, 0, 6, PH).fill().restore();

    /* ════════════════════════════════════
       TOP GOLD BAR  (y=0)
    ════════════════════════════════════ */
    fillRect(0, 0, PW, 4, GOLD);

    /* Soft glow below bar */
    for (let i = 0; i < 10; i++) {
      doc.save().fillColor(GOLD).fillOpacity(0.012 - i * 0.001)
         .rect(0, 4 + i * 6, PW, 6).fill().restore();
    }

    /* ════════════════════════════════════
       HEADER  (top of page, y=20)
    ════════════════════════════════════ */
    let y = 20;

    /* AG monogram box */
    fillRect(ML, y, 44, 44, GOLD);
    t("AG", ML, y + 13, { font: "Helvetica-Bold", size: 17, color: BG, align: "center", width: 44 });

    /* Company name + tagline */
    t("AG CLASSICS", ML + 54, y + 10,
      { font: "Helvetica-Bold", size: 15, color: WHITE, width: 250 });
    t("www.agclassics.in  ·  support@agclassics.in", ML + 54, y + 29,
      { font: "Helvetica", size: 7.5, color: WHITE, width: 300 });

    /* Invoice badge — top right */
    const bdgW = 118, bdgH = 36;
    fillRect(MR - bdgW, y, bdgW, bdgH, SURFACE2);
    strokeRect(MR - bdgW, y, bdgW, bdgH, GOLD, 0.7);
    t("INVOICE", MR - bdgW, y + 9,
      { font: "Helvetica-Bold", size: 13, color: GOLD, align: "center", width: bdgW });
    t(`# ${o.order_id}`, MR - bdgW, y + 25,
      { font: "Helvetica", size: 7.5, color: WHITE, align: "center", width: bdgW });

    /* Section divider */
    y += 56;
    hline(y, GOLD_DIM, 0.7);
    diamond(ML, y, 3);
    diamond(PW / 2, y, 3);
    diamond(MR, y, 3);

    /* ════════════════════════════════════
       BILLED TO  +  ORDER DETAILS
    ════════════════════════════════════ */
    y += 14;
    const INFO_TOP = y;
    const RX = ML + CW * 0.52;

    /* Left — Billed To */
    t("BILLED TO", ML, y, { font: "Helvetica-Bold", size: 7, color: GOLD, width: 200 });
    y += 13;

    const fullName = `${o.first_name || ""} ${o.last_name || ""}`.trim() || "Customer";
    t(fullName, ML, y, { font: "Helvetica-Bold", size: 11, color: WHITE, width: CW * 0.46 });
    y += 14;

    const addrLines = [
      o.address,
      o.city ? `${o.city}, ${o.state} – ${o.pincode}` : null,
      o.phone ? `Phone: ${o.phone}` : null,
      o.shipping_email ? `Email: ${o.shipping_email}` : null,
    ].filter(Boolean);

    addrLines.forEach((line) => {
      t(line, ML, y, { font: "Helvetica", size: 8, color: WHITE, width: CW * 0.46 });
      y += 12;
    });

    const leftBottom = y;

    /* Right — Order Details (starts at same INFO_TOP) */
    let ry = INFO_TOP;
    t("ORDER DETAILS", RX, ry, { font: "Helvetica-Bold", size: 7, color: GOLD, width: 200 });
    ry += 13;

    const details = [
      ["Invoice No.",     `#${o.order_id}`],
      ["Date",            fmtDate(o.created_at)],
      ["Payment Method",  o.payment_method || "Razorpay"],
      ["Transaction ID",  txnId.length > 24 ? txnId.slice(0, 24) + "…" : txnId],
      ["Status",          (o.payment_status || "").toUpperCase()],
    ];

    details.forEach(([lbl, val]) => {
      t(lbl, RX,      ry, { font: "Helvetica",      size: 7.5, color: WHITE, width: 86 });
      t(val, RX + 90, ry, {
        font: "Helvetica-Bold", size: 8,
        color: lbl === "Status" ? GREEN : WHITE,
        width: CW * 0.46 - 90,
      });
      ry += 14;
    });

    y = Math.max(leftBottom, ry) + 10;
    hline(y, GOLD_DIM, 0.5);

    /* ════════════════════════════════════
       ITEMS TABLE
    ════════════════════════════════════ */
    y += 12;

      const COL = {
      no:    { x: ML,       w: 18  },
      title: { x: ML + 22,  w: 200 },
      fmt:   { x: ML + 226, w: 62  },
      qty:   { x: ML + 292, w: 30  },
      price: { x: ML + 326, w: 72  },
      total: { x: ML + 397, w: CW - 402 },        // <-- Corrected width
    };

    /* Header row */
    const HDR_H = 22;
    fillRect(ML, y, CW, HDR_H, SURFACE2);
    hline(y,          GOLD, 0.7);
    hline(y + HDR_H,  GOLD, 0.7);

    [
      ["#",          COL.no,    "center"],
      ["ITEM",       COL.title, "left"],
      ["FORMAT",     COL.fmt,   "center"],
      ["QTY",        COL.qty,   "center"],
      ["UNIT PRICE", COL.price, "right"],
      ["AMOUNT",     COL.total, "right"],
    ].forEach(([label, col, align]) => {
      t(label, col.x, y + 7,
        { font: "Helvetica-Bold", size: 7, color: GOLD, align, width: col.w });
    });

    y += HDR_H;

    /* Item rows */
    items.forEach((item, idx) => {
      const ROW_H = 26;
      fillRect(ML, y, CW, ROW_H, idx % 2 === 0 ? SURFACE : SURFACE2);
      if (idx % 2 === 0) fillRect(ML, y, 2, ROW_H, GOLD_DIM);  // left accent

      const rowY = y + 9;
      const amt  = Number(item.price) * Number(item.quantity);

      t(String(idx + 1),           COL.no.x,    rowY, { size: 8,   color: WHITE,  align: "center", width: COL.no.w });
      t(item.title,                COL.title.x, rowY, { size: 8.5, color: WHITE,  width: COL.title.w });
      t(item.format.toUpperCase(), COL.fmt.x,   rowY, { size: 7.5, color: WHITE,  align: "center", width: COL.fmt.w });
      t(String(item.quantity),     COL.qty.x,   rowY, { size: 8.5, color: WHITE,  align: "center", width: COL.qty.w });
      t(rs(item.price),            COL.price.x, rowY, { size: 8.5, color: WHITE,  align: "right",  width: COL.price.w });
      t(rs(amt),                   COL.total.x, rowY, {
        font: "Helvetica-Bold", size: 8.5, color: WHITE, align: "right", width: COL.total.w,
      });

      y += ROW_H;
    });

    hline(y, GOLD_DIM, 0.5);
    y += 16;

    /* ════════════════════════════════════
       TOTALS BLOCK
    ════════════════════════════════════ */
    const TX   = MR - 210;
    const LBLW = 110;
    const VX   = TX + LBLW + 6;
    const VW   = 210 - LBLW - 6;

    const subtotal   = Number(o.total_amount) - Number(o.shipping_cost) + Number(o.coupon_discount || 0);
    const shipping   = Number(o.shipping_cost);
    const discount   = Number(o.coupon_discount || 0);
    const grandTotal = Number(o.total_amount);

    const totRow = (lbl, val, valColor = WHITE) => {
      t(lbl, TX,  y, { size: 8.5, color: WHITE,    align: "right", width: LBLW });
      t(val, VX,  y, { size: 8.5, color: valColor, align: "right", width: VW   });
      y += 16;
    };

    totRow("Subtotal", rs(subtotal));
    if (shipping > 0) totRow("Shipping", rs(shipping));
    if (discount  > 0) totRow(`Coupon (${o.coupon_code || ""})`, `- ${rs(discount)}`, RED_SOFT);

    hline(y, GOLD_DIM, 0.5, TX, MR);
    y += 8;

    /* Grand total gold bar */
    fillRect(TX - 8, y, MR - TX + 8, 30, GOLD);
    t("TOTAL AMOUNT", TX - 8, y + 9,
      { font: "Helvetica-Bold", size: 8,  color: BG, align: "right", width: LBLW + 8 });
    t(rs(grandTotal), VX, y + 8,
      { font: "Helvetica-Bold", size: 12, color: BG, align: "right", width: VW });

    /* Payment confirmed badge — left, vertically centred with grand total bar */
    if (o.payment_status === "success") {
      fillRect(ML, y + 4, 154, 22, GREEN_BG);
      strokeRect(ML, y + 4, 154, 22, "#166534", 0.5);
      t("✓  PAYMENT CONFIRMED", ML, y + 12,
        { font: "Helvetica-Bold", size: 7.5, color: GREEN, align: "center", width: 154 });
    }

    y += 48;

    /* ════════════════════════════════════
       ORNAMENTAL DIVIDER
    ════════════════════════════════════ */
    hline(y, GOLD_DIM, 0.5);
    diamond(PW / 2, y, 3);
    dot(PW / 2 - 14, y);
    dot(PW / 2 + 14, y);
    y += 14;

    /* ════════════════════════════════════
       THANK-YOU NOTE
    ════════════════════════════════════ */
    t("Thank you for your order. We hope you enjoy your classics.",
      ML, y, { font: "Helvetica", size: 8, color: WHITE, align: "center", width: CW });
    y += 12;
    t("For any queries, write to us at  support@agclassics.in",
      ML, y, { font: "Helvetica", size: 7.5, color: WHITE, align: "center", width: CW });

    /* ════════════════════════════════════
       FOOTER  (pinned to page bottom)
    ════════════════════════════════════ */
    fillRect(0, PH - 28, PW, 28, SURFACE2);
    hline(PH - 28, GOLD_DIM, 0.5, 0, PW);
    t("AG CLASSICS  ·  Computer-generated invoice  ·  No signature required",
      0, PH - 17, { font: "Helvetica", size: 7, color: WHITE, align: "center", width: PW });

    /* Rotated watermark along left edge */
    doc.save()
       .fillColor(GOLD).fillOpacity(0.04)
       .font("Helvetica-Bold").fontSize(7)
       .translate(10, PH / 2)
       .rotate(-90)
       .text(
         "AG CLASSICS  ·  LITERARY ARCHIVE  ·  DIGITAL LIBRARY  ·  TIMELESS WORKS",
         -180, 0, { lineBreak: false }
       )
       .restore();

    doc.end();
  });
});

module.exports = router;