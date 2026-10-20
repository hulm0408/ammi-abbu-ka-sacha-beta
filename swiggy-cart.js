import fs from 'fs';
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import { getDb } from './store.js';
import { findChromePath, decodeJwtPayload, claimSwiggyBreakfastAndLateNightOffers } from './swiggy-bridge.js';

const CHROME_PATH = findChromePath();
const PUPPETEER_HEADLESS = (process.platform === 'linux' || process.env.RAILWAY_ENVIRONMENT || process.env.HEADLESS === 'true') ? 'new' : false;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// Shared in-memory caches for sub-second operations
let cachedWafToken = '';
let cachedWafAt = 0;
let wafFetchPromise = null;
const WAF_TTL_MS = 8 * 60 * 1000; // 8 minutes

const sessionAuthCache = new Map(); // cookieSig -> { auth, ts }
const csrfTokenCache = new Map();   // cookieSig -> { csrf, ts }
const AUTH_TTL_MS = 45 * 1000;

// Distance helper (Haversine in meters)
function distanceMeters(lat1, lng1, lat2, lng2) {
  const a1 = parseFloat(lat1), o1 = parseFloat(lng1), a2 = parseFloat(lat2), o2 = parseFloat(lng2);
  if ([a1, o1, a2, o2].some(Number.isNaN)) return Infinity;
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(a2 - a1);
  const dLon = toRad(o2 - o1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Clean & normalize cookies (strips expired aws-waf-token so WAF never blocks requests)
export function cleanSwiggyCookieString(rawCookies, acc = null) {
  let pairs = [];
  if (typeof rawCookies === 'string') {
    const trimmed = rawCookies.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          pairs = arr.map(c => `${c.name || c.key}=${c.value}`);
        }
      } catch (e) {
        pairs = trimmed.split(';');
      }
    } else {
      pairs = trimmed.split(';');
    }
  } else if (Array.isArray(rawCookies)) {
    pairs = rawCookies.map(c => `${c.name || c.key}=${c.value}`);
  } else if (rawCookies && typeof rawCookies === 'object') {
    acc = acc || rawCookies;
    return cleanSwiggyCookieString(rawCookies.cookies || '', acc);
  }

  const map = new Map();
  for (const raw of pairs) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (!k || k === 'aws-waf-token' || k === 'userLocation') continue;
    map.set(k, v);
  }

  if (acc && typeof acc === 'object') {
    if (acc.tid && !map.has('_session_tid') && !acc.tid.includes('.')) map.set('_session_tid', acc.tid);
    if (acc.tid && !map.has('tid')) map.set('tid', acc.tid);
    if (acc.token && !map.has('token')) map.set('token', acc.token);
    if (acc.sid && !map.has('_sid')) map.set('_sid', acc.sid);
    if (acc.deviceId && !map.has('_device_id')) map.set('_device_id', acc.deviceId);
  }
  if ((map.has('_session_tid') || map.has('tid') || map.has('token')) && !map.has('_is_logged_in')) {
    map.set('_is_logged_in', '1');
  }

  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseCookieMap(cookieStr) {
  const cm = {};
  for (const part of String(cookieStr || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) cm[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return cm;
}

// ---------------------------------------------------------------------------
// ZERO-WAF SESSION AUTH BOOTSTRAP (<250ms pure HTTP via GET /dapi/order/all)
// Returns genuine HS256 JWT `jwtTid`, numeric `userId`, `sid`, `deviceId`, and `orders`
// ---------------------------------------------------------------------------
export async function getSwiggySessionAuth(accountOrCookies, forceRefresh = false) {
  if (!accountOrCookies) return null;
  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const cleanCookies = cleanSwiggyCookieString(accountOrCookies, acc);
  if (!cleanCookies) return null;

  const sig = cleanCookies.slice(0, 180);
  const now = Date.now();
  if (!forceRefresh && sessionAuthCache.has(sig)) {
    const cached = sessionAuthCache.get(sig);
    if (now - cached.ts < AUTH_TTL_MS) return cached.auth;
  }

  const cm = parseCookieMap(cleanCookies);
  try {
    const res = await fetch('https://www.swiggy.com/dapi/order/all', {
      headers: {
        'Cookie': cleanCookies,
        'User-Agent': DESKTOP_UA,
        'Accept': 'application/json',
        'Referer': 'https://www.swiggy.com/my-account'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      const json = await res.json().catch(() => null);
      const statusMsg = String(json?.statusMessage || '').toLowerCase();
      const isExpired = json?.statusCode === 1 && (
        statusMsg.includes('session') ||
        statusMsg.includes('login') ||
        statusMsg.includes('logged out') ||
        statusMsg.includes('unauthorized') ||
        statusMsg.includes('customer id')
      );
      if (isExpired) {
        return { sessionExpired: true, statusMessage: json?.statusMessage || 'Session expired', cleanCookies, cm };
      }

      const jwtTid = (json?.tid && String(json.tid).includes('.')) ? json.tid : (acc?.tid && String(acc.tid).includes('.') ? acc.tid : '');
      const claims = jwtTid ? decodeJwtPayload(jwtTid) : null;
      const userId = claims?.user_id || acc?.customerId || null;

      const auth = {
        sessionExpired: false,
        cleanCookies,
        cm,
        jwtTid,
        userId: userId ? String(userId) : null,
        sid: json?.sid || acc?.sid || cm._sid || '',
        deviceId: json?.deviceId || acc?.deviceId || cm._device_id || '',
        token: acc?.token || cm.token || '',
        swuid: cm._swuid || json?.deviceId || acc?.deviceId || cm._device_id || '',
        orders: Array.isArray(json?.data?.orders) ? json.data.orders : []
      };
      sessionAuthCache.set(sig, { auth, ts: now });
      return auth;
    }
  } catch (e) {
    console.warn('[SwiggyAuth] Direct auth bootstrap warning:', e.message);
  }

  // Fallback decode from existing JWT if present
  const fallbackJwt = (acc?.tid && String(acc.tid).includes('.')) ? acc.tid : (cm.tid && cm.tid.includes('.') ? cm.tid : '');
  const claims = fallbackJwt ? decodeJwtPayload(fallbackJwt) : null;
  return {
    sessionExpired: false,
    cleanCookies,
    cm,
    jwtTid: fallbackJwt,
    userId: claims?.user_id ? String(claims.user_id) : (acc?.customerId ? String(acc.customerId) : null),
    sid: acc?.sid || cm._sid || '',
    deviceId: acc?.deviceId || cm._device_id || '',
    token: acc?.token || cm.token || '',
    swuid: cm._swuid || acc?.deviceId || cm._device_id || '',
    orders: []
  };
}

// ---------------------------------------------------------------------------
// CACHED AWS WAF TOKEN GENERATOR (Solves once in ~2.5s, cached 8m across all API calls)
// ---------------------------------------------------------------------------
export async function getCachedWafToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedWafToken && (now - cachedWafAt) < WAF_TTL_MS) {
    return cachedWafToken;
  }
  if (wafFetchPromise) return wafFetchPromise;

  wafFetchPromise = (async () => {
    let browser = null;
    try {
      browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: PUPPETEER_HEADLESS,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-blink-features=AutomationControlled'
        ]
      });
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      });
      await page.setUserAgent(DESKTOP_UA);
      await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const cList = await page.cookies('https://www.swiggy.com').catch(() => []);
        const waf = cList.find(c => c.name === 'aws-waf-token');
        if (waf && waf.value && waf.value.length > 50) {
          cachedWafToken = waf.value;
          cachedWafAt = Date.now();
          break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      await browser.close().catch(() => {});
      return cachedWafToken;
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      console.warn('[WAF] Failed to acquire fresh aws-waf-token:', err.message);
      return cachedWafToken || '';
    } finally {
      wafFetchPromise = null;
    }
  })();

  return wafFetchPromise;
}

// Authenticated / guest Swiggy DAPI caller with automatic WAF token + _csrf + location cookie
export async function dapiFetch(accountOrCookies, endpoint, options = {}) {
  const {
    method = 'GET',
    body = null,
    lat = null,
    lng = null,
    address = '',
    area = '',
    extraHeaders = {},
    timeoutMs = 10000
  } = options;

  const cleanCookies = accountOrCookies ? cleanSwiggyCookieString(accountOrCookies) : '';
  const sig = cleanCookies ? cleanCookies.slice(0, 180) : 'guest';
  const url = endpoint.startsWith('http') ? endpoint : `https://www.swiggy.com/dapi/${endpoint.replace(/^\/?(dapi\/)?/, '')}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const wafToken = await getCachedWafToken(attempt > 0);
    const cookieParts = [];
    if (cleanCookies) cookieParts.push(cleanCookies);
    if (wafToken) cookieParts.push(`aws-waf-token=${wafToken}`);
    if (lat && lng) {
      cookieParts.push(`userLocation=${encodeURIComponent(JSON.stringify({
        lat: String(lat),
        lng: String(lng),
        address: String(address || area || 'India'),
        area: String(area || '')
      }))}`);
    }

    let finalBody = body ? { ...body } : null;
    if (method !== 'GET' && finalBody && finalBody._csrf === undefined) {
      let csrf = csrfTokenCache.get(sig)?.csrf || '';
      if (!csrf) {
        try {
          const csrfRes = await fetch('https://www.swiggy.com/dapi/cart', {
            headers: {
              'Cookie': cookieParts.join('; '),
              'User-Agent': DESKTOP_UA,
              'Accept': 'application/json',
              'Referer': 'https://www.swiggy.com/'
            },
            signal: AbortSignal.timeout(7000)
          });
          const csrfJson = await csrfRes.json().catch(() => null);
          if (csrfJson?.csrfToken) {
            csrf = csrfJson.csrfToken;
            csrfTokenCache.set(sig, { csrf, ts: Date.now() });
          }
        } catch (e) {}
      }
      if (csrf) finalBody._csrf = csrf;
    }

    const res = await fetch(url, {
      method,
      headers: {
        'Cookie': cookieParts.join('; '),
        'User-Agent': DESKTOP_UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://www.swiggy.com',
        'Referer': 'https://www.swiggy.com/checkout',
        ...extraHeaders
      },
      ...(finalBody ? { body: JSON.stringify(finalBody) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (res.status === 202 || res.headers.get('x-amzn-waf-action')) {
      if (attempt === 0) continue;
    }

    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json?.csrfToken) {
        csrfTokenCache.set(sig, { csrf: json.csrfToken, ts: Date.now() });
      }
      return { ok: res.ok, status: res.status, json };
    } catch (parseErr) {
      if (attempt === 0) continue;
      return { ok: false, status: res.status, json: null, rawText: text.slice(0, 300) };
    }
  }

  return { ok: false, status: 0, json: null };
}

function buildChkoutHeaders(auth, lat = '26.8658609', lng = '80.9307755', extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'tid': auth.jwtTid || '',
    'sid': auth.sid || '',
    'token': auth.token || '',
    'userid': String(auth.userId || ''),
    'user-id': String(auth.userId || ''),
    'deviceId': auth.deviceId || '',
    'device-id': auth.deviceId || '',
    'swuid': auth.swuid || auth.deviceId || '',
    'platform': 'an',
    'agent-type': 'Swiggy-Android',
    'analyticsPlatform': 'an',
    'x-web-checkout-flow': 'cart',
    'marketplaceid': '1',
    'marketplacecategory': 'FOOD',
    'marketplacebusinessline': 'Regular',
    'version-code': '1350',
    'app-version': '4.68.0',
    'lat': String(lat),
    'lng': String(lng),
    'Cookie': auth.cleanCookies || '',
    'Origin': 'https://www.swiggy.com',
    'Referer': 'https://www.swiggy.com/',
    'User-Agent': 'Swiggy-Android',
    ...extra
  };
}

// Helper to get ordered candidate Swiggy accounts from local DB
function getCandidateAccounts(preferredAccount = null, preferredHostName = null) {
  const list = [];
  const seen = new Set();

  const pushAcc = (key, acc) => {
    if (!acc || typeof acc !== 'object') return;
    const clean = cleanSwiggyCookieString(acc.cookies || '', acc);
    if (!clean && !acc.tid) return;
    const id = key || acc.phone || acc.name || clean.slice(0, 40);
    if (seen.has(id)) return;
    seen.add(id);
    list.push({ key: key || id, acc });
  };

  if (preferredAccount) pushAcc('preferred', preferredAccount);

  try {
    const db = getDb();
    const accounts = db?.config?.accounts || {};
    const entries = Object.entries(accounts);

    // If preferredHostName matches one of our accounts, check it first (read-only!)
    if (preferredHostName) {
      const h = preferredHostName.trim().toLowerCase();
      for (const [k, a] of entries) {
        const names = [a.swiggyName, a.name, a.phone].filter(Boolean).map(x => String(x).trim().toLowerCase());
        if (names.some(n => n === h || n.includes(h) || h.includes(n))) {
          pushAcc(k, a);
        }
      }
    }

    for (const [k, a] of entries) {
      pushAcc(k, a);
    }
  } catch (e) {}

  return list;
}

// ---------------------------------------------------------------------------
// LIVE GROUP CART ENGINE (https://chkout.swiggy.com/api/v1/shared_cart)
// Sub-100ms, zero WAF, auto-joins foreign customer group carts cleanly!
// ---------------------------------------------------------------------------
export async function fetchLiveGroupCart(groupCartId, restaurantId = null, hostName = null, preferredAccount = null) {
  if (!groupCartId) return null;
  const gcId = String(groupCartId).trim();
  const candidates = getCandidateAccounts(preferredAccount, hostName);
  if (candidates.length === 0) return null;

  const parseSharedCartPayload = (data) => {
    if (!data || typeof data !== 'object') return null;
    const rDetails = data.restaurant_details || {};
    const resolvedRestId = String(rDetails.restaurant_id || restaurantId || '');
    const resolvedRestName = rDetails.restaurant_name || null;
    const areaName = rDetails.area_name || '';

    // Merge identical menu items across all group cart participants cleanly
    const mergedItemsMap = new Map();
    const userCartMap = data.user_cart_map || {};
    for (const participant of Object.values(userCartMap)) {
      const userCart = Array.isArray(participant?.user_cart) ? participant.user_cart : [];
      for (const rawItem of userCart) {
        if (!rawItem || !rawItem.menu_item_id || !(rawItem.quantity > 0)) continue;
        const menuItemId = String(rawItem.menu_item_id);
        const addons = Array.isArray(rawItem.addons) ? rawItem.addons : [];
        const variants = Array.isArray(rawItem.variants) ? rawItem.variants : [];
        const sigKey = `${menuItemId}::${JSON.stringify(variants)}::${JSON.stringify(addons)}`;

        const qty = Number(rawItem.quantity) || 1;
        const basePaise = Number(rawItem.subtotal ?? (Number(rawItem.base_price || 0) * qty));
        const finalPaise = Number(rawItem.final_price ?? basePaise);
        const tradeDiscPaise = Number(rawItem.subtotal_trade_discount || 0);
        const packPaise = Number(rawItem.packing_charge || 0);
        const itemGst = Number(rawItem.item_taxes?.GST || 0);

        const unitPrice = Math.round((basePaise / 100 / qty) * 100) / 100;
        const lineTotal = Math.round((basePaise / 100) * 100) / 100;
        const finalLineTotal = Math.round((finalPaise / 100) * 100) / 100;

        if (mergedItemsMap.has(sigKey)) {
          const prev = mergedItemsMap.get(sigKey);
          prev.qty += qty;
          prev.quantity = prev.qty;
          prev.lineTotal = Math.round((prev.lineTotal + lineTotal) * 100) / 100;
          prev.finalLineTotal = Math.round((prev.finalLineTotal + finalLineTotal) * 100) / 100;
          prev.tradeDiscount = Math.round((prev.tradeDiscount + tradeDiscPaise / 100) * 100) / 100;
          prev.packingCharge = Math.round((prev.packingCharge + packPaise / 100) * 100) / 100;
          prev.gst = Math.round((prev.gst + itemGst) * 100) / 100;
        } else {
          mergedItemsMap.set(sigKey, {
            itemId: menuItemId,
            menu_item_id: Number(menuItemId),
            name: String(rawItem.name || 'Dish Item').trim(),
            qty,
            quantity: qty,
            price: unitPrice,
            lineTotal,
            finalLineTotal,
            tradeDiscount: Math.round((tradeDiscPaise / 100) * 100) / 100,
            packingCharge: Math.round((packPaise / 100) * 100) / 100,
            gst: Math.round(itemGst * 100) / 100,
            addons,
            variants,
            isVeg: rawItem.isVeg === 1 || rawItem.is_veg === '1',
            inStock: rawItem.in_stock !== 0
          });
        }
      }
    }

    const items = Array.from(mergedItemsMap.values());
    const subtotal = Math.round(items.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
    const tradeDiscountTotal = Math.round(items.reduce((s, i) => s + (i.tradeDiscount || 0), 0) * 100) / 100;
    const discountedSubtotal = Math.round(items.reduce((s, i) => s + i.finalLineTotal, 0) * 100) / 100;
    const packingCharges = Math.round(items.reduce((s, i) => s + (i.packingCharge || 0), 0) * 100) / 100;
    const itemGstTotal = Math.round(items.reduce((s, i) => s + (i.gst || 0), 0) * 100) / 100;

    return {
      status: 'ACTIVE',
      groupCartId: String(data.group_cart_id || gcId),
      hostUserId: data.host_user_id ? String(data.host_user_id) : null,
      deeplink: data.shared_cart_deeplink || null,
      locked: Boolean(data.locked_status),
      restaurantId: resolvedRestId || null,
      restaurantName: resolvedRestName,
      areaName,
      items,
      itemTotal: subtotal,
      subtotal,
      discountedSubtotal,
      tradeDiscountTotal,
      packingCharges,
      taxesAndCharges: itemGstTotal
    };
  };

  let lastStatusInfo = null;

  // Pass 1: Read-only GET across candidate accounts (never modifies anything if already member/host!)
  const resolvedAuths = [];
  for (const cand of candidates) {
    const auth = await getSwiggySessionAuth(cand.acc);
    if (!auth || auth.sessionExpired || !auth.jwtTid || !auth.userId) continue;
    resolvedAuths.push({ ...cand, auth });

    try {
      const res = await fetch(`https://chkout.swiggy.com/api/v1/shared_cart?group_cart_id=${encodeURIComponent(gcId)}`, {
        headers: buildChkoutHeaders(auth),
        signal: AbortSignal.timeout(7000)
      });
      const json = await res.json().catch(() => null);
      if (json?.statusCode === 0 && json?.data) {
        return parseSharedCartPayload(json.data);
      }
      if (json?.statusCode === 88 || json?.errorCodes?.includes('GROUP_CART_NO_LONGER_EXISTS')) {
        return { status: 'EXPIRED', statusCode: json.statusCode, statusMessage: json.statusMessage || 'Group cart no longer exists', items: [] };
      }
      if (json?.errorCodes?.includes('GROUP_CART_ORDER_PLACED')) {
        return { status: 'PLACED', statusCode: json.statusCode, statusMessage: json.statusMessage || 'Group cart order already placed', items: [] };
      }
      lastStatusInfo = json;
    } catch (e) {}
  }

  // Pass 2: If foreign customer created this group cart (UNAUTHORIZED_ACCESS_TO_CART), join cleanly via POST /api/v1/shared_cart/join!
  // Prefer an account with an empty cart first so an active personal cart is untouched
  for (const entry of resolvedAuths.slice().reverse()) {
    const { auth } = entry;
    const uid = String(auth.userId);
    try {
      const joinRes = await fetch('https://chkout.swiggy.com/api/v1/shared_cart/join', {
        method: 'POST',
        headers: buildChkoutHeaders(auth),
        body: JSON.stringify({
          group_cart_id: gcId,
          groupCartId: gcId,
          group_cart_user_id: uid,
          groupCartUserId: uid,
          user_id: uid,
          userId: uid,
          customer_id: uid,
          member_id: uid,
          ...(hostName ? { host_name: String(hostName) } : {}),
          ...(restaurantId ? { restaurant_id: String(restaurantId) } : {})
        }),
        signal: AbortSignal.timeout(8000)
      });
      const joinJson = await joinRes.json().catch(() => null);
      if (joinJson?.statusCode === 0 && joinJson?.data) {
        return parseSharedCartPayload(joinJson.data);
      }
      if (joinJson?.statusCode === 88 || joinJson?.errorCodes?.includes('GROUP_CART_NO_LONGER_EXISTS')) {
        return { status: 'EXPIRED', statusCode: joinJson.statusCode, statusMessage: joinJson.statusMessage || 'Group cart no longer exists', items: [] };
      }
      lastStatusInfo = joinJson || lastStatusInfo;
    } catch (e) {}
  }

  if (lastStatusInfo) {
    return {
      status: 'UNAVAILABLE',
      statusCode: lastStatusInfo.statusCode,
      statusMessage: lastStatusInfo.statusMessage || (lastStatusInfo.errorCodes || []).join(', '),
      items: []
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// REVERSE & FORWARD GEOCODING ENGINE (Swiggy Maps API + Nominatim fallback)
// ---------------------------------------------------------------------------
export async function reverseGeocodeCoords(lat, lng, accountOrCookies = null) {
  if (!lat || !lng) return null;
  const sLat = String(lat).trim();
  const sLng = String(lng).trim();

  // 1. Try Swiggy's own official reverse geocoder first for 100% Swiggy area/city parity
  try {
    const cand = accountOrCookies || getCandidateAccounts()[0]?.acc || null;
    const { json } = await dapiFetch(cand, 'misc/address-recommend', {
      method: 'POST',
      body: { latlng: `${sLat},${sLng}` },
      lat: sLat,
      lng: sLng,
      timeoutMs: 7000
    });
    const rec = json?.data?.[0];
    if (rec?.formatted_address) {
      const comps = Array.isArray(rec.address_components) ? rec.address_components : [];
      const findComp = (...types) => comps.find(c => Array.isArray(c.types) && types.some(t => c.types.includes(t)))?.long_name || '';
      const city = findComp('locality', 'administrative_area_level_2') || 'Address';
      const area = findComp('sublocality_level_1', 'sublocality', 'neighborhood') || city;
      const landmark = findComp('sublocality_level_2', 'premise', 'route') || area;
      const pincode = findComp('postal_code') || '';
      return {
        address: rec.formatted_address,
        area,
        landmark,
        city,
        pincode,
        lat: String(rec.geometry?.location?.lat || sLat),
        lng: String(rec.geometry?.location?.lng || sLng)
      };
    }
  } catch (e) {}

  // 2. Fallback to OpenStreetMap Nominatim reverse geocoding
  try {
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(sLat)}&lon=${encodeURIComponent(sLng)}`, {
      headers: { 'User-Agent': 'TelegramSlotBot/2.0', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(4500)
    });
    if (geoRes.ok) {
      const gj = await geoRes.json();
      const a = gj.address || {};
      const city = a.city || a.town || a.village || a.state_district || 'Address';
      const area = a.suburb || a.neighbourhood || a.residential || a.county || city;
      const landmark = a.road || a.building || area;
      return {
        address: gj.display_name || `${area}, ${city}`,
        area,
        landmark,
        city,
        pincode: a.postcode || '',
        lat: sLat,
        lng: sLng
      };
    }
  } catch (e) {}

  return {
    address: `Pinned Location (${sLat}, ${sLng})`,
    area: 'Pinned Area',
    landmark: 'Main Road',
    city: 'Delivery',
    lat: sLat,
    lng: sLng
  };
}

export async function geocodeAddressDetails(addrObj, accountOrCookies = null) {
  if (!addrObj || typeof addrObj !== 'object') return addrObj;
  const out = { ...addrObj };

  // Case A: Already has coordinates -> enrich street/area/city if missing
  if (out.lat && out.lng) {
    if (!out.address || out.address.startsWith('Delivering to ') || out.address.startsWith('Pinned Location')) {
      const rev = await reverseGeocodeCoords(out.lat, out.lng, accountOrCookies);
      if (rev) {
        out.address = rev.address || out.address;
        out.area = out.area || rev.area;
        out.landmark = out.landmark || rev.landmark;
        out.city = (!out.city || out.city === 'Delivery' || out.city === 'Shared Location') ? rev.city : out.city;
      }
    }
    return out;
  }

  // Case B: Has text street address without coordinates -> check saved account addresses first for exact match!
  const rawAddr = String(out.address || '').trim();
  if (!rawAddr || out.unresolvableShortLink) return out;

  try {
    const allSaved = await fetchAllAccountsSavedAddresses();
    const normTarget = rawAddr.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const matchedSaved = allSaved.find(sa => {
      if (!sa.lat || !sa.lng || !sa.address) return false;
      const normSa = sa.address.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      return normTarget.includes(normSa) || normSa.includes(normTarget) ||
        (normTarget.length > 18 && normSa.slice(0, 24) === normTarget.slice(0, 24));
    });
    if (matchedSaved) {
      out.lat = String(matchedSaved.lat);
      out.lng = String(matchedSaved.lng);
      out.id = out.id || matchedSaved.id;
      out.name = out.name || matchedSaved.name;
      out.mobile = out.mobile || matchedSaved.mobile;
      out.city = out.city || matchedSaved.city;
      out.area = out.area || matchedSaved.area;
      out.flat_no = out.flat_no || matchedSaved.flat_no;
      return out;
    }
  } catch (e) {}

  // Progressive Nominatim forward-geocoding queries (most specific -> locality + PIN -> PIN -> city)
  const parts = rawAddr.split(',').map(s => s.trim()).filter(Boolean);
  const pinMatch = rawAddr.match(/\b([1-8]\d{5})\b/);
  const pin = pinMatch ? pinMatch[1] : '';
  const queries = [];
  if (parts.length >= 3) {
    queries.push(parts.slice(-5).join(', '));
    queries.push(parts.slice(-4).join(', '));
    queries.push(parts.slice(-3).join(', '));
  }
  queries.push(rawAddr);
  if (out.area && out.city) queries.push(`${out.area}, ${out.city}${pin ? ', ' + pin : ''}, India`);
  if (pin) queries.push(`${pin}, India`);
  if (out.city) queries.push(`${out.city}, India`);

  const seenQ = new Set();
  for (const q of queries) {
    const cleanQ = q.trim();
    if (!cleanQ || seenQ.has(cleanQ.toLowerCase())) continue;
    seenQ.add(cleanQ.toLowerCase());
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(cleanQ)}`, {
        headers: { 'User-Agent': 'TelegramSlotBot/2.0', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(4000)
      });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
          out.lat = String(arr[0].lat);
          out.lng = String(arr[0].lon);
          if (!out.city) {
            const rev = await reverseGeocodeCoords(out.lat, out.lng, accountOrCookies);
            if (rev?.city) out.city = rev.city;
            if (rev?.area && !out.area) out.area = rev.area;
            if (rev?.landmark && !out.landmark) out.landmark = rev.landmark;
          }
          break;
        }
      }
    } catch (e) {}
  }

  return out;
}

