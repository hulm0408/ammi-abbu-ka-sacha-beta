/**
 * event-offers.js — Swiggy ke CHAAR offer links, har JSON import par activate.
 *
 * Boss (26-10-2026 raat) ne chaar link diye:
 *   1. pick-your-late-night-offer   (boss: "Morning Link")
 *   2. book-your-offer              (boss: "Night Link")
 *   3. pick-your-offer              ("Extra 50 Link")
 *   4. byo-weekend                  ("Weekend Link")
 *   — "JAB BHI FILE BHEJU SAARE OFFER ACTIVATE HONE CHAHIYE"
 *
 * Pehle sirf PEHLE DO claim hote the, aur ek hi offer par dobara-dobara claim
 * bhi chala jata tha ("2 times claim ho rha tha"). Yeh module:
 *   • chaaron links ke campaign id LIVE page se nikalta hai (prefix + day number),
 *   • har campaign ka asli state GET se padhta hai — pehle se sahi hai to KUCH
 *     likhta hi nahi (isliye double claim nahi hota),
 *   • likhne ke baad ek aur GET se read-back verify karta hai (HTTP 200 = claim
 *     nahi; sirf shouldNotify:true && value:1 sach hai),
 *   • ek hi account par ek waqt me ek hi claim run (import + cart scan + prebook
 *     sab ek hi promise share karte hain),
 *   • jo nahi hua, uska asli reason deta hai (koi jhoota "✓ sab ho gaya" nahi).
 *
 * Pure-ish: fetch inject kiya ja sakta hai (`fetchImpl`) — tests offline chalti hain.
 */

const EVENTS_API = 'https://events.swiggy.com/api/notify';
export const PREFERRED_OFFER_VALUE = 1;
export const PREFERRED_OFFER_LABEL = '₹50 off on ₹199';

export const EVENT_OFFER_OPTIONS = {
  1: { value: 1, shortLabel: '₹50 Free Cash (>₹199)' },
  2: { value: 2, shortLabel: '₹150 OFF Coupon (>₹249)' },
  3: { value: 3, shortLabel: '₹175 LN / ₹100 BF Coupon' },
  4: { value: 4, shortLabel: '₹100 OFF Coupon (>₹149)' }
};

/**
 * Chaar offers. `windowed` = campaign id me day number hota hai (aaj + kal
 * pre-lock); warna page se mila fixed campaign id hi chalta hai.
 */
export const EVENT_OFFERS = [
  {
    key: 'lateNight',
    bossLabel: 'Morning Link',
    name: 'Late Night (9PM–6AM slot)',
    url: 'https://events.swiggy.com/pick-your-late-night-offer',
    slug: 'pick-your-late-night-offer',
    prefixHint: 'byo-ln-v5-',
    windowed: true,
    isLateNight: true,
    cutoffH: 7.5,
    slotOpenH: 10,
    slotCloseH: 19
  },
  {
    key: 'breakfast',
    bossLabel: 'Night Link',
    name: 'Breakfast (7AM–11AM slot)',
    url: 'https://events.swiggy.com/book-your-offer',
    slug: 'book-your-offer',
    prefixHint: 'byo-bf-v10-',
    windowed: true,
    isLateNight: false,
    cutoffH: 18,
    slotOpenH: 20,
    slotCloseH: 24
  },
  {
    key: 'extra50',
    bossLabel: 'Extra 50 Link',
    name: 'Extra ₹50 offer',
    url: 'https://events.swiggy.com/pick-your-offer',
    slug: 'pick-your-offer',
    prefixHint: '',
    windowed: false
  },
  {
    key: 'weekend',
    bossLabel: 'Weekend Link',
    name: 'Weekend offer',
    url: 'https://events.swiggy.com/byo-weekend',
    slug: 'byo-weekend',
    prefixHint: '',
    windowed: false
  }
];

export const EVENT_OFFER_LINKS = Object.fromEntries(EVENT_OFFERS.map((o) => [o.key, o.url]));
export const EVENT_OFFER_KEYS = EVENT_OFFERS.map((o) => o.key);

export function getEventOffer(key) {
  return EVENT_OFFERS.find((o) => o.key === key) || null;
}

// ── campaign id discovery ────────────────────────────────────────────────────

