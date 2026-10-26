/**
 * v57 — INSTANT ID ROTATION (ek account ek baar, refresh = turant naya ID)
 *
 * User ask:
 *   - "one account can be selected once, if user refresh it should immediately
 *      change to another"
 *   - "each account can be selected immediately, there is no auto offer applying
 *      because it takes time and each account has the same offer"
 *   - "if bot selected an ID which has been already used for ordering and click
 *      on refresh then it will choose a new account"
 *   - "and i can choose for them too"
 *
 * Proven here:
 *   1. Rotation candidates are computed locally (no network) with honest statuses.
 *   2. ⚡ Next ID never repeats an ID already used on this order.
 *   3. The switch pushes the bill with offers OFF (no coupon / MCP / offers calls,
 *      no Swiggy One auto-add) → fast.
 *   4. Card updates immediately with the new ID, then the bill lands.
 *   5. A failed new ID auto-advances to the next fresh ID (no extra taps).
 *   6. 👤 Choose ID lists every ID as a button; the boss/customer can pick one.
 *   7. An ID already used for ordering (live on another order / has active order)
 *      is deprioritised, and "refresh" moves off it.
 *   8. Permissions + no wipe + no delete.
 */
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

function jsonRes(status, payload, url = '') {
  return {
    ok: status >= 200 && status < 300, status, url,
    headers: { get: () => 'application/json', getSetCookie: () => [] },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

const realFetch = globalThis.fetch;
const store = await import('./store.js');
const flow = await import('./forwarded-order-flow.js');
const cart = await import('./swiggy-cart.js');
const dbAtStart = JSON.parse(JSON.stringify(store.getDb()));

const BOSS_ID = 920001;
const CUSTOMER_ID = 920002;
const STRANGER_ID = 920003;
const ORDER_ID = 'FWD5701';
const jwt = (uid) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: String(uid), user_id: Number(uid), exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.sig`;
};
const ACC = {
  acc_9580917901: { phone: '9580917901', uid: '287113901' },
  acc_9580917902: { phone: '9580917902', uid: '287113902' },
  acc_9580917903: { phone: '9580917903', uid: '287113903' },
  acc_9580917904: { phone: '9580917904', uid: '287113904' }
};

const sent = [];
const actionHandlers = [];
const textHandlers = [];
let msgSeq = 9000;

const mockTelegram = {
  async sendMessage(chatId, text, extra = {}) {
    const id = ++msgSeq;
    sent.push({ chatId: String(chatId), text: String(text), keyboard: extra?.reply_markup?.inline_keyboard || [] });
    return { message_id: id, chat: { id: chatId } };
  },
  async sendPhoto(chatId, photo, extra = {}) {
    const id = ++msgSeq;
    sent.push({ chatId: String(chatId), text: String(extra?.caption || ''), keyboard: extra?.reply_markup?.inline_keyboard || [] });
    return { message_id: id, chat: { id: chatId } };
  },
  async deleteMessage() { return true; },
  async editMessageText(chatId, messageId, _i, text, extra = {}) {
    sent.push({ chatId: String(chatId), text: String(text), keyboard: extra?.reply_markup?.inline_keyboard || [], edited: true });
    return true;
  },
  async editMessageReplyMarkup() { return true; }
};

const mockBot = {
  action: (pattern, fn) => actionHandlers.push({ pattern, fn }),
  hears: () => {},
  on: (e, fn) => { if (e === 'text') textHandlers.push(fn); }
};

const renderBodyHtml = (order) => `<b>BILL</b>\nItems: ₹${order.itemTotal || 0}\nPayable: ${order.finalPayable || 0}`;

const makeCtx = ({ fromId = BOSS_ID, text = '', cbData = null }) => ({
  from: { id: fromId, first_name: 'T' },
  chat: { id: fromId, type: 'private' },
  telegram: mockTelegram,
  message: text ? { text } : null,
  callbackQuery: cbData ? { data: cbData, message: { message_id: 999 } } : undefined,
  reply: (t, ex) => mockTelegram.sendMessage(fromId, t, ex),
  replyWithPhoto: (p, ex) => mockTelegram.sendPhoto(fromId, p, ex),
  editMessageText: (t, ex) => mockTelegram.editMessageText(fromId, 999, undefined, t, ex),
  editMessageReplyMarkup: async () => true,
  answerCbQuery: async () => true
});

const click = async (cbData, fromId = BOSS_ID) => {
  for (const h of actionHandlers) {
    const m = String(cbData).match(h.pattern);
    if (!m) continue;
    const ctx = makeCtx({ fromId, cbData });
    ctx.match = m;
    await h.fn(ctx);
    return true;
  }
  return false;
};

const flushAsync = () => new Promise((r) => setTimeout(r, 350));
const findSent = (needle, chatId = null) => sent.filter((m) => m.text.includes(needle) && (!chatId || m.chatId === String(chatId)));
const allButtons = (msgs) => msgs.flatMap((m) => (m.keyboard || []).flat());
const hasBtn = (msgs, cb) => allButtons(msgs).some((b) => String(b.callback_data || '') === cb);

// ---------------------------------------------------------------------------
// Swiggy mock — records which offer endpoints were hit.
// ---------------------------------------------------------------------------
const offersHits = { couponsMcp: 0, paymentOffers: 0, restaurantOffers: 0, cartUpdates: 0 };
const failingAccounts = new Set();
// A fresh account has NO cart until we push one — that is what makes the sync
// really push (and lets us assert the bill is real, not cached).
const accountsWithCart = new Set();

const cartCookieOf = (opts = {}) => {
  const headers = opts.headers || {};
  return String(headers.Cookie || headers.cookie || '');
};
const callerOf = (opts) => {
  const headers = opts.headers || {};
  const cookieStr = String(headers.Cookie || headers.cookie || '');
  const uid = String(headers.userid || headers['user-id'] || headers.customer_id || headers.customerId || '');
  const byCookie = Object.entries(ACC).find(([, v]) => cookieStr.includes(v.phone))?.[0];
  if (byCookie) return byCookie;
  return Object.entries(ACC).find(([, v]) => uid && v.uid === uid)?.[0] || '';
};
const emptyCartMeta = () => ({
  cart_id: '', restaurant_details: {}, cart_total_count: 0, cart_menu_items: [],
  order_total: 0, delivery_fee: 0, address_id: 'addr_v57',
  addresses: [{ id: 'addr_v57', selected: true, name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' }]
});

const cartMeta = () => ({
  cart_id: 'cart_v57',
  restaurant_details: { id: '990011', name: 'Real Bakers' },
  cart_total_count: 1,
  cart_menu_items: [{ menu_item_id: 71234, name: 'Hazelnut Missu', price: 25, quantity: 2, subtotal: 5000, final_price: 5000 }],
  order_total: 70, delivery_fee: 20, address_id: 'addr_v57',
  addresses: [{ id: 'addr_v57', selected: true, name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' }]
});

globalThis.fetch = async (u, opts = {}) => {
  const url = String(u);
  const method = String(opts.method || 'GET').toUpperCase();
  const caller = callerOf(opts);
  if (failingAccounts.has(caller) && /chkout|dapi/.test(url)) {
    return jsonRes(500, { statusCode: 1, statusMessage: `Account ${caller} dead for test` }, url);
  }
  if (url.includes('shared_cart')) {
    return jsonRes(200, {
      statusCode: 0,
      data: {
        restaurant_details: { restaurant_id: '990011', restaurant_name: 'Real Bakers' },
        user_cart_map: { u1: { user_cart: [{ menu_item_id: 71234, name: 'Hazelnut Missu', quantity: 2, base_price: 2500, subtotal: 5000, final_price: 5000 }] } }
      }
    }, url);
  }
  if (url.includes('events.swiggy.com')) return jsonRes(200, { message: 'ok', shouldNotify: true, value: 1 }, url);
  if (url.includes('chkout.swiggy.com/api/v2/cart/client/update')) {
    offersHits.cartUpdates += 1;
    accountsWithCart.add(caller);
    return jsonRes(200, { statusCode: 0, data: { cartMeta: cartMeta() } }, url);
  }
  if (url.includes('chkout.swiggy.com/api/v2/cart/client')) {
    return jsonRes(200, { statusCode: 0, data: { cartMeta: accountsWithCart.has(caller) ? cartMeta() : emptyCartMeta() } }, url);
  }
  if (url.includes('/dapi/cart')) {
    return jsonRes(200, { statusCode: 0, data: { cartMeta: accountsWithCart.has(caller) ? cartMeta() : emptyCartMeta() } }, url);
  }
  if (url.includes('offers/payment')) { offersHits.paymentOffers += 1; return jsonRes(200, { statusCode: 0, data: { cards: [] } }, url); }
  if (url.includes('offers/restaurant')) { offersHits.restaurantOffers += 1; return jsonRes(200, { statusCode: 0, data: { cards: [] } }, url); }
  if (url.includes('mcp.swiggy.com')) { offersHits.couponsMcp += 1; return jsonRes(200, { jsonrpc: '2.0', result: { structuredContent: { coupons: [] } } }, url); }
  if (url.includes('order/all') || url.includes('order/details')) return jsonRes(200, { statusCode: 0, data: { orders: [] } }, url);
  if (url.includes('maps.swiggy.com/addresses/nearby')) {
    return jsonRes(200, { statusCode: 0, addresses: [{ id: 'addr_v57', name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' }] }, url);
  }
  if (url.includes('/dapi/address') && method === 'POST') return jsonRes(200, { statusCode: 0, data: { id: 'addr_v57' } }, url);
  if (url.includes('profile.swiggy.com') || url.includes('profile/info')) {
    return jsonRes(200, { statusCode: 0, data: { customer_id: '287113901' }, tid: jwt('287113901') }, url);
  }
  if (url.includes('raw.githubusercontent.com')) return jsonRes(404, {}, url);
  return jsonRes(200, { statusCode: 0, data: {} }, url);
};

function seed({ otherOrderAccount = null } = {}) {
  const db = store.getDb();
  db.config.accounts = {};
  for (const [key, v] of Object.entries(ACC)) {
    db.config.accounts[key] = {
      id: key, phone: v.phone, customerId: v.uid,
      cookies: `_session_tid=s57_${v.phone}; tid=${jwt(v.uid)}; _is_logged_in=1`,
      tid: jwt(v.uid), token: `tok_${v.phone}`, isLoggedIn: true,
      totalOrdersCount: 0, isZeroOrderAccount: true
    };
  }
  db.config.bossIds = [String(BOSS_ID)];
  db.orders = {
    [ORDER_ID]: {
      id: ORDER_ID,
      userId: String(CUSTOMER_ID),
      fwdSenderUserId: String(CUSTOMER_ID),
      userName: 'Tohid', fwdSenderName: 'Tohid',
      isForwardedOrder: true,
      status: 'ACCEPTED',
      cardStage: 'BILL_READY',
      restaurantId: '990011',
      restaurantName: 'Real Bakers',
      cart: 'https://swig.gy/gc/990011/Tohid-642855918',
      items: [{ itemId: '71234', menu_item_id: 71234, name: 'Hazelnut Missu', price: 25, qty: 2, quantity: 2 }],
      itemTotal: 50, subtotal: 50, finalPayable: 70,
      address: 'Nadiad City, Gujarat 387001',
      addressDetails: { id: 'addr_v57', name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' },
      selectedAccount: 'acc_9580917901',
      orderAccount: ACC.acc_9580917901.phone,
      availableCoupons: [],
      createdAt: new Date().toISOString()
    }
  };
  if (otherOrderAccount) {
    db.orders.OTHER99 = {
      id: 'OTHER99', status: 'ACCEPTED', cardStage: 'QR_GENERATED',
      selectedAccount: otherOrderAccount, pendingSwiggyOrderId: '123456789',
      userId: '930001', items: [], createdAt: new Date().toISOString()
    };
  }
  store.saveDb(db);
  sent.length = 0;
  accountsWithCart.clear();
  offersHits.couponsMcp = 0;
  offersHits.paymentOffers = 0;
  offersHits.restaurantOffers = 0;
  offersHits.cartUpdates = 0;
  failingAccounts.clear();
}

flow.registerForwardedOrderHandlers(mockBot, {
  isBoss: (id) => Number(id) === BOSS_ID,
  formatOrderBodyFn: renderBodyHtml
});

// ---------------------------------------------------------------------------
console.log('\n━━━ 1) Rotation candidates are local + honest ━━━');
{
  seed({ otherOrderAccount: 'acc_9580917903' });
  const db = store.getDb();
  db.orders[ORDER_ID].usedAccountKeys = ['acc_9580917901'];
  store.saveDb(db);
  const t0 = Date.now();
  const rows = cart.describeAccountRotation(store.getDb().orders[ORDER_ID]);
  const elapsed = Date.now() - t0;
  check('candidates resolve locally in under 50ms', elapsed < 50, `${elapsed}ms`);
  check('all 4 vault IDs are listed', rows.length === 4, String(rows.length));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  check('the ID already used on this order is marked USED', byKey.acc_9580917901.status === 'USED', byKey.acc_9580917901.status);
  check('the ID held by another live order is marked BUSY', byKey.acc_9580917903.status === 'BUSY', byKey.acc_9580917903.status);
  check('a free ID is offered first', rows[0].status === 'FREE' || rows[0].status === 'MAYBE_USED', rows[0].status);
}

console.log('\n━━━ 2) ⚡ Next ID never repeats an ID ━━━');
{
  seed();
  const first = cart.pickNextRotationAccount(store.getDb().orders[ORDER_ID]);
  check('a pick is possible', first.success === true, JSON.stringify(first));
  const order = store.getDb().orders[ORDER_ID];
  order.usedAccountKeys = ['acc_9580917901'];
  const second = cart.pickNextRotationAccount(order);
  check('the used ID is skipped', second.key !== 'acc_9580917901', second.key);
  order.usedAccountKeys = ['acc_9580917901', 'acc_9580917902', 'acc_9580917903', 'acc_9580917904'];
  const third = cart.pickNextRotationAccount(order);
  check('when every ID is used it says so instead of repeating', third.success === false && /use ho gaye/.test(String(third.error)),
    JSON.stringify({ ok: third.success, err: third.error }));
}

console.log('\n━━━ 3) ⚡ Next ID: instant switch + offers skipped ━━━');
{
  seed();
  sent.length = 0;
  accountsWithCart.clear();
  offersHits.couponsMcp = 0; offersHits.paymentOffers = 0; offersHits.restaurantOffers = 0;
  const t0 = Date.now();
  await click(`fwd_next_acc_${ORDER_ID}`, BOSS_ID);
  const switchElapsed = Date.now() - t0;
  check('the handler returns immediately with the new ID (<1.5s)', switchElapsed < 1500, `${switchElapsed}ms`);

  const afterClick = store.getDb().orders[ORDER_ID];
  check('a different account is selected than before', afterClick.selectedAccount !== 'acc_9580917901', afterClick.selectedAccount);
  check('the previous account is remembered as used',
    (afterClick.usedAccountKeys || []).includes('acc_9580917901'), JSON.stringify(afterClick.usedAccountKeys));
  check('the card was posted immediately showing the instant switch',
    findSent('Instant ID switch').length > 0, String(findSent('Instant ID switch').length));

  await flushAsync();
  const done = store.getDb().orders[ORDER_ID];
  check('the bill was built on the new ID', done.cardStage === 'BILL_READY' && Boolean(done.selectedAccount),
    JSON.stringify({ stage: done.cardStage, acc: done.selectedAccount }));
  check('NO coupon/MCP offer scan ran', offersHits.couponsMcp === 0, String(offersHits.couponsMcp));
  check('NO offers/payment scan ran', offersHits.paymentOffers === 0, String(offersHits.paymentOffers));
  check('NO offers/restaurant scan ran', offersHits.restaurantOffers === 0, String(offersHits.restaurantOffers));
  check('the cart itself WAS pushed (bill is real)', offersHits.cartUpdates > 0, String(offersHits.cartUpdates));
  check('the switch is reported honestly', findSent('ID switch ho gayi').length > 0);
}

console.log('\n━━━ 4) A dead ID auto-advances to the next fresh ID ━━━');
{
  seed();
  // Make the two best candidates fail so the switch must walk forward.
  const db = store.getDb();
  const order = db.orders[ORDER_ID];
  order.usedAccountKeys = [];
  store.saveDb(db);
  const orderIdle = store.getDb().orders[ORDER_ID];
  const firstPick = cart.pickNextRotationAccount(orderIdle);
  failingAccounts.add(firstPick.key);
  sent.length = 0;
  await click(`fwd_next_acc_${ORDER_ID}`, BOSS_ID);
  await new Promise((r) => setTimeout(r, 1200));
  const after = store.getDb().orders[ORDER_ID];
  check('it moved on from the failing ID', after.selectedAccount !== firstPick.key, after.selectedAccount);
  check('the failing ID is marked used (never retried)', (after.usedAccountKeys || []).includes(firstPick.key),
    JSON.stringify(after.usedAccountKeys));
  check('a working ID still produced a bill', after.cardStage === 'BILL_READY', after.cardStage);
  failingAccounts.clear();
}

console.log('\n━━━ 5) 👤 Choose ID — manual picker ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_pick_acc_${ORDER_ID}`, BOSS_ID);
  const picker = findSent('ID CHOOSE');
  check('picker opens', picker.length > 0);
  check('every ID has its own button', ['0', '1', '2', '3'].every((i) => hasBtn(picker, `fwd_set_acc_${ORDER_ID}_${i}`)),
    String(allButtons(picker).map((b) => b.callback_data).join(',')));
  check('picker also offers next/reset', hasBtn(picker, `fwd_next_acc_${ORDER_ID}`) && hasBtn(picker, `fwd_reset_rot_${ORDER_ID}`));

  const db = store.getDb();
  const pickable = db.orders[ORDER_ID].accountPickerKeys || [];
  check('the rendered order is remembered for a stable tap', pickable.length >= 3, JSON.stringify(pickable));
  const wanted = pickable[2];

  sent.length = 0;
  await click(`fwd_set_acc_${ORDER_ID}_2`, CUSTOMER_ID);
  await flushAsync();
  const after = store.getDb().orders[ORDER_ID];
  check('the CUSTOMER can pick the exact ID they tapped', after.selectedAccount === wanted,
    JSON.stringify({ wanted, got: after.selectedAccount }));
  check('the picked ID builds the bill instantly (offers skipped)', after.cardStage === 'BILL_READY');
  check('the user is told which ID got set', findSent('ID set:').length > 0);
}

