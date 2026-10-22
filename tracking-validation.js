/**
 * Tracking validation — prevents fabricated Swiggy tracking URLs.
 * Real tracking URLs only come from authenticated Swiggy API responses
 * via extractSwiggyProvidedTrackingUrl and must pass isOfficialSwiggyTrackingUrl.
 */

// Standalone copy of isOfficialSwiggyTrackingUrl to avoid heavy swiggy-cart imports in tests
export function isOfficialSwiggyTrackingUrl(value, { allowProviderShortLink = false } = {}) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    const isProviderShortHost = host === 'swig.gy' || host === 'swiggy.onelink.me';
    const swiggyHost = isProviderShortHost || host === 'swiggy.com' || host.endsWith('.swiggy.com');
    const isRswiggyHost = host === 'r.swiggy.com' || host.endsWith('.r.swiggy.com');
    const pathHasTrackingContext = /track|tracking/i.test(url.pathname) ||
      (/share/i.test(url.pathname) && /order|track/i.test(url.pathname));
    const queryHasTrackingContext = /(?:^|[?&])(?:tracking_url|track_url|order_id|orderid)=/i.test(url.search) &&
      /order|track|share/i.test(url.pathname);
    const isExplicitSwiggyTrackingRoute = pathHasTrackingContext || queryHasTrackingContext;
    const isProviderShortLink = allowProviderShortLink && ((isProviderShortHost && url.pathname.length > 1) || (isRswiggyHost && url.pathname.length > 1));
    const isRswiggyTrackingShort = isRswiggyHost && url.pathname.length > 1;
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.port && swiggyHost &&
      (isExplicitSwiggyTrackingRoute || isProviderShortLink || isRswiggyTrackingShort) &&
      !/support\/issues|\/restaurant(?:s)?(?:\/|$)|\/menu(?:\/|$)|\/gc(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}


export const REQUIRED_RETRY_MESSAGE = 'Payment verified successfully. Swiggy tracking is not available yet. I\'ll retry shortly.';

/**
 * Detect if a URL appears to be fabricated by appending order ID to a generic Swiggy URL
 * or by using a placeholder like https://www.swiggy.com/track / /orders without order-specific data.
 * Such URLs are never valid per-order tracking links.
 */
export function isFabricatedTrackingUrl(url, orderId = '') {
  if (!url) return false;
  const u = String(url).trim();
  const oid = String(orderId || '').trim();
  // Generic placeholders that are not per-order tracking
  if (u === 'https://www.swiggy.com/track' || u === 'https://www.swiggy.com/orders' || u === 'https://www.swiggy.com/' || u === 'https://www.swiggy.com/track/') {
    return true;
  }
  if (/^https?:\/\/(www\.)?swiggy\.com\/(track|orders)\/?$/i.test(u)) {
    return true;
  }
  // Fabricated: generic Swiggy URL + orderId appended without proper tracking context
  // e.g., https://www.swiggy.com/orders/251576512345, https://swiggy.com/track/251..., https://r.swiggy.com/251576512345 (r.swiggy short links are random, not orderId)
  if (oid && u.toLowerCase().includes(oid.toLowerCase()) && /swiggy\.com/i.test(u)) {
    // r.swiggy.com short links should be random short codes, not numeric orderId — treat as fabricated if path is exactly orderId
    try {
      const parsed2 = new URL(u);
      const host2 = parsed2.hostname.toLowerCase();
      const path2 = parsed2.pathname; // e.g. /251576512349
      if ((host2 === 'r.swiggy.com' || host2.endsWith('.r.swiggy.com')) && (path2 === `/${oid}` || path2 === `/${oid}/`)) {
        return true; // fabricated: r.swiggy.com/<orderId> is not a genuine short link (genuine are random like /AbCdEf)
      }
    } catch {}
    // If it contains orderId but fails official validation, it's fabricated
    if (!isOfficialSwiggyTrackingUrl(u, { allowProviderShortLink: true })) {
      return true;
    }
    // Simple append pattern like https://www.swiggy.com/orders/251... or /track/251... without genuine tracking context is fabricated
    // But allow genuine tracking routes like /orders/track/<orderId> which Swiggy returns in tracking fields
    try {
      const parsed = new URL(u);
      const path = parsed.pathname;
      if (new RegExp(`^/(track|orders|order)/${oid}$`, 'i').test(path) || path === `/${oid}` || path === `/${oid}/`) {
        // Only reject simple /track/<oid> or /orders/<oid> at root, not /orders/track/<oid>
        // We already handled r.swiggy above, this is for www.swiggy.com simple guess
        return true;
      }
    } catch {}
    // For www.swiggy.com URLs with explicit tracking context (/track, /orders/track), do not reject here —
    // they are considered genuine if extracted from Swiggy API fields (e.g., swiggyOrderTrackingUrl)
    // Fabricated detection for swiggy.com is limited to generic placeholders handled above
    // and cross-order contamination handled in validateTrackingUrlForOrder
    
  }
  return false;
}

