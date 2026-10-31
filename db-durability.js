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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb, saveDb } from './store.js';
import { buildMoneySnapshot, snapshotHasData, needsMoneyRestore, mergeMoneySnapshot, describeDurableState } from './money-snapshot.js';
import { buildIdentitySnapshot, snapshotHasIdentities, mergeIdentitySnapshot, describeIdentityDurability, summarizeIdentities } from './identity-snapshot.js';
import { pushVaultTextFile, pullVaultTextFile, resolveVaultToken, encryptVaultPayloadObject, decryptVaultPayloadText } from './vault-sync.js';
import { proWorkspaceKeyHealth } from './swiggy-pro-store.js';

const SNAPSHOT_PATH = 'vault/db-money-snapshot.json';
const LOCAL_COPY = 'db-money-snapshot.json';
// Round 22: login IDs + mini-app workspaces bhi deploy-proof (boss: "JITNE BHI
// LOGIN ID HOTE HAIN KISIKA DATA NAHI BACHTA").
const IDENTITY_PATH = 'vault/db-identity-snapshot.json';
const LOCAL_IDENTITY_COPY = 'db-identity-snapshot.json';
const PUSH_MIN_INTERVAL_MS = 20_000;

const identityState = {
  lastPushAt: '', lastPushOk: null, lastError: '', restoredAt: '', restoredSummary: null,
  pushing: false, pending: false
};

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
  state.timer = setInterval(() => {
    backupMoneyNow().catch(() => {});
    // Round 22: login IDs + workspaces bhi (deploy se pehle hi cloud par ho).
    backupIdentityNow().catch(() => {});
  }, intervalMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  // Shutdown se pehle bhi ek baar (best effort).
  try {
    process.once('SIGTERM', () => {
      backupMoneyNow({ force: true }).catch(() => {});
      backupIdentityNow({ force: true }).catch(() => {});
    });
    process.once('beforeExit', () => {
      backupMoneyNow({ force: true }).catch(() => {});
      backupIdentityNow({ force: true }).catch(() => {});
    });
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
  let identity = null;
  try { identity = identityStatus(); } catch { identity = null; }
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
    // Round 22: login IDs ka sach bhi isi status me.
    identity: identity ? {
      total: identity.total, live: identity.live, expired: identity.expired,
      workspaces: identity.workspaceCount, restoredAt: identity.restoredAt,
      lastPushAt: identity.lastPushAt, lastError: identity.lastError, line: identity.line
    } : null,
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


// ── Login ID / mini-app workspace durability (round 22) ────────────────────

function identityLocalPath() {
  try { return path.join(getDataDir(), LOCAL_IDENTITY_COPY); } catch { return ''; }
}

function writeIdentityLocalCopy(snapshot) {
  const file = identityLocalPath();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    identityState.lastError = `local copy: ${err?.message || err}`;
    return false;
  }
}

function readIdentityLocalCopy() {
  const file = identityLocalPath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && snapshotHasIdentities(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * Login IDs + mini-app workspaces ka snapshot — local copy + encrypted cloud.
 * Kabhi throw nahi karta (backup fail hone se app nahi rukta).
 */
export async function backupIdentityNow({ force = false } = {}) {
  const now = Date.now();
  if (!force && identityState.lastPushAt && now - Date.parse(identityState.lastPushAt) < PUSH_MIN_INTERVAL_MS) {
    identityState.pending = true;
    return { ok: false, skipped: 'throttled' };
  }
  if (identityState.pushing) { identityState.pending = true; return { ok: false, skipped: 'busy' }; }
  identityState.pushing = true;
  try {
    const db = getDb();
    const snapshot = buildIdentitySnapshot(db);
    // Mirror row se naya disk file ho to wahi snapshot me jaye — warna 1.5s ke
    // debounce me hua aakhri change deploy par chhut sakta hai.
    try {
      const dir = path.join(getDataDir(), 'pro-workspaces');
      for (const row of Object.values(snapshot.workspaces)) {
        const file = path.join(dir, `${require_sha256(row.userId)}.json`);
        if (!fs.existsSync(file)) continue;
        const envelope = fs.readFileSync(file, 'utf8');
        if (envelope.length > 20 && envelope.includes('"version"')) row.envelope = envelope;
      }
    } catch { /* disk read best-effort */ }
    if (!snapshotHasIdentities(snapshot)) return { ok: false, skipped: 'empty' };
    const localOk = writeIdentityLocalCopy(snapshot);
    const token = resolveVaultToken();
    if (!token) {
      identityState.lastPushAt = new Date(now).toISOString();
      identityState.lastPushOk = localOk;
      identityState.lastError = localOk ? 'cloud token nahi — sirf local copy' : 'cloud token nahi aur local copy fail';
      return { ok: localOk, localOnly: true };
    }
    const text = JSON.stringify({ __identitySnapshot: true, at: snapshot.at, payload: encryptVaultPayloadObject(snapshot) });
    const res = await pushVaultTextFile(IDENTITY_PATH, text, 'chore(vault): login IDs + mini-app workspaces (deploy-proof)');
    identityState.lastPushAt = new Date(now).toISOString();
    identityState.lastPushOk = res?.ok === true;
    identityState.lastError = res?.ok ? '' : String(res?.reason || res?.error || `HTTP ${res?.status || '?'}`);
    return { ok: identityState.lastPushOk, localOnly: false, counts: snapshot.counts };
  } catch (err) {
    identityState.lastError = String(err?.message || err);
    return { ok: false, error: identityState.lastError };
  } finally {
    identityState.pushing = false;
    if (identityState.pending) {
      identityState.pending = false;
      const t = setTimeout(() => { backupIdentityNow({ force: true }).catch(() => {}); }, 1500);
      if (typeof t.unref === 'function') t.unref();
    }
  }
}

function decodeIdentityText(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const payload = parsed?.payload ?? parsed;
    if (typeof payload === 'string' || (payload && typeof payload === 'object' && payload.__vaultEnc)) {
      const inner = decryptVaultPayloadText(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (!inner || typeof inner !== 'object') return null;
      return inner.accounts || inner.workspaces ? inner : null;
    }
    if (payload && typeof payload === 'object' && payload.accounts) return payload;
    return null;
  } catch { return null; }
}

/**
 * Boot par: deploy ke baad khaali db me login IDs + workspaces wapas.
 * Local copy pehle, phir cloud. Live local session kabhi overwrite nahi hota.
 */
export async function restoreIdentityOnBoot() {
  let snapshot = readIdentityLocalCopy();
  let source = snapshot ? 'local' : '';
  if (!snapshot) {
    try {
      const text = await pullVaultTextFile(IDENTITY_PATH);
      snapshot = decodeIdentityText(text);
      if (snapshot) source = 'cloud';
    } catch { /* network issue — local par chalta hai */ }
  }
  if (!snapshot) return { restored: false, reason: 'identity snapshot nahi mila' };
  const db = getDb();
  const merge = mergeIdentitySnapshot(db, snapshot);
  // Workspace files bhi disk par wapas — warna user ko dobara login karna padta.
  let workspacesWritten = 0;
  for (const item of merge.workspacesToRestore) {
    try {
      const file = path.join(getDataDir(), 'pro-workspaces');
      fs.mkdirSync(file, { recursive: true, mode: 0o700 });
      const target = path.join(file, `${require_sha256(item.userId)}.json`);
      if (fs.existsSync(target)) continue;
      const tmp = `${target}.${process.pid}.restore.tmp`;
      fs.writeFileSync(tmp, item.envelope, { mode: 0o600 });
      fs.renameSync(tmp, target);
      workspacesWritten += 1;
    } catch { /* ek workspace fail ho to baaki chalte rahen */ }
  }
  if (merge.changed) {
    saveDb(db);
    identityState.restoredAt = new Date().toISOString();
    identityState.restoredSummary = { ...merge.summary, workspacesWritten };
    console.log('[db-durability] login ID restore', source, JSON.stringify(identityState.restoredSummary));
  }
  return {
    restored: merge.changed,
    source,
    summary: { ...merge.summary, workspacesWritten },
    reason: merge.changed ? '' : 'local db me IDs pehle se hain'
  };
}

function require_sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Boss/user card ke liye login ID ka sach. */
export function identityStatus() {
  let accounts = [];
  let workspaceCount = 0;
  let cloud = false;
  let workspaceHealth = { ok: 0, failed: 0, total: 0, keySource: '' };
  try {
    const db = getDb();
    accounts = summarizeIdentities(db?.config?.accounts);
    workspaceCount = Object.keys(db?.config?.proWorkspaceMirror || {}).length;
    cloud = Boolean(resolveVaultToken());
    workspaceHealth = proWorkspaceKeyHealth();
  } catch { /* health check best-effort */ }
  const live = accounts.filter((a) => a.status === 'LOGGED_IN').length;
  const expired = accounts.filter((a) => a.status === 'EXPIRED' || a.status === 'LOGGED_OUT').length;
  return {
    cloud,
    total: accounts.length,
    live,
    expired,
    workspaceCount,
    lastPushAt: identityState.lastPushAt,
    lastPushOk: identityState.lastPushOk,
    lastError: identityState.lastError,
    restoredAt: identityState.restoredAt,
    restoredSummary: identityState.restoredSummary,
    workspaceHealth,
    accounts,
    line: describeIdentityDurability({
      cloud,
      accountCount: accounts.length,
      workspaceCount,
      restoredAt: identityState.restoredAt,
      snapshotAt: identityState.lastPushAt,
      lastError: identityState.lastError
    }) + (workspaceHealth.failed > 0
      ? ` · ${workspaceHealth.failed} mini-app workspace is vault key se khul nahi rahe — PRO_VAULT_KEY/VAULT_ENCRYPTION_KEY badla lagta hai (data safe hai, par padha nahi ja sakta).`
      : '')
  };
}

/** Test ke liye — state reset. */
export function _resetDurabilityState() {
  identityState.lastPushAt = ''; identityState.lastPushOk = null; identityState.lastError = '';
  identityState.restoredAt = ''; identityState.restoredSummary = null;
  identityState.pushing = false; identityState.pending = false;
  state.lastPushAt = ''; state.lastPushOk = null; state.lastError = '';
  state.restoredAt = ''; state.restoredSummary = null; state.bootChecked = false;
  state.pushing = false; state.pending = false;
}