// Resolve genuine Swiggy OFO shared address UUID via mobile endpoint (/mapi/social/getAddress/<uuid>)
export async function resolveSharedOfoAddress(ofoToken, ofoUser = null, accountOrCookies = null) {
  if (!ofoToken) return null;
  const tok = String(ofoToken).trim();

  // Real Swiggy social address tokens are UUIDs / long IDs (AppsFlyer JgkQ short codes are ~8 chars)
  const looksLikeUuidOrLongToken = tok.length >= 14 || tok.includes('-');
  if (!looksLikeUuidOrLongToken) {
    return null;
  }

  try {
    const cand = accountOrCookies || getCandidateAccounts()[0]?.acc || null;
    const cleanCookies = cand ? cleanSwiggyCookieString(cand) : '';
    const waf = await getCachedWafToken(false);
    const cookieStr = [cleanCookies, waf ? `aws-waf-token=${waf}` : ''].filter(Boolean).join('; ');

    const res = await fetch(`https://www.swiggy.com/mapi/social/getAddress/${encodeURIComponent(tok)}`, {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Swiggy-Android',
        'app-version': '1150',
        'version-code': '1150',
        'platform': 'an',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(7000)
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const d = json?.data;
      if (json?.statusCode === 0 && d && (d.address || d.address_line1 || d.lat || d.latitude)) {
        return {
          id: d.id || d.address_id || '',
          name: d.name || d.customer_name || ofoUser || 'Customer',
          mobile: d.mobile || d.phone || '',
          flat_no: d.flat_no && d.flat_no !== 'None' ? d.flat_no : '',
          area: d.area || d.locality || '',
          landmark: d.landmark || d.area || '',
          city: d.city || 'Address',
          address: `${d.flat_no && d.flat_no !== 'None' ? d.flat_no + ', ' : ''}${d.address || d.address_line1 || ''}`.trim(),
          lat: String(d.lat || d.latitude || ''),
          lng: String(d.lng || d.longitude || ''),
          annotation: d.annotation || 'Shared'
        };
      }
    }
  } catch (e) {}
  return null;
}

// Verified payment data extraction - STOP synthetic QR generation via qrserver.com
export function getGenuinePaymentDetails(order) {
  return {
    payableAmount: order?.finalPayable || order?.subtotal || null,
    restaurantName: order?.restaurantName || 'Swiggy Order',
    swiggyPaymentUrl: 'https://www.swiggy.com/payments',
    swiggyCheckoutUrl: 'https://www.swiggy.com/checkout',
    hasGenuineQr: Boolean(order?.customQrFileId || order?.genuineQrBuffer),
    genuineQr: order?.customQrFileId || order?.genuineQrBuffer || null
  };
}

export function generateUpiQrUrl(amount, orderId, upiId = null) {
  return {
    hasGenuineQr: false,
    qrUrl: null,
    amount: Math.max(1, Math.round(amount || 0)),
    swiggyPaymentUrl: 'https://www.swiggy.com/payments',
    swiggyCheckoutUrl: 'https://www.swiggy.com/checkout'
  };
}

// Generates a sleek, authentic, personalized Swiggy Payment Card image with customer's name IN CENTER OF QR
export async function generatePersonalizedQrCard({
  customerName = 'Abbu & Ammi',
  restaurantName = 'Swiggy Food Order',
  amount = 0,
  savings = 0,
  upiUrl = null,
  qrBuffer = null
}) {
  let qrDataUrl = '';
  if (qrBuffer) {
    qrDataUrl = `data:image/png;base64,${Buffer.isBuffer(qrBuffer) ? qrBuffer.toString('base64') : qrBuffer}`;
  } else if (upiUrl) {
    qrDataUrl = await QRCode.toDataURL(upiUrl, {
      margin: 2,
      width: 360,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' }
    });
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: PUPPETEER_HEADLESS,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 2 });

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }
    .card {
      width: 480px;
      background: linear-gradient(160deg, #1a1e29 0%, #10131a 100%);
      border: 2px solid #fc8019;
      border-radius: 24px;
      padding: 28px 24px;
      color: #ffffff;
      text-align: center;
      box-shadow: 0 16px 40px rgba(252, 128, 25, 0.25);
    }
    .header-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(252, 128, 25, 0.15);
      border: 1px solid rgba(252, 128, 25, 0.4);
      color: #fc8019;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 6px 16px;
      border-radius: 20px;
      margin-bottom: 14px;
    }
    .restaurant-title {
      font-size: 20px;
      font-weight: 600;
      color: #e5e7eb;
      margin-bottom: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qr-frame {
      background: #ffffff;
      padding: 12px;
      border-radius: 20px;
      display: inline-block;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      margin-bottom: 18px;
    }
    .qr-wrapper {
      position: relative;
      display: inline-block;
      width: 260px;
      height: 260px;
    }
    .qr-wrapper img {
      display: block;
      width: 260px;
      height: 260px;
      border-radius: 8px;
      object-fit: contain;
    }
    .qr-center-badge {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #ffffff;
      border: 3px solid #fc8019;
      border-radius: 12px;
      padding: 5px 14px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: 140px;
      min-width: 65px;
      z-index: 10;
    }
    .qr-center-badge span {
      font-size: 14px;
      font-weight: 800;
      color: #fc8019;
      letter-spacing: 0.5px;
      text-transform: capitalize;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .amount-box {
      margin-bottom: 12px;
    }
    .amount-label {
      font-size: 13px;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .amount-value {
      font-size: 34px;
      font-weight: 800;
      color: #10b981;
      margin-top: 2px;
    }
    .savings-badge {
      display: inline-block;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      font-size: 13px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 12px;
      margin-top: 4px;
    }
    .instructions {
      font-size: 13px;
      color: #d1d5db;
      line-height: 1.4;
      margin-top: 10px;
    }
    .footer {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      color: #6b7280;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="header-badge">
      ⚡ SWIGGY OFFICIAL INSTANT PAY
    </div>
    <br>
    <div class="restaurant-title">
      🏪 ${restaurantName}
    </div>
    <div class="qr-frame">
      <div class="qr-wrapper">
        <img src="${qrDataUrl}" alt="Payment QR" />
        <div class="qr-center-badge">
          <span>${customerName}</span>
        </div>
      </div>
    </div>
    <div class="amount-box">
      <div class="amount-label">Amount To Pay</div>
      <div class="amount-value">₹${amount}</div>
      ${savings > 0 ? `<div class="savings-badge">🎉 Saved ₹${savings} with Coupons & Free Delivery</div>` : ''}
    </div>
    <div class="instructions">
      📲 <b>Scan & Pay</b> using PhonePe, Google Pay, Paytm or any UPI App
    </div>
    <div class="footer">
      🔒 100% Genuine Swiggy Checkout • Order placed automatically upon payment
    </div>
  </div>
</body>
</html>
    `;

    await page.setContent(html, { waitUntil: 'load' });
    const cardEl = await page.$('#card');
    const buffer = await cardEl.screenshot({ type: 'png' });
    return buffer;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Fast fetch verified restaurant info & menu directly from Swiggy's API with WAF token support
export async function fetchFastRestaurantInfo(restaurantId, lat = '26.8658609', lng = '80.9307755', includeMenu = false) {
  if (!restaurantId) return null;
  try {
    const cand = getCandidateAccounts()[0]?.acc || null;
    const { json } = await dapiFetch(
      cand,
      `menu/pl?page-type=REGULAR_MENU&complete-menu=${includeMenu ? 'true' : 'false'}&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`,
      { lat, lng, timeoutMs: 8000 }
    );
    if (!json?.data?.cards) return null;

    let restName = null;
    let city = null;
    const menuItems = [];
    const seenIds = new Set();

    const cards = json.data.cards || [];
    function extractDishes(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.id && obj.name && (obj.price || obj.defaultPrice || obj.finalPrice)) {
        const idStr = String(obj.id);
        if (!seenIds.has(idStr)) {
          seenIds.add(idStr);
          const rawPrice = obj.finalPrice || obj.price || obj.defaultPrice;
          menuItems.push({
            id: idStr,
            name: String(obj.name).trim(),
            price: Math.round(Number(rawPrice)) / 100,
            inStock: obj.inStock !== 0
          });
        }
      }
      for (const v of Object.values(obj)) {
        if (typeof v === 'object' && v !== null) extractDishes(v);
      }
    }

    for (const c of cards) {
      const info = c?.card?.card?.info;
      if (info?.name && !restName) {
        restName = info.name;
        city = info.city || info.areaName;
      }
    }
    if (includeMenu) {
      extractDishes(cards);
    }

    if (!restName) return null;
    return {
      restName,
      city: city || 'Local Area',
      menuItems
    };
  } catch (e) {
    return null;
  }
}

// Cleanly extract structured delivery address from Swiggy native share messages, Swiggy World receipts, coordinates, or plain text
export function parseAddressDetails(text) {
  if (!text) return null;
  // Normalize markdown tel/url links like `[9823305540](tel:9823305540)` -> `9823305540` and HTML `&amp;` -> `&`
  const str = String(text)
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/gi, '$1')
    .replace(/&amp;/gi, '&')
    .trim();

  // Pure single URL with no accompanying text is handled by URL resolvers, not text parser
  if (/^https?:\/\/\S+$/i.test(str)) {
    return null;
  }

  let name = null, mobile = null, city = null, address = null, flat_no = null, area = null, landmark = null, lat = null, lng = null;

  // 1. Check Swiggy App's native "Share Address" message format:
  const swiggyShareAddrMatch = str.match(/(?:^|\n)\s*Address\s*:\s*([^\n\r]+(?:\n(?!https?:\/\/)[^\n\r]+)*)/i);
  if (swiggyShareAddrMatch) {
    address = swiggyShareAddrMatch[1].replace(/https?:\/\/\S+/gi, '').trim().replace(/[,\s]+$/, '');
  }

  // 2. Isolate ONLY the address block BEFORE "Select an Available Payment Method" / "Final Bill" / "Bill Summary" / "Items Total"
  let searchScope = str.split(/\n\s*(?:Select\s+an\s+Available\s+Payment\s+Method|Final\s+Bill|Bill\s+Summary|Items\s+Total\s*:)/i)[0] || str;
  const delivSectionMatch = searchScope.match(/(?:📍\s*Delivering\s*To|Delivering\s*To)[\s\S]*/i);
  if (delivSectionMatch) {
    searchScope = delivSectionMatch[0];
  }

  const phoneMatch = searchScope.match(/(?:📱|phone|mobile|tel|contact)?[:\s]*([6-9]\d{9})\b/i) || str.match(/(?:📱|phone|mobile|tel|contact)[:\s]*([6-9]\d{9})\b/i);
  if (phoneMatch) mobile = phoneMatch[1];

  const latMatch = (searchScope + '\n' + str).match(/(?:🧭\s*Latitude|lat|latitude)[:\s]*(-?[0-9]{1,2}\.[0-9]{3,10})/i);
  const lngMatch = (searchScope + '\n' + str).match(/(?:🧭\s*Longitude|lng|long|longitude)[:\s]*(-?[0-9]{1,3}\.[0-9]{3,10})/i);
  if (latMatch) lat = latMatch[1];
  if (lngMatch) lng = lngMatch[1];

  if (!lat || !lng) {
    const coordsMatch = str.match(/\b([1-3][0-9]\.[0-9]{4,10})[,\s]+([6-9][0-9]\.[0-9]{4,10})\b/);
    if (coordsMatch) {
      lat = coordsMatch[1];
      lng = coordsMatch[2];
    }
  }

  const nameMatch = searchScope.match(/(?:👤|recipient|receiver|customer\s*name|name)\s*[:\-]?\s*([^\n\r]+)/i);
  if (nameMatch) {
    const candidateName = nameMatch[1].replace(/https?:\/\/\S+/gi, '').trim();
    if (candidateName && candidateName.length <= 50) name = candidateName;
  }

  // Match `<City> Address` header with OR without 📍 emoji (e.g. `Pune Address`, `Lucknow Address`)
  const cityHeaderMatch = searchScope.match(/(?:^|\n)\s*(?:📍\s*)?([A-Za-z][A-Za-z\s]{1,30}?)\s+Address\s*(?:\n|$)/i)
    || searchScope.match(/city\s*[:\-]\s*([^\n\r,]+)/i);
  if (cityHeaderMatch) {
    const c = (cityHeaderMatch[1] || '').trim();
    if (!/^(delivering|delivery|your|saved|order|billing)$/i.test(c)) {
      city = c;
    }
  }

  if (!city) {
    const knownCities = [
      'Lucknow', 'Hyderabad', 'Secunderabad', 'Bangalore', 'Bengaluru', 'New Delhi', 'Delhi',
      'Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Kolkata', 'Chennai', 'Jaipur', 'Ahmedabad',
      'Chandigarh', 'Noida', 'Greater Noida', 'Gurgaon', 'Gurugram', 'Ghaziabad', 'Faridabad',
      'Kanpur', 'Varanasi', 'Prayagraj', 'Allahabad', 'Agra', 'Gorakhpur', 'Bareilly', 'Aligarh',
      'Moradabad', 'Meerut', 'Kota', 'Indore', 'Bhopal', 'Patna', 'Ranchi', 'Raipur', 'Bilaspur',
      'Bhubaneswar', 'Guwahati', 'Kochi', 'Coimbatore', 'Nagpur', 'Surat', 'Vadodara', 'Ludhiana',
      'Amritsar', 'Dehradun', 'Jodhpur', 'Udaipur', 'Gwalior', 'Jabalpur', 'Visakhapatnam', 'Vijayawada'
    ];
    for (const c of knownCities) {
      if (new RegExp('\\b' + c + '\\b', 'i').test(address || searchScope)) {
        city = c;
        break;
      }
    }
  }

  // 3. Parse structured multi-line Swiggy World address block:
  //    Pune Address
  //    Prathmesh
  //    9823305540
  //    Flat no. 412 , 4th floor Parivartan society dandekar pool pune
  //    Pune, Maharashtra 411030
  //    Latitude: 18.502975
  const scopeLines = searchScope
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^(Delivering\s*To|📍\s*Delivering\s*To|Your\s*Cart)$/i.test(l));

  const headerIdx = scopeLines.findIndex(l => /^(?:📍\s*)?[A-Za-z][A-Za-z\s]{1,30}\s+Address$/i.test(l));
  const phoneIdx = mobile ? scopeLines.findIndex(l => l.includes(mobile)) : -1;
  const latIdx = scopeLines.findIndex(l => /^(?:🧭\s*)?Latitude\s*:/i.test(l));

  if (!name && phoneIdx > 0) {
    const prevLine = scopeLines[phoneIdx - 1];
    if (prevLine && prevLine.length <= 50 && !/\s+Address$/i.test(prevLine) && !/\d{4,}/.test(prevLine)) {
      name = prevLine.replace(/^👤\s*/, '').trim();
    }
  } else if (!name && headerIdx >= 0 && scopeLines[headerIdx + 1] && !/\d{6,}/.test(scopeLines[headerIdx + 1])) {
    name = scopeLines[headerIdx + 1].replace(/^👤\s*/, '').trim();
  }

  if (!address && phoneIdx >= 0 && (latIdx > phoneIdx || scopeLines.length > phoneIdx + 1)) {
    const endIdx = latIdx > phoneIdx ? latIdx : scopeLines.length;
    const addrLines = scopeLines
      .slice(phoneIdx + 1, endIdx)
      .filter(l => !/^₹|\s*[×x]\s*\d+\s*=\s*₹|Subtotal\s*:|^Order\s*Account\s*:/i.test(l));
    if (addrLines.length > 0) {
      address = addrLines.join('\n').replace(/^🏠\s*/, '').trim();
    }
  }

  if (!address) {
    const addrEmojiMatch = searchScope.match(/(?:🏠\s*[\r\n]*)([^\n\r]+(?:\n[^\n\r]+)*?)(?=\n🧭|\nLatitude|\n1️⃣|\n📦|\n🧾|$)/i);
    if (addrEmojiMatch) {
      address = addrEmojiMatch[1].replace(/https?:\/\/\S+/gi, '').trim();
    } else {
      const stripped = searchScope
        .replace(/Hey!\s*Save my address on Swiggy using the link\s*:?\s*/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/^[\s\.,:\-]+|[\s\.,:\-]+$/g, '')
        .trim();

      const looksLikeRealAddress =
        !searchScope.includes('Your Cart') &&
        stripped.length >= 10 &&
        (
          /\b[1-8]\d{5}\b/.test(stripped) ||
          Boolean(city) ||
          /\b(house|flat|floor|ground|plot|block|sector|phase|nagar|ganj|colony|road|rd|marg|street|st|lane|gali|apartment|apt|tower|hostel|campus|near|opp|opposite|behind|beside|india|uttar pradesh|telangana|karnataka|maharashtra|delhi|rajasthan|bihar|madhya pradesh|west bengal|gujarat|tamil nadu|chhattisgarh)\b/i.test(stripped)
        );

      if (looksLikeRealAddress) {
        address = stripped;
      }
    }
  }

  // Derive flat_no, area, landmark cleanly from comma/newline-separated address parts
  if (address) {
    const segs = address.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
      flat_no = segs[0];
      const nonCountry = segs.filter(s => !/^india$/i.test(s) && !/\b\d{6}\b/.test(s) && (!city || s.toLowerCase() !== city.toLowerCase()));
      area = nonCountry[nonCountry.length - 1] || segs[1] || city || 'Main Area';
      landmark = nonCountry[Math.max(0, nonCountry.length - 2)] || area;
    }
  }

  if (name || mobile || city || address || lat || lng) {
    return { name, mobile, city, address, flat_no, area, landmark, lat, lng };
  }
  return null;
}

export function parseCartDetails(text) {
  if (!text) return null;
  const str = String(text)
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/gi, '$1')
    .replace(/&amp;/gi, '&')
    .trim();

  let restaurantName = null;
  const restMatch = str.match(/🏪\s*([^\n\r]+)/i);
  if (restMatch) restaurantName = restMatch[1].trim();

  let orderAccount = null;
  const accMatch = str.match(/(?:📱\s*)?Order\s*Account[:\s]*([0-9]{10})/i);
  if (accMatch) orderAccount = accMatch[1].trim();

  const items = [];
  const itemRegex = /(?:[0-9]️⃣|[0-9]+\.)\s*([^\n\r]+)[\r\n]+\s*💵\s*₹([0-9.]+)\s*×\s*([0-9]+)\s*=\s*₹([0-9.]+)/gi;
  let m;
  while ((m = itemRegex.exec(str)) !== null) {
    const qty = parseInt(m[3], 10) || 1;
    items.push({
      name: m[1].trim(),
      price: parseFloat(m[2]),
      qty,
      quantity: qty,
      lineTotal: parseFloat(m[4])
    });
  }

  if (items.length === 0) {
    const plainReceiptRegex = /([^\n\r₹]+)\r?\n₹([0-9.]+)\s*[×x]\s*([0-9]+)\s*=\s*₹([0-9.]+)/gi;
    while ((m = plainReceiptRegex.exec(str)) !== null) {
      const dish = m[1].trim();
      if (dish && !/^(Your Cart|Delivering To|Bill Summary|Final Bill)$/i.test(dish)) {
        const qty = parseInt(m[3], 10) || 1;
        items.push({
          name: dish,
          price: parseFloat(m[2]),
          qty,
          quantity: qty,
          lineTotal: parseFloat(m[4])
        });
      }
    }
    if (!restaurantName && str.includes('Your Cart')) {
      const ycMatch = str.match(/Your Cart\r?\n([^\n\r]+)/i);
      if (ycMatch) restaurantName = ycMatch[1].trim();
    }
  }

  let itemsTotal = null;
  const itemsTotMatch = str.match(/Items?\s*Total[:\s]*₹([0-9.]+)/i) || str.match(/Subtotal[:\s]*₹([0-9.]+)/i);
  if (itemsTotMatch) itemsTotal = parseFloat(itemsTotMatch[1]);

  let couponCode = null, discountAmount = 0;
  const coupMatch = str.match(/Coupon(?:\s+Discount)?\s*\(?([A-Z0-9_]+)\)?[:\s]*[-−–]\s*₹([0-9.]+)/i);
  if (coupMatch && coupMatch[1].toUpperCase() !== 'NOT') {
    couponCode = coupMatch[1].trim().toUpperCase();
    discountAmount = parseFloat(coupMatch[2]);
  }

  let swiggyOneMembershipFee = 0;
  const oneMatch = str.match(/Swiggy\s*One(?:\s*Lite)?\s*Membership[:\s]*\+?₹([0-9.]+)/i);
  if (oneMatch) swiggyOneMembershipFee = parseFloat(oneMatch[1]);

  let freeCashApplied = 0;
  const fcMatch = str.match(/(?:Swiggy\s*Money\s*\/\s*)?Free\s*Cash(?:\s*Applied)?\s*\)?[:\s]*[-−–]\s*₹([0-9.]+)/i);
  if (fcMatch) freeCashApplied = parseFloat(fcMatch[1]);

  let packingCharges = 0;
  const packMatch = str.match(/Packing\s*Charges[:\s]*₹([0-9.]+)/i);
  if (packMatch) packingCharges = parseFloat(packMatch[1]);

  let gstCharges = 0;
  const gstMatch = str.match(/GST\s*(?:&|and)\s*(?:Other\s*)?Charges[:\s]*₹([0-9.]+)/i);
  if (gstMatch) gstCharges = parseFloat(gstMatch[1]);

  let deliveryFee = 0;
  const delFeeNumMatch = str.match(/Delivery\s*Fee[:\s]*₹([0-9.]+)/i);
  if (delFeeNumMatch) deliveryFee = parseFloat(delFeeNumMatch[1]);

  let deliverySaved = 0;
  const delSavedMatch = str.match(/Delivery\s*Fee:\s*FREE\s*\(₹([0-9.]+)\s*saved\)/i)
    || str.match(/Free\s*Delivery:\s*₹0\s*\(₹([0-9.]+)\s*saved\)/i);
  if (delSavedMatch) deliverySaved = parseFloat(delSavedMatch[1]);

  let finalPayable = null;
  const payMatch = str.match(/Final\s*(?:Total|Payable)[:\s]*₹([0-9.]+)/i)
    || str.match(/To\s*Pay[:\s]*₹([0-9.]+)/i);
  if (payMatch) finalPayable = parseFloat(payMatch[1]);

  let totalSavings = 0;
  const savMatch = str.match(/Total\s*Savings[:\s]*₹([0-9.]+)/i);
  if (savMatch) totalSavings = parseFloat(savMatch[1]);

  const freeDelivery = /Delivery\s*Fee:\s*FREE/i.test(str) || /Free\s*Delivery\s*upto/i.test(str) || deliverySaved > 0;

  if (items.length > 0 || finalPayable || itemsTotal) {
    const calcSub = itemsTotal || Math.round(items.reduce((s, i) => s + (i.lineTotal || i.price * i.qty), 0) * 100) / 100;
    return {
      restaurantName,
      orderAccount,
      items,
      itemsTotal: calcSub,
      subtotal: calcSub,
      couponCode,
      discountAmount,
      swiggyOneMembershipFee,
      freeCashApplied,
      freeDelivery,
      deliverySaved,
      freeDeliveryDiscount: deliverySaved,
      deliveryFee,
      packingCharges,
      gstCharges,
      finalPayable,
      totalSavings
    };
  }
  return null;
}

// Helper to follow short-link redirects (up to 4 hops for swig.gy, onelink.me, maps.app.goo.gl)
async function expandShortUrl(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:\/\//i.test(current)) break;
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': DESKTOP_UA },
        signal: AbortSignal.timeout(4000)
      });
      const loc = res.headers.get('location');
      if (!loc) break;
      current = loc.startsWith('http') || loc.startsWith('swiggy://') || loc.startsWith('intent://')
        ? loc
        : new URL(loc, current).toString();
      if (current.startsWith('swiggy://') || current.startsWith('intent://')) break;
    } catch (e) {
      break;
    }
  }
  return current;
}

// Fast-resolve Swiggy links (Group Cart, Restaurant Menu, Shared Address, Google Maps, or Full Text)
export async function resolveSwiggyLink(input) {
  if (!input) return { url: input, type: 'UNKNOWN' };
  const rawInput = String(input).trim();

  // Extract first URL from input while STILL keeping full text for address/receipt parsing!
  const urlMatch = rawInput.match(/(https?:\/\/[^\s]+|www\.[^\s]+|maps\.app\.goo\.gl\/[^\s]+|swig\.gy\/[^\s]+)/i);
  let primaryUrl = urlMatch ? urlMatch[1].replace(/[,\.;\)]+$/, '') : rawInput;
  if (primaryUrl.startsWith('www.') || primaryUrl.startsWith('maps.app.goo.gl/') || primaryUrl.startsWith('swig.gy/')) {
    primaryUrl = 'https://' + primaryUrl;
  }

  let resolved = primaryUrl;
  let restaurantId = null;
  let groupCartId = null;
  let hostName = null;
  let ofoUser = null;
  let ofoToken = null;

  if (/^https?:\/\//i.test(primaryUrl) && (primaryUrl.includes('swig.gy') || primaryUrl.includes('onelink.me') || primaryUrl.includes('goo.gl') || primaryUrl.includes('google.com/maps'))) {
    resolved = await expandShortUrl(primaryUrl);
  }

  const combinedForMatch = `${primaryUrl} ${resolved}`;

  // 1. Group Cart URL pattern (e.g. https://swig.gy/gc/1467977/Umbashiya-642855918)
  const gcMatch = combinedForMatch.match(/\/gc\/([0-9]+)\/([^\/\-\s?]+)-([0-9]+)/i);
  if (gcMatch) {
    restaurantId = gcMatch[1];
    hostName = decodeURIComponent(gcMatch[2]);
    groupCartId = gcMatch[3];
  }

  // 2. Restaurant ID from menu URL
  const restMenuMatch = combinedForMatch.match(/\/restaurants\/[^\/\s?]+-([0-9]+)/i)
    || combinedForMatch.match(/\/menu\/([0-9]+)/i)
    || combinedForMatch.match(/restaurant_id=([0-9]+)/i);
  if (restMenuMatch && !restaurantId) {
    restaurantId = restMenuMatch[1];
  }

  // 3. Deep link query parameters (af_dp / deep_link_value / swiggy://)
  if (resolved.includes('swiggy://') || resolved.includes('af_dp=') || resolved.includes('deep_link_value=')) {
    try {
      const normalized = resolved.startsWith('http') ? resolved : 'https://' + resolved.replace(/^[a-z]+:\/\//i, 'swiggy.com/');
      const u = new URL(normalized);
      const afDp = u.searchParams.get('af_dp') || u.searchParams.get('deep_link_value') || '';
      const decoded = decodeURIComponent(afDp || resolved);
      const mRest = decoded.match(/restaurant_id=([0-9]+)/i);
      const mGc = decoded.match(/group_cart_id=([0-9]+)/i);
      const mHost = decoded.match(/host_name=([^&\s]+)/i);
      if (mRest && !restaurantId) restaurantId = mRest[1];
      if (mGc && !groupCartId) groupCartId = mGc[1];
      if (mHost && !hostName) hostName = decodeURIComponent(mHost[1]);

      const mOfo = decoded.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?&]+)/i);
      if (mOfo) {
        ofoUser = decodeURIComponent(mOfo[1]);
        ofoToken = mOfo[2];
      }
    } catch (e) {}
  }

  // 4. OFO web address URL & OneLink short address ID
  const ofoDirect = combinedForMatch.match(/\/ofo\/address\/([^\/\?\s]+)\/([^\/\?\s&]+)/i);
  if (ofoDirect) {
    ofoUser = decodeURIComponent(ofoDirect[1]);
    ofoToken = ofoDirect[2];
  }
  const onelinkAddrMatch = combinedForMatch.match(/onelink\.me\/[a-zA-Z0-9]+\/([a-zA-Z0-9_\-]+)/i);
  const isOneLinkShort = Boolean(onelinkAddrMatch && !ofoDirect);
  if (onelinkAddrMatch && !ofoToken) {
    ofoToken = onelinkAddrMatch[1];
  }

  // 5. Google Maps coordinates from expanded URL (@lat,lng, ?q=lat,lng, !3dlat!4dlng, ll=lat,lng)
  let mapCoords = null;
  const cMatch =
    combinedForMatch.match(/!3d(-?[0-9]{1,2}\.[0-9]{4,10})!4d(-?[0-9]{1,3}\.[0-9]{4,10})/) ||
    combinedForMatch.match(/[@?&](?:q|ll|query|center)?=?(-?[0-9]{1,2}\.[0-9]{4,10}),\s*(-?[0-9]{1,3}\.[0-9]{4,10})/) ||
    combinedForMatch.match(/@(-?[0-9]{1,2}\.[0-9]{4,10}),(-?[0-9]{1,3}\.[0-9]{4,10})/);
  if (cMatch) {
    mapCoords = { lat: cMatch[1], lng: cMatch[2] };
  }

  // 6. Structured text parsing on FULL input (preserves "Address: ..." sent alongside JgkQ link!)
  let parsedAddr = parseAddressDetails(rawInput);

  const isCart = Boolean(
    groupCartId ||
    restaurantId ||
    combinedForMatch.includes('/gc/') ||
    combinedForMatch.includes('group-order') ||
    combinedForMatch.includes('group_cart') ||
    primaryUrl.includes('/cart') ||
    primaryUrl.includes('/menu') ||
    rawInput.includes('Items Total')
  );
  const isAddress = !isCart && Boolean(
    ofoToken ||
    ofoUser ||
    mapCoords ||
    combinedForMatch.includes('ofo/address') ||
    combinedForMatch.includes('onelink.me') ||
    combinedForMatch.includes('maps.google') ||
    combinedForMatch.includes('google.com/maps') ||
    combinedForMatch.includes('goo.gl') ||
    parsedAddr
  );

  // Resolve full address details cleanly
  let addressDetails = null;
  if (parsedAddr) {
    addressDetails = await geocodeAddressDetails({
      ...parsedAddr,
      ...(mapCoords && !parsedAddr.lat ? mapCoords : {}),
      ...(ofoUser && !parsedAddr.name ? { name: ofoUser } : {})
    });
  } else if (mapCoords) {
    const rev = await reverseGeocodeCoords(mapCoords.lat, mapCoords.lng);
    addressDetails = {
      name: ofoUser || '',
      mobile: '',
      city: rev?.city || 'Delivery',
      area: rev?.area || '',
      landmark: rev?.landmark || '',
      address: rev?.address || `Pinned Location (${mapCoords.lat}, ${mapCoords.lng})`,
      lat: String(mapCoords.lat),
      lng: String(mapCoords.lng)
    };
  } else if (ofoToken) {
    const socialAddr = await resolveSharedOfoAddress(ofoToken, ofoUser);
    if (socialAddr) {
      addressDetails = socialAddr;
    } else if (isOneLinkShort) {
      // Bare AppsFlyer OneLink (JgkQ) without Swiggy's accompanying "Address: ..." text line:
      // NEVER overwrite existing real addresses with a placeholder string — flag cleanly!
      addressDetails = {
        name: ofoUser || '',
        token: ofoToken,
        unresolvableShortLink: true,
        city: '',
        mobile: '',
        address: '',
        lat: null,
        lng: null
      };
    }
  }

  // Parse structured cart text if present
  let parsedCart = parseCartDetails(rawInput);
  let groupCartStatus = null;

  // 7. LIVE GROUP CART FETCH (<100ms direct Swiggy shared_cart API — 100% genuine items, ZERO hardcoded dishes!)
  if (groupCartId) {
    const liveGc = await fetchLiveGroupCart(groupCartId, restaurantId, hostName);
    if (liveGc) {
      groupCartStatus = liveGc.status;
      if (liveGc.restaurantId) restaurantId = liveGc.restaurantId;
      if (liveGc.status === 'ACTIVE') {
        parsedCart = {
          restaurantName: liveGc.restaurantName || parsedCart?.restaurantName || null,
          items: liveGc.items || [],
          itemsTotal: liveGc.subtotal || 0,
          subtotal: liveGc.subtotal || 0,
          discountedSubtotal: liveGc.discountedSubtotal || liveGc.subtotal || 0,
          tradeDiscountTotal: liveGc.tradeDiscountTotal || 0,
          packingCharges: liveGc.packingCharges || 0,
          gstCharges: liveGc.taxesAndCharges || 0
        };
      }
    }
  }

  // 8. Fetch restaurant name / menu prices if needed
  let fastMenu = null;
  if (restaurantId && (!parsedCart?.restaurantName || (parsedCart?.items?.length > 0 && parsedCart.items.some(it => !it.itemId || !it.price)))) {
    fastMenu = await fetchFastRestaurantInfo(
      restaurantId,
      addressDetails?.lat || '26.8658609',
      addressDetails?.lng || '80.9307755',
      Boolean(parsedCart?.items?.length)
    );
    if (fastMenu?.menuItems && parsedCart?.items?.length > 0) {
      for (const it of parsedCart.items) {
        const match = fastMenu.menuItems.find(m =>
          m.name.toLowerCase() === it.name.toLowerCase() ||
          m.name.toLowerCase().includes(it.name.toLowerCase()) ||
          it.name.toLowerCase().includes(m.name.toLowerCase())
        );
        if (match) {
          if (!it.price || it.price === 0) it.price = match.price;
          if (!it.itemId) it.itemId = match.id;
          it.lineTotal = Math.round(it.price * (it.qty || 1) * 100) / 100;
        }
      }
    }
  }

  const realRestaurantName = parsedCart?.restaurantName || fastMenu?.restName || (hostName ? `${hostName}'s Group Order` : null);

  return {
    originalUrl: rawInput,
    primaryUrl,
    resolvedUrl: resolved,
    type: isCart ? 'CART' : (isAddress ? 'ADDRESS' : 'SWIGGY_GENERAL'),
    restaurantId,
    restaurantName: realRestaurantName,
    groupCartId,
    groupCartStatus,
    hostName,
    ofoUser,
    ofoToken,
    addressDetails,
    cartDetails: parsedCart
  };
}

// Honest bill calculation helper — NEVER fabricates imaginary coupons or fake fees!
export function applyMaxOfferToOrder(order) {
  if (!order) return order;

  let subtotal = Number(order.subtotal || order.itemTotal || 0);
  if (!subtotal && Array.isArray(order.items) && order.items.length > 0) {
    subtotal = Math.round(order.items.reduce((s, it) => s + (Number(it.lineTotal) || (Number(it.price || 0) * Number(it.qty || it.quantity || 1))), 0) * 100) / 100;
  }
  if (!subtotal && order.finalPayable > 0) {
    subtotal = Number(order.finalPayable);
  }
  if (!subtotal || subtotal <= 0) {
    return order;
  }

  order.subtotal = Math.round(subtotal * 100) / 100;
  order.itemTotal = order.itemTotal || order.subtotal;

  const discount = Number(order.discountAmount || 0);
  const tradeDisc = Number(order.tradeDiscountTotal || 0);
  const freeCash = Number(order.freeCashApplied || 0);
  const swiggyOneFee = Number(order.swiggyOneMembershipFee || 0);
  const delivery = Number(order.deliveryFee || 0);
  const packing = Number(order.packingCharges || 0);
  const taxes = Number(order.taxesAndCharges || 0);
  const freeDelSaved = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);

  if (!order.totalSavings || !order.swiggyVerified) {
    order.totalSavings = Math.round((freeDelSaved + discount + tradeDisc + freeCash) * 100) / 100;
  }

  // If Swiggy checkout returned an authoritative `order_total`, keep it intact unless manually changed
  if (!order.swiggyVerified || !order.finalPayable || Number(order.finalPayable) <= 0) {
    order.finalPayable = Math.max(
      1,
      Math.round(order.subtotal - discount - tradeDisc - freeCash + swiggyOneFee + delivery + (taxes > 0 ? taxes : packing))
    );
  }

  return order;
}

// Parse a live Swiggy /dapi/cart `data` payload into a normalized, 100% accurate cart object
function parseDapiCartPayload(data) {
  if (!data || !data.cartMeta) return null;
  const cm = data.cartMeta;
  const ciMap = data.cartItems || {};

  const items = Object.values(ciMap).map(ci => {
    const itemInfo = ci.items?.[0] || {};
    const qty = Number(ci.quantity || itemInfo.quantity || 1);
    const subPaise = Number(itemInfo.subtotal ?? (Number(itemInfo.base_price || itemInfo.price || 0) * qty));
    const finalPaise = Number(itemInfo.final_price ?? subPaise);
    const tradeDiscPaise = Number(itemInfo.subtotal_trade_discount || 0);
    const unitPrice = subPaise > 0 ? Math.round((subPaise / 100 / qty) * 100) / 100 : 0;
    const lineTotal = Math.round((subPaise / 100) * 100) / 100;
    const finalLineTotal = Math.round((finalPaise / 100) * 100) / 100;

    return {
      itemId: String(ci.itemId || itemInfo.menu_item_id || ''),
      menu_item_id: Number(ci.itemId || itemInfo.menu_item_id || 0),
      name: String(itemInfo.name || 'Dish Item').trim(),
      qty,
      quantity: qty,
      price: unitPrice,
      lineTotal,
      finalLineTotal,
      tradeDiscount: Math.round((tradeDiscPaise / 100) * 100) / 100,
      addons: Array.isArray(itemInfo.addons) ? itemInfo.addons : [],
      variants: Array.isArray(itemInfo.variants) ? itemInfo.variants : []
    };
  }).filter(it => it.name && it.qty > 0);

  const restDetails = cm.restaurant_details || {};
  const restaurantId = String(restDetails.id || restDetails.restaurant_id || cm.restaurantId || '');
  const restaurantName = restDetails.name || restDetails.restaurant_name || cm.restaurantName || null;

  const addresses = Array.isArray(cm.addresses) ? cm.addresses : [];
  const selectedRaw = addresses.find(a => a.selected || (cm.address_id && String(a.id) === String(cm.address_id))) || cm.delivery_address || null;
  let addressDetails = null;
  let address = null;
  if (selectedRaw && (selectedRaw.address || selectedRaw.area || selectedRaw.lat)) {
    address = `${selectedRaw.flat_no && selectedRaw.flat_no !== 'None' ? selectedRaw.flat_no + ', ' : ''}${selectedRaw.address || selectedRaw.area || ''}`.trim();
    addressDetails = {
      id: selectedRaw.id || cm.address_id || '',
      name: selectedRaw.name || '',
      mobile: selectedRaw.mobile || '',
      flat_no: selectedRaw.flat_no && selectedRaw.flat_no !== 'None' ? selectedRaw.flat_no : '',
      area: selectedRaw.area || '',
      landmark: selectedRaw.landmark || '',
      city: selectedRaw.city || 'Address',
      address,
      lat: String(selectedRaw.lat || ''),
      lng: String(selectedRaw.lng || ''),
      annotation: selectedRaw.annotation || ''
    };
  }

  // Extract eligible Swiggy One / One Lite plan nudge if Swiggy offers it on this account
  const renderingList = Array.isArray(cm.rendering_details) ? cm.rendering_details : [];
  const superNudge = renderingList.find(r => r.key === 'super_v3_nudge')?.meta || null;
  const planRaw = superNudge?.plan_details || null;
  const eligibleSuperPlan = planRaw?.plan_id
    ? {
        planId: String(planRaw.plan_id),
        name: planRaw.name || 'Swiggy One Lite Membership',
        priceRupees: Math.round((Number(planRaw.final_price ?? planRaw.base_price ?? 100) / 100) * 100) / 100
      }
    : null;

  const subItems = Array.isArray(data.subscriptionItems) ? data.subscriptionItems : [];
  const swiggyOneMembershipFee = Number(
    cm.subscription_total ||
    (subItems.length > 0 ? Number(subItems[0]?.final_price ?? subItems[0]?.base_price ?? 100) / 100 : 0) ||
    0
  );

  const itemTotal = Number(cm.item_total ?? cm.cart_subtotal_without_packing ?? cm.cart_subtotal ?? items.reduce((s, i) => s + i.lineTotal, 0));
  const deliveryFee = Number(cm.positiveDeliveryChargesExclusive ?? cm.delivery_charges ?? 0);

  // Delivery is genuinely FREE only when effective delivery charge is 0!
  // Never mistake promotional `deliveryChargeStrikeOffAmount` on a paid-delivery cart for FREE delivery!
  const swiggyOneApplied = deliveryFee <= 0 && Boolean(
    swiggyOneMembershipFee > 0 ||
    cm.swiggyOneBenefitsApplicable ||
    cm.oneLiteBenefitsApplicable ||
    cm.fullCouponLessFreeDeliveryApplied ||
    cm.is_swiggy_one_free_delivery_applicable ||
    cm.free_shipping ||
    Number(cm.free_delivery_discount) > 0 ||
    Number(cm.delivery_fee_reversal) > 0
  );
  const rawFreeDelSaved = deliveryFee <= 0
    ? Number(cm.free_delivery_discount || cm.delivery_fee_reversal || cm.deliveryChargeStrikeOffAmount || cm.strike_off_amount_without_tax || 0)
    : 0;
  const freeDeliveryDiscount = Math.round(rawFreeDelSaved * 100) / 100;

  // Coupon is valid ONLY when Swiggy confirms `is_coupon_valid === 1` OR `coupon_discount_total > 0`
  const isCouponValid = Boolean(cm.is_coupon_valid === 1 || Number(cm.coupon_discount_total) > 0);
  const couponCode = isCouponValid && cm.coupon_code ? String(cm.coupon_code).trim().toUpperCase() : null;
  const couponDiscount = isCouponValid ? Number(cm.coupon_discount_total ?? cm.coupon_discount_effective ?? 0) : 0;

  const tradeDiscountTotal = Number(cm.trade_discount_total ?? items.reduce((s, i) => s + (i.tradeDiscount || 0), 0));
  const packingCharges = Number(cm.total_packing_charges ?? cm.basePackagingCharges ?? cm.restaurant_packing_charges ?? cm.packaging_fee ?? 0);
  const taxesAndCharges = cm.taxesAndCharges !== undefined
    ? Number(cm.taxesAndCharges)
    : (Number(cm.total_tax || 0) + Number(cm.convenience_fees ?? cm.convenience_fee ?? cm.platform_fee ?? 0) + packingCharges);

  const freeCashBalance = Number(cm.user_swiggy_money ?? 0);
  const freeCashApplied = Number(cm.swiggy_money ?? 0);
  const orderTotal = Number(cm.order_total ?? 0);
  const totalSavings = Math.round((couponDiscount + tradeDiscountTotal + freeDeliveryDiscount + freeCashApplied) * 100) / 100;

  return {
    restaurantId,
    restaurantName,
    items,
    address,
    addressDetails,
    savedAddresses: addresses.map(a => ({
      id: a.id || '',
      city: a.city || 'Address',
      name: a.name || '',
      mobile: a.mobile || '',
      flat_no: a.flat_no && a.flat_no !== 'None' ? a.flat_no : '',
      area: a.area || '',
      landmark: a.landmark || '',
      address: `${a.flat_no && a.flat_no !== 'None' ? a.flat_no + ', ' : ''}${a.address || ''}`.trim(),
      lat: String(a.lat || ''),
      lng: String(a.lng || ''),
      annotation: a.annotation || ''
    })),
    eligibleSuperPlan,
    swiggyOneMembershipFee: Math.round(swiggyOneMembershipFee * 100) / 100,
    itemTotal: Math.round(itemTotal * 100) / 100,
    subtotal: Math.round(itemTotal * 100) / 100,
    tradeDiscountTotal: Math.round(tradeDiscountTotal * 100) / 100,
    deliveryFee: Math.round(deliveryFee * 100) / 100,
    freeDeliveryDiscount,
    swiggyOneApplied,
    swiggyOneSavings: freeDeliveryDiscount,
    couponCode,
    discountAmount: Math.round(couponDiscount * 100) / 100,
    freeCashBalance: Math.round(freeCashBalance * 100) / 100,
    freeCashApplied: Math.round(freeCashApplied * 100) / 100,
    packingCharges: Math.round(packingCharges * 100) / 100,
    taxesAndCharges: Math.round(taxesAndCharges * 100) / 100,
    finalPayable: Math.round(orderTotal > 0 ? orderTotal : Math.max(0, itemTotal - couponDiscount - tradeDiscountTotal + swiggyOneMembershipFee + deliveryFee + taxesAndCharges)),
    totalSavings
  };
}

// Fast inspect an active personal cart for a specific chosen account (<500ms direct DAPI call)
export async function inspectCartForAccount(accountOrCookies) {
  if (!accountOrCookies) return null;
  try {
    const auth = await getSwiggySessionAuth(accountOrCookies);
    if (auth?.sessionExpired) {
      return { sessionExpired: true };
    }
    const { json } = await dapiFetch(accountOrCookies, 'cart', { timeoutMs: 9000 });
    if (json?.statusCode === 1 && /session|login|unauthorized/i.test(json?.statusMessage || '')) {
      return { sessionExpired: true };
    }
    if (!json?.data || !json.data.cartMeta) {
      return { items: [], restaurantName: null, finalPayable: 0 };
    }
    return parseDapiCartPayload(json.data);
  } catch (err) {
    console.error('inspectCartForAccount error:', err.message);
    return null;
  }
}

// Verify Swiggy link and extract real cart & address details (<1s via live Group Cart + DAPI)
export async function verifyAndInspectSwiggyLink(url, cookies = '', accountSession = null) {
  if (!url) return { verified: false, message: 'No link provided' };

  const cleanUrl = String(url).trim();
  const isSwiggy = cleanUrl.includes('swiggy.com') || cleanUrl.includes('swiggy.onelink.me') || cleanUrl.includes('swig.gy');
  if (!isSwiggy) {
    return { verified: false, message: 'Not a valid Swiggy link' };
  }

  const meta = await resolveSwiggyLink(cleanUrl);
  const accObj = accountSession ? { ...accountSession, cookies: cookies || accountSession.cookies || '' } : cookies;

  // If link was a personal `/cart` URL rather than group cart, inspect active personal cart on account
  if ((!meta.cartDetails || !meta.cartDetails.items || meta.cartDetails.items.length === 0) && accObj) {
    const livePersonal = await inspectCartForAccount(accObj);
    if (livePersonal?.sessionExpired) {
      return { verified: false, sessionExpired: true, message: 'Swiggy session expired for this account' };
    }
    if (livePersonal?.items?.length > 0 && (!meta.restaurantId || String(livePersonal.restaurantId) === String(meta.restaurantId))) {
      return {
        verified: true,
        ...livePersonal,
        hostName: meta.hostName,
        groupCartId: meta.groupCartId,
        resolvedUrl: meta.resolvedUrl
      };
    }
  }

  const cd = meta.cartDetails || {};
  const items = cd.items || [];
  const itemTotal = cd.itemsTotal || cd.subtotal || 0;
  const discountAmount = cd.discountAmount || 0;
  const tradeDiscountTotal = cd.tradeDiscountTotal || 0;
  const packingCharges = cd.packingCharges || 0;
  const taxesAndCharges = cd.gstCharges || 0;
  const finalPayable = cd.finalPayable || Math.max(0, Math.round(itemTotal - discountAmount - tradeDiscountTotal + packingCharges + taxesAndCharges));

  return {
    verified: Boolean(items.length > 0 || meta.restaurantName),
    groupCartStatus: meta.groupCartStatus,
    restaurantName: meta.restaurantName || 'Swiggy Food Order',
    hostName: meta.hostName,
    restaurantId: meta.restaurantId,
    groupCartId: meta.groupCartId,
    items,
    address: meta.addressDetails?.address || null,
    addressDetails: meta.addressDetails || null,
    taxesAndCharges,
    packingCharges,
    swiggyOneMembershipFee: 0,
    itemTotal,
    subtotal: itemTotal,
    tradeDiscountTotal,
    deliveryFee: 0,
    freeDeliveryDiscount: 0,
    swiggyOneApplied: false,
    swiggyOneSavings: 0,
    couponCode: cd.couponCode || null,
    discountAmount,
    freeCashBalance: 0,
    freeCashApplied: cd.freeCashApplied || 0,
    finalPayable,
    totalSavings: Math.round((discountAmount + tradeDiscountTotal + (cd.freeCashApplied || 0)) * 100) / 100,
    resolvedUrl: meta.resolvedUrl
  };
}

// Extract real live tracking link from Swiggy account (<250ms zero-WAF API — NEVER fabricates fake tracking URLs!)
export async function extractRealSwiggyTracking(cookies = '') {
  if (!cookies) {
    return { trackingUrl: null, orderId: null, status: 'NO_COOKIES' };
  }
  try {
    const auth = await getSwiggySessionAuth(cookies, true);
    if (auth?.orders?.length > 0) {
      const latest = auth.orders[0];
      if (latest?.order_id) {
        return {
          trackingUrl: `https://www.swiggy.com/orders/track/${latest.order_id}`,
          orderId: String(latest.order_id),
          status: latest.order_status || 'ACTIVE'
        };
      }
    }
  } catch (err) {
    console.error('Error fetching real tracking link from Swiggy:', err.message);
  }
  return { trackingUrl: null, orderId: null, status: 'NOT_FOUND' };
}

// Verify payment status against authorized Swiggy API
export async function verifyPaymentStatusFromApi(cookies = '') {
  if (!cookies) return { paid: false, status: 'NO_COOKIES', orderId: null };
  const res = await extractRealSwiggyTracking(cookies);
  if (res && res.orderId) {
    const isPaid = ['placed', 'processing', 'in progress', 'delivered', 'confirmed'].includes(
      String(res.status).toLowerCase()
    );
    return {
      paid: isPaid,
      status: isPaid ? 'SUCCESS' : 'PENDING',
      orderId: res.orderId,
      trackingUrl: res.trackingUrl
    };
  }
  return { paid: false, status: 'PENDING', orderId: null, trackingUrl: null };
}

// ---------------------------------------------------------------------------
// MULTI-SOURCE SAVED ADDRESS FETCHER (<800ms, works even when personal cart is EMPTY!)
// Combines:
//   1. GET /dapi/cart -> data.cartMeta.addresses (all saved addresses nationwide when cart active)
//   2. GET https://maps.swiggy.com/addresses/nearby (CAS_HOST zero-WAF across Indian hubs + order coords)
//   3. GET /dapi/order/all -> orders[].delivery_address (historical addresses used on empty-cart accounts)
// ---------------------------------------------------------------------------
export async function fetchAccountAddresses(cookiesOrAcc) {
  if (!cookiesOrAcc) return [];
  try {
    const auth = await getSwiggySessionAuth(cookiesOrAcc);
    if (!auth || auth.sessionExpired) return [];

    const collected = [];
    const seenKeys = new Set();

    const addNormalized = (raw) => {
      if (!raw) return;
      const addrStr = String(raw.address || '').trim();
      if (!addrStr || addrStr.length < 4) return;
      const id = String(raw.id || '').trim();
      const lat = raw.lat ? String(raw.lat).trim() : '';
      const lng = raw.lng ? String(raw.lng).trim() : '';
      const normText = addrStr.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 45);
      const dedupeKey = id || `${lat.slice(0, 6)},${lng.slice(0, 6)}:${normText}`;
      if (seenKeys.has(dedupeKey)) return;

      // Also avoid near-identical coordinate duplicates
      if (lat && lng) {
        const dupByGeo = collected.find(existing =>
          existing.lat && existing.lng &&
          distanceMeters(existing.lat, existing.lng, lat, lng) < 35 &&
          (!id || !existing.id || existing.id === id)
        );
        if (dupByGeo) {
          if (!dupByGeo.id && id) dupByGeo.id = id;
          if (!dupByGeo.name && raw.name) dupByGeo.name = raw.name;
          if (!dupByGeo.mobile && raw.mobile) dupByGeo.mobile = raw.mobile;
          return;
        }
      }

      seenKeys.add(dedupeKey);
      collected.push({
        id,
        city: raw.city || 'Address',
        name: raw.name || '',
        mobile: raw.mobile || '',
        flat_no: raw.flat_no && raw.flat_no !== 'None' ? raw.flat_no : '',
        area: raw.area || '',
        landmark: raw.landmark || '',
        address: addrStr,
        lat,
        lng,
        annotation: raw.annotation || ''
      });
    };

    // Source 1: GET /dapi/cart -> cartMeta.addresses (returns ALL saved addresses globally if cart exists)
    const cartPromise = dapiFetch(cookiesOrAcc, 'cart', { timeoutMs: 7000 })
      .then(({ json }) => {
        const list = json?.data?.cartMeta?.addresses || [];
        for (const a of list) {
          addNormalized({
            id: a.id,
            city: a.city || 'Address',
            name: a.name || '',
            mobile: a.mobile || '',
            flat_no: a.flat_no,
            area: a.area || '',
            landmark: a.landmark || '',
            address: `${a.flat_no && a.flat_no !== 'None' ? a.flat_no + ', ' : ''}${a.address || ''}`.trim(),
            lat: a.lat,
            lng: a.lng,
            annotation: a.annotation || ''
          });
        }
      })
      .catch(() => {});

    // Source 2: CAS_HOST (https://maps.swiggy.com/addresses/nearby) across major hubs + order coords (zero WAF, ~80ms!)
    const probeCoords = [
      ['26.865861', '80.930776'], // Lucknow
      ['17.442991', '78.362384'], // Hyderabad
      ['28.613939', '77.209021'], // Delhi NCR
      ['19.075984', '72.877656'], // Mumbai
      ['12.971599', '77.594563'], // Bengaluru
      ['22.572646', '88.363895'], // Kolkata
      ['13.082680', '80.270718'], // Chennai
      ['18.520430', '73.856744'], // Pune
      ['26.912434', '75.787271'], // Jaipur
      ['25.182544', '75.839073'], // Kota
      ['25.594095', '85.137565']  // Patna
    ];
    for (const o of (auth.orders || [])) {
      const da = o?.delivery_address;
      if (da?.lat && da?.lng) {
        probeCoords.unshift([String(da.lat), String(da.lng)]);
      }
    }

    const casPromise = (auth.jwtTid && auth.userId)
      ? Promise.all(
          probeCoords.slice(0, 14).map(async ([la, ln]) => {
            try {
              const url = `https://maps.swiggy.com/addresses/nearby?lat_long=${la},${ln}&radius_mtr=50000&entity_type=1&entity_id=${encodeURIComponent(auth.userId)}&market_place_id=1&marketplace_business_lines=0`;
              const r = await fetch(url, {
                headers: buildChkoutHeaders(auth, la, ln, {
                  'client-id': 'checkout-web-app',
                  'source': 'web-cart'
                }),
                signal: AbortSignal.timeout(5000)
              });
              if (!r.ok) return;
              const j = await r.json().catch(() => null);
              for (const item of (j?.addresses || [])) {
                const aa = item?.actual_address;
                if (!aa) continue;
                const cat = Array.isArray(aa.address_category) ? aa.address_category[0] : aa.address_category;
                const tagLabel = aa.tags?.[0] || (cat === 1 ? 'Home' : cat === 2 ? 'Work' : 'Saved');
                addNormalized({
                  id: item.id || '',
                  city: aa.city || 'Address',
                  name: aa.contact_name || '',
                  mobile: aa.phone ? String(aa.phone).replace(/^\+?91/, '') : '',
                  flat_no: aa.address_line || '',
                  area: aa.locality || '',
                  landmark: aa.directions_to_reach || aa.locality || '',
                  address: `${aa.address_line ? aa.address_line + ', ' : ''}${aa.formatted_address || aa.locality || ''}`.trim(),
                  lat: aa.location?.lat,
                  lng: aa.location?.lng,
                  annotation: tagLabel
                });
              }
            } catch (e) {}
          })
        )
      : Promise.resolve();

    await Promise.all([cartPromise, casPromise]);

    // Source 3: Historical order `delivery_address` from GET /dapi/order/all (covers empty-cart accounts outside hub cities!)
    for (const o of (auth.orders || [])) {
      const da = o?.delivery_address;
      if (!da) continue;
      addNormalized({
        id: da.id || '',
        city: da.city || 'Address',
        name: da.name || '',
        mobile: da.mobile ? String(da.mobile).replace(/^\+?91/, '') : '',
        flat_no: da.flat_no || '',
        area: da.area || '',
        landmark: da.landmark || da.area || '',
        address: `${da.flat_no && da.flat_no !== 'None' ? da.flat_no + ', ' : ''}${da.address || da.address_line1 || da.area || ''}`.trim(),
        lat: da.lat,
        lng: da.lng,
        annotation: da.annotation || 'Past Order'
      });
    }

    return collected;
  } catch (err) {
    console.error('fetchAccountAddresses error:', err.message);
    return [];
  }
}

// Fetch saved addresses across ALL connected Swiggy accounts in parallel
export async function fetchAllAccountsSavedAddresses() {
  const candidates = getCandidateAccounts();
  const perAcc = await Promise.all(
    candidates.map(async ({ key, acc }) => {
      const addrs = await fetchAccountAddresses(acc);
      return addrs.map(a => ({
        ...a,
        accountKey: key,
        accountName: acc.name || acc.phone || key,
        accountPhone: acc.phone || ''
      }));
    })
  );
  const normAddr = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 45);
  const flat = [];
  for (const list of perAcc) {
    for (const a of list) {
      const dup = flat.find(x =>
        (x.id && a.id && x.id === a.id) ||
        (
          (!x.id || !a.id) &&
          x.lat && a.lat &&
          distanceMeters(x.lat, x.lng, a.lat, a.lng) < 35 &&
          normAddr(x.address) === normAddr(a.address)
        )
      );
      if (!dup) flat.push(a);
    }
  }
  return flat;
}

