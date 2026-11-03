// Boss (03-11-2026): "bhia max offer and free cash jaise swiggy me auto lag
// jata waise isme bhi lag jaye ... usko time nahi lagta mere me bhi na lage
// and without any error hojaye".
//
// Offline guard (koi live Swiggy/Telegram/UPI call nahi):
//   1) instant auto: Swiggy ka best coupon + campaign Free Cash EK HI cart
//      write me, verified readback se (blind trial ladder bilkul nahi).
//   2) feed/claim/coupon sab fail ho to bhi bill aata hai — error nahi,
//      jhootha "applied" bhi nahi.
//   3) feed empty ho to Swiggy ka cart-suggested code EK targeted write me.
//   4) pehle verified code doosre bill par 0 discovery call me lagta hai.
//   5) purana deep engine waise hi zinda hai (refresh ke liye).
//   6) server `offerMode: 'instant'` ko provider tak pahunchata hai, app
//      automatic bill me ye mode bhejta hai, UI auto badge sach dikhati hai.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v126-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v126-offline-token', PRO_VAULT_KEY: 'v126-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test',
  SWIGGY_BLOCK_LIVE_ORDER_PLACE: '1'
});
const realFetch = globalThis.fetch;
const { proProvider, addressFingerprint } = await import('../swiggy-pro-provider.js');
const { resetInstantOfferCache, selectInstantCoupon, extractCouponSaving } = await import('../instant-offer-engine.js');
const { handleSwiggyProHttp } = await import('../swiggy-pro-api.js');
const { writeProWorkspace } = await import('../swiggy-pro-store.js');

const appSource = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../swiggy-pro-api.js', import.meta.url), 'utf8');
const providerSource = fs.readFileSync(new URL('../swiggy-pro-provider.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../swiggy-pro.html', import.meta.url), 'utf8')
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');

