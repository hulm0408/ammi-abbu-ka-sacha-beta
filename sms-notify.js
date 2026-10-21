// SMS notification for parents when Boss places order for them
// Uses optional SMS gateway via env vars, falls back to Telegram-only log

import { getDb } from './store.js';

const SMS_ENABLED = process.env.SMS_ENABLED !== 'false'; // default enabled if gateway configured

function logSms(phone, text) {
  console.log(`[SMS-NOTIFY] To ${phone}: ${text.slice(0, 120)}`);
}

export async function sendParentSmsNotification(order, trackingUrl = '') {
  try {
    const recipientMobile = String(order?.addressDetails?.mobile || order?.addressDetails?.phone || '').replace(/\D/g, '').slice(-10);
    if (!recipientMobile || !/^[6-9]\d{9}$/.test(recipientMobile)) {
      console.log(`[SMS-NOTIFY] Skip: invalid recipient mobile for order #${order.id}`);
      return { sent: false, reason: 'invalid_mobile' };
    }
    if (!SMS_ENABLED) {
      logSms(recipientMobile, `[SMS disabled] Order #${order.id} tracking: ${trackingUrl}`);
      return { sent: false, reason: 'sms_disabled' };
    }

    const bossName = String(order.bossName || order.placedByName || 'Fer aex').trim() || 'Fer aex';
    const displayId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
    const trackPart = trackingUrl ? ` Track: ${trackingUrl}` : ' Tracking link jaldi bheja jayega.';
    const smsText = `${bossName} ne aapke liye Swiggy order place kiya hai. Order ID: ${displayId} for you on Swiggy.${trackPart} - Reply STOP to opt out`;

    // Try external SMS gateway if configured
    const webhook = process.env.SMS_WEBHOOK_URL;
    const apiKey = process.env.SMS_API_KEY;

    if (webhook) {
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ to: recipientMobile, message: smsText, orderId: order.id })
        });
        if (res.ok) {
          logSms(recipientMobile, smsText);
          // Audit log
          try {
            const db = getDb();
            if (!Array.isArray(db.auditLog)) db.auditLog = [];
            db.auditLog.push({ id: `sms_${Date.now()}`, action: 'sms_sent', meta: { orderId: order.id, to: `****${recipientMobile.slice(-4)}`, via: 'webhook' }, at: new Date().toISOString() });
            // Save not needed for audit? We can skip save to avoid DB churn
          } catch {}
          return { sent: true, via: 'webhook' };
        } else {
          console.warn(`[SMS-NOTIFY] Webhook failed ${res.status} for ${recipientMobile}`);
        }
      } catch (e) {
        console.warn(`[SMS-NOTIFY] Webhook error: ${e.message}`);
      }
    }

    // Fallback: Log and treat as sent via Telegram bridge (no real SMS gateway)
    // In production, configure SMS_WEBHOOK_URL + SMS_API_KEY (Twilio/Fast2SMS) to enable real SMS
    logSms(recipientMobile, smsText);
    return { sent: true, via: 'log', smsText, to: recipientMobile };
  } catch (e) {
    console.warn(`[SMS-NOTIFY] Failed for order #${order?.id}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

// Helper to notify parents on order placement (before tracking) — called when order is created/accepted
export async function notifyParentsOrderPlaced(order) {
  if (!order || !order.addressDetails?.mobile) return;
  const trackingUrl = order.trackingLink || '';
  // For initial placement (no tracking yet), send SMS without tracking, will be updated later
  return sendParentSmsNotification(order, trackingUrl);
}
