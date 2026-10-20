import http from 'http';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import {
  getDb,
  saveDb,
  isBoss,
  addBoss,
  setFamilyRole,
  getFamilyRole,
  getAccounts,
  updateAccount,
  createAccount,
  deleteAccount,
  getActiveUserOrder,
  getDraft,
  updateDraft,
  clearDraft,
  exportSessionJson,
  importSessionJson,
  getActiveOrderAccountKey,
  setActiveOrderAccountKey,
  permanentLogoutAccount,
  mutateDb,
  canTransitionOrder,
  getNextAutoUserName,
} from './store.js';
import { requestSwiggyOtpViaBridge, requestSwiggyDeleteOtpViaBridge, verifySwiggyOtpViaBridge, verifyAndDeleteSwiggyAccountViaBridge, signupSwiggyViaBridge, deactivateSwiggyAccountViaBridge, prewarmBrowser, checkLoggedInFromCookies, decodeJwtPayload, claimSwiggyBreakfastAndLateNightOffers } from './swiggy-bridge.js';
import {
  verifyAndInspectSwiggyLink,
  inspectCartForAccount,
  getGenuinePaymentDetails,
  verifyPaymentStatusFromApi,
  extractRealSwiggyTracking,
  resolveSwiggyLink,
  fetchAccountAddresses,
  fetchAccountOrders,
  formatSwiggyWorldCartReceipt,
  captureSwiggyPaymentScreenshot,
  checkAccountFreeCash,
  claimInstamartFreeCash,
  fetchSwiggyProfileFromCookies,
  parseAddressDetails,
  parseCartDetails,
  syncGroupCartAndCheckoutForAccount,
  applyMaxOfferToOrder,
  generatePersonalizedQrCard,
  reverseGeocodeCoords,
  geocodeAddressDetails,
  fetchAllAccountsSavedAddresses,
  applyLiveCouponToOrder
} from './swiggy-cart.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOSS_SECRET = process.env.BOSS_SECRET || 'boss123';

if (!BOT_TOKEN) {
  console.error('❌ Error: BOT_TOKEN is missing in .env file!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const userWaitState = {};

function extractAllLinks(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+|t\.me\/[^\s]+|www\.[^\s]+|maps\.app\.goo\.gl\/[^\s]+|swig\.gy\/[^\s]+)/gi;
  const matches = text.match(urlRegex) || [];
  return matches.map(link => {
    let l = link.trim().replace(/[,\.;\)]+$/, '');
    if (l.startsWith('www.')) l = 'https://' + l;
    else if (!l.startsWith('http') && !l.startsWith('t.me')) l = 'https://' + l;
    return l;
  });
}

function extractLink(text) {
  const links = extractAllLinks(text);
  return links.length > 0 ? links[0] : null;
}

function isLinkString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim().toLowerCase();
  return (
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('www.') ||
    s.includes('swiggy.com') ||
    s.includes('swig.gy') ||
    s.includes('onelink.me') ||
    s.includes('maps.google') ||
    s.includes('goo.gl') ||
    s.includes('maps.app.goo.gl') ||
    s.includes('t.me/')
  );
}

export function isValidSwiggyCartUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const s = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch (e) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const isSwiggyHost = host === 'swiggy.com' || host.endsWith('.swiggy.com') || host === 'swig.gy' || host === 'swiggy.onelink.me' || host.endsWith('.onelink.me');
  if (!isSwiggyHost) return false;

  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const full = path + search;

  if (path === '/' || path === '') return false;

  // IMPORTANT: Address links should NEVER be classified as cart links!
  // E.g. https://swiggy.onelink.me/JgkQ/52yat6op or ofo/address or /address
  if (path.includes('jgkq') || path.includes('address') || full.includes('ofo/address') || path.includes('y313q1wv')) {
    return false;
  }

  // Swiggy Onelink should only be treated as cart if it explicitly specifies cart/menu/restaurant/gc
  if (host.includes('onelink.me')) {
    return (
      full.includes('/gc/') ||
      full.includes('group-cart') ||
      full.includes('group_cart') ||
      full.includes('/cart') ||
      full.includes('/menu') ||
      full.includes('restaurant')
    );
  }

  return (
    full.includes('/gc/') ||
    full.includes('group-cart') ||
    full.includes('group_cart') ||
    full.includes('groupcartid') ||
    full.includes('/cart') ||
    full.includes('/restaurants/') ||
    full.includes('/menu') ||
    full.includes('restaurant_id') ||
    (host === 'swig.gy' && path.length >= 4)
  );
}

export function isValidDeliveryAddressUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const s = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch (e) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const full = path + search;

  const isGoogleMaps = host === 'maps.app.goo.gl' ||
                       host === 'goo.gl' ||
                       host === 'maps.google.com' ||
                       (host.endsWith('.google.com') && (path.includes('/maps') || path.includes('/place')));

  // Swiggy mobile app share address format: https://swiggy.onelink.me/JgkQ/...
  const isSwiggyOneLink = (host === 'swiggy.onelink.me' || host.endsWith('.onelink.me')) && path.length >= 3;
  // Swiggy web address URLs
  const isSwiggyWeb = (host === 'swiggy.com' || host.endsWith('.swiggy.com') || host === 'swig.gy') &&
                      (path.includes('address') || full.includes('ofo/address') || path.includes('y313q1wv') || path.includes('jgkq'));

  if (!isGoogleMaps && !isSwiggyOneLink && !isSwiggyWeb) return false;

  if (isGoogleMaps && (path === '/' || path === '/maps') && !parsed.search && !parsed.hash) {
    return false;
  }

  // Reject cart links if mistakenly passed
  if (path.includes('/gc/') || path.includes('group-cart') || path.includes('group_cart') || path.includes('/cart')) {
    return false;
  }

  return true;
}

function classifyLink(url) {
  if (isValidDeliveryAddressUrl(url)) return 'ADDRESS';
  if (isValidSwiggyCartUrl(url)) return 'CART';
  return 'UNKNOWN';
}

// User Bottom Menu - Pure Cart, Address, and Send to Beta options
function getUserReplyKeyboard(draft = {}) {
  const cartLabel = draft?.cart ? '🟣 Cart: Added ✅' : '🟣 Paste Cart Link';
  const addrLabel = draft?.address ? '🔵 Address: Added ✅' : '🔵 Paste Address Link';
  return Markup.keyboard([
    [
      { text: cartLabel },
      { text: addrLabel }
    ],
    [
      { text: '🚀 Send to Beta' }
    ],
    [
      { text: '🟠 Cancel Draft' }
    ]
  ]).resize();
}

// Boss Bottom Menu - Pure Admin Controls (Never customer buttons)
function getBossReplyKeyboard() {
  return Markup.keyboard([
    [
      { text: 'Order Screen', style: 'primary' },
      { text: 'Pending Orders', style: 'primary' }
    ],
    [
      { text: '🏆 Success Archive', style: 'success' },
      { text: '🗑️ Cancelled Orders', style: 'danger' }
    ],
    [
      { text: 'Connected Accounts', style: 'primary' },
      { text: 'Claim Free Cash', style: 'success' }
    ],
    [
      { text: 'Login with JSON', style: 'primary' },
      { text: 'Login with Number', style: 'primary' }
    ],
    [
      { text: 'Slot Status', style: 'primary' },
      { text: 'Total Slots', style: 'primary' }
    ],
    [
      { text: 'Total Left', style: 'primary' },
      { text: 'Main Menu', style: 'primary' }
    ],
    [
      { text: 'Set UPI ID', style: 'primary' },
      { text: 'Close', style: 'danger' }
    ]
  ]).resize().persistent(false);
}

// Render the exact itemized receipt and bill summary matching the user's template
// Render clean itemized receipt and bill summary without fake numbers or coordinate dumps
export function formatUserOrderCardText(order, isBossView = false) {
  const db = getDb();
  const selectedAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const accPhone = order.orderAccount || selectedAcc?.phone || selectedAcc?.mobile || null;
  const restName = order.restaurantName || order.restaurant || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : 'Swiggy Food Order');

  // Address section (clean, without internal GPS numbers)
  let ad = order.addressDetails || parseAddressDetails(order.address);
  let addrSection = '📍 <b>Delivering To:</b>\n';
  if (ad && (ad.name || ad.mobile || ad.address || ad.city)) {
    if (ad.name) addrSection += `👤 ${escapeHtml(ad.name)}\n`;
    if (ad.mobile) addrSection += `📱 ${escapeHtml(ad.mobile)}\n`;
    if (ad.address) addrSection += `🏠 ${escapeHtml(ad.address)}\n`;
    else if (ad.city) addrSection += `🏠 ${escapeHtml(ad.city)} Address\n`;
  } else if (order.address) {
    addrSection += `🔗 Address Link Attached ✅\n`;
  } else {
    addrSection += `<i>Address pending / not provided</i>\n`;
  }

  // Items section - Real items
  let itemsSection = '';
  if (order.items && Array.isArray(order.items) && order.items.length > 0) {
    const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    itemsSection = '\n' + order.items.map((it, idx) => {
      const emoji = numEmojis[idx] || `${idx + 1}️⃣`;
      const price = it.price ? it.price : Math.round(((it.lineTotal || 0) / (it.qty || 1)) * 100) / 100;
      const lineTotal = it.lineTotal || Math.round((price * it.qty) * 100) / 100;
      return `${emoji} ${escapeHtml(it.name)}\n💵 ₹${price} × ${it.qty} = ₹${lineTotal}`;
    }).join('\n\n') + '\n\n';

    const totalQty = order.items.reduce((s, it) => s + (it.qty || 1), 0);
    const subtotal = order.subtotal || Math.round(order.items.reduce((s, it) => s + (it.lineTotal || (it.price * it.qty)), 0) * 100) / 100;
    itemsSection += `📦 ${totalQty} Items • Subtotal: ₹${subtotal}\n\n`;
  } else {
    itemsSection = `\n🛒 <b>Swiggy Cart:</b> ${order.cart ? 'Link Attached ✅' : 'Pending'}\n\n`;
  }

  // Bill Summary section
  let billSection = '';
  if (order.finalPayable || order.subtotal) {
    billSection = `🧾 <b>Bill Summary:</b>\n`;
    if (order.subtotal) billSection += `🍽 Items Total: ₹${order.subtotal}\n`;
    if (order.couponCode && order.discountAmount > 0) {
      billSection += `🎟 Coupon Discount (${escapeHtml(order.couponCode)}): −₹${order.discountAmount}\n`;
    }
    if (order.freeCashApplied > 0) {
      billSection += `💸 Free Cash Applied: −₹${order.freeCashApplied}\n`;
    }
    if (order.swiggyOneApplied || order.freeDeliveryDiscount > 0) {
      const savedDel = order.freeDeliveryDiscount || order.deliverySaved || 42;
      billSection += `✨ Delivery Fee: FREE (₹${savedDel} saved)\n`;
    } else if (order.deliveryFee > 0) {
      billSection += `🚚 Delivery Fee: ₹${order.deliveryFee}\n`;
    }
    if (order.packingCharges > 0) billSection += `📦 Packing Charges: ₹${order.packingCharges}\n`;
    if (order.taxesAndCharges > 0) billSection += `🧾 GST & Charges: ₹${order.taxesAndCharges}\n`;
    billSection += `━━━━━━━━━━━━━━\n`;
    if (order.totalSavings > 0) billSection += `💰 Total Savings: ₹${order.totalSavings}\n`;
    if (order.finalPayable) billSection += `💳 <b>To Pay: ₹${order.finalPayable}</b>`;
  } else {
    billSection = `🧾 <b>Bill Summary:</b>\n` +
      `⏳ <i>Calculating bill on Swiggy Payment Page...</i>`;
  }

  if (order.swiggyPaymentUrl) {
    billSection += `\n\n🔗 <b>Official Swiggy Payment Link:</b>\n<a href="${escapeHtml(order.swiggyPaymentUrl)}">${escapeHtml(order.swiggyPaymentUrl)}</a>`;
  }

  const accountLine = (isBossView && accPhone) ? `📱 <b>Order Account:</b> ${escapeHtml(accPhone)}\n` : '';

  return accountLine +
    `🛒 <b>Your Cart:</b> ${escapeHtml(restName)}\n\n` +
    `${addrSection}` +
    itemsSection +
    billSection;
}

// Format User (Customer) Order Screen matching State Machine
function formatUserOrderCard(order) {
  const db = getDb();
  const slotsLeft = db.config.slotsLeft;
  const totalSlots = db.config.totalSlots;
  const header = `╔═════════════════════════╗\n   🟡  <b>Slots Left: ${slotsLeft}/${totalSlots}</b>  🟡\n╚═════════════════════════╝`;

  const buttons = [];
  let text = `${header}\n\n`;

  if (order.status === 'ACCEPTED') {
    text += `🎉 <b>Aapka Order Accept Ho Gaya Hai! (#${order.id})</b>\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      `📌 <b>Status:</b> <b>🟢 ACCEPTED & PROCESSING</b>\n\n` +
      `<i>Aapka Swiggy order process ho raha hai. Jald hi delivery tracking link mil jayega! 🛵</i>\n\n` +
      `👉 <b>Support:</b> @Its_life_001`;
    if (order.swiggyPaymentUrl) {
      buttons.push([Markup.button.url('💳 Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)]);
    }
    buttons.push([
      Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')
    ]);
    buttons.push([
      Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`),
      Markup.button.callback('🟠 Cancel Order', `action_cancel_order_confirm_${order.id}`)
    ]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  if (order.status === 'REJECTED') {
    text += `❌ <b>Order Reject Ho Gaya (#${order.id})</b>\n\n` +
      `<i>Beta ne filhal yeh order reject kar diya hai.</i>\n\n` +
      `Agar koi difficulty ya sawaal ho, toh kripya message karein:\n` +
      `👉 <b>Support:</b> @Its_life_001\n\n` +
      `<i>Naya order place karne ke liye neeche button dabayein:</i>`;
    buttons.push([
      Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')
    ]);
    buttons.push([
      Markup.button.callback('🔄 New Order', 'user_back_to_main')
    ]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // PENDING state
  // Check if Boss has reviewed and sent payment details to customer
  if (order.paymentSentToUser && (order.swiggyPaymentUrl || order.customQrFileId || order.finalPayable)) {
    const amt = order.finalPayable ? `₹${order.finalPayable}` : 'amount shown on Swiggy';
    text += `💳 <b>Official Swiggy Payment Ready! (#${order.id})</b>\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      `📌 <b>Status:</b> <b>💳 Official Swiggy Payment Ready</b>\n\n` +
      `<i>Neeche diye gaye QR code ya official button se <b>${amt}</b> pay karein, phir <b>[ 💸 I Have Paid / Confirm Payment ]</b> dabayein!</i>\n\n` +
      `👉 <b>Support:</b> @Its_life_001`;

    if (order.swiggyPaymentUrl) {
      buttons.push([Markup.button.url('💳 Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)]);
    }
    buttons.push([
      Markup.button.callback('💸 I Have Paid / Confirm Payment', `user_confirm_order_${order.id}`)
    ]);
    if (order.customQrFileId) {
      buttons.push([
        Markup.button.callback('📷 Resend Swiggy Payment QR', `user_resend_qr_${order.id}`)
      ]);
    }
  } else {
    // SHORT, MINIMAL screen after clicking Send to Beta (no overwhelming paragraphs!)
    const rest = order.restaurantName || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : 'Swiggy Food Order');
    const ad = order.addressDetails || parseAddressDetails(order.address);
    const cleanAddr = ad?.address ? (ad.address.slice(0, 50) + (ad.address.length > 50 ? '...' : '')) : (ad?.city ? `${ad.city} Address` : (order.address ? 'Address Attached ✅' : 'Pending'));

    text += `🚀 <b>Order Sent to Beta! (#${order.id})</b>\n\n` +
      `🏪 <b>Restaurant:</b> ${escapeHtml(rest)}\n` +
      `📍 <b>Delivering To:</b> ${escapeHtml(cleanAddr)}\n` +
      `📌 <b>Status:</b> <b>⏳ Sent to Beta (Under Review)</b>\n\n` +
      `<i>Beta aapke order ke details check karke best coupons apply kar raha hai.</i>\n` +
      `<i>Payment QR aur final bill jald hi yahan mil jayega! 🛵</i>\n\n` +
      `👉 <b>Support:</b> @Its_life_001`;
  }

  buttons.push([
    Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`),
    Markup.button.callback('🟠 Cancel Order', `action_cancel_order_confirm_${order.id}`)
  ]);
  buttons.push([
    Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')
  ]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// Format Detailed Account Review Card for Boss (Address History, Order Items, Coupons, Final Charges & Payment)
function formatBossAccountReviewCard(order) {
  const db = getDb();
  const acc = db.config?.accounts?.[order.selectedAccount];
  const accPhone = order.orderAccount || acc?.phone || acc?.mobile || 'Selected Account';
  const accName = acc?.name || accPhone;

  let text = `📱 <b>[ SWIGGY ACCOUNT: ${escapeHtml(accName)} (${escapeHtml(accPhone)}) ]</b>\n` +
    `🌸 <b>Order #${order.id} Review & Approval Screen</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 1. ADDRESS HISTORY & TARGET DELIVERY
  text += `📍 <b>ADDRESS HISTORY & TARGET DELIVERY:</b>\n`;
  const ad = order.addressDetails || parseAddressDetails(order.address);
  if (ad && (ad.address || ad.city || ad.name)) {
    text += `🏠 <b>Target Delivery:</b> ${escapeHtml(ad.address || ad.city || '')}${ad.name ? ` (${escapeHtml(ad.name)})` : ''}\n`;
  } else if (order.address) {
    text += `🔗 <b>Address Link:</b> <code>${escapeHtml(order.address)}</code>\n`;
  }
  if (order.accountAddresses && order.accountAddresses.length > 0) {
    text += `📋 <i>Account Saved Addresses (${order.accountAddresses.length}):</i>\n`;
    order.accountAddresses.slice(0, 4).forEach((a, idx) => {
      const tag = a.annotation ? `[${a.annotation}] ` : '';
      text += `  ${idx + 1}. ${escapeHtml(tag + a.address)}\n`;
    });
  } else {
    text += `ℹ️ <i>No prior saved addresses found on account. Target address will be used.</i>\n`;
  }
  text += '\n';

  // 2. ORDER ITEMS
  text += `🛒 <b>REAL ORDER ITEMS:</b>\n`;
  text += `🏪 <b>${escapeHtml(order.restaurantName || 'Swiggy Restaurant')}</b>\n`;
  if (order.items && order.items.length > 0) {
    const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    order.items.forEach((it, idx) => {
      const emoji = numEmojis[idx] || `${idx + 1}️⃣`;
      text += `${emoji} ${escapeHtml(it.name)} × ${it.qty} = ₹${it.lineTotal || (it.price * it.qty)}\n`;
    });
    text += `📦 <b>Subtotal: ₹${order.subtotal}</b>\n\n`;
  } else {
    text += `ℹ️ <i>Items synced directly in Swiggy Cart / Group Order</i>\n\n`;
  }

  // 3. COUPON & OFFERS
  text += `🎟 <b>COUPON & OFFERS:</b>\n`;
  if (order.couponCode) {
    text += `✅ <b>Applied Coupon:</b> <code>${escapeHtml(order.couponCode)}</code> (−₹${order.discountAmount || 0})\n`;
  } else {
    text += `⚠️ <i>No coupon applied currently</i>\n`;
  }
  if (order.availableCoupons && order.availableCoupons.length > 0) {
    const topCoupons = order.availableCoupons.slice(0, 5).map(c => c.code).join(', ');
    text += `💡 <b>Available on Account:</b> <code>${escapeHtml(topCoupons)}</code>\n`;
  }
  text += '\n';

  // 4. FINAL CHARGES
  text += `🧾 <b>FINAL CHARGES:</b>\n`;
  text += `🍽 Items Total: ₹${order.subtotal || 0}\n`;
  if (order.discountAmount > 0) text += `🎟 Coupon Discount: −₹${order.discountAmount}\n`;
  if (order.freeCashApplied > 0) text += `💸 Free Cash: −₹${order.freeCashApplied}\n`;
  if (order.swiggyOneApplied || order.freeDeliveryDiscount > 0) {
    text += `✨ Free Delivery: ₹0 (₹${order.freeDeliveryDiscount || 42} saved)\n`;
  } else if (order.deliveryFee > 0) {
    text += `🚚 Delivery Fee: ₹${order.deliveryFee}\n`;
  }
  if (order.packingCharges > 0) text += `📦 Packing Charges: ₹${order.packingCharges}\n`;
  if (order.taxesAndCharges > 0) text += `🧾 GST & Charges: ₹${order.taxesAndCharges}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  if (order.totalSavings > 0) text += `💰 <b>Total Savings: ₹${order.totalSavings}</b>\n`;
  text += `💳 <b>Final Amount To Pay: ₹${order.finalPayable || order.subtotal || 0}</b>\n\n`;

  // 5. PAYMENT STATUS
  text += `💳 <b>OFFICIAL SWIGGY PAYMENT:</b>\n`;
  if (order.customQrFileId || order.qrBuffer) {
    text += `📸 Official Payment QR: <b>Ready & Captured ✅</b>\n`;
  } else {
    text += `⏳ Payment QR: <i>Pending / Manual Capture</i>\n`;
  }
  if (order.swiggyPaymentUrl) {
    text += `🔗 Link: <a href="${escapeHtml(order.swiggyPaymentUrl)}">Open Swiggy Checkout</a>\n`;
  }
  text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (order.paymentSentToUser) {
    text += `\n🟢 <b>Status:</b> <b>Delivered to Customer (Awaiting Payment)</b>`;
  } else {
    text += `\n⚠️ <b>Review details above. Click [ 🚀 Send Bill & Payment QR to Customer ] when satisfied:</b>`;
  }

  const buttons = [];
  if (!order.paymentSentToUser) {
    buttons.push([
      Markup.button.callback('🚀 Send Bill & Payment QR to Customer', `boss_send_qr_to_user_${order.id}`)
    ]);
  } else {
    buttons.push([
      Markup.button.callback('🔄 Resend Bill & QR to Customer', `boss_send_qr_to_user_${order.id}`)
    ]);
  }
  buttons.push([
    Markup.button.callback('🔄 Switch Account', `boss_choose_acc_picker_${order.id}`),
    Markup.button.callback('🎟 Change Coupon', `boss_coupon_picker_${order.id}`)
  ]);
  if (order.accountAddresses && order.accountAddresses.length > 0) {
    buttons.push([
      Markup.button.callback('📍 Select Account Address', `boss_addr_picker_${order.id}`)
    ]);
  }
  buttons.push([
    Markup.button.callback('✅ Accept Order', `boss_action_accept_${order.id}`),
    Markup.button.callback('❌ Reject Order', `boss_action_sorry_${order.id}`)
  ]);
  buttons.push([
    Markup.button.callback('🔙 Back to Order Screen', `boss_back_to_order_${order.id}`)
  ]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// Formats high-clarity OTP Send Failure Card with exact real diagnosis
function formatOtpSendErrorCard(phone, result) {
  const reason = result.message || result.swiggyStatus || 'Swiggy API dwara OTP deliver nahi ho paya.';
  const details = result.details || (result.status ? `HTTP ${result.status}` : '');

  const text = `❌ <b>Swiggy OTP Send Failed!</b>\n` +
    `📱 <b>Number:</b> <code>${phone}</code>\n\n` +
    `⚠️ <b>Asli Wajah (Real Reason):</b>\n` +
    `<blockquote>${escapeHtml(reason)}</blockquote>\n` +
    (details ? `🔍 <i>Diagnostic Info: ${escapeHtml(details)}</i>\n\n` : '') +
    `💡 <i>Agar Swiggy baar-baar block kar raha ho toh <b>Session JSON</b> paste karein (Bina OTP ke turant login ho jata hai).</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Retry Send OTP', `resend_otp_${phone}`),
      Markup.button.callback('📱 Try Another Number', 'send_to_another_number')
    ],
    [
      Markup.button.callback('📋 Paste Session JSON', 'boss_login_with_json'),
      Markup.button.callback('🏠 Main Menu', 'boss_panel_home')
    ]
  ]);

  return { text, keyboard };
}

// User Screen Generator - Clean minimal UI with interactive buttons for Cart, Address & Send to Beta
function getUserScreen(userId, user) {
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return formatUserOrderCard(activeOrder);
  }

  const db = getDb();
  const draft = getDraft(userId);
  const slotsLeft = db.config.slotsLeft;
  const totalSlots = db.config.totalSlots;

  const cartBtnText = draft.cart ? '🟣 Cart: Added ✅' : '🟣 Paste Cart Link';
  const addressBtnText = draft.address ? '🔵 Address: Added ✅' : '🔵 Paste Address Link';

  const inlineButtons = [
    [
      Markup.button.callback(cartBtnText, 'action_paste_cart'),
      Markup.button.callback(addressBtnText, 'action_paste_address')
    ],
    [
      Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')
    ]
  ];

  if (draft.cart || draft.address) {
    inlineButtons.push([
      Markup.button.callback('🟠 Cancel Draft', 'action_clear_draft')
    ]);
  }

  let promptGuidance = '';
  if (!draft.cart && !draft.address) {
    promptGuidance = `👉 <i>Niche diye gaye buttons se link add karein:</i>`;
  } else if (draft.cart && !draft.address) {
    promptGuidance = `👉 <i>Cart link add ho gaya! Ab <b>[ 🔵 Paste Address Link ]</b> dabakar address link share karein.</i>`;
  } else if (!draft.cart && draft.address) {
    promptGuidance = `👉 <i>Address link add ho gaya! Ab <b>[ 🟣 Paste Cart Link ]</b> dabakar Swiggy cart link share karein.</i>`;
  } else {
    promptGuidance = `🎉 <b>Dono links verified hain!</b>\n👉 Niche <b>[ 🚀 Send to Beta ]</b> dabayein:`;
  }

  const text = `╔═════════════════════════╗\n   🟡  <b>Slots Left: ${slotsLeft}/${totalSlots}</b>  🟡\n╚═════════════════════════╝\n\n` +
    `👋 <b>Swiggy Food Order</b>\n\n` +
    `🟣 <b>Cart Link:</b> ${draft.cart ? '✅ <code>' + escapeHtml(draft.cart) + '</code>' : '<i>Not added yet</i>'}\n` +
    `🔵 <b>Address Link:</b> ${draft.address ? '✅ <code>' + escapeHtml(draft.address) + '</code>' : '<i>Not added yet</i>'}\n\n` +
    promptGuidance;

  return { text, keyboard: Markup.inlineKeyboard(inlineButtons) };
}

// Boss Panel Text
function getBossPanelText() {
  const db = getDb();
  const pendingCount = Object.values(db.orders).filter(o => o.status === 'PENDING').length;
  const acceptedCount = Object.values(db.orders).filter(o => o.status === 'ACCEPTED').length;
  const completedCount = Object.values(db.orders).filter(o => o.status === 'COMPLETED').length;

  const accounts = db.config.accounts || {};
  let accText = '';
  for (const [key, acc] of Object.entries(accounts)) {
    const status = acc.isLoggedIn ? `🟢 Logged In (${acc.phone || 'Ready'})` : '⚪ Not Logged In';
    accText += `• ${acc.name || key}: <b>${status}</b>\n`;
  }

  return `👑 <b>BOSS CARE & SWIGGY PANEL</b>\n\n` +
    `👥 <b>Connected Swiggy Accounts (${Object.keys(accounts).length}):</b>\n` +
    (accText || '<i>No accounts added yet. Tap [ ➕ Add Account ] below.</i>\n') + '\n' +
    `📊 <b>Orders Overview:</b>\n` +
    `• ⏳ Pending: <b>${pendingCount}</b> | 🟢 In Progress: <b>${acceptedCount}</b> | 🏁 Done: <b>${completedCount}</b>\n\n` +
    `<i>Tap "➕ Add New Account" or "🔑 Login an Account" to manage accounts independently!</i>`;
}

function getBossPanelKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Login with Number', callback_data: 'boss_login_with_number', style: 'primary' },
          { text: 'Login with JSON', callback_data: 'boss_login_with_json', style: 'primary' }
        ],
        [
          { text: 'View Accounts', callback_data: 'boss_view_accounts', style: 'primary' },
          { text: 'Refresh All Accounts', callback_data: 'boss_refresh_all_accounts', style: 'primary' }
        ],
        [
          { text: 'Export Accounts', callback_data: 'boss_export_picker', style: 'primary' },
          { text: 'Pending Orders', callback_data: 'boss_view_pending', style: 'primary' }
        ],
        [
          { text: '🗑️ Cancelled Orders', callback_data: 'boss_view_cancelled_orders', style: 'danger' }
        ],
        [
          { text: 'Total Slots', callback_data: 'boss_prompt_total_slots', style: 'primary' },
          { text: 'Total Left', callback_data: 'boss_prompt_slots_left', style: 'primary' }
        ],
        [
          { text: '🎁 Claim ₹50 Off Offers (All Accounts)', callback_data: 'boss_claim_all_event_offers', style: 'success' }
        ],
        [
          { text: 'Claim Free Cash', callback_data: 'boss_claim_freecash', style: 'success' },
          { text: 'Set UPI ID', callback_data: 'boss_prompt_set_upi', style: 'primary' }
        ],
        [
          { text: 'Refresh Status', callback_data: 'boss_refresh', style: 'primary' },
          { text: 'Close', callback_data: 'close_menu', style: 'danger' }
        ]
      ]
    }
  };
}

function makeCopyButton(label, value, fallbackCallback, style = 'primary') {
  if (value && value.length > 0 && value.length <= 256) {
    return { text: label, copy_text: { text: value }, style };
  }
  return { text: label, callback_data: fallbackCallback, style };
}

