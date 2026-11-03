/**
 * instant-offer-engine.js — Swiggy jaisa "auto max offer + free cash" bill.
 *
 * Boss (03-11-2026): "bhia max offer and free cash jaise swiggy me auto lag
 * jata waise isme bhi lag jaye ... usko time nahi lagta mere me bhi na lage
 * and without any error hojaye".
 *
 * Swiggy app me coupon trial-and-error nahi hota: Swiggy ka apna cart engine
 * best coupon + Swiggy Money/campaign cash PEHLE HI cart response me laga ke
 * deta hai. Purana `quoteCart` (abhi bhi `deep` mode me available) iske ulta
 * 6-10 alag cart writes + claim wait + One Lite trials karta tha — isliye bill
 * me time lagta tha aur beech ka ek write fail hone par poora bill error tha.
 *
 * Ye engine bilkul Swiggy wala rasta leta hai:
 *   1. address + coupon feed + Night/Breakfast claim EK SAATH (parallel) shuru,
 *   2. Swiggy ka khud ka best coupon (auto-suggested / feed me sabse bada
 *      discount / isi account+restaurant par pehle VERIFY hua coupon) chunna,
 *   3. wo code PEHLE cart write me bhejna — free cash claim bhi tab tak aa
 *      chuka hota hai,
 *   4. cart ki readback se hi bill banana. Jo Swiggy ne sach me kata wahi
 *      discount/free cash dikhta hai; koi andaza, koi jhootha "applied" nahi.
 *
 * Guarantee:
 *   • typical bill = 1 cart write (fallback mila kar max 3), blind trial 0.
 *   • offer feed / claim / coupon reject / dedicated apply — inme se kisi ke
 *     fail hone par bill phir bhi verified readback se aata hai, error nahi.
 *   • sirf wahi error nikalti hai jo sach me bill rok sake (address/cart/payable
 *     verify na ho) — usme bhi jhootha number kabhi nahi dikhta.
 *   • har network call bounded hai, koi infinite wait / unhandled rejection nahi.
 */

import {
  buildSwiggyCartItemsPayload, buildOfoCartFields, dapiFetch,
  fetchAccountAddresses, saveAddressToAccount, swiggyCartGet, swiggyCartUpdate,
  applySwiggyCartCoupon, parseDapiCartPayload, callSwiggyFoodMcpTool,
  isValidIndianDeliveryCoordinates
} from './swiggy-cart.js';
import { activateAllEventOffers } from './event-offers.js';
import { sameCartItems, sameDeliveryRecipient, exactPaise } from './swiggy-cart-integrity.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';

const okCode = v => v === 0 || v === '0';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(Number.isFinite(Number(v)) ? Number(v) : lo, hi));
const envMs = (name, fallback, lo, hi) => clamp(Number(process.env[name]) || fallback, lo, hi);

function badRequest(message) { const e = new Error(message); e.statusCode = 400; return e; }
function unavailable(message) { const e = new Error(message); e.statusCode = 502; return e; }

/** Har optional kaam ka jawab ya to aa jaye, ya `fallback` — kabhi throw nahi. */
async function bounded(promise, ms, fallback = null) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), Math.max(1, ms));
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
  } catch { return fallback; }
  finally { if (timer) clearTimeout(timer); }
}

function accountKey(account) {
  return normalizeIndianMobileNumber(account?.phone || account?.mobile || '') ||
    String(account?.customerId || account?.userId || account?.token || 'account').slice(0, 80);
}

/** Isi ID + restaurant + cart size par ek baar Swiggy ne discount diya tha. */
const VERIFIED_TTL_MS = envMs('PRO_INSTANT_VERIFIED_TTL_MS', 10 * 60_000, 30_000, 60 * 60_000);
const verifiedCoupons = new Map();
const verifiedCacheKey = (account, restaurantId, itemTotal = 0) =>
  `${accountKey(account)}|${String(restaurantId || '')}|${Math.round(Number(itemTotal) / 50)}`;

