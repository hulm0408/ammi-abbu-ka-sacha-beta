import assert from 'node:assert/strict';
import { discoverOpen24x7RestaurantOrder } from './test-live-open-cart-helper.mjs';
import { syncGroupCartAndCheckoutForAccount } from './swiggy-cart.js';
import fs from 'node:fs';
import { getDb, saveDb } from './store.js';
import { dapiFetch, inspectCartForAccount, parseAddressDetails, swiggyCartFlush } from './swiggy-cart.js';
import {
  looksLikeBossOrderInput,
  handleBossForwardedOrderInput,
  registerForwardedOrderHandlers
} from './forwarded-order-flow.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ [PASS ${String(passed).padStart(2, '0')}] ${msg}`);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderBodyHtml(order, isBossView = false) {
  const db = getDb();
  const selectedAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const accPhone = order.orderAccount || selectedAcc?.phone || selectedAcc?.mobile || null;
  const restName = order.restaurantName || order.restaurant || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : '');

  const ad = order.addressDetails || parseAddressDetails(order.address);
  let addrSection = '';
  if (ad && (ad.name || ad.mobile || ad.address || ad.city || ad.lat)) {
    const cityHeader = ad.city ? `${escapeHtml(ad.city)} Address` : 'Delivery Address';
    addrSection += `<b>${cityHeader}</b>\n`;
    if (ad.name) addrSection += `${escapeHtml(ad.name)}\n`;
    if (ad.mobile) addrSection += `<a href="tel:${escapeHtml(ad.mobile)}">${escapeHtml(ad.mobile)}</a>\n`;
    if (ad.address) {
      for (const ln of String(ad.address).split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        addrSection += `${escapeHtml(ln)}\n`;
      }
    }
    if (ad.lat) addrSection += `Latitude: ${escapeHtml(String(ad.lat))}\n`;
    if (ad.lng) addrSection += `Longitude: ${escapeHtml(String(ad.lng))}\n`;
    addrSection += `Select an Available Payment Method\n`;
  }

  let itemsSection = '\n';
  if (order.items?.length > 0) {
    itemsSection = '\n' + order.items.map((it, idx) => `${idx + 1}️⃣ ${escapeHtml(it.name)}\n💵 ₹${it.price} × ${it.qty} = ₹${it.lineTotal}`).join('\n\n') + '\n\n';
  }

  let billSection = `<b>Final Bill</b>\nItems Total: ₹${order.subtotal || 0}\n`;
  if (order.couponCode && order.discountAmount > 0) billSection += `Coupon ${escapeHtml(order.couponCode)}: −₹${order.discountAmount}\n`;
  if (Number(order.swiggyOneMembershipFee || 0) > 0) billSection += `Swiggy One Lite Membership: +₹${order.swiggyOneMembershipFee}\n`;
  const savedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
  if (Number(order.deliveryFee || 0) <= 0 && (order.swiggyOneApplied || savedDel > 0)) {
    billSection += `Free Delivery upto 7km\nDelivery Fee: FREE${savedDel > 0 ? ` (₹${savedDel} saved)` : ''}\n`;
  } else if (Number(order.deliveryFee || 0) > 0) {
    billSection += `Delivery Fee: ₹${order.deliveryFee}\n`;
  } else {
    billSection += `Delivery Fee: FREE\n`;
  }
  if (order.packingCharges > 0) billSection += `Packing Charges: ₹${order.packingCharges}\n`;
  if (order.taxesAndCharges > 0) billSection += `GST &amp; Other Charges: ₹${order.taxesAndCharges}\n`;
  billSection += `━━━━━━━━━━━━━━\n`;
  if (order.totalSavings > 0) billSection += `Total Savings: ₹${order.totalSavings}\n`;
  billSection += `<b>Final Total: ₹${order.finalPayable || 0}</b>`;

  return ((isBossView && accPhone) ? `📱 <b>Order Account:</b> ${escapeHtml(accPhone)}\n` : '') +
    (restName ? `🛒 <b>Your Cart:</b> ${escapeHtml(restName)}\n\n` : '') +
    addrSection + itemsSection + billSection;
}

const originalDbRaw = fs.readFileSync('./data/db.json', 'utf8');

