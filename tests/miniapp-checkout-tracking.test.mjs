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
const fakeProvider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [receiver]; },
  async orders() { return ordersList; },
  async checkout() {
    return { orderId: ORDER_ID, upiIntentUrl: 'upi://pay?pa=upiswiggy%40icici&am=150.25&cu=INR&tr=offline', amount: 150.25 };
  },
  async checkPayment() { return { paid: false, paymentVerified: false }; },
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
