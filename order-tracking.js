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
import {
  scanOrderAcrossAccounts,
  normalizeSwiggyOrderId,
  getStoredSwiggyTrackingUrl,
  isOfficialSwiggyTrackingUrl,
  extractOrderShareUrlDeep,
  dapiFetch
} from './swiggy-cart.js';

const inflightScans = new Map();
const autoTimers = new Map();

// Retry cadence: instant, then backing off to 30 min. Swiggy usually publishes
// the share link within the first minute after the kitchen accepts the order.
const DEFAULT_AUTO_DELAYS = [0, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];

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

function applyScanToOrder(order, scan) {
  if (!order || !scan) return { changedTracking: false, previousUrl: getStoredSwiggyTrackingUrl(order) };
  const previousUrl = getStoredSwiggyTrackingUrl(order);
  const candidates = [scan.trackingUrl, scan.nativeShareUrl, scan.swiggyWebTrackUrl]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const verifiedUrl = candidates.find(value => isOfficialSwiggyTrackingUrl(value, { allowProviderShortLink: true })) || '';
  if (verifiedUrl && verifiedUrl !== previousUrl) {
    order.trackingLink = verifiedUrl;
    order.trackingLinkSource = 'SWIGGY_API';
    order.shareTrackUrl = '';
    order.trackingFoundAt = new Date().toISOString();
  }
  if (scan.otp) order.deliveryOtp = String(scan.otp).replace(/\D/g, '').slice(0, 8);
  if (scan.orderStatus) order.liveOrderStatus = String(scan.orderStatus);
  if (scan.etaMinutes) order.etaMinutes = String(scan.etaMinutes);
  if (scan.deliveryBoy?.name) order.deliveryBoyName = String(scan.deliveryBoy.name);
  if (scan.deliveryBoy?.mobile) order.deliveryBoyMobile = String(scan.deliveryBoy.mobile);
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
  concurrency = 4,
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
    if (!target) {
      // Unknown-but-real Swiggy order (looked up by its numeric id): register it
      // only after Swiggy itself confirmed it exists on one of our accounts.
      if (!scan.hasOrder) {
        return { ...scan, orderId: order.id, trackingUrl: getStoredSwiggyTrackingUrl(order) || '' };
      }
      target = { ...order, isExternalOrder: true, isSwiggyIdLookup: true };
      freshDb.orders[target.id] = target;
    }
    const { changedTracking, previousUrl } = applyScanToOrder(target, scan);
    saveDb(freshDb);

    // Keep the caller's in-memory object in sync (it is often the same object).
    if (target !== order) applyScanToOrder(order, scan);

    if (changedTracking && trackingNotifier) {
      try {
        await trackingNotifier(target, { previousUrl, scan });
      } catch (err) {
        console.warn('[order-tracking] notifier failed:', err?.message || err);
      }
    }
    return { ...scan, orderId: order.id, trackingUrl: getStoredSwiggyTrackingUrl(target) || scan.trackingUrl || '' };
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

  const existing = autoTimers.get(key);
  if (existing && !existing.stopped && !force) return existing;

  stopOrderTrackingAuto(key);

  const state = { timer: null, attempts: 0, stopped: false, startedAt: Date.now() };
  autoTimers.set(key, state);

  const schedule = delay => {
    if (state.stopped) return;
    state.timer = setTimeout(runAttempt, Math.max(0, delay));
    if (typeof state.timer.unref === 'function') state.timer.unref();
  };

  const runAttempt = async () => {
    if (state.stopped) return;
    const fresh = findOrderRecord(key);
    if (!fresh || ['CANCELLED', 'REJECTED'].includes(String(fresh.status || ''))) {
      return stopOrderTrackingAuto(key);
    }
    if (getStoredSwiggyTrackingUrl(fresh)) {
      return stopOrderTrackingAuto(key);
    }
    state.attempts += 1;
    try {
      const result = await ensureOrderTracking(key, { budgetMs, deep, force });
      if (result?.trackingUrl) return stopOrderTrackingAuto(key);
    } catch (err) {
      console.warn('[order-tracking] auto scan failed:', err?.message || err);
    }
    if (state.attempts >= delays.length) {
      const freshDb = getDb();
      const target = freshDb.orders?.[key];
      if (target) {
        target.trackingAutoExhaustedAt = new Date().toISOString();
        saveDb(freshDb);
      }
      return stopOrderTrackingAuto(key);
    }
    schedule(delays[state.attempts]);
  };

  schedule((delays[0] ?? 0) + Math.max(0, Number(initialDelayMs) || 0));
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
  const trackingUrl = extractOrderShareUrlDeep(latest);
  return {
    ok: Boolean(orderId),
    orderId,
    status: String(latest?.order_status || ''),
    trackingUrl,
    accountPhone: String(acc.phone || acc.mobile || '')
  };
}
