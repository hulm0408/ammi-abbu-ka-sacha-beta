import assert from 'node:assert/strict';
import { refreshEventOfferSnapshot, activeEventOffer } from './event-offer-state.js';
import { freeCashStatus } from './checkout-eligibility.js';
import { expandTrackingCandidates, trackingQueryMatchesOrder } from './tracking-link-utils.js';
process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const at = date => Date.parse(date);
const now = at('2026-10-24T16:00:00Z'); // 21:30 IST
const slot = (kind, confirmed = true) => ({
  bookingConfirmed: confirmed, offerValue: 1, slotState: 'LOCKED_FOR_TODAY',
  bookedAt: '2026-10-24T12:00:00Z',
  cutoffMs: at(kind === 'LN' ? '2026-10-24T13:00:00Z' : '2026-10-24T23:30:00Z'),
  slotOpenMs: at(kind === 'LN' ? '2026-10-24T15:30:00Z' : '2026-10-25T01:30:00Z'),
  slotEndMs: at(kind === 'LN' ? '2026-10-25T00:30:00Z' : '2026-10-25T05:30:00Z')
});
const snapshot = time => ({ verifiedAt: time, breakfast: slot('BF'), lateNight: slot('LN') });
check(refreshEventOfferSnapshot(snapshot(now), now).lateNight.slotState, 'ACTIVE_NOW', 'rebases booked-before-cutoff status during night slot');
check(activeEventOffer({ offers: snapshot(now) }, now).amount, 50, 'real cash option estimate');
check(activeEventOffer({ offers: { lateNight: { slotState: 'ACTIVE_NOW' } } }, now).active, false, 'timeless imported flag is not proof');
check(refreshEventOfferSnapshot(snapshot(now - 60_000), now), null, 'stale snapshot must be fetched live');
check(refreshEventOfferSnapshot(snapshot(now + 1000), now), null, 'future verification rejected');
for (const [date, state] of [
  ['2026-10-24T15:29:59Z', 'LOCKED_FOR_TODAY'],
  ['2026-10-24T15:30:00Z', 'ACTIVE_NOW'],
  ['2026-10-24T20:30:00Z', 'ACTIVE_NOW'], // 02:00 IST next calendar day
  ['2026-10-25T00:30:00Z', 'SLOT_ENDED']
]) {
  const time = at(date);
  check(refreshEventOfferSnapshot(snapshot(time), time).lateNight.slotState, state, date);
}
let changed = snapshot(now);
changed.lateNight.bookedAt = '2026-10-24T14:00:00Z';
check(activeEventOffer({ offers: changed }, now).active, false, 'cutoff-passed booking never active today');
changed = snapshot(now);
changed.lateNight.bookingConfirmed = false;
check(activeEventOffer({ offers: changed }, now).active, false, 'tomorrow does not prove today');
changed = snapshot(now);
changed.lateNight.bookedAt = '';
check(refreshEventOfferSnapshot(changed, now).lateNight.slotState, 'BOOKING_TIME_UNVERIFIED', 'missing time not invented');
changed = snapshot(now);
changed.lateNight.offerValue = 2;
check(activeEventOffer({ offers: changed }, now).amount, 0, 'coupon is not wallet cash');
check(freeCashStatus({ itemTotal: 235 }, refreshEventOfferSnapshot(changed, now)).includes('₹249'), true, '235 cart below selected coupon minimum');
check(freeCashStatus({ freeCashApplied: 50, itemTotal: 235 }, snapshot(now)), '', 'never overwrite actual cart savings');

const official = 'https://www.swiggy.com/swiggy/ofo/track/AbCd123?order_id=123456789&token=a%2Bb%26c%3D';
const wrapper = `https://swiggy.onelink.me/JgkQ/xyz?af_web_dp=${encodeURIComponent(official)}`;
check(expandTrackingCandidates([wrapper])[0], official, 'unwrap official target, preserve encoded signature');
check(trackingQueryMatchesOrder(wrapper, '123456789'), true, 'matching nested order');
check(trackingQueryMatchesOrder(wrapper, '987654321'), false, 'wrong nested order rejected');
check(trackingQueryMatchesOrder(`${official}&ORDER_ID=999`, '123456789'), false, 'duplicate/case-variant order id rejected');
check(expandTrackingCandidates(['https://evil.example/ofo/track/abc']), [], 'no external tracking');

const { extractOrderShareUrlDeep, extractOrderShareUrlForOrder, extractTrackingCandidateUrlsFromString,
  validateTrackingUrlForOrder: validateEngine } = await import('./swiggy-cart.js');
