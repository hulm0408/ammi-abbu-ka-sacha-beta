// DOM tests use fake Telegram/provider responses. They do NOT verify a real
// Telegram device, Swiggy login, order, payment, tracking, or recipient SMS.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

const account = { key: 'a', name: 'Test account', phone: '9123456789', active: true, ordersCount: 0 };
const address = { name: 'Demo receiver', mobile: '9234567890', address: 'Demo road ' + 'Long building name '.repeat(22) };
const quote = { total: 150.25, fetchedAt: '2026-10-31T00:00:00Z', itemTotal: 125, deliveryFee: 20, packingCharges: 0, taxes: 5.25, discount: 0 };
const cart = { restaurantId: '123', restaurantName: 'Demo restaurant', forSomeoneElse: true, quote, items: [{ lineKey: 'line', name: 'Meal', price: 125, qty: 1 }] };
const normalState = () => ({ ok: true, user: { name: 'Test', isBoss: false }, accounts: [account], activeAccount: account, selectedAddress: address, cart: structuredClone(cart), checkout: null, checkoutEnabled: true });

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
async function waitFor(fn, message = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
}
function harness({ initData = 'signed-offline-data', responder } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  const external = [];
  window.scrollTo = () => {};
  window.confirm = () => { throw new Error('Browser confirm must not be used inside Telegram'); };
  window.open = url => { external.push(url); };
  window.Telegram = { WebApp: { initData, ready() {}, expand() {}, openLink: url => external.push(url) } };
  window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    calls.push(call);
    return responder ? responder(call) : response(normalState());
  };
  window.eval(script);
  return { window, document: window.document, calls, external, close: () => window.close() };
}

test('preview and missing vault do not show a fake empty account list; retry connects after setup', async () => {
  const preview = harness({ initData: '' });
  try {
    assert.match(preview.document.body.textContent, /Open in Telegram/);
    assert.equal(preview.calls.length, 0);
    assert.equal(preview.document.querySelector('form[data-form="send-otp"]'), null);
  } finally { preview.close(); }

  let ready = false;
  const app = harness({ responder: call => call.url.endsWith('/bootstrap')
    ? ready ? response(normalState()) : response({ ok: false, code: 'PRO_VAULT_NOT_CONFIGURED', error: 'Mini App vault is not configured.' }, 503)
    : response({ ok: false, error: 'unexpected' }, 500) });
  try {
    await waitFor(() => app.document.querySelector('[data-action="retry-auth"]'), 'vault setup screen');
    assert.match(app.document.body.textContent, /server storage needs setup.*phone number is not the problem/i);
    assert.equal(app.document.querySelector('form[data-form="send-otp"]'), null);
    assert.equal(app.calls.filter(c => c.url.includes('send-otp')).length, 0);
    ready = true;
    app.document.querySelector('[data-action="retry-auth"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'account form after reconnect');
    assert.equal(app.calls.filter(c => c.url.endsWith('/bootstrap')).length, 2);
  } finally { app.close(); }
});

test('OTP request and verification stay inside the app and only reflect provider responses', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(normalState());
    if (call.url.endsWith('/accounts/send-otp')) return response({ ok: true, message: 'Swiggy accepted the OTP request.' });
    if (call.url.endsWith('/accounts/verify-otp')) return response(normalState());
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'OTP form');
    app.document.querySelector('input[name="phone"]').value = '9234567890';
    app.document.querySelector('form[data-form="send-otp"]').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('form[data-form="verify-otp"]'), 'verification form');
    assert.equal(app.calls.find(c => c.url.endsWith('/accounts/send-otp')).body.phone, '9234567890');
    app.document.querySelector('input[name="otp"]').value = '123456';
    app.document.querySelector('form[data-form="verify-otp"]').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]') && app.document.querySelector('#toast').textContent.includes('Account added.'), 'verification response');
    assert(app.calls.some(c => c.url.endsWith('/accounts/verify-otp')));
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

