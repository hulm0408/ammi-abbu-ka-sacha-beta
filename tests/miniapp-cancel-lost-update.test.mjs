// Offline regression: "cancel dabaya, order archive hua, naya order karo to
// 'ek order pending hai' aata hai." Root cause: cancel workspace lock ke bahar
// chalta hai, aur us waqt chal rahe lock-holder (menu / coupons / cart sync)
// apna PURANA workspace snapshot likh dete the — checkout wapas aa jata tha.
// Fake provider only. No Swiggy, UPI or real order is contacted.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-cancel-lost-update-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:cancel-lost-update-token', PRO_VAULT_KEY: 'cancel-lost-update-vault-key-1234',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
const { handleSwiggyProHttp } = await import('../swiggy-pro-api.js');
const { writeProWorkspace, readProWorkspace } = await import('../swiggy-pro-store.js');

const ORDER = '252593787174904';
const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const quote = { total: 352, itemTotal: 342, deliveryFee: 28, taxes: 32, discount: 50, coupon: 'TRYNEW', freeCash: 50, fetchedAt: new Date().toISOString() };
const cart = { restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false, items: [{ lineKey: 'l', name: 'Paneer', price: 230, qty: 1, isVeg: true }], quote };

let holdPayment = false;
let releasePayment = null;
let slowMenu = false;
let releaseMenu = null;
const provider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [address]; },
  async orders() { return []; },
  async quoteCart() { return { address, bill: { total: 352 } }; },
  async checkPayment() {
    if (holdPayment) await new Promise(resolve => { releasePayment = resolve; });
    return { paid: false, paymentVerified: false };
  },
  async menu() {
    if (slowMenu) await new Promise(resolve => { releaseMenu = resolve; });
    return { restaurant: { id: '201', name: 'Paneer Palace', area: 'A', time: '30', image: '', rating: '4' }, categories: [], items: [] };
  },
  async tracking(_account, orderId) { return { orderId, status: 'Confirmed', trackingUrl: '', via: '', tried: [] }; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  releasePayment?.(); releaseMenu?.();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'U' }), query_id: 'q' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
async function call(userId, route, { method = 'GET', body } = {}) {
  const res = await fetch(base + '/pro/api/' + route, {
    method, headers: { 'X-Telegram-Init-Data': sign(userId), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function seed(userId) {
  writeProWorkspace(userId, {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: address, addressCandidates: [], checkoutGeneration: 0, cart,
    checkout: {
      id: '0', checkoutToken: 'tok-1', status: 'PAYMENT_PENDING', accountKey: 'mine', accountPhone: '9123456789',
      accountCustomerId: 'c-9123456789', orderId: ORDER, paymentTxnId: 'txn-1', amount: 352, restaurantName: 'Paneer Palace',
      createdAt: new Date().toISOString(), upiIntentUrl: 'upi://pay?pa=x&am=352', qrDataUrl: 'data:image/png;base64,AAAA'
    }
  });
}

test('cancel ke baad checkout wapas nahi aata (seedha cancel)', async () => {
  const U = '7911'; seed(U);
  const c = await call(U, 'checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  assert.equal(c.status, 200);
  assert.equal(readProWorkspace(U).checkout, null, 'checkout band');
  assert.equal(readProWorkspace(U).checkoutGeneration, 1, 'generation aage badha');
});

test('cancel ke baad bhi payment poll checkout wapas nahi laata', async () => {
  const U = '7912'; seed(U);
  holdPayment = true;
  const poll = call(U, 'checkout/status', { method: 'POST', body: {} });
  poll.catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const c = await call(U, 'checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  assert.equal(c.status, 200, 'cancel poll ke peeche nahi atakta');
  holdPayment = false; releasePayment();
  await poll;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(readProWorkspace(U).checkout, null, 'poll ke baad bhi checkout null');
});

test('cancel ke baad slow menu request ka purana snapshot checkout wapas nahi laata', async () => {
  const U = '7913'; seed(U);
  slowMenu = true;
  const menu = call(U, 'menu?id=201');
  menu.catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const c = await call(U, 'checkout/cancel', { method: 'POST', body: { confirmCancel: true } });
  assert.equal(c.status, 200);
  slowMenu = false; releaseMenu();
  const m = await menu;
  assert.equal(m.status, 200, 'menu response theek');
  await new Promise(r => setTimeout(r, 200));
  const saved = readProWorkspace(U);
  assert.equal(saved.checkout, null, 'stale menu write ne cancel nahi palta');
  assert.equal(saved.checkoutGeneration, 1, 'generation cancel wala rahe');
  assert.equal(saved.menu?.restaurant?.id, '201', 'menu write fir bhi save hua');
});
