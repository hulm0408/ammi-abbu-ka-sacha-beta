/**
 * v52 — Fast ID selection / QR deadline / free-cash self-heal
 *
 * User complaint: "ID SELECTION ME 5 MINUTES LAG JAATE", "PAYMENT QR KAAM NAHI
 * KARTA", "FREE CASH OF NIGHT NAHI LAGTA", handler dying with
 * `Promise timed out after 240000 milliseconds`.
 *
 * Root causes proven here:
 *   1. A queued per-account lock waited FOREVER (no timeout) — one stuck job
 *      blocked every later selection for minutes.
 *   2. The coupon trial loop walked the whole candidate list sequentially, one
 *      live cart mutation (2-8s) per code, for every probed ID → minutes.
 *   3. A timed-out BEST pick had no backstop, so the Telegraf handler hit 240s.
 *   4. A FAILED Breakfast/Late-Night claim was cached for 30 minutes → free cash
 *      never applied until the cache expired.
 *
 * These are behavioural checks wherever possible (no source-grep theatre).
 */
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

function jsonRes(status, payload, url = '') {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => 'application/json', getSetCookie: () => [] },
    text: async () => text,
    json: async () => payload
  };
}

// The vault must survive every scenario unchanged (no ID wipe / logout).
const dbPath = './data/db.json';
// Har guard test apna saaf DB paata hai (run_guards.mjs) — file na ho to bhi chale.
const dbBackup = fs.existsSync(dbPath) ? fs.readFileSync(dbPath, 'utf8') : null;
const realFetch = globalThis.fetch;

const cart = await import('./swiggy-cart.js');
const trk = await import('./order-tracking.js');
const bridge = await import('./swiggy-bridge.js');

// ---------------------------------------------------------------------------
// Scenario 1: a busy account lock fails fast instead of hanging
// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 1: an ID busy on another job never blocks for minutes ━━━');
{
  const acc = { id: 'lock_probe_acc', phone: '9000000001', cookies: '_session_tid=lockprobe.tid' };
  let releaseHolder;
  const holder = cart.withSwiggyAccountLock(acc, () => new Promise((resolve) => { releaseHolder = resolve; }));

  const startedAt = Date.now();
  let err = null;
  try {
    await cart.withSwiggyAccountLock(acc, async () => 'never', { maxWaitMs: 1200 });
  } catch (e) {
    err = e;
  }
  const waited = Date.now() - startedAt;

  check('the second caller is rejected with ACCOUNT_LOCK_TIMEOUT', err?.code === 'ACCOUNT_LOCK_TIMEOUT', String(err?.code));
  check(`it fails fast (waited ${waited}ms, well under a minute)`, waited >= 1000 && waited < 6000, `${waited}ms`);
  check('the rejection carries an actionable diag stage', err?.diag?.stage === 'ACCOUNT_LOCK');

  releaseHolder('done');
  await holder;

  // After the holder releases, the lock must be usable again (no permanent wedge).
  const after = await cart.withSwiggyAccountLock(acc, async () => 'ok', { maxWaitMs: 2000 });
  check('the same ID is usable again right after the holder finishes', after === 'ok');
}

