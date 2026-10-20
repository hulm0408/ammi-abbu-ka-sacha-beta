import crypto from 'crypto';
import { Markup } from 'telegraf';
import { getDb, saveDb } from './store.js';
import {
  resolveSwiggyLink,
  parseAddressDetails,
  parseCartDetails,
  geocodeAddressDetails,
  reverseGeocodeCoords,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  generatePersonalizedQrCard,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  getSwiggySessionAuth
} from './swiggy-cart.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePersonName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const PUBLIC_APP_URL = (process.env.RENDER_EXTERNAL_URL || 'https://ammi-abbu-ka-sacha-beta.onrender.com').replace(/\/+$/, '');
const activePaymentPollers = new Map();

export function computeTrackHmac(orderId) {
  const secret = process.env.BOT_TOKEN || 'swiggy_live_track_secret';
  return crypto.createHmac('sha256', secret).update(`track:${orderId}`).digest('hex').slice(0, 24);
}

export function buildLiveShareableTrackUrl(orderId) {
  return `${PUBLIC_APP_URL}/track/${encodeURIComponent(orderId)}?sig=${computeTrackHmac(orderId)}`;
}

// ===========================================================================
// INSTANT COPY-PASTE AI DIAGNOSTIC ERROR REPORTER
// Sends a crystal-clear, structured `[AI-DIAG]` block directly to Boss whenever
// ANY error happens in link parsing, cart sync, Real QR creation, or Tracking!
// ===========================================================================
export function formatBossDiagnosticErrorMessage(err, context = {}) {
  const diag = err?.diag || {};
  const lines = [
    '[AI-DIAG]',
    `code: ${diag.code || err?.code || 'UNHANDLED_ORDER_FLOW_ERROR'}`,
    `stage: ${context.stage || diag.stage || 'ORDER_FLOW'}`,
    context.orderId ? `orderId: ${context.orderId}` : null,
    context.accountKey ? `account: ${context.accountKey}${context.accountPhone ? ` (${context.accountPhone})` : ''}` : null,
    context.senderName ? `sender: ${context.senderName} (${context.isForwarded ? 'forwarded' : 'boss-direct'})` : null,
    context.cartLink ? `cart: ${context.cartLink}` : null,
    context.address ? `address: ${String(context.address).replace(/\s+/g, ' ').slice(0, 140)}` : null,
    diag.httpStatus != null ? `httpStatus: ${diag.httpStatus}` : null,
    diag.swiggyStatusCode != null ? `swiggyStatusCode: ${diag.swiggyStatusCode}` : null,
    diag.swiggyMessage ? `swiggyMsg: ${diag.swiggyMessage}` : null,
    diag.cartId ? `cartId: ${diag.cartId} | addressId: ${diag.addressId || ''}` : null,
    `error: ${err?.message || String(err)}`,
    diag.rawSnippet ? `raw: ${String(diag.rawSnippet).replace(/\s+/g, ' ').slice(0, 260)}` : null,
    `time: ${new Date().toISOString()}`
  ].filter(Boolean);

  return (
    `❌ <b>Error Detected — Copy &amp; Send This Message Directly:</b>\n\n` +
    `<code>${escapeHtml(lines.join('\n'))}</code>`
  );
}

export async function sendBossDiagnosticError(ctxOrTelegram, chatId, err, context = {}) {
  const html = formatBossDiagnosticErrorMessage(err, context);
  try {
    if (ctxOrTelegram && typeof ctxOrTelegram.reply === 'function') {
      await ctxOrTelegram.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } else if (ctxOrTelegram && typeof ctxOrTelegram.sendMessage === 'function' && chatId) {
      await ctxOrTelegram.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
  } catch (sendErr) {
    console.error('[DiagSendError]', sendErr.message);
  }
}

// Extract original sender identity ONLY when message is genuinely forwarded from another chat/user
export function extractForwardSenderInfo(msg) {
  if (!msg) return null;

  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === 'user' && origin.sender_user) {
      const u = origin.sender_user;
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${u.id}`;
      return {
        isForwarded: true,
        senderId: String(u.id),
        senderName: fullName,
        senderUsername: u.username ? String(u.username) : null,
        originType: 'user'
      };
    }
    if (origin.type === 'hidden_user') {
      const hiddenName = String(origin.sender_user_name || 'Customer').trim();
      return {
        isForwarded: true,
        senderId: null,
        senderName: hiddenName,
        senderUsername: null,
        originType: 'hidden_user'
      };
    }
    if ((origin.type === 'chat' || origin.type === 'channel') && (origin.sender_chat || origin.chat)) {
      const ch = origin.sender_chat || origin.chat;
      const title = origin.author_signature || ch.title || ch.username || `Chat ${ch.id}`;
      return {
        isForwarded: true,
        senderId: String(ch.id),
        senderName: String(title).trim(),
        senderUsername: ch.username ? String(ch.username) : null,
        originType: origin.type
      };
    }
  }

  if (msg.forward_from) {
    const u = msg.forward_from;
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${u.id}`;
    return {
      isForwarded: true,
      senderId: String(u.id),
      senderName: fullName,
      senderUsername: u.username ? String(u.username) : null,
      originType: 'user'
    };
  }
  if (msg.forward_sender_name) {
    return {
      isForwarded: true,
      senderId: null,
      senderName: String(msg.forward_sender_name).trim(),
      senderUsername: null,
      originType: 'hidden_user'
    };
  }
  if (msg.forward_from_chat) {
    const ch = msg.forward_from_chat;
    return {
      isForwarded: true,
      senderId: String(ch.id),
      senderName: String(msg.forward_signature || ch.title || ch.username || `Chat ${ch.id}`).trim(),
      senderUsername: ch.username ? String(ch.username) : null,
      originType: 'chat'
    };
  }

  return null;
}

