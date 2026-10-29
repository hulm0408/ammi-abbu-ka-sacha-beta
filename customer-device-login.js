/**
 * customer-device-login.js — "ID unke phone me login ho, order unke phone se ho".
 *
 * Boss (29-10-2026): "jaise koi slot mere ammi abbu koi order de to unke phone me
 * wo login hojaye wo id aur unke phone se order ho kiuki phone to unka hai aur
 * order to india se hoga, me to saudi me rahunga — isi wajah se night cash aur
 * wo sab apply na ho raha tha".
 *
 * Matlab: jis Swiggy ID par bot ne ₹50 offers lock kiye hain, wahi ID customer
 * ke phone par login honi chahiye, aur order wahi se place ho — tab offers asli
 * me lagte hain. Bot Saudi/server IP se place karta tha, isliye cash lagta nahi tha.
 *
 * Is module ka kaam (aur hadd):
 *   • Customer ko SAaf handover card dena — kaunsi ID/phone, kaunse steps,
 *     aur "cart + ₹50 offer usi ID par already laga hua hai".
 *   • Customer ke "login ho gaya" par ASLI check karna (`/dapi/order/all` live
 *     probe) — sirf tab SESSION_LIVE kehna.
 *   • Sach me proof tab jab us ID par naya order dikhe (customer ke phone se
 *     place hua) — tab VERIFIED_BY_ORDER.
 *   • Bot apni taraf se order place karna BAND karna jab customer ne bola
 *     "main apne phone se karunga" (warna double order / galat IP se order).
 *
 * JHOOTH NAHI: bot customer ke phone ko dekh nahi sakta. Isliye "aapke phone me
 * login hai" kabhi apne aap se nahi kaha jata — status hamesha wahi hota hai jo
 * proof se milta hai (live session ya us ID par aaya naya order).
 *
 * Pure functions + injectable fetch => offline testable.
 */

export const DEVICE_LOGIN_STATUS = {
  NOT_REQUESTED: 'NOT_REQUESTED',
  AWAITING_LOGIN: 'AWAITING_LOGIN',
  SELF_REPORTED: 'SELF_REPORTED',
  SESSION_LIVE: 'SESSION_LIVE',
  VERIFIED_BY_ORDER: 'VERIFIED_BY_ORDER',
  FAILED: 'FAILED'
};

export const PLACEMENT_MODE = {
  BOT: 'BOT',
  CUSTOMER_PHONE: 'CUSTOMER_PHONE'
};

const SWIGGY_HOME = 'https://www.swiggy.com/';
const SWIGGY_ORDERS = 'https://www.swiggy.com/my-account/orders';
const LIVE_PROBE_URL = 'https://www.swiggy.com/dapi/order/all';

const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Account ka phone (7-field JSON / key dono se). */
export function accountPhone(account, key = '') {
  const src = account || {};
  const fromKey = digits(String(key || '').replace(/^acc_/, '')).slice(-10);
  const phone = digits(src.mobile || src.phone || fromKey).slice(-10);
  return phone.length === 10 ? phone : '';
}

/**
 * Order par device-login record banao. Har baar naya record nahi — maujooda
 * record sirf update hota hai (warna "kab request hua" ka sach kho jata hai).
 */
export function attachDeviceLogin(order, account, { key = '', nowMs = Date.now() } = {}) {
  if (!order) return null;
  const phone = accountPhone(account, key || order.selectedAccount || order.orderAccount || '');
  const prev = (order.deviceLogin && typeof order.deviceLogin === 'object') ? order.deviceLogin : null;
  order.deviceLogin = {
    status: prev?.status || DEVICE_LOGIN_STATUS.NOT_REQUESTED,
    accountKey: String(key || prev?.accountKey || order.selectedAccount || ''),
    phone: phone || prev?.phone || '',
    name: String(account?.name || prev?.name || '').slice(0, 60),
    requestedAt: prev?.requestedAt || '',
    handoverSentAt: prev?.handoverSentAt || '',
    customerReportedAt: prev?.customerReportedAt || '',
    sessionCheckedAt: prev?.sessionCheckedAt || '',
    sessionLive: prev?.sessionLive === true,
    placedOrderId: prev?.placedOrderId || '',
    verifiedAt: prev?.verifiedAt || '',
    lastReason: prev?.lastReason || '',
    updatedAt: new Date(nowMs).toISOString()
  };
  if (!order.placementMode) order.placementMode = PLACEMENT_MODE.BOT;
  return order.deviceLogin;
}

