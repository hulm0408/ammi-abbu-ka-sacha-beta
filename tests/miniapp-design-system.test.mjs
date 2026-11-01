// UI regression tests use fake Telegram/provider responses only. They never
// verify or perform a live Swiggy order, payment, SMS, or Telegram device flow.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../swiggy-pro.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../swiggy-pro.css', import.meta.url), 'utf8');
const account = { key: 'a', name: 'Ammi', phoneMasked: '90••••0001', active: true, selectable: true, status: 'USED' };
const address = { id: 'home', ref: 'home', name: 'Receiver', mobile: '9123456789', address: 'Test Road, Pune' };
const cart = { restaurantId: 'r', restaurantName: 'A long restaurant name', restaurantArea: 'Pune', items: [{ id: 'i', lineKey: 'line', name: 'Meal', qty: 2, price: 100 }], quote: { itemTotal: 200, deliveryFee: 10, taxes: 5, total: 215, fetchedAt: '2026-11-01T00:00:00Z' } };
const baseState = () => ({ ok: true, user: { name: 'Demo', isBoss: false }, accounts: [account, { key: 'b', name: 'Abbu', active: false, selectable: true, status: 'READY' }], activeAccount: account, selectedAddress: address, cart: structuredClone(cart), checkout: null, checkoutEnabled: true });
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
async function waitFor(fn, label = 'condition') {
  for (let i = 0; i < 300; i++) {
    const result = fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function harness({ bootstrap = baseState(), responder } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, 'innerHeight', { value: 844, writable: true, configurable: true });
  const viewport = new window.EventTarget();
  viewport.height = 844; viewport.offsetTop = 0;
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  window.Telegram = { WebApp: { initData: 'offline-signed-demo', ready() {}, expand() {} } };
  window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.endsWith('/bootstrap')) return response(bootstrap);
    const handled = responder && await responder(call);
    if (handled) return handled;
    if (call.url.includes('/coupons')) return response({ ok: true, coupons: [{ code: 'DEMO', title: '10% OFF', description: 'Offline example' }] });
    if (call.url.includes('/menu?')) return response({ ok: true, restaurant: { id: 'r', name: 'Restaurant', area: 'Pune', isOpen: true }, categories: [] });
    if (call.url.endsWith('/addresses')) return response({ ok: true, addresses: [address] });
    if (call.url.includes('/orders')) return response({ ok: true, orders: [] });
    return response({ ok: false, error: 'Unexpected offline request' }, 500);
  };
  window.eval(script);
  return { window, document: window.document, viewport, calls, close: () => window.close() };
}
const nav = (app, tab) => app.document.querySelector(`#bottom-nav [data-tab="${tab}"]`).click();
const key = (app, name, shiftKey = false) => app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));

test('shared shell shows the selected real account and accessible theme state', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    assert.equal(app.document.querySelector('#account-chip-text').textContent, 'Ammi');
    assert.match(app.document.querySelector('#account-chip').getAttribute('aria-label'), /Ammi.*0001/);
    assert.match(app.document.querySelector('#content h1').textContent, /Accounts/);
    assert.ok(app.document.querySelector('.ac-saved-head').compareDocumentPosition(app.document.querySelector('.ac-card')) & app.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(app.document.querySelector('form[data-form="send-otp"]'));
    app.document.querySelector('[data-action="account-mode"][data-mode="json"]').click();
    assert.ok(app.document.querySelector('form[data-form="import"]'));
    const theme = app.document.querySelector('[data-action="theme"]');
    assert.equal(theme.getAttribute('aria-pressed'), 'false');
    theme.click();
    assert.equal(theme.getAttribute('aria-pressed'), 'true');
    assert.equal(theme.getAttribute('aria-label'), 'Switch to light theme');
    assert.equal(app.window.localStorage.getItem('pro-theme'), 'dark');
    theme.click();
    assert.equal(theme.getAttribute('aria-pressed'), 'false');
  } finally { app.close(); }
});

