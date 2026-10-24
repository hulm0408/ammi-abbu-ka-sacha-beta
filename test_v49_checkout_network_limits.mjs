import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCheckoutResponse, checkoutCooldownResponse, observeCheckoutResponse, checkoutFailureResult } from './checkout-network-health.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-network-'));
process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';
process.env.DATA_DIR = temp;
process.env.DB_FILE = path.join(temp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(temp, 'accounts.json');
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const response = (status, headers = {}, json = null) => ({ status, ok: status >= 200 && status < 300,
  headers: { get: key => headers[key.toLowerCase()] ?? null },
  json: async () => json, text: async () => JSON.stringify(json) });
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
let now = originalNow();
try {
  check(classifyCheckoutResponse(response(200)), null, 'successful cart is not proof of IP block');
  check(classifyCheckoutResponse(response(200, {}, { statusCode: 1 })), null, 'business rejection not called IP block');
  check(classifyCheckoutResponse(response(401)), null, 'auth failure is not IP block');
  check(classifyCheckoutResponse(response(202)), null, '202 alone not proof of security challenge');
  check(classifyCheckoutResponse(response(403)).code, 'CHECKOUT_ACCESS_DENIED', '403 is access denial, not confirmed IP ban');
  check(classifyCheckoutResponse(response(403)).ipBlockConfirmed, false, 'do not invent an IP diagnosis');
  check(classifyCheckoutResponse(response(429, { 'retry-after': '25' }), now).retryAfterMs, 25_000, 'respect retry-after seconds');
  check(classifyCheckoutResponse(response(429, { 'retry-after': new Date(now + 90_000).toUTCString() }), now).retryAfterMs > 88_000, true, 'respect retry-after date');
  check(classifyCheckoutResponse(response(200, { 'x-amzn-waf-action': 'challenge' })).code, 'CHECKOUT_SECURITY_CHALLENGE', 'detect explicit challenge even on HTTP 200');
  check(classifyCheckoutResponse(response(200, { 'x-amzn-waf-action': 'count' })), null, 'count-only action not denied');
  check(classifyCheckoutResponse(response(429, { 'retry-after': 'bad' })).retryAfterMs, 60_000, 'safe default retry delay');
  const saved = observeCheckoutResponse(response(403), now);
  check(checkoutCooldownResponse(now + 1000).networkDiagnostic.code, saved.code, 'shared origin backoff');
  check(checkoutCooldownResponse(now + 180_000), null, 'backoff expires, not permanent account lock');

  Date.now = () => now;
  const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '123', exp: Math.floor(now / 1000) + 86400 })).toString('base64url') + '.sig';
  const account = { id: 'acc_network_test', phone: '9000000005', isLoggedIn: true, customerId: '123',
    token: 'test-token', tid: jwt, cookies: `_session_tid=test; tid=${jwt}; token=test-token` };
  let nativeCalls = 0;
  let otherCalls = 0;
  let nativeStatus = 403;
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://chkout.swiggy.com/api/v2/cart/')) {
      nativeCalls++;
      return response(nativeStatus, nativeStatus === 429 ? { 'retry-after': '12' } : {});
    }
    assert.match(String(url), /\/dapi\/order\/all/, 'no cart fallback/challenge solver or alternate gateway');
    otherCalls++;
    return response(200, {}, { statusCode: 0, tid: jwt, data: { orders: [] } });
  };
  const { swiggyCartGet, swiggyCartUpdate, swiggyCartFlush } = await import('./swiggy-cart.js');
  const first = await swiggyCartGet(account);
  check(first.networkDiagnostic.code, 'CHECKOUT_ACCESS_DENIED', 'actual native refusal surfaced');
  const callsBeforeCooldown = nativeCalls + otherCalls;
  check((await swiggyCartGet(account)).networkDiagnostic.code, 'CHECKOUT_ACCESS_DENIED', 'repeat read paused');
  check((await swiggyCartUpdate(account, { cartItems: [] })).networkDiagnostic.code, 'CHECKOUT_ACCESS_DENIED', 'cart update paused');
  check((await swiggyCartFlush(account)).networkDiagnostic.code, 'CHECKOUT_ACCESS_DENIED', 'cart flush paused');
  check((await swiggyCartGet({ ...account, id: 'another_account' })).networkDiagnostic.code, 'CHECKOUT_ACCESS_DENIED', 'switching accounts does not evade origin backoff');
  check(nativeCalls + otherCalls, callsBeforeCooldown, 'no network/auth calls during cooldown');
  check(account.isLoggedIn, true, '403 does not log out account');
  now += 180_001;
  nativeStatus = 429;
  const limited = await swiggyCartGet(account);
  check(limited.networkDiagnostic.retryAfterMs, 12_000, 'new response respects server delay');
  const failed = checkoutFailureResult(limited);
  check(failed.success, false, 'rate limited cart never reported as synced');
  check(failed.code, 'CHECKOUT_RATE_LIMITED', 'failure code preserved');
  check(JSON.stringify(failed).includes('test-token'), false, 'diagnostic contains no session material');
  check(nativeCalls, 2, 'exactly one attempt per backoff window');
  check(fs.readFileSync('checkout-network-health.js', 'utf8'), fs.readFileSync('bossbot/vendor/checkout-network-health.js', 'utf8'), 'standalone engine matches main rule');
  console.log(`PASS: ${checks} access-denial, rate-limit, cooldown, no-fallback and no-false-IP-diagnosis checks`);
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}
