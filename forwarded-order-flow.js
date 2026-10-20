import crypto from 'crypto';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { Markup } from 'telegraf';
import { getDb, saveDb, upsertOrder } from './store.js';
import {
  resolveSwiggyLink,
  parseAddressDetails,
  reverseGeocodeCoords,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  withSwiggyAccountLock,
  getBusySwiggyAccountsMap,
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

const activePaymentPollers = new Map();
const senderIntakeLocks = new Map();

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
  return Boolean(acc?.isLoggedIn && String(acc?.cookies || '').includes('_session_tid='));
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
  const tokens = tokenizeBannerText(text).slice(0, maxChars);
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

export async function generateNamedUpiQrPngBuffer({ upiUri, senderName, amount, orderId }) {
  const qrRawBuf = await QRCode.toBuffer(upiUri, {
    type: 'png',
    width: 680,
    margin: 2,
    errorCorrectionLevel: 'M'
  });
  const qrPng = PNG.sync.read(qrRawBuf);

  const headerH = 118;
  const footerH = 104;
  const sidePad = 40;
  const outW = qrPng.width + sidePad * 2;
  const outH = headerH + qrPng.height + footerH;
  const out = new PNG({ width: outW, height: outH });

  fillRect(out, 0, 0, outW, outH, 255, 255, 255);
  fillRect(out, 0, 0, outW, headerH, 252, 128, 25);
  fillRect(out, 0, headerH - 6, outW, 6, 224, 98, 8);

  const cleanName = String(senderName || 'CUSTOMER').trim() || 'CUSTOMER';
  drawCenteredText(out, cleanName, 44, 4, 255, 255, 255);
  drawCenteredText(out, `OFFICIAL SWIGGY QR  #${orderId || ''}`, 90, 2, 255, 245, 232);

  PNG.bitblt(qrPng, out, 0, 0, qrPng.width, qrPng.height, sidePad, headerH);

  fillRect(out, 0, headerH + qrPng.height, outW, footerH, 248, 250, 252);
  fillRect(out, 28, headerH + qrPng.height + 6, outW - 56, 2, 226, 232, 240);
  drawCenteredText(out, `PAY ₹${amount}`, headerH + qrPng.height + 44, 4, 15, 23, 42);
  drawCenteredText(out, `AUTO PLACES ORDER ON SWIGGY`, headerH + qrPng.height + 84, 2, 22, 163, 74);

  return PNG.sync.write(out);
}

export function findIncompleteForwardedOrder(db, senderInfo) {
  if (!db?.orders || !senderInfo) return null;
  const candidates = Object.values(db.orders).filter(o => {
    if (!o || o.isForwardedOrder !== true) return false;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) return false;
    if (o.cardStage === 'BILL_READY' || o.cardStage === 'QR_GENERATED') return false;

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
  candidates.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
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
      o.cardStage === 'NEED_ACCOUNT' &&
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

export function buildForwardedOrderCardView(order, db, formatOrderBodyFn) {
  const senderLine = buildSenderHeaderLine(order);
  const hasAddress = Boolean(order.address);
  const hasCart = Boolean(order.cart);
  const cancelBtn = Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`);

  // Stage 4: Paid & Confirmed with REAL Live Tracking Links
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

  // Stage 3: Account Selected & Live Bill Fetched -> [Generate QR] [Paid] [Switch Account] [Cancel]
  if (hasAddress && hasCart && (order.cardStage === 'BILL_READY' || order.cardStage === 'QR_GENERATED')) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const qrStatusNote = order.cardStage === 'QR_GENERATED'
      ? `\n\n🟢 <b>Official Swiggy Dynamic QR Active</b> (Swiggy Order <code>${escapeHtml(String(order.pendingSwiggyOrderId || ''))}</code> • Auto-detecting payment every 5s or tap <b>Paid</b>)`
      : '';
    const text =
      `🧾 <b>ORDER BILL READY (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `${bodyHtml}${qrStatusNote}`;

    const readyForQrCount = getBillReadyOrdersWaitingForQr(db).length;
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
    rows.push([Markup.button.callback('🔄 Change Swiggy Account', `fwd_rechoose_acc_${order.id}`)]);
    rows.push([cancelBtn]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // Stage 2: Both Address + Cart Received -> Live Multi-ID Account Chooser (FREE vs BUSY vs Re-Login!)
  if (hasAddress && hasCart) {
    order.cardStage = 'NEED_ACCOUNT';
    const busyMap = getBusySwiggyAccountsMap(db, order.id);
    const allLoggedAccounts = Object.entries(db?.config?.accounts || {}).filter(([, a]) => a.isLoggedIn && (a.cookies || a.tid));

    // Sort: 🟢 Valid & FREE first -> 🟡 Valid & BUSY second -> ⚠️ Missing `_session_tid` third
    const sortedAccounts = [...allLoggedAccounts].sort(([ka, a], [kb, b]) => {
      const validA = hasLiveWebSessionCookie(a) ? 1 : 0;
      const validB = hasLiveWebSessionCookie(b) ? 1 : 0;
      if (validA !== validB) return validB - validA;
      const busyA = busyMap.has(ka) ? 1 : 0;
      const busyB = busyMap.has(kb) ? 1 : 0;
      return busyA - busyB;
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
          `🏆 Auto-Pick Best FREE Account (${freeValidCount} Free / ${sortedAccounts.length} IDs)`,
          `fwd_pick_acc_${order.id}__BEST`
        )
      ]);
      for (const [k, a] of sortedAccounts) {
        const cleanName = String(a.name || 'Account').replace(/\s*\(\d{10}\)\s*$/g, '').trim();
        const phoneStr = a.phone ? ` (${a.phone})` : '';
        const webOk = hasLiveWebSessionCookie(a);
        const busyOrder = busyMap.get(k);
        let badge = '🟢 FREE';
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
    `<i>${actionHint}</i>`;

  return { text, keyboard: Markup.inlineKeyboard([[cancelBtn]]) };
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

  // Resolve ALL links in the message IN PARALLEL!
  const [resolvedSwiggyList, resolvedMapsList] = await Promise.all([
    Promise.all(swiggyUrls.map(url => resolveSwiggyLink(url).then(resolved => ({ url, resolved })))),
    Promise.all(mapsUrls.map(mUrl => resolveSwiggyLink(mUrl).then(resolved => ({ mUrl, resolved }))))
  ]);

  for (const { url, resolved } of resolvedSwiggyList) {
    const looksLikeAddressShare =
      resolved?.linkType === 'ADDRESS' ||
      Boolean(resolved?.addressDetails) ||
      (/save my address on swiggy/i.test(trimmed) && !/\/gc\//i.test(url));

    if (looksLikeAddressShare) {
      const ad = parseAddressDetails(trimmed) || resolved?.addressDetails || parseAddressDetails(url);
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
      order.cart = url;
      if (resolved?.restaurantId) order.restaurantId = resolved.restaurantId;
      if (resolved?.restaurantName) order.restaurantName = resolved.restaurantName;
      if (resolved?.cartDetails?.items?.length) {
        order.items = resolved.cartDetails.items;
        order.subtotal = resolved.cartDetails.subtotal || 0;
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
      const ad = parseAddressDetails(trimmed);
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
      const ad = parseAddressDetails(textWithoutUrls);
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
  if (usedAcc?.cookies) {
    const allRes = await dapiFetch(usedAcc, 'order/all').catch(() => null);
    const latestExisting = allRes?.json?.data?.orders?.[0]?.order_id;
    order.baselineSwiggyOrderId = latestExisting ? String(latestExisting) : '';
  }

  const freshDb = getDb();
  freshDb.orders[order.id] = order;
  await postOrReplaceForwardedCard(telegram, chatId, order, freshDb, formatOrderBodyFn, { includeQrDelete: true });
  return order;
}

// Shared helper to generate REAL Swiggy Dynamic QR for a single order (safe for `Promise.all` across multiple IDs!)
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

  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  if (!acc || !acc.isLoggedIn) {
    const err = new Error('Selected Swiggy account session is missing or logged out.');
    err.diag = { code: 'QR_ACCOUNT_MISSING', stage: 'GENERATE_REAL_SWIGGY_QR' };
    throw err;
  }

  const generator = customRealQrGenerator || generateRealSwiggyMerchantUpiQr;
  const realQr = await generator(acc, order);
  const payable = Number(realQr.amount || order.finalPayable || 0);
  if (payable > 0) order.finalPayable = payable;

  order.pendingSwiggyUpiUri = realQr.upiIntentUrl;
  order.pendingSwiggyOrderId = String(realQr.swiggyOrderId || '');
  order.pendingSwiggyPaasId = String(realQr.paymentTxnId || '');
  if (realQr.slaMinutes) order.etaMinutes = String(realQr.slaMinutes);
  order.cardStage = 'QR_GENERATED';

  const qrBuffer = await generateNamedUpiQrPngBuffer({
    upiUri: realQr.upiIntentUrl,
    senderName: order.fwdSenderName || order.userName || 'Customer',
    amount: payable,
    orderId: order.id
  });

  if (order.activeQrMessageId) {
    await telegram.deleteMessage(chatId, order.activeQrMessageId).catch(() => {});
  }

  const senderTag = escapeHtml(order.fwdSenderName || order.userName || 'Customer');
  const sendPhotoFn = typeof telegram.sendPhoto === 'function'
    ? (cid, photo, extra) => telegram.sendPhoto(cid, photo, extra)
    : null;
  if (!sendPhotoFn) {
    throw new Error('Telegram instance does not implement sendPhoto.');
  }
  const qrSent = await sendPhotoFn(
    chatId,
    { source: qrBuffer },
    {
      caption:
        `🔳 <b>OFFICIAL SWIGGY DYNAMIC PAYMENT QR (#${escapeHtml(order.id)})</b>\n` +
        `👤 <b>Order For:</b> ${senderTag}\n` +
        `🍽 <b>Restaurant:</b> ${escapeHtml(realQr.restaurantName || order.restaurantName || 'Swiggy')}\n` +
        `💰 <b>Exact Swiggy Amount:</b> ₹${payable}\n` +
        `🆔 <b>Swiggy Checkout Order ID:</b> <code>${escapeHtml(order.pendingSwiggyOrderId)}</code>\n` +
        `📱 <b>Swiggy Account:</b> <code>${escapeHtml(acc.phone || order.selectedAccount)}</code>\n\n` +
        `<i>✅ 100% Real Swiggy Merchant Dynamic QR — Pay from GPay / PhonePe / Paytm to place order directly on Swiggy! Auto-detecting payment every 5s...</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Paid (Verify & Get Live Tracking)', `fwd_check_paid_${order.id}`)],
        [Markup.button.callback('❌ Cancel Order', `fwd_cancel_${order.id}`)]
      ])
    }
  );

  order.activeQrMessageId = qrSent.message_id;
  order.trackedQrMessageIds = [qrSent.message_id];

  const freshDb = getDb();
  freshDb.orders[order.id] = order;
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
    formatOrderBodyFn
  });

  return { order, realQr, qrMessageId: qrSent.message_id };
}

// Parallel Batch Dispatcher: assigns each ready order its own distinct FREE Swiggy ID and fetches ALL simultaneously!
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

  // Pair up to `freeValidAccounts.length` orders with distinct FREE IDs and execute ALL AT THE EXACT SAME TIME (`Promise.all`)!
  const pairs = readyOrders.slice(0, freeValidAccounts.length).map((ord, idx) => ({
    order: ord,
    accKey: freeValidAccounts[idx][0],
    acc: freeValidAccounts[idx][1]
  }));

  const settled = await Promise.allSettled(
    pairs.map(({ order, accKey }) =>
      executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId: order.id,
        accKey,
        formatOrderBodyFn
      })
    )
  );

  return {
    dispatched: pairs.length,
    queuedRemaining: Math.max(0, readyOrders.length - pairs.length),
    pairs,
    settled
  };
}

export async function handleBossForwardedOrderInput(ctx, { rawText = '', location = null, formatOrderBodyFn }) {
  const sender = resolveOrderSenderInfo(ctx.message, ctx.from);
  if (!sender) return false;

  // Per-sender lock: different senders (`Boss`, `Ammi`, `Customer 2`, `Customer 3`) run 100% IN PARALLEL!
  return withSenderIntakeLock(sender.senderKey, async () => {
    const db = getDb();
    if (!db.orders) db.orders = {};

    let order = findIncompleteForwardedOrder(db, sender);
    const isUpdatingExisting = Boolean(order);

    if (!order) {
      const prefix = sender.isForwarded ? 'FWD' : 'ORD';
      const orderId = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
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

    try {
      const { updatedCart, updatedAddress } = await ingestForwardedContentIntoOrder(order, { rawText, location });

      if (!updatedCart && !updatedAddress) {
        await ctx.reply(
          `⚠️ <b>Could not detect a valid Swiggy Cart link or Delivery Address</b> in <b>${escapeHtml(sender.senderName)}</b>'s message.\n` +
          `<i>Send a Swiggy Cart link, Address share text/link, Google Maps link, street address, or GPS location pin.</i>`,
          { parse_mode: 'HTML' }
        );
        return true;
      }

      const freshDb = getDb();
      freshDb.orders[order.id] = order;
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, freshDb, formatOrderBodyFn);
      return true;
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
        stage: 'INGEST_LINK_OR_ADDRESS',
        orderId: order.id,
        senderName: sender.senderName,
        isForwarded: sender.isForwarded,
        cartLink: order.cart || rawText,
        addressSummary: order.address || ''
      });
      return true;
    }
  });
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

    order.cardStage = 'NEED_ACCOUNT';
    await ctx.answerCbQuery('Select Swiggy account');
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, db, formatOrderBodyFn, { includeQrDelete: true });
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

    // Flush unpaid cart cleanly & atomically inside per-account lock before returning (~180ms)!
    if (freedAcc?.cookies && order.status !== 'COMPLETED' && order.restaurantId) {
      await withSwiggyAccountLock(freedAccKey, () =>
        dapiFetch(freedAcc, 'cart', {
          method: 'POST',
          body: { flushFirst: true, cart: { restaurantId: String(order.restaurantId), address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] } }
        }).catch(() => {})
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
}
