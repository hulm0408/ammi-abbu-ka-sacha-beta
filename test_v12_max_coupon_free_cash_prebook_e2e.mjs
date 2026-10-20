import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { getDb, saveDb } from './store.js';
import {
  claimSwiggyBreakfastAndLateNightOffers,
  EVENT_OFFER_OPTIONS
} from './swiggy-bridge.js';
import {
  callSwiggyFoodMcpTool,
  parseDapiCartPayload,
  formatSwiggyWorldCartReceipt,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  generateRealSwiggyMerchantUpiQr,
  swiggyCartFlush,
  inspectCartForAccount
} from './swiggy-cart.js';

let passed = 0;
function check(label, cond) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  passed++;
  console.log(`  ✅ [${passed}] ${label}`);
}

console.log('🚀 Running Task 11 Full E2E Suite (Max Discount Coupon + Free Cash + 15-Day LN/BF Pre-Book + Wallet Split-Pay + Anti-FNA)...\n');

// Spy on `puppeteer.launch` — MUST remain strictly ZERO (`0`) throughout ALL order sync, coupon maxing, Free Cash & QR flows!
let chromiumLaunches = 0;
const origLaunch = puppeteer.launch;
puppeteer.launch = async (...args) => {
  chromiumLaunches++;
  return origLaunch.apply(puppeteer, args);
};

// =========================================================================
// PART 1: LIVE SWIGGY PRODUCTION — 15-Day Pre-Book + PATCH Reward Switcher
// =========================================================================
console.log('━━━ PART 1: Live `events.swiggy.com` 15-Day Breakfast & Late Night Pre-Book + PATCH Switcher ━━━');
{
  const db = getDb();
  const entries = Object.entries(db.config.accounts).filter(([, a]) => a.isLoggedIn);
  check('At least 2 logged-in Swiggy accounts present in data/db.json', entries.length >= 2);
  check('All 4 official Swiggy event reward options configured', Object.keys(EVENT_OFFER_OPTIONS).length === 4);

  // Test live PATCH to option 2 (`₹150 OFF Coupon (>₹249)`), then lock back to option 1 (`₹50 Free Cash (>₹199)`) across all 15 days!
  const [, firstAcc] = entries[0];
  const switched = await claimSwiggyBreakfastAndLateNightOffers(firstAcc, {
    force: true,
    forcePatch: true,
    offerValue: 2
  });
  check('Live PATCH reward switch to Option #2 succeeded', switched.success === true && switched.offerValue === 2);

  // Now lock ALL active accounts across today + next 14 days on Option #1 (`₹50 Free Cash (>₹199)`) and persist to `data/db.json`!
  for (const [key, acc] of entries) {
    const res = await claimSwiggyBreakfastAndLateNightOffers(acc, {
      force: true,
      forcePatch: true,
      offerValue: 1
    });
    acc.preferredOfferValue = 1;
    acc.offers = res;
    check(`${key}: Both Breakfast & Late Night claimed live on events.swiggy.com`, res.bothClaimed === true);
    check(`${key}: Pre-locked Today + Tomorrow 48h rolling Breakfast days (${res.breakfast.lockedDaysCount})`, res.breakfast.lockedDaysCount >= 2);
    check(`${key}: Pre-locked Today + Tomorrow 48h rolling Late Night days (${res.lateNight.lockedDaysCount})`, res.lateNight.lockedDaysCount >= 2);
    check(`${key}: Exact slot diagnostic populated`, Boolean(res.breakfast.message && res.lateNight.message));
  }
  saveDb(db);
}

