import {
  buildSwiggyAndroidClientHeaders, buildSwiggyCartItemsPayload, buildOfoCartFields,
  dapiFetch, fetchAccountAddresses, fetchSwiggyAndroidProfile, getSwiggySessionAuth, isValidIndianDeliveryCoordinates,
  parseDapiCartPayload, resolveSharedOfoAddress, saveAddressToAccount,
  swiggyCartGet, swiggyCartUpdate, verifySwiggySessionLive, withSwiggyAccountLock,
  checkRealSwiggyPaymentAndExtractTracking, detectOfoFromPlaceResponse, normalizeSwiggyOrderId,
  extractSwiggyProvidedTrackingUrl, extractSwiggyDeliveryOtp, isZeroSmsTestSandboxActive,
  extractDeepLinkFromReferrerOrUrl, fetchLiveGroupCart, resolveSwiggyLink, callSwiggyFoodMcpTool
} from './swiggy-cart.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { getDb } from './store.js';
import crypto from 'node:crypto';
import { sameCartItems, sameDeliveryRecipient, exactPaise } from './swiggy-cart-integrity.js';
import { executeSingleSwiggyPlacement } from './swiggy-placement-journal.js';
import { validateUpiIntentForQr } from './payment-qr-guard.js';
export { sameCartItems, sameDeliveryRecipient } from './swiggy-cart-integrity.js';

const bootFetch = globalThis.fetch;

function unavailable(message) {
  const e = new Error(message);
  e.statusCode = 502;
  return e;
}
function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function coords(address) {
  if (!isValidIndianDeliveryCoordinates(address?.lat, address?.lng)) {
    const e = new Error('Select an address with a verified map location first.');
    e.statusCode = 400;
    throw e;
  }
  return { lat: String(address.lat), lng: String(address.lng) };
}

function imageUrl(id) {
  const value = String(id || '');
  return /^[\w./-]{1,300}$/.test(value)
    ? 'https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_300,h_300,c_fill/' + value
    : '';
}

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 18) return;
  visit(node);
  if (Array.isArray(node)) node.forEach(n => walk(n, visit, depth + 1));
  else Object.values(node).forEach(n => walk(n, visit, depth + 1));
}

function successCode(value) { return value === 0 || value === '0'; }

function optionalBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

async function discovery(account, route, lat, lng) {
  try {
    const auth = await getSwiggySessionAuth(account);
    if (!auth || (!auth.jwtTid && !auth.token)) return null;
    const response = await fetch(`https://disc.swiggy.com/api/v1/${route}`, {
      headers: buildSwiggyAndroidClientHeaders(account, {
        tid: auth.jwtTid, token: auth.token, sid: auth.sid, deviceId: auth.deviceId, userId: auth.userId, lat, lng
      }),
      signal: AbortSignal.timeout(6000)
    });
    const payload = await response.json().catch(() => null);
    return response.ok && successCode(payload?.statusCode) && payload?.data ? payload : null;
  } catch { return null; }
}

function searchRestaurants(json) {
  const result = [];
  const seen = new Set();
  walk(json?.data, (node) => {
    const info = node?.restaurant?.info || node?.info;
    if (!info || !info.id || !info.name || seen.has(String(info.id))) return;
    if (!info.sla && !Array.isArray(info.cuisines)) return;
    seen.add(String(info.id));
    const avail = info.availability || {};
    const open = info.isOpen ?? avail.opened;
    result.push({
      id: String(info.id), name: String(info.name), image: imageUrl(info.cloudinaryImageId),
      rating: String(info.avgRatingString || info.avgRating || ''),
      ratings: String(info.totalRatingsString || ''),
      cuisines: Array.isArray(info.cuisines) ? info.cuisines.join(', ') : '',
      area: String(info.areaName || info.locality || ''),
      distance: String(info.sla?.lastMileTravelString || ''),
      time: String(info.sla?.slaString || ''),
      isOpen: optionalBoolean(open),
      opens: String(avail.nextOpenTimeMessage || '')
    });
  });
  return result.slice(0, 100);
}

function dishInfo(info) {
  if (!info?.id || !info?.name || !/^\d+$/.test(String(info.id)) || !Number.isSafeInteger(Number(info.id))) return null;
  const pricePaise = Number(info.finalPrice ?? info.price ?? info.defaultPrice ?? 0);
  const variants = info.variantsV2?.variantGroups || info.variants_v2?.variant_groups || info.variants?.variantGroups || [];
  const addons = info.addons || [];
  const customizable = (Array.isArray(variants) && variants.length > 0) || (Array.isArray(addons) && addons.length > 0);
  const stock = optionalBoolean(info.inStock);
  const veg = optionalBoolean(info.isVeg);
  return {
    id: String(info.id), name: String(info.name),
    price: Number.isFinite(pricePaise) && pricePaise > 0 ? Math.round(pricePaise) / 100 : null,
    description: String(info.description || ''), image: imageUrl(info.imageId || info.cloudinaryImageId),
    inStock: stock, isVeg: veg, customizable,
    offer_ids: Array.isArray(info.offerIds) ? info.offerIds : [],
    item_offer_cart_meta: String(info.itemOfferCartMeta || '')
  };
}

function parseMenu(json, restaurantId) {
  let info = null;
  const categories = [];
  const names = new Set();
  const cards = json?.data?.cards || [];
  for (const card of cards) {
    const candidate = card?.card?.card?.info;
    if (candidate?.name && (candidate.id || candidate.cuisines)) { info = candidate; break; }
  }
  walk(cards, (node) => {
    if (!Array.isArray(node.itemCards)) return;
    const items = node.itemCards.map(it => dishInfo(it?.card?.info || it?.info)).filter(Boolean);
    if (!items.length) return;
    const title = String(node.title || 'Menu');
    if (names.has(title)) return;
    names.add(title);
    categories.push({ title, items });
  });
  if (!info || !categories.length) throw unavailable('Swiggy did not return a usable restaurant menu.');
  const opened = info.isOpen ?? info.availability?.opened;
  return {
    restaurant: {
      id: String(info.id || restaurantId), name: String(info.name),
      area: String(info.areaName || info.locality || ''),
      rating: String(info.avgRatingString || info.avgRating || ''),
      ratings: String(info.totalRatingsString || ''),
      time: String(info.sla?.slaString || ''),
      isOpen: optionalBoolean(opened),
      opens: String(info.availability?.nextOpenTimeMessage || ''), image: imageUrl(info.cloudinaryImageId)
    }, categories
  };
}

