import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eligibleWalletBalance, verifiedOrderHistory, freeCashStatus } from './checkout-eligibility.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-eligibility-'));
process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';
process.env.DATA_DIR = temp;
process.env.DB_FILE = path.join(temp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(temp, 'accounts.json');
const good = orders => ({ ok: true, status: 200, json: { statusCode: 0, data: { orders } } });
let checks = 0;
function check(value, expected, label) { assert.deepEqual(value, expected, label); checks++; }
try {
  check(eligibleWalletBalance({ user_swiggy_money: 100, swiggy_pay_eligible_balance: 25 }), 25, 'eligible portion, not total balance');
  check(eligibleWalletBalance({ user_swiggy_money: 100, swiggy_pay_eligible_balance: 0 }), 0, 'explicit ineligible zero');
  check(eligibleWalletBalance({ user_swiggy_money: 50 }), 50, 'legacy cart balance');
  check(eligibleWalletBalance({ swiggy_pay_eligible_balance: '25.50' }), 25.5, 'numeric string');
  check(eligibleWalletBalance({ swiggy_pay_eligible_balance: 'invalid' }), 0, 'bad balance');
  check(verifiedOrderHistory({}, null, null).isZeroOrderAccount, false, 'network failure is not unused');
  check(verifiedOrderHistory({ totalOrdersCount: 0 }, null, null).isZeroOrderAccount, false, 'imported zero not proof');
  check(verifiedOrderHistory({}, good([]), null).isZeroOrderAccount, false, 'partial history not proof');
  check(verifiedOrderHistory({}, { json: { statusCode: 0, data: {} } }, good([])).isZeroOrderAccount, false, 'missing orders array not empty history');
  check(verifiedOrderHistory({}, good([]), good([])).isZeroOrderAccount, true, 'both verified empty histories');
  const used = { order_id: '123', order_status: 'delivered' };
  check(verifiedOrderHistory({}, good([used]), good([used])).totalOrdersCount, 1, 'deduplicate');
  check(verifiedOrderHistory({}, good([{ order_id: '456', order_status: 'cancelled' }]), good([])).isZeroOrderAccount, false, 'previously placed cancelled order is not unused');
  check(verifiedOrderHistory({ cachedTotalOrdersCount: 3, totalOrdersCount: 0 }, good([]), good([])).totalOrdersCount, 3, 'empty recent page does not erase usage');
  check(verifiedOrderHistory({ totalOrdersCount: 999999 }, good([]), good([])).totalOrdersCount, 0, 'unknown sentinel can resolve to verified unused');

  check(freeCashStatus({ freeCashApplied: 25 }), '', 'no missing cash warning when applied');
  check(freeCashStatus({}, { lateNight: { slotState: 'LOCKED_FOR_TODAY' } }).includes('abhi active nahi'), true, 'booked is not active');
  check(freeCashStatus({}, { lateNight: { slotState: 'ACTIVE_NOW' } }).includes('minimum spend'), true, 'active claim is not proof of cart discount');
  let historyOrders = [];
  let malformed = false;
  let reads = 0;
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ user_id: '112233', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.sig';
  globalThis.fetch = async url => {
    assert.match(String(url), /\/dapi\/order\/all/, 'no live calls or checkout probe allowed in these cases');
    reads++;
    const json = { statusCode: 0, tid: jwt, data: malformed ? {} : { orders: historyOrders } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json), json: async () => json };
  };
  const { getDb, saveDb } = await import('./store.js');
  const { inspectAccountOrderHistoryAndOffers, invalidateAccountOrderProfileCache,
    findBestMaxCouponAccountForOrder, parseDapiCartPayload, getBusySwiggyAccountsMap } = await import('./swiggy-cart.js');
  const account = { id: 'acc_test', phone: '9000000002', isLoggedIn: true, tid: jwt,
    cookies: `_session_tid=test; tid=${jwt}; token=test`, token: 'test', customerId: '112233',
    totalOrdersCount: 0, cachedTotalOrdersCount: 0, ordersVerifiedLive: true };
  const db = getDb();
  db.config.accounts = { acc_test: account };
  db.orders = {};
  saveDb(db);
  let profile = await inspectAccountOrderHistoryAndOffers('acc_test', account, { force: true });
  check(profile.isZeroOrderAccount, true, 'live empty history');
  historyOrders = [used];
  invalidateAccountOrderProfileCache('acc_test');
  profile = await inspectAccountOrderHistoryAndOffers('acc_test', account);
  check(profile.totalOrdersCount, 1, 'cache invalidation uses composite keys; no permanent imported fast-path');
  check(profile.isZeroOrderAccount, false, 'used account loses zero badge');
  check(reads >= 5, true, 'history actually fetched again');
  let selection = await findBestMaxCouponAccountForOrder({ id: 'ORD_TEST' });
  check(selection.code, 'NO_VERIFIED_UNUSED_ACCOUNTS', 'auto-select refuses used-only vault');
  const stale = getDb();
  const updated = getDb();
  updated.config.accounts.acc_test.totalOrdersCount = 2;
  saveDb(updated);
  stale.config.accounts.acc_test.offers = { updated: true };
  stale.config.accounts.acc_test.totalOrdersCount = 0;
  stale.config.accounts.acc_test.cachedTotalOrdersCount = 0;
  saveDb(stale);
  check(getDb().config.accounts.acc_test.totalOrdersCount, 2, 'stale profile cannot reset used account');

  const unknownDb = getDb();
  unknownDb.config.accounts = { acc_unknown: { ...account, id: 'acc_unknown', phone: '9000000003', totalOrdersCount: 0, cachedTotalOrdersCount: 0 } };
  saveDb(unknownDb);
  malformed = true;
  selection = await findBestMaxCouponAccountForOrder({ id: 'ORD_UNKNOWN' });
  check(selection.code, 'NO_VERIFIED_UNUSED_ACCOUNTS', 'malformed history never auto-selects imported zero');

  const cart = { order_total: 80, item_total: 203, user_swiggy_money: 100, swiggy_pay_eligible_balance: 25,
    trade_discount_total: 25, trade_discount_reward_amount: 25 };
  let parsed = parseDapiCartPayload(cart);
  check(parsed.walletSplitPayAmount, 25, 'bill uses eligible wallet');
  check(parsed.finalPayable, 55, 'bill deducts eligible split only once');
  check(parsed.freeCashApplied, 50, 'campaign cash plus eligible wallet');
  parsed = parseDapiCartPayload({ ...cart, swiggy_pay_eligible_balance: 0 });
  check(parsed.finalPayable, 80, 'ineligible wallet not shown as applied');
  parsed = parseDapiCartPayload({ ...cart, order_total: 55, swiggy_money: 25 });
  check(parsed.finalPayable, 55, 'already deducted wallet not deducted twice');
  parsed = parseDapiCartPayload({ ...cart, swiggy_pay_eligible_balance: 100 });
  check(parsed.finalPayable, 0, 'wallet-only zero does not fall back to full price');
  const busy = getBusySwiggyAccountsMap({ orders: { hold: { id: 'hold', selectedAccount: 'acc_test', status: 'APPROVAL_PENDING', cardStage: 'WAITING_APPROVAL' } } });
  check(busy.has('acc_test'), true, 'approval/payment stages keep accounts busy');

  for (const file of ['swiggy-cart.js', 'bossbot/vendor/swiggy-cart.js']) {
    const source = fs.readFileSync(file, 'utf8');
    check(/send(?:NativeAndroid|WebPayments)PlaceOrder\(0\)/.test(source), false, 'no silent full-price wallet fallback');
    check(source.includes('new Promise(r => setTimeout(r, 450))'), false, 'no claim/cart race');
  }
  check(fs.readFileSync('checkout-eligibility.js', 'utf8'), fs.readFileSync('bossbot/vendor/checkout-eligibility.js', 'utf8'), 'standalone rules match');
  console.log(`PASS: ${checks} checkout eligibility, history, cache, used-account, busy-account, wallet and fallback checks (offline)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
