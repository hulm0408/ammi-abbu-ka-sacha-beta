// Offline regression for the post-PR-120 checkout failures:
//   • Breakfast/Late Night claim must pick the OPEN window, not blindly ids[0].
//   • Pay must re-lock/verify coupon + Free Cash + One Lite before any POST.
//   • Cancel must not queue behind a slow provider, must advance the generation,
//     and a late provider response must not resurrect the stuck checkout card.
//   • Stale local barriers recover without claiming a Swiggy order was cancelled.
// No live Swiggy/Telegram/UPI request is made.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-checkout-recovery-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-recovery-token', PRO_VAULT_KEY: 'offline-recovery-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', PRO_ENABLE_CHECKOUT: '1',
  BOSS_ID: '9900', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '0'
});
delete process.env.GITHUB_VAULT_TOKEN;

const { selectCampaignIdsForWindow, campaignIdsForOffer, activateAllEventOffers, resetEventOfferMetaCache } = await import('../event-offers.js');
const { proProvider } = await import('../swiggy-pro-provider.js');
const { handleSwiggyProHttp } = await import('../swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('../swiggy-pro-store.js');
const { getDb, saveDb } = await import('../store.js');
const { planIdleExpiry, STALE_PLACED_TIMEOUT_MS } = await import('../order-idle-expiry.js');

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

// ── 1. Window selection ─────────────────────────────────────────────────────
test('Free Cash: open Breakfast window wins over a closed earlier campaign id', () => {
  const now = Date.parse('2026-11-01T20:30:00+05:30');
  const meta = { breakfast: { prefix: 'byo-bf-v10-', boundaries: [
    { day: 10, startTime: '2026-11-01T08:00:00+05:30', endTime: '2026-11-01T12:00:00+05:30' },
    { day: 11, startTime: '2026-11-01T20:00:00+05:30', endTime: '2026-11-02T00:00:00+05:30' }
  ] } };
  const picked = selectCampaignIdsForWindow('breakfast', ['byo-bf-v10-10', 'byo-bf-v10-11'], meta, now);
  assert.deepEqual(picked.ids, ['byo-bf-v10-11']);
  assert.equal(picked.reason, 'WINDOW_OPEN');
});

test('Free Cash: closed today pre-locks only the next nearby window, not an expired id', () => {
  const now = Date.parse('2026-11-01T18:30:00+05:30');
  const meta = { breakfast: { boundaries: [
    { day: 10, startTime: '2026-10-31T20:00:00+05:30', endTime: '2026-11-01T00:00:00+05:30' },
    { day: 11, startTime: '2026-11-01T20:00:00+05:30', endTime: '2026-11-02T00:00:00+05:30' }
  ] } };
  const picked = selectCampaignIdsForWindow('breakfast', ['byo-bf-v10-10', 'byo-bf-v10-11'], meta, now);
  assert.deepEqual(picked.ids, ['byo-bf-v10-11']);
  assert.equal(picked.reason, 'WINDOW_UPCOMING');
  const closed = selectCampaignIdsForWindow('breakfast', ['byo-bf-v10-10'], meta, now);
  assert.deepEqual(closed.ids, []);
  assert.equal(closed.reason, 'WINDOW_CLOSED');
});

test('Free Cash: campaign day comes from page boundaries, not the calendar date', () => {
  const now = Date.parse('2026-11-01T18:30:00+05:30');
  const meta = { breakfast: { prefix: 'byo-bf-v10-', boundaries: [
    { day: 10, startTime: '2026-11-01T06:00:00+05:30', endTime: '2026-11-01T11:00:00+05:30' },
    { day: 11, startTime: '2026-11-02T06:00:00+05:30', endTime: '2026-11-02T11:00:00+05:30' }
  ] } };
  const ids = campaignIdsForOffer('breakfast', meta, now).ids;
  assert.deepEqual(ids, ['byo-bf-v10-11', 'byo-bf-v10-12']);
  assert.deepEqual(selectCampaignIdsForWindow('breakfast', ids, meta, now), { ids: ['byo-bf-v10-11'], reason: 'WINDOW_UPCOMING' });
});

test('Free Cash: currentWindowOnly writes only the selected open campaign', async () => {
  resetEventOfferMetaCache();
  const now = Date.parse('2026-11-01T20:30:00+05:30');
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (u.includes('/api/notify')) {
      if (method !== 'GET') {
        writes.push(JSON.parse(init.body).campaign);
        return { ok: true, status: 200, json: async () => ({ statusCode: 0 }) };
      }
      const campaign = new URL(u).searchParams.get('campaign');
      const active = writes.includes(campaign);
      return { ok: true, status: 200, json: async () => ({ shouldNotify: active, value: active ? 1 : 0 }) };
    }
    return { ok: true, status: 200, text: async () => '<html></html>', json: async () => ({}) };
  };
  const out = await activateAllEventOffers({ id: 'window-test', token: 't', tid: 'a.b.c' }, {
    fetchImpl, nowMs: now, offerKeys: ['breakfast'], currentWindowOnly: true, parallelOffers: true,
    requestTimeoutMs: 1000, maxRetries: 0, deadlineAt: Date.now() + 5000,
    meta: { breakfast: { prefix: 'byo-bf-v10-', boundaries: [
      { day: 10, startTime: '2026-11-01T08:00:00+05:30', endTime: '2026-11-01T12:00:00+05:30' },
      { day: 11, startTime: '2026-11-01T20:00:00+05:30', endTime: '2026-11-02T00:00:00+05:30' }
    ] } }
  });
  assert.deepEqual(writes, ['byo-bf-v10-11']);
  assert.equal(out.offers.breakfast.campaign, 'byo-bf-v10-11');
  assert.equal(out.offers.breakfast.windowReason, 'WINDOW_OPEN');
});

