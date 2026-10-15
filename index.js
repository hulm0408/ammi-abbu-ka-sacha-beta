import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
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
  ORDER_STATES
} from './store.js';
import { requestSwiggyOtpViaBridge, verifySwiggyOtpViaBridge } from './swiggy-bridge.js';
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
  claimInstamartFreeCash
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

// User Bottom Menu - Send Order to Beta ALWAYS available on reply keyboard
function getUserReplyKeyboard(draft = {}) {
  const cartLabel = draft?.cart ? '🟣 Cart: Added ✅' : '🟣 Paste cart link';
  const addrLabel = draft?.address ? '🔵 Address: Added ✅' : '🔵 Paste address Link';
  return Markup.keyboard([
    [cartLabel, addrLabel],
    ['🚀 Send Order to Beta', '🟢 Send to Boss'],
    ['🟠 cancel order', '⚪ previous order']
  ]).resize();
}

// Boss Bottom Menu - Includes Send Order to Beta & Order Screen for easy testing
function getBossReplyKeyboard() {
  return Markup.keyboard([
    ['🚀 Send Order to Beta', '📦 Order Screen'],
    ['🟡 Pending Orders', '🟣 Connected Accounts'],
    ['🔵 Saved Addresses', '🟢 Slot Status'],
    ['📊 Total slots', '🟢 Total left'],
    ['🎁 Claim Free Cash', '🟠 Set UPI ID', '⚪ Login Swiggy']
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

// User Screen Generator - Exact 5 buttons from User Diagram
function getUserScreen(userId, user) {
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return formatUserOrderCard(activeOrder);
  }

  const db = getDb();
  const draft = getDraft(userId);
  const slotsLeft = db.config.slotsLeft;
  const totalSlots = db.config.totalSlots;
  const role = getFamilyRole(userId, 'Ammi / Abbu');

  const header = `╔═════════════════════════╗\n   🟡  <b>Slots Left: ${slotsLeft}/${totalSlots}</b>  🟡\n╚═════════════════════════╝`;

  const cartBtnText = draft.cart ? '🟣 Cart: Added ✅' : '🟣 Paste cart link';
  const addressBtnText = draft.address ? '🔵 Address: Added ✅' : '🔵 Paste address Link';

  const inlineButtons = [
    [
      Markup.button.callback(cartBtnText, draft.cart ? 'action_force_change_cart' : 'action_add_cart'),
      Markup.button.callback(addressBtnText, draft.address ? 'action_force_change_address' : 'action_add_address')
    ]
  ];

  const changeRow = [];
  if (draft.cart) {
    changeRow.push(Markup.button.callback('🟣 change cart link', 'action_force_change_cart'));
  }
  if (draft.address) {
    changeRow.push(Markup.button.callback('🔵 change address link', 'action_force_change_address'));
  }
  if (changeRow.length > 0) {
    inlineButtons.push(changeRow);
  }

  const hasValidBoth = Boolean(
    draft.cart &&
    draft.address &&
    classifyLink(draft.cart) === 'CART'
  );

  inlineButtons.push([
    Markup.button.callback(hasValidBoth ? '🚀 Send Order to Beta' : '🚀 Send Order to Beta', 'action_send_to_beta'),
    Markup.button.callback(hasValidBoth ? '🟢 Send to Boss' : '🟢 Send to Boss', 'action_send_to_boss')
  ]);

  inlineButtons.push([
    Markup.button.callback('🟠 cancel order', 'action_cancel_order_confirm'),
    Markup.button.callback('⚪ previous order', 'action_previous_order')
  ]);

  let draftStatus = '';
  if (draft.cart && draft.address) {
    draftStatus = `\n\n✅ <b>Cart: Added | Address: Added</b>\nNiche <b>🟢 Send to Boss</b> ya <b>🚀 Send to beta</b> par click karein.`;
  } else if (draft.cart) {
    draftStatus = `\n\n🟣 <b>Cart: Added ✅</b> <code>${escapeHtml(draft.cart)}</code>\n<i>Ab delivery address link paste karein ya <b>[ 🔵 Paste address Link ]</b> dabayein.</i>`;
  } else if (draft.address) {
    draftStatus = `\n\n🔵 <b>Address: Added ✅</b> <code>${escapeHtml(draft.address)}</code>\n<i>Ab Swiggy cart link paste karein ya <b>[ 🟣 Paste cart link ]</b> dabayein.</i>`;
  }

  const text = `${header}\n\n` +
    `❤️ <b>Khushamdeed ${role}!</b>\n` +
    `Cart link aur Address link attach karke <b>🟢 Send to Boss</b> dabayein:${draftStatus}`;

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
      Markup.button.callback('➕ Add New Account', 'boss_add_new_account_menu'),
      Markup.button.callback('🔑 Login an Account', 'boss_prompt_login')
    ],
    [
      Markup.button.callback('👥 View Accounts', 'boss_view_accounts'),
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
    await bot.telegram.sendMessage(bossId, card.text, {
      parse_mode: 'HTML',
      ...card.keyboard
    });
  }
}

// ================= COMMANDS =================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];

  if (isBoss(userId)) {
    await ctx.reply(`👑 Welcome back, <b>Boss</b>! Swiggy Family Care Mode is active.`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    await ctx.reply(getBossPanelText(), {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
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
      Markup.button.callback('🌸 Login Ammi', 'boss_start_otp_ammi'),
      Markup.button.callback('👴 Login Abbu', 'boss_start_otp_abbu'),
      Markup.button.callback('🧓 Login Dada', 'boss_start_otp_dada')
    ],
    [
      Markup.button.callback('📤 Export Session JSON', 'boss_export_menu'),
      Markup.button.callback('📥 Import / Login via JSON', 'boss_prompt_import')
    ]
  ]);

  await ctx.reply(
    `🔑 <b>Swiggy Account Access & Session Manager:</b>\n\n` +
    `• <b>Fast OTP:</b> Number bhejte hi 1 second ke andar OTP aayega (Pre-warmed Chrome active)\n` +
    `• <b>Auto-Signup:</b> Agar number Swiggy par naya hai toh automatically register karke login hoga\n` +
    `• <b>Session JSON:</b> Bina OTP ke login karna ho ya Mom se Dad me transfer karna ho, JSON use karein!`,
    { parse_mode: 'HTML', ...keyboard }
  );
}

bot.action(/^boss_start_otp_(ammi|abbu|dada)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const acc = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = {
    action: 'waiting_phone_for_otp',
    targetAcc: acc
  };

  const name = acc.charAt(0).toUpperCase() + acc.slice(1);
  await ctx.reply(
    `📱 <b>Enter ${name}'s 10-digit mobile number:</b>\n\n` +
    `<i>(Tip: Aap chat me kabhi bhi seedha 10-digit number likh kar bhej sakte hain!)</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter 10-digit number...' }
    }
  );
});

// Fast OTP Trigger from 1-tap buttons
bot.action(/^boss_fast_otp_(ammi|abbu|dada)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  const cleanPhone = ctx.match[2];
  await ctx.answerCbQuery().catch(() => {});

  const userId = ctx.from.id;
  await ctx.reply(`⚡ <b>Sending Instant Swiggy OTP to ${cleanPhone}...</b>`, { parse_mode: 'HTML' });

  const result = await requestSwiggyOtpViaBridge(userId, cleanPhone, targetAcc);

  if (result.success) {
    userWaitState[userId] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc,
      phone: cleanPhone
    };

    await ctx.reply(
      `📲 <b>OTP Sent to ${cleanPhone}!</b>\n\n` +
      `Please enter the 6-digit OTP received on the phone:`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
      }
    );
  } else {
    delete userWaitState[userId];
    await ctx.reply(`❌ <b>Swiggy Error:</b> ${result.message}\nPlease check the number and try again.`, getBossPanelKeyboard());
  }
});

// Export Session Menu
bot.action('boss_export_menu', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  await ctx.reply(
    `📤 <b>Choose Account to Export Session JSON:</b>\n\n` +
    `Is JSON ko aap Telegram Saved Messages me rakh sakte hain. Kisi bhi waqt bina OTP ke restore kar sakte hain!`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🌸 Export Ammi\'s JSON', 'boss_export_ammi')],
      [Markup.button.callback('👴 Export Abbu\'s JSON', 'boss_export_abbu')],
      [Markup.button.callback('🧓 Export Dada\'s JSON', 'boss_export_dada')],
      [Markup.button.callback('🔙 Back', 'boss_prompt_login')]
    ])
  );
});

bot.action(/^boss_export_(ammi|abbu|dada)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const acc = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const data = exportSessionJson(acc);
  const accName = acc.charAt(0).toUpperCase() + acc.slice(1);

  if (!data) {
    return ctx.reply(`⚠️ <b>${accName}'s account is not logged in yet.</b>\nPehle OTP daal kar ya JSON import karke login karein!`, getBossPanelKeyboard());
  }

  const jsonStr = JSON.stringify(data, null, 2);
  await ctx.reply(
    `📦 <b>[ SESSION BACKUP JSON: ${accName.toUpperCase()} ]</b>\n\n` +
    `<code>${escapeHtml(jsonStr)}</code>\n\n` +
    `<i>💡 Tip: Is block ko copy karke Saved Messages me rakh lein. Agar non-veg ke dar se Ammi se Abbu me switch karna ho, toh bas ye JSON chat me paste kar dena!</i>`,
    { parse_mode: 'HTML', ...getBossPanelKeyboard() }
  );
});

