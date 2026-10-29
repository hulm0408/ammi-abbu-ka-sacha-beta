// ============================================================================
// SIMPLE CHAT FLOW — "Two links in, one tap consent, tracking link out"
// ----------------------------------------------------------------------------
// This module owns the *customer facing* chat screens when simple mode is on.
// It deliberately knows nothing about Swiggy APIs: it only formats a draft or
// an order into the smallest possible Telegram card.
//
//   1. Customer pastes the Swiggy CART link + ADDRESS link in one message.
//   2. Bot auto-checks the best offer and shows ONE bill card:
//          [ ✅ Confirm ₹xxx ]
//      Tapping it is the customer's consent (no typing, no web app).
//   3. Payment QR arrives in the same chat.
//   4. Swiggy tracking link arrives in the same chat as a button.
//
// Everything stays inside Telegram chat — there is no mini-app / web app.
// ============================================================================

import { getStoredSwiggyTrackingUrl } from './swiggy-cart.js';
import { deviceLoginTruth, deviceLoginCallbacks, isCustomerPhonePlacement } from './customer-device-login.js';

export const SIMPLE_CHAT_CALLBACKS = {
  pasteLinks: 'simple_paste_links',
  clearDraft: 'simple_clear_draft',
  confirmDraft: 'simple_confirm_draft',
  continueDraft: 'simple_continue',
  myOrder: 'simple_my_order',
  newOrder: 'simple_new_order'
};

/**
 * Simple mode is ON by default in production and OFF inside the offline/legacy
 * test suite (TEST_MODE=1) so the historical guarded flows keep working.
 * `SIMPLE_CHAT_MODE=0` always restores the old multi-topic screens.
 */
