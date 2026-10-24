// Pure checkout rules shared by the main bot and standalone engine.
const money = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
export function eligibleWalletBalance(cart = {}) {
  // An explicit eligible zero wins over a positive *total* wallet balance.
  return money(cart.swiggy_pay_eligible_balance ?? cart.user_swiggy_money ?? 0);
}

export function verifiedOrderHistory(account = {}, foodResponse, instamartResponse) {
  const read = response => response?.ok !== false && response?.json?.statusCode === 0 &&
    Array.isArray(response.json.data?.orders) ? response.json.data.orders : null;
  const food = read(foodResponse);
  const instamart = read(instamartResponse);
  const orders = [...(food || []), ...(instamart || [])];
  const seen = new Set();
  let observed = 0;
  for (const order of orders) {
    if (/failed/i.test(String(order?.order_status || order?.post_status || ''))) continue;
    const id = String(order?.order_id || order?.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    observed++;
  }
  const known = [account.totalOrdersCount, account.cachedTotalOrdersCount]
    .filter(v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) !== 999999)
    .map(money);
  // Never erase positive usage evidence with an empty page or imported zero.
  const lowerBound = Math.max(observed, ...known, 0);
  const verified = food !== null && instamart !== null;
  return {
    orders,
    ordersVerifiedLive: verified,
    totalOrdersCount: lowerBound > 0 || verified ? lowerBound : 999999,
    isZeroOrderAccount: verified && lowerBound === 0
  };
}

export function freeCashStatus(cart = {}, claim = null) {
  if (money(cart.freeCashApplied) > 0) return '';
  const slots = [claim?.breakfast?.slotState, claim?.lateNight?.slotState];
  const active = claim?.lateNight?.slotState === 'ACTIVE_NOW' ? claim.lateNight :
    claim?.breakfast?.slotState === 'ACTIVE_NOW' ? claim.breakfast : null;
  const option = Number(active?.offerValue || claim?.offerValue || 1);
  if (active && option !== 1) {
    const minimum = option === 2 ? '₹249' : option === 4 ? '₹149' : 'selected coupon ke terms';
    return `Selected event option Free Cash nahi, coupon hai (minimum ${minimum}). Current items: ₹${money(cart.itemTotal || cart.subtotal)}. Coupon Swiggy-confirmed hone par hi discount count hoga.`;
  }
  if (slots.includes('ACTIVE_NOW')) {
    return 'Free Cash cart mein apply nahi hua. Swiggy ki minimum spend, eligible items aur account eligibility check karein; booking alone discount ki guarantee nahi hai.';
  }
  if (slots.includes('LOCKED_FOR_TODAY')) {
    return 'Free Cash booked hai, abhi active nahi. Breakfast 7 AM / Late Night 9 PM ke eligible slot mein cart refresh karein; cutoff aur minimum spend apply honge.';
  }
  return 'Swiggy cart ne eligible Free Cash confirm nahi kiya. Claim/slot, minimum spend aur account eligibility check karein; extra discount assume nahi kiya gaya.';
}

// Wallet credit is not proof of a Night campaign reward. Always report the
// booking and cart reward separately, even when another wallet discount exists.
export function nightOfferDiagnostic(cart = {}, claim = null) {
  const slot = claim?.lateNight;
  const reward = money(cart.campaignFreeCash);
  const wallet = money(cart.walletSplitPayAmount);
  const state = slot?.slotState || 'UNVERIFIED';
  let message;
  if (state === 'ACTIVE_NOW') {
    message = Number(slot.offerValue || claim?.offerValue || 1) !== 1
      ? 'Night mein coupon option selected hai, ₹50 Free Cash option nahi.'
      : reward > 0
        ? `Night booking active; cart reward ₹${reward}. Reward ka Night campaign attribution abhi verify nahi hua.`
        : 'Night booking active, lekin live Swiggy cart mein campaign reward ₹0 hai; discount confirmed nahi hai.';
  } else if (state === 'CUTOFF_PASSED_LOCKED_NEXT_14D') {
    message = 'Night booking cutoff ke baad hui; current night ka discount confirmed nahi hai.';
  } else if (state === 'LOCKED_FOR_TODAY') {
    message = 'Night booking confirmed; redeem slot abhi active nahi hai.';
  } else if (state === 'SLOT_ENDED') {
    message = 'Night redeem slot khatam ho chuka hai.';
  } else {
    message = 'Current Night booking/time Swiggy se verify nahi hua; Night offer applied nahi maana gaya.';
  }
  if (wallet > 0) message += ` Wallet ₹${wallet} alag hai; ise Night reward nahi maana gaya.`;
  return { state, campaignReward: reward, wallet, message,
    bookedAt: slot?.bookedAt || null, cutoffMs: slot?.cutoffMs ?? null,
    slotOpenMs: slot?.slotOpenMs ?? null, slotEndMs: slot?.slotEndMs ?? null };
}
