import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { updateAccount, getNextAutoUserName } from './store.js';

function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  const linuxPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];
  for (const p of linuxPaths) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return '/usr/bin/chromium';
}

const CHROME_PATH = findChromePath();
const IS_LINUX = process.platform === 'linux';
const HEADLESS_MODE = IS_LINUX ? true : false;

// Active login sessions keyed by userId: { [userId]: { browser, page, phone, otp, targetAcc, isNewUser } }
const activeSessions = {};
// Dedicated in-memory session map for Swiggy account deletions (strictly isolated from login)
const activeDeleteSessions = {};
let deleteOtpRequestCount = 0;
let deleteVerifyRequestCount = 0;

// Pre-warmed browser pool for instantaneous (<1s) OTP dispatch
let prewarmedBrowser = null;
let prewarmedPage = null;
let isPrewarming = false;

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
  let cleaned = String(name).replace(/[^a-zA-Z\s]/g, '').trim();
  if (cleaned.length < 3 || /^user\s*\d*$/i.test(cleaned)) {
    return 'Rahul Kumar';
  }
  return cleaned;
}

// Helper to check if cookies or account contain a verified logged-in user
export function checkLoggedInFromCookies(input) {
  if (!input) return false;
  let tidValue = '';

  if (typeof input === 'object' && !Array.isArray(input)) {
    if (input.tid) {
      tidValue = input.tid;
    } else if (input.cookies) {
      input = input.cookies;
    }
  }

  if (Array.isArray(input)) {
    const tidCookie = input.find(c => c && c.name === 'tid');
    tidValue = tidCookie?.value || '';
  } else if (typeof input === 'string') {
    const match = input.match(/(?:^|;\s*)tid=([^;]+)/);
    if (match) tidValue = decodeURIComponent(match[1]);
    else if (input.includes('.') && input.length > 50) tidValue = input;
  }

  if (!tidValue) return false;
  const payload = decodeJwtPayload(tidValue);
  return Boolean(payload && payload.user_id && payload.user_id !== '0' && payload.user_id !== '-1');
}

