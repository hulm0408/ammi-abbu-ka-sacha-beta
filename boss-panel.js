import { Telegraf, Markup } from 'telegraf';
import { getDb, saveDb, isBoss, canTransitionOrder } from './store.js';
import { getStoredSwiggyTrackingUrl } from './swiggy-cart.js';
import {
  esc,
  heading,
  sub,
  field,
  section,
  table,
  divider,
  DIVIDER,
} from './rich-text.js';

const PUBLIC_SERVICE_URL = (process.env.RENDER_EXTERNAL_URL || 'https://ammi-abbu-ka-sacha-beta.onrender.com').replace(/\/+$/, '');



// Show an alert popup to Boss when something goes wrong
export async function bossAlert(ctx, message) {
  return ctx.answerCbQuery(String(message), { show_alert: true }).catch(() => {});
}

// Clean short address preview for cards
function addrPreview(order) {
  const ad = order.addressDetails || {};
  if (ad.unresolvableShortLink) return 'Address link unresolved — send a fresh link/pin';
  if (ad.address) {
    const a = String(ad.address);
    return a.length > 45 ? a.slice(0, 45) + '…' : a;
  }
  if (ad.city) return `${ad.city} Address`;
  // Never echo a pasted chat block; only a short, address-looking string.
  const raw = String(order.address || '').trim();
  if (!raw) return 'Address not received';
  if (/^https?:\/\//i.test(raw)) return 'Address link received';
  if (/order\s*account|forwarded\s*from|^\s*(?:🧾|📱|🛒)/i.test(raw) || raw.length > 120) return 'Address not verified';
  return raw.length > 45 ? raw.slice(0, 45) + '…' : raw;
}

// Monospace bill table inside a bordered section
function billSection(order) {
  const hasBill = Number(order.subtotal || order.itemTotal || order.finalPayable || 0) > 0 || (Array.isArray(order.items) && order.items.length > 0);
  if (!hasBill) {
    return section('Final Bill', sub('Calculating max coupon and final bill — items not loaded yet'));
  }
  const rows = [['Final Bill', '']];
  rows.push(['Items Total', `₹${Number(order.subtotal || 0)}`]);
  if (order.tradeDiscountTotal > 0) rows.push(['Restaurant Offer Discount', `−₹${Number(order.tradeDiscountTotal)}`]);
  if (order.couponCode && order.discountAmount > 0) {
    rows.push([`Coupon ${esc(order.couponCode)}`, `−₹${Number(order.discountAmount)}`]);
  }
  if (Number(order.swiggyOneMembershipFee || 0) > 0) {
    rows.push(['Swiggy One Lite Membership', `+₹${Number(order.swiggyOneMembershipFee)}`]);
  }
  if (order.freeCashApplied > 0) rows.push(['Swiggy Money / Free Cash', `−₹${Number(order.freeCashApplied)}`]);
  const savedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
  const isFreeDel =
    Number(order.deliveryFee || 0) <= 0 &&
    (order.swiggyOneApplied || savedDel > 0 || Number(order.swiggyOneMembershipFee || 0) > 0 || order.freeDelivery);
  if (isFreeDel) {
    rows.push(['Free Delivery upto 7km', `Delivery Fee: FREE${savedDel > 0 ? ` (₹${savedDel} saved)` : ''}`]);
  } else if (Number(order.deliveryFee || 0) > 0) {
    rows.push(['Delivery Fee', `₹${Number(order.deliveryFee)}`]);
  } else {
    rows.push(['Delivery Fee', 'FREE']);
  }
  if (order.packingCharges > 0) rows.push(['Packing Charges', `₹${Number(order.packingCharges)}`]);
  if (order.taxesAndCharges > 0) rows.push(['GST & Other Charges', `₹${Number(order.taxesAndCharges)}`]);
  if (order.totalSavings > 0) rows.push(['Total Savings', `₹${Number(order.totalSavings)}`]);
  rows.push([`<b>Final Total</b>`, `<b>₹${Number(order.finalPayable || order.subtotal || 0)}</b>`]);
  rows.push(['Payment Options', 'UPI QR, Card, Wallet via Swiggy']);
  return section('Final Bill', table(rows));
}

// ---------------------------------------------------------------------------
// Dashboard helpers — every order row always answers three questions:
//   1. What is the real Swiggy order id?  2. Where is its tracking link?
//   3. Which Swiggy phone number placed it?
// ---------------------------------------------------------------------------
export function swiggyOrderIdOf(order) {
  const raw = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || '').trim();
  return /^\d{10,20}$/.test(raw) ? raw : '';
}