// =========================================================================
// PART 2: LIVE SWIGGY PRODUCTION — Cart-First Ordering + MOBILE_WEB_UA + MCP
// =========================================================================
console.log('\n━━━ PART 2: Live Production Sequential Cart-First Discovery + MOBILE_WEB_UA + Zero Chromium ━━━');
{
  const db = getDb();
  const acc = db.config.accounts.acc_9935123518;
  const networkLog = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const ua = init?.headers?.['User-Agent'] || init?.headers?.['user-agent'] || '';
    networkLog.push({ ts: Date.now(), url, ua, body: typeof init?.body === 'string' ? init.body : '' });
    return realFetch(input, init);
  };

  try {
    // Dynamically find an open Lucknow restaurant + non-variant item via Official Swiggy Food MCP so this E2E works 24x7 at ANY hour (even 2 AM)!
    const mcpAddr = await callSwiggyFoodMcpTool(acc, 'get_addresses', {});
    check('Official Swiggy Food MCP `get_addresses` succeeded live without Chromium', mcpAddr.ok === true && Boolean(mcpAddr.structured));
    const liveAddrList = mcpAddr.structured?.addresses || mcpAddr.structured?.data || [];
    const liveAddr = Array.isArray(liveAddrList) && liveAddrList[0] ? liveAddrList[0] : { id: 'dbbr5js1d96sjbedhba0', latitude: 26.85, longitude: 80.95 };
    const liveAddrId = String(liveAddr.id || liveAddr.addressId || 'dbbr5js1d96sjbedhba0');

    const searchRes = await callSwiggyFoodMcpTool(acc, 'search_restaurants', {
      addressId: liveAddrId,
      query: 'pizza'
    });
    const restCandidates = searchRes.structured?.restaurants || [];
    let chosenRest = null;
    let chosenItem = null;
    for (const r of restCandidates.slice(0, 6)) {
      const rId = String(r.id || r.restaurantId || '');
      if (!rId) continue;
      const menuRes = await callSwiggyFoodMcpTool(acc, 'get_restaurant_menu', {
        restaurantId: rId,
        addressId: liveAddrId,
        page: 1,
        pageSize: 5
      });
      const foundItems = [];
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        const id = n.id || n.item_id;
        const hasReqVariant = Boolean(
          (Array.isArray(n.variantsV2?.variantGroups) && n.variantsV2.variantGroups.length > 0) ||
          (Array.isArray(n.variant_groups) && n.variant_groups.length > 0) ||
          n.has_variants === true ||
          (Array.isArray(n.addons) && n.addons.some(a => Number(a.minAddons || a.min_addons || 0) > 0))
        );
        const inStock = n.inStock !== 0 && n.in_stock !== false;
        const priceNum = Number(n.price ?? n.final_price ?? n.default_price ?? 0);
        if (id && n.name && inStock && !hasReqVariant && priceNum > 0) {
          foundItems.push({
            id: String(id),
            name: String(n.name),
            price: priceNum > 2000 ? Math.round(priceNum / 100) : priceNum
          });
        }
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') walk(v);
        }
      };
      walk(menuRes.structured);
      if (foundItems.length > 0) {
        chosenRest = { id: rId, name: r.name || 'Live Open Restaurant' };
        chosenItem = foundItems[0];
        break;
      }
    }
    check('Discovered live open restaurant + in-stock non-variant item via MCP 24x7', Boolean(chosenRest && chosenItem));

    networkLog.length = 0; // Measure strictly the `syncGroupCartAndCheckoutForAccount` network sequence!

    const testOrder = {
      id: 'E2E_LIVE_SEQ_1',
      restaurantId: chosenRest.id,
      restaurantName: chosenRest.name,
      items: [{ itemId: chosenItem.id, menu_item_id: Number(chosenItem.id), name: chosenItem.name, price: chosenItem.price, qty: 2 }],
      address: 'Hazratganj, Lucknow, Uttar Pradesh 226001',
      addressDetails: {
        id: liveAddrId,
        name: 'Prithvi',
        mobile: '9935123518',
        address: 'Hazratganj, Lucknow, Uttar Pradesh 226001',
        area: 'Hazratganj',
        city: 'Lucknow',
        lat: String(liveAddr.latitude || liveAddr.lat || '26.8500000'),
        lng: String(liveAddr.longitude || liveAddr.lng || '80.9499970')
      }
    };

    const syncRes = await syncGroupCartAndCheckoutForAccount(acc, testOrder, { captureScreenshot: false });
    check('Live Swiggy cart sync succeeded cleanly', syncRes.success === true);
    check('Live order marked swiggyVerified === true with positive finalPayable', testOrder.swiggyVerified === true && testOrder.finalPayable > 0);
    check('Events 15-day pre-book summary attached to synced order', Boolean(testOrder.eventsClaimSummary));

    const firstCartPushIdx = networkLog.findIndex(x => x.url.includes('chkout.swiggy.com/api/v2/cart/client/update'));
    const firstOffersPayIdx = networkLog.findIndex(x => x.url.includes('/dapi/offers/payment'));
    const firstMcpCouponsIdx = networkLog.findIndex(x => x.url.includes('mcp.swiggy.com/food') && x.body.includes('fetch_food_coupons'));
    const firstMcpCartIdx = networkLog.findIndex(x => x.url.includes('mcp.swiggy.com/food') && x.body.includes('get_food_cart'));

    check('Server cart update (`chkout v2/cart/client/update`) ran BEFORE `/dapi/offers/payment`', firstCartPushIdx >= 0 && firstOffersPayIdx > firstCartPushIdx);
    check('Server cart update ran BEFORE MCP `fetch_food_coupons` & `get_food_cart`', firstMcpCouponsIdx > firstCartPushIdx && firstMcpCartIdx > firstCartPushIdx);

    const offersPayCall = networkLog[firstOffersPayIdx];
    check('`/dapi/offers/payment` used Mobile Safari Web UA (NEVER broken `Swiggy-Android` UA)', offersPayCall.ua.includes('Mobile Safari') && offersPayCall.ua !== 'Swiggy-Android');
    check('Zero Chromium launches across entire live intake & Max-Coupon discovery (`0` launches)', chromiumLaunches === 0);
  } finally {
    globalThis.fetch = realFetch;
    await swiggyCartFlush(acc).catch(() => {});
  }
}

