// Offline presentation checks: synthetic data only. They do not verify real
// Telegram, Swiggy, payment, SMS or ordering. Chromium checks skip if absent.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { findChromePath } from './swiggy-bridge.js';
import { generatePersonalizedQrCard, generateUltraPremiumCard } from './swiggy-cart.js';
import { accountDetailText, compactAccountLine, fourOfferScoreLine, fourOfferStatusBlock, liveOrderTruth, offerClaimTruth } from './account-views.js';

const chrome = findChromePath();
const chromeOptions = { executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] };
const uri = 'upi://pay?pa=offline%40test&pn=OfflineTest&am=150.25&cu=INR&tr=offline-test';
function decode(buffer) {
  const image = PNG.sync.read(buffer);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data;
}

test('compact account views do not invent order counts or offer savings', () => {
  for (const missing of [undefined, null, '', '  ', -1, 999999, false]) {
    const acc = { ordersVerifiedLive: true, totalOrdersCount: missing, liveActiveOrdersCount: missing };
    assert.equal(liveOrderTruth(acc).totalOrders, null);
    assert.equal(liveOrderTruth(acc).activeOrders, null);
    assert.match(compactAccountLine(acc, 'demo'), /ord \?/);
    assert.doesNotMatch(compactAccountLine(acc, 'demo'), /null ord|0 ord/);
  }
  assert.equal(liveOrderTruth({ ordersVerifiedLive: false, totalOrdersCount: 0 }).totalOrders, null);
  assert.equal(liveOrderTruth({ ordersVerifiedLive: true, totalOrdersCount: 0, liveActiveOrdersCount: 0 }).totalOrders, 0);
  assert.equal(liveOrderTruth({ ordersVerifiedLive: true, totalOrdersCount: 0, liveActiveOrdersCount: 0 }).activeOrders, 0);
  const acc = { offers: {
    breakfast: { status: 'CLAIMED' },
    lateNight: { status: 'CLAIMED', state: 'WRONG_REWARD', claimed: true },
    extra50: { status: 'PRE_LOCKED' }
  } };
  const truth = offerClaimTruth(acc);
  assert.equal(truth.claimedCount, 1);
  assert.equal(truth.lateNight.status, 'WRONG_REWARD');
  assert.doesNotMatch(truth.breakfast.label, /₹50/);
  assert.match(fourOfferStatusBlock(acc), /WRONG REWARD.*₹50 free cash nahi mila/);
  assert.match(fourOfferScoreLine(acc), /1\/5 claimed.*1 pre-locked/);
  assert.doesNotMatch(fourOfferScoreLine(acc), /pakka|possible|₹/);
  const detail = accountDetailText({ key: '<unsafe>', acc: { ...acc, phone: '<unsafe>', orderLock: { orderId: 'offline' } } }).text;
  assert.match(detail, /&lt;unsafe&gt;/);
  assert.doesNotMatch(detail, /<unsafe>|max 6h/);
  assert.match(compactAccountLine({ phone: '<unsafe>' }, 'demo'), /&lt;unsafe&gt;/);
  assert.match(accountDetailText({ key: 'demo', acc: { isLoggedIn: true, token: 'stale', sessionExpired: true } }).text, /Session expired/);
});

test('payment cards fail closed without payment data', async () => {
  await assert.rejects(generatePersonalizedQrCard({}), /payment QR is unavailable/i);
  await assert.rejects(generateUltraPremiumCard({}), /payment QR is unavailable/i);
});

test('both simple payment cards retain the exact QR data without an overlay', { skip: !chrome && 'Chromium is not installed' }, async () => {
  const opts = { customerName: 'Demo <customer>', restaurantName: 'Demo & Restaurant', amount: 150.25, orderId: 'offline-123', address: 'Offline sample address', upiUrl: uri };
  assert.equal(decode(await generatePersonalizedQrCard(opts)), uri);
  assert.equal(decode(await generateUltraPremiumCard(opts)), uri);
  const png = await QRCode.toBuffer(uri, { type: 'png', width: 400, margin: 4 });
  assert.equal(decode(await generatePersonalizedQrCard({ ...opts, upiUrl: null, qrBuffer: png })), uri);
});

