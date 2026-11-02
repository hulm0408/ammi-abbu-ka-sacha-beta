// Offline regression suite for the bill-generation bugs:
//  A) bill generation speed (single selected account, no fixed delays, bounded lock wait)
//  B) account lock safety (immediate / busy / timeout / concurrency / no bypass)
//  C) coupon-discount final-payable calculation (centralized helper + parser)
//  D) max-eligible-offer semantics (claimed != applied; no fabricated discounts)
//  E) QR generation ordering vs offer discovery / bill finalization
// No live Swiggy/Telegram/UPI request is made — fetch is mocked everywhere.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-regression-'));
Object.assign(process.env, {
  DATA_DIR: tmp,
  DB_FILE: path.join(tmp, 'db.json'),
  ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-bill-regression',
  BOSS_ID: '999',
  NODE_ENV: 'test',
  DB_ASYNC_WRITE: '0',
  SWIGGY_BLOCK_LIVE_ORDER_PLACE: '1'
});

const { computeFinalPayable } = await import('../checkout-total.js');
const {
  parseDapiCartPayload,
  applyMaxOfferToOrder,
  withSwiggyAccountLock,
  doesCouponMatchExpectedOrder,
  doesOrderBillMatchLiveCart,
  findBestMaxCouponAccountForOrder,
  selectSingleBillAccount,
  applyLiveFreeCashRelock
} = await import('../swiggy-cart.js');
const { getDb, saveDb } = await import('../store.js');
const { executeOrderBillSyncOnAccount, executeRealQrGenerationForOrder } = await import('../forwarded-order-flow.js');

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
function mockFetch(handler) { globalThis.fetch = handler; }
after(() => { globalThis.fetch = realFetch; });

const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567', exp: 1900000000 })).toString('base64url') + '.signature';
function makeAccount(key, phone) {
  return { isLoggedIn: true, token: `${key}-token`, tid: jwt, customerId: '1234567', cookies: `_session=${key}_unique;`, phone };
}
function seedAccounts(keys) {
  const db = getDb();
  db.config.accounts = {};
  for (const k of keys) db.config.accounts[k] = makeAccount(k, `900000000${keys.indexOf(k)}`);
  db.config.bossIds = [999];
  saveDb(db);
}
function seedOrder(id, extra = {}) {
  const db = getDb();
  db.orders = db.orders || {};
  db.orders[id] = {
    id,
    status: 'ACCEPTED',
    cardStage: 'COLLECTING',
    userId: '999',
    restaurantId: '201',
    items: [{ itemId: '9001', menu_item_id: 9001, name: 'Biryani', qty: 1, price: 500, lineTotal: 500 }],
    subtotal: 500,
    address: 'Test Road 1, Lucknow',
    addressDetails: { id: '', name: 'Receiver', mobile: '9234567890', address: 'Test Road 1', area: 'Area', city: 'Lucknow', lat: '26.8467', lng: '80.9462' },
    ...extra
  };
  saveDb(db);
  return db.orders[id];
}
const tgMock = new Proxy({}, { get: () => async () => ({ message_id: 1, chat: { id: 1 } }) });
const fmtFn = () => ({ text: 'card', keyboard: {} });

// ---------------------------------------------------------------- Test C ---
test('C1: computeFinalPayable — breakdown example gives ₹420', () => {
  const p = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20,
    deliveryFee: 30, taxesAndCharges: 10, swiggyOneMembershipFee: 0
  });
  assert.equal(p, 420);
});

test('C2: stale undiscounted order_total is NOT used when discounts are validated', () => {
  const p = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20,
    deliveryFee: 30, taxesAndCharges: 10, swiggyOneMembershipFee: 0,
    authoritativeTotal: 540 // 500+30+10 gross — discount NOT reflected
  });
  assert.equal(p, 420, 'must not return the undiscounted ₹540');
});

test('C3: authoritative total that already includes the discount is kept, not subtracted twice', () => {
  const p = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20,
    deliveryFee: 30, taxesAndCharges: 10,
    authoritativeTotal: 420
  });
  assert.equal(p, 420, 'must not become ₹300 (double discount)');
});