export function placedFromPhoneOf(order, db) {
  const direct = String(
    order?.selectedAccountPhone ||
    order?.orderAccountPhone ||
    order?.placedFromPhone ||
    order?.pendingQrAddressAccount ||
    ''
  ).trim();
  if (direct) return direct.replace(/^\+?91/, '').replace(/\D/g, '').slice(-10) || direct;
  const accKey = order?.selectedAccount;
  const acc = accKey ? db?.config?.accounts?.[accKey] : null;
  const phone = String(acc?.phone || acc?.mobile || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);
  return phone || '';
}

function trackingLineOf(order, { short = false } = {}) {
  const url = getStoredSwiggyTrackingUrl(order);
  if (url) return `<a href="${esc(url)}">${short ? 'Open live tracking' : esc(url)}</a>`;
  const status = String(order?.liveOrderStatus || '').toLowerCase();
  if (/delivered|cancelled|refund/i.test(status)) return `<i>Not needed — ${esc(order.liveOrderStatus)}</i>`;
  return '<i>⏳ Waiting for Swiggy share link — auto-fetching</i>';
}

function safeOrderList(db) {
  return Object.values(db.orders || {}).filter(o => {
    if (!o || typeof o !== 'object') return false;
    // Ignore placeholder/test rows and anything without a real order reference.
    if (String(o.id || '').toUpperCase() === 'TEST') return false;
    return Boolean(o.id);
  });
}

export function buildBossTrackerHome(db) {
  const orders = safeOrderList(db);
  const pending = orders.filter(o => o.status === 'PENDING').length;
  const accepted = orders.filter(o => o.status === 'ACCEPTED').length;
  const completed = orders.filter(o => o.status === 'COMPLETED' || o.swiggyOrderId).length;
  const accounts = Object.entries(db.config?.accounts || {});
  const loggedIn = accounts.filter(([, a]) => a && (a.isLoggedIn || a.cookies || a.tid)).length;
  const doneOrders = orders.filter(o => o.status === 'COMPLETED');
  const tracked = doneOrders.filter(o => Boolean(getStoredSwiggyTrackingUrl(o))).length;

  const text = section('📊 Dashboard — Orders & Tracking', [
    `<b>Swiggy IDs:</b> ${loggedIn} logged in${accounts.length > loggedIn ? ` · ${accounts.length - loggedIn} need login` : ''}`,
    `<b>Orders:</b> ${orders.length} · Pending ${pending} · In progress ${accepted} · Done ${completed}`,
    `<b>Tracking links:</b> ${tracked} live${doneOrders.length > tracked ? ` · ${doneOrders.length - tracked} pending` : ''}`,
    '',
    sub('Every order below shows its Swiggy order id, the phone that placed it, and its live tracking link.'),
  ].join('\n'));

  return { text, keyboard: Markup.inlineKeyboard([[Markup.button.callback('★ Boss Panel', 'boss_panel_home')]]) };
}

