// Offline regression for the 02-11-2026 checkout-page request:
//   • Checkout page gets the reference app's "Live Order Tracking" card —
//     Swiggy order ID + live link (Copy/Open) + Re-fetch — shown on the
//     checkout/payment view itself.
//   • The live tracking link is fetched the moment the order is placed
//     (orderId present in the checkout response), NOT only after payment:
//     POST /pro/api/checkout returns orderId without tracking, and
//     GET /pro/api/orders/tracking?id=<orderId>&scope=checkout returns the
//     Swiggy link — exactly the call the mini app fires right after place.
//   • The Pay Now / Place button markup is byte-identical (boss: "pay now
//     wala button pura rahega usko change mat kario").
// No live Swiggy/Telegram/UPI request is made — provider is a fake.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-checkout-tracking-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-tracking-token', PRO_VAULT_KEY: 'offline-tracking-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', PRO_ENABLE_CHECKOUT: '1',
  BOSS_ID: '9900', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '0'
});
delete process.env.GITHUB_VAULT_TOKEN;

const { handleSwiggyProHttp } = await import('../swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('../swiggy-pro-store.js');
const { getDb, saveDb } = await import('../store.js');

const ORDER_ID = '252583515117';
const LIVE_LINK = 'https://www.swiggy.com/ofo/track/r9iLOAKbmCHg';

// ── 1. UI source guards (swiggy-pro-app.js) ─────────────────────────────────
const app = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');

test('UI: Pay Now pay-bar button is byte-identical (not touched)', () => {
  assert.ok(app.includes('<button class="button green pay-now" type="button" data-action="checkout-start"'),
    'pay-bar Pay Now button markup changed');
  assert.ok(app.includes('Pay Now · ${money(state.cart.quote.total)}'),
    'handoff Pay Now button markup changed');
  // The pay-bar line must not reference the new tracking card.
  const payBarLine = app.split('\n').find(l => l.includes('button green pay-now'));
  assert.ok(!payBarLine.includes('track'), 'pay-bar line must stay free of tracking changes');
});

test('UI: checkout/payment views render the Live Order Tracking card', () => {
  assert.match(app, /function renderCheckoutTracking\(c\)/);
  const payStart = app.indexOf('function renderPaymentScreen');
  const payScreen = app.slice(payStart, app.indexOf('function renderCart', payStart));
  assert.ok(payScreen.includes('${renderCheckoutTracking(c)}'), 'payment screen must include the tracking card');
  const coStart = app.indexOf('function renderCheckout()');
  const checkoutFn = app.slice(coStart, app.indexOf('function renderBill(', coStart));
  assert.ok((checkoutFn.match(/\$\{trackCard\}/g) || []).length >= 3, 'all renderCheckout branches must include the tracking card');
  // Only Swiggy-returned https links are shown — never a fabricated link.
  const card = app.slice(app.indexOf('function renderCheckoutTracking'), app.indexOf('function renderPaymentScreen'));
  assert.match(card, /\^https:\\\/\\\//);
  assert.match(card, /Active Live Link/);
  assert.match(card, /Re-fetch Tracking Link/);
  assert.match(card, /data-action="checkout-track-refresh"/);
});

test('UI: merge() keeps the fetched live link across checkout/status polls (same orderId)', () => {
  const mergeFn = app.slice(app.indexOf('function merge(data)'), app.indexOf('function merge(data)') + 1200);
  assert.match(mergeFn, /const previousCheckout = state\.checkout/);
  assert.match(mergeFn, /tracking: previousCheckout\.tracking/,
    'poll response without tracking must not wipe the app-fetched live link');
  assert.match(mergeFn, /String\(previousCheckout\.orderId \|\| ''\) === String\(state\.checkout\.orderId \|\| ''\)/,
    'link is kept only for the same order');
});

test('UI: Pay Now ke baad bada "Checkout band karein" cancel card nahi aata — status + tracking card aata hai', () => {
  assert.ok(!app.includes('<div class="card cancel-card">'), 'cancel card markup hona hi nahi chahiye');
  const checkoutFn = app.slice(app.indexOf('function renderCheckout()'), app.indexOf('function renderBill('));
  assert.match(checkoutFn, /Order status/);
  assert.match(checkoutFn, /data-action="checkout-status"/);
  assert.ok((checkoutFn.match(/\$\{trackCard\}/g) || []).length >= 3, 'tracking card har checkout branch me');
  // Cancel ka option ab bhi hai, par sirf chhote text button me.
  assert.match(checkoutFn, /<button class="text-button" type="button" data-action="checkout-cancel">/);
  // Auto-poll OUTCOME_UNKNOWN pe bhi chalta hai — PAID hote hi My Orders khule.
  assert.match(app, /c\.status === 'PAYMENT_PENDING' \|\| c\.status === 'OUTCOME_UNKNOWN'/);
  assert.match(app, /out\.checkout\?\.status === 'PAYMENT_PENDING' \|\| out\.checkout\?\.status === 'OUTCOME_UNKNOWN'\) maybeCheckoutTracking/);
});

test('UI: tracking link is fetched as soon as the order is placed', () => {
  assert.match(app, /if \(out\.checkout\?\.orderId\) refreshCheckoutTracking\(\)/,
    'checkout-start must fire the tracking fetch right after place');
  assert.match(app, /orders\/tracking\?id=' \+ encodeURIComponent\(orderId\) \+ '&scope=checkout'/,
    'fetch must hit the checkout-scope tracking endpoint');
  assert.match(app, /action === 'checkout-track-refresh'/);
  assert.match(app, /maybeCheckoutTracking\(\);/);
});

// ── 2. API level (fully mocked provider; no real order/payment) ─────────────
const receiver = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5204', lng: '73.8567' };
const placedOrder = { id: ORDER_ID, restaurant: 'Mock', status: 'Order placed', amount: 150.25, placedAt: new Date().toISOString(), items: [{ name: 'Meal', qty: 1 }] };
let ordersList = [placedOrder]; // mutable: simulate Swiggy history lag right after place
let ordersThrow = false; // mutable: simulate order-history fetch failure (unverifiable)
let paymentResult = { paid: false, paymentVerified: false }; // mutable: payment truth check
const fakeProvider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [receiver]; },
  async orders() { if (ordersThrow) throw new Error('Swiggy order history could not be fetched.'); return ordersList; },
  async checkout() {
    return { orderId: ORDER_ID, upiIntentUrl: 'upi://pay?pa=upiswiggy%40icici&am=150.25&cu=INR&tr=offline', amount: 150.25 };
  },
  async checkPayment() { return paymentResult; },
  async tracking(_account, id) {
    if (String(id) !== ORDER_ID) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    return { orderId: ORDER_ID, trackingUrl: LIVE_LINK, status: 'Order placed', eta: '35 mins', via: 'FYI_CTA' };
  }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fakeProvider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'User' }), query_id: 'q' });
  const text = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(text).digest('hex'));
  return params.toString();
}
async function call(route, { method = 'GET', body, userId = '9900' } = {}) {
  const res = await fetch(baseUrl + '/pro/api/' + route, {
    method, headers: { 'X-Telegram-Init-Data': sign(userId), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
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

test('Place: checkout response carries orderId immediately, tracking link comes from the checkout-scope tracking endpoint', async () => {
  seedWorkspace();
  const quote = readProWorkspace('9900').cart.quote;
  const placed = await call('checkout', { method: 'POST', body: { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt } });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(placed.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(placed.body.checkout.orderId, ORDER_ID);
  // Place response itself has no tracking link — the app must fetch it right
  // away via orders/tracking (scope=checkout), which is what the UI now does.
  assert.ok(!placed.body.checkout.tracking, 'place response should not yet embed tracking');

  const track = await call('orders/tracking?id=' + encodeURIComponent(ORDER_ID) + '&scope=checkout');
  assert.equal(track.status, 200, JSON.stringify(track.body));
  assert.equal(track.body.tracking.trackingUrl, LIVE_LINK);
  assert.equal(track.body.tracking.orderId, ORDER_ID);
  assert.equal(track.body.tracking.status, 'Order placed');

  // Boss (02-11-2026): link checkout record me persist ho — poll/reload me gayab na ho.
  assert.equal(readProWorkspace('9900').checkout?.tracking?.trackingUrl, LIVE_LINK, 'live link must be persisted on the checkout record');
  const status = await call('checkout/status', { method: 'POST', body: {} });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(status.body.checkout.tracking?.trackingUrl, LIVE_LINK, 'checkout/status poll must keep returning the live link');

  // A different order id is not trackable through this checkout scope.
  const other = await call('orders/tracking?id=999999999999&scope=checkout');
  assert.equal(other.status, 404);
});

test('Live link right after place: checkout-scope tracking skips the order-history gate (history lag)', async () => {
  // Fresh checkout (cancel advances the generation, so the journal key is new).
  const cancel = await call('checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  seedWorkspace();
  const quote = readProWorkspace('9900').cart.quote;
  const placed = await call('checkout', { method: 'POST', body: { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt } });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(placed.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(placed.body.checkout.orderId, ORDER_ID);

  // Right after place, Swiggy's order history may not list the new order yet.
  ordersList = [];
  try {
    // This is the exact call the mini app fires the moment the order is placed.
    const track = await call('orders/tracking?id=' + encodeURIComponent(ORDER_ID) + '&scope=checkout');
    assert.equal(track.status, 200, JSON.stringify(track.body));
    assert.equal(track.body.tracking.trackingUrl, LIVE_LINK);
    assert.equal(track.body.tracking.orderId, ORDER_ID);
    // Outside checkout scope the history gate still applies.
    const active = await call('orders/tracking?id=' + encodeURIComponent(ORDER_ID));
    assert.equal(active.status, 404);
    // A different id under checkout scope is still rejected.
    const other = await call('orders/tracking?id=999999999999&scope=checkout');
    assert.equal(other.status, 404);
  } finally { ordersList = [placedOrder]; }
});

test('New Pay Now: old UNPAID checkout auto-closes (payment checked first); fresh unpaid and PAID ones still block', async () => {
  const place = async () => {
    const quote = readProWorkspace('9900').cart.quote;
    return call('checkout', { method: 'POST', body: { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt } });
  };
  // 1) Place order A → PAYMENT_PENDING with orderId.
  seedWorkspace();
  let placed = await place();
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(placed.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(placed.body.checkout.orderId, ORDER_ID);

  // 2) Fresh unpaid checkout → new Pay Now still blocked (user may be paying right now).
  let again = await place();
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.ok(readProWorkspace('9900').checkout, 'fresh unpaid checkout must NOT be closed');

  // 3) Age the old checkout beyond the idle timeout, still unpaid → auto-close + new placement succeeds.
  const ws = readProWorkspace('9900');
  ws.checkout.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeProWorkspace('9900', ws);
  again = await place();
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.checkout.status, 'PAYMENT_PENDING');
  const after = readProWorkspace('9900');
  assert.equal(after.checkoutGeneration, 1, 'generation must advance so the old journal cannot block the new order');
  assert.equal(after.abandoned?.length, 1);
  assert.equal(after.abandoned[0].kind, 'PLACED_UNPAID');
  assert.equal(after.abandoned[0].orderId, ORDER_ID);
  assert.match(after.lastClosed.message, /apne aap cancel/);

  // 4) If the old order was actually PAID on Swiggy → never auto-close, 409 + PAID kept.
  await call('checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  seedWorkspace();
  placed = await place();
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const ws2 = readProWorkspace('9900');
  ws2.checkout.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeProWorkspace('9900', ws2);
  paymentResult = { paid: true, paymentVerified: true, swiggyOrderId: ORDER_ID };
  try {
    again = await place();
    assert.equal(again.status, 409);
    assert.match(JSON.stringify(again.body), /PAID/);
    assert.equal(readProWorkspace('9900').checkout.status, 'PAID', 'paid checkout must never be closed');
  } finally { paymentResult = { paid: false, paymentVerified: false }; }
});

test('Status check resolves no-orderId OUTCOME_UNKNOWN: no matching Swiggy order → auto-band + new Pay Now works; match found → orderId attached + live link', async () => {
  const place = async () => {
    const quote = readProWorkspace('9900').cart.quote;
    return call('checkout', { method: 'POST', body: { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt } });
  };
  const seedUnknown = () => {
    seedWorkspace();
    const ws = readProWorkspace('9900');
    ws.checkout = { id: '0', status: 'OUTCOME_UNKNOWN', orderId: '', amount: 150.25, accountKey: 'mine', accountPhone: '9123456789', createdAt: new Date(Date.now() - 10 * 60_000).toISOString(), message: 'Order Swiggy par ho sakta hai.' };
    writeProWorkspace('9900', ws);
  };
  // Case A: Swiggy order list verify hui, match nahi → local band; fresh Pay Now phir kaam kare.
  seedUnknown();
  ordersList = [];
  let st = await call('checkout/status', { method: 'POST', body: {} });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.checkout, null, 'verified no-order → local band, checkout null (no dead-end card)');
  assert.ok(st.body.closed?.message, 'closed record message present');
  let ws = readProWorkspace('9900');
  assert.equal(ws.checkout, null);
  assert.ok((ws.checkoutGeneration ?? 0) >= 1, 'generation advanced so the old journal cannot block');
  const placed = await place();
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(placed.body.checkout.status, 'PAYMENT_PENDING', 'after auto-band, new Pay Now works');

  // Case B: matching order found in Swiggy list → real orderId attached, live link available.
  await call('checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  seedUnknown();
  const created = new Date(Date.now() - 10 * 60_000).toISOString();
  ws = readProWorkspace('9900');
  ws.checkout.createdAt = created;
  writeProWorkspace('9900', ws);
  ordersList = [{ id: ORDER_ID, restaurant: 'Mock', status: 'Order placed', amount: 150.25, placedAt: new Date(Date.parse(created) + 60_000).toISOString(), items: [] }];
  try {
    st = await call('checkout/status', { method: 'POST', body: {} });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.checkout.orderId, ORDER_ID, 'discovery attached the real orderId');
    assert.notEqual(st.body.checkout.status, 'PAID', 'unpaid stays unpaid (no false PAID)');
    const track = await call('orders/tracking?id=' + encodeURIComponent(ORDER_ID) + '&scope=checkout');
    assert.equal(track.status, 200, JSON.stringify(track.body));
    assert.equal(track.body.tracking.trackingUrl, LIVE_LINK);
  } finally { ordersList = [placedOrder]; }
});

test('Old stuck checkouts never nag forever: unverified no-orderId → band; 15-min unpaid placed → band', async () => {
  let gen = 1000; // pin high generations so earlier tests' placement journals never collide
  // This file places many checkouts as user 9900; clear the checkout rate-limit bucket first.
  const db = getDb();
  db.config.rateLimits = {};
  saveDb(db);
  const seedUnknown = (ageMin) => {
    seedWorkspace();
    const ws = readProWorkspace('9900');
    ws.checkoutGeneration = gen;
    ws.checkout = { id: String(gen), status: 'OUTCOME_UNKNOWN', orderId: '', amount: 150.25, accountKey: 'mine', accountPhone: '9123456789', createdAt: new Date(Date.now() - ageMin * 60_000).toISOString(), message: 'Order Swiggy par ho sakta hai.' };
    writeProWorkspace('9900', ws);
  };
  const place = async () => {
    const quote = readProWorkspace('9900').cart.quote;
    return call('checkout', { method: 'POST', body: { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt } });
  };
  // Case C: order list fetch hi fail ho (account/session issue) — purana to band anyway.
  seedUnknown(10);
  ordersThrow = true;
  try {
    const st = await call('checkout/status', { method: 'POST', body: {} });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.checkout, null, 'unverified but old → local band, card will not come back');
    assert.ok(st.body.closed?.message);
    assert.equal(readProWorkspace('9900').checkout, null);
  } finally { ordersThrow = false; }

  // Case D: PAYMENT_PENDING with orderId, unpaid, 20 min old → band (Swiggy unpaid auto-cancels).
  seedWorkspace();
  let ws = readProWorkspace('9900');
  ws.checkoutGeneration = ++gen;
  writeProWorkspace('9900', ws);
  const placed = await place();
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(placed.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(placed.body.checkout.orderId, ORDER_ID);
  ws = readProWorkspace('9900');
  ws.checkout.createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
  writeProWorkspace('9900', ws);
  paymentResult = { paid: false, paymentVerified: false };
  const st = await call('checkout/status', { method: 'POST', body: {} });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.checkout, null, '20-min unpaid placed order → local band on status check');
  const after = readProWorkspace('9900');
  assert.equal(after.checkout, null);
  assert.equal(after.abandoned.at(-1).kind, 'PLACED_UNPAID');
  assert.equal(after.abandoned.at(-1).orderId, ORDER_ID);
  // Fresh unpaid placed order must NOT be banded by the status check.
  await call('checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  seedWorkspace();
  ws = readProWorkspace('9900');
  ws.checkoutGeneration = ++gen;
  writeProWorkspace('9900', ws);
  const placed2 = await place();
  assert.equal(placed2.status, 200, JSON.stringify(placed2.body));
  assert.equal(placed2.body.checkout.status, 'PAYMENT_PENDING');
  const st2 = await call('checkout/status', { method: 'POST', body: {} });
  assert.equal(st2.status, 200, JSON.stringify(st2.body));
  assert.equal(st2.body.checkout.status, 'PAYMENT_PENDING', 'fresh unpaid order must stay pending (user may be paying)');
  assert.ok(readProWorkspace('9900').checkout, 'fresh unpaid checkout must NOT be closed');
});
