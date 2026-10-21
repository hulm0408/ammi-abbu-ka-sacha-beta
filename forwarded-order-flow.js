import crypto from 'crypto';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { Markup } from 'telegraf';
import { getDb, saveDb, upsertOrder, appendAuditEvent, maskAccountCode } from './store.js';
import {
  buildBossOrderPortalUrl,
  makeSmartPortalButton,
  buildCleanUserBillConfirmationCard
} from './order-ux-portal.js';
import { checkLoggedInFromCookies } from './swiggy-bridge.js';
import {
  resolveSwiggyLink,
  parseAddressDetails,
  reverseGeocodeCoords,
  geocodeAddressDetails,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  withSwiggyAccountLock,
  getBusySwiggyAccountsMap,
  releaseSwiggyAccountReservation,
  invalidateAccountOrderProfileCache,
  getSwiggySessionAuth,
  swiggyCartFlush,
  dapiFetch
} from './swiggy-cart.js';

function isValidCartInput(input) {
  const s = String(input || '').trim();
  if (!s) return false;
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

// Instant 0ms synchronous input classifier so burst multi-order intake pairs FIFO drafts cleanly without overwriting!
export function classifyRawOrderInputFast(rawText = '', location = null) {
  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    return { hasCart: false, hasAddress: true, primaryCartUrl: '' };
  }
  const s = String(rawText || '').trim();
  if (!s) return { hasCart: false, hasAddress: false, primaryCartUrl: '' };

  const allUrls = s.match(/https?:\/\/[^\s]+/gi)?.map(u => u.replace(/[.,;!?)]+$/, '')) || [];
  let hasCart = false;
  let hasAddress = false;
  let primaryCartUrl = '';

  for (const u of allUrls) {
    if (/(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u)) {
      hasAddress = true;
    } else if (/save my address on swiggy/i.test(s) && /onelink\.me\/jgkq\//i.test(u) && !/\/gc\//i.test(u)) {
      hasAddress = true;
    } else if (/(swiggy\.com|swig\.gy|onelink\.me)/i.test(u)) {
      // Distinguish Swiggy address share link from cart/group-cart link if whole text has `save my address`
      if (/\/gc\//i.test(u) || /shared_cart|menu|restaurants/i.test(u)) {
        hasCart = true;
        if (!primaryCartUrl) primaryCartUrl = u;
      } else if (!/save my address on swiggy/i.test(s)) {
        hasCart = true;
        if (!primaryCartUrl) primaryCartUrl = u;
      } else {
        hasAddress = true;
      }
    }
  }

  const textWithoutUrls = s.replace(/https?:\/\/[^\s]+/gi, ' ').trim();
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
  const s = String(rawText || '').trim();
  if (!s) return [];
  const gcMatches = [...s.matchAll(/https?:\/\/[^\s]*(?:swig\.gy\/gc\/|swiggy\.com\/[^\s]*group_cart)[^\s]*/gi)];
  if (gcMatches.length <= 1) return [s];

  // Look for natural paragraph splits where each segment carries its own cart link
  const segments = [];
  for (let i = 0; i < gcMatches.length; i++) {
    const curIdx = gcMatches[i].index;
    const nextIdx = i + 1 < gcMatches.length ? gcMatches[i + 1].index : s.length;
    // Check if address precedes cart link or follows cart link
    if (i === 0 && curIdx > 25) {
      // Format looks like `Address 1 \n Cart 1 \n\n Address 2 \n Cart 2 ...`
      const endOfCartLine = s.indexOf('\n', curIdx + gcMatches[i][0].length);
      const cutPoints = gcMatches.map((m, idx) => {
        const lineEnd = s.indexOf('\n', m.index + m[0].length);
        return idx === gcMatches.length - 1 ? s.length : (lineEnd === -1 ? m.index + m[0].length : lineEnd);
      });
      let start = 0;
      for (const end of cutPoints) {
        const chunk = s.slice(start, end).trim();
        if (chunk) segments.push(chunk);
        start = end;
      }
      return segments.length >= 2 ? segments : [s];
    }
    const seg = s.slice(curIdx, nextIdx).trim();
    if (seg) segments.push(seg);
  }
  return segments.length >= 2 ? segments : [s];
}

const activePaymentPollers = new Map();
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

export function getPublicAppBaseUrl() {
  const raw = process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://ammi-abbu-ka-sacha-beta.onrender.com';
  return String(raw).replace(/\/+$/, '');
}

export function computeTrackHmac(orderId) {
  const secret = process.env.BOT_TOKEN || 'ammi-abbu-ka-sacha-beta-secret';
  return crypto.createHmac('sha256', secret).update(`track:${orderId}`).digest('hex').slice(0, 24);
}

