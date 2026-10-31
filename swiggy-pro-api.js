import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { validateUpiIntentForQr } from './payment-qr-guard.js';
import { readSwiggyPlacement } from './swiggy-placement-journal.js';
import { exactPaise } from './swiggy-cart-integrity.js';
import { isOfficialSwiggyTrackingUrl, normalizeSwiggyOrderId, validateTrackingUrlForOrder } from './swiggy-cart.js';
import { deleteAccount, getDb, isBoss, updateAccount, permanentLogoutAccount, normalizeSwiggySessionPayload } from './store.js';
import { requestSwiggyDeleteOtpViaBridge, requestSwiggyOtpViaBridge, verifyAndDeleteSwiggyAccountViaBridge, verifySwiggyOtpViaBridge } from './swiggy-bridge.js';
import { activateAllEventOffers } from './event-offers.js';
import { OFFER_TRACKS } from './account-views.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { describeAccountForPicker } from './mini-app.js';
import { proProvider } from './swiggy-pro-provider.js';
import { backupProWorkspaceNow, cloudBackupEnabled, ensureProWorkspaceHydrated, proBackupStatus, readProWorkspace, writeProWorkspace, withProWorkspaceLock } from './swiggy-pro-store.js';

const ASSETS = {
  '/pro': ['text/html; charset=utf-8', new URL('./swiggy-pro.html', import.meta.url)],
  '/pro/': ['text/html; charset=utf-8', new URL('./swiggy-pro.html', import.meta.url)],
  '/pro/app.js': ['text/javascript; charset=utf-8', new URL('./swiggy-pro-app.js', import.meta.url)],
  '/pro/style.css': ['text/css; charset=utf-8', new URL('./swiggy-pro.css', import.meta.url)]
};
const MAX_INIT_AGE_SECONDS = 24 * 60 * 60;
const otpRequestedAt = new Map();
const otpAttempts = new Map();
const deleteOtpRequestedAt = new Map();
const defaultOtp = { request: requestSwiggyOtpViaBridge, verify: verifySwiggyOtpViaBridge };
const defaultDeleteOtp = {
  request: (userId, phone, key, name, account) => requestSwiggyDeleteOtpViaBridge(userId, phone, key, name, account),
  verify: (userId, otp, key) => verifyAndDeleteSwiggyAccountViaBridge(userId, otp, key)
};

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

/**
 * Boss (31-10-2026): "JO ACCOUNT ME UPLOAD KARTA HU WO SAARE USERS KO SHOW HONA
 * CHAHIYE BUT KOI USER AGAR APNA ACCOUNT ADD KARE TO WO SABKO SHOW NA HO."
 *
 * Isliye map do hone chahiye:
 *   • shared (boss/operator vault) — har user ko dikhta hai, par sirf boss
 *     badal sakta hai;
 *   • private workspace — sirf us Telegram user ka, kisi doosre ko kabhi nahi.
 * Boss ka apna map pehle jaisa hi shared vault hai (boss wahin likhta hai).
 */
function sharedAccountMap() {
  try { return getDb().config?.accounts || {}; } catch { return {}; }
}
function accountMap(user, workspace) {
  const shared = sharedAccountMap();
  if (isBoss(user.id)) return shared;
  return { ...shared, ...workspace.accounts };
}
/**
 * Kya ye ID operator (boss) ki hai? User ke apne workspace me isi key ka
 * account ho to wo uska apna hai — shared map me same naam ho to bhi private
 * hi rahega (key collision se kisi ka data kisi ko nahi dikhna chahiye).
 */
function isSharedAccountFor(user, workspace, key) {
  const k = String(key);
  if (isBoss(user.id)) return false;
  if (Object.prototype.hasOwnProperty.call(workspace?.accounts || {}, k)) return false;
  return Object.prototype.hasOwnProperty.call(sharedAccountMap(), k);
}
/** Doosre ke number poora nahi dikhta — sirf operator ko poora. */
function maskAccountPhone(phone) {
  const p = normalizeIndianMobileNumber(phone || '') || '';
  if (p.length !== 10) return '';
  return `${p.slice(0, 2)}••••${p.slice(-4)}`;
}
/**
 * Boss (30-10-2026): "har ID ke saamne likha ho ki isse order place hua hai ki
 * nahi, suspend ya koi dikkat ho… free cash icon… offer active hai ya nahi…
 * aur used ID ko kaat de."
 *
 * Har row ab ASLI sach ke saath aati hai (`mini-app.js` ka picker helper):
 *   READY (0 order) / USED (kaat di jati hai) / SUSPENDED / SESSION_EXPIRED /
 *   BUSY (kisi chalte order ki ID) / UNVERIFIED (live check nahi hua).
 * Jo verify nahi hua usko kabhi "used" nahi likhte.
 */
