import crypto from 'crypto';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { Markup } from 'telegraf';
// Rate limiter for heavy lazy callbacks (confirm/track) — same policy as index.js extract_now
const _lazyRateMap = new Map();
function _isLazyRateLimited(userId, maxPerWindow = 5, windowMs = 60_000) {
  const k = String(userId); const now = Date.now(); let rec = _lazyRateMap.get(k);
  if (!rec || now - rec.windowStart > windowMs) { rec = { count: 0, windowStart: now }; _lazyRateMap.set(k, rec); }
  if (rec.count >= maxPerWindow) return true; rec.count += 1; return false;
}
import { getDb, saveDb, upsertOrder, appendAuditEvent, maskAccountCode } from './store.js';
import { checkLoggedInFromCookies } from './swiggy-bridge.js';
import { extractSharedUrls, stripSharedLinks, normalizeSharedUrl, collapseSharedLinks } from './link-utils.js';
import { sendParentSmsNotification, sendDirectOrderSms, sendPaymentLinkSms } from './sms-notify.js';
import { startOrderTrackingAuto, ensureOrderTracking, isTerminalDeliveryStatus } from './order-tracking.js';
import {
  detectRecipientRole,
  recipientLabelOf,
  planAccountFallbacks,
  retryFetch,
  isRetryableFetchError,
  storeIntakeSnapshot,
  buildLazyConfirmRow,
  buildLazyRescueCard,
  resolveTrackingDelivery,
  trackingRetryPromiseText,
  lazyActionId
} from './lazy-order-pilot.js';

// Robust order lookup — handles stale callback IDs, case mismatch, or swiggyOrderId passed instead of bot orderId
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__']);
export function isSafeOrderKey(key) {
  const k = String(key || '').trim();
  return k && !UNSAFE_KEYS.has(k) && !k.startsWith('__');
}
export function lookupOrder(db, orderId) {
  if (!db?.orders) return null;
  const raw = String(orderId || '').trim();
  if (!raw) return null;
  if (!isSafeOrderKey(raw)) return null;
  // Use hasOwnProperty to avoid prototype chain lookup
  if (Object.prototype.hasOwnProperty.call(db.orders, raw)) return db.orders[raw];
  const q = raw.toLowerCase();
  const qShort = q.slice(-6);
  for (const o of Object.values(db.orders)) {
    if (!o) continue;
    const bid = String(o.id || '').toLowerCase();
    if (bid === q) return o;
    const sid = String(o.swiggyOrderId || '').toLowerCase();
    if (sid && sid === q) return o;
    const pid = String(o.pendingSwiggyOrderId || '').toLowerCase();
    if (pid && pid === q) return o;
    // Short-id fallback: QR caption shows last 4-6 digits like #299100 — match suffix
    if (q.length >= 4 && q.length <= 10) {
      if (bid.endsWith(q) || bid.endsWith(qShort) || (sid && sid.endsWith(q)) || (pid && pid.endsWith(q))) return o;
    }
  }
  return null;
}

export function orderNotFoundDiag(db, orderId) {
  try {
    const asked = String(orderId || '').trim();
    const isNumericSwiggy = /^\d{6,20}$/.test(asked);
    // Friendly hint instead of exposing internal TEST IDs
    if (isNumericSwiggy) {
      return `Order #${asked} bot DB me nahi mila (DB reset/expire ho sakta hai). Swiggy ka numeric ID hai to 🔗 Extract Tracking Link se All IDs scan karein.`;
    }
    return `Order #${asked} nahi mila. Expire ho gaya ho sakta hai — naya order banayein ya Swiggy numeric ID se Extract Tracking Link try karein.`;
  } catch { return `Order #${String(orderId)} nahi mila`; }
}

// Genuine Swiggy page used as an honest fallback (never a synthesised tracking URL).
const SWIGGY_ORDERS_PAGE = 'https://www.swiggy.com/orders';

import {
  resolveSwiggyLink,
  parseAddressDetails,
  extractAddressShareUrl,
  isAddressShareUrl,
  reverseGeocodeCoords,
  isValidIndianDeliveryCoordinates,
  geocodeAddressDetails,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  extractTrackingViaAllAccounts,
  extractSwiggyProvidedTrackingUrl,
  extractSwiggyDeliveryOtp,
  getStoredSwiggyTrackingUrl,
  isOfficialSwiggyTrackingUrl,
  withSwiggyAccountLock,
  getBusySwiggyAccountsMap,
  releaseSwiggyAccountReservation,
  invalidateAccountOrderProfileCache,
  getSwiggySessionAuth,
  swiggyCartFlush,
  dapiFetch,
  computeTrackHmac as swiggyComputeTrackHmac,
  buildSignedOrderTrackUrl
} from './swiggy-cart.js';

function isValidCartInput(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  // Never treat tracking links as cart (r.swiggy.com / ofo/track)
  if (isOfficialSwiggyTrackingUrl(s)) return false;
  if (/r\.swiggy\.com|\/ofo\/track/i.test(s)) return false;
  if (/https?:\/\/[^\s]*(swiggy\.com|swig\.gy|onelink\.me)/i.test(s) && !/save my address on swiggy/i.test(s)) return true;
  if (/your cart\s*\n|items total\s*:|final bill/i.test(s)) return true;
  return false;
}

function isValidAddressInput(input) {
  const s = String(input || '').trim();
  if (s.length < 10) return false;
  if (/save my address on swiggy|address\s*:|latitude\s*:|https?:\/\/[^\s]*(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(s)) return true;
  if (/\b\d{6}\b/.test(s) && s.length >= 20) return true;
  if ((s.match(/,/g) || []).length >= 2 && s.length >= 20) return true;
  return false;
}

function primaryCartFallback(s){ const u=String(s).trim(); try{ new URL(u.startsWith('http')?u:'https://'+u); return u; }catch{ return ''; } }

// Instant 0ms synchronous input classifier so burst multi-order intake pairs FIFO drafts cleanly without overwriting!
export function classifyRawOrderInputFast(rawText = '', location = null) {
  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    return { hasCart: false, hasAddress: true, primaryCartUrl: '' };
  }
  const s = String(rawText || '').trim();
  if (!s) return { hasCart: false, hasAddress: false, primaryCartUrl: '' };

  const allUrls = extractSharedUrls(s);
  let hasCart = false;
  let hasAddress = false;
  let primaryCartUrl = '';

  for (const u of allUrls) {
    // Never treat a tracking link as cart or address
    if (isOfficialSwiggyTrackingUrl(u)) {
      continue;
    }
    const isMaps = /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u);
    const isCartHint = /\/gc\/|shared_cart|group[_-]?cart|\/cart|restaurant_id=/i.test(u);
    const isAddrHint = /save my address on swiggy/i.test(s) || /onelink\.me\/jgkq\//i.test(u) || /address|shareaddress|delivery/i.test(u) || /(?:^|\/)(?:ofo\/)?address/i.test(u);

    if (isMaps || (isAddrHint && !isCartHint)) {
      hasAddress = true;
    } else if (isCartHint) {
      hasCart = true;
      if (!primaryCartUrl) primaryCartUrl = u;
    } else if (/(swiggy\.com|swig\.gy|onelink\.me)/i.test(u)) {
      if (!hasCart) {
        hasCart = true;
        if (!primaryCartUrl) primaryCartUrl = u;
      } else {
        // If hasCart is already set from another URL, the second Swiggy/Onelink URL is the address!
        hasAddress = true;
      }
    }
  }

  // If there are 2 or more URLs and one is a cart, any other URL is treated as address
  if (hasCart && !hasAddress && allUrls.length >= 2) {
    const secondUrl = allUrls.find(u => u !== primaryCartUrl && !isOfficialSwiggyTrackingUrl(u));
    if (secondUrl) hasAddress = true;
  }

  const textWithoutUrls = stripSharedLinks(s);
  if (!hasCart && /your cart\s*\n|items total\s*:/i.test(s)) {
    hasCart = true;
  }
  if (!hasAddress && textWithoutUrls.length >= 12 && isValidAddressInput(textWithoutUrls)) {
    hasAddress = true;
  }
  if (!hasAddress && !hasCart && isValidAddressInput(s)) {
    hasAddress = true;
  }
  return { hasCart, hasAddress, primaryCartUrl };
}

// Splits a single mega-message containing 2..N `Cart + Address` order blocks into independent per-order texts!
export function splitMultipleOrderBlocks(rawText = '') {
  const raw = String(rawText || '').trim();
  if (!raw) return [];
  // Markdown pastes contain the same link twice (`[url](url)`); collapse them so
  // each cart link is found exactly once before splitting.
  const normalized = collapseSharedLinks(raw);
  const gcLinks = extractSharedUrls(normalized).filter((u) => /\/gc\/|group_cart/i.test(u));
  if (gcLinks.length <= 1) return [raw];

  const positions = [];
  let searchFrom = 0;
  for (const link of gcLinks) {
    let idx = normalized.indexOf(link, searchFrom);
    if (idx === -1) idx = normalized.indexOf(link);
    positions.push(idx === -1 ? 0 : idx);
    searchFrom = (idx === -1 ? 0 : idx) + link.length;
  }

  // Cut at the end of each cart's line so the address block travels with its link.
  const cutPoints = positions.map((pos, i) => {
    if (i === positions.length - 1) return normalized.length;
    const lineEnd = normalized.indexOf('\n', pos + gcLinks[i].length);
    return lineEnd === -1 ? pos + gcLinks[i].length : lineEnd;
  });

  const segments = [];
  let start = 0;
  for (const end of cutPoints) {
    const chunk = normalized.slice(start, end).trim();
    if (chunk) segments.push(chunk);
    start = end;
  }
  return segments.length >= 2 ? segments : [raw];
}

const activePaymentPollers = new Map();
const activeDeliveryInfoPollers = new Map();
const senderIntakeLocks = new Map();
const orderIngestLocks = new Map();

async function withOrderIngestLock(orderId, fn) {
  const key = String(orderId || 'default_order');
  const prev = orderIngestLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next, () => next);
  orderIngestLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (orderIngestLocks.get(key) === tail) {
      orderIngestLocks.delete(key);
    }
  }
}

export async function withSenderIntakeLock(senderKey, fn) {
  const key = String(senderKey || 'default_sender');
  const prev = senderIntakeLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next, () => next);
  senderIntakeLocks.set(key, tail);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (senderIntakeLocks.get(key) === tail) {
      senderIntakeLocks.delete(key);
    }
  }
}

export function stopOrderPaymentPoller(orderId) {
  const handle = activePaymentPollers.get(orderId);
  if (handle) {
    clearInterval(handle);
    activePaymentPollers.delete(orderId);
  }
}

export function stopOrderDeliveryInfoPoller(orderId) {
  const state = activeDeliveryInfoPollers.get(String(orderId));
  if (state?.timer) clearTimeout(state.timer);
  if (state) state.stopped = true;
  activeDeliveryInfoPollers.delete(String(orderId));
}

export function computeTrackHmac(orderId) {
  return swiggyComputeTrackHmac(orderId);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasLiveWebSessionCookie(acc) {
  return Boolean(acc?.isLoggedIn && checkLoggedInFromCookies(acc));
}

export function formatBossDiagnosticErrorMessage(err, meta = {}) {
  const code = err?.diag?.code || err?.code || 'UNEXPECTED_ERROR';
  const stage = meta.stage || err?.diag?.stage || 'UNKNOWN_STAGE';
  const msg = err?.message || String(err || 'Unknown failure');
  const lines = [
    `[AI-DIAG]`,
    `code: ${code}`,
    `stage: ${stage}`,
    `orderId: ${meta.orderId || 'N/A'}`,
    `account: ${meta.accountKey || 'N/A'}${meta.accountPhone ? ` (${meta.accountPhone})` : ''}`,
    `sender: ${meta.senderName || 'N/A'} (${meta.isForwarded ? 'forwarded' : 'boss-direct'})`,
    ...(meta.cartLink ? [`cart: ${String(meta.cartLink).slice(0, 180)}`] : []),
    ...(meta.addressSummary ? [`address: ${String(meta.addressSummary).replace(/\s+/g, ' ').slice(0, 160)}`] : []),
    ...(err?.diag?.httpStatus ? [`httpStatus: ${err.diag.httpStatus}`] : []),
    ...(err?.diag?.swiggyStatusCode !== undefined ? [`swiggyStatusCode: ${err.diag.swiggyStatusCode}`] : []),
    ...(err?.diag?.swiggyMessage ? [`swiggyMsg: ${err.diag.swiggyMessage}`] : []),
    ...(err?.diag?.rawSnippet ? [`raw: ${String(err.diag.rawSnippet).replace(/\s+/g, ' ').slice(0, 320)}`] : []),
    `error: ${msg}`,
    `time: ${new Date().toISOString()}`
  ];

  const stackFirstLine = (err?.stack || '').split('\n').slice(1, 3).map(s => s.trim()).filter(Boolean).join(' | ');
  if (stackFirstLine) lines.push(`at: ${stackFirstLine}`);

  return `<blockquote>${escapeHtml(lines.join('\n'))}</blockquote>`;
}

export async function sendBossDiagnosticError(ctxOrTelegram, chatId, err, meta = {}) {
  console.error('[AI-DIAG]', meta, err);
  const text = formatBossDiagnosticErrorMessage(err, meta);
  const tg = ctxOrTelegram?.telegram || ctxOrTelegram;
  if (tg && chatId) {
    return tg.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => null);
  }
  return null;
}

export function extractForwardSenderInfo(msg) {
  if (!msg) return null;

  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === 'user' && origin.sender_user) {
      const u = origin.sender_user;
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${u.id}`;
      return {
        isForwarded: true,
        senderKey: `tg_${u.id}`,
        senderUserId: u.id,
        senderName: fullName,
        senderUsername: u.username || ''
      };
    }
    if (origin.type === 'hidden_user') {
      const name = String(origin.sender_user_name || 'Customer').trim();
      return {
        isForwarded: true,
        senderKey: `name_${name.toLowerCase()}`,
        senderUserId: null,
        senderName: name,
        senderUsername: ''
      };
    }
    if (origin.type === 'chat' && origin.sender_chat) {
      const ch = origin.sender_chat;
      const title = String(ch.title || ch.username || `Chat ${ch.id}`).trim();
      return {
        isForwarded: true,
        senderKey: `chat_${ch.id}`,
        senderUserId: ch.id,
        senderName: title,
        senderUsername: ch.username || ''
      };
    }
    if (origin.type === 'channel' && origin.chat) {
      const ch = origin.chat;
      const title = String(ch.title || ch.username || `Channel ${ch.id}`).trim();
      return {
        isForwarded: true,
        senderKey: `chan_${ch.id}`,
        senderUserId: ch.id,
        senderName: title,
        senderUsername: ch.username || ''
      };
    }
  }

  if (msg.forward_from) {
    const u = msg.forward_from;
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${u.id}`;
    return {
      isForwarded: true,
      senderKey: `tg_${u.id}`,
      senderUserId: u.id,
      senderName: fullName,
      senderUsername: u.username || ''
    };
  }

  if (msg.forward_sender_name) {
    const name = String(msg.forward_sender_name).trim();
    return {
      isForwarded: true,
      senderKey: `name_${name.toLowerCase()}`,
      senderUserId: null,
      senderName: name,
      senderUsername: ''
    };
  }

  if (msg.forward_from_chat) {
    const ch = msg.forward_from_chat;
    const title = String(ch.title || ch.username || `Chat ${ch.id}`).trim();
    return {
      isForwarded: true,
      senderKey: `chat_${ch.id}`,
      senderUserId: ch.id,
      senderName: title,
      senderUsername: ch.username || ''
    };
  }

  return null;
}

export function resolveOrderSenderInfo(msg, fromUser) {
  const fwd = extractForwardSenderInfo(msg);
  if (fwd) return fwd;

  const u = fromUser || msg?.from || {};
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `Boss ${u.id || ''}`.trim() || 'Boss';
  return {
    isForwarded: false,
    senderKey: `boss_self_${u.id || 'main'}`,
    senderUserId: u.id || null,
    senderName: fullName,
    senderUsername: u.username || ''
  };
}

export function looksLikeBossOrderInput(rawText = '', location = null) {
  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    return true;
  }
  const t = String(rawText || '').trim();
  if (!t || t.startsWith('/')) return false;
  // Never treat pure tracking links as order input
  if (isOfficialSwiggyTrackingUrl(t) || /r\.swiggy\.com.*\/track\//i.test(t)) {
    return false;
  }

  if (/https?:\/\/[^\s]*(swiggy\.com|swig\.gy|onelink\.me|maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(t)) {
    return true;
  }
  if (/save my address on swiggy|address\s*:|flat\s*no|house\s*no|latitude\s*:/i.test(t)) {
    return true;
  }
  if (/\b\d{6}\b/.test(t) && t.length >= 25 && /,/.test(t)) {
    return true;
  }
  if (isValidCartInput(t)) {
    return true;
  }
  return false;
}

