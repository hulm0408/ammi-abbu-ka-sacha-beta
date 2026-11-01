// Offline fake-provider integration and fault-injection tests. They do NOT
// verify a live Telegram client, Swiggy login, order, payment, OFO or SMS.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-managed-offline-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:managed-offline-test-token', PRO_VAULT_KEY: 'offline-only-managed-vault-key',
  BOSS_ID: '9000', DB_ASYNC_WRITE: '0', PRO_ENABLE_CHECKOUT: '1', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '1', NODE_ENV: 'test'
});
const { clearDraft, getDb, saveDb, updateDraft } = await import('./store.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace, withProWorkspaceLock } = await import('./swiggy-pro-store.js');
const { beginChatSubmission, chatDraftFingerprint, finishChatSubmission, markChatHandoffPaid, readChatHandoff, readChatSubmissionGuard, releaseChatHandoff } = await import('./swiggy-pro-handoff.js');
const { readProAccountReservation, setProAccountReservationState } = await import('./swiggy-pro-reservations.js');
const { withSwiggyAccountLock, reserveSwiggyAccountAtomically } = await import('./swiggy-cart.js');
const { isAccountLockedForOtherOrder, sweepAccountLocks, lockAccountToOrder } = await import('./order-account-lock.js');
const { buildSimpleHomeScreen } = await import('./simple-chat.js');
const { executeSingleSwiggyPlacement } = await import('./swiggy-placement-journal.js');

const db = getDb();
db.config.accounts = {
  family_one: { id: 'family_one', phone: '9123456789', customerId: 'cust-one', name: 'PRIVATE OWNER NAME', isLoggedIn: true, token: 'do-not-expose-token-one', totalOrdersCount: 0, ordersVerifiedLive: true, orderCountSource: 'LIVE', orderTruthCheckedAt: new Date().toISOString() },
  family_two: { id: 'family_two', phone: '9234567890', customerId: 'cust-two', name: 'OWNER OTHER NAME', isLoggedIn: true, token: 'do-not-expose-token-two', totalOrdersCount: 0, ordersVerifiedLive: false },
  suspended: { id: 'suspended', phone: '9345678901', customerId: 'cust-three', isLoggedIn: true, token: 'do-not-expose-token-three', suspended: true },
};
saveDb(db);
const receiver = { id: '', name: 'Own receiver', mobile: '9456789012', address: 'Own private address, Test Road', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const orderId = '123456789012';
const foreignId = '123456789099';
const upi = 'upi://pay?pa=upiswiggy%40icici&pn=Swiggy&am=150.00&cu=INR&tr=offline-only';
const seen = { addresses: 0, group: [], resolves: [], quotes: 0, checkout: 0 };
let mode = 'success';
let holdQuote = null;
const provider = {
  async verifySession(a) { return { valid: true, phone: a.phone, customerId: a.customerId || 'verified-' + a.phone }; },
  async inspectAccount() { return { sessionState: 'VERIFIED', orderState: 'USED', ordersCount: 3, walletBalance: 25, currentCoupon: 'SAVE25', privateOtherAddress: 'NEVER OUTPUT' }; },
  async addresses() { seen.addresses++; return [{ ...receiver, address: 'OTHER USERS SECRET ADDRESS' }]; },
  async resolveAddress(_a, link) { seen.resolves.push(link); return { ...receiver }; },
  async groupCart(_a, _address, link) {
    seen.group.push(link);
    if (link.includes('fail-group')) throw Object.assign(new Error('Provider did not return a cart.'), { statusCode: 502 });
    return { restaurantId: '123', restaurantName: 'Offline Restaurant', items: [{ id: '456', menu_item_id: 456, name: 'Offline Meal', qty: 1, price: 125, variants: [], addons: [] }] };
  },
  async quoteCart(_a, address) {
    seen.quotes++;
    if (holdQuote) await holdQuote;
    return { address: { ...address, id: 'saved-by-provider' }, bill: { itemTotal: 125, deliveryFee: 20, taxes: 5, total: 150, coupon: '', walletBalance: 25 }, ofoConfirmed: false };
  },
  async checkout(_a, _address, _cart, placementKey) {
    if (mode === 'unknown') {
      return executeSingleSwiggyPlacement(placementKey, async () => { seen.checkout++; throw new Error('simulated timeout after POST'); });
    }
    const result = await executeSingleSwiggyPlacement(placementKey, async () => { seen.checkout++; return { placeRes: { ok: true, status: 200 }, json: { statusCode: 0, data: { order_id: orderId } } }; });
    assert.equal(result.placeRes.ok, true);
    return { orderId, upiIntentUrl: upi, paymentTxnId: 'test', ofoConfirmed: false };
  },
  async checkPayment() { return { paid: true, paymentVerified: true, swiggyOrderId: orderId, orderStatus: 'Confirmed' }; },
  async orders() { return [
    { id: foreignId, restaurant: 'OTHER CUSTOMER RESTAURANT', address: 'OTHER USERS SECRET ADDRESS', items: [] },
    { id: orderId, restaurant: 'Own order', address: receiver.address, items: [] }
  ]; },
  async tracking(_a, id) { return { orderId: id, status: 'Confirmed' }; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });
function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id: userId, first_name: 'Offline user' }), query_id: 'offline' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
async function req(user, route, body) {
  const response = await fetch(base + '/pro/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Telegram-Init-Data': sign(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function chatDraft(user, suffix = 'x') {
  return updateDraft(user, { cart: `https://swig.gy/gc/offline-${suffix}`, address: receiver.address, addressLink: `https://swiggy.onelink.me/abc/offline-${suffix}`, addressTyped: false, submitted: false, currentOrderId: null, addressDetails: receiver });
}
async function grant(user, key = 'family_one') {
  assert.equal((await req(9000, 'pool/user', { userId: String(user), allowed: true })).status, 200);
  assert.equal((await req(9000, 'pool/account', { key, allowed: true })).status, 200);
}
async function waitFor(fn) {
  for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for offline test condition.');
}
let aliceRef = '';

test('explicit user AND account grants isolate the vault and auto-select an available managed ID', async () => {
  const boss = await req(9000, 'bootstrap');
  assert.equal(boss.body.accounts.length, 3);
  assert.equal((await req(9003, 'bootstrap')).body.accounts.length, 0);
  assert.equal((await req(9003, 'pool/user', { userId: '9003', allowed: true })).status, 403);
  assert.equal((await req(9003, 'pool/account', { key: 'family_one', allowed: true })).status, 403);
  assert.equal((await req(9000, 'pool/user', { userId: '9001', allowed: true })).status, 200);
  assert.equal((await req(9001, 'bootstrap')).body.accounts.length, 0, 'no account is shared by default');
  assert.equal((await req(9000, 'pool/account', { key: 'family_one', allowed: true })).status, 200);
  const alice = await req(9001, 'bootstrap');
  assert.equal(alice.body.accounts.length, 1);
  assert.equal(alice.body.user.managedAccess, true);
  assert.equal(alice.body.activeAccount.managed, true);
  assert.match(alice.body.activeAccount.key, /^managed_/);
  assert.equal(alice.body.activeAccount.phone, '');
  assert.match(alice.body.activeAccount.phoneLabel, /6789$/);
  aliceRef = alice.body.activeAccount.key;
  for (const secret of ['do-not-expose-token-one', 'cust-one', 'PRIVATE OWNER NAME', '9123456789', 'family_one']) assert.equal(JSON.stringify(alice.body).includes(secret), false, secret);
  assert.equal((await req(9003, 'accounts/select', { key: aliceRef })).status, 404);
  assert.equal((await req(9001, 'accounts/select', { key: 'family_two' })).status, 404);
  assert.equal((await req(9001, 'accounts/remove', { key: aliceRef })).status, 403);
});

test('shared addresses and unrelated order history/tracking are not exposed', async () => {
  const addresses = await req(9001, 'addresses');
  assert.equal(addresses.status, 200); assert.deepEqual(addresses.body.addresses, []); assert.equal(seen.addresses, 0);
  let orders = await req(9001, 'orders');
  assert.deepEqual(orders.body.orders, []);
  assert.equal(JSON.stringify(orders.body).includes('OTHER USERS SECRET ADDRESS'), false);
  assert.equal((await req(9001, `orders/tracking?id=${foreignId}`)).status, 404);
  const ws = readProWorkspace('9001'); ws.managedOrderIds = { [aliceRef]: [orderId] }; writeProWorkspace('9001', ws);
  orders = await req(9001, 'orders');
  assert.deepEqual(orders.body.orders.map(o => o.id), [orderId]);
  assert.equal(JSON.stringify(orders.body).includes('OTHER CUSTOMER'), false);
  assert.equal((await req(9001, `orders/tracking?id=${orderId}`)).status, 200);
});

test('live-shaped checks show timestamped facts, not invented free cash or private fields', async () => {
  const out = await req(9001, 'accounts/check', { key: aliceRef });
  assert.equal(out.status, 200);
  assert.equal(out.body.activeAccount.orderState, 'USED');
  assert.equal(out.body.activeAccount.ordersCount, 3);
  assert.equal(out.body.activeAccount.walletBalance, 25);
  assert.ok(Date.parse(out.body.activeAccount.checkedAt));
  assert.equal(JSON.stringify(out.body).includes('NEVER OUTPUT'), false);
  assert.equal(JSON.stringify(out.body).includes('freeCash'), false);
});

test('chat button contains only a source marker; authenticated handoff imports only the owner’s draft', async () => {
  const draft = chatDraft(9001, 'alice');
  const screen = buildSimpleHomeScreen(draft, { miniAppUrl: 'https://example.test/pro' });
  const button = screen.keyboard.reply_markup.inline_keyboard.flat().find(b => b.web_app);
  assert.ok(button); assert.equal(button.text, 'Open Mini App');
  assert.equal(button.web_app.url, 'https://example.test/pro?from=chat');
  assert(!button.web_app.url.includes('swiggy') && !button.web_app.url.includes('9001'));
  assert(screen.keyboard.reply_markup.inline_keyboard.flat().some(b => b.callback_data), 'chat remains available');
  const out = await req(9001, 'chat-draft', {});
  assert.equal(out.status, 200);
  assert.equal(out.body.cart.items[0].name, 'Offline Meal');
  assert.equal(out.body.selectedAddress.name, receiver.name);
  assert.equal(out.body.selectedAddress.mobile, receiver.mobile);
  assert.equal(out.body.cart.forSomeoneElse, true);
  assert.equal(out.body.chatHandoff, true);
  assert.equal(JSON.stringify(out.body).includes(draft.addressLink), false);
  assert.equal(JSON.stringify(out.body).includes(draft.cart), false);
  assert.equal(readChatHandoff(9001).fingerprint, chatDraftFingerprint(draft));
  assert.equal((await req(9003, 'chat-draft', {})).status, 409);
  assert.equal(seen.resolves.at(-1), draft.addressLink);
  assert.equal(seen.group.at(-1), draft.cart);
  const workspaceFile = path.join(tmp, 'pro-workspaces', crypto.createHash('sha256').update('9001').digest('hex') + '.json');
  assert.equal(fs.readFileSync(workspaceFile, 'utf8').includes(receiver.mobile), false);
  // Chat submission and transfer take the same lock. A concurrent chat attempt
  // observes the durable ownership marker, never a fresh usable draft.
  let chatCreated = false;
  await withProWorkspaceLock('9001', async () => { if (!readChatHandoff('9001')) chatCreated = true; });
  assert.equal(chatCreated, false);
});

test('old nonterminal chat orders and linked drafts block transfer without relying on a 12-hour TTL', async () => {
  await grant(9006);
  chatDraft(9006, 'stale');
  const d = getDb(); d.orders['old-open'] = { id: 'old-open', userId: 9006, status: 'PAYMENT_PENDING', createdAt: '2020-01-01T00:00:00Z' }; saveDb(d);
  await req(9006, 'bootstrap');
  const out = await req(9006, 'chat-draft', {});
  assert.equal(out.status, 409); assert.equal(readChatHandoff(9006), null);
  const d2 = getDb(); d2.orders['old-open'].status = 'CANCELLED'; saveDb(d2);
  updateDraft(9006, { currentOrderId: 'missing-order' });
  assert.equal((await req(9006, 'chat-draft', {})).status, 409);
});

test('a crashed chat submission remains blocked until its order and consumed draft are durable', async () => {
  const user = 9011;
  await grant(user);
  await req(user, 'bootstrap');
  updateDraft(user, { cart: 'https://swig.gy/gc/guard', address: 'Private address' });
  beginChatSubmission(user, chatDraftFingerprint(getDb().drafts[String(user)]), 'chat-guard-1');
  assert.equal(readChatSubmissionGuard(user).orderId, 'chat-guard-1');
  assert.throws(() => finishChatSubmission(user, 'chat-guard-1'), /durably recorded/i);
  assert.ok(readChatSubmissionGuard(user));
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readChatSubmissionGuard} from './swiggy-pro-handoff.js'; console.log(Boolean(readChatSubmissionGuard(9011)));`], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0);
  assert.match(restarted.stdout, /true/);
  let res = await req(user, 'chat-draft', {});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /chat submission/i);
  const current = getDb();
  current.orders['chat-guard-1'] = { id: 'chat-guard-1', userId: user, status: 'PENDING', createdAt: new Date().toISOString() };
  saveDb(current);
  clearDraft(user);
  finishChatSubmission(user, 'chat-guard-1');
  assert.equal(readChatSubmissionGuard(user), null);
  assert.ok(JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8')).orders['chat-guard-1']);
  updateDraft(user, { cart: 'https://swig.gy/gc/guard', address: 'Private address' });
  res = await req(user, 'chat-draft', {});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /chat order is still open/i);
});

test('existing Mini App drafts survive auto-selection, replacement refusal and failed import', async () => {
  await grant(9007);
  const previous = { restaurantId: '999', restaurantName: 'Keep this draft', items: [{ lineKey: 'old', name: 'Keep', qty: 1 }], quote: null };
  writeProWorkspace('9007', { version: 1, accounts: {}, activeAccountKey: '', cart: previous, selectedAddress: receiver, pendingAddress: null, addressCandidates: [] });
  const initial = await req(9007, 'bootstrap');
  assert.equal(initial.body.activeAccount, null, 'bootstrap does not silently replace an existing address');
  assert.equal(initial.body.cart.restaurantName, 'Keep this draft');
  const ref = initial.body.accounts[0].key;
  const select = await req(9007, 'accounts/select', { key: ref });
  assert.equal(select.body.code, 'PRO_ACCOUNT_CHANGE_REQUIRES_CONFIRMATION');
  const confirmed = await req(9007, 'accounts/select', { key: ref, confirmClearAddress: true });
  assert.equal(confirmed.status, 200);
  chatDraft(9007, 'fail-group');
  const refusal = await req(9007, 'chat-draft', {});
  assert.equal(refusal.body.code, 'PRO_DRAFT_REPLACEMENT_REQUIRED');
  assert.equal(readChatHandoff(9007), null);
  const failed = await req(9007, 'chat-draft', { replace: true });
  assert.equal(failed.status, 502);
  assert.equal(readProWorkspace('9007').cart.restaurantName, 'Keep this draft');
  assert(readChatHandoff(9007));
  assert.equal((await req(9007, 'chat-draft/release', { confirmRelease: true })).status, 200);
  assert.equal(readProWorkspace('9007').cart.restaurantName, 'Keep this draft');
  assert.equal(readChatHandoff(9007), null);
});

test('durable shared-account reservation blocks concurrent app and chat use; preparation can be released', async () => {
  await grant(9002);
  await req(9002, 'bootstrap');
  chatDraft(9002, 'bob');
  assert.equal((await req(9002, 'chat-draft', {})).status, 200);
  let unblock;
  holdQuote = new Promise(resolve => { unblock = resolve; });
  const before = seen.quotes;
  const aliceSync = req(9001, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: true });
  await waitFor(() => seen.quotes > before);
  assert.equal(readProAccountReservation('family_one').state, 'PREPARING');
  assert.equal(reserveSwiggyAccountAtomically('family_one', 'chat-other'), false);
  await assert.rejects(withSwiggyAccountLock('family_one', async () => 'must not run'), e => e.code === 'PRO_ACCOUNT_RESERVED');
  assert.equal(isAccountLockedForOtherOrder(getDb(), 'family_one', 'no-such-chat-order').locked, true);
  assert.equal(lockAccountToOrder(getDb(), 'family_one', { id: 'chat-other' }).conflict, true);
  sweepAccountLocks(getDb(), { nowMs: Date.now() + 99 * 60 * 60 * 1000 });
  assert.equal(readProAccountReservation('family_one').state, 'PREPARING');
  assert.equal((await req(9002, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: true })).status, 409);
  unblock(); holdQuote = null;
  assert.equal((await aliceSync).status, 200);
  assert.equal((await req(9000, 'pool/user', { userId: '9001', allowed: false })).status, 409);
  assert.equal((await req(9001, 'accounts/release', { confirmRelease: true })).status, 200);
  assert.equal(readProAccountReservation('family_one'), null);
  assert.equal((await req(9002, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: true })).status, 200);
  assert.equal((await req(9002, 'accounts/release', { confirmRelease: true })).status, 200);
});

test('verified paid handoff consumes the chat copy and releases its ID', async () => {
  const q = await req(9001, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: true });
  assert.equal(q.status, 200);
  const before = seen.checkout;
  const out = await req(9001, 'checkout', { confirmCheckout: true, expectedTotal: q.body.cart.quote.total, quoteFetchedAt: q.body.cart.quote.fetchedAt });
  assert.equal(out.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(seen.checkout, before + 1);
  assert.equal(readProAccountReservation('family_one').state, 'UNRESOLVED');
  assert.equal((await req(9001, 'chat-draft/release', { confirmRelease: true })).status, 409);
  const status = await req(9001, 'checkout/status', {});
  assert.equal(status.body.checkout.status, 'PAID');
  assert.equal((await req(9001, 'checkout/finish', { confirmNewDraft: true })).status, 200);
  assert.equal(readProAccountReservation('family_one'), null);
  assert.equal(readChatHandoff(9001), null);
  assert.equal(getDb().drafts['9001'].cart, null);
  assert.equal((await req(9001, 'chat-draft', {})).status, 409);
});

test('a crash after the paid marker still consumes the matching chat draft on recovery', async () => {
  chatDraft(9010, 'recover');
  const { claimChatHandoff } = await import('./swiggy-pro-handoff.js');
  claimChatHandoff(9010, chatDraftFingerprint(getDb().drafts['9010']));
  markChatHandoffPaid(9010);
  releaseChatHandoff(9010);
  assert.equal(getDb().drafts['9010'].cart, null);
});

test('unknown placement keeps its account and chat draft locked across a restart', async () => {
  await grant(9004, 'family_two');
  const state = (await req(9004, 'bootstrap')).body;
  const second = state.accounts.find(a => a.phoneLabel?.endsWith('7890'));
  assert(second);
  assert.equal((await req(9004, 'accounts/select', { key: second.key })).status, 200);
  chatDraft(9004, 'unknown');
  assert.equal((await req(9004, 'chat-draft', {})).status, 200);
  const q = await req(9004, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: true });
  mode = 'unknown';
  const before = seen.checkout;
  const out = await req(9004, 'checkout', { confirmCheckout: true, expectedTotal: q.body.cart.quote.total, quoteFetchedAt: q.body.cart.quote.fetchedAt });
  assert.equal(out.body.checkout.status, 'OUTCOME_UNKNOWN');
  assert.equal(seen.checkout, before + 1);
  assert.equal((await req(9004, 'checkout', { confirmCheckout: true, expectedTotal: q.body.cart.quote.total, quoteFetchedAt: q.body.cart.quote.fetchedAt })).status, 409);
  assert.equal((await req(9004, 'accounts/release', { confirmRelease: true })).status, 409);
  assert.equal((await req(9004, 'chat-draft/release', { confirmRelease: true })).status, 409);
  assert.equal((await req(9000, 'pool/account', { key: 'family_two', allowed: false })).status, 409);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readProAccountReservation} from './swiggy-pro-reservations.js'; import {readChatHandoff} from './swiggy-pro-handoff.js'; if (readProAccountReservation('family_two')?.state !== 'UNRESOLVED' || !readChatHandoff('9004')) process.exit(2);`], { cwd: process.cwd(), env: process.env });
  assert.equal(child.status, 0, child.stderr.toString());
  assert.equal(isAccountLockedForOtherOrder(getDb(), 'family_two', 'stale-or-missing', { nowMs: Date.now() + 1e12 }).locked, true);
  await assert.rejects(withSwiggyAccountLock('family_two', async () => 'must not run'), e => e.code === 'PRO_ACCOUNT_RESERVED');
});

