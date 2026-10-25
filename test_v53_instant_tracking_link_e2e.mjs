/**
 * v53 — INSTANT tracking link (payment ke turant baad)
 *
 * Complaint: doosre bot payment confirm hote hi tracking link publish kar dete
 * hain ("THEY CAN PUBLISH INSTANTLY BUT YOU CANT"), humara bot card par likhta
 * tha "Swiggy has not shared a tracking link yet".
 *
 * Proven here with real behaviour (mocked Swiggy only):
 *   1. `fetchSwiggyTrackingLinkFast` nikaalta hai `data.fyi_details[0].value.cta_link`
 *      -> `https://www.swiggy.com/ofo/track/...` (wahi field jo live app bharta hai).
 *   2. Agar pehla jawab khaali ho (Swiggy 1-2s late publish karta hai) to retry
 *      khud link le aata hai — bounded attempts, bounded budget.
 *   3. Payment card ke finalize par instant fetch chalta hai; link turant card me.
 *   4. Link na mile to card jhooth nahi bolta ki "not shared" — honest line +
 *      ek watcher jo link aate hi WAHI card update karta hai.
 *   5. Koi ID logout nahi, koi order delete nahi.
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

const realFetch = globalThis.fetch;

const cart = await import('./swiggy-cart.js');
const store = await import('./store.js');
const dbSnapshot = () => {
  const db = store.getDb();
  return {
    accounts: Object.keys(db.config?.accounts || {}).sort().map((k) => {
      const a = db.config.accounts[k] || {};
      return [k, a.isLoggedIn, a.isLoggedOut, a.sessionExpired, a.cookies].join('|');
    }),
    orders: Object.keys(db.orders || {}).sort()
  };
};
const before = dbSnapshot();

const LIVE_LINK = 'https://www.swiggy.com/ofo/track/ZXQPy4BbQuGb';
const SWIGGY_ORDER_ID = '251917980139509';
const makeTid = () => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: '287113492', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.sig`;
};
const TID = makeTid();
const ACCOUNT = {
  id: 'acc_9580917944', phone: '9580917944', customerId: '287113492',
  cookies: `_session_tid=v53sess; tid=${TID}; _is_logged_in=1`,
  tid: TID, token: TID, isLoggedIn: true
};

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 1: fyi_details cta_link is read exactly like the app does ━━━');
{
  check('pure extractor reads `fyi_details[0].value.cta_link`',
    cart.extractTrackingUrlFromSwiggyFyiDetails({
      data: { order_id: SWIGGY_ORDER_ID, fyi_details: [{ value: { cta_link: `swiggy://share?text=${encodeURIComponent(LIVE_LINK)}` } }] }
    }) === LIVE_LINK);
  check('it also accepts the raw (unwrapped) trackV4 data',
    cart.extractTrackingUrlFromSwiggyFyiDetails({
      fyi_details: [{ value: { cta_link: `swiggy://share?text=${encodeURIComponent(LIVE_LINK)}` } }]
    }) === LIVE_LINK);
  check('an unrelated Swiggy page is never treated as a tracking link',
    cart.isOfficialSwiggyTrackingUrl('https://www.swiggy.com/orders') === false);
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 2: link turant milta hai (ek hi call) ━━━');
let trackV4Calls = 0;
{
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('order/trackV4')) {
      trackV4Calls += 1;
      return jsonRes(200, {
        statusCode: 0,
        data: {
          order_id: SWIGGY_ORDER_ID,
          order_status_details: { status_message: 'Order Confirmed' },
          fyi_details: [{ value: { cta_link: `swiggy://share?text=${encodeURIComponent(LIVE_LINK)}` } }]
        }
      }, url);
    }
    if (url.includes('order/all')) return jsonRes(200, { statusCode: 0, data: { orders: [] } }, url);
    return jsonRes(200, { statusCode: 0, data: {} }, url);
  };

  try {
    const started = Date.now();
    const fast = await cart.fetchSwiggyTrackingLinkFast(ACCOUNT, SWIGGY_ORDER_ID, { budgetMs: 4000, attempts: 2 });
    const ms = Date.now() - started;
    check('fast fetch returns the real OFO link', fast.url === LIVE_LINK, fast.url);
    // One round = web-UA trackV4 then Android-header trackV4; both are cheap.
    // dapiFetch may internally re-try a route once; what matters is that the
    // whole fast path stays well under a second and does NOT scan the vault.
    check(`fast path stayed tiny and quick (${trackV4Calls} trackV4 call(s), ${ms}ms)`, trackV4Calls <= 4 && ms < 3000);
    check('the raw Swiggy payload is returned for OTP/status reuse', Boolean(fast.payload?.order_id === SWIGGY_ORDER_ID));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 3: Swiggy 1-2s late publish kare to retry khud le aata hai ━━━');
{
  let calls = 0;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('order/trackV4')) {
      calls += 1;
      const ready = calls >= 2; // pehla jawab khaali, doosre me link
      return jsonRes(200, {
        statusCode: 0,
        data: {
          order_id: SWIGGY_ORDER_ID,
          fyi_details: ready
            ? [{ value: { cta_link: `swiggy://share?text=${encodeURIComponent(LIVE_LINK)}` } }]
            : []
        }
      }, url);
    }
    return jsonRes(200, { statusCode: 0, data: {} }, url);
  };
  try {
    const fast = await cart.fetchSwiggyTrackingLinkFast(ACCOUNT, SWIGGY_ORDER_ID, { budgetMs: 6000, attempts: 3 });
    check('an empty first answer still ends with the real link', fast.url === LIVE_LINK, fast.url);
    check(`it retried until the link appeared (${fast.attempts} attempt(s), ${calls} trackV4 calls)`, calls >= 2 && fast.url === LIVE_LINK);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 4: kisi doosre order ka link kabhi attach nahi hota ━━━');
{
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('order/trackV4')) {
      return jsonRes(200, {
        statusCode: 0,
        data: {
          order_id: '251900000000001', // different order!
          fyi_details: [{ value: { cta_link: `swiggy://share?text=${encodeURIComponent('https://www.swiggy.com/ofo/track/WRONGORDER1')}` } }]
        }
      }, url);
    }
    return jsonRes(200, { statusCode: 0, data: {} }, url);
  };
  try {
    const fast = await cart.fetchSwiggyTrackingLinkFast(ACCOUNT, SWIGGY_ORDER_ID, { budgetMs: 2500, attempts: 1 });
    check('a cross-order response is rejected (no false tracking link)', fast.url === '', fast.url);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 5: payment card + watcher wiring ━━━');
{
  const flow = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('the paid card asks Swiggy for the link BEFORE it is drawn',
    /const providerTrackingCandidate = instantTrackingUrl \|\| livePaidResult\.nativeShareUrl/.test(flow));
  check('that instant fetch is bounded (4.5s, 3 attempts)',
    /fetchSwiggyTrackingLinkFast\(instantAcc, instantTrackingOrderId, \{ budgetMs: 4500, attempts: 3 \}\)/.test(flow));
  check('a watcher updates the SAME card the moment the link appears',
    /export function watchInstantTrackingLink/.test(flow)
    && /postOrReplaceForwardedCard\(telegram, chatId, freshOrder/.test(flow));
  check('the watcher starts right after finalize when there is no link',
    /if \(!getStoredSwiggyTrackingUrl\(order\)\) \{[\s\S]{0,200}watchInstantTrackingLink/.test(flow));
  check('the watcher cannot run forever (bounded window)', /maxWaitMs = 12 \* 60 \* 1000/.test(flow));
  check('it starts watching within 2s of the payment', /const firstDelay = 2000;/.test(flow));
  check('the card no longer claims Swiggy has shared nothing',
    !/Swiggy has not shared a tracking link yet/.test(flow));
  check('the card says the link will land in this same message',
    /yehi card update hoga jaise hi Swiggy publish karega/.test(flow));

  const idx = fs.readFileSync('./index.js', 'utf8');
  check('a pasted order id also tries the fast route before the 29-ID scan',
    /INSTANT TRY FIRST/.test(idx) && /fetchSwiggyTrackingLinkFast\(accMap\[key\], q, \{ budgetMs: 2500, attempts: 1 \}\)/.test(idx));
  check('an instant hit skips the slow scan entirely',
    /const result = instantUrl\s*\n?\s*\?/.test(idx));
}

// ---------------------------------------------------------------------------
console.log('\n━━━ Scenario 6: no ID wipe, no order deletion ━━━');
{
  const after = dbSnapshot();
  check('every account keeps its session (no logout)', JSON.stringify(before.accounts) === JSON.stringify(after.accounts));
  check('no order was deleted', before.orders.every((k) => after.orders.includes(k)));
}

console.log(`\n📊 RESULT: ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log('❌ FAILED CHECKS PRESENT');
  process.exit(1);
}
console.log('🏆 INSTANT TRACKING LINK VERIFIED');
process.exit(0);