// Match or save delivery address into target Swiggy account via verified `POST /dapi/address`
// Ensures Swiggy binds a real `address_id` and calculates exact distance-based delivery charges!
export async function saveAddressToAccount(account, addrDetails, existingAddresses = null) {
  if (!account || !addrDetails) return { addressId: '', addressDetails: addrDetails || null, createdNew: false };

  const enriched = await geocodeAddressDetails(addrDetails, account);
  const savedList = Array.isArray(existingAddresses) ? existingAddresses : await fetchAccountAddresses(account);

  // 1. Reuse existing saved address on this account if ID matches or coordinates are within 80m!
  if (savedList.length > 0) {
    const existing = savedList.find(sa =>
      (enriched.id && sa.id && String(sa.id) === String(enriched.id)) ||
      (enriched.lat && enriched.lng && sa.lat && sa.lng && distanceMeters(sa.lat, sa.lng, enriched.lat, enriched.lng) < 80)
    );
    if (existing && existing.id) {
      return {
        addressId: String(existing.id),
        addressDetails: {
          ...enriched,
          id: String(existing.id),
          lat: enriched.lat || existing.lat,
          lng: enriched.lng || existing.lng,
          name: enriched.name || existing.name,
          mobile: enriched.mobile || existing.mobile,
          city: enriched.city || existing.city
        },
        createdNew: false
      };
    }
  }

  // 2. Create address on target Swiggy account using exact verified Swiggy web payload (`statusCode: 0`)
  if (!enriched.lat || !enriched.lng) {
    return { addressId: '', addressDetails: enriched, createdNew: false };
  }

  try {
    const auth = await getSwiggySessionAuth(account);
    if (!auth?.userId) return { addressId: '', addressDetails: enriched, createdNew: false };

    const rawPhone = String(enriched.mobile || account.phone || '9876543210').replace(/\D/g, '').slice(-10) || '9876543210';
    const citySlug = String(enriched.city || 'lucknow').trim();
    const flatNo = String(enriched.flat_no || enriched.address?.split(',')[0] || 'Ground Floor').trim().slice(0, 60);
    const areaStr = String(enriched.area || citySlug || 'Main Area').trim().slice(0, 80);
    const landmarkStr = String(enriched.landmark || areaStr || 'Near Main Road').trim().slice(0, 80);
    const fullAddr = String(enriched.address || `${flatNo}, ${areaStr}, ${citySlug}`).trim();

    const { json } = await dapiFetch(account, 'address', {
      method: 'POST',
      lat: enriched.lat,
      lng: enriched.lng,
      address: fullAddr,
      area: areaStr,
      body: {
        address: fullAddr,
        flat_no: flatNo,
        lat: String(enriched.lat),
        lng: String(enriched.lng),
        area: areaStr,
        landmark: landmarkStr,
        annotation: enriched.annotation || 'Order Delivery',
        addressCategory: 3,
        name: String(enriched.name || account.swiggyName || account.name || 'Customer').trim(),
        mobile: rawPhone,
        city: citySlug.toLowerCase(),
        is_edited: 1,
        cart_type: 'REGULAR',
        customer_id: String(auth.userId)
      }
    });

    const newId = json?.data?.id || json?.data?.address_id || '';
    if (json?.statusCode === 0 && newId) {
      return {
        addressId: String(newId),
        addressDetails: { ...enriched, id: String(newId) },
        createdNew: true
      };
    }
  } catch (err) {
    console.warn('[saveAddressToAccount] Warning:', err.message);
  }

  return { addressId: '', addressDetails: enriched, createdNew: false };
}