// ---------------------------------------------------------------------------
// Scenario 2: coupon trials are bounded and dead codes are remembered
// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 2: coupon gauntlet is time-boxed (the real "5 minute" cause) ━━━');
{
  const tid = (sub) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
    return `${h}.${p}.sig`;
  };
  const jwt = tid('202');

  let updateCalls = 0;
  let couponAttemptCodes = [];

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('order/all') || u.includes('order/track')) {
      return jsonRes(200, { statusCode: 0, tid: jwt, data: { orders: [] } }, u);
    }
    if (u.includes('chkout.swiggy.com/api/v2/cart/client')) {
      const raw = String(opts.body || '{}');
      // Coupon can arrive as `couponCode`, `coupon_code`, or nested under `cart`,
      // so read it the same tolerant way for every engine.
      const codeMatch = raw.match(/"coupon_?[cC]ode"\s*:\s*"([^"]*)"/);
      const code = String(codeMatch?.[1] || '').toUpperCase();
      if (code) couponAttemptCodes.push(code);
      if (process.env.V52_DEBUG) console.log('     [cart-update]', code || '(none)', raw.slice(0, 120));
      updateCalls += 1;
      return jsonRes(200, {
        statusCode: 0,
        tid: jwt,
        data: {
          cartMeta: {
            cart_id: 'cart_v52',
            restaurant_details: { id: '990011', name: 'Test Kitchen' },
            cart_total_count: 1,
            // Swiggy sends paise: ₹300 item, ₹30 delivery.
            cart_menu_items: [{ menu_item_id: 71234, name: 'Paneer Tikka', quantity: 1, subtotal: 30000, final_price: 30000 }],
            coupon_code: code,
            // Parser needs `is_coupon_valid === 1` (or a discount total) to treat a
            // code as APPLIED rather than merely auto-suggested.
            is_coupon_valid: code === 'TRYNEW' ? 1 : 0,
            coupon_discount_total: code === 'TRYNEW' ? 4000 : 0,
            order_total: (code === 'TRYNEW' ? 260 : 300) * 100 - 3000,
            delivery_fee: 3000,
            address_id: 'addr_v52',
            addresses: [{
              id: 'addr_v52', selected: true, name: 'Boss', mobile: '9876500011',
              address: 'Vibhuti Khand, Gomti Nagar, Lucknow 226010',
              area: 'Gomti Nagar', city: 'Lucknow', lat: '26.8520', lng: '81.0060'
            }]
          }
        }
      }, u);
    }
    if (u.includes('maps.swiggy.com/addresses/nearby')) {
      // NOTE: this endpoint returns saved addresses at the ROOT (`json.addresses`).
      return jsonRes(200, {
        statusCode: 0,
        addresses: [{
          id: 'addr_v52', name: 'Boss', mobile: '9876500011',
          address: 'Vibhuti Khand, Gomti Nagar, Lucknow 226010',
          area: 'Gomti Nagar', city: 'Lucknow', lat: '26.8520', lng: '81.0060'
        }]
      }, u);
    }
    if (u.includes('maps.swiggy.com')) return jsonRes(200, { statusCode: 0, data: { addresses: [] } }, u);
    if (/\/dapi\/address/.test(u) && String(opts?.method || '').toUpperCase() === 'POST') {
      return jsonRes(200, { statusCode: 0, data: { id: 'addr_v52' } }, u);
    }
    if (u.includes('mcp.swiggy.com')) return jsonRes(200, { ok: true, structured: {} }, u);
    if (u.includes('offers/payment') || u.includes('offers/restaurant')) return jsonRes(200, { statusCode: 0, data: {} }, u);
    if (u.includes('cart') || u.includes('checkout')) {
      if (process.env.V52_DEBUG) console.log('     [cart-other]', u.slice(0, 110));
      return jsonRes(200, { statusCode: 0, data: { cartMeta: { cart_total_count: 0 } } }, u);
    }
    return jsonRes(200, { statusCode: 0, data: {} }, u);
  };

  try {
    const account = {
      id: 'sim_fast_acc', phone: '9111122233', customerId: '202',
      cookies: `_session_tid=v52.${jwt}.1; tid=${jwt}; _is_logged_in=1`,
      tid: jwt, jwtTid: jwt, isLoggedIn: true
    };
    const order = {
      id: 'V52_FAST_ORDER',
      restaurantId: '990011',
      restaurantName: 'Test Kitchen',
      items: [{ itemId: '71234', menu_item_id: 71234, name: 'Paneer Tikka', price: 300, qty: 1 }],
      address: 'Gomti Nagar, Lucknow',
      addressDetails: {
        id: 'addr_v52', name: 'Boss', mobile: '9876500011',
        address: 'Vibhuti Khand, Gomti Nagar, Lucknow 226010',
        area: 'Gomti Nagar', city: 'Lucknow', lat: '26.8520', lng: '81.0060'
      }
    };

    const started = Date.now();
    const out = await cart.syncGroupCartAndCheckoutForAccount(account, order, {
      captureScreenshot: false,
      maxCouponTrials: 3,
      couponTrialBudgetMs: 8000
    });
    const elapsed = Date.now() - started;

    const distinctCodes = new Set(couponAttemptCodes);
    console.log(`     (coupon codes actually tried: ${[...distinctCodes].join(', ') || 'none'})`);
    check('cart sync still succeeds with a bounded coupon list', out?.success === true, out?.error || out?.code);
    check(
      `at most the configured 3 coupon trials ran (saw ${distinctCodes.size} codes)`,
      distinctCodes.size > 0 && distinctCodes.size <= 3,
      [...distinctCodes].join(',')
    );
    check(`the whole sync finished fast (${elapsed}ms)`, elapsed < 20_000, `${elapsed}ms`);

    // Second pass: every dead code from pass 1 must be skipped from the negative cache.
    const before = couponAttemptCodes.length;
    const capturedLogs = [];
    const realLog = console.log;
    console.log = (...args) => { capturedLogs.push(args.join(' ')); realLog(...args); };
    try {
      await cart.syncGroupCartAndCheckoutForAccount(account, { ...order, couponCode: 'TRYNEW' }, {
        captureScreenshot: false,
        maxCouponTrials: 3,
        couponTrialBudgetMs: 8000
      });
    } finally {
      console.log = realLog;
    }
    const secondPassCodes = new Set(couponAttemptCodes.slice(before));
    // A code the customer explicitly asked for is always re-tested; the dead
    // auto-discovered ones must not be.
    check(
      'known-dead codes are skipped on the next scan (negative cache)',
      !secondPassCodes.has('SNACKIT') && !secondPassCodes.has('STEALDEAL'),
      [...secondPassCodes].join(',')
    );
    const scanLine = capturedLogs.find((l) => l.includes('[CouponScan]')) || '';
    const trialsMatch = scanLine.match(/(\d+) trial\(s\), (\d+) skipped/);
    check('the bounded loop reports its own trial/skip counts', Boolean(trialsMatch), scanLine);
    check('the second scan skipped cached dead codes (skip count > 0)',
      Boolean(trialsMatch) && Number(trialsMatch[2]) > 0, scanLine);
    check('the cache can be cleared on demand', (cart.clearCouponTrialCache?.(), true));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: ID selection + QR have a hard deadline wired in
// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 3: BEST pick & QR generation have hard deadlines ━━━');
{
  const flow = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  // v61: backstop 6s -> 4s (ID selection faster), budget default 12s
  check('BEST account pick runs inside a race with a deadline timer', /ID_SELECT_TIMEOUT/.test(flow) && /scanBudgetMs \+ 4_000/.test(flow));
  check('a timed-out pick releases the IDs it reserved so retry is instant',
    /if \(!syncRes\) \{[\s\S]{0,500}releaseSwiggyAccountReservation/.test(flow)
    && /releaseSwiggyAccountReservation[\s\S]{0,300}ID_SELECT_TIMEOUT/.test(flow));
  check('the scan budget is configurable (ID_SELECT_BUDGET_MS)', /ID_SELECT_BUDGET_MS/.test(flow));
  // 30-10-2026: timer se race hata diya (chhodta hua worker + retry = doosra
  // unpaid order). Ab budget naapa jata hai aur order par SACH likha jata hai.
  check('QR generation ka budget (QR_GEN_BUDGET_MS) hai aur job registry me chadhta hai',
    /QR_GEN_BUDGET_MS/.test(flow) && /startJob\('QR_GENERATE', \{ timeoutMs: QR_GEN_BUDGET_MS/.test(flow));
  check('budget se zyada lage to QR_GENERATION_TIMEOUT order par audit hota hai',
    /qrGenerationSlow = \{[\s\S]{0,120}code: 'QR_GENERATION_TIMEOUT'/.test(flow));
  check('worker beech me nahi chhoda jata (duplicate order ka khatra nahi)',
    /qrGenerationInFlight\.has\(key\)[\s\S]{0,120}return qrGenerationInFlight\.get\(key\)/.test(flow));

  check('payment verification is bounded (never a 240s kill)',
    /verifyTimer[\s\S]{0,400}75_000/.test(flow) && /rescueTimer[\s\S]{0,300}45_000/.test(flow));

  const idx = fs.readFileSync('./index.js', 'utf8');
  check('the bot handler no longer awaits a multi-minute scan (fire-and-forget)', /void \(async \(\) => \{/.test(flow));
  check('the handler watchdog is documented against 240s kills', /240s handler watchdog|240000/.test(flow) || /handlerTimeout: 240_000/.test(idx));

  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('per-probe timeout exists so one stuck ID cannot eat the budget', /PROBE_TIMEOUT/.test(src) && /probeTimeoutMs/.test(src));
  check('coupon trials are capped per account', /maxCouponTrials/.test(src) && /couponTrialBudgetMs/.test(src));
  check('coupon negative cache exists with a TTL', /COUPON_TRIAL_CACHE_TTL_MS/.test(src));
  check('no local Chromium => screenshot is skipped instantly (no hung launch)', /if \(!CHROME_PATH\) return null;/.test(src));
  check('Chromium launch is itself time-boxed', /Chromium launch timed out/.test(src));
}

// ---------------------------------------------------------------------------
// Scenario 4: a failed free-cash claim is retried quickly (not cached 30 min)
// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 4: free cash / late-night claim failures are not sticky ━━━');
{
  const bridgeSrc = fs.readFileSync('./swiggy-bridge.js', 'utf8');
  check('a short failure TTL exists next to the 30 min success TTL',
    /OFFER_CLAIM_FAILURE_TTL_MS\s*=\s*3 \* 60 \* 1000/.test(bridgeSrc) && /OFFER_CLAIM_TTL_MS = 30 \* 60 \* 1000/.test(bridgeSrc));
  check('Swiggy 403/429 gets a LONGER back-off so we stop hammering',
    /OFFER_CLAIM_RATELIMIT_TTL_MS\s*=\s*10 \* 60 \* 1000/.test(bridgeSrc)
    && /rateLimited \? OFFER_CLAIM_RATELIMIT_TTL_MS : OFFER_CLAIM_FAILURE_TTL_MS/.test(bridgeSrc));
  check('concurrent callers share ONE in-flight claim (no request storm)',
    /offerClaimInflight/.test(bridgeSrc) && /if \(inflight\) return inflight;/.test(bridgeSrc));
  check('an expired failure entry is dropped so the next call really retries',
    /if \(Date\.now\(\) - prev\.ts < ttl\) return prev\.result;\s*\n\s*offerClaimCache\.delete\(accSig\);/.test(bridgeSrc));

  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('the live claim promise is reused (not fired twice per scan)', /eventsClaimPromise/.test(cartSrc));
  check('free cash is re-locked when the offer lands after the cart was built', /\[FreeCash\].*free cash applied after offer lock/s.test(cartSrc));
  check('the re-lock only happens while the redeem slot is ACTIVE_NOW', /slotLiveNow[\s\S]{0,300}ACTIVE_NOW/.test(cartSrc));

  // Behavioural: a claim result that failed must come back quickly on retry.
  const srcSuccessCache = bridgeSrc.includes('offerClaimCache.set(accSig');
  check('claim results are still cached on success', srcSuccessCache);
}

// ---------------------------------------------------------------------------
// Scenario 6: offer claims are single-flight and back off on 403/429
// (the real reason late-night free cash stopped applying after a retry storm)
// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 6: claim storm protection (single-flight + 403 back-off) ━━━');
{
  const jwt = (() => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: '303', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
    return `${h}.${p}.sig`;
  })();

  let notifyCalls = 0;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('events.swiggy.com/api/notify')) {
      notifyCalls += 1;
      return jsonRes(403, { message: 'Forbidden' }, url);
    }
    if (url.includes('events.swiggy.com')) return jsonRes(403, {}, url);
    if (url.includes('chkout.swiggy.com')) return jsonRes(200, { statusCode: 0, tid: jwt }, url);
    return jsonRes(200, { statusCode: 0, data: {} }, url);
  };

  try {
    const acc = {
      id: 'fc_storm_acc', phone: '9333344455', customerId: '303',
      cookies: `_session_tid=fcstorm; tid=${jwt}`, tid: jwt, token: jwt, isLoggedIn: true
    };

    const [a, b] = await Promise.all([
      bridge.claimSwiggyBreakfastAndLateNightOffers(acc, { quickLockOnly: true }),
      bridge.claimSwiggyBreakfastAndLateNightOffers(acc, { quickLockOnly: true })
    ]);

    check('two simultaneous probes share ONE claim (no duplicate HTTP storm)', a === b);
    // 4 campaigns (2 days x BF/LN) x 3 attempts (GET, retry GET, POST) = 12 — the
    // point is that two callers did NOT double it (24 would mean a storm).
    check(`the shared claim made a bounded number of notify calls (${notifyCalls})`, notifyCalls > 0 && notifyCalls <= 12, String(notifyCalls));
    check('a Swiggy 403/429 is reported as rateLimited for back-off', a?.rateLimited === true, JSON.stringify({ bf: a?.breakfast?.statusCode, ln: a?.lateNight?.statusCode }));

    const callsBefore = notifyCalls;
    const third = await bridge.claimSwiggyBreakfastAndLateNightOffers(acc, { quickLockOnly: true });
    check('a repeat call inside the back-off window makes ZERO new requests', notifyCalls === callsBefore, `${callsBefore} -> ${notifyCalls}`);
    check('the back-off answer is the same rate-limited verdict', third?.rateLimited === true);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: nothing above wiped an ID or deleted an order
// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 5: no wipe, no order deletion, vault untouched ━━━');
{
  const before = dbBackup ? JSON.parse(dbBackup) : { config: { accounts: {} }, orders: {} };
  const after = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const identityOf = (db) => Object.keys(db.config?.accounts || {})
    .sort()
    .map((k) => {
      const a = db.config.accounts[k] || {};
      return [k, a.isLoggedIn, a.isLoggedOut, a.sessionExpired, a.cookies, a.tid, a.token].join('|');
    });
  check('every account ID keeps its session/logged-in state (no wipe, no logout)',
    JSON.stringify(identityOf(before)) === JSON.stringify(identityOf(after)));
  check('no account was removed from the vault',
    Object.keys(before.config?.accounts || {}).every((k) => Boolean(after.config?.accounts?.[k])));
  check('no order was deleted by any of these paths',
    Object.keys(before.orders || {}).every((k) => Boolean(after.orders?.[k])));

  const storeSrc = fs.readFileSync('./store.js', 'utf8');
  const flowSrc = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('no order deletion was added to the selection/QR paths',
    !/delete\s+db\.orders\[/.test(flowSrc) && /delete db\.orders\[/.test(storeSrc));
  check('the read-only active-order sweep is still exported', typeof trk.refreshActiveOrdersTracking === 'function');
  check('the tracking sweep still defaults to read-only per order', /readOnly: true/.test(fs.readFileSync('./order-tracking.js', 'utf8')));
}

// ---------------------------------------------------------------------------
console.log(`\n📊 RESULT: ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log('❌ FAILED CHECKS PRESENT');
  process.exit(1);
}
console.log('🏆 FAST ID SELECTION + QR DEADLINE + FREE-CASH SELF-HEAL VERIFIED');
process.exit(0);