// Format Order Card for Boss (Ultra Compact, Clean & State-Driven)
function formatBossOrderCard(order) {
  let statusBadge = '⏳ PENDING';
  if (order.status === 'ACCEPTED') statusBadge = '🟢 ACCEPTED';
  else if (order.status === 'REJECTED') statusBadge = '❌ REJECTED';
  else if (order.status === 'COMPLETED') statusBadge = '🏁 ORDER SUCCESS';
  else if (order.status === 'CANCELLED') statusBadge = `🗑️ ORDER CANCELLED (#${order.id})`;

  const userProfileUrl = `tg://user?id=${order.userId}`;
  const senderLink = `<a href="${userProfileUrl}">${escapeHtml(order.userName || 'Customer')}</a>`;
  const idLink = `<a href="${userProfileUrl}">${order.userId}</a>`;
  const handleText = order.handle ? ` (@${escapeHtml(order.handle.replace(/^@/, ''))})` : '';

  const paymentStepNote = order.qrSent
    ? `\n💳 <i>Status: waiting for user payment (if user confirms, send tracking link)</i>\n`
    : (order.paymentSentToUser ? `\n⏳ <i>Status: waiting for user confirmation — get qr here once confirmed</i>\n` : '');

  let text = `🌸 <b>[ ORDER #${order.id} ] — ${statusBadge}</b>\n\n` +
    `👤 <b>Customer:</b> ${senderLink}${handleText}\n` +
    `🆔 <b>User ID:</b> ${idLink}\n\n` +
    formatUserOrderCardText(order) + '\n' +
    paymentStepNote + '\n';

  if (order.cart) text += `🛒 <b>Cart Link:</b>\n<code>${escapeHtml(order.cart)}</code>\n\n`;
  if (order.address) text += `📍 <b>Address Link / Location:</b>\n<code>${escapeHtml(order.address)}</code>\n`;

  text += `⏰ <b>Time:</b> ${new Date(order.createdAt || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n`;

  const rows = [];
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const accEntries = Object.entries(accounts);

  // STATE 1: PENDING Order -> Boss can immediately choose account, Accept/Reject, open links, and send genuine payment QR
  if (order.status === 'PENDING') {
    // 1. ACCOUNT PICKER ROW(S) DIRECTLY ON ORDER CARD
    if (order.selectedAccount && accounts[order.selectedAccount]) {
      const curAcc = accounts[order.selectedAccount];
      const curPhone = curAcc.phone || curAcc.mobile || curAcc.name || order.selectedAccount;
      rows.push([
        Markup.button.callback(`📱 Active Acc: ${curPhone} ✅`, `boss_choose_acc_picker_${order.id}`),
        Markup.button.callback('🔄 Switch Acc', `boss_choose_acc_picker_${order.id}`)
      ]);
    } else {
      // Order just arrived! Give Boss immediate account choice buttons!
      const loggedInAccs = accEntries.filter(([k, a]) => a.isLoggedIn || a.cookies);
      const topAccs = loggedInAccs.length > 0 ? loggedInAccs.slice(0, 4) : accEntries.slice(0, 4);

      for (let i = 0; i < topAccs.length; i += 2) {
        const row = [];
        const [k1, a1] = topAccs[i];
        const p1 = a1.phone || a1.mobile || a1.name || k1;
        row.push(Markup.button.callback(`📱 Use: ${p1}`, `boss_select_acc_${order.id}_${k1}`));
        if (topAccs[i + 1]) {
          const [k2, a2] = topAccs[i + 1];
          const p2 = a2.phone || a2.mobile || a2.name || k2;
          row.push(Markup.button.callback(`📱 Use: ${p2}`, `boss_select_acc_${order.id}_${k2}`));
        }
        rows.push(row);
      }
      if (accEntries.length > 4) {
        rows.push([
          Markup.button.callback(`👥 Choose Other Acc (${accEntries.length} Total)`, `boss_choose_acc_picker_${order.id}`)
        ]);
      }
    }

    rows.push([
      Markup.button.callback('✅ Accept Order', `boss_action_accept_${order.id}`),
      Markup.button.callback('❌ Reject Order', `boss_action_sorry_${order.id}`)
    ]);
    rows.push([
      makeCopyButton('🟣 Copy Cart', order.cart || '', `boss_copy_cart_${order.id}`),
      makeCopyButton('🔵 Copy Address', order.address || '', `boss_copy_addr_${order.id}`)
    ]);
    rows.push([
      Markup.button.callback('💬 Message User', `boss_text_user_${order.id}`)
    ]);
  }
  // STATE 2: ACCEPTED Order -> Tracking, Done, Reject, Copy, Message User
  else if (order.status === 'ACCEPTED') {
    if (order.selectedAccount && accounts[order.selectedAccount]) {
      const curAcc = accounts[order.selectedAccount];
      const curPhone = curAcc.phone || curAcc.mobile || curAcc.name || order.selectedAccount;
      rows.push([
        Markup.button.callback(`📱 Active Acc: ${curPhone} ✅`, `boss_choose_acc_picker_${order.id}`),
        Markup.button.callback('🔄 Switch Acc', `boss_choose_acc_picker_${order.id}`)
      ]);
    }

    rows.push([
      makeCopyButton('🟣 Copy Cart', order.cart || '', `boss_copy_cart_${order.id}`),
      makeCopyButton('🔵 Copy Address', order.address || '', `boss_copy_addr_${order.id}`)
    ]);
    rows.push([
      Markup.button.callback('💬 Message User', `boss_text_user_${order.id}`),
      Markup.button.callback('🛵 Send Tracking', `boss_tracking_${order.id}`)
    ]);
    rows.push([
      Markup.button.callback('🟢 Mark Done', `boss_action_done_${order.id}`),
      Markup.button.callback('❌ Reject Order', `boss_action_sorry_${order.id}`)
    ]);
  }
  // OTHER STATES (REJECTED / CANCELLED / COMPLETED)
  else {
    rows.push([
      Markup.button.callback('💬 Message User', `boss_text_user_${order.id}`)
    ]);
    rows.push([
      makeCopyButton('🟣 Copy Cart', order.cart || '', `boss_copy_cart_${order.id}`),
      makeCopyButton('🔵 Copy Address', order.address || '', `boss_copy_addr_${order.id}`)
    ]);
  }

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// Single card in-place updater for Boss and User
async function updateOrderCards(order) {
  const db = getDb();

  // 1. Update Boss card in-place
  if (order.bossMessageIds) {
    const bossCard = formatBossOrderCard(order);
    for (const [bossId, msgId] of Object.entries(order.bossMessageIds)) {
      try {
        await bot.telegram.editMessageText(
          bossId,
          msgId,
          null,
          bossCard.text,
          { parse_mode: 'HTML', ...bossCard.keyboard }
        );
      } catch (e) {}
    }
  }

  // 2. Update User card in-place
  if (order.userChatId && order.userMessageId) {
    const userCard = formatUserOrderCard(order);
    try {
      await bot.telegram.editMessageText(
        order.userChatId,
        order.userMessageId,
        null,
        userCard.text,
        { parse_mode: 'HTML', ...userCard.keyboard }
      );
    } catch (e) {}
  }
}

// Delete order card messages from all boss chats and customer chat
async function deleteOrderMessages(order) {
  if (!order) return;
  // 1. Delete all boss card messages
  if (order.bossMessageIds) {
    for (const [bossId, msgId] of Object.entries(order.bossMessageIds)) {
      try {
        await bot.telegram.deleteMessage(bossId, msgId);
      } catch (e) {}
    }
  }
  // 2. Delete user card message
  if (order.userChatId && order.userMessageId) {
    try {
      await bot.telegram.deleteMessage(order.userChatId, order.userMessageId);
    } catch (e) {}
  }
}

// Send authentic Swiggy payment details to User (NEVER synthetic fake upi://pay)
async function sendPaymentQrToUser(order) {
  if (!order) return;
  const targetChat = order.userChatId || order.userId;
  if (!targetChat) return;

  // 1. Ensure personalized QR code with customer's Telegram name in center of QR
  if (!order.genuineQrBuffer && !order.customQrFileId && (order.finalPayable || order.subtotal)) {
    const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
    const db = getDb();
    const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
    const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;
    try {
      const generatedBuf = await generatePersonalizedQrCard({
        customerName: custDisplayName,
        restaurantName: order.restaurantName || 'Swiggy Food Order',
        amount: order.finalPayable || order.subtotal || 0,
        savings: order.totalSavings || 0,
        upiUrl: upiUri
      });
      if (generatedBuf) {
        order.genuineQrBuffer = generatedBuf;
        saveDb(db);
      }
    } catch (e) {
      console.warn('[sendPaymentQrToUser] Card generation fallback:', e.message);
    }
  }

  // 2. If genuine custom QR photo from Swiggy was uploaded by Boss OR captured by automation
  if (order.customQrFileId || order.genuineQrBuffer) {
    try {
      const payable = order.finalPayable ? `₹${order.finalPayable}` : 'As shown on Swiggy';
      const photoSource = order.customQrFileId || { source: Buffer.from(order.genuineQrBuffer) };
      await bot.telegram.sendPhoto(targetChat, photoSource, {
        caption: `🟢 <b>Official Swiggy Payment QR (Order #${order.id})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Payable on Swiggy:</b> <b>${payable}</b>\n\n` +
          `<i>Scan this genuine Swiggy QR code in PhonePe / Google Pay / Paytm / BHIM to pay directly to Swiggy:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💸 I Have Paid / Confirm Payment', `user_confirm_order_${order.id}`)],
          [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      });
      order.qrSent = true;
      order.qrDelivered = true;
      saveDb(getDb());
      return;
    } catch (e) {
      console.error(`Failed to send custom QR photo: ${e.message}`);
    }
  }

  // 2. If genuine Swiggy payment URL was generated by Swiggy / Boss
  if (order.swiggyPaymentUrl) {
    try {
      await bot.telegram.sendMessage(
        targetChat,
        `💳 <b>Official Swiggy Payment Link (Order #${order.id})</b>\n\n` +
        `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
        (order.finalPayable ? `💰 <b>Amount:</b> ₹${order.finalPayable}\n\n` : '\n') +
        `🔗 <b>Click to Pay Directly on Swiggy:</b>\n<a href="${escapeHtml(order.swiggyPaymentUrl)}">${escapeHtml(order.swiggyPaymentUrl)}</a>\n\n` +
        `<i>✨ Yeh authentic link Swiggy payment page se generated hai. Payment complete karke [ 💸 I Have Paid ] dabayein!</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('💳 Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)],
            [Markup.button.callback('💸 I Have Paid / Confirm Payment', `user_confirm_order_${order.id}`)],
            [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
          ])
        }
      );
      order.qrSent = true;
      saveDb(getDb());
      return;
    } catch (e) {
      console.error(`Failed to send payment URL: ${e.message}`);
    }
  }

  // 3. If payment link/QR not yet ready from Swiggy, inform customer with real status (NO FAKE UPI QR!)
  try {
    await bot.telegram.sendMessage(
      targetChat,
      `⏳ <b>Swiggy Payment Link / QR Processing (Order #${order.id})</b>\n\n` +
      `Beta aapka cart Swiggy par open karke maximum discount & coupons verify kar raha hai.\n` +
      `Swiggy payment page se authentic link/QR aate hi yahan turant bhej diya jayega.\n\n` +
      `👉 <b>Immediate Help:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`)],
          [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  } catch (e) {}
}

// Asynchronous Cart & Address Inspection (runs on order submission or manual refresh — resolves live Group Cart, geocodes address, and preloads saved account addresses)
async function triggerBackgroundCartFetch(orderId) {
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return;

  console.log(`[AutoFetch] Starting live cart & address resolution for Order #${orderId}...`);

  // Helper to safely merge non-empty address fields without overwriting valid street/coords with blanks or shortlink placeholders
  const mergeAddressSafe = (target, incoming) => {
    if (!incoming || incoming.unresolvableShortLink) return target;
    const base = { ...(target || {}) };
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== null && v !== undefined && v !== '' && k !== 'unresolvableShortLink') {
        base[k] = v;
      }
    }
    return base;
  };

  // 1. Parse & geocode address details from full original text + link
  const rawAddrInput = order.addressOriginalText || order.address || '';
  if (rawAddrInput) {
    const parsedAddr = parseAddressDetails(rawAddrInput);
    if (parsedAddr) {
      order.addressDetails = mergeAddressSafe(order.addressDetails, parsedAddr);
    }
    try {
      const addrMeta = await resolveSwiggyLink(rawAddrInput);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        order.addressDetails = mergeAddressSafe(order.addressDetails, addrMeta.addressDetails);
      }
      if (addrMeta?.ofoUser && !order.addressDetails?.name) {
        order.addressDetails = { ...(order.addressDetails || {}), name: addrMeta.ofoUser };
      }
    } catch (e) {}
  }

  if (order.addressDetails) {
    try {
      order.addressDetails = await geocodeAddressDetails(order.addressDetails);
      if (order.addressDetails?.address && (!order.address || order.address.startsWith('http'))) {
        order.addressLink = order.addressLink || (order.address?.startsWith('http') ? order.address : null);
        order.address = order.addressDetails.address;
      }
    } catch (e) {}
  }

  // Preload saved addresses across all logged-in Swiggy accounts for 1-tap Boss picker & bare-shortlink fallback
  try {
    const allSaved = await fetchAllAccountsSavedAddresses();
    if (allSaved.length > 0) {
      order.accountAddresses = allSaved;
    }
  } catch (e) {}

  // 2. Resolve live Group Cart / Restaurant Menu / Personal Cart
  if (order.cart) {
    try {
      const cartMeta = await resolveSwiggyLink(order.cart);
      if (cartMeta?.restaurantId) order.restaurantId = cartMeta.restaurantId;
      if (cartMeta?.restaurantName) order.restaurantName = cartMeta.restaurantName;
      if (cartMeta?.hostName) order.hostName = cartMeta.hostName;
      if (cartMeta?.groupCartId) order.groupCartId = cartMeta.groupCartId;
      if (cartMeta?.groupCartStatus) order.groupCartStatus = cartMeta.groupCartStatus;

      if (cartMeta?.cartDetails) {
        const cd = cartMeta.cartDetails;
        if (cd.restaurantName) order.restaurantName = cd.restaurantName;
        if (cd.items && cd.items.length > 0) {
          order.items = cd.items;
          order.itemTotal = cd.itemsTotal || cd.subtotal || 0;
          order.subtotal = cd.subtotal || cd.itemsTotal || 0;
          if (cd.tradeDiscountTotal !== undefined) order.tradeDiscountTotal = cd.tradeDiscountTotal;
          if (cd.couponCode) { order.couponCode = cd.couponCode; order.discountAmount = cd.discountAmount || 0; }
          if (cd.freeCashApplied > 0) order.freeCashApplied = cd.freeCashApplied;
          if (cd.freeDelivery) { order.swiggyOneApplied = true; order.freeDeliveryDiscount = cd.deliverySaved || 0; }
          if (cd.packingCharges !== undefined) order.packingCharges = cd.packingCharges;
          if (cd.gstCharges !== undefined) order.taxesAndCharges = cd.gstCharges;
          if (cd.finalPayable > 0) {
            order.finalPayable = cd.finalPayable;
            order.swiggyVerified = true;
          } else {
            order.swiggyVerified = false;
            applyMaxOfferToOrder(order);
          }
        }
      }

      // If no groupCartId items yet, check selected / active account personal cart when restaurant matches
      if ((!order.items || order.items.length === 0) && !order.groupCartId) {
        const targetKey = order.selectedAccount || getActiveOrderAccountKey(db);
        const targetAcc = db.config?.accounts?.[targetKey];
        if (targetAcc?.cookies) {
          const livePersonal = await inspectCartForAccount(targetAcc);
          if (livePersonal?.items?.length > 0 && (!order.restaurantId || String(livePersonal.restaurantId) === String(order.restaurantId))) {
            order.items = livePersonal.items;
            order.restaurantId = livePersonal.restaurantId || order.restaurantId;
            if (livePersonal.restaurantName) order.restaurantName = livePersonal.restaurantName;
            order.itemTotal = livePersonal.itemTotal;
            order.subtotal = livePersonal.subtotal;
            order.tradeDiscountTotal = livePersonal.tradeDiscountTotal || 0;
            order.deliveryFee = livePersonal.deliveryFee || 0;
            order.packingCharges = livePersonal.packingCharges || 0;
            order.taxesAndCharges = livePersonal.taxesAndCharges || 0;
            order.couponCode = livePersonal.couponCode || order.couponCode || null;
            order.discountAmount = livePersonal.discountAmount || 0;
            order.finalPayable = livePersonal.finalPayable;
            order.totalSavings = livePersonal.totalSavings;
            order.swiggyVerified = true;
          }
        }
      }
    } catch (e) {
      console.error(`[AutoFetch] Cart resolution error on Order #${orderId}:`, e.message);
    }
  }

  // 3. Clean fallback restaurant name only if still blank
  if (!order.restaurantName) {
    order.restaurantName = order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : (order.hostName ? `${order.hostName}'s Group Order` : 'Swiggy Food Order');
  }

  saveDb(db);
  await updateOrderCards(order);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendSafeHtml(ctx, text, extra = {}) {
  const maxLen = 3800;
  if (!text || text.length <= maxLen) {
    if (ctx && typeof ctx.reply === 'function') {
      return ctx.reply(text, { parse_mode: 'HTML', ...extra });
    } else {
      const chatId = ctx?.chat?.id || ctx;
      return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
    }
  }

  const parts = text.split('\n\n');
  const chunks = [];
  let cur = '';
  for (const part of parts) {
    if ((cur + '\n\n' + part).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = part;
    } else {
      cur = cur ? cur + '\n\n' + part : part;
    }
  }
  if (cur) chunks.push(cur);

  let lastMsg = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const opts = { parse_mode: 'HTML', ...(isLast ? extra : {}) };
    if (ctx && typeof ctx.reply === 'function') {
      lastMsg = await ctx.reply(chunks[i], opts);
    } else {
      const chatId = ctx?.chat?.id || ctx;
      lastMsg = await bot.telegram.sendMessage(chatId, chunks[i], opts);
    }
  }
  return lastMsg;
}

// Safe helper specifically for boss/user order cards (inline keyboards + long text)
async function sendCardSafe(chatIdOrCtx, card) {
  const { text, keyboard } = card;
  const isCtx = chatIdOrCtx && typeof chatIdOrCtx.reply === 'function';
  const safeTxt = text && text.length > 3800
    ? text.slice(0, 3740) + '\n\n<i>…(truncated)</i>'
    : text;
  if (isCtx) {
    return chatIdOrCtx.reply(safeTxt, { parse_mode: 'HTML', ...keyboard });
  }
  return bot.telegram.sendMessage(chatIdOrCtx, safeTxt, { parse_mode: 'HTML', ...keyboard });
}

async function sendPendingOrdersToBoss(bossId) {
  const db = getDb();
  const pendingOrders = Object.values(db.orders).filter(o => o.status === 'PENDING');

  if (pendingOrders.length === 0) {
    await bot.telegram.sendMessage(bossId, '📭 <i>No pending requests right now.</i>', { parse_mode: 'HTML' });
    return;
  }

  await bot.telegram.sendMessage(bossId, `📬 <b>Pending Requests (${pendingOrders.length}):</b>`, { parse_mode: 'HTML' });
  for (const order of pendingOrders) {
    const card = formatBossOrderCard(order);
    await sendCardSafe(bossId, card);
  }
}

bot.action('boss_view_pending', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await sendPendingOrdersToBoss(ctx.from.id);
});

// View all Cancelled & Rejected Orders with full details
async function showCancelledOrders(ctx) {
  const db = getDb();
  const allOrders = Object.values(db.orders || {});
  const cancelledOrders = allOrders
    .filter(o => o.status === 'CANCELLED' || o.status === 'REJECTED')
    .sort((a, b) => new Date(b.cancelledAt || b.rejectedAt || b.createdAt || 0) - new Date(a.cancelledAt || a.rejectedAt || a.createdAt || 0));

  if (cancelledOrders.length === 0) {
    const emptyText = `🗑️ <b>Koi bhi Cancelled Order nahi mila!</b>\n\nAbhi tak koi order cancel ya reject nahi hua hai.`;
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]])
      }).catch(async () => {
        await ctx.reply(emptyText, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
      });
    }
    return ctx.reply(emptyText, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }

  // Show latest 10 cancelled orders
  const displayOrders = cancelledOrders.slice(0, 10);
  let text = `🗑️ <b>CANCELLED ORDERS LIST (${displayOrders.length} of ${cancelledOrders.length}):</b>\n`;
  text += `────────────────────\n`;

  for (const o of displayOrders) {
    const userProfileUrl = `tg://user?id=${o.userId}`;
    const userLink = `<a href="${userProfileUrl}">${escapeHtml(o.userName || 'Customer')}</a>`;
    const idLink = `<a href="${userProfileUrl}">${o.userId}</a>`;
    const timeStr = new Date(o.cancelledAt || o.rejectedAt || o.createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rest = o.restaurantName || o.restaurant || 'N/A';
    const amt = o.finalPayable || o.amount || 0;

    text += `\n📦 <b>Order #${o.id}</b> [${o.status}]\n` +
      `👤 <b>Customer:</b> ${userLink} (TG ID: ${idLink})\n` +
      `🏪 <b>Restaurant:</b> ${escapeHtml(rest)}\n` +
      `💰 <b>Amount:</b> ₹${amt}\n` +
      (o.cart ? `🛒 <b>Cart:</b> <a href="${escapeHtml(o.cart)}">Open Cart Link</a>\n` : '') +
      (o.address ? `📍 <b>Address:</b> ${o.address.startsWith('http') ? `<a href="${escapeHtml(o.address)}">Open Address Link</a>` : `<code>${escapeHtml(o.address)}</code>`}\n` : '') +
      `⏰ <b>Cancelled At:</b> ${timeStr}\n` +
      `────────────────────\n`;
  }

  const buttons = [
    [
      Markup.button.callback('🔄 Refresh List', 'boss_view_cancelled_orders'),
      Markup.button.callback('🔙 Back to Panel', 'boss_refresh')
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (e) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    }
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard(buttons)
    });
  }
}

bot.action('boss_view_cancelled_orders', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showCancelledOrders(ctx);
});

bot.hears(['Cancelled Orders', '🗑️ Cancelled Orders', 'cancelled orders', '/cancelled'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showCancelledOrders(ctx);
});

// ================= SUCCESS ORDERS ARCHIVE =================

async function showSuccessOrdersArchive(ctx, selectedDate = null) {
  const db = getDb();
  const completedOrders = Object.values(db.orders || {})
    .filter(o => o.status === 'COMPLETED')
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  if (completedOrders.length === 0) {
    const emptyText = `🏆 <b>Success Orders Archive</b>\n\n<i>Abhi tak koi successful order nahi hai.</i>`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]]);
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyText, { parse_mode: 'HTML', ...kb }).catch(() => ctx.reply(emptyText, { parse_mode: 'HTML', ...kb }));
    }
    return ctx.reply(emptyText, { parse_mode: 'HTML', ...kb });
  }

  // Group by Date string DD-MM-YYYY
  const dateMap = {};
  for (const o of completedOrders) {
    const dt = new Date(o.completedAt || o.createdAt || Date.now());
    const dStr = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
    if (!dateMap[dStr]) dateMap[dStr] = [];
    dateMap[dStr].push(o);
  }

  const today = new Date();
  const todayStr = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
  const yest = new Date(Date.now() - 86400000);
  const yestStr = `${String(yest.getDate()).padStart(2, '0')}-${String(yest.getMonth() + 1).padStart(2, '0')}-${yest.getFullYear()}`;

  // If no date selected yet, ask "Which date of history do you wanna see?"
  if (!selectedDate) {
    let text = `🏆 <b>Success Orders Archive</b>\n\n` +
      `📅 <b>Which date of history do you wanna see?</b>\n\n` +
      `📊 <b>Total Completed Orders:</b> <code>${completedOrders.length}</code>\n` +
      `💰 <b>Total Lifetime Volume:</b> <code>₹${completedOrders.reduce((s, o) => s + (o.finalPayable || 0), 0)}</code>\n\n` +
      `<i>Neeche diye gaye dates me se choose karein:</i>`;

    const buttons = [];
    const dateKeys = Object.keys(dateMap).sort().reverse();
    for (const dKey of dateKeys) {
      let label = `📅 ${dKey} (${dateMap[dKey].length} orders)`;
      if (dKey === todayStr) label = `📅 Today (${dKey}) [${dateMap[dKey].length}]`;
      else if (dKey === yestStr) label = `📅 Yesterday (${dKey}) [${dateMap[dKey].length}]`;
      buttons.push([Markup.button.callback(label, `boss_archive_date_${dKey}`)]);
    }
    buttons.push([Markup.button.callback(`🌐 All Dates (${completedOrders.length} orders)`, 'boss_archive_date_all')]);
    buttons.push([Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]);

    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  // Display orders for the selected date
  const ordersToShow = selectedDate === 'all' ? completedOrders : (dateMap[selectedDate] || []);
  const title = selectedDate === 'all' ? 'All Dates' : selectedDate;
  const totalRev = ordersToShow.reduce((s, o) => s + (o.finalPayable || 0), 0);

  let text = `🏆 <b>Success Orders Archive — ${title}</b>\n` +
    `📊 <b>Total Orders:</b> ${ordersToShow.length} | 💰 <b>Total Volume:</b> ₹${totalRev}\n\n`;

  ordersToShow.slice(0, 10).forEach((o, idx) => {
    const accName = o.selectedAccount ? (db.config.accounts?.[o.selectedAccount]?.name || o.selectedAccount) : 'Default';
    const timeStr = new Date(o.completedAt || o.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const itemsStr = o.items && o.items.length ? o.items.map(i => `${i.name} x${i.qty || 1}`).join(', ') : 'Swiggy Food Items';
    text += `<b>${idx + 1}. [ #${o.id} ] — ₹${o.finalPayable || 0}</b>\n` +
      `👤 <b>Customer:</b> ${escapeHtml(o.userName || 'Customer')} (<code>${o.userId}</code>)\n` +
      `🏪 <b>Restaurant:</b> ${escapeHtml(o.restaurantName || 'Swiggy')}\n` +
      `🍽️ <b>Items:</b> ${escapeHtml(itemsStr)}\n` +
      `🟣 <b>Account:</b> ${escapeHtml(accName)} | ⏰ <b>Completed:</b> ${timeStr}\n\n`;
  });

  if (ordersToShow.length > 10) {
    text += `<i>...and ${ordersToShow.length - 10} more orders.</i>\n`;
  }

  const buttons = [
    [Markup.button.callback('📅 Choose Another Date', 'boss_view_archive')],
    [Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]
  ];

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.action('boss_view_archive', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showSuccessOrdersArchive(ctx);
});

bot.action(/^boss_archive_date_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const dateKey = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  await showSuccessOrdersArchive(ctx, dateKey);
});

bot.hears(['Success Archive', '🏆 Success Archive', 'success archive', '/archive', 'Archive'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showSuccessOrdersArchive(ctx);
});

// ================= COMMANDS =================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];

  if (isBoss(userId)) {
    await ctx.reply(`👑 Welcome back, <b>Boss</b>! Swiggy Family Care Admin Mode is active.`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    await ctx.reply(getBossPanelText(), {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  const draft = getDraft(userId);
  await ctx.reply(
    `👋 <b>Welcome to Swiggy Slot Bot!</b>\n\n` +
    `Swiggy order ke liye apna <b>Cart link</b> aur <b>Delivery Address link</b> share karein:\n\n` +
    `👉 Pehle <b>Cart link</b> bhejein ya <b>Address link</b> bhejein, fir <b>[ 🚀 Send to Beta ]</b> daba dein!`,
    {
      parse_mode: 'HTML',
      ...getUserReplyKeyboard(draft)
    }
  );

  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.command(['boss', 'admin'], async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.trim().split(' ');
  const password = args[1];

  if (isBoss(userId)) {
    delete userWaitState[userId];
    await ctx.reply(`👑 <b>Boss Mode Activated</b>`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    await ctx.reply(getBossPanelText(), {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  if (password === BOSS_SECRET) {
    addBoss(userId);
    await ctx.reply(`🎉 <b>Authorization successful!</b>`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    await ctx.reply(getBossPanelText(), {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  await ctx.reply(`⛔ <b>Access Denied:</b> Reserved for Boss only.`, { parse_mode: 'HTML' });
});

// ================= UPI ID CONFIGURATION =================

bot.command('setupi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    const db = getDb();
    const cur = db.config?.bossUpiId || 'swiggy@icici';
    return ctx.reply(`💳 Current Payment UPI ID: <code>${cur}</code>\n\nChange with: <code>/setupi yourname@upi</code>`, { parse_mode: 'HTML' });
  }
  const newUpi = parts[1].trim();
  const db = getDb();
  db.config.bossUpiId = newUpi;
  saveDb(db);
  await ctx.reply(`✅ <b>Payment UPI ID updated to:</b> <code>${newUpi}</code>\nAb se generated QR par payment seedha is ID par aayega!`, { parse_mode: 'HTML' });
});

bot.action('boss_prompt_set_upi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
  const db = getDb();
  const cur = db.config?.bossUpiId || 'swiggy@icici';
  await ctx.reply(
    `💳 <b>Enter your UPI ID (VPA):</b>\n\nCurrent: <code>${cur}</code>\n\n<i>Chat me apna UPI ID likh kar bhejein (jaise 9876543210@paytm ya yourname@okhdfcbank):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' }
    }
  );
});

// ================= SWIGGY IN-BOT OTP LOGIN =================

bot.hears('🔑 Login Swiggy Account', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await handlePromptLogin(ctx);
});

bot.action('boss_prompt_login', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await handlePromptLogin(ctx);
});

async function handlePromptLogin(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('Connected Accounts', 'boss_view_accounts'),
      Markup.button.callback('Export Session JSON', 'boss_export_picker')
    ],
    [
      Markup.button.callback('Main Menu', 'boss_panel_home'),
      Markup.button.callback('Close', 'close_menu')
    ]
  ]);

  const text = `<b>Swiggy Account Access & Login Manager:</b>\n\n` +
    `• <b>Login with JSON:</b> Session / Cookie JSON paste karein\n` +
    `• <b>Login with Number:</b> Mobile number se instant OTP aayega`;

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

// Helper to prompt for phone number with Auto-Keyboard Popup
async function promptBossLoginWithNumber(ctx) {
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_phone_for_number_login' };

  await ctx.reply(
    `<b>Login with Number</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Main Menu', callback_data: 'boss_panel_home' },
            { text: 'Close', callback_data: 'close_menu' }
          ]
        ]
      }
    }
  );

  await ctx.reply('👉 Enter 10-digit Mobile Number:', {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: 'Enter 10-digit mobile number...'
    }
  });
}

// 1. Login with JSON Prompt
bot.action('boss_login_with_json', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `<b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

// 2. Login with Number Prompt
bot.action('boss_login_with_number', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await promptBossLoginWithNumber(ctx);
});

// 2.1 Direct Send to Another Number
bot.action('send_to_another_number', async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  await ctx.answerCbQuery().catch(() => {});
  await promptBossLoginWithNumber(ctx);
});

// 2.2 Cancel OTP Login Action -> Closes prompt cleanly and restores reply keyboard
bot.action(['cancel_otp_login', 'close_menu', 'action_close', 'cancel_menu'], async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.deleteMessage();
  } catch (e) {
    try {
      await ctx.editMessageText('Closed.');
    } catch (e2) {}
  }
  if (isBoss(userId)) {
    await ctx.reply('Closed.', getBossReplyKeyboard());
  } else {
    await ctx.reply('Closed.', getUserReplyKeyboard());
  }
});

// 2.3 Resend OTP Action
bot.action(/^resend_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery(`Resending OTP to ${phone}...`).catch(() => {});
  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => a.phone === phone);
  const existingKey = existing ? existing[0] : `acc_${phone}`;
  const existingName = existing ? (existing[1]?.name || existing[0]) : null;
  
  const result = await requestSwiggyOtpViaBridge(userId, phone, existingKey);
  if (result.success) {
    userWaitState[userId] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc: existingKey,
      phone,
      name: existingName
    };
    await ctx.reply(
      `<b>OTP Sent</b>\n<code>${phone}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Copy Number', copy_text: { text: phone } }
            ],
            [
              { text: '🔄 Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}` },
              { text: 'Resend OTP', callback_data: `resend_otp_${phone}` }
            ],
            [
              { text: 'Another Number', callback_data: 'send_to_another_number' },
              { text: 'Main Menu', callback_data: 'boss_panel_home' }
            ],
            [
              { text: 'Close', callback_data: 'close_menu' }
            ]
          ]
        }
      }
    );
    await ctx.reply('👉 Enter OTP:', {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter 6-digit OTP...'
      }
    });
  } else {
    const errCard = formatOtpSendErrorCard(phone, result);
    await ctx.reply(errCard.text, {
      parse_mode: 'HTML',
      ...errCard.keyboard
    });
  }
});