test('the one cart dock uses the current item count and bill, and updates after quantity response', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/cart/quantity')) {
      const changed = structuredClone(cart); changed.items[0].qty = call.body.qty; changed.quote.total = 315;
      return response({ ok: true, cart: changed });
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.cart-dock'), 'dock');
    assert.equal(app.document.querySelectorAll('#cart-dock .cart-dock').length, 1);
    assert.match(app.document.querySelector('.cart-dock').getAttribute('aria-label'), /2 items.*A long restaurant name.*₹215/);
    nav(app, 'cart');
    await waitFor(() => app.document.querySelector('[data-action="qty"][data-qty="3"]'), 'quantity button');
    assert.equal(app.document.querySelector('#cart-dock .cart-dock'), null);
    app.document.querySelector('[data-action="qty"][data-qty="3"]').click();
    await waitFor(() => app.document.querySelector('.stepper span')?.textContent === '3', 'new quantity');
    nav(app, 'search');
    const dock = await waitFor(() => app.document.querySelector('.cart-dock'), 'updated dock');
    assert.match(dock.textContent, /3 items/);
    assert.match(dock.textContent, /₹315/);
    assert.match(app.document.querySelector('#bottom-nav [data-tab="cart"]').getAttribute('aria-label'), /3 items/);
    assert.equal(app.calls.filter(c => c.url.endsWith('/cart/quantity')).length, 1);
    assert.equal(app.calls.some(c => c.url.endsWith('/checkout')), false);
  } finally { app.close(); }
});

test('cart dock stays hidden during pending or uncertain checkout and for an empty cart', async () => {
  for (const checkout of [{ status: 'PAYMENT_PENDING', amount: 215, paymentVerified: false }, { status: 'OUTCOME_UNKNOWN' }]) {
    const state = baseState(); state.checkout = checkout;
    const app = harness({ bootstrap: state });
    try {
      await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts with checkout');
      assert.equal(app.document.querySelector('#cart-dock .cart-dock'), null);
      nav(app, 'address');
      await waitFor(() => app.document.querySelector('.address-row'), 'address');
      assert.equal(app.document.querySelector('#cart-dock .cart-dock'), null);
    } finally { app.close(); }
  }
  const state = baseState(); state.cart = null;
  const empty = harness({ bootstrap: state });
  try {
    await waitFor(() => empty.document.querySelector('.ac-row.active'), 'empty cart');
    assert.equal(empty.document.querySelector('#cart-dock .cart-dock'), null);
  } finally { empty.close(); }
});

test('coupon sheet retains the cart beneath it, traps focus, and restores a usable trigger on Escape', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'cart');
    await waitFor(() => app.document.querySelector('[data-action="coupon-open"]'), 'coupons');
    app.document.querySelector('[data-action="coupon-open"]').click();
    const sheet = await waitFor(() => app.document.querySelector('.coupon-sheet'), 'coupon dialog');
    assert.ok(app.document.querySelector('.coupon-underlay[inert] .restaurant-cart'));
    assert.ok(app.document.querySelector('#bottom-nav[inert][aria-hidden="true"]'));
    assert.equal(app.document.activeElement.dataset.action, 'coupon-back');
    const buttons = [...sheet.querySelectorAll('button:not([disabled])')];
    buttons.at(-1).focus(); key(app, 'Tab');
    assert.equal(app.document.activeElement, buttons[0]);
    key(app, 'Tab', true);
    assert.equal(app.document.activeElement, buttons.at(-1));
    key(app, 'Escape');
    assert.equal(app.document.querySelector('.coupon-sheet'), null);
    assert.equal(app.document.querySelector('#bottom-nav').hasAttribute('inert'), false);
    assert.ok(['coupon-open', 'toggle-coupon'].includes(app.document.activeElement.dataset.action));
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/sync') || c.url.endsWith('/checkout')), false);
  } finally { app.close(); }
});

