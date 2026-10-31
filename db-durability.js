/**
 * Boss (31-10-2026, round 19):
 *   "SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"
 *
 * Render par disk attach na ho to har deploy `db.json` naya bana deta hai.
 * Isliye paisa + UTR ka sach **encrypted** form me cloud vault (`bot-vault`
 * branch) me rakha jata hai aur boot par wapas milta hai.
 *
 *  • `backupMoneyNow()`   — snapshot push (throttled)
 *  • `restoreMoneyOnBoot()` — boot par pull + merge (paisa kam nahi hota)
 *  • `durabilityStatus()` — app/boss ko sach (cloud ON/OFF, last snapshot, restore)
 *
 * Kuch bhi token ke bina nahi hota — aur token na ho to status saaf bolta hai
 * ki deploy par data ja sakta hai (jhootha "safe hai" nahi).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb, saveDb } from './store.js';
import { buildMoneySnapshot, snapshotHasData, needsMoneyRestore, mergeMoneySnapshot, describeDurableState } from './money-snapshot.js';
import { pushVaultTextFile, pullVaultTextFile, resolveVaultToken, encryptVaultPayloadObject, decryptVaultPayloadText } from './vault-sync.js';

const SNAPSHOT_PATH = 'vault/db-money-snapshot.json';
const LOCAL_COPY = 'db-money-snapshot.json';
const PUSH_MIN_INTERVAL_MS = 20_000;

const state = {
  lastPushAt: '',
  lastPushOk: null,
  lastError: '',
  restoredAt: '',
  restoredSummary: null,
  bootChecked: false,
  pushing: false,
  pending: false,
  timer: null
};

function localCopyPath() {
  try { return path.join(getDataDir(), LOCAL_COPY); } catch { return ''; }
}

/**
 * Local disk copy — cloud token na ho to bhi redeploy ke baad (disk bacha ho
 * to) paisa wapas milta hai.
 */
function writeLocalCopy(snapshot) {
  const file = localCopyPath();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    state.lastError = `local copy: ${err?.message || err}`;
    return false;
  }
}

function readLocalCopy() {
  const file = localCopyPath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && snapshotHasData(parsed) ? parsed : null;
  } catch { return null; }
}

/** Snapshot push — best effort, kabhi throw nahi. */
export async function backupMoneyNow({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.lastPushAt && now - Date.parse(state.lastPushAt) < PUSH_MIN_INTERVAL_MS) {
    state.pending = true;
    return { ok: false, skipped: 'throttled' };
  }
  if (state.pushing) { state.pending = true; return { ok: false, skipped: 'busy' }; }
  state.pushing = true;
  try {
    const db = getDb();
    const snapshot = buildMoneySnapshot(db);
    if (!snapshotHasData(snapshot)) return { ok: false, skipped: 'empty' };
    const localOk = writeLocalCopy(snapshot);
    const token = resolveVaultToken();
    if (!token) {
      state.lastPushAt = new Date(now).toISOString();
      state.lastPushOk = localOk;
      state.lastError = localOk ? 'cloud token nahi — sirf local copy' : 'cloud token nahi aur local copy fail';
      return { ok: localOk, localOnly: true };
    }
    const text = JSON.stringify({ __moneySnapshot: true, at: snapshot.at, payload: encryptVaultPayloadObject(snapshot) });
    const res = await pushVaultTextFile(SNAPSHOT_PATH, text, 'chore(vault): money/UTR snapshot (deploy-proof)');
    state.lastPushAt = new Date(now).toISOString();
    state.lastPushOk = res?.ok === true;
    state.lastError = res?.ok ? '' : String(res?.reason || res?.error || `HTTP ${res?.status || '?'}`);
    return { ok: state.lastPushOk, localOnly: false };
  } catch (err) {
    state.lastError = String(err?.message || err);
    return { ok: false, error: state.lastError };
  } finally {
    state.pushing = false;
    if (state.pending) {
      state.pending = false;
      const t = setTimeout(() => { backupMoneyNow({ force: true }).catch(() => {}); }, 1500);
      if (typeof t.unref === 'function') t.unref();
    }
  }
}

