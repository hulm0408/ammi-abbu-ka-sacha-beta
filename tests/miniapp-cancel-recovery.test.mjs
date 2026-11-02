// Offline DOM regression for the "cancel dabaya par card wapas aata hai" bug.
//   • Pay Now ka response kho jaye (lost response) → OUTCOME_UNKNOWN card.
//     Recovery bootstrap server ke workspace lock ke peeche atak sakta hai.
//   • User cancel kare → card hat jaana chahiye.
//   • Cancel ke BAAD purana Pay Now response / atke hue bootstrap ka jawab
//     card wapas nahi la sakta (epoch guard).
//   • Server par checkout pehle hi band ho (404) → error nahi, saaf message.
// Fake Telegram/provider only. No Swiggy, UPI or real order is contacted.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const appSource = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');

const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const baseState = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: address,
  checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
  cart: {
    restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false,
    items: [{ lineKey: 'l', name: 'Paneer', price: 230, qty: 1, isVeg: true }],
    quote: { total: 352, itemTotal: 342, deliveryFee: 28, taxes: 32, discount: 50, coupon: 'TRYNEW', freeCash: 50, fetchedAt: new Date().toISOString() }
  },
  checkout: null,
  wallet: { balancePaise: 1500, balance: '15', feePaise: 1500, fee: '15', ready: true, shortfall: '0', upiId: 'mius@ybl', presets: [] },
  idle: { timeoutMs: 120000, closed: null, abandoned: [] },
  ...over
});

async function mount(routes) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  const calls = [];
  window.fetch = (url, opts = {}) => {
    const path = String(url).replace('/pro/api/', '');
    calls.push(path);
    const handler = routes[path] || routes['*'];
    return Promise.resolve(handler ? handler(opts) : { status: 500, body: { ok: false, error: 'unexpected ' + path } })
      .then(res => ({ ok: res.status < 300, status: res.status, json: async () => res.body }));
  };
  window.eval(appSource);
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      try { const v = fn(); if (v) return v; } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timeout: ' + label);
  };
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not(:disabled)'), 'nav');
  window.document.querySelector('[data-tab="cart"]').click();
  return { window, waitFor, calls };
}

// Deferred helper: test decides when (and how) a request settles.
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('cancel ke baad stale Pay Now failure card wapas nahi laata', async () => {
  const state = baseState();
  const payCall = deferred();
  const staleBootstrap = deferred();
  let bootstrapCount = 0;
  const { window, waitFor } = await mount({
    'bootstrap': () => {
      bootstrapCount += 1;
      // Pehla bootstrap (page load) turant; recovery wala lock ki tarah atakta hai.
      if (bootstrapCount === 1) return { status: 200, body: state };
      return staleBootstrap.promise;
    },
    'checkout': () => payCall.promise,
    'checkout/cancel': () => ({ status: 200, body: { ok: true, checkout: null, cart: state.cart, message: 'Checkout band. Paisa nahi kata.' } })
  });
  try {
    const pay = await waitFor(() => window.document.querySelector('.pay-bar .pay-now'), 'pay button');
    pay.click();
    const confirmOk = await waitFor(() => window.document.querySelector('.confirm-dialog .button.primary'), 'pay confirm');
    confirmOk.click();
    // Response kho gaya — browser ko koi jawab nahi mila.
    payCall.reject(new TypeError('Failed to fetch'));
    await waitFor(() => window.document.querySelector('.cancel-card'), 'lost-response card');

    // User cancel karta hai.
    window.document.querySelector('.cancel-card [data-action="checkout-cancel"]').click();
    const confirmCancel = await waitFor(() => window.document.querySelector('.confirm-dialog .button.danger'), 'cancel confirm');
    confirmCancel.click();
    await waitFor(() => window.document.querySelector('.pay-bar .pay-now') && !window.document.querySelector('.cancel-card'), 'cart wapas');

    // Ab atka hua recovery bootstrap server state (checkout OUTCOME_UNKNOWN) laata hai.
    staleBootstrap.resolve({ status: 200, body: baseState({ checkout: { status: 'OUTCOME_UNKNOWN', message: 'stale' } }) });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(window.document.querySelector('.cancel-card'), null, 'stale response se card wapas nahi aana chahiye');
    assert.ok(window.document.querySelector('.pay-bar .pay-now'), 'cart Pay Now ke saath khula hai');
  } finally { window.close(); }
});

test('cancel 404 (server par checkout pehle se band) → error nahi, saaf message aur cart', async () => {
  let window404 = false;
  // Server par checkout pehle hi nahi hai (404 ka matlab yahi): bootstrap bhi null.
  const withCheckout = baseState({ checkout: { status: 'OUTCOME_UNKNOWN', message: 'lost', orderId: '' } });
  const { window, waitFor } = await mount({
    'bootstrap': () => ({ status: 200, body: withCheckout.checkout && window404 ? baseState() : withCheckout }),
    'checkout/cancel': () => { window404 = true; return { status: 404, body: { ok: false, error: 'Koi checkout khula nahi hai.' } }; }
  });
  try {
    await waitFor(() => window.document.querySelector('.cancel-card'), 'cancel card');
    window.document.querySelector('.cancel-card [data-action="checkout-cancel"]').click();
    const confirmCancel = await waitFor(() => window.document.querySelector('.confirm-dialog .button.danger'), 'cancel confirm');
    confirmCancel.click();
    const toast = await waitFor(() => /pehle hi band/.test(window.document.querySelector('#toast')?.textContent || '') && window.document.querySelector('#toast'), 'toast');
    assert.ok(toast, 'saaf message dikhe');
    assert.equal(window.document.querySelector('.cancel-card'), null, 'card gaya');
  } finally { window.close(); }
});

test('recovery bootstrap timeout ke saath hai — UI lock ke peeche hamesha ke liye nahi atakta', async () => {
  // Source guard: sab recovery bootstrap calls timeout ke saath hon.
  const cancelAt = appSource.indexOf("else if (action === 'checkout-cancel')");
  const cancelEnd = appSource.indexOf("else if (action === 'back-to-cart')");
  assert.ok(cancelAt > 0 && cancelEnd > cancelAt, 'checkout-cancel block mila');
  assert.match(appSource.slice(cancelAt, cancelEnd), /api\('bootstrap', 'GET', undefined, \{ timeoutMs: 8000 \}\)/);
  const startAt = appSource.indexOf("else if (action === 'checkout-start')");
  const startEnd = appSource.indexOf("else if (action === 'checkout-status')");
  assert.ok(startAt > 0 && startEnd > startAt, 'checkout-start block mila');
  const startBlock = appSource.slice(startAt, startEnd);
  assert.match(startBlock, /\/\/ User ne is checkout[\s\S]*?if \(epoch !== checkoutEpoch\) return;/);
  assert.match(startBlock, /api\('bootstrap', 'GET', undefined, \{ timeoutMs: 8000 \}\)/);
});