const DAY_SUFFIX_RE = /-(\d{1,3})$/;
// Swiggy ke campaign ids `byo-<slug>-v<n>-<day>` (windowed) ya `byo-<slug>[-v<n>]`
// (fixed) hote hain. Regex GREEDY rakho — lazy hone se `byo-pick-your-offer-v2-26`
// `byo-pick` ban jata tha (asli bug, test ne pakda).
const CAMPAIGN_TOKEN_RE = /byo-[a-z0-9][a-z0-9-]*/gi;

/** HTML/JSON se sabse sahi campaign id candidates (lamba pehle). */
export function scanCampaignTokens(text) {
  const raw = String(text || '').match(CAMPAIGN_TOKEN_RE) || [];
  const cleaned = [...new Set(raw.map((t) => t.replace(/-+$/, '').toLowerCase()))].filter((t) => t.length > 4);
  return cleaned.sort((a, b) => b.length - a.length);
}

function pickBestToken(tokens, offer) {
  const windowed = tokens.find((t) => /-v\d+-\d{1,3}$/.test(t));
  const versioned = tokens.find((t) => /-v\d+$/.test(t));
  const slugMatch = offer?.slug ? tokens.find((t) => t.includes(offer.slug)) : null;
  const exact = windowed || versioned || slugMatch || tokens[0] || '';
  if (!exact) return { prefix: '', fixed: '', token: '' };
  // Windowed offer (LN/BF) me day number badalta hai -> prefix chahiye.
  // Fixed offer (extra ₹50 / weekend) me page jo id de wahi asli hai — uska
  // day-number se anumaan NAHI lagate.
  if (offer?.windowed && windowed) {
    return { prefix: windowed.replace(DAY_SUFFIX_RE, '-'), fixed: '', token: windowed };
  }
  if (offer?.windowed && versioned) {
    // `byo-ln-v6` mila (day number ke bina) — prefix banao.
    return { prefix: `${versioned}-`, fixed: '', token: versioned };
  }
  return { prefix: '', fixed: exact, token: exact };
}

/**
 * Page HTML se campaign info nikalo. Swiggy ke offer pages Next.js hain aur
 * `props.pageProps.nexusData` me `notifyCampaignIdPrefix` + `dayBoundaries`
 * dete hain. Na mile to HTML ke andar `byo-...` tokens scan karte hain, aur
 * aakhri fallback slug-based prefix hota hai (source me likha jata hai).
 */
export function extractCampaignInfoFromHtml(html, offer) {
  const text = String(html || '');
  const out = { prefix: '', fixedCampaignId: '', boundaries: [], source: 'NONE' };

  const nextData = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData[1]);
      const nexus = parsed?.props?.pageProps?.nexusData || {};
      const prefix = String(nexus.notifyCampaignIdPrefix || '').trim();
      const fixed = String(nexus.notifyCampaignId || nexus.campaignId || nexus.campaign_id || '').trim();
      const boundaries = Array.isArray(nexus.dayBoundaries) ? nexus.dayBoundaries : [];
      if (prefix) { out.prefix = prefix; out.source = 'NEXT_DATA'; }
      else if (fixed) { out.fixedCampaignId = fixed; out.source = 'NEXT_DATA'; }
      if (boundaries.length) { out.boundaries = boundaries; out.source = 'NEXT_DATA'; }
      if (!out.prefix && !out.fixedCampaignId) {
        // NexusData ke andar kahin bhi campaign id ho sakti hai — poora JSON scan.
        const best = pickBestToken(scanCampaignTokens(JSON.stringify(nexus)), offer);
        if (best.prefix || best.fixed) {
          out.prefix = best.prefix;
          out.fixedCampaignId = best.fixed;
          out.source = 'NEXT_DATA_SCAN';
        }
      }
    } catch { /* fall through to raw scan */ }
  }

  // `notifyCampaignIdPrefix` page ke kisi bhi JSON blob me ho sakta hai (NEXT_DATA
  // ka exact path Swiggy badalta rehta hai) — seedha text se bhi pakdo.
  if (!out.prefix && !out.fixedCampaignId) {
    const prefixHit = text.match(/"notifyCampaignIdPrefix"\s*:\s*"([^"]+)"/);
    const fixedHit = text.match(/"(?:notifyCampaignId|campaignId|campaign_id)"\s*:\s*"(byo[^"]*)"/i);
    if (prefixHit?.[1]) { out.prefix = prefixHit[1].trim(); out.source = 'PAGE_JSON'; }
    else if (fixedHit?.[1]) { out.fixedCampaignId = fixedHit[1].trim(); out.source = 'PAGE_JSON'; }
  }

  if (!out.prefix && !out.fixedCampaignId) {
    const best = pickBestToken(scanCampaignTokens(text), offer);
    if (best.prefix || best.fixed) {
      out.prefix = best.prefix;
      out.fixedCampaignId = best.fixed;
      out.source = 'HTML_SCAN';
    }
  }

  // Fixed offers (pick-your-offer / byo-weekend) ki campaign id SIRF live page
  // se leni hai. Pehle yahan slug se id "guess" hoti thi (byo-pick-your-offer) —
  // woh galat id par write kar deti thi aur card me jhootha ✓ dikhta tha.
  // Ab: id na mile to khaali chhodo, doctor asli reason batayega.
  if (!out.prefix && !out.fixedCampaignId && offer?.windowed && offer?.prefixHint) {
    out.prefix = offer.prefixHint;
    out.source = 'HINT';
  }

  return out;
}

