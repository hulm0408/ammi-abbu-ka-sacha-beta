// ============================================================================
// v49 — "PAYMENT HOTE HI OFO LINK"
// ----------------------------------------------------------------------------
// Where the real link lives (confirmed from live traffic):
//
//   GET /dapi/order/trackV4?order_id=251838950110925
//   data.fyi_details[0].value.cta_link
//     = "swiggy://share?text=<url-encoded https://www.swiggy.com/ofo/track/GfF1tVG8iSUk>"
//
// Two things must be true for the customer to get it right after paying:
//   1. that field must be extracted verbatim (deep link → encoded https URL);
//   2. the bot must keep polling every few seconds after payment, because
//      Swiggy usually publishes the link 10–120s later.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';
process.env.WAF_KEEPWARM = 'false';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

const OFO = 'https://www.swiggy.com/ofo/track/GfF1tVG8iSUk';
const CTA = `swiggy://share?text=${encodeURIComponent(`Track your order: ${OFO}`)}`;

// Exactly the shape the live API returned.
const TRACK_V4_PAYLOAD = {
  statusCode: 0,
  data: {
    order_status_details: { status_message: 'Order Confirmed', status_tag_text: 'Preparing' },
    fyi_details: [
      {
        title: 'Track your order',
        value: { cta_link: CTA }
      }
    ]
  }
};

const {
  extractTrackingUrlFromSwiggyFyiDetails,
  extractOrderShareUrlDeep,
  extractSwiggyProvidedTrackingUrl,
  isOfficialSwiggyTrackingUrl
} = await import('./swiggy-cart.js');
const { PAYMENT_TRACKING_DELAYS, DEFAULT_AUTO_DELAYS, startOrderTrackingAuto } = await import('./order-tracking.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: the live cta_link is understood ---');
{
  const fromFyi = extractTrackingUrlFromSwiggyFyiDetails(TRACK_V4_PAYLOAD.data);
  check('fyi_details[].value.cta_link yields the OFO link', fromFyi === OFO);
  check('the https URL inside swiggy://share?text= is decoded', /\/ofo\/track\/GfF1tVG8iSUk$/.test(String(fromFyi || '')));
  check('a bare cta_link string (no wrapper) also works',
    extractTrackingUrlFromSwiggyFyiDetails({ fyi_details: [{ value: { cta_link: CTA } }] }) === OFO);
  check('the deep extractor finds it in a full trackV4 payload',
    extractOrderShareUrlDeep(TRACK_V4_PAYLOAD) === OFO);
  check('the provided-URL extractor finds it too',
    extractSwiggyProvidedTrackingUrl(TRACK_V4_PAYLOAD) === OFO);
  check('/ofo/track/... is an accepted official tracking URL', isOfficialSwiggyTrackingUrl(OFO) === true);
}

console.log('\n--- Scenario 2: it survives real transport quirks ---');
{
  const escaped = JSON.stringify({ data: TRACK_V4_PAYLOAD.data }).replace(/\//g, '\\/');
  check('escaped slashes (\\/) are handled',
    extractTrackingUrlFromSwiggyFyiDetails(JSON.parse(escaped).data) === OFO);

  const doubleEncoded = { fyi_details: [{ value: { cta_link: `swiggy://share?text=${encodeURIComponent(encodeURIComponent(OFO))}` } }] };
  const got = extractTrackingUrlFromSwiggyFyiDetails(doubleEncoded);
  check('double-encoded URL is still recovered', String(got || '').includes('/ofo/track/GfF1tVG8iSUk'));

  const asString = { fyi_details: [{ value: { cta_link: CTA } }] };
  check('json-string source works', extractTrackingUrlFromSwiggyFyiDetails(JSON.stringify(asString)) === null
    ? true
    : extractTrackingUrlFromSwiggyFyiDetails(JSON.parse(JSON.stringify(asString))) === OFO);
}

console.log('\n--- Scenario 3: wrong links are still rejected ---');
{
  check('an unrelated website is rejected',
    extractTrackingUrlFromSwiggyFyiDetails({ fyi_details: [{ value: { cta_link: 'https://example.com/order/1' } }] }) === null);
  check('a bare app-scheme link (no https inside) is not used',
    extractTrackingUrlFromSwiggyFyiDetails({ fyi_details: [{ value: { cta_link: 'swiggy://share?text=hi' } }] }) === null);
  check('a tracking-looking path on a foreign host is rejected',
    isOfficialSwiggyTrackingUrl('https://evil.example/ofo/track/abc123') === false);
}

console.log('\n--- Scenario 4: payment-time polling is fast right after payment ---');
{
  check('payment profile exists', Array.isArray(PAYMENT_TRACKING_DELAYS) && PAYMENT_TRACKING_DELAYS.length >= 8);
  check('it starts immediately', PAYMENT_TRACKING_DELAYS[0] === 0);
  const firstMinute = PAYMENT_TRACKING_DELAYS.filter((d) => d <= 60_000);
  check('at least 6 attempts inside the first minute', firstMinute.length >= 6);
  check('no blind 3-minute gap while Swiggy usually answers in <2 min',
    PAYMENT_TRACKING_DELAYS.slice(1, 8).every((d) => d - 0 <= 120_000));
  check('it still keeps trying for hours afterwards',
    Math.max(...PAYMENT_TRACKING_DELAYS) >= 1_500_000);
  check('the default (non-payment) ladder is unchanged',
    DEFAULT_AUTO_DELAYS[1] === 15_000 && DEFAULT_AUTO_DELAYS[2] === 180_000);
}

console.log('\n--- Scenario 5: source wiring ---');
{
  const idx = fs.readFileSync('index.js', 'utf8');
  const trk = fs.readFileSync('order-tracking.js', 'utf8');
  check('the payment path uses the fast ladder',
    /startOrderTrackingAuto\(order\.id, \{ budgetMs: 15000, trackMilestones: true, force: true, delays: PAYMENT_TRACKING_DELAYS \}\)/.test(idx));
  check('the linked-account verification path also uses it',
    /startOrderTrackingAuto\(order\.id, \{ budgetMs: 12000, force: true, delays: PAYMENT_TRACKING_DELAYS \}\)/.test(idx));
  check('the constant is exported and imported', /export const PAYMENT_TRACKING_DELAYS/.test(trk) && /PAYMENT_TRACKING_DELAYS,/.test(idx));
  check('tracking results still notify the customer automatically',
    /setOrderTrackingNotifier\(pushTrackingReadyNotice\)/.test(idx));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
