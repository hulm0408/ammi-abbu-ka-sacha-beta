/**
 * v54 — "WO KISI BHI ID SE ORDER NIKAAL SAKTA HAI TO TU KIU NAHI"
 *
 * Proves the any-ID contract on a pasted numeric Swiggy order id:
 *   1. An ID flagged `sessionExpired` / `isLoggedOut` (STALE flags) is still asked
 *      when the user pastes the id — flags are hints, not facts.
 *   2. An order that is NOT on page 1 of `order/all` is found on page 2.
 *   3. A WAF cooldown set by background sweeps does not answer "not found" to a
 *      human: the user-initiated scan bypasses it (exactly once).
 *   4. No false links: a payload for a DIFFERENT order id is ignored.
 *   5. No wipe: a read-only sweep never sets sessionExpired / isLoggedIn=false.
 *   6. Wiring: the pasted-id path in index.js uses those options.
 */
import fs from 'node:fs';
import * as wafPool from './waf-pool.js';

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

// Each scenario uses its own order id: the module keeps a small in-memory
// "last known link" cache per Swiggy id, and a reused id would short-circuit a
// later scan (test bleed, not a product bug).
const IDS = {
  stale: '4821377991',
  legacy: '4821377992',
  paged: '4821377993',
  cooldown: '4821377994',
  wrong: '4821377995'
};
const OTHER_ID = '4821377000';
const JWT = (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: '287113492', user_id: 287113492, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.sig`;
})();

function jsonRes(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: { get: () => 'application/json', getSetCookie: () => [] },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

const realFetch = globalThis.fetch;
const store = await import('./store.js');
const dbAtStart = JSON.parse(JSON.stringify(store.getDb()));
const tracking = await import('./order-tracking.js');

const makeAccount = (over = {}) => ({
  id: 'acc_stale', phone: '9580917944', customerId: '287113492', name: 'Stale ID',
  cookies: `_session_tid=sess_v54; tid=${JWT}`, tid: JWT, token: 'tok_v54',
  isLoggedIn: true, ...over
});

const dummyOrders = Array.from({ length: 10 }, (_, i) => ({ order_id: String(9000000000 + i), restaurant_name: 'Old Order' }));

let fetchLog = [];
function installFetch({ targetId, trackOrderId = targetId, targetOnPage = 2, accountFails = false } = {}) {
  fetchLog = [];
  globalThis.fetch = async (u, opts = {}) => {
    const url = String(u);
    fetchLog.push(url);
    if (url.includes('events.swiggy.com')) return jsonRes(200, { message: 'ok', shouldNotify: true, value: 1 });
    if (/order\/all(\?|$)/.test(url)) {
      const page = Number(new URL(url, 'https://www.swiggy.com').searchParams.get('page') || 1);
      if (accountFails) return jsonRes(401, { statusCode: 999, statusMessage: 'Session expired' });
      if (page === 1) return jsonRes(200, { statusCode: 0, data: { orders: targetOnPage === 1 ? [{ order_id: targetId, restaurant_name: 'Real Bakers' }, ...dummyOrders.slice(1)] : dummyOrders } });
      if (page === 2 && targetOnPage === 2) return jsonRes(200, { statusCode: 0, data: { orders: [{ order_id: targetId, restaurant_name: 'Real Bakers' }, ...dummyOrders.slice(1)] } });
      return jsonRes(200, { statusCode: 0, data: { orders: [] } });
    }
    if (url.includes('order/details')) {
      if (accountFails) return jsonRes(401, { statusCode: 999, statusMessage: 'Session expired' });
      // Wrong-order payload on purpose when trackOrderId differs.
      return jsonRes(200, { statusCode: 0, data: { orders: [{ order_id: trackOrderId, restaurant_name: 'Real Bakers', order_status: 'Confirmed' }] } });
    }
    if (url.includes('order/trackV4') || url.includes('order/trackV2')) {
      if (accountFails) return jsonRes(401, { statusCode: 999, statusMessage: 'Session expired' });
      return jsonRes(200, {
        statusCode: 0,
        data: {
          order_id: trackOrderId,
          order_status_details: { status_message: 'Order Confirmed' },
          fyi_details: [{ value: { cta_link: `https://swig.gy/track-${trackOrderId}` } }]
        }
      });
    }
    if (url.includes('profile.swiggy.com') || url.includes('profile/info')) {
      if (accountFails) return jsonRes(401, { statusCode: 999 });
      return jsonRes(200, { statusCode: 0, tid: JWT, data: { customer_id: '287113492' } });
    }
    if (url.includes('chkout.swiggy.com/api/v2/cart/client')) return jsonRes(200, { statusCode: 0, tid: JWT, data: {} });
    return jsonRes(200, { statusCode: 0, data: {} });
  };
}

