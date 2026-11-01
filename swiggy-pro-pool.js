import crypto from 'node:crypto';
import { getDb, isBoss, saveDb } from './store.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { readProAccountReservation, reservationOwnedBy } from './swiggy-pro-reservations.js';

// The Boss must explicitly grant users and opt individual shared-vault accounts
// into this pool. A customer receives only opaque references and metadata; the
// underlying Swiggy credentials never leave the server.
function config() {
  const db = getDb();
  const current = db.config?.proManagedPool;
  return {
    db,
    users: Array.isArray(current?.users) ? current.users.map(String) : [],
    accounts: Array.isArray(current?.accounts) ? current.accounts.map(String) : []
  };
}

function secret() {
  const value = String(process.env.PRO_VAULT_KEY || process.env.VAULT_ENCRYPTION_KEY || '').trim();
  if (Buffer.byteLength(value) < 16) throw new Error('Mini App vault is not configured.');
  return value;
}

export function managedAccountRef(key) {
  return 'managed_' + crypto.createHmac('sha256', secret()).update(`pro-managed-account:${String(key)}`).digest('base64url').slice(0, 24);
}

export function poolEnabledFor(userId) {
  return isBoss(userId) || config().users.includes(String(userId));
}

export function managedEntries(userId) {
  if (isBoss(userId) || !poolEnabledFor(userId)) return [];
  const { db, accounts } = config();
  const vault = db.config?.accounts || {};
  return accounts.filter(key => Object.prototype.hasOwnProperty.call(vault, key) && vault[key])
    .map(key => ({ ref: managedAccountRef(key), key, account: vault[key] }));
}

export function managedEntryFor(userId, ref) {
  return managedEntries(userId).find(item => item.ref === String(ref)) || null;
}

export function poolSettingsForBoss(userId) {
  if (!isBoss(userId)) return null;
  const { users, accounts } = config();
  return { users: [...users], accounts: [...accounts] };
}

export function setPoolUser(actorId, targetId, allowed) {
  if (!isBoss(actorId)) throw Object.assign(new Error('Only the bot owner can manage access.'), { statusCode: 403 });
  const id = String(targetId || '').trim();
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw Object.assign(new Error('Enter a valid Telegram user ID.'), { statusCode: 400 });
  }
  if (typeof allowed !== 'boolean') throw Object.assign(new Error('Specify whether to allow this user.'), { statusCode: 400 });
  const { db, users, accounts } = config();
  if (!allowed && accounts.some(key => reservationOwnedBy(readProAccountReservation(key), id))) {
    throw Object.assign(new Error('This user has a reserved ID. Ask them to release it, or resolve their pending order, before removing access.'), { statusCode: 409 });
  }
  const updated = new Set(users);
  if (allowed) updated.add(id); else updated.delete(id);
  if (updated.size > 200) throw Object.assign(new Error('Too many authorized users.'), { statusCode: 400 });
  db.config.proManagedPool = { users: [...updated], accounts };
  saveDb(db);
  return poolSettingsForBoss(actorId);
}

export function setPoolAccount(actorId, accountKey, allowed) {
  if (!isBoss(actorId)) throw Object.assign(new Error('Only the bot owner can share accounts.'), { statusCode: 403 });
  const key = String(accountKey || '');
  const { db, users, accounts } = config();
  if (!Object.prototype.hasOwnProperty.call(db.config?.accounts || {}, key)) {
    throw Object.assign(new Error('Account not found.'), { statusCode: 404 });
  }
  if (typeof allowed !== 'boolean') throw Object.assign(new Error('Specify whether to share this account.'), { statusCode: 400 });
  if (!allowed && readProAccountReservation(key)) {
    throw Object.assign(new Error('This ID is reserved. Resolve its current order or release it before stopping sharing.'), { statusCode: 409 });
  }
  const updated = new Set(accounts);
  if (allowed) updated.add(key); else updated.delete(key);
  if (updated.size > 200) throw Object.assign(new Error('Too many shared accounts.'), { statusCode: 400 });
  db.config.proManagedPool = { users, accounts: [...updated] };
  saveDb(db);
  return poolSettingsForBoss(actorId);
}

// A quarantine or an outstanding chat lock is never silently cleared here.
// Stored session flags are evidence of a problem, not proof of present health.
export function accountAvailability(account) {
  if (!account || account.isLoggedOut || !account.isLoggedIn || !(account.token || account.tid || account.jwtTid || account.cookies || account._session_tid || account.sessionId)) return 'LOGGED_OUT';
  if (account.sessionExpired) return 'SESSION_EXPIRED';
  if (account.healthStatus === 'SUSPENDED' || account.suspended === true || account.suspendedAt) return 'SUSPENDED';
  if (account.orderLock?.orderId) return 'BUSY';
  return 'NOT_CHECKED';
}

export function safeManagedLabel(account) {
  const phone = normalizeIndianMobileNumber(account?.phone || account?.mobile || '') || '';
  return phone ? `ID · ••••${phone.slice(-4)}` : 'Managed Swiggy ID';
}

export function maskedManagedPhone(value) {
  const phone = normalizeIndianMobileNumber(value || '') || '';
  return phone ? `••••${phone.slice(-4)}` : '';
}

export function knownOrderCount(account) {
  const raw = account?.totalOrdersCount ?? account?.cachedTotalOrdersCount;
  if (account?.ordersVerifiedLive !== true || account?.orderCountSource !== 'LIVE' || !Number.isFinite(Date.parse(account?.orderTruthCheckedAt || '')) || typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw === 999999) return null;
  return raw;
}

// This is a record of an earlier provider result, never an inferred current offer.
export function recordedOffers(account) {
  const records = account?.offerAutoActivation;
  if (!records || typeof records !== 'object' || !Number.isFinite(Date.parse(records.at || ''))) return [];
  const slots = [['breakfast', 'Breakfast'], ['lateNight', 'Late night'], ['extra50', 'Extra offer'], ['weekend', 'Weekend']];
  return slots.flatMap(([key, label]) => {
    const entry = records[key];
    if (!entry || typeof entry !== 'object') return [];
    const status = String(entry.status || '').toUpperCase();
    if (!['CLAIMED', 'ALREADY_CLAIMED', 'PRE_LOCKED', 'USED', 'EXPIRED', 'FAILED'].includes(status)) return [];
    return [{ key, label, status, checkedAt: String(entry.claimedAt || records.at || '').slice(0, 40) }];
  });
}
