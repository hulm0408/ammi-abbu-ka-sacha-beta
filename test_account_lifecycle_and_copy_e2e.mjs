import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
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
  findChromePath,
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
  console.log('🧪 LIVE E2E SUITE: LOGIN / LOGOUT / DELETE / RE-LOGIN / OFFER CLAIM / 1-CLICK FULL CODE COPY');
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

  // 2. Test 1-Click WebApp Copy Server in REAL Headless Chromium — verify byte-for-byte clipboard copy of ALL ~3,100 chars!
  const testSecret = 'test_bot_token_secret';
  const computeSig = (accKey) => crypto.createHmac('sha256', testSecret).update(`copy:${accKey}`).digest('hex').slice(0, 24);

  const copyServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const accKey = u.searchParams.get('acc') || '';
    const sig = u.searchParams.get('sig') || '';
    if (u.pathname !== '/copy' || !accKey || sig !== computeSig(accKey)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const exp = exportSessionJson(accKey);
    const fullCode = JSON.stringify(exp, null, 2);
    const safeEmbedded = JSON.stringify(fullCode).replace(/</g, '\\u003c');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><textarea id="ta" readonly></textarea><button id="btn">Copy</button><script>
      const CODE = ${safeEmbedded};
      const ta = document.getElementById('ta');
      ta.value = CODE;
      window.__COPIED_OK = false;
      async function copyAll() {
        try { await navigator.clipboard.writeText(CODE); window.__COPIED_OK = true; return; } catch (e) {}
        ta.focus(); ta.select(); ta.setSelectionRange(0, CODE.length);
        window.__COPIED_OK = document.execCommand('copy');
      }
      document.getElementById('btn').addEventListener('click', copyAll);
      window.addEventListener('load', () => { setTimeout(copyAll, 20); });
    </script></body></html>`);
  });

  await new Promise((resolve) => copyServer.listen(0, '127.0.0.1', resolve));
  const port = copyServer.address().port;

  // Unauthorized check
  const badRes = await fetch(`http://127.0.0.1:${port}/copy?acc=acc_9935123518&sig=invalid`);
  ok(badRes.status === 403, 'Tampered `/copy` signature strictly rejected with HTTP 403');

  // Real Chromium 1-Click Full Clipboard Copy verification
  const browser = await puppeteer.launch({
    executablePath: findChromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(`http://127.0.0.1:${port}`, ['clipboard-read', 'clipboard-write']);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/copy?acc=acc_9935123518&sig=${computeSig('acc_9935123518')}`, { waitUntil: 'load' });
    await page.click('#btn');
    await new Promise(r => setTimeout(r, 120));
    const clipboardContents = await page.evaluate(() => navigator.clipboard.readText());
    ok(clipboardContents === fullJsonStr, `1-Click Copy Button copied 100.0% FULL code byte-for-byte (${clipboardContents.length}/${fullJsonStr.length} chars)!`);
    const reparsed = JSON.parse(clipboardContents);
    ok(reparsed.cookies.includes('_session_tid=') && reparsed.phone === '9935123518', 'Copied JSON parses cleanly & contains complete `_session_tid` cookie');
  } finally {
    await browser.close();
    copyServer.close();
  }

  // 3. Test Re-Login into a cloned test account using that exact copied code -> Live Swiggy API verification!
  const testKey = 'acc_9999999991';
  const imported = importSessionJson(fullJsonStr, testKey);
  ok(imported.success === true && getDb().config.accounts[testKey]?.isLoggedIn === true, 'Full copied Session Code imported into fresh account slot');

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

  // 4. Test Logout -> Session stays safe in Vault -> Re-Login that SAME account with copied code works LIVE!
  permanentLogoutAccount(testKey);
  const afterLogout = getDb().config.accounts[testKey];
  ok(afterLogout.isLoggedIn === false && afterLogout.cookies === '', 'Logout clears active bot session cleanly');

  const vaultExportAfterLogout = exportSessionJson(testKey);
  ok(Boolean(vaultExportAfterLogout?.cookies?.includes('_session_tid=')), 'Copy Code still retrieves full session from Vault even after Logout');

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
  ok(liveVerify2.status === 200 && liveJson2.statusCode === 0, 'Logout did NOT destroy copied session on Swiggy — Re-Login works 100% LIVE!');

  // 5. Test Delete Account -> Tombstone blocks zombie resurrection -> Re-creating/Re-logging in same account clears tombstone!
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

  // 6. Live Offer Claim verification on BOTH live Swiggy accounts (`acc_9935123518` & `acc_6296591407`)
  const claim1 = await claimSwiggyBreakfastAndLateNightOffers(db.config.accounts.acc_9935123518);
  const claim2 = await claimSwiggyBreakfastAndLateNightOffers(db.config.accounts.acc_6296591407);
  ok(claim1.bothClaimed === true && claim2.bothClaimed === true, 'Live Breakfast & Late Night ₹50 OFF offers verified CLAIMED on BOTH active accounts!');

  console.log(`\n================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} LIFECYCLE + LIVE SWIGGY + CHROMIUM CLIPBOARD TESTS PASSED!`);
  console.log(`================================================================`);
} finally {
  fs.writeFileSync('./data/db.json', originalDbRaw, 'utf8');
  if (originalAccRaw !== null) fs.writeFileSync('./accounts.json', originalAccRaw, 'utf8');
}
