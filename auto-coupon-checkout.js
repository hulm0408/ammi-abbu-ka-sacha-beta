// ===== 🤖 AUTO COUPON CHECKOUT MODULE — ek START, apne aap poora batch =====
//
// Checkout par Boss ke liye dedicated module:
//   1. Night / Breakfast event offers (free cash campaign, e.g. ₹50 OFF > ₹199) pre-claim karta hai
//      (`claimSwiggyBreakfastAndLateNightOffers` → events.swiggy.com notify campaign).
//   2. Live Swiggy Cart / Group Cart ko resolve + sync karti hai
//      (`syncGroupCartAndCheckoutForAccount`):
//        → delivery address bind
//        → Swiggy One / One Lite auto (+₹1) free-delivery activation
//        → ALL coupons scan (Swiggy auto-suggested best + MCP + /dapi offers + menu offers + universal promos)
//        → har eligible coupon ko trial me apply & MAXIMUM SAVINGS / MINIMUM finalPayable wala hi jeetta hai
//        → free cash (campaign + Swiggy Money split-pay) + night/breakfast offers ko bill me fold karta hai
//   3. FINAL optimized bill return karta hai — appliedCoupon, discountAmount, freeCashApplied,
//      campaignFreeCash, walletSplitPayAmount, freeDeliveryDiscount, savings, finalPayable, totalSavings.
//
// Selected restaurants:
//   - CLI flag : `--restaurant <id|name>` (id ya name dono support; numeric id → id)
//   - CLI flag : `--restaurant-id <id>` / `--restaurant-name <n>`
//   - Env      : `AUTO_COUPON_RESTAURANT` (single) / `AUTO_COUPON_RESTAURANTS` (comma list)
//   - Default  : koi allowlist nahi set → saari restaurants scan honge.
//
// "Koi cheez roke" nahi — coupon trial loop poora chalta hai, har failure par agla coupon try hota hai,
// aur na hi koi offer ko skip kiya jata (eligible coupons ke alawa explicit selection allowed hai).
//
// Usage:
//   node auto-coupon-checkout.js --account <key> --cart <swiggy cart url> --address "<addr>"
//   node auto-coupon-checkout.js --account <key> --restaurant <id|name> --cart <url> --apply
//   node auto-coupon-checkout.js --help

import {
  getSwiggySessionAuth,
  resolveSwiggyLink,
  parseAddressDetails,
  syncGroupCartAndCheckoutForAccount
} from './swiggy-cart.js';
import { claimSwiggyBreakfastAndLateNightOffers } from './swiggy-bridge.js';
import { getDb } from './store.js';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    help: false,
    apply: false,
    account: '',
    cart: '',
    address: '',
    restaurant: '',
    restaurantId: '',
    restaurantName: '',
    orderId: ''
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--account') out.account = next() || '';
    else if (a === '--cart') out.cart = next() || '';
    else if (a === '--address') out.address = next() || '';
    else if (a === '--restaurant') out.restaurant = next() || '';
    else if (a === '--restaurant-id') out.restaurantId = next() || '';
    else if (a === '--restaurant-name') out.restaurantName = next() || '';
    else if (a === '--order-id') out.orderId = next() || '';
  }
  // `--restaurant <id|name>` → numeric id hai to id bhejo, naam hai to name bhejo.
  if (out.restaurant) {
    const r = String(out.restaurant).trim();
    if (/^\d+$/.test(r)) {
      if (!out.restaurantId) out.restaurantId = r;
    } else if (r) {
      if (!out.restaurantName) out.restaurantName = r;
    }
  }
  return out;
}

const HELP = `
Auto Coupon Checkout Module — checkout par auto coupon scan + max apply + free cash + night offers

  --account <key>          Swiggy account key (e.g. acc_...) ya phone (default: first logged-in from vault)
  --cart <url>             Swiggy cart / group-cart share URL (e.g. https://swig.gy/gc/...)
  --address <text>         Delivery address text (Boss-style receipt / typed address)
  --restaurant <id|name>   Selected restaurant filter (overrides env allowlist for this run)
  --restaurant-id <id>     Force restaurant id
  --restaurant-name <n>    Force restaurant name
  --order-id <id>          Logical order id (default: AUTO_COUPON_<ts>_<rand>)
  --apply                  Capture real Swiggy payment screenshot (QR) after best bill is locked

Env:
  AUTO_COUPON_RESTAURANT     single restaurant id/name to scan
  AUTO_COUPON_RESTAURANTS    comma-separated restaurant allowlist (id|name|slug)

Exit codes: 0 ok, 1 error / not-allowed / failed.
`;