const FONT_5X7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '#': [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x04, 0x04, 0x08, 0x10, 0x00],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '@': [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0f],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'B': [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  'D': [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  'G': [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'I': [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'J': [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'M': [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'P': [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  'Q': [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  'S': [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  'X': [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  'Z': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  'RS': [0x1f, 0x04, 0x1f, 0x09, 0x06, 0x04, 0x03]
};

function tokenizeBannerText(raw) {
  const tokens = [];
  const clean = String(raw || '').toUpperCase();
  for (const ch of clean) {
    if (ch === '₹') tokens.push('RS');
    else if (FONT_5X7[ch]) tokens.push(ch);
    else if (/\s/.test(ch)) tokens.push(' ');
  }
  return tokens;
}

function fillRect(png, x0, y0, w, h, r, g, b) {
  const xStart = Math.max(0, Math.floor(x0));
  const yStart = Math.max(0, Math.floor(y0));
  const xEnd = Math.min(png.width, Math.ceil(x0 + w));
  const yEnd = Math.min(png.height, Math.ceil(y0 + h));
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
}

function drawCenteredText(png, text, centerY, scale, r, g, b) {
  const maxChars = Math.max(10, Math.floor((png.width - 48) / (6 * scale)));
  const tokens = Array.isArray(text) ? text.slice(0, maxChars) : tokenizeBannerText(text).slice(0, maxChars);
  if (tokens.length === 0) return;
  const totalW = tokens.length * (6 * scale) - scale;
  let cursorX = Math.max(24, Math.floor((png.width - totalW) / 2));
  const startY = Math.floor(centerY - (7 * scale) / 2);

  for (const tok of tokens) {
    const rows = FONT_5X7[tok] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
      const mask = rows[row];
      for (let col = 0; col < 5; col++) {
        if (mask & (1 << (4 - col))) {
          fillRect(png, cursorX + col * scale, startY + row * scale, scale, scale, r, g, b);
        }
      }
    }
    cursorX += 6 * scale;
  }
}

export function truncateDisplayField(rawText, maxChars = 90) {
  const clean = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(8, maxChars - 3)).trim()}...`;
}

export function safeTelegramCaption(htmlText, maxLen = 1000) {
  const str = String(htmlText || '');
  if (str.length <= maxLen) return str;
  // Strip HTML safely only if extreme fallback needed so no broken `<b` tag ever occurs
  const plain = str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  return `${plain.slice(0, maxLen - 4).trim()}...`;
}

// Preserves bank-signed merchant UPI URIs (`sign=...`) 100% byte-for-byte intact while sanitizing unsigned `pn`/`tn` per NPCI UPI 2.0 spec (`<= 30` clean ASCII chars) so giant/Unicode names NEVER bloat QR density!
export function sanitizeUpiUriForQr(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) throw new Error('Empty UPI URI passed to QR generator.');

  // CRITICAL: Never alter a single character if bank cryptographic signature (`sign=`) is present!
  if (/[?&]sign=/i.test(raw) || !/^upi:\/\/pay\?/i.test(raw)) {
    return raw;
  }

  const qIdx = raw.indexOf('?');
  const prefix = raw.slice(0, qIdx + 1);
  const query = raw.slice(qIdx + 1);
  const cleanAsciiParam = (val, maxLen, fallback) => {
    let decoded = val;
    try { decoded = decodeURIComponent(val.replace(/\+/g, ' ')); } catch {}
    const ascii = String(decoded || '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/[&=+#%<>\\"`'|{}[\]^~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen)
      .trim();
    return encodeURIComponent(ascii || fallback);
  };

  const parts = query.split('&').filter(Boolean).map(seg => {
    const eq = seg.indexOf('=');
    if (eq <= 0) return seg;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    const kl = k.toLowerCase();
    if (kl === 'pn') return `${k}=${cleanAsciiParam(v, 28, 'Swiggy')}`;
    if (kl === 'tn') return `${k}=${cleanAsciiParam(v, 32, 'Swiggy Order')}`;
    return seg;
  });

  return `${prefix}${parts.join('&')}`;
}

export async function generateNamedUpiQrPngBuffer({ upiUri, senderName, restaurantName, amount, orderId }) {
  const safeUri = sanitizeUpiUriForQr(upiUri);
  // Adaptive ECC: 'M' for compact URIs (<= 175 chars), 'L' for long signed merchant URIs so module count stays big & crisp!
  const ecc = safeUri.length > 175 ? 'L' : 'M';
  const qrData = QRCode.create(safeUri, { errorCorrectionLevel: ecc });
  const modCount = qrData.modules.size;
  const quietModules = 4; // Full ISO/IEC 18004 4-module quiet zone!
  const totalModules = modCount + quietModules * 2;

  // Exact integer pixel scale per module (`8px`..`16px`) — ZERO anti-aliased gray pixels, AND total PNG strictly <= 1180px so Telegram NEVER downscales!
  const modPx = Math.max(8, Math.min(16, Math.floor(820 / totalModules)));
  const qrBoxPx = totalModules * modPx;
  const guardPad = 32;
  const outW = Math.max(760, qrBoxPx + guardPad * 2);

  // Adaptive multi-line header layout so even 250-char names display cleanly without ever shrinking or touching the QR quiet zone!
  const rawName = String(senderName || restaurantName || 'CUSTOMER').replace(/\s+/g, ' ').trim() || 'CUSTOMER';
  const nameTokens = tokenizeBannerText(rawName);
  let headerLines = [];
  let nameScale = 4;

  const fitCols4 = Math.floor((outW - 56) / 24);
  const fitCols3 = Math.floor((outW - 56) / 18);
  const fitCols2 = Math.floor((outW - 56) / 12);

  if (nameTokens.length <= fitCols4) {
    nameScale = 4;
    headerLines = [nameTokens.length ? nameTokens : tokenizeBannerText('CUSTOMER')];
  } else if (nameTokens.length <= fitCols3) {
    nameScale = 3;
    headerLines = [nameTokens];
  } else {
    nameScale = 2;
    const line1 = nameTokens.slice(0, fitCols2);
    let line2 = nameTokens.slice(fitCols2, fitCols2 * 2);
    if (nameTokens.length > fitCols2 * 2 && line2.length >= 3) {
      line2 = [...line2.slice(0, line2.length - 3), '.', '.', '.'];
    }
    headerLines = line2.length ? [line1, line2] : [line1];
  }

  const headerH = headerLines.length > 1 ? 142 : 118;
  const footerH = 104;
  const outH = headerH + guardPad * 2 + qrBoxPx + footerH;
  const out = new PNG({ width: outW, height: outH });

  // Pure high-contrast white background over entire canvas including quiet zone & guard frame
  fillRect(out, 0, 0, outW, outH, 255, 255, 255);
  fillRect(out, 0, 0, outW, headerH, 252, 128, 25);
  fillRect(out, 0, headerH - 6, outW, 6, 224, 98, 8);

  if (headerLines.length === 1) {
    drawCenteredText(out, headerLines[0], 44, nameScale, 255, 255, 255);
    drawCenteredText(out, `OFFICIAL SWIGGY QR  #${String(orderId || '').slice(0, 24)}`, 90, 2, 255, 245, 232);
  } else {
    drawCenteredText(out, headerLines[0], 34, 2, 255, 255, 255);
    drawCenteredText(out, headerLines[1], 66, 2, 255, 255, 255);
    drawCenteredText(out, `OFFICIAL SWIGGY QR  #${String(orderId || '').slice(0, 24)}`, 108, 2, 255, 245, 232);
  }

  // Paint every dark QR module with 100% crisp integer coordinates — zero interpolation blur!
  const qrOriginX = Math.floor((outW - qrBoxPx) / 2) + quietModules * modPx;
  const qrOriginY = headerH + guardPad + quietModules * modPx;
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (qrData.modules.get(r, c)) {
        fillRect(out, qrOriginX + c * modPx, qrOriginY + r * modPx, modPx, modPx, 0, 0, 0);
      }
    }
  }

  const footerTop = headerH + guardPad * 2 + qrBoxPx;
  fillRect(out, 0, footerTop, outW, footerH, 248, 250, 252);
  fillRect(out, 28, footerTop + 6, outW - 56, 2, 226, 232, 240);
  drawCenteredText(out, `PAY ₹${amount}`, footerTop + 44, 4, 15, 23, 42);
  drawCenteredText(out, `AUTO PLACES ORDER ON SWIGGY`, footerTop + 84, 2, 22, 163, 74);

  // Built-in real camera decoder verification on rendered pixels (`jsQR`) — fallback to ultra-clean pure QR if ever needed!
  const decoded = jsQR(new Uint8ClampedArray(out.data), out.width, out.height);
  if (!decoded || decoded.data !== safeUri) {
    return QRCode.toBuffer(safeUri, {
      type: 'png',
      scale: 10,
      margin: 4,
      errorCorrectionLevel: ecc,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
  }

  return PNG.sync.write(out);
}

export function findIncompleteForwardedOrder(db, senderInfo, incomingHint = null) {
  if (!db?.orders || !senderInfo) return null;

  // If the incoming message ALREADY carries BOTH Cart + Address, start a brand-new independent Order immediately!
  if (incomingHint && incomingHint.hasCart && incomingHint.hasAddress) {
    return null;
  }

  const candidates = Object.values(db.orders).filter(o => {
    if (!o || o.isForwardedOrder !== true) return false;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) return false;
    if (['AUTO_SELECTING', 'NEED_ACCOUNT', 'BILL_READY', 'QR_GENERATED', 'PAID_CONFIRMED'].includes(o.cardStage)) {
      return false;
    }
    // A rescue card older than 30 minutes no longer pairs with new forwards —
    // its links have almost certainly expired, so start a clean order instead.
    if (o.cardStage === 'FETCH_FAILED') {
      const failedAt = new Date(o.fetchFailedAt || o.createdAt || 0).getTime();
      if (Number.isFinite(failedAt) && Date.now() - failedAt > 30 * 60 * 1000) return false;
    }
    // CRITICAL 10x MULTI-ORDER FIX: Once an order has BOTH Cart & Address (or pending slots), its intake is 100% COMPLETE —
    // NEVER overwrite it when Boss shares the 2nd, 3rd, ..., 10th order!
    const hasCartNow = Boolean(o.cart || o._pendingCartSlot);
    const hasAddrNow = Boolean(o.address || o._pendingAddrSlot);
    if (hasCartNow && hasAddrNow) return false;

    if (!senderInfo.isForwarded) {
      return o.isDirectBossOrder === true && String(o.fwdSenderKey) === String(senderInfo.senderKey);
    }
    if (o.isDirectBossOrder === true) return false;

    if (senderInfo.senderUserId && o.fwdSenderUserId) {
      return String(o.fwdSenderUserId) === String(senderInfo.senderUserId);
    }
    return String(o.fwdSenderKey || '').toLowerCase() === String(senderInfo.senderKey || '').toLowerCase();
  });

  if (candidates.length === 0) return null;

  // Sort FIFO oldest-first (`createdAt ASC`) so rapid batches (`Cart1..Cart10` then `Addr1..Addr10`) pair 1-for-1 cleanly!
  candidates.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  if (incomingHint) {
    if (incomingHint.hasCart && !incomingHint.hasAddress) {
      if (incomingHint.primaryCartUrl) {
        const exactSameCart = candidates.find(o => (o.cart || o._pendingCartSlot) === incomingHint.primaryCartUrl);
        if (exactSameCart) return exactSameCart;
      }
      return candidates.find(o => !o.cart && !o._pendingCartSlot && Boolean(o.address || o._pendingAddrSlot)) || null;
    }
    if (incomingHint.hasAddress && !incomingHint.hasCart) {
      return candidates.find(o => !o.address && !o._pendingAddrSlot && Boolean(o.cart || o._pendingCartSlot)) || null;
    }
  }

  return candidates[0];
}

export async function deleteOrderBotMessages(telegram, chatId, order, { includeQr = false } = {}) {
  if (!telegram || !chatId || !order) return;
  const ids = new Set();
  if (order.activeCardMessageId) ids.add(order.activeCardMessageId);
  if (Array.isArray(order.trackedCardMessageIds)) {
    for (const mid of order.trackedCardMessageIds) {
      if (mid) ids.add(mid);
    }
  }
  if (includeQr) {
    if (order.activeQrMessageId) ids.add(order.activeQrMessageId);
    if (Array.isArray(order.trackedQrMessageIds)) {
      for (const qid of order.trackedQrMessageIds) {
        if (qid) ids.add(qid);
      }
    }
  }

  await Promise.all(
    Array.from(ids).map(msgId => telegram.deleteMessage(chatId, msgId).catch(() => {}))
  );

  order.activeCardMessageId = null;
  order.trackedCardMessageIds = [];
  if (includeQr) {
    order.activeQrMessageId = null;
    order.trackedQrMessageIds = [];
  }
}

// Helper: try to edit the existing payment QR message in-place to show tracking link (per user request: payment message edit hokar usme link ajaye)
async function tryEditForwardedPaymentMessageWithTracking(telegram, chatId, order) {
  if (!telegram || !chatId || !order?.activeQrMessageId) return false;
  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  const swiggyId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  const restName = String(order.restaurantName || 'Swiggy Order').trim();
  const senderName = String(order.fwdSenderName || order.userName || 'Customer').trim();
  const otp = String(order.deliveryOtp || '').trim();
  const amt = Number(order.finalPayable || order.finalTotal || 0);

  let caption = '';
  if (trackingUrl) {
    caption = `\u2705 <b>PAYMENT SUCCESS \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (senderName ? `\uD83D\uDC64 <b>For:</b> ${escapeHtml(senderName)}\n` : '') +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      (order.etaMinutes ? `\u23F1\uFE0F <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min\n` : '') +
      (otp ? `\uD83D\uDD22 <b>Delivery OTP:</b> <code>${escapeHtml(otp)}</code>\n` : '') +
      `\n\uD83D\uDD17 <b>Tracking Link:</b>\n<a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingUrl)}</a>\n\n` +
      `<i>Payment verified on Swiggy \u2014 tap tracking to follow rider live.</i>`;
  } else {
    caption = `\u2705 <b>PAYMENT SUCCESS \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      `\n<i>\u2713 Payment verified on Swiggy. Tracking link will appear here automatically \u2014 or tap \"I have paid\" if delayed.</i>`;
  }

  const rows = [];
  if (trackingUrl) rows.push([Markup.button.url('\uD83D\uDD17 Open Swiggy Tracking', trackingUrl)]);
  if (otp) rows.push([Markup.button.callback(`\uD83D\uDCCB Copy OTP ${otp}`, `copy_otp_${order.id}`)]);
  // Per user request: after auto-edit, I-have-paid / fwd_check_paid button disappears (gayab) — only tracking/OTP remain
  const kb = rows.length ? Markup.inlineKeyboard(rows) : { reply_markup: { inline_keyboard: [] } };

  try {
    await telegram.editMessageCaption(chatId, order.activeQrMessageId, undefined, caption, { parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  try {
    await telegram.editMessageText(caption, { chat_id: chatId, message_id: order.activeQrMessageId, parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  return false;
}


function buildSenderHeaderLine(order) {
  const senderLabel = escapeHtml(order.fwdSenderName || order.userName || 'Customer');
  const uname = order.fwdSenderUsername ? ` (@${escapeHtml(order.fwdSenderUsername)})` : '';
  const profileTag = order.fwdSenderUserId
    ? `<a href="tg://user?id=${order.fwdSenderUserId}">${senderLabel}</a>${uname}`
    : `<b>${senderLabel}</b>${uname}`;

  if (order.isDirectBossOrder) {
    return `◉ <b>Order For:</b> ${profileTag}`;
  }
  return `◉ <b>Forwarded From:</b> ${profileTag}`;
}

export function buildTelegramUserBillConfirmationCard(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const itemLines = items.map((item) => {
    const quantity = Number(item.qty || item.quantity || 1);
    const lineTotal = Number(item.lineTotal || (Number(item.price || 0) * quantity) || 0);
    return `▪ ${quantity} × ${escapeHtml(item.name || 'Item')}${lineTotal > 0 ? `: ₹${lineTotal}` : ''}`;
  });
  const address = order?.addressDetails?.address || order?.address || 'Verified delivery address';
  const sub = Number(order?.subtotal || 0);
  const trade = Number(order?.tradeDiscountTotal || 0);
  const disc = Number(order?.discountAmount || 0);
  const fc = Number(order?.freeCashApplied || 0);
  const oneFee = Number(order?.swiggyOneMembershipFee || 0);
  const del = Number(order?.deliveryFee || 0);
  const pack = Number(order?.packingCharges || 0);
  const taxes = Number(order?.taxesAndCharges || 0);
  const computedTotal = Math.max(0, Math.round((sub - trade - disc - fc + oneFee + del + pack + taxes) * 100) / 100);
  let total = Number(order?.finalPayable ?? order?.finalTotal ?? order?.subtotal ?? 0);
  if (!total || (trade + disc + fc > 0 && total >= sub && computedTotal < total)) {
    total = computedTotal;
    if (order) order.finalPayable = total;
  }
  const billLines = [
    `Restaurant: <b>${escapeHtml(order?.restaurantName || 'Swiggy Order')}</b>`,
    `Deliver to: ${escapeHtml(address)}`,
    order?.addressDetails?.city ? `City: ${escapeHtml(order.addressDetails.city)}` : '',
    '',
    '<b>Bill details</b>',
    `Items subtotal: ₹${Number(order?.subtotal || 0)}`,
    Number(order?.tradeDiscountTotal || 0) > 0 ? `Restaurant offer: −₹${Number(order.tradeDiscountTotal)}` : '',
    order?.couponCode && Number(order?.discountAmount || 0) > 0
      ? `Coupon ${escapeHtml(order.couponCode)}: −₹${Number(order.discountAmount)}`
      : '',
    Number(order?.freeCashApplied || 0) > 0 ? `Swiggy Money / Free Cash: −₹${Number(order.freeCashApplied)}` : '',
    Number(order?.freeDeliveryDiscount || 0) > 0 ? `Free-delivery saving: −₹${Number(order.freeDeliveryDiscount)}` : '',
    `Delivery: ${Number(order?.deliveryFee || 0) > 0 ? `₹${Number(order.deliveryFee)}` : 'FREE'}`,
    Number(order?.packingCharges || 0) > 0 ? `Packing: ₹${Number(order.packingCharges)}` : '',
    Number(order?.taxesAndCharges || 0) > 0 ? `GST and other charges: ₹${Number(order.taxesAndCharges)}` : '',
    Number(order?.totalSavings || 0) > 0 ? `Total savings: ₹${Number(order.totalSavings)}` : '',
    `<b>Total to pay: ₹${total}</b>`,
    '',
    '<i>Approving sends the official Swiggy payment details to you. If a Swiggy request already exists, the same request is reused; a button tap alone never marks payment complete.</i>'
  ].filter(Boolean);
  if (itemLines.length) {
    billLines.splice(3, 0, '<b>Items</b>', ...itemLines);
  }

  const text =
    `i <b>Please check the delivery address and final bill.</b>\n\n` +
    `<b>Order #${escapeHtml(order?.id || '')} — Approval pending</b>\n\n` +
    billLines.join('\n');
  const keyboard = Markup.inlineKeyboard([
    [{ text: '✓ Approve bill', callback_data: `user_approve_bill_${order.id}`, style: 'success' }],
    [{ text: '! Something is wrong', callback_data: `user_bill_issue_${order.id}`, style: 'danger' }]
  ]);
  return { text, keyboard };
}

// ---------------------------------------------------------------------------
// Customer identity + one-time bill summary
// ---------------------------------------------------------------------------
// Resolve the customer's Telegram chat for an order. Boss's own orders and
// orders that only exist in the Boss chat return '' so a summary is never sent
// back to the Boss by accident.
export function resolveCustomerChatId(order, bossIds = []) {
  const target = String(order?.fwdSenderUserId || order?.userChatId || order?.userId || '').trim();
  if (!target) return '';
  if (order?.isDirectBossOrder || order?.isForwardedOrder) return '';
  if (order?.isCustomerSubmitted === true) return target;
  const bossSet = new Set((bossIds || []).map(id => String(id)));
  if (bossSet.has(target)) return '';
  if (order?.bossChatId && String(order.bossChatId) === target) return '';
  return target;
}

// Who must see the max-discount bill summary?
//   * Boss forwarded the message  -> only the Bot (Boss chat): the customer may
//     not even be a bot user, and Boss is the one placing the order.
//   * Customer tapped Send to Beta -> BOTH: the customer confirms the bill in
//     their chat, the Boss sees the same bill on the order card.
export function resolveBillSummaryAudience(order, db = null) {
  const liveDb = db || getDb();
  const bossIds = [...new Set((liveDb?.config?.bossIds || []).filter(Boolean).map(String))];
  const bossIntake = order?.isForwardedOrder === true || order?.isDirectBossOrder === true;
  if (bossIntake) return 'BOSS_ONLY';
  return resolveCustomerChatId(order, bossIds) ? 'CUSTOMER_AND_BOSS' : 'BOSS_ONLY';
}

export function shouldSendSummaryToCustomer(order, db = null) {
  return resolveBillSummaryAudience(order, db) === 'CUSTOMER_AND_BOSS';
}

// Sends the max-discount bill summary to the customer EXACTLY ONCE.
// After this the order waits in `APPROVAL_PENDING`: the customer taps
// "Approve bill" and only then are the official Swiggy payment details sent.
export async function sendBillSummaryToCustomerOnce(telegram, order, { db = null, force = false, deliver = null, onMessageSent = null } = {}) {
  if (!telegram?.sendMessage || !order?.id) return { sent: false, reason: 'no-telegram' };

  const liveDb = db || getDb();
  const audience = resolveBillSummaryAudience(order, liveDb);
  // A Boss-forwarded order must never message the customer — the summary lives
  // on the Boss card in the bot chat.
  if (audience !== 'CUSTOMER_AND_BOSS') return { sent: false, reason: 'boss-only' };
  const customerId = resolveCustomerChatId(order, liveDb?.config?.bossIds || []);
  if (!customerId) return { sent: false, reason: 'no-customer-chat' };

  if (!force && (order.billSummarySentAt || order.billApprovedByUser)) return { sent: false, reason: 'already-sent' };
  if (['COMPLETED', 'CANCELLED', 'REJECTED', 'PAYMENT_PENDING'].includes(order.status)) return { sent: false, reason: 'not-awaiting-review' };
  const hasVerifiedZeroBill = Boolean(
    order.swiggyVerified &&
    Number(order.subtotal || order.itemTotal || 0) > 0 &&
    order.finalPayable !== null &&
    order.finalPayable !== undefined &&
    Number(order.finalPayable) === 0
  );
  if (Number(order.finalPayable || 0) <= 0 && !hasVerifiedZeroBill) return { sent: false, reason: 'bill-not-ready' };
  if (!order.selectedAccount) return { sent: false, reason: 'no-account' };

  const summary = buildTelegramUserBillConfirmationCard({ ...order, userId: customerId });

  // When the customer already has a single live card, the caller can render the
  // summary into that card instead of sending another chat bubble. `deliver`
  // returns false when it could not update the card -> normal message is sent.
  let deliveredOnCard = false;
  if (typeof deliver === 'function' && !force) {
    try {
      deliveredOnCard = (await deliver(summary)) === true;
    } catch {
      deliveredOnCard = false;
    }
  }
  if (deliveredOnCard) {
    order.status = 'APPROVAL_PENDING';
    order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
    order.billSummarySentAt = new Date().toISOString();
    order.billSummaryAutoSent = true;
    order.billSummaryDelivery = 'SINGLE_CARD';
    order.billSummaryAudience = audience;
    delete order.billSummarySendError;
    const cardDb = getDb();
    cardDb.orders[order.id] = order;
    saveDb(cardDb);
    return { sent: true, customerId, viaCard: true };
  }

  let sentMsg = null;
  try {
    sentMsg = await telegram.sendMessage(customerId, summary.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...summary.keyboard
    });
  } catch (error) {
    order.billSummarySendError = String(error?.message || error).slice(0, 200);
    const failDb = getDb();
    if (failDb.orders?.[order.id]) {
      failDb.orders[order.id].billSummarySendError = order.billSummarySendError;
      saveDb(failDb);
    }
    return { sent: false, reason: 'telegram-error', error: order.billSummarySendError };
  }

  if (sentMsg?.message_id) {
    order.billSummaryMessageId = sentMsg.message_id;
    order.userChatId = order.userChatId || customerId;
    if (typeof onMessageSent === 'function') {
      try { onMessageSent(sentMsg); } catch {}
    }
  }
  order.status = 'APPROVAL_PENDING';
  order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
  order.billSummarySentAt = new Date().toISOString();
  order.billSummaryAutoSent = true;
  order.billSummaryDelivery = 'MESSAGE';
  order.billSummaryAudience = audience;
  delete order.billSummarySendError;

  const freshDb = getDb();
  freshDb.orders[order.id] = order;
  saveDb(freshDb);
  return { sent: true, customerId, messageId: sentMsg?.message_id || null };
}

function summarizeAddressPreview(order) {
  const ad = order.addressDetails || parseAddressDetails(order.address);
  if (!ad) {
    // Never echo an entire pasted message back as the address. A bare link is
    // summarised honestly instead of leaking the chat text next to it.
    const raw = String(order.address || '').trim();
    if (isAddressShareUrl(raw)) return '<i>Address link received — fetching address from Swiggy…</i>';
    if (raw && raw.length <= 120 && !/order\s*account|https?:\/\//i.test(raw)) return escapeHtml(raw);
    return '<i>Not verified yet</i>';
  }
  if (ad.unresolvableShortLink) return '<i>Address link could not be resolved — send a fresh address link or GPS pin</i>';
  const parts = [];
  if (ad.city) parts.push(`<b>${escapeHtml(ad.city)}</b>`);
  if (ad.name) parts.push(escapeHtml(ad.name));
  if (ad.address) parts.push(escapeHtml(ad.address.replace(/\s+/g, ' ').trim()));
  if (ad.lat && ad.lng) parts.push(`(${ad.lat}, ${ad.lng})`);
  return parts.join(' • ') || '<i>Not verified yet</i>';
}

function summarizeCartPreview(order) {
  if (order.restaurantName) {
    const cnt = order.items?.reduce((s, it) => s + Number(it.qty || it.quantity || 1), 0) || 0;
    const sub = order.subtotal ? ` • ₹${order.subtotal}` : '';
    return `<b>${escapeHtml(order.restaurantName)}</b>${cnt ? ` (${cnt} item${cnt > 1 ? 's' : ''}${sub})` : ''}`;
  }
  return `<code>${escapeHtml(String(order.cart || '').slice(0, 90))}</code>`;
}

function normalizeRecipientMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function hasVerifiedDeliveryLocation(order) {
  const address = String(order?.addressDetails?.address || '').trim();
  const lat = Number(order?.addressDetails?.lat);
  const lng = Number(order?.addressDetails?.lng);
  return Boolean(
    address.length >= 8 && !order?.addressDetails?.unresolvableShortLink &&
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= 5.5 && lat <= 38.5 && lng >= 67 && lng <= 99
  );
}

function hasVerifiedDeliveryContact(order) {
  return Boolean(normalizeRecipientMobile(order?.addressDetails?.mobile));
}

export function getReadyOrdersWaitingForAccount(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      (o.cardStage === 'NEED_ACCOUNT' || (!o.selectedAccount && o.cardStage !== 'AUTO_SELECTING')) &&
      Boolean(o.cart) &&
      hasVerifiedDeliveryLocation(o) &&
      hasVerifiedDeliveryContact(o)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

export function getBillReadyOrdersWaitingForQr(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      !(o.status === 'APPROVAL_PENDING' && !o.billApprovedByUser) &&
      o.cardStage === 'BILL_READY' &&
      Boolean(o.selectedAccount) &&
      hasVerifiedDeliveryLocation(o) &&
      hasVerifiedDeliveryContact(o) &&
      Number(o.finalPayable || 0) > 0
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

export function getActiveQrOrdersWaitingForPayment(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      o.cardStage === 'QR_GENERATED' &&
      Boolean(o.selectedAccount) &&
      Boolean(o.pendingSwiggyOrderId)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

export function buildForwardedOrderCardView(order, db, formatOrderBodyFn) {
  const senderLine = buildSenderHeaderLine(order);
  const hasAddress = Boolean(order.address) && hasVerifiedDeliveryLocation(order);
  const hasDeliveryContact = hasVerifiedDeliveryContact(order);
  const hasCart = Boolean(order.cart);
  const directSwiggyUrl = getStoredSwiggyTrackingUrl(order);
  const cancelBtn = Markup.button.callback('✕ Cancel Order', `fwd_cancel_${order.id}`);

  // Stage 0 (Lazy Boss rescue): the forward could not be read. One card, one
  // retry tap — the original forwarded text is already stored on the order.
  if (order.cardStage === 'FETCH_FAILED' && !order.pendingSwiggyOrderId && order.status !== 'COMPLETED') {
    const rescue = buildLazyRescueCard(order, { reason: order.fetchError || '', escapeHtml });
    if (rescue.missing.length > 0 || order.fetchError) {
      return { text: rescue.text, keyboard: { reply_markup: { inline_keyboard: rescue.buttons } } };
    }
  }

  // Stage 4A: show only links returned by Swiggy (or explicitly supplied by the boss).
  if (order.status === 'COMPLETED' && directSwiggyUrl) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const swiggyIdLine = order.swiggyOrderId
      ? `↳ <b>Swiggy order ID:</b> <code>${escapeHtml(String(order.swiggyOrderId))}</code>\n`
      : '';
    const liveStatusLine = order.liveOrderStatus
      ? `↳ <b>Status:</b> ${escapeHtml(order.liveOrderStatus)}${order.etaMinutes ? ` · <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min` : ''}`
      : '';
    const riderLine = order.deliveryBoyName
      ? `\n↳ <b>Delivery partner:</b> ${escapeHtml(order.deliveryBoyName)}${order.deliveryBoyMobile ? ` (<a href="tel:${escapeHtml(order.deliveryBoyMobile)}">${escapeHtml(order.deliveryBoyMobile)}</a>)` : ''}`
      : '';
    const deliveryOtpLine = order.deliveryOtp
      ? `\n⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';

    const text =
      `✓ <b>ORDER PAID &amp; CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n` +
      `${swiggyIdLine}` +
      `${liveStatusLine}${riderLine}${deliveryOtpLine}\n\n` +
      `${bodyHtml}\n\n` +
      `↗ <b>Swiggy tracking link:</b> <a href="${escapeHtml(directSwiggyUrl)}">Open link from Swiggy</a>`;

    const buttons = [
      [Markup.button.url('↗ Open Swiggy tracking', directSwiggyUrl)],
      [Markup.button.callback('🔗 Extract Delivery Link (All IDs)', `fwd_extract_all_${order.id}`)],
      [Markup.button.callback('⌕ Add delivery OTP', `boss_delivery_otp_${order.id}`)],
      [cancelBtn]
    ];
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // Stage 4B (Screen 05): Paid Confirmed, Tracking Delayed -> Retry tracking ONLY, NEVER create 2nd QR!
  if (order.status === 'COMPLETED' && !directSwiggyUrl) {
    const paidAmt = Number(order.finalTotal || order.finalPayable || 0);
    const statusLine = order.liveOrderStatus ? `\n● <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}` : '';
    const etaLine = order.etaMinutes ? `\n◷ <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min` : '';
    const riderLine = order.deliveryBoyName
      ? `\n◉ <b>Delivery partner:</b> ${escapeHtml(order.deliveryBoyName)}${order.deliveryBoyMobile ? ` (<a href="tel:${escapeHtml(order.deliveryBoyMobile)}">${escapeHtml(order.deliveryBoyMobile)}</a>)` : ''}`
      : '';
    const deliveryOtpLine = order.deliveryOtp
      ? `\n⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';
    const text =
      `✓ <b>Payment confirmed: ₹${paidAmt}</b>\n` +
      `<i>No second charge will be requested.</i>\n\n` +
      `<b>#${escapeHtml(order.id)} · ORDER SUMMARY</b>\n` +
      `${senderLine}\n\n` +
      `▣ <b>${escapeHtml(order.restaurantName || 'Swiggy Order')}</b>` +
      `${statusLine}${etaLine}${riderLine}\n` +
      `<i>Swiggy has not shared a tracking link yet. The bot will send it when available.</i>` +
      `${deliveryOtpLine}\n\n` +
      `<b>Payment is final. Only tracking will be retried.</b>\n` +
      `<i>No replacement payment QR will be created.</i>`;

    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('↻ Retry Swiggy tracking', `fwd_retry_track_${order.id}`)],
        [Markup.button.callback('🔗 Extract Delivery Link (All IDs)', `fwd_extract_all_${order.id}`)],
        [Markup.button.callback('⌕ Add delivery OTP', `boss_delivery_otp_${order.id}`)]
      ])
    };
  }

  if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
    const text =
      `◷ <b>WAITING FOR CUSTOMER BILL APPROVAL (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `${formatOrderBodyFn(order, true)}\n\n` +
      `<i>The verified bill summary was sent in Telegram. Payment details will be sent to the customer after approval.</i>`;
    return { text, keyboard: Markup.inlineKeyboard([[cancelBtn]]) };
  }

  // Stage 3: Account Selected & Live Bill Fetched -> [Generate QR] [Paid] [Parallel Batch Buttons] [Re-Scan Offers] [Switch Account] [Cancel]
  if (hasAddress && hasDeliveryContact && hasCart && (order.cardStage === 'BILL_READY' || order.cardStage === 'QR_GENERATED')) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const offerNotes = [];
    if (order.selectedAccount) {
      const accBadge = order.selectedAccountZeroOrders
        ? `+ <b>0-Order Swiggy ID</b>`
        : `● <b>Free Swiggy ID (0 Active Orders)</b>`;
      offerNotes.push(
        `◎ <b>Auto-Matched Account:</b> <code>${escapeHtml(String(order.orderAccount || order.selectedAccount))}</code> (${accBadge})`
      );
    }
    if (order.eventsClaimSummary) {
      const bfMsg = order.eventsClaimSummary.breakfastMsg;
      const lnMsg = order.eventsClaimSummary.lateNightMsg;
      if (bfMsg) offerNotes.push(`• <b>Breakfast:</b> ${escapeHtml(bfMsg)}`);
      if (lnMsg) offerNotes.push(`◷ <b>Late Night:</b> ${escapeHtml(lnMsg)}`);
    }
    if (Number(order.walletSplitPayAmount || 0) > 0) {
      offerNotes.push(`₹ <b>Wallet Split-Pay Ready:</b> ₹${order.walletSplitPayAmount} Swiggy Money auto-deducts from UPI QR!`);
    }
    if (order.offerDiagnostics) {
      offerNotes.push(`i <i>${escapeHtml(order.offerDiagnostics)}</i>`);
    }
    if (order.freeCashMovNote) {
      offerNotes.push(`i <i>${escapeHtml(order.freeCashMovNote)}</i>`);
    }
    const offerStrip = offerNotes.length > 0 ? `\n\n${offerNotes.join('\n')}` : '';
    const qrStatusNote = order.cardStage === 'QR_GENERATED'
      ? `\n\n● <b>Official Swiggy Dynamic QR Active</b> (Swiggy Order <code>${escapeHtml(String(order.pendingSwiggyOrderId || ''))}</code> • Auto-detecting payment every 5s or tap <b>Paid</b>)`
      : '';
    // Lazy Boss mode: ONE obvious tap on top of the card. It is the explicit
    // confirmation step — nothing is charged before Boss (or the customer on
    // their own order) taps it.
    const isBossIntake = Boolean(order.isForwardedOrder || order.isDirectBossOrder);
    const lazyHint = isBossIntake && order.cardStage !== 'QR_GENERATED'
      ? `\n\n⚡ <i>Ek tap: ✅ Confirm → official Swiggy QR → payment ke baad tracking link khud aa jayega.</i>`
      : '';
    const text =
      `▤ <b>ORDER BILL READY (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `${bodyHtml}${offerStrip}${qrStatusNote}${lazyHint}`;

    const readyForQrCount = getBillReadyOrdersWaitingForQr(db).length;
    const activeQrCount = getActiveQrOrdersWaitingForPayment(db).length;
    const rows = [];
    if (isBossIntake && order.cardStage !== 'QR_GENERATED') {
      rows.push(buildLazyConfirmRow(order));
    }
    rows.push([
      Markup.button.callback(
        order.cardStage === 'QR_GENERATED' ? '↻ Regenerate Swiggy QR' : '□ Generate QR',
        `fwd_gen_qr_${order.id}`
      ),
      Markup.button.callback('✓ Paid', `fwd_check_paid_${order.id}`)
    ]);
    if (readyForQrCount >= 2 && order.cardStage === 'BILL_READY') {
      rows.push([
        Markup.button.callback(
          `! Generate All ${readyForQrCount} Ready QRs in Parallel`,
          `fwd_parallel_qrs_${order.id}`
        )
      ]);
    }
    if (activeQrCount >= 2) {
      rows.push([
        Markup.button.callback(
          `✓ Verify All ${activeQrCount} Active Payments Now`,
          `fwd_check_all_paid`
        )
      ]);
    }
    rows.push([
      Markup.button.callback('▣ Re-Scan Max Offer', `fwd_rescan_max_${order.id}`),
      Markup.button.callback('🔄 Change Auto Selection', `fwd_change_auto_sel_${order.id}`)
    ]);
    if (order.fwdSenderUserId && !order.isDirectBossOrder && !order.billApprovedByUser && !['APPROVAL_PENDING', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
      rows.push([Markup.button.callback('↑ Send Bill Summary ›', `fwd_send_summary_${order.id}`)]);
    }
    if (!order.pendingSwiggyOrderId && !order.pendingSwiggyUpiUri && !order.realUpiIntentUri && order.cardStage !== 'QR_GENERATED') {
      rows.push([
        Markup.button.callback('✎ Change Cart', `fwd_input_cart_${order.id}`),
        Markup.button.callback('⌖ Change Address', `fwd_input_address_${order.id}`)
      ]);
      rows.push([Markup.button.callback('☎ Change Recipient Mobile', `fwd_input_mobile_${order.id}`)]);
    }
    rows.push([cancelBtn]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // Stage 2-: auto-selection exhausted. Boss gets ONE retry button that walks
  // the fallback ladder across every logged-in ID — never a manual picker.
  if (hasAddress && hasDeliveryContact && hasCart && order.cardStage === 'NEED_ACCOUNT') {
    const errText = escapeHtml(order.accountSyncError || order.lastAccountError || 'Swiggy ID se live bill nahi bana.');
    const vaultCount = planAccountFallbacks(db?.config?.accounts || {}).length;
    const text =
      `⚠️ <b>BEST SWIGGY ID NAHI MILA (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `⌖ <b>Address:</b> ${summarizeAddressPreview(order)}\n` +
      `▤ <b>Cart:</b> ${summarizeCartPreview(order)}\n\n` +
      `<b>Reason:</b> <i>${errText}</i>\n` +
      (vaultCount > 0
        ? `<i>Vault me ${vaultCount} logged-in ID available hain — ek tap me sab par try hoga.</i>\n`
        : `<i>Vault me koi logged-in ID nahi hai. Session JSON drop karein.</i>\n`) +
      `\n<i>Cart/address safe hain — dobara forward karne ki zarurat nahi.</i>`;
    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Best ID dobara try karo', lazyActionId('best_id', order.id))],
        [Markup.button.callback('▣ Re-Scan Max Offer', `fwd_rescan_max_${order.id}`)],
        [cancelBtn]
      ])
    };
  }

  // Stage 2A & 2B: Automatic Account Selection by default (No manual picker needed!)
  if (hasAddress && hasDeliveryContact && hasCart) {
    order.cardStage = (order.accountSyncError || order.lastAccountError) ? 'NEED_ACCOUNT' : 'AUTO_SELECTING';
    const errNotice = (order.accountSyncError || order.lastAccountError)
      ? `\n\n⚠️ <b>Dikkat:</b> <i>${escapeHtml(order.accountSyncError || order.lastAccountError)}</i>\n<i>Please resolve the account issue or tap below to retry auto-selection.</i>`
      : '';
    const text =
      `! <b>AUTO-SELECTING BEST 0-ORDER SWIGGY ID (#${escapeHtml(order.id)})...</b>\n` +
      `${senderLine}\n\n` +
      `⌖ <b>Address:</b> ${summarizeAddressPreview(order)}\n` +
      `▤ <b>Cart:</b> ${summarizeCartPreview(order)}\n\n` +
      `<i>› Finding free 0-Order Swiggy ID + applying Maximum Coupon, Item Offers, Free Cash &amp; Free Delivery in parallel...</i>${errNotice}`;
    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback(order.accountSyncError || order.lastAccountError ? '🔄 Retry Auto Selection' : '🔄 Change Auto Selection', `fwd_change_auto_sel_${order.id}`)],
        [cancelBtn]
      ])
    };
  }

  // Stage 1: Partial Card (Waiting for missing Cart or missing Address)
  order.cardStage = 'COLLECTING';
  const hasAddressText = Boolean(order.addressDetails?.address || order.address);
  const addrStatus = hasAddress
    ? `✓ ${summarizeAddressPreview(order)}`
    : hasAddressText
      ? `! <i>Address text received, but its Indian map location is not verified. Send a precise GPS pin or full street address with area, city and PIN.</i>`
      : `◷ <i>Waiting — send Address link / text / GPS pin</i>`;
  const contactStatus = hasDeliveryContact
    ? `✓ <code>${escapeHtml(normalizeRecipientMobile(order.addressDetails.mobile))}</code>`
    : `! <i>Recipient mobile missing — enter the correct 10-digit number in the address box; account/old numbers are never substituted.</i>`;
  const cartStatus = hasCart
    ? `✓ ${summarizeCartPreview(order)}\n↗ <code>${escapeHtml(String(order.cart).slice(0, 95))}</code>`
    : `◷ <i>Waiting — send Swiggy Cart / Group Order link</i>`;

  const missingItem = !hasAddress
    ? 'verified delivery address / exact GPS pin'
    : (!hasDeliveryContact ? 'recipient’s correct 10-digit mobile' : 'Cart link');
  const actionHint = !hasDeliveryContact && hasAddress && hasCart
    ? `i Use <b>Add Recipient Mobile</b> below and enter the correct 10-digit Indian number.`
    : (order.isDirectBossOrder
        ? `i Use the buttons below or send ${missingItem} in this chat.`
        : `i Forward ${escapeHtml(order.fwdSenderName)}'s ${missingItem}, or enter it with the buttons below.`);

  const errLine = (order.accountSyncError || order.lastAccountError)
    ? `\n⚠️ <b>Notice:</b> <i>${escapeHtml(order.accountSyncError || order.lastAccountError)}</i>\n`
    : '';

  const text =
    `✉ <b>NEW ORDER CARD (#${escapeHtml(order.id)})</b>\n` +
    `${senderLine}\n\n` +
    `⌖ <b>Address:</b>\n${addrStatus}\n` +
    `☎ <b>Recipient mobile:</b> ${contactStatus}\n\n` +
    `▤ <b>Cart:</b>\n${cartStatus}\n\n` +
    errLine +
    `<i>${actionHint}</i>\n` +
    `<i>◈ No account allocated; QR is blocked.</i>`;

  const inputButtons = [];
  if (!hasCart) inputButtons.push(Markup.button.callback('▤ Enter Cart Link', `fwd_input_cart_${order.id}`));
  if (!hasAddress) inputButtons.push(Markup.button.callback('⌖ Add / Correct Address', `fwd_input_address_${order.id}`));
  else if (!hasDeliveryContact) inputButtons.push(Markup.button.callback('☎ Add Recipient Mobile', `fwd_input_mobile_${order.id}`));

  const rows = [];
  if (inputButtons.length) rows.push(inputButtons);
  rows.push([cancelBtn]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export async function postOrReplaceForwardedCard(telegram, chatId, order, db, formatOrderBodyFn, { includeQrDelete = false } = {}) {
  await deleteOrderBotMessages(telegram, chatId, order, { includeQr: includeQrDelete });
  const { text, keyboard } = buildForwardedOrderCardView(order, db, formatOrderBodyFn);
  const sent = await telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard
  });
  order.activeCardMessageId = sent.message_id;
  order.trackedCardMessageIds = [sent.message_id];
  order.bossChatId = chatId;
  order.updatedAt = new Date().toISOString();
  upsertOrder(order.id, order);
  return sent;
}

export async function ingestForwardedContentIntoOrder(order, { rawText = '', location = null } = {}) {
  let updatedCart = false;
  let updatedAddress = false;

  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    if (!isValidIndianDeliveryCoordinates(location.latitude, location.longitude)) {
      return { updatedCart, updatedAddress: false, error: 'Swiggy delivery is India-only. Send a valid Indian delivery pin.' };
    }
    const geo = await reverseGeocodeCoords(location.latitude, location.longitude);
    const formatted = geo?.formattedAddress || `GPS Pin (${location.latitude}, ${location.longitude})`;
    order.address = formatted;
    order.addressOriginalText = formatted;
    order.addressDetails = {
      name: order.fwdSenderName || order.userName || '',
      // A newly supplied pin may be for a different recipient; never carry the old delivery phone over silently.
      mobile: '',
      address: formatted,
      area: geo?.area || '',
      city: geo?.city || '',
      lat: String(location.latitude),
      lng: String(location.longitude)
    };
    updatedAddress = true;
    return { updatedCart, updatedAddress };
  }

  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { updatedCart, updatedAddress };

  const contactMatch = trimmed.match(/^(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?([6-9]\d{4}[\s-]?\d{5})$/);
  if (contactMatch && order.addressDetails?.address) {
    const mobile = contactMatch[1].replace(/\D/g, '');
    order.addressDetails = { ...order.addressDetails, mobile };
    return { updatedCart, updatedAddress: true };
  }

  const allUrls = extractSharedUrls(trimmed);
  const swiggyUrls = allUrls.filter(u => /(swiggy\.com|swig\.gy|onelink\.me)/i.test(u) && !isOfficialSwiggyTrackingUrl(u) && !/r\.swiggy\.com.*\/track\//i.test(u));
  const mapsUrls = allUrls.filter(u => /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u));

  // URL-FIRST: if the message carries an address share link, delivery data comes
  // from that link only. Text sitting next to the link (order account, receipt,
  // forwarded header, "Address: ..." line) is never used.
  const addressShareUrl = extractAddressShareUrl(trimmed);

  // Pre-extract plain-text street address BEFORE `Promise.all` so links + geocoding run 100% concurrently!
  // (Only for genuinely text-only messages — never when an address link is present.)
  const textWithoutUrlsEarly = stripSharedLinks(trimmed);
  const earlyPlainAd = addressShareUrl
    ? null
    : (allUrls.length === 0 && !isValidCartInput(trimmed) && isValidAddressInput(trimmed)
        ? parseAddressDetails(trimmed)
        : textWithoutUrlsEarly.length >= 12 && isValidAddressInput(textWithoutUrlsEarly)
          ? parseAddressDetails(textWithoutUrlsEarly)
          : null);
  const firstAccEarly = earlyPlainAd && (!earlyPlainAd.lat || !earlyPlainAd.lng)
    ? Object.values(getDb()?.config?.accounts || {}).find(a => a?.isLoggedIn && (a.cookies || a.tid || a.token)) || null
    : null;

  // Resolve ALL links + plain-text street address geocoding IN ONE SINGLE PARALLEL BATCH!
  // If `earlyPlainAd?.address` is already extracted from plain text (e.g. `Save my address on Swiggy... Address: ...`),
  // skip external HTTP hop on `onelink.me/JgkQ` (`0ms` instead of `1.9s`!) and reuse `preGeocodedPlainAd` directly!
  const [resolvedSwiggyList, resolvedMapsList, preGeocodedPlainAd] = await Promise.all([
    Promise.all(
      swiggyUrls.map(url => resolveSwiggyLink(url).then(resolved => ({ url, resolved })))
    ),
    Promise.all(mapsUrls.map(mUrl => resolveSwiggyLink(mUrl).then(resolved => ({ mUrl, resolved })))),
    earlyPlainAd && (!earlyPlainAd.lat || !earlyPlainAd.lng)
      ? geocodeAddressDetails(earlyPlainAd).catch(() => earlyPlainAd)
      : Promise.resolve(earlyPlainAd)
  ]);

  for (const { url, resolved } of resolvedSwiggyList) {
    const looksLikeAddressShare =
      resolved?.linkType === 'ADDRESS' ||
      Boolean(resolved?.addressDetails) ||
      (/save my address on swiggy/i.test(trimmed) && !/\/gc\//i.test(url)) ||
      (/(?:swiggy\.onelink\.me|onelink\.me\/jgkq)/i.test(url) && !/\/gc\//i.test(url)) ||
      (/(?:swiggy\.com|swig\.gy).*(?:address|shareaddress)/i.test(url));

    if (looksLikeAddressShare) {
      // The address link is authoritative. `preGeocodedPlainAd` is always null here
      // when a link is present, and text parsing is never used as a substitute.
      const ad = resolved?.addressDetails || null;
      if (ad && !ad.unresolvableShortLink) {
        delete ad.id;
        // Never overwrite recipient name with sender's Telegram name — link's contact_name is authoritative (recipient = Ammi/Abbu)
        order.addressDetails = ad;
        order.address = ad.address || ad.city || url;
        order.addressLink = url;
      } else {
        // Keep the link (never the surrounding chat text) and let the card ask for
        // a fresh address/pin if the share link could not be resolved.
        order.addressDetails = ad || null;
        order.address = url;
        order.addressLink = url;
      }

      // If mobile is not inside the onelink, extract recipient mobile from the message text
      if (order.addressDetails && !order.addressDetails.mobile) {
        const phoneMatch = trimmed.match(/(?:(?:phone|mobile|contact|tel|call)[\s:.-]*)?(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?([6-9]\d{4}[\s-]?\d{5})\b/i);
        if (phoneMatch) {
          order.addressDetails.mobile = phoneMatch[1].replace(/\D/g, '');
        }
      }

      order.addressOriginalText = order.address;
      updatedAddress = true;
    } else if (isValidCartInput(url)) {
      if (resolved?.expired || resolved?.groupCartStatus === 'EXPIRED' || resolved?.status === 'EXPIRED') {
        const err = new Error(`Group Cart link expired or closed on Swiggy: ${url}`);
        err.diag = { code: 'GROUP_CART_EXPIRED', stage: 'RESOLVE_CART_LINK', swiggyMessage: resolved?.groupCartStatus || 'EXPIRED' };
        throw err;
      }
      if (resolved?.groupCartStatus === 'PLACED') {
        const err = new Error(`Group Cart order was already placed on Swiggy: ${url}`);
        err.diag = { code: 'GROUP_CART_ALREADY_PLACED', stage: 'RESOLVE_CART_LINK', swiggyMessage: 'PLACED' };
        throw err;
      }
      order.cart = url;
      // Lazy Boss mode: remember whether Swiggy actually answered for this link.
      // An unresolved link must never masquerade as a live cart on the bill card.
      const cartResolved = Boolean(resolved && (
        resolved.groupCartId || resolved.restaurantId || resolved.restaurantName || resolved.cartDetails
      ));
      order.cartUnverified = !cartResolved;
      if (resolved?.groupCartId) order.groupCartId = resolved.groupCartId;
      if (resolved?.hostName) order.hostName = resolved.hostName;
      if (resolved?.restaurantId) order.restaurantId = resolved.restaurantId;
      if (resolved?.restaurantName) order.restaurantName = resolved.restaurantName;
      if (resolved?.cartDetails?.items?.length) {
        order.items = resolved.cartDetails.items;
        order.subtotal = resolved.cartDetails.subtotal || 0;
        order.tradeDiscountTotal = resolved.cartDetails.tradeDiscountTotal || 0;
      }
      updatedCart = true;
    }
  }

  for (const { mUrl, resolved } of resolvedMapsList) {
    // GPS pin / Maps link is authoritative too: reverse-geocoded location only, never sender's name
    const ad = resolved?.addressDetails || null;
    if (ad) {
      delete ad.id;
      order.addressDetails = ad;
      order.address = ad.address || mUrl;
      order.addressLink = mUrl;
    } else {
      order.address = mUrl;
    }
    order.addressOriginalText = order.address;
    updatedAddress = true;
  }

  if (!updatedCart && !updatedAddress) {
    if (isValidCartInput(trimmed)) {
      // Only store the actual cart URL, not the whole message text — prevents address text leaking into cart
      const urlsForCart = extractSharedUrls(trimmed).filter(u => isValidCartInput(u));
      order.cart = urlsForCart[0] || primaryCartFallback(trimmed);
      // Text/receipt fallback — Swiggy never confirmed this cart, so the intake
      // handler shows the rescue card (with one-tap retry) instead of pretending.
      order.cartUnverified = true;
      updatedCart = true;
    } else if (!addressShareUrl && isValidAddressInput(trimmed)) {
      // Plain-text address (no address link in the message) — the text IS the source.
      const ad = preGeocodedPlainAd || parseAddressDetails(trimmed);
      order.address = trimmed;
      order.addressOriginalText = trimmed;
      if (ad) {
        delete ad.id;
        order.addressDetails = ad;
      }
      updatedAddress = true;
    }
  } else if (updatedCart && !updatedAddress && !addressShareUrl) {
    const textWithoutUrls = trimmed.replace(/https?:\/\/[^\s]+/gi, ' ').trim();
    if (textWithoutUrls.length >= 12 && isValidAddressInput(textWithoutUrls)) {
      const ad = preGeocodedPlainAd || parseAddressDetails(textWithoutUrls);
      if (ad && (ad.address || ad.lat || /\d{6}/.test(textWithoutUrls))) {
        delete ad.id;
        order.address = textWithoutUrls;
        order.addressOriginalText = textWithoutUrls;
        order.addressDetails = ad;
        updatedAddress = true;
      }
    }
  }

  // Eagerly pre-geocode plain-text street addresses during message intake (~200ms via Swiggy autocomplete)
  // so `order.addressDetails.lat`/`lng` are ALREADY ready in 0ms when any account / Multi-ID Best Offer syncs!
  if (updatedAddress && order.addressDetails && (!order.addressDetails.lat || !order.addressDetails.lng)) {
    try {
      const db = getDb();
      const firstAcc = Object.values(db?.config?.accounts || {}).find(a => a?.isLoggedIn && (a.cookies || a.tid || a.token)) || null;
      order.addressDetails = await geocodeAddressDetails(order.addressDetails, firstAcc);
    } catch (e) {}
  }

  return { updatedCart, updatedAddress };
}

export async function finalizePaidOrderCard({
  telegram,
  chatId,
  order,
  livePaidResult,
  formatOrderBodyFn
}) {
  stopOrderPaymentPoller(order.id);
  if (order.selectedAccount) {
    releaseSwiggyAccountReservation(order.selectedAccount, order.id);
    // Invalidate cached `0-Order` badge so once a `0-Order` ID completes its 1st order, next order grabs another fresh `0-Order` ID!
    invalidateAccountOrderProfileCache(order.selectedAccount);
    const curDb = getDb();
    const persistedOrder = curDb?.orders?.[order.id];
    const usedAccObj = curDb?.config?.accounts?.[order.selectedAccount];
    const alreadyCounted = Boolean(order.accountOrderCountIncremented || persistedOrder?.accountOrderCountIncremented);
    const alreadyCompleted = (order.status === 'COMPLETED' && order.cardStage === 'PAID_CONFIRMED') ||
      (persistedOrder?.status === 'COMPLETED' && persistedOrder?.cardStage === 'PAID_CONFIRMED');
    if (usedAccObj && !alreadyCounted && !alreadyCompleted) {
      const knownCounts = [usedAccObj.totalOrdersCount, usedAccObj.cachedTotalOrdersCount, order.selectedAccountTotalOrders]
        .filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
        .map(value => Math.max(0, Number(value)));
      const nextOrderCount = (knownCounts.length ? Math.max(...knownCounts) : 0) + 1;
      usedAccObj.isZeroOrderAccount = false;
      usedAccObj.totalOrdersCount = nextOrderCount;
      usedAccObj.cachedTotalOrdersCount = nextOrderCount;
      order.accountOrderCountIncremented = true;
      if (persistedOrder) persistedOrder.accountOrderCountIncremented = true;
      saveDb(curDb);
    } else if (usedAccObj && alreadyCompleted && !alreadyCounted) {
      // Legacy completed cards predate the idempotency marker; don't increment them again.
      order.accountOrderCountIncremented = true;
      if (persistedOrder) persistedOrder.accountOrderCountIncremented = true;
      saveDb(curDb);
    } else if (alreadyCounted) {
      order.accountOrderCountIncremented = true;
    }
  }

  order.status = 'COMPLETED';
  order.cardStage = 'PAID_CONFIRMED';
  order.swiggyOrderId = String(livePaidResult.swiggyOrderId || order.pendingSwiggyOrderId || '');
  order.liveOrderStatus = livePaidResult.orderStatus || 'Order Confirmed';
  order.etaMinutes = livePaidResult.etaMinutes || order.etaMinutes || '';
  order.deliveryBoyName = livePaidResult.deliveryBoy?.name || order.deliveryBoyName || '';
  order.deliveryBoyMobile = livePaidResult.deliveryBoy?.mobile || order.deliveryBoyMobile || '';
  order.deliveryOtp = livePaidResult.deliveryOtp || order.deliveryOtp || '';
  if (livePaidResult.restaurantName) order.restaurantName = livePaidResult.restaurantName;

  const providerTrackingCandidate = livePaidResult.nativeShareUrl || livePaidResult.swiggyWebTrackUrl || '';
  const providerTrackingUrl = providerTrackingCandidate
    ? getStoredSwiggyTrackingUrl({ trackingLink: providerTrackingCandidate, trackingLinkSource: 'SWIGGY_API' })
    : '';
  const existingTrustedTrackingUrl = getStoredSwiggyTrackingUrl(order);
  order.shareTrackUrl = '';
  order.trackingLink = providerTrackingUrl || existingTrustedTrackingUrl;
  order.trackingLinkSource = providerTrackingUrl ? 'SWIGGY_API' : (existingTrustedTrackingUrl ? order.trackingLinkSource : '');
  order.paidAt = new Date().toISOString();

  // NEW: Try to edit the existing payment QR message in-place to inject tracking link/OTP (user request: payment message auto-edit)
  // If edit succeeds, keep the edited QR visible (do not delete it) and only clear card messages.
  let qrPaymentEdited = false;
  try {
    qrPaymentEdited = await tryEditForwardedPaymentMessageWithTracking(telegram, chatId, order);
  } catch {}

  if (qrPaymentEdited) {
    await deleteOrderBotMessages(telegram, chatId, order, { includeQr: false });
  } else {
    await deleteOrderBotMessages(telegram, chatId, order, { includeQr: true });
  }
  upsertOrder(order.id, order);
  const freshDb = getDb();
  const { text, keyboard } = buildForwardedOrderCardView(order, freshDb, formatOrderBodyFn);
  const sent = await telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard
  });
  order.activeCardMessageId = sent.message_id;
  order.trackedCardMessageIds = [sent.message_id];
  upsertOrder(order.id, order);
  await sendOrderDeliveryInfoNotice(telegram, chatId, order, { force: true });
  startOrderDeliveryInfoPoller({ telegram, chatId, orderId: order.id, formatOrderBodyFn });
  // Order confirmed → the bot fetches the genuine Swiggy share link itself and
  // pushes it to the Boss dashboard + customer as soon as Swiggy publishes it.
  try { startOrderTrackingAuto(order.id, { budgetMs: 15000 }); } catch {}
  return sent;
}

export async function sendOrderDeliveryInfoNotice(telegram, chatId, order, { force = false } = {}) {
  const recipientId = String(order?.fwdSenderUserId || order?.userId || '').trim();
  if (!recipientId || recipientId === String(chatId || '') || typeof telegram?.sendMessage !== 'function') return false;

  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  const deliveryOtp = String(order?.deliveryOtp || '').trim();
  const noticeKey = `${trackingUrl}\n${deliveryOtp}`;
  const notices = order.deliveryInfoNotices && typeof order.deliveryInfoNotices === 'object'
    ? order.deliveryInfoNotices
    : {};
  if (!force && notices[recipientId] === noticeKey) return false;

  // User-requested format: "Fer aex has just placed an order (ID: 251144921143559) for you on Swiggy. Click this link to track: http://r.swiggy.com/..."
  const bossName = String(order.bossName || order.placedByName || order.confirmedByName || 'Fer aex').trim() || 'Fer aex';
  const displayOrderId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  const trackDisplay = trackingUrl ? escapeHtml(trackingUrl) : '';
  const trackLinkHtml = trackingUrl ? `<a href="${escapeHtml(trackingUrl)}">${trackDisplay}</a>` : '';
  const lines = [];
  if (order.status === 'COMPLETED' && trackingUrl) {
    lines.push(`${escapeHtml(bossName)} has just placed an order (ID: ${escapeHtml(displayOrderId)}) for you on Swiggy. Click this link to track: ${trackLinkHtml}`);
    lines.push(`✓ <b>Payment received — Swiggy order confirmed</b>`);
  } else if (trackingUrl) {
    lines.push(`${escapeHtml(bossName)} has just placed an order (ID: ${escapeHtml(displayOrderId)}) for you on Swiggy. Click this link to track: ${trackLinkHtml}`);
    lines.push(`✓ <b>Payment received — Swiggy order confirmed</b>`);
    if (order.liveOrderStatus) lines.push(`Status: ${escapeHtml(String(order.liveOrderStatus))}`);
  } else {
    lines.push(`✓ <b>Swiggy order update</b>`);
    lines.push(`Order reference: <code>#${escapeHtml(String(order.id))}</code>`);
    if (order.swiggyOrderId) lines.push(`Swiggy order no.: <code>${escapeHtml(String(order.swiggyOrderId))}</code>`);
    if (order.liveOrderStatus) lines.push(`Status: ${escapeHtml(String(order.liveOrderStatus))}`);
    lines.push('Payment verified successfully. Swiggy tracking is not available yet. I\'ll retry shortly.');
    console.log(`[Tracking] No reliable tracking source for order ${order.id} (swiggyOrderId=${order.swiggyOrderId || 'unknown'}). Will retry via poller.`);
  }
  if (deliveryOtp) {
    lines.push(`⌕ <b>Delivery OTP:</b> <code>${escapeHtml(deliveryOtp)}</code>`);
  } else if (!trackingUrl) {
    lines.push('Delivery OTP is not available yet. If Swiggy provides one, I will send it here.');
  }

  const options = {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(trackingUrl ? Markup.inlineKeyboard([[Markup.button.url('↗ Open Swiggy tracking', trackingUrl)]]) : {})
  };
  // Telegram DM disabled per user request — only SMS
  try {
    order.deliveryInfoNotices = { ...notices, [recipientId]: noticeKey };
    const db = getDb();
    db.orders[order.id] = order;
    saveDb(db);
    if (trackingUrl || order.swiggyOrderId || order.id) {
      sendParentSmsNotification(order, trackingUrl).catch(() => {});
      sendDirectOrderSms(order).catch(()=>{});
    }
    return true;
  } catch {
    // SMS fallback
    if (trackingUrl || order.swiggyOrderId) {
      sendParentSmsNotification(order, trackingUrl).catch(() => {});
    }
    return false;
  }
}

export function startOrderDeliveryInfoPoller({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  customTrackingFetcher = null,
  intervalMs = 60_000,
  maxDurationMs = 6 * 60 * 60 * 1000
}) {
  const key = String(orderId);
  if (activeDeliveryInfoPollers.has(key)) return activeDeliveryInfoPollers.get(key);

  const state = { timer: null, startedAt: Date.now(), attempts: 0, checking: false, stopped: false };
  activeDeliveryInfoPollers.set(key, state);
  const stop = () => stopOrderDeliveryInfoPoller(key);
  const schedule = () => {
    if (state.stopped) return;
    const delay = Math.min(5 * 60_000, Math.round(intervalMs * Math.pow(1.5, Math.min(state.attempts, 6))));
    state.timer = setTimeout(poll, delay);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  };
  const poll = async () => {
    if (state.stopped || state.checking) return;
    if (Date.now() - state.startedAt >= maxDurationMs) return stop();
    state.checking = true;
    try {
      const db = getDb();
      const order = db.orders?.[key];
      if (!order || !['COMPLETED', 'ACCEPTED'].includes(order.status) || ['CANCELLED', 'REJECTED'].includes(order.status)) return stop();
      const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
      if (!acc || (!acc.cookies && !acc.tid && !acc.token) || !order.swiggyOrderId) return;

      let update = null;
      if (typeof customTrackingFetcher === 'function') {
        update = await customTrackingFetcher(acc, order);
      } else {
        const customerId = String(order.swiggyCustomerId || '');
        const [trackRes, deRes] = await Promise.all([
          dapiFetch(acc, `order/trackV4?order_id=${encodeURIComponent(order.swiggyOrderId)}&type=full&version=V2${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`).catch(() => null),
          dapiFetch(acc, `order/trackV2/de?order_id=${encodeURIComponent(order.swiggyOrderId)}`).catch(() => null)
        ]);
        const trackData = trackRes?.json?.data || {};
        const deData = deRes?.json?.data || {};
        update = {
          trackingUrl: extractSwiggyProvidedTrackingUrl(trackData, deData),
          deliveryOtp: extractSwiggyDeliveryOtp(trackData, { delivery: deData }),
          status: trackData?.order_status_details?.status_message || trackData?.order_status || '',
          etaMinutes: trackData?.sla_time || '',
          deliveryBoy: {
            name: deData?.name || '',
            mobile: deData?.mobile || ''
          }
        };
      }

      const candidateUrl = update?.trackingUrl || update?.swiggyWebTrackUrl || update?.nativeShareUrl || '';
      const verifiedUrl = candidateUrl
        ? getStoredSwiggyTrackingUrl({ trackingLink: candidateUrl, trackingLinkSource: 'SWIGGY_API' })
        : '';
      const previousUrl = getStoredSwiggyTrackingUrl(order);
      const otpDigits = String(update?.deliveryOtp || '').replace(/\D/g, '');
      const nextOtp = /^\d{4,8}$/.test(otpDigits) ? otpDigits : '';
      const previousOtp = String(order.deliveryOtp || '');
      const previousStatus = String(order.liveOrderStatus || '');
      const changed = Boolean((verifiedUrl && verifiedUrl !== previousUrl) || (nextOtp && nextOtp !== previousOtp));

      if (verifiedUrl) {
        order.trackingLink = verifiedUrl;
        order.trackingLinkSource = 'SWIGGY_API';
        order.shareTrackUrl = '';
      }
      if (nextOtp) order.deliveryOtp = nextOtp;
      if (update?.status) order.liveOrderStatus = String(update.status);
      if (update?.etaMinutes) order.etaMinutes = String(update.etaMinutes);
      if (update?.deliveryBoy?.name) order.deliveryBoyName = String(update.deliveryBoy.name);
      if (update?.deliveryBoy?.mobile) order.deliveryBoyMobile = String(update.deliveryBoy.mobile);
      const statusChanged = previousStatus !== String(order.liveOrderStatus || '');
      upsertOrder(order.id, order);

      if (changed || statusChanged) {
        if (formatOrderBodyFn && telegram?.sendMessage) {
          await postOrReplaceForwardedCard(telegram, chatId, order, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
        }
        // Also re-edit the payment QR message in-place when tracking/OTP finally appears (delay auto-edit)
        if (changed && order.activeQrMessageId) {
          try { await tryEditForwardedPaymentMessageWithTracking(telegram, chatId, order); } catch {}
        }
        if (changed) await sendOrderDeliveryInfoNotice(telegram, chatId, order);
      }
      if (/delivered|cancelled|canceled|rejected/i.test(String(order.liveOrderStatus || ''))) return stop();
    } catch {
      // Swiggy tracking can be temporarily unavailable; retry with bounded backoff.
    } finally {
      state.checking = false;
      state.attempts++;
      if (!state.stopped) schedule();
    }
  };

  schedule();
  return state;
}

export function startOrderPaymentPoller({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  customPaymentChecker = null,
  intervalMs = 5000,
  maxDurationMs = 12 * 60 * 1000
}) {
  stopOrderPaymentPoller(orderId);
  const startedAt = Date.now();
  let checking = false;

  const timer = setInterval(async () => {
    if (checking) return;
    if (Date.now() - startedAt > maxDurationMs) {
      stopOrderPaymentPoller(orderId);
      return;
    }
    checking = true;
    try {
      const db = getDb();
      const order = db.orders?.[orderId];
      if (!order || ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
        stopOrderPaymentPoller(orderId);
        return;
      }
      const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
      if (!acc) return;

      const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
      const res = await checker(acc, order);
      if (res?.paid && res?.swiggyOrderId) {
        await finalizePaidOrderCard({
          telegram,
          chatId: order.bossChatId || chatId,
          order,
          livePaidResult: res,
          formatOrderBodyFn
        });
      }
    } catch (e) {
      // Transient background poll network blips stay quiet unless manually clicked
    } finally {
      checking = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  activePaymentPollers.set(orderId, timer);
}

// Shared helper to sync a single order onto a chosen Swiggy ID safely in parallel
export async function executeOrderBillSyncOnAccount({
  telegram,
  chatId,
  orderId,
  accKey,
  formatOrderBodyFn,
  excludeAccountKeys = []
}) {
  const db = getDb();
  let order = lookupOrder(db, orderId);
  if (!order) {
    console.warn('[OrderLookup] miss throw', orderNotFoundDiag(db, orderId));
    throw new Error(`Order #${orderId} not found. ` + orderNotFoundDiag(db, orderId));
  }

  let syncRes = null;
  if (accKey === 'BEST') {
    syncRes = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false, excludeAccountKeys });
    if (!syncRes?.success) {
      const err = new Error(syncRes?.error || 'Could not sync cart across logged-in accounts.');
      err.diag = { code: 'BEST_ACCOUNT_SYNC_FAILED', stage: 'PICK_BEST_ACCOUNT', comparison: syncRes?.accountComparison };
      throw err;
    }
  } else {
    const acc = db.config?.accounts?.[accKey];
    if (!acc || !acc.isLoggedIn || (!acc.cookies && !acc.tid && !acc.jwtTid && !acc.token)) {
      const err = new Error(`Selected Swiggy account (${accKey}) is not logged in.`);
      err.diag = { code: 'ACCOUNT_NOT_LOGGED_IN', stage: 'PICK_SPECIFIC_ACCOUNT' };
      throw err;
    }
    // Execute inside per-account lock so DIFFERENT accounts run 100% simultaneously in parallel!
    syncRes = await withSwiggyAccountLock(accKey, async () => {
      // Clear any foreign `addressDetails.id` from a previous account before syncing on `accKey`!
      if (order.addressDetails?.id && order.selectedAccount && order.selectedAccount !== accKey) {
        delete order.addressDetails.id;
      }
      const r = await syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false });
      return r;
    });
    if (!syncRes?.success) {
      const err = new Error(syncRes?.error || 'Failed to sync cart & address on selected Swiggy account.');
      err.diag = { code: syncRes?.code || 'ACCOUNT_CART_SYNC_FAILED', stage: 'PICK_SPECIFIC_ACCOUNT' };
      throw err;
    }
    order.selectedAccount = accKey;
    order.orderAccount = acc.phone || accKey;
  }

  order.status = 'ACCEPTED';
  order.cardStage = 'BILL_READY';
  order.pendingSwiggyUpiUri = '';
  order.pendingSwiggyOrderId = '';
  order.pendingSwiggyPaasId = '';
  order.pendingQrAddressId = '';
  order.pendingQrAddressText = '';
  order.pendingQrDeliveryMobile = '';
  order.pendingQrLat = '';
  order.pendingQrLng = '';
  order.pendingQrAddressAccount = '';

  const usedAcc = getDb().config?.accounts?.[order.selectedAccount];
  if (usedAcc) {
    const authSnap = await getSwiggySessionAuth(usedAcc).catch(() => null);
    const latestExisting = authSnap?.orders?.[0]?.order_id;
    order.baselineSwiggyOrderId = latestExisting ? String(latestExisting) : '';
  }

  let freshDb = getDb();
  freshDb.orders[order.id] = order;
  saveDb(freshDb);

  // Bill summary routing: a Boss-forwarded / Boss-entered order keeps the summary
  // INSIDE the bot (the Boss card below is that summary) and never messages the
  // customer. Only a customer's own "Send to Beta" order goes to the customer.
  const audience = resolveBillSummaryAudience(order, freshDb);
  if (audience === 'BOSS_ONLY') {
    order.billSummaryAudience = 'BOSS_ONLY';
    order.billSummaryDelivery = 'BOSS_CARD';
    order.billSummarySentAt = order.billSummarySentAt || new Date().toISOString();
    order.billSummarySentTo = {
      ...(order.billSummarySentTo && typeof order.billSummarySentTo === 'object' ? order.billSummarySentTo : {}),
      [String(chatId)]: new Date().toISOString()
    };
    freshDb = getDb();
    freshDb.orders[order.id] = order;
    saveDb(freshDb);
  } else {
    try {
      const summarySend = await sendBillSummaryToCustomerOnce(telegram, order, { db: freshDb });
      if (summarySend?.sent) {
        console.log(`[BillSummary] Sent to customer ${summarySend.customerId} for Order #${order.id}`);
      }
    } catch (summaryErr) {
      console.warn('[BillSummary] Auto-send skipped:', summaryErr?.message || summaryErr);
    }
  }

  freshDb = getDb();
  await postOrReplaceForwardedCard(telegram, chatId, order, freshDb, formatOrderBodyFn, { includeQrDelete: true });
  return order;
}

/**
 * Lazy Boss mode — never leave an order stuck on "no account".
 *
 * 1. Try the automatic multi-probe pick (`BEST`) twice (transient WAF/network
 *    failures are retried; expired-cart style errors fail fast).
 * 2. If that still fails, walk a deterministic fallback ladder across every
 *    logged-in Swiggy ID (0-order → 0-active → rest) and stop at the first
 *    one that can build a live bill.
 * 3. Only when the whole vault is unusable does the order go back to Boss.
 */
export async function autoAssignBestAccountWithFallback({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  excludeAccountKeys = []
}) {
  const startDb = getDb();
  const order = lookupOrder(startDb, orderId);
  if (!order) throw new Error(`Order #${orderId} not found. ` + orderNotFoundDiag(startDb, orderId));

  const excluded = [...new Set((excludeAccountKeys || []).filter(Boolean).map(String))];
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId,
        accKey: 'BEST',
        formatOrderBodyFn,
        excludeAccountKeys: excluded
      });
    } catch (err) {
      lastError = err;
      if (attempt === 2 || !isRetryableFetchError(err)) break;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  const ladder = planAccountFallbacks(getDb()?.config?.accounts, order, { exclude: excluded });
  const tried = [];
  for (const candidate of ladder.slice(0, 3)) {
    try {
      const result = await executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId,
        accKey: candidate.key,
        formatOrderBodyFn
      });
      const doneDb = getDb();
      const doneOrder = doneDb.orders?.[orderId];
      if (doneOrder) {
        doneOrder.accountFallbackReason = candidate.reason;
        doneOrder.accountFallbackTier = candidate.tier;
        doneOrder.accountSyncError = '';
        doneOrder.lastAccountError = '';
        upsertOrder(orderId, doneOrder);
      }
      return result;
    } catch (err) {
      lastError = err;
      tried.push(candidate.phone || candidate.key);
    }
  }

  if (lastError && tried.length) {
    lastError.message = `${lastError.message} (aage try kiye: ${tried.join(', ')})`;
  }
  throw lastError || new Error('No usable Swiggy ID could build a live bill.');
}

// Shared helper to generate REAL Swiggy Dynamic QR for a single order (safe for `Promise.all` across 10+ distinct IDs!)
export async function executeRealQrGenerationForOrder({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  customRealQrGenerator = null
}) {
  const db = getDb();
  let order = lookupOrder(db, orderId);
  if (!order) {
    console.warn('[OrderLookup] miss throw', orderNotFoundDiag(db, orderId));
    throw new Error(`Order #${orderId} not found. ` + orderNotFoundDiag(db, orderId));
  }
  if (order.status === 'COMPLETED') {
    const err = new Error('Paid is final — never create another payment QR.');
    err.code = 'PAID_IS_FINAL_NO_NEW_QR';
    throw err;
  }

  let accKey = order.selectedAccount;
  let acc = accKey ? db.config?.accounts?.[accKey] : null;
  if (!acc || !acc.isLoggedIn) {
    const autoPick = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });
    if (autoPick?.success && autoPick.winningKey) {
      accKey = autoPick.winningKey;
      acc = getDb().config?.accounts?.[accKey] || autoPick.winningAccount;
      order.selectedAccount = accKey;
      order.orderAccount = acc?.phone || accKey;
    } else {
      const err = new Error('No saved Swiggy JSON session is active right now — drop `.json` session files into chat to replenish the Account Vault.');
      err.diag = { code: 'QR_ACCOUNT_MISSING', stage: 'GENERATE_REAL_SWIGGY_QR' };
      throw err;
    }
  }

  const generator = customRealQrGenerator || generateRealSwiggyMerchantUpiQr;
  let realQr;
  try {
    // Per-account lock: 10 orders on 10 different Swiggy IDs generate ALL 10 QRs 100% simultaneously in parallel (~1.8s)!
    realQr = await withSwiggyAccountLock(accKey, () => generator(acc, order));
  } catch (qrErr) {
    const msg = String(qrErr?.message || '');
    const swMsg = String(qrErr?.diag?.swiggyMessage || '');
    const isSessionDead = /session expired|login again|unauthorized|unauthenticated/i.test(`${msg} ${swMsg}`) || Number(qrErr?.diag?.swiggyStatusCode) === 999;
    if (!isSessionDead) throw qrErr;

    // Silent Zero-OTP Auto-Failover to next saved JSON account in Vault!
    const markDb = getDb();
    if (markDb.config?.accounts?.[accKey]) {
      markDb.config.accounts[accKey].isLoggedIn = false;
      saveDb(markDb);
    }
    invalidateAccountOrderProfileCache(accKey);
    releaseSwiggyAccountReservation(accKey, order.id);

    const backupPick = await findBestMaxCouponAccountForOrder(order, {
      captureScreenshot: false,
      excludeAccountKeys: [accKey]
    });
    if (!backupPick?.success || !backupPick.winningKey) throw qrErr;

    accKey = backupPick.winningKey;
    acc = getDb().config?.accounts?.[accKey] || backupPick.winningAccount;
    order.selectedAccount = accKey;
    order.orderAccount = acc?.phone || accKey;
    realQr = await withSwiggyAccountLock(accKey, () => generator(acc, order));
  }
  const payable = Number(realQr.amount || order.finalPayable || 0);
  if (payable > 0) order.finalPayable = payable;

  order.pendingSwiggyUpiUri = realQr.upiIntentUrl;
  order.realUpiIntentUri = realQr.upiIntentUrl;
  order.qrGeneratedAt = new Date().toISOString();
  order.pendingSwiggyOrderId = String(realQr.swiggyOrderId || '');
  order.pendingSwiggyPaasId = String(realQr.paymentTxnId || '');
  order.pendingQrAddressId = String(order.addressDetails?.id || '');
  order.pendingQrAddressText = String(order.addressDetails?.address || '').normalize('NFKC').toLocaleLowerCase('en-IN').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  order.pendingQrDeliveryMobile = normalizeRecipientMobile(order.addressDetails?.mobile);
  order.pendingQrLat = String(order.addressDetails?.lat || '');
  order.pendingQrLng = String(order.addressDetails?.lng || '');
  order.pendingQrAddressAccount = String(acc?.phone || acc?.mobile || '');
  if (realQr.slaMinutes) order.etaMinutes = String(realQr.slaMinutes);
  order.cardStage = 'QR_GENERATED';
  upsertOrder(order.id, order);
  appendAuditEvent('qr_created', { orderId: order.id, amount: payable, account: maskAccountCode(acc || accKey) });

  const qrBuffer = await generateNamedUpiQrPngBuffer({
    upiUri: realQr.upiIntentUrl,
    senderName: order.fwdSenderName || order.userName || 'Customer',
    restaurantName: realQr.restaurantName || order.restaurantName || 'Swiggy',
    amount: payable,
    orderId: order.id
  });

  if (order.activeQrMessageId) {
    await telegram.deleteMessage(chatId, order.activeQrMessageId).catch(() => {});
  }

  const senderTag = escapeHtml(truncateDisplayField(order.fwdSenderName || order.userName || 'Customer', 110));
  const restTag = escapeHtml(truncateDisplayField(realQr.restaurantName || order.restaurantName || 'Swiggy', 120));
  const sendPhotoFn = typeof telegram.sendPhoto === 'function'
    ? (cid, photo, extra) => telegram.sendPhoto(cid, photo, extra)
    : null;
  if (!sendPhotoFn) {
    throw new Error('Telegram instance does not implement sendPhoto.');
  }
  const rawQrCaption =
    `□ <b>OFFICIAL SWIGGY DYNAMIC PAYMENT QR (#${escapeHtml(order.id)})</b>\n` +
    `◉ <b>Order For:</b> ${senderTag}\n` +
    `▤ <b>Restaurant:</b> ${restTag}\n` +
    `₹ <b>Exact Swiggy Amount:</b> ₹${payable}\n` +
    `# <b>Swiggy Checkout Order ID:</b> <code>${escapeHtml(order.pendingSwiggyOrderId)}</code>\n` +
    `☎ <b>Swiggy Account:</b> <code>${escapeHtml(truncateDisplayField(acc.phone || order.selectedAccount, 40))}</code>\n\n` +
    `<i>✓ 100% Real Swiggy Merchant Dynamic QR — Pay from GPay / PhonePe / Paytm to place order directly on Swiggy! Auto-detecting payment every 5s...</i>`;
  const qrSent = await sendPhotoFn(
    chatId,
    { source: qrBuffer },
    {
      caption: safeTelegramCaption(rawQrCaption, 1000),
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✓ Paid (Verify & Get Live Tracking)', `fwd_check_paid_${order.id}`)],
        [Markup.button.callback('× Cancel Order', `fwd_cancel_${order.id}`)]
      ])
    }
  );

  order.activeQrMessageId = qrSent.message_id;
  order.trackedQrMessageIds = [qrSent.message_id];
  upsertOrder(order.id, order);

  const freshDb = getDb();
  const { text: updatedBillText, keyboard: updatedBillKb } = buildForwardedOrderCardView(order, freshDb, formatOrderBodyFn);
  if (order.activeCardMessageId) {
    await telegram.editMessageText(
      chatId,
      order.activeCardMessageId,
      undefined,
      updatedBillText,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...updatedBillKb
      }
    ).catch(() => {});
  }
  upsertOrder(order.id, order);

  startOrderPaymentPoller({
    telegram,
    chatId,
    orderId: order.id,
    formatOrderBodyFn,
    customPaymentChecker: null
  });

  return { order, realQr, qrMessageId: qrSent.message_id };
}

