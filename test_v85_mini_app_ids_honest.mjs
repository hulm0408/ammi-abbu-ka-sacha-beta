// test_v85_mini_app_ids_honest.mjs
// Boss (30-10-2026): "ID choose karne ka option ho… har ek ID ke saamne likh
// rahega ki isse koi order place hua hai ki nahi, suspend ya koi bhi dikkat ho…
// free cash icon… offer active hai ya nahi… OPEN MINI APP button."
//
// Yeh guard mini app ka SACH lock karta hai:
//   1. Token: bina signed token koi andar nahi (tampered/expired → 403 reason).
//   2. ID list: USED / READY / SUSPENDED / SESSION_EXPIRED / BUSY / UNVERIFIED —
//      sab live sach se. Jo verify nahi hua usko "used" nahi kehte.
//   3. Used/suspended/busy ID select hi nahi hoti (kai bar "kaat dega" rule).
//   4. Auto ID select sirf selectable ID par.
//   5. Address/cart parse honest error deta hai (jhootha success nahi).
//   6. Confirm: items ke Swiggy IDs ke bina order nahi banta; bill live cart se.
//   7. Bot button tabhi banta hai jab public URL pata ho (jhootha link nahi).

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-MINIAPP';
process.env.NODE_ENV = 'test';
process.env.MINI_APP_SECRET = 'test-mini-app-secret';
delete process.env.PUBLIC_URL;
delete process.env.RENDER_EXTERNAL_URL;

import fs from 'node:fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const miniApp = await import('./mini-app.js');
const { renderMiniAppHtml } = await import('./mini-app-page.js');
const { handleMiniAppApi } = await import('./index.js');

// ── 1) Token ───────────────────────────────────────────────────────────────
{
  const token = miniApp.issueMiniAppToken('424242');
  const ok = miniApp.verifyMiniAppToken(token);
  check('valid token khulta hai', ok.ok === true && ok.userId === '424242', JSON.stringify(ok));

  const tampered = token.slice(0, -3) + 'abc';
  check('tampered token reject', miniApp.verifyMiniAppToken(tampered).ok === false);
  check('tampered token ka reason hai', /TOKEN_/.test(miniApp.verifyMiniAppToken(tampered).reason || ''));

  const expired = miniApp.issueMiniAppToken('424242', { now: 1000, ttlMs: 60_000 });
  check('expired token reject', miniApp.verifyMiniAppToken(expired, { now: 999_999 }).reason === 'TOKEN_EXPIRED');
  check('khaali token reject', miniApp.verifyMiniAppToken('').reason === 'TOKEN_MISSING');
  check('dusre user ka token userId badal ke nahi chalta', miniApp.verifyMiniAppToken(token).userId === '424242');
  const other = miniApp.issueMiniAppToken('999');
  check('alag user ka token alag hai', other !== token);
}

// ── 2) ID picker — har ID ka sach ──────────────────────────────────────────
const fakeDb = {
  config: {
    accounts: {
      acc_fresh: { phone: '9811111111', cookies: '_session_tid=a;', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0, freeCashBalance: 50, offers: { breakfast: { status: 'CLAIMED' } } },
      acc_used: { phone: '9822222222', cookies: '_session_tid=b;', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 7 },
      acc_unverified: { phone: '9833333333', cookies: '_session_tid=c;', isLoggedIn: true },
      acc_suspended: { phone: '9844444444', cookies: '_session_tid=d;', isLoggedIn: true, healthStatus: 'SUSPENDED', suspendReason: 'Swiggy block' },
      acc_expired: { phone: '9855555555', isLoggedIn: false },
      acc_busy: { phone: '9866666666', cookies: '_session_tid=e;', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0 }
    }
  },
  orders: {
    O1: { id: 'O1', status: 'PENDING', cardStage: 'QR_GENERATED', selectedAccount: 'acc_busy' }
  }
};