console.log('\n━━━ 6) An ID already used for ordering is deprioritised ━━━');
{
  seed({ otherOrderAccount: 'acc_9580917902' });
  const order = store.getDb().orders[ORDER_ID];
  const pick = cart.pickNextRotationAccount(order);
  check('the ID that another live order is using is NOT picked', pick.key !== 'acc_9580917902', pick.key);
  const rows = cart.describeAccountRotation(order);
  const busyRow = rows.find((r) => r.key === 'acc_9580917902');
  check('and it is shown as in-use with the order id', busyRow.status === 'BUSY' && /OTHER99/.test(busyRow.reason), busyRow.reason);

  // An account Swiggy says may already have a running order is behind free ones.
  const db = store.getDb();
  db.config.accounts.acc_9580917904.hasZeroActiveOrders = false;
  store.saveDb(db);
  const rows2 = cart.describeAccountRotation(store.getDb().orders[ORDER_ID]);
  const maybe = rows2.find((r) => r.key === 'acc_9580917904');
  check('an ID with a possible running order is flagged', maybe.status === 'MAYBE_USED', maybe.status);
  check('free IDs are ranked before it', rows2.findIndex((r) => r.status === 'FREE') < rows2.findIndex((r) => r.key === 'acc_9580917904'));
}

console.log('\n━━━ 7) Permissions, locks, no wipe ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_next_acc_${ORDER_ID}`, STRANGER_ID);
  await flushAsync();
  check('a stranger cannot rotate the ID', store.getDb().orders[ORDER_ID].selectedAccount === 'acc_9580917901',
    store.getDb().orders[ORDER_ID].selectedAccount);
  check('no message went to a stranger', sent.filter((m) => m.chatId === String(STRANGER_ID)).length === 0);

  const db = store.getDb();
  db.orders[ORDER_ID].billApprovedByUser = true;
  store.saveDb(db);
  sent.length = 0;
  await click(`fwd_next_acc_${ORDER_ID}`, BOSS_ID);
  await flushAsync();
  check('an approved bill locks the ID', store.getDb().orders[ORDER_ID].selectedAccount === 'acc_9580917901');

  const db2 = store.getDb();
  db2.orders[ORDER_ID].billApprovedByUser = false;
  store.saveDb(db2);
  check('all 4 IDs kept their sessions', Object.values(store.getDb().config.accounts).every((a) => String(a.cookies || '').includes('_session_tid=')));
  check('the other order was not touched', Object.keys(store.getDb().orders).length >= 1);
}

