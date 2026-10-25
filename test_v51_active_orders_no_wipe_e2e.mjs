// ============================================================================
// v51 — ACTIVE ORDERS GET THEIR OFO LINK, WITHOUT WIPING ANY LOGGED-IN ID
// ----------------------------------------------------------------------------
// Live route confirmed by the operator:
//
//   GET /dapi/order/trackV4?order_id=251838950110925&type=full&version=V2
//   data.fyi_details[0].value.cta_link
//     = swiggy://share?text=<url-encoded https://www.swiggy.com/ofo/track/GfF1tVG8iSUk>
//
// Contract under test:
//   1. A running order with no tracking link gets one from that exact field.
//   2. The sweep is READ-ONLY: no account is logged out, marked
//      `sessionExpired`, `isLoggedIn: false`, removed, or "wiped" — even when
//      an ID answers with a timeout / WAF page / HTML challenge.
//   3. Only Swiggy's own "unauthorized / logged out" answer may demote an ID.
//   4. Finished/history orders and the account vault stay byte-identical.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';
process.env.WAF_KEEPWARM = 'false';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

const OFO = 'https://www.swiggy.com/ofo/track/GfF1tVG8iSUk';
const CTA = `swiggy://share?text=${encodeURIComponent(`Track your order: ${OFO}`)}`;
// A fresh numeric id per seed so the module-level order snapshot cache can
// never answer a later scenario from an earlier scan's memory.
let ACTIVE_ID = '251838950110925';
globalThis.__v51TargetId = ACTIVE_ID;

// 'ok'      -> order/all + trackV4 answer with the fyi cta_link
// 'waf'     -> every Swiggy call returns a WAF 403 HTML challenge
// 'timeout' -> fetch rejects (network timeout)
// 'deadid'  -> order/all answers statusCode 999 (Swiggy really says logged out)
const net = { mode: 'ok' };
const calls = [];

const jsonRes = (status, body, u) => ({
  ok: status >= 200 && status < 300, status, url: u,
  headers: { get: (k) => (String(k).toLowerCase() === 'x-amzn-waf-action' && status === 403 ? 'challenge' : 'application/json') },
  text: async () => JSON.stringify(body),
  json: async () => body
});
const htmlRes = (status, u) => ({
  ok: false, status, url: u,
  headers: { get: (k) => (String(k).toLowerCase() === 'x-amzn-waf-action' && status === 403 ? 'challenge' : 'text/html') },
  text: async () => '<html>challenge</html>',
  json: async () => { throw new Error('not json'); }
});

const orderRow = () => ({
  order_id: globalThis.__v51TargetId,
  customer_id: '778899',
  order_status: 'Order Confirmed',
  restaurant_name: 'Mouj Mela',
  sla_time: '32',
  delivery_address: 'Flat 4, Gomti Nagar, Lucknow 226010'
});
const TRACK_V4 = {
  statusCode: 0,
  data: {
    order_status_details: { status_message: 'Order Confirmed', status_tag_text: 'Preparing' },
    fyi_details: [{ title: 'Track your order', value: { cta_link: CTA } }]
  }
};

globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (net.mode === 'timeout') throw new Error('ETIMEDOUT');
  if (net.mode === 'waf') return htmlRes(403, u);
  if (u.includes('onelink.me') || u.includes('swig.gy')) return htmlRes(403, u);
  if (u.includes('order/all')) {
    if (net.mode === 'deadid') return jsonRes(200, { statusCode: 999, statusMessage: 'User not logged in' }, u);
    return jsonRes(200, { statusCode: 0, data: { orders: [orderRow()] }, tid: 'fake.jwt.tid' }, u);
  }
  if (u.includes('order/trackV4')) return jsonRes(200, TRACK_V4, u);
  if (u.includes('order/details')) return jsonRes(200, { statusCode: 0, data: { orders: [orderRow()] } }, u);
  if (u.includes('order/trackV2')) return jsonRes(200, { statusCode: 0, data: {} }, u);
  if (u.includes('profile/info')) return jsonRes(200, { statusCode: 0, data: { customer_id: '778899' }, tid: 'fake.jwt.tid' }, u);
  if (u.includes('social/getAddress')) return jsonRes(200, { statusCode: 1, statusMessage: 'Oops!! Something went wrong' }, u);
  return htmlRes(503, u);
};

const { getDb, mutateDb } = await import('./store.js');
const {
  refreshActiveOrdersTracking,
  listActiveOrdersNeedingTracking,
  ensureOrderTracking
} = await import('./order-tracking.js');
const { getStoredSwiggyTrackingUrl } = await import('./swiggy-cart.js');
const wafPool = await import('./waf-pool.js');

