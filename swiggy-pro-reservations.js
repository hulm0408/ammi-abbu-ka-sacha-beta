import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './store.js';

// Durable per-vault-account reservations coordinate the Mini App with the
// main chat bot on a single persistent volume. They are not chat-order locks:
// chat's stale-order cleanup must never expire an unresolved Mini App order.
function dir() { return path.join(getDataDir(), 'pro-account-reservations'); }
function file(accountKey) {
  const digest = crypto.createHash('sha256').update(String(accountKey)).digest('hex');
  return path.join(dir(), `${digest}.json`);
}
function ownerHash(userId) { return crypto.createHash('sha256').update(`pro-owner:${String(userId)}`).digest('hex'); }
function syncDir() {
  const fd = fs.openSync(dir(), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function busyError() {
  return Object.assign(new Error('This Swiggy ID is reserved for another order. Choose another ID or ask the owner.'), { statusCode: 409, code: 'PRO_ACCOUNT_RESERVED' });
}

export function readProAccountReservation(accountKey) {
  if (!accountKey) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file(accountKey), 'utf8'));
    if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(String(value.owner || '')) || !['PREPARING', 'UNRESOLVED'].includes(value.state)) {
      return { state: 'CORRUPT', owner: '' };
    }
    return value;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // A damaged or inaccessible reservation never means the account is free.
    return { state: 'CORRUPT', owner: '' };
  }
}

export function reservationOwnedBy(reservation, userId) {
  return Boolean(reservation && userId && reservation.owner === ownerHash(userId));
}

export function proAccountReservedForOther(accountKey, userId = '') {
  const reservation = readProAccountReservation(accountKey);
  return Boolean(reservation && !reservationOwnedBy(reservation, userId));
}

export function acquireProAccountReservation(accountKey, userId) {
  if (!accountKey || !userId) throw busyError();
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const reservation = { version: 1, owner: ownerHash(userId), state: 'PREPARING', createdAt: new Date().toISOString() };
  let fd;
  try {
    // Exclusive create makes two different users/processes race for one owner.
    fd = fs.openSync(file(accountKey), 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(reservation));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDir();
    const parentFd = fs.openSync(path.dirname(dir()), 'r');
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return reservation;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (err?.code !== 'EEXIST') throw err;
    const existing = readProAccountReservation(accountKey);
    if (reservationOwnedBy(existing, userId)) return existing;
    throw busyError();
  }
}

export function setProAccountReservationState(accountKey, userId, state) {
  if (!['PREPARING', 'UNRESOLVED'].includes(state)) throw new Error('Invalid reservation state.');
  const existing = readProAccountReservation(accountKey);
  if (!reservationOwnedBy(existing, userId)) throw busyError();
  const next = { ...existing, state, updatedAt: new Date().toISOString() };
  const tmp = `${file(accountKey)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(next));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file(accountKey));
    syncDir();
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
  return next;
}

export function releaseProAccountReservation(accountKey, userId, { verifiedPaid = false } = {}) {
  const existing = readProAccountReservation(accountKey);
  if (!existing) return false;
  if (!reservationOwnedBy(existing, userId)) throw busyError();
  if (existing.state !== 'PREPARING' && !verifiedPaid) {
    throw Object.assign(new Error('An order may exist. This ID cannot be released until the original order is verified.'), { statusCode: 409 });
  }
  fs.unlinkSync(file(accountKey));
  syncDir();
  return true;
}