// ── 2. Provider benefit re-lock / split-pay ─────────────────────────────────
const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567', exp: 1900000000 })).toString('base64url') + '.signature';
const account = { phone: '9123456789', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const address = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', selected: true };
const items = [{ menu_item_id: 9001, qty: 1, name: 'Combo', price: 230, variants: [], addons: [] }];
const approvedQuote = {
  total: 151, itemTotal: 230, packingCharges: 10, taxes: 30,
  deliveryFee: 0, deliverySaved: 49, discount: 30, couponSaving: 30, couponCode: 'SAVE30',
  freeCash: 70, tradeDiscount: 20, oneMembershipFee: 1, oneApplied: true,
  subscriptionItems: [{ plan_id: '773', quantity: 1 }], walletSplitPayAmount: 20
};
const baseCart = () => ({ restaurantId: '201', restaurantName: 'Mock', forSomeoneElse: false, items: structuredClone(items), quote: structuredClone(approvedQuote), activeSubscriptionItems: [{ plan_id: '773', quantity: 1 }] });
function cartMeta(restored) {
  return restored ? {
    order_total: 171, item_total: 230, total_packing_charges: 10, taxesAndCharges: 30,
    positiveDeliveryChargesExclusive: 0, free_delivery_discount: 49, subscription_total: 1,
    coupon_code: 'SAVE30', is_coupon_valid: 1, coupon_discount_total: 30,
    trade_discount_total: 70, trade_discount_reward_amount: 50, user_swiggy_money: 20, swiggy_money: 0,
    cartId: 'cart-1', address_id: 'addr-1', restaurant_details: { id: '201', name: 'Mock' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Combo', subtotal: 23000, final_price: 23000, addons: [], variants: [] }]
  } : {
    order_total: 319, item_total: 230, total_packing_charges: 10, taxesAndCharges: 30,
    positiveDeliveryChargesExclusive: 49, free_delivery_discount: 0, subscription_total: 0,
    coupon_code: '', is_coupon_valid: 0, coupon_discount_total: 0,
    trade_discount_total: 0, trade_discount_reward_amount: 0, user_swiggy_money: 20, swiggy_money: 0,
    cartId: 'cart-1', address_id: 'addr-1', restaurant_details: { id: '201', name: 'Mock' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Combo', subtotal: 23000, final_price: 23000, addons: [], variants: [] }]
  };
}
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function mockProviderFetch({ restoreOnUpdate }) {
  const state = { restored: false, placeCalls: 0, updateBodies: [], placeBodies: [] };
  globalThis.fetch = async (raw, options = {}) => {
    const u = String(raw);
    if (u.includes('/api/v2/order/place')) {
      state.placeCalls++; state.placeBodies.push(JSON.parse(options.body));
      return jsonRes({ statusCode: 0, data: { order_id: '123456789012', app_redirection_info: { intent: 'upi://pay?pa=upiswiggy%40icici&am=151.00&cu=INR&tr=offline' } } });
    }
    if (u.includes('/api/v2/cart/client/update')) {
      state.updateBodies.push(JSON.parse(options.body));
      if (restoreOnUpdate) state.restored = true;
      return jsonRes({ statusCode: 0, tid: jwt, data: { cartMeta: cartMeta(state.restored) } });
    }
    if (u.includes('/api/v2/cart/client')) return jsonRes({ statusCode: 0, tid: jwt, data: { cartMeta: cartMeta(state.restored) } });
    if (u.includes('/api/v1/user/profile')) return jsonRes({ statusCode: 0, data: { customer_id: '1234567', mobile: '9123456789', addresses: [address] } });
    if (u.includes('/dapi/address')) return jsonRes({ statusCode: 0, data: { addresses: [address] } });
    throw new Error('unmocked offline request: ' + u);
  };
  return state;
}

test('Pay: missing coupon/Free Cash/One Lite is re-locked and split-pay reaches the place body', async () => {
  const state = mockProviderFetch({ restoreOnUpdate: true });
  try {
    const out = await proProvider.checkout(account, address, baseCart(), 'relock-ok');
    assert.equal(state.placeCalls, 1);
    assert.equal(out.amount, 151);
    assert.ok(state.updateBodies.length >= 1, 'benefits were re-locked before POST');
    assert.equal(state.updateBodies[0].couponCode, 'SAVE30');
    assert.deepEqual(state.updateBodies[0].subscriptionItems, [{ plan_id: '773', quantity: 1 }]);
    assert.equal(state.placeBodies[0].order_total, 171);
    assert.equal(state.placeBodies[0].swiggy_pay_amount, '20');
  } finally { globalThis.fetch = realFetch; }
});

test('Pay: if benefits cannot be restored, no order/QR is placed on the higher bill', async () => {
  const state = mockProviderFetch({ restoreOnUpdate: false });
  try {
    await assert.rejects(proProvider.checkout(account, address, baseCart(), 'relock-fail'), e => e.code === 'BILL_CHANGED' && e.diag?.placementAttempted === false);
    assert.equal(state.placeCalls, 0);
  } finally { globalThis.fetch = realFetch; }
});

// ── 3. API cancel is non-blocking and generation-safe ───────────────────────
const receiver = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5204', lng: '73.8567' };
const placementKeys = [];
let releaseFirst = null;
let firstEntered = null;
const firstStarted = new Promise(r => { firstEntered = r; });
const fakeProvider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [receiver]; },
  async orders() { return []; },
  async checkout(_account, _address, _cart, key) {
    placementKeys.push(key);
    if (placementKeys.length === 1) {
      firstEntered();
      await new Promise(r => { releaseFirst = r; });
    }
    return { orderId: '123456789012', upiIntentUrl: 'upi://pay?pa=upiswiggy%40icici&am=150.25&cu=INR&tr=offline', amount: 150.25 };
  }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fakeProvider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); });