test('compact Mini App works at narrow mobile widths and in dark mode with offline mock data', { skip: !chrome && 'Chromium is not installed', timeout: 60_000 }, async () => {
  const account = { key: 'family', name: 'Family ID', phoneLabel: '•••• 6789', active: true, managed: true, sessionState: 'VERIFIED', orderState: 'ZERO_REPORTED', checkedAt: '2026-10-31T09:00:00Z', recordedOffers: [] };
  const address = { annotation: 'Home', name: 'Demo receiver', mobile: '9123456789', address: 'Flat 101, Example Building, Demo Road, Lucknow 226010' };
  const cart = { restaurantName: 'Example restaurant', restaurantId: '123', forSomeoneElse: true, items: [{ lineKey: 'l1', id: '1', name: 'Demo meal with a longer name', qty: 1, price: 125 }], quote: { itemTotal: 125, deliveryFee: 20, packingCharges: 0, taxes: 5.25, discount: 0, total: 150.25, fetchedAt: '2026-10-31T09:00:00Z' } };
  const bootstrap = { ok: true, user: { name: 'Offline', managedAccess: true, isBoss: false }, accounts: [account], activeAccount: account, selectedAddress: address, cart, checkout: null, checkoutEnabled: false };
  const restaurant = { id: 'r1', name: 'Example restaurant', area: 'Demo area', isOpen: true };
  const menu = { ok: true, restaurant, categories: [{ title: 'Meals', items: [
    { id: 'm1', name: 'Demo meal', price: 125, isVeg: true, inStock: true, customizable: false },
    { id: 'm2', name: 'Custom meal', price: 150, isVeg: false, inStock: true, customizable: true }
  ] }] };
  const order = { id: 'mock-123', restaurant: 'Example restaurant', placedAt: 'Offline', status: 'Pending', items: [{ name: 'Demo meal', qty: 1 }], amount: 150.25 };
  let checkoutCalls = 0;
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8')
    .replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', `<script>window.Telegram={WebApp:{initData:'OFFLINE-MOCK',ready(){},expand(){},openLink(){}}};</script>`)
    .replace('<body>', '<body><div style="padding:5px;background:#f9dfab;color:#3e2c10;text-align:center;font:12px sans-serif">OFFLINE TEST · MOCK DATA · CHECKOUT DISABLED</div>');
  const js = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url));
  const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url));
  assert.doesNotMatch(css.toString(), /@keyframes/i);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock.invalid');
    if (url.pathname === '/pro') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/pro/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(js); return; }
    if (url.pathname === '/pro/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(css); return; }
    let data;
    if (url.pathname === '/pro/api/bootstrap') data = bootstrap;
    else if (url.pathname === '/pro/api/addresses') data = { ok: true, addresses: [], note: 'No saved addresses returned.' };
    else if (url.pathname === '/pro/api/search') data = { ok: true, restaurants: [restaurant] };
    else if (url.pathname === '/pro/api/menu') data = menu;
    else if (url.pathname === '/pro/api/orders') data = { ok: true, orders: [order] };
    else {
      if (url.pathname === '/pro/api/checkout') checkoutCalls++;
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Offline preview: checkout is disabled.' })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch(chromeOptions);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // No real provider, external assets or payment network can be reached.
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(base + '/') || request.url().startsWith('data:') ? request.continue() : request.abort());
    for (const width of [320, 360, 390, 414, 768]) {
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
      await page.goto(base + '/pro', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#bottom-nav [data-tab="cart"]:not([disabled])');
      const tabs = await page.$$eval('#bottom-nav button', buttons => buttons.map(b => b.textContent.trim()));
      assert.deepEqual(tabs, ['Accounts', 'Address', 'Search', 'Cart', 'Orders', 'Offers']);
      assert.equal(await page.$('form[data-form="send-otp"]'), null, 'managed family must not see OTP');
      const checkLayout = async label => {
        const state = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          nav: document.querySelector('#bottom-nav').getBoundingClientRect().toJSON(),
          buttons: [...document.querySelectorAll('#bottom-nav button')].map(b => b.getBoundingClientRect().toJSON())
        }));
        assert.ok(state.scrollWidth <= state.viewport, `${label} overflows at ${width}px`);
        assert.ok(state.nav.left >= -1 && state.nav.right <= state.viewport + 1, `navigation clipped at ${width}px`);
        assert.ok(state.buttons.every(b => b.width > 0 && b.left >= -1 && b.right <= state.viewport + 1));
      };
      await checkLayout('accounts');
      await page.click('#bottom-nav [data-tab="address"]');
      await page.waitForSelector('form[data-form="address-link"]');
      assert.ok(await page.$('label[for="address-link-url"]'));
      await checkLayout('address');
      // Wait for address fetch to settle before using the next tab.
      await page.waitForNetworkIdle();
      await page.click('#bottom-nav [data-tab="search"]');
      await page.waitForSelector('form[data-form="search"]');
      await page.type('input[name="q"]', 'Demo');
      await page.click('form[data-form="search"] button');
      await page.waitForSelector('[data-action="restaurant"]');
      await page.click('[data-action="restaurant"]');
      await page.waitForSelector('.dish-row');
      const options = await page.$$eval('[data-action="dish-add"]', buttons => buttons.map(b => ({ text: b.textContent.trim(), disabled: b.disabled })));
      assert.equal(options[0].disabled, false);
      assert.equal(options[1].disabled, true, 'customisable items must not be silently added');
      await checkLayout('menu');
      await page.click('#bottom-nav [data-tab="cart"]');
      await page.waitForSelector('form[data-form="group-cart"]');
      assert.ok(await page.$('label[for="group-cart-url"]'));
      assert.equal(await page.$('[data-action="checkout-start"]'), null, 'mock checkout must be disabled');
      assert.match(await page.$eval('#content', el => el.textContent), /Checkout is disabled/i);
      await checkLayout('cart');
      await page.click('#bottom-nav [data-tab="orders"]');
      await page.waitForSelector('[data-action="order-detail"]');
      await checkLayout('orders');
      await page.click('#bottom-nav [data-tab="tools"]');
      await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === 'Offers');
      await checkLayout('offers');
      const initiallyDark = await page.evaluate(() => document.body.classList.contains('dark'));
      await page.click('[data-action="theme"]');
      assert.notEqual(await page.evaluate(() => document.body.classList.contains('dark')), initiallyDark);
      if (initiallyDark) await page.click('[data-action="theme"]');
      assert.ok(await page.$('body.dark'));
      await checkLayout('dark offers');
      if (width === 390 && process.env.SACHA_UI_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.SACHA_UI_SCREENSHOT_DIR}/sacha-offline-offers.png` });
        await page.click('#bottom-nav [data-tab="cart"]');
        await page.waitForSelector('form[data-form="group-cart"]');
        await page.screenshot({ path: `${process.env.SACHA_UI_SCREENSHOT_DIR}/sacha-offline-cart.png`, fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    assert.equal(checkoutCalls, 0);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
