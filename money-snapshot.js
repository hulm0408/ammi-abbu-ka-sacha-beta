/**
 * Boss (31-10-2026, round 19):
 *   "SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"
 *
 * Ye bilkul sahi diagnosis hai — Render par `/app/data` disk attach na ho to
 * har deploy par `db.json` naya ban jata hai: wallet, UTR ledger, top-up claims,
 * sab ud jaate hain. Paisa aur UTR ki yaad **deploy se zyada zinda** honi chahiye.
 *
 * Ye module pure hai — snapshot banao, merge karo, aur batao ki restore chahiye
 * ya nahi. Network (cloud vault) `db-durability.js` me hai.
 */

export const MONEY_SNAPSHOT_VERSION = 2;

/** db ki wo sections jo paise/UTR ka sach rakhte hain. */
export const MONEY_SECTIONS = ['wallets', 'topupRequests', 'topupClaims', 'topupIntents', 'usedUtrs'];

/** config me sirf paise wali settings (accounts/vault ka sach alag jagah hai). */
const MONEY_CONFIG_KEYS = ['walletUpiId', 'bossUpiId', 'serviceFeePaise', 'walletAutoCreditMaxPaise'];

function plain(value) {
  try { return JSON.parse(JSON.stringify(value ?? {})); } catch { return {}; }
}

/** Snapshot: sirf paisa/UTR ka sach — bhaari orders/accounts nahi. */
export function buildMoneySnapshot(db, { at = Date.now() } = {}) {
  const config = db?.config || {};
  const sections = {};
  for (const key of MONEY_SECTIONS) sections[key] = plain(config[key]);
  const moneyConfig = {};
  for (const key of MONEY_CONFIG_KEYS) if (config[key] !== undefined) moneyConfig[key] = config[key];
  const counts = Object.fromEntries(MONEY_SECTIONS.map((key) => [key, Object.keys(sections[key]).length]));
  return {
    version: MONEY_SNAPSHOT_VERSION,
    at: new Date(at).toISOString(),
    config: moneyConfig,
    sections,
    counts
  };
}

/** Snapshot me paisa/UTR ka kuch hai bhi? (khaali snapshot push karne ka matlab nahi) */
export function snapshotHasData(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const sections = snapshot.sections || {};
  return ['wallets', 'topupRequests', 'topupClaims', 'topupIntents', 'usedUtrs']
    .some((key) => sections[key] && Object.keys(sections[key]).length > 0);
}

/** DB fresh lag raha hai (deploy ke baad jaisa) — restore karna chahiye? */
export function needsMoneyRestore(db, snapshot) {
  if (!snapshotHasData(snapshot)) return false;
  const config = db?.config || {};
  const fresh = ['wallets', 'topupRequests', 'usedUtrs'].every((key) => !config[key] || Object.keys(config[key]).length === 0);
  return fresh;
}

/**
 * Snapshot ko db me milao — **paisa kabhi kam nahi hota**.
 *  • wallet: jo balance zyada hai wahi rakha jata hai (local ya snapshot)
 *  • usedUtrs: union — ek UTR dobara chalu nahi ho sakta, bhale snapshot purana ho
 *  • topupRequests/Claims/Intents: union by id (local jeetta hai agar dono me ho)
 */
export function mergeMoneySnapshot(db, snapshot, { at = Date.now() } = {}) {
  const summary = { wallets: 0, walletsKeptHigher: 0, topupRequests: 0, topupClaims: 0, topupIntents: 0, usedUtrs: 0, config: 0 };
  if (!snapshot || typeof snapshot !== 'object') return { changed: false, summary };
  if (!db.config) db.config = {};
  let changed = false;

  const snapSections = snapshot.sections || {};

  // config (paise wali settings) — local na ho to snapshot se.
  for (const [key, value] of Object.entries(snapshot.config || {})) {
    // Khaali value wapas likhne ka koi matlab nahi — warna har boot par
    // "restore hua" jhootha dikhta (aur `changed` hamesha true rehta).
    if (value === undefined || value === null || value === '') continue;
    if (db.config[key] === undefined || db.config[key] === '' || db.config[key] === null) {
      db.config[key] = value;
      summary.config += 1;
      changed = true;
    }
  }

  // wallets — balance kabhi kam nahi.
  if (!db.config.wallets || typeof db.config.wallets !== 'object') db.config.wallets = {};
  for (const [userId, snapWallet] of Object.entries(snapSections.wallets || {})) {
    if (!snapWallet || typeof snapWallet !== 'object') continue;
    const local = db.config.wallets[userId];
    if (!local) {
      db.config.wallets[userId] = { ...snapWallet };
      summary.wallets += 1;
      changed = true;
      continue;
    }
    const localPaise = Math.round(Number(local.balancePaise) || 0);
    const snapPaise = Math.round(Number(snapWallet.balancePaise) || 0);
    if (snapPaise > localPaise) {
      db.config.wallets[userId] = {
        ...snapWallet,
        ...local,
        balancePaise: snapPaise,
        history: Array.isArray(local.history) && local.history.length ? local.history : (snapWallet.history || [])
      };
      summary.walletsKeptHigher += 1;
      changed = true;
    }
  }

  // union sections
  const union = (key, counter) => {
    if (!db.config[key] || typeof db.config[key] !== 'object') db.config[key] = {};
    for (const [id, record] of Object.entries(snapSections[key] || {})) {
      if (!record || typeof record !== 'object') continue;
      if (!db.config[key][id]) {
        db.config[key][id] = { ...record };
        summary[counter] += 1;
        changed = true;
      }
    }
  };
  union('topupRequests', 'topupRequests');
  union('topupClaims', 'topupClaims');
  union('topupIntents', 'topupIntents');

  // usedUtrs — sabse zaroori: ek UTR hamesha ek hi baar.
  if (!db.config.usedUtrs || typeof db.config.usedUtrs !== 'object') db.config.usedUtrs = {};
  for (const [utr, record] of Object.entries(snapSections.usedUtrs || {})) {
    if (!db.config.usedUtrs[utr]) {
      db.config.usedUtrs[utr] = { ...(record || {}) };
      summary.usedUtrs += 1;
      changed = true;
    }
  }

  if (changed) db.config.lastMoneyRestoreAt = new Date(at).toISOString();
  return { changed, summary };
}

/** App/tools me dikhane ke liye ek line — sach, dhamki nahi. */
export function describeDurableState({ snapshotAt = '', restoredAt = '', cloud = false, localOnly = false, walletCount = 0, utrCount = 0 } = {}) {
  if (!cloud) return 'Cloud backup OFF — deploy par wallet aur UTR ki yaad mit sakti hai. GITHUB_VAULT_TOKEN Render env me daalein.';
  const bits = [`Cloud backup ON`];
  if (snapshotAt) bits.push(`last snapshot ${snapshotAt}`);
  if (restoredAt) bits.push(`deploy ke baad restore hua ${restoredAt}`);
  bits.push(`${walletCount} wallet, ${utrCount} UTR yaad`);
  if (localOnly) bits.push('disk local hai — deploy par khali ho sakta hai');
  return bits.join(' · ');
}
