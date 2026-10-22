// ============================================================================
// order-tracking.js — automatic Swiggy tracking-link engine
// ============================================================================
// Goal (user requirement): the moment an order is confirmed, the bot must fetch
// the official Swiggy tracking/share link by itself — exactly like opening
// "Profile → My Orders → latest order → Share" in the app — and push it to the
// Boss dashboard and the customer. Manual "Extract Tracking Link" stays as a
// fallback, but it can never hang for minutes again.
//
// Hard rules enforced here:
//   • A tracking link is only ever a URL that Swiggy itself returned.
//   • A false order id is never manufactured (no id is guessed from an index).
//   • Every scan runs under a time budget with capped concurrency.

import { getDb, saveDb } from './store.js';
import * as wafPool from './waf-pool.js';
import {
  scanOrderAcrossAccounts,
  normalizeSwiggyOrderId,
  normalizeSwiggyLiveOrderStatus,
  getStoredSwiggyTrackingUrl,
  isOfficialSwiggyTrackingUrl,
  validateTrackingUrlForOrder,
  extractOrderShareUrlDeep,
  dapiFetch,
  buildSignedOrderTrackUrl,
  getSwiggyOrderSnapshot,
  checkRealSwiggyPaymentAndExtractTracking
} from './swiggy-cart.js';

const inflightScans = new Map();
const autoTimers = new Map();

// Retry cadence: instant, then backing off to 30 min. Swiggy usually publishes
// the share link within the first minute after the kitchen accepts the order.
// WAF-aware retry cadence (2026-10-22 incident: the old [0,10s,30s,60s,2m,5m,
// 10m,15m,30m] burst — 9 full-vault scans in the first 30 minutes — triggered
// Swiggy's WAF rate-limit and blocked EVERY account for ~30+ min). The first
// two quick tries cover the common "link appears in 15-30s" case, then the
// cadence spaces out to 3–8 min gaps so the bot's IP stays under Swiggy's radar.
export const DEFAULT_AUTO_DELAYS = [0, 15_000, 180_000, 300_000, 480_000, 900_000, 1_500_000, 2_400_000];

let trackingNotifier = null;

/** Register the Telegram notifier (index.js) so this module stays cycle-free. */
export function setOrderTrackingNotifier(fn) {
  trackingNotifier = typeof fn === 'function' ? fn : null;
}

export function findOrderRecord(orderRef, db = null) {
  const database = db || getDb();
  if (!database?.orders) return null;
  if (orderRef && typeof orderRef === 'object') {
    return database.orders?.[orderRef.id] || orderRef;
  }
  const raw = String(orderRef ?? '').trim();
  if (!raw) return null;
  if (database.orders[raw]) return database.orders[raw];
  const lower = raw.toLowerCase();
  for (const order of Object.values(database.orders)) {
    if (!order) continue;
    if (String(order.id || '').toLowerCase() === lower) return order;
    if (String(order.swiggyOrderId || '') === raw) return order;
    if (String(order.pendingSwiggyOrderId || '') === raw) return order;
  }
  return null;
}

/** The only Swiggy order id we trust: a real numeric id returned by Swiggy. */
export function orderSwiggyOrderId(order) {
  return normalizeSwiggyOrderId(order?.swiggyOrderId) ||
    normalizeSwiggyOrderId(order?.pendingSwiggyOrderId);
}

/** Phone number of the Swiggy account that actually placed the order. */
export function orderPlacedFromPhone(order, db = null) {
  const database = db || getDb();
  const direct = String(
    order?.selectedAccountPhone ||
    order?.orderAccountPhone ||
    order?.placedFromPhone ||
    order?.pendingQrAddressAccount ||
    ''
  ).trim();
  if (direct) return direct.replace(/^\+?91/, '').replace(/\D/g, '').slice(-10) || direct;
  const accKey = order?.selectedAccount;
  if (accKey) {
    const acc = database?.config?.accounts?.[accKey];
    const phone = acc?.phone || acc?.mobile || '';
    if (phone) return String(phone).replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);
  }
  return '';
}