function decodeSnapshotText(text) {
  if (!text) return null;
  const asSnapshot = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return asSnapshot(JSON.parse(value)); } catch { return null; }
    }
    if (typeof value !== 'object') return null;
    // `decryptVaultPayloadText` parsed object deta hai, isliye dono shape chalti hain.
    if (value.sections && value.version) return value;
    return null;
  };
  try {
    const parsed = JSON.parse(text);
    const payload = parsed?.payload ?? parsed;
    if (typeof payload === 'string' || (payload && typeof payload === 'object' && payload.__vaultEnc)) {
      const inner = decryptVaultPayloadText(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return asSnapshot(inner);
    }
    // Plain / doosre shape: `sections` wala seedha snapshot.
    return asSnapshot(payload);
  } catch { return null; }
}

/**
 * Boot par ek baar: agar db fresh lagta hai (deploy ke baad) aur snapshot
 * milta hai to paisa/UTR wapas. Local copy bhi try hoti hai.
 */
export async function restoreMoneyOnBoot() {
  state.bootChecked = true;
  const db = getDb();
  let snapshot = readLocalCopy();
  let source = snapshot ? 'local' : '';
  if (!snapshot) {
    try {
      const text = await pullVaultTextFile(SNAPSHOT_PATH);
      snapshot = decodeSnapshotText(text);
      if (snapshot) source = 'cloud';
    } catch { /* network issue — local par chalta hai */ }
  }
  if (!snapshot) {
    state.restoredAt = '';
    return { restored: false, reason: 'snapshot nahi mila' };
  }
  if (!needsMoneyRestore(db, snapshot)) {
    // Local db me pehle se data hai — merge phir bhi karo (union, paisa kam nahi).
    const merge = mergeMoneySnapshot(db, snapshot);
    if (merge.changed) { saveDb(db); state.restoredAt = new Date().toISOString(); state.restoredSummary = merge.summary; }
    return { restored: merge.changed, source, summary: merge.summary, reason: merge.changed ? '' : 'local db me pehle se data hai' };
  }
  const merge = mergeMoneySnapshot(db, snapshot);
  if (merge.changed) {
    saveDb(db);
    state.restoredAt = new Date().toISOString();
    state.restoredSummary = merge.summary;
    console.log('[db-durability] money/UTR restore', source, JSON.stringify(merge.summary));
    return { restored: true, source, summary: merge.summary };
  }
  return { restored: false, source, reason: 'merge me kuch nahi mila' };
}

/** Boot par interval — har 30s me (badla ho to) snapshot. */
export function startDbDurability({ intervalMs = 30_000 } = {}) {
  if (state.timer) return state.timer;
  state.timer = setInterval(() => { backupMoneyNow().catch(() => {}); }, intervalMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  // Shutdown se pehle bhi ek baar (best effort).
  try {
    process.once('SIGTERM', () => { backupMoneyNow({ force: true }).catch(() => {}); });
    process.once('beforeExit', () => { backupMoneyNow({ force: true }).catch(() => {}); });
  } catch {}
  return state.timer;
}

export function durabilityStatus() {
  let wallets = 0;
  let utrs = 0;
  try {
    const config = getDb()?.config || {};
    wallets = Object.keys(config.wallets || {}).length;
    utrs = Object.keys(config.usedUtrs || {}).length;
  } catch {}
  const cloud = Boolean(resolveVaultToken());
  const dataDir = (() => { try { return getDataDir(); } catch { return ''; } })();
  const looksEphemeral = !/^\/app\/data|^\/data\b|^\/var\/data/.test(dataDir) && process.env.NODE_ENV === 'production';
  return {
    cloud,
    dataDir,
    looksEphemeral,
    lastPushAt: state.lastPushAt,
    lastPushOk: state.lastPushOk,
    lastError: state.lastError,
    restoredAt: state.restoredAt,
    restoredSummary: state.restoredSummary,
    wallets,
    utrs,
    line: describeDurableState({
      snapshotAt: state.lastPushAt ? new Date(state.lastPushAt).toLocaleString('en-IN') : '',
      restoredAt: state.restoredAt ? new Date(state.restoredAt).toLocaleString('en-IN') : '',
      cloud,
      localOnly: looksEphemeral,
      walletCount: wallets,
      utrCount: utrs
    })
  };
}

/** Test ke liye — state reset. */
export function _resetDurabilityState() {
  state.lastPushAt = ''; state.lastPushOk = null; state.lastError = '';
  state.restoredAt = ''; state.restoredSummary = null; state.bootChecked = false;
  state.pushing = false; state.pending = false;
}