test('cancelled confirmations trap focus, restore a repainted trigger, and leave the cart unchanged', async () => {
  let releaseCoupons;
  const pendingCoupons = new Promise(resolve => { releaseCoupons = resolve; });
  const app = harness({ responder: call => call.url.includes('/coupons') ? pendingCoupons : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'cart');
    const trigger = await waitFor(() => app.document.querySelector('[data-action="cart-clear"]'), 'clear cart');
    trigger.focus(); trigger.click();
    const dialog = await waitFor(() => app.document.querySelector('.confirm-dialog'), 'confirmation');
    assert.ok(app.document.querySelector('.app-shell[inert][aria-hidden="true"]'));
    const buttons = [...dialog.querySelectorAll('button')];
    assert.equal(app.document.activeElement, buttons[0]);
    releaseCoupons(response({ ok: true, coupons: [{ code: 'DEMO', title: '10% OFF' }] }));
    await waitFor(() => app.document.querySelector('[data-action="coupon-open"]'), 'background coupon repaint');
    assert.notEqual(app.document.querySelector('[data-action="cart-clear"]'), trigger);
    assert.equal(app.document.activeElement, buttons[0]);
    key(app, 'Tab', true);
    assert.equal(app.document.activeElement, buttons.at(-1));
    key(app, 'Escape');
    await waitFor(() => app.document.activeElement === app.document.querySelector('[data-action="cart-clear"]'), 'confirmation focus restored');
    assert.equal(app.document.querySelector('.confirm-dialog'), null);
    assert.equal(app.document.querySelector('.app-shell').hasAttribute('inert'), false);
    assert.ok(app.document.querySelector('.restaurant-cart'));
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/clear')), false);
  } finally { app.close(); }
});

test('typing and keyboard focus survive an async repaint without copying an address link into the group cart', async () => {
  let releaseAddresses;
  const pending = new Promise(resolve => { releaseAddresses = resolve; });
  const app = harness({ responder: call => call.url.endsWith('/addresses') ? pending : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'address');
    const input = await waitFor(() => app.document.querySelector('form[data-form="address-link"] input[name="url"]'), 'address link');
    input.focus(); input.value = 'https://swiggy.onelink.me/example';
    input.setSelectionRange(10, 10);
    releaseAddresses(response({ ok: true, addresses: [address] }));
    const restored = await waitFor(() => {
      const el = app.document.querySelector('form[data-form="address-link"] input[name="url"]');
      return el !== input && app.document.querySelectorAll('.address-row').length > 1 && el;
    }, 'async address repaint');
    assert.equal(restored.value, 'https://swiggy.onelink.me/example');
    assert.equal(app.document.activeElement, restored);
    assert.equal(restored.selectionStart, 10);
    nav(app, 'cart');
    const group = await waitFor(() => app.document.querySelector('form[data-form="group-cart"] input[name="url"]'), 'group cart');
    assert.equal(group.value, '');
  } finally { app.close(); }
});

test('both edited receiver fields survive a background repaint and submit unchanged', async () => {
  let releaseAddresses;
  const pending = new Promise(resolve => { releaseAddresses = resolve; });
  const app = harness({ responder: call => {
    if (call.url.endsWith('/addresses')) return pending;
    if (call.url.endsWith('/addresses/update-contact')) return response({ ok: true, selectedAddress: { ...address, name: call.body.name, mobile: call.body.mobile } });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'address');
    (await waitFor(() => app.document.querySelector('[data-action="contact-edit"]'), 'selected address')).click();
    const form = app.document.querySelector('form[data-form="contact"]');
    form.querySelector('[name="name"]').value = 'Updated Receiver';
    const mobile = form.querySelector('[name="mobile"]');
    mobile.value = '9876543210'; mobile.focus();
    releaseAddresses(response({ ok: true, addresses: [address] }));
    const updated = await waitFor(() => {
      const current = app.document.querySelector('form[data-form="contact"]');
      return current !== form && app.document.querySelectorAll('.address-row').length > 1 && current;
    }, 'background address repaint');
    assert.equal(updated.querySelector('[name="name"]').value, 'Updated Receiver');
    assert.equal(updated.querySelector('[name="mobile"]').value, '9876543210');
    assert.equal(app.document.activeElement, updated.querySelector('[name="mobile"]'));
    updated.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    const call = await waitFor(() => app.calls.find(c => c.url.endsWith('/addresses/update-contact')), 'contact update');
    assert.deepEqual(call.body, { name: 'Updated Receiver', mobile: '9876543210' });
  } finally { app.close(); }
});

test('a newly resolved address replaces old recipient edits with its own link details', async () => {
  const first = { ...address, address: 'First Road', name: 'First Recipient', mobile: '9111111111' };
  const second = { ...address, address: 'Second Road', name: 'Second Recipient', mobile: '9222222222' };
  let releaseSecond, resolutions = 0;
  const pending = new Promise(resolve => { releaseSecond = resolve; });
  const app = harness({ responder: call => {
    if (call.url.endsWith('/addresses/resolve')) return ++resolutions === 1 ? response({ ok: true, address: first }) : pending;
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'address');
    const submitLink = () => {
      const form = app.document.querySelector('form[data-form="address-link"]');
      form.querySelector('[name="url"]').value = 'https://swiggy.onelink.me/example';
      form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    };
    submitLink();
    const firstForm = await waitFor(() => app.document.querySelector('form[data-form="confirm-address"]'), 'first address');
    firstForm.querySelector('[name="name"]').value = 'Unsaved Old Name';
    firstForm.querySelector('[name="mobile"]').value = '9333333333';
    firstForm.querySelector('[name="name"]').focus();
    submitLink();
    await waitFor(() => resolutions === 2, 'second address request');
    releaseSecond(response({ ok: true, address: second }));
    const next = await waitFor(() => {
      const form = app.document.querySelector('form[data-form="confirm-address"]');
      return form !== firstForm && form?.closest('.card')?.textContent.includes('Second Road') && form;
    }, 'second address');
    assert.equal(next.querySelector('[name="name"]').value, 'Second Recipient');
    assert.equal(next.querySelector('[name="mobile"]').value, '9222222222');
  } finally { app.close(); }
});

test('keyboard-resized viewport hides and restores fixed controls', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    const input = app.document.querySelector('.ac-search input'); input.focus();
    app.viewport.height = 500;
    app.viewport.dispatchEvent(new app.window.Event('resize'));
    assert.equal(app.document.body.classList.contains('keyboard-open'), true);
    app.viewport.height = 844;
    app.viewport.dispatchEvent(new app.window.Event('resize'));
    assert.equal(app.document.body.classList.contains('keyboard-open'), false);
  } finally { app.close(); }
});