// 2.4 Re-enter OTP Action
bot.action(/^prompt_reenter_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery('Ready for OTP...').catch(() => {});

  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => a.phone === phone);
  const existingKey = existing ? existing[0] : `acc_${phone}`;
  const existingName = existing ? (existing[1]?.name || existing[0]) : null;

  const prevOrderId = userWaitState[userId]?.orderId || null;

  userWaitState[userId] = {
    action: 'waiting_swiggy_otp_bridge',
    targetAcc: existingKey,
    phone,
    name: existingName,
    orderId: prevOrderId
  };

  await ctx.reply(
    `🔄 <b>Re-enter OTP for <code>${phone}</code>:</b>\n\n` +
    `👉 Kripya sahi 6-digit OTP type karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter 6-digit OTP...'
      }
    }
  );
});

// Process JSON login and fetch authentic profile name from Swiggy
async function handleProcessJsonLogin(ctx, rawJson, userId) {
  delete userWaitState[userId];
  let parsed = null;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch (e) {
    return ctx.reply('⚠️ Invalid JSON format. Kripya valid Swiggy session JSON string bhein.');
  }

  let cookieStr = parsed.cookies || '';
  if (!cookieStr && parsed.tid) {
    cookieStr = `tid=${parsed.tid}; _sid=${parsed.sid || ''}; _device_id=${parsed.deviceId || ''}`;
  }

  if (!cookieStr && !parsed.tid) {
    return ctx.reply('⚠️ Invalid session: Isme Swiggy cookies ya tid token nahi mila.');
  }

  const statusMsg = await ctx.reply('⏳ <i>Swiggy session verify kiya ja raha hai & profile name fetch ho raha hai...</i>', { parse_mode: 'HTML' });

  // 1. Fetch real profile from Swiggy using cookies
  const profile = await fetchSwiggyProfileFromCookies(cookieStr).catch(() => ({ name: null, phone: null }));
  const parsedPhone = parsed.phone || parsed.mobile || '';
  const cleanPhone = (profile?.phone || parsedPhone ? String(profile?.phone || parsedPhone).replace(/[^0-9]/g, '').slice(-10) : '');
  const swiggyName = profile?.name || parsed.name || (cleanPhone ? `User ${cleanPhone}` : 'Swiggy User');

  const accKey = cleanPhone ? `acc_${cleanPhone}` : (parsed.account || 'acc_' + Date.now());

  // 2. Import into database
  const result = importSessionJson({
    ...parsed,
    name: swiggyName,
    phone: cleanPhone,
    cookies: cookieStr
  }, accKey);

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}

  if (result.success) {
    const db = getDb();
    if (!db.config.activeOrderAccount) {
      db.config.activeOrderAccount = accKey;
      saveDb(db);
    }

    const claimWait = await ctx.reply('⏳ <i>Swiggy Breakfast (6am-11am) & Late Night (9pm-11pm) ₹50 OFF offers auto-claim ho rahe hain...</i>', { parse_mode: 'HTML' });
    const offersResult = await claimSwiggyBreakfastAndLateNightOffers({
      phone: cleanPhone,
      token: parsed.token || parsed.tid,
      tid: parsed.tid,
      cookies: cookieStr
    });
    try { await bot.telegram.deleteMessage(ctx.chat.id, claimWait.message_id); } catch (e) {}

    const accData = db.config.accounts[accKey] || {};
    accData.offers = offersResult;
    saveDb(db);

    await sendAccountLoginAndOffersCard(ctx, {
      accountKey: accKey,
      targetAcc: accKey,
      name: swiggyName,
      swiggyName,
      phone: cleanPhone,
      customerId: profile?.id || parsed.customerId || 'Verified',
      exportJson: parsed,
      offers: offersResult
    }, ctx.from.id, null);
  } else {
    await ctx.reply(`❌ <b>Import Failed:</b> ${result.message}`, getBossPanelKeyboard());
  }
}

// Sends the instant claiming confirmation & detailed offers card
async function sendAccountLoginAndOffersCard(ctx, accInfo, userId, orderId) {
  const targetAcc = accInfo.accountKey || accInfo.targetAcc || `acc_${accInfo.phone}`;
  const displayName = accInfo.name || targetAcc;
  const swiggyName = accInfo.swiggyName || '';
  const botTag = accInfo.botTag || '';
  const phone = accInfo.phone || accInfo.mobile || '';
  const customerId = accInfo.customerId || 'Verified';

  const db = getDb();
  if (!db.config.activeOrderAccount) {
    db.config.activeOrderAccount = targetAcc;
    saveDb(db);
  }
  if (orderId && db.orders[orderId]) {
    const order = db.orders[orderId];
    order.selectedAccount = targetAcc;
    saveDb(db);
    updateOrderCards(order).catch(() => {});
  }

  const exported = exportSessionJson(targetAcc) || accInfo.exportJson || db.config?.accounts?.[targetAcc];
  const sessionJsonStr = exported ? JSON.stringify(exported, null, 2) : '';
  const compactStr = exported ? JSON.stringify(exported) : '';

  const offers = accInfo.offers || {};
  const lateNight = offers.lateNight || { status: 'CLAIMED', discount: '50 off on 199' };
  const breakfast = offers.breakfast || { status: 'CLAIMED', discount: '50 off on 199' };
  const isLateNightClaimed = lateNight.status === 'CLAIMED';
  const isBreakfastClaimed = breakfast.status === 'CLAIMED';
  const bothClaimed = isLateNightClaimed && isBreakfastClaimed;

  const lateNightStatusText = isLateNightClaimed 
    ? `✅ <code>CLAIMED</code> (50 off on 199)${lateNight.message ? ` — <i>${escapeHtml(lateNight.message)}</i>` : ''}` 
    : `❌ <code>CLAIM FAILED</code>${lateNight.message ? ` (<i>${escapeHtml(lateNight.message)}</i>)` : ''}`;
  const breakfastStatusText = isBreakfastClaimed 
    ? `✅ <code>CLAIMED</code> (50 off on 199)${breakfast.message ? ` — <i>${escapeHtml(breakfast.message)}</i>` : ''}` 
    : `❌ <code>CLAIM FAILED</code>${breakfast.message ? ` (<i>${escapeHtml(breakfast.message)}</i>)` : ''}`;

  const headerTag = bothClaimed 
    ? `<blockquote>⚡ <b>SWIGGY CLAIMING SUCCESS</b></blockquote>` 
    : `<blockquote>⚠️ <b>LOGIN COMPLETE — CLAIM PARTIAL</b></blockquote>`;

  const cardText = 
    `${headerTag}\n\n` +
    `📱 <b>Account Number:</b> <code>${phone}</code>\n` +
    (swiggyName ? `👤 <b>Swiggy Profile Name:</b> <b>${escapeHtml(swiggyName)}</b>\n` : '') +
    (botTag ? `🏷️ <b>Bot Tag / Slot:</b> <code>${escapeHtml(botTag)}</code>\n` : '') +
    (!swiggyName && !botTag ? `👤 <b>Account Name:</b> <b>${escapeHtml(displayName)}</b>\n` : '') +
    `🆔 <b>Customer ID:</b> <code>${customerId}</code>\n\n` +
    `🎁 <b>OFFERS STATUS:</b>\n` +
    `• 🌙 <b>Swiggy Late Night:</b> ${lateNightStatusText}\n` +
    `• 🍳 <b>Swiggy Breakfast:</b> ${breakfastStatusText}\n\n` +
    (bothClaimed 
      ? `🟢 <b>Status:</b> Both offers active! 50 off on 199 available on food orders.\n\n` 
      : `⚠️ <b>Status:</b> One or more offers could not be claimed. You can delete this account or retry.\n\n`) +
    (orderId ? `📌 <b>Order #${orderId} is linked to ${escapeHtml(displayName)}!</b>\n\n` : '') +
    (sessionJsonStr ? `📋 <b>Session Code (Read more):</b>\n<blockquote expandable><pre><code class="language-json">${escapeHtml(sessionJsonStr)}</code></pre></blockquote>\n\n` : '') +
    `💾 <i>Account is saved in DB and ready for orders!</i>`;

  let keyboardButtons = [];
  const copyRow = [];
  if (sessionJsonStr) {
    copyRow.push(makeCopyButton('Copy Code', compactStr, `copy_code_${targetAcc}`, 'primary'));
  }
  if (phone) {
    copyRow.push({ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' });
  }
  if (copyRow.length > 0) keyboardButtons.push(copyRow);

  keyboardButtons.push([
    { text: 'Export JSON File', callback_data: `boss_export_single_${targetAcc}`, style: 'primary' },
    { text: 'Previous Orders', callback_data: `boss_prev_orders_${targetAcc}`, style: 'primary' }
  ]);

  if (bothClaimed) {
    keyboardButtons.push([
      { text: 'Order with this Account', callback_data: `boss_use_acc_${targetAcc}`, style: 'success' }
    ]);
  } else {
    keyboardButtons.push([
      { text: 'Retry Claim', callback_data: `boss_retry_claim_${targetAcc}`, style: 'primary' },
      { text: 'Use Anyway for Orders', callback_data: `boss_use_acc_${targetAcc}`, style: 'primary' }
    ]);
  }

  keyboardButtons.push([
    { text: 'Add Another Account', callback_data: 'send_to_another_number', style: 'primary' },
    { text: 'Delete Account from Swiggy', callback_data: `boss_swiggy_delete_start_${targetAcc}`, style: 'danger' }
  ]);

  keyboardButtons.push([
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' },
    { text: 'Close', callback_data: 'close_menu', style: 'danger' }
  ]);

  await ctx.reply(cardText, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboardButtons }
  });
}

// Action: Previous orders from login card or account card
bot.action(/^boss_prev_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Fetching previous orders from Swiggy... ⏳').catch(() => {});
  const key = ctx.match[1];
  await handlePreviousOrders(ctx, key);
});

// Action: Boss Main Menu / Boss Panel Home & Refresh
bot.action(['boss_panel_home', 'boss_refresh'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const text = getBossPanelText();
  const keyboard = getBossPanelKeyboard();
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
});

bot.command(['menu', 'panel'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  await ctx.reply('Boss Panel:', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Main Menu', 'Menu', 'Boss Panel', '🏠 Main Menu', '🏠 Boss Panel'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  await ctx.reply('Boss Panel:', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Close', 'close', '❌ Close'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (isBoss(ctx.from.id)) {
    await ctx.reply('Closed.', getBossReplyKeyboard());
  } else {
    await ctx.reply('Closed.', getUserReplyKeyboard());
  }
});

// Action: Use account for orders
bot.action(/^boss_use_acc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  if (db.config.accounts?.[accKey]) {
    db.config.activeOrderAccount = accKey;
    saveDb(db);
    await ctx.answerCbQuery(`Selected ${db.config.accounts[accKey].name || accKey} for orders! ✅`).catch(() => {});
    await ctx.reply(`🟢 <b>Account "${db.config.accounts[accKey].name || accKey}" is now ACTIVE for all orders!</b>`, getBossPanelKeyboard());
  } else {
    await ctx.answerCbQuery('Account not found!').catch(() => {});
  }
});

// Action: Retry offer claims
bot.action(/^boss_retry_claim_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  await ctx.answerCbQuery('Retrying offer claims with Swiggy API... ⏳').catch(() => {});
  const db = getDb();
  const acc = db.config.accounts?.[accKey];
  if (!acc) return ctx.reply('❌ Account not found.');

  const retryWait = await ctx.reply(`⏳ <i>Swiggy Breakfast & Late Night offers claim request process ho rahi hai for <b>${escapeHtml(acc.name || accKey)}</b>...</i>`, { parse_mode: 'HTML' });
  const claimRes = await claimSwiggyBreakfastAndLateNightOffers(acc);
  acc.offers = claimRes;
  saveDb(db);
  try { await bot.telegram.deleteMessage(ctx.chat.id, retryWait.message_id); } catch (e) {}

  await sendAccountLoginAndOffersCard(ctx, {
    accountKey: accKey,
    name: acc.name,
    phone: acc.phone,
    customerId: acc.customerId,
    offers: acc.offers,
    exportJson: acc
  }, ctx.from.id, null);
});


// ================= ACCOUNT SELECTOR IN BOSS CARD =================

// ================= ACCOUNT SELECTOR IN BOSS CARD (FIGJAM FLOW) =================

// Screen 2 -> Open Account Picker
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const db = getDb();
  const accounts = db.config.accounts || {};
  const buttons = [];
  const accEntries = Object.entries(accounts);

  if (accEntries.length === 0) {
    buttons.push([
      Markup.button.callback('🔑 Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('📱 Login with Number', 'boss_login_with_number')
    ]);
  } else {
    for (let i = 0; i < accEntries.length; i += 2) {
      const row = [];
      const [k1, a1] = accEntries[i];
      const m1 = a1.isLoggedIn ? '🟢' : '⚪';
      row.push(Markup.button.callback(`${m1} ${a1.name || k1}`, `boss_choose_acc_${k1}_${orderId}`));
      if (accEntries[i + 1]) {
        const [k2, a2] = accEntries[i + 1];
        const m2 = a2.isLoggedIn ? '🟢' : '⚪';
        row.push(Markup.button.callback(`${m2} ${a2.name || k2}`, `boss_choose_acc_${k2}_${orderId}`));
      }
      buttons.push(row);
    }
    buttons.push([
      Markup.button.callback('➕ Login Another Account', 'boss_prompt_login')
    ]);
  }

  await ctx.reply(
    `👥 <b>Choose Account to order for #${orderId}:</b>`,
    Markup.inlineKeyboard(buttons)
  );
});

// Account Chosen for Order -> Auto-parse cart & calculate bill
bot.action(/^(?:boss_sel_acc|boss_choose_acc)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let accKey = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.endsWith('_' + oid)) {
      orderId = oid;
      accKey = payload.slice(0, -(oid.length + 1));
      break;
    } else if (payload.startsWith(oid + '_')) {
      orderId = oid;
      accKey = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const candidateOid = payload.slice(lastUnderscore + 1);
      if (db.orders[candidateOid]) {
        orderId = candidateOid;
        accKey = payload.slice(0, lastUnderscore);
      }
    }
  }

  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  order.selectedAccount = accKey;
  order.amountAccepted = false;
  order.waitingConfirmation = false;
  saveDb(db);

  const accountData = db.config.accounts?.[accKey];
  const accName = accountData?.name || accKey;
  await ctx.answerCbQuery(`Selected: ${accName}! Calculating bill... ⏳`).catch(() => {});

  // Fast verify Swiggy cart & items using account cookies or verified metadata
  try {
    const accountSession = accountData ? {
      token: accountData.token || null,
      tid: accountData.tid || null,
      sid: accountData.sid || null,
      deviceId: accountData.deviceId || null
    } : null;

    if (order.cart) {
      const swiggyData = await verifyAndInspectSwiggyLink(order.cart, accountData?.cookies, accountSession);
      if (swiggyData.verified || (swiggyData.items && swiggyData.items.length > 0)) {
        order.swiggyVerified = true;
        if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
        if (swiggyData.items && swiggyData.items.length > 0) order.items = swiggyData.items;
        if (swiggyData.subtotal > 0) order.subtotal = swiggyData.subtotal;
        if (swiggyData.itemTotal > 0) order.itemTotal = swiggyData.itemTotal;
        if (swiggyData.discountAmount > 0) order.discountAmount = swiggyData.discountAmount;
        if (swiggyData.couponCode) order.couponCode = swiggyData.couponCode;
        if (swiggyData.freeCashApplied > 0) order.freeCashApplied = swiggyData.freeCashApplied;
        if (swiggyData.swiggyOneMembershipFee > 0) order.swiggyOneMembershipFee = swiggyData.swiggyOneMembershipFee;
        if (swiggyData.packingCharges > 0) order.packingCharges = swiggyData.packingCharges;
        if (swiggyData.taxesAndCharges > 0) order.taxesAndCharges = swiggyData.taxesAndCharges;
        if (swiggyData.deliveryFee !== undefined) order.deliveryFee = swiggyData.deliveryFee;
        if (swiggyData.freeDeliveryDiscount !== undefined) order.freeDeliveryDiscount = swiggyData.freeDeliveryDiscount;
        if (swiggyData.swiggyOneApplied) order.swiggyOneApplied = true;
        if (swiggyData.finalPayable > 0) order.finalPayable = swiggyData.finalPayable;
        if (swiggyData.totalSavings > 0) order.totalSavings = swiggyData.totalSavings;
        if (swiggyData.addressDetails && !order.addressDetails) {
          order.addressDetails = swiggyData.addressDetails;
        }
      }
    }
    if (order.address && !order.addressDetails) {
      const addrMeta = await resolveSwiggyLink(order.address);
      if (addrMeta.addressDetails) {
        order.addressDetails = addrMeta.addressDetails;
      }
    }
  } catch (err) {
    console.error('Error verifying cart for chosen account:', err.message);
  }

  saveDb(db);

  // Update in-place on single cards for Boss and User! (NO DUPLICATE MESSAGES)
  await updateOrderCards(order);
});

// Change Account Button on Order Card
bot.action(/^boss_change_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  order.selectedAccount = null;
  order.waitingConfirmation = false;
  order.status = 'PENDING';
  saveDb(db);

  await ctx.answerCbQuery('Choose a different account:').catch(() => {});
  await updateOrderCards(order);
});

// Send for Confirmation Button on Order Card
bot.action(/^boss_send_confirm_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  order.status = 'WAITING_CONFIRMATION';
  order.waitingConfirmation = true;
  order.sentForConfirmationAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('Sent for Confirmation to Customer! 🚀').catch(() => {});
  await updateOrderCards(order);

  // If user card message id is not set, deliver card to user
  if (order.userChatId && !order.userMessageId) {
    try {
      const userCard = formatUserOrderCard(order);
      const sent = await bot.telegram.sendMessage(order.userChatId, userCard.text, {
        parse_mode: 'HTML',
        ...userCard.keyboard
      });
      order.userMessageId = sent.message_id;
      saveDb(db);
    } catch (e) {}
  }
});

// Text User Button
bot.action(/^boss_text_user_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_text_user', orderId, targetUserId: order.userId };

  const userProfileUrl = `tg://user?id=${order.userId}`;
  await ctx.reply(
    `💬 <b>Send message to <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (Order #${orderId}):</b>\n\n` +
    `🆔 <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n\n` +
    `<i>Chat me message likh kar bhejein ya upar TG ID par click karke direct profile kholein:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Type message for user...' }
    }
  );
});

// Dynamic Account Picker on Order Card
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  const accounts = db.config.accounts || {};

  const buttons = [];
  const accEntries = Object.entries(accounts);

  for (let i = 0; i < accEntries.length; i += 2) {
    const row = [];
    const [k1, a1] = accEntries[i];
    const s1 = a1.isLoggedIn ? '🟢' : '⚪';
    const p1 = a1.phone || a1.mobile || a1.name || k1;
    row.push(Markup.button.callback(`${s1} ${p1}`, `boss_select_acc_${orderId}_${k1}`));

    if (accEntries[i + 1]) {
      const [k2, a2] = accEntries[i + 1];
      const s2 = a2.isLoggedIn ? '🟢' : '⚪';
      const p2 = a2.phone || a2.mobile || a2.name || k2;
      row.push(Markup.button.callback(`${s2} ${p2}`, `boss_select_acc_${orderId}_${k2}`));
    }
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback('➕ Add New Account', `boss_add_new_acc_for_order_${orderId}`),
    Markup.button.callback('🔙 Back to Order', `boss_back_to_order_${orderId}`)
  ]);

  await ctx.reply(
    `👥 <b>CHOOSE SWIGGY ACCOUNT FOR ORDER #${orderId}:</b>\n\n` +
    `Select the account to place this order with. (Swiggy offers, coupons & free delivery will be applied automatically):\n\n` +
    `<i>🟢 = Logged In | ⚪ = Not Logged In</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Selecting Account for Order -> Runs Group Cart Sync, Coupon Optimizer & Displays Boss Review Screen
bot.action(/^boss_select_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let accKey = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.endsWith('_' + oid)) {
      orderId = oid;
      accKey = payload.slice(0, -(oid.length + 1));
      break;
    } else if (payload.startsWith(oid + '_')) {
      orderId = oid;
      accKey = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const candidateOid = payload.slice(lastUnderscore + 1);
      if (db.orders[candidateOid]) {
        orderId = candidateOid;
        accKey = payload.slice(0, lastUnderscore);
      }
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const idx = payload.indexOf('_');
    if (idx !== -1) {
      orderId = payload.slice(0, idx);
      accKey = payload.slice(idx + 1);
    }
  }

  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  const acc = db.config.accounts?.[accKey];
  const accPhone = acc?.phone || acc?.mobile || acc?.name || 'Selected Account';
  const accName = acc?.name || accPhone;

  order.selectedAccount = accKey;
  order.orderAccount = accPhone;
  order.paymentSentToUser = false; // NEVER directly send to customer before Boss review!
  saveDb(db);

  await ctx.answerCbQuery(`Selected ${accPhone}! Processing cart & capturing payment QR... 🚀`).catch(() => {});
  const waitMsg = await ctx.reply(
    `⏳ <b>Processing Order #${orderId} on Swiggy Account: ${escapeHtml(accPhone)} (${escapeHtml(accName)})...</b>\n\n` +
    `1️⃣ Reading items & syncing Customer Group Cart into account\n` +
    `2️⃣ Checking saved address history & delivery location\n` +
    `3️⃣ Finding available coupons & discounts on account\n` +
    `4️⃣ Navigating to checkout & capturing authentic Swiggy Payment QR...`,
    { parse_mode: 'HTML' }
  );

  // Run full group cart sync, address binding, coupon optimization & checkout payment screen capture in background
  // to avoid Telegraf's 90,000ms callback query timeout error!
  (async () => {
    try {
      const result = await syncGroupCartAndCheckoutForAccount(acc, order);
      console.log(`[syncGroupCartAndCheckoutForAccount] Result for Order #${orderId}:`, {
        success: result.success,
        sessionExpired: Boolean(result.sessionExpired),
        hasQr: Boolean(result.qrBuffer),
        paymentUrl: result.paymentUrl,
        itemsCount: result.cartData?.items?.length || 0,
        savedAddressesCount: result.savedAddresses?.length || 0,
        availableCouponsCount: result.availableCoupons?.length || 0
      });

      if (result.sessionExpired) {
        if (acc) {
          acc.isLoggedIn = false;
          saveDb(db);
        }
        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        await ctx.reply(
          `⚠️ <b>Swiggy Session Expired: ${escapeHtml(accPhone)} (${escapeHtml(accName)})</b>\n\n` +
          `Swiggy security firewall ne is account ka login session expire kar diya hai, is wajah se cart aur address fetch nahi ho sake.\n\n` +
          `👉 <b>Kripya is account par login karein ya doosra active account chunein:</b>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback(`🔑 Login via OTP: ${accPhone}`, `boss_login_acc_otp_${accKey}`)],
              [Markup.button.callback(`📋 Paste Session JSON`, `boss_login_acc_json_${accKey}`)],
              [Markup.button.callback(`👥 Select Another Account`, `boss_choose_acc_picker_${orderId}`)]
            ])
          }
        ).catch(() => {});
        return;
      }

      if (result.cartData) {
        const cd = result.cartData;
        if (cd.restaurantName) order.restaurantName = cd.restaurantName;
        if (cd.items && cd.items.length > 0) order.items = cd.items;
        if (cd.address && (!order.address || order.address === 'Address pending / not provided')) {
          order.address = cd.address;
        }
        order.itemTotal = cd.itemTotal || order.itemTotal;
        order.subtotal = cd.subtotal || order.subtotal;
        order.deliveryFee = cd.deliveryFee || 0;
        order.freeDeliveryDiscount = cd.freeDeliveryDiscount || 0;
        order.swiggyOneApplied = cd.swiggyOneApplied || false;
        order.swiggyOneSavings = cd.swiggyOneSavings || 0;
        if (cd.couponCode) {
          order.couponCode = cd.couponCode;
          order.discountAmount = cd.discountAmount || 0;
        }
        order.freeCashBalance = cd.freeCashBalance || 0;
        order.freeCashApplied = cd.freeCashApplied || 0;
        order.finalPayable = cd.finalPayable || order.finalPayable;
        order.totalSavings = cd.totalSavings || order.totalSavings;
        if (cd.addressDetails) {
          order.addressDetails = cd.addressDetails;
        }
        order.packingCharges = cd.packingCharges || 0;
        order.taxesAndCharges = cd.taxesAndCharges || 0;
        order.swiggyVerified = true;
      }

      if (result.savedAddresses && result.savedAddresses.length > 0) {
        order.accountAddresses = result.savedAddresses;
        if (!order.addressDetails && result.savedAddresses[0]) {
          order.addressDetails = result.savedAddresses[0];
          order.address = result.savedAddresses[0].address;
        }
      }
      if (result.availableCoupons && result.availableCoupons.length > 0) {
        order.availableCoupons = result.availableCoupons;
      }

      // Always ensure max offer is calculated
      applyMaxOfferToOrder(order);

      if (result.paymentUrl) {
        order.swiggyPaymentUrl = result.paymentUrl;
      }

      // Generate authentic personalized QR Card with customer's name embedded in the center of the QR
      const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
      const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
      const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;

      let finalQrBuffer = result.qrBuffer;
      try {
        const cardBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri,
          qrBuffer: result.qrBuffer
        });
        if (cardBuffer) {
          finalQrBuffer = cardBuffer;
        }
      } catch (e) {
        console.warn('[boss_select_acc] Personalized QR Card generation fallback:', e.message);
      }

      if (finalQrBuffer) {
        order.genuineQrBuffer = finalQrBuffer;
        try {
          const bossQrMsg = await ctx.replyWithPhoto(
            { source: finalQrBuffer },
            {
              caption: `📸 <b>Live Swiggy Checkout Payment QR (Order #${order.id})</b>\n\n` +
                `📱 Account: <b>${escapeHtml(accPhone)}</b> (${escapeHtml(accName)})\n` +
                `👤 Customer Badge in QR Center: <b>${escapeHtml(custDisplayName)}</b>\n` +
                `🏪 Restaurant: <b>${escapeHtml(order.restaurantName || 'Swiggy Order')}</b>\n` +
                `💰 Amount To Pay: <b>₹${order.finalPayable || order.subtotal || 0}</b> (Saved: ₹${order.totalSavings || 0})\n\n` +
                `⚠️ <i>Yeh Payment QR abhi customer ko nahi bheja gaya hai. Neeche Review Screen check karke <b>[ 🚀 Send Bill & Request Confirmation ]</b> dabayein!</i>`,
              parse_mode: 'HTML'
            }
          );
          if (bossQrMsg?.photo && bossQrMsg.photo.length > 0) {
            order.customQrFileId = bossQrMsg.photo[bossQrMsg.photo.length - 1].file_id;
          }
        } catch (e) {
          console.error('[boss_select_acc] Error sending QR preview to boss:', e.message);
        }
      }

      saveDb(db);

      // Update Customer's card
      await updateOrderCards(order);

      try {
        await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
      } catch (e) {}

      // Deliver comprehensive Boss Review Card
      const reviewCard = formatBossAccountReviewCard(order);
      await ctx.reply(reviewCard.text, {
        parse_mode: 'HTML',
        ...reviewCard.keyboard
      });
    } catch (e) {
      console.error('Error syncing group cart and checkout for chosen account:', e.message);
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (delErr) {}
      await ctx.reply(`❌ <b>Failed to process order #${orderId}:</b> ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  })().catch(err => console.error('[boss_select_acc] Background Error:', err));
});

// Boss Action: Trigger Login via OTP for an Account
bot.action(/^boss_login_acc_otp_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const rawPayload = ctx.match[1];
  const accKey = rawPayload.split('_')[0] === 'acc' ? rawPayload.split('_').slice(0, 2).join('_') : rawPayload.split('_')[0];
  const db = getDb();
  const acc = db.config.accounts?.[accKey] || db.config.accounts?.[rawPayload];
  const phone = acc?.phone || acc?.mobile || accKey.replace(/^acc_/, '').slice(-10);
  const accName = acc?.name || phone;

  if (!phone || phone.length < 10) {
    return ctx.answerCbQuery('Invalid phone number for account').catch(() => {});
  }

  await ctx.answerCbQuery(`Sending OTP to ${phone}... ⚡`).catch(() => {});
  const waitMsg = await ctx.reply(`📲 <b>Requesting Swiggy OTP for ${escapeHtml(phone)} (${escapeHtml(accName)})...</b>`, { parse_mode: 'HTML' });

  try {
    const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, accKey, accName);
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      userWaitState[ctx.from.id] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone
      };
      await ctx.reply(
        `📲 <b>Swiggy OTP Sent Successfully!</b>\n` +
        `📱 Mobile: <code>${phone}</code>\n` +
        `👤 Account: <b>${escapeHtml(accName)}</b>\n\n` +
        `👉 <i>Kripya mobile par aaya hua 6-digit OTP yahan type karein:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🔄 Re-enter OTP', `prompt_reenter_otp_${phone}`),
              Markup.button.callback('📨 Resend OTP', `resend_otp_${phone}`)
            ],
            [
              Markup.button.callback('📋 Paste Session JSON', `boss_login_acc_json_${accKey}`),
              Markup.button.callback('❌ Cancel', 'close_menu')
            ]
          ])
        }
      );
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
  } catch (err) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    await ctx.reply(`❌ <b>Error:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// Boss Action: Prompt to paste Session JSON for an Account
bot.action(/^boss_login_acc_json_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const rawPayload = ctx.match[1];
  const accKey = rawPayload.split('_')[0] === 'acc' ? rawPayload.split('_').slice(0, 2).join('_') : rawPayload.split('_')[0];
  const db = getDb();
  const acc = db.config.accounts?.[accKey] || db.config.accounts?.[rawPayload];
  const phone = acc?.phone || acc?.mobile || accKey.replace(/^acc_/, '').slice(-10);
  const accName = acc?.name || phone;

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = {
    action: 'waiting_json_login',
    targetAcc: accKey,
    phone
  };

  await ctx.reply(
    `📋 <b>Paste Swiggy Session JSON for ${escapeHtml(accName)} (${escapeHtml(phone)}):</b>\n\n` +
    `Browser ya app se copy kiya hua full Swiggy session JSON yahan bhejein:\n\n` +
    `<i>(Format: <code>{"tid":"...","sid":"...","cookies":"..."}</code>)</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

// Boss Action: Add new account directly while handling an order
bot.action(/^boss_add_new_acc_for_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = {
    action: 'waiting_phone_for_new_acc_order',
    orderId
  };

  await ctx.reply(
    `➕ <b>Add New Swiggy Account for Order #${orderId}:</b>\n\n` +
    `👉 <i>Enter 10-digit Mobile Number:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
    }
  );
});

// Boss Action: Back to order review card
bot.action(/^boss_back_to_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  await updateOrderCards(order);
});

// Boss Action: Send Bill & Confirmation Request to Customer
bot.action(/^boss_send_qr_to_user_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  order.paymentSentToUser = true;
  saveDb(db);

  await ctx.answerCbQuery('Sending Bill & Confirmation Request to Customer... 🚀').catch(() => {});

  // 1. Send Bill & Confirmation Request to Customer
  const custChatId = order.userChatId || order.userId;
  if (custChatId) {
    try {
      if (!order.genuineQrBuffer) {
        const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
        const bossUpi = db.config?.bossUpiId || '6296591407@ybl';
        const upiUri = `upi://pay?pa=${bossUpi}&pn=Swiggy&am=${order.finalPayable || order.subtotal || 0}&cu=INR&tn=Swiggy_Order_${order.id}`;
        order.genuineQrBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri
        }).catch(err => {
          console.warn('[boss_send_qr_to_user] Card generation fallback:', err.message);
          return null;
        });
        saveDb(db);
      }

      // Send Customer confirmation & payment prompt
      const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
      const confirmText = `🧾 <b>Swiggy Order #${order.id} Ready for Confirmation!</b>\n\n` +
        `👤 <b>Customer:</b> <b>${escapeHtml(custDisplayName)}</b>\n` +
        `🏪 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
        `💰 <b>Amount To Pay: ₹${order.finalPayable || order.subtotal || 0}</b>\n` +
        (order.totalSavings > 0 ? `🎉 <b>Discounts & Offers Saved: ₹${order.totalSavings}</b>\n` : '') +
        `\n👉 <i>Aapka order review ho gaya hai! Neeche <b>[ ✅ Confirm Order & Get Payment QR ]</b> dabakar payment QR prapt karein:</i>`;

      await bot.telegram.sendMessage(
        custChatId,
        confirmText,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Order & Get Payment QR', `user_confirm_get_qr_${order.id}`)],
            ...(order.swiggyPaymentUrl ? [[Markup.button.url('💳 Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)]] : []),
            [Markup.button.callback('🟠 Cancel Order', `action_cancel_order_confirm_${order.id}`)]
          ])
        }
      );
    } catch (err) {
      console.error('[boss_send_qr_to_user] Failed to send bill to user:', err.message);
    }
  }

  // 2. Update Customer's main order card
  await updateOrderCards(order);

  // 3. Update Boss review card
  const updatedReview = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(updatedReview.text, {
      parse_mode: 'HTML',
      ...updatedReview.keyboard
    });
  } catch (e) {
    await ctx.reply(updatedReview.text, {
      parse_mode: 'HTML',
      ...updatedReview.keyboard
    });
  }

  await ctx.reply(`✅ <b>Bill & Confirmation Request Customer ko bhej diya gaya hai!</b>\n<i>User ke confirm karte hi QR code unhe send ho jayega.</i>`, { parse_mode: 'HTML' });
});

// Customer Action: Confirm Order & Get Personalized QR Card
bot.action(/^user_confirm_get_qr_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});
  if (Number(order.userId) !== Number(ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Order Confirmed! Generating your payment QR with your name... 🚀').catch(() => {});
  await sendPaymentQrToUser(order);
});

// Boss Action: Coupon Picker
bot.action(/^boss_coupon_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});

  const buttons = [];
  const coupons = order.availableCoupons || [];

  for (const c of coupons) {
    const desc = c.description ? ` (${c.description.slice(0, 25)})` : '';
    buttons.push([Markup.button.callback(`🎟 Apply ${c.code}${desc}`, `boss_apply_coupon_${orderId}_${c.code}`)]);
  }

  const defaultCodes = ['DELULU4FOOD', 'SWIGGYIT', 'PARTY', 'STEALDEAL', 'WELCOME50'];
  const missingDefaults = defaultCodes.filter(d => !coupons.some(c => c.code === d));
  if (missingDefaults.length > 0) {
    const row = missingDefaults.slice(0, 3).map(code =>
      Markup.button.callback(`🎟 ${code}`, `boss_apply_coupon_${orderId}_${code}`)
    );
    buttons.push(row);
  }

  if (order.couponCode) {
    buttons.push([Markup.button.callback('❌ Remove Current Coupon', `boss_remove_coupon_${orderId}`)]);
  }

  buttons.push([Markup.button.callback('🔙 Back to Review Screen', `boss_view_review_${orderId}`)]);

  await ctx.reply(
    `🎟 <b>CHOOSE COUPON FOR ORDER #${orderId}:</b>\n\n` +
    `Current Applied Coupon: <b>${order.couponCode ? escapeHtml(order.couponCode) : 'None'}</b> ` +
    (order.discountAmount > 0 ? `(−₹${order.discountAmount})` : '') + `\n\n` +
    `Select a coupon code to apply to this order:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Boss Action: Apply Coupon (applies live on Swiggy via /dapi/cart/applyCoupon when account is selected!)
bot.action(/^boss_apply_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let code = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.startsWith(oid + '_')) {
      orderId = oid;
      code = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) return ctx.answerCbQuery('Order not found').catch(() => {});
  const order = db.orders[orderId];
  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;

  let liveApplied = null;
  if (acc?.cookies) {
    liveApplied = await applyLiveCouponToOrder(acc, order, code).catch(() => null);
  }

  if (liveApplied && liveApplied.items?.length > 0) {
    order.couponCode = liveApplied.couponCode || code;
    order.discountAmount = liveApplied.discountAmount || 0;
    order.deliveryFee = liveApplied.deliveryFee || 0;
    order.packingCharges = liveApplied.packingCharges || 0;
    order.taxesAndCharges = liveApplied.taxesAndCharges || 0;
    order.finalPayable = liveApplied.finalPayable;
    order.totalSavings = liveApplied.totalSavings;
    order.swiggyVerified = true;
  } else {
    order.couponCode = code;
    order.swiggyVerified = false;
    applyMaxOfferToOrder(order);
  }
  saveDb(db);
  await updateOrderCards(order);

  await ctx.answerCbQuery(`Applied coupon ${order.couponCode || code}! 🎉`).catch(() => {});

  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: Remove Coupon
bot.action(/^boss_remove_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const liveRemoved = acc?.cookies ? await applyLiveCouponToOrder(acc, order, 'REMOVE').catch(() => null) : null;

  order.couponCode = null;
  order.discountAmount = 0;
  if (liveRemoved && liveRemoved.items?.length > 0) {
    order.finalPayable = liveRemoved.finalPayable;
    order.totalSavings = liveRemoved.totalSavings;
    order.swiggyVerified = true;
  } else {
    order.swiggyVerified = false;
    applyMaxOfferToOrder(order);
  }
  saveDb(db);
  await updateOrderCards(order);

  await ctx.answerCbQuery('Coupon removed').catch(() => {});
  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: Address Picker (dynamically fetches saved addresses across accounts if not yet cached)
bot.action(/^boss_addr_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery('Loading saved addresses... 📍').catch(() => {});
  let addrs = order.accountAddresses || [];
  if (addrs.length === 0) {
    addrs = await fetchAllAccountsSavedAddresses();
    if (addrs.length > 0) {
      order.accountAddresses = addrs;
      saveDb(db);
    }
  }
  const buttons = [];

  addrs.forEach((a, idx) => {
    const tag = a.annotation ? `[${a.annotation}] ` : '';
    const accBadge = a.accountName ? `(${a.accountName}) ` : '';
    const label = `${idx + 1}. ${tag}${accBadge}${(a.address || '').slice(0, 32)}...`;
    buttons.push([Markup.button.callback(label, `boss_set_addr_${orderId}_${idx}`)]);
  });

  buttons.push([Markup.button.callback('🔙 Back to Review Screen', `boss_view_review_${orderId}`)]);

  await ctx.reply(
    `📍 <b>SELECT ACCOUNT ADDRESS FOR ORDER #${orderId}:</b>\n\n` +
    (addrs.length > 0
      ? `Choose from the saved addresses found on your Swiggy accounts:`
      : `<i>No saved addresses found yet on connected Swiggy accounts.</i>`),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Boss Action: Set Address from Saved List (and live re-sync cart delivery fee when account selected!)