// Fetch recent orders from Swiggy account (<250ms direct API with clean cookies)
export async function fetchAccountOrders(cookiesOrAcc) {
  if (!cookiesOrAcc) return [];
  try {
    const auth = await getSwiggySessionAuth(cookiesOrAcc, true);
    if (!auth || !Array.isArray(auth.orders)) return [];
    return auth.orders.slice(0, 10).map(o => {
      const itemNames = (o.order_items || []).map(it => `${it.name}${it.quantity > 1 ? ' (' + it.quantity + ')' : ''}`);
      return {
        orderId: o.order_id,
        restaurantName: o.restaurant_name,
        status: o.order_status,
        items: itemNames,
        deliveryAddress: o.delivery_address?.area || o.delivery_address?.address || '',
        orderTime: o.order_time,
        orderTotal: o.order_total,
        trackingUrl: `https://www.swiggy.com/orders/track/${o.order_id}`
      };
    });
  } catch (err) {
    console.error('fetchAccountOrders error:', err.message);
    return [];
  }
}

// Format clean, exact Swiggy World receipt + Final Bill (matches user's exact format 100%)
export function formatSwiggyWorldCartReceipt(order, accountPhoneOrName = '') {
  const lines = [];

  const accStr = accountPhoneOrName || order.selectedAccountPhone || order.selectedAccount || '';
  if (accStr) {
    lines.push(`Order Account: ${accStr}\n`);
  }

  if (order.restaurantName) {
    lines.push(`Your Cart`);
    lines.push(`${order.restaurantName}\n`);
  }

  const addr = order.addressDetails || parseAddressDetails(order.address);
  if (addr && (addr.address || addr.lat || addr.name || addr.mobile)) {
    const cityLabel = addr.city ? `${addr.city} Address` : 'Delivery Address';
    lines.push(cityLabel);
    if (addr.name) lines.push(addr.name);
    if (addr.mobile) lines.push(addr.mobile);
    if (addr.flat_no && addr.address && !addr.address.startsWith(addr.flat_no)) {
      lines.push(addr.flat_no);
    }
    if (addr.address) {
      for (const aLine of String(addr.address).split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        lines.push(aLine);
      }
    }
    if (addr.lat) lines.push(`Latitude: ${addr.lat}`);
    if (addr.lng) lines.push(`Longitude: ${addr.lng}`);
    lines.push(`Select an Available Payment Method`);
  } else if (order.address && order.address !== 'Address pending / not provided' && !order.address.includes('onelink.me/JgkQ')) {
    lines.push(`Delivery Address`);
    lines.push(order.address);
    lines.push(`Select an Available Payment Method`);
  } else {
    lines.push(`Delivering To`);
    lines.push(`Address pending / share full address or map pin`);
  }
  lines.push('');

  if (order.items && order.items.length > 0) {
    for (const it of order.items) {
      lines.push(it.name);
      const price = typeof it.price === 'number' ? it.price : parseFloat(it.price || 0);
      const qty = it.qty || it.quantity || 1;
      const lineTotal = it.lineTotal !== undefined ? it.lineTotal : Math.round(price * qty * 100) / 100;
      lines.push(`₹${price} × ${qty} = ₹${lineTotal}\n`);
    }
    const totalQty = order.items.reduce((s, it) => s + (it.qty || it.quantity || 1), 0);
    const sub = order.itemTotal || order.subtotal || 0;
    const itemWord = totalQty === 1 ? 'Item' : 'Items';
    lines.push(`${totalQty} ${itemWord} • Subtotal: ₹${sub}\n`);
  }

  const hasItems = order.items && order.items.length > 0;
  const hasPayable = Boolean((order.finalPayable && Number(order.finalPayable) > 0) || (order.subtotal && Number(order.subtotal) > 0));

  if (hasItems || hasPayable) {
    lines.push(`Final Bill`);
    const sub = order.itemTotal || order.subtotal || 0;
    lines.push(`Items Total: ₹${sub > 0 ? sub : (order.finalPayable || 0)}`);

    if (order.tradeDiscountTotal && Number(order.tradeDiscountTotal) > 0) {
      lines.push(`Restaurant Offer Discount: −₹${order.tradeDiscountTotal}`);
    }

    if (order.couponCode && Number(order.discountAmount || 0) > 0) {
      lines.push(`Coupon ${order.couponCode}: −₹${order.discountAmount}`);
    } else if (order.couponCode) {
      lines.push(`Coupon ${order.couponCode}: −₹0`);
    }

    const oneFee = Number(order.swiggyOneMembershipFee || 0);
    if (oneFee > 0) {
      lines.push(`Swiggy One Lite Membership: +₹${oneFee}`);
    }

    if (order.freeCashApplied > 0) {
      lines.push(`Swiggy Money / Free Cash: −₹${order.freeCashApplied}`);
    }

    const freeDelSaved = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
    const isFreeDel = (Number(order.deliveryFee || 0) <= 0) && (freeDelSaved > 0 || order.swiggyOneApplied || oneFee > 0 || order.freeDelivery);

    if (isFreeDel) {
      lines.push(`Free Delivery upto 7km`);
      const savedTxt = freeDelSaved > 0 ? ` (₹${freeDelSaved} saved)` : '';
      lines.push(`Delivery Fee: FREE${savedTxt}`);
    } else if (Number(order.deliveryFee || 0) > 0) {
      lines.push(`Delivery Fee: ₹${order.deliveryFee}`);
    } else {
      lines.push(`Delivery Fee: FREE`);
    }

    if (order.packingCharges && Number(order.packingCharges) > 0) {
      lines.push(`Packing Charges: ₹${order.packingCharges}`);
    }

    const gst = order.taxesAndCharges || order.gstAndCharges || 0;
    if (gst > 0) {
      lines.push(`GST & Other Charges: ₹${gst}`);
    }

    lines.push(`━━━━━━━━━━━━━━`);
    if (Number(order.totalSavings || 0) > 0) {
      lines.push(`Total Savings: ₹${order.totalSavings}`);
    }
    if (order.finalPayable && Number(order.finalPayable) > 0) {
      lines.push(`Final Total: ₹${order.finalPayable}`);
    }
  } else {
    lines.push(`🛒 <b>Cart Status:</b> <i>Waiting for Swiggy items / cart verification...</i>`);
  }

  return lines.join('\n');
}

