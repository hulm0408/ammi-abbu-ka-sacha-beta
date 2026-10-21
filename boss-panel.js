import { Telegraf } from 'telegraf';
import { getDb, saveDb, isBoss, canTransitionOrder } from './store.js';
import { buildBossAccountsPortalUrl } from './order-ux-portal.js';

const Markup = Telegraf.Markup;

export function esc(str = '') {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Show an alert popup to Boss when something goes wrong
export async function bossAlert(ctx, message) {
  return ctx.answerCbQuery(String(message), { show_alert: true }).catch(() => {});
}

// Clean short address preview for cards
function addrPreview(order) {
  const ad = order.addressDetails || {};
  if (ad && ad.address) {
    const a = String(ad.address);
    return a.length > 45 ? a.slice(0, 45) + '…' : a;
  }
  if (ad && ad.city) return `${ad.city} Address`;
  if (order.address) return String(order.address).slice(0, 45) + (String(order.address).length > 45 ? '…' : '');
  return 'Address not received';
}

// Compact bill block (Swiggy World style) — no circular dep on index.js
function billBlock(order) {
  const lines = [`<b>Final Bill</b>`, `Items Total: ₹${Number(order.subtotal || 0)}`];
  if (order.tradeDiscountTotal > 0) lines.push(`Restaurant Offer Discount: −₹${Number(order.tradeDiscountTotal)}`);
  if (order.couponCode && order.discountAmount > 0) lines.push(`Coupon ${esc(order.couponCode)}: −₹${Number(order.discountAmount)}`);
  if (Number(order.swiggyOneMembershipFee || 0) > 0) lines.push(`Swiggy One Lite Membership: +₹${Number(order.swiggyOneMembershipFee)}`);
  if (order.freeCashApplied > 0) lines.push(`Swiggy Money / Free Cash: −₹${Number(order.freeCashApplied)}`);
  const savedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
  const isFreeDel =
    Number(order.deliveryFee || 0) <= 0 &&
    (order.swiggyOneApplied || savedDel > 0 || Number(order.swiggyOneMembershipFee || 0) > 0 || order.freeDelivery);
  if (isFreeDel) {
    lines.push('Free Delivery upto 7km');
    lines.push(`Delivery Fee: FREE${savedDel > 0 ? ` (₹${savedDel} saved)` : ''}`);
  } else if (Number(order.deliveryFee || 0) > 0) {
    lines.push(`Delivery Fee: ₹${Number(order.deliveryFee)}`);
  } else {
    lines.push('Delivery Fee: FREE');
  }
  if (order.packingCharges > 0) lines.push(`Packing Charges: ₹${Number(order.packingCharges)}`);
  if (order.taxesAndCharges > 0) lines.push(`GST &amp; Other Charges: ₹${Number(order.taxesAndCharges)}`);
  lines.push('━━━━━━━━━━━━━━');
  if (order.totalSavings > 0) lines.push(`Total Savings: ₹${Number(order.totalSavings)}`);
  lines.push(`<b>Final Total: ₹${Number(order.finalPayable || order.subtotal || 0)}</b>`);
  return lines.join('\n');
}

export function buildBossPanelHome(db) {
  const orders = Object.values(db.orders || {});
  const pending = orders.filter(o => o.status === 'PENDING').length;
  const accepted = orders.filter(o => o.status === 'ACCEPTED').length;
  const completed = orders.filter(o => o.status === 'COMPLETED').length;
  const accounts = db.config?.accounts || {};

  let accText = '';
  let accCount = 0;
  for (const [key, acc] of Object.entries(accounts)) {
    accCount++;
    const status = acc.isLoggedIn ? `🟢 Logged In (${acc.phone || 'Ready'})` : '⚪ Not Logged In';
    accText += `• ${esc(acc.name || key)}: <b>${status}</b>\n`;
  }

  const defaultBossId = Number(process.env.BOSS_ID || 6484999726);
  const accMgrUrl = buildBossAccountsPortalUrl(defaultBossId);
  const mgrButton =
    /^https:\/\//i.test(accMgrUrl)
      ? { text: '🔐 Account Manager (OTP + JSON Vault)', web_app: { url: accMgrUrl } }
      : { text: '🔐 Account Manager (OTP + JSON Vault)', url: accMgrUrl };

  const text =
    `👑 <b>BOSS CARE & SWIGGY PANEL</b>\n\n` +
    `👥 <b>Connected Swiggy Accounts (${accCount}):</b>\n` +
    (accText || '<i>No accounts added yet.</i>\n') +
    '\n' +
    `📊 <b>Orders Overview:</b>\n` +
    `• ⏳ Pending: <b>${pending}</b> | 🟢 In Progress: <b>${accepted}</b> | 🏁 Done: <b>${completed}</b>\n\n` +
    `<i>Clean, Apple-style panel. Sab kuch yahin manage kar sakte ho.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [mgrButton],
    [
      { text: '📦 Pending Orders', callback_data: 'boss_view_pending' },
      { text: '🗑️ Cancelled Orders', callback_data: 'boss_view_cancelled_orders' },
    ],
    [
      { text: '📜 Order History', callback_data: 'boss_view_archive' },
      { text: '👤 View Accounts', callback_data: 'boss_view_accounts' },
    ],
    [
      { text: '🎁 Claim Offers (All Accounts)', callback_data: 'boss_claim_all_event_offers' },
      { text: '⚡ Refresh Panel', callback_data: 'boss_refresh' },
    ],
    [{ text: '❌ Close Panel', callback_data: 'close_menu' }],
  ]);

  return { text, keyboard };
}

// One card per pending order — Boss taps Accept / Reject / Pick Account directly
export function buildBossPendingList(db) {
  const pendingOrders = Object.values(db.orders || {}).filter(o => o.status === 'PENDING');
  const cards = pendingOrders.map(o => buildBossOrderCard(o, db));
  const header = `📬 <b>Pending Requests (${pendingOrders.length}):</b>`;
  return { header, cards };
}

// Full order detail card — state driven, clean buttons only
export function buildBossOrderCard(order, db = getDb()) {
  let statusBadge = '⏳ PENDING';
  if (order.status === 'ACCEPTED') statusBadge = '🟢 ACCEPTED';
  else if (order.status === 'REJECTED') statusBadge = '❌ REJECTED';
  else if (order.status === 'COMPLETED') statusBadge = '🏁 ORDER SUCCESS';
  else if (order.status === 'CANCELLED') statusBadge = `🗑️ ORDER CANCELLED (#${order.id})`;

  const userProfileUrl = `tg://user?id=${order.userId}`;
  const senderLink = `<a href="${userProfileUrl}">${esc(order.userName || 'Customer')}</a>`;
  const idLink = `<a href="${userProfileUrl}">${order.userId}</a>`;

  const paymentNote =
    order.qrSent
      ? '\n💳 <i>Status: waiting for user payment</i>\n'
      : order.paymentSentToUser
      ? '\n⏳ <i>Status: bill sent to customer — awaiting payment confirmation</i>\n'
      : '';

  let text =
    `🌸 <b>[ ORDER #${order.id} ] — ${statusBadge}</b>\n\n` +
    `👤 <b>Customer:</b> ${senderLink}\n` +
    `🆔 <b>User ID:</b> ${idLink}\n\n` +
    billBlock(order) +
    '\n' +
    paymentNote +
    `\n🛒 <b>Cart:</b> ${order.cart ? `<a href="${esc(order.cart)}">Open Cart Link</a>` : '<i>Not added</i>'}\n` +
    `📍 <b>Deliver To:</b> ${esc(addrPreview(order))}\n` +
    `⏰ <b>Time:</b> ${new Date(order.createdAt || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n`;

  const rows = [];
  const accounts = db.config?.accounts || {};
  const accEntries = Object.entries(accounts);

  if (order.status === 'PENDING') {
    rows.push([
      Markup.button.callback('🏆 Auto Max Coupon (Best Account)', `boss_auto_max_coupon_${order.id}`),
      Markup.button.callback('🤖 Auto-Pick Account', `boss_auto_max_coupon_${order.id}`),
    ]);

    if (order.selectedAccount && accounts[order.selectedAccount]) {
      const curAcc = accounts[order.selectedAccount];
      const curPhone = curAcc.phone || curAcc.mobile || curAcc.name || order.selectedAccount;
      rows.push([
        Markup.button.callback(`📱 Active Acc: ${esc(curPhone)} ✅`, `boss_choose_acc_picker_${order.id}`),
        Markup.button.callback('🔄 Switch Acc', `boss_choose_acc_picker_${order.id}`),
      ]);
    } else {
      const topAccs = accEntries.slice(0, 6);
      for (let i = 0; i < topAccs.length; i += 2) {
        const row = [];
        const [k1, a1] = topAccs[i];
        const p1 = a1?.phone || a1?.mobile || a1?.name || k1;
        row.push(Markup.button.callback(`📱 Use: ${esc(p1)}`, `boss_select_acc_${order.id}_${k1}`));
        if (topAccs[i + 1]) {
          const [k2, a2] = topAccs[i + 1];
          const p2 = a2?.phone || a2?.mobile || a2?.name || k2;
          row.push(Markup.button.callback(`📱 Use: ${esc(p2)}`, `boss_select_acc_${order.id}_${k2}`));
        }
        rows.push(row);
      }
      if (accEntries.length > 6) {
        rows.push([
          Markup.button.callback(`👥 Choose Other Acc (${accEntries.length} Total)`, `boss_choose_acc_picker_${order.id}`),
        ]);
      }
    }

    rows.push([
      Markup.button.callback('✅ Accept Order', `boss_action_accept_${order.id}`),
      Markup.button.callback('❌ Reject Order', `boss_action_sorry_${order.id}`),
    ]);
    if (order.cart || order.address) {
      rows.push([
        Markup.button.callback('📋 Copy Cart', `boss_copy_cart_${order.id}`),
        Markup.button.callback('📋 Copy Address', `boss_copy_addr_${order.id}`),
      ]);
    }
    rows.push([Markup.button.callback('💬 Message User', `boss_text_user_${order.id}`)]);
  } else if (order.status === 'ACCEPTED') {
    if (order.selectedAccount && accounts[order.selectedAccount]) {
      const curAcc = accounts[order.selectedAccount];
      const curPhone = curAcc.phone || curAcc.mobile || curAcc.name || order.selectedAccount;
      rows.push([
        Markup.button.callback(`📱 Active Acc: ${esc(curPhone)} ✅`, `boss_choose_acc_picker_${order.id}`),
        Markup.button.callback('🔄 Switch Acc', `boss_choose_acc_picker_${order.id}`),
      ]);
    }
    if (order.cart || order.address) {
      rows.push([
        Markup.button.callback('📋 Copy Cart', `boss_copy_cart_${order.id}`),
        Markup.button.callback('📋 Copy Address', `boss_copy_addr_${order.id}`),
      ]);
    }
    rows.push([
      Markup.button.callback('💬 Message User', `boss_text_user_${order.id}`),
      Markup.button.callback('🛵 Send Tracking', `boss_tracking_${order.id}`),
    ]);
    rows.push([
      Markup.button.callback('🟢 Mark Done', `boss_action_done_${order.id}`),
      Markup.button.callback('❌ Reject Order', `boss_action_sorry_${order.id}`),
    ]);
  } else {
    rows.push([Markup.button.callback('💬 Message User', `boss_text_user_${order.id}`)]);
    if (order.cart || order.address) {
      rows.push([
        Markup.button.callback('📋 Copy Cart', `boss_copy_cart_${order.id}`),
        Markup.button.callback('📋 Copy Address', `boss_copy_addr_${order.id}`),
      ]);
    }
  }

  rows.push([Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export function buildBossArchiveList(db) {
  const completedOrders = Object.values(db.orders || {})
    .filter(o => o.status === 'COMPLETED')
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  if (completedOrders.length === 0) {
    return {
      text: `🏆 <b>Order History</b>\n\n<i>Abhi tak koi successful order nahi hai.</i>`,
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]]),
    };
  }

  const totalRev = completedOrders.reduce((s, o) => s + (o.finalPayable || 0), 0);
  let text = `🏆 <b>Order History (All Completed)</b>\n` + `📊 <b>Total Orders:</b> ${completedOrders.length} | 💰 <b>Total Volume:</b> ₹${totalRev}\n\n`;

  completedOrders.slice(0, 20).forEach((o, idx) => {
    const accName = o.selectedAccount ? (db.config?.accounts?.[o.selectedAccount]?.name || o.selectedAccount) : 'Default';
    const timeStr = new Date(o.completedAt || o.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const itemsStr = o.items && o.items.length ? o.items.map(i => `${esc(i.name || 'Item')} x${i.qty || 1}`).join(', ') : 'Swiggy Food Items';
    text += `<b>${idx + 1}. [ #${o.id} ] — ₹${o.finalPayable || 0}</b>\n` +
      `👤 <b>Customer:</b> ${esc(o.userName || 'Customer')} (<code>${o.userId}</code>)\n` +
      `🏪 <b>Restaurant:</b> ${esc(o.restaurantName || 'Swiggy')}\n` +
      `🍽️ <b>Items:</b> ${esc(itemsStr)}\n` +
      `🟣 <b>Account:</b> ${esc(accName)} | ⏰ <b>Done:</b> ${timeStr}\n\n`;
  });

  if (completedOrders.length > 20) {
    text += `<i>...and ${completedOrders.length - 20} more completed orders.</i>\n`;
  }

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh List', 'boss_view_archive')],
      [Markup.button.callback('🔙 Back to Panel', 'boss_refresh')],
    ]),
  };
}