let _metaCache = null;
let _metaAt = 0;
const META_TTL_MS = 15 * 60 * 1000;

/**
 * Chaaron offer pages ka live meta (prefix / fixed id / day boundaries).
 * Cache 15 min. Page na khula to `source` me sach likha jata hai.
 */
export async function discoverOfferMeta({ force = false, fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (!force && _metaCache && Date.now() - _metaAt < META_TTL_MS) return _metaCache;
  const meta = {};
  for (const offer of EVENT_OFFERS) {
    let info = { prefix: offer.prefixHint || '', fixedCampaignId: '', boundaries: [], source: offer.prefixHint ? 'HINT' : 'NONE', error: '' };
    try {
      const res = await fetchImpl(offer.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res && typeof res.text === 'function') {
        const html = await res.text();
        info = { ...extractCampaignInfoFromHtml(html, offer), error: '' };
        if (offer.windowed && !info.prefix && offer.prefixHint) info.prefix = offer.prefixHint;
      }
    } catch (err) {
      info.error = String(err?.message || err).slice(0, 120);
      if (offer.prefixHint) info.prefix = info.prefix || offer.prefixHint;
    }
    meta[offer.key] = info;
  }
  _metaCache = meta;
  _metaAt = Date.now();
  return meta;
}

export function resetEventOfferMetaCache() {
  _metaCache = null;
  _metaAt = 0;
  claimLedger.clear();
  accountRuns.clear();
}

/** Swiggy ka "day" 11:00 IST par badalta hai (midnight par nahi). */
function swiggyDayNumber(nowMs) {
  const H = 3600 * 1000;
  const ist = new Date(nowMs + 5.5 * H);
  const shift = ist.getUTCHours() < 11 ? -1 : 0;
  return ist.getUTCDate() + shift;
}

/**
 * Diye gaye campaign id ka redeem window ABHI khula hai ya nahi.
 * Pre-book (aaj + kal) me kal wali id ka window abhi band hota hai — us case
 * me Swiggy likh kar bhi `shouldNotify:false` hi dikhata hai. Isliye band
 * window par hum "save nahi hua" nahi kehte, "pre-lock ho gaya" kehte hain
 * aur dobara likhte hi nahi (wahi to "2 times claim" tha).
 */
function isWindowOpenNow(campaignId, info, nowMs) {
  const bounds = Array.isArray(info?.boundaries) ? info.boundaries : [];
  if (!bounds.length) return null; // pata nahi — jhooth mat bolo
  const dayMatch = String(campaignId || '').match(/(\d+)\s*$/);
  const day = dayMatch ? Number(dayMatch[1]) : null;
  const scoped = day === null ? bounds : bounds.filter((b) => Number(b.day) === day);
  if (!scoped.length) return null;
  return scoped.some((b) => {
    const start = Date.parse(b.startTime);
    const end = Date.parse(b.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && nowMs >= start && nowMs < end;
  });
}

/**
 * Ek offer ke aaj ke + kal ke campaign id. `windowed` offers me day number
 * lagta hai; fixed offers me wahi id.
 */
export function campaignIdsForOffer(offerKey, meta, nowMs = Date.now()) {
  const offer = getEventOffer(offerKey);
  const info = meta?.[offerKey] || {};
  if (!offer) return { ids: [], source: 'UNKNOWN', prefix: '', fixed: '' };

  if (offer.windowed) {
    const prefix = String(info.prefix || offer.prefixHint || '');
    if (!prefix) return { ids: [], source: info.source || 'NONE', prefix: '', fixed: '' };
    // Live boundaries ho to unse aaj ka day lo (Swiggy ka asli schedule).
    let day = swiggyDayNumber(nowMs);
    if (Array.isArray(info.boundaries) && info.boundaries.length) {
      const hit = info.boundaries.find((b) => {
        const s = Date.parse(b.startTime);
        const e = Date.parse(b.endTime);
        return Number.isFinite(s) && nowMs >= s && nowMs < e;
      });
      if (hit?.day) day = Number(hit.day);
    }
    const ids = [`${prefix}${day}`, `${prefix}${day + 1}`];
    return { ids, source: info.source || 'PREFIX', prefix, fixed: '' };
  }

  const fixed = String(info.fixedCampaignId || '').trim();
  if (fixed) return { ids: [fixed], source: info.source || 'FIXED', prefix: '', fixed };
  return { ids: [], source: info.source || 'NONE', prefix: '', fixed: '' };
}

// ── claim engine ─────────────────────────────────────────────────────────────

// Kitni der tak "is campaign par likh diya" yaad rahe (double claim rokne ke liye).
const ledger = new Map();       // `${accSig}|${campaignId}` -> { value, at, verified, state }
export const claimLedger = ledger;
const LEDGER_TTL_MS = 6 * 60 * 60 * 1000;
const accountRuns = new Map();  // accSig -> promise (ek waqt me ek run)

function accountSignature(account) {
  return String(
    account?.id || account?.phone || account?.customerId || account?.token ||
    String(account?.cookies || '').slice(0, 80) || 'unknown'
  );
}

/** Baaki modules (swiggy-bridge ka purana claim path) bhi isi ledger ka hissa hon. */
export function campaignClaimSignature(account) {
  return accountSignature(account);
}

function ledgerGet(accSig, campaignId) {
  const rec = ledger.get(`${accSig}|${campaignId}`);
  if (!rec) return null;
  if (Date.now() - rec.at > LEDGER_TTL_MS) {
    ledger.delete(`${accSig}|${campaignId}`);
    return null;
  }
  return rec;
}

function ledgerSet(accSig, campaignId, value, verified, state = '') {
  ledger.set(`${accSig}|${campaignId}`, { value, at: Date.now(), verified: Boolean(verified), state });
}

/**
 * Kisi campaign par kuch hi der pehle likha gaya tha? Purane claim path
 * (`claimSwiggyBreakfastAndLateNightOffers`) isi se poochta hai, isliye dono
 * raaste ek hi ledger share karte hain — "2 times claim" dono taraf se band.
 */
export function recentCampaignClaim(account, campaignId, nowMs = Date.now()) {
  const rec = ledgerGet(accountSignature(account), campaignId);
  if (!rec) return null;
  return { ...rec, ageMs: Math.max(0, nowMs - rec.at) };
}

/** Legacy path write ke baad ledger me note karta hai (same key, same TTL). */
export function noteCampaignClaim(account, campaignId, { value = PREFERRED_OFFER_VALUE, verified = false, state = '' } = {}) {
  if (!campaignId) return;
  ledgerSet(accountSignature(account), campaignId, Number(value) || PREFERRED_OFFER_VALUE, verified, state);
}

function decodeJwtExpSec(jwt) {
  try {
    const part = String(jwt || '').split('.')[1];
    if (!part) return 0;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(json?.exp || 0);
  } catch {
    return 0;
  }
}

/** events.swiggy.com sirf { token, tid } headers maanta hai (Cookie = CloudFront 403). */
export function resolveEventOfferAuth(account) {
  const acc = account || {};
  let token = String(acc.token || '');
  let tid = String(acc.jwtTid || acc.tid || '');
  const cookieStr = String(acc.cookies || '');
  for (const part of cookieStr.split(';').map((s) => s.trim())) {
    if (!token && part.startsWith('token=')) token = part.slice(6);
    if (!tid && part.startsWith('tid=') && part.slice(4).includes('.')) tid = part.slice(4);
    if (!tid && part.startsWith('_session_tid=') && part.slice(13).includes('.')) tid = part.slice(13);
  }
  return { token: token || tid, tid, hasToken: Boolean(token), hasTid: Boolean(tid) };
}

function buildHeaders(auth) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    token: auth.token || auth.tid || '',
    tid: auth.tid || auth.token || '',
    Origin: 'https://events.swiggy.com',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  };
}

