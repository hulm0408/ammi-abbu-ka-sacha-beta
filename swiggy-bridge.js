import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer from 'puppeteer-core';
import { updateAccount, getNextAutoUserName, cleanEssentialSwiggyCookies } from './store.js';

export function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  const linuxPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/playwright/browsers/chromium-1247/chrome-linux64/chrome'
  ];
  for (const p of linuxPaths) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  for (const rootDir of ['/opt/playwright/browsers', path.join(os.homedir(), '.cache', 'puppeteer'), '/root/.cache/puppeteer']) {
    try {
      if (!fs.existsSync(rootDir)) continue;
      for (const entry of fs.readdirSync(rootDir)) {
        for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const full = path.join(rootDir, entry, sub);
          if (fs.existsSync(full)) return full;
        }
      }
    } catch (e) {}
  }
  return '/usr/bin/chromium';
}

const CHROME_PATH = findChromePath();
const IS_LINUX = process.platform === 'linux';
const HEADLESS_MODE = (IS_LINUX || process.env.RAILWAY_ENVIRONMENT || process.env.HEADLESS === 'true') ? 'new' : false;

// Active login sessions keyed by userId:
// { [userId]: { browser, page, phone, otp, targetAcc, targetAccName, signupEmail, isNewUser, safetyTimer } }
const activeSessions = {};
// Dedicated in-memory session map for Swiggy account deletions (strictly isolated from login)
const activeDeleteSessions = {};
let deleteOtpRequestCount = 0;
let deleteVerifyRequestCount = 0;

// Pre-warmed browser pool for instantaneous (<1s) OTP dispatch
let prewarmedBrowser = null;
let prewarmedPage = null;
let isPrewarming = false;
let prewarmedAt = 0;

export function stripStaleWafCookie(cookieStr = '') {
  if (!cookieStr || typeof cookieStr !== 'string') return '';
  return cookieStr
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('aws-waf-token='))
    .join('; ');
}