function seed(account = {}, targetId) {
  const db = store.getDb();
  db.config.accounts = { acc_stale: makeAccount(account) };
  db.config.bossIds = ['900001'];
  db.orders = {
    LOOKUP1: {
      id: 'LOOKUP1',
      isSwiggyIdLookup: true,
      swiggyOrderId: targetId,
      status: 'ACCEPTED',
      userId: '900002'
    }
  };
  store.saveDb(db);
  return db;
}

// ---------------------------------------------------------------------------
console.log('\n━━━ 1) stale sessionExpired / isLoggedOut flags are still scanned ━━━');
{
  seed({ sessionExpired: true, isLoggedOut: true, isLoggedIn: false }, IDS.stale);
  installFetch({ targetId: IDS.stale, targetOnPage: 1 });
  wafPool.clearCooldown();
  const res = await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: IDS.stale }, {
    force: true, budgetMs: 12000, deep: true, includeStaleFlags: true
  });
  check('a flagged-but-credentialed ID is asked and the order is found', res?.status === 'TRACKING_FOUND', JSON.stringify(res?.status));
  check('the real Swiggy link is stored', String(res?.trackingUrl || '').includes(IDS.stale), String(res?.trackingUrl));
  const stored = store.getDb().orders.LOOKUP1;
  check('the order record now carries the link', String(stored?.trackingUrl || stored?.trackingLink || '').includes(IDS.stale),
    JSON.stringify({ t: stored?.trackingUrl, l: stored?.trackingLink }));
}

console.log('\n━━━ 2) the same scan WITHOUT includeStaleFlags finds nothing (proof the flag mattered) ━━━');
{
  seed({ sessionExpired: true, isLoggedOut: true, isLoggedIn: false }, IDS.stale);
  installFetch({ targetId: IDS.stale, targetOnPage: 1 });
  wafPool.clearCooldown();
  const res = await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: IDS.stale }, { force: true, budgetMs: 6000, deep: true });
  check('legacy behaviour skips the flagged ID', res?.status !== 'TRACKING_FOUND', JSON.stringify(res?.status));
  check('and reports why (no usable accounts)', /NO_ACCOUNTS|NOT_FOUND/.test(String(res?.status)));
}

console.log('\n━━━ 3) order beyond page 1 of order/all is still found ━━━');
{
  seed({}, IDS.paged);
  installFetch({ targetId: IDS.paged, targetOnPage: 2 });
  wafPool.clearCooldown();
  const res = await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: IDS.paged }, {
    force: true, budgetMs: 15000, deep: true, includeStaleFlags: true
  });
  check('page 2 is walked', fetchLog.some((u) => /order\/all\?page=2/.test(u)));
  check('the deep-paged order is found', res?.status === 'TRACKING_FOUND', JSON.stringify(res?.status));
}

console.log('\n━━━ 4) a user-initiated scan bypasses a background WAF cooldown ━━━');
{
  seed({}, IDS.cooldown);
  installFetch({ targetId: IDS.cooldown, targetOnPage: 1 });
  wafPool.markWafHit();
  check('cooldown is actually active', wafPool.cooldownRemainingMs() > 0);
  const blocked = await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: IDS.cooldown }, { force: true, budgetMs: 6000 });
  check('background sweep still honours the cooldown', blocked?.status === 'WAF_COOLDOWN', JSON.stringify(blocked?.status));

  const userRes = await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: IDS.cooldown }, {
    force: true, budgetMs: 12000, deep: true, ignoreWafCooldown: true, includeStaleFlags: true
  });
  check('a pasted id still gets answered during cooldown', userRes?.status === 'TRACKING_FOUND', JSON.stringify(userRes?.status));
  wafPool.clearCooldown();
}