export function isSimpleChatEnabled() {
  const raw = process.env.SIMPLE_CHAT_MODE;
  if (raw !== undefined && String(raw).trim() !== '') {
    return !/^(0|false|off|no|disabled)$/i.test(String(raw).trim());
  }
  if (String(process.env.TEST_MODE || '') === '1') return false;
  return true;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rupees(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function shortText(text, max = 58) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function itemLines(order, limit = 4) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return [];
  const lines = items.slice(0, limit).map((item) => {
    const qty = Number(item?.qty || item?.quantity || 1) || 1;
    const name = item?.name || item?.item_name || 'Item';
    return `• ${esc(shortText(name, 34))} × ${qty}`;
  });
  if (items.length > limit) lines.push(`• +${items.length - limit} more`);
  return lines;
}

function addressLine(order) {
  const ad = order?.addressDetails || {};
  const text = ad.address || order?.address || '';
  const area = ad.city || ad.area || '';
  const clean = String(text || '').startsWith('http') ? area : (text || area);
  const mobile = String(ad.mobile || '').replace(/\D/g, '').slice(-10);
  const parts = [];
  if (clean) parts.push(shortText(clean, 60));
  if (mobile) parts.push(`📞 ${mobile}`);
  return parts.join(' · ');
}

function restaurantName(order) {
  return order?.restaurantName || order?.restaurant ||
    (order?.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : 'Swiggy order');
}

function amountOf(order) {
  return Number(order?.finalPayable || order?.finalTotal || order?.subtotal || order?.itemTotal || 0);
}

export function simpleTrackingUrl(order) {
  try {
    return getStoredSwiggyTrackingUrl(order) || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Stage detection — one place, so the card, the buttons and the tests agree.
// ---------------------------------------------------------------------------
export function getSimpleStage(order) {
  if (!order) return 'DRAFT';
  const status = String(order.status || '').toUpperCase();
  if (status === 'CANCELLED' || status === 'REJECTED') return 'CLOSED';
  const trackingUrl = simpleTrackingUrl(order);
  if (trackingUrl && (status === 'COMPLETED' || status === 'ACCEPTED' || order.paymentStatus === 'PAID')) {
    return 'TRACKING';
  }
  if (status === 'COMPLETED' || status === 'ACCEPTED') return 'TRACKING';
  if (order.paymentSentToUser || order.customerPaymentMessageId || status === 'PAYMENT_PENDING' || order.billApprovedByUser) {
    return 'PAY';
  }
  if (amountOf(order) > 0 && (order.selectedAccount || order.autoOptimized || status === 'APPROVAL_PENDING' || order.cardStage === 'BILL_READY')) {
    return 'BILL';
  }
  return 'CHECKING';
}

// ---------------------------------------------------------------------------
// 1) HOME — the only screen a customer needs before the two links.
// ---------------------------------------------------------------------------
export function buildSimpleHomeScreen(draft = {}) {
  const hasCart = Boolean(draft?.cart);
  const hasAddress = Boolean(draft?.address);
  const cartDetails = draft?.cartDetails || {};
  const addressDetails = draft?.addressDetails || {};

  const cartItems = Array.isArray(cartDetails.items) ? cartDetails.items : [];
  const cartTotal = Number(cartDetails.subtotal || cartDetails.itemsTotal || 0);

  const cartValue = hasCart
    ? `${esc(shortText(cartDetails.restaurantName || 'Cart link added', 28))}${cartTotal > 0 ? ` · ₹${rupees(cartTotal)}` : ''}` +
      (cartItems.length ? ` (${cartItems.length} item${cartItems.length === 1 ? '' : 's'})` : '')
    : '—';

  // A stored LINK is not a fetched ADDRESS. If Swiggy never opened it, the card
  // must say so — otherwise the customer reads a green address and is then asked
  // to "retry" when the order starts, which looks like the bot contradicting itself.
  const addressUnresolved = Boolean(hasAddress && addressDetails.unresolvableShortLink);
  const addressValue = hasAddress
    ? (addressUnresolved
        ? '⚠️ link added — Swiggy se khul nahi paya'
        : esc(shortText(addressDetails.address || addressDetails.city || 'Address link added', 34)))
    : '—';

  const missing = [];
  if (!hasCart) missing.push('🛒 Cart link');
  if (!hasAddress) missing.push('📍 Address link');

  const hint = addressUnresolved
    ? 'Address link khul nahi paya — ↻ Retry karein, ya seedha address type kar dein.'
    : (missing.length
        ? `Ab ${missing.join(' + ')} bhejein — bas paste karna hai, kuch type nahi karna.`
        : 'Dono links mil gaye — bill check shuru…');

  const text =
    '🍽 <b>Swiggy order</b>\n\n' +
    `🛒 <b>Cart:</b> ${cartValue}\n` +
    `📍 <b>Address:</b> ${addressValue}\n\n` +
    `<i>${hint}</i>`;

  const rows = [
    [{ text: '📋 Cart + Address link paste karein', callback_data: SIMPLE_CHAT_CALLBACKS.pasteLinks, style: 'success' }]
  ];
  if (addressUnresolved) {
    // Fix it right here — the customer should never have to press Continue only
    // to be bounced back with the same retry card.
    rows.unshift([
      { text: '↻ Retry address', callback_data: 'simple_retry_address', style: 'primary' },
      { text: '✍️ Address type karein', callback_data: 'simple_type_address', style: 'primary' }
    ]);
  } else if (hasCart && hasAddress) {
    rows.unshift([{ text: '✅ Continue — check best price', callback_data: SIMPLE_CHAT_CALLBACKS.continueDraft, style: 'success' }]);
  }
  if (hasCart || hasAddress) {
    rows.push([{ text: '✖ Clear', callback_data: SIMPLE_CHAT_CALLBACKS.clearDraft, style: 'danger' }]);
  }

  return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
}

// ---------------------------------------------------------------------------
// 2) ORDER CARD — bill + the single consent button, then payment, then tracking.
// ---------------------------------------------------------------------------
export function buildSimpleOrderCard(order) {
  const stage = getSimpleStage(order);
  const rest = esc(shortText(restaurantName(order), 42));
  const addr = addressLine(order);
  const amount = amountOf(order);
  const savings = Number(order?.totalSavings || 0);
  const rows = [];

  if (stage === 'CLOSED') {
    const text =
      '✖ <b>Order cancelled</b>\n\n' +
      `<i>${esc(order?.cancellationReason || order?.liveOrderStatus || 'Yeh order band ho gaya.')}</i>\n\n` +
      'Naya order shuru karne ke liye neeche dabayein.';
    rows.push([{ text: '🛒 Naya order', callback_data: SIMPLE_CHAT_CALLBACKS.newOrder, style: 'success' }]);
    return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  if (stage === 'TRACKING') {
    const trackingUrl = simpleTrackingUrl(order);
    const swiggyId = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || order?.id || '').trim();
    const otp = String(order?.deliveryOtp || '').trim();
    const partnerName = String(order?.deliveryBoyName || '').trim();
    const partnerPhone = String(order?.deliveryBoyMobile || '').trim();
    const swiggyPhone = String(order?.orderAccount || order?.selectedAccountPhone || order?.injectedSession?.phone || '').trim();
    const eta = String(order?.etaMinutes || '').trim();
    const isDelivered = /delivered/i.test(String(order?.liveOrderStatus || ''));
    const statusText = String(order?.liveOrderStatus || (isDelivered ? 'Delivered' : 'Order Confirmed')).trim();

    const lines = [
      isDelivered ? '🍽 <b>Order Delivered! Enjoy your meal! 🎉</b>' : '✅ <b>Order confirmed</b> — Live Tracking',
      '',
      `▤ <b>${rest}</b>`,
      swiggyId ? `◉ <b>Swiggy ID:</b> <code>${esc(swiggyId)}</code>` : '',
      `◉ <b>Status:</b> <b>${esc(shortText(statusText, 45))}</b>`,
      partnerName ? `🛵 <b>Delivery Partner:</b> ${esc(partnerName)}` : '',
      partnerPhone ? `📞 <b>Call Partner:</b> <code>${esc(partnerPhone)}</code>` : '',
      swiggyPhone ? `📱 <b>Swiggy Account:</b> <code>${esc(swiggyPhone)}</code>` : '',
      otp ? `🔢 <b>Delivery OTP:</b> <code>${esc(otp)}</code>` : '',
      eta && !isDelivered ? `⏱ <b>Estimated Time:</b> ${esc(eta)} mins` : '',
      order?.injectedSessionStatus === 'DELIVERED_RELEASED'
        ? '🔒 <b>Session:</b> <i>Auto-logged out & returned to vault</i>'
        : (order?.injectedSession ? '⚡ <b>Session:</b> <i>Injected & live tracking</i>' : ''),
      '',
      isDelivered
        ? '<i>Order deliver ho gaya hai. Swiggy session automatically logout hokar vault me export ho chuka hai.</i>'
        : (trackingUrl
            ? '<i>Swiggy live tracking link neeche hai 👇</i>'
            : '<i>Swiggy link publish hote hi yahan aa jayega. Live updates yahan aate rahenge.</i>')
    ].filter((line) => line !== null && line !== undefined && line !== '');

    if (partnerPhone) {
      rows.push([{ text: `📞 Call Partner: ${partnerPhone}`, callback_data: `user_call_partner_${order.id}` }]);
    }
    if (trackingUrl) rows.push([{ text: '🛵 Track on Swiggy', url: trackingUrl, style: 'success' }]);
    rows.push([
      { text: '🔄 Refresh status', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
      { text: '🏁 Finish', callback_data: SIMPLE_CHAT_CALLBACKS.newOrder, style: 'primary' }
    ]);
    return { text: lines.join('\n'), keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  if (stage === 'PAY') {
    const paymentUrl = String(order?.swiggyPaymentUrl || '').trim();
    const generic = /^https?:\/\/(www\.)?swiggy\.com\/(checkout|payments)\/?$/i.test(paymentUrl);
    // 📱 Phone placement: bot place nahi karta — Swiggy app se order hota hai.
    const phoneMode = isCustomerPhonePlacement(order);
    const dlTruthPay = order?.deviceLogin ? deviceLoginTruth(order) : null;
    const text =
      (phoneMode ? '📱 <b>Order aapke phone se</b>\n\n' : '💳 <b>Payment</b>\n\n') +
      `▤ <b>${rest}</b>\n` +
      (amount > 0 ? `₹ <b>To Pay:</b> ₹${rupees(amount)}\n` : '') +
      (phoneMode
        ? `\n<i>Swiggy app me login karke Cart kholo — ₹50 cash + offers usi ID par lage hain. Order place karte hi tracking yahin aa jayega.</i>` +
          (dlTruthPay ? `\n${dlTruthPay.icon} <i>${esc(dlTruthPay.label)}</i>` : '')
        : '\n<i>QR upar bheja gaya hai — scan karke pay karein. Payment ke baad tracking link yahin milega.</i>');
    if (paymentUrl && !generic) {
      rows.push([{ text: '💳 Pay on Swiggy', url: paymentUrl, style: 'success' }]);
    }
    rows.push([{ text: '✓ I have paid — get tracking', callback_data: `user_paid_status_${order.id}`, style: 'success' }]);
    rows.push([
      { text: '🔁 Resend QR', callback_data: `user_resend_approved_qr_${order.id}`, style: 'primary' },
      { text: '✖ Cancel', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
    ]);
    return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  if (stage === 'BILL') {
    const items = itemLines(order);
    // 📱 Customer ke phone se order (boss 29-10-2026) — sach wahi jo proof se mila.
    const dlTruth = order?.deviceLogin ? deviceLoginTruth(order) : null;
    const dlCb = deviceLoginCallbacks(order.id);
    const lines = [
      '🧾 <b>Confirm your order</b>',
      '',
      `▤ <b>${rest}</b>`,
      ...items,
      addr ? `📍 ${esc(addr)}` : '',
      '',
      amount > 0 ? `₹ <b>To Pay: ₹${rupees(amount)}</b>${savings > 0 ? `  <i>(saved ₹${rupees(savings)})</i>` : ''}` : '₹ <b>Best price lag raha hai…</b>',
      dlTruth ? `${dlTruth.icon} <b>Phone:</b> ${esc(shortText(dlTruth.label, 70))}` : '',
      '',
      '<i>Confirm dabate hi Swiggy payment QR aayega. Uske baad tracking link yahin milega.</i>'
    ].filter((line) => line !== null && line !== undefined);
    rows.push([
      {
        text: amount > 0 ? `✅ Confirm ₹${rupees(amount)}` : '✅ Confirm order',
        callback_data: `simple_confirm_order_${order.id}`,
        style: 'success'
      }
    ]);
    if (dlTruth) {
      rows.push(isCustomerPhonePlacement(order)
        ? [{ text: '✅ Login ho gaya — check', callback_data: dlCb.check }]
        : [{ text: '📱 Order apne phone se karo', callback_data: dlCb.choosePhone }]);
    }
    rows.push([
      { text: '🔄 Refresh', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
      { text: '✖ Cancel', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
    ]);
    return { text: lines.join('\n'), keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  // CHECKING — offer scan running
  const text =
    '◷ <b>Best price check…</b>\n\n' +
    `▤ <b>${rest}</b>\n` +
    (addr ? `📍 ${esc(addr)}\n` : '') +
    '\n<i>Coupon + free cash lagake final bill nikal raha hoon. 10–20 second.</i>';
  rows.push([
    { text: '🔄 Refresh', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
    { text: '✖ Cancel', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
  ]);
  return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
}

// ---------------------------------------------------------------------------
// 3) TRACKING MESSAGE — delivered once, as its own bubble, the moment Swiggy
//    publishes the real tracking link (works even if the QR message is gone).
// ---------------------------------------------------------------------------
export function buildSimpleTrackingMessage(order, { milestoneUpdate = false } = {}) {
  const trackingUrl = simpleTrackingUrl(order);
  const rest = esc(shortText(restaurantName(order), 42));
  const swiggyId = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || order?.id || '').trim();
  const otp = String(order?.deliveryOtp || '').trim();
  const partnerName = String(order?.deliveryBoyName || '').trim();
  const partnerPhone = String(order?.deliveryBoyMobile || '').trim();
  const swiggyPhone = String(order?.orderAccount || order?.selectedAccountPhone || order?.injectedSession?.phone || '').trim();
  const eta = String(order?.etaMinutes || '').trim();
  const isDelivered = /delivered/i.test(String(order?.liveOrderStatus || ''));
  const statusText = String(order?.liveOrderStatus || (isDelivered ? 'Delivered' : 'Order Confirmed')).trim();

  let title = '🛵 <b>Tracking link aa gaya</b>';
  if (isDelivered) {
    title = '🍽 <b>Order Delivered Successfully! 🎉</b>';
  } else if (milestoneUpdate) {
    title = '🛵 <b>Live Delivery Update</b>';
  }

  const lines = [
    title,
    '',
    `▤ <b>${rest}</b>`,
    swiggyId ? `◉ <b>Order:</b> <code>${esc(swiggyId)}</code>` : '',
    `◉ <b>Status:</b> <b>${esc(shortText(statusText, 45))}</b>`,
    partnerName ? `🛵 <b>Delivery Partner:</b> ${esc(partnerName)}` : '',
    partnerPhone ? `📞 <b>Call Partner:</b> <code>${esc(partnerPhone)}</code>` : '',
    swiggyPhone ? `📱 <b>Swiggy Account:</b> <code>${esc(swiggyPhone)}</code>` : '',
    otp ? `🔢 <b>Delivery OTP:</b> <code>${esc(otp)}</code>` : '',
    eta && !isDelivered ? `⏱ <b>Estimated Time:</b> ${esc(eta)} mins` : '',
    order?.injectedSessionStatus === 'DELIVERED_RELEASED'
      ? '🔒 <b>Session:</b> <i>Auto-logged out & returned to vault</i>'
      : (order?.injectedSession ? '⚡ <b>Session:</b> <i>Injected session active</i>' : ''),
    trackingUrl ? '\n<a href="' + esc(trackingUrl) + '">' + esc(trackingUrl) + '</a>' : ''
  ].filter((line) => line !== null && line !== undefined && line !== '');

  const rows = [];
  if (partnerPhone) {
    rows.push([{ text: `📞 Call Partner: ${partnerPhone}`, callback_data: `user_call_partner_${order.id}` }]);
  }
  if (trackingUrl) rows.push([{ text: '🛵 Track on Swiggy', url: trackingUrl, style: 'success' }]);
  rows.push([{ text: '🏁 Finish', callback_data: SIMPLE_CHAT_CALLBACKS.newOrder, style: 'primary' }]);
  return { text: lines.join('\n'), keyboard: { reply_markup: { inline_keyboard: rows } } };
}

// ---------------------------------------------------------------------------
// 4) Consent record — stamped on the draft and copied onto the order.
// ---------------------------------------------------------------------------
export function buildConsentPatch(order, userId, { via = 'TELEGRAM_BUTTON' } = {}) {
  const amount = amountOf(order);
  return {
    customerConsentGiven: true,
    customerConsentAt: new Date().toISOString(),
    customerConsentBy: String(userId || ''),
    customerConsentVia: via,
    customerConsentAmount: amount > 0 ? amount : null,
    customerConsentText:
      `Customer tapped Confirm in Telegram${amount > 0 ? ` for ₹${rupees(amount)}` : ''}. ` +
      'No web app / mini-app was used.'
  };
}