test('C4: lower authoritative total (extra discounts inside) is preserved', () => {
  const p = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20,
    deliveryFee: 30, taxesAndCharges: 10,
    authoritativeTotal: 390 // e.g. free delivery also applied upstream
  });
  assert.equal(p, 390);
});

test('C5: fallback reconstruction includes packing charges and clamps at 0', () => {
  const withPacking = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20,
    deliveryFee: 30, taxesAndCharges: 10, packingCharges: 10
  });
  assert.equal(withPacking, 430, 'packing must be counted (old code dropped it)');
  const overDiscounted = computeFinalPayable({ itemTotal: 100, couponDiscount: 200, deliveryFee: 0, taxesAndCharges: 0 });
  assert.equal(overDiscounted, 0, 'never negative');
});

test('C6: malformed authoritative totals (NaN / negative / null) fall back to breakdown', () => {
  for (const bad of [NaN, -5, null, undefined, 'abc']) {
    const p = computeFinalPayable({
      itemTotal: 500, couponDiscount: 100, deliveryFee: 30, taxesAndCharges: 10,
      authoritativeTotal: bad
    });
    assert.equal(p, 440, `authoritativeTotal=${bad} should be ignored`);
  }
});

test('C7: wallet split-pay is deducted exactly once', () => {
  const notYet = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20, deliveryFee: 30, taxesAndCharges: 10,
    authoritativeTotal: 420, walletSplitPayAmount: 50, walletAlreadyDeducted: false
  });
  assert.equal(notYet, 370);
  const already = computeFinalPayable({
    itemTotal: 500, couponDiscount: 100, tradeDiscountTotal: 20, deliveryFee: 30, taxesAndCharges: 10,
    authoritativeTotal: 370, walletSplitPayAmount: 50, walletAlreadyDeducted: true
  });
  assert.equal(already, 370, 'must not subtract wallet twice (₹320)');
});

// ------------------------------------------- Test C (parser integration) ---
function cartMeta(overrides = {}) {
  return {
    cartMeta: {
      address_id: 'addr-1', cartId: 'cart-1',
      restaurant_details: { id: '201', name: 'Mock' },
      cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Biryani', subtotal: 50000, final_price: 50000, addons: [], variants: [] }],
      item_total: 500,
      positiveDeliveryChargesExclusive: 30,
      total_tax: 10,
      ...overrides
    }
  };
}

test('C8: parser — stale undiscounted order_total yields discounted payable ₹420', () => {
  const parsed = parseDapiCartPayload(cartMeta({
    order_total: 540, // undiscounted gross; coupon IS valid below
    coupon_code: 'BEST100', is_coupon_valid: 1, coupon_discount_total: 100, coupon_discount_effective: 100,
    trade_discount_total: 20
  }));
  assert.equal(parsed.couponCode, 'BEST100');
  assert.equal(parsed.discountAmount, 100);
  assert.equal(parsed.finalPayable, 420, 'final payable must reflect the coupon, not the stale ₹540');
});

test('C9: parser — order_total that already includes the discount is kept (no double subtract)', () => {
  const parsed = parseDapiCartPayload(cartMeta({
    order_total: 420,
    coupon_code: 'BEST100', is_coupon_valid: 1, coupon_discount_total: 100,
    trade_discount_total: 20
  }));
  assert.equal(parsed.finalPayable, 420);
});

test('C10: parser — missing order_total falls back to breakdown INCLUDING packing', () => {
  const parsed = parseDapiCartPayload(cartMeta({
    coupon_code: 'BEST100', is_coupon_valid: 1, coupon_discount_total: 100,
    trade_discount_total: 20,
    total_packing_charges: 10
    // no order_total, no rendering grand_total
  }));
  // 500 - 100 - 20 + 30 delivery + 10 packing + 10 tax = 430
  assert.equal(parsed.finalPayable, 430);
});