export function rememberVerifiedCoupon(account, restaurantId, code, discount, itemTotal = 0) {
  const clean = String(code || '').trim().toUpperCase();
  const amount = Number(discount);
  if (!/^[A-Z0-9_-]{3,28}$/.test(clean) || !Number.isFinite(amount) || amount <= 0) return;
  verifiedCoupons.set(verifiedCacheKey(account, restaurantId, itemTotal), {
    code: clean, discount: Math.round(amount * 100) / 100, savedAt: Date.now()
  });
}
export function verifiedCouponFor(account, restaurantId, itemTotal = 0) {
  const hit = verifiedCoupons.get(verifiedCacheKey(account, restaurantId, itemTotal));
  if (!hit || Date.now() - hit.savedAt > VERIFIED_TTL_MS) return null;
  return { ...hit };
}
export function resetInstantOfferCache() { verifiedCoupons.clear(); }

/** Coupon ke text/explicit field se andaza nahi — sirf likhi hui saving. */
export function extractCouponSaving(coupon, itemTotal = 0) {
  if (!coupon || typeof coupon !== 'object') return null;
  for (const key of ['discountAmount', 'discount_amount', 'maxDiscount', 'max_discount',
    'savings', 'saving', 'couponDiscount', 'coupon_discount', 'offerDiscount',
    'offer_discount', 'cashback_amount', 'cashback']) {
    const value = Number(coupon[key]);
    if (Number.isFinite(value) && value > 0 && value < 10_000) return Math.round(value * 100) / 100;
  }
  const text = ['title', 'header', 'description', 'subtitle', 'text', 'offerText']
    .map(k => String(coupon[k] || '')).filter(Boolean).join(' ');
  if (!text) return null;
  const flat = text.match(/₹\s*(\d{1,4})\s*(?:off|discount|cashback|save)/i) ||
    text.match(/(?:flat|save|get)\s*₹?\s*(\d{1,4})\s*(?:off|discount)/i);
  if (flat) return Number(flat[1]);
  const pct = text.match(/(\d{1,2})\s*%\s*(?:off|discount)/i);
  const cap = text.match(/(?:up\s*to|max\.?|capped\s*at)\s*₹\s*(\d{1,4})/i);
  if (pct) {
    const ceiling = cap ? Number(cap[1]) : Number.POSITIVE_INFINITY;
    const gross = Number(itemTotal);
    const base = gross > 0 ? gross * Number(pct[1]) / 100 : (cap ? Number(cap[1]) : null);
    return base ? Math.round(Math.min(base, ceiling) * 100) / 100 : null;
  }
  return null;
}

/**
 * EK hi coupon chunta hai — jaise Swiggy khud karti hai. Blind promo list,
 * sequential trials ya "8 code try karo" yahan bilkul nahi.
 * Priority: Swiggy ka auto-suggested > sabse bada likha hua discount >
 * pehle verified > pichhla auto coupon > feed ka pehla applicable code.
 */
