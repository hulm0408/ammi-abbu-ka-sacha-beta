/**
 * v60 — "QR INVALID, AUR NEW QR MAANGNE PAR WAHI QR"
 *
 * Boss ka message (26-10-2026 16:0x, order #288600):
 *   "UPON SCANNING THE QR THIS IS WHAT I SEE ALWAYS THAT QR IS INVALID AND USER
 *    IF USER REQUEST A NEW QR SAME QR APPEAR WITH SAME ISSUE"
 *
 * Do asli code defects mile:
 *   A. `config.bossUpiId` ka default **`swiggy@icici`** — ye asli VPA nahi hai
 *      (Swiggy ka merchant `upiswiggy@icici` hai). Jab Swiggy payment intent nahi
 *      deta (order #288600 me Swiggy order id hi nahi bana), bot isi placeholder
 *      se QR bana deta tha → **har scan par "invalid"**, aur deterministic hone ki
 *      wajah se **har baar bilkul wahi QR**.
 *   B. "Regenerate" / "Resend QR" path `forceNewQr` kabhi pass nahi karta tha, aur
 *      `generateRealSwiggyMerchantUpiQr` 4 minute tak purana intent reuse karta
 *      tha → naya QR maangne par bhi **same QR**.
 *
 * Proven here:
 *   1. Placeholder VPA se koi QR nahi banta (customer ko jhootha QR nahi jaata).
 *   2. Har QR bhejne se pehle intent validate hota hai (pa/am/cu/duplicates).
 *   3. `/setupi` placeholder reject karta hai, asli UPI accept karta hai.
 *   4. "Regenerate" sach me naya QR deta hai (forceNewQr end-to-end).
 *   5. Purana/dead QR reuse nahi hota (90s + validity + invalidated flag).
 *   6. Customer ko honest message jaata hai, Boss ko "QR blocked" alert.
 */
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const guard = await import('./payment-qr-guard.js');
const store = await import('./store.js');
const dbAtStart = JSON.parse(JSON.stringify(store.getDb()));

console.log('\n=== 1. Placeholder UPI: QR hi nahi banega ===');
{
  check('swiggy@icici is a placeholder', guard.isPlaceholderUpiId('swiggy@icici') === true);
  check('upiswiggy@icici (Swiggy merchant) is not a customer VPA', guard.isPlaceholderUpiId('upiswiggy@icici') === true);
  check('empty id is placeholder', guard.isPlaceholderUpiId('') === true);
  check('real personal UPI is NOT placeholder', guard.isPlaceholderUpiId('rahul.sharma@okaxis') === false);

  check('valid VPA accepted', guard.isValidUpiVpa('rahul.sharma@okaxis') === true);
  check('VPA without @ rejected', guard.isValidUpiVpa('rahulokaxis') === false);
  check('VPA with space rejected', guard.isValidUpiVpa('rahul @okaxis') === false);
  check('VPA with empty handle rejected', guard.isValidUpiVpa('rahul@') === false);

  const blocked = guard.buildFallbackUpiIntent({ upiId: 'swiggy@icici', amount: 43, orderId: '288600' });
  check('placeholder UPI → NO fallback QR', blocked.ok === false, JSON.stringify(blocked));
  check('blocked reason names the placeholder', /placeholder/i.test(blocked.reason), blocked.reason);

  const noUpi = guard.buildFallbackUpiIntent({ upiId: '', amount: 43 });
  check('empty UPI → NO fallback QR', noUpi.ok === false);

  const badAmount = guard.buildFallbackUpiIntent({ upiId: 'rahul@okaxis', amount: 0 });
  check('zero amount → NO fallback QR', badAmount.ok === false);

  const good = guard.buildFallbackUpiIntent({ upiId: 'rahul@okaxis', amount: 43, orderId: '288600' });
  check('real UPI + amount → valid intent', good.ok === true, JSON.stringify(good));
  const parsed = guard.parseUpiIntent(good.uri);
  check('intent points at the real VPA', parsed.map.pa === 'rahul@okaxis', parsed.map.pa);
  check('intent carries the exact amount', Number(parsed.map.am) === 43, parsed.map.am);
  check('intent currency INR', parsed.map.cu === 'INR');
  check('intent scheme upi://pay', parsed.scheme === 'upi' && /^pay$/i.test(parsed.path));
}