export function buildBossPanelHome(db) {
  const orders = safeOrderList(db);
  const pending = orders.filter(o => o.status === 'PENDING').length;
  const accepted = orders.filter(o => o.status === 'ACCEPTED').length;
  const completed = orders.filter(o => o.status === 'COMPLETED').length;
  const accounts = db.config?.accounts || {};

  let accBody = '';
  let accCount = 0;
  for (const [key, acc] of Object.entries(accounts)) {
    accCount++;
    const status = acc.isLoggedIn ? `● Logged In (${acc.phone || 'Ready'})` : '○ Not Logged In';
    accBody += `<b>${esc(acc.name || key)}:</b> <b>${esc(status)}</b>\n`;
  }

  const text = section('Boss Panel', [
    section('Swiggy Accounts', accBody || sub('No accounts added yet. Tap Login to add.')),
    section('Orders', [
      `<b>Pending:</b> <b>${pending}</b>`,
      `<b>In Progress:</b> <b>${accepted}</b>`,
      `<b>Completed:</b> <b>${completed}</b>`,
    ].join('\n')),
    sub('Manage orders, accounts, and offers from here.'),
  ].join('\n'));

  // Clean minimal Boss Panel — only necessary buttons, all dummy buttons removed
  const keyboard = Markup.inlineKeyboard([
    [
      { text: '📊 Dashboard (ID + Tracking + Phone)', callback_data: 'boss_dashboard' }
    ],
    [
      { text: '🔗 Extract Tracking Link', callback_data: 'boss_extract_tracking_prompt' }
    ],
    [
      { text: '📦 Orders Done', callback_data: 'boss_view_orders_done' },
      { text: '▣ Pending Orders', callback_data: 'boss_view_pending' }
    ],
    [
      { text: '◉ Connected Accounts', callback_data: 'boss_view_accounts' },
      { text: '↻ Refresh Panel', callback_data: 'boss_refresh' }
    ],
    [
      { text: '× Close', callback_data: 'close_menu' }
    ]
  ]);

  return { text, keyboard };
}

/**
 * Dashboard: newest orders first. Each row is a clean block with the real
 * Swiggy order id, the phone that placed it and its live tracking link.
 */