// Unified sender resolver:
// - If forwarded -> uses THAT person's Name & ID (`isForwarded: true`)
// - If sent directly by Boss -> uses BOSS'S OWN Name & ID (`isForwarded: false`)
export function resolveOrderSenderInfo(msg, fromUser) {
  const fwd = extractForwardSenderInfo(msg);
  if (fwd) return fwd;
  if (!fromUser) return null;
  const fullName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ').trim() || fromUser.username || `User ${fromUser.id}`;
  return {
    isForwarded: false,
    senderId: String(fromUser.id),
    senderName: fullName,
    senderUsername: fromUser.username ? String(fromUser.username) : null,
    originType: 'boss_direct'
  };
}

// Detects whether a normal direct message from Boss is a Cart link, Address link, Address block, or GPS pin
export function looksLikeBossOrderInput(rawText = '', location = null) {
  if (location && location.latitude != null && location.longitude != null) return true;
  const t = String(rawText || '').trim();
  if (!t || t.startsWith('/')) return false;

  // 1. Any Swiggy or Google/Apple Maps link
  if (/https?:\/\/[^\s]*(swig\.gy|swiggy\.com|swiggy\.onelink\.me|maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps|maps\.google)/i.test(t)) {
    return true;
  }

  // 2. Structured Swiggy address share / receipt address text / PIN code street address
  if (/\b(Address\s*:|Save my address on Swiggy|Latitude\s*:|Longitude\s*:)/i.test(t)) {
    return true;
  }
  if (/\b[A-Za-z]+\s+Address\b/i.test(t) && /\b\d{6}\b/.test(t)) {
    return true;
  }
  if (/\b\d{6}\b/.test(t) && t.includes(',') && t.length >= 25 && !t.startsWith('{') && !t.startsWith('[')) {
    return true;
  }

  return false;
}

// Find an active incomplete card order for the same sender (either same forwarded person OR Boss direct)
export function findIncompleteForwardedOrder(db, sender) {
  if (!db?.orders || !sender) return null;
  const targetNormName = normalizePersonName(sender.senderName);
  const candidates = Object.values(db.orders)
    .filter(o => {
      if (!o || !o.isForwardedOrder) return false;
      if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) return false;
      if (o.paidVerified) return false;
      // Keep direct Boss personal orders separate from forwarded customer orders even if names ever overlap
      if (Boolean(o.isDirectBossOrder) !== !sender.isForwarded) return false;
      if (sender.senderId && o.fwdSenderId && String(o.fwdSenderId) === String(sender.senderId)) {
        return true;
      }
      if (targetNormName && normalizePersonName(o.fwdSenderName) === targetNormName) {
        return true;
      }
      return false;
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return candidates[0] || null;
}

function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/https?:\/\/[^\s<>")]+/gi) || [];
  return matches.map(u => u.replace(/[.,;!?)]+$/, ''));
}

export async function deleteOrderBotMessages(telegram, order, { deleteQr = false, deleteCard = true } = {}) {
  if (!telegram || !order) return;
  if (deleteCard && order.bossCardChatId && order.bossCardMsgId) {
    try {
      await telegram.deleteMessage(order.bossCardChatId, order.bossCardMsgId);
    } catch (e) {}
    order.bossCardMsgId = null;
  }
  if (deleteQr && order.qrChatId && order.qrMsgId) {
    try {
      await telegram.deleteMessage(order.qrChatId, order.qrMsgId);
    } catch (e) {}
    order.qrMsgId = null;
  }
}

function getAllConnectedAccountEntries(db) {
  const accs = db?.config?.accounts || {};
  return Object.entries(accs).map(([key, acc]) => ({
    key,
    acc,
    phone: acc?.phone || acc?.mobile || key.replace(/^acc_/, ''),
    name: acc?.name || acc?.userName || acc?.phone || key,
    hasCookies: Boolean(acc?.cookies && String(acc.cookies).trim().length > 15)
  }));
}

export function buildForwardedSenderHeader(order) {
  const nameHtml = order.fwdSenderId
    ? `<a href="tg://user?id=${escapeHtml(order.fwdSenderId)}">${escapeHtml(order.fwdSenderName || order.userName || 'Customer')}</a>`
    : `<b>${escapeHtml(order.fwdSenderName || order.userName || 'Customer')}</b>`;
  const uname = order.fwdSenderUsername ? ` (@${escapeHtml(order.fwdSenderUsername)})` : '';
  const roleLabel = order.isDirectBossOrder ? '👤 <b>Order For:</b>' : '👤 <b>Forwarded From:</b>';
  return `${roleLabel} ${nameHtml}${uname}`;
}

