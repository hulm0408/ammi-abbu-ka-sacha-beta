import crypto from 'node:crypto';
import fs from 'node:fs';
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
function publicState(user, ws) {
  return {
    user: { name: user.firstName || 'Friend', isBoss: isBoss(user.id) },
    accounts: listAccounts(user, ws), activeAccount: activeAccountForClient(user, ws),
    selectedAddress: ws.selectedAddress, cart: ws.cart
  };
}
function storeAccount(user, ws, incoming) {
  const phone = normalizeIndianMobileNumber(incoming.phone || incoming.mobile || '') || '';
  if (isBoss(user.id)) {
    if (!phone) throw error(400, 'Swiggy did not return an account phone number.');
    const key = `acc_${phone}`;
    updateAccount(key, { ...incoming, phone, mobile: phone, isLoggedIn: true });
    ws.activeAccountKey = key;
  } else {
    const match = Object.entries(ws.accounts).find(([, a]) =>
      (phone && normalizeIndianMobileNumber(a.phone || a.mobile) === phone) ||
      (incoming.customerId && String(a.customerId || '') === String(incoming.customerId))
    );
    const key = match?.[0] || `private_${crypto.randomUUID()}`;
    ws.accounts[key] = { ...incoming, phone, mobile: phone, isLoggedIn: true };
    ws.activeAccountKey = key;
  }
  invalidateAccountDependentState(ws);
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
        if (ws.activeAccountKey !== key) { ws.activeAccountKey = key; invalidateAccountDependentState(ws); }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/remove' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
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
        const orders = await provider.orders(currentAccount(user, ws));
        json(res, 200, { ok: true, orders });
        return;
      }
      if (route === '/pro/api/checkout' && req.method === 'POST') {
        throw error(501, 'In-app payment and placement are not enabled yet. Use Swiggy to review the cart and complete the order.');
      }
      throw error(404, 'Not found.');
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      // Do not log inputs, tokens, addresses, or raw Swiggy errors.
      json(res, status, { ok: false, error: status >= 500 && status !== 501 && status !== 502 && status !== 503 ? 'Unable to complete this request. Please retry.' : String(err?.message || 'Request failed.') });
    }
  });
  return true;
}