export function selectInstantCoupon({
  mcpCoupons = null, mcpCart = null, previousAutoCoupon = '',
  verified = null, itemTotal = 0, excluded = null
} = {}) {
  const candidates = new Map();
  const add = (code, source, saving = null, trust = 50) => {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,28}$/.test(clean)) return;
    if (['NOT', 'NONE', 'NULL', 'UNDEFINED', 'NOFOMO', 'REMOVE'].includes(clean)) return;
    if (excluded instanceof Set && excluded.has(clean)) return;
    const score = source === 'swiggy_suggested' ? 100_000
      : saving !== null ? 10_000 + Number(saving)
        : source === 'previous' ? 5_000 : 1_000;
    const prior = candidates.get(clean);
    if (!prior || score > prior.score) candidates.set(clean, { code: clean, source, saving, trust, score });
  };

  if (verified?.code) add(verified.code, 'verified', Number(verified.discount) || null, 10);
  const structured = mcpCart?.structured || mcpCart?.structuredContent || null;
  const suggested = structured?.offers?.coupon_applied || structured?.offers?.suggested_coupon ||
    structured?.suggested_coupon || structured?.coupon_applied || structured?.coupon_code ||
    structured?.data?.coupon_code || '';
  if (suggested) add(suggested, 'swiggy_suggested', null, 0);
  if (previousAutoCoupon) add(previousAutoCoupon, 'previous', null, 20);

  const feed = Array.isArray(mcpCoupons?.structured?.coupons) ? mcpCoupons.structured.coupons
    : Array.isArray(mcpCoupons?.structuredContent?.coupons) ? mcpCoupons.structuredContent.coupons : [];
  const ineligible = new Set();
  for (const cp of feed) {
    const code = cp?.coupon_code || cp?.couponCode || cp?.code || '';
    const applicable = cp?.is_applicable !== false && cp?.applicable !== false;
    if (!applicable) { if (code) ineligible.add(String(code).toUpperCase()); continue; }
    const saving = extractCouponSaving(cp, itemTotal);
    const flagged = cp?.best_offer === true || cp?.bestOffer === true || cp?.recommended === true ||
      cp?.is_best === true || /best|super\s?saver/i.test(String(cp?.title || cp?.header || ''));
    add(code, flagged ? 'feed_best' : 'feed', saving, flagged ? 15 : 30);
  }
  for (const blob of [mcpCoupons?.structured, mcpCoupons?.structuredContent, mcpCart?.structured, mcpCart?.structuredContent]) {
    if (!blob) continue;
    let text = '';
    try { text = JSON.stringify(blob); } catch { continue; }
    for (const m of text.matchAll(/"(?:auto_?suggested_?coupon|best_?coupon_?code|coupon_?applied)"\s*:\s*"([A-Za-z0-9_-]{3,28})"/g)) {
      add(m[1], 'swiggy_suggested', null, 5);
    }
  }
  const ranked = [...candidates.values()]
    .filter(c => !ineligible.has(c.code))
    .sort((a, b) => b.score - a.score || a.trust - b.trust || a.code.localeCompare(b.code));
  const winner = ranked[0] || null;
  return winner ? { code: winner.code, source: winner.source, estimatedSaving: winner.saving, considered: ranked.length } : null;
}

/** Bill card par chhoti sachchi line — claim ko "cash lag gaya" kabhi nahi bolte. */
export function instantOfferNote({ campaignCash = 0, walletSplit = 0, walletDeducted = 0,
  activeClaims = 0, claimFailed = false, couponCode = '' } = {}) {
  if (campaignCash > 0) return `Free Cash ₹${campaignCash} Swiggy cart me auto-applied.`;
  if (walletDeducted > 0) return `Swiggy Money ₹${walletDeducted} Swiggy cart me auto-applied.`;
  if (walletSplit > 0) return `₹${walletSplit} Swiggy Money split-pay eligible; QR par amount verify karein.`;
  const code = /^[A-Z0-9_-]{3,28}$/.test(String(couponCode)) ? couponCode : '';
  if (activeClaims > 0) return `Night/Breakfast claim verified; is cart par Free Cash ₹0${code ? ` (${code} ke saath)` : ''}.`;
  if (claimFailed) return 'Free Cash claim ka jawab nahi mila; bill me sirf Swiggy ka asli cash dikhta hai.';
  return 'Is cart par Swiggy ne Free Cash ₹0 diya — balance hona discount nahi hai.';
}

function resolveCoords(address) {
  if (!isValidIndianDeliveryCoordinates(address?.lat, address?.lng)) {
    throw badRequest('Select an address with a verified map location first.');
  }
  return { lat: String(address.lat), lng: String(address.lng) };
}

/**
 * Swiggy-style instant quote. Return shape bilkul `quoteCart` jaisa hai, isliye
 * `saveProviderQuote` / checkout / UI me koi badlav nahi chahiye.
 */