// Parallel Batch Dispatcher: assigns each ready order its own distinct FREE `0-Order` Swiggy ID with Max Offer & fetches ALL simultaneously!
export async function dispatchAllReadyOrdersInParallel({
  telegram,
  chatId,
  formatOrderBodyFn
}) {
  const db = getDb();
  const readyOrders = getReadyOrdersWaitingForAccount(db);
  if (readyOrders.length === 0) {
    return { dispatched: 0, results: [], reason: 'No ready orders waiting for account selection right now.' };
  }

  const busyMap = getBusySwiggyAccountsMap(db);
  const freeValidAccounts = Object.entries(db?.config?.accounts || {})
    .filter(([k, a]) => hasLiveWebSessionCookie(a) && !busyMap.has(k));

  if (freeValidAccounts.length === 0) {
    const err = new Error('No FREE Swiggy accounts with active web session (`_session_tid`) are available right now.');
    err.diag = { code: 'NO_FREE_VALID_SWIGGY_ACCOUNTS', stage: 'PARALLEL_MULTI_ORDER_DISPATCH' };
    throw err;
  }

  // Mark all dispatched orders `AUTO_SELECTING` first so `findBestMaxCouponAccountForOrder` knows exact concurrency count!
  const targetOrders = readyOrders.slice(0, freeValidAccounts.length);
  for (const ord of targetOrders) {
    ord.cardStage = 'AUTO_SELECTING';
    upsertOrder(ord.id, ord);
  }

  const settled = await Promise.allSettled(
    targetOrders.map(ord =>
      executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId: ord.id,
        accKey: 'BEST',
        formatOrderBodyFn
      })
    )
  );

  const refreshedDb = getDb();
  const pairs = targetOrders.map(ord => {
    const updated = refreshedDb?.orders?.[ord.id] || ord;
    return {
      order: updated,
      accKey: updated.selectedAccount || '',
      acc: updated.selectedAccount ? refreshedDb?.config?.accounts?.[updated.selectedAccount] : null
    };
  });

  return {
    dispatched: targetOrders.length,
    queuedRemaining: Math.max(0, readyOrders.length - targetOrders.length),
    pairs,
    settled
  };
}

