// Boss (31-10-2026) round: shared operator IDs, used-ID warning, address/bill
// fixes, order-history privacy, aur UI polish. Ye OFFLINE test hai — fake
// provider, koi live Swiggy/Telegram/UPI call nahi hoti.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v93-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v93-offline-token', PRO_VAULT_KEY: 'v93-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', BOSS_ID: '9000', DB_ASYNC_WRITE: '0', NODE_ENV: 'test',
  ADMIN_TELEGRAM_USERNAME: '@admin_bhai'
});

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace, ensureProWorkspaceHydrated, getProVaultSource } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');

const db = getDb();
db.config.accounts = {
  // Operator ne upload kiya — sabko dikhega, par claim/remove sirf boss.
  acc_operator_used: { phone: '9876500001', name: 'Operator used', token: 'op-token-1', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 4 },
  acc_operator_fresh: { phone: '9876500002', name: 'Operator fresh', token: 'op-token-2', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0 },
  acc_operator_expired: { phone: '9876500003', name: 'Operator expired', isLoggedIn: true, isLoggedOut: true }
};
db.config.bossIds = ['9000'];
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const billStates = { mode: 'exact' };
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search() { return []; },
  async menu() { return { restaurant: { id: '123', name: 'R', isOpen: true }, categories: [{ title: 'All', items: [] }] }; },
  async quoteCart(_a, address) {
    const base = { itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, discount: 0, total: 335, coupon: '' };
    if (billStates.mode === 'gap') return { address, bill: { ...base, total: 350 }, ofoConfirmed: false };
    if (billStates.mode === 'below') return { address, bill: { ...base, total: 200 }, ofoConfirmed: false };
    return { address, bill: base, ofoConfirmed: false };
  },
  async orders() {
    return [{ id: '111111111111', restaurant: 'Example restaurant', status: 'DELIVERED', placedAt: '31/10/26', amount: 335, items: [{ name: 'Meal', qty: 1 }], address: 'Secret address of operator' }];
  },
  async tracking() { return { orderId: '111111111111', status: 'Delivered', trackingUrl: 'https://www.swiggy.com/orders/111111111111', deliveryOtp: '1234' }; }
};

const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: `User ${userId}` }), query_id: 'q' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
const user = sign(9101), other = sign(9102), boss = sign(9000);
async function req(auth, route, payload, method = payload === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/pro/api/' + route, {
    method,
    headers: { 'X-Telegram-Init-Data': auth, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}

function seedCart(userId, accountKey) {
  const quoteAt = new Date().toISOString();
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { [accountKey]: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: accountKey, selectedAddress: receiver, addressCandidates: [],
    cart: { restaurantId: '123', restaurantName: 'R', forSomeoneElse: false, items: [{ lineKey: 'l', id: '1', menu_item_id: 1, name: 'Meal', qty: 1, price: 274, variants: [], addons: [] }], quote: { total: 335, fetchedAt: quoteAt } }
  });
}

test('operator ke ID sabko dikhte hain, par claim/remove aur poora number sirf boss ka', async () => {
  const boot = await req(user, 'bootstrap');
  assert.equal(boot.status, 200);
  const keys = boot.body.accounts.map(a => a.key);
  assert.ok(keys.includes('acc_operator_used'));
  assert.ok(keys.includes('acc_operator_fresh'));
  assert.equal(keys.includes('acc_operator_expired'), false, 'logged-out ID list me nahi aani chahiye');
  const shared = boot.body.accounts.find(a => a.key === 'acc_operator_used');
  assert.equal(shared.owner, 'operator');
  assert.equal(shared.canClaim, false);
  assert.equal(shared.canRemove, false);
  assert.equal(shared.phone, '', 'shared ID ka poora number user ko nahi');
  assert.match(shared.phoneMasked, /^98/);
  assert.equal(JSON.stringify(boot.body).includes('op-token-1'), false, 'token kabhi client ko nahi');

  const bossBoot = await req(boss, 'bootstrap');
  const bossRow = bossBoot.body.accounts.find(a => a.key === 'acc_operator_used');
  assert.equal(bossRow.owner, 'operator');
  assert.equal(bossRow.phone, '9876500001', 'boss ko poora number dikhta hai');
  assert.equal(bossRow.canClaim, true);
  assert.equal(bossRow.canRemove, true);
});

test('user ka apna ID kisi doosre user ko nahi dikhta', async () => {
  await req(user, 'accounts/import', { session: { mobile: '9333344444', token: 'private-token-1', tid: 't1' } });
  const mine = (await req(user, 'bootstrap')).body.accounts.filter(a => a.owner === 'self');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].phone, '9333344444');
  const othersView = (await req(other, 'bootstrap')).body.accounts;
  assert.equal(othersView.some(a => a.phone === '9333344444'), false);
  assert.equal(JSON.stringify(othersView).includes('private-token-1'), false);
  assert.equal((await req(other, 'accounts/select', { key: mine[0].key })).status, 404);
});

