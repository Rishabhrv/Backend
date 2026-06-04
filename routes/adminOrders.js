const express    = require("express");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const router     = express.Router();
const db         = require("../db");

const SECRET = "MY_SECRET_KEY";

const transporter = nodemailer.createTransport({
  host:           process.env.MAIL_HOST || "smtp.gmail.com",
  port:           Number(process.env.MAIL_PORT) || 587,
  secure:         Number(process.env.MAIL_PORT) === 465,
  pool:           true,   // ← reuse one authenticated connection
  maxConnections: 1,      // ← Gmail only allows 1 concurrent SMTP connection
  rateDelta:      2000,   // ← enforce at least 2s between messages
  rateLimit:      3,      // ← max 3 messages per rateDelta window
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ════════════════════════════════════════════════════════
   UNIFIED STATUS MAP
════════════════════════════════════════════════════════ */
const UNIFIED_MAP = {
  pending:          { orderStatus: "pending",   shippingStatus: null },
  paid:             { orderStatus: "paid",      shippingStatus: null },
  confirmed:        { orderStatus: "paid",      shippingStatus: "confirmed" },
  shipped:          { orderStatus: "shipped",   shippingStatus: "shipped" },
  out_for_delivery: { orderStatus: "shipped",   shippingStatus: "out_for_delivery" },
  delivered:        { orderStatus: "completed", shippingStatus: "delivered" },
  cancelled:        { orderStatus: "cancelled", shippingStatus: null },
};


/* ════════════════════════════════════════════════════════
   NEW AGPH EMAIL TEMPLATE (Refined Light Theme)
════════════════════════════════════════════════════════ */
function agphEmailTemplate(unifiedStatus, customer, order, tracking, courier, items = []) {
  const ACCENT = "#2563eb"; // Royal Blue
  const BG_SOFT = "#f8fafc";
  const TEXT_MAIN = "#1e293b";
  const TEXT_MUTED = "#64748b";

  const statusConfig = {
    confirmed: {
      subject:  `Order #${order.id} Confirmed — AGPH Books`,
      headline: "Order Confirmed",
      emoji:    "✅",
      body:     items.length > 0 && items.every(i => i.format === "ebook")
        ? `Your digital library is ready! Your eBook purchase is confirmed and available for immediate reading in your account.`
        : `Your order has been received and is being prepared for shipment. We'll notify you the moment it leaves our warehouse.`,
      accent:   ACCENT,
      badge:    "CONFIRMED",
    },
    shipped: {
      subject:  `Your order #${order.id} is on the way!`,
      headline: "Order Dispatched",
      emoji:    "📦",
      body:     `Great news! Your package has been handed over to <strong>${courier || "our courier partner"}</strong>.${
                  tracking ? ` You can track your journey with ID: <strong>${tracking}</strong>.` : ""
                }`,
      accent:   "#7c3aed",
      badge:    "SHIPPED",
    },
    out_for_delivery: {
      subject:  `Out for delivery: Order #${order.id}`,
      headline: "Arriving Today",
      emoji:    "🚚",
      body:     `Your package is with the delivery agent and will reach your doorstep today.`,
      accent:   "#ca8a04",
      badge:    "OUT FOR DELIVERY",
    },
    delivered: {
      subject:  `Delivered: Order #${order.id}`,
      headline: "Package Delivered",
      emoji:    "✨",
      body:     `Your order has been successfully delivered. We hope you enjoy your new books!`,
      accent:   "#16a34a",
      badge:    "DELIVERED",
    },
    cancelled: {
      subject:  `Update on Order #${order.id}`,
      headline: "Order Cancelled",
      emoji:    "✉️",
      body:     `Your order <strong>#${order.id}</strong> has been cancelled. If you didn't request this, please contact our support immediately.`,
      accent:   "#e11d48",
      badge:    "CANCELLED",
    },
  };

  const cfg = statusConfig[unifiedStatus];
  if (!cfg) return null;

  /* ── Item Rows ── */
  const itemRowsHTML = items.map((item) => {
    const isEbook = item.format === "ebook";
    const badgeStyle = isEbook 
      ? `background:#eff6ff; color:#2563eb;` 
      : `background:#f1f5f9; color:#475569;`;
    
    return `
      <tr>
        <td style="padding:16px; border-bottom:1px solid #f1f5f9;">
          <p style="margin:0; font-size:14px; font-weight:600; color:${TEXT_MAIN};">${item.title}</p>
          <span style="display:inline-block; margin-top:4px; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:700; text-transform:uppercase; ${badgeStyle}">${item.format}</span>
        </td>
        <td style="padding:16px; border-bottom:1px solid #f1f5f9; text-align:center; font-size:14px; color:${TEXT_MUTED};">x${item.quantity}</td>
        <td style="padding:16px; border-bottom:1px solid #f1f5f9; text-align:right; font-size:14px; font-weight:700; color:${TEXT_MAIN};">₹${(item.price * item.quantity).toFixed(2)}</td>
      </tr>`;
  }).join("");

  const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);

  return {
    subject: cfg.subject,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); }
    .header { background: ${BG_SOFT}; padding: 40px 30px; text-align: center; border-bottom: 1px solid #e2e8f0; }
    .content { padding: 40px 30px; }
    .footer { background: ${TEXT_MAIN}; padding: 30px; text-align: center; color: #94a3b8; font-size: 12px; }
    .button { display: inline-block; padding: 12px 24px; background: ${cfg.accent}; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 14px; }
  </style>
</head>
<body style="margin:0; padding:20px; background-color:#f1f5f9; font-family:'Inter', system-ui, sans-serif;">
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div style="font-size:24px; font-weight:800; color:${TEXT_MAIN}; letter-spacing:-0.5px; margin-bottom:10px;">AGPH <span style="color:${cfg.accent}">BOOKS</span></div>
      <div style="display:inline-block; padding:4px 12px; background:${cfg.accent}15; color:${cfg.accent}; border-radius:20px; font-size:11px; font-weight:800; letter-spacing:1px; margin-bottom:20px;">${cfg.badge}</div>
      <h1 style="margin:0; font-size:28px; color:${TEXT_MAIN};">${cfg.emoji} ${cfg.headline}</h1>
    </div>

    <!-- Body -->
    <div class="content">
      <p style="font-size:16px; color:${TEXT_MAIN}; font-weight:600; margin-top:0;">Hello ${customer.name},</p>
      <p style="font-size:15px; color:${TEXT_MUTED}; line-height:1.6; margin-bottom:30px;">${cfg.body}</p>

      <!-- Items Table -->
      <table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0; border-radius:8px; border-collapse:separate; overflow:hidden;">
        <tr style="background:${BG_SOFT};">
          <th align="left" style="padding:12px 16px; font-size:11px; color:${TEXT_MUTED}; text-transform:uppercase;">Product</th>
          <th align="center" style="padding:12px 16px; font-size:11px; color:${TEXT_MUTED}; text-transform:uppercase;">Qty</th>
          <th align="right" style="padding:12px 16px; font-size:11px; color:${TEXT_MUTED}; text-transform:uppercase;">Price</th>
        </tr>
        ${itemRowsHTML}
      </table>

      <!-- Summary -->
      <div style="margin-top:24px; padding:20px; background:${BG_SOFT}; border-radius:8px;">
        <table width="100%">
          <tr><td style="font-size:14px; color:${TEXT_MUTED};">Order ID</td><td align="right" style="font-size:14px; font-weight:700; color:${TEXT_MAIN};">#${order.id}</td></tr>
          ${orderDate ? `<tr><td style="font-size:14px; color:${TEXT_MUTED}; padding-top:8px;">Date</td><td align="right" style="font-size:14px; font-weight:700; color:${TEXT_MAIN}; padding-top:8px;">${orderDate}</td></tr>` : ''}
          <tr><td colspan="2" style="border-top:1px solid #e2e8f0; margin:12px 0; padding-top:12px;"></td></tr>
          <tr><td style="font-size:16px; font-weight:700; color:${TEXT_MAIN};">Total Amount</td><td align="right" style="font-size:18px; font-weight:800; color:${cfg.accent};">₹${order.total_amount}</td></tr>
        </table>
      </div>

      ${unifiedStatus === 'delivered' ? `
      <div style="text-align:center; margin-top:30px;">
        <p style="font-size:14px; color:${TEXT_MUTED}; margin-bottom:15px;">How was your experience?</p>
        <a href="${process.env.NEXT_PUBLIC_SITE_URL}/account/orders/${order.id}/review" class="button">Write a Review</a>
      </div>` : ''}
    </div>

    <!-- Footer -->
    <div class="footer">
      <p style="margin:0 0 10px; font-weight:700; color:#ffffff;">AGPH Books Store</p>
      <p style="margin:0;">You are receiving this because you made a purchase at store.agphbooks.com</p>
      <div style="margin-top:20px; border-top:1px solid #334155; padding-top:20px;">
        <a href="mailto:editor@agphbooks.com" style="color:${cfg.accent}; text-decoration:none;">Contact Support</a>
      </div>
    </div>
  </div>
</body>
</html>`,
  };
}

/* ════════════════════════════════════════════════════════
   AG CLASSICS EMAIL TEMPLATE  (dark / gold theme)
════════════════════════════════════════════════════════ */
function agClassicsEmailTemplate(unifiedStatus, customer, order, tracking, courier, items = []) {
  // Gold accent
  const GOLD   = "#c9a84c";
  const DARK   = "#000000";
  const DARK2  = "#ffffff";
  const MUTED  = "#262626";
  const LIGHT  = "#3b3b3b";
  const DIMMED = "rgba(232, 178, 29, 0.79)";

  const statusConfig = {
    confirmed: {
      subject:  `Order #${order.id} Confirmed — Thank you, ${customer.name}`,
      headline: "Order Confirmed",
      badge:    "CONFIRMED",
      body:     items.length > 0 && items.every(i => i.format === "ebook")
        ? `Your eBook order is confirmed. Your titles are now available instantly in <strong style="color:${GOLD};">My Books</strong> within your account. Thank you for choosing AG Classics.`
        : `We have received your order and it is now being prepared. You will receive another update once it has been dispatched.`,
    },
    shipped: {
      subject:  `Your AG Classics Order #${order.id} Has Been Shipped`,
      headline: "Your Order Is On Its Way",
      badge:    "SHIPPED",
      body:     `Your order has been entrusted to <strong style="color:${LIGHT};">${courier || "our courier partner"}</strong>.${
                  tracking ? ` You may track your parcel using tracking ID <strong style="color:${GOLD};">${tracking}</strong>.` : ""
                }`,
    },
    out_for_delivery: {
      subject:  `Your AG Classics Order #${order.id} Is Out for Delivery`,
      headline: "Out for Delivery",
      badge:    "OUT FOR DELIVERY",
      body:     `Your parcel is almost with you. It is out for delivery today — please ensure someone is available to receive it.`,
    },
    delivered: {
      subject:  `Your AG Classics Order #${order.id} Has Been Delivered`,
      headline: "Delivered",
      badge:    "DELIVERED",
      body:     `Your order has been delivered successfully. We hope these titles bring you great joy. Should you have any concerns, do not hesitate to reach out.`,
    },
    cancelled: {
      subject:  `Your AG Classics Order #${order.id} Has Been Cancelled`,
      headline: "Order Cancelled",
      badge:    "CANCELLED",
      body:     `We regret to inform you that your order <strong style="color:${LIGHT};">#${order.id}</strong> has been cancelled. If you believe this is in error, please contact us.${
                  order.total_amount > 0
                    ? ` Any payment made will be refunded within <strong style="color:${LIGHT};">5–7 business days</strong>.`
                    : ""}`,
    },
  };

  const cfg = statusConfig[unifiedStatus];
  if (!cfg) return null;

  /* ── Item rows ── */
  const itemRowsHTML = items.map((item) => {
    const formatBadge = item.format === "ebook"
      ? `<span style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${GOLD};background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.25);padding:2px 8px;border-radius:3px;">E-Book</span>`
      : `<span style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#a3a3a3;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);padding:2px 8px;border-radius:3px;">Paperback</span>`;
    const lineTotal = `₹${(Number(item.price) * Number(item.quantity)).toFixed(2)}`;
    return `
      <tr>
        <td style="padding:14px 20px;border-bottom:1px solid rgba(201,168,76,0.08);">
          <p style="margin:0 0 6px;font-size:13px;font-weight:400;color:${LIGHT};line-height:1.4;font-family:Georgia,serif;">${item.title}</p>
          ${formatBadge}
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid rgba(201,168,76,0.08);text-align:center;font-size:12px;color:#2d2d2d;white-space:nowrap;">× ${item.quantity}</td>
        <td style="padding:14px 20px;border-bottom:1px solid rgba(201,168,76,0.08);text-align:right;font-size:13px;font-weight:600;color:${GOLD};white-space:nowrap;">${lineTotal}</td>
      </tr>`;
  }).join("");

  const itemsTableHTML = items.length > 0 ? `
    <!-- Items -->
    <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#2d2d2d;text-transform:uppercase;letter-spacing:3px;">Items Ordered</p>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid rgba(201,168,76,0.15);border-radius:6px;overflow:hidden;margin-bottom:28px;border-collapse:separate;border-spacing:0;background:${DARK2};">
      <thead>
        <tr style="background:white;">
          <td style="padding:10px 20px;font-size:11px;font-weight:700;color:#2d2d2d;text-transform:uppercase;letter-spacing:2px;">Title</td>
          <td style="padding:10px 16px;font-size:11px;font-weight:700;color:#2d2d2d;text-transform:uppercase;letter-spacing:2px;text-align:center;">Qty</td>
          <td style="padding:10px 20px;font-size:11px;font-weight:700;color:#2d2d2d;text-transform:uppercase;letter-spacing:2px;text-align:right;">Total</td>
        </tr>
      </thead>
      <tbody>${itemRowsHTML}</tbody>
    </table>` : "";

  /* ── Order summary ── */
  const orderDate    = order.created_at
    ? new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })
    : "";
  const subtotal     = items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0);
  const shippingCost = Number(order.shipping_cost || 0);

  const summaryRowsArr = [
    orderDate && [`Order Date`, orderDate],
    courier   && [`Courier`,    courier],
    tracking  && [`Tracking ID`, tracking],
    [`Subtotal`,  `₹${subtotal.toFixed(2)}`],
    [`Shipping`,  shippingCost > 0 ? `₹${shippingCost.toFixed(2)}` : "Free"],
  ].filter(Boolean);

  const summaryRowsHTML = summaryRowsArr.map(([label, val]) => `
    <tr>
      <td style="font-size:11px;color:#2d2d2d;padding:7px 0;letter-spacing:0.5px;">${label}</td>
      <td style="font-size:11px;color:#a3a3a3;text-align:right;padding:7px 0;font-family:${label === "Tracking ID" ? "monospace" : "inherit"};">${val}</td>
    </tr>`).join("");

  const summaryHTML = `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid rgba(201,168,76,0.15);border-radius:6px;overflow:hidden;margin-bottom:28px;border-collapse:separate;border-spacing:0;">
      <tr><td style="background:white;padding:10px 20px;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#2d2d2d;text-transform:uppercase;letter-spacing:3px;">Order Summary</p>
      </td></tr>
      <tr><td style="background:${DARK2};padding:16px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:11px;color:#2d2d2d;padding:7px 0;letter-spacing:0.5px;">Order ID</td>
            <td style="font-size:11px;color:${GOLD};text-align:right;padding:7px 0;font-family:monospace;font-weight:700;">#${order.id}</td>
          </tr>
          ${summaryRowsHTML}
          <tr><td colspan="2" style="padding:10px 0 6px;">
            <div style="border-top:1px solid rgba(201,168,76,0.12);"></div>
          </td></tr>
          <tr>
            <td style="font-size:14px;font-weight:400;color:${LIGHT};padding:4px 0;letter-spacing:1px;font-family:Georgia,serif;">Total Paid</td>
            <td style="font-size:18px;font-weight:400;color:${GOLD};text-align:right;padding:4px 0;font-family:Georgia,serif;">₹${order.total_amount}</td>
          </tr>
        </table>
      </td></tr>
    </table>`;

  /* ── Cancellation notice ── */
  const cancelNoteHTML = unifiedStatus === "cancelled" ? `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-left:3px solid #8b3a3a;background:rgba(139,58,58,0.08);border-radius:4px;margin-bottom:28px;border-collapse:collapse;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#8b3a3a;text-transform:uppercase;letter-spacing:2px;">Cancellation Notice</p>
        <p style="margin:0;font-size:12px;color:#a37070;line-height:1.8;">
          If a payment was made, a refund will be processed to your original payment method within <strong style="color:#c09090;">5–7 business days</strong>.<br>
          Questions? Write to us at <a href="mailto:editor@agclassics.in" style="color:#8b3a3a;font-weight:600;">editor@agclassics.in</a>
        </p>
      </td></tr>
    </table>` : "";

  /* ── Ornament divider ── */
  const ornament = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
      <tr>
        <td style="width:40%;height:1px;background:rgba(201,168,76,0.1);"></td>
        <td style="width:20px;text-align:center;font-size:10px;color:rgba(201,168,76,0.3);">◆</td>
        <td style="height:1px;background:rgba(201,168,76,0.1);"></td>
      </tr>
    </table>`;

  return {
    subject: cfg.subject,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${cfg.subject}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:white;padding:40px 0;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0"
        style="max-width:580px;width:100%;background:${DARK};border-radius:4px;overflow:hidden;">

        <!-- ══ TOP GOLD LINE ══ -->
        <tr><td style="height:2px;background:linear-gradient(to right,transparent,${GOLD},transparent);"></td></tr>

        <!-- ══ HEADER ══ -->
        <tr><td style="padding:36px 40px 28px;background:${DARK};">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <!-- Brand -->
                <p style="margin:0 0 24px;font-size:11px;font-weight:400;color:${GOLD};letter-spacing:6px;text-transform:uppercase;">AG Classics</p>
                <!-- Badge -->
                <table cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
                  <tr><td style="border:1px solid rgba(201,168,76,0.3);padding:4px 12px;border-radius:3px;">
                    <span style="font-size:11px;font-weight:700;color:${GOLD};letter-spacing:3px;text-transform:uppercase;">${cfg.badge}</span>
                  </td></tr>
                </table>
                <!-- Headline -->
                <p style="margin:0 0 6px;font-size:30px;font-weight:300;color:${GOLD};font-family:Georgia,'Times New Roman',serif;line-height:1.2;font-style:italic;">${cfg.headline}</p>
                <p style="margin:0;font-size:11px;color:${GOLD};font-family:monospace;letter-spacing:1px;">Order #${order.id}</p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- ══ BODY ══ -->
        <tr><td style="padding:32px 40px 36px;background:${DARK2};">

          <!-- Greeting -->
          <p style="margin:0 0 6px;font-size:18px;font-weight:300;color:${LIGHT};font-family:Georgia,serif;font-style:italic;">Dear ${customer.name},</p>
          <p style="margin:0 0 32px;font-size:13px;color:#8a8a8a;line-height:1.9;">${cfg.body}</p>

          <!-- Cancellation notice -->
          ${cancelNoteHTML}

          <!-- Items -->
          ${itemsTableHTML}

          <!-- Summary -->
          ${summaryHTML}

          <!-- Review CTA — delivered only -->
          ${unifiedStatus === "delivered" ? `
          <table width="100%" cellpadding="0" cellspacing="0"
            style="border:1px solid rgba(201,168,76,0.2);background:rgba(201,168,76,0.03);border-radius:4px;margin-bottom:28px;border-collapse:collapse;">
            <tr><td style="padding:24px 28px;text-align:center;">
              <p style="margin:0 0 6px;font-size:14px;color:#a3a3a3;letter-spacing:2px;">✦ ✦ ✦ ✦ ✦</p>
              <p style="margin:8px 0 4px;font-size:16px;font-weight:300;color:${LIGHT};font-family:Georgia,serif;font-style:italic;">Share Your Thoughts</p>
              <p style="margin:0 0 20px;font-size:12px;color:#2d2d2d;line-height:1.8;">Your review helps fellow readers discover timeless works.</p>
              <a href="${process.env.NEXT_PUBLIC_AG_CLASSICS_URL || process.env.NEXT_PUBLIC_SITE_URL}/account/orders/${order.id}/review"
                style="display:inline-block;background:${GOLD};color:${DARK};font-size:10px;font-weight:700;padding:12px 32px;letter-spacing:3px;text-transform:uppercase;text-decoration:none;">Write a Review</a>
            </td></tr>
          </table>` : ""}

          ${ornament}

          <!-- Help -->
          <p style="margin:0;font-size:11px;color:#3a3a3e;line-height:1.9;text-align:center;">
            Need assistance? Write to us at
            <a href="mailto:editor@agclassics.in" style="color:${GOLD};text-decoration:none;font-weight:600;">editor@agclassics.in</a>
          </p>

        </td></tr>

        <!-- ══ FOOTER ══ -->
        <tr><td style="padding:20px 40px;background:${DARK};">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <p style="margin:0 0 2px;font-size:11px;color:rgba(201,168,76,0.5);letter-spacing:3px;text-transform:uppercase;">AG Classics</p>
                <p style="margin:0;font-size:10px;color:${GOLD};">© ${new Date().getFullYear()} All rights reserved.</p>
              </td>
              <td align="right" style="vertical-align:middle;">
                <a href="mailto:editor@agclassics.in" style="font-size:10px;color:${GOLD};text-decoration:none;letter-spacing:1px;">editor@agclassics.in</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- ══ BOTTOM GOLD LINE ══ -->
        <tr><td style="height:2px;background:linear-gradient(to right,transparent,${GOLD},transparent);"></td></tr>

      </table>
    </td></tr>
  </table>

</body>
</html>`,
  };
}