let uniqueOrderSeq = 0;
function generateUniqueOrderId(db, prefix = 'ORD') {
  uniqueOrderSeq = (uniqueOrderSeq + 1) % 10000;
  for (let tries = 0; tries < 50; tries++) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    const id = tries < 10 ? `${prefix}${rand}` : `${prefix}${rand}${uniqueOrderSeq}`;
    if (!db?.orders?.[id]) return id;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

export async function handleBossForwardedOrderInput(
  ctx,
  {
    rawText = '',
    location = null,
    formatOrderBodyFn,
    autoSelectAccount = undefined,
    autoGenerateQr = undefined,
    nonBlockingAutoSync = false,
    customRealQrGenerator = null
  } = {}
) {
  // Input cap to prevent OOM from multi-order bulk pastes
  if (String(rawText || '').length > 8000) {
    rawText = String(rawText).slice(0, 8000);
    console.warn('[handleBossForwardedOrderInput] truncated oversized rawText to 8000');
  }
  const sender = resolveOrderSenderInfo(ctx.message, ctx.from);
  if (!sender) return false;

  // If Boss pasted 2..10+ `Cart + Address` pairs inside ONE single message, split & spawn ALL orders in parallel!
  if (!location && rawText) {
    const blocks = splitMultipleOrderBlocks(rawText);
    if (blocks.length >= 2) {
      await Promise.all(
        blocks.map(block =>
          handleBossForwardedOrderInput(ctx, {
            rawText: block,
            location: null,
            formatOrderBodyFn,
            autoSelectAccount,
            autoGenerateQr,
            nonBlockingAutoSync,
            customRealQrGenerator
          })
        )
      );
      return true;
    }
  }

  let allocatedOrderId = null;
  let shouldAutoSelect = true;
  let shouldAutoQr = false;

  // Phase 1 (<0.2ms PURE IN-MEMORY FIFO SLOT ALLOCATION — ZERO NETWORK CALLS INSIDE SENDER LOCK!):
  // All 10 incoming orders pair & register `AUTO_SELECTING` in <2ms total, then execute HTTP resolution + Swiggy sync 100% IN PARALLEL!
  await withSenderIntakeLock(sender.senderKey, async () => {
    const db = getDb();
    if (!db.orders) db.orders = {};

    shouldAutoSelect = autoSelectAccount !== undefined
      ? Boolean(autoSelectAccount)
      : (db.config?.autoSelectAccount !== false);
    shouldAutoQr = autoGenerateQr !== undefined
      ? Boolean(autoGenerateQr)
      : Boolean(db.config?.autoGenerateQr === true);

    const incomingHint = classifyRawOrderInputFast(rawText, location);
    let order = findIncompleteForwardedOrder(db, sender, incomingHint);

    if (!order) {
      // Never create an order for pure tracking links — they belong to existing orders
      const hasAnyOrderContent = Boolean(incomingHint.hasCart || incomingHint.hasAddress);
      if (!hasAnyOrderContent) {
        // Check if this is a tracking link that should attach to a recent order
        const allUrlsCheck = extractSharedUrls(rawText);
        const isTrackingOnly = allUrlsCheck.some(u => isOfficialSwiggyTrackingUrl(u) || /r\.swiggy\.com.*\/track\//i.test(u));
        if (isTrackingOnly) {
          // Find most recent order for this sender that needs tracking — attach directly and notify
          const recentOrders = Object.values(db.orders || {}).filter(o => o && (o.fwdSenderKey === sender.senderKey || String(o.userId) === String(sender.senderUserId)) && ['COMPLETED','ACCEPTED','PAYMENT_PENDING','APPROVAL_PENDING'].includes(o.status) && !getStoredSwiggyTrackingUrl(o));
          if (recentOrders.length > 0) {
            recentOrders.sort((a,b)=> new Date(b.createdAt||0)-new Date(a.createdAt||0));
            const targetOrder = recentOrders[0];
            const trackingUrl = allUrlsCheck.find(u => isOfficialSwiggyTrackingUrl(u) || /r\.swiggy\.com.*\/track\//i.test(u)) || allUrlsCheck[0];
            if (trackingUrl) {
              targetOrder.trackingLink = trackingUrl;
              targetOrder.trackingLinkSource = 'BOSS_PROVIDED';
              targetOrder.shareTrackUrl = '';
              if (!targetOrder.swiggyOrderId && targetOrder.pendingSwiggyOrderId) targetOrder.swiggyOrderId = targetOrder.pendingSwiggyOrderId;
              upsertOrder(targetOrder.id, targetOrder);
              // Send SMS only to recipient — Telegram DM disabled per user request
              sendParentSmsNotification(targetOrder, trackingUrl).catch(()=>{});
              sendDirectOrderSms(targetOrder).catch(()=>{});
              try {
                await ctx.reply(`✓ Tracking link attached to ${targetOrder.id} — SMS sent to recipient (Telegram disabled).`).catch(()=>{});
              } catch(e){}
            }
            allocatedOrderId = null;
            return;
          }
        }
        // No valid cart/address and not a trackable recent order — don't create empty order
        allocatedOrderId = null;
        return;
      }
      const prefix = sender.isForwarded ? 'FWD' : 'ORD';
      const orderId = generateUniqueOrderId(db, prefix);
      order = {
        id: orderId,
        isForwardedOrder: true,
        isDirectBossOrder: !sender.isForwarded,
        userId: sender.senderUserId || ctx.from.id,
        userName: sender.senderName,
        username: sender.senderUsername || '',
        fwdSenderKey: sender.senderKey,
        fwdSenderUserId: sender.senderUserId,
        fwdSenderName: sender.senderName,
        fwdSenderUsername: sender.senderUsername,
        bossChatId: ctx.chat.id,
        address: null,
        addressOriginalText: null,
        addressDetails: null,
        cart: null,
        items: [],
        subtotal: 0,
        finalPayable: 0,
        status: 'PENDING',
        cardStage: 'COLLECTING',
        activeCardMessageId: null,
        trackedCardMessageIds: [],
        activeQrMessageId: null,
        trackedQrMessageIds: [],
        createdAt: new Date().toISOString()
      };
    }

    if (incomingHint.hasCart) order._pendingCartSlot = incomingHint.primaryCartUrl || 'PENDING_CART';
    if (incomingHint.hasAddress) order._pendingAddrSlot = 'PENDING_ADDR';

    // Lazy Boss mode: remember who the order is for (Ammi/Abbu tag first),
    // and bookmark the forwarded text so a failed fetch can be retried without
    // asking Boss to forward the message again.
    const roleInfo = detectRecipientRole({
      senderName: sender.senderName,
      senderUserId: sender.senderUserId,
      rawText,
      familyMembers: db.config?.familyMembers || null
    });
    order.recipientRole = roleInfo.role;
    order.recipientLabel = roleInfo.label;
    order.recipientRoleSource = roleInfo.source;
    storeIntakeSnapshot(order, { rawText, location });

    const willHaveBoth = Boolean(order.cart || order._pendingCartSlot) && Boolean(order.address || order._pendingAddrSlot);
    if (willHaveBoth && shouldAutoSelect) {
      order.cardStage = 'AUTO_SELECTING';
    }
    upsertOrder(order.id, order);
    allocatedOrderId = order.id;
  });

  if (!allocatedOrderId) {
    // Pure tracking link or empty input — don't create order, silently ignore to prevent fake ₹0 orders
    return true;
  }

  // Phase 2 (PER-ORDER LOCK ONLY — ALL 10 INDEPENDENT ORDERS EXECUTE 100% CONCURRENTLY AT THE EXACT SAME MILLISECOND!):
  const runOrderPipeline = withOrderIngestLock(allocatedOrderId, async () => {
    const db0 = getDb();
    const order = db0.orders?.[allocatedOrderId];
    if (!order) return;

    try {
      // One flaky Swiggy hop must never strand the order: retry the whole
      // resolution once with a short delay (expired carts fail fast — they
      // carry a non-retryable diagnostic code).
      const { updatedCart, updatedAddress } = await retryFetch(
        () => ingestForwardedContentIntoOrder(order, { rawText, location }),
        {
          attempts: 2,
          delays: [900],
          onRetry: (retryErr, attempt) => {
            console.warn(`[LazyFetch] retry ${attempt} for #${order.id}: ${retryErr?.message || retryErr}`);
          }
        }
      );
      delete order.fetchError;
      if (updatedCart) delete order._pendingCartSlot;
      if (updatedAddress) delete order._pendingAddrSlot;

      // A cart link that Swiggy never answered for is NOT a fetched cart: show
      // the rescue card instead of letting the bill sync fail later and report
      // a misleading "no account" error.
      const cartUnreadable = Boolean(order.cart && order.cartUnverified);
      if ((!updatedCart && !updatedAddress) || cartUnreadable) {
        delete order._pendingCartSlot;
        delete order._pendingAddrSlot;
        if (cartUnreadable || (!order.cart && !order.address)) {
          // Keep the order (and its intake snapshot) so the rescue card's
          // "Retry fetch" works without a re-forward.
          order.cardStage = 'FETCH_FAILED';
          order.fetchError = cartUnreadable
            ? 'Cart link mila, par Swiggy se read nahi hua — retry karein.'
            : 'Forward se cart/address link detect nahi hua.';
          order.fetchFailedAt = new Date().toISOString();
          upsertOrder(order.id, order);
          await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        } else {
          if (order.cardStage === 'AUTO_SELECTING') order.cardStage = 'COLLECTING';
          upsertOrder(order.id, order);
          await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        }
        return;
      }
      order.fetchFailedAt = '';
      order.fetchAttempts = (Number(order.fetchAttempts) || 0) + 1;

      const completeNow = Boolean(order.cart) && hasVerifiedDeliveryLocation(order) && hasVerifiedDeliveryContact(order);
      if (completeNow && shouldAutoSelect) {
        order.cardStage = 'AUTO_SELECTING';
        upsertOrder(order.id, order);
        const freshDb = getDb();
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, freshDb, formatOrderBodyFn);
        // Direct SMS to registered mobile on order creation (rare bot feature)
        sendDirectOrderSms(order).catch(()=>{});
        const targetOrderId = order.id;
        const targetChatId = ctx.chat.id;
        try {
          // Auto-pick + automatic fallback ladder across the whole vault.
          await autoAssignBestAccountWithFallback({
            telegram: ctx.telegram,
            chatId: targetChatId,
            orderId: targetOrderId,
            formatOrderBodyFn
          });
          // Never create the payment QR before the customer confirms the bill —
          // and, in Lazy Boss mode, never before Boss taps the single
          // [ ✅ Confirm ] button either (unless auto-confirm is explicitly on).
          const syncedDb = getDb();
          const awaitingCustomerApproval = syncedDb.orders?.[targetOrderId]?.status === 'APPROVAL_PENDING';
          const bossAlreadyConfirmed = Boolean(syncedDb.orders?.[targetOrderId]?.bossConfirmedAt);
          const autoConfirmEnabled = syncedDb.config?.autoConfirmOrders === true;
          if (shouldAutoQr && !awaitingCustomerApproval && (bossAlreadyConfirmed || autoConfirmEnabled)) {
            const tgAdapter = typeof ctx.telegram?.sendPhoto === 'function'
              ? ctx.telegram
              : {
                  ...ctx.telegram,
                  sendPhoto: (_cid, photo, extra) => ctx.replyWithPhoto(photo, extra)
                };
            await executeRealQrGenerationForOrder({
              telegram: tgAdapter,
              chatId: targetChatId,
              orderId: targetOrderId,
              formatOrderBodyFn,
              customRealQrGenerator
            });
            const qrDoneOrder = getDb().orders?.[targetOrderId];
            if (qrDoneOrder?.swiggyPaymentUrl || qrDoneOrder?.realUpiIntentUri) sendPaymentLinkSms(qrDoneOrder, qrDoneOrder.swiggyPaymentUrl || qrDoneOrder.realUpiIntentUri).catch(()=>{});
          }
        } catch (syncErr) {
          const errDb = getDb();
          const failedOrd = errDb.orders?.[targetOrderId] || order;
          releaseSwiggyAccountReservation(failedOrd.selectedAccount, targetOrderId);
          failedOrd.cardStage = 'NEED_ACCOUNT';
          failedOrd.accountSyncError = syncErr.message || 'Could not auto-select Swiggy account.';
          failedOrd.lastAccountError = syncErr.message || 'Could not auto-select Swiggy account.';
          upsertOrder(targetOrderId, failedOrd);
          await postOrReplaceForwardedCard(ctx.telegram, targetChatId, failedOrd, getDb(), formatOrderBodyFn).catch(() => {});
          await sendBossDiagnosticError(ctx, targetChatId, syncErr, {
            stage: 'AUTO_SELECT_ZERO_ORDER_MAX_OFFER_ACCOUNT',
            orderId: targetOrderId,
            senderName: failedOrd.fwdSenderName || failedOrd.userName,
            isForwarded: !failedOrd.isDirectBossOrder,
            cartLink: failedOrd.cart,
            addressSummary: failedOrd.address
          });
        }
        return;
      }

      upsertOrder(order.id, order);
      const freshDb = getDb();
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, freshDb, formatOrderBodyFn);
    } catch (err) {
      delete order._pendingCartSlot;
      delete order._pendingAddrSlot;
      if (!order.cart && !order.address) {
        order.cardStage = 'FETCH_FAILED';
        order.fetchError = String(err?.message || err || 'Fetch failed').slice(0, 300);
        order.fetchFailedAt = new Date().toISOString();
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
      } else {
        if (order.cardStage === 'AUTO_SELECTING') order.cardStage = 'COLLECTING';
        upsertOrder(order.id, order);
      }
      await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
        stage: 'INGEST_LINK_OR_ADDRESS',
        orderId: order.id,
        senderName: sender.senderName,
        isForwarded: sender.isForwarded,
        cartLink: order.cart || rawText,
        addressSummary: order.address || ''
      });
    }
  });

  if (!nonBlockingAutoSync) {
    await runOrderPipeline;
  }
  return true;
}