const ACTIVE_ORDER = 'ORD_ACTIVE_V51';
const DONE_ORDER = 'ORD_DONE_V51';
const finishedSnapshot = {
  id: DONE_ORDER, userId: 8180001, status: 'COMPLETED', paymentStatus: 'PAID',
  createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  completedAt: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString(),
  restaurantName: 'Old Order', items: [{ name: 'Chole Bhature', qty: 1, price: 150, lineTotal: 150 }],
  finalPayable: 170, swiggyOrderId: '251800000000001',
  trackingLink: 'https://www.swiggy.com/ofo/track/OLDORDER123', trackingLinkSource: 'SWIGGY_API',
  address: 'Flat 9, Hazratganj, Lucknow 226001',
  addressDetails: { address: 'Flat 9, Hazratganj, Lucknow 226001', city: 'Lucknow', mobile: '9876543210' }
};

let seedSeq = 0;
function seed() {
  seedSeq += 1;
  ACTIVE_ID = `2518389501109${String(20 + seedSeq).padStart(3, '0')}`;
  globalThis.__v51TargetId = ACTIVE_ID;
  // Unique cookies per seed so the module-level session auth cache (keyed on
  // the cookie string) can never leak a previous scenario's verdict.
  mutateDb((d) => {
    d.orders = d.orders || {};
    d.drafts = d.drafts || {};
    d.config.accounts = {
      // A perfectly healthy logged-in ID with a running order.
      acc_live_1: {
        account: 'acc_live_1', name: 'Ammi', phone: '9000000999',
        isLoggedIn: true, cookies: `_session_tid=live.tid.value.${seedSeq}`, tid: 'fake.jwt.tid',
        customerId: '778899'
      },
      // A second logged-in ID that is NOT involved in this order at all.
      acc_live_2: {
        account: 'acc_live_2', name: 'Abbu', phone: '9000000888',
        isLoggedIn: true, cookies: `_session_tid=second.tid.value.${seedSeq}`, tid: 'fake.jwt.tid2'
      }
    };
    d.orders[ACTIVE_ORDER] = {
      id: ACTIVE_ORDER, userId: 8180001, userName: 'Ammi', type: 'SWIGGY_ORDER',
      status: 'ACCEPTED', paymentStatus: 'PAID',
      selectedAccount: 'acc_live_1', orderAccount: '9000000999',
      restaurantName: 'Mouj Mela', items: [{ name: 'Paneer Butter Masala', qty: 1, price: 240, lineTotal: 240 }],
      finalPayable: 268, swiggyOrderId: globalThis.__v51TargetId,
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      address: 'Flat 4, Gomti Nagar, Lucknow 226010',
      addressDetails: { address: 'Flat 4, Gomti Nagar, Lucknow 226010', city: 'Lucknow', mobile: '9876543210' }
    };
    d.orders[DONE_ORDER] = { ...finishedSnapshot };
  });
}

const accountSnapshot = () => JSON.stringify(getDb().config.accounts);

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: a running order gets its OFO link from fyi cta_link ---');
{
  seed();
  net.mode = 'ok';
  calls.length = 0;
  const accountsBefore = accountSnapshot();

  const pending = listActiveOrdersNeedingTracking();
  check('the running order is listed for tracking', pending.some((o) => o.id === ACTIVE_ORDER));
  check('the finished order (already linked) is NOT listed', !pending.some((o) => o.id === DONE_ORDER));

  const out = await refreshActiveOrdersTracking({ budgetMs: 12000, deep: true, concurrency: 2 });
  const order = getDb().orders[ACTIVE_ORDER];
  const url = getStoredSwiggyTrackingUrl(order);

  check('the sweep found a tracking link', out.found >= 1);
  check('the link is the exact OFO url from cta_link', url === OFO);
  check('trackV4 was actually called', calls.some((u) => u.includes('order/trackV4')));
  check('the account vault is byte-identical (no wipe, no demotion)', accountSnapshot() === accountsBefore);
  check('both IDs are still logged in', getDb().config.accounts.acc_live_1.isLoggedIn === true && getDb().config.accounts.acc_live_2.isLoggedIn === true);
  check('no ID was marked sessionExpired', !getDb().config.accounts.acc_live_1.sessionExpired && !getDb().config.accounts.acc_live_2.sessionExpired);
  check('the finished order is untouched', JSON.stringify(getDb().orders[DONE_ORDER]) === JSON.stringify(finishedSnapshot));
}

console.log('\n--- Scenario 2: a WAF page can never wipe an ID ---');
{
  seed();
  net.mode = 'waf';
  calls.length = 0;
  const accountsBefore = accountSnapshot();
  const out = await refreshActiveOrdersTracking({ budgetMs: 8000, deep: true, concurrency: 2 });
  check('nothing was found (WAF blocks the read)', out.found === 0);
  check('the sweep still ran', out.scanned >= 1);
  check('the vault is untouched after a WAF sweep', accountSnapshot() === accountsBefore);
  check('the order is still open and unchanged', getDb().orders[ACTIVE_ORDER].status === 'ACCEPTED');
  check('no tracking link was invented', !getStoredSwiggyTrackingUrl(getDb().orders[ACTIVE_ORDER]));
}