export function buildLiveShareableTrackUrl(orderId) {
  const base = getPublicAppBaseUrl();
  return `${base}/track/${encodeURIComponent(orderId)}?sig=${computeTrackHmac(orderId)}`;
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

  return (
    `❌ <b>Error Detected — Copy &amp; Send This Message Directly:</b>\n\n` +
    `<code>${escapeHtml(lines.join('\n'))}</code>`
  );
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

function buildSenderHeaderLine(order) {
  const senderLabel = escapeHtml(order.fwdSenderName || order.userName || 'Customer');
  const uname = order.fwdSenderUsername ? ` (@${escapeHtml(order.fwdSenderUsername)})` : '';
  const profileTag = order.fwdSenderUserId
    ? `<a href="tg://user?id=${order.fwdSenderUserId}">${senderLabel}</a>${uname}`
    : `<b>${senderLabel}</b>${uname}`;

  if (order.isDirectBossOrder) {
    return `👤 <b>Order For:</b> ${profileTag}`;
  }
  return `👤 <b>Forwarded From:</b> ${profileTag}`;
}

function summarizeAddressPreview(order) {
  const ad = order.addressDetails || parseAddressDetails(order.address);
  if (!ad) return escapeHtml(order.address || '');
  const parts = [];
  if (ad.city) parts.push(`<b>${escapeHtml(ad.city)}</b>`);
  if (ad.name) parts.push(escapeHtml(ad.name));
  if (ad.address) parts.push(escapeHtml(ad.address.replace(/\s+/g, ' ').trim()));
  if (ad.lat && ad.lng) parts.push(`(${ad.lat}, ${ad.lng})`);
  return parts.join(' • ') || escapeHtml(order.address || '');
}

function summarizeCartPreview(order) {
  if (order.restaurantName) {
    const cnt = order.items?.reduce((s, it) => s + Number(it.qty || it.quantity || 1), 0) || 0;
    const sub = order.subtotal ? ` • ₹${order.subtotal}` : '';
    return `<b>${escapeHtml(order.restaurantName)}</b>${cnt ? ` (${cnt} item${cnt > 1 ? 's' : ''}${sub})` : ''}`;
  }
  return `<code>${escapeHtml(String(order.cart || '').slice(0, 90))}</code>`;
}

export function getReadyOrdersWaitingForAccount(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      (o.cardStage === 'NEED_ACCOUNT' || (!o.selectedAccount && o.cardStage !== 'AUTO_SELECTING')) &&
      Boolean(o.cart) &&
      Boolean(o.address)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

export function getBillReadyOrdersWaitingForQr(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      o.cardStage === 'BILL_READY' &&
      Boolean(o.selectedAccount) &&
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
  const hasAddress = Boolean(order.address);
  const hasCart = Boolean(order.cart);
  const cancelBtn = Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`);

  // Stage 4A: Paid & Confirmed with REAL Live Tracking Links
  if (order.status === 'COMPLETED' && order.trackingLink) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const swiggyIdLine = order.swiggyOrderId
      ? `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(String(order.swiggyOrderId))}</code>\n`
      : '';
    const liveStatusLine = order.liveOrderStatus
      ? `\n📦 <b>Status:</b> ${escapeHtml(order.liveOrderStatus)}${order.etaMinutes ? ` • ⏱ <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} mins` : ''}`
      : '';
    const riderLine = order.deliveryBoyName
      ? `\n🏍 <b>Delivery Partner:</b> ${escapeHtml(order.deliveryBoyName)}${order.deliveryBoyMobile ? ` (<a href="tel:${escapeHtml(order.deliveryBoyMobile)}">${escapeHtml(order.deliveryBoyMobile)}</a>)` : ''}`
      : '';
    const shareUrl = order.shareTrackUrl || buildLiveShareableTrackUrl(order.id);
    const directSwiggyUrl = order.trackingLink;

    const text =
      `✅ <b>ORDER PAID &amp; CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n` +
      `${swiggyIdLine}` +
      `${liveStatusLine}${riderLine}\n\n` +
      `${bodyHtml}\n\n` +
      `🛵 <b>Live Tracking Link (Share with Customer — No Login Needed):</b>\n` +
      `<a href="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl)}</a>\n` +
      `🔗 <b>Swiggy Direct Link:</b> <a href="${escapeHtml(directSwiggyUrl)}">${escapeHtml(directSwiggyUrl)}</a>`;

    const buttons = [
      [Markup.button.url('🛵 Open Live Map Tracking', shareUrl)],
      [Markup.button.url('🟠 Open in Swiggy App/Web', directSwiggyUrl)],
      [cancelBtn]
    ];
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // Stage 4B (Screen 05): Paid Confirmed, Tracking Delayed -> Retry tracking ONLY, NEVER create 2nd QR!
  if (order.status === 'COMPLETED' && !order.trackingLink) {
    const paidAmt = Number(order.finalTotal || order.finalPayable || 0);
    const text =
      `✅ <b>Provider confirmed ₹${paidAmt} ✓</b>\n` +
      `<i>No second charge requested.</i>\n\n` +
      `<b>#${escapeHtml(order.id)} — ORDER SUMMARY</b> · 🟡 <b>Tracking delayed</b>\n` +
      `${senderLine}\n\n` +
      `🍽 <b>${escapeHtml(order.restaurantName || 'Swiggy Order')}</b>\n` +
      `<i>Swiggy did not return tracking yet. Retry tracking only.</i>\n\n` +
      `⚠️ <b>Paid is final. Retry tracking only.</b>\n` +
      `<i>🔒 Never create another payment QR.</i>`;

    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry tracking link', `fwd_retry_track_${order.id}`)],
        [makeSmartPortalButton('📱 Open Order Card ›', buildBossOrderPortalUrl(order.id))]
      ])
    };
  }

  // Stage 3: Account Selected & Live Bill Fetched -> [Generate QR] [Paid] [Parallel Batch Buttons] [Re-Scan Offers] [Switch Account] [Cancel]
  if (hasAddress && hasCart && (order.cardStage === 'BILL_READY' || order.cardStage === 'QR_GENERATED')) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const offerNotes = [];
    if (order.selectedAccount) {
      const accBadge = order.selectedAccountZeroOrders
        ? `🆕 <b>0-Order Swiggy ID</b>`
        : `🟢 <b>Free Swiggy ID (0 Active Orders)</b>`;
      offerNotes.push(
        `🎯 <b>Auto-Matched Account:</b> <code>${escapeHtml(String(order.orderAccount || order.selectedAccount))}</code> (${accBadge})`
      );
    }
    if (order.eventsClaimSummary) {
      const bfMsg = order.eventsClaimSummary.breakfastMsg;
      const lnMsg = order.eventsClaimSummary.lateNightMsg;
      if (bfMsg) offerNotes.push(`🍳 <b>Breakfast:</b> ${escapeHtml(bfMsg)}`);
      if (lnMsg) offerNotes.push(`🌙 <b>Late Night:</b> ${escapeHtml(lnMsg)}`);
    }
    if (Number(order.walletSplitPayAmount || 0) > 0) {
      offerNotes.push(`💰 <b>Wallet Split-Pay Ready:</b> ₹${order.walletSplitPayAmount} Swiggy Money auto-deducts from UPI QR!`);
    }
    if (order.offerDiagnostics) {
      offerNotes.push(`ℹ️ <i>${escapeHtml(order.offerDiagnostics)}</i>`);
    }
    const offerStrip = offerNotes.length > 0 ? `\n\n${offerNotes.join('\n')}` : '';
    const qrStatusNote = order.cardStage === 'QR_GENERATED'
      ? `\n\n🟢 <b>Official Swiggy Dynamic QR Active</b> (Swiggy Order <code>${escapeHtml(String(order.pendingSwiggyOrderId || ''))}</code> • Auto-detecting payment every 5s or tap <b>Paid</b>)`
      : '';
    const text =
      `🧾 <b>ORDER BILL READY (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `${bodyHtml}${offerStrip}${qrStatusNote}`;

    const readyForQrCount = getBillReadyOrdersWaitingForQr(db).length;
    const activeQrCount = getActiveQrOrdersWaitingForPayment(db).length;
    const rows = [
      [
        Markup.button.callback(
          order.cardStage === 'QR_GENERATED' ? '🔄 Regenerate Swiggy QR' : '🔳 Generate QR',
          `fwd_gen_qr_${order.id}`
        ),
        Markup.button.callback('✅ Paid', `fwd_check_paid_${order.id}`)
      ]
    ];
    if (readyForQrCount >= 2 && order.cardStage === 'BILL_READY') {
      rows.push([
        Markup.button.callback(
          `⚡ Generate All ${readyForQrCount} Ready QRs in Parallel`,
          `fwd_parallel_qrs_${order.id}`
        )
      ]);
    }
    if (activeQrCount >= 2) {
      rows.push([
        Markup.button.callback(
          `✅ Verify All ${activeQrCount} Active Payments Now`,
          `fwd_check_all_paid`
        )
      ]);
    }
    rows.push([
      Markup.button.callback('🎁 Re-Scan Max Offer', `fwd_rescan_max_${order.id}`),
      Markup.button.callback('🔄 Change Account', `fwd_rechoose_acc_${order.id}`)
    ]);
    rows.push([
      ...(order.fwdSenderUserId && !order.isDirectBossOrder
        ? [Markup.button.callback('📤 Send Bill Summary ›', `fwd_send_summary_${order.id}`)]
        : []),
      makeSmartPortalButton('📝 Review / Edit Card ›', buildBossOrderPortalUrl(order.id))
    ]);
    rows.push([cancelBtn]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // Stage 2A: Instant Parallel Auto-Account Selection (`0-Order ID` + `Max Offer`) In Progress!
  if (hasAddress && hasCart && order.cardStage === 'AUTO_SELECTING') {
    const text =
      `⚡ <b>AUTO-SELECTING BEST 0-ORDER SWIGGY ID (#${escapeHtml(order.id)})...</b>\n` +
      `${senderLine}\n\n` +
      `📍 <b>Address:</b> ${summarizeAddressPreview(order)}\n` +
      `🛒 <b>Cart:</b> ${summarizeCartPreview(order)}\n\n` +
      `<i>🚀 Finding free 0-Order Swiggy ID + applying Maximum Coupon, Item Offers, Free Cash &amp; Free Delivery in parallel...</i>`;
    return { text, keyboard: Markup.inlineKeyboard([[cancelBtn]]) };
  }

  // Stage 2B: Manual Multi-ID Account Chooser (FREE vs BUSY vs Re-Login — also accessible via `🔄 Change Account`)
  if (hasAddress && hasCart) {
    order.cardStage = 'NEED_ACCOUNT';
    const busyMap = getBusySwiggyAccountsMap(db, order.id);
    const allLoggedAccounts = Object.entries(db?.config?.accounts || {}).filter(([, a]) => a.isLoggedIn && (a.cookies || a.tid));

    // Sort: 🆕 Valid + 0-Orders + FREE -> 🟢 Valid & FREE -> 🟡 Valid & BUSY -> ⚠️ Missing `_session_tid`
    const sortedAccounts = [...allLoggedAccounts].sort(([ka, a], [kb, b]) => {
      const validA = hasLiveWebSessionCookie(a) ? 1 : 0;
      const validB = hasLiveWebSessionCookie(b) ? 1 : 0;
      if (validA !== validB) return validB - validA;
      const busyA = busyMap.has(ka) ? 1 : 0;
      const busyB = busyMap.has(kb) ? 1 : 0;
      if (busyA !== busyB) return busyA - busyB;
      const zeroA = a.isZeroOrderAccount || a.totalOrdersCount === 0 ? 1 : 0;
      const zeroB = b.isZeroOrderAccount || b.totalOrdersCount === 0 ? 1 : 0;
      return zeroB - zeroA;
    });

    const freeValidCount = sortedAccounts.filter(([k, a]) => hasLiveWebSessionCookie(a) && !busyMap.has(k)).length;
    const readyOrders = getReadyOrdersWaitingForAccount(db);

    const rows = [];
    if (readyOrders.length >= 2) {
      rows.push([
        Markup.button.callback(
          `⚡ Fetch All ${readyOrders.length} Ready Orders Now (Parallel Multi-ID)`,
          `fwd_parallel_fetch_all`
        )
      ]);
    }
    if (sortedAccounts.length > 0) {
      rows.push([
        Markup.button.callback(
          `🏆 Auto-Pick Best FREE 0-Order Account (${freeValidCount} Free / ${sortedAccounts.length} IDs)`,
          `fwd_pick_acc_${order.id}__BEST`
        )
      ]);
      for (const [k, a] of sortedAccounts) {
        const cleanName = String(a.name || 'Account').replace(/\s*\(\d{10}\)\s*$/g, '').trim();
        const phoneStr = a.phone ? ` (${a.phone})` : '';
        const webOk = hasLiveWebSessionCookie(a);
        const busyOrder = busyMap.get(k);
        const zeroTag = (a.isZeroOrderAccount || a.totalOrdersCount === 0) ? '🆕 0-Order • ' : '';
        let badge = `${zeroTag}🟢 FREE`;
        if (!webOk) {
          badge = '⚠️ Re-Login OTP';
        } else if (busyOrder) {
          badge = `🟡 Busy #${busyOrder.id}`;
        }
        rows.push([
          Markup.button.callback(
            `${badge} • ${cleanName}${phoneStr}`,
            `fwd_pick_acc_${order.id}__${k}`
          )
        ]);
      }
    }
    rows.push([cancelBtn]);

    const noAccWarn = sortedAccounts.length === 0
      ? `\n\n⚠️ <i>No Swiggy account is logged in right now — log in from Boss Panel first.</i>`
      : '';

    const multiHint = readyOrders.length >= 2
      ? `\n⚡ <b>${readyOrders.length} orders ready!</b> Tap individual IDs simultaneously without waiting, or tap <b>Fetch All ${readyOrders.length} Ready Orders Now</b>!`
      : `\n⚡ <i>Multi-ID Parallel Ready: ${freeValidCount} ID(s) FREE for simultaneous order fetching &amp; placing!</i>`;

    const text =
      `📋 <b>ORDER READY — CHOOSE SWIGGY ACCOUNT (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `📍 <b>Address:</b> ${summarizeAddressPreview(order)}\n` +
      `🛒 <b>Cart:</b> ${summarizeCartPreview(order)}\n\n` +
      `👇 <b>Select which Swiggy ID to fetch Final Bill &amp; apply Max Coupon:</b>` +
      `${multiHint}${noAccWarn}`;

    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // Stage 1: Partial Card (Waiting for missing Cart or missing Address)
  order.cardStage = 'COLLECTING';
  const addrStatus = hasAddress
    ? `✅ ${summarizeAddressPreview(order)}`
    : `⏳ <i>Waiting — send Address link / text / GPS pin</i>`;
  const cartStatus = hasCart
    ? `✅ ${summarizeCartPreview(order)}\n🔗 <code>${escapeHtml(String(order.cart).slice(0, 95))}</code>`
    : `⏳ <i>Waiting — send Swiggy Cart / Group Order link</i>`;

  const missingItem = !hasAddress ? 'Address' : 'Cart link';
  const actionHint = order.isDirectBossOrder
    ? `💡 Send ${missingItem} next — this card will auto-replace cleanly!`
    : `💡 Forward ${escapeHtml(order.fwdSenderName)}'s ${missingItem} next — this card will auto-replace cleanly!`;

  const text =
    `📩 <b>NEW ORDER CARD (#${escapeHtml(order.id)})</b>\n` +
    `${senderLine}\n\n` +
    `📍 <b>Address:</b>\n${addrStatus}\n\n` +
    `🛒 <b>Cart:</b>\n${cartStatus}\n\n` +
    `<i>${actionHint}</i>\n` +
    `<i>🔒 No account allocated; QR is blocked.</i>`;

  const portalBtnLabel = !hasAddress && hasCart
    ? '📍 Enter Missing Address & Verify ›'
    : (hasAddress && !hasCart ? '🛒 Enter Missing Cart & Verify ›' : '📝 Open Cart + Address Verify Box ›');

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [makeSmartPortalButton(portalBtnLabel, buildBossOrderPortalUrl(order.id))],
      [cancelBtn]
    ])
  };
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
    const geo = await reverseGeocodeCoords(location.latitude, location.longitude);
    const formatted = geo?.formattedAddress || `GPS Pin (${location.latitude}, ${location.longitude})`;
    order.address = formatted;
    order.addressOriginalText = formatted;
    order.addressDetails = {
      name: order.fwdSenderName || order.userName || '',
      mobile: order.addressDetails?.mobile || '',
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

  const allUrls = trimmed.match(/https?:\/\/[^\s]+/gi)?.map(u => u.replace(/[.,;!?)]+$/, '')) || [];
  const swiggyUrls = allUrls.filter(u => /(swiggy\.com|swig\.gy|onelink\.me)/i.test(u));
  const mapsUrls = allUrls.filter(u => /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u));

  // Pre-extract plain-text street address BEFORE `Promise.all` so links + geocoding run 100% concurrently!
  const textWithoutUrlsEarly = trimmed.replace(/https?:\/\/[^\s]+/gi, ' ').trim();
  const earlyPlainAd =
    allUrls.length === 0 && !isValidCartInput(trimmed) && isValidAddressInput(trimmed)
      ? parseAddressDetails(trimmed)
      : textWithoutUrlsEarly.length >= 12 && isValidAddressInput(textWithoutUrlsEarly)
        ? parseAddressDetails(textWithoutUrlsEarly)
        : null;
  const firstAccEarly = earlyPlainAd && (!earlyPlainAd.lat || !earlyPlainAd.lng)
    ? Object.values(getDb()?.config?.accounts || {}).find(a => a?.isLoggedIn && (a.cookies || a.tid || a.token)) || null
    : null;

  // Resolve ALL links + plain-text street address geocoding IN ONE SINGLE PARALLEL BATCH!
  // If `earlyPlainAd?.address` is already extracted from plain text (e.g. `Save my address on Swiggy... Address: ...`),
  // skip external HTTP hop on `onelink.me/JgkQ` (`0ms` instead of `1.9s`!) and reuse `preGeocodedPlainAd` directly!
  const [resolvedSwiggyList, resolvedMapsList, preGeocodedPlainAd] = await Promise.all([
    Promise.all(
      swiggyUrls.map(url =>
        earlyPlainAd?.address && /onelink\.me\/jgkq\//i.test(url) && !/\/gc\//i.test(url)
          ? Promise.resolve({ url, resolved: { linkType: 'ADDRESS' } })
          : resolveSwiggyLink(url).then(resolved => ({ url, resolved }))
      )
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
      (/save my address on swiggy/i.test(trimmed) && !/\/gc\//i.test(url));

    if (looksLikeAddressShare) {
      const ad = preGeocodedPlainAd || parseAddressDetails(trimmed) || resolved?.addressDetails || parseAddressDetails(url);
      order.address = trimmed;
      order.addressOriginalText = trimmed;
      if (ad) {
        delete ad.id;
        if (!ad.name && order.fwdSenderName) ad.name = order.fwdSenderName;
        order.addressDetails = ad;
      }
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
    const ad = resolved?.addressDetails || parseAddressDetails(trimmed);
    order.address = trimmed;
    order.addressOriginalText = trimmed;
    if (ad) {
      delete ad.id;
      if (!ad.name && order.fwdSenderName) ad.name = order.fwdSenderName;
      order.addressDetails = ad;
    } else {
      order.address = mUrl;
    }
    updatedAddress = true;
  }

  if (!updatedCart && !updatedAddress) {
    if (isValidCartInput(trimmed)) {
      order.cart = trimmed;
      updatedCart = true;
    } else if (isValidAddressInput(trimmed)) {
      const ad = preGeocodedPlainAd || parseAddressDetails(trimmed);
      order.address = trimmed;
      order.addressOriginalText = trimmed;
      if (ad) {
        delete ad.id;
        if (!ad.name && order.fwdSenderName) ad.name = order.fwdSenderName;
        order.addressDetails = ad;
      }
      updatedAddress = true;
    }
  } else if (updatedCart && !updatedAddress) {
    const textWithoutUrls = trimmed.replace(/https?:\/\/[^\s]+/gi, ' ').trim();
    if (textWithoutUrls.length >= 12 && isValidAddressInput(textWithoutUrls)) {
      const ad = preGeocodedPlainAd || parseAddressDetails(textWithoutUrls);
      if (ad && (ad.address || ad.lat || /\d{6}/.test(textWithoutUrls))) {
        delete ad.id;
        if (!ad.name && order.fwdSenderName) ad.name = order.fwdSenderName;
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
    const usedAccObj = curDb?.config?.accounts?.[order.selectedAccount];
    if (usedAccObj) {
      usedAccObj.isZeroOrderAccount = false;
      usedAccObj.cachedTotalOrdersCount = Number(usedAccObj.cachedTotalOrdersCount || 0) + 1;
    }
  }

  order.status = 'COMPLETED';
  order.cardStage = 'PAID_CONFIRMED';
  order.swiggyOrderId = String(livePaidResult.swiggyOrderId || order.pendingSwiggyOrderId || '');
  order.liveOrderStatus = livePaidResult.orderStatus || 'Order Confirmed';
  order.etaMinutes = livePaidResult.etaMinutes || order.etaMinutes || '';
  order.deliveryBoyName = livePaidResult.deliveryBoy?.name || '';
  order.deliveryBoyMobile = livePaidResult.deliveryBoy?.mobile || '';
  if (livePaidResult.restaurantName) order.restaurantName = livePaidResult.restaurantName;

  order.shareTrackUrl = buildLiveShareableTrackUrl(order.id);
  order.trackingLink =
    livePaidResult.nativeShareUrl ||
    livePaidResult.swiggyWebTrackUrl ||
    `https://www.swiggy.com/track-order/${order.swiggyOrderId}`;
  order.paidAt = new Date().toISOString();

  await deleteOrderBotMessages(telegram, chatId, order, { includeQr: true });
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
  return sent;
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
  formatOrderBodyFn
}) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) throw new Error(`Order #${orderId} not found.`);

  let syncRes = null;
  if (accKey === 'BEST') {
    syncRes = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });
    if (!syncRes?.success) {
      const err = new Error(syncRes?.error || 'Could not sync cart across logged-in accounts.');
      err.diag = { code: 'BEST_ACCOUNT_SYNC_FAILED', stage: 'PICK_BEST_ACCOUNT', comparison: syncRes?.accountComparison };
      throw err;
    }
  } else {
    const acc = db.config?.accounts?.[accKey];
    if (!acc || !acc.isLoggedIn || (!acc.cookies && !acc.tid)) {
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

  const usedAcc = getDb().config?.accounts?.[order.selectedAccount];
  if (usedAcc) {
    const authSnap = await getSwiggySessionAuth(usedAcc).catch(() => null);
    const latestExisting = authSnap?.orders?.[0]?.order_id;
    order.baselineSwiggyOrderId = latestExisting ? String(latestExisting) : '';
  }

  const freshDb = getDb();
  freshDb.orders[order.id] = order;
  await postOrReplaceForwardedCard(telegram, chatId, order, freshDb, formatOrderBodyFn, { includeQrDelete: true });
  return order;
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
  const order = db.orders?.[orderId];
  if (!order) throw new Error(`Order #${orderId} not found.`);
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
    `🔳 <b>OFFICIAL SWIGGY DYNAMIC PAYMENT QR (#${escapeHtml(order.id)})</b>\n` +
    `👤 <b>Order For:</b> ${senderTag}\n` +
    `🍽 <b>Restaurant:</b> ${restTag}\n` +
    `💰 <b>Exact Swiggy Amount:</b> ₹${payable}\n` +
    `🆔 <b>Swiggy Checkout Order ID:</b> <code>${escapeHtml(order.pendingSwiggyOrderId)}</code>\n` +
    `📱 <b>Swiggy Account:</b> <code>${escapeHtml(truncateDisplayField(acc.phone || order.selectedAccount, 40))}</code>\n\n` +
    `<i>✅ 100% Real Swiggy Merchant Dynamic QR — Pay from GPay / PhonePe / Paytm to place order directly on Swiggy! Auto-detecting payment every 5s...</i>`;
  const qrSent = await sendPhotoFn(
    chatId,
    { source: qrBuffer },
    {
      caption: safeTelegramCaption(rawQrCaption, 1000),
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Paid (Verify & Get Live Tracking)', `fwd_check_paid_${order.id}`)],
        [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)]
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

    const willHaveBoth = Boolean(order.cart || order._pendingCartSlot) && Boolean(order.address || order._pendingAddrSlot);
    if (willHaveBoth && shouldAutoSelect) {
      order.cardStage = 'AUTO_SELECTING';
    }
    upsertOrder(order.id, order);
    allocatedOrderId = order.id;
  });

  // Phase 2 (PER-ORDER LOCK ONLY — ALL 10 INDEPENDENT ORDERS EXECUTE 100% CONCURRENTLY AT THE EXACT SAME MILLISECOND!):
  const runOrderPipeline = withOrderIngestLock(allocatedOrderId, async () => {
    const db0 = getDb();
    const order = db0.orders?.[allocatedOrderId];
    if (!order) return;

    try {
      const { updatedCart, updatedAddress } = await ingestForwardedContentIntoOrder(order, { rawText, location });
      if (updatedCart) delete order._pendingCartSlot;
      if (updatedAddress) delete order._pendingAddrSlot;

      if (!updatedCart && !updatedAddress) {
        delete order._pendingCartSlot;
        delete order._pendingAddrSlot;
        if (!order.cart && !order.address) {
          upsertOrder(order.id, null);
        } else {
          if (order.cardStage === 'AUTO_SELECTING') order.cardStage = 'COLLECTING';
          upsertOrder(order.id, order);
        }
        await ctx.reply(
          `⚠️ <b>Could not detect a valid Swiggy Cart link or Delivery Address</b> in <b>${escapeHtml(sender.senderName)}</b>'s message.\n` +
          `<i>Send a Swiggy Cart link, Address share text/link, Google Maps link, street address, or GPS location pin.</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const completeNow = Boolean(order.cart) && Boolean(order.address);
      if (completeNow && shouldAutoSelect) {
        order.cardStage = 'AUTO_SELECTING';
        upsertOrder(order.id, order);
        const freshDb = getDb();
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, freshDb, formatOrderBodyFn);

        const targetOrderId = order.id;
        const targetChatId = ctx.chat.id;
        try {
          await executeOrderBillSyncOnAccount({
            telegram: ctx.telegram,
            chatId: targetChatId,
            orderId: targetOrderId,
            accKey: 'BEST',
            formatOrderBodyFn
          });
          if (shouldAutoQr) {
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
          }
        } catch (syncErr) {
          const errDb = getDb();
          const failedOrd = errDb.orders?.[targetOrderId] || order;
          releaseSwiggyAccountReservation(failedOrd.selectedAccount, targetOrderId);
          failedOrd.cardStage = 'NEED_ACCOUNT';
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
        upsertOrder(order.id, null);
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
    await ctx.answerCbQuery('⚡ Fetching ALL ready orders across separate FREE Swiggy IDs in parallel...');
    try {
      const out = await dispatchAllReadyOrdersInParallel({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        formatOrderBodyFn
      });
      if (out.dispatched === 0) {
        return ctx.reply(`ℹ️ ${escapeHtml(out.reason)}`, { parse_mode: 'HTML' });
      }
      const failed = out.settled.filter(s => s.status === 'rejected');
      for (const f of failed) {
        await sendBossDiagnosticError(ctx, ctx.chat.id, f.reason, {
          stage: 'PARALLEL_MULTI_ORDER_FETCH'
        });
      }
      const okCount = out.settled.filter(s => s.status === 'fulfilled').length;
      await ctx.reply(
        `⚡ <b>Parallel Multi-ID Sync Complete:</b> <b>${okCount}/${out.dispatched}</b> order bill(s) fetched simultaneously on separate Swiggy IDs!` +
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
    await ctx.answerCbQuery(`⚡ Generating ${readyForQr.length} Official Swiggy QRs in parallel...`);
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
    await ctx.answerCbQuery(`⚡ Checking all ${activeQrs.length} active payments in parallel...`);
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
      `✅ <b>Parallel Payment Check Complete:</b> <b>${paidCount}/${activeQrs.length}</b> order(s) confirmed &amp; tracking extracted!` +
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
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });

    // Protect active unpaid orders on busy IDs unless explicitly confirmed with FORCE!
    if (accKey !== 'BEST' && !forceUse) {
      const busyMap = getBusySwiggyAccountsMap(db, orderId);
      const conflictOrder = busyMap.get(accKey);
      if (conflictOrder) {
        const acc = db.config?.accounts?.[accKey];
        await ctx.answerCbQuery(`⚠️ ${acc?.phone || accKey} is currently holding Order #${conflictOrder.id}!`, { show_alert: true });
        return ctx.editMessageText(
          `⚠️ <b>Account Busy Warning (#${escapeHtml(orderId)})</b>\n\n` +
          `Swiggy ID <b>${escapeHtml(acc?.name || accKey)} (${escapeHtml(acc?.phone || '')})</b> currently holds active unpaid order <b>#${escapeHtml(conflictOrder.id)}</b> (${escapeHtml(conflictOrder.fwdSenderName || conflictOrder.userName || 'Customer')} • ₹${conflictOrder.finalPayable || 0}).\n\n` +
          `Pick another <b>🟢 FREE</b> Swiggy ID to run both orders simultaneously at the same time, or force-override this ID:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Pick Another 🟢 FREE Swiggy ID', `fwd_rechoose_acc_${orderId}`)],
              [Markup.button.callback(`⚡ Force Override ${acc?.phone || accKey}`, `fwd_pick_acc_${orderId}__${accKey}__FORCE`)],
              [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${orderId}`)]
            ])
          }
        ).catch(() => {});
      }
    }

    await ctx.answerCbQuery(`⏳ Syncing on ${accKey === 'BEST' ? 'Best FREE Account (Parallel)' : accKey}...`);
    await ctx.editMessageText(
      `⏳ <b>Fetching Live Swiggy Bill &amp; Applying Max Coupon (#${escapeHtml(orderId)})...</b>\n` +
      `${buildSenderHeaderLine(order)}\n\n` +
      `<i>Syncing on <code>${escapeHtml(accKey)}</code> — other Swiggy IDs remain 100% free &amp; parallel!</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Order', `fwd_cancel_${orderId}`)]])
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

  // 2. Switch Swiggy Account before payment
  bot.action(/^fwd_rechoose_acc_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    stopOrderPaymentPoller(orderId);
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });

    if (order.selectedAccount) {
      releaseSwiggyAccountReservation(order.selectedAccount, orderId);
    }
    order.cardStage = 'NEED_ACCOUNT';
    upsertOrder(order.id, order);
    await ctx.answerCbQuery('Select Swiggy account');
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: true });
  });

  // 3. Generate 100% REAL Swiggy Dynamic Merchant UPI QR (parallel across distinct Swiggy IDs!)
  bot.action(/^fwd_gen_qr_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });

    await ctx.answerCbQuery('⚡ Generating Official Swiggy Payment QR...');
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
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });

    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('⚠️ Selected Swiggy account is not logged in!', { show_alert: true });
    }

    try {
      const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
      const liveCheck = await checker(acc, order);

      if (!liveCheck?.paid) {
        const stateLabel = liveCheck?.txnState === 'pending' || !liveCheck?.txnState
          ? 'Payment is processing'
          : `Payment status: ${liveCheck.txnState}`;
        await ctx.answerCbQuery(
          `⏳ ${stateLabel}... Order will confirm automatically as soon as UPI payment completes!`,
          { show_alert: true }
        );
        return;
      }

      await ctx.answerCbQuery('✅ Payment Verified on Swiggy! Extracting live tracking link...');
      await finalizePaidOrderCard({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        order,
        livePaidResult: liveCheck,
        formatOrderBodyFn
      });
    } catch (err) {
      await ctx.answerCbQuery('❌ Error while checking payment — diagnostic sent!', { show_alert: true }).catch(() => {});
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

  // 5. Cancel Order at ANY Stage (immediately frees that Swiggy ID back to `🟢 FREE`!)
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
      `❌ <b>Order Cancelled (#${escapeHtml(order.id)})</b> — ${buildSenderHeaderLine(order)}` +
      (freedAcc ? `\n🟢 <i>Account ${escapeHtml(freedAcc.phone || freedAccKey)} is now FREE for new orders!</i>` : ''),
      { parse_mode: 'HTML' }
    );
  });

  // 6. Force Re-Scan Max Coupon + Breakfast/Late Night Free Cash on Current Account
  bot.action(/^fwd_rescan_max_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    const accKey = order.selectedAccount;
    const acc = accKey ? db.config?.accounts?.[accKey] : null;
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('⚠️ Select a logged-in Swiggy account first!', { show_alert: true });
    }
    await ctx.answerCbQuery('🎁 Re-claiming Free Cash & testing all Max Coupons...').catch(() => {});
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
  bot.action(/^fwd_send_summary_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    const targetUserId = order.fwdSenderUserId || order.userId;
    if (!targetUserId) {
      return ctx.answerCbQuery('Customer chat ID not available — share portal link instead.', { show_alert: true });
    }
    order.status = 'APPROVAL_PENDING';
    order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
    upsertOrder(order.id, order);
    const summaryView = buildCleanUserBillConfirmationCard({ ...order, userId: targetUserId });
    await ctx.telegram.sendMessage(targetUserId, summaryView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...summaryView.keyboard
    });
    await ctx.answerCbQuery('✅ Bill summary sent — awaiting explicit approval!');
  });

  // 8. Screen 05: Paid Is Final -> Retry Tracking Link ONLY (NEVER creates another payment QR!)
  bot.action(/^fwd_retry_track_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    if (acc && order.swiggyOrderId) {
      const trkRes = await dapiFetch(acc, `order/trackV4?order_id=${encodeURIComponent(order.swiggyOrderId)}&type=full&version=V2`).catch(() => null);
      if (trkRes?.json?.data) {
        order.trackingLink = `https://www.swiggy.com/track-order/${order.swiggyOrderId}`;
        order.shareTrackUrl = buildLiveShareableTrackUrl(order.id);
        order.liveOrderStatus = trkRes.json.data?.order_status || 'Order Placed';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: false });
        return ctx.answerCbQuery('✅ Live tracking link ready!');
      }
    }
    return ctx.answerCbQuery('⏳ Swiggy has not published tracking yet — safe to retry anytime.', { show_alert: true });
  });
}

