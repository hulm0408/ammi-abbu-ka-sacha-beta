import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const defaultData = {
  config: {
    totalSlots: 9,
    slotsLeft: 5,
    bossIds: [6484999726],
    familyMembers: {},
    accounts: {}
  },
  orders: {},
  drafts: {},
  bossState: null,
  userStates: {}
};

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}

export function getDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.config.bossIds) {
      data.config.bossIds = data.config.bossId ? [data.config.bossId] : [6484999726];
    }
    if (!data.config.familyMembers) {
      data.config.familyMembers = {};
    }
    if (!data.config.accounts) {
      data.config.accounts = defaultData.config.accounts;
    }
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
    return ['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'ACCEPTED') {
    return ['COMPLETED', 'CANCELLED'].includes(targetStatus);
  }
  return false;
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
  db.config.accounts[key] = { ...(db.config.accounts[key] || {}), ...updates };
  saveDb(db);
  return db.config.accounts[key];
}

export function createAccount(key, name, phone = '', address = '') {
  const db = getDb();
  if (!db.config.accounts) db.config.accounts = {};
  const cleanKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  db.config.accounts[cleanKey] = {
    id: cleanKey,
    name: name || (cleanKey.charAt(0).toUpperCase() + cleanKey.slice(1)),
    phone: phone || '',
    token: '',
    address: address || '',
    isLoggedIn: false,
    createdAt: new Date().toISOString()
  };
  saveDb(db);
  return db.config.accounts[cleanKey];
}

export function deleteAccount(key) {
  const db = getDb();
  if (db.config?.accounts?.[key]) {
    delete db.config.accounts[key];
    saveDb(db);
    return true;
  }
  return false;
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

export function exportSessionJson(key) {
  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc || !acc.cookies) return null;

  return {
    account: key,
    name: acc.name || key,
    phone: acc.phone || '',
    customerId: acc.customerId || acc.userId || '',
    tid: acc.tid || '',
    sid: acc.sid || '',
    deviceId: acc.deviceId || '',
    cookies: acc.cookies,
    savedAt: acc.savedAt || new Date().toISOString()
  };
}

export function importSessionJson(rawJson, targetKey = null) {
  try {
    let data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    if (!data || (!data.cookies && !data.tid)) {
      return { success: false, message: 'Invalid session JSON: missing cookies or tid' };
    }

    let cookieStr = data.cookies || '';
    if (!cookieStr && data.tid) {
      cookieStr = `tid=${data.tid}; _sid=${data.sid || ''}; _device_id=${data.deviceId || ''}`;
    }

    const phone = data.phone || data.mobile || '';
    const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '').slice(-10) : '';
    const key = targetKey || (cleanPhone ? `acc_${cleanPhone}` : (data.account || 'acc_' + Date.now()));

    const db = getDb();
    if (!db.config.accounts) db.config.accounts = {};
    if (!db.config.accounts[key]) {
      db.config.accounts[key] = { id: key, name: data.name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User') };
    }

    db.config.accounts[key] = {
      ...db.config.accounts[key],
      phone: cleanPhone || db.config.accounts[key].phone || '',
      name: data.name || db.config.accounts[key].name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User'),
      customerId: data.customerId || data.userId || db.config.accounts[key].customerId || '',
      tid: data.tid || db.config.accounts[key].tid || '',
      sid: data.sid || db.config.accounts[key].sid || '',
      deviceId: data.deviceId || db.config.accounts[key].deviceId || '',
      cookies: cookieStr,
      isLoggedIn: true,
      savedAt: new Date().toISOString()
    };

    if (!db.config.activeOrderAccount) {
      db.config.activeOrderAccount = key;
    }

    saveDb(db);
    return { success: true, account: key, name: db.config.accounts[key].name, phone: db.config.accounts[key].phone };
  } catch (err) {
    return { success: false, message: 'Invalid JSON format: ' + err.message };
  }
}

export function getActiveOrderAccountKey() {
  const db = getDb();
  if (db.config?.activeOrderAccount && db.config?.accounts?.[db.config.activeOrderAccount]?.isLoggedIn) {
    return db.config.activeOrderAccount;
  }
  // Fallback to first logged in account
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

export function permanentLogoutAccount(key) {
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return null;
  acc.isLoggedIn = false;
  acc.cookies = '';
  acc.tid = '';
  acc.sid = '';
  acc.token = '';
  saveDb(db);
  return acc;
}