// ===========================================================================
// CARD RENDERER FOR ALL 4 LIFECYCLE STAGES
// Stage D: Partial card (waiting for missing Cart or Address)
// Stage C: Account Chooser card (both Address & Cart present -> pick account)
// Stage B: Fetched Bill card (`[ 🔳 Generate QR ]` + `[ ✅ Paid ]` + `[ ❌ Cancel Order ]`)
// Stage A: Confirmed Paid card (exact same details + REAL Live Tracking Links + `[ ❌ Cancel Order ]`)
// EVERY STAGE ALWAYS INCLUDES `[ ❌ Cancel Order ]`!
// ===========================================================================
export function buildForwardedOrderCardView(order, formatOrderBodyFn) {
  const db = getDb();
  const hasCart = Boolean(order.cart || (order.items && order.items.length > 0));
  const hasAddress = Boolean(order.address || order.addressDetails?.address || order.addressDetails?.lat);
  const cancelRow = [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)];

  // STAGE A: PAID & CONFIRMED -> SAME FULL ORDER/BILL DETAILS + REAL LIVE TRACKING LINKS
  if (order.status === 'COMPLETED' && order.paidVerified) {
    const shareTrackUrl = order.shareTrackUrl || buildLiveShareableTrackUrl(order.id);
    const swiggyDirectUrl = order.trackingLink || (order.swiggyOrderId
      ? `https://www.swiggy.com/track-order/${order.swiggyOrderId}`
      : 'https://www.swiggy.com/my-account/orders');
    const bodyText = formatOrderBodyFn(order, true);

    const statusLine = order.liveOrderStatus ? `\n📦 <b>Status:</b> ${escapeHtml(order.liveOrderStatus)}` : '';
    const etaLine = order.etaMinutes ? ` • ⏱ <b>ETA:</b> ${escapeHtml(order.etaMinutes)} mins` : '';
    const riderLine = order.deliveryBoyName
      ? `\n🏍 <b>Delivery Partner:</b> ${escapeHtml(order.deliveryBoyName)}${order.deliveryBoyMobile ? ` (<a href="tel:${escapeHtml(order.deliveryBoyMobile)}">${escapeHtml(order.deliveryBoyMobile)}</a>)` : ''}`
      : '';

    const text =
      `✅ <b>ORDER PAID &amp; CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `${buildForwardedSenderHeader(order)}\n` +
      (order.swiggyOrderId ? `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(order.swiggyOrderId)}</code>\n` : '') +
      statusLine + etaLine + riderLine +
      `\n\n${bodyText}\n\n` +
      `🛵 <b>Live Tracking Link (Share with Customer — No Login Needed):</b>\n` +
      `<a href="${escapeHtml(shareTrackUrl)}">${escapeHtml(shareTrackUrl)}</a>\n` +
      `🔗 <b>Swiggy Direct Link:</b> <a href="${escapeHtml(swiggyDirectUrl)}">${escapeHtml(swiggyDirectUrl)}</a>`;

    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.url('🛵 Track Live Order (Shareable Map)', shareTrackUrl)],
        [Markup.button.url('🟠 Open in Swiggy App / Web', swiggyDirectUrl)],
        cancelRow
      ])
    };
  }

  // STAGE B: ACCOUNT SELECTED & BILL FETCHED -> SHOW EXACT FINAL BILL + `[ 🔳 Generate QR ]` + `[ ✅ Paid ]` + `[ ❌ Cancel Order ]`
  if (hasCart && hasAddress && order.selectedAccount && order.accountFetched) {
    const bodyText = formatOrderBodyFn(order, true);
    const statusNote = order.paymentProcessingNote
      ? `\n\n⏳ <b>Payment Status:</b> <i>${escapeHtml(order.paymentProcessingNote)}</i>`
      : '';
    const text =
      `🧾 <b>ORDER SUMMARY (#${escapeHtml(order.id)})</b>\n` +
      `${buildForwardedSenderHeader(order)}\n\n` +
      `${bodyText}${statusNote}`;

    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [
          Markup.button.callback(order.pendingSwiggyUpiUri ? '🔄 Regenerate Real QR' : '🔳 Generate QR', `fwd_gen_qr_${order.id}`),
          Markup.button.callback('✅ Paid', `fwd_check_paid_${order.id}`)
        ],
        [
          Markup.button.callback('🔄 Change Account', `fwd_rechoose_acc_${order.id}`),
          Markup.button.callback('🎟 Change Coupon', `boss_coupon_picker_${order.id}`)
        ],
        cancelRow
      ])
    };
  }

  // STAGE C: BOTH ADDRESS & CART PRESENT -> PROMPT BOSS TO CHOOSE SWIGGY ACCOUNT
  if (hasCart && hasAddress) {
    const ad = order.addressDetails || parseAddressDetails(order.address) || {};
    const addrPreview = ad.address || order.address || `${ad.lat}, ${ad.lng}`;
    const restPreview = order.restaurantName || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : 'Swiggy Cart');
    const itemsPreview = order.items?.length
      ? order.items.map((it, i) => `  ${i + 1}. ${escapeHtml(it.name)} × ${it.qty} (₹${it.lineTotal})`).join('\n')
      : `  🔗 <a href="${escapeHtml(order.cart)}">${escapeHtml(order.cart)}</a>`;

    const allAccounts = getAllConnectedAccountEntries(db);
    const rows = [
      [Markup.button.callback('🏆 Auto Best Account (Max Coupon)', `fwd_pick_acc_${order.id}__AUTO_BEST`)]
    ];

    for (const entry of allAccounts) {
      const badge = entry.hasCookies ? '🟢' : '🔴';
      const label = `${badge} ${entry.phone}${entry.name && entry.name !== entry.phone ? ` (${entry.name})` : ''}`;
      rows.push([Markup.button.callback(label.slice(0, 60), `fwd_pick_acc_${order.id}__${entry.key}`)]);
    }
    rows.push(cancelRow);

    const text =
      `📦 <b>ORDER READY — CHOOSE ACCOUNT (#${escapeHtml(order.id)})</b>\n` +
      `${buildForwardedSenderHeader(order)}\n\n` +
      `📍 <b>Address:</b> ✅ Received\n` +
      `${ad.name ? `👤 ${escapeHtml(ad.name)}${ad.mobile ? ` • ${escapeHtml(ad.mobile)}` : ''}\n` : ''}` +
      `${escapeHtml(addrPreview)}\n\n` +
      `🛒 <b>Cart:</b> ✅ ${escapeHtml(restPreview)}\n` +
      `${itemsPreview}\n` +
      (order.subtotal ? `💵 <b>Cart Subtotal:</b> ₹${order.subtotal}\n\n` : '\n') +
      `👇 <b>Choose Swiggy Account to fetch live bill &amp; apply max coupon:</b>`;

    return {
      text,
      keyboard: Markup.inlineKeyboard(rows)
    };
  }

  // STAGE D: PARTIAL CARD (ONLY ADDRESS OR ONLY CART RECEIVED SO FAR)
  const ad = hasAddress ? (order.addressDetails || parseAddressDetails(order.address) || {}) : null;
  const addrStatus = hasAddress
    ? `✅ ${escapeHtml(ad?.address || order.address || `${ad?.lat}, ${ad?.lng}`)}`
    : `⏳ <i>Waiting — ${order.isDirectBossOrder ? 'send Address link / text / GPS pin' : 'forward customer\'s Address link / text / GPS pin'}</i>`;

  const cartStatus = hasCart
    ? `✅ ${escapeHtml(order.restaurantName || 'Swiggy Cart')}${order.subtotal ? ` (₹${order.subtotal})` : ''}\n🔗 <code>${escapeHtml(order.cart)}</code>`
    : `⏳ <i>Waiting — ${order.isDirectBossOrder ? 'send Swiggy Cart link' : 'forward customer\'s Swiggy Cart link'}</i>`;

  const text =
    `📩 <b>NEW ORDER CARD (#${escapeHtml(order.id)})</b>\n` +
    `${buildForwardedSenderHeader(order)}\n\n` +
    `📍 <b>Address:</b>\n${addrStatus}\n\n` +
    `🛒 <b>Cart:</b>\n${cartStatus}\n\n` +
    `<i>💡 Send ${!hasAddress ? 'Address' : 'Cart'} next — this card will auto-replace cleanly!</i>`;

  return {
    text,
    keyboard: Markup.inlineKeyboard([cancelRow])
  };
}