export function orderPlacedFromName(order, db = null) {
  const database = db || getDb();
  const accKey = order?.selectedAccount;
  const acc = accKey ? database?.config?.accounts?.[accKey] : null;
  return String(order?.selectedAccountName || acc?.name || acc?.swiggyName || '').trim();
}

/**
 * A Swiggy *live* status that means the trip is over. Tracking links are never
 * published by Swiggy for these orders, so retrying forever is pointless.
 * NOTE: this is deliberately NOT applied to the bot's own `status` field —
 * `COMPLETED` there only means "payment confirmed".
 */
export function isCancelledOrRefusedStatus(value) {
  return /cancelled|canceled|refused|returned/i.test(String(value || ''));
}

export function isTerminalDeliveryStatus(value) {
  // Deliberately narrow: "completed" is NOT matched. A false negative only costs
  // a few capped retries, while a false positive would silently skip tracking
  // for a live order — the worse failure. Swiggy post-delivery prompts on
  // trackV4 ("Rate your delivery", "How was your food?", etc.) ARE terminal.
  const raw = String(value || '').trim();
  if (!raw) return false;
  return /(?:delivered|rate\s+(?:your\s+)?(?:delivery|order|food|experience)|how\s+was\s+your\s+(?:food|order|delivery)|leave\s+a\s+review|tip\s+your\s+(?:delivery|rider|partner)|cancelled|canceled|refused|returned)/i.test(raw);
}