/** Handover card bhej diya — customer ka login pending hai. */
export function markHandoverSent(order, { nowMs = Date.now() } = {}) {
  if (!order?.deviceLogin) return null;
  const iso = new Date(nowMs).toISOString();
  order.deviceLogin.handoverSentAt = order.deviceLogin.handoverSentAt || iso;
  order.deviceLogin.requestedAt = order.deviceLogin.requestedAt || iso;
  if (order.deviceLogin.status === DEVICE_LOGIN_STATUS.NOT_REQUESTED) {
    order.deviceLogin.status = DEVICE_LOGIN_STATUS.AWAITING_LOGIN;
  }
  order.deviceLogin.updatedAt = iso;
  return order.deviceLogin;
}

/**
 * Customer ne kaha: "main apne phone se order karunga".
 * Tab bot apni taraf se place karna band karta hai (warna double order).
 */
export function customerChoseOwnPhone(order, { nowMs = Date.now() } = {}) {
  if (!order?.deviceLogin) return null;
  order.placementMode = PLACEMENT_MODE.CUSTOMER_PHONE;
  order.deviceLogin.placementMode = PLACEMENT_MODE.CUSTOMER_PHONE;
  if (order.deviceLogin.status === DEVICE_LOGIN_STATUS.NOT_REQUESTED) {
    order.deviceLogin.status = DEVICE_LOGIN_STATUS.AWAITING_LOGIN;
  }
  order.deviceLogin.updatedAt = new Date(nowMs).toISOString();
  return order.deviceLogin;
}

export function isCustomerPhonePlacement(order) {
  return String(order?.placementMode || '').toUpperCase() === PLACEMENT_MODE.CUSTOMER_PHONE;
}

/**
 * Customer ne "login ho gaya" bola. Yeh SIRF customer ka bayan hai — ise
 * verified nahi maana jata; agla step live probe hai.
 */
export function markCustomerSaidLoggedIn(order, { nowMs = Date.now() } = {}) {
  if (!order?.deviceLogin) return null;
  const iso = new Date(nowMs).toISOString();
  order.deviceLogin.customerReportedAt = iso;
  order.deviceLogin.status = DEVICE_LOGIN_STATUS.SELF_REPORTED;
  order.deviceLogin.updatedAt = iso;
  return order.deviceLogin;
}

/**
 * Account session ka ASLI check (Swiggy se hi). `live` sirf tab jab Swiggy ne
 * order-history call ka saaf jawab diya ho.
 * Returns `{ live, httpStatus, reason, checkedAt }`.
 */
