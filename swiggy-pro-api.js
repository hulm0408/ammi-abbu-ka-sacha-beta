import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { validateUpiIntentForQr } from './payment-qr-guard.js';
import { readSwiggyPlacement } from './swiggy-placement-journal.js';
import { exactPaise } from './swiggy-cart-integrity.js';
import { isOfficialSwiggyTrackingUrl, normalizeSwiggyOrderId, validateTrackingUrlForOrder } from './swiggy-cart.js';
import { getDb, isBoss, updateAccount, permanentLogoutAccount, normalizeSwiggySessionPayload } from './store.js';
import { requestSwiggyOtpViaBridge, verifySwiggyOtpViaBridge } from './swiggy-bridge.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { proProvider } from './swiggy-pro-provider.js';
import { readProWorkspace, writeProWorkspace, withProWorkspaceLock } from './swiggy-pro-store.js';

const ASSETS = {
  '/pro': ['text/html; charset=utf-8', new URL('./swiggy-pro.html', import.meta.url)],
  '/pro/': ['text/html; charset=utf-8', new URL('./swiggy-pro.html', import.meta.url)],
  '/pro/app.js': ['text/javascript; charset=utf-8', new URL('./swiggy-pro-app.js', import.meta.url)],
  '/pro/style.css': ['text/css; charset=utf-8', new URL('./swiggy-pro.css', import.meta.url)]
};
const MAX_INIT_AGE_SECONDS = 24 * 60 * 60;
const otpRequestedAt = new Map();
const otpAttempts = new Map();
const defaultOtp = { request: requestSwiggyOtpViaBridge, verify: verifySwiggyOtpViaBridge };