function applyScanToOrder(order, scan) {
  if (!order || !scan) return { changedTracking: false, previousUrl: getStoredSwiggyTrackingUrl(order) };
  const previousUrl = getStoredSwiggyTrackingUrl(order);
  const candidates = [scan.trackingUrl, scan.nativeShareUrl, scan.swiggyWebTrackUrl]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const verifiedUrl = candidates.find(value =>
    validateTrackingUrlForOrder(value, order, 'SWIGGY_API') ||
    (isOfficialSwiggyTrackingUrl(value, { allowProviderShortLink: true }) && validateTrackingUrlForOrder(value, { swiggyOrderId: scan.swiggyOrderId || order.swiggyOrderId }, 'SWIGGY_API'))
  ) || '';
  if (verifiedUrl && verifiedUrl !== previousUrl) {
    order.trackingLink = verifiedUrl;
    order.trackingLinkSource = 'SWIGGY_API';
    order.shareTrackUrl = '';
    order.trackingFoundAt = new Date().toISOString();
  }
  if (scan.otp) order.deliveryOtp = String(scan.otp).replace(/\D/g, '').slice(0, 8);
  if (scan.orderStatus) {
    order.liveOrderStatus = normalizeSwiggyLiveOrderStatus(scan.orderStatus) || String(scan.orderStatus);
  }
  if (scan.etaMinutes) order.etaMinutes = String(scan.etaMinutes);
  if (scan.deliveryBoy?.name) order.deliveryBoyName = String(scan.deliveryBoy.name);
  if (scan.deliveryBoy?.mobile) order.deliveryBoyMobile = String(scan.deliveryBoy.mobile);
  if (scan.deliveryBoy?.lat != null) order.deliveryBoyLat = scan.deliveryBoy.lat;
  if (scan.deliveryBoy?.lng != null) order.deliveryBoyLng = scan.deliveryBoy.lng;
  if (scan.restaurantName && (!order.restaurantName || /^swiggy\s+(?:order|food)$/i.test(String(order.restaurantName).trim()))) {
    order.restaurantName = String(scan.restaurantName);
  }
  if (scan.restaurantAddress && !order.restaurantAddress) {
    order.restaurantAddress = String(scan.restaurantAddress);
  }
  if (scan.restaurantLat != null && order.restaurantLat == null) order.restaurantLat = scan.restaurantLat;
  if (scan.restaurantLng != null && order.restaurantLng == null) order.restaurantLng = scan.restaurantLng;
  if (Array.isArray(scan.items) && scan.items.length > 0 && (!Array.isArray(order.items) || order.items.length === 0)) {
    order.items = scan.items;
  }
  if (Number(scan.orderTotal) > 0 && !Number(order.finalPayable)) {
    order.finalPayable = Number(scan.orderTotal);
  }
  if (scan.orderTime && !order.orderTime) {
    order.orderTime = String(scan.orderTime);
  }
  if (scan.deliveryAddress && (scan.deliveryAddress.address || scan.deliveryAddress.lat != null)) {
    const existingAd = (order.addressDetails && typeof order.addressDetails === 'object') ? order.addressDetails : {};
    order.addressDetails = {
      ...existingAd,
      ...(scan.deliveryAddress.name && !existingAd.name ? { name: scan.deliveryAddress.name } : {}),
      ...(scan.deliveryAddress.address && !existingAd.address ? { address: scan.deliveryAddress.address } : {}),
      ...(scan.deliveryAddress.area && !existingAd.area ? { area: scan.deliveryAddress.area } : {}),
      ...(scan.deliveryAddress.city && !existingAd.city ? { city: scan.deliveryAddress.city } : {}),
      ...(scan.deliveryAddress.mobile && !existingAd.mobile ? { mobile: scan.deliveryAddress.mobile } : {}),
      ...(scan.deliveryAddress.lat != null && existingAd.lat == null ? { lat: scan.deliveryAddress.lat } : {}),
      ...(scan.deliveryAddress.lng != null && existingAd.lng == null ? { lng: scan.deliveryAddress.lng } : {})
    };
    if (scan.deliveryAddress.address && !order.address) {
      order.address = scan.deliveryAddress.address;
    }
  }
  if (scan.accKey) {
    order.selectedAccount = scan.accKey;
    if (scan.accPhone) order.selectedAccountPhone = scan.accPhone;
    if (scan.accName) order.selectedAccountName = scan.accName;
    if (scan.accPhone) order.orderAccount = scan.accPhone;
  }
  order.trackingLastScanAt = new Date().toISOString();
  order.trackingScanStatus = scan.status;
  order.trackingScannedAccounts = Number(scan.scanned) || 0;
  return { changedTracking: Boolean(verifiedUrl && verifiedUrl !== previousUrl), previousUrl };
}

/**
 * Scan every logged-in Swiggy id for this order and persist whatever Swiggy
 * returns (tracking link, OTP, live status, and the account that owns it).
 */