test('operator ka ID user remove nahi kar sakta; apna kar sakta hai', async () => {
  const blocked = await req(user, 'accounts/remove', { key: 'acc_operator_fresh' });
  assert.equal(blocked.status, 403);
  assert.ok(Object.prototype.hasOwnProperty.call(getDb().config.accounts, 'acc_operator_fresh'));
  const mine = (await req(user, 'bootstrap')).body.accounts.find(a => a.owner === 'self');
  const removed = await req(user, 'accounts/remove', { key: mine.key });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.accounts.some(a => a.owner === 'self'), false);
});

test('used ID pehle warning deti hai, confirm ke baad select hoti hai; expired band rehti hai', async () => {
  const denied = await req(user, 'accounts/select', { key: 'acc_operator_used' });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'ACCOUNT_NEEDS_CONFIRM');
  assert.match(denied.body.error, /order ho chuke/i);
  const confirmed = await req(user, 'accounts/select', { key: 'acc_operator_used', confirmUsed: true });
  assert.equal(confirmed.status, 200);
  assert.equal(readProWorkspace('9101').activeAccountKey, 'acc_operator_used');
  // Busy/expired ID confirm ke baad bhi nahi.
  const expired = await req(user, 'accounts/select', { key: 'acc_operator_expired', confirmUsed: true });
  assert.equal(expired.status, 404);
});

test('shared ID par saved address list kisi user ko nahi dikhti — boss ko dikhti hai', async () => {
  await req(user, 'accounts/select', { key: 'acc_operator_fresh', confirmUsed: true });
  const userView = await req(user, 'addresses');
  assert.equal(userView.status, 200);
  assert.equal(userView.body.addresses.length, 0);
  assert.match(userView.body.note, /apna address link se add/i);
  await req(boss, 'accounts/select', { key: 'acc_operator_fresh' });
  const bossView = await req(boss, 'addresses');
  assert.equal(bossView.status, 200);
  assert.equal(bossView.body.addresses.length, 1);
  assert.equal(bossView.body.addresses[0].address, receiver.address);
});

test('shared ID ke order user ko chhote card me, boss ko poore detail me; tracking user ko band', async () => {
  await req(user, 'accounts/select', { key: 'acc_operator_fresh', confirmUsed: true });
  const compact = await req(user, 'orders');
  assert.equal(compact.status, 200);
  assert.equal(compact.body.detailAllowed, false);
  assert.equal(compact.body.orders[0].id, '111111111111');
  assert.deepEqual(compact.body.orders[0].items, []);
  assert.equal(compact.body.orders[0].address, '');
  assert.equal(compact.body.orders[0].restricted, true);
  const tracking = await req(user, 'orders/tracking?id=111111111111');
  assert.equal(tracking.status, 403);
  assert.equal(tracking.body.code, 'SHARED_ACCOUNT_RESTRICTED');

  await req(boss, 'accounts/select', { key: 'acc_operator_fresh' });
  const full = await req(boss, 'orders');
  assert.equal(full.body.detailAllowed, true);
  assert.equal(full.body.orders[0].items.length, 1);
  assert.equal(full.body.orders[0].address, 'Secret address of operator');
});