// ===========================================================================
// TRANSITION TO PAID + REAL LIVE TRACKING CARD
// Deletes BOTH previous Bill Card AND QR Photo Card, then posts fresh Confirmed Card
// with IDENTICAL order/bill details + REAL Live Tracking Links + `[ ❌ Cancel Order ]`!
// ===========================================================================
async function completeOrderWithRealTracking(telegram, orderId, payResult, formatOrderBodyFn) {
  stopOrderPaymentPoller(orderId);
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order || order.paidVerified) return false;

  order.status = 'COMPLETED';
  order.paidVerified = true;
  order.paymentProcessingNote = null;
  order.swiggyOrderId = payResult.swiggyOrderId;
  order.liveOrderStatus = payResult.orderStatus || 'Order Confirmed';
  order.etaMinutes = payResult.etaMinutes || order.etaMinutes || '';
  order.deliveryBoyName = payResult.deliveryBoy?.name || '';
  order.deliveryBoyMobile = payResult.deliveryBoy?.mobile || '';
  order.trackingLink = payResult.swiggyWebTrackUrl || `https://www.swiggy.com/track-order/${payResult.swiggyOrderId}`;
  order.shareTrackUrl = buildLiveShareableTrackUrl(order.id);
  saveDb(db);

  const chatId = order.bossCardChatId || order.qrChatId || order.userChatId;

  // Delete BOTH old Bill Card AND QR Photo Card!
  await deleteOrderBotMessages(telegram, order, { deleteCard: true, deleteQr: true });

  const completedView = buildForwardedOrderCardView(order, formatOrderBodyFn);
  if (chatId) {
    const sent = await telegram.sendMessage(chatId, completedView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...completedView.keyboard
    });
    order.bossCardChatId = sent.chat?.id ?? chatId;
    order.bossCardMsgId = sent.message_id;
    saveDb(db);
  }
  return true;
}

