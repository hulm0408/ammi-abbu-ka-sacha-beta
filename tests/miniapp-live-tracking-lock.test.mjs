// Offline regression: live checkout ka tracking link lookup checkout/status poll
// ke peeche queue na ho. Scenario: payment poll Swiggy ke payment check me atka
// hai (workspace lock pakde hue), user ka tracking request aata hai — use turant
// jawab milna chahiye aur link checkout record me save hona chahiye.
// Fake provider only. No Swiggy, UPI or real order is contacted.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-live-tracking-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:live-tracking-offline-token', PRO_VAULT_KEY: 'live-tracking-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
const { handleSwiggyProHttp } = await import('../swiggy-pro-api.js');
const { writeProWorkspace, readProWorkspace } = await import('../swiggy-pro-store.js');

const USER = '7902';
const ORDER = '252593787174904';
const TRACK = 'https://www.swiggy.com/ofo/track/r9iLOAKbmCHg';
const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
let releasePayment = () => {};
const provider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [address]; },
  async orders() { return []; },
  async quoteCart() { return { address, bill: { total: 352 } }; },
  // Swiggy payment check dheere chalta hai: poll is promise par atakta hai.
  async checkPayment() { await new Promise(resolve => { releasePayment = resolve; }); return { paid: false, paymentVerified: false }; },
  async tracking(_account, orderId) { return { orderId, status: 'Confirmed', trackingUrl: TRACK, via: 'FYI_CTA', tried: [], attempts: 1 }; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { releasePayment(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'U' }), query_id: 'q' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
async function call(route, { method = 'GET', body } = {}) {
  const res = await fetch(base + '/pro/api/' + route, {
    method, headers: { 'X-Telegram-Init-Data': sign(USER), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

writeProWorkspace(USER, {
  version: 1,
  accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' } },
  activeAccountKey: 'mine', selectedAddress: address, addressCandidates: [], checkoutGeneration: 0,
  checkout: {
    id: '0', checkoutToken: 'tok-live', status: 'PAYMENT_PENDING', accountKey: 'mine', accountPhone: '9123456789',
    accountCustomerId: 'c-9123456789', orderId: ORDER, paymentTxnId: 'txn-1', amount: 352, restaurantName: 'Test',
    createdAt: new Date().toISOString(), upiIntentUrl: 'upi://pay?pa=x&am=352', qrDataUrl: 'data:image/png;base64,AAAA'
  },
  cart: null
});

test('payment poll atka ho to bhi live tracking link turant aata hai aur save hota hai', async () => {
  // 1) Payment poll shuru — ye Swiggy ke payment check me atak jata hai (lock pakad ke).
  const poll = call('checkout/status', { method: 'POST', body: {} });
  poll.catch(() => {});
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    // 2) User ka tracking request — lock ke bahar chalna chahiye.
    const started = Date.now();
    const tracking = await call(`orders/tracking?id=${ORDER}&scope=checkout`);
    const elapsed = Date.now() - started;
    assert.equal(tracking.status, 200, 'tracking 200');
    assert.equal(tracking.body.tracking?.trackingUrl, TRACK, 'live link mila');
    assert.ok(elapsed < 3000, `tracking poll ke peeche queue nahi hona chahiye (${elapsed}ms)`);
  } finally {
    // 3) Payment poll ko chhodo — ab lock khulega, pending save bhi hoga.
    releasePayment();
  }
  const pollOut = await poll;
  assert.equal(pollOut.status, 200);
  assert.equal(pollOut.body.checkout?.status, 'PAYMENT_PENDING');
  // 4) Link checkout record me save hua (reload ke baad bhi rahe).
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && readProWorkspace(USER).checkout?.tracking?.trackingUrl !== TRACK) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(readProWorkspace(USER).checkout?.tracking?.trackingUrl, TRACK, 'link checkout record me save');
});

test('live checkout tracking ka token/ID mismatch ho to lock-bypass nahi, purana behaviour', async () => {
  // Doosre order ID ka tracking checkout-scope me live ID se match nahi karta;
  // route pehle jaisa hi chalta hai (orders list check ke saath).
  const other = await call('orders/tracking?id=252593787170000&scope=checkout');
  assert.notEqual(other.status, 200, 'unrelated order checkout scope me track nahi hona chahiye');
});

test('client: tracking refresh ka timeout hai — "link aa raha hai…" hamesha ke liye na atke', async () => {
  const app = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');
  const start = app.indexOf('async function refreshCheckoutTracking()');
  const end = app.indexOf('function maybeCheckoutTracking()');
  assert.ok(start > 0 && end > start, 'refreshCheckoutTracking mila');
  const fn = app.slice(start, end);
  assert.match(fn, /api\('orders\/tracking\?id=' \+ encodeURIComponent\(orderId\) \+ '&scope=checkout', 'GET', undefined, \{ timeoutMs: 30000 \}\)/);
  assert.match(fn, /e\?\.name === 'TimeoutError'/);
  assert.match(fn, /finally \{[\s\S]*checkoutTrackBusy = false/);
});
