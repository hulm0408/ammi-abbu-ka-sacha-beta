// ============================================================================
// v47 — "NAYA ADDRESS DAALTA HOON, PHIR BHI LINK EXPIRE BOLTA HAI"
// ----------------------------------------------------------------------------
// Real-world complaint: every freshly pasted Swiggy address link is called
// "expired" instantly, so the customer keeps pasting new links that also fail.
//
// Root causes covered here:
//   1. resolveSharedOfoAddress() called a link EXPIRED whenever ANY http status
//      came back and no address did. A WAF 403, a 202 challenge, a 401 from a
//      token-only account, a 429/5xx or an HTML challenge page are OUR side.
//   2. statusCode 1 + a generic message ("Oops!! Something went wrong",
//      "Invalid session") matched /invalid/ and was reported as expiry.
//   3. The failure verdict was cached forever for the token, so even a healthy
//      re-paste answered "expired" without asking Swiggy.
//   4. The dead link stayed in the draft, so Continue/Retry re-ran it forever.
//
// Contract:
//   - "expired" ONLY from a clean 2xx JSON answer where Swiggy says the token is
//     dead;
//   - a fresh paste always gets a fresh attempt;
//   - a dead link is removed from the draft after it is reported;
//   - a real typed address is never blocked by a bad link.
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
// Switchable fake Swiggy network.
//   mode 'waf'    -> every Swiggy endpoint answers a WAF 403 (HTML challenge)
//   mode 'noauth' -> token-only 401
//   mode 'oops'   -> 200 {"statusCode":1,"statusMessage":"Oops!! Something went wrong"}
//   mode 'session'-> 200 {"statusCode":1,"statusMessage":"Invalid session"}
//   mode 'dead'   -> 200 {"statusCode":1,"statusMessage":"Invalid or expired link"}
//   mode 'ok'     -> 200 real shared-address payload
// ---------------------------------------------------------------------------
const net = { mode: 'waf' };
const hits = [];
const jsonResponse = (status, body, u) => ({
  ok: status >= 200 && status < 300,
  status,
  url: u,
  headers: { get: (k) => (String(k).toLowerCase() === 'x-amzn-waf-action' && status === 403 ? 'challenge' : null) },
  text: async () => JSON.stringify(body),
  json: async () => body
});
const htmlResponse = (status, u) => ({
  ok: false, status, url: u,
  headers: { get: (k) => (String(k).toLowerCase() === 'x-amzn-waf-action' && status === 403 ? 'challenge' : 'text/html') },
  text: async () => '<html>challenge</html>',
  json: async () => { throw new Error('not json'); }
});

const SHARED = {
  statusCode: 0,
  data: {
    address: {
      id: 'addr_v47',
      display_address: 'Flat 4, Gomti Nagar, Lucknow, Uttar Pradesh 226010',
      actual_address: {
        contact_name: 'AMMI',
        phone: '9876543210',
        city: 'Lucknow',
        locality: 'Gomti Nagar',
        landmark: 'Near Sahara Ganj',
        address_line: 'Flat 4',
        location: { lat: 26.8523, lng: 80.9462 },
        tags: ['Home']
      }
    }
  }
};

globalThis.fetch = async (url) => {
  const u = String(url);
  hits.push(u);
  if (u.includes('onelink.me') || u.includes('swig.gy')) return htmlResponse(403, u);
  if (u.includes('social/getAddress')) {
    if (net.mode === 'waf') return htmlResponse(403, u);
    if (net.mode === 'noauth') return jsonResponse(401, { statusCode: 401, statusMessage: 'Unauthorized' }, u);
    if (net.mode === 'oops') return jsonResponse(200, { statusCode: 1, statusMessage: 'Oops!! Something went wrong' }, u);
    if (net.mode === 'session') return jsonResponse(200, { statusCode: 1, statusMessage: 'Invalid session' }, u);
    if (net.mode === 'dead') return jsonResponse(200, { statusCode: 1, statusMessage: 'Invalid or expired link' }, u);
    if (net.mode === 'ok') return jsonResponse(200, SHARED, u);
  }
  return htmlResponse(503, u);
};

const { bot } = await import('./index.js');
const { mutateDb, clearDraft, getDraft, updateDraft } = await import('./store.js');
const {
  resolveSwiggyLink,
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
const sentMessages = () => apiLog.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.payload);
const lastMessage = () => sentMessages().pop() || {};
const allText = () => sentMessages().map((m) => String(m.text || '')).join('\n');