function mergeSetCookiesIntoJar(existingCookieStr = '', setCookieHeaders = []) {
  const map = new Map();
  for (const part of stripStaleWafCookie(existingCookieStr).split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  for (const raw of (setCookieHeaders || [])) {
    const first = String(raw || '').split(';')[0].trim();
    if (!first || !first.includes('=')) continue;
    const idx = first.indexOf('=');
    const k = first.slice(0, idx).trim();
    const v = first.slice(idx + 1).trim();
    if (k && v && k !== '_guest_tid' && k !== 'aws-waf-token') {
      map.set(k, v);
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Helper to decode JWT payload safely
export function decodeJwtPayload(jwtToken) {
  if (!jwtToken || typeof jwtToken !== 'string') return null;
  try {
    const parts = jwtToken.split('.');
    if (parts.length < 2) return null;
    const jsonStr = Buffer.from(parts[1], 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

export function sanitizeSwiggyName(name) {
  if (!name) return 'Rahul Kumar';
  // Strip any previously appended "(User 1)" or "(6296591407)" tag first
  const withoutSlotTag = String(name).replace(/\([^)]*\)/g, ' ');
  const cleaned = withoutSlotTag.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3 || /^user\s*\d*$/i.test(cleaned)) {
    return 'Rahul Kumar';
  }
  return cleaned;
}

function generateUniqueSwiggyEmail(phone, name) {
  const prefix = String(name || 'rahul').toLowerCase().replace(/[^a-z]/g, '').slice(0, 8) || 'rahul';
  const last4 = String(phone || '').slice(-4) || '1000';
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${last4}.${rand}@gmail.com`;
}

// Helper to check if cookies or account contain a verified logged-in user
export function checkLoggedInFromCookies(input) {
  if (!input) return false;
  let tidValue = '';
  let sessionTid = '';
  let tokenVal = '';
  let isLoggedFlag = '';

  if (typeof input === 'object' && !Array.isArray(input)) {
    if (input.isLoggedIn === false) return false;
    if (input.tid) tidValue = String(input.tid);
    if (input._session_tid || input.session_tid || input.sessionTid) {
      sessionTid = String(input._session_tid || input.session_tid || input.sessionTid);
    }
    if (!sessionTid && tidValue && !tidValue.includes('.')) {
      sessionTid = tidValue;
    }
    if (input.token || input.auth_token || input.access_token || input.authToken || input.accessToken) {
      tokenVal = String(input.token || input.auth_token || input.access_token || input.authToken || input.accessToken);
    }
    if (input.cookies) input = input.cookies;
    else if (!tidValue && !tokenVal && !sessionTid) return Boolean(input.isLoggedIn);
  }

  if (Array.isArray(input)) {
    const getC = (n) => input.find(c => c && c.name === n)?.value || '';
    tidValue = tidValue || getC('tid');
    sessionTid = sessionTid || getC('_session_tid');
    tokenVal = tokenVal || getC('token');
    isLoggedFlag = getC('_is_logged_in');
  } else if (typeof input === 'string') {
    const getS = (re) => {
      const m = input.match(re);
      return m ? decodeURIComponent(m[1]).trim() : '';
    };
    tidValue = tidValue || getS(/(?:^|;\s*)tid=([^;]+)/);
    sessionTid = sessionTid || getS(/(?:^|;\s*)_session_tid=([^;]+)/);
    tokenVal = tokenVal || getS(/(?:^|;\s*)token=([^;]+)/);
    isLoggedFlag = getS(/(?:^|;\s*)_is_logged_in=([^;]+)/);
    if (!tidValue && input.includes('.') && input.length > 50 && !input.includes(';')) {
      tidValue = input.trim();
    }
    if (!sessionTid && /^[0-9a-fA-F]{40,}$/.test(input.trim())) {
      sessionTid = input.trim();
    }
  }

  if (tidValue && tidValue.includes('.')) {
    const payload = decodeJwtPayload(tidValue);
    if (payload && payload.user_id && payload.user_id !== '0' && payload.user_id !== '-1') {
      return true;
    }
    // If `tid` is an explicit guest pre-OTP JWT (`user_id === "0"`) and there is NO real `_session_tid`, it is NOT logged in!
    if (payload && (payload.user_id === '0' || payload.user_id === '-1') && !sessionTid && (!tokenVal || tokenVal === tidValue)) {
      return false;
    }
  }

  if (isLoggedFlag === '1' && (sessionTid.length >= 16 || tokenVal.length >= 10)) {
    return true;
  }
  if (isLoggedFlag !== '0' && (sessionTid.length >= 32 || tokenVal.length >= 24 || (tokenVal.length >= 16 && tidValue.length >= 50))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Auto-claim Swiggy Event Offers:
// 1. Breakfast Morning (6 AM To 11 AM) - https://events.swiggy.com/book-your-offer
// 2. Dinner Late Night Offer (9 PM To 11 PM) - https://events.swiggy.com/pick-your-late-night-offer
// Automatically selects 50 off on 199 (value: 1)
// ---------------------------------------------------------------------------
export async function claimSwiggyBreakfastAndLateNightOffers(account) {
  if (!account) return { success: false, reason: 'No account provided' };

  let token = account.token || '';
  let jwtTid = account.tid || '';
  let cookieStr = stripStaleWafCookie(account.cookies || '');

  if (cookieStr) {
    const tidCookie = cookieStr.split(';').map(s => s.trim()).find(s => s.startsWith('tid='));
    if (tidCookie) {
      jwtTid = tidCookie.slice(4);
    }
    if (!token) {
      const tokCookie = cookieStr.split(';').map(s => s.trim()).find(s => s.startsWith('token='));
      if (tokCookie) {
        token = tokCookie.slice(6);
      }
    }
  }

  // Always verify & refresh live `tid` via zero-WAF `/dapi/order/all` when cookies exist
  let liveSessionDead = false;
  if (cookieStr) {
    try {
      const authRes = await fetch('https://www.swiggy.com/dapi/order/all', {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.swiggy.com/my-account'
        },
        signal: AbortSignal.timeout(6000)
      });
      const authJson = await authRes.json().catch(() => null);
      if (authRes.status === 200 && authJson?.statusCode === 0 && authJson?.tid) {
        jwtTid = authJson.tid;
        account.tid = jwtTid;
        const setCookies = typeof authRes.headers.getSetCookie === 'function' ? authRes.headers.getSetCookie() : [];
        if (setCookies.length > 0) {
          cookieStr = mergeSetCookiesIntoJar(cookieStr, setCookies);
        }
      } else if (authJson?.statusCode === 1) {
        liveSessionDead = true;
      }
    } catch (e) {}
  }

  if (!token && jwtTid) {
    token = jwtTid;
  }

  if (!jwtTid && !token) {
    return { success: false, sessionExpired: true, reason: 'Session Logged Out — Re-login required' };
  }

  if (!cookieStr && jwtTid) {
    cookieStr = `tid=${jwtTid}` + (account.sid ? `; _sid=${account.sid}` : '') + (account.deviceId ? `; _device_id=${account.deviceId}` : '');
  }

  let bfCampaign = 'byo-bf-v10-15';
  let lnCampaign = 'byo-ln-v5-15';

  try {
    const [bfRes, lnRes] = await Promise.all([
      fetch('https://events.swiggy.com/book-your-offer?utm_source=app&utm_medium=share', { signal: AbortSignal.timeout(5000) }),
      fetch('https://events.swiggy.com/pick-your-late-night-offer?utm_source=app&utm_medium=share', { signal: AbortSignal.timeout(5000) })
    ]);
    const [bfHtml, lnHtml] = await Promise.all([bfRes.text(), lnRes.text()]);

    function extractCampaign(html, defaultPrefix) {
      const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
      if (nextMatch) {
        try {
          const data = JSON.parse(nextMatch[1]);
          const nexus = data?.props?.pageProps?.nexusData;
          const prefix = nexus?.notifyCampaignIdPrefix || defaultPrefix;
          const boundaries = nexus?.dayBoundaries || [];
          const nowMs = Date.now();
          for (const d of boundaries) {
            const start = new Date(d.startTime).getTime();
            const end = new Date(d.endTime).getTime();
            if (nowMs >= start && nowMs <= end) {
              return `${prefix}${d.day}`;
            }
          }
          if (boundaries.length > 0) {
            const start1 = new Date(boundaries[0].startTime).getTime();
            const diff = Math.floor((nowMs - start1) / (24 * 3600 * 1000)) + 1;
            return `${prefix}${Math.max(1, Math.min(diff, boundaries.length))}`;
          }
        } catch (e) {}
      }
      return null;
    }

    const dynBf = extractCampaign(bfHtml, 'byo-bf-v10-');
    const dynLn = extractCampaign(lnHtml, 'byo-ln-v5-');
    if (dynBf) bfCampaign = dynBf;
    if (dynLn) lnCampaign = dynLn;
  } catch (e) {
    console.warn('[EventsClaim] Dynamic campaign lookup fallback used:', e.message);
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'token': token || jwtTid,
    'tid': jwtTid,
    'Cookie': cookieStr,
    'Origin': 'https://events.swiggy.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
  };

  try {
    const [resBf, resLn] = await Promise.all([
      fetch('https://events.swiggy.com/api/notify', {
        method: 'POST',
        headers: { ...baseHeaders, 'Referer': 'https://events.swiggy.com/book-your-offer' },
        body: JSON.stringify({ campaign: bfCampaign, value: 1 }),
        signal: AbortSignal.timeout(8000)
      }),
      fetch('https://events.swiggy.com/api/notify', {
        method: 'POST',
        headers: { ...baseHeaders, 'Referer': 'https://events.swiggy.com/pick-your-late-night-offer' },
        body: JSON.stringify({ campaign: lnCampaign, value: 1 }),
        signal: AbortSignal.timeout(8000)
      })
    ]);

    const bfJson = await resBf.json().catch(() => ({}));
    const lnJson = await resLn.json().catch(() => ({}));

    const bfOk = resBf.ok || (bfJson?.message && bfJson.message.toLowerCase().includes('already'));
    const lnOk = resLn.ok || (lnJson?.message && lnJson.message.toLowerCase().includes('already'));

    const formatOfferMsg = (ok, res, json) => {
      if (ok) {
        if (json.message?.toLowerCase().includes('already')) {
          return `Already Active (${json.message})`;
        }
        return json.message || 'Claimed Successfully';
      }
      if (res.status === 401 || liveSessionDead) return 'Session Expired — Re-login required';
      if (res.status === 403) return 'HTTP 403 Forbidden (WAF Blocked)';
      return `HTTP ${res.status} (${json.message || res.statusText || 'Error'})`;
    };

    console.log(`[EventsClaim] Account ${account.phone || account.name || 'User'} result:`, {
      breakfast: { campaign: bfCampaign, status: resBf.status, msg: bfJson.message },
      lateNight: { campaign: lnCampaign, status: resLn.status, msg: lnJson.message }
    });

    return {
      success: bfOk || lnOk,
      bothClaimed: bfOk && lnOk,
      sessionExpired: !bfOk && !lnOk && (resBf.status === 401 || resLn.status === 401 || liveSessionDead),
      breakfast: {
        name: 'Breakfast Morning (6AM-11AM)',
        campaign: bfCampaign,
        status: bfOk ? 'CLAIMED' : 'FAILED',
        statusCode: resBf.status,
        discount: '₹50 OFF on ₹199',
        rawMessage: bfJson.message || '',
        message: formatOfferMsg(bfOk, resBf, bfJson)
      },
      lateNight: {
        name: 'Dinner Late Night (9PM-11PM)',
        campaign: lnCampaign,
        status: lnOk ? 'CLAIMED' : 'FAILED',
        statusCode: resLn.status,
        discount: '₹50 OFF on ₹199',
        rawMessage: lnJson.message || '',
        message: formatOfferMsg(lnOk, resLn, lnJson)
      }
    };
  } catch (err) {
    console.error('[EventsClaim] Request error:', err.message);
    return { success: false, error: err.message };
  }
}

async function launchStealthSwiggyBrowser() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS_MODE,
    protocolTimeout: 60000,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(IS_LINUX ? [] : ['--window-position=-32000,-32000']),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,900',
      '--lang=en-US,en'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
  });
  return { browser, page };
}

// Pre-warm browser in background so when user asks for OTP, it fires instantly
export async function prewarmBrowser() {
  if (isPrewarming || (prewarmedPage && prewarmedBrowser?.connected && (Date.now() - prewarmedAt < 180000))) return;
  isPrewarming = true;

  try {
    if (prewarmedBrowser) {
      await prewarmedBrowser.close().catch(() => {});
      prewarmedBrowser = null;
      prewarmedPage = null;
    }

    const { browser, page } = await launchStealthSwiggyBrowser();
    await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    let wafFound = false;
    for (let i = 0; i < 25; i++) {
      const cookies = await page.cookies();
      const waf = cookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) {
        wafFound = true;
        break;
      }
      await new Promise(r => setTimeout(r, 800));
    }

    if (!wafFound) {
      console.warn('⚠️ [SwiggyBridge] Prewarm: AWS WAF token not acquired within 20s. Discarding session.');
      await browser.close().catch(() => {});
      return;
    }

    await new Promise(r => setTimeout(r, 1500));

    prewarmedBrowser = browser;
    prewarmedPage = page;
    prewarmedAt = Date.now();
    console.log('⚡ [SwiggyBridge] Pre-warmed Chrome is primed with valid AWS WAF token on swiggy.com! Next OTP will fire in <1s.');
  } catch (err) {
    console.error('Failed to prewarm Chrome:', err.message);
    if (prewarmedBrowser) {
      await prewarmedBrowser.close().catch(() => {});
      prewarmedBrowser = null;
      prewarmedPage = null;
    }
  } finally {
    isPrewarming = false;
  }
}

async function safeEvaluate(page, fn, ...args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const evalPromise = page.evaluate(fn, ...args);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('CDP evaluate timeout after 12s')), 12000)
      );
      return await Promise.race([evalPromise, timeoutPromise]);
    } catch (err) {
      if (
        err.message.includes('Execution context was destroyed') ||
        err.message.includes('Cannot find context') ||
        err.message.includes('target closed') ||
        err.message.includes('timed out') ||
        err.message.includes('timeout')
      ) {
        console.log(`[SwiggyBridge] Context navigating/reloaded or slow (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Browser evaluate timed out. Please retry.');
}

export function parseSwiggyOtpError(otpResult) {
  if (!otpResult) {
    return {
      message: 'Swiggy API dwara koi response nahi mila. Kripya dobara try karein.',
      swiggyStatus: 'No Response',
      details: 'Empty response from Swiggy'
    };
  }

  const swiggyMsg = (otpResult.data?.statusMessage || otpResult.data?.message || '').trim();
  const rawLower = ((otpResult.rawText || '') + ' ' + swiggyMsg).toLowerCase();
  const status = otpResult.status;

  if (status === 429 || rawLower.includes('rate limit') || rawLower.includes('too many') || rawLower.includes('limit reached') || rawLower.includes('maximum attempts')) {
    return {
      message: 'Swiggy Rate Limit: Is mobile number ya IP par Swiggy ne OTP limit laga di hai (Too many requests). Kripya 15-30 minute intezaar karein ya doosra number / session JSON paste karein.',
      swiggyStatus: swiggyMsg || 'Swiggy Rate Limit (429 Too Many Requests)',
      details: `HTTP ${status || 429} | Rate limit reached on Swiggy`
    };
  }

  if (status === 403 || rawLower.includes('waf') || rawLower.includes('captcha') || rawLower.includes('challenge') || rawLower.includes('forbidden')) {
    return {
      message: 'Swiggy Anti-Bot Protection (AWS WAF): Swiggy security firewall ne browser request ko verify nahi hone diya. Kripya Retry dabayein ya Session JSON se login karein.',
      swiggyStatus: swiggyMsg || 'Security Challenge (WAF 403 Forbidden)',
      details: `HTTP ${status || 403} | AWS WAF Anti-bot challenge`
    };
  }

  if (status === 400 || status === 422 || rawLower.includes('invalid mobile') || rawLower.includes('valid 10 digit')) {
    return {
      message: `Invalid Mobile Number: Swiggy ne is number ko reject kiya (${swiggyMsg || 'Invalid format'}). Kripya 10-digit valid Indian number daalein.`,
      swiggyStatus: swiggyMsg || 'Invalid Mobile Number',
      details: `HTTP ${status || 400}`
    };
  }

  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return {
      message: `Swiggy Server Error (${status}): Swiggy backend servers par temporary issue chal raha hai. Kripya 1-2 minute baad dobara koshish karein.`,
      swiggyStatus: swiggyMsg || `Swiggy Server Down (${status})`,
      details: `HTTP ${status}`
    };
  }

  if (otpResult.error) {
    return {
      message: `Puppeteer / Browser Error: ${otpResult.error}`,
      swiggyStatus: otpResult.error,
      details: 'Browser context error'
    };
  }

  if (swiggyMsg) {
    return {
      message: `Swiggy Error: "${swiggyMsg}" (HTTP ${status || 200})`,
      swiggyStatus: swiggyMsg,
      details: `HTTP ${status || 200} | Swiggy Code: ${otpResult.data?.statusCode ?? 'none'}`
    };
  }

  return {
    message: `Swiggy API Error: OTP deliver nahi ho paya (HTTP ${status || 'unknown'}). Kripya Retry ya Session JSON se login karein.`,
    swiggyStatus: `HTTP ${status || 'unknown'} - OTP Failed`,
    details: `HTTP ${status || 'unknown'}`
  };
}

export async function requestSwiggyOtpViaBridge(userId, phone, targetAcc = '', targetAccName = null) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);

  if (cleanPhone.length !== 10) {
    return { success: false, message: 'Please enter a valid 10-digit phone number.' };
  }

  let browser;
  let page;
  let isReused = false;

  if (
    activeSessions[userId] &&
    activeSessions[userId].needsName &&
    activeSessions[userId].phone === cleanPhone &&
    activeSessions[userId].browser?.connected &&
    activeSessions[userId].page
  ) {
    console.log(`⚡ [SwiggyBridge] Reusing warm browser session for ${cleanPhone} with name "${targetAccName}"...`);
    browser = activeSessions[userId].browser;
    page = activeSessions[userId].page;
    isReused = true;
    if (activeSessions[userId].safetyTimer) {
      clearTimeout(activeSessions[userId].safetyTimer);
    }
  } else {
    if (activeSessions[userId]) {
      try {
        if (activeSessions[userId].safetyTimer) clearTimeout(activeSessions[userId].safetyTimer);
        await activeSessions[userId].browser.close();
      } catch (e) {}
      delete activeSessions[userId];
    }

    let isUsable = false;
    if (prewarmedPage && prewarmedBrowser?.connected && (Date.now() - prewarmedAt < 180000)) {
      try {
        await Promise.race([
          prewarmedPage.evaluate(() => 1),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 1200))
        ]);
        isUsable = true;
      } catch (pingErr) {
        isUsable = false;
      }
    }

    if (isUsable) {
      browser = prewarmedBrowser;
      page = prewarmedPage;
      prewarmedBrowser = null;
      prewarmedPage = null;
      console.log(`⚡ [SwiggyBridge] Using primed Chrome for instantaneous OTP to ${cleanPhone}...`);
    } else {
      if (prewarmedBrowser) {
        await prewarmedBrowser.close().catch(() => {});
        prewarmedBrowser = null;
        prewarmedPage = null;
      }

      const launched = await launchStealthSwiggyBrowser();
      browser = launched.browser;
      page = launched.page;
      await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

      for (let i = 0; i < 25; i++) {
        const cookies = await page.cookies();
        const waf = cookies.find(c => c.name === 'aws-waf-token');
        if (waf && waf.value.length > 50) break;
        await new Promise(r => setTimeout(r, 600));
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  try {
    // Ensure clean unauthenticated cookie context inside browser before triggering fresh OTP / Re-Login!
    const existingBrowserCookies = await page.cookies();
    const staleAuthCookies = existingBrowserCookies.filter(c => ['_session_tid', 'tid', 'token', '_is_logged_in'].includes(c.name));
    if (staleAuthCookies.length > 0) {
      await page.deleteCookie(...staleAuthCookies).catch(() => {});
    }

    const pageCookies = await page.cookies();
    const wafCookie = pageCookies.find(c => c.name === 'aws-waf-token');
    const wafToken = wafCookie?.value || '';

    let otpResult;
    if (isReused && targetAccName) {
      otpResult = { status: 200, data: { statusCode: 1, statusMessage: 'not registered' } };
    } else {
      otpResult = await safeEvaluate(page, async (mobileNumber, waf) => {
        try {
          const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': navigator.userAgent
          };
          if (waf) headers['aws-waf-token'] = waf;

          let res = await fetch('/dapi/auth/sms-otp', {
            method: 'POST',
            headers,
            body: JSON.stringify({ mobile: mobileNumber }),
            credentials: 'include',
            signal: AbortSignal.timeout(8000)
          });

          let rawText = await res.text().catch(() => '');
          let data = {};
          try { data = JSON.parse(rawText); } catch (e) {}

          if ((res.status !== 200 && res.status !== 202) || (data.statusCode && data.statusCode !== 0 && data.statusCode !== 1)) {
            try {
              const altRes = await fetch('/dapi/auth/otp-generate', {
                method: 'POST',
                headers,
                body: JSON.stringify({ mobile: mobileNumber }),
                credentials: 'include',
                signal: AbortSignal.timeout(8000)
              });
              const altText = await altRes.text().catch(() => '');
              const altData = JSON.parse(altText);
              if (altRes.status === 200 && (altData.statusCode === 0 || !altData.statusCode)) {
                return { status: altRes.status, data: altData, rawText: altText, endpoint: 'otp-generate' };
              }
            } catch (e) {}
          }

          return { status: res.status, data, rawText };
        } catch (err) {
          return { status: 500, error: err.message };
        }
      }, cleanPhone, wafToken);
    }

    console.log('[SwiggyBridge] OTP dispatch raw result for ' + cleanPhone + ':', JSON.stringify(otpResult));

    const msgLower = (otpResult.data?.statusMessage || '').toLowerCase();
    const isRateOrInvalid =
      msgLower.includes('rate limit') ||
      msgLower.includes('too many') ||
      msgLower.includes('limit reached') ||
      msgLower.includes('maximum') ||
      msgLower.includes('valid 10 digit');

    // Covers both brand-new numbers AND numbers that were just deleted/archived on Swiggy (`re-login that account` after delete!)
    const isUnregistered = otpResult.data?.statusCode === 1 && !isRateOrInvalid;

    if (isUnregistered) {
      const signupName = sanitizeSwiggyName(targetAccName);
      // Unique email prevents collision with any previous archived/deleted Swiggy account on the same mobile number!
      const signupEmail = generateUniqueSwiggyEmail(cleanPhone, signupName);
      console.log(`[SwiggyBridge] Number ${cleanPhone} unregistered/fresh on Swiggy. Triggering signup OTP as "${signupName}" (${signupEmail})...`);

      const signupInitResult = await safeEvaluate(page, async (mobileNumber, name, email, waf) => {
        try {
          const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          };
          if (waf) headers['aws-waf-token'] = waf;
          const res = await fetch('https://www.swiggy.com/dapi/auth/signup', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              mobile: mobileNumber,
              name,
              email
            }),
            credentials: 'include',
            signal: AbortSignal.timeout(8000)
          });
          const text = await res.text().catch(() => '');
          let data = {};
          try { data = JSON.parse(text); } catch (e) {}
          return { status: res.status, data, rawText: text };
        } catch (err) {
          return { status: 500, error: err.message };
        }
      }, cleanPhone, signupName, signupEmail, wafToken);

      console.log('[SwiggyBridge] Signup dispatch raw result:', JSON.stringify(signupInitResult));
      const signupSent = (signupInitResult.status === 200 || signupInitResult.status === 202) && (
        signupInitResult.data?.statusCode === 0 || !signupInitResult.data?.statusCode
      );

      if (signupSent) {
        const safetyTimer = setTimeout(() => {
          if (activeSessions[userId]?.phone === cleanPhone) {
            activeSessions[userId].browser?.close().catch(() => {});
            delete activeSessions[userId];
          }
        }, 300000);

        activeSessions[userId] = {
          browser,
          page,
          phone: cleanPhone,
          targetAcc: targetAcc || `acc_${cleanPhone}`,
          targetAccName: signupName,
          signupEmail,
          isNewUser: true,
          safetyTimer,
          createdAt: Date.now()
        };

        return {
          success: true,
          phone: cleanPhone,
          isNewUser: true,
          message: 'OTP Sent',
          swiggyStatus: 'OTP Sent'
        };
      } else {
        await browser.close().catch(() => {});
        const parsedErr = parseSwiggyOtpError(signupInitResult);
        if (process.env.PREWARM_CHROME === 'true') setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
        return {
          success: false,
          message: parsedErr.message,
          swiggyStatus: parsedErr.swiggyStatus,
          details: parsedErr.details
        };
      }
    }

    const isSent = (otpResult.status === 200 || otpResult.status === 202) && (
      otpResult.data?.statusCode === 0 || !otpResult.data?.statusCode
    );

    if (isSent) {
      const safetyTimer = setTimeout(() => {
        if (activeSessions[userId]?.phone === cleanPhone) {
          console.log(`[SwiggyBridge] Session for ${cleanPhone} timed out after 5 mins. Closing browser.`);
          activeSessions[userId].browser?.close().catch(() => {});
          delete activeSessions[userId];
        }
      }, 300000);

      activeSessions[userId] = {
        browser,
        page,
        phone: cleanPhone,
        targetAcc: targetAcc || `acc_${cleanPhone}`,
        targetAccName: targetAccName || null,
        isNewUser: false,
        safetyTimer,
        createdAt: Date.now()
      };

      return {
        success: true,
        phone: cleanPhone,
        message: 'OTP Sent',
        swiggyStatus: 'OTP Sent'
      };
    } else {
      await browser.close().catch(() => {});
      const parsedErr = parseSwiggyOtpError(otpResult);
      if (process.env.PREWARM_CHROME === 'true') setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
      return {
        success: false,
        message: parsedErr.message,
        swiggyStatus: parsedErr.swiggyStatus,
        details: parsedErr.details
      };
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    delete activeSessions[userId];
    if (process.env.PREWARM_CHROME === 'true') setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
    return {
      success: false,
      message: `System / Browser Error: ${err.message}`,
      swiggyStatus: err.message,
      details: err.stack ? err.stack.split('\n')[0] : err.message
    };
  }
}