console.log('\n━━━ 5) no false links: a different order id is never attached ━━━');
{
  seed({}, IDS.wrong);
  // Every endpoint answers for OTHER_ID, not for the id the user pasted.
  installFetch({ targetId: IDS.wrong, trackOrderId: OTHER_ID, targetOnPage: 1 });
  wafPool.clearCooldown();
  const res = await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: IDS.wrong }, {
    force: true, budgetMs: 12000, deep: true, includeStaleFlags: true
  });
  check('a mismatched payload does not become a tracking link',
    res?.status !== 'TRACKING_FOUND', JSON.stringify(res?.status));
  check('and no link is written to the order',
    !String(store.getDb().orders.LOOKUP1?.trackingUrl || '').includes(OTHER_ID));
}

console.log('\n━━━ 6) read-only sweeps never wipe an ID ━━━');
{
  seed({}, '4821377996');
  installFetch({ targetId: '4821377996', accountFails: true });
  wafPool.clearCooldown();
  await tracking.ensureOrderTracking({ id: 'LOOKUP1', swiggyOrderId: '4821377996' }, {
    force: true, budgetMs: 8000, deep: true, readOnly: true, includeStaleFlags: true, ignoreWafCooldown: true
  });
  const acc = store.getDb().config.accounts.acc_stale;
  check('sessionExpired is not written by a read-only sweep', !acc.sessionExpired);
  check('isLoggedIn is not flipped off', acc.isLoggedIn !== false);
  check('the session itself is untouched', String(acc.cookies || '').includes('_session_tid='));
  check('the order still exists', Boolean(store.getDb().orders.LOOKUP1));
}

console.log('\n━━━ 7) wiring of the pasted-id path ━━━');
{
  const idx = fs.readFileSync('./index.js', 'utf8');
  check('instant try covers up to 6 IDs (not 3)',
    /for \(const key of likelyKeys\.slice\(0, 6\)\)/.test(idx));
  check('instant try no longer filters on isLoggedIn/isLoggedOut',
    !/filter\(\(k\) => accMap\[k\] && accMap\[k\]\.isLoggedIn && !accMap\[k\]\.isLoggedOut/.test(idx));
  check('pasted id passes ignoreWafCooldown', /ignoreWafCooldown: isNumericSwiggyId/.test(idx));
  check('pasted id passes includeStaleFlags', /includeStaleFlags: isNumericSwiggyId/.test(idx));

  const cart = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('scan accepts stale-flag accounts when asked',
    /includeStaleFlags \|\| \(!acc\.isLoggedOut && !acc\.sessionExpired\)/.test(cart));
  check('order/all pagination exists', /order\/all\?page=\$\{pg\}/.test(cart));
  check('extractTrackingViaAllAccounts defaults to stale-flag inclusion',
    /extractTrackingViaAllAccounts\(order, \{ getAccountsFn = null, budgetMs = 18000, deep = true, includeStaleFlags = true \}/.test(cart));

  const trk = fs.readFileSync('./order-tracking.js', 'utf8');
  check('cooldown bypass is opt-in only', /wafCooldownMs > 0 && !ignoreWafCooldown/.test(trk));
  check('scan receives readOnly (no wipe contract)', /readOnly,\s*\n\s*includeStaleFlags/.test(trk));
}

globalThis.fetch = realFetch;
wafPool.clearCooldown();
const db = store.getDb();
db.config = dbAtStart.config;
db.orders = dbAtStart.orders;
store.saveDb(db);

console.log(`\n📊 RESULT: ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log('❌ FAILED CHECKS PRESENT');
  process.exit(1);
}
console.log('🏆 ANY-ID ORDER EXTRACTION VERIFIED');
process.exit(0);
