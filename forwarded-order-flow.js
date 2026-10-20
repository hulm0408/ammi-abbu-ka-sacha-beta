import { Markup } from 'telegraf';
import { getDb, saveDb } from './store.js';
import {
  dapiFetch,
  getSwiggySessionAuth,
  resolveSwiggyLink,
  parseAddressDetails,
  parseCartDetails,
  reverseGeocodeCoords,
  geocodeAddressDetails,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  applyLiveCouponToOrder,
  applyMaxOfferToOrder,
  captureSwiggyPaymentScreenshot,
  generatePersonalizedQrCard
} from './swiggy-cart.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|swig\.gy\/[^\s<>"]+|maps\.app\.goo\.gl\/[^\s<>"]+)/gi) || [];
  return matches.map(u => {
    const cleaned = u.replace(/[.,;)]+$/, '');
    return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  });
}

function isSwiggyCartLink(url) {
  if (!url) return false;
  return /swig\.gy\/gc\/|swiggy\.com\/(?:restaurants|menu|cart|checkout)|group[_-]?cart|group-order/i.test(url);
}

function isAddressLink(url) {
  if (!url) return false;
  if (isSwiggyCartLink(url)) return false;
  return /onelink\.me\/|ofo\/address|maps\.app\.goo\.gl|goo\.gl\/maps|google\.com\/maps|maps\.google/i.test(url);
}

// ---------------------------------------------------------------------------
// 1. EXTRACT ORIGINAL SENDER FROM ANY TELEGRAM FORWARDED MESSAGE
// Supports Telegram Bot API 7.0+ (`forward_origin`) AND legacy (`forward_from`, `forward_sender_name`, `forward_from_chat`)
// Works 100% whether sender's Telegram privacy settings are OPEN or HIDDEN!
// ---------------------------------------------------------------------------
export function extractForwardSenderInfo(msg) {
  if (!msg || typeof msg !== 'object') return null;

  const isForwarded = Boolean(
    msg.forward_origin ||
    msg.forward_from ||
    msg.forward_sender_name ||
    msg.forward_from_chat ||
    msg.forward_date
  );
  if (!isForwarded) return null;

  let senderId = null;
  let senderName = '';
  let senderUsername = '';

  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === 'user' && origin.sender_user) {
      senderId = origin.sender_user.id ? String(origin.sender_user.id) : null;
      senderName = [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(' ').trim();
      senderUsername = origin.sender_user.username || '';
    } else if (origin.type === 'hidden_user') {
      senderName = String(origin.sender_user_name || '').trim();
    } else if ((origin.type === 'chat' || origin.type === 'channel')) {
      const ch = origin.sender_chat || origin.chat;
      senderId = ch?.id ? String(ch.id) : null;
      senderName = String(ch?.title || ch?.username || 'Forwarded Chat').trim();
      senderUsername = ch?.username || '';
    }
  }

  if (!senderName && msg.forward_from) {
    senderId = senderId || (msg.forward_from.id ? String(msg.forward_from.id) : null);
    senderName = [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ').trim();
    senderUsername = senderUsername || msg.forward_from.username || '';
  }
  if (!senderName && msg.forward_sender_name) {
    senderName = String(msg.forward_sender_name).trim();
  }
  if (!senderName && msg.forward_from_chat) {
    senderId = senderId || (msg.forward_from_chat.id ? String(msg.forward_from_chat.id) : null);
    senderName = String(msg.forward_from_chat.title || msg.forward_from_chat.username || 'Forwarded User').trim();
    senderUsername = senderUsername || msg.forward_from_chat.username || '';
  }

  if (!senderName) senderName = 'Customer';
  const normName = senderName.trim().toLowerCase();
  const senderKey = senderId ? `tgid_${senderId}` : `tgname_${normName}`;

  return {
    senderId,
    senderName,
    senderUsername,
    normName,
    senderKey
  };
}