export async function requestSwiggyDeleteOtpViaBridge(userId, phone, targetAcc = '', targetAccName = null) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);

  delete activeDeleteSessions[userId];

  const { getDb } = await import('./store.js');
  const db = getDb();
  let acc = db.config?.accounts?.[targetAcc];

  let rawCookieString = acc?.cookies || '';
  if (!rawCookieString && cleanPhone) {
    for (const [k, a] of Object.entries(db.config?.accounts || {})) {
      if ((a.phone === cleanPhone || k === `acc_${cleanPhone}`) && a.cookies) {
        rawCookieString = a.cookies;
        acc = a;
        targetAcc = k;
        break;
      }
    }
  }

  // Always strip stale `aws-waf-token` so AWS WAF never returns a false 403!
  let cookieString = stripStaleWafCookie(rawCookieString);

  if (!cookieString) {
    return {
      success: false,
      isAuthError: true,
      message: 'Account session cookies not found. Please log in first or remove account from Bot DB.'
    };
  }

  const isAuth = checkLoggedInFromCookies(cookieString) || checkLoggedInFromCookies(acc);
  if (!isAuth) {
    return {
      success: false,
      isAuthError: true,
      message: 'Selected account session is logged out or expired. Re-login or remove from Bot DB.'
    };
  }

  deleteOtpRequestCount++;
  const reqNum = deleteOtpRequestCount;
  const maskedPhone = cleanPhone.length >= 4 ? '******' + cleanPhone.slice(-4) : '***';
  console.log(`[SwiggyDelete] [Request #${reqNum}] Triggering Delete OTP: GET /mapi/auth/delete/userCheck | Target: ${targetAcc} | Phone: ${maskedPhone}`);

  try {
    let status = 0;
    let data = {};
    let mergedCookies = cookieString;

    const res = await fetch('https://www.swiggy.com/mapi/auth/delete/userCheck', {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json',
        'Referer': 'https://www.swiggy.com/my-account/settings',
        'Origin': 'https://www.swiggy.com'
      },
      signal: AbortSignal.timeout(10000)
    });

    status = res.status;
    data = await res.json().catch(() => ({}));
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      mergedCookies = mergeSetCookiesIntoJar(cookieString, setCookies);
    }

    // Automatic browser fallback if AWS WAF challenged direct HTTP request (403 / 202)
    if (status === 403 || status === 202) {
      console.log(`[SwiggyDelete] Direct userCheck got WAF ${status}; retrying inside stealth Chromium...`);
      let browser = null;
      try {
        const launched = await launchStealthSwiggyBrowser();
        browser = launched.browser;
        const page = launched.page;
        await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        for (let i = 0; i < 20; i++) {
          const ck = await page.cookies();
          if (ck.some(c => c.name === 'aws-waf-token' && c.value.length > 50)) break;
          await new Promise(r => setTimeout(r, 600));
        }
        const cookieObjs = mergedCookies.split(';').map(s => s.trim()).filter(s => s.includes('=')).map(s => {
          const idx = s.indexOf('=');
          return { name: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim(), domain: '.swiggy.com', path: '/' };
        });
        if (cookieObjs.length > 0) await page.setCookie(...cookieObjs);
        const wafVal = (await page.cookies()).find(c => c.name === 'aws-waf-token')?.value || '';
        const brRes = await safeEvaluate(page, async (waf) => {
          const headers = { 'Accept': 'application/json' };
          if (waf) headers['aws-waf-token'] = waf;
          const r = await fetch('https://www.swiggy.com/mapi/auth/delete/userCheck', {
            method: 'GET',
            headers,
            credentials: 'include'
          });
          const j = await r.json().catch(() => ({}));
          return { status: r.status, data: j };
        }, wafVal);
        status = brRes.status;
        data = brRes.data || {};
        const finalCk = await page.cookies();
        mergedCookies = stripStaleWafCookie(finalCk.map(c => `${c.name}=${c.value}`).join('; '));
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }

    console.log(`[SwiggyDelete] [Request #${reqNum}] Response: HTTP ${status} | SwiggyCode: ${data.statusCode ?? 'none'} | Message: ${data.statusMessage || data.error || 'ok'}`);

    const isSent = status === 200 && (data.statusCode === 28 || data.statusCode === 0);

    if (!isSent) {
      const isAuthError = status === 401 || data.statusCode === 1 || (data.statusMessage && data.statusMessage.toLowerCase().includes('login'));
      const errMsg = isAuthError
        ? 'Swiggy session has expired on Swiggy servers. Re-login or remove this account from Bot DB.'
        : (data.statusMessage || data.error || `Swiggy returned status ${status} (code ${data.statusCode ?? 'unknown'})`);
      return {
        success: false,
        isAuthError,
        message: errMsg,
        swiggyStatus: errMsg
      };
    }

    activeDeleteSessions[userId] = {
      accountKey: targetAcc,
      phone: cleanPhone,
      tid: data.tid || '',
      csrfToken: data.csrfToken || '',
      sid: data.sid || '',
      deviceId: data.deviceId || '',
      cookies: mergedCookies,
      createdAt: Date.now()
    };

    return {
      success: true,
      phone: cleanPhone,
      message: data.statusMessage || 'Archive OTP Sent',
      swiggyStatus: 'Swiggy Account Deletion OTP sent to ' + cleanPhone
    };
  } catch (err) {
    console.error(`[SwiggyDelete] [Request #${reqNum}] Exception calling /mapi/auth/delete/userCheck:`, err.message);
    return {
      success: false,
      message: 'Failed to contact Swiggy deletion endpoint: ' + err.message
    };
  }
}