test('bill breakdown Swiggy screenshot jaisa: lines ka jod To Pay ke barabar, farak ho to sach', async () => {
  seedCart(9101, 'mine');
  let out = await req(user, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  assert.equal(out.status, 200);
  let quote = out.body.cart.quote;
  assert.equal(quote.total, 335);
  assert.equal(quote.itemTotal, 274);
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.taxesAndCharges, 61.08);
  assert.equal(quote.otherCharges, 0);
  assert.equal(quote.mismatch, false);
  // 274 + 0 + 61.08 = 335.08 vs total 335 -> 0.08 ka rounding farak chhupa nahi.
  assert.equal(Math.abs((quote.itemTotal + quote.deliveryFee + quote.taxesAndCharges) - quote.total) < 0.5, true);

  billStates.mode = 'gap';
  out = await req(user, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  quote = out.body.cart.quote;
  assert.equal(quote.otherCharges, 14.92);
  assert.equal(Number((quote.taxesAndCharges + quote.itemTotal + quote.deliveryFee).toFixed(2)), quote.total);

  billStates.mode = 'below';
  out = await req(user, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  quote = out.body.cart.quote;
  assert.equal(quote.mismatch, true);
  billStates.mode = 'exact';
});

test('admin contact bootstrap me aata hai (app ke andar se baat)', async () => {
  const boot = await req(user, 'bootstrap');
  assert.equal(boot.body.adminContact, 'admin_bhai');
});

test('vault backup hooks maujood hain aur local file ko overwrite nahi karte', async () => {
  seedCart(9103, 'mine');
  const before = readProWorkspace('9103').activeAccountKey;
  assert.equal(await ensureProWorkspaceHydrated('9103'), false);
  assert.equal(readProWorkspace('9103').activeAccountKey, before);
  assert.ok(getProVaultSource().length > 0);
  const src = fs.readFileSync(new URL('./swiggy-pro-store.js', import.meta.url), 'utf8');
  assert.match(src, /scheduleProWorkspaceBackup/);
  assert.match(src, /pullVaultTextFile/);
});

// ── Client/CSS: boss ke visual + "bahar mat jao" + lazy load points ────────
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');

test('Mini App se koi bahar navigation nahi (koi browser link nahi)', () => {
  assert.equal(/openExternal/.test(appSource), false);
  assert.equal(/swiggy\.com\/cart/.test(appSource), false);
  assert.equal(/swiggy\.com\/my-account/.test(appSource), false);
  assert.equal(/window\.open\(/.test(appSource), false);
  assert.match(appSource, /data-action="contact-admin"/);
  assert.match(appSource, /function contactAdmin\(\)/);
});

test('used ID par in-app warning aur confirm ke baad select', () => {
  assert.match(appSource, /ACCOUNT_NEEDS_CONFIRM/);
  assert.match(appSource, /Ye ID pehle use ho chuki hai/);
  assert.match(appSource, /confirmUsed: true/);
});

test('lazy load + skeleton + phone par data bacha rehne wala cache', () => {
  assert.match(appSource, /loading="lazy" decoding="async"/);
  assert.match(appSource, /skeletonRows/);
  assert.match(appSource, /pro-state-v2/);
  assert.match(appSource, /cachedAccounts/);
  assert.match(cssSource, /skeleton-sweep/);
  assert.match(cssSource, /prefers-reduced-motion/);
});

test('text box ka mota outline gaya, saaf focus ring aaya', () => {
  assert.match(cssSource, /input:focus,\s*input:focus-visible[^}]*outline:\s*0/);
  assert.match(cssSource, /\.input-wrap:focus-within\s*\{[^}]*box-shadow/);
  assert.equal(/outline:3px solid #38bdf8/.test(cssSource), true, 'purana rule file me hai — override neeche hona chahiye');
  const overrideIndex = cssSource.lastIndexOf('input:focus, input:focus-visible');
  const legacyIndex = cssSource.lastIndexOf('input:focus-visible{outline:3px');
  assert.ok(overrideIndex > legacyIndex, 'override baad me aana chahiye warna outline wapas');
});

// ── DOM: bill + used warning sach me dikhte hain ─────────────────────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function waitFor(fn, label) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('timeout: ' + label);
}
function harness({ responder }) {
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.scrollTo = () => {};
  window.Telegram = { WebApp: { initData: 'signed', ready() {}, expand() {}, openLink() {}, openTelegramLink() {} } };
  window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return response(responder(call));
  };
  window.eval(appSource);
  return { window, document: window.document, calls, close: () => window.close() };
}

const sharedAccount = { key: 'acc_operator_used', name: 'Operator used', phone: '', phoneMasked: '98••••0001', owner: 'operator', canClaim: false, canRemove: false, status: 'USED', selectable: false, needsConfirm: true, reason: 'Is ID par 4 order ho chuke hain', active: false, icons: '✔', freeCash: 0, offers: [] };
const ownAccount = { key: 'private_1', name: 'Mera', phone: '9123456789', phoneMasked: '', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, needsConfirm: false, active: true, icons: '★', freeCash: 50, offers: [] };
const billQuote = { total: 335, itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, taxesAndCharges: 61.08, discount: 0, otherCharges: 0, fetchedAt: '2026-10-31T00:00:00Z' };
function state(extra = {}) {
  return { ok: true, user: { name: 'Test', isBoss: false }, accounts: [ownAccount, sharedAccount], activeAccount: sharedAccount,
    selectedAddress: null, cart: { restaurantId: '1', restaurantName: 'R', forSomeoneElse: false, quote: billQuote, items: [{ lineKey: 'l', name: 'Meal', price: 274, qty: 1 }] },
    checkout: null, checkoutEnabled: true, adminContact: 'admin_bhai', ordersDetailAllowed: false, ...extra };
}

test('DOM: bill card me FREE delivery, GST & other charges aur To Pay dikhta hai', async () => {
  const app = harness({ responder: call => call.url.endsWith('/bootstrap') ? state() : state() });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.body.textContent.includes('To Pay'), 'bill');
    const text = app.document.body.textContent;
    assert.match(text, /Bill details/);
    assert.match(text, /FREE/);
    assert.match(text, /GST & other charges/);
    assert.match(text, /₹335/);
    assert.equal(/Open Swiggy/.test(text), false);
  } finally { app.close(); }
});

test('DOM: used ID par warning dialog, phir confirmUsed ke saath select', async () => {
  let selected = false;
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return state();
    if (call.url.endsWith('/accounts/select')) {
      if (call.body?.confirmUsed === true) { selected = true; return state({ accounts: [ownAccount, { ...sharedAccount, active: true }], activeAccount: sharedAccount }); }
      return { ok: false, code: 'ACCOUNT_NEEDS_CONFIRM', error: 'Is ID par 4 order ho chuke hain' };
    }
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-action="account-select"]'), 'used row');
    app.document.querySelector('[data-action="account-select"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'warning dialog');
    const text = app.document.querySelector('.confirm-dialog').textContent;
    assert.match(text, /Ye ID pehle use ho chuki hai/);
    assert.match(text, /4 order ho chuke/);
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => selected, 'confirmed select');
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).length, 2);
  } finally { app.close(); }
});