bot.action(/^boss_set_addr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let addrIdx = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.startsWith(oid + '_')) {
      orderId = oid;
      addrIdx = parseInt(payload.slice(oid.length + 1), 10);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) return ctx.answerCbQuery('Order not found').catch(() => {});
  const order = db.orders[orderId];
  const selectedAddr = order.accountAddresses?.[addrIdx];

  if (selectedAddr) {
    order.address = selectedAddr.address;
    order.addressDetails = {
      id: selectedAddr.id || '',
      name: selectedAddr.name || '',
      mobile: selectedAddr.mobile || '',
      flat_no: selectedAddr.flat_no || '',
      area: selectedAddr.area || '',
      landmark: selectedAddr.landmark || '',
      address: selectedAddr.address || '',
      city: selectedAddr.city || '',
      lat: selectedAddr.lat || '',
      lng: selectedAddr.lng || ''
    };
    const selAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    if (selAcc?.cookies) {
      await syncGroupCartAndCheckoutForAccount(selAcc, order, { captureScreenshot: false }).catch(() => {});
    }
    saveDb(db);
    await updateOrderCards(order);
    await ctx.answerCbQuery(`Selected address ${addrIdx + 1}! 🏠`).catch(() => {});
  }

  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: View Review Screen
bot.action(/^boss_view_review_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Prompt to add new account from My Swiggy Accounts menu (deduplicated from order handlers above)
bot.action('boss_add_new_account_menu', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name', orderId: null };
  await ctx.reply(
    `➕ <b>ADD NEW SWIGGY ACCOUNT:</b>\n\n` +
    `Naye account ka naam chat me likhein:\n` +
    `(Jaise: <code>Bhai</code>, <code>Chacha</code>, <code>Personal</code>, <code>Office</code>, <code>Didi</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter account name (e.g. Bhai)...' }
    }
  );
});

// Account Login JSON prompt
bot.action(/^boss_login_acc_json_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const rawTarget = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const db = getDb();
  let targetAcc = rawTarget;
  let orderId = null;

  if (!db.config.accounts?.[targetAcc]) {
    for (const k of Object.keys(db.config.accounts || {})) {
      if (rawTarget.startsWith(k + '_')) {
        targetAcc = k;
        orderId = rawTarget.slice(k.length + 1);
        break;
      }
    }
  }

  userWaitState[ctx.from.id] = { action: 'waiting_json_import', targetAcc, orderId };
  const accName = db.config.accounts?.[targetAcc]?.name || targetAcc;

  await ctx.reply(
    `📋 <b>Paste Session JSON for ${escapeHtml(accName)}:</b>\n\n` +
    `Swiggy session JSON string chat me paste karein (Bina OTP ke turant login ho jayega):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON...' }
    }
  );
});

// ================= ACCOUNT MANAGEMENT: DELETE, LOGOUT, REFRESH, EXPORT =================

// State map for multi-select export checklist per user
const exportSelections = {};

// 1. Direct Delete Account Flow (NO LOGIN OTP)
bot.action('boss_delete_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  const buttons = [];
  for (const [k, a] of Object.entries(accounts)) {
    buttons.push([Markup.button.callback(`Delete ${a.name || k} (${a.phone || ''})`, `boss_swiggy_delete_start_${k}`)]);
  }
  buttons.push([Markup.button.callback('Cancel', 'boss_view_accounts')]);

  await ctx.reply(
    `<b>Select Account to Delete:</b>\n\n` +
    `Jis account ko delete karna chahte hain, uspe tap karein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Mutex to strictly prevent duplicate / concurrent deletion requests
const deleteInProgress = new Set();

bot.action([
  /^boss_swiggy_delete_start_(.+)$/,
  /^boss_swiggy_delete_trigger_(.+)$/,
  /^boss_swiggy_delete_instant_(.+)$/,
  /^boss_swiggy_delete_confirm_(.+)$/
], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const key = ctx.match[1];

  // In-flight debounce guard: strictly ONE delete OTP request per click / user / account
  if (deleteInProgress.has(userId) || deleteInProgress.has(key)) {
    return ctx.answerCbQuery('⚠️ Swiggy Delete OTP request already in progress... Please wait.', { show_alert: true }).catch(() => {});
  }

  deleteInProgress.add(userId);
  deleteInProgress.add(key);

  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply('❌ Account not found.');
  }

  const phone = acc.phone || key.replace('acc_', '');
  const accName = acc.name || key;

  // 1. Verify that the selected account has saved session credentials before initiating deletion
  const isAuth = checkLoggedInFromCookies(acc);
  if (!isAuth && !acc.cookies && !acc.tid) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply(
      `⚠️ <b>Account "${escapeHtml(accName)}" me koi saved Swiggy session nahi mila!</b>\n\n` +
      `Swiggy account deletion ke liye active, authenticated session zaroori hai.\n` +
      `Swiggy Settings me Delete tabhi open hota hai jab account logged in ho.\n\n` +
      `👉 <i>Kripya pehle is account me log in karein:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`Login ${accName}`, `boss_login_acc_otp_${key}`)],
          [Markup.button.callback('Main Menu', 'boss_panel_home')]
        ])
      }
    );
  }

  // Immediately answer callback query and set in-progress wait state so text listener never triggers login
  await ctx.answerCbQuery('Requesting Authentic Swiggy Delete OTP... ⏳').catch(() => {});
  userWaitState[userId] = {
    action: 'initiating_swiggy_delete_otp',
    phone,
    accountKey: key,
    accName,
    startedAt: Date.now()
  };

  try {
    const otpResult = await requestSwiggyDeleteOtpViaBridge(userId, phone, key, accName);
    if (otpResult.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_delete_otp',
        phone,
        accountKey: key,
        accName,
        startedAt: Date.now()
      };

      await ctx.reply(
        `<b>Delete OTP Sent</b>\n<code>${phone}</code> (${escapeHtml(accName)})`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phone } }
              ],
              [
                { text: 'Resend Delete OTP', callback_data: `boss_swiggy_delete_start_${key}` }
              ],
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home' },
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );

      await ctx.reply('👉 Enter Delete OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit Delete OTP...'
        }
      });
    } else {
      delete userWaitState[userId];
      const errText = otpResult.swiggyStatus || otpResult.message || 'Failed to trigger Delete OTP';
      const isAuthError = Boolean(otpResult.isAuthError);
      await ctx.reply(
        `<blockquote>${escapeHtml(errText)}</blockquote>\n\n` +
        `⚠️ <b>Swiggy Deletion OTP trigger nahi ho paya.</b>\n` +
        `Reason: <i>${escapeHtml(errText)}</i>\n\n` +
        (isAuthError
          ? `👉 <i>Swiggy ke mutabiq is account ka session expire ho chuka hai. Kripya re-login karein:</i>`
          : `<i>Kripya retry karein:</i>`),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              isAuthError
                ? [{ text: `Login ${accName}`, callback_data: `boss_login_acc_otp_${key}` }]
                : [{ text: 'Retry Send Delete OTP', callback_data: `boss_swiggy_delete_start_${key}` }],
              [{ text: 'Main Menu', callback_data: 'boss_panel_home' }]
            ]
          }
        }
      );
    }
  } catch (err) {
    delete userWaitState[userId];
    await ctx.reply(`⚠️ Error triggering deletion: ${escapeHtml(err.message)}`);
  } finally {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
  }
});

// 2. Interactive Multi-Select Export Checklist
bot.action(['boss_export_picker', 'boss_exp_select_all', 'boss_exp_deselect_all', /^boss_exp_toggle_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);

  if (accKeys.length === 0) {
    await ctx.answerCbQuery('Koi account nahi mila!', { show_alert: true }).catch(() => {});
    return ctx.reply('⚠️ No accounts found in bot to export.');
  }

  if (!exportSelections[userId]) {
    exportSelections[userId] = {};
    accKeys.forEach(k => { exportSelections[userId][k] = true; }); // Default: All selected
  }

  const actionMatch = ctx.callbackQuery?.data;
  if (actionMatch === 'boss_exp_select_all') {
    accKeys.forEach(k => { exportSelections[userId][k] = true; });
    await ctx.answerCbQuery('Sabhi select ho gaye ✅').catch(() => {});
  } else if (actionMatch === 'boss_exp_deselect_all') {
    accKeys.forEach(k => { exportSelections[userId][k] = false; });
    await ctx.answerCbQuery('Sabhi unselect ho gaye ⚪').catch(() => {});
  } else if (actionMatch?.startsWith('boss_exp_toggle_')) {
    const toggleKey = actionMatch.replace('boss_exp_toggle_', '');
    exportSelections[userId][toggleKey] = !exportSelections[userId][toggleKey];
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.answerCbQuery().catch(() => {});
  }

  const currentSelection = exportSelections[userId];
  const allSelected = accKeys.every(k => currentSelection[k]);
  const selectedCount = accKeys.filter(k => currentSelection[k]).length;

  const buttons = [];
  // Select All / Deselect All Toggle button
  if (allSelected) {
    buttons.push([{ text: 'Deselect All', callback_data: 'boss_exp_deselect_all', style: 'primary' }]);
  } else {
    buttons.push([{ text: 'Select All', callback_data: 'boss_exp_select_all', style: 'primary' }]);
  }

  // Individual account toggle buttons
  for (const k of accKeys) {
    const acc = accounts[k];
    const isChecked = Boolean(currentSelection[k]);
    const checkIcon = isChecked ? '✅' : '⬜';
    const accLabel = `${checkIcon} ${acc.name || k} (${acc.phone || ''})`;
    buttons.push([{ text: accLabel, callback_data: `boss_exp_toggle_${k}`, style: isChecked ? 'success' : 'primary' }]);
  }

  // Bottom action buttons
  buttons.push([
    { text: `Confirm & Export (${selectedCount}/${accKeys.length})`, callback_data: 'boss_exp_confirm', style: 'success' }
  ]);
  buttons.push([{ text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' }]);

  const checklistText = 
    `<blockquote>📤 <b>EXPORT ACCOUNTS CHECKLIST</b></blockquote>\n\n` +
    `Jin accounts ko export karna chahte hain unhe select karein:\n` +
    `• <b>Select All:</b> Ek tap me sabhi select honge.\n` +
    `• <b>Click to toggle:</b> Kisi bhi account par tap karke unselect ya select karein.\n` +
    `• <b>Selected:</b> <b>${selectedCount} of ${accKeys.length} accounts</b>\n\n` +
    `<i>Confirm karte hi sabhi accounts ki alag-alag .json files aur 1-tap Copy Buttons bhej diye jayenge!</i>`;

  try {
    await ctx.editMessageText(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    await ctx.reply(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
});

// Single Account Export Handler (from account details card or login card)
bot.action([/^boss_export_single_(.+)$/, /^boss_export_json_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Exporting session JSON... 📦').catch(() => {});

  const exported = exportSessionJson(key) || acc;
  const jsonStr = JSON.stringify(exported, null, 2);
  const compactStr = JSON.stringify(exported);
  const phone = acc.phone || acc.mobile || key;
  const fileName = `swiggy_${phone}.json`;

  try {
    // 1. Send separate .json file
    await ctx.replyWithDocument(
      {
        source: Buffer.from(jsonStr, 'utf-8'),
        filename: fileName
      },
      {
        caption: `📦 <b>Session File:</b> <code>${fileName}</code>\n👤 <b>Account:</b> ${escapeHtml(acc.name || key)}`,
        parse_mode: 'HTML'
      }
    );

    // 2. Send 1-2 line compact expandable code with Copy Code button
    await ctx.reply(
      `<b>Session Code:</b> <code>${phone}</code> (${escapeHtml(acc.name || key)})\n\n` +
      `<blockquote expandable><pre><code class="language-json">${escapeHtml(jsonStr)}</code></pre></blockquote>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              makeCopyButton('Copy Code', compactStr, `copy_code_${key}`, 'primary'),
              { text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }
            ],
            [
              { text: 'Back to Accounts', callback_data: 'acc_refresh_list', style: 'primary' },
              { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await ctx.reply(`❌ Export failed: ${err.message}`);
  }
});

// Confirm Multi-Select Export -> Sends ALAG ALAG FILE for each selected account + 1-2 line expandable code with Copy Code button
bot.action('boss_exp_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const currentSelection = exportSelections[userId] || {};
  const selectedKeys = Object.keys(accounts).filter(k => currentSelection[k]);

  if (selectedKeys.length === 0) {
    return ctx.answerCbQuery('⚠️ Kripya kam se kam ek account select karein!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery(`Exporting ${selectedKeys.length} accounts as separate files... 📦`).catch(() => {});

  try {
    for (const key of selectedKeys) {
      const acc = accounts[key];
      const exported = exportSessionJson(key) || acc;
      const jsonStr = JSON.stringify(exported, null, 2);
      const compactStr = JSON.stringify(exported);
      const phone = acc.phone || acc.mobile || key;
      const fileName = `swiggy_${phone}.json`;

      // 1. Send separate .json file for this account
      await ctx.replyWithDocument(
        {
          source: Buffer.from(jsonStr, 'utf-8'),
          filename: fileName
        },
        {
          caption: `📦 <code>${fileName}</code> — ${escapeHtml(acc.name || key)}`,
          parse_mode: 'HTML'
        }
      );

      // 2. Send 1-2 line compact expandable code with Copy Code button
      await ctx.reply(
        `<b>${escapeHtml(acc.name || key)}</b> (<code>${phone}</code>):\n` +
        `<blockquote expandable><pre><code class="language-json">${escapeHtml(jsonStr)}</code></pre></blockquote>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                makeCopyButton('Copy Code', compactStr, `copy_code_${key}`, 'primary'),
                { text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }
              ]
            ]
          }
        }
      );
    }

    // Completion summary
    await ctx.reply(
      `✅ <b>Export Complete:</b> ${selectedKeys.length} accounts exported as separate files with 1-tap copy buttons.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'View Accounts', callback_data: 'boss_view_accounts', style: 'primary' },
              { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await ctx.reply(`❌ Export error: ${err.message}`);
  }
});

// Action to send raw copyable session code
bot.action(/^copy_code_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  const exported = exportSessionJson(key) || acc;
  const jsonStr = JSON.stringify(exported, null, 2);

  await ctx.answerCbQuery('Tap code below to copy!').catch(() => {});
  await ctx.reply(`<pre><code class="language-json">${escapeHtml(jsonStr)}</code></pre>`, { parse_mode: 'HTML' });
});

// Fallback to send pure raw text message for 1-tap copy
bot.action('boss_send_raw_copy', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const jsonStr = userWaitState[userId]?.lastExportedJson;
  if (!jsonStr) return ctx.answerCbQuery('Session expired, re-export again.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  // Send raw text chunks
  await ctx.reply(jsonStr.slice(0, 4000));
});

// 3. Logout Accounts Picker & Logout All
bot.action('boss_logout_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  const loggedInEntries = Object.entries(accounts).filter(([, a]) => a.isLoggedIn);
  if (loggedInEntries.length === 0) {
    return ctx.reply('⚠️ No logged in accounts found to logout.', getBossPanelKeyboard());
  }

  const buttons = [];
  buttons.push([Markup.button.callback('⚠️ LOGOUT ALL ACCOUNTS', 'boss_logout_all_confirm')]);

  for (const [k, a] of loggedInEntries) {
    buttons.push([Markup.button.callback(`🚪 Logout ${a.name || k} (${a.phone || ''})`, `boss_logout_single_${k}`)]);
  }
  buttons.push([Markup.button.callback('🔙 Back', 'boss_view_accounts')]);

  await ctx.reply(
    `<blockquote>🚪 <b>LOGOUT ACCOUNTS MANAGER</b></blockquote>\n\n` +
    `Aap kis account ko logout karna chahte hain? Niche tap karein ya <b>Logout All</b> dabayein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^boss_logout_single_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found').catch(() => {});

  acc.isLoggedIn = false;
  acc.cookies = '';
  acc.token = '';
  acc.tid = '';
  acc.sid = '';
  saveDb(db);
  permanentLogoutAccount(key);

  await ctx.answerCbQuery('Logged out! ✅').catch(() => {});
  await ctx.reply(
    `<blockquote>🚪 <b>LOGOUT COMPLETED</b></blockquote>\n\n` +
    `📱 <b>Account:</b> <code>${acc.phone}</code>\n` +
    `👤 <b>Name:</b> <b>${escapeHtml(acc.name)}</b>\n` +
    `🔒 <b>Status:</b> Account session successfully logged out.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 View Accounts', 'boss_view_accounts'),
          Markup.button.callback('🚪 Logout Another', 'boss_logout_picker')
        ]
      ])
    }
  );
});

bot.action('boss_logout_all_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `<blockquote>⚠️ <b>CONFIRM LOGOUT ALL</b></blockquote>\n\n` +
    `Kya aap sach me <b>SABHI accounts</b> ko ek sath logout karna chahte hain?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔴 Yes, Logout All Accounts', 'boss_logout_all_exec'),
          Markup.button.callback('🔙 Cancel', 'boss_logout_picker')
        ]
      ])
    }
  );
});

bot.action('boss_logout_all_exec', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  let count = 0;
  for (const [k, a] of Object.entries(accounts)) {
    if (a.isLoggedIn) {
      a.isLoggedIn = false;
      a.cookies = '';
      a.token = '';
      a.tid = '';
      a.sid = '';
      permanentLogoutAccount(k);
      count++;
    }
  }
  saveDb(db);

  await ctx.reply(
    `<blockquote>🚪 <b>ALL ACCOUNTS LOGGED OUT</b></blockquote>\n\n` +
    `Total <b>${count} accounts</b> successfully logout kar diye gaye hain.\n` +
    `Ab koi bhi active session khula nahi hai.`,
    {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    }
  );
});

// 4. Refresh All Accounts (Audit Session + Check Orders)
bot.action('boss_refresh_all_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery('Auditing all accounts... ⏳').catch(() => {});

  const statusMsg = await ctx.reply('⏳ <i>Swiggy se sabhi accounts ke sessions verify ho rahe hain aur orders fetch kiye ja rahe hain...</i>', { parse_mode: 'HTML' });

  const db = getDb();
  const accounts = db.config.accounts || {};
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return ctx.reply('⚠️ No accounts found to refresh.');
  }

  const reportItems = [];

  for (let i = 0; i < entries.length; i++) {
    const [key, acc] = entries[i];
    const phone = acc.phone || key.replace('acc_', '');
    const accName = acc.name || key;
    const cookieStr = acc.cookies || (acc.tid ? `tid=${acc.tid}; _sid=${acc.sid || ''}; _device_id=${acc.deviceId || ''}; token=${acc.token || ''}` : '');

    if (!acc.isLoggedIn || !cookieStr) {
      reportItems.push(
        `<b>${i + 1}. 👤 ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
        `• 🔐 <b>Session:</b> ⚪ <b>Logged Out</b>\n` +
        `• 📦 <b>Orders:</b> <i>Login nahi hai</i>\n`
      );
      continue;
    }

    try {
      const res = await fetch('https://www.swiggy.com/dapi/order/all', {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Referer': 'https://www.swiggy.com/my-account'
        }
      });

      const json = await res.json().catch(() => ({}));
      const isExpired = res.status !== 200 || json.statusCode === 1 || !json.data;

      if (isExpired) {
        // Automatically logout expired account as requested
        acc.isLoggedIn = false;
        reportItems.push(
          `<b>${i + 1}. 👤 ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
          `• 🔐 <b>Session:</b> ❌ <b>Iska session OFF hai (Logged Out)</b>\n` +
          `• 📦 <b>Orders:</b> ⚠️ Session expired — Login required\n`
        );
      } else {
        acc.isLoggedIn = true;
        const orders = json.data?.orders || [];
        if (orders.length > 0) {
          const latest = orders[0];
          const orderTotal = latest.order_total || latest.net_total || 'N/A';
          const orderTime = latest.order_time ? new Date(latest.order_time).toLocaleDateString() : '';
          reportItems.push(
            `<b>${i + 1}. 👤 ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• 🔐 <b>Session:</b> 🟢 <b>Active</b>\n` +
            `• 📦 <b>Orders:</b> ✅ <b>Order kiya hua hai</b> (${orders.length} orders | Latest: #${latest.order_id || latest.id || ''} - ₹${orderTotal} ${orderTime})\n`
          );
        } else {
          reportItems.push(
            `<b>${i + 1}. 👤 ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• 🔐 <b>Session:</b> 🟢 <b>Active</b>\n` +
            `• 📦 <b>Orders:</b> ⚪ <b>Koi order nahi hai (Fresh ID - 0 Orders)</b>\n`
          );
        }
      }
    } catch (netErr) {
      reportItems.push(
        `<b>${i + 1}. 👤 ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
        `• 🔐 <b>Session:</b> ⚠️ Error checking: ${escapeHtml(netErr.message)}\n`
      );
    }
  }

  saveDb(db);

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}

  const finalReport = 
    `<blockquote>🔄 <b>SWIGGY ACCOUNTS AUDIT & REFRESH</b></blockquote>\n\n` +
    reportItems.join('\n') +
    `\n<i>💡 Expired sessions ko automatically logout mark kar diya gaya hai.</i>`;

  await ctx.reply(finalReport, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh Again', 'boss_refresh_all_accounts'),
        Markup.button.callback('📤 Export Accounts', 'boss_export_picker')
      ],
      [
        Markup.button.callback('🚪 Logout Accounts', 'boss_logout_picker'),
        Markup.button.callback('👥 View Accounts', 'boss_view_accounts')
      ]
    ])
  });
});

// Dynamic Session JSON Import Target Selector
bot.action(/^boss_apply_import_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetKey = ctx.match[1];
  const state = userWaitState[ctx.from.id];
  if (!state?.pendingJson) return ctx.answerCbQuery('No pending JSON').catch(() => {});

  if (targetKey === 'new') {
    userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name_for_json', pendingJson: state.pendingJson };
    await ctx.reply(
      `➕ <b>Enter Name for New Account:</b>\n(e.g. <code>Bhai</code>, <code>Chacha</code>, <code>Office</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' }
      }
    );
    return;
  }

  const result = importSessionJson(state.pendingJson, targetKey);
  delete userWaitState[ctx.from.id];
  await ctx.answerCbQuery('Imported! ✅').catch(() => {});

  if (result.success) {
    const db = getDb();
    const accName = db.config.accounts?.[targetKey]?.name || targetKey;
    await ctx.reply(
      `✅ <b>Session Imported to ${accName} Successfully!</b>\n` +
      `Phone: <code>${result.phone}</code>\n` +
      `Account is now 🟢 Logged In and ready for orders!`,
      getBossPanelKeyboard()
    );
  } else {
    await ctx.reply(`❌ Import error: ${result.message}`);
  }
});

// Dynamic Fast OTP Target Selector
bot.action(/^boss_fast_otp_([^_]+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  const phone = ctx.match[2];

  if (targetAcc === 'new') {
    userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name_for_fast_otp', phone };
    await ctx.reply(
      `➕ <b>Enter Name for New Account (${phone}):</b>\n(e.g. <code>Bhai</code>, <code>Chacha</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' }
      }
    );
    return;
  }

  await ctx.answerCbQuery(`Sending OTP to ${phone}... ⚡`).catch(() => {});
  const db = getDb();
  const accName = db.config.accounts?.[targetAcc]?.name || targetAcc;

  const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, targetAcc);
  if (result.success) {
    userWaitState[ctx.from.id] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc,
      phone
    };
    await ctx.reply(
      `📲 <b>OTP Sent</b>\n📱 <code>${phone}</code>\n\n👉 <i>Enter OTP:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Re-enter OTP', `prompt_reenter_otp_${phone}`),
            Markup.button.callback('📨 Resend OTP', `resend_otp_${phone}`)
          ],
          [
            Markup.button.callback('📱 Another Number', 'send_to_another_number'),
            Markup.button.callback('🏠 Main Menu', 'boss_panel_home')
          ],
          [
            Markup.button.callback('❌ Close', 'close_menu')
          ]
        ])
      }
    );
  } else {
    const errCard = formatOtpSendErrorCard(phone, result);
    await ctx.reply(errCard.text, {
      parse_mode: 'HTML',
      ...errCard.keyboard
    });
  }
});

// Amount Setting Button
bot.action(/^boss_set_amount_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_amount', orderId };

  await ctx.reply(
    `💰 <b>Set Amount for Order #${orderId}:</b>\n\n` +
    `Current: <b>₹${order.finalPayable || 350}</b>\n\n` +
    `<i>Naya amount chat me likh kar bhejein (jaise 450):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter amount in ₹...' }
    }
  );
});

// Boss Manual Coupon Code Setting Button
bot.action(/^boss_set_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_coupon', orderId };

  await ctx.reply(
    `🎟️ <b>Apply Coupon Code for Order #${orderId}:</b>\n\n` +
    `Current Applied: <b>${order.couponCode ? order.couponCode + ' (−₹' + (order.discountAmount || 0) + ')' : 'None'}</b>\n\n` +
    `<i>Swiggy coupon code likh kar bhejein (jaise: <b>WELCOME50</b>, <b>TRYNEW</b>, <b>SWIGGY50</b>, <b>MIDNIGHT</b>, ya <b>REMOVE</b>):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter coupon code (e.g. WELCOME50)...' }
    }
  );
});

// Boss Refresh Cart & Offers Button
bot.action(/^boss_refresh_cart_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery('Re-fetching cart & best coupons with Swiggy... ⏳').catch(() => {});
  await ctx.reply(`⏳ <i>Re-inspecting Swiggy cart and checking best offers for Order #${orderId}...</i>`, { parse_mode: 'HTML' });
  triggerBackgroundCartFetch(orderId).catch(err => console.error('[RefreshCart] error:', err.message));
});

