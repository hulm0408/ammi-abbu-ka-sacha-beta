// Offline DOM regression: cart khulte hi bill (cart/sync) chalta hai. Us dauran
// "Complete your meal" (menu) aur coupon list ke requests nahi jaane chahiye —
// wo server ke per-user lock me bill ke peeche queue hote the aur bill dhima hota tha.
// Bill aane ke baad hi ye load hote hain.
// Fake Telegram/provider only. No Swiggy, UPI or real order is contacted.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const appSource = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');

const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const items = [{ lineKey: 'l', name: 'Paneer', price: 230, qty: 1, isVeg: true }];
const quote = { total: 352, itemTotal: 342, deliveryFee: 28, taxes: 32, discount: 50, coupon: 'TRYNEW', freeCash: 50, fetchedAt: new Date().toISOString() };
const baseState = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: address,
  checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
  cart: { restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false, items, quote: null },
  checkout: null,
  wallet: { balancePaise: 1500, balance: '15', feePaise: 1500, fee: '15', ready: true, shortfall: '0', upiId: 'mius@ybl', presets: [] },
  idle: { timeoutMs: 120000, closed: null, abandoned: [] },
  ...over
});

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

async function mount(routes) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  const calls = [];
  window.fetch = (url, opts = {}) => {
    const p = String(url).replace('/pro/api/', '');
    calls.push(p);
    const handler = routes[p] || routes['*'];
    return Promise.resolve(handler ? handler(opts) : { status: 500, body: { ok: false, error: 'unexpected ' + p } })
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

test('bill chalte waqt meal rail aur coupon list ke requests nahi jaate; bill ke baad jaate hain', async () => {
  const sync = deferred();
  const { window, waitFor, calls } = await mount({
    'bootstrap': () => ({ status: 200, body: baseState() }),
    'cart/sync': () => sync.promise,
    'menu?id=201': () => ({ status: 200, body: { ok: true, restaurant: { id: '201', name: 'Paneer Palace' }, categories: [], items: [] } }),
    'coupons?id=201': () => ({ status: 200, body: { ok: true, coupons: [], note: '' } })
  });
  try {
    // Auto bill ka confirm aata hai — haan dabao.
    const confirmOk = await waitFor(() => window.document.querySelector('.confirm-dialog .button.primary'), 'bill confirm');
    confirmOk.click();
    await waitFor(() => calls.includes('cart/sync'), 'cart/sync shuru');
    // Bill abhi chal raha hai — meal aur coupon ka koi request nahi.
    await new Promise(r => setTimeout(r, 300));
    assert.equal(calls.includes('menu?id=201'), false, 'bill ke dauran menu nahi jana chahiye');
    assert.equal(calls.includes('coupons?id=201'), false, 'bill ke dauran coupons nahi jane chahiye');
    // Bill aa gaya.
    sync.resolve({ status: 200, body: { ok: true, cart: { ...baseState().cart, quote }, selectedAddress: address } });
    await waitFor(() => calls.includes('menu?id=201') && calls.includes('coupons?id=201'), 'bill ke baad meal + coupons');
  } finally { window.close(); }
});

test('bill confirm na ho (dismiss) to meal rail ruka nahi rehta', async () => {
  const { window, waitFor, calls } = await mount({
    'bootstrap': () => ({ status: 200, body: baseState() }),
    'menu?id=201': () => ({ status: 200, body: { ok: true, restaurant: { id: '201', name: 'Paneer Palace' }, categories: [], items: [] } }),
    'coupons?id=201': () => ({ status: 200, body: { ok: true, coupons: [], note: '' } })
  });
  try {
    const cancelBtn = await waitFor(() => window.document.querySelector('.confirm-dialog .button:not(.primary)'), 'confirm dismiss');
    cancelBtn.click();
    await waitFor(() => calls.includes('menu?id=201'), 'dismiss ke baad meal load');
    assert.equal(calls.includes('cart/sync'), false, 'bina confirm ke sync nahi');
  } finally { window.close(); }
});

test('bill fail ho to bhi meal rail ruka nahi rehta (error ke baad cart dobara banta hai)', async () => {
  const sync = deferred();
  const { window, waitFor, calls } = await mount({
    'bootstrap': () => ({ status: 200, body: baseState() }),
    'cart/sync': () => sync.promise,
    'menu?id=201': () => ({ status: 200, body: { ok: true, restaurant: { id: '201', name: 'Paneer Palace' }, categories: [], items: [] } }),
    'coupons?id=201': () => ({ status: 200, body: { ok: true, coupons: [], note: '' } })
  });
  try {
    const confirmOk = await waitFor(() => window.document.querySelector('.confirm-dialog .button.primary'), 'bill confirm');
    confirmOk.click();
    await waitFor(() => calls.includes('cart/sync'), 'cart/sync shuru');
    sync.resolve({ status: 500, body: { ok: false, error: 'Swiggy ne bill nahi diya' } });
    await waitFor(() => calls.includes('menu?id=201'), 'bill fail ke baad meal load');
  } finally { window.close(); }
});