test('C11: parser — wallet split-pay reduces the QR payable exactly once', () => {
  const parsed = parseDapiCartPayload(cartMeta({
    order_total: 420, user_swiggy_money: 50, swiggy_money: 0,
    coupon_code: 'BEST100', is_coupon_valid: 1, coupon_discount_total: 100,
    trade_discount_total: 20
  }));
  assert.equal(parsed.finalPayable, 370);
  const parsed2 = parseDapiCartPayload(cartMeta({
    order_total: 370, user_swiggy_money: 50, swiggy_money: 50, // already deducted upstream
    coupon_code: 'BEST100', is_coupon_valid: 1, coupon_discount_total: 100,
    trade_discount_total: 20
  }));
  assert.equal(parsed2.finalPayable, 370, 'must not become ₹320');
});

test('C12: applyMaxOfferToOrder — verified discounted total is kept; fallback counts packing+taxes', () => {
  const verified = applyMaxOfferToOrder({
    subtotal: 500, discountAmount: 100, tradeDiscountTotal: 20, deliveryFee: 30,
    taxesAndCharges: 10, packingCharges: 10, swiggyOneMembershipFee: 0, freeCashApplied: 0,
    swiggyVerified: true, finalPayable: 420
  });
  assert.equal(verified.finalPayable, 420, 'authoritative verified total must win');
  const local = applyMaxOfferToOrder({
    subtotal: 500, discountAmount: 100, tradeDiscountTotal: 20, deliveryFee: 30,
    taxesAndCharges: 10, packingCharges: 10, swiggyOneMembershipFee: 0, freeCashApplied: 0
  });
  assert.equal(local.finalPayable, 430, 'unverified fallback: 500-100-20+30+10+10');
});

// ---------------------------------------------------------------- Test D ---
test('D1: claimed-but-not-applied coupon does not match; no fabricated discount', () => {
  const parsed = parseDapiCartPayload(cartMeta({
    order_total: 540, coupon_code: 'BEST100', is_coupon_valid: 0, coupon_discount_total: 0
  }));
  assert.equal(parsed.couponCode, null, 'invalid coupon must not be reported as applied');
  assert.equal(parsed.suggestedCouponCode, 'BEST100');
  assert.equal(parsed.discountAmount, 0);
  assert.equal(parsed.finalPayable, 540, 'no discount may be fabricated');
  const order = { couponCode: 'BEST100', discountAmount: 100 };
  assert.equal(doesCouponMatchExpectedOrder(parsed, order), false, 'claimed != applied');
});

test('D2: bill/cart match guards — best applied offer reflected, stale bill rejected', () => {
  const cart = parseDapiCartPayload(cartMeta({
    order_total: 420, coupon_code: 'BEST100', is_coupon_valid: 1, coupon_discount_total: 100, trade_discount_total: 20
  }));
  const order = {
    couponCode: 'BEST100', discountAmount: 100, itemTotal: 500, tradeDiscountTotal: 20,
    freeCashApplied: 0, freeDeliveryDiscount: 0, deliveryFee: 30, swiggyOneMembershipFee: 0,
    packingCharges: 0, taxesAndCharges: 10, finalPayable: 420
  };
  assert.equal(doesCouponMatchExpectedOrder(cart, order), true);
  assert.equal(doesOrderBillMatchLiveCart(cart, order), true);
  const stale = { ...order, finalPayable: 540 }; // older undiscounted bill
  assert.equal(doesOrderBillMatchLiveCart(cart, stale), false, 'outdated bill must not match live cart');
  const changedCart = { ...cart, itemTotal: 600, finalPayable: 520 };
  assert.equal(doesOrderBillMatchLiveCart(changedCart, order), false, 'cart changed during discovery');
});

// ---------------------------------------------------------------- Test B ---
test('B1: lock is immediately available and returns fn result', async () => {
  const v = await withSwiggyAccountLock('b1-key', async () => 42, { maxWaitMs: 2000 });
  assert.equal(v, 42);
});

test('B2: busy lock is waited out (bounded), operations never overlap', async () => {
  const events = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const job = async (name, holdMs) => withSwiggyAccountLock('b2-key', async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    events.push(`start-${name}`);
    await new Promise((r) => setTimeout(r, holdMs));
    events.push(`end-${name}`);
    concurrent--;
  }, { maxWaitMs: 5000 });
  await Promise.all([job('a', 150), job('b', 50), job('c', 50)]);
  assert.equal(maxConcurrent, 1, 'no two operations on the same account may overlap');
  assert.deepEqual(events, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
});