console.log('\n--- Scenario 3: a network timeout can never wipe an ID ---');
{
  seed();
  net.mode = 'timeout';
  calls.length = 0;
  const accountsBefore = accountSnapshot();
  await refreshActiveOrdersTracking({ budgetMs: 6000, deep: true, concurrency: 2 });
  check('the vault survives a total network failure', accountSnapshot() === accountsBefore);
  check('ids stay logged in after timeouts',
    getDb().config.accounts.acc_live_1.isLoggedIn === true &&
    getDb().config.accounts.acc_live_2.isLoggedIn === true &&
    !getDb().config.accounts.acc_live_1.sessionExpired);
}

console.log('\n--- Scenario 4: only a real "logged out" answer demotes an ID ---');
{
  seed();
  net.mode = 'deadid';
  wafPool.clearCooldown();
  await ensureOrderTracking(ACTIVE_ORDER, { budgetMs: 8000, deep: true, readOnly: true });
  const afterReadOnly = getDb().config.accounts.acc_live_1;
  check('a read-only scan never demotes, even on a real 999', afterReadOnly.isLoggedIn !== false && !afterReadOnly.sessionExpired);
  check('the unrelated ID is untouched by the read-only scan',
    getDb().config.accounts.acc_live_2.isLoggedIn === true && !getDb().config.accounts.acc_live_2.sessionExpired);

  // The WAF scenario above tripped the shared cooldown; clear it so this scan
  // really runs (a cooldown must never be the reason a test "passes").
  wafPool.clearCooldown();
  seed();
  net.mode = 'deadid';
  const scanOut = await ensureOrderTracking(ACTIVE_ORDER, { budgetMs: 8000, deep: true, readOnly: false });
  check('the scan really ran (not skipped by WAF cooldown)', scanOut?.status !== 'WAF_COOLDOWN');
  const afterNormal = getDb().config.accounts.acc_live_1;
  check('a normal scan may demote only on Swiggy\'s own 999 answer', afterNormal.sessionExpired === true || afterNormal.isLoggedIn === false);
  // In this global "deadid" mock EVERY account answers logged-out, so a demotion
  // here is Swiggy's own verdict — the earlier read-only check above proves a
  // tracking sweep can never do this on its own.
}

console.log('\n--- Scenario 5: history and other orders survive every sweep ---');
{
  seed();
  net.mode = 'ok';
  await refreshActiveOrdersTracking({ budgetMs: 12000, deep: true, concurrency: 2 });
  const db = getDb();
  check('the finished order still exists', Boolean(db.orders[DONE_ORDER]));
  check('its old tracking link is unchanged', db.orders[DONE_ORDER].trackingLink === finishedSnapshot.trackingLink);
  check('its address is unchanged', db.orders[DONE_ORDER].addressDetails.address === finishedSnapshot.addressDetails.address);
  check('orders were added, not removed', Object.keys(db.orders).length >= 2);
}

console.log('\n--- Scenario 6: source wiring ---');
{
  const idx = fs.readFileSync('index.js', 'utf8');
  const trk = fs.readFileSync('order-tracking.js', 'utf8');
  const cart = fs.readFileSync('swiggy-cart.js', 'utf8');
  check('the sweep exists and is exported', /export async function refreshActiveOrdersTracking/.test(trk));
  check('the sweep is read-only', /readOnly: true/.test(trk));
  check('scans accept a readOnly flag', /readOnly = false/.test(cart));
  check('the read-only flag is forwarded into the scan', /concurrency,\s*\n\s*readOnly,?\s*\n\s*(includeStaleFlags,?\s*\n\s*)?\}\)/.test(trk));
  check('demotion requires a HARD expiry', /auth\.hardExpired === true\)/.test(cart));
  check('transient fallbacks are flagged', /transient: !hardExpired/.test(cart));
  check('a boss button exists', /boss_active_tracking/.test(idx) && /🔄 Active Orders Tracking/.test(idx));
  check('the boot sweep is read-only and rate-limited',
    /refreshActiveOrdersTracking\(\{ budgetMs: 12000, deep: false, concurrency: 4, limit: 8, maxAgeMs: /.test(idx)
    && /wafPool\.cooldownRemainingMs\(\)/.test(idx));
  check('no logout / session wipe in the sweep paths',
    !/isLoggedOut = true/.test(trk) && !/sessionExpired = true/.test(trk));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