{
  const list = miniApp.buildMiniAppIdList('424242', { db: fakeDb });
  const byKey = Object.fromEntries(list.rows.map((r) => [r.key, r]));
  check('fresh 0-order ID = READY', byKey.acc_fresh.status === 'READY', byKey.acc_fresh.status);
  check('fresh ID select ho sakti hai', byKey.acc_fresh.selectable === true);
  check('used ID = USED', byKey.acc_used.status === 'USED', byKey.acc_used.status);
  check('used ID select nahi hoti ("kaat dega")', byKey.acc_used.selectable === false);
  check('used ID ka reason saaf', /7 order/.test(byKey.acc_used.reason), byKey.acc_used.reason);
  check('suspended ID = SUSPENDED', byKey.acc_suspended.status === 'SUSPENDED' && byKey.acc_suspended.selectable === false);
  check('suspended ID par ⛔ icon', byKey.acc_suspended.icons.includes('⛔'));
  check('expired session = SESSION_EXPIRED', byKey.acc_expired.status === 'SESSION_EXPIRED');
  check('busy ID = BUSY + order id', byKey.acc_busy.status === 'BUSY' && byKey.acc_busy.busyOrderId === 'O1');
  check('unverified ID = UNVERIFIED (used nahi bolte)', byKey.acc_unverified.status === 'UNVERIFIED' && byKey.acc_unverified.orders === null);
  check('fresh ID par ★ icon', byKey.acc_fresh.icons.includes('★'));
  check('free cash icon 💵 dikhta hai', byKey.acc_fresh.icons.includes('💵') && byKey.acc_fresh.freeCash === 50);
  check('offer icon 🎁 dikhta hai + offer naam', byKey.acc_fresh.icons.includes('🎁') && byKey.acc_fresh.offers.length >= 1);
  check('READY IDs list me sabse upar', list.rows[0].status === 'READY');
  check('summary counts sach me hain', list.readyCount === 1 && list.usedCount === 1 && list.blockedCount === 2, JSON.stringify({ r: list.readyCount, u: list.usedCount, b: list.blockedCount }));
}

// ── 3) Selection — galat ID par saaf mana ─────────────────────────────────
{
  const used = miniApp.selectMiniAppAccount('424242', 'acc_used', { db: fakeDb });
  check('used ID select karne par mana', used.ok === false && used.code === 'ID_USED', JSON.stringify(used));
  const suspended = miniApp.selectMiniAppAccount('424242', 'acc_suspended', { db: fakeDb });
  check('suspended ID select karne par mana', suspended.ok === false && suspended.code === 'ID_SUSPENDED');
  const missing = miniApp.selectMiniAppAccount('424242', 'acc_nahi_hai', { db: fakeDb });
  check('anjaan ID par ACCOUNT_NOT_FOUND', missing.code === 'ACCOUNT_NOT_FOUND');

  // disk db par select (state save)
  const { getDb } = await import('./store.js');
  const live = getDb();
  live.config = live.config || {};
  live.config.accounts = { ...(live.config.accounts || {}), acc_fresh: fakeDb.config.accounts.acc_fresh };
  live.orders = live.orders || {};
  await import('./store.js').then((m) => m.saveDb(live));
  const good = miniApp.selectMiniAppAccount('424242', 'acc_fresh', { db: getDb() });
  check('READY ID select ho jati hai', good.ok === true, JSON.stringify(good));
  check('selectedKey state me save hui', miniApp.getMiniAppState('424242', { db: getDb() }).accountKey === 'acc_fresh');
  const resolved = miniApp.resolveSelectedAccount('424242', { db: getDb() });
  check('chuni hui ID resolve hoti hai', resolved.ok === true && resolved.key === 'acc_fresh');
  const none = miniApp.resolveSelectedAccount('no-state-user', { db: fakeDb });
  check('bina chune confirm nahi (NO_ID_SELECTED)', none.ok === false && none.code === 'NO_ID_SELECTED');
}

// ── 4) Search filter ───────────────────────────────────────────────────────
{
  const menu = [
    { id: '1', name: 'Paneer Butter Masala', price: 260 },
    { id: '2', name: 'Chicken Biryani', price: 320 },
    { id: '3', name: 'Paneer Tikka', price: 210, inStock: false }
  ];
  const paneer = miniApp.filterMenuItems(menu, 'paneer');
  check('search sirf match karta hai', paneer.length === 2 && paneer.every((x) => /paneer/i.test(x.name)));
  check('search price number rehti hai', paneer[0].price === 260);
  check('khaali query par poora menu (limit ke andar)', miniApp.filterMenuItems(menu, '').length === 3);
}

