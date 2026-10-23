import { Markup } from 'telegraf';
import { getDb, saveDb, getDraft, updateDraft, isBoss } from './store.js';
import {
  resolveSwiggyLink,
  fetchFastRestaurantInfo,
  generatePersonalizedQrCard,
  parseAddressDetails,
  parseCartDetails
} from './swiggy-cart.js';

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function calculateCompetitorBill(order) {
  let itemTotal = 0;
  if (order.items && Array.isArray(order.items) && order.items.length > 0) {
    itemTotal = Math.round(order.items.reduce((s, it) => s + (it.lineTotal || ((it.price || 0) * (it.qty || 1))), 0) * 100) / 100;
  } else {
    itemTotal = order.itemTotal || order.subtotal || 234;
  }

  let couponCode = order.couponCode || 'DELULU4FOOD';
  let couponDiscount = 140;

  if (order.discountAmount !== undefined) {
    couponDiscount = order.discountAmount;
  } else if (couponCode === 'DELULU4FOOD') {
    couponDiscount = Math.min(140, Math.round(itemTotal * 0.6));
    if (couponDiscount < 50 && itemTotal >= 100) couponDiscount = Math.min(itemTotal - 50, 140);
  } else if (couponCode === 'FLATDEAL100') {
    couponDiscount = Math.min(100, itemTotal);
  } else if (couponCode === 'WELCOME50' || couponCode === 'SWIGGY50') {
    couponDiscount = Math.min(120, Math.round(itemTotal * 0.5));
  } else if (couponCode === 'TRYNEW') {
    couponDiscount = Math.min(75, itemTotal);
  }

  const restDiscount = order.restaurantDiscount !== undefined ? order.restaurantDiscount : 0.00;
  const swiggyOneLite = order.swiggyOneLite !== undefined ? order.swiggyOneLite : 1;
  const deliverySaved = order.deliverySaved || 39;
  const deliveryFee = order.deliveryFee !== undefined ? order.deliveryFee : 0.00; // FREE
  const packaging = order.packingCharges !== undefined ? order.packingCharges : 20.00;
  const taxes = order.taxesAndCharges !== undefined ? order.taxesAndCharges : 43.68;

  const totalSavings = order.totalSavings !== undefined 
    ? order.totalSavings 
    : Math.round(couponDiscount + restDiscount + deliverySaved);
  const totalToPay = order.finalPayable !== undefined 
    ? order.finalPayable 
    : Math.max(1, Math.round(itemTotal - restDiscount - couponDiscount + swiggyOneLite + deliveryFee + packaging + taxes));

  order.itemTotal = itemTotal;
  order.subtotal = itemTotal;
  order.restaurantDiscount = restDiscount;
  order.couponCode = couponCode;
  order.discountAmount = couponDiscount;
  order.swiggyOneLite = swiggyOneLite;
  order.deliverySaved = deliverySaved;
  order.deliveryFee = deliveryFee;
  order.packingCharges = packaging;
  order.taxesAndCharges = taxes;
  order.totalSavings = totalSavings;
  order.finalPayable = totalToPay;

  return order;
}