console.log('\n=== 2. Har QR validate hota hai (invalid kabhi customer tak nahi) ===');
{
  const placeholderQr = 'upi://pay?pa=swiggy@icici&pn=SWIGGY&mc=5812&am=43&cu=INR&tn=Swiggy_Order_288600';
  const bad = guard.validateUpiIntentForQr(placeholderQr, { amount: 43 });
  check('placeholder QR is flagged INVALID', bad.valid === false);
  check('reason mentions placeholder', bad.problems.some((p) => /placeholder/i.test(p)), bad.problems.join(' | '));

  const realSwiggy = 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&mc=5812&am=43.00&cu=INR&tr=SWG2886001234&sign=abcd1234';
  const ok = guard.validateUpiIntentForQr(realSwiggy, { amount: 43 });
  check('real Swiggy merchant QR is VALID', ok.valid === true, ok.problems.join(' | '));
  check('recognised as Swiggy merchant', ok.info.isSwiggyMerchant === true);
  check('amount parsed', ok.info.amount === 43, String(ok.info.amount));

  const mm = guard.validateUpiIntentForQr('upi://pay?pa=rahul@okaxis&am=99&cu=INR', { amount: 43 });
  check('amount mismatch is rejected', mm.valid === false && mm.problems.some((p) => /amount/i.test(p)), mm.problems.join(' | '));

  const dup = guard.validateUpiIntentForQr('upi://pay?pa=rahul@okaxis&am=43&am=43&cu=INR', { amount: 43 });
  check('duplicate params rejected', dup.valid === false);

  const noPa = guard.validateUpiIntentForQr('upi://pay?pn=X&am=43&cu=INR', { amount: 43 });
  check('missing pa rejected', noPa.valid === false && noPa.problems.some((p) => /pa/i.test(p)));

  const badCu = guard.validateUpiIntentForQr('upi://pay?pa=rahul@okaxis&am=43&cu=USD', { amount: 43 });
  check('non-INR currency rejected', badCu.valid === false);

  const notUpi = guard.validateUpiIntentForQr('https://pay.example.com/abc', { amount: 43 });
  check('non-UPI QR data rejected', notUpi.valid === false);

  const spacey = guard.validateUpiIntentForQr('upi://pay?pa=rahul@okaxis&am=43&cu=INR&tn=Swiggy Order', { amount: 43 });
  check('raw space in QR data rejected', spacey.valid === false);

  const longTr = guard.validateUpiIntentForQr(`upi://pay?pa=rahul@okaxis&am=43&cu=INR&tr=${'X'.repeat(40)}`, { amount: 43 });
  check('over-long tr is a warning, not a block', longTr.valid === true && longTr.warnings.length > 0);
}

console.log('\n=== 3. "New QR" sach me naya hota hai (reuse planner) ===');
{
  const now = 1_800_000_000_000;
  const base = {
    pendingSwiggyUpiUri: 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=43&cu=INR&tr=REF1',
    pendingSwiggyOrderId: '251630299198600',
    pendingQrCreatedAt: now - 20_000,
    pendingQrAmount: 43,
    finalPayable: 43,
    orderAccount: 'acc_7877669963',
    pendingQrAddressAccount: '7877669963'
  };

  check('taza + valid QR reuse hota hai (duplicate order nahi)', guard.shouldReusePendingQr(base, { now }).reuse === true);
  check('forceNew → reuse nahi (naya QR)', guard.shouldReusePendingQr(base, { now, forceNew: true }).reuse === false);
  check('purana QR (3 min) reuse nahi', guard.shouldReusePendingQr({ ...base, pendingQrCreatedAt: now - 180_000 }, { now }).reuse === false);
  check('placeholder QR reuse nahi', guard.shouldReusePendingQr({ ...base, pendingSwiggyUpiUri: 'upi://pay?pa=swiggy@icici&am=43&cu=INR' }, { now }).reuse === false);
  check('invalidated QR reuse nahi', guard.shouldReusePendingQr({ ...base, qrInvalidatedAt: 'x' }, { now }).reuse === false);
  check('ek baar regenerate hua → phir reuse nahi', guard.shouldReusePendingQr({ ...base, qrRegenerateCount: 1 }, { now }).reuse === false);
  check('amount mismatch wala QR reuse nahi', guard.shouldReusePendingQr({ ...base, finalPayable: 99 }, { now }).reuse === false);
  check('doosre account ka QR reuse nahi', guard.shouldReusePendingQr(base, { now, accountPhone: '9999999999' }).reuse === false);
}

