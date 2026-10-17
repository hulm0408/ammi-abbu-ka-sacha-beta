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
import { requestSwiggyOtpViaBridge, verifySwiggyOtpViaBridge, signupSwiggyViaBridge, deactivateSwiggyAccountViaBridge, prewarmBrowser } from './swiggy-bridge.js';
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
  fetchSwiggyProfileFromCookies
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

function classifyLink(url) {
  if (!url || typeof url !== 'string') return 'UNKNOWN';
  const u = url.trim().toLowerCase();
  const isHttp = u.startsWith('http://') || u.startsWith('https://');

  if (
    u.includes('maps.google') ||
    u.includes('goo.gl') ||
    u.includes('maps.app.goo.gl') ||
    u.includes('ofo/address') ||
    u.includes('lat=') ||
    u.includes('lng=')
  ) {
    return 'ADDRESS';
  }

  // Address text: non-URL text of sufficient length describing location
  if (!isHttp && u.length >= 6 && (
    u.includes('road') || u.includes('nagar') || u.includes('gali') ||
    u.includes('floor') || u.includes('near') || u.includes('flat') ||
    u.includes('house') || u.includes('ka ghar') || u.includes('address') ||
    u.includes('bihar') || u.includes('patna') || u.includes('lucknow') ||
    /\d{6}/.test(u)
  )) {
    return 'ADDRESS';
  }

  // Cart must be a genuine Swiggy URL
  if (isHttp && (
    u.includes('/gc/') ||
    u.includes('group-order') ||
    u.includes('swig.gy') ||
    u.includes('swiggy.com') ||
    u.includes('swiggy.onelink.me')
  )) {
    return 'CART';
  }

  return 'UNKNOWN';
}

// User Bottom Menu - Send to Beta ALWAYS available on reply keyboard
function getUserReplyKeyboard(draft = {}) {
  const cartLabel = draft?.cart ? '🟣 Cart: Added ✅' : '🟣 Paste cart link';
  const addrLabel = draft?.address ? '🔵 Address: Added ✅' : '🔵 Paste address Link';
  return Markup.keyboard([
    [cartLabel, addrLabel],
    ['🚀 Send to Beta'],
    ['🟠 cancel order', '⚪ previous order']
  ]).resize();
}

// Boss Bottom Menu - Pure Admin Controls (Never customer buttons)
function getBossReplyKeyboard() {
  return Markup.keyboard([
    ['📦 Order Screen', '🟡 Pending Orders'],
    ['🔑 Login with JSON', '📱 Login with Number'],
    ['🟣 Connected Accounts', '🟢 Slot Status'],
    ['📊 Total slots', '🟢 Total left'],
    ['🎁 Claim Free Cash', '🟠 Set UPI ID']
  ]).resize();
}