export async function ensureOrderTracking(orderRef, {
  budgetMs = 18_000,
  deep = true,
  force = false,
  // 27+ account vaults: concurrency 4 timed out after scanning only ~8 IDs
  // (live incident 2026-10-22 3:48 PM). 6 keeps full coverage inside budget.
  concurrency = 6,
  getAccountsFn = null
} = {}) {
  const db = getDb();
  const order = findOrderRecord(orderRef, db);
  if (!order) return { status: 'ORDER_NOT_FOUND', hasOrder: false, trackingUrl: '' };

  const swiggyOrderId = orderSwiggyOrderId(order);
  if (!swiggyOrderId) {
    return { status: 'NO_SWIGGY_ID', hasOrder: false, trackingUrl: '', orderId: order.id };
  }

  const existingUrl = getStoredSwiggyTrackingUrl(order);
  if (existingUrl && !force) {
    return {
      status: 'TRACKING_FOUND',
      hasOrder: true,
      trackingUrl: existingUrl,
      swiggyOrderId,
      orderId: order.id,
      cached: true,
      accKey: order.selectedAccount || '',
      accPhone: orderPlacedFromPhone(order, db)
    };
  }

  // WAF circuit breaker: while Swiggy's rate-limit is hot, STOP sending more
  // bursts — hammering is exactly what keeps the block alive. Cooldown is
  // 3/5/10 min (escalating); scans resume automatically when it clears.
  const wafCooldownMs = wafPool.cooldownRemainingMs();
  if (wafCooldownMs > 0) {
    return { status: 'WAF_COOLDOWN', hasOrder: false, trackingUrl: '', scanned: 0, cooldownMs: wafCooldownMs };
  }

  const inflightKey = `${order.id}:${swiggyOrderId}`;
  if (inflightScans.has(inflightKey)) return inflightScans.get(inflightKey);

  const run = (async () => {
    const scan = await scanOrderAcrossAccounts(swiggyOrderId, {
      getAccountsFn,
      preferredAccountKey: order.selectedAccount || '',
      budgetMs,
      deep,
      concurrency
    });
    const freshDb = getDb();
    let target = freshDb.orders?.[order.id] || null;
    // If Swiggy confirmed the order exists on our account, also check whether
    // another bot order record for the same numeric Swiggy order id already
    // captured the verified Swiggy tracking link while the order was live.
    if (scan.hasOrder && !scan.trackingUrl) {
      for (const existing of Object.values(freshDb.orders || {})) {
        if (!existing) continue;
        if (orderSwiggyOrderId(existing) === swiggyOrderId) {
          const priorUrl = getStoredSwiggyTrackingUrl(existing);
          if (priorUrl) {
            scan.trackingUrl = priorUrl;
            break;
          }
        }
      }
    }
    if (!target) {
      // Unknown-but-real Swiggy order (looked up by its numeric id): register it
      // only after Swiggy itself confirmed it exists on one of our accounts.
      if (!scan.hasOrder) {
        return { ...scan, orderId: order.id, trackingUrl: getStoredSwiggyTrackingUrl(order) || '' };
      }
      target = { ...order, isExternalOrder: true, isSwiggyIdLookup: true };
      freshDb.orders[target.id] = target;
    }
    applyScanToOrder(target, scan);
    saveDb(freshDb);

    // Keep the caller's in-memory object in sync (it is often the same object).
    if (target !== order) applyScanToOrder(order, scan);

    // BUGFIX (notifier race): the scan itself may persist a verified link to
    // disk via `rememberSwiggyOrderTracking`'s order hydration WHILE scanning —
    // before `applyScanToOrder` above ran. In that case `changedTracking` is
    // false even though THIS scan is what surfaced the link, and the customer
    // would never receive the "Live Swiggy tracking ready" push. Compare the
    // final stored URL against the pre-scan state instead.
    const finalUrl = getStoredSwiggyTrackingUrl(target) || '';
    if (finalUrl && finalUrl !== existingUrl && trackingNotifier) {
      try {
        await trackingNotifier(target, { previousUrl: existingUrl, scan });
      } catch (err) {
        console.warn('[order-tracking] notifier failed:', err?.message || err);
      }
    }
    return { ...scan, orderId: order.id, trackingUrl: finalUrl || scan.trackingUrl || '' };
  })().finally(() => inflightScans.delete(inflightKey));

  inflightScans.set(inflightKey, run);
  return run;
}

export function stopOrderTrackingAuto(orderId) {
  const key = String(orderId || '');
  const state = autoTimers.get(key);
  if (!state) return false;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  autoTimers.delete(key);
  return true;
}

/**
 * Keep retrying in the background until Swiggy publishes the tracking link.
 * Fully non-blocking — safe to call from a Telegram handler.
 */
