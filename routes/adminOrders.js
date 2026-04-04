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
   AGPH EMAIL TEMPLATE  (light theme — existing)
════════════════════════════════════════════════════════ */
function agphEmailTemplate(unifiedStatus, customer, order, tracking, courier, items = []) {
  const statusConfig = {
    confirmed: {
      subject:  `Order #${order.id} Confirmed — Thank you, ${customer.name}!`,
      headline: "Order Confirmed",
      emoji:    "🎉",
      body:     items.length > 0 && items.every(i => i.format === "ebook")
        ? `Your eBook order is confirmed! Your purchase is now available — you can access your eBooks from your account. Thank you for shopping with us!`
        : `We've received your order and it's now being processed. You'll get another update once it ships.`,
      accent:   "#2563eb",
      badge:    "CONFIRMED",
    },
    shipped: {
      subject:  `Order #${order.id} has been Shipped!`,
      headline: "Your Order is On Its Way",
      emoji:    "📦",
      body:     `Your order has been handed over to <strong>${courier || "our courier partner"}</strong>.${
                  tracking ? ` Track it using ID <strong>${tracking}</strong>.` : ""
                }`,
      accent:   "#7c3aed",
      badge:    "SHIPPED",
    },
    out_for_delivery: {
      subject:  `Order #${order.id} is Out for Delivery!`,
      headline: "Out for Delivery",
      emoji:    "🚚",
      body:     `Your package is almost there! It's out for delivery and will arrive today. Please be available to receive it.`,
      accent:   "#d97706",
      badge:    "OUT FOR DELIVERY",
    },
    delivered: {
      subject:  `Order #${order.id} Delivered Successfully`,
      headline: "Delivered!",
      emoji:    "🎊",
      body:     `Your order has been delivered successfully. We hope you love your purchase! Reach out if you have any concerns.`,
      accent:   "#16a34a",
      badge:    "DELIVERED",
    },
    cancelled: {
      subject:  `Order #${order.id} Has Been Cancelled`,
      headline: "Order Cancelled",
      emoji:    "❌",
      body:     `We're sorry — your order <strong>#${order.id}</strong> has been cancelled. If you think this is a mistake, please contact our support team.${
                  order.total_amount > 0
                    ? ` Any amount paid will be refunded within <strong>5–7 business days</strong>.`
                    : ""}`,
      accent:   "#dc2626",
      badge:    "CANCELLED",
    },
  };

  const cfg = statusConfig[unifiedStatus];
  if (!cfg) return null;

  /* ── Item rows ── */
  const itemRowsHTML = items.map((item) => {
    const badge = item.format === "ebook"
      ? `<span style="background:#ede9fe;color:#7c3aed;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:0.05em;text-transform:uppercase;">eBook</span>`
      : `<span style="background:#dcfce7;color:#15803d;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:0.05em;text-transform:uppercase;">Paperback</span>`;
    const lineTotal = `₹${(Number(item.price) * Number(item.quantity)).toFixed(2)}`;
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">
          <div>
            <p style="margin:0 0 5px;font-size:13px;font-weight:700;color:#0f172a;line-height:1.4;">${item.title}</p>
            ${badge}
          </div>
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;color:#64748b;font-weight:600;white-space:nowrap;">× ${item.quantity}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px;font-weight:800;color:#0f172a;white-space:nowrap;">${lineTotal}</td>
      </tr>`;
  }).join("");

  const itemsTableHTML = items.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:2px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;border-collapse:separate;border-spacing:0;">
      <thead>
        <tr style="background:#0f172a;">
          <td style="padding:12px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;">Item</td>
          <td style="padding:12px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;text-align:center;">Qty</td>
          <td style="padding:12px 16px;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;text-align:right;">Total</td>
        </tr>
      </thead>
      <tbody style="background:#ffffff;">${itemRowsHTML}</tbody>
    </table>` : "";

  const orderDate = order.created_at
    ? new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";
  const subtotal     = items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0);
  const shippingCost = Number(order.shipping_cost || 0);

  const summaryRows = [
    orderDate && `<tr><td style="font-size:12px;color:#64748b;padding:6px 0;font-weight:500;">Order Date</td><td style="font-size:12px;color:#0f172a;font-weight:700;text-align:right;">${orderDate}</td></tr>`,
    courier   && `<tr><td style="font-size:12px;color:#64748b;padding:6px 0;font-weight:500;">Courier</td><td style="font-size:12px;color:#0f172a;font-weight:700;text-align:right;">${courier}</td></tr>`,
    tracking  && `<tr><td style="font-size:12px;color:#64748b;padding:6px 0;font-weight:500;">Tracking ID</td><td style="font-size:12px;color:#0f172a;font-weight:700;text-align:right;font-family:monospace;">${tracking}</td></tr>`,
    `<tr><td style="font-size:12px;color:#64748b;padding:6px 0;font-weight:500;">Subtotal</td><td style="font-size:12px;color:#0f172a;font-weight:700;text-align:right;">₹${subtotal.toFixed(2)}</td></tr>`,
    `<tr><td style="font-size:12px;color:#64748b;padding:6px 0;font-weight:500;">Shipping</td><td style="font-size:12px;color:#0f172a;font-weight:700;text-align:right;">${shippingCost > 0 ? `₹${shippingCost.toFixed(2)}` : "Free"}</td></tr>`,
  ].filter(Boolean).join("");

  const summaryHTML = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-collapse:collapse;">
      <tr><td style="background:#0f172a;border-radius:10px 10px 0 0;padding:12px 20px;">
        <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.12em;">Order Summary</p>
      </td></tr>
      <tr><td style="background:#f8fafc;border:2px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:16px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:12px;color:#64748b;padding:6px 0;font-weight:500;">Order ID</td>
            <td style="font-size:12px;color:#0f172a;font-weight:800;text-align:right;font-family:monospace;">#${order.id}</td>
          </tr>
          ${summaryRows}
          <tr><td colspan="2" style="padding:10px 0 4px;"><div style="border-top:2px solid #e2e8f0;"></div></td></tr>
          <tr>
            <td style="font-size:15px;font-weight:800;color:#0f172a;padding:4px 0;">Total Paid</td>
            <td style="font-size:15px;font-weight:800;color:${cfg.accent};text-align:right;">₹${order.total_amount}</td>
          </tr>
        </table>
      </td></tr>
    </table>`;

  const cancelNoteHTML = unifiedStatus === "cancelled" ? `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:6px;margin-bottom:24px;border-collapse:collapse;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:800;color:#991b1b;text-transform:uppercase;letter-spacing:0.08em;">Cancellation Notice</p>
        <p style="margin:0;font-size:13px;color:#7f1d1d;line-height:1.7;">
          If a payment was made, a refund will be processed within <strong>5–7 business days</strong>.<br>
          Questions? Email us at <a href="mailto:editor@agphbooks.com" style="color:#dc2626;font-weight:700;">editor@agphbooks.com</a>
        </p>
      </td></tr>
    </table>` : "";

  return {
    subject: cfg.subject,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cfg.subject}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
        <!-- HEADER -->
        <tr><td style="background:#0f172a;padding:0;">
          <div style="height:5px;background:${cfg.accent};"></div>
          <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 36px 24px;">
            <p style="margin:0 0 20px;font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">AGPH <span style="color:${cfg.accent};">Books</span></p>
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="background:${cfg.accent};padding:5px 14px;border-radius:6px;">
                <span style="font-size:10px;font-weight:800;color:#ffffff;letter-spacing:0.15em;">${cfg.badge}</span>
              </td>
            </tr></table>
            <p style="margin:16px 0 4px;font-size:26px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;line-height:1.2;">${cfg.emoji} ${cfg.headline}</p>
            <p style="margin:0;font-size:12px;color:#64748b;font-family:monospace;">Order #${order.id}</p>
          </td></tr></table>
        </td></tr>
        <!-- BODY -->
        <tr><td style="padding:15px;">
          <p style="margin:0 0 8px;font-size:16px;font-weight:800;color:#0f172a;">Hello, ${customer.name} 👋</p>
          <p style="margin:0 0 32px;font-size:14px;color:#475569;line-height:1.8;">${cfg.body}</p>
          ${cancelNoteHTML}
          ${itemsTableHTML}
          ${summaryHTML}
          <div style="border-top:2px solid #f1f5f9;margin:24px 0;"></div>
          ${unifiedStatus === "delivered" ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-collapse:collapse;">
            <tr><td style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:10px;padding:24px 20px;text-align:center;">
              <p style="margin:0 0 4px;font-size:20px;">⭐⭐⭐⭐⭐</p>
              <p style="margin:8px 0 4px;font-size:15px;font-weight:800;color:#0f172a;">How was your order?</p>
              <p style="margin:0 0 20px;font-size:13px;color:#64748b;line-height:1.7;">Your review helps other readers find great books.</p>
              <a href="${process.env.NEXT_PUBLIC_SITE_URL}/account/orders/${order.id}/review"
                style="display:inline-block;background:#0f172a;color:#ffffff;font-size:13px;font-weight:800;padding:12px 32px;border-radius:8px;text-decoration:none;">✍️ Write a Review</a>
            </td></tr>
          </table>` : ""}
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.8;">
            Need help? <a href="mailto:editor@agphbooks.com" style="color:${cfg.accent};font-weight:700;text-decoration:none;">editor@agphbooks.com</a>
          </p>
        </td></tr>
        <!-- FOOTER -->
        <tr><td style="background:#0f172a;padding:24px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <p style="margin:0 0 4px;font-size:13px;font-weight:800;color:#ffffff;">AGPH Books Store</p>
              <p style="margin:0;font-size:11px;color:#475569;">© ${new Date().getFullYear()} All rights reserved.</p>
            </td>
            <td align="right" style="vertical-align:middle;">
              <a href="mailto:editor@agphbooks.com" style="font-size:11px;color:#64748b;text-decoration:none;font-weight:600;">editor@agphbooks.com</a>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
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

            db.query(`SELECT * FROM shipping WHERE order_id = ? LIMIT 1`, [orderId], (err, shipRows) => {
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
                customer: { name: order.name, email: order.email, phone: order.phone },
                billing:  addrRows[0] || {},
                shipping: shipRows[0] || {},
                items: normItems,
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
                  await transporter.sendMail({
                    from:    `"${email.brand === "agclassics" ? "AG Classics" : "AGPH Books Store"}" <${process.env.MAIL_USER}>`,
                    to:      customer.email,
                    subject: email.subject,
                    html:    email.html,
                  });
                } catch (mailErr) {
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

                try {
                  await transporter.sendMail({
                    from:    `"AGPH Books Store" <${process.env.MAIL_USER}>`,
                    to:      process.env.ADMIN_MAIL,
                    subject: `[New Order] #${order.id} — ₹${order.total_amount} — ${customer.name}`,
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
                } catch (mailErr) {
                  console.error("Admin mail error:", mailErr.message);
                }
              }

              res.json({ msg: "Order updated & customer notified" });
            }
          );
        }
      );
    });
  });
});

module.exports = router;
module.exports.agphEmailTemplate      = agphEmailTemplate;
module.exports.agClassicsEmailTemplate = agClassicsEmailTemplate;