export function buildBossDashboard(db, { limit = 8, onlyMissingTracking = false } = {}) {
  const allOrders = safeOrderList(db)
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  const relevant = onlyMissingTracking
    ? allOrders.filter(o => ['COMPLETED', 'ACCEPTED'].includes(o.status) && !getStoredSwiggyTrackingUrl(o))
    : allOrders;

  const orders = relevant.slice(0, limit);
  const accounts = Object.entries(db.config?.accounts || {});
  const loggedIn = accounts.filter(([, a]) => a && (a.isLoggedIn || a.cookies || a.tid)).length;
  const doneOrders = allOrders.filter(o => o.status === 'COMPLETED');
  const tracked = doneOrders.filter(o => Boolean(getStoredSwiggyTrackingUrl(o))).length;
  const missing = doneOrders.filter(o => !getStoredSwiggyTrackingUrl(o)).length;

  const header = [
    `<b>Swiggy IDs:</b> ${loggedIn} logged in${accounts.length > loggedIn ? ` · ${accounts.length - loggedIn} need login` : ''}`,
    `<b>Orders:</b> ${allOrders.length} total · ${doneOrders.length} confirmed`,
    `<b>Tracking:</b> ${tracked} live${missing ? ` · ${missing} auto-fetching` : ''}`,
  ].join('\n');

  let body = '';
  if (orders.length === 0) {
    body = sub(onlyMissingTracking ? 'Every confirmed order already has its tracking link.' : 'No orders yet.');
  } else {
    body = orders.map((order, index) => {
      const swiggyId = swiggyOrderIdOf(order);
      const phone = placedFromPhoneOf(order, db);
      const amount = Number(order.finalPayable || order.subtotal || 0);
      const customer = String(order.fwdSenderName || order.userName || 'Customer').slice(0, 28);
      const status = String(order.liveOrderStatus || order.status || 'PENDING').slice(0, 34);
      const lines = [
        `<b>${index + 1}. ${swiggyId ? `Swiggy #${esc(swiggyId)}` : `Ref #${esc(String(order.id))}`}</b>`,
        swiggyId ? `▪ <b>Order ref:</b> <code>#${esc(String(order.id))}</code>` : `▪ <b>Swiggy order:</b> <i>not created yet</i>`,
        `▪ <b>Placed from:</b> ${phone ? `<code>${esc(phone)}</code>` : '<i>account not selected</i>'}`,
        `▪ <b>Customer:</b> ${esc(customer)} · <b>₹${amount || 0}</b>`,
        `▪ <b>Status:</b> <code>${esc(status)}</code>`,
        `▪ <b>Tracking:</b> ${trackingLineOf(order, { short: true })}`,
      ];
      return lines.join('\n');
    }).join('\n\n');
  }

  const text = section('📊 Dashboard — Order ID · Tracking · Phone', header) +
    section(onlyMissingTracking ? 'Waiting for tracking' : 'Recent orders', body) +
    (relevant.length > orders.length ? sub(`Showing latest ${orders.length} of ${relevant.length}.`) : '');

  const rows = [];
  for (const order of orders.slice(0, 5)) {
    const url = getStoredSwiggyTrackingUrl(order);
    const swiggyId = swiggyOrderIdOf(order);
    const label = swiggyId ? swiggyId.slice(-6) : String(order.id);
    if (url) {
      rows.push([Markup.button.url(`🔗 Track #${label}`, url)]);
    } else if (['COMPLETED', 'ACCEPTED'].includes(order.status)) {
      rows.push([Markup.button.callback(`🔄 Fetch tracking #${label}`, `boss_track_now_${order.id}`)]);
    }
  }
  rows.push([Markup.button.callback('⚡ Fetch all missing tracking', 'boss_fetch_all_missing')]);
  rows.push([
    Markup.button.callback('↻ Refresh Dashboard', 'boss_dashboard'),
    Markup.button.callback('★ Boss Panel', 'boss_panel_home'),
  ]);

  return { text, keyboard: Markup.inlineKeyboard(rows), summary: { tracked, missing, total: allOrders.length } };
}

// One card per pending order — Boss taps Accept / Reject / Pick Account directly
export function buildBossPendingList(db) {
  const pendingOrders = Object.values(db.orders || {}).filter(o => o.status === 'PENDING');
  const cards = pendingOrders.map(o => buildBossOrderCard(o, db));
  const header = section('✉ Pending Requests', `<b>Count:</b> <b>${pendingOrders.length}</b>`);
  return { header, cards };
}