async function readCampaignState(campaignId, { headers, fetchImpl, timeoutMs = 5500 }) {
  try {
    const res = await fetchImpl(`${EVENTS_API}?campaign=${encodeURIComponent(campaignId)}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok),
      httpStatus: Number(res.status || 0),
      shouldNotify: Boolean(json?.shouldNotify),
      value: Number(json?.value || 0),
      timestamp: json?.timestamp || ''
    };
  } catch (err) {
    return { ok: false, httpStatus: 0, shouldNotify: false, value: 0, timestamp: '', error: String(err?.message || err).slice(0, 120) };
  }
}

/**
 * Ek campaign ko chahiye wali state me lao — par pehle padho:
 *   already `shouldNotify:true && value:N` hai  →  kuch likho hi nahi (0 write)
 *   nahi hai                                     →  ek POST/PATCH
 *   phir ek GET se read-back verify
 */
export async function ensureCampaignClaim(account, {
  campaignId,
  offerKey = '',
  referer = '',
  value = PREFERRED_OFFER_VALUE,
  headers = null,
  auth = null,
  fetchImpl = globalThis.fetch,
  force = false,
  maxRetries = 1,
  windowOpen = null
} = {}) {
  if (!campaignId) {
    return { campaignId: '', state: 'NO_CAMPAIGN_ID', writes: 0, verified: false, reason: 'campaign id nahi mila (offer page se)' };
  }
  const accSig = accountSignature(account);
  const resolvedAuth = auth || resolveEventOfferAuth(account);
  const hdr = headers || buildHeaders(resolvedAuth);
  if (!hdr.token && !hdr.tid) {
    return { campaignId, state: 'NO_SESSION', writes: 0, verified: false, reason: 'ID me token/tid nahi — re-login karein' };
  }

  const cached = ledgerGet(accSig, campaignId);
  if (cached && cached.verified && cached.value === value && !force) {
    // Isi campaign par kuch hi der pehle verified likha gaya — dobara chhedna
    // hi "2 times claim" banata tha.
    return { campaignId, state: 'ALREADY_VERIFIED', writes: 0, verified: true, cached: true, reason: 'pehle se locked (read-back verified)' };
  }
  if (cached && cached.state === 'PRE_LOCKED' && cached.value === value) {
    // Window band tha, hum pehle hi likh chuke hain. `force` par bhi dobara
    // nahi likhenge — yahi boss ki shikayat ("2 times claim") thi.
    return { campaignId, state: 'PRE_LOCKED', writes: 0, verified: false, cached: true, reason: 'pre-lock pehle ho chuka (window band) — dobara nahi likhenge' };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000));
    const before = await readCampaignState(campaignId, { headers: hdr, fetchImpl });
    if (before.httpStatus === 401) {
      return { campaignId, state: 'AUTH_FAILED', writes: 0, verified: false, httpStatus: 401, reason: 'session se mana (401) — re-login' };
    }
    if ([403, 429].includes(before.httpStatus) && attempt < maxRetries) continue; // WAF burst → window reset
    if (!before.ok) {
      return {
        campaignId,
        state: before.httpStatus ? 'PROBE_FAILED' : 'NETWORK_FAILED',
        writes: 0,
        verified: false,
        httpStatus: before.httpStatus,
        reason: before.httpStatus ? `events.swiggy.com HTTP ${before.httpStatus}` : (before.error || 'network')
      };
    }
    if (before.shouldNotify && before.value === value) {
      ledgerSet(accSig, campaignId, value, true);
      return { campaignId, state: 'ALREADY_ACTIVE', writes: 0, verified: true, httpStatus: before.httpStatus, value: before.value, reason: 'pehle se active' };
    }

    const method = before.shouldNotify ? 'PATCH' : 'POST';
    let writeRes = null;
    let writeJson = {};
    try {
      writeRes = await fetchImpl(EVENTS_API, {
        method,
        headers: { ...hdr, ...(referer ? { Referer: referer } : {}) },
        body: JSON.stringify({ campaign: campaignId, value }),
        signal: AbortSignal.timeout(6500)
      });
      writeJson = await writeRes.json().catch(() => ({}));
      if ([403, 429].includes(Number(writeRes.status))) {
        if (attempt < maxRetries) continue; // WAF burst → 4s baad ek aur koshish
        // Retry bhi 403/429 → yeh "save nahi hua" nahi, Swiggy ne request hi
        // rok di. Jhoothi wajah mat likho.
        return {
          campaignId,
          method,
          writes: 0,
          state: 'RATE_LIMITED',
          verified: false,
          httpStatus: Number(writeRes.status),
          reason: `Swiggy ne request rok di (HTTP ${writeRes.status} WAF/throttle) — claim nahi hua, 10 min baad retry`
        };
      }
    } catch (err) {
      if (attempt < maxRetries) continue;
      return { campaignId, state: 'WRITE_FAILED', writes: 0, verified: false, reason: String(err?.message || err).slice(0, 120) };
    }

    const after = await readCampaignState(campaignId, { headers: hdr, fetchImpl });
    const ok = after.ok && after.shouldNotify && after.value === value;
    // Write accept hua par state save nahi — agar window ABHI band hai to yeh
    // normal pre-book hai (Swiggy band slot par shouldNotify:false hi rakhta
    // hai). Use PRE_LOCKED maano: 6h tak dobara write nahi.
    const preLocked = !ok && after.ok && Number(writeRes.status) >= 200 && Number(writeRes.status) < 300 && windowOpen === false;
    const state = ok ? 'CLAIMED' : preLocked ? 'PRE_LOCKED' : (after.ok ? 'WRITE_NOT_SAVED' : 'READBACK_FAILED');
    // PRE_LOCKED me humne jo value bheji wahi yaad rakhte hain (read-back 0
    // dikhata hai kyunki window band hai) — warna har call dobara likhega.
    ledgerSet(accSig, campaignId, ok ? value : (preLocked ? value : after.value), ok, state);
    return {
      campaignId,
      method,
      writes: 1,
      state,
      verified: ok,
      preLocked,
      httpStatus: Number(writeRes.status || 0),
      value: after.value,
      shouldNotify: after.shouldNotify,
      message: writeJson?.message || '',
      reason: ok
        ? `claim ho gaya (read-back: option ${after.value})`
        : preLocked
          ? 'pre-lock ho gaya (window abhi band hai, Swiggy slot khulne par laga dega)'
          : after.ok
            ? `Swiggy ne likha par save nahi kiya (read-back: shouldNotify=${after.shouldNotify}, value=${after.value})`
            : `read-back fail (HTTP ${after.httpStatus || 'network'}) — claim ka pakka pata nahi`
    };
  }
  return { campaignId, state: 'RATE_LIMITED', writes: 0, verified: false, reason: 'Swiggy ne throttle kiya (403/429) — 10 min baad retry' };
}

/**
 * CHAARON offers activate karo — ek hi account par ek waqt me ek run.
 * JSON import, cart scan, pre-book loop — sab isi ko call karte hain, isliye
 * double claim possible nahi.
 */
export async function activateAllEventOffers(account, {
  force = false,
  offerValue = PREFERRED_OFFER_VALUE,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  meta = null,
  offerKeys = EVENT_OFFER_KEYS,
  skipIfRunInFlight = false
} = {}) {
  const accSig = accountSignature(account);
  const runKey = `${accSig}:v${offerValue}`;
  const inflight = accountRuns.get(runKey);
  if (inflight) {
    if (skipIfRunInFlight) return { ...(await inflight), sharedRun: true };
    return inflight;
  }

  const run = (async () => {
    const resolvedMeta = meta || await discoverOfferMeta({ fetchImpl });
    const auth = resolveEventOfferAuth(account);
    const headers = buildHeaders(auth);
    const offers = {};
    let claimed = 0;
    let already = 0;
    let failed = 0;
    let preLocked = 0;

    for (const offerKey of offerKeys) {
      const offer = getEventOffer(offerKey);
      if (!offer) continue;
      const { ids, source } = campaignIdsForOffer(offerKey, resolvedMeta, nowMs);
      if (!ids.length) {
        offers[offerKey] = {
          key: offerKey,
          bossLabel: offer.bossLabel,
          name: offer.name,
          url: offer.url,
          campaign: '',
          ids: [],
          metaSource: source,
          status: 'NO_CAMPAIGN_ID',
          state: 'NO_CAMPAIGN_ID',
          verified: false,
          claimed: false,
          message: 'offer page se campaign id nahi mili — link khol kar ek baar claim karein',
          reason: 'offer page se campaign id nahi mili — link khol kar ek baar claim karein'
        };
        failed += 1;
        continue;
      }
      const results = [];
      for (const campaignId of ids) {
        const out = await ensureCampaignClaim(account, {
          campaignId,
          offerKey,
          referer: offer.url,
          value: offerValue,
          headers,
          auth,
          fetchImpl,
          force,
          windowOpen: isWindowOpenNow(campaignId, resolvedMeta?.[offerKey], nowMs)
        });
        results.push(out);
      }
      const primary = results[0];
      const anyClaimed = results.some((r) => r.state === 'CLAIMED' || r.verified);
      const allVerified = results.every((r) => r.verified);
      const anyPreLocked = results.some((r) => r.state === 'PRE_LOCKED');
      if (primary?.state === 'ALREADY_ACTIVE' || primary?.state === 'ALREADY_VERIFIED') already += 1;
      else if (primary?.verified) claimed += 1;
      else if (primary?.state === 'PRE_LOCKED') preLocked += 1;
      else failed += 1;
      offers[offerKey] = {
        key: offerKey,
        bossLabel: offer.bossLabel,
        name: offer.name,
        url: offer.url,
        campaign: primary?.campaignId || '',
        ids,
        metaSource: source,
        status: allVerified ? 'CLAIMED' : (anyClaimed ? 'PARTIAL' : (anyPreLocked && !failed ? 'PRE_LOCKED' : 'FAILED')),
        state: primary?.state || 'UNKNOWN',
        preLocked: anyPreLocked,
        verified: Boolean(primary?.verified),
        alreadyActive: primary?.state === 'ALREADY_ACTIVE' || primary?.state === 'ALREADY_VERIFIED',
        writes: results.reduce((n, r) => n + Number(r.writes || 0), 0),
        campaignUrl: offer.url,
        discount: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
        message: primary?.reason || '',
        results
      };
    }

    const total = Object.keys(offers).length;
    return {
      ok: failed === 0,
      at: new Date(nowMs).toISOString(),
      source: 'EVENT_OFFERS_ENGINE',
      offerValue,
      label: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
      links: EVENT_OFFER_LINKS,
      offers,
      summary: { total, claimed, alreadyActive: already, preLocked, failed },
      // "all active" ka matlab sach me laga — pre-lock (window band) active nahi.
      allActive: total > 0 && failed === 0 && preLocked === 0,
      // Purane callers (import card / doctor) `offers.breakfast` & `offers.lateNight`
      // padhte hain — woh shape isi me maujood hai.
      breakfast: offers.breakfast || null,
      lateNight: offers.lateNight || null,
      extra50: offers.extra50 || null,
      weekend: offers.weekend || null
    };
  })();

  accountRuns.set(runKey, run);
  try {
    return await run;
  } finally {
    if (accountRuns.get(runKey) === run) accountRuns.delete(runKey);
  }
}

/** UI ke liye saaf Hinglish lines (jo hua wahi dikhta hai). */
export function describeEventOfferActivation(result) {
  if (!result?.offers) return ['Offers: koi jawab nahi mila.'];
  const lines = [];
  for (const offer of EVENT_OFFERS) {
    const rec = result.offers[offer.key];
    if (!rec) continue;
    const tag = rec.status === 'CLAIMED'
      ? (rec.alreadyActive ? '✓ pehle se active' : '✓ activate')
      : (rec.status === 'PARTIAL' ? '◐ aadha' : '✕ nahi hua');
    lines.push(`${offer.bossLabel}: ${tag}${rec.campaign ? ` · ${rec.campaign}` : ''}${rec.message ? ` — ${rec.message}` : ''}`);
  }
  return lines;
}

/** Kitne offers sach me active hain (UI/counter ke liye). */
export function countActiveEventOffers(result) {
  if (!result?.offers) return 0;
  return Object.values(result.offers).filter((o) => o && (o.status === 'CLAIMED' || o.verified)).length;
}
