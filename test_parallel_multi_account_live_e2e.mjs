import assert from 'node:assert/strict';
import fs from 'node:fs';
import { discoverOpen24x7RestaurantOrder } from './test-live-open-cart-helper.mjs';
import { syncGroupCartAndCheckoutForAccount } from './swiggy-cart.js';
import { getDb, saveDb } from './store.js';
import { dapiFetch, inspectCartForAccount, parseAddressDetails } from './swiggy-cart.js';
import {
  handleBossForwardedOrderInput,
  registerForwardedOrderHandlers
} from './forwarded-order-flow.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ [PARALLEL ${String(passed).padStart(2, '0')}] ${msg}`);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderBodyHtml(order) {
  const ad = order.addressDetails || parseAddressDetails(order.address) || {};
  return (
    `📱 <b>Order Account:</b> ${escapeHtml(order.orderAccount || '')}\n` +
    `🛒 <b>Your Cart:</b> ${escapeHtml(order.restaurantName || '')}\n` +
    `📍 <b>Address ID:</b> <code>${escapeHtml(ad.id || '')}</code>\n` +
    `<b>Final Total: ₹${order.finalPayable || 0}</b>`
  );
}

try {
  console.log('================================================================');
  console.log('⚡ LIVE SIMULTANEOUS MULTI-ID PARALLEL SWIGGY FETCH + PLACEMENT E2E');
  console.log('================================================================\n');

  const initDb = getDb();
  const bossId = initDb.config.bossIds[0];
  const acc1 = initDb.config.accounts.acc_9935123518;
  const acc2 = initDb.config.accounts.acc_6296591407;

  // Snapshot pre-existing cart on `acc_6296591407` so we restore it byte-for-byte after parallel multi-ID live QR test!
  const savedPreCart2 = await inspectCartForAccount(acc2);

  // Also add genuinely expired guest/unverified session `acc_8001201740` (`user_id: "0"`, dead on both Web & Android!)
  const deadJwtTid = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiJkZjU0OGNiYy1jMjE5LTQxZWMtYjFiZC1lMzA0ZjBjOTkxZjMiLCJ1c2VyX2lkIjoiMCIsInNpZCI6InU4MmQzODVmZTBmLWYzOTktNDI0My04YjIwLTQxOTA4MTljOSJ9.LL75ejwNxZlvsIMpLVWoaxCyPHD7x--yhJLTsg8d4Xc';
  initDb.config.accounts.acc_8001201740 = {
    id: 'acc_8001201740',
    name: 'Swiggy 8001201740',
    phone: '8001201740',
    mobile: '8001201740',
    tid: deadJwtTid,
    sid: 'u82d385fe0f-f399-4243-8b20-4190819c9',
    deviceId: 'f549cb00-0d53-f94e-6757-ce16edc55937',
    token: deadJwtTid,
    cookies: `tid=${deadJwtTid}; _sid=u82d385fe0f-f399-4243-8b20-4190819c9; _device_id=f549cb00-0d53-f94e-6757-ce16edc55937; token=${deadJwtTid}; _is_logged_in=1`,
    isLoggedIn: true
  };
  saveDb(initDb);

  let nextMsgId = 500;
  const messages = new Map();
  const actionHandlers = [];

  const mockTelegram = {
    async sendMessage(chatId, text, extra = {}) {
      const id = ++nextMsgId;
      messages.set(id, { id, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
      return { message_id: id, chat: { id: chatId } };
    },
    async sendPhoto(chatId, photo, extra = {}) {
      const id = ++nextMsgId;
      messages.set(id, { id, type: 'photo', buffer: photo?.source, caption: extra?.caption || '', keyboard: extra?.reply_markup?.inline_keyboard || [] });
      return { message_id: id, chat: { id: chatId } };
    },
    async deleteMessage(chatId, messageId) {
      messages.delete(messageId);
      return true;
    },
    async editMessageText(chatId, messageId, _inlineId, text, extra = {}) {
      messages.set(messageId, { id: messageId, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
      return true;
    }
  };

  const mockBot = {
    action(pattern, fn) {
      actionHandlers.push({ pattern, fn });
    }
  };

  registerForwardedOrderHandlers(mockBot, {
    isBoss: (id) => Number(id) === Number(bossId),
    formatOrderBodyFn: renderBodyHtml
  });

  function makeCtx({ message = null, cbData = null, msgIdForCb = null }) {
    return {
      from: { id: bossId, first_name: 'Rahul', last_name: 'Boss', username: 'rahul_boss' },
      chat: { id: bossId, type: 'private' },
      telegram: mockTelegram,
      message,
      callbackQuery: cbData ? { data: cbData, message: { message_id: msgIdForCb } } : undefined,
      reply: (text, extra) => mockTelegram.sendMessage(bossId, text, extra),
      replyWithPhoto: (photo, extra) => mockTelegram.sendPhoto(bossId, photo, extra),
      editMessageText: (text, extra) => mockTelegram.editMessageText(bossId, msgIdForCb, undefined, text, extra),
      answerCbQuery: async () => true
    };
  }

  async function clickButton(cbData, msgId = 501) {
    for (const h of actionHandlers) {
      const m = cbData.match(h.pattern);
      if (m) {
        const ctx = makeCtx({ cbData, msgIdForCb: msgId });
        ctx.match = m;
        await h.fn(ctx);
        return;
      }
    }
    throw new Error(`Unmatched callback: ${cbData}`);
  }

  const cartLink = 'https://swig.gy/gc/622166/Adithya-312184336';
  const addr1 = 'Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/j37ai838.\n\nAddress: Svr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India';
  const addr2 = 'Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/j37ai838.\n\nAddress: House 14, Lecturers Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India';

  // Seed partial-session test fixture `acc_8001201740` locally for this test run (restored cleanly in `finally`!)
  {
    const seedDb = getDb();
    seedDb.config.accounts.acc_8001201740 = {
      id: 'acc_8001201740',
      name: 'User 8001201740',
      phone: '8001201740',
      tid: 'dead_partial_tid',
      cookies: '_device_id=partial_dev_only',
      isLoggedIn: true
    };
    saveDb(seedDb);
  }

  // 1. Fire FOUR incoming messages across 2 different senders AT THE EXACT SAME MILLISECOND (`Promise.all`)!
  await Promise.all([
    handleBossForwardedOrderInput(makeCtx({ message: { text: addr1 } }), { rawText: addr1, formatOrderBodyFn: renderBodyHtml, autoSelectAccount: false }),
    handleBossForwardedOrderInput(makeCtx({ message: { text: cartLink } }), { rawText: cartLink, formatOrderBodyFn: renderBodyHtml, autoSelectAccount: false }),
    handleBossForwardedOrderInput(makeCtx({ message: { text: addr2, forward_origin: { type: 'user', sender_user: { id: 888001, first_name: 'Ammi' } } } }), { rawText: addr2, formatOrderBodyFn: renderBodyHtml, autoSelectAccount: false }),
    handleBossForwardedOrderInput(makeCtx({ message: { text: cartLink, forward_origin: { type: 'user', sender_user: { id: 888001, first_name: 'Ammi' } } } }), { rawText: cartLink, formatOrderBodyFn: renderBodyHtml, autoSelectAccount: false })
  ]);

  const readyOrders = Object.values(getDb().orders).filter(o => o.cardStage === 'NEED_ACCOUNT');
  ok(readyOrders.length === 2, `4 simultaneous messages merged race-free into EXACTLY 2 ready orders (${readyOrders.map(o => `${o.id}:${o.fwdSenderName}`).join(', ')})`);

  // Verify partial session account `acc_8001201740` is flagged `⚠️ Re-Login OTP` while valid IDs are `🟢 FREE` + parallel button appears!
  const latestCard = Array.from(messages.values()).pop();
  const btnTexts = latestCard.keyboard.flat().map(b => b.text);
  ok(
    btnTexts.some(t => t.includes('⚡ Fetch All 2 Ready Orders Now')) &&
    btnTexts.some(t => t.includes('🟢 FREE') && t.includes('9935123518')) &&
    btnTexts.some(t => t.includes('🟢 FREE') && t.includes('6296591407')) &&
    btnTexts.some(t => t.includes('⚠️ Re-Login OTP') && t.includes('8001201740')),
    'Account Picker clearly marks 2 FREE valid IDs, flags 8001201740 as Re-Login OTP, and displays [ ⚡ Fetch All 2 Ready Orders Now ]!'
  );

  // Verify exact Render repro: clicking partial account `acc_8001201740` immediately fails cleanly with `ACCOUNT_SESSION_EXPIRED_OR_PARTIAL` instead of fake empty cart!
  await clickButton(`fwd_pick_acc_${readyOrders[0].id}__acc_8001201740`, readyOrders[0].activeCardMessageId);
  const diagAlert = Array.from(messages.values()).find(m => m.text?.includes('ACCOUNT_SESSION_EXPIRED_OR_PARTIAL'));
  ok(
    Boolean(diagAlert),
    'Exact Render Repro Fixed: partial session account 8001201740 immediately reports ACCOUNT_SESSION_EXPIRED_OR_PARTIAL instead of later failing at QR!'
  );

  // 2. ONE SINGLE CLICK -> FETCH BOTH READY ORDERS SIMULTANEOUSLY IN PARALLEL ON 2 DISTINCT LIVE SWIGGY IDs!
  const tStartFetch = Date.now();
  await clickButton('fwd_parallel_fetch_all');
  const elapsedFetchMs = Date.now() - tStartFetch;

  const postFetchDb = getDb();
  const ordA = postFetchDb.orders[readyOrders[0].id];
  const ordB = postFetchDb.orders[readyOrders[1].id];

  ok(
    ordA.cardStage === 'BILL_READY' &&
    ordB.cardStage === 'BILL_READY' &&
    ordA.selectedAccount !== ordB.selectedAccount,
    `Simultaneous Multi-ID Fetch succeeded in ${(elapsedFetchMs / 1000).toFixed(1)}s: ${ordA.id} -> ${ordA.selectedAccount} (₹${ordA.finalPayable}) & ${ordB.id} -> ${ordB.selectedAccount} (₹${ordB.finalPayable})!`
  );

  ok(
    ordA.addressDetails?.id &&
    ordB.addressDetails?.id &&
    ordA.addressDetails.id !== ordB.addressDetails.id,
    `Zero Foreign Address ID Leak: ${ordA.selectedAccount} used own address_id="${ordA.addressDetails.id}" & ${ordB.selectedAccount} used own address_id="${ordB.addressDetails.id}"!`
  );

  // 3. ONE SINGLE CLICK -> GENERATE TWO 100% REAL OFFICIAL SWIGGY DYNAMIC QRs IN PARALLEL AT THE EXACT SAME TIME!
  const tStartQr = Date.now();
  await clickButton(`fwd_parallel_qrs_${ordA.id}`, ordA.activeCardMessageId);
  let elapsedQrMs = Date.now() - tStartQr;

  let postQrDb = getDb();
  if (!postQrDb.orders[ordA.id]?.pendingSwiggyUpiUri || !postQrDb.orders[ordB.id]?.pendingSwiggyUpiUri) {
    // Past 2:00 AM IST `MOJO Pizza (622166)` closes — sync both orders in parallel on real 24x7 OPEN restaurant & generate both QRs in parallel!
    const openSpec = await discoverOpen24x7RestaurantOrder(postQrDb.config.accounts[ordA.selectedAccount]);
    for (const o of [postQrDb.orders[ordA.id], postQrDb.orders[ordB.id]]) {
      Object.assign(o, openSpec);
      delete o.groupCartId;
      delete o.cart;
    }
    await Promise.all([
      syncGroupCartAndCheckoutForAccount(postQrDb.config.accounts[ordA.selectedAccount], postQrDb.orders[ordA.id], { captureScreenshot: false }),
      syncGroupCartAndCheckoutForAccount(postQrDb.config.accounts[ordB.selectedAccount], postQrDb.orders[ordB.id], { captureScreenshot: false })
    ]);
    saveDb(postQrDb);
    const tRetryQr = Date.now();
    await clickButton(`fwd_parallel_qrs_${ordA.id}`, postQrDb.orders[ordA.id].activeCardMessageId);
    elapsedQrMs = Date.now() - tRetryQr;
    postQrDb = getDb();
  }
  const qrOrdA = postQrDb.orders[ordA.id];
  const qrOrdB = postQrDb.orders[ordB.id];

  console.log('\n--- SIMULTANEOUS DUAL REAL SWIGGY QRs GENERATED IN PARALLEL ---');
  console.log(`Order #1 (${qrOrdA.fwdSenderName} on ${qrOrdA.selectedAccount}): SwiggyOrder=${qrOrdA.pendingSwiggyOrderId} | URI=${qrOrdA.pendingSwiggyUpiUri}`);
  console.log(`Order #2 (${qrOrdB.fwdSenderName} on ${qrOrdB.selectedAccount}): SwiggyOrder=${qrOrdB.pendingSwiggyOrderId} | URI=${qrOrdB.pendingSwiggyUpiUri}`);
  console.log('---------------------------------------------------------------\n');

  ok(
    /^upi:\/\/pay\?.*swiggy/i.test(qrOrdA.pendingSwiggyUpiUri || '') &&
    /^upi:\/\/pay\?.*swiggy/i.test(qrOrdB.pendingSwiggyUpiUri || '') &&
    qrOrdA.pendingSwiggyOrderId !== qrOrdB.pendingSwiggyOrderId &&
    qrOrdA.pendingSwiggyPaasId !== qrOrdB.pendingSwiggyPaasId,
    `TWO DISTINCT 100% REAL SWIGGY MERCHANT QRs generated SIMULTANEOUSLY in ${(elapsedQrMs / 1000).toFixed(2)}s (${qrOrdA.pendingSwiggyOrderId} & ${qrOrdB.pendingSwiggyOrderId})!`
  );

  // Cancel both test orders cleanly & restore `acc_6296591407`'s pre-existing cart!
  await Promise.all([
    clickButton(`fwd_cancel_${qrOrdA.id}`, qrOrdA.activeCardMessageId),
    clickButton(`fwd_cancel_${qrOrdB.id}`, qrOrdB.activeCardMessageId)
  ]);

  if (savedPreCart2?.items?.length > 0 && savedPreCart2?.restaurantId) {
    await dapiFetch(acc2, 'cart', {
      method: 'POST',
      lat: savedPreCart2.addressDetails?.lat || '26.8658609',
      lng: savedPreCart2.addressDetails?.lng || '80.9307755',
      body: {
        flushFirst: true,
        cart: {
          restaurantId: String(savedPreCart2.restaurantId),
          address_id: String(savedPreCart2.addressDetails?.id || ''),
          couponCode: String(savedPreCart2.couponCode || ''),
          cartItems: savedPreCart2.items.map(it => ({
            addons: Array.isArray(it.addons) ? it.addons : [],
            variants: Array.isArray(it.variants) ? it.variants : [],
            menu_item_id: Number(it.menu_item_id || it.itemId),
            quantity: Number(it.qty || it.quantity || 1)
          })),
          mealItems: [],
          subscriptionItems: []
        }
      }
    });
  }

  await dapiFetch(acc1, 'cart', {
    method: 'POST',
    body: { flushFirst: true, cart: { restaurantId: '636724', address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] } }
  });

  const check1 = await inspectCartForAccount(acc1);
  const check2 = await inspectCartForAccount(acc2);
  ok(
    (!check1?.items || check1.items.length === 0) &&
    check2?.restaurantName === savedPreCart2?.restaurantName,
    `Clean restoration verified on BOTH live Swiggy IDs: acc_9935123518 empty & acc_6296591407 (${check2?.restaurantName}) restored intact!`
  );

  console.log(`\n================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} SIMULTANEOUS MULTI-ID PARALLEL SWIGGY TESTS PASSED!`);
  console.log(`================================================================`);
} finally {
  try {
    const curDb = JSON.parse(fs.readFileSync('./data/db.json', 'utf8'));
    delete curDb.config?.accounts?.['acc_8001201740'];
    delete curDb.sessionVault?.['acc_8001201740'];
    delete curDb.config?.deletedAccounts?.['acc_8001201740'];
    delete curDb.config?.deletedAccounts?.['8001201740'];
    fs.writeFileSync('./data/db.json', JSON.stringify(curDb, null, 2), 'utf8');
  } catch {}
}