// Prompt Import JSON
bot.action('boss_prompt_import', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_json_import' };
  await ctx.reply(
    `📥 <b>Paste your Swiggy Session JSON here:</b>\n\n` +
    `<i>Saved Messages ya backup se JSON copy karke chat me bhej dein:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

// Apply Import JSON to specific account
bot.action(/^boss_apply_import_(ammi|abbu|dada)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const userId = ctx.from.id;
  const state = userWaitState[userId];
  if (!state || !state.pendingJson) {
    return ctx.reply('⚠️ No session JSON found in memory. Please paste the JSON again.');
  }

  const result = importSessionJson(state.pendingJson, targetAcc);
  delete userWaitState[userId];

  if (result.success) {
    const accName = targetAcc.charAt(0).toUpperCase() + targetAcc.slice(1);
    await ctx.reply(
      `✅ <b>Session Imported Successfully!</b>\n\n` +
      `<b>${accName}</b>'s Swiggy account is now 🟢 <b>Logged In & Active</b>!\n` +
      `📱 Phone: <b>${result.phone || 'Linked'}</b>\n\n` +
      `<i>No OTP was needed. You can now order from ${accName}'s account seamlessly!</i>`,
      { parse_mode: 'HTML', ...getBossPanelKeyboard() }
    );
  } else {
    await ctx.reply(`❌ <b>Import Failed:</b> ${result.message}`, getBossPanelKeyboard());
  }
});