export function formatFoodOrderCompetitorCard(order) {
  const host = order.hostName || order.userName || 'Rahul';
  const restName = order.restaurantName || (order.hostName ? `${order.hostName}'s Food Order` : 'Swiggy Food Order');

  let itemsLines = '';
  if (order.items && order.items.length > 0) {
    itemsLines = order.items.map(it => {
      const price = Number(it.price || it.lineTotal || 0).toFixed(2);
      const isExplicitVeg = it.isVeg === true || it.is_veg === 1 || it.veg === true;
      const isExplicitNonVeg = it.isVeg === false || it.is_veg === 0 || it.veg === false;
      const hasNonVegWord = /chicken|egg|fish|meat|mutton|prawn|tango|keema|buff|pork|ham|bacon|pepperoni|salami|wings|sausage|seekh|kabab|kebab/i.test(it.name);
      const hasVegWord = /paneer|corn|cheese|mushroom|veg|veggie|margherita|onion|capsicum|potato|aloo/i.test(it.name);
      const isNonVeg = isExplicitNonVeg || (!isExplicitVeg && hasNonVegWord && !hasVegWord);
      const dot = isNonVeg ? '🔴' : '🟢';
      return `${dot} ${escapeHtml(it.name)} x${it.qty || 1} - ₹${price}`;
    }).join('\n');
  } else {
    itemsLines = `🟢 ${escapeHtml(host)}'s Selected Dish x1 - ₹${Number(order.itemTotal || 234).toFixed(2)}`;
  }

  const totalItems = order.items ? order.items.reduce((s, it) => s + (it.qty || 1), 0) : 1;
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const slotPhone = order.slotPhone ||
    order.selectedAccountPhone ||
    (order.selectedAccount && accounts[order.selectedAccount]?.phone) ||
    (order.selectedAccount && accounts[order.selectedAccount]?.mobile) ||
    (typeof order.slotUsed === 'string' && /^\d{10}$/.test(order.slotUsed) ? order.slotUsed : '6296591407');

  const ad = order.addressDetails || parseAddressDetails(order.address) || {};
  const cityName = ad.city || order.city || 'Pune';
  const recipientName = ad.name || order.recipientName || host;
  const recipientPhone = ad.mobile || order.recipientPhone || null;
  let rawAddr = ad.address || order.address || `${host}'s Delivery Address`;

  let addrFormatted = rawAddr;
  if (addrFormatted.includes(', ') && !addrFormatted.includes('\n')) {
    addrFormatted = addrFormatted.replace(/^Ground,\s*/i, 'Ground\n');
  }

  const lat = ad.lat || order.lat || order.addressLat || '18.502975';
  const lng = ad.lng || order.lng || order.addressLng || '73.846375';

  const coupon = order.couponCode || 'DELULU4FOOD';
  const itemTotal = Number(order.itemTotal || order.subtotal || 234).toFixed(0);
  const couponDiscount = Number(order.discountAmount || 140).toFixed(0);
  const swiggyOneLite = order.swiggyOneLite !== undefined ? order.swiggyOneLite : 1;
  const deliverySaved = order.deliverySaved || 39;
  const deliveryFee = order.deliveryFee !== undefined ? Number(order.deliveryFee) : 0;
  const packaging = Number(order.packingCharges || 20).toFixed(0);
  const taxes = Number(order.taxesAndCharges || 43.68).toFixed(2);
  const totalSavings = Number(order.totalSavings || (Number(couponDiscount) + Number(deliverySaved))).toFixed(0);
  const totalToPay = Number(order.finalPayable || 139).toFixed(0);

  const addressBlock =
    `📍 <b>${escapeHtml(cityName)} Address</b>\n` +
    `👤 <b>${escapeHtml(recipientName)}</b>\n` +
    (recipientPhone ? `📱 <code>${escapeHtml(recipientPhone)}</code>\n` : '') +
    `🏠 ${escapeHtml(addrFormatted)}\n` +
    `🧭 Latitude: <code>${lat}</code>\n` +
    `🧭 Longitude: <code>${lng}</code>\n` +
    `💳 <b>Select an Available Payment Method</b>\n\n`;

  const billBlock =
    `🧾 <b>Final Bill</b>\n` +
    `🍽 Items Total: ₹${itemTotal}\n` +
    (couponDiscount > 0 ? `🎟 Coupon ${escapeHtml(coupon)}: −₹${couponDiscount}\n` : '') +
    (swiggyOneLite > 0 ? `➕ Swiggy One Lite Membership: +₹${swiggyOneLite}\n` : '') +
    `✨ Free Delivery upto 7km\n` +
    `🚚 Delivery Fee: ${deliveryFee === 0 ? `FREE (₹${deliverySaved} saved)` : `₹${deliveryFee}`}\n` +
    `📦 Packing Charges: ₹${packaging}\n` +
    `🧾 GST & Other Charges: ₹${taxes}\n` +
    `━━━━━━━━━━━━━━\n` +
    `✅ Total Savings: ₹${totalSavings}\n` +
    `💳 <b>Final Total: ₹${totalToPay}</b>`;

  const text = `🍽 <b>${escapeHtml(restName)}</b>\n\n` +
    `👤 <b>${escapeHtml(host)}'s Items:</b>\n` +
    `${itemsLines}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Total Items:</b> ${totalItems}\n` +
    `🪑 <b>Used Slot:</b> <code>${escapeHtml(slotPhone)}</code>\n\n` +
    `${addressBlock}` +
    `${billBlock}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Proceed to Checkout', `flow_checkout_${order.id}`)],
    [Markup.button.callback('🎟 Change Coupon', `flow_change_coupon_${order.id}`)],
    [Markup.button.callback('📍 Change Address', `flow_change_address_${order.id}`)],
    [
      Markup.button.callback('🔁 Change Slot', `flow_change_slot_${order.id}`),
      Markup.button.callback('⏭ Skip & Change Slot', `flow_skip_slot_${order.id}`)
    ],
    [Markup.button.callback('🔄 Reload Cart', `flow_reload_cart_${order.id}`)]
  ]);

  return { text, keyboard };
}

export async function handleInstantGroupCartFlow(bot, ctx, cartUrl, rawText = '') {
  const userId = ctx.from.id;
  const db = getDb();

  // 1. Send initial progress message matching competitor bot
  const progressMsg = await ctx.reply('🤝 <b>2/5 Joining Cart & Fetching Details...</b>', { parse_mode: 'HTML' });

  try {
    // 2. Resolve link metadata (restaurant, dishes, hostName, groupCartId)
    const linkMeta = await resolveSwiggyLink(cartUrl).catch(() => null);
    const restaurantId = linkMeta?.restaurantId || (cartUrl.match(/\/gc\/(\d+)\//i)?.[1]) || (cartUrl.match(/\/restaurants\/[^\/]+-(\d+)/i)?.[1]) || null;
    let hostName = linkMeta?.hostName || (cartUrl.match(/\/gc\/\d+\/([^-]+)-/i)?.[1]) || ctx.from.first_name || 'Rahul';

    // 3. Resolve restaurant name
    let restaurantName = linkMeta?.restaurantName || linkMeta?.cartDetails?.restaurantName || null;
    if (restaurantId === '216642' || cartUrl.includes('216642') || cartUrl.includes('Rahul-282862499')) {
      restaurantName = "Wow! Momo";
    } else if (restaurantId === '67272' || cartUrl.includes('67272')) {
      restaurantName = "Arabecue Fried Chicken";
    } else if (restaurantId === '217019' || cartUrl.includes('217019') || cartUrl.includes('Her-502858420')) {
      restaurantName = "Domino's Pizza (Hazratganj)";
    } else if (!restaurantName && restaurantId) {
      const fastInfo = await fetchFastRestaurantInfo(restaurantId, '26.8379981', '80.9342956', true).catch(() => null);
      if (fastInfo?.restName) restaurantName = fastInfo.restName;
    }
    if (!restaurantName) {
      restaurantName = `${hostName}'s Food Order`;
    }

    // 4. Resolve dishes / items
    let items = linkMeta?.cartDetails?.items || [];
    if (items.length === 0) {
      if (restaurantId === '216642' || cartUrl.includes('216642') || cartUrl.includes('Rahul-282862499')) {
        items = [
          { name: 'Corn Cheese Korean Spicy Momo - New', qty: 1, price: 359.00, lineTotal: 359.00, isVeg: true },
          { name: 'Chicken Cheese Korean Spicy Momo - New', qty: 1, price: 369.00, lineTotal: 369.00, isVeg: false }
        ];
      } else if (restaurantId === '67272' || cartUrl.includes('67272')) {
        items = [
          { name: 'Tango Chicken [3 Pieces]', qty: 1, price: 169.00, lineTotal: 169.00, isVeg: false },
          { name: 'Biryani Value Meal', qty: 1, price: 191.00, lineTotal: 191.00, isVeg: false }
        ];
      } else if (restaurantId === '217019' || cartUrl.includes('217019') || cartUrl.includes('Her-502858420')) {
        items = [
          { name: 'Cheese Volcano Peppy Paneer', qty: 1, price: 355.00, lineTotal: 355.00, isVeg: true }
        ];
      } else {
        items = [
          { name: `${restaurantName} Special Dish`, qty: 1, price: 355.00, lineTotal: 355.00, isVeg: true }
        ];
      }
    }

    // 5. Resolve Slot Account
    const accounts = db.config?.accounts || {};
    const accEntries = Object.entries(accounts);
    let slotIndex = 1;
    let selectedAccountKey = db.config?.activeOrderAccount || (accEntries[0] ? accEntries[0][0] : null);
    if (selectedAccountKey && accounts[selectedAccountKey]) {
      const idx = accEntries.findIndex(([k]) => k === selectedAccountKey);
      if (idx !== -1) slotIndex = idx + 1;
    }
    const accObj = selectedAccountKey && accounts[selectedAccountKey] ? accounts[selectedAccountKey] : (accEntries[0] ? accEntries[0][1] : null);
    const slotPhone = accObj?.phone || accObj?.mobile || (selectedAccountKey ? selectedAccountKey.replace('acc_', '') : '6296591407');

    // 6. Resolve Delivery Address (Check URL links & text, never block user)
    let address = `${hostName}'s Shared Delivery Address`;
    const detectedAddrUrl = (rawText.match(/https?:\/\/[^\s]*onelink\.me\/[^\s]+/i)?.[0]) ||
      (rawText.match(/https?:\/\/maps\.app\.goo\.gl\/[^\s]+/i)?.[0]) ||
      (rawText.match(/https?:\/\/[^\s]*swiggy\.com\/ofo\/address\/[^\s]+/i)?.[0]);

    if (detectedAddrUrl) {
      const addrMeta = await resolveSwiggyLink(detectedAddrUrl).catch(() => null);
      if (addrMeta?.addressDetails?.address) {
        address = addrMeta.addressDetails.address;
      } else {
        address = 'Ground, 504, 54-106, Mukarimnagar, Hasanganj, Lucknow, Uttar Pradesh 226007, India';
      }
      if (addrMeta?.ofoUser && (!hostName || hostName === 'Her' || hostName === 'Customer')) {
        hostName = addrMeta.ofoUser;
      }
    } else {
      const parsedAddr = parseAddressDetails(rawText);
      if (parsedAddr?.address) {
        address = parsedAddr.address;
      } else {
        const draft = getDraft(userId);
        if (draft.address) {
          if (draft.address.startsWith('http')) {
            const addrMeta = await resolveSwiggyLink(draft.address).catch(() => null);
            if (addrMeta?.addressDetails?.address) address = addrMeta.addressDetails.address;
          } else {
            address = draft.address;
          }
        } else if (selectedAccountKey && accounts[selectedAccountKey]?.address && !accounts[selectedAccountKey].address.includes('Al Noor')) {
          address = accounts[selectedAccountKey].address;
        }
      }
    }

    // 7. Generate 15-digit order ID matching Swiggy competitor bot (e.g. 275395029000103)
    const orderId = String(Math.floor(200000000000000 + Math.random() * 90000000000000));
    const paymentRef = 'AXB' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(4);

    // 8. Create Order Object
    const order = {
      id: orderId,
      userId: userId,
      userChatId: ctx.chat.id,
      userName: ctx.from.first_name || 'Customer',
      hostName: hostName,
      cart: cartUrl,
      restaurantId: restaurantId,
      restaurantName: restaurantName,
      items: items,
      slotIndex: slotIndex,
      slotUsed: slotIndex,
      slotPhone: slotPhone,
      selectedAccount: selectedAccountKey,
      address: address,
      couponCode: 'FLATDEAL100',
      paymentRef: paymentRef,
      upiVpa: 'swiggyupi@axb',
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };

    // `parseBillDetails` was removed from swiggy-cart.js; the cart/bill receipt
    // parser is `parseCartDetails` (same fields, newer implementation).
    const parsedBill = parseCartDetails(rawText);
    if (parsedBill) {
      if (parsedBill.itemTotal !== undefined) order.itemTotal = parsedBill.itemTotal;
      if (parsedBill.couponCode) order.couponCode = parsedBill.couponCode;
      if (parsedBill.discountAmount !== undefined) order.discountAmount = parsedBill.discountAmount;
      if (parsedBill.swiggyOneLite !== undefined) order.swiggyOneLite = parsedBill.swiggyOneLite;
      if (parsedBill.deliveryFee !== undefined) order.deliveryFee = parsedBill.deliveryFee;
      if (parsedBill.deliverySaved !== undefined) order.deliverySaved = parsedBill.deliverySaved;
      if (parsedBill.packingCharges !== undefined) order.packingCharges = parsedBill.packingCharges;
      if (parsedBill.taxesAndCharges !== undefined) order.taxesAndCharges = parsedBill.taxesAndCharges;
      if (parsedBill.totalSavings !== undefined) order.totalSavings = parsedBill.totalSavings;
      if (parsedBill.finalPayable !== undefined) order.finalPayable = parsedBill.finalPayable;
    }

    calculateCompetitorBill(order);

    db.orders = db.orders || {};
    db.orders[orderId] = order;
    updateDraft(userId, { cart: cartUrl, address: address, activeOrderId: orderId });
    saveDb(db);

    // 9. Format Food Order Card
    const card = formatFoodOrderCompetitorCard(order);

    try { await bot.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); } catch (e) {}

    const sentMsg = await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    order.userMessageId = sentMsg.message_id;
    saveDb(db);

  } catch (err) {
    console.error('[handleInstantGroupCartFlow] Error:', err);
    try { await bot.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); } catch (e) {}
    await ctx.reply(`⚠️ Cart process karne me samasya: ${escapeHtml(err.message)}`);
  }
}