const { validateTrackingUrlForOrder: validateStandalone } = await import('./tracking-validation.js');
check(extractTrackingCandidateUrlsFromString(official.replace(/&/g, '&amp;'))[0], official, 'HTML ampersand does not corrupt query');
check(extractOrderShareUrlDeep({ share_url: wrapper }), official, 'actual OFO target outranks wrapper');
check(extractOrderShareUrlDeep({ share_url: 'https://r.swiggy.com/generic', tracking_url: official }), official, 'explicit OFO outranks opaque short link');
for (const validate of [validateEngine, validateStandalone]) {
  check(validate(wrapper, { swiggyOrderId: '987654321' }, 'SWIGGY_API'), false, 'both validators reject cross-order wrapper');
  check(validate(official, { swiggyOrderId: '123456789' }, 'SWIGGY_API'), true, 'both validators accept actual OFO URL');
  check(validate(`${official}&orderId=999`, { swiggyOrderId: '123456789' }, 'SWIGGY_API'), false, 'both validators inspect all IDs');
}
check(extractOrderShareUrlForOrder('123456789', { orders: [
  { order_id: '987654321', tracking_url: 'https://r.swiggy.com/swiggy/ofo/track/wrongToken' },
  { order_id: '123456789', tracking_url: official }
] }), official, 'ignore another order response, even an opaque higher-ranked OFO token');
check(extractOrderShareUrlForOrder('123456789', { tracking_url: official.replace('123456789', '987654321') }, { share_url: official }), official, 'reject bad primary link and keep looking for actual order');
check(extractOrderShareUrlDeep({ tracking_url: 'https://www.swiggy.com/', address_url: 'https://swiggy.com/ofo/address/test/token' }), '', 'no placeholder or address as tracking');
// Exercise the real booking function with HTTP-200 business failures and a
// successful tomorrow. All requests are mocked; no campaign is actually booked.
const { claimSwiggyBreakfastAndLateNightOffers, getReusableEventOffers } = await import('./swiggy-bridge.js');
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
try {
  Date.now = () => now;
  let refuseToday = true;
  let bookingReads = 0;
  const response = json => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'events.swiggy.com', 'no real Swiggy network requests');
    if (parsed.pathname === '/api/notify') {
      bookingReads++;
      const campaign = parsed.searchParams.get('campaign') || JSON.parse(options.body || '{}').campaign;
      const refused = refuseToday && campaign === 'test-ln-1';
      if (options.method) return response({ statusCode: refused ? 1 : 0, message: refused ? 'Not eligible today' : 'ok' });
      return response({ statusCode: 0, shouldNotify: !refused, value: 1, timestamp: '2026-10-24T12:00:00Z' });
    }
    const prefix = parsed.pathname === '/book-your-offer' ? 'test-bf-' : 'test-ln-';
    const json = { props: { pageProps: { nexusData: { notifyCampaignIdPrefix: prefix, dayBoundaries: [
      { day: 1, startTime: '2026-10-24T05:30:00Z', endTime: '2026-10-25T05:30:00Z' },
      { day: 2, startTime: '2026-10-25T05:30:00Z', endTime: '2026-10-26T05:30:00Z' }
    ] } } } };
    return { ok: true, status: 200, text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(json)}</script>` };
  };
  const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: 'test', exp: Math.floor(now / 1000) + 86400 })).toString('base64url') + '.signature';
  const account = { id: 'night-offline-test', token: 'test-token', tid: jwt };
  const denied = await claimSwiggyBreakfastAndLateNightOffers(account, { force: true, quickLockOnly: true });
  check(denied.lateNight.bookingConfirmed, false, 'HTTP 200 with statusCode 1 is a failed booking');
  check(denied.lateNight.slotState, 'FAILED', 'tomorrow success cannot label today active');
  check(denied.bothClaimed, false, 'today not falsely both claimed');
  refuseToday = false;
  const confirmed = await claimSwiggyBreakfastAndLateNightOffers(account, { force: true, quickLockOnly: true });
  check(confirmed.lateNight.slotState, 'ACTIVE_NOW', 'today confirmed before cutoff, current slot active');
  check(confirmed.lateNight.slotEndMs, at('2026-10-25T00:30:00Z'), 'server campaign end does not extend redemption past 6 AM');
  const readsBeforeReuse = bookingReads;
  check(getReusableEventOffers({ offers: confirmed }, now).lateNight.slotState, 'ACTIVE_NOW', 'fresh verified booking reusable');
  check(bookingReads, readsBeforeReuse, 'pure cache rebase performs no requests');
  check(getReusableEventOffers({ offers: confirmed }, now + 61_000), null, 'dated cache expires and requires live recheck');
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
console.log(`PASS: ${checks} night slot, cached booking, ₹235 eligibility and OFO extraction/validation checks`);