// Find an incomplete forwarded order belonging to the same person (matches by Telegram User ID OR exact Display Name!)
export function findIncompleteForwardedOrder(db, senderInfo) {
  if (!db?.orders || !senderInfo) return null;
  const candidates = Object.values(db.orders).filter(o =>
    o &&
    o.isForwardedOrder &&
    !o.paidVerified &&
    !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)
  );

  // Latest active incomplete order for this exact sender
  for (let i = candidates.length - 1; i >= 0; i--) {
    const o = candidates[i];
    if (senderInfo.senderId && o.forwardedSenderId && String(o.forwardedSenderId) === String(senderInfo.senderId)) {
      return o;
    }
    const existingNorm = String(o.userName || '').trim().toLowerCase();
    if (senderInfo.normName && existingNorm && existingNorm === senderInfo.normName) {
      return o;
    }
  }
  return null;
}

// Safely delete previous bot message(s) for an order so chat never has duplicate stale cards
export async function deleteOrderBotMessages(telegram, order, { deleteCard = true, deleteQr = false } = {}) {
  if (!telegram || !order) return;
  const chatId = order.bossCardChatId;
  if (!chatId) return;

  if (deleteCard && order.bossCardMsgId) {
    const mid = order.bossCardMsgId;
    order.bossCardMsgId = null;
    try {
      await telegram.deleteMessage(chatId, mid);
    } catch (e) {}
  }

  if (deleteQr && order.qrMsgId) {
    const qid = order.qrMsgId;
    order.qrMsgId = null;
    try {
      await telegram.deleteMessage(chatId, qid);
    } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// 2. LIVE SWIGGY NEW-ORDER PAYMENT & TRACKING VERIFIER
// Strictly distinguishes NEW paid orders placed AFTER `baselineSwiggyOrderId` from old order history!
// ---------------------------------------------------------------------------
export async function verifyLiveNewOrderPayment(account, order, customOrderFetcher = null) {
  if (!account && !customOrderFetcher) {
    return { paid: false, reason: 'NO_ACCOUNT', statusText: 'Payment is processing' };
  }

  try {
    let orders = [];
    if (typeof customOrderFetcher === 'function') {
      orders = await customOrderFetcher(account, order);
    } else {
      const auth = await getSwiggySessionAuth(account, true);
      if (auth?.sessionExpired) {
        return { paid: false, sessionExpired: true, reason: 'SESSION_EXPIRED', statusText: 'Swiggy session expired on selected account' };
      }
      orders = Array.isArray(auth?.orders) ? auth.orders : [];
    }

    if (!orders || orders.length === 0) {
      return { paid: false, reason: 'NO_NEW_ORDER_YET', statusText: 'Payment is processing' };
    }

    const latest = orders[0];
    const latestId = latest?.order_id ? String(latest.order_id) : '';
    if (!latestId) {
      return { paid: false, reason: 'NO_ORDER_ID', statusText: 'Payment is processing' };
    }

    // Must NOT match the pre-existing historical `baselineSwiggyOrderId` that was already on the account BEFORE this order!
    if (order.baselineSwiggyOrderId && latestId === String(order.baselineSwiggyOrderId)) {
      return { paid: false, reason: 'STILL_ON_PREVIOUS_ORDER', statusText: 'Payment is processing' };
    }

    // Also guard against old historical orders if baseline wasn't set yet (check order_time recency if available)
    if (!order.baselineSwiggyOrderId && latest.order_time) {
      const orderTs = Date.parse(String(latest.order_time).replace(' ', 'T') + '+05:30');
      const createdTs = order.createdAt ? Date.parse(order.createdAt) : 0;
      if (!Number.isNaN(orderTs) && createdTs > 0 && orderTs < createdTs - 5 * 60 * 1000) {
        return { paid: false, reason: 'HISTORICAL_ORDER', statusText: 'Payment is processing' };
      }
    }

    const rawStatus = String(latest.order_status || latest.post_status || '').trim().toLowerCase();
    const isFailedOrPending = /fail|cancel|pending|payment_pending|created|aborted/i.test(rawStatus);
    if (isFailedOrPending) {
      return {
        paid: false,
        reason: 'PAYMENT_PROCESSING',
        swiggyStatus: latest.order_status || 'Processing',
        statusText: 'Payment is processing'
      };
    }

    return {
      paid: true,
      orderId: latestId,
      swiggyStatus: latest.order_status || 'Placed',
      trackingUrl: `https://www.swiggy.com/orders/track/${latestId}`
    };
  } catch (err) {
    return { paid: false, reason: 'API_ERROR', error: err.message, statusText: 'Payment is processing' };
  }
}

// ---------------------------------------------------------------------------
// 3. UNIFIED RECEIPT + BUTTON BUILDER FOR ALL STAGES OF FORWARDED ORDER CARD
// Note: EVERY SINGLE STAGE ALWAYS INCLUDES `[ ❌ Cancel Order ]`!
// ---------------------------------------------------------------------------
export function buildForwardedOrderCardView(order, formatOrderBodyFn) {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const cancelRow = [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)];

  const senderDisplay = order.forwardedSenderId
    ? `<a href="tg://user?id=${escapeHtml(String(order.forwardedSenderId))}">${escapeHtml(order.userName || 'Customer')}</a>`
    : `<b>${escapeHtml(order.userName || 'Customer')}</b>`;
  const unameTag = order.handle ? ` (@${escapeHtml(order.handle.replace(/^@/, ''))})` : '';

  const hasCart = Boolean(order.cart);
  const hasAddress = Boolean(order.address || order.addressDetails?.address || order.addressDetails?.lat);

  // STAGE A: COMPLETED / PAID ORDER CARD WITH LIVE TRACKING LINK (+ ALWAYS CANCEL BUTTON!)
  if (order.paidVerified || order.status === 'COMPLETED') {
    const trackUrl = order.trackingUrl || (order.swiggyOrderId ? `https://www.swiggy.com/orders/track/${order.swiggyOrderId}` : 'https://www.swiggy.com/my-account/orders');
    const bodyHtml = formatOrderBodyFn(order, true);

    const text =
      `✅ <b>ORDER PAID &amp; CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `👤 <b>Forwarded From:</b> ${senderDisplay}${unameTag}\n` +
      (order.swiggyOrderId ? `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(String(order.swiggyOrderId))}</code>\n` : '') +
      `\n${bodyHtml}\n\n` +
      `🛵 <b>Live Tracking Link:</b>\n<a href="${escapeHtml(trackUrl)}">${escapeHtml(trackUrl)}</a>`;

    const rows = [
      [Markup.button.url('🛵 Track Live Order on Swiggy', trackUrl)],
      cancelRow
    ];
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // STAGE B: FETCHED BILL READY -> SHOW EXACT FINAL BILL + `[ 🔳 Generate QR ]` + `[ ✅ Paid ]` + `[ ❌ Cancel Order ]`
  if (order.billFetched && hasCart && hasAddress) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const processingBanner = order.paymentProcessingNotice
      ? `\n\n⏳ <b>Payment is processing...</b>\n<i>Swiggy par payment complete hote hi dobara [ ✅ Paid ] click karein.</i>`
      : '';

    const text =
      `🧾 <b>ORDER SUMMARY (#${escapeHtml(order.id)})</b>\n` +
      `👤 <b>Forwarded From:</b> ${senderDisplay}${unameTag}\n\n` +
      `${bodyHtml}` +
      processingBanner;

    const rows = [
      [
        Markup.button.callback('🔳 Generate QR', `fwd_gen_qr_${order.id}`),
        Markup.button.callback('✅ Paid', `fwd_check_paid_${order.id}`)
      ],
      [
        Markup.button.callback('🔄 Change Account', `fwd_rechoose_acc_${order.id}`),
        Markup.button.callback('🎟 Change Coupon', `boss_coupon_picker_${order.id}`)
      ],
      cancelRow
    ];
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // STAGE C: BOTH ADDRESS & CART PRESENT -> ASK BOSS TO CHOOSE ACCOUNT (+ ALWAYS CANCEL BUTTON!)
  if (hasCart && hasAddress) {
    const ad = order.addressDetails;
    const addrPreview = ad?.address
      ? `${ad.city ? ad.city + ' — ' : ''}${ad.address.replace(/\s+/g, ' ').slice(0, 90)}`
      : String(order.address || 'Attached');
    const restPreview = order.restaurantName || order.cart;

    const text =
      `📦 <b>NEW FORWARDED ORDER (#${escapeHtml(order.id)})</b>\n` +
      `👤 <b>Customer:</b> ${senderDisplay}${unameTag}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 <b>Address:</b> ✅ ${escapeHtml(addrPreview)}\n` +
      `🛒 <b>Cart:</b> ✅ ${escapeHtml(restPreview)}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👇 <b>Choose Swiggy Account to Fetch Bill &amp; Max Coupon:</b>`;

    const rows = [];
    const entries = Object.entries(accounts);
    const sorted = [
      ...entries.filter(([, a]) => a.isLoggedIn && a.cookies),
      ...entries.filter(([, a]) => !(a.isLoggedIn && a.cookies))
    ];

    if (sorted.some(([, a]) => a.isLoggedIn && a.cookies)) {
      rows.push([
        Markup.button.callback('🏆 Auto Best Account (Max Coupon)', `fwd_pick_acc_${order.id}__AUTO_BEST`)
      ]);
    }

    for (let i = 0; i < sorted.length; i += 2) {
      const r = [];
      const [k1, a1] = sorted[i];
      const badge1 = (a1.isLoggedIn && a1.cookies) ? '🟢' : '⚪';
      r.push(Markup.button.callback(`${badge1} ${a1.phone || a1.name || k1}`, `fwd_pick_acc_${order.id}__${k1}`));
      if (sorted[i + 1]) {
        const [k2, a2] = sorted[i + 1];
        const badge2 = (a2.isLoggedIn && a2.cookies) ? '🟢' : '⚪';
        r.push(Markup.button.callback(`${badge2} ${a2.phone || a2.name || k2}`, `fwd_pick_acc_${order.id}__${k2}`));
      }
      rows.push(r);
    }

    rows.push(cancelRow);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // STAGE D: PARTIAL ORDER CARD (WAITING FOR CART OR WAITING FOR ADDRESS + ALWAYS CANCEL BUTTON!)
  const ad = order.addressDetails;
  let partialInfo = '';
  if (hasAddress) {
    const addrLine = ad?.address || order.address;
    partialInfo =
      `📍 <b>Address:</b> ✅ Added\n` +
      `<code>${escapeHtml(addrLine)}</code>\n\n` +
      `🛒 <b>Cart Link:</b> ⏳ <i>Waiting — ${escapeHtml(order.userName)} ka Cart message forward karein...</i>`;
  } else {
    partialInfo =
      `🛒 <b>Cart Link:</b> ✅ Added (${escapeHtml(order.restaurantName || 'Swiggy Cart')})\n` +
      `<code>${escapeHtml(order.cart)}</code>\n\n` +
      `📍 <b>Address:</b> ⏳ <i>Waiting — ${escapeHtml(order.userName)} ka Address message forward karein...</i>`;
  }

  const text =
    `📝 <b>ORDER CARD (#${escapeHtml(order.id)})</b>\n` +
    `👤 <b>Customer:</b> ${senderDisplay}${unameTag}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${partialInfo}`;

  return {
    text,
    keyboard: Markup.inlineKeyboard([cancelRow])
  };
}

// ---------------------------------------------------------------------------
// 4. INGEST ANY FORWARDED MESSAGE FROM BOSS (`text` OR `location`)
//   - Extracts original sender Name & ID
//   - If incomplete card exists for same sender -> DELETES old card & updates existing order!
//   - Sends clean updated card with `[ ❌ Cancel Order ]` (and Account Picker once both Cart & Address exist!)
// ---------------------------------------------------------------------------
export async function handleBossForwardedOrderInput(ctx, { rawText = '', location = null, formatOrderBodyFn }) {
  const msg = ctx.message;
  const sender = extractForwardSenderInfo(msg);
  if (!sender) return false;

  const db = getDb();
  let order = findIncompleteForwardedOrder(db, sender);

  // Extract incoming cart & address from forwarded text or GPS location pin
  let incomingCartLink = null;
  let incomingCartDetails = null;
  let incomingRestId = null;
  let incomingRestName = null;
  let incomingGroupCartId = null;
  let incomingHostName = null;

  let incomingAddressText = null;
  let incomingAddressLink = null;
  let incomingAddrDetails = null;

  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    const lat = String(location.latitude);
    const lng = String(location.longitude);
    const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
    incomingAddressText = rev?.address || `Pinned Location (${lat}, ${lng})`;
    incomingAddrDetails = {
      name: sender.senderName,
      mobile: '',
      city: rev?.city || 'Delivery',
      area: rev?.area || '',
      landmark: rev?.landmark || '',
      address: incomingAddressText,
      lat,
      lng
    };
  }

  if (rawText) {
    const urls = extractUrls(rawText);
    const cartUrl = urls.find(isSwiggyCartLink);
    const addrUrl = urls.find(isAddressLink);
    const parsedCart = parseCartDetails(rawText);
    const parsedAddr = parseAddressDetails(rawText);

    if (cartUrl || parsedCart) {
      incomingCartLink = cartUrl || 'https://www.swiggy.com/cart';
      let meta = null;
      if (cartUrl) {
        meta = await resolveSwiggyLink(cartUrl).catch(() => null);
      }
      incomingRestId = meta?.restaurantId || null;
      incomingRestName = meta?.restaurantName || parsedCart?.restaurantName || null;
      incomingGroupCartId = meta?.groupCartId || null;
      incomingHostName = meta?.hostName || null;
      incomingCartDetails = {
        ...(parsedCart || {}),
        ...(meta?.cartDetails || {})
      };
    }

    if (addrUrl || parsedAddr) {
      let geo = parsedAddr ? { ...parsedAddr } : null;
      const meta = await resolveSwiggyLink(rawText).catch(() => null);
      if (meta?.addressDetails && !meta.addressDetails.unresolvableShortLink) {
        geo = { ...(geo || {}), ...meta.addressDetails };
      } else if (geo) {
        geo = await geocodeAddressDetails(geo).catch(() => geo);
      }
      if (geo && !geo.name) geo.name = sender.senderName;
      incomingAddrDetails = geo || {
        name: sender.senderName,
        address: addrUrl || rawText.trim()
      };
      incomingAddressLink = addrUrl || null;
      incomingAddressText = incomingAddrDetails.address || addrUrl || rawText.trim();
    }

    // Fallback: if neither URL nor structured keywords matched, treat plain street note forwarded from customer as address text
    if (!incomingCartLink && !incomingAddressText && rawText.trim().length >= 5) {
      const geo = await geocodeAddressDetails({ name: sender.senderName, address: rawText.trim() }).catch(() => ({
        name: sender.senderName,
        address: rawText.trim()
      }));
      incomingAddrDetails = geo;
      incomingAddressText = geo.address || rawText.trim();
    }
  }

  // If an incomplete order card already exists for this same person: DELETE OLD CARD FIRST!
  if (order) {
    await deleteOrderBotMessages(ctx.telegram || botTelegramFallback(ctx), order, { deleteCard: true, deleteQr: true });
    order.billFetched = false; // Re-prompt account / re-fetch since customer updated cart or address!
    order.paymentProcessingNotice = false;
  } else {
    const newId = `FWD${Math.floor(1000 + Math.random() * 9000)}`;
    order = {
      id: newId,
      isForwardedOrder: true,
      forwardedSenderKey: sender.senderKey,
      forwardedSenderId: sender.senderId || null,
      userId: sender.senderId || `fwd_${sender.normName}`,
      userName: sender.senderName,
      handle: sender.senderUsername || '',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      items: [],
      subtotal: 0,
      finalPayable: 0
    };
    db.orders[newId] = order;
  }

  if (sender.senderId && !order.forwardedSenderId) order.forwardedSenderId = sender.senderId;
  if (sender.senderUsername && !order.handle) order.handle = sender.senderUsername;

  // Apply newly forwarded Cart details
  if (incomingCartLink) {
    order.cart = incomingCartLink;
    if (incomingRestId) order.restaurantId = incomingRestId;
    if (incomingRestName) order.restaurantName = incomingRestName;
    if (incomingGroupCartId) order.groupCartId = incomingGroupCartId;
    if (incomingHostName) order.hostName = incomingHostName;
    if (incomingCartDetails?.items?.length > 0) {
      order.items = incomingCartDetails.items;
      order.itemTotal = incomingCartDetails.itemsTotal || incomingCartDetails.subtotal || 0;
      order.subtotal = order.itemTotal;
    } else if (incomingCartDetails?.subtotal > 0) {
      order.subtotal = incomingCartDetails.subtotal;
      order.itemTotal = incomingCartDetails.itemsTotal || incomingCartDetails.subtotal;
    }
    if (incomingCartDetails?.couponCode) {
      order.couponCode = incomingCartDetails.couponCode;
      order.discountAmount = incomingCartDetails.discountAmount || 0;
    }
  }

  // Apply newly forwarded Address details
  if (incomingAddressText || incomingAddrDetails) {
    order.address = incomingAddressText || order.address;
    order.addressOriginalText = rawText || order.addressOriginalText || incomingAddressText;
    if (incomingAddressLink) order.addressLink = incomingAddressLink;
    order.addressDetails = {
      ...(order.addressDetails || {}),
      ...(incomingAddrDetails || {})
    };
    if (!order.addressDetails.name) order.addressDetails.name = sender.senderName;
  }

  const view = buildForwardedOrderCardView(order, formatOrderBodyFn);
  const sent = await ctx.reply(view.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...view.keyboard
  });

  order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
  order.bossCardMsgId = sent.message_id;
  saveDb(db);
  return true;
}

function botTelegramFallback(ctx) {
  return ctx?.telegram || null;
}

// ---------------------------------------------------------------------------
// 5. REGISTER ALL FORWARDED ORDER CALLBACK HANDLERS (`fwd_*`) ON TELEGRAF BOT
// ---------------------------------------------------------------------------
export function registerForwardedOrderHandlers(bot, { isBoss, formatOrderBodyFn, customOrderFetcher = null }) {
  // Choose Account -> Fetch Everything in Exact Format -> Unlock `[ 🔳 Generate QR ]` + `[ ✅ Paid ]` + `[ ❌ Cancel Order ]`
  bot.action(/^fwd_pick_acc_(.+?)__(.+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const accChoice = ctx.match[2];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery('Fetching live Swiggy cart, address & max coupon... 🚀').catch(() => {});

    // Show clean fetching message while keeping `[ ❌ Cancel Order ]` active even mid-fetch!
    const accObj = accChoice === 'AUTO_BEST' ? null : db.config?.accounts?.[accChoice];
    const accLabel = accChoice === 'AUTO_BEST'
      ? 'All Active Accounts (Auto Max Coupon)'
      : (accObj?.phone || accObj?.name || accChoice);

    try {
      await ctx.editMessageText(
        `⏳ <b>Fetching Order #${escapeHtml(order.id)} on Swiggy...</b>\n\n` +
        `👤 <b>Customer:</b> ${escapeHtml(order.userName)}\n` +
        `📱 <b>Account:</b> <code>${escapeHtml(accLabel)}</code>\n\n` +
        `<i>Syncing items, delivery address, Swiggy One Lite Free Delivery &amp; Maximum Coupon...</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)]])
        }
      );
    } catch (e) {}

    try {
      let result = null;
      let chosenKey = accChoice;

      if (accChoice === 'AUTO_BEST') {
        result = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });
        chosenKey = result?.winningKey || order.selectedAccount;
      } else {
        if (!accObj) {
          return ctx.reply('⚠️ Selected account not found.', { parse_mode: 'HTML' });
        }
        order.selectedAccount = accChoice;
        order.orderAccount = accObj.phone || accObj.name || accChoice;
        result = await syncGroupCartAndCheckoutForAccount(accObj, order, { captureScreenshot: false });
      }

      // Reload latest order reference in case cancel was clicked mid-flight
      if (db.orders[orderId]?.status === 'CANCELLED') return;

      const finalAcc = db.config?.accounts?.[chosenKey];
      if (!result || result.sessionExpired) {
        if (finalAcc) {
          finalAcc.isLoggedIn = false;
          saveDb(db);
        }
        order.billFetched = false;
        const fallbackView = buildForwardedOrderCardView(order, formatOrderBodyFn);
        await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true });
        const retryMsg = await ctx.reply(
          `⚠️ <b>Session Expired on ${escapeHtml(accLabel)}!</b> Dusra active account choose karein:\n\n` + fallbackView.text,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...fallbackView.keyboard }
        );
        order.bossCardChatId = retryMsg.chat?.id ?? ctx.chat?.id;
        order.bossCardMsgId = retryMsg.message_id;
        saveDb(db);
        return;
      }

      // Snapshot current latest Swiggy `order_id` on this account BEFORE payment so `[ ✅ Paid ]` strictly detects NEW payment!
      if (finalAcc) {
        const baseAuth = await getSwiggySessionAuth(finalAcc, true).catch(() => null);
        order.baselineSwiggyOrderId = baseAuth?.orders?.[0]?.order_id ? String(baseAuth.orders[0].order_id) : '';
      }

      if (result.savedAddresses?.length > 0) order.accountAddresses = result.savedAddresses;
      if (result.availableCoupons?.length > 0) order.availableCoupons = result.availableCoupons;
      if (result.paymentUrl) order.swiggyPaymentUrl = result.paymentUrl;
      applyMaxOfferToOrder(order);

      order.billFetched = true;
      order.paymentProcessingNotice = false;

      // Delete fetching card and post clean Fetched Final Bill Card with `[ 🔳 Generate QR ]`, `[ ✅ Paid ]`, `[ ❌ Cancel Order ]`
      await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true });
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
      await ctx.reply(`❌ <b>Fetch Error:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // Re-open Account Chooser if Boss wants to switch account
  bot.action(/^fwd_rechoose_acc_(.+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});
    await ctx.answerCbQuery().catch(() => {});

    order.billFetched = false;
    order.paymentProcessingNotice = false;
    saveDb(db);

    const view = buildForwardedOrderCardView(order, formatOrderBodyFn);
    try {
      await ctx.editMessageText(view.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...view.keyboard
      });
    } catch (e) {
      await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true });
      const sent = await ctx.reply(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
      order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
      order.bossCardMsgId = sent.message_id;
      saveDb(db);
    }
  });

  // `[ 🔳 Generate QR ]` -> Instant Personalized Swiggy Payment QR Card (with Customer Name in Center Badge!)
  bot.action(/^fwd_gen_qr_(.+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    const amount = Number(order.finalPayable || order.subtotal || 0);
    if (amount <= 0) {
      return ctx.answerCbQuery('⚠️ Payable amount must be > ₹0 before generating QR!', { show_alert: true }).catch(() => {});
    }

    await ctx.answerCbQuery('Generating Personalized QR Card... ⚡').catch(() => {});

    try {
      const custName = order.addressDetails?.name || order.userName || 'Customer';
      const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
      const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${amount}&cu=INR&tn=Swiggy_Order_${order.id}`;

      const cardBuffer = await generatePersonalizedQrCard({
        customerName: custName,
        restaurantName: order.restaurantName || 'Swiggy Food Order',
        amount,
        savings: Number(order.totalSavings || 0),
        upiUrl: upiUri
      });

      // Remove previous QR photo if regenerated so chat stays ultra clean
      await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: false, deleteQr: true });

      const qrMsg = await ctx.replyWithPhoto(
        { source: cardBuffer },
        {
          caption:
            `💳 <b>Payment QR Ready — ${escapeHtml(custName)}</b>\n` +
            `🏪 <b>${escapeHtml(order.restaurantName || 'Swiggy Food Order')}</b>\n` +
            `💰 <b>Final Total: ₹${amount}</b>` +
            (order.totalSavings > 0 ? ` <i>(Saved ₹${order.totalSavings})</i>` : ''),
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Paid', `fwd_check_paid_${order.id}`)],
            [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)]
          ])
        }
      );

      order.qrSent = true;
      order.qrMsgId = qrMsg.message_id;
      order.bossCardChatId = qrMsg.chat?.id ?? ctx.chat?.id;
      if (qrMsg?.photo?.length > 0) {
        order.customQrFileId = qrMsg.photo[qrMsg.photo.length - 1].file_id;
      }
      saveDb(db);
    } catch (err) {
      await ctx.reply(`❌ <b>QR Generation Failed:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // `[ ✅ Paid ]` -> Live Swiggy Payment Check:
  //   - If PAID on Swiggy: DELETE old Bill Card & QR Photo -> SEND NEW CARD with exact same details + LIVE TRACKING LINK (+ Cancel button)!
  //   - If NOT PAID yet: respond "Payment is processing" and keep current card + Cancel button intact!
  bot.action(/^fwd_check_paid_(.+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    const check = await verifyLiveNewOrderPayment(acc, order, customOrderFetcher);

    if (!check.paid) {
      order.paymentProcessingNotice = true;
      saveDb(db);

      await ctx.answerCbQuery('⏳ Payment is processing...', { show_alert: true }).catch(() => {});

      // Update Bill Card banner with "Payment is processing..." if not already shown
      if (order.bossCardChatId && order.bossCardMsgId) {
        const updatedView = buildForwardedOrderCardView(order, formatOrderBodyFn);
        try {
          await ctx.telegram.editMessageText(
            order.bossCardChatId,
            order.bossCardMsgId,
            undefined,
            updatedView.text,
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...updatedView.keyboard }
          );
        } catch (e) {}
      }
      return;
    }

    // GENUINELY PAID ON SWIGGY! Delete old Bill Card + QR Card and send fresh Confirmed Card with Tracking Link!
    await ctx.answerCbQuery('✅ Payment Verified! Sending Tracking Card... 🛵').catch(() => {});
    await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true, deleteQr: true });

    order.paidVerified = true;
    order.status = 'COMPLETED';
    order.completedAt = new Date().toISOString();
    order.swiggyOrderId = check.orderId;
    order.trackingUrl = check.trackingUrl;
    order.paymentProcessingNotice = false;

    const confirmedView = buildForwardedOrderCardView(order, formatOrderBodyFn);
    const newCard = await ctx.reply(confirmedView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...confirmedView.keyboard
    });

    order.bossCardChatId = newCard.chat?.id ?? ctx.chat?.id;
    order.bossCardMsgId = newCard.message_id;
    saveDb(db);
  });

  // `[ ❌ Cancel Order ]` -> Available at EVERY stage! Deletes active cards, clears unpaid Swiggy cart cleanly, marks CANCELLED!
  bot.action(/^fwd_cancel_(.+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.answerCbQuery('Order already removed', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery('🗑️ Order Cancelled!').catch(() => {});

    // If an account cart was loaded for this unpaid order, flush it cleanly so the account is ready for next order
    if (!order.paidVerified && order.selectedAccount && order.restaurantId) {
      const acc = db.config?.accounts?.[order.selectedAccount];
      if (acc?.cookies) {
        dapiFetch(acc, 'cart', {
          method: 'POST',
          body: {
            flushFirst: true,
            cart: {
              restaurantId: String(order.restaurantId),
              address_id: '',
              couponCode: '',
              cartItems: [],
              mealItems: [],
              subscriptionItems: []
            }
          }
        }).catch(() => {});
      }
    }

    await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true, deleteQr: true });

    order.status = 'CANCELLED';
    order.cancelledAt = new Date().toISOString();
    saveDb(db);

    await ctx.reply(
      `🗑️ <b>Order Cancelled (#${escapeHtml(order.id)})</b> — ${escapeHtml(order.userName || 'Customer')}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });
}