const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567', exp: 1900000000 })).toString('base64url') + '.signature';
const account = () => ({ phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true });
const address = { id: 'addr-1', name: 'Receiver', mobile: '9234567890', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', selected: true };
const cart = () => ({
  restaurantId: '201', restaurantName: 'Mock', forSomeoneElse: false, autoCoupon: true, skipOfferClaim: true,
  confirmedAddress: { ...address, fingerprint: addressFingerprint(address), savedAt: Date.now() },
  items: [{ menu_item_id: 9001, qty: 1, name: 'Biryani', price: 230, variants: [], addons: [] }], quote: null
});

const state = {
  coupon: '', trade: 0, reward: 0, coupons: [], suggested: '', suggestInCart: '',
  discoveryFail: false, claimFail: false, bulkHonorsCoupon: true, requests: [], updateCalls: 0, applyCalls: 0
};
function reset() {
  Object.assign(state, {
    coupon: '', trade: 0, reward: 0, coupons: [], suggested: '', suggestInCart: '',
    discoveryFail: false, claimFail: false, bulkHonorsCoupon: true, requests: [], updateCalls: 0, applyCalls: 0
  });
  resetInstantOfferCache();
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function cartPayload() {
  const discount = state.coupon === 'BEST80' ? 80 : state.coupon === 'SAVE50' ? 50 : 0;
  const total = 270 - discount - state.trade;
  return { statusCode: 0, data: { cartMeta: {
    address_id: 'addr-1', cartId: 'cart-1', order_total: total, item_total: 230,
    restaurant_details: { id: '201', name: 'Mock' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Biryani', subtotal: 23000, final_price: 23000, addons: [], variants: [] }],
    coupon_code: state.coupon || state.suggestInCart || '',
    is_coupon_valid: state.coupon ? 1 : 0,
    coupon_discount_total: discount, coupon_discount_effective: discount,
    trade_discount_total: state.trade, trade_discount_reward_amount: state.reward,
    user_swiggy_money: 0, swiggy_pay_eligible_balance: 0, swiggy_money: 0,
    taxesAndCharges: 30, total_packing_charges: 10, is_order_for_someone_else: false
  } } };
}
const mockFetch = async (raw, options = {}) => {
  const u = String(raw);
  state.requests.push(u);
  if (u.includes('events.swiggy.com')) {
    if (state.claimFail) throw new Error('offer campaign unavailable');
    return new Response('<html></html>', { status: 200 });
  }
  if (u.includes('mcp.swiggy.com') || u.includes('/dapi/offers/')) {
    if (state.discoveryFail) return json({ error: 'offers down' }, 503);
    return json({ result: { structuredContent: {
      coupons: state.coupons, offers: { coupon_applied: state.suggested }
    } } });
  }
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwt, data: { addresses: [address] } });
  if (u.includes('/api/v2/cart/client')) {
    const body = options.body ? JSON.parse(options.body) : null;
    if (u.includes('applycoupon')) {
      state.applyCalls++;
      if (state.bulkHonorsCoupon) state.coupon = String(body?.coupon_code || body?.couponCode || '').toUpperCase();
      return json(cartPayload());
    }
    if (u.includes('removecoupon')) { state.coupon = ''; return json(cartPayload()); }
    if (u.includes('/flush')) return json({ statusCode: 0, data: {} });
    if (u.includes('/update') && body) {
      state.updateCalls++;
      const code = String(body.couponCode || '').toUpperCase();
      if (state.bulkHonorsCoupon) state.coupon = code;
      return json(cartPayload());
    }
    return json(cartPayload());
  }
  return json({ statusCode: 0, data: {} });
};
async function withMock(fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try { return await fn(); } finally { globalThis.fetch = prev; }
}
const offerReads = () => state.requests.filter(u => u.includes('mcp.swiggy.com') || u.includes('/dapi/offers/')).length;
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

// ── 1. Swiggy jaisa EK write: best coupon + free cash ─────────────────────
test('instant: best coupon + campaign free cash EK hi verified cart write me', async () => {
  reset();
  state.trade = 50; state.reward = 50;
  state.coupons = [
    { coupon_code: 'SAVE20', is_applicable: true, title: 'Flat ₹20 off' },
    { coupon_code: 'BEST80', is_applicable: true, title: 'Flat ₹80 off' },
    { coupon_code: 'BADONE', is_applicable: false, title: 'Flat ₹500 off' }
  ];
  const out = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true, instantAuto: true
  }));
  assert.equal(out.bill.couponCode, 'BEST80', 'feed ka sabse bada discount auto laga');
  assert.equal(out.bill.discount, 80);
  assert.equal(out.bill.freeCash, 50, 'Swiggy cart ka asli campaign cash');
  assert.equal(out.bill.total, 140);
  assert.equal(out.bill.autoCoupon, true);
  assert.equal(out.bill.autoOfferMode, 'instant');
  assert.equal(out.bill.engine.instantAuto, true);
  assert.equal(out.bill.engine.autoOffer.cartWrites, 1, 'ek hi cart write — koi trial ladder nahi');
  assert.equal(out.bill.engine.couponTrials.length, 1, 'sirf chuna hua code verify hua');
  assert.equal(state.applyCalls, 0, 'dedicated apply ki zarurat hi nahi padi');
  assert.equal(out.optimizePending, false, 'bill baad me badalta nahi');
  assert.match(out.bill.offerNote, /Free Cash ₹50.*auto-applied/i);
  // Offer reads address/cart ke saath parallel shuru hote hain, baad me nahi.
  const firstOffer = state.requests.findIndex(u => u.includes('mcp.swiggy.com') || u.includes('/dapi/offers/'));
  const firstWrite = state.requests.findIndex(u => u.includes('/api/v2/cart/client/update'));
  assert.ok(firstOffer >= 0 && firstWrite >= 0 && firstOffer < firstWrite, 'offer feed cart write se pehle shuru');
});

// ── 2. Sab kuch fail: phir bhi verified bill, koi error / jhooth nahi ──────
test('error-proof: feed, claim aur coupon sab fail — bill aata hai, jhooth nahi', async () => {
  reset();
  state.discoveryFail = true; state.claimFail = true; state.bulkHonorsCoupon = false;
  const out = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true, instantAuto: true
  }));
  assert.equal(out.bill.total, 270, 'Swiggy ka plain payable');
  assert.equal(out.bill.couponCode, '', 'bina verification coupon kabhi nahi dikha');
  assert.equal(out.bill.discount, null);
  assert.equal(out.bill.freeCash, null, 'claim fail par cash ka jhootha discount nahi');
  assert.match(out.bill.offerNote, /claim|Free Cash ₹0|cash/i);
  assert.ok(out.bill.engine.autoOffer.cartWrites <= 3, 'koi trial storm nahi');
  assert.equal(out.bill.engine.autoOffer.source, 'none');
});