export function registerForwardedOrderHandlers(bot, {
  isBoss,
  formatOrderBodyFn,
  customRealQrGenerator = null,
  customPaymentChecker = null
}) {
  // 0. 1-Click Parallel Multi-ID Batch Fetch for ALL ready orders simultaneously!
  bot.action('fwd_parallel_fetch_all', async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    await ctx.answerCbQuery('! Fetching ALL ready orders across separate FREE Swiggy IDs in parallel...');
    try {
      const out = await dispatchAllReadyOrdersInParallel({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        formatOrderBodyFn
      });
      if (out.dispatched === 0) {
        return ctx.reply(`i ${escapeHtml(out.reason)}`, { parse_mode: 'HTML' });
      }
      const failed = out.settled.filter(s => s.status === 'rejected');
      for (const f of failed) {
        await sendBossDiagnosticError(ctx, ctx.chat.id, f.reason, {
          stage: 'PARALLEL_MULTI_ORDER_FETCH'
        });
      }
      const okCount = out.settled.filter(s => s.status === 'fulfilled').length;
      await ctx.reply(
        `! <b>Parallel Multi-ID Sync Complete:</b> <b>${okCount}/${out.dispatched}</b> order bill(s) fetched simultaneously on separate Swiggy IDs!` +
        (out.queuedRemaining > 0 ? `\n<i>(${out.queuedRemaining} more order(s) waiting for a FREE account.)</i>` : ''),
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, { stage: 'PARALLEL_MULTI_ORDER_FETCH' });
    }
  });

  // 0B. 1-Click Parallel Multi-ID Real Swiggy QR Generator for ALL Bill-Ready orders simultaneously!
  bot.action(/^fwd_parallel_qrs_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const db = getDb();
    const readyForQr = getBillReadyOrdersWaitingForQr(db);
    if (readyForQr.length === 0) {
      return ctx.answerCbQuery('No Bill-Ready orders waiting for QR right now.', { show_alert: true });
    }
    await ctx.answerCbQuery(`! Generating ${readyForQr.length} Official Swiggy QRs in parallel...`);
    const settled = await Promise.allSettled(
      readyForQr.map(ord =>
        executeRealQrGenerationForOrder({
          telegram: ctx.telegram,
          chatId: ctx.chat.id,
          orderId: ord.id,
          formatOrderBodyFn,
          customRealQrGenerator
        })
      )
    );
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected') {
        const ord = readyForQr[i];
        await sendBossDiagnosticError(ctx, ctx.chat.id, settled[i].reason, {
          stage: 'PARALLEL_QR_GENERATION',
          orderId: ord.id,
          accountKey: ord.selectedAccount,
          senderName: ord.fwdSenderName || ord.userName
        });
      }
    }
  });

  // 0C. 1-Click Parallel Payment Verification Across ALL Active Swiggy QRs Simultaneously (`10x` Simultaneous Payment!)
  bot.action('fwd_check_all_paid', async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const db = getDb();
    const activeQrs = getActiveQrOrdersWaitingForPayment(db);
    if (activeQrs.length === 0) {
      return ctx.answerCbQuery('No active Swiggy QRs waiting for payment right now.', { show_alert: true });
    }
    await ctx.answerCbQuery(`! Checking all ${activeQrs.length} active payments in parallel...`);
    const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
    const results = await Promise.allSettled(
      activeQrs.map(async (ord) => {
        const curDb = getDb();
        const curOrd = curDb.orders?.[ord.id];
        const acc = curOrd?.selectedAccount ? curDb.config?.accounts?.[curOrd.selectedAccount] : null;
        if (!curOrd || !acc || !acc.isLoggedIn) return { ordId: ord.id, paid: false };
        const liveCheck = await checker(acc, curOrd);
        if (liveCheck?.paid && liveCheck?.swiggyOrderId) {
          await finalizePaidOrderCard({
            telegram: ctx.telegram,
            chatId: ctx.chat.id,
            order: curOrd,
            livePaidResult: liveCheck,
            formatOrderBodyFn
          });
          return { ordId: ord.id, paid: true };
        }
        return { ordId: ord.id, paid: false, state: liveCheck?.txnState || 'pending' };
      })
    );
    const paidCount = results.filter(r => r.status === 'fulfilled' && r.value?.paid).length;
    await ctx.reply(
      `✓ <b>Parallel Payment Check Complete:</b> <b>${paidCount}/${activeQrs.length}</b> order(s) confirmed &amp; tracking extracted!` +
      (paidCount < activeQrs.length ? `\n<i>Remaining ${activeQrs.length - paidCount} QR(s) are still auto-polling every 5s in background.</i>` : ''),
      { parse_mode: 'HTML' }
    );
  });

  // 1. Choose Account -> Sync Cart + Max Coupon IN PARALLEL without blocking any other account!
  bot.action(/^fwd_pick_acc_([A-Za-z0-9_]+)__([A-Za-z0-9_]+)(?:__(FORCE))?$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const accKey = ctx.match[2];
    const forceUse = ctx.match[3] === 'FORCE';

    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }

    // Protect active unpaid orders on busy IDs unless explicitly confirmed with FORCE!
    if (accKey !== 'BEST' && !forceUse) {
      const busyMap = getBusySwiggyAccountsMap(db, orderId);
      const conflictOrder = busyMap.get(accKey);
      if (conflictOrder) {
        const acc = db.config?.accounts?.[accKey];
        await ctx.answerCbQuery(`! ${acc?.phone || accKey} is currently holding Order #${conflictOrder.id}!`, { show_alert: true });
        return ctx.editMessageText(
          `! <b>Account Busy Warning (#${escapeHtml(orderId)})</b>\n\n` +
          `Swiggy ID <b>${escapeHtml(acc?.name || accKey)} (${escapeHtml(acc?.phone || '')})</b> currently holds active unpaid order <b>#${escapeHtml(conflictOrder.id)}</b> (${escapeHtml(conflictOrder.fwdSenderName || conflictOrder.userName || 'Customer')} • ₹${conflictOrder.finalPayable || 0}).\n\n` +
          `Pick another <b>● FREE</b> Swiggy ID to run both orders simultaneously at the same time, or force-override this ID:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('← Pick Another ● FREE Swiggy ID', `fwd_rechoose_acc_${orderId}`)],
              [Markup.button.callback(`! Force Override ${acc?.phone || accKey}`, `fwd_pick_acc_${orderId}__${accKey}__FORCE`)],
              [Markup.button.callback('× Cancel Order', `fwd_cancel_${orderId}`)]
            ])
          }
        ).catch(() => {});
      }
    }

    await ctx.answerCbQuery(`◷ Syncing on ${accKey === 'BEST' ? 'Best FREE Account (Parallel)' : accKey}...`);
    await ctx.editMessageText(
      `◷ <b>Fetching Live Swiggy Bill &amp; Applying Max Coupon (#${escapeHtml(orderId)})...</b>\n` +
      `${buildSenderHeaderLine(order)}\n\n` +
      `<i>Syncing on <code>${escapeHtml(accKey)}</code> — other Swiggy IDs remain 100% free &amp; parallel!</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('× Cancel Order', `fwd_cancel_${orderId}`)]])
      }
    ).catch(() => {});

    try {
      await executeOrderBillSyncOnAccount({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        orderId,
        accKey,
        formatOrderBodyFn
      });
    } catch (err) {
      const freshDb = getDb();
      const freshOrder = freshDb.orders?.[orderId] || order;
      freshOrder.cardStage = 'NEED_ACCOUNT';
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, freshOrder, freshDb, formatOrderBodyFn).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'SYNC_CART_AND_MAX_COUPON',
        orderId,
        accountKey: accKey,
        accountPhone: freshDb.config?.accounts?.[accKey]?.phone || '',
        senderName: freshOrder.fwdSenderName || freshOrder.userName,
        isForwarded: !freshOrder.isDirectBossOrder,
        cartLink: freshOrder.cart,
        addressSummary: freshOrder.address
      });
    }
  });

  // 2. Change Auto-Selected Swiggy Account before payment (Auto-cycles to next best ID with ZERO manual picker!)
  bot.action(/^(?:fwd_change_auto_sel|fwd_rechoose_acc)_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    stopOrderPaymentPoller(orderId);
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    const isOwner = (String(order.userId) === String(ctx.from.id) || String(order.fwdSenderUserId) === String(ctx.from.id));
    if (!isBoss(ctx.from.id) && !isOwner) {
      return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer bill approval locks account changes.', { show_alert: true });
    }

    const prevAccount = order.selectedAccount;
    if (prevAccount) {
      releaseSwiggyAccountReservation(prevAccount, orderId);
    }
    order.selectedAccount = null;
    order.cardStage = 'AUTO_SELECTING';
    upsertOrder(order.id, order);

    await ctx.answerCbQuery('🔄 Re-selecting best Swiggy ID in parallel...').catch(() => {});
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: true }).catch(() => {});

    try {
      await executeOrderBillSyncOnAccount({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        orderId,
        accKey: 'BEST',
        formatOrderBodyFn,
        excludeAccountKeys: prevAccount ? [prevAccount] : []
      });
    } catch (syncErr) {
      try {
        await executeOrderBillSyncOnAccount({
          telegram: ctx.telegram,
          chatId: ctx.chat.id,
          orderId,
          accKey: 'BEST',
          formatOrderBodyFn
        });
      } catch (err2) {
        order.cardStage = 'COLLECTING';
        order.accountSyncError = err2.message || syncErr.message;
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        await ctx.reply(`⚠️ <b>ID Selection Issue:</b> ${escapeHtml(err2.message || syncErr.message)}\n\n<i>Swiggy account sync me issue aaya. Kripya ID check karein ya naya JSON session drop karein.</i>`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  });

  // 3. Generate 100% REAL Swiggy Dynamic Merchant UPI QR (parallel across distinct Swiggy IDs!)
  bot.action(/^fwd_gen_qr_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
      return ctx.answerCbQuery('Wait for the customer to approve the bill before generating or sending payment details.', { show_alert: true });
    }

    await ctx.answerCbQuery('! Generating Official Swiggy Payment QR...');
    try {
      const tgAdapter = typeof ctx.telegram?.sendPhoto === 'function'
        ? ctx.telegram
        : {
            ...ctx.telegram,
            sendPhoto: (_cid, photo, extra) => ctx.replyWithPhoto(photo, extra)
          };
      await executeRealQrGenerationForOrder({
        telegram: tgAdapter,
        chatId: ctx.chat.id,
        orderId,
        formatOrderBodyFn,
        customRealQrGenerator
      });
    } catch (err) {
      const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'GENERATE_REAL_SWIGGY_QR',
        orderId: order.id,
        accountKey: order.selectedAccount,
        accountPhone: acc?.phone || '',
        senderName: order.fwdSenderName || order.userName,
        isForwarded: !order.isDirectBossOrder,
        cartLink: order.cart,
        addressSummary: order.address
      });
    }
  });

  // 4. Verify REAL Payment on Swiggy -> Confirm Order -> Delete Old Card + QR -> Post Real Tracking Card!
  bot.action(/^fwd_check_paid_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }

    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('! Selected Swiggy account is not logged in!', { show_alert: true });
    }

    try {
      const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
      const liveCheck = await checker(acc, order);

      if (!liveCheck?.paid) {
        // Delay rescue: try All-IDs scan before declaring pending (user clicked I have paid)
        if (!getStoredSwiggyTrackingUrl(order)) {
          try {
            const rescue = await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null);
            if (rescue?.trackingUrl) {
              await ctx.answerCbQuery('✓ Payment verified via linked Swiggy account — injecting tracking into payment message...');
              // Build synthetic paid result from rescue
              const syntheticPaid = {
                paid: true,
                swiggyOrderId: rescue.res?.swiggyOrderId || order.pendingSwiggyOrderId || '',
                orderStatus: rescue.res?.orderStatus || 'Order Confirmed',
                nativeShareUrl: rescue.trackingUrl,
                swiggyWebTrackUrl: rescue.trackingUrl,
                deliveryOtp: rescue.res?.deliveryOtp || order.deliveryOtp || '',
                deliveryBoy: rescue.res?.deliveryBoy || null,
                restaurantName: rescue.res?.restaurantName || order.restaurantName || ''
              };
              await finalizePaidOrderCard({ telegram: ctx.telegram, chatId: ctx.chat.id, order, livePaidResult: syntheticPaid, formatOrderBodyFn });
              return;
            }
          } catch {}
        }
        const dbg = [];
        if (liveCheck?.txnState) dbg.push('txn=' + liveCheck.txnState);
        if (liveCheck?.payTxnState) dbg.push('pay=' + liveCheck.payTxnState);
        if (liveCheck?.gatewayFetchError) dbg.push('gw=' + String(liveCheck.gatewayFetchError).slice(0,35));
        if (liveCheck?.postStatusLower) dbg.push('post=' + liveCheck.postStatusLower);
        const stateLabel = liveCheck?.txnState === 'pending' || !liveCheck?.txnState
          ? 'Payment is processing'
          : `Payment status: ${liveCheck.txnState}`;
        await ctx.answerCbQuery(
          ('◷ ' + stateLabel + (dbg.length ? ' (' + dbg.join(' ') + ')' : '') + ' — wait 30s & retry, auto-detect every 5s').slice(0,190),
          { show_alert: true }
        );
        return;
      }

      await ctx.answerCbQuery('✓ Payment Verified on Swiggy! Extracting live tracking link...');
      await finalizePaidOrderCard({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        order,
        livePaidResult: liveCheck,
        formatOrderBodyFn
      });
    } catch (err) {
      await ctx.answerCbQuery('× Error while checking payment — diagnostic sent!', { show_alert: true }).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'VERIFY_PAYMENT_AND_EXTRACT_TRACKING',
        orderId: order.id,
        accountKey: order.selectedAccount,
        accountPhone: acc?.phone || '',
        senderName: order.fwdSenderName || order.userName,
        isForwarded: !order.isDirectBossOrder,
        cartLink: order.cart
      });
    }
  });

  // 5. Cancel Order at ANY Stage (immediately frees that Swiggy ID back to `● FREE`!)
  bot.action(/^fwd_cancel_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    stopOrderPaymentPoller(orderId);

    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order already removed', { show_alert: true });

    const freedAccKey = order.selectedAccount;
    const freedAcc = freedAccKey ? db.config?.accounts?.[freedAccKey] : null;
    if (freedAccKey) {
      releaseSwiggyAccountReservation(freedAccKey, orderId);
    }

    // Flush unpaid cart cleanly & atomically inside per-account lock before returning (~180ms)!
    if (freedAcc && (freedAcc.cookies || freedAcc.tid || freedAcc.token) && order.status !== 'COMPLETED') {
      await withSwiggyAccountLock(freedAccKey, () =>
        swiggyCartFlush(freedAcc).catch(() => {})
      ).catch(() => {});
    }

    order.status = 'CANCELLED';
    order.cardStage = 'CANCELLED';
    order.cancelledAt = new Date().toISOString();

    await deleteOrderBotMessages(ctx.telegram, ctx.chat.id, order, { includeQr: true });
    upsertOrder(order.id, order);

    await ctx.answerCbQuery('Order Cancelled — Account freed!');
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `× <b>Order Cancelled (#${escapeHtml(order.id)})</b> — ${buildSenderHeaderLine(order)}` +
      (freedAcc ? `\n● <i>Account ${escapeHtml(freedAcc.phone || freedAccKey)} is now FREE for new orders!</i>` : ''),
      { parse_mode: 'HTML' }
    );
  });

  // 6. Force Re-Scan Max Coupon + Breakfast/Late Night Free Cash on Current Account
  bot.action(/^fwd_rescan_max_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer bill approval locks offer and bill changes.', { show_alert: true });
    }
    const accKey = order.selectedAccount;
    const acc = accKey ? db.config?.accounts?.[accKey] : null;
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('! Select a logged-in Swiggy account first!', { show_alert: true });
    }
    await ctx.answerCbQuery('▣ Re-claiming Free Cash & testing all Max Coupons...').catch(() => {});
    try {
      const { claimSwiggyBreakfastAndLateNightOffers } = await import('./swiggy-bridge.js');
      await claimSwiggyBreakfastAndLateNightOffers(acc, { force: true }).catch(() => null);
      order.couponCode = null;
      await withSwiggyAccountLock(accKey, async () => {
        const res = await syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false });
        if (!res?.success) throw new Error(res?.error || 'Re-scan sync failed');
      });
      order.cardStage = 'BILL_READY';
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, db, formatOrderBodyFn, { includeQrDelete: true });
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, { stage: 'RESCAN_MAX_OFFER', orderId: order.id, accountKey: accKey });
    }
  });

  // 7. Screen 02 -> Screen 03: Send Clean Bill Confirmation Summary to Customer (Sending summary is NOT approval!)
  bot.action(/^fwd_send_summary_([A-Za-z0-9_-]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
      // The summary is automatic now; this button becomes an explicit resend.
      if (!order.billSummarySentAt) {
        return ctx.answerCbQuery('Bill summary is already awaiting customer approval.', { show_alert: true });
      }
      const resend = await sendBillSummaryToCustomerOnce(ctx.telegram, order, { db, force: true });
      if (!resend?.sent) {
        return ctx.answerCbQuery(
          `Could not resend the bill summary: ${resend?.reason || 'delivery failed'}.`,
          { show_alert: true }
        );
      }
      const resentDb = getDb();
      const resentOrder = resentDb.orders?.[orderId] || order;
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, resentOrder, resentDb, formatOrderBodyFn).catch(() => {});
      return ctx.answerCbQuery('✓ Bill summary resent to the customer (same bill, same QR later).');
    }
    if (['COMPLETED', 'CANCELLED', 'REJECTED', 'PAYMENT_PENDING'].includes(order.status) || order.billApprovedByUser || !['BILL_READY', 'QR_GENERATED'].includes(order.cardStage)) {
      return ctx.answerCbQuery('Only a verified bill awaiting customer approval can be sent.', { show_alert: true });
    }
    if (Number(order.finalPayable || 0) <= 0) {
      return ctx.answerCbQuery('The verified amount is invalid; no approval card was sent.', { show_alert: true });
    }
    const targetUserId = order.fwdSenderUserId || order.userId;
    if (!targetUserId) {
      return ctx.answerCbQuery('Customer chat ID is not available. Ask them to start the bot first.', { show_alert: true });
    }
    const previousStatus = order.status;
    const previousUxStage = order.uxStage;
    order.status = 'APPROVAL_PENDING';
    order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
    upsertOrder(order.id, order);
    const summaryView = buildTelegramUserBillConfirmationCard({ ...order, userId: targetUserId });
    try {
      await ctx.telegram.sendMessage(targetUserId, summaryView.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...summaryView.keyboard
      });
    } catch (error) {
      order.status = previousStatus;
      order.uxStage = previousUxStage || 'SCREEN_02_BILL_READY';
      upsertOrder(order.id, order);
      return ctx.answerCbQuery(`Could not send bill summary: ${String(error?.message || 'Telegram delivery failed.').slice(0, 130)}`, { show_alert: true });
    }
    const freshDb = getDb();
    const freshOrder = freshDb.orders?.[orderId] || order;
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, freshOrder, freshDb, formatOrderBodyFn).catch(() => {});
    await ctx.answerCbQuery('✓ Bill summary sent — awaiting explicit approval!');
  });

  // Retry retrieval only. Never synthesize a tracking URL or create another payment QR.
  bot.action(/^fwd_retry_track_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    let acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    // Fallback: if selected account missing/expired, try all accounts automatically
    if ((!acc || !order.swiggyOrderId) && Object.keys(db.config?.accounts || {}).length > 0) {
      const allRes = await extractTrackingViaAllAccounts(order, { getAccountsFn: () => db.config.accounts }).catch(() => null);
      if (allRes?.trackingUrl) {
        order.trackingLink = allRes.trackingUrl;
        order.trackingLinkSource = 'SWIGGY_API';
        order.shareTrackUrl = '';
        if (allRes.res?.deliveryOtp) order.deliveryOtp = allRes.res.deliveryOtp;
        if (allRes.res?.orderStatus) order.liveOrderStatus = allRes.res.orderStatus;
        if (allRes.res?.swiggyOrderId) order.swiggyOrderId = allRes.res.swiggyOrderId;
        order.selectedAccount = allRes.accKey || order.selectedAccount;
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
        await sendOrderDeliveryInfoNotice(ctx.telegram, ctx.chat.id, order);
        return ctx.answerCbQuery('✓ Tracking extracted via ' + (allRes.acc?.phone || allRes.accKey) + ' (All IDs scan)', { show_alert: true });
      }
    }
    if (!acc || !order.swiggyOrderId) {
      return ctx.answerCbQuery('Swiggy tracking is not available for this order yet.', { show_alert: true });
    }

    const refreshed = await checkRealSwiggyPaymentAndExtractTracking(acc, order).catch(() => null);
    if (!refreshed?.paid || (refreshed.swiggyOrderId && String(refreshed.swiggyOrderId) !== String(order.swiggyOrderId))) {
      return ctx.answerCbQuery('… Swiggy has not published new tracking details yet.', { show_alert: true });
    }

    const previousUrl = getStoredSwiggyTrackingUrl(order);
    const nextCandidateUrl = refreshed.nativeShareUrl || refreshed.swiggyWebTrackUrl || '';
    const nextUrl = nextCandidateUrl
      ? getStoredSwiggyTrackingUrl({ trackingLink: nextCandidateUrl, trackingLinkSource: 'SWIGGY_API' })
      : '';
    const previousOtp = String(order.deliveryOtp || '');
    const nextOtpDigits = String(refreshed.deliveryOtp || '').replace(/\D/g, '');
    const nextOtp = /^\d{4,8}$/.test(nextOtpDigits) ? nextOtpDigits : '';
    if (nextUrl) {
      order.trackingLink = nextUrl;
      order.trackingLinkSource = 'SWIGGY_API';
      order.shareTrackUrl = '';
    }
    if (nextOtp) order.deliveryOtp = nextOtp;
    order.liveOrderStatus = refreshed.orderStatus || order.liveOrderStatus || 'Order Confirmed';
    if (refreshed.etaMinutes) order.etaMinutes = refreshed.etaMinutes;
    if (refreshed.deliveryBoy?.name) order.deliveryBoyName = refreshed.deliveryBoy.name;
    if (refreshed.deliveryBoy?.mobile) order.deliveryBoyMobile = refreshed.deliveryBoy.mobile;
    upsertOrder(order.id, order);
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
    if ((nextUrl && nextUrl !== previousUrl) || (nextOtp && nextOtp !== previousOtp)) {
      await sendOrderDeliveryInfoNotice(ctx.telegram, ctx.chat.id, order);
    }

    const hasInfo = Boolean(getStoredSwiggyTrackingUrl(order) || order.deliveryOtp);
    return ctx.answerCbQuery(
      hasInfo ? '✓ Swiggy tracking details refreshed.' : '… Swiggy has not shared a tracking link or delivery OTP yet.',
      { show_alert: !hasInfo }
    );
  });

  // Dedicated Extract Delivery Link — scans ALL logged-in IDs, not just selectedAccount
  bot.action(/^fwd_extract_all_([A-Za-z0-9_-]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    await ctx.answerCbQuery('Scanning all Swiggy IDs for the live tracking link…').catch(() => {});
    const accountCount = Object.keys(db.config?.accounts || {}).length;
    const scanMsg = await ctx.reply(
      `⏳ <i>Scanning ${accountCount} logged-in Swiggy IDs for the live tracking link…</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    try {
      const result = await ensureOrderTracking(order.id, { force: true, budgetMs: 20000, deep: true });
      if (scanMsg) { try { await ctx.telegram.deleteMessage(ctx.chat.id, scanMsg.message_id); } catch {} }

      const fresh = getDb().orders?.[order.id] || order;
      const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
      const swiggyId = String(fresh.swiggyOrderId || order.swiggyOrderId || '—');
      const phone = String(fresh.selectedAccountPhone || order.selectedAccountPhone || '');

      if (!trackingUrl) {
        if (result?.hasOrder) {
          const rawLiveStatus = String(fresh.liveOrderStatus || result.orderStatus || 'Order Confirmed');
          const liveStatus = rawLiveStatus;
          const cancelled = /cancel|refus|return/i.test(liveStatus);
          const delivered = !cancelled && /deliv/i.test(liveStatus);
          const deliveredUrl = delivered ? buildSignedOrderTrackUrl(fresh) : '';
          await ctx.reply(
            `✅ <b>${delivered && deliveredUrl ? 'Tracking link ready' : 'Order Swiggy par mil gaya'}</b>\n` +
            `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
            `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
            `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>` +
            (deliveredUrl ? `\n▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredUrl)}">Open order tracking</a>` : '') +
            (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '') +
            (fresh.deliveryBoyName || fresh.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([fresh.deliveryBoyName, fresh.deliveryBoyMobile].filter(Boolean).join(' · '))}` : '') +
            `\n\n` +
            (cancelled
              ? `<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`
              : delivered
                ? `<i>Order delivered hai — live order summary &amp; map link upar taiyaar hai.</i>`
                : `<i>Swiggy ne share link abhi publish nahi kiya. Bot background me retry karta rahega aur link aate hi bhej dega.</i>`),
            {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...(!cancelled
                ? Markup.inlineKeyboard([
                    ...(deliveredUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredUrl)]] : []),
                    [Markup.button.callback('🔄 Re-check Swiggy Link', `fwd_extract_all_${order.id}`)]
                  ])
                : {})
            }
          );
          if (!cancelled && !delivered) startOrderTrackingAuto(order.id, { force: true, budgetMs: 12000 });
        } else {
          await ctx.reply(
            `❌ <b>No tracking link found on any ID yet.</b>\n` +
            `▪ Scanned <b>${Number(result?.scanned) || 0}</b> IDs${result?.status === 'TIMEOUT' ? ' (time out)' : ''}\n` +
            `▪ Swiggy order id: <code>${escapeHtml(swiggyId)}</code>\n\n` +
            `<i>Swiggy may not have published it yet. Bot retry karta rahega — koi fake link nahi banaya jayega.</i>`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('↗ Add Swiggy tracking manually', `boss_tracking_${order.id}`)]]) }
          );
          startOrderTrackingAuto(order.id, { force: true, budgetMs: 12000 });
        }
        return;
      }

      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, fresh, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
      await sendOrderDeliveryInfoNotice(ctx.telegram, ctx.chat.id, fresh, { force: true });
      await ctx.reply(
        `✅ <b>Tracking extracted!</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open Swiggy tracking</a>` +
        (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : ''),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard([[Markup.button.url('↗ Open tracking', trackingUrl)]]) }
      );
    } catch (e) {
      if (scanMsg) { try { await ctx.telegram.deleteMessage(ctx.chat.id, scanMsg.message_id); } catch {} }
      await ctx.reply(`❌ Extract failed: ${escapeHtml(String(e?.message || e))}`, { parse_mode: 'HTML' });
    }
  });

  // =========================================================================
  // 8. LAZY BOSS AUTOPILOT — one forward, one tap, zero babysitting
  // =========================================================================
  // Boss forwards Ammi/Abbu's chat into the bot. From here he should only ever
  // need ONE tap: [ ✅ Confirm · for Ammi · ₹248 ]. Everything else
  // (fetch retry, best-ID fallback, tracking) self-heals in the background.
  const resolveLazyOrder = (ctx, orderId) => {
    const db = getDb();
    const order = lookupOrder(db, orderId);
    return { db, order };
  };
  const canOperateLazyOrder = (ctx, order) =>
    isBoss(ctx.from.id) ||
    String(order?.userId) === String(ctx.from.id) ||
    String(order?.fwdSenderUserId) === String(ctx.from.id);

  // 8A. ONE-TAP CONFIRM → official Swiggy QR (this IS the confirmation step)
  bot.action(/^lazy_confirm_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (_isLazyRateLimited(ctx.from.id, 5, 60_000)) return ctx.answerCbQuery('⏳ Thoda slow — 1 min me max 5 taps!', { show_alert: true }).catch(()=>{});
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    if (order.status === 'COMPLETED') return ctx.answerCbQuery('✓ This order is already paid and confirmed.', { show_alert: true });
    if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer ka bill approval pending hai — uske approve karne ke baad QR jayega.', { show_alert: true });
    }
    if (order.cardStage === 'QR_GENERATED' && order.activeQrMessageId) {
      return ctx.answerCbQuery('✓ Payment QR already bheja gaya hai — QR scan karke pay karein.', { show_alert: true });
    }
    if (!['BILL_READY', 'NEED_ACCOUNT', 'QR_GENERATED'].includes(order.cardStage)) {
      return ctx.answerCbQuery('! Pehle cart + address complete hone dein — bot abhi fetch kar raha hai.', { show_alert: true });
    }

    const who = recipientLabelOf(order);
    await ctx.answerCbQuery(`✅ Confirmed for ${who} — QR ban raha hai...`).catch(() => {});

    order.bossConfirmedAt = order.bossConfirmedAt || new Date().toISOString();
    order.bossConfirmedBy = String(ctx.from.id);
    order.bossConfirmedName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim() || 'Boss';
    order.confirmedRecipient = who;
    upsertOrder(order.id, order);

    const tgAdapter = typeof ctx.telegram?.sendPhoto === 'function'
      ? ctx.telegram
      : { ...ctx.telegram, sendPhoto: (_cid, photo, extra) => ctx.replyWithPhoto(photo, extra) };

    try {
      await executeRealQrGenerationForOrder({
        telegram: tgAdapter,
        chatId: ctx.chat.id,
        orderId,
        formatOrderBodyFn,
        customRealQrGenerator
      });
    } catch (err) {
      // Self-heal: transient account/WAF problems get one automatic re-pick +
      // one automatic QR retry before Boss hears about it.
      if (isRetryableFetchError(err)) {
        try {
          await autoAssignBestAccountWithFallback({ telegram: ctx.telegram, chatId: ctx.chat.id, orderId, formatOrderBodyFn });
          await executeRealQrGenerationForOrder({
            telegram: tgAdapter,
            chatId: ctx.chat.id,
            orderId,
            formatOrderBodyFn,
            customRealQrGenerator
          });
          return;
        } catch (retryErr) {
          err = retryErr;
        }
      }
      const freshDb = getDb();
      const freshOrder = freshDb.orders?.[orderId] || order;
      freshOrder.cardStage = 'NEED_ACCOUNT';
      freshOrder.accountSyncError = String(err?.message || err || 'QR generation failed').slice(0, 300);
      upsertOrder(freshOrder.id, freshOrder);
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, freshOrder, getDb(), formatOrderBodyFn).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'LAZY_CONFIRM_GENERATE_QR',
        orderId,
        accountKey: freshOrder.selectedAccount,
        senderName: freshOrder.fwdSenderName || freshOrder.userName,
        isForwarded: !freshOrder.isDirectBossOrder,
        cartLink: freshOrder.cart,
        addressSummary: freshOrder.address
      });
    }
  });

  // 8B. RETRY FETCH — replays the stored forward; Boss never re-sends anything
  bot.action(/^lazy_fetch_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    const rawText = String(order.lastIntakeRawText || '');
    const location = order.lastIntakeLocation || null;
    if (!rawText && !location) {
      return ctx.answerCbQuery('Original message stored nahi hai — cart link ya address dobara bhej dein.', { show_alert: true });
    }
    await ctx.answerCbQuery('↻ Retrying the same forward...').catch(() => {});

    try {
      const { updatedCart, updatedAddress } = await retryFetch(
        () => ingestForwardedContentIntoOrder(order, { rawText, location }),
        { attempts: 3, delays: [500, 1500] }
      );
      delete order._pendingCartSlot;
      delete order._pendingAddrSlot;
      const cartUnreadable = Boolean(order.cart && order.cartUnverified);
      const complete = Boolean(order.cart) && !cartUnreadable &&
        hasVerifiedDeliveryLocation(order) && hasVerifiedDeliveryContact(order);
      const progress = !cartUnreadable && Boolean(updatedCart || updatedAddress || order.cart || order.address);
      if (!progress) {
        order.cardStage = 'FETCH_FAILED';
        order.fetchError = 'Retry bhi fail hua — link expire ho sakta hai ya galat forward hai.';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        return;
      }
      delete order.fetchError;
      order.fetchFailedAt = '';
      if (complete) {
        order.cardStage = 'AUTO_SELECTING';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        await autoAssignBestAccountWithFallback({ telegram: ctx.telegram, chatId: ctx.chat.id, orderId, formatOrderBodyFn });
      } else {
        order.cardStage = 'COLLECTING';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
      }
    } catch (err) {
      order.cardStage = 'FETCH_FAILED';
      order.fetchError = String(err?.message || err).slice(0, 300);
      upsertOrder(order.id, order);
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
    }
  });

  // 8C. BEST ID DOBARA — walks the fallback ladder across every logged-in ID
  bot.action(/^lazy_best_id_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer approval ke baad ID change lock hai.', { show_alert: true });
    }
    const previous = order.selectedAccount;
    if (previous) releaseSwiggyAccountReservation(previous, orderId);
    order.selectedAccount = null;
    order.cardStage = 'AUTO_SELECTING';
    order.accountSyncError = '';
    order.lastAccountError = '';
    upsertOrder(order.id, order);
    await ctx.answerCbQuery('🔄 Best ID dobara dhoond raha hoon...').catch(() => {});
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: true }).catch(() => {});
    try {
      await autoAssignBestAccountWithFallback({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        orderId,
        formatOrderBodyFn,
        excludeAccountKeys: previous ? [previous] : []
      });
    } catch (err) {
      order.cardStage = 'NEED_ACCOUNT';
      order.accountSyncError = String(err?.message || err).slice(0, 300);
      upsertOrder(order.id, order);
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, { stage: 'LAZY_BEST_ID_RETRY', orderId });
    }
  });

  // 8D. TRACKING ABHI — force scan + always return something clickable
  bot.action(/^lazy_track_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    await ctx.answerCbQuery('🔗 Swiggy tracking dhoond raha hoon...').catch(() => {});

    let scan = null;
    try { scan = await ensureOrderTracking(orderId, { force: true, budgetMs: 20000, deep: true }); } catch {}
    const fresh = getDb().orders?.[orderId] || order;
    const delivery = resolveTrackingDelivery(fresh, { storedUrl: getStoredSwiggyTrackingUrl(fresh) });
    const swiggyId = String(fresh.swiggyOrderId || fresh.pendingSwiggyOrderId || '—');
    const otpLine = fresh.deliveryOtp ? `\n⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '';
    const header = delivery.isOfficial
      ? `✅ <b>Tracking link ready (#${escapeHtml(fresh.id)})</b>`
      : `◷ <b>Tracking abhi publish nahi hua (#${escapeHtml(fresh.id)})</b>`;

    await ctx.reply(
      `${header}\n` +
      `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      `▪ <b>${delivery.isOfficial ? 'Tracking' : 'Swiggy orders page'}:</b> <a href="${escapeHtml(delivery.url)}">Open</a>` +
      `${otpLine}\n\n` +
      `<i>${delivery.isOfficial ? 'Yeh Swiggy ka apna link hai.' : trackingRetryPromiseText(Number(fresh.trackingRetryCount) || 0)}</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([
          [Markup.button.url(delivery.isOfficial ? '↗ Open Swiggy tracking' : '↗ Swiggy My Orders', delivery.url)],
          [Markup.button.callback('↻ Tracking dobara check', lazyActionId('track', fresh.id))]
        ])
      }
    ).catch(() => {});
    if (!delivery.isOfficial) {
      try { startOrderTrackingAuto(fresh.id, { force: true, budgetMs: 12000 }); } catch {}
    }
  });
}

