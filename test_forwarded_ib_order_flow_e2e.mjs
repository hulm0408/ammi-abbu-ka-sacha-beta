import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDb } from './store.js';
import { dapiFetch, inspectCartForAccount, getSwiggySessionAuth, parseAddressDetails } from './swiggy-cart.js';
import {
  extractForwardSenderInfo,
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

// Identical formatter matching `formatUserOrderCardText` in index.js
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
  console.log('🧪 LIVE E2E SUITE: BOSS FORWARDED IB MESSAGE -> LIVE CARD -> QR -> PAID/TRACKING -> CANCEL');
  console.log('================================================================\n');

  const db = getDb();
  const bossId = db.config.bossIds[0];
  const accLive = db.config.accounts.acc_6296591407;
  const accHelper = db.config.accounts.acc_9935123518;
  const beforeLiveCart = await inspectCartForAccount(accLive);

  // Mock Telegram chat harness tracking every sent, edited & deleted message + button keyboards + alerts
  let nextMsgId = 100;
  const messages = new Map();
  const deletedIds = [];
  const cbAlerts = [];
  const actionHandlers = [];
  let simulatedNewSwiggyOrder = null;

  const mockTelegram = {
    async deleteMessage(chatId, messageId) {
      deletedIds.push(messageId);
      messages.delete(messageId);
      return true;
    },
    async editMessageText(chatId, messageId, _inlineId, text, extra) {
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
    formatOrderBodyFn: renderBodyHtml,
    customOrderFetcher: async (acc, order) => {
      if (simulatedNewSwiggyOrder) return [simulatedNewSwiggyOrder];
      // Default: call REAL LIVE Swiggy `/dapi/order/all`!
      const auth = await getSwiggySessionAuth(acc, true);
      return auth?.orders || [];
    }
  });

  function makeCtx({ message = null, cbData = null, msgIdForCb = null }) {
    return {
      from: { id: bossId, first_name: 'Boss' },
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
        return { message_id: id, chat: { id: bossId }, photo: [{ file_id: `mock_qr_file_${id}` }] };
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

  // STEP 1: Boss forwards Ammi's Address message from IB -> Bot creates Card #1 (101) with Ammi's Name + Cancel button!
  const fwdAddrMsg = {
    text: 'Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/j37ai838.\n\nAddress: Ground, 504, 54-106, Mukarimnagar, Hasanganj, Lucknow, Uttar Pradesh 226007, India',
    forward_origin: {
      type: 'user',
      sender_user: { id: 7770001, first_name: 'Ammi', username: 'ammi_home' }
    }
  };
  await handleBossForwardedOrderInput(makeCtx({ message: fwdAddrMsg }), { rawText: fwdAddrMsg.text, formatOrderBodyFn: renderBodyHtml });

  const card1 = messages.get(101);
  ok(Boolean(card1) && card1.text.includes('Ammi') && card1.text.includes('Mukarimnagar'), 'Step 1: Forwarded Address created Card #101 with sender name "Ammi" & parsed street address');
  ok(flatButtons(card1).includes('❌ Cancel Order'), 'Step 1: Partial Card #101 has [ ❌ Cancel Order ] button');

  // STEP 2: Boss forwards Ammi's Cart Link from IB (even with hidden_user privacy!) -> Card #101 DELETED, Card #102 asks Choose Account!
  const fwdCartMsg = {
    text: 'Beta ye mangwa do https://swig.gy/gc/67272/Umbashiya-642855918',
    forward_origin: {
      type: 'hidden_user',
      sender_user_name: 'Ammi'
    }
  };
  await handleBossForwardedOrderInput(makeCtx({ message: fwdCartMsg }), { rawText: fwdCartMsg.text, formatOrderBodyFn: renderBodyHtml });

  ok(deletedIds.includes(101) && !messages.has(101), 'Step 2: Previous incomplete Card #101 WAS DELETED automatically when Ammi sent Cart link!');
  const card2 = messages.get(102);
  ok(Boolean(card2) && card2.text.includes('Choose Swiggy Account'), 'Step 2: Updated Card #102 has both Address + Cart & asks Boss to Choose Account');
  ok(flatButtons(card2).includes('❌ Cancel Order'), 'Step 2: Account Chooser Card #102 has [ ❌ Cancel Order ] button');

  // Extract orderId dynamically from callback_data
  const pickCb = flatCallbacks(card2).find(c => c.endsWith('__acc_9935123518'));
  ok(Boolean(pickCb), `Step 2: Live account picker button found (${pickCb})`);
  const orderId = pickCb.split('__')[0].replace('fwd_pick_acc_', '');

  // STEP 3: Boss chooses `acc_9935123518` -> Live Swiggy Fetch -> Card #102 DELETED -> Card #103 shows exact Final Bill + `[ 🔳 Generate QR ]` + `[ ✅ Paid ]` + `[ ❌ Cancel Order ]`!
  await clickButton(pickCb, 102);

  ok(deletedIds.includes(102) && !messages.has(102), 'Step 3: Account Chooser Card #102 deleted cleanly once live bill finished fetching');
  const card3 = messages.get(103);
  console.log('\n--- LIVE FETCHED FORWARDED ORDER CARD (#103) ---\n' + card3.text + '\n------------------------------------------------\n');

  ok(
    Boolean(card3) &&
    card3.text.includes('Final Bill') &&
    card3.text.includes('Items Total:') &&
    card3.text.includes('Select an Available Payment Method') &&
    card3.text.includes('Final Total:'),
    'Step 3: Fetched Bill Card #103 renders exact Swiggy Final Bill layout'
  );
  ok(
    flatButtons(card3).includes('🔳 Generate QR') &&
    flatButtons(card3).includes('✅ Paid') &&
    flatButtons(card3).includes('❌ Cancel Order'),
    'Step 3: Fetched Bill Card #103 displays [ 🔳 Generate QR ], [ ✅ Paid ], and [ ❌ Cancel Order ]!'
  );

  // STEP 4: Boss clicks `[ 🔳 Generate QR ]` -> Real Personalized Swiggy QR PNG generated with Ammi's name!
  await clickButton(`fwd_gen_qr_${orderId}`, 103);
  const qrCard = messages.get(104);
  ok(
    qrCard?.type === 'photo' &&
    Buffer.isBuffer(qrCard.buffer) &&
    qrCard.buffer.length > 25000 &&
    flatButtons(qrCard).includes('✅ Paid') &&
    flatButtons(qrCard).includes('❌ Cancel Order'),
    `Step 4: Personalized Payment QR PNG generated (${qrCard?.buffer?.length} bytes) with [ ✅ Paid ] & [ ❌ Cancel Order ]`
  );

  // STEP 5: Boss clicks `[ ✅ Paid ]` BEFORE customer has paid on Swiggy -> real live Swiggy API check says "Payment is processing"!
  cbAlerts.length = 0;
  await clickButton(`fwd_check_paid_${orderId}`, 103);
  ok(
    cbAlerts.some(a => /Payment is processing/i.test(a.text)) &&
    messages.has(103) &&
    messages.get(103).text.includes('Payment is processing') &&
    messages.has(104),
    'Step 5: Unpaid check reports "Payment is processing" and keeps Bill Card #103 + QR #104 intact!'
  );

  // STEP 6: Customer completes payment on Swiggy (`order_id: 249876543210`) -> Boss clicks `[ ✅ Paid ]` -> Old Card #103 & QR #104 DELETED -> New Card #105 sent with SAME details + LIVE TRACKING LINK + `[ ❌ Cancel Order ]`!
  simulatedNewSwiggyOrder = {
    order_id: '249876543210',
    order_status: 'Processing',
    order_time: new Date().toISOString()
  };
  await clickButton(`fwd_check_paid_${orderId}`, 103);

  ok(deletedIds.includes(103) && deletedIds.includes(104), 'Step 6: Both Old Bill Card (#103) & QR Card (#104) DELETED automatically upon verified payment!');
  const trackingCard = messages.get(105);
  console.log('\n--- CONFIRMED PAID + LIVE TRACKING CARD (#105) ---\n' + trackingCard.text + '\n--------------------------------------------------\n');

  ok(
    Boolean(trackingCard) &&
    trackingCard.text.includes('Ammi') &&
    trackingCard.text.includes('Final Bill') &&
    trackingCard.text.includes('https://www.swiggy.com/orders/track/249876543210') &&
    flatButtons(trackingCard).includes('🛵 Track Live Order on Swiggy') &&
    flatButtons(trackingCard).includes('❌ Cancel Order'),
    'Step 6: New Confirmed Card #105 has identical order details + Live Swiggy Tracking Link + [ ❌ Cancel Order ]!'
  );

  // STEP 7: New forwarded message from Ammi AFTER Order #1 is COMPLETED does NOT delete Completed Tracking Card #105 — creates fresh Order #2 (#106), then `[ ❌ Cancel Order ]` cancels it cleanly!
  await handleBossForwardedOrderInput(makeCtx({ message: fwdAddrMsg }), { rawText: fwdAddrMsg.text, formatOrderBodyFn: renderBodyHtml });
  ok(messages.has(105) && messages.has(106), 'Step 7: Forwarding new message after COMPLETED keeps Completed Tracking Card #105 intact & opens new Card #106');

  const cancelCb2 = flatCallbacks(messages.get(106)).find(c => c.startsWith('fwd_cancel_'));
  await clickButton(cancelCb2, 106);
  ok(deletedIds.includes(106) && messages.get(107)?.text.includes('Order Cancelled'), 'Step 8: Clicking [ ❌ Cancel Order ] deletes active card #106 & confirms cancellation cleanly');

  // Cleanup live helper cart & verify acc_6296591407 untouched!
  await dapiFetch(accHelper, 'cart', {
    method: 'POST',
    body: { flushFirst: true, cart: { restaurantId: '444136', address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] } }
  }).catch(() => {});

  const afterLiveCart = await inspectCartForAccount(accLive);
  const afterHelperCart = await inspectCartForAccount(accHelper);
  ok(
    (!afterHelperCart?.items || afterHelperCart.items.length === 0) &&
    afterLiveCart?.restaurantName === beforeLiveCart?.restaurantName,
    `Step 9: Live cleanup verified — acc_9935123518 empty & acc_6296591407 (${afterLiveCart?.restaurantName}) untouched!`
  );

  console.log(`\n================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} FORWARDED IB -> CARD -> QR -> PAID/TRACKING -> CANCEL TESTS PASSED!`);
  console.log(`================================================================`);
} finally {
  fs.writeFileSync('./data/db.json', originalDbRaw, 'utf8');
}
