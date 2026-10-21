import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  pullAccountsFromCloudVault,
  pushAccountsToCloudVaultNow,
  scheduleCloudVaultSync,
  markCloudVaultHydrated
} from './vault-sync.js';

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

// Strips markdown code fences and outer noise from pasted JSON / Cookie strings
function unwrapRawSessionString(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim();
  s = s.replace(/^```(?:json|js|txt)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (/^cookie\s*:/i.test(s)) {
    s = s.replace(/^cookie\s*:\s*/i, '').trim();
  }
  return s;
}

function isCookieEditorArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.some(c => c && typeof c === 'object' && typeof c.name === 'string' && c.value !== undefined && !c.tid && !c.token && !c.phone && !c.mobile)
  );
}

// Normalizes ANY single Swiggy session object/cookie string from ANY bot or browser extension into canonical fields
export function normalizeSwiggySessionPayload(rawInput) {
  if (!rawInput) return null;
  let item = typeof rawInput === 'string' ? unwrapRawSessionString(rawInput) : rawInput;

  if (typeof item === 'string') {
    try {
      item = JSON.parse(item);
    } catch {
      if (item.includes('=') && (item.includes('_session_tid') || item.includes('tid=') || item.includes('token='))) {
        item = { cookies: item };
      } else if (item.includes('.') && item.length > 60 && !item.includes(' ')) {
        item = { tid: item };
      } else if (/^[0-9a-fA-F]{40,}$/.test(item)) {
        item = { _session_tid: item };
      } else {
        return null;
      }
    }
  }

  if (isCookieEditorArray(item)) {
    const cookiePairs = item
      .filter(c => c && c.name && c.value !== undefined)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    const getC = (n) => item.find(c => c && c.name === n)?.value || '';
    item = {
      _session_tid: getC('_session_tid'),
      tid: getC('tid'),
      sid: getC('_sid') || getC('sid'),
      deviceId: getC('_device_id') || getC('deviceId') || getC('_swuid'),
      token: getC('token'),
      cookies: cookiePairs
    };
  }

  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  // Unwrap nested containers `{ session: {...} }`, `{ data: {...} }`, `{ account: {...} }`, `{ user: {...} }`
  const inner =
    (item.session && typeof item.session === 'object' && !Array.isArray(item.session) ? item.session : null) ||
    (item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? item.data : null) ||
    (item.account && typeof item.account === 'object' && !Array.isArray(item.account) ? item.account : null) ||
    (item.auth && typeof item.auth === 'object' && !Array.isArray(item.auth) ? item.auth : null) ||
    null;
  const src = inner ? { ...item, ...inner } : { ...item };
  const hdr = (src.headers && typeof src.headers === 'object') ? src.headers : {};

  // Normalize cookies whether string, Cookie-Editor array, or `{ key: value }` object map
  let rawCookieStr = '';
  const rawC = src.cookies ?? src.cookie ?? src.cookie_string ?? src.cookieString ?? hdr.Cookie ?? hdr.cookie ?? '';
  if (typeof rawC === 'string') {
    rawCookieStr = unwrapRawSessionString(rawC);
  } else if (Array.isArray(rawC)) {
    rawCookieStr = rawC
      .filter(c => c && (c.name || c.key) && c.value !== undefined)
      .map(c => `${c.name || c.key}=${c.value}`)
      .join('; ');
  } else if (rawC && typeof rawC === 'object') {
    rawCookieStr = Object.entries(rawC)
      .filter(([k, v]) => k && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  let sessionTid = String(
    src._session_tid ||
    src.session_tid ||
    src.sessionTid ||
    src.session_id ||
    src.sessionId ||
    (typeof src.session === 'string' ? src.session : '') ||
    hdr._session_tid ||
    ''
  ).trim();

  let rawTid = String(src.tid || src.jwt_tid || src.jwtTid || src.jwt || hdr.tid || '').trim();
  // Critical fix: other bots often store the hex `_session_tid` directly inside `tid`!
  if (rawTid && !rawTid.includes('.') && !sessionTid) {
    sessionTid = rawTid;
  }

  let token = String(
    src.token ||
    src.auth_token ||
    src.authToken ||
    src.access_token ||
    src.accessToken ||
    src.swiggy_token ||
    hdr.token ||
    ''
  ).trim();

  let sid = String(src.sid || src._sid || src.session_sid || hdr.sid || '').trim();
  let deviceId = String(
    src.deviceId ||
    src.device_id ||
    src._device_id ||
    src.swuid ||
    src._swuid ||
    src.uuid ||
    hdr.deviceId ||
    hdr['device-id'] ||
    hdr.swuid ||
    ''
  ).trim();

  let customerId = String(
    src.customerId ||
    src.customer_id ||
    src.userId ||
    src.user_id ||
    src.userid ||
    hdr.userid ||
    hdr['user-id'] ||
    (typeof src.id === 'number' || /^\d{5,15}$/.test(String(src.id || '')) ? src.id : '') ||
    ''
  ).trim();
  if (customerId === '0' || customerId === '-1') customerId = '';

  const rawPhone = String(
    src.phone ||
    src.mobile ||
    src.phone_number ||
    src.mobile_number ||
    src.phoneNumber ||
    src.mobileNumber ||
    src.number ||
    src.msisdn ||
    ''
  ).trim();
  const cleanPhone = rawPhone ? rawPhone.replace(/[^0-9]/g, '').slice(-10) : '';
  const name = String(src.swiggyName || src.name || src.full_name || src.user_name || src.username || '').trim();

  const normalized = {
    account: typeof src.account === 'string' ? src.account : '',
    name,
    swiggyName: String(src.swiggyName || '').trim(),
    phone: cleanPhone,
    mobile: cleanPhone,
    customerId,
    _session_tid: sessionTid,
    tid: rawTid,
    token,
    sid,
    deviceId,
    cookies: rawCookieStr,
    ...(typeof src.totalOrdersCount === 'number' ? { totalOrdersCount: src.totalOrdersCount } : {}),
    ...(typeof src.isZeroOrderAccount === 'boolean' ? { isZeroOrderAccount: src.isZeroOrderAccount } : {})
  };

  normalized.cookies = cleanEssentialSwiggyCookies(rawCookieStr, normalized);
  const getFromMap = (cookieKey) => {
    const m = normalized.cookies.match(new RegExp(`(?:^|;\\s*)${cookieKey}=([^;]+)`));
    return m ? m[1].trim() : '';
  };

  if (!normalized._session_tid) normalized._session_tid = getFromMap('_session_tid');
  if (!normalized.tid || (!normalized.tid.includes('.') && getFromMap('tid').includes('.'))) {
    normalized.tid = getFromMap('tid') || normalized.tid;
  }
  if (!normalized.token) normalized.token = getFromMap('token');
  if (!normalized.sid) normalized.sid = getFromMap('_sid') || getFromMap('sid');
  if (!normalized.deviceId) normalized.deviceId = getFromMap('_device_id') || getFromMap('_swuid');

  if (!normalized.customerId && normalized.tid && normalized.tid.includes('.')) {
    try {
      const payload = JSON.parse(Buffer.from(normalized.tid.split('.')[1], 'base64').toString('utf8'));
      if (payload?.user_id && String(payload.user_id) !== '0' && String(payload.user_id) !== '-1') {
        normalized.customerId = String(payload.user_id);
      }
    } catch {}
  }

  const hasAnyAuth = Boolean(normalized._session_tid || normalized.tid || normalized.token || normalized.cookies);
  return hasAnyAuth ? normalized : null;
}

// Extracts 1 or MANY normalized Swiggy session objects from single JSON, Cookie-Editor array, or multi-account `accounts.json` / `db.json`!
export function extractSwiggyAccountsListFromInput(rawInput) {
  if (!rawInput) return [];
  let parsed = typeof rawInput === 'string' ? unwrapRawSessionString(rawInput) : rawInput;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      const single = normalizeSwiggySessionPayload(parsed);
      return single ? [single] : [];
    }
  }

  if (isCookieEditorArray(parsed)) {
    const single = normalizeSwiggySessionPayload(parsed);
    return single ? [single] : [];
  }

  if (Array.isArray(parsed)) {
    return parsed.map(x => normalizeSwiggySessionPayload(x)).filter(Boolean);
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.cookies) && isCookieEditorArray(parsed.cookies)) {
      const single = normalizeSwiggySessionPayload(parsed);
      return single ? [single] : [];
    }
    const multiMap =
      (parsed.config?.accounts && typeof parsed.config.accounts === 'object' ? parsed.config.accounts : null) ||
      (parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : null);
    if (multiMap) {
      const arr = Array.isArray(multiMap)
        ? multiMap
        : Object.entries(multiMap).map(([k, v]) => (v && typeof v === 'object' ? { account: k, ...v } : null));
      return arr.map(x => normalizeSwiggySessionPayload(x)).filter(Boolean);
    }
    if (Array.isArray(parsed.data)) {
      return parsed.data.map(x => normalizeSwiggySessionPayload(x)).filter(Boolean);
    }
    const single = normalizeSwiggySessionPayload(parsed);
    return single ? [single] : [];
  }
  return [];
}

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

  const fbSessionTid = fallback._session_tid || fallback.session_tid || fallback.sessionTid || '';
  if (fbSessionTid && !map.has('_session_tid')) map.set('_session_tid', fbSessionTid);
  if (fallback.tid && !fallback.tid.includes('.') && !map.has('_session_tid')) {
    map.set('_session_tid', fallback.tid);
  }
  if (fallback.tid && fallback.tid.includes('.') && !map.has('tid')) {
    map.set('tid', fallback.tid);
  } else if (fallback.tid && !map.has('tid')) {
    map.set('tid', fallback.tid);
  }
  const fbSid = fallback.sid || fallback._sid || '';
  if (fbSid && !map.has('_sid')) map.set('_sid', fbSid);
  const fbDev = fallback.deviceId || fallback.device_id || fallback._device_id || fallback.swuid || '';
  if (fbDev && !map.has('_device_id')) map.set('_device_id', fbDev);
  const fbTok = fallback.token || fallback.auth_token || fallback.access_token || '';
  if (fbTok && !map.has('token')) map.set('token', fbTok);
  if ((map.has('_session_tid') || map.has('tid') || map.has('token')) && !map.has('_is_logged_in')) {
    map.set('_is_logged_in', '1');
  }

  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function buildCloudVaultSnapshot(data = null) {
  const src = data || getDb();
  const accountsOut = {};
  for (const [k, a] of Object.entries(src?.config?.accounts || {})) {
    if (!a || (!a.cookies && !a.tid && !a.token && !a.isLoggedIn)) continue;
    accountsOut[k] = { ...a };
  }
  return {
    version: 15,
    updatedAt: new Date().toISOString(),
    accounts: accountsOut,
    deletedAccounts: { ...(src?.config?.deletedAccounts || {}) },
    sessionVault: { ...(src?.sessionVault || {}) }
  };
}

export async function syncCloudVaultNow(data = null) {
  return pushAccountsToCloudVaultNow(buildCloudVaultSnapshot(data));
}

export async function hydrateAccountsFromCloudVault() {
  try {
    const remote = await pullAccountsFromCloudVault();
    markCloudVaultHydrated();
    if (!remote || typeof remote !== 'object') return { restored: 0, total: 0 };

    let restored = 0;
    const db = getDb();
    if (!db.config.accounts) db.config.accounts = {};
    if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
    if (!db.sessionVault) db.sessionVault = {};

    for (const [delKey, delVal] of Object.entries(remote.deletedAccounts || {})) {
      if (delVal && !db.config.accounts[delKey]?.isLoggedIn) {
        db.config.deletedAccounts[delKey] = delVal;
      }
    }

    for (const [vKey, vVal] of Object.entries(remote.sessionVault || {})) {
      if (vVal && !db.sessionVault[vKey]) {
        db.sessionVault[vKey] = vVal;
      }
    }

    for (const [k, remAcc] of Object.entries(remote.accounts || {})) {
      if (!remAcc || db.config.deletedAccounts[k]) continue;
      if (remAcc.isLoggedIn === false) continue;
      const cur = db.config.accounts[k];
      if (!cur || !cur.isLoggedIn || (!cur.cookies && !cur.tid && !cur.token)) {
        const cleanC = cleanEssentialSwiggyCookies(remAcc.cookies || '', remAcc);
        db.config.accounts[k] = {
          ...remAcc,
          id: k,
          cookies: cleanC || remAcc.cookies || '',
          isLoggedIn: true
        };
        restored++;
      }
    }

    if (restored > 0) {
      saveDb(db);
      syncAccountsJsonMirror(db, { skipCloudPush: true });
      console.log(`[CloudVault] Restored ${restored} saved Swiggy JSON account(s) from persistent vault!`);
    }
    return {
      restored,
      total: Object.values(db.config.accounts).filter(a => a?.isLoggedIn).length
    };
  } catch (e) {
    console.warn('[CloudVault] Hydrate note:', e.message);
    return { restored: 0, total: 0 };
  }
}

function syncAccountsJsonMirror(data, { skipCloudPush = false } = {}) {
  try {
    const accounts = data?.config?.accounts || {};
    const mirrorList = Object.entries(accounts)
      .filter(([, a]) => a && a.isLoggedIn && (a.cookies || a.tid || a.token))
      .map(([k, a]) => {
        const cleanC = cleanEssentialSwiggyCookies(a.cookies, a);
        const sessMatch = cleanC.match(/(?:^|;\s*)_session_tid=([^;]+)/);
        const sessionTidVal = sessMatch ? sessMatch[1].trim() : (a._session_tid || '');
        return {
          account: k,
          name: a.name || k,
          phone: a.phone || a.mobile || '',
          mobile: a.mobile || a.phone || '',
          customerId: a.customerId || '',
          ...(sessionTidVal ? { _session_tid: sessionTidVal } : {}),
          token: a.token || '',
          tid: a.tid || '',
          sid: a.sid || '',
          deviceId: a.deviceId || '',
          cookies: cleanC,
          isLoggedIn: true,
          ...(a.isZeroOrderAccount !== undefined ? { isZeroOrderAccount: a.isZeroOrderAccount } : {}),
          ...(a.totalOrdersCount !== undefined ? { totalOrdersCount: a.totalOrdersCount } : {}),
          savedAt: a.savedAt || new Date().toISOString()
        };
      });
    fs.writeFileSync(ACCOUNTS_JSON_FILE, JSON.stringify(mirrorList, null, 2), 'utf-8');
    if (!skipCloudPush) {
      scheduleCloudVaultSync(() => buildCloudVaultSnapshot(getDb()));
    }
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
    // Tag non-enumerable baseline snapshots for orders, accounts & sessionVault so NO concurrent async fiber ever clobbers newly uploaded accounts or sibling orders!
    const baseOrdersJson = {};
    for (const [oid, oVal] of Object.entries(data.orders || {})) {
      baseOrdersJson[oid] = JSON.stringify(oVal);
    }
    const baseAccountsJson = {};
    for (const [ak, aVal] of Object.entries(data.config.accounts || {})) {
      baseAccountsJson[ak] = JSON.stringify(aVal);
    }
    const baseVaultJson = {};
    for (const [vk, vVal] of Object.entries(data.sessionVault || {})) {
      baseVaultJson[vk] = JSON.stringify(vVal);
    }
    Object.defineProperty(data, '__baseOrdersJson', { value: baseOrdersJson, enumerable: false, configurable: true });
    Object.defineProperty(data, '__baseAccountsJson', { value: baseAccountsJson, enumerable: false, configurable: true });
    Object.defineProperty(data, '__baseVaultJson', { value: baseVaultJson, enumerable: false, configurable: true });
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

  // Concurrent-Safe Parallel Merge for Orders + Uploaded Accounts + Session Vault!
  // Any account/vault/order written concurrently to disk after `getDb()` was called is 100% preserved unless explicitly mutated/deleted by caller!
  if (data && (data.__baseOrdersJson || data.__baseAccountsJson)) {
    try {
      const liveDisk = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

      if (data.__baseOrdersJson && typeof data.orders === 'object' && data.orders !== null) {
        const diskOrders = liveDisk?.orders || {};
        const baseMap = data.__baseOrdersJson;
        for (const [oid, diskOrder] of Object.entries(diskOrders)) {
          const existedAtRead = Object.prototype.hasOwnProperty.call(baseMap, oid);
          const presentInCaller = Object.prototype.hasOwnProperty.call(data.orders, oid);
          if (!existedAtRead && !presentInCaller) {
            data.orders[oid] = diskOrder;
          } else if (existedAtRead && presentInCaller && JSON.stringify(data.orders[oid]) === baseMap[oid]) {
            data.orders[oid] = diskOrder;
          }
        }
        const refreshedBase = {};
        for (const [oid, oVal] of Object.entries(data.orders)) refreshedBase[oid] = JSON.stringify(oVal);
        Object.defineProperty(data, '__baseOrdersJson', { value: refreshedBase, enumerable: false, configurable: true });
      }

      if (data.__baseAccountsJson && data.config && typeof data.config.accounts === 'object' && data.config.accounts !== null) {
        const diskAccounts = liveDisk?.config?.accounts || {};
        const baseAccMap = data.__baseAccountsJson;
        const callerDeleted = data.config.deletedAccounts || {};
        for (const [ak, diskAcc] of Object.entries(diskAccounts)) {
          const existedAtRead = Object.prototype.hasOwnProperty.call(baseAccMap, ak);
          const presentInCaller = Object.prototype.hasOwnProperty.call(data.config.accounts, ak);
          if (!existedAtRead && !presentInCaller && !callerDeleted[ak]) {
            // Brand-new `.json` account imported concurrently while this fiber was awaiting Swiggy — NEVER WIPE IT!
            data.config.accounts[ak] = diskAcc;
          } else if (existedAtRead && presentInCaller && JSON.stringify(data.config.accounts[ak]) === baseAccMap[ak]) {
            data.config.accounts[ak] = diskAcc;
          }
        }
        const refreshedAccBase = {};
        for (const [ak, aVal] of Object.entries(data.config.accounts)) refreshedAccBase[ak] = JSON.stringify(aVal);
        Object.defineProperty(data, '__baseAccountsJson', { value: refreshedAccBase, enumerable: false, configurable: true });
      }

      if (data.__baseVaultJson && typeof data.sessionVault === 'object' && data.sessionVault !== null) {
        const diskVault = liveDisk?.sessionVault || {};
        const baseVaultMap = data.__baseVaultJson;
        for (const [vk, diskV] of Object.entries(diskVault)) {
          const existedAtRead = Object.prototype.hasOwnProperty.call(baseVaultMap, vk);
          const presentInCaller = Object.prototype.hasOwnProperty.call(data.sessionVault, vk);
          if (!existedAtRead && !presentInCaller) {
            data.sessionVault[vk] = diskV;
          } else if (existedAtRead && presentInCaller && JSON.stringify(data.sessionVault[vk]) === baseVaultMap[vk]) {
            data.sessionVault[vk] = diskV;
          }
        }
        const refreshedVaultBase = {};
        for (const [vk, vVal] of Object.entries(data.sessionVault)) refreshedVaultBase[vk] = JSON.stringify(vVal);
        Object.defineProperty(data, '__baseVaultJson', { value: refreshedVaultBase, enumerable: false, configurable: true });
      }
    } catch (e) {}
  }

  const tmpFile = `${DB_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
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

export function upsertOrder(orderId, orderOrPatchFn) {
  ensureDb();
  const db = getDb();
  if (!db.orders) db.orders = {};
  if (typeof orderOrPatchFn === 'function') {
    const updated = orderOrPatchFn(db.orders[orderId] || null, db);
    if (updated === null) {
      delete db.orders[orderId];
    } else if (updated) {
      db.orders[orderId] = updated;
    }
  } else if (orderOrPatchFn === null) {
    delete db.orders[orderId];
  } else if (orderOrPatchFn && typeof orderOrPatchFn === 'object') {
    db.orders[orderId] = { ...(db.orders[orderId] || {}), ...orderOrPatchFn };
  }
  saveDb(db);
  return db.orders[orderId] || null;
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
    if (k !== excludeKey && a && a.isLoggedIn && (a.cookies || a.tid || a.token)) return k;
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
    const list = extractSwiggyAccountsListFromInput(rawJson);
    if (!list.length) {
      return { success: false, message: 'Invalid session JSON: missing cookies / tid / token' };
    }

    const db = getDb();
    if (!db.config.accounts) db.config.accounts = {};
    if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
    if (!db.sessionVault) db.sessionVault = {};

    const results = [];
    for (let idx = 0; idx < list.length; idx++) {
      const data = list[idx];
      const cleanPhone = data.phone || '';
      const cookieStrPre = cleanEssentialSwiggyCookies(data.cookies || '', data);
      const extractFromCookiePre = (name) => {
        const m = cookieStrPre.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        return m ? m[1] : '';
      };
      const tidPre = data.tid || extractFromCookiePre('tid') || '';
      let customerIdPre = data.customerId || '';
      if (!customerIdPre && tidPre && tidPre.includes('.')) {
        try {
          const payload = tidPre.split('.')[1];
          if (payload) {
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
            if (decoded?.user_id && String(decoded.user_id) !== '0' && String(decoded.user_id) !== '-1') {
              customerIdPre = String(decoded.user_id);
            }
          }
        } catch {}
      }

      const key = (list.length === 1 && targetKey)
        ? targetKey
        : (cleanPhone
          ? `acc_${cleanPhone}`
          : (data.account || (customerIdPre ? `acc_cid_${customerIdPre}` : `acc_${Date.now()}_${idx}`)));

      // Recover full cookies from vault if user pasted an older partial JSON without `_session_tid`
      const vaultBackup = db.sessionVault[cleanPhone] || db.sessionVault[key] || null;
      let rawCookies = data.cookies || '';
      if ((!rawCookies || !rawCookies.includes('_session_tid=')) && vaultBackup?.cookies?.includes('_session_tid=')) {
        rawCookies = `${vaultBackup.cookies}; ${rawCookies}`;
      }

      const cookieStr = cleanEssentialSwiggyCookies(rawCookies, data);
      const extractFromCookie = (name) => {
        const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        return m ? m[1] : '';
      };

      const tid = data.tid || extractFromCookie('tid') || '';
      const sessionTid = extractFromCookie('_session_tid') || data._session_tid || (!tid.includes('.') && tid.length >= 64 ? tid : '');
      const token = data.token || extractFromCookie('token') || tid || '';
      const sid = data.sid || extractFromCookie('_sid') || '';
      const deviceId = data.deviceId || extractFromCookie('_device_id') || '';
      const customerId = customerIdPre;

      delete db.config.deletedAccounts[key];
      if (!db.config.accounts[key]) {
        db.config.accounts[key] = { id: key, name: data.name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User') };
      }

      db.config.accounts[key] = {
        ...db.config.accounts[key],
        id: key,
        mobile: cleanPhone || db.config.accounts[key].mobile || db.config.accounts[key].phone || '',
        phone: cleanPhone || db.config.accounts[key].phone || db.config.accounts[key].mobile || '',
        ...(data.swiggyName ? { swiggyName: data.swiggyName } : {}),
        name: data.name || db.config.accounts[key].name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User'),
        customerId: customerId || db.config.accounts[key].customerId || '',
        ...(sessionTid ? { _session_tid: sessionTid } : {}),
        token: token || db.config.accounts[key].token || '',
        tid: tid || db.config.accounts[key].tid || '',
        sid: sid || db.config.accounts[key].sid || '',
        deviceId: deviceId || db.config.accounts[key].deviceId || '',
        cookies: cookieStr,
        ...(typeof data.totalOrdersCount === 'number' ? {
          totalOrdersCount: data.totalOrdersCount,
          isZeroOrderAccount: data.totalOrdersCount === 0
        } : {}),
        isLoggedIn: true,
        savedAt: new Date().toISOString()
      };

      const finalPhone = db.config.accounts[key].phone;
      db.sessionVault[finalPhone || key] = {
        account: key,
        name: db.config.accounts[key].name,
        swiggyName: db.config.accounts[key].swiggyName || '',
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

      results.push({
        success: true,
        key,
        account: key,
        accountObj: db.config.accounts[key],
        name: db.config.accounts[key].name,
        phone: db.config.accounts[key].phone,
        mobile: db.config.accounts[key].mobile,
        customerId: db.config.accounts[key].customerId,
        token: db.config.accounts[key].token,
        totalOrdersCount: db.config.accounts[key].totalOrdersCount,
        isZeroOrderAccount: db.config.accounts[key].isZeroOrderAccount
      });
    }

    // Single atomic disk write + `accounts.json` mirror + Cloud Vault schedule across ALL imported files!
    saveDb(db);
    syncAccountsJsonMirror(db);

    return {
      ...results[0],
      importedCount: results.length,
      accounts: results
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
  appendAuditEvent('logout', { accountKey: key, phone: acc.phone || '' });
  return acc;
}

// =========================================================================
// V16 SECURITY, MASKING, OTP 3-STRIKE LOCK & STRUCTURED AUDIT LOG HELPERS
// =========================================================================

export function maskPhoneStars(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 4) return `****${digits.slice(-4)}`;
  return '****0000';
}

export function maskAccountCode(accOrKey = '') {
  if (accOrKey && typeof accOrKey === 'object') {
    const digits = String(accOrKey.phone || accOrKey.mobile || accOrKey.id || '').replace(/\D/g, '');
    if (digits.length >= 4) return `AC-${digits.slice(-4)}`;
  }
  const digits = String(accOrKey || '').replace(/\D/g, '');
  if (digits.length >= 4) return `AC-${digits.slice(-4)}`;
  return `AC-${String(accOrKey || '0000').slice(-4).toUpperCase()}`;
}

export function redactSensitiveText(input = '') {
  return String(input || '')
    .replace(/(_session_tid\s*=\s*)[^;\s"'}]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:_session_tid|session_id|token|tid|jwt|cookies|cookie)["']?\s*:\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2');
}

export function exportSafeRedactedSessionJson(key) {
  const db = getDb();
  const acc = db?.config?.accounts?.[key] || db?.sessionVault?.[String(key || '').replace(/^acc_/, '')];
  if (!acc) return null;
  const payload = {
    account_code: maskAccountCode(acc),
    phone: maskPhoneStars(acc.phone || acc.mobile || key),
    session_id: '[REDACTED]',
    token: '[REDACTED]',
    is_logged_in: Boolean(acc.isLoggedIn),
    previous_orders: Number(acc.totalOrdersCount || 0),
    zero_order_eligible: Boolean(acc.isZeroOrderAccount || Number(acc.totalOrdersCount || 0) === 0),
    saved_at: acc.savedAt || new Date().toISOString()
  };
  return JSON.stringify(payload, null, 2);
}

const otpAttemptTracker = new Map();

export function getOtpLockStatus(phone = '') {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!clean) return { locked: false, failures: 0, remainingAttempts: 3, unlockAt: null };
  const entry = otpAttemptTracker.get(clean);
  if (!entry) return { locked: false, failures: 0, remainingAttempts: 3, unlockAt: null };
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return {
      locked: true,
      failures: entry.failures,
      remainingAttempts: 0,
      unlockAt: new Date(entry.lockedUntil).toISOString(),
      retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    };
  }
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    otpAttemptTracker.delete(clean);
    return { locked: false, failures: 0, remainingAttempts: 3, unlockAt: null };
  }
  return {
    locked: false,
    failures: entry.failures,
    remainingAttempts: Math.max(0, 3 - entry.failures),
    unlockAt: null
  };
}

export function recordOtpAttempt(phone = '', succeeded = false, { lockMs = 15 * 60 * 1000 } = {}) {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!clean) return { locked: false, failures: 0, remainingAttempts: 3 };
  if (succeeded) {
    otpAttemptTracker.delete(clean);
    appendAuditEvent('otp_verified', { phone: maskPhoneStars(clean) });
    return { locked: false, failures: 0, remainingAttempts: 3 };
  }
  const prev = getOtpLockStatus(clean);
  if (prev.locked) return prev;
  const failures = prev.failures + 1;
  const lockedUntil = failures >= 3 ? Date.now() + lockMs : null;
  otpAttemptTracker.set(clean, { failures, lockedUntil });
  if (lockedUntil) {
    appendAuditEvent('otp_locked', { phone: maskPhoneStars(clean), failures });
  } else {
    appendAuditEvent('otp_failed', { phone: maskPhoneStars(clean), failures });
  }
  return getOtpLockStatus(clean);
}

export function resetOtpLock(phone = '') {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  otpAttemptTracker.delete(clean);
}

// --- Robust instant order ID generator (no collisions, no hours delay) ---
let _lastOrderMs = 0;
let _orderSeqInMs = 0;
export function generateOrderId() {
  const now = Date.now();
  if (now === _lastOrderMs) {
    _orderSeqInMs = (_orderSeqInMs + 1) % 100;
  } else {
    _lastOrderMs = now;
    _orderSeqInMs = 0;
  }
  // 6-digit base from timestamp + 2-digit seq/random to guarantee uniqueness in same ms
  const base = String(now).slice(-6);
  const suffix = String(_orderSeqInMs).padStart(2, '0');
  let candidate = `${base}${suffix}`.slice(-6);
  // Ensure not already in DB (extremely rare, but handle burst)
  try {
    const db = getDb();
    let tries = 0;
    while (db.orders && db.orders[candidate] && tries < 5) {
      candidate = String((parseInt(candidate, 10) + 1) % 1000000).padStart(6, '0');
      tries++;
    }
    if (db.orders && db.orders[candidate]) {
      candidate = String(now).slice(-5) + String(Math.floor(Math.random() * 10));
      candidate = candidate.slice(-6);
    }
  } catch {}
  return candidate;
}

export function appendAuditEvent(action, meta = {}) {
  try {
    const db = getDb();
    if (!Array.isArray(db.auditLog)) db.auditLog = [];
    const safeMeta = {};
    for (const [k, v] of Object.entries(meta || {})) {
      if (/cookie|token|tid|secret|password/i.test(k)) {
        safeMeta[k] = '[REDACTED]';
      } else if (/phone|mobile/i.test(k) && v) {
        safeMeta[k] = String(v).startsWith('****') ? String(v) : maskPhoneStars(v);
      } else if (typeof v === 'string') {
        safeMeta[k] = redactSensitiveText(v).slice(0, 240);
      } else {
        safeMeta[k] = v;
      }
    }
    db.auditLog.push({
      id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: String(action || 'event'),
      meta: safeMeta,
      at: new Date().toISOString()
    });
    if (db.auditLog.length > 300) {
      db.auditLog = db.auditLog.slice(-300);
    }
    saveDb(db);
  } catch {}
}

