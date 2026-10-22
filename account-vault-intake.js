import crypto from 'crypto';
import {
  getDb,
  saveDb,
  importSessionJson,
  normalizeSwiggySessionPayload,
  extractSwiggyAccountsListFromInput,
  syncCloudVaultNow
} from './store.js';
import { extractStandaloneMobileNumber } from './phone-utils.js';
export { extractStandaloneMobileNumber, normalizeIndianMobileNumber } from './phone-utils.js';
import {
  verifySwiggySessionLive,
  inspectAccountOrderHistoryAndOffers,
  accountTidExpiryMs
} from './swiggy-cart.js';
import {
  claimSwiggyBreakfastAndLateNightOffers,
  decodeJwtPayload
} from './swiggy-bridge.js';
import { extractSessionFilesFromZipBuffer } from './vault-sync.js';
import { section, sub, table } from './rich-text.js';

/**
 * Validate a new display name and produce a short, collision-safe account key.
 */
export function prepareNewSwiggyAccountIdentity(rawName, accounts = {}) {
  const name = typeof rawName === 'string'
    ? rawName.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  const length = [...name].length;
  if (length < 2 || length > 40 || !/[\p{L}\p{N}]/u.test(name) || /^\p{N}+$/u.test(name)) {
    return { success: false, error: 'Use a name with 2–40 characters and at least one letter (for example, Bhai or Office).' };
  }

  const normalizedName = name.toLocaleLowerCase('en-IN');
  const duplicateName = Object.entries(accounts || {}).find(([, account]) =>
    String(account?.name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN') === normalizedName
  );
  if (duplicateName) {
    return { success: false, error: `That account name is already in use (${duplicateName[1]?.name || duplicateName[0]}). Choose a distinct label or use the existing account.` };
  }

  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 24)
    .replace(/_+$/g, '');
  const hash = crypto.createHash('sha256').update(normalizedName).digest('hex').slice(0, 10);
  const key = slug || `account_${hash}`;

  if (Object.prototype.hasOwnProperty.call(accounts || {}, key)) {
    return { success: false, error: `The generated account key “${key}” is already in use. Add a distinguishing word to the name.` };
  }
  return { success: true, name, key };
}

/**
 * Extracts a strict 4–6 digit OTP code ONLY when the message is purely an OTP number
 * (never when the user sends a Swiggy Cart URL, Address, JSON, or general sentence!).
 */
