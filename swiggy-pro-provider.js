import {
  buildSwiggyAndroidClientHeaders, buildSwiggyCartItemsPayload, buildOfoCartFields,
  dapiFetch, fetchAccountAddresses, fetchSwiggyAndroidProfile, getSwiggySessionAuth, isValidIndianDeliveryCoordinates,
  parseDapiCartPayload, resolveSharedOfoAddress, saveAddressToAccount,
  swiggyCartUpdate, verifySwiggySessionLive, withSwiggyAccountLock,
  extractDeepLinkFromReferrerOrUrl
} from './swiggy-cart.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { getDb } from './store.js';
import crypto from 'node:crypto';

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
const SHARE_HOSTS = new Set(['swig.gy', 'swiggy.onelink.me', 'www.swiggy.com', 'swiggy.com']);
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

// Compare the item IDs, quantities AND selected add-ons/variants, not just
// the number of items. Otherwise a customized group-cart meal could silently
// become a different meal while the Mini App claims the bill was verified.
export function sameCartItems(expected, actual) {
  const makeSignature = (item) => {
    const id = String(item?.menu_item_id || item?.itemId || item?.id || '');
    if (!/^\d+$/.test(id)) return null;
    const choices = (list, choiceKeys) => {
      if (!Array.isArray(list)) return null;
      const output = [];
      for (const choice of list) {
        const group = String(choice?.group_id ?? choice?.groupId ?? '');
        const choiceId = String(choiceKeys.map(key => choice?.[key]).find(v => v !== undefined && v !== null) ?? '');
        if (!group || !choiceId) return null;
        output.push(`${group}:${choiceId}`);
      }
      return output.sort();
    };
    const variants = choices(item.variants || [], ['variation_id', 'variationId', 'id']);
    const addons = choices(item.addons || [], ['choice_id', 'choiceId', 'id']);
    if (!variants || !addons) return null;
    return JSON.stringify([id, variants, addons]);
  };
  const aggregate = (list) => {
    if (!Array.isArray(list) || !list.length) return null;
    const result = new Map();
    for (const item of list) {
      const signature = makeSignature(item);
      const quantity = Number(item.qty ?? item.quantity);
      if (!signature || !Number.isInteger(quantity) || quantity <= 0) return null;
      result.set(signature, (result.get(signature) || 0) + quantity);
    }
    return result;
  };
  const left = aggregate(expected), right = aggregate(actual);
  return Boolean(left && right && left.size === right.size && [...left].every(([key, qty]) => right.get(key) === qty));
}

