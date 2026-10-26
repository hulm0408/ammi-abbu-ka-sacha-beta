/**
 * v59 — EXPORT & LOGOUT FIXES + AUTO EXPORT AFTER DELIVERY + REAL SHARE LINK
 *
 * Boss ka message (26-10-2026 16:04):
 *   "× Export failed for 9302790930: 400: Bad Request: message is too long"
 *   → ek hi account export hua, baaki logout hi nahi hue.
 *   "AND AUTO LOGOUT AND EXPORT BHI NA HOTA AFTER ORDER IS DELIVERED"
 *   "OFO LINK ... MY ACCOUNT PAR JAAO PHIR MY ORDERS THEN TRACK THEN SHARE THE LINK"
 *
 * Proven here:
 *   1. Export payload size is measured; huge sessions go as a FILE only, so
 *      "message is too long" cannot abort the loop or skip the logout.
 *   2. The inline code message failing does NOT stop the account from being
 *      logged out (previously it did — that is the literal bug in the log).
 *   3. Delivered order → auto `.json` export to Boss → account logged out &
 *      removed, exactly once, and never while the ID has another live order.
 *   4. Export failure is reported honestly and retried later (no fake success).
 *   5. The share/track link is now also read from the page a human uses
 *      (My Orders → Track → Share), never fabricated.
 */
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const rel = await import('./delivery-release.js');
const views = await import('./account-views.js');
const cart = await import('./swiggy-cart.js');

const JWT = (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ user_id: 287113492, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return `${h}.${p}.jwt`;
})();