test('B3: lock exceeding the configured timeout fails fast WITHOUT bypass', async () => {
  let innerRan = false;
  const release = await withSwiggyAccountLock('b3-key', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    return 'holder-done';
  }, { maxWaitMs: 5000 }).then((v) => v); // holder starts
  // NOTE: the line above awaits the holder; instead test properly below.
  assert.equal(release, 'holder-done');

  let holderResolve;
  const holder = withSwiggyAccountLock('b3-key', () => new Promise((r) => { holderResolve = r; }), { maxWaitMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(
    withSwiggyAccountLock('b3-key', async () => { innerRan = true; }, { maxWaitMs: 300 }),
    (err) => err.code === 'ACCOUNT_LOCK_TIMEOUT'
  );
  const waited = Date.now() - t0;
  assert.ok(waited < 1100, `should fail fast (~300ms), waited ${waited}ms`);
  assert.equal(innerRan, false, 'timed-out waiter must NEVER run its critical section');
  holderResolve('done');
  await holder;
  // Chain is intact after a timeout: a fresh caller can acquire the lock.
  const after = await withSwiggyAccountLock('b3-key', async () => 'ok-after', { maxWaitMs: 2000 });
  assert.equal(after, 'ok-after');
});

test('B4: ACCOUNT_LOCK_MAX_WAIT_MS env configures the default bounded wait', async () => {
  process.env.ACCOUNT_LOCK_MAX_WAIT_MS = '400';
  try {
    let holderResolve;
    const holder = withSwiggyAccountLock('b4-key', () => new Promise((r) => { holderResolve = r; }), { maxWaitMs: 5000 });
    const t0 = Date.now();
    await assert.rejects(
      withSwiggyAccountLock('b4-key', async () => 'x'), // no explicit maxWaitMs → env default
      (err) => err.code === 'ACCOUNT_LOCK_TIMEOUT'
    );
    assert.ok(Date.now() - t0 < 1500, 'env-configured bound must apply');
    holderResolve('done');
    await holder;
  } finally {
    delete process.env.ACCOUNT_LOCK_MAX_WAIT_MS;
  }
});

test('B5: re-entrant acquisition inside the same async context does not deadlock', async () => {
  const order = [];
  await withSwiggyAccountLock('b5-key', async () => {
    order.push('outer');
    await withSwiggyAccountLock('b5-key', async () => { order.push('inner'); }, { maxWaitMs: 1000 });
  }, { maxWaitMs: 1000 });
  assert.deepEqual(order, ['outer', 'inner']);
});

// ---------------------------------------------------------------- Test A ---
test('A1: selectSingleBillAccount — selected account wins; unavailable selection never falls back silently', () => {
  const entries = [['first', {}], ['selected', {}], ['third', {}]];
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'selected', activeKey: 'first' }), 'selected');
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'missing', activeKey: 'first' }), null);
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'selected', busyKeys: ['selected'] }), null);
  assert.equal(selectSingleBillAccount(entries, { activeKey: 'third' }), 'third');
});

test('A2: bill sync on the selected account never touches other accounts and has no fixed 25s/900ms stall', async () => {
  seedAccounts(['a2-first', 'a2-second']);
  seedOrder('a2-order', { selectedAccount: 'a2-second' });
  const requests = [];
  mockFetch(async (url, options = {}) => {
    requests.push({ url: String(url), headers: JSON.stringify(options.headers || {}) });
    return new Response(JSON.stringify({ statusCode: 1, statusMessage: 'session expired' }), { status: 401, headers: { 'content-type': 'application/json' } });
  });
  const t0 = Date.now();
  await assert.rejects(
    executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'a2-order', accKey: 'a2-second', formatOrderBodyFn: fmtFn })
  );
  const elapsed = Date.now() - t0;
  const allHeaders = requests.map((r) => r.headers).join('\n');
  assert.ok(requests.length > 0, 'selected account was contacted');
  assert.match(allHeaders, /a2-second_unique/);
  assert.doesNotMatch(allHeaders, /a2-first_unique/, 'no request may use another account\'s session');
  assert.ok(elapsed < 5000, `bill path must fail fast, took ${elapsed}ms (no 25s lock wait / fixed delays)`);
});