test('outlet sheet supports keyboard dismissal and returns focus without requesting a menu', async () => {
  const restaurants = [{ id: '1', name: 'Curry', area: 'One', isOpen: true }, { id: '2', name: 'Curry', area: 'Two', isOpen: true }];
  const app = harness({ responder: call => call.url.includes('/search?') ? response({ ok: true, restaurants }) : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'search');
    const form = app.document.querySelector('form[data-form="search"]');
    form.querySelector('input').value = 'Curry';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    const row = await waitFor(() => app.document.querySelector('[data-action="restaurant"]'), 'search results');
    row.focus(); row.click();
    await waitFor(() => app.document.querySelector('.sheet-overlay'), 'outlet sheet');
    assert.ok(app.document.activeElement.hasAttribute('data-sheet-close'));
    assert.ok(app.document.querySelector('.app-shell[inert][aria-hidden="true"]'));
    key(app, 'Escape');
    assert.equal(app.document.querySelector('.sheet-overlay'), null);
    assert.equal(app.document.querySelector('.app-shell').hasAttribute('inert'), false);
    assert.equal(app.document.activeElement, row);
    assert.equal(app.calls.some(c => c.url.includes('/menu?')), false);
  } finally { app.close(); }
});

test('chat handoff shows the server stage and still pre-fills the receiver from the link', async () => {
  const state = baseState();
  state.chatHandoff = { activeId: 'draft', stage: 'ADDRESS', address: { ...address } };
  const app = harness({ bootstrap: state });
  try {
    const form = await waitFor(() => app.document.querySelector('form[data-form="handoff-address"]'), 'handoff address');
    assert.equal(form.querySelector('[name="receiver_name"]').value, 'Receiver');
    assert.equal(form.querySelector('[name="receiver_mobile"]').value, '9123456789');
    assert.equal(app.document.querySelector('.handoff-step[aria-current="step"]').textContent.replace(/\s+/g, ' ').trim(), '2Address');
    assert.equal(app.document.querySelector('#bottom-nav [aria-current="page"]'), null);
    nav(app, 'search');
    const resume = await waitFor(() => app.document.querySelector('[data-action="handoff-resume"]'), 'resume handoff');
    assert.match(resume.textContent, /2 items/);
    assert.match(resume.textContent, /₹215/);
    resume.click();
    assert.ok(app.document.querySelector('form[data-form="handoff-address"]'));
  } finally { app.close(); }
});

test('design tokens include safe areas and reduced-motion support without a global motion kill switch', () => {
  assert.match(css, /--tg-content-safe-area-inset-top/);
  assert.match(css, /--tg-safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /\*\s*,\s*\*::before\s*,\s*\*::after\s*\{\s*animation:\s*none\s*!important;\s*transition:\s*none\s*!important/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
});