/**
 * Validate that a tracking URL is genuine, belongs to the expected order, and is from authoritative source.
 * @param {string} url - tracking URL to validate
 * @param {object} order - order object with swiggyOrderId / pendingSwiggyOrderId / id
 * @param {string} source - trackingLinkSource, must be SWIGGY_API or BOSS_PROVIDED, not fabricated
 * @returns {boolean}
 */
export function validateTrackingUrlForOrder(url, order, source = '') {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Must be valid HTTP(S) URL
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
  } catch {
    return false;
  }
  // Must pass official Swiggy tracking validation
  const allowProviderShort = source === 'SWIGGY_API';
  if (!isOfficialSwiggyTrackingUrl(trimmed, { allowProviderShortLink: allowProviderShort })) {
    return false;
  }
  // Must not be fabricated by appending order ID
  const orderId = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || order?.id || '').trim();
  if (isFabricatedTrackingUrl(trimmed, orderId)) {
    return false;
  }
  // Must not be generic placeholder
  if (trimmed === 'https://www.swiggy.com/orders' || trimmed === 'https://www.swiggy.com/track') {
    return false;
  }
  // Cross-order contamination check: if URL contains an order_id query param, it must match this order
  // e.g., https://www.swiggy.com/order-tracking?order_id=251... must match order.swiggyOrderId
  try {
    const parsed = new URL(trimmed);
    const qOrderId = parsed.searchParams.get('order_id') || parsed.searchParams.get('orderId') || parsed.searchParams.get('orderid');
    if (qOrderId && orderId && qOrderId !== orderId) {
      // URL contains a different order's ID — reject to prevent cross-order contamination
      return false;
    }
  } catch {}
  return true;
}

/**
 * Ensure no fabricated URL is stored on order — clear it and log.
 * Returns cleaned trackingLink or empty string.
 */
export function sanitizeTrackingLink(order) {
  if (!order || !order.trackingLink) return '';
  const url = String(order.trackingLink).trim();
  const source = String(order.trackingLinkSource || '').trim();
  // Only allow SWIGGY_API or BOSS_PROVIDED sources
  if (!['SWIGGY_API', 'BOSS_PROVIDED'].includes(source)) {
    // Clear fabricated source
    order.trackingLink = '';
    order.trackingLinkSource = '';
    order.shareTrackUrl = '';
    return '';
  }
  const orderId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  if (isFabricatedTrackingUrl(url, orderId)) {
    console.warn(`[TrackingValidation] Rejected fabricated URL for order ${order.id}: ${url}`);
    order.trackingLink = '';
    order.trackingLinkSource = '';
    order.shareTrackUrl = '';
    return '';
  }
  if (!validateTrackingUrlForOrder(url, order, source)) {
    console.warn(`[TrackingValidation] Rejected invalid tracking URL for order ${order.id}: ${url} source=${source}`);
    order.trackingLink = '';
    order.trackingLinkSource = '';
    order.shareTrackUrl = '';
    return '';
  }
  return url;
}

/**
 * Check if order has a genuine tracking link that belongs to this order.
 */
export function hasValidTrackingForOrder(order) {
  if (!order) return false;
  const url = String(order.trackingLink || '').trim();
  if (!url) return false;
  return validateTrackingUrlForOrder(url, order, String(order.trackingLinkSource || ''));
}
