import { Markup } from 'telegraf';
import { getDb, clearDraft, getActiveUserOrder } from './store.js';
import { esc } from './rich-text.js';
import { readChatHandoff, readChatSubmissionGuard } from './swiggy-pro-handoff.js';

/**
 * 4-Topic Progressive Progression System for Ammi & Abbu:
 *   Topic 1: 🛒 Submit Link (Cart + Address link input)
 *   Topic 2: 🧾 Bill & Confirmation (Live bill review & 1-tap customer approval)
 *   Topic 3: 💳 Payment & QR (Personalised UPI QR / direct Swiggy payment)
 *   Topic 4: 🛵 Live Tracking (Swiggy tracking link, delivery OTP, rider status)
 *
 * Each topic button unlocks ONLY when the previous level passes.
 * Finishing all topics returns cleanly to Start (Topic 1).
 */

export const TOPIC_LEVELS = {
  1: { id: 1, name: 'Submit Link', icon: '🛒', shortName: '1. Link' },
  2: { id: 2, name: 'Bill & Confirm', icon: '🧾', shortName: '2. Bill' },
  3: { id: 3, name: 'Payment & QR', icon: '💳', shortName: '3. Pay' },
  4: { id: 4, name: 'Live Tracking', icon: '🛵', shortName: '4. Track' }
};

export function getOrderCurrentTopic(order) {
  if (!order) return 1;

  // Level 4: Tracking (Payment completed or accepted with live tracking)
  if (['COMPLETED', 'ACCEPTED'].includes(order.status)) {
    return 4;
  }

  // Level 3: Payment (Bill approved by customer, payment QR/link ready)
  if (
    order.status === 'PAYMENT_PENDING' ||
    order.paymentSentToUser ||
    order.pendingSwiggyUpiUri ||
    order.realUpiIntentUri ||
    order.customerPaymentMessageId
  ) {
    return 3;
  }

  // Level 2: Bill & Confirmation (Order created, finding offers, awaiting customer approval)
  if (
    order.status === 'APPROVAL_PENDING' ||
    order.cardStage === 'AUTO_SELECTING' ||
    order.cardStage === 'BILL_READY' ||
    order.status === 'PENDING'
  ) {
    return 2;
  }

  return 1;
}

export function buildTopicNavKeyboardRows(currentTopic = 1, orderId = 'draft') {
  const t = Math.max(1, Math.min(4, Math.trunc(Number(currentTopic)) || 1));
  const safeId = String(orderId || 'draft').replace(/[^a-zA-Z0-9_-]/g, '_');
  const names = ['Link', 'Bill', 'Pay', 'Track'];
  return [names.map((name, index) => {
    const topic = index + 1;
    const marker = topic === t ? '▶' : topic < t ? '✓' : '🔒';
    return { text: `${marker} ${name}`, callback_data: `topic_nav_${topic}_${safeId}` };
  })];
}

export function formatTopicProgressBarText(currentTopic = 1) {
  const t = Math.max(1, Math.min(4, Math.trunc(Number(currentTopic)) || 1));
  return `<b>Step ${t}/4 · ${TOPIC_LEVELS[t].name}</b>\n`;
}

export async function handleTopicNavClick(ctx, targetTopicNum, orderIdArg, { getUserScreenFn, formatUserOrderCardFn } = {}) {
  const userId = ctx.from.id;
  const targetTopic = Number(targetTopicNum);
  if (!Number.isInteger(targetTopic) || targetTopic < 1 || targetTopic > 4) {
    return ctx.answerCbQuery('Step unavailable.', { show_alert: true }).catch(() => {});
  }
  const db = getDb();

  let order = null;
  if (orderIdArg && orderIdArg !== 'draft') {
    order = db.orders?.[orderIdArg] || Object.values(db.orders || {}).find(o => String(o.id) === String(orderIdArg));
    // A forwarded or stale keyboard must not expose another user's order.
    if (!order || String(order.userId) !== String(userId)) {
      return ctx.answerCbQuery('Order unavailable.', { show_alert: true }).catch(() => {});
    }
  } else {
    order = getActiveUserOrder(userId);
  }

  const currentTopic = getOrderCurrentTopic(order);

  // If clicked a locked topic, show alert explaining why it's locked
  if (targetTopic > currentTopic) {
    const neededStep = targetTopic === 2
      ? 'Cart aur Address link submit karein'
      : (targetTopic === 3
        ? 'bill check karke "Approve bill" dabayein'
        : 'payment complete karein');
    return ctx.answerCbQuery(`🔒 Topic ${targetTopic} locked hai! Pehle ${neededStep}.`, { show_alert: true }).catch(() => {});
  }

  // If clicking an unlocked / active topic
  if (targetTopic === 1) {
    await ctx.answerCbQuery('✓ Topic 1: Link Submission').catch(() => {});
    if (!order && getUserScreenFn) {
      const scr = getUserScreenFn(userId, ctx.from);
      try { await ctx.editMessageText(scr.text, { parse_mode: 'HTML', ...scr.keyboard }); } catch {}
    } else if (order) {
      await ctx.reply(
        `<b>Order #${esc(order.id)}</b>\n` +
        `<b>Cart:</b> ${esc(order.cart || 'Not available')}\n` +
        `<b>Address:</b> ${esc(order.addressDetails?.address || order.address || 'Not available')}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return;
  }

  if (targetTopic === 2) {
    await ctx.answerCbQuery('✓ Topic 2: Bill & Confirmation').catch(() => {});
    if (order && formatUserOrderCardFn) {
      const card = formatUserOrderCardFn(order);
      try { await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }); } catch {}
    }
    return;
  }

  if (targetTopic === 3) {
    await ctx.answerCbQuery('✓ Topic 3: Payment & QR').catch(() => {});
    if (order && formatUserOrderCardFn) {
      const card = formatUserOrderCardFn(order);
      try { await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }); } catch {}
    }
    return;
  }

  if (targetTopic === 4) {
    await ctx.answerCbQuery('✓ Topic 4: Live Tracking').catch(() => {});
    if (order && formatUserOrderCardFn) {
      const card = formatUserOrderCardFn(order);
      try { await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }); } catch {}
    }
    return;
  }
}

export function resetOrderTopicsToStart(userId) {
  // Navigating away is not proof that an order completed. Preserve an open
  // order or transferred draft instead of erasing it or inventing a status.
  if (getActiveUserOrder(userId) || readChatHandoff(userId) || readChatSubmissionGuard(userId)) return false;
  clearDraft(userId);
  return true;
}