// Live capture real Swiggy checkout & payment screen using account cookies
export async function captureSwiggyPaymentScreenshot(cookies) {
  if (!cookies) return null;
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(DESKTOP_UA);

    const cleanStr = cleanSwiggyCookieString(cookies);
    const parsedCookies = cleanStr.split(';').map(s => s.trim()).filter(Boolean).map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });

    if (parsedCookies.length > 0) {
      await page.setCookie(...parsedCookies).catch(() => {});
    }

    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
    for (let i = 0; i < 18; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) {
        cachedWafToken = waf.value;
        cachedWafAt = Date.now();
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const stateInfo = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        isEmpty: text.includes('Your cart is empty'),
        isSignIn: text.includes('To place your order now, log in')
      };
    });

    if (stateInfo.isEmpty || stateInfo.isSignIn) {
      await browser.close().catch(() => {});
      return null;
    }

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 4000));

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const pp = els.find(e => e.innerText && (e.innerText.includes('PhonePe') || e.innerText.includes('UPI')));
      if (pp) pp.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    const buffer = await page.screenshot({ fullPage: false });
    await browser.close().catch(() => {});
    return buffer;
  } catch (err) {
    console.error('Failed to capture Swiggy payment screenshot:', err.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// Actively CLAIM Instamart Free Cash (₹50/₹60) and Freebies on Swiggy
export async function claimInstamartFreeCash(cookies) {
  if (!cookies) {
    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      balance: 0,
      amount: 0,
      reason: 'No session cookies or JSON provided',
      message: 'No cookies provided'
    };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(DESKTOP_UA);

    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) {
        cachedWafToken = waf.value;
        cachedWafAt = Date.now();
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    const cleanStr = cleanSwiggyCookieString(cookies);
    const parsedCookies = cleanStr.split(';').map(s => s.trim()).filter(Boolean).map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    if (parsedCookies.length > 0) {
      await page.setCookie(...parsedCookies).catch(() => {});
    }

    const initialCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        return {
          statusCode: json.statusCode,
          freeCash: cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0,
          swiggyOne: Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super)
        };
      } catch (err) {
        return { freeCash: 0, swiggyOne: false };
      }
    });

    const initialBalance = Number(initialCheck?.freeCash || 0);

    await page.goto('https://www.swiggy.com/instamart', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const claimExecutionResult = await page.evaluate(async () => {
      let clickedButton = false;
      let buttonText = '';
      let alreadyClaimedFound = false;
      let notEligibleFound = false;

      const allElements = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
      for (const el of allElements) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;
        if (/already claimed|already collected|offer collected|claimed|redeemed/i.test(text)) alreadyClaimedFound = true;
        if (/not eligible|not applicable|expired/i.test(text)) notEligibleFound = true;
        if (/^(claim|claim now|collect|opt-in|opt in|get free cash|claim ₹|claim 50|claim 60)/i.test(text)) {
          try {
            el.click();
            clickedButton = true;
            buttonText = text;
            break;
          } catch (e) {}
        }
      }

      let optInStatus = null;
      try {
        const optInRes = await fetch('https://www.swiggy.com/dapi/user/swiggy-money/opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({})
        });
        const optInJson = await optInRes.json().catch(() => ({}));
        optInStatus = optInJson?.statusCode || optInRes.status;
      } catch (e) {}

      try {
        await fetch('https://www.swiggy.com/dapi/rewards/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaign: 'instamart_free_cash' })
        }).catch(() => {});
      } catch (e) {}

      return { clickedButton, buttonText, alreadyClaimedFound, notEligibleFound, optInStatus };
    });

    await new Promise(r => setTimeout(r, 2000));

    const finalCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        return {
          statusCode: json.statusCode,
          freeCash: cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0,
          swiggyOne: Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super)
        };
      } catch (err) {
        return { freeCash: 0, swiggyOne: false };
      }
    });

    const finalBalance = Number(finalCheck?.freeCash || 0);

    if (finalBalance > initialBalance || (initialBalance === 0 && finalBalance > 0) || (claimExecutionResult.clickedButton && !claimExecutionResult.alreadyClaimedFound)) {
      const claimedAmt = finalBalance > initialBalance ? (finalBalance - initialBalance) : (finalBalance > 0 ? finalBalance : 50);
      return {
        status: 'CLAIMED',
        eligible: true,
        amount: claimedAmt,
        balance: finalBalance > 0 ? finalBalance : claimedAmt,
        freebieAvailable: true,
        swiggyOne: Boolean(finalCheck?.swiggyOne),
        details: `Successfully claimed ₹${claimedAmt} Free Cash! Current Balance: ₹${finalBalance > 0 ? finalBalance : claimedAmt}`
      };
    }

    if (claimExecutionResult.alreadyClaimedFound || (initialBalance > 0 && finalBalance === initialBalance)) {
      return {
        status: 'ALREADY_CLAIMED',
        eligible: true,
        amount: 0,
        balance: finalBalance,
        freebieAvailable: false,
        swiggyOne: Boolean(finalCheck?.swiggyOne),
        details: `Already claimed previously. Current Balance: ₹${finalBalance}`
      };
    }

    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: finalBalance,
      freebieAvailable: false,
      swiggyOne: Boolean(finalCheck?.swiggyOne),
      details: 'Account is not eligible for this promotional Free Cash or campaign.'
    };
  } catch (err) {
    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: 0,
      error: err.message,
      details: 'Error while executing claim engine: ' + err.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function checkAccountFreeCash(cookies) {
  return claimInstamartFreeCash(cookies);
}

// Fast profile name + mobile extractor (checks zero-WAF order/address data first in ~200ms, browser fallback)
export async function fetchSwiggyProfileFromCookies(cookies) {
  if (!cookies) return { name: null, phone: null };
  try {
    const auth = await getSwiggySessionAuth(cookies);
    if (auth?.orders?.length > 0) {
      const da = auth.orders[0]?.delivery_address;
      if (da?.name || da?.mobile) {
        return {
          name: da.name || null,
          phone: da.mobile ? String(da.mobile).replace(/^\+?91/, '') : null
        };
      }
    }
    const addrs = await fetchAccountAddresses(cookies);
    if (addrs.length > 0 && (addrs[0].name || addrs[0].mobile)) {
      return { name: addrs[0].name || null, phone: addrs[0].mobile || null };
    }
  } catch (e) {}

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent(DESKTOP_UA);
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const c = await page.cookies();
      if (c.find(x => x.name === 'aws-waf-token' && x.value.length > 50)) break;
      await new Promise(r => setTimeout(r, 400));
    }
    const cleanStr = cleanSwiggyCookieString(cookies);
    const parsedCookies = cleanStr.split(';').map(s => s.trim()).filter(Boolean).map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    if (parsedCookies.length > 0) await page.setCookie(...parsedCookies).catch(() => {});
    await page.goto('https://www.swiggy.com/my-account', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const result = await page.evaluate(() => {
      const editBtn = Array.from(document.querySelectorAll('*')).find(e => e.innerText?.trim() === 'EDIT PROFILE');
      if (editBtn && editBtn.parentElement) {
        const lines = editBtn.parentElement.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length >= 2) {
          const name = lines[1] !== 'EDIT PROFILE' ? lines[1] : (lines[0] || null);
          const phone = lines[2] || (lines[1].match(/\d{10}/) ? lines[1] : null);
          return { name, phone };
        }
      }
      return { name: null, phone: null };
    });
    await browser.close().catch(() => {});
    return result || { name: null, phone: null };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { name: null, phone: null };
  }
}

