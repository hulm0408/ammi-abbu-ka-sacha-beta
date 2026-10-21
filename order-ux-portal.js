// ============================================================================
// ORDER UX PORTAL & ONE-CARD STATE MACHINE (V16)
// ----------------------------------------------------------------------------
// Implements:
//  - Screen 01: User intake · address/cart missing + Interactive Two-Box [Verify] Form
//  - Screen 02: Boss · review one card + Missing-Field Two-Box [Verify] Form
//  - Screen 03: User · bill confirmation ([Approve bill] / [Something is wrong])
//  - Screen 04: User · payment pending (Single QR · [I've paid — check status])
//  - Screen 05: Boss · paid, tracking delayed ([Retry tracking link], never 2nd QR)
//  - Screen 06: Boss · accounts, OTP (Wrong OTP x3 -> lock) & Safe JSON Vault
//  - Screen 07: Full 8-Stage State Machine + Role Auth + Masked Phones + Audit Log
// ============================================================================

import crypto from 'crypto';
import QRCode from 'qrcode';
import { Markup } from 'telegraf';
import {
  getDb,
  saveDb,
  getDraft,
  updateDraft,
  clearDraft,
  updateAccount,
  permanentLogoutAccount,
  deleteAccount,
  setActiveOrderAccountKey,
  maskPhoneStars,
  maskAccountCode,
  exportSafeRedactedSessionJson,
  getOtpLockStatus,
  recordOtpAttempt,
  appendAuditEvent
} from './store.js';
import { ingestAndPersistRawAccountTexts } from './account-vault-intake.js';
import {
  claimSwiggyBreakfastAndLateNightOffers,
  requestSwiggyOtpViaBridge,
  verifySwiggyOtpViaBridge
} from './swiggy-bridge.js';
import { table, heading, sub, field, section } from './rich-text.js';
import { getStoredSwiggyTrackingUrl } from './swiggy-cart.js';

function getSafePublishedTrackingLink(order) {
  return getStoredSwiggyTrackingUrl(order);
}

const PORTAL_SIGN_SECRET = crypto
  .createHash('sha256')
  .update(String(process.env.BOT_TOKEN || 'order_ux_portal_v16_secret'))
  .digest('hex');

export function getPublicAppBaseUrl(req = null) {
  const envUrl = String(
    process.env.APP_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  ).trim().replace(/\/+$/, '');
  if (envUrl) return envUrl;
  if (req && req.headers?.host) {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return `${proto}://${req.headers.host}`;
  }
  return 'https://ammi-abbu-ka-sacha-beta.onrender.com';
}

export function createPortalToken(scope = 'user', subjectId = '0') {
  return crypto
    .createHmac('sha256', PORTAL_SIGN_SECRET)
    .update(`v16:${scope}:${subjectId}`)
    .digest('hex')
    .slice(0, 24);
}

export function verifyPortalToken(scope = 'user', subjectId = '0', token = '') {
  if (!token || typeof token !== 'string') return false;
  const expected = createPortalToken(scope, subjectId);
  if (token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function verifyTelegramWebAppInitData(initData = '', botToken = process.env.BOT_TOKEN || '') {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;
    const rawUser = params.get('user');
    return rawUser ? JSON.parse(rawUser) : null;
  } catch {
    return null;
  }
}

export function buildUserPortalUrl(userId, orderId = '') {
  const base = getPublicAppBaseUrl();
  const sig = createPortalToken('user', String(userId));
  const ordParam = orderId ? `&orderId=${encodeURIComponent(orderId)}` : '';
  return `${base}/portal/user?uid=${encodeURIComponent(String(userId))}&sig=${sig}${ordParam}`;
}

export function buildBossOrderPortalUrl(orderId) {
  const base = getPublicAppBaseUrl();
  const sig = createPortalToken('boss_order', String(orderId));
  return `${base}/portal/boss-order/${encodeURIComponent(String(orderId))}?sig=${sig}`;
}

export function buildBossAccountsPortalUrl(bossId) {
  const base = getPublicAppBaseUrl();
  const sig = createPortalToken('boss_accounts', String(bossId));
  return `${base}/portal/accounts?bid=${encodeURIComponent(String(bossId))}&sig=${sig}`;
}

export function makeSmartPortalButton(label, url) {
  if (/^https:\/\//i.test(String(url || '')) && Markup.button.webApp) {
    return Markup.button.webApp(label, url);
  }
  return Markup.button.url(label, url);
}

function esc(str = '') {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// CLEAN ONE-CARD TELEGRAM FORMATTERS (EXACT SCREENS 01, 03, 04, 05 CONTRACT)
// ============================================================================

export function buildCleanUserIntakeCard(userId, draft = {}, userInfo = {}) {
  const hasCart = Boolean(draft?.cart);
  const hasAddress = Boolean(draft?.address);
  const shortRef = String(draft?.tempRef || String(userId).slice(-5)).padStart(5, '3');
  const cd = draft?.cartDetails || {};
  const items = Array.isArray(cd.items) ? cd.items : [];
  const totalQty = items.reduce((s, it) => s + Number(it.qty || it.quantity || 1), 0);
  const computedSub = items.reduce(
    (s, it) => s + Number(it.lineTotal || (Number(it.price || 0) * Number(it.qty || it.quantity || 1)) || 0),
    0
  );
  const subtotal = Number(cd.subtotal || cd.itemsTotal || computedSub || 0);
  const portalUrl = buildUserPortalUrl(userId);

  // Determine badge & prompt line
  let statusBadge = 'Cart & address needed';
  let topBanner = 'i <b>Send cart + address.</b> <i>Either can arrive first.</i>';
  let actionPrompt = '✎ <b>Open the Verify Form below (or paste in chat) to add Cart + Address.</b>';
  let primaryCtaLabel = '✎ Open Cart + Address Verify Box ›';

  if (hasCart && !hasAddress) {
    statusBadge = '● Address needed';
    actionPrompt = '⌖ <b>Add a valid address link to continue.</b>';
    primaryCtaLabel = '⌖ Enter Address & Verify ›';
  } else if (!hasCart && hasAddress) {
    statusBadge = '● Cart needed';
    actionPrompt = '▤ <b>Add a valid Swiggy cart link to continue.</b>';
    primaryCtaLabel = '▤ Enter Cart Link & Verify ›';
  } else if (hasCart && hasAddress) {
    statusBadge = '● Ready to validate';
    topBanner = '✓ <b>Cart ✓  Address ✓</b> · <i>Ready to submit for bill validation.</i>';
    actionPrompt = '› <b>Both Cart &amp; Address verified — tap Submit to fetch your bill.</b>';
    primaryCtaLabel = '✎ Review / Edit Boxes ›';
  }

  const restLine = hasCart
    ? `▤ <b>${esc(cd.restaurantName || 'Swiggy Cart')}</b>\n<i>${totalQty > 0 ? `${totalQty} item${totalQty > 1 ? 's' : ''} · ` : ''}original cart verified</i>`
    : `▤ <b>Cart not added yet</b>\n<i>Paste Swiggy group order / cart link</i>`;

  const ad = draft?.addressDetails || {};
  const deliverLine = hasAddress
    ? `<b>DELIVER TO</b>\n<b>${esc(ad.city || ad.label || 'Delivery Location')}</b>\n${esc(draft.address)}`
    : `<b>DELIVER TO</b>\n<i>Address link not received</i>`;

  const itemTable = items.length > 0
    ? table([
        ['#', 'Item', 'Qty', 'Line Total'],
        ...items.map((it, idx) => {
          const q = Number(it.qty || it.quantity || 1);
          const lineAmt = Number(it.lineTotal || (Number(it.price || 0) * q) || 0);
          return [String(idx + 1), esc(it.name || 'Item'), String(q), lineAmt > 0 ? `₹${lineAmt}` : '—'];
        })
      ])
    : '';

  const summaryTable = table([
    ['Items / subtotal', subtotal > 0 ? `₹${subtotal}` : 'Pending cart'],
    ['Delivery & fees', hasAddress ? 'Calculating on checkout' : 'Pending address'],
    ['Eligible discount', 'Pending'],
    ['Total after validation', 'Pending'],
  ]);

  const text =
    `${topBanner}\n` +
    section(`#${esc(shortRef)} — ORDER SUMMARY · ${statusBadge}`, [
      restLine,
      deliverLine,
      itemTable,
    ].filter(Boolean).join('\n')) +
    '\n' +
    section('▤ Order Summary', summaryTable) +
    '\n' +
    section('› Next Step', `${actionPrompt}\n${sub('◈ No account allocated; QR is blocked.')}`);

  const rows = [
    [makeSmartPortalButton(primaryCtaLabel, portalUrl)],
    [
      Markup.button.callback(hasCart ? '● Cart ✓' : '● Paste Cart', 'action_paste_cart'),
      Markup.button.callback(hasAddress ? '● Address ✓' : '● Paste Address', 'action_paste_address')
    ]
  ];
  if (hasCart && hasAddress) {
    rows.push([Markup.button.callback('› Submit for Bill Validation ›', 'action_send_to_beta')]);
  }
  rows.push([Markup.button.callback('× Clear Draft', 'action_reset_draft')]);

  return { text, keyboard: Markup.inlineKeyboard(rows), portalUrl };
}

export function buildCleanUserBillConfirmationCard(order) {
  const portalUrl = buildUserPortalUrl(order.userId, order.id);
  const items = Array.isArray(order.items) ? order.items : [];
  const totalQty = items.reduce((s, it) => s + Number(it.qty || it.quantity || 1), 0);
  const subtotal = Number(order.subtotal || 0);
  const deliveryFee = Number(order.deliveryFee || 0);
  const otherFees = Number((Number(order.packingFee || 0) + Number(order.platformFee || 0) + Number(order.gst || 0)).toFixed(2));
  const feesTotal = Number((deliveryFee + otherFees).toFixed(2));
  const discount = Number(order.discount || order.totalSavings || 0);
  const totalToPay = Number(order.finalPayable || order.finalTotal || subtotal || 0);
  const ad = order.addressDetails || {};

  const itemTable = items.length > 0
    ? table([
        ['#', 'Item', 'Qty', 'Line Total'],
        ...items.map((it, idx) => {
          const q = Number(it.qty || it.quantity || 1);
          const lineAmt = Number(it.lineTotal || (Number(it.price || 0) * q) || 0);
          return [String(idx + 1), esc(it.name || 'Item'), String(q), `₹${lineAmt}`];
        })
      ])
    : '';

  const billTable = table([
    ['Items / subtotal', `₹${subtotal}`],
    ['Delivery & fees', `₹${feesTotal}`],
    ['Eligible discount', discount > 0 ? `−₹${discount}` : '₹0'],
    ['TOTAL TO PAY', `<b>₹${totalToPay}</b>`],
  ]);

  const text =
    `i <b>Check your delivery address and total.</b>\n` +
    section(`#${esc(order.id)} — ORDER SUMMARY · ● <b>Approval pending</b>`, [
      `▤ <b>${esc(order.restaurantName || 'Swiggy Order')}</b>`,
      `<i>${totalQty || items.length || 1} items · address validated</i>`,
      '',
      `<b>DELIVER TO</b>`,
      `<b>${esc(ad.city || ad.name || 'Delivery Address')}</b>`,
      `${esc(order.address || '')}`,
      '',
      itemTable,
    ].filter(Boolean).join('\n')) +
    '\n' +
    section('₹ Final Bill', billTable) +
    '\n' +
    section('! Important', `<i>◈ No QR before explicit approval.</i>`);

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✓ Approve bill', `user_approve_bill_${order.id}`),
      Markup.button.callback('! Something is wrong', `user_bill_issue_${order.id}`)
    ],
    [makeSmartPortalButton('☎ View Order Card in App ›', portalUrl)]
  ]);

  return { text, keyboard };
}