try {
  console.log('================================================================');
  console.log('🧪 100% REAL SWIGGY GATEWAY E2E: DIRECT BOSS + FORWARDED IB + REAL MERCHANT QR + REAL TRACKING + AI-DIAG');
  console.log('================================================================\n');

  const db = getDb();
  const bossId = db.config.bossIds[0];
  const accLive = db.config.accounts.acc_6296591407;
  const accHelper = db.config.accounts.acc_9935123518;
  const beforeLiveCart = await inspectCartForAccount(accLive);

  let nextMsgId = 100;
  const messages = new Map();
  const deletedIds = [];
  const cbAlerts = [];
  const actionHandlers = [];

  const mockTelegram = {
    async sendMessage(chatId, text, extra = {}) {
      const id = ++nextMsgId;
      const entry = { id, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] };
      messages.set(id, entry);
      return { message_id: id, chat: { id: chatId } };
    },
    async deleteMessage(chatId, messageId) {
      deletedIds.push(messageId);
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

  // ZERO MOCKS ON QR OR SWIGGY TRACKING — 100% REAL LIVE SWIGGY API CALLS!
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
      async reply(text, extra = {}) {
        const id = ++nextMsgId;
        const entry = { id, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] };
        messages.set(id, entry);
        return { message_id: id, chat: { id: bossId } };
      },
      async replyWithPhoto(photo, extra = {}) {
        const id = ++nextMsgId;
        const entry = {
          id,
          type: 'photo',
          buffer: photo?.source,
          caption: extra?.caption || '',
          keyboard: extra?.reply_markup?.inline_keyboard || []
        };
        messages.set(id, entry);
        return { message_id: id, chat: { id: bossId }, photo: [{ file_id: `qr_file_${id}` }] };
      },
      async editMessageText(text, extra = {}) {
        const id = msgIdForCb;
        messages.set(id, { id, type: 'text', text, keyboard: extra?.reply_markup?.inline_keyboard || [] });
        return true;
      },
      async answerCbQuery(text = '', opts = {}) {
        cbAlerts.push({ text, showAlert: Boolean(opts?.show_alert) });
        return true;
      }
    };
  }

  async function clickButton(cbData, msgId) {
    for (const h of actionHandlers) {
      const m = cbData.match(h.pattern);
      if (m) {
        const ctx = makeCtx({ cbData, msgIdForCb: msgId });
        ctx.match = m;
        await h.fn(ctx);
        return;
      }
    }
    throw new Error(`No handler matched callback: ${cbData}`);
  }

  const flatButtons = (msg) => (msg?.keyboard || []).flat().map(b => b.text);
  const flatCallbacks = (msg) => (msg?.keyboard || []).flat().map(b => b.callback_data).filter(Boolean);

  // =========================================================================
  // PART A: BOSS SENDS NORMALLY FROM HIS OWN ACCOUNT (NOT FORWARDED!)
  // =========================================================================
  const bossDirectAddr = 'Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/j37ai838.\n\nAddress: Svr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India';
  const bossDirectCart = 'https://swig.gy/gc/622166/Adithya-312184336';

  ok(looksLikeBossOrderInput(bossDirectAddr) && looksLikeBossOrderInput(bossDirectCart), 'Direct Boss detector recognizes both Address share & Group Cart link');
  ok(!looksLikeBossOrderInput('/start') && !looksLikeBossOrderInput('Order Screen'), 'Direct Boss detector ignores normal bot commands & admin buttons');

  // 1. Boss sends Address NORMALLY (no forward_origin!) -> Card #101 created under "Rahul Boss"
  await handleBossForwardedOrderInput(makeCtx({ message: { text: bossDirectAddr } }), {
    rawText: bossDirectAddr,
    formatOrderBodyFn: renderBodyHtml
  });
  const bossCard1 = messages.get(101);
  ok(
    Boolean(bossCard1) &&
    bossCard1.text.includes('Order For:') &&
    bossCard1.text.includes('Rahul Boss') &&
    flatButtons(bossCard1).includes('❌ Cancel Order'),
    'Boss Direct Send #1: Card #101 created under Boss\'s OWN name ("Rahul Boss") with [ ❌ Cancel Order ]'
  );

  // 2. Simultaneously, Boss FORWARDS a message from "Ammi" -> Card #102 created under "Ammi" WITHOUT deleting Boss's personal Card #101!
  const ammiFwdAddr = {
    text: bossDirectAddr,
    forward_origin: { type: 'user', sender_user: { id: 7770001, first_name: 'Ammi', username: 'ammi_home' } }
  };
  await handleBossForwardedOrderInput(makeCtx({ message: ammiFwdAddr }), {
    rawText: ammiFwdAddr.text,
    formatOrderBodyFn: renderBodyHtml
  });
  const ammiCard1 = messages.get(102);
  ok(
    messages.has(101) &&
    Boolean(ammiCard1) &&
    ammiCard1.text.includes('Forwarded From:') &&
    ammiCard1.text.includes('Ammi') &&
    flatButtons(ammiCard1).includes('❌ Cancel Order'),
    'Forwarded IB Send: Card #102 created under "Ammi" while keeping Boss\'s personal Card #101 untouched!'
  );

  // 3. Boss now sends his Cart link NORMALLY -> ONLY Boss's old Card #101 is deleted & upgraded to Choose Account Card #103 (explicit manual picker check)!
  await handleBossForwardedOrderInput(makeCtx({ message: { text: bossDirectCart } }), {
    rawText: bossDirectCart,
    formatOrderBodyFn: renderBodyHtml,
    autoSelectAccount: false
  });
  ok(
    deletedIds.includes(101) && !messages.has(101) && messages.has(102) && messages.has(103),
    'Boss Direct Send #2: Boss\'s old incomplete Card #101 auto-deleted & upgraded to Choose Account Card #103!'
  );

  const bossPickAcc = flatCallbacks(messages.get(103)).find(c => c.endsWith('__acc_9935123518'));
  const bossOrderId = bossPickAcc.split('__')[0].replace('fwd_pick_acc_', '');

  // =========================================================================
  // PART B: LIVE SWIGGY ACCOUNT FETCH -> 100% REAL SWIGGY MERCHANT DYNAMIC QR
  // =========================================================================
  await clickButton(bossPickAcc, 103);
  const billCardId = getDb().orders[bossOrderId].activeCardMessageId;
  const bossBillCard = messages.get(billCardId);
  ok(
    deletedIds.includes(103) &&
    Boolean(bossBillCard) &&
    bossBillCard.text.includes('Rahul Boss') &&
    bossBillCard.text.includes('Final Bill') &&
    flatButtons(bossBillCard).includes('🔳 Generate QR') &&
    flatButtons(bossBillCard).includes('✅ Paid') &&
    flatButtons(bossBillCard).includes('❌ Cancel Order'),
    'Live Swiggy Bill Fetched on Bill Card with [ 🔳 Generate QR ], [ ✅ Paid ], & [ ❌ Cancel Order ]'
  );

  // Click `[ 🔳 Generate QR ]` -> HITS REAL `https://payments.swiggy.com/api/v3/order/place`!
  await clickButton(`fwd_gen_qr_${bossOrderId}`, billCardId);
  let storedOrder = getDb().orders[bossOrderId];
  if (!storedOrder.pendingSwiggyUpiUri) {
    // Past 2:00 AM IST `MOJO Pizza (622166)` closes — seamlessly switch order to live 24x7 OPEN restaurant via MCP & re-click QR!
    const acc99 = getDb().config.accounts.acc_9935123518;
    const openSpec = await discoverOpen24x7RestaurantOrder(acc99);
    const liveDb = getDb();
    Object.assign(liveDb.orders[bossOrderId], openSpec);
    delete liveDb.orders[bossOrderId].groupCartId;
    delete liveDb.orders[bossOrderId].cart;
    await syncGroupCartAndCheckoutForAccount(acc99, liveDb.orders[bossOrderId], { captureScreenshot: false });
    saveDb(liveDb);
    await clickButton(`fwd_gen_qr_${bossOrderId}`, liveDb.orders[bossOrderId].activeCardMessageId);
    storedOrder = getDb().orders[bossOrderId];
  }
  const qrMsgId = storedOrder.activeQrMessageId;
  const realQrMsg = messages.get(qrMsgId);
  console.log('\n--- LIVE REAL SWIGGY MERCHANT QR GENERATED ---');
  console.log('Swiggy Order ID:', storedOrder.pendingSwiggyOrderId);
  console.log('Swiggy PaaS Txn ID:', storedOrder.pendingSwiggyPaasId);
  console.log('Real Merchant UPI URI:', storedOrder.pendingSwiggyUpiUri);
  console.log('----------------------------------------------\n');

  ok(
    /^upi:\/\/pay\?.*swiggy/i.test(storedOrder.pendingSwiggyUpiUri || '') &&
    !storedOrder.pendingSwiggyUpiUri.includes('6296591407@ybl') &&
    /^\d{10,20}$/.test(storedOrder.pendingSwiggyOrderId) &&
    /^\d{10,20}$/.test(storedOrder.pendingSwiggyPaasId) &&
    Buffer.isBuffer(realQrMsg?.buffer) &&
    realQrMsg.buffer.length > 10000,
    `100% REAL Official Swiggy Merchant Dynamic UPI QR generated (${storedOrder.pendingSwiggyUpiUri.slice(0, 62)}...)!`
  );

  // =========================================================================
  // PART C: LIVE UNPAID CHECK -> SAYS "Payment is processing" ON REAL GATEWAY!
  // =========================================================================
  cbAlerts.length = 0;
  await clickButton(`fwd_check_paid_${bossOrderId}`, billCardId);
  ok(
    cbAlerts.some(a => /Payment is processing/i.test(a.text)) &&
    messages.has(billCardId) &&
    messages.has(qrMsgId),
    'Live Swiggy Gateway Unpaid Check: returns "Payment is processing" & keeps Bill Card + Real QR active!'
  );

  // =========================================================================
  // PART D: LIVE PAID ORDER & REAL `order/trackV4` EXTRACTION ON SWIGGY!
  // Verify against real paid Swiggy order `250070826195484` on `acc_9935123518`!
  // =========================================================================
  {
    const liveDb = getDb();
    liveDb.orders[bossOrderId].pendingSwiggyOrderId = '250070826195484';
    liveDb.orders[bossOrderId].pendingSwiggyPaasId = '';
    liveDb.orders[bossOrderId].baselineSwiggyOrderId = '';
    saveDb(liveDb);
  }
  await clickButton(`fwd_check_paid_${bossOrderId}`, billCardId);

  ok(deletedIds.includes(billCardId) && deletedIds.includes(qrMsgId), 'Upon verified Swiggy payment: BOTH old Bill Card & Real QR auto-deleted!');
  const paidCardId = getDb().orders[bossOrderId].activeCardMessageId;
  const paidTrackCard = messages.get(paidCardId);
  console.log('\n--- REAL SWIGGY PAID + LIVE TRACKING CARD (#106) ---\n' + paidTrackCard.text + '\n----------------------------------------------------\n');

  ok(
    Boolean(paidTrackCard) &&
    paidTrackCard.text.includes('Rahul Boss') &&
    paidTrackCard.text.includes('250070826195484') &&
    paidTrackCard.text.includes('Order Delivered') &&
    paidTrackCard.text.includes('SurajKumar Kumar') &&
    paidTrackCard.text.includes('/track/' + bossOrderId) &&
    paidTrackCard.text.includes('https://www.swiggy.com/track-order/250070826195484') &&
    flatButtons(paidTrackCard).includes('❌ Cancel Order'),
    'Confirmed Card #106 extracted 100% REAL Swiggy Order Status ("Order Delivered"), Rider Name ("SurajKumar Kumar"), Shareable Live Map Link & Direct Swiggy Track Link!'
  );

  // =========================================================================
  // PART E: INSTANT SELF-CONTAINED `[AI-DIAG]` ERROR MESSAGE ON FAILURE!
  // =========================================================================
  const expiredCartMsg = { text: 'https://swig.gy/gc/67272/Umbashiya-142853973' };
  await handleBossForwardedOrderInput(makeCtx({ message: expiredCartMsg }), {
    rawText: expiredCartMsg.text,
    formatOrderBodyFn: renderBodyHtml
  });
  const diagMsg = Array.from(messages.values()).pop();
  console.log('\n--- INSTANT BOSS AI DIAGNOSTIC MESSAGE ---\n' + diagMsg.text + '\n------------------------------------------\n');
  ok(
    Boolean(diagMsg) &&
    diagMsg.text.includes('[AI-DIAG]') &&
    diagMsg.text.includes('code: GROUP_CART_EXPIRED') &&
    diagMsg.text.includes('stage: INGEST_LINK_OR_ADDRESS'),
    'Any error immediately sends Boss a copyable [AI-DIAG] diagnostic card with exact error code, stage & link!'
  );

  // Cancel Ammi's incomplete card (#102) via `[ ❌ Cancel Order ]`
  const ammiCancelCb = flatCallbacks(messages.get(102)).find(c => c.startsWith('fwd_cancel_'));
  await clickButton(ammiCancelCb, 102);
  const cancelConfirmMsg = Array.from(messages.values()).pop();
  ok(deletedIds.includes(102) && cancelConfirmMsg?.text.includes('Order Cancelled'), 'Ammi\'s card cancelled cleanly via [ ❌ Cancel Order ]');

  // Cleanup live helper cart & verify both accounts clean!
  await swiggyCartFlush(accHelper).catch(() => {});

  const afterLiveCart = await inspectCartForAccount(accLive);
  const afterHelperCart = await inspectCartForAccount(accHelper);
  ok(
    (!afterHelperCart?.items || afterHelperCart.items.length === 0) &&
    afterLiveCart?.restaurantName === beforeLiveCart?.restaurantName,
    `Cleanup verified: acc_9935123518 empty & acc_6296591407 (${afterLiveCart?.restaurantName}) completely untouched!`
  );

  console.log(`\n================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} REAL SWIGGY QR + LIVE TRACKING + DIRECT/FWD + AI-DIAG TESTS PASSED!`);
  console.log(`================================================================`);
} finally {
  fs.writeFileSync('./data/db.json', originalDbRaw, 'utf8');
}
