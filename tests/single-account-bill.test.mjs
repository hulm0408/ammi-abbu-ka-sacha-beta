import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-bill-'));
Object.assign(process.env, { DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'), NODE_ENV: 'test', DB_ASYNC_WRITE: '0' });
const { selectSingleBillAccount, findBestMaxCouponAccountForOrder } = await import('../swiggy-cart.js');
const { getDb, saveDb } = await import('../store.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('selected account overrides active account and no silent fallback occurs', () => {
  const entries = [['first', {}], ['selected', {}], ['third', {}]];
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'selected', activeKey: 'first' }), 'selected');
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'missing', activeKey: 'first' }), null);
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'selected', busyKeys: ['selected'] }), null);
  assert.equal(selectSingleBillAccount(entries, { selectedKey: 'selected', excludedKeys: ['selected'] }), null);
  assert.equal(selectSingleBillAccount(entries, { activeKey: 'third' }), 'third');
  assert.equal(selectSingleBillAccount(entries, { busyKeys: ['first'] }), 'selected');
});

test('an unavailable selected account never probes another account', async () => {
  const db = getDb();
  db.config.accounts = {
    first: { isLoggedIn: true, token: 'first-token', phone: '9000000001' },
    second: { isLoggedIn: true, token: 'second-token', phone: '9000000002' }
  };
  db.config.activeOrderAccount = 'first';
  saveDb(db);
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected network request'); };
  try {
    const result = await findBestMaxCouponAccountForOrder({ id: 'single-test', selectedAccount: 'missing' });
    assert.equal(result.code, 'SELECTED_ACCOUNT_UNAVAILABLE');
    assert.equal(requests, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('bill inspection never sends requests with other account credentials', async () => {
  const db = getDb();
  const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567', exp: 1900000000 })).toString('base64url') + '.signature';
  db.config.accounts = {
    first: { isLoggedIn: true, tid: jwt, customerId: '1234567', cookies: '_session=first_unique;', phone: '9000000001' },
    selected: { isLoggedIn: true, tid: jwt, customerId: '1234567', cookies: '_session=selected_unique;', phone: '9000000002' },
    third: { isLoggedIn: true, tid: jwt, customerId: '1234567', cookies: '_session=third_unique;', phone: '9000000003' }
  };
  db.config.activeOrderAccount = 'first';
  saveDb(db);
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), headers: JSON.stringify(options.headers || {}) });
    return new Response(JSON.stringify({ statusCode: 1, statusMessage: 'test unavailable' }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  try {
    await findBestMaxCouponAccountForOrder({ id: 'chosen-test', selectedAccount: 'selected' });
    assert.ok(requests.length > 0, 'selected account was checked');
    const headers = requests.map(r => r.headers).join('\n');
    assert.match(headers, /selected_unique/);
    assert.doesNotMatch(headers, /first_unique|third_unique/);
  } finally { globalThis.fetch = original; }
});