mutateDb((d) => {
  d.orders = {}; d.drafts = {};
  d.config.deletedAccounts = {};
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
    update_id: 7000 + mid,
    message: {
      message_id: mid, date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private', first_name: 'Ammi' },
      from: { id: userId, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text
    }
  });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && apiLog.filter((c) => c.method === 'sendMessage').length === before) {
    await sleep(50);
  }
  await sleep(250);
}

async function tap(userId, data, mid) {
  await bot.handleUpdate({
    update_id: 7500 + mid,
    callback_query: {
      id: `cb-${mid}`, from: { id: userId, is_bot: false, first_name: 'Ammi' }, chat_instance: 'ci',
      data,
      message: { message_id: 99, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: 'private' }, text: 'card' }
    }
  });
  await sleep(800);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: our own session/WAF problems are never "expired" ---');
{
  const DIRECT = 'https://www.swiggy.com/ofo/address/ammi/GHISTOKEN123456';
  for (const mode of ['waf', 'noauth', 'oops', 'session']) {
    net.mode = mode;
    clearOfoResolutionFailures(DIRECT);
    const meta = await resolveSwiggyLink(DIRECT);
    const reason = meta?.addressDetails?.unresolvedReason || getOfoResolutionFailureReason(DIRECT);
    check(`mode=${mode}: the link is unresolved`, Boolean(meta?.addressDetails?.unresolvableShortLink));
    check(`mode=${mode}: the reason is NOT EXPIRED`, reason !== 'EXPIRED');
    check(`mode=${mode}: reason is transport/session (${reason || 'EMPTY'})`, ['NETWORK', 'NO_ACCOUNT'].includes(reason));
  }
}

console.log('\n--- Scenario 2: a healthy Swiggy answer still resolves the address ---');
{
  const DIRECT = 'https://www.swiggy.com/ofo/address/ammi/HEALTHYTOKEN98765';
  net.mode = 'ok';
  clearOfoResolutionFailures(DIRECT);
  const meta = await resolveSwiggyLink(DIRECT);
  check('no false unresolvable flag', !meta?.addressDetails?.unresolvableShortLink);
  check('street address resolved', /Gomti Nagar/i.test(String(meta?.addressDetails?.address || '')));
  check('recipient phone resolved', meta?.addressDetails?.mobile === '9876543210');
}

console.log('\n--- Scenario 3: a freshly pasted WAF-blocked link never says "expire" ---');
{
  const USER_A = 5150001;
  clearDraft(USER_A);
  net.mode = 'waf';
  apiLog.length = 0;
  await say(USER_A, 'https://swig.gy/gc/1467977/Umbashiya-642855918\nhttps://swiggy.onelink.me/JgkQ/newlink1', 1);
  const text = allText();
  check('the bot does not say the link expired', !/expire/i.test(text));
  check('the bot explains it could not open the link', /khul nahi paya|nahi mil paya|login nahi/i.test(text));
  const buttons = (lastMessage().reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);
  check('a retry action is offered', buttons.includes('simple_retry_address'));
  check('a "type the address" action is offered', buttons.includes('simple_type_address'));
  check('the cart link was kept', /swig\.gy\/gc/.test(String(getDraft(USER_A).cart || '')));
}

console.log('\n--- Scenario 4: Retry really retries (no stale cached verdict) ---');
{
  const USER_B = 5150002;
  clearDraft(USER_B);
  net.mode = 'session';
  apiLog.length = 0;
  await say(USER_B, 'https://swig.gy/gc/1467977/Umbashiya-642855918\nhttps://swiggy.onelink.me/JgkQ/retryme1', 2);
  check('first attempt is not called expired', !/expire/i.test(allText()));

  // Swiggy recovers; the customer taps Retry. The old verdict must not stick.
  net.mode = 'ok';
  apiLog.length = 0;
  await tap(USER_B, 'simple_retry_address', 21);
  check('retry re-asked Swiggy instead of answering from cache',
    hits.filter((u) => u.includes('social/getAddress')).length > 0);
  check('retry no longer reports expiry', !/expire ho gaya/i.test(allText()));
}