test('cart sync requires in-app confirmation and Escape safely cancels it', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(normalState());
    if (call.url.endsWith('/cart/sync')) return response({ ok: true, cart: structuredClone(cart), selectedAddress: address });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'connected navigation');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="sync"]'), 'sync form');
    const submit = () => app.document.querySelector('form[data-form="sync"]').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    submit();
    await waitFor(() => app.document.querySelector('[role="dialog"]'), 'sync dialog');
    assert.match(app.document.querySelector('[role="dialog"]').textContent, /replaces the current cart/i);
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !app.document.querySelector('[role="dialog"]'), 'cancelled dialog');
    assert.equal(app.calls.filter(c => c.url.endsWith('/cart/sync')).length, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    submit();
    await waitFor(() => app.document.querySelector('[role="dialog"]'), 'second sync dialog');
    app.document.querySelectorAll('.confirm-actions button')[1].click();
    await waitFor(() => app.document.querySelector('#toast').textContent.includes('Bill returned'), 'sync result');
    const syncCalls = app.calls.filter(c => c.url.endsWith('/cart/sync'));
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].body.confirmReplaceSwiggyCart, true);
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

test('checkout uses an in-app consent dialog, preserves full details, and only submits after approval', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) {
      const state = normalState();
      state.accounts.push({ key: 'other', name: 'Other', phone: '9234567890', active: false });
      return response(state);
    }
    if (call.url.endsWith('/checkout')) return response({ ok: true, checkout: { status: 'OUTCOME_UNKNOWN', accountPhone: account.phone, message: 'An order may exist; do not retry.' } });
    if (call.url.endsWith('/addresses')) return response({ ok: true, addresses: [], note: 'No saved addresses (offline).' });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'connected navigation');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="checkout-start"]'), 'checkout button');
    app.document.querySelector('[data-action="checkout-start"]').click();
    await waitFor(() => app.document.querySelector('[role="dialog"]'), 'consent dialog');
    let dialog = app.document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /₹150\.25/);
    assert(dialog.textContent.includes(address.address), 'full address must not be truncated');
    assert.match(dialog.textContent, /do not place another order/i);
    assert.equal(app.calls.filter(c => c.url.endsWith('/checkout')).length, 0);
    assert.equal(app.document.activeElement.textContent, 'Cancel');
    dialog.querySelector('.confirm-actions button').click();
    await waitFor(() => !app.document.querySelector('[role="dialog"]'), 'dialog close');
    assert.equal(app.calls.filter(c => c.url.endsWith('/checkout')).length, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    app.document.querySelector('[data-action="checkout-start"]').click();
    await waitFor(() => app.document.querySelector('[role="dialog"]'), 'second consent dialog');
    dialog = app.document.querySelector('[role="dialog"]');
    const confirm = dialog.querySelectorAll('.confirm-actions button')[1];
    confirm.click(); confirm.click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/checkout')), 'one checkout request');
    const checkoutCalls = app.calls.filter(c => c.url.endsWith('/checkout'));
    assert.equal(checkoutCalls.length, 1);
    assert.equal(checkoutCalls[0].body.confirmCheckout, true);
    assert.equal(checkoutCalls[0].body.expectedTotal, 150.25);
    await waitFor(() => app.document.body.textContent.includes('Draft cart changes are locked'), 'locked draft');
    assert(app.document.querySelector('[data-action="qty"]').disabled);
    app.document.querySelector('[data-tab="address"]').click();
    await waitFor(() => app.document.body.textContent.includes('No saved addresses (offline).'), 'address response');
    assert.match(app.document.body.textContent, /Receiver changes are locked/);
    assert(app.document.querySelector('[data-action="contact-edit"]').disabled);
    assert(app.document.querySelector('form[data-form="address-link"] button').disabled);
    app.document.querySelector('[data-tab="accounts"]').click();
    assert.match(app.document.body.textContent, /Account switching is locked/);
    assert(app.document.querySelector('[data-action="account-select"]').disabled);
    assert(app.document.querySelector('[data-action="account-remove"]').disabled);
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

test('uncertain checkout offers in-app original-account history without clearing the duplicate-order warning', async () => {
  const state = normalState();
  state.activeAccount = { ...account, key: 'b', name: 'Other selected account' };
  state.checkout = { status: 'OUTCOME_UNKNOWN', accountPhone: account.phone, message: 'An order may exist; do not retry.' };
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(state);
    if (call.url.includes('/orders?scope=checkout')) return response({ ok: true, orders: [{ id: '123456789012', restaurant: 'Demo', status: 'Pending', items: [], amount: 150.25 }] });
    if (call.url.includes('/orders/tracking?')) return response({ ok: true, tracking: { orderId: '123456789012', status: 'Pending' } });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'connected navigation');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="checkout-orders"]'), 'original-account history button');
    app.document.querySelector('[data-action="checkout-orders"]').click();
    await waitFor(() => app.document.querySelector('[data-action="order-detail"]'), 'original-account orders');
    assert.match(app.document.body.textContent, /empty or delayed list does not prove failure/i);
    assert(app.calls.some(c => c.url.endsWith('/orders?scope=checkout')));
    app.document.querySelector('[data-action="order-detail"]').click();
    app.document.querySelector('[data-action="order-tracking"]').click();
    await waitFor(() => !app.document.body.textContent.includes('Swiggy has not returned tracking details yet.'), 'tracking response');
    assert(app.calls.some(c => c.url.includes('/orders/tracking?') && c.url.includes('scope=checkout')));
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

test('compact navigation keeps all six actions, cart dock and labelled link forms', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(normalState());
    if (call.url.endsWith('/addresses')) return response({ ok: true, addresses: [], note: 'No saved addresses returned.' });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('#bottom-nav button:not([disabled])'));
    const tabs = [...app.document.querySelectorAll('#bottom-nav button')];
    assert.deepEqual(tabs.map(button => button.textContent.trim()), ['Accounts', 'Address', 'Search', 'Cart', 'Orders', 'Offers']);
    assert.equal(app.document.body.classList.contains('has-cart-dock'), true);
    app.document.querySelector('[data-tab="address"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="address-link"]'));
    const input = app.document.querySelector('form[data-form="address-link"] input');
    assert.equal(app.document.querySelector(`label[for="${input.id}"]`).textContent, 'Address link');
    assert.equal(input.type, 'url');
    await waitFor(() => app.document.body.textContent.includes('No saved addresses returned.'));
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="group-cart"]'));
    assert.equal(app.document.body.classList.contains('has-cart-dock'), false);
    assert.equal(app.document.querySelector('form[data-form="group-cart"] label').textContent, 'Cart link');
    assert.match(app.document.body.textContent, /Sync replaces the account’s Swiggy cart/i);
    assert.match(app.document.body.textContent, /OFO acceptance is unconfirmed/i);
  } finally { app.close(); }
});

test('a reported payment hides the QR even if stale QR data is returned', async () => {
  const state = normalState();
  state.checkout = {
    status: 'PAYMENT_PENDING', paymentVerified: true, amount: 150.25,
    qrDataUrl: 'data:image/png;base64,ZmFrZQ==', upiIntentUrl: 'upi://pay?pa=example%40upi&am=150.25',
    message: 'The order still needs confirmation.'
  };
  const app = harness({ responder: call => call.url.endsWith('/bootstrap') ? response(state) : response({ ok: false }, 500) });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'));
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="checkout-status"]'));
    assert.match(app.document.body.textContent, /do not pay again/i);
    assert.equal(app.document.querySelector('.payment-qr'), null);
    assert.equal(app.document.querySelector('a[href^="upi:"]'), null);
    assert.equal(app.document.querySelector('form[data-form="group-cart"] input').disabled, true);
    assert.equal(app.document.querySelector('[data-action="checkout-start"]'), null);
  } finally { app.close(); }
});