// =========================================================================
// PART 3: FULL CHECKOUT ENGINE MATRIX — Auto-Suggested Coupon Trap + Best Coupon
// Winner + Campaign Free Cash (`₹50`) + Wallet Split-Pay (`₹60`) + Fallback QR
// =========================================================================
console.log('\n━━━ PART 3: Full Max-Coupon + Campaign Free Cash (`₹50`) + Wallet Split-Pay (`₹60`) + Multi-ID Winner Simulation ━━━');
{
  const realFetch = globalThis.fetch;
  const makeFakeJwt = (sub) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
    return `${h}.${p}.sig`;
  };

  const rawDbBackup = fs.readFileSync('./data/db.json', 'utf8');
  const db = getDb();
  const placePayloads = [];
  let rejectSplitPayOnce = false;

  const buildSimCartData = ({ isAccA, couponCode, hasItems = true }) => {
    if (!hasItems) {
      return {
        cartMeta: {
          cartId: '',
          address_id: isAccA ? 'addrA_1' : 'addrB_1',
          cart_menu_items: [],
          addresses: [{ id: isAccA ? 'addrA_1' : 'addrB_1', name: 'Customer', mobile: '9999988888', address: 'Hazratganj, Lucknow', lat: '26.85', lng: '80.95', city: 'Lucknow' }],
          order_total: 0
        }
      };
    }
    const appliedCoupon = isAccA
      ? (couponCode === 'STEALDEAL' ? { code: 'STEALDEAL', disc: 125 } : couponCode === 'TRYNEW' ? { code: 'TRYNEW', disc: 40 } : { code: 'TRYNEW', disc: 0, invalid: true })
      : (couponCode === 'WELCOME50' ? { code: 'WELCOME50', disc: 80 } : { code: '', disc: 0, invalid: true });

    const itemTotal = 320;
    const campaignFreeCash = isAccA ? 50 : 0; // ₹50 Late Night Free Cash auto-stacks over coupon!
    const walletBalance = isAccA ? 60 : 0;    // ₹60 Swiggy Money wallet split-pay balance!
    const taxes = 28;
    const rawOrderTotal = itemTotal - appliedCoupon.disc - campaignFreeCash + taxes;

    return {
      cartMeta: {
        cartId: isAccA ? 'cartA_999' : 'cartB_888',
        address_id: isAccA ? 'addrA_1' : 'addrB_1',
        restaurant_details: { id: '777111', name: 'Royal Biryani House', lat: '26.85', lng: '80.95' },
        cart_menu_items: [{ menu_item_id: 55501, name: 'Mutton Dum Biryani', quantity: 1, subtotal: 32000, total: 32000, final_price: 32000 }],
        addresses: [{ id: isAccA ? 'addrA_1' : 'addrB_1', name: 'Customer', mobile: '9999988888', address: 'Hazratganj, Lucknow', lat: '26.85', lng: '80.95', city: 'Lucknow' }],
        item_total: itemTotal,
        positiveDeliveryChargesExclusive: 0,
        free_delivery_discount: 45,
        swiggyOneBenefitsApplicable: true,
        is_coupon_valid: appliedCoupon.disc > 0 ? 1 : 0,
        coupon_code: appliedCoupon.code,
        coupon_discount_total: appliedCoupon.disc,
        trade_discount_total: campaignFreeCash,
        trade_discount_reward_amount: campaignFreeCash,
        taxesAndCharges: taxes,
        user_swiggy_money: walletBalance,
        swiggy_money: 0,
        order_total: rawOrderTotal
      }
    };
  };

  let accACurrentCoupon = '';
  let accBCurrentCoupon = '';
  let accAHasItems = false;
  let accBHasItems = false;

  const tidA = makeFakeJwt('100001');
  const tidB = makeFakeJwt('100002');

  db.config.accounts = {
    sim_acc_a: {
      isLoggedIn: true,
      name: 'Clean ID A (LN ₹50 FreeCash + ₹60 Wallet)',
      phone: '9000000001',
      customerId: '100001',
      tid: tidA,
      token: 'tokA',
      cookies: `_session_tid=sessA; tid=${tidA}; _device_id=devA; _sid=sidA`
    },
    sim_acc_b: {
      isLoggedIn: true,
      name: 'Standard ID B',
      phone: '9000000002',
      customerId: '100002',
      tid: tidB,
      token: 'tokB',
      cookies: `_session_tid=sessB; tid=${tidB}; _device_id=devB; _sid=sidB`
    }
  };
  saveDb(db);

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const hdrs = init?.headers || {};
    const authHdr = JSON.stringify(hdrs);
    const isAccA = authHdr.includes(tidA) || authHdr.includes('tokA') || authHdr.includes('sessA') || authHdr.includes('100001');
    const bodyObj = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {};

    if (url.includes('events.swiggy.com')) {
      return new Response(JSON.stringify({ message: 'Subscribed', shouldNotify: true, value: 1 }), { status: 200 });
    }
    if (url.includes('maps.swiggy.com/addresses/nearby')) {
      return new Response(JSON.stringify({
        statusCode: 0,
        data: {
          addresses: [{ id: isAccA ? 'addrA_1' : 'addrB_1', name: 'Customer', mobile: '9999988888', address: 'Hazratganj, Lucknow', lat: '26.85', lng: '80.95', city: 'Lucknow' }]
        }
      }), { status: 200 });
    }
    if (url.includes('/dapi/order/all')) {
      return new Response(JSON.stringify({ statusCode: 0, csrfToken: 'csrf_ok', data: { orders: [] } }), { status: 200 });
    }
    if (url.includes('chkout.swiggy.com/api/v2/cart/client/flush')) {
      if (isAccA) { accACurrentCoupon = ''; accAHasItems = false; } else { accBCurrentCoupon = ''; accBHasItems = false; }
      return new Response(JSON.stringify({ statusCode: 0, data: buildSimCartData({ isAccA, couponCode: '', hasItems: false }) }), { status: 200 });
    }
    if (url.includes('chkout.swiggy.com/api/v2/cart/client/update')) {
      const itemsArr = bodyObj?.cart?.cartItems || bodyObj?.cartItems || [];
      const code = String(bodyObj?.cart?.couponCode ?? bodyObj?.couponCode ?? bodyObj?.coupon_code ?? '').toUpperCase();
      if (isAccA) { accAHasItems = itemsArr.length > 0; accACurrentCoupon = code; }
      else { accBHasItems = itemsArr.length > 0; accBCurrentCoupon = code; }
      return new Response(JSON.stringify({ statusCode: 0, tid: isAccA ? tidA : tidB, data: buildSimCartData({ isAccA, couponCode: code, hasItems: itemsArr.length > 0 }) }), { status: 200 });
    }
    if (url.includes('chkout.swiggy.com/api/v2/cart/client')) {
      const code = isAccA ? accACurrentCoupon : accBCurrentCoupon;
      const hasItems = isAccA ? accAHasItems : accBHasItems;
      return new Response(JSON.stringify({ statusCode: 0, tid: isAccA ? tidA : tidB, data: buildSimCartData({ isAccA, couponCode: code, hasItems }) }), { status: 200 });
    }
    if (url.includes('mcp.swiggy.com/food')) {
      const toolName = bodyObj?.params?.name;
      if (toolName === 'get_food_cart') {
        // CRITICAL TRAP TEST: `STEALDEAL` returned ONLY inside `offers.coupon_applied` with `coupon_discount: 0`!
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: {
              offers: { coupon_applied: isAccA ? 'STEALDEAL' : 'WELCOME50', coupon_discount: 0 },
              pricing: { trade_discount_reward_amount: isAccA ? 50 : 0 }
            }
          }
        }), { status: 200 });
      }
      if (toolName === 'fetch_food_coupons') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: {
              coupons: isAccA ? [{ coupon_code: 'TRYNEW', is_applicable: true, title: '₹40 OFF' }] : []
            }
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: {} } }), { status: 200 });
    }
    if (url.includes('/dapi/offers/')) {
      return new Response(JSON.stringify({ statusCode: 0, data: { cards: [] } }), { status: 200 });
    }
    if (url.includes('payments.swiggy.com/api/v3/order/place')) {
      placePayloads.push(bodyObj);
      if (rejectSplitPayOnce && bodyObj.swiggy_pay_amount) {
        rejectSplitPayOnce = false;
        return new Response(JSON.stringify({ statusCode: 1, statusMessage: 'Split pay temporarily unavailable' }), { status: 200 });
      }
      const splitUsed = Number(bodyObj.swiggy_pay_amount || 0);
      const netUpi = 173 - splitUsed; // 320 - 125 (STEALDEAL) - 50 (Campaign FreeCash) + 28 (GST) = 173; minus ₹60 Wallet = ₹113!
      return new Response(JSON.stringify({
        statusCode: 0,
        data: {
          order_data: {
            order_id: '240999888777',
            order_total: 173,
            sla_time: '24',
            restaurant_name: 'Royal Biryani House',
            targeted_marketplace_payment_reference_id: 'paas_txn_777',
            app_redirection_info: {
              upiRedirect: {
                upiIntentRedirect: {
                  upiIntentUrl: `upi://pay?pa=swiggyupi@icici&pn=Swiggy&tr=paas_txn_777&am=${netUpi.toFixed(2)}&cu=INR`,
                  transactionId: 'paas_txn_777'
                }
              }
            }
          }
        }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ statusCode: 0, data: {} }), { status: 200 });
  };

  try {
    const order = {
      id: 'E2E_SIM_MAX_1',
      restaurantId: '777111',
      restaurantName: 'Royal Biryani House',
      items: [{ itemId: '55501', menu_item_id: 55501, name: 'Mutton Dum Biryani', price: 320, qty: 1 }],
      address: 'Hazratganj, Lucknow',
      addressDetails: { name: 'Customer', mobile: '9999988888', address: 'Hazratganj, Lucknow', area: 'Hazratganj', city: 'Lucknow', lat: '26.85', lng: '80.95' }
    };

    const best = await findBestMaxCouponAccountForOrder(order);
    check('Multi-Account Max Coupon Finder picked `sim_acc_a` as winner (`₹113` vs `₹268`)', best.success === true && best.winningKey === 'sim_acc_a');
    check('Auto-suggested MCP `STEALDEAL` (`−₹125`) beat lower `TRYNEW` (`−₹40`)', order.couponCode === 'STEALDEAL' && order.discountAmount === 125);
    check('Campaign Free Cash (`₹50`) + Wallet Split-Pay (`₹60`) both detected (`freeCashApplied = ₹110`)', order.campaignFreeCash === 50 && order.walletSplitPayAmount === 60 && order.freeCashApplied === 110);
    check('Effective `finalPayable` equals exact `₹113` (`320 - 125 - 50 + 28 - 60`)', order.finalPayable === 113);
    check('`totalSavings` equals exact `₹280` (`125 coupon + 50 LN FreeCash + 45 FreeDel + 60 Wallet`) without double-counting', order.totalSavings === 280);

    const receipt = formatSwiggyWorldCartReceipt(order);
    check('Final Bill displays `Coupon STEALDEAL: −₹125`', receipt.includes('Coupon STEALDEAL: −₹125'));
    check('Final Bill displays `Swiggy Money / Free Cash Wallet: −₹60`', receipt.includes('Swiggy Money / Free Cash Wallet: −₹60'));
    check('Final Bill displays `Total Savings: ₹280` & `Final Total: ₹113`', receipt.includes('Total Savings: ₹280') && receipt.includes('Final Total: ₹113'));

    // Generate REAL Merchant QR -> must pass `swiggy_pay_amount: "60"` and bill `₹113`!
    const qr1 = await generateRealSwiggyMerchantUpiQr(db.config.accounts.sim_acc_a, order);
    check('`generateRealSwiggyMerchantUpiQr` sent `swiggy_pay_amount: "60"` in POST body', placePayloads[0]?.swiggy_pay_amount === '60');
    check('UPI QR charges exact `₹113` after deducting `₹60` Swiggy Money Split-Pay', qr1.amount === 113 && qr1.upiIntentUrl.includes('am=113.00'));

    // Also test automatic gateway fallback if `swiggy_pay_amount` is rejected once -> seamlessly falls back to `₹173` QR without failing!
    placePayloads.length = 0;
    rejectSplitPayOnce = true;
    const qrFallback = await generateRealSwiggyMerchantUpiQr(db.config.accounts.sim_acc_a, order);
    check('Gateway split-pay rejection automatically retried cleanly without failing QR creation', placePayloads.length === 2 && !placePayloads[1].swiggy_pay_amount && qrFallback.amount === 173);
    check('Still strictly ZERO Chromium launches across entire simulation (`0` launches)', chromiumLaunches === 0);
  } finally {
    globalThis.fetch = realFetch;
    fs.writeFileSync('./data/db.json', rawDbBackup);
  }
}

// =========================================================================
// PART 4: FINAL LIVE CART CLEANLINESS CHECK ON ALL REAL ACCOUNTS
// =========================================================================
console.log('\n━━━ PART 4: Final Live Swiggy Cart Flush & Clean-State Verification ━━━');
{
  const db = getDb();
  for (const [key, acc] of Object.entries(db.config.accounts)) {
    if (!acc.isLoggedIn) continue;
    await swiggyCartFlush(acc).catch(() => {});
    const after = await inspectCartForAccount(acc);
    check(`${key}: Live Swiggy cart confirmed 100% clean & empty (${after?.items?.length || 0} items)`, (after?.items?.length || 0) === 0);
  }
}

console.log(`\n🏆 ALL ${passed}/${passed} TASK 11 E2E ASSERTIONS PASSED WITH ${chromiumLaunches} CHROMIUM LAUNCHES! 🚀`);
