// tradeDiscountTotal can already contain campaignFreeCash. Expose disjoint
// components so renderers/calculators never subtract the same reward twice.
const amount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const round = value => Math.round(value * 100) / 100;
export function orderDiscountBreakdown(order = {}) {
  const campaign = amount(order.campaignFreeCash);
  const merchant = order.merchantTradeDiscount != null
    ? amount(order.merchantTradeDiscount)
    : Math.max(0, amount(order.tradeDiscountTotal) - campaign);
  const wallet = order.walletSplitPayAmount != null
    ? amount(order.walletSplitPayAmount)
    : Math.max(0, amount(order.freeCashApplied) - campaign);
  const coupon = amount(order.discountAmount);
  const total = round(merchant + campaign + wallet + coupon);
  return { merchant: round(merchant), campaign: round(campaign), wallet: round(wallet), coupon,
    freeCash: round(campaign + wallet), total,
    savings: round(total + amount(order.freeDeliveryDiscount || order.deliverySaved)) };
}