// =========================================================================
// LIVE TWO-BOX [VERIFY] HANDLER FOR BOSS FORWARDED / DIRECT ORDERS
// =========================================================================
export async function applyBossPortalVerification({
  telegram,
  bossChatId,
  orderId,
  cart = '',
  address = '',
  formatOrderBodyFn
}) {
  const db = getDb();
  const order = db?.orders?.[orderId];
  if (!order) return { ok: false, error: `Order #${orderId} not found.` };
  if (!cart && !address) {
    return { ok: false, error: 'Please fill at least one box before clicking Verify.' };
  }

  let updatedCart = false;
  let updatedAddr = false;

  if (cart && cart !== order.cart) {
    const resCart = await ingestForwardedContentIntoOrder(order, { rawText: cart });
    if (!resCart.updatedCart && !order.cart) {
      return { ok: false, error: 'Invalid Swiggy Cart link — paste a valid https://swig.gy/gc/... or Swiggy cart link.' };
    }
    updatedCart = true;
  }

  if (address && address !== order.address && address !== order.addressOriginalText) {
    const resAddr = await ingestForwardedContentIntoOrder(order, { rawText: address });
    if (!resAddr.updatedAddress && address.trim().length >= 12) {
      // Accept clean street address typed directly in the Boss form box
      const plainGeo = await geocodeAddressDetails({ address: address.trim(), raw: address.trim() }).catch(() => ({ address: address.trim() }));
      order.address = plainGeo.address || address.trim();
      order.addressOriginalText = address.trim();
      order.addressDetails = plainGeo;
      updatedAddr = true;
    } else if (!resAddr.updatedAddress && !order.address) {
      return { ok: false, error: 'Invalid Delivery Address — paste a Swiggy/Google Maps link or complete street address.' };
    } else {
      updatedAddr = true;
    }
  }

  upsertOrder(order.id, order);

  const hasBothNow = Boolean(order.cart && order.address);
  if (hasBothNow) {
    // Auto-select best unused 0-order account & fetch real Swiggy bill + max offer!
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
        message: 'Cart ✓ & Address ✓ verified — Live Swiggy Bill & Best Unused Account ready!'
      };
    } catch (syncErr) {
      await postOrReplaceForwardedCard(telegram, bossChatId, order, getDb(), formatOrderBodyFn).catch(() => {});
      return {
        ok: true,
        message: `Cart ✓ & Address ✓ saved (manual account select ready: ${syncErr.message}).`
      };
    }
  }

  await postOrReplaceForwardedCard(telegram, bossChatId, order, getDb(), formatOrderBodyFn).catch(() => {});
  return {
    ok: true,
    message: `${updatedCart ? 'Cart ✓' : 'Address ✓'} verified — fill the other box to complete!`
  };
}