export function stopOrderPaymentPoller(orderId) {
  const existing = activePaymentPollers.get(orderId);
  if (existing) {
    clearInterval(existing);
    activePaymentPollers.delete(orderId);
  }
}

// Automatic background payment watcher after Real QR is generated:
// Polls Swiggy every 4s for up to 10 minutes — the moment customer pays on GPay/PhonePe/Paytm,
// auto-confirms on Swiggy AND immediately swaps the old card + QR for the Live Tracking Card!
function startOrderPaymentPoller(telegram, orderId, formatOrderBodyFn, customPaymentChecker = null) {
  stopOrderPaymentPoller(orderId);
  let ticks = 0;
  const maxTicks = 150; // ~10 minutes @ 4s intervals

  const timer = setInterval(async () => {
    ticks++;
    if (ticks > maxTicks) {
      stopOrderPaymentPoller(orderId);
      return;
    }
    try {
      const db = getDb();
      const order = db.orders?.[orderId];
      if (!order || order.paidVerified || ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
        stopOrderPaymentPoller(orderId);
        return;
      }
      const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
      if (!acc?.cookies) return;

      const checkFn = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
      const payCheck = await checkFn(acc, order);
      if (payCheck?.paid) {
        await completeOrderWithRealTracking(telegram, orderId, payCheck, formatOrderBodyFn);
      }
    } catch (e) {
      // Silent during background poll; manual Paid tap shows full diagnostic if API fails
    }
  }, 4000);

  if (typeof timer.unref === 'function') timer.unref();
  activePaymentPollers.set(orderId, timer);
}

// ===========================================================================
// PARSE INCOMING MESSAGE / LOCATION INTO CART & ADDRESS FIELDS
// ===========================================================================
export async function ingestForwardedContentIntoOrder(order, { rawText = '', location = null } = {}) {
  let updatedCart = false;
  let updatedAddress = false;
  const parseWarnings = [];

  if (location && location.latitude != null && location.longitude != null) {
    const geo = await reverseGeocodeCoords(location.latitude, location.longitude).catch(() => null);
    order.addressDetails = {
      ...(order.addressDetails || {}),
      name: order.addressDetails?.name || order.fwdSenderName || 'Customer',
      lat: Number(location.latitude),
      lng: Number(location.longitude),
      address: geo?.address || `${location.latitude}, ${location.longitude}`,
      city: geo?.city || order.addressDetails?.city || '',
      area: geo?.area || ''
    };
    order.address = order.addressDetails.address;
    updatedAddress = true;
  }

  const trimmed = String(rawText || '').trim();
  if (trimmed) {
    const urls = extractUrls(trimmed);

    for (const url of urls) {
      let resolved = null;
      try {
        resolved = await resolveSwiggyLink(url);
      } catch (linkErr) {
        parseWarnings.push(linkErr);
      }

      if (resolved?.expired || resolved?.groupCartStatus === 'EXPIRED' || resolved?.status === 'EXPIRED') {
        const err = new Error(`Group Cart link expired or closed on Swiggy: ${url}`);
        err.diag = { code: 'GROUP_CART_EXPIRED', stage: 'RESOLVE_CART_LINK', swiggyMessage: resolved?.groupCartStatus || 'EXPIRED' };
        throw err;
      }

      if (resolved?.type === 'CART' || /\/gc\/|group|cart|restaurants|menu/i.test(url)) {
        order.cart = resolved?.resolvedUrl && /\/menu|restaurants/i.test(resolved.resolvedUrl) && !/\/gc\//i.test(url)
          ? resolved.resolvedUrl
          : url;
        order.cartOriginalUrl = url;
        if (resolved?.restaurantId) order.restaurantId = resolved.restaurantId;
        if (resolved?.restaurantName) order.restaurantName = resolved.restaurantName;
        if (resolved?.groupCartId) order.groupCartId = resolved.groupCartId;
        if (resolved?.cartDetails?.items?.length) {
          order.items = resolved.cartDetails.items;
          order.subtotal = resolved.cartDetails.subtotal || 0;
        }
        updatedCart = true;
      } else if (resolved?.type === 'ADDRESS' || /maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl|address/i.test(url)) {
        const parsedAddr = parseAddressDetails(trimmed) || resolved?.addressDetails || {};
        const enriched = await geocodeAddressDetails({
          ...parsedAddr,
          name: parsedAddr.name || order.addressDetails?.name || order.fwdSenderName || 'Customer'
        }).catch(() => parsedAddr);
        order.addressDetails = {
          ...(order.addressDetails || {}),
          ...enriched
        };
        order.address = enriched?.address || trimmed;
        updatedAddress = true;
      }
    }

    const parsedFromText = parseAddressDetails(trimmed);
    if (
      parsedFromText &&
      (
        parsedFromText.lat ||
        /Address\s*:/i.test(trimmed) ||
        /\b\d{6}\b/.test(trimmed) ||
        (!updatedCart && urls.length === 0 && trimmed.length >= 12)
      )
    ) {
      const enriched = await geocodeAddressDetails({
        ...parsedFromText,
        name: parsedFromText.name || order.addressDetails?.name || order.fwdSenderName || 'Customer'
      }).catch(() => parsedFromText);
      order.addressDetails = {
        ...(order.addressDetails || {}),
        ...enriched
      };
      order.address = enriched?.address || parsedFromText.address || trimmed;
      updatedAddress = true;
    }

    const parsedTextCart = parseCartDetails(trimmed);
    if (!updatedCart && parsedTextCart?.items?.length) {
      order.cart = order.cart || 'https://www.swiggy.com/checkout';
      order.items = parsedTextCart.items;
      order.subtotal = parsedTextCart.subtotal || 0;
      if (parsedTextCart.restaurantName) order.restaurantName = parsedTextCart.restaurantName;
      updatedCart = true;
    }

    if (!updatedCart && !updatedAddress && urls.length === 0 && trimmed.length >= 6) {
      const enriched = await geocodeAddressDetails({
        name: order.fwdSenderName || 'Customer',
        address: trimmed
      }).catch(() => ({ name: order.fwdSenderName || 'Customer', address: trimmed }));
      order.addressDetails = {
        ...(order.addressDetails || {}),
        ...enriched
      };
      order.address = enriched?.address || trimmed;
      updatedAddress = true;
    }
  }

  if (!updatedCart && !updatedAddress && parseWarnings.length > 0) {
    throw parseWarnings[0];
  }

  return { updatedCart, updatedAddress };
}

