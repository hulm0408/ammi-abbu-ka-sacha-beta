// ============================================================================
// v48 — "ADDRESS FETCHED, PHIR BHI RETRY"
// ----------------------------------------------------------------------------
// Real-world complaint: the bot shows the address as saved/fetched, then asks
// the customer to RETRY the address link instead of starting the order.
//
// Four separate causes are guarded here:
//   1. The card showed a green "✓ Address" for a link that Swiggy never opened
//      (only the LINK was stored, no address). The customer reads "fetched".
//   2. In simple mode the order was auto-started with that unresolved link, and
//      the failure surfaced one screen later as "retry".
//   3. /dapi/social/getAddress answers "invalid/expired" for links that open
//      fine in the app, and there was no second route to the address.
//   4. The link was re-resolved at Continue time even though a perfectly good
//      address was already stored — a second chance to fail.
//
// Contract:
//   - the card never claims a fetched address it does not have;
//   - an unopened link shows Retry / "type address" right there;
//   - the share PAGE is used as a second resolver;
//   - a stored address is reused instead of re-resolving the link;
//   - "retry" only appears when there is really nothing usable.
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

// ---------------------------------------------------------------------------
// Fake Swiggy: the mobile API refuses / lies, the share PAGE carries the truth.
//   api:  'dead' | 'oops' | 'ok'
//   page: 'ok' | 'empty'
// ---------------------------------------------------------------------------
const net = { api: 'dead', page: 'ok' };
const hits = [];

const jsonRes = (status, body, u) => ({
  ok: status >= 200 && status < 300, status, url: u,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(body),
  json: async () => body
});
const htmlRes = (status, html, u) => ({
  ok: status >= 200 && status < 300, status, url: u,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html' : null) },
  text: async () => html,
  json: async () => { throw new Error('html'); }
});

const PAGE_HTML = `<!doctype html><html><body><div id="root"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      sharedAddress: {
        address: {
          id: 'addr_page_1',
          display_address: 'Flat 402, Sunrise Apartments, Gomti Nagar, Lucknow, Uttar Pradesh 226010',
          actual_address: {
            contact_name: 'AMMI',
            phone: '9876543210',
            city: 'Lucknow',
            locality: 'Gomti Nagar',
            landmark: 'Near Sahara Ganj',
            address_line: 'Flat 402',
            location: { lat: 26.8523, lng: 80.9462 },
            tags: ['Home']
          }
        }
      }
    }
  }
})}</script></body></html>`;

globalThis.fetch = async (url) => {
  const u = String(url);
  hits.push(u);
  if (u.includes('onelink.me') || u.includes('swig.gy')) {
    return { ok: false, status: 403, url: u, headers: { get: () => 'text/html' }, text: async () => 'blocked', json: async () => ({}) };
  }
  if (u.includes('/ofo/address/')) {
    if (net.page === 'ok') return htmlRes(200, PAGE_HTML, u);
    return htmlRes(200, '<html><body>no state</body></html>', u);
  }
  if (u.includes('social/getAddress')) {
    if (net.api === 'ok') {
      return jsonRes(200, {
        statusCode: 0,
        data: { address: { id: 'api_1', display_address: 'API Street, Lucknow 226010', actual_address: { contact_name: 'AMMI', phone: '9876500000', city: 'Lucknow', locality: 'API Area', address_line: 'H-1', location: { lat: 26.85, lng: 80.94 } } } }
      }, u);
    }
    if (net.api === 'oops') return jsonRes(200, { statusCode: 1, statusMessage: 'Oops!! Something went wrong' }, u);
    return jsonRes(200, { statusCode: 1, statusMessage: 'Invalid or expired link' }, u);
  }
  return htmlRes(503, 'nope', u);
};

const { bot } = await import('./index.js');
const { mutateDb, clearDraft, getDraft, updateDraft } = await import('./store.js');
const {
  resolveSwiggyLink,
  resolveOfoAddressFromPage,
  getOfoResolutionFailureReason,
  clearOfoResolutionFailures
} = await import('./swiggy-cart.js');