/* ════════════════════════════════════════════════════════
   ROUTE HELPER — pick the right template based on imprint
   Rules:
     • All items agclassics  → AG Classics template
     • All items agph        → AGPH template
     • Mixed                 → send both emails
════════════════════════════════════════════════════════ */
function buildEmailsForOrder(unifiedStatus, customer, order, tracking, courier, items) {
  const agphItems      = items.filter(i => i.imprint !== "agclassics");
  const classicsItems  = items.filter(i => i.imprint === "agclassics");

  const emails = [];

  if (agphItems.length > 0) {
    const tpl = agphEmailTemplate(unifiedStatus, customer, order, tracking, courier, agphItems);
    if (tpl) emails.push({ ...tpl, brand: "agph" });
  }

  if (classicsItems.length > 0) {
    const tpl = agClassicsEmailTemplate(unifiedStatus, customer, order, tracking, courier, classicsItems);
    if (tpl) emails.push({ ...tpl, brand: "agclassics" });
  }

  return emails;
}

/* ─── Admin Auth Middleware ─── */
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ msg: "Admin only" });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

/* ════════════════════════════════════════
   GET /api/admin/orders
════════════════════════════════════════ */
router.get("/orders", adminAuth, (req, res) => {
  db.query(
    `SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
            u.name AS user_name,
            s.courier, s.tracking_number, s.status AS shipping_status,
            GROUP_CONCAT(DISTINCT c.imprint) AS imprints
     FROM orders o
     LEFT JOIN users        u  ON u.id  = o.user_id
     LEFT JOIN shipping     s  ON s.order_id = o.id
     LEFT JOIN order_items  oi ON oi.order_id = o.id
     LEFT JOIN products     p  ON p.id  = oi.product_id
     LEFT JOIN product_categories pc ON pc.product_id = p.id
     LEFT JOIN categories   c  ON c.id  = pc.category_id
     GROUP BY o.id, u.name, s.courier, s.tracking_number, s.status
     ORDER BY o.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      res.json(rows.map(r => ({
        ...r,
        imprints: r.imprints ? r.imprints.split(",") : [],
      })));
    }
  );
});


/* ════════════════════════════════════════
   GET /api/admin/orders/:id
════════════════════════════════════════ */
router.get("/orders/:id", adminAuth, (req, res) => {
  const orderId = req.params.id;

  db.query(
    `SELECT o.id, o.total_amount, o.status, o.payment_status,
            o.razorpay_order_id, o.razorpay_payment_id,
            o.coupon_code, o.coupon_discount, o.created_at,
            u.id AS user_id, u.name, u.email, u.phone
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = ? LIMIT 1`,
    [orderId],
    (err, orderRows) => {
      if (err) return res.status(500).json({ msg: "DB error" });
      if (!orderRows.length) return res.status(404).json({ msg: "Order not found" });

      const order = orderRows[0];

      db.query(`SELECT * FROM order_address WHERE order_id = ? LIMIT 1`, [orderId], (err, addrRows) => {
        if (err) return res.status(500).json({ msg: "DB error" });

        // 1. Get the billing address row
        const billingAddress = addrRows[0] || {};
        
        // 2. Fetch phone from order_address, fallback to user profile phone
        const orderPhone = billingAddress.phone || order.phone;

        db.query(
          `SELECT p.title, p.main_image, oi.quantity, oi.price, oi.format,
                  GROUP_CONCAT(DISTINCT c.imprint ORDER BY c.imprint) AS imprint
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           LEFT JOIN product_categories pc ON pc.product_id = p.id
           LEFT JOIN categories c ON c.id = pc.category_id
           WHERE oi.order_id = ?
           GROUP BY oi.id, p.title, p.main_image, oi.quantity, oi.price, oi.format`,
          [orderId],
          (err, items) => {
            if (err) return res.status(500).json({ msg: "DB error" });

            // Normalise imprint: if any category is agclassics → mark as agclassics
            const normItems = items.map(i => ({
              ...i,
              imprint: (i.imprint || "").includes("agclassics") ? "agclassics" : "agph",
            }));

           // FETCH SHIPPING
            db.query(`SELECT * FROM shipping WHERE order_id = ? LIMIT 1`, [orderId], (err, shipRows) => {
              if (err) return res.status(500).json({ msg: "DB error" });

              // FETCH SYSTEM LOGS FOR TIMELINE
              db.query(
                `SELECT * FROM system_logs WHERE entity_type = 'order' AND entity_id = ? ORDER BY created_at DESC`,
                [orderId],
                (err, logs) => {
                  if (err) return res.status(500).json({ msg: "DB error" });

                  res.json({
                    order: {
                      id: order.id,
                      status: order.status,
                      payment_status: order.payment_status,
                      total_amount: order.total_amount,
                      created_at: order.created_at,
                      razorpay_order_id: order.razorpay_order_id,
                      razorpay_payment_id: order.razorpay_payment_id,
                      coupon_code: order.coupon_code,
                      coupon_discount: order.coupon_discount,
                    },
                    customer: { name: order.name, email: order.email, phone: orderPhone }, 
                    billing:  billingAddress,
                    shipping: shipRows[0] || {},
                    items: normItems,
                    logs: logs || [] // 🌟 Pass logs back to frontend
                  });
              });
            });
          }
        );
      });
    }
  );
});

/* ════════════════════════════════════════
   PUT /api/admin/orders/:id/unified-status
════════════════════════════════════════ */
router.put("/orders/:id/unified-status", adminAuth, async (req, res) => {
  const orderId = req.params.id;
  const { unifiedStatus, courier = "", tracking_number = "" } = req.body;

  // Safe fallback identification for the acting administrator profile
  const adminActorId = req.admin?.id || req.admin?.user_id || null;

  // 1. Validate
  const mapping = UNIFIED_MAP[unifiedStatus];
  if (!mapping) return res.status(400).json({ msg: "Invalid status" });

  const { orderStatus, shippingStatus } = mapping;

  // 2. Update orders.status
  db.query(`UPDATE orders SET status = ? WHERE id = ?`, [orderStatus, orderId], async (err) => {
    if (err) return res.status(500).json({ msg: "Failed to update order status" });

    // 3. Upsert shipping row
    const doShipping = (next) => {
      if (!shippingStatus) return next();

      const columnMap = {
        confirmed:        "confirmed_at",
        shipped:          "shipped_at",
        out_for_delivery: "out_for_delivery_at",
        delivered:        "delivered_at",
      };
      const timeCol = columnMap[shippingStatus];

      db.query(
        `INSERT INTO shipping (order_id, courier, tracking_number, status)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           courier         = VALUES(courier),
           tracking_number = VALUES(tracking_number),
           status          = VALUES(status),
           ${timeCol}      = NOW()`,
        [orderId, courier, tracking_number, shippingStatus],
        (err) => {
          if (err) return res.status(500).json({ msg: "Failed to update shipping" });
          next();
        }
      );
    };

    doShipping(async () => {
      const emailStatuses = ["confirmed", "shipped", "out_for_delivery", "delivered", "cancelled"];
      if (!emailStatuses.includes(unifiedStatus)) {
        return res.json({ msg: "Order status updated" });
      }

      // 4. Fetch order + customer
      db.query(
        `SELECT o.id, o.total_amount, o.created_at,
                u.name, u.email,
                COALESCE(s.shipping_cost, 0) AS shipping_cost
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN shipping s ON s.order_id = o.id
         WHERE o.id = ? LIMIT 1`,
        [orderId],
        (err, orderRows) => {
          if (err || !orderRows.length) {
            return res.json({ msg: "Status updated (email skipped)" });
          }

          const row      = orderRows[0];
          const customer = { name: row.name, email: row.email };
          const order    = {
            id:            row.id,
            total_amount:  row.total_amount,
            created_at:    row.created_at,
            shipping_cost: row.shipping_cost,
          };

          // 5. Fetch items WITH imprint via join on categories
          db.query(
            `SELECT p.title, oi.format, oi.quantity, oi.price,
                    GROUP_CONCAT(DISTINCT c.imprint ORDER BY c.imprint) AS imprint
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id
             LEFT JOIN product_categories pc ON pc.product_id = p.id
             LEFT JOIN categories c ON c.id = pc.category_id
             WHERE oi.order_id = ?
             GROUP BY oi.id, p.title, oi.format, oi.quantity, oi.price`,
            [orderId],
            async (err, items) => {
              const rawItems = (!err && Array.isArray(items)) ? items : [];

              // Normalise imprint per item
              const normItems = rawItems.map(i => ({
                ...i,
                imprint: (i.imprint || "").includes("agclassics") ? "agclassics" : "agph",
              }));

              // 6. Build brand-specific emails
              const emails = buildEmailsForOrder(
                unifiedStatus, customer, order,
                tracking_number, courier, normItems
              );

              // 7. Send customer emails
              for (const email of emails) {
                try {
                  const info = await transporter.sendMail({
                    from: `"${email.brand === "agclassics" ? "AG Classics" : "AGPH Books Store"}" <${process.env.MAIL_USER}>`,
                    to: customer.email,
                    subject: email.subject,
                    html: email.html,
                  });

                  if (info.rejected && info.rejected.length > 0) {
                    const detailsObj = {
                      brand: email.brand,
                      recipient_email: customer.email,
                      recipient_type: "customer",
                      subject: email.subject
                    };
                    db.query(
                      `INSERT INTO system_logs (event_type, entity_type, entity_id, actor_id, status, error_message, details) VALUES ('email_sent', 'order', ?, ?, 'failed', ?, CAST(? AS JSON))`,
                      [orderId, adminActorId, `Rejected by SMTP: ${info.rejected.join(", ")}`, JSON.stringify(detailsObj)]
                    );
                    console.error(`⚠️ Email rejected for: ${info.rejected.join(", ")}`);
                  } else {
                    const detailsObj = {
                      brand: email.brand,
                      recipient_email: customer.email,
                      recipient_type: "customer",
                      subject: email.subject,
                      message_id: info.messageId
                    };
                    db.query(
                      `INSERT INTO system_logs (event_type, entity_type, entity_id, actor_id, status, details) VALUES ('email_sent', 'order', ?, ?, 'success', CAST(? AS JSON))`,
                      [orderId, adminActorId, JSON.stringify(detailsObj)]
                    );
                  }

                } catch (mailErr) {
                  const detailsObj = {
                    brand: email.brand,
                    recipient_email: customer.email,
                    recipient_type: "customer",
                    subject: email.subject
                  };
                  db.query(
                    `INSERT INTO system_logs (event_type, entity_type, entity_id, actor_id, status, error_message, details) VALUES ('email_sent', 'order', ?, ?, 'failed', ?, CAST(? AS JSON))`,
                    [orderId, adminActorId, mailErr.message, JSON.stringify(detailsObj)]
                  );
                  console.error(`Mail send error (${email.brand}):`, mailErr.message);
                }
              }

              // 8. Admin notification — only for "confirmed"
              if (unifiedStatus === "confirmed") {
                const itemRowsAdmin = normItems.map(item => `
                  <tr>
                    <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#0f172a;font-weight:600;">${item.title}</td>
                    <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:center;">${item.format === "ebook" ? "eBook" : "Paperback"}</td>
                    <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:center;text-transform:capitalize;">${item.imprint}</td>
                    <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:center;">× ${item.quantity}</td>
                    <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;font-weight:700;text-align:right;">₹${(Number(item.price) * Number(item.quantity)).toFixed(2)}</td>
                  </tr>`).join("");

                const adminSubject = `[New Order] #${order.id} — ₹${order.total_amount} — ${customer.name}`;

                try {
                  const adminInfo = await transporter.sendMail({
                    from: `"AGPH Books Store" <${process.env.MAIL_USER}>`,
                    to: process.env.ADMIN_MAIL,
                    subject: adminSubject,
                    html: `
                      <div style="font-family:sans-serif;max-width:640px;margin:auto;background:#f8fafc;">
                        <div style="background:#0f172a;padding:20px 28px;border-radius:10px 10px 0 0;">
                          <p style="margin:0;font-size:18px;font-weight:800;color:#fff;">🛒 New Order Received</p>
                          <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;font-family:monospace;">Order #${order.id}</p>
                        </div>
                        <div style="background:#fff;border:2px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:24px 8px;">
                          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                            <tr><td style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:10px;" colspan="2">Customer Details</td></tr>
                            <tr><td style="font-size:13px;color:#64748b;padding:4px 0;width:120px;">Name</td><td style="font-size:13px;color:#0f172a;font-weight:700;">${customer.name}</td></tr>
                            <tr><td style="font-size:13px;color:#64748b;padding:4px 0;">Email</td><td style="font-size:13px;color:#0f172a;">${customer.email}</td></tr>
                            <tr><td style="font-size:13px;color:#64748b;padding:4px 0;">Order Total</td><td style="font-size:14px;color:#2563eb;font-weight:800;">₹${order.total_amount}</td></tr>
                          </table>
                          <p style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 10px;">Items Ordered</p>
                          <table width="100%" cellpadding="0" cellspacing="0"
                            style="border:2px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;margin-bottom:24px;">
                            <thead>
                              <tr style="background:#0f172a;">
                                <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Title</td>
                                <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Format</td>
                                <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Imprint</td>
                                <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Qty</td>
                                <td style="padding:10px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:right;">Total</td>
                              </tr>
                            </thead>
                            <tbody style="background:#fff;">${itemRowsAdmin}</tbody>
                          </table>
                          <p style="margin:0;font-size:12px;color:#94a3b8;">Automated notification · AGPH Books Admin</p>
                        </div>
                      </div>`,
                  });

                  if (adminInfo.rejected && adminInfo.rejected.length > 0) {
                    const detailsObj = {
                      brand: "agph",
                      recipient_email: process.env.ADMIN_MAIL,
                      recipient_type: "admin",
                      subject: adminSubject
                    };
                    db.query(
                      `INSERT INTO system_logs (event_type, entity_type, entity_id, actor_id, status, error_message, details) VALUES ('email_sent', 'order', ?, ?, 'failed', ?, CAST(? AS JSON))`,
                      [orderId, adminActorId, `Rejected by SMTP: ${adminInfo.rejected.join(", ")}`, JSON.stringify(detailsObj)]
                    );
                  } else {
                    const detailsObj = {
                      brand: "agph",
                      recipient_email: process.env.ADMIN_MAIL,
                      recipient_type: "admin",
                      subject: adminSubject,
                      message_id: adminInfo.messageId
                    };
                    db.query(
                      `INSERT INTO system_logs (event_type, entity_type, entity_id, actor_id, status, details) VALUES ('email_sent', 'order', ?, ?, 'success', CAST(? AS JSON))`,
                      [orderId, adminActorId, JSON.stringify(detailsObj)]
                    );
                  }

                } catch (mailErr) {
                  const detailsObj = {
                    brand: "agph",
                    recipient_email: process.env.ADMIN_MAIL,
                    recipient_type: "admin",
                    subject: adminSubject
                  };
                  db.query(
                    `INSERT INTO system_logs (event_type, entity_type, entity_id, actor_id, status, error_message, details) VALUES ('email_sent', 'order', ?, ?, 'failed', ?, CAST(? AS JSON))`,
                    [orderId, adminActorId, mailErr.message, JSON.stringify(detailsObj)]
                  );
                  console.error("Admin mail error:", mailErr.message);
                }
              }

              // ── THE MISSING BRACKETS WERE HERE ──
              res.json({ msg: "Order updated & customer notified" });
            }
          );
        }
      );
    });
  });
});

