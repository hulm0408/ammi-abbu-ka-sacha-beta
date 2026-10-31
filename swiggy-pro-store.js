import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './store.js';

// The chat bot's shared vault must not contain the Mini App's private users.
// Each Telegram user's workspace is authenticated and encrypted separately.
// Back this directory up on an encrypted persistent volume: it is deliberately
// NOT included in the bot's existing shared-account cloud vault.
function secretKey() {
  const secret = String(process.env.PRO_VAULT_KEY || process.env.VAULT_ENCRYPTION_KEY || '').trim();
  if (Buffer.byteLength(secret) < 16) {
    const err = new Error('Mini App vault is not configured. Set PRO_VAULT_KEY (at least 16 characters) on the server.');
    err.statusCode = 503;
    throw err;
  }
  return crypto.scryptSync(secret, 'sacha-beta-miniapp-v1', 32);
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
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
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