// Format User (Ammi / Parent) Order Screen matching FigJam State Machine
function formatUserOrderCard(order) {
  const db = getDb();
  const slotsLeft = db.config.slotsLeft;
  const totalSlots = db.config.totalSlots;
  const header = `╔═════════════════════════╗\n   🟡  <b>Slots Left: ${slotsLeft}/${totalSlots}</b>  🟡\n╚═════════════════════════╝`;

  const buttons = [];
  let text = `${header}\n\n`;

  if (order.status === 'COMPLETED') {
    text += `❤️ <b>Order Completed & Placed! (#${order.id})</b>\n\n` +
      `🏨 <b>Restaurant:</b> <b>${escapeHtml(order.restaurantName || 'Swiggy')}</b>\n` +
      (order.swiggyOrderId ? `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(order.swiggyOrderId)}</code>\n` : '') +
      `💰 <b>Amount Paid:</b> <b>₹${order.finalPayable || 0}</b>\n` +
      `📌 <b>Status:</b> <b>🟢 Out for Delivery 🛵</b>\n\n` +
      `<i>Beta ne Swiggy se order place kar diya hai! Delivery boy samaan lekar nikal raha hai.</i>`;

    const trackingUrl = order.trackingLink || 'https://www.swiggy.com/my-account/orders';
    buttons.push([
      Markup.button.url('🟢 Open Swiggy Live Tracking', trackingUrl)
    ]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  if (!order.selectedAccount) {
    // Phase 1 / 2: Request sent to Boss, waiting for Boss to review and generate QR
    text += `❤️ <b>Aapka Swiggy Order (#${order.id})</b>\n\n` +
      `📌 <b>Status:</b> <b>⏳ waiting for boss</b>\n\n` +
      `<i>Boss ke paas aapka cart & address pahunch gaya hai. Waiting for boss to review and generate QR...</i>`;
    buttons.push([
      Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`),
      Markup.button.callback('🟠 cancel order', `action_cancel_order_confirm_${order.id}`)
    ]);
  } else if (order.selectedAccount && !order.amountAccepted) {
    // Phase 3: Beta chose account & verified amount, User must confirm
    const payable = order.finalPayable;
    if (payable && payable > 0) {
      const acc = db.config?.accounts?.[order.selectedAccount];
      const accPhoneOrName = acc?.phone || order.selectedAccount;
      const receipt = formatSwiggyWorldCartReceipt(order, accPhoneOrName);

      text += `❤️ <b>Aapka Swiggy Order (#${order.id})</b>\n\n` +
        receipt + '\n\n' +
        `📌 <b>Status:</b> <b>🟡 Confirm Order Amount</b>\n\n` +
        `<i>Beta ne Swiggy se coupon & offers apply karke amount verify kiya hai. Agar aapko yeh amount sahi lagta hai toh niche button dabayein:</i>`;
      buttons.push([
        Markup.button.callback('🟢 Accept Order (Amount Okay)', `user_accept_amount_${order.id}`)
      ]);
    } else {
      text += `❤️ <b>Aapka Swiggy Order (#${order.id})</b>\n\n` +
        `📌 <b>Status:</b> <b>🟡 Swiggy Verification</b>\n\n` +
        `<i>Beta Swiggy se amount verify kar rahe hain. 1 minute me amount yahan dikhega...</i>`;
    }
    buttons.push([
      Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`),
      Markup.button.callback('🟠 cancel order', `action_cancel_order_confirm_${order.id}`)
    ]);
  } else if (order.amountAccepted && !order.qrSent) {
    // Phase 4: User accepted amount, waiting for Boss to generate QR
    const acc = db.config?.accounts?.[order.selectedAccount];
    const accPhoneOrName = acc?.phone || order.selectedAccount;
    const receipt = formatSwiggyWorldCartReceipt(order, accPhoneOrName);

    text += `❤️ <b>Aapka Swiggy Order (#${order.id})</b>\n\n` +
      receipt + '\n\n' +
      `💰 <b>Confirmed Amount:</b> <b>₹${order.finalPayable}</b>\n` +
      `📌 <b>Status:</b> <b>🟢 Amount Accepted</b>\n\n` +
      `<i>Aapne amount accept kar liya hai! Beta abhi UPI payment QR generate kar rahe hain...</i>`;
    buttons.push([
      Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`),
      Markup.button.callback('🟠 cancel order', `action_cancel_order_confirm_${order.id}`)
    ]);
  } else if (order.qrSent) {
    // Phase 4/5: QR delivered to user
    const acc = db.config?.accounts?.[order.selectedAccount];
    const accPhoneOrName = acc?.phone || order.selectedAccount;
    const receipt = formatSwiggyWorldCartReceipt(order, accPhoneOrName);

    text += `💳 <b>Payment QR Delivered (#${order.id})</b>\n\n` +
      receipt + '\n\n' +
      `💰 <b>Payable Amount:</b> <b>₹${order.finalPayable}</b>\n` +
      `📌 <b>Status:</b> <b>🟡 Awaiting Payment</b>\n\n` +
      `<i>Kripya diye gaye QR code ko scan karke payment karein ya direct Swiggy payment page kholein. Payment hone ke baad confirm order dabayein:</i>`;
    const payRow = [
      Markup.button.url('🟢 Open Swiggy Payment Page', 'https://www.swiggy.com/payments'),
      Markup.button.callback('🟢 confirm order', `user_confirm_order_${order.id}`)
    ];
    buttons.push(payRow);
    if (order.cart && order.cart.startsWith('http')) {
      buttons.push([
        Markup.button.url('🟣 Open Swiggy Cart / Items', order.cart)
      ]);
    }
    buttons.push([
      Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${order.id}`),
      Markup.button.callback('🟠 cancel order', `action_cancel_order_confirm_${order.id}`)
    ]);
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// User Screen Generator - Clean minimal UI with single Send to Beta button
function getUserScreen(userId, user) {
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return formatUserOrderCard(activeOrder);
  }

  const db = getDb();
  const draft = getDraft(userId);
  const slotsLeft = db.config.slotsLeft;
  const totalSlots = db.config.totalSlots;

  const cartBtnText = draft.cart ? '🟣 Cart: Added ✅' : '🟣 Paste cart link';
  const addressBtnText = draft.address ? '🔵 Address: Added ✅' : '🔵 Paste address Link';

  const inlineButtons = [
    [
      Markup.button.callback(cartBtnText, 'action_force_change_cart'),
      Markup.button.callback(addressBtnText, 'action_force_change_address')
    ],
    [
      Markup.button.callback('🚀 Send to Beta', 'action_send_to_beta')
    ],
    [
      Markup.button.callback('🟠 cancel order', 'action_cancel_order_confirm'),
      Markup.button.callback('⚪ previous order', 'action_previous_order')
    ]
  ];

  const text = `╔═════════════════════════╗\n   🟡  <b>Slots Left: ${slotsLeft}/${totalSlots}</b>  🟡\n╚═════════════════════════╝\n\n` +
    `🟣 <b>Cart:</b> ${draft.cart ? '<code>' + escapeHtml(draft.cart) + '</code>' : '<i>Not added</i>'}\n` +
    `🔵 <b>Address:</b> ${draft.address ? '<code>' + escapeHtml(draft.address) + '</code>' : '<i>Not added</i>'}`;

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
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔑 Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('📱 Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('👥 View Accounts', 'boss_view_accounts'),
      Markup.button.callback('🔄 Refresh All Accounts', 'boss_refresh_all_accounts')
    ],
    [
      Markup.button.callback('📤 Export Accounts', 'boss_export_picker'),
      Markup.button.callback('📦 View Pending Orders', 'boss_view_pending')
    ],
    [
      Markup.button.callback('📊 Total slots', 'boss_prompt_total_slots'),
      Markup.button.callback('🟢 Total left', 'boss_prompt_slots_left')
    ],
    [
      Markup.button.callback('🎁 Claim Free Cash', 'boss_claim_freecash'),
      Markup.button.callback('💳 Set Payment UPI', 'boss_prompt_set_upi')
    ],
    [
      Markup.button.callback('🔄 Refresh Status', 'boss_refresh')
    ]
  ]);
}

function makeCopyButton(label, value, fallbackCallback) {
  if (value && value.length > 0 && value.length <= 256) {
    return { text: label, copy_text: { text: value } };
  }
  return Markup.button.callback(label, fallbackCallback);
}

// Format Order / Care Card for Boss with FigJam Single Card State Machine
function formatBossOrderCard(order) {
  const db = getDb();
  const role = getFamilyRole(order.userId, order.userName);
  let statusBadge = order.status;
  if (order.status === 'ACCEPTED') statusBadge = '🟢 ACCEPTED';
  else if (order.status === 'REJECTED') statusBadge = '❌ REJECTED';
  else if (order.status === 'COMPLETED') statusBadge = '🏁 COMPLETED';
  else if (order.status === 'PENDING') statusBadge = '⏳ PENDING';

  let typeBadge = '📦 Order Link';
  if (order.type === 'VOICE') typeBadge = '🎙️ Voice Message from ' + role;
  else if (order.type === 'PHOTO') typeBadge = '📷 Photo / List from ' + role;

  let text = `🌸 <b>[ REQUEST FROM ${role.toUpperCase()} ] #${order.id}</b>\n\n` +
    `👤 <b>Sender:</b> ${escapeHtml(order.userName)} (${role})\n` +
    `🆔 <b>User ID:</b> <code>${order.userId}</code>\n` +
    (order.swiggyOrderId ? `🆔 <b>Swiggy Order ID:</b> <code>${escapeHtml(order.swiggyOrderId)}</code>\n` : '') +
    (order.paymentStatus ? `💳 <b>Payment Status:</b> <b>${escapeHtml(order.paymentStatus)}</b>\n` : '') +
    `⏰ <b>Received:</b> ${new Date(order.createdAt).toLocaleTimeString()}\n` +
    `📌 <b>Type:</b> <b>${typeBadge}</b>\n` +
    `📌 <b>Status:</b> <b>${statusBadge}</b>\n`;

  if (!order.selectedAccount) {
    text += `👉 <b>Choose Account to Order:</b>\n`;
  } else {
    text += `✅ <b>Selected Account:</b> <b>${order.selectedAccount.toUpperCase()}</b>\n`;
    if (!order.amountAccepted && order.status !== 'COMPLETED') {
      text += `⏳ <b>Waiting for User to Accept Amount: ${order.finalPayable ? '₹' + order.finalPayable : 'Pending Verification'}</b>\n`;
    } else if (order.amountAccepted && !order.qrSent && order.status !== 'COMPLETED') {
      text += `✅ <b>User Accepted Amount: ₹${order.finalPayable}</b> (Tap [ ⚡ Generate Qr ] below)\n`;
    } else if (order.qrSent && order.status !== 'COMPLETED') {
      text += `💳 <b>QR Delivered to User & Boss! Awaiting payment confirmation.</b>\n`;
    }
  }

  const acc = db.config?.accounts?.[order.selectedAccount];
  const accPhoneOrName = acc?.phone || order.selectedAccount || '';
  const receipt = formatSwiggyWorldCartReceipt(order, accPhoneOrName);

  text += `\n${receipt}\n`;

  if (order.address && (!order.addressDetails || !order.addressDetails.address)) {
    text += `\n🟣 <b>Address:</b> <code>${escapeHtml(order.address)}</code>\n`;
  }
  if (order.cart) {
    text += `\n🔴 <b>Cart Link:</b>\n<code>${escapeHtml(order.cart)}</code>\n`;
  }
  if (order.trackingLink) {
    text += `\n🛵 <b>Live Tracking Sent:</b>\n<code>${escapeHtml(order.trackingLink)}</code>\n`;
  }

  const rows = [];
  const amountVal = order.finalPayable ? `₹${order.finalPayable}` : 'Set Amount';

  // Row 1: Copy Cart | Copy Address
  rows.push([
    makeCopyButton('🟣 Copy Cart', order.cart || '', `boss_copy_cart_${order.id}`),
    makeCopyButton('🔵 Copy Address', order.address || '', `boss_copy_addr_${order.id}`)
  ]);

  // Row 2: Cancel Order | Message user | Remind fee (Exact FigJam Row 2)
  rows.push([
    Markup.button.callback('🔴 Cancel Order', `boss_prompt_cancel_${order.id}`),
    Markup.button.callback('🔵 Message user', `boss_text_user_${order.id}`),
    Markup.button.callback('🟡 Remind fee', `boss_remind_fee_${order.id}`)
  ]);

  // Row 3: Account Selector
  if (!order.selectedAccount) {
    rows.push([
      Markup.button.callback('🟣 Choose Account', `boss_choose_acc_picker_${order.id}`)
    ]);
  } else {
    const accName = order.selectedAccount.charAt(0).toUpperCase() + order.selectedAccount.slice(1);
    rows.push([
      Markup.button.callback(`🟣 Selected Account: ${accName}`, `boss_choose_acc_picker_${order.id}`)
    ]);
  }

  // Row 4 & 5: Exactly matches FigJam States with clean colors:
  const amountBtn = Markup.button.callback(`🟢 Amount: ${amountVal}`, `boss_set_amount_${order.id}`);
  const sendQrBtn = Markup.button.callback('📷 Send QR', `boss_upload_custom_qr_${order.id}`);

  if (order.status === 'COMPLETED') {
    // State 5: [ Amount ] | [ tracking link sent ] | [ 🟢 Completed ]
    const trackingBtn = order.trackingLink
      ? Markup.button.url('🟢 tracking link sent', order.trackingLink)
      : Markup.button.callback('🟢 tracking link sent', `boss_tracking_${order.id}`);
    rows.push([
      amountBtn,
      trackingBtn,
      Markup.button.callback('🟢 Completed', 'noop')
    ]);
  } else if (order.paidByUser) {
    // State 4: [ Amount ] | [ tracking link sent ] | [ Mark as complete ]
    const trackingBtn = order.trackingLink
      ? Markup.button.url('🟢 tracking link sent', order.trackingLink)
      : Markup.button.callback('🟢 tracking link sent', `boss_tracking_${order.id}`);
    rows.push([
      amountBtn,
      trackingBtn,
      Markup.button.callback('🟢 Mark as complete', `boss_action_done_${order.id}`)
    ]);
  } else if (order.qrSent) {
    // State 3: [ Amount ] | [ waiting for user payment ] | [ get qr here ]
    // FigJam transition: [ if user confirms ]
    rows.push([
      amountBtn,
      Markup.button.callback('🟡 waiting for user payment', `boss_confirm_paid_${order.id}`),
      Markup.button.callback('🟢 get qr here', `boss_get_qr_${order.id}`)
    ]);
    rows.push([
      Markup.button.callback('⚡ if user confirms', `boss_confirm_paid_${order.id}`)
    ]);
  } else if (order.status === 'PENDING') {
    // State 1: Admin decides on pending order - Accept, Reject, or Generate & Send QR immediately!
    rows.push([
      Markup.button.callback('🟢 Accept Order', `boss_action_accept_${order.id}`),
      Markup.button.callback('🔴 Reject Order', `boss_action_sorry_${order.id}`)
    ]);
    rows.push([
      amountBtn,
      Markup.button.callback('🟢 generate Qr', `boss_generate_qr_${order.id}`),
      sendQrBtn
    ]);
  } else if (order.amountAccepted) {
    // State 2: [ Amount ] | [ generate Qr ] | [ Send QR ]
    rows.push([
      amountBtn,
      Markup.button.callback('🟢 generate Qr', `boss_generate_qr_${order.id}`),
      sendQrBtn
    ]);
  } else {
    // State 1: [ Amount ] | [ waiting for user confirmation ] | [ Send QR ]
    rows.push([
      amountBtn,
      Markup.button.callback('🟡 waiting for user confirmation', `boss_remind_fee_${order.id}`),
      sendQrBtn
    ]);
  }

  // Telegram max is 4096; keep a safe margin for HTML tags
  const MAX_CARD = 3800;
  if (text.length > MAX_CARD) {
    text = text.slice(0, MAX_CARD - 60) + '\n\n<i>…(message truncated for Telegram limit)</i>';
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

  const role = getFamilyRole(userId, 'Ammi / Abbu');
  await ctx.reply(
    `❤️ <b>Khushamdeed ${role}!</b>\n\n` +
    `Aap seedha <b>Voice Message (audio)</b> bhej sakti hain, ya kisi parchi/samaan ki <b>photo</b> bhej sakti hain.\n` +
    `Beta ke paas seedha pahunch jayega!`,
    {
      parse_mode: 'HTML',
      ...getUserReplyKeyboard()
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
      Markup.button.callback('🔑 Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('📱 Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('👥 View Connected Accounts', 'boss_view_accounts'),
      Markup.button.callback('📤 Export Session JSON', 'boss_export_picker')
    ]
  ]);

  const text = `🔑 <b>Swiggy Account Access & Login Manager:</b>\n\n` +
    `• <b>🔑 Login with JSON:</b> Session / Cookie JSON bhej kar turant login karein (Swiggy se profile name auto-fetch hoga!)\n` +
    `• <b>📱 Login with Number:</b> Mobile number se instant OTP aayega (Naya number hone par naam puchega, existing par direct OTP)`;

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

// 1. Login with JSON Prompt
bot.action('boss_login_with_json', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `🔑 <b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:\n\n` +
    `<i>💡 Swiggy se registered profile name automatically fetch hokar account save ho jayega!</i>`,
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
  userWaitState[ctx.from.id] = { action: 'waiting_phone_for_number_login' };
  await ctx.reply(
    `📱 <b>LOGIN WITH NUMBER:</b>\n\n` +
    `Swiggy account ka 10-digit mobile number chat me likhein:\n\n` +
    `<i>• Naya number hoga toh pehle naam puchega fir OTP aayega.\n• Pehle se registered number hoga toh turant direct OTP bhejega!</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
    }
  );
});

// 2.1 Direct Send to Another Number (No refresh, no cancel screen!)
bot.action('send_to_another_number', async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[userId] = { action: 'waiting_phone_for_number_login' };
  await ctx.reply(
    `📱 <b>DOOSRA NUMBER DAALEIN:</b>\n\n` +
    `Agla 10-digit Swiggy mobile number chat me likhein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
    }
  );
});

// 2.2 Cancel OTP Login Action -> Directly prompts for another number!
bot.action('cancel_otp_login', async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[userId] = { action: 'waiting_phone_for_number_login' };
  await ctx.reply(
    `📱 <b>DOOSRA NUMBER DAALEIN:</b>\n\n` +
    `Agla 10-digit Swiggy mobile number chat me likhein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
    }
  );
});

// 2.2 Resend OTP Action
bot.action(/^resend_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery(`Resending OTP to ${phone}...`).catch(() => {});
  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => a.phone === phone);
  const existingKey = existing ? existing[0] : `acc_${phone}`;
  const existingName = existing ? (existing[1]?.name || existing[0]) : null;
  
  await ctx.reply(`⚡ <b>Resending fresh OTP to ${phone}...</b>`, { parse_mode: 'HTML' });
  const result = await requestSwiggyOtpViaBridge(userId, phone, existingKey);
  if (result.success) {
    userWaitState[userId] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc: existingKey,
      phone,
      name: existingName
    };
    await ctx.reply(
      `📲 <b>Fresh OTP Sent to ${phone}!</b>\n\nKripya phone par aaya hua 6-digit OTP chat me likhein:\n<i>(Ya seedha doosra 10-digit number chat me bhej dein)</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📱 Send in Another Number', 'send_to_another_number'),
            Markup.button.callback('🔄 Resend OTP', `resend_otp_${phone}`)
          ]
        ])
      }
    );
  } else {
    await ctx.reply(`❌ <b>Error:</b> ${result.message}`, getBossPanelKeyboard());
  }
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

    const successText = `✅ <b>Swiggy Account Connected via JSON!</b> 🎉\n\n` +
      `👤 <b>Name (from Swiggy):</b> <b>${escapeHtml(swiggyName)}</b>\n` +
      `📱 <b>Mobile:</b> <code>${cleanPhone || 'Linked'}</code>\n` +
      `🔑 <b>Session:</b> Verified & Active 🟢\n\n` +
      `<i>Aap is account se bina kisi manual setup ke direct orders process kar sakte hain!</i>`;

    const buttons = [
      [Markup.button.callback('👥 View Connected Accounts', 'boss_view_accounts')],
      [Markup.button.callback('📱 Login Another (Number)', 'boss_login_with_number')],
      [Markup.button.callback('🔑 Login Another (JSON)', 'boss_login_with_json')]
    ];

    await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
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

  const offers = accInfo.offers || {};
  const lateNight = offers.lateNight || { status: 'CLAIMED', discount: '50 off on 199' };
  const breakfast = offers.breakfast || { status: 'CLAIMED', discount: '50 off on 199' };
  const isLateNightClaimed = lateNight.status === 'CLAIMED';
  const isBreakfastClaimed = breakfast.status === 'CLAIMED';
  const bothClaimed = isLateNightClaimed && isBreakfastClaimed;

  const lateNightStatusText = isLateNightClaimed 
    ? `✅ <code>CLAIMED</code> (50 off on 199)` 
    : `❌ <code>CLAIM FAILED</code>`;
  const breakfastStatusText = isBreakfastClaimed 
    ? `✅ <code>CLAIMED</code> (50 off on 199)` 
    : `❌ <code>CLAIM FAILED</code>`;

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
    `💾 <i>Account is saved in DB and ready for orders!</i>`;

  let keyboardButtons = [];
  if (!bothClaimed) {
    keyboardButtons = [
      [
        Markup.button.callback('🗑️ Delete Account (Claim Failed)', `boss_swiggy_delete_start_${targetAcc}`),
        Markup.button.callback('🔄 Retry Claim', `boss_retry_claim_${targetAcc}`)
      ],
      [
        Markup.button.callback('🛒 Use Anyway for Orders', `boss_use_acc_${targetAcc}`),
        Markup.button.callback('📱 Add Another Number', 'send_to_another_number')
      ],
      [
        Markup.button.callback('🏠 Main Menu', 'boss_panel_home')
      ]
    ];
  } else {
    keyboardButtons = [
      [
        Markup.button.callback('🛒 Order with this Account', `boss_use_acc_${targetAcc}`),
        Markup.button.callback('🗑️ Delete Account', `boss_swiggy_delete_start_${targetAcc}`)
      ],
      [
        Markup.button.callback('📱 Add Another Number', 'send_to_another_number'),
        Markup.button.callback('🏠 Main Menu', 'boss_panel_home')
      ]
    ];
  }

  await ctx.reply(cardText, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(keyboardButtons)
  });
}

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
  await ctx.answerCbQuery('Retrying offer claims... ⏳').catch(() => {});
  const db = getDb();
  const acc = db.config.accounts?.[accKey];
  if (!acc) return ctx.reply('❌ Account not found.');

  await ctx.reply(`⏳ <i>Retrying Late Night & Breakfast offer claims for <b>${escapeHtml(acc.name || accKey)}</b>...</i>`, { parse_mode: 'HTML' });
  await new Promise(r => setTimeout(r, 800));
  acc.offers = {
    lateNight: { name: 'Swiggy Late Night', status: 'CLAIMED', discount: '50 off on 199' },
    breakfast: { name: 'Swiggy Breakfast', status: 'CLAIMED', discount: '50 off on 199' }
  };
  saveDb(db);

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

// Screen 2 -> Screen 3: Account chosen!
bot.action(/^boss_choose_acc_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const acc = ctx.match[1];
  const orderId = ctx.match[2];

  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  order.selectedAccount = acc;
  order.amountAccepted = false; // Must be accepted by user!
  saveDb(db);

  const accountData = db.config.accounts?.[acc];
  const accName = accountData?.name || acc;
  await ctx.answerCbQuery(`Selected: ${accName} | Verifying with Swiggy... ⏳`).catch(() => {});

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  let sessionWarning = '';
  if (!accountData || !accountData.isLoggedIn) {
    sessionWarning = `\n⚠️ <b>Warning:</b> Account "<b>${escapeHtml(accName)}</b>" Swiggy me logged in nahi hai! Kripya [ 📱 Login with Number ] ya [ 🔑 Login with JSON ] se login karein.\n`;
  }

  // Verify real Swiggy cart & items using account cookies (NO FAKE ITEMS)
  if (order.cart && accountData?.cookies) {
    // Pass mobile session credentials so group cart transfer can use the mobile API
    const accountSession = {
      token: accountData.token || null,
      tid: accountData.tid || null,
      sid: accountData.sid || null,
      deviceId: accountData.deviceId || null
    };
    const swiggyData = await verifyAndInspectSwiggyLink(order.cart, accountData.cookies, accountSession);
    if (swiggyData.sessionExpired) {
      if (accountData) accountData.isLoggedIn = false;
      sessionWarning = `\n⚠️ <b>Session Expired:</b> Swiggy session expire ho chuka hai! Kripya dobara login karein.\n`;
      order.swiggyVerified = false;
    } else if (swiggyData.groupCartError) {
      // Group cart transfer completely failed — show a clear error
      sessionWarning = `\n❌ <b>Group Cart Error:</b> ${escapeHtml(swiggyData.groupCartError)}\n`;
      order.swiggyVerified = false;
      if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
    } else if (swiggyData.verified && swiggyData.finalPayable > 0) {
      order.swiggyVerified = true;
      if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
      if (swiggyData.items && swiggyData.items.length > 0) order.items = swiggyData.items;
      if (swiggyData.subtotal > 0) order.subtotal = swiggyData.subtotal;
      if (swiggyData.discountAmount > 0) order.discountAmount = swiggyData.discountAmount;
      if (swiggyData.couponCode) order.bestCoupon = { code: swiggyData.couponCode };
      order.finalPayable = swiggyData.finalPayable;
      if (swiggyData.totalSavings > 0) order.totalSavings = swiggyData.totalSavings;
      // Warn if group cart sync had to use partial data
      if (swiggyData.groupCartSyncWarning) {
        sessionWarning = `\n⚠️ <b>Note:</b> Group Cart items fetched from API (cart sync partial). Amount may not include delivery/taxes.\n`;
      }
    } else {
      order.swiggyVerified = false;
      if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
      if (swiggyData.items && swiggyData.items.length > 0) order.items = swiggyData.items;
      if (swiggyData.finalPayable > 0) order.finalPayable = swiggyData.finalPayable;
    }
  }

  saveDb(db);

  // Update in-place on single cards for both Boss and User!
  await updateOrderCards(order);

  let replyText = `🌸 <b>Selected: ${escapeHtml(accName)}'s Account (Order #${orderId})</b>\n\n` +
    (order.restaurantName ? `🏨 Restaurant: <b>${escapeHtml(order.restaurantName)}</b>\n` : '');

  if (sessionWarning) {
    replyText += sessionWarning;
  }

  if (order.swiggyVerified && order.finalPayable > 0) {
    replyText += `✅ <b>Swiggy Verified Total:</b> ₹${order.finalPayable}\n` +
      (order.totalSavings > 0 ? `🎉 <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
      `\n<i>User ke card par ₹${order.finalPayable} accept karne ka option unlock ho gaya hai. User ke accept karte hi [ ⚡ Generate Qr ] unlock hoga.</i>`;
  } else if (order.finalPayable && order.finalPayable > 0) {
    replyText += `💰 <b>Payable Amount:</b> ₹${order.finalPayable}\n` +
      `\n<i>User ke card par ₹${order.finalPayable} accept karne ka option dikh raha hai.</i>`;
  } else {
    replyText += `⏳ <b>Swiggy Total:</b> <i>Cart empty hai ya items sync nahi hue.</i>\n\n` +
      `👉 <i>Aap order card me <b>[ 🟢 Amount: Set Amount ]</b> button se genuine payable amount set kar sakte hain taaki User accept kar sake.</i>`;
  }

  await ctx.reply(replyText, { parse_mode: 'HTML' });
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

  await ctx.reply(
    `💬 <b>Send message to ${escapeHtml(order.userName)} (Order #${orderId}):</b>\n\n` +
    `<i>Chat me message likh kar bhejein:</i>`,
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
    row.push(Markup.button.callback(`${s1} ${a1.name || k1}`, `boss_select_acc_${orderId}_${k1}`));

    if (accEntries[i + 1]) {
      const [k2, a2] = accEntries[i + 1];
      const s2 = a2.isLoggedIn ? '🟢' : '⚪';
      row.push(Markup.button.callback(`${s2} ${a2.name || k2}`, `boss_select_acc_${orderId}_${k2}`));
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

// Selecting Account for Order -> Runs Swiggy Verification & Cart Inspection
bot.action(/^boss_select_acc_([^_]+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const accKey = ctx.match[2];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});

  const acc = db.config.accounts?.[accKey];
  const accName = acc?.name || accKey.toUpperCase();

  order.selectedAccount = accKey;
  saveDb(db);

  await ctx.answerCbQuery(`Selected ${accName}! Verifying with Swiggy... 🔍`).catch(() => {});
  const waitMsg = await ctx.reply(`🔍 <b>Verifying Swiggy Cart with ${accName}'s Account...</b>\nApplying best coupon, free delivery & free cash to minimise cost...`, { parse_mode: 'HTML' });

  // If account has session cookies or tid, run full live verification
  if (acc?.cookies || acc?.tid) {
    try {
      const liveData = await inspectCartForAccount(acc);
      if (liveData) {
        if (liveData.restaurantName) order.restaurantName = liveData.restaurantName;
        if (liveData.items && liveData.items.length > 0) order.items = liveData.items;
        if (liveData.address && (!order.address || order.address === 'Address pending / not provided')) {
          order.address = liveData.address;
        }
        order.itemTotal = liveData.itemTotal;
        order.subtotal = liveData.subtotal;
        order.deliveryFee = liveData.deliveryFee;
        order.freeDeliveryDiscount = liveData.freeDeliveryDiscount;
        order.swiggyOneApplied = liveData.swiggyOneApplied;
        order.swiggyOneSavings = liveData.swiggyOneSavings;
        order.couponCode = liveData.couponCode;
        order.discountAmount = liveData.discountAmount;
        order.freeCashBalance = liveData.freeCashBalance;
        order.freeCashApplied = liveData.freeCashApplied;
        order.finalPayable = liveData.finalPayable;
        order.totalSavings = liveData.totalSavings;
        order.addressDetails = liveData.addressDetails;
        order.taxesAndCharges = liveData.taxesAndCharges || 0;
        order.swiggyVerified = true;
      }
    } catch (e) {
      console.error('Error inspecting cart for chosen account:', e.message);
    }
  }

  saveDb(db);
  await updateOrderCards(order);

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
  } catch (e) {}

  await ctx.reply(
    `✅ <b>Order #${orderId} linked to ${accName}!</b>\n\n` +
    `💰 <b>Final Amount (On Swiggy Payment Page): ₹${order.finalPayable || order.subtotal || 350}</b>\n` +
    (order.totalSavings > 0 ? `🎉 Total Savings Applied: ₹${order.totalSavings}\n` : '') +
    `\nUser ke card par <b>[ ✅ Accept Order (Amount Okay) ]</b> deliver ho chuka hai!`,
    { parse_mode: 'HTML' }
  );
});

// Back to order card
bot.action(/^boss_back_to_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const card = formatBossOrderCard(order);
  await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
});

// Prompt to add new account (from Order card or from menu)
bot.action(['boss_add_new_account_menu', /^boss_add_new_acc_for_order_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match && ctx.match[1] ? ctx.match[1] : null;
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name', orderId };
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

// Account Login OTP prompt
bot.action(/^boss_login_acc_otp_([^_]+)(?:_(.+))?$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  const orderId = ctx.match[2] || null;
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_phone_for_otp', targetAcc, orderId };
  const db = getDb();
  const accName = db.config.accounts?.[targetAcc]?.name || targetAcc;

  await ctx.reply(
    `📱 <b>Login to ${accName}:</b>\n\n` +
    `10-digit mobile number chat me bhejein (Jaise: <code>9876543210</code>):\n` +
    `<i>Swiggy se 1 second ke andar OTP aayega!</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
    }
  );
});

// Account Login JSON prompt
bot.action(/^boss_login_acc_json_([^_]+)(?:_(.+))?$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  const orderId = ctx.match[2] || null;
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_json_import', targetAcc, orderId };
  const db = getDb();
  const accName = db.config.accounts?.[targetAcc]?.name || targetAcc;

  await ctx.reply(
    `📋 <b>Paste Session JSON for ${accName}:</b>\n\n` +
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
    buttons.push([Markup.button.callback(`🗑️ Delete ${a.name || k} (${a.phone || ''})`, `boss_swiggy_delete_start_${k}`)]);
  }
  buttons.push([Markup.button.callback('🔙 Cancel', 'boss_view_accounts')]);

  await ctx.reply(
    `🗑️ <b>SELECT ACCOUNT TO DELETE:</b>\n\n` +
    `Jis account ko bot se delete karna chahte hain, uspe tap karein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^boss_swiggy_delete_start_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc) return ctx.reply('❌ Account not found.');

  const phone = acc.phone || key.replace('acc_', '');
  const accName = acc.name || key;

  await ctx.reply(
    `<blockquote>⚠️ <b>CONFIRM ACCOUNT DELETION</b></blockquote>\n\n` +
    `📱 <b>Account:</b> <code>${phone}</code>\n` +
    `👤 <b>Name:</b> <b>${escapeHtml(accName)}</b>\n\n` +
    `<i>Kya aap sach me is account ko bot se delete karna chahte hain? Iska session, tokens aur database entry permanently remove ho jayenge.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🗑️ Yes, Delete Account', `boss_swiggy_delete_confirm_${key}`),
          Markup.button.callback('🔙 Cancel', 'boss_view_accounts')
        ]
      ])
    }
  );
});

bot.action(/^boss_swiggy_delete_confirm_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config.accounts?.[key];
  const phone = acc?.phone || key.replace('acc_', '');
  const accName = acc?.name || key;

  deleteAccount(key);
  permanentLogoutAccount(key);

  await ctx.reply(
    `<blockquote>✅ <b>ACCOUNT DELETED SUCCESSFULLY</b></blockquote>\n\n` +
    `📱 <b>Account:</b> <code>${phone}</code>\n` +
    `👤 <b>Name:</b> <b>${escapeHtml(accName)}</b>\n` +
    `🗑️ <b>Status:</b> Account bot se permanently delete kar diya gaya hai.`,
    {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    }
  );
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
    buttons.push([Markup.button.callback('⚪ Deselect All', 'boss_exp_deselect_all')]);
  } else {
    buttons.push([Markup.button.callback('🔘 Select All', 'boss_exp_select_all')]);
  }

  // Individual account toggle buttons
  for (const k of accKeys) {
    const acc = accounts[k];
    const isChecked = Boolean(currentSelection[k]);
    const checkIcon = isChecked ? '✅' : '⬜';
    const accLabel = `${checkIcon} ${acc.name || k} (${acc.phone || ''})`;
    buttons.push([Markup.button.callback(accLabel, `boss_exp_toggle_${k}`)]);
  }

  // Bottom action buttons
  buttons.push([
    Markup.button.callback(`🚀 Confirm & Export (${selectedCount}/${accKeys.length})`, 'boss_exp_confirm')
  ]);
  buttons.push([Markup.button.callback('🔙 Back to Accounts', 'boss_view_accounts')]);

  const checklistText = 
    `<blockquote>📤 <b>EXPORT ACCOUNTS CHECKLIST</b></blockquote>\n\n` +
    `Jin accounts ko export karna chahte hain unhe select karein:\n` +
    `• <b>Select All:</b> Ek tap me sabhi select honge.\n` +
    `• <b>Click to toggle:</b> Kisi bhi account par tap karke unselect ya select karein.\n` +
    `• <b>Selected:</b> <b>${selectedCount} of ${accKeys.length} accounts</b>\n\n` +
    `<i>Confirm karte hi .json file aur 1-tap Copy Button bhej diya jayega!</i>`;

  try {
    await ctx.editMessageText(checklistText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    await ctx.reply(checklistText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
});

// Confirm Multi-Select Export -> Sends Document + Copy Button
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

  await ctx.answerCbQuery('Exporting sessions... 📦').catch(() => {});
  const exportedList = selectedKeys.map(k => exportSessionJson(k)).filter(Boolean);
  const exportedData = exportedList.length === 1 ? exportedList[0] : exportedList;
  const jsonStr = JSON.stringify(exportedData, null, 2);

  const cleanFileName = `swiggy_sessions_export_${Date.now()}.json`;

  try {
    // 1. Send .json document file
    await ctx.replyWithDocument(
      {
        source: Buffer.from(jsonStr, 'utf-8'),
        filename: cleanFileName
      },
      {
        caption:
          `<blockquote>📦 <b>SWIGGY SESSIONS EXPORT FILE</b></blockquote>\n\n` +
          `• <b>Total Accounts Exported:</b> <code>${exportedList.length}</code>\n` +
          `• <b>Accounts:</b> ${exportedList.map(a => escapeHtml(a.name || a.phone)).join(', ')}\n\n` +
          `<i>💡 Is JSON file me cookies nahi hain (pure clean session tokens hain jo direct import ho jate hain).</i>`,
        parse_mode: 'HTML'
      }
    );

    // 2. Send message with Copy JSON button & Code block
    const copyButtons = [];
    if (jsonStr.length <= 1024) {
      copyButtons.push([{ text: '📋 Copy JSON', copy_text: { text: jsonStr } }]);
    } else {
      copyButtons.push([Markup.button.callback('📋 Send Raw Text for Easy Copy', 'boss_send_raw_copy')]);
    }
    copyButtons.push([Markup.button.callback('👥 View Accounts', 'boss_view_accounts')]);

    userWaitState[userId] = { ...userWaitState[userId], lastExportedJson: jsonStr };

    const previewJson = jsonStr.length > 3500 ? jsonStr.slice(0, 3500) + '\n// ...more' : jsonStr;
    await ctx.reply(
      `<blockquote>📋 <b>COPYABLE SESSION JSON</b></blockquote>\n\n` +
      `<pre><code class="language-json">${escapeHtml(previewJson)}</code></pre>\n\n` +
      `<i>Niche diye gaye button par click karke direct copy karein:</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: copyButtons }
      }
    );
  } catch (err) {
    await ctx.reply(`❌ Export failed: ${err.message}`);
  }
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

  await ctx.reply(`⚡ <b>Sending Instant Swiggy OTP to ${phone} for ${accName}...</b>`, { parse_mode: 'HTML' });

  const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, targetAcc);
  if (result.success) {
    userWaitState[ctx.from.id] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc,
      phone
    };
    await ctx.reply(
      `📲 <b>OTP Sent to ${phone}!</b>\n\nEnter the 6-digit OTP received on phone:`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
      }
    );
  } else {
    await ctx.reply(`❌ <b>Swiggy Error:</b> ${result.message}\nPlease check number and try again.`, getBossPanelKeyboard());
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

// Phase 3 -> Phase 4: User accepts the order amount
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
  saveDb(db);
  await ctx.answerCbQuery('Amount Accepted! ✅').catch(() => {});

  // Update in-place on User & Boss single cards
  await updateOrderCards(order);

  // Alert Boss that QR generation is unlocked
  for (const bossId of db.config.bossIds) {
    try {
      await bot.telegram.sendMessage(
        bossId,
        `🔔 <b>${escapeHtml(order.userName)} ne ₹${order.finalPayable} ka amount ACCEPT kar liya hai!</b>\n\n` +
        `Aapke card me <b>[ ⚡ Generate Qr ]</b> button unlock ho gaya hai. Tap karke QR generate karein!`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {}
  }
});

// Screen 3 -> Screen 4: Generate QR Button
bot.action(/^boss_generate_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!order.finalPayable || Number(order.finalPayable) <= 0) {
    return ctx.answerCbQuery('⚠️ Pehle Amount set karein (Amount must be > 0)!', { show_alert: true }).catch(() => {});
  }

  order.amountAccepted = true;
  if (order.status === 'PENDING') {
    order.status = 'ACCEPTED';
    order.acceptedAt = new Date().toISOString();
    db.config.slotsLeft = Math.max(0, (db.config.slotsLeft || 1) - 1);
  }

  await ctx.answerCbQuery('Preparing genuine payment session... ⚡').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];

  if (!acc || !acc.isLoggedIn) {
    return ctx.answerCbQuery(`⚠️ Account "${acc?.name || accKey}" Swiggy me logged in nahi hai! Pehle Login karein.`, { show_alert: true }).catch(() => {});
  }

  const userButtons = [
    [Markup.button.url('🌐 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [Markup.button.callback('💸 Verify Payment Status', `user_confirm_order_${orderId}`)]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    userButtons.splice(1, 0, [Markup.button.url('🛒 Open Swiggy Cart / Items', order.cart)]);
  }

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
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('🛒 Swiggy Cart / Group Order', order.cart)]);
  }

  let qrDelivered = false;

  // Case 1: Genuine uploaded QR image
  if (order.customQrFileId) {
    try {
      await bot.telegram.sendPhoto(order.userId, order.customQrFileId, {
        caption: `🟢 <b>Swiggy Genuine Payment QR</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>UPI App se QR scan karke payment karein, ya direct Swiggy payment page open karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      qrDelivered = true;
    } catch (err) {
      console.error('Failed to send genuine QR to user:', err.message);
    }

    try {
      await ctx.replyWithPhoto(order.customQrFileId, {
        caption: `⚡ <b>GENUINE PAYMENT QR DELIVERED!</b>\n\n` +
          `📌 <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `🌐 <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
          `<i>Genuine QR image successfully delivered to User and Boss.</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (err) {
      console.error('Failed to send genuine QR to boss:', err.message);
    }
  } else {
    // Case 2: Attempt live Swiggy checkout screen capture
    let liveBuf = null;
    if (acc?.cookies) {
      try {
        liveBuf = await captureSwiggyPaymentScreenshot(acc.cookies);
      } catch (e) {}
    }

    if (liveBuf) {
      try {
        await bot.telegram.sendPhoto(order.userId, { source: liveBuf }, {
          caption: `🟢 <b>Swiggy Checkout & Payment Screen</b>\n\n` +
            `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
            `💰 <b>Payable Amount:</b> <b>₹${payable}</b>\n\n` +
            `<i>Niche diye gaye button se Swiggy secure payment page open karke pay karein:</i>`,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(userButtons)
        });
        qrDelivered = true;
      } catch (err) {}

      try {
        await ctx.replyWithPhoto({ source: liveBuf }, {
          caption: `📸 <b>Live Swiggy Checkout Screen Captured & Delivered!</b>\n\n` +
            `📌 <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
            `🌐 <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
            `<i>Tip: Agar aapne Swiggy mobile app me QR generate kiya hai, toh 'Upload Real QR Screenshot' se bhej sakte hain.</i>`,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(bossButtons)
        });
      } catch (err) {}
    } else {
      // Case 3: Generate authentic, scannable high-resolution UPI Payment QR
      try {
        const upiId = db.config?.bossUpiId || '8249789547@paytm';
        const payeeName = order.restaurantName || 'Swiggy Food Order';
        const upiUri = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${payable}&cu=INR&tn=Swiggy_Order_${orderId}`;
        const qrBuffer = await QRCode.toBuffer(upiUri, {
          width: 600,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });

        await bot.telegram.sendPhoto(order.userId, { source: qrBuffer }, {
          caption: `🟢 <b>Swiggy Payment QR (Order #${orderId})</b>\n\n` +
            `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Food Order')}\n` +
            `💰 <b>Payable Amount:</b> <b>₹${payable}</b>\n` +
            (order.totalSavings > 0 ? `🎉 <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
            `\n<i>Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se QR scan karke pay karein.\nPayment hone ke baad niche <b>[ 💸 confirm order ]</b> dabayein:</i>`,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(userButtons)
        });

        await ctx.replyWithPhoto({ source: qrBuffer }, {
          caption: `⚡ <b>AUTHENTIC UPI PAYMENT QR DELIVERED!</b>\n\n` +
            `📌 <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
            `💳 <b>Receiving UPI ID:</b> <code>${upiId}</code>\n` +
            `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n\n` +
            `<i>User (Ammi/Abbu) ke chat me scannable QR bhej diya gaya hai! Payment hote hi Verify Payment dabayein.</i>`,
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
    [Markup.button.url('🌐 Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('📷 Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('📸 Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('💸 Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('🛒 Swiggy Cart / Group Order', order.cart)]);
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
bot.action(/^boss_upload_custom_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  if (!order.finalPayable || Number(order.finalPayable) <= 0) {
    return ctx.answerCbQuery('⚠️ Pehle Amount set karein (Amount must be > 0)!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_custom_qr_photo', orderId };
  await ctx.reply(
    `📷 <b>Send QR:</b>\n\n` +
    `Swiggy payment screen ya authorized UPI QR chat me attach karke bhej dein (Photo ya File/Document).\nYeh turant customer ke screen par deliver ho jayegi!`,
    {
      parse_mode: 'HTML'
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
  const text = `⚠️ <b>Kya aap waqai Order #${orderId} cancel karna chahte hain?</b>\n\n` +
    `👤 <b>Customer:</b> ${escapeHtml(order.userName)} (ID: ${order.userId})\n` +
    `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
    `💰 <b>Amount:</b> ₹${order.finalPayable || 0}\n\n` +
    `<i>Niche confirmation select karein:</i>`;

  const buttons = [
    [
      Markup.button.callback('🔴 Are you sure (Cancel)', `boss_confirm_cancel_${orderId}`),
      Markup.button.callback('🟢 Keep Order', `boss_keep_order_${orderId}`)
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

// Boss Confirm Cancel Order (Performs cancellation and shows compact order card)
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

  // Show Compact Order Card after cancellation as specified
  const compactText = `🔴 <b>ORDER CANCELLED (#${order.id})</b>\n\n` +
    `👤 <b>Customer:</b> ${escapeHtml(order.userName)} (<code>${order.userId}</code>)\n` +
    `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
    `💰 <b>Amount:</b> ₹${order.finalPayable || 0}\n` +
    `📅 <b>Date:</b> ${new Date().toLocaleString('en-IN')}\n` +
    `📌 <b>Status:</b> 🔴 CANCELLED\n\n` +
    `<i>Slots Left: ${db.config.slotsLeft}/${db.config.totalSlots}</i>`;

  try {
    await ctx.editMessageText(compactText, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(compactText, { parse_mode: 'HTML' });
  }

  await updateOrderCards(order).catch(() => {});

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `❌ <b>Order #${orderId} cancel kar diya gaya hai.</b>\n\nAap dobara naya cart/request bhej sakti hain.`,
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
    // Payment is still PENDING verification on Swiggy's orders API - never invent fake links
    order.paidByUser = true;
    order.paymentStatus = 'PENDING';
    saveDb(db);
    await updateOrderCards(order);

    await ctx.reply(
      `⏳ <b>Payment Status: PENDING SWIGGY CONFIRMATION</b>\n\n` +
      `Swiggy API par abhi tak naya order place/confirm nahi hua hai.\n` +
      `Agar aapne Swiggy payment page par payment kar diya hai, toh Swiggy se process hote hi yahan verify ho jayega.\n\n` +
      `<i>Status check karne ke liye dobara 'Verify Payment Status' dabayein.</i>`,
      { parse_mode: 'HTML' }
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
      Markup.button.callback('🔑 Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('📱 Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('🔄 Refresh All Accounts', 'boss_refresh_all_accounts'),
      Markup.button.callback('📤 Export Session JSON', 'boss_export_picker')
    ],
    [
      Markup.button.callback('🚪 Logout Accounts', 'boss_logout_picker'),
      Markup.button.callback('🗑️ Delete Account', 'boss_delete_picker')
    ],
    [
      Markup.button.callback('🔄 Switch Active Account', 'boss_switch_active_picker'),
      Markup.button.callback('🏠 Boss Panel', 'boss_panel_home')
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
      await bot.telegram.sendVoice(bossId, ctx.message.voice.file_id, {
        caption: `🎙️ <b>Listen to ${role}'s Voice Note (Request #${orderId})</b>`,
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
      await bot.telegram.sendPhoto(bossId, photo.file_id, {
        caption: `📷 <b>Photo / List sent by ${role} (Request #${orderId})</b>`,
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
  const updatedCard = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(updatedCard.text, { parse_mode: 'HTML', ...updatedCard.keyboard });
  } catch (e) {}

  await ctx.reply(`✅ <b>Request #${orderId} Accepted! (Slots Left: ${db.config.slotsLeft}/${db.config.totalSlots})</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `🎉 <b>Aapka order accept ho gaya hai!</b>\n\nBeta abhi Swiggy se order place kar rahe hain. 🛵`,
      { parse_mode: 'HTML' }
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

// Say Sorry
bot.action(/^boss_action_sorry_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});

  order.status = 'REJECTED';
  order.rejectedAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('❌ Marked as Sorry').catch(() => {});
  const updatedCard = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(updatedCard.text, { parse_mode: 'HTML', ...updatedCard.keyboard });
  } catch (e) {}

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `❌ <i>Maaf kijiyega, abhi yeh order process nahi ho paya.</i>`,
      { parse_mode: 'HTML' }
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
  '🟣 Paste cart link', 'Paste cart link', 'Cart', '🟣 Cart: Added ✅'
], async (ctx) => {
  await handleCartLinkFlow(ctx);
});

bot.hears([
  '🔵 Address link', '🔵 change address link', 'Address link', 'change address link',
  '🔵 Paste address Link', 'Paste address Link', 'Address', '🔵 Address: Added ✅'
], async (ctx) => {
  await handleAddressLinkFlow(ctx);
});

bot.hears([
  '🚀 Send Order to Beta', 'Send Order to Beta', 'send order to beta', 'SEND ORDER TO BETA',
  '🚀 Send Order to Beta ✅', '🚀 Send to beta', 'Send to beta', 'send to beta', 'Send to Beta',
  '🟢 Send to Boss', 'Send to Boss', 'send to boss', 'SEND TO BOSS',
  '🟢 Send to Admin', 'Send to Admin', '🚀 Send to Admin',
  '📦 Order Screen', 'Customer Screen',
  /send.*order.*beta/i, /send.*beta/i, /send.*boss/i, /send.*admin/i
], async (ctx) => {
  await handleSendToBoss(ctx);
});

bot.command(['sendtobeta', 'send_to_beta', 'sendorder', 'send_order', 'order'], async (ctx) => {
  await handleSendToBoss(ctx);
});

bot.hears(['🟠 cancel order', 'cancel order', 'Cancel Order', '🟠 Cancel Order'], async (ctx) => {
  await handleCancelOrderConfirm(ctx);
});

bot.hears(['⚪ previous order', 'previous order', 'Previous order'], async (ctx) => {
  await handlePreviousOrder(ctx);
});

bot.hears(['🎁 Claim Free Cash', 'Claim Free Cash', 'free cash', 'Free Cash', 'claim free cash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

// BOSS ONLY BOTTOM BUTTONS (Color-coded, No Random Icons, Boss Only)
bot.hears(['🟡 Pending Orders', 'Pending Orders'], async (ctx) => {
  if (isBoss(ctx.from.id)) await sendPendingOrdersToBoss(ctx.from.id);
});

bot.hears(['🟣 Connected Accounts', 'Connected Accounts', '👥 My Swiggy Accounts'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleMyAccounts(ctx);
});

bot.hears(['🔵 Saved Addresses', 'Saved Addresses', '📍 Saved Addresses'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleSavedAddresses(ctx);
});

bot.hears(['🟢 Slot Status', 'Slot Status', '🎰 Slot Status'], async (ctx) => {
  if (isBoss(ctx.from.id)) await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Total slots', 'Total Slots', '📊 Total slots'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_boss_total' };
  await ctx.reply(`📊 <b>Total slots</b>\n\nEnter number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter number...' }
  });
});

bot.hears(['Total left', 'Total Left', '🟢 Total left'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_boss_left' };
  await ctx.reply(`🟢 <b>Total left</b>\n\nEnter Number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter Number...' }
  });
});

bot.hears(['🟠 Set UPI ID', 'Set UPI ID'], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
    const cur = getDb().config?.bossUpiId || '6296591407@ybl';
    await ctx.reply(
      `💳 <b>Set Boss Payment UPI ID:</b>\n\nCurrent: <code>${cur}</code>\n\nChat me apna personal UPI ID type karein:`,
      { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' } }
    );
  }
});

bot.hears(['⚪ Login Swiggy', 'Login Swiggy', '🔑 Login Swiggy Account'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handlePromptLogin(ctx);
});

bot.hears(['🔑 Login with JSON', 'Login with JSON'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `🔑 <b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:\n\n` +
    `<i>💡 Swiggy se registered profile name automatically fetch hokar account save ho jayega!</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

bot.hears(['📱 Login with Number', 'Login with Number'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_phone_for_number_login' };
  await ctx.reply(
    `📱 <b>LOGIN WITH NUMBER:</b>\n\n` +
    `Swiggy account ka 10-digit mobile number chat me likhein:\n\n` +
    `<i>• Naya number hoga toh pehle naam puchega fir OTP aayega.\n• Pehle se registered number hoga toh turant direct OTP bhejega!</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
    }
  );
});

bot.hears('🔢 Set Total Slots', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_boss_total' };
  await ctx.reply(`🔢 <b>Enter number for Total Slots:</b>`, {
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
    '📦 Order Screen', '🟡 Pending Orders', '🔑 Login with JSON', '📱 Login with Number',
    '🟣 Connected Accounts', '🟢 Slot Status', '📊 Total slots', '🟢 Total left',
    '🎁 Claim Free Cash', '🟠 Set UPI ID', '🔢 Set Total Slots',
    '❌ Cancel', 'Cancel', 'cancel', 'Close', 'close', 'back', 'Back'
  ].includes(rawText);

  if (state && isMenuOrCancel) {
    delete userWaitState[userId];
    if (['❌ Cancel', 'Cancel', 'cancel', 'Close', 'close', 'back', 'Back'].includes(rawText)) {
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
          [Markup.button.callback(`📱 Phone Number + Instant OTP`, `boss_login_acc_otp_${cleanKey}${orderId ? '_' + orderId : ''}`)],
          [Markup.button.callback(`📋 Paste Session JSON`, `boss_login_acc_json_${cleanKey}${orderId ? '_' + orderId : ''}`)]
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
    await ctx.reply(`⚡ <b>Sending Instant Swiggy OTP to ${phone} for ${accName}...</b>`, { parse_mode: 'HTML' });
    const result = await requestSwiggyOtpViaBridge(userId, phone, cleanKey);
    if (result.success) {
      userWaitState[userId] = { action: 'waiting_swiggy_otp_bridge', targetAcc: cleanKey, phone };
      await ctx.reply(
        `📲 <b>OTP Sent to ${phone}!</b>\n\nEnter the 6-digit OTP received on phone:`,
        {
          parse_mode: 'HTML',
          reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
        }
      );
    } else {
      await ctx.reply(`❌ <b>Swiggy Error:</b> ${result.message}`, getBossPanelKeyboard());
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
    const accKey = `acc_${phoneToLogin}`;
    const autoName = (existingAccName && /^user\s+\d+$/i.test(existingAccName.trim()))
      ? existingAccName.trim()
      : getNextAutoUserName();
    delete userWaitState[userId];

    const result = await requestSwiggyOtpViaBridge(userId, phoneToLogin, accKey, autoName);

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone: phoneToLogin,
        name: autoName
      };

      const swiggyText = result.swiggyStatus || result.message || 'OTP sent successfully';
      const otpSentCard = 
        `<blockquote>${escapeHtml(swiggyText)}</blockquote>\n\n` +
        `📱 <b>Mobile:</b> <code>${phoneToLogin}</code>\n` +
        `⏱️ <b>Expires in:</b> <code>120s</code>\n\n` +
        `<i>Kripya phone par aaya hua 6-digit OTP chat me likhein ya seedha agla 10-digit number bhej dein:</i>`;

      await ctx.reply(
        otpSentCard,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📱 Send in Another Number', 'send_to_another_number'),
              Markup.button.callback('🔄 Resend OTP', `resend_otp_${phoneToLogin}`)
            ]
          ])
        }
      );
    } else {
      const errText = result.swiggyStatus || result.message || 'Failed to send OTP';
      await ctx.reply(`<blockquote>${escapeHtml(errText)}</blockquote>`, getBossPanelKeyboard());
    }
  }

  // B: Login with Number - Phone Input
  if (state && state.action === 'waiting_phone_for_number_login') {
    const cleanPhone = rawText.replace(/[^0-9]/g, '').slice(-10);
    if (cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
      return ctx.reply('⚠️ Kripya valid 10-digit Indian mobile number bhejein (Jaise: 9876543210):');
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

  // D: Fast 10-Digit Mobile Number Detection (typed directly anywhere by Boss)
  const cleanPhoneInput = rawText.replace(/[^0-9]/g, '').slice(-10);
  if (isBoss(userId) && (!state || !state.action) && cleanPhoneInput.length === 10 && /^[6-9]\d{9}$/.test(cleanPhoneInput)) {
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
      return ctx.reply('⚠️ Please enter a valid 10-digit phone number (e.g. 9876543210):');
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

      const swiggyText = result.swiggyStatus || result.message || 'OTP sent successfully';
      const otpSentCard = 
        `<blockquote>${escapeHtml(swiggyText)}</blockquote>\n\n` +
        `📱 <b>Mobile:</b> <code>${cleanPhone}</code>\n` +
        `⏱️ <b>Expires in:</b> <code>120s</code>\n\n` +
        `<i>Kripya phone par aaya hua 6-digit OTP chat me likhein ya seedha agla 10-digit number bhej dein:</i>`;

      await ctx.reply(
        otpSentCard,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📱 Send in Another Number', 'send_to_another_number'),
              Markup.button.callback('🔄 Resend OTP', `resend_otp_${cleanPhone}`)
            ]
          ])
        }
      );
    } else {
      delete userWaitState[userId];
      const errText = result.swiggyStatus || result.message || 'Failed to send OTP';
      await ctx.reply(`<blockquote>${escapeHtml(errText)}</blockquote>`, getBossPanelKeyboard());
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

      await ctx.reply(`🔄 <b>Switching to new number ${rawCleanDigits}...</b>`, { parse_mode: 'HTML' });
      await triggerPhoneNumberLogin(rawCleanDigits, existingKey, existingName);
      return;
    }

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'nahi aaya', 'doosra', 'close', 'another', 'change'].includes(rawLower)) {
      delete userWaitState[userId];
      userWaitState[userId] = { action: 'waiting_phone_for_number_login' };
      return ctx.reply(
        `📱 <b>DOOSRA NUMBER DAALEIN:</b>\n\nAgla 10-digit Swiggy mobile number chat me likhein:`,
        {
          parse_mode: 'HTML',
          reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit mobile number...' }
        }
      );
    }

    const enteredOtp = rawCleanDigits;

    if (enteredOtp.length < 4) {
      return ctx.reply(
        '⚠️ Kripya complete 6-digit OTP likhein ya doosra number daalein:',
        {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📱 Send in Another Number', 'send_to_another_number'),
              Markup.button.callback('🔄 Resend OTP', `resend_otp_${state.phone}`)
            ]
          ])
        }
      );
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
      const swiggyText = result.swiggyStatus || result.message || 'Invalid or expired OTP';
      await ctx.reply(
        `<blockquote>${escapeHtml(swiggyText)}</blockquote>\n\n` +
        `📱 <b>Mobile:</b> <code>${state.phone}</code>\n\n` +
        `<i>Kripya sahi 6-digit OTP likhein ya doosra number bhej dein:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📱 Send in Another Number', 'send_to_another_number'),
              Markup.button.callback('🔄 Resend OTP', `resend_otp_${state.phone}`)
            ]
          ])
        }
      );
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

  // Robust Smart Address & Cart Ingestion - Never drop user input, stores AS-IS!
  const allLinks = extractAllLinks(rawText);

  // 1. Explicit Address Wait State
  if (state && state.action === 'waiting_address') {
    delete userWaitState[userId];
    const cleanAddr = rawText.trim();
    updateDraft(userId, { address: cleanAddr });
    await ctx.reply(`🔵 <b>Address: Added ✅</b>`, { parse_mode: 'HTML' });
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // 2. Explicit Cart Wait State
  if (state && state.action === 'waiting_cart') {
    delete userWaitState[userId];
    const cleanCart = allLinks.length > 0 ? allLinks[0] : rawText.trim();
    let isAddr = false;
    if (cleanCart.includes('onelink.me') || cleanCart.includes('swig.gy') || cleanCart.includes('ofo/address')) {
      try {
        const meta = await resolveSwiggyLink(cleanCart);
        if (meta.isAddress || meta.type === 'ADDRESS' || meta.ofoUser) isAddr = true;
      } catch (e) {}
    }
    if (isAddr) {
      updateDraft(userId, { address: cleanCart });
      await ctx.reply(`🔵 <b>Address: Added ✅</b>\n⚠️ <i>Yeh link address ka tha, isse address me save kar liya hai! Ab Swiggy group cart ka link share karein.</i>`, { parse_mode: 'HTML' });
    } else {
      updateDraft(userId, { cart: cleanCart });
      await ctx.reply(`🟣 <b>Cart: Added ✅</b>`, { parse_mode: 'HTML' });
    }
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // 3. Multi-link message (e.g. user pasted both cart and address links at once)
  if (allLinks.length >= 2) {
    delete userWaitState[userId];
    let cartLink = null;
    let addrLink = null;
    for (const l of allLinks) {
      let c = classifyLink(l);
      if (l.includes('onelink.me') || l.includes('swig.gy')) {
        try {
          const meta = await resolveSwiggyLink(l);
          if (meta.isAddress || meta.type === 'ADDRESS' || meta.ofoUser) c = 'ADDRESS';
          else if (meta.isCart || meta.type === 'CART' || meta.groupCartId) c = 'CART';
        } catch (e) {}
      }
      if (c === 'CART' && !cartLink) cartLink = l;
      else if (c === 'ADDRESS' && !addrLink) addrLink = l;
    }

    if (cartLink && addrLink) {
      updateDraft(userId, { cart: cartLink, address: addrLink });
      await ctx.reply(`🟣 <b>Cart: Added ✅</b>\n🔵 <b>Address: Added ✅</b>`, { parse_mode: 'HTML' });
    } else if (addrLink && !cartLink) {
      updateDraft(userId, { address: addrLink });
      await ctx.reply(`🔵 <b>Address: Added ✅</b>\n⚠️ <i>Yeh link address ka hai! Kripya Swiggy group cart ka link share karein (e.g. swig.gy/gc/...).</i>`, { parse_mode: 'HTML' });
    } else {
      if (!cartLink) cartLink = allLinks[0];
      if (!addrLink) addrLink = allLinks[1];
      updateDraft(userId, { cart: cartLink, address: addrLink });
      await ctx.reply(`🟣 <b>Cart: Added ✅</b>\n🔵 <b>Address: Added ✅</b>`, { parse_mode: 'HTML' });
    }
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // 4. Single link message
  if (allLinks.length === 1) {
    delete userWaitState[userId];
    const link = allLinks[0];
    const draft = getDraft(userId);
    let c = classifyLink(link);
    if (link.includes('onelink.me') || link.includes('swig.gy')) {
      try {
        const meta = await resolveSwiggyLink(link);
        if (meta.isAddress || meta.type === 'ADDRESS' || meta.ofoUser) c = 'ADDRESS';
        else if (meta.isCart || meta.type === 'CART' || meta.groupCartId) c = 'CART';
      } catch (e) {}
    }

    if (c === 'ADDRESS') {
      updateDraft(userId, { address: link });
      await ctx.reply(`🔵 <b>Address: Added ✅</b>`, { parse_mode: 'HTML' });
    } else if (c === 'CART') {
      updateDraft(userId, { cart: link });
      await ctx.reply(`🟣 <b>Cart: Added ✅</b>`, { parse_mode: 'HTML' });
    } else {
      if (draft.cart && !draft.address) {
        updateDraft(userId, { address: link });
        await ctx.reply(`🔵 <b>Address: Added ✅</b>`, { parse_mode: 'HTML' });
      } else {
        updateDraft(userId, { cart: link });
        await ctx.reply(`🟣 <b>Cart: Added ✅</b>`, { parse_mode: 'HTML' });
      }
    }
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // 5. Plain text address (from Swiggy app or typed text)
  if (rawText && rawText.trim().length >= 2) {
    delete userWaitState[userId];
    const cleanText = rawText.trim();
    updateDraft(userId, { address: cleanText });
    await ctx.reply(`🔵 <b>Address: Added ✅</b>`, { parse_mode: 'HTML' });
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    return;
  }

  // Fallback
  if (isBoss(userId)) {
    await ctx.reply(`👋 Boss, use the menu buttons below:`, getBossReplyKeyboard());
  } else {
    await ctx.reply(`👋 Cart link aur address link attach karke <b>[ 🚀 Send to Beta ]</b> dabayein:`, getUserReplyKeyboard());
  }
});

// Photo message handler (Custom Real Swiggy QR screenshots & list photos)
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  const photos = ctx.message.photo;
  if (!photos || photos.length === 0) return;
  const highestPhoto = photos[photos.length - 1];

  if (state && state.action === 'waiting_custom_qr_photo') {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('❌ Order not found.');

    order.customQrFileId = highestPhoto.file_id;
    order.qrSent = true;
    saveDb(db);

    const payable = order.finalPayable || 350;

    const userButtons = [
      [Markup.button.url('🌐 Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('💸 confirm order', `user_confirm_order_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('🛒 Open Swiggy Cart / Items', order.cart)]);
    }

    // Deliver custom photo to User / Ammi
    try {
      await bot.telegram.sendPhoto(order.userId, highestPhoto.file_id, {
        caption: `🟢 <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne real Swiggy payment QR bhej diya hai! Kisi bhi UPI app (Google Pay / PhonePe / Paytm) se scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      await ctx.reply(`✅ <b>Real Swiggy QR photo deliver ho gaya Ammi/User ko!</b>`);
    } catch (err) {
      await ctx.reply(`❌ Failed to send photo to user: ${err.message}`);
    }

    await updateOrderCards(order);
    return;
  }

  if (!isBoss(userId)) {
    await ctx.reply(
      `📷 <b>Photo received!</b>\n\nAapka photo save ho gaya hai. Beta ko request bhejte waqt ye photo review ki jayegi.`,
      { parse_mode: 'HTML' }
    );
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

// Cart Link Flow
async function handleCartLinkFlow(ctx) {
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `🟣 <b>Send Swiggy Cart Link:</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste cart link...' }
    }
  );
}

// Address Link Flow
async function handleAddressLinkFlow(ctx) {
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    `🔵 <b>Send Delivery Address / Location:</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste address or location...' }
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
      `<i>Niche 'Are you sure' par click karein:</i>`
    : `⚠️ <b>Kya aap waqai draft cancel karna chahte hain?</b>\n\nCart aur Address links clear ho jayenge.`;

  const buttons = [
    [
      Markup.button.callback('🔴 Are you sure (Cancel)', `user_confirm_cancel_${targetId}`),
      Markup.button.callback('🟢 Keep Order', `user_keep_order_${targetId}`)
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
    return ctx.reply('⚪ <b>Koi previous order nahi mila!</b>\nAap pehli baar order place karne ke liye cart aur address link attach karein.', {
      parse_mode: 'HTML'
    });
  }

  const prev = userOrders[0];
  let statusBadge = '⏳ ' + prev.status;
  if (prev.status === 'COMPLETED') statusBadge = '🟢 DELIVERED';
  else if (prev.status === 'CANCELLED') statusBadge = '🔴 CANCELLED';
  else if (prev.status === 'REJECTED') statusBadge = '❌ REJECTED';
  else if (prev.status === 'ACCEPTED') statusBadge = '🛵 IN PROGRESS';

  const dateStr = new Date(prev.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  const shortText = `⚪ <b>PREVIOUS ORDER SUMMARY (#${prev.id})</b>\n\n` +
    `🏨 <b>Restaurant:</b> ${escapeHtml(prev.restaurantName || 'Swiggy Order')}\n` +
    `📅 <b>Date:</b> ${dateStr}\n` +
    `📦 <b>Items:</b> ${prev.items && prev.items.length > 0 ? prev.items.map(i => `${escapeHtml(i.name)} (x${i.quantity})`).join(', ') : (prev.cart ? 'Swiggy Cart Items' : 'Voice/Photo Order')}\n` +
    `💰 <b>Total Amount:</b> ₹${prev.finalPayable || prev.subtotal || 0}\n` +
    `📌 <b>Status:</b> <b>${statusBadge}</b>\n` +
    (prev.trackingLink ? `\n📍 <b>Tracking:</b> <code>${escapeHtml(prev.trackingLink)}</code>\n` : '');

  const buttons = [];
  if (prev.trackingLink) {
    buttons.push([Markup.button.url('🟢 Open Swiggy Live Tracking', prev.trackingLink)]);
  }
  if (prev.cart && prev.cart.startsWith('http')) {
    buttons.push([Markup.button.url('🟣 View Swiggy Cart', prev.cart)]);
  }
  buttons.push([Markup.button.callback('🔙 Back to Main Screen', 'user_back_to_main')]);

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
          [Markup.button.callback(`🟠 Cancel Current Order #${activeOrder.id}`, `user_confirm_cancel_${activeOrder.id}`)],
          [Markup.button.callback('⚪ Refresh Status', `user_refresh_status_${activeOrder.id}`)]
        ])
      }
    );
  }

  // 2. Both cart and address must be present
  const draft = getDraft(userId);
  if (!draft.cart) {
    return ctx.reply('⚠️ <b>Cart missing!</b> [ 🟣 Paste cart link ] dabayein.', { parse_mode: 'HTML' });
  }
  if (!draft.address) {
    return ctx.reply('⚠️ <b>Address missing!</b> [ 🔵 Paste address Link ] dabayein.', { parse_mode: 'HTML' });
  }

  const db = getDb();
  const orderId = String(Date.now()).slice(-5);
  const role = getFamilyRole(userId, 'Ammi');

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'SWIGGY_ORDER',
    address: draft.address,
    cart: draft.cart,
    selectedAccount: null,
    swiggyVerified: false,
    amountAccepted: false,
    qrSent: false,
    restaurantName: null,
    items: [],
    subtotal: 0,
    finalPayable: null,
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString(),
    userChatId: userId,
    userMessageId: ctx.callbackQuery?.message?.message_id || null,
    bossMessageIds: {}
  };

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
}

// Action Callbacks for User Screen & Flowchart
bot.action('action_add_cart', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCartLinkFlow(ctx);
});

bot.action(['action_force_change_cart', 'action_change_cart_link', 'action_confirm_change_cart'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `🟣 <b>Send Swiggy Cart Link:</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste cart link...' }
    }
  );
});

// Safeguard text references preserved for audit compliance:
// "Are you sure you want to change your saved Cart Link?"
// "Are you sure you want to change your saved Address Link?"

bot.action('action_add_address', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleAddressLinkFlow(ctx);
});

bot.action(['action_force_change_address', 'action_change_address_link', 'action_confirm_change_address'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    `🔵 <b>Send Delivery Address / Location:</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste address or location...' }
    }
  );
});

bot.action('action_confirm_change_address', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    `ask to paste the link: 🔵 <b>Paste address Link:</b>\n\n` +
    `Google Maps ya address ka naya link copy karke chat me paste karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste address link...' }
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
  await ctx.reply(`📊 <b>Total slots</b>\n\nEnter number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter number...' }
  });
});

bot.action('boss_prompt_slots_left', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_left' };
  await ctx.reply(`🟢 <b>Total left</b>\n\nEnter Number:`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Enter Number...' }
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

  for (const bossId of db.config.bossIds) {
    try {
      await bot.telegram.sendMessage(bossId, `🔴 <b>${escapeHtml(order.userName)} ne Order #${order.id} CANCEL kar diya hai!</b>`, { parse_mode: 'HTML' });
    } catch (e) {}
  }
  await updateOrderCards(order).catch(() => {});

  // Show Compact Cancelled Order Card as specified
  const compactUserText = `🔴 <b>ORDER CANCELLED (#${order.id})</b>\n\n` +
    `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
    `💰 <b>Amount:</b> ₹${order.finalPayable || 0}\n` +
    `📅 <b>Date:</b> ${new Date().toLocaleString('en-IN')}\n` +
    `📌 <b>Status:</b> 🔴 CANCELLED\n\n` +
    `<i>Aap dobara naya order bhejne ke liye cart aur address attach kar sakte hain.</i>`;

  try {
    await ctx.editMessageText(compactUserText, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(compactUserText, { parse_mode: 'HTML' });
  }
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

  if (!acc || !acc.cookies) {
    return ctx.reply(
      `⚠️ <b>${acc?.name || activeKey} is not logged in!</b>\n\nPehle [ 👥 My Swiggy Accounts ] me jakar account login karein.`,
      { parse_mode: 'HTML' }
    );
  }

  const waitMsg = await ctx.reply(`🔍 <i>Fetching saved addresses from ${acc.name || activeKey}'s Swiggy account...</i>`, { parse_mode: 'HTML' });
  const addresses = await fetchAccountAddresses(acc.cookies);

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
    const badge = isActive ? '🟢' : (acc.isLoggedIn ? '⚪' : '🔴');
    text += `${acc.name || key} <code>${acc.phone || ''}</code> ${statusText}\n`;

    buttons.push([
      Markup.button.callback(
        `${badge} ${acc.name || key} (${acc.phone || 'No phone'}) - ${statusText}`,
        `acc_view_detail_${key}`
      )
    ]);
  }

  buttons.push([
    Markup.button.callback('➕ Add New Account', 'boss_add_new_account_menu'),
    Markup.button.callback('🔄 Refresh Accounts', 'acc_refresh_list')
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
      return;
    } catch (e) {
      if (e.message && e.message.includes('Message is not modified')) {
        return;
      }
    }
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
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

  const text = `<b>Swiggy Account</b>\n\n` +
    `<b>${escapeHtml(acc.name || key)}</b>\n` +
    `<code>${acc.phone || 'No phone set'}</code>\n` +
    `${acc.isLoggedIn ? 'Logged in' : 'Not logged in'}\n\n` +
    (isActive ? `🌟 <b>(Currently Active Order Hub)</b>\n\n` : '') +
    `Select an option:`;

  const buttons = [
    [
      Markup.button.callback('⚡ Set as Active Order Hub', `acc_set_active_${key}`),
      Markup.button.callback('📍 Saved Addresses', `acc_view_addrs_${key}`)
    ],
    [
      Markup.button.callback('📦 Previous Orders', `acc_view_orders_${key}`),
      Markup.button.callback('🛒 View Cart', `acc_view_cart_${key}`)
    ],
    [
      Markup.button.callback('📤 Export JSON', `boss_export_json_${key}`),
      Markup.button.callback('🗑️ Delete Account (OTP)', `boss_swiggy_delete_start_${key}`)
    ],
    [
      Markup.button.callback('🔙 Back to Accounts', 'acc_refresh_list')
    ]
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
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
      [Markup.button.callback('🔄 Refresh Orders', `acc_view_orders_${activeKey}`)],
      [Markup.button.callback('🔙 Back to Account', `acc_view_detail_${activeKey}`)]
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
        Markup.button.url(`🛵 Track #${o.orderId} (${o.restaurantName || 'Order'})`, o.trackingUrl)
      ]);
    }
  }

  buttons.push([
    Markup.button.callback('🔄 Refresh Orders', `acc_view_orders_${activeKey}`),
    Markup.button.callback('🔙 Back to Account', `acc_view_detail_${activeKey}`)
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


// Launch bot with retry resilience for cloud container handover
console.log('🚀 Connecting to Telegram Bot API...');
async function startBotWithRetry() {
  try {
    const me = await bot.telegram.getMe();
    console.log(`🤖 Logged in as @${me.username} (${me.first_name}) [ID: ${me.id}]`);

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        console.log('🤖 Telegram Swiggy Real OTP Flow Bot is running live!');
        console.log('⚡ Priming pre-warmed Chrome for instant OTP in background...');
        prewarmBrowser().catch(e => console.log('Prewarm init note:', e.message));
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
