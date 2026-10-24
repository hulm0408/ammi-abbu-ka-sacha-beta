import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiggy-suspension-'));
process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';
process.env.DATA_DIR = temp;
process.env.DB_FILE = path.join(temp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(temp, 'accounts.json');
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('No live requests allowed'); };
try {
  const { getDb, saveDb, isAccountLoggedInSession, updateAccount } = await import('./store.js');
  const { assertSwiggyAccountNotSuspended, generateRealSwiggyMerchantUpiQr,
    inspectAccountOrderHistoryAndOffers, findBestMaxCouponAccountForOrder } = await import('./swiggy-cart.js');
  const { executeRealQrGenerationForOrder, formatBossDiagnosticErrorMessage } = await import('./forwarded-order-flow.js');
  const account = { id: 'acc_test', phone: '9000000001', isLoggedIn: true, token: 'test-token' };
  const db = getDb();
  db.config.accounts = { acc_test: account };
  db.orders = { ORD_TEST: { id: 'ORD_TEST', selectedAccount: 'acc_test', status: 'PENDING', finalPayable: 54 } };
  saveDb(db);
  const stale = getDb();
  stale.config.accounts.acc_test.offers = { breakfast: 'updated' };
  assert.doesNotThrow(() => assertSwiggyAccountNotSuspended(account, { statusCode: 1, statusMessage: 'Restaurant closed' }, 200));
  assert.doesNotThrow(() => assertSwiggyAccountNotSuspended(account, { statusCode: 0, statusMessage: 'success' }, 200));
  const response = { statusCode: 1, statusMessage: 'Your account has been suspended. Please contact support@swiggy.in for assistance', tid: 'SECRET-JWT', data: null };
  let failure;
  assert.throws(() => assertSwiggyAccountNotSuspended(account, response, 200), err => {
    failure = err;
    return err.diag.code === 'SWIGGY_ACCOUNT_SUSPENDED' && err.diag.retryable === false && err.diag.httpStatus === 200;
  });
  assert.equal(account.isSuspended, true);
  assert.equal(getDb().config.accounts.acc_test.isSuspended, true);
  saveDb(stale);
  assert.equal(getDb().config.accounts.acc_test.isSuspended, true, 'stale modified profile cannot erase suspension');
  updateAccount('acc_test', { isLoggedIn: true, name: 'Reimported session' });
  assert.equal(isAccountLoggedInSession(getDb().config.accounts.acc_test), false, 're-login alone does not clear suspension');
  const staleAccount = { id: 'acc_test', phone: account.phone, token: account.token, isLoggedIn: true };
  await assert.rejects(generateRealSwiggyMerchantUpiQr(staleAccount, {}), err => err.diag.code === 'SWIGGY_ACCOUNT_SUSPENDED');
  const profile = await inspectAccountOrderHistoryAndOffers('acc_test', getDb().config.accounts.acc_test);
  assert.equal(profile.reason, 'ACCOUNT_SUSPENDED');
  const pick = await findBestMaxCouponAccountForOrder({ id: 'ORD_TEST' });
  assert.equal(Boolean(pick.success), false, 'suspended account is excluded from auto-selection');
  let generated = 0;
  await assert.rejects(executeRealQrGenerationForOrder({ orderId: 'ORD_TEST', customRealQrGenerator: async () => { generated++; } }), err => err.diag.code === 'SWIGGY_ACCOUNT_SUSPENDED');
  assert.equal(generated, 0, 'no QR or silent failover on a suspended selected account');
  assert.equal(getDb().orders.ORD_TEST.selectedAccount, 'acc_test');
  const text = formatBossDiagnosticErrorMessage(failure, { orderId: 'ORD_TEST' });
  assert.match(text, /support@swiggy.in/);
  assert.doesNotMatch(text, /SECRET-JWT|raw:|AI-DIAG/);
  assert.equal(networkCalls, 0);

  // Both shipping engines must stop all gateway fallbacks on this terminal error.
  for (const file of ['swiggy-cart.js', 'bossbot/vendor/swiggy-cart.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal((source.match(/assertSwiggyAccountNotSuspended\(account, parsed, r.status\)/g) || []).length, 3);
    assert.equal((source.match(/\.catch\(handlePlaceOrderTransportFailure\)/g) || []).length, 3);
  }
  console.log('PASS: suspended HTTP-200 refusal, persistence, stale writes, session reimport, QR guards, selection, diagnostic redaction, and both gateway fallback guards');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