export function extractStandaloneOtpDigits(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (/https?:\/\/|swig\.gy|swiggy|goo\.gl|maps|[{[\]@]/i.test(trimmed)) return null;
  const direct = trimmed.match(/^(?:otp[\s:-]*)?(\d{4,6})$/i);
  return direct ? direct[1] : null;
}

/**
 * Checks whether a normalized Swiggy session payload carries an authenticated non-guest identity
 * (so transient network hiccups during 50-file bulk uploads NEVER discard valid `.json` files!).
 */
function hasAuthenticatedTokenIdentity(norm) {
  if (!norm) return false;
  const jwt = decodeJwtPayload(norm.tid || '');
  if (jwt) {
    const uid = String(jwt.user_id ?? jwt.userId ?? jwt.sub ?? '').trim();
    if (uid === '0' || uid === '-1') return false;
    if (uid && /^\d+$/.test(uid)) return true;
  }
  if (norm.token && String(norm.token).length >= 16) return true;
  if (norm.customerId && /^\d{4,}$/.test(String(norm.customerId))) return true;
  if (norm.cookies && /_is_logged_in=1/.test(norm.cookies) && /_session_tid=/.test(norm.cookies)) return true;
  return false;
}

async function runWithConcurrencyLimit(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await workerFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Core Bulk `.json` / `.txt` / multi-JSON Vault Importer & Permanent Cloud Saver:
 * - Accepts ANY array of `{ fileName, text }` items (1 file, 50 `.json` files sent together, `.zip` archive entries, or pasted JSON).
 * - Deduplicates by phone / customerId / token while keeping the newest credentials.
 * - Verifies live session & `0-Order` (`isZeroOrderAccount`) status with bounded concurrency (`8`),
 *   preserving authenticated sessions even if Swiggy rate-limits a single probe!
 * - Saves ALL valid accounts atomically into `db.config.accounts`, `db.sessionVault`, `accounts.json`, AND GitHub Cloud Vault (`bot-vault`)!
 */
export async function ingestAndPersistRawAccountTexts(
  rawEntries,
  {
    verifyFn = verifySwiggySessionLive,
    orderProfileFn = inspectAccountOrderHistoryAndOffers,
    claimOffersFn = claimSwiggyBreakfastAndLateNightOffers,
    syncVaultFn = syncCloudVaultNow,
    concurrency = 8
  } = {}
) {
  const candidatePayloads = [];
  const parseErrors = [];

  for (const item of rawEntries || []) {
    const fileName = item?.fileName || 'session.json';
    const text = String(item?.text || '').trim();
    if (!text) continue;

    // Derive fallback label/phone hint from filename if present (e.g. `9876543210.json` or `acc_12.json`)
    const filePhoneHint = (fileName.match(/(?:^|\D)([6-9]\d{9})(?:\D|$)/) || [])[1] || '';
    const list = extractSwiggyAccountsListFromInput(text);

    if (list.length === 0) {
      parseErrors.push({ fileName, reason: 'Invalid / Unrecognized JSON format' });
      continue;
    }

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        if (!entry.phone && !entry.mobile && filePhoneHint && list.length === 1) {
          entry.phone = filePhoneHint;
        }
        if (!entry.name && fileName) {
          entry.name = fileName.replace(/\.(json|txt|cookies?)$/i, '');
        }
      }
      const norm = normalizeSwiggySessionPayload(entry);
      if (norm && (norm.cookies || norm.tid || norm.token)) {
        candidatePayloads.push({ fileName, rawEntry: entry, norm });
      } else {
        parseErrors.push({ fileName, reason: 'Missing Swiggy cookies / token fields' });
      }
    }
  }

  if (candidatePayloads.length === 0) {
    return {
      savedAccounts: [],
      zeroOrderCount: 0,
      usedAccountCount: 0,
      expiredList: [],
      parseErrors,
      totalVaultActiveCount: Object.values(getDb().config?.accounts || {}).filter(a => a?.isLoggedIn).length
    };
  }

  const verifiedItems = await runWithConcurrencyLimit(candidatePayloads, concurrency, async (cand) => {
    const { fileName, norm } = cand;
    let live = null;
    try {
      live = await verifyFn({
        cookies: norm.cookies,
        tid: norm.tid,
        sid: norm.sid,
        token: norm.token,
        customerId: norm.customerId,
        deviceId: norm.deviceId,
        phone: norm.phone
      });
    } catch (err) {
      live = { valid: false, networkError: true, error: err?.message || 'verify failed' };
    }

    const explicitlyDeadGuest = Boolean(
      live &&
      !live.valid &&
      !live.networkError &&
      !hasAuthenticatedTokenIdentity(norm)
    ) || Boolean(
      live &&
      !live.valid &&
      /guest|logged out|invalid session|session expired|statuscode.*999/i.test(String(live.error || ''))
    );

    if (!live?.valid && (explicitlyDeadGuest || !hasAuthenticatedTokenIdentity(norm))) {
      return {
        accepted: false,
        fileName,
        phone: norm.phone || '',
        name: norm.name || fileName,
        reason: live?.error || 'Session Expired / Logged Out'
      };
    }

    const mergedPayload = {
      ...norm,
      phone: live?.phone || norm.phone || '',
      mobile: live?.phone || norm.phone || '',
      name: live?.name || norm.name || '',
      customerId: live?.customerId || norm.customerId || '',
      tid: live?.liveTid || norm.tid || '',
      sid: live?.liveSid || norm.sid || '',
      token: live?.token || norm.token || '',
      deviceId: norm.deviceId || '',
      cookies: live?.cookies || norm.cookies || '',
      isLoggedIn: true
    };

    // Quick order-history check so Vault immediately knows `0-Order` (`isZeroOrderAccount`) vs `Used`!
    try {
      const prof = await orderProfileFn(mergedPayload, null, { timeoutMs: 3200 });
      if (prof && typeof prof.orderCount === 'number' && Number.isFinite(prof.orderCount)) {
        mergedPayload.totalOrdersCount = prof.orderCount;
        mergedPayload.isZeroOrderAccount = prof.orderCount === 0;
      }
    } catch {}

    return { accepted: true, fileName, mergedPayload };
  });

  const acceptedPayloads = [];
  const expiredList = [];
  for (const item of verifiedItems) {
    if (item.accepted) acceptedPayloads.push(item.mergedPayload);
    else expiredList.push(item);
  }

  let savedAccounts = [];
  if (acceptedPayloads.length > 0) {
    // Atomic single-pass import across all accepted accounts (collision-free keys + `accounts.json` + `sessionVault`)!
    const impOut = importSessionJson(acceptedPayloads);
    savedAccounts = (impOut?.accounts || []).map((r) => ({
      key: r.key || r.account,
      account: r.accountObj || getDb().config?.accounts?.[r.key || r.account] || r,
      totalOrdersCount: r.totalOrdersCount,
      isZeroOrderAccount: r.isZeroOrderAccount
    }));

    // Immediately flush to persistent Cloud Vault (`bot-vault` branch) so Render restarts NEVER lose any file!
    await Promise.resolve(syncVaultFn(getDb())).catch(() => {});

    // Trigger non-blocking `₹50 OFF` Breakfast + Late Night auto-prebook across newly saved accounts
    Promise.allSettled(
      savedAccounts.slice(0, 25).map(({ account }) =>
        Promise.resolve(claimOffersFn({
          cookies: account.cookies,
          tid: account.tid,
          sid: account.sid,
          deviceId: account.deviceId,
          offerValue: account.preferredOfferValue || 1
        })).catch(() => null)
      )
    ).catch(() => {});
  }

  const allVaultActive = Object.values(getDb().config?.accounts || {}).filter(a => a?.isLoggedIn);
  const zeroOrderCount = savedAccounts.filter(s => s.isZeroOrderAccount || s.totalOrdersCount === 0).length;
  const usedAccountCount = savedAccounts.length - zeroOrderCount;

  return {
    savedAccounts,
    zeroOrderCount,
    usedAccountCount,
    expiredList,
    parseErrors,
    totalVaultActiveCount: allVaultActive.length,
    totalVaultZeroOrderCount: allVaultActive.filter(a => a.isZeroOrderAccount || a.totalOrdersCount === 0).length
  };
}

