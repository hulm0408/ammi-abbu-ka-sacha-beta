import './network-shield.js';
import { createIpv4TelegramAgent, installBulletproofTelegramTransport } from './network-shield.js';
import http from 'http';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import {
  getDb,
  saveDb,
  isBoss,
  addBoss,
  setFamilyRole,
  getFamilyRole,
  getAccounts,
  updateAccount,
  createAccount,
  deleteAccount,
  getActiveUserOrder,
  getDraft,
  updateDraft,
  clearDraft,
  exportSessionJson,
  importSessionJson,
  normalizeSwiggySessionPayload,
  extractSwiggyAccountsListFromInput,
  getActiveOrderAccountKey,
  setActiveOrderAccountKey,
  permanentLogoutAccount,
  mutateDb,
  canTransitionOrder,
  getNextAutoUserName,
  cleanEssentialSwiggyCookies,
  hydrateAccountsFromCloudVault,
  syncCloudVaultNow,
  generateOrderId,
  isAccountLoggedInSession,
  findAccountKeyByPhone,
} from './store.js';
import { extractSharedUrls, stripSharedLinks, isLinkOnlyShareText } from './link-utils.js';
import {
  extractStandaloneMobileNumber,
  extractStandaloneOtpDigits,
  prepareNewSwiggyAccountIdentity,
  ingestAndPersistRawAccountTexts,
  formatBulkVaultImportSummaryHtml,
  createBulkDocumentBatchCollector,
} from './account-vault-intake.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { sendParentSmsNotification, sendDirectOrderSms, sendPaymentLinkSms } from './sms-notify.js';
import { requestSwiggyOtpViaBridge, requestSwiggyDeleteOtpViaBridge, verifySwiggyOtpViaBridge, verifyAndDeleteSwiggyAccountViaBridge, signupSwiggyViaBridge, deactivateSwiggyAccountViaBridge, prewarmBrowser, checkLoggedInFromCookies, decodeJwtPayload, claimSwiggyBreakfastAndLateNightOffers, EVENT_OFFER_OPTIONS, stripStaleWafCookie } from './swiggy-bridge.js';
import {
  verifyAndInspectSwiggyLink,
  inspectCartForAccount,
  getGenuinePaymentDetails,
  getStoredSwiggyTrackingUrl,
  isOfficialSwiggyTrackingUrl,
  isFabricatedTrackingUrl,
  normalizeSwiggyLiveOrderStatus,
  resolveSwiggyLink,
  fetchAccountAddresses,
  fetchAccountOrders,
  formatSwiggyWorldCartReceipt,
  captureSwiggyPaymentScreenshot,
  checkAccountFreeCash,
  claimInstamartFreeCash,
  fetchSwiggyProfileFromCookies,
  parseAddressDetails,
  parseCartDetails,
  extractAddressShareUrl,
  isAddressShareUrl,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  applyMaxOfferToOrder,
  generatePersonalizedQrCard,
  generateUltraPremiumCard,
  reverseGeocodeCoords,
  isValidIndianDeliveryCoordinates,
  geocodeAddressDetails,
  fetchAllAccountsSavedAddresses,
  applyLiveCouponToOrder,
  verifySwiggySessionLive,
  inspectAccountOrderHistoryAndOffers,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  extractTrackingViaAllAccounts,
  releaseSwiggyAccountReservation,
  startWafKeepWarmLoop,
  notePublicServiceOrigin,
  getPublicServiceBaseUrl,
  buildSignedOrderTrackUrl
} from './swiggy-cart.js';
import {
  extractForwardSenderInfo,
  looksLikeBossOrderInput,
  computeTrackHmac,
  formatBossDiagnosticErrorMessage,
  deleteOrderBotMessages,
  buildForwardedOrderCardView,
  dispatchAllReadyOrdersInParallel,
  handleBossForwardedOrderInput,
  registerForwardedOrderHandlers,
  executeRealQrGenerationForOrder,
  startOrderDeliveryInfoPoller,
  sendOrderDeliveryInfoNotice,
  applyBossOrderUpdate,
  generateNamedUpiQrPngBuffer,
  sanitizeUpiUriForQr,
  sendBillSummaryToCustomerOnce,
  resolveBillSummaryAudience,
  resolveCustomerChatId,
  safeTelegramCaption,
  truncateDisplayField,
  lookupOrder,
  orderNotFoundDiag
} from './forwarded-order-flow.js';
import {
  buildBossPanelHome,
  buildBossPendingList,
  buildBossOrderCard as formatBossOrderCard,
  buildBossArchiveList,
  buildBossCancelledList,
  buildBossDashboard,
  bossAlert,
  swiggyOrderIdOf,
  placedFromPhoneOf,
  trackingLinkDisplay,
} from './boss-panel.js';
import {
  ensureOrderTracking,
  startOrderTrackingAuto,
  stopOrderTrackingAuto,
  setOrderTrackingNotifier,
  orderPlacedFromPhone,
  isTerminalDeliveryStatus,
  isCancelledOrRefusedStatus,
  resolveTrackEndpointPayload,
} from './order-tracking.js';
import {
  esc,
  heading,
  sub,
  field,
  bullet,
  section,
  card,
  table,
  divider,
  DIVIDER,
  message,
  otpSentCard,
  otpErrorCard,
  bossPanelCard,
} from './rich-text.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOSS_SECRET = process.env.BOSS_SECRET || 'boss123';

if (!BOT_TOKEN) {
  console.error('× Error: BOT_TOKEN is missing in .env file!');
  process.exit(1);
}

const bot = installBulletproofTelegramTransport(
  new Telegraf(BOT_TOKEN, {
    handlerTimeout: 240_000,
    telegram: {
      agent: createIpv4TelegramAgent()
    }
  })
);

// Fix: Telegraf throws synchronously if answerCbQuery is called on a message update.
// All existing handlers assume .catch() is enough, but assert() throws before Promise.
// Monkey-patch to silently no-op when there's no callbackQuery (prevents UNEXPECTED_ERROR).
try {
  const _origAnswerCbQuery = bot.context?.answerCbQuery || null;
  if (_origAnswerCbQuery) {
    const patched = function(...args) {
      if (!this.callbackQuery) return Promise.resolve(true);
      return _origAnswerCbQuery.apply(this, args);
    };
    bot.context.answerCbQuery = patched;
    // Also patch prototype for any new contexts
    if (bot.context && bot.context.constructor && bot.context.constructor.prototype) {
      bot.context.constructor.prototype.answerCbQuery = patched;
    }
  }
  // Patch editMessageText to ignore benign "Message is not modified" races (Order Hub etc.)
  const _origEditText = bot.telegram.editMessageText.bind(bot.telegram);
  bot.telegram.editMessageText = async (chatId, messageId, inlineMessageId, text, extra) => {
    try {
      return await _origEditText(chatId, messageId, inlineMessageId, text, extra);
    } catch (e) {
      const msg = String(e?.message || e?.description || '');
      if (msg.toLowerCase().includes('message is not modified') || msg.toLowerCase().includes('message_id_invalid')) {
        return { ok: true };
      }
      throw e;
    }
  };
} catch {}

const userWaitState = {};

// ---------------------------------------------------------------------------
// One live card per customer chat
// ---------------------------------------------------------------------------
// Ammi/Abbu used to get 3-4 bubbles per link ("verified & saved", "now paste
// the next one", the screen …). Instead we keep ONE card and edit it in place:
// when a link is accepted the customer's own message and the stale prompt
// bubbles are deleted, and the card is refreshed with the next step.
const userChatCards = new Map();

function userCardState(userId) {
  const key = String(userId || '');
  if (!userChatCards.has(key)) userChatCards.set(key, { messageId: null, promptIds: [] });
  return userChatCards.get(key);
}

function rememberUserCard(userId, message) {
  if (!userId || !message?.message_id) return;
  userCardState(userId).messageId = message.message_id;
}

function rememberUserPrompt(userId, message) {
  if (!userId || !message?.message_id) return;
  const state = userCardState(userId);
  if (message.message_id === state.messageId) return;
  state.promptIds.push(message.message_id);
}

// Deletes the customer's own message plus the old prompt bubbles. The live card
// is kept (and can be deleted explicitly when an order ends).
async function cleanupUserChat(telegram, chatId, userId, { deleteIncomingId = null, deleteCard = false } = {}) {
  const state = userCardState(userId);
  const safeDelete = async (messageId) => {
    if (!messageId || messageId === state.messageId) return;
    try { await telegram.deleteMessage(chatId, messageId); } catch {}
  };
  await safeDelete(deleteIncomingId);
  for (const id of state.promptIds) await safeDelete(id);
  state.promptIds = [];
  if (deleteCard && state.messageId) {
    try { await telegram.deleteMessage(chatId, state.messageId); } catch {}
    state.messageId = null;
  }
  return state;
}

// Telegram only opens the reply keyboard (and focuses the input) for a message
// that carries `force_reply`. We send exactly ONE such prompt, remember it, and
// delete it as soon as the link arrives — so the chat still ends with one card.
const LINK_PROMPTS = {
  cart: {
    text: '🟠 <b>Cart link</b> bhejein 👇',
    placeholder: 'Swiggy cart link paste karein...'
  },
  address: {
    text: '🟠 <b>Address link</b> ya Location bhejein 👇',
    placeholder: 'Address link paste karein ya Location bhejein...'
  }
};

async function promptForLink(ctx, userId, kind) {
  const spec = LINK_PROMPTS[kind];
  if (!spec) return null;
  const chatId = ctx.chat?.id || userId;
  const state = userCardState(userId);
  // Replace an older prompt instead of stacking them.
  for (const id of state.promptIds) {
    try { await ctx.telegram.deleteMessage(chatId, id); } catch {}
  }
  state.promptIds = [];
  try {
    const prompt = await ctx.reply(spec.text, {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: spec.placeholder
      }
    });
    rememberUserPrompt(userId, prompt);
    return prompt;
  } catch (err) {
    console.warn('[Prompt] force_reply failed:', err?.message || err);
    return null;
  }
}

// Refreshes the single card: edit in place when possible, otherwise post once.
// `deleteIncoming` removes the customer's pasted link message; `notice` shows a
// short toast instead of an extra chat bubble.
async function renderUserCard(ctx, userId, { deleteIncoming = false, notice = '' } = {}) {
  const chatId = ctx.chat?.id || userId;
  const telegram = ctx.telegram || ctx.tg;
  const incomingId = deleteIncoming ? (ctx.message?.message_id || null) : null;
  const state = await cleanupUserChat(telegram, chatId, userId, { deleteIncomingId: incomingId });

  let screen;
  try {
    screen = getUserScreen(userId, ctx.from || { id: userId });
  } catch (err) {
    console.error('[UserCard] render failed:', err?.message || err);
    return null;
  }

  if (state.messageId) {
    try {
      await telegram.editMessageText(chatId, state.messageId, null, screen.text, {
        parse_mode: 'HTML',
        ...screen.keyboard
      });
      if (notice && ctx.callbackQuery && ctx.answerCbQuery) await ctx.answerCbQuery(notice).catch(() => {});
      return state.messageId;
    } catch {
      // Card was deleted by the customer or is too old to edit -> post a fresh one.
      state.messageId = null;
    }
  }

  const sent = await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard }).catch(() => null);
  if (sent?.message_id) {
    state.messageId = sent.message_id;
    if (notice && ctx.callbackQuery && ctx.answerCbQuery) await ctx.answerCbQuery(notice).catch(() => {});
  }
  return sent?.message_id || null;
}


// Never let a stray async rejection or an unexpected throw take the whole bot
// down (Telegram polling, order sync, Swiggy fetches all run concurrently).
// Every failure is logged with its stack so it can be fixed instead of being
// reported to users as "[AI-DIAG] UNEXPECTED_ERROR".
process.on('unhandledRejection', (reason) => {
  const text = reason?.stack || reason?.message || String(reason);
  console.error('× Unhandled promise rejection:', text);
});
process.on('uncaughtException', (err) => {
  const text = err?.stack || err?.message || String(err);
  console.error('× Uncaught exception (bot kept alive):', text);
});

const splitJsonChunks = {};

function extractAllLinks(text) {
  // Markdown / duplicated links are normalised to the bare URL by link-utils,
  // so `[link](link)` never turns into one broken url with text around it.
  return extractSharedUrls(text);
}

function extractLink(text) {
  const links = extractAllLinks(text);
  return links.length > 0 ? links[0] : null;
}

function normalizeDeliveryContact(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function isLinkString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim().toLowerCase();
  return (
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('www.') ||
    s.includes('swiggy.com') ||
    s.includes('swig.gy') ||
    s.includes('onelink.me') ||
    s.includes('maps.google') ||
    s.includes('goo.gl') ||
    s.includes('maps.app.goo.gl') ||
    s.includes('t.me/')
  );
}

export function isValidSwiggyCartUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const s = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch (e) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const isSwiggyHost = host === 'swiggy.com' || host.endsWith('.swiggy.com') || host === 'swig.gy' || host === 'swiggy.onelink.me' || host.endsWith('.onelink.me');
  if (!isSwiggyHost) return false;

  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const full = path + search;

  if (path === '/' || path === '') return false;

  // Never treat tracking links as cart links (r.swiggy.com / ofo/track)
  if (host === 'r.swiggy.com' || path.includes('/ofo/track') || path.includes('/track/') || full.includes('ofo/track')) {
    return false;
  }

  // IMPORTANT: Address links should NEVER be classified as cart links!
  // E.g. https://swiggy.onelink.me/JgkQ/52yat6op or ofo/address or /address
  if (path.includes('jgkq') || path.includes('address') || full.includes('ofo/address') || path.includes('y313q1wv')) {
    return false;
  }

  // Swiggy Onelink should only be treated as cart if it explicitly specifies cart/menu/restaurant/gc
  if (host.includes('onelink.me')) {
    return (
      full.includes('/gc/') ||
      full.includes('group-cart') ||
      full.includes('group_cart') ||
      full.includes('/cart') ||
      full.includes('/menu') ||
      full.includes('restaurant')
    );
  }

  return (
    full.includes('/gc/') ||
    full.includes('group-cart') ||
    full.includes('group_cart') ||
    full.includes('groupcartid') ||
    full.includes('/cart') ||
    full.includes('restaurant_id') ||
    (host === 'swig.gy' && path.length >= 4)
  );
}

export function isValidDeliveryAddressUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const s = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch (e) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const full = path + search;

  const isGoogleMaps = host === 'maps.app.goo.gl' ||
                       host === 'goo.gl' ||
                       host === 'maps.google.com' ||
                       (host.endsWith('.google.com') && (path.includes('/maps') || path.includes('/place')));

  // Swiggy mobile app share address format: https://swiggy.onelink.me/JgkQ/...
  const isSwiggyOneLink = (host === 'swiggy.onelink.me' || host.endsWith('.onelink.me')) && path.length >= 3;
  // Swiggy web address URLs
  const isSwiggyWeb = (host === 'swiggy.com' || host.endsWith('.swiggy.com') || host === 'swig.gy') &&
                      (path.includes('address') || full.includes('ofo/address') || path.includes('y313q1wv') || path.includes('jgkq'));

  if (!isGoogleMaps && !isSwiggyOneLink && !isSwiggyWeb) return false;

  if (isGoogleMaps && (path === '/' || path === '/maps') && !parsed.search && !parsed.hash) {
    return false;
  }

  // Reject cart links if mistakenly passed
  if (path.includes('/gc/') || path.includes('group-cart') || path.includes('group_cart') || path.includes('/cart')) {
    return false;
  }

  return true;
}

function classifyLink(url) {
  if (isValidDeliveryAddressUrl(url)) return 'ADDRESS';
  if (isValidSwiggyCartUrl(url)) return 'CART';
  return 'UNKNOWN';
}

// User Bottom Menu - Colorful orange Cart & Address buttons + clean direct actions
function getUserReplyKeyboard(draft = {}) {
  const hasCart = Boolean(draft?.cart);
  const hasAddr = Boolean(draft?.address);
  const bothReady = hasCart && hasAddr;
  const cartLabel = hasCart ? '🟢 🛒 Cart ✓' : '🟠 🛒 Cart Link';
  const addrLabel = hasAddr ? '🟢 📍 Address ✓' : '🟠 📍 Address Link';
  return Markup.keyboard([
    [
      { text: cartLabel, style: hasCart ? 'success' : 'danger' },
      { text: addrLabel, style: hasAddr ? 'success' : 'danger' }
    ],
    [
      { text: '🚀 Send to Beta', style: bothReady ? 'success' : 'primary' }
    ],
    [
      { text: '📦 Orders Done', style: 'primary' },
      { text: '✖ Cancel Draft', style: 'danger' }
    ],
    [
      { text: '🔗 Extract Tracking Link', style: 'primary' }
    ]
  ]).resize();
}

// Boss Bottom Menu - Single dedicated Extract Tracking button (all dummy buttons removed per user request)
function getBossReplyKeyboard() {
  return Markup.keyboard([
    [
      { text: '🔗 Extract Tracking Link' }
    ]
  ]).resize().persistent(false).oneTime(false).selective(false);
}

bot.hears(['🔗 Extract Tracking Link', 'Extract Tracking Link', 'extract tracking', '/extract', '🔗 extract', '/extractlink', '/tracking'], async (ctx) => {
  userWaitState[ctx.from.id] = { action: 'waiting_boss_extract_tracking' };
  await ctx.reply(
    '🔗 <b>Extract Tracking Link — All IDs scan</b>\nSend the <b>Order ID</b> (e.g. <code>FWD9670</code>) or Swiggy Order ID. I will check every logged-in Swiggy ID for its tracking link.',
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Enter Order ID' } }
  );
});

// ---------------------------------------------------------------------------
// Order card renderer — compact Swiggy-style receipt:
//   Order Account / Your Cart / Delivering To / items / Bill Summary / To Pay
// Address data is ONLY ever the URL-resolved delivery details (never chat text).
// ---------------------------------------------------------------------------

const PLACEHOLDER_CITIES = /^(?:india|address|delivery|delivering|shared location|delivery address|order|billing|your|saved)$/i;

function cleanAddressLine(line) {
  return String(line || '')
    .replace(/(?:📱\s*)?(?:phone|mobile|tel|contact)\s*[:\-]?\s*\+?[\d\s\-]{10,}/gi, '')
    .replace(/\bOrder\s*Account\s*:.*$/gi, '')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

// Normalises an addressDetails object for display: drops placeholder cities,
// duplicate lines and any phone/account noise that may have leaked in earlier.
function normalizeAddressForDisplay(ad) {
  if (!ad || typeof ad !== 'object') return null;
  const out = { ...ad };
  const city = String(out.city || '').trim();
  out.city = city && !PLACEHOLDER_CITIES.test(city) ? city : '';

  if (out.mobile) {
    const digits = String(out.mobile).replace(/\D/g, '').slice(-10);
    out.mobile = digits.length === 10 ? digits : '';
  }

  const seen = new Set();
  const lines = String(out.address || '')
    .split(/\r?\n/)
    .map(cleanAddressLine)
    .filter(line => {
      if (!line) return false;
      if (/^(?:delivering\s*to|your\s*cart|select an available payment method)$/i.test(line)) return false;
      if (out.city && line.toLowerCase() === `${out.city} address`.toLowerCase()) return false;
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  out.address = lines.join('\n').trim();
  if (!out.address && !out.city && !out.lat) return null;
  return out;
}

export function formatUserOrderCardText(order, isBossView = false) {
  const db = getDb();
  const selectedAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const accPhone = order.orderAccount || selectedAcc?.phone || selectedAcc?.mobile || null;
  const restName = order.restaurantName || order.restaurant || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : '');
  const ad = normalizeAddressForDisplay(order.addressDetails || parseAddressDetails(order.address));

  const blocks = [];

  // ---------- 1. ORDER ACCOUNT (Boss view only) ----------
  if (isBossView && accPhone) {
    blocks.push(`<b>Order Account:</b> <code>${esc(accPhone)}</code>`);
  }

  // ---------- 2. CART / RESTAURANT ----------
  if (restName) {
    blocks.push(`<b>Your Cart</b>\n<b>${esc(restName)}</b>`);
  }

  // ---------- 3. DELIVERY ADDRESS ----------
  const addrLines = [];
  if (ad && (ad.address || ad.city || ad.name || ad.mobile || ad.lat)) {
    addrLines.push('<b>Delivering To</b>');
    addrLines.push(`<b>${esc(ad.city ? `${ad.city} Address` : 'Delivery Address')}</b>`);
    if (ad.name) addrLines.push(esc(ad.name));
    if (ad.mobile) addrLines.push(esc(ad.mobile));
    if (ad.flat_no && ad.address && !ad.address.startsWith(ad.flat_no)) addrLines.push(esc(ad.flat_no));
    if (ad.address) addrLines.push(...ad.address.split('\n').map(line => esc(line)));
    if (ad.lat) addrLines.push(`Latitude: ${esc(String(ad.lat))}`);
    if (ad.lng) addrLines.push(`Longitude: ${esc(String(ad.lng))}`);
  } else if (order.addressDetails?.unresolvableShortLink) {
    addrLines.push('<b>Delivering To</b>');
    addrLines.push('<i>Address link could not be resolved — send a fresh address link or GPS pin.</i>');
  } else {
    addrLines.push('<b>Delivering To</b>');
    addrLines.push('<i>Address pending / share the Swiggy address link or a GPS pin.</i>');
  }
  blocks.push(addrLines.join('\n'));

  // ---------- 4. ORDER ITEMS ----------
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length > 0) {
    const itemLines = [];
    for (const it of items) {
      const qty = Number(it.qty || it.quantity || 1);
      const price = Number(it.price || (it.lineTotal ? it.lineTotal / qty : 0)) || 0;
      const lineTotal = Number(it.lineTotal || Math.round(price * qty * 100) / 100) || 0;
      itemLines.push(`<b>${esc(it.name || 'Item')}</b>`);
      itemLines.push(`₹${price} × ${qty} = ₹${lineTotal}`);
      itemLines.push('');
    }
    const totalQty = items.reduce((sum, it) => sum + Number(it.qty || it.quantity || 1), 0);
    const itemsTotal = Number(order.itemTotal || order.subtotal || items.reduce((sum, it) => sum + (Number(it.lineTotal) || 0), 0));
    itemLines.push(`${totalQty} ${totalQty === 1 ? 'Item' : 'Items'} • Subtotal: ₹${itemsTotal}`);
    blocks.push(itemLines.join('\n').trim());
  }

  // ---------- 5. BILL SUMMARY (clean, consistent) ----------
  const billLines = [];
  const hasBill = Number(order.finalPayable || order.subtotal || 0) > 0;
  if (hasBill) {
    billLines.push('<b>Bill Summary</b>');
    billLines.push(`Items Total: ₹${Number(order.subtotal || order.itemTotal || 0)}`);

    const merchantOfferDisc = order.merchantTradeDiscount !== undefined
      ? Number(order.merchantTradeDiscount || 0)
      : Math.max(0, Math.round((Number(order.tradeDiscountTotal || 0) - Number(order.campaignFreeCash || 0)) * 100) / 100);
    if (merchantOfferDisc > 0) billLines.push(`Restaurant Offer Discount: −₹${merchantOfferDisc}`);

    if (order.couponCode && Number(order.discountAmount || 0) > 0) {
      billLines.push(`Coupon ${esc(order.couponCode)}: −₹${Number(order.discountAmount)}`);
    } else if (order.couponCode) {
      billLines.push(`Coupon ${esc(order.couponCode)}: not applied`);
    } else if (order.swiggyVerified) {
      billLines.push('Coupon: no eligible offer confirmed by Swiggy');
    }

    const freeCash = Number(order.freeCashApplied || 0);
    if (freeCash > 0) billLines.push(`Extra Discount ( Free Cash ): −₹${freeCash}`);

    const oneFee = Number(order.swiggyOneMembershipFee || 0);
    if (oneFee > 0) billLines.push(`Swiggy One Lite Membership: +₹${oneFee}`);

    const savedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
    const isFreeDel = Number(order.deliveryFee || 0) <= 0 &&
      (order.swiggyOneApplied || savedDel > 0 || oneFee > 0 || order.freeDelivery);
    if (isFreeDel) {
      billLines.push('Free Delivery upto 7km');
      billLines.push(`Delivery Fee: FREE${savedDel > 0 ? ` (₹${savedDel} saved)` : ''}`);
    } else if (Number(order.deliveryFee || 0) > 0) {
      billLines.push(`Delivery Fee: ₹${Number(order.deliveryFee)}`);
    } else {
      billLines.push('Delivery Fee: FREE');
    }

    if (order.packingCharges > 0) billLines.push(`Packing Charges: ₹${Number(order.packingCharges)}`);
    if (order.taxesAndCharges > 0) billLines.push(`GST & Other Charges: ₹${Number(order.taxesAndCharges)}`);

    if (Number(order.totalSavings || 0) > 0) {
      billLines.push(`Total Savings: ₹${Number(order.totalSavings)}`);
    }
    billLines.push(`<b>To Pay: ₹${Number(order.finalPayable || order.subtotal || 0)}</b>`);
    // Card & other payment options (new)
    billLines.push(`<i>Pay via UPI QR, Card, or Wallet on Swiggy</i>`);
    blocks.push(billLines.join('\n'));
  } else {
    blocks.push('<b>Bill Summary</b>\n<i>Calculating max coupon and final bill on Swiggy…</i>');
  }

  // ---------- 6. PAYMENT LINK ----------
  if (order.swiggyPaymentUrl) {
    blocks.push(`<b>Swiggy Payment:</b> <a href="${esc(order.swiggyPaymentUrl)}">Open official Swiggy payment (UPI / Card)</a>`);
  }

  return blocks.filter(Boolean).join('\n\n');
}

// Format User (Customer) Order Screen matching State Machine
export function formatUserOrderCard(order) {
  const buttons = [];
  let text = '';
  const officialTrackingUrl = getStoredSwiggyTrackingUrl(order);

  if (order.status === 'ACCEPTED' || order.status === 'COMPLETED') {
    const trackingLine = officialTrackingUrl
      ? `<b>Swiggy tracking:</b> <a href="${escapeHtml(officialTrackingUrl)}">Open tracking link</a>`
      : '… Swiggy tracking link aate hi yahan bhej diya jayega.';
    const otpLine = order.deliveryOtp
      ? `<b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';
    text += `${heading(`Order #${order.id} — Confirmed`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Order Status', [
        `<b>${escapeHtml(order.liveOrderStatus || 'Processing')}</b>`,
        trackingLine,
        otpLine
      ].filter(Boolean).join('\n')) +
      `\n${field('Support', '@Its_life_001')}`;
    if (officialTrackingUrl) buttons.push([{ text: '📍 Open Swiggy Tracking', url: officialTrackingUrl, style: 'success' }]);
    if (order.swiggyPaymentUrl) buttons.push([{ text: '💳 Pay via Swiggy', url: order.swiggyPaymentUrl, style: 'primary' }]);
    buttons.push([
      { text: '↻ Refresh Status', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
      { text: '✖ Cancel Order', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
    ]);
    buttons.push([Markup.button.url('Contact support', 'https://t.me/Its_life_001')]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  if (order.status === 'REJECTED') {
    text += `${heading(`Order #${order.id} — Rejected`)}\n\n` +
      `${sub('Yeh order cancel/reject ho gaya hai. Naya order karne ke liye neeche dabayein:')}\n\n` +
      field('Support', '@Its_life_001');
    buttons.push([{ text: '🟠 Naya Order Karein', callback_data: 'user_back_to_main', style: 'danger' }]);
    buttons.push([Markup.button.url('Contact support', 'https://t.me/Its_life_001')]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // PENDING state: show only the verified bill and payment action.
  if (order.paymentSentToUser && (order.swiggyPaymentUrl || order.customQrFileId || order.finalPayable)) {
    const amt = order.finalPayable ? `₹${order.finalPayable}` : 'amount shown on Swiggy';
    text += `${heading(`Payment Ready — Order #${order.id}`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Payment', `${heading(`Pay ${esc(amt)}`)}\n${sub('Pay karne ke baad Check payment status dabayein.')}`) +
      `\n${field('Support', '@Its_life_001')}`;

    if (order.swiggyPaymentUrl) buttons.push([{ text: '💳 Pay via Swiggy (UPI/Card)', url: order.swiggyPaymentUrl, style: 'success' }]);
    buttons.push([{ text: '✓ Check payment status', callback_data: `user_paid_status_${order.id}`, style: 'success' }]);
    if (order.customQrFileId) {
      buttons.push([{ text: '↻ Resend payment QR', callback_data: `user_resend_qr_${order.id}`, style: 'primary' }]);
    } else if (order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.swiggyPaymentUrl) {
      buttons.push([{ text: '↻ Resend Swiggy payment details', callback_data: `user_resend_approved_qr_${order.id}`, style: 'primary' }]);
    }
  } else if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
    // The max-discount bill summary was sent; the QR is created only after approval.
    text += `${heading(`Bill summary sent (#${order.id})`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Confirm', `${heading('Bill check karke Approve karein')}\n${sub('Approve karte hi Swiggy payment QR aayega.')}`) +
      `\n${field('Support', '@Its_life_001')}`;
    buttons.push([{ text: '✓ Approve bill', callback_data: `user_approve_bill_${order.id}`, style: 'success' }]);
    buttons.push([{ text: '! Something is wrong', callback_data: `user_bill_issue_${order.id}`, style: 'danger' }]);
  } else if (Number(order.finalPayable || 0) > 0 && (order.selectedAccount || order.autoOptimized)) {
    // Auto max-offer finished: show the customer the verified bill while Boss approves.
    text += `${heading(`✓ Verified bill ready (#${order.id})`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Status', `${heading('Waiting for Beta approval')}\n${sub('Best offers lag chuke hain. Payment QR yahan aayega.')}`) +
      `\n${field('Support', '@Its_life_001')}`;
  } else if (order.cardStage === 'AUTO_SELECTING') {
    text += `${heading(`◷ Best offers check ho rahe hain (#${order.id})`)}\n\n` +
      section('Order details', [
        field('Restaurant', esc(order.restaurantName || 'Swiggy Food Order')),
        field('Status', '<b>Best offer lagaya ja raha hai</b>')
      ].join('\n')) +
      `\n${sub('Final bill yahan update ho jayega.')}`;
  } else {
    const rest = order.restaurantName || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : 'Swiggy Food Order');
    const ad = order.addressDetails || parseAddressDetails(order.address);
    const cleanAddr = ad?.address
      ? `${ad.address.slice(0, 50)}${ad.address.length > 50 ? '…' : ''}`
      : (ad?.city ? `${ad.city} Address` : (order.address ? 'Address attached' : 'Pending'));

    text += `${heading(`↗ Order sent to Beta (#${order.id})`)}\n\n` +
      section('Order details', [
        field('Restaurant', esc(rest)),
        field('Delivering to', esc(cleanAddr)),
        field('Status', '<b>Checking best offer</b>')
      ].join('\n')) +
      `\n${sub('Bill aur payment QR yahan aayega.')}\n\n` +
      `${field('Support', '@Its_life_001')}`;
  }

  buttons.push([
    { text: '↻ Refresh status', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
    { text: '✖ Cancel order', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
  ]);
  buttons.push([Markup.button.url('Contact support', 'https://t.me/Its_life_001')]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// Format Detailed Account Review Card for Boss (Address History, Order Items, Coupons, Final Charges & Payment)
function formatBossAccountReviewCard(order) {
  const db = getDb();
  const acc = db.config?.accounts?.[order.selectedAccount];
  const accPhone = order.orderAccount || acc?.phone || acc?.mobile || 'Selected Account';
  const accName = acc?.name || accPhone;

  let text = `${heading(`◉ [ SWIGGY ACCOUNT: ${esc(accName)} (${esc(accPhone)}) ]`)}` +
    `\n${heading(`▣ Order #${order.id} Review & Approval`)}`;

  const ad = order.addressDetails || parseAddressDetails(order.address);

  // ---------- 1. ADDRESS HISTORY & TARGET DELIVERY ----------
  let addrBody = '';
  if (ad && (ad.address || ad.city || ad.name)) {
    addrBody += `⌖ <b>Target delivery:</b> ${esc(ad.address || ad.city || '')}${ad.name ? ` (${esc(ad.name)})` : ''}\n`;
  } else if (order.address) {
    addrBody += `↗ <b>Address Link:</b> <code>${esc(order.address)}</code>\n`;
  }
  if (order.accountAddresses && order.accountAddresses.length > 0) {
    addrBody += `${sub(`Account Saved Addresses (${order.accountAddresses.length}):`)}\n`;
    order.accountAddresses.slice(0, 4).forEach((a, idx) => {
      const tag = a.annotation ? `[${a.annotation}] ` : '';
      addrBody += `  ${idx + 1}. ${esc(tag + a.address)}\n`;
    });
  } else {
    addrBody += `${sub('No prior saved addresses found on account. Target address will be used.')}\n`;
  }
  text += section('⌖ Address history & target delivery', addrBody);

  // ---------- 2. ORDER ITEMS (table inside border) ----------
  let itemsBody = `${esc(order.restaurantName || 'Swiggy Restaurant')}\n`;
  if (order.items && order.items.length > 0) {
    const rows = [['#', 'Item', 'Qty', 'Total']];
    order.items.forEach((it, idx) => {
      const total = it.lineTotal || (it.price * it.qty);
      rows.push([String(idx + 1), esc(it.name), String(it.qty || 1), `₹${total}`]);
    });
    itemsBody += table(rows);
    itemsBody += `${field('Subtotal', `₹${order.subtotal}`)}\n`;
  } else {
    itemsBody += `${sub('Items synced directly in Swiggy Cart / Group Order')}\n`;
  }
  text += section('▪ Verified order items', itemsBody);

  // ---------- 3. COUPON & OFFERS ----------
  let offersBody = '';
  if (order.couponCode && Number(order.discountAmount || 0) > 0) {
    offersBody += `✓ <b>Applied coupon:</b> <code>${esc(order.couponCode)}</code> (−₹${order.discountAmount})\n`;
  } else if (order.couponCode) {
    offersBody += `! <b>Coupon not applied:</b> <code>${esc(order.couponCode)}</code> (Swiggy confirmed ₹0 discount)\n`;
  } else {
    offersBody += `${sub(order.swiggyVerified ? 'No eligible coupon confirmed on this cart' : 'No coupon applied currently')}\n`;
  }
  if (order.availableCoupons && order.availableCoupons.length > 0) {
    const topCoupons = order.availableCoupons.slice(0, 5).map(c => c.code).join(', ');
    offersBody += `${field('Available on Account', `<code>${esc(topCoupons)}</code>`)}\n`;
  }
  text += section('◇ Coupon & offers', offersBody);

  // ---------- 4. FINAL BILL (table inside border) ----------
  const billRows = [['Final Bill', '']];
  billRows.push(['Items Total', `₹${order.subtotal || 0}`]);
  if (order.tradeDiscountTotal > 0) billRows.push(['Restaurant Offer Discount', `−₹${order.tradeDiscountTotal}`]);
  if (order.couponCode && order.discountAmount > 0) {
    billRows.push([`Coupon ${esc(order.couponCode)}`, `−₹${order.discountAmount}`]);
  }
  if (Number(order.swiggyOneMembershipFee || 0) > 0) {
    billRows.push(['Swiggy One Lite Membership', `+₹${order.swiggyOneMembershipFee}`]);
  }
  if (order.freeCashApplied > 0) billRows.push(['Swiggy Money / Free Cash', `−₹${order.freeCashApplied}`]);
  const revSavedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
  const revIsFreeDel = Number(order.deliveryFee || 0) <= 0 && (order.swiggyOneApplied || revSavedDel > 0 || Number(order.swiggyOneMembershipFee || 0) > 0 || order.freeDelivery);
  if (revIsFreeDel) {
    billRows.push(['Free Delivery upto 7km', `Delivery Fee: FREE${revSavedDel > 0 ? ` (₹${revSavedDel} saved)` : ''}`]);
  } else if (Number(order.deliveryFee || 0) > 0) {
    billRows.push(['Delivery Fee', `₹${order.deliveryFee}`]);
  } else {
    billRows.push(['Delivery Fee', 'FREE']);
  }
  if (order.packingCharges > 0) billRows.push(['Packing Charges', `₹${order.packingCharges}`]);
  if (order.taxesAndCharges > 0) billRows.push(['GST & Other Charges', `₹${order.taxesAndCharges}`]);
  if (order.totalSavings > 0) billRows.push(['Total Savings', `₹${order.totalSavings}`]);
  billRows.push([`<b>Final Total</b>`, `<b>₹${order.finalPayable || order.subtotal || 0}</b>`]);
  text += section('₹ Final bill', table(billRows));

  // ---------- 5. OFFICIAL SWIGGY PAYMENT ----------
  let payBody = '';
  if (order.customQrFileId || order.qrBuffer) {
    payBody += `▣ Official payment QR: <b>Ready and captured</b>\n`;
  } else {
    payBody += `… Payment QR: <i>Pending / manual capture</i>\n`;
  }
  if (order.swiggyPaymentUrl) {
    payBody += `↗ Link: <a href="${esc(order.swiggyPaymentUrl)}">Open Swiggy Checkout</a>\n`;
  }
  if (order.paymentSentToUser) {
    payBody += `✓ <b>Status:</b> <b>Delivered to customer (awaiting payment)</b>`;
  } else {
    payBody += `! <b>Review the details above before sending the bill and payment QR.</b>`;
  }
  text += section('↗ Official Swiggy payment', payBody);

  const buttons = [];
  if (!order.paymentSentToUser) {
    buttons.push([
      Markup.button.callback('› Send Bill & Payment QR to Customer', `boss_send_qr_to_user_${order.id}`)
    ]);
  } else {
    buttons.push([
      Markup.button.callback('↻ Resend Bill & QR to Customer', `boss_send_qr_to_user_${order.id}`)
    ]);
  }
  buttons.push([
    Markup.button.callback('★ Auto Max Coupon (Best Acc)', `boss_auto_max_coupon_${order.id}`)
  ]);
  buttons.push([
    Markup.button.callback('↻ Switch Account', `boss_choose_acc_picker_${order.id}`),
    Markup.button.callback('# Change Coupon', `boss_coupon_picker_${order.id}`)
  ]);
  if (order.accountAddresses && order.accountAddresses.length > 0) {
    buttons.push([
      Markup.button.callback('⌖ Select Account Address', `boss_addr_picker_${order.id}`)
    ]);
  }
  buttons.push([
    Markup.button.callback('✓ Accept Order', `boss_action_accept_${order.id}`),
    Markup.button.callback('× Reject Order', `boss_action_sorry_${order.id}`)
  ]);
  buttons.push([
    Markup.button.callback('← Back to Order Screen', `boss_back_to_order_${order.id}`)
  ]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// Formats high-clarity OTP Send Failure Card with exact real diagnosis
function formatOtpSendErrorCard(phone, result = {}) {
  const reason = result.message || result.swiggyStatus || 'Swiggy could not confirm the OTP request.';
  const details = result.details || (result.status ? `HTTP ${result.status}` : '');
  const securityChallenge = result.code === 'SWIGGY_SECURITY_CHALLENGE';
  const rateLimited = result.code === 'SWIGGY_RATE_LIMIT';
  const blockedBySwiggy = securityChallenge || rateLimited;
  const hint = securityChallenge
    ? 'Swiggy controls this verification. Complete it in the official app/site and do not retry repeatedly.'
    : (rateLimited
        ? 'Wait for Swiggy’s limit to clear before making another OTP request.'
        : (result.retryable === true ? 'Wait briefly, then try once more if the issue continues.' : 'Check the number and Swiggy response before trying again.'));

  const text = otpErrorCard(phone, reason, hint)
    + (details ? `\n⌕ <i>Diagnostic Info: ${escapeHtml(details)}</i>\n` : '')
    + (blockedBySwiggy
        ? `\ni <i>Security checks and request limits are controlled by Swiggy. This bot will not bypass them. If you already have a valid session export for this account, use the JSON import option.</i>`
        : `\ni <i>If you have a valid Swiggy session export for this account, you can import it instead.</i>`);

  const buttons = blockedBySwiggy
    ? [
        [Markup.button.url('Open official Swiggy', 'https://www.swiggy.com/')],
        [Markup.button.callback('Paste Session JSON', 'boss_login_with_json'), Markup.button.callback('Main Menu', 'boss_panel_home')]
      ]
    : [
        ...(result.retryable === true ? [[Markup.button.callback('Retry OTP once', `resend_otp_${phone}`)]] : []),
        [Markup.button.callback('Enter Number Again', 'send_to_another_number')],
        [Markup.button.callback('Paste Session JSON', 'boss_login_with_json'), Markup.button.callback('Main Menu', 'boss_panel_home')]
      ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
// User Screen Generator - Short, direct single-card UI with colorful orange buttons (no slots)
function getUserScreen(userId, user) {
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return formatUserOrderCard(activeOrder);
  }

  const draft = getDraft(userId);
  const hasCart = Boolean(draft.cart);
  const hasAddr = Boolean(draft.address);
  const bothReady = hasCart && hasAddr;

  const cartBtn = hasCart
    ? { text: '🟢 🛒 Cart ✓', callback_data: 'action_add_cart', style: 'success' }
    : { text: '🟠 🛒 Cart Link', callback_data: 'action_add_cart', style: 'danger' };
  const addressBtn = hasAddr
    ? { text: '🟢 📍 Address ✓', callback_data: 'action_add_address', style: 'success' }
    : { text: '🟠 📍 Address Link', callback_data: 'action_add_address', style: 'danger' };

  const inlineButtons = [
    [cartBtn, addressBtn],
    [{ text: '🚀 Send to Beta', callback_data: 'action_send_to_boss', style: bothReady ? 'success' : 'primary' }],
    [
      { text: '📦 Previous Order', callback_data: 'action_previous_order', style: 'primary' },
      { text: '✖ Cancel', callback_data: 'action_cancel_order_confirm', style: 'danger' }
    ]
  ];

  const cd = draft.cartDetails || {};
  const itemRows = Array.isArray(cd.items) ? cd.items : [];
  const subVal = Number(
    cd.subtotal ||
    cd.itemsTotal ||
    itemRows.reduce((s, it) => s + Number(it.lineTotal || (Number(it.price || 0) * Number(it.qty || it.quantity || 1)) || 0), 0)
  );

  const shortUrl = (u) => {
    const clean = String(u || '').replace(/^https?:\/\/(?:www\.)?/i, '');
    return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean;
  };

  let cartLine = '🟠 <b>Cart:</b> Link bhejein';
  if (hasCart) {
    const restPart = cd.restaurantName
      ? `<b>${esc(cd.restaurantName)}</b>${subVal > 0 ? ` (₹${subVal})` : ''} · `
      : '';
    cartLine = `✓ <b>Cart:</b> ${restPart}<code>${esc(shortUrl(draft.cart))}</code>`;
    if (itemRows.length > 0) {
      const previewItems = itemRows.slice(0, 4).map((it) => {
        const q = Number(it.qty || it.quantity || 1);
        return `  • ${esc(it.name || 'Item')} × ${q}`;
      });
      if (itemRows.length > 4) previewItems.push(`  • +${itemRows.length - 4} more`);
      cartLine += `\n${previewItems.join('\n')}`;
    }
  }

  let addrLine = '🟠 <b>Address:</b> Link bhejein';
  if (hasAddr) {
    const ad = draft.addressDetails || {};
    const addrUrl = draft.addressLink || (String(draft.address).startsWith('http') ? draft.address : '');
    const humanAddr = ad.address && !String(ad.address).startsWith('http')
      ? `${ad.address.slice(0, 45)}${ad.address.length > 45 ? '…' : ''}`
      : (!String(draft.address).startsWith('http') ? `${String(draft.address).slice(0, 45)}${String(draft.address).length > 45 ? '…' : ''}` : '');
    const parts = [];
    if (humanAddr) parts.push(esc(humanAddr));
    if (addrUrl) parts.push(`<code>${esc(shortUrl(addrUrl))}</code>`);
    addrLine = `✓ <b>Address:</b> ${parts.join(' · ') || 'Added'}`;
  }

  let nextLine = '';
  if (!hasCart && !hasAddr) {
    nextLine = '👉 Seedha <b>Cart</b> aur <b>Address link</b> bhejein 👇';
  } else if (hasCart && !hasAddr) {
    nextLine = '🟠 Ab <b>Address link</b> bhejein 👇';
  } else if (!hasCart && hasAddr) {
    nextLine = '🟠 Ab <b>Cart link</b> bhejein 👇';
  } else {
    nextLine = '🟢 <b>Dono links verified!</b> Ab <b>Send to Beta</b> dabayein 👇';
  }

  if (draft.addressDetails?.unresolvableShortLink) {
    nextLine += '\n⚠️ Naya <b>Address link</b> ya Location pin bhejein.';
  }

  const headerTitle = bothReady ? '🍽 <b>Order Ready!</b>' : '🍽 <b>Khana Order Karein</b>';
  const text = `${headerTitle}\n\n${cartLine}\n${addrLine}\n\n${nextLine}`;

  return { text, keyboard: Markup.inlineKeyboard(inlineButtons) };
}

// Boss Panel Home — clean Apple-style panel (built in boss-panel.js)
function getBossPanelHome() {
  return buildBossPanelHome(getDb());
}

function getBossPanelText() {
  return buildBossPanelHome(getDb()).text;
}

function getBossPanelKeyboard() {
  return { reply_markup: buildBossPanelHome(getDb()).keyboard };
}

// ===== RARE TELEGRAM BUTTONS — jo bahut kam log jaante hain (ekdam alag type) =====
export function buildRareInlineButtons(order){
  const orderId = String(order?.swiggyOrderId || order?.id || '').trim();
  const trackUrl = getStoredSwiggyTrackingUrl(order);
  const payUrl = String(order?.swiggyPaymentUrl || order?.pendingSwiggyUpiUri || order?.realUpiIntentUri || 'https://www.swiggy.com/payments').trim();
  const phone = String(order?.addressDetails?.mobile || order?.addressDetails?.phone || '').replace(/\D/g,'').slice(-10);
  const otp = String(order?.deliveryOtp || '').trim();
  const shortId = orderId ? orderId.slice(-6) : 'ID';
  // Rare buttons: copy_text (Bot API 7.4), switch_inline_query, switch_inline_query_chosen_chat
  const rows = [];
  rows.push([
    { text: `📋 Copy ID ${shortId}`, copy_text: { text: orderId || 'no-id' } },
    trackUrl
      ? { text: '🔗 Open Tracking', url: trackUrl }
      : { text: '🔗 Extract Tracking', callback_data: `extract_now_${order?.swiggyOrderId || order?.id || '0'}` }
  ]);
  rows.push([
    { text: '↗️ Share to Chat', switch_inline_query: `Swiggy ${orderId} ${order?.restaurantName||''}`.trim() },
    { text: '👥 Share to Group', switch_inline_query_chosen_chat: { query: `order ${orderId}`, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true } }
  ]);
  const payRow = [];
  if (otp) payRow.push({ text: `🔢 Copy OTP ${otp}`, copy_text: { text: otp } });
  payRow.push({ text: '💳 Pay Instantly', url: payUrl });
  rows.push(payRow);
  if (phone) rows.push([{ text: `📞 Copy Phone ${phone.slice(-4)}`, copy_text: { text: phone } }, Markup.button.url('☎️ Support', 'https://t.me/Its_life_001')]);
  else rows.push([Markup.button.url('☎️ Support', 'https://t.me/Its_life_001')]);
  rows.push([Markup.button.callback('🔄 Refresh Status', `user_refresh_status_${order.id}`), Markup.button.callback('❌ Cancel', `action_cancel_order_confirm_${order.id}`)]);
  return Markup.inlineKeyboard(rows);
}

export function getRareReplyKeyboard(){
  // Rare KeyboardButtons: request_contact, request_location, request_poll, request_users, request_chat
  return Markup.keyboard([
    [Markup.button.contactRequest('📱 Send My Contact ✅'), Markup.button.locationRequest('📍 Share Live Location 📡')],
    [Markup.button.pollRequest('📊 Create Delivery Poll', 'regular'), Markup.button.text('🛒 New Order')],
    [{ text: '👤 Share User', request_users: { request_id: 1, user_is_bot: false } }, { text: '🏢 Share Group', request_chat: { request_id: 2, chat_is_channel: false, chat_is_forum: false } }],
    ['📦 My Orders', '◉ Family Accounts']
  ]).resize().persistent();
}

function getRareBotMainButtons(){
  return [
    [{ text: '✨ Ultra Card Pay', callback_data: 'rare_ultra_card' }, { text: '🔗 Extract Tracking', callback_data: 'boss_extract_tracking_prompt' }],
    [{ text: '📋 Copy Bot Link', copy_text: { text: PUBLIC_SERVICE_URL } }, { text: '↗️ Share Bot', switch_inline_query: 'Try this Swiggy Bot' }],
    [{ text: '📱 Verify Phone (Rare)', request_contact: true }, { text: '📍 Share Location (Rare)', request_location: true }]
  ];
}

const PUBLIC_SERVICE_URL = getPublicServiceBaseUrl();

function makeCopyButton(label, value, fallbackCallback, style = 'primary') {
  if (value && value.length > 0 && value.length <= 256) {
    return { text: label, copy_text: { text: value }, style };
  }
  return { text: label, callback_data: fallbackCallback, style };
}

// Short values use Telegram's native copy button. Longer session exports are
// sent by the bot when the callback is tapped; no web page is required.
function makeFullSessionCopyButton(_ctx, label, accKey, fullValue, fallbackCallback, style = 'primary') {
  if (fullValue && fullValue.length > 0 && fullValue.length <= 256) {
    return { text: label, copy_text: { text: fullValue }, style };
  }
  return { text: label, callback_data: fallbackCallback || `copy_code_${accKey}`, style };
}

// Single card in-place updater for Boss and User
async function updateOrderCards(order) {
  const db = getDb();
  const result = { bossCardUpdated: false, userCardUpdated: false };

  // 1. Update Boss card in-place
  if (order.bossMessageIds) {
    const bossCard = formatBossOrderCard(order);
    for (const [bossId, msgId] of Object.entries(order.bossMessageIds)) {
      try {
        await bot.telegram.editMessageText(
          bossId,
          msgId,
          null,
          bossCard.text,
          { parse_mode: 'HTML', ...bossCard.keyboard }
        );
        result.bossCardUpdated = true;
      } catch (e) {}
    }
  }

  // 2. Update User card in-place
  if (order.userChatId && order.userMessageId) {
    const userCard = formatUserOrderCard(order);
    try {
      await bot.telegram.editMessageText(
        order.userChatId,
        order.userMessageId,
        null,
        userCard.text,
        { parse_mode: 'HTML', ...userCard.keyboard }
      );
      result.userCardUpdated = true;
    } catch (e) {}
  }
  return result;
}

// Boss must also see the max-discount bill summary for customer orders. Usually
// the existing Boss card is just edited; if that card is gone, ONE compact
// summary message is posted (tracked so it is never repeated).
async function ensureBossBillSummary(order) {
  const db = getDb();
  const bossIds = [...new Set((db.config?.bossIds || []).filter(Boolean).map(String))];
  const sentTo = order.billSummarySentTo && typeof order.billSummarySentTo === 'object' ? order.billSummarySentTo : {};
  let posted = false;
  for (const bossId of bossIds) {
    if (sentTo[bossId]) continue;
    const hasLiveCard = Boolean(order.bossMessageIds?.[bossId]);
    // Prefer updating the live card; it is the single card for that Boss.
    if (hasLiveCard) {
      try {
        const card = formatBossOrderCard(order);
        await bot.telegram.editMessageText(bossId, order.bossMessageIds[bossId], null, card.text, {
          parse_mode: 'HTML',
          ...card.keyboard
        });
        sentTo[bossId] = new Date().toISOString();
        continue;
      } catch {}
    }
    const summaryText =
      `▤ <b>Bill summary · Order #${escapeHtml(order.id)}</b>\n` +
      `◉ <b>For:</b> ${escapeHtml(order.fwdSenderName || order.userName || 'Customer')}\n` +
      `▤ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy')}\n` +
      `₹ <b>To pay:</b> ₹${Number(order.finalPayable || 0)}\n` +
      (order.couponCode ? `◎ <b>Best offer:</b> ${escapeHtml(order.couponCode)}\n` : '') +
      (order.orderAccount ? `● <b>Account:</b> <code>${escapeHtml(String(order.orderAccount))}</code>\n` : '') +
      `\n<i>Bill customer ko confirmation ke liye bhej diya gaya hai; QR unke confirm karne par jayega.</i>`;
    try {
      const sent = await bot.telegram.sendMessage(bossId, summaryText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('Refresh status', 'boss_refresh')]])
      });
      order.bossMessageIds = { ...(order.bossMessageIds || {}), [bossId]: sent?.message_id };
      sentTo[bossId] = new Date().toISOString();
      posted = true;
    } catch {}
  }
  order.billSummarySentTo = sentTo;
  const fresh = getDb();
  if (fresh.orders?.[order.id]) {
    fresh.orders[order.id] = { ...fresh.orders[order.id], billSummarySentTo: sentTo, bossMessageIds: order.bossMessageIds };
    saveDb(fresh);
  }
  return posted;
}

// The bill summary is rendered INTO the customer's single live card when it
// exists, so confirming the bill never adds another chat bubble.
async function deliverBillSummaryIntoSingleCard(order, _summary) {
  const uid = order?.userChatId || order?.userId;
  if (!uid) return false;
  const state = userChatCards.get(String(uid));
  if (!state?.messageId) return false;
  const preview = {
    ...order,
    status: 'APPROVAL_PENDING',
    uxStage: 'SCREEN_03_BILL_CONFIRMATION',
    billSummarySentAt: order.billSummarySentAt || new Date().toISOString(),
    userChatId: uid,
    userMessageId: state.messageId
  };
  const res = await updateOrderCards(preview).catch(() => null);
  return Boolean(res?.userCardUpdated);
}

// Delete order card messages from all boss chats and customer chat
async function deleteOrderMessages(order) {
  if (!order) return;
  // 1. Delete all boss card messages
  if (order.bossMessageIds) {
    for (const [bossId, msgId] of Object.entries(order.bossMessageIds)) {
      try {
        await bot.telegram.deleteMessage(bossId, msgId);
      } catch (e) {}
    }
  }
  // 2. Delete user card message
  if (order.userChatId && order.userMessageId) {
    try {
      await bot.telegram.deleteMessage(order.userChatId, order.userMessageId);
    } catch (e) {}
  }
}

// Send authentic Swiggy payment details to User (NEVER synthetic fake upi://pay)
async function sendPaymentQrToUser(order) {
  if (!order) return;
  const targetChat = order.userChatId || order.userId;
  if (!targetChat) return;

  // 1. Ensure personalized QR code with customer's Telegram name in center of QR
  if (!order.genuineQrBuffer && !order.customQrFileId && (order.finalPayable || order.subtotal)) {
    const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
    const db = getDb();
    const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
    const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;
    try {
      // Try ultra premium holographic card first (alag type ka card), fallback to classic
      let generatedBuf = null;
      try { generatedBuf = await generateUltraPremiumCard({ customerName: custDisplayName, restaurantName: order.restaurantName || 'Swiggy Food Order', amount: order.finalPayable || order.subtotal || 0, savings: order.totalSavings || 0, upiUrl: upiUri, orderId: order.id, address: order.addressDetails?.address || order.address || '', deliveryOtp: order.deliveryOtp || '' }); } catch(e){}
      if (!generatedBuf) generatedBuf = await generatePersonalizedQrCard({
        customerName: custDisplayName,
        restaurantName: order.restaurantName || 'Swiggy Food Order',
        amount: order.finalPayable || order.subtotal || 0,
        savings: order.totalSavings || 0,
        upiUrl: upiUri
      });
      if (generatedBuf) {
        order.genuineQrBuffer = generatedBuf;
        saveDb(db);
      }
    } catch (e) {
      console.warn('[sendPaymentQrToUser] Card generation fallback:', e.message);
    }
  }

  // 2. If genuine custom QR photo from Swiggy was uploaded by Boss OR captured by automation
  if (order.customQrFileId || order.genuineQrBuffer) {
    try {
      const payable = order.finalPayable ? `₹${order.finalPayable}` : 'As shown on Swiggy';
      const photoSource = order.customQrFileId || { source: Buffer.from(order.genuineQrBuffer) };
      const rarePayRow = [];
      const _otp = String(order.deliveryOtp||'').trim();
      if (_otp) rarePayRow.push({ text: `📋 Copy OTP ${_otp}`, copy_text: { text: _otp } });
      const _payUrl = String(order.swiggyPaymentUrl||'https://www.swiggy.com/payments');
      rarePayRow.push({ text: '💳 Pay Link', url: _payUrl.startsWith('http')? _payUrl : 'https://www.swiggy.com/payments' });
      await bot.telegram.sendPhoto(targetChat, photoSource, {
        caption: safeTelegramCaption(
          `● <b>Official Swiggy Payment QR (Order #${order.id})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Order', 120))}\n` +
          `₹ <b>Payable on Swiggy:</b> <b>${payable}</b>\n\n` +
          `<i>Scan this genuine Swiggy QR code in PhonePe / Google Pay / Paytm / BHIM to pay directly to Swiggy:</i>`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)],
          [{ text: '↗️ Share Order', switch_inline_query: `Order #${order.id} ${order.restaurantName||''}` }, { text: '👥 Share to Group', switch_inline_query_chosen_chat: { query: `order ${order.id}`, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true } }],
          rarePayRow,
          [{ text: `📋 Copy Order ${String(order.id).slice(-4)}`, copy_text: { text: String(order.id) } }, Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      });
      order.qrSent = true;
      order.qrDelivered = true;
      saveDb(getDb());
      // Direct SMS to registered mobile with payment link (rare bot feature)
      sendPaymentLinkSms(order, order.swiggyPaymentUrl || `upi://pay?pa=${getDb().config?.bossUpiId||'6296591407@ybl'}&am=${order.finalPayable||0}`).catch(()=>{});
      return;
    } catch (e) {
      console.error(`Failed to send custom QR photo: ${e.message}`);
    }
  }

  // 2. If genuine Swiggy payment URL was generated by Swiggy / Boss
  if (order.swiggyPaymentUrl) {
    try {
      const _rareUrlRow = [{ text: `📋 Copy Link`, copy_text: { text: String(order.swiggyPaymentUrl) } }, { text: '💳 Pay Link', url: String(order.swiggyPaymentUrl) }];
      await bot.telegram.sendMessage(
        targetChat,
        `₹ <b>Official Swiggy Payment Link (Order #${order.id})</b>\n\n` +
        `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
        (order.finalPayable ? `₹ <b>Amount:</b> ₹${order.finalPayable}\n\n` : '\n') +
        `↗ <b>Click to Pay Directly on Swiggy:</b>\n<a href="${escapeHtml(order.swiggyPaymentUrl)}">${escapeHtml(order.swiggyPaymentUrl)}</a>\n\n` +
        `<i>★ Yeh authentic link Swiggy payment page se generated hai. Payment ke baad [ Check payment status ] dabayein!</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('₹ Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)],
            [{ text: '↗️ Share Link', switch_inline_query: `${order.swiggyPaymentUrl}` }, { text: '👥 To Group', switch_inline_query_chosen_chat: { query: `pay ${order.id}`, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true } }],
            _rareUrlRow,
            [Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)],
            [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
          ])
        }
      );
      order.qrSent = true;
      saveDb(getDb());
      sendPaymentLinkSms(order, order.swiggyPaymentUrl).catch(()=>{});
      return;
    } catch (e) {
      console.error(`Failed to send payment URL: ${e.message}`);
    }
  }

  // 3. If payment link/QR not yet ready from Swiggy, inform customer with real status (NO FAKE UPI QR!)
  try {
    await bot.telegram.sendMessage(
      targetChat,
      `◷ <b>Swiggy Payment Link / QR Processing (Order #${order.id})</b>\n\n` +
      `Beta aapka cart Swiggy par open karke maximum discount & coupons verify kar raha hai.\n` +
      `Swiggy payment page se authentic link/QR aate hi yahan turant bhej diya jayega.\n\n` +
      `› <b>Immediate Help:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('○ Refresh Status', `user_refresh_status_${order.id}`)],
          [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  } catch (e) {}
}

// Asynchronous Cart & Address Inspection (runs on order submission or manual refresh — resolves live Group Cart, geocodes address, and preloads saved account addresses)
async function triggerBackgroundCartFetch(orderId) {
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return;

  console.log(`[AutoFetch] Starting live cart & address resolution for Order #${orderId}...`);

  // Helper to safely merge non-empty address fields without overwriting valid street/coords with blanks or shortlink placeholders
  const mergeAddressSafe = (target, incoming) => {
    if (!incoming || incoming.unresolvableShortLink) return target;
    const base = { ...(target || {}) };
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== null && v !== undefined && v !== '' && k !== 'unresolvableShortLink') {
        base[k] = v;
      }
    }
    const normalizeAddressIdentity = value => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('en-IN')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const previousAddress = normalizeAddressIdentity(target?.address);
    const incomingAddress = normalizeAddressIdentity(incoming.address);
    if (previousAddress && incomingAddress && previousAddress !== incomingAddress) {
      // A changed street/pin must not inherit a previous recipient, location, or saved-address ID.
      for (const key of ['id', 'name', 'mobile', 'flat_no', 'area', 'landmark', 'city', 'pincode', 'lat', 'lng', 'annotation']) {
        if (incoming[key] === null || incoming[key] === undefined || incoming[key] === '') delete base[key];
      }
      if (!isValidIndianDeliveryCoordinates(incoming.lat, incoming.lng)) {
        delete base.lat;
        delete base.lng;
      }
    }
    return base;
  };

  // 1. Parse & geocode address details from full original text + link
  const rawAddrInput = order.addressOriginalText || order.address || '';
  if (rawAddrInput) {
    const parsedAddr = parseAddressDetails(rawAddrInput);
    if (parsedAddr) {
      order.addressDetails = mergeAddressSafe(order.addressDetails, parsedAddr);
    }
    try {
      const addrMeta = await resolveSwiggyLink(rawAddrInput);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        order.addressDetails = mergeAddressSafe(order.addressDetails, addrMeta.addressDetails);
      }
      if (addrMeta?.ofoUser && !order.addressDetails?.name) {
        order.addressDetails = { ...(order.addressDetails || {}), name: addrMeta.ofoUser };
      }
    } catch (e) {}
  }

  if (order.addressDetails) {
    try {
      order.addressDetails = await geocodeAddressDetails(order.addressDetails);
      if (order.addressDetails?.address && (!order.address || order.address.startsWith('http'))) {
        order.addressLink = order.addressLink || (order.address?.startsWith('http') ? order.address : null);
        order.address = order.addressDetails.address;
      }
    } catch (e) {}
  }

  // Preload saved addresses across all logged-in Swiggy accounts for 1-tap Boss picker & bare-shortlink fallback
  try {
    const allSaved = await fetchAllAccountsSavedAddresses();
    if (allSaved.length > 0) {
      order.accountAddresses = allSaved;
    }
  } catch (e) {}

  // 2. Resolve live Group Cart / Restaurant Menu / Personal Cart
  if (order.cart) {
    try {
      const cartMeta = await resolveSwiggyLink(order.cart);
      if (cartMeta?.restaurantId) order.restaurantId = cartMeta.restaurantId;
      if (cartMeta?.restaurantName) order.restaurantName = cartMeta.restaurantName;
      if (cartMeta?.hostName) order.hostName = cartMeta.hostName;
      if (cartMeta?.groupCartId) order.groupCartId = cartMeta.groupCartId;
      if (cartMeta?.groupCartStatus) order.groupCartStatus = cartMeta.groupCartStatus;

      if (cartMeta?.cartDetails) {
        const cd = cartMeta.cartDetails;
        if (cd.restaurantName) order.restaurantName = cd.restaurantName;
        if (cd.items && cd.items.length > 0) {
          order.items = cd.items;
          order.itemTotal = cd.itemsTotal || cd.subtotal || 0;
          order.subtotal = cd.subtotal || cd.itemsTotal || 0;
          if (cd.tradeDiscountTotal !== undefined) order.tradeDiscountTotal = cd.tradeDiscountTotal;
          if (cd.couponCode) { order.couponCode = cd.couponCode; order.discountAmount = cd.discountAmount || 0; }
          if (cd.swiggyOneMembershipFee > 0) order.swiggyOneMembershipFee = cd.swiggyOneMembershipFee;
          if (cd.freeCashApplied > 0) order.freeCashApplied = cd.freeCashApplied;
          if (cd.freeDelivery) {
            order.freeDelivery = true;
            order.swiggyOneApplied = true;
            order.freeDeliveryDiscount = cd.freeDeliveryDiscount || cd.deliverySaved || 0;
          }
          if (cd.packingCharges !== undefined) order.packingCharges = cd.packingCharges;
          if (cd.gstCharges !== undefined) order.taxesAndCharges = cd.gstCharges;
          if (cd.totalSavings > 0) order.totalSavings = cd.totalSavings;
          if (cd.finalPayable > 0) {
            order.finalPayable = cd.finalPayable;
            order.swiggyVerified = true;
          } else {
            order.swiggyVerified = false;
            applyMaxOfferToOrder(order);
          }
        }
      }

      // Auto-sync live Group Cart & apply Max Coupon across saved JSON Vault accounts immediately upon order arrival (ZERO OTP!)
      if (order.groupCartId && order.items?.length > 0 && !order.selectedAccount) {
        const bestRes = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false }).catch(() => null);
        if (bestRes?.availableCoupons?.length > 0) {
          order.availableCoupons = bestRes.availableCoupons;
        }
        if (bestRes?.savedAddresses?.length > 0 && (!order.accountAddresses || order.accountAddresses.length === 0)) {
          order.accountAddresses = bestRes.savedAddresses;
        }
      }

      // If no groupCartId items yet, check selected / active account personal cart when restaurant matches
      if ((!order.items || order.items.length === 0) && !order.groupCartId) {
        const targetKey = order.selectedAccount || getActiveOrderAccountKey(db);
        const targetAcc = db.config?.accounts?.[targetKey];
        if (targetAcc?.cookies) {
          const livePersonal = await inspectCartForAccount(targetAcc);
          if (livePersonal?.items?.length > 0 && (!order.restaurantId || String(livePersonal.restaurantId) === String(order.restaurantId))) {
            order.items = livePersonal.items;
            order.restaurantId = livePersonal.restaurantId || order.restaurantId;
            if (livePersonal.restaurantName) order.restaurantName = livePersonal.restaurantName;
            order.itemTotal = livePersonal.itemTotal;
            order.subtotal = livePersonal.subtotal;
            order.tradeDiscountTotal = livePersonal.tradeDiscountTotal || 0;
            order.deliveryFee = livePersonal.deliveryFee || 0;
            order.packingCharges = livePersonal.packingCharges || 0;
            order.taxesAndCharges = livePersonal.taxesAndCharges || 0;
            order.couponCode = livePersonal.couponCode || order.couponCode || null;
            order.discountAmount = livePersonal.discountAmount || 0;
            order.finalPayable = livePersonal.finalPayable;
            order.totalSavings = livePersonal.totalSavings;
            order.swiggyVerified = true;
          }
        }
      }
    } catch (e) {
      console.error(`[AutoFetch] Cart resolution error on Order #${orderId}:`, e.message);
    }
  }

  // 3. Clean fallback restaurant name only if still blank
  if (!order.restaurantName) {
    order.restaurantName = order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : (order.hostName ? `${order.hostName}'s Group Order` : 'Swiggy Food Order');
  }

  saveDb(db);
  await updateOrderCards(order);
}

// ---------------------------------------------------------------------------
// AUTO MAX-OFFER FOR CUSTOMER SUBMISSIONS
// ---------------------------------------------------------------------------
// A forwarded message runs the full pipeline (best 0-Order account -> max coupon
// -> live bill) automatically. A customer tapping "Send to Beta" used to stop at a
// plain PENDING order, so Ammi had to wait for Boss to press "Auto Max Coupon".
// This helper gives customer orders the exact same treatment, in the background.
const autoOptimizeInFlight = new Set();

export async function autoOptimizeUserOrder(orderId, { reason = 'CUSTOMER_SEND_TO_BETA' } = {}) {
  const key = String(orderId);
  if (autoOptimizeInFlight.has(key)) return { skipped: true, reason: 'in-flight' };
  autoOptimizeInFlight.add(key);

  try {
    let db = getDb();
    let order = db.orders?.[key];
    if (!order) return { skipped: true, reason: 'missing' };
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) return { skipped: true, reason: 'closed' };
    if (order.isForwardedOrder) {
      // Forwarded orders have their own pipeline (AUTO_SELECTING card flow).
      return { skipped: true, reason: 'forwarded' };
    }

    // No cart -> nothing to scan.
    if (!order.cart) {
      order.autoOptimizeError = 'Cart link missing — no account scan possible.';
      saveDb(db);
      await updateOrderCards(order).catch(() => {});
      return { skipped: true, reason: 'no-cart' };
    }

    // Background cart fetch may already have picked the best account + live bill.
    const alreadyPicked = Boolean(order.selectedAccount) && Number(order.finalPayable || 0) > 0;
    if (alreadyPicked) {
      order.cardStage = 'BILL_READY';
      order.autoOptimized = true;
      order.autoOptimizedAt = order.autoOptimizedAt || new Date().toISOString();
      delete order.autoOptimizeError;
      saveDb(db);

      // Still send the one-time bill summary so the customer can confirm the QR.
      let summarySent = false;
      try {
        const summarySend = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
          db: getDb(),
          deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary)
        });
        summarySent = Boolean(summarySend?.sent);
      } catch (summaryErr) {
        console.warn('[AutoOptimize] Bill summary skipped:', summaryErr?.message || summaryErr);
      }

      order = getDb().orders?.[key] || order;
      await updateOrderCards(order).catch(() => {});
      if (summarySent) await ensureBossBillSummary(order).catch(() => {});
      return { success: true, reused: true, summarySent, order };
    }

    const statusBefore = order.status || 'PENDING';
    order.cardStage = 'AUTO_SELECTING';
    order.autoOptimizeStartedAt = new Date().toISOString();
    delete order.autoOptimizeError;
    saveDb(db);
    await updateOrderCards(order).catch(() => {});

    console.log(`[AutoOptimize] Order #${key} (${reason}): scanning accounts for max offer...`);
    const best = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });

    if (!best?.success) {
      db = getDb();
      order = db.orders?.[key] || order;
      order.cardStage = 'PENDING';
      order.status = statusBefore;
      order.autoOptimizeError = best?.error || 'Could not sync cart on any free Swiggy account.';
      order.autoOptimizeFailedAt = new Date().toISOString();
      saveDb(db);
      await updateOrderCards(order).catch(() => {});
      console.warn(`[AutoOptimize] Order #${key} failed: ${order.autoOptimizeError}`);
      return { success: false, error: order.autoOptimizeError, code: best?.code };
    }

    db = getDb();
    order = db.orders?.[key] || order;

    if (Array.isArray(best.savedAddresses) && best.savedAddresses.length > 0) order.accountAddresses = best.savedAddresses;
    if (Array.isArray(best.availableCoupons) && best.availableCoupons.length > 0) order.availableCoupons = best.availableCoupons;
    if (best.paymentUrl) order.swiggyPaymentUrl = best.paymentUrl;
    applyMaxOfferToOrder(order);

    // Keep the order in Boss's approval queue: only the bill/offers were computed.
    order.status = statusBefore;
    order.cardStage = 'BILL_READY';
    order.autoOptimized = true;
    order.autoOptimizedAt = new Date().toISOString();
    order.accountComparison = best.accountComparison || [];
    delete order.autoOptimizeError;
    saveDb(db);

    // One-time max-discount bill summary -> customer approves -> QR is generated.
    let summarySent = false;
    try {
      const summarySend = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
        db: getDb(),
        deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary)
      });
      summarySent = Boolean(summarySend?.sent);
      if (summarySent) console.log(`[AutoOptimize] Bill summary sent for Order #${key} -> ${summarySend.customerId}`);
    } catch (summaryErr) {
      console.warn('[AutoOptimize] Bill summary skipped:', summaryErr?.message || summaryErr);
    }

    order = getDb().orders?.[key] || order;
    await updateOrderCards(order).catch(() => {});
    if (summarySent) await ensureBossBillSummary(order).catch(() => {});

    console.log(
      `[AutoOptimize] Order #${key} ready: account ${order.orderAccount || order.selectedAccount}, ` +
      `coupon ${order.couponCode || 'none'}, To Pay ₹${order.finalPayable || 0}` +
      `${summarySent ? ', bill summary sent' : ''}`
    );
    return { success: true, order, summarySent };
  } catch (err) {
    console.error(`[AutoOptimize] Order #${key} crashed:`, err?.stack || err?.message || err);
    try {
      const db = getDb();
      const order = db.orders?.[key];
      if (order) {
        order.cardStage = 'PENDING';
        order.autoOptimizeError = err?.message || 'Auto offer scan failed.';
        saveDb(db);
        await updateOrderCards(order).catch(() => {});
      }
    } catch (e) {}
    return { success: false, error: err?.message || String(err) };
  } finally {
    autoOptimizeInFlight.delete(key);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendSafeHtml(ctx, text, extra = {}) {
  const maxLen = 3800;
  if (!text || text.length <= maxLen) {
    if (ctx && typeof ctx.reply === 'function') {
      return ctx.reply(text, { parse_mode: 'HTML', ...extra });
    } else {
      const chatId = ctx?.chat?.id || ctx;
      return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
    }
  }

  const parts = text.split('\n\n');
  const chunks = [];
  let cur = '';
  for (const part of parts) {
    if ((cur + '\n\n' + part).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = part;
    } else {
      cur = cur ? cur + '\n\n' + part : part;
    }
  }
  if (cur) chunks.push(cur);

  let lastMsg = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const opts = { parse_mode: 'HTML', ...(isLast ? extra : {}) };
    if (ctx && typeof ctx.reply === 'function') {
      lastMsg = await ctx.reply(chunks[i], opts);
    } else {
      const chatId = ctx?.chat?.id || ctx;
      lastMsg = await bot.telegram.sendMessage(chatId, chunks[i], opts);
    }
  }
  return lastMsg;
}

// Safe helper specifically for boss/user order cards (inline keyboards + long text)
async function sendCardSafe(chatIdOrCtx, card) {
  const { text, keyboard } = card;
  const isCtx = chatIdOrCtx && typeof chatIdOrCtx.reply === 'function';
  const safeTxt = text && text.length > 3800
    ? text.slice(0, 3740) + '\n\n<i>…(truncated)</i>'
    : text;
  if (isCtx) {
    return chatIdOrCtx.reply(safeTxt, { parse_mode: 'HTML', ...keyboard });
  }
  return bot.telegram.sendMessage(chatIdOrCtx, safeTxt, { parse_mode: 'HTML', ...keyboard });
}

async function sendPendingOrdersToBoss(bossId) {
  const db = getDb();
  const { header, cards } = buildBossPendingList(db);

  if (cards.length === 0) {
    await bot.telegram.sendMessage(bossId, '○ <i>No pending requests right now.</i>', { parse_mode: 'HTML' });
    return;
  }

  await bot.telegram.sendMessage(bossId, header, { parse_mode: 'HTML' });
  for (const card of cards) {
    await sendCardSafe(bossId, card);
  }
}

bot.action('boss_view_pending', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await sendPendingOrdersToBoss(ctx.from.id);
});

// View all Cancelled & Rejected Orders with full details
async function showCancelledOrders(ctx) {
  const db = getDb();
  const allOrders = Object.values(db.orders || {});
  const cancelledOrders = allOrders
    .filter(o => o.status === 'CANCELLED' || o.status === 'REJECTED')
    .sort((a, b) => new Date(b.cancelledAt || b.rejectedAt || b.createdAt || 0) - new Date(a.cancelledAt || a.rejectedAt || a.createdAt || 0));

  if (cancelledOrders.length === 0) {
    const emptyText = `× <b>Koi bhi Cancelled Order nahi mila!</b>\n\nAbhi tak koi order cancel ya reject nahi hua hai.`;
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('← Back to Panel', 'boss_refresh')]])
      }).catch(async () => {
        await ctx.reply(emptyText, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
      });
    }
    return ctx.reply(emptyText, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }

  // Show latest 10 cancelled orders
  const displayOrders = cancelledOrders.slice(0, 10);
  let text = section('× Cancelled Orders List', [
    field('Showing', `${displayOrders.length} of ${cancelledOrders.length}`),
  ]);

  for (const o of displayOrders) {
    const userProfileUrl = `tg://user?id=${o.userId}`;
    const userLink = `<a href="${userProfileUrl}">${esc(o.userName || 'Customer')}</a>`;
    const idLink = `<a href="${userProfileUrl}">${o.userId}</a>`;
    const timeStr = new Date(o.cancelledAt || o.rejectedAt || o.createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rest = o.restaurantName || o.restaurant || 'N/A';
    const amt = o.finalPayable || o.amount || 0;

    const orderRows = [
      ['Order', `#${o.id} [${o.status}]`],
      ['Customer', `${userLink} (<code>${o.userId}</code>)`],
      ['Restaurant', esc(rest)],
      ['Amount', `₹${amt}`],
      ['Cancelled At', timeStr],
    ];
    if (o.cart) orderRows.push(['Cart', `<a href="${esc(o.cart)}">Open Cart Link</a>`]);
    if (o.address) orderRows.push(['Address', o.address.startsWith('http') ? `<a href="${esc(o.address)}">Open Address Link</a>` : `<code>${esc(o.address)}</code>`]);

    text += section(`▣ Order #${o.id} [${o.status}]`, table(orderRows));
  }

  const buttons = [
    [
      Markup.button.callback('↻ Refresh List', 'boss_view_cancelled_orders'),
      Markup.button.callback('← Back to Panel', 'boss_refresh')
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (e) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    }
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard(buttons)
    });
  }
}

bot.action('boss_view_cancelled_orders', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showCancelledOrders(ctx);
});

bot.hears(['Cancelled Orders', '× Cancelled Orders', 'cancelled orders', '/cancelled'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showCancelledOrders(ctx);
});

// ================= SUCCESS ORDERS ARCHIVE =================

async function showSuccessOrdersArchive(ctx, selectedDate = null) {
  const db = getDb();
  const completedOrders = Object.values(db.orders || {})
    .filter(o => o.status === 'COMPLETED')
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  if (completedOrders.length === 0) {
    const emptyText = `★ <b>Success Orders Archive</b>\n\n<i>Abhi tak koi successful order nahi hai.</i>`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback('← Back to Panel', 'boss_refresh')]]);
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyText, { parse_mode: 'HTML', ...kb }).catch(() => ctx.reply(emptyText, { parse_mode: 'HTML', ...kb }));
    }
    return ctx.reply(emptyText, { parse_mode: 'HTML', ...kb });
  }

  // Group by Date string DD-MM-YYYY
  const dateMap = {};
  for (const o of completedOrders) {
    const dt = new Date(o.completedAt || o.createdAt || Date.now());
    const dStr = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
    if (!dateMap[dStr]) dateMap[dStr] = [];
    dateMap[dStr].push(o);
  }

  const today = new Date();
  const todayStr = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
  const yest = new Date(Date.now() - 86400000);
  const yestStr = `${String(yest.getDate()).padStart(2, '0')}-${String(yest.getMonth() + 1).padStart(2, '0')}-${yest.getFullYear()}`;

  // If no date selected yet, ask "Which date of history do you wanna see?"
  if (!selectedDate) {
    const totalVolume = completedOrders.reduce((s, o) => s + (o.finalPayable || 0), 0);
    let text = section('★ Success Orders Archive', [
      sub('Which date of history do you wanna see?'),
      field('Total Completed Orders', `<code>${completedOrders.length}</code>`),
      field('Total Lifetime Volume', `<code>₹${totalVolume}</code>`),
      sub('Neeche diye gaye dates me se choose karein:'),
    ].join('\n'));

    const buttons = [];
    const dateKeys = Object.keys(dateMap).sort().reverse();
    for (const dKey of dateKeys) {
      let label = `◷ ${dKey} (${dateMap[dKey].length} orders)`;
      if (dKey === todayStr) label = `◷ Today (${dKey}) [${dateMap[dKey].length}]`;
      else if (dKey === yestStr) label = `◷ Yesterday (${dKey}) [${dateMap[dKey].length}]`;
      buttons.push([Markup.button.callback(label, `boss_archive_date_${dKey}`)]);
    }
    buttons.push([Markup.button.callback(`◎ All Dates (${completedOrders.length} orders)`, 'boss_archive_date_all')]);
    buttons.push([Markup.button.callback('← Back to Panel', 'boss_refresh')]);

    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  // Display orders for the selected date
  const ordersToShow = selectedDate === 'all' ? completedOrders : (dateMap[selectedDate] || []);
  const title = selectedDate === 'all' ? 'All Dates' : selectedDate;
  const totalRev = ordersToShow.reduce((s, o) => s + (o.finalPayable || 0), 0);

  let text = `★ <b>Success Orders Archive — ${title}</b>\n` +
    `▤ <b>Total Orders:</b> ${ordersToShow.length} | ₹ <b>Total Volume:</b> ₹${totalRev}\n\n`;

  ordersToShow.slice(0, 10).forEach((o, idx) => {
    const accName = o.selectedAccount ? (db.config.accounts?.[o.selectedAccount]?.name || o.selectedAccount) : 'Default';
    const timeStr = new Date(o.completedAt || o.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const itemsStr = o.items && o.items.length ? o.items.map(i => `${esc(i.name)} x${i.qty || 1}`).join(', ') : 'Swiggy Food Items';
    text += section(`#${idx + 1}. [ #${o.id} ] — ₹${o.finalPayable || 0}`, [
      field('Customer', `<a href="tg://user?id=${o.userId}">${esc(o.userName || 'Customer')}</a> (<code>${o.userId}</code>)`),
      field('Restaurant', esc(o.restaurantName || 'Swiggy')),
      field('Items', esc(itemsStr)),
      field('Account', esc(accName)),
      field('Completed', timeStr),
    ].join('\n'));
  });

  if (ordersToShow.length > 10) {
    text += `<i>...and ${ordersToShow.length - 10} more orders.</i>\n`;
  }

  const buttons = [
    [Markup.button.callback('◷ Choose Another Date', 'boss_view_archive')],
    [Markup.button.callback('← Back to Panel', 'boss_refresh')]
  ];

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.action('boss_view_archive', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showSuccessOrdersArchive(ctx);
});

bot.action(/^boss_archive_date_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const dateKey = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  await showSuccessOrdersArchive(ctx, dateKey);
});

bot.hears(['Success Archive', '★ Success Archive', 'success archive', '/archive', 'Archive'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showSuccessOrdersArchive(ctx);
});

// ================= COMMANDS =================

bot.start(async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  delete userWaitState[userId];

  const welcomeText = `🙏 <b>Assalamu Alaikum!</b> Seedha <b>Cart</b> aur <b>Address link</b> bhejein 👇`;

  // A new user must ALWAYS get a working screen. Any helper failure below is
  // contained here so /start can never surface an UNEXPECTED_ERROR to the user.
  try {
    if (isBoss(userId)) {
      await ctx.reply(`★ Welcome back, <b>Boss</b>! Swiggy Family Care Admin Mode is active.`, {
        parse_mode: 'HTML',
        ...getBossReplyKeyboard()
      });
      try {
        const home = getBossPanelHome();
        await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
        await sendPendingOrdersToBoss(userId);
      } catch (panelErr) {
        console.error('[START] boss panel render failed:', panelErr?.stack || panelErr?.message || panelErr);
      }
      return;
    }

    const draft = getDraft(userId);
    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      ...getUserReplyKeyboard(draft)
    });

    try {
      const screen = getUserScreen(userId, ctx.from);
      const screenMsg = await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
      rememberUserCard(userId, screenMsg);
    } catch (screenErr) {
      console.error('[START] user screen render failed:', screenErr?.stack || screenErr?.message || screenErr);
      await ctx.reply('🟠 <b>Cart</b> ya <b>Address link</b> bhejein 👇', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          { text: '🟠 🛒 Cart Link', callback_data: 'action_add_cart', style: 'danger' },
          { text: '🟠 📍 Address Link', callback_data: 'action_add_address', style: 'danger' }
        ]])
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[START] handler failed:', err?.stack || err?.message || err);
    try {
      await ctx.reply(welcomeText, { parse_mode: 'HTML', ...getUserReplyKeyboard() });
    } catch (e2) {
      console.error('[START] fallback reply failed:', e2?.message || e2);
    }
  }
});

bot.command('help', async (ctx) => {
  const isBossUser = isBoss(ctx.from?.id);
  const text =
    `🍽 <b>Order Kaise Karein</b>\n\n` +
    `1. 🟠 <b>Cart Link</b> bhejein\n` +
    `2. 🟠 <b>Address Link</b> (ya Location) bhejein\n` +
    `3. 🚀 <b>Send to Beta</b> dabayein` +
    (isBossUser ? `\n\n★ Boss: <code>/boss</code> panel · <code>/parallel</code> ready orders.` : '');
  return ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[
      { text: '🟠 🛒 Cart Link', callback_data: 'action_add_cart', style: 'danger' },
      { text: '🟠 📍 Address Link', callback_data: 'action_add_address', style: 'danger' }
    ]])
  });
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  delete userWaitState[userId];
  clearDraft(userId);
  if (isBoss(userId)) {
    const home = getBossPanelHome();
    return ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  }
  return ctx.reply('✖ <b>Draft clear ho gaya.</b> Naya link bhejein 👇', {
    parse_mode: 'HTML',
    ...getUserReplyKeyboard()
  });
});

bot.command(['boss', 'admin'], async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.trim().split(' ');
  const password = args[1];

  // Return Telegram buttons immediately; collect order inputs in chat.

  if (isBoss(userId)) {
    delete userWaitState[userId];
    await ctx.reply(`★ <b>Boss Mode Activated</b>`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  if (password === BOSS_SECRET) {
    addBoss(userId);
    await ctx.reply(`✓ <b>Authorization successful!</b>`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  await ctx.reply(`× <b>Access Denied:</b> Reserved for Boss only.`, { parse_mode: 'HTML' });
});

// ================= UPI ID CONFIGURATION =================

bot.command('setupi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    const db = getDb();
    const cur = db.config?.bossUpiId || 'swiggy@icici';
    return ctx.reply(`₹ Current Payment UPI ID: <code>${cur}</code>\n\nChange with: <code>/setupi yourname@upi</code>`, { parse_mode: 'HTML' });
  }
  const newUpi = parts[1].trim();
  const db = getDb();
  db.config.bossUpiId = newUpi;
  saveDb(db);
  await ctx.reply(`✓ <b>Payment UPI ID updated to:</b> <code>${newUpi}</code>\nAb se generated QR par payment seedha is ID par aayega!`, { parse_mode: 'HTML' });
});

bot.action('boss_prompt_set_upi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
  const db = getDb();
  const cur = db.config?.bossUpiId || 'swiggy@icici';
  await ctx.reply(
    `₹ <b>Enter your UPI ID (VPA):</b>\n\nCurrent: <code>${cur}</code>\n\n<i>Chat me apna UPI ID likh kar bhejein (jaise 9876543210@paytm ya yourname@okhdfcbank):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' }
    }
  );
});

// ================= SWIGGY IN-BOT OTP LOGIN =================

bot.hears('◈ Login Swiggy Account', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await handlePromptLogin(ctx);
});

bot.action('boss_prompt_login', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await handlePromptLogin(ctx);
});

async function handlePromptLogin(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('Connected Accounts', 'boss_view_accounts'),
      Markup.button.callback('Export Session JSON', 'boss_export_picker')
    ],
    [
      Markup.button.callback('Main Menu', 'boss_panel_home'),
      Markup.button.callback('Close', 'close_menu')
    ]
  ]);

  const text = `<b>Swiggy Account Access & Login Manager:</b>\n\n` +
    `• <b>Login with JSON:</b> Session / Cookie JSON paste karein\n` +
    `• <b>Login with Number:</b> Mobile number se instant OTP aayega`;

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

// Helper to prompt for phone number with Auto-Keyboard Popup
async function promptBossLoginWithNumber(ctx) {
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_phone_for_number_login' };

  await ctx.reply(
    `<b>Login with Number</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Main Menu', callback_data: 'boss_panel_home' },
            { text: 'Close', callback_data: 'close_menu' }
          ]
        ]
      }
    }
  );

  await ctx.reply('› Enter 10-digit Mobile Number:', {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: '10 digits, or 91 + 10 digits...'
    }
  });
}

// 1. Login with JSON Prompt
bot.action('boss_login_with_json', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `<b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

// 2. Login with Number Prompt
bot.action('boss_login_with_number', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await promptBossLoginWithNumber(ctx);
});

// 2.1 Direct Send to Another Number
bot.action('send_to_another_number', async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  await ctx.answerCbQuery().catch(() => {});
  await promptBossLoginWithNumber(ctx);
});

// 2.2 Cancel OTP Login Action -> Closes prompt cleanly and restores reply keyboard
bot.action(['cancel_otp_login', 'close_menu', 'action_close', 'cancel_menu'], async (ctx) => {
  const userId = ctx.from.id;
  const prevState = userWaitState[userId];
  delete userWaitState[userId];
  if (prevState?.targetAcc) {
    deactivateSwiggyAccountViaBridge(userId, prevState.targetAcc, false).catch(() => {});
    // If Boss created an empty unlogged placeholder slot and cancelled before entering a phone/session, clean it up so the name stays reusable!
    if (prevState.createdFreshSlot) {
      const acc = getDb().config?.accounts?.[prevState.targetAcc];
      if (acc && !isAccountLoggedInSession(acc) && !acc.phone) {
        deleteAccount(prevState.targetAcc, { purgeVault: false });
      }
    }
  }
  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.deleteMessage();
  } catch (e) {
    try {
      await ctx.editMessageText('Closed.');
    } catch (e2) {}
  }
  if (isBoss(userId)) {
    await ctx.reply('Closed.', getBossReplyKeyboard());
  } else {
    await ctx.reply('Closed.', getUserReplyKeyboard());
  }
});

// 2.3 Resend OTP Action
bot.action(/^resend_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery(`Resending OTP to ${phone}...`).catch(() => {});
  const db = getDb();
  const previousState = userWaitState[userId];
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === phone);
  const existingKey = existing ? existing[0] : (previousState?.targetAcc || `acc_${phone}`);
  const existingName = existing?.[1]?.name || previousState?.name || null;

  const result = await requestSwiggyOtpViaBridge(userId, phone, existingKey, existingName);
  if (result.success) {
    userWaitState[userId] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc: existingKey,
      phone,
      name: existingName
    };
    await ctx.reply(
      otpSentCard(phone, [`› <i>6-digit OTP yahan type karein:</i>`]),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Copy Number', copy_text: { text: phone } }
            ],
            [
              { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}` },
              { text: 'Resend OTP', callback_data: `resend_otp_${phone}` }
            ],
            [
              { text: 'Another Number', callback_data: 'send_to_another_number' },
              { text: 'Main Menu', callback_data: 'boss_panel_home' }
            ],
            [
              { text: 'Close', callback_data: 'close_menu' }
            ]
          ]
        }
      }
    );
    await ctx.reply('› Enter OTP:', {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter 6-digit OTP...'
      }
    });
  } else {
    const errCard = formatOtpSendErrorCard(phone, result);
    await ctx.reply(errCard.text, {
      parse_mode: 'HTML',
      ...errCard.keyboard
    });
  }
});

// 2.4 Re-enter OTP Action
bot.action(/^prompt_reenter_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery('Ready for OTP...').catch(() => {});

  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === phone);
  const existingKey = existing ? existing[0] : `acc_${phone}`;
  const existingName = existing ? (existing[1]?.name || existing[0]) : null;

  const prevOrderId = userWaitState[userId]?.orderId || null;

  userWaitState[userId] = {
    action: 'waiting_swiggy_otp_bridge',
    targetAcc: existingKey,
    phone,
    name: existingName,
    orderId: prevOrderId
  };

  await ctx.reply(
    `↻ <b>Re-enter OTP for <code>${phone}</code>:</b>\n\n` +
    `› Kripya sahi 6-digit OTP type karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter 6-digit OTP...'
      }
    }
  );
});

// Process JSON / Cookie login (single account, Cookie-Editor array, OR multi-account `accounts.json` batch!),
// verifying live against BOTH Swiggy Web DAPI (`_session_tid`) AND Swiggy Native Android (`chkout` + `profile` token sessions)!
async function handleProcessJsonLogin(ctx, rawJson, userId, targetKeyOverride = null, orderIdOverride = null) {
  const prevState = userWaitState[userId] || {};
  const finalTargetKey = targetKeyOverride || prevState.targetAcc || null;
  const finalOrderId = orderIdOverride || prevState.orderId || null;
  delete userWaitState[userId];

  const extractedList = extractSwiggyAccountsListFromInput(rawJson);
  if (!extractedList.length) {
    return ctx.reply('! Invalid JSON format. Kripya valid Swiggy Session JSON, Cookie string, ya .json/.txt file bhejein.');
  }

  // Multi-account JSON array (`accounts.json` / `[ {...}, {...} ]`) — verify & permanently save ALL active accounts to Vault!
  if (extractedList.length > 1) {
    const statusMsg = await ctx.reply(
      `◷ <i>${extractedList.length} Swiggy accounts verify hokar Permanent Vault me save ho rahe hain...</i>`,
      { parse_mode: 'HTML' }
    );
    const bulkRes = await ingestAndPersistRawAccountTexts([
      { fileName: 'multi_accounts.json', text: typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson) }
    ]);
    try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return sendSafeHtml(ctx, formatBulkVaultImportSummaryHtml(bulkRes, extractedList.length), getBossPanelKeyboard());
  }

  // Single account session JSON (supports Web `_session_tid`, hex-`tid`, Python/Android `{ tid, token, sid, deviceId }`, Cookie-Editor, etc.)
  const parsed = extractedList[0];
  const dbCheck = getDb();
  const hintPhone = parsed.phone || '';
  const vaultFallback = (hintPhone && dbCheck.sessionVault?.[hintPhone]) || (finalTargetKey && dbCheck.sessionVault?.[finalTargetKey]) || null;

  let rawCookieStr = parsed.cookies || '';
  if ((!rawCookieStr || !rawCookieStr.includes('_session_tid=')) && vaultFallback?.cookies?.includes('_session_tid=')) {
    rawCookieStr = `${vaultFallback.cookies}; ${rawCookieStr}`;
  }
  const cookieStr = cleanEssentialSwiggyCookies(rawCookieStr, parsed);
  if (!cookieStr && !parsed.tid && !parsed.token) {
    return ctx.reply('! Invalid session: Isme Swiggy cookies, tid ya token nahi mila.');
  }

  const statusMsg = await ctx.reply('◷ <i>Swiggy session live verify ho raha hai (Web + Native App engine)...</i>', { parse_mode: 'HTML' });

  const liveCheck = await verifySwiggySessionLive({
    ...parsed,
    cookies: cookieStr
  });

  if (!liveCheck?.valid) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return ctx.reply(
      `× <b>Swiggy Session Genuinely Expired!</b>\n\n` +
      `Swiggy Web + Native Android dono servers par live check kiya gaya — Swiggy ne bataya: <code>${escapeHtml(liveCheck?.androidMessage || liveCheck?.webMessage || 'Session expired')}</code>.\n\n` +
      `› <b>Kripya Mobile Number + OTP se fresh login karein ya active Swiggy JSON bhejein!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            ...(hintPhone.length === 10
              ? [Markup.button.callback(`◈ Login ${hintPhone} via OTP`, `relogin_phone_${hintPhone}`)]
              : [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')])
          ],
          [Markup.button.callback('⌂ Main Menu', 'boss_panel_home')]
        ])
      }
    );
  }

  const liveTid = liveCheck.liveTid || parsed.tid || '';
  const liveToken = liveCheck.token || parsed.token || '';
  const liveCustomerId = liveCheck.customerId || parsed.customerId || '';
  const finalCookieStr = liveCheck.cookies || cookieStr;

  // 1. Fetch real profile from Swiggy if not already resolved by native profile endpoint
  const profile = (liveCheck.name && liveCheck.phone)
    ? { id: liveCustomerId, name: liveCheck.name, phone: liveCheck.phone }
    : await fetchSwiggyProfileFromCookies({ ...parsed, tid: liveTid, token: liveToken, customerId: liveCustomerId, cookies: finalCookieStr }).catch(() => ({ name: null, phone: null }));
  const cleanPhone = (profile?.phone || hintPhone ? String(profile?.phone || hintPhone).replace(/[^0-9]/g, '').slice(-10) : '');
  const swiggyName = profile?.name || parsed?.swiggyName || parsed?.name || (cleanPhone ? `User ${cleanPhone}` : 'Swiggy User');
  const accKey = finalTargetKey || (cleanPhone ? `acc_${cleanPhone}` : (parsed?.account || 'acc_' + Date.now()));

  // 2. Import complete session into database + vault (preserving freshly minted/existing `_session_tid`!)
  const result = importSessionJson({
    ...parsed,
    tid: liveTid,
    token: liveToken,
    customerId: liveCustomerId || profile?.id || parsed?.customerId || '',
    name: swiggyName,
    swiggyName,
    phone: cleanPhone,
    cookies: finalCookieStr
  }, accKey);

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}

  if (result.success) {
    const savedKey = result.account || result.key || accKey;
    const claimWait = await ctx.reply('◷ <i>Swiggy Breakfast &amp; Late Night ₹50 OFF offers lock ho rahe hain...</i>', { parse_mode: 'HTML' });
    const offersResult = await Promise.race([
      claimSwiggyBreakfastAndLateNightOffers({
        id: savedKey,
        phone: cleanPhone,
        token: liveToken || liveTid,
        tid: liveTid,
        cookies: finalCookieStr
      }, { quickLockOnly: true }),
      new Promise(resolve => setTimeout(() => resolve({ success: false, pendingBackgroundLock: true }), 2400))
    ]);
    try { await bot.telegram.deleteMessage(ctx.chat.id, claimWait.message_id); } catch (e) {}

    const db = getDb();
    if (db.config.accounts?.[savedKey]) {
      db.config.accounts[savedKey].offers = offersResult;
      saveDb(db);
    }
    syncCloudVaultNow(db).catch(() => {});

    await sendAccountLoginAndOffersCard(ctx, {
      accountKey: savedKey,
      targetAcc: savedKey,
      name: db.config.accounts?.[savedKey]?.name || swiggyName,
      swiggyName,
      phone: cleanPhone,
      customerId: liveCustomerId || profile?.id || result.customerId || 'Verified',
      exportJson: exportSessionJson(savedKey),
      offers: offersResult
    }, ctx.from.id, finalOrderId);
  } else {
    await ctx.reply(`× <b>Import Failed:</b> ${escapeHtml(result.message || '')}`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }
}

// Sends the instant claiming confirmation & detailed offers card with 1-Click FULL Code Copy
async function sendAccountLoginAndOffersCard(ctx, accInfo, userId, orderId) {
  const targetAcc = accInfo.accountKey || accInfo.targetAcc || `acc_${accInfo.phone}`;
  const displayName = accInfo.name || targetAcc;
  const swiggyName = accInfo.swiggyName || '';
  const botTag = accInfo.botTag || '';
  const phone = accInfo.phone || accInfo.mobile || '';
  const customerId = accInfo.customerId || 'Verified';

  const db = getDb();
  if (!db.config.activeOrderAccount || !db.config.accounts?.[db.config.activeOrderAccount]?.isLoggedIn) {
    db.config.activeOrderAccount = targetAcc;
    saveDb(db);
  }
  if (orderId && db.orders[orderId]) {
    const order = db.orders[orderId];
    order.selectedAccount = targetAcc;
    saveDb(db);
    updateOrderCards(order).catch(() => {});
  }

  const exported = exportSessionJson(targetAcc) || accInfo.exportJson || db.config?.accounts?.[targetAcc];
  const sessionJsonStr = exported ? JSON.stringify(exported, null, 2) : '';
  const compactStr = exported ? JSON.stringify(exported) : '';

  const offers = accInfo.offers || {};
  const lateNight = offers.lateNight || { status: 'CLAIMED', discount: '50 off on 199' };
  const breakfast = offers.breakfast || { status: 'CLAIMED', discount: '50 off on 199' };
  const isLateNightClaimed = lateNight.status === 'CLAIMED';
  const isBreakfastClaimed = breakfast.status === 'CLAIMED';
  const bothClaimed = isLateNightClaimed && isBreakfastClaimed;

  const lateNightStatusText = isLateNightClaimed
    ? `✓ <code>CLAIMED</code> (50 off on 199)${lateNight.message ? ` — <i>${escapeHtml(lateNight.message)}</i>` : ''}`
    : `× <code>CLAIM FAILED</code>${lateNight.message ? ` (<i>${escapeHtml(lateNight.message)}</i>)` : ''}`;
  const breakfastStatusText = isBreakfastClaimed
    ? `✓ <code>CLAIMED</code> (50 off on 199)${breakfast.message ? ` — <i>${escapeHtml(breakfast.message)}</i>` : ''}`
    : `× <code>CLAIM FAILED</code>${breakfast.message ? ` (<i>${escapeHtml(breakfast.message)}</i>)` : ''}`;

  const headerTag = bothClaimed
    ? `<blockquote>! <b>SWIGGY CLAIMING SUCCESS</b></blockquote>`
    : `<blockquote>! <b>LOGIN COMPLETE — CLAIM PARTIAL</b></blockquote>`;

  const headerBody =
    `${headerTag}\n\n` +
    `☎ <b>Account Number:</b> <code>${phone}</code>\n` +
    (swiggyName ? `◉ <b>Swiggy Profile Name:</b> <b>${escapeHtml(swiggyName)}</b>\n` : '') +
    (botTag ? `# <b>Bot Tag / Slot:</b> <code>${escapeHtml(botTag)}</code>\n` : '') +
    (!swiggyName && !botTag ? `◉ <b>Account Name:</b> <b>${escapeHtml(displayName)}</b>\n` : '') +
    `# <b>Customer ID:</b> <code>${customerId}</code>\n\n` +
    `▣ <b>OFFERS STATUS:</b>\n` +
    `• ◷ <b>Swiggy Late Night:</b> ${lateNightStatusText}\n` +
    `• • <b>Swiggy Breakfast:</b> ${breakfastStatusText}\n\n` +
    (bothClaimed
      ? `● <b>Status:</b> Both offers active! 50 off on 199 available on food orders.\n\n`
      : `! <b>Status:</b> One or more offers could not be claimed. Retry claim below or manage account.\n\n`) +
    (orderId ? `⌖ <b>Order #${orderId} is linked to ${escapeHtml(displayName)}!</b>\n\n` : '');

  // Keep total message safely inside Telegram's 4096-char HTML message limit (zero truncation!)
  const codeToEmbed = (headerBody.length + sessionJsonStr.length + 140 <= 4050) ? sessionJsonStr : compactStr;
  const cardText =
    headerBody +
    (codeToEmbed ? `▤ <b>Full Session Code (${codeToEmbed.length} chars):</b>\n<pre><code class="language-json">${escapeHtml(codeToEmbed)}</code></pre>\n\n` : '') +
    `▣ <i>Account is saved in DB — tap <b>Copy Code</b> below to copy 100% FULL code!</i>`;

  const keyboardButtons = [];
  const copyRow = [];
  if (compactStr) {
    copyRow.push(makeFullSessionCopyButton(ctx, 'Copy Code', targetAcc, compactStr, `copy_code_${targetAcc}`, 'primary'));
  }
  if (phone) {
    copyRow.push({ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' });
  }
  if (copyRow.length > 0) keyboardButtons.push(copyRow);

  keyboardButtons.push([
    { text: '▣ Claim ₹50 Offers', callback_data: `boss_retry_claim_${targetAcc}`, style: 'success' },
    { text: '₹ Claim Free Cash', callback_data: `boss_check_fc_${targetAcc}`, style: 'success' }
  ]);

  keyboardButtons.push([
    { text: 'Export JSON File', callback_data: `boss_export_single_${targetAcc}`, style: 'primary' },
    { text: 'Previous Orders', callback_data: `boss_prev_orders_${targetAcc}`, style: 'primary' }
  ]);

  keyboardButtons.push([
    { text: 'Order with this Account', callback_data: `boss_use_acc_${targetAcc}`, style: 'success' },
    { text: '↗ Logout Account', callback_data: `boss_logout_single_${targetAcc}`, style: 'danger' }
  ]);

  keyboardButtons.push([
    { text: 'Add Another Account', callback_data: 'send_to_another_number', style: 'primary' },
    { text: 'Delete Account from Swiggy', callback_data: `boss_swiggy_delete_start_${targetAcc}`, style: 'danger' }
  ]);

  keyboardButtons.push([
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' },
    { text: 'Close', callback_data: 'close_menu', style: 'danger' }
  ]);

  await sendSafeHtml(ctx, cardText, { reply_markup: { inline_keyboard: keyboardButtons } });
}

// Action: Previous orders from login card or account card
bot.action(/^boss_prev_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Fetching previous orders from Swiggy... ◷').catch(() => {});
  const key = ctx.match[1];
  await handlePreviousOrders(ctx, key);
});

// Action: Boss Main Menu / Boss Panel Home & Refresh
bot.action(['boss_panel_home', 'boss_refresh'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const home = getBossPanelHome();
  try {
    await ctx.editMessageText(home.text, { parse_mode: 'HTML', ...home.keyboard });
  } catch (e) {
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  }
});

// ---------------------------------------------------------------------------
// BOSS DASHBOARD — order id + live tracking + the phone that placed it
// ---------------------------------------------------------------------------
async function renderBossDashboard(ctx, { onlyMissingTracking = false, limit = 8 } = {}) {
  const view = buildBossDashboard(getDb(), { limit, onlyMissingTracking });
  try {
    await ctx.editMessageText(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
  } catch {
    await ctx.reply(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
  }
  return view;
}

bot.action('boss_dashboard', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Dashboard refreshed').catch(() => {});
  await renderBossDashboard(ctx);
});

bot.command(['dashboard', 'tracking_dashboard'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const view = buildBossDashboard(getDb(), { limit: 10 });
  await ctx.reply(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
});

bot.action(/^boss_track_now_([A-Za-z0-9_-]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Scanning Swiggy IDs for the live share link…').catch(() => {});

  const result = await ensureOrderTracking(orderId, { force: true, budgetMs: 22000, deep: true });
  const fresh = getDb().orders?.[orderId] || order;
  const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
  const swiggyId = swiggyOrderIdOf(fresh);
  const phone = placedFromPhoneOf(fresh, getDb());

  let text;
  const rawLiveStatusStr = String(fresh.liveOrderStatus || result?.orderStatus || '');
  const liveStatusStr = normalizeSwiggyLiveOrderStatus(rawLiveStatusStr) || rawLiveStatusStr;
  const isCancelledStatus = /cancel|refus|return/i.test(liveStatusStr);
  const isDeliveredStatus = !isCancelledStatus && /deliv/i.test(liveStatusStr);
  const deliveredTrackUrl = !trackingUrl && isDeliveredStatus ? buildSignedOrderTrackUrl(swiggyId || fresh.id) : '';
  if (trackingUrl) {
    text = `✅ <b>Tracking found</b>\n` +
      `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
      `▪ <b>Order ref:</b> <code>#${escapeHtml(String(fresh.id))}</code>\n` +
      `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
      (liveStatusStr ? `▪ <b>Status:</b> <code>${escapeHtml(liveStatusStr)}</code>\n` : '') +
      `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open live Swiggy tracking</a>` +
      (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '');
  } else if (result?.status === 'NO_SWIGGY_ID') {
    text = `⏳ <b>Swiggy order id abhi create nahi hua.</b>\nPayment confirm hote hi bot khud tracking laayega — kuch karne ki zaroorat nahi.`;
  } else if (result?.status === 'ORDER_FOUND' && isCancelledStatus) {
    text = `✅ <b>Order Swiggy par mil gaya</b> (<code>${escapeHtml(swiggyId || '')}</code> on <code>${escapeHtml(phone || '—')}</code>) — status <code>${escapeHtml(liveStatusStr)}</code>.\n\n<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`;
  } else if (result?.status === 'ORDER_FOUND' && isDeliveredStatus) {
    text = `✅ <b>Tracking link ready</b>\n` +
      `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
      `▪ <b>Order ref:</b> <code>#${escapeHtml(String(fresh.id))}</code>\n` +
      `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
      `▪ <b>Status:</b> <code>${escapeHtml(liveStatusStr)}</code>\n` +
      (deliveredTrackUrl ? `▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredTrackUrl)}">Open order tracking</a>` : '') +
      (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '') +
      (fresh.deliveryBoyName || fresh.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([fresh.deliveryBoyName, fresh.deliveryBoyMobile].filter(Boolean).join(' · '))}` : '');
  } else if (result?.status === 'ORDER_FOUND') {
    text = `✅ <b>Order Swiggy par mil gaya</b> (<code>${escapeHtml(swiggyId || '')}</code> on <code>${escapeHtml(phone || '—')}</code>) — lekin Swiggy ne share link abhi publish nahi kiya.\n\n<i>Bot har 10s–30s me retry karta rahega aur link aate hi bhej dega.</i>`;
  } else if (result?.status === 'TIMEOUT') {
    text = `◷ <b>Scan time out ho gaya</b> (${Number(result.scanned) || 0} IDs checked).\nSwiggy slow hai — dobara try karein. Koi fake link nahi banaya jayega.`;
  } else {
    text = `❌ <b>Swiggy order <code>${escapeHtml(swiggyId || '')}</code> kisi bhi ID par nahi mila.</b>\n\nCheck karein ki order ID sahi hai (numeric, 12–18 digits). Bot koi false tracking link nahi banata.`;
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(trackingUrl
      ? Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy tracking', trackingUrl)]])
      : (!isCancelledStatus && result?.status === 'ORDER_FOUND'
        ? Markup.inlineKeyboard([
            ...(deliveredTrackUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredTrackUrl)]] : []),
            [Markup.button.callback('🔄 Re-check Tracking', `boss_track_now_${fresh.id}`)]
          ])
        : {}))
  }).catch(() => {});

  if (!trackingUrl && !isTerminalDeliveryStatus(liveStatusStr) && ['ORDER_FOUND', 'TIMEOUT'].includes(result?.status)) {
    startOrderTrackingAuto(fresh.id, { force: true, budgetMs: 12000 });
  }
  if (ctx.callbackQuery?.message?.message_id) {
    await renderBossDashboard(ctx, { limit: 8 });
  }
});

bot.action('boss_fetch_all_missing', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Fetching tracking for orders that need it…').catch(() => {});

  const db = getDb();
  const pending = Object.values(db.orders || {})
    .filter(o => o && o.id && ['COMPLETED', 'ACCEPTED'].includes(o.status) && !getStoredSwiggyTrackingUrl(o) && swiggyOrderIdOf(o))
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))
    // Small batch: 4 orders × 10s keeps this button well inside the handler timeout.
    .slice(0, 4);

  if (pending.length === 0) {
    const confirmed = Object.values(db.orders || {})
      .filter(o => o && o.id && ['COMPLETED', 'ACCEPTED'].includes(String(o.status || '')) && swiggyOrderIdOf(o));
    const msg = confirmed.length === 0
      ? 'ℹ️ <b>Abhi koi confirmed Swiggy order nahi hai.</b>\n<i>Tracking fetch karne ke liye pehle order place/confirm hona chahiye.</i>'
      : `✅ <b>Sab ${confirmed.length} confirmed/delivered orders ke tracking link already available hain.</b>`;
    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  let found = 0;
  const failed = [];
  for (const order of pending) {
    const res = await ensureOrderTracking(order, { force: true, budgetMs: 12000, deep: true }).catch(() => null);
    if (res?.trackingUrl) {
      found += 1;
      try { await tryEditCustomerPaymentMessageWithTracking(getDb().orders?.[order.id] || order); } catch {}
    } else {
      failed.push(String(swiggyOrderIdOf(order) || order.id));
      startOrderTrackingAuto(order.id, { force: true, budgetMs: 12000 });
    }
  }

  await ctx.reply(
    `🔎 <b>Tracking scan complete</b>\n` +
    `▪ Found: <b>${found}</b>\n` +
    `▪ Still waiting on Swiggy: <b>${failed.length}</b>` +
    (failed.length ? `\n<code>${escapeHtml(failed.join(', '))}</code>\n\n<i>Bot background me retry karta rahega.</i>` : ''),
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await renderBossDashboard(ctx, { limit: 8 });
});

bot.command(['menu', 'panel'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  await ctx.reply('Boss Panel:', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Main Menu', 'Menu', 'Boss Panel', '⌂ Main Menu', '⌂ Boss Panel'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  await ctx.reply('Boss Panel:', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Close', 'close', '× Close'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (isBoss(ctx.from.id)) {
    await ctx.reply('Closed.', getBossReplyKeyboard());
  } else {
    await ctx.reply('Closed.', getUserReplyKeyboard());
  }
});

// Action: Use account for orders
bot.action(/^boss_use_acc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  if (db.config.accounts?.[accKey]) {
    db.config.activeOrderAccount = accKey;
    saveDb(db);
    await ctx.answerCbQuery(`Selected ${db.config.accounts[accKey].name || accKey} for orders! ✓`).catch(() => {});
    await ctx.reply(`● <b>Account "${escapeHtml(db.config.accounts[accKey].name || accKey)}" is now ACTIVE for all orders!</b>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  } else {
    await ctx.answerCbQuery('Account not found!').catch(() => {});
  }
});

// Action: Retry offer claims
bot.action(/^boss_retry_claim_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  await ctx.answerCbQuery('Retrying offer claims with Swiggy API... ◷').catch(() => {});
  const db = getDb();
  const acc = db.config.accounts?.[accKey];
  if (!acc) return ctx.reply('× Account not found.');

  const retryWait = await ctx.reply(`◷ <i>Swiggy Breakfast & Late Night offers claim request process ho rahi hai for <b>${escapeHtml(acc.name || accKey)}</b>...</i>`, { parse_mode: 'HTML' });
  const claimRes = await claimSwiggyBreakfastAndLateNightOffers(acc);
  acc.offers = claimRes;
  saveDb(db);
  try { await bot.telegram.deleteMessage(ctx.chat.id, retryWait.message_id); } catch (e) {}

  await sendAccountLoginAndOffersCard(ctx, {
    accountKey: accKey,
    name: acc.name,
    phone: acc.phone,
    customerId: acc.customerId,
    offers: acc.offers,
    exportJson: acc
  }, ctx.from.id, null);
});


// ================= ACCOUNT SELECTOR IN BOSS CARD =================

// ================= ACCOUNT SELECTOR IN BOSS CARD (FIGJAM FLOW) =================

// Screen 2 -> Open Account Picker
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const db = getDb();
  const accounts = db.config.accounts || {};
  const buttons = [];
  const accEntries = Object.entries(accounts);

  if (accEntries.length === 0) {
    buttons.push([
      Markup.button.callback('◈ Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('☎ Login with Number', 'boss_login_with_number')
    ]);
  } else {
    for (let i = 0; i < accEntries.length; i += 2) {
      const row = [];
      const [k1, a1] = accEntries[i];
      const m1 = a1.isLoggedIn ? '●' : '○';
      row.push(Markup.button.callback(`${m1} ${a1.name || k1}`, `boss_choose_acc_${k1}_${orderId}`));
      if (accEntries[i + 1]) {
        const [k2, a2] = accEntries[i + 1];
        const m2 = a2.isLoggedIn ? '●' : '○';
        row.push(Markup.button.callback(`${m2} ${a2.name || k2}`, `boss_choose_acc_${k2}_${orderId}`));
      }
      buttons.push(row);
    }
    buttons.push([
      Markup.button.callback('+ Login Another Account', 'boss_prompt_login')
    ]);
  }

  await ctx.reply(
    `◉ <b>Choose Account to order for #${escapeHtml(String(orderId))}:</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

// Account Chosen for Order -> Auto-parse cart & calculate bill
bot.action(/^(?:boss_sel_acc|boss_choose_acc)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let accKey = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.endsWith('_' + oid)) {
      orderId = oid;
      accKey = payload.slice(0, -(oid.length + 1));
      break;
    } else if (payload.startsWith(oid + '_')) {
      orderId = oid;
      accKey = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const candidateOid = payload.slice(lastUnderscore + 1);
      if (db.orders[candidateOid]) {
        orderId = candidateOid;
        accKey = payload.slice(0, lastUnderscore);
      }
    }
  }

  let order = lookupOrder(db, orderId);


  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.selectedAccount = accKey;
  order.amountAccepted = false;
  order.waitingConfirmation = false;
  saveDb(db);

  const accountData = db.config.accounts?.[accKey];
  const accName = accountData?.name || accKey;
  await ctx.answerCbQuery(`Selected: ${accName}! Calculating bill... ◷`).catch(() => {});

  // Fast verify Swiggy cart & items using account cookies or verified metadata
  try {
    const accountSession = accountData ? {
      token: accountData.token || null,
      tid: accountData.tid || null,
      sid: accountData.sid || null,
      deviceId: accountData.deviceId || null
    } : null;

    if (order.cart) {
      const swiggyData = await verifyAndInspectSwiggyLink(order.cart, accountData?.cookies, accountSession);
      if (swiggyData.verified || (swiggyData.items && swiggyData.items.length > 0)) {
        order.swiggyVerified = true;
        if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
        if (swiggyData.items && swiggyData.items.length > 0) order.items = swiggyData.items;
        if (swiggyData.subtotal > 0) order.subtotal = swiggyData.subtotal;
        if (swiggyData.itemTotal > 0) order.itemTotal = swiggyData.itemTotal;
        if (swiggyData.discountAmount > 0) order.discountAmount = swiggyData.discountAmount;
        if (swiggyData.couponCode) order.couponCode = swiggyData.couponCode;
        if (swiggyData.freeCashApplied > 0) order.freeCashApplied = swiggyData.freeCashApplied;
        if (swiggyData.swiggyOneMembershipFee > 0) order.swiggyOneMembershipFee = swiggyData.swiggyOneMembershipFee;
        if (swiggyData.packingCharges > 0) order.packingCharges = swiggyData.packingCharges;
        if (swiggyData.taxesAndCharges > 0) order.taxesAndCharges = swiggyData.taxesAndCharges;
        if (swiggyData.deliveryFee !== undefined) order.deliveryFee = swiggyData.deliveryFee;
        if (swiggyData.freeDeliveryDiscount !== undefined) order.freeDeliveryDiscount = swiggyData.freeDeliveryDiscount;
        if (swiggyData.swiggyOneApplied) order.swiggyOneApplied = true;
        if (swiggyData.finalPayable > 0) order.finalPayable = swiggyData.finalPayable;
        if (swiggyData.totalSavings > 0) order.totalSavings = swiggyData.totalSavings;
      }
    }
    if (order.address && !order.addressDetails) {
      const addrMeta = await resolveSwiggyLink(order.address);
      if (addrMeta.addressDetails) {
        order.addressDetails = addrMeta.addressDetails;
      }
    }
  } catch (err) {
    console.error('Error verifying cart for chosen account:', err.message);
  }

  saveDb(db);

  // Update in-place on single cards for Boss and User! (NO DUPLICATE MESSAGES)
  await updateOrderCards(order);
});

// Change Account Button on Order Card
bot.action(/^boss_change_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.selectedAccount = null;
  order.waitingConfirmation = false;
  order.status = 'PENDING';
  saveDb(db);

  await ctx.answerCbQuery('Choose a different account:').catch(() => {});
  await updateOrderCards(order);
});

// Send for Confirmation Button on Order Card
bot.action(/^boss_send_confirm_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.status = 'WAITING_CONFIRMATION';
  order.waitingConfirmation = true;
  order.sentForConfirmationAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('Sent for Confirmation to Customer! ›').catch(() => {});
  await updateOrderCards(order);

  // If user card message id is not set, deliver card to user
  if (order.userChatId && !order.userMessageId) {
    try {
      const userCard = formatUserOrderCard(order);
      const sent = await bot.telegram.sendMessage(order.userChatId, userCard.text, {
        parse_mode: 'HTML',
        ...userCard.keyboard
      });
      order.userMessageId = sent.message_id;
      saveDb(db);
    } catch (e) {}
  }
});

// Text User Button
bot.action(/^boss_text_user_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_text_user', orderId, targetUserId: order.userId };

  const userProfileUrl = `tg://user?id=${order.userId}`;
  await ctx.reply(
    `✉ <b>Send message to <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (Order #${orderId}):</b>\n\n` +
    `# <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n\n` +
    `<i>Chat me message likh kar bhejein ya upar TG ID par click karke direct profile kholein:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Type message for user...' }
    }
  );
});

// Dynamic Account Picker on Order Card
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  const accounts = db.config.accounts || {};

  const buttons = [];
  const accEntries = Object.entries(accounts);

  for (let i = 0; i < accEntries.length; i += 2) {
    const row = [];
    const [k1, a1] = accEntries[i];
    const s1 = a1.isLoggedIn ? '●' : '○';
    const p1 = a1.phone || a1.mobile || a1.name || k1;
    row.push(Markup.button.callback(`${s1} ${p1}`, `boss_select_acc_${orderId}_${k1}`));

    if (accEntries[i + 1]) {
      const [k2, a2] = accEntries[i + 1];
      const s2 = a2.isLoggedIn ? '●' : '○';
      const p2 = a2.phone || a2.mobile || a2.name || k2;
      row.push(Markup.button.callback(`${s2} ${p2}`, `boss_select_acc_${orderId}_${k2}`));
    }
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback('+ Add New Account', `boss_add_new_acc_for_order_${orderId}`),
    Markup.button.callback('← Back to Order', `boss_back_to_order_${orderId}`)
  ]);

  await ctx.reply(
    `◉ <b>CHOOSE SWIGGY ACCOUNT FOR ORDER #${orderId}:</b>\n\n` +
    `Select the account to place this order with. (Swiggy offers, coupons & free delivery will be applied automatically):\n\n` +
    `<i>● = Logged In | ○ = Not Logged In</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Selecting Account for Order -> Runs Group Cart Sync, Coupon Optimizer & Displays Boss Review Screen
bot.action(/^boss_select_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let accKey = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.endsWith('_' + oid)) {
      orderId = oid;
      accKey = payload.slice(0, -(oid.length + 1));
      break;
    } else if (payload.startsWith(oid + '_')) {
      orderId = oid;
      accKey = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const candidateOid = payload.slice(lastUnderscore + 1);
      if (db.orders[candidateOid]) {
        orderId = candidateOid;
        accKey = payload.slice(0, lastUnderscore);
      }
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const idx = payload.indexOf('_');
    if (idx !== -1) {
      orderId = payload.slice(0, idx);
      accKey = payload.slice(idx + 1);
    }
  }

  let order = lookupOrder(db, orderId);


  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  const acc = db.config.accounts?.[accKey];
  const accPhone = acc?.phone || acc?.mobile || acc?.name || 'Selected Account';
  const accName = acc?.name || accPhone;

  order.selectedAccount = accKey;
  order.orderAccount = accPhone;
  order.paymentSentToUser = false; // NEVER directly send to customer before Boss review!
  saveDb(db);

  await ctx.answerCbQuery(`Selected ${accPhone}! Processing cart & capturing payment QR... ›`).catch(() => {});
  const waitMsg = await ctx.reply(
    `◷ <b>Processing Order #${orderId} on Swiggy Account: ${escapeHtml(accPhone)} (${escapeHtml(accName)})...</b>\n\n` +
    `1️⃣ Reading items & syncing Customer Group Cart into account\n` +
    `2️⃣ Checking saved address history & delivery location\n` +
    `3️⃣ Finding available coupons & discounts on account\n` +
    `4️⃣ Navigating to checkout & capturing authentic Swiggy Payment QR...`,
    { parse_mode: 'HTML' }
  );

  // Run full group cart sync, address binding, coupon optimization & checkout payment screen capture in background
  // to avoid Telegraf's 90,000ms callback query timeout error!
  (async () => {
    try {
      const result = await syncGroupCartAndCheckoutForAccount(acc, order);
      console.log(`[syncGroupCartAndCheckoutForAccount] Result for Order #${orderId}:`, {
        success: result.success,
        sessionExpired: Boolean(result.sessionExpired),
        hasQr: Boolean(result.qrBuffer),
        paymentUrl: result.paymentUrl,
        itemsCount: result.cartData?.items?.length || 0,
        savedAddressesCount: result.savedAddresses?.length || 0,
        availableCouponsCount: result.availableCoupons?.length || 0
      });

      if (result.sessionExpired) {
        if (acc) {
          acc.isLoggedIn = false;
          saveDb(db);
        }
        // ZERO-OTP AUTO-FAILOVER: Automatically pick the best remaining saved `.json` account from Vault instead of asking for OTP!
        const fallbackBest = await findBestMaxCouponAccountForOrder(order, {
          captureScreenshot: false,
          excludeAccountKeys: [accKey]
        }).catch(() => null);

        if (fallbackBest?.success && fallbackBest.winningKey) {
          saveDb(db);
          try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
          await updateOrderCards(order);
          return;
        }

        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        await ctx.reply(
          `! <b>No Active Session Remaining in Vault</b>\n\n` +
          `Purana account (<code>${escapeHtml(accPhone)}</code>) expire ho gaya tha aur Vault me koi aur active JSON file nahi bachi.\n` +
          `▤ <i>Bas chat me apne <code>.json</code> / <code>.zip</code> account files drop kar dein — bot bina OTP sab save karke order ready kar dega!</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }

      if (!result?.success) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        await ctx.reply(
          `× <b>Order #${orderId} was not sent to payment.</b>\n\n${escapeHtml(result?.error || 'Delivery address, location, or recipient mobile could not be verified.')}\n\n` +
          `<i>No default/first-saved address was substituted and no payment QR was created. Correct the recipient details, then retry.</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }

      if (result.cartData) {
        const cd = result.cartData;
        if (cd.restaurantName) order.restaurantName = cd.restaurantName;
        if (cd.items && cd.items.length > 0) order.items = cd.items;
        if (cd.address && (!order.address || order.address === 'Address pending / not provided')) {
          order.address = cd.address;
        }
        order.itemTotal = cd.itemTotal || order.itemTotal;
        order.subtotal = cd.subtotal || order.subtotal;
        order.swiggyOneMembershipFee = cd.swiggyOneMembershipFee || 0;
        order.deliveryFee = cd.deliveryFee || 0;
        order.freeDeliveryDiscount = cd.freeDeliveryDiscount || 0;
        order.swiggyOneApplied = cd.swiggyOneApplied || false;
        order.swiggyOneSavings = cd.swiggyOneSavings || 0;
        order.couponCode = cd.couponCode || null;
        order.discountAmount = cd.discountAmount || 0;
        order.freeCashBalance = cd.freeCashBalance || 0;
        order.freeCashApplied = cd.freeCashApplied || 0;
        order.finalPayable = cd.finalPayable || order.finalPayable;
        order.totalSavings = cd.totalSavings || order.totalSavings;
        if (cd.addressDetails) {
          order.addressDetails = cd.addressDetails;
        }
        order.packingCharges = cd.packingCharges || 0;
        order.taxesAndCharges = cd.taxesAndCharges || 0;
        order.swiggyVerified = true;
      }

      if (result.savedAddresses && result.savedAddresses.length > 0) {
        // Keep these for the explicit address picker only; never auto-select savedAddresses[0].
        order.accountAddresses = result.savedAddresses;
      }
      if (result.availableCoupons && result.availableCoupons.length > 0) {
        order.availableCoupons = result.availableCoupons;
      }

      // Always ensure max offer is calculated
      applyMaxOfferToOrder(order);

      if (result.paymentUrl) {
        order.swiggyPaymentUrl = result.paymentUrl;
      }

      // Generate authentic personalized QR Card with customer's name embedded in the center of the QR
      const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
      const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
      const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;

      let finalQrBuffer = result.qrBuffer;
      try {
        const cardBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri,
          qrBuffer: result.qrBuffer
        });
        if (cardBuffer) {
          finalQrBuffer = cardBuffer;
        }
      } catch (e) {
        console.warn('[boss_select_acc] Personalized QR Card generation fallback:', e.message);
      }

      if (finalQrBuffer) {
        order.genuineQrBuffer = finalQrBuffer;
        try {
          const bossQrMsg = await ctx.replyWithPhoto(
            { source: finalQrBuffer },
            {
              caption: `▣ <b>Live Swiggy Checkout Payment QR (Order #${order.id})</b>\n\n` +
                `☎ Account: <b>${escapeHtml(accPhone)}</b> (${escapeHtml(accName)})\n` +
                `◉ Customer Badge in QR Center: <b>${escapeHtml(custDisplayName)}</b>\n` +
                `▣ Restaurant: <b>${escapeHtml(order.restaurantName || 'Swiggy Order')}</b>\n` +
                `₹ Amount To Pay: <b>₹${order.finalPayable || order.subtotal || 0}</b> (Saved: ₹${order.totalSavings || 0})\n\n` +
                `! <i>Yeh Payment QR abhi customer ko nahi bheja gaya hai. Neeche Review Screen check karke <b>[ › Send Bill & Request Confirmation ]</b> dabayein!</i>`,
              parse_mode: 'HTML'
            }
          );
          if (bossQrMsg?.photo && bossQrMsg.photo.length > 0) {
            order.customQrFileId = bossQrMsg.photo[bossQrMsg.photo.length - 1].file_id;
          }
        } catch (e) {
          console.error('[boss_select_acc] Error sending QR preview to boss:', e.message);
        }
      }

      saveDb(db);

      // Update Customer's card
      await updateOrderCards(order);

      try {
        await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
      } catch (e) {}

      // Deliver comprehensive Boss Review Card
      const reviewCard = formatBossAccountReviewCard(order);
      await ctx.reply(reviewCard.text, {
        parse_mode: 'HTML',
        ...reviewCard.keyboard
      });
    } catch (e) {
      console.error('Error syncing group cart and checkout for chosen account:', e.message);
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (delErr) {}
      await ctx.reply(`× <b>Failed to process order #${orderId}:</b> ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  })().catch(err => console.error('[boss_select_acc] Background Error:', err));
});

// 1-Tap Boss Action: Auto Scan ALL Logged-In Accounts -> Apply Swiggy One Lite (+₹1) + Max Coupon -> Pick Lowest Final Total!
bot.action(/^boss_auto_max_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Scanning all accounts for MAX Coupon + Lowest Bill... ★').catch(() => {});
  const waitMsg = await ctx.reply(
    `★ <b>Auto Max-Coupon & Best Account Engine (#${orderId})...</b>\n\n` +
    `1️⃣ Checking all logged-in Swiggy accounts\n` +
    `2️⃣ Unlocking ₹50 Event Offers & ₹1 Swiggy One Lite Free Delivery\n` +
    `3️⃣ Testing all restaurant & campaign coupons (<code>DELULU4FOOD</code>, <code>STEALDEAL</code>, <code>MEALDEAL</code>, <code>FLAT150</code>, <code>TRYNEW</code>...)\n` +
    `4️⃣ Locking the #1 Lowest <b>Final Total</b> & capturing Payment QR...`,
    { parse_mode: 'HTML' }
  );

  (async () => {
    try {
      const best = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: true });
      if (!best.success) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        return ctx.reply(`! <b>Max Coupon Scan Failed:</b> ${escapeHtml(best.error || 'No active accounts')}`, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (best.savedAddresses?.length > 0) order.accountAddresses = best.savedAddresses;
      if (best.availableCoupons?.length > 0) order.availableCoupons = best.availableCoupons;
      if (best.paymentUrl) order.swiggyPaymentUrl = best.paymentUrl;
      applyMaxOfferToOrder(order);

      const custDisplayName = order.userName || 'Customer';
      const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
      const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;

      let finalQrBuffer = best.qrBuffer;
      try {
        const cardBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri,
          qrBuffer: best.qrBuffer
        });
        if (cardBuffer) finalQrBuffer = cardBuffer;
      } catch (e) {}

      const winPhone = best.winningAccount?.phone || best.winningKey;
      const winName = best.winningAccount?.name || winPhone;
      const cmpLines = (best.accountComparison || [])
        .map(c => `• <code>${escapeHtml(c.phone)}</code>: Final Total <b>₹${c.finalPayable}</b>${c.couponCode ? ` (${escapeHtml(c.couponCode)} −₹${c.discountAmount})` : ''}`)
        .join('\n');

      if (finalQrBuffer) {
        order.genuineQrBuffer = finalQrBuffer;
        try {
          const bossQrMsg = await ctx.replyWithPhoto(
            { source: finalQrBuffer },
            {
              caption: `★ <b>MAX COUPON WINNER ACCOUNT LOCKED! (Order #${order.id})</b>\n\n` +
                `★ Winning Account: <b>${escapeHtml(winPhone)}</b> (${escapeHtml(winName)})\n` +
                `# Best Coupon: <b>${escapeHtml(order.couponCode || 'Auto Free Delivery')}</b> (−₹${order.discountAmount || 0})\n` +
                `₹ Total Savings: <b>₹${order.totalSavings || 0}</b>\n` +
                `₹ <b>Final Total: ₹${order.finalPayable || order.subtotal || 0}</b>\n` +
                (cmpLines ? `\n▤ <b>Account Comparison:</b>\n${cmpLines}` : ''),
              parse_mode: 'HTML'
            }
          );
          if (bossQrMsg?.photo?.length > 0) {
            order.customQrFileId = bossQrMsg.photo[bossQrMsg.photo.length - 1].file_id;
          }
        } catch (e) {}
      }

      saveDb(db);
      try {
        const summarySend = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
          db: getDb(),
          deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary)
        });
        if (summarySend?.sent) console.log(`[MaxCoupon] Bill summary sent for Order #${order.id}`);
      } catch (summaryErr) {
        console.warn('[MaxCoupon] Bill summary skipped:', summaryErr?.message || summaryErr);
      }
      await updateOrderCards(order);
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

      const reviewCard = formatBossAccountReviewCard(order);
      await ctx.reply(reviewCard.text, { parse_mode: 'HTML', ...reviewCard.keyboard });
    } catch (e) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (err) {}
      await ctx.reply(`× <b>Max Coupon Scan Error:</b> ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  })().catch(err => console.error('[boss_auto_max_coupon] Error:', err));
});

// Helper: parse `accKey` and optional `orderId` cleanly even when `accKey` contains underscores (`acc_9935123518` or `acc_9935123518_ORD1`)
function resolveAccountPayload(rawPayload) {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  if (accounts[rawPayload]) return { accKey: rawPayload, orderId: null, acc: accounts[rawPayload] };
  for (const k of Object.keys(accounts)) {
    if (rawPayload.startsWith(k + '_')) {
      return { accKey: k, orderId: rawPayload.slice(k.length + 1), acc: accounts[k] };
    }
  }
  const m = rawPayload.match(/^(acc_\d{10})(?:_(.+))?$/);
  if (m) return { accKey: m[1], orderId: m[2] || null, acc: accounts[m[1]] || null };
  return { accKey: rawPayload, orderId: null, acc: accounts[rawPayload] || null };
}

// 1-Tap Direct Re-Login / Re-Create on any 10-digit mobile number (works right after Logout OR Swiggy Delete!)
bot.action(/^relogin_phone_(\d{10})$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const phone = ctx.match[1];
  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === phone);
  const accKey = existing ? existing[0] : `acc_${phone}`;
  const accName = existing?.[1]?.name || getNextAutoUserName();

  await ctx.answerCbQuery(`Sending OTP to ${phone}... !`).catch(() => {});
  const waitMsg = await ctx.reply(`☎ <b>Requesting Swiggy OTP for <code>${phone}</code>...</b>`, { parse_mode: 'HTML' });

  try {
    const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, accKey, accName);
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      userWaitState[ctx.from.id] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone,
        name: accName
      };
      await ctx.reply(
        `☎ <b>Swiggy OTP Sent!</b>\n` +
        `☎ Mobile: <code>${phone}</code>${result.isNewUser ? ' <i>(Fresh Signup Mode)</i>' : ''}\n\n` +
        `› <i>6-digit OTP yahan type karein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}`, style: 'primary' },
                { text: '✉ Resend OTP', callback_data: `resend_otp_${phone}`, style: 'primary' }
              ],
              [
                { text: '▤ Paste Session JSON', callback_data: `boss_login_acc_json_${accKey}`, style: 'primary' },
                { text: '× Cancel', callback_data: 'close_menu', style: 'danger' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, { parse_mode: 'HTML', ...errCard.keyboard });
    }
  } catch (err) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    await ctx.reply(`× <b>Error:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// Boss Action: Trigger Login / Re-Login via OTP for an Account
bot.action(/^boss_login_acc_otp_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const { accKey, orderId, acc } = resolveAccountPayload(ctx.match[1]);
  const rawPhone = acc?.phone || acc?.mobile || accKey.replace(/^acc_/, '');
  const phone = /^\d{10}$/.test(rawPhone) ? rawPhone : '';
  const accName = acc?.name || phone || accKey;

  // If account slot has no phone number yet (newly created slot), ask for the 10-digit number directly!
  if (!phone) {
    await ctx.answerCbQuery().catch(() => {});
    userWaitState[ctx.from.id] = { action: 'waiting_phone_for_otp', targetAcc: accKey, orderId };
    return ctx.reply(
      `☎ <b>Enter 10-digit Mobile Number for "${escapeHtml(accName)}":</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '10 digits, or 91 + 10 digits...' }
      }
    );
  }

  await ctx.answerCbQuery(`Sending OTP to ${phone}... !`).catch(() => {});
  const waitMsg = await ctx.reply(`☎ <b>Requesting Swiggy OTP for ${escapeHtml(phone)} (${escapeHtml(accName)})...</b>`, { parse_mode: 'HTML' });

  try {
    const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, accKey, accName);
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      userWaitState[ctx.from.id] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone,
        name: accName,
        orderId
      };
      await ctx.reply(
        `☎ <b>Swiggy OTP Sent Successfully!</b>\n` +
        `☎ Mobile: <code>${phone}</code>${result.isNewUser ? ' <i>(Fresh Signup)</i>' : ''}\n` +
        `◉ Account: <b>${escapeHtml(accName)}</b>\n\n` +
        `› <i>Kripya mobile par aaya hua 6-digit OTP yahan type karein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}`, style: 'primary' },
                { text: '✉ Resend OTP', callback_data: `resend_otp_${phone}`, style: 'primary' }
              ],
              [
                { text: '▤ Paste Session JSON', callback_data: `boss_login_acc_json_${accKey}`, style: 'primary' },
                { text: '× Cancel', callback_data: 'close_menu', style: 'danger' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
  } catch (err) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    await ctx.reply(`× <b>Error:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// Boss Action: Prompt to paste Full Session JSON / Code for an Account (Re-Login without OTP!)
bot.action(/^boss_login_acc_json_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const { accKey, orderId, acc } = resolveAccountPayload(ctx.match[1]);
  const phone = acc?.phone || acc?.mobile || accKey.replace(/^acc_/, '');
  const accName = acc?.name || phone || accKey;

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = {
    action: 'waiting_json_login',
    targetAcc: accKey,
    orderId,
    phone
  };

  await ctx.reply(
    `▤ <b>Re-Login / Import Session Code for ${escapeHtml(accName)}${phone ? ` (<code>${escapeHtml(phone)}</code>)` : ''}:</b>\n\n` +
    `Copy kiya hua full Swiggy Session Code (ya <code>.json</code> file) yahan paste karein — bina OTP ke turant re-login ho jayega!`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste full session JSON code here...' }
    }
  );
});

// Boss Action: Add new account directly while handling an order
bot.action(/^boss_add_new_acc_for_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = {
    action: 'waiting_phone_for_new_acc_order',
    orderId
  };

  await ctx.reply(
    `+ <b>Add New Swiggy Account for Order #${orderId}:</b>\n\n` +
    `› <i>Enter 10-digit Mobile Number:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: '10 digits, or 91 + 10 digits...' }
    }
  );
});

// Boss Action: Back to order review card
bot.action(/^boss_back_to_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  await updateOrderCards(order);
});

// Boss Action: Send Bill & Confirmation Request to Customer
bot.action(/^boss_send_qr_to_user_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.paymentSentToUser = true;
  saveDb(db);

  await ctx.answerCbQuery('Sending Bill & Confirmation Request to Customer... ›').catch(() => {});

  // 1. Send Bill & Confirmation Request to Customer
  const custChatId = order.userChatId || order.userId;
  if (custChatId) {
    try {
      if (!order.genuineQrBuffer) {
        const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
        const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
        const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;
        order.genuineQrBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri
        }).catch(err => {
          console.warn('[boss_send_qr_to_user] Card generation fallback:', err.message);
          return null;
        });
        saveDb(db);
      }

      // Send Customer confirmation & payment prompt
      const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
      const confirmText = `▤ <b>Swiggy Order #${order.id} Ready for Confirmation!</b>\n\n` +
        `◉ <b>Customer:</b> <b>${escapeHtml(custDisplayName)}</b>\n` +
        `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
        `₹ <b>Amount To Pay: ₹${order.finalPayable || order.subtotal || 0}</b>\n` +
        (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved: ₹${order.totalSavings}</b>\n` : '') +
        `\n› <i>Aapka order review ho gaya hai! Neeche <b>[ ✓ Confirm Order & Get Payment QR ]</b> dabakar payment QR prapt karein:</i>`;

      await bot.telegram.sendMessage(
        custChatId,
        confirmText,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✓ Confirm Order & Get Payment QR', `user_confirm_get_qr_${order.id}`)],
            ...(order.swiggyPaymentUrl ? [[Markup.button.url('₹ Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)]] : []),
            [Markup.button.callback('● Cancel Order', `action_cancel_order_confirm_${order.id}`)]
          ])
        }
      );
    } catch (err) {
      console.error('[boss_send_qr_to_user] Failed to send bill to user:', err.message);
    }
  }

  // 2. Update Customer's main order card
  await updateOrderCards(order);

  // 3. Update Boss review card
  const updatedReview = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(updatedReview.text, {
      parse_mode: 'HTML',
      ...updatedReview.keyboard
    });
  } catch (e) {
    await ctx.reply(updatedReview.text, {
      parse_mode: 'HTML',
      ...updatedReview.keyboard
    });
  }

  await ctx.reply(`✓ <b>Bill & Confirmation Request Customer ko bhej diya gaya hai!</b>\n<i>User ke confirm karte hi QR code unhe send ho jayega.</i>`, { parse_mode: 'HTML' });
});

// Customer Action: Confirm Order & Get Personalized QR Card
bot.action(/^user_confirm_get_qr_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery('No payment QR is available for a closed order.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Order Confirmed! Generating your payment QR with your name... ›').catch(() => {});
  await sendPaymentQrToUser(order);
});

// Boss Action: Coupon Picker
bot.action(/^boss_coupon_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});

  const buttons = [];
  const coupons = order.availableCoupons || [];

  for (const c of coupons) {
    const desc = c.description ? ` (${c.description.slice(0, 25)})` : '';
    buttons.push([Markup.button.callback(`# Apply ${c.code}${desc}`, `boss_apply_coupon_${orderId}_${c.code}`)]);
  }

  const defaultCodes = ['DELULU4FOOD', 'SWIGGYIT', 'PARTY', 'STEALDEAL', 'WELCOME50'];
  const missingDefaults = defaultCodes.filter(d => !coupons.some(c => c.code === d));
  if (missingDefaults.length > 0) {
    const row = missingDefaults.slice(0, 3).map(code =>
      Markup.button.callback(`# ${code}`, `boss_apply_coupon_${orderId}_${code}`)
    );
    buttons.push(row);
  }

  if (order.couponCode) {
    buttons.push([Markup.button.callback('× Remove Current Coupon', `boss_remove_coupon_${orderId}`)]);
  }

  buttons.push([Markup.button.callback('← Back to Review Screen', `boss_view_review_${orderId}`)]);

  await ctx.reply(
    `# <b>CHOOSE COUPON FOR ORDER #${orderId}:</b>\n\n` +
    `Current Applied Coupon: <b>${order.couponCode ? escapeHtml(order.couponCode) : 'None'}</b> ` +
    (order.discountAmount > 0 ? `(−₹${order.discountAmount})` : '') + `\n\n` +
    `Select a coupon code to apply to this order:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Boss Action: Apply Coupon (applies live on Swiggy via /dapi/cart/applyCoupon when account is selected!)
bot.action(/^boss_apply_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let code = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.startsWith(oid + '_')) {
      orderId = oid;
      code = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) return ctx.answerCbQuery('Order not found').catch(() => {});
  const order = db.orders[orderId];
  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;

  let liveApplied = null;
  if (acc?.cookies) {
    liveApplied = await applyLiveCouponToOrder(acc, order, code).catch(() => null);
  }

  if (liveApplied && liveApplied.items?.length > 0) {
    order.couponCode = liveApplied.couponCode || code;
    order.discountAmount = liveApplied.discountAmount || 0;
    order.deliveryFee = liveApplied.deliveryFee || 0;
    order.packingCharges = liveApplied.packingCharges || 0;
    order.taxesAndCharges = liveApplied.taxesAndCharges || 0;
    order.finalPayable = liveApplied.finalPayable;
    order.totalSavings = liveApplied.totalSavings;
    order.swiggyVerified = true;
  } else {
    order.couponCode = code;
    order.swiggyVerified = false;
    applyMaxOfferToOrder(order);
  }
  saveDb(db);
  await updateOrderCards(order);

  await ctx.answerCbQuery(`Applied coupon ${order.couponCode || code}! ✓`).catch(() => {});

  if (order.isForwardedOrder) {
    await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true });
    try { await ctx.deleteMessage(); } catch (e) {}
    const fwdView = buildForwardedOrderCardView(order, formatUserOrderCardText);
    const sent = await ctx.reply(fwdView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...fwdView.keyboard
    });
    order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
    order.bossCardMsgId = sent.message_id;
    saveDb(db);
    return;
  }

  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: Remove Coupon
bot.action(/^boss_remove_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const liveRemoved = acc?.cookies ? await applyLiveCouponToOrder(acc, order, 'REMOVE').catch(() => null) : null;

  order.couponCode = null;
  order.discountAmount = 0;
  if (liveRemoved && liveRemoved.items?.length > 0) {
    order.finalPayable = liveRemoved.finalPayable;
    order.totalSavings = liveRemoved.totalSavings;
    order.swiggyVerified = true;
  } else {
    order.swiggyVerified = false;
    applyMaxOfferToOrder(order);
  }
  saveDb(db);
  await updateOrderCards(order);

  await ctx.answerCbQuery('Coupon removed').catch(() => {});
  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: Address Picker (dynamically fetches saved addresses across accounts if not yet cached)
bot.action(/^boss_addr_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery('Loading saved addresses... ⌖').catch(() => {});
  let addrs = order.accountAddresses || [];
  if (addrs.length === 0) {
    addrs = await fetchAllAccountsSavedAddresses();
    if (addrs.length > 0) {
      order.accountAddresses = addrs;
      saveDb(db);
    }
  }
  const buttons = [];

  addrs.forEach((a, idx) => {
    const tag = a.annotation ? `[${a.annotation}] ` : '';
    const accBadge = a.accountName ? `(${a.accountName}) ` : '';
    const label = `${idx + 1}. ${tag}${accBadge}${(a.address || '').slice(0, 32)}...`;
    buttons.push([Markup.button.callback(label, `boss_set_addr_${orderId}_${idx}`)]);
  });

  buttons.push([Markup.button.callback('← Back to Review Screen', `boss_view_review_${orderId}`)]);

  await ctx.reply(
    `⌖ <b>SELECT ACCOUNT ADDRESS FOR ORDER #${orderId}:</b>\n\n` +
    (addrs.length > 0
      ? `Choose from the saved addresses found on your Swiggy accounts:`
      : `<i>No saved addresses found yet on connected Swiggy accounts.</i>`),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Boss Action: Set Address from Saved List (and live re-sync cart delivery fee when account selected!)
bot.action(/^boss_set_addr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let addrIdx = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.startsWith(oid + '_')) {
      orderId = oid;
      addrIdx = parseInt(payload.slice(oid.length + 1), 10);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) return ctx.answerCbQuery('Order not found').catch(() => {});
  const order = db.orders[orderId];
  const selectedAddr = order.accountAddresses?.[addrIdx];
  if (order.pendingSwiggyOrderId) {
    return ctx.answerCbQuery('Delivery address cannot change after a Swiggy payment order/QR exists.', { show_alert: true }).catch(() => {});
  }

  if (selectedAddr) {
    order.address = selectedAddr.address;
    order.addressOriginalText = selectedAddr.address;
    order.addressLink = null;
    order.addressDetails = {
      id: selectedAddr.id || '',
      name: selectedAddr.name || '',
      mobile: selectedAddr.mobile || '',
      flat_no: selectedAddr.flat_no || '',
      area: selectedAddr.area || '',
      landmark: selectedAddr.landmark || '',
      address: selectedAddr.address || '',
      city: selectedAddr.city || '',
      lat: selectedAddr.lat || '',
      lng: selectedAddr.lng || ''
    };
    const selAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    let syncError = '';
    if (selAcc?.cookies) {
      const syncRes = await syncGroupCartAndCheckoutForAccount(selAcc, order, { captureScreenshot: false }).catch(e => ({ success: false, error: e.message }));
      if (!syncRes?.success) syncError = syncRes?.error || 'Address could not be verified on the selected Swiggy account.';
    }
    saveDb(db);
    await updateOrderCards(order);
    if (syncError) {
      await ctx.answerCbQuery('Address not verified; checkout is blocked.', { show_alert: true }).catch(() => {});
      await ctx.reply(`× <b>Address not verified:</b> ${escapeHtml(syncError)}\n\n<i>No default address was substituted.</i>`, { parse_mode: 'HTML' }).catch(() => {});
    } else {
      await ctx.answerCbQuery(`Selected address ${addrIdx + 1}! ⌂`).catch(() => {});
    }
  }

  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: View Review Screen
bot.action(/^boss_view_review_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Prompt to add new account from My Swiggy Accounts menu (deduplicated from order handlers above)
bot.action('boss_add_new_account_menu', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name', orderId: null };
  await ctx.reply(
    `+ <b>ADD NEW SWIGGY ACCOUNT:</b>\n\n` +
    `Naye account ka naam chat me likhein:\n` +
    `(Jaise: <code>Bhai</code>, <code>Chacha</code>, <code>Personal</code>, <code>Office</code>, <code>Didi</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter account name (e.g. Bhai)...' }
    }
  );
});

// ================= ACCOUNT MANAGEMENT: DELETE, LOGOUT, REFRESH, EXPORT =================

// State map for multi-select export checklist per user
const exportSelections = {};
// State for Export & Logout (1+ orders) picker
const exportLogoutSelections = {};
const exportLogoutOrderCounts = {};

// 1A. Remove Account Locally from Bot DB (works immediately even if session is logged out or expired!)
bot.action(/^boss_remove_local_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  const phone = acc?.phone || acc?.mobile || key.replace(/^acc_/, '');
  const cleanPhone = normalizeIndianMobileNumber(phone) || '';
  const accName = acc?.name || key;

  const curWait = userWaitState[userId];
  if (curWait && (curWait.targetAcc === key || (cleanPhone && curWait.phone === cleanPhone))) {
    delete userWaitState[userId];
  }

  await deactivateSwiggyAccountViaBridge(userId, key, false).catch(() => {});
  deleteAccount(key, { purgeVault: false });

  await ctx.answerCbQuery('Removed from Bot DB! ×').catch(() => {});
  await ctx.reply(
    `<blockquote>× <b>ACCOUNT REMOVED FROM BOT</b></blockquote>\n\n` +
    `☎ <b>Number:</b> <code>${escapeHtml(phone)}</code>\n` +
    `◉ <b>Name:</b> <b>${escapeHtml(accName)}</b>\n\n` +
    `<i>Account bot list se hata diya gaya hai. Neeche 1-tap se dobara login kar sakte hain:</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          ...(/^\d{10}$/.test(cleanPhone || phone)
            ? [Markup.button.callback(`◈ Re-Login ${cleanPhone || phone} (OTP)`, `relogin_phone_${cleanPhone || phone}`)]
            : [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')]),
          Markup.button.callback('▤ Login with Code', 'boss_login_with_json')
        ],
        [
          Markup.button.callback('◉ View Accounts', 'boss_view_accounts'),
          Markup.button.callback('⌂ Main Menu', 'boss_panel_home')
        ]
      ])
    }
  );
});

// 1B. Clean All Logged-Out / Dead Accounts from Bot DB in 1 Tap
bot.action('boss_clean_dead_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const entries = Object.entries(db.config?.accounts || {});
  let removed = 0;
  for (const [k, a] of entries) {
    if (!isAccountLoggedInSession(a)) {
      if (userWaitState[userId]?.targetAcc === k) {
        delete userWaitState[userId];
      }
      deleteAccount(k, { purgeVault: false, skipImmediateCloudPush: true });
      removed++;
    }
  }
  if (removed > 0) {
    syncCloudVaultNow(getDb()).catch(() => {});
  }
  await ctx.answerCbQuery(`Removed ${removed} logged-out accounts! ×`).catch(() => {});
  await showFamilyAccounts(ctx);
});

// 1. Direct Delete Account Picker (Supports BOTH Swiggy Server Delete via OTP AND Instant Bot Removal!)
bot.action('boss_delete_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};
  const entries = Object.entries(accounts);

  const buttons = [];
  const deadCount = entries.filter(([, a]) => !isAccountLoggedInSession(a)).length;
  if (deadCount > 0) {
    buttons.push([
      { text: `× Remove All Logged-Out (${deadCount}) from Bot`, callback_data: 'boss_clean_dead_accounts', style: 'danger' }
    ]);
  }

  for (const [k, a] of entries) {
    const label = `${a.name || k} (${a.phone || ''})`;
    if (isAccountLoggedInSession(a)) {
      buttons.push([
        { text: `! Swiggy Delete: ${label}`, callback_data: `boss_swiggy_delete_start_${k}`, style: 'danger' },
        { text: `× Bot Remove`, callback_data: `boss_remove_local_${k}`, style: 'primary' }
      ]);
    } else {
      buttons.push([
        { text: `× Remove from Bot: ${label}`, callback_data: `boss_remove_local_${k}`, style: 'danger' },
        { text: `◈ Re-Login`, callback_data: `boss_login_acc_otp_${k}`, style: 'primary' }
      ]);
    }
  }
  buttons.push([{ text: 'Cancel', callback_data: 'boss_view_accounts', style: 'primary' }]);

  await ctx.reply(
    `<b>× Delete / Remove Accounts Manager:</b>\n\n` +
    `• <b>! Swiggy Delete:</b> OTP ke baad Swiggy server se account delete karne ki request karega.\n` +
    `• <b>× Bot Remove:</b> Sirf bot ki list se account hatayega (bina OTP ke turant!).`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }
  );
});

// Mutex to strictly prevent duplicate / concurrent deletion requests
const deleteInProgress = new Set();

bot.action([
  /^boss_swiggy_delete_start_(.+)$/,
  /^boss_swiggy_delete_trigger_(.+)$/,
  /^boss_swiggy_delete_instant_(.+)$/,
  /^boss_swiggy_delete_confirm_(.+)$/
], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const key = ctx.match[1];

  if (deleteInProgress.has(userId) || deleteInProgress.has(key)) {
    return ctx.answerCbQuery('! Swiggy Delete OTP request already in progress... Please wait.', { show_alert: true }).catch(() => {});
  }

  deleteInProgress.add(userId);
  deleteInProgress.add(key);

  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply('× Account not found.');
  }

  const phone = normalizeIndianMobileNumber(acc.phone || acc.mobile || key.replace(/^acc_/, '')) || '';
  const accName = acc.name || key;
  if (!phone) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply(
      `! <b>No valid Indian mobile number is saved for ${escapeHtml(accName)}.</b> Remove it from the bot list or correct the account details first.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`)]]) }
    );
  }

  const isAuth = checkLoggedInFromCookies(acc);
  if (!isAuth && !acc.cookies && !acc.tid) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply(
      `! <b>"${escapeHtml(accName)}" (<code>${escapeHtml(phone)}</code>) abhi Logged Out hai!</b>\n\n` +
      `• Agar sirf <b>Bot list se hatana hai</b> toh <b>× Remove from Bot DB</b> dabayein.\n` +
      `• Agar <b>Swiggy server se delete</b> karna hai toh pehle <b>◈ Login via OTP</b> dabayein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('× Remove from Bot DB', `boss_remove_local_${key}`),
            Markup.button.callback(`◈ Login ${accName}`, `boss_login_acc_otp_${key}`)
          ],
          [Markup.button.callback('Main Menu', 'boss_panel_home')]
        ])
      }
    );
  }

  await ctx.answerCbQuery('Requesting Authentic Swiggy Delete OTP... ◷').catch(() => {});
  userWaitState[userId] = {
    action: 'initiating_swiggy_delete_otp',
    phone,
    accountKey: key,
    accName,
    startedAt: Date.now()
  };

  try {
    const otpResult = await requestSwiggyDeleteOtpViaBridge(userId, phone, key, accName);
    if (otpResult.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_delete_otp',
        phone,
        accountKey: key,
        accName,
        startedAt: Date.now()
      };

      await ctx.reply(
        otpSentCard(phone, [`× Delete OTP for account: <b>${escapeHtml(accName)}</b>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }],
              [
                { text: 'Resend Delete OTP', callback_data: `boss_swiggy_delete_start_${key}`, style: 'primary' },
                { text: '× Remove from Bot Only', callback_data: `boss_remove_local_${key}`, style: 'danger' }
              ],
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' },
                { text: 'Close', callback_data: 'close_menu', style: 'danger' }
              ]
            ]
          }
        }
      );

      await ctx.reply('› Enter 6-digit Delete OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit Delete OTP...'
        }
      });
    } else {
      delete userWaitState[userId];
      const errText = otpResult.swiggyStatus || otpResult.message || 'Failed to trigger Delete OTP';
      const isAuthError = Boolean(otpResult.isAuthError);
      const securityBlocked = otpResult.code === 'SWIGGY_SECURITY_CHALLENGE' || otpResult.code === 'SWIGGY_RATE_LIMIT';
      if (isAuthError && db.config.accounts?.[key]) {
        db.config.accounts[key].isLoggedIn = false;
        saveDb(db);
      }
      const actionButtons = securityBlocked
        ? [
            [Markup.button.url('Open official Swiggy settings', 'https://www.swiggy.com/my-account/settings')],
            [Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`)],
            [Markup.button.callback('Main Menu', 'boss_panel_home')]
          ]
        : [
            [
              Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`),
              isAuthError
                ? Markup.button.callback(`Re-Login ${phone}`, `boss_login_acc_otp_${key}`)
                : Markup.button.callback('Retry Delete OTP', `boss_swiggy_delete_start_${key}`)
            ],
            [Markup.button.callback('Main Menu', 'boss_panel_home')]
          ];
      await ctx.reply(
        `<blockquote>${escapeHtml(errText)}</blockquote>\n\n` +
        (securityBlocked
          ? `! <b>Swiggy stopped this request. The bot did not retry or bypass the security check.</b>\nUse the official Swiggy settings page to finish deletion, or remove only the saved bot entry. `
          : `! <b>Swiggy Deletion OTP trigger nahi ho paya.</b>\nYou can remove only the bot entry, re-login, or try again later.`),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: actionButtons } }
      );
    }
  } catch (err) {
    delete userWaitState[userId];
    await ctx.reply(`! Error triggering deletion: ${escapeHtml(err.message)}`);
  } finally {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
  }
});

// 2. Interactive Multi-Select Export Checklist
bot.action(['boss_export_picker', 'boss_exp_select_all', 'boss_exp_deselect_all', /^boss_exp_toggle_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);

  if (accKeys.length === 0) {
    await ctx.answerCbQuery('Koi account nahi mila!', { show_alert: true }).catch(() => {});
    return ctx.reply('! No accounts found in bot to export.');
  }

  if (!exportSelections[userId]) {
    exportSelections[userId] = {};
    accKeys.forEach(k => { exportSelections[userId][k] = Boolean(accounts[k]?.isLoggedIn || exportSessionJson(k)); });
  }

  const actionMatch = ctx.callbackQuery?.data;
  if (actionMatch === 'boss_exp_select_all') {
    accKeys.forEach(k => { exportSelections[userId][k] = true; });
    await ctx.answerCbQuery('Sabhi select ho gaye ✓').catch(() => {});
  } else if (actionMatch === 'boss_exp_deselect_all') {
    accKeys.forEach(k => { exportSelections[userId][k] = false; });
    await ctx.answerCbQuery('Sabhi unselect ho gaye ○').catch(() => {});
  } else if (actionMatch?.startsWith('boss_exp_toggle_')) {
    const toggleKey = actionMatch.replace('boss_exp_toggle_', '');
    exportSelections[userId][toggleKey] = !exportSelections[userId][toggleKey];
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.answerCbQuery().catch(() => {});
  }

  const currentSelection = exportSelections[userId];
  const allSelected = accKeys.every(k => currentSelection[k]);
  const selectedCount = accKeys.filter(k => currentSelection[k]).length;

  const buttons = [];
  if (allSelected) {
    buttons.push([{ text: 'Deselect All', callback_data: 'boss_exp_deselect_all', style: 'primary' }]);
  } else {
    buttons.push([{ text: 'Select All', callback_data: 'boss_exp_select_all', style: 'primary' }]);
  }

  for (const k of accKeys) {
    const acc = accounts[k];
    const isChecked = Boolean(currentSelection[k]);
    const checkIcon = isChecked ? '✓' : '□';
    const liveBadge = acc.isLoggedIn ? '●' : '○';
    const accLabel = `${checkIcon} ${liveBadge} ${acc.name || k} (${acc.phone || ''})`;
    buttons.push([{ text: accLabel, callback_data: `boss_exp_toggle_${k}`, style: isChecked ? 'success' : 'primary' }]);
  }

  buttons.push([
    { text: `Confirm & Export (${selectedCount}/${accKeys.length})`, callback_data: 'boss_exp_confirm', style: 'success' }
  ]);
  buttons.push([{ text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' }]);

  const checklistText =
    `<blockquote>↑ <b>EXPORT ACCOUNTS CHECKLIST</b></blockquote>\n\n` +
    `Jin accounts ko export karna chahte hain unhe select karein:\n` +
    `• <b>Selected:</b> <b>${selectedCount} of ${accKeys.length} accounts</b>\n\n` +
    `<i>Confirm karte hi har account ki full <code>.json</code> file (with complete cookies) + 1-Click <b>Copy Code</b> button mil jayega!</i>`;

  try {
    await ctx.editMessageText(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    await ctx.reply(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
});

// Single Account Export Handler (Full Session JSON with complete cookies + 1-Click Full Copy)
bot.action([/^boss_export_single_(.+)$/, /^boss_export_json_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Exporting FULL session JSON... ▣').catch(() => {});

  const exported = exportSessionJson(key) || acc;
  const jsonStr = JSON.stringify(exported, null, 2);
  const compactStr = JSON.stringify(exported);
  const phone = acc.phone || acc.mobile || key;
  const fileName = `swiggy_${phone}.json`;
  const codeBlock = jsonStr.length <= 3700 ? jsonStr : compactStr;

  try {
    await ctx.replyWithDocument(
      {
        source: Buffer.from(jsonStr, 'utf-8'),
        filename: fileName
      },
      {
        caption: `▣ <b>Full Session File:</b> <code>${fileName}</code> (${jsonStr.length} chars)\n◉ <b>Account:</b> ${escapeHtml(acc.name || key)}`,
        parse_mode: 'HTML'
      }
    );

    await ctx.reply(
      `<b>Full Session Code:</b> <code>${phone}</code> (${escapeHtml(acc.name || key)})\n` +
      `<pre><code class="language-json">${escapeHtml(codeBlock)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              makeFullSessionCopyButton(ctx, 'Copy Code', key, compactStr, `copy_code_${key}`, 'primary'),
              { text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }
            ],
            [
              { text: 'Back to Accounts', callback_data: 'acc_refresh_list', style: 'primary' },
              { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await ctx.reply(`× Export failed: ${err.message}`);
  }
});

// Confirm Multi-Select Export -> Sends separate full `.json` file + 1-Click Full Copy button per account
bot.action('boss_exp_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const currentSelection = exportSelections[userId] || {};
  const selectedKeys = Object.keys(accounts).filter(k => currentSelection[k]);

  if (selectedKeys.length === 0) {
    return ctx.answerCbQuery('! Kripya kam se kam ek account select karein!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery(`Exporting ${selectedKeys.length} accounts... ▣`).catch(() => {});

  try {
    for (const key of selectedKeys) {
      const acc = accounts[key];
      const exported = exportSessionJson(key) || acc;
      const jsonStr = JSON.stringify(exported, null, 2);
      const compactStr = JSON.stringify(exported);
      const phone = acc.phone || acc.mobile || key;
      const fileName = `swiggy_${phone}.json`;
      const codeBlock = jsonStr.length <= 3700 ? jsonStr : compactStr;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(jsonStr, 'utf-8'),
          filename: fileName
        },
        {
          caption: `▣ <code>${fileName}</code> — ${escapeHtml(acc.name || key)}`,
          parse_mode: 'HTML'
        }
      );

      await ctx.reply(
        `<b>${escapeHtml(acc.name || key)}</b> (<code>${phone}</code>):\n` +
        `<pre><code class="language-json">${escapeHtml(codeBlock)}</code></pre>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                makeFullSessionCopyButton(ctx, 'Copy Code', key, compactStr, `copy_code_${key}`, 'primary'),
                { text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }
              ]
            ]
          }
        }
      );
    }

    await ctx.reply(
      `✓ <b>Export Complete:</b> ${selectedKeys.length} accounts exported with 100% full session cookies & 1-click Copy Code buttons.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'View Accounts', callback_data: 'boss_view_accounts', style: 'primary' },
              { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await ctx.reply(`× Export error: ${err.message}`);
  }
});

// Fallback callback for non-private chats -> sends 1-tap `<code>` AND `<pre><code class="language-json">` with 100% FULL session JSON!
bot.action(/^copy_code_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc && !exportSessionJson(key)) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  const exported = exportSessionJson(key) || acc;
  const compactStr = JSON.stringify(exported);

  await ctx.answerCbQuery('1 tap on code below copies FULL session! ▤').catch(() => {});
  await ctx.reply(
    `▤ <b>Tap anywhere on code below to copy 100% FULL code (${compactStr.length} chars):</b>\n\n` +
    `<code>${escapeHtml(compactStr)}</code>`,
    { parse_mode: 'HTML' }
  );
});

// 3. Logout Accounts Picker & Logout All
bot.action('boss_logout_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  const loggedInEntries = Object.entries(accounts).filter(([, a]) => a.isLoggedIn);
  if (loggedInEntries.length === 0) {
    return ctx.reply(
      '! <b>Koi bhi active logged-in account nahi hai!</b>\nNiche se account login ya re-login karein:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('☎ Login with Number', 'boss_login_with_number'),
            Markup.button.callback('▤ Login with Code', 'boss_login_with_json')
          ],
          [Markup.button.callback('◉ View All Accounts', 'boss_view_accounts')]
        ])
      }
    );
  }

  const buttons = [];
  buttons.push([{ text: '! LOGOUT ALL ACCOUNTS', callback_data: 'boss_logout_all_confirm', style: 'danger' }]);

  for (const [k, a] of loggedInEntries) {
    buttons.push([{ text: `↗ Logout ${a.name || k} (${a.phone || ''})`, callback_data: `boss_logout_single_${k}`, style: 'primary' }]);
  }
  buttons.push([{ text: '← Back', callback_data: 'boss_view_accounts', style: 'primary' }]);

  await ctx.reply(
    `<blockquote>↗ <b>LOGOUT ACCOUNTS MANAGER</b></blockquote>\n\n` +
    `Jis account ko bot se logout karna chahte hain uspe tap karein (aapka copy kiya hua Session Code Swiggy par active rahega taaki baad me 1-tap Re-Login ho sake!):`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }
  );
});

bot.action(/^boss_logout_single_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found').catch(() => {});

  const phone = acc.phone || acc.mobile || '';
  const accName = acc.name || key;
  await deactivateSwiggyAccountViaBridge(ctx.from.id, key, false).catch(() => {});
  permanentLogoutAccount(key);

  await ctx.answerCbQuery('Logged out cleanly! ✓').catch(() => {});
  await ctx.reply(
    `<blockquote>↗ <b>LOGOUT COMPLETED</b></blockquote>\n\n` +
    `☎ <b>Account:</b> <code>${escapeHtml(phone)}</code>\n` +
    `◉ <b>Name:</b> <b>${escapeHtml(accName)}</b>\n` +
    `◈ <b>Status:</b> Logged Out from Bot (Session Vault saved — Re-Login anytime below!):`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`◈ Re-Login ${phone || accName} (OTP)`, `boss_login_acc_otp_${key}`),
          Markup.button.callback('▤ Re-Login with Code', `boss_login_acc_json_${key}`)
        ],
        [
          Markup.button.callback('× Remove from Bot DB', `boss_remove_local_${key}`),
          Markup.button.callback('◉ View Accounts', 'boss_view_accounts')
        ]
      ])
    }
  );
});

bot.action('boss_logout_all_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `<blockquote>! <b>CONFIRM LOGOUT ALL</b></blockquote>\n\n` +
    `Kya aap sach me <b>SABHI accounts</b> ko ek sath logout karna chahte hain?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('● Yes, Logout All Accounts', 'boss_logout_all_exec'),
          Markup.button.callback('← Cancel', 'boss_logout_picker')
        ]
      ])
    }
  );
});

bot.action('boss_logout_all_exec', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  let count = 0;
  for (const [k, a] of Object.entries(accounts)) {
    if (a.isLoggedIn) {
      permanentLogoutAccount(k);
      count++;
    }
  }

  await ctx.reply(
    `<blockquote>↗ <b>ALL ACCOUNTS LOGGED OUT</b></blockquote>\n\n` +
    `Total <b>${count} accounts</b> successfully logout kar diye gaye hain.\n` +
    `Ab aap kisi bhi account ko <b>OTP</b> ya <b>Copied Session Code</b> se turant re-login kar sakte hain.`,
    {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    }
  );
});

// ===== 3B. Export & Logout (only accounts with minimum 1 order) =====
async function buildExportLogoutChecklist(ctx, orderCounts, selections) {
  const db = getDb();
  const accounts = db.config.accounts || {};
  const eligibleKeys = Object.keys(accounts).filter(k => {
    const cnt = orderCounts[k] ?? -1;
    return cnt >= 1 && (accounts[k]?.isLoggedIn || exportSessionJson(k));
  });
  const ineligibleKeys = Object.keys(accounts).filter(k => !eligibleKeys.includes(k));

  const selectedCount = eligibleKeys.filter(k => selections[k]).length;
  const totalEligible = eligibleKeys.length;

  const buttons = [];
  if (totalEligible > 0) {
    const allSelected = eligibleKeys.every(k => selections[k]);
    buttons.push([{ text: allSelected ? 'Deselect All Eligible' : 'Select All Eligible', callback_data: allSelected ? 'boss_exlo_deselect_all' : 'boss_exlo_select_all', style: 'primary' }]);
  }

  for (const k of eligibleKeys) {
    const acc = accounts[k];
    const cnt = orderCounts[k] ?? 0;
    const isChecked = Boolean(selections[k]);
    const checkIcon = isChecked ? '✓' : '□';
    const liveBadge = acc.isLoggedIn ? '●' : '○';
    const label = `${checkIcon} ${liveBadge} ${acc.name || k} (${acc.phone || ''}) — ${cnt} order${cnt>1?'s':''}`;
    buttons.push([{ text: label, callback_data: `boss_exlo_toggle_${k}`, style: isChecked ? 'success' : 'primary' }]);
  }
  for (const k of ineligibleKeys) {
    const acc = accounts[k];
    const cnt = orderCounts[k] ?? 0;
    const liveBadge = acc.isLoggedIn ? '●' : '○';
    const label = `○ ${liveBadge} ${acc.name || k} (${acc.phone || ''}) — ${cnt} orders (skipped)`;
    buttons.push([{ text: label, callback_data: `boss_exlo_skip_${k}`, style: 'primary' }]);
  }

  if (totalEligible > 0) {
    buttons.push([{ text: `Confirm Export & Logout (${selectedCount}/${totalEligible})`, callback_data: 'boss_exlo_confirm', style: 'success' }]);
  }
  buttons.push([{ text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' }]);

  const checklistText =
    `<blockquote>⇧ <b>EXPORT & LOGOUT (1+ ORDERS)</b></blockquote>\n\n` +
    `Sirf wahi accounts export & logout honge jinme <b>minimum 1 order</b> hai.\n` +
    `• <b>Eligible:</b> <b>${totalEligible} accounts</b> (1+ orders) — selectable\n` +
    `• <b>Skipped:</b> <b>${ineligibleKeys.length} accounts</b> (0 orders) — not exported/logged out\n` +
    `• <b>Selected:</b> <b>${selectedCount}/${totalEligible}</b>\n\n` +
    (totalEligible === 0 ? `<i>⚠️ Koi bhi account me 1+ orders nahi mile — export & logout ke liye koi eligible account nahi hai.</i>` : `<i>Select karein, confirm karte hi har eligible account ki full <code>.json</code> + logout ek saath hoga!</i>`);

  try {
    await ctx.editMessageText(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    await ctx.reply(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
}

bot.action('boss_export_logout_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);
  if (accKeys.length === 0) {
    await ctx.answerCbQuery('Koi account nahi mila!', { show_alert: true }).catch(() => {});
    return ctx.reply('! No accounts found to export.');
  }

  await ctx.answerCbQuery('Checking orders for 1+ filter... ⏳').catch(() => {});
  let statusMsg = null;
  try {
    statusMsg = await ctx.reply('⏳ <i>Har logged-in ID ke orders check ho rahe hain (1+ filter)... Isme 5-8 sec lag sakte hain</i>', { parse_mode: 'HTML' });
  } catch (e) {}

  // Fetch order counts in parallel with timeout
  const orderCounts = {};
  const loggedInEntries = Object.entries(accounts).filter(([, a]) => a && (a.isLoggedIn || a.cookies || a.tid));
  if (loggedInEntries.length === 0) {
    if (statusMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return ctx.reply('! <b>Koi bhi logged-in account nahi hai!</b> Pehle login karein.', { parse_mode: 'HTML' });
  }

  const results = await Promise.allSettled(
    loggedInEntries.map(async ([key, acc]) => {
      try {
        const orders = await Promise.race([
          fetchAccountOrders(acc),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))
        ]);
        const cnt = Array.isArray(orders) ? orders.length : 0;
        return { key, cnt };
      } catch (err) {
        // Fallback to cached totalOrdersCount if available
        const cached = typeof acc.totalOrdersCount === 'number' ? acc.totalOrdersCount : (typeof acc.cachedTotalOrdersCount === 'number' ? acc.cachedTotalOrdersCount : 0);
        return { key, cnt: cached || 0, error: err?.message };
      }
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      orderCounts[r.value.key] = r.value.cnt;
    }
  }
  // For non-logged-in / not fetched accounts, default 0
  for (const k of accKeys) if (!(k in orderCounts)) orderCounts[k] = 0;

  // Also consider db-tracked completed orders as valid (bot ke andar 1+ order ka proof)
  const dbOrders = Object.values(db.orders || {}).filter(o => o.status === 'COMPLETED' || o.swiggyOrderId);
  for (const dbo of dbOrders) {
    if (dbo.selectedAccount && !(dbo.selectedAccount in orderCounts)) orderCounts[dbo.selectedAccount] = 1;
    else if (dbo.selectedAccount && orderCounts[dbo.selectedAccount] === 0) orderCounts[dbo.selectedAccount] = Math.max(orderCounts[dbo.selectedAccount], 1);
    if (dbo.orderAccount) {
      for (const [k, a] of Object.entries(accounts)) {
        if (a.phone && String(dbo.orderAccount).includes(a.phone) && orderCounts[k] === 0) orderCounts[k] = 1;
      }
    }
  }

  if (statusMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}

  if (!exportLogoutSelections[userId]) exportLogoutSelections[userId] = {};
  if (!exportLogoutOrderCounts[userId]) exportLogoutOrderCounts[userId] = {};
  exportLogoutOrderCounts[userId] = orderCounts;

  const eligibleKeys = accKeys.filter(k => (orderCounts[k] ?? 0) >= 1 && (accounts[k]?.isLoggedIn || exportSessionJson(k)));
  // Preselect all eligible by default
  for (const k of accKeys) {
    if (eligibleKeys.includes(k)) {
      if (!(k in exportLogoutSelections[userId])) exportLogoutSelections[userId][k] = true;
    } else {
      exportLogoutSelections[userId][k] = false;
    }
  }

  await buildExportLogoutChecklist(ctx, orderCounts, exportLogoutSelections[userId]);
});

// Toggle / Select All / Skip info for Export & Logout
bot.action(['boss_exlo_select_all', 'boss_exlo_deselect_all', /^boss_exlo_toggle_(.+)$/, /^boss_exlo_skip_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);
  if (!exportLogoutSelections[userId]) exportLogoutSelections[userId] = {};
  if (!exportLogoutOrderCounts[userId]) exportLogoutOrderCounts[userId] = {};

  const data = ctx.callbackQuery?.data || '';
  if (data === 'boss_exlo_select_all') {
    for (const k of accKeys) if ((exportLogoutOrderCounts[userId][k] ?? 0) >= 1) exportLogoutSelections[userId][k] = true;
    await ctx.answerCbQuery('All eligible selected ✓').catch(() => {});
  } else if (data === 'boss_exlo_deselect_all') {
    for (const k of accKeys) exportLogoutSelections[userId][k] = false;
    await ctx.answerCbQuery('All deselected ○').catch(() => {});
  } else if (data.startsWith('boss_exlo_toggle_')) {
    const toggleKey = data.replace('boss_exlo_toggle_', '');
    const cnt = exportLogoutOrderCounts[userId][toggleKey] ?? 0;
    if (cnt < 1) {
      await ctx.answerCbQuery(`Skipped: ${accounts[toggleKey]?.phone || toggleKey} me 0 orders — minimum 1 chahiye!`, { show_alert: true }).catch(() => {});
      return;
    }
    exportLogoutSelections[userId][toggleKey] = !exportLogoutSelections[userId][toggleKey];
    await ctx.answerCbQuery().catch(() => {});
  } else if (data.startsWith('boss_exlo_skip_')) {
    const k = data.replace('boss_exlo_skip_', '');
    await ctx.answerCbQuery(`Not eligible: ${accounts[k]?.phone || k} has 0 orders — skipped`, { show_alert: true }).catch(() => {});
    return;
  }

  await buildExportLogoutChecklist(ctx, exportLogoutOrderCounts[userId], exportLogoutSelections[userId]);
});

// Confirm Export & Logout (only 1+ orders)
bot.action('boss_exlo_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db0 = getDb();
  const accounts0 = db0.config.accounts || {};
  const selections = exportLogoutSelections[userId] || {};
  const orderCounts = exportLogoutOrderCounts[userId] || {};

  const selectedKeys = Object.keys(accounts0).filter(k => selections[k] && (orderCounts[k] ?? 0) >= 1);

  if (selectedKeys.length === 0) {
    return ctx.answerCbQuery('Koi eligible account select nahi hai! (1+ orders chahiye)', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery(`Exporting & logging out ${selectedKeys.length} accounts... ⇧`).catch(() => {});
  await ctx.reply(`⏳ <b>Export & Logout shuru:</b> ${selectedKeys.length} accounts (1+ orders) — pehle export, phir logout...`, { parse_mode: 'HTML' });

  let exportedCount = 0;
  let loggedOutCount = 0;
  let skippedZero = 0;
  const skippedDetails = [];

  for (const key of selectedKeys) {
    const acc = getDb().config.accounts?.[key];
    if (!acc) {
      skippedDetails.push(`${key}: not found`);
      continue;
    }
    const cnt = orderCounts[key] ?? 0;
    if (cnt < 1) {
      skippedZero++;
      skippedDetails.push(`${acc.phone || key}: 0 orders — skipped`);
      continue;
    }

    // Double-check live orders before final logout (safety: re-verify minimum 1 order still holds)
    try {
      const liveOrders = await Promise.race([
        fetchAccountOrders(acc),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 7000))
      ]);
      const liveCnt = Array.isArray(liveOrders) ? liveOrders.length : cnt;
      if (liveCnt < 1 && cnt < 1) {
        skippedZero++;
        skippedDetails.push(`${acc.phone || key}: live check 0 orders — skipped`);
        continue;
      }
    } catch (e) {
      // If live check fails, trust cached cnt >=1
    }

    const exported = exportSessionJson(key) || acc;
    if (!exported || (!exported.cookies && !acc.cookies)) {
      skippedDetails.push(`${acc.phone || key}: export failed (no session)`);
      continue;
    }

    const jsonStr = JSON.stringify(exported, null, 2);
    const compactStr = JSON.stringify(exported);
    const phone = acc.phone || acc.mobile || key.replace(/^acc_/, '');
    const fileName = `swiggy_${phone}.json`;
    const codeBlock = jsonStr.length <= 3700 ? jsonStr : compactStr;

    try {
      await ctx.replyWithDocument(
        { source: Buffer.from(jsonStr, 'utf-8'), filename: fileName },
        { caption: `⇧ <b>Exported:</b> <code>${fileName}</code> (${cnt} orders) — ${escapeHtml(acc.name || key)}`, parse_mode: 'HTML' }
      );
      await ctx.reply(
        `<b>${escapeHtml(acc.name || key)}</b> (<code>${phone}</code>) — <b>${cnt} orders</b>\n` +
        `<pre><code class="language-json">${escapeHtml(codeBlock)}</code></pre>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [ makeFullSessionCopyButton(ctx, 'Copy Code', key, compactStr, `copy_code_${key}`, 'primary'), { text: 'Copy Number', copy_text: { text: phone }, style: 'primary' } ]
            ]
          }
        }
      );
      exportedCount++;
    } catch (err) {
      await ctx.reply(`× Export failed for ${escapeHtml(acc.phone || key)}: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      continue;
    }

    // Now logout only after successful export
    try {
      await deactivateSwiggyAccountViaBridge(ctx.from.id, key, false).catch(() => {});
      permanentLogoutAccount(key);
      loggedOutCount++;
    } catch (e) {
      await ctx.reply(`⚠️ Export hua par logout fail for ${escapeHtml(phone)}: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
    }

    // Small delay to avoid flood
    await new Promise(r => setTimeout(r, 400));
  }

  await ctx.reply(
    `<blockquote>⇧ <b>EXPORT & LOGOUT COMPLETE</b></blockquote>\n\n` +
    `• <b>Exported:</b> ${exportedCount} accounts\n` +
    `• <b>Logged out:</b> ${loggedOutCount} accounts\n` +
    (skippedZero ? `• <b>Skipped (0 orders):</b> ${skippedZero}\n` : ``) +
    (skippedDetails.length ? `\n<i>${skippedDetails.map(s=>escapeHtml(s)).join('\n')}</i>` : ``) +
    `\n\n<i>Note: Sirf 1+ orders wale accounts hi export & logout hue — 0 orders wale automatically skipped rahe.</i>`,
    {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    }
  );

  // Clear selections after done
  delete exportLogoutSelections[userId];
  delete exportLogoutOrderCounts[userId];
});

// ===== RARE ULTRA CARD PREVIEW — alag hi type ka card (jo kam log jaante hain) =====
bot.action('rare_ultra_card', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(()=>{});
  await ctx.answerCbQuery('Ultra Premium Holographic Card bana raha hoon... ✨').catch(()=>{});
  try {
    const db = getDb();
    const sampleOrder = {
      id: `DEMO-${Date.now().toString().slice(-6)}`,
      swiggyOrderId: `2515765${Math.floor(10000+Math.random()*90000)}`,
      restaurantName: 'Thinsane Pizza by Oven Story • Sec 4 Bhilai',
      finalPayable: 341,
      totalSavings: 128,
      addressDetails: { name: 'Panu', mobile: '9157600711', address: 'Sector 4, Bhilai, Chhattisgarh 490001' },
      swiggyPaymentUrl: 'https://www.swiggy.com/payments',
      trackingLink: '',
      deliveryOtp: `${Math.floor(1000+Math.random()*9000)}`,
      registeredMobile: '9157600711'
    };
    const upiUri = `upi://pay?pa=${db.config?.bossUpiId||'6296591407@ybl'}&pn=Swiggy&am=${sampleOrder.finalPayable}&cu=INR&tn=Ultra_${sampleOrder.id}`;
    const buf = await generateUltraPremiumCard({
      customerName: sampleOrder.addressDetails.name,
      restaurantName: sampleOrder.restaurantName,
      amount: sampleOrder.finalPayable,
      savings: sampleOrder.totalSavings,
      upiUrl: upiUri,
      orderId: sampleOrder.swiggyOrderId,
      address: sampleOrder.addressDetails.address,
      deliveryOtp: sampleOrder.deliveryOtp
    });
    // Direct SMS demo to registered mobile with payment link
    sendDirectOrderSms(sampleOrder).catch(()=>{});
    sendPaymentLinkSms(sampleOrder, sampleOrder.swiggyPaymentUrl).catch(()=>{});
    await ctx.replyWithPhoto({ source: buf }, {
      caption: `<b>✨ ULTRA PREMIUM HOLOGRAPHIC CARD</b>\n\n` +
        `🆔 <b>Order:</b> <code>${sampleOrder.swiggyOrderId}</code>\n` +
        `🏪 <b>Restaurant:</b> ${sampleOrder.restaurantName}\n` +
        `💰 <b>Pay:</b> <b>₹${sampleOrder.finalPayable}</b> • <b>Saved ₹${sampleOrder.totalSavings}</b>\n` +
        `📍 <b>Deliver to:</b> ${sampleOrder.addressDetails.address}\n` +
        `📱 <b>Registered Mobile:</b> <code>${sampleOrder.registeredMobile}</code> — <i>Direct SMS sent! ✅</i>\n\n` +
        `<i>🔔 Order karte hi direct SMS registered number par jaata hai — neeche rare buttons try karo (copy_text, switch_inline_query jo bahut kam log jaante hain)</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `📋 Copy Order ${sampleOrder.swiggyOrderId.slice(-6)}`, copy_text: { text: sampleOrder.swiggyOrderId } }, { text: '🔗 Open Tracking', url: sampleOrder.trackingLink }],
          [{ text: '↗️ Share Order', switch_inline_query: `Order ${sampleOrder.swiggyOrderId} — ${sampleOrder.restaurantName}` }, { text: '👥 Share to Group', switch_inline_query_chosen_chat: { query: `order ${sampleOrder.swiggyOrderId}`, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true } }],
          [{ text: `🔢 Copy OTP ${sampleOrder.deliveryOtp}`, copy_text: { text: sampleOrder.deliveryOtp } }, { text: '💳 Pay Instantly', url: sampleOrder.swiggyPaymentUrl }],
          [{ text: `📞 Copy Phone ${sampleOrder.registeredMobile.slice(-4)}`, copy_text: { text: sampleOrder.registeredMobile } }, { text: '☎️ Support', url: 'https://t.me/Its_life_001' }],
          [{ text: '🔄 Refresh Rare', callback_data: 'rare_ultra_card' }, { text: '◉ Family Accounts', callback_data: 'boss_view_accounts' }]
        ]
      }
    });
    await ctx.reply(`<i>Rare Reply Keyboard neeche activate — <b>📱 Send My Contact</b> aur <b>📍 Share Live Location</b> jaise rare buttons try karo!</i>`, { parse_mode: 'HTML', ...getRareReplyKeyboard() });
  } catch(e){ await ctx.reply(`❌ Ultra card error: ${e.message}`); }
});

// Rare: handle contact/location shared via reply keyboard
bot.on('contact', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const phone = ctx.message?.contact?.phone_number || '';
  await ctx.reply(`✅ <b>Rare Button Success!</b>\n\n📱 <b>Contact received:</b> <code>${phone}</code>\n<i>Yeh request_contact rare keyboard se aaya — bahut kam bots iska use karte hain!</i>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});
bot.on('location', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const loc = ctx.message?.location;
  await ctx.reply(`✅ <b>Location received!</b>\n📍 <b>Lat:</b> <code>${loc.latitude}</code> <b>Lng:</b> <code>${loc.longitude}</code>\n<i>Rare request_location button se — alag type ka bot!</i>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

// 4. Refresh All Accounts (Audit Session WITHOUT stale AWS WAF false-403 bug!)
bot.action('boss_refresh_all_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery('Auditing all accounts... ◷').catch(() => {});

  const statusMsg = await ctx.reply('◷ <i>Swiggy se sabhi accounts ke live sessions aur orders verify ho rahe hain...</i>', { parse_mode: 'HTML' });

  const db = getDb();
  const accounts = db.config.accounts || {};
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return ctx.reply('! No accounts found to refresh.');
  }

  const reportItems = [];

  for (let i = 0; i < entries.length; i++) {
    const [key, acc] = entries[i];
    const phone = acc.phone || key.replace('acc_', '');
    const accName = acc.name || key;
    const rawCookie = acc.cookies || (acc.tid ? `tid=${acc.tid}; _sid=${acc.sid || ''}; _device_id=${acc.deviceId || ''}; token=${acc.token || ''}` : '');
    const cookieStr = stripStaleWafCookie(rawCookie);

    if (!cookieStr) {
      acc.isLoggedIn = false;
      reportItems.push(
        `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
        `• ◈ <b>Session:</b> ○ <b>Logged Out</b>\n`
      );
      continue;
    }

    try {
      const res = await fetch('https://www.swiggy.com/dapi/order/all', {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.swiggy.com/my-account'
        },
        signal: AbortSignal.timeout(7000)
      });

      const json = await res.json().catch(() => ({}));
      const isExpired = res.status !== 200 || json.statusCode === 1 || !json.data;

      if (isExpired) {
        acc.isLoggedIn = false;
        reportItems.push(
          `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
          `• ◈ <b>Session:</b> × <b>Expired / Logged Out</b>\n`
        );
      } else {
        acc.isLoggedIn = true;
        if (json.tid) acc.tid = json.tid;
        const orders = json.data?.orders || [];
        if (orders.length > 0) {
          const latest = orders[0];
          const orderTotal = latest.order_total || latest.net_total || 'N/A';
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> ● <b>Active</b> | ▣ ${orders.length} orders (Latest: #${latest.order_id || latest.id || ''} — ₹${orderTotal})\n`
          );
        } else {
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> ● <b>Active (Fresh ID — 0 Orders)</b>\n`
          );
        }
      }
    } catch (netErr) {
      reportItems.push(
        `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
        `• ◈ <b>Session:</b> ! Network Timeout (${escapeHtml(netErr.message)})\n`
      );
    }
  }

  saveDb(db);

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}

  const finalReport =
    `<blockquote>↻ <b>SWIGGY ACCOUNTS AUDIT & REFRESH</b></blockquote>\n\n` +
    reportItems.join('\n');

  await sendSafeHtml(ctx, finalReport, Markup.inlineKeyboard([
    [
      Markup.button.callback('↻ Refresh Again', 'boss_refresh_all_accounts'),
      Markup.button.callback('↑ Export Accounts', 'boss_export_picker')
    ],
    [
      Markup.button.callback('× Delete / Clean Dead', 'boss_delete_picker'),
      Markup.button.callback('◉ View Accounts', 'boss_view_accounts')
    ]
  ]));
});

// Dynamic Session JSON Import Target Selector
bot.action(/^boss_apply_import_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetKey = ctx.match[1];
  const state = userWaitState[ctx.from.id];
  if (!state?.pendingJson) return ctx.answerCbQuery('No pending JSON').catch(() => {});

  if (targetKey === 'new') {
    userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name_for_json', pendingJson: state.pendingJson };
    await ctx.reply(
      `+ <b>Enter Name for New Account:</b>\n(e.g. <code>Bhai</code>, <code>Chacha</code>, <code>Office</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' }
      }
    );
    return;
  }

  await ctx.answerCbQuery('Importing & claiming offers... !').catch(() => {});
  await handleProcessJsonLogin(ctx, state.pendingJson, ctx.from.id, targetKey, null);
});

// Dynamic Fast OTP Target Selector (supports `acc_9935123518` with underscores!)
bot.action(/^boss_fast_otp_(.+)_(\d{10})$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  const phone = ctx.match[2];

  if (targetAcc === 'new') {
    userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name_for_fast_otp', phone };
    await ctx.reply(
      `+ <b>Enter Name for New Account (${phone}):</b>\n(e.g. <code>Bhai</code>, <code>Chacha</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' }
      }
    );
    return;
  }

  await ctx.answerCbQuery(`Sending OTP to ${phone}... !`).catch(() => {});
  const db = getDb();
  const accName = db.config.accounts?.[targetAcc]?.name || targetAcc;

  const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, targetAcc, accName);
  if (result.success) {
    userWaitState[ctx.from.id] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc,
      phone,
      name: accName
    };
    await ctx.reply(
      `☎ <b>OTP Sent</b>\n☎ <code>${phone}</code>\n\n› <i>Enter OTP:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('↻ Re-enter OTP', `prompt_reenter_otp_${phone}`),
            Markup.button.callback('✉ Resend OTP', `resend_otp_${phone}`)
          ],
          [
            Markup.button.callback('☎ Another Number', 'send_to_another_number'),
            Markup.button.callback('⌂ Main Menu', 'boss_panel_home')
          ],
          [
            Markup.button.callback('× Close', 'close_menu')
          ]
        ])
      }
    );
  } else {
    const errCard = formatOtpSendErrorCard(phone, result);
    await ctx.reply(errCard.text, {
      parse_mode: 'HTML',
      ...errCard.keyboard
    });
  }
});

// Amount Setting Button
bot.action(/^boss_set_amount_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_amount', orderId };

  await ctx.reply(
    `₹ <b>Set Amount for Order #${orderId}:</b>\n\n` +
    `Current: <b>₹${order.finalPayable || 350}</b>\n\n` +
    `<i>Naya amount chat me likh kar bhejein (jaise 450):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter amount in ₹...' }
    }
  );
});

// Boss Manual Coupon Code Setting Button
bot.action(/^boss_set_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_coupon', orderId };

  await ctx.reply(
    `# <b>Apply Coupon Code for Order #${orderId}:</b>\n\n` +
    `Current Applied: <b>${order.couponCode ? order.couponCode + ' (−₹' + (order.discountAmount || 0) + ')' : 'None'}</b>\n\n` +
    `<i>Swiggy coupon code likh kar bhejein (jaise: <b>WELCOME50</b>, <b>TRYNEW</b>, <b>SWIGGY50</b>, <b>MIDNIGHT</b>, ya <b>REMOVE</b>):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter coupon code (e.g. WELCOME50)...' }
    }
  );
});

// Boss Refresh Cart & Offers Button
bot.action(/^boss_refresh_cart_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery('Re-fetching cart & best coupons with Swiggy... ◷').catch(() => {});
  await ctx.reply(`◷ <i>Re-inspecting Swiggy cart and checking best offers for Order #${orderId}...</i>`, { parse_mode: 'HTML' });
  triggerBackgroundCartFetch(orderId).catch(err => console.error('[RefreshCart] error:', err.message));
});

// Phase 3 -> Phase 4: User accepts the order amount -> Automatically send authentic UPI QR!
bot.action(/^user_accept_amount_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  // Security check: Only the customer who owns this order (or boss) can accept
  if (Number(order.userId) !== Number(ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }

  // State check: Order must not be completed or cancelled
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
    return ctx.answerCbQuery(`Order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.amountAccepted = true;
  order.status = 'AMOUNT_CONFIRMED';
  order.qrSent = true;
  saveDb(db);

  await ctx.answerCbQuery('Amount Accepted! Generating UPI QR... ₹').catch(() => {});

  // Generate guaranteed-scannable high-clarity UPI QR Code automatically using bot's configured UPI ID
  const upiId = db.config.bossUpiId || '6296591407@ybl';
  const amt = order.finalPayable || 57;
  const upiUri = sanitizeUpiUriForQr(`upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(order.restaurantName || 'Swiggy')}&am=${amt}&cu=INR&tn=Swiggy_Order_${order.id}`);
  let qrBuf = null;
  try {
    qrBuf = await generateNamedUpiQrPngBuffer({
      upiUri,
      senderName: order.userName || order.restaurantName || 'Swiggy',
      restaurantName: order.restaurantName || 'Swiggy',
      amount: amt,
      orderId: order.id
    });
  } catch (err) {
    console.error('Failed to generate QR buffer:', err.message);
  }

  if (qrBuf && (order.userChatId || order.userId)) {
    try {
      const targetChat = order.userChatId || order.userId;
      await bot.telegram.sendPhoto(targetChat, { source: qrBuf }, {
        caption: `₹ <b>Payment QR Code (#${order.id})</b>\n\n` +
          `₹ <b>Payable Amount:</b> <b>₹${amt}</b>\n` +
          `⌖ <b>UPI ID:</b> <code>${upiId}</code>\n\n` +
          `<i>Kisi bhi UPI app (GPay, PhonePe, Paytm) se scan karke ₹${amt} pay karein. Payment ke baad neeche "Check payment status" button dabayein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)],
          [Markup.button.callback('● Cancel Order', `action_cancel_order_confirm_${order.id}`)]
        ])
      });
    } catch (e) {
      console.error('Failed to send QR photo to user:', e.message);
    }
  }

  // Update in-place on User & Boss single cards
  await updateOrderCards(order);
});

// Screen 3 -> Screen 4: Generate QR Button
bot.action(/^boss_generate_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!order.finalPayable || Number(order.finalPayable) <= 0) {
    if (order.subtotal && Number(order.subtotal) > 0) {
      order.finalPayable = Math.round(order.subtotal);
    } else {
      return ctx.answerCbQuery('! Pehle Amount set karein (Amount must be > 0)!', { show_alert: true }).catch(() => {});
    }
  }

  order.amountAccepted = true;
  if (order.status === 'PENDING') {
    order.status = 'ACCEPTED';
    order.acceptedAt = new Date().toISOString();
  }

  await ctx.answerCbQuery('Generating genuine payment QR... !').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  const upiId = db.config?.bossUpiId || '6296591407@ybl';
  const payeeName = order.restaurantName || 'Swiggy Food Order';

  const userButtons = [
    [Markup.button.url('● Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    userButtons.push([Markup.button.url('● Open Swiggy Cart / Items', order.cart)]);
  }

  const bossButtons = [
    [Markup.button.url('Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('Swiggy Cart / Group Order', order.cart)]);
  }

  let qrDelivered = false;

  // Case 1: Custom real Swiggy QR screenshot uploaded by Boss
  if (order.customQrFileId) {
    try {
      await bot.telegram.sendPhoto(order.userId, order.customQrFileId, {
        caption: `● <b>Swiggy Genuine Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n☎ <b>Payment Instructions:</b>\n` +
          `1. Kisi bhi UPI App (PhonePe, Google Pay, Paytm, BHIM) se yeh QR scan karein.\n` +
          `2. Exact <b>₹${payable}</b> pay karein.\n` +
          `3. Payment ke baad niche <b>[ Check payment status ]</b> dabayein!`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      qrDelivered = true;
    } catch (err) {
      console.error('Failed to send genuine QR to user:', err.message);
    }

    try {
      const userProfileUrl = `tg://user?id=${order.userId}`;
      await ctx.replyWithPhoto(order.customQrFileId, {
        caption: `! <b>GENUINE PAYMENT QR DELIVERED!</b>\n\n` +
          `⌖ <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `◉ <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
          `◎ <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
          `<i>Genuine QR image successfully delivered to User and Boss.</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (err) {
      console.error('Failed to send genuine QR to boss:', err.message);
    }
  } else {
    // Case 2: Instant High-Resolution Guaranteed-Scannable UPI QR (< 100ms, safe with giant names!)
    try {
      const upiUri = sanitizeUpiUriForQr(`upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${payable}&cu=INR&tn=Swiggy_Order_${orderId}`);
      const qrBuffer = await generateNamedUpiQrPngBuffer({
        upiUri,
        senderName: order.userName || payeeName,
        restaurantName: payeeName,
        amount: payable,
        orderId
      });

      await bot.telegram.sendPhoto(order.userId, { source: qrBuffer }, {
        caption: safeTelegramCaption(
          `● <b>Swiggy Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Food Order', 120))}\n` +
          `₹ <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n☎ <b>Payment Instructions:</b>\n` +
          `1. Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se QR scan karein.\n` +
          `2. Exact <b>₹${payable}</b> pay karein.\n` +
          `3. Payment ke baad niche <b>[ Check payment status ]</b> dabayein:`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });

      const userProfileUrl = `tg://user?id=${order.userId}`;
      await ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: safeTelegramCaption(
          `! <b>AUTHENTIC UPI PAYMENT QR DELIVERED!</b>\n\n` +
          `⌖ <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `◉ <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(truncateDisplayField(order.userName, 90))}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
          `₹ <b>Receiving UPI ID:</b> <code>${upiId}</code>\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Order', 120))}\n\n` +
          `<i>User ke chat me scannable QR bhej diya gaya hai! Payment hote hi user confirm karega.</i>`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });

      qrDelivered = true;
    } catch (qrErr) {
      console.error('Failed to generate UPI QR:', qrErr.message);
      await ctx.reply(`× QR Generation Error: ${qrErr.message}`);
      return;
    }
  }

  if (qrDelivered) {
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);
  }
});

// Boss Get QR button (Card 3 in FigJam)
bot.action(/^boss_get_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Fetching genuine payment info... ▣').catch(() => {});
  const payable = order.finalPayable || order.subtotal || 0;

  const bossButtons = [
    [Markup.button.url('Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('Swiggy Cart / Group Order', order.cart)]);
  }

  if (order.customQrFileId) {
    await ctx.replyWithPhoto(order.customQrFileId, {
      caption: `▣ <b>GENUINE PAYMENT QR FOR REQUEST #${orderId}</b>\n\n` +
        `₹ <b>Amount:</b> <b>₹${payable}</b>\n` +
        `◎ <b>Swiggy Payment:</b> <code>https://www.swiggy.com/payments</code>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    });
  } else {
    try {
      const upiId = db.config?.bossUpiId || '8249789547@paytm';
      const payeeName = order.restaurantName || 'Swiggy Food Order';
      const upiUri = sanitizeUpiUriForQr(`upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${payable}&cu=INR&tn=Swiggy_Order_${orderId}`);
      const qrBuffer = await generateNamedUpiQrPngBuffer({
        upiUri,
        senderName: order.userName || payeeName,
        restaurantName: payeeName,
        amount: payable,
        orderId
      });
      await ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: safeTelegramCaption(
          `▣ <b>AUTHENTIC UPI PAYMENT QR FOR REQUEST #${orderId}</b>\n\n` +
          `₹ <b>Amount:</b> <b>₹${payable}</b>\n` +
          `₹ <b>Receiving UPI:</b> <code>${upiId}</code>\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Order', 120))}\n\n` +
          `<i>Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se scan karke payment ho jayega!</i>`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (e) {
      await ctx.reply(`× QR Generation Error: ${e.message}`);
    }
  }
});

// Boss Upload Custom Swiggy QR Prompt
bot.action([/^boss_upload_custom_qr_(.+)$/, /^boss_prompt_send_qr_(.+)$/, /^boss_send_payment_qr_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});

  // If genuine QR is already captured from Swiggy checkout, send immediately to user!
  if (order.genuineQrBuffer || order.customQrFileId) {
    await sendPaymentQrToUser(order);
    return ctx.reply(`✓ <b>Genuine Swiggy Payment QR successfully sent to Customer for Order #${orderId}!</b>`, { parse_mode: 'HTML' });
  }

  userWaitState[ctx.from.id] = { action: 'waiting_custom_qr_photo', orderId };
  await ctx.reply(
    `▣ <b>Send Genuine Swiggy Payment QR (Order #${orderId}):</b>\n\n` +
    `Swiggy checkout/payment screen se genuine payment QR ka screenshot image ke roop me chat me send karein:\n\n` +
    `› Yeh photo seedha customer ko deliver ho jayegi aur customer scan karke Swiggy ko pay kar sakega!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '• Send QR screenshot here...'
      }
    }
  );
});

// Boss Live Swiggy Payment Screen Capture
bot.action(/^boss_live_pay_screen_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];
  if (!acc?.cookies) {
    return ctx.answerCbQuery('Selected account does not have active cookies!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Capturing live Swiggy payment screen... ▣').catch(() => {});
  const statusMsg = await ctx.reply('◷ <i>Opening Swiggy checkout & capturing live payment screen with cookies...</i>', { parse_mode: 'HTML' });

  const buf = await captureSwiggyPaymentScreenshot(acc.cookies);
  if (buf) {
    await ctx.replyWithPhoto({ source: buf }, {
      caption: `▣ <b>Live Swiggy Checkout / Payment Screen (Order #${orderId})</b>\n\n` +
        `◉ Account: <b>${acc.name || accKey}</b>\n` +
        `₹ Payable: <b>₹${order.finalPayable || 0}</b>\n\n` +
        `<i>Aap is screenshot ko Ammi ko bhej sakte hain ya payment page par jaakar pay kar sakte hain.</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
        [Markup.button.callback('↑ Send this Screen to Ammi', `boss_forward_live_screen_${orderId}`)]
      ])
    });
  } else {
    await ctx.reply('! Could not capture live payment screen. Swiggy session might need fresh cookies.');
  }

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}
});

// Boss Forward Live Screenshot to User / Ammi
bot.action(/^boss_forward_live_screen_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];
  if (!acc?.cookies) {
    return ctx.answerCbQuery('No cookies available!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Sending screen to Ammi... ↑').catch(() => {});
  const buf = await captureSwiggyPaymentScreenshot(acc.cookies);
  if (buf) {
    const payable = order.finalPayable || 350;
    try {
      await bot.telegram.sendPhoto(order.userId, { source: buf }, {
        caption: `● <b>Swiggy Live Payment Screen (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne Swiggy payment screen bhej di hai! Payment karein ya payment status check karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
          ...(order.cart?.startsWith('http') ? [[Markup.button.url('▤ Open Swiggy Cart / Items', order.cart)]] : []),
          [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
        ])
      });
      await ctx.reply(`✓ <b>Live Swiggy payment screen deliver ho gaya Ammi/User ko!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send photo to user: ${err.message}`);
    }
  } else {
    await ctx.reply('! Failed to capture screenshot.');
  }
});

// Copy Cart fallback handlers
bot.action(/^(?:boss_copy_cart_|boss_copy_cart_link_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order || !order.cart) return ctx.answerCbQuery('Cart link not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Cart link copied!').catch(() => {});
  await ctx.reply(`● <b>Cart Link (#${orderId}):</b>\n<code>${escapeHtml(order.cart)}</code>`, { parse_mode: 'HTML' });
});

// Copy Address fallback handlers
bot.action(/^(?:boss_copy_addr_|boss_copy_addr_link_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order || !order.address) return ctx.answerCbQuery('Address link not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Address link copied!').catch(() => {});
  await ctx.reply(`● <b>Address Link (#${orderId}):</b>\n<code>${escapeHtml(order.address)}</code>`, { parse_mode: 'HTML' });
});

// Cancel Order button: Prompt confirmation (Card Row 2 in FigJam)
bot.action(/^boss_prompt_cancel_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  const userProfileUrl = `tg://user?id=${order.userId}`;
  const text = `! <b>Kya aap waqai Order #${orderId} cancel karna chahte hain?</b>\n\n` +
    `◉ <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
    `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
    `₹ <b>Amount:</b> ₹${order.finalPayable || 0}\n\n` +
    `<i>Niche confirmation select karein:</i>`;

  const buttons = [
    [
      Markup.button.callback('Are you sure (Cancel)', `boss_confirm_cancel_${orderId}`),
      Markup.button.callback('Keep Order', `boss_keep_order_${orderId}`)
    ]
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
});

// Boss Keep Order (cancel aborted)
bot.action(/^boss_keep_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Order active hai ●').catch(() => {});
  const card = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
  } catch (e) {
    await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
  }
});

// Boss Confirm Cancel Order (Performs cancellation and deletes message cards)
bot.action(/^(?:boss_confirm_cancel_|boss_cancel_order_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  saveDb(db);
  try { stopOrderTrackingAuto(order.id); } catch {}
  await ctx.answerCbQuery('Order Cancelled ●').catch(() => {});

  // 1. Delete message from current chat
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // 2. Delete order card messages from all chats
  await deleteOrderMessages(order);

  // 3. Confirm to Boss with direct View Cancelled Orders button
  await ctx.reply(
    `× <b>Order #${orderId} cancel kar diya gaya aur card delete ho gaya!</b>\n\n` +
    `Sabhi cancelled orders dekhne ke liye neeche button dabayein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('× View Cancelled Orders', 'boss_view_cancelled_orders')]
      ])
    }
  );

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `× <b>Order #${orderId} cancel kar diya gaya hai.</b>\n\nAap dobara naya link bhej sakte hain.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
});

// Remind Fee button (Card Row 2 in FigJam)
bot.action(/^boss_remind_fee_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Reminder sent to parent! •').catch(() => {});
  const payable = order.finalPayable || order.subtotal || 350;

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `♥ <b>Khushamdeed! Beta ne Swiggy order amount ₹${payable} verify kar diya hai.</b>\n\n` +
      `Kripya screen par <b>[ ✓ Accept Order (Amount Okay) ]</b> dabayein taaki beta payment QR bhej sake!`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
});

// Common handler for payment verification and real tracking extraction
/** Render the "scan errors" line for an all-IDs scan: which accounts failed
 *  and why (expired session vs auth error), so NOT_FOUND is never ambiguous. */
function scanFailuresLine(result) {
  const fails = Array.isArray(result?.failures) ? result.failures : [];
  if (!fails.length) return '';
  const shown = fails.slice(0, 6).map(f =>
    `<code>${escapeHtml(String(f.phone || f.key || '?'))}</code> (${f.reason === 'SESSION_EXPIRED' ? 'session expired' : 'auth fail'})`
  ).join(', ');
  const more = fails.length > 6 ? ` +${fails.length - 6} aur` : '';
  return `▪ <b>Scan errors:</b> ${shown}${more} — in accounts ko <b>My Accounts</b> se dobara login karke retry karo.\n`;
}

async function handleConfirmOrderPaid(ctx, orderId, _confirmedBy) {
  const result = await checkOrderPaidStatusOnly(orderId);
  await ctx.answerCbQuery(result.message || 'Waiting for Swiggy payment verification.', { show_alert: true }).catch(() => {});
}

bot.action(/^user_confirm_order_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }
  await handleConfirmOrderPaid(ctx, orderId, 'User');
});

bot.action(/^user_resend_qr_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery('No payment QR is available for a closed order.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Resending payment details...').catch(() => {});
  await sendPaymentQrToUser(order);
});

bot.action(/^boss_confirm_paid_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await handleConfirmOrderPaid(ctx, orderId, 'Boss');
});

// Universal Extract Now — any user pastes Order ID and taps this button → scan All IDs
bot.action(/^extract_now_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const q = String(ctx.match[1] || '').trim();
  await ctx.answerCbQuery('Extracting — scanning Swiggy IDs…').catch(() => {});

  const db2 = getDb();
  let order = db2.orders?.[q] || db2.orders?.[q.toLowerCase()] || db2.orders?.[q.toUpperCase()];
  if (!order) {
    const qL = q.toLowerCase();
    for (const oo of Object.values(db2.orders || {})) {
      if (String(oo.id || '').toLowerCase() === qL || String(oo.swiggyOrderId || '') === q || String(oo.pendingSwiggyOrderId || '') === q) {
        order = oo;
        break;
      }
    }
  }

  const isNumericSwiggyId = /^\d{10,20}$/.test(q);
  if (!order && !isNumericSwiggyId) {
    await ctx.reply(`❌ Order <code>${escapeHtml(q)}</code> not found.\n\n<i>Bot koi false order id nahi banata — sirf real Swiggy order id (numeric) scan hota hai.</i>`, { parse_mode: 'HTML' });
    return;
  }

  // A numeric Swiggy id that is not in the bot DB is scanned as a TRANSIENT
  // reference. It is saved only if Swiggy confirms the order exists.
  if (!order) {
    order = {
      id: q,
      swiggyOrderId: q,
      pendingSwiggyOrderId: q,
      restaurantName: 'Swiggy Order',
      status: 'UNVERIFIED',
      addressDetails: {},
      createdAt: new Date().toISOString(),
      userId: String(ctx.from.id),
      fwdSenderUserId: String(ctx.from.id),
      userName: ctx.from?.first_name || 'Customer',
      fwdSenderName: ctx.from?.first_name || 'Customer',
      selectedAccount: '',
      trackingLink: '',
      trackingLinkSource: '',
      deliveryOtp: '',
      liveOrderStatus: '',
      isSwiggyIdLookup: true
    };
  }

  const statusMsg = await ctx.reply(
    `⏳ <i>Scanning ${Object.keys(db2.config?.accounts || {}).length} Swiggy IDs for <code>${escapeHtml(q)}</code>…</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => null);

  try {
    const result = await ensureOrderTracking(order, { force: true, budgetMs: 20000, deep: true });
    if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }

    const fresh = getDb().orders?.[order.id] || order;
    const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
    const swiggyId = swiggyOrderIdOf(fresh) || q;
    const phone = placedFromPhoneOf(fresh, getDb());

    if (!result?.hasOrder && !trackingUrl) {
      await ctx.reply(
        `❌ <b>Swiggy order <code>${escapeHtml(q)}</code> kisi bhi logged-in ID par nahi mila.</b>\n\n` +
        `▪ Scanned: <b>${Number(result?.scanned) || 0}</b> IDs${result?.status === 'TIMEOUT' ? ' (time out)' : ''}\n` +
        scanFailuresLine(result) +
        `▪ <b>Order kisi dusre Swiggy account par hoga</b> — jis account se order hua usko is bot me login karo (<b>My Accounts</b>), phir dobara id bhejo.\n` +
        `<i>Order id bhi verify karo (numeric, 12–18 digits) — Swiggy app: Profile → My Orders. Bot koi false tracking link nahi banata.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Swiggy confirmed the order exists — persist it as a genuine external order.
    const saveDbNow = getDb();
    const rec = saveDbNow.orders?.[order.id] || fresh;
    if (!saveDbNow.orders?.[order.id]) {
      rec.isExternalOrder = true;
      rec.isSwiggyIdLookup = true;
      saveDbNow.orders[rec.id] = rec;
    }
    if (rec.status !== 'COMPLETED') {
      rec.status = 'COMPLETED';
      rec.cardStage = 'PAID_CONFIRMED';
      rec.completedAt = rec.completedAt || new Date().toISOString();
    }
    saveDb(saveDbNow);

    const rawLiveStatusNow = String(rec.liveOrderStatus || result?.orderStatus || '');
    const liveStatusNow = normalizeSwiggyLiveOrderStatus(rawLiveStatusNow) || rawLiveStatusNow;
    const isCancelledNow = /cancel|refus|return/i.test(liveStatusNow);
    const isDeliveredNow = /deliv/i.test(liveStatusNow);
    if (trackingUrl) {
      await ctx.reply(
        `✅ <b>Tracking found</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        (liveStatusNow ? `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow)}</code>\n` : '') +
        `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open Swiggy tracking</a>` +
        (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
        (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy tracking', trackingUrl)]])
        }
      );
    } else if (isCancelledNow) {
      await ctx.reply(
        `✅ <b>Order mil gaya</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow)}</code>\n\n` +
        `<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`,
        { parse_mode: 'HTML' }
      );
    } else if (isDeliveredNow) {
      const deliveredUrl = buildSignedOrderTrackUrl(swiggyId || rec.id);
      await ctx.reply(
        `✅ <b>Tracking link ready</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow)}</code>` +
        (deliveredUrl ? `\n▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredUrl)}">Open order tracking</a>` : '') +
        (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
        (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...Markup.inlineKeyboard([
            ...(deliveredUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredUrl)]] : []),
            [Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]
          ])
        }
      );
    } else {
      await ctx.reply(
        `✅ <b>Order mil gaya</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow || 'Order Confirmed')}</code>\n\n` +
        `<i>Swiggy ne share link abhi publish nahi kiya — bot background me retry karega aur link aate hi bhej dega.</i>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]]) }
      );
      startOrderTrackingAuto(rec.id, { force: true, budgetMs: 12000 });
    }
  } catch (e) {
    if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }
    await ctx.reply(`❌ ${escapeHtml(String(e?.message || e))}`, { parse_mode: 'HTML' });
  }
});

// View Family Accounts
bot.action('boss_extract_tracking_prompt', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery().catch(()=>{});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_extract_tracking' };
  await ctx.reply('🔗 <b>Extract Delivery Link — All IDs scan</b>\nSend the <b>Order ID</b> (e.g. <code>FWD9670</code>) or Swiggy Order ID. I will check every logged-in Swiggy ID for its tracking link.', { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Enter Order ID' } });
});

bot.action('boss_view_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showFamilyAccounts(ctx);
});

bot.hears('◉ Family Accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showFamilyAccounts(ctx);
});

async function showFamilyAccounts(ctx) {
  const db = getDb();
  const accounts = db.config.accounts || {};
  const activeKey = db.config.activeOrderAccount;
  const entries = Object.entries(accounts);
  const liveCount = entries.filter(([, a]) => isAccountLoggedInSession(a)).length;
  const deadCount = entries.length - liveCount;

  let text = `◉ <b>CONNECTED SWIGGY ACCOUNTS (${liveCount} Active / ${entries.length} Total):</b>\n\n`;
  if (entries.length === 0) {
    text += `<i>Koi bhi account connected nahi hai.\nNiche diye buttons se JSON ya Number se login karein!</i>\n\n`;
  } else {
    for (const [key, acc] of entries) {
      const status = isAccountLoggedInSession(acc) ? `● Logged In` : '○ Logged Out';
      const isActive = key === activeKey ? ' ★ <b>[ACTIVE]</b>' : '';
      text += `• <b>${escapeHtml(acc.name || key)}</b>${isActive} — <b>${status}</b>\n` +
        `  ☎ <code>${acc.phone || 'Not set'}</code>\n`;
    }
    text += `\n<i>↓ Kisi bhi account par tap karein (Copy Code / Claim Offer / Logout / Re-Login / Delete ke liye):</i>`;
  }

  const buttons = [];

  for (let i = 0; i < entries.length; i += 2) {
    const row = [];
    const [k1, a1] = entries[i];
    const live1 = isAccountLoggedInSession(a1);
    const icon1 = live1 ? (k1 === activeKey ? '★' : '●') : '○';
    row.push({ text: `${icon1} ${a1.phone || a1.name || k1}`, callback_data: `acc_view_detail_${k1}`, style: live1 ? 'success' : 'primary' });
    if (entries[i + 1]) {
      const [k2, a2] = entries[i + 1];
      const live2 = isAccountLoggedInSession(a2);
      const icon2 = live2 ? (k2 === activeKey ? '★' : '●') : '○';
      row.push({ text: `${icon2} ${a2.phone || a2.name || k2}`, callback_data: `acc_view_detail_${k2}`, style: live2 ? 'success' : 'primary' });
    }
    buttons.push(row);
  }

  buttons.push([
    { text: '▣ Claim ₹50 Off Offers (All Active)', callback_data: 'boss_claim_all_event_offers', style: 'success' }
  ]);
  buttons.push([
    { text: 'Login with Number', callback_data: 'boss_login_with_number', style: 'primary' },
    { text: 'Login with JSON', callback_data: 'boss_login_with_json', style: 'primary' }
  ]);
  buttons.push([
    { text: 'Refresh All Accounts', callback_data: 'boss_refresh_all_accounts', style: 'primary' },
    { text: 'Export Session JSON', callback_data: 'boss_export_picker', style: 'primary' }
  ]);
  buttons.push([
    { text: '⇧ Export & Logout (1+ Orders)', callback_data: 'boss_export_logout_picker', style: 'success' }
  ]);
  buttons.push([
    { text: 'Logout Accounts', callback_data: 'boss_logout_picker', style: 'danger' },
    { text: 'Delete Account', callback_data: 'boss_delete_picker', style: 'danger' }
  ]);
  if (deadCount > 0) {
    buttons.push([
      { text: `× Remove Logged-Out Accounts (${deadCount})`, callback_data: 'boss_clean_dead_accounts', style: 'danger' }
    ]);
  }
  buttons.push([
    { text: 'Switch Active Account', callback_data: 'boss_switch_active_picker', style: 'primary' },
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      return;
    } catch (e) {}
  }
  await sendSafeHtml(ctx, text, { reply_markup: { inline_keyboard: buttons } });
}

// Boss Action: Claim ₹50 Off Offers in All Logged-in Accounts
async function runBossEventOffersClaim(ctx, chosenOfferValue = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    return;
  }
  const db = getDb();
  const accounts = db.config.accounts || {};
  const activeEntries = Object.entries(accounts).filter(([, a]) => a.isLoggedIn && (a.cookies || a.tid || a.token));
  const skippedCount = Object.keys(accounts).length - activeEntries.length;

  if (ctx.callbackQuery) {
    const label = chosenOfferValue ? (EVENT_OFFER_OPTIONS[chosenOfferValue]?.shortLabel || `Option #${chosenOfferValue}`) : 'All Active Accounts';
    await ctx.answerCbQuery(`Locking ${label} across today + next 14 days... ›`).catch(() => {});
  }

  if (activeEntries.length === 0) {
    return ctx.reply('! <b>Koi bhi Active Logged-In account nahi mila!</b>\n\nPehle Number ya JSON se account login karein.', {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
  }

  const effectiveVal = [1, 2, 3, 4].includes(Number(chosenOfferValue)) ? Number(chosenOfferValue) : null;
  const headerMeta = EVENT_OFFER_OPTIONS[effectiveVal || 1] || EVENT_OFFER_OPTIONS[1];

  const waitMsg = await ctx.reply(
    `◷ <b>Swiggy Breakfast &amp; Late Night 15-Day Pre-Book Running...</b>\n\n` +
    `▣ <b>Selected Reward:</b> ${escapeHtml(headerMeta.fullLabel)}\n` +
    `• <b>Breakfast Slot:</b> 7:00 AM – 11:00 AM (cutoff 5:00 AM IST)\n` +
    `◷ <b>Late Night Slot:</b> 9:00 PM – 6:00 AM (cutoff 6:30 PM IST)\n\n` +
    `<i>${activeEntries.length} active account(s) me Aaj + Agle 14 Din ke slots ek saath lock kiye ja rahe hain...</i>`,
    { parse_mode: 'HTML' }
  );

  // Claim ALL accounts IN PARALLEL (`Promise.all`) across today + next 14 days!
  const settled = await Promise.all(
    activeEntries.map(async ([key, acc]) => {
      const accLabel = `${acc.phone || key}${acc.name ? ` (${acc.name})` : ''}`;
      if (effectiveVal) acc.preferredOfferValue = effectiveVal;
      try {
        const claimRes = await claimSwiggyBreakfastAndLateNightOffers(acc, {
          force: true,
          forcePatch: Boolean(effectiveVal),
          offerValue: effectiveVal || acc.preferredOfferValue || 1
        });
        acc.offers = claimRes;
        if (claimRes.sessionExpired) acc.isLoggedIn = false;
        return { label: accLabel, key, res: claimRes };
      } catch (e) {
        return { label: accLabel, key, res: { success: false, error: e.message } };
      }
    })
  );

  let successCount = 0;
  let partialCount = 0;
  let failCount = 0;
  for (const item of settled) {
    if (item.res?.bothClaimed) successCount++;
    else if (item.res?.success) partialCount++;
    else failCount++;
  }

  saveDb(db);
  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}

  let reportText = section('▣ SWIGGY FREE CASH & EVENT OFFERS (15-DAY AUTO-LOCK)', [
    sub('• Breakfast: 7AM–11AM · ◷ Late Night: 9PM–6AM'),
    sub('Auto-locked before 5:00 AM IST (Breakfast) · 6:30 PM IST (Late Night)'),
  ].join('\n')) + '\n';

  const offerTableRows = [['Account', 'Breakfast', 'Late Night', 'Status']];
  for (const item of settled) {
    const r = item.res;
    if (r.error || r.reason) {
      offerTableRows.push([
        `<b>${escapeHtml(item.label)}</b>`,
        `× Error`,
        `× Error`,
        `<code>${escapeHtml(r.error || r.reason)}</code>`,
      ]);
      continue;
    }

    const bf = r.breakfast || {};
    const ln = r.lateNight || {};
    const bfTag = bf.status === 'CLAIMED' ? '✓' : '×';
    const lnTag = ln.status === 'CLAIMED' ? '✓' : '×';
    const bfMsg = escapeHtml(bf.message || bf.rawMessage || 'Done');
    const lnMsg = escapeHtml(ln.message || ln.rawMessage || 'Done');

    offerTableRows.push([
      `<b>${escapeHtml(item.label)}</b>`,
      `${bfTag} ${bfMsg}`,
      `${lnTag} ${lnMsg}`,
      '✓ Claimed',
    ]);
  }
  reportText += table(offerTableRows) + '\n';

  reportText += section('▤ Summary', [
    field('Fully Locked', `<b>${successCount}</b>`),
    field('Partial', `<b>${partialCount}</b>`),
    field('Expired', `<b>${failCount}</b>`),
    skippedCount > 0 ? field('Logged-out Skipped', `<i>${skippedCount}</i>`) : '',
    sub('Tap any reward button below to switch ALL IDs instantly across all 15 days!'),
  ].filter(Boolean).join('\n'));

  const buttons = [
    [
      Markup.button.callback('₹ ₹50 Free Cash (>₹199)', 'boss_claim_val_1'),
      Markup.button.callback('# ₹150 OFF (>₹249)', 'boss_claim_val_2')
    ],
    [
      Markup.button.callback('! ₹175 LN / ₹100 BF', 'boss_claim_val_3'),
      Markup.button.callback('! ₹100 OFF (>₹149)', 'boss_claim_val_4')
    ],
    [
      Markup.button.callback('↻ Refresh Status', 'boss_claim_all_event_offers'),
      Markup.button.callback('◉ View Accounts', 'boss_view_accounts')
    ],
    [
      Markup.button.callback('⌂ Boss Panel', 'boss_panel_home')
    ]
  ];

  await sendSafeHtml(ctx, reportText, Markup.inlineKeyboard(buttons));
}

bot.command('claim', async (ctx) => {
  const argNum = Number(String(ctx.message?.text || '').trim().split(/\s+/)[1]);
  await runBossEventOffersClaim(ctx, [1, 2, 3, 4].includes(argNum) ? argNum : null);
});

bot.action('boss_claim_all_event_offers', async (ctx) => {
  await runBossEventOffersClaim(ctx, null);
});

bot.action(/^boss_claim_val_([1234])$/, async (ctx) => {
  await runBossEventOffersClaim(ctx, Number(ctx.match[1]));
});

// Switch Active Account Picker
bot.action('boss_switch_active_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};
  const buttons = [];
  for (const [k, a] of Object.entries(accounts)) {
    const isAct = db.config.activeOrderAccount === k ? '★ ' : '';
    buttons.push([Markup.button.callback(`${isAct}${a.name || k} (${a.phone || ''})`, `boss_set_active_${k}`)]);
  }
  buttons.push([Markup.button.callback('← Back', 'boss_view_accounts')]);

  await ctx.reply(
    `↻ <b>SELECT ACTIVE ACCOUNT FOR ORDERS:</b>\n\n` +
    `Orders place karte waqt by-default kaunsa account use karna hai?`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^boss_set_active_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found').catch(() => {});

  setActiveOrderAccountKey(key);
  await ctx.answerCbQuery(`Active account set to ${acc.name || key} ★`).catch(() => {});
  await showFamilyAccounts(ctx);
});


// ================= VOICE MESSAGE HANDLER =================

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;

  if (isBoss(userId) && userWaitState[userId]?.action === 'reply_voice') {
    const targetUserId = userWaitState[userId].targetUserId;
    const orderId = userWaitState[userId].orderId;
    delete userWaitState[userId];

    try {
      await bot.telegram.sendVoice(targetUserId, ctx.message.voice.file_id, {
        caption: `♥ <b>Beta ka aawaaz sandesh (Order #${orderId}):</b>`,
        parse_mode: 'HTML'
      });
      await ctx.reply(`✓ <b>Voice note successfully sent to Ammi/Abbu!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to deliver voice note: ${err.message}`);
    }
    return;
  }

  const db = getDb();
  const role = getFamilyRole(userId, 'Ammi');
  const orderId = generateOrderId();

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'VOICE',
    fileId: ctx.message.voice.file_id,
    address: null,
    cart: null,
    selectedAccount: getActiveOrderAccountKey(db),
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  saveDb(db);

  await ctx.reply(
    `♥ <b>Aapki aawaaz beta tak pahunch gayi hai!</b>\n\n` +
    `<i>Beta abhi aapka voice note sun kar Swiggy se order place kar rahe hain. Aap befikr rahiye.</i>`,
    { parse_mode: 'HTML' }
  );

  for (const bossId of db.config.bossIds) {
    try {
      const card = formatBossOrderCard(newOrder);
      await sendCardSafe(bossId, card);
      const userProfileUrl = `tg://user?id=${newOrder.userId}`;
      await bot.telegram.sendVoice(bossId, ctx.message.voice.file_id, {
        caption: `• <b>Listen to <a href="${userProfileUrl}">${role}</a>'s Voice Note (Request #${orderId})</b>\n# <b>User TG ID:</b> <a href="${userProfileUrl}">${newOrder.userId}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Failed to notify boss of voice note:', e.message);
    }
  }
});

// ================= PHOTO HANDLER =================

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];

  // If Boss sends/forwards a photo with a Cart/Address caption (not while manually uploading a custom QR), handle via Unified Card Flow!
  if (
    isBoss(userId) &&
    (!state || state.action !== 'waiting_custom_qr_photo') &&
    ctx.message?.caption &&
    (extractForwardSenderInfo(ctx.message) || looksLikeBossOrderInput(ctx.message.caption))
  ) {
    delete userWaitState[userId];
    void handleBossForwardedOrderInput(ctx, {
      rawText: ctx.message.caption.trim(),
      formatOrderBodyFn: formatUserOrderCardText,
      nonBlockingAutoSync: true
    }).catch(e => console.error('[BossPhotoOrderIntake]', e));
    return;
  }

  if (state && (state.action === 'waiting_qr' || state.action === 'waiting_custom_qr_photo')) {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('× Order could not be found.');

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;

    order.customQrFileId = fileId;
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);

    const payable = order.finalPayable || 350;
    const userButtons = [
      [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('▤ Open Swiggy Cart / Items', order.cart)]);
    }

    try {
      await bot.telegram.sendPhoto(order.userId, fileId, {
        caption: `● <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne authorized Swiggy payment QR bhej diya hai! Kisi bhi UPI app (Google Pay / PhonePe / Paytm) se scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });

      await ctx.reply(`✓ <b>Custom Swiggy QR successfully delivered to ${escapeHtml(order.userName)}!</b>\n\nUser ke payment confirm karte hi Swiggy live tracking extract hokar dono ko mil jayegi.`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send screenshot: ${err.message}`);
    }
    return;
  }

  const db = getDb();
  const role = getFamilyRole(userId, 'Ammi');
  const orderId = generateOrderId();
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'PHOTO',
    fileId: photo.file_id,
    address: null,
    cart: null,
    selectedAccount: getActiveOrderAccountKey(db),
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  saveDb(db);

  await ctx.reply(
    `♥ <b>Parchi / Photo beta tak pahunch gayi hai!</b>\n\n` +
    `<i>Beta abhi samaan dekh kar order kar rahe hain.</i>`,
    { parse_mode: 'HTML' }
  );

  for (const bossId of db.config.bossIds) {
    try {
      const card = formatBossOrderCard(newOrder);
      await sendCardSafe(bossId, card);
      const userProfileUrl = `tg://user?id=${newOrder.userId}`;
      await bot.telegram.sendPhoto(bossId, photo.file_id, {
        caption: `▣ <b>Photo / List sent by <a href="${userProfileUrl}">${role}</a> (Request #${orderId})</b>\n# <b>User TG ID:</b> <a href="${userProfileUrl}">${newOrder.userId}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Failed to notify boss of photo:', e.message);
    }
  }
});

// Coalesced Multi-File `.json` / `.txt` / `.zip` Account Vault Importer (1 to 200+ files at once — ZERO 429 drops!)
const bulkAccountDocCollector = createBulkDocumentBatchCollector({
  windowMs: 650,
  downloadBufferFn: async (docMeta) => {
    const fileLink = await docMeta.ctx.telegram.getFileLink(docMeta.fileId);
    const res = await fetch(fileLink.href, { signal: AbortSignal.timeout(20000) });
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  },
  onBatchComplete: async ({ lastCtx, statusMsg, html }) => {
    if (statusMsg?.message_id) {
      try { await bot.telegram.deleteMessage(lastCtx.chat.id, statusMsg.message_id); } catch (e) {}
    }
    await sendSafeHtml(lastCtx, html, getBossReplyKeyboard()).catch(err => {
      console.error('[VaultBulkSummary] Reply error:', err.message);
    });
  }
});

// ================= DOCUMENT HANDLER =================
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  const doc = ctx.message.document;
  if (!doc) return;

  // Handle ANY burst of `.json`, `.txt`, `.cookies`, or `.zip` account files sent anytime by Boss!
  if (doc.file_name && /\.(json|txt|cookies?|zip)$/i.test(doc.file_name) && isBoss(userId)) {
    try {
      if (state && state.action === 'waiting_fc_json' && !/\.zip$/i.test(doc.file_name)) {
        delete userWaitState[userId];
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const res = await fetch(fileLink.href);
        const fileText = await res.text();
        const norm = normalizeSwiggySessionPayload(fileText);
        if (!norm) {
          return ctx.reply('! File me valid Swiggy session nahi mila.');
        }
        const ck = norm.cookies || '';
        const statusMsg = await ctx.reply('◷ <i>Uploaded file se Free Cash check & claim ho raha hai...</i>', { parse_mode: 'HTML' });
        const fcRes = await claimInstamartFreeCash(ck);
        try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
        if (fcRes.status === 'CLAIMED') {
          return ctx.reply(`✓ <b>SUCCESSFULLY CLAIMED ₹${fcRes.amount}!</b>\n₹ Total Balance: <b>₹${fcRes.balance}</b>`, { parse_mode: 'HTML' });
        } else if (fcRes.status === 'ALREADY_CLAIMED') {
          return ctx.reply(`i <b>ALREADY CLAIMED!</b>\n₹ Balance: <b>₹${fcRes.balance}</b>`, { parse_mode: 'HTML' });
        }
        return ctx.reply(`× <b>NOT ELIGIBLE FOR FREE CASH</b>\n₹ Balance: ₹0`, { parse_mode: 'HTML' });
      }

      // Clear any stale login/OTP wait state automatically when Boss sends account JSON files!
      if (state) delete userWaitState[userId];
      await bulkAccountDocCollector.enqueue(String(ctx.chat.id), ctx, {
        ctx,
        fileId: doc.file_id,
        fileName: doc.file_name
      });
      return;
    } catch (e) {
      return ctx.reply('! Session file process karne me error aaya: ' + e.message);
    }
  }

  if (state && (state.action === 'waiting_qr' || state.action === 'waiting_custom_qr_photo')) {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('× Order could not be found.');

    order.customQrFileId = doc.file_id;
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);

    const payable = order.finalPayable || 350;
    const userButtons = [
      [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('▤ Open Swiggy Cart / Items', order.cart)]);
    }

    try {
      await bot.telegram.sendDocument(order.userId, doc.file_id, {
        caption: `● <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne authorized Swiggy payment QR document bhej diya hai! QR scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      await ctx.reply(`✓ <b>Custom Swiggy QR document successfully delivered to ${escapeHtml(order.userName)}!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send document to user: ${err.message}`);
    }
    return;
  }
});

// ================= BOSS CARE ACTIONS =================

// Add the delivery OTP only when Swiggy supplies it; never confuse it with login/payment OTPs.
bot.action(/^boss_delivery_otp_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  let order = lookupOrder(getDb(), orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(getDb(), orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true }).catch(() => {}); }
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_delivery_otp', orderId };
  await ctx.reply(
    `⌕ <b>Enter the delivery OTP Swiggy provided for order #${escapeHtml(orderId)}.</b>\n` +
    `<i>This is not the Swiggy login or payment OTP.</i>`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Delivery OTP (4–8 digits)' } }
  );
});

// Send Tracking Link to Parent
bot.action(/^boss_tracking_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_tracking', orderId };

  await ctx.reply(
    `↗ <b>Paste the official Swiggy tracking link for order #${escapeHtml(orderId)}.</b>\n\n` +
    `<i>Only a real Swiggy link will be sent to ${escapeHtml(order.userName)}. To add a delivery OTP, use the “Add delivery OTP” button on the order card.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste the Swiggy tracking URL' }
    }
  );
});

// Reply with Voice
bot.action(/^boss_reply_voice_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'reply_voice', orderId, targetUserId: order.userId };

  await ctx.reply(
    `• <b>Record and send your Voice Message now:</b>\n` +
    `It will be sent straight to ${escapeHtml(order.userName)}.`,
    { parse_mode: 'HTML' }
  );
});

// Tag as Ammi
bot.action(/^boss_tag_ammi_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetUserId = ctx.match[1];
  const orderId = ctx.match[2];

  setFamilyRole(targetUserId, 'Ammi');
  await ctx.answerCbQuery('Tagged as Ammi! ♥').catch(() => {});

  const db = getDb();
  const order = db.orders[orderId];
  if (order) {
    const updated = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updated.text, { parse_mode: 'HTML', ...updated.keyboard });
    } catch (e) {}
  }
});

// Tag as Abbu
bot.action(/^boss_tag_abbu_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetUserId = ctx.match[1];
  const orderId = ctx.match[2];

  setFamilyRole(targetUserId, 'Abbu');
  await ctx.answerCbQuery('Tagged as Abbu! ◉').catch(() => {});

  const db = getDb();
  const order = db.orders[orderId];
  if (order) {
    const updated = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updated.text, { parse_mode: 'HTML', ...updated.keyboard });
    } catch (e) {}
  }
});

// Accept Order
bot.action(/^boss_action_accept_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!canTransitionOrder(order.status, 'ACCEPTED') || order.status !== 'PENDING') {
    return ctx.answerCbQuery(`Cannot accept: order is currently ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'ACCEPTED';
  order.acceptedAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('✓ Order Accepted!').catch(() => {});
  await updateOrderCards(order);

  await ctx.reply(`✓ <b>Request #${orderId} Accepted!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `✓ <b>Aapka Order Accept Ho Gaya Hai! (#${orderId})</b>\n\n` +
      `Beta ne aapka Swiggy order accept kar liya hai aur processing shuru kar di hai. ↗\n\n` +
      `! <b>Zaroori Suchna:</b>\n` +
      `Agar aapko koi bhi difficulty, issue ya samasya aati hai, toh kripya direct message karein:\n` +
      `› <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  } catch (err) {}
});

// Mark as Done
bot.action(/^boss_action_done_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!canTransitionOrder(order.status, 'COMPLETED')) {
    return ctx.answerCbQuery(`Cannot complete: order is currently ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'COMPLETED';
  order.completedAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('✓ Marked as Completed!').catch(() => {});
  const updatedCard = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(updatedCard.text, { parse_mode: 'HTML', ...updatedCard.keyboard });
  } catch (e) {}

  await ctx.reply(`✓ <b>Order #${orderId} marked as COMPLETED!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `✓ <b>Order Complete!</b>\n\nAapka samaan/order delivered ho gaya hai. Khuda hafiz! ♥`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {}
});

// Boss generates UPI QR Code / Payment details for Order
bot.action(/^boss_qr_pay_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Fetching genuine payment details... !').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  const bossButtons = [
    [Markup.button.url('◎ Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('▣ Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('▣ Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('₹ Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];

  if (order.customQrFileId) {
    return ctx.replyWithPhoto(order.customQrFileId, {
      caption: `! <b>GENUINE PAYMENT QR</b>\n\n` +
        `⌖ <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
        `◎ <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
        `<i>Real QR image from checkout session.</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    });
  }

  return ctx.reply(
    `! <b>SWIGGY PAYMENT SESSION</b>\n\n` +
    `⌖ <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
    `◎ <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
    `i <i>Swiggy Desktop Web does not return a dynamic UPI QR in checkout options. User can pay via Swiggy Payment Page or you can upload the Swiggy mobile app QR screenshot.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    }
  );
});

// Boss Prompt Send Swiggy Payment Link
bot.action([/^boss_prompt_send_link_(.+)$/, /^boss_send_payment_link_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_swiggy_link', orderId };
  await ctx.reply(
    `↗ <b>Send Official Swiggy Payment Link (Order #${orderId}):</b>\n\n` +
    `Swiggy checkout page se generated genuine payment link chat me paste karein.\n` +
    `<i>Optional: Amount ke sath bhi likh sakte hain, jaise <code>₹120 https://payments.swiggy.com/...</code> ya seedha URL paste karein.</i>\n\n` +
    `› Yeh authentic link seedha customer ko official payment button ke sath deliver ho jayega!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Paste Swiggy payment link here...'
      }
    }
  );
});

// Reject Order / Say Sorry
bot.action(/^boss_action_sorry_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  order.status = 'REJECTED';
  order.rejectedAt = new Date().toISOString();
  order.cancelledAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('× Order Rejected').catch(() => {});
  await updateOrderCards(order);

  await ctx.reply(`× <b>Order #${orderId} Reject kar diya gaya!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `× <b>Aapka Order Reject Ho Gaya Hai (#${orderId})</b>\n\n` +
      `Beta ne filhal yeh order reject kar diya hai.\n\n` +
      `Agar koi bhi difficulty ya sawal hai, toh kripya direct message karein:\n` +
      `› <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')],
          [Markup.button.callback('↻ New Order', 'user_back_to_main')]
        ])
      }
    );
  } catch (err) {}
});

// Upload SS / QR prompt
bot.action(/^boss_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_qr', orderId };

  await ctx.reply(
    `▣ <b>Upload Screenshot / QR for Order #${orderId}:</b>\n\n` +
    `Tap • icon to choose photo from gallery.`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Pick photo...' }
    }
  );
});

// ================= FREE CASH & INSTAMART OFFERS =================

async function showFreeCashMenu(ctx) {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const accKeys = Object.keys(accounts);

  let text = `▣ <b>CLAIM SWIGGY INSTAMART FREE CASH (₹50-₹60) + FREEBIE</b>\n\n` +
    `Bot pehle account run karke Free Cash actively <b>CLAIM</b> karega aur confirm karega:\n` +
    `• ● <b>CLAIMED:</b> Agar naya Free Cash (₹50/₹60) add ho gaya\n` +
    `• ● <b>ALREADY CLAIMED:</b> Agar is account pe pehle se claim ho chuka hai\n` +
    `• ● <b>NOT ELIGIBLE:</b> Agar account is promo offer ke liye eligible nahi hai\n\n` +
    `<i>Niche apna account select karein ya naya Session JSON / Cookies paste karein:</i>`;

  const buttons = [];
  const accButtons = [];
  for (const k of accKeys) {
    const acc = accounts[k];
    const label = `▣ ${acc.name || k} (${acc.phone || 'Saved'})`;
    accButtons.push(Markup.button.callback(label, `boss_check_fc_${k}`));
  }
  for (let i = 0; i < accButtons.length; i += 2) {
    buttons.push(accButtons.slice(i, i + 2));
  }

  buttons.push([Markup.button.callback('▤ Paste / Upload Session JSON', 'boss_paste_fc_json')]);
  buttons.push([Markup.button.callback('← Back to Main Panel', 'user_back_to_main')]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.command(['freecash', 'claim', 'claim_freecash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

bot.hears(['▣ Claim Free Cash', 'Claim Free Cash', 'claim free cash', 'Free Cash', 'free cash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

bot.action('boss_claim_freecash', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showFreeCashMenu(ctx);
});

bot.action('boss_paste_fc_json', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_fc_json' };
  await ctx.reply(
    `▤ <b>Paste / Upload Swiggy Session JSON / Cookies:</b>\n\n` +
    `Apne account ka session JSON ya cookies yahan chat me paste karein.\n` +
    `Bot pehle account ko run karke Free Cash claim karega aur turant batayega:\n` +
    `• <b>CLAIMED</b> (₹50-₹60 credited)\n` +
    `• <b>ALREADY CLAIMED</b> (pehle se availed)\n` +
    `• <b>NOT ELIGIBLE</b> (offer not valid)`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON or cookies here...' }
    }
  );
});

bot.action(/^boss_check_fc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[accKey];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  if (!acc.cookies) {
    return ctx.answerCbQuery('Account me saved cookies/session nahi hai! Pehle login karein.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Running Swiggy Instamart claim engine... ◷').catch(() => {});
  const statusMsg = await ctx.reply(`◷ <i>Running Instamart Claim Engine for <b>${escapeHtml(acc.name || accKey)}</b>... Please wait 5-10 seconds...</i>`, { parse_mode: 'HTML' });

  const res = await claimInstamartFreeCash(acc.cookies);

  const accName = escapeHtml(acc.name || accKey);
  const accPhone = escapeHtml(acc.phone || 'N/A');

  if (res.status === 'CLAIMED') {
    const successText = `✓ <b>SUCCESSFULLY CLAIMED!</b> ♥\n\n` +
      `◉ <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `₹ <b>Claimed Free Cash:</b> <b>₹${res.amount}</b> (Credited to Swiggy Money!)\n` +
      `₹ <b>Total Current Balance:</b> <b>₹${res.balance}</b>\n` +
      `▣ <b>Instamart Freebie:</b> UNLOCKED ✓ (Eligible for Freebie on orders above ₹199!)\n` +
      (res.swiggyOne ? `★ <b>Swiggy One:</b> Active (Free Delivery Included)\n` : `↗ <b>Delivery:</b> Free delivery on Instamart\n`) +
      `\n<i>Mubarak ho! Bot ne account run karke Free Cash successfully claim kar liya hai. Ammi/Abbu ke liye Instamart grocery mangwayein aur direct ₹${res.balance} discount enjoy karein!</i>`;

    const buttons = [
      [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
      [Markup.button.callback('↻ Check Another Account', 'boss_claim_freecash')]
    ];
    await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else if (res.status === 'ALREADY_CLAIMED') {
    const alreadyText = `i <b>ALREADY CLAIMED!</b>\n\n` +
      `◉ <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `! <b>Status:</b> Is account par Free Cash pehle se claim ho chuka hai.\n` +
      `₹ <b>Available Swiggy Money Balance:</b> <b>₹${res.balance}</b>\n\n` +
      `<i>Yeh balance aapke account me already maujood hai. Aap isse Instamart checkout par use kar sakte hain!</i>`;

    const buttons = [
      [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
      [Markup.button.callback('↻ Check Another Account', 'boss_claim_freecash')],
      [Markup.button.callback('▤ Paste Another Session JSON', 'boss_paste_fc_json')]
    ];
    await ctx.reply(alreadyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else {
    const notEligibleText = `× <b>NOT ELIGIBLE FOR FREE CASH</b>\n\n` +
      `◉ <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `₹ <b>Free Cash Balance:</b> ₹0\n\n` +
      `<i>Yeh account is promotional Free Cash offer ke liye eligible nahi hai.\n` +
      `Note: Yeh promo offers Swiggy ke naye accounts ya targeted users ke liye aate hain. Aap dusra account try karein!</i>`;

    const buttons = [
      [Markup.button.callback('↻ Check Another Account', 'boss_claim_freecash')],
      [Markup.button.callback('▤ Paste / Upload Session JSON', 'boss_paste_fc_json')]
    ];
    await ctx.reply(notEligibleText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}
});

// ================= USER & BOSS BOTTOM MENU HEARS =================

// USER BUTTONS (Colorful Orange Cart & Address Buttons + All Aliases)
bot.hears([
  '🟠 🛒 Cart Link', '🟢 🛒 Cart ✓', '🟠 Cart Link', '🟢 Cart ✓',
  '● Cart link', '● change cart link', 'Cart link', 'change cart link',
  '● Paste cart link', 'Paste cart link', 'Cart', '● Cart: Added ✓',
  '● Paste Cart Link', 'Paste Cart Link', 'Cart: Added'
], async (ctx) => {
  await handleCartLinkFlow(ctx);
});

bot.hears([
  '🟠 📍 Address Link', '🟢 📍 Address ✓', '🟠 Address Link', '🟢 Address ✓',
  '● Address link', '● change address link', 'Address link', 'change address link',
  '● Paste address Link', 'Paste address Link', 'Address', '● Address: Added ✓',
  '● Paste Address Link', 'Paste Address Link', 'Address: Added'
], async (ctx) => {
  await handleAddressLinkFlow(ctx);
});

bot.hears([
  '🚀 Send to Beta',
  'Order Screen', 'Customer Screen', '▣ Order Screen',
  'Send Order to Beta', 'send order to beta', 'SEND ORDER TO BETA',
  'Send to Beta', 'send to beta',
  'Send to Boss', 'send to boss', 'SEND TO BOSS',
  'Send to Admin', '› Send to Beta',
  /send.*order.*beta/i, /send.*beta/i, /send.*boss/i, /send.*admin/i
], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    await ctx.reply('Boss Menu:', getBossReplyKeyboard());
    return ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }
  await handleSendToBoss(ctx);
});

bot.command(['sendtobeta', 'send_to_beta', 'sendorder', 'send_order', 'order'], async (ctx) => {
  await handleSendToBoss(ctx);
});

bot.hears(['✖ Cancel Draft', 'Cancel Draft', 'cancel draft', '● Cancel Draft'], async (ctx) => {
  const userId = ctx.from.id;
  clearDraft(userId);
  delete userWaitState[userId];
  await ctx.reply('✖ <b>Draft clear ho gaya!</b>', { parse_mode: 'HTML', ...getUserReplyKeyboard() });
  return renderUserCard(ctx, userId);
});

bot.action(['action_clear_draft', 'action_cancel_draft'], async (ctx) => {
  await ctx.answerCbQuery('Draft Cleared').catch(() => {});
  const userId = ctx.from.id;
  clearDraft(userId);
  delete userWaitState[userId];
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText(screen.text, {
      parse_mode: 'HTML',
      ...screen.keyboard
    });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.hears(['✖ Cancel Order', '✖ Cancel', 'Cancel Order', 'cancel order', 'Cancel order', '● cancel order', '● Cancel Order'], async (ctx) => {
  await handleCancelOrderConfirm(ctx);
});

bot.hears(['📦 Previous Order', 'Previous Orders', 'previous orders', 'previous order', 'Previous order', '○ previous order'], async (ctx) => {
  await handlePreviousOrder(ctx);
});

bot.hears(['Claim Free Cash', 'claim free cash', 'Free Cash', 'free cash', '▣ Claim Free Cash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

// BOSS ONLY BOTTOM BUTTONS
bot.hears(['Pending Orders', '● Pending Orders'], async (ctx) => {
  if (isBoss(ctx.from.id)) await sendPendingOrdersToBoss(ctx.from.id);
});

bot.hears(['Connected Accounts', '● Connected Accounts', '◉ My Swiggy Accounts'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleMyAccounts(ctx);
});

bot.hears(['Saved Addresses', '● Saved Addresses', '⌖ Saved Addresses'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleSavedAddresses(ctx);
});

bot.hears(['Slot Status', '● Slot Status', '# Slot Status'], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  }
});

bot.hears(['Set UPI ID', '● Set UPI ID'], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
    const cur = getDb().config?.bossUpiId || '6296591407@ybl';
    await ctx.reply(
      `₹ <b>Set Boss Payment UPI ID:</b>\nCurrent: <code>${cur}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Main Menu', 'boss_panel_home'),
            Markup.button.callback('Close', 'close_menu')
          ]
        ])
      }
    );
    await ctx.reply('› Enter UPI ID:', {
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID (e.g. name@upi)...' }
    });
  }
});

bot.hears(['Login Swiggy', '○ Login Swiggy', '◈ Login Swiggy Account'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handlePromptLogin(ctx);
});

bot.hears(['Login with JSON', '◈ Login with JSON'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `<b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

bot.hears(['Login with Number', '☎ Login with Number'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await promptBossLoginWithNumber(ctx);
});

// Register complete Forwarded IB + 10x Parallel Zero-Order Auto-Account Order Workflow (`fwd_*` actions)
registerForwardedOrderHandlers(bot, {
  isBoss,
  formatOrderBodyFn: formatUserOrderCardText
});

bot.action(/^fwd_input_(cart|address|mobile)_([A-Za-z0-9_-]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const [, inputType, orderId] = ctx.match;
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery(`Order is ${order.status.toLowerCase()} and cannot be edited.`, { show_alert: true }).catch(() => {});
  }
  if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
    return ctx.answerCbQuery('Bill approval is in progress or complete; delivery details are locked.', { show_alert: true }).catch(() => {});
  }
  if (order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.cardStage === 'QR_GENERATED') {
    return ctx.answerCbQuery('Swiggy checkout is already active. Cancel or resolve it before editing delivery details.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: `waiting_boss_order_${inputType}`, orderId };
  const prompt = inputType === 'cart'
    ? `▤ <b>Send the genuine Swiggy Cart / Group Cart link for order #${escapeHtml(orderId)}.</b>\n\n<i>The bill will be rechecked after the delivery address and recipient mobile are verified.</i>`
    : inputType === 'mobile'
      ? `☎ <b>Send only the recipient’s correct 10-digit Indian mobile for order #${escapeHtml(orderId)}.</b>\n\n<i>The Swiggy account number will never be substituted for the recipient number.</i>`
      : `⌖ <b>Send the delivery address for order #${escapeHtml(orderId)}.</b>\n\n<i>Use a Swiggy address share, Google Maps link, full street address with area/city/PIN, or share a GPS pin. Include the recipient’s 10-digit mobile if known.</i>`;
  await ctx.reply(prompt, {
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: inputType === 'cart'
        ? 'Paste Swiggy cart link...'
        : (inputType === 'mobile' ? 'Enter recipient mobile...' : 'Paste address or send GPS pin...')
    }
  });
});

// Optional instant QR push toggle (`/autoqr on` | `/autoqr off` | `/autoqr`) for 10x zero-tap QR generation
bot.command('autoqr', async (ctx) => {
  if (!isBoss(ctx.from?.id)) return;
  const arg = String(ctx.message?.text || '').split(/\s+/)[1]?.toLowerCase() || '';
  const db = getDb();
  if (!db.config) db.config = {};
  if (arg === 'on' || arg === '1' || arg === 'true') {
    db.config.autoGenerateQr = true;
  } else if (arg === 'off' || arg === '0' || arg === 'false') {
    db.config.autoGenerateQr = false;
  } else {
    db.config.autoGenerateQr = !Boolean(db.config.autoGenerateQr);
  }
  saveDb(db);
  await ctx.reply(
    `! <b>Auto-QR Mode is now: ${db.config.autoGenerateQr ? '● ON (Instant QR after Auto-Bill Sync)' : '● SMART MANUAL (Auto-Account + Max Offer ON, 1-Click QR button)'}</b>`,
    { parse_mode: 'HTML' }
  );
});

// Detect if pasted text looks like a Swiggy Session JSON
// (used to route boss-pasted session JSON straight to Vault Saver)
function looksLikeSwiggySessionJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    const jsonStr = JSON.stringify(obj).toLowerCase();
    return (
      jsonStr.includes('_session_tid') ||
      jsonStr.includes('"tid"') ||
      jsonStr.includes('"token"') ||
      jsonStr.includes('"cookies"') ||
      jsonStr.includes('"customerid"') ||
      jsonStr.includes('"session_id"') ||
      jsonStr.includes('swiggy')
    );
  } catch (e) {
    return false;
  }
}

// Text message handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  let state = userWaitState[userId];
  const rawText = ctx.message.text.trim();

  // ================= PRIORITY #1: ZERO-OTP CART / ADDRESS / JSON GUARD (BOTH BOSS & CUSTOMERS!) =================
  // NEVER let a stale OTP wait state OR digits inside a Swiggy URL / Address hijack ANY Cart, Address, or Session JSON!
  if (isBoss(userId)) {
    // 1A. Pasted Session JSON anywhere in chat -> straight to Vault Saver (clears any stale OTP wait state!)
    if (
      (!state || state.action !== 'waiting_fc_json') &&
      looksLikeSwiggySessionJson(rawText) &&
      (!state || !['waiting_json_login', 'waiting_account_json_login'].includes(state.action))
    ) {
      delete userWaitState[userId];
      const res = await ingestAndPersistRawAccountTexts([{ fileName: 'pasted_session.json', text: rawText }]);
      await sendSafeHtml(ctx, formatBulkVaultImportSummaryHtml(res, 1), getBossReplyKeyboard());
      return;
    }

    // Telegram callback-based edit prompts stay attached to their order; do not allocate a new one.
    if (state && ['waiting_boss_order_cart', 'waiting_boss_order_address', 'waiting_boss_order_mobile'].includes(state.action)) {
      if (rawText.startsWith('/') || ['Cancel', 'cancel', 'Close', 'close', 'Order Screen', 'Main Menu', 'Menu', 'Back', 'back'].includes(rawText)) {
        // The normal menu/cancel handling below clears the pending prompt.
      } else {
        const order = getDb().orders?.[state.orderId];
        if (!order) {
          delete userWaitState[userId];
          await ctx.reply('Order not found; the input prompt has been cleared.');
          return;
        }

        const links = extractAllLinks(rawText);
        if (state.action === 'waiting_boss_order_cart') {
          const parsedCart = parseCartDetails(rawText);
          if (!links.some(isValidSwiggyCartUrl) && !parsedCart) {
            await ctx.reply('! Send a genuine Swiggy Cart / Group Cart link or a readable Swiggy cart receipt.');
            return;
          }
        } else if (state.action === 'waiting_boss_order_mobile') {
          if (!/^(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?[6-9]\d{4}[\s-]?\d{5}$/.test(rawText.trim()) || !normalizeDeliveryContact(rawText)) {
            await ctx.reply('! Send only the recipient’s valid 10-digit Indian mobile number, optionally with +91.');
            return;
          }
        } else {
          const hasAddressLink = links.some(isValidDeliveryAddressUrl);
          const hasMapLink = links.some(link => /maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps/i.test(link));
          const addressDetails = parseAddressDetails(rawText);
          const hasPlausibleStreetAddress = rawText.length >= 20 && /[\p{L}]/u.test(rawText) &&
            ((rawText.match(/,/g) || []).length >= 2 || /\b\d{6}\b/.test(rawText) || /address|latitude|delivery/i.test(rawText));
          const onlyCartLinks = links.length > 0 && links.every(isValidSwiggyCartUrl) && !hasAddressLink && !hasMapLink;
          if (onlyCartLinks || (!hasAddressLink && !hasMapLink && !addressDetails?.address && !hasPlausibleStreetAddress)) {
            await ctx.reply('! Send a delivery address share/link, Google Maps URL, or a full street address with area, city and PIN.');
            return;
          }
        }

        const update = await applyBossOrderUpdate({
          telegram: ctx.telegram,
          bossChatId: ctx.chat.id,
          orderId: state.orderId,
          cart: state.action === 'waiting_boss_order_cart' ? rawText : '',
          address: ['waiting_boss_order_address', 'waiting_boss_order_mobile'].includes(state.action) ? rawText : '',
          formatOrderBodyFn: formatUserOrderCardText
        });
        if (!update.ok) {
          await ctx.reply(`! ${escapeHtml(update.error || 'Could not update the order.')}`);
          return;
        }
        delete userWaitState[userId];
        await ctx.reply(`✓ ${escapeHtml(update.message || 'Order details updated.')}`, { parse_mode: 'HTML' });
        return;
      }
    }

    // 1B. ANY Forwarded OR Direct Boss Cart Link / Address / Combined Cart+Address -> NEVER ask for OTP!
    const isExplicitAdminLinkInput = state && ['waiting_swiggy_link', 'waiting_payment_link', 'waiting_tracking'].includes(state.action);
    if (!isExplicitAdminLinkInput && (extractForwardSenderInfo(ctx.message) || looksLikeBossOrderInput(rawText))) {
      delete userWaitState[userId];
      void handleBossForwardedOrderInput(ctx, {
        rawText,
        formatOrderBodyFn: formatUserOrderCardText,
        nonBlockingAutoSync: true
      }).catch(e => console.error('[BossDirectOrFwdOrderIntake]', e));
      return;
    }
  } else {
    // 1C. Non-Boss Customer sending ANY Cart / Address -> clear any stale non-draft wait state immediately (ZERO OTP!)
    if (state && !['waiting_cart', 'waiting_address'].includes(state.action) && looksLikeBossOrderInput(rawText)) {
      delete userWaitState[userId];
      state = undefined;
    }
  }

  // Intercept any menu button, slash command, or cancel keyword to free user from wait state
  const isMenuOrCancel = rawText.startsWith('/') || [
    'Order Screen', 'Pending Orders', 'Login with JSON', 'Login with Number',
    'Connected Accounts', 'Claim Free Cash', 'Set UPI ID',
    '🟠 🛒 Cart Link', '🟢 🛒 Cart ✓', '🟠 Cart Link', '🟢 Cart ✓',
    '🟠 📍 Address Link', '🟢 📍 Address ✓', '🟠 Address Link', '🟢 Address ✓',
    '🚀 Send to Beta', '✖ Cancel Draft', '✖ Cancel Order', '✖ Cancel', '📦 Previous Order',
    'Cancel', 'cancel', 'Close', 'close', 'back', 'Back',
    'Main Menu', 'Menu',
    // Legacy emoji versions:
    '▣ Order Screen', '● Pending Orders', '◈ Login with JSON', '☎ Login with Number',
    '● Connected Accounts', '▣ Claim Free Cash', '● Set UPI ID',
    '× Cancel', '⌂ Main Menu', '× Close'
  ].includes(rawText);

  if (state && isMenuOrCancel) {
    delete userWaitState[userId];
    if (['× Cancel', 'Cancel', 'cancel', 'Close', 'close', 'back', 'Back', '× Close'].includes(rawText)) {
      if (isBoss(userId)) {
        await ctx.reply('× Action cancelled.', getBossReplyKeyboard());
        const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
      } else {
        await ctx.reply('× Action cancelled.', getUserReplyKeyboard());
        const screen = getUserScreen(userId, ctx.from);
        await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
      }
      return;
    }
  }

  if (state?.action === 'waiting_recipient_mobile' && !isBoss(userId)) {
    const recipientMobile = extractStandaloneMobileNumber(rawText);
    if (recipientMobile) {
      const draft = getDraft(userId);
      if (!draft.addressDetails?.address) {
        delete userWaitState[userId];
        await ctx.reply('🟠 Pehle <b>Address link</b> ya Location bhejein 👇', { parse_mode: 'HTML' });
        return;
      }
      const addressDetails = { ...draft.addressDetails, mobile: recipientMobile };
      updateDraft(userId, { addressDetails });
      delete userWaitState[userId];
      const updatedDraft = getDraft(userId);
      await renderUserCard(ctx, userId, { deleteIncoming: true, notice: '✓ Mobile saved' });
      if (!updatedDraft.cart) {
        userWaitState[userId] = { action: 'waiting_cart' };
        await promptForLink(ctx, userId, 'cart');
      }
      return;
    }

    const hasNewAddress = extractAllLinks(rawText).some(link => isValidDeliveryAddressUrl(link)) ||
      Boolean(parseAddressDetails(rawText)?.address) ||
      extractAllLinks(rawText).some(link => isValidSwiggyCartUrl(link)) ||
      Boolean(parseCartDetails(rawText));
    if (hasNewAddress) {
      delete userWaitState[userId];
      state = undefined;
    } else {
      await ctx.reply('📞 Sirf <b>10-digit mobile number</b> bhejein:', { parse_mode: 'HTML' });
      return;
    }
  }

  // Handle in-flight delete OTP initiation (prevents any accidental login trigger while waiting for Swiggy)
  if (state && state.action === 'initiating_swiggy_delete_otp') {
    return ctx.reply('◷ <i>Swiggy Deletion OTP request process ho rahi hai. Kripya thoda intezaar karein...</i>', { parse_mode: 'HTML' });
  }

  // Handle Delete Account OTP (TOP PRIORITY: MUST BE PROCESSED BEFORE ANY PHONE OR LOGIN DETECTOR)
  if (state && state.action === 'waiting_swiggy_delete_otp') {
    const rawCleanDigits = rawText.replace(/[^0-9]/g, '');

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'close'].includes(rawLower)) {
      delete userWaitState[userId];
      return ctx.reply('× <b>Swiggy account deletion cancelled.</b>', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
    }

    const enteredOtp = rawCleanDigits;
    if (enteredOtp.length !== 6) {
      return ctx.reply(
        `! <b>Invalid OTP</b>\n\n› <i>Enter the 6-digit Delete OTP, or type Cancel:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('⌂ Main Menu', 'boss_panel_home'),
              Markup.button.callback('× Close', 'close_menu')
            ]
          ])
        }
      );
    }

    const waitMsg = await ctx.reply('◷ <i>Verifying Delete OTP with Swiggy and deleting account...</i>', { parse_mode: 'HTML' });
    const key = state.accountKey;
    const phone = state.phone;
    const accName = state.accName;

    // Use dedicated verifyAndDeleteSwiggyAccountViaBridge (NEVER calls login or sms-otp)
    const result = await verifyAndDeleteSwiggyAccountViaBridge(userId, enteredOtp, key).catch(err => ({ success: false, message: err.message }));

    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      delete userWaitState[userId];

      try {
        await deactivateSwiggyAccountViaBridge(userId, key, false).catch(() => {});
      } catch (e) {}

      deleteAccount(key, { purgeVault: true });

      await ctx.reply(
        `<blockquote>✓ <b>SWIGGY ACCOUNT DELETED</b></blockquote>\n\n` +
        `☎ <b>Number:</b> <code>${escapeHtml(phone)}</code> (${escapeHtml(accName)})\n` +
        `The account was removed from Swiggy and from this bot. Use Swiggy’s official app/site if you need to manage the number again.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('Open official Swiggy', 'https://www.swiggy.com/')],
            [
              Markup.button.callback('Add Another Account', 'send_to_another_number'),
              Markup.button.callback('Main Menu', 'boss_panel_home')
            ]
          ])
        }
      );
    } else {
      const swiggyText = result.message || 'Invalid or expired OTP';
      if (result.code === 'SWIGGY_SECURITY_CHALLENGE' || result.code === 'SWIGGY_RATE_LIMIT') {
        delete userWaitState[userId];
        await ctx.reply(
          `× <b>${escapeHtml(swiggyText)}</b>\n\n` +
          `The bot did not retry or bypass Swiggy’s security check. Finish deletion in the official settings page, or remove only the saved bot entry.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('Open official Swiggy settings', 'https://www.swiggy.com/my-account/settings')],
              [Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`)],
              [Markup.button.callback('Main Menu', 'boss_panel_home')]
            ])
          }
        );
      } else {
        await ctx.reply(
          `× <b>${escapeHtml(swiggyText)}</b>\n<code>${escapeHtml(phone)}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Copy Number', copy_text: { text: phone } }
                ],
                [
                  { text: 'Resend Delete OTP', callback_data: `boss_swiggy_delete_start_${key}` }
                ],
                [
                  { text: 'Main Menu', callback_data: 'boss_panel_home' },
                  { text: 'Close', callback_data: 'close_menu' }
                ]
              ]
            }
          }
        );
        await ctx.reply('› Enter valid Delete OTP:', {
          reply_markup: {
            force_reply: true,
            input_field_placeholder: 'Enter 6-digit Delete OTP...'
          }
        });
      }
    }
    return;
  }

  // 0: Check if Boss is typing a new account name
  if (state && state.action === 'waiting_new_acc_name') {
    const curDb = getDb();
    const accountsObj = curDb.config?.accounts || {};
    // Prune any abandoned empty unlogged placeholder matching this exact name so Boss is never blocked by a stale cancelled slot!
    const normWanted = String(rawText || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');
    for (const [k, a] of Object.entries(accountsObj)) {
      const aNorm = String(a?.name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');
      if (aNorm === normWanted && !isAccountLoggedInSession(a) && !a?.phone) {
        deleteAccount(k, { purgeVault: false, skipImmediateCloudPush: true });
      }
    }

    const identity = prepareNewSwiggyAccountIdentity(rawText, getDb().config?.accounts || {});
    if (!identity.success) {
      await ctx.reply(
        `! <b>Account name not accepted:</b> ${escapeHtml(identity.error)}\n› Enter a distinct name:`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' } }
      );
      return;
    }
    const { name: accName, key: cleanKey } = identity;
    const orderId = state.orderId;
    delete userWaitState[userId];

    createAccount(cleanKey, accName);
    await ctx.reply(
      `✓ <b>Account "${escapeHtml(accName)}" created.</b>\n\n` +
      `Choose how to connect it to Swiggy:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Phone Number + OTP', `boss_login_acc_otp_${cleanKey}${orderId ? '_' + orderId : ''}`)],
          [Markup.button.callback('Paste Session JSON', `boss_login_acc_json_${cleanKey}${orderId ? '_' + orderId : ''}`)],
          [Markup.button.callback('× Cancel', 'cancel_otp_login')]
        ])
      }
    );
    return;
  }

  // 0B: Check if Boss is typing a new account name for phone login
  if (state && state.action === 'waiting_new_acc_name_for_fast_otp') {
    const identity = prepareNewSwiggyAccountIdentity(rawText, getDb().config?.accounts || {});
    if (!identity.success) {
      await ctx.reply(
        `! <b>Account name not accepted:</b> ${escapeHtml(identity.error)}\n› Enter a distinct name:`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' } }
      );
      return;
    }
    const { name: accName, key: cleanKey } = identity;
    const phone = normalizeIndianMobileNumber(state.phone);
    if (!phone) {
      delete userWaitState[userId];
      await ctx.reply('× Invalid phone number. Start the login again with a standalone 10-digit number or a 12-digit number beginning with 91.');
      return;
    }
    const duplicatePhone = Object.entries(getDb().config?.accounts || {}).find(([, account]) =>
      normalizeIndianMobileNumber(account?.phone || account?.mobile) === phone
    );
    if (duplicatePhone) {
      delete userWaitState[userId];
      const [existingKey, existingAccount] = duplicatePhone;
      await ctx.reply(
        `! This number is already saved as <b>${escapeHtml(existingAccount.name || existingKey)}</b>. Use that account instead of creating a duplicate.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Log in to existing account', `boss_login_acc_otp_${existingKey}`)]]) }
      );
      return;
    }

    delete userWaitState[userId];
    createAccount(cleanKey, accName, phone);
    const result = await requestSwiggyOtpViaBridge(userId, phone, cleanKey, accName);
    if (result.success) {
      userWaitState[userId] = { action: 'waiting_swiggy_otp_bridge', targetAcc: cleanKey, phone, name: accName };
      await ctx.reply(
        otpSentCard(phone, [`◉ <b>Account:</b> ${escapeHtml(accName)}`, `› <i>6-digit OTP yahan type karein:</i>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phone } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${phone}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
    return;
  }

  // 0C: Check if Boss is typing a new account name for JSON import
  if (state && state.action === 'waiting_new_acc_name_for_json') {
    const identity = prepareNewSwiggyAccountIdentity(rawText, getDb().config?.accounts || {});
    if (!identity.success) {
      await ctx.reply(
        `! <b>Account name not accepted:</b> ${escapeHtml(identity.error)}\n› Enter a distinct name:`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' } }
      );
      return;
    }
    const { name: accName, key: cleanKey } = identity;
    const pendingJson = state.pendingJson;
    delete userWaitState[userId];

    createAccount(cleanKey, accName);
    const result = importSessionJson(pendingJson, cleanKey);
    if (result.success) {
      await ctx.reply(
        `✓ <b>Account "${escapeHtml(accName)}" created and session imported.</b>\n` +
        `Phone: <code>${escapeHtml(result.phone || '')}</code>\n` +
        `Account is ● Logged In and ready for orders!`,
        { parse_mode: 'HTML', ...getBossPanelKeyboard() }
      );
    } else {
      await ctx.reply(`× Import error: ${result.message}`);
    }
    return;
  }

  // Free Cash JSON / Cookies claim runner
  if (state && state.action === 'waiting_fc_json') {
    delete userWaitState[userId];
    const textTrimmed = rawText.trim();
    let cookies = null;
    let sessionName = 'Pasted Session';

    try {
      if (textTrimmed.startsWith('{') || textTrimmed.startsWith('[')) {
        const parsed = JSON.parse(textTrimmed);
        if (Array.isArray(parsed)) {
          cookies = parsed;
          sessionName = 'Cookie Array JSON';
        } else if (typeof parsed === 'object' && parsed !== null) {
          cookies = parsed.cookies || (parsed.tid ? `tid=${parsed.tid}; _sid=${parsed.sid || ''}; _session_id=${parsed._session_id || ''}` : null);
          if (parsed.phone || parsed.mobile) {
            sessionName = `Phone: ${parsed.phone || parsed.mobile}`;
          }
        }
      }
    } catch (e) {}

    if (!cookies && (textTrimmed.includes('=') || textTrimmed.includes('tid') || textTrimmed.includes('_session_id'))) {
      cookies = textTrimmed;
      sessionName = 'Raw Cookie String';
    }

    if (!cookies) {
      return ctx.reply('! Invalid format. Kripya valid Swiggy session JSON ya cookies string paste karein.');
    }

    const statusMsg = await ctx.reply('◷ <i>Swiggy Instamart claim engine run ho raha hai... (Checking & Claiming)...</i>', { parse_mode: 'HTML' });
    const res = await claimInstamartFreeCash(cookies);

    if (res.status === 'CLAIMED') {
      const successText = `✓ <b>SUCCESSFULLY CLAIMED!</b> ♥\n\n` +
        `◉ <b>Session:</b> ${sessionName}\n` +
        `₹ <b>Claimed Free Cash:</b> <b>₹${res.amount}</b> (Swiggy Money Added!)\n` +
        `₹ <b>Current Total Balance:</b> <b>₹${res.balance}</b>\n` +
        `▣ <b>Instamart Freebie:</b> UNLOCKED ✓ (Eligible on orders above ₹199!)\n` +
        (res.swiggyOne ? `★ <b>Swiggy One:</b> Active (Free Delivery Included)\n` : `↗ <b>Delivery:</b> Free delivery on Instamart\n`) +
        `\n<i>Mubarak ho! Bot ne account run karke Free Cash claim kar liya hai. Aap is session ko connected accounts me save karke Instamart order place kar sakte hain!</i>`;

      const buttons = [
        [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
        [Markup.button.callback('▣ Save as Connected Account', 'boss_add_new_account_menu')],
        [Markup.button.callback('↻ Claim Another Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } else if (res.status === 'ALREADY_CLAIMED') {
      const alreadyText = `i <b>ALREADY CLAIMED!</b>\n\n` +
        `◉ <b>Session:</b> ${sessionName}\n` +
        `! <b>Status:</b> Is account par Free Cash pehle se claim ho chuka hai.\n` +
        `₹ <b>Available Balance:</b> <b>₹${res.balance}</b>\n\n` +
        `<i>Yeh balance aapke account me already maujood hai. Aap isse Instamart checkout par use kar sakte hain!</i>`;

      const buttons = [
        [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
        [Markup.button.callback('▣ Save as Connected Account', 'boss_add_new_account_menu')],
        [Markup.button.callback('↻ Claim Another Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(alreadyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } else {
      const notEligibleText = `× <b>NOT ELIGIBLE FOR FREE CASH</b>\n\n` +
        `◉ <b>Session:</b> ${sessionName}\n` +
        `₹ <b>Free Cash Balance:</b> ₹0\n\n` +
        `<i>Yeh account is promotional Free Cash offer ke liye eligible nahi hai.\n` +
        `Note: Promo offers Swiggy ke naye accounts ya targeted users ke liye aate hain. Aap dusra JSON try karein!</i>`;

      const buttons = [
        [Markup.button.callback('↻ Try Another JSON / Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(notEligibleText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }

    try {
      await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}
    return;
  }

  // A: Login with JSON / Cookie / Multi-Account Array / Telegram Split-Message Reassembly (>4096 chars!)
  if (splitJsonChunks[userId]) {
    clearTimeout(splitJsonChunks[userId].timer);
    const combined = splitJsonChunks[userId].buf + rawText;
    const extractedCombined = extractSwiggyAccountsListFromInput(combined);
    if (extractedCombined.length > 0) {
      delete splitJsonChunks[userId];
      await handleProcessJsonLogin(ctx, combined, userId);
      return;
    }
    splitJsonChunks[userId].buf = combined;
    splitJsonChunks[userId].timer = setTimeout(() => {
      const leftover = splitJsonChunks[userId]?.buf || '';
      delete splitJsonChunks[userId];
      if (leftover) handleProcessJsonLogin(ctx, leftover, userId).catch(() => {});
    }, 1800);
    return;
  }

  const looksLikeSessionPaste =
    (state && (state.action === 'waiting_json_login' || state.action === 'waiting_json_import')) ||
    ((rawText.startsWith('{') || rawText.startsWith('[') || rawText.startsWith('```') || rawText.includes('_session_tid=')) &&
      /(_session_tid|session_tid|"tid"|"token"|"auth_token"|"access_token"|"cookies"|tid=)/i.test(rawText));

  if (looksLikeSessionPaste) {
    const quickExtracted = extractSwiggyAccountsListFromInput(rawText);
    if (quickExtracted.length > 0) {
      await handleProcessJsonLogin(ctx, rawText, userId);
      return;
    }
    // If Telegram truncated a >4096-char pasted JSON across 2–3 messages, buffer chunk #1 cleanly for 1.8s!
    if ((rawText.startsWith('{') || rawText.startsWith('[') || rawText.startsWith('```')) && rawText.length >= 3500) {
      splitJsonChunks[userId] = {
        buf: rawText,
        timer: setTimeout(() => {
          const leftover = splitJsonChunks[userId]?.buf || '';
          delete splitJsonChunks[userId];
          if (leftover) handleProcessJsonLogin(ctx, leftover, userId).catch(() => {});
        }, 1800)
      };
      return;
    }
    if (state && (state.action === 'waiting_json_login' || state.action === 'waiting_json_import')) {
      return ctx.reply('! Invalid JSON format. Kripya valid Swiggy session JSON, Cookie string, ya .json/.txt file bhejein.');
    }
  }

  // Helper for starting phone number login
  async function triggerPhoneNumberLogin(phoneToLogin, existingAccKey, existingAccName) {
    const pendingOrderId = state?.orderId || null;
    const matchedKey = existingAccKey || findAccountKeyByPhone(getDb().config?.accounts || {}, phoneToLogin) || `acc_${phoneToLogin}`;
    const cleanName = (existingAccName && existingAccName.trim().length >= 2 && !/^user\s*\d*$/i.test(existingAccName.trim()))
      ? existingAccName.trim()
      : null;
    const autoName = cleanName || getDb().config?.accounts?.[matchedKey]?.name || getNextAutoUserName();
    delete userWaitState[userId];

    const result = await requestSwiggyOtpViaBridge(userId, phoneToLogin, matchedKey, autoName);

    if (result.needsName) {
      userWaitState[userId] = {
        action: 'waiting_name_for_new_number_signup',
        phone: phoneToLogin,
        targetAcc: matchedKey,
        orderId: pendingOrderId
      };

      await ctx.reply('› Enter Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Name...'
        }
      });
      return;
    }

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: matchedKey,
        phone: phoneToLogin,
        name: autoName,
        orderId: pendingOrderId
      };

      await ctx.reply(
        otpSentCard(phoneToLogin, [`› <i>6-digit OTP yahan type karein:</i>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phoneToLogin } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phoneToLogin}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${phoneToLogin}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phoneToLogin, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
  }

  // B: Login with Number - Phone Input
  if (state && (state.action === 'waiting_phone_for_number_login' || state.action === 'waiting_phone_for_new_acc_order')) {
    const cleanPhone = extractStandaloneMobileNumber(rawText);
    if (!cleanPhone) {
      await ctx.reply(
        'Send only a standalone 10-digit number or a 12-digit number beginning with 91.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home' },
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter Mobile Number:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: '10 digits, or 91 + 10 digits...'
        }
      });
      return;
    }

    const db = getDb();
    const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === cleanPhone);
    const existingKey = existing ? existing[0] : null;
    const existingName = existing ? (existing[1]?.name || existing[0]) : null;

    await triggerPhoneNumberLogin(cleanPhone, existingKey, existingName);
    return;
  }

  // C: Handle Name for New Swiggy User Signup (auto-handled)
  if (state && state.action === 'waiting_name_for_new_swiggy_signup') {
    const enteredName = rawText.trim() || getNextAutoUserName();
    const cleanPhone = state.phone;
    const orderId = state.orderId;
    delete userWaitState[userId];

    const signupRes = await signupSwiggyViaBridge(userId, enteredName);
    if (signupRes.success) {
      await sendAccountLoginAndOffersCard(ctx, signupRes, userId, orderId);
    } else if (['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(signupRes.code)) {
      const errCard = formatOtpSendErrorCard(cleanPhone, signupRes);
      await ctx.reply(errCard.text, { parse_mode: 'HTML', ...errCard.keyboard });
    } else {
      await ctx.reply(`<blockquote>${escapeHtml(signupRes.message)}</blockquote>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
    }
    return;
  }

  // Handle Name for New Swiggy Number Signup
  if (state && state.action === 'waiting_name_for_new_number_signup') {
    const enteredName = rawText.trim();
    if (!enteredName || enteredName.length < 2 || /^\d+$/.test(enteredName)) {
      await ctx.reply('› Enter Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Name...'
        }
      });
      return;
    }
    const phone = state.phone;
    delete userWaitState[userId];
    await triggerPhoneNumberLogin(phone, `acc_${phone}`, enteredName);
    return;
  }

  // D: Fast Standalone 10-Digit Mobile Number Detection (ONLY bare phone numbers — NEVER URLs, Carts, or Addresses!)
  const cleanPhoneInput = extractStandaloneMobileNumber(rawText);
  if (isBoss(userId) && (!state || !state.action) && cleanPhoneInput) {
    const db = getDb();
    const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === cleanPhoneInput);
    const existingKey = existing ? existing[0] : null;
    const existingName = existing ? (existing[1]?.name || existing[0]) : null;

    await triggerPhoneNumberLogin(cleanPhoneInput, existingKey, existingName);
    return;
  }

  // Step 1: User entered a standalone 10-digit number or 12-digit +91 number for Swiggy login.
  if (state && state.action === 'waiting_phone_for_otp') {
    const targetAcc = state.targetAcc;
    const pendingOrderId = state.orderId || null;
    const cleanPhone = extractStandaloneMobileNumber(rawText);

    if (!cleanPhone) {
      await ctx.reply('Send only a standalone 10-digit number or a 12-digit number beginning with 91.');
      await ctx.reply('› Enter Mobile Number:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: '10 digits, or 91 + 10 digits...'
        }
      });
      return;
    }

    const dbSnapshot = getDb();
    const existingTarget = dbSnapshot.config?.accounts?.[targetAcc];
    const autoName = existingTarget?.name || getNextAutoUserName();
    createAccount(targetAcc, autoName, cleanPhone);
    const result = await requestSwiggyOtpViaBridge(userId, cleanPhone, targetAcc, autoName);

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc,
        phone: cleanPhone,
        name: autoName,
        orderId: pendingOrderId
      };

      await ctx.reply(
        otpSentCard(cleanPhone, [`› <i>6-digit OTP yahan type karein:</i>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: cleanPhone } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${cleanPhone}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${cleanPhone}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      delete userWaitState[userId];
      // If `targetAcc` was a newly created empty slot that never logged in, don't leave a dead orphan slot with wrong/blocked phone!
      const curAcc = getDb().config?.accounts?.[targetAcc];
      if (curAcc && !isAccountLoggedInSession(curAcc) && targetAcc !== `acc_${cleanPhone}`) {
        curAcc.phone = '';
        curAcc.mobile = '';
        const d2 = getDb();
        if (d2.config?.accounts?.[targetAcc] && !isAccountLoggedInSession(d2.config.accounts[targetAcc])) {
          d2.config.accounts[targetAcc].phone = '';
          d2.config.accounts[targetAcc].mobile = '';
          saveDb(d2);
        }
      }
      const errCard = formatOtpSendErrorCard(cleanPhone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
    return;
  }

  // Step 2: User enters 6-digit OTP
  if (state && state.action === 'waiting_swiggy_otp_bridge') {
    // Switch only when the entire message is a standalone valid 10-digit or +91-prefixed phone number.
    const phoneSwitch = extractStandaloneMobileNumber(rawText);
    if (phoneSwitch) {
      delete userWaitState[userId];
      const db = getDb();
      const existingKey = findAccountKeyByPhone(db.config?.accounts || {}, phoneSwitch);
      const existingName = existingKey ? (db.config.accounts[existingKey]?.name || existingKey) : null;

      await ctx.reply(`Switching to number ${phoneSwitch}...`);
      await triggerPhoneNumberLogin(phoneSwitch, existingKey, existingName);
      return;
    }

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'nahi aaya', 'doosra', 'close', 'another', 'change'].includes(rawLower)) {
      return promptBossLoginWithNumber(ctx);
    }

    // Safely extract 6-digit OTP without ever mistaking URLs (`swiggy.com/menu/123456`) or JSONs for an OTP!
    let enteredOtp = '';
    if (!/https?:\/\/|swig\.gy|swiggy\.com|goo\.gl|maps|[{[\]}]/i.test(rawText)) {
      const directOtp = extractStandaloneOtpDigits(rawText);
      if (directOtp && directOtp.length === 6) {
        enteredOtp = directOtp;
      } else {
        const spacedDigits = rawText.trim().match(/^(\d{3})[\s-]+(\d{3})$/);
        if (spacedDigits) {
          enteredOtp = `${spacedDigits[1]}${spacedDigits[2]}`;
        } else {
          const smsCodeMatch = rawText.match(/(?<!\d)(\d{6})(?!\d)/);
          if (smsCodeMatch) enteredOtp = smsCodeMatch[1];
        }
      }
    }

    if (enteredOtp.length !== 6) {
      await ctx.reply(
        `! <b>Exact 6-digit Swiggy OTP enter karein</b>\n☎ <code>${state.phone}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: state.phone } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${state.phone}` },
                { text: '✉ Resend OTP', callback_data: `resend_otp_${state.phone}` }
              ],
              [
                { text: '☎ Another Number', callback_data: 'send_to_another_number' },
                { text: '⌂ Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: '× Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter 6-digit OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
      return;
    }

    const result = await verifySwiggyOtpViaBridge(userId, enteredOtp);

    if (result.success) {
      const orderId = state.orderId;
      delete userWaitState[userId];
      syncCloudVaultNow(getDb()).catch(() => {});
      await sendAccountLoginAndOffersCard(ctx, result, userId, orderId);
      return;
    }

    if (result.isNewUser || result.needsSignup) {
      // Auto-assign sequential name without prompting user
      const autoName = state.name || getNextAutoUserName();
      const signupRes = await signupSwiggyViaBridge(userId, autoName);
      if (signupRes.success) {
        const orderId = state.orderId;
        delete userWaitState[userId];
        syncCloudVaultNow(getDb()).catch(() => {});
        await sendAccountLoginAndOffersCard(ctx, signupRes, userId, orderId);
      } else {
        await ctx.reply(`<blockquote>${escapeHtml(signupRes.message)}</blockquote>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
      }
      return;
    }

    if (['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(result.code)) {
      delete userWaitState[userId];
      const challenge = result.code === 'SWIGGY_SECURITY_CHALLENGE';
      const title = challenge ? 'Swiggy Security Check Blocked Login' : 'Swiggy OTP Limit Reached';
      const reason = result.message || result.swiggyStatus || 'Swiggy stopped this verification.';
      const text = section(title, [
        `☎ <b>Number:</b> <code>${escapeHtml(state.phone)}</code>`,
        `! <b>Swiggy response:</b>`,
        `<blockquote>${escapeHtml(reason)}</blockquote>`,
        `› <i>This bot will not retry or bypass Swiggy security checks. Use the official Swiggy app/site, or import an existing valid session.</i>`
      ].join('\n'));
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('Open official Swiggy', 'https://www.swiggy.com/')],
          [Markup.button.callback('Paste Session JSON', 'boss_login_with_json'), Markup.button.callback('Main Menu', 'boss_panel_home')]
        ])
      });
    } else {
      const swiggyText = result.swiggyStatus || result.message || 'Galat ya expired OTP';
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: state.targetAcc,
        phone: state.phone,
        name: state.name,
        orderId: state.orderId
      };
      await ctx.reply(
        `× <b>Galat OTP / Verification Failed!</b>\n` +
        `☎ <b>Number:</b> <code>${state.phone}</code>\n\n` +
        `! <b>Swiggy Response:</b>\n` +
        `<blockquote>${escapeHtml(swiggyText)}</blockquote>\n` +
        `› <i>Sahi 6-digit OTP dubara type karein ya neeche <b>Re-enter OTP</b> dabayein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${state.phone}` },
                { text: '✉ Resend New OTP', callback_data: `resend_otp_${state.phone}` }
              ],
              [
                { text: '☎ Another Number', callback_data: 'send_to_another_number' },
                { text: '▤ Session JSON', callback_data: 'boss_login_with_json' }
              ],
              [
                { text: '⌂ Main Menu', callback_data: 'boss_panel_home' },
                { text: '× Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Re-enter 6-digit OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    }
    return;
  }



  // Boss sending text to user
  if (state && state.action === 'waiting_text_user') {
    const targetUserId = state.targetUserId;
    const orderId = state.orderId;
    delete userWaitState[userId];

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `✉ <b>Beta ka sandesh (Order #${orderId}):</b>\n\n${escapeHtml(rawText)}`,
        { parse_mode: 'HTML' }
      );
      await ctx.reply(`✓ <b>Message delivered to user!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send message: ${err.message}`);
    }
    return;
  }

  // Boss sending official Swiggy payment link to user
  if (state && (state.action === 'waiting_swiggy_link' || state.action === 'waiting_payment_link')) {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) {
      await ctx.reply('× Order could not be found.');
      return;
    }

    // Only the link is meaningful; markdown wrappers and the note around it are dropped.
    const pastedUrls = extractSharedUrls(rawText);
    let link = pastedUrls[0] || stripSharedLinks(rawText);
    const amtMatch = rawText.match(/(?:₹|rs\.?|inr)?\s*([0-9]{2,5})\b/i);

    if (pastedUrls.length > 0) {
      link = pastedUrls[0];
      if (amtMatch && !link.includes(amtMatch[1])) {
        order.finalPayable = parseInt(amtMatch[1], 10);
      }
    }

    order.swiggyPaymentUrl = link;
    order.paymentStatus = 'PAYMENT_LINK_SENT';
    saveDb(db);
    await updateOrderCards(order);

    const targetUserId = order.userChatId || order.userId;
    if (targetUserId) {
      try {
        const amtText = order.finalPayable ? `\n₹ <b>Payable on Swiggy:</b> ₹${order.finalPayable}` : '';
        await bot.telegram.sendMessage(
          targetUserId,
          `₹ <b>Official Swiggy Payment Link Ready! (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}${amtText}\n\n` +
          `↗ <b>Click to Pay Directly on Swiggy:</b>\n<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>\n\n` +
          `<i>★ Yeh authentic link Swiggy payment page se generated hai. Payment ke baad [ Check payment status ] dabayein!</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('₹ Pay on Swiggy (Official Link)', link)],
              [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)],
              [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
            ])
          }
        );
        await ctx.reply(`✓ <b>Official Swiggy Payment Link delivered to Customer!</b>\n\nLink: <code>${escapeHtml(link)}</code>`, { parse_mode: 'HTML' });
      } catch (err) {
        await ctx.reply(`× Failed to send link to user: ${err.message}`);
      }
    }
    return;
  }

  // Boss setting custom amount
  if (state && state.action === 'waiting_set_amount') {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const num = parseInt(rawText.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(num) && num > 0) {
      const db = getDb();
      const order = db.orders[orderId];
      if (order) {
        order.finalPayable = num;
        order.amountAccepted = false; // User must accept the newly set amount!
        saveDb(db);
        await updateOrderCards(order);
        await ctx.reply(`✓ <b>Payable amount updated to ₹${num}! User ke card par [ Accept Order ] update ho gaya hai.</b>`, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(`! Invalid amount. Please enter a valid number.`);
    }
    return;
  }

  // Boss setting custom coupon code
  if (state && state.action === 'waiting_set_coupon') {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const code = rawText.trim().toUpperCase();
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) {
      await ctx.reply('× Order not found.');
      return;
    }

    const selAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;

    if (code === 'REMOVE' || code === 'NONE' || code === 'CLEAR' || code === '0') {
      const liveRemoved = selAcc?.cookies ? await applyLiveCouponToOrder(selAcc, order, 'REMOVE').catch(() => null) : null;
      order.couponCode = null;
      order.discountAmount = 0;
      if (liveRemoved && liveRemoved.items?.length > 0) {
        order.finalPayable = liveRemoved.finalPayable;
        order.totalSavings = liveRemoved.totalSavings;
        order.swiggyVerified = true;
      } else {
        order.swiggyVerified = false;
        applyMaxOfferToOrder(order);
      }
      saveDb(db);
      await updateOrderCards(order);
      await ctx.reply(`✓ <b>Coupon removed from Order #${orderId}!</b>\nNew Payable: ₹${order.finalPayable}`, { parse_mode: 'HTML' });
      return;
    }

    const liveApplied = selAcc?.cookies ? await applyLiveCouponToOrder(selAcc, order, code).catch(() => null) : null;
    if (liveApplied && liveApplied.items?.length > 0) {
      order.couponCode = liveApplied.couponCode || code;
      order.discountAmount = liveApplied.discountAmount || 0;
      order.deliveryFee = liveApplied.deliveryFee || 0;
      order.packingCharges = liveApplied.packingCharges || 0;
      order.taxesAndCharges = liveApplied.taxesAndCharges || 0;
      order.finalPayable = liveApplied.finalPayable;
      order.totalSavings = liveApplied.totalSavings;
      order.swiggyVerified = true;
    } else {
      let appliedDiscount = 0;
      if (code.includes('70')) {
        appliedDiscount = Math.min(100, Math.round((order.subtotal || 200) * 0.7));
      } else if (code.includes('100')) {
        appliedDiscount = 100;
      } else if (code.includes('125')) {
        appliedDiscount = 125;
      } else if (code.includes('150')) {
        appliedDiscount = 150;
      } else if (code.includes('175')) {
        appliedDiscount = 175;
      } else {
        appliedDiscount = 50;
      }

      order.couponCode = code;
      order.discountAmount = appliedDiscount;
      order.swiggyVerified = false;
      applyMaxOfferToOrder(order);
    }

    saveDb(db);
    await updateOrderCards(order);
    await ctx.reply(
      `✓ <b>Coupon "${escapeHtml(order.couponCode || code)}" Applied Successfully to Order #${orderId}!</b>\n\n` +
      `₹ <b>Discount:</b> −₹${order.discountAmount || 0}\n` +
      `₹ <b>New Payable Amount:</b> <b>₹${order.finalPayable}</b>\n\n` +
      `<i>User aur Boss dono ke card par naya amount update ho gaya hai!</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Boss setting custom UPI ID
  if (state && state.action === 'waiting_set_upi') {
    delete userWaitState[userId];
    const upi = rawText.trim();
    if (upi.includes('@')) {
      const db = getDb();
      db.config.bossUpiId = upi;
      saveDb(db);
      await ctx.reply(`✓ <b>Payment UPI ID saved:</b> <code>${upi}</code>\nAb se sabhi payment QR is UPI ID par generate honge!`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`! Invalid UPI ID format. Should contain '@' (e.g. yourname@paytm).`);
    }
    return;
  }

  // Boss entering a delivery OTP that Swiggy provided outside the live account feed
  if (state && state.action === 'waiting_delivery_otp') {
    const digits = rawText.replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(digits)) {
      await ctx.reply('! Enter only the 4–8 digit delivery OTP that Swiggy provided. Login/payment OTPs are not accepted here.');
      return;
    }
    const orderId = state.orderId;
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) {
      delete userWaitState[userId];
      await ctx.reply('! Order not found.');
      return;
    }
    delete userWaitState[userId];
    order.deliveryOtp = digits;
    order.deliveryOtpSource = 'BOSS_PROVIDED';
    saveDb(db);
    await updateOrderCards(order);
    const firstBossChatId = db.config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
    await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId, order, { force: true });
    await ctx.reply(`✓ Delivery OTP saved and sent with the verified Swiggy tracking link when available.`);
    return;
  }

  // Extract Tracking — works for ANY user (boss or customer) : Swiggy order id se direct scan
  if (state && state.action === 'waiting_boss_extract_tracking') {
    const rawText = String(ctx.message.text || '').trim();
    let q = rawText;
    for (const token of rawText.split(/\s+/).filter(Boolean)) {
      const clean = token.replace(/[^A-Za-z0-9_-]/g, '').trim();
      if (/^\d{10,20}$/.test(clean) || /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(clean)) { q = clean; break; }
    }
    q = q.replace(/[^A-Za-z0-9_-]/g, '').trim() || rawText;
    const db2 = getDb();

    // Exact lookup only: order ref, Swiggy id or pending id. A partial numeric
    // suffix is NEVER used (that used to match the wrong order).
    let order = db2.orders?.[q] || db2.orders?.[q.toLowerCase()] || db2.orders?.[q.toUpperCase()] || null;
    if (!order) {
      const qLower = q.toLowerCase();
      for (const candidate of Object.values(db2.orders || {})) {
        if (!candidate) continue;
        const refMatch = String(candidate.id || '').toLowerCase() === qLower;
        const swiggyMatch = [candidate.swiggyOrderId, candidate.pendingSwiggyOrderId]
          .some(value => String(value || '') === q);
        if (refMatch || swiggyMatch) { order = candidate; break; }
      }
    }

    const isNumericSwiggyId = /^\d{10,20}$/.test(q);
    if (!order && !isNumericSwiggyId) {
      const knownIds = Object.values(db2.orders || {})
        .filter(o => o && String(o.id || '').toUpperCase() !== 'TEST')
        .slice(0, 8)
        .map(o => `#${o.id}`)
        .join(', ') || 'none';
      await ctx.reply(
        `❌ <b>Order <code>${escapeHtml(q)}</code> bot DB me nahi mila.</b>\n\n` +
        `▪ Known order refs: <code>${escapeHtml(knownIds)}</code>\n` +
        `<i>Ya exact Swiggy numeric order id (12–18 digits) bhejein — bot usko har logged-in ID par dhoondhega. Koi false id nahi banega.</i>`,
        { parse_mode: 'HTML' }
      );
      delete userWaitState[ctx.from.id];
      return;
    }

    if (!order) {
      // Transient reference — saved only after Swiggy confirms the order exists.
      order = {
        id: q,
        swiggyOrderId: q,
        pendingSwiggyOrderId: q,
        restaurantName: 'Swiggy Order',
        status: 'UNVERIFIED',
        addressDetails: {},
        createdAt: new Date().toISOString(),
        userId: String(ctx.from.id),
        fwdSenderUserId: String(ctx.from.id),
        userName: ctx.from?.first_name || 'Customer',
        fwdSenderName: ctx.from?.first_name || 'Customer',
        selectedAccount: '',
        trackingLink: '',
        trackingLinkSource: '',
        deliveryOtp: '',
        liveOrderStatus: '',
        isSwiggyIdLookup: true
      };
    }

    const statusMsg = await ctx.reply(
      `⏳ <i>Scanning ${Object.keys(db2.config?.accounts || {}).length} Swiggy IDs for <code>${escapeHtml(q)}</code>…</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    try {
      // IMPORTANT: pass the order OBJECT. Passing `order.id` for a pasted Swiggy
      // id made `findOrderRecord()` return null, so the scan was skipped
      // entirely ("Scanned: 0 IDs") instead of searching all logged-in IDs.
      const result = await ensureOrderTracking(order, { force: true, budgetMs: 20000, deep: true });
      if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }

      const fresh = getDb().orders?.[order.id] || order;
      const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
      const swiggyId = swiggyOrderIdOf(fresh) || (isNumericSwiggyId ? q : '');
      const phone = placedFromPhoneOf(fresh, getDb());
      const rawLiveStatus = String(fresh.liveOrderStatus || result?.orderStatus || '');
      const liveStatus = normalizeSwiggyLiveOrderStatus(rawLiveStatus) || rawLiveStatus;

      if (!result?.hasOrder && !trackingUrl) {
        const noAccounts = result?.status === 'NO_ACCOUNTS' || (Number(result?.scanned) || 0) === 0;
        await ctx.reply(
          noAccounts
            ? `⚠️ <b>Koi logged-in Swiggy ID nahi mila</b> — isliye <code>${escapeHtml(q)}</code> scan nahi ho paya.\n\n` +
              `<i>Boss Panel → accounts login karein, phir dobara try karein.</i>`
            : `❌ <b>Swiggy order <code>${escapeHtml(q)}</code> kisi bhi logged-in ID par nahi mila.</b>\n\n` +
              `▪ IDs scanned: <b>${Number(result?.scanned) || 0}</b>${result?.status === 'TIMEOUT' ? ' (time out)' : ''}\n` +
              scanFailuresLine(result) +
              `▪ <b>Order kisi dusre Swiggy account par hoga</b> — jis account se order hua usko is bot me login karo (<b>My Accounts</b>), phir dobara id bhejo.\n` +
              `<i>Order id bhi verify karo (numeric, 12–18 digits) — Swiggy app: Profile → My Orders. Bot koi false link nahi banata.</i>`,
          { parse_mode: 'HTML' }
        );
        delete userWaitState[ctx.from.id];
        return;
      }

      const saveNow = getDb();
      const rec = saveNow.orders?.[order.id] || fresh;
      if (!saveNow.orders?.[order.id]) {
        rec.isExternalOrder = true;
        rec.isSwiggyIdLookup = true;
        saveNow.orders[rec.id] = rec;
      }
      if (rec.status !== 'COMPLETED') {
        rec.status = 'COMPLETED';
        rec.cardStage = 'PAID_CONFIRMED';
        rec.completedAt = rec.completedAt || new Date().toISOString();
      }
      saveDb(saveNow);

      const isCancelledExtract = /cancel|refus|return/i.test(liveStatus);
      const isDeliveredExtract = /deliv/i.test(liveStatus);
      if (trackingUrl) {
        await ctx.reply(
          `✅ <b>Tracking extracted</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          (liveStatus ? `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>\n` : '') +
          `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open Swiggy tracking</a>` +
          (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
          (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy Tracking', trackingUrl)]])
          }
        );
      } else if (isCancelledExtract) {
        await ctx.reply(
          `✅ <b>Order Swiggy par mil gaya</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>\n\n` +
          `<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`,
          { parse_mode: 'HTML' }
        );
      } else if (isDeliveredExtract) {
        const deliveredExtractUrl = buildSignedOrderTrackUrl(swiggyId || rec.id);
        await ctx.reply(
          `✅ <b>Tracking link ready</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>` +
          (deliveredExtractUrl ? `\n▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredExtractUrl)}">Open order tracking</a>` : '') +
          (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
          (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...Markup.inlineKeyboard([
              ...(deliveredExtractUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredExtractUrl)]] : []),
              [Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]
            ])
          }
        );
      } else {
        await ctx.reply(
          `✅ <b>Order Swiggy par mil gaya</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          `▪ <b>Status:</b> <code>${escapeHtml(liveStatus || 'Order Confirmed')}</code>\n\n` +
          `<i>Share link abhi publish nahi hua — bot background me retry karega aur link aate hi bhej dega.</i>`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]]) }
        );
        startOrderTrackingAuto(rec.id, { force: true, budgetMs: 12000 });
      }

      if (isBoss(ctx.from.id)) {
        const bossCard = formatBossOrderCard(rec);
        await ctx.reply(bossCard.text, { parse_mode: 'HTML', ...bossCard.keyboard }).catch(() => {});
      }
    } catch (e) {
      if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }
      await ctx.reply(`❌ Failed: ${escapeHtml(String(e?.message || e))}`, { parse_mode: 'HTML' });
    }
    delete userWaitState[ctx.from.id];
    return;
  }

  if (state && state.action === 'waiting_tracking') {
    const orderId = state.orderId;
    const candidateLink = extractAllLinks(rawText).find(isOfficialSwiggyTrackingUrl);
    if (!candidateLink) {
      await ctx.reply('! Please paste the official Swiggy tracking URL. An order ID or rider phone is not a tracking link.');
      return;
    }
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('! Order not found.');

    order.trackingLink = candidateLink;
    order.trackingLinkSource = 'BOSS_PROVIDED';
    order.shareTrackUrl = '';
    const bossDisplayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim() || 'Fer aex';
    order.bossName = bossDisplayName;
    order.placedByName = bossDisplayName;
    if (!order.swiggyOrderId && order.pendingSwiggyOrderId) order.swiggyOrderId = order.pendingSwiggyOrderId;
    saveDb(db);
    await updateOrderCards(order);

    const trackingUrl = getStoredSwiggyTrackingUrl(order);
    const displayOrderId = String(order.swiggyOrderId || order.id || '').trim();
    const bossNameEsc = escapeHtml(bossDisplayName);
    const trackEsc = escapeHtml(trackingUrl);
    const otpLine = order.deliveryOtp
      ? `\n<b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';
    try {
      await bot.telegram.sendMessage(
        order.fwdSenderUserId || order.userId,
        `${bossNameEsc} has just placed an order (ID: ${escapeHtml(displayOrderId)}) for you on Swiggy. Click this link to track: <a href="${trackEsc}">${trackEsc}</a>` +
        `${otpLine}`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.url('Open Swiggy tracking', trackingUrl)]])
        }
      );
      // Also trigger SMS to recipient's phone (mirrors Telegram notification)
      sendParentSmsNotification(order, trackingUrl).catch(() => {});
      await ctx.reply(`✓ <b>Swiggy tracking link sent to ${escapeHtml(order.userName || 'customer')}.</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`! Failed to send tracking: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Unified Direct Boss Card Workflow (Non-Blocking 10x Parallel Dispatch!):
  // Supports sharing 10+ different Cart + Address orders rapidly without waiting or overwriting previous orders!
  if (isBoss(userId) && (looksLikeBossOrderInput(rawText) || (state && ['waiting_cart', 'waiting_address'].includes(state.action)))) {
    delete userWaitState[userId];
    void handleBossForwardedOrderInput(ctx, {
      rawText,
      formatOrderBodyFn: formatUserOrderCardText,
      nonBlockingAutoSync: true
    }).catch(e => console.error('[BossDirectOrderIntake]', e));
    return;
  }

  // Direct Order ID paste → instant Extract Tracking offer (user enters Swiggy/Bot order ID anywhere)
  // Fires when text is just an order ID (FWD..., ORD..., or 9-20 digit Swiggy ID) and no active multi-step flow
  {
    const t = String(rawText || '').trim();
    const compact = t.replace(/\s+/g,'');
    const isPlainOrderId = /^\d{9,20}$/.test(compact) || /^(FWD|ORD|FWD_|ORD_|ORD-)[A-Za-z0-9_-]{3,}$/i.test(compact);
    // Only trigger if not already handling cart/address/boss input and text is exactly the ID (not a cart/address URL)
    if (isPlainOrderId && !extractAllLinks(t).length && !isBoss(userId) || isPlainOrderId && isBoss(userId) && !looksLikeBossOrderInput(rawText)) {
      // Avoid double-fire when user is in waiting_boss_extract_tracking (already handled above)
      if (!state || state.action !== 'waiting_boss_extract_tracking') {
        const dbTmp = getDb();
        let found = dbTmp.orders?.[compact] || dbTmp.orders?.[compact.toUpperCase()] || dbTmp.orders?.[compact.toLowerCase()];
        if (!found) {
          const qL = compact.toLowerCase();
          for (const oo of Object.values(dbTmp.orders||{})) {
            if (String(oo.id||'').toLowerCase()===qL || String(oo.swiggyOrderId||'')===compact || String(oo.pendingSwiggyOrderId||'')===compact) { found = oo; break; }
          }
        }
        // If found or looks like Swiggy numeric ID, offer Extract button (don't auto-scan to avoid spam; button triggers scan)
        if (found || /^\d{9,20}$/.test(compact)) {
          const labelId = found ? found.id : compact;
          const displayId = found ? (found.swiggyOrderId || found.id) : compact;
          const existingTrack = found ? getStoredSwiggyTrackingUrl(found) : '';
          const foundLiveStatus = found ? (normalizeSwiggyLiveOrderStatus(found.liveOrderStatus) || String(found.liveOrderStatus || '')) : '';
          const foundDeliveredUrl = !existingTrack && found && /deliv/i.test(foundLiveStatus) && !/cancel|refus|return/i.test(foundLiveStatus)
            ? buildSignedOrderTrackUrl(displayId)
            : '';
          if (existingTrack || foundDeliveredUrl) {
            const activeLink = existingTrack || foundDeliveredUrl;
            await ctx.reply(`🔗 <b>Order #${escapeHtml(String(displayId))} — Tracking available</b>\n<a href="${escapeHtml(activeLink)}">${escapeHtml(activeLink)}</a>` + (found?.deliveryOtp ? `\n🔢 OTP: <code>${escapeHtml(String(found.deliveryOtp))}</code>` : ''), { parse_mode:'HTML', link_preview_options:{is_disabled:true}, ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Order Tracking', activeLink)] , [Markup.button.callback('🔄 Refresh Tracking', `extract_now_${labelId}`)]]) }).catch(()=>{});
          } else {
            await ctx.reply(`📦 <b>Order #${escapeHtml(String(displayId))} detected</b>\nTap below to extract its live Swiggy tracking link (scans all logged-in Swiggy IDs):`, { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔗 Extract Tracking Link', `extract_now_${labelId}`)], [Markup.button.callback('📋 Copy Order ID', `copy_text_${labelId}`)]]) }).catch(()=>{});
          }
          // Don't return — let normal flow continue if this was actually a cart? But plain ID is not cart, so stop here
          if (isPlainOrderId) return;
        }
      }
    }
  }

  // Direct, flexible user input: accept Cart OR Address (or both together!) in ANY order,
  // even if the user previously tapped the other button! Only show a short 1-line hint if
  // the message contains neither a valid cart nor a valid delivery address.
  const allLinks = extractAllLinks(rawText);
  const validCartLink = allLinks.find(l => isValidSwiggyCartUrl(l));
  const validAddrLink = allLinks.find(l => isValidDeliveryAddressUrl(l));
  const parsedCartDirect = parseCartDetails(rawText);
  const parsedAddrDirect = parseAddressDetails(rawText);
  const hasAnyValidOrderInput = Boolean(validCartLink || validAddrLink || parsedCartDirect || parsedAddrDirect);

  if (!hasAnyValidOrderInput && state && (state.action === 'waiting_cart' || state.action === 'waiting_address')) {
    const askingCart = state.action === 'waiting_cart';
    await ctx.reply(
      askingCart
        ? '🟠 Sahi <b>Cart link</b> bhejein 👇'
        : '🟠 Sahi <b>Address link</b> ya Location bhejein 👇',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            askingCart
              ? { text: '🟠 🛒 Cart Link', callback_data: 'action_paste_cart', style: 'danger' }
              : { text: '🟠 📍 Address Link', callback_data: 'action_paste_address', style: 'danger' }
          ]
        ])
      }
    );
    return;
  }

  // Unified Ingestion (Links OR Structured Receipt/Address text pasted directly, in any order)
  if (allLinks.length > 0 || hasAnyValidOrderInput) {
    let addedCart = false;
    let addedAddress = false;
    let hadFake = false;

    if (validCartLink || parsedCartDirect) {
      let cartMeta = null;
      if (validCartLink) {
        try { cartMeta = await resolveSwiggyLink(validCartLink); } catch (e) {}
      }
      const mergedCartDetails = {
        ...(parsedCartDirect || {}),
        ...(cartMeta?.cartDetails || {})
      };
      if (cartMeta?.restaurantName && !mergedCartDetails.restaurantName) {
        mergedCartDetails.restaurantName = cartMeta.restaurantName;
      }
      updateDraft(userId, {
        cart: validCartLink || 'https://www.swiggy.com/cart',
        ...(cartMeta?.restaurantId ? { restaurantId: cartMeta.restaurantId } : {}),
        ...(cartMeta?.groupCartId ? { groupCartId: cartMeta.groupCartId } : {}),
        ...(cartMeta?.hostName ? { hostName: cartMeta.hostName } : {}),
        cartDetails: mergedCartDetails
      });
      addedCart = true;
    }

    if (parsedAddrDirect || validAddrLink) {
      let geoAddr = parsedAddrDirect;
      try {
        const addrMeta = await resolveSwiggyLink(validAddrLink || rawText);
        if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
          geoAddr = { ...(geoAddr || {}), ...addrMeta.addressDetails };
        } else if (geoAddr) {
          geoAddr = await geocodeAddressDetails(geoAddr);
        }
      } catch (e) {}

      // NEVER overwrite clean street address with bare JgkQ URL!
      updateDraft(userId, {
        address: geoAddr?.address || validAddrLink || `${geoAddr?.city || 'Delivery'} Address`,
        // Link-shared messages: store the resolved address, never the pasted chat text.
        addressOriginalText: geoAddr?.address || validAddrLink || stripSharedLinks(rawText),
        ...(validAddrLink ? { addressLink: validAddrLink } : {}),
        ...(geoAddr ? { addressDetails: geoAddr } : {})
      });
      addedAddress = true;
    }

    for (const l of allLinks) {
      if (!isValidSwiggyCartUrl(l) && !isValidDeliveryAddressUrl(l) && !parsedCartDirect && !parsedAddrDirect) {
        hadFake = true;
      }
    }

    delete userWaitState[userId];
    const curDraft = getDraft(userId);

    if (hadFake && !addedCart && !addedAddress) {
      await ctx.reply(
        '🟠 Sahi <b>Cart</b> ya <b>Address link</b> bhejein 👇',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              { text: '🟠 🛒 Cart Link', callback_data: 'action_paste_cart', style: 'danger' },
              { text: '🟠 📍 Address Link', callback_data: 'action_paste_address', style: 'danger' }
            ]
          ])
        }
      );
      return;
    }

    let nextPrompt = '';
    if (curDraft.cart && curDraft.address) {
      delete userWaitState[userId];
    } else if (addedCart && !curDraft.address) {
      userWaitState[userId] = { action: 'waiting_address' };
      nextPrompt = 'address';
    } else if (addedAddress && !curDraft.cart) {
      userWaitState[userId] = { action: 'waiting_cart' };
      nextPrompt = 'cart';
    }
    const savedNotice = addedCart && addedAddress
      ? '✓ Cart & Address saved'
      : (addedCart ? '✓ Cart link saved' : '✓ Address link saved');
    // One card only: the pasted link message is deleted, card shows items +
    // address and Send to Beta becomes the single next action.
    await renderUserCard(ctx, userId, { deleteIncoming: true, notice: savedNotice });
    if (nextPrompt) await promptForLink(ctx, userId, nextPrompt);
    return;
  }

  // Plain text fallback for normal users — single clean card, zero extra lecture bubbles
  if (!isBoss(userId)) {
    await renderUserCard(ctx, userId, { notice: '🟠 Link bhejein' });
    return;
  }

  // Fallback for Boss
  if (isBoss(userId)) {
    await ctx.reply(bossPanelCard(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  }
});

// Telegram Location Pin & Live Location Handler (Instant Swiggy Reverse Geocoding!)
async function handleIncomingTelegramLocation(ctx, loc) {
  if (!loc || loc.latitude === undefined || loc.longitude === undefined) return;
  const userId = ctx.from.id;
  const lat = String(loc.latitude);
  const lng = String(loc.longitude);
  if (!isValidIndianDeliveryCoordinates(lat, lng)) {
    await ctx.reply('🟠 Sirf India ki delivery location bhejein.', { parse_mode: 'HTML' });
    return;
  }

  const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
  const resolvedAddr = {
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
    mobile: '',
    city: rev?.city || 'Delivery',
    area: rev?.area || '',
    landmark: rev?.landmark || '',
    address: rev?.address || `Pinned Location (${lat}, ${lng})`,
    lat,
    lng
  };

  userWaitState[userId] = { action: 'waiting_recipient_mobile' };
  updateDraft(userId, {
    address: resolvedAddr.address,
    addressOriginalText: `${resolvedAddr.address}\nLatitude: ${lat}\nLongitude: ${lng}`,
    addressLink: `https://maps.google.com/?q=${lat},${lng}`,
    addressDetails: resolvedAddr
  });

  await renderUserCard(ctx, userId, { deleteIncoming: true, notice: '✓ Location saved' });
  const mobilePrompt = await ctx.reply(
    '📞 <b>Delivery mobile number</b> bhejein (10 digit):',
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: '10-digit mobile number...'
      }
    }
  ).catch(() => null);
  if (mobilePrompt) rememberUserPrompt(userId, mobilePrompt);
}

bot.on('location', async (ctx) => {
  if (ctx.from?.id && isBoss(ctx.from.id)) {
    const userId = ctx.from.id;
    const state = userWaitState[userId];
    if (state?.action === 'waiting_boss_order_address') {
      const update = await applyBossOrderUpdate({
        telegram: ctx.telegram,
        bossChatId: ctx.chat.id,
        orderId: state.orderId,
        location: ctx.message?.location,
        formatOrderBodyFn: formatUserOrderCardText
      });
      if (update.ok) {
        delete userWaitState[userId];
        await ctx.reply(`✓ ${escapeHtml(update.message || 'Delivery pin saved.')}`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`! ${escapeHtml(update.error || 'Could not save this delivery pin.')}`, { parse_mode: 'HTML' });
      }
      return;
    }
    if (state?.action === 'waiting_boss_order_cart' || state?.action === 'waiting_boss_order_mobile') {
      await ctx.reply('! This prompt needs text. Use its Cart or recipient-mobile prompt, or choose the Address button to send a location pin.');
      return;
    }
    delete userWaitState[userId];
    void handleBossForwardedOrderInput(ctx, {
      location: ctx.message?.location,
      formatOrderBodyFn: formatUserOrderCardText,
      nonBlockingAutoSync: true
    }).catch(e => console.error('[BossLocOrderIntake]', e));
    return;
  }
  await handleIncomingTelegramLocation(ctx, ctx.message?.location);
});

bot.on('edited_message', async (ctx) => {
  if (ctx.editedMessage?.location) {
    const userId = ctx.editedMessage.from?.id;
    if (!userId) return;
    const lat = String(ctx.editedMessage.location.latitude);
    const lng = String(ctx.editedMessage.location.longitude);
    const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
    if (rev) {
      updateDraft(userId, {
        address: rev.address,
        addressOriginalText: `${rev.address}\nLatitude: ${lat}\nLongitude: ${lng}`,
        addressLink: `https://maps.google.com/?q=${lat},${lng}`,
        addressDetails: {
          name: [ctx.editedMessage.from.first_name, ctx.editedMessage.from.last_name].filter(Boolean).join(' ') || 'Customer',
          mobile: '',
          city: rev.city || 'Delivery',
          area: rev.area || '',
          landmark: rev.landmark || '',
          address: rev.address,
          lat,
          lng
        }
      });
    }
  }
});

// Setup Boss UPI Command (/setupi <vpa>)
bot.command(['setupi', 'set_upi'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length > 1 && parts[1].includes('@')) {
    const upi = parts[1].trim();
    const db = getDb();
    db.config.bossUpiId = upi;
    saveDb(db);
    return ctx.reply(`✓ <b>Payment UPI ID saved:</b> <code>${upi}</code>\nAb se sabhi payment QR is UPI ID par generate honge!`, { parse_mode: 'HTML' });
  }
  userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
  const currentUpi = getDb().config?.bossUpiId || '6296591407@ybl';
  await ctx.reply(
    `₹ <b>Set Boss Payment UPI ID:</b>\n\n` +
    `Current UPI ID: <code>${escapeHtml(currentUpi)}</code>\n\n` +
    `Apna UPI ID reply karein (e.g. <code>6296591407@ybl</code> ya <code>name@okaxis</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' }
    }
  );
});

// ================= USER FLOWCHART & BOTTOM BUTTON HANDLERS =================

// Cart Link Flow (asks confirmation before replacing an already-saved Cart Link, otherwise asks to paste the link)
async function handleCartLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (draft.cart) {
    return ctx.reply(
      `🟠 <b>Cart link badalna hai?</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            { text: '🟠 Haan, Naya Link', callback_data: 'action_confirm_change_cart', style: 'danger' },
            { text: '🟢 Yahi Rakhein', callback_data: 'action_cancel_change_link', style: 'success' }
          ]
        ])
      }
    );
  }
  userWaitState[userId] = { action: 'waiting_cart' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'cart');
}

// Address Link Flow (asks short confirmation before replacing an already-saved Address Link)
async function handleAddressLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (draft.address) {
    return ctx.reply(
      `🟠 <b>Address link badalna hai?</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            { text: '🟠 Haan, Naya Address', callback_data: 'action_confirm_change_address', style: 'danger' },
            { text: '🟢 Yahi Rakhein', callback_data: 'action_cancel_change_link', style: 'success' }
          ]
        ])
      }
    );
  }
  userWaitState[userId] = { action: 'waiting_address' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'address');
}

// Cancel Order with short colorful Confirmation
async function handleCancelOrderConfirm(ctx, orderId = null) {
  const userId = ctx.from.id;
  const db = getDb();
  const activeOrder = orderId ? db.orders[orderId] : getActiveUserOrder(userId);
  const draft = getDraft(userId);

  if (!activeOrder && !draft.cart && !draft.address) {
    return ctx.reply('i <b>Abhi koi active order ya draft nahi hai.</b>', { parse_mode: 'HTML' });
  }

  const targetId = activeOrder ? activeOrder.id : 'draft';
  const text = activeOrder
    ? `⚠️ <b>Order #${activeOrder.id} cancel karein?</b>\n<b>${escapeHtml(activeOrder.restaurantName || 'Swiggy Order')}</b>${activeOrder.finalPayable ? ` · ₹${activeOrder.finalPayable}` : ''}`
    : `⚠️ <b>Draft clear karein?</b>`;

  const buttons = [
    [
      { text: '✖ Haan, Cancel', callback_data: `user_confirm_cancel_${targetId}`, style: 'danger' },
      { text: '🟢 Nahi, Rakhein', callback_data: `user_keep_order_${targetId}`, style: 'success' }
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// Previous Order Flow (FigJam: "show order card in short")
async function handlePreviousOrder(ctx) {
  const userId = ctx.from.id;
  const db = getDb();
  const userOrders = Object.values(db.orders || {})
    .filter(o => Number(o.userId) === Number(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (userOrders.length === 0) {
    return ctx.reply('<b>Koi previous order nahi mila!</b>\nAap pehli baar order place karne ke liye cart aur address link attach karein.', {
      parse_mode: 'HTML'
    });
  }

  const prev = userOrders[0];
  const previousTrackingLink = getStoredSwiggyTrackingUrl(prev);
  let statusBadge = prev.status;
  if (prev.status === 'COMPLETED') statusBadge = 'DELIVERED';
  else if (prev.status === 'CANCELLED') statusBadge = 'CANCELLED';
  else if (prev.status === 'REJECTED') statusBadge = 'REJECTED';
  else if (prev.status === 'ACCEPTED') statusBadge = 'IN PROGRESS';

  const dateStr = new Date(prev.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  const shortText = `<b>PREVIOUS ORDER SUMMARY (#${prev.id})</b>\n\n` +
    `▣ <b>Restaurant:</b> ${escapeHtml(prev.restaurantName || 'Swiggy Order')}\n` +
    `◷ <b>Date:</b> ${dateStr}\n` +
    `▪ <b>Items:</b> ${prev.items && prev.items.length > 0 ? prev.items.map(i => `${escapeHtml(i.name)} (x${i.qty || i.quantity || 1})`).join(', ') : (prev.cart ? 'Swiggy Cart Items' : 'Voice/Photo Order')}\n` +
    `₹ <b>Total amount:</b> ₹${prev.finalPayable || prev.subtotal || 0}\n` +
    `● <b>Status:</b> <b>${statusBadge}</b>\n` +
    (previousTrackingLink ? `\n↗ <b>Swiggy tracking:</b> <a href="${escapeHtml(previousTrackingLink)}">Open tracking link</a>\n` : '') +
    (prev.deliveryOtp ? `<b>Delivery OTP:</b> <code>${escapeHtml(String(prev.deliveryOtp))}</code>\n` : '');

  const buttons = [];
  if (previousTrackingLink) {
    buttons.push([Markup.button.url('Open Swiggy tracking', previousTrackingLink)]);
  }
  if (prev.cart && prev.cart.startsWith('http')) {
    buttons.push([Markup.button.url('View Swiggy Cart', prev.cart)]);
  }
  buttons.push([Markup.button.callback('Back to Main Screen', 'user_back_to_main')]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(shortText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(shortText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// Send to Admin Flow (User Diagram: when both links present, user can Send to Admin; Admin decides whether to accept and generate QR)
// Send to Beta with something missing: wipe the previous card/messages so the
// chat never piles up, then ask ONLY for what is still required.
async function resetCardAndAskForMissing(ctx, userId, missing) {
  const chatId = ctx.chat?.id || userId;
  const state = await cleanupUserChat(ctx.telegram, chatId, userId, { deleteCard: true });
  state.messageId = null;
  if (missing === 'cart') {
    userWaitState[userId] = { action: 'waiting_cart' };
    await ctx.reply(
      '🟠 <b>Cart link missing</b> — bhejein 👇',
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await promptForLink(ctx, userId, 'cart');
    return;
  }
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    '🟠 <b>Delivery address missing</b> — bhejein 👇',
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await promptForLink(ctx, userId, 'address');
}

async function handleSendToBoss(ctx) {
  const userId = ctx.from.id;

  // 1. Check if user already has an active order
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return ctx.reply(
      `⚠️ <b>Order #${activeOrder.id} pehle se chal raha hai!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [{ text: '↻ Refresh Status', callback_data: `user_refresh_status_${activeOrder.id}`, style: 'primary' }],
          [{ text: `✖ Cancel Order #${activeOrder.id}`, callback_data: `user_confirm_cancel_${activeOrder.id}`, style: 'danger' }]
        ])
      }
    );
  }

  // 2. Both cart and address must be present — otherwise the old card is deleted
  // and the customer is asked only for the missing link.
  let draft = getDraft(userId);
  if (!draft.cart) return resetCardAndAskForMissing(ctx, userId, 'cart');
  if (!draft.address) return resetCardAndAskForMissing(ctx, userId, 'address');

  let deliveryDetails = { ...(draft.addressDetails || {}) };
  const addressSource = draft.addressOriginalText || draft.address;
  const addressLink = draft.addressLink || extractAddressShareUrl(addressSource) || (isAddressShareUrl(addressSource) ? addressSource : '');

  if (addressLink) {
    // URL-FIRST: the shared Swiggy address link is the only source of delivery
    // data. Never merge name / mobile / area from the pasted chat text.
    try {
      const addrMeta = await resolveSwiggyLink(addressLink);
      const resolvedAd = addrMeta?.addressDetails;
      if (resolvedAd && !resolvedAd.unresolvableShortLink) {
        deliveryDetails = { ...resolvedAd };
      } else {
        deliveryDetails = { ...deliveryDetails, unresolvableShortLink: true };
      }
    } catch (e) {}
  } else {
    // Plain-text address / GPS pin — the message itself is the source.
    const parsedAddress = parseAddressDetails(addressSource);
    if (parsedAddress) {
      for (const [key, value] of Object.entries(parsedAddress)) {
        if (value !== null && value !== undefined && value !== '') deliveryDetails[key] = value;
      }
    }
  }

  if (addressLink && deliveryDetails.unresolvableShortLink) {
    userWaitState[userId] = { action: 'waiting_address' };
    return ctx.reply(
      `🟠 <b>Address link expire ho gaya</b> — naya link ya Location bhejein 👇`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[{ text: '🟠 📍 Address Link', callback_data: 'action_paste_address', style: 'danger' }]])
      }
    );
  }

  const explicitRecipientMobile = normalizeDeliveryContact(deliveryDetails.mobile);
  if (!explicitRecipientMobile) {
    userWaitState[userId] = { action: 'waiting_recipient_mobile' };
    return ctx.reply(
      `📞 <b>Delivery mobile number</b> bhejein (10 digit):`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: '10-digit mobile number...'
        }
      }
    );
  }
  deliveryDetails.mobile = explicitRecipientMobile;
  updateDraft(userId, { addressDetails: deliveryDetails });
  draft = getDraft(userId);

  const db = getDb();
  const orderId = generateOrderId();
  const role = getFamilyRole(userId, 'Ammi');

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username ? `@${ctx.from.username}` : null,
    type: 'SWIGGY_ORDER',
    address: draft.addressDetails?.address || draft.address,
    addressOriginalText: draft.addressOriginalText || draft.address || '',
    addressLink: draft.addressLink || extractAddressShareUrl(draft.addressOriginalText || draft.address) || null,
    cart: draft.cart,
    restaurantId: draft.restaurantId || null,
    groupCartId: draft.groupCartId || null,
    hostName: draft.hostName || null,
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString(),
    userChatId: userId,
    userMessageId: ctx.callbackQuery?.message?.message_id || null,
    bossMessageIds: {}
  };

  if (draft.addressDetails) newOrder.addressDetails = draft.addressDetails;
  if (draft.cartDetails) {
    const cd = draft.cartDetails;
    if (cd.restaurantName) newOrder.restaurantName = cd.restaurantName;
    // NEVER copy the "Order Account" phone from pasted cart text: the account used
    // for the order is the Swiggy account selected by the bot, not the pasted number.
    if (cd.items && cd.items.length > 0) newOrder.items = cd.items;
    if (cd.itemsTotal > 0) { newOrder.itemTotal = cd.itemsTotal; newOrder.subtotal = cd.itemsTotal; }
    if (cd.tradeDiscountTotal > 0) newOrder.tradeDiscountTotal = cd.tradeDiscountTotal;
    if (cd.couponCode) { newOrder.couponCode = cd.couponCode; newOrder.discountAmount = cd.discountAmount; }
    if (cd.freeCashApplied > 0) newOrder.freeCashApplied = cd.freeCashApplied;
    if (cd.freeDelivery) { newOrder.swiggyOneApplied = true; newOrder.freeDeliveryDiscount = cd.deliverySaved || 0; }
    if (cd.packingCharges > 0) newOrder.packingCharges = cd.packingCharges;
    if (cd.gstCharges > 0) newOrder.taxesAndCharges = cd.gstCharges;
    if (cd.totalSavings > 0) newOrder.totalSavings = cd.totalSavings;
    if (cd.finalPayable > 0) newOrder.finalPayable = cd.finalPayable;
    else applyMaxOfferToOrder(newOrder);
  }

  // Fallback: If items are missing, resolve directly from live cart link (<150ms for group carts!)
  if (!newOrder.items || newOrder.items.length === 0) {
    try {
      const linkMeta = await resolveSwiggyLink(newOrder.cart);
      if (linkMeta?.restaurantId) newOrder.restaurantId = linkMeta.restaurantId;
      if (linkMeta?.groupCartId) newOrder.groupCartId = linkMeta.groupCartId;
      if (linkMeta?.hostName) newOrder.hostName = linkMeta.hostName;
      if (linkMeta?.cartDetails?.items?.length > 0) {
        newOrder.items = linkMeta.cartDetails.items;
        if (!newOrder.restaurantName) newOrder.restaurantName = linkMeta.restaurantName;
        if (!newOrder.subtotal) {
          newOrder.subtotal = linkMeta.cartDetails.subtotal || linkMeta.cartDetails.itemsTotal;
          newOrder.itemTotal = newOrder.subtotal;
        }
        if (linkMeta.cartDetails.tradeDiscountTotal > 0) newOrder.tradeDiscountTotal = linkMeta.cartDetails.tradeDiscountTotal;
        if (linkMeta.cartDetails.packingCharges > 0) newOrder.packingCharges = linkMeta.cartDetails.packingCharges;
        if (linkMeta.cartDetails.gstCharges > 0) newOrder.taxesAndCharges = linkMeta.cartDetails.gstCharges;
        applyMaxOfferToOrder(newOrder);
      }
    } catch (e) {}
  }

  // Fallback: If addressDetails is missing, resolve directly from address text/link without clobbering
  if (!newOrder.addressDetails && (newOrder.addressOriginalText || newOrder.address)) {
    try {
      // Prefer the address share link itself; never hand the whole pasted text to the resolver.
      const addrLinkForOrder = extractAddressShareUrl(newOrder.addressOriginalText || newOrder.address);
      const addrMeta = await resolveSwiggyLink(addrLinkForOrder || newOrder.addressOriginalText || newOrder.address);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        newOrder.addressDetails = addrMeta.addressDetails;
        if (addrMeta.addressDetails.address) newOrder.address = addrMeta.addressDetails.address;
      }
    } catch (e) {}
  }

  // Loophole fix: block ₹0 empty orders (e.g. tracking link mis-parsed as cart)
  const hasItems = Array.isArray(newOrder.items) && newOrder.items.length > 0;
  const hasValue = Number(newOrder.subtotal || newOrder.itemTotal || newOrder.finalPayable || 0) > 0;
  if (!hasItems && !hasValue) {
    return ctx.reply(
      `❌ <b>Cart khali hai — order nahi ban sakta</b>\n\nKripya sahi Swiggy cart link bhejein (<code>https://swig.gy/gc/...</code>) — tracking link se order nahi banta.`,
      { parse_mode: 'HTML' }
    );
  }

  db.orders[orderId] = newOrder;
  saveDb(db);
  clearDraft(userId);

  // Track the same single card the customer has been using since the links.
  if (ctx.callbackQuery?.message?.message_id) {
    rememberUserCard(userId, ctx.callbackQuery.message);
  }

  // Edit User's single card in-place if initiated via inline button, else send and save message ID
  const userCard = formatUserOrderCard(newOrder);
  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.editMessageText(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
    } catch (e) {
      const msg = await ctx.reply(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
      newOrder.userMessageId = msg.message_id;
    }
  } else {
    const msg = await ctx.reply(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
    newOrder.userMessageId = msg.message_id;
  }

  // Deliver single card to Boss so Admin can DECIDE
  const bossCard = formatBossOrderCard(newOrder);
  const bossList = [...new Set([...(db.config.bossIds || []), ...(isBoss(userId) ? [userId] : [])])];
  for (const bossId of bossList) {
    try {
      const bossMsg = await sendCardSafe(bossId, bossCard);
      newOrder.bossMessageIds[bossId] = bossMsg?.message_id;
      console.log(`✓ Successfully sent Order #${orderId} to Boss: ${bossId}`);
    } catch (e) {
      console.error(`× Failed to send Order #${orderId} to Boss ${bossId}:`, e.message);
    }
  }
  saveDb(db);

  // Background pipeline for customer submissions — same treatment as a forwarded order:
  // 1) resolve the live cart + address, 2) auto-pick the best account, 3) lock the max offer.
  triggerBackgroundCartFetch(orderId)
    .then(() => autoOptimizeUserOrder(orderId, { reason: 'CUSTOMER_SEND_TO_BETA' }))
    .catch(err => console.error(`[BackgroundFetch] Order #${orderId} error:`, err?.stack || err?.message || err));
}

// Action Callbacks for User Screen & Flowchart
bot.action('action_add_cart', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCartLinkFlow(ctx);
});

bot.action(['action_paste_cart', 'action_force_change_cart', 'action_change_cart_link', 'action_confirm_change_cart'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_cart' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'cart');
});

bot.action('action_add_address', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleAddressLinkFlow(ctx);
});

bot.action(['action_paste_address', 'action_force_change_address', 'action_change_address_link', 'action_confirm_change_address'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_address' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'address');
});

bot.action('action_cancel_change_link', async (ctx) => {
  await ctx.answerCbQuery('Link preserved ●').catch(() => {});
  const userId = ctx.from.id;
  // Keep editing the existing card instead of posting another copy of the screen.
  await renderUserCard(ctx, userId);
});

bot.action(['action_send_to_admin', 'action_send_to_boss', 'action_send_to_beta', 'action_send_order_to_beta'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleSendToBoss(ctx);
});

bot.action('action_cancel_order_confirm', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCancelOrderConfirm(ctx);
});

bot.action(/^action_cancel_order_confirm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const orderId = ctx.match[1];
  await handleCancelOrderConfirm(ctx, orderId);
});

bot.action(/^user_confirm_cancel_(.+)$/, async (ctx) => {
  const target = ctx.match[1];
  const userId = ctx.from.id;

  if (target === 'draft') {
    clearDraft(userId);
    userChatCards.delete(String(userId));
    const screen = getUserScreen(userId, ctx.from);
    await ctx.answerCbQuery('Draft Cleared').catch(() => {});
    try {
      await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    } catch (e) {
      await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    }
    return;
  }

  const db = getDb();
  const order = db.orders[target];
  if (!order) {
    return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});
  }

  // Security check: Must be the order's customer or boss
  if (Number(order.userId) !== Number(userId) && !isBoss(userId)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }

  // State machine transition check
  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  saveDb(db);
  try { stopOrderTrackingAuto(order.id); } catch {}
  clearDraft(userId);

  await ctx.answerCbQuery('Order Cancelled ●').catch(() => {});

  // 1. Delete message from current chat
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // 2. Delete card messages from user and boss chats
  await deleteOrderMessages(order);
  userChatCards.delete(String(userId));

  // 3. Notify bosses with View Cancelled Orders button
  for (const bossId of db.config.bossIds) {
    try {
      const userProfileUrl = `tg://user?id=${order.userId}`;
      await bot.telegram.sendMessage(
        bossId,
        `● <b><a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> ne Order #${order.id} CANCEL kar diya hai!</b>\n` +
        `# <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n\n` +
        `<i>Card chat se delete kar diya gaya hai.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('× View Cancelled Orders', 'boss_view_cancelled_orders')]
          ])
        }
      );
    } catch (e) {}
  }

  await ctx.reply('× <b>Order cancel ho gaya aur message delete kar diya gaya hai!</b>\n\nAap naya order bhej sakte hain.', { parse_mode: 'HTML' });
  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(/^user_keep_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Order active hai ●').catch(() => {});
  const userId = ctx.from.id;
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.action('action_previous_order', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handlePreviousOrder(ctx);
});

bot.action('user_back_to_main', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  if (isBoss(userId)) {
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  } else {
    const screen = getUserScreen(userId, ctx.from);
    try {
      await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    } catch (e) {
      await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    }
  }
});

bot.action(/^user_refresh_status_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }
  await ctx.answerCbQuery('Status Refreshed ↻').catch(() => {});
  const card = formatUserOrderCard(order);
  try {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
  } catch (e) {}

  // Customer can retry the account / max-offer scan straight from their card.
  if (
    !order.isForwardedOrder &&
    !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status) &&
    (!order.selectedAccount || !(Number(order.finalPayable || 0) > 0))
  ) {
    autoOptimizeUserOrder(orderId, { reason: 'CUSTOMER_REFRESH_STATUS' }).catch(err =>
      console.error(`[AutoOptimize] refresh retry failed for #${orderId}:`, err?.message || err)
    );
  }
});

bot.action('user_reset', async (ctx) => {
  await ctx.answerCbQuery('Form cleared').catch(() => {});
  clearDraft(ctx.from.id);
  const screen = getUserScreen(ctx.from.id, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

// ================= SWIGGY WORLD BOT FEATURES =================

// 1. Saved Addresses
async function handleSavedAddresses(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(
      `! <b>${acc?.name || activeKey} is not logged in!</b>\n\nPehle [ ◉ My Swiggy Accounts ] me jakar account login karein.`,
      { parse_mode: 'HTML' }
    );
  }

  const waitMsg = await ctx.reply(`⌕ <i>Fetching saved addresses from ${escapeHtml(acc.name || activeKey)}'s Swiggy account...</i>`, { parse_mode: 'HTML' });
  const addresses = await fetchAccountAddresses(acc);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!addresses || addresses.length === 0) {
    return ctx.reply(`⌖ <b>No saved addresses found in ${acc.name || activeKey}'s account.</b>`, { parse_mode: 'HTML' });
  }

  let text = `<b>Saved Addresses</b>\n\n`;
  for (const addr of addresses) {
    text += `<b>${escapeHtml(addr.city)} Address</b>\n` +
      `${escapeHtml(addr.name)} <code>${escapeHtml(addr.mobile)}</code>\n` +
      `${escapeHtml(addr.address)}\n` +
      `Latitude: ${addr.lat}\n` +
      `Longitude: ${addr.lng}\n\n`;
  }

  const buttons = [
    [Markup.button.callback('↻ Refresh Addresses', `acc_view_addrs_${activeKey}`)],
    [Markup.button.callback('◉ Switch Account', 'acc_refresh_list')]
  ];

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.hears('⌖ Saved Addresses', async (ctx) => handleSavedAddresses(ctx));
bot.command('addresses', async (ctx) => handleSavedAddresses(ctx));
bot.action('action_refresh_addresses', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleSavedAddresses(ctx);
});
bot.action(/^acc_view_addrs_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleSavedAddresses(ctx, key);
});

// 2. My Swiggy Accounts Menu
async function handleMyAccounts(ctx) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const activeKey = getActiveOrderAccountKey();

  let text = `<b>My Swiggy Accounts</b>\n\nSelect an account:\n`;
  const buttons = [];

  for (const [key, acc] of Object.entries(accounts)) {
    const isActive = key === activeKey;
    const statusText = isActive ? 'Active' : (acc.isLoggedIn ? 'Saved' : 'Not Logged In');
    text += `${acc.name || key} <code>${acc.phone || ''}</code> ${statusText}\n`;

    buttons.push([
      {
        text: `${isActive ? '[Active] ' : ''}${acc.name || key} (${acc.phone || 'No phone'}) - ${statusText}`,
        callback_data: `acc_view_detail_${key}`,
        style: isActive ? 'success' : (acc.isLoggedIn ? 'primary' : 'danger')
      }
    ]);
  }

  buttons.push([
    { text: 'Add New Account', callback_data: 'boss_add_new_account_menu', style: 'primary' },
    { text: 'Refresh Accounts', callback_data: 'acc_refresh_list', style: 'primary' }
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      return;
    } catch (e) {
      if (e.message && e.message.includes('Message is not modified')) {
        return;
      }
    }
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

bot.hears('◉ My Swiggy Accounts', async (ctx) => handleMyAccounts(ctx));
bot.command('accounts', async (ctx) => handleMyAccounts(ctx));
bot.action('acc_refresh_list', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await handleMyAccounts(ctx);
});

// Account Details screen (Full Unified Account Control Panel)
bot.action(/^acc_view_detail_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.reply('Account not found.');

  const activeKey = getActiveOrderAccountKey();
  const isActive = key === activeKey;
  const isLogged = isAccountLoggedInSession(acc);

  const exported = exportSessionJson(key) || ((acc.cookies || acc.tid || acc.token) ? acc : null);
  const sessionJsonStr = exported ? JSON.stringify(exported, null, 2) : '';
  const compactStr = exported ? JSON.stringify(exported) : '';
  const phone = acc.phone || acc.mobile || '';
  const codeBlock = sessionJsonStr.length <= 3400 ? sessionJsonStr : compactStr;

  const text = `<b>Swiggy Account Control</b>\n\n` +
    `◉ <b>${escapeHtml(acc.name || key)}</b>\n` +
    `☎ <code>${phone || 'No phone set'}</code>\n` +
    `◈ Status: <b>${isLogged ? '● Logged In' : '○ Logged Out / Expired'}</b>\n` +
    (isActive ? `★ <b>(Currently Active Order Hub)</b>\n` : '') +
    `\n` +
    (codeBlock ? `▤ <b>Full Session Code (${codeBlock.length} chars):</b>\n<pre><code class="language-json">${escapeHtml(codeBlock)}</code></pre>\n\n` : '') +
    `Select an option:`;

  const buttons = [];

  if (compactStr || phone) {
    const row = [];
    if (compactStr) {
      row.push(makeFullSessionCopyButton(ctx, 'Copy Code', key, compactStr, `copy_code_${key}`, 'primary'));
    }
    if (phone) {
      row.push({ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' });
    }
    buttons.push(row);
  }

  if (isLogged) {
    buttons.push([
      { text: '▣ Claim ₹50 Offers', callback_data: `boss_retry_claim_${key}`, style: 'success' },
      { text: '₹ Claim Free Cash', callback_data: `boss_check_fc_${key}`, style: 'success' }
    ]);
    buttons.push([
      { text: 'Set as Active Order Hub', callback_data: `acc_set_active_${key}`, style: 'success' },
      { text: 'Export JSON', callback_data: `boss_export_json_${key}`, style: 'primary' }
    ]);
    buttons.push([
      { text: 'Saved Addresses', callback_data: `acc_view_addrs_${key}`, style: 'primary' },
      { text: 'Previous Orders', callback_data: `acc_view_orders_${key}`, style: 'primary' }
    ]);
    buttons.push([
      { text: 'View Cart', callback_data: `acc_view_cart_${key}`, style: 'primary' },
      { text: '↗ Logout Account', callback_data: `boss_logout_single_${key}`, style: 'danger' }
    ]);
    buttons.push([
      { text: 'Delete Account from Swiggy', callback_data: `boss_swiggy_delete_start_${key}`, style: 'danger' },
      { text: '× Remove from Bot', callback_data: `boss_remove_local_${key}`, style: 'danger' }
    ]);
  } else {
    buttons.push([
      { text: `◈ Re-Login ${phone || 'OTP'}`, callback_data: `boss_login_acc_otp_${key}`, style: 'success' },
      { text: '▤ Re-Login with Code', callback_data: `boss_login_acc_json_${key}`, style: 'primary' }
    ]);
    buttons.push([
      { text: '× Remove from Bot DB', callback_data: `boss_remove_local_${key}`, style: 'danger' }
    ]);
  }

  buttons.push([
    { text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' },
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    if (e.message && e.message.includes('Message is not modified')) return;
    await sendSafeHtml(ctx, text, { reply_markup: { inline_keyboard: buttons } });
  }
});

// Set as Active Order Hub
bot.action(/^acc_set_active_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  setActiveOrderAccountKey(key);
  await ctx.answerCbQuery('Order Hub ready! !').catch(() => {});
  await ctx.reply(`<b>Order Hub ready — orders will now be placed from this account.</b>`, { parse_mode: 'HTML' });
});

// Permanent Logout
bot.action(/^acc_perm_logout_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  const name = acc?.name || key;
  const phone = acc?.phone || '';

  permanentLogoutAccount(key);
  await ctx.answerCbQuery('Permanent Logout Successful ↗').catch(() => {});
  await ctx.reply(
    `<b>Permanent Logout Successful</b>\n\n` +
    `<b>${escapeHtml(name)}</b> <code>${escapeHtml(phone)}</code>\n\n` +
    `The account has been removed from My Swiggy Accounts. To use it again, add it via Login.`,
    { parse_mode: 'HTML' }
  );
});

// 3. Previous Orders
async function handlePreviousOrders(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(`! <b>${escapeHtml(acc?.name || activeKey)} is not logged in!</b>\nPlease login to view previous orders.`, { parse_mode: 'HTML' });
  }

  const orders = await fetchAccountOrders(acc);

  if (!orders || orders.length === 0) {
    const emptyText = 
      `<blockquote>▣ <b>PREVIOUS ORDERS</b></blockquote>\n\n` +
      `☎ <b>Account:</b> <code>${acc.phone || ''}</code> (<b>${escapeHtml(acc.name || activeKey)}</b>)\n` +
      `# <b>Customer ID:</b> <code>${acc.customerId || 'Verified'}</code>\n\n` +
      `<i>Is account se Swiggy par abhi tak koi previous order nahi mila (0 orders).</i>`;
    return sendSafeHtml(ctx, emptyText, Markup.inlineKeyboard([
      [
        Markup.button.callback('Delete Account from Swiggy', `boss_swiggy_delete_start_${activeKey}`),
        Markup.button.callback('Refresh Orders', `acc_view_orders_${activeKey}`)
      ],
      [
        Markup.button.callback('Add Another Account', 'send_to_another_number'),
        Markup.button.callback('Main Menu', 'boss_panel_home')
      ]
    ]));
  }

  let text = 
    `<blockquote>▣ <b>PREVIOUS ORDERS (${orders.length})</b></blockquote>\n\n` +
    `☎ <b>Account:</b> <code>${acc.phone || ''}</code> (<b>${escapeHtml(acc.name || activeKey)}</b>)\n` +
    `# <b>Customer ID:</b> <code>${acc.customerId || 'Verified'}</code>\n\n`;

  const buttons = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const prevRawLink = o.trackingUrl ? String(o.trackingUrl).trim() : '';
    const validPrevTrack = prevRawLink &&
      isOfficialSwiggyTrackingUrl(prevRawLink, { allowProviderShortLink: true }) &&
      !isFabricatedTrackingUrl(prevRawLink, String(o.orderId || ''))
      ? prevRawLink
      : '';
    const prevStatus = normalizeSwiggyLiveOrderStatus(o.status) || o.status || 'Completed';
    const isPrevDelivered = !/cancel|refus|return/i.test(String(prevStatus)) && /deliv|complet/i.test(String(prevStatus));
    const prevDeliveredUrl = !validPrevTrack && isPrevDelivered && o.orderId
      ? (o.deliveredTrackUrl || buildSignedOrderTrackUrl(o.orderId))
      : '';
    const resolvedPrevLink = validPrevTrack || prevDeliveredUrl;
    const statusIcon = String(prevStatus).toLowerCase().includes('deliv') ? '●' : '●';
    text += `<b>${i + 1}. ${escapeHtml(o.restaurantName || 'Swiggy Food')}</b>\n` +
      `• # <b>Order ID:</b> <code>#${o.orderId}</code>\n` +
      `• ₹ <b>Amount:</b> <b>₹${o.orderTotal || 0}</b> • ${statusIcon} <code>${escapeHtml(prevStatus)}</code>\n` +
      (o.items && o.items.length > 0 ? `• ▤ <i>${escapeHtml(o.items.join(', '))}</i>\n` : '') +
      (o.deliveryAddress ? `• ⌖ <code>${escapeHtml(o.deliveryAddress)}</code>\n` : '') +
      (o.deliveryOtp ? `• ⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(o.deliveryOtp))}</code>\n` : '') +
      (resolvedPrevLink ? `• 🔗 <b>Tracking:</b> <a href="${escapeHtml(resolvedPrevLink)}">${validPrevTrack ? 'Open Swiggy tracking' : 'Open order tracking'}</a>\n` : '') +
      (o.orderTime ? `• ◷ <i>${escapeHtml(o.orderTime)}</i>\n` : '') +
      `\n`;

    if (resolvedPrevLink && buttons.length < 20) {
      buttons.push([
        Markup.button.url(`↗ Track #${o.orderId} (${truncateDisplayField(o.restaurantName || 'Order', 18)})`, resolvedPrevLink)
      ]);
    } else if (o.orderId && !/cancel/i.test(String(prevStatus)) && buttons.length < 20) {
      buttons.push([
        Markup.button.callback(`🔗 Extract Tracking #${String(o.orderId).slice(-6)}`, `extract_now_${o.orderId}`)
      ]);
    }
  }

  buttons.push([
    Markup.button.callback('Delete Account from Swiggy', `boss_swiggy_delete_start_${activeKey}`),
    Markup.button.callback('Refresh Orders', `acc_view_orders_${activeKey}`)
  ]);
  buttons.push([
    Markup.button.callback('Add Another Account', 'send_to_another_number'),
    Markup.button.callback('Main Menu', 'boss_panel_home')
  ]);

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.hears(['▣ Previous Orders', '▣ My Orders', 'Previous Orders'], async (ctx) => handlePreviousOrders(ctx));
bot.command(['orders', 'previous_orders'], async (ctx) => handlePreviousOrders(ctx));
bot.action(/^acc_view_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handlePreviousOrders(ctx, key);
});

// ================= ORDERS DONE (ALL IDs) =================
async function handleAllOrdersDone(ctx) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('Fetching live orders from your logged-in ID...').catch(() => {});
  }

  let statusMsg = null;
  try {
    statusMsg = await ctx.reply('⏳ <i>Logged-in accounts se live orders aur tracking links fetch ho rahe hain...</i>', { parse_mode: 'HTML' });
  } catch (e) {}

  try {
    const db = getDb();
    const accounts = db.config?.accounts || {};
    const accountEntries = Object.entries(accounts);

    if (accountEntries.length === 0) {
      if (statusMsg) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
      }
      return ctx.reply('⚠️ <b>Koi bhi Swiggy account added nahi hai!</b>\n\nBoss panel se pehle number ya JSON ke zariye account login karein.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')],
          [Markup.button.callback('▤ Login with JSON', 'boss_login_with_json')],
          [Markup.button.callback('★ Boss Panel', 'boss_panel_home')]
        ])
      });
    }

    const activeKey = getActiveOrderAccountKey(db);

    // Sort accounts so active logged-in account is first, followed by other logged-in accounts
    accountEntries.sort(([k1, a1], [k2, a2]) => {
      if (k1 === activeKey) return -1;
      if (k2 === activeKey) return 1;
      const logged1 = Boolean(a1 && (a1.isLoggedIn || a1.cookies || a1.tid));
      const logged2 = Boolean(a2 && (a2.isLoggedIn || a2.cookies || a2.tid));
      if (logged1 && !logged2) return -1;
      if (!logged1 && logged2) return 1;
      return 0;
    });

    const loggedInEntries = accountEntries.filter(([, a]) => a && (a.isLoggedIn || a.cookies || a.tid));
    const notLoggedInCount = accountEntries.length - loggedInEntries.length;

    if (loggedInEntries.length === 0) {
      if (statusMsg) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
      }
      return ctx.reply('⚠️ <b>Koi bhi logged-in Swiggy account nahi mila!</b>\n\nLive orders aur tracking links dekhne ke liye pehle number ya JSON se account login karein.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')],
          [Markup.button.callback('▤ Login with JSON', 'boss_login_with_json')],
          [Markup.button.callback('★ Boss Panel', 'boss_panel_home')]
        ])
      });
    }

    // Parallel fetch live orders from all logged-in accounts.
    // Each account is capped so a slow Swiggy ID can never stall the whole
    // dashboard (this used to end in a 240s handler timeout).
    const fetchWithBudget = (acc, ms) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), ms);
      timer.unref?.();
      Promise.resolve()
        .then(() => fetchAccountOrders(acc))
        .then(orders => resolve(Array.isArray(orders) ? orders : []))
        .catch(() => resolve([]))
        .finally(() => clearTimeout(timer));
    });
    const accountResults = await Promise.allSettled(
      loggedInEntries.map(async ([key, acc]) => {
        try {
          const orders = await fetchWithBudget(acc, 25000);
          return { key, acc, orders: Array.isArray(orders) ? orders : [], isActive: key === activeKey };
        } catch (err) {
          console.error(`[ORDERS_DONE] Error fetching orders for ${acc?.name || key}:`, err?.message || err);
          return { key, acc, orders: [], isActive: key === activeKey, error: err?.message };
        }
      })
    );

    // Also collect completed orders recorded in db.orders
    const dbOrders = Object.values(db.orders || {});
    const dbCompletedOrders = dbOrders.filter(o =>
      o.status === 'COMPLETED' || o.swiggyOrderId || (o.trackingLink && isOfficialSwiggyTrackingUrl(o.trackingLink))
    );

    let totalOrdersFound = 0;
    const buttons = [];
    const emptyAccounts = [];
    const matchedDbOrderIds = new Set();
    let text = `<blockquote>📦 <b>ORDERS DONE — LOGGED IN SWIGGY IDs</b></blockquote>\n\n`;

    for (const res of accountResults) {
      if (res.status !== 'fulfilled') continue;
      const { key, acc, orders, isActive } = res.value;
      const accName = acc.name || key;
      const phoneStr = acc.phone ? `<code>${acc.phone}</code>` : '';
      const badge = isActive ? '🟢 <b>Active Logged-in ID:</b>' : '📱 <b>Logged-in ID:</b>';

      // Augment orders with any db.orders matching by Swiggy order id OR placing account
      for (const dbo of Object.values(db.orders || {})) {
        if (!dbo || typeof dbo !== 'object') continue;
        const swiggyId = String(dbo.swiggyOrderId || dbo.pendingSwiggyOrderId || dbo.id || '');
        const existingById = swiggyId ? orders.find(o => String(o.orderId || '') === swiggyId) : null;
        if (existingById) {
          matchedDbOrderIds.add(String(dbo.id || dbo.swiggyOrderId));
          const storedTrack = getStoredSwiggyTrackingUrl(dbo);
          if (!existingById.trackingUrl && storedTrack) {
            existingById.trackingUrl = storedTrack;
          }
          if (!existingById.deliveryOtp && dbo.deliveryOtp) {
            existingById.deliveryOtp = dbo.deliveryOtp;
          }
          continue;
        }
        const matchesAccount = (dbo.selectedAccount && dbo.selectedAccount === key) ||
          (dbo.selectedAccountPhone && acc.phone && dbo.selectedAccountPhone === acc.phone) ||
          (dbo.orderAccount && acc.phone && String(dbo.orderAccount).includes(acc.phone));
        if (matchesAccount && dbo.status === 'COMPLETED') {
          matchedDbOrderIds.add(String(dbo.id || dbo.swiggyOrderId));
          // Never synthesize a tracking URL — only real Swiggy links are shown
          const realTrack = getStoredSwiggyTrackingUrl(dbo);
          orders.unshift({
            orderId: dbo.swiggyOrderId || '',
            orderRef: String(dbo.id || ''),
            restaurantName: dbo.restaurantName || 'Swiggy Food',
            status: dbo.liveOrderStatus || dbo.status || 'COMPLETED',
            items: (dbo.items || []).map(i => `${i.name}${i.qty > 1 ? ` (${i.qty})` : ''}`),
            deliveryAddress: dbo.addressDetails?.address || dbo.address || '',
            orderTotal: dbo.finalPayable || 0,
            trackingUrl: realTrack,
            deliveryOtp: dbo.deliveryOtp || '',
            placedFrom: String(dbo.selectedAccountPhone || dbo.orderAccount || acc.phone || ''),
            orderTime: dbo.completedAt ? new Date(dbo.completedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''
          });
        }
      }

      if (!orders || orders.length === 0) {
        // collect empty accounts, don't spam per-account — summary after loop
        emptyAccounts.push({ name: accName, phone: acc.phone || '' });
        continue;
      }

      const cleanHeaderName = acc.phone
        ? String(accName).replace(new RegExp(`\\s*\\(\\s*${String(acc.phone).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)\\s*$`), '').trim() || accName
        : accName;
      text += `📱 <b>${escapeHtml(cleanHeaderName)}</b> ${phoneStr ? `(Placed from ${phoneStr})` : ''}\n`;
      totalOrdersFound += orders.length;
      text += `<i>Total Orders: <b>${orders.length}</b></i>\n\n`;

      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        const rowSwiggyId = /^\d{10,20}$/.test(String(o.orderId || '')) ? String(o.orderId) : '';
        const rawTrackLink2 = o.trackingUrl ? String(o.trackingUrl).trim() : '';
        const validTrackUrl = rawTrackLink2 &&
          isOfficialSwiggyTrackingUrl(rawTrackLink2, { allowProviderShortLink: true }) &&
          !isFabricatedTrackingUrl(rawTrackLink2, rowSwiggyId)
          ? rawTrackLink2
          : '';
        const normalizedStatus = normalizeSwiggyLiveOrderStatus(o.status) || o.status || 'COMPLETED';
        const statusRaw = String(normalizedStatus);
        const isRowDelivered = !/cancel|refus|return/i.test(statusRaw) && /deliv|complet/i.test(statusRaw);
        const rowDeliveredUrl = !validTrackUrl && isRowDelivered && (rowSwiggyId || o.orderRef)
          ? (o.deliveredTrackUrl || buildSignedOrderTrackUrl(rowSwiggyId || o.orderRef))
          : '';
        const trackingDisplay = trackingLinkDisplay({
          url: validTrackUrl,
          fallbackTrackUrl: rowDeliveredUrl,
          status: statusRaw,
          orderId: rowSwiggyId
        });
        const statusStr = escapeHtml(statusRaw);
        const restName = escapeHtml(o.restaurantName || 'Swiggy Food');
        const rowRef = String(o.orderRef || (rowSwiggyId ? '' : (o.orderId || '')));
        const rowPhone = String(o.placedFrom || acc.phone || '');

        text += `<b>${i + 1}. ${restName}</b>\n` +
          (rowSwiggyId ? `• 🆔 <b>Swiggy order:</b> <code>${escapeHtml(rowSwiggyId)}</code>\n` : `• 🆔 <b>Swiggy order:</b> <i>not created yet</i>\n`) +
          (rowRef ? `• 🧾 <b>Order ref:</b> <code>#${escapeHtml(rowRef)}</code>\n` : '') +
          `• ☎ <b>Placed from:</b> <code>${escapeHtml(rowPhone || 'unknown')}</code>\n` +
          `• 💰 <b>Total:</b> <b>₹${o.orderTotal || 0}</b> · <b>Status:</b> <code>${statusStr}</code>\n` +
          (o.items && o.items.length ? `• 🍽️ <b>Items:</b> <i>${escapeHtml(o.items.join(', '))}</i>\n` : '') +
          (o.deliveryAddress ? `• 📍 <b>Address:</b> <code>${escapeHtml(o.deliveryAddress)}</code>\n` : '') +
          (o.deliveryOtp ? `• 🔢 <b>Delivery OTP:</b> <code>${escapeHtml(String(o.deliveryOtp))}</code>\n` : '') +
          (o.orderTime ? `• 🕒 <b>Time:</b> <i>${escapeHtml(String(o.orderTime))}</i>\n` : '') +
          `• 🔗 <b>Tracking Link:</b> ${trackingDisplay}\n\n`;

        const resolvedRowButtonUrl = validTrackUrl || rowDeliveredUrl;
        if (resolvedRowButtonUrl && buttons.length < 25) {
          buttons.push([
            Markup.button.url(`↗ Track #${rowSwiggyId || rowRef || 'order'} (${truncateDisplayField(o.restaurantName || 'Order', 18)})`, resolvedRowButtonUrl)
          ]);
        } else if (!resolvedRowButtonUrl && rowSwiggyId && !/cancel/i.test(statusRaw) && buttons.length < 25) {
          buttons.push([
            Markup.button.callback(`🔗 Extract Link #${rowSwiggyId.slice(-6)} (${truncateDisplayField(o.restaurantName || 'Order', 16)})`, `extract_now_${rowSwiggyId}`)
          ]);
        }
      }
    }

    if (notLoggedInCount > 0) {
      text += `━━━━━━━━━━━━━━━━━━━━\n<i>⚠️ ${notLoggedInCount} other account(s) login required.</i>\n\n`;
    }

    // Summary for empty accounts instead of spamming per-account 0-orders blocks
    if (emptyAccounts.length > 0) {
      const formatEmptyAccount = (a) => {
        const namePart = String(a.name || '').trim();
        const phonePart = String(a.phone || '').trim();
        if (phonePart && namePart && !namePart.includes(phonePart)) {
          return `${escapeHtml(namePart)} (${escapeHtml(phonePart)})`;
        }
        return escapeHtml(namePart || phonePart || 'Account');
      };
      const emptyList = emptyAccounts.map(formatEmptyAccount).join(', ');
      if (totalOrdersFound > 0) {
        text += `━━━━━━━━━━━━━━━━━━━━\n<i>ℹ️ ${emptyAccounts.length} ID(s) me koi orders nahi mile: ${emptyList}</i>\n\n`;
      } else {
        text += `━━━━━━━━━━━━━━━━━━━━\n<i>ℹ️ ${emptyAccounts.length} ID(s) me koi orders nahi mile: ${emptyList}</i>\n`;
      }
    }

    // Show unmatched bot orders that didn't associate to any logged-in ID (so user never sees contradictory 0-orders)
    const unmatchedBotOrders = dbCompletedOrders.filter(dbo => !matchedDbOrderIds.has(String(dbo.id || dbo.swiggyOrderId)));
    if (unmatchedBotOrders.length > 0) {
      text += `📦 <b>Bot-tracked orders (account not logged in)</b>\n\n`;
      for (let i = 0; i < unmatchedBotOrders.length; i++) {
        const dbo = unmatchedBotOrders[i];
        const validTrackUrl = getStoredSwiggyTrackingUrl(dbo);
        const swiggyId = swiggyOrderIdOf(dbo);
        const normalizedUnmatchedStatus = normalizeSwiggyLiveOrderStatus(dbo.liveOrderStatus) || dbo.liveOrderStatus || dbo.status || 'COMPLETED';
        const statusRaw = String(normalizedUnmatchedStatus);
        const isUnmatchedDelivered = !/cancel|refus|return/i.test(statusRaw) && /deliv|complet/i.test(statusRaw);
        const unmatchedDeliveredUrl = !validTrackUrl && isUnmatchedDelivered && (swiggyId || dbo.id)
          ? buildSignedOrderTrackUrl(swiggyId || dbo.id)
          : '';
        const trackingDisplay = trackingLinkDisplay({
          url: validTrackUrl,
          fallbackTrackUrl: unmatchedDeliveredUrl,
          status: statusRaw,
          orderId: swiggyId
        });
        const placedFrom = placedFromPhoneOf(dbo, db);
        text += `<b>${i + 1}. ${escapeHtml(dbo.restaurantName || 'Swiggy Food')}</b>\n` +
          `• 🆔 <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || 'not created yet')}</code>\n` +
          `• 🧾 <b>Order ref:</b> <code>#${escapeHtml(String(dbo.id))}</code>\n` +
          `• ☎ <b>Placed from:</b> <code>${escapeHtml(placedFrom || 'account not selected')}</code>\n` +
          `• 💰 <b>Total:</b> <b>₹${dbo.finalPayable || 0}</b> · <b>Status:</b> <code>${escapeHtml(statusRaw)}</code>\n` +
          (dbo.items && dbo.items.length ? `• 🍽️ <b>Items:</b> <i>${escapeHtml(dbo.items.map(it => it.name).join(', '))}</i>\n` : '') +
          (dbo.addressDetails?.address || dbo.address ? `• 📍 <b>Address:</b> <code>${escapeHtml(dbo.addressDetails?.address || dbo.address)}</code>\n` : '') +
          (dbo.deliveryOtp ? `• 🔢 <b>Delivery OTP:</b> <code>${escapeHtml(String(dbo.deliveryOtp))}</code>\n` : '') +
          (dbo.completedAt ? `• 🕒 <b>Time:</b> <i>${escapeHtml(new Date(dbo.completedAt).toLocaleString('en-IN'))}</i>\n` : '') +
          `• 🔗 <b>Tracking Link:</b> ${trackingDisplay}\n\n`;
        totalOrdersFound += 1;
        const resolvedUnmatchedUrl = validTrackUrl || unmatchedDeliveredUrl;
        if (resolvedUnmatchedUrl && buttons.length < 25) {
          buttons.push([Markup.button.url(`↗ Track #${swiggyId || dbo.id} (${truncateDisplayField(dbo.restaurantName || 'Order', 18)})`, resolvedUnmatchedUrl)]);
        }
      }
    }

    if (totalOrdersFound === 0) {
      text += `\n<i>Connected accounts me abhi koi completed orders nahi hain.</i>`;
    }

    buttons.push([
      Markup.button.callback('↻ Refresh Orders Done', 'boss_view_orders_done'),
      Markup.button.callback('★ Boss Panel', 'boss_panel_home')
    ]);

    if (statusMsg) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    }

    await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('[ORDERS_DONE] Execution error:', err?.stack || err?.message || err);
    if (statusMsg) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    }
    await ctx.reply(`❌ <b>Orders Done fetch karne me error aaya:</b> ${escapeHtml(err?.message || 'Unknown error')}`, {
      parse_mode: 'HTML'
    });
  }
}

bot.hears(['📦 Orders Done', 'Orders Done', 'orders done', 'orders_done', '/orders_done', '/ordersdone'], async (ctx) => {
  await handleAllOrdersDone(ctx);
});
bot.command(['ordersdone', 'orders_done'], async (ctx) => {
  await handleAllOrdersDone(ctx);
});
bot.action(['boss_view_orders_done', 'user_orders_done'], async (ctx) => {
  await handleAllOrdersDone(ctx);
});

// 4. View Cart
async function handleViewCart(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(`! <b>${escapeHtml(acc?.name || activeKey)} is not logged in!</b>\nPlease login with OTP or JSON first.`, { parse_mode: 'HTML' });
  }

  const waitMsg = await ctx.reply(`▤ <i>Inspecting live cart & calculating best offers for ${acc.name || activeKey}...</i>`, { parse_mode: 'HTML' });
  const liveCart = await inspectCartForAccount(acc);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!liveCart || (!liveCart.restaurantName && (!liveCart.items || liveCart.items.length === 0))) {
    return ctx.reply(
      `▤ <b>Your Cart is empty</b> in <b>${acc.name || activeKey}</b>'s Swiggy account.\n\n` +
      `Aap Swiggy app me jakar items cart me add kar sakte hain ya cart link yahan paste kar sakte hain!`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('◎ Open Swiggy Web', 'https://www.swiggy.com/')],
          [Markup.button.callback('i Add Food via Link Video', 'action_link_guide')]
        ])
      }
    );
  }

  const receipt = formatSwiggyWorldCartReceipt(liveCart, acc.phone || acc.name || activeKey);
  await ctx.reply(receipt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url('◎ Open Swiggy Checkout', 'https://www.swiggy.com/checkout')],
      [Markup.button.callback('↻ Refresh Cart', `acc_view_cart_${activeKey}`)]
    ])
  });
}

bot.hears('▤ View Cart', async (ctx) => handleViewCart(ctx));
bot.command('cart', async (ctx) => handleViewCart(ctx));
bot.action(/^acc_view_cart_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleViewCart(ctx, key);
});

// 5. Add Food via Link Guide
function handleLinkGuide(ctx) {
  return ctx.reply(
    `<b>Add Food Items via Link</b>\n\n` +
    `Did you know you can add food items to your cart directly through a link?\n` +
    `Watch this quick video https://t.me/FireByWorld/370\n\n` +
    `<i>Note: You can log in with any Swiggy account in the app — both accounts don't need to be the same.</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false }
    }
  );
}

bot.hears('i Add Food via Link', handleLinkGuide);
bot.command('link_guide', handleLinkGuide);
bot.action('action_link_guide', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  handleLinkGuide(ctx);
});

// 6. Cash Loot
function handleCashLoot(ctx) {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const buttons = [];

  for (const [key, acc] of Object.entries(accounts)) {
    buttons.push([
      Markup.button.callback(`▣ ${acc.name || key} (${acc.phone || 'Ready'})`, `cash_loot_acc_${key}`)
    ]);
  }

  return ctx.reply(
    `<b>SWIGGY CASH LOOT</b>\n` +
    `Campaign: ydiHi75 · ₹10 per friend · cap ₹100/account\n\n` +
    `Pehle account chuno — kaunse account pe loot karna hai?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
}

bot.hears('₹ Cash Loot', handleCashLoot);
bot.command('cash_loot', handleCashLoot);
bot.action(/^cash_loot_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `▣ <b>CASH LOOT READY FOR ${acc?.name || key}:</b>\n\n` +
    `Campaign Link: https://www.swiggy.com/referrals/ydiHi75\n` +
    `Earn ₹10 per friend · Cap ₹100/account!`,
    { parse_mode: 'HTML' }
  );
});

// Slot system removed — orders are unlimited without slot gating.
bot.command(['slots', 'resetslots'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  return ctx.reply('✓ <b>Slot system hata diya gaya hai</b> — ab unlimited orders direct chalte hain.', { parse_mode: 'HTML' });
});

bot.action('noop', async (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.catch(async (err, ctx) => {
  const description = String(err?.description || '');
  const message = String(err?.message || '');

  // Ignore harmless "not modified" edits and transient Telegram races
  const ignorePhrases = [
    'message is not modified',
    'query is too old',
    'MESSAGE_ID_INVALID',
    'message is too long',
    'message to be edited',
    'message can\'t be edited'
  ];
  if (ignorePhrases.some(p => (message || description).toLowerCase().includes(p.toLowerCase()))) return;

  const updateType = ctx?.updateType || 'unknown';
  const errMsg = message || description || String(err);
  console.error(`× Bot error [${updateType}]:`, errMsg);
  if (err?.stack) console.error(`  ↳ ${String(err.stack).split('\n').slice(1, 4).join('\n  ↳ ')}`);

  // Tell the person who triggered it something useful — but only for real code
  // faults. Transient Telegram/network failures must not spam the chat.
  const looksLikeCodeFault = /is not defined|is not a function|ReferenceError|TypeError|Cannot read|undefined \(reading/i.test(`${message} ${description}`);
  if (looksLikeCodeFault) {
    try {
      if (ctx?.chat?.id && typeof ctx.reply === 'function') {
        await ctx.reply(
          '! <b>Kuch technical issue aa gaya.</b>\n\nKripya dobara try karein ya /start dabayein. Aapka data safe hai.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } catch (e) {}
  }

  // Report to Boss with the exact failing line so the bug can be fixed fast.
  try {
    const db = getDb();
    const bossIds = db?.config?.bossIds || [];
    const diagMsg = formatBossDiagnosticErrorMessage(err, {
      stage: `GLOBAL_BOT_CATCH_${updateType.toUpperCase()}`,
      senderName: ctx?.from?.first_name || '',
      isForwarded: Boolean(ctx?.message && extractForwardSenderInfo(ctx.message)),
      cartLink: ctx?.callbackQuery?.data || ctx?.message?.text || ''
    });
    for (const bossId of bossIds) {
      await bot.telegram.sendMessage(bossId, diagMsg, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (e) {}
});

// =========================================================================
// Telegram order-state, bill-approval, and payment actions
// =========================================================================

// Telegram callbacks for bill approval, payment status, and corrected delivery details.

function isOrderCustomer(order, userId) {
  const allowedIds = [order?.fwdSenderUserId, order?.userId]
    .filter(value => value !== null && value !== undefined && String(value).trim() !== '')
    .map(String);
  return allowedIds.includes(String(userId));
}

export async function sendApprovedOrderPaymentToUser(uidStr, order, { force = false } = {}) {
  const callerId = String(uidStr || '').trim();
  const callerIsBoss = callerId && isBoss(Number(callerId));
  if (callerId && !isOrderCustomer(order, callerId) && !callerIsBoss) return false;
  const targetUserId = callerId && isOrderCustomer(order, callerId)
    ? callerId
    : String(order?.fwdSenderUserId || order?.userId || '').trim();
  if (!targetUserId) return false;
  if (!force && order.customerPaymentMessageId) return true;

  let upiUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
  const paymentUrl = String(order.swiggyPaymentUrl || '').trim();
  const amount = Number(order.finalPayable || order.finalTotal || 0);
  const restaurant = escapeHtml(order.restaurantName || 'Swiggy Order');
  const rows = [];
  if (paymentUrl) rows.push([Markup.button.url('Pay via Swiggy (UPI/Card)', paymentUrl)]);
  rows.push([Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)]);
  if (upiUri || paymentUrl) rows.push([Markup.button.callback('Resend payment QR', `user_resend_approved_qr_${order.id}`)]);
  const keyboard = Markup.inlineKeyboard(rows);

  // If Swiggy did not return a UPI intent, fall back to the configured collection
  // UPI so the customer always gets a scannable PERSONALISED QR (name + amount).
  let usingFallbackUpi = false;
  if (!upiUri && !paymentUrl && amount > 0) {
    const fallbackUpiId = String(getDb().config?.bossUpiId || '6296591407@ybl').trim();
    upiUri = sanitizeUpiUriForQr(
      `upi://pay?pa=${encodeURIComponent(fallbackUpiId)}&pn=${encodeURIComponent(order.restaurantName || 'Swiggy')}` +
      `&am=${amount}&cu=INR&tn=${encodeURIComponent(`Swiggy Order ${order.id}`)}`
    );
    usingFallbackUpi = true;
  }

  if (upiUri) {
    // Same branded, personalised QR the Boss cards use: orange header with the
    // customer's name, the exact amount and the order id baked into the image.
    let qrBuffer = null;
    try {
      qrBuffer = await generateNamedUpiQrPngBuffer({
        upiUri,
        senderName: order.fwdSenderName || order.userName || 'Customer',
        restaurantName: order.restaurantName || 'Swiggy',
        amount,
        orderId: order.id
      });
    } catch (qrErr) {
      console.warn(`[PaymentQR] Personalised QR failed for #${order.id}:`, qrErr?.message || qrErr);
    }
    if (!qrBuffer) {
      qrBuffer = await QRCode.toBuffer(upiUri, {
        type: 'png',
        width: 900,
        margin: 3,
        errorCorrectionLevel: 'M'
      });
    }
    const caption = safeTelegramCaption(
      `₹ <b>Payment QR · Order #${escapeHtml(order.id)}</b>\n` +
      `◉ <b>For:</b> ${escapeHtml(order.fwdSenderName || order.userName || 'Customer')}\n` +
      `▤ <b>Restaurant:</b> ${restaurant}\n` +
      `₹ <b>Exact amount:</b> ₹${amount}\n\n` +
      (usingFallbackUpi
        ? `<i>Swiggy did not return an in-app payment request for this order, so this QR uses our verified UPI. Pay this exact amount and tap “Check payment status”.</i>`
        : `<i>This QR encodes the existing Swiggy checkout request. Checking status verifies payment with Swiggy; a button tap alone never marks it paid.</i>`),
      1000
    );
    const sent = await bot.telegram.sendPhoto(targetUserId, { source: qrBuffer }, {
      caption,
      parse_mode: 'HTML',
      ...keyboard
    });
    order.customerPaymentMessageId = sent?.message_id || null;
    order.customerPaymentSentAt = new Date().toISOString();
    order.paymentSentToUser = true;
    order.paymentQrKind = usingFallbackUpi ? 'UPI_FALLBACK_PERSONALISED' : 'SWIGGY_PERSONALISED';
    const db = getDb();
    db.orders[order.id] = order;
    saveDb(db);
    return true;
  }

  if (paymentUrl) {
    const sent = await bot.telegram.sendMessage(
      targetUserId,
      `↗ <b>Official Swiggy payment link · Order #${escapeHtml(order.id)}</b>\n\n` +
      `▤ <b>Restaurant:</b> ${restaurant}\n` +
      `₹ <b>Exact amount:</b> ₹${amount}\n\n` +
      `<a href=\"${escapeHtml(paymentUrl)}\">Open Swiggy payment</a>\n` +
      `<i>Use the status button only after paying. Payment is verified with Swiggy.</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...keyboard
      }
    );
    order.customerPaymentMessageId = sent?.message_id || null;
    order.customerPaymentSentAt = new Date().toISOString();
    order.paymentSentToUser = true;
    const db = getDb();
    db.orders[order.id] = order;
    saveDb(db);
    return true;
  }

  await bot.telegram.sendMessage(
    targetUserId,
    `✓ <b>Bill approved for order #${escapeHtml(order.id)}.</b>\n\n` +
    `Swiggy has not returned a payment QR or official payment link yet. Do not pay using another QR or link; the official payment details will be sent here when available.`,
    { parse_mode: 'HTML' }
  );
  return false;
}

export async function approveUserOrderBillAction(uidStr, orderId) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOrderCustomer(order, uidStr) && !isBoss(Number(uidStr))) {
    return { ok: false, error: 'Unauthorized: this is not your order.' };
  }
  if (order.status === 'COMPLETED') {
    return { ok: false, error: 'This order is already paid. No second payment QR will be created.' };
  }
  if (!['APPROVAL_PENDING', 'PAYMENT_PENDING'].includes(order.status)) {
    return { ok: false, error: 'This bill is not awaiting approval.' };
  }

  if (!order.billApprovedByUser) {
    order.billApprovedByUser = true;
    order.billApprovedAt = new Date().toISOString();
  }
  order.status = 'PAYMENT_PENDING';
  order.uxStage = 'SCREEN_04_PAYMENT_PENDING';
  saveDb(db);

  const bossTargetId = Number(process.env.BOSS_ID || db.bosses?.[0] || 6484999726);
  let qrGenerationError = '';
  // Idempotent single Swiggy QR creation — never create a second order/QR on repeat taps.
  if (!order.pendingSwiggyUpiUri && !order.realUpiIntentUri) {
    try {
      await executeRealQrGenerationForOrder({
        telegram: bot.telegram,
        chatId: bossTargetId,
        orderId: order.id,
        formatOrderBodyFn: formatUserOrderCardText
      });
    } catch (error) {
      qrGenerationError = String(error?.message || 'Swiggy payment details could not be prepared.').slice(0, 350);
      console.warn(`[BillApproval] Swiggy payment details are not ready for #${order.id}:`, error.message);
    }
  }

  const updated = getDb().orders?.[orderId] || order;
  // Swiggy unavailable? The customer still gets a scannable, personalised QR
  // built from the configured collection UPI — never a dead end.
  if (qrGenerationError && !updated.pendingSwiggyUpiUri && !updated.realUpiIntentUri && !updated.swiggyPaymentUrl) {
    updated.paymentQrFallbackReason = qrGenerationError.slice(0, 250);
    const fallbackDb = getDb();
    fallbackDb.orders[orderId] = updated;
    saveDb(fallbackDb);
  }
  let sentPayment;
  try {
    sentPayment = await sendApprovedOrderPaymentToUser(uidStr, updated);
  } catch (error) {
    return {
      ok: false,
      error: `Bill approved, but Telegram could not deliver the existing Swiggy payment details: ${error.message}. Refresh the order screen and resend the same QR; no new order will be created.`
    };
  }
  // Refresh the single card so it shows the payment-ready state (no new bubble).
  await updateOrderCards(getDb().orders?.[orderId] || updated).catch(() => {});

  return {
    ok: true,
    orderId,
    message: sentPayment
      ? 'Bill approved — the payment QR was sent in Telegram.'
      : 'Bill approved — waiting for Swiggy to return an official payment QR or link.'
  };
}

async function rejectUserOrderBillAction(uidStr, orderId) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOrderCustomer(order, uidStr) && !isBoss(Number(uidStr))) {
    return { ok: false, error: 'Unauthorized: this is not your order.' };
  }
  if (order.billApprovedByUser || order.pendingSwiggyOrderId) {
    return { ok: false, error: 'The bill has already been approved or sent to Swiggy and cannot be returned for edits.' };
  }
  if (order.status !== 'APPROVAL_PENDING') {
    return { ok: false, error: 'This bill is no longer awaiting review.' };
  }
  if (order.selectedAccount) {
    releaseSwiggyAccountReservation(order.selectedAccount, order.id);
  }
  order.status = 'CANCELLED';
  order.cancelledReason = 'USER_SOMETHING_IS_WRONG';
  saveDb(db);
  try { stopOrderTrackingAuto(order.id); } catch {}
  updateDraft(uidStr, {
    cart: order.cart || '',
    address: order.address || '',
    addressOriginalText: order.addressOriginalText || order.address || '',
    cartDetails: order.cartDetails || { restaurantName: order.restaurantName, items: order.items, subtotal: order.subtotal },
    addressDetails: order.addressDetails || null
  });
  return { ok: true, message: 'Order returned to your Telegram order screen so you can edit the Cart or Address.' };
}


// Helper: auto-edit the customer payment message in-place to inject tracking link/OTP after Swiggy payment (user request: payment message edit hokar usme link ajaye)
async function tryEditCustomerPaymentMessageWithTracking(order) {
  if (!order || !bot?.telegram) return false;
  const msgId = order.customerPaymentMessageId || order.activeQrMessageId || null;
  if (!msgId) return false;
  const chatId = String(order.userChatId || order.userId || order.fwdSenderUserId || '').trim();
  if (!chatId) return false;
  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  const swiggyId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  const restName = String(order.restaurantName || 'Swiggy Order').trim();
  const amt = Number(order.finalPayable || order.finalTotal || 0);
  const otp = String(order.deliveryOtp || '').trim();

  // Build success caption — same style as forwarded edit helper
  let caption = '';
  if (trackingUrl) {
    caption = `\u2705 <b>PAYMENT VERIFIED \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      (order.etaMinutes ? `\u23F1\uFE0F <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min\n` : '') +
      (otp ? `\uD83D\uDD22 <b>Delivery OTP:</b> <code>${escapeHtml(otp)}</code>\n` : '') +
      `\n\uD83D\uDD17 <b>Live Tracking Link:</b>\n<a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingUrl)}</a>\n\n` +
      `<i>Swiggy payment confirmed — tap tracking to follow rider live.</i>`;
  } else {
    caption = `\u2705 <b>PAYMENT VERIFIED \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      `\n<i>\u2713 Payment verified on Swiggy. Tracking link will be injected here automatically when Swiggy publishes it.</i>`;
  }

  const rows = [];
  if (trackingUrl) rows.push([Markup.button.url('\uD83D\uDD17 Track Order Live', trackingUrl)]);
  if (otp) rows.push([Markup.button.callback(`\uD83D\uDCCB Copy OTP ${otp}`, `copy_otp_${order.id}`)]);
  // Per user request: after auto-edit, "I have paid" button disappears (gayab) — only tracking/OTP remain
  // No Check payment status button is kept after edit; user can still use 🔗 Extract Tracking Link reply button for refresh
  const kb = rows.length ? Markup.inlineKeyboard(rows) : { reply_markup: { inline_keyboard: [] } };

  try {
    await bot.telegram.editMessageCaption(chatId, msgId, undefined, caption, { parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  try {
    await bot.telegram.editMessageText(caption, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  return false;
}


async function checkOrderPaidStatusOnly(orderId) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { paid: false, message: 'Order not found.' };
  const wasAlreadyCompleted = order.status === 'COMPLETED';
  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  if (!acc) {
    // Try All-IDs extract as fallback when selected account missing but order already paid (delay case: I have paid click)
    if (wasAlreadyCompleted && !getStoredSwiggyTrackingUrl(order)) {
      try {
        const fallback = typeof extractTrackingViaAllAccounts === 'function'
          ? await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null)
          : null;
        if (fallback?.trackingUrl) {
          // persisted inside extractTrackingViaAllAccounts; reload
          const fresh = getDb().orders?.[orderId];
          if (fresh) { order.trackingLink = fresh.trackingLink; order.trackingLinkSource = fresh.trackingLinkSource; }
        }
      } catch {}
    }
    const trackingLink = getStoredSwiggyTrackingUrl(order);
    if (wasAlreadyCompleted) {
      // Auto-edit payment message to inject link on delayed I-have-paid click
      try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
    }
    return wasAlreadyCompleted
      ? { paid: true, trackingLink, deliveryOtp: order.deliveryOtp || '', message: trackingLink ? '✓ Swiggy tracking is available.' : '… Swiggy has not shared a tracking link yet.' }
      : { paid: false, message: 'Waiting for verified payment on the Swiggy gateway (status check only).' };
  }

  let check;
  try {
    check = await checkRealSwiggyPaymentAndExtractTracking(acc, order);
  } catch (checkErr) {
    const errMsg = String(checkErr?.message || checkErr || 'unknown');
    const diag = checkErr?.diag ? ' diag=' + JSON.stringify(checkErr.diag) : '';
    return {
      paid: false,
      message: ('! Swiggy verify failed: ' + errMsg + diag).slice(0, 190)
    };
  }
  if (!check?.paid) {
    if (wasAlreadyCompleted) {
      // Delay case: I have paid already true but tracking still pending — try All-IDs live extract before responding
      if (!getStoredSwiggyTrackingUrl(order)) {
        try {
          const fallback = typeof extractTrackingViaAllAccounts === 'function'
            ? await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null)
            : null;
          if (fallback?.trackingUrl) {
            const fresh2 = getDb().orders?.[orderId];
            if (fresh2) { order.trackingLink = fresh2.trackingLink; order.trackingLinkSource = fresh2.trackingLinkSource; order.deliveryOtp = fresh2.deliveryOtp || order.deliveryOtp; }
          }
        } catch {}
      }
      const trackingLink = getStoredSwiggyTrackingUrl(order);
      try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
      return {
        paid: true,
        trackingLink,
        deliveryOtp: order.deliveryOtp || '',
        message: trackingLink ? '✓ Payment is verified; Swiggy tracking is available.' : '✓ Payment is verified. Swiggy has not published tracking yet.'
      };
    }
    // Delay rescue: primary ID says pending but payment may have settled on another saved account — try All-IDs before declaring pending
    // This satisfies user request: "I have paid" click par turant link aa jaye even if gateway delayed
    if (!getStoredSwiggyTrackingUrl(order)) {
      try {
        const rescue = typeof extractTrackingViaAllAccounts === 'function'
          ? await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null)
          : null;
        if (rescue?.trackingUrl) {
          const freshRescue = getDb().orders?.[orderId];
          if (freshRescue) {
            order.trackingLink = freshRescue.trackingLink || rescue.trackingUrl;
            order.trackingLinkSource = freshRescue.trackingLinkSource || 'SWIGGY_API';
            order.deliveryOtp = freshRescue.deliveryOtp || rescue.res?.deliveryOtp || order.deliveryOtp;
            order.swiggyOrderId = freshRescue.swiggyOrderId || rescue.res?.swiggyOrderId || order.swiggyOrderId;
            order.liveOrderStatus = freshRescue.liveOrderStatus || rescue.res?.orderStatus || order.liveOrderStatus;
          } else {
            order.trackingLink = rescue.trackingUrl;
            order.trackingLinkSource = 'SWIGGY_API';
            order.deliveryOtp = rescue.res?.deliveryOtp || order.deliveryOtp;
            order.swiggyOrderId = rescue.res?.swiggyOrderId || order.swiggyOrderId;
          }
          order.status = 'COMPLETED';
          order.cardStage = 'PAID_CONFIRMED';
          order.paidAt = new Date().toISOString();
          order.uxStage = 'SCREEN_05_TRACKING_READY';
          saveDb(getDb());
          try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
          const firstBossChatId2 = getDb().config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
          try { await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId2, order); } catch {}
          try { startOrderDeliveryInfoPoller({ telegram: bot.telegram, chatId: firstBossChatId2, orderId: order.id, formatOrderBodyFn: formatUserOrderCardText }); } catch {}
          try { startOrderTrackingAuto(order.id, { budgetMs: 12000 }); } catch {}
          const t2 = getStoredSwiggyTrackingUrl(order);
          return { paid: true, trackingLink: t2, deliveryOtp: order.deliveryOtp || '', message: t2 ? '✓ Payment verified via linked Swiggy account. Swiggy tracking is available.' : 'Payment verified successfully. Swiggy tracking is not available yet. I\'ll retry shortly.' };
        }
      } catch {}
    }
    const dbg = [];
    if (check?.txnState) dbg.push('txn=' + check.txnState);
    if (check?.payTxnState) dbg.push('pay=' + check.payTxnState);
    if (check?.gatewayFetchError) dbg.push('gwErr=' + String(check.gatewayFetchError).slice(0,40));
    if (check?.postStatusLower) dbg.push('post=' + check.postStatusLower);
    if (!dbg.length && check) dbg.push(JSON.stringify(check).slice(0,80));
    return {
      paid: false,
      message: ('◷ Still pending' + (dbg.length ? ' (' + dbg.join(' ') + ')' : '') + ' — will auto-detect every 5s. If you paid, wait 30s and try again.').slice(0,180)
    };
  }

  if (order.selectedAccount) releaseSwiggyAccountReservation(order.selectedAccount, order.id);
  order.status = 'COMPLETED';
  order.swiggyOrderId = check.swiggyOrderId || order.pendingSwiggyOrderId || order.swiggyOrderId || '';
  order.liveOrderStatus = check.orderStatus || order.liveOrderStatus || 'Order Confirmed';
  const trackingCandidate = check.nativeShareUrl || check.swiggyWebTrackUrl || '';
  const providerTrackingUrl = trackingCandidate
    ? getStoredSwiggyTrackingUrl({ trackingLink: trackingCandidate, trackingLinkSource: 'SWIGGY_API' })
    : '';
  const existingTrustedTrackingUrl = getStoredSwiggyTrackingUrl(order);
  order.trackingLink = providerTrackingUrl || existingTrustedTrackingUrl;
  order.trackingLinkSource = providerTrackingUrl ? 'SWIGGY_API' : (existingTrustedTrackingUrl ? order.trackingLinkSource : '');
  order.shareTrackUrl = '';
  order.deliveryOtp = check.deliveryOtp || order.deliveryOtp || '';
  order.deliveryBoyName = check.deliveryBoy?.name || order.deliveryBoyName || '';
  order.deliveryBoyMobile = check.deliveryBoy?.mobile || order.deliveryBoyMobile || '';
  order.uxStage = getStoredSwiggyTrackingUrl(order) ? 'SCREEN_05_TRACKING_READY' : 'SCREEN_05_PAID_TRACKING_DELAYED';
  saveDb(db);

  // Auto-edit the customer's payment QR message in-place to inject tracking link/OTP (Swiggy payment hote hi edit)
  try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}

  const firstBossChatId = db.config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
  await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId, order);
  startOrderDeliveryInfoPoller({
    telegram: bot.telegram,
    chatId: firstBossChatId,
    orderId: order.id,
    formatOrderBodyFn: formatUserOrderCardText
  });
  // Payment is confirmed — fetch the real Swiggy share link automatically.
  // No button, no manual "Extract Tracking Link" needed.
  try { startOrderTrackingAuto(order.id, { budgetMs: 15000 }); } catch {}

  const trackingLink = getStoredSwiggyTrackingUrl(order);
  return {
    paid: true,
    trackingLink,
    deliveryOtp: order.deliveryOtp || '',
    message: trackingLink
      ? '✓ Payment verified. Swiggy tracking is available.'
      : 'Payment verified successfully. Swiggy tracking is not available yet. I\'ll retry shortly.'
  };
}

bot.action(/^user_approve_bill_([A-Za-z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking bill approval and Swiggy payment details...').catch(() => {});
  const result = await approveUserOrderBillAction(String(ctx.from.id), ctx.match[1]);
  if (!result.ok) await ctx.reply(`! ${escapeHtml(result.error || 'Bill approval failed.')}`).catch(() => {});
});

bot.action(/^user_bill_issue_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const result = await rejectUserOrderBillAction(String(ctx.from.id), ctx.match[1]);
  if (!result.ok) return ctx.answerCbQuery(result.error || 'Could not return this order for edits.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Returned to your order screen for edits.').catch(() => {});
  const screen = getUserScreen(ctx.from.id, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(/^user_paid_status_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: not your order.', { show_alert: true }).catch(() => {});
  }
  const res = await checkOrderPaidStatusOnly(orderId);
  await ctx.answerCbQuery(res.message, { show_alert: true }).catch(() => {});
});

bot.action(/^user_resend_approved_qr_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: not your order.', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status) || !order.billApprovedByUser) {
    return ctx.answerCbQuery('No unpaid approved payment QR is available.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Resending the same Swiggy payment request; no new QR/order will be created.').catch(() => {});
  try {
    await sendApprovedOrderPaymentToUser(String(ctx.from.id), order, { force: true });
  } catch (error) {
    await ctx.reply(`! ${escapeHtml(`Could not resend the existing Swiggy payment details: ${error.message}`)}`).catch(() => {});
  }
});

// Lightweight health check server + Swiggy tracking endpoints + 24x7 Keep-Alive
const healthPort = Number(process.env.PORT || 0);
if (healthPort > 0) {
  const server = http.createServer(async (req, res) => {
    try {
      notePublicServiceOrigin(req);
      const reqUrl = new URL(req.url || '/', `http://localhost:${healthPort}`);

      // Live & Delivered Zero-Login Swiggy Order Tracking JSON Endpoint (`/api/track/:orderId?sig=...`)
      const apiTrackMatch = reqUrl.pathname.match(/^\/api\/track\/([A-Za-z0-9_-]+)$/);
      if (apiTrackMatch) {
        const orderId = apiTrackMatch[1];
        const sig = reqUrl.searchParams.get('sig') || '';
        if (sig !== computeTrackHmac(orderId)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'Unauthorized tracking signature' }));
        }
        const resolved = await resolveTrackEndpointPayload(orderId, {
          db: getDb(),
          onLiveDiscovery: async (ord, database) => {
            const firstBossChatId = database.config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
            if (firstBossChatId) {
              await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId, ord);
            }
          }
        });
        if (!resolved.ok) {
          res.writeHead(resolved.statusCode || 404, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: resolved.error || 'Order not found' }));
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify(resolved.payload));
      }

      // Live & Delivered Zero-Login Shareable Swiggy Order Tracking Web Page (`/track/:orderId?sig=...`)
      const pageTrackMatch = reqUrl.pathname.match(/^\/track\/([A-Za-z0-9_-]+)$/);
      if (pageTrackMatch) {
        const orderId = pageTrackMatch[1];
        const sig = reqUrl.searchParams.get('sig') || '';
        if (sig !== computeTrackHmac(orderId)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Invalid or unauthorized live tracking link.');
        }
        const safeOrderId = JSON.stringify(orderId);
        const safeSig = JSON.stringify(sig);
        const trackHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Swiggy Order • #${escapeHtml(orderId)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  body{background:#0f172a;color:#f8fafc;min-height:100vh;padding:14px}
  .wrap{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:18px;padding:16px;box-shadow:0 12px 30px rgba(0,0,0,.35)}
  .badge{display:inline-flex;align-items:center;gap:6px;background:rgba(16,185,129,.16);color:#34d399;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700}
  .badge.cancel{background:rgba(239,68,68,.18);color:#f87171}
  .status{font-size:22px;font-weight:800;margin-top:10px;color:#fff}
  .sub{font-size:13px;color:#94a3b8;margin-top:4px}
  #map{width:100%;height:240px;border-radius:14px;overflow:hidden;background:#0b1220}
  .row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid rgba(148,163,184,.14);font-size:14px}
  .row:last-child{border-bottom:none}
  .row .val{text-align:right;word-break:break-word;max-width:68%}
  .muted{color:#94a3b8;font-size:13px;flex-shrink:0}
  .otpbox{display:inline-block;background:rgba(252,128,25,.16);border:1px solid rgba(252,128,25,.5);color:#fb923c;padding:4px 10px;border-radius:8px;font-weight:800;letter-spacing:2px;font-size:15px}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:13px 16px;border-radius:12px;background:#fc8019;color:#fff;text-decoration:none;font-weight:800;font-size:15px}
  .callbtn{padding:7px 13px;border-radius:10px;background:#10b981;color:#fff;text-decoration:none;font-weight:700;font-size:13px}
  .sec-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:6px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span class="badge" id="badge">● ORDER STATUS · SWIGGY</span>
      <span class="muted" id="eta">Syncing...</span>
    </div>
    <div class="status" id="st">Fetching order details...</div>
    <div class="sub" id="sub">Verified directly from Swiggy order data.</div>
  </div>
  <div class="card" style="padding:10px" id="mapCard"><div id="map"></div></div>
  <div class="card" id="riderCard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="muted">Delivery Partner</div>
        <div style="font-size:17px;font-weight:800;margin-top:2px" id="riderName">-</div>
      </div>
      <a class="callbtn" id="riderCall" href="#" style="display:none">☎ Call Rider</a>
    </div>
  </div>
  <div class="card" id="itemsCard" style="display:none">
    <div class="sec-title">Ordered Items</div>
    <div id="itemsList"></div>
  </div>
  <div class="card">
    <div class="sec-title">Order Summary</div>
    <div class="row"><span class="muted">Restaurant</span><strong class="val" id="rest">-</strong></div>
    <div class="row"><span class="muted">Swiggy Order ID</span><code class="val" id="soid">-</code></div>
    <div class="row" id="otpRow" style="display:none"><span class="muted">Delivery OTP</span><span class="otpbox" id="otpVal">-</span></div>
    <div class="row"><span class="muted">Order For</span><strong class="val" id="cust">-</strong></div>
    <div class="row" id="addrRow" style="display:none"><span class="muted">Deliver To</span><span class="val" id="addrVal">-</span></div>
    <div class="row" id="timeRow" style="display:none"><span class="muted">Order Time</span><span class="val" id="timeVal">-</span></div>
    <div class="row"><span class="muted">Paid Amount</span><strong class="val" id="amt">-</strong></div>
  </div>
  <a class="btn" id="swLink" href="#" target="_blank" rel="noopener" style="display:none">↗ Open official Swiggy tracking</a>
</div>
<script>
const OID = ${safeOrderId}, SIG = ${safeSig};
let map, riderMarker, destMarker, restMarker, routeLine, pollTimer = null;
async function refresh() {
  try {
    const r = await fetch('/api/track/' + encodeURIComponent(OID) + '?sig=' + encodeURIComponent(SIG));
    const d = await r.json();
    if (!d.ok) {
      document.getElementById('st').textContent = d.error || 'Order not found';
      return;
    }
    const badge = document.getElementById('badge');
    if (d.isCancelled) {
      badge.className = 'badge cancel';
      badge.textContent = '× ORDER CANCELLED';
    } else if (d.isDelivered) {
      badge.className = 'badge';
      badge.textContent = '✓ DELIVERED · SWIGGY VERIFIED';
    } else {
      badge.className = 'badge';
      badge.textContent = '● LIVE ORDER · SWIGGY';
    }
    document.getElementById('st').textContent = d.orderStatus || 'Order Confirmed';
    document.getElementById('sub').textContent = d.statusSubText || (d.orderTime ? ('Ordered: ' + d.orderTime) : ('Synced: ' + new Date().toLocaleTimeString()));
    document.getElementById('eta').textContent = d.isDelivered ? '✓ Delivered' : (d.isCancelled ? 'Cancelled' : (d.etaMinutes ? ('◷ ' + d.etaMinutes + ' mins') : 'Live'));
    document.getElementById('rest').textContent = d.restaurantAddress ? (d.restaurantName + ' · ' + d.restaurantAddress) : (d.restaurantName || '-');
    document.getElementById('soid').textContent = d.swiggyOrderId || OID;
    document.getElementById('cust').textContent = d.customerName || '-';
    document.getElementById('amt').textContent = d.finalPayable ? ('₹' + d.finalPayable) : '₹0';
    if (d.deliveryOtp) {
      document.getElementById('otpRow').style.display = 'flex';
      document.getElementById('otpVal').textContent = d.deliveryOtp;
    }
    const addrText = d.deliveryAddress && (d.deliveryAddress.address || d.deliveryAddress.area || d.deliveryAddress.city);
    if (addrText) {
      document.getElementById('addrRow').style.display = 'flex';
      document.getElementById('addrVal').textContent = addrText;
    }
    if (d.orderTime) {
      document.getElementById('timeRow').style.display = 'flex';
      document.getElementById('timeVal').textContent = d.orderTime;
    }
    if (Array.isArray(d.items) && d.items.length > 0) {
      const itemsCard = document.getElementById('itemsCard');
      const itemsList = document.getElementById('itemsList');
      itemsCard.style.display = 'block';
      itemsList.innerHTML = '';
      d.items.forEach(function(it) {
        const row = document.createElement('div');
        row.className = 'row';
        const left = document.createElement('span');
        left.textContent = (it.name || 'Item') + (it.qty > 1 ? (' × ' + it.qty) : '');
        const right = document.createElement('strong');
        right.textContent = it.price ? ('₹' + it.price) : ('×' + (it.qty || 1));
        row.appendChild(left);
        row.appendChild(right);
        itemsList.appendChild(row);
      });
    }
    const swLink = document.getElementById('swLink');
    if (d.swiggyWebTrackUrl) {
      swLink.href = d.swiggyWebTrackUrl;
      swLink.textContent = '↗ Open official Swiggy tracking';
      swLink.style.display = 'flex';
    } else {
      swLink.style.display = 'none';
    }
    if (d.deliveryBoy && d.deliveryBoy.name) {
      document.getElementById('riderCard').style.display = 'block';
      document.getElementById('riderName').textContent = '↗ ' + d.deliveryBoy.name;
      if (d.deliveryBoy.mobile) {
        const cb = document.getElementById('riderCall');
        cb.style.display = 'inline-block';
        cb.href = 'tel:' + d.deliveryBoy.mobile;
      }
    }
    const dLat = parseFloat(d.deliveryAddress && d.deliveryAddress.lat), dLng = parseFloat(d.deliveryAddress && d.deliveryAddress.lng);
    const rLat = parseFloat(d.deliveryBoy && d.deliveryBoy.lat), rLng = parseFloat(d.deliveryBoy && d.deliveryBoy.lng);
    const sLat = parseFloat(d.restaurantLat), sLng = parseFloat(d.restaurantLng);
    const cLat = !isNaN(rLat) ? rLat : (!isNaN(dLat) ? dLat : (!isNaN(sLat) ? sLat : 26.8658));
    const cLng = !isNaN(rLng) ? rLng : (!isNaN(dLng) ? dLng : (!isNaN(sLng) ? sLng : 80.9307));
    if (!map && window.L) {
      map = L.map('map').setView([cLat, cLng], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    }
    const bounds = [];
    if (map && !isNaN(sLat) && !isNaN(sLng)) {
      bounds.push([sLat, sLng]);
      if (!restMarker) restMarker = L.marker([sLat, sLng]).addTo(map).bindPopup('🍽 ' + (d.restaurantName || 'Restaurant'));
      else restMarker.setLatLng([sLat, sLng]);
    }
    if (map && !isNaN(dLat) && !isNaN(dLng)) {
      bounds.push([dLat, dLng]);
      if (!destMarker) destMarker = L.marker([dLat, dLng]).addTo(map).bindPopup('⌖ Delivery Address');
      else destMarker.setLatLng([dLat, dLng]);
    }
    if (map && !isNaN(sLat) && !isNaN(sLng) && !isNaN(dLat) && !isNaN(dLng)) {
      if (!routeLine) routeLine = L.polyline([[sLat, sLng], [dLat, dLng]], { color: '#fc8019', weight: 3, dashArray: '7,7' }).addTo(map);
      else routeLine.setLatLngs([[sLat, sLng], [dLat, dLng]]);
    }
    if (map && !isNaN(rLat) && !isNaN(rLng)) {
      bounds.push([rLat, rLng]);
      if (!riderMarker) riderMarker = L.marker([rLat, rLng]).addTo(map).bindPopup('↗ Delivery Partner (Live)').openPopup();
      else riderMarker.setLatLng([rLat, rLng]);
      map.setView([rLat, rLng], 15);
    } else if (map && bounds.length >= 2) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
    } else if (map && bounds.length === 1) {
      map.setView(bounds[0], 15);
    }
    if ((d.isDelivered || d.isCancelled) && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (e) {}
}
refresh();
pollTimer = setInterval(refresh, 8000);
</script>
</body>
</html>`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        return res.end(trackHtml);
      }

    } catch (e) {}

    const liveAccounts = Object.values(getDb().config?.accounts || {}).filter(a => a?.isLoggedIn);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bot: 'online',
      build: 'telegram-button-order-flow',
      ipv4Shield: true,
      zeroSmsShield: true,
      zeroChromiumOrderFlow: true,
      tenOrderParallelAutoDispatch: true,
      zeroOtpCartIntake: true,
      cloudAccountVault: true,
      activeVaultAccounts: liveAccounts.length,
      timestamp: new Date().toISOString()
    }));
  });
  server.listen(healthPort, '0.0.0.0', () => {
    console.log(`◎ Cloud health & Swiggy tracking server listening on 0.0.0.0:${healthPort}`);
  });

  // Self keep-alive ping every 8 minutes via public Render edge URL so container never idles out
  const keepAliveUrl = PUBLIC_SERVICE_URL + '/';
  setInterval(() => {
    fetch(keepAliveUrl, { signal: AbortSignal.timeout(10000) })
      .then(r => console.log(`♥ Keep-alive ping -> ${keepAliveUrl} [${r.status}]`))
      .catch(e => console.log(`♥ Keep-alive retry note: ${e.message}`));
  }, 8 * 60 * 1000).unref();
}

// Non-blocking Concurrent Parallel Update Dispatcher:
// Telegraf's polling loop defaults to `await this.handleUpdate(update)` one update at a time,
// which would block Account #2 / Order #2 behind Account #1's Swiggy API calls!
// Dispatching concurrently lets 2..N Swiggy IDs fetch bills, generate QRs, & place orders AT THE EXACT SAME TIME!
const rawBotHandleUpdate = bot.handleUpdate.bind(bot);
bot.handleUpdate = (update, webhookResponse) => {
  rawBotHandleUpdate(update, webhookResponse).catch((err) => {
    console.error('[ConcurrentUpdateDispatcher] Unhandled error:', err);
  });
  return Promise.resolve();
};

bot.command('parallel', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  try {
    const out = await dispatchAllReadyOrdersInParallel({
      telegram: ctx.telegram,
      chatId: ctx.chat.id,
      formatOrderBodyFn: formatUserOrderCardText
    });
    if (out.dispatched === 0) {
      return ctx.reply(`i ${out.reason}`, { parse_mode: 'HTML' });
    }
    const okCount = out.settled.filter(s => s.status === 'fulfilled').length;
    await ctx.reply(
      `! <b>Parallel Multi-ID Sync Complete:</b> <b>${okCount}/${out.dispatched}</b> ready order(s) fetched simultaneously on separate Swiggy IDs!`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    const diag = formatBossDiagnosticErrorMessage(err, { stage: 'COMMAND_PARALLEL' });
    await ctx.reply(diag, { parse_mode: 'HTML' });
  }
});

let autoEventPrebookTimer = null;
function startAutoEventOffersPrebookLoop() {
  if (autoEventPrebookTimer) return;
  const runSweep = async () => {
    try {
      const db = getDb();
      const entries = Object.entries(db?.config?.accounts || {}).filter(([, a]) => a?.isLoggedIn && (a.cookies || a.tid || a.token));
      if (entries.length === 0) return;
      await Promise.all(
        entries.map(async ([, acc]) => {
          const out = await claimSwiggyBreakfastAndLateNightOffers(acc, {
            force: true,
            offerValue: acc.preferredOfferValue || 1
          }).catch(() => null);
          if (out) acc.offers = out;
        })
      );
      saveDb(db);
      console.log(`▣ [AutoPreBook] Locked Breakfast + Late Night offers across 15 days for ${entries.length} account(s)!`);
    } catch (e) {
      console.warn('[AutoPreBook] Sweep warning:', e.message);
    }
  };
  const bootKick = setTimeout(runSweep, 2500);
  if (typeof bootKick.unref === 'function') bootKick.unref();
  // Run every 2 hours so every account is ALWAYS pre-booked well before both 05:00 AM IST & 06:30 PM IST cutoffs!
  autoEventPrebookTimer = setInterval(runSweep, 2 * 60 * 60 * 1000);
  if (typeof autoEventPrebookTimer.unref === 'function') autoEventPrebookTimer.unref();
}

// Registers the command list + a plain "commands" menu button.
// Kept dependency-free and fully guarded: a Telegram-side hiccup must never
// stop the bot from serving /start or orders.
let botMenuReady = false;
async function setupBotMenu() {
  if (botMenuReady) return true;
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start a new Swiggy order' },
      { command: 'help', description: 'How to place an order' },
      { command: 'cancel', description: 'Cancel the current draft order' }
    ]);
  } catch (e) {
    console.warn('[Menu] setMyCommands skipped:', e?.message || e);
  }
  try {
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
  } catch (e) {
    console.warn('[Menu] setChatMenuButton skipped:', e?.message || e);
  }
  botMenuReady = true;
  return true;
}

// Launch bot with retry resilience for cloud container handover
console.log('› Connecting to Telegram Bot API...');
async function startBotWithRetry() {
  try {
    // Restore ALL saved `.json` accounts from Persistent Cloud Vault BEFORE serving orders!
    await hydrateAccountsFromCloudVault().catch(e => console.warn('CloudVault boot warning:', e.message));

    const me = await bot.telegram.getMe();
    console.log(`⚙ Logged in as @${me.username} (${me.first_name}) [ID: ${me.id}]`);

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        console.log('⚙ Telegram Swiggy Real OTP Flow Bot is running live!');
        startWafKeepWarmLoop();
        startAutoEventOffersPrebookLoop();
        if (process.env.PREWARM_CHROME === 'true') {
          console.log('! Priming pre-warmed Chrome for instant OTP in background...');
          prewarmBrowser().catch(e => console.log('Prewarm init note:', e.message));
        }
        await bot.launch({ dropPendingUpdates: true });
        try { await setupBotMenu(); } catch (e) { console.error('Menu setup error:', e.message); }
        resumeAutoTrackingForRecentOrders();
        break;
      } catch (err) {
        if ((err.message?.includes('409') || err.description?.includes('Conflict')) && attempt < 10) {
          console.log(`◷ [Attempt ${attempt}/10] Telegram 409 Conflict (previous cloud container shutting down). Retrying in 4 seconds...`);
          await new Promise(r => setTimeout(r, 4000));
        } else {
          console.error('× Launch error:', err.message);
          break;
        }
      }
    }
  } catch (err) {
    console.error('× Failed to connect to Telegram:', err);
  }
}

// ---------------------------------------------------------------------------
// AUTOMATIC TRACKING NOTIFIER
// ---------------------------------------------------------------------------
// Called by order-tracking.js the moment a genuine Swiggy share/tracking link
// is discovered. Everything below is best-effort and never throws upward.
async function pushTrackingReadyNotice(order, { scan } = {}) {
  if (!order) return;
  const url = getStoredSwiggyTrackingUrl(order);
  if (!url) return;
  const db = getDb();
  const swiggyId = swiggyOrderIdOf(order);
  const phone = placedFromPhoneOf(order, db) || orderPlacedFromPhone(order, db);
  const restaurant = String(order.restaurantName || 'Swiggy Order').slice(0, 40);

  const lines = [
    `🔗 <b>Live Swiggy tracking ready</b>`,
    '',
    `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>`,
    `▪ <b>Order ref:</b> <code>#${escapeHtml(String(order.id))}</code>`,
    `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>`,
    `▪ <b>Restaurant:</b> ${escapeHtml(restaurant)}`,
  ];
  if (order.liveOrderStatus) lines.push(`▪ <b>Status:</b> <code>${escapeHtml(String(order.liveOrderStatus))}</code>`);
  if (order.deliveryOtp) lines.push(`▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`);
  lines.push('', `<a href="${escapeHtml(url)}">Open live Swiggy tracking</a>`);
  const text = lines.join('\n');

  // 1) Edit the customer's payment message in place (I-have-paid button gone).
  try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}

  // 2) Show it on the order cards.
  try { await updateOrderCards(order); } catch {}

  // 3) One Telegram message per chat (deduped by URL).
  const notified = (order.trackingNoticeSentTo && typeof order.trackingNoticeSentTo === 'object')
    ? { ...order.trackingNoticeSentTo }
    : {};
  const targets = new Set();
  for (const id of [order.userChatId, order.userId, order.fwdSenderUserId, order.bossChatId]) {
    if (id) targets.add(String(id));
  }
  for (const bossId of (Array.isArray(db.config?.bossIds) ? db.config.bossIds : [])) targets.add(String(bossId));
  const fallbackBoss = Number(process.env.BOSS_ID || 0);
  if (fallbackBoss) targets.add(String(fallbackBoss));

  for (const chatId of targets) {
    if (!chatId || notified[chatId] === url) continue;
    try {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy tracking', url)]])
      });
      notified[chatId] = url;
    } catch {}
  }

  try {
    const fresh = getDb();
    if (fresh.orders?.[order.id]) {
      fresh.orders[order.id].trackingNoticeSentTo = notified;
      saveDb(fresh);
    }
  } catch {}

  // 4) Friends/parents SMS (deduped inside the notice helper by link + OTP).
  try {
    const bossChat = order.bossChatId || db.config?.bossIds?.[0] || fallbackBoss;
    if (bossChat) await sendOrderDeliveryInfoNotice(bot.telegram, bossChat, order);
  } catch {}
}

setOrderTrackingNotifier(pushTrackingReadyNotice);

// After a restart, resume tracking for recent confirmed orders that still have
// no share link — "kal raat se tracking nahi mila" never needs a manual tap.
function resumeAutoTrackingForRecentOrders() {
  try {
    const db = getDb();
    const since = Date.now() - 36 * 60 * 60 * 1000;
    const candidates = Object.values(db.orders || {})
      .filter(order => order && order.id && swiggyOrderIdOf(order) && !getStoredSwiggyTrackingUrl(order))
      .filter(order => ['COMPLETED', 'ACCEPTED'].includes(order.status))
      .filter(order => {
        const created = new Date(order.completedAt || order.createdAt || 0).getTime();
        return Number.isFinite(created) && created >= since;
      })
      .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))
      .slice(0, 6);
    // Stagger the boot scans so 6 orders × 24 IDs never hammer Swiggy at once.
    candidates.forEach((order, index) => {
      startOrderTrackingAuto(order.id, { budgetMs: 12000, deep: false, initialDelayMs: index * 4000 });
    });
    if (candidates.length) console.log(`↻ Auto-tracking resumed for ${candidates.length} recent order(s).`);

    // Catch-up for the old notifier race: orders where Swiggy's genuine link
    // WAS persisted by the scan but the "Live Swiggy tracking ready" push was
    // never delivered (e.g. order 251630299198497). Push it exactly once —
    // `pushTrackingReadyNotice` dedupes per chat by URL via trackingNoticeSentTo.
    const unannounced = Object.values(db.orders || {})
      .filter(order => order && order.id && swiggyOrderIdOf(order) && getStoredSwiggyTrackingUrl(order))
      .filter(order => ['COMPLETED', 'ACCEPTED'].includes(order.status))
      .filter(order => !isCancelledOrRefusedStatus(order.liveOrderStatus))
      .filter(order => {
        const created = new Date(order.completedAt || order.createdAt || 0).getTime();
        return Number.isFinite(created) && created >= since;
      })
      .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))
      .slice(0, 6);
    unannounced.forEach((order, index) => {
      setTimeout(() => {
        pushTrackingReadyNotice(order).catch(() => {});
      }, 5000 + index * 4000);
    });
    if (unannounced.length) console.log(`↻ Tracking notice catch-up queued for ${unannounced.length} recent order(s).`);
  } catch (err) {
    console.warn('[order-tracking] resume failed:', err?.message || err);
  }
}

// Exposed for the offline e2e suites (single-card chat behaviour).
export {
  bot,
  renderUserCard,
  cleanupUserChat,
  userChatCards,
  getUserScreen,
  updateOrderCards,
  promptForLink,
  resetCardAndAskForMissing,
  handleSendToBoss,
  ensureBossBillSummary
};

if (!process.env.TEST_MODE && !process.env.BOT_TEST_MODE) {
  startBotWithRetry();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
