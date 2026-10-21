import assert from 'node:assert/strict';
import { discoverOpen24x7RestaurantOrder } from './test-live-open-cart-helper.mjs';
import { syncGroupCartAndCheckoutForAccount } from './swiggy-cart.js';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { getDb, saveDb } from './store.js';
import {
  clearAllAccountReservations,
  invalidateAccountOrderProfileCache,
  swiggyCartFlush,
  parseAddressDetails,
  callSwiggyFoodMcpTool
} from './swiggy-cart.js';
import {
  handleBossForwardedOrderInput,
  registerForwardedOrderHandlers,
  stopOrderPaymentPoller
} from './forwarded-order-flow.js';

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✅ [${String(passed).padStart(2, '0')}] ${msg}`);
}

let chromiumLaunches = 0;
const origLaunch = puppeteer.launch;
puppeteer.launch = async (...args) => {
  chromiumLaunches++;
  return origLaunch.apply(puppeteer, args);
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&quot;');
}

function renderBodyHtml(order) {
  const ad = order.addressDetails || parseAddressDetails(order.address) || {};
  return (
    `📱 <b>Order Account:</b> ${escapeHtml(order.orderAccount || '')}\n` +
    `🛒 <b>Your Cart:</b> ${escapeHtml(order.restaurantName || '')}\n` +
    `📍 <b>Delivery:</b> ${escapeHtml(ad.address || order.address || '')}\n` +
    `<b>Final Total: ₹${order.finalPayable || 0}</b>`
  );
}

console.log('========================================================================');
console.log('🚀 V14 FULL E2E SUITE: 10x SIMULTANEOUS ORDERS + 0-ORDER ID AUTO-SELECT');
console.log('   + MAX OFFER MATCHING + 10x PARALLEL QR & SIMULTANEOUS PAYMENTS');
console.log('========================================================================\n');

const rawDbBackup = fs.readFileSync('./data/db.json', 'utf8');

try {
  // ===========================================================================
  // PART 1: 10 SIMULTANEOUS ORDERS ACROSS 15 SWIGGY IDs (10 `0-Order` IDs +
  //         4 Used `>0 Order` IDs + 1 Expired ID) — ZERO CLICKS, ZERO OVERWRITES!
  // ===========================================================================
  console.log('━━━ PART 1: 10 Simultaneous Orders Burst + Strict `0-Order` Selection + Max-Offer Winner + 10x Parallel Payment ━━━');
  {
    const realFetch = globalThis.fetch;
    clearAllAccountReservations();
    invalidateAccountOrderProfileCache();

    const makeJwt = (sub, uid) => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const p = Buffer.from(JSON.stringify({ sub, user_id: String(uid), exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
      return `${h}.${p}.sig`;
    };

    const db = getDb();
    const bossId = db.config.bossIds[0];
    db.orders = {};
    db.config.accounts = {};

    // Seed 10 FRESH `0-Order` Swiggy IDs (`acc_zero_01` .. `acc_zero_10`) with varying real discount tiers,
    // PLUS 4 OLD used accounts (`3`, `7`, `15`, `29` past orders) AND 1 dead/expired session (`user_id: "0"`)!
    const offerByAccUserId = new Map();
    const pastOrdersByUserId = new Map();

    for (let i = 1; i <= 10; i++) {
      const uid = 910000 + i;
      const phone = `98100000${String(i).padStart(2, '0')}`;
      const key = `acc_zero_${String(i).padStart(2, '0')}`;
      const freeCash = i === 3 ? 125 : i <= 5 ? 80 : 50; // `acc_zero_03` has highest `-₹125` offer!
      offerByAccUserId.set(String(uid), freeCash);
      pastOrdersByUserId.set(String(uid), []); // STRICTLY 0 ORDERS ON SWIGGY!
      const tid = makeJwt(`dev-${i}`, uid);
      db.config.accounts[key] = {
        id: key,
        name: `FreshZeroID_${i}`,
        phone,
        mobile: phone,
        customerId: String(uid),
        tid,
        jwtTid: tid,
        token: `tok_${uid}`,
        sid: `sid_${uid}`,
        deviceId: `dev_${uid}`,
        cookies: `_session_tid=${'a'.repeat(140)}${String(i).padStart(4, '0')}; tid=${tid}; _sid=sid_${uid}; _device_id=dev_${uid}; _is_logged_in=1`,
        preferredOfferValue: i === 3 ? 4 : i <= 5 ? 2 : 1,
        isLoggedIn: true
      };
    }

    for (let j = 1; j <= 4; j++) {
      const uid = 820000 + j;
      const phone = `972000000${j}`;
      const key = `acc_used_0${j}`;
      offerByAccUserId.set(String(uid), 150); // Even with high promo, has >0 past orders so MUST lose to 0-Order IDs!
      pastOrdersByUserId.set(String(uid), Array.from({ length: j * 4 }, (_, k) => ({ order_id: `24000${j}${k}`, order_status: 'Delivered' })));
      const tid = makeJwt(`used-${j}`, uid);
      db.config.accounts[key] = {
        id: key,
        name: `UsedOldID_${j}`,
        phone,
        mobile: phone,
        customerId: String(uid),
        tid,
        jwtTid: tid,
        token: `tok_${uid}`,
        sid: `sid_${uid}`,
        deviceId: `dev_${uid}`,
        cookies: `_session_tid=${'b'.repeat(140)}000${j}; tid=${tid}; _sid=sid_${uid}; _device_id=dev_${uid}; _is_logged_in=1`,
        preferredOfferValue: 4,
        isLoggedIn: true
      };
    }

    const deadTid = makeJwt('dead-0', 0);
    db.config.accounts.acc_dead_99 = {
      id: 'acc_dead_99',
      name: 'DeadSessionID',
      phone: '9000000099',
      mobile: '9000000099',
      customerId: '',
      tid: deadTid,
      token: deadTid,
      sid: 'sid_dead',
      deviceId: 'dev_dead',
      cookies: `tid=${deadTid}; _sid=sid_dead`,
      isLoggedIn: true
    };
    saveDb(db);

    let qrSeq = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const hdrs = init?.headers || {};
      const getH = (n) => hdrs[n] || hdrs[n.toLowerCase()] || '';
      const uidMatch = (getH('userid') || '').trim() || (() => {
        const cookieStr = getH('Cookie') || '';
        const cookieTid = (cookieStr.match(/(?:^|;\s*)tid=([^;]+)/) || [])[1] || '';
        const t = getH('tid') || cookieTid || (getH('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (!t.includes('.')) return '';
        try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).user_id || ''; } catch { return ''; }
      })();

      // Realistic 80ms network RTT to prove true parallel O(1) execution across all 10 orders!
      await new Promise(r => setTimeout(r, 45));

      if (url.includes('shared_cart') || url.includes('/gc/')) {
        const gcNum = (url.match(/6221(\d\d)/) || [null, '01'])[1];
        return new Response(JSON.stringify({
          statusCode: 0,
          data: {
            group_cart_id: `gc_${gcNum}`,
            restaurant_id: `6221${gcNum}`,
            restaurant_details: { name: `Biryani House #${gcNum}` },
            cart_menu_items: [{ menu_item_id: 7000 + Number(gcNum), name: `Royal Dum Biryani #${gcNum}`, price: 32000, final_price: 22000, quantity: 1, offer_ids: ['OFF100'] }]
          }
        }), { status: 200 });
      }
      if (url.includes('/dapi/order/all')) {
        if (!uidMatch || uidMatch === '0') return new Response(JSON.stringify({ statusCode: 1 }), { status: 401 });
        return new Response(JSON.stringify({
          statusCode: 0,
          tid: getH('tid'),
          data: { orders: pastOrdersByUserId.get(uidMatch) || [] }
        }), { status: 200 });
      }
      if (url.includes('/dapi/profile/info')) {
        if (!uidMatch || uidMatch === '0') return new Response(JSON.stringify({ statusCode: 1 }), { status: 401 });
        return new Response(JSON.stringify({ statusCode: 0, data: { id: uidMatch, mobile: `98100${uidMatch.slice(-5)}` } }), { status: 200 });
      }
      if (url.includes('events.swiggy.com')) {
        return new Response(JSON.stringify({ statusCode: 0, data: { locked: true } }), { status: 200 });
      }
      if (url.includes('photon.komoot.io')) {
        return new Response(JSON.stringify({
          features: [{ geometry: { coordinates: [80.949997, 26.85] } }]
        }), { status: 200 });
      }
      if (url.includes('nominatim.openstreetmap.org')) {
        return new Response(JSON.stringify([{ lat: '26.8500', lon: '80.949997' }]), { status: 200 });
      }
      if (url.includes('address') || url.includes('maps.swiggy.com') || url.includes('place-autocomplete')) {
        return new Response(JSON.stringify({
          statusCode: 0,
          data: {
            address_id: `addr_${uidMatch}_${Math.floor(Math.random() * 9999)}`,
            addresses: [{ id: `addr_${uidMatch}_main`, lat: '26.8500', lng: '80.9500', address: 'Hazratganj, Lucknow 226001' }],
            predictions: [{ place_id: 'plc1', description: 'Hazratganj, Lucknow, Uttar Pradesh 226001', geometry: { location: { lat: 26.85, lng: 80.95 } } }]
          }
        }), { status: 200 });
      }
      if (url.includes('chkout.swiggy.com/api/v2/cart/client/flush')) {
        return new Response(JSON.stringify({ statusCode: 0, data: {} }), { status: 200 });
      }
      if (url.includes('chkout.swiggy.com/api/v2/cart/client')) {
        if (!uidMatch || uidMatch === '0') return new Response(JSON.stringify({ statusCode: 1, statusMessage: 'Session expired' }), { status: 200 });
        const freeCash = offerByAccUserId.get(uidMatch) ?? 50;
        const bodyObj = init?.body ? JSON.parse(init.body) : {};
        if (Array.isArray(bodyObj.cartItems) && bodyObj.cartItems.length === 0) {
          return new Response(JSON.stringify({ statusCode: 0, tid: getH('tid'), data: { cart_menu_items: [], order_total: 0 } }), { status: 200 });
        }
        const netTotal = Math.max(99, 273 - freeCash); // e.g., `273 - 125 = ₹148` on `acc_zero_03`!
        return new Response(JSON.stringify({
          statusCode: 0,
          tid: getH('tid'),
          data: {
            cartId: `cid_${uidMatch}`,
            originalCartId: `ocid_${uidMatch}`,
            address_id: bodyObj.address_id || `addr_${uidMatch}_main`,
            restaurant_details: { restaurant_id: bodyObj.restaurantId || '622101', name: `Biryani House` },
            user_super_status: 'NOT_SUPER',
            cart_menu_items: [{ menu_item_id: 7001, name: 'Royal Dum Biryani', base_price: 32000, final_price: 22000, quantity: 1, offer_ids: ['OFF100'] }],
            item_total: 320,
            trade_discount_total: 100 + freeCash,
            trade_discount_reward_list: [{ reward_type: 'FREE_CASH', discount_amount: freeCash }],
            subscription_total: 1,
            delivery_charges: 0,
            free_delivery_discount_hit: 32,
            packaging_charges: 24,
            total_tax: 28,
            order_total: netTotal,
            cart_total: netTotal,
            total_savings_shown: 100 + freeCash + 32
          }
        }), { status: 200 });
      }
      if (url.includes('mcp.swiggy.com/food')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { coupons: [] }, content: [{ type: 'text', text: '{}' }] } }), { status: 200 });
      }
      if (url.includes('/dapi/offers/')) {
        return new Response(JSON.stringify({ statusCode: 0, data: { cards: [] } }), { status: 200 });
      }
      if (url.includes('chkout.swiggy.com/api/v2/order/place')) {
        const bodyObj = JSON.parse(init.body || '{}');
        const seq = ++qrSeq;
        const oid = `25990000000${String(seq).padStart(3, '0')}`;
        const amt = Number(bodyObj.order_total || 193).toFixed(2);
        return new Response(JSON.stringify({
          statusCode: 0,
          tid: getH('tid'),
          data: {
            order_data: {
              order_id: oid,
              payment_txn_id: `PAAS_${oid}`,
              order_total: Number(amt),
              sla_time: 26,
              app_redirection_info: JSON.stringify({
                upiRedirect: {
                  upiIntentRedirect: {
                    upiIntentUrl: `upi://pay?pa=upiswiggy@icici&pn=Swiggy&tr=PAAS_${oid}&am=${amt}&cu=INR`
                  }
                }
              })
            }
          }
        }), { status: 200 });
      }
      return realFetch(input, init);
    };

    try {
      let msgSeq = 1000;
      const messages = new Map();
      const actionHandlers = [];

      const mockTelegram = {
        async sendMessage(chatId, text, extra = {}) {
          const id = ++msgSeq;
          messages.set(id, { id, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
          return { message_id: id, chat: { id: chatId } };
        },
        async sendPhoto(chatId, photo, extra = {}) {
          const id = ++msgSeq;
          messages.set(id, { id, type: 'photo', buffer: photo?.source, caption: extra?.caption || '', keyboard: extra?.reply_markup?.inline_keyboard || [] });
          return { message_id: id, chat: { id: chatId } };
        },
        async deleteMessage(_chatId, messageId) {
          messages.delete(messageId);
          return true;
        },
        async editMessageText(_chatId, messageId, _inlineId, text, extra = {}) {
          messages.set(messageId, { id: messageId, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
          return true;
        }
      };

      const mockBot = { action: (pattern, fn) => actionHandlers.push({ pattern, fn }) };
      registerForwardedOrderHandlers(mockBot, {
        isBoss: (id) => Number(id) === Number(bossId),
        formatOrderBodyFn: renderBodyHtml,
        customPaymentChecker: async (_acc, ord) => ({
          paid: true,
          swiggyOrderId: ord.pendingSwiggyOrderId,
          orderStatus: 'Order Confirmed • Preparing',
          etaMinutes: '25',
          deliveryBoy: { name: 'Ramesh Rider', mobile: '9876543210' },
          nativeShareUrl: 'https://swig.gy/live-order-track-demo'
        })
      });

      const makeCtx = ({ text = '', cbData = null, msgId = null }) => ({
        from: { id: bossId, first_name: 'Boss', last_name: 'Main' },
        chat: { id: bossId, type: 'private' },
        telegram: mockTelegram,
        message: text ? { text } : null,
        callbackQuery: cbData ? { data: cbData, message: { message_id: msgId } } : undefined,
        reply: (t, ex) => mockTelegram.sendMessage(bossId, t, ex),
        replyWithPhoto: (p, ex) => mockTelegram.sendPhoto(bossId, p, ex),
        editMessageText: (t, ex) => mockTelegram.editMessageText(bossId, msgId, undefined, t, ex),
        answerCbQuery: async () => true
      });

      const clickButton = async (cbData, msgId = 1001) => {
        for (const h of actionHandlers) {
          const m = cbData.match(h.pattern);
          if (m) {
            const ctx = makeCtx({ cbData, msgId });
            ctx.match = m;
            await h.fn(ctx);
            return;
          }
        }
        throw new Error(`No handler for ${cbData}`);
      };

      // 1A. First verify single-order MAX OFFER race across free `0-Order` accounts picks `acc_zero_03` (`-₹125` Free Cash => `₹148`!)
      await handleBossForwardedOrderInput(
        makeCtx({ text: `https://www.swiggy.com/shared_cart?group_cart_id=622101\nHouse 1, Hazratganj, Lucknow, Uttar Pradesh 226001` }),
        {
          rawText: `https://www.swiggy.com/shared_cart?group_cart_id=622101\nHouse 1, Hazratganj, Lucknow, Uttar Pradesh 226001`,
          formatOrderBodyFn: renderBodyHtml
        }
      );
      const singleOrd = Object.values(getDb().orders)[0];
      ok(
        singleOrd.selectedAccount === 'acc_zero_03' && singleOrd.finalPayable === 148 && singleOrd.selectedAccountZeroOrders === true,
        `Max-Offer Race among 0-Order IDs selected #1 highest-offer account acc_zero_03 (₹148 vs ₹193/₹223) while ignoring all >0-Order IDs!`
      );
      await clickButton(`fwd_cancel_${singleOrd.id}`, singleOrd.activeCardMessageId);

      // 1B. NOW BLAST ALL 10 DIFFERENT ORDERS AT THE EXACT SAME MILLISECOND (`Promise.all` — ZERO MANUAL CLICKS!):
      // Mix BOTH styles in the same 10-order burst:
      // - Orders 1..6: Combined `Address + Cart` messages
      // - Orders 7..8: Rapid FIFO `Cart 7, Cart 8` followed by `Address 7, Address 8`
      // - Orders 9..10: Single mega-message containing 2 separate `Cart + Address` blocks!
      const t10Start = Date.now();
      const burstPromises = [];
      for (let i = 1; i <= 6; i++) {
        const msg = `House ${10 + i}, Gomti Nagar Sector ${i}, Lucknow, Uttar Pradesh 226010\nhttps://www.swiggy.com/shared_cart?group_cart_id=62210${i}`;
        burstPromises.push(handleBossForwardedOrderInput(makeCtx({ text: msg }), { rawText: msg, formatOrderBodyFn: renderBodyHtml }));
      }
      // FIFO separate Cart 7, Cart 8 -> Address 7, Address 8
      burstPromises.push((async () => {
        await handleBossForwardedOrderInput(makeCtx({ text: 'https://www.swiggy.com/shared_cart?group_cart_id=622107' }), {
          rawText: 'https://www.swiggy.com/shared_cart?group_cart_id=622107',
          formatOrderBodyFn: renderBodyHtml
        });
        await handleBossForwardedOrderInput(makeCtx({ text: 'https://www.swiggy.com/shared_cart?group_cart_id=622108' }), {
          rawText: 'https://www.swiggy.com/shared_cart?group_cart_id=622108',
          formatOrderBodyFn: renderBodyHtml
        });
        await Promise.all([
          handleBossForwardedOrderInput(makeCtx({ text: 'House 77, Aliganj Sector K, Lucknow, Uttar Pradesh 226024' }), {
            rawText: 'House 77, Aliganj Sector K, Lucknow, Uttar Pradesh 226024',
            formatOrderBodyFn: renderBodyHtml
          }),
          handleBossForwardedOrderInput(makeCtx({ text: 'House 88, Indira Nagar Block C, Lucknow, Uttar Pradesh 226016' }), {
            rawText: 'House 88, Indira Nagar Block C, Lucknow, Uttar Pradesh 226016',
            formatOrderBodyFn: renderBodyHtml
          })
        ]);
      })());
      // Multi-order single message paste (Orders 9 & 10 in ONE message!)
      const dualPasteMsg =
        `House 91, Mahanagar Extension, Lucknow, Uttar Pradesh 226006\nhttps://swig.gy/gc/622109/HostNine\n` +
        `House 100, Nirala Nagar Crossing, Lucknow, Uttar Pradesh 226020\nhttps://swig.gy/gc/622110/HostTen`;
      burstPromises.push(handleBossForwardedOrderInput(makeCtx({ text: dualPasteMsg }), { rawText: dualPasteMsg, formatOrderBodyFn: renderBodyHtml }));

      await Promise.all(burstPromises);
      const burstMs = Date.now() - t10Start;

      const active10Orders = Object.values(getDb().orders).filter(o => o.status !== 'CANCELLED');
      ok(active10Orders.length === 10, `Created EXACTLY 10 independent active orders with zero overwrites (got ${active10Orders.length})`);
      ok(burstMs < 3500, `All 10 orders auto-selected accounts & synced bills in parallel in ${burstMs}ms (<3.5s)!`);
      ok(active10Orders.every(o => o.cardStage === 'BILL_READY'), 'All 10/10 orders automatically reached BILL_READY with zero manual clicks!');

      const chosenAccounts = active10Orders.map(o => o.selectedAccount);
      const uniqueChosenAccounts = new Set(chosenAccounts);
      ok(
        uniqueChosenAccounts.size === 10,
        `100% Exclusive Multi-ID Assignment: 10 orders assigned to 10 DISTINCT Swiggy IDs (${chosenAccounts.join(', ')})!`
      );
      ok(
        chosenAccounts.every(k => k.startsWith('acc_zero_')) && active10Orders.every(o => o.selectedAccountZeroOrders === true),
        `Strict 0-Order Priority Verified: ALL 10/10 chosen IDs have 0 past orders (0 used IDs & 0 dead IDs touched)!`
      );

      // 1C. 1-Click Parallel Generation of ALL 10 Official Swiggy Dynamic UPI QRs at once!
      const tQr10 = Date.now();
      await clickButton(`fwd_parallel_qrs_${active10Orders[0].id}`, active10Orders[0].activeCardMessageId);
      const qr10Ms = Date.now() - tQr10;

      const qrOrders10 = Object.values(getDb().orders).filter(o => o.status !== 'CANCELLED');
      const uniqueSwiggyOrderIds = new Set(qrOrders10.map(o => o.pendingSwiggyOrderId));
      ok(
        qrOrders10.every(o => o.cardStage === 'QR_GENERATED') && uniqueSwiggyOrderIds.size === 10,
        `All 10 Official Swiggy QRs generated simultaneously in ${qr10Ms}ms across 10 distinct Swiggy Order IDs!`
      );

      // Verify pixel-level scannability on sample generated PNG QR
      const samplePhotoMsg = messages.get(qrOrders10[0].activeQrMessageId);
      const parsedPng = PNG.sync.read(samplePhotoMsg.buffer);
      const decodedQr = jsQR(new Uint8ClampedArray(parsedPng.data), parsedPng.width, parsedPng.height);
      ok(decodedQr?.data?.startsWith('upi://pay?pa=upiswiggy@icici'), 'Generated batch QR PNG decodes cleanly via jsQR camera scan');

      // 1D. 1-Click Simultaneous Payment Verification Across ALL 10 Active Orders (`fwd_check_all_paid`)!
      await clickButton('fwd_check_all_paid', qrOrders10[0].activeCardMessageId);
      const completed10 = Object.values(getDb().orders).filter(o => o.status === 'COMPLETED');
      ok(
        completed10.length === 10 && completed10.every(o =>
          o.cardStage === 'PAID_CONFIRMED' &&
          o.trackingLink === 'https://swig.gy/live-order-track-demo' &&
          o.trackingLinkSource === 'SWIGGY_API'
        ),
        `Simultaneous 10x Payment Confirmed: ALL 10/10 orders verified paid & received live Swiggy tracking links at once!`
      );

      for (const o of completed10) stopOrderPaymentPoller(o.id);
    } finally {
      globalThis.fetch = realFetch;
      clearAllAccountReservations();
      invalidateAccountOrderProfileCache();
    }
  }

  // ===========================================================================
  // PART 2: 100% REAL LIVE SWIGGY GATEWAY — ZERO-CLICK AUTO-ACCOUNT + MAX OFFER
  //         + PARALLEL REAL SWIGGY MERCHANT UPI QRs (`0` MOCKS, `0` CHROMIUM!)
  // ===========================================================================
  console.log('\n━━━ PART 2: 100% Real Live Swiggy Production Gateway — Simultaneous Zero-Click Auto-Select + Real QRs ━━━');
  saveDb(JSON.parse(rawDbBackup));
  {
    const db = getDb();
    const bossId = db.config.bossIds[0];
    db.orders = {};
    saveDb(db);

    const accA = db.config.accounts.acc_6296591407;
    const accB = db.config.accounts.acc_9935123518;
    await Promise.all([swiggyCartFlush(accA).catch(() => {}), swiggyCartFlush(accB).catch(() => {})]);

    // Check if MOJO Pizza Group Cart (`622166`) is open right now; if closed for maintenance, discover any live open Lucknow restaurant via MCP 24x7!
    let liveCartInput1 = 'https://swig.gy/gc/636724/Umbashiya-642855918';
    let liveCartInput2 = 'https://swig.gy/gc/636724/Umbashiya-642855918';
    const testAddr1 = 'House 12A, Hazratganj Main Market, Lucknow, Uttar Pradesh 226001, India';
    const testAddr2 = 'Flat 4B, Nirala Nagar Crossing, Daliganj, Lucknow, Uttar Pradesh 226020, India';

    let msgSeq = 3000;
    const messages = new Map();
    const actionHandlers = [];
    const mockTelegram = {
      async sendMessage(chatId, text, extra = {}) {
        const id = ++msgSeq;
        messages.set(id, { id, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
        return { message_id: id, chat: { id: chatId } };
      },
      async sendPhoto(chatId, photo, extra = {}) {
        const id = ++msgSeq;
        messages.set(id, { id, type: 'photo', buffer: photo?.source, caption: extra?.caption || '', keyboard: extra?.reply_markup?.inline_keyboard || [] });
        return { message_id: id, chat: { id: chatId } };
      },
      async deleteMessage(_chatId, messageId) {
        messages.delete(messageId);
        return true;
      },
      async editMessageText(_chatId, messageId, _inlineId, text, extra = {}) {
        messages.set(messageId, { id: messageId, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
        return true;
      }
    };
    const mockBot = { action: (pattern, fn) => actionHandlers.push({ pattern, fn }) };
    registerForwardedOrderHandlers(mockBot, {
      isBoss: (id) => Number(id) === Number(bossId),
      formatOrderBodyFn: renderBodyHtml
    });
    const makeCtx = ({ text = '', cbData = null, msgId = null }) => ({
      from: { id: bossId, first_name: 'Rahul', last_name: 'Boss' },
      chat: { id: bossId, type: 'private' },
      telegram: mockTelegram,
      message: text ? { text } : null,
      callbackQuery: cbData ? { data: cbData, message: { message_id: msgId } } : undefined,
      reply: (t, ex) => mockTelegram.sendMessage(bossId, t, ex),
      replyWithPhoto: (p, ex) => mockTelegram.sendPhoto(bossId, p, ex),
      editMessageText: (t, ex) => mockTelegram.editMessageText(bossId, msgId, undefined, t, ex),
      answerCbQuery: async () => true
    });
    const clickButton = async (cbData, msgId = 3001) => {
      for (const h of actionHandlers) {
        const m = cbData.match(h.pattern);
        if (m) {
          const ctx = makeCtx({ cbData, msgId });
          ctx.match = m;
          await h.fn(ctx);
          return;
        }
      }
      throw new Error(`No handler for ${cbData}`);
    };

    const liveGcUrl = 'https://swig.gy/gc/622166/Adithya-312184336';
    const liveAddr1 = 'Svr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India';
    const liveAddr2 = 'House 14, Lecturers Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India';

    clearAllAccountReservations();
    const cleanDb = getDb();
    cleanDb.orders = {};
    saveDb(cleanDb);

    const tLive = Date.now();
    await Promise.all([
      handleBossForwardedOrderInput(makeCtx({ text: `${liveAddr1}\n${liveGcUrl}` }), {
        rawText: `${liveAddr1}\n${liveGcUrl}`,
        formatOrderBodyFn: renderBodyHtml
      }),
      handleBossForwardedOrderInput(makeCtx({ text: `${liveAddr2}\n${liveGcUrl}` }), {
        rawText: `${liveAddr2}\n${liveGcUrl}`,
        formatOrderBodyFn: renderBodyHtml
      })
    ]);
    const liveMs = Date.now() - tLive;
    const liveOrders = Object.values(getDb().orders);

    ok(liveOrders.length === 2, `2 simultaneous live Boss inputs created 2 distinct orders (${liveOrders.map(o => o.id).join(', ')}) on MOJO Pizza (622166)`);
    ok(
      liveOrders.every(o => o.cardStage === 'BILL_READY' && o.finalPayable > 0),
      `Both live orders auto-selected distinct accounts & fetched real Swiggy bills in ${(liveMs / 1000).toFixed(2)}s (${liveOrders.map(o => `${o.selectedAccount}=₹${o.finalPayable}`).join(', ')})`
    );
    ok(
      liveOrders[0].selectedAccount !== liveOrders[1].selectedAccount,
      `Live Multi-ID Exclusive Lock Verified: ${liveOrders[0].selectedAccount} !== ${liveOrders[1].selectedAccount}`
    );

    await clickButton(`fwd_parallel_qrs_${liveOrders[0].id}`, liveOrders[0].activeCardMessageId);
    let afterQrOrders = Object.values(getDb().orders);
    const triedOpenRestIds = [];
    for (let attempt = 0; attempt < 5 && !afterQrOrders.every(o => /^upi:\/\/pay\?.*swiggy/i.test(o.pendingSwiggyUpiUri || '')); attempt++) {
      // Past 2:00 AM IST `MOJO Pizza (622166)` closes — sync both orders in parallel on real 24x7 OPEN restaurant & generate both QRs in parallel!
      const retryDb = getDb();
      const retryOrders = Object.values(retryDb.orders);
      const openSpec = await discoverOpen24x7RestaurantOrder(accA, {
        excludeRestaurantIds: triedOpenRestIds
      });
      if (!openSpec) break;
      triedOpenRestIds.push(openSpec.restaurantId);
      for (const o of retryOrders) {
        Object.assign(o, openSpec);
        delete o.groupCartId;
        delete o.cart;
      }
      await Promise.all(
        retryOrders.map(o => syncGroupCartAndCheckoutForAccount(retryDb.config.accounts[o.selectedAccount], o, { captureScreenshot: false }))
      );
      saveDb(retryDb);
      await clickButton(`fwd_parallel_qrs_${retryOrders[0].id}`, retryOrders[0].activeCardMessageId);
      afterQrOrders = Object.values(getDb().orders);
    }
    ok(
      afterQrOrders.every(o => /^upi:\/\/pay\?.*swiggy/i.test(o.pendingSwiggyUpiUri || '')) &&
      afterQrOrders[0].pendingSwiggyOrderId !== afterQrOrders[1].pendingSwiggyOrderId,
      `Generated 2 DISTINCT 100% REAL Swiggy Merchant Dynamic QRs simultaneously (${afterQrOrders[0].pendingSwiggyOrderId} & ${afterQrOrders[1].pendingSwiggyOrderId})!`
    );

    // Cleanly cancel both test orders, flush carts, & verify zero Chromium launches across the entire suite!
    await Promise.all(afterQrOrders.map(o => clickButton(`fwd_cancel_${o.id}`, o.activeCardMessageId)));
    await Promise.allSettled([swiggyCartFlush(accA), swiggyCartFlush(accB)]);
    ok(chromiumLaunches === 0, `Strictly ZERO Headless Chromium launches across entire 10x + Live Swiggy E2E (${chromiumLaunches})`);
  }

  console.log(`\n========================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} V14 10x PARALLEL + 0-ORDER + MAX OFFER E2E ASSERTIONS PASSED!`);
  console.log(`========================================================================`);
} finally {
  clearAllAccountReservations();
  invalidateAccountOrderProfileCache();
  saveDb(JSON.parse(rawDbBackup));
}