// Full order detail card — state driven, clean buttons only
export function buildBossOrderCard(order, db = getDb()) {
  let statusBadge = 'Pending';
  if (order.status === 'ACCEPTED') statusBadge = 'Accepted';
  else if (order.status === 'REJECTED') statusBadge = 'Rejected';
  else if (order.status === 'COMPLETED') statusBadge = 'Confirmed';
  else if (order.status === 'CANCELLED') statusBadge = `Cancelled (#${order.id})`;

  const userProfileUrl = `tg://user?id=${order.userId}`;
  const senderLink = `<a href="${userProfileUrl}">${esc(order.userName || 'Customer')}</a>`;
  const idLink = `<a href="${userProfileUrl}">${order.userId}</a>`;

  const paymentNote =
    order.qrSent
      ? `${sub('Status: waiting for user payment')}`
      : order.paymentSentToUser
      ? `${sub('Status: bill sent to customer — awaiting payment confirmation')}`
      : '';

  let text = `${heading(`[ ORDER #${order.id} ] · ${statusBadge}`)}\n`;
  text += section('Ordered By', [
    `<b>Name:</b> ${senderLink}`,
    `<b>User ID:</b> ${idLink}`,
  ].join('\n'));

  // Order identity block — the real Swiggy id, the phone that placed it and the
  // live tracking link. Never a guessed or synthetic id.
  const swiggyOrderId = swiggyOrderIdOf(order);
  const placedFrom = placedFromPhoneOf(order, db);
  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  text += section('Order & Tracking', [
    `<b>Order ref:</b> <code>#${esc(String(order.id))}</code>`,
    `<b>Swiggy order id:</b> ${swiggyOrderId ? `<code>${esc(swiggyOrderId)}</code>` : '<i>not created yet</i>'}`,
    `<b>Placed from:</b> ${placedFrom ? `<code>${esc(placedFrom)}</code>` : '<i>account not selected</i>'}`,
    `<b>Tracking:</b> ${trackingUrl ? `<a href="${esc(trackingUrl)}">Open live Swiggy tracking</a>` : '<i>auto-fetching from Swiggy — will appear here</i>'}`,
  ].join('\n'));

  const ad = order.addressDetails || {};
  if (ad.name || ad.mobile || ad.address) {
    const rLines = [];
    if (ad.name) rLines.push(field('Name', esc(ad.name)));
    if (ad.mobile) rLines.push(`<b>Phone:</b> <code>${esc(ad.mobile)}</code> · <i>delivery contact</i>`);
    if (ad.address) rLines.push(field('Address', esc(ad.address.length>80?ad.address.slice(0,80)+'…':ad.address)));
    if (rLines.length) text += section('Deliver To (Recipient)', rLines.join('\n') + '\n' + sub('Order placed on recipient\'s name & phone — rider will call them, not you.'));
  }
  text += billSection(order);
  text += `${paymentNote}\n`;
  let offerLine = '';
  if (order.autoOptimizeError) {
    offerLine = `\n<b>Auto offers:</b> <i>${esc(order.autoOptimizeError)}</i>`;
  } else if (order.autoOptimized) {
    offerLine = `\n<b>Auto offers:</b> ✓ Best account + max coupon locked${order.orderAccount ? ` (${esc(String(order.orderAccount))})` : ''}`;
  }
  text += section('Cart & Delivery', [
    `<b>Cart:</b> ${order.cart ? `<a href="${esc(order.cart)}">Open cart link</a>` : '<i>Not added</i>'}`,
    field('Deliver to', esc(addrPreview(order))),
    field('Time', new Date(order.createdAt || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })),
  ].join('\n') + offerLine);
  if (order.status === 'COMPLETED') {
    if (!getStoredSwiggyTrackingUrl(order)) {
      text += section('Tracking status', '<i>Swiggy has not published the share link yet — the bot keeps retrying and will post it here automatically.</i>');
    }
    if (order.deliveryOtp) text += section('Delivery OTP', `<code>${esc(String(order.deliveryOtp))}</code> · <i>Share with rider</i>`);
    if (order.deliveryBoyName || order.deliveryBoyMobile) {
      const riderLine = [order.deliveryBoyName?esc(order.deliveryBoyName):'', order.deliveryBoyMobile?`<a href="tel:${esc(order.deliveryBoyMobile)}">${esc(order.deliveryBoyMobile)}</a>`:'' ].filter(Boolean).join(' · ');
      if (riderLine) text += section('Rider', riderLine);
    }
  }

  const rows = [];
  const accounts = db.config?.accounts || {};
  const accEntries = Object.entries(accounts);

  if (order.status === 'PENDING') {
    rows.push([
      Markup.button.callback('★ Auto Max Coupon (Best Account)', `boss_auto_max_coupon_${order.id}`),
      Markup.button.callback('⚙ Auto-Pick Account', `boss_auto_max_coupon_${order.id}`),
    ]);

    if (order.selectedAccount && accounts[order.selectedAccount]) {
      const curAcc = accounts[order.selectedAccount];
      const curPhone = curAcc.phone || curAcc.mobile || curAcc.name || order.selectedAccount;
      rows.push([
        Markup.button.callback(`☎ Active Acc: ${esc(curPhone)} ✓`, `boss_choose_acc_picker_${order.id}`),
        Markup.button.callback('↻ Switch Acc', `boss_choose_acc_picker_${order.id}`),
      ]);
    } else {
      const topAccs = accEntries.slice(0, 6);
      for (let i = 0; i < topAccs.length; i += 2) {
        const row = [];
        const [k1, a1] = topAccs[i];
        const p1 = a1?.phone || a1?.mobile || a1?.name || k1;
        row.push(Markup.button.callback(`☎ Use: ${esc(p1)}`, `boss_select_acc_${order.id}_${k1}`));
        if (topAccs[i + 1]) {
          const [k2, a2] = topAccs[i + 1];
          const p2 = a2?.phone || a2?.mobile || a2?.name || k2;
          row.push(Markup.button.callback(`☎ Use: ${esc(p2)}`, `boss_select_acc_${order.id}_${k2}`));
        }
        rows.push(row);
      }
      if (accEntries.length > 6) {
        rows.push([
          Markup.button.callback(`◉ Choose Other Acc (${accEntries.length} Total)`, `boss_choose_acc_picker_${order.id}`),
        ]);
      }
    }

    rows.push([
      Markup.button.callback('✓ Accept Order', `boss_action_accept_${order.id}`),
      Markup.button.callback('× Reject Order', `boss_action_sorry_${order.id}`),
    ]);
    if (order.cart || order.address) {
      rows.push([
        Markup.button.callback('▤ Copy Cart', `boss_copy_cart_${order.id}`),
        Markup.button.callback('▤ Copy Address', `boss_copy_addr_${order.id}`),
      ]);
    }
    rows.push([Markup.button.callback('✉ Message User', `boss_text_user_${order.id}`)]);
  } else if (order.status === 'ACCEPTED') {
    if (order.selectedAccount && accounts[order.selectedAccount]) {
      const curAcc = accounts[order.selectedAccount];
      const curPhone = curAcc.phone || curAcc.mobile || curAcc.name || order.selectedAccount;
      rows.push([
        Markup.button.callback(`☎ Active Acc: ${esc(curPhone)} ✓`, `boss_choose_acc_picker_${order.id}`),
        Markup.button.callback('↻ Switch Acc', `boss_choose_acc_picker_${order.id}`),
      ]);
    }
    if (order.cart || order.address) {
      rows.push([
        Markup.button.callback('▤ Copy Cart', `boss_copy_cart_${order.id}`),
        Markup.button.callback('▤ Copy Address', `boss_copy_addr_${order.id}`),
      ]);
    }
    rows.push([
      Markup.button.callback('Message user', `boss_text_user_${order.id}`),
      Markup.button.callback('↗ Add Swiggy tracking', `boss_tracking_${order.id}`),
      Markup.button.callback('⌕ Add delivery OTP', `boss_delivery_otp_${order.id}`),
    ]);
    rows.push([
      Markup.button.callback('🔗 Extract Delivery (All IDs)', `fwd_extract_all_${order.id}`),
    ]);
    rows.push([
      Markup.button.callback('✓ Mark done', `boss_action_done_${order.id}`),
      Markup.button.callback('× Reject order', `boss_action_sorry_${order.id}`),
    ]);
  } else {
    rows.push([Markup.button.callback('Message user', `boss_text_user_${order.id}`)]);
    if (order.status === 'COMPLETED') {
      rows.push([
        Markup.button.callback('↗ Add Swiggy tracking', `boss_tracking_${order.id}`),
        Markup.button.callback('⌕ Add delivery OTP', `boss_delivery_otp_${order.id}`),
        Markup.button.callback('✓ Mark done', `boss_action_done_${order.id}`)
      ]);
      if (!trackingUrl) {
        rows.push([Markup.button.callback('🔄 Fetch live tracking now', `boss_track_now_${order.id}`)]);
      }
      rows.push([
        Markup.button.callback('🔗 Extract Delivery (All IDs)', `fwd_extract_all_${order.id}`),
      ]);
    }
    if (order.cart || order.address) {
      rows.push([
        Markup.button.callback('▤ Copy Cart', `boss_copy_cart_${order.id}`),
        Markup.button.callback('▤ Copy Address', `boss_copy_addr_${order.id}`),
      ]);
    }
  }

  rows.push([Markup.button.callback('← Back to Panel', 'boss_refresh')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export function buildBossArchiveList(db) {
  const completedOrders = Object.values(db.orders || {})
    .filter(o => o.status === 'COMPLETED')
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  if (completedOrders.length === 0) {
    return {
      text: section('★ Order History', sub('Abhi tak koi successful order nahi hai.')),
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('← Back to Panel', 'boss_refresh')]]),
    };
  }

  const totalRev = completedOrders.reduce((s, o) => s + (o.finalPayable || 0), 0);
  let text = section('★ Order History (All Completed)', [
    `<b>Total Orders:</b> <b>${completedOrders.length}</b>`,
    `<b>Total Volume:</b> <b>₹${totalRev}</b>`,
  ].join('\n'));

  const rows = [['#', 'Order ID', 'Customer', 'Restaurant', 'Amount', 'Account', 'Done']];
  completedOrders.slice(0, 20).forEach((o, idx) => {
    const accName = o.selectedAccount ? (db.config?.accounts?.[o.selectedAccount]?.name || o.selectedAccount) : 'Default';
    const timeStr = new Date(o.completedAt || o.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    rows.push([
      String(idx + 1),
      `#${o.id}`,
      esc(o.userName || 'Customer'),
      esc(o.restaurantName || 'Swiggy'),
      `₹${o.finalPayable || 0}`,
      esc(accName),
      timeStr,
    ]);
  });
  text += table(rows);

  if (completedOrders.length > 20) {
    text += `\n${sub(`...and ${completedOrders.length - 20} more completed orders.`)}`;
  }

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('↻ Refresh List', 'boss_view_archive')],
      [Markup.button.callback('← Back to Panel', 'boss_refresh')],
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
      text: section('× Cancelled Orders', sub('Koi bhi order cancel ya reject nahi hua hai.')),
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('← Back to Panel', 'boss_refresh')]]),
    };
  }

  const displayOrders = cancelledOrders.slice(0, 15);
  let text = section('× Cancelled Orders List', field('Showing', `${displayOrders.length} of ${cancelledOrders.length}`));

  for (const o of displayOrders) {
    const userProfileUrl = `tg://user?id=${o.userId}`;
    const userLink = `<a href="${userProfileUrl}">${esc(o.userName || 'Customer')}</a>`;
    const idLink = `<a href="${userProfileUrl}">${o.userId}</a>`;
    const timeStr = new Date(o.cancelledAt || o.rejectedAt || o.createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rest = o.restaurantName || o.restaurant || 'N/A';
    const amt = o.finalPayable || o.amount || 0;

    const orderRows = [
      ['Order', `#${o.id} [${o.status}]`],
      ['Customer', `${userLink} (<code>${o.userId}</code>)`],
      ['Restaurant', esc(rest)],
      ['Amount', `₹${amt}`],
      ['Cancelled At', timeStr],
    ];
    if (o.cart) orderRows.push(['Cart', `<a href="${esc(o.cart)}">Open Cart Link</a>`]);
    if (o.address) orderRows.push(['Address', o.address.startsWith('http') ? `<a href="${esc(o.address)}">Open Address Link</a>` : `<code>${esc(o.address)}</code>`]);

    text += section(`▣ Order #${o.id} [${o.status}]`, table(orderRows));
  }

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('↻ Refresh List', 'boss_view_cancelled_orders')],
      [Markup.button.callback('← Back to Panel', 'boss_refresh')],
    ]),
  };
}