// Phase 3 -> Phase 4: User accepts the order amount -> Automatically send authentic UPI QR!
bot.action(/^user_accept_amount_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  // Security check: Only the customer who owns this order (or boss) can accept
  if (Number(order.userId) !== Number(ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }

  // State check: Order must not be completed or cancelled
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
    return ctx.answerCbQuery(`Order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.amountAccepted = true;
  order.status = 'AMOUNT_CONFIRMED';
  order.qrSent = true;
  saveDb(db);

  await ctx.answerCbQuery('Amount Accepted! Generating UPI QR... 💳').catch(() => {});

  // Generate UPI QR Code automatically using bot's configured UPI ID
  const upiId = db.config.bossUpiId || '6296591407@ybl';
  const amt = order.finalPayable || 57;
  const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=Swiggy&am=${amt}&cu=INR&tn=Swiggy_Order_${order.id}`;
  let qrBuf = null;
  try {
    qrBuf = await QRCode.toBuffer(upiUri, { width: 350, margin: 2 });
  } catch (err) {
    console.error('Failed to generate QR buffer:', err.message);
  }

  if (qrBuf && (order.userChatId || order.userId)) {
    try {
      const targetChat = order.userChatId || order.userId;
      await bot.telegram.sendPhoto(targetChat, { source: qrBuf }, {
        caption: `💳 <b>Payment QR Code (#${order.id})</b>\n\n` +
          `💰 <b>Payable Amount:</b> <b>₹${amt}</b>\n` +
          `📌 <b>UPI ID:</b> <code>${upiId}</code>\n\n` +
          `<i>Kisi bhi UPI app (GPay, PhonePe, Paytm) se scan karke ₹${amt} pay karein. Payment hone ke baad neeche "Confirm Payment" button dabayein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💸 Confirm Payment / Done', `user_confirm_order_${order.id}`)],
          [Markup.button.callback('🟠 Cancel Order', `action_cancel_order_confirm_${order.id}`)]
        ])
      });
    } catch (e) {
      console.error('Failed to send QR photo to user:', e.message);
    }
  }

  // Update in-place on User & Boss single cards
  await updateOrderCards(order);
});

// Screen 3 -> Screen 4: Generate QR Button
bot.action(/^boss_generate_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!order.finalPayable || Number(order.finalPayable) <= 0) {
    if (order.subtotal && Number(order.subtotal) > 0) {
      order.finalPayable = Math.round(order.subtotal);
    } else {
      return ctx.answerCbQuery('⚠️ Pehle Amount set karein (Amount must be > 0)!', { show_alert: true }).catch(() => {});
    }
  }

  order.amountAccepted = true;
  if (order.status === 'PENDING') {
    order.status = 'ACCEPTED';
    order.acceptedAt = new Date().toISOString();
    db.config.slotsLeft = Math.max(0, (db.config.slotsLeft || 1) - 1);
  }

  await ctx.answerCbQuery('Generating genuine payment QR... ⚡').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  const upiId = db.config?.bossUpiId || '6296591407@ybl';
  const payeeName = order.restaurantName || 'Swiggy Food Order';

  const userButtons = [
    [Markup.button.url('🟢 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [Markup.button.callback('💸 Confirm Payment / Done', `user_confirm_order_${orderId}`)]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    userButtons.push([Markup.button.url('🟣 Open Swiggy Cart / Items', order.cart)]);
  }

  const bossButtons = [
    [Markup.button.url('Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('Swiggy Cart / Group Order', order.cart)]);
  }

  let qrDelivered = false;

  // Case 1: Custom real Swiggy QR screenshot uploaded by Boss
  if (order.customQrFileId) {
    try {
      await bot.telegram.sendPhoto(order.userId, order.customQrFileId, {
        caption: `🟢 <b>Swiggy Genuine Payment QR (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n📱 <b>Payment Instructions:</b>\n` +
          `1. Kisi bhi UPI App (PhonePe, Google Pay, Paytm, BHIM) se yeh QR scan karein.\n` +
          `2. Exact <b>₹${payable}</b> pay karein.\n` +
          `3. Payment hone ke baad niche <b>[ 💸 Confirm Payment / Done ]</b> dabayein!`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      qrDelivered = true;
    } catch (err) {
      console.error('Failed to send genuine QR to user:', err.message);
    }

    try {
      const userProfileUrl = `tg://user?id=${order.userId}`;
      await ctx.replyWithPhoto(order.customQrFileId, {
        caption: `⚡ <b>GENUINE PAYMENT QR DELIVERED!</b>\n\n` +
          `📌 <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `👤 <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
          `🌐 <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
          `<i>Genuine QR image successfully delivered to User and Boss.</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (err) {
      console.error('Failed to send genuine QR to boss:', err.message);
    }
  } else {
    // Case 2: Instant High-Resolution Scannable UPI QR (< 100ms)
    try {
      const upiUri = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${payable}&cu=INR&tn=Swiggy_Order_${orderId}`;
      const qrBuffer = await QRCode.toBuffer(upiUri, {
        width: 800,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });

      await bot.telegram.sendPhoto(order.userId, { source: qrBuffer }, {
        caption: `🟢 <b>Swiggy Payment QR (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Food Order')}\n` +
          `💰 <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n📱 <b>Payment Instructions:</b>\n` +
          `1. Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se QR scan karein.\n` +
          `2. Exact <b>₹${payable}</b> pay karein.\n` +
          `3. Payment hone ke baad niche <b>[ 💸 Confirm Payment / Done ]</b> dabayein:`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });

      const userProfileUrl = `tg://user?id=${order.userId}`;
      await ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: `⚡ <b>AUTHENTIC UPI PAYMENT QR DELIVERED!</b>\n\n` +
          `📌 <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `👤 <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
          `💳 <b>Receiving UPI ID:</b> <code>${upiId}</code>\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n\n` +
          `<i>User ke chat me scannable QR bhej diya gaya hai! Payment hote hi user confirm karega.</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });

      qrDelivered = true;
    } catch (qrErr) {
      console.error('Failed to generate UPI QR:', qrErr.message);
      await ctx.reply(`❌ QR Generation Error: ${qrErr.message}`);
      return;
    }
  }

  if (qrDelivered) {
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);
  }
});

// Boss Get QR button (Card 3 in FigJam)
bot.action(/^boss_get_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Fetching genuine payment info... 📷').catch(() => {});
  const payable = order.finalPayable || order.subtotal || 0;

  const bossButtons = [
    [Markup.button.url('Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('Swiggy Cart / Group Order', order.cart)]);
  }

  if (order.customQrFileId) {
    await ctx.replyWithPhoto(order.customQrFileId, {
      caption: `📷 <b>GENUINE PAYMENT QR FOR REQUEST #${orderId}</b>\n\n` +
        `💰 <b>Amount:</b> <b>₹${payable}</b>\n` +
        `🌐 <b>Swiggy Payment:</b> <code>https://www.swiggy.com/payments</code>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    });
  } else {
    try {
      const upiId = db.config?.bossUpiId || '8249789547@paytm';
      const payeeName = order.restaurantName || 'Swiggy Food Order';
      const upiUri = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${payable}&cu=INR&tn=Swiggy_Order_${orderId}`;
      const qrBuffer = await QRCode.toBuffer(upiUri, {
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      await ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: `📷 <b>AUTHENTIC UPI PAYMENT QR FOR REQUEST #${orderId}</b>\n\n` +
          `💰 <b>Amount:</b> <b>₹${payable}</b>\n` +
          `💳 <b>Receiving UPI:</b> <code>${upiId}</code>\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n\n` +
          `<i>Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se scan karke payment ho jayega!</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (e) {
      await ctx.reply(`❌ QR Generation Error: ${e.message}`);
    }
  }
});

// Boss Upload Custom Swiggy QR Prompt
bot.action([/^boss_upload_custom_qr_(.+)$/, /^boss_prompt_send_qr_(.+)$/, /^boss_send_payment_qr_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery().catch(() => {});

  // If genuine QR is already captured from Swiggy checkout, send immediately to user!
  if (order.genuineQrBuffer || order.customQrFileId) {
    await sendPaymentQrToUser(order);
    return ctx.reply(`✅ <b>Genuine Swiggy Payment QR successfully sent to Customer for Order #${orderId}!</b>`, { parse_mode: 'HTML' });
  }

  userWaitState[ctx.from.id] = { action: 'waiting_custom_qr_photo', orderId };
  await ctx.reply(
    `📸 <b>Send Genuine Swiggy Payment QR (Order #${orderId}):</b>\n\n` +
    `Swiggy checkout/payment screen se genuine payment QR ka screenshot image ke roop me chat me send karein:\n\n` +
    `👉 Yeh photo seedha customer ko deliver ho jayegi aur customer scan karke Swiggy ko pay kar sakega!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '📎 Send QR screenshot here...'
      }
    }
  );
});

// Boss Live Swiggy Payment Screen Capture
bot.action(/^boss_live_pay_screen_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];
  if (!acc?.cookies) {
    return ctx.answerCbQuery('Selected account does not have active cookies!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Capturing live Swiggy payment screen... 📸').catch(() => {});
  const statusMsg = await ctx.reply('⏳ <i>Opening Swiggy checkout & capturing live payment screen with cookies...</i>', { parse_mode: 'HTML' });

  const buf = await captureSwiggyPaymentScreenshot(acc.cookies);
  if (buf) {
    await ctx.replyWithPhoto({ source: buf }, {
      caption: `📸 <b>Live Swiggy Checkout / Payment Screen (Order #${orderId})</b>\n\n` +
        `👤 Account: <b>${acc.name || accKey}</b>\n` +
        `💰 Payable: <b>₹${order.finalPayable || 0}</b>\n\n` +
        `<i>Aap is screenshot ko Ammi ko bhej sakte hain ya payment page par jaakar pay kar sakte hain.</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('🌐 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
        [Markup.button.callback('📤 Send this Screen to Ammi', `boss_forward_live_screen_${orderId}`)]
      ])
    });
  } else {
    await ctx.reply('⚠️ Could not capture live payment screen. Swiggy session might need fresh cookies.');
  }

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}
});

// Boss Forward Live Screenshot to User / Ammi
bot.action(/^boss_forward_live_screen_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];
  if (!acc?.cookies) {
    return ctx.answerCbQuery('No cookies available!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Sending screen to Ammi... 📤').catch(() => {});
  const buf = await captureSwiggyPaymentScreenshot(acc.cookies);
  if (buf) {
    const payable = order.finalPayable || 350;
    try {
      await bot.telegram.sendPhoto(order.userId, { source: buf }, {
        caption: `🟢 <b>Swiggy Live Payment Screen (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne Swiggy payment screen bhej di hai! Payment karein ya confirm order dabayein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🌐 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
          ...(order.cart?.startsWith('http') ? [[Markup.button.url('🛒 Open Swiggy Cart / Items', order.cart)]] : []),
          [Markup.button.callback('💸 confirm order', `user_confirm_order_${orderId}`)]
        ])
      });
      await ctx.reply(`✅ <b>Live Swiggy payment screen deliver ho gaya Ammi/User ko!</b>`);
    } catch (err) {
      await ctx.reply(`❌ Failed to send photo to user: ${err.message}`);
    }
  } else {
    await ctx.reply('⚠️ Failed to capture screenshot.');
  }
});

// Copy Cart fallback handlers
bot.action(/^(?:boss_copy_cart_|boss_copy_cart_link_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order || !order.cart) return ctx.answerCbQuery('Cart link not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Cart link copied!').catch(() => {});
  await ctx.reply(`🟣 <b>Cart Link (#${orderId}):</b>\n<code>${escapeHtml(order.cart)}</code>`, { parse_mode: 'HTML' });
});

// Copy Address fallback handlers
bot.action(/^(?:boss_copy_addr_|boss_copy_addr_link_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order || !order.address) return ctx.answerCbQuery('Address link not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Address link copied!').catch(() => {});
  await ctx.reply(`🔵 <b>Address Link (#${orderId}):</b>\n<code>${escapeHtml(order.address)}</code>`, { parse_mode: 'HTML' });
});

// Cancel Order button: Prompt confirmation (Card Row 2 in FigJam)
bot.action(/^boss_prompt_cancel_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  const userProfileUrl = `tg://user?id=${order.userId}`;
  const text = `⚠️ <b>Kya aap waqai Order #${orderId} cancel karna chahte hain?</b>\n\n` +
    `👤 <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
    `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
    `💰 <b>Amount:</b> ₹${order.finalPayable || 0}\n\n` +
    `<i>Niche confirmation select karein:</i>`;

  const buttons = [
    [
      Markup.button.callback('Are you sure (Cancel)', `boss_confirm_cancel_${orderId}`),
      Markup.button.callback('Keep Order', `boss_keep_order_${orderId}`)
    ]
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
});

// Boss Keep Order (cancel aborted)
bot.action(/^boss_keep_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Order active hai 🟢').catch(() => {});
  const card = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
  } catch (e) {
    await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
  }
});

// Boss Confirm Cancel Order (Performs cancellation and deletes message cards)
bot.action(/^(?:boss_confirm_cancel_|boss_cancel_order_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  const prevStatus = order.status;
  if (prevStatus === 'ACCEPTED') {
    db.config.slotsLeft = Math.min(db.config.totalSlots, (db.config.slotsLeft || 0) + 1);
  }

  order.status = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  saveDb(db);
  await ctx.answerCbQuery('Order Cancelled 🔴').catch(() => {});

  // 1. Delete message from current chat
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // 2. Delete order card messages from all chats
  await deleteOrderMessages(order);

  // 3. Confirm to Boss with direct View Cancelled Orders button
  await ctx.reply(
    `🗑️ <b>Order #${orderId} cancel kar diya gaya aur card delete ho gaya!</b>\n\n` +
    `Sabhi cancelled orders dekhne ke liye neeche button dabayein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ View Cancelled Orders', 'boss_view_cancelled_orders')]
      ])
    }
  );

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `❌ <b>Order #${orderId} cancel kar diya gaya hai.</b>\n\nAap dobara naya link bhej sakte hain.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
});

// Remind Fee button (Card Row 2 in FigJam)
bot.action(/^boss_remind_fee_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Reminder sent to parent! 🔔').catch(() => {});
  const payable = order.finalPayable || order.subtotal || 350;

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `❤️ <b>Khushamdeed! Beta ne Swiggy order amount ₹${payable} verify kar diya hai.</b>\n\n` +
      `Kripya screen par <b>[ ✅ Accept Order (Amount Okay) ]</b> dabayein taaki beta payment QR bhej sake!`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
});

// Common handler for payment verification and real tracking extraction
async function handleConfirmOrderPaid(ctx, orderId, confirmedBy) {
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery('Verifying payment with Swiggy API... ⏳').catch(() => {});

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config.accounts?.[accKey];
  const trackingData = await extractRealSwiggyTracking(acc?.cookies || '');

  if (trackingData && trackingData.orderId) {
    // Verified payment and live order confirmed by authorized Swiggy API
    order.paidByUser = true;
    order.paymentStatus = 'VERIFIED';
    order.status = 'ACCEPTED';
    order.swiggyOrderId = trackingData.orderId;
    order.trackingLink = trackingData.trackingUrl;
    saveDb(db);

    // Update single cards in-place for both Ammi and Beta
    await updateOrderCards(order);

    const role = getFamilyRole(order.userId, order.userName);

    // Send message with permanent button to Ammi
    try {
      await bot.telegram.sendMessage(
        order.userId,
        `❤️🛵 <b>${role}, Beta ne aapka Swiggy order place kar diya hai!</b>\n\n` +
        `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(trackingData.orderId)}</code>\n` +
        `Khana restaurant me ban raha hai aur delivery boy samaan lekar nikal raha hai.\n\n` +
        `📍 <b>Live Tracking Link:</b>\n<code>${escapeHtml(trackingData.trackingUrl)}</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🛵 Open Swiggy Live Tracking', trackingData.trackingUrl)]
          ])
        }
      );
    } catch (e) {
      console.error('Failed to send tracking to user:', e.message);
    }

    // Send message with permanent button to Boss
    for (const bossId of db.config.bossIds) {
      try {
        await bot.telegram.sendMessage(
          bossId,
          `🎉 <b>Payment Verified via Swiggy API (Request #${orderId})!</b>\n\n` +
          `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(trackingData.orderId)}</code>\n` +
          `🛵 <b>Real Live Tracking:</b>\n<code>${escapeHtml(trackingData.trackingUrl)}</code>\n\n` +
          `Card is now in State 4 (Tracking Link Sent). Tap [ 🟢 Mark as complete ] when delivered!`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('🛵 Open Swiggy Live Tracking', trackingData.trackingUrl)]
            ])
          }
        );
      } catch (e) {}
    }
  } else {
    // Payment is confirmed by user, awaiting final order placement & tracking link
    order.paidByUser = true;
    order.paymentStatus = 'PAID_BY_USER';
    order.status = 'ACCEPTED';
    order.acceptedAt = new Date().toISOString();
    db.config.slotsLeft = Math.max(0, (db.config.slotsLeft || 1) - 1);
    saveDb(db);
    await updateOrderCards(order);

    // Notify Boss that User confirmed payment
    for (const bossId of db.config.bossIds) {
      try {
        const userProfileUrl = `tg://user?id=${order.userId}`;
        await bot.telegram.sendMessage(
          bossId,
          `💸 <b>PAID ORDER! <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> ne ₹${order.finalPayable || 0} ka payment confirm kar diya hai! (#${orderId})</b>\n\n` +
          `🆔 <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Amount:</b> ₹${order.finalPayable || 0}\n` +
          (order.cart ? `🛒 <b>Cart:</b> <code>${escapeHtml(order.cart)}</code>\n` : '') +
          (order.address ? `📍 <b>Address:</b> <code>${escapeHtml(order.address)}</code>\n\n` : '\n') +
          `👉 Kripya Swiggy me order place karke live tracking link share karein:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                makeCopyButton('🟣 Copy Cart', order.cart || '', `boss_copy_cart_${orderId}`),
                makeCopyButton('🔵 Copy Address', order.address || '', `boss_copy_addr_${orderId}`)
              ],
              [Markup.button.callback('🛵 Send Tracking Link', `boss_tracking_${orderId}`)],
              [Markup.button.callback('🟢 Mark as Complete', `boss_action_done_${orderId}`)]
            ])
          }
        );
      } catch (e) {}
    }

    await ctx.reply(
      `🎉 <b>Payment confirmation received! (#${orderId})</b>\n\n` +
      `Aapka Swiggy order place kiya ja raha hai. Jald hi delivery tracking link mil jayega! 🛵\n\n` +
      `👉 <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  }
}

bot.action(/^user_confirm_order_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});
  if (Number(order.userId) !== Number(ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }
  await handleConfirmOrderPaid(ctx, orderId, 'User');
});

bot.action(/^user_resend_qr_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Resending QR Code... ⚡').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.reply('Order not found');
  await sendPaymentQrToUser(order);
});

bot.action(/^boss_confirm_paid_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await handleConfirmOrderPaid(ctx, orderId, 'Boss');
});

// View Family Accounts
bot.action('boss_view_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showFamilyAccounts(ctx);
});

bot.hears('👥 Family Accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showFamilyAccounts(ctx);
});

async function showFamilyAccounts(ctx) {
  const db = getDb();
  const accounts = db.config.accounts || {};
  const activeKey = db.config.activeOrderAccount;

  let text = `👥 <b>CONNECTED SWIGGY ACCOUNTS (${Object.keys(accounts).length}):</b>\n\n`;
  if (Object.keys(accounts).length === 0) {
    text += `<i>Koi bhi account connected nahi hai.\nNiche diye buttons se JSON ya Number se login karein!</i>\n\n`;
  } else {
    for (const [key, acc] of Object.entries(accounts)) {
      const status = acc.isLoggedIn ? `🟢 Logged In` : '⚪ Logged Out';
      const isActive = key === activeKey ? ' ⭐ <b>[ACTIVE FOR ORDERS]</b>' : '';
      text += `• <b>${escapeHtml(acc.name || key)}</b>${isActive}\n` +
        `  📌 Status: <b>${status}</b>\n` +
        `  📱 Phone: <code>${acc.phone || 'Not set'}</code>\n` +
        `  🆔 Customer ID: <code>${acc.customerId || 'Linked'}</code>\n\n`;
    }
  }

  const buttons = [
    [
      Markup.button.callback('🎁 Claim ₹50 Off Offers (All Accounts)', 'boss_claim_all_event_offers')
    ],
    [
      Markup.button.callback('Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('Refresh All Accounts', 'boss_refresh_all_accounts'),
      Markup.button.callback('Export Session JSON', 'boss_export_picker')
    ],
    [
      Markup.button.callback('Logout Accounts', 'boss_logout_picker'),
      Markup.button.callback('Delete Account', 'boss_delete_picker')
    ],
    [
      Markup.button.callback('Switch Active Account', 'boss_switch_active_picker'),
      Markup.button.callback('Main Menu', 'boss_panel_home')
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
}

// Boss Action: Claim ₹50 Off Offers in All Logged-in Accounts
bot.action('boss_claim_all_event_offers', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery('Claiming ₹50 Off offers in all accounts... 🚀').catch(() => {});

  const db = getDb();
  const accounts = db.config.accounts || {};
  const accEntries = Object.entries(accounts);

  if (accEntries.length === 0) {
    return ctx.reply('⚠️ <b>Koi bhi logged-in account nahi mila!</b>\n\nPehle Number ya JSON se account add karein.', {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
  }

  const waitMsg = await ctx.reply(
    `⏳ <b>Swiggy Breakfast & Late Night Offers Claiming...</b>\n\n` +
    `🍳 <b>Breakfast (6AM–11AM):</b> ₹50 OFF on ₹199\n` +
    `🌙 <b>Dinner Late Night (9PM–11PM):</b> ₹50 OFF on ₹199\n\n` +
    `<i>Sabhi ${accEntries.length} accounts me Swiggy backend API call ki ja rahi hai...</i>`,
    { parse_mode: 'HTML' }
  );

  let successCount = 0;
  let partialCount = 0;
  let failCount = 0;
  const results = [];

  for (const [key, acc] of accEntries) {
    const accLabel = `${acc.phone || key}${acc.name ? ` (${acc.name})` : ''}`;
    try {
      const claimRes = await claimSwiggyBreakfastAndLateNightOffers(acc);
      acc.offers = claimRes;
      if (claimRes.bothClaimed) {
        successCount++;
      } else if (claimRes.success) {
        partialCount++;
      } else {
        failCount++;
      }
      results.push({
        label: accLabel,
        key,
        res: claimRes
      });
    } catch (e) {
      failCount++;
      results.push({
        label: accLabel,
        key,
        res: { success: false, error: e.message }
      });
    }
  }

  saveDb(db);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  let reportText = `🎁 <b>SWIGGY OFFERS CLAIM REPORT (ALL ACCOUNTS)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🍳 <b>Breakfast (6AM–11AM):</b> 50 OFF on 199\n` +
    `🌙 <b>Late Night (9PM–11PM):</b> 50 OFF on 199\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const item of results) {
    const r = item.res;
    if (r.error || r.reason) {
      reportText += `📱 <b>${escapeHtml(item.label)}:</b>\n` +
        `  ❌ <b>Status:</b> <code>${escapeHtml(r.error || r.reason)}</code>\n\n`;
      continue;
    }

    const bf = r.breakfast || {};
    const ln = r.lateNight || {};

    const bfTag = bf.status === 'CLAIMED' ? '✅ CLAIMED' : '❌ FAILED';
    const lnTag = ln.status === 'CLAIMED' ? '✅ CLAIMED' : '❌ FAILED';

    reportText += `📱 <b>${escapeHtml(item.label)}:</b>\n` +
      `  • 🍳 <b>Breakfast:</b> ${bfTag} (50 off on 199)\n` +
      `    <i>${escapeHtml(bf.message || bf.rawMessage || 'Done')}</i>\n` +
      `  • 🌙 <b>Late Night:</b> ${lnTag} (50 off on 199)\n` +
      `    <i>${escapeHtml(ln.message || ln.rawMessage || 'Done')}</i>\n\n`;
  }

  reportText += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Summary:</b> <b>${successCount}</b> Fully Active | <b>${partialCount}</b> Partial | <b>${failCount}</b> Failed\n` +
    `<i>100% Genuine Swiggy responses recorded directly from Swiggy API!</i>`;

  const buttons = [
    [
      Markup.button.callback('🔄 Retry Claim in All', 'boss_claim_all_event_offers'),
      Markup.button.callback('👥 View Accounts', 'boss_view_accounts')
    ],
    [
      Markup.button.callback('🏠 Boss Panel', 'boss_panel_home')
    ]
  ];

  await sendSafeHtml(ctx, reportText, Markup.inlineKeyboard(buttons));
});

// Switch Active Account Picker
bot.action('boss_switch_active_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};
  const buttons = [];
  for (const [k, a] of Object.entries(accounts)) {
    const isAct = db.config.activeOrderAccount === k ? '⭐ ' : '';
    buttons.push([Markup.button.callback(`${isAct}${a.name || k} (${a.phone || ''})`, `boss_set_active_${k}`)]);
  }
  buttons.push([Markup.button.callback('🔙 Back', 'boss_view_accounts')]);

  await ctx.reply(
    `🔄 <b>SELECT ACTIVE ACCOUNT FOR ORDERS:</b>\n\n` +
    `Orders place karte waqt by-default kaunsa account use karna hai?`,
    Markup.inlineKeyboard(buttons)
  );
});

bot.action(/^boss_set_active_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found').catch(() => {});

  setActiveOrderAccountKey(key);
  await ctx.answerCbQuery(`Active account set to ${acc.name || key} ⭐`).catch(() => {});
  await showFamilyAccounts(ctx);
});


// ================= VOICE MESSAGE HANDLER =================

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;

  if (isBoss(userId) && userWaitState[userId]?.action === 'reply_voice') {
    const targetUserId = userWaitState[userId].targetUserId;
    const orderId = userWaitState[userId].orderId;
    delete userWaitState[userId];

    try {
      await bot.telegram.sendVoice(targetUserId, ctx.message.voice.file_id, {
        caption: `❤️ <b>Beta ka aawaaz sandesh (Order #${orderId}):</b>`,
        parse_mode: 'HTML'
      });
      await ctx.reply(`✅ <b>Voice note successfully sent to Ammi/Abbu!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Failed to deliver voice note: ${err.message}`);
    }
    return;
  }

  const db = getDb();
  const role = getFamilyRole(userId, 'Ammi');
  const orderId = String(Date.now()).slice(-5);

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'VOICE',
    fileId: ctx.message.voice.file_id,
    address: null,
    cart: null,
    selectedAccount: getActiveOrderAccountKey(db),
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  saveDb(db);

  await ctx.reply(
    `❤️ <b>Aapki aawaaz beta tak pahunch gayi hai!</b>\n\n` +
    `<i>Beta abhi aapka voice note sun kar Swiggy se order place kar rahe hain. Aap befikr rahiye.</i>`,
    { parse_mode: 'HTML' }
  );

  for (const bossId of db.config.bossIds) {
    try {
      const card = formatBossOrderCard(newOrder);
      await sendCardSafe(bossId, card);
      const userProfileUrl = `tg://user?id=${newOrder.userId}`;
      await bot.telegram.sendVoice(bossId, ctx.message.voice.file_id, {
        caption: `🎙️ <b>Listen to <a href="${userProfileUrl}">${role}</a>'s Voice Note (Request #${orderId})</b>\n🆔 <b>User TG ID:</b> <a href="${userProfileUrl}">${newOrder.userId}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Failed to notify boss of voice note:', e.message);
    }
  }
});

// ================= PHOTO HANDLER =================

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];

  if (state && (state.action === 'waiting_qr' || state.action === 'waiting_custom_qr_photo')) {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('❌ Order could not be found.');

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;

    order.customQrFileId = fileId;
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);

    const payable = order.finalPayable || 350;
    const userButtons = [
      [Markup.button.url('🌐 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('💸 confirm order', `user_confirm_order_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('🛒 Open Swiggy Cart / Items', order.cart)]);
    }

    try {
      await bot.telegram.sendPhoto(order.userId, fileId, {
        caption: `🟢 <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne authorized Swiggy payment QR bhej diya hai! Kisi bhi UPI app (Google Pay / PhonePe / Paytm) se scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });

      await ctx.reply(`✅ <b>Custom Swiggy QR successfully delivered to ${escapeHtml(order.userName)}!</b>\n\nUser ke payment confirm karte hi Swiggy live tracking extract hokar dono ko mil jayegi.`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Failed to send screenshot: ${err.message}`);
    }
    return;
  }

  const db = getDb();
  const role = getFamilyRole(userId, 'Ammi');
  const orderId = String(Date.now()).slice(-5);
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'PHOTO',
    fileId: photo.file_id,
    address: null,
    cart: null,
    selectedAccount: getActiveOrderAccountKey(db),
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  saveDb(db);

  await ctx.reply(
    `❤️ <b>Parchi / Photo beta tak pahunch gayi hai!</b>\n\n` +
    `<i>Beta abhi samaan dekh kar order kar rahe hain.</i>`,
    { parse_mode: 'HTML' }
  );

  for (const bossId of db.config.bossIds) {
    try {
      const card = formatBossOrderCard(newOrder);
      await sendCardSafe(bossId, card);
      const userProfileUrl = `tg://user?id=${newOrder.userId}`;
      await bot.telegram.sendPhoto(bossId, photo.file_id, {
        caption: `📷 <b>Photo / List sent by <a href="${userProfileUrl}">${role}</a> (Request #${orderId})</b>\n🆔 <b>User TG ID:</b> <a href="${userProfileUrl}">${newOrder.userId}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Failed to notify boss of photo:', e.message);
    }
  }
});

// ================= DOCUMENT HANDLER =================
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  const doc = ctx.message.document;
  if (!doc) return;

  // Handle .json file upload for Login with JSON
  if (doc.file_name && doc.file_name.toLowerCase().endsWith('.json') && isBoss(userId)) {
    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(fileLink.href);
      const fileText = await res.text();
      await handleProcessJsonLogin(ctx, fileText, userId);
      return;
    } catch (e) {
      return ctx.reply('⚠️ JSON file process karne me error aaya: ' + e.message);
    }
  }

  if (state && (state.action === 'waiting_qr' || state.action === 'waiting_custom_qr_photo')) {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('❌ Order could not be found.');

    order.customQrFileId = doc.file_id;
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);

    const payable = order.finalPayable || 350;
    const userButtons = [
      [Markup.button.url('🌐 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('💸 confirm order', `user_confirm_order_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('🛒 Open Swiggy Cart / Items', order.cart)]);
    }

    try {
      await bot.telegram.sendDocument(order.userId, doc.file_id, {
        caption: `🟢 <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne authorized Swiggy payment QR document bhej diya hai! QR scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      await ctx.reply(`✅ <b>Custom Swiggy QR document successfully delivered to ${escapeHtml(order.userName)}!</b>`);
    } catch (err) {
      await ctx.reply(`❌ Failed to send document to user: ${err.message}`);
    }
    return;
  }
});

// ================= BOSS CARE ACTIONS =================

// Send Tracking Link to Parent
bot.action(/^boss_tracking_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_tracking', orderId };

  await ctx.reply(
    `🛵 <b>Paste Swiggy Live Tracking Link or Rider Number for #${orderId}:</b>\n\n` +
    `<i>It will be sent directly to ${escapeHtml(order.userName)}!</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste Swiggy tracking URL here...' }
    }
  );
});

// Reply with Voice
bot.action(/^boss_reply_voice_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'reply_voice', orderId, targetUserId: order.userId };

  await ctx.reply(
    `🎙️ <b>Record and send your Voice Message now:</b>\n` +
    `It will be sent straight to ${escapeHtml(order.userName)}.`,
    { parse_mode: 'HTML' }
  );
});

// Tag as Ammi
bot.action(/^boss_tag_ammi_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetUserId = ctx.match[1];
  const orderId = ctx.match[2];

  setFamilyRole(targetUserId, 'Ammi');
  await ctx.answerCbQuery('Tagged as Ammi! ❤️').catch(() => {});

  const db = getDb();
  const order = db.orders[orderId];
  if (order) {
    const updated = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updated.text, { parse_mode: 'HTML', ...updated.keyboard });
    } catch (e) {}
  }
});

// Tag as Abbu
bot.action(/^boss_tag_abbu_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetUserId = ctx.match[1];
  const orderId = ctx.match[2];

  setFamilyRole(targetUserId, 'Abbu');
  await ctx.answerCbQuery('Tagged as Abbu! 👴').catch(() => {});

  const db = getDb();
  const order = db.orders[orderId];
  if (order) {
    const updated = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updated.text, { parse_mode: 'HTML', ...updated.keyboard });
    } catch (e) {}
  }
});

// Accept Order
bot.action(/^boss_action_accept_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!canTransitionOrder(order.status, 'ACCEPTED') || order.status !== 'PENDING') {
    return ctx.answerCbQuery(`Cannot accept: order is currently ${order.status}`, { show_alert: true }).catch(() => {});
  }

  if (db.config.slotsLeft <= 0) {
    order.status = 'REJECTED';
    order.rejectedAt = new Date().toISOString();
    order.rejectReason = 'Sorry, slot has ended.';
    saveDb(db);
    await ctx.answerCbQuery('Sorry, slot has ended.', { show_alert: true }).catch(() => {});
    const updatedCard = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updatedCard.text, { parse_mode: 'HTML', ...updatedCard.keyboard });
    } catch (e) {}
    try {
      await bot.telegram.sendMessage(
        order.userId,
        `❌ <b>Sorry, slot has ended.</b>\n\nAapka order accept nahi ho saka kyunki slots khatam ho chuke hain.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {}
    return;
  }

  db.config.slotsLeft = Math.max(0, db.config.slotsLeft - 1);
  order.status = 'ACCEPTED';
  order.acceptedAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('✅ Order Accepted!').catch(() => {});
  await updateOrderCards(order);

  await ctx.reply(`✅ <b>Request #${orderId} Accepted! (Slots Left: ${db.config.slotsLeft}/${db.config.totalSlots})</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `🎉 <b>Aapka Order Accept Ho Gaya Hai! (#${orderId})</b>\n\n` +
      `Beta ne aapka Swiggy order accept kar liya hai aur processing shuru kar di hai. 🛵\n\n` +
      `⚠️ <b>Zaroori Suchna:</b>\n` +
      `Agar aapko koi bhi difficulty, issue ya samasya aati hai, toh kripya direct message karein:\n` +
      `👉 <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  } catch (err) {}
});

// Mark as Done
bot.action(/^boss_action_done_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!canTransitionOrder(order.status, 'COMPLETED')) {
    return ctx.answerCbQuery(`Cannot complete: order is currently ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'COMPLETED';
  order.completedAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('🏁 Marked as Completed!').catch(() => {});
  const updatedCard = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(updatedCard.text, { parse_mode: 'HTML', ...updatedCard.keyboard });
  } catch (e) {}

  await ctx.reply(`🏁 <b>Order #${orderId} marked as COMPLETED!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `🎉 <b>Order Complete!</b>\n\nAapka samaan/order delivered ho gaya hai. Khuda hafiz! ❤️`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {}
});

// Boss generates UPI QR Code / Payment details for Order
bot.action(/^boss_qr_pay_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Fetching genuine payment details... ⚡').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  const bossButtons = [
    [Markup.button.url('🌐 Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('📷 Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('📸 Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('💸 Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];

  if (order.customQrFileId) {
    return ctx.replyWithPhoto(order.customQrFileId, {
      caption: `⚡ <b>GENUINE PAYMENT QR</b>\n\n` +
        `📌 <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
        `🌐 <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
        `<i>Real QR image from checkout session.</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    });
  }

  return ctx.reply(
    `⚡ <b>SWIGGY PAYMENT SESSION</b>\n\n` +
    `📌 <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
    `🌐 <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
    `ℹ️ <i>Swiggy Desktop Web does not return a dynamic UPI QR in checkout options. User can pay via Swiggy Payment Page or you can upload the Swiggy mobile app QR screenshot.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    }
  );
});

// Boss Prompt Send Swiggy Payment Link
bot.action([/^boss_prompt_send_link_(.+)$/, /^boss_send_payment_link_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_swiggy_link', orderId };
  await ctx.reply(
    `🔗 <b>Send Official Swiggy Payment Link (Order #${orderId}):</b>\n\n` +
    `Swiggy checkout page se generated genuine payment link chat me paste karein.\n` +
    `<i>Optional: Amount ke sath bhi likh sakte hain, jaise <code>₹120 https://payments.swiggy.com/...</code> ya seedha URL paste karein.</i>\n\n` +
    `👉 Yeh authentic link seedha customer ko official payment button ke sath deliver ho jayega!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Paste Swiggy payment link here...'
      }
    }
  );
});

// Reject Order / Say Sorry
bot.action(/^boss_action_sorry_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  order.status = 'REJECTED';
  order.rejectedAt = new Date().toISOString();
  order.cancelledAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('❌ Order Rejected').catch(() => {});
  await updateOrderCards(order);

  await ctx.reply(`❌ <b>Order #${orderId} Reject kar diya gaya!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `❌ <b>Aapka Order Reject Ho Gaya Hai (#${orderId})</b>\n\n` +
      `Beta ne filhal yeh order reject kar diya hai.\n\n` +
      `Agar koi bhi difficulty ya sawal hai, toh kripya direct message karein:\n` +
      `👉 <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')],
          [Markup.button.callback('🔄 New Order', 'user_back_to_main')]
        ])
      }
    );
  } catch (err) {}
});

// Upload SS / QR prompt
bot.action(/^boss_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_qr', orderId };

  await ctx.reply(
    `📷 <b>Upload Screenshot / QR for Order #${orderId}:</b>\n\n` +
    `Tap 📎 icon to choose photo from gallery.`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Pick photo...' }
    }
  );
});

// ================= FREE CASH & INSTAMART OFFERS =================

async function showFreeCashMenu(ctx) {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const accKeys = Object.keys(accounts);

  let text = `🎁 <b>CLAIM SWIGGY INSTAMART FREE CASH (₹50-₹60) + FREEBIE</b>\n\n` +
    `Bot pehle account run karke Free Cash actively <b>CLAIM</b> karega aur confirm karega:\n` +
    `• 🟢 <b>CLAIMED:</b> Agar naya Free Cash (₹50/₹60) add ho gaya\n` +
    `• 🟡 <b>ALREADY CLAIMED:</b> Agar is account pe pehle se claim ho chuka hai\n` +
    `• 🔴 <b>NOT ELIGIBLE:</b> Agar account is promo offer ke liye eligible nahi hai\n\n` +
    `<i>Niche apna account select karein ya naya Session JSON / Cookies paste karein:</i>`;

  const buttons = [];
  const accButtons = [];
  for (const k of accKeys) {
    const acc = accounts[k];
    const label = `🎁 ${acc.name || k} (${acc.phone || 'Saved'})`;
    accButtons.push(Markup.button.callback(label, `boss_check_fc_${k}`));
  }
  for (let i = 0; i < accButtons.length; i += 2) {
    buttons.push(accButtons.slice(i, i + 2));
  }

  buttons.push([Markup.button.callback('📄 Paste / Upload Session JSON', 'boss_paste_fc_json')]);
  buttons.push([Markup.button.callback('🔙 Back to Main Panel', 'user_back_to_main')]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.command(['freecash', 'claim', 'claim_freecash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

bot.hears(['🎁 Claim Free Cash', 'Claim Free Cash', 'claim free cash', 'Free Cash', 'free cash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

bot.action('boss_claim_freecash', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showFreeCashMenu(ctx);
});

bot.action('boss_paste_fc_json', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_fc_json' };
  await ctx.reply(
    `📄 <b>Paste / Upload Swiggy Session JSON / Cookies:</b>\n\n` +
    `Apne account ka session JSON ya cookies yahan chat me paste karein.\n` +
    `Bot pehle account ko run karke Free Cash claim karega aur turant batayega:\n` +
    `• <b>CLAIMED</b> (₹50-₹60 credited)\n` +
    `• <b>ALREADY CLAIMED</b> (pehle se availed)\n` +
    `• <b>NOT ELIGIBLE</b> (offer not valid)`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON or cookies here...' }
    }
  );
});

bot.action(/^boss_check_fc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[accKey];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  if (!acc.cookies) {
    return ctx.answerCbQuery('Account me saved cookies/session nahi hai! Pehle login karein.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Running Swiggy Instamart claim engine... ⏳').catch(() => {});
  const statusMsg = await ctx.reply(`⏳ <i>Running Instamart Claim Engine for <b>${escapeHtml(acc.name || accKey)}</b>... Please wait 5-10 seconds...</i>`, { parse_mode: 'HTML' });

  const res = await claimInstamartFreeCash(acc.cookies);

  const accName = escapeHtml(acc.name || accKey);
  const accPhone = escapeHtml(acc.phone || 'N/A');

  if (res.status === 'CLAIMED') {
    const successText = `🎉 <b>SUCCESSFULLY CLAIMED!</b> ❤️\n\n` +
      `👤 <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `💰 <b>Claimed Free Cash:</b> <b>₹${res.amount}</b> (Credited to Swiggy Money!)\n` +
      `💳 <b>Total Current Balance:</b> <b>₹${res.balance}</b>\n` +
      `🎁 <b>Instamart Freebie:</b> UNLOCKED ✅ (Eligible for Freebie on orders above ₹199!)\n` +
      (res.swiggyOne ? `🌟 <b>Swiggy One:</b> Active (Free Delivery Included)\n` : `🛵 <b>Delivery:</b> Free delivery on Instamart\n`) +
      `\n<i>Mubarak ho! Bot ne account run karke Free Cash successfully claim kar liya hai. Ammi/Abbu ke liye Instamart grocery mangwayein aur direct ₹${res.balance} discount enjoy karein!</i>`;

    const buttons = [
      [Markup.button.url('🛒 Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
      [Markup.button.callback('🔄 Check Another Account', 'boss_claim_freecash')]
    ];
    await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else if (res.status === 'ALREADY_CLAIMED') {
    const alreadyText = `ℹ️ <b>ALREADY CLAIMED!</b>\n\n` +
      `👤 <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `⚠️ <b>Status:</b> Is account par Free Cash pehle se claim ho chuka hai.\n` +
      `💰 <b>Available Swiggy Money Balance:</b> <b>₹${res.balance}</b>\n\n` +
      `<i>Yeh balance aapke account me already maujood hai. Aap isse Instamart checkout par use kar sakte hain!</i>`;

    const buttons = [
      [Markup.button.url('🛒 Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
      [Markup.button.callback('🔄 Check Another Account', 'boss_claim_freecash')],
      [Markup.button.callback('📄 Paste Another Session JSON', 'boss_paste_fc_json')]
    ];
    await ctx.reply(alreadyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else {
    const notEligibleText = `❌ <b>NOT ELIGIBLE FOR FREE CASH</b>\n\n` +
      `👤 <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `💰 <b>Free Cash Balance:</b> ₹0\n\n` +
      `<i>Yeh account is promotional Free Cash offer ke liye eligible nahi hai.\n` +
      `Note: Yeh promo offers Swiggy ke naye accounts ya targeted users ke liye aate hain. Aap dusra account try karein!</i>`;

    const buttons = [
      [Markup.button.callback('🔄 Check Another Account', 'boss_claim_freecash')],
      [Markup.button.callback('📄 Paste / Upload Session JSON', 'boss_paste_fc_json')]
    ];
    await ctx.reply(notEligibleText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}
});

// ================= USER & BOSS BOTTOM MENU HEARS =================

// USER BUTTONS (Exact FigJam Diagram + Specification)
bot.hears([
  '🟣 Cart link', '🟣 change cart link', 'Cart link', 'change cart link',
  '🟣 Paste cart link', 'Paste cart link', 'Cart', '🟣 Cart: Added ✅',
  '🟣 Paste Cart Link', 'Paste Cart Link', 'Cart: Added'
], async (ctx) => {
  await handleCartLinkFlow(ctx);
});

bot.hears([
  '🔵 Address link', '🔵 change address link', 'Address link', 'change address link',
  '🔵 Paste address Link', 'Paste address Link', 'Address', '🔵 Address: Added ✅',
  '🔵 Paste Address Link', 'Paste Address Link', 'Address: Added'
], async (ctx) => {
  await handleAddressLinkFlow(ctx);
});

bot.hears([
  'Order Screen', 'Customer Screen', '📦 Order Screen',
  'Send Order to Beta', 'send order to beta', 'SEND ORDER TO BETA',
  'Send to Beta', 'send to beta',
  'Send to Boss', 'send to boss', 'SEND TO BOSS',
  'Send to Admin', '🚀 Send to Beta',
  /send.*order.*beta/i, /send.*beta/i, /send.*boss/i, /send.*admin/i
], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    await ctx.reply('Boss Menu:', getBossReplyKeyboard());
    return ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }
  await handleSendToBoss(ctx);
});

bot.command(['sendtobeta', 'send_to_beta', 'sendorder', 'send_order', 'order'], async (ctx) => {
  await handleSendToBoss(ctx);
});

bot.hears(['Cancel Draft', 'cancel draft', '🟠 Cancel Draft'], async (ctx) => {
  const userId = ctx.from.id;
  clearDraft(userId);
  delete userWaitState[userId];
  await ctx.reply('🟠 <b>Draft cancel kar diya gaya hai!</b>', { parse_mode: 'HTML', ...getUserReplyKeyboard() });
  const screen = getUserScreen(userId, ctx.from);
  return ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(['action_clear_draft', 'action_cancel_draft'], async (ctx) => {
  await ctx.answerCbQuery('Draft Cleared').catch(() => {});
  const userId = ctx.from.id;
  clearDraft(userId);
  delete userWaitState[userId];
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText('🟠 <b>Draft clear ho gaya hai!</b>\n\nNaya cart ya address link bhejein:', {
      parse_mode: 'HTML',
      ...screen.keyboard
    });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.hears(['Cancel Order', 'cancel order', 'Cancel order', '🟠 cancel order', '🟠 Cancel Order'], async (ctx) => {
  await handleCancelOrderConfirm(ctx);
});

bot.hears(['Previous Orders', 'previous orders', 'previous order', 'Previous order', '⚪ previous order'], async (ctx) => {
  await handlePreviousOrder(ctx);
});

bot.hears(['Claim Free Cash', 'claim free cash', 'Free Cash', 'free cash', '🎁 Claim Free Cash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

// BOSS ONLY BOTTOM BUTTONS
bot.hears(['Pending Orders', '🟡 Pending Orders'], async (ctx) => {
  if (isBoss(ctx.from.id)) await sendPendingOrdersToBoss(ctx.from.id);
});

bot.hears(['Connected Accounts', '🟣 Connected Accounts', '👥 My Swiggy Accounts'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleMyAccounts(ctx);
});

bot.hears(['Saved Addresses', '🔵 Saved Addresses', '📍 Saved Addresses'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleSavedAddresses(ctx);
});

bot.hears(['Slot Status', '🟢 Slot Status', '🎰 Slot Status'], async (ctx) => {
  if (isBoss(ctx.from.id)) await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Total Slots', 'Total slots', '📊 Total slots'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_boss_total' };
  await ctx.reply(`<b>Total Slots</b>\n\nEnter number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter number...' }
  });
});

bot.hears(['Total Left', 'Total left', '🟢 Total left'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_boss_left' };
  await ctx.reply(`<b>Total Left</b>\n\nEnter number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter number...' }
  });
});

bot.hears(['Set UPI ID', '🟠 Set UPI ID'], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
    const cur = getDb().config?.bossUpiId || '6296591407@ybl';
    await ctx.reply(
      `💳 <b>Set Boss Payment UPI ID:</b>\nCurrent: <code>${cur}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Main Menu', 'boss_panel_home'),
            Markup.button.callback('Close', 'close_menu')
          ]
        ])
      }
    );
    await ctx.reply('👉 Enter UPI ID:', {
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID (e.g. name@upi)...' }
    });
  }
});

bot.hears(['Login Swiggy', '⚪ Login Swiggy', '🔑 Login Swiggy Account'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handlePromptLogin(ctx);
});

bot.hears(['Login with JSON', '🔑 Login with JSON'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `<b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

bot.hears(['Login with Number', '📱 Login with Number'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await promptBossLoginWithNumber(ctx);
});

bot.hears('🔢 Set Total Slots', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_boss_total' };
  await ctx.reply(`<b>Enter number for Total Slots:</b>`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter total number...' }
  });
});

// Text message handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  const rawText = ctx.message.text.trim();

  // Intercept any menu button, slash command, or cancel keyword to free user from wait state
  const isMenuOrCancel = rawText.startsWith('/') || [
    'Order Screen', 'Pending Orders', 'Login with JSON', 'Login with Number',
    'Connected Accounts', 'Slot Status', 'Total slots', 'Total Slots', 'Total left', 'Total Left',
    'Claim Free Cash', 'Set UPI ID',
    'Cancel', 'cancel', 'Close', 'close', 'back', 'Back',
    'Main Menu', 'Menu',
    // Legacy emoji versions:
    '📦 Order Screen', '🟡 Pending Orders', '🔑 Login with JSON', '📱 Login with Number',
    '🟣 Connected Accounts', '🟢 Slot Status', '📊 Total slots', '🟢 Total left',
    '🎁 Claim Free Cash', '🟠 Set UPI ID', '🔢 Set Total Slots',
    '❌ Cancel', '🏠 Main Menu', '❌ Close'
  ].includes(rawText);

  if (state && isMenuOrCancel) {
    delete userWaitState[userId];
    if (['❌ Cancel', 'Cancel', 'cancel', 'Close', 'close', 'back', 'Back', '❌ Close'].includes(rawText)) {
      if (isBoss(userId)) {
        await ctx.reply('❌ Action cancelled.', getBossReplyKeyboard());
        await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
      } else {
        await ctx.reply('❌ Action cancelled.', getUserReplyKeyboard());
        const screen = getUserScreen(userId, ctx.from);
        await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
      }
      return;
    }
  }

  // Handle in-flight delete OTP initiation (prevents any accidental login trigger while waiting for Swiggy)
  if (state && state.action === 'initiating_swiggy_delete_otp') {
    return ctx.reply('⏳ <i>Swiggy Deletion OTP request process ho rahi hai. Kripya thoda intezaar karein...</i>', { parse_mode: 'HTML' });
  }

  // Handle Delete Account OTP (TOP PRIORITY: MUST BE PROCESSED BEFORE ANY PHONE OR LOGIN DETECTOR)
  if (state && state.action === 'waiting_swiggy_delete_otp') {
    const rawCleanDigits = rawText.replace(/[^0-9]/g, '');

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'close'].includes(rawLower)) {
      delete userWaitState[userId];
      return ctx.reply('❌ <b>Swiggy account deletion cancelled.</b>', getBossPanelKeyboard());
    }

    const enteredOtp = rawCleanDigits;
    if (enteredOtp.length < 4) {
      return ctx.reply(
        `⚠️ <b>Invalid OTP</b>\n\n👉 <i>Enter 6-digit Delete OTP:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🏠 Main Menu', 'boss_panel_home'),
              Markup.button.callback('❌ Close', 'close_menu')
            ]
          ])
        }
      );
    }

    const waitMsg = await ctx.reply('⏳ <i>Verifying Delete OTP with Swiggy and deleting account...</i>', { parse_mode: 'HTML' });
    const key = state.accountKey;
    const phone = state.phone;
    const accName = state.accName;

    // Use dedicated verifyAndDeleteSwiggyAccountViaBridge (NEVER calls login or sms-otp)
    const result = await verifyAndDeleteSwiggyAccountViaBridge(userId, enteredOtp, key).catch(err => ({ success: false, message: err.message }));

    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      delete userWaitState[userId];

      try {
        await deactivateSwiggyAccountViaBridge(userId, key).catch(() => {});
      } catch (e) {}

      deleteAccount(key);
      permanentLogoutAccount(key);

      await ctx.reply(
        `✅ <b>Account Deleted</b>\n` +
        `📱 <code>${phone}</code> (${escapeHtml(accName)})`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('Add Account', 'send_to_another_number'),
              Markup.button.callback('Main Menu', 'boss_panel_home')
            ]
          ])
        }
      );
    } else {
      const swiggyText = result.message || 'Invalid or expired OTP';
      await ctx.reply(
        `❌ <b>${escapeHtml(swiggyText)}</b>\n<code>${phone}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phone } }
              ],
              [
                { text: 'Resend Delete OTP', callback_data: `boss_swiggy_delete_start_${key}` }
              ],
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home' },
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Enter valid Delete OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit Delete OTP...'
        }
      });
    }
    return;
  }

  // 0: Check if Boss is typing a new account name
  if (state && state.action === 'waiting_new_acc_name') {
    const accName = rawText.trim();
    const cleanKey = accName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const orderId = state.orderId;
    delete userWaitState[userId];

    createAccount(cleanKey, accName);
    await ctx.reply(
      `🎉 <b>Account "${accName}" Created Successfully!</b>\n\n` +
      `Ab is account ko Swiggy se connect karne ke liye method select karein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Phone Number + Instant OTP', `boss_login_acc_otp_${cleanKey}${orderId ? '_' + orderId : ''}`)],
          [Markup.button.callback('Paste Session JSON', `boss_login_acc_json_${cleanKey}${orderId ? '_' + orderId : ''}`)]
        ])
      }
    );
    return;
  }

  // 0B: Check if Boss is typing new account name for phone fast OTP
  if (state && state.action === 'waiting_new_acc_name_for_fast_otp') {
    const accName = rawText.trim();
    const cleanKey = accName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const phone = state.phone;
    delete userWaitState[userId];

    createAccount(cleanKey, accName, phone);
    const result = await requestSwiggyOtpViaBridge(userId, phone, cleanKey);
    if (result.success) {
      userWaitState[userId] = { action: 'waiting_swiggy_otp_bridge', targetAcc: cleanKey, phone };
      await ctx.reply(
        `<b>OTP Sent</b>\n<code>${phone}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phone } }
              ],
              [
                { text: '🔄 Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${phone}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
    return;
  }

  // 0C: Check if Boss is typing new account name for JSON import
  if (state && state.action === 'waiting_new_acc_name_for_json') {
    const accName = rawText.trim();
    const cleanKey = accName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const pendingJson = state.pendingJson;
    delete userWaitState[userId];

    createAccount(cleanKey, accName);
    const result = importSessionJson(pendingJson, cleanKey);
    if (result.success) {
      await ctx.reply(
        `✅ <b>Account "${accName}" Created and Session Imported!</b>\n` +
        `Phone: <code>${result.phone}</code>\n` +
        `Account is 🟢 Logged In and ready for orders!`,
        getBossPanelKeyboard()
      );
    } else {
      await ctx.reply(`❌ Import error: ${result.message}`);
    }
    return;
  }

  // Free Cash JSON / Cookies claim runner
  if (state && state.action === 'waiting_fc_json') {
    delete userWaitState[userId];
    const textTrimmed = rawText.trim();
    let cookies = null;
    let sessionName = 'Pasted Session';

    try {
      if (textTrimmed.startsWith('{') || textTrimmed.startsWith('[')) {
        const parsed = JSON.parse(textTrimmed);
        if (Array.isArray(parsed)) {
          cookies = parsed;
          sessionName = 'Cookie Array JSON';
        } else if (typeof parsed === 'object' && parsed !== null) {
          cookies = parsed.cookies || (parsed.tid ? `tid=${parsed.tid}; _sid=${parsed.sid || ''}; _session_id=${parsed._session_id || ''}` : null);
          if (parsed.phone || parsed.mobile) {
            sessionName = `Phone: ${parsed.phone || parsed.mobile}`;
          }
        }
      }
    } catch (e) {}

    if (!cookies && (textTrimmed.includes('=') || textTrimmed.includes('tid') || textTrimmed.includes('_session_id'))) {
      cookies = textTrimmed;
      sessionName = 'Raw Cookie String';
    }

    if (!cookies) {
      return ctx.reply('⚠️ Invalid format. Kripya valid Swiggy session JSON ya cookies string paste karein.');
    }

    const statusMsg = await ctx.reply('⏳ <i>Swiggy Instamart claim engine run ho raha hai... (Checking & Claiming)...</i>', { parse_mode: 'HTML' });
    const res = await claimInstamartFreeCash(cookies);

    if (res.status === 'CLAIMED') {
      const successText = `🎉 <b>SUCCESSFULLY CLAIMED!</b> ❤️\n\n` +
        `👤 <b>Session:</b> ${sessionName}\n` +
        `💰 <b>Claimed Free Cash:</b> <b>₹${res.amount}</b> (Swiggy Money Added!)\n` +
        `💳 <b>Current Total Balance:</b> <b>₹${res.balance}</b>\n` +
        `🎁 <b>Instamart Freebie:</b> UNLOCKED ✅ (Eligible on orders above ₹199!)\n` +
        (res.swiggyOne ? `🌟 <b>Swiggy One:</b> Active (Free Delivery Included)\n` : `🛵 <b>Delivery:</b> Free delivery on Instamart\n`) +
        `\n<i>Mubarak ho! Bot ne account run karke Free Cash claim kar liya hai. Aap is session ko connected accounts me save karke Instamart order place kar sakte hain!</i>`;

      const buttons = [
        [Markup.button.url('🛒 Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
        [Markup.button.callback('💾 Save as Connected Account', 'boss_add_new_account_menu')],
        [Markup.button.callback('🔄 Claim Another Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } else if (res.status === 'ALREADY_CLAIMED') {
      const alreadyText = `ℹ️ <b>ALREADY CLAIMED!</b>\n\n` +
        `👤 <b>Session:</b> ${sessionName}\n` +
        `⚠️ <b>Status:</b> Is account par Free Cash pehle se claim ho chuka hai.\n` +
        `💰 <b>Available Balance:</b> <b>₹${res.balance}</b>\n\n` +
        `<i>Yeh balance aapke account me already maujood hai. Aap isse Instamart checkout par use kar sakte hain!</i>`;

      const buttons = [
        [Markup.button.url('🛒 Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
        [Markup.button.callback('💾 Save as Connected Account', 'boss_add_new_account_menu')],
        [Markup.button.callback('🔄 Claim Another Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(alreadyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } else {
      const notEligibleText = `❌ <b>NOT ELIGIBLE FOR FREE CASH</b>\n\n` +
        `👤 <b>Session:</b> ${sessionName}\n` +
        `💰 <b>Free Cash Balance:</b> ₹0\n\n` +
        `<i>Yeh account is promotional Free Cash offer ke liye eligible nahi hai.\n` +
        `Note: Promo offers Swiggy ke naye accounts ya targeted users ke liye aate hain. Aap dusra JSON try karein!</i>`;

      const buttons = [
        [Markup.button.callback('🔄 Try Another JSON / Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(notEligibleText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }

    try {
      await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}
    return;
  }

  // A: Login with JSON (either waiting_json_login or directly pasted JSON string)
  if ((state && (state.action === 'waiting_json_login' || state.action === 'waiting_json_import')) || (rawText.startsWith('{') && (rawText.includes('cookies') || rawText.includes('tid')))) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed.cookies || parsed.tid) {
        await handleProcessJsonLogin(ctx, rawText, userId);
        return;
      }
    } catch (e) {
      if (state && (state.action === 'waiting_json_login' || state.action === 'waiting_json_import')) {
        return ctx.reply('⚠️ Invalid JSON format. Please send a valid Swiggy session JSON string.');
      }
    }
  }

  // Helper for starting phone number login
  async function triggerPhoneNumberLogin(phoneToLogin, existingAccKey, existingAccName) {
    const accKey = existingAccKey || `acc_${phoneToLogin}`;
    const cleanName = (existingAccName && existingAccName.trim().length >= 2 && !/^user\s*\d*$/i.test(existingAccName.trim()))
      ? existingAccName.trim()
      : null;
    const autoName = cleanName || getNextAutoUserName();
    delete userWaitState[userId];

    const result = await requestSwiggyOtpViaBridge(userId, phoneToLogin, accKey, autoName);

    if (result.needsName) {
      userWaitState[userId] = {
        action: 'waiting_name_for_new_number_signup',
        phone: phoneToLogin,
        targetAcc: accKey
      };

      await ctx.reply('👉 Enter Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Name...'
        }
      });
      return;
    }

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone: phoneToLogin,
        name: autoName
      };

      await ctx.reply(
        `<b>OTP Sent</b>\n<code>${phoneToLogin}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phoneToLogin } }
              ],
              [
                { text: '🔄 Re-enter OTP', callback_data: `prompt_reenter_otp_${phoneToLogin}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${phoneToLogin}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phoneToLogin, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
  }

  // B: Login with Number - Phone Input
  if (state && (state.action === 'waiting_phone_for_number_login' || state.action === 'waiting_phone_for_new_acc_order')) {
    const cleanPhone = rawText.replace(/[^0-9]/g, '').slice(-10);
    if (cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
      await ctx.reply(
        'Enter valid 10-digit Indian mobile number:',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home' },
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Enter 10-digit Mobile Number:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 10-digit mobile number...'
        }
      });
      return;
    }

    const db = getDb();
    const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => a.phone === cleanPhone);
    const existingKey = existing ? existing[0] : null;
    const existingName = existing ? (existing[1]?.name || existing[0]) : null;

    await triggerPhoneNumberLogin(cleanPhone, existingKey, existingName);
    return;
  }

  // C: Handle Name for New Swiggy User Signup (auto-handled)
  if (state && state.action === 'waiting_name_for_new_swiggy_signup') {
    const enteredName = rawText.trim() || getNextAutoUserName();
    const cleanPhone = state.phone;
    const orderId = state.orderId;
    delete userWaitState[userId];

    const signupRes = await signupSwiggyViaBridge(userId, enteredName);
    if (signupRes.success) {
      await sendAccountLoginAndOffersCard(ctx, signupRes, userId, orderId);
    } else {
      await ctx.reply(`<blockquote>${escapeHtml(signupRes.message)}</blockquote>`, getBossPanelKeyboard());
    }
    return;
  }

  // Handle Name for New Swiggy Number Signup
  if (state && state.action === 'waiting_name_for_new_number_signup') {
    const enteredName = rawText.trim();
    if (!enteredName || enteredName.length < 2 || /^\d+$/.test(enteredName)) {
      await ctx.reply('👉 Enter Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Name...'
        }
      });
      return;
    }
    const phone = state.phone;
    delete userWaitState[userId];
    await triggerPhoneNumberLogin(phone, `acc_${phone}`, enteredName);
    return;
  }

  // D: Fast 10-Digit Mobile Number Detection (typed directly anywhere by Boss)
  const cleanPhoneInput = rawText.replace(/[^0-9]/g, '').slice(-10);
  if (isBoss(userId) && (!state || !state.action) && cleanPhoneInput.length === 10 && /^[6-9]\d{9}$/.test(cleanPhoneInput)) {
    const lower = rawText.toLowerCase();
    if (lower.includes('del') || lower.includes('hata') || lower.includes('rem') || lower.includes('khatam') || lower.includes('deact')) {
      return ctx.reply(
        'ℹ️ Swiggy account delete karne ke liye <b>👥 View Accounts → 🗑️ Delete Account</b> par jayein.',
        { parse_mode: 'HTML' }
      );
    }

    const db = getDb();
    const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => a.phone === cleanPhoneInput);
    const existingKey = existing ? existing[0] : null;
    const existingName = existing ? (existing[1]?.name || existing[0]) : null;

    await triggerPhoneNumberLogin(cleanPhoneInput, existingKey, existingName);
    return;
  }

  // Step 1: User entered 10-digit number for Swiggy after legacy prompt
  if (state && state.action === 'waiting_phone_for_otp') {
    const targetAcc = state.targetAcc;
    const cleanPhone = rawText.replace(/[^0-9]/g, '').slice(-10);

    if (cleanPhone.length !== 10) {
      await ctx.reply('Enter valid 10-digit phone number:');
      await ctx.reply('👉 Enter 10-digit Mobile Number:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 10-digit mobile number...'
        }
      });
      return;
    }

    const autoName = getNextAutoUserName();
    const result = await requestSwiggyOtpViaBridge(userId, cleanPhone, targetAcc, autoName);

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc,
        phone: cleanPhone,
        name: autoName
      };

      await ctx.reply(
        `<b>OTP Sent</b>\n<code>${cleanPhone}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: cleanPhone } }
              ],
              [
                { text: '🔄 Re-enter OTP', callback_data: `prompt_reenter_otp_${cleanPhone}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${cleanPhone}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      delete userWaitState[userId];
      const errCard = formatOtpSendErrorCard(cleanPhone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
    return;
  }

  // Step 2: User enters 6-digit OTP
  if (state && state.action === 'waiting_swiggy_otp_bridge') {
    const rawCleanDigits = rawText.replace(/[^0-9]/g, '');

    // Direct auto-switch if user pasted/typed a 10-digit phone number while waiting for OTP!
    if (rawCleanDigits.length === 10 && /^[6-9]\d{9}$/.test(rawCleanDigits)) {
      delete userWaitState[userId];
      const db = getDb();
      const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => a.phone === rawCleanDigits);
      const existingKey = existing ? existing[0] : null;
      const existingName = existing ? (existing[1]?.name || existing[0]) : null;

      await ctx.reply(`Switching to new number ${rawCleanDigits}...`);
      await triggerPhoneNumberLogin(rawCleanDigits, existingKey, existingName);
      return;
    }

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'nahi aaya', 'doosra', 'close', 'another', 'change'].includes(rawLower)) {
      return promptBossLoginWithNumber(ctx);
    }

    const enteredOtp = rawCleanDigits;

    if (enteredOtp.length < 4) {
      await ctx.reply(
        `⚠️ <b>6-digit Swiggy OTP enter karein</b>\n📱 <code>${state.phone}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: state.phone } }
              ],
              [
                { text: '🔄 Re-enter OTP', callback_data: `prompt_reenter_otp_${state.phone}` },
                { text: '📨 Resend OTP', callback_data: `resend_otp_${state.phone}` }
              ],
              [
                { text: '📱 Another Number', callback_data: 'send_to_another_number' },
                { text: '🏠 Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: '❌ Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Enter 6-digit OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
      return;
    }

    const result = await verifySwiggyOtpViaBridge(userId, enteredOtp);

    if (result.isNewUser) {
      // Auto-assign sequential name without prompting user
      const autoName = state.name || getNextAutoUserName();
      const signupRes = await signupSwiggyViaBridge(userId, autoName);
      if (signupRes.success) {
        const orderId = state.orderId;
        delete userWaitState[userId];
        await sendAccountLoginAndOffersCard(ctx, signupRes, userId, orderId);
      } else {
        await ctx.reply(`<blockquote>${escapeHtml(signupRes.message)}</blockquote>`, getBossPanelKeyboard());
      }
      return;
    }

    if (result.success) {
      const orderId = state.orderId;
      delete userWaitState[userId];
      await sendAccountLoginAndOffersCard(ctx, result, userId, orderId);
    } else {
      const swiggyText = result.swiggyStatus || result.message || 'Galat ya expired OTP';
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: state.targetAcc,
        phone: state.phone,
        name: state.name,
        orderId: state.orderId
      };
      await ctx.reply(
        `❌ <b>Galat OTP / Verification Failed!</b>\n` +
        `📱 <b>Number:</b> <code>${state.phone}</code>\n\n` +
        `⚠️ <b>Swiggy Response:</b>\n` +
        `<blockquote>${escapeHtml(swiggyText)}</blockquote>\n` +
        `👉 <i>Sahi 6-digit OTP dubara type karein ya neeche <b>Re-enter OTP</b> dabayein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Re-enter OTP', callback_data: `prompt_reenter_otp_${state.phone}` },
                { text: '📨 Resend New OTP', callback_data: `resend_otp_${state.phone}` }
              ],
              [
                { text: '📱 Another Number', callback_data: 'send_to_another_number' },
                { text: '📋 Session JSON', callback_data: 'boss_login_with_json' }
              ],
              [
                { text: '🏠 Main Menu', callback_data: 'boss_panel_home' },
                { text: '❌ Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('👉 Re-enter 6-digit OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    }
    return;
  }



  // Boss sending text to user
  if (state && state.action === 'waiting_text_user') {
    const targetUserId = state.targetUserId;
    const orderId = state.orderId;
    delete userWaitState[userId];

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `💬 <b>Beta ka sandesh (Order #${orderId}):</b>\n\n${escapeHtml(rawText)}`,
        { parse_mode: 'HTML' }
      );
      await ctx.reply(`✅ <b>Message delivered to user!</b>`);
    } catch (err) {
      await ctx.reply(`❌ Failed to send message: ${err.message}`);
    }
    return;
  }

  // Boss sending official Swiggy payment link to user
  if (state && (state.action === 'waiting_swiggy_link' || state.action === 'waiting_payment_link')) {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) {
      await ctx.reply('❌ Order could not be found.');
      return;
    }

    let link = rawText.trim();
    const urlMatch = link.match(/(https?:\/\/[^\s]+)/i);
    const amtMatch = link.match(/(?:₹|rs\.?|inr)?\s*([0-9]{2,5})\b/i);

    if (urlMatch) {
      link = urlMatch[1];
      if (amtMatch && !link.includes(amtMatch[1])) {
        order.finalPayable = parseInt(amtMatch[1], 10);
      }
    }

    order.swiggyPaymentUrl = link;
    order.paymentStatus = 'PAYMENT_LINK_SENT';
    saveDb(db);
    await updateOrderCards(order);

    const targetUserId = order.userChatId || order.userId;
    if (targetUserId) {
      try {
        const amtText = order.finalPayable ? `\n💰 <b>Payable on Swiggy:</b> ₹${order.finalPayable}` : '';
        await bot.telegram.sendMessage(
          targetUserId,
          `💳 <b>Official Swiggy Payment Link Ready! (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}${amtText}\n\n` +
          `🔗 <b>Click to Pay Directly on Swiggy:</b>\n<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>\n\n` +
          `<i>✨ Yeh authentic link Swiggy payment page se generated hai. Payment complete karke neeche [ 💸 I Have Paid ] dabayein!</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('💳 Pay on Swiggy (Official Link)', link)],
              [Markup.button.callback('💸 I Have Paid / Confirm Payment', `user_confirm_order_${orderId}`)],
              [Markup.button.url('💬 Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
            ])
          }
        );
        await ctx.reply(`✅ <b>Official Swiggy Payment Link delivered to Customer!</b>\n\nLink: <code>${escapeHtml(link)}</code>`, { parse_mode: 'HTML' });
      } catch (err) {
        await ctx.reply(`❌ Failed to send link to user: ${err.message}`);
      }
    }
    return;
  }

  // Boss setting custom amount
  if (state && state.action === 'waiting_set_amount') {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const num = parseInt(rawText.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(num) && num > 0) {
      const db = getDb();
      const order = db.orders[orderId];
      if (order) {
        order.finalPayable = num;
        order.amountAccepted = false; // User must accept the newly set amount!
        saveDb(db);
        await updateOrderCards(order);
        await ctx.reply(`✅ <b>Payable amount updated to ₹${num}! User ke card par [ Accept Order ] update ho gaya hai.</b>`, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(`⚠️ Invalid amount. Please enter a valid number.`);
    }
    return;
  }

  // Boss setting custom coupon code
  if (state && state.action === 'waiting_set_coupon') {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const code = rawText.trim().toUpperCase();
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) {
      await ctx.reply('❌ Order not found.');
      return;
    }

    const selAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;

    if (code === 'REMOVE' || code === 'NONE' || code === 'CLEAR' || code === '0') {
      const liveRemoved = selAcc?.cookies ? await applyLiveCouponToOrder(selAcc, order, 'REMOVE').catch(() => null) : null;
      order.couponCode = null;
      order.discountAmount = 0;
      if (liveRemoved && liveRemoved.items?.length > 0) {
        order.finalPayable = liveRemoved.finalPayable;
        order.totalSavings = liveRemoved.totalSavings;
        order.swiggyVerified = true;
      } else {
        order.swiggyVerified = false;
        applyMaxOfferToOrder(order);
      }
      saveDb(db);
      await updateOrderCards(order);
      await ctx.reply(`✅ <b>Coupon removed from Order #${orderId}!</b>\nNew Payable: ₹${order.finalPayable}`, { parse_mode: 'HTML' });
      return;
    }

    const liveApplied = selAcc?.cookies ? await applyLiveCouponToOrder(selAcc, order, code).catch(() => null) : null;
    if (liveApplied && liveApplied.items?.length > 0) {
      order.couponCode = liveApplied.couponCode || code;
      order.discountAmount = liveApplied.discountAmount || 0;
      order.deliveryFee = liveApplied.deliveryFee || 0;
      order.packingCharges = liveApplied.packingCharges || 0;
      order.taxesAndCharges = liveApplied.taxesAndCharges || 0;
      order.finalPayable = liveApplied.finalPayable;
      order.totalSavings = liveApplied.totalSavings;
      order.swiggyVerified = true;
    } else {
      let appliedDiscount = 0;
      if (code.includes('70')) {
        appliedDiscount = Math.min(100, Math.round((order.subtotal || 200) * 0.7));
      } else if (code.includes('100')) {
        appliedDiscount = 100;
      } else if (code.includes('125')) {
        appliedDiscount = 125;
      } else if (code.includes('150')) {
        appliedDiscount = 150;
      } else if (code.includes('175')) {
        appliedDiscount = 175;
      } else {
        appliedDiscount = 50;
      }

      order.couponCode = code;
      order.discountAmount = appliedDiscount;
      order.swiggyVerified = false;
      applyMaxOfferToOrder(order);
    }

    saveDb(db);
    await updateOrderCards(order);
    await ctx.reply(
      `🎉 <b>Coupon "${escapeHtml(order.couponCode || code)}" Applied Successfully to Order #${orderId}!</b>\n\n` +
      `💰 <b>Discount:</b> −₹${order.discountAmount || 0}\n` +
      `💳 <b>New Payable Amount:</b> <b>₹${order.finalPayable}</b>\n\n` +
      `<i>User aur Boss dono ke card par naya amount update ho gaya hai!</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Boss setting custom UPI ID
  if (state && state.action === 'waiting_set_upi') {
    delete userWaitState[userId];
    const upi = rawText.trim();
    if (upi.includes('@')) {
      const db = getDb();
      db.config.bossUpiId = upi;
      saveDb(db);
      await ctx.reply(`✅ <b>Payment UPI ID saved:</b> <code>${upi}</code>\nAb se sabhi payment QR is UPI ID par generate honge!`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`⚠️ Invalid UPI ID format. Should contain '@' (e.g. yourname@paytm).`);
    }
    return;
  }

  // Boss sending tracking link to parent
  if (state && state.action === 'waiting_tracking') {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('❌ Order not found.');

    order.trackingLink = rawText;
    saveDb(db);
    await updateOrderCards(order);

    try {
      await bot.telegram.sendMessage(
        order.userId,
        `🛵 <b>Ammi/Abbu, beta ne Swiggy se order bhej diya hai!</b>\n\n` +
        `Delivery boy nikal chuka hai. Aap niche diye gaye link se live dekh sakti hain:\n\n` +
        `📍 <b>Live Tracking Link / Details:</b>\n${rawText}`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🛵 Open Swiggy Live Tracking', rawText)]
          ])
        }
      );
      await ctx.reply(`✅ <b>Live tracking sent to ${escapeHtml(order.userName)}!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Failed to send tracking: ${err.message}`);
    }
    return;
  }

  // Boss: Set Total Slots
  if (state && state.action === 'waiting_boss_total') {
    delete userWaitState[userId];
    const num = parseInt(rawText.trim(), 10);
    if (!isNaN(num) && num >= 0) {
      mutateDb((d) => {
        d.config.totalSlots = num;
        d.config.slotsLeft = Math.min(d.config.slotsLeft, num);
      });
      const db = getDb();
      await ctx.reply(`✅ <b>Total slots updated to ${num}!</b> (Slots Left: ${db.config.slotsLeft}/${num})`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
    } else {
      await ctx.reply('⚠️ Please enter a valid non-negative integer for Total slots.');
    }
    return;
  }

  // Boss: Set Total Left (Slots Left)
  if (state && state.action === 'waiting_boss_left') {
    delete userWaitState[userId];
    const num = parseInt(rawText.trim(), 10);
    if (!isNaN(num) && num >= 0) {
      mutateDb((d) => {
        d.config.slotsLeft = Math.min(d.config.totalSlots, Math.max(0, num));
      });
      const db = getDb();
      await ctx.reply(`✅ <b>Total left updated to ${db.config.slotsLeft}!</b> (${db.config.slotsLeft}/${db.config.totalSlots})`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
    } else {
      await ctx.reply('⚠️ Please enter a valid non-negative integer for Total left.');
    }
    return;
  }

  // Handle waiting_cart state
  if (state && state.action === 'waiting_cart') {
    const allLinks = extractAllLinks(rawText);
    const validCart = allLinks.find(l => isValidSwiggyCartUrl(l));
    const parsedCart = parseCartDetails(rawText);

    if (!validCart && !parsedCart) {
      await ctx.reply(
        `❌ <b>Fake / Invalid Swiggy Cart Link!</b>\n\n` +
        `Bot sirf genuine Swiggy cart / group cart links accept karta hai.\n` +
        `<i>Example: <code>https://swig.gy/gc/...</code> ya <code>https://www.swiggy.com/restaurants/...</code></i>\n\n` +
        `👉 Niche button dabakar genuine link paste karein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🟣 Paste Cart Link', 'action_paste_cart')]
          ])
        }
      );
      return;
    }

    delete userWaitState[userId];
    const cartVal = validCart || 'https://www.swiggy.com/cart';
    const draftUpdates = { cart: cartVal };
    if (parsedCart) draftUpdates.cartDetails = parsedCart;

    // Fast-resolve link metadata (live group cart items, restaurant & real prices)
    try {
      const linkMeta = await resolveSwiggyLink(cartVal);
      if (linkMeta?.cartDetails) {
        draftUpdates.cartDetails = {
          ...(draftUpdates.cartDetails || {}),
          ...(linkMeta.cartDetails || {})
        };
      }
      if (linkMeta?.restaurantName && !draftUpdates.cartDetails?.restaurantName) {
        draftUpdates.cartDetails = draftUpdates.cartDetails || {};
        draftUpdates.cartDetails.restaurantName = linkMeta.restaurantName;
      }
      if (linkMeta?.restaurantId) draftUpdates.restaurantId = linkMeta.restaurantId;
      if (linkMeta?.groupCartId) draftUpdates.groupCartId = linkMeta.groupCartId;
      if (linkMeta?.hostName) draftUpdates.hostName = linkMeta.hostName;
    } catch (e) {}

    // Check if user also sent address details in the same text
    const parsedAddr = parseAddressDetails(rawText);
    const curBefore = getDraft(userId);
    if (parsedAddr && !curBefore.address) {
      const geoAddr = await geocodeAddressDetails(parsedAddr).catch(() => parsedAddr);
      draftUpdates.address = geoAddr.address || `${geoAddr.city || 'Delivery'} Address`;
      draftUpdates.addressOriginalText = rawText;
      draftUpdates.addressDetails = geoAddr;
    }

    updateDraft(userId, draftUpdates);
    const curDraft = getDraft(userId);

    if (curDraft.address) {
      await ctx.reply(
        `✅ <b>Cart Link verified & saved!</b>\n\n🎉 <i>Dono links ready hain! Niche <b>[ 🚀 Send to Beta ]</b> dabayein:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🟣 Cart: Added ✅', 'action_paste_cart'),
              Markup.button.callback('🔵 Address: Added ✅', 'action_paste_address')
            ],
            [Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')]
          ]),
          ...getUserReplyKeyboard(curDraft)
        }
      );
    } else {
      userWaitState[userId] = { action: 'waiting_address' };
      await ctx.reply(
        `✅ <b>Cart Link verified & saved!</b>\n\n👉 Ab niche button dabakar <b>Delivery Address</b> paste karein (ya Telegram 📎 <b>Location</b> bhej dein):`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔵 Paste Address Link', 'action_paste_address')]
          ])
        }
      );
    }

    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // Handle waiting_address state
  if (state && state.action === 'waiting_address') {
    const allLinks = extractAllLinks(rawText);
    const validAddress = allLinks.find(l => isValidDeliveryAddressUrl(l));
    let parsedAddr = parseAddressDetails(rawText);

    if (!validAddress && !parsedAddr) {
      await ctx.reply(
        `❌ <b>Fake / Invalid Delivery Address Link!</b>\n\n` +
        `Bot Swiggy Share Address message (<code>Address: ...</code> ke saath), Google Maps link, plain address, ya Telegram 📎 <b>Location Pin</b> accept karta hai.\n` +
        `<i>Example: <code>https://swiggy.onelink.me/JgkQ/52yat6op</code></i>\n\n` +
        `👉 Niche button dabakar genuine address paste karein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔵 Paste Address Link', 'action_paste_address')]
          ])
        }
      );
      return;
    }

    delete userWaitState[userId];

    // Resolve full address details immediately (preserves full Swiggy Share text + geocodes coordinates!)
    let resolvedAddrDetails = parsedAddr;
    try {
      const addrMeta = await resolveSwiggyLink(rawText);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        resolvedAddrDetails = { ...(resolvedAddrDetails || {}), ...addrMeta.addressDetails };
      } else if (resolvedAddrDetails) {
        resolvedAddrDetails = await geocodeAddressDetails(resolvedAddrDetails);
      }
    } catch (e) {}

    const cleanDisplayAddr = resolvedAddrDetails?.address || validAddress || rawText.trim();
    const draftUpdates = {
      address: cleanDisplayAddr,
      addressOriginalText: rawText,
      ...(validAddress ? { addressLink: validAddress } : {})
    };
    if (resolvedAddrDetails) draftUpdates.addressDetails = resolvedAddrDetails;

    // Check if user also sent cart details in the same text
    const parsedCart = parseCartDetails(rawText);
    const curBefore = getDraft(userId);
    if (parsedCart && !curBefore.cart) {
      draftUpdates.cart = 'https://www.swiggy.com/cart';
      draftUpdates.cartDetails = parsedCart;
    }

    updateDraft(userId, draftUpdates);
    const curDraft = getDraft(userId);

    const bareOneLinkNotice = (validAddress && /onelink\.me\/JgkQ/i.test(validAddress) && !resolvedAddrDetails?.address)
      ? `\n\n💡 <i>Tip: Agar Swiggy link ke neeche wali <code>Address: ...</code> line delete ho gayi thi, toh aap poora Swiggy message, Google Maps link, ya Telegram 📎 Location Pin bhi bhej sakte hain taaki exact street address auto-fill ho jaye!</i>`
      : '';

    if (curDraft.cart) {
      await ctx.reply(
        `✅ <b>Address Link verified & saved!</b>${bareOneLinkNotice}\n\n🎉 <i>Dono links ready hain! Niche <b>[ 🚀 Send to Beta ]</b> dabayein:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🟣 Cart: Added ✅', 'action_paste_cart'),
              Markup.button.callback('🔵 Address: Added ✅', 'action_paste_address')
            ],
            [Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')]
          ]),
          ...getUserReplyKeyboard(curDraft)
        }
      );
    } else {
      userWaitState[userId] = { action: 'waiting_cart' };
      await ctx.reply(
        `✅ <b>Address Link verified & saved!</b>${bareOneLinkNotice}\n\n👉 Ab niche button dabakar <b>Swiggy Cart link</b> paste karein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🟣 Paste Cart Link', 'action_paste_cart')]
          ])
        }
      );
    }

    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // General Ingestion (Links OR Structured Receipt/Address text pasted directly)
  const allLinks = extractAllLinks(rawText);
  const parsedCartDirect = parseCartDetails(rawText);
  const parsedAddrDirect = parseAddressDetails(rawText);

  if (allLinks.length > 0 || parsedCartDirect || parsedAddrDirect) {
    let addedCart = false;
    let addedAddress = false;
    let hadFake = false;

    const validCartLink = allLinks.find(l => isValidSwiggyCartUrl(l));
    const validAddrLink = allLinks.find(l => isValidDeliveryAddressUrl(l));

    if (validCartLink || parsedCartDirect) {
      let cartMeta = null;
      if (validCartLink) {
        try { cartMeta = await resolveSwiggyLink(validCartLink); } catch (e) {}
      }
      updateDraft(userId, {
        cart: validCartLink || 'https://www.swiggy.com/cart',
        ...(cartMeta?.restaurantId ? { restaurantId: cartMeta.restaurantId } : {}),
        ...(cartMeta?.groupCartId ? { groupCartId: cartMeta.groupCartId } : {}),
        ...(cartMeta?.hostName ? { hostName: cartMeta.hostName } : {}),
        cartDetails: {
          ...(parsedCartDirect || {}),
          ...(cartMeta?.cartDetails || {})
        }
      });
      addedCart = true;
    }

    if (parsedAddrDirect || validAddrLink) {
      let geoAddr = parsedAddrDirect;
      try {
        const addrMeta = await resolveSwiggyLink(rawText);
        if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
          geoAddr = { ...(geoAddr || {}), ...addrMeta.addressDetails };
        } else if (geoAddr) {
          geoAddr = await geocodeAddressDetails(geoAddr);
        }
      } catch (e) {}

      // NEVER overwrite clean street address with bare JgkQ URL!
      updateDraft(userId, {
        address: geoAddr?.address || validAddrLink || `${geoAddr?.city || 'Delivery'} Address`,
        addressOriginalText: rawText,
        ...(validAddrLink ? { addressLink: validAddrLink } : {}),
        ...(geoAddr ? { addressDetails: geoAddr } : {})
      });
      addedAddress = true;
    }

    for (const l of allLinks) {
      if (!isValidSwiggyCartUrl(l) && !isValidDeliveryAddressUrl(l) && !parsedCartDirect && !parsedAddrDirect) {
        hadFake = true;
      }
    }

    delete userWaitState[userId];
    const curDraft = getDraft(userId);

    if (hadFake && !addedCart && !addedAddress) {
      await ctx.reply(
        `❌ <b>Fake ya invalid Link!</b>\n\n` +
        `Bot me sirf genuine links accept hote hain:\n` +
        `🟣 <b>Cart:</b> <code>https://swig.gy/gc/...</code>\n` +
        `🔵 <b>Address:</b> <code>https://swiggy.onelink.me/JgkQ/52yat6op</code>\n\n` +
        `👉 Niche diye gaye buttons se link add karein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🟣 Paste Cart Link', 'action_paste_cart'),
              Markup.button.callback('🔵 Paste Address Link', 'action_paste_address')
            ]
          ])
        }
      );
      return;
    }

    if (curDraft.cart && curDraft.address) {
      await ctx.reply(
        `🎉 <b>Cart aur Address dono ready hain!</b>\n\n👉 Niche <b>[ 🚀 Send to Beta ]</b> dabayein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🟣 Cart: Added ✅', 'action_paste_cart'),
              Markup.button.callback('🔵 Address: Added ✅', 'action_paste_address')
            ],
            [Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')]
          ]),
          ...getUserReplyKeyboard(curDraft)
        }
      );
    } else if (addedCart && !curDraft.address) {
      userWaitState[userId] = { action: 'waiting_address' };
      await ctx.reply(
        `✅ <b>Cart Link add ho gaya!</b>\n\n👉 Ab niche button dabakar <b>Delivery Address link</b> paste karein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔵 Paste Address Link', 'action_paste_address')]
          ])
        }
      );
    } else if (addedAddress && !curDraft.cart) {
      userWaitState[userId] = { action: 'waiting_cart' };
      await ctx.reply(
        `✅ <b>Address Link add ho gaya!</b>\n\n👉 Ab niche button dabakar <b>Swiggy Cart link</b> paste karein:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🟣 Paste Cart Link', 'action_paste_cart')]
          ])
        }
      );
    }

    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // Plain text fallback for normal users
  if (!isBoss(userId)) {
    const curDraft = getDraft(userId);
    await ctx.reply(
      `👋 <b>Swiggy Food Order</b>\n\n` +
      `Kripya buttons se link paste karein:\n\n` +
      `🟣 <b>Cart Link:</b> Genuine Swiggy link (<code>https://swig.gy/gc/...</code>)\n` +
      `🔵 <b>Address Link:</b> Swiggy Address link (<code>https://swiggy.onelink.me/JgkQ/...</code>)\n\n` +
      `Niche buttons par click karein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(curDraft.cart ? '🟣 Cart: Added ✅' : '🟣 Paste Cart Link', 'action_paste_cart'),
            Markup.button.callback(curDraft.address ? '🔵 Address: Added ✅' : '🔵 Paste Address Link', 'action_paste_address')
          ],
          [
            Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')
          ]
        ]),
        ...getUserReplyKeyboard(curDraft)
      }
    );
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // Fallback for Boss
  if (isBoss(userId)) {
    await ctx.reply(`👋 Boss, use the menu buttons below:`, getBossReplyKeyboard());
  }
});

// Telegram Location Pin & Live Location Handler (Instant Swiggy Reverse Geocoding!)
async function handleIncomingTelegramLocation(ctx, loc) {
  if (!loc || loc.latitude === undefined || loc.longitude === undefined) return;
  const userId = ctx.from.id;
  const lat = String(loc.latitude);
  const lng = String(loc.longitude);

  const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
  const resolvedAddr = {
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
    mobile: '',
    city: rev?.city || 'Delivery',
    area: rev?.area || '',
    landmark: rev?.landmark || '',
    address: rev?.address || `Pinned Location (${lat}, ${lng})`,
    lat,
    lng
  };

  delete userWaitState[userId];
  updateDraft(userId, {
    address: resolvedAddr.address,
    addressOriginalText: `${resolvedAddr.address}\nLatitude: ${lat}\nLongitude: ${lng}`,
    addressLink: `https://maps.google.com/?q=${lat},${lng}`,
    addressDetails: resolvedAddr
  });

  const curDraft = getDraft(userId);
  if (curDraft.cart) {
    await ctx.reply(
      `📍 <b>Live Location verified & saved!</b>\n` +
      `🏠 <code>${escapeHtml(resolvedAddr.address)}</code>\n\n` +
      `🎉 <i>Cart aur Address dono ready hain! Niche <b>[ 🚀 Send to Beta ]</b> dabayein:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🟣 Cart: Added ✅', 'action_paste_cart'),
            Markup.button.callback('🔵 Address: Added ✅', 'action_paste_address')
          ],
          [Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')]
        ]),
        ...getUserReplyKeyboard(curDraft)
      }
    );
  } else {
    userWaitState[userId] = { action: 'waiting_cart' };
    await ctx.reply(
      `📍 <b>Live Location verified & saved!</b>\n` +
      `🏠 <code>${escapeHtml(resolvedAddr.address)}</code>\n\n` +
      `👉 Ab niche button dabakar <b>Swiggy Cart link</b> paste karein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟣 Paste Cart Link', 'action_paste_cart')]
        ])
      }
    );
  }

  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
}