export function buildCleanUserPaymentPendingCard(order) {
  const portalUrl = buildUserPortalUrl(order.userId, order.id);
  const totalToPay = Number(order.finalPayable || order.finalTotal || 0);
  const paymentTable = table([
    ['Order ID', `#${esc(order.id)}`],
    ['Amount', `<b>₹${totalToPay}</b>`],
    ['Restaurant', esc(order.restaurantName || 'Swiggy Order')],
    ['Status', '● Waiting for verified payment'],
  ]);

  const text =
    `₹ <b>Pay when ready</b> · <i>Amount confirmed by the order summary</i>\n` +
    section('▤ Payment Request Issued', paymentTable) +
    '\n' +
    `<i>"I've paid" requests a status check only.</i>\n` +
    section('! Important', `<i>◈ No duplicate QR. No trust in a button tap.</i>`);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⌕ I've paid — check status", `user_paid_status_${order.id}`)],
    [makeSmartPortalButton('□ Open Full Payment Card ›', portalUrl)]
  ]);
  return { text, keyboard };
}

// ============================================================================
// SHARED CSS DESIGN SYSTEM (PIXEL-FAITHFUL TO SCREENS 01–07 PALETTE)
// ============================================================================

const APPLE_SPEC_CSS = `
:root {
  --bg: #F4F4F8;
  --surface: #FFFFFF;
  --card: #FCFCFC;
  --border: #E0E4EC;
  --border-strong: #CBD2DF;
  --text: #181C24;
  --muted: #687080;
  --subtle: #8C95A6;
  --blue: #1C6CF0;
  --blue-hover: #1558CC;
  --blue-soft: #E8F0FC;
  --blue-border: #B8D0F8;
  --blue-text: #164EB8;
  --amber-soft: #FCF4E0;
  --amber-border: #F0D898;
  --amber-text: #8A5600;
  --green-soft: #E4F4EC;
  --green-border: #9CD8BC;
  --green-text: #148C5C;
  --red-soft: #FCECF0;
  --red-border: #F4BCC8;
  --red-text: #B4233C;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  line-height: 1.45;
  padding: 14px 12px 36px;
}
.shell {
  max-width: 440px;
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 26px;
  box-shadow: 0 12px 34px rgba(24, 28, 36, 0.06);
  overflow: hidden;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.topbar-left { display: flex; align-items: center; gap: 10px; }
.back-chevron {
  width: 28px; height: 28px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--blue); font-size: 19px; font-weight: 600; text-decoration: none;
  background: #F4F6FA; cursor: pointer; border: none;
}
.bot-title { font-size: 16px; font-weight: 700; letter-spacing: -0.015em; color: var(--text); }
.bot-sub { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 5px; }
.online-dot { width: 7px; height: 7px; border-radius: 50%; background: #18A96E; display: inline-block; }
.body-wrap { padding: 14px 15px 18px; display: flex; flex-direction: column; gap: 12px; }

.banner {
  border-radius: 14px;
  padding: 11px 13px;
  font-size: 13px;
  border: 1px solid transparent;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.banner-blue { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue-text); }
.banner-green { background: var(--green-soft); border-color: var(--green-border); color: var(--green-text); }
.banner-amber { background: var(--amber-soft); border-color: var(--amber-border); color: var(--amber-text); }
.banner-red { background: var(--red-soft); border-color: var(--red-border); color: var(--red-text); }
.banner strong { font-weight: 700; font-size: 13.5px; }
.banner span { opacity: 0.9; font-size: 12.5px; }

.meta-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 12.5px; color: var(--muted); padding: 0 2px;
}
.check-badges { display: inline-flex; gap: 6px; font-weight: 600; font-size: 12px; }
.pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700;
  border: 1px solid transparent; white-space: nowrap;
}
.pill-amber { background: var(--amber-soft); border-color: var(--amber-border); color: var(--amber-text); }
.pill-green { background: var(--green-soft); border-color: var(--green-border); color: var(--green-text); }
.pill-blue { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue-text); }
.pill-red { background: var(--red-soft); border-color: var(--red-border); color: var(--red-text); }

.summary-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 15px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.summary-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding-bottom: 10px; border-bottom: 1px solid var(--border);
}
.order-code {
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.rest-name { font-size: 16.5px; font-weight: 700; color: var(--text); letter-spacing: -0.015em; }
.rest-meta { font-size: 12.5px; color: var(--muted); margin-top: 1px; }

.section-block {
  padding-top: 10px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-label {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.055em;
  text-transform: uppercase; color: var(--subtle);
}
.addr-title { font-size: 14px; font-weight: 650; color: var(--text); }
.addr-body { font-size: 13px; color: var(--muted); word-break: break-word; }
.addr-missing { font-size: 13.5px; color: var(--muted); font-style: normal; }

.item-row, .price-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  font-size: 13.5px; font-variant-numeric: tabular-nums;
}
.item-row .name { color: var(--text); font-weight: 500; }
.item-row .amt { color: var(--text); font-weight: 600; white-space: nowrap; }
.price-row .lbl { color: var(--muted); }
.price-row .val { color: var(--text); font-weight: 600; }
.price-row .val-pending { color: var(--muted); font-weight: 500; }
.price-row .val-discount { color: var(--green-text); font-weight: 700; }
.total-row {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-top: 10px; border-top: 1px solid var(--border);
  font-size: 14px; font-weight: 800; letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
}
.total-row .total-amt { font-size: 18px; color: var(--text); }

/* TWO ELEGANT INPUT BOXES + VERIFY FORM */
.verify-box-panel {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  box-shadow: 0 4px 16px rgba(28, 108, 240, 0.05);
}
.field-group { display: flex; flex-direction: column; gap: 5px; }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.field-label { font-size: 12px; font-weight: 700; color: var(--text); letter-spacing: -0.005em; }
.input-box, .textarea-box {
  width: 100%;
  background: #F8F9FC;
  border: 1.5px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13.5px;
  color: var(--text);
  font-family: inherit;
  transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
}
.input-box:focus, .textarea-box:focus {
  outline: none;
  background: #FFFFFF;
  border-color: var(--blue);
  box-shadow: 0 0 0 3px rgba(28, 108, 240, 0.14);
}
.input-box.missing-focus, .textarea-box.missing-focus {
  border-color: #E5A93C;
  background: #FFFDF7;
}
.input-box.verified-ok, .textarea-box.verified-ok {
  border-color: #7ACBA5;
  background: #F8FCFA;
}
.textarea-box { min-height: 68px; resize: vertical; }
.mono-box { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

.btn {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 14px;
  padding: 12px 16px;
  font-size: 14.5px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  text-decoration: none;
  transition: transform 0.08s ease, background 0.15s ease, opacity 0.15s ease;
  width: 100%;
}
.btn:active { transform: scale(0.985); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-primary { background: var(--blue); color: #FFFFFF; }
.btn-primary:hover { background: var(--blue-hover); }
.btn-soft-blue { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue-text); font-size: 13px; padding: 9px 12px; }
.btn-danger-soft { background: var(--red-soft); border-color: var(--red-border); color: var(--red-text); }
.btn-neutral { background: #F4F5F8; border-color: var(--border); color: var(--text); font-size: 13px; padding: 9px 12px; }
.btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.btn-row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }

.qr-frame {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 16px; background: #FFFFFF; border: 1px solid var(--border); border-radius: 18px;
}
.qr-amount { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.qr-img { width: 208px; height: 208px; border-radius: 12px; border: 1px solid var(--border); padding: 8px; background: #FFF; }

.rule-foot {
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  padding-top: 2px;
}
.toast {
  display: none;
  padding: 10px 13px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
}
.toast.show { display: block; }
`;

// ============================================================================
// SERIALIZE ORDER / DRAFT STATE FOR LIVE PORTAL UI
// ============================================================================

export async function serializeUserPortalState(userId, preferredOrderId = '') {
  const db = getDb();
  const uidNum = Number(userId);
  const draft = getDraft(userId) || {};

  // Find user's latest active order (unless explicitly selected)
  const userOrders = Object.values(db?.orders || {})
    .filter(o => o && Number(o.userId) === uidNum && !['CANCELLED', 'REJECTED'].includes(o.status))
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const activeOrder = preferredOrderId && db?.orders?.[preferredOrderId]
    ? db.orders[preferredOrderId]
    : userOrders.find(o => o.status !== 'COMPLETED') || null;

  let qrDataUrl = null;
  const upiUri = activeOrder?.pendingSwiggyUpiUri || activeOrder?.realUpiIntentUri || '';
  if (upiUri) {
    try {
      qrDataUrl = await QRCode.toDataURL(upiUri, { width: 320, margin: 1 });
    } catch {}
  }

  return {
    role: 'user',
    userId: String(userId),
    sig: createPortalToken('user', String(userId)),
    draft: {
      cart: draft.cart || '',
      address: draft.address || '',
      addressOriginalText: draft.addressOriginalText || draft.address || '',
      cartDetails: draft.cartDetails || null,
      addressDetails: draft.addressDetails || null
    },
    activeOrder: activeOrder ? {
      id: activeOrder.id,
      status: activeOrder.status,
      uxStage: deriveUxStageFromOrder(activeOrder),
      restaurantName: activeOrder.restaurantName || 'Swiggy Order',
      address: activeOrder.address || '',
      addressDetails: activeOrder.addressDetails || null,
      cart: activeOrder.cart || '',
      items: activeOrder.items || [],
      subtotal: Number(activeOrder.subtotal || 0),
      deliveryFee: Number(activeOrder.deliveryFee || 0),
      fees: Number(
        (Number(activeOrder.deliveryFee || 0) + Number(activeOrder.packingFee || 0) + Number(activeOrder.platformFee || 0) + Number(activeOrder.gst || 0)).toFixed(2)
      ),
      discount: Number(activeOrder.discount || activeOrder.totalSavings || 0),
      finalTotal: Number(activeOrder.finalPayable || activeOrder.finalTotal || 0),
      billApprovedByUser: Boolean(activeOrder.billApprovedByUser),
      hasQr: Boolean(upiUri),
      qrDataUrl,
      trackingLink: getSafePublishedTrackingLink(activeOrder),
      liveOrderStatus: activeOrder.liveOrderStatus || ''
    } : null
  };
}

export function deriveUxStageFromOrder(order) {
  if (!order) return 'SCREEN_01_INTAKE';
  if (!order.cart || !order.address) return 'SCREEN_01_INTAKE';
  if (order.status === 'COMPLETED') {
    return getSafePublishedTrackingLink(order) ? 'SCREEN_05_TRACKING_READY' : 'SCREEN_05_PAID_TRACKING_DELAYED';
  }
  if (order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.status === 'PAYMENT_PENDING' || order.cardStage === 'QR_GENERATED') {
    return 'SCREEN_04_PAYMENT_PENDING';
  }
  if (order.status === 'APPROVAL_PENDING' || (Number(order.finalPayable || order.finalTotal || 0) > 0 && !order.billApprovedByUser)) {
    return 'SCREEN_03_BILL_CONFIRMATION';
  }
  return 'SCREEN_02_VALIDATING';
}