export async function verifyAccountSessionLive(account, { fetchImpl = globalThis.fetch, timeoutMs = 6000, nowMs = Date.now() } = {}) {
  const checkedAt = new Date(nowMs).toISOString();
  const acc = account || {};
  const cookieStr = String(acc.cookies || '').trim();
  const tid = String(acc.tid || acc.jwtTid || '').trim() || (cookieStr.match(/(?:^|;\s*)(?:_session_tid|tid)=([^;]+)/) || [])[1] || '';
  if (!cookieStr && !tid) {
    return { live: false, httpStatus: 0, reason: 'ID me session cookie/tid hi nahi — pehle JSON import ya OTP login', checkedAt };
  }
  const cookieHeader = cookieStr
    ? (/(?:^|;\s*)tid=/.test(cookieStr) ? cookieStr : `${cookieStr}; tid=${tid}`)
    : `tid=${tid}`;
  if (typeof fetchImpl !== 'function') {
    return { live: false, httpStatus: 0, reason: 'network layer missing', checkedAt };
  }
  let res = null;
  try {
    res = await fetchImpl(LIVE_PROBE_URL, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        Accept: 'application/json',
        'User-Agent': DEFAULT_UA,
        Referer: SWIGGY_HOME,
        Origin: 'https://www.swiggy.com'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return { live: false, httpStatus: 0, reason: `Swiggy tak pahuncha nahi (${String(err?.message || err).slice(0, 80)})`, checkedAt };
  }
  const httpStatus = Number(res?.status || 0);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (httpStatus === 401 || httpStatus === 403) {
    return { live: false, httpStatus, reason: `session accept nahi hui (HTTP ${httpStatus}) — logout/login dobara`, checkedAt };
  }
  if (!res?.ok) {
    return { live: false, httpStatus, reason: `Swiggy ne jawab nahi diya (HTTP ${httpStatus || 'network'})`, checkedAt };
  }
  const statusCode = Number(json?.statusCode ?? 0);
  const loginRequired = /login|unauthentic|unauthori[sz]ed|session.*expired/i.test(String(json?.statusMessage || json?.message || ''));
  if (statusCode !== 0 || loginRequired) {
    return {
      live: false,
      httpStatus,
      reason: String(json?.statusMessage || json?.message || `Swiggy ne status code ${statusCode} diya`).slice(0, 120),
      checkedAt
    };
  }
  if (!json || typeof json !== 'object') {
    return { live: false, httpStatus, reason: 'Swiggy ka jawab samajh nahi aaya (JSON nahi)', checkedAt };
  }
  return { live: true, httpStatus, reason: 'Swiggy ne session accept kiya (live order-history check)', checkedAt, ordersSeen: Array.isArray(json?.data?.orders) ? json.data.orders.length : null };
}

/** Live probe ka nateeja order par likho — jhooth nahi, sirf probe ka sach. */
export function applySessionProbe(order, probe, { nowMs = Date.now() } = {}) {
  if (!order?.deviceLogin) return null;
  const iso = new Date(nowMs).toISOString();
  order.deviceLogin.sessionCheckedAt = probe?.checkedAt || iso;
  order.deviceLogin.sessionLive = probe?.live === true;
  order.deviceLogin.lastReason = String(probe?.reason || '').slice(0, 160);
  if (probe?.live === true) {
    // Session live hai, par "phone me login" ka pakka proof tab jab order aaye.
    if (order.deviceLogin.status !== DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER) {
      order.deviceLogin.status = DEVICE_LOGIN_STATUS.SESSION_LIVE;
    }
  } else if (order.deviceLogin.status !== DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER) {
    order.deviceLogin.status = DEVICE_LOGIN_STATUS.FAILED;
  }
  order.deviceLogin.updatedAt = iso;
  return order.deviceLogin;
}

/**
 * Us ID par naya order dikha. Agar customer ne apne phone se karne ko kaha tha
 * (ya handover chalu tha), tab yahi PAKKA proof hai ki order unke phone se hua.
 * Returns true jab status pehli baar verify hua.
 */
export function noteCustomerPlacedOrder(order, swiggyOrderId, { nowMs = Date.now() } = {}) {
  if (!order || !swiggyOrderId) return false;
  const id = String(swiggyOrderId).trim();
  if (!id) return false;
  const dl = order.deviceLogin;
  const wanted = isCustomerPhonePlacement(order) || Boolean(dl && dl.status !== DEVICE_LOGIN_STATUS.NOT_REQUESTED);
  if (!wanted || !dl) return false;
  if (dl.status === DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER && dl.placedOrderId === id) return false;
  if (dl.status === DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER && dl.placedOrderId && dl.placedOrderId !== id) return false;
  const iso = new Date(nowMs).toISOString();
  dl.status = DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER;
  dl.placedOrderId = id;
  dl.verifiedAt = iso;
  dl.updatedAt = iso;
  dl.lastReason = `us ID par order #${id} aaya — customer ke phone se place hua`;
  return true;
}

/** Honest status → icon + label (yeh kabhi jhooth nahi bolta). */
export function deviceLoginTruth(order) {
  const dl = order?.deviceLogin || null;
  const mode = String(order?.placementMode || PLACEMENT_MODE.BOT).toUpperCase();
  if (!dl || dl.status === DEVICE_LOGIN_STATUS.NOT_REQUESTED) {
    return {
      status: DEVICE_LOGIN_STATUS.NOT_REQUESTED,
      icon: '⚪',
      label: 'Phone handover nahi hua',
      verified: false,
      mode,
      placedOrderId: ''
    };
  }
  switch (dl.status) {
    case DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER:
      return {
        status: dl.status,
        icon: '✅',
        label: `Customer ke phone se order #${dl.placedOrderId} place hua (us ID par dikha)`,
        verified: true,
        mode,
        placedOrderId: dl.placedOrderId || ''
      };
    case DEVICE_LOGIN_STATUS.SESSION_LIVE:
      return {
        status: dl.status,
        icon: '🟢',
        label: `Session live (Swiggy ne accept kiya${dl.sessionCheckedAt ? ` · ${String(dl.sessionCheckedAt).slice(11, 16)} UTC` : ''}) — order aane par pakka hoga`,
        verified: false,
        mode,
        placedOrderId: ''
      };
    case DEVICE_LOGIN_STATUS.SELF_REPORTED:
      return {
        status: dl.status,
        icon: '🟡',
        label: 'Customer ne bola login ho gaya — bot verify kar raha hai',
        verified: false,
        mode,
        placedOrderId: ''
      };
    case DEVICE_LOGIN_STATUS.AWAITING_LOGIN:
      return {
        status: dl.status,
        icon: '⏳',
        label: mode === PLACEMENT_MODE.CUSTOMER_PHONE
          ? 'Customer apne phone se login/order karega (bot place nahi karega)'
          : 'Login hone ka wait',
        verified: false,
        mode,
        placedOrderId: ''
      };
    default:
      return {
        status: DEVICE_LOGIN_STATUS.FAILED,
        icon: '❌',
        label: `Login verify nahi hua${dl.lastReason ? ` — ${dl.lastReason}` : ''}`,
        verified: false,
        mode,
        placedOrderId: ''
      };
  }
}

/** Order id se callback data (Telegram safe). */
export function deviceLoginCallbacks(orderId) {
  const id = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return {
    choosePhone: `devlogin_phone_${id}`,
    check: `devlogin_check_${id}`,
    help: `devlogin_help_${id}`
  };
}

/**
 * Handover card: customer ko wahi ID/phone + steps, aur buttons.
 * `buttons` Telegram inline keyboard rows (array of arrays) — caller Markup me daale.
 */
export function buildDeviceLoginHandover({ order, account, key = '', nowMs = Date.now() } = {}) {
  const phone = accountPhone(account, key || order?.selectedAccount || '');
  const name = String(account?.name || '').slice(0, 40);
  const cb = deviceLoginCallbacks(order?.id);
  const phoneText = phone ? `<code>${esc(phone)}</code>` : '<i>(ID me phone number nahi hai)</i>';
  const text = [
    '📱 <b>ORDER AAPKE PHONE SE — SWIGGY ID HANDOVER</b>',
    '',
    `Swiggy ID: ${phoneText}${name ? ` · ${esc(name)}` : ''}`,
    '<i>(yeh wahi ID hai jis par ₹50 cash + saare offer already lock hain)</i>',
    '',
    '<b>Aapko bas 3 step karne hain:</b>',
    '1️⃣ Phone me Swiggy app kholo → agar koi aur ID logged in hai to <b>Logout</b>',
    `2️⃣ Usi number ${phoneText} se <b>OTP</b> daal kar login karo`,
    '3️⃣ App me <b>Cart</b> khud dikhega (bot ne bana diya hai) → <b>order place</b> karo',
    '',
    '⬇️ Neeche <b>“Login ho gaya — check karo”</b> dabaiye, bot Swiggy se live check karke sach batayega.',
    '<i>Bot aapke phone ko dekh nahi sakta — isliye jhootha “login ho gaya” kabhi nahi bolega. Pakka proof tab jab isi ID par aapka order dikhega.</i>'
  ].join('\n');
  const buttons = [
    [{ text: '📲 Swiggy app kholo', url: SWIGGY_HOME }],
    [{ text: '✅ Login ho gaya — check karo', callback_data: cb.check }],
    [{ text: '📱 Order main apne phone se karunga', callback_data: cb.choosePhone }],
    [
      { text: '📦 Meri orders', url: SWIGGY_ORDERS },
      { text: '❓ Madad', callback_data: cb.help }
    ]
  ];
  return { text, buttons, phone, name, callbacks: cb, at: new Date(nowMs).toISOString() };
}

/** Probe ke baad customer ko sach (aur boss ko mirror). */
export function buildDeviceLoginStatusText({ order, probe = null, escape = esc } = {}) {
  const truth = deviceLoginTruth(order);
  const phone = order?.deviceLogin?.phone || '';
  const lines = [
    `${truth.icon} <b>PHONE LOGIN — ${escape(String(truth.status).replace(/_/g, ' '))}</b>`,
    phone ? `Swiggy ID: <code>${escape(phone)}</code>` : '',
    '',
    escape(truth.label)
  ].filter(Boolean);
  if (probe?.live === true) {
    lines.push('', '<i>Ab app me cart + ₹50 offer dono dikhega. Aap order place karo — bot tracking khud laga dega.</i>');
  } else if (probe && probe.live === false) {
    lines.push('', `<i>Wajah: ${escape(String(probe.reason || 'verify nahi hua'))}</i>`);
    lines.push('<i>Swiggy me logout karke usi number se dobara login karo, phir <b>“Login ho gaya — check karo”</b> dabaiye.</i>');
  }
  if (isCustomerPhonePlacement(order)) {
    lines.push('', '📱 <b>Order aapke phone se hoga</b> — bot apni taraf se place nahi karega (double order nahi banega).');
  }
  return lines.join('\n');
}

/** Bot ko place karna roka gaya — customer ko/boss ko asli wajah. */
export function placementHoldMessage(order) {
  const truth = deviceLoginTruth(order);
  return `📱 <b>Order aapke phone se place hoga — bot ne apni taraf se place nahi kiya.</b>\n` +
    `Swiggy ID: <code>${esc(order?.deviceLogin?.phone || order?.orderAccount || '')}</code>\n` +
    `${truth.icon} ${esc(truth.label)}\n\n` +
    `<i>App me cart kholo → place order. Uske baad bot tracking + OTP khud bhej dega.</i>`;
}

/** Help text (aam customer ke liye, seedha). */
export function buildDeviceLoginHelpText({ order } = {}) {
  const phone = order?.deviceLogin?.phone || order?.orderAccount || '';
  return [
    '❓ <b>PHONE LOGIN — MADAD</b>',
    '',
    `1. Swiggy app → <b>Account</b> → Logout (purani ID hat jaye)`,
    `2. Login me number daalo: <code>${esc(phone)}</code>`,
    '3. OTP apne phone par aayega — daal do',
    '4. App → <b>Cart</b> → items aur ₹50 cash already laga hua dikhega',
    '5. Place order → bot tracking link + delivery OTP bhej dega',
    '',
    '<i>Agar OTP nahi aaya ya number galat hai to bot me “📱 ID switch” dabaiye — dusri ID mil jayegi.</i>'
  ].join('\n');
}
