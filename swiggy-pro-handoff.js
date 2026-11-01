import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clearDraft, flushDbSync, getDataDir, getDb, getDbFile } from './store.js';

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'REJECTED']);
function dir() { return path.join(getDataDir(), 'pro-chat-handoffs'); }
function file(userId) {
  if (!/^\d{1,20}$/.test(String(userId))) throw new Error('Invalid Telegram user.');
  return path.join(dir(), crypto.createHash('sha256').update(String(userId)).digest('hex') + '.json');
}
function syncDir() {
  const fd = fs.openSync(dir(), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function handoffError(message) { return Object.assign(new Error(message), { statusCode: 409 }); }
function syncDirectory(location) {
  const fd = fs.openSync(location, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableDbSnapshot() {
  flushDbSync();
  const dbFile = getDbFile();
  const fd = fs.openSync(dbFile, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(dbFile));
  return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
}
function chatSubmissionDir() { return path.join(getDataDir(), 'chat-submission-guards'); }
function chatSubmissionFile(userId) {
  if (!/^\d{1,20}$/.test(String(userId))) throw new Error('Invalid Telegram user.');
  return path.join(chatSubmissionDir(), crypto.createHash('sha256').update(String(userId)).digest('hex') + '.json');
}

// Only a hash is kept in the ownership marker; the link itself stays server-side.
export function chatDraftFingerprint(draft) {
  return crypto.createHash('sha256').update(JSON.stringify({
    cart: String(draft?.cart || ''),
    address: String(draft?.addressLink || draft?.address || ''),
    typed: Boolean(draft?.addressTyped)
  })).digest('hex');
}
export function readChatHandoff(userId) {
  try {
    const value = JSON.parse(fs.readFileSync(file(userId), 'utf8'));
    if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(String(value.fingerprint || ''))) return { state: 'CORRUPT' };
    return value;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return { state: 'CORRUPT' }; // fail closed, never quietly re-enable chat
  }
}

// A chat submission gets its own write-ahead marker until the bot order and
// consumed draft have both been fsynced to the existing database. If the
// process dies first, neither chat nor the Mini App can assume no order exists.
export function readChatSubmissionGuard(userId) {
  try {
    const value = JSON.parse(fs.readFileSync(chatSubmissionFile(userId), 'utf8'));
    if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(String(value.fingerprint || '')) || !value.orderId) return { state: 'CORRUPT' };
    return value;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return { state: 'CORRUPT' };
  }
}
export function beginChatSubmission(userId, fingerprint, orderId) {
  if (readChatHandoff(userId) || readChatSubmissionGuard(userId)) throw handoffError('A previous chat or Mini App order needs review.');
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint || '')) || !String(orderId || '').trim()) throw new Error('Invalid chat submission.');
  fs.mkdirSync(chatSubmissionDir(), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(chatSubmissionFile(userId), 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ version: 1, fingerprint, orderId: String(orderId), createdAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDirectory(chatSubmissionDir());
    syncDirectory(path.dirname(chatSubmissionDir()));
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
export function finishChatSubmission(userId, orderId) {
  const marker = readChatSubmissionGuard(userId);
  if (!marker || marker.state === 'CORRUPT' || marker.orderId !== String(orderId)) throw handoffError('Chat submission ownership could not be verified.');
  const disk = durableDbSnapshot();
  const order = disk.orders?.[String(orderId)];
  const draft = disk.drafts?.[String(userId)];
  if (!order || String(order.userId) !== String(userId) || (draft && chatDraftFingerprint(draft) === marker.fingerprint)) {
    throw handoffError('The chat order could not be durably recorded. Ask the owner to investigate before retrying.');
  }
  fs.unlinkSync(chatSubmissionFile(userId));
  syncDirectory(chatSubmissionDir());
}

export function getTransferableChatDraft(userId) {
  if (readChatSubmissionGuard(userId)) throw handoffError('A chat submission is still being checked. Ask the owner before starting another order.');
  const db = getDb();
  const draft = db.drafts?.[String(userId)];
  if (!draft?.cart || !draft?.address) throw handoffError('Send both the Swiggy cart and address links to the bot first.');
  // A linked/submitted draft is not transferable, even if an old chat order is
  // missing or terminal. Age/TTL alone never proves a provider order did not exist.
  if (draft.submitted || draft.currentOrderId || draft.activeOrderId) {
    throw handoffError('This chat draft is linked to an order. Check that order before using the Mini App.');
  }
  const active = Object.values(db.orders || {}).find(order => order && String(order.userId) === String(userId) && !TERMINAL.has(String(order.status || '').toUpperCase()));
  if (active) throw handoffError('A chat order is still open. Resolve it before transferring a draft to the Mini App.');
  return structuredClone(draft);
}

export function claimChatHandoff(userId, fingerprint) {
  const prior = readChatHandoff(userId);
  if (prior) {
    if (prior.fingerprint === fingerprint) return prior;
    throw handoffError('A different chat draft is already open in the Mini App. Return to it or release it first.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) throw new Error('Invalid draft fingerprint.');
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(file(userId), 'wx', 0o600);
    const value = { version: 1, fingerprint, createdAt: new Date().toISOString() };
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDir();
    const parentFd = fs.openSync(path.dirname(dir()), 'r');
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return value;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (err?.code === 'EEXIST') {
      const existing = readChatHandoff(userId);
      if (existing?.fingerprint === fingerprint) return existing;
      throw handoffError('A chat draft is already open in the Mini App.');
    }
    throw err;
  }
}

// Record completion before clearing the workspace. If the process dies between
// those writes, a later release still consumes the matching chat draft.
export function markChatHandoffPaid(userId) {
  const marker = readChatHandoff(userId);
  if (!marker || marker.state === 'CORRUPT') throw handoffError('Draft ownership could not be verified; contact the owner.');
  const tmp = `${file(userId)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ ...marker, state: 'PAID', paidAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file(userId));
    syncDir();
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Caller must first persist a discarded or verified-paid Mini App state.
export function releaseChatHandoff(userId, { paid = false } = {}) {
  const marker = readChatHandoff(userId);
  if (!marker) return false;
  if (marker.state === 'CORRUPT') throw handoffError('Draft ownership could not be verified; contact the owner.');
  if (paid || marker.state === 'PAID') {
    const current = getDb().drafts?.[String(userId)];
    if (current && chatDraftFingerprint(current) === marker.fingerprint) clearDraft(userId);
    // Even if another handler already changed the in-memory draft, sync that
    // change before removing the paid marker; a restart must not resurrect it.
    const disk = durableDbSnapshot();
    const saved = disk.drafts?.[String(userId)];
    if (saved && chatDraftFingerprint(saved) === marker.fingerprint) throw handoffError('Could not durably consume the paid draft. Contact the owner.');
  }
  fs.unlinkSync(file(userId));
  syncDir();
  return true;
}