// ---------------------------------------------------------------------------
// Auto-claim Swiggy Event Offers:
// 1. Breakfast Morning (6 AM To 11 AM) - https://events.swiggy.com/book-your-offer
// 2. Dinner Late Night Offer (9 PM To 11 PM) - https://events.swiggy.com/pick-your-late-night-offer
// Automatically selects 50 off on 199 (value: 1)
// ---------------------------------------------------------------------------
export async function claimSwiggyBreakfastAndLateNightOffers(account) {
  if (!account) return { success: false, reason: 'No account provided' };

  let token = account.token;
  let jwtTid = account.tid;
  const cookieStr = account.cookies || '';

  if (cookieStr) {
    const tidCookie = cookieStr.split(';').map(s => s.trim()).find(s => s.startsWith('tid='));
    if (tidCookie) {
      jwtTid = tidCookie.split('=')[1];
    }
    if (!token) {
      const tokCookie = cookieStr.split(';').map(s => s.trim()).find(s => s.startsWith('token='));
      if (tokCookie) {
        token = tokCookie.split('=')[1];
      }
    }
  }

  if (!token || !jwtTid) {
    return { success: false, reason: 'Missing Swiggy token or JWT tid' };
  }

  let bfCampaign = 'byo-bf-v10-14';
  let lnCampaign = 'byo-ln-v5-14';

  try {
    const [bfRes, lnRes] = await Promise.all([
      fetch('https://events.swiggy.com/book-your-offer?utm_source=app&utm_medium=share', { signal: AbortSignal.timeout(4000) }),
      fetch('https://events.swiggy.com/pick-your-late-night-offer?utm_source=app&utm_medium=share', { signal: AbortSignal.timeout(4000) })
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

  const headers = {
    'Content-Type': 'application/json',
    'token': token,
    'tid': jwtTid,
    'Cookie': cookieStr,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  try {
    const [resBf, resLn] = await Promise.all([
      fetch('https://events.swiggy.com/api/notify', {
        method: 'POST',
        headers,
        body: JSON.stringify({ campaign: bfCampaign, value: 1 })
      }),
      fetch('https://events.swiggy.com/api/notify', {
        method: 'POST',
        headers,
        body: JSON.stringify({ campaign: lnCampaign, value: 1 })
      })
    ]);

    const bfJson = await resBf.json().catch(() => ({}));
    const lnJson = await resLn.json().catch(() => ({}));

    console.log(`[EventsClaim] Account ${account.phone || account.name || 'User'} result:`, {
      breakfast: { campaign: bfCampaign, status: resBf.status, msg: bfJson.message },
      lateNight: { campaign: lnCampaign, status: resLn.status, msg: lnJson.message }
    });

    return {
      success: resBf.ok || resLn.ok,
      breakfast: {
        name: 'Breakfast Morning (6AM-11AM)',
        campaign: bfCampaign,
        status: resBf.ok ? 'CLAIMED' : 'FAILED',
        discount: '₹50 OFF on ₹199',
        message: bfJson.message || (resBf.ok ? 'Subscribed' : `HTTP ${resBf.status}`)
      },
      lateNight: {
        name: 'Dinner Late Night (9PM-11PM)',
        campaign: lnCampaign,
        status: resLn.ok ? 'CLAIMED' : 'FAILED',
        discount: '₹50 OFF on ₹199',
        message: lnJson.message || (resLn.ok ? 'Subscribed' : `HTTP ${resLn.status}`)
      }
    };
  } catch (err) {
    console.error('[EventsClaim] Request error:', err.message);
    return { success: false, error: err.message };
  }
}

// Pre-warm browser in background so when user asks for OTP, it fires instantly
export async function prewarmBrowser() {
  if (isPrewarming || (prewarmedPage && prewarmedBrowser?.connected)) return;
  isPrewarming = true;

  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: HEADLESS_MODE,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(IS_LINUX ? [] : ['--window-position=-32000,-32000']),
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
    await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Wait until AWS WAF challenge solves and token is issued
    for (let i = 0; i < 20; i++) {
      const cookies = await page.cookies();
      const waf = cookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 800));
    }

    // Wait for WAF post-reload to settle down
    await new Promise(r => setTimeout(r, 2000));

    prewarmedBrowser = browser;
    prewarmedPage = page;
    console.log('⚡ [SwiggyBridge] Pre-warmed Chrome is primed on swiggy.com! Next OTP will fire in <1s.');
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

// Safe evaluate that handles "Execution context was destroyed" gracefully
async function safeEvaluate(page, fn, ...args) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (err) {
      if (
        err.message.includes('Execution context was destroyed') ||
        err.message.includes('Cannot find context') ||
        err.message.includes('target closed')
      ) {
        console.log(`[SwiggyBridge] Context navigating/reloaded, waiting for page to settle (attempt ${attempt + 1}/4)...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Navigation in progress, please retry.');
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
      message: 'Swiggy Anti-Bot Protection (AWS WAF): Swiggy security firewall ne browser request ko verify nahi hone diya. Kripya Session JSON se bina OTP ke turant login karein.',
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
    message: `Swiggy API Error: OTP deliver nahi ho paya (HTTP ${status || 'unknown'}). Kripya Session JSON se login karein.`,
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

  // Check if we already have an active warm session waiting for name for this user and phone
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
    // Close previous session for this user if any
    if (activeSessions[userId]) {
      try {
        if (activeSessions[userId].safetyTimer) clearTimeout(activeSessions[userId].safetyTimer);
        await activeSessions[userId].browser.close();
      } catch (e) {}
      delete activeSessions[userId];
    }

    // Use prewarmed instance if available for instant OTP
    if (prewarmedPage && prewarmedBrowser?.connected) {
      browser = prewarmedBrowser;
      page = prewarmedPage;
      prewarmedBrowser = null;
      prewarmedPage = null;
      console.log(`⚡ [SwiggyBridge] Using primed Chrome for instantaneous OTP to ${cleanPhone}...`);
    } else {
      // Launch fresh
      browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: HEADLESS_MODE,
        args: [
          '--disable-blink-features=AutomationControlled',
          ...(IS_LINUX ? [] : ['--window-position=-32000,-32000']),
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
      await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

      // Wait for WAF token
      for (let i = 0; i < 20; i++) {
        const cookies = await page.cookies();
        const waf = cookies.find(c => c.name === 'aws-waf-token');
        if (waf && waf.value.length > 50) break;
        await new Promise(r => setTimeout(r, 600));
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  try {
    const pageCookies = await page.cookies();
    const wafCookie = pageCookies.find(c => c.name === 'aws-waf-token');
    const wafToken = wafCookie?.value || '';

    // If session was already warm and verified unregistered, directly proceed to signup!
    let otpResult;
    if (isReused && targetAccName) {
      console.log(`⚡ [SwiggyBridge] Fast-path: Directly initiating signup with provided name "${targetAccName}"...`);
      otpResult = { status: 200, data: { statusCode: 1, statusMessage: 'not registered' } };
    } else {
      // Request SMS OTP inside browser context (with dual endpoint fallback)
      otpResult = await safeEvaluate(page, async (mobileNumber, waf) => {
        try {
          const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': navigator.userAgent
          };
          if (waf) headers['aws-waf-token'] = waf;

          // Attempt 1: Standard sms-otp endpoint
          let res = await fetch('/dapi/auth/sms-otp', {
            method: 'POST',
            headers,
            body: JSON.stringify({ mobile: mobileNumber }),
            credentials: 'include'
          });

          let rawText = await res.text().catch(() => '');
          let data = {};
          try { data = JSON.parse(rawText); } catch (e) {}

          // Attempt 2: If primary endpoint returned non-200 or 404, try otp-generate
          if ((res.status !== 200 && res.status !== 202) || (data.statusCode && data.statusCode !== 0 && data.statusCode !== 1)) {
            try {
              const altRes = await fetch('/dapi/auth/otp-generate', {
                method: 'POST',
                headers,
                body: JSON.stringify({ mobile: mobileNumber }),
                credentials: 'include'
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

    const isUnregistered = otpResult.data?.statusCode === 1 && (
      otpResult.data?.statusMessage?.toLowerCase().includes('not registered') ||
      otpResult.data?.statusMessage?.toLowerCase().includes('new user') ||
      otpResult.data?.statusMessage?.toLowerCase().includes('user not found')
    );

    if (isUnregistered) {
      // Check if a real human name was provided by the user
      const hasRealName = targetAccName && !/^user\s*\d*$/i.test(targetAccName.trim()) && targetAccName.trim().length >= 3;
      if (!hasRealName) {
        console.log(`[SwiggyBridge] Number ${cleanPhone} is not registered on Swiggy. Keeping browser warm and requesting user's name.`);
        const safetyTimer = setTimeout(() => {
          if (activeSessions[userId]?.needsName) {
            console.log(`[SwiggyBridge] Session for ${cleanPhone} timed out waiting for name. Closing browser.`);
            activeSessions[userId].browser?.close().catch(() => {});
            delete activeSessions[userId];
          }
        }, 120000);

        activeSessions[userId] = {
          browser,
          page,
          phone: cleanPhone,
          targetAcc: targetAcc || `acc_${cleanPhone}`,
          needsName: true,
          safetyTimer
        };

        return {
          success: false,
          needsName: true,
          phone: cleanPhone,
          message: 'New number on Swiggy. Please provide a name to create account.'
        };
      }

      const signupName = sanitizeSwiggyName(targetAccName);
      console.log(`[SwiggyBridge] Number ${cleanPhone} is not registered on Swiggy. Triggering authentic signup OTP with name "${signupName}" via /dapi/auth/signup...`);
      const signupInitResult = await safeEvaluate(page, async (mobileNumber, name, waf) => {
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
              name: name,
              email: `${mobileNumber}@gmail.com`
            }),
            credentials: 'include'
          });
          const text = await res.text().catch(() => '');
          let data = {};
          try { data = JSON.parse(text); } catch (e) {}
          return { status: res.status, data, rawText: text };
        } catch (err) {
          return { status: 500, error: err.message };
        }
      }, cleanPhone, signupName, wafToken);

      console.log('[SwiggyBridge] Signup dispatch raw result:', JSON.stringify(signupInitResult));
      const signupSent = (signupInitResult.status === 200 || signupInitResult.status === 202) && (
        signupInitResult.data?.statusCode === 0 || !signupInitResult.data?.statusCode
      );

      if (signupSent) {
        activeSessions[userId] = {
          browser,
          page,
          phone: cleanPhone,
          targetAcc: targetAcc || `acc_${cleanPhone}`,
          targetAccName: signupName,
          isNewUser: true,
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
        setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
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
      setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
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
    setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
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

  // Clear previous deletion session for this user
  delete activeDeleteSessions[userId];

  const { getDb } = await import('./store.js');
  const db = getDb();
  let acc = db.config?.accounts?.[targetAcc];

  // We need cookies to access the account's settings
  let cookieString = acc?.cookies || '';
  if (!cookieString && cleanPhone) {
    // Check all accounts matching phone
    for (const [k, a] of Object.entries(db.config?.accounts || {})) {
      if ((a.phone === cleanPhone || k === `acc_${cleanPhone}`) && a.cookies) {
        cookieString = a.cookies;
        acc = a;
        targetAcc = k;
        break;
      }
    }
  }

  if (!cookieString) {
    return {
      success: false,
      message: 'Account session cookies not found. Please log in first.'
    };
  }

  // 1. Verify the selected account is genuinely authenticated before accessing Settings -> Delete Account
  const isAuth = checkLoggedInFromCookies(cookieString) || checkLoggedInFromCookies(acc);
  if (!isAuth) {
    return {
      success: false,
      isAuthError: true,
      message: 'Selected account session is not authenticated or has expired. Please log in first to access Settings → Delete Account.'
    };
  }

  deleteOtpRequestCount++;
  const reqNum = deleteOtpRequestCount;
  const maskedPhone = cleanPhone.length >= 4 ? '******' + cleanPhone.slice(-4) : '***';
  console.log(`[SwiggyDelete] [Request #${reqNum}] Triggering authentic Delete OTP: GET https://www.swiggy.com/mapi/auth/delete/userCheck | Target: ${targetAcc} | Phone: ${maskedPhone}`);

  try {
    const res = await fetch('https://www.swiggy.com/mapi/auth/delete/userCheck', {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json',
        'Referer': 'https://www.swiggy.com/my-account/settings',
        'Origin': 'https://www.swiggy.com'
      }
    });

    const data = await res.json().catch(() => ({}));
    console.log(`[SwiggyDelete] [Request #${reqNum}] Response: HTTP ${res.status} | SwiggyCode: ${data.statusCode ?? 'none'} | Message: ${data.statusMessage || data.error || 'ok'}`);

    // Swiggy returns { statusCode: 28, statusMessage: "Archive OTP Sent", tid: "...", csrfToken: "..." }
    const isSent = res.status === 200 && (data.statusCode === 28 || data.statusCode === 0);

    if (!isSent) {
      const isAuthError = res.status === 401 || res.status === 403 || data.statusCode === 1 || (data.statusMessage && data.statusMessage.toLowerCase().includes('login'));
      const errMsg = isAuthError
        ? 'Swiggy session has expired. Please log in first to access Settings → Delete Swiggy Account.'
        : (data.statusMessage || data.error || `Swiggy returned status ${res.status} (code ${data.statusCode || 'unknown'})`);
      return {
        success: false,
        isAuthError,
        message: errMsg,
        swiggyStatus: errMsg
      };
    }

    // Keep deletion session active for OTP verification
    activeDeleteSessions[userId] = {
      accountKey: targetAcc,
      phone: cleanPhone,
      tid: data.tid || '',
      csrfToken: data.csrfToken || '',
      sid: data.sid || '',
      deviceId: data.deviceId || '',
      cookies: cookieString,
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
  const cookieString = session?.cookies || acc?.cookies || '';
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
  console.log(`[SwiggyDelete] [Verify #${reqNum}] Verifying Delete OTP: POST https://www.swiggy.com/mapi/auth/delete/user | Target: ${accountKey} | Phone: ${maskedPhone}`);

  try {
    const postHeaders = {
      'Cookie': cookieString + (tid ? `; tid=${tid}` : '') + (csrfToken ? `; _csrf=${csrfToken}` : ''),
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.swiggy.com',
      'Referer': 'https://www.swiggy.com/my-account/settings'
    };

    const res = await fetch('https://www.swiggy.com/mapi/auth/delete/user', {
      method: 'POST',
      headers: postHeaders,
      body: JSON.stringify({ otp: cleanOtp, _csrf: csrfToken })
    });

    const verifyResult = await res.json().catch(() => ({}));
    console.log(`[SwiggyDelete] [Verify #${reqNum}] Response: HTTP ${res.status} | SwiggyCode: ${verifyResult.statusCode ?? 'none'} | Message: ${verifyResult.statusMessage || verifyResult.error || 'ok'}`);

    if (!verifyResult || verifyResult.error) {
      return {
        success: false,
        message: verifyResult?.error || 'Failed to communicate with Swiggy servers. Please try again.'
      };
    }

    // Error Code 29: Invalid OTP (Keep session active for retry)
    if (verifyResult.statusCode === 29) {
      return {
        success: false,
        message: verifyResult.statusMessage || 'Invalid OTP. Please check and re-enter.'
      };
    }

    // Check for Swiggy deletion blockers:
    // 25: Pending cancellation charges
    // 26: Ongoing order
    // 34: Active Swiggy Money wallet
    if (verifyResult.statusCode === 25) {
      delete activeDeleteSessions[userId];
      return {
        success: false,
        message: 'You have pending cancellation charges. Please clear them first on Swiggy.'
      };
    }
    if (verifyResult.statusCode === 26) {
      delete activeDeleteSessions[userId];
      return {
        success: false,
        message: 'You have an ongoing order. Please try after delivery.'
      };
    }
    if (verifyResult.statusCode === 34) {
      delete activeDeleteSessions[userId];
      return {
        success: false,
        message: 'Cannot delete: active Swiggy Money wallet exists.'
      };
    }

    // Swiggy Authentic Deletion Success Code: 33 (DELETE_USER) or 0 or 200
    const isSuccess = (verifyResult.statusCode === 33 || verifyResult.statusCode === 0 || (res.status === 200 && verifyResult.statusCode === undefined));

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
            credentials: 'include'
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

    let statusCode = verifyResult?.data?.statusCode;
    let statusMsg = (verifyResult?.data?.statusMessage || '').trim();
    let isSuccess = (verifyResult?.status === 200 || verifyResult?.status === 202) && statusCode === 0;

    // Check if genuinely not registered / new user on Swiggy
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
          console.log(`[SwiggyBridge] Session for ${phone} expired after OTP retry window. Closing browser.`);
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
      console.log(`[SwiggyBridge] Unregistered number ${phone} detected during verify. Attempting auto-signup via bridge...`);
      const signupName = sanitizeSwiggyName(session.targetAccName);
      let signupResult = null;
      try {
        signupResult = await safeEvaluate(page, async (mobileNumber, otpCode, name, waf) => {
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
                name: name,
                email: `${mobileNumber}@gmail.com`
              }),
              credentials: 'include'
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, data };
          } catch (err) {
            return { status: 500, error: err.message };
          }
        }, phone, cleanOtp, signupName, wafToken);
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
        session.otp = cleanOtp;
        session.isNewUser = true;
        return {
          success: false,
          isNewUser: true,
          phone,
          message: signupResult?.data?.statusMessage || 'Number is not registered on Swiggy.'
        };
      }
    }

    // Wait 500ms for cookies to register
    await new Promise(r => setTimeout(r, 500));
    const cookies = await page.cookies();
    const isReallyLoggedIn = checkLoggedInFromCookies(cookies);

    if (!isSuccess && !isReallyLoggedIn) {
      if (session.safetyTimer) clearTimeout(session.safetyTimer);
      session.safetyTimer = setTimeout(() => {
        if (activeSessions[userId]?.phone === phone) {
          console.log(`[SwiggyBridge] Session for ${phone} expired after OTP retry window. Closing browser.`);
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

    // Extract authentic profile name from Swiggy's response
    const swiggyActualName = (verifyResult?.data?.data?.name || '').trim();
    const swiggyEmail = verifyResult?.data?.data?.email || '';
    const autoTag = session.targetAccName || getNextAutoUserName();
    // Display name combines authentic Swiggy name with bot slot tag so user is never misled
    const finalName = swiggyActualName ? `${swiggyActualName} (${autoTag})` : autoTag;
    const accKey = targetAcc || `acc_${phone}`;

    const tidCookie = cookies.find(c => c.name === 'tid');
    const sidCookie = cookies.find(c => c.name === '_sid');
    const deviceCookie = cookies.find(c => c.name === '_device_id');
    const tokenCookie = cookies.find(c => c.name === 'token');
    const jwtPayload = decodeJwtPayload(tidCookie?.value);
    const customerId = (jwtPayload && jwtPayload.user_id && jwtPayload.user_id !== '0')
      ? jwtPayload.user_id
      : (verifyResult?.data?.data?.user_id || verifyResult?.data?.data?.id || 'RegisteredUser');

    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Auto-claim real Swiggy Breakfast (6am-11am) & Late Night (9pm-11pm) event offers (50 off on 199)
    console.log(`[SwiggyBridge] Auto-claiming 50 off on 199 for Breakfast & Late Night offers on ${phone}...`);
    const offersResult = await claimSwiggyBreakfastAndLateNightOffers({
      phone,
      token: tokenCookie?.value || '',
      tid: tidCookie?.value || '',
      cookies: cookieStr
    });

    const savedData = {
      name: finalName,
      swiggyName: swiggyActualName || '',
      botTag: autoTag,
      email: swiggyEmail,
      phone,
      mobile: phone,
      customerId,
      tid: tidCookie?.value || '',
      sid: sidCookie?.value || '',
      deviceId: deviceCookie?.value || '',
      token: tokenCookie?.value || tidCookie?.value || '',
      isLoggedIn: true,
      cookies: cookieStr,
      offers: offersResult,
      savedAt: new Date().toISOString()
    };

    updateAccount(accKey, savedData);

    await browser.close().catch(() => {});
    delete activeSessions[userId];

    const exportJson = {
      account: accKey,
      name: finalName,
      swiggyName: swiggyActualName || '',
      botTag: autoTag,
      mobile: phone,
      phone,
      customerId,
      token: savedData.token,
      tid: savedData.tid,
      sid: savedData.sid,
      deviceId: savedData.deviceId,
      savedAt: savedData.savedAt
    };

    return {
      success: true,
      isNewUser: false,
      name: finalName,
      swiggyName: swiggyActualName || '',
      botTag: autoTag,
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

// Signs up a new unregistered phone number on Swiggy with the user's name
export async function signupSwiggyViaBridge(userId, enteredName) {
  const session = activeSessions[userId];
  if (!session || !session.otp) {
    return { success: false, message: 'Session expired. Please enter phone number again.' };
  }

  const { browser, page, phone, otp } = session;
  const cleanName = String(enteredName).trim();
  const accKey = session.targetAcc || `acc_${phone}`;

  try {
    const pageCookies = await page.cookies();
    const wafCookie = pageCookies.find(c => c.name === 'aws-waf-token');
    const wafToken = wafCookie?.value || '';

    const signupResult = await safeEvaluate(page, async (mobileNumber, otpCode, name, waf) => {
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
            name: name,
            email: `${mobileNumber}@swiggyorder.in`
          }),
          credentials: 'include'
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
      } catch (err) {
        return { status: 500, error: err.message };
      }
    }, phone, otp, cleanName, wafToken);

    await new Promise(r => setTimeout(r, 2000));

    const cookies = await page.cookies();
    const isReallyLoggedIn = checkLoggedInFromCookies(cookies);

    if (
      isReallyLoggedIn ||
      (signupResult?.status === 200 && signupResult?.data?.statusCode === 0)
    ) {
      const tidCookie = cookies.find(c => c.name === 'tid');
      const sidCookie = cookies.find(c => c.name === '_sid');
      const deviceCookie = cookies.find(c => c.name === '_device_id');
      const jwtPayload = decodeJwtPayload(tidCookie?.value);
      const customerId = (jwtPayload && jwtPayload.user_id && jwtPayload.user_id !== '0')
        ? jwtPayload.user_id
        : (signupResult?.data?.data?.user_id || signupResult?.data?.data?.id || 'RegisteredUser');

      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      // Auto-claim real Swiggy Breakfast (6am-11am) & Late Night (9pm-11pm) event offers (50 off on 199)
      console.log(`[SwiggyBridge] Auto-claiming 50 off on 199 for Breakfast & Late Night offers on ${phone}...`);
      const tokenCookie = cookies.find(c => c.name === 'token');
      const offersResult = await claimSwiggyBreakfastAndLateNightOffers({
        phone,
        token: tokenCookie?.value || '',
        tid: tidCookie?.value || '',
        cookies: cookieStr
      });
      const savedData = {
        name: cleanName,
        phone,
        mobile: phone,
        customerId,
        tid: tidCookie?.value || '',
        sid: sidCookie?.value || '',
        deviceId: deviceCookie?.value || '',
        token: tokenCookie?.value || tidCookie?.value || '',
        isLoggedIn: true,
        cookies: cookieStr,
        offers: offersResult,
        savedAt: new Date().toISOString()
      };

      updateAccount(accKey, savedData);

      await browser.close().catch(() => {});
      delete activeSessions[userId];

      const exportJson = {
        account: accKey,
        name: cleanName,
        mobile: phone,
        phone,
        customerId,
        token: savedData.token,
        tid: savedData.tid,
        sid: savedData.sid,
        deviceId: savedData.deviceId,
        savedAt: savedData.savedAt
      };

      return {
        success: true,
        name: cleanName,
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

export async function deactivateSwiggyAccountViaBridge(userId, targetAcc) {
  // 1. Close any active browser login session for this user
  const session = activeSessions[userId];
  if (session) {
    try {
      if (session.page) {
        const cookies = await session.page.cookies().catch(() => []);
        const waf = cookies.find(c => c.name === 'aws-waf-token')?.value || '';
        await safeEvaluate(session.page, async (wafToken) => {
          const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
          if (wafToken) headers['aws-waf-token'] = wafToken;
          await fetch('https://www.swiggy.com/dapi/auth/logout', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
            credentials: 'include'
          }).catch(() => {});
        }, waf).catch(() => {});
      }
      if (session.browser) {
        await session.browser.close().catch(() => {});
      }
    } catch (e) {}
    delete activeSessions[userId];
  }
  delete activeDeleteSessions[userId];

  // 2. Terminate session on Swiggy via direct HTTPS request using saved cookies
  try {
    const { getDb } = await import('./store.js');
    const db = getDb();
    const acc = db.config?.accounts?.[targetAcc];
    if (acc && acc.cookies) {
      const https = (await import('https')).default;
      await new Promise((resolve) => {
        const req = https.request({
          hostname: 'www.swiggy.com',
          port: 443,
          path: '/dapi/auth/logout',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            'Cookie': acc.cookies
          },
          timeout: 3000
        }, res => {
          res.resume();
          resolve();
        });
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write('{}');
        req.end();
      });
    }
  } catch (e) {}

  return true;
}

