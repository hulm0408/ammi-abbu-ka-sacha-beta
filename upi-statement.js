/**
 * Boss (31-10-2026, round 20): asli paisa ka sabooot — UPI/bank statement.
 *
 * `config.upiStatement` me sirf wahi entries rehti hain jo bank/UPI se aayi
 * hain (boss statement paste karta hai, ya provider API/webhook bhejta hai).
 * Har entry: utr → { amountPaise, payeeName, payeeVpa, status, at, source }.
 *
 * Isi ledger se `evaluateUtrCredit` (upi-credit-policy.js) credit ka faisla
 * leta hai. User khud jo UTR likhta hai wo sirf **claim** hai — proof nahi.
 */
import { parseStatementText, evaluateUtrCredit, CREDIT_ACTIONS, isBossPayee } from './upi-credit-policy.js';
import {
  creditWallet, ensureWallet, findUsedUtr, markUtrUsed, listTopupRequests, normalizeUtr, walletBalancePaise
} from './user-wallet.js';

const STATEMENT_KEY = 'upiStatement';
const MAX_ENTRIES = 800;

function store(db) {
  if (!db.config) db.config = {};
  if (!db.config[STATEMENT_KEY] || typeof db.config[STATEMENT_KEY] !== 'object') db.config[STATEMENT_KEY] = {};
  return db.config[STATEMENT_KEY];
}

/** Ek payment entry likho (UTR unique — dobara wahi entry update). */
export function recordStatementPayment(db, entry, { actor = '', at = Date.now() } = {}) {
  const utr = normalizeUtr(entry?.utr);
  if (!utr) return { ok: false, code: 'UTR_REQUIRED', reason: 'UTR ke bina entry nahi' };
  const amountPaise = Math.round(Number(entry?.amountPaise) || 0);
  if (!(amountPaise > 0)) return { ok: false, code: 'AMOUNT_REQUIRED', reason: 'amount ke bina entry nahi' };
  const payments = store(db);
  const existing = payments[utr];
  const record = {
    utr,
    amountPaise,
    payeeName: String(entry?.payeeName || existing?.payeeName || '').slice(0, 60),
    payeeVpa: String(entry?.payeeVpa || existing?.payeeVpa || '').slice(0, 60),
    status: String(entry?.status || 'SUCCESS').toUpperCase().slice(0, 20),
    at: Number(entry?.at) || at,
    ref: String(entry?.ref || '').slice(0, 60),
    source: String(entry?.source || 'statement').slice(0, 20),
    importedAt: new Date(at).toISOString(),
    importedBy: String(actor || '').slice(0, 60)
  };
  payments[utr] = record;
  // Purani entries prune (hamesha UTR ledger bacha rehta hai, ye sirf proof cache).
  const keys = Object.keys(payments);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (Number(payments[a]?.at) || 0) - (Number(payments[b]?.at) || 0));
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete payments[key];
  }
  return { ok: true, record, isNew: !existing };
}

/** UTR ka asli payment record dhundo. */
export function findStatementPayment(db, rawUtr) {
  const utr = normalizeUtr(rawUtr);
  if (!utr) return null;
  return store(db)[utr] || null;
}

export function statementSummary(db) {
  const payments = store(db);
  const entries = Object.values(payments);
  const totalPaise = entries.reduce((sum, e) => sum + (Number(e?.amountPaise) || 0), 0);
  const withName = entries.filter((e) => isBossPayee({ name: e?.payeeName || '', vpa: e?.payeeVpa || '' }).ok).length;
  return {
    count: entries.length,
    totalPaise,
    bossPayeeCount: withName,
    lastAt: entries.reduce((max, e) => Math.max(max, Number(e?.at) || 0), 0) || 0,
    recent: entries
      .sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
      .slice(0, 10)
      .map((e) => ({ utr: e.utr, amountPaise: e.amountPaise, payeeName: e.payeeName, status: e.status, at: e.at, source: e.source }))
  };
}

/**
 * Boss statement/SMS paste karta hai → entries save + jo pending claims is
 * UTR se match karein, unhe **asli amount** par credit kar do.
 */