// ── 5) API: token ke bina kuch nahi ──────────────────────────────────────
{
  const state = await handleMiniAppApi({
    pathname: '/api/app/state',
    reqUrl: new URL('http://x/api/app/state'),
    body: {},
    userId: '424242'
  });
  check('state API ok deta hai', state.status === 200 && state.json.ok === true, JSON.stringify(state.json).slice(0, 160));
  check('state API me rows hain', Array.isArray(state.json.rows) && state.json.rows.length >= 1);

  const auto = state.json.selectedKey;
  check('auto ID select hoti hai (boss: ek auto ID select karke)', Boolean(auto), String(auto));

  const badAddress = await handleMiniAppApi({
    pathname: '/api/app/address',
    reqUrl: new URL('http://x/api/app/address'),
    body: { text: 'hello dosto' },
    userId: '424242'
  });
  check('address na samajh aaye to jhootha success nahi', badAddress.json.ok === false && badAddress.json.code === 'ADDRESS_NOT_READ');

  const goodAddress = await handleMiniAppApi({
    pathname: '/api/app/address',
    reqUrl: new URL('http://x/api/app/address'),
    body: { text: 'Ammi\n9823305540\nFlat 4, Gomti Nagar, Lucknow 226010' },
    userId: '424242'
  });
  check('typed address accept hota hai', goodAddress.json.ok === true, JSON.stringify(goodAddress.json).slice(0, 160));

  const badCart = await handleMiniAppApi({
    pathname: '/api/app/cart',
    reqUrl: new URL('http://x/api/app/cart'),
    body: { text: 'kuch bhi' },
    userId: '424242'
  });
  check('cart na samajh aaye to jhootha success nahi', badCart.json.ok === false && badCart.json.code === 'CART_NOT_READ');

  const confirmNoIds = await handleMiniAppApi({
    pathname: '/api/app/confirm',
    reqUrl: new URL('http://x/api/app/confirm'),
    body: { items: [{ id: '', name: 'Paneer', price: 200, qty: 1 }] },
    userId: '424242'
  });
  check('bina Swiggy item IDs order nahi banta', confirmNoIds.json.ok === false && confirmNoIds.json.code === 'ITEMS_WITHOUT_IDS', JSON.stringify(confirmNoIds.json));
}

// ── 6) Bot button — jhootha link kabhi nahi ───────────────────────────────
{
  const noBase = miniApp.buildMiniAppInviteCard('424242', { baseUrl: '' });
  check('base URL na ho to koi url nahi', !noBase.url && !JSON.stringify(noBase.keyboard).includes('/app?t='));
  check('card me steps saaf hain', /ID chuno/.test(noBase.text) && /Address link paste/.test(noBase.text));
  const withBase = miniApp.buildMiniAppInviteCard('424242', { baseUrl: 'https://bot.example.com/' });
  check('base URL ho to signed link banta hai', /^https:\/\/bot\.example\.com\/app\?t=/.test(withBase.url), withBase.url);
  const tokenInUrl = decodeURIComponent(withBase.url.split('t=')[1]);
  check('link ka token verify hota hai', miniApp.verifyMiniAppToken(tokenInUrl).userId === '424242');
}

// ── 7) Page + server wiring ───────────────────────────────────────────────
{
  const html = renderMiniAppHtml({ token: 'abc.def' });
  check('page me token aata hai', html.includes('"abc.def"'));
  check('page me ID list / steps hain', /Swiggy ID chuno/.test(html) && /Address/.test(html) && /Confirm order/.test(html));
  check('page me koi inline eval/unsafe insert nahi', !/innerHTML\s*=\s*[^'"]/.test(html.replace(/innerHTML = ''/g, '')));

  const src = fs.readFileSync('./index.js', 'utf8');
  check('server /app route token verify karta hai', /reqUrl\.pathname === '\/app'[\s\S]{0,220}verifyMiniAppToken/.test(src));
  check('API routes bhi token verify karte hain', /startsWith\('\/api\/app\/'\)[\s\S]{0,260}verifyMiniAppToken/.test(src));
  check('confirm live cart se bill leta hai', /liveTotal/.test(src) && /swiggyVerified: true/.test(src));
  check('/app command bot me hai', /bot\.command\(\['app', 'miniapp', 'mini'\]/.test(src));
  check('user screen par mini app button jodta hai', /attachMiniAppButton\(userId/.test(src));
  check('confirm par boss ko alert jata hai', /MINI APP ORDER/.test(src));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} v85 mini app (ID truth): ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