test('A3: busy selected-account lock → bounded ACCOUNT_LOCK_TIMEOUT (not 25s), safe retry afterwards', async () => {
  seedAccounts(['a3-first', 'a3-second']);
  seedOrder('a3-order', { selectedAccount: 'a3-second' });
  mockFetch(async () => new Response(JSON.stringify({ statusCode: 1, statusMessage: 'session expired' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  process.env.BILL_SYNC_LOCK_MAX_WAIT_MS = '500';
  try {
    let releaseHolder;
    const holder = withSwiggyAccountLock('a3-second', () => new Promise((r) => { releaseHolder = r; }), { maxWaitMs: 10_000 });
    const t0 = Date.now();
    await assert.rejects(
      executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'a3-order', accKey: 'a3-second', formatOrderBodyFn: fmtFn }),
      (err) => /busy|ACCOUNT_LOCK_TIMEOUT/i.test(String(err?.code || err?.message))
    );
    const waited = Date.now() - t0;
    assert.ok(waited < 5000, `lock wait must be bounded (~500ms configured), took ${waited}ms`);
    releaseHolder('done');
    await holder;
    // After the holder releases, the same bill sync can run again (safe retry, no deadlock).
    await assert.rejects(
      executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'a3-order', accKey: 'a3-second', formatOrderBodyFn: fmtFn })
    );
  } finally {
    delete process.env.BILL_SYNC_LOCK_MAX_WAIT_MS;
  }
});

test('A4: same order+account bill sync is deduped; a different account is refused while in flight', async () => {
  seedAccounts(['a4-first', 'a4-second']);
  seedOrder('a4-order', { selectedAccount: 'a4-second' });
  let releaseFetch;
  const gate = new Promise((r) => { releaseFetch = r; });
  mockFetch(async () => { await gate; return new Response(JSON.stringify({ statusCode: 1, statusMessage: 'session expired' }), { status: 401, headers: { 'content-type': 'application/json' } }); });
  const p1 = executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'a4-order', accKey: 'a4-second', formatOrderBodyFn: fmtFn });
  const p2 = executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'a4-order', accKey: 'a4-second', formatOrderBodyFn: fmtFn });
  assert.equal(p1, p2, 'identical in-flight bill sync must return the same promise (no duplicate bill requests)');
  await assert.rejects(
    executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'a4-order', accKey: 'a4-first', formatOrderBodyFn: fmtFn }),
    (err) => err.code === 'BILL_SYNC_IN_FLIGHT'
  );
  releaseFetch();
  await assert.rejects(p1);
  await assert.rejects(p2).catch(() => {});
});

test('A5: genuine failure on the chosen account → honest error, selected account unavailable never probes others', async () => {
  seedAccounts(['a5-first', 'a5-second']);
  const requests = [];
  mockFetch(async (url, options = {}) => {
    requests.push(JSON.stringify(options.headers || {}));
    throw new Error('network down');
  });
  const res = await findBestMaxCouponAccountForOrder({ id: 'a5-order', selectedAccount: 'missing' });
  assert.equal(res.code, 'SELECTED_ACCOUNT_UNAVAILABLE');
  assert.equal(requests.length, 0, 'no network call may be made for other accounts');
});