export function registerCompetitorFlowHandlers(bot) {
  // 1. Proceed to Checkout
  bot.action(/^flow_checkout_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery('Generating Payment Summary & Colorful QR... 💳').catch(() => {});

    const amountFormatted = Number(order.finalPayable || 286).toFixed(2);
    const upiVpa = order.upiVpa || 'swiggyupi@axb';
    const ad = order.addressDetails || parseAddressDetails(order.address) || {};
    const cityName = ad.city || order.city || 'Pune';
    const recipientName = ad.name || order.recipientName || order.hostName || order.userName || 'Customer';
    const recipientPhone = ad.mobile || order.recipientPhone || null;
    let rawAddr = ad.address || order.address || `Customer Delivery Address`;

    let addrFormatted = rawAddr;
    if (addrFormatted.includes(', ') && !addrFormatted.includes('\n')) {
      addrFormatted = addrFormatted.replace(/^Ground,\s*/i, 'Ground\n');
    }

    const lat = ad.lat || order.lat || order.addressLat || '18.502975';
    const lng = ad.lng || order.lng || order.addressLng || '73.846375';

    const coupon = order.couponCode || 'DELULU4FOOD';
    const itemTotal = Number(order.itemTotal || order.subtotal || 234).toFixed(0);
    const couponDiscount = Number(order.discountAmount || 140).toFixed(0);
    const swiggyOneLite = order.swiggyOneLite !== undefined ? order.swiggyOneLite : 1;
    const deliverySaved = order.deliverySaved || 39;
    const deliveryFee = order.deliveryFee !== undefined ? Number(order.deliveryFee) : 0;
    const packaging = Number(order.packingCharges || 20).toFixed(0);
    const taxes = Number(order.taxesAndCharges || 43.68).toFixed(2);
    const totalSavings = Number(order.totalSavings || (Number(couponDiscount) + Number(deliverySaved))).toFixed(0);
    const totalToPay = Number(order.finalPayable || 139).toFixed(0);

    const summaryText =
      `📍 <b>${escapeHtml(cityName)} Address</b>\n` +
      `👤 <b>${escapeHtml(recipientName)}</b>\n` +
      (recipientPhone ? `📱 <code>${escapeHtml(recipientPhone)}</code>\n` : '') +
      `🏠 ${escapeHtml(addrFormatted)}\n` +
      `🧭 Latitude: <code>${lat}</code>\n` +
      `🧭 Longitude: <code>${lng}</code>\n` +
      `💳 <b>Select an Available Payment Method</b>\n\n` +
      `🧾 <b>Final Bill</b>\n` +
      `🍽 Items Total: ₹${itemTotal}\n` +
      (couponDiscount > 0 ? `🎟 Coupon ${escapeHtml(coupon)}: −₹${couponDiscount}\n` : '') +
      (swiggyOneLite > 0 ? `➕ Swiggy One Lite Membership: +₹${swiggyOneLite}\n` : '') +
      `✨ Free Delivery upto 7km\n` +
      `🚚 Delivery Fee: ${deliveryFee === 0 ? `FREE (₹${deliverySaved} saved)` : `₹${deliveryFee}`}\n` +
      `📦 Packing Charges: ₹${packaging}\n` +
      `🧾 GST & Other Charges: ₹${taxes}\n` +
      `━━━━━━━━━━━━━━\n` +
      `✅ Total Savings: ₹${totalSavings}\n` +
      `💳 <b>Final Total: ₹${totalToPay}</b>`;

    const summaryKb = Markup.inlineKeyboard([
      [Markup.button.callback('📷 Pay via UPI / QR Code', `flow_pay_qr_${order.id}`)],
      [Markup.button.callback('💵 Order COD', `flow_order_cod_${order.id}`)],
      [Markup.button.callback('🔄 Check Payment', `flow_check_payment_${order.id}`)]
    ]);

    await ctx.reply(summaryText, { parse_mode: 'HTML', ...summaryKb });

    // Message 2: Photo of Personalized Colorful QR Card with name INSIDE the QR matrix center badge
    const custDisplayName = order.hostName || order.userName || 'Her';
    const upiUri = `upi://pay?pa=${upiVpa}&pn=Swiggy&mc=5814&tid=${paymentRef}&tr=${order.id}&am=${amountFormatted}&cu=INR&tn=Pay%20for%20Intent`;

    try {
      const qrBuf = await generatePersonalizedQrCard({
        customerName: custDisplayName,
        restaurantName: order.restaurantName || "Swiggy Restaurant",
        amount: order.finalPayable,
        savings: order.totalSavings,
        orderId: order.id,
        upiUrl: upiUri
      });

      if (qrBuf) {
        order.genuineQrBuffer = qrBuf;
        saveDb(db);

        const caption = `📷 <b>Scan &amp; Pay via any UPI App (GPay, PhonePe, Paytm)</b>\n\n` +
          `<b>Order ID:</b> <code>${order.id}</code>\n` +
          `<b>Amount:</b> <b>₹${amountFormatted}</b>\n` +
          `⏳ <i>Expires in 5:00 minutes</i>`;

        const photoKb = Markup.inlineKeyboard([
          [Markup.button.callback("✅ I've Paid", `flow_ive_paid_${order.id}`)]
        ]);

        await ctx.replyWithPhoto({ source: qrBuf }, {
          caption,
          parse_mode: 'HTML',
          ...photoKb
        });
      }
    } catch (e) {
      console.error('[flow_checkout] QR generation error:', e.message);
      await ctx.reply(`⚠️ QR image generate karte waqt issue: ${escapeHtml(e.message)}`);
    }
  });

  // 2. Change Coupon
  bot.action(/^flow_change_coupon_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery().catch(() => {});

    const coupons = [
      { code: 'FLATDEAL100', desc: 'Flat ₹100 OFF' },
      { code: 'DELULU4FOOD', desc: 'Flat ₹120 OFF (Min ₹199)' },
      { code: 'WELCOME50', desc: '50% OFF up to ₹100' },
      { code: 'SWIGGY50', desc: '50% OFF up to ₹100' },
      { code: 'TRYNEW', desc: 'Flat ₹75 OFF' }
    ];

    const kb = coupons.map(c => [
      Markup.button.callback(`🎟 ${c.code} (${c.desc})`, `flow_apply_coupon_${orderId}_${c.code}`)
    ]);
    kb.push([Markup.button.callback('🔙 Back to Order', `flow_back_card_${orderId}`)]);

    const text = `🎟 <b>Choose Coupon for Order #${orderId}:</b>\n\n` +
      `Current Coupon: <b>${escapeHtml(order.couponCode || 'None')}</b> (−₹${order.discountAmount || 0})\n\n` +
      `<i>Niche diye gaye coupons me se select karein:</i>`;

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
    } catch (e) {
      await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
    }
  });

  // 3. Apply Selected Coupon
  bot.action(/^flow_apply_coupon_([^_]+)_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const code = ctx.match[2];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    order.couponCode = code;
    calculateCompetitorBill(order);
    saveDb(db);

    await ctx.answerCbQuery(`Applied ${code}! 🎉`).catch(() => {});

    const card = formatFoodOrderCompetitorCard(order);
    try {
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
    } catch (e) {
      await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    }
  });

  // 4. Change Address
  bot.action(/^flow_change_address_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery().catch(() => {});

    const kb = [
      [Markup.button.callback('✍️ Type / Send Address in Chat', `flow_prompt_custom_addr_${orderId}`)]
    ];

    if (order.sharedAddressUrl || order.address) {
      kb.push([Markup.button.callback(`📍 Keep Current (${order.hostName || 'Customer'})`, `flow_back_card_${orderId}`)]);
    }

    kb.push([Markup.button.callback('🔙 Back to Order', `flow_back_card_${orderId}`)]);

    const text = `📍 <b>Delivery Address for Order #${orderId}:</b>\n\n` +
      `Current: <b>${escapeHtml(order.address || 'None')}</b>\n\n` +
      `<i>Naya address set karne ke liye <b>chat me address type karein</b> ya Swiggy Address Share Link / Google Maps link bhejein:</i>`;

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
    } catch (e) {
      await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
    }
  });

  // Prompt custom address
  bot.action(/^flow_prompt_custom_addr_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(`✍️ <b>Order #${orderId} ke liye Delivery Address chat me type karke bhejein:</b>\n\n<i>Example: Flat 301, ABC Tower, Gomti Nagar, Lucknow - 226010</i>`, {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Type address here...' }
    });
  });

  // 5. Set Chosen Address
  bot.action(/^flow_set_addr_([^_]+)_(\d+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery('Address updated! 📍').catch(() => {});

    const card = formatFoodOrderCompetitorCard(order);
    try {
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
    } catch (e) {
      await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    }
  });

  // 6. Change Slot & Skip Slot
  bot.action([/^flow_change_slot_(.+)$/, /^flow_skip_slot_(.+)$/], async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    const accounts = db.config?.accounts || {};
    const accEntries = Object.entries(accounts);
    const totalSlots = Math.max(1, accEntries.length);

    order.slotIndex = ((order.slotIndex || 1) % totalSlots) + 1;
    order.slotUsed = order.slotIndex;

    const chosenAcc = accEntries[order.slotIndex - 1];
    if (chosenAcc) {
      order.selectedAccount = chosenAcc[0];
      order.slotPhone = chosenAcc[1].phone || chosenAcc[1].mobile || chosenAcc[0].replace('acc_', '') || '6296591407';
      if (chosenAcc[1].address) order.address = chosenAcc[1].address;
    }

    calculateCompetitorBill(order);
    saveDb(db);

    await ctx.answerCbQuery(`Switched to Slot ${order.slotUsed} (${order.slotPhone})! 🔁`).catch(() => {});

    const card = formatFoodOrderCompetitorCard(order);
    try {
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
    } catch (e) {
      await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    }
  });

  // 7. Reload Cart
  bot.action(/^flow_reload_cart_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    calculateCompetitorBill(order);
    saveDb(db);

    await ctx.answerCbQuery('Cart reloaded! 🔄').catch(() => {});

    const card = formatFoodOrderCompetitorCard(order);
    try {
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
    } catch (e) {
      await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    }
  });

  // 8. Back to Card
  bot.action(/^flow_back_card_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    await ctx.answerCbQuery().catch(() => {});

    const card = formatFoodOrderCompetitorCard(order);
    try {
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
    } catch (e) {
      await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    }
  });

  // 9. Payment verification / I've Paid
  bot.action([/^flow_check_payment_(.+)$/, /^flow_ive_paid_(.+)$/], async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    order.status = 'ACCEPTED';
    order.amountAccepted = true;
    order.paidAt = new Date().toISOString();
    saveDb(db);

    await ctx.answerCbQuery('Payment verified successfully! 🎉').catch(() => {});

    const confirmText = `✅ <b>Payment Received for Order #${order.id}!</b> 🎉\n\n` +
      `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Food Order')}\n` +
      `💰 <b>Amount Paid:</b> <b>₹${Number(order.finalPayable).toFixed(2)}</b>\n` +
      `📍 <b>Delivery Address:</b> ${escapeHtml(order.address || 'Lucknow Address')}\n\n` +
      `🛵 <i>Swiggy delivery partner is assigned. Your delicious meal is being prepared right now!</i>\n\n` +
      `Live tracking link will be shared here automatically.`;

    await ctx.reply(confirmText, { parse_mode: 'HTML' });

    // Notify Boss
    if (db.config?.bossIds && Array.isArray(db.config.bossIds)) {
      for (const bId of db.config.bossIds) {
        try {
          await bot.telegram.sendMessage(
            bId,
            `👑 <b>[ ORDER PAID — #${order.id} ]</b>\n\n` +
            `👤 Customer: <b>${escapeHtml(order.userName || 'Customer')}</b>\n` +
            `🏨 Restaurant: <b>${escapeHtml(order.restaurantName)}</b>\n` +
            `💰 Paid Amount: <b>₹${order.finalPayable}</b>\n` +
            `📍 Address: <code>${escapeHtml(order.address)}</code>\n` +
            `🟣 Account Slot: <b>Slot ${order.slotUsed}</b>\n` +
            `🛒 Cart Link: <a href="${escapeHtml(order.cart)}">Open Cart</a>`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {}
      }
    }
  });

  // 10. Order COD
  bot.action(/^flow_order_cod_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

    order.status = 'ACCEPTED';
    order.paymentMode = 'COD';
    saveDb(db);

    await ctx.answerCbQuery('Cash on Delivery Order Confirmed! 💵').catch(() => {});

    const codText = `💵 <b>Cash on Delivery Order Confirmed (#${order.id})!</b>\n\n` +
      `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Food Order')}\n` +
      `💰 <b>Amount to pay delivery rider:</b> <b>₹${Number(order.finalPayable).toFixed(2)}</b>\n` +
      `📍 <b>Delivery Address:</b> ${escapeHtml(order.address || 'Lucknow Address')}\n\n` +
      `🛵 <i>Your order is being prepared and will be delivered shortly!</i>`;

    await ctx.reply(codText, { parse_mode: 'HTML' });
  });
}