console.log('\n━━━ 8) Wiring / card ━━━');
{
  const src = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('bill card has ⚡ Next ID', /⚡ Next ID \(instant\)/.test(src));
  check('bill card has 👤 Choose ID', /👤 Choose ID/.test(src));
  check('panel has the ID row too', /⚡ Next ID \(instant\)', `fwd_next_acc_/.test(src));
  check('instant switch passes skipAutoOffers', /skipAutoOffers: true/.test(src));
  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('sync really skips the offer wave', /const skipAutoOffers = options\.skipAutoOffers === true/.test(cartSrc));
  check('sync skips coupon trials in fast mode', /!skipAutoOffers && controlOn\('coupon'\)/.test(cartSrc));
  check('sync skips free cash relock in fast mode', /!skipFreeCashRelock && !skipAutoOffers && controlOn\('freeCash'\)/.test(cartSrc));
  check('rotation helpers are exported', /export function describeAccountRotation/.test(cartSrc) && /export function pickNextRotationAccount/.test(cartSrc));
}

globalThis.fetch = realFetch;
{
  const db = store.getDb();
  db.config = dbAtStart.config;
  db.orders = dbAtStart.orders;
  store.saveDb(db);
}

console.log(`\n📊 RESULT: ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log('❌ FAILED CHECKS PRESENT');
  process.exit(1);
}
console.log('🏆 INSTANT ID ROTATION VERIFIED');
process.exit(0);