/**
 * Formats a clean, concise single-card summary for 1..200 imported `.json` accounts (never floods Telegram!).
 */
export function formatBulkVaultImportSummaryHtml(result, filesCount = 1) {
  const {
    savedAccounts = [],
    zeroOrderCount = 0,
    usedAccountCount = 0,
    expiredList = [],
    parseErrors = [],
    totalVaultActiveCount = 0,
    totalVaultZeroOrderCount = 0
  } = result || {};

  if (savedAccounts.length === 0) {
    const expLines = expiredList.slice(0, 12).map((e, idx) =>
      `${idx + 1}. <code>${String(e.phone || e.fileName || 'Account').slice(0, 32)}</code> — ${String(e.reason || 'Expired').slice(0, 48)}`
    ).join('\n');
    const errLines = parseErrors.slice(0, 6).map(p => `• <code>${p.fileName}</code>: ${p.reason}`).join('\n');
    return (
      `! <b>Koi Active Session Save Nahi Hua (${filesCount} file checked)</b>\n\n` +
      (expLines ? `× <b>Expired / Logged Out (${expiredList.length}):</b>\n${expLines}\n\n` : '') +
      (errLines ? `! <b>Invalid File (${parseErrors.length}):</b>\n${errLines}\n\n` : '') +
      `▣ <b>Permanent Vault Active IDs Ready:</b> <b>${totalVaultActiveCount}</b>`
    );
  }

  const previewLines = savedAccounts.slice(0, 18).map((item, idx) => {
    const acc = item.account || {};
    const label = acc.phone || acc.name || item.key;
    const tag = (item.isZeroOrderAccount || item.totalOrdersCount === 0)
      ? '+ 0-Order'
      : (typeof item.totalOrdersCount === 'number' ? `▣ ${item.totalOrdersCount} Orders` : '● Ready');
    return `${idx + 1}. ✓ <code>${label}</code> (${tag})`;
  }).join('\n');
  const moreNote = savedAccounts.length > 18
    ? `\n<i>...aur ${savedAccounts.length - 18} accounts bhi Vault me save ho gaye!</i>`
    : '';
  const skippedNote = expiredList.length > 0
    ? `\n\n× <b>Skipped Dead/Logged-Out (${expiredList.length}):</b> ${expiredList.slice(0, 6).map(e => `<code>${e.phone || e.fileName}</code>`).join(', ')}${expiredList.length > 6 ? '...' : ''}`
    : '';

  // Web/OTP-style logins mint SHORT-lived tids (~40 min) unlike 30-day app
  // logins. An account imported with a short session will silently stop
  // working for orders/tracking right after expiry — warn at import time.
  const shortSessions = savedAccounts
    .map((item) => ({ label: String(item.account?.phone || item.key || '').slice(0, 12), exp: accountTidExpiryMs(item.account || {}) }))
    .filter((s) => s.exp && (s.exp - Date.now()) < 6 * 60 * 60 * 1000);
  const shortNote = shortSessions.length > 0
    ? `\n\n! <b>Short session (${shortSessions.length}):</b> ${shortSessions.slice(0, 6).map((s) => `<code>${s.label}</code>`).join(', ')}${shortSessions.length > 6 ? '...' : ''} — inka token ~${Math.max(1, Math.round((Math.min(...shortSessions.map((s) => s.exp)) - Date.now()) / 60000))} min me expire hoga (web login). Expire hone par us account se tracking/orders fail honge — fresh app session dobara upload karna.`
    : '';

  const summaryTable = [
    ['▤ Files Processed', String(filesCount)],
    ['+ Fresh 0-Order IDs', String(zeroOrderCount)],
    ['● Other Active IDs', String(usedAccountCount)],
    ['☁️ Total Active Ready', `${totalVaultActiveCount} (${totalVaultZeroOrderCount} Zero-Order)`],
  ];

  return (
    section(`✓ ${savedAccounts.length} Swiggy Account(s) Permanently Saved to Vault!`, [
      table(summaryTable),
      '',
      previewLines,
      moreNote,
      skippedNote,
      shortNote,
    ].filter(Boolean).join('\n')) +
    `\n\n${sub('› Ab jab bhi Cart + Address aayega, bot bina OTP maange apne aap Best 0-Order + Max Offer account select karke bill nikal dega!')}`
  );
}

