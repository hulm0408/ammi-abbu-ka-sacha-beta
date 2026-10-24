// Booking is not cart credit. Only fresh, dated server-confirmed bookings can
// qualify for an active slot; legacy state labels alone are not evidence.
export const EVENT_BOOKING_MAX_AGE_MS = 60_000;
export function refreshEventOfferSnapshot(snapshot, nowMs = Date.now()) {
  const source = snapshot?.offers?.breakfast || snapshot?.offers?.lateNight ? snapshot.offers : snapshot;
  const verifiedAt = Number(source?.verifiedAt || snapshot?.verifiedAt);
  if (!Number.isFinite(verifiedAt) || nowMs < verifiedAt || nowMs - verifiedAt >= EVENT_BOOKING_MAX_AGE_MS) return null;
  const refresh = (slot, name) => {
    if (!slot) return null;
    const open = Number(slot.slotOpenMs), end = Number(slot.slotEndMs), cutoff = Number(slot.cutoffMs);
    const booked = Date.parse(slot.bookedAt || '');
    if (!Number.isFinite(open) || !Number.isFinite(end) || !Number.isFinite(cutoff) || !(end > open)) return null;
    let state = slot.slotState;
    if (!slot.bookingConfirmed) state = 'FAILED';
    else if (!Number.isFinite(booked)) state = 'BOOKING_TIME_UNVERIFIED';
    else if (booked > cutoff) state = 'CUTOFF_PASSED_LOCKED_NEXT_14D';
    else if (nowMs >= end) state = 'SLOT_ENDED';
    else state = nowMs >= open ? 'ACTIVE_NOW' : 'LOCKED_FOR_TODAY';
    const messages = {
      ACTIVE_NOW: `${name} slot active; discount sirf live Swiggy cart confirmation par apply hoga.`,
      LOCKED_FOR_TODAY: `${name} booked; redeem slot abhi shuru nahi hua.`,
      SLOT_ENDED: `${name} redeem slot khatam; current booking dobara verify karein.`,
      CUTOFF_PASSED_LOCKED_NEXT_14D: `${name} booking cutoff ke baad hui; aaj ka discount confirmed nahi hai.`,
      BOOKING_TIME_UNVERIFIED: `${name} booking time verify nahi hua; aaj ka discount confirmed nahi hai.`,
      FAILED: `${name} ki current booking Swiggy ne confirm nahi ki.`
    };
    return { ...slot, slotState: state, message: messages[state] };
  };
  const breakfast = refresh(source.breakfast, 'Breakfast');
  const lateNight = refresh(source.lateNight, 'Late Night');
  if (!breakfast || !lateNight) return null;
  return { ...snapshot, ...source, verifiedAt, breakfast, lateNight,
    success: breakfast.bookingConfirmed || lateNight.bookingConfirmed };
}

export function activeEventOffer(account, nowMs = Date.now()) {
  const snapshot = refreshEventOfferSnapshot(account?.offers, nowMs);
  const slot = snapshot?.lateNight?.slotState === 'ACTIVE_NOW' ? 'lateNight' :
    snapshot?.breakfast?.slotState === 'ACTIVE_NOW' ? 'breakfast' : null;
  if (!slot) return { active: false, slot: null, amount: 0, state: '' };
  const offer = snapshot[slot];
  const value = Number(offer.offerValue || 1);
  // Options 2–4 are coupons, NOT a wallet credit that stacks over coupons.
  return { active: true, slot: slot === 'lateNight' ? 'LATE_NIGHT' : 'BREAKFAST',
    kind: value === 1 ? 'FREE_CASH' : 'COUPON', amount: value === 1 ? 50 : 0,
    minOrderValue: value === 2 ? 249 : value === 3 ? 399 : value === 4 ? 149 : 199,
    state: offer.slotState };
}
