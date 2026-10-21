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

export function buildBossPanelHome(db) {
  const orders = Object.values(db.orders || {});
  const pending = orders.filter(o => o.status === 'PENDING').length;
  const accepted = orders.filter(o => o.status === 'ACCEPTED').length;
  const completed = orders.filter(o => o.status === 'COMPLETED').length;
  const accounts = db.config?.accounts || {};

  let accBody = '';
  let accCount = 0;
  for (const [key, acc] of Object.entries(accounts)) {
    accCount++;
    const status = acc.isLoggedIn ? `● Logged In (${acc.phone || 'Ready'})` : '○ Not Logged In';
    accBody += `${field(esc(acc.name || key), `<b>${status}</b>`)}\n`;
  }

  const text = section('Boss Panel', [
    section('Swiggy Accounts', accBody || sub('No accounts added yet. Tap Login to add.')),
    section('Orders', [
      field('Pending', `<b>${pending}</b>`),
      field('In Progress', `<b>${accepted}</b>`),
      field('Completed', `<b>${completed}</b>`),
    ].join('\n')),
    sub('Manage orders, accounts, and offers from here.'),
  ].join('\n'));

  const keyboard = Markup.inlineKeyboard([
    [
      { text: '📦 Orders Done (All IDs)', callback_data: 'boss_view_orders_done' },
      { text: '▣ Pending Orders', callback_data: 'boss_view_pending' },
    ],
    [
      { text: '☎ Login with Number', callback_data: 'boss_login_with_number' },
      { text: '▤ Login with JSON', callback_data: 'boss_login_with_json' },
    ],
    [
      { text: '◉ Connected Accounts', callback_data: 'boss_view_accounts' },
      { text: '▤ Order History', callback_data: 'boss_view_archive' },
    ],
    [
      { text: '× Cancelled Orders', callback_data: 'boss_view_cancelled_orders' },
      { text: '▣ Claim Offers (All Accounts)', callback_data: 'boss_claim_all_event_offers' },
    ],
    [
      { text: '↻ Refresh Panel', callback_data: 'boss_refresh' },
      { text: '× Close Panel', callback_data: 'close_menu' },
    ],
  ]);

  return { text, keyboard };
}

// One card per pending order — Boss taps Accept / Reject / Pick Account directly
export function buildBossPendingList(db) {
  const pendingOrders = Object.values(db.orders || {}).filter(o => o.status === 'PENDING');
  const cards = pendingOrders.map(o => buildBossOrderCard(o, db));
  const header = section('✉ Pending Requests', field('Count', `<b>${pendingOrders.length}</b>`));
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
    field('Name', senderLink),
    field('User ID', idLink),
  ].join('\n'));
  const ad = order.addressDetails || {};
  if (ad.name || ad.mobile || ad.address) {
    const rLines = [];
    if (ad.name) rLines.push(field('Name', esc(ad.name)));
    if (ad.mobile) rLines.push(field('Phone', `<code>${esc(ad.mobile)}</code> (delivery contact)`));
    if (ad.address) rLines.push(field('Address', esc(ad.address.length>80?ad.address.slice(0,80)+'…':ad.address)));
    if (rLines.length) text += section('Deliver To (Recipient)', rLines.join('\n') + '\n' + sub('Order placed on recipient\'s name & phone — rider will call them, not you.'));
  }
  text += billSection(order);
  text += `${paymentNote}\n`;
  const offerLine = order.autoOptimizeError
    ? `\n${field('Auto offers', `<i>${esc(order.autoOptimizeError)}</i>`)}`
    : (order.autoOptimized
        ? `\n${field('Auto offers', `✓ Best account + max coupon locked${order.orderAccount ? ` (${esc(String(order.orderAccount))})` : ''}`)}`
        : '');
  text += section('Cart & Delivery', [
    field('Cart', order.cart ? `<a href="${esc(order.cart)}">Open cart link</a>` : '<i>Not added</i>'),
    field('Deliver to', esc(addrPreview(order))),
    field('Time', new Date(order.createdAt || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })),
  ].join('\n') + offerLine);
  if (order.status === 'COMPLETED') {
    const trackingUrl = getStoredSwiggyTrackingUrl(order);
    text += section('Swiggy Tracking', trackingUrl
      ? `<a href="${esc(trackingUrl)}">Open official Swiggy tracking</a>`
      : '<i>Swiggy has not shared a tracking link yet. It will be sent when available.</i>');
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
    field('Total Orders', `<b>${completedOrders.length}</b>`),
    field('Total Volume', `<b>₹${totalRev}</b>`),
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