export async function quoteInstantCart(account, address, cart, coupon = '', options = {}) {
  const startedAt = Date.now();
  const { lat, lng } = resolveCoords(address);
  if (!address.name || !normalizeIndianMobileNumber(address.mobile)) {
    throw badRequest('Confirm the receiver name and 10-digit mobile number first.');
  }
  const requestedCoupon = String(coupon || '').trim().toUpperCase();
  const autoCoupon = options.autoCoupon !== false && cart?.autoCoupon !== false;
  const discoveryMs = envMs('PRO_INSTANT_DISCOVERY_MS', 1_400, 300, 4_000);
  const claimMs = envMs('PRO_INSTANT_CLAIM_MS', 1_600, 300, 4_000);
  const writeMs = envMs('PRO_INSTANT_WRITE_MS', 5_000, 1_500, 9_000);
  const restaurantId = String(cart?.restaurantId || '');
  const itemTotal = (Array.isArray(cart?.items) ? cart.items : [])
    .reduce((sum, i) => sum + (Number(i?.price) || 0) * (Number(i?.qty ?? i?.quantity) || 0), 0);
  const engine = {
    instantAuto: true, phase: 'instant', offersClaimed: 0, offersNote: '',
    oneLite: 'skipped_instant', couponTrials: [], couponsSeen: 0, notes: [],
    offerTracks: [], autoOffer: { source: '', code: '', ms: 0, discoveryMs: 0, claimMs: 0, cartWrites: 0 }
  };

  // ── 1. Teen kaam EK SAATH: address, coupon feed, free-cash claim ──────────
  const addressDigest = String(options.addressDigest || '');
  const addressPromise = (async () => {
    const prior = cart?.confirmedAddress && Number(cart.confirmedAddress.savedAt || 0) > Date.now() - Number(options.addressTtlMs || 10 * 60_000)
      && cart.confirmedAddress.fingerprint === addressDigest ? cart.confirmedAddress : null;
    if (prior?.id && sameDeliveryRecipient(address, prior)) {
      return { confirmedAddress: prior, addressId: String(prior.id), reused: true };
    }
    const listed = await fetchAccountAddresses(account).catch(() => null);
    const saved = await saveAddressToAccount(account, address, Array.isArray(listed) ? listed : null);
    if (!saved?.addressId || !saved?.addressDetails) throw unavailable(saved?.error || 'Swiggy did not confirm the delivery address.');
    const addressId = String(saved.addressId);
    let confirmedAddress = null;
    if (Array.isArray(listed) && saved.createdNew !== true) {
      const reused = listed.find(a => String(a.id || '') === addressId);
      if (reused && sameDeliveryRecipient(address, { ...reused, mobile: reused.mobile || reused.phone || '' })) {
        confirmedAddress = { ...reused, id: addressId, mobile: normalizeIndianMobileNumber(reused.mobile || reused.phone || '') };
      }
    }
    if (!confirmedAddress) {
      const savedList = await fetchAccountAddresses(account);
      confirmedAddress = savedList.find(a => String(a.id || '') === addressId);
    }
    if (!confirmedAddress || !sameDeliveryRecipient(address, confirmedAddress)) {
      throw unavailable('Swiggy did not read back the same receiver, street and location. No bill or order was created.');
    }
    return { confirmedAddress, addressId, reused: false };
  })();

  // Isi ID+restaurant+par pehle verify hua coupon ho to feed ka koi call hi
  // nahi — Swiggy ka code seedha pehle cart write me jata hai (0ms discovery).
  const preVerified = !requestedCoupon && autoCoupon ? verifiedCouponFor(account, restaurantId, itemTotal) : null;
  const discoveryPromise = !requestedCoupon && autoCoupon && !preVerified ? Promise.all([
    callSwiggyFoodMcpTool(account, 'fetch_food_coupons', { restaurantId, addressId: String(address?.id || '') }, Math.min(discoveryMs, 1_800)).catch(() => null),
    callSwiggyFoodMcpTool(account, 'get_food_cart', { addressId: String(address?.id || '') }, Math.min(discoveryMs, 1_800)).catch(() => null),
    dapiFetch(account, `offers/restaurant?lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`, { lat, lng, timeoutMs: Math.min(discoveryMs, 1_600) }).catch(() => null),
    dapiFetch(account, `offers/payment?lat=${lat}&lng=${lng}&restaurantId=${restaurantId}&cart_value=${Math.round(itemTotal || 250)}&sourcePage=cart&page_type=PAYMENT_OFFERS_PAGE`, { lat, lng, timeoutMs: Math.min(discoveryMs, 1_800) }).catch(() => null)
  ]) : Promise.resolve([null, null, null, null]);

  const claimPromise = activateAllEventOffers(account, {
    offerKeys: ['lateNight', 'breakfast'], requestTimeoutMs: Math.min(1_200, claimMs),
    maxRetries: 0, deadlineAt: Date.now() + claimMs, parallelOffers: true,
    currentWindowOnly: true, skipIfRunInFlight: true
  }).catch(err => ({ success: false, reason: String(err?.message || err).slice(0, 120) }));

  const [discovery, claimResult, confirmed] = await Promise.all([
    bounded(discoveryPromise, discoveryMs, [null, null, null, null]),
    bounded(claimPromise, claimMs, null),
    addressPromise // required: address verify na ho to bill jhootha hoga
  ]);
  const { confirmedAddress, addressId } = confirmed;
  engine.autoOffer.addressReused = confirmed.reused === true;

  const claimSummary = claimResult?.summary || {};
  const activeClaims = Number(claimSummary.claimed || 0) + Number(claimSummary.alreadyActive || 0);
  engine.offersClaimed = Number(claimSummary.claimed || 0);
  engine.offersNote = claimResult === null ? 'Free Cash claim ka jawab time par nahi aaya — bill me sirf Swiggy ka asli cash.'
    : claimResult?.success === false ? 'Free Cash claim nahi hua; bill me sirf Swiggy ka asli cash.'
      : activeClaims > 0 ? `${activeClaims} Night/Breakfast claim verified; cash sirf Swiggy cart se dikhta hai.`
        : 'Is cart par koi naya Free Cash claim nahi hua.';
  engine.offerTracks = ['lateNight', 'breakfast'].map(key => {
    const rec = claimResult?.offers?.[key];
    return { key, label: key === 'lateNight' ? 'Night' : 'Breakfast', status: String(rec?.status || ''), verified: rec?.verified === true, alreadyActive: rec?.alreadyActive === true };
  });

  // ── 2. Swiggy ka best coupon: EK code, zero blind trials ─────────────────
  const [mcpCoupons, mcpCart, offersRest, offersPay] = Array.isArray(discovery) ? discovery : [null, null, null, null];
  const feedCodes = [];
  for (const blob of [offersRest?.json, offersPay?.json]) {
    if (!blob) continue;
    try {
      for (const m of JSON.stringify(blob).matchAll(/"coupon_?code"\s*:\s*"([A-Za-z0-9_-]{3,28})"/g)) feedCodes.push(m[1]);
    } catch { /* optional */ }
  }
  engine.couponsSeen = (Array.isArray(mcpCoupons?.structured?.coupons) ? mcpCoupons.structured.coupons.length : 0) + feedCodes.length;
  const choice = requestedCoupon
    ? { code: requestedCoupon, source: 'user', estimatedSaving: null, considered: 1 }
    : selectInstantCoupon({
      mcpCoupons, mcpCart, itemTotal,
      previousAutoCoupon: String(options.previousAutoCoupon || ''),
      verified: preVerified
    });
  engine.autoOffer.source = choice?.source || 'none';
  engine.autoOffer.code = choice?.code || '';
  engine.autoOffer.considered = choice?.considered || 0;

  // ── 3. Cart write + readback (har optional failure yahin absorb hoti hai) ─
  const itemsPayload = buildSwiggyCartItemsPayload(cart.items);
  const ofoFields = cart.forSomeoneElse ? buildOfoCartFields({ addressDetails: address }) : {};
  const subscriptionItems = Array.isArray(cart.activeSubscriptionItems) ? cart.activeSubscriptionItems : [];
  let cartInitialized = false;
  let lastReadback = null;
  const acceptCart = out => {
    if (!okCode(out?.json?.statusCode)) {
      const msg = String(out?.json?.statusMessage || '').slice(0, 120) || `HTTP ${out?.status || '?'}`;
      throw unavailable(`Swiggy ne cart update reject kiya (${msg}).`);
    }
    const data = out?.json?.data;
    const meta = data?.cartMeta || data;
    const parsed = data ? parseDapiCartPayload(data) : null;
    if (!parsed || !meta || !Array.isArray(parsed.items)) throw unavailable('Swiggy did not confirm the cart. Refresh in Swiggy before trying again.');
    const boundAddress = String(meta.address_id || meta.delivery_address?.id || data.address_id || data.delivery_address?.id || '');
    const itemsMatch = sameCartItems(cart.items, parsed.items);
    if (!itemsMatch || boundAddress !== addressId) {
      const err = unavailable(!itemsMatch
        ? 'Swiggy cart me alag items/variants aaye. Bill nahi dikhaya; cart check karke dobara sync karein.'
        : 'Swiggy cart naye delivery address se abhi bind nahi hua. Bill nahi dikhaya; dobara sync karein.');
      err.code = !itemsMatch ? 'CART_ITEMS_MISMATCH' : 'CART_ADDRESS_MISMATCH';
      throw err;
    }
    const rawCartTotal = Number(meta.order_total);
    const total = Number(parsed.finalPayable ?? meta.order_total);
    if (total === 0 && rawCartTotal > 0) throw unavailable('Free Cash se poora bill cover ho raha hai. Zero-amount payment yahan supported nahi hai; Swiggy app me checkout karein.');
    if (exactPaise(rawCartTotal) === null || rawCartTotal <= 0 || exactPaise(total) === null || total <= 0) {
      throw unavailable('Swiggy did not return a valid payable amount.');
    }
    lastReadback = {
      parsed, meta, total,
      coupon: String(parsed?.couponCode || '').toUpperCase(),
      couponReason: String(out?.json?.statusMessage || parsed?.couponReason || '').slice(0, 140)
    };
    return lastReadback;
  };
  const readCart = async (timeoutMs = 3_500) => acceptCart(
    await swiggyCartGet(account, { lat, lng, timeoutMs }).catch(() => ({ status: 0, json: null }))
  );
  const writeCart = async (code, timeoutMs = writeMs) => {
    engine.autoOffer.cartWrites += 1;
    const out = await swiggyCartUpdate(account, {
      restaurantId, address_id: addressId, couponCode: code,
      cartItems: itemsPayload, mealItems: [], subscriptionItems, ...ofoFields
    }, { lat, lng, flushFirst: !cartInitialized, timeoutMs }).catch(() => ({ status: 0, json: null }));
    cartInitialized = true;
    const data = out?.json?.data;
    const hasCart = Boolean(okCode(out?.json?.statusCode) && data?.cartMeta && Array.isArray(data?.cartMeta?.cart_menu_items));
    let snapshot;
    try {
      snapshot = hasCart ? acceptCart(out) : await readCart(Math.min(timeoutMs, 4_000));
    } catch (err) {
      // /update purana address/items bhej sakta hai — ek GET se pakka karo.
      if (!['CART_ITEMS_MISMATCH', 'CART_ADDRESS_MISMATCH'].includes(err?.code)) throw err;
      snapshot = await readCart(Math.min(timeoutMs, 4_000));
    }
    const settled = code && snapshot.coupon === code && Number(snapshot.parsed?.discountAmount || 0) > 0;
    if (code && !settled && engine.autoOffer.cartWrites < 3) {
      // Bulk endpoint kabhi couponCode ignore kar deta hai — Swiggy ka dedicated
      // endpoint EK baar, phir verified readback. Fail = coupon nahi laga, bill
      // phir bhi wahi (error nahi, jhootha "applied" bhi nahi).
      const applied = await applySwiggyCartCoupon(account, { couponCode: code, addressId, lat, lng, timeoutMs: Math.min(1_800, timeoutMs) }).catch(() => null);
      if (okCode(applied?.json?.statusCode) && applied?.json?.data) {
        try { snapshot = acceptCart(applied); } catch { /* neeche GET */ }
      }
      if (!(snapshot.coupon === code && Number(snapshot.parsed?.discountAmount || 0) > 0)) {
        try { snapshot = await readCart(Math.min(timeoutMs, 3_000)); } catch { /* last verified snapshot hi sach hai */ }
      }
    }
    if (code && !(snapshot.coupon === code && Number(snapshot.parsed?.discountAmount || 0) > 0)) {
      snapshot.couponReason = String(snapshot.couponReason || 'Swiggy ne is cart par ye coupon accept nahi kiya.').slice(0, 140);
      engine.couponTrials.push({ code, ok: false, discount: 0, total: snapshot.total, reason: snapshot.couponReason });
    } else if (code) {
      engine.couponTrials.push({ code, ok: true, discount: Number(snapshot.parsed.discountAmount), total: snapshot.total, reason: '' });
    }
    return snapshot;
  };

  let best = null;
  let couponReason = '';
  let writeUncertain = false;
  try {
    best = await writeCart(choice?.code || '', writeMs);
  } catch (firstErr) {
    // Chosen code ke saath write hi fail ho jaye to bina coupon ek hi retry —
    // bill phir bhi aata hai, user ko "error" nahi.
    if (!choice?.code) throw firstErr;
    engine.notes.push('best coupon write fail — plain cart se verified bill');
    writeUncertain = true;
    best = await writeCart('', writeMs);
    if (lastReadback) best = lastReadback;
  }
  if (choice?.code && best.coupon !== choice.code) couponReason = best.couponReason;
  // Swiggy ne readback me apna best code suggest kiya ho (feed empty thi) to
  // EK targeted write — aur koi ladder nahi.
  if (!requestedCoupon && autoCoupon && !choice?.code && best.parsed?.suggestedCouponCode && engine.autoOffer.cartWrites < 3) {
    const suggested = String(best.parsed.suggestedCouponCode).toUpperCase();
    try {
      const attempt = await writeCart(suggested, Math.min(writeMs, 3_500));
      if (attempt.coupon === suggested && Number(attempt.parsed?.discountAmount || 0) > 0) {
        engine.autoOffer.source = 'cart_suggested';
        engine.autoOffer.code = suggested;
      }
      best = lastReadback || attempt; // hamesha aakhiri VERIFIED readback
    } catch { writeUncertain = true; /* pehla verified bill hi sach hai */ }
  }
  // Koi write beech me chhuti ho to Swiggy se cart dobara padh kar pakka karo —
  // kabhi purana / andaze ka bill nahi dikhte. Har successful write `lastReadback`
  // update karta hai, isliye yahi final cart state hai.
  if (lastReadback && lastReadback !== best) best = lastReadback;
  if (writeUncertain) {
    try { best = await readCart(Math.min(writeMs, 3_000)); } catch { /* aakhiri verified readback hi sach hai */ }
  }
  if (!best) throw unavailable('Swiggy ne is cart ka bill confirm nahi kiya. Dobara sync karein.');

  const { parsed, meta, total } = best;
  if (best.coupon && Number(parsed.discountAmount || 0) > 0) {
    rememberVerifiedCoupon(account, restaurantId, best.coupon, Number(parsed.discountAmount), itemTotal);
  }
  const campaignCash = Math.max(0, Number(parsed?.campaignFreeCash ?? 0));
  const walletDeducted = Math.max(0, Number(parsed?.swiggyMoneyApplied || 0), Number(meta?.swiggy_money ?? 0) || 0);
  const walletSplit = Math.max(0, Number(parsed?.walletSplitPayAmount || 0));
  const walletApplied = Math.max(walletDeducted, walletSplit);
  const tradeTotal = Math.max(0, Number(parsed?.tradeDiscountTotal ?? 0));
  const merchantDiscount = Math.max(0, tradeTotal - Math.min(campaignCash, tradeTotal));
  const freeCashShown = campaignCash + walletApplied;
  const offerNote = instantOfferNote({
    campaignCash, walletSplit, walletDeducted, activeClaims,
    claimFailed: claimResult === null || claimResult?.success === false,
    couponCode: best.coupon
  });
  engine.freeCash = walletApplied;
  engine.campaignFreeCash = campaignCash;
  engine.freeCashAvailable = Math.max(0, Number(parsed?.freeCashBalance || 0));
  engine.offerNote = offerNote;
  engine.cashOnlyBill = null;
  engine.autoOffer.ms = Date.now() - startedAt;
  engine.autoOffer.discoveryMs = discoveryMs;
  engine.autoOffer.claimMs = claimMs;
  engine.notes.push(`Instant auto-offer: ${engine.autoOffer.cartWrites} cart write, 0 coupon trial ladder, ${engine.autoOffer.ms}ms.`);

  const returnedNumber = (...values) => {
    const raw = values.find(v => v !== undefined && v !== null && v !== '');
    return raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
  };
  return {
    address: confirmedAddress,
    addressFingerprint: addressDigest,
    optimizePending: false,
    ofoConfirmed: false,
    bill: {
      itemTotal: returnedNumber(parsed?.itemTotal, meta.item_total, meta.cart_subtotal),
      deliveryFee: returnedNumber(parsed?.deliveryFee, meta.positiveDeliveryChargesExclusive, meta.delivery_charges),
      deliverySaved: parsed?.freeDeliveryDiscount ?? null,
      deliveryFree: Number(parsed?.deliveryFee ?? 0) <= 0,
      deliveryDistance: String(meta?.delivery_distance || parsed?.deliveryDistance || '').slice(0, 40),
      packingCharges: returnedNumber(parsed?.packingCharges, meta.total_packing_charges),
      taxes: returnedNumber(parsed?.taxesAndCharges, meta.taxesAndCharges, meta.total_tax),
      discount: parsed?.couponCode ? returnedNumber(parsed.discountAmount, meta.coupon_discount_total, meta.coupon_discount_effective) : null,
      coupon: best.coupon,
      couponCode: best.coupon,
      autoCoupon: Boolean(best.coupon) && !requestedCoupon,
      couponTried: engine.couponTrials.map(t => t.code).slice(0, 5),
      couponReason: requestedCoupon && best.coupon !== requestedCoupon ? (couponReason || 'Swiggy ne ye coupon accept nahi kiya.') : '',
      freeCash: freeCashShown > 0 ? freeCashShown : null,
      freeCashWallet: walletApplied > 0 ? walletApplied : null,
      walletSplitPayAmount: walletSplit,
      walletSplitPending: walletSplit > 0 && walletDeducted <= 0,
      freeCashAvailable: Math.max(0, Number(parsed?.freeCashBalance || 0)),
      cashEvidence: {
        balance: parsed?.swiggyMoneyBalanceReported === true ? Math.max(0, Number(parsed?.reportedSwiggyMoneyBalance || 0)) : null,
        eligible: parsed?.swiggyMoneyEligibilityReported === true ? Math.max(0, Number(parsed?.freeCashBalance || 0)) : null,
        cashWithoutCoupon: null, noCouponTotal: null
      },
      tradeDiscount: merchantDiscount > 0 ? merchantDiscount : null,
      oneMembershipFee: parsed?.swiggyOneMembershipFee ?? null,
      oneApplied: parsed?.swiggyOneApplied === true,
      totalSavings: parsed?.totalSavings ?? null,
      subscriptionItems,
      engine,
      offerNote,
      offerTracks: engine.offerTracks,
      autoOfferMode: 'instant',
      autoOfferSource: engine.autoOffer.source,
      autoOfferMs: engine.autoOffer.ms,
      total
    }
  };
}