function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'User' }), query_id: 'q' });
  const text = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(text).digest('hex'));
  return params.toString();
}
async function post(route, body, userId = '9900') {
  const res = await fetch(baseUrl + '/pro/api/' + route, { method: 'POST', headers: { 'X-Telegram-Init-Data': sign(userId), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function seedWorkspace() {
  const db = getDb();
  db.config.accounts ||= {};
  db.config.accounts.mine = { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' };
  saveDb(db);
  writeProWorkspace('9900', {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [], checkout: null,
    cart: {
      restaurantId: '201', restaurantName: 'Mock', forSomeoneElse: false,
      items: [{ lineKey: 'l1', id: '9001', menu_item_id: 9001, name: 'Meal', qty: 1, price: 125, variants: [], addons: [] }],
      quote: { total: 150.25, itemTotal: 125, deliveryFee: 20, taxes: 5.25, couponCode: '', fetchedAt: new Date().toISOString() }
    }
  });
}
const confirmation = () => ({ confirmCheckout: true, expectedTotal: 150.25, quoteFetchedAt: readProWorkspace('9900').cart.quote.fetchedAt });

test('Cancel: returns while provider checkout is still running, advances generation, late QR cannot revive card', { timeout: 15000 }, async () => {
  seedWorkspace();
  const first = post('checkout', confirmation());
  try {
    const entered = await Promise.race([firstStarted.then(() => 'entered'), first.then(r => ({ early: r })), new Promise((_, rej) => setTimeout(() => rej(new Error('provider never entered; ws=' + JSON.stringify(readProWorkspace('9900').checkout) + ' keys=' + JSON.stringify(placementKeys))), 5000))]);
    if (entered && entered.early) throw new Error('checkout returned before provider: ' + JSON.stringify(entered.early));
    const started = Date.now();
    const cancel = await post('checkout/cancel', { confirmCancel: true });
    assert.ok(Date.now() - started < 1000, 'cancel did not wait for the provider');
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.checkout, null);
    assert.equal(readProWorkspace('9900').checkoutGeneration, 1);
  } finally {
    releaseFirst?.();
  }
  const late = await first;
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.checkout, null, 'late provider success must not resurrect checkout');
  assert.equal(readProWorkspace('9900').checkout, null);
  const second = await post('checkout', confirmation());
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.checkout.status, 'PAYMENT_PENDING');
  assert.deepEqual(placementKeys, ['pro:9900:0', 'pro:9900:1']);
});

// ── 4. Idle recovery ────────────────────────────────────────────────────────
test('Idle: SUBMITTING without a dispatch journal clears; an in-flight journal stays locked', () => {
  const ws = { cart: { items: [], quote: { fetchedAt: new Date(Date.now() - 4 * 60_000).toISOString() } }, checkout: { id: '0', status: 'SUBMITTING', createdAt: new Date(Date.now() - 4 * 60_000).toISOString() }, lastActivityAt: new Date(Date.now() - 4 * 60_000).toISOString() };
  const stale = planIdleExpiry({ ws, now: Date.now(), timeoutMs: 120000, placementInFlight: false });
  assert.equal(stale.expire, true);
  assert.equal(stale.refundFee, true);
  const active = planIdleExpiry({ ws, now: Date.now(), timeoutMs: 120000, placementInFlight: true });
  assert.equal(active.expire, false);
});

test('Idle: long-idle placed/unpaid closes locally without refund or a Swiggy-cancel claim', () => {
  const ws = { cart: { items: [] }, checkout: { id: '0', status: 'PAYMENT_PENDING', orderId: '123456789012', createdAt: new Date(Date.now() - STALE_PLACED_TIMEOUT_MS - 1000).toISOString() }, lastActivityAt: new Date(Date.now() - STALE_PLACED_TIMEOUT_MS - 1000).toISOString() };
  const plan = planIdleExpiry({ ws, now: Date.now(), timeoutMs: 120000 });
  assert.equal(plan.expire, true);
  assert.equal(plan.kind, 'PLACED_UNPAID');
  assert.equal(plan.refundFee, false);
  assert.equal(plan.keepRecord, true);
});

test('UI: cancel invalidates in-flight checkout/status responses and has a bounded request', () => {
  const app = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');
  assert.match(app, /let checkoutEpoch = 0/);
  assert.match(app, /const epoch = \+\+checkoutEpoch/);
  assert.match(app, /checkout\/cancel', 'POST', \{ confirmCancel: true \}, \{ timeoutMs: 8000 \}/);
  assert.match(app, /if \(epoch !== checkoutEpoch\) return/);
});
