/**
 * v58 — AUTO 2-OFFER CLAIM ON EVERY JSON IMPORT + COMPACT VAULT + COPY JSON
 *
 * Boss ki shart:
 *  1. Koi bhi JSON import → har ID par DONO event offers auto activate
 *     (Breakfast `book-your-offer` + Dinner `pick-your-late-night-offer`),
 *     hamesha option #1 = "₹50 off on ₹199" (4 me se).
 *  2. 5 file ya 25 file → sab login + claim, ek compact list.
 *  3. Har account ek chhoti line, tap → poora detail, sabse NEECHE Copy button,
 *     copy me exact 7 fields: name, customerId, mobile, token, tid, sid, deviceId.
 *  4. Har account batata hai NEW vs ALREADY CLAIMED aur orders hain ya nahi.
 *  5. JSON me "order count 0" likha ho to wo MANA NAHI jayega — sirf LIVE check.
 */
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const views = await import('./account-views.js');
const store = await import('./store.js');
const intake = await import('./account-vault-intake.js');
const bridge = await import('./swiggy-bridge.js');

const dbAtStart = JSON.parse(JSON.stringify(store.getDb()));
const JWT = (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: '287113492', user_id: 287113492, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.jwt`;
})();

console.log('\n=== 1. Portable session JSON — exact 7 fields, exact order ===');
{
  const acc = { name: 'Bhai', tid: JWT, cookies: '_sid=sid123; _device_id=dev-abc-999', phone: '9580917901' };
  const json = views.buildPortableSessionJson(acc, 'acc_9580917901');
  check('7 keys exactly', Object.keys(json).length === 7, Object.keys(json).join(','));
  check('key order = name,customerId,mobile,token,tid,sid,deviceId',
    Object.keys(json).join(',') === 'name,customerId,mobile,token,tid,sid,deviceId', Object.keys(json).join(','));
  check('customerId recovered from tid JWT', json.customerId === '287113492', json.customerId);
  check('mobile from phone', json.mobile === '9580917901', json.mobile);
  check('sid from _sid cookie', json.sid === 'sid123', json.sid);
  check('deviceId from _device_id cookie', json.deviceId === 'dev-abc-999', json.deviceId);
  check('tid kept', json.tid === JWT);
  check('token falls back to tid', json.token === JWT);

  const text = views.portableSessionJsonText(acc, 'acc_9580917901');
  check('pretty JSON parses back', JSON.parse(text).customerId === '287113492');
  const compact = views.portableSessionJsonText(acc, 'acc_9580917901', { pretty: false });
  check('compact JSON has no newlines', !compact.includes('\n'));
}

console.log('\n=== 2. File ka "order count 0" kabhi trust nahi ===');
{
  const fromFile = { totalOrdersCount: 0, cachedTotalOrdersCount: 0, isZeroOrderAccount: true, orderCount: 0, previous_orders: 3, name: 'X', tid: JWT };
  const claims = views.detectedFileOrderClaims(fromFile);
  check('detects 5 order-count fields in file', claims.length === 5, claims.join('|'));

  const stripped = views.stripUntrustedOrderClaims(fromFile);
  check('totalOrdersCount stripped', !('totalOrdersCount' in stripped));
  check('isZeroOrderAccount stripped', !('isZeroOrderAccount' in stripped));
  check('orderCount stripped', !('orderCount' in stripped));
  check('name/tid preserved', stripped.name === 'X' && stripped.tid === JWT);

  const unverified = views.liveOrderTruth({ totalOrdersCount: 0, isZeroOrderAccount: true });
  check('unverified 0-order is NOT shown as 0 orders', unverified.totalOrders === null, String(unverified.totalOrders));
  check('unverified label asks for live check', /not checked live/i.test(unverified.label), unverified.label);
  check('fileClaimIgnored flag set', unverified.fileClaimIgnored === true);

  const liveZero = views.liveOrderTruth({ totalOrdersCount: 0, ordersVerifiedLive: true });
  check('LIVE 0 orders is allowed', liveZero.totalOrders === 0 && liveZero.zeroOrder === true);
  check('LIVE label says LIVE', /LIVE/.test(liveZero.label), liveZero.label);

  const liveThree = views.liveOrderTruth({ totalOrdersCount: 3, ordersVerifiedLive: true });
  check('LIVE 3 orders shown', liveThree.totalOrders === 3, String(liveThree.totalOrders));
}

console.log('\n=== 3. Offer truth: NEW vs ALREADY CLAIMED (option #1) ===');
{
  const fresh = views.offerClaimTruth({});
  check('no claim record → NEW', fresh.isNew === true && fresh.both === false);
  check('NEW label mentions claim pending', /NEW/.test(fresh.breakfast.label), fresh.breakfast.label);
  check('default offer value = 1', fresh.offerValue === 1, String(fresh.offerValue));
  check('default label ₹50 off on ₹199', fresh.offerLabel === '₹50 off on ₹199', fresh.offerLabel);

  const claimedBoth = views.offerClaimTruth({
    offerAutoActivation: {
      offerValue: 1, label: '₹50 off on ₹199', at: '2026-10-26T04:00:00.000Z',
      breakfast: { status: 'CLAIMED', discount: '₹50 off on ₹199' },
      lateNight: { status: 'CLAIMED', discount: '₹50 off on ₹199', alreadyActive: true }
    }
  });
  check('both claimed → both true', claimedBoth.both === true);
  check('alreadyActive late night says Already claimed', /Already claimed/i.test(claimedBoth.lateNight.label), claimedBoth.lateNight.label);
  check('breakfast claim label', /Claimed/.test(claimedBoth.breakfast.label), claimedBoth.breakfast.label);
  check('campaign URLs exposed', claimedBoth.campaigns.breakfast.includes('book-your-offer') && claimedBoth.campaigns.lateNight.includes('pick-your-late-night-offer'));

  const failedBoth = views.offerClaimTruth({
    offerAutoActivation: { breakfast: { status: 'FAILED', message: 'rate limited' }, lateNight: { status: 'FAILED' } }
  });
  check('failed claims are NOT reported as claimed', failedBoth.both === false);
  check('failure carries a real reason', /rate limited/.test(failedBoth.breakfast.label), failedBoth.breakfast.label);
}

console.log('\n=== 4. Compact list line + expanded detail with Copy JSON at bottom ===');
{
  const accounts = {
    acc_9580917901: { name: 'Bhai', phone: '9580917901', isLoggedIn: true, tid: JWT, ordersVerifiedLive: true, totalOrdersCount: 0, offerAutoActivation: { offerValue: 1, breakfast: { status: 'CLAIMED' }, lateNight: { status: 'CLAIMED' } } },
    acc_9999999999: { name: 'Dost', phone: '9999999999', isLoggedIn: true, tid: JWT }
  };
  const list = views.compactAccountListText(accounts, { activeKey: 'acc_9580917901' });
  check('header shows live/total', /2 live \/ 2 total/.test(list.text), list.text.split('\n')[1]);
  const rows = list.text.split('\n').filter((l) => /^\d+\./.test(l));
  check('one compact row per account', rows.length === 2, String(rows.length));
  check('active account starred', /★/.test(rows[0]), rows[0]);
  check('LIVE 0 orders row shows 0 ord', /0 ord/.test(rows[0]), rows[0]);
  check('unverified row shows ord ? (never 0)', /ord \?/.test(rows[1]), rows[1]);
  // Ab saare offer ka sach dikhta hai: 2 lage to "2/5", sab lage tabhi ✓.
  check('claimed row shows honest offer count (2/5)', /₹50 2\/5/.test(rows[0]), rows[0]);
  check('new row shows ₹50 new', /₹50 new/.test(rows[1]), rows[1]);
  check('phone masked', /95809•17901/.test(rows[0]), rows[0]);

  const detail = views.accountDetailText({ acc: accounts.acc_9580917901, key: 'acc_9580917901', activeKey: 'acc_9580917901' });
  check('detail shows LIVE orders line', /LIVE check/.test(detail.text), detail.text);
  // Ab detail chaaron offer ka line-by-line sach + score dikhata hai.
  check('detail shows offer score (2/5)', /2\/5 claimed/.test(detail.text), detail.text.split('\n').slice(4, 12).join(' | '));
  check('detail contains pre JSON block', /<pre><code class="language-json">/.test(detail.text));
  check('detail JSON has the 7 keys', Object.keys(JSON.parse(detail.json)).join(',') === 'name,customerId,mobile,token,tid,sid,deviceId');
  check('detail marks ACTIVE account', /\[ACTIVE\]/.test(detail.text));

  const unverDetail = views.accountDetailText({ acc: accounts.acc_9999999999, key: 'acc_9999999999' });
  check('unverified detail says file count not trusted', /File me jo order count/.test(unverDetail.text), unverDetail.text);
  check('unverified detail me saare offer NEW (claim pending)', /0\/5 claimed/.test(unverDetail.text) && (unverDetail.text.match(/claim pending/g) || []).length === 5, unverDetail.text.split('\n').slice(4, 12).join(' | '));
}

console.log('\n=== 5. Auto-activate: BOTH links, ALWAYS option 1 ===');
{
  check('EVENT_CAMPAIGN_URLS exported', typeof bridge.EVENT_CAMPAIGN_URLS?.breakfast === 'string' && bridge.EVENT_CAMPAIGN_URLS.breakfast.includes('book-your-offer'));
  check('late night URL exported', bridge.EVENT_CAMPAIGN_URLS.lateNight.includes('pick-your-late-night-offer'));
  check('PREFERRED_EVENT_OFFER_VALUE is 1', bridge.PREFERRED_EVENT_OFFER_VALUE === 1);
  check('PREFERRED_EVENT_OFFER_LABEL is ₹50 off on ₹199', bridge.PREFERRED_EVENT_OFFER_LABEL === '₹50 off on ₹199');
  check('autoActivateEventOffers exported', typeof bridge.autoActivateEventOffers === 'function');
  const opt1 = String(bridge.EVENT_OFFER_OPTIONS[1]?.shortLabel || '');
  check('EVENT_OFFER_OPTIONS[1] is the ₹50 Free Cash (>₹199) option', /₹50/.test(opt1) && /199/.test(opt1), JSON.stringify(bridge.EVENT_OFFER_OPTIONS[1]));

  const src = fs.readFileSync('./swiggy-bridge.js', 'utf8');
  // autoActivate ab chaar-offer engine ko call karta hai (dono raaste ek hi ledger).
  check('autoActivate chaar-offer engine se claim karta hai', /activateAllEventOffers\(account, \{ force, offerValue, fetchImpl, skipIfRunInFlight \}\)/.test(src));
  check('autoActivate pins offerValue: PREFERRED_EVENT_OFFER_VALUE', src.includes('offerValue: PREFERRED_EVENT_OFFER_VALUE'));
  check('campaign fetch uses exported URLs', src.includes('fetch(EVENT_CAMPAIGN_URLS.breakfast') && src.includes('fetch(EVENT_CAMPAIGN_URLS.lateNight'));
}

console.log('\n=== 6. Import: 5 files → every ID claimed with option 1, file counts ignored ===');
{
  const claimCalls = [];
  const files = [1, 2, 3, 4, 5].map((n) => ({
    fileName: `s${n}.json`,
    text: JSON.stringify({
      name: `User${n}`,
      phone: `95809179${String(n).padStart(2, '0')}`,
      tid: JWT,
      // The lie: every file claims a 0-order account.
      totalOrdersCount: 0,
      isZeroOrderAccount: true
    })
  }));

  // Fresh keys (avoid the shared db being polluted between runs)
  const res = await intake.ingestAndPersistRawAccountTexts(files, {
    verifyFn: async () => ({ valid: true, cookies: '_sid=x; _device_id=y' }),
    orderProfileFn: async () => ({ valid: true, ordersVerifiedLive: false, liveActiveOrdersCount: 0 }),
    claimOffersFn: async (account, opts) => {
      claimCalls.push({ key: account?.phone || account?.id, opts });
      return {
        ok: true, success: true, bothClaimed: true, offerValue: 1, label: '₹50 off on ₹199',
        at: '2026-10-26T04:00:00.000Z',
        breakfast: { status: 'CLAIMED', discount: '₹50 off on ₹199' },
        lateNight: { status: 'CLAIMED', discount: '₹50 off on ₹199' }
      };
    },
    syncVaultFn: async () => true,
    waitForClaims: true
  });

  check('5 accounts saved', res.savedAccounts.length === 5, String(res.savedAccounts.length));
  check('claim called for EVERY saved account', claimCalls.length === 5, String(claimCalls.length));
  // force:false — engine pehle GET se state padhta hai, isliye already-laga offer
  // par koi write nahi jata (double claim band) par galat reward PATCH se theek hota hai.
  check('claim honest mode (force:false, read-back verified)', claimCalls.every((c) => c.opts?.force === false && Number(c.opts?.offerValue) === 1));
  check('claim always option 1 (₹50 on ₹199)', claimCalls.every((c) => c.opts?.offerValue === 1), JSON.stringify(claimCalls.map((c) => c.opts?.offerValue)));

  const db = store.getDb();
  const saved = res.savedAccounts.map((s) => db.config.accounts[s.key]).filter(Boolean);
  check('no account kept the file-supplied 0 count', saved.every((a) => a.ordersVerifiedLive !== true), saved.map((a) => String(a.ordersVerifiedLive)).join(','));
  check('no account has totalOrdersCount from file', saved.every((a) => !('totalOrdersCount' in a) || a.orderCountSource === 'LIVE'), JSON.stringify(saved.map((a) => a.totalOrdersCount)));
  check('all marked UNVERIFIED', saved.every((a) => a.orderCountSource === 'UNVERIFIED'));
  check('ignored file claims recorded', saved.every((a) => Array.isArray(a.ignoredFileOrderClaims) && a.ignoredFileOrderClaims.length > 0), JSON.stringify(saved[0]?.ignoredFileOrderClaims));
  check('offerAutoActivation stored on every account', saved.every((a) => a.offerAutoActivation?.offerValue === 1));
  check('offerAutoActivation has BF + LN claimed', saved.every((a) => a.offerAutoActivation.breakfast.status === 'CLAIMED' && a.offerAutoActivation.lateNight.status === 'CLAIMED'));
  check('preferredOfferValue pinned to 1', saved.every((a) => a.preferredOfferValue === 1));

  const compact = views.compactAccountListText(db.config.accounts);
  check('vault rows never print a fake 0-orders badge', !/· 0 ord/.test(compact.text), compact.text.slice(0, 200));
  const claimed = views.offerClaimTruth(saved[0]);
  check('imported account reads ALREADY CLAIMED', claimed.both === true);

  check('portableAccounts returned for each saved ID', Array.isArray(res.portableAccounts) && res.portableAccounts.length === 5);
  check('portable JSON has exactly the 7 keys', Object.keys(res.portableAccounts[0].json).join(',') === 'name,customerId,mobile,token,tid,sid,deviceId');

  const msgs = intake.buildPortableAccountMessages(res);
  check('one message per account', msgs.length === 5, String(msgs.length));
  check('caption says ALREADY CLAIMED', /ALREADY CLAIMED/.test(msgs[0].caption), msgs[0].caption);
  check('caption says order count pending, never 0', /pending/.test(msgs[0].caption) && !/0 orders \(LIVE/.test(msgs[0].caption), msgs[0].caption);
  check('portable text parses to 7 keys', Object.keys(JSON.parse(msgs[0].jsonText)).length === 7);
}

console.log('\n=== 7. Live-verified import IS trusted ===');
{
  const res = await intake.ingestAndPersistRawAccountTexts(
    [{ fileName: 'live.json', text: JSON.stringify({ name: 'Live', phone: '9111111111', tid: JWT, totalOrdersCount: 0 }) }],
    {
      verifyFn: async () => ({ valid: true, cookies: '_sid=z' }),
      orderProfileFn: async () => ({ valid: true, ordersVerifiedLive: true, totalOrdersCount: 7, liveActiveOrdersCount: 1 }),
      claimOffersFn: async () => ({ ok: true, success: true, bothClaimed: true, offerValue: 1, breakfast: { status: 'CLAIMED' }, lateNight: { status: 'CLAIMED' } }),
      syncVaultFn: async () => true,
      waitForClaims: true
    }
  );
  const acc = store.getDb().config.accounts[res.savedAccounts[0].key];
  check('LIVE count 7 stored', acc.totalOrdersCount === 7, String(acc.totalOrdersCount));
  check('LIVE count marked verified', acc.ordersVerifiedLive === true);
  check('LIVE source tagged', acc.orderCountSource === 'LIVE');
  check('file 0 did not win', acc.isZeroOrderAccount === false);
  check('active orders stored', acc.liveActiveOrdersCount === 1);
  const truth = views.liveOrderTruth(acc);
  check('card shows 7 orders (LIVE)', truth.totalOrders === 7 && /LIVE/.test(truth.label), truth.label);
}

console.log('\n=== 8. store.js: importSessionJson ignores file order counts ===');
{
  const src = fs.readFileSync('./store.js', 'utf8');
  check('importSessionJson only writes order count behind ordersVerifiedLive (no bare totalOrdersCount branch)',
    !/typeof data\.totalOrdersCount === 'number' && data\.totalOrdersCount !== 999999 \? \{\s*\n\s*totalOrdersCount: data\.totalOrdersCount\s*\n\s*\} : \{\}\)/.test(src));
  check('verified branch tags orderCountSource LIVE', /ordersVerifiedLive: true,\s*\n\s*orderCountSource: 'LIVE'/.test(src));

  // Behavioural: a file that claims count 0 must not change an existing account.
  store.importSessionJson(JSON.stringify({ name: 'Keep', phone: '9222222222', tid: JWT, cookies: '_sid=k' }), 'acc_9222222222');
  const db1 = store.getDb();
  db1.config.accounts.acc_9222222222.totalOrdersCount = 4;
  db1.config.accounts.acc_9222222222.ordersVerifiedLive = true;
  store.saveDb(db1);
  store.importSessionJson(JSON.stringify({ name: 'Keep', phone: '9222222222', tid: JWT, cookies: '_sid=k2', totalOrdersCount: 0, isZeroOrderAccount: true }), 'acc_9222222222');
  const after = store.getDb().config.accounts.acc_9222222222;
  check('re-import with "0 order count" does not overwrite live count 4', after.totalOrdersCount === 4, String(after.totalOrdersCount));
  check('re-import does not flip account to zero-order', after.isZeroOrderAccount !== true, String(after.isZeroOrderAccount));
}

console.log('\n=== 9. index.js wiring: compact list, detail, live check, copy JSON ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('showFamilyAccounts uses compactAccountListText', /compactAccountListText\(accounts, \{/.test(src));
  check('account badges use liveOrderTruth (no raw cachedTotalOrdersCount badge)', !/const ordBadge1 = cnt1 === 0/.test(src) && /const t1 = liveOrderTruth\(a1\)/.test(src));
  check('detail card uses accountDetailText', /accountDetailText\(\{ acc, key, activeKey/.test(src));
  check('detail uses portableSessionJsonText', /portableSessionJsonText\(acc, key, \{ pretty: false \}\)/.test(src));
  check('detail shows Copy Session JSON button', /▤ Copy Session JSON/.test(src));
  check('detail shows Send .json button', /⬇ Send \.json/.test(src));
  check('Live Check button exists', /⟳ Live Check Orders/.test(src));
  check('live check handler registered', /bot\.action\(\/\^acc_live_orders_\(\.\+\)\$\/,/.test(src));
  check('copy json handler registered', /bot\.action\(\/\^acc_copy_json_\(\.\+\)\$\/,/.test(src));
  check('send json handler registered', /bot\.action\(\/\^acc_send_json_\(\.\+\)\$\/,/.test(src));
  check('send all json handler registered', /bot\.action\('boss_send_all_json',/.test(src));
  check('import chaaron offers claim karta hai offerValue 1 par', /autoActivateEventOffers\(accTarget, \{ force: false, offerValue: 1 \}\)/.test(src));
  check('pre-claim chaaron offer engine se (quickLock nahi)', /autoActivateEventOffers\(\{\s*\n?\s*id: savedKey/.test(src) && !/quickLockOnly: true, offerValue: 1, forcePatch: true/.test(src));
  check('zero-order gate removed from auto-claim', !/if \(accTarget\.isZeroOrderAccount \|\| accTarget\.totalOrdersCount === 0\) \{\s*\n\s*try \{\s*\n\s*const claimOut = await claimSwiggyBreakfastAndLateNightOffers/.test(src));
  check('login-time live check requires ordersVerifiedLive', /orderHistory\.ordersVerifiedLive === true/.test(src));
  check('bulk summary reports LIVE truth per account', /Order count sirf LIVE Swiggy check se/.test(src));
  check('bulk import sends one .json per account', /processedKeys\.slice\(0, 40\)/.test(src));
  const copyIdx = src.lastIndexOf('const copyRow = [];');
  check('login card has no "?? 0" order fallback', !/orderHistory\?\.totalOrdersCount \?\? knownOrders \?\? 0/.test(src));
  check('login card uses liveOrderTruth', /const liveTruth = liveOrderTruth\(/.test(src));
  check('offers never default to CLAIMED', !/offers\.lateNight \|\| \{ status: 'CLAIMED'/.test(src) && !/offers\.breakfast \|\| \{ status: 'CLAIMED'/.test(src));
  check('login card copy row is at the bottom too', /const copyRow = \[\];[\s\S]{0,900}keyboardButtons\.push\(copyRow\);\s*\n\s*keyboardButtons\.push\(\[\n\s*\{ text: 'Main Menu'/.test(src));
  check('login card JSON is the portable 7-field form', /const sessionJsonStr = portableSessionJsonText\(portableSource, targetAcc/.test(src));
  check('copy row is pushed at the BOTTOM (after all action rows, before Back/Main Menu)',
    copyIdx > src.lastIndexOf("text: 'Delete Account from Swiggy'") &&
    copyIdx < src.indexOf("{ text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' },", copyIdx) &&
    src.slice(copyIdx, copyIdx + 900).includes("buttons.push(copyRow)"));
}

console.log('\n=== 10. Copy button really copies (≤256 native, else chunked) ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('copy uses makeFullSessionCopyButton', /makeFullSessionCopyButton\(ctx, '▤ Copy Session JSON'/.test(src));
  check('long JSON is chunked into ≤250-char copyable pieces', /chunks\.push\(rest\.slice\(0, 250\)\)/.test(src));
  check('document fallback sends .json file', /filename: `\$\{phone\}\.json`/.test(src));
  const short = JSON.stringify({ a: 1 });
  check('short value fits native copy limit', short.length <= 256);
  const long = views.portableSessionJsonText({ name: 'X', tid: JWT, cookies: '_sid=abc; _device_id=def' }, 'acc_1', { pretty: false });
  check('full session JSON exceeds 256 → falls back to chunked/document', long.length > 256, String(long.length));
}

// ---- restore ----
{
  const db = store.getDb();
  db.config = JSON.parse(JSON.stringify(dbAtStart.config || {}));
  db.orders = JSON.parse(JSON.stringify(dbAtStart.orders || {}));
  if ('sessionVault' in dbAtStart) db.sessionVault = JSON.parse(JSON.stringify(dbAtStart.sessionVault || {}));
  store.saveDb(db);
}

console.log(`\n${'='.repeat(70)}`);
if (failed === 0) {
  console.log(`🏆 AUTO OFFER CLAIM + COPY JSON VERIFIED — ${passed}/${passed} checks passed`);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
}
process.exit(failed === 0 ? 0 : 1);
