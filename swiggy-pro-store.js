import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './store.js';
import { proWorkspaceVaultPath, pullVaultTextFile, pushVaultTextFile } from './vault-sync.js';

// The chat bot's shared vault must not contain the Mini App's private users.
// Each Telegram user's workspace is authenticated and encrypted separately.
// Back this directory up on an encrypted persistent volume: it is deliberately
// NOT included in the bot's existing shared-account cloud vault.
// ---------------------------------------------------------------------------
// VAULT KEY — boss (31-10-2026): "Server setup needed … Try again ISKO THEEK KAR"
//
// Pehle jab tak owner PRO_VAULT_KEY na daale, app dead-end tha: har user ko
// "Server setup needed" dikhta tha. Ab key khud manage hoti hai, par safe
// tarteeb me — jo data pehle se encrypted hai wo kabhi silently na toote:
//
//   1. PRO_VAULT_KEY / VAULT_ENCRYPTION_KEY  (owner ka explicit key — best)
//   2. DATA_DIR/pro-vault.key               (pehle se bani hui key file)
//   3. BOT_TOKEN se derive                  (deploy ke baad bhi same rehti hai,
//                                            ephemeral disk par bhi stable)
//   4. random generate + file me save       (sirf jab BOT_TOKEN bhi na ho)
//
// Sach ka rule: agar kisi user ka purana workspace is key se khulta nahi, to
// read path PRO_VAULT_DECRYPT_FAILED deta hai aur likhne ki koshish nahi hoti —
// purana data overwrite nahi hota (sirf "kuch nahi kiya" ka jhooth nahi).
// ---------------------------------------------------------------------------
const KEY_FILE_NAME = 'pro-vault.key';
// scrypt mehnga hai (~50ms) — sirf derived key cache karte hain, secret se
// keyed. Isse env badalne par nayi key turant lagti hai (stale cache nahi).
const derivedKeyCache = new Map();
let lastSource = '';

function keyFile() {
  return path.join(getDataDir(), KEY_FILE_NAME);
}

function workspaceDir() {
  return path.join(getDataDir(), 'pro-workspaces');
}

function keyFromSecret(secret) {
  const hit = derivedKeyCache.get(secret);
  if (hit) return hit;
  const key = crypto.scryptSync(secret, 'sacha-beta-miniapp-v1', 32);
  if (derivedKeyCache.size > 8) derivedKeyCache.clear();
  derivedKeyCache.set(secret, key);
  return key;
}

function readKeyFile() {
  try {
    const raw = fs.readFileSync(keyFile(), 'utf8').trim();
    return raw.length >= 16 ? raw : '';
  } catch {
    return '';
  }
}

function writeKeyFile(secret) {
  try {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${keyFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, secret, { mode: 0o600 });
    fs.renameSync(tmp, keyFile());
    return true;
  } catch (err) {
    console.warn('[MiniAppVault] key file save nahi hui (read-only disk?):', err?.message || err);
    return false;
  }
}

/**
 * Server par available secrets se deterministic key — redeploy ke baad bhi wahi,
 * isliye ephemeral disk par bhi workspaces khulte rehte hain.
 */
function derivedSecret() {
  // Sirf server ke asli secrets — DATA_DIR jaisa path nahi (wo machine badalne
  // par badal sakta hai, aur key badalna = purana data band).
  const parts = [
    String(process.env.BOT_TOKEN || '').trim(),
    String(process.env.PAY_WEBHOOK_SECRET || '').trim()
  ].filter(Boolean);
  if (!parts.length) return '';
  return crypto.createHash('sha256').update(`pro-vault-v1:${parts.join('|')}`).digest('hex');
}

/** Tests / rotate ke liye — key cache clear. */
export function resetProVaultKeyCache() {
  derivedKeyCache.clear();
  lastSource = '';
}

/** Ab kaunsi key source chal rahi hai (ENV / KEY_FILE / DERIVED / GENERATED). */
export function getProVaultSource() {
  try {
    secretKey();
    return lastSource;
  } catch (err) {
    return err?.code || 'UNKNOWN';
  }
}

function secretKey() {
  const explicit = String(process.env.PRO_VAULT_KEY || process.env.VAULT_ENCRYPTION_KEY || '').trim();
  if (Buffer.byteLength(explicit) >= 16) {
    lastSource = 'ENV';
    return keyFromSecret(explicit);
  }

  const fromFile = readKeyFile();
  if (fromFile) {
    lastSource = 'KEY_FILE';
    return keyFromSecret(fromFile);
  }

  // Server ke apne secrets se deterministic key — redeploy ke baad bhi wahi,
  // isliye ephemeral disk par bhi purana data khulta rehta hai.
  const derived = derivedSecret();
  if (derived) {
    lastSource = 'DERIVED';
    // File nahi likhte: derived key har boot par khud banti hai (BOT_TOKEN se),
    // isliye disk read-only ho ya na ho, key wahi rehti hai.
    console.log('[MiniAppVault] PRO_VAULT_KEY set nahi hai — bot ke server secrets se stable key derive ki gayi (source=DERIVED).');
    return keyFromSecret(derived);
  }

  // Kuch bhi available nahi — nayi random key banao aur disk par rakh do.
  const generated = crypto.randomBytes(32).toString('hex');
  lastSource = 'GENERATED';
  writeKeyFile(generated);
  console.warn('[MiniAppVault] Koi server secret nahi mila — nayi random vault key banayi (source=GENERATED).');
  return keyFromSecret(generated);
}