// ===========================================================================
// ENTRYPOINT FOR BOTH:
//   1) Forwarded Customer Messages from IB (`isForwarded === true` -> Their Name)
//   2) Direct Boss Normal Messages (`isForwarded === false` -> Boss's Own Name)
// ===========================================================================
export async function handleBossForwardedOrderInput(ctx, { rawText = '', location = null, formatOrderBodyFn }) {
  const sender = resolveOrderSenderInfo(ctx.message, ctx.from);
  if (!sender) return false;

  const db = getDb();
  db.orders = db.orders || {};

  let order = findIncompleteForwardedOrder(db, sender);
  const isUpdatingExisting = Boolean(order);

  if (!order) {
    const orderPrefix = sender.isForwarded ? 'FWD' : 'ORD';
    const orderId = orderPrefix + Math.floor(1000 + Math.random() * 9000);
    order = {
      id: orderId,
      isForwardedOrder: true,
      isDirectBossOrder: !sender.isForwarded,
      fwdSenderId: sender.senderId,
      fwdSenderName: sender.senderName,
      fwdSenderUsername: sender.senderUsername,
      userId: ctx.from.id,
      userChatId: ctx.chat.id,
      userName: sender.senderName,
      userUsername: sender.senderUsername || '',
      cart: null,
      address: null,
      addressDetails: null,
      items: [],
      subtotal: 0,
      discountAmount: 0,
      deliveryFee: 0,
      packingCharges: 0,
      taxesAndCharges: 0,
      finalPayable: 0,
      totalSavings: 0,
      selectedAccount: null,
      accountFetched: false,
      status: 'PENDING',
      createdAt: Date.now()
    };
    db.orders[orderId] = order;
  } else {
    if (sender.senderId && !order.fwdSenderId) order.fwdSenderId = sender.senderId;
    if (sender.senderUsername && !order.fwdSenderUsername) order.fwdSenderUsername = sender.senderUsername;
  }

  try {
    const { updatedCart, updatedAddress } = await ingestForwardedContentIntoOrder(order, { rawText, location });

    if (isUpdatingExisting && (updatedCart || updatedAddress)) {
      stopOrderPaymentPoller(order.id);
      order.accountFetched = false;
      order.selectedAccount = null;
      order.paymentProcessingNote = null;
      order.pendingSwiggyOrderId = null;
      order.pendingSwiggyPaasId = null;
      order.pendingSwiggyUpiUri = null;
      order.genuineQrBuffer = null;
    }

    // Delete previous incomplete card (+ old QR if any) BEFORE posting the updated card!
    if (isUpdatingExisting) {
      await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true, deleteQr: true });
    }

    const cardView = buildForwardedOrderCardView(order, formatOrderBodyFn);
    const sent = await ctx.reply(cardView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...cardView.keyboard
    });

    order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
    order.bossCardMsgId = sent.message_id;
    saveDb(db);
    return true;
  } catch (err) {
    if (!isUpdatingExisting && !order.cart && !order.address) {
      delete db.orders[order.id];
    }
    saveDb(db);
    await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
      stage: 'INGEST_LINK_OR_ADDRESS',
      orderId: order.id,
      senderName: sender.senderName,
      isForwarded: sender.isForwarded,
      cartLink: order.cart || rawText,
      address: order.address
    });
    return true;
  }
}