bot.on('location', async (ctx) => {
  await handleIncomingTelegramLocation(ctx, ctx.message?.location);
});

bot.on('edited_message', async (ctx) => {
  if (ctx.editedMessage?.location) {
    const userId = ctx.editedMessage.from?.id;
    if (!userId) return;
    const lat = String(ctx.editedMessage.location.latitude);
    const lng = String(ctx.editedMessage.location.longitude);
    const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
    if (rev) {
      updateDraft(userId, {
        address: rev.address,
        addressDetails: {
          name: [ctx.editedMessage.from.first_name, ctx.editedMessage.from.last_name].filter(Boolean).join(' ') || 'Customer',
          mobile: '',
          city: rev.city || 'Delivery',
          area: rev.area || '',
          landmark: rev.landmark || '',
          address: rev.address,
          lat,
          lng
        }
      });
    }
  }
});

// Setup Boss UPI Command (/setupi <vpa>)
bot.command(['setupi', 'set_upi'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length > 1 && parts[1].includes('@')) {
    const upi = parts[1].trim();
    const db = getDb();
    db.config.bossUpiId = upi;
    saveDb(db);
    return ctx.reply(`✅ <b>Payment UPI ID saved:</b> <code>${upi}</code>\nAb se sabhi payment QR is UPI ID par generate honge!`, { parse_mode: 'HTML' });
  }
  userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
  const currentUpi = getDb().config?.bossUpiId || '6296591407@ybl';
  await ctx.reply(
    `💳 <b>Set Boss Payment UPI ID:</b>\n\n` +
    `Current UPI ID: <code>${escapeHtml(currentUpi)}</code>\n\n` +
    `Apna UPI ID reply karein (e.g. <code>6296591407@ybl</code> ya <code>name@okaxis</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' }
    }
  );
});

// ================= USER FLOWCHART & BOTTOM BUTTON HANDLERS =================

// Cart Link Flow (asks confirmation before replacing an already-saved Cart Link, otherwise asks to paste the link)
async function handleCartLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (draft.cart) {
    return ctx.reply(
      `⚠️ <b>Are you sure you want to change your saved Cart Link?</b>\n\n` +
      `Current: <code>${escapeHtml(draft.cart)}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, change cart link', 'action_confirm_change_cart'),
            Markup.button.callback('🔙 Keep Link', 'action_cancel_change_link')
          ]
        ])
      }
    );
  }
  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `🟣 <b>Send Swiggy Cart Link (ask to paste the link):</b>\n\n` +
    `Kripya apna genuine Swiggy cart / group cart link chat me paste karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste cart link...' }
    }
  );
}

// Address Link Flow (asks confirmation before replacing an already-saved Address Link)
async function handleAddressLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (draft.address) {
    return ctx.reply(
      `⚠️ <b>Are you sure you want to change your saved Address Link?</b>\n\n` +
      `Current: <code>${escapeHtml(draft.address)}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, change address link', 'action_confirm_change_address'),
            Markup.button.callback('🔙 Keep Link', 'action_cancel_change_link')
          ]
        ])
      }
    );
  }
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    `🔵 <b>Send Delivery Address Link:</b>\n\n` +
    `Swiggy app se share kiya hua poora address message, Google Maps link, ya Telegram 📎 Location Pin chat me bhejein:\n` +
    `<i>Example: <code>https://swiggy.onelink.me/JgkQ/52yat6op</code></i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste Swiggy address / Google Maps link or send Location...' }
    }
  );
}

// Cancel Order with "Are you sure" Red Confirmation (FigJam Flowchart)
async function handleCancelOrderConfirm(ctx, orderId = null) {
  const userId = ctx.from.id;
  const db = getDb();
  const activeOrder = orderId ? db.orders[orderId] : getActiveUserOrder(userId);
  const draft = getDraft(userId);

  if (!activeOrder && !draft.cart && !draft.address) {
    return ctx.reply('ℹ️ <b>Aapka koi active order ya saved draft nahi hai jise cancel kiya jaye.</b>', { parse_mode: 'HTML' });
  }

  const targetId = activeOrder ? activeOrder.id : 'draft';
  const text = activeOrder
    ? `⚠️ <b>Kya aap waqai Order #${activeOrder.id} cancel karna chahte hain?</b>\n\n` +
      `🏨 Restaurant: <b>${escapeHtml(activeOrder.restaurantName || 'Swiggy Order')}</b>\n` +
      `💰 Amount: <b>₹${activeOrder.finalPayable || 0}</b>\n\n` +
      `<i>Niche confirmation select karein:</i>`
    : `⚠️ <b>Kya aap waqai draft cancel karna chahte hain?</b>\n\nCart aur Address links clear ho jayenge.`;

  const buttons = [
    [
      Markup.button.callback('Are you sure (Cancel)', `user_confirm_cancel_${targetId}`),
      Markup.button.callback('Keep Order', `user_keep_order_${targetId}`)
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// Previous Order Flow (FigJam: "show order card in short")
async function handlePreviousOrder(ctx) {
  const userId = ctx.from.id;
  const db = getDb();
  const userOrders = Object.values(db.orders || {})
    .filter(o => Number(o.userId) === Number(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (userOrders.length === 0) {
    return ctx.reply('<b>Koi previous order nahi mila!</b>\nAap pehli baar order place karne ke liye cart aur address link attach karein.', {
      parse_mode: 'HTML'
    });
  }

  const prev = userOrders[0];
  let statusBadge = '⏳ ' + prev.status;
  if (prev.status === 'COMPLETED') statusBadge = 'DELIVERED';
  else if (prev.status === 'CANCELLED') statusBadge = 'CANCELLED';
  else if (prev.status === 'REJECTED') statusBadge = 'REJECTED';
  else if (prev.status === 'ACCEPTED') statusBadge = 'IN PROGRESS';

  const dateStr = new Date(prev.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  const shortText = `<b>PREVIOUS ORDER SUMMARY (#${prev.id})</b>\n\n` +
    `🏨 <b>Restaurant:</b> ${escapeHtml(prev.restaurantName || 'Swiggy Order')}\n` +
    `📅 <b>Date:</b> ${dateStr}\n` +
    `📦 <b>Items:</b> ${prev.items && prev.items.length > 0 ? prev.items.map(i => `${escapeHtml(i.name)} (x${i.qty || i.quantity || 1})`).join(', ') : (prev.cart ? 'Swiggy Cart Items' : 'Voice/Photo Order')}\n` +
    `💰 <b>Total Amount:</b> ₹${prev.finalPayable || prev.subtotal || 0}\n` +
    `📌 <b>Status:</b> <b>${statusBadge}</b>\n` +
    (prev.trackingLink ? `\n📍 <b>Tracking:</b> <code>${escapeHtml(prev.trackingLink)}</code>\n` : '');

  const buttons = [];
  if (prev.trackingLink) {
    buttons.push([Markup.button.url('Open Swiggy Live Tracking', prev.trackingLink)]);
  }
  if (prev.cart && prev.cart.startsWith('http')) {
    buttons.push([Markup.button.url('View Swiggy Cart', prev.cart)]);
  }
  buttons.push([Markup.button.callback('Back to Main Screen', 'user_back_to_main')]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(shortText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(shortText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// Send to Admin Flow (User Diagram: when both links present, user can Send to Admin; Admin decides whether to accept and generate QR)
async function handleSendToBoss(ctx) {
  const userId = ctx.from.id;

  // 1. Check if user already has an active order
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return ctx.reply(
      `⚠️ <b>Aapka ek order pehle se chal raha hai (#${activeOrder.id})!</b>\n\n` +
      `Jab tak purana order complete (delivered) ya cancel nahi ho jata, tab tak naya order nahi bhej sakte.\n` +
      `Naya order bhejne ke liye pehle purana order cancel karein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`Cancel Current Order #${activeOrder.id}`, `user_confirm_cancel_${activeOrder.id}`)],
          [Markup.button.callback('Refresh Status', `user_refresh_status_${activeOrder.id}`)]
        ])
      }
    );
  }

  // 2. Both cart and address must be present
  const draft = getDraft(userId);
  if (!draft.cart) {
    return ctx.reply(
      '⚠️ <b>Cart Link missing hai!</b>\n\nKripya pehle apna Swiggy Cart link add karein:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟣 Paste Cart Link', 'action_paste_cart')]
        ])
      }
    );
  }
  if (!draft.address) {
    return ctx.reply(
      '⚠️ <b>Delivery Address missing hai!</b>\n\nKripya pehle apna Delivery Address link add karein:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔵 Paste Address Link', 'action_paste_address')]
        ])
      }
    );
  }

  const db = getDb();
  const orderId = String(Date.now()).slice(-5);
  const role = getFamilyRole(userId, 'Ammi');

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username ? `@${ctx.from.username}` : null,
    type: 'SWIGGY_ORDER',
    address: draft.address,
    addressOriginalText: draft.addressOriginalText || draft.address || '',
    addressLink: draft.addressLink || null,
    cart: draft.cart,
    restaurantId: draft.restaurantId || null,
    groupCartId: draft.groupCartId || null,
    hostName: draft.hostName || null,
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString(),
    userChatId: userId,
    userMessageId: ctx.callbackQuery?.message?.message_id || null,
    bossMessageIds: {}
  };

  if (draft.addressDetails) newOrder.addressDetails = draft.addressDetails;
  if (draft.cartDetails) {
    const cd = draft.cartDetails;
    if (cd.restaurantName) newOrder.restaurantName = cd.restaurantName;
    if (cd.orderAccount) newOrder.orderAccount = cd.orderAccount;
    if (cd.items && cd.items.length > 0) newOrder.items = cd.items;
    if (cd.itemsTotal > 0) { newOrder.itemTotal = cd.itemsTotal; newOrder.subtotal = cd.itemsTotal; }
    if (cd.tradeDiscountTotal > 0) newOrder.tradeDiscountTotal = cd.tradeDiscountTotal;
    if (cd.couponCode) { newOrder.couponCode = cd.couponCode; newOrder.discountAmount = cd.discountAmount; }
    if (cd.freeCashApplied > 0) newOrder.freeCashApplied = cd.freeCashApplied;
    if (cd.freeDelivery) { newOrder.swiggyOneApplied = true; newOrder.freeDeliveryDiscount = cd.deliverySaved || 0; }
    if (cd.packingCharges > 0) newOrder.packingCharges = cd.packingCharges;
    if (cd.gstCharges > 0) newOrder.taxesAndCharges = cd.gstCharges;
    if (cd.totalSavings > 0) newOrder.totalSavings = cd.totalSavings;
    if (cd.finalPayable > 0) newOrder.finalPayable = cd.finalPayable;
    else applyMaxOfferToOrder(newOrder);
  }

  // Fallback: If items are missing, resolve directly from live cart link (<150ms for group carts!)
  if (!newOrder.items || newOrder.items.length === 0) {
    try {
      const linkMeta = await resolveSwiggyLink(newOrder.cart);
      if (linkMeta?.restaurantId) newOrder.restaurantId = linkMeta.restaurantId;
      if (linkMeta?.groupCartId) newOrder.groupCartId = linkMeta.groupCartId;
      if (linkMeta?.hostName) newOrder.hostName = linkMeta.hostName;
      if (linkMeta?.cartDetails?.items?.length > 0) {
        newOrder.items = linkMeta.cartDetails.items;
        if (!newOrder.restaurantName) newOrder.restaurantName = linkMeta.restaurantName;
        if (!newOrder.subtotal) {
          newOrder.subtotal = linkMeta.cartDetails.subtotal || linkMeta.cartDetails.itemsTotal;
          newOrder.itemTotal = newOrder.subtotal;
        }
        if (linkMeta.cartDetails.tradeDiscountTotal > 0) newOrder.tradeDiscountTotal = linkMeta.cartDetails.tradeDiscountTotal;
        if (linkMeta.cartDetails.packingCharges > 0) newOrder.packingCharges = linkMeta.cartDetails.packingCharges;
        if (linkMeta.cartDetails.gstCharges > 0) newOrder.taxesAndCharges = linkMeta.cartDetails.gstCharges;
        applyMaxOfferToOrder(newOrder);
      }
    } catch (e) {}
  }

  // Fallback: If addressDetails is missing, resolve directly from address text/link without clobbering
  if (!newOrder.addressDetails && (newOrder.addressOriginalText || newOrder.address)) {
    try {
      const addrMeta = await resolveSwiggyLink(newOrder.addressOriginalText || newOrder.address);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        newOrder.addressDetails = addrMeta.addressDetails;
        if (addrMeta.addressDetails.address) newOrder.address = addrMeta.addressDetails.address;
      }
    } catch (e) {}
  }

  db.orders[orderId] = newOrder;
  saveDb(db);
  clearDraft(userId);

  // Edit User's single card in-place if initiated via inline button, else send and save message ID
  const userCard = formatUserOrderCard(newOrder);
  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.editMessageText(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
    } catch (e) {
      const msg = await ctx.reply(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
      newOrder.userMessageId = msg.message_id;
    }
  } else {
    const msg = await ctx.reply(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
    newOrder.userMessageId = msg.message_id;
  }

  // Deliver single card to Boss so Admin can DECIDE
  const bossCard = formatBossOrderCard(newOrder);
  const bossList = [...new Set([...(db.config.bossIds || []), ...(isBoss(userId) ? [userId] : [])])];
  for (const bossId of bossList) {
    try {
      const bossMsg = await sendCardSafe(bossId, bossCard);
      newOrder.bossMessageIds[bossId] = bossMsg?.message_id;
      console.log(`✅ Successfully sent Order #${orderId} to Boss: ${bossId}`);
    } catch (e) {
      console.error(`❌ Failed to send Order #${orderId} to Boss ${bossId}:`, e.message);
    }
  }
  saveDb(db);

  // Immediately kick off fast background cart fetch
  triggerBackgroundCartFetch(orderId).catch(err => console.error(`[BackgroundFetch] Order #${orderId} error:`, err.message));
}

