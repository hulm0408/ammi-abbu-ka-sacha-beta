import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ACCOUNTS_JSON_FILE = path.join(__dirname, 'accounts.json');

const defaultData = {
  config: {
    totalSlots: 9,
    slotsLeft: 5,
    bossIds: [6484999726],
    familyMembers: {},
    accounts: {},
    deletedAccounts: {}
  },
  sessionVault: {},
  orders: {},
  drafts: {},
  bossState: null,
  userStates: {}
};

// Strips only transient/analytics bloat while preserving 100% of Swiggy auth cookies (_session_tid, tid, token, _sid, _device_id, __SW, _swuid, _is_logged_in)
export function cleanEssentialSwiggyCookies(cookieStr = '', fallback = {}) {
  const dropPrefixes = [
    'aws-waf-token=',
    '_ga=',
    '_ga_',
    '_gid=',
    '_gat',
    '_gcl_',
    'AMP_TOKEN=',
    'fontsLoaded=',
    'userLocation='
  ];
  const map = new Map();

  if (typeof cookieStr === 'string' && cookieStr.trim()) {
    for (const part of cookieStr.split(';')) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      if (dropPrefixes.some(p => trimmed.startsWith(p))) continue;
      const eqIdx = trimmed.indexOf('=');
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (!k || v === '') continue;
      map.set(k, v);
    }
  }

  if (fallback.tid && !map.has('tid')) map.set('tid', fallback.tid);
  if (fallback.sid && !map.has('_sid')) map.set('_sid', fallback.sid);
  if (fallback.deviceId && !map.has('_device_id')) map.set('_device_id', fallback.deviceId);
  if (fallback.token && !map.has('token')) map.set('token', fallback.token);
  if ((map.has('_session_tid') || map.has('tid') || map.has('token')) && !map.has('_is_logged_in')) {
    map.set('_is_logged_in', '1');
  }

  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function syncAccountsJsonMirror(data) {
  try {
    const accounts = data?.config?.accounts || {};
    const mirrorList = Object.entries(accounts)
      .filter(([, a]) => a && a.isLoggedIn && a.cookies)
      .map(([k, a]) => ({
        account: k,
        name: a.name || k,
        phone: a.phone || a.mobile || '',
        mobile: a.mobile || a.phone || '',
        customerId: a.customerId || '',
        token: a.token || '',
        tid: a.tid || '',
        sid: a.sid || '',
        deviceId: a.deviceId || '',
        cookies: cleanEssentialSwiggyCookies(a.cookies, a),
        isLoggedIn: true,
        savedAt: a.savedAt || new Date().toISOString()
      }));
    fs.writeFileSync(ACCOUNTS_JSON_FILE, JSON.stringify(mirrorList, null, 2), 'utf-8');
  } catch (e) {}
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}

let accountsSeeded = false;
function seedAccountsFromJson(data) {
  if (accountsSeeded) return;
  try {
    if (fs.existsSync(ACCOUNTS_JSON_FILE)) {
      const raw = fs.readFileSync(ACCOUNTS_JSON_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        if (!data.config.accounts) data.config.accounts = {};
        if (!data.config.deletedAccounts) data.config.deletedAccounts = {};
        for (const item of list) {
          if (item && (item.tid || item.cookies || item.phone)) {
            const phone = item.phone || item.mobile || '';
            const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '').slice(-10) : '';
            const key = cleanPhone ? `acc_${cleanPhone}` : (item.account || 'acc_' + Date.now());
            // Never resurrect explicitly deleted or logged-out accounts!
            if (data.config.deletedAccounts[key]) continue;
            if (data.config.accounts[key] && data.config.accounts[key].isLoggedIn === false) continue;

            if (!data.config.accounts[key] && item.isLoggedIn !== false) {
              const cookieStr = cleanEssentialSwiggyCookies(
                item.cookies || (item.tid ? `tid=${item.tid}; _sid=${item.sid || ''}; _device_id=${item.deviceId || ''}; token=${item.token || item.tid}; _is_logged_in=1` : ''),
                item
              );
              data.config.accounts[key] = {
                id: key,
                name: item.name || (cleanPhone ? `User (${cleanPhone})` : 'Swiggy User'),
                phone: cleanPhone || '',
                mobile: cleanPhone || '',
                token: item.token || item.tid || '',
                tid: item.tid || '',
                sid: item.sid || '',
                deviceId: item.deviceId || '',
                cookies: cookieStr,
                isLoggedIn: Boolean(item.isLoggedIn !== false && cookieStr),
                savedAt: item.savedAt || new Date().toISOString()
              };
            }
          }
        }
      }
    }
    accountsSeeded = true;
  } catch (e) {
    console.warn('seedAccountsFromJson note:', e.message);
  }
}