/* ════════════════════════════════════════
   PUT /api/admin/orders/:id/address
════════════════════════════════════════ */
router.put("/orders/:id/address", adminAuth, (req, res) => {
  const orderId = req.params.id;
  const { address, city, state, pincode, phone } = req.body;

  db.query(`SELECT id FROM order_address WHERE order_id = ?`, [orderId], (err, rows) => {
    if (err) return res.status(500).json({ msg: "Database error checking address" });

    if (rows.length > 0) {
      // Update ONLY the requested text, city, state, pincode, and phone columns
      const updateSql = `
        UPDATE order_address 
        SET address = ?, city = ?, state = ?, pincode = ?, phone = ?
        WHERE order_id = ?
      `;
      db.query(
        updateSql,
        [address, city, state, pincode, phone, orderId],
        (err) => {
          if (err) return res.status(500).json({ msg: "Failed to update address details" });
          return res.json({ msg: "Shipping address updated successfully" });
        }
      );
    } else {
      // Fallback insert if no address record exists yet
      const insertSql = `
        INSERT INTO order_address (order_id, address, city, state, pincode, phone)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      db.query(
        insertSql,
        [orderId, address, city, state, pincode, phone],
        (err) => {
          if (err) return res.status(500).json({ msg: "Failed to save address" });
          return res.json({ msg: "Shipping address created and saved" });
        }
      );
    }
  });
});





module.exports = router;
module.exports.agphEmailTemplate      = agphEmailTemplate;
module.exports.agClassicsEmailTemplate = agClassicsEmailTemplate;