export async function verifyAndDeleteSwiggyAccountViaBridge(userId, otp, accountKey) {
  const session = activeDeleteSessions[userId];
  const cleanOtp = String(otp).replace(/[^0-9]/g, '').trim();

  if (cleanOtp.length < 4) {
    return { success: false, message: 'Please enter a valid 6-digit OTP.' };
  }

  const { getDb } = await import('./store.js');
  const db = getDb();
  const acc = db.config?.accounts?.[accountKey];
  const phone = session?.phone || acc?.phone || accountKey.replace('acc_', '');
  const cookieString = stripStaleWafCookie(session?.cookies || acc?.cookies || '');
  const csrfToken = session?.csrfToken || '';
  const tid = session?.tid || acc?.tid || '';

  if (!cookieString) {
    return {
      success: false,
      message: 'Deletion session or cookies expired. Please tap Delete Account again to get a fresh OTP.'
    };
  }

  deleteVerifyRequestCount++;
  const reqNum = deleteVerifyRequestCount;
  const maskedPhone = phone.length >= 4 ? '******' + phone.slice(-4) : '***';
  console.log(`[SwiggyDelete] [Verify #${reqNum}] Verifying Delete OTP: POST /mapi/auth/delete/user | Target: ${accountKey} | Phone: ${maskedPhone}`);

  try {
    let status = 0;
    let verifyResult = null;
    const fullCookieHeader = cookieString + (tid && !cookieString.includes('tid=') ? `; tid=${tid}` : '') + (csrfToken ? `; _csrf=${csrfToken}` : '');

    const res = await fetch('https://www.swiggy.com/mapi/auth/delete/user', {
      method: 'POST',
      headers: {
        'Cookie': fullCookieHeader,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.swiggy.com',
        'Referer': 'https://www.swiggy.com/my-account/settings'
      },
      body: JSON.stringify({ otp: cleanOtp, _csrf: csrfToken }),
      signal: AbortSignal.timeout(10000)
    });

    status = res.status;
    verifyResult = await res.json().catch(() => ({}));

    if (status === 403 || status === 202) {
      let browser = null;
      try {
        const launched = await launchStealthSwiggyBrowser();
        browser = launched.browser;
        const page = launched.page;
        await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        for (let i = 0; i < 20; i++) {
          const ck = await page.cookies();
          if (ck.some(c => c.name === 'aws-waf-token' && c.value.length > 50)) break;
          await new Promise(r => setTimeout(r, 600));
        }
        const cookieObjs = fullCookieHeader.split(';').map(s => s.trim()).filter(s => s.includes('=')).map(s => {
          const idx = s.indexOf('=');
          return { name: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim(), domain: '.swiggy.com', path: '/' };
        });
        if (cookieObjs.length > 0) await page.setCookie(...cookieObjs);
        const wafVal = (await page.cookies()).find(c => c.name === 'aws-waf-token')?.value || '';
        const brRes = await safeEvaluate(page, async (otpVal, csrfVal, waf) => {
          const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
          if (waf) headers['aws-waf-token'] = waf;
          const r = await fetch('https://www.swiggy.com/mapi/auth/delete/user', {
            method: 'POST',
            headers,
            body: JSON.stringify({ otp: otpVal, _csrf: csrfVal }),
            credentials: 'include'
          });
          const j = await r.json().catch(() => ({}));
          return { status: r.status, data: j };
        }, cleanOtp, csrfToken, wafVal);
        status = brRes.status;
        verifyResult = brRes.data || {};
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }

    console.log(`[SwiggyDelete] [Verify #${reqNum}] Response: HTTP ${status} | SwiggyCode: ${verifyResult?.statusCode ?? 'none'} | Message: ${verifyResult?.statusMessage || verifyResult?.error || 'ok'}`);

    if (!verifyResult || verifyResult.error) {
      return {
        success: false,
        message: verifyResult?.error || 'Failed to communicate with Swiggy servers. Please try again.'
      };
    }

    if (verifyResult.statusCode === 29) {
      return {
        success: false,
        message: verifyResult.statusMessage || 'Invalid OTP. Please check and re-enter.'
      };
    }

    if (verifyResult.statusCode === 25) {
      delete activeDeleteSessions[userId];
      return { success: false, message: 'You have pending cancellation charges. Please clear them first on Swiggy.' };
    }
    if (verifyResult.statusCode === 26) {
      delete activeDeleteSessions[userId];
      return { success: false, message: 'You have an ongoing order. Please try after delivery.' };
    }
    if (verifyResult.statusCode === 34) {
      delete activeDeleteSessions[userId];
      return { success: false, message: 'Cannot delete: active Swiggy Money wallet exists.' };
    }

    const isSuccess = (verifyResult.statusCode === 33 || verifyResult.statusCode === 0 || (status === 200 && verifyResult.statusCode === undefined));

    if (isSuccess) {
      delete activeDeleteSessions[userId];
      return {
        success: true,
        phone,
        message: verifyResult.statusMessage || 'Account permanently deleted from Swiggy servers!'
      };
    }

    return {
      success: false,
      message: verifyResult.statusMessage || `Deletion blocked by Swiggy (Code ${verifyResult.statusCode})`
    };
  } catch (err) {
    console.error(`[SwiggyDelete] [Verify #${reqNum}] Error in delete OTP verification:`, err.message);
    return { success: false, message: err.message };
  }
}

export async function verifySwiggyOtpViaBridge(userId, otp) {
  const session = activeSessions[userId];
  if (!session) {
    return { success: false, message: 'Session expired. Please enter phone number again.' };
  }

  const cleanOtp = String(otp).replace(/[^0-9]/g, '').trim();
  if (cleanOtp.length < 4) {
    return { success: false, message: 'Please enter a valid 6-digit OTP.' };
  }

  const { browser, page, phone, targetAcc } = session;

  try {
    const pageCookies = await page.cookies();
    const wafCookie = pageCookies.find(c => c.name === 'aws-waf-token');
    const wafToken = wafCookie?.value || '';

    let verifyResult = null;
    let statusCode = null;
    let statusMsg = '';
    let isSuccess = false;

    if (!session.isNewUser) {
      try {
        verifyResult = await safeEvaluate(page, async (mobileNumber, otpCode, waf) => {
          try {
            const headers = {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            };
            if (waf) headers['aws-waf-token'] = waf;
            const res = await fetch('/dapi/auth/otp-verify', {
              method: 'POST',
              headers,
              body: JSON.stringify({ mobile: mobileNumber, otp: otpCode }),
              credentials: 'include',
              signal: AbortSignal.timeout(8000)
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, data };
          } catch (err) {
            return { status: 500, error: err.message };
          }
        }, phone, cleanOtp, wafToken);
      } catch (evalErr) {
        console.log('[SwiggyBridge] Evaluation error during verify:', evalErr.message);
      }

      console.log(`[SwiggyBridge] Verify raw result for ${phone}:`, JSON.stringify(verifyResult));
      statusCode = verifyResult?.data?.statusCode;
      statusMsg = (verifyResult?.data?.statusMessage || '').trim();
      isSuccess = (verifyResult?.status === 200 || verifyResult?.status === 202) && statusCode === 0;
    }

    const isUnregistered =
      session.isNewUser ||
      statusCode === 999 ||
      statusMsg.toLowerCase().includes('not registered') ||
      statusMsg.toLowerCase().includes('invalid mobile number') ||
      statusMsg.toLowerCase().includes('user not found');

    if (statusCode === 1 && !isUnregistered) {
      if (session.safetyTimer) clearTimeout(session.safetyTimer);
      session.safetyTimer = setTimeout(() => {
        if (activeSessions[userId]?.phone === phone) {
          activeSessions[userId].browser?.close().catch(() => {});
          delete activeSessions[userId];
        }
      }, 180000);

      return {
        success: false,
        swiggyStatus: statusMsg || 'Galat OTP (Invalid OTP)',
        message: statusMsg || 'Galat OTP enter kiya hai. Kripya check karke dubara daalein.'
      };
    }

    if (isUnregistered) {
      const signupName = sanitizeSwiggyName(session.targetAccName);
      const signupEmail = session.signupEmail || generateUniqueSwiggyEmail(phone, signupName);
      session.signupEmail = signupEmail;
      console.log(`[SwiggyBridge] Completing fresh Swiggy signup for ${phone} as "${signupName}" (${signupEmail})...`);

      let signupResult = null;
      try {
        signupResult = await safeEvaluate(page, async (mobileNumber, otpCode, name, email, waf) => {
          try {
            const headers = {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            };
            if (waf) headers['aws-waf-token'] = waf;
            const res = await fetch('https://www.swiggy.com/dapi/auth/signup', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                mobile: mobileNumber,
                otp: otpCode,
                name,
                email
              }),
              credentials: 'include',
              signal: AbortSignal.timeout(8000)
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, data };
          } catch (err) {
            return { status: 500, error: err.message };
          }
        }, phone, cleanOtp, signupName, signupEmail, wafToken);
      } catch (signupErr) {
        console.log('[SwiggyBridge] Signup evaluation error:', signupErr.message);
      }

      console.log('[SwiggyBridge] Signup raw result:', JSON.stringify(signupResult));
      if (signupResult?.status === 200 && (signupResult?.data?.statusCode === 0 || !signupResult?.data?.statusCode)) {
        verifyResult = signupResult;
        statusCode = 0;
        statusMsg = 'done successfully';
        isSuccess = true;
      } else {
        const errMessage = signupResult?.data?.statusMessage || 'Invalid or expired Signup OTP';
        return {
          success: false,
          swiggyStatus: errMessage,
          message: errMessage
        };
      }
    }

    await new Promise(r => setTimeout(r, 700));
    const cookies = await page.cookies();
    const isReallyLoggedIn = checkLoggedInFromCookies(cookies);

    if (!isSuccess && !isReallyLoggedIn) {
      if (session.safetyTimer) clearTimeout(session.safetyTimer);
      session.safetyTimer = setTimeout(() => {
        if (activeSessions[userId]?.phone === phone) {
          activeSessions[userId].browser?.close().catch(() => {});
          delete activeSessions[userId];
        }
      }, 180000);

      const errReason = statusMsg || verifyResult?.error || (verifyResult?.status === 429 ? 'Maximum OTP verification attempts exceeded' : 'Invalid or expired OTP');
      return {
        success: false,
        swiggyStatus: errReason,
        message: errReason
      };
    }

    if (session.safetyTimer) {
      clearTimeout(session.safetyTimer);
    }

    const swiggyActualName = (verifyResult?.data?.data?.name || session.targetAccName || '').trim();
    const swiggyEmail = verifyResult?.data?.data?.email || session.signupEmail || '';
    const rawSlot = session.targetAccName && /^user\s*\d+$/i.test(session.targetAccName.trim())
      ? session.targetAccName.trim()
      : getNextAutoUserName();
    const cleanActual = swiggyActualName.replace(/\([^)]*\)/g, '').trim();
    const finalName = cleanActual ? `${cleanActual} (${rawSlot})` : rawSlot;
    const accKey = targetAcc || `acc_${phone}`;

    const tidCookie = cookies.find(c => c.name === 'tid');
    const sidCookie = cookies.find(c => c.name === '_sid');
    const deviceCookie = cookies.find(c => c.name === '_device_id');
    const tokenCookie = cookies.find(c => c.name === 'token');
    const jwtPayload = decodeJwtPayload(tidCookie?.value);
    const customerId = (jwtPayload && jwtPayload.user_id && jwtPayload.user_id !== '0')
      ? jwtPayload.user_id
      : (verifyResult?.data?.data?.user_id || verifyResult?.data?.data?.id || 'RegisteredUser');

    const fullCookieStr = cleanEssentialSwiggyCookies(
      cookies.map(c => `${c.name}=${c.value}`).join('; '),
      { tid: tidCookie?.value || '', sid: sidCookie?.value || '', deviceId: deviceCookie?.value || '', token: tokenCookie?.value || '' }
    );

    console.log(`[SwiggyBridge] Auto-claiming 50 off on 199 for Breakfast & Late Night offers on ${phone}...`);
    const offersResult = await claimSwiggyBreakfastAndLateNightOffers({
      phone,
      token: tokenCookie?.value || '',
      tid: tidCookie?.value || '',
      cookies: fullCookieStr
    });

    const savedData = {
      name: finalName,
      swiggyName: cleanActual || '',
      botTag: rawSlot,
      email: swiggyEmail,
      phone,
      mobile: phone,
      customerId,
      tid: tidCookie?.value || '',
      sid: sidCookie?.value || '',
      deviceId: deviceCookie?.value || '',
      token: tokenCookie?.value || tidCookie?.value || '',
      isLoggedIn: true,
      cookies: fullCookieStr,
      offers: offersResult,
      savedAt: new Date().toISOString()
    };

    updateAccount(accKey, savedData);

    await browser.close().catch(() => {});
    delete activeSessions[userId];

    // Full 100% session code including complete Swiggy auth `cookies`
    const exportJson = {
      account: accKey,
      name: finalName,
      swiggyName: cleanActual || '',
      botTag: rawSlot,
      mobile: phone,
      phone,
      customerId,
      token: savedData.token,
      tid: savedData.tid,
      sid: savedData.sid,
      deviceId: savedData.deviceId,
      cookies: fullCookieStr,
      savedAt: savedData.savedAt
    };

    return {
      success: true,
      isNewUser: false,
      name: finalName,
      swiggyName: cleanActual || '',
      botTag: rawSlot,
      accountKey: accKey,
      phone,
      customerId,
      offers: offersResult,
      exportJson,
      message: verifyResult?.data?.statusMessage || 'done successfully',
      swiggyStatus: verifyResult?.data?.statusMessage || 'done successfully'
    };
  } catch (err) {
    return {
      success: false,
      isNewUser: false,
      swiggyStatus: err.message,
      message: `System Error: ${err.message}`
    };
  }
}