export function importStatementText(db, text, { actor = 'boss', at = Date.now() } = {}) {
  const parsed = parseStatementText(text, { at });
  const accepted = [];
  const rejected = [];
  for (const entry of parsed) {
    const saved = recordStatementPayment(db, entry, { actor, at });
    if (saved.ok) accepted.push(saved.record);
    else rejected.push({ utr: entry.utr, reason: saved.reason });
  }
  const settled = settledPendingClaims(db, { actor, at });
  return { ok: true, parsed: parsed.length, accepted, rejected, settled };
}

/**
 * Har PENDING claim dekho: agar uska UTR ab statement me hai to us asli amount
 * par credit karo. Jo UTR statement me nahi, wo PENDING hi rehta hai.
 */
export function settledPendingClaims(db, { actor = 'system', at = Date.now() } = {}) {
  const result = [];
  const pending = listTopupRequests(db, { status: 'PENDING', limit: 200 });
  for (const req of pending) {
    const payment = findStatementPayment(db, req.utr);
    if (!payment) continue;
    const decision = evaluateUtrCredit({
      claim: { utr: req.utr, claimedPaise: req.claimedPaise, userId: req.userId },
      intent: { amountPaise: req.claimedPaise, createdAt: Date.parse(req.at || '') || 0 },
      payment,
      usedUtrs: {},
      autoMaxPaise: 0
    });
    if (decision.action !== CREDIT_ACTIONS.CREDIT) {
      if (decision.action === CREDIT_ACTIONS.REJECT) {
        req.status = 'REJECTED';
        req.reviewedAt = new Date(at).toISOString();
        req.reviewedBy = String(actor);
        req.reason = decision.reason;
        result.push({ topupId: req.id, action: 'REJECT', reason: decision.reason });
      }
      continue;
    }
    // Ledger me credit — UTR mark + wallet credit, dono ek saath.
    const already = findUsedUtr(db, req.utr);
    if (already && String(already.userId || '') !== String(req.userId || '')) {
      req.status = 'REJECTED';
      req.reason = 'ye UTR pehle kisi aur ke top-up me credit ho chuka hai';
      result.push({ topupId: req.id, action: 'REJECT', reason: req.reason });
      continue;
    }
    ensureWallet(db, req.userId, { name: req.name || '', at });
    const credit = creditWallet(db, req.userId, decision.creditedPaise, {
      reason: `Top-up verified: UTR ${req.utr} — ${decision.reason.slice(0, 120)}`,
      actor: String(actor),
      at,
      type: 'CREDIT',
      meta: { utr: req.utr, topupId: req.id, verifiedBy: decision.verifiedBy, payee: payment.payeeName || payment.payeeVpa || '' }
    });
    if (!credit.ok) {
      result.push({ topupId: req.id, action: 'FAIL', reason: credit.reason });
      continue;
    }
    markUtrUsed(db, req.utr, { userId: req.userId, amountPaise: decision.creditedPaise, status: 'CREDITED', source: 'statement-match', at });
    req.status = 'AUTO_VERIFIED';
    req.approvedPaise = decision.creditedPaise;
    req.verifiedBy = decision.verifiedBy || 'statement';
    req.reviewedAt = new Date(at).toISOString();
    req.reviewedBy = String(actor);
    req.reason = decision.reason;
    result.push({ topupId: req.id, userId: req.userId, action: 'CREDIT', creditedPaise: decision.creditedPaise, balancePaise: credit.balancePaise });
  }
  return result;
}

/** Boss ke liye summary + kitne claim verify ke intezaar me hain. */
export function statementStatus(db) {
  const summary = statementSummary(db);
  const pending = listTopupRequests(db, { status: 'PENDING', limit: 200 });
  const matched = pending.filter((r) => findStatementPayment(db, r.utr));
  return {
    ...summary,
    pendingClaims: pending.length,
    pendingMatched: matched.length,
    pendingUnmatched: pending.length - matched.length,
    walletTotalPaise: Object.keys((db.config && db.config.wallets) || {}).reduce((s, k) => s + walletBalancePaise(db, k), 0)
  };
}