export function sameDeliveryRecipient(expected, saved) {
  const expectedPhone = normalizeIndianMobileNumber(expected?.mobile || '');
  const savedPhone = normalizeIndianMobileNumber(saved?.mobile || '');
  const normalizeText = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!expectedPhone || expectedPhone !== savedPhone || !normalizeText(expected?.name) || normalizeText(expected.name) !== normalizeText(saved?.name)) return false;
  if (!normalizeText(expected?.address) || normalizeText(expected.address) !== normalizeText(saved?.address)) return false;
  if (!isValidIndianDeliveryCoordinates(expected?.lat, expected?.lng) || !isValidIndianDeliveryCoordinates(saved?.lat, saved?.lng)) return false;
  const toRad = n => n * Math.PI / 180;
  const lat1 = Number(expected.lat), lat2 = Number(saved.lat);
  const dLat = toRad(lat2 - lat1), dLng = toRad(Number(saved.lng) - Number(expected.lng));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, a))) <= 35;
}

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
    const found = await resolveSharedOfoAddress(token, name, account);
    if (!found || !found.address || !isValidIndianDeliveryCoordinates(found.lat, found.lng)) {
      throw unavailable('Swiggy did not return the full address and location. Retry; do not assume the link is expired.');
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
    const { lat, lng } = coords(address);
    const expanded = await expandProShareLink(link);
    const match = expanded.match(/\/gc\/(\d+)\/[^/?#]+-(\d+)/i);
    if (!match) throw badRequest('This group-cart link could not be expanded. Try the full Swiggy group-cart link.');
    const auth = await getSwiggySessionAuth(account);
    if (!auth?.jwtTid || !auth?.userId) throw unavailable('The selected Swiggy session could not be verified.');
    const response = await fetch(`https://chkout.swiggy.com/api/v1/shared_cart?group_cart_id=${encodeURIComponent(match[2])}`, {
      headers: buildSwiggyAndroidClientHeaders(account, { tid: auth.jwtTid, token: auth.token, sid: auth.sid, deviceId: auth.deviceId, userId: auth.userId, lat, lng }),
      signal: AbortSignal.timeout(8000)
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !successCode(json?.statusCode) || !json?.data) throw unavailable('Swiggy did not return this group cart; it may be closed or unavailable.');
    const data = json.data;
    const items = [];
    for (const participant of Object.values(data.user_cart_map || {})) {
      for (const it of participant?.user_cart || []) {
        if (!it.menu_item_id || !(Number(it.quantity) > 0)) continue;
        const qty = Number(it.quantity);
        const raw = Number(it.subtotal ?? Number(it.base_price || 0) * qty);
        items.push({
          id: String(it.menu_item_id), menu_item_id: Number(it.menu_item_id), name: String(it.name || 'Item'), qty,
          price: Number.isFinite(raw) ? Math.round(raw / qty) / 100 : null,
          variants: Array.isArray(it.variants) ? it.variants : [], addons: Array.isArray(it.addons) ? it.addons : [],
          offer_ids: Array.isArray(it.offer_ids) ? it.offer_ids : [], item_offer_cart_meta: String(it.item_offer_cart_meta || '')
        });
      }
    }
    if (!items.length) throw unavailable('Swiggy returned no items for this group cart.');
    return { restaurantId: String(data.restaurant_details?.restaurant_id || match[1]), restaurantName: String(data.restaurant_details?.restaurant_name || 'Restaurant'), items };
  },
  async quoteCart(account, address, cart, coupon) {
    const { lat, lng } = coords(address);
    if (!address.name || !normalizeIndianMobileNumber(address.mobile)) throw badRequest('Confirm the receiver name and 10-digit mobile number first.');
    return withSwiggyAccountLock(checkoutLockKey(account), async () => {
      const saved = await saveAddressToAccount(account, address);
      if (!saved?.addressId || !saved?.addressDetails) throw unavailable(saved?.error || 'Swiggy did not confirm the delivery address.');
      if (!sameDeliveryRecipient(address, saved.addressDetails)) throw unavailable('Swiggy returned a different receiver or location. Check the address before syncing again.');
      const payload = {
        restaurantId: cart.restaurantId, address_id: String(saved.addressId), couponCode: coupon || '',
        cartItems: buildSwiggyCartItemsPayload(cart.items), mealItems: [], subscriptionItems: [],
        ...(cart.forSomeoneElse ? buildOfoCartFields({ addressDetails: address }) : {})
      };
      const result = await swiggyCartUpdate(account, payload, { lat, lng, flushFirst: true });
      const data = result?.json?.data;
      const meta = data?.cartMeta || data;
      const parsed = data && parseDapiCartPayload(data);
      if (!successCode(result?.json?.statusCode) || !parsed || !meta || !Array.isArray(parsed.items)) throw unavailable('Swiggy did not confirm the cart. Refresh in Swiggy before trying again.');
      if (!sameCartItems(cart.items, parsed.items) || String(meta.address_id || '') !== String(saved.addressId)) {
        throw unavailable('Swiggy returned different items or address. No bill is being shown; check the Swiggy cart.');
      }
      const total = Number(meta.order_total);
      if (!Number.isFinite(total) || total <= 0) throw unavailable('Swiggy did not return a valid payable amount.');
      const returnedNumber = (...values) => {
        const raw = values.find(v => v !== undefined && v !== null && v !== '');
        return raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
      };
      return {
        address: saved.addressDetails,
        bill: {
          itemTotal: returnedNumber(meta.item_total, meta.cart_subtotal),
          deliveryFee: returnedNumber(meta.positiveDeliveryChargesExclusive, meta.delivery_charges),
          packingCharges: returnedNumber(meta.total_packing_charges, meta.restaurant_packing_charges),
          taxes: returnedNumber(meta.taxesAndCharges, meta.total_tax),
          discount: parsed.couponCode ? returnedNumber(meta.coupon_discount_total, meta.coupon_discount_effective) : null,
          coupon: String(parsed.couponCode || ''), total
        },
        // Sending OFO fields is not proof that Swiggy accepted OFO placement.
        ofoConfirmed: false
      };
    });
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