/** Verify Telegram's signature and freshness; never trust initDataUnsafe. */
export function verifyTelegramWebAppInitData(initData, botToken = process.env.BOT_TOKEN, now = Date.now()) {
  const raw = String(initData || '');
  if (!raw || raw.length > 8192 || !botToken) return null;
  try {
    const params = new URLSearchParams(raw);
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) return null;
    const hash = params.get('hash') || '';
    const dateText = params.get('auth_date') || '';
    if (!/^[0-9a-f]{64}$/i.test(hash) || !/^\d{1,12}$/.test(dateText)) return null;
    const age = Math.floor(now / 1000) - Number(dateText);
    if (age < -30 || age > MAX_INIT_AGE_SECONDS) return null;
    const check = [...params.entries()].filter(([key]) => key !== 'hash')
      .map(([key, value]) => `${key}=${value}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(check).digest();
    const supplied = Buffer.from(hash, 'hex');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !/^\d{1,20}$/.test(String(user.id)) || !Number.isSafeInteger(Number(user.id))) return null;
    return { id: String(user.id), firstName: String(user.first_name || '').slice(0, 80) };
  } catch { return null; }
}

function error(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw error(415, 'Send JSON.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 100_000) throw error(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw error(400, 'Invalid JSON.'); }
}

function accountMap(user, workspace) {
  return isBoss(user.id) ? (getDb().config?.accounts || {}) : workspace.accounts;
}
function listAccounts(user, workspace) {
  const map = accountMap(user, workspace);
  return Object.entries(map).filter(([, a]) => a && a.isLoggedIn && !a.isLoggedOut).map(([key, a]) => ({
    key, name: String(a.swiggyName || a.name || 'Swiggy account').slice(0, 80),
    phone: normalizeIndianMobileNumber(a.phone || a.mobile || '') || '',
    active: key === workspace.activeAccountKey,
    ordersCount: Number.isInteger(a.totalOrdersCount) ? a.totalOrdersCount : null,
    sessionExpired: Boolean(a.sessionExpired)
  }));
}
function currentAccount(user, workspace) {
  const map = accountMap(user, workspace);
  const key = workspace.activeAccountKey;
  if (!key || !Object.prototype.hasOwnProperty.call(map, key) || !map[key]?.isLoggedIn || map[key]?.isLoggedOut) {
    throw error(400, 'First select a logged-in Swiggy account in Accounts.');
  }
  // External provider helpers must never mutate the shared vault by matching
  // this Mini App session's phone, even when it is a boss's own account.
  return { ...map[key], __proPrivate: true };
}
function requireEditableCart(ws) {
  if (ws.checkout && ws.checkout.status !== 'PAID') {
    throw error(409, 'Resolve the existing Swiggy checkout before changing the draft cart or receiver.');
  }
}
function invalidateAccountDependentState(ws) {
  ws.selectedAddress = null;
  ws.addressCandidates = [];
  ws.pendingAddress = null;
  ws.menu = null;
  if (ws.cart) ws.cart.quote = null;
}
function cleanAddress(a) {
  return {
    name: String(a?.name || '').slice(0, 120), mobile: normalizeIndianMobileNumber(a?.mobile || '') || '',
    address: String(a?.address || '').slice(0, 500), area: String(a?.area || '').slice(0, 200),
    city: String(a?.city || '').slice(0, 100), flat_no: String(a?.flat_no || '').slice(0, 100),
    landmark: String(a?.landmark || '').slice(0, 200), lat: String(a?.lat || ''), lng: String(a?.lng || ''),
    annotation: String(a?.annotation || 'OTHER').slice(0, 50), id: String(a?.id || '').slice(0, 100)
  };
}
function activeAccountForClient(user, ws) {
  return listAccounts(user, ws).find(a => a.active) || null;
}
function safeTrackingUrl(value, orderId) {
  const link = String(value || '').trim();
  if (!/^https:\/\//i.test(link) || !isOfficialSwiggyTrackingUrl(link, { allowProviderShortLink: true }) ||
      !validateTrackingUrlForOrder(link, { swiggyOrderId: orderId }, 'SWIGGY_API')) return '';
  try {
    const pathId = new URL(link).pathname.match(/\/(?:orders?|track|tracking)\/(\d{10,20})(?:\/|$)/i)?.[1];
    return pathId && pathId !== String(orderId) ? '' : link;
  } catch { return ''; }
}
function publicCheckout(checkout) {
  if (!checkout) return null;
  const output = {
    status: String(checkout.status || 'UNKNOWN'), createdAt: String(checkout.createdAt || ''),
    accountPhone: String(checkout.accountPhone || ''),
    orderId: String(checkout.orderId || ''), amount: Number(checkout.amount) || 0,
    restaurantName: String(checkout.restaurantName || ''),
    ofoConfirmed: checkout.ofoConfirmed === true,
    paymentVerified: checkout.paymentVerified === true,
    message: String(checkout.message || ''), tracking: checkout.tracking || null
  };
  if (checkout.status === 'PAYMENT_PENDING' && checkout.paymentVerified !== true && checkout.upiIntentUrl && checkout.qrDataUrl) {
    output.upiIntentUrl = checkout.upiIntentUrl;
    output.qrDataUrl = checkout.qrDataUrl;
  }
  return output;
}
function publicState(user, ws) {
  return {
    user: { name: user.firstName || 'Friend', isBoss: isBoss(user.id) },
    accounts: listAccounts(user, ws), activeAccount: activeAccountForClient(user, ws),
    selectedAddress: ws.selectedAddress, cart: ws.cart,
    checkout: publicCheckout(ws.checkout),
    checkoutEnabled: process.env.PRO_ENABLE_CHECKOUT === '1'
  };
}
function checkoutAccount(user, ws) {
  const key = String(ws.checkout?.accountKey || '');
  const map = accountMap(user, ws);
  const account = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  if (!account?.isLoggedIn || account.isLoggedOut) throw error(409, 'The original Swiggy account is unavailable. Reconnect that account before checking this order.');
  const originalId = String(ws.checkout?.accountCustomerId || '').trim();
  if (originalId && String(account.customerId || '').trim() !== originalId) throw error(409, 'The saved account no longer matches the original checkout account. Check Swiggy My Orders.');
  return { ...account, __proPrivate: true };
}
function orderHistoryAccount(user, ws, scope) {
  if (scope === 'checkout') {
    if (!ws.checkout) throw error(404, 'No Mini App checkout exists.');
    return checkoutAccount(user, ws);
  }
  if (scope !== 'active') throw error(400, 'Invalid order history scope.');
  return currentAccount(user, ws);
}
function requireOriginalReconnect(user, ws, key, incoming) {
  if (!ws.checkout || ws.checkout.status === 'PAID') return;
  const saved = accountMap(user, ws)[ws.checkout.accountKey];
  const originalId = String(ws.checkout.accountCustomerId || saved?.customerId || '').trim();
  if (key !== ws.checkout.accountKey || !originalId || String(incoming.customerId || '').trim() !== originalId) {
    throw error(409, 'Only the verified original checkout account can be reconnected while its outcome is unresolved.');
  }
}
function storeAccount(user, ws, incoming) {
  const phone = normalizeIndianMobileNumber(incoming.phone || incoming.mobile || '') || '';
  const unresolved = Boolean(ws.checkout && ws.checkout.status !== 'PAID');
  if (isBoss(user.id)) {
    if (!phone) throw error(400, 'Swiggy did not return an account phone number.');
    const key = `acc_${phone}`;
    requireOriginalReconnect(user, ws, key, incoming);
    updateAccount(key, { ...incoming, phone, mobile: phone, isLoggedIn: true });
    ws.activeAccountKey = key;
  } else {
    const match = Object.entries(ws.accounts).find(([, a]) =>
      (phone && normalizeIndianMobileNumber(a.phone || a.mobile) === phone) ||
      (incoming.customerId && String(a.customerId || '') === String(incoming.customerId))
    );
    const key = match?.[0] || `private_${crypto.randomUUID()}`;
    requireOriginalReconnect(user, ws, key, incoming);
    ws.accounts[key] = { ...incoming, phone, mobile: phone, isLoggedIn: true };
    ws.activeAccountKey = key;
  }
  // Refreshing the original session must not erase the pending order's receiver
  // and cart. A different account is blocked above until the checkout resolves.
  if (!unresolved) invalidateAccountDependentState(ws);
}

export async function handleSwiggyProHttp(req, res, { provider = proProvider, otp = defaultOtp, authorizeUser = null } = {}) {
  const url = new URL(req.url || '/', 'http://local');
  const route = url.pathname;
  if (route !== '/pro' && !route.startsWith('/pro/')) return false;

  if (req.method === 'GET' && ASSETS[route]) {
    const [type, file] = ASSETS[route];
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https://media-assets.swiggy.com data:; connect-src 'self'; base-uri 'none'; form-action 'self'"
      });
      res.end(data);
    } catch { json(res, 500, { ok: false, error: 'Mini App asset missing.' }); }
    return true;
  }
  if (!route.startsWith('/pro/api/')) {
    json(res, 404, { ok: false, error: 'Not found.' });
    return true;
  }

  const user = verifyTelegramWebAppInitData(req.headers['x-telegram-init-data']);
  if (!user) {
    json(res, 401, { ok: false, error: 'Open this Mini App from the Telegram bot. Session may need to be reopened.' });
    return true;
  }
  // A menu-button launch bypasses Telegram chat middleware; explicitly apply
  // the same service-pause and membership policy to every Mini App API call.
  if (typeof authorizeUser !== 'function') {
    json(res, 503, { ok: false, error: 'Mini App access policy is not configured.' });
    return true;
  }
  try {
    const decision = await authorizeUser(user);
    if (!decision?.allowed) {
      json(res, 403, { ok: false, error: decision?.message || 'Mini App access is not available.' });
      return true;
    }
  } catch {
    json(res, 503, { ok: false, error: 'Unable to verify Mini App access. Please retry.' });
    return true;
  }

  await withProWorkspaceLock(user.id, async () => {
    try {
      const ws = readProWorkspace(user.id);
      if (route === '/pro/api/bootstrap' && req.method === 'GET') {
        const quotedAt = Date.parse(ws.cart?.quote?.fetchedAt || '');
        if (ws.cart?.quote && (!Number.isFinite(quotedAt) || Date.now() - quotedAt > 5 * 60_000 || quotedAt > Date.now() + 30_000)) {
          ws.cart.quote = null;
          writeProWorkspace(user.id, ws);
        }
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/send-otp' && req.method === 'POST') {
        const body = await bodyJson(req);
        const phone = normalizeIndianMobileNumber(body.phone);
        if (!phone) throw error(400, 'Enter a valid 10-digit Indian mobile number.');
        if (ws.checkout && ws.checkout.status !== 'PAID') {
          const original = normalizeIndianMobileNumber(ws.checkout.accountPhone || '');
          if (!original || phone !== original) throw error(409, 'Only the original checkout account can be reconnected while its outcome is unresolved.');
        }
        const now = Date.now();
        if (now - (otpRequestedAt.get(user.id) || 0) < 30_000) throw error(429, 'Please wait 30 seconds before requesting another OTP.');
        otpRequestedAt.set(user.id, now);
        const result = await otp.request(`pro_${user.id}`, phone, `private_${user.id}`, user.firstName || 'Swiggy User', { persistAccount: false, allowSignup: false, claimOffers: false });
        if (!result?.success) throw error(502, result?.message || 'Swiggy did not confirm that an OTP was sent.');
        ws.otpPhone = phone;
        otpAttempts.delete(user.id);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, message: 'Swiggy accepted the OTP request.' });
        return;
      }
      if (route === '/pro/api/accounts/verify-otp' && req.method === 'POST') {
        const body = await bodyJson(req);
        const digits = String(body.otp || '').trim();
        if (!ws.otpPhone || !/^\d{6}$/.test(digits)) throw error(400, 'Request an OTP and enter its six digits.');
        const attempts = otpAttempts.get(user.id) || 0;
        if (attempts >= 5) throw error(429, 'Too many attempts. Request a fresh OTP after the wait.');
        otpAttempts.set(user.id, attempts + 1);
        const result = await otp.verify(`pro_${user.id}`, digits);
        if (!result?.success || !result.exportJson) throw error(400, result?.message || 'Swiggy did not verify this OTP.');
        const session = normalizeSwiggySessionPayload(result.exportJson);
        if (!session || normalizeIndianMobileNumber(result.phone) !== ws.otpPhone) throw error(502, 'Swiggy returned an unexpected account; nothing was saved.');
        const live = await provider.verifySession({ ...session, __proPrivate: true });
        if (!live?.valid || !live.customerId) throw error(502, 'OTP was accepted, but Swiggy did not confirm the account session. Nothing was saved; request a fresh OTP and retry.');
        const profilePhone = normalizeIndianMobileNumber(live.phone || '');
        if (profilePhone && profilePhone !== ws.otpPhone) throw error(502, 'Swiggy returned a different account phone. Nothing was saved.');
        storeAccount(user, ws, {
          ...session, phone: ws.otpPhone, mobile: ws.otpPhone, customerId: live.customerId,
          tid: live.liveTid || session.tid || '', token: live.token || session.token || '', cookies: live.cookies || session.cookies || '',
          name: live.name || result.name || user.firstName, swiggyName: live.name || result.swiggyName || '', totalOrdersCount: result.totalOrdersCount
        });
        delete ws.otpPhone;
        otpAttempts.delete(user.id);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/import' && req.method === 'POST') {
        const body = await bodyJson(req);
        const session = normalizeSwiggySessionPayload(body.session);
        if (!session || !(session.token || session.tid || session.cookies)) throw error(400, 'Session JSON must contain Swiggy credentials.');
        const live = await provider.verifySession({ ...session, __proPrivate: true });
        if (!live?.valid || !live.customerId) throw error(502, 'Swiggy could not verify this session. Nothing was imported; check the session or retry later.');
        const suppliedPhone = normalizeIndianMobileNumber(session.phone || session.mobile || '');
        const verifiedPhone = normalizeIndianMobileNumber(live.phone || '');
        if (suppliedPhone && verifiedPhone && suppliedPhone !== verifiedPhone) throw error(400, 'The phone in this JSON differs from the Swiggy profile. Nothing was imported.');
        // Never display or use a JSON-supplied phone as a verified Swiggy
        // account phone when the provider did not return it.
        const phone = verifiedPhone || '';
        storeAccount(user, ws, {
          ...session, phone, mobile: phone, customerId: live.customerId || session.customerId || '',
          name: live.name || session.name || 'Swiggy account', swiggyName: live.name || '',
          tid: live.liveTid || session.tid || '', token: live.token || session.token || '', cookies: live.cookies || session.cookies || ''
        });
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/select' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key) || !map[key]?.isLoggedIn || map[key]?.isLoggedOut) throw error(404, 'Account not found.');
        if (ws.activeAccountKey !== key) {
          if (ws.checkout && ws.checkout.status !== 'PAID') throw error(409, 'Resolve the existing Swiggy checkout before switching accounts.');
          ws.activeAccountKey = key;
          invalidateAccountDependentState(ws);
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/remove' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
        if (ws.checkout && ws.checkout.accountKey === key && ws.checkout.status !== 'PAID') {
          throw error(409, 'This account has an unresolved checkout. Check it in Swiggy My Orders before removing the account.');
        }
        if (isBoss(user.id)) permanentLogoutAccount(key);
        else delete ws.accounts[key];
        if (ws.activeAccountKey === key) { ws.activeAccountKey = ''; invalidateAccountDependentState(ws); }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/addresses' && req.method === 'GET') {
        const account = currentAccount(user, ws);
        const addresses = await provider.addresses(account);
        if (!Array.isArray(addresses)) throw error(502, 'Could not fetch addresses from Swiggy.');
        ws.addressCandidates = addresses.slice(0, 50).map(a => ({ ...cleanAddress(a), ref: crypto.randomUUID() }));
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, addresses: ws.addressCandidates, note: addresses.length ? '' : 'No addresses returned. If you have saved addresses, retry: Swiggy may not have responded.' });
        return;
      }
      if (route === '/pro/api/addresses/select' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        const address = ws.addressCandidates.find(a => a.ref === String(body.ref || ''));
        if (!address) throw error(404, 'Address not found. Refresh the list.');
        ws.selectedAddress = cleanAddress(address);
        if (ws.cart) ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, selectedAddress: ws.selectedAddress, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/addresses/update-contact' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        if (!ws.selectedAddress) throw error(400, 'Select an address first.');
        const name = String(body.name || '').trim().slice(0, 120);
        const mobile = normalizeIndianMobileNumber(body.mobile || '');
        if (!name || !mobile) throw error(400, 'Enter the receiver name and valid 10-digit mobile number.');
        ws.selectedAddress = { ...ws.selectedAddress, name, mobile };
        if (ws.cart) ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, selectedAddress: ws.selectedAddress, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/addresses/resolve' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        const account = currentAccount(user, ws);
        if (typeof body.url !== 'string' || body.url.length > 2000) throw error(400, 'Paste a Swiggy address link.');
        const resolved = await provider.resolveAddress(account, body.url);
        ws.pendingAddress = cleanAddress(resolved);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, address: ws.pendingAddress });
        return;
      }
      if (route === '/pro/api/addresses/confirm' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        if (!ws.pendingAddress) throw error(400, 'Resolve an address link first.');
        const name = String(body.name || ws.pendingAddress.name || '').trim().slice(0, 120);
        const mobile = normalizeIndianMobileNumber(body.mobile || ws.pendingAddress.mobile || '');
        if (!name || !mobile) throw error(400, 'Confirm the receiver name and valid 10-digit mobile number.');
        ws.selectedAddress = { ...ws.pendingAddress, name, mobile };
        ws.pendingAddress = null;
        if (ws.cart) ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, selectedAddress: ws.selectedAddress, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/search' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (q.length < 2 || q.length > 80) throw error(400, 'Enter at least 2 characters.');
        const restaurants = await provider.search(currentAccount(user, ws), ws.selectedAddress, q);
        json(res, 200, { ok: true, restaurants });
        return;
      }
      if (route === '/pro/api/menu' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        if (!/^\d{1,20}$/.test(id)) throw error(400, 'Invalid restaurant.');
        const menu = await provider.menu(currentAccount(user, ws), ws.selectedAddress, id);
        ws.menu = menu;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...menu });
        return;
      }
      if (route === '/pro/api/cart/add' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        const menu = ws.menu;
        const id = String(body.itemId || '');
        const item = menu?.categories?.flatMap(c => c.items || []).find(i => i.id === id);
        if (!item) throw error(404, 'Menu item not found. Open its restaurant again.');
        if (menu.restaurant?.isOpen === false || item.inStock === false) throw error(400, 'This item is unavailable.');
        if (item.customizable || item.price === null) throw error(400, 'This item needs choices that are not supported here yet. Please use Swiggy for this item.');
        if (ws.cart && ws.cart.restaurantId !== menu.restaurant.id && body.replace !== true) throw error(409, 'Your cart has items from another restaurant. Confirm replacement.');
        if (!ws.cart || ws.cart.restaurantId !== menu.restaurant.id) {
          ws.cart = { restaurantId: menu.restaurant.id, restaurantName: menu.restaurant.name, items: [], forSomeoneElse: true, quote: null };
        }
        const existing = ws.cart.items.find(i => i.menu_item_id === Number(item.id) && !(i.variants?.length || i.addons?.length));
        if (existing) existing.qty = Math.min(20, existing.qty + 1);
        else ws.cart.items.push({ lineKey: crypto.randomUUID(), id: item.id, menu_item_id: Number(item.id), name: item.name, price: item.price, qty: 1, variants: [], addons: [], offer_ids: item.offer_ids, item_offer_cart_meta: item.item_offer_cart_meta });
        ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/cart/quantity' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        const item = ws.cart?.items?.find(i => i.lineKey === String(body.lineKey || ''));
        const qty = Number(body.qty);
        if (!item || !Number.isInteger(qty) || qty < 0 || qty > 20) throw error(400, 'Invalid item or quantity.');
        if (!qty) ws.cart.items = ws.cart.items.filter(i => i !== item);
        else item.qty = qty;
        ws.cart.quote = null;
        if (!ws.cart.items.length) ws.cart = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/cart/import-group' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        const account = currentAccount(user, ws);
        if (ws.cart && body.replace !== true) throw error(409, 'Confirm replacing your current cart.');
        if (typeof body.url !== 'string' || body.url.length > 2000) throw error(400, 'Paste a Swiggy group cart link.');
        const group = await provider.groupCart(account, ws.selectedAddress, body.url);
        if (!group?.restaurantId || !Array.isArray(group.items) || !group.items.length) throw error(502, 'Swiggy did not return group-cart items.');
        ws.cart = { ...group, items: group.items.map(i => ({ ...i, lineKey: crypto.randomUUID() })), forSomeoneElse: true, quote: null };
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/cart/sync' && req.method === 'POST') {
        const body = await bodyJson(req);
        requireEditableCart(ws);
        const account = currentAccount(user, ws);
        if (body.confirmReplaceSwiggyCart !== true) throw error(400, 'Confirm that the existing Swiggy cart may be replaced.');
        if (!ws.cart?.items?.length || !ws.selectedAddress) throw error(400, 'Add items and select an address first.');
        const coupon = String(body.coupon || '').trim().toUpperCase();
        if (coupon && !/^[A-Z0-9_-]{3,28}$/.test(coupon)) throw error(400, 'Invalid coupon code.');
        ws.cart.forSomeoneElse = body.forSomeoneElse === true;
        ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        const quote = await provider.quoteCart(account, ws.selectedAddress, ws.cart, coupon);
        ws.selectedAddress = cleanAddress(quote.address);
        ws.cart.quote = { ...quote.bill, ofoConfirmed: quote.ofoConfirmed === true, fetchedAt: new Date().toISOString() };
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart, selectedAddress: ws.selectedAddress });
        return;
      }
      if (route === '/pro/api/orders' && req.method === 'GET') {
        const account = orderHistoryAccount(user, ws, url.searchParams.get('scope') || 'active');
        const orders = await provider.orders(account);
        json(res, 200, { ok: true, orders });
        return;
      }
      if (route === '/pro/api/orders/tracking' && req.method === 'GET') {
        const id = normalizeSwiggyOrderId(url.searchParams.get('id'));
        if (!id) throw error(400, 'Invalid Swiggy order ID.');
        const account = orderHistoryAccount(user, ws, url.searchParams.get('scope') || 'active');
        const orders = await provider.orders(account);
        if (!orders.some(o => String(o.id) === id)) throw error(404, 'Order was not returned for this Swiggy account.');
        const tracking = await provider.tracking(account, id);
        const link = String(tracking?.trackingUrl || '');
        json(res, 200, { ok: true, tracking: {
          orderId: id, status: String(tracking?.status || '').slice(0, 200), eta: String(tracking?.eta || '').slice(0, 100),
          trackingUrl: safeTrackingUrl(link, id),
          deliveryOtp: /^\d{4,8}$/.test(String(tracking?.deliveryOtp || '')) ? String(tracking.deliveryOtp) : '',
          deliveryPartner: { name: String(tracking?.deliveryPartner?.name || '').slice(0, 100), phone: String(tracking?.deliveryPartner?.phone || '').slice(0, 30) }
        } });
        return;
      }
      if (route === '/pro/api/checkout' && req.method === 'POST') {
        const body = await bodyJson(req);
        if (process.env.PRO_ENABLE_CHECKOUT !== '1') throw error(503, 'Experimental in-app checkout is disabled. Review and pay in Swiggy instead.');
        if (ws.checkout) throw error(409, 'A checkout is already pending or unresolved. Check its status; do not place another order.');
        const account = currentAccount(user, ws);
        const customerId = String(account.customerId || '').trim();
        if (!customerId) throw error(409, 'Reconnect this Swiggy account before checkout so its identity can be verified for recovery.');
        const quote = ws.cart?.quote;
        const quotedAt = Date.parse(quote?.fetchedAt || '');
        const total = Number(quote?.total);
        if (body.confirmCheckout !== true || !quote || !ws.cart?.items?.length || !ws.selectedAddress ||
            !Number.isFinite(quotedAt) || quotedAt > Date.now() + 30_000 || Date.now() - quotedAt > 5 * 60_000 ||
            String(body.quoteFetchedAt || '') !== String(quote.fetchedAt) || exactPaise(total) === null || total <= 0 ||
            exactPaise(body.expectedTotal) === null || exactPaise(body.expectedTotal) !== exactPaise(total)) {
          throw error(400, 'Review a fresh Swiggy bill and explicitly confirm its exact amount before placing an order.');
        }
        // One durable barrier per user and checkout generation, regardless of
        // account, quote refresh or concurrent stale workspace reads. Advance the
        // generation ONLY after this order is verified paid and explicitly closed.
        // Workspace/cart mutation still requires one app instance (see setup).
        const generation = ws.checkoutGeneration ?? 0;
        if (!Number.isSafeInteger(generation) || generation < 0) throw error(503, 'Checkout state is invalid; contact the operator.');
        const checkoutId = String(generation);
        const placementKey = `pro:${user.id}:${checkoutId}`;
        ws.checkout = {
          id: checkoutId, accountKey: ws.activeAccountKey, accountPhone: String(account.phone || ''), status: 'SUBMITTING',
          accountCustomerId: customerId,
          createdAt: new Date().toISOString(), amount: total, restaurantName: String(ws.cart.restaurantName || '')
        };
        // Persist the logical ID before the provider can send a placement POST.
        writeProWorkspace(user.id, ws);
        let providerReturned = false;
        let result;
        try {
          result = await provider.checkout(account, ws.selectedAddress, ws.cart, placementKey);
          providerReturned = true;
          const orderId = normalizeSwiggyOrderId(result?.orderId);
          const uri = String(result?.upiIntentUrl || '');
          const intent = validateUpiIntentForQr(uri, { amount: total, requireAmount: true });
          if (!orderId || uri.length > 6000 || !intent.valid || exactPaise(intent.info?.amount) === null ||
              exactPaise(intent.info.amount) !== exactPaise(total)) {
            throw new Error('Provider response did not contain matching payment details.');
          }
          const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
          Object.assign(ws.checkout, {
            status: 'PAYMENT_PENDING', orderId, paymentTxnId: String(result.paymentTxnId || '').slice(0, 200),
            upiIntentUrl: uri, qrDataUrl, ofoConfirmed: result.ofoConfirmed === true,
            message: 'Swiggy returned payment details. Payment and restaurant acceptance are not yet verified.'
          });
          writeProWorkspace(user.id, ws);
        } catch (err) {
          const record = readSwiggyPlacement(placementKey);
          if (record || err?.diag?.placementAttempted === true || providerReturned) {
            ws.checkout.status = 'OUTCOME_UNKNOWN';
            ws.checkout.orderId = normalizeSwiggyOrderId(result?.orderId || err?.diag?.placedOrderId || record?.orderId || '');
            ws.checkout.message = 'An order may exist on Swiggy. Open My Orders on the original account; do not retry or switch accounts.';
            delete ws.checkout.upiIntentUrl;
            delete ws.checkout.qrDataUrl;
            writeProWorkspace(user.id, ws);
            json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout) });
            return;
          }
          ws.checkout = null;
          if (ws.cart) ws.cart.quote = null;
          writeProWorkspace(user.id, ws);
          throw error(Number(err?.statusCode) || 502, String(err?.message || 'Checkout could not be prepared. No order was placed.'));
        }
        json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout) });
        return;
      }
      if (route === '/pro/api/checkout/status' && req.method === 'POST') {
        await bodyJson(req);
        const checkout = ws.checkout;
        if (!checkout) throw error(404, 'No Mini App checkout exists.');
        if (checkout.status === 'PAID' || !normalizeSwiggyOrderId(checkout.orderId)) {
          json(res, 200, { ok: true, checkout: publicCheckout(checkout) });
          return;
        }
        const payment = await provider.checkPayment(checkoutAccount(user, ws), checkout);
        const exactPaidOrder = payment?.paid === true && String(payment.swiggyOrderId || '') === String(checkout.orderId);
        checkout.paymentVerified = checkout.paymentVerified === true || payment?.paymentVerified === true || exactPaidOrder;
        if (exactPaidOrder) {
          const link = String(payment.trackingUrl || payment.nativeShareUrl || payment.swiggyWebTrackUrl || '');
          checkout.status = 'PAID';
          checkout.message = 'Swiggy returned a paid order for this exact order ID.';
          checkout.tracking = {
            orderId: checkout.orderId, status: String(payment.orderStatus || '').slice(0, 200),
            eta: String(payment.etaMinutes || '').slice(0, 100),
            trackingUrl: safeTrackingUrl(link, checkout.orderId),
            deliveryOtp: /^\d{4,8}$/.test(String(payment.deliveryOtp || '')) ? String(payment.deliveryOtp) : '',
            deliveryPartner: { name: String(payment.deliveryBoy?.name || '').slice(0, 100), phone: String(payment.deliveryBoy?.mobile || '').slice(0, 30) }
          };
          delete checkout.upiIntentUrl;
          delete checkout.qrDataUrl;
        } else if (checkout.paymentVerified) {
          checkout.message = 'Payment was reported by Swiggy, but this exact order is not yet confirmed. Check My Orders; do not pay again.';
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, checkout: publicCheckout(checkout) });
        return;
      }
      if (route === '/pro/api/checkout/finish' && req.method === 'POST') {
        const body = await bodyJson(req);
        if (body.confirmNewDraft !== true || ws.checkout?.status !== 'PAID') throw error(409, 'Only a verified paid order can be closed here.');
        const generation = ws.checkoutGeneration ?? 0;
        if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) throw error(503, 'Checkout state is invalid; contact the operator.');
        ws.checkoutGeneration = generation + 1;
        ws.checkout = null;
        ws.cart = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      throw error(404, 'Not found.');
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      // Do not log inputs, tokens, addresses, or raw Swiggy errors.
      const code = ['PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED'].includes(err?.code) ? err.code : undefined;
      json(res, status, {
        ok: false,
        error: status >= 500 && status !== 501 && status !== 502 && status !== 503 ? 'Unable to complete this request. Please retry.' : String(err?.message || 'Request failed.'),
        ...(code ? { code } : {})
      });
    }
  });
  return true;
}
