/**
 * v56 — REAL USER CONTROLS (ON/OFF switches + quantity +/− buttons)
 *
 * The complaint: "EK BHI CONTROL USER KO NAHI DIA GAYA JAHAN BUTTON KI SHAKAL ME
 * WO ON OFF AND QUANTITY ADJUST KAR SAKE".
 *
 * Proven here:
 *   1. Panel me 4 ON/OFF switches hain (Coupon / Free cash / Swiggy One / Item offers),
 *      label state ke saath, aur tap karne par state flip + persist hoti hai.
 *   2. Coupon OFF → live coupon Swiggy se sach me remove hota hai.
 *   3. Items screen me har item ke ➖ / ➕ / 🗑 buttons hain.
 *   4. ➕ se Swiggy cart me real qty push hoti hai (body capture), bill re-price,
 *      dono parties ko naya card.
 *   5. 🗑 se item hat jaata hai; last item hatne par cart khaali + stage COLLECTING.
 *   6. Switches sach me sync me lagte hain: itemOffers OFF → cart payload me
 *      offer_ids khaali, swiggyOne OFF → subscriptionItems khaali,
 *      coupon OFF → auto coupon scan nahi, freeCash OFF → free-cash relock nahi.
 *   7. Sirf boss/customer controls chala sakte hain — stranger ko kuch nahi.
 *   8. Koi ID wipe / order delete nahi.
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
    ok: status >= 200 && status < 300,
    status,
    url,
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

const BOSS_ID = 910001;
const CUSTOMER_ID = 910002;
const STRANGER_ID = 910003;
const ORDER_ID = 'FWD5601';
const JWT = (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: '287113492', user_id: 287113492, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.jwt`;
})();

const sent = [];
const actionHandlers = [];
const textHandlers = [];
let msgSeq = 7000;

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
  async editMessageText(chatId, messageId, _inline, text, extra = {}) {
    sent.push({ chatId: String(chatId), text: String(text), keyboard: extra?.reply_markup?.inline_keyboard || [], edited: true });
    return true;
  },
  async editMessageReplyMarkup() { return true; }
};

const mockBot = {
  action: (pattern, fn) => actionHandlers.push({ pattern, fn }),
  hears: () => {},
  on: (event, fn) => { if (event === 'text') textHandlers.push(fn); }
};

const renderBodyHtml = (order) => `<b>BILL</b>\nItems: ₹${order.itemTotal || 0}\nPayable: ₹${order.finalPayable || 0}`;

const makeCtx = ({ fromId = BOSS_ID, text = '', cbData = null }) => ({
  from: { id: fromId, first_name: 'T' },
  chat: { id: fromId, type: 'private' },
  telegram: mockTelegram,
  message: text ? { text } : null,
  callbackQuery: cbData ? { data: cbData, message: { message_id: 888 } } : undefined,
  reply: (t, ex) => mockTelegram.sendMessage(fromId, t, ex),
  replyWithPhoto: (p, ex) => mockTelegram.sendPhoto(fromId, p, ex),
  editMessageText: (t, ex) => mockTelegram.editMessageText(fromId, 888, undefined, t, ex),
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

const findSent = (needle, chatId = null) =>
  sent.filter((m) => m.text.includes(needle) && (!chatId || m.chatId === String(chatId)));
const allButtonsOf = (msgs) => msgs.flatMap((m) => (m.keyboard || []).flat());
const buttonWith = (msgs, cb) => allButtonsOf(msgs).find((b) => String(b.callback_data || '') === cb);

// ---------------------------------------------------------------------------
// Stateful Swiggy mock: the cart body we PUSH is what the cart then returns.
// ---------------------------------------------------------------------------
const pushedCartBodies = [];
let swiggyCart = [
  { menu_item_id: 71234, name: 'Hazelnut Missu', quantity: 2, price: 25, offer_ids: ['OF1'] },
  { menu_item_id: 71235, name: 'Choco Lava', quantity: 1, price: 60, offer_ids: ['OF2'] }
];
let couponState = '';
let flushCount = 0;

const cartMetaFromState = () => {
  const items = swiggyCart.map((it) => ({
    menu_item_id: it.menu_item_id,
    name: it.name,
    price: it.price,
    quantity: it.quantity,
    subtotal: it.price * it.quantity * 100,
    final_price: it.price * it.quantity * 100,
    offer_ids: it.offer_ids || []
  }));
  const itemTotal = swiggyCart.reduce((s, it) => s + it.price * it.quantity, 0);
  const disc = couponState ? 15 : 0;
  return {
    cart_id: 'cart_v56',
    restaurant_details: { id: '990011', name: 'Real Bakers' },
    cart_total_count: swiggyCart.length,
    cart_menu_items: items,
    coupon_code: couponState,
    is_coupon_valid: disc > 0 ? 1 : 0,
    coupon_discount_total: disc,
    order_total: itemTotal - disc + 20,
    delivery_fee: 20,
    address_id: 'addr_v56',
    addresses: [{ id: 'addr_v56', selected: true, name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' }]
  };
};

globalThis.fetch = async (u, opts = {}) => {
  const url = String(u);
  const method = String(opts.method || 'GET').toUpperCase();
  if (url.includes('events.swiggy.com')) return jsonRes(200, { message: 'ok', shouldNotify: true, value: 1 }, url);
  if (url.includes('shared_cart')) {
    return jsonRes(200, {
      statusCode: 0,
      data: {
        restaurant_details: { restaurant_id: '990011', restaurant_name: 'Real Bakers' },
        user_cart_map: { u1: { user_cart: swiggyCart.map((it) => ({ menu_item_id: it.menu_item_id, name: it.name, quantity: it.quantity, base_price: it.price * 100, subtotal: it.price * it.quantity * 100, final_price: it.price * it.quantity * 100 })) } }
      }
    }, url);
  }
  if (url.includes('chkout.swiggy.com/api/v2/cart/client/flush')) {
    flushCount += 1;
    swiggyCart = [];
    return jsonRes(200, { statusCode: 0, data: { cartMeta: { cart_total_count: 0 } } }, url);
  }
  if (url.includes('chkout.swiggy.com/api/v2/cart/client/update')) {
    const body = JSON.parse(String(opts.body || '{}'));
    pushedCartBodies.push(body);
    if (Array.isArray(body.cartItems) && body.cartItems.length > 0) {
      swiggyCart = body.cartItems.map((ci) => ({
        menu_item_id: Number(ci.menu_item_id),
        name: (swiggyCart.find((x) => Number(x.menu_item_id) === Number(ci.menu_item_id)) || {}).name || `Item ${ci.menu_item_id}`,
        quantity: Number(ci.quantity),
        price: (swiggyCart.find((x) => Number(x.menu_item_id) === Number(ci.menu_item_id)) || {}).price || 25,
        offer_ids: Array.isArray(ci.offer_ids) ? ci.offer_ids : []
      }));
    }
    if (typeof body.couponCode === 'string') couponState = body.couponCode;
    return jsonRes(200, { statusCode: 0, data: { cartMeta: cartMetaFromState() } }, url);
  }
  if (url.includes('chkout.swiggy.com/api/v2/cart/client')) return jsonRes(200, { statusCode: 0, data: { cartMeta: cartMetaFromState() } }, url);
  if (url.includes('/dapi/cart')) return jsonRes(200, { statusCode: 0, data: { cartMeta: cartMetaFromState() } }, url);
  if (url.includes('order/all')) return jsonRes(200, { statusCode: 0, data: { orders: [] } }, url);
  if (url.includes('maps.swiggy.com/addresses/nearby')) {
    return jsonRes(200, { statusCode: 0, addresses: [{ id: 'addr_v56', name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' }] }, url);
  }
  if (url.includes('/dapi/address') && method === 'POST') return jsonRes(200, { statusCode: 0, data: { id: 'addr_v56' } }, url);
  if (url.includes('mcp.swiggy.com')) return jsonRes(200, { jsonrpc: '2.0', result: { structuredContent: { coupons: [] } } }, url);
  if (url.includes('raw.githubusercontent.com')) return jsonRes(404, {}, url);
  return jsonRes(200, { statusCode: 0, data: {} }, url);
};

function seed() {
  const db = store.getDb();
  db.config.accounts = {
    acc_5601: {
      id: 'acc_5601', phone: '9580917944', customerId: '287113492', name: 'Rahul',
      cookies: `_session_tid=s56; tid=${JWT}; _is_logged_in=1`, tid: JWT, token: 'tok56',
      isLoggedIn: true
    }
  };
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
      items: [
        { itemId: '71234', menu_item_id: 71234, name: 'Hazelnut Missu', price: 25, qty: 2, quantity: 2, offer_ids: ['OF1'] },
        { itemId: '71235', menu_item_id: 71235, name: 'Choco Lava', price: 60, qty: 1, quantity: 1, offer_ids: ['OF2'] }
      ],
      itemTotal: 110, subtotal: 110, finalPayable: 130, discountAmount: 0,
      address: 'Nadiad City, Gujarat 387001',
      addressDetails: { id: 'addr_v56', name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' },
      selectedAccount: 'acc_5601',
      orderAccount: '9580917944',
      availableCoupons: [{ code: 'TRYNEW', discountAmount: 15, finalPayable: 115 }],
      createdAt: new Date().toISOString()
    }
  };
  store.saveDb(db);
  swiggyCart = [
    { menu_item_id: 71234, name: 'Hazelnut Missu', quantity: 2, price: 25, offer_ids: ['OF1'] },
    { menu_item_id: 71235, name: 'Choco Lava', quantity: 1, price: 60, offer_ids: ['OF2'] }
  ];
  couponState = '';
  pushedCartBodies.length = 0;
  sent.length = 0;
}

flow.registerForwardedOrderHandlers(mockBot, {
  isBoss: (id) => Number(id) === BOSS_ID,
  formatOrderBodyFn: renderBodyHtml
});

// ---------------------------------------------------------------------------
console.log('\n━━━ 1) ON/OFF switches exist as buttons and really flip ━━━');
{
  seed();
  await click(`fwd_panel_${ORDER_ID}`, BOSS_ID);
  const panel = findSent('OFFER & CASH PANEL');
  check('panel has a Coupon ON/OFF button', Boolean(buttonWith(panel, `fwd_tgl_${ORDER_ID}_coupon`)));
  check('panel has a Free cash ON/OFF button', Boolean(buttonWith(panel, `fwd_tgl_${ORDER_ID}_freeCash`)));
  check('panel has a Swiggy One ON/OFF button', Boolean(buttonWith(panel, `fwd_tgl_${ORDER_ID}_swiggyOne`)));
  check('panel has an Item offers ON/OFF button', Boolean(buttonWith(panel, `fwd_tgl_${ORDER_ID}_itemOffers`)));
  check('the button label shows the current state', String(buttonWith(panel, `fwd_tgl_${ORDER_ID}_coupon`)?.text || '').includes('ON'),
    String(buttonWith(panel, `fwd_tgl_${ORDER_ID}_coupon`)?.text));

  sent.length = 0;
  await click(`fwd_tgl_${ORDER_ID}_freeCash`, CUSTOMER_ID);
  const after = store.getDb().orders[ORDER_ID];
  check('the CUSTOMER can flip a switch', after.controls?.freeCash === false, JSON.stringify(after.controls));
  const flipped = findSent('Free cash');
  check('the new state is shown on the panel sent to both',
    flipped.some((m) => m.chatId === String(BOSS_ID)) && flipped.some((m) => m.chatId === String(CUSTOMER_ID)));
  check('the button now reads OFF',
    String(buttonWith(flipped, `fwd_tgl_${ORDER_ID}_freeCash`)?.text || '').includes('OFF'));

  sent.length = 0;
  await click(`fwd_tgl_${ORDER_ID}_freeCash`, BOSS_ID);
  check('flipping back restores ON', store.getDb().orders[ORDER_ID].controls?.freeCash === true);
}

console.log('\n━━━ 2) Coupon OFF really removes the live coupon ━━━');
{
  seed();
  const db = store.getDb();
  db.orders[ORDER_ID].couponCode = 'TRYNEW';
  db.orders[ORDER_ID].discountAmount = 15;
  store.saveDb(db);
  couponState = 'TRYNEW';
  const order = store.getDb().orders[ORDER_ID];
  order.availableCoupons = [{ code: 'TRYNEW', discountAmount: 15, finalPayable: 115 }];

  sent.length = 0;
  await click(`fwd_tgl_${ORDER_ID}_coupon`, BOSS_ID);
  const fresh = store.getDb().orders[ORDER_ID];
  check('coupon switch is OFF', fresh.controls?.coupon === false);
  check('live coupon removed from the order', !fresh.couponCode, String(fresh.couponCode));
  check('Swiggy cart got an empty couponCode',
    pushedCartBodies.some((b) => b.couponCode === ''), JSON.stringify(pushedCartBodies.map((b) => b.couponCode)));
  check('both parties were told', findSent('Coupon').some((m) => m.chatId === String(CUSTOMER_ID)));
}

console.log('\n━━━ 3) Quantity buttons: ➖ ➕ 🗑 ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_panel_items_${ORDER_ID}`, BOSS_ID);
  const itemsMsg = findSent('ITEMS / QUANTITY');
  check('items screen opens', itemsMsg.length > 0);
  check('every item has a ➖ button', Boolean(buttonWith(itemsMsg, `fwd_qty_${ORDER_ID}_0_minus`)));
  check('every item has a ➕ button', Boolean(buttonWith(itemsMsg, `fwd_qty_${ORDER_ID}_0_plus`)));
  check('every item has a 🗑 remove button', Boolean(buttonWith(itemsMsg, `fwd_qty_${ORDER_ID}_1_remove`)));

  sent.length = 0;
  pushedCartBodies.length = 0;
  await click(`fwd_qty_${ORDER_ID}_0_plus`, CUSTOMER_ID);
  const q1 = store.getDb().orders[ORDER_ID];
  check('➕ pushes a real Swiggy cart update', pushedCartBodies.length > 0, String(pushedCartBodies.length));
  const body0 = pushedCartBodies[0] || {};
  check('the pushed payload carries the new quantity 3',
    (body0.cartItems || []).some((ci) => Number(ci.menu_item_id) === 71234 && Number(ci.quantity) === 3),
    JSON.stringify(body0.cartItems));
  check('the order now shows 3x', Number((q1.items || []).find((it) => it.menu_item_id === 71234)?.qty) === 3,
    JSON.stringify((q1.items || []).map((it) => [it.name, it.qty])));
  check('bill re-priced from Swiggy totals', Number(q1.itemTotal) === 110 + 25, String(q1.itemTotal));
  check('naya bill dono ko gaya', findSent('BILL').some((m) => m.chatId === String(CUSTOMER_ID)));
  check('a stale QR is cleared on quantity change', !q1.pendingSwiggyUpiUri);

  sent.length = 0;
  await click(`fwd_qty_${ORDER_ID}_1_remove`, BOSS_ID);
  const q2 = store.getDb().orders[ORDER_ID];
  check('🗑 removes just that item', !(q2.items || []).some((it) => Number(it.menu_item_id) === 71235),
    JSON.stringify((q2.items || []).map((it) => it.name)));
  check('remaining item survives', (q2.items || []).some((it) => Number(it.menu_item_id) === 71234));

  sent.length = 0;
  const flushesBefore = flushCount;
  await click(`fwd_qty_${ORDER_ID}_0_remove`, BOSS_ID);
  const q3 = store.getDb().orders[ORDER_ID];
  check('removing the last item flushes the cart', flushCount > flushesBefore);
  check('order is empty and back to COLLECTING', (q3.items || []).length === 0 && q3.cardStage === 'COLLECTING',
    JSON.stringify({ items: (q3.items || []).length, stage: q3.cardStage }));
}

console.log('\n━━━ 4) Switches reach the real sync engine ━━━');
{
  const makeAcc = () => store.getDb().config.accounts.acc_5601;
  // itemOffers OFF → pushed cart items must not carry offer_ids
  seed();
  const orderOffersOff = store.getDb().orders[ORDER_ID];
  orderOffersOff.controls = { itemOffers: false };
  pushedCartBodies.length = 0;
  await cart.adjustOrderItemQuantity(makeAcc(), orderOffersOff, { index: 0, delta: 1 });
  const offBody = pushedCartBodies[0] || {};
  check('itemOffers OFF → offer_ids stripped from the pushed cart',
    (offBody.cartItems || []).every((ci) => (ci.offer_ids || []).length === 0), JSON.stringify(offBody.cartItems));

  // swiggyOne OFF → no subscriptionItems
  seed();
  const orderOneOff = store.getDb().orders[ORDER_ID];
  orderOneOff.controls = { swiggyOne: false };
  orderOneOff.activeSubscriptionItems = [{ plan_id: '773', quantity: 1 }];
  pushedCartBodies.length = 0;
  await cart.adjustOrderItemQuantity(makeAcc(), orderOneOff, { index: 0, delta: 1 });
  check('swiggyOne OFF → no subscriptionItems pushed',
    Array.isArray((pushedCartBodies[0] || {}).subscriptionItems) && pushedCartBodies[0].subscriptionItems.length === 0);

  // coupon OFF → no couponCode pushed
  seed();
  const orderCouponOff = store.getDb().orders[ORDER_ID];
  orderCouponOff.controls = { coupon: false };
  orderCouponOff.couponCode = 'TRYNEW';
  pushedCartBodies.length = 0;
  await cart.adjustOrderItemQuantity(makeAcc(), orderCouponOff, { index: 0, delta: 1 });
  check('coupon OFF → couponCode is not pushed', (pushedCartBodies[0] || {}).couponCode === '',
    JSON.stringify((pushedCartBodies[0] || {}).couponCode));

  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('sync honours the coupon switch', /controlOn\('coupon'\) && liveCart/.test(src));
  check('sync honours the free-cash switch', /controlOn\('freeCash'\)/.test(src));
  check('sync honours the Swiggy One switch', /controlOn\('swiggyOne'\)/.test(src));
  check('sync honours the item-offers switch', /controlOn\('itemOffers'\)/.test(src));
}

console.log('\n━━━ 5) Permissions ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_tgl_${ORDER_ID}_coupon`, STRANGER_ID);
  check('a stranger cannot flip a switch', store.getDb().orders[ORDER_ID].controls?.coupon !== false);
  sent.length = 0;
  await click(`fwd_qty_${ORDER_ID}_0_plus`, STRANGER_ID);
  check('a stranger cannot change quantity',
    Number((store.getDb().orders[ORDER_ID].items || [])[0]?.qty) === 2);
  check('no message was sent to a stranger', sent.length === 0, String(sent.length));
}

console.log('\n━━━ 6) No wipe / no delete ━━━');
{
  const db = store.getDb();
  check('the Swiggy ID still holds its session', String(db.config.accounts.acc_5601?.cookies || '').includes('_session_tid='));
  check('the order still exists', Boolean(db.orders?.[ORDER_ID]));
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
console.log('🏆 USER CONTROLS (ON/OFF + QUANTITY) VERIFIED');
process.exit(0);