export async function signupSwiggyViaBridge(userId, enteredName) {
  const session = activeSessions[userId];
  if (!session || !session.otp) {
    return { success: false, message: 'Session expired. Please enter phone number again.' };
  }

  const { browser, page, phone, otp } = session;
  const cleanName = sanitizeSwiggyName(enteredName);
  const signupEmail = session.signupEmail || generateUniqueSwiggyEmail(phone, cleanName);
  const accKey = session.targetAcc || `acc_${phone}`;

  try {
    const pageCookies = await page.cookies();
    const wafCookie = pageCookies.find(c => c.name === 'aws-waf-token');
    const wafToken = wafCookie?.value || '';

    const signupResult = await safeEvaluate(page, async (mobileNumber, otpCode, name, email, waf) => {
      try {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        };
        if (waf) headers['aws-waf-token'] = waf;
        const res = await fetch('https://www.swiggy.com/dapi/auth/signup', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            mobile: mobileNumber,
            otp: otpCode,
            name,
            email
          }),
          credentials: 'include'
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
      } catch (err) {
        return { status: 500, error: err.message };
      }
    }, phone, otp, cleanName, signupEmail, wafToken);

    await new Promise(r => setTimeout(r, 1500));

    const cookies = await page.cookies();
    const isReallyLoggedIn = checkLoggedInFromCookies(cookies);

    if (
      isReallyLoggedIn ||
      (signupResult?.status === 200 && signupResult?.data?.statusCode === 0)
    ) {
      const tidCookie = cookies.find(c => c.name === 'tid');
      const sidCookie = cookies.find(c => c.name === '_sid');
      const deviceCookie = cookies.find(c => c.name === '_device_id');
      const tokenCookie = cookies.find(c => c.name === 'token');
      const jwtPayload = decodeJwtPayload(tidCookie?.value);
      const customerId = (jwtPayload && jwtPayload.user_id && jwtPayload.user_id !== '0')
        ? jwtPayload.user_id
        : (signupResult?.data?.data?.user_id || signupResult?.data?.data?.id || 'RegisteredUser');

      const fullCookieStr = cleanEssentialSwiggyCookies(
        cookies.map(c => `${c.name}=${c.value}`).join('; '),
        { tid: tidCookie?.value || '', sid: sidCookie?.value || '', deviceId: deviceCookie?.value || '', token: tokenCookie?.value || '' }
      );

      const offersResult = await claimSwiggyBreakfastAndLateNightOffers({
        phone,
        token: tokenCookie?.value || '',
        tid: tidCookie?.value || '',
        cookies: fullCookieStr
      });

      const savedData = {
        name: cleanName,
        swiggyName: cleanName,
        phone,
        mobile: phone,
        customerId,
        tid: tidCookie?.value || '',
        sid: sidCookie?.value || '',
        deviceId: deviceCookie?.value || '',
        token: tokenCookie?.value || tidCookie?.value || '',
        isLoggedIn: true,
        cookies: fullCookieStr,
        offers: offersResult,
        savedAt: new Date().toISOString()
      };

      updateAccount(accKey, savedData);

      await browser.close().catch(() => {});
      delete activeSessions[userId];

      const exportJson = {
        account: accKey,
        name: cleanName,
        swiggyName: cleanName,
        mobile: phone,
        phone,
        customerId,
        token: savedData.token,
        tid: savedData.tid,
        sid: savedData.sid,
        deviceId: savedData.deviceId,
        cookies: fullCookieStr,
        savedAt: savedData.savedAt
      };

      return {
        success: true,
        name: cleanName,
        swiggyName: cleanName,
        accountKey: accKey,
        phone,
        customerId,
        offers: offersResult,
        exportJson,
        message: 'Swiggy account created and logged in successfully!'
      };
    } else {
      const errorMsg =
        signupResult?.data?.statusMessage ||
        signupResult?.error ||
        'Failed to signup on Swiggy';
      return { success: false, message: errorMsg };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Closes any open browser session cleanly without destroying exported tokens unless revokeRemote = true
export async function deactivateSwiggyAccountViaBridge(userId, targetAcc, revokeRemote = false) {
  const session = activeSessions[userId];
  if (session) {
    try {
      if (session.safetyTimer) clearTimeout(session.safetyTimer);
      if (session.browser) {
        await session.browser.close().catch(() => {});
      }
    } catch (e) {}
    delete activeSessions[userId];
  }
  delete activeDeleteSessions[userId];

  if (revokeRemote) {
    try {
      const { getDb } = await import('./store.js');
      const db = getDb();
      const acc = db.config?.accounts?.[targetAcc];
      const cleanCk = stripStaleWafCookie(acc?.cookies || '');
      if (cleanCk) {
        await fetch('https://www.swiggy.com/dapi/auth/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            'Cookie': cleanCk
          },
          body: '{}',
          signal: AbortSignal.timeout(3000)
        }).catch(() => {});
      }
    } catch (e) {}
  }

  return true;
}