test('managed family UI has an ID dropdown, no OTP form and opens the chat cart with no link in the URL', async () => {
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/pro?from=chat', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.scrollTo = () => {};
  win.Telegram = { WebApp: { initData: 'offline-signed-data', ready() {}, expand() {} } };
  const account = { key: 'managed_ref', name: 'ID · ••••6789', phone: '', phoneLabel: '••••6789', managed: true, active: true, availability: 'NOT_CHECKED', orderState: 'USED', sessionState: 'VERIFIED', ordersCount: 3, walletBalance: 25, checkedAt: new Date().toISOString(), recordedOffers: [{ label: 'Breakfast', status: 'USED', checkedAt: new Date().toISOString() }] };
  const baseState = { ok: true, user: { isBoss: false, managedAccess: true, name: 'Family' }, accounts: [account], activeAccount: account, selectedAddress: null, pendingAddress: null, cart: null, checkout: null, checkoutEnabled: true, chatHandoff: false };
  const cart = { restaurantId: '123', restaurantName: 'Offline Restaurant', items: [{ lineKey: '1', name: 'Offline Meal', qty: 1, price: 125 }], quote: null, forSomeoneElse: true };
  const calls = [];
  win.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    const result = String(url).endsWith('/chat-draft') ? { ...baseState, cart, selectedAddress: receiver, chatHandoff: true } : baseState;
    return { ok: true, status: 200, json: async () => result };
  };
  try {
    win.eval(script);
    await waitFor(() => win.document.body.textContent.includes('Offline Meal'));
    assert(win.document.querySelector('select[data-action="account-dropdown"]'));
    assert.equal(win.document.querySelector('form[data-form="send-otp"]'), null);
    assert.equal(win.document.querySelector('form[data-form="import"]'), null);
    assert.equal(calls.filter(c => c.url.endsWith('/chat-draft')).length, 1);
    assert(!calls.some(c => c.url.includes('swiggy.onelink.me') || c.url.includes('swig.gy')));
    win.document.querySelector('[data-tab="accounts"]').click();
    assert(win.document.querySelector('s'), 'known used entries are struck out');
    assert.match(win.document.body.textContent, /not necessarily promotional Free Cash/i);
  } finally { win.close(); }
});