// Apply or remove a specific coupon code directly on Swiggy's live cart (`POST /dapi/cart/applyCoupon` / `removeCoupon`)
export async function applyLiveCouponToOrder(account, order, couponCode) {
  if (!account || !order) return null;
  const lat = order.addressDetails?.lat || '26.8658609';
  const lng = order.addressDetails?.lng || '80.9307755';
  const code = couponCode ? String(couponCode).trim().toUpperCase() : '';

  if (!code || code === 'REMOVE' || code === 'NONE' || code === 'CLEAR') {
    const { json } = await dapiFetch(account, 'cart/removeCoupon', {
      method: 'POST',
      body: {},
      lat,
      lng
    });
    return json?.data?.cartMeta ? parseDapiCartPayload(json.data) : null;
  }

  const { json } = await dapiFetch(account, 'cart/applyCoupon', {
    method: 'POST',
    body: { couponCode: code },
    lat,
    lng
  });
  if (json?.data?.cartMeta) {
    return parseDapiCartPayload(json.data);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SYNC GROUP CART, DELIVERY ADDRESS, SWIGGY ONE LITE (+₹1) & MAX COUPON ENGINE
// Fast API pipeline (<3s without screenshot, +checkout capture when needed):
//   1. Pre-claims Breakfast & Late Night ₹50 OFF event campaigns on the account
//   2. Resolves live Group Cart via `chkout.swiggy.com/api/v1/shared_cart`
//   3. Matches or saves customer's delivery address via `POST /dapi/address`
//   4. Syncs exact `menu_item_id`, `quantity`, `addons`, `variants` & `address_id` via `POST /dapi/cart`
//   5. Auto-adds eligible `+₹1` Swiggy One / One Lite Membership if it lowers `order_total` (FREE delivery!)
//   6. Discovers ALL real account/restaurant/payment/campaign coupons (`offers/payment`, `offers/restaurant`,
//      `menu/pl`, `DELULU4FOOD`, `STEALDEAL`, `MEALDEAL`, `FLAT150`, `TRYNEW`, etc.) and tests them on live cart,
//      strictly keeping whichever achieves MAXIMUM SAVINGS & MINIMUM `Final Total` (`order_total`)!
// ---------------------------------------------------------------------------
export async function syncGroupCartAndCheckoutForAccount(account, order, options = {}) {
  const { captureScreenshot = true } = options;
  if (!account) return { success: false, error: 'No account provided' };

  const cleanCookies = cleanSwiggyCookieString(account.cookies || '', account);
  if (!cleanCookies && !account.tid) {
    return { success: false, error: 'Account has no active session or cookies' };
  }

  try {
    // Step 1: Verify session auth (<250ms zero-WAF)
    const auth = await getSwiggySessionAuth(account, true);
    if (auth?.sessionExpired) {
      return {
        success: false,
        sessionExpired: true,
        accountPhone: account.phone || account.name,
        error: `Session expired on Swiggy for account ${account.phone || account.name}. Please re-login with OTP or Session JSON.`
      };
    }

    // Unlock Breakfast / Late Night ₹50 OFF campaigns BEFORE evaluating coupons (capped at 2s)
    await Promise.race([
      claimSwiggyBreakfastAndLateNightOffers(account).catch(() => null),
      new Promise(r => setTimeout(r, 2000))
    ]);

    // Step 2: Resolve Cart & Address links cleanly (without ever overwriting valid address details!)
    let cartMeta = null;
    if (order.cart) {
      try {
        cartMeta = await resolveSwiggyLink(order.cart);
      } catch (e) {}
    }

    const rawAddrSource = order.addressOriginalText || order.address || '';
    if (rawAddrSource && (!order.addressDetails || !order.addressDetails.lat)) {
      try {
        const addrMeta = await resolveSwiggyLink(rawAddrSource);
        if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
          order.addressDetails = { ...(order.addressDetails || {}), ...addrMeta.addressDetails };
        }
      } catch (e) {}
    }
    if (order.addressDetails) {
      order.addressDetails = await geocodeAddressDetails(order.addressDetails, account);
    }

    let restaurantId = cartMeta?.restaurantId || order.restaurantId || null;
    const groupCartId = cartMeta?.groupCartId || order.groupCartId || null;
    const hostName = cartMeta?.hostName || order.hostName || null;

    if (groupCartId) order.groupCartId = groupCartId;
    if (hostName) order.hostName = hostName;

    // Populate live Group Cart items if available
    if (cartMeta?.cartDetails?.items?.length > 0) {
      order.items = cartMeta.cartDetails.items;
      if (cartMeta.restaurantName) order.restaurantName = cartMeta.restaurantName;
    } else if (groupCartId) {
      const liveGc = await fetchLiveGroupCart(groupCartId, restaurantId, hostName, account);
      if (liveGc?.status === 'ACTIVE' && liveGc.items?.length > 0) {
        order.items = liveGc.items;
        restaurantId = liveGc.restaurantId || restaurantId;
        if (liveGc.restaurantName) order.restaurantName = liveGc.restaurantName;
      }
    }
    if (restaurantId) order.restaurantId = restaurantId;

    // Fetch saved addresses on this account (fast multi-source)
    const savedAddresses = await fetchAccountAddresses(account);
    if (!order.addressDetails && savedAddresses.length > 0) {
      order.addressDetails = savedAddresses[0];
      order.address = savedAddresses[0].address;
    }

    // Bind / save target delivery address on this Swiggy account so delivery fee is 100% accurate
    let targetAddressId = '';
    if (order.addressDetails) {
      const savedRes = await saveAddressToAccount(account, order.addressDetails, savedAddresses);
      targetAddressId = savedRes.addressId || '';
      if (savedRes.addressDetails) {
        order.addressDetails = savedRes.addressDetails;
        if (savedRes.addressDetails.address) {
          order.address = savedRes.addressDetails.address;
        }
        if (savedRes.createdNew && !savedAddresses.some(a => a.id === targetAddressId)) {
          savedAddresses.unshift(savedRes.addressDetails);
        }
      }
    }

    const lat = order.addressDetails?.lat || '26.8658609';
    const lng = order.addressDetails?.lng || '80.9307755';

    // Inspect current personal cart on this account BEFORE syncing so we preserve an already-matching live cart/coupon!
    let liveCart = await inspectCartForAccount(account);
    if (liveCart?.sessionExpired) {
      return {
        success: false,
        sessionExpired: true,
        accountPhone: account.phone || account.name,
        error: `Session expired on Swiggy for account ${account.phone || account.name}.`
      };
    }

    // Enrich missing itemIds from restaurant menu if user pasted dish names without menu_item_id
    if (restaurantId && Array.isArray(order.items) && order.items.length > 0 && order.items.some(it => !it.itemId && !it.menu_item_id)) {
      const menuInfo = await fetchFastRestaurantInfo(restaurantId, lat, lng, true);
      if (menuInfo?.menuItems) {
        if (!order.restaurantName && menuInfo.restName) order.restaurantName = menuInfo.restName;
        for (const it of order.items) {
          const match = menuInfo.menuItems.find(m =>
            m.name.toLowerCase() === it.name.toLowerCase() ||
            m.name.toLowerCase().includes(it.name.toLowerCase()) ||
            it.name.toLowerCase().includes(m.name.toLowerCase())
          );
          if (match) {
            it.itemId = match.id;
            it.menu_item_id = Number(match.id);
            if (!it.price) it.price = match.price;
          }
        }
      }
    }

    const syncableItems = (order.items || []).filter(it => it.itemId || it.menu_item_id);
    const sameCartAlreadyLoaded = Boolean(
      liveCart &&
      liveCart.items?.length > 0 &&
      restaurantId &&
      String(liveCart.restaurantId) === String(restaurantId) &&
      (!targetAddressId || String(liveCart.addressDetails?.id || '') === String(targetAddressId)) &&
      syncableItems.length === liveCart.items.length &&
      syncableItems.every(si => liveCart.items.some(li => String(li.itemId) === String(si.itemId || si.menu_item_id) && Number(li.qty) === Number(si.qty || si.quantity || 1)))
    );

    // Step 3: Push exact items + delivery address into chosen Swiggy account via verified `POST /dapi/cart`
    if (restaurantId && syncableItems.length > 0 && !sameCartAlreadyLoaded) {
      const initialCoupon = order.couponCode || liveCart?.couponCode || '';
      const { json: syncJson } = await dapiFetch(account, 'cart', {
        method: 'POST',
        lat,
        lng,
        address: order.addressDetails?.address || '',
        area: order.addressDetails?.area || '',
        body: {
          flushFirst: true,
          cart: {
            restaurantId: String(restaurantId),
            address_id: String(targetAddressId || ''),
            couponCode: String(initialCoupon || ''),
            cartItems: syncableItems.map(it => ({
              addons: Array.isArray(it.addons) ? it.addons : [],
              variants: Array.isArray(it.variants) ? it.variants : [],
              menu_item_id: Number(it.menu_item_id || it.itemId),
              quantity: Number(it.qty || it.quantity || 1)
            })),
            mealItems: [],
            subscriptionItems: []
          }
        }
      });
      if (syncJson?.data?.cartMeta) {
        liveCart = parseDapiCartPayload(syncJson.data);
      } else {
        liveCart = null;
      }
    }

    // Step 4: Auto-apply eligible Swiggy One / One Lite Plan (`+₹1` -> `FREE Delivery`) ONLY when it strictly lowers `finalPayable`!
    if (liveCart && liveCart.items?.length > 0 && liveCart.eligibleSuperPlan && liveCart.deliveryFee > liveCart.eligibleSuperPlan.priceRupees) {
      try {
        const planId = String(liveCart.eligibleSuperPlan.planId);
        const { json: subJson } = await dapiFetch(account, 'cart/addSubscriptionToCart', {
          method: 'POST',
          lat,
          lng,
          body: { subscriptionItems: [{ plan_id: planId, quantity: 1 }] }
        });
        if (subJson?.statusCode === 0 && subJson?.data?.cartMeta) {
          const withPlan = parseDapiCartPayload(subJson.data);
          if (withPlan && withPlan.items?.length > 0 && withPlan.finalPayable < liveCart.finalPayable) {
            liveCart = withPlan;
          }
        }
      } catch (e) {}
    }

    // Step 5: Complete Multi-Source Max-Coupon Engine!
    const availableCoupons = [];
    const pushCoupon = (code, title = '', description = '') => {
      const c = String(code || '').trim().toUpperCase();
      if (!c || c === 'NOT' || c === 'NONE' || c === 'NOFOMO' || availableCoupons.some(x => x.code === c)) return;
      availableCoupons.push({ code: c, title: title || c, description: description || 'Swiggy Offer' });
    };

    if (order.couponCode) pushCoupon(order.couponCode, order.couponCode, 'Order Coupon');
    if (liveCart?.couponCode) pushCoupon(liveCart.couponCode, liveCart.couponCode, 'Currently Applied');

    try {
      const cartVal = Math.round(liveCart?.finalPayable || liveCart?.subtotal || order.subtotal || 250);
      const [offersPayResp, offersRestResp, menuResp] = await Promise.all([
        restaurantId
          ? dapiFetch(
              account,
              `offers/payment?lat=${lat}&lng=${lng}&restaurantId=${restaurantId}&cart_value=${cartVal}&restaurant_id=${restaurantId}&sourcePage=cart&source_page=cart`,
              { lat, lng, timeoutMs: 7000 }
            )
          : Promise.resolve({ json: null }),
        restaurantId
          ? dapiFetch(account, `offers/restaurant?lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`, { lat, lng, timeoutMs: 6000 })
          : Promise.resolve({ json: null }),
        restaurantId
          ? dapiFetch(account, `menu/pl?page-type=REGULAR_MENU&complete-menu=false&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`, { lat, lng, timeoutMs: 7000 })
          : Promise.resolve({ json: null })
      ]);

      for (const blob of [offersPayResp?.json, offersRestResp?.json, menuResp?.json]) {
        if (!blob) continue;
        const rawStr = JSON.stringify(blob);
        for (const m of rawStr.matchAll(/"couponCode"\s*:\s*"([A-Z0-9_]{3,25})"/gi)) {
          pushCoupon(m[1], m[1], 'Swiggy Live Offer');
        }
      }
    } catch (e) {}

    const CAMPAIGN_CODES = [
      'DELULU4FOOD',
      'FLAT150',
      'FLAT140',
      'STEALDEAL',
      'MEALDEAL',
      'FLAT125',
      'TRYNEW',
      'WELCOMEBACK',
      'WELCOME50',
      'FLAT100',
      'BINGE',
      'PARTY',
      'JUMBO',
      'SWIGGYIT',
      'SWIGGY50',
      'FLAT75',
      'FLAT50'
    ];
    for (const std of CAMPAIGN_CODES) {
      pushCoupon(std, std, 'Swiggy Max Promo');
    }

    const isStrictlyBetterCart = (candidate, incumbent) => {
      if (!candidate || !candidate.items?.length) return false;
      if (!incumbent || !incumbent.items?.length) return true;
      if (candidate.finalPayable > 0 && incumbent.finalPayable > 0 && candidate.finalPayable !== incumbent.finalPayable) {
        return candidate.finalPayable < incumbent.finalPayable;
      }
      if ((candidate.discountAmount || 0) !== (incumbent.discountAmount || 0)) {
        return (candidate.discountAmount || 0) > (incumbent.discountAmount || 0);
      }
      return (candidate.totalSavings || 0) > (incumbent.totalSavings || 0);
    };

    if (liveCart && liveCart.items?.length > 0 && (!restaurantId || String(liveCart.restaurantId) === String(restaurantId))) {
      let bestCartState = liveCart;
      let bestCode = liveCart.couponCode || '';
      const validVerifiedCoupons = [];

      for (const cand of availableCoupons.slice(0, 18)) {
        if (cand.code === bestCode && bestCartState.discountAmount > 0) {
          validVerifiedCoupons.push({ ...cand, discountAmount: bestCartState.discountAmount, finalPayable: bestCartState.finalPayable });
          continue;
        }
        const tested = await applyLiveCouponToOrder(account, order, cand.code);
        if (tested && tested.items?.length > 0) {
          if (tested.couponCode === cand.code && tested.discountAmount > 0) {
            validVerifiedCoupons.push({
              ...cand,
              title: `${cand.code} (−₹${tested.discountAmount})`,
              discountAmount: tested.discountAmount,
              finalPayable: tested.finalPayable
            });
          }
          if (isStrictlyBetterCart(tested, bestCartState)) {
            bestCartState = tested;
            bestCode = tested.couponCode || cand.code;
          }
        }
      }

      validVerifiedCoupons.sort((a, b) => (b.discountAmount || 0) - (a.discountAmount || 0));
      if (validVerifiedCoupons.length > 0) {
        const validSet = new Set(validVerifiedCoupons.map(v => v.code));
        const remainder = availableCoupons.filter(c => !validSet.has(c.code));
        availableCoupons.length = 0;
        availableCoupons.push(...validVerifiedCoupons, ...remainder);
      }

      if (bestCode) {
        const finalApplied = await applyLiveCouponToOrder(account, order, bestCode);
        if (finalApplied && finalApplied.items?.length > 0) bestCartState = finalApplied;
      } else {
        const cleaned = await applyLiveCouponToOrder(account, order, 'REMOVE').catch(() => null);
        if (cleaned && cleaned.items?.length > 0) bestCartState = cleaned;
      }

      liveCart = bestCartState;
    }

    // Step 6: Populate `order` cleanly with 100% genuine Swiggy numbers
    if (liveCart && liveCart.items?.length > 0 && (!restaurantId || String(liveCart.restaurantId) === String(restaurantId))) {
      order.items = liveCart.items;
      if (liveCart.restaurantName) order.restaurantName = liveCart.restaurantName;
      order.restaurantId = liveCart.restaurantId || order.restaurantId;
      order.itemTotal = liveCart.itemTotal;
      order.subtotal = liveCart.subtotal;
      order.tradeDiscountTotal = liveCart.tradeDiscountTotal || 0;
      order.swiggyOneMembershipFee = liveCart.swiggyOneMembershipFee || 0;
      order.deliveryFee = liveCart.deliveryFee;
      order.freeDeliveryDiscount = liveCart.freeDeliveryDiscount;
      order.swiggyOneApplied = liveCart.swiggyOneApplied;
      order.swiggyOneSavings = liveCart.swiggyOneSavings;
      order.couponCode = liveCart.couponCode || null;
      order.discountAmount = liveCart.discountAmount || 0;
      order.freeCashBalance = liveCart.freeCashBalance || 0;
      order.freeCashApplied = liveCart.freeCashApplied || 0;
      order.packingCharges = liveCart.packingCharges || 0;
      order.taxesAndCharges = liveCart.taxesAndCharges || 0;
      order.finalPayable = liveCart.finalPayable;
      order.totalSavings = liveCart.totalSavings;
      order.swiggyVerified = true;
    } else {
      order.swiggyVerified = false;
      applyMaxOfferToOrder(order);
    }

    const cartData = {
      restaurantId: order.restaurantId,
      restaurantName: order.restaurantName,
      items: order.items || [],
      itemTotal: order.itemTotal || order.subtotal || 0,
      subtotal: order.subtotal || 0,
      tradeDiscountTotal: order.tradeDiscountTotal || 0,
      swiggyOneMembershipFee: order.swiggyOneMembershipFee || 0,
      finalTotal: order.finalPayable || order.subtotal || 0,
      finalPayable: order.finalPayable || order.subtotal || 0,
      couponCode: order.couponCode || null,
      discountAmount: order.discountAmount || 0,
      freeCashBalance: order.freeCashBalance || 0,
      freeCashApplied: order.freeCashApplied || 0,
      swiggyOneApplied: Boolean(order.swiggyOneApplied),
      swiggyOneSavings: order.swiggyOneSavings || 0,
      freeDeliveryDiscount: order.freeDeliveryDiscount || 0,
      deliveryFee: order.deliveryFee || 0,
      packingCharges: order.packingCharges || 0,
      taxesAndCharges: order.taxesAndCharges || 0,
      totalSavings: order.totalSavings || 0,
      address: order.address,
      addressDetails: order.addressDetails
    };

    // Optional real checkout screenshot when Boss selects account for payment
    let qrBuffer = null;
    if (captureScreenshot && liveCart?.items?.length > 0) {
      qrBuffer = await captureSwiggyPaymentScreenshot(account.cookies || cleanCookies).catch(() => null);
    }

    return {
      success: true,
      cartData,
      savedAddresses,
      availableCoupons,
      qrBuffer,
      paymentUrl: 'https://www.swiggy.com/payments'
    };
  } catch (err) {
    console.error('[syncGroupCartAndCheckoutForAccount] Error:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// MULTI-ACCOUNT MAX COUPON FINDER (`🏆 Auto Best Account + Max Coupon`)
// Tests ALL logged-in Swiggy accounts safely and locks in the #1 lowest `Final Total`!
// ---------------------------------------------------------------------------
export async function findBestMaxCouponAccountForOrder(order, options = {}) {
  const { captureScreenshot = true } = options;
  const db = getDb();
  const accounts = db?.config?.accounts || {};
  const liveEntries = Object.entries(accounts).filter(([, a]) => a.isLoggedIn && (a.cookies || a.tid));

  if (liveEntries.length === 0) {
    return { success: false, error: 'No logged-in Swiggy accounts available.' };
  }

  let bestResult = null;
  let bestKey = null;
  let bestOrderSnapshot = null;
  const accountComparison = [];

  for (const [key, acc] of liveEntries) {
    const preCart = await inspectCartForAccount(acc).catch(() => null);
    const hadPreExistingCart = Boolean(preCart?.items?.length > 0 && preCart?.restaurantId);

    const probeOrder = JSON.parse(JSON.stringify(order));
    const res = await syncGroupCartAndCheckoutForAccount(acc, probeOrder, { captureScreenshot: false });

    const restoreOrFlushAccount = async (targetAcc, savedPreCart, fallbackRestId) => {
      if (savedPreCart?.items?.length > 0 && savedPreCart?.restaurantId) {
        await dapiFetch(targetAcc, 'cart', {
          method: 'POST',
          lat: savedPreCart.addressDetails?.lat || '26.8658609',
          lng: savedPreCart.addressDetails?.lng || '80.9307755',
          body: {
            flushFirst: true,
            cart: {
              restaurantId: String(savedPreCart.restaurantId),
              address_id: String(savedPreCart.addressDetails?.id || ''),
              couponCode: String(savedPreCart.couponCode || ''),
              cartItems: savedPreCart.items.map(it => ({
                addons: Array.isArray(it.addons) ? it.addons : [],
                variants: Array.isArray(it.variants) ? it.variants : [],
                menu_item_id: Number(it.menu_item_id || it.itemId),
                quantity: Number(it.qty || it.quantity || 1)
              })),
              mealItems: [],
              subscriptionItems: []
            }
          }
        }).catch(() => {});
      } else if (fallbackRestId) {
        await dapiFetch(targetAcc, 'cart', {
          method: 'POST',
          body: { flushFirst: true, cart: { restaurantId: String(fallbackRestId), address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] } }
        }).catch(() => {});
      }
    };

    if (res?.success) {
      accountComparison.push({
        key,
        phone: acc.phone || key,
        name: acc.name || key,
        couponCode: probeOrder.couponCode || null,
        discountAmount: probeOrder.discountAmount || 0,
        totalSavings: probeOrder.totalSavings || 0,
        finalPayable: probeOrder.finalPayable || 0
      });

      const isBetter =
        !bestOrderSnapshot ||
        (probeOrder.finalPayable > 0 && bestOrderSnapshot.finalPayable > 0 && probeOrder.finalPayable < bestOrderSnapshot.finalPayable) ||
        (probeOrder.finalPayable === bestOrderSnapshot.finalPayable && (probeOrder.totalSavings || 0) > (bestOrderSnapshot.totalSavings || 0));

      if (isBetter) {
        if (bestKey && bestKey !== key && bestResult) {
          await restoreOrFlushAccount(accounts[bestKey], bestResult._preCart, bestOrderSnapshot?.restaurantId);
        }
        bestKey = key;
        bestResult = { ...res, _preCart: hadPreExistingCart ? preCart : null };
        bestOrderSnapshot = probeOrder;
      } else {
        await restoreOrFlushAccount(acc, hadPreExistingCart ? preCart : null, probeOrder.restaurantId);
      }
    }
  }

  if (!bestKey || !bestOrderSnapshot || !bestResult) {
    return { success: false, error: 'Could not sync cart on any active account.', accountComparison };
  }

  Object.assign(order, bestOrderSnapshot);
  order.selectedAccount = bestKey;
  order.orderAccount = accounts[bestKey]?.phone || bestKey;

  let qrBuffer = null;
  if (captureScreenshot && accounts[bestKey]) {
    qrBuffer = await captureSwiggyPaymentScreenshot(accounts[bestKey].cookies).catch(() => null);
  }

  return {
    ...bestResult,
    qrBuffer,
    winningKey: bestKey,
    winningAccount: accounts[bestKey],
    accountComparison
  };
}

// ===========================================================================
// REAL SWIGGY PAYMENT GATEWAY DYNAMIC UPI QR + LIVE ORDER CONFIRM & TRACKING
// ===========================================================================

function buildSwiggyPaymentsApiHeaders(account, auth, { cartId = '', addressId = '', lat = '', lng = '' } = {}) {
  const cookies = parseCookieMap(account?.cookies || '');
  const deviceId = auth?.deviceId || cookies._device_id || cookies._swuid || '';
  return {
    'content-type': 'application/json',
    'accept': '*/*',
    'origin': 'https://www.swiggy.com',
    'referer': 'https://www.swiggy.com/',
    'marketplaceid': '1',
    'statusbarheight': '0',
    'accessibility-enabled': 'false',
    'x-web-checkout-flow': 'payment',
    'x-checkout-webview': 'ANDROID',
    'iswebcachingxpenabled': 'false',
    'tid': auth?.jwtTid || cookies.tid || '',
    'cartid': String(cartId || ''),
    'swuid': cookies._swuid || deviceId,
    'marketplacebusinessline': 'regular',
    'token': account?.token || cookies.token || '',
    'platform': 'swiggy-android',
    'sid': auth?.sid || cookies._sid || '',
    'userid': String(auth?.userId || ''),
    'isfrombottombar': 'false',
    'custom-success-screen': 'false',
    'm_id': 'CHECKOUT',
    'x-client-id': 'web-payment',
    'browser-user-agent': DESKTOP_UA,
    'user-agent': DESKTOP_UA,
    'marketplacecategory': 'food',
    'issuperuser': 'false',
    'version-code': '1600',
    'deviceid': deviceId,
    'isfirstsessionpostdeployment': 'false',
    'iswebviewassetscached': 'false',
    'agent-type': 'Swiggy-Android',
    'analyticsplatform': 'an',
    'x-origin-id': 'ANDROID',
    'cartaddressid': String(addressId || ''),
    'addressid': String(addressId || ''),
    'lat': String(lat || ''),
    'lng': String(lng || ''),
    'tenant': 'SW-FOOD',
    'client-id': 'swiggy-android'
  };
}

/**
 * Places a REAL pending UPI Intent order on Swiggy (`POST https://payments.swiggy.com/api/v3/order/place`)
 * and extracts Swiggy's genuine merchant dynamic UPI QR URI (`upi://pay?pa=swiggyupi@...`),
 * exact Swiggy `order_id`, and `transactionId` (`paas_id`).
 * Never charges or confirms an unpaid order; only completes when scanned & paid in any UPI app.
 */
export async function generateRealSwiggyMerchantUpiQr(account, order) {
  if (!account?.cookies) {
    const err = new Error('Selected Swiggy account has no active session cookies.');
    err.diag = { code: 'QR_NO_ACCOUNT_COOKIES', stage: 'GENERATE_REAL_QR' };
    throw err;
  }

  let auth = await getSwiggySessionAuth(account, true);
  if (!auth?.userId || !auth?.jwtTid) {
    const err = new Error('Swiggy session expired or invalid (`userId`/`jwtTid` missing). Re-login account.');
    err.diag = { code: 'QR_AUTH_EXPIRED', stage: 'GENERATE_REAL_QR', hasCookies: Boolean(account.cookies) };
    throw err;
  }

  // Verify live Swiggy personal cart has items + `address_id`; re-sync automatically if stale/empty!
  let curCart = await dapiFetch(account, 'cart');
  let cm = curCart?.json?.data?.cartMeta || {};
  let itemCount = Number(curCart?.json?.data?.totalItemsCount || curCart?.json?.data?.cartItemsCount || 0);

  if ((!cm.address_id || !cm.order_total || itemCount <= 0) && (order?.cart || order?.cartLink || order?.items?.length)) {
    await syncGroupCartAndCheckoutForAccount(account, order, { captureScreenshot: false });
    auth = await getSwiggySessionAuth(account, true);
    curCart = await dapiFetch(account, 'cart');
    cm = curCart?.json?.data?.cartMeta || {};
    itemCount = Number(curCart?.json?.data?.totalItemsCount || curCart?.json?.data?.cartItemsCount || 0);
  }

  const cartId = String(cm.originalCartId || cm.cart_id || '');
  const addressId = String(cm.address_id || order?.addressDetails?.id || '');
  const lat = String(order?.addressDetails?.lat || cm.restaurant_details?.lat || '26.8467');
  const lng = String(order?.addressDetails?.lng || cm.restaurant_details?.lng || '80.9462');

  if (!addressId || Number(cm.order_total || 0) <= 0) {
    const err = new Error(
      `Swiggy checkout cart is empty or missing delivery address_id (items=${itemCount}, order_total=${cm.order_total || 0}, address_id="${addressId}", msg="${cm.statusMessage || ''}").`
    );
    err.diag = {
      code: 'QR_CART_NOT_READY',
      stage: 'GENERATE_REAL_QR',
      itemCount,
      cartOrderTotal: cm.order_total || 0,
      addressId,
      cartMessage: cm.statusMessage || cm.ctaText || ''
    };
    throw err;
  }

  const headers = buildSwiggyPaymentsApiHeaders(account, auth, { cartId, addressId, lat, lng });

  const placeRes = await fetch('https://payments.swiggy.com/api/v3/order/place', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      address_id: addressId,
      lat,
      lng,
      payment_cod_method: 'UPIIntent',
      order_comments: '',
      force_validate_coupon: false,
      upi_transaction_info: {
        intent_app: 'com.google.android.apps.nbu.paisa.user',
        intent_app_display_name: 'Google Pay'
      }
    })
  });

  const rawText = await placeRes.text();
  let json = null;
  try { json = JSON.parse(rawText); } catch (e) {}

  const orderData = json?.data?.order_data || json?.data?.orderData || null;
  let redir = orderData?.app_redirection_info ?? orderData?.appRedirectionInfo ?? null;
  if (typeof redir === 'string') {
    try { redir = JSON.parse(redir); } catch (e) { redir = null; }
  }

  const upiIntentUrl =
    redir?.upiRedirect?.upiIntentRedirect?.upiIntentUrl ||
    redir?.upi_intent_url ||
    orderData?.upiIntentUrl ||
    orderData?.upi_intent_url ||
    '';

  const swiggyOrderId = String(orderData?.order_id || orderData?.orderId || '');
  const paymentTxnId = String(
    redir?.upiRedirect?.upiIntentRedirect?.transactionId ||
    orderData?.targeted_marketplace_payment_reference_id ||
    orderData?.payment_info_v2?.payment_transactions?.[0]?.marketplace_reference_id ||
    ''
  );
  const liveOrderTotal = Number(orderData?.order_total ?? cm.order_total ?? order?.finalPayable ?? 0);

  if (!placeRes.ok || json?.statusCode !== 0 || !upiIntentUrl || !upiIntentUrl.startsWith('upi://')) {
    const err = new Error(
      `Swiggy payment gateway rejected QR creation: HTTP ${placeRes.status}, statusCode=${json?.statusCode}, msg="${json?.statusMessage || 'Unknown'}"`
    );
    err.diag = {
      code: 'SWIGGY_PLACE_ORDER_QR_FAILED',
      stage: 'POST_PAYMENTS_ORDER_PLACE',
      httpStatus: placeRes.status,
      swiggyStatusCode: json?.statusCode ?? null,
      swiggyMessage: json?.statusMessage || '',
      cartId,
      addressId,
      cartTotal: cm.order_total,
      rawSnippet: rawText.slice(0, 500)
    };
    throw err;
  }

  return {
    upiIntentUrl,
    swiggyOrderId,
    paymentTxnId,
    amount: liveOrderTotal,
    slaMinutes: orderData?.sla_time ? String(orderData.sla_time) : '',
    restaurantName: orderData?.restaurant_name || cm.restaurant_details?.name || order?.restaurantName || '',
    confirmWindowMs: Number(redir?.upiRedirect?.upiIntentRedirect?.upiIntentConfirmTimeInMs || 45000)
  };
}