// Short links are followed without credentials and only to these Swiggy hosts.
// This avoids exposing account cookies to redirects or using a link as SSRF.
const SHARE_HOSTS = new Set(['swig.gy', 'swiggy.onelink.me', 'www.swiggy.com', 'swiggy.com', 'm.swiggy.com']);
function shareUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw badRequest('Paste a valid Swiggy share link.'); }
  if (url.protocol !== 'https:' || !SHARE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443')) {
    throw badRequest('Only HTTPS Swiggy share links are accepted.');
  }
  return url;
}

export async function expandProShareLink(raw) {
  let current = shareUrl(raw).toString();
  for (let i = 0; i < 4; i++) {
    const deep = extractDeepLinkFromReferrerOrUrl(current);
    if (deep && (/\/ofo\/address\/|\/gc\//i.test(deep))) return deep;
    const url = shareUrl(current);
    if (url.hostname === 'www.swiggy.com' || url.hostname === 'swiggy.com') return current;
    let response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(4500), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
    } catch { return current; }
    const location = response.headers.get('location');
    if (!location) return current;
    const resolved = new URL(location, current).toString();
    const resolvedDeep = extractDeepLinkFromReferrerOrUrl(resolved);
    if (resolvedDeep && (/\/ofo\/address\/|\/gc\//i.test(resolvedDeep))) return resolvedDeep;
    try { current = shareUrl(resolved).toString(); } catch { return current; }
  }
  return current;
}

/**
 * Boss (31-10-2026): "CART KO BHI PARSE NAHI KAR PAA RAHA SALA."
 *
 * Swiggy group cart link sirf ek shakal me nahi aata. Yahan sabse pehle koi
 * network call ke bina, plain text se hi cart id nikaal lete hain:
 *   1. https://www.swiggy.com/gc/<x>/<slug>-<cartId>      (web share — purana)
 *   2. https://www.swiggy.com/gc/<cartId>                 (chhota web link)
 *   3. ...?sharedCartId= / ?groupCartId= / ?shared_cart_id= (query wale)
 *   4. swiggy://gc?... / swiggy://share?text=<encoded url>  (app deep link)
 *   5. swig.gy / swiggy.onelink.me short link  → resolveGroupCartLink expand karta hai
 * Kuch bhi match na ho to `null` — jhootha cart id kabhi nahi.
 */
const GROUP_CART_QUERY_KEYS = ['sharedCartId', 'shared_cart_id', 'groupCartId', 'group_cart_id', 'groupcartid', 'cartId', 'cart_id', 'sharedCart', 'shared_cart'];
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
export function extractGroupCartRef(raw) {
  const original = String(raw || '').trim();
  if (!original || original.length > 4000) return null;
  // URL-encoded ya swiggy://share?text=... ke andar chhupa hua link bhi kholte hain.
  const variants = [original, safeDecode(original)];
  const deep = (() => { try { return new URL(original).searchParams.get('text') || ''; } catch { return ''; } })();
  if (deep) variants.push(safeDecode(deep));
  const text = variants.join('\n');

  // 1 & 2: /gc/ path — trailing number hi group cart id hai (jaise pehle tha).
  const pathMatch = text.match(/\/gc\/([A-Za-z0-9_-]{1,40})(?:\/(?:[^/?#\s]*-)?(\d{1,20}))?/i);
  if (pathMatch) {
    const cartId = pathMatch[2] || (/^\d{1,20}$/.test(pathMatch[1]) ? pathMatch[1] : '');
    if (cartId) return { cartId, restaurantId: pathMatch[2] ? pathMatch[1] : '', shape: 'gc-path' };
  }
  // 3 & 4: query / deep-link parameters.
  for (const key of GROUP_CART_QUERY_KEYS) {
    const match = text.match(new RegExp(`[?&#;]${key}=([A-Za-z0-9_-]{1,40})`, 'i'));
    if (match && /\d/.test(match[1])) {
      const restaurantMatch = text.match(/[?&#;](?:restaurantId|restaurant_id)=(\d{1,20})/i);
      return { cartId: match[1], restaurantId: restaurantMatch ? restaurantMatch[1] : '', shape: 'gc-query' };
    }
  }
  return null;
}

/**
 * Sirf Swiggy ke host ya bare text (bina host) se seedha parse karte hain —
 * kisi doosre host ka `/gc/1/x-2` jaisa text jhootha cart id na ban jaye.
 */
function groupCartTextAllowed(text) {
  const value = String(text || '').trim();
  if (/^swiggy:\/\//i.test(value)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  try { return SHARE_HOSTS.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
}

/** Link ko samajhne ki ek hi jagah — short link pehle expand hota hai. */
export async function resolveGroupCartLink(raw) {
  const direct = groupCartTextAllowed(raw) ? extractGroupCartRef(raw) : null;
  if (direct) return { ...direct, expanded: String(raw).trim() };
  let expanded = '';
  try {
    expanded = await expandProShareLink(raw);
  } catch (err) {
    // shareUrl ka apna saaf message (http / doosra host) — wahi dikhao.
    throw badRequest(`${err?.message || 'Link padha nahi ja saka.'} Swiggy ka group cart link paste karein (swiggy.com/gc/... ya app ka Share link).`);
  }
  const ref = extractGroupCartRef(expanded);
  if (ref) return { ...ref, expanded };
  // Akhri raasta: bot ka battle-tested resolver. Ye AppsFlyer ke HTML page,
  // swiggy://webviewV2?group_cart_id=… aur af_dp/deep_link_value wale share
  // link bhi padh leta hai — inhi par "cart parse nahi hua" hota tha.
  const vendor = await resolveSwiggyLink(String(raw).trim()).catch(() => null);
  if (vendor?.groupCartId) {
    return {
      cartId: String(vendor.groupCartId),
      restaurantId: String(vendor.restaurantId || ''),
      hostName: String(vendor.hostName || ''),
      shape: 'vendor-resolve',
      expanded: String(vendor.url || expanded)
    };
  }
  throw badRequest(`Is link me group cart ki ID nahi mili. Chahiye: swiggy.com/gc/<id>, ?sharedCartId=<id>, swiggy:// deep link, ya app ka Share link. Mila: ${String(raw).slice(0, 120)}`);
}

// Compare the item IDs, quantities AND selected add-ons/variants, not just
// the number of items. Otherwise a customized group-cart meal could silently
// become a different meal while the Mini App claims the bill was verified.


function checkoutLockKey(account) {
  const phone = normalizeIndianMobileNumber(account.phone || account.mobile || '');
  const customerId = String(account.customerId || account.userId || '').trim();
  // The same Swiggy account can be present in the boss vault and a private
  // workspace. Coordinate with the bot's existing per-account lock, without
  // ever borrowing the boss account or returning it to the user.
  const shared = Object.entries(getDb().config?.accounts || {}).find(([, candidate]) =>
    (phone && normalizeIndianMobileNumber(candidate?.phone || candidate?.mobile || '') === phone) ||
    (customerId && String(candidate?.customerId || candidate?.userId || '').trim() === customerId)
  );
  const fallback = customerId || phone || crypto.createHash('sha256').update(String(account.token || account.tid || '')).digest('hex').slice(0, 20);
  return shared?.[0] || `pro:${fallback}`;
}

// Extract only values actually returned by the provider. Never manufacture a
// merchant UPI URI, order ID or transaction reference.
function placementDetails(json) {
  const data = json?.data?.order_data || json?.data?.orderData || json?.data || {};
  const findIntent = (value, depth = 0) => {
    if (depth > 15 || !value) return '';
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^upi:\/\/pay\?/i.test(text)) return text;
      if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try { return findIntent(JSON.parse(text), depth + 1); } catch {}
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const child of Object.values(value)) {
      const found = findIntent(child, depth + 1);
      if (found) return found;
    }
    return '';
  };
  // Boss (31-10-2026, round 12): "QR NAHI AYA". Swiggy kabhi intent ko
  // `app_redirection_info` se bahar (payment_fallbacks / HTML-escaped text /
  // nested order_data) bhejta hai. Sirf structured field dekhna hi QR na aane
  // ki wajah thi — ab poore jawab me text-scan bhi hota hai (jaisa bot karta hai).
  const findIntentInText = (value) => {
    let text = '';
    try { text = JSON.stringify(value); } catch { return ''; }
    const matches = String(text).match(/upi:\/\/pay\?[^"'\\\s<]+/g) || [];
    for (const raw of matches) {
      const decoded = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (/[?&]pa=/.test(decoded)) return decoded;
    }
    return '';
  };
  const findHttpPaymentLink = (value) => {
    let text = '';
    try { text = JSON.stringify(value); } catch { return ''; }
    const matches = String(text).match(/https:\/\/[^"'\\\s<]+/g) || [];
    const link = matches.find(u => /(?:^|\/)(?:payments?|upi|pay)\b/i.test(u) && !/swiggy\.com\/(?:orders|ofo\/track)/i.test(u));
    return link ? String(link).replace(/\\u0026/g, '&').replace(/\\\//g, '/') : '';
  };
  let redirect = data.app_redirection_info || data.appRedirectionInfo || null;
  if (typeof redirect === 'string') { try { redirect = JSON.parse(redirect); } catch { redirect = null; } }
  const paymentFallbacks = json?.data?.payment_fallbacks || data.payment_fallbacks || json?.data?.order_data?.payment_fallbacks || null;
  return {
    orderId: normalizeSwiggyOrderId(data.order_id || data.orderId || ''),
    upiIntentUrl: findIntent(json) || findIntentInText(json),
    paymentFallbacks,
    paymentPageUrl: findHttpPaymentLink(paymentFallbacks) || '' ,
    paymentTxnId: String(data.targeted_marketplace_payment_reference_id ||
      data.payment_info_v2?.payment_transactions?.[0]?.marketplace_reference_id ||
      redirect?.upiRedirect?.upiIntentRedirect?.transactionId || '').slice(0, 200)
  };
}

function attemptedPlacementError(message, code, orderId = '') {
  const err = unavailable(message);
  err.code = code;
  err.diag = { code, placementAttempted: true, placedOrderId: normalizeSwiggyOrderId(orderId) };
  return err;
}

export const proProvider = {
  async verifySession(account) {
    const live = await verifySwiggySessionLive(account);
    if (!live?.valid) return { valid: false };
    // A successful guest cart response is not proof of an authenticated user.
    // Require an actual non-guest customer ID returned by Swiggy's profile.
    let profile = await fetchSwiggyAndroidProfile(account, { timeoutMs: 6500 }).catch(() => null);
    if (!profile?.customerId) {
      const web = await dapiFetch(account, 'profile/info', { timeoutMs: 6500 }).catch(() => null);
      const info = web?.status === 200 && successCode(web?.json?.statusCode) ? web.json.data : null;
      if (info?.customer_id) profile = { customerId: String(info.customer_id), name: info.name || '', phone: info.mobile || info.phone || '' };
    }
    const id = String(profile?.customerId || '');
    if (!id || id === '0' || id === '-1') return { valid: false };
    return { ...live, valid: true, customerId: id, name: profile.name || live.name || '', phone: profile.phone || live.phone || '' };
  },
  addresses: fetchAccountAddresses,
  async resolveAddress(account, link) {
    const original = shareUrl(link);
    if (original.hostname === 'swig.gy') throw badRequest('This is not a Swiggy address link.');
    const expanded = await expandProShareLink(link);
    const match = expanded.match(/\/ofo\/address\/([^/?#]+)\/([^/?#&]+)/i);
    const short = original.hostname === 'swiggy.onelink.me' ? original.pathname.match(/^\/[^/]+\/([^/?#]+)/) : null;
    const token = match?.[2] || short?.[1];
    if (!token) throw badRequest('Could not find an address in this link. Please check and try again.');
    const name = match ? decodeURIComponent(match[1]) : null;
    // Boss (31-10-2026): "ADDRESS FETCH NA HORAHA". Mini App ke naye logins
    // Android token sessions hote hain jinme web cookie (`_session_tid`) nahi
    // hoti, isliye /dapi/social/getAddress unke saath 401 deta hai — link
    // kharab nahi hota. Pehle user ke apne session se try karo, phir server ke
    // apne web sessions se (address link sirf padhne ke liye hai aur wahi
    // content user ne khud bheja hai), phir share page se.
    let found = await resolveSharedOfoAddress(token, name, account);
    if (!found && account) found = await resolveSharedOfoAddress(token, name, null);
    if (!found || !found.address || !isValidIndianDeliveryCoordinates(found.lat, found.lng)) {
      const err = unavailable('Address link se pura address nahi mila. Neeche diya step follow karein aur dobara try karein — link expire maan kar naya address banane ki zaroorat nahi.');
      err.code = 'ADDRESS_INCOMPLETE';
      throw err;
    }
    return {
      // The legacy resolver uses the placeholder "Customer" when the link did
      // not return a name. Do not present that placeholder as an autofill.
      name: String(found.name || '').trim() === 'Customer' ? '' : String(found.name || ''), mobile: normalizeIndianMobileNumber(found.mobile) || '',
      address: String(found.address), area: String(found.area || ''), city: String(found.city || ''),
      flat_no: String(found.flat_no || ''), landmark: String(found.landmark || ''),
      lat: String(found.lat), lng: String(found.lng), annotation: String(found.annotation || 'OTHER')
    };
  },
  async search(account, address, query) {
    const { lat, lng } = coords(address);
    const path = `restaurants/search/v3?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&str=${encodeURIComponent(query)}&submitAction=ENTER&selectedPLTab=RESTAURANT`;
    let payload = await discovery(account, path, lat, lng);
    if (!payload) {
      const response = await dapiFetch(account, path, { lat, lng, timeoutMs: 8000 });
      if (response?.status === 200 && successCode(response?.json?.statusCode) && response.json.data) payload = response.json;
    }
    if (!payload) throw unavailable('Could not fetch restaurant search from Swiggy. Check the account session and try again.');
    return searchRestaurants(payload);
  },
  async menu(account, address, restaurantId) {
    const { lat, lng } = coords(address);
    const path = `menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&restaurantId=${encodeURIComponent(restaurantId)}`;
    let payload = await discovery(account, path, lat, lng);
    if (!Array.isArray(payload?.data?.cards)) {
      const response = await dapiFetch(account, path, { lat, lng, timeoutMs: 8000 });
      if (response?.status === 200 && successCode(response?.json?.statusCode)) payload = response.json;
    }
    if (!payload) throw unavailable('Swiggy menu could not be loaded.');
    return parseMenu(payload, restaurantId);
  },
  async groupCart(account, address, link) {
    // Group cart padhna address ke pin par depend nahi karta — lat/lng sirf
    // request headers ke liye hote hain. Address bhara na ho to bhi cart khule.
    let lat = '';
    let lng = '';
    try { ({ lat, lng } = coords(address)); } catch { /* default headers */ }
    const ref = await resolveGroupCartLink(link);
    const auth = await getSwiggySessionAuth(account);
    if (!auth?.jwtTid || !auth?.userId) throw unavailable('The selected Swiggy session could not be verified.');
    const normalizeItems = live => (live?.items || [])
      .filter(it => it && it.menu_item_id && Number(it.qty ?? it.quantity) > 0)
      .map(it => ({
        id: String(it.menu_item_id),
        menu_item_id: Number(it.menu_item_id),
        name: String(it.name || 'Item'),
        qty: Number(it.qty ?? it.quantity) || 1,
        price: it.price === null || it.price === undefined || !Number.isFinite(Number(it.price)) ? null : Number(it.price),
        lineTotal: it.lineTotal === null || it.lineTotal === undefined || !Number.isFinite(Number(it.lineTotal)) ? null : Number(it.lineTotal),
        // Vendor parser sirf `true` se veg confirm karta hai; `false` ka matlab
        // "veg nahi bataya" ho sakta hai — jhootha non-veg mark nahi lagate.
        isVeg: it.isVeg === true ? true : null,
        inStock: it.inStock === false ? false : true,
        variants: Array.isArray(it.variants) ? it.variants : [],
        addons: Array.isArray(it.addons) ? it.addons : [],
        offer_ids: Array.isArray(it.offer_ids) ? it.offer_ids : [],
        item_offer_cart_meta: String(it.item_offer_cart_meta || '')
      }));
    const cartShape = (live, items) => ({
      restaurantId: String(live?.restaurantId || ref.restaurantId || ref.cartId),
      restaurantName: String(live?.restaurantName || 'Restaurant'),
      restaurantArea: String(live?.areaName || ''),
      groupCartId: String(live?.groupCartId || ref.cartId),
      items
    });
    // (1) Bot ka proven engine: chkout `shared_cart/join` (ephemeral reader user
    // id) + read-only GET. Isse doosre customer ka group cart bhi khulta hai aur
    // "USER_ALREADY_PART_OF_GROUP_CART" (statusCode 86) nahi aata — yahi wajah
    // thi ki mini app "cart fetch nahi hua" bolta tha.
    const live = await fetchLiveGroupCart(ref.cartId, ref.restaurantId || null, ref.hostName || null, account, lat, lng).catch(() => null);
    const liveItems = normalizeItems(live);
    if (liveItems.length) return cartShape(live, liveItems);
    if (live?.status === 'EXPIRED') {
      const e = unavailable('Ye group cart ab band ho chuka hai (Swiggy ne "no longer exists" kaha). Host se naya group cart link maangein.');
      e.code = 'GROUP_CART_EXPIRED';
      throw e;
    }
    if (live?.status === 'PLACED') {
      const e = unavailable('Is group cart ka order pehle hi place ho chuka hai. Naya group cart banwaiye.');
      e.code = 'GROUP_CART_PLACED';
      throw e;
    }
    // (2) Seedha read-only GET (purana raasta) — engine sirf join ke bina bhi
    // kaam kare to yahan se sach milta hai.
    const response = await fetch(`https://chkout.swiggy.com/api/v1/shared_cart?group_cart_id=${encodeURIComponent(ref.cartId)}`, {
      headers: buildSwiggyAndroidClientHeaders(account, { tid: auth.jwtTid, token: auth.token, sid: auth.sid, deviceId: auth.deviceId, userId: auth.userId, lat: lat || '17.385044', lng: lng || '78.486671' }),
      signal: AbortSignal.timeout(8000)
    });
    const json = await response.json().catch(() => null);
    const data = json?.data;
    const items = [];
    for (const participant of Object.values(data?.user_cart_map || {})) {
      for (const it of participant?.user_cart || []) {
        if (!it.menu_item_id || !(Number(it.quantity) > 0)) continue;
        const qty = Number(it.quantity);
        const raw = Number(it.subtotal ?? Number(it.base_price || 0) * qty);
        items.push({
          id: String(it.menu_item_id), menu_item_id: Number(it.menu_item_id), name: String(it.name || 'Item'), qty,
          price: Number.isFinite(raw) ? Math.round(raw / qty) / 100 : null,
          lineTotal: Number.isFinite(raw) ? Math.round(raw) / 100 : null,
          isVeg: it.is_veg === 1 || it.is_veg === '1' || it.isVeg === 1 ? true : null,
          is_veg: it.is_veg,
          inStock: it.in_stock === 0 ? false : true,
          variants: Array.isArray(it.variants) ? it.variants : [], addons: Array.isArray(it.addons) ? it.addons : [],
          offer_ids: Array.isArray(it.offer_ids) ? it.offer_ids : [], item_offer_cart_meta: String(it.item_offer_cart_meta || '')
        });
      }
    }
    if (items.length) {
      return cartShape({
        restaurantId: String(data?.restaurant_details?.restaurant_id || ref.restaurantId || ref.cartId),
        restaurantName: String(data?.restaurant_details?.restaurant_name || 'Restaurant'),
        areaName: String(data?.restaurant_details?.area_name || '')
      }, items);
    }
    // Asli wajah — HTTP + Swiggy ka apna statusCode/statusMessage, chhupata nahi.
    const statusCode = json?.statusCode;
    const statusMessage = String(json?.statusMessage || (json?.errorCodes || []).join(', ') || '').slice(0, 180);
    const engineNote = String(live?.statusMessage || '').slice(0, 180);
    const e = unavailable(`Swiggy ne is group cart par item nahi diye (HTTP ${response.status}${statusCode !== undefined && statusCode !== null ? `, statusCode ${statusCode}` : ''}${statusMessage ? `: ${statusMessage}` : ''}${!statusMessage && engineNote ? `: ${engineNote}` : ''}). Mitti me cart band ho sakta hai ya link ka cart id galat hai — host se taaza link maangein.`);
    e.code = statusCode === 88 ? 'GROUP_CART_EXPIRED' : statusCode === 86 ? 'GROUP_CART_BUSY' : 'GROUP_CART_FETCH_FAILED';
    throw e;
  },

  /**
   * Boss (31-10-2026): "MUJHE OPTION DETA HAI COUPON CHOOSE KARNE KA." Coupon
   * page ke liye asli list — Swiggy ke apne coupon tool se. Jo code Swiggy ne
   * nahi diya wo hum banate nahi; list khaali aaye to saaf bata dete hain.
   */
  /**
   * Boss (31-10-2026, round 8): "COUPON AVAILABLE NAHI HAI MAT BOLO — WO HAMESHA
   * HOTA HAI. OPTION DO, CODE TYPE KARNE KA NAHI — SIRF APPLY."
   *
   * Pehle Swiggy ke apne coupon tool se asli list. Uske baad wahi promo codes jo
   * bot ka apna engine hamesha test karta hai (SNACKIT/TRYNEW/STEALDEAL/
   * SWIGGYIT/WELCOME50). Ye "guaranteed discount" ka dawa nahi hai — APPLY par
   * asli bill aata hai aur tabhi discount dikhta hai jab Swiggy deta hai.
   */
  async coupons(account, address, restaurantId) {
    const rid = String(restaurantId || '').trim();
    if (!/^\d{1,20}$/.test(rid)) throw badRequest('Pehle cart ya restaurant kholein — restaurant id chahiye.');
    const addressId = String(address?.id || address?.addressId || '').trim();
    const found = new Map();
    const push = (code, title, description, meta = {}) => {
      const key = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,28}$/.test(key)) return;
      const previous = found.get(key);
      if (previous?.source === 'swiggy' && meta.source !== 'swiggy') return;
      found.set(key, {
        code: key,
        title: String(title || key).slice(0, 90),
        description: String(description || '').slice(0, 200),
        applicable: meta.applicable === false ? false : true,
        reason: String(meta.reason || '').slice(0, 140),
        source: meta.source === 'swiggy' ? 'swiggy' : 'promo'
      });
    };
    let discovery = false;
    try {
      const mcp = await callSwiggyFoodMcpTool(account, 'fetch_food_coupons', {
        restaurantId: rid,
        ...(addressId ? { addressId } : {})
      }, 6000).catch(() => null);
      const list = Array.isArray(mcp?.structured?.coupons) ? mcp.structured.coupons : [];
      for (const cp of list) {
        push(cp?.coupon_code || cp?.couponCode || cp?.code || '', cp?.title || cp?.header || cp?.coupon_code, cp?.description || cp?.subtitle || '', {
          applicable: cp?.is_applicable !== false && cp?.applicable !== false,
          reason: cp?.ineligible_reason || cp?.reason || '',
          source: 'swiggy'
        });
      }
      discovery = Boolean(mcp?.ok) || list.length > 0;
    } catch { /* promo codes neeche hamesha aate hain */ }
    // Bot ka engine inhe har order par test karta hai — isliye list kabhi
    // khaali nahi dikhti aur user ko "coupon nahi hai" nahi bolna padta.
    for (const code of ['SNACKIT', 'TRYNEW', 'STEALDEAL', 'SWIGGYIT', 'WELCOME50']) {
      push(code, code === 'SNACKIT' ? 'Snackit offer' : 'Swiggy promo code', 'Swiggy ke promo code — APPLY karke asli bill dekhein', { source: 'promo' });
    }
    const all = [...found.values()];
    const rank = c => (c.source === 'swiggy' ? 0 : 10) + (c.applicable === false ? 5 : 0);
    const coupons = all.sort((a, b) => rank(a) - rank(b)).slice(0, 24);
    return {
      restaurantId: rid,
      coupons,
      discovery,
      note: 'APPLY dabaiye — Swiggy par asli bill aayega. Discount tabhi dikhega jab Swiggy deta hai; jo code lagta nahi uski asli wajah dikh jayegi.'
    };
  },
  /**
   * Bill = Swiggy ka hi bill. Boss (31-10-2026, round 11):
   * "AUTO SAARE COUPON LAG KAR AISA SUMMARY NAHI AARHA" — isliye coupon khud
   * lagta hai (sabse bada discount), aur bill ki har line wahin se aati hai.
   */
  async quoteCart(account, address, cart, coupon) {
    const { lat, lng } = coords(address);
    if (!address.name || !normalizeIndianMobileNumber(address.mobile)) throw badRequest('Confirm the receiver name and 10-digit mobile number first.');
    const requestedCoupon = String(coupon || '').trim().toUpperCase();
    return withSwiggyAccountLock(checkoutLockKey(account), async () => {
      const saved = await saveAddressToAccount(account, address);
      if (!saved?.addressId || !saved?.addressDetails) throw unavailable(saved?.error || 'Swiggy did not confirm the delivery address.');
      // A create-address response that only echoes our input is not readback.
      const savedList = await fetchAccountAddresses(account);
      const confirmedAddress = savedList.find(a => String(a.id || '') === String(saved.addressId));
      if (!confirmedAddress || !sameDeliveryRecipient(address, confirmedAddress)) {
        throw unavailable('Swiggy did not read back the same receiver, street and location. No bill or order was created.');
      }
      const pushAndRead = async (couponCode) => {
        const payload = {
          restaurantId: cart.restaurantId, address_id: String(saved.addressId), couponCode: couponCode || '',
          cartItems: buildSwiggyCartItemsPayload(cart.items), mealItems: [], subscriptionItems: [],
          ...(cart.forSomeoneElse ? buildOfoCartFields({ addressDetails: address }) : {})
        };
        const result = await swiggyCartUpdate(account, payload, { lat, lng, flushFirst: true });
        // The update wrapper can echo the requested address ID. Fetch the cart
        // independently before displaying a bill or treating an ID as bound.
        const readback = successCode(result?.json?.statusCode) ? await swiggyCartGet(account, { lat, lng }) : null;
        const data = readback?.json?.data;
        const meta = data?.cartMeta || data;
        const parsed = data && parseDapiCartPayload(data);
        if (!successCode(readback?.json?.statusCode) || !parsed || !meta || !Array.isArray(parsed.items)) throw unavailable('Swiggy did not confirm the cart. Refresh in Swiggy before trying again.');
        const boundAddress = String(meta.address_id || meta.delivery_address?.id || data.address_id || data.delivery_address?.id || '');
        if (!sameCartItems(cart.items, parsed.items) || boundAddress !== String(saved.addressId)) {
          throw unavailable('Swiggy returned different items or address. No bill is being shown; check the Swiggy cart.');
        }
        const total = Number(meta.order_total);
        if (exactPaise(total) === null || total <= 0) throw unavailable('Swiggy did not return a valid payable amount.');
        return { parsed, meta, total, coupon: String(parsed?.couponCode || '').toUpperCase() };
      };
      let best = { code: requestedCoupon, ...(await pushAndRead(requestedCoupon)) };
      // Auto-coupon: sirf jab user ne koi code na chuna ho. Har candidate ka
      // asli bill dekh kar sabse kam total wala rakhte hain — jhoothi saving nahi.
      let autoApplied = false;
      let triedCodes = [];
      if (!requestedCoupon && cart?.autoCoupon !== false) {
        let candidates = [];
        try {
          const list = await proProvider.coupons(account, confirmedAddress, cart.restaurantId);
          candidates = (Array.isArray(list?.coupons) ? list.coupons : [])
            .filter(c => c && c.applicable !== false && /^[A-Z0-9_-]{3,28}$/.test(String(c.code || '')))
            .map(c => String(c.code).toUpperCase())
            .filter((code, i, arr) => arr.indexOf(code) === i)
            .slice(0, 3);
        } catch { candidates = []; }
        for (const code of candidates) {
          triedCodes.push(code);
          let attempt = null;
          try { attempt = await pushAndRead(code); } catch { continue; }
          if (Number(attempt.total) < Number(best.total) - 0.005) {
            best = { code, ...attempt };
            autoApplied = true;
          }
        }
        // Aakhri push kisi doosre code ka ho sakta hai — cart ko best par lauta.
        if (best.code !== requestedCoupon) {
          const settled = await pushAndRead(best.code);
          best = { code: best.code, ...settled };
        }
        autoApplied = autoApplied && best.coupon === best.code;
      }
      const { parsed, meta, total } = best;
      const returnedNumber = (...values) => {
        const raw = values.find(v => v !== undefined && v !== null && v !== '');
        return raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
      };
      return {
        address: confirmedAddress,
        bill: {
          // Boss (31-10-2026, round 9): "BILL SUMMARY ME ITNA AYEGA" — wahi
          // lines jo Swiggy dikhata hai: Coupon, Extra Discount (Free Cash),
          // Swiggy One Lite Membership, FREE delivery (kitna bacha),
          // Packing, GST & Other, Total Savings, To Pay.
          itemTotal: returnedNumber(parsed?.itemTotal, meta.item_total, meta.cart_subtotal),
          deliveryFee: returnedNumber(parsed?.deliveryFee, meta.positiveDeliveryChargesExclusive, meta.delivery_charges),
          deliverySaved: parsed?.freeDeliveryDiscount ?? null,
          deliveryFree: Number(parsed?.deliveryFee ?? 0) <= 0,
          deliveryDistance: String(meta?.delivery_distance || meta?.delivery_distance_in_km || parsed?.deliveryDistance || '').slice(0, 40),
          packingCharges: returnedNumber(parsed?.packingCharges, meta.total_packing_charges, meta.restaurant_packing_charges),
          taxes: returnedNumber(parsed?.taxesAndCharges, meta.taxesAndCharges, meta.total_tax),
          discount: parsed?.couponCode ? returnedNumber(parsed.discountAmount, meta.coupon_discount_total, meta.coupon_discount_effective) : null,
          coupon: String(parsed?.couponCode || ''),
          autoCoupon: autoApplied,
          couponTried: triedCodes,
          freeCash: parsed?.freeCashApplied ?? null,
          freeCashWallet: parsed?.walletSplitPayAmount ?? null,
          tradeDiscount: parsed?.merchantTradeDiscount ?? null,
          oneMembershipFee: parsed?.swiggyOneMembershipFee ?? null,
          oneApplied: parsed?.swiggyOneApplied === true,
          totalSavings: parsed?.totalSavings ?? null,
          total
        },
        // Sending OFO fields is not proof that Swiggy accepted OFO placement.
        ofoConfirmed: false
      };
    });
  },
  async checkout(account, address, cart, placementKey) {
    const { lat, lng } = coords(address);
    if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1' ||
        (globalThis.fetch === bootFetch && isZeroSmsTestSandboxActive())) {
      throw badRequest('Order placement is blocked in this environment; no simulated order or QR was created.');
    }
    const expected = Number(cart?.quote?.total);
    // Coupon code jo bill ke waqt APPROVE hua tha — billBreakdown `coupon` ko
    // clear kar deta hai jab discount item total me pehle se ho, isliye asli
    // code alag field me rakhte hain.
    const approvedCoupon = String(cart?.quote?.couponCode ?? cart?.quote?.coupon ?? '').trim().toUpperCase();
    if (!address?.id || !address?.name || !normalizeIndianMobileNumber(address?.mobile) ||
        !Array.isArray(cart?.items) || !cart.items.length || exactPaise(expected) === null || expected <= 0) {
      throw badRequest('Confirm the recipient and refresh the Swiggy bill before checkout.');
    }
    return withSwiggyAccountLock(checkoutLockKey(account), async () => {
      const [auth, liveCart, savedAddresses] = await Promise.all([
        getSwiggySessionAuth(account, false),
        swiggyCartGet(account, { lat, lng, timeoutMs: 8000 }),
        fetchAccountAddresses(account)
      ]);
      if (!auth?.userId || !auth?.jwtTid) throw unavailable('Swiggy session could not be verified. No order was placed.');
      const actualAddress = savedAddresses.find(a => String(a.id || '') === String(address.id));
      if (!actualAddress || !sameDeliveryRecipient(address, actualAddress)) {
        throw unavailable('Swiggy did not confirm the same receiver and delivery location. No order was placed.');
      }
      const accountPhone = normalizeIndianMobileNumber(account?.phone || account?.mobile || '');
      const receiverPhone = normalizeIndianMobileNumber(actualAddress.mobile || '');
      if ((!accountPhone || accountPhone !== receiverPhone) && !cart.forSomeoneElse) {
        throw badRequest('The receiver differs from this account. Select “Order for someone else” and review a fresh bill. No order was placed.');
      }
      const data = liveCart?.json?.data;
      const meta = data?.cartMeta || data;
      const parsed = data ? parseDapiCartPayload(data) : null;
      const liveTotal = Number(meta?.order_total);
      const addressId = String(meta?.address_id || meta?.delivery_address?.id || data?.address_id || data?.delivery_address?.id || '');
      const cartId = String(meta?.originalCartId || meta?.cartId || meta?.cart_id || '');
      const coupon = String(parsed?.couponCode || '').toUpperCase();
      // Boss (31-10-2026, round 10): pehle yahan ek hi generic message aata tha
      // ("cart, recipient/OFO, coupon or amount could not be confirmed") aur
      // user ko pata hi nahi chalta tha kya badla. Ab har check alag hai aur
      // uski asli wajah + dono numbers message me aate hain.
      const problems = [];
      const fail = (code, message, extra = {}) => problems.push({ code, message, ...extra });
      if (!successCode(liveCart?.json?.statusCode) || !data) {
        fail('CART_FETCH', `Swiggy ne cart nahi diya (HTTP ${liveCart?.status || '?'}${liveCart?.json?.statusCode !== undefined ? `, statusCode ${liveCart.json.statusCode}` : ''}).`);
      } else if (!parsed) {
        fail('CART_PARSE', 'Swiggy ka cart jawab samajh nahi aaya (items parse nahi hue).');
      } else {
        const quantityOk = sameCartItems(cart.items, parsed.items) ||
          // Group cart import ke raw variants/add-ons Swiggy ke shape se thoda
          // alag hote hain — pehle item+qty compare karo, phir hi "badal gaya"
          // bolo. Jhoothi mismatch ki wajah se order nahi rukna chahiye.
          (() => {
            const key = list => list.map(i => `${i.menu_item_id || i.itemId || i.id}:${Number(i.qty ?? i.quantity) || 0}`).sort().join('|');
            return Boolean(cart.items?.length) && key(cart.items) === key(parsed.items || []);
          })();
        if (!quantityOk) fail('CART_ITEMS', 'Swiggy ke cart me items badal gaye (Swiggy app me kuch add/hata hua hai).');
        if (parsed.restaurantId && String(parsed.restaurantId) !== String(cart.restaurantId)) {
          fail('RESTAURANT', `Restaurant badal gaya — bill ${cart.restaurantId}, Swiggy ${parsed.restaurantId}.`);
        }
      }
      if (addressId && addressId !== String(address.id)) fail('ADDRESS', `Delivery address Swiggy par alag hai (bill ${address.id}, Swiggy ${addressId}).`);
      if (exactPaise(liveTotal) === null) fail('AMOUNT_MISSING', 'Swiggy ne payable amount nahi diya.');
      else if (exactPaise(liveTotal) !== exactPaise(expected)) {
        fail('AMOUNT', `Bill ka amount badal gaya — aapne ₹${expected} dekh kar Pay dabaya, Swiggy ab ₹${liveTotal} keh raha hai.`);
      }
      if (coupon !== approvedCoupon) {
        fail('COUPON', `Coupon badal gaya — bill me "${approvedCoupon || 'koi coupon nahi'}", Swiggy par "${coupon || 'koi coupon nahi'}".`);
      }
      if (!cartId) fail('CART_ID', 'Swiggy ne cart id nahi di (order place karne ke liye zaroori hai).');
      if (problems.length) {
        const err = unavailable(`${problems.map((p, i) => `${i + 1}. ${p.message}`).join(' ')} Order place nahi hua — naya bill dekh kar dobara Pay dabaiye.`);
        err.diag = { code: problems[0].code, problems, placementAttempted: false };
        // Recoverable: bill/coupon badla hai par items/address wahi hain. Tab
        // naya bill bhej dete hain taaki app use dikha kar dobara confirm kare
        // (dead-end loop nahi).
        const hardStop = problems.some(p => ['CART_FETCH', 'CART_PARSE', 'CART_ID', 'CART_ITEMS', 'RESTAURANT', 'ADDRESS'].includes(p.code));
        // Code hamesha set — app isi se decide karta hai ki retry safe hai ya
        // nahi (aur "outcome unknown" ka darr dikhana hai ya nahi).
        err.code = hardStop ? problems[0].code : 'BILL_CHANGED';
        if (!hardStop && parsed) {
          err.diag.freshBill = {
            itemTotal: parsed.itemTotal, deliveryFee: parsed.deliveryFee, deliverySaved: parsed.freeDeliveryDiscount,
            packingCharges: parsed.packingCharges, taxes: parsed.taxesAndCharges,
            discount: parsed.discountAmount, coupon: String(parsed.couponCode || ''),
            freeCash: parsed.freeCashApplied, tradeDiscount: parsed.merchantTradeDiscount,
            oneMembershipFee: parsed.swiggyOneMembershipFee, oneApplied: parsed.swiggyOneApplied === true,
            totalSavings: parsed.totalSavings, total: liveTotal
          };
        }
        throw err;
      }
      const recipient = cart.forSomeoneElse ? buildOfoCartFields({ addressDetails: actualAddress }) : {};
      const body = {
        address_id: addressId, lat, lng, payment_cod_method: 'UPIIntent',
        ...recipient,
        order_total: liveTotal, bill_total: liveTotal, cart_total: liveTotal,
        cart_total_shown_to_coupon: meta.cart_total_shown_to_coupon ?? liveTotal,
        total_without_coupon_discount: meta.total_without_coupon_discount ?? liveTotal,
        original_order_total: meta.original_order_total ?? liveTotal,
        transaction_amount: liveTotal, updated_amount: liveTotal, amount: liveTotal,
        cartId, cart_id: cartId, originalCartId: cartId,
        upi_transaction_info: { intent_app: 'com.google.android.apps.nbu.paisa.user', intent_app_display_name: 'Google Pay' }
      };
      const headers = buildSwiggyAndroidClientHeaders(account, {
        tid: liveCart?.json?.tid || auth.jwtTid, token: auth.token, sid: auth.sid,
        deviceId: auth.deviceId, userId: auth.userId, lat, lng,
        extraHeaders: { paymentamount: String(liveTotal), cartid: cartId, cartaddressid: addressId, addressid: addressId }
      });
      const result = await executeSingleSwiggyPlacement(placementKey, async () => {
        const response = await fetch('https://chkout.swiggy.com/api/v2/order/place', {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000)
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { placeRes: response, json };
      });
      const details = placementDetails(result?.json);
      const check = details.upiIntentUrl
        ? validateUpiIntentForQr(details.upiIntentUrl, { amount: expected, requireAmount: true })
        : { valid: false, info: {} };
      if (!result?.placeRes?.ok || !successCode(result?.json?.statusCode) || !details.orderId) {
        throw attemptedPlacementError(
          'Swiggy did not return a verifiable order ID and matching UPI payment. An order may exist; check My Orders on this account. Do not retry.',
          'SWIGGY_PLACEMENT_RESPONSE_UNCERTAIN', details.orderId
        );
      }
      const amountOk = exactPaise(check.info?.amount) !== null && exactPaise(check.info.amount) === exactPaise(expected);
      if (!check.valid || !amountOk) {
        // Order BAN gaya hai — "rejected" kehna jhooth hota. Bas QR nahi mila.
        // Isko OUTCOME_UNKNOWN me daalna hi confusion tha; ab alag haalat.
        const intentProblem = details.upiIntentUrl
          ? `Swiggy ka QR amount bill se match nahi karta (QR ₹${check.info?.amount ?? '?'}, bill ₹${expected}).`
          : 'Swiggy ne order accept kiya par UPI payment QR/intent nahi diya.';
        const err = unavailable(`${intentProblem} Order #${details.orderId} Swiggy par bana hua hai — dobara order na karein.`);
        err.code = 'SWIGGY_PLACED_NO_UPI_INTENT';
        err.diag = {
          code: 'SWIGGY_PLACED_NO_UPI_INTENT', placementAttempted: true, placedOrderId: details.orderId,
          qrMissing: true, intentProblem, paymentFallbacks: details.paymentFallbacks || null,
          paymentPageUrl: details.paymentPageUrl || '', paymentTxnId: details.paymentTxnId || ''
        };
        throw err;
      }
      // Boss (31-10-2026, round 11): Swiggy ka cart readback OFO flag deta hi
      // nahi, isliye pehle har OFO order "flag nahi mila" par ruk jaata tha.
      // Ab order nahi rukta; OFO ka sach sirf place-response se aata hai aur
      // wahi (jhooth bina) app ko dikhta hai.
      const ofoProof = detectOfoFromPlaceResponse(result.json);
      return {
        ...details,
        amount: expected,
        ofoConfirmed: ofoProof.ofo === true,
        ofoRequested: cart.forSomeoneElse === true,
        ofoNote: cart.forSomeoneElse
          ? (ofoProof.ofo === true
            ? 'Swiggy ne OFO flag place-response me diya.'
            : 'Swiggy ne place-response me OFO flag nahi diya — order normal order ki tarah gaya, khana usi address par jayega.')
          : ''
      };
    });
  },
  async checkPayment(account, checkout) {
    return checkRealSwiggyPaymentAndExtractTracking({
      account,
      order: {
        pendingSwiggyOrderId: checkout.orderId,
        pendingSwiggyPaasId: checkout.paymentTxnId,
        finalPayable: checkout.amount,
        restaurantName: checkout.restaurantName
      }
    });
  },
  async tracking(account, rawId) {
    const id = normalizeSwiggyOrderId(rawId);
    if (!id) throw badRequest('Invalid Swiggy order ID.');
    const [track, delivery] = await Promise.all([
      dapiFetch(account, `order/trackV4?order_id=${encodeURIComponent(id)}&type=full&version=V2`, { timeoutMs: 8000 }).catch(() => null),
      dapiFetch(account, `order/trackV2/de?order_id=${encodeURIComponent(id)}`, { timeoutMs: 8000 }).catch(() => null)
    ]);
    const validData = response => {
      if (response?.status !== 200 || !successCode(response?.json?.statusCode) || !response?.json?.data) return null;
      const value = response.json.data;
      const returnedId = String(value.order_id || value.orderId || '');
      return returnedId && returnedId !== id ? null : value;
    };
    const t = validData(track), d = validData(delivery);
    if (!t && !d) throw unavailable('Swiggy did not return tracking details for this order.');
    return {
      orderId: id,
      status: String(t?.order_status_details?.status_message || t?.order_status || ''),
      eta: String(t?.sla_time || t?.order_status_details?.eta || ''),
      trackingUrl: extractSwiggyProvidedTrackingUrl(t, d) || '',
      deliveryOtp: extractSwiggyDeliveryOtp(t, { delivery: d }) || '',
      deliveryPartner: { name: String(d?.name || ''), phone: String(d?.mobile || '') }
    };
  },
  async orders(account) {
    const result = await dapiFetch(account, 'order/all', { timeoutMs: 10000 });
    const list = result?.json?.data?.orders;
    if (result?.status !== 200 || !successCode(result?.json?.statusCode) || !Array.isArray(list)) throw unavailable('Swiggy order history could not be fetched.');
    return list.slice(0, 30).map(o => ({
      id: String(o.order_id || ''), restaurant: String(o.restaurant_name || ''),
      status: String(o.order_status || o.order_delivery_status || o.post_status || 'Status unavailable'),
      placedAt: String(o.order_time || ''), amount: o.order_total === undefined || o.order_total === null ? null : Number(o.order_total),
      items: (Array.isArray(o.order_items) ? o.order_items : []).map(i => ({ name: String(i.name || ''), qty: Number(i.quantity || 1) })),
      address: String(o.delivery_address?.address || o.delivery_address?.area || '')
    })).filter(o => o.id);
  }
};