/**
 * Coalesces multi-file bursts (e.g. Boss dropping 20 `.json` files or a `.zip` file at once in Telegram)
 * into ONE single batch execution + ONE single summary reply — ZERO Telegram `429` flood errors!
 */
export function createBulkDocumentBatchCollector({
  windowMs = 650,
  downloadBufferFn,
  ingestOptions = {},
  onBatchComplete
} = {}) {
  const buckets = new Map();

  async function flushBucket(chatKey) {
    const bucket = buckets.get(chatKey);
    if (!bucket) return null;
    buckets.delete(chatKey);

    const files = bucket.items;
    const lastCtx = bucket.lastCtx;

    let statusMsg = null;
    if (files.length >= 2 && lastCtx?.reply) {
      statusMsg = await lastCtx.reply(
        `◷ <b>${files.length} Account Files Received!</b> Sabko ek saath verify karke Permanent Vault me save kiya ja raha hai...`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
    }

    // Download all queued Telegram file buffers concurrently (`concurrency = 6`) + unpack `.zip` archives automatically!
    const rawEntries = [];
    const dlErrors = [];
    await runWithConcurrencyLimit(files, 6, async (docItem) => {
      try {
        const buf = await downloadBufferFn(docItem);
        const fname = docItem.fileName || 'session.json';
        if (/\.zip$/i.test(fname) || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
          const unzipped = extractSessionFilesFromZipBuffer(buf);
          if (unzipped.length === 0) {
            dlErrors.push({ fileName: fname, reason: 'ZIP contained no .json / .txt files' });
          } else {
            rawEntries.push(...unzipped);
          }
        } else {
          rawEntries.push({ fileName: fname, text: buf.toString('utf8') });
        }
      } catch (err) {
        dlErrors.push({ fileName: docItem.fileName || 'file.json', reason: err?.message || 'Download error' });
      }
    });

    const result = await ingestAndPersistRawAccountTexts(rawEntries, ingestOptions);
    if (dlErrors.length > 0) {
      result.parseErrors = [...(result.parseErrors || []), ...dlErrors];
    }
    const html = formatBulkVaultImportSummaryHtml(result, Math.max(files.length, rawEntries.length));

    if (onBatchComplete) {
      await onBatchComplete({ chatKey, lastCtx, statusMsg, result, html, filesCount: files.length });
    }
    return result;
  }

  function enqueue(chatKey, ctx, docMeta) {
    let bucket = buckets.get(chatKey);
    if (!bucket) {
      let resolveDone;
      const donePromise = new Promise((res) => { resolveDone = res; });
      bucket = {
        items: [],
        lastCtx: ctx,
        timer: null,
        donePromise,
        resolveDone
      };
      buckets.set(chatKey, bucket);
    }
    bucket.items.push(docMeta);
    bucket.lastCtx = ctx;

    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(async () => {
      try {
        const out = await flushBucket(chatKey);
        bucket.resolveDone(out);
      } catch (err) {
        bucket.resolveDone({ error: err });
      }
    }, windowMs);

    return bucket.donePromise;
  }

  return { enqueue, flushBucket };
}