/**
 * Checks LIVE payment status & extracts REAL Swiggy Order ID, Order Status, Rider Info & Live Tracking Data:
 * 1) Non-destructively checks `GET https://payments.swiggy.com/api/v3/vpa-txn-status?paas_id=<txnId>&payment_code=UPIIntent`
 * 2) As soon as `data === 'success'`, fires `POST https://payments.swiggy.com/api/v3/order/confirm?order_id=<id>` so Swiggy confirms kitchen dispatch!
 * 3) Verifies real paid order via `GET /dapi/order/all` + `GET /dapi/order/details?type=full&version=V2` + `GET /dapi/order/trackV4` + `GET /dapi/order/trackV2/de`.
 */
export async function checkRealSwiggyPaymentAndExtractTracking(account, order) {
  if (!account?.cookies) {
    const err = new Error('Selected Swiggy account has no session cookies while checking payment.');
    err.diag = { code: 'PAID_CHECK_NO_COOKIES', stage: 'CHECK_PAYMENT_AND_TRACKING' };
    throw err;
  }

  const auth = await getSwiggySessionAuth(account, true);
  if (!auth?.userId) {
    const err = new Error('Swiggy session expired while checking payment status.');
    err.diag = { code: 'PAID_CHECK_AUTH_EXPIRED', stage: 'CHECK_PAYMENT_AND_TRACKING' };
    throw err;
  }

  const headers = buildSwiggyPaymentsApiHeaders(account, auth);
  let gatewayTxnState = '';
  let targetOrderId = String(order?.pendingSwiggyOrderId || order?.swiggyOrderId || '');
  const pendingPaasId = String(order?.pendingSwiggyPaasId || '');

  // Step 1: Non-destructive live gateway check on the exact QR `paas_id` (`transactionId`)
  if (pendingPaasId) {
    try {
      const txnRes = await fetch(
        `https://payments.swiggy.com/api/v3/vpa-txn-status?paas_id=${encodeURIComponent(pendingPaasId)}&payment_code=UPIIntent`,
        { method: 'GET', headers }
      );
      const txnJson = await txnRes.json().catch(() => null);
      gatewayTxnState = String(txnJson?.data || '').toLowerCase();

      // ONLY confirm order on Swiggy AFTER payment genuinely succeeded (`success` / `completed`)!
      if (['success', 'completed', 'paid'].includes(gatewayTxnState) && targetOrderId) {
        await fetch(
          `https://payments.swiggy.com/api/v3/order/confirm?order_id=${encodeURIComponent(targetOrderId)}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ order_id: targetOrderId, transaction_id: pendingPaasId })
          }
        ).catch(() => {});
      }
    } catch (e) {}
  }

  // Step 2: Re-fetch fresh `/dapi/order/all` to detect either:
  //   - Exact paid `pendingSwiggyOrderId`, OR
  //   - Any brand-new paid Swiggy order placed on this account after `baselineSwiggyOrderId`!
  const freshAuth = await getSwiggySessionAuth(account, true);
  const recentOrders = freshAuth?.orders || auth?.orders || [];
  const baselineId = String(order?.baselineSwiggyOrderId || '');

  let matchedOrder = null;
  for (const o of recentOrders) {
    const oid = String(o?.order_id || '');
    if (!oid) continue;
    if (baselineId && oid === baselineId) break;
    if (targetOrderId && oid === targetOrderId) {
      matchedOrder = o;
      break;
    }
    if (!matchedOrder) matchedOrder = o;
  }

  // If order hasn't surfaced in `/dapi/order/all` yet, also check `order/details?order_id=<targetOrderId>&type=full&version=V2`
  if (!matchedOrder && targetOrderId) {
    const det = await dapiFetch(account, `order/details?order_id=${encodeURIComponent(targetOrderId)}&type=full&version=V2`).catch(() => null);
    const detOrder = det?.json?.data?.orders?.[0];
    if (detOrder) {
      const payState = String(detOrder?.payment_info_v2?.payment_transactions?.[0]?.state || '').toUpperCase();
      const postSt = String(detOrder?.post_status || '').toLowerCase();
      if (payState === 'STATE_SUCCESS' || ['processing', 'completed', 'delivered'].includes(postSt) || ['success', 'completed', 'paid'].includes(gatewayTxnState)) {
        matchedOrder = detOrder;
      }
    }
  }

  if (!matchedOrder) {
    return {
      paid: false,
      txnState: gatewayTxnState || 'pending'
    };
  }

  const payTxnState = String(matchedOrder?.payment_info_v2?.payment_transactions?.[0]?.state || '').toUpperCase();
  const statusStr = String(matchedOrder?.order_status || matchedOrder?.post_status || '').toLowerCase();
  const isPaidAndValid =
    (payTxnState === 'STATE_SUCCESS' || ['success', 'completed', 'paid'].includes(gatewayTxnState) || (!payTxnState && !/fail|cancel|pending_payment/i.test(statusStr))) &&
    !/cancel|fail|aborted|pending/i.test(statusStr === 'pending' ? 'pending' : (/cancel|fail|aborted/i.test(statusStr) ? statusStr : ''));

  // Wait: if `post_status === 'pending'` AND payment is NOT `STATE_SUCCESS`, customer hasn't paid yet!
  if (
    payTxnState === 'STATE_PENDING' ||
    payTxnState === 'STATE_FAILED' ||
    (String(matchedOrder?.post_status || '').toLowerCase() === 'pending' && payTxnState !== 'STATE_SUCCESS')
  ) {
    return {
      paid: false,
      txnState: gatewayTxnState || payTxnState.toLowerCase() || 'pending'
    };
  }

  if (!isPaidAndValid) {
    return {
      paid: false,
      txnState: gatewayTxnState || statusStr || 'pending'
    };
  }

  const confirmedOrderId = String(matchedOrder.order_id);
  const customerId = String(matchedOrder.customer_id || auth.userId || '');

  // Step 3: Fetch live `trackV4` + `trackV2/de` for real-time status text, ETA & rider coordinates!
  const [trkRes, deRes] = await Promise.all([
    dapiFetch(account, `order/trackV4?order_id=${encodeURIComponent(confirmedOrderId)}&type=full&version=V2&customer_id=${encodeURIComponent(customerId)}`).catch(() => null),
    dapiFetch(account, `order/trackV2/de?order_id=${encodeURIComponent(confirmedOrderId)}`).catch(() => null)
  ]);

  const trkData = trkRes?.json?.data || {};
  const deData = deRes?.json?.data || {};

  // Check if Swiggy returned any shareable link in trackV4 actions
  const allTrackJson = JSON.stringify(trkData);
  const shareMatch = allTrackJson.match(/https?:\/\/(?:www\.)?(?:swig\.gy|swiggy\.com)\/[^\s"\\]+/i);
  const nativeShareUrl =
    matchedOrder?.shareable_url ||
    trkData?.shareable_url ||
    (shareMatch && !/support\/issues/i.test(shareMatch[0]) ? shareMatch[0] : null);

  return {
    paid: true,
    txnState: 'success',
    swiggyOrderId: confirmedOrderId,
    customerId,
    orderStatus: trkData?.order_status_details?.status_message || matchedOrder?.order_status || 'Order Confirmed',
    statusSubText: trkData?.order_status_details?.status_tag_text || '',
    etaMinutes: String(matchedOrder?.sla_time || ''),
    restaurantName: matchedOrder?.restaurant_name || order?.restaurantName || '',
    restaurantAddress: matchedOrder?.restaurant_address || '',
    deliveryBoy: {
      name: matchedOrder?.delivery_boy?.name || deData?.name || '',
      mobile: matchedOrder?.delivery_boy?.mobile || deData?.mobile || '',
      lat: deData?.lat || deData?.location?.lat || null,
      lng: deData?.lng || deData?.location?.lng || null
    },
    deliveryAddress: matchedOrder?.delivery_address || order?.addressDetails || null,
    nativeShareUrl,
    swiggyWebTrackUrl: nativeShareUrl || `https://www.swiggy.com/track-order/${confirmedOrderId}`,
    swiggyAppDeepLink: `swiggy://track-order?order_id=${confirmedOrderId}`
  };
}