console.log('\n--- Scenario 5: a genuinely dead token is reported once, then cleaned ---');
{
  const USER_C = 5150003;
  clearDraft(USER_C);
  net.mode = 'dead';
  const DIRECT = 'https://www.swiggy.com/ofo/address/ammi/DEADTOKEN123456';
  clearOfoResolutionFailures(DIRECT);
  apiLog.length = 0;
  await say(USER_C, `https://swig.gy/gc/1467977/Umbashiya-642855918\n${DIRECT}`, 3);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !/expire ho gaya/i.test(allText())) await sleep(50);
  check('a truly dead link is reported as expired', /expire ho gaya/i.test(allText()));
  const d = getDraft(USER_C);
  check('the dead link is removed from the draft', !d.addressLink);
  check('the draft address is cleared so it is not shown as verified',
    !d.address || !/ofo\/address|onelink\.me/i.test(String(d.address)));
  check('the dead link is gone from the stored original text',
    !/ofo\/address|onelink\.me/i.test(String(d.addressOriginalText || '')));

  apiLog.length = 0;
  await tap(USER_C, 'simple_continue', 31);
  check('Continue after a dead link does not repeat "expired"', !/expire ho gaya/i.test(allText()));
}

console.log('\n--- Scenario 6: re-pasting the same link after a cached verdict retries it ---');
{
  const USER_D = 5150004;
  clearDraft(USER_D);
  const LINK = 'https://www.swiggy.com/ofo/address/ammi/REPASTETOKEN1234';
  net.mode = 'dead';
  clearOfoResolutionFailures(LINK);
  await resolveSwiggyLink(LINK);
  check('the dead verdict is remembered', getOfoResolutionFailureReason(LINK) === 'EXPIRED');

  // Swiggy is healthy again and the customer pastes the very same link.
  net.mode = 'ok';
  apiLog.length = 0;
  await say(USER_D, `https://swig.gy/gc/1467977/Umbashiya-642855918\n${LINK}`, 4);
  check('the fresh paste is not answered from the old cached verdict', !/expire ho gaya/i.test(allText()));
  check('the fresh paste resolved the address', /Gomti Nagar/i.test(String(getDraft(USER_D).addressDetails?.address || '')));
}

console.log('\n--- Scenario 7: a usable typed address is never blocked by a bad link ---');
{
  const USER_E = 5150005;
  clearDraft(USER_E);
  updateDraft(USER_E, {
    cart: 'https://swig.gy/gc/1467977/Umbashiya-642855918',
    address: 'Flat 4, Gomti Nagar, Lucknow 226010',
    addressOriginalText: 'Flat 4, Gomti Nagar, Lucknow 226010',
    addressTyped: true,
    addressLink: 'https://www.swiggy.com/ofo/address/ammi/DEADFALLBACK1234',
    addressDetails: {
      address: 'Flat 4, Gomti Nagar, Lucknow 226010',
      city: 'Lucknow', lat: '26.8523', lng: '80.9462'
    }
  });
  net.mode = 'dead';
  clearOfoResolutionFailures('https://www.swiggy.com/ofo/address/ammi/DEADFALLBACK1234');
  apiLog.length = 0;
  await tap(USER_E, 'simple_continue', 41);
  check('the typed address order is not blocked by "expired"', !/expire ho gaya/i.test(allText()));
}

console.log('\n--- Scenario 8: link recognition for real share formats ---');
{
  const src = fs.readFileSync('index.js', 'utf8');
  check('bare onelink.me shares are accepted as addresses',
    /host === 'onelink\.me'/.test(src));
  check('a fresh paste clears the remembered failure',
    /if \(validAddrLink\) clearOfoResolutionFailures\(validAddrLink\)/.test(src));
  check('Retry clears the remembered failure',
    /bot\.action\('simple_retry_address'[\s\S]{0,600}?clearOfoResolutionFailures/.test(src));
  check('the expired branch scrubs the link from the draft',
    /reason === 'EXPIRED'[\s\S]{0,1500}?addressLink: null/.test(src));
  const cart = fs.readFileSync('swiggy-cart.js', 'utf8');
  check('a WAF/401/5xx answer is never classified as EXPIRED',
    /answeredCleanly\) sawRealAnswer = true/.test(cart) && !/sawAnyHttpStatus && !sawUsableResponse \? 'EXPIRED'/.test(cart));
  check('generic "invalid" messages are not treated as expiry',
    /isOfoSessionOrTransportProblem/.test(cart) && /isOfoTokenDeadAnswer/.test(cart));
  check('the failure cache is exported for clearing', /export function clearOfoResolutionFailures/.test(cart));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