export function serializeBossOrderPortalState(orderId) {
  const db = getDb();
  const order = db?.orders?.[orderId];
  if (!order) return null;
  const accKey = order.selectedAccount || '';
  const acc = accKey ? db?.config?.accounts?.[accKey] : null;
  return {
    role: 'boss_order',
    orderId: order.id,
    sig: createPortalToken('boss_order', order.id),
    senderName: order.fwdSenderName || order.userName || 'Customer',
    isForwarded: !order.isDirectBossOrder,
    cart: order.cart || '',
    address: order.address || '',
    addressOriginalText: order.addressOriginalText || order.address || '',
    hasCart: Boolean(order.cart),
    hasAddress: Boolean(order.address),
    cardStage: order.cardStage || 'COLLECTING',
    status: order.status || 'PENDING',
    accountBadge: acc
      ? `${maskAccountCode(acc)} · ${acc.isZeroOrderAccount || Number(acc.totalOrdersCount || 0) === 0 ? 'unused · eligible offer' : 'active session'}`
      : (accKey ? maskAccountCode(accKey) : 'No account allocated yet'),
    restaurantName: order.restaurantName || order.cartDetails?.restaurantName || 'Pending Cart Verification',
    items: order.items || order.cartDetails?.items || [],
    subtotal: Number(order.subtotal || order.cartDetails?.subtotal || 0),
    fees: Number(
      (Number(order.deliveryFee || 0) + Number(order.packingFee || 0) + Number(order.platformFee || 0) + Number(order.gst || 0)).toFixed(2)
    ),
    discount: Number(order.discount || order.totalSavings || 0),
    finalTotal: Number(order.finalPayable || order.finalTotal || 0),
    trackingLink: getSafePublishedTrackingLink(order),
    hasQr: Boolean(order.realUpiIntentUri)
  };
}

export function serializeBossAccountsPortalState(bossId) {
  const db = getDb();
  const accountsMap = db?.config?.accounts || {};
  const activeKey = db?.config?.activeOrderAccount || Object.keys(accountsMap)[0] || '';
  const accounts = Object.entries(accountsMap).map(([key, acc]) => {
    const prevOrders = Number(acc.totalOrdersCount || 0);
    const zeroOrder = Boolean(acc.isZeroOrderAccount || prevOrders === 0);
    return {
      key,
      code: maskAccountCode(acc),
      maskedPhone: maskPhoneStars(acc.phone || key),
      isLoggedIn: Boolean(acc.isLoggedIn),
      previousOrders: prevOrders,
      zeroOrder,
      offerLabel: zeroOrder ? 'eligible · Welcome offer' : 'repeat account',
      isActive: key === activeKey,
      safeJson: exportSafeRedactedSessionJson(key)
    };
  });
  return {
    role: 'boss_accounts',
    bossId: String(bossId),
    sig: createPortalToken('boss_accounts', String(bossId)),
    activeKey,
    accounts,
    recentAudit: (db?.auditLog || []).slice(-10).reverse()
  };
}

// ============================================================================
// RENDER INTERACTIVE TWO-BOX [VERIFY] + ONE-CARD PORTAL HTML (USER & BOSS)
// ============================================================================

