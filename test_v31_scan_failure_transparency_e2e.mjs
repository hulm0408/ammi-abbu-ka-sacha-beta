// ============================================================================
// V31 — Scan failure transparency: expired/failed accounts are NAMED, not
// silently counted as "scanned, no order" (order 251630299198497 incident:
// account 8000958285 had a 40-min tid JWT that expired 26 min before the
// scan, so the order was invisible on that account and the user got a bare
// "kisi bhi logged-in ID par nahi mila" with no hint to re-login).
// ============================================================================
import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import { getDb, saveDb } from './store.js';
import {
  scanOrderAcrossAccounts,
  accountTidExpiryMs,
  getStoredSwiggyTrackingUrl
} from './swiggy-cart.js';
import { formatBulkVaultImportSummaryHtml } from './account-vault-intake.js';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${label}`); }
  catch (err) { failed += 1; console.log(`❌ ${label}\n   ↳ ${err.message}`); }
}

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function makeJwt(expSeconds, userId = '286684413') {
  return `${b64url({ typ: 'JWT', alg: 'HS256' })}.${b64url({ user_id: userId, iat: expSeconds - 2400, exp: expSeconds })}.sig`;
}
const NOW = Math.floor(Date.now() / 1000);
const EXPIRED_JWT = makeJwt(NOW - 1500);        // expired 25 min ago (the 8000958285 case)
const SHORT_JWT = makeJwt(NOW + 1800);          // expires in 30 min
const LONG_JWT = makeJwt(NOW + 30 * 24 * 3600); // 30-day app session

const ORDER_ID = '251630299198497';
const REAL_OFO_URL = 'http://r.swiggy.com/swiggy/ofo/track/JxFrye5qawn8';

function makeResponse(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
}

const realFetch = globalThis.fetch;
const captured = [];
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), cookie: String(init?.headers?.Cookie || '') });
  if (String(url).includes('/dapi/order/all')) {
    return makeResponse({ statusCode: 0, tid: LONG_JWT, data: { orders: [{ order_id: ORDER_ID, order_status: 'Processing', restaurant_name: 'Sanjay Sweets', order_total: 40 }] } });
  }
  if (String(url).includes('/dapi/order/details')) {
    return makeResponse({ statusCode: 0, data: { orders: [{ order_id: ORDER_ID, order_status: 'processing', restaurant_name: 'Sanjay Sweets' }] } });
  }
  if (String(url).includes('/dapi/order/trackV4')) {
    return makeResponse({ statusCode: 0, data: { order_status_details: { status_message: 'Order accepted by restaurant' }, ofo_details: { share_data: { share_url: REAL_OFO_URL } } } });
  }
  if (String(url).includes('/dapi/order/trackV2/de')) {
    return makeResponse({ statusCode: 0, data: { otp: '4821' } });
  }
  return makeResponse({ statusCode: 0, data: {} });
};

const rawDbDiskBackup = fs.existsSync('data/db.json') ? fs.readFileSync('data/db.json', 'utf8') : null;
const dbBackup = JSON.parse(JSON.stringify(getDb()));

const expiredAcc = {
  name: 'Rahul Kumar', phone: '8000958285', customerId: '286684413',
  token: 'tok-expired', tid: EXPIRED_JWT, sid: 's1', deviceId: 'd1',
  cookies: `dead-cookies _session_tid=x; token=tok-expired; tid=${EXPIRED_JWT}`,
  isLoggedIn: true
};
const aliveAcc = {
  name: 'prithvi', phone: '9935123518', customerId: '283703858',
  token: 'tok-alive', tid: LONG_JWT, sid: 's2', deviceId: 'd2',
  cookies: `alive-cookies _session_tid=y; token=tok-alive; tid=${LONG_JWT}`,
  isLoggedIn: true
};

try {
  const db = getDb();
  db.config.accounts = { ...db.config.accounts, acc_exp: expiredAcc, acc_alive: aliveAcc };
  db.orders.V31_A = {
    id: 'V31_A', status: 'COMPLETED', swiggyOrderId: ORDER_ID, pendingSwiggyOrderId: ORDER_ID,
    selectedAccount: 'acc_exp', createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
  };
  saveDb(db);

  await check('accountTidExpiryMs decodes expired/short/long tids correctly', () => {
    assert.ok(accountTidExpiryMs(expiredAcc) < Date.now(), 'expired tid detected');
    const shortExp = accountTidExpiryMs({ ...aliveAcc, tid: SHORT_JWT });
    assert.ok(shortExp > Date.now() && shortExp < Date.now() + 3600_000, 'short tid detected');
    assert.ok(accountTidExpiryMs(aliveAcc) > Date.now() + 29 * 24 * 3600_000, 'long tid detected');
    assert.strictEqual(accountTidExpiryMs({ cookies: 'no tid here' }), null);
  });

  await check('Scan finds the order on the alive account AND names the expired account in failures', async () => {
    captured.length = 0;
    const scan = await scanOrderAcrossAccounts(ORDER_ID, { budgetMs: 15000, deep: true, getAccountsFn: () => ({ acc_exp: expiredAcc, acc_alive: aliveAcc }) });
    assert.strictEqual(scan.hasOrder, true, `order must be found via alive account: status=${scan.status}`);
    assert.strictEqual(scan.status, 'TRACKING_FOUND');
    assert.strictEqual(scan.trackingUrl, REAL_OFO_URL);
    const fails = (scan.failures || []).filter(f => f.phone === '8000958285');
    assert.strictEqual(fails.length, 1, `failures must name the expired account: ${JSON.stringify(scan.failures)}`);
    assert.strictEqual(fails[0].reason, 'SESSION_EXPIRED');
    // The expired account must NOT burn network budget on doomed calls.
    const doomed = captured.filter(c => c.cookie.includes('dead-cookies'));
    assert.strictEqual(doomed.length, 0, `no DAPI calls expected for the expired account, got ${doomed.length}`);
  });

  await check('When EVERY account is expired, NOT_FOUND carries per-account SESSION_EXPIRED failures', async () => {
    const scan = await scanOrderAcrossAccounts('259999999999999', { budgetMs: 12000, deep: true, getAccountsFn: () => ({ acc_exp: expiredAcc }) });
    assert.strictEqual(scan.hasOrder, false);
    assert.strictEqual(scan.status, 'NOT_FOUND');
    assert.ok(Array.isArray(scan.failures) && scan.failures.length === 1, 'one failure recorded');
    assert.strictEqual(scan.failures[0].reason, 'SESSION_EXPIRED');
    assert.strictEqual(scan.failures[0].phone, '8000958285');
  });

  await check('Auth-failed account (Swiggy rejects the session live) is named as AUTH_FAILED', async () => {
    // A live-auth failure: auth throws AND the direct order/all fallback returns
    // an error payload (e.g. "Please login again") — exactly what a session that
    // expires AFTER import looks like at scan time.
    const failingAcc = { ...aliveAcc, name: 'Fail Acc', phone: '9988776655', cookies: `fail-cookies _session_tid=z; token=tok-fail; tid=${LONG_JWT}`, token: 'tok-fail', tid: LONG_JWT, customerId: '111' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const cookie = String(init?.headers?.Cookie || '');
      if (cookie.includes('fail-cookies')) {
        return makeResponse({ statusCode: 401, statusMessage: 'Please login again', data: {} });
      }
      return origFetch(url, init);
    };
    try {
      const scan = await scanOrderAcrossAccounts('259999999999998', { budgetMs: 12000, deep: true, getAccountsFn: () => ({ acc_fail: failingAcc }) });
      assert.strictEqual(scan.hasOrder, false);
      const fails = (scan.failures || []).filter(f => f.phone === '9988776655');
      assert.strictEqual(fails.length, 1, `failure must be recorded: ${JSON.stringify(scan.failures)}`);
      assert.strictEqual(fails[0].reason, 'AUTH_FAILED');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await check('Import summary warns about short-lived sessions at save time', () => {
    const result = {
      savedAccounts: [
        { key: 'acc_short', account: { phone: '8000958285', tid: SHORT_JWT } },
        { key: 'acc_long', account: { phone: '9935123518', tid: LONG_JWT } }
      ],
      zeroOrderCount: 0, usedAccountCount: 1, expiredList: [], parseErrors: [],
      totalVaultActiveCount: 2, totalVaultZeroOrderCount: 0
    };
    const html = formatBulkVaultImportSummaryHtml(result, 1);
    assert.ok(/Short session \(1\)/.test(html), `summary must flag the short session: ${html.slice(0, 300)}`);
    assert.ok(html.includes('8000958285'), 'short-session phone shown');
    assert.ok(!html.includes('9935123518') || !/Short session.*9935123518/.test(html), 'long session not flagged');
  });
} finally {
  globalThis.fetch = realFetch;
  try {
    if (rawDbDiskBackup !== null) fs.writeFileSync('data/db.json', rawDbDiskBackup, 'utf8');
    saveDb(JSON.parse(JSON.stringify(dbBackup)));
  } catch {}
}

console.log(`\n================================================================\n📊 V31 RESULT: ${passed}/${passed + failed} scan-failure-transparency checks passed${failed ? ` — ${failed} FAILED` : ''}\n================================================================`);
process.exit(failed ? 1 : 0);