// ================= ACCOUNT SELECTOR IN BOSS CARD =================

// ================= ACCOUNT SELECTOR IN BOSS CARD (FIGJAM FLOW) =================

// Screen 2 -> Open Account Picker
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const db = getDb();
  const ammiLogged = db.config.accounts?.ammi?.isLoggedIn ? '✅' : '';
  const abbuLogged = db.config.accounts?.abbu?.isLoggedIn ? '✅' : '';
  const dadaLogged = db.config.accounts?.dada?.isLoggedIn ? '✅' : '';

  await ctx.reply(
    `👥 <b>Choose Account to order for #${orderId}:</b>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`🌸 Ammi ${ammiLogged}`, `boss_choose_acc_ammi_${orderId}`),
        Markup.button.callback(`👴 Abbu ${abbuLogged}`, `boss_choose_acc_abbu_${orderId}`),
        Markup.button.callback(`🧓 Dada ${dadaLogged}`, `boss_choose_acc_dada_${orderId}`)
      ]
    ])
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

  const accName = acc.charAt(0).toUpperCase() + acc.slice(1);
  await ctx.answerCbQuery(`Selected: ${accName} | Verifying with Swiggy... ⏳`).catch(() => {});

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // Verify real Swiggy cart & items using account cookies (NO FAKE ITEMS)
  const accountData = db.config.accounts?.[acc];
  if (order.cart) {
    const swiggyData = await verifyAndInspectSwiggyLink(order.cart, accountData?.cookies || '');
    if (swiggyData.verified) {
      order.swiggyVerified = true;
      if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
      if (swiggyData.items && swiggyData.items.length > 0) order.items = swiggyData.items;
      if (swiggyData.subtotal > 0) order.subtotal = swiggyData.subtotal;
      if (swiggyData.discountAmount > 0) order.discountAmount = swiggyData.discountAmount;
      if (swiggyData.couponCode) order.bestCoupon = { code: swiggyData.couponCode };
      if (swiggyData.finalPayable > 0) order.finalPayable = swiggyData.finalPayable;
      else if (order.subtotal > 0) order.finalPayable = order.subtotal;
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

  await ctx.reply(
    `🌸 <b>Selected: ${accName}'s Account (Order #${orderId})</b>\n\n` +
    (order.restaurantName ? `🏨 Restaurant: <b>${escapeHtml(order.restaurantName)}</b>\n` : '') +
    (order.swiggyVerified ? `✅ <b>Swiggy Verified:</b> ₹${order.finalPayable}\n` : `ℹ️ Amount: <b>₹${order.finalPayable}</b> (Aap [ 💰 Amount ] se edit kar sakte hain)\n`) +
    `\n<i>User ke card par amount accept ka option dikh raha hai. User ke "Accept Order" karte hi [ ⚡ Generate Qr ] unlock hoga.</i>`,
    { parse_mode: 'HTML' }
  );
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

  // If account has session cookies, run full live verification
  if (acc?.cookies) {
    try {
      const liveData = await inspectCartForAccount(acc.cookies);
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
        order.taxesAndCharges = liveData.taxesAndCharges || 28.31;
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

// Delete account picker
bot.action('boss_delete_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  const buttons = [];
  for (const [k, a] of Object.entries(accounts)) {
    buttons.push([Markup.button.callback(`🗑️ Delete ${a.name || k}`, `boss_confirm_delete_${k}`)]);
  }
  buttons.push([Markup.button.callback('🔙 Cancel', 'boss_view_accounts')]);

  await ctx.reply(
    `🗑️ <b>SELECT ACCOUNT TO DELETE:</b>\n\n` +
    `Jis account ko remove karna chahte hain, uspe tap karein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Confirm delete account
bot.action(/^boss_confirm_delete_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const accName = db.config.accounts?.[key]?.name || key;

  deleteAccount(key);
  await ctx.answerCbQuery(`Deleted ${accName} 🗑️`).catch(() => {});
  await ctx.reply(`🗑️ <b>Account "${accName}" has been removed.</b>`, getBossPanelKeyboard());
});

// Export JSON picker
bot.action('boss_export_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  const buttons = [];
  for (const [k, a] of Object.entries(accounts)) {
    if (a.isLoggedIn) {
      buttons.push([Markup.button.callback(`📤 Export ${a.name || k} (${a.phone || ''})`, `boss_export_json_${k}`)]);
    }
  }
  buttons.push([Markup.button.callback('🔙 Back', 'boss_view_accounts')]);

  if (buttons.length === 1) {
    return ctx.reply('⚠️ No logged in accounts found to export.');
  }

  await ctx.reply(
    `📤 <b>SELECT ACCOUNT TO EXPORT SESSION JSON:</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Export JSON for specific account
bot.action(/^boss_export_json_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const exported = exportSessionJson(key);
  if (!exported) {
    return ctx.answerCbQuery('No active session found', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  const jsonStr = JSON.stringify(exported, null, 2);
  await ctx.reply(
    `📦 <b>[ SESSION BACKUP JSON: ${exported.name.toUpperCase()} ]</b>\n\n` +
    `• 📱 Mobile: <b>${exported.phone}</b>\n` +
    `• 🆔 Customer ID: <code>${exported.customerId || 'Verified'}</code>\n\n` +
    `<code>${escapeHtml(jsonStr)}</code>\n\n` +
    `<i>💡 Save this to your Telegram Saved Messages. You can paste it anytime to restore login without OTP!</i>`,
    { parse_mode: 'HTML' }
  );
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
    } catch (err) {
      console.error('Failed to send genuine QR to user:', err.message);
    }

    try {
      await ctx.replyWithPhoto(order.customQrFileId, {
        caption: `⚡ <b>GENUINE PAYMENT QR DELIVERED!</b>\n\n` +
          `📌 <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
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
      } catch (err) {}

      try {
        await ctx.replyWithPhoto({ source: liveBuf }, {
          caption: `📸 <b>Live Swiggy Checkout Screen Captured & Delivered!</b>\n\n` +
            `📌 <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
            `🌐 <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
            `<i>Tip: Agar aapne Swiggy mobile app me QR generate kiya hai, toh 'Upload Real QR Screenshot' se bhej sakte hain.</i>`,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(bossButtons)
        });
      } catch (err) {}
    } else {
      // Case 3: Official Swiggy payment session link (Swiggy Web API does not provide a dynamic UPI QR in get-payment-options)
      try {
        await bot.telegram.sendMessage(
          order.userId,
          `🟢 <b>Swiggy Official Payment Session</b>\n\n` +
          `🏨 <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `💰 <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `🎉 <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Niche button par tap karke Swiggy secure payment page kholein aur UPI / Card / Netbanking se pay karein:</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(userButtons)
          }
        );
      } catch (err) {}

      try {
        await ctx.reply(
          `⚡ <b>Official Swiggy Payment Link Delivered!</b>\n\n` +
          `📌 <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `🌐 <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
          `ℹ️ <i>Swiggy Desktop Web checkout me dynamic UPI QR code expose nahi hota hai. User direct payment page se linked UPI/Cards se pay kar sakte hain ya aap Swiggy App ka real QR screenshot upload kar sakte hain.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(bossButtons)
          }
        );
      } catch (err) {}
    }
  }

  order.qrSent = true;
  saveDb(db);
  await updateOrderCards(order);
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
    await ctx.reply(
      `📷 <b>PAYMENT DETAILS FOR REQUEST #${orderId}</b>\n\n` +
      `💰 <b>Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
      `🌐 <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
      `<i>Swiggy Web API desktop par dynamic UPI QR code provide nahi karta. User Swiggy page open karke pay kar sakte hain ya aap Swiggy App ka QR screenshot upload kar sakte hain:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      }
    );
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

  const acc = db.config.accounts?.[order.selectedAccount || 'ammi'];
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

  let text = `👥 <b>CONFIGURED SWIGGY ACCOUNTS (${Object.keys(accounts).length}):</b>\n\n`;
  for (const [key, acc] of Object.entries(accounts)) {
    const status = acc.isLoggedIn ? `🟢 Logged In (${acc.phone || 'Ready'})` : '⚪ Not Logged In';
    text += `• <b>${acc.name || key}:</b>\n` +
      `  📌 Status: <b>${status}</b>\n` +
      `  📱 Phone: <code>${acc.phone || 'Not set'}</code>\n` +
      `  🏠 Address: ${acc.address || 'Saved Address'}\n\n`;
  }
  text += `<i>Aap naye accounts independent naam se add kar sakte hain (e.g. Bhai, Chacha, Personal) aur bina kisi limit ke OTP ya JSON se login kar sakte hain!</i>`;

  const buttons = [
    [
      Markup.button.callback('➕ Add New Account', 'boss_add_new_account_menu'),
      Markup.button.callback('🔑 Login via OTP', 'boss_prompt_login')
    ],
    [
      Markup.button.callback('📤 Export Session JSON', 'boss_export_picker'),
      Markup.button.callback('🗑️ Delete Account', 'boss_delete_picker')
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
    selectedAccount: role.toLowerCase() === 'abbu' ? 'abbu' : 'ammi',
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
      await bot.telegram.sendMessage(bossId, card.text, {
        parse_mode: 'HTML',
        ...card.keyboard
      });
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
    selectedAccount: role.toLowerCase() === 'abbu' ? 'abbu' : 'ammi',
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
      await bot.telegram.sendMessage(bossId, card.text, {
        parse_mode: 'HTML',
        ...card.keyboard
      });
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

  // A: Check if message is a JSON Session string (either waiting for import or pasted directly)
  if ((state && state.action === 'waiting_json_import') || (rawText.startsWith('{') && (rawText.includes('cookies') || rawText.includes('tid')))) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed.cookies || parsed.tid) {
        if (state && state.targetAcc) {
          const result = importSessionJson(parsed, state.targetAcc);
          const orderId = state.orderId;
          delete userWaitState[userId];
          if (result.success) {
            const db = getDb();
            const accName = db.config.accounts?.[state.targetAcc]?.name || state.targetAcc;
            if (orderId && db.orders[orderId]) {
              const order = db.orders[orderId];
              order.selectedAccount = state.targetAcc;
              saveDb(db);
              updateOrderCards(order).catch(() => {});
            }
            await ctx.reply(`✅ <b>Session JSON Imported into ${accName}!</b>\nAccount is now logged in without OTP.`, getBossPanelKeyboard());
            return;
          }
        }

        userWaitState[userId] = { action: 'confirm_json_import', pendingJson: parsed };
        const foundPhone = parsed.phone || parsed.mobile || 'Unknown';
        const foundId = parsed.customerId || parsed.userId || 'Detected';

        const db = getDb();
        const accounts = db.config.accounts || {};
        const buttons = [];
        const accList = Object.entries(accounts);
        for (let i = 0; i < accList.length; i += 2) {
          const row = [];
          const [k1, a1] = accList[i];
          row.push(Markup.button.callback(`📥 ${a1.name || k1}`, `boss_apply_import_${k1}`));
          if (accList[i + 1]) {
            const [k2, a2] = accList[i + 1];
            row.push(Markup.button.callback(`📥 ${a2.name || k2}`, `boss_apply_import_${k2}`));
          }
          buttons.push(row);
        }
        buttons.push([Markup.button.callback('➕ Import as New Account', 'boss_apply_import_new')]);

        await ctx.reply(
          `📥 <b>Swiggy Session JSON Detected!</b>\n\n` +
          `• 📱 Mobile: <b>${foundPhone}</b>\n` +
          `• 🆔 Customer ID: <b>${foundId}</b>\n` +
          `• 🔑 Session Cookies / TID: <b>Valid ✅</b>\n\n` +
          `Aap is session ko kiske account me import karna chahte hain? (Bina OTP ke login ho jayega!):`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          }
        );
        return;
      }
    } catch (e) {
      if (state && state.action === 'waiting_json_import') {
        return ctx.reply('⚠️ Invalid JSON format. Please send a valid Swiggy session JSON string.');
      }
    }
  }

  // B: Fast 10-Digit Mobile Number Detection (typed directly anywhere by Boss)
  const cleanPhoneInput = rawText.replace(/[^0-9]/g, '').slice(-10);
  if (isBoss(userId) && (!state || !state.action) && cleanPhoneInput.length === 10 && /^[6-9]\d{9}$/.test(cleanPhoneInput)) {
    userWaitState[userId] = { action: 'choose_acc_for_fast_otp', phone: cleanPhoneInput };
    const db = getDb();
    const accounts = db.config.accounts || {};
    const buttons = [];
    const accList = Object.entries(accounts);
    for (let i = 0; i < accList.length; i += 2) {
      const row = [];
      const [k1, a1] = accList[i];
      row.push(Markup.button.callback(`⚡ ${a1.name || k1}`, `boss_fast_otp_${k1}_${cleanPhoneInput}`));
      if (accList[i + 1]) {
        const [k2, a2] = accList[i + 1];
        row.push(Markup.button.callback(`⚡ ${a2.name || k2}`, `boss_fast_otp_${k2}_${cleanPhoneInput}`));
      }
      buttons.push(row);
    }
    buttons.push([Markup.button.callback(`➕ Send to New Account (${cleanPhoneInput})`, `boss_fast_otp_new_${cleanPhoneInput}`)]);

    await ctx.reply(
      `⚡ <b>Mobile Number Detected: ${cleanPhoneInput}</b>\n\n` +
      `Instant OTP bhejne ke liye account select karein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
      }
    );
    return;
  }

  // Step 1: User entered 10-digit number for Swiggy after prompt
  if (state && state.action === 'waiting_phone_for_otp') {
    const targetAcc = state.targetAcc;
    const cleanPhone = rawText.replace(/[^0-9]/g, '').slice(-10);

    if (cleanPhone.length !== 10) {
      return ctx.reply('⚠️ Please enter a valid 10-digit phone number (e.g. 9876543210):');
    }

    await ctx.reply(`⚡ <b>Sending Instant Swiggy OTP to ${cleanPhone}...</b>`, { parse_mode: 'HTML' });

    const result = await requestSwiggyOtpViaBridge(userId, cleanPhone, targetAcc);

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc,
        phone: cleanPhone
      };

      await ctx.reply(
        `📲 <b>OTP Sent to ${cleanPhone}!</b>\n\n` +
        `Please enter the 6-digit OTP received on the phone:`,
        {
          parse_mode: 'HTML',
          reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
        }
      );
    } else {
      delete userWaitState[userId];
      await ctx.reply(`❌ <b>Swiggy Error:</b> ${result.message}\nPlease check the number and try again.`, getBossPanelKeyboard());
    }
    return;
  }

  // Step 2: User enters 6-digit OTP
  if (state && state.action === 'waiting_swiggy_otp_bridge') {
    const enteredOtp = rawText.replace(/[^0-9]/g, '');

    if (enteredOtp.length < 4) {
      return ctx.reply('⚠️ Please enter the complete 6-digit OTP:');
    }

    await ctx.reply(`⏳ <b>Verifying OTP with Swiggy...</b>`, { parse_mode: 'HTML' });

    const result = await verifySwiggyOtpViaBridge(userId, enteredOtp);

    if (result.success) {
      const orderId = state.orderId;
      delete userWaitState[userId];
      const accName = result.targetAcc.charAt(0).toUpperCase() + result.targetAcc.slice(1);
      const jsonBackupStr = JSON.stringify(result.exportJson || {}, null, 2);

      const db = getDb();
      if (orderId && db.orders[orderId]) {
        const order = db.orders[orderId];
        order.selectedAccount = result.targetAcc;
        saveDb(db);
        updateOrderCards(order).catch(() => {});
      }

      await ctx.reply(
        `✅ <b>Logged In Successfully!</b>\n\n` +
        `🌸 <b>${accName}'s Swiggy account (${result.phone}) is active!</b>\n` +
        `🆔 Customer ID: <code>${result.customerId || 'Verified'}</code>\n\n` +
        (orderId ? `📌 <b>Order #${orderId} is now linked to ${accName}!</b>\n\n` : '') +
        `📦 <b>[ SESSION BACKUP JSON ]</b> (Save to Telegram Saved Messages):\n` +
        `<code>${escapeHtml(jsonBackupStr)}</code>\n\n` +
        `<i>💡 Tip: Is JSON ko apne Saved Messages me rakh lo. Kabhi bhi bina OTP ke login karna ho, bas ye JSON chat me paste kar dena!</i>`,
        { parse_mode: 'HTML', ...getBossPanelKeyboard() }
      );
    } else {
      await ctx.reply(
        `❌ <b>Invalid or Incorrect OTP!</b> (${result.message})\n\n` +
        `Please enter the correct OTP received on your phone:`,
        {
          parse_mode: 'HTML',
          reply_markup: { force_reply: true, input_field_placeholder: 'Enter correct 6-digit OTP...' }
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

  // Smart Multi-Link & Single-Link Detection for User (Cart and/or Address)
  if (!isBoss(userId)) {
    const allLinks = extractAllLinks(rawText);
    if (allLinks.length > 0) {
      delete userWaitState[userId];
      const draft = getDraft(userId);

      let foundCart = null;
      let foundAddr = null;

      // 1. Analyze and classify each link found in text
      for (const l of allLinks) {
        const c = classifyLink(l);
        if (c === 'CART' && !foundCart) foundCart = l;
        else if (c === 'ADDRESS' && !foundAddr) foundAddr = l;
      }

      // 2. Fallbacks based on waiting state if not resolved
      for (const l of allLinks) {
        if (l === foundCart || l === foundAddr) continue;
        if (!foundCart && (state?.action === 'waiting_cart' || l.includes('swiggy') || l.includes('swig.gy'))) {
          foundCart = l;
        } else if (!foundAddr) {
          foundAddr = l;
        }
      }

      if (foundCart) updateDraft(userId, { cart: foundCart });
      if (foundAddr) updateDraft(userId, { address: foundAddr });

      const updatedDraft = getDraft(userId);
      const keyboard = getUserReplyKeyboard(updatedDraft);

      // Branch A: Both links now present! (Diagram: "if any one send both address at once or single bot has to be smart enough to understand which is address and which is cart and ask him now you can send to beta by giving him option")
      if (updatedDraft.cart && updatedDraft.address) {
        await ctx.reply(
          `✅ <b>Cart aur Address donon link save ho gaye!</b>\n\n` +
          `🟣 <b>Cart Link:</b> <code>${escapeHtml(updatedDraft.cart)}</code>\n` +
          `🔵 <b>Address Link:</b> <code>${escapeHtml(updatedDraft.address)}</code>\n\n` +
          `Ab aap niche <b>🟢 Send to beta</b> par click karke beta ko bhej sakte hain:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🟢 Send to beta', 'action_send_to_boss')],
              [
                Markup.button.callback('🟣 change cart link', 'action_force_change_cart'),
                Markup.button.callback('🔵 change address link', 'action_force_change_address')
              ]
            ])
          }
        );
        const screen = getUserScreen(userId, ctx.from);
        await ctx.reply(screen.text, { parse_mode: 'HTML', ...keyboard });
        return;
      }

      // Branch B: Only Cart link present
      if (updatedDraft.cart && !updatedDraft.address) {
        await ctx.reply(
          `🟣 <b>Cart Link Save Ho Gaya!</b>\n<code>${escapeHtml(updatedDraft.cart)}</code>\n\n` +
          `Ab delivery address ka link bhejein ya niche <b>[ 🔵 Address link ]</b> dabayein.\n\n` +
          `📖 <b>Address link kaise nikalein (Short Guide in Hinglish):</b>\n` +
          `1. Google Maps app kholein aur apne ghar ki location select karein.\n` +
          `2. <b>'Share'</b> button par tap karke link copy karein.\n` +
          `3. Copy kiya hua link chat me bhej dein!`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔵 Address link', 'action_add_address')],
              [Markup.button.callback('🟣 change cart link', 'action_force_change_cart')]
            ])
          }
        );
        return;
      }

      // Branch C: Only Address link present
      if (updatedDraft.address && !updatedDraft.cart) {
        await ctx.reply(
          `🔵 <b>Address Link Save Ho Gaya!</b>\n<code>${escapeHtml(updatedDraft.address)}</code>\n\n` +
          `Ab Swiggy cart ka link bhejein ya niche <b>[ 🟣 Cart link ]</b> dabayein.\n\n` +
          `📖 <b>Cart link kaise nikalein (Short Guide in Hinglish):</b>\n` +
          `1. Swiggy app kholein aur items cart me add karein.\n` +
          `2. Cart me <b>'Start a Group Order'</b> ya <b>'Share Cart'</b> se link copy karein.\n` +
          `3. Copy kiya hua link chat me bhej dein!`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🟣 Cart link', 'action_add_cart')],
              [Markup.button.callback('🔵 change address link', 'action_force_change_address')]
            ])
          }
        );
        return;
      }
    }
  }

  // Address prompt fallback (text address without link)
  if (state && state.action === 'waiting_address') {
    delete userWaitState[userId];
    updateDraft(userId, { address: rawText });
    const draft = getDraft(userId);
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(
      `🔵 <b>Address Saved:</b>\n<code>${escapeHtml(rawText)}</code>\n\n` +
      (draft.cart
        ? `✅ <b>Donon links ready hain!</b> Niche <b>🟢 Send to beta</b> dabayein.`
        : `Ab Swiggy cart ka link attach karein ya <b>[ 🟣 Cart link ]</b> dabayein:`),
      { parse_mode: 'HTML', ...screen.keyboard }
    );
    return;
  }

  // Cart prompt fallback
  if (state && state.action === 'waiting_cart') {
    return ctx.reply(
      `⚠️ <b>Valid Swiggy link nahi mila!</b>\n\n` +
      `Kripya Swiggy cart ya group order ka link paste karein (e.g. <code>https://swig.gy/gc/...</code>).`,
      { parse_mode: 'HTML' }
    );
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

  // Fallback
  if (isBoss(userId)) {
    await ctx.reply(`👋 Boss, use the menu buttons below:`, getBossReplyKeyboard());
  } else {
    await ctx.reply(`👋 Aap cart link aur address link attach karke <b>[ 🚀 Send to Beta ]</b> dabayein:`, getUserReplyKeyboard());
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

// Cart Link Flow (FigJam: ask to paste link with Hinglish short guide, or if already present ask to change)
async function handleCartLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);

  if (draft.cart) {
    return ctx.reply(
      `⚠️ <b>Are you sure you want to change your saved Cart Link?</b>\n\n` +
      `Current Cart Link:\n<code>${escapeHtml(draft.cart)}</code>\n\n` +
      `<i>Saved cart link replace karne ke liye confirm karein:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Change Cart Link', 'action_confirm_change_cart')],
          [Markup.button.callback('❌ Keep Current Link', 'action_cancel_change_link')]
        ])
      }
    );
  }

  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `ask to paste the link: 🟣 <b>Paste cart link:</b>\n\n` +
    `📖 <b>Cart link kaise nikalein (Short Guide in Hinglish):</b>\n` +
    `1. Swiggy app kholein aur restaurant se samaan cart me add karein.\n` +
    `2. Cart page par jaakar <b>'Start a Group Order'</b> ya <b>'Share Cart'</b> option par tap karein.\n` +
    `3. Link copy karke chat me paste kar dein!\n\n` +
    `<i>Swiggy cart link chat me paste karein:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste cart link...' }
    }
  );
}

// Address Link Flow (FigJam: ask to paste link with Hinglish short guide, or if already present ask to change)
async function handleAddressLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);

  if (draft.address) {
    return ctx.reply(
      `⚠️ <b>Are you sure you want to change your saved Address Link?</b>\n\n` +
      `Current Address Link:\n<code>${escapeHtml(draft.address)}</code>\n\n` +
      `<i>Saved address link replace karne ke liye confirm karein:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Change Address Link', 'action_confirm_change_address')],
          [Markup.button.callback('❌ Keep Current Link', 'action_cancel_change_link')]
        ])
      }
    );
  }

  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    `ask to paste the link: 🔵 <b>Paste address Link:</b>\n\n` +
    `📖 <b>Address link kaise nikalein (Short Guide in Hinglish):</b>\n` +
    `1. Google Maps app kholein aur apne ghar ki location chunein.\n` +
    `2. <b>'Share'</b> button par tap karke link copy karein.\n` +
    `3. Copy kiya hua link chat me paste kar dein!\n\n` +
    `<i>Google Maps ya Address link chat me paste karein:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste address link...' }
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

  // 2. Both links must be present and valid
  const draft = getDraft(userId);
  if (!draft.cart) {
    return ctx.reply('⚠️ <b>Pehle Cart Link attach karein!</b> Niche <b>[ 🟣 Cart link ]</b> dabayein.', { parse_mode: 'HTML' });
  }
  if (!draft.address) {
    return ctx.reply('⚠️ <b>Delivery Address link attach karein!</b> Niche <b>[ 🔵 Address link ]</b> dabayein.', { parse_mode: 'HTML' });
  }
  if (classifyLink(draft.cart) !== 'CART') {
    return ctx.reply('⚠️ <b>Aapka Cart Link valid Swiggy link nahi lag raha hai!</b>\nKripya valid Swiggy cart ya group order ka link attach karein.', { parse_mode: 'HTML' });
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
      const bossMsg = await bot.telegram.sendMessage(bossId, bossCard.text, {
        parse_mode: 'HTML',
        ...bossCard.keyboard
      });
      newOrder.bossMessageIds[bossId] = bossMsg.message_id;
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

bot.action(['action_force_change_cart', 'action_change_cart_link'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const draft = getDraft(userId);

  if (draft.cart) {
    return ctx.reply(
      `⚠️ <b>Are you sure you want to change your saved Cart Link?</b>\n\n` +
      `Current Cart Link:\n<code>${escapeHtml(draft.cart)}</code>\n\n` +
      `<i>Pehle se saved cart link ko replace karne ke liye confirm karein:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Change Cart Link', 'action_confirm_change_cart')],
          [Markup.button.callback('❌ Keep Current Link', 'action_cancel_change_link')]
        ])
      }
    );
  }

  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `ask to paste the link: 🟣 <b>Paste cart link:</b>\n\n` +
    `Swiggy app se naya cart/group order link copy karke chat me paste karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste cart link...' }
    }
  );
});

bot.action('action_confirm_change_cart', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_cart' };
  await ctx.reply(
    `ask to paste the link: 🟣 <b>Paste cart link:</b>\n\n` +
    `Swiggy app se naya cart/group order link copy karke chat me paste karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste cart link...' }
    }
  );
});

bot.action('action_add_address', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleAddressLinkFlow(ctx);
});

bot.action(['action_force_change_address', 'action_change_address_link'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const draft = getDraft(userId);

  if (draft.address) {
    return ctx.reply(
      `⚠️ <b>Are you sure you want to change your saved Address Link?</b>\n\n` +
      `Current Address Link:\n<code>${escapeHtml(draft.address)}</code>\n\n` +
      `<i>Pehle se saved address link ko replace karne ke liye confirm karein:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Change Address Link', 'action_confirm_change_address')],
          [Markup.button.callback('❌ Keep Current Link', 'action_cancel_change_link')]
        ])
      }
    );
  }

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
      Markup.button.callback('📦 My Orders', `acc_view_orders_${key}`),
      Markup.button.callback('🛒 View Cart', `acc_view_cart_${key}`)
    ],
    [
      Markup.button.callback('📤 Export JSON', `boss_export_json_${key}`),
      Markup.button.callback('🚪 Permanent Logout', `acc_perm_logout_${key}`)
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

// 3. My Orders
async function handleMyOrders(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    return ctx.answerCbQuery ? ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {}) : ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || !acc.cookies) {
    return ctx.reply(`⚠️ <b>${acc?.name || activeKey} is not logged in!</b>\nPlease login to view recent orders.`);
  }

  const waitMsg = await ctx.reply(`📦 <i>Fetching recent orders from Swiggy for ${acc.name || activeKey}...</i>`, { parse_mode: 'HTML' });
  const orders = await fetchAccountOrders(acc.cookies);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!orders || orders.length === 0) {
    return ctx.reply(`📦 <b>My Orders</b>\n${acc.name || activeKey} • <code>${acc.phone || ''}</code>\n\n<i>No recent orders found on Swiggy.</i>`, { parse_mode: 'HTML' });
  }

  let text = `<b>My Orders</b>\n` +
    `${escapeHtml(acc.name || activeKey)} • <code>${acc.phone || ''}</code>\n\n` +
    `Recent Orders: ${orders.length}\n\n`;

  const buttons = [];
  for (const o of orders) {
    text += `Order #${o.orderId}\n` +
      `<b>${escapeHtml(o.restaurantName || 'Swiggy')} • ${escapeHtml(o.status || 'Delivered')}</b>\n` +
      (o.items && o.items.length > 0 ? `${o.items.join(', ')}\n` : '') +
      (o.deliveryAddress ? `${escapeHtml(o.deliveryAddress)}\n` : '') +
      (o.orderTime ? `${o.orderTime}\n` : '') +
      `₹${o.orderTotal || 0}\n\n`;

    buttons.push([
      Markup.button.url(`🛵 Track #${o.orderId} (${o.restaurantName || 'Order'})`, o.trackingUrl)
    ]);
  }

  buttons.push([
    Markup.button.callback('🔄 Refresh Orders', `acc_view_orders_${activeKey}`)
  ]);

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.hears('📦 My Orders', async (ctx) => handleMyOrders(ctx));
bot.command('orders', async (ctx) => handleMyOrders(ctx));
bot.action(/^acc_view_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleMyOrders(ctx, key);
});

// 4. View Cart
async function handleViewCart(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    return ctx.answerCbQuery ? ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {}) : ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || !acc.cookies) {
    return ctx.reply(`⚠️ <b>${acc?.name || activeKey} is not logged in!</b>\nPlease login with OTP or JSON first.`);
  }

  const waitMsg = await ctx.reply(`🛒 <i>Inspecting live cart & calculating best offers for ${acc.name || activeKey}...</i>`, { parse_mode: 'HTML' });
  const liveCart = await inspectCartForAccount(acc.cookies);

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

bot.catch((err, ctx) => {
  if (err.description && err.description.includes('message is not modified')) {
    return;
  }
  console.warn(`⚠️ Handled bot error [${ctx?.updateType || 'unknown'}]:`, err.message);
});

// Launch bot with retry resilience for cloud container handover
console.log('🚀 Connecting to Telegram Bot API...');
async function startBotWithRetry() {
  try {
    const me = await bot.telegram.getMe();
    console.log(`🤖 Logged in as @${me.username} (${me.first_name}) [ID: ${me.id}]`);

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await bot.launch({ dropPendingUpdates: true });
        console.log('🤖 Telegram Swiggy Real OTP Flow Bot is running live on Railway Cloud!');
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