// ---------------------------------------------------------------- Test E ---
test('E1: bill sync is refused while a QR generation is in flight for the same order', async () => {
  seedAccounts(['e1-acc']);
  seedOrder('e1-order', { selectedAccount: 'e1-acc', finalPayable: 420, billShownAmount: 420 });
  let releaseQr;
  const qrGate = new Promise((r) => { releaseQr = r; });
  const qrPromise = executeRealQrGenerationForOrder({
    telegram: tgMock, chatId: 1, orderId: 'e1-order', formatOrderBodyFn: fmtFn,
    customRealQrGenerator: () => qrGate
  });
  // give the QR path a tick to enter the in-flight map
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'e1-order', accKey: 'e1-acc', formatOrderBodyFn: fmtFn })
  );
  releaseQr({ upiIntentUrl: 'upi://pay?pa=merchant@upi&pn=Test&am=420.00&cu=INR', amount: 420, swiggyOrderId: 'SW1', paymentTxnId: 'T1', restaurantName: 'Mock' });
  const qr = await qrPromise;
  assert.equal(Number(qr.realQr.amount), 420, 'QR amount must equal the verified bill');
  assert.equal(Number(qr.order.finalPayable), 420, 'displayed bill and QR amount cannot diverge');
});

test('E2: QR generation is refused while a bill sync is in flight (offer discovery finishes first)', async () => {
  seedAccounts(['e2-acc']);
  seedOrder('e2-order', { selectedAccount: 'e2-acc' });
  let releaseFetch;
  const gate = new Promise((r) => { releaseFetch = r; });
  mockFetch(() => gate.then(() => { throw new Error('network down'); }));
  const billPromise = executeOrderBillSyncOnAccount({ telegram: tgMock, chatId: 1, orderId: 'e2-order', accKey: 'e2-acc', formatOrderBodyFn: fmtFn });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    executeRealQrGenerationForOrder({ telegram: tgMock, chatId: 1, orderId: 'e2-order', formatOrderBodyFn: fmtFn, customRealQrGenerator: async () => ({ upiIntentUrl: 'upi://pay?pa=m@upi&am=1&cu=INR', amount: 1 }) }),
    (err) => String(err?.diag?.code || err?.code || err?.message).includes('BILL_SYNC_IN_FLIGHT')
  );
  releaseFetch();
  await assert.rejects(billPromise);
});