const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  return { message_id: apiLog.length, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' }, text: payload.text || payload.caption || '' };
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sent = () => apiLog.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.payload);
const lastMsg = () => sent().pop() || {};
const allText = () => sent().map((m) => String(m.text || '')).join('\n');
const lastButtons = () => (lastMsg().reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);

mutateDb((d) => {
  d.orders = {}; d.drafts = {}; d.config.deletedAccounts = {};
  d.config.accounts = {
    acc_9000000999: {
      account: 'acc_9000000999', name: 'Ammi', phone: '9000000999', isLoggedIn: true,
      cookies: '_session_tid=fake.tid.value', tid: 'fake.tid.value'
    }
  };
});

async function say(userId, text, mid) {
  const before = apiLog.filter((c) => c.method === 'sendMessage').length;
  await bot.handleUpdate({
    update_id: 9000 + mid,
    message: {
      message_id: mid, date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private', first_name: 'Ammi' },
      from: { id: userId, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text
    }
  });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && apiLog.filter((c) => c.method === 'sendMessage').length === before) await sleep(50);
  await sleep(300);
}

async function tap(userId, data, mid) {
  await bot.handleUpdate({
    update_id: 9500 + mid,
    callback_query: {
      id: `cb-${mid}`, from: { id: userId, is_bot: false, first_name: 'Ammi' }, chat_instance: 'ci',
      data,
      message: { message_id: 99, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: 'private' }, text: 'card' }
    }
  });
  await sleep(900);
}

const CART = 'https://swig.gy/gc/1467977/Umbashiya-642855918';

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: the share PAGE rescues a link the API rejects ---');
{
  const DIRECT = 'https://www.swiggy.com/ofo/address/ammi/PAGETOKEN123456';
  net.api = 'dead';
  net.page = 'ok';
  clearOfoResolutionFailures(DIRECT);
  const meta = await resolveSwiggyLink(DIRECT);
  const ad = meta?.addressDetails || {};
  check('the API "invalid/expired" answer is not the final word', !ad.unresolvableShortLink);
  check('the address came from the share page', /Gomti Nagar/i.test(String(ad.address || '')));
  check('GPS coordinates were recovered', Boolean(ad.lat && ad.lng));
  check('the receiver phone was recovered', String(ad.mobile || '') === '9876543210');
  check('the link is not marked EXPIRED any more', getOfoResolutionFailureReason(DIRECT) !== 'EXPIRED');
}

console.log('\n--- Scenario 2: the page parser works on its own ---');
{
  net.page = 'ok';
  const hit = await resolveOfoAddressFromPage('PAGETOKEN999', 'ammi');
  check('page resolver returns a usable address', /Sunrise Apartments/i.test(String(hit?.address || '')));
  net.page = 'empty';
  const miss = await resolveOfoAddressFromPage('EMPTYPAGE999', 'ammi');
  check('an empty page yields null, not a fake address', miss === null);
}

console.log('\n--- Scenario 3: a link nobody can open is NEVER shown as a fetched address ---');
{
  const USER_A = 6160001;
  clearDraft(USER_A);
  net.api = 'oops';
  net.page = 'empty';
  apiLog.length = 0;
  await say(USER_A, CART, 1);
  await say(USER_A, 'https://swiggy.onelink.me/JgkQ/unopenable1', 2);

  const draft = getDraft(USER_A);
  check('the draft knows the link is unresolved', draft.addressDetails?.unresolvableShortLink === true);
  check('the card does not print a green "Address: Added" line', !/✓ <b>Address:<\/b>/.test(allText()));
  check('the card says the link could not be opened', /khul nahi paya/i.test(allText()));
  const buttons = lastButtons();
  check('Retry is offered right on the card', buttons.includes('simple_retry_address'));
  check('typing the address is offered right on the card', buttons.includes('simple_type_address'));
  check('no order was created just to fail', Object.keys(getDbOrders(USER_A)).length === 0);
}

console.log('\n--- Scenario 4: when the link does open, the card shows the real address ---');
{
  const USER_B = 6160002;
  clearDraft(USER_B);
  net.api = 'dead';
  net.page = 'ok';
  apiLog.length = 0;
  await say(USER_B, CART, 3);
  await say(USER_B, 'https://www.swiggy.com/ofo/address/ammi/GOODTOKEN88888', 4);

  const draft = getDraft(USER_B);
  check('the address is resolved in the draft', !draft.addressDetails?.unresolvableShortLink);
  check('the draft stores a real street address', /Gomti Nagar/i.test(String(draft.addressDetails?.address || '')));
  check('the customer is not asked to retry', !/retry|khul nahi paya/i.test(allText()));
}