console.log('\n=== 1. "message is too long" can never abort an export again ===');
{
  const bigSession = {
    name: 'Rahul Kumar',
    phone: '9302790930',
    tid: JWT,
    // A real session can carry huge cookie/JWT values; 5 KB here proves the
    // old `message is too long` crash is impossible now.
    cookies: `_session_tid=${'a'.repeat(5200)}; _device_id=dev-xyz; _is_logged_in=1`,
    sid: 'S'.repeat(5200),
    tid: `${JWT}`,
  };
  const payload = rel.buildExportPayload(bigSession, 'acc_9302790930', { orderCount: 1 });
  check('huge session detected as NOT fitting inline', payload.fitsInline === false);
  check('inline <pre> left empty for huge session', payload.inlineCode === '');
  check('full JSON still delivered as the .json file', payload.jsonText.length > 5000);
  check('file name uses the account phone', payload.fileName === 'swiggy_9302790930.json', payload.fileName);
  check('caption fits one Telegram message', payload.caption.length < 1000, String(payload.caption.length));
  check('caption says what the file contains (7 fields)', /7 fields/.test(payload.caption), payload.caption);
  check('payload JSON has exactly the 7 portable keys',
    Object.keys(payload.json).join(',') === 'name,customerId,mobile,token,tid,sid,deviceId',
    Object.keys(payload.json).join(','));

  const normal = rel.buildExportPayload({ name: 'Small', phone: '9876500001', tid: JWT, cookies: '_sid=s' }, 'acc_9876500001', { orderCount: 0 });
  check('normal session still shows inline code (nice for copy)', normal.fitsInline === true);
  check('normal inline code is the portable 7-field JSON', Object.keys(JSON.parse(normal.inlineCode)).length === 7);
  check('inline size stays under the safe limit', normal.inlineCode.length <= rel.EXPORT_INLINE_SAFE_LIMIT);
  check('Telegram limit constant is 4096', rel.TELEGRAM_MESSAGE_LIMIT === 4096);

  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  const exloStart = indexSrc.indexOf('const payload = buildExportPayload(acc, key, { orderCount: cnt })');
  const exportBlock = indexSrc.slice(exloStart, exloStart + 5200);
  check('Export & Logout flow uses the measured payload', exloStart > 0);
  check('document is sent BEFORE the inline code message', exportBlock.indexOf('replyWithDocument') < exportBlock.indexOf('const inlineCode = payload.inlineCode'));
  check('inline code message is wrapped in its own try/catch', /\/\/ Optional inline code \+ copy buttons[\s\S]{0,200}try \{/.test(exportBlock));
  check('logout happens AFTER the file, outside the code-message try', exportBlock.indexOf('permanentLogoutAccount') > exportBlock.indexOf('const inlineCode = payload.inlineCode'));
  check('no more "codeBlock = jsonStr.length <= 3700" crash pattern', !/const codeBlock = jsonStr\.length <= 3700/.test(indexSrc));
}

console.log('\n=== 2. Export failure still logs out nothing wrong, and never lies ===');
{
  // Simulate the exact failure path: file send throws -> no logout, honest message.
  const db = {
    config: { accounts: { acc_9302790930: { name: 'Rahul', phone: '9302790930', tid: JWT, cookies: '_sid=x' } }, bossIds: [111] },
    orders: {}
  };
  const logoutCalls = [];
  const notices = [];
  const order = { id: 'FWD5901', status: 'COMPLETED', liveOrderStatus: 'Delivered', selectedAccount: 'acc_9302790930', swiggyOrderId: '251630299198497' };
  db.orders[order.id] = order;

  const failedRun = await rel.autoExportAccountAfterDelivery(order.id, {
    getDb: () => db,
    saveDb: () => {},
    bossChatId: 111,
    sendDocument: async () => { throw new Error('400: Bad Request: message is too long'); },
    notifyBoss: async (t) => notices.push(t),
    logoutAccount: async (k) => logoutCalls.push(k)
  });
  check('export failure reported (not fake success)', failedRun.exported === false);
  check('failure carries the real Telegram reason', /message is too long/.test(failedRun.reason), failedRun.reason);
  check('account NOT logged out when the file never got through', logoutCalls.length === 0);
  check('boss is warned instead of silently losing it', notices.some((n) => /Auto export fail/.test(n)), notices.join(' | ').slice(0, 120));
  check('order is not marked exported (so it retries)', !order.autoExportDoneAt);
}

console.log('\n=== 3. Delivered order → AUTO export + logout (once, safely) ===');
{
  const mkDb = () => ({
    config: {
      accounts: {
        acc_9888877777: { name: 'Family Swiggy Pro', phone: '9888877777', tid: JWT, cookies: '_session_tid=s1; _device_id=d1', token: 'tok' }
      },
      bossIds: [111]
    },
    orders: {
      FWD5902: { id: 'FWD5902', status: 'COMPLETED', liveOrderStatus: 'Delivered', selectedAccount: 'acc_9888877777', swiggyOrderId: '251630299198498' }
    }
  });
  const db = mkDb();
  const docs = [];
  const notices = [];
  const logouts = [];
  const deps = {
    getDb: () => db,
    saveDb: () => {},
    bossChatId: 111,
    sendDocument: async (chatId, fileName, text, caption) => docs.push({ chatId, fileName, text, caption }),
    notifyBoss: async (t) => notices.push(t),
    logoutAccount: async (k) => {
      logouts.push(k);
      delete db.config.accounts[k]; // bot vault removal
    }
  };

  const first = await rel.autoExportAccountAfterDelivery('FWD5902', deps);
  check('auto export ran for the delivered order', first.exported === true, JSON.stringify(first));
  check('the 7-field .json file was sent to the Boss', docs.length === 1 && docs[0].chatId === 111);
  check('file name = swiggy_<phone>.json', docs[0].fileName === 'swiggy_9888877777.json', docs[0].fileName);
  check('file content is the portable JSON', Object.keys(JSON.parse(docs[0].text)).join(',') === 'name,customerId,mobile,token,tid,sid,deviceId');
  check('account logged out & removed from vault', logouts.length === 1 && !db.config.accounts.acc_9888877777);
  check('order stamped so it never exports twice', Boolean(db.orders.FWD5902.autoExportDoneAt));
  check('Boss card explains AUTO EXPORT & LOGOUT', notices.some((n) => /AUTO EXPORT &&#?38;? ?LOGOUT|AUTO EXPORT &amp; LOGOUT|AUTO EXPORT & LOGOUT/.test(n)), notices.join(' | ').slice(0, 100));
  check('card says account removed from vault', notices.some((n) => /logged out/.test(n)), notices.join(' | ').slice(0, 100));

  const second = await rel.autoExportAccountAfterDelivery('FWD5902', deps);
  check('second call is a no-op (idempotent)', second.exported === false && docs.length === 1);
  check('second call says already exported', /already auto-exported/.test(second.reason), second.reason);

  // Not delivered yet.
  const db2 = mkDb();
  db2.orders.FWD5902.liveOrderStatus = 'Out for delivery';
  const early = await rel.autoExportAccountAfterDelivery('FWD5902', { ...deps, getDb: () => db2 });
  check('a running order is never exported', early.exported === false && /not delivered/.test(early.reason), early.reason);

  // Account still busy with another live order.
  const db3 = mkDb();
  db3.orders.FWD5999 = { id: 'FWD5999', status: 'ACCEPTED', selectedAccount: 'acc_9888877777', liveOrderStatus: 'Order Confirmed' };
  const busy = await rel.autoExportAccountAfterDelivery('FWD5902', { ...deps, getDb: () => db3 });
  check('account with another running order is kept alive', busy.exported === false && /chal raha hai/.test(busy.reason), busy.reason);

  // Cancelled must never export.
  const db4 = mkDb();
  db4.orders.FWD5902.liveOrderStatus = 'Cancelled by restaurant';
  const cancelled = await rel.autoExportAccountAfterDelivery('FWD5902', { ...deps, getDb: () => db4 });
  check('cancelled order is not treated as delivered', cancelled.exported === false);

  // isOrderDelivered mapping
  check('isOrderDelivered: Delivered ✓', rel.isOrderDelivered({ liveOrderStatus: 'Delivered' }) === true);
  check('isOrderDelivered: heading there ✗', rel.isOrderDelivered({ liveOrderStatus: 'Out for delivery' }) === false);
  check('isOrderDelivered: cancelled ✗', rel.isOrderDelivered({ liveOrderStatus: 'Delivered cancelled' }) === false);
  check('isOrderDelivered: COMPLETED + deliveredAt ✓', rel.isOrderDelivered({ status: 'COMPLETED', deliveredAt: '2026-10-26T10:00:00Z' }) === true);
}

console.log('\n=== 4. index.js wiring: milestone + sweep + payload builder ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('delivery-release imported', /from '\.\/delivery-release\.js'/.test(src));
  check('auto export called from the delivery milestone', /if \(isDelivered\) \{\s*\n\s*autoExportDeliveredOrder\(orderId\)/.test(src));
  check('auto export also swept periodically (restart-safe)', /const runDeliveredExportSweep = \(\) =>/.test(src) && /setInterval\(runDeliveredExportSweep/.test(src));
  check('sweep skips orders already exported', /filter\(\(o\) => o && o\.id && !o\.autoExportDoneAt && isOrderDelivered\(o\)\)/.test(src));
  check('autoExportDeliveredOrder exports then logs out', /permanentLogoutAccount\(key, \{ purgeVault: true \}\);\s*\n\s*deleteAccount\(key, \{ purgeVault: true \}\);/.test(src));
  check('export loop uses buildExportPayload', /const payload = buildExportPayload\(acc, key, \{ orderCount: cnt \}\)/.test(src));
  check('export uses the portable copy button', /makeFullSessionCopyButton\(ctx, '▤ Copy Session JSON'/.test(src));
}

console.log('\n=== 5. Share link from "My Orders → Track → Share" page ===');
{
  const realFetch = globalThis.fetch;
  const LIVE = 'https://www.swiggy.com/ofo/track/9f2b7c1d4e';
  let pageHits = [];

  const htmlPage = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => `<html><body>${body}</body></html>`
  });

  // 5a. link present inside __NEXT_DATA__ (what the real page carries)
  globalThis.fetch = async (url) => {
    pageHits.push(String(url));
    if (String(url).includes('/my-orders')) {
      return htmlPage(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { orders: [{ order_id: '251630299198499', track_url: LIVE }] } }
      })}</script>`);
    }
    return htmlPage('<div>no orders</div>');
  };
  const hit = await cart.scrapeSwiggyOrderShareFromPages({ cookies: '_session_tid=abc' }, '251630299198499');
  check('page scrape finds the real share link', hit.url === LIVE, hit.url);
  check('it came from /my-orders (the human path)', /my-orders/.test(hit.page), hit.page);

  // 5b. cache prevents hammering the same page on every retry
  const before = pageHits.length;
  const cached = await cart.scrapeSwiggyOrderShareFromPages({ cookies: '_session_tid=abc' }, '251630299198499');
  check('result cached (no extra page hit)', cached.url === LIVE && pageHits.length === before, `${pageHits.length - before} extra`);

  // 5c. fabricated / foreign links are refused
  globalThis.fetch = async (url) => {
    if (String(url).includes('/my-orders')) {
      return htmlPage(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { orders: [{ order_id: '251630299198500', track_url: 'https://evil.example.com/track/251630299198500' }] } }
      })}</script>`);
    }
    return htmlPage('<div>nothing</div>');
  };
  const bad = await cart.scrapeSwiggyOrderShareFromPages({ cookies: '_sid=x' }, '251630299198500');
  check('non-Swiggy link is refused (no fake link)', bad.url === '', bad.url);

  // 5d. page with nothing → honest empty result
  globalThis.fetch = async () => htmlPage('<div>Koi order nahi</div>');
  const none = await cart.scrapeSwiggyOrderShareFromPages({ cookies: '_sid=y' }, '251630299198501');
  check('empty page returns no url (bot keeps saying "not published")', none.url === '');

  // 5e. network exploding must not throw
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const crashed = await cart.scrapeSwiggyOrderShareFromPages({ cookies: '_sid=z' }, '251630299198502').catch((e) => ({ url: 'THREW:' + e.message }));
  check('network error is swallowed', crashed.url === '', String(crashed.url));

  // 5f. offline fallback inside fetchSwiggyTrackingLinkFast: DAPI empty, page has it
  globalThis.fetch = async (url, opts = {}) => {
    pageHits.push(String(url));
    const u = String(url);
    if (u.includes('/dapi/') || u.includes('/mapi/')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ statusCode: 0, data: {} }), text: async () => '{"statusCode":0,"data":{}}' };
    }
    if (u.includes('/my-orders')) {
      return htmlPage(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { orders: [{ order_id: '251630299198503', share: { url: 'https://www.swiggy.com/track/ab12cd34ef' } }] } }
      })}</script>`);
    }
    return htmlPage('<div>-</div>');
  };
  const fast = await cart.fetchSwiggyTrackingLinkFast({ cookies: '_session_tid=q', customerId: '287113492' }, '251630299198503', { budgetMs: 4000, attempts: 1 });
  check('fast path falls back to the page share link', fast.url === 'https://www.swiggy.com/track/ab12cd34ef', fast.url);
  check('fallback is tagged as WEB_PAGE_SHARE', fast.via === 'WEB_PAGE_SHARE', String(fast.via));

  globalThis.fetch = realFetch;
}

console.log('\n=== 6. No fake claims in the tracking copy ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('cart scrape validates every candidate', /validateTrackingUrlForOrder\(url, \{ swiggyOrderId: cleanId \}, 'SWIGGY_API'\)/.test(cartSrc));
  check('cart scrape never builds a URL from the order id', !/swiggy\.com\/track\/\$\{cleanId\}/.test(cartSrc));
  check('cart scrape caches misses too (WAF safety)', /orderSharePageCache\.set\(cleanId, \{ url: '', page: '', at: Date\.now\(\) \}\)/.test(cartSrc));
  check('shipped vendor copy has the scrape too', fs.readFileSync('./bossbot/vendor/swiggy-cart.js', 'utf8').includes('scrapeSwiggyOrderShareFromPages'));
  check('bot still admits when no link exists', /share link abhi publish nahi kiya|share link abhi publish nahi/.test(src));
}

console.log(`\n${'='.repeat(70)}`);
if (failed === 0) {
  console.log(`🏆 EXPORT FIX + AUTO EXPORT ON DELIVERY + PAGE SHARE LINK VERIFIED — ${passed}/${passed} checks passed`);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
}
process.exit(failed === 0 ? 0 : 1);