export function buildBossCancelledList(db) {
  const allOrders = Object.values(db.orders || {});
  const cancelledOrders = allOrders
    .filter(o => o.status === 'CANCELLED' || o.status === 'REJECTED')
    .sort((a, b) => new Date(b.cancelledAt || b.rejectedAt || b.createdAt || 0) - new Date(a.cancelledAt || a.rejectedAt || a.createdAt || 0));

  if (cancelledOrders.length === 0) {
    return {
      text: `🗑️ <b>Cancelled Orders</b>\n\n<i>Koi bhi order cancel ya reject nahi hua hai.</i>`,
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Panel', 'boss_refresh')]]),
    };
  }

  const displayOrders = cancelledOrders.slice(0, 15);
  let text = `🗑️ <b>Cancelled Orders List (${displayOrders.length} of ${cancelledOrders.length}):</b>\n` + `────────────────────\n`;

  for (const o of displayOrders) {
    const userProfileUrl = `tg://user?id=${o.userId}`;
    const userLink = `<a href="${userProfileUrl}">${esc(o.userName || 'Customer')}</a>`;
    const idLink = `<a href="${userProfileUrl}">${o.userId}</a>`;
    const timeStr = new Date(o.cancelledAt || o.rejectedAt || o.createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rest = o.restaurantName || o.restaurant || 'N/A';
    const amt = o.finalPayable || o.amount || 0;

    text += `\n📦 <b>Order #${o.id}</b> [${o.status}]\n` +
      `👤 <b>Customer:</b> ${userLink} (TG ID: ${idLink})\n` +
      `🏪 <b>Restaurant:</b> ${esc(rest)}\n` +
      `💰 <b>Amount:</b> ₹${amt}\n` +
      (o.cart ? `🛒 <b>Cart:</b> <a href="${esc(o.cart)}">Open Cart Link</a>\n` : '') +
      (o.address ? `📍 <b>Address:</b> ${o.address.startsWith('http') ? `<a href="${esc(o.address)}">Open Address Link</a>` : `<code>${esc(o.address)}</code>`}\n` : '') +
      `⏰ <b>Cancelled At:</b> ${timeStr}\n` +
      `────────────────────\n`;
  }

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh List', 'boss_view_cancelled_orders')],
      [Markup.button.callback('🔙 Back to Panel', 'boss_refresh')],
    ]),
  };
}