test('E4: optional offer claim never waits indefinitely — small claimWaitMs bounds the whole relock', async () => {
  seedAccounts(['e4-acc']);
  const order = seedOrder('e4-order', { selectedAccount: 'e4-acc', restaurantId: '201', campaignFreeCash: 0, freeCashApplied: 0 });
  order.addressDetails = { ...order.addressDetails, id: 'addr-1' };
  // events API hangs (worst case: WAF retry storm) — the relock must still return fast.
  mockFetch(async (url) => {
    if (String(url).includes('events.swiggy.com')) { await new Promise((r) => setTimeout(r, 30_000)); return new Response('slow', { status: 500 }); }
    if (String(url).includes('cart/client')) return new Response(JSON.stringify({ statusCode: 0, data: { cartMeta: { cartId: 'c1', address_id: 'addr-1', order_total: 500, item_total: 500, restaurant_details: { id: '201', name: 'M' }, cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'X', subtotal: 50000, final_price: 50000 }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ statusCode: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const t0 = Date.now();
  const out = await applyLiveFreeCashRelock(db_account('e4-acc'), order, { claimWaitMs: 300 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `optional offer wait must be bounded by claimWaitMs, took ${elapsed}ms`);
  assert.equal(out.applied, false, 'a hung claim must not fabricate a discount');
  assert.ok(out.reason, 'honest reason is reported');
});

function db_account(key) { return getDb().config.accounts[key]; }

test('E3: duplicate QR generation for one order is deduped (no duplicate checkout/placement)', async () => {
  seedAccounts(['e3-acc']);
  seedOrder('e3-order', { selectedAccount: 'e3-acc', finalPayable: 100, billShownAmount: 100 });
  let releaseQr;
  const qrGate = new Promise((r) => { releaseQr = r; });
  const gen = () => qrGate;
  const q1 = executeRealQrGenerationForOrder({ telegram: tgMock, chatId: 1, orderId: 'e3-order', formatOrderBodyFn: fmtFn, customRealQrGenerator: gen });
  const q2 = executeRealQrGenerationForOrder({ telegram: tgMock, chatId: 1, orderId: 'e3-order', formatOrderBodyFn: fmtFn, customRealQrGenerator: gen });
  assert.equal(q1, q2, 'same in-flight QR generation must return the same promise');
  releaseQr({ upiIntentUrl: 'upi://pay?pa=merchant@upi&pn=Test&am=100.00&cu=INR', amount: 100, swiggyOrderId: 'SW2', paymentTxnId: 'T2', restaurantName: 'Mock' });
  const qr = await q1;
  assert.equal(qr.realQr.swiggyOrderId, 'SW2');
  await q2;
});

test('C15: Diya cash in eligible wallet alias reduces payable once even when legacy balance is zero', () => {
  const parsed = parseDapiCartPayload({ cartMeta: {
    item_total: 230, order_total: 270, user_swiggy_money: 0, swiggy_pay_eligible_balance: 10,
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, subtotal: 23000, final_price: 23000 }]
  } });
  assert.equal(parsed.freeCashBalance, 10);
  assert.equal(parsed.walletSplitPayAmount, 10);
  assert.equal(parsed.finalPayable, 260);
});

test('C16: balance not eligible for this cart must not be presented as applied', () => {
  const parsed = parseDapiCartPayload({ cartMeta: {
    item_total: 230, order_total: 270, user_swiggy_money: 10, swiggy_pay_eligible_balance: 0,
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, subtotal: 23000, final_price: 23000 }]
  } });
  assert.equal(parsed.walletSplitPayAmount, 0);
  assert.equal(parsed.finalPayable, 270);
});

test('C17: zero primary reward field does not hide a validated savings alias', () => {
  const parsed = parseDapiCartPayload({ cartMeta: {
    item_total: 230, order_total: 260, trade_discount_total: 10, trade_discount_reward_amount: 0,
    offer_presentation_info: { reward_offer_savings_info: { savings: 10 } },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, subtotal: 23000, final_price: 23000 }]
  } });
  assert.equal(parsed.campaignFreeCash, 10);
  assert.equal(parsed.finalPayable, 260);
});

test('C18: stale cart total does not mask a reward just because wallet split-pay is present', () => {
  assert.equal(computeFinalPayable({ itemTotal: 230, tradeDiscountTotal: 10,
    taxesAndCharges: 40, independentTaxesAndCharges: 40,
    authoritativeTotal: 270, walletSplitPayAmount: 10 }), 250);
});


test('C19: missing wallet eligibility is not presented as an explicit Swiggy denial', () => {
  const base = { item_total: 230, order_total: 270,
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, subtotal: 23000, final_price: 23000 }] };
  const unknown = parseDapiCartPayload({ cartMeta: base });
  const ineligible = parseDapiCartPayload({ cartMeta: { ...base, user_swiggy_money: 10, swiggy_pay_eligible_balance: 0 } });
  assert.equal(unknown.swiggyMoneyEligibilityReported, false);
  assert.equal(unknown.swiggyMoneyBalanceReported, false);
  assert.equal(ineligible.swiggyMoneyEligibilityReported, true);
  assert.equal(ineligible.swiggyMoneyBalanceReported, true);
  assert.equal(ineligible.walletSplitPayAmount, 0);
});


test('C20: secondary wallet balance survives a zero primary field but cannot override eligibility', () => {
  const base = { item_total: 230, order_total: 270, user_swiggy_money: 0,
    user_swiggy_money_balance: 10,
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, subtotal: 23000, final_price: 23000 }] };
  const unknown = parseDapiCartPayload({ cartMeta: base });
  assert.equal(unknown.reportedSwiggyMoneyBalance, 10);
  assert.equal(unknown.swiggyMoneyBalanceReported, true);
  assert.equal(unknown.swiggyMoneyEligibilityReported, false);
  assert.equal(unknown.walletSplitPayAmount, 10);
  assert.equal(unknown.finalPayable, 260);
  const ineligible = parseDapiCartPayload({ cartMeta: { ...base, swiggy_pay_eligible_balance: 0 } });
  assert.equal(ineligible.reportedSwiggyMoneyBalance, 10);
  assert.equal(ineligible.walletSplitPayAmount, 0);
  assert.equal(ineligible.finalPayable, 270);
});