// ---------------------------------------------------------------------------
// selected-restaurant allowlist
// ---------------------------------------------------------------------------
export function getAutoCouponRestaurantAllowlist() {
  const single = String(process.env.AUTO_COUPON_RESTAURANT || '').trim();
  const listRaw = String(process.env.AUTO_COUPON_RESTAURANTS || '').trim();
  const set = new Set();
  if (single) set.add(single);
  for (const part of listRaw.split(',')) {
    const v = String(part || '').trim();
    if (v) set.add(v);
  }
  const list = Array.from(set);
  return list.length ? list : null;
}

export function restaurantInAutoCouponAllowlist(restaurantId, restaurantName, allowlist) {
  const list = allowlist === undefined ? getAutoCouponRestaurantAllowlist() : allowlist;
  if (!list) return true; // default: no allowlist → scan all
  const rid = String(restaurantId || '').trim().toLowerCase();
  const rname = String(restaurantName || '').trim().toLowerCase();
  const hay = `${rid} ${rname}`.trim().toLowerCase();
  for (const entry of list) {
    const e = String(entry || '').trim().toLowerCase();
    if (!e) continue;
    if (rid && (rid === e || rid.includes(e))) return true;
    if (rname && (rname === e || rname.includes(e))) return true;
    if (hay && hay.includes(e)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// core — scan + auto apply max coupon / free cash / night offers, nothing stops
// ---------------------------------------------------------------------------
export async function runAutoCouponCheckout({ account, order, options = {} } = {}) {
  const allowlist = options.restaurantAllowlist === undefined ? getAutoCouponRestaurantAllowlist() : options.restaurantAllowlist;

  const base = {
    requested: true,
    success: false,
    code: 'AUTO_COUPON_MODULE_UNAVAILABLE',
    appliedCoupon: null,
    discountAmount: 0,
    finalPayable: 0,
    savings: 0,
    totalSavings: 0,
    freeCashApplied: 0,
    campaignFreeCash: 0,
    walletSplitPayAmount: 0,
    freeDeliveryDiscount: 0,
    eventsClaimSummary: null,
    offerDiagnostics: null,
    availableCoupons: [],
    savedAddresses: [],
    accountComparison: null,
    qrBuffer: null,
    paymentUrl: null,
    restaurantId: order?.restaurantId || null,
    restaurantName: order?.restaurantName || null,
    items: Array.isArray(order?.items) ? order.items : [],
    address: order?.address || null,
    addressDetails: order?.addressDetails || null,
  };

  if (!account) {
    return { ...base, code: 'NO_ACCOUNT', error: 'Auto Coupon Checkout module: no Swiggy account provided.' };
  }

  if (!restaurantInAutoCouponAllowlist(order?.restaurantId, order?.restaurantName, allowlist)) {
    return {
      ...base,
      code: 'RESTAURANT_NOT_ALLOWED',
      error: `Restaurant "${order?.restaurantName || order?.restaurantId}" is NOT in the selected AUTO_COUPON_RESTAURANTS allowlist. Scan skipped safely.`,
    };
  }

  const auth = await getSwiggySessionAuth(account).catch(() => null);
  if (auth?.sessionExpired) {
    return { ...base, code: 'ACCOUNT_SESSION_EXPIRED_OR_PARTIAL', error: `Swiggy session expired for account ${account?.phone || account?.name || account?.id || 'ID'} — re-login first.` };
  }

  // 1) Night / Breakfast event offers (free cash campaign) pre-claim.
  let eventsClaimSummary = null;
  try {
    eventsClaimSummary = await claimSwiggyBreakfastAndLateNightOffers(account);
  } catch (e) {
    eventsClaimSummary = { success: false, reason: String(e?.message || 'event_claim_failed') };
  }

  // 2) Full auto checkout pipeline:
  //    cart resolve → address bind → Swiggy One → coupon discovery → MAX coupon trial/apply → free cash → bill
  const syncRes = await syncGroupCartAndCheckoutForAccount(account, order, {
    captureScreenshot: Boolean(options.captureScreenshot)
  });

  const result = {
    ...base,
    eventsClaimSummary,
    savedAddresses: syncRes?.savedAddresses || [],
    accountComparison: syncRes?.accountComparison || null,
    offerDiagnostics: syncRes?.offerDiagnostics || null,
    availableCoupons: Array.isArray(syncRes?.availableCoupons) ? syncRes.availableCoupons : [],
    qrBuffer: syncRes?.qrBuffer || null,
    paymentUrl: syncRes?.paymentUrl || null,
  };

  if (syncRes?.success === false) {
    return { ...result, code: syncRes.code || 'AUTO_COUPON_SYNC_FAILED', error: syncRes.error, sessionExpired: Boolean(syncRes.sessionExpired) };
  }

  const cartData = syncRes?.cartData || {};
  const appliedCoupon = String(cartData.couponCode || order?.couponCode || '') || null;
  const discount = Number(cartData.discountAmount || order?.discountAmount || 0);
  const finalPayable = Number(cartData.finalPayable || order?.finalPayable || 0);
  const savings = Number(cartData.totalSavings || cartData.discountAmount || 0);
  const freeCashApplied = Number(cartData.freeCashApplied || 0);
  const campaignFreeCash = Number(cartData.campaignFreeCash || 0);
  const walletSplitPayAmount = Number(cartData.walletSplitPayAmount || 0);
  const freeDeliveryDiscount = Number(cartData.freeDeliveryDiscount || 0);

  return {
    ...result,
    success: true,
    code: 'AUTO_COUPON_OK',
    sessionExpired: false,
    cartData,
    appliedCoupon,
    couponApplied: Boolean(appliedCoupon) || Number(discount) > 0 || Number(savings) > 0,
    discountAmount: discount,
    finalPayable,
    savings,
    totalSavings: savings,
    freeCashApplied,
    campaignFreeCash,
    walletSplitPayAmount,
    freeDeliveryDiscount,
    restaurantId: order?.restaurantId || null,
    restaurantName: order?.restaurantName || null,
  };
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------
function resolveAccountFromArgs(a) {
  const db = getDb();
  const accounts = db?.config?.accounts || {};
  const keys = Object.keys(accounts);
  const wanted = String(a.account || '').trim();
  if (wanted) {
    const hit = keys.find((k) => {
      const acc = accounts[k];
      return k === wanted || String(acc?.phone || '') === wanted || String(acc?.mobile || '') === wanted;
    });
    if (hit) return { key: hit, acc: accounts[hit] };
  }
  const loggedIn = keys.filter((k) => {
    const acc = accounts[k];
    return Boolean(acc && (acc.isLoggedIn || acc.token || acc.tid || acc.cookies));
  });
  const pick = loggedIn[0];
  if (pick) return { key: pick, acc: accounts[pick] };
  return { key: '', acc: null };
}

async function buildOrderFromArgs(a) {
  const order = { id: a.orderId || `AUTO_COUPON_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, status: 'PENDING', paymentStatus: 'UNPAID' };
  if (a.cart) order.cart = a.cart;

  if (a.address) {
    const parsed = parseAddressDetails(a.address);
    if (parsed?.address) {
      order.address = parsed.address;
      order.addressDetails = parsed;
    }
  }

  let restaurantId = '';
  let restaurantName = '';
  if (a.cart) {
    const cm = await resolveSwiggyLink(a.cart).catch(() => null);
    if (cm) {
      if (cm.restaurantId) { restaurantId = String(cm.restaurantId); order.restaurantId = restaurantId; }
      if (cm.restaurantName) { restaurantName = cm.restaurantName; order.restaurantName = restaurantName; }
      if (cm.groupCartId) order.groupCartId = cm.groupCartId;
      if (cm.hostName) order.hostName = cm.hostName;
      if (cm.cartDetails?.items?.length > 0) {
        order.items = cm.cartDetails.items;
        order.itemTotal = cm.cartDetails.itemsTotal || cm.cartDetails.subtotal || 0;
        order.subtotal = cm.cartDetails.subtotal || cm.cartDetails.itemsTotal || 0;
        if (cm.cartDetails.couponCode) { order.couponCode = cm.cartDetails.couponCode; order.discountAmount = cm.cartDetails.discountAmount || 0; }
        if (Number(cm.cartDetails.finalPayable) > 0) { order.finalPayable = cm.cartDetails.finalPayable; order.swiggyVerified = true; }
      }
    }
  }

  if (a.restaurantId) order.restaurantId = a.restaurantId;
  if (a.restaurantName) order.restaurantName = a.restaurantName;
  if (a.restaurant) {
    const r = String(a.restaurant).trim();
    if (/^\d+$/.test(r)) {
      if (!order.restaurantId) order.restaurantId = r;
    } else if (r) {
      if (!order.restaurantName) order.restaurantName = r;
      if (!order.restaurantId) order.restaurantId = r;
    }
  }
  if (!restaurantId && order.restaurantId) restaurantId = String(order.restaurantId);
  if (!restaurantName && order.restaurantName) restaurantName = String(order.restaurantName);
  if (restaurantId) order.restaurantId = restaurantId;
  if (restaurantName) order.restaurantName = restaurantName;

  return order;
}

function fmtMoney(n) {
  const v = Number(n || 0);
  return `₹${(Math.round(v * 100) / 100).toFixed(2)}`;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return 0;
  }
  if (!a.account && !a.cart && !a.address) {
    console.error(`--account / --cart / --address me se kam ek zaroori hai.\n\n${HELP}`);
    return 1;
  }

  const { acc } = resolveAccountFromArgs(a);
  if (!acc) {
    console.error('❌ No logged-in Swiggy account found in vault. Pehle OTP se login karo (☎ Accounts).');
    return 1;
  }

  const order = await buildOrderFromArgs(a).catch((e) => ({ id: a.orderId || `AUTO_COUPON_${Date.now()}`, error: e?.message }));
  const res = await runAutoCouponCheckout({ account: acc, order, options: { captureScreenshot: a.apply } });

  console.log('================================================================');
  console.log('🤖 AUTO COUPON CHECKOUT MODULE RESULT');
  console.log('================================================================');
  console.log(`Account: ${acc?.phone || acc?.name || acc?.id || a.account}`);
  console.log(`Restaurant: ${res.restaurantName || order?.restaurantName || 'UNKNOWN'}`);
  console.log(`Order ID: ${order?.id || '-'}`);
  console.log(`Status: ${res.success ? '✅ AUTO-COUPON OK' : `❌ ${res.code}`}`);
  if (res.error) console.log(`Error: ${res.error}`);

  if (res.success) {
    console.log(`Applied Coupon: ${res.appliedCoupon || 'NONE'}`);
    console.log(`Coupon Applied Flag: ${Boolean(res.couponApplied)}`);
    console.log(`Coupon Discount: ${fmtMoney(res.discountAmount)}`);
    console.log(`Campaign Free Cash: ${fmtMoney(res.campaignFreeCash)}`);
    console.log(`Free Cash Applied: ${fmtMoney(res.freeCashApplied)}`);
    console.log(`Swiggy Money Split-Pay: ${fmtMoney(res.walletSplitPayAmount)}`);
    console.log(`Free Delivery Discount: ${fmtMoney(res.freeDeliveryDiscount)}`);
    console.log(`Total Savings: ${fmtMoney(res.savings)}`);
    console.log(`Final Payable: ${fmtMoney(res.finalPayable)}`);
    console.log(`Available Coupons Scanned: ${(res.availableCoupons || []).length}`);
    if (Array.isArray(res.availableCoupons) && res.availableCoupons.length) {
      console.log('Scanned Coupons:');
      for (const c of res.availableCoupons.slice(0, 25)) console.log(`  • ${c.code} — ${c.title || c.description || ''} (priority ${c.priority})`);
    }
    if (res.eventsClaimSummary) {
      console.log('Events/Night Offer Claim:');
      console.log(`  success=${Boolean(res.eventsClaimSummary.success)} label=${res.eventsClaimSummary.offerLabel || ''} breakfast=${JSON.stringify(res.eventsClaimSummary.breakfast || null)} lateNight=${JSON.stringify(res.eventsClaimSummary.lateNight || null)}`);
    }
  }

  console.log('================================================================');
  return res.success ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`Error: ${err?.message || err}`);
    process.exitCode = 1;
  });