export function startOrderTrackingAuto(orderId, {
  delays = DEFAULT_AUTO_DELAYS,
  budgetMs = 15_000,
  deep = true,
  force = false,
  initialDelayMs = 0
} = {}) {
  const key = String(orderId || '');
  if (!key) return null;

  const order = findOrderRecord(key);
  if (!order) return null;
  if (getStoredSwiggyTrackingUrl(order)) return null;
  if (!orderSwiggyOrderId(order)) return null;
  if (['CANCELLED', 'REJECTED'].includes(String(order.status || ''))) return null;
  // Cancelled/refused orders never get tracking retries.
  if (isCancelledOrRefusedStatus(order.liveOrderStatus)) return null;
  // Delivered orders STILL get 1 automatic extraction pass so their Swiggy link
  // is captured even after delivery, without spinning an endless retry ladder
  // once post-delivery scanning has already completed.
  const isAlreadyDelivered = /delivered/i.test(String(order.liveOrderStatus || ''));
  if (isAlreadyDelivered && order.trackingLastScanAt && !force) return null;
  const effectiveDelays = isAlreadyDelivered ? [0] : delays;

  const existing = autoTimers.get(key);
  if (existing && !existing.stopped && !force) return existing;

  stopOrderTrackingAuto(key);

  const state = { timer: null, attempts: 0, stopped: false, startedAt: Date.now(), singlePass: isAlreadyDelivered };
  autoTimers.set(key, state);

  const schedule = delay => {
    if (state.stopped) return;
    state.timer = setTimeout(runAttempt, Math.max(0, delay));
    if (typeof state.timer.unref === 'function') state.timer.unref();
  };

  const runAttempt = async () => {
    if (state.stopped) return;
    // Wait out the WAF cooldown WITHOUT burning a retry attempt — the block
    // needs the quiet time to clear, and the ladder should not run out early.
    const wafCd = wafPool.cooldownRemainingMs();
    if (wafCd > 5000) {
      schedule(Math.min(wafCd + 5000, 15 * 60 * 1000));
      return;
    }
    const fresh = findOrderRecord(key);
    if (!fresh || ['CANCELLED', 'REJECTED'].includes(String(fresh.status || ''))) {
      return stopOrderTrackingAuto(key);
    }
    if (getStoredSwiggyTrackingUrl(fresh)) {
      return stopOrderTrackingAuto(key);
    }
    if (isCancelledOrRefusedStatus(fresh.liveOrderStatus)) {
      return stopOrderTrackingAuto(key);
    }
    state.attempts += 1;
    let result = null;
    try {
      result = await ensureOrderTracking(key, { budgetMs, deep, force });
      if (result?.trackingUrl) return stopOrderTrackingAuto(key);
    } catch (err) {
      console.warn('[order-tracking] auto scan failed:', err?.message || err);
    }
    const postScanOrder = findOrderRecord(key);
    const postStatus = String(postScanOrder?.liveOrderStatus || result?.orderStatus || '');
    // Once we have scanned a delivered/cancelled order at least once, stop the
    // background ladder rather than polling every 10s–30m indefinitely.
    if (isTerminalDeliveryStatus(postStatus) || state.attempts >= effectiveDelays.length) {
      const freshDb = getDb();
      const target = freshDb.orders?.[key];
      if (target) {
        target.trackingAutoExhaustedAt = new Date().toISOString();
        saveDb(freshDb);
      }
      return stopOrderTrackingAuto(key);
    }
    schedule(effectiveDelays[state.attempts]);
  };

  schedule((effectiveDelays[0] ?? 0) + Math.max(0, Number(initialDelayMs) || 0));
  return state;
}

/**
 * "Profile → My Orders → latest order" helper: read the newest order of one
 * account and return its genuine Swiggy share/tracking link (if published).
 */