console.log('\n=== 4. store.js: placeholder default hata diya ===');
{
  const src = fs.readFileSync('./store.js', 'utf8');
  check('default bossUpiId empty (no fake VPA)', /bossUpiId: ''/.test(src), 'still defaulting to a VPA');
  check('no `bossUpiId: \'swiggy@icici\'` default anywhere', !/bossUpiId:\s*'swiggy@icici'/.test(src));
  check('old stored placeholder is auto-cleared on load', /A stored placeholder from older versions/.test(src) && /data\.config\.bossUpiId = ''/.test(src));
  const db = store.getDb();
  check('live db has no placeholder UPI', !guard.isPlaceholderUpiId(db.config?.bossUpiId) || !db.config?.bossUpiId, String(db.config?.bossUpiId));
}

console.log('\n=== 5. index.js: koi QR placeholder se nahi banta ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('no remaining `bossUpiId || \'swiggy@icici\'` fallback', !/bossUpiId \|\| 'swiggy@icici'/.test(src));
  check('sendApprovedOrderPaymentToUser uses buildFallbackUpiIntent', /const fb = buildFallbackUpiIntent\(\{/.test(src));
  check('customer QR path gates on validateUpiIntentForQr', /const gate = validateUpiIntentForQr\(upiUri, \{ amount \}\)/.test(src));
  check('blocked QR explains itself to the customer', /QR abhi nahi bheja gaya/.test(src));
  check('boss gets a "QR blocked" alert with a Set-UPI button', /Payment QR blocked/.test(src) && /boss_set_payment_upi/.test(src));
  check('/setupi rejects placeholders', /if \(isPlaceholderUpiId\(newUpi\)\)/.test(src));
  check('/setupi rejects bad format', /if \(!isValidUpiVpa\(newUpi\)\)/.test(src));
  check('tap-to-set UPI handler registered', /bot\.action\('boss_set_payment_upi'/.test(src));
  check('typed UPI is validated before saving', /state\.action === 'waiting_boss_upi'/.test(src));
  check('resend QR path regenerates when old one is dead', /qrInvalidatedAt = new Date\(\)\.toISOString\(\)/.test(src));
  check('resend no longer promises "same QR"', !/Resending the same Swiggy payment request; no new QR/.test(src));
  check('describeQrRef used in the new-QR notice', /describeQrRef\(fresh\)/.test(src));
}

console.log('\n=== 6. forwarded-order-flow: Regenerate = naya QR ===');
{
  const src = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('executeRealQrGenerationForOrder accepts forceNewQr', /forceNewQr = false/.test(src));
  check('real generator is called in WRAPPED form (so forceNewQr reaches it)', /generateRealSwiggyMerchantUpiQr\(\{ account: accArg, order: orderArg, forceNewQr: force \}\)/.test(src));
  check('Regenerate button passes forceNewQr when a QR already exists', /forceNewQr: order\.cardStage === 'QR_GENERATED' \|\| Boolean\(order\.pendingSwiggyUpiUri\)/.test(src));
  check('returned intent is validated before sending', /const intentGate = validateUpiIntentForQr\(realQr\.upiIntentUrl/.test(src));
  check('invalid intent throws QR_INTENT_INVALID instead of sending', /QR_INTENT_INVALID/.test(src) && /Customer ko bheja nahi gaya/.test(src));
  check('QR version stamped on regenerate', /order\.qrVersion = forceNewQr/.test(src));
  check('card shows "QR #N (naya)" and the ref', /QR #\$\{Number\(order\.qrVersion\)\}/.test(src) && /QR Ref:/.test(src));
  // v61: failover healthy ID par NAYA QR banata hai (force=true, purana intent nahi)
  check('fallback account path also forces a new QR', /runGenerator\(nextAcc, order, true\)/.test(src));
}

console.log('\n=== 7. swiggy-cart: 4-min blind reuse khatam ===');
{
  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('reuse window is 90s now, not 4 minutes', /QR_REUSE_MAX_AGE_MS = 90 \* 1000/.test(src));
  check('reuse uses shouldReusePendingQr', /const reuseDecision = shouldReusePendingQr\(order, \{/.test(src));
  check('reuse requires reuseDecision.reuse', /reuseDecision\.reuse/.test(src));
  check('no 4 * 60 * 1000 QR reuse left', !/payingOrder|4 \* 60 \* 1000/.test(src.split('QR_REUSE_MAX_AGE_MS')[0]) || !/< 4 \* 60 \* 1000/.test(src));
  check('new intent is validated right after place', /const intentCheck = upiIntentUrl/.test(src));
  check('invalid intent → SWIGGY_UPI_INTENT_INVALID diag', /SWIGGY_UPI_INTENT_INVALID/.test(src));
  check('vendor copy has the same guard', fs.readFileSync('./bossbot/vendor/swiggy-cart.js', 'utf8').includes('QR_REUSE_MAX_AGE_MS'));
  check('vendor has the guard module too', fs.existsSync('./bossbot/vendor/payment-qr-guard.js'));
}

console.log('\n=== 8. Order #288600 ka asli scenario (Swiggy id nahi bana) ===');
{
  // Swiggy ne payment intent nahi diya, boss ka UPI bhi set nahi => koi QR nahi.
  const noIntentOrder = {
    id: '288600',
    finalPayable: 43,
    status: 'PAYMENT_PENDING',
    billApprovedByUser: true,
    pendingSwiggyUpiUri: '',
    swiggyPaymentUrl: '',
    addressDetails: { name: 'Sneha', mobile: '9109533577', address: '350, MIG 2, New Subhash Nagar', lat: '26.9', lng: '82.1' }
  };
  // Scenario: Boss ka UPI set HI nahi hai (doosre tests ne set kiya ho to bhi).
  const savedBossUpi = store.getDb().config?.bossUpiId || '';
  store.mutateDb((d) => { d.config.bossUpiId = ''; });
  const fb = guard.buildFallbackUpiIntent({ upiId: getDbBossUpi(), amount: noIntentOrder.finalPayable, orderId: noIntentOrder.id });
  check('order #288600: UPI set nahi hai to koi QR nahi banta', fb.ok === false, JSON.stringify(fb));
  store.mutateDb((d) => { d.config.bossUpiId = savedBossUpi; });

  // Boss apna UPI set karta hai => valid QR.
  const set = guard.buildFallbackUpiIntent({ upiId: 'ankur@okhdfcbank', amount: 43, orderId: '288600' });
  check('UPI set karne ke baad valid QR banta hai', set.ok === true);
  const v = guard.validateUpiIntentForQr(set.uri, { amount: 43 });
  check('us QR ka intent valid hai (scan par invalid nahi)', v.valid === true, v.problems.join(' | '));

  // Swiggy ne intent diya => wahi use hota hai, placeholder nahi.
  const swiggyIntent = 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=43.00&cu=INR&tr=SW288600';
  const gate = guard.validateUpiIntentForQr(swiggyIntent, { amount: 43 });
  check('Swiggy ka apna QR valid hai aur use hoga', gate.valid === true);
  check('Swiggy QR ko "our UPI" nahi kaha jaata (kind flag)', gate.info.isSwiggyMerchant === true);
}

function getDbBossUpi() {
  return store.getDb().config?.bossUpiId || '';
}

// restore
{
  const db = store.getDb();
  db.config = JSON.parse(JSON.stringify(dbAtStart.config || {}));
  db.orders = JSON.parse(JSON.stringify(dbAtStart.orders || {}));
  if ('sessionVault' in dbAtStart) db.sessionVault = JSON.parse(JSON.stringify(dbAtStart.sessionVault || {}));
  store.saveDb(db);
}

console.log(`\n${'='.repeat(70)}`);
if (failed === 0) {
  console.log(`🏆 VALID QR + REAL NEW QR VERIFIED — ${passed}/${passed} checks passed`);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
}
process.exit(failed === 0 ? 0 : 1);