function listAccounts(user, workspace) {
  const map = accountMap(user, workspace);
  const boss = isBoss(user.id);
  const bossDb = boss ? getDb() : null;
  return Object.entries(map)
    .filter(([, a]) => a && a.isLoggedIn && !a.isLoggedOut)
    .map(([key, a]) => {
      const shared = isSharedAccountFor(user, workspace, key);
      const mine = !shared;
      // Shared ID par kisi ka live order chal raha ho to wo sabke liye busy
      // hai — isliye shared rows ke liye poora db dekhte hain.
      const truth = describeAccountForPicker(key, a, boss || shared ? { db: bossDb || getDb() } : { accounts: map, orders: {} });
      return {
        key,
        name: String(a.swiggyName || a.name || 'Swiggy account').slice(0, 80),
        phone: mine ? (normalizeIndianMobileNumber(a.phone || a.mobile || '') || '') : '',
        phoneMasked: mine ? '' : maskAccountPhone(a.phone || a.mobile || ''),
        owner: shared || boss ? 'operator' : 'self',
        canClaim: mine,
        canRemove: mine,
        // Used ID sirf warning ke baad khulti hai (boss 31-10-2026).
        needsConfirm: truth.status === 'USED',
        active: key === workspace.activeAccountKey,
        ordersCount: Number.isInteger(a.totalOrdersCount) ? a.totalOrdersCount : null,
        sessionExpired: Boolean(a.sessionExpired),
        // ── sach (UI inhi par icons/reason dikhata hai) ──
        status: truth.status,
        selectable: truth.selectable,
        reason: truth.reason,
        icons: truth.icons,
        freeCash: truth.freeCash,
        offers: truth.offers,
        // Har track ka sach — Mini App me claim button isi par chalta hai.
        offerTracks: OFFER_TRACKS.map(track => {
          const rec = a.offerAutoActivation?.[track.key] || a.offers?.[track.key] || null;
          return {
            key: track.key,
            label: track.label,
            emoji: track.emoji,
            status: String(rec?.status || rec?.state || 'NOT_CLAIMED'),
            verified: rec?.verified === true || rec?.status === 'CLAIMED' || rec?.status === 'ALREADY_ACTIVE',
            message: String(rec?.message || '').slice(0, 160)
          };
        }),
        busyOrderId: truth.busyOrderId,
        ordersVerifiedLive: truth.ordersVerifiedLive
      };
    });
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
/**
 * Purane session JSON me `customer_id` nahi hota. Checkout usi par rukta tha
 * ("reconnect karein") — user ke liye dead end. Bill/sync ke waqt ek hi baar
 * Swiggy se identity le kar workspace me save kar dete hain; order placement
 * ka raasta (aur uska double-tap barrier) chhua nahi jaata.
 */
async function ensureAccountCustomerId(provider, user, ws, account) {
  const existing = String(account?.customerId || '').trim();
  if (existing) return existing;
  const live = await provider.verifySession(account).catch(() => null);
  const resolved = String(live?.customerId || '').trim();
  if (!resolved) return '';
  account.customerId = resolved;
  const key = String(ws.activeAccountKey || '');
  if (key && ws.accounts?.[key]) {
    ws.accounts[key] = { ...ws.accounts[key], customerId: resolved };
    writeProWorkspace(user.id, ws);
  }
  return resolved;
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
/**
 * `restricted` = user ne operator (shared) ID par order kiya. Us haalat me
 * operator ka poora number aur tracking detail user ko nahi dikhte (boss
 * 31-10-2026: "MOBILE NUMBER BHI FULL NAHI DIKHEGA ... TRACKING BHI NAHI").
 */
function publicCheckout(checkout, { restricted = false } = {}) {
  if (!checkout) return null;
  const output = {
    status: String(checkout.status || 'UNKNOWN'), createdAt: String(checkout.createdAt || ''),
    accountPhone: restricted ? maskAccountPhone(checkout.accountPhone) : String(checkout.accountPhone || ''),
    orderId: String(checkout.orderId || ''), amount: Number(checkout.amount) || 0,
    restaurantName: String(checkout.restaurantName || ''),
    ofoConfirmed: checkout.ofoConfirmed === true,
    paymentVerified: checkout.paymentVerified === true,
    message: String(checkout.message || ''),
    tracking: restricted ? null : (checkout.tracking || null),
    restricted: restricted === true
  };
  if (checkout.status === 'PAYMENT_PENDING' && checkout.paymentVerified !== true && checkout.upiIntentUrl && checkout.qrDataUrl) {
    output.upiIntentUrl = checkout.upiIntentUrl;
    output.qrDataUrl = checkout.qrDataUrl;
  }
  return output;
}
/**
 * Boss: "direct cart wale page par le jaye — ek auto ID select karke."
 * Sirf tab jab user ne khud koi ID na chuni ho, aur sirf selectable ID.
 */
function autoSelectAccount(user, ws) {
  try {
    if (ws.activeAccountKey) return;
    const rows = listAccounts(user, ws);
    const pick = rows.find(r => r.selectable);
    if (!pick) return;
    ws.activeAccountKey = pick.key;
    invalidateAccountDependentState(ws);
    writeProWorkspace(user.id, ws);
  } catch { /* auto-select fail ho to user khud chun sakta hai */ }
}

/**
 * Boss (31-10-2026): "BILL CALCULATION BHI NA HORAHA SAHI SE — IMAGE JAISA HONA
 * CHAHIYE." Swiggy screenshot: Item total (list strike), Delivery FREE,
 * GST & other charges, To Pay. Yahan hum sirf wahi numbers rakhte hain jo
 * Swiggy ne diye, aur lines ko itna banana ki unka jod To Pay ke barabar ho.
 * Jod nahi milta to hum chupe nahi rakhte — `mismatch` sach bolta hai.
 */
function round2(value) { return Math.round(Number(value) * 100) / 100; }
function billBreakdown(bill) {
  if (!bill || typeof bill !== 'object') return bill;
  const num = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : round2(value));
  const pos = value => Math.max(0, num(value) ?? 0);
  const add = (...values) => values.reduce((sum, v) => sum + (v === null || v === undefined ? 0 : v), 0);
  const itemTotal = num(bill.itemTotal);
  const deliveryFee = num(bill.deliveryFee);
  const packingCharges = num(bill.packingCharges);
  const taxes = num(bill.taxes);
  const discount = pos(bill.discount);
  const freeCash = pos(bill.freeCash);
  const tradeDiscount = pos(bill.tradeDiscount);
  const oneMembershipFee = pos(bill.oneMembershipFee);
  const total = num(bill.total);
  let otherCharges = 0;
  let unlistedDiscount = 0;
  let couponApplied = discount > 0;
  if (total !== null) {
    // Boss (31-10-2026, round 9): bill summary me wahi lines jo Swiggy dikhata
    // hai. Net = items + delivery + packing + gst + One fee − coupon − free
    // cash − restaurant discount. Bacha hua = platform/other charge, kam pada
    // = chhupa hua discount — dono sach ke saath, koi darawne warning nahi.
    const gross = add(itemTotal, deliveryFee, packingCharges, taxes, oneMembershipFee);
    const known = total - add(gross, -discount, -freeCash, -tradeDiscount);
    if (Math.abs(known) >= 0.5) {
      if (known > 0) otherCharges = round2(known);
      else unlistedDiscount = round2(Math.abs(known));
    }
    if (discount > 0 && Math.abs(total - add(gross, -freeCash, -tradeDiscount, otherCharges)) < 0.5) {
      couponApplied = false;
    }
  }
  const totalSavings = num(bill.totalSavings) ?? round2(discount + freeCash + tradeDiscount + pos(bill.deliverySaved));
  return {
    ...bill,
    itemTotal, deliveryFee, packingCharges, taxes,
    discount: couponApplied ? discount : null,
    coupon: couponApplied ? String(bill.coupon || '') : '',
    discountAlreadyApplied: discount > 0 && !couponApplied,
    freeCash, tradeDiscount, oneMembershipFee,
    oneApplied: bill.oneApplied === true || oneMembershipFee > 0,
    deliverySaved: pos(bill.deliverySaved),
    otherCharges,
    unlistedDiscount,
    taxesAndCharges: round2(add(packingCharges, taxes, otherCharges)),
    totalSavings: Math.max(round2(totalSavings), round2(discount + freeCash + tradeDiscount)),
    total,
    mismatch: false
  };
}

/**
 * Mini App me claim aur delete jaise write kaam ke liye ek hi jagah.
 * Boss ka account shared vault me, user ka uske apne workspace me.
 */
function persistAccountPatch(user, ws, key, patch) {
  if (isBoss(user.id)) { updateAccount(key, patch); return; }
  if (!Object.prototype.hasOwnProperty.call(ws.accounts || {}, key)) throw error(404, 'Account not found.');
  ws.accounts[key] = { ...ws.accounts[key], ...patch };
}
function removeAccountLocally(user, ws, key) {
  if (isBoss(user.id)) {
    // Boss ne Swiggy se delete kar diya — local vault se bhi hatao.
    deleteAccount(key, { purgeVault: true });
    return;
  }
  delete ws.accounts[key];
}
function offerClaimSummary(result) {
  const offers = result?.offers && typeof result.offers === 'object' ? result.offers : {};
  return OFFER_TRACKS.map(track => {
    const rec = offers[track.key] || null;
    return {
      key: track.key, label: track.label, emoji: track.emoji,
      status: String(rec?.status || rec?.state || 'NOT_CLAIMED'),
      verified: rec?.verified === true,
      message: String(rec?.message || '').slice(0, 200)
    };
  });
}

/**
 * Backup ka sach: boss ko poora detail (kahan fail hua), user ko bas itna ki
 * uska data mirror me hai ya nahi. Jhooth nahi — jo hai wahi.
 */
function userBackupView(user) {
  const status = proBackupStatus();
  if (isBoss(user.id)) return status;
  return {
    cloud: { enabled: cloudBackupEnabled() },
    dbMirror: { enabled: true, rows: status.dbMirror.rows },
    restored: { count: status.restored.count, lastAt: status.restored.lastAt }
  };
}

function checkoutEnabled() {
  if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1') return false;
  return process.env.PRO_ENABLE_CHECKOUT !== '0';
}
/** Payment band hone ki asli wajah — bina wajah koi dead end nahi. */
function checkoutBlockReason() {
  if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1') return 'Live order placement is blocked in this environment (SWIGGY_BLOCK_LIVE_ORDER_PLACE=1).';
  if (process.env.PRO_ENABLE_CHECKOUT === '0') return 'In-app checkout is turned off by PRO_ENABLE_CHECKOUT=0.';
  return '';
}

function publicState(user, ws) {
  autoSelectAccount(user, ws);
  return {
    user: { name: user.firstName || 'Friend', isBoss: isBoss(user.id) },
    accounts: listAccounts(user, ws), activeAccount: activeAccountForClient(user, ws),
    selectedAddress: ws.selectedAddress, cart: ws.cart,
    checkout: publicCheckout(ws.checkout, { restricted: Boolean(ws.checkout) && isSharedAccountFor(user, ws, ws.checkout.accountKey) }),
    // Boss (31-10-2026, round 3): "ACTUAL PAYMENT FLOW APPLY KAR." Ab in-app
    // checkout default ON hai; band karna ho to PRO_ENABLE_CHECKOUT=0.
    // Asli order placement ka hard block (SWIGGY_BLOCK_LIVE_ORDER_PLACE=1) phir
    // bhi sabse upar hai.
    checkoutEnabled: checkoutEnabled(),
    checkoutBlockReason: checkoutBlockReason()
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
/**
 * Boss (31-10-2026): "USER KO ORDER HISTORY ME BAS CHOTA CARD DIKHEGA, JAB ME
 * KHOLU TO PURA DETAILS." Shared (operator) ID par user ko sirf compact card —
 * address, item-wise detail aur tracking link nahi. Apne add kiye ID par aur
 * boss ke liye poora detail.
 */
function orderDetailAllowed(user, workspace, key) {
  return !isSharedAccountFor(user, workspace, key);
}
function compactOrder(order) {
  return {
    id: order.id, restaurant: order.restaurant, status: order.status,
    placedAt: order.placedAt, amount: order.amount,
    items: [], address: '', restricted: true
  };
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

export async function handleSwiggyProHttp(req, res, { provider = proProvider, otp = defaultOtp, authorizeUser = null, claim = activateAllEventOffers, deleteOtp = defaultDeleteOtp } = {}) {
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
      // Redeploy ke baad naya disk khali ho sakta hai — encrypted workspace
      // cloud vault se wapas (sirf jab local file na ho).
      await ensureProWorkspaceHydrated(user.id);
      const ws = readProWorkspace(user.id);
      if (route === '/pro/api/bootstrap' && req.method === 'GET') {
        const quotedAt = Date.parse(ws.cart?.quote?.fetchedAt || '');
        if (ws.cart?.quote && (!Number.isFinite(quotedAt) || Date.now() - quotedAt > 5 * 60_000 || quotedAt > Date.now() + 30_000)) {
          ws.cart.quote = null;
          writeProWorkspace(user.id, ws);
        }
        json(res, 200, { ok: true, ...publicState(user, ws), backup: userBackupView(user) });
        return;
      }
      if (route === '/pro/api/backup' && req.method === 'POST') {
        // Boss (31-10-2026): "DATA TO ERASE HOJATA." Ab backup ka asli sach +
        // ek button jo turant backup kar ke result dikhata hai.
        if (!isBoss(user.id)) throw error(403, 'Backup sirf boss kar sakta hai.');
        const result = await backupProWorkspaceNow(user.id);
        json(res, 200, { ok: true, result, backup: userBackupView(user) });
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
        // Boss (31-10-2026): "JAISE KOI USED ID HAI PHIR BHI KOI USKO SELECT
        // KARNA CHAHTA TO EK WARNING DEKAR USKO PHIR WO SELECT KAR PAYEGA."
        // Isliye USED ab confirm ke baad khulti hai. Suspended / expired /
        // busy ID phir bhi band rehti hai — unse order ho hi nahi sakta, aur
        // busy ID kisi chalte order ki hai (wo kabhi doosre ko nahi milti).
        {
          const row = listAccounts(user, ws).find(r => r.key === key);
          if (row && row.needsConfirm === true && body.confirmUsed === true) {
            // explicit user warning acknowledgement — aage badho
          } else if (row && row.selectable === false) {
            const e = error(409, row.reason || `Ye ID abhi select nahi ho sakti (${row.status}).`);
            e.code = 'ACCOUNT_NEEDS_CONFIRM';
            throw e;
          }
        }
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
        // Boss (31-10-2026): delete par DO option — sirf database se hatana, ya
        // Swiggy se account hi delete karna (uske liye Swiggy ka delete OTP).
        if (String(body.mode || 'local') === 'swiggy') {
          if (isSharedAccountFor(user, ws, key)) {
            const e = error(403, 'Operator ka ID aap Swiggy se delete nahi kar sakte. Sirf apna add kiya ID.');
            e.code = 'SHARED_ACCOUNT_RESTRICTED';
            throw e;
          }
          const account = map[key];
          const phone = normalizeIndianMobileNumber(account?.phone || account?.mobile || '') || '';
          if (!phone) throw error(400, 'Is account ka phone number nahi mila, isliye Swiggy delete OTP nahi bhej sakte.');
          const now = Date.now();
          if (now - (deleteOtpRequestedAt.get(user.id) || 0) < 30_000) throw error(429, 'Please wait 30 seconds before requesting another delete OTP.');
          deleteOtpRequestedAt.set(user.id, now);
          let requested;
          try {
            requested = await deleteOtp.request(`pro_${user.id}`, phone, key, account?.swiggyName || account?.name || '', { ...account, __proPrivate: true });
          } catch (delErr) {
            throw error(502, `Swiggy delete OTP fail hua: ${String(delErr?.message || 'jawab nahi mila').slice(0, 160)}. Account waisa hi hai.`);
          }
          if (!requested?.success) throw error(502, requested?.message || 'Swiggy ne delete OTP nahi bheja. Account waisa hi hai.');
          json(res, 200, {
            ok: true, otpRequired: true, key,
            phoneMasked: maskAccountPhone(phone),
            message: 'Swiggy ne delete OTP bheja hai. OTP daalne par account Swiggy se delete ho jayega — ye wapas nahi hota.'
          });
          return;
        }
        if (isBoss(user.id)) permanentLogoutAccount(key);
        else if (isSharedAccountFor(user, ws, key)) {
          // Operator ka ID sabko dikhta hai par kisi user ke haath se delete
          // nahi hota — warna ek user sabka ID uda dega.
          throw error(403, 'Ye operator ka ID hai; aap ise remove nahi kar sakte. Apna add kiya ID hi remove hota hai.');
        } else delete ws.accounts[key];
        if (ws.activeAccountKey === key) { ws.activeAccountKey = ''; invalidateAccountDependentState(ws); }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/remove/confirm' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const digits = String(body.otp || '').replace(/\D/g, '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
        if (isSharedAccountFor(user, ws, key)) {
          const e = error(403, 'Operator ka ID aap Swiggy se delete nahi kar sakte.');
          e.code = 'SHARED_ACCOUNT_RESTRICTED';
          throw e;
        }
        if (!/^\d{6}$/.test(digits)) throw error(400, 'Swiggy ne jo 6-digit delete OTP bheja hai wahi daalein.');
        if (ws.checkout && ws.checkout.accountKey === key && ws.checkout.status !== 'PAID') {
          throw error(409, 'Is account ka checkout pending hai. Pehle Swiggy My Orders me check karein.');
        }
        const deleted = await deleteOtp.verify(`pro_${user.id}`, digits, key);
        if (!deleted?.success) throw error(400, deleted?.message || 'Swiggy ne delete OTP accept nahi kiya. Account waisa hi hai.');
        removeAccountLocally(user, ws, key);
        if (ws.activeAccountKey === key) { ws.activeAccountKey = ''; invalidateAccountDependentState(ws); }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, deleted: true, message: 'Account Swiggy se delete ho gaya aur yahan se bhi hat gaya.', ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/offers/claim' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
        if (isSharedAccountFor(user, ws, key)) {
          // Boss (31-10-2026): operator ke ID par claim band — wo unka free cash hai.
          const e = error(403, 'Operator ke ID par offer claim nahi hota. Apna add kiya ID select karein.');
          e.code = 'SHARED_ACCOUNT_RESTRICTED';
          throw e;
        }
        const account = map[key];
        if (!account?.isLoggedIn || account?.isLoggedOut) throw error(409, 'Pehle is ID ko login karein.');
        if (ws.checkout && ws.checkout.status !== 'PAID') throw error(409, 'Checkout pending hai. Pehle usko resolve karein, phir claim karein.');
        let result;
        try {
          result = await claim({ ...account, __proPrivate: true }, { force: false });
        } catch (claimErr) {
          throw error(502, `Claim fail hua: ${String(claimErr?.message || 'Swiggy ne jawab nahi diya').slice(0, 160)}. Dobara try kar sakte hain.`);
        }
        const tracks = offerClaimSummary(result);
        // Jo sach mila wahi save — icons agla boot bhi sach dikhayein.
        persistAccountPatch(user, ws, key, {
          offerAutoActivation: {
            ...(account.offerAutoActivation && typeof account.offerAutoActivation === 'object' ? account.offerAutoActivation : {}),
            ...Object.fromEntries(Object.entries(result?.offers || {}).filter(([, value]) => value && typeof value === 'object'))
          },
          offersUpdatedAt: new Date().toISOString()
        });
        writeProWorkspace(user.id, ws);
        json(res, 200, {
          ok: true,
          claim: {
            summary: result?.summary || null,
            allActive: result?.allActive === true,
            tracks
          },
          ...publicState(user, ws)
        });
        return;
      }
      if (route === '/pro/api/addresses' && req.method === 'GET') {
        // Boss (31-10-2026): "ADDRESS WAGAIRA BHI WO NAHI DEKH SAKTA DUSRE LOGO
        // KA — ONLY USKA DEKH SAKTA, BUT ME SABKA DEKH SAKTA."
        // Shared (operator) ID par saved address list kisi user ko nahi dikhti;
        // user apna address link se add karta hai, aur wo uske workspace me
        // rehta hai. Boss ko sab dikhta hai.
        const activeKey = String(ws.activeAccountKey || '');
        if (isSharedAccountFor(user, ws, activeKey)) {
          ws.addressCandidates = [];
          writeProWorkspace(user.id, ws);
          json(res, 200, {
            ok: true, addresses: [],
            note: 'Ye operator ka ID hai. Purane address (kisi aur ke) nahi dikhaye jaate — apna address link se add karein. Aapka add kiya address sirf aapko dikhta hai.'
          });
          return;
        }
        const account = currentAccount(user, ws);
        // Ek transient failure par seedha error nahi — Swiggy kabhi kabhi ek
        // hi try me jawab nahi deta (boss: "ADDRESS FETCH NA HORAHA").
        let addresses = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2 && addresses === null; attempt += 1) {
          try {
            const result = await provider.addresses(account);
            if (Array.isArray(result)) addresses = result;
            else lastError = error(502, 'Could not fetch addresses from Swiggy.');
          } catch (err) {
            lastError = err;
            if (attempt === 0) await new Promise(r => setTimeout(r, 350));
          }
        }
        if (!Array.isArray(addresses)) throw lastError || error(502, 'Could not fetch addresses from Swiggy.');
        ws.addressCandidates = addresses.slice(0, 50).map(a => ({ ...cleanAddress(a), ref: crypto.randomUUID() }));
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, addresses: ws.addressCandidates, note: addresses.length ? '' : 'Swiggy ne koi saved address nahi diya. Address link se add karein, ya ek baar Refresh dabayein — Swiggy kabhi kabhi late jawab deta hai.' });
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
        if (ws.cart && String(ws.cart.restaurantId) === String(menu?.restaurant?.id)) {
          Object.assign(ws.cart, {
            restaurantArea: String(menu.restaurant.area || ''),
            restaurantTime: String(menu.restaurant.time || ''),
            restaurantImage: String(menu.restaurant.image || ''),
            restaurantRating: String(menu.restaurant.rating || '')
          });
        }
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
        // Cart header ke liye outlet ka sach (boss 31-10-2026 round 3).
        Object.assign(ws.cart, {
          restaurantArea: String(menu.restaurant.area || ''),
          restaurantTime: String(menu.restaurant.time || ''),
          restaurantImage: String(menu.restaurant.image || ''),
          restaurantRating: String(menu.restaurant.rating || '')
        });
        const existing = ws.cart.items.find(i => i.menu_item_id === Number(item.id) && !(i.variants?.length || i.addons?.length));
        if (existing) existing.qty = Math.min(20, existing.qty + 1);
        else ws.cart.items.push({ lineKey: crypto.randomUUID(), id: item.id, menu_item_id: Number(item.id), name: item.name, price: item.price, qty: 1, isVeg: item.isVeg === true ? true : item.isVeg === false ? false : null, variants: [], addons: [], offer_ids: item.offer_ids, item_offer_cart_meta: item.item_offer_cart_meta });
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
      if (route === '/pro/api/cart/clear' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        if (body.confirmClear !== true) throw error(400, 'Cart clear karne ke liye confirm karein.');
        ws.cart = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: null });
        return;
      }
      if (route === '/pro/api/coupons' && req.method === 'GET') {
        // Boss (31-10-2026): coupon choose karne ka asli page — Swiggy ke apne
        // coupon list se, jhootha code nahi.
        const account = currentAccount(user, ws);
        const requested = String(url.searchParams.get('id') || '').trim();
        const restaurantId = requested || String(ws.cart?.restaurantId || '');
        if (!/^\d{1,20}$/.test(restaurantId)) throw error(400, 'Pehle cart ya restaurant kholein.');
        const out = await provider.coupons(account, ws.selectedAddress || {}, restaurantId);
        json(res, 200, { ok: true, ...out });
        return;
      }
      if (route === '/pro/api/restaurants/outlets' && req.method === 'GET') {
        // Boss (31-10-2026): ek restaurant ke kai franchise — location ka naam
        // aur dropdown, taaki aas-paas ka outlet chuna ja sake.
        const name = String(url.searchParams.get('q') || '').trim().slice(0, 80);
        if (name.length < 2) throw error(400, 'Restaurant ka naam chahiye.');
        const account = currentAccount(user, ws);
        if (!ws.selectedAddress) throw error(400, 'Pehle delivery address chunein.');
        const list = await provider.search(account, ws.selectedAddress, name);
        const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = norm(name);
        const outlets = (Array.isArray(list) ? list : [])
          .filter(r => norm(r.name) === target || norm(r.name).includes(target) || target.includes(norm(r.name)))
          .slice(0, 20)
          .map(r => ({
            id: String(r.id || ''), name: String(r.name || ''), area: String(r.area || ''),
            distance: String(r.distance || ''), time: String(r.time || ''), rating: String(r.rating || ''), ratings: String(r.ratings || ''),
            isOpen: r.isOpen === true ? true : r.isOpen === false ? false : null
          }))
          .filter(r => r.id);
        json(res, 200, { ok: true, outlets, note: outlets.length ? '' : 'Is naam ka koi outlet nahi mila. Search me poora naam try karein.' });
        return;
      }
      if (route === '/pro/api/cart/sync' && req.method === 'POST') {
        const body = await bodyJson(req);
        requireEditableCart(ws);
        const account = currentAccount(user, ws);
        await ensureAccountCustomerId(provider, user, ws, account);
        if (body.confirmReplaceSwiggyCart !== true) throw error(400, 'Confirm that the existing Swiggy cart may be replaced.');
        if (!ws.cart?.items?.length || !ws.selectedAddress) throw error(400, 'Add items and select an address first.');
        const coupon = String(body.coupon || '').trim().toUpperCase();
        if (coupon && !/^[A-Z0-9_-]{3,28}$/.test(coupon)) throw error(400, 'Invalid coupon code.');
        ws.cart.forSomeoneElse = body.forSomeoneElse === true;
        ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        const quote = await provider.quoteCart(account, ws.selectedAddress, ws.cart, coupon);
        ws.selectedAddress = cleanAddress(quote.address);
        ws.cart.quote = { ...billBreakdown(quote.bill), ofoConfirmed: quote.ofoConfirmed === true, fetchedAt: new Date().toISOString() };
        // Bill ke saath outlet ka sach bhi — header/outlet row ke liye.
        if (ws.menu?.restaurant && String(ws.menu.restaurant.id) === String(ws.cart.restaurantId)) {
          Object.assign(ws.cart, {
            restaurantArea: String(ws.menu.restaurant.area || ''),
            restaurantTime: String(ws.menu.restaurant.time || ''),
            restaurantImage: String(ws.menu.restaurant.image || ''),
            restaurantRating: String(ws.menu.restaurant.rating || '')
          });
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart, selectedAddress: ws.selectedAddress });
        return;
      }
      if (route === '/pro/api/orders' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') || 'active';
        const account = orderHistoryAccount(user, ws, scope);
        const orders = await provider.orders(account);
        const key = scope === 'checkout' ? String(ws.checkout?.accountKey || '') : String(ws.activeAccountKey || '');
        const detailed = orderDetailAllowed(user, ws, key);
        json(res, 200, { ok: true, orders: detailed ? orders : orders.map(compactOrder), detailAllowed: detailed });
        return;
      }
      if (route === '/pro/api/orders/tracking' && req.method === 'GET') {
        const id = normalizeSwiggyOrderId(url.searchParams.get('id'));
        if (!id) throw error(400, 'Invalid Swiggy order ID.');
        const scope = url.searchParams.get('scope') || 'active';
        const scopeKey = scope === 'checkout' ? String(ws.checkout?.accountKey || '') : String(ws.activeAccountKey || '');
        if (!orderDetailAllowed(user, ws, scopeKey)) {
          const e = error(403, 'Operator ke ID ka tracking detail sirf operator dekh sakta hai. Order status upar dikh raha hai.');
          e.code = 'SHARED_ACCOUNT_RESTRICTED';
          throw e;
        }
        const account = orderHistoryAccount(user, ws, scope);
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
        if (!checkoutEnabled()) throw error(503, checkoutBlockReason());
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
            json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout, { restricted: isSharedAccountFor(user, ws, ws.checkout.accountKey) }) });
            return;
          }
          ws.checkout = null;
          if (ws.cart) ws.cart.quote = null;
          writeProWorkspace(user.id, ws);
          throw error(Number(err?.statusCode) || 502, String(err?.message || 'Checkout could not be prepared. No order was placed.'));
        }
        json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout, { restricted: isSharedAccountFor(user, ws, ws.checkout.accountKey) }) });
        return;
      }
      if (route === '/pro/api/checkout/status' && req.method === 'POST') {
        await bodyJson(req);
        const checkout = ws.checkout;
        if (!checkout) throw error(404, 'No Mini App checkout exists.');
        if (checkout.status === 'PAID' || !normalizeSwiggyOrderId(checkout.orderId)) {
          json(res, 200, { ok: true, checkout: publicCheckout(checkout, { restricted: isSharedAccountFor(user, ws, checkout.accountKey) }) });
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
        json(res, 200, { ok: true, checkout: publicCheckout(checkout, { restricted: isSharedAccountFor(user, ws, checkout.accountKey) }) });
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
      const code = ['PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED', 'ACCOUNT_NEEDS_CONFIRM', 'ADDRESS_INCOMPLETE', 'SHARED_ACCOUNT_RESTRICTED'].includes(err?.code) ? err.code : undefined;
      json(res, status, {
        ok: false,
        error: status >= 500 && status !== 501 && status !== 502 && status !== 503 ? 'Unable to complete this request. Please retry.' : String(err?.message || 'Request failed.'),
        ...(code ? { code } : {})
      });
    }
  });
  return true;
}