export function getDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.config) data.config = { ...defaultData.config };
    if (!data.config.bossIds) {
      data.config.bossIds = data.config.bossId ? [data.config.bossId] : [6484999726];
    }
    if (!data.config.familyMembers) {
      data.config.familyMembers = {};
    }
    if (!data.config.accounts) {
      data.config.accounts = {};
    }
    if (!data.config.deletedAccounts) {
      data.config.deletedAccounts = {};
    }
    if (!data.sessionVault) {
      data.sessionVault = {};
    }
    seedAccountsFromJson(data);
    delete data.config.depositAmount;
    return data;
  } catch (err) {
    console.error('Error reading db:', err);
    return defaultData;
  }
}

export function saveDb(data) {
  ensureDb();
  if (data?.config) {
    if (typeof data.config.totalSlots === 'number') {
      data.config.totalSlots = Math.max(0, data.config.totalSlots);
    } else {
      data.config.totalSlots = 9;
    }
    if (typeof data.config.slotsLeft === 'number') {
      data.config.slotsLeft = Math.max(0, Math.min(data.config.totalSlots, data.config.slotsLeft));
    } else {
      data.config.slotsLeft = data.config.totalSlots;
    }
  }

  const tmpFile = `${DB_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (e) {}
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }
}

export function mutateDb(updater) {
  ensureDb();
  const data = getDb();
  const result = updater(data);
  saveDb(data);
  return { data, result };
}

export const ORDER_STATES = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

export function canTransitionOrder(currentStatus, targetStatus) {
  if (!currentStatus) return targetStatus === 'PENDING';
  if (currentStatus === targetStatus) return true;
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(currentStatus)) {
    return false;
  }
  if (currentStatus === 'PENDING') {
    return ['ACCEPTED', 'WAITING_CONFIRMATION', 'AMOUNT_CONFIRMED', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'WAITING_CONFIRMATION') {
    return ['AMOUNT_CONFIRMED', 'ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'AMOUNT_CONFIRMED') {
    return ['ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'ACCEPTED') {
    return ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(targetStatus);
  }
  return true;
}

export function isBoss(userId) {
  const db = getDb();
  const idNum = Number(userId);
  return db.config.bossIds.map(Number).includes(idNum);
}

export function addBoss(userId) {
  const db = getDb();
  const idNum = Number(userId);
  if (!db.config.bossIds.includes(idNum)) {
    db.config.bossIds.push(idNum);
    saveDb(db);
  }
}

export function setFamilyRole(userId, role) {
  const db = getDb();
  db.config.familyMembers[String(userId)] = role;
  saveDb(db);
}

export function getFamilyRole(userId, fallback = 'Parent') {
  const db = getDb();
  return db.config.familyMembers[String(userId)] || fallback;
}

export function getAccounts() {
  const db = getDb();
  return db.config.accounts || defaultData.config.accounts;
}

export function updateAccount(key, updates) {
  const db = getDb();
  if (!db.config.accounts) db.config.accounts = {};
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  if (!db.sessionVault) db.sessionVault = {};

  delete db.config.deletedAccounts[key];
  const merged = { ...(db.config.accounts[key] || {}), id: key, ...updates };
  db.config.accounts[key] = merged;

  const phone = String(merged.phone || merged.mobile || '').replace(/[^0-9]/g, '').slice(-10);
  if (merged.isLoggedIn && merged.cookies) {
    const cleanCookies = cleanEssentialSwiggyCookies(merged.cookies, merged);
    const vaultKey = phone || key;
    db.sessionVault[vaultKey] = {
      account: key,
      name: merged.name || key,
      swiggyName: merged.swiggyName || '',
      mobile: phone,
      phone,
      customerId: merged.customerId || '',
      token: merged.token || '',
      tid: merged.tid || '',
      sid: merged.sid || '',
      deviceId: merged.deviceId || '',
      cookies: cleanCookies,
      savedAt: merged.savedAt || new Date().toISOString()
    };
  }

  saveDb(db);
  syncAccountsJsonMirror(db);
  return db.config.accounts[key];
}

export function createAccount(key, name, phone = '', address = '') {
  const db = getDb();
  if (!db.config.accounts) db.config.accounts = {};
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  const cleanKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  delete db.config.deletedAccounts[cleanKey];
  const existing = db.config.accounts[cleanKey] || {};
  db.config.accounts[cleanKey] = {
    ...existing,
    id: cleanKey,
    name: name || existing.name || (cleanKey.charAt(0).toUpperCase() + cleanKey.slice(1)),
    phone: phone || existing.phone || '',
    mobile: phone || existing.mobile || existing.phone || '',
    token: existing.token || '',
    address: address || existing.address || '',
    isLoggedIn: Boolean(existing.isLoggedIn && existing.cookies),
    createdAt: existing.createdAt || new Date().toISOString()
  };
  saveDb(db);
  return db.config.accounts[cleanKey];
}

export function getNextAutoUserName() {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const names = Object.values(accounts).map(a => (a.name || '').trim().toLowerCase());
  let num = 1;
  while (names.some(n => n === `user ${num}` || n.includes(`(user ${num})`))) {
    num++;
  }
  return `User ${num}`;
}

function pickNextActiveAccountKey(accounts, excludeKey = null) {
  for (const [k, a] of Object.entries(accounts || {})) {
    if (k !== excludeKey && a && a.isLoggedIn && a.cookies) return k;
  }
  return null;
}

export function deleteAccount(key, options = {}) {
  const db = getDb();
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  db.config.deletedAccounts[key] = true;

  const acc = db.config?.accounts?.[key];
  const phone = acc ? String(acc.phone || acc.mobile || '').replace(/[^0-9]/g, '').slice(-10) : key.replace(/^acc_/, '');

  if (options.purgeVault && db.sessionVault) {
    delete db.sessionVault[phone];
    delete db.sessionVault[key];
  }

  const existed = Boolean(db.config?.accounts?.[key]);
  if (existed) {
    delete db.config.accounts[key];
  }
  if (db.config.activeOrderAccount === key) {
    const nextKey = pickNextActiveAccountKey(db.config.accounts, key);
    if (nextKey) db.config.activeOrderAccount = nextKey;
    else delete db.config.activeOrderAccount;
  }

  saveDb(db);
  syncAccountsJsonMirror(db);
  return existed;
}

export function getActiveUserOrder(userId) {
  const db = getDb();
  const idNum = Number(userId);
  const activeStatuses = ['PENDING', 'ACCEPTED'];
  const userOrders = Object.values(db.orders).filter(o => Number(o.userId) === idNum);

  return userOrders.find(o => activeStatuses.includes(o.status));
}

export function getDraft(userId) {
  const db = getDb();
  if (!db.drafts[userId]) {
    db.drafts[userId] = {
      address: null,
      cart: null,
      submitted: false,
      currentOrderId: null
    };
    saveDb(db);
  }
  return db.drafts[userId];
}

export function updateDraft(userId, updates) {
  const db = getDb();
  db.drafts[userId] = { ...(db.drafts[userId] || {}), ...updates };
  saveDb(db);
  return db.drafts[userId];
}

export function clearDraft(userId) {
  const db = getDb();
  db.drafts[userId] = {
    address: null,
    cart: null,
    submitted: false,
    currentOrderId: null
  };
  saveDb(db);
  return db.drafts[userId];
}

// Exports COMPLETE 100% self-contained Swiggy Session JSON (including full essential `cookies` + `_session_tid`)
export function exportSessionJson(key) {
  const db = getDb();
  const acc = db.config.accounts?.[key];
  const fallbackPhone = acc ? String(acc.phone || acc.mobile || '').replace(/[^0-9]/g, '').slice(-10) : String(key).replace(/^acc_/, '');
  const vault = db.sessionVault?.[fallbackPhone] || db.sessionVault?.[key] || null;
  const source = (acc && acc.cookies) ? acc : (vault || acc);

  if (!source || (!source.cookies && !source.tid)) return null;

  const cleanCookies = cleanEssentialSwiggyCookies(source.cookies || '', source);

  let token = source.token || '';
  if (!token && cleanCookies) {
    const m = cleanCookies.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) token = m[1];
  }

  let tid = source.tid || '';
  if ((!tid || !tid.includes('.')) && cleanCookies) {
    const tm = cleanCookies.match(/(?:^|;\s*)tid=([^;]+)/);
    if (tm) tid = tm[1];
  }

  let sid = source.sid || '';
  if (!sid && cleanCookies) {
    const sm = cleanCookies.match(/(?:^|;\s*)_sid=([^;]+)/);
    if (sm) sid = sm[1];
  }

  let deviceId = source.deviceId || '';
  if (!deviceId && cleanCookies) {
    const dm = cleanCookies.match(/(?:^|;\s*)_device_id=([^;]+)/);
    if (dm) deviceId = dm[1];
  }

  let customerId = source.customerId || source.userId || '';
  if (!customerId && tid && tid.includes('.')) {
    try {
      const payload = tid.split('.')[1];
      if (payload) {
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        customerId = decoded.user_id || decoded.sub || '';
      }
    } catch (e) {}
  }

  const phone = source.phone || source.mobile || fallbackPhone || '';

  return {
    account: key,
    name: source.name || key,
    ...(source.swiggyName ? { swiggyName: source.swiggyName } : {}),
    mobile: phone,
    phone,
    customerId,
    token,
    tid,
    sid,
    deviceId,
    cookies: cleanCookies,
    savedAt: source.savedAt || new Date().toISOString()
  };
}

export function importSessionJson(rawJson, targetKey = null) {
  try {
    let data = typeof rawJson === 'string' ? JSON.parse(rawJson.trim()) : rawJson;

    // Also support array of cookies exported directly from Cookie-Editor browser extension!
    if (Array.isArray(data)) {
      const cookiePairs = data
        .filter(c => c && c.name && c.value !== undefined)
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      const getC = (n) => data.find(c => c && c.name === n)?.value || '';
      data = {
        tid: getC('tid'),
        sid: getC('_sid'),
        deviceId: getC('_device_id'),
        token: getC('token'),
        cookies: cookiePairs
      };
    }

    const db = getDb();
    if (!db.config.accounts) db.config.accounts = {};
    if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
    if (!db.sessionVault) db.sessionVault = {};

    const phone = data?.phone || data?.mobile || '';
    const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '').slice(-10) : '';
    const key = targetKey || (cleanPhone ? `acc_${cleanPhone}` : (data?.account || 'acc_' + Date.now()));

    // Recover full cookies from vault if user pasted an older partial JSON without `_session_tid`
    const vaultBackup = db.sessionVault[cleanPhone] || db.sessionVault[key] || null;
    let rawCookies = data?.cookies || '';
    if ((!rawCookies || !rawCookies.includes('_session_tid=')) && vaultBackup?.cookies?.includes('_session_tid=')) {
      rawCookies = vaultBackup.cookies;
    }

    if (!data || (!rawCookies && !data.tid && !data.token)) {
      return { success: false, message: 'Invalid session JSON: missing cookies / tid token' };
    }

    let cookieStr = cleanEssentialSwiggyCookies(
      rawCookies || `tid=${data.tid || ''}; _sid=${data.sid || ''}; _device_id=${data.deviceId || ''}; token=${data.token || data.tid || ''}; _is_logged_in=1`,
      data
    );

    const extractFromCookie = (name) => {
      const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      return m ? m[1] : '';
    };

    const tid = data.tid || extractFromCookie('tid') || '';
    const token = data.token || extractFromCookie('token') || tid || '';
    const sid = data.sid || extractFromCookie('_sid') || '';
    const deviceId = data.deviceId || extractFromCookie('_device_id') || '';

    let customerId = data.customerId || data.customer_id || data.userId || '';
    if (!customerId && tid && tid.includes('.')) {
      try {
        const payload = tid.split('.')[1];
        if (payload) {
          const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
          customerId = decoded.user_id || decoded.sub || '';
        }
      } catch (e) {}
    }

    delete db.config.deletedAccounts[key];
    if (!db.config.accounts[key]) {
      db.config.accounts[key] = { id: key, name: data.name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User') };
    }

    db.config.accounts[key] = {
      ...db.config.accounts[key],
      id: key,
      mobile: cleanPhone || db.config.accounts[key].mobile || db.config.accounts[key].phone || '',
      phone: cleanPhone || db.config.accounts[key].phone || db.config.accounts[key].mobile || '',
      name: data.name || db.config.accounts[key].name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User'),
      customerId: customerId || db.config.accounts[key].customerId || '',
      token: token || db.config.accounts[key].token || '',
      tid: tid || db.config.accounts[key].tid || '',
      sid: sid || db.config.accounts[key].sid || '',
      deviceId: deviceId || db.config.accounts[key].deviceId || '',
      cookies: cookieStr,
      isLoggedIn: true,
      savedAt: new Date().toISOString()
    };

    const finalPhone = db.config.accounts[key].phone;
    db.sessionVault[finalPhone || key] = {
      account: key,
      name: db.config.accounts[key].name,
      mobile: finalPhone,
      phone: finalPhone,
      customerId: db.config.accounts[key].customerId,
      token: db.config.accounts[key].token,
      tid: db.config.accounts[key].tid,
      sid: db.config.accounts[key].sid,
      deviceId: db.config.accounts[key].deviceId,
      cookies: cookieStr,
      savedAt: db.config.accounts[key].savedAt
    };

    if (!db.config.activeOrderAccount || !db.config.accounts[db.config.activeOrderAccount]?.isLoggedIn) {
      db.config.activeOrderAccount = key;
    }

    saveDb(db);
    syncAccountsJsonMirror(db);

    return {
      success: true,
      account: key,
      name: db.config.accounts[key].name,
      phone: db.config.accounts[key].phone,
      mobile: db.config.accounts[key].mobile,
      customerId: db.config.accounts[key].customerId,
      token: db.config.accounts[key].token
    };
  } catch (err) {
    return { success: false, message: 'Invalid JSON format: ' + err.message };
  }
}

export function getActiveOrderAccountKey() {
  const db = getDb();
  if (db.config?.activeOrderAccount && db.config?.accounts?.[db.config.activeOrderAccount]?.isLoggedIn) {
    return db.config.activeOrderAccount;
  }
  for (const [k, a] of Object.entries(db.config?.accounts || {})) {
    if (a.isLoggedIn && a.cookies) return k;
  }
  const first = Object.keys(db.config?.accounts || {})[0];
  return first || null;
}

export function setActiveOrderAccountKey(key) {
  const db = getDb();
  if (!db.config) db.config = {};
  db.config.activeOrderAccount = key;
  saveDb(db);
  return db.config.accounts?.[key] || null;
}

// Logs out locally in the Bot DB (keeps copied Session JSON alive on Swiggy servers so Re-Login with Code works!)
export function permanentLogoutAccount(key) {
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return null;

  // Snapshot into vault BEFORE clearing active fields so previously exported code never loses `_session_tid`
  const phone = String(acc.phone || acc.mobile || '').replace(/[^0-9]/g, '').slice(-10);
  if (acc.cookies && acc.cookies.includes('_session_tid=')) {
    if (!db.sessionVault) db.sessionVault = {};
    db.sessionVault[phone || key] = {
      account: key,
      name: acc.name || key,
      mobile: phone,
      phone,
      customerId: acc.customerId || '',
      token: acc.token || '',
      tid: acc.tid || '',
      sid: acc.sid || '',
      deviceId: acc.deviceId || '',
      cookies: cleanEssentialSwiggyCookies(acc.cookies, acc),
      savedAt: acc.savedAt || new Date().toISOString()
    };
  }

  acc.isLoggedIn = false;
  acc.cookies = '';
  acc.tid = '';
  acc.sid = '';
  acc.token = '';

  if (db.config.activeOrderAccount === key) {
    const nextKey = pickNextActiveAccountKey(db.config.accounts, key);
    if (nextKey) db.config.activeOrderAccount = nextKey;
    else delete db.config.activeOrderAccount;
  }

  saveDb(db);
  syncAccountsJsonMirror(db);
  return acc;
}