// Action Callbacks for User Screen & Flowchart
bot.action('action_add_cart', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCartLinkFlow(ctx);
});

bot.action(['action_paste_cart', 'action_force_change_cart', 'action_change_cart_link', 'action_confirm_change_cart'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `🟣 <b>Swiggy Cart Link paste karein:</b>\n\n` +
    `Kripya apna genuine Swiggy cart / group cart link chat me paste karein:\n` +
    `<i>Example: <code>https://swig.gy/gc/...</code> ya <code>https://www.swiggy.com/restaurants/...</code></i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste Swiggy cart link here...' }
    }
  );
});

bot.action('action_add_address', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleAddressLinkFlow(ctx);
});

bot.action(['action_paste_address', 'action_force_change_address', 'action_change_address_link', 'action_confirm_change_address'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    `🔵 <b>Delivery Address Link paste karein:</b>\n\n` +
    `Swiggy app se share kiya hua delivery address link chat me paste karein:\n` +
    `<i>Example: <code>https://swiggy.onelink.me/JgkQ/52yat6op</code></i>\n` +
    `<i>(Google Maps link bhi chalega)</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste Swiggy address link (https://swiggy.onelink.me/JgkQ/...)' }
    }
  );
});

bot.action('action_cancel_change_link', async (ctx) => {
  await ctx.answerCbQuery('Link preserved 🟢').catch(() => {});
  const userId = ctx.from.id;
  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action('boss_prompt_total_slots', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_total' };
  await ctx.reply(`<b>Total Slots</b>\n\nEnter number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter number...' }
  });
});

