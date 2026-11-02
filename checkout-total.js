/**
 * checkout-total.js — centralized, PURE checkout-total calculation.
 *
 * Single source of truth for "final payable" from a Swiggy cart/checkout
 * breakdown. Rules (boss: "BILL SAHI SE CALCULATE KARLE"):
 *   • A Swiggy-supplied authoritative total (`order_total` / `grand_total`
 *     render row) is preserved when it is consistent with the validated
 *     item-and-charge breakdown, or when it is LOWER than the reconstruction
 *     (i.e. it already includes discounts we cannot see line-by-line, such as
 *     free delivery) — never subtract those again.
 *   • A raw `order_total` is NOT trusted blindly: if coupon/trade discounts
 *     are validated (> 0) but the authoritative total still equals the
 *     pre-discount gross, it is stale/undiscounted → the reconstructed total
 *     from the breakdown is used instead.
 *   • Coupon and trade discounts are applied EXACTLY ONCE.
 *   • Delivery fee, packing, taxes/platform charges and Swiggy One membership
 *     fee are added according to the breakdown.
 *   • Wallet / Swiggy Money split-pay is deducted from the authoritative
 *     total exactly once (only when Swiggy has not already deducted it).
 *   • Result is never negative; null/undefined/NaN/negative inputs are
 *     handled; everything is rounded to 2 decimals (paise-consistent).
 *
 * Pure module — no I/O, no globals — so it is trivially unit-testable.
 */

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const toNum = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const nonNeg = (v) => Math.max(0, toNum(v));

/**
 * @param {object} c
 * @param {number} c.itemTotal               item subtotal (pre-discount)
 * @param {number} [c.couponDiscount]        validated coupon discount
 * @param {number} [c.tradeDiscountTotal]    trade/item discount total (may include reward free cash)
 * @param {number} [c.extraFreeCash]         free cash NOT already inside tradeDiscountTotal
 * @param {number} [c.swiggyOneMembershipFee]
 * @param {number} [c.deliveryFee]
 * @param {number} [c.packingCharges]
 * @param {number} [c.taxesAndCharges]       taxes/platform charges used for the reconstruction
 * @param {number} [c.independentTaxesAndCharges] taxes from render rows / raw tax fields,
 *                                               used only to detect a stale undiscounted total
 * @param {number|null} [c.authoritativeTotal]   Swiggy order_total / grand_total (null = absent)
 * @param {number} [c.walletSplitPayAmount]  Swiggy Money split-pay deducted on the QR
 * @param {boolean} [c.walletAlreadyDeducted]   true when swiggy_money is already inside order_total
 * @param {number} [c.tolerance]             absolute tolerance (₹) for "consistent" comparison
 * @returns {number} final payable in rupees, >= 0, 2-decimal rounded
 */
export function computeFinalPayable({
  itemTotal = 0,
  couponDiscount = 0,
  tradeDiscountTotal = 0,
  extraFreeCash = 0,
  swiggyOneMembershipFee = 0,
  deliveryFee = 0,
  packingCharges = 0,
  taxesAndCharges = 0,
  independentTaxesAndCharges = null,
  authoritativeTotal = null,
  walletSplitPayAmount = 0,
  walletAlreadyDeducted = false,
  tolerance = 1
} = {}) {
  const items = nonNeg(itemTotal);
  const coupon = nonNeg(couponDiscount);
  const trade = nonNeg(tradeDiscountTotal);
  const extraCash = nonNeg(extraFreeCash);
  const oneFee = nonNeg(swiggyOneMembershipFee);
  const delivery = nonNeg(deliveryFee);
  const packing = nonNeg(packingCharges);
  const taxes = nonNeg(taxesAndCharges);
  const discounts = round2(coupon + trade + extraCash);

  const charges = round2(oneFee + delivery + packing + taxes);
  // Reconstruction from the validated breakdown; discounts applied exactly once.
  const reconstructed = round2(Math.max(0, items - discounts + charges));

  // Authoritative Swiggy total (may be null/undefined/NaN/negative → malformed).
  const rawAuth = (authoritativeTotal === null || authoritativeTotal === undefined || authoritativeTotal === '')
    ? null
    : Number(authoritativeTotal);
  if (rawAuth === null || !Number.isFinite(rawAuth) || rawAuth < 0) {
    // No usable authoritative total → trust the breakdown.
    return reconstructed;
  }
  // Wallet split-pay reduces the QR amount exactly once.
  const auth = walletAlreadyDeducted
    ? round2(rawAuth)
    : round2(Math.max(0, rawAuth - nonNeg(walletSplitPayAmount)));

  const tol = Math.max(nonNeg(tolerance), items * 0.005, 0.01);

  // Stale/undiscounted detection: validated discounts exist, but the
  // authoritative total still equals the pre-discount gross (computed with
  // independently sourced taxes when available). Then order_total was NOT
  // reduced by the coupon → do not use it as the payable.
  const indepTaxes = independentTaxesAndCharges === null || independentTaxesAndCharges === undefined
    ? taxes
    : nonNeg(independentTaxesAndCharges);
  const gross = round2(Math.max(0, items + oneFee + delivery + packing + indepTaxes));
  // Compare the UNSPLIT cart amount with gross. Comparing the wallet-
  // reduced QR amount hides stale coupons/rewards when wallet cash is present.
  if (discounts > 0 && Math.abs(rawAuth - gross) <= tol) {
    const wallet = walletAlreadyDeducted ? 0 : nonNeg(walletSplitPayAmount);
    return round2(Math.max(0, items - discounts + oneFee + delivery + packing + indepTaxes - wallet));
  }

  if (Math.abs(auth - reconstructed) <= tol) return auth;          // consistent → authoritative
  if (auth < reconstructed - tol) return auth;                      // extra discounts inside → authoritative
  return auth;                                                      // partial mismatch → trust Swiggy (conservative)
}

/** Small helper: 2-decimal clamp for money values coming from anywhere. */
export function sanitizeMoney(value, { fallback = 0 } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return round2(Math.max(0, n));
}
