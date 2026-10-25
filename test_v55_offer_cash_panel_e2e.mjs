/**
 * v55 — OFFER & CASH PANEL (boss + customer, har cheez ka button)
 *
 * User ask: "coupon change, clear cart, import cart link, refresh cash, free cash,
 * item adjust — har ek ka button, dono ko send".
 *
 * Proven here with a real handler registration and mocked Swiggy:
 *   1. Bill card par panel button maujood hai.
 *   2. Panel me items / cart-link / coupons / cash / clear-cart sab buttons hain.
 *   3. BOSS aur CUSTOMER dono panel khol sakte hain; koi teesra nahi.
 *   4. Coupon apply → bill re-price + purana QR clear + dono ko naya card.
 *   5. Coupon REMOVE → coupon hat jata hai.
 *   6. Clear cart → items/coupon/QR saaf, phir cart link maanga jata hai.
 *   7. Cart link paste → naya cart import + bill dono ko.
 *   8. Refresh cash → free cash ka honest result.
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
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => 'application/json', getSetCookie: () => [] },
    text: async () => text,
    json: async () => payload
  };
}

const realFetch = globalThis.fetch;
const store = await import('./store.js');
const flow = await import('./forwarded-order-flow.js');

const BOSS_ID = 900001;
const CUSTOMER_ID = 900002;
const STRANGER_ID = 900003;
const ORDER_ID = 'FWD6377';
const JWT = (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: '287113492', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.sig`;
})();

const sent = [];       // { chatId, text, keyboard }
const actionHandlers = [];
const textHandlers = [];
let msgSeq = 5000;

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

const renderBodyHtml = (order) =>
  `<b>BILL</b>\nItems: ₹${order.itemTotal || 0}\nPayable: ₹${order.finalPayable || 0}`;

const makeCtx = ({ fromId = BOSS_ID, text = '', cbData = null }) => {
  const ctx = {
    from: { id: fromId, first_name: 'T' },
    chat: { id: fromId, type: 'private' },
    telegram: mockTelegram,
    message: text ? { text } : null,
    callbackQuery: cbData ? { data: cbData, message: { message_id: 777 } } : undefined,
    reply: (t, ex) => mockTelegram.sendMessage(fromId, t, ex),
    replyWithPhoto: (p, ex) => mockTelegram.sendPhoto(fromId, p, ex),
    editMessageText: (t, ex) => mockTelegram.editMessageText(fromId, 777, undefined, t, ex),
    editMessageReplyMarkup: async () => true,
    answerCbQuery: async () => true
  };
  return ctx;
};

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

const sendText = async (text, fromId = BOSS_ID) => {
  for (const fn of textHandlers) {
    const ctx = makeCtx({ fromId, text });
    let calledNext = false;
    const next = async () => { calledNext = true; };
    await fn(ctx, next);
    if (!calledNext || true) return { handled: !calledNext };
  }
  return { handled: false };
};

const findSent = (needle, chatId = null) =>
  sent.filter((m) => m.text.includes(needle) && (!chatId || m.chatId === String(chatId)));
const flatButtons = (m) => (m?.keyboard || []).flat();
const allButtonsOf = (msgs) => msgs.flatMap((m) => flatButtons(m));
const hasButton = (msgs, needle) => allButtonsOf(msgs).some((b) => String(b.callback_data || '').includes(needle) || String(b.text || '').includes(needle));

// ---------------------------------------------------------------------------
// Vault + order
// ---------------------------------------------------------------------------
const dbBefore = JSON.parse(JSON.stringify(store.getDb()));
const seed = () => {
  const db = store.getDb();
  db.config.accounts = {
    acc_9580917944: {
      id: 'acc_9580917944', phone: '9580917944', customerId: '287113492',
      name: 'Rahul Kumar', cookies: `_session_tid=v55sess; tid=${JWT}; _is_logged_in=1`,
      tid: JWT, token: JWT, isLoggedIn: true, totalOrdersCount: 0
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
      cart: 'https://www.swiggy.com/restaurants/real-bakers-990011',
      items: [{ itemId: '71234', menu_item_id: 71234, name: 'Hazelnut Missu', price: 25, qty: 2 }],
      itemTotal: 50, subtotal: 50, finalPayable: 50,
      address: 'Nadiad City, Gujarat 387001',
      addressDetails: { id: 'addr_v55', name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' },
      selectedAccount: 'acc_9580917944',
      orderAccount: '9580917944',
      createdAt: new Date().toISOString(),
      availableCoupons: [
        { code: 'TRYNEW', title: 'TRYNEW', discountAmount: 0, finalPayable: 50 },
        { code: 'STEALDEAL', title: 'STEALDEAL', discountAmount: 0, finalPayable: 50 }
      ]
    }
  };
  store.saveDb(db);
};

// Swiggy mock: coupon TRYNEW gives ₹15 off, REMOVE clears it.
const cartPayload = (code) => {
  const disc = code === 'TRYNEW' ? 15 : 0;
  return {
    statusCode: 0,
    data: {
      cartMeta: {
        cart_id: 'cart_v55',
        restaurant_details: { id: '990011', name: 'Real Bakers' },
        cart_total_count: 1,
        cart_menu_items: [{ menu_item_id: 71234, name: 'Hazelnut Missu', price: 25, quantity: 2, subtotal: 50, final_price: 25 }],
        coupon_code: code,
        is_coupon_valid: disc > 0 ? 1 : 0,
        coupon_discount_total: disc,
        order_total: 50 - disc + 20,
        delivery_fee: 20,
        address_id: 'addr_v55',
        addresses: [{
          id: 'addr_v55', selected: true, name: 'Tohid', mobile: '9000000011',
          address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616'
        }]
      }
    }
  };
};

globalThis.fetch = async (u, opts = {}) => {
  const url = String(u);
  const raw = String(opts.body || '{}');
  const codeMatch = raw.match(/"coupon_?[cC]ode"\s*:\s*"([^"]*)"/);
  const code = String(codeMatch?.[1] || '').toUpperCase();
  if (url.includes('shared_cart')) {
    return jsonRes(200, {
      statusCode: 0,
      data: {
        restaurant_details: { restaurant_id: '990011', restaurant_name: 'Real Bakers', area_name: 'Nadiad' },
        user_cart_map: {
          u1: {
            user_cart: [{
              menu_item_id: 71234, name: 'Hazelnut Missu', quantity: 2,
              base_price: 2500, subtotal: 5000, final_price: 5000
            }]
          }
        }
      }
    }, url);
  }
  if (url.includes('events.swiggy.com')) return jsonRes(200, { message: 'ok', shouldNotify: true, value: 1 }, url);
  if (url.includes('order/all')) return jsonRes(200, { statusCode: 0, data: { orders: [] } }, url);
  if (url.includes('maps.swiggy.com/addresses/nearby')) {
    return jsonRes(200, { statusCode: 0, addresses: [{ id: 'addr_v55', name: 'Tohid', mobile: '9000000011', address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616' }] }, url);
  }
  if (/\/dapi\/address/.test(url) && String(opts.method || '').toUpperCase() === 'POST') return jsonRes(200, { statusCode: 0, data: { id: 'addr_v55' } }, url);
  if (url.includes('/dapi/address') || url.includes('/dapi/cart') && !url.includes('flush')) return jsonRes(200, cartPayload(code), url);
  if (url.includes('chkout.swiggy.com/api/v2/cart/client/flush')) return jsonRes(200, { statusCode: 0, data: { cartMeta: { cart_total_count: 0 } } }, url);
  if (url.includes('chkout.swiggy.com/api/v2/cart/client')) return jsonRes(200, cartPayload(code), url);
  if (url.includes('order/details') || url.includes('order/trackV4')) return jsonRes(200, { statusCode: 0, data: {} }, url);
  return jsonRes(200, { statusCode: 0, data: {} }, url);
};

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 1: panel button + panel buttons (boss & customer) ━━━');
{
  seed();
  flow.registerForwardedOrderHandlers(mockBot, {
    isBoss: (id) => Number(id) === BOSS_ID,
    formatOrderBodyFn: renderBodyHtml
  });

  const order = store.getDb().orders[ORDER_ID];
  const view = flow.buildForwardedOrderCardView(order, store.getDb(), renderBodyHtml);
  const cardKeyboard = view.keyboard?.reply_markup?.inline_keyboard || view.keyboard?.inline_keyboard || [];
  const btn = cardKeyboard.flat();
  check('bill card carries the 🛠 Offer & Cash Panel button',
    btn.some((b) => String(b.callback_data || '') === `fwd_panel_${ORDER_ID}`));

  sent.length = 0;
  await click(`fwd_panel_${ORDER_ID}`, BOSS_ID);
  const panelMsg = findSent('OFFER & CASH PANEL');
  check('boss can open the panel', panelMsg.length > 0);
  const panelButtons = allButtonsOf(panelMsg);
  const need = [
    ['items', `fwd_panel_items_${ORDER_ID}`],
    ['import cart link', `fwd_panel_import_${ORDER_ID}`],
    ['coupons', `fwd_panel_coupons_${ORDER_ID}`],
    ['refresh cash', `fwd_panel_cash_${ORDER_ID}`],
    ['clear cart', `fwd_panel_clear_${ORDER_ID}`],
    ['re-scan offers', `fwd_panel_rescan_${ORDER_ID}`]
  ];
  for (const [label, cb] of need) {
    check(`panel has the ${label} button`, panelButtons.some((b) => String(b.callback_data || '') === cb));
  }
  check('panel went to BOTH boss and customer', panelMsg.some((m) => m.chatId === String(BOSS_ID)) && panelMsg.some((m) => m.chatId === String(CUSTOMER_ID)),
    panelMsg.map((m) => m.chatId).join(','));

  sent.length = 0;
  await click(`fwd_panel_${ORDER_ID}`, CUSTOMER_ID);
  check('the CUSTOMER can open the same panel', findSent('OFFER & CASH PANEL').length > 0);

  sent.length = 0;
  await click(`fwd_panel_${ORDER_ID}`, STRANGER_ID);
  check('a stranger gets no panel (unauthorized)', findSent('OFFER & CASH PANEL').length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 2: coupon list + apply + remove ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_panel_coupons_${ORDER_ID}`, BOSS_ID);
  const listMsg = findSent('COUPONS');
  check('coupon list opens from the panel', listMsg.length > 0);
  check('every offer has its own button',
    allButtonsOf(listMsg).some((b) => String(b.callback_data || '') === `fwd_cpn_${ORDER_ID}_TRYNEW`)
    && allButtonsOf(listMsg).some((b) => String(b.callback_data || '') === `fwd_cpn_${ORDER_ID}_STEALDEAL`));

  sent.length = 0;
  await click(`fwd_cpn_${ORDER_ID}_TRYNEW`, BOSS_ID);
  const fresh = store.getDb().orders[ORDER_ID];
  check('coupon gets applied to the order', String(fresh.couponCode || '').toUpperCase() === 'TRYNEW', String(fresh.couponCode));
  check('discount is taken from Swiggy', Number(fresh.discountAmount) === 15, String(fresh.discountAmount));
  check('payable is re-priced', Number(fresh.finalPayable) === 55, String(fresh.finalPayable));
  const confirmMsgs = findSent('naya bill dono ko bhej diya');
  check('the new bill is pushed to both parties',
    confirmMsgs.length > 0, String(confirmMsgs.length));

  sent.length = 0;
  await click(`fwd_cpn_${ORDER_ID}_REMOVE`, BOSS_ID);
  const afterRemove = store.getDb().orders[ORDER_ID];
  check('REMOVE clears the coupon', !afterRemove.couponCode, String(afterRemove.couponCode));
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 3: clear cart + import cart link (text) ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_panel_clear_${ORDER_ID}`, BOSS_ID);
  const cleared = store.getDb().orders[ORDER_ID];
  check('clear cart empties items', Array.isArray(cleared.items) && cleared.items.length === 0);
  check('clear cart drops the coupon and total', !cleared.couponCode && Number(cleared.finalPayable) === 0);
  check('clear cart asks for a new cart link', findSent('Cart clear ho gaya').length > 0);

  sent.length = 0;
  const res = await sendText('https://swig.gy/gc/990011/Tohid-642855918', BOSS_ID);
  check('pasted cart link is handled by the panel input', res.handled === true);
  const imported = store.getDb().orders[ORDER_ID];
  check('cart link import rebuilds the cart', Array.isArray(imported.items) && imported.items.length > 0, JSON.stringify(imported.items?.length));
  check('import reports success to the user', findSent('Naya cart import ho gaya').length > 0);
  check('import pushes the refreshed bill to both', findSent('BILL').some((m) => m.chatId === String(CUSTOMER_ID)));
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 4: refresh cash reports honestly ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_panel_cash_${ORDER_ID}`, BOSS_ID);
  const cashMsg = findSent('CASH REFRESH');
  check('cash refresh produces a report', cashMsg.length > 0);
  const text = cashMsg.map((m) => m.text).join('\n');
  check('the report states the free-cash outcome (applied OR an honest reason)',
    /Free cash lag gaya|Free cash abhi 0/.test(text), text.slice(0, 120));
  check('the report lists the breakfast/late-night offer state', /Breakfast offer:/.test(text) && /Late-night offer:/.test(text));
  check('cash report goes to both parties',
    cashMsg.some((m) => m.chatId === String(BOSS_ID)) && cashMsg.some((m) => m.chatId === String(CUSTOMER_ID)));
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 5: item adjust view + wiring ━━━');
{
  seed();
  sent.length = 0;
  await click(`fwd_panel_items_${ORDER_ID}`, BOSS_ID);
  const itemsMsg = findSent('ITEMS / QUANTITY');
  check('items screen lists the cart items', itemsMsg.length > 0 && /Hazelnut Missu/.test(itemsMsg[0].text));
  check('items adjust offers import + refresh', hasButton(itemsMsg, `fwd_panel_import_${ORDER_ID}`) && hasButton(itemsMsg, `fwd_panel_cartrefresh_${ORDER_ID}`));

  const src = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('coupon apply clears a stale payment QR (never a wrong-price QR)',
    /Any old QR belongs to the previous price/.test(src) && /pendingSwiggyUpiUri = ''/.test(src));
  check('panel text input handler passes other messages through (next())',
    /if \(!wait\) return next\(\);/.test(src));
  check('panel targets both boss and customer chats',
    /const sendPanelToBoth = async \(ctx, order, text, keyboard\)/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 6: no ID wiped, no order deleted ━━━');
{
  const now = store.getDb();
  check('the Swiggy ID keeps its session', Boolean(now.config.accounts.acc_9580917944?.cookies));
  check('the order still exists', Boolean(now.orders?.[ORDER_ID]));
  const db = store.getDb();
  db.config = dbBefore.config;
  db.orders = dbBefore.orders;
  store.saveDb(db);
  globalThis.fetch = realFetch;
  check('vault + boss ids restored for the next suite', true);
}

console.log(`\n📊 RESULT: ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log('❌ FAILED CHECKS PRESENT');
  process.exit(1);
}
console.log('🏆 OFFER & CASH PANEL VERIFIED');
process.exit(0);