test('error-proof: Swiggy ne chuna code reject kiya to bill bina coupon ke aata hai', async () => {
  reset();
  state.bulkHonorsCoupon = false;
  state.coupons = [{ coupon_code: 'BEST80', is_applicable: true, title: 'Flat ₹80 off' }];
  const out = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true, instantAuto: true
  }));
  assert.equal(out.bill.couponCode, '');
  assert.equal(out.bill.total, 270);
  assert.equal(out.bill.engine.couponTrials[0].ok, false, 'reject ka sach engine me');
  assert.equal(out.bill.engine.autoOffer.cartWrites, 1);
});

// ── 3. Feed khaali ho to Swiggy ka cart-suggested code EK targeted write ───
test('instant: feed empty par Swiggy ka suggested coupon ek hi extra write me', async () => {
  reset();
  state.suggestInCart = 'SAVE50';
  const out = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true, instantAuto: true
  }));
  assert.equal(out.bill.couponCode, 'SAVE50');
  assert.equal(out.bill.discount, 50);
  assert.equal(out.bill.total, 220);
  assert.equal(out.bill.engine.autoOffer.source, 'cart_suggested');
  assert.equal(out.bill.engine.autoOffer.cartWrites, 2, 'sirf ek targeted extra write');
});

// ── 4. Doosra bill: verified cache se ZERO discovery call ──────────────────
test('speed: agla bill cached verified coupon se 0 offer-discovery call me', async () => {
  reset();
  state.coupons = [{ coupon_code: 'BEST80', is_applicable: true, title: 'Flat ₹80 off' }];
  const first = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true, instantAuto: true
  }));
  assert.equal(first.bill.couponCode, 'BEST80');
  const before = offerReads();
  state.coupons = []; state.suggested = '';
  const second = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true, instantAuto: true
  }));
  assert.equal(second.bill.couponCode, 'BEST80', 'pichhla verified code seedha laga');
  assert.equal(offerReads(), before, 'doosre bill par offer feed ka koi call nahi');
  assert.equal(second.bill.engine.autoOffer.cartWrites, 1);
  assert.equal(second.bill.engine.autoOffer.source, 'verified');
});

// ── 5. Purana deep engine zinda hai (explicit refresh) ────────────────────
test('deep mode: bina instantAuto ke purana max-coupon trial engine chalta hai', async () => {
  reset();
  state.coupons = [
    ...Array.from({ length: 5 }, (_, i) => ({ coupon_code: `CODE${i}`, is_applicable: true })),
    { coupon_code: 'BEST80', is_applicable: true }
  ];
  const out = await withMock(() => proProvider.quoteCart(account(), address, cart(), '', {
    phase: 'full', autoCoupon: true
  }));
  assert.equal(out.bill.couponCode, 'BEST80');
  assert.equal(out.bill.engine.instantAuto, undefined, 'deep engine me instant flag nahi');
  assert.ok(out.bill.engine.couponTrials.length > 1, 'deep mode me trial ladder zinda');
});

// ── 6. Pure selector: jhoothe "best" aur ineligible code kabhi nahi ────────
test('selector: ineligible / jhootha discount chun kar bill nahi bigadta', () => {
  assert.equal(extractCouponSaving({ title: 'Minimum order ₹199' }), null, 'min-order amount saving nahi');
  assert.equal(extractCouponSaving({ title: 'Flat ₹125 OFF' }), 125);
  assert.equal(extractCouponSaving({ title: '50% OFF up to ₹100' }, 300), 100);
  const picked = selectInstantCoupon({
    mcpCoupons: { structured: { coupons: [
      { coupon_code: 'FAKE500', is_applicable: false, title: 'Flat ₹500 off' },
      { coupon_code: 'REAL60', is_applicable: true, title: 'Flat ₹60 off' }
    ] } }, mcpCart: null, itemTotal: 300
  });
  assert.equal(picked.code, 'REAL60');
  assert.equal(selectInstantCoupon({ mcpCoupons: null, mcpCart: null, itemTotal: 0 }), null);
  assert.equal(selectInstantCoupon({
    mcpCoupons: null,
    mcpCart: { structured: { offers: { coupon_applied: 'SWIGGYBEST' } } }, itemTotal: 300
  }).code, 'SWIGGYBEST');
});

// ── 7. Server + app wiring ────────────────────────────────────────────────
const USER = '7910';
const serverAddress = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const quoteOptions = [];
const fakeProvider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [serverAddress]; },
  async orders() { return []; },
  async quoteCart(_account, _address, _wsCart, _coupon, options = {}) {
    quoteOptions.push(options);
    return {
      address: serverAddress, addressFingerprint: 'fp', optimizePending: false,
      bill: {
        itemTotal: 230, deliveryFee: 0, packingCharges: 10, taxes: 30,
        discount: 80, coupon: 'BEST80', couponCode: 'BEST80', tradeDiscount: null,
        freeCash: 50, total: 140, autoOfferMode: 'instant', autoOfferSource: 'swiggy_suggested', autoOfferMs: 812
      }
    };
  }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fakeProvider, authorizeUser: async () => ({ allowed: true }) })) {
    res.writeHead(404); res.end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); });
