import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getDb,
  saveDb,
  createAccount,
  updateAccount,
  deleteAccount,
  permanentLogoutAccount,
  exportSessionJson,
  importSessionJson,
  getActiveOrderAccountKey,
  cleanEssentialSwiggyCookies
} from './store.js';
import {
  sanitizeSwiggyName,
  stripStaleWafCookie,
  claimSwiggyBreakfastAndLateNightOffers
} from './swiggy-bridge.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ [PASS ${String(passed).padStart(2, '0')}] ${msg}`);
}

const originalDbRaw = fs.readFileSync('./data/db.json', 'utf8');
const originalAccRaw = fs.existsSync('./accounts.json') ? fs.readFileSync('./accounts.json', 'utf8') : null;

try {
  console.log('================================================================');
  console.log('🧪 LIVE E2E SUITE: LOGIN / LOGOUT / DELETE / RE-LOGIN / OFFER CLAIM');
  console.log('================================================================\n');

  const db = getDb();
  const realAcc = db.config.accounts.acc_9935123518;
  ok(Boolean(realAcc && realAcc.cookies), 'Live reference Swiggy account acc_9935123518 loaded');

  // 1. Verify full export includes complete auth cookies (`_session_tid`, `tid`, `token`, `_sid`, `_device_id`) and strips analytics/WAF bloat
  const exported = exportSessionJson('acc_9935123518');
  const fullJsonStr = JSON.stringify(exported, null, 2);
  const compactJsonStr = JSON.stringify(exported);
  ok(Boolean(exported?.cookies && exported.cookies.includes('_session_tid=')), 'exportSessionJson preserves FULL `_session_tid` auth cookie');
  ok(!exported.cookies.includes('aws-waf-token=') && !exported.cookies.includes('_ga='), 'exportSessionJson strips stale `aws-waf-token` & GA bloat');
  ok(fullJsonStr.length < 3900, `Full formatted Session JSON fits inside Telegram 4096-char single message (${fullJsonStr.length} chars)`);
  ok(compactJsonStr.length < 3600, `Compact Session JSON fits cleanly (${compactJsonStr.length} chars)`);

  // 2. Test Re-Login into a cloned test account using exported session JSON -> Live Swiggy API verification!
  const testKey = 'acc_9999999991';
  const imported = importSessionJson(fullJsonStr, testKey);
  ok(imported.success === true && getDb().config.accounts[testKey]?.isLoggedIn === true, 'Exported Session JSON imported into fresh account slot');

  const reimportedAcc = getDb().config.accounts[testKey];
  const liveVerify1 = await fetch('https://www.swiggy.com/dapi/order/all', {
    headers: {
      'Cookie': stripStaleWafCookie(reimportedAcc.cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.swiggy.com/my-account'
    }
  });
  const liveJson1 = await liveVerify1.json();
  ok(liveVerify1.status === 200 && liveJson1.statusCode === 0, 'Imported session authenticates LIVE on Swiggy servers (`statusCode: 0`)');

  // 3. Test Logout -> Session stays safe in Vault -> Re-Login that SAME account with exported code works LIVE!
  permanentLogoutAccount(testKey);
  const afterLogout = getDb().config.accounts[testKey];
  ok(afterLogout.isLoggedIn === false && afterLogout.cookies === '', 'Logout clears active bot session cleanly');

  const vaultExportAfterLogout = exportSessionJson(testKey);
  ok(Boolean(vaultExportAfterLogout?.cookies?.includes('_session_tid=')), 'Session export still retrieves full credentials from Vault after Logout');

  const reloginRes = importSessionJson(fullJsonStr, testKey);
  ok(reloginRes.success === true && getDb().config.accounts[testKey].isLoggedIn === true, 'Re-Login after Logout succeeds cleanly on same account');

  const liveVerify2 = await fetch('https://www.swiggy.com/dapi/order/all', {
    headers: {
      'Cookie': stripStaleWafCookie(getDb().config.accounts[testKey].cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.swiggy.com/my-account'
    }
  });
  const liveJson2 = await liveVerify2.json();
  ok(liveVerify2.status === 200 && liveJson2.statusCode === 0, 'Logout did NOT destroy vaulted session on Swiggy — Re-Login works LIVE!');

  // 4. Test Delete Account -> Tombstone blocks zombie resurrection -> Re-creating/Re-logging in same account clears tombstone!
  const deleted = deleteAccount(testKey, { purgeVault: true });
  ok(deleted === true && !getDb().config.accounts[testKey], 'Account deleted cleanly from Bot DB & Vault');
  ok(getDb().config.deletedAccounts[testKey] === true, 'Deleted tombstone recorded so restart never resurrects deleted account');
  ok(getActiveOrderAccountKey() !== testKey, 'Active Order Hub automatically switched away from deleted account');

  // Re-create / Re-login same deleted account
  createAccount(testKey, 'ReCreated User (User 1) (User 2)', '9999999991');
  ok(!getDb().config.deletedAccounts[testKey], 'Re-creating deleted account clears tombstone cleanly');
  ok(sanitizeSwiggyName('prithvi (User 1) (User 2)') === 'prithvi', 'sanitizeSwiggyName strips stacked `(User X)` tags cleanly on re-login');

  deleteAccount(testKey, { purgeVault: true });
  delete db.config?.deletedAccounts?.[testKey];

  // 5. Live Offer Claim verification on BOTH live Swiggy accounts (`acc_9935123518` & `acc_6296591407`)
  const claim1 = await claimSwiggyBreakfastAndLateNightOffers(db.config.accounts.acc_9935123518);
  const claim2 = await claimSwiggyBreakfastAndLateNightOffers(db.config.accounts.acc_6296591407);
  ok(claim1.bothClaimed === true && claim2.bothClaimed === true, 'Live Breakfast & Late Night ₹50 OFF offers verified CLAIMED on BOTH active accounts!');

  console.log(`\n================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} LIFECYCLE + LIVE SWIGGY TESTS PASSED!`);
  console.log(`================================================================`);
} finally {
  fs.writeFileSync('./data/db.json', originalDbRaw, 'utf8');
  if (originalAccRaw !== null) fs.writeFileSync('./accounts.json', originalAccRaw, 'utf8');
}