// ===========================================================================
// REGISTER ALL CALLBACK ACTION HANDLERS (`fwd_*`)
// ===========================================================================
export function registerForwardedOrderHandlers(bot, {
  isBoss,
  formatOrderBodyFn,
  customPaymentChecker = null,
  customRealQrGenerator = null
}) {
  // 1. Account Selected (`fwd_pick_acc_<orderId>__<accKey|AUTO_BEST>`)
  bot.action(/^fwd_pick_acc_([A-Za-z0-9_]+)__(.+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const choice = ctx.match[2];

    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});
    if (['CANCELLED', 'REJECTED'].includes(order.status)) {
      return ctx.answerCbQuery('Order is already cancelled', { show_alert: true }).catch(() => {});
    }

    await ctx.answerCbQuery('🔄 Live Swiggy bill & max coupon fetch ho raha hai...').catch(() => {});

    try {
      await ctx.editMessageText(
        `⏳ <b>Fetching Live Swiggy Bill &amp; Applying Max Coupon (#${escapeHtml(order.id)})...</b>\n` +
        `${buildForwardedSenderHeader(order)}\n\n` +
        `<i>Address save + Cart items sync + Best coupon apply ho raha hai...</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)]
          ])
        }
      );
    } catch (e) {}

    let chosenAccKey = choice;
    try {
      stopOrderPaymentPoller(order.id);
      order.pendingSwiggyOrderId = null;
      order.pendingSwiggyPaasId = null;
      order.pendingSwiggyUpiUri = null;
      order.genuineQrBuffer = null;

      if (choice === 'AUTO_BEST') {
        const bestRes = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });
        if (!bestRes?.success || !bestRes.winningKey) {
          const e = new Error(bestRes?.error || 'Could not sync cart on any logged-in Swiggy account.');
          e.diag = { code: 'AUTO_BEST_SYNC_FAILED', stage: 'SELECT_ACCOUNT_SYNC' };
          throw e;
        }
        chosenAccKey = bestRes.winningKey;
      } else {
        const acc = db.config?.accounts?.[chosenAccKey];
        if (!acc?.cookies) {
          const e = new Error(`Account "${chosenAccKey}" is logged out / missing cookies.`);
          e.diag = { code: 'ACCOUNT_NOT_LOGGED_IN', stage: 'SELECT_ACCOUNT_SYNC' };
          throw e;
        }
        const syncRes = await syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false });
        if (!syncRes?.success) {
          const e = new Error(syncRes?.error || 'Live Swiggy sync failed for this account.');
          e.diag = { code: 'SWIGGY_CART_SYNC_FAILED', stage: 'SELECT_ACCOUNT_SYNC' };
          throw e;
        }
        order.selectedAccount = chosenAccKey;
        order.orderAccount = acc.phone || acc.mobile || chosenAccKey.replace(/^acc_/, '');
      }

      if (!order.items?.length || Number(order.finalPayable || 0) <= 0) {
        const e = new Error(
          `Swiggy returned empty bill (items=${order.items?.length || 0}, finalPayable=₹${order.finalPayable || 0}). Restaurant may be closed or item unavailable at this delivery pin.`
        );
        e.diag = {
          code: 'EMPTY_SYNCED_BILL',
          stage: 'SELECT_ACCOUNT_SYNC',
          swiggyMessage: '0 payable or 0 items after cart sync'
        };
        throw e;
      }

      // Snapshot baseline historical `order_id` on this account BEFORE QR checkout!
      const chosenAcc = db.config?.accounts?.[chosenAccKey];
      const baseAuth = chosenAcc?.cookies ? await getSwiggySessionAuth(chosenAcc, true).catch(() => null) : null;
      order.baselineSwiggyOrderId = String(baseAuth?.orders?.[0]?.order_id || '');
      order.selectedAccount = chosenAccKey;
      order.accountFetched = true;
      order.status = 'ACCEPTED';
      order.paymentProcessingNote = null;

      await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true, deleteQr: true });

      const fetchedView = buildForwardedOrderCardView(order, formatOrderBodyFn);
      const sent = await ctx.reply(fetchedView.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...fetchedView.keyboard
      });
      order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
      order.bossCardMsgId = sent.message_id;
      saveDb(db);
    } catch (err) {
      order.accountFetched = false;
      order.selectedAccount = null;
      saveDb(db);
      const fallbackView = buildForwardedOrderCardView(order, formatOrderBodyFn);
      await ctx.editMessageText(fallbackView.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...fallbackView.keyboard
      }).catch(() => {});

      const chosenAcc = db.config?.accounts?.[chosenAccKey];
      await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
        stage: 'SYNC_CART_AND_BILL',
        orderId: order.id,
        accountKey: chosenAccKey,
        accountPhone: chosenAcc?.phone || '',
        senderName: order.fwdSenderName,
        isForwarded: !order.isDirectBossOrder,
        cartLink: order.cart,
        address: order.address
      });
    }
  });

  // 2. Re-open Account Chooser (`fwd_rechoose_acc_<orderId>`)
  bot.action(/^fwd_rechoose_acc_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    stopOrderPaymentPoller(order.id);
    order.accountFetched = false;
    order.selectedAccount = null;
    order.paymentProcessingNote = null;
    await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true, deleteQr: true });

    const chooserView = buildForwardedOrderCardView(order, formatOrderBodyFn);
    const sent = await ctx.reply(chooserView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...chooserView.keyboard
    });
    order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
    order.bossCardMsgId = sent.message_id;
    saveDb(db);
    await ctx.answerCbQuery('Choose another Swiggy account').catch(() => {});
  });

  // 3. Generate 100% REAL Swiggy Merchant Dynamic Payment QR (`fwd_gen_qr_<orderId>`)
  bot.action(/^fwd_gen_qr_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    if (!acc?.cookies) {
      return ctx.answerCbQuery('⚠️ Account not logged in', { show_alert: true }).catch(() => {});
    }

    await ctx.answerCbQuery('⚡ Generating 100% REAL Swiggy Payment QR...').catch(() => {});

    try {
      const qrGenFn = customRealQrGenerator || generateRealSwiggyMerchantUpiQr;
      const realQr = await qrGenFn(acc, order);

      order.pendingSwiggyUpiUri = realQr.upiIntentUrl;
      order.pendingSwiggyOrderId = realQr.swiggyOrderId;
      order.pendingSwiggyPaasId = realQr.paymentTxnId;
      order.etaMinutes = realQr.slaMinutes || order.etaMinutes || '';
      if (realQr.amount > 0) order.finalPayable = realQr.amount;

      const customerLabel = order.fwdSenderName || order.userName || 'Customer';
      const cardBuffer = await generatePersonalizedQrCard({
        customerName: customerLabel,
        restaurantName: realQr.restaurantName || order.restaurantName || 'Swiggy Food Order',
        amount: order.finalPayable,
        savings: order.totalSavings || 0,
        upiUrl: realQr.upiIntentUrl
      });

      order.genuineQrBuffer = cardBuffer;

      // Replace previous QR message if regenerating
      await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: false, deleteQr: true });

      const sentQr = await ctx.replyWithPhoto(
        { source: cardBuffer },
        {
          caption:
            `🟢 <b>Official Swiggy Merchant Payment QR (#${escapeHtml(order.id)})</b>\n` +
            `${buildForwardedSenderHeader(order)}\n` +
            `🏨 <b>Restaurant:</b> ${escapeHtml(realQr.restaurantName || order.restaurantName || 'Swiggy Order')}\n` +
            `💰 <b>Exact Swiggy Payable:</b> <b>₹${order.finalPayable}</b>\n` +
            `🆔 <b>Swiggy Order Ref:</b> <code>${escapeHtml(realQr.swiggyOrderId)}</code>\n\n` +
            `<i>Scan in GPay / PhonePe / Paytm / BHIM — pays Swiggy directly &amp; auto-extracts live tracking link!</i>`,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Paid', `fwd_check_paid_${order.id}`),
              Markup.button.callback('🔄 Fresh QR', `fwd_gen_qr_${order.id}`)
            ],
            [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)]
          ])
        }
      );

      order.qrChatId = sentQr.chat?.id ?? ctx.chat?.id;
      order.qrMsgId = sentQr.message_id;
      saveDb(db);

      // Start background payment watcher so payment automatically confirms & posts Live Tracking Card!
      startOrderPaymentPoller(ctx.telegram, order.id, formatOrderBodyFn, customPaymentChecker);
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
        stage: 'GENERATE_REAL_SWIGGY_QR',
        orderId: order.id,
        accountKey: order.selectedAccount,
        accountPhone: acc?.phone || '',
        senderName: order.fwdSenderName,
        isForwarded: !order.isDirectBossOrder,
        cartLink: order.cart,
        address: order.address
      });
    }
  });

  // 4. Paid Check (`fwd_check_paid_<orderId>`)
  // - If genuinely PAID on Swiggy: delete old card + QR & post NEW card with SAME details + REAL Live Tracking Links!
  // - If NOT paid yet: say "Payment is processing" & keep card + QR active!
  bot.action(/^fwd_check_paid_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    try {
      const checkFn = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
      const payCheck = await checkFn(acc, order);

      if (!payCheck.paid) {
        order.paymentProcessingNote = 'Payment is processing... (Swiggy payment confirmation pending)';
        saveDb(db);

        const refreshedView = buildForwardedOrderCardView(order, formatOrderBodyFn);
        if (order.bossCardChatId && order.bossCardMsgId) {
          await ctx.telegram.editMessageText(
            order.bossCardChatId,
            order.bossCardMsgId,
            undefined,
            refreshedView.text,
            {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...refreshedView.keyboard
            }
          ).catch(() => {});
        }

        await ctx.answerCbQuery('⏳ Payment is processing...', { show_alert: true }).catch(() => {});
        return;
      }

      await completeOrderWithRealTracking(ctx.telegram, order.id, payCheck, formatOrderBodyFn);
      await ctx.answerCbQuery('✅ Payment Verified! Live Tracking Link Ready!').catch(() => {});
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
        stage: 'CHECK_PAID_AND_EXTRACT_TRACKING',
        orderId: order.id,
        accountKey: order.selectedAccount,
        accountPhone: acc?.phone || '',
        senderName: order.fwdSenderName,
        isForwarded: !order.isDirectBossOrder,
        cartLink: order.cart,
        address: order.address
      });
    }
  });

  // 5. Cancel Button — ALWAYS present on EVERY card stage (`fwd_cancel_<orderId>`)
  bot.action(/^fwd_cancel_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order already removed').catch(() => {});

    stopOrderPaymentPoller(order.id);
    order.status = 'CANCELLED';
    order.cancelledAt = Date.now();
    await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true, deleteQr: true });
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    saveDb(db);

    await ctx.answerCbQuery(`❌ Order #${order.id} cancelled`).catch(() => {});
    await ctx.reply(
      `❌ <b>Order Cancelled (#${escapeHtml(order.id)})</b>\n` +
      `${buildForwardedSenderHeader(order)}`,
      { parse_mode: 'HTML' }
    );
  });
}
