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
// The existing chat flow remains available alongside an optional Telegram Mini App.
// ============================================================================

import { getStoredSwiggyTrackingUrl } from './swiggy-cart.js';
import { deviceLoginTruth, deviceLoginCallbacks, isCustomerPhonePlacement } from './customer-device-login.js';

export const SIMPLE_CHAT_CALLBACKS = {
  pasteLinks: 'simple_paste_links',
  clearDraft: 'simple_clear_draft',
  confirmDraft: 'simple_confirm_draft',
  continueDraft: 'simple_continue',
  myOrder: 'simple_my_order',
  loginReady: 'simple_login_ready',
  newOrder: 'simple_new_order',
  orderForOthers: 'simple_order_for_others'
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

function itemLines(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.map((item) => {
    const qty = Number(item?.qty || item?.quantity || 1) || 1;
    const name = item?.name || item?.item_name || 'Item';
    return `• ${esc(name)} × ${qty}`;
  });
}

function addressLine(order) {
  const ad = order?.addressDetails || {};
  const text = ad.address || order?.address || '';
  const area = ad.city || ad.area || '';
  const clean = String(text || '').startsWith('http') ? area : (text || area);
  return clean ? String(clean).replace(/\s+/g, ' ').trim() : '';
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
export function buildSimpleHomeScreen(draft = {}, { miniAppUrl = '' } = {}) {
  const hasCart = Boolean(draft?.cart);
  const hasAddress = Boolean(draft?.address);
  let handoffUrl = '';
  if (hasCart && hasAddress && miniAppUrl) {
    try {
      const url = new URL(miniAppUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        url.searchParams.set('from', 'chat');
        handoffUrl = url.toString();
      }
    } catch {}
  }
  const cartDetails = draft?.cartDetails || {};
  const addressDetails = draft?.addressDetails || {};
  const cartItems = Array.isArray(cartDetails.items) ? cartDetails.items : [];
  const cartTotal = Number(cartDetails.subtotal || cartDetails.itemsTotal || 0);
  const cartValue = hasCart
    ? `${esc(cartDetails.restaurantName || 'Link added')}${cartTotal > 0 ? ` · ₹${rupees(cartTotal)}` : ''}${cartItems.length ? ` · ${cartItems.length} item${cartItems.length === 1 ? '' : 's'}` : ''}`
    : '—';
  const addressUnresolved = Boolean(hasAddress && addressDetails.unresolvableShortLink);
  const addressValue = !hasAddress ? '—' : addressUnresolved
    ? '⚠️ Link could not be opened'
    : esc(addressDetails.address || addressDetails.city || 'Link added');
  const text = `🍽 <b>Swiggy order</b>\n<b>Cart:</b> ${cartValue}\n<b>Address:</b> ${addressValue}`;
  if (hasCart && hasAddress && !addressUnresolved) {
    const buttons = [];
    if (handoffUrl) buttons.push({ text: 'Open Mini App', web_app: { url: handoffUrl } });
    buttons.push({ text: 'Continue in chat', callback_data: SIMPLE_CHAT_CALLBACKS.loginReady });
    return { text, keyboard: { reply_markup: { inline_keyboard: [buttons] } } };
  }
  const rows = [];
  if (addressUnresolved) {
    rows.push([
      { text: 'Retry address', callback_data: 'simple_retry_address' },
      { text: 'Type address', callback_data: 'simple_type_address' }
    ]);
  }
  rows.push([
    { text: 'Send links', callback_data: SIMPLE_CHAT_CALLBACKS.pasteLinks },
    { text: 'For someone else', callback_data: SIMPLE_CHAT_CALLBACKS.orderForOthers }
  ]);
  if (hasCart || hasAddress) rows.push([{ text: 'Clear', callback_data: SIMPLE_CHAT_CALLBACKS.clearDraft }]);
  return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
}

/**
 * ❓ Login me dikkat — chhota madad card (sirf tab jab customer poochhe).
 * Yahan hi phone-login ke saare raste hain (check / apne phone se / bot kare).
 */
export function buildSimpleLoginHelpCard(order) {
  const dlCb = deviceLoginCallbacks(order?.id);
  const truth = order?.deviceLogin ? deviceLoginTruth(order) : null;
  const phone = String(order?.deviceLogin?.phone || order?.orderAccount || '').trim();
  const text =
    '📱 <b>Swiggy login</b>\n' +
    (truth ? `${truth.icon} ${esc(truth.label)}\n` : '') +
    (phone ? `<b>Number:</b> <code>${esc(phone)}</code>\n` : '') +
    'Server session phone mein login nahi karta. Phone login ke liye Swiggy mein OTP chahiye.';
  return {
    text,
    keyboard: {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cart dikh raha hai', callback_data: dlCb.cartYes }, { text: 'Cart nahi dikha', callback_data: dlCb.cartNo }],
          [{ text: 'Bot se order', callback_data: dlCb.botPlaces }]
        ]
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 2) ORDER CARD — bill + the single consent button, then payment, then tracking.
// ---------------------------------------------------------------------------
export function buildSimpleOrderCard(order, { serviceFeePaise = null, feeExempt = false, placementPossible = false } = {}) {
  const stage = getSimpleStage(order);
  const rest = esc(restaurantName(order));
  const addr = addressLine(order);
  const amount = amountOf(order);
  const savings = Number(order?.totalSavings || 0);
  const rows = [];
  const recipientName = String(order?.recipientName || order?.addressDetails?.name || '').trim();
  const recipientMobile = String(order?.recipientMobile || order?.addressDetails?.mobile || '').replace(/\D/g, '').slice(-10);
  const recipient = [recipientName, recipientMobile].filter(Boolean).map(esc).join(' · ');

  if (stage === 'CLOSED') {
    const reason = esc(order?.cancellationReason || order?.liveOrderStatus || 'Order band hai.');
    rows.push([{ text: 'New order', callback_data: SIMPLE_CHAT_CALLBACKS.newOrder }]);
    return { text: `✖ <b>Order cancelled</b>\n${reason}`, keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  if (stage === 'TRACKING') {
    const trackingUrl = simpleTrackingUrl(order);
    const swiggyId = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || '').trim();
    const otp = String(order?.deliveryOtp || '').trim();
    const partnerName = String(order?.deliveryBoyName || '').trim();
    const partnerPhone = String(order?.deliveryBoyMobile || '').trim();
    const swiggyPhone = String(order?.orderAccount || order?.selectedAccountPhone || order?.injectedSession?.phone || '').trim();
    const eta = String(order?.etaMinutes || '').trim();
    const isDelivered = /delivered/i.test(String(order?.liveOrderStatus || ''));
    const statusText = String(order?.liveOrderStatus || (order?.status === 'COMPLETED' ? 'Completed' : order?.status === 'ACCEPTED' ? 'Accepted' : 'Update pending')).trim();
    const partner = [partnerName, partnerPhone].filter(Boolean).map(esc).join(' · ');
    const lines = [
      isDelivered ? '✅ <b>Order delivered</b>' : '🛵 <b>Order status</b>',
      `<b>${rest}</b>`,
      recipient ? `<b>For:</b> ${recipient}` : '',
      swiggyId ? `<b>Swiggy ID:</b> <code>${esc(swiggyId)}</code>` : `<b>Order ref:</b> <code>${esc(order?.id || '')}</code>`,
      `<b>Status:</b> ${esc(statusText)}`,
      partner ? `<b>Partner:</b> ${partner}` : '',
      swiggyPhone ? `<b>Swiggy account:</b> <code>${esc(swiggyPhone)}</code>` : '',
      otp ? `<b>Delivery OTP:</b> <code>${esc(otp)}</code>` : '',
      eta && !isDelivered ? `<b>ETA:</b> ${esc(eta)} min` : '',
      !trackingUrl && !isDelivered ? 'Tracking link not available yet.' : ''
    ].filter(Boolean);
    if (trackingUrl) rows.push([{ text: 'Track on Swiggy', url: trackingUrl }]);
    else rows.push([{ text: 'Get tracking', callback_data: `track_now_${order.id}` }]);
    const lastRow = [];
    if (partnerPhone) lastRow.push({ text: 'Call partner', callback_data: `user_call_partner_${order.id}` });
    lastRow.push({ text: 'Done', callback_data: SIMPLE_CHAT_CALLBACKS.newOrder });
    rows.push(lastRow);
    return { text: lines.join('\n'), keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  const heldStage = String(order?.cardStage || '').toUpperCase();
  if (heldStage === 'QR_RETRY') {
    const text = `⚠️ <b>QR unavailable</b>\n${rest}\n${placementPossible ? 'Order may exist. Check the original account; do not retry.' : 'Check the order before retrying.'}`;
    if (!placementPossible) rows.push([{ text: 'Retry QR', callback_data: `user_retry_qr_${order.id}` }]);
    rows.push(placementPossible
      ? [{ text: 'Support', callback_data: 'support_contact_admin' }]
      : [{ text: 'Support', callback_data: 'support_contact_admin' }, { text: 'Cancel', callback_data: `action_cancel_order_confirm_${order.id}` }]);
    return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
  }
  if (heldStage === 'AWAITING_FEE' || heldStage === 'QR_HELD') {
    const fee = Number(order?.feeDuePaise || 0) / 100;
    const text = `🔐 <b>Service fee required</b>\n${rest}${fee > 0 ? `\n<b>Fee:</b> ₹${rupees(fee)}` : ''}${amount > 0 ? `\n<b>Order payment:</b> ₹${rupees(amount)}` : ''}\nFee and order payment are separate.`;
    rows.push([{ text: 'View fee', callback_data: 'wallet_verify_pay' }, { text: 'Support', callback_data: 'support_contact_admin' }]);
    return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  if (stage === 'PAY') {
    const paymentUrl = String(order?.swiggyPaymentUrl || '').trim();
    const generic = /^https?:\/\/(www\.)?swiggy\.com\/(checkout|payments)\/?$/i.test(paymentUrl);
    const phoneMode = isCustomerPhonePlacement(order);
    const dlTruth = order?.deviceLogin ? deviceLoginTruth(order) : null;
    const paymentSent = Boolean(order?.paymentSentToUser || order?.customerPaymentMessageId);
    const paymentHint = paymentSent
      ? 'Use the payment details and check payment status.'
      : paymentUrl && !generic ? 'Open payment and check its status.' : 'Payment details pending.';
    const text = [
      phoneMode ? '📱 <b>Order on your phone</b>' : '💳 <b>Payment</b>',
      `<b>${rest}</b>`,
      amount > 0 ? `<b>To pay:</b> ₹${rupees(amount)}` : '',
      phoneMode ? 'Place the order in Swiggy on your phone.' : paymentHint,
      phoneMode && dlTruth ? `${dlTruth.icon} ${esc(dlTruth.label)}` : ''
    ].filter(Boolean).join('\n');
    if (paymentUrl && !generic) rows.push([{ text: 'Pay on Swiggy', url: paymentUrl }]);
    rows.push([{ text: 'Check payment', callback_data: `user_paid_status_${order.id}` }, { text: 'Support', callback_data: 'support_contact_admin' }]);
    return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  if (stage === 'BILL') {
    const dlTruth = order?.deviceLogin ? deviceLoginTruth(order) : null;
    const lines = [
      '🧾 <b>Confirm your order</b>',
      `<b>${rest}</b>`,
      recipient ? `<b>For:</b> ${recipient}` : '',
      ...itemLines(order),
      addr ? `<b>Address:</b> ${esc(addr)}` : '',
      amount > 0 ? `<b>Order payment: ₹${rupees(amount)}</b>${savings > 0 ? ` · saved ₹${rupees(savings)}` : ''}` : '<b>Checking bill…</b>',
      !feeExempt && Number(serviceFeePaise) > 0 ? `<b>Service fee:</b> ₹${rupees(Number(serviceFeePaise) / 100)} · separate` : ''
    ].filter(Boolean);
    rows.push([{ text: amount > 0 ? `Confirm ₹${rupees(amount)}` : 'Confirm', callback_data: `simple_confirm_order_${order.id}` }]);
    if (dlTruth && dlTruth.status === 'FAILED') rows.push([{ text: 'Login help', callback_data: `simple_login_help_${order.id}` }]);
    return { text: lines.join('\n'), keyboard: { reply_markup: { inline_keyboard: rows } } };
  }

  const text = `◷ <b>Checking bill…</b>\n${rest}${addr ? `\n<b>Address:</b> ${esc(addr)}` : ''}`;
  rows.push([{ text: 'Refresh', callback_data: `user_refresh_status_${order.id}` }, { text: 'Cancel', callback_data: `action_cancel_order_confirm_${order.id}` }]);
  return { text, keyboard: { reply_markup: { inline_keyboard: rows } } };
}

// ---------------------------------------------------------------------------
// 3) TRACKING MESSAGE — delivered once, as its own bubble, the moment Swiggy
//    publishes the real tracking link (works even if the QR message is gone).
// ---------------------------------------------------------------------------
export function buildSimpleTrackingMessage(order, { milestoneUpdate = false } = {}) {
  const trackingUrl = simpleTrackingUrl(order);
  const rest = esc(restaurantName(order));
  const swiggyId = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || '').trim();
  const otp = String(order?.deliveryOtp || '').trim();
  const partnerName = String(order?.deliveryBoyName || '').trim();
  const partnerPhone = String(order?.deliveryBoyMobile || '').trim();
  const swiggyPhone = String(order?.orderAccount || order?.selectedAccountPhone || order?.injectedSession?.phone || '').trim();
  const eta = String(order?.etaMinutes || '').trim();
  const isDelivered = /delivered/i.test(String(order?.liveOrderStatus || ''));
  const statusText = String(order?.liveOrderStatus || (order?.status === 'COMPLETED' ? 'Completed' : order?.status === 'ACCEPTED' ? 'Accepted' : 'Update pending')).trim();
  const recipientName = String(order?.recipientName || order?.addressDetails?.name || '').trim();
  const recipientMobile = String(order?.recipientMobile || order?.addressDetails?.mobile || '').replace(/\D/g, '').slice(-10);
  const recipient = [recipientName, recipientMobile].filter(Boolean).map(esc).join(' · ');
  const partner = [partnerName, partnerPhone].filter(Boolean).map(esc).join(' · ');
  const title = isDelivered ? '✅ <b>Order delivered</b>' : milestoneUpdate || !trackingUrl ? '🛵 <b>Order update</b>' : '🛵 <b>Tracking ready</b>';
  const lines = [
    title,
    `<b>${rest}</b>`,
    recipient ? `<b>For:</b> ${recipient}` : '',
    swiggyId ? `<b>Swiggy ID:</b> <code>${esc(swiggyId)}</code>` : '',
    `<b>Status:</b> ${esc(statusText)}`,
    partner ? `<b>Partner:</b> ${partner}` : '',
    swiggyPhone ? `<b>Swiggy account:</b> <code>${esc(swiggyPhone)}</code>` : '',
    otp ? `<b>Delivery OTP:</b> <code>${esc(otp)}</code>` : '',
    eta && !isDelivered ? `<b>ETA:</b> ${esc(eta)} min` : '',
    !trackingUrl && order?.ofoPlaced === false ? 'OFO not confirmed; ask support.' : ''
  ].filter(Boolean);
  const rows = [];
  if (trackingUrl) rows.push([{ text: 'Track on Swiggy', url: trackingUrl }]);
  if (!trackingUrl && order?.ofoPlaced === false) rows.push([{ text: 'Support', callback_data: 'support_contact_admin' }]);
  const lastRow = [];
  if (partnerPhone) lastRow.push({ text: 'Call partner', callback_data: `user_call_partner_${order.id}` });
  lastRow.push({ text: 'New order', callback_data: SIMPLE_CHAT_CALLBACKS.newOrder });
  rows.push(lastRow);
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