function sign(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'User ' + userId }),
    query_id: 'query'
  });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
async function post(route, body) {
  const res = await fetch(baseUrl + '/pro/api/' + route, {
    method: 'POST',
    headers: { 'X-Telegram-Init-Data': sign(USER), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function seedWorkspace() {
  writeProWorkspace(USER, {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: serverAddress, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Mock', forSomeoneElse: false,
      items: [{ lineKey: 'l1', id: '9001', menu_item_id: 9001, name: 'Biryani', qty: 1, price: 230, variants: [], addons: [] }],
      quote: null
    }
  });
}

test('server: offerMode instant sirf auto bill par instantAuto bhejta hai', async () => {
  seedWorkspace(); quoteOptions.length = 0;
  const instant = await post('cart/sync', { confirmReplaceSwiggyCart: true, autoCoupon: true, offerMode: 'instant', phase: 'full' });
  assert.equal(instant.status, 200);
  assert.equal(quoteOptions.at(-1).instantAuto, true, 'instant engine chala');
  assert.equal(quoteOptions.at(-1).phase, 'full', 'ek hi poora bill');
  assert.equal(instant.body.cart.quote.autoOfferMode, 'instant');
  assert.equal(instant.body.cart.quote.autoOfferMs, 812);
  assert.equal(instant.body.cart.quote.total, 140);

  seedWorkspace();
  const manual = await post('cart/sync', { confirmReplaceSwiggyCart: true, autoCoupon: false, coupon: 'TRYNEW', offerMode: 'instant' });
  assert.equal(manual.status, 200);
  assert.equal(quoteOptions.at(-1).instantAuto, undefined, 'user ka khud ka code instant mode me nahi badalta');
  const deep = await post('cart/sync', { confirmReplaceSwiggyCart: true, autoCoupon: true, offerMode: 'deep' });
  assert.equal(deep.status, 200);
  assert.equal(quoteOptions.at(-1).instantAuto, undefined, 'deep refresh purana engine rakhta hai');
});

test('app + provider: automatic bill instant mode maangta hai, UI auto badge sach dikhati hai', async () => {
  assert.match(appSource, /offerMode: 'instant'/, 'app ka auto bill instant maangta hai');
  assert.match(apiSource, /body\.offerMode === 'instant'/, 'server instant mode samajhta hai');
  assert.match(providerSource, /quoteInstantCart\(/, 'provider instant engine call karta hai');
  assert.match(css, /\.auto-offer-note \{/);

  const stateUi = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: serverAddress,
    checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
    cart: {
      restaurantId: '201', restaurantName: 'Mock', forSomeoneElse: false,
      items: [{ lineKey: 'l', name: 'Biryani', price: 230, qty: 1, isVeg: true }],
      quote: {
        total: 140, itemTotal: 230, deliveryFee: 0, taxes: 30, discount: 80, coupon: 'BEST80',
        couponCode: 'BEST80', freeCash: 50, autoOfferMode: 'instant', fetchedAt: new Date().toISOString()
      }
    },
    checkout: null,
    wallet: { balancePaise: 1500, balance: '15', feePaise: 1500, fee: '15', ready: true, shortfall: '0', upiId: 'mius@ybl', presets: [] },
    idle: { timeoutMs: 120000, closed: null, abandoned: [] }
  };
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => stateUi });
  window.eval(appSource);
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch { /* retry */ } await new Promise(r => setTimeout(r, 20)); }
    throw new Error('timeout: ' + label);
  };
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not(:disabled)'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    const badge = await waitFor(() => window.document.querySelector('.auto-offer-note'), 'auto offer badge');
    assert.match(badge.textContent, /best coupon \+ Free Cash auto-applied/i);
    assert.match(badge.textContent, /verified/i);
    // Bina coupon/cash ke jhootha "auto-applied" nahi.
    stateUi.cart.quote = { ...stateUi.cart.quote, discount: null, coupon: '', couponCode: '', freeCash: null, total: 270 };
    window.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => !window.document.querySelector('.auto-offer-note'), 'jhootha badge hat gaya');
  } finally { window.close(); }
});
