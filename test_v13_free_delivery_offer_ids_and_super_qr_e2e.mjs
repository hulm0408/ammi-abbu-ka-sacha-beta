import './network-shield.js';
import assert from 'node:assert/strict';
import { discoverOpen24x7RestaurantOrder } from './test-live-open-cart-helper.mjs';
import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';
import fs from 'node:fs';
import {
  resolveSwiggyLink,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  generateRealSwiggyMerchantUpiQr,
  swiggyCartFlush,
  swiggyCartGet,
  dapiFetch,
  buildSwiggyAndroidClientHeaders,
  buildSwiggyCartItemsPayload,
  formatSwiggyWorldCartReceipt
} from './swiggy-cart.js';

let chromiumLaunches = 0;
const origLaunch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async (...args) => {
  chromiumLaunches++;
  return origLaunch(...args);
};

let passed = 0;
function check(label, cond, extra = '') {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${label}${extra ? ` -> ${extra}` : ''}`);
  }
  passed++;
  console.log(`  ✅ [${passed}] ${label}`);
}

console.log('🚀 Running V13 Live E2E: Native Android Headers + Item `offer_ids` + Zero-Chromium `+₹1` Swiggy One Free Delivery + Real `am=` QR Parity...\n');

const db = getDb();
const accNonSuper = db.config.accounts.acc_6296591407; // NOT_SUPER account!
const accSuper = db.config.accounts.acc_9935123518;    // SUPER account!

const GC_URL = 'https://swig.gy/gc/622166/Adithya-312184336';
const CUST_ADDR = 'Svr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India';

// 1. Unit / Protocol header + `offer_ids` guarantees
{
  const hdrs = buildSwiggyAndroidClientHeaders(accNonSuper, { lat: '17.3266', lng: '78.6046' });
  check('`buildSwiggyAndroidClientHeaders` NEVER sends discount-stripping `x-web-checkout-flow` header', !('x-web-checkout-flow' in hdrs));
  check('`buildSwiggyAndroidClientHeaders` uses pure `Swiggy-Android` UA + `version-code: 1800`', hdrs['User-Agent'] === 'Swiggy-Android' && Number(hdrs['version-code']) >= 1800);

  const built = buildSwiggyCartItemsPayload([{
    itemId: '139224136',
    qty: 1,
    offer_ids: ['392a7fd4-b4d0-4c4d-bd9c-3ff93b68621a'],
    item_offer_cart_meta: '{"tag":"CRAZY_DEALS"}'
  }]);
  check('`buildSwiggyCartItemsPayload` preserves `offer_ids` UUID array & `item_offer_cart_meta`', built[0].offer_ids[0] === '392a7fd4-b4d0-4c4d-bd9c-3ff93b68621a' && built[0].item_offer_cart_meta === '{"tag":"CRAZY_DEALS"}');
}

const createdAddrIdsByAcc = [];

try {
  // 2. Live Group Cart resolution preserves `offer_ids`
  const resolvedGc = await resolveSwiggyLink(GC_URL);
  check('Live `MOJO Pizza (622166)` Group Cart resolved cleanly', resolvedGc?.groupCartStatus === 'ACTIVE' && resolvedGc?.cartDetails?.items?.length > 0);
  const firstGcItem = resolvedGc.cartDetails.items[0];
  check('Live Group Cart item preserves `offer_ids` (`CRAZY_DEALS` / `NBH_OFFER` `-₹100` OFF)', Array.isArray(firstGcItem.offer_ids) && firstGcItem.offer_ids.length > 0);

  // 3. Test NON-SUPER account (`acc_6296591407`) -> MUST get BOTH Item Offer (`-₹100`) AND `+₹1` Swiggy One Lite FREE Delivery (`₹0` delivery!) + Exact Real UPI QR!
  const orderNonSuper = {
    id: 'E2E_V13_NONSUPER',
    cart: GC_URL,
    address: CUST_ADDR,
    selectedAccount: 'acc_6296591407'
  };
  const t0 = Date.now();
  const syncNonSuper = await syncGroupCartAndCheckoutForAccount(accNonSuper, orderNonSuper, { captureScreenshot: false });
  const nonSuperMs = Date.now() - t0;
  console.log('  📊 acc_6296591407 (NOT_SUPER) Live Sync Summary:', {
    ms: nonSuperMs,
    itemTotal: orderNonSuper.itemTotal,
    merchantTradeDiscount: orderNonSuper.merchantTradeDiscount,
    campaignFreeCash: orderNonSuper.campaignFreeCash,
    swiggyOneMembershipFee: orderNonSuper.swiggyOneMembershipFee,
    deliveryFee: orderNonSuper.deliveryFee,
    freeDeliveryDiscount: orderNonSuper.freeDeliveryDiscount,
    totalSavings: orderNonSuper.totalSavings,
    finalPayable: orderNonSuper.finalPayable
  });
  if (orderNonSuper.addressDetails?.id) createdAddrIdsByAcc.push([accNonSuper, orderNonSuper.addressDetails.id]);

  check('`acc_6296591407` sync succeeded in < 6.5s with 0 Chromium launches', syncNonSuper.success === true && nonSuperMs < 6500 && chromiumLaunches === 0, `ms=${nonSuperMs}, launches=${chromiumLaunches}`);
  check('`acc_6296591407` received `₹100+` real trade/item discount (`tradeDiscountTotal >= 100`, down from broken `₹0`)', Number(orderNonSuper.tradeDiscountTotal) >= 100, `got ${orderNonSuper.tradeDiscountTotal}`);
  check('`acc_6296591407` (`NOT_SUPER`) auto-activated `+₹1` Swiggy One Lite (`deliveryFee === 0`, `swiggyOneMembershipFee === 1`)', Number(orderNonSuper.deliveryFee) === 0 && Number(orderNonSuper.swiggyOneMembershipFee) === 1, `del=${orderNonSuper.deliveryFee}, oneFee=${orderNonSuper.swiggyOneMembershipFee}`);
  check('`acc_6296591407` Final Total slashed from `₹442` down below `₹300` (`₹212` with LN Free Cash / `₹292` base)', Number(orderNonSuper.finalPayable) <= 295, `got ${orderNonSuper.finalPayable}`);

  // Format receipt BEFORE any late-night QR fallback so MOJO `−₹100` merchant discount check is 100% preserved!
  const formattedReceipt = formatSwiggyWorldCartReceipt(orderNonSuper, '6296591407');
  let qrNonSuper;
  let qrOrderRef = orderNonSuper;
  try {
    qrNonSuper = await generateRealSwiggyMerchantUpiQr(accNonSuper, orderNonSuper);
  } catch (closedErr) {
    if (!/closed|out of stock|unserviceable/i.test(String(closedErr?.message || ''))) throw closedErr;
    const openSpec = await discoverOpen24x7RestaurantOrder(accNonSuper, {
      addressId: orderNonSuper.addressDetails?.id || null
    });
    qrOrderRef = { ...orderNonSuper, ...openSpec };
    delete qrOrderRef.groupCartId;
    delete qrOrderRef.cart;
    await syncGroupCartAndCheckoutForAccount(accNonSuper, qrOrderRef);
    qrNonSuper = await generateRealSwiggyMerchantUpiQr(accNonSuper, qrOrderRef);
  }
  console.log('  💳 acc_6296591407 Real Swiggy UPI QR:', qrNonSuper);
  check('`acc_6296591407` Real Swiggy UPI QR amount EQUALS `order.finalPayable` TO THE EXACT RUPEE', Number(qrNonSuper.amount) === Number(qrOrderRef.finalPayable), `qr=${qrNonSuper.amount} vs bill=${qrOrderRef.finalPayable}`);

  check('Receipt displays `Restaurant Offer Discount: −₹100` (not double-counted)', formattedReceipt.includes('Restaurant Offer Discount: −₹100'), formattedReceipt);
  check('Receipt displays `Swiggy One Lite Membership: +₹1` & `Delivery Fee: FREE`', formattedReceipt.includes('Swiggy One Lite Membership: +₹1') && formattedReceipt.includes('Delivery Fee: FREE'), formattedReceipt);
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check('`index.js` exposes `/health` build tag (`v13+`/`v14+`/`v15+`) + `merchantOfferDisc`', /build:\s*'v1[3-9]-/.test(indexSrc) && indexSrc.includes('merchantOfferDisc'));

  // 4. Test Parallel Multi-Account Winner (`findBestMaxCouponAccountForOrder`) across BOTH live accounts simultaneously!
  const multiOrder = {
    id: 'E2E_V13_MULTI_BEST',
    cart: GC_URL,
    address: CUST_ADDR
  };
  const tMulti = Date.now();
  const bestRes = await findBestMaxCouponAccountForOrder(multiOrder, { preferZeroOrderAccounts: false });
  const multiMs = Date.now() - tMulti;
  console.log('  🏆 Parallel Multi-ID Winner Summary:', {
    ms: multiMs,
    winningKey: bestRes.winningKey,
    finalPayable: multiOrder.finalPayable,
    totalSavings: multiOrder.totalSavings,
    comparison: bestRes.accountComparison
  });
  const minCompared = Math.min(...(bestRes.accountComparison || []).map(c => Number(c.finalPayable)));
  check('Parallel Multi-ID scan compared both live accounts & picked exact minimum `finalPayable` (`<= ₹300`)', bestRes.success === true && bestRes.accountComparison.length >= 2 && Number(multiOrder.finalPayable) === minCompared && Number(multiOrder.finalPayable) <= 300);

  let qrBest;
  let multiOrderRef = multiOrder;
  try {
    qrBest = await generateRealSwiggyMerchantUpiQr(bestRes.winningAccount, multiOrder);
  } catch (closedErr) {
    if (!/closed|out of stock|unserviceable/i.test(String(closedErr?.message || ''))) throw closedErr;
    const openSpec = await discoverOpen24x7RestaurantOrder(bestRes.winningAccount, {
      addressId: multiOrder.addressDetails?.id || null
    });
    multiOrderRef = { ...multiOrder, ...openSpec };
    delete multiOrderRef.groupCartId;
    delete multiOrderRef.cart;
    await syncGroupCartAndCheckoutForAccount(bestRes.winningAccount, multiOrderRef);
    qrBest = await generateRealSwiggyMerchantUpiQr(bestRes.winningAccount, multiOrderRef);
  }
  console.log('  💳 Winning Account Real Swiggy UPI QR:', qrBest);
  check('Winning Account Real Swiggy UPI QR amount EQUALS `multiOrder.finalPayable` TO THE EXACT RUPEE', Number(qrBest.amount) === Number(multiOrderRef.finalPayable), `qr=${qrBest.amount} vs bill=${multiOrderRef.finalPayable}`);
  check('Total Chromium launches across ALL live V13 flows === 0', chromiumLaunches === 0, `launches=${chromiumLaunches}`);
} finally {
  // Cleanly flush ALL live accounts and remove temporary test addresses!
  for (const acc of [accNonSuper, accSuper]) {
    await swiggyCartFlush(acc).catch(() => {});
  }
  for (const [acc, addrId] of createdAddrIdsByAcc) {
    if (/^\d+$/.test(String(addrId))) {
      await dapiFetch(acc, 'address/delete', { method: 'POST', body: { address_id: String(addrId) } }).catch(() => {});
    }
  }
  for (const [lbl, acc] of [['acc_6296591407', accNonSuper], ['acc_9935123518', accSuper]]) {
    const c = await swiggyCartGet(acc).catch(() => null);
    const cnt = Number(c?.json?.data?.cart_total_count || 0);
    console.log(`  🧹 Post-test cart count on ${lbl}: ${cnt}`);
    assert.equal(cnt, 0, `Expected 0 leftover items on ${lbl}`);
  }
}

console.log(`\n🎉 ALL ${passed} V13 LIVE E2E ASSERTIONS PASSED WITH ZERO CHROMIUM LAUNCHES!`);
process.exit(0);