export async function refreshLatestOrderTrackingForAccount(accKey) {
  const db = getDb();
  const acc = db.config?.accounts?.[accKey];
  if (!acc) return { ok: false, error: 'Account not found' };

  const listRes = await dapiFetch(acc, 'order/all', { timeoutMs: 7000 }).catch(() => null);
  const orders = Array.isArray(listRes?.json?.data?.orders) ? listRes.json.data.orders : [];
  const latest = orders[0];
  if (!latest) return { ok: false, error: 'No orders found on this account' };
  const orderId = normalizeSwiggyOrderId(latest.order_id);
  let trackingUrl = extractOrderShareUrlDeep(latest);
  if (!trackingUrl && orderId) {
    const customerId = String(latest?.customer_id || acc?.customerId || acc?.userId || '');
    const [detRes, trkRes, trackClassicRes] = await Promise.all([
      dapiFetch(acc, `order/details?order_id=${encodeURIComponent(orderId)}&type=full&version=V2`, { timeoutMs: 5000 }).catch(() => null),
      dapiFetch(acc, `order/trackV4?order_id=${encodeURIComponent(orderId)}&type=full&version=V2${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`, { timeoutMs: 5000 }).catch(() => null),
      dapiFetch(acc, `order/track?order_id=${encodeURIComponent(orderId)}`, { timeoutMs: 4000 }).catch(() => null)
    ]);
    const detOrder = detRes?.json?.data?.orders?.[0] || detRes?.json?.data?.order || null;
    trackingUrl = extractOrderShareUrlDeep(latest, detOrder, trkRes?.json?.data, trackClassicRes?.json?.data);
  }
  return {
    ok: Boolean(orderId),
    orderId,
    status: String(latest?.order_status || ''),
    trackingUrl,
    accountPhone: String(acc.phone || acc.mobile || '')
  };
}

/**
 * Resolve full live or delivered Swiggy order tracking/receipt payload for `/api/track/:orderId`.
 * Supports both internal bot order refs (`ORD...`) and standalone numeric Swiggy order IDs
 * (`251585352131266`) discovered in `Orders Done`, `Previous Orders`, or `Extract Tracking`.
 */
