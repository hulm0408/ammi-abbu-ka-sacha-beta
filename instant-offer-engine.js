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
 *   2. restaurant ke applicable coupons ka ASLI bill compare karke MAX coupon
 *      chunna (bounded ladder + verified cache; pehla code hi final nahi),
 *   3. One Lite (+₹1) se FREE delivery — sirf jab readback me total sach me
 *      kam ho, warna turant revert,
 *   4. jeetne wala coupon + One Lite ek hi final verified cart write me settle,
 *   5. cart ki readback se hi bill banana. Jo Swiggy ne sach me kata wahi
 *      discount/free cash dikhta hai; koi andaza, koi jhootha "applied" nahi.
 *
 * Boss (03-11-2026, agla round): "free cash ko mat chedna wo theek hogaya bas
 * one lite free delivery usko sahi kar and auto jo coupon ho restaurant par
 * max usko sahi kar" — free cash ka claim/readback/note/bill code yahan waisa
 * hi hai; badlav sirf coupon max-verification + One Lite cart write me.
 *
 * Guarantee:
 *   • verified cache wala bill = 1 cart write / 0 discovery calls / 0 trials;
 *     naya bill bhi bounded ladder (max 10 trials / 4.5s) me MAX pakka karta hai,
 *     blind promo-code list kabhi nahi.
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
 * Restaurant ke coupons ko rank karta hai. Pehla code pehle cart write me
 * jata hai, baaki `candidates` me rehte hain taaki engine unka ASLI bill
 * compare karke MAX coupon pakka kar sake (blind promo list kabhi nahi).
 * Priority: sabse bada likha hua discount > Swiggy ka auto-suggested >
 * feed ka "best" flag > pehle verified > pichhla auto coupon > feed codes.
 * Ye sirf pehle write ki ranking hai; final MAX verified bill comparison se
 * pakka hota hai (neeche 3a), isliye galat ranking bhi bill nahi bigadti.
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
    // Jis coupon ka discount likha hai wo sabse pehle; Swiggy ka suggested
    // bhi upar, par kisi ₹150 wale code ko andhe se override nahi karta.
    const score = saving !== null ? 30_000 + Number(saving)
      : source === 'swiggy_suggested' ? 20_000
        : source === 'feed_best' ? 8_000
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
  return {
    code: winner?.code || '', source: winner?.source || '', estimatedSaving: winner?.saving ?? null,
    considered: ranked.length, candidates: ranked, ineligible: [...ineligible]
  };
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
  // Restaurant ka MAX coupon: applicable codes ka asli bill compare, par
  // strict budget me. Verified winner cache agle bill ko 1-write bana deta hai.
  const maxTrials = Math.max(1, Math.min(Number(process.env.PRO_INSTANT_MAX_COUPON_TRIALS) || 10, 20));
  const maxBudgetMs = envMs('PRO_INSTANT_MAX_COUPON_BUDGET_MS', 4_500, 1_000, 12_000);
  const restaurantId = String(cart?.restaurantId || '');
  const itemTotal = (Array.isArray(cart?.items) ? cart.items : [])
    .reduce((sum, i) => sum + (Number(i?.price) || 0) * (Number(i?.qty ?? i?.quantity) || 0), 0);
  const engine = {
    instantAuto: true, phase: 'instant', offersClaimed: 0, offersNote: '',
    oneLite: 'not_tried', couponTrials: [], couponsSeen: 0, notes: [],
    offerTracks: [], autoOffer: { source: '', code: '', ms: 0, discoveryMs: 0, claimMs: 0, cartWrites: 0, couponTrials: 0, maxVerifiedDiscount: 0 }
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

  // ── 2. Restaurant ke coupons: ranked list (pehla code + verified trials) ──
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
    ? { code: requestedCoupon, source: 'user', estimatedSaving: null, considered: 1, candidates: [], ineligible: [] }
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
  // One Lite sub yahan mutable hai: final write me add / revert hota hai aur
  // bill me wahi final sub jata hai (checkout usi ke saath place hota hai).
  let subscriptionItems = Array.isArray(cart.activeSubscriptionItems) ? cart.activeSubscriptionItems : [];
  let cartInitialized = false;
  let lastReadback = null;
  let applyAttempts = 0;
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
    const updatePayload = {
      restaurantId, address_id: addressId, couponCode: code,
      cartItems: itemsPayload, mealItems: [], subscriptionItems, ...ofoFields
    };
    const out = await swiggyCartUpdate(account, updatePayload, { lat, lng, flushFirst: !cartInitialized, timeoutMs })
      .catch(() => ({ status: 0, json: null }));
    cartInitialized = true;
    const data = out?.json?.data;
    const hasCart = Boolean(okCode(out?.json?.statusCode) && data?.cartMeta && Array.isArray(data?.cartMeta?.cart_menu_items));
    let snapshot;
    try {
      snapshot = hasCart ? acceptCart(out) : await readCart(Math.min(timeoutMs, 4_000));
    } catch (err) {
      // /update purana address/items bhej sakta hai — ek GET se pakka karo.
      if (!['CART_ITEMS_MISMATCH', 'CART_ADDRESS_MISMATCH'].includes(err?.code)) throw err;
      try {
        snapshot = await readCart(Math.min(timeoutMs, 4_000));
      } catch (readErr) {
        if (!['CART_ITEMS_MISMATCH', 'CART_ADDRESS_MISMATCH'].includes(readErr?.code)) throw readErr;
        // Error ka apna hi ilaj: "cart check karke dobara sync karein".
        // Confirmed GET phir bhi alag hai — wahi approved cart ek aur baar
        // (bina flush; pehla write cart already replace kar chuka tha) aur
        // uske baad hi verified readback. Bounded: ek hi retry — persistent
        // mismatch ab bhi fail hota hai, loop nahi.
        engine.autoOffer.cartWrites += 1;
        const resync = await swiggyCartUpdate(account, updatePayload, { lat, lng, flushFirst: false, timeoutMs })
          .catch(() => ({ status: 0, json: null }));
        const rData = resync?.json?.data;
        const rHasCart = Boolean(okCode(resync?.json?.statusCode) && rData?.cartMeta && Array.isArray(rData?.cartMeta?.cart_menu_items));
        try {
          snapshot = rHasCart ? acceptCart(resync) : await readCart(Math.min(timeoutMs, 4_000));
        } catch {
          // Aakhiri GET hi sach hai — uska mismatch seedha bahar jayega.
          snapshot = await readCart(Math.min(timeoutMs, 4_000));
        }
      }
    }
    const settled = code && snapshot.coupon === code && Number(snapshot.parsed?.discountAmount || 0) > 0;
    if (code && !settled && applyAttempts < maxTrials + 2) {
      // Bulk endpoint kabhi couponCode ignore kar deta hai — Swiggy ka dedicated
      // endpoint EK baar, phir verified readback. Fail = coupon nahi laga, bill
      // phir bhi wahi (error nahi, jhootha "applied" bhi nahi). Har coupon ke
      // liye ek baar, poore ladder me bounded.
      applyAttempts += 1;
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
  if (lastReadback && lastReadback !== best) best = lastReadback;

  // ── 3a. Restaurant ka MAX coupon: applicable codes ka ASLI bill compare ──
  // Feed ka likha hua discount sirf ranking hai; jeet tabhi maani jati hai jab
  // Swiggy ki readback me coupon + discount dono confirm ho. Jin codes ka
  // discount likha nahi hai (ya Swiggy ne suggest kiya hai), unka live bill
  // zarur check hota hai — strict trial/time budget ke andar.
  let winner = {
    code: String(best.coupon || '').toUpperCase(),
    total: Number(best.total),
    discount: Math.max(0, Number(best.parsed?.discountAmount || 0)),
    source: best.coupon && best.coupon === choice?.code ? choice?.source : ''
  };
  let maxVerifiedDiscount = winner.discount;
  const blocked = new Set((choice?.ineligible || []).map(c => String(c).toUpperCase()));
  const candidateList = [];
  const pushCandidate = (code, source, saving = null, trust = 50) => {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,28}$/.test(clean) || blocked.has(clean)) return;
    if (candidateList.some(c => c.code === clean)) return;
    candidateList.push({ code: clean, source, saving, trust });
  };
  for (const cand of (choice?.candidates || [])) pushCandidate(cand.code, cand.source, cand.saving, cand.trust);
  for (const code of feedCodes) pushCandidate(code, 'offer_feed');
  if (best.parsed?.suggestedCouponCode) pushCandidate(best.parsed.suggestedCouponCode, 'cart_suggested');
  const savingOf = c => (c.saving === null || c.saving === undefined || !Number.isFinite(Number(c.saving)) ? -1 : Number(c.saving));
  candidateList.sort((a, b) => savingOf(b) - savingOf(a) || a.trust - b.trust || a.code.localeCompare(b.code));
  const tried = new Set([String(choice?.code || '').toUpperCase()].filter(Boolean));
  const trialStarted = Date.now();
  for (const cand of candidateList) {
    if (tried.has(cand.code)) continue;
    const remainingMs = maxBudgetMs - (Date.now() - trialStarted);
    if (engine.autoOffer.couponTrials >= maxTrials || remainingMs <= 0) {
      engine.notes.push('max-coupon trial budget khatam — jo verify hua wahi final');
      break;
    }
    // Sirf tab skip jab likha hua discount (upper bound) verified discount se
    // chhota ho. Unknown-saving / Swiggy-suggested codes ka live bill zarur.
    if (cand.saving !== null && cand.saving !== undefined && Number(cand.saving) <= maxVerifiedDiscount + 0.005
      && !['swiggy_suggested', 'feed_best', 'cart_suggested'].includes(cand.source)) {
      engine.notes.push(`${cand.code}: estimated ₹${cand.saving} ≤ verified ₹${maxVerifiedDiscount} — skip`);
      continue;
    }
    tried.add(cand.code);
    engine.autoOffer.couponTrials += 1;
    try {
      const attempt = await writeCart(cand.code, Math.min(writeMs, Math.max(1_500, remainingMs)));
      if (attempt.coupon === cand.code && Number(attempt.parsed?.discountAmount || 0) > 0) {
        const discount = Number(attempt.parsed.discountAmount);
        maxVerifiedDiscount = Math.max(maxVerifiedDiscount, discount);
        if (attempt.total < winner.total - 0.005 || discount > winner.discount + 0.005) {
          winner = { code: cand.code, total: Number(attempt.total), discount, source: cand.source };
        }
      }
    } catch (err) {
      engine.notes.push(`${cand.code}: ${String(err?.message || err).slice(0, 80)}`);
      writeUncertain = true;
    }
  }
  engine.autoOffer.maxVerifiedDiscount = maxVerifiedDiscount;
  if (winner.code && engine.autoOffer.couponTrials > 0) {
    engine.autoOffer.source = winner.source === 'cart_suggested' ? 'cart_suggested' : 'max_verified';
  }
  if (!winner.code) engine.autoOffer.source = 'none';
  engine.autoOffer.code = winner.code;

  // ── 3b. Final write: MAX coupon + One Lite FREE delivery settle ──────────
  // Trials cart me koi doosra code chhod de to yahin winner wapas lagta hai.
  // One Lite bhi isi write me try hota hai: readback me total sach me kam na ho
  // to ek write me revert. Bill aur Swiggy cart hamesha ek hi state me rehte.
  best = lastReadback || best;
  const noOneTotal = Number(best.total);
  const needsSettle = Boolean(lastReadback && String(lastReadback.coupon || '').toUpperCase() !== winner.code);
  const deliveryFee = Number(best.parsed?.deliveryFee || 0);
  const oneFeeAlready = Number(best.parsed?.swiggyOneMembershipFee || 0);
  let oneLiteSub = null;
  if (cart.autoOneLite !== false && deliveryFee > 1 && oneFeeAlready <= 0 && !subscriptionItems.length) {
    const planId = String(best.parsed?.eligibleSuperPlan?.planId || '773').trim() || '773';
    oneLiteSub = [{ plan_id: planId, quantity: 1 }];
  } else {
    engine.oneLite = oneFeeAlready > 0 || subscriptionItems.length ? 'already_applied'
      : cart.autoOneLite === false ? 'disabled' : 'not_needed';
  }
  if (needsSettle || oneLiteSub) {
    const codeToSettle = winner.code;
    // Deep engine ki tarah: eligible Super plan, phir '773' fallback. Jo bhi
    // readback me delivery FREE + sasta total de, wahi rehta hai.
    const planIds = oneLiteSub ? [...new Set([String(oneLiteSub[0].plan_id), '773'].filter(Boolean))] : [];
    try {
      if (!oneLiteSub) {
        best = await writeCart(codeToSettle, writeMs); // sirf winner coupon settle
      } else {
        let kept = false;
        for (const planId of planIds) {
          subscriptionItems = [{ plan_id: planId, quantity: 1 }];
          const attempt = await writeCart(codeToSettle, writeMs);
          const oneFee = Number(attempt.parsed?.swiggyOneMembershipFee || 0);
          const deliveryNow = Number(attempt.parsed?.deliveryFee || 0);
          if (oneFee > 0 && deliveryNow <= 0 && attempt.total < noOneTotal - 0.005) {
            best = attempt;
            engine.oneLite = 'applied';
            kept = true;
            break;
          }
          engine.notes.push(`One Lite plan ${planId} ne delivery FREE nahi ki`);
        }
        if (!kept) {
          // FREE ka jhooth nahi: membership wapas hata kar verified bill.
          engine.oneLite = 'not_profitable';
          subscriptionItems = [];
          best = await writeCart(codeToSettle, writeMs);
        }
      }
    } catch {
      engine.notes.push('final coupon/One Lite write fail — verified bill rakha');
      if (oneLiteSub) {
        subscriptionItems = [];
        engine.oneLite = 'failed';
        try { best = await writeCart(codeToSettle, writeMs); } catch { writeUncertain = true; }
      } else writeUncertain = true;
    }
  }
  // Koi write beech me chhuti ho to Swiggy se cart dobara padh kar pakka karo —
  // kabhi purana / andaze ka bill nahi dikhte.
  if (lastReadback && lastReadback !== best) best = lastReadback;
  if (writeUncertain) {
    try { best = await readCart(Math.min(writeMs, 3_000)); } catch { /* aakhiri verified readback hi sach hai */ }
  }
  if (!best) throw unavailable('Swiggy ne is cart ka bill confirm nahi kiya. Dobara sync karein.');
  // Diagnostics bhi aakhiri verified cart state bolte hain, purana plan nahi.
  engine.autoOffer.code = String(best.coupon || '');
  if (!best.coupon) engine.autoOffer.source = 'none';
  // Checkout ko wahi subscription state bhejo jo Swiggy ke final cart me hai.
  const finalOneFee = Number(best.parsed?.swiggyOneMembershipFee || 0);
  if (finalOneFee > 0 && !subscriptionItems.length) {
    const planId = String(best.parsed?.eligibleSuperPlan?.planId || '773').trim() || '773';
    subscriptionItems = [{ plan_id: planId, quantity: 1 }];
    if (engine.oneLite === 'not_tried') engine.oneLite = 'already_applied';
  } else if (finalOneFee <= 0 && subscriptionItems.length) {
    subscriptionItems = [];
  }

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
  engine.notes.push(`Instant auto-offer: ${engine.autoOffer.cartWrites} cart write, ${engine.autoOffer.couponTrials} max-coupon trial, One Lite ${engine.oneLite}, ${engine.autoOffer.ms}ms.`);

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
      couponTried: [...new Set(engine.couponTrials.map(t => t.code))].slice(0, 5),
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