// =========================================================================
// Telegram button-driven update handler for Boss forwarded / direct orders
// =========================================================================
export async function applyBossOrderUpdate({
  telegram,
  bossChatId,
  orderId,
  cart = '',
  address = '',
  location = null,
  formatOrderBodyFn
}) {
  const db = getDb();
  const order = db?.orders?.[orderId];
  if (!order) return { ok: false, error: `Order #${orderId} not found.` };
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return { ok: false, error: `Order #${orderId} is ${order.status.toLowerCase()} and cannot be edited.` };
  }
  if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
    return { ok: false, error: 'The bill has been sent for approval or approved; ask the customer to report an issue before changing delivery details.' };
  }
  const swiggyCheckoutStarted = Boolean(order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.cardStage === 'QR_GENERATED');
  if (swiggyCheckoutStarted && (cart || address || location)) {
    return { ok: false, error: 'Cart and delivery details cannot be edited after Swiggy has created a payment QR/order. Resolve or cancel the existing Swiggy order first.' };
  }
  if (!cart && !address && !location) {
    return { ok: false, error: 'Send a cart link, delivery address, recipient mobile, or GPS pin.' };
  }

  let updatedCart = false;
  let updatedAddr = false;

  if (location) {
    try {
      const locationResult = await ingestForwardedContentIntoOrder(order, { location });
      if (locationResult.error) return { ok: false, error: locationResult.error };
      updatedAddr = Boolean(locationResult.updatedAddress);
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not resolve this delivery pin.' };
    }
  }

  if (cart && cart !== order.cart) {
    try {
      const resCart = await ingestForwardedContentIntoOrder(order, { rawText: cart });
      if (!resCart.updatedCart) {
        return { ok: false, error: 'Invalid Swiggy Cart link. Send a genuine Swiggy cart or group-cart link.' };
      }
      updatedCart = true;
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not verify this Swiggy cart link.' };
    }
  }

  if (address && address !== order.address && address !== order.addressOriginalText) {
    let resAddr;
    try {
      resAddr = await ingestForwardedContentIntoOrder(order, { rawText: address });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not verify these delivery details.' };
    }
    if (resAddr.error) return { ok: false, error: resAddr.error };
    if (!resAddr.updatedAddress && address.trim().length >= 12) {
      // Keep manually entered street addresses, but checkout remains blocked until
      // geocoding supplies verified coordinates and a separate recipient mobile.
      const plainGeo = await geocodeAddressDetails({ address: address.trim(), raw: address.trim() }).catch(() => ({ address: address.trim() }));
      order.address = plainGeo.address || address.trim();
      order.addressOriginalText = address.trim();
      order.addressDetails = plainGeo;
      updatedAddr = true;
    } else if (!resAddr.updatedAddress) {
      return { ok: false, error: 'Invalid delivery details. Send a Swiggy/Google Maps address, full street address, or the recipient’s 10-digit Indian mobile after the address is saved.' };
    } else {
      updatedAddr = true;
    }
  }

  upsertOrder(order.id, order);

  const readyForCheckout = Boolean(
    order.cart &&
    hasVerifiedDeliveryLocation(order) &&
    hasVerifiedDeliveryContact(order)
  );
  if (readyForCheckout) {
    try {
      await executeOrderBillSyncOnAccount({
        telegram,
        chatId: bossChatId,
        orderId: order.id,
        accKey: order.selectedAccount || 'BEST',
        formatOrderBodyFn
      });
      return {
        ok: true,
        message: 'Cart, verified Indian delivery location, and recipient mobile are ready. Swiggy bill and eligible offers are being checked.'
      };
    } catch (syncErr) {
      await postOrReplaceForwardedCard(telegram, bossChatId, order, getDb(), formatOrderBodyFn).catch(() => {});
      return {
        ok: true,
        message: `Delivery details saved. Manual account selection is ready: ${syncErr.message}`
      };
    }
  }

  await postOrReplaceForwardedCard(telegram, bossChatId, order, getDb(), formatOrderBodyFn).catch(() => {});
  const changes = [updatedCart ? 'Cart saved' : '', updatedAddr ? 'Delivery details saved' : ''].filter(Boolean);
  return {
    ok: true,
    message: changes.length ? `${changes.join(' and ')}. Check the refreshed order card for the next required detail.` : 'No order details changed.'
  };
}