console.log('\n--- Scenario 5: a stored address is reused, the link is not re-resolved ---');
{
  const USER_C = 6160003;
  clearDraft(USER_C);
  updateDraft(USER_C, {
    cart: CART,
    address: 'Flat 402, Sunrise Apartments, Gomti Nagar, Lucknow 226010',
    addressOriginalText: 'Flat 402, Sunrise Apartments, Gomti Nagar, Lucknow 226010',
    addressTyped: false,
    addressLink: 'https://www.swiggy.com/ofo/address/ammi/STOREDTOKEN1234',
    addressDetails: {
      address: 'Flat 402, Sunrise Apartments, Gomti Nagar, Lucknow 226010',
      city: 'Lucknow', area: 'Gomti Nagar', mobile: '9876543210',
      lat: '26.8523', lng: '80.9462'
    }
  });
  // Swiggy is now completely broken on both routes.
  net.api = 'oops';
  net.page = 'empty';
  hits.length = 0;
  apiLog.length = 0;
  await tap(USER_C, 'simple_continue', 51);
  check('the already-fetched address is not re-resolved',
    !hits.some((u) => u.includes('social/getAddress') || u.includes('/ofo/address/')));
  check('the bot never asks for a retry', !/Retry address|khul nahi paya|expire ho gaya/i.test(allText()));
}

console.log('\n--- Scenario 6: retry really re-asks and can succeed ---');
{
  const USER_D = 6160004;
  clearDraft(USER_D);
  net.api = 'oops';
  net.page = 'empty';
  apiLog.length = 0;
  await say(USER_D, CART, 5);
  await say(USER_D, 'https://www.swiggy.com/ofo/address/ammi/RETRYTOKEN1234', 6);
  check('first attempt says it could not open the link', /khul nahi paya/i.test(allText()));

  // Swiggy recovers; the customer taps Retry on the same card.
  net.api = 'dead';
  net.page = 'ok';
  apiLog.length = 0;
  await tap(USER_D, 'simple_retry_address', 61);
  await sleep(1500);
  const draft = getDraft(USER_D);
  check('retry re-asked Swiggy instead of trusting the cache', draft.addressDetails?.unresolvableShortLink !== true);
  check('retry resolved the real address', /Gomti Nagar/i.test(String(draft.addressDetails?.address || '')));
  check('after a successful retry the customer is not asked to retry again', !/khul nahi paya/i.test(allText()));
}

console.log('\n--- Scenario 7: source wiring ---');
{
  const src = fs.readFileSync('index.js', 'utf8');
  const cart = fs.readFileSync('swiggy-cart.js', 'utf8');
  const chat = fs.readFileSync('simple-chat.js', 'utf8');
  check('the starter refuses to auto-start on an unusable address',
    /curDraft\.cart && curDraft\.address && !addressUsable/.test(src));
  check('the card notice is honest about an unresolved link',
    /⚠️ Address link mila — Swiggy se khul nahi paya/.test(src));
  check('a stored address skips link re-resolution', /const skipLinkResolution = Boolean\(addressLink && draftHasUsableAddress\)/.test(src));
  check('a stored unresolved link is not treated as usable',
    /\) && !draft\.addressDetails\?\.unresolvableShortLink;/.test(src));
  check('the simple card labels an unresolved link', /link added — Swiggy se khul nahi paya/.test(chat));
  check('the simple card offers Retry + type address', /simple_retry_address/.test(chat) && /simple_type_address/.test(chat));
  check('the share page is used as a second resolver', /export async function resolveOfoAddressFromPage/.test(cart));
  check('the API "dead" answer is not the final word', /trying the share page/.test(cart));
}

function getDbOrders(userId) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  return Object.fromEntries(Object.entries(db.orders || {}).filter(([, o]) => Number(o?.userId) === Number(userId)));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