function workspacePath(userId) {
  if (!/^\d{1,20}$/.test(String(userId))) throw new Error('Invalid Telegram user');
  const fileName = crypto.createHash('sha256').update(String(userId)).digest('hex') + '.json';
  return path.join(getDataDir(), 'pro-workspaces', fileName);
}

function aad(userId) {
  return Buffer.from(`sacha-beta-miniapp-v1:${userId}`);
}

export function emptyProWorkspace() {
  return { version: 1, accounts: {}, activeAccountKey: '', selectedAddress: null, addressCandidates: [], cart: null };
}

export function readProWorkspace(userId) {
  const key = secretKey();
  const file = workspacePath(userId);
  if (!fs.existsSync(file)) return emptyProWorkspace();
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (envelope.version !== 1) throw new Error('Unsupported workspace version');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const value = JSON.parse(plain.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace');
    return { ...emptyProWorkspace(), ...value, accounts: value.accounts || {} };
  } catch {
    const err = new Error('Unable to decrypt the Mini App workspace. Check the configured vault key; existing data was not changed.');
    err.statusCode = 503;
    err.code = 'PRO_VAULT_DECRYPT_FAILED';
    throw err;
  }
}

export function writeProWorkspace(userId, workspace) {
  const key = secretKey();
  const file = workspacePath(userId);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(userId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(workspace), 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    // Checkout state must survive a restart before a placement POST begins.
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, envelope);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    const parentFd = fs.openSync(path.dirname(dir), 'r');
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    scheduleProWorkspaceBackup(userId);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── DURABLE BACKUP (boss 31-10-2026) ──────────────────────────────────────
// "JAISE ME KOI CHEEZ UPDATE KARU TO SAARA USER KA DATA RESET NA HOJAYE, BAAKI
// RAHE UNKE PHONES ME." Render ka disk redeploy par khali ho sakta hai. Isliye
// har workspace ka ENCRYPTED blob cloud vault me bhi jata hai aur naye disk par
// pehli read se pehle wapas aata hai. Key wahi rehti hai (env/derived/key file),
// isliye blob wapas aane par data waisa hi khulta hai.
const hydratedUsers = new Set();
const backupTimers = new Map();

export function cloudBackupEnabled() {
  return process.env.PRO_VAULT_CLOUD_BACKUP !== '0';
}

function scheduleProWorkspaceBackup(userId) {
  if (!cloudBackupEnabled()) return;
  const key = String(userId);
  if (backupTimers.has(key)) return;
  const timer = setTimeout(async () => {
    backupTimers.delete(key);
    try {
      const file = workspacePath(key);
      if (!fs.existsSync(file)) return;
      await pushVaultTextFile(proWorkspaceVaultPath(path.basename(file)), fs.readFileSync(file, 'utf8'));
    } catch { /* best effort — local file hi asli hai */ }
  }, 6000);
  if (typeof timer.unref === 'function') timer.unref();
  backupTimers.set(key, timer);
}

/**
 * Naye/khali disk par (redeploy ke baad) encrypted workspace wapas laata hai.
 * Sirf tab likhta hai jab local file bilkul nahi hai — chalta hua data kabhi
 * overwrite nahi hota.
 */
export async function ensureProWorkspaceHydrated(userId) {
  const key = String(userId);
  if (hydratedUsers.has(key)) return false;
  hydratedUsers.add(key);
  if (!cloudBackupEnabled()) return false;
  try {
    const file = workspacePath(key);
    if (fs.existsSync(file)) return false;
    const text = await pullVaultTextFile(proWorkspaceVaultPath(path.basename(file)));
    if (!text || !text.trim().startsWith('{') || text.length > 2_000_000) return false;
    JSON.parse(text); // sirf valid envelope likho
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.restore.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    console.log('[MiniAppVault] encrypted workspace cloud vault se wapas aaya (redeploy recovery).');
    return true;
  } catch {
    return false;
  }
}

/** Tests ke liye. */
export function resetProWorkspaceHydrationCache() {
  hydratedUsers.clear();
  for (const timer of backupTimers.values()) clearTimeout(timer);
  backupTimers.clear();
}

const locks = new Map();
// Serialize complete requests for a user, including asynchronous provider calls.
// This prevents two tabs from losing each other's changes in one Node process.
export async function withProWorkspaceLock(userId, task) {
  const key = String(userId);
  const previous = locks.get(key) || Promise.resolve();
  let unlock;
  const current = new Promise((resolve) => { unlock = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    unlock();
    if (locks.get(key) === current) locks.delete(key);
  }
}