export function renderInteractiveOrderPortalHtml(initialState, mode = 'user') {
  const safeJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Order Bot — One-Card &amp; Verify</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${APPLE_SPEC_CSS}</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div class="topbar-left">
      <button class="back-chevron" type="button" id="closeBtn" title="Back">‹</button>
      <div>
        <div class="bot-title">Order Bot</div>
        <div class="bot-sub"><span class="online-dot"></span> online</div>
      </div>
    </div>
    <span class="pill pill-blue" id="rolePill">${mode === 'boss_order' ? 'Boss Review' : 'Live Verify'}</span>
  </div>

  <div class="body-wrap" id="appRoot"></div>
</div>

<script>
let STATE = ${safeJson};
const MODE = ${JSON.stringify(mode)};

if (window.Telegram && Telegram.WebApp) {
  try {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();
  } catch (e) {}
}

document.getElementById('closeBtn').addEventListener('click', () => {
  if (window.Telegram && Telegram.WebApp && Telegram.WebApp.close) {
    try { Telegram.WebApp.close(); return; } catch (e) {}
  }
  window.history.back();
});

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function render() {
  const root = document.getElementById('appRoot');
  if (MODE === 'boss_order') {
    root.innerHTML = renderBossOrderView(STATE);
    bindBossEvents();
    return;
  }
  root.innerHTML = renderUserFlowView(STATE);
  bindUserEvents();
}

function renderBossOrderView(st) {
  const missingCart = !st.hasCart;
  const missingAddr = !st.hasAddress;
  const bothOk = st.hasCart && st.hasAddress;
  const items = Array.isArray(st.items) ? st.items : [];
  const qty = items.reduce((s, i) => s + Number(i.qty || i.quantity || 1), 0);

  return \`
    <div class="meta-row">
      <span>\${st.isForwarded ? 'Forwarded from ' : 'Direct order · '}<strong>\${escHtml(st.senderName)}</strong></span>
      <span class="check-badges">
        <span class="pill \${st.hasCart ? 'pill-green' : 'pill-amber'}">\${st.hasCart ? 'Cart ✓' : 'Cart missing'}</span>
        <span class="pill \${st.hasAddress ? 'pill-green' : 'pill-amber'}">\${st.hasAddress ? 'Address ✓' : 'Address missing'}</span>
      </span>
    </div>

    <div class="banner \${bothOk ? 'banner-green' : 'banner-amber'}">
      <strong>\${bothOk ? 'Best eligible unused account' : 'Missing details detected in forwarded message'}</strong>
      <span>\${bothOk ? escHtml(st.accountBadge) : 'Paste the missing link or text in the two boxes below and tap Verify.'}</span>
    </div>

    <div id="feedbackToast" class="toast"></div>

    <!-- TWO ELEGANT BOXES + VERIFY BUTTON -->
    <form class="verify-box-panel" id="bossVerifyForm">
      <div class="field-group">
        <div class="field-head">
          <label class="field-label" for="cartInput">1. Swiggy Cart / Group Order Link</label>
          <span class="pill \${st.hasCart ? 'pill-green' : 'pill-amber'}">\${st.hasCart ? 'Verified ✓' : 'Required'}</span>
        </div>
        <input id="cartInput" name="cart" class="input-box \${missingCart ? 'missing-focus' : 'verified-ok'}"
          placeholder="https://swig.gy/gc/... or Swiggy cart text"
          value="\${escHtml(st.cart || '')}" autocomplete="off">
      </div>

      <div class="field-group">
        <div class="field-head">
          <label class="field-label" for="addrInput">2. Delivery Address Link / Street / GPS</label>
          <span class="pill \${st.hasAddress ? 'pill-green' : 'pill-amber'}">\${st.hasAddress ? 'Verified ✓' : 'Required'}</span>
        </div>
        <textarea id="addrInput" name="address" class="textarea-box \${missingAddr ? 'missing-focus' : 'verified-ok'}"
          placeholder="Paste Swiggy Share Address link, Google Maps URL, or full delivery address...">\${escHtml(st.addressOriginalText || st.address || '')}</textarea>
      </div>

      <div class="btn-row">
        <button type="button" class="btn btn-neutral" id="gpsBtn">⌖ Fill Live GPS</button>
        <button type="submit" class="btn btn-primary" id="verifySubmitBtn">✓ Verify &amp; Update Bill</button>
      </div>
    </form>

    <!-- ONE CLEAN ORDER SUMMARY CARD (SCREEN 02 / 05) -->
    <div class="summary-card">
      <div class="summary-head">
        <span class="order-code">#\${escHtml(st.orderId)} — ORDER SUMMARY</span>
        <span class="pill \${st.status === 'COMPLETED' ? 'pill-amber' : (bothOk ? 'pill-green' : 'pill-amber')}">
          \${st.status === 'COMPLETED' ? (st.trackingLink ? 'Tracking live' : 'Tracking delayed') : (bothOk ? 'Bill ready' : (missingCart ? 'Cart needed' : 'Address needed'))}
        </span>
      </div>

      <div>
        <div class="rest-name">\${escHtml(st.restaurantName)}</div>
        <div class="rest-meta">\${qty > 0 ? qty + ' items · ' : ''}\${bothOk ? 'cart &amp; address verified' : 'awaiting missing box verification'}</div>
      </div>

      <div class="section-block">
        <div class="section-label">DELIVER TO</div>
        <div class="\${st.hasAddress ? 'addr-body' : 'addr-missing'}">\${st.hasAddress ? escHtml(st.address) : 'Address link not received'}</div>
      </div>

      <div class="section-block">
        \${items.map(it => {
          const q = Number(it.qty || it.quantity || 1);
          const amt = Number(it.lineTotal || (Number(it.price || 0) * q) || 0);
          return \`<div class="item-row"><span class="name">\${q} × \${escHtml(it.name || 'Item')}</span><span class="amt">\${amt ? '₹' + amt : '—'}</span></div>\`;
        }).join('')}
        <div class="price-row"><span class="lbl">Items / subtotal</span><span class="val">\${st.subtotal ? '₹' + st.subtotal : 'Pending'}</span></div>
        <div class="price-row"><span class="lbl">Delivery &amp; fees</span><span class="\${bothOk ? 'val' : 'val-pending'}">\${bothOk ? '₹' + st.fees : 'Pending address'}</span></div>
        <div class="price-row"><span class="lbl">Eligible discount</span><span class="\${st.discount > 0 ? 'val-discount' : 'val-pending'}">\${st.discount > 0 ? '−₹' + st.discount : (bothOk ? '₹0' : 'Pending')}</span></div>
      </div>

      <div class="total-row">
        <span>\${bothOk ? 'TOTAL TO PAY' : 'TOTAL AFTER VALIDATION'}</span>
        <span class="total-amt">\${st.finalTotal > 0 ? '₹' + st.finalTotal : 'Pending'}</span>
      </div>
    </div>

    \${bothOk && st.status !== 'COMPLETED' ? \`
      <button type="button" class="btn btn-primary" id="sendSummaryToUserBtn">Send bill to family ›</button>
      <div class="rule-foot">Sending summary is not approval.</div>
    \` : st.status === 'COMPLETED' ? \`
      <div class="banner banner-amber">
        <strong>Paid is final. Retry tracking only.</strong>
        <span>Customer must not pay again.</span>
      </div>
      <button type="button" class="btn btn-primary" id="retryTrackBtn">Retry tracking link</button>
      <div class="rule-foot">Never create another payment QR.</div>
    \` : \`
      <div class="rule-foot">No account allocated; QR is blocked.</div>
    \`}
  \`;
}

function renderUserFlowView(st) {
  const ord = st.activeOrder;
  const stage = ord ? ord.uxStage : 'SCREEN_01_INTAKE';

  // SCREEN 04: PAYMENT PENDING (SINGLE SCANNABLE QR)
  if (ord && stage === 'SCREEN_04_PAYMENT_PENDING' && ord.qrDataUrl) {
    return \`
      <div class="banner banner-blue">
        <strong>Pay when ready</strong>
        <span>Amount confirmed by the order summary</span>
      </div>
      <div id="feedbackToast" class="toast"></div>
      <div class="qr-frame">
        <div class="order-code">#\${escHtml(ord.id)} — PAYMENT REQUEST ISSUED</div>
        <div class="qr-amount">₹\${ord.finalTotal}</div>
        <img class="qr-img" src="\${ord.qrDataUrl}" alt="Swiggy Verified Payment QR">
      </div>
      <div class="banner banner-amber">
        <strong>Waiting for verified payment</strong>
        <span>"I've paid" requests a status check only.</span>
      </div>
      <button type="button" class="btn btn-primary" id="checkPaidBtn">I've paid — check status</button>
      <div class="rule-foot">No duplicate QR. No trust in a button tap.</div>
    \`;
  }

  // SCREEN 05: PAID CONFIRMED / TRACKING
  if (ord && (stage === 'SCREEN_05_PAID_TRACKING_DELAYED' || stage === 'SCREEN_05_TRACKING_READY')) {
    return \`
      <div class="banner banner-green">
        <strong>Provider confirmed ₹\${ord.finalTotal} ✓</strong>
        <span>No second charge requested.</span>
      </div>
      <div id="feedbackToast" class="toast"></div>
      <div class="summary-card">
        <div class="summary-head">
          <span class="order-code">#\${escHtml(ord.id)} — ORDER SUMMARY</span>
          <span class="pill \${ord.trackingLink ? 'pill-green' : 'pill-amber'}">\${ord.trackingLink ? 'Tracking live' : 'Tracking delayed'}</span>
        </div>
        <div class="rest-name">\${escHtml(ord.restaurantName)}</div>
        <div class="addr-body">\${escHtml(ord.liveOrderStatus || 'Order confirmed on Swiggy')}</div>
      </div>
      \${ord.trackingLink
        ? \`<a class="btn btn-primary" href="\${escHtml(ord.trackingLink)}" target="_blank">Open live tracking ›</a>\`
        : \`<button type="button" class="btn btn-primary" id="checkPaidBtn">Retry tracking link</button>\`}
      <div class="rule-foot">Never create another payment QR.</div>
    \`;
  }

  // SCREEN 03: USER BILL CONFIRMATION
  if (ord && stage === 'SCREEN_03_BILL_CONFIRMATION') {
    const items = Array.isArray(ord.items) ? ord.items : [];
    const qty = items.reduce((s, i) => s + Number(i.qty || i.quantity || 1), 0);
    return \`
      <div class="banner banner-blue">
        <strong>Check your delivery address and total.</strong>
      </div>
      <div id="feedbackToast" class="toast"></div>
      <div class="summary-card">
        <div class="summary-head">
          <span class="order-code">#\${escHtml(ord.id)} — ORDER SUMMARY</span>
          <span class="pill pill-amber">Approval pending</span>
        </div>
        <div>
          <div class="rest-name">\${escHtml(ord.restaurantName)}</div>
          <div class="rest-meta">\${qty || items.length || 1} items · address validated</div>
        </div>
        <div class="section-block">
          <div class="section-label">DELIVER TO</div>
          <div class="addr-body">\${escHtml(ord.address)}</div>
        </div>
        <div class="section-block">
          \${items.map(it => {
            const q = Number(it.qty || it.quantity || 1);
            const amt = Number(it.lineTotal || (Number(it.price || 0) * q) || 0);
            return \`<div class="item-row"><span class="name">\${q} × \${escHtml(it.name || 'Item')}</span><span class="amt">₹\${amt}</span></div>\`;
          }).join('')}
          <div class="price-row"><span class="lbl">Items / subtotal</span><span class="val">₹\${ord.subtotal}</span></div>
          <div class="price-row"><span class="lbl">Delivery &amp; fees</span><span class="val">₹\${ord.fees}</span></div>
          <div class="price-row"><span class="lbl">Eligible discount</span><span class="val-discount">\${ord.discount > 0 ? '−₹' + ord.discount : '₹0'}</span></div>
        </div>
        <div class="total-row">
          <span>TOTAL TO PAY</span>
          <span class="total-amt">₹\${ord.finalTotal}</span>
        </div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="approveBillBtn">Approve bill</button>
        <button type="button" class="btn btn-danger-soft" id="wrongBillBtn">Something is wrong</button>
      </div>
      <div class="rule-foot">No QR before explicit approval.</div>
    \`;
  }

  // SCREEN 01: USER INTAKE + TWO ELEGANT BOXES + [VERIFY] BUTTON
  const d = st.draft || {};
  const hasCart = Boolean(d.cart);
  const hasAddr = Boolean(d.address);
  const cd = d.cartDetails || {};
  const items = Array.isArray(cd.items) ? cd.items : [];
  const qty = items.reduce((s, i) => s + Number(i.qty || i.quantity || 1), 0);
  const sub = Number(cd.subtotal || items.reduce((s, i) => s + Number(i.lineTotal || (Number(i.price || 0) * Number(i.qty || 1)) || 0), 0));

  return \`
    <div class="banner banner-blue">
      <strong>Send cart + address.</strong>
      <span>Either can arrive first — fill below and tap Verify.</span>
    </div>

    <div id="feedbackToast" class="toast"></div>

    <!-- TWO ELEGANT INPUT BOXES + VERIFY BUTTON -->
    <form class="verify-box-panel" id="userVerifyForm">
      <div class="field-group">
        <div class="field-head">
          <label class="field-label" for="uCartInput">1. Swiggy Cart / Group Order Link</label>
          <span class="pill \${hasCart ? 'pill-green' : 'pill-amber'}">\${hasCart ? 'Cart ✓' : 'Needed'}</span>
        </div>
        <input id="uCartInput" name="cart" class="input-box \${hasCart ? 'verified-ok' : 'missing-focus'}"
          placeholder="Paste https://swig.gy/gc/... link here"
          value="\${escHtml(d.cart || '')}" autocomplete="off">
      </div>

      <div class="field-group">
        <div class="field-head">
          <label class="field-label" for="uAddrInput">2. Delivery Address Link / Street / GPS</label>
          <span class="pill \${hasAddr ? 'pill-green' : 'pill-amber'}">\${hasAddr ? 'Address ✓' : 'Address needed'}</span>
        </div>
        <textarea id="uAddrInput" name="address" class="textarea-box \${hasAddr ? 'verified-ok' : 'missing-focus'}"
          placeholder="Paste Swiggy Share Address link, Google Maps URL, or full delivery address...">\${escHtml(d.addressOriginalText || d.address || '')}</textarea>
      </div>

      <div class="btn-row">
        <button type="button" class="btn btn-neutral" id="uGpsBtn">⌖ Use GPS</button>
        <button type="submit" class="btn btn-primary" id="uVerifyBtn">✓ Verify</button>
      </div>
    </form>

    <!-- SCREEN 01 LIVE SUMMARY PREVIEW -->
    <div class="summary-card">
      <div class="summary-head">
        <span class="order-code">#\${escHtml(String(st.userId).slice(-5).padStart(5,'3'))} — ORDER SUMMARY</span>
        <span class="pill \${hasCart && hasAddr ? 'pill-green' : 'pill-amber'}">
          \${hasCart && hasAddr ? 'Ready to submit' : (!hasCart ? 'Cart needed' : 'Address needed')}
        </span>
      </div>
      <div>
        <div class="rest-name">\${hasCart ? escHtml(cd.restaurantName || 'Swiggy Cart Verified') : 'Cart not added yet'}</div>
        <div class="rest-meta">\${hasCart ? ((qty ? qty + ' items · ' : '') + 'original cart verified') : 'awaiting genuine Swiggy cart link'}</div>
      </div>
      <div class="section-block">
        <div class="section-label">DELIVER TO</div>
        <div class="\${hasAddr ? 'addr-body' : 'addr-missing'}">\${hasAddr ? escHtml(d.address) : 'Address link not received'}</div>
      </div>
      <div class="section-block">
        \${items.map(it => {
          const q = Number(it.qty || it.quantity || 1);
          const amt = Number(it.lineTotal || (Number(it.price || 0) * q) || 0);
          return \`<div class="item-row"><span class="name">\${q} × \${escHtml(it.name || 'Item')}</span><span class="amt">\${amt ? '₹' + amt : '—'}</span></div>\`;
        }).join('')}
        <div class="price-row"><span class="lbl">Items / subtotal</span><span class="val">\${sub ? '₹' + sub : 'Pending'}</span></div>
        <div class="price-row"><span class="lbl">Delivery &amp; fees</span><span class="val-pending">Pending address</span></div>
        <div class="price-row"><span class="lbl">Eligible discount</span><span class="val-pending">Pending</span></div>
      </div>
      <div class="total-row">
        <span>TOTAL AFTER VALIDATION</span>
        <span class="total-amt">Pending</span>
      </div>
    </div>

    \${hasCart && hasAddr ? \`
      <button type="button" class="btn btn-primary" id="submitOrderBtn">Send order for bill check ›</button>
    \` : ''}
    <div class="rule-foot">No account allocated; QR is blocked.</div>
  \`;
}

function showToast(msg, kind = 'banner-green') {
  const el = document.getElementById('feedbackToast');
  if (!el) return;
  el.className = 'toast show banner ' + kind;
  el.textContent = msg;
}

function attachGpsFill(btnId, inputId) {
  const btn = document.getElementById(btnId);
  const box = document.getElementById(inputId);
  if (!btn || !box) return;
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('GPS not supported in this browser — paste Google Maps or address text.', 'banner-amber');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        btn.textContent = '⌖ GPS Filled ✓';
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        box.value = (box.value ? box.value.trim() + '\\n' : '') + 'https://maps.google.com/?q=' + lat + ',' + lng;
      },
      () => {
        btn.disabled = false;
        btn.textContent = '⌖ Use GPS';
        showToast('Location permission denied — paste Swiggy/Google Maps link instead.', 'banner-amber');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

function bindBossEvents() {
  attachGpsFill('gpsBtn', 'addrInput');
  const form = document.getElementById('bossVerifyForm');
  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = document.getElementById('verifySubmitBtn');
      btn.disabled = true;
      btn.textContent = 'Verifying…';
      try {
        const res = await fetch('/api/portal/boss-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: STATE.orderId,
            sig: STATE.sig,
            initData: window.Telegram?.WebApp?.initData || '',
            cart: document.getElementById('cartInput').value,
            address: document.getElementById('addrInput').value
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showToast(data.error || 'Verification failed', 'banner-red');
          btn.disabled = false;
          btn.textContent = '✓ Verify & Update Bill';
          return;
        }
        STATE = data.state;
        render();
        showToast(data.message || 'Verified & Boss card updated!', 'banner-green');
      } catch (err) {
        showToast('Network error: ' + err.message, 'banner-red');
        btn.disabled = false;
        btn.textContent = '✓ Verify & Update Bill';
      }
    });
  }

  const sendBtn = document.getElementById('sendSummaryToUserBtn');
  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending bill summary…';
      const res = await fetch('/api/portal/boss-send-bill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: STATE.orderId, sig: STATE.sig })
      });
      const data = await res.json();
      sendBtn.disabled = false;
      sendBtn.textContent = 'Bill sent to family ✓';
      showToast(data.message || 'Clean Bill Confirmation Card sent!', data.ok ? 'banner-green' : 'banner-red');
    });
  }

  const retryBtn = document.getElementById('retryTrackBtn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying tracking…';
      const res = await fetch('/api/portal/boss-retry-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: STATE.orderId, sig: STATE.sig })
      });
      const data = await res.json();
      if (data.state) { STATE = data.state; render(); }
      showToast(data.message || 'Checked tracking status.', data.ok ? 'banner-green' : 'banner-amber');
    });
  }
}

function bindUserEvents() {
  attachGpsFill('uGpsBtn', 'uAddrInput');
  const form = document.getElementById('userVerifyForm');
  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = document.getElementById('uVerifyBtn');
      btn.disabled = true;
      btn.textContent = 'Verifying…';
      try {
        const res = await fetch('/api/portal/user-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: STATE.userId,
            sig: STATE.sig,
            initData: window.Telegram?.WebApp?.initData || '',
            cart: document.getElementById('uCartInput').value,
            address: document.getElementById('uAddrInput').value
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showToast(data.error || 'Could not verify link — check and try again.', 'banner-red');
          btn.disabled = false;
          btn.textContent = '✓ Verify';
          return;
        }
        STATE = data.state;
        render();
        showToast(data.message || 'Verified successfully ✓', 'banner-green');
      } catch (err) {
        showToast('Network error: ' + err.message, 'banner-red');
        btn.disabled = false;
        btn.textContent = '✓ Verify';
      }
    });
  }

  const subBtn = document.getElementById('submitOrderBtn');
  if (subBtn) {
    subBtn.addEventListener('click', async () => {
      subBtn.disabled = true;
      subBtn.textContent = 'Submitting order…';
      const res = await fetch('/api/portal/user-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: STATE.userId, sig: STATE.sig })
      });
      const data = await res.json();
      if (data.state) { STATE = data.state; render(); }
      showToast(data.message || 'Order sent for bill validation!', data.ok ? 'banner-green' : 'banner-red');
    });
  }

  const appBtn = document.getElementById('approveBillBtn');
  if (appBtn && STATE.activeOrder) {
    appBtn.addEventListener('click', async () => {
      appBtn.disabled = true;
      appBtn.textContent = 'Approving…';
      const res = await fetch('/api/portal/user-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: STATE.userId, orderId: STATE.activeOrder.id, sig: STATE.sig, decision: 'approve' })
      });
      const data = await res.json();
      if (data.state) { STATE = data.state; render(); }
      showToast(data.message || 'Bill approved ✓', data.ok ? 'banner-green' : 'banner-amber');
    });
  }

  const wrongBtn = document.getElementById('wrongBillBtn');
  if (wrongBtn && STATE.activeOrder) {
    wrongBtn.addEventListener('click', async () => {
      wrongBtn.disabled = true;
      const res = await fetch('/api/portal/user-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: STATE.userId, orderId: STATE.activeOrder.id, sig: STATE.sig, decision: 'reject' })
      });
      const data = await res.json();
      if (data.state) { STATE = data.state; render(); }
      showToast(data.message || 'Returned to draft so you can edit Cart or Address.', 'banner-amber');
    });
  }

  const checkBtn = document.getElementById('checkPaidBtn');
  if (checkBtn && STATE.activeOrder) {
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking gateway…';
      const res = await fetch('/api/portal/user-check-paid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: STATE.userId, orderId: STATE.activeOrder.id, sig: STATE.sig })
      });
      const data = await res.json();
      if (data.state) { STATE = data.state; render(); }
      showToast(data.message || 'Waiting for verified payment.', data.paid ? 'banner-green' : 'banner-amber');
    });
  }
}

render();
</script>
</body>
</html>`;
}

// ============================================================================
// SCREEN 06: OWNER-ONLY ACCOUNT MANAGER PORTAL HTML (OTP + SAFE JSON + OFFERS)
// ============================================================================

export function renderBossAccountManagerHtml(initialState) {
  const safeJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Order Bot — Owner Account Manager</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${APPLE_SPEC_CSS}</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div class="topbar-left">
      <button class="back-chevron" type="button" id="closeBtn">‹</button>
      <div>
        <div class="bot-title">Order Bot</div>
        <div class="bot-sub"><span class="online-dot"></span> online</div>
      </div>
    </div>
    <span class="pill pill-blue">Owner Only</span>
  </div>
  <div class="body-wrap" id="mgrRoot"></div>
</div>
<script>
let STATE = ${safeJson};
if (window.Telegram?.WebApp) { try { Telegram.WebApp.ready(); Telegram.WebApp.expand(); } catch (e) {} }
document.getElementById('closeBtn').onclick = () => {
  if (window.Telegram?.WebApp?.close) { try { Telegram.WebApp.close(); return; } catch (e) {} }
  window.history.back();
};
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

let selectedKey = STATE.activeKey || (STATE.accounts[0]?.key || '');

function render() {
  const cur = STATE.accounts.find(a => a.key === selectedKey) || STATE.accounts[0] || null;
  if (cur) selectedKey = cur.key;
  const root = document.getElementById('mgrRoot');

  root.innerHTML = \`
    <div class="banner banner-blue">
      <strong>Account manager · owner-only · secure actions</strong>
    </div>
    <div id="mgrToast" class="toast"></div>

    <div class="summary-card">
      \${STATE.accounts.length > 1 ? \`
        <select id="accSelect" class="input-box">
          \${STATE.accounts.map(a => \`<option value="\${esc(a.key)}" \${a.key === selectedKey ? 'selected' : ''}>\${esc(a.code)} (\${esc(a.maskedPhone)}) · \${a.previousOrders} orders</option>\`).join('')}
        </select>
      \` : ''}

      \${cur ? \`
        <div class="summary-head" style="border-bottom:none;padding-bottom:0">
          <div>
            <div class="rest-name">\${esc(cur.code)} · \${cur.isLoggedIn ? 'session active' : 'logged out'}</div>
            <div class="rest-meta">\${cur.previousOrders} previous orders · \${esc(cur.offerLabel)}</div>
          </div>
          <span class="pill \${cur.zeroOrder ? 'pill-green' : 'pill-blue'}">\${cur.zeroOrder ? 'Eligible' : 'Active'}</span>
        </div>
        <button type="button" class="btn btn-soft-blue" id="claimOffersBtn">Check / claim eligible offers</button>
      \` : \`<div class="addr-missing">No sessions stored yet — import JSON or login via OTP below.</div>\`}

      <div class="section-block">
        <div class="field-label">Import session JSON</div>
        <textarea id="jsonImportBox" class="textarea-box mono-box" placeholder='{"phone":"****7929","session_id":"[REDACTED]"}'></textarea>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="importJsonBtn">Import session</button>
          <button type="button" class="btn btn-neutral" id="copySafeJsonBtn">Copy safe JSON</button>
        </div>
      </div>

      <div class="section-block">
        <div class="field-label">Phone login</div>
        <input id="otpPhoneBox" class="input-box" placeholder="+91 mobile number" inputmode="tel">
        <div class="btn-row">
          <button type="button" class="btn btn-soft-blue" id="sendOtpBtn">Send OTP</button>
          <button type="button" class="btn btn-neutral" id="resendOtpBtn">Resend OTP</button>
        </div>
        <div class="btn-row">
          <input id="otpCodeBox" class="input-box" placeholder="6-digit code" maxlength="6" inputmode="numeric">
          <button type="button" class="btn btn-primary" id="verifyOtpBtn">Verify</button>
        </div>
      </div>

      \${cur ? \`
        <div class="section-block">
          <div class="field-label">Account actions</div>
          <div class="btn-row-3">
            <button type="button" class="btn btn-neutral" id="logoutAccBtn">Log out</button>
            <button type="button" class="btn btn-danger-soft" id="deleteAccBtn">Delete</button>
            <button type="button" class="btn btn-neutral" id="exportSafeBtn">Export JSON</button>
          </div>
        </div>
      \` : ''}
    </div>
    <div class="rule-foot">Wrong OTP ×3 → lock. Never log raw tokens.</div>
  \`;

  bindMgrEvents(cur);
}

function toast(msg, kind = 'banner-green') {
  const t = document.getElementById('mgrToast');
  if (!t) return;
  t.className = 'toast show banner ' + kind;
  t.textContent = msg;
}

async function callMgr(action, payload = {}) {
  const res = await fetch('/api/portal/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bossId: STATE.bossId, sig: STATE.sig, action, accountKey: selectedKey, ...payload })
  });
  return { okHttp: res.ok, ...(await res.json()) };
}

function bindMgrEvents(cur) {
  const sel = document.getElementById('accSelect');
  if (sel) sel.onchange = () => { selectedKey = sel.value; render(); };

  const claimBtn = document.getElementById('claimOffersBtn');
  if (claimBtn) claimBtn.onclick = async () => {
    claimBtn.disabled = true;
    const r = await callMgr('claim_offers');
    if (r.state) { STATE = r.state; render(); }
    toast(r.message || 'Checked eligible offers', r.ok ? 'banner-green' : 'banner-amber');
  };

  const impBtn = document.getElementById('importJsonBtn');
  if (impBtn) impBtn.onclick = async () => {
    const rawJson = document.getElementById('jsonImportBox').value.trim();
    if (!rawJson) return toast('Paste valid Swiggy session JSON first.', 'banner-amber');
    impBtn.disabled = true;
    const r = await callMgr('import_json', { rawJson });
    if (r.state) { STATE = r.state; render(); }
    toast(r.message || 'Session imported ✓', r.ok ? 'banner-green' : 'banner-red');
  };

  const copyBtn = document.getElementById('copySafeJsonBtn');
  if (copyBtn && cur) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(cur.safeJson || ''); } catch {}
    toast('Copied redacted safe JSON (' + cur.maskedPhone + ') — secrets stripped ✓');
  };

  const expBtn = document.getElementById('exportSafeBtn');
  if (expBtn && cur) expBtn.onclick = () => {
    const blob = new Blob([cur.safeJson || '{}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = cur.code.toLowerCase() + '-safe-redacted.json';
    a.click();
    toast('Downloaded safe redacted JSON ✓');
  };

  const sendOtp = async () => {
    const phone = document.getElementById('otpPhoneBox').value.trim();
    const r = await callMgr('send_otp', { phone });
    toast(r.message || 'OTP action complete', r.ok ? 'banner-green' : 'banner-red');
  };
  const sBtn = document.getElementById('sendOtpBtn');
  const rBtn = document.getElementById('resendOtpBtn');
  if (sBtn) sBtn.onclick = sendOtp;
  if (rBtn) rBtn.onclick = sendOtp;

  const vBtn = document.getElementById('verifyOtpBtn');
  if (vBtn) vBtn.onclick = async () => {
    const phone = document.getElementById('otpPhoneBox').value.trim();
    const otp = document.getElementById('otpCodeBox').value.trim();
    const r = await callMgr('verify_otp', { phone, otp });
    if (r.state) { STATE = r.state; render(); }
    toast(r.message || 'OTP result', r.ok ? 'banner-green' : 'banner-red');
  };

  const outBtn = document.getElementById('logoutAccBtn');
  if (outBtn) outBtn.onclick = async () => {
    const r = await callMgr('logout');
    if (r.state) { STATE = r.state; render(); }
    toast(r.message || 'Logged out session ✓', 'banner-amber');
  };

  const delBtn = document.getElementById('deleteAccBtn');
  if (delBtn) delBtn.onclick = async () => {
    const r = await callMgr('delete');
    if (r.state) { STATE = r.state; render(); }
    toast(r.message || 'Account deleted ✓', 'banner-amber');
  };
}

render();
</script>
</body>
</html>`;
}

// ============================================================================
// INTERACTIVE 7-SCREEN LIVE SHOWCASE HTML (`/showcase` & STANDALONE PREVIEW)
// ============================================================================

export function renderInteractiveSevenScreenShowcaseHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order Bot — Interactive 7-Screen One-Card &amp; Two-Box Verify Showcase</title>
<style>
${APPLE_SPEC_CSS}
.top-switcher {
  max-width: 980px; margin: 0 auto 18px;
  display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
}
.tab-chip {
  border: 1px solid var(--border); background: #FFFFFF; color: var(--muted);
  border-radius: 999px; padding: 8px 14px; font-size: 12.5px; font-weight: 700; cursor: pointer;
}
.tab-chip.active { background: var(--blue); border-color: var(--blue); color: #FFFFFF; }
.caption-head {
  text-align: center; font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 10px;
}
.contract-grid {
  max-width: 820px; margin: 0 auto; background: #FFF; border: 1px solid var(--border);
  border-radius: 22px; padding: 20px; display: flex; flex-direction: column; gap: 16px;
}
.stage-track { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.stage-pill {
  padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: #F8FAFE;
  font-size: 12px;
}
.stage-pill b { display: block; color: var(--blue-text); font-size: 11px; letter-spacing: 0.04em; }
.matrix-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.matrix-card { border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: var(--card); font-size: 12.5px; }
.matrix-card h4 { font-size: 13px; margin-bottom: 4px; color: var(--text); }
</style>
</head>
<body>
<div class="top-switcher" id="tabs">
  <button class="tab-chip active" data-screen="01">01 · User Intake + 2-Box Verify</button>
  <button class="tab-chip" data-screen="02">02 · Boss Forwarded + 2-Box Verify</button>
  <button class="tab-chip" data-screen="03">03 · User Bill Confirmation</button>
  <button class="tab-chip" data-screen="04">04 · Single QR Payment</button>
  <button class="tab-chip" data-screen="05">05 · Paid · Tracking Delayed</button>
  <button class="tab-chip" data-screen="06">06 · Owner Account Manager</button>
  <button class="tab-chip" data-screen="07">07 · State Machine Contract</button>
</div>
<div class="caption-head" id="screenTitle">User intake · address missing (Interactive Two-Box + Verify)</div>
<div id="stageMount"></div>

<script>
const DEMO = {
  cartUrl: 'https://swig.gy/gc/88412/Burger-House',
  addressText: 'Flat 302, Green View Apartments, Gomti Nagar, Lucknow 226010',
  bossAddr: '',
  otpFails: 0,
  otpLocked: false
};

function setTab(id) {
  document.querySelectorAll('.tab-chip').forEach(b => b.classList.toggle('active', b.dataset.screen === id));
  const titles = {
    '01': 'User intake · address missing — Interactive Two-Box Form + [ Verify ] Button',
    '02': 'Boss · review one card — Forwarded SMS Missing-Box [ Verify ] -> Bill Ready',
    '03': 'User · bill confirmation — Explicit approval gate before any QR',
    '04': 'User · payment pending — Single QR · No trust in button tap',
    '05': 'Boss · paid, tracking delayed — Paid is final · Never create 2nd QR',
    '06': 'Boss · accounts, OTP (Wrong OTP ×3 -> lock) and Safe Redacted JSON',
    '07': 'State machine, failure recovery & security contract (Zero-SMS Shield active)'
  };
  document.getElementById('screenTitle').textContent = titles[id] || '';
  const m = document.getElementById('stageMount');

  if (id === '07') {
    m.innerHTML = \`
      <div class="contract-grid">
        <div class="banner banner-green">
          <strong>Zero-SMS Shield Active · 0 Unpaid order/place Calls Until Explicit Approval</strong>
          <span>Every stage enforces strict single-card replacement, single-QR idempotency, and masked AC-XXXX security.</span>
        </div>
        <div class="stage-track">
          <div class="stage-pill"><b>1 · INTAKE</b>Cart + address via 2-Box Verify</div>
          <div class="stage-pill"><b>2 · VALIDATE</b>Check links, restaurant &amp; pin</div>
          <div class="stage-pill"><b>3 · ALLOCATE</b>Best unused 0-order AC-XXXX</div>
          <div class="stage-pill"><b>4 · SEND SUMMARY</b>One clean card, no QR yet</div>
          <div class="stage-pill"><b>5 · CONFIRM</b>Explicit user approval</div>
          <div class="stage-pill"><b>6 · PAYMENT</b>Single dynamic UPI QR</div>
          <div class="stage-pill"><b>7 · VERIFY</b>Server gateway check only</div>
          <div class="stage-pill"><b>8 · TRACK</b>Live map &amp; Swiggy tracking</div>
        </div>
        <div class="matrix-grid">
          <div class="matrix-card"><h4>Cart arrived, address missing</h4><p>Keep draft · show 2-Box Verify · block account &amp; QR.</p></div>
          <div class="matrix-card"><h4>Forwarded SMS incomplete</h4><p>Boss opens 2-Box Verify right on card · fills missing box · instant Bill Ready.</p></div>
          <div class="matrix-card"><h4>User clicks "I've paid"</h4><p>Triggers server gateway status check ONLY · never creates 2nd QR.</p></div>
          <div class="matrix-card"><h4>Wrong OTP ×3</h4><p>Immediate 15-minute phone lockout · secrets redacted in logs &amp; JSON.</p></div>
        </div>
      </div>\`;
    return;
  }

  let bodyHtml = '';
  if (id === '01') {
    const hasAddr = Boolean(DEMO.userVerifiedAddr);
    bodyHtml = \`
      <div class="banner banner-blue"><strong>Send cart + address.</strong><span>Either can arrive first — enter below and click Verify.</span></div>
      <div id="demoToast" class="toast"></div>
      <div class="verify-box-panel">
        <div class="field-group">
          <div class="field-head"><span class="field-label">1. Swiggy Cart Link</span><span class="pill pill-green">Cart ✓</span></div>
          <input id="dCart" class="input-box verified-ok" value="\${DEMO.cartUrl}">
        </div>
        <div class="field-group">
          <div class="field-head"><span class="field-label">2. Delivery Address</span><span class="pill \${hasAddr ? 'pill-green' : 'pill-amber'}">\${hasAddr ? 'Address ✓' : 'Address needed'}</span></div>
          <textarea id="dAddr" class="textarea-box \${hasAddr ? 'verified-ok' : 'missing-focus'}" placeholder="Paste address link or type street address here...">\${DEMO.userVerifiedAddr || ''}</textarea>
        </div>
        <button type="button" class="btn btn-primary" onclick="verifyUserDemo()">✓ Verify</button>
      </div>
      <div class="summary-card">
        <div class="summary-head"><span class="order-code">#30108 — ORDER SUMMARY</span><span class="pill \${hasAddr ? 'pill-green' : 'pill-amber'}">\${hasAddr ? 'Verified ✓' : 'Address needed'}</span></div>
        <div><div class="rest-name">Burger House</div><div class="rest-meta">2 items · original cart verified</div></div>
        <div class="section-block"><div class="section-label">DELIVER TO</div><div class="\${hasAddr ? 'addr-body' : 'addr-missing'}">\${hasAddr || 'Address link not received'}</div></div>
        <div class="section-block">
          <div class="item-row"><span class="name">1 × Classic Chicken Burger</span><span class="amt">₹219</span></div>
          <div class="item-row"><span class="name">1 × Peri Peri Fries</span><span class="amt">₹129</span></div>
          <div class="price-row"><span class="lbl">Items / subtotal</span><span class="val">₹348</span></div>
          <div class="price-row"><span class="lbl">Delivery &amp; fees</span><span class="val-pending">\${hasAddr ? '₹39' : 'Pending address'}</span></div>
          <div class="price-row"><span class="lbl">Eligible discount</span><span class="\${hasAddr ? 'val-discount' : 'val-pending'}">\${hasAddr ? '−₹100' : 'Pending'}</span></div>
        </div>
        <div class="total-row"><span>\${hasAddr ? 'TOTAL TO PAY' : 'TOTAL AFTER VALIDATION'}</span><span class="total-amt">\${hasAddr ? '₹287' : 'Pending'}</span></div>
      </div>
      \${hasAddr ? '<button class="btn btn-primary" onclick="setTab(\\'03\\')">Continue to Bill Confirmation ›</button>' : '<div class="rule-foot">No account allocated; QR is blocked.</div>'}\`;
  } else if (id === '02') {
    const ok = Boolean(DEMO.bossAddr);
    bodyHtml = \`
      <div class="meta-row"><span>Forwarded from <strong>Ayesha</strong></span><span class="check-badges"><span class="pill pill-green">Cart ✓</span><span class="pill \${ok ? 'pill-green' : 'pill-amber'}">\${ok ? 'Address ✓' : 'Address missing'}</span></span></div>
      <div class="banner \${ok ? 'banner-green' : 'banner-amber'}">
        <strong>\${ok ? 'Best eligible unused account' : 'Forwarded SMS missing Delivery Address'}</strong>
        <span>\${ok ? 'AC-7929 · eligible offer ₹100 off' : 'Fill the missing box below and click Verify to build the Bill Ready card.'}</span>
      </div>
      <div class="verify-box-panel">
        <div class="field-group">
          <div class="field-head"><span class="field-label">1. Forwarded Cart Link</span><span class="pill pill-green">Cart ✓</span></div>
          <input id="bCart" class="input-box verified-ok" value="https://swig.gy/gc/88412/Burger-House">
        </div>
        <div class="field-group">
          <div class="field-head"><span class="field-label">2. Missing Delivery Address Box</span><span class="pill \${ok ? 'pill-green' : 'pill-amber'}">\${ok ? 'Verified ✓' : 'Paste here'}</span></div>
          <textarea id="bAddr" class="textarea-box \${ok ? 'verified-ok' : 'missing-focus'}" placeholder="Paste Ayesha's missing address or link here...">\${DEMO.bossAddr || ''}</textarea>
        </div>
        <button type="button" class="btn btn-primary" onclick="verifyBossDemo()">✓ Verify &amp; Fetch Bill</button>
      </div>
      <div class="summary-card">
        <div class="summary-head"><span class="order-code">#30108 — ORDER SUMMARY</span><span class="pill \${ok ? 'pill-green' : 'pill-amber'}">\${ok ? 'Bill ready' : 'Address needed'}</span></div>
        <div><div class="rest-name">Burger House</div><div class="rest-meta">2 items · \${ok ? 'address validated' : 'awaiting address box'}</div></div>
        <div class="section-block"><div class="section-label">DELIVER TO</div><div class="addr-body">\${DEMO.bossAddr || 'Waiting for Verify above'}</div></div>
        <div class="section-block">
          <div class="item-row"><span class="name">1 × Classic Chicken Burger</span><span class="amt">₹219</span></div>
          <div class="item-row"><span class="name">1 × Peri Peri Fries</span><span class="amt">₹129</span></div>
          <div class="price-row"><span class="lbl">Items / subtotal</span><span class="val">₹348</span></div>
          <div class="price-row"><span class="lbl">Delivery &amp; fees</span><span class="val">\${ok ? '₹39' : 'Pending'}</span></div>
          <div class="price-row"><span class="lbl">Eligible discount</span><span class="val-discount">\${ok ? '−₹100' : 'Pending'}</span></div>
        </div>
        <div class="total-row"><span>TOTAL TO PAY</span><span class="total-amt">\${ok ? '₹287' : 'Pending'}</span></div>
      </div>
      \${ok ? '<button class="btn btn-primary" onclick="setTab(\\'03\\')">Send bill to family ›</button><div class="rule-foot">Sending summary is not approval.</div>' : ''}\`;
  } else if (id === '03') {
    bodyHtml = \`
      <div class="banner banner-blue"><strong>Check your delivery address and total.</strong></div>
      <div class="summary-card">
        <div class="summary-head"><span class="order-code">#30108 — ORDER SUMMARY</span><span class="pill pill-amber">Approval pending</span></div>
        <div><div class="rest-name">Burger House</div><div class="rest-meta">2 items · address validated</div></div>
        <div class="section-block"><div class="section-label">DELIVER TO</div><div class="addr-title">Ayesha · Home</div><div class="addr-body">Flat 302, Green View Apartments, Gomti Nagar, Lucknow 226010</div></div>
        <div class="section-block">
          <div class="item-row"><span class="name">1 × Classic Chicken Burger</span><span class="amt">₹219</span></div>
          <div class="item-row"><span class="name">1 × Peri Peri Fries</span><span class="amt">₹129</span></div>
          <div class="price-row"><span class="lbl">Items / subtotal</span><span class="val">₹348</span></div>
          <div class="price-row"><span class="lbl">Delivery &amp; fees</span><span class="val">₹39</span></div>
          <div class="price-row"><span class="lbl">Eligible discount</span><span class="val-discount">−₹100</span></div>
        </div>
        <div class="total-row"><span>TOTAL TO PAY</span><span class="total-amt">₹287</span></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="setTab('04')">Approve bill</button>
        <button class="btn btn-danger-soft" onclick="setTab('01')">Something is wrong</button>
      </div>
      <div class="rule-foot">No QR before explicit approval.</div>\`;
  } else if (id === '04') {
    bodyHtml = \`
      <div class="banner banner-blue"><strong>Pay when ready</strong><span>Amount confirmed by the order summary</span></div>
      <div class="qr-frame">
        <div class="order-code">#30108 — PAYMENT REQUEST ISSUED</div>
        <div class="qr-amount">₹287</div>
        <svg class="qr-img" viewBox="0 0 120 120">
          <rect width="120" height="120" fill="#fff"/>
          <path fill="#181C24" d="M10,10 h30 v30 h-30 z M16,16 v18 h18 v-18 z M20,20 h10 v10 h-10 z M80,10 h30 v30 h-30 z M86,16 v18 h18 v-18 z M90,20 h10 v10 h-10 z M10,80 h30 v30 h-30 z M16,86 v18 h18 v-18 z M20,90 h10 v10 h-10 z M48,14 h8 v8 h-8 z M62,14 h10 v8 h-10 z M48,28 h16 v8 h-16 z M14,48 h18 v8 h-18 z M40,48 h14 v14 h-14 z M62,46 h10 v18 h-10 z M82,48 h26 v8 h-26 z M48,70 h12 v12 h-12 z M68,72 h16 v10 h-16 z M90,70 h18 v14 h-18 z M48,92 h22 v16 h-22 z M78,94 h14 v14 h-14 z M98,92 h12 v18 h-12 z"/>
        </svg>
      </div>
      <div class="banner banner-amber"><strong>Waiting for verified payment</strong><span>"I've paid" requests a status check only.</span></div>
      <button class="btn btn-primary" onclick="setTab('05')">I've paid — check status</button>
      <div class="rule-foot">No duplicate QR. No trust in a button tap.</div>\`;
  } else if (id === '05') {
    bodyHtml = \`
      <div class="banner banner-green"><strong>Provider confirmed ₹287 ✓</strong><span>No second charge requested.</span></div>
      <div class="summary-card">
        <div class="summary-head"><span class="order-code">#30108 — ORDER SUMMARY</span><span class="pill pill-amber">Tracking delayed</span></div>
        <div><div class="rest-name">Burger House</div><div class="rest-meta">Order placed · awaiting tracking link</div></div>
        <div class="section-block"><div class="addr-body">Swiggy did not return tracking yet. Retry tracking only.</div></div>
      </div>
      <div class="banner banner-amber"><strong>Paid is final. Retry tracking only.</strong><span>Customer must not pay again.</span></div>
      <button class="btn btn-primary" onclick="alert('Live trackV4 polled — never creates a second payment QR!')">Retry tracking link</button>
      <div class="rule-foot">Never create another payment QR.</div>\`;
  } else if (id === '06') {
    bodyHtml = \`
      <div class="banner banner-blue"><strong>Account manager · owner-only · secure actions</strong></div>
      <div id="otpNotice" class="toast \${DEMO.otpLocked ? 'show banner banner-red' : ''}">\${DEMO.otpLocked ? '◈ Phone locked for 15m after 3 wrong OTP attempts.' : ''}</div>
      <div class="summary-card">
        <div><div class="rest-name">AC-7929 · session active</div><div class="rest-meta">0 previous orders · eligible · Welcome offer</div></div>
        <button class="btn btn-soft-blue" onclick="alert('Daily Breakfast + Late Night offers checked ✓')">Check / claim eligible offers</button>
        <div class="section-block">
          <div class="field-label">Import session JSON</div>
          <textarea class="textarea-box mono-box">{"phone":"****7929","session_id":"[REDACTED]"}</textarea>
          <div class="btn-row">
            <button class="btn btn-primary" onclick="alert('Session saved to permanent vault ✓')">Import session</button>
            <button class="btn btn-neutral" onclick="alert('Copied redacted safe JSON (****7929) ✓')">Copy safe JSON</button>
          </div>
        </div>
        <div class="section-block">
          <div class="field-label">Phone login</div>
          <input class="input-box" placeholder="+91 mobile number" value="+91 99351 27929">
          <div class="btn-row"><button class="btn btn-soft-blue">Send OTP</button><button class="btn btn-neutral">Resend OTP</button></div>
          <div class="btn-row">
            <input id="demoOtpCode" class="input-box" placeholder="6-digit code" maxlength="6">
            <button class="btn btn-primary" onclick="testOtpLock()">Verify</button>
          </div>
        </div>
        <div class="section-block">
          <div class="field-label">Account actions</div>
          <div class="btn-row-3">
            <button class="btn btn-neutral">Log out</button>
            <button class="btn btn-danger-soft">Delete</button>
            <button class="btn btn-neutral">Export JSON</button>
          </div>
        </div>
      </div>
      <div class="rule-foot">Wrong OTP ×3 → lock. Never log raw tokens.</div>\`;
  }

  m.innerHTML = \`
    <div class="shell">
      <div class="topbar">
        <div class="topbar-left">
          <span class="back-chevron">‹</span>
          <div><div class="bot-title">Order Bot</div><div class="bot-sub"><span class="online-dot"></span> online</div></div>
        </div>
        <span class="pill pill-blue">Screen \${id}</span>
      </div>
      <div class="body-wrap">\${bodyHtml}</div>
    </div>\`;
}

window.verifyUserDemo = function() {
  const val = document.getElementById('dAddr').value.trim() || DEMO.addressText;
  DEMO.userVerifiedAddr = val;
  setTab('01');
};
window.verifyBossDemo = function() {
  DEMO.bossAddr = document.getElementById('bAddr').value.trim() || DEMO.addressText;
  setTab('02');
};
window.testOtpLock = function() {
  DEMO.otpFails += 1;
  if (DEMO.otpFails >= 3) DEMO.otpLocked = true;
  setTab('06');
};

document.querySelectorAll('.tab-chip').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.screen)));
setTab('01');
</script>
</body>
</html>`;
}

// ============================================================================
// HTTP PORTAL ROUTER FOR `index.js` (`GET /portal/*`, `POST /api/portal/*`)
// ============================================================================

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
  return true;
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(html);
  return true;
}

export function createOrderUxHttpHandler({
  bot,
  isBoss,
  extractAllLinks,
  isValidSwiggyCartUrl,
  isValidDeliveryAddressUrl,
  parseCartDetails,
  parseAddressDetails,
  geocodeAddressDetails,
  resolveSwiggyLink,
  formatUserOrderCardText,
  submitDraftAsCleanOrder,
  approveUserOrderBill,
  rejectUserOrderBill,
  checkOrderPaidStatus,
  ingestBossPortalUpdate,
  sendBossBillSummaryToCustomer
}) {
  return async function handlePortalHttpRequest(req, res, reqUrl) {
    const pathname = reqUrl.pathname || '/';

    // 1. Live Interactive 7-Screen Showcase
    if (req.method === 'GET' && (pathname === '/showcase' || pathname === '/preview-showcase')) {
      return sendHtml(res, 200, renderInteractiveSevenScreenShowcaseHtml());
    }

    // 2. Customer Two-Box + One-Card Portal (`GET /portal/user`)
    if (req.method === 'GET' && pathname === '/portal/user') {
      const uid = reqUrl.searchParams.get('uid') || '';
      const sig = reqUrl.searchParams.get('sig') || '';
      const ordId = reqUrl.searchParams.get('orderId') || '';
      if (!uid || !verifyPortalToken('user', uid, sig)) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized user portal link.' });
      }
      const state = await serializeUserPortalState(uid, ordId);
      return sendHtml(res, 200, renderInteractiveOrderPortalHtml(state, 'user'));
    }

    // 3. Boss Incomplete/Review Order Two-Box Portal (`GET /portal/boss-order/:orderId`)
    const bossOrdMatch = pathname.match(/^\/portal\/boss-order\/([A-Za-z0-9_]+)$/);
    if (req.method === 'GET' && bossOrdMatch) {
      const orderId = bossOrdMatch[1];
      const sig = reqUrl.searchParams.get('sig') || '';
      if (!verifyPortalToken('boss_order', orderId, sig)) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized Boss order review link.' });
      }
      const state = serializeBossOrderPortalState(orderId);
      if (!state) return sendJson(res, 404, { ok: false, error: 'Order not found.' });
      return sendHtml(res, 200, renderInteractiveOrderPortalHtml(state, 'boss_order'));
    }

    // 4. Owner-Only Account Manager (`GET /portal/accounts`) — Screen 06
    if (req.method === 'GET' && pathname === '/portal/accounts') {
      const bid = reqUrl.searchParams.get('bid') || '';
      const sig = reqUrl.searchParams.get('sig') || '';
      if (!bid || !isBoss(bid) || !verifyPortalToken('boss_accounts', bid, sig)) {
        return sendJson(res, 403, { ok: false, error: 'Forbidden — Owner role required.' });
      }
      const state = serializeBossAccountsPortalState(bid);
      return sendHtml(res, 200, renderBossAccountManagerHtml(state));
    }

    // 5. Customer Two-Box `[ ✓ Verify ]` API (`POST /api/portal/user-verify`)
    if (req.method === 'POST' && pathname === '/api/portal/user-verify') {
      const body = await readJsonBody(req);
      const uid = String(body.userId || '');
      const tgUser = verifyTelegramWebAppInitData(body.initData || '');
      const sigOk = verifyPortalToken('user', uid, body.sig || '') || (tgUser && String(tgUser.id) === uid);
      if (!uid || !sigOk) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized request.' });
      }

      const rawCart = String(body.cart || '').trim();
      const rawAddr = String(body.address || '').trim();
      if (!rawCart && !rawAddr) {
        return sendJson(res, 400, { ok: false, error: 'Enter a Swiggy Cart link or Delivery Address first.' });
      }

      const updates = {};
      const verifiedParts = [];

      if (rawCart) {
        const cartLinks = extractAllLinks(rawCart);
        const validCart = cartLinks.find(l => isValidSwiggyCartUrl(l));
        const parsedCart = parseCartDetails(rawCart);
        if (!validCart && !parsedCart) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Invalid Swiggy Cart link — paste a genuine https://swig.gy/gc/... or Swiggy cart link.'
          });
        }
        const cartUrl = validCart || 'https://www.swiggy.com/cart';
        let cartMeta = null;
        if (validCart) {
          try { cartMeta = await resolveSwiggyLink(validCart); } catch {}
        }
        updates.cart = cartUrl;
        if (cartMeta?.restaurantId) updates.restaurantId = cartMeta.restaurantId;
        if (cartMeta?.groupCartId) updates.groupCartId = cartMeta.groupCartId;
        updates.cartDetails = { ...(parsedCart || {}), ...(cartMeta?.cartDetails || {}) };
        verifiedParts.push('Cart ✓');
      }

      if (rawAddr) {
        const addrLinks = extractAllLinks(rawAddr);
        const validAddr = addrLinks.find(l => isValidDeliveryAddressUrl(l));
        let parsedAddr = parseAddressDetails(rawAddr);
        // Also accept clean multi-word street addresses typed directly in the form box!
        if (!validAddr && !parsedAddr && rawAddr.length >= 12 && /[a-zA-Z]/.test(rawAddr)) {
          parsedAddr = { address: rawAddr, raw: rawAddr };
        }
        if (!validAddr && !parsedAddr) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Invalid Address — paste a Swiggy Share Address link, Google Maps URL, GPS, or full street address.'
          });
        }
        try {
          const addrMeta = await resolveSwiggyLink(rawAddr);
          if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
            parsedAddr = { ...(parsedAddr || {}), ...addrMeta.addressDetails };
          } else if (parsedAddr) {
            parsedAddr = await geocodeAddressDetails(parsedAddr).catch(() => parsedAddr);
          }
        } catch {}

        updates.address = parsedAddr?.address || validAddr || rawAddr;
        updates.addressOriginalText = rawAddr;
        if (validAddr) updates.addressLink = validAddr;
        if (parsedAddr) updates.addressDetails = parsedAddr;
        verifiedParts.push('Address ✓');
      }

      updateDraft(uid, updates);
      const updatedDraft = getDraft(uid);

      // Update user's single Telegram intake card cleanly in chat as well!
      try {
        const view = buildCleanUserIntakeCard(uid, updatedDraft);
        if (updatedDraft.activeIntakeMsgId) {
          await bot.telegram.deleteMessage(uid, updatedDraft.activeIntakeMsgId).catch(() => {});
        }
        const sent = await bot.telegram.sendMessage(uid, view.text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...view.keyboard
        }).catch(() => null);
        if (sent?.message_id) {
          updateDraft(uid, { activeIntakeMsgId: sent.message_id });
        }
      } catch {}

      const state = await serializeUserPortalState(uid);
      return sendJson(res, 200, {
        ok: true,
        message: `${verifiedParts.join(' & ')} verified!`,
        state
      });
    }

    // 6. Customer Submit Order from Portal (`POST /api/portal/user-submit`)
    if (req.method === 'POST' && pathname === '/api/portal/user-submit') {
      const body = await readJsonBody(req);
      const uid = String(body.userId || '');
      if (!uid || !verifyPortalToken('user', uid, body.sig || '')) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized request.' });
      }
      const result = await submitDraftAsCleanOrder(uid);
      const state = await serializeUserPortalState(uid, result?.orderId || '');
      return sendJson(res, result?.ok ? 200 : 400, { ...result, state });
    }

    // 7. Customer Approve / Something Is Wrong (`POST /api/portal/user-approve`)
    if (req.method === 'POST' && pathname === '/api/portal/user-approve') {
      const body = await readJsonBody(req);
      const uid = String(body.userId || '');
      const orderId = String(body.orderId || '');
      if (!uid || !verifyPortalToken('user', uid, body.sig || '')) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized request.' });
      }
      const outcome = body.decision === 'approve'
        ? await approveUserOrderBill(uid, orderId)
        : await rejectUserOrderBill(uid, orderId);
      const state = await serializeUserPortalState(uid, body.decision === 'approve' ? orderId : '');
      return sendJson(res, outcome?.ok ? 200 : 400, { ...outcome, state });
    }

    // 8. Customer Status Check ONLY — NEVER creates a duplicate QR (`POST /api/portal/user-check-paid`)
    if (req.method === 'POST' && pathname === '/api/portal/user-check-paid') {
      const body = await readJsonBody(req);
      const uid = String(body.userId || '');
      const orderId = String(body.orderId || '');
      if (!uid || !verifyPortalToken('user', uid, body.sig || '')) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized request.' });
      }
      const checkRes = await checkOrderPaidStatus(orderId);
      const state = await serializeUserPortalState(uid, orderId);
      return sendJson(res, 200, { ok: true, ...checkRes, state });
    }

    // 9. Boss Forwarded-SMS Missing-Field Two-Box `[ ✓ Verify ]` (`POST /api/portal/boss-verify`)
    if (req.method === 'POST' && pathname === '/api/portal/boss-verify') {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || '');
      if (!orderId || !verifyPortalToken('boss_order', orderId, body.sig || '')) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized Boss review request.' });
      }
      const result = await ingestBossPortalUpdate(orderId, {
        cart: String(body.cart || '').trim(),
        address: String(body.address || '').trim()
      });
      if (!result.ok) {
        return sendJson(res, 400, result);
      }
      const state = serializeBossOrderPortalState(orderId);
      return sendJson(res, 200, { ok: true, message: result.message, state });
    }

    // 10. Boss Send Clean Bill Summary to Customer (`POST /api/portal/boss-send-bill`)
    if (req.method === 'POST' && pathname === '/api/portal/boss-send-bill') {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || '');
      if (!orderId || !verifyPortalToken('boss_order', orderId, body.sig || '')) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized Boss action.' });
      }
      const out = await sendBossBillSummaryToCustomer(orderId);
      return sendJson(res, out.ok ? 200 : 400, out);
    }

    // 11. Boss Retry Tracking ONLY — Never creates 2nd QR (`POST /api/portal/boss-retry-track`)
    if (req.method === 'POST' && pathname === '/api/portal/boss-retry-track') {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || '');
      if (!orderId || !verifyPortalToken('boss_order', orderId, body.sig || '')) {
        return sendJson(res, 403, { ok: false, error: 'Unauthorized Boss action.' });
      }
      const checkRes = await checkOrderPaidStatus(orderId);
      return sendJson(res, 200, {
        ok: true,
        message: checkRes.trackingLink ? 'Live tracking link refreshed ✓' : 'Swiggy has not published tracking yet — safe to retry anytime.',
        state: serializeBossOrderPortalState(orderId)
      });
    }

    // 12. Owner-Only Account Manager API (`POST /api/portal/accounts`) — Screen 06 + Screen 07 Security
    if (req.method === 'POST' && pathname === '/api/portal/accounts') {
      const body = await readJsonBody(req);
      const bid = String(body.bossId || '');
      const tgUser = verifyTelegramWebAppInitData(body.initData || '');
      const authed =
        (bid && isBoss(bid) && verifyPortalToken('boss_accounts', bid, body.sig || '')) ||
        (tgUser && isBoss(tgUser.id));

      if (!authed) {
        appendAuditEvent('unauthorized_account_mgr_attempt', { actor: bid || 'unknown' });
        return sendJson(res, 403, { ok: false, error: 'Forbidden — Owner role required on every action.' });
      }

      const action = String(body.action || '');
      const accountKey = String(body.accountKey || '');

      if (action === 'import_json') {
        const resVault = await ingestAndPersistRawAccountTexts([String(body.rawJson || '')], {
          sourceLabel: 'portal-json-import',
          probeLive: false
        });
        const importedCount = Number(resVault?.savedCount ?? resVault?.importedCount ?? 0);
        appendAuditEvent('login', { method: 'json_import', importedCount });
        return sendJson(res, 200, {
          ok: importedCount > 0,
          message: importedCount > 0
            ? `Imported ${importedCount} session(s) permanently ✓`
            : 'No valid session cookie found in pasted JSON.',
          state: serializeBossAccountsPortalState(bid)
        });
      }

      if (action === 'claim_offers') {
        const db = getDb();
        const acc = db?.config?.accounts?.[accountKey];
        if (!acc) return sendJson(res, 404, { ok: false, error: 'Account not found.' });
        const claim = await claimSwiggyBreakfastAndLateNightOffers(acc, { force: true }).catch(e => ({ error: e.message }));
        appendAuditEvent('offer_claim', { accountKey, code: maskAccountCode(acc) });
        return sendJson(res, 200, {
          ok: true,
          message: `${maskAccountCode(acc)} · Eligible daily & welcome offers checked ✓`,
          claim,
          state: serializeBossAccountsPortalState(bid)
        });
      }

      if (action === 'send_otp') {
        const cleanPhone = String(body.phone || '').replace(/\D/g, '').slice(-10);
        if (cleanPhone.length !== 10) {
          return sendJson(res, 400, { ok: false, message: 'Enter a valid 10-digit +91 mobile number.' });
        }
        const lock = getOtpLockStatus(cleanPhone);
        if (lock.locked) {
          return sendJson(res, 429, {
            ok: false,
            locked: true,
            message: `◈ Locked after 3 wrong OTP attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} min.`
          });
        }
        const otpRes = await requestSwiggyOtpViaBridge(Number(bid), cleanPhone, `acc_${cleanPhone}`, `Swiggy ${maskAccountCode(cleanPhone)}`).catch(e => ({ success: false, error: e.message }));
        appendAuditEvent('otp_sent', { phone: maskPhoneStars(cleanPhone) });
        return sendJson(res, otpRes?.success ? 200 : 400, {
          ok: Boolean(otpRes?.success),
          message: otpRes?.success
            ? `OTP sent to ${maskPhoneStars(cleanPhone)} ✓`
            : (otpRes?.error || 'Swiggy OTP gateway busy — import Session JSON instead.')
        });
      }

      if (action === 'verify_otp') {
        const cleanPhone = String(body.phone || '').replace(/\D/g, '').slice(-10);
        const otpCode = String(body.otp || '').trim();
        if (cleanPhone.length !== 10 || !/^\d{6}$/.test(otpCode)) {
          return sendJson(res, 400, { ok: false, message: 'Enter valid 10-digit phone and 6-digit OTP.' });
        }
        const preLock = getOtpLockStatus(cleanPhone);
        if (preLock.locked) {
          return sendJson(res, 429, {
            ok: false,
            locked: true,
            message: `◈ Wrong OTP ×3 lock active for ${maskPhoneStars(cleanPhone)} (${Math.ceil(preLock.retryAfterSec / 60)}m remaining).`
          });
        }
        const verifyRes = await verifySwiggyOtpViaBridge(Number(bid), otpCode).catch(e => ({ success: false, error: e.message }));
        if (!verifyRes?.success || !verifyRes?.cookies) {
          const strike = recordOtpAttempt(cleanPhone, false);
          return sendJson(res, strike.locked ? 429 : 400, {
            ok: false,
            locked: strike.locked,
            failures: strike.failures,
            message: strike.locked
              ? `◈ Wrong OTP ×3 — ${maskPhoneStars(cleanPhone)} locked for 15 minutes.`
              : `Invalid OTP (${strike.failures}/3 attempts used).`
          });
        }
        recordOtpAttempt(cleanPhone, true);
        const key = `acc_${cleanPhone}`;
        updateAccount(key, {
          name: `Swiggy ${maskAccountCode(cleanPhone)}`,
          phone: cleanPhone,
          cookies: verifyRes.cookies,
          tid: verifyRes.tid || '',
          sid: verifyRes.sid || '',
          token: verifyRes.token || '',
          isLoggedIn: true,
          savedAt: new Date().toISOString()
        });
        setActiveOrderAccountKey(key);
        appendAuditEvent('login', { method: 'otp', phone: maskPhoneStars(cleanPhone) });
        return sendJson(res, 200, {
          ok: true,
          message: `Session verified & active (${maskAccountCode(cleanPhone)}) ✓`,
          state: serializeBossAccountsPortalState(bid)
        });
      }

      if (action === 'logout') {
        permanentLogoutAccount(accountKey);
        return sendJson(res, 200, {
          ok: true,
          message: `${maskAccountCode(accountKey)} logged out cleanly.`,
          state: serializeBossAccountsPortalState(bid)
        });
      }

      if (action === 'delete') {
        deleteAccount(accountKey);
        appendAuditEvent('delete', { accountKey, code: maskAccountCode(accountKey) });
        return sendJson(res, 200, {
          ok: true,
          message: `${maskAccountCode(accountKey)} deleted from vault.`,
          state: serializeBossAccountsPortalState(bid)
        });
      }

      return sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
    }

    return false;
  };
}