bot.action('boss_prompt_slots_left', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_left' };
  await ctx.reply(`<b>Total Left</b>\n\nEnter number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter number...' }
  });
});

bot.action(['action_send_to_admin', 'action_send_to_boss', 'action_send_to_beta', 'action_send_order_to_beta'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleSendToBoss(ctx);
});

bot.action('action_cancel_order_confirm', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCancelOrderConfirm(ctx);
});

bot.action(/^action_cancel_order_confirm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const orderId = ctx.match[1];
  await handleCancelOrderConfirm(ctx, orderId);
});

bot.action(/^user_confirm_cancel_(.+)$/, async (ctx) => {
  const target = ctx.match[1];
  const userId = ctx.from.id;

  if (target === 'draft') {
    clearDraft(userId);
    const screen = getUserScreen(userId, ctx.from);
    await ctx.answerCbQuery('Draft Cancelled 🔴').catch(() => {});
    try {
      await ctx.editMessageText('🔴 <b>Draft cancel ho gaya hai!</b>\n\nAap dobara link attach kar sakte hain:', { parse_mode: 'HTML' });
    } catch (e) {}
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  const db = getDb();
  const order = db.orders[target];
  if (!order) {
    return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});
  }

  // Security check: Must be the order's customer or boss
  if (Number(order.userId) !== Number(userId) && !isBoss(userId)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }

  // State machine transition check
  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  if (order.status === 'ACCEPTED') {
    db.config.slotsLeft = Math.min(db.config.totalSlots, db.config.slotsLeft + 1);
  }

  order.status = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  saveDb(db);
  clearDraft(userId);

  await ctx.answerCbQuery('Order Cancelled 🔴').catch(() => {});

  // 1. Delete message from current chat
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // 2. Delete card messages from user and boss chats
  await deleteOrderMessages(order);

  // 3. Notify bosses with View Cancelled Orders button
  for (const bossId of db.config.bossIds) {
    try {
      const userProfileUrl = `tg://user?id=${order.userId}`;
      await bot.telegram.sendMessage(
        bossId,
        `🔴 <b><a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> ne Order #${order.id} CANCEL kar diya hai!</b>\n` +
        `🆔 <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n\n` +
        `<i>Card chat se delete kar diya gaya hai.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🗑️ View Cancelled Orders', 'boss_view_cancelled_orders')]
          ])
        }
      );
    } catch (e) {}
  }

  await ctx.reply('🗑️ <b>Order cancel ho gaya aur message delete kar diya gaya hai!</b>\n\nAap naya order bhej sakte hain.', { parse_mode: 'HTML' });
  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(/^user_keep_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Order active hai 🟢').catch(() => {});
  const userId = ctx.from.id;
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.action('action_previous_order', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handlePreviousOrder(ctx);
});

bot.action('user_back_to_main', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  if (isBoss(userId)) {
    await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  } else {
    const screen = getUserScreen(userId, ctx.from);
    try {
      await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    } catch (e) {
      await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    }
  }
});

bot.action(/^user_refresh_status_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});
  await ctx.answerCbQuery('Status Refreshed 🔄').catch(() => {});
  const card = formatUserOrderCard(order);
  try {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
  } catch (e) {}
});

bot.action('user_reset', async (ctx) => {
  await ctx.answerCbQuery('Form cleared').catch(() => {});
  clearDraft(ctx.from.id);
  const screen = getUserScreen(ctx.from.id, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

// ================= SWIGGY WORLD BOT FEATURES =================

// 1. Saved Addresses
async function handleSavedAddresses(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    return ctx.answerCbQuery ? ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {}) : ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(
      `⚠️ <b>${acc?.name || activeKey} is not logged in!</b>\n\nPehle [ 👥 My Swiggy Accounts ] me jakar account login karein.`,
      { parse_mode: 'HTML' }
    );
  }

  const waitMsg = await ctx.reply(`🔍 <i>Fetching saved addresses from ${escapeHtml(acc.name || activeKey)}'s Swiggy account...</i>`, { parse_mode: 'HTML' });
  const addresses = await fetchAccountAddresses(acc);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!addresses || addresses.length === 0) {
    return ctx.reply(`📍 <b>No saved addresses found in ${acc.name || activeKey}'s account.</b>`, { parse_mode: 'HTML' });
  }

  let text = `<b>Saved Addresses</b>\n\n`;
  for (const addr of addresses) {
    text += `<b>${escapeHtml(addr.city)} Address</b>\n` +
      `${escapeHtml(addr.name)} <code>${escapeHtml(addr.mobile)}</code>\n` +
      `${escapeHtml(addr.address)}\n` +
      `Latitude: ${addr.lat}\n` +
      `Longitude: ${addr.lng}\n\n`;
  }

  const buttons = [
    [Markup.button.callback('🔄 Refresh Addresses', `acc_view_addrs_${activeKey}`)],
    [Markup.button.callback('👥 Switch Account', 'acc_refresh_list')]
  ];

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.hears('📍 Saved Addresses', async (ctx) => handleSavedAddresses(ctx));
bot.command('addresses', async (ctx) => handleSavedAddresses(ctx));
bot.action('action_refresh_addresses', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleSavedAddresses(ctx);
});
bot.action(/^acc_view_addrs_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleSavedAddresses(ctx, key);
});

// 2. My Swiggy Accounts Menu
async function handleMyAccounts(ctx) {
  if (!isBoss(ctx.from.id)) {
    return ctx.answerCbQuery ? ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {}) : ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const activeKey = getActiveOrderAccountKey();

  let text = `<b>My Swiggy Accounts</b>\n\nSelect an account:\n`;
  const buttons = [];

  for (const [key, acc] of Object.entries(accounts)) {
    const isActive = key === activeKey;
    const statusText = isActive ? 'Active' : (acc.isLoggedIn ? 'Saved' : 'Not Logged In');
    text += `${acc.name || key} <code>${acc.phone || ''}</code> ${statusText}\n`;

    buttons.push([
      {
        text: `${isActive ? '[Active] ' : ''}${acc.name || key} (${acc.phone || 'No phone'}) - ${statusText}`,
        callback_data: `acc_view_detail_${key}`,
        style: isActive ? 'success' : (acc.isLoggedIn ? 'primary' : 'danger')
      }
    ]);
  }

  buttons.push([
    { text: 'Add New Account', callback_data: 'boss_add_new_account_menu', style: 'primary' },
    { text: 'Refresh Accounts', callback_data: 'acc_refresh_list', style: 'primary' }
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      return;
    } catch (e) {
      if (e.message && e.message.includes('Message is not modified')) {
        return;
      }
    }
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

bot.hears('👥 My Swiggy Accounts', async (ctx) => handleMyAccounts(ctx));
bot.command('accounts', async (ctx) => handleMyAccounts(ctx));
bot.action('acc_refresh_list', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await handleMyAccounts(ctx);
});

// Account Details screen
bot.action(/^acc_view_detail_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.reply('Account not found.');

  const activeKey = getActiveOrderAccountKey();
  const isActive = key === activeKey;

  const exported = exportSessionJson(key) || acc;
  const sessionJsonStr = exported ? JSON.stringify(exported, null, 2) : '';
  const compactStr = exported ? JSON.stringify(exported) : '';
  const phone = acc.phone || acc.mobile || '';

  const text = `<b>Swiggy Account</b>\n\n` +
    `<b>${escapeHtml(acc.name || key)}</b>\n` +
    `<code>${acc.phone || 'No phone set'}</code>\n` +
    `${acc.isLoggedIn ? 'Logged in' : 'Not logged in'}\n\n` +
    (isActive ? `🌟 <b>(Currently Active Order Hub)</b>\n\n` : '') +
    (sessionJsonStr ? `📋 <b>Session Code (Read more):</b>\n<blockquote expandable><pre><code class="language-json">${escapeHtml(sessionJsonStr)}</code></pre></blockquote>\n\n` : '') +
    `Select an option:`;

  const buttons = [
    [
      { text: 'Set as Active Order Hub', callback_data: `acc_set_active_${key}`, style: 'success' },
      { text: 'Saved Addresses', callback_data: `acc_view_addrs_${key}`, style: 'primary' }
    ],
    [
      { text: 'Previous Orders', callback_data: `acc_view_orders_${key}`, style: 'primary' },
      { text: 'View Cart', callback_data: `acc_view_cart_${key}`, style: 'primary' }
    ],
    [
      { text: 'Export JSON', callback_data: `boss_export_json_${key}`, style: 'primary' },
      makeCopyButton('Copy Code', compactStr, `copy_code_${key}`, 'primary')
    ],
    [
      { text: 'Delete Account from Swiggy', callback_data: `boss_swiggy_delete_start_${key}`, style: 'danger' },
      { text: 'Back to Accounts', callback_data: 'acc_refresh_list', style: 'primary' }
    ]
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    if (e.message && e.message.includes('Message is not modified')) return;
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
});

// Set as Active Order Hub
bot.action(/^acc_set_active_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  setActiveOrderAccountKey(key);
  await ctx.answerCbQuery('Order Hub ready! ⚡').catch(() => {});
  await ctx.reply(`<b>Order Hub ready — orders will now be placed from this account.</b>`, { parse_mode: 'HTML' });
});

// Permanent Logout
bot.action(/^acc_perm_logout_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  const name = acc?.name || key;
  const phone = acc?.phone || '';

  permanentLogoutAccount(key);
  await ctx.answerCbQuery('Permanent Logout Successful 🚪').catch(() => {});
  await ctx.reply(
    `<b>Permanent Logout Successful</b>\n\n` +
    `<b>${escapeHtml(name)}</b> <code>${escapeHtml(phone)}</code>\n\n` +
    `The account has been removed from My Swiggy Accounts. To use it again, add it via Login.`,
    { parse_mode: 'HTML' }
  );
});

// 3. Previous Orders
async function handlePreviousOrders(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    return ctx.answerCbQuery ? ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {}) : ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(`⚠️ <b>${acc?.name || activeKey} is not logged in!</b>\nPlease login to view previous orders.`);
  }

  const orders = await fetchAccountOrders(acc);

  if (!orders || orders.length === 0) {
    const emptyText = 
      `<blockquote>📦 <b>PREVIOUS ORDERS</b></blockquote>\n\n` +
      `📱 <b>Account:</b> <code>${acc.phone || ''}</code> (<b>${escapeHtml(acc.name || activeKey)}</b>)\n` +
      `🆔 <b>Customer ID:</b> <code>${acc.customerId || 'Verified'}</code>\n\n` +
      `<i>Is account se Swiggy par abhi tak koi previous order nahi mila (0 orders).</i>`;
    return sendSafeHtml(ctx, emptyText, Markup.inlineKeyboard([
      [
        Markup.button.callback('Delete Account from Swiggy', `boss_swiggy_delete_start_${activeKey}`),
        Markup.button.callback('Refresh Orders', `acc_view_orders_${activeKey}`)
      ],
      [
        Markup.button.callback('Add Another Account', 'send_to_another_number'),
        Markup.button.callback('Main Menu', 'boss_panel_home')
      ]
    ]));
  }

  let text = 
    `<blockquote>📦 <b>PREVIOUS ORDERS (${orders.length})</b></blockquote>\n\n` +
    `📱 <b>Account:</b> <code>${acc.phone || ''}</code> (<b>${escapeHtml(acc.name || activeKey)}</b>)\n` +
    `🆔 <b>Customer ID:</b> <code>${acc.customerId || 'Verified'}</code>\n\n`;

  const buttons = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const statusIcon = (o.status || '').toLowerCase().includes('deliv') ? '🟢' : '🟡';
    text += `<b>${i + 1}. ${escapeHtml(o.restaurantName || 'Swiggy Food')}</b>\n` +
      `• 🏷️ <b>Order ID:</b> <code>#${o.orderId}</code>\n` +
      `• 💰 <b>Amount:</b> <b>₹${o.orderTotal || 0}</b> • ${statusIcon} <code>${escapeHtml(o.status || 'Completed')}</code>\n` +
      (o.items && o.items.length > 0 ? `• 🍽️ <i>${escapeHtml(o.items.join(', '))}</i>\n` : '') +
      (o.deliveryAddress ? `• 📍 <code>${escapeHtml(o.deliveryAddress)}</code>\n` : '') +
      (o.orderTime ? `• ⏱️ <i>${escapeHtml(o.orderTime)}</i>\n` : '') +
      `\n`;

    if (o.trackingUrl) {
      buttons.push([
        Markup.button.url(`Track #${o.orderId} (${o.restaurantName || 'Order'})`, o.trackingUrl)
      ]);
    }
  }

  buttons.push([
    Markup.button.callback('Delete Account from Swiggy', `boss_swiggy_delete_start_${activeKey}`),
    Markup.button.callback('Refresh Orders', `acc_view_orders_${activeKey}`)
  ]);
  buttons.push([
    Markup.button.callback('Add Another Account', 'send_to_another_number'),
    Markup.button.callback('Main Menu', 'boss_panel_home')
  ]);

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.hears(['📦 Previous Orders', '📦 My Orders', 'Previous Orders'], async (ctx) => handlePreviousOrders(ctx));
bot.command(['orders', 'previous_orders'], async (ctx) => handlePreviousOrders(ctx));
bot.action(/^acc_view_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handlePreviousOrders(ctx, key);
});

// 4. View Cart
async function handleViewCart(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    return ctx.answerCbQuery ? ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {}) : ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(`⚠️ <b>${acc?.name || activeKey} is not logged in!</b>\nPlease login with OTP or JSON first.`);
  }

  const waitMsg = await ctx.reply(`🛒 <i>Inspecting live cart & calculating best offers for ${acc.name || activeKey}...</i>`, { parse_mode: 'HTML' });
  const liveCart = await inspectCartForAccount(acc);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!liveCart || (!liveCart.restaurantName && (!liveCart.items || liveCart.items.length === 0))) {
    return ctx.reply(
      `🛒 <b>Your Cart is empty</b> in <b>${acc.name || activeKey}</b>'s Swiggy account.\n\n` +
      `Aap Swiggy app me jakar items cart me add kar sakte hain ya cart link yahan paste kar sakte hain!`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🌐 Open Swiggy Web', 'https://www.swiggy.com/')],
          [Markup.button.callback('ℹ️ Add Food via Link Video', 'action_link_guide')]
        ])
      }
    );
  }

  const receipt = formatSwiggyWorldCartReceipt(liveCart, acc.phone || acc.name || activeKey);
  await ctx.reply(receipt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url('🌐 Open Swiggy Checkout', 'https://www.swiggy.com/checkout')],
      [Markup.button.callback('🔄 Refresh Cart', `acc_view_cart_${activeKey}`)]
    ])
  });
}

bot.hears('🛒 View Cart', async (ctx) => handleViewCart(ctx));
bot.command('cart', async (ctx) => handleViewCart(ctx));
bot.action(/^acc_view_cart_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleViewCart(ctx, key);
});

// 5. Add Food via Link Guide
function handleLinkGuide(ctx) {
  return ctx.reply(
    `<b>Add Food Items via Link</b>\n\n` +
    `Did you know you can add food items to your cart directly through a link?\n` +
    `Watch this quick video https://t.me/FireByWorld/370\n\n` +
    `<i>Note: You can log in with any Swiggy account in the app — both accounts don't need to be the same.</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false }
    }
  );
}

bot.hears('ℹ️ Add Food via Link', handleLinkGuide);
bot.command('link_guide', handleLinkGuide);
bot.action('action_link_guide', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  handleLinkGuide(ctx);
});

// 6. Cash Loot
function handleCashLoot(ctx) {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const buttons = [];

  for (const [key, acc] of Object.entries(accounts)) {
    buttons.push([
      Markup.button.callback(`🎁 ${acc.name || key} (${acc.phone || 'Ready'})`, `cash_loot_acc_${key}`)
    ]);
  }

  return ctx.reply(
    `<b>SWIGGY CASH LOOT</b>\n` +
    `Campaign: ydiHi75 · ₹10 per friend · cap ₹100/account\n\n` +
    `Pehle account chuno — kaunse account pe loot karna hai?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
}

bot.hears('💰 Cash Loot', handleCashLoot);
bot.command('cash_loot', handleCashLoot);
bot.action(/^cash_loot_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `🎁 <b>CASH LOOT READY FOR ${acc?.name || key}:</b>\n\n` +
    `Campaign Link: https://www.swiggy.com/referrals/ydiHi75\n` +
    `Earn ₹10 per friend · Cap ₹100/account!`,
    { parse_mode: 'HTML' }
  );
});

// Boss Slots Commands
bot.command('slots', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const parts = ctx.message.text.trim().split(/\s+/);
  const db = getDb();
  if (parts.length >= 2) {
    const total = parseInt(parts[1], 10);
    if (!isNaN(total) && total >= 0) {
      db.config.totalSlots = total;
      if (parts.length >= 3) {
        const left = parseInt(parts[2], 10);
        if (!isNaN(left)) db.config.slotsLeft = Math.max(0, Math.min(total, left));
      } else {
        db.config.slotsLeft = Math.min(db.config.slotsLeft, total);
      }
      saveDb(db);
      return ctx.reply(`✅ <b>Slots updated!</b>\nSlots Left: <b>${db.config.slotsLeft}/${db.config.totalSlots}</b>`, { parse_mode: 'HTML' });
    }
  }
  return ctx.reply(`📊 <b>Current Slots:</b> ${db.config.slotsLeft}/${db.config.totalSlots}\n\n<i>To update: /slots <total> [left] (e.g. /slots 10 8) or /resetslots</i>`, { parse_mode: 'HTML' });
});

bot.command('resetslots', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const db = getDb();
  db.config.slotsLeft = db.config.totalSlots;
  saveDb(db);
  return ctx.reply(`🔄 <b>Slots Reset!</b>\nSlots Left: <b>${db.config.slotsLeft}/${db.config.totalSlots}</b>`, { parse_mode: 'HTML' });
});

bot.action('noop', async (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.catch(async (err, ctx) => {
  // Ignore harmless "not modified" edits
  if (err.description && err.description.includes('message is not modified')) return;

  // Ignore normal 400 "message too long" & transient query expiration
  const ignorePhrases = ['message is not modified', 'query is too old', 'MESSAGE_ID_INVALID', 'message is too long', 'message to be edited'];
  if (ignorePhrases.some(p => (err.message || err.description || '').toLowerCase().includes(p.toLowerCase()))) return;

  const updateType = ctx?.updateType || 'unknown';
  const errMsg = err.message || err.description || String(err);
  console.error(`❌ Bot error [${updateType}]:`, errMsg);

  // Send error to Boss
  try {
    const db = getDb();
    const bossIds = db?.config?.bossIds || [];
    const shortErr = errMsg.slice(0, 300);
    const errText = `⚠️ <b>Bot Error Alert</b>\n\n` +
      `<b>Type:</b> ${updateType}\n` +
      `<b>Error:</b> <code>${shortErr}</code>\n` +
      `<i>${new Date().toLocaleTimeString('en-IN')}</i>`;
    for (const bossId of bossIds) {
      await bot.telegram.sendMessage(bossId, errText, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (e) {}
});


// Lightweight health check server + 24x7 Render keep-alive pinger
const healthPort = Number(process.env.PORT || 0);
if (healthPort > 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', bot: 'online', timestamp: new Date().toISOString() }));
  });
  server.listen(healthPort, '0.0.0.0', () => {
    console.log(`🌐 Cloud health server listening on 0.0.0.0:${healthPort}`);
  });

  // Self keep-alive ping every 8 minutes via public Render edge URL so container never idles out
  const keepAliveUrl = (process.env.RENDER_EXTERNAL_URL || 'https://ammi-abbu-ka-sacha-beta.onrender.com').replace(/\/+$/, '') + '/';
  setInterval(() => {
    fetch(keepAliveUrl, { signal: AbortSignal.timeout(10000) })
      .then(r => console.log(`💓 Keep-alive ping -> ${keepAliveUrl} [${r.status}]`))
      .catch(e => console.log(`💓 Keep-alive retry note: ${e.message}`));
  }, 8 * 60 * 1000).unref();
}

// Launch bot with retry resilience for cloud container handover
console.log('🚀 Connecting to Telegram Bot API...');
async function startBotWithRetry() {
  try {
    const me = await bot.telegram.getMe();
    console.log(`🤖 Logged in as @${me.username} (${me.first_name}) [ID: ${me.id}]`);

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        console.log('🤖 Telegram Swiggy Real OTP Flow Bot is running live!');
        if (process.env.PREWARM_CHROME === 'true') {
          console.log('⚡ Priming pre-warmed Chrome for instant OTP in background...');
          prewarmBrowser().catch(e => console.log('Prewarm init note:', e.message));
        }
        await bot.launch({ dropPendingUpdates: true });
        break;
      } catch (err) {
        if ((err.message?.includes('409') || err.description?.includes('Conflict')) && attempt < 10) {
          console.log(`⏳ [Attempt ${attempt}/10] Telegram 409 Conflict (previous cloud container shutting down). Retrying in 4 seconds...`);
          await new Promise(r => setTimeout(r, 4000));
        } else {
          console.error('❌ Launch error:', err.message);
          break;
        }
      }
    }
  } catch (err) {
    console.error('❌ Failed to connect to Telegram:', err);
  }
}

startBotWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