export async function resolveTrackEndpointPayload(orderId, {
  db = null,
  forceRefresh = false,
  getAccountsFn = null,
  onLiveDiscovery = null
} = {}) {
  const database = db || getDb();
  const cleanParam = String(orderId || '').trim();
  if (!cleanParam) {
    return { ok: false, statusCode: 404, error: 'Order not found' };
  }

  let order = findOrderRecord(cleanParam, database);
  const numericId = normalizeSwiggyOrderId(order?.swiggyOrderId || order?.pendingSwiggyOrderId || cleanParam);
  let snap = numericId ? getSwiggyOrderSnapshot(numericId) : null;

  if (!order && !numericId) {
    return { ok: false, statusCode: 404, error: 'Order not found' };
  }

  const rawKnownStatus = String(order?.liveOrderStatus || snap?.status || '');
  const knownStatus = normalizeSwiggyLiveOrderStatus(rawKnownStatus) || rawKnownStatus;
  const knownTerminal = isTerminalDeliveryStatus(knownStatus);
  const snapAgeMs = snap?.updatedAt ? (Date.now() - Number(snap.updatedAt)) : Infinity;
  const hasRichDetails = Boolean(
    (Array.isArray(order?.items) && order.items.length > 0) ||
    (Array.isArray(snap?.items) && snap.items.length > 0)
  ) && Boolean(
    order?.addressDetails?.address || order?.address || snap?.deliveryAddress?.address
  );

  const shouldRefresh = forceRefresh ||
    (!order && !snap) ||
    (!knownTerminal && snapAgeMs > 4000) ||
    (knownTerminal && !hasRichDetails && snapAgeMs > 15000);

  let live = null;
  let scan = null;

  if (shouldRefresh) {
    const acc = order?.selectedAccount ? database?.config?.accounts?.[order.selectedAccount] : null;
    const previousTrackingUrl = order ? getStoredSwiggyTrackingUrl(order) : '';
    const previousDeliveryOtp = String(order?.deliveryOtp || '');

    if (order && acc?.cookies && (order.swiggyOrderId || order.pendingSwiggyOrderId) && !knownTerminal && !getAccountsFn) {
      live = await checkRealSwiggyPaymentAndExtractTracking(acc, order).catch(() => null);
      if (live?.paid) {
        order.liveOrderStatus = normalizeSwiggyLiveOrderStatus(live.orderStatus) || live.orderStatus || order.liveOrderStatus;
        order.etaMinutes = live.etaMinutes || order.etaMinutes;
        if (live.deliveryBoy?.name) order.deliveryBoyName = live.deliveryBoy.name;
        if (live.deliveryBoy?.mobile) order.deliveryBoyMobile = live.deliveryBoy.mobile;
        if (live.deliveryOtp) order.deliveryOtp = live.deliveryOtp;
        const providerTrackCandidate = live.nativeShareUrl || live.swiggyWebTrackUrl || '';
        const providerTrackUrl = providerTrackCandidate
          ? getStoredSwiggyTrackingUrl({
              swiggyOrderId: live.swiggyOrderId || order.swiggyOrderId,
              trackingLink: providerTrackCandidate,
              trackingLinkSource: 'SWIGGY_API'
            })
          : '';
        if (providerTrackUrl) {
          order.trackingLink = providerTrackUrl;
          order.trackingLinkSource = 'SWIGGY_API';
          order.shareTrackUrl = '';
        }
        saveDb(database);
        if (
          typeof onLiveDiscovery === 'function' &&
          (getStoredSwiggyTrackingUrl(order) !== previousTrackingUrl || String(order.deliveryOtp || '') !== previousDeliveryOtp)
        ) {
          await Promise.resolve(onLiveDiscovery(order, database)).catch(() => {});
        }
      }
    }

    if (numericId && (!live?.paid || !order || !hasRichDetails)) {
      scan = await scanOrderAcrossAccounts(numericId, {
        getAccountsFn,
        preferredAccountKey: order?.selectedAccount || snap?.accKey || '',
        budgetMs: 8500,
        deep: true,
        concurrency: 4
      }).catch(() => null);

      if (scan?.hasOrder && order) {
        applyScanToOrder(order, scan);
        if (database?.orders?.[order.id]) {
          saveDb(database);
        }
      }
      snap = getSwiggyOrderSnapshot(numericId) || snap;
    }
  }

  if (!order && !snap && !scan?.hasOrder) {
    return { ok: false, statusCode: 404, error: 'Order not found on any connected Swiggy account' };
  }

  const finalSwiggyId = String(live?.swiggyOrderId || scan?.swiggyOrderId || order?.swiggyOrderId || order?.pendingSwiggyOrderId || snap?.orderId || numericId || '');
  const rawFinalStatus = String(live?.orderStatus || scan?.orderStatus || order?.liveOrderStatus || snap?.status || 'Order Confirmed');
  const finalStatus = normalizeSwiggyLiveOrderStatus(rawFinalStatus) || rawFinalStatus || 'Order Confirmed';
  const isCancelled = isCancelledOrRefusedStatus(finalStatus);
  const isDelivered = !isCancelled && /deliv/i.test(finalStatus);

  const rawItems = (Array.isArray(order?.items) && order.items.length > 0)
    ? order.items
    : (Array.isArray(scan?.items) && scan.items.length > 0 ? scan.items : (snap?.items || []));
  const normalizedItems = rawItems.map(it => {
    if (typeof it === 'string') return { name: it, qty: 1 };
    return {
      name: String(it?.name || it?.item_name || 'Item'),
      qty: Math.max(1, Number(it?.qty || it?.quantity || 1) || 1),
      ...(Number(it?.price) > 0 ? { price: Number(it.price) } : {})
    };
  });

  const mergedAddress = {
    ...(snap?.deliveryAddress || {}),
    ...(scan?.deliveryAddress || {}),
    ...(order?.addressDetails || {}),
    ...(live?.deliveryAddress || {})
  };
  if (!mergedAddress.address && order?.address) {
    mergedAddress.address = String(order.address);
  }

  const mergedRider = {
    name: String(live?.deliveryBoy?.name || scan?.deliveryBoy?.name || order?.deliveryBoyName || snap?.deliveryBoy?.name || ''),
    mobile: String(live?.deliveryBoy?.mobile || scan?.deliveryBoy?.mobile || order?.deliveryBoyMobile || snap?.deliveryBoy?.mobile || ''),
    lat: live?.deliveryBoy?.lat ?? scan?.deliveryBoy?.lat ?? order?.deliveryBoyLat ?? snap?.deliveryBoy?.lat ?? null,
    lng: live?.deliveryBoy?.lng ?? scan?.deliveryBoy?.lng ?? order?.deliveryBoyLng ?? snap?.deliveryBoy?.lng ?? null
  };

  const officialSwiggyUrl = (order ? getStoredSwiggyTrackingUrl(order) : '') ||
    (scan?.trackingUrl && validateTrackingUrlForOrder(scan.trackingUrl, { swiggyOrderId: finalSwiggyId }, 'SWIGGY_API') ? scan.trackingUrl : '') ||
    (snap?.trackingUrl && validateTrackingUrlForOrder(snap.trackingUrl, { swiggyOrderId: finalSwiggyId }, 'SWIGGY_API') ? snap.trackingUrl : '') ||
    '';

  const placedFrom = (order ? orderPlacedFromPhone(order, database) : '') ||
    String(scan?.accPhone || snap?.accPhone || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10) ||
    '';

  return {
    ok: true,
    statusCode: 200,
    payload: {
      ok: true,
      orderId: String(order?.id || finalSwiggyId || cleanParam),
      swiggyOrderId: finalSwiggyId,
      customerName: String(
        order?.addressDetails?.name ||
        order?.fwdSenderName ||
        order?.userName ||
        scan?.customerName ||
        snap?.customerName ||
        mergedAddress?.name ||
        'Customer'
      ),
      placedFrom,
      restaurantName: String(
        live?.restaurantName ||
        scan?.restaurantName ||
        (order?.restaurantName && !/^swiggy\s+order$/i.test(order.restaurantName) ? order.restaurantName : '') ||
        snap?.restaurantName ||
        order?.restaurantName ||
        'Swiggy Restaurant'
      ),
      restaurantAddress: String(live?.restaurantAddress || scan?.restaurantAddress || order?.restaurantAddress || snap?.restaurantAddress || ''),
      restaurantLat: live?.restaurantLat ?? scan?.restaurantLat ?? order?.restaurantLat ?? snap?.restaurantLat ?? null,
      restaurantLng: live?.restaurantLng ?? scan?.restaurantLng ?? order?.restaurantLng ?? snap?.restaurantLng ?? null,
      orderStatus: finalStatus,
      isDelivered,
      isCancelled,
      statusSubText: String(live?.statusSubText || ''),
      etaMinutes: isDelivered || isCancelled ? '' : String(live?.etaMinutes || scan?.etaMinutes || order?.etaMinutes || snap?.etaMinutes || ''),
      orderTime: String(
        scan?.orderTime ||
        order?.orderTime ||
        snap?.orderTime ||
        (order?.completedAt ? new Date(order.completedAt).toLocaleString('en-IN') : '')
      ),
      deliveryBoy: mergedRider,
      deliveryAddress: mergedAddress,
      items: normalizedItems,
      finalPayable: Number(order?.finalPayable || scan?.orderTotal || snap?.orderTotal || 0),
      swiggyWebTrackUrl: officialSwiggyUrl,
      signedTrackUrl: buildSignedOrderTrackUrl(finalSwiggyId || order?.id || cleanParam),
      deliveryOtp: String(live?.deliveryOtp || scan?.otp || order?.deliveryOtp || snap?.deliveryOtp || ''),
      updatedAt: new Date().toISOString()
    }
  };
}

