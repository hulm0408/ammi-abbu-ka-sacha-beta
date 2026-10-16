import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { updateAccount } from './store.js';

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

// Active login sessions keyed by userId: { [userId]: { browser, page, phone, otp, targetAcc, isNewUser } }
const activeSessions = {};

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

// Helper to check if cookies contain a verified logged-in user
export function checkLoggedInFromCookies(cookies) {
  const tidCookie = cookies.find(c => c.name === 'tid');
  if (!tidCookie) return false;
  const payload = decodeJwtPayload(tidCookie.value);
  return Boolean(payload && payload.user_id && payload.user_id !== '0');
}

// Pre-warm browser in background so when user asks for OTP, it fires instantly
export async function prewarmBrowser() {
  if (isPrewarming || (prewarmedPage && prewarmedBrowser?.connected)) return;
  isPrewarming = true;

  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});

    // Wait until AWS WAF challenge solves and token is issued
    for (let i = 0; i < 20; i++) {
      const cookies = await page.cookies();
      const waf = cookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 800));
    }

    // Allow page to settle after WAF reload
    await new Promise(r => setTimeout(r, 3000));

    prewarmedBrowser = browser;
    prewarmedPage = page;
    console.log('⚡ [SwiggyBridge] Pre-warmed Chrome is primed! Next OTP will fire instantly.');
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

export async function requestSwiggyOtpViaBridge(userId, phone, targetAcc = '') {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);

  if (cleanPhone.length !== 10) {
    return { success: false, message: 'Please enter a valid 10-digit phone number.' };
  }

  // Close previous session for this user if any
  if (activeSessions[userId]) {
    try {
      await activeSessions[userId].browser.close();
    } catch (e) {}
    delete activeSessions[userId];
  }

  let browser;
  let page;

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
      headless: 'new',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    page = await browser.newPage();
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});

    // Wait for WAF token
    for (let i = 0; i < 20; i++) {
      const cookies = await page.cookies();
      const waf = cookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 800));
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  try {
    // Request SMS OTP inside browser context
    const otpResult = await safeEvaluate(page, async (mobileNumber) => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/auth/sms-otp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Referer': 'https://www.swiggy.com/',
            'Origin': 'https://www.swiggy.com'
          },
          body: JSON.stringify({ mobile: mobileNumber })
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
      } catch (err) {
        return { status: 500, error: err.message };
      }
    }, cleanPhone);

    if (otpResult.status === 200 && otpResult.data?.statusCode === 0) {
      activeSessions[userId] = {
        browser,
        page,
        phone: cleanPhone,
        targetAcc: targetAcc || `acc_${cleanPhone}`,
        createdAt: Date.now()
      };

      // Prime the next warm browser in background
      setTimeout(() => prewarmBrowser().catch(() => {}), 1500);

      return { success: true, phone: cleanPhone, message: 'OTP sent successfully!' };
    } else {
      await browser.close().catch(() => {});
      const errorMsg = otpResult.data?.statusMessage || otpResult.error || 'Failed to send OTP';
      setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
      return { success: false, message: errorMsg };
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    delete activeSessions[userId];
    setTimeout(() => prewarmBrowser().catch(() => {}), 1000);
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
    let verifyResult = null;

    try {
      verifyResult = await safeEvaluate(page, async (mobileNumber, otpCode) => {
        try {
          const res = await fetch('https://www.swiggy.com/dapi/auth/otp-verify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Referer': 'https://www.swiggy.com/',
              'Origin': 'https://www.swiggy.com'
            },
            body: JSON.stringify({ mobile: mobileNumber, otp: otpCode })
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data };
        } catch (err) {
          return { status: 500, error: err.message };
        }
      }, phone, cleanOtp);
    } catch (evalErr) {
      console.log('[SwiggyBridge] Evaluation error during verify:', evalErr.message);
    }

    // Check if Swiggy indicates this number is not registered on Swiggy
    const isNotRegistered =
      (verifyResult?.data?.statusMessage && verifyResult.data.statusMessage.toLowerCase().includes('not registered')) ||
      (verifyResult?.data?.statusCode === 1 && !verifyResult?.data?.data?.user_id);

    if (isNotRegistered) {
      // Keep session open so user can provide name and signup
      session.otp = cleanOtp;
      session.isNewUser = true;
      return {
        success: false,
        isNewUser: true,
        phone,
        message: 'Number is not registered on Swiggy.'
      };
    }

    // Wait 2s for cookies to update
    await new Promise(r => setTimeout(r, 2000));

    const cookies = await page.cookies();
    const isReallyLoggedIn = checkLoggedInFromCookies(cookies);

    if (
      isReallyLoggedIn ||
      (verifyResult?.status === 200 && verifyResult?.data?.statusCode === 0)
    ) {
      // 1. Fetch authentic profile name directly from Swiggy's /my-account on this page
      let authenticName = null;
      try {
        await page.goto('https://www.swiggy.com/my-account', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        authenticName = await page.evaluate(() => {
          const editBtn = Array.from(document.querySelectorAll('*')).find(e => e.innerText?.trim() === 'EDIT PROFILE');
          if (editBtn && editBtn.parentElement) {
            const lines = editBtn.parentElement.innerText.split('\n').map(s => s.trim()).filter(Boolean);
            if (lines.length >= 2) {
              const name = lines[1] !== 'EDIT PROFILE' ? lines[1] : (lines[0] || null);
              return name;
            }
          }
          return null;
        });
      } catch (err) {
        console.log('[SwiggyBridge] Error reading /my-account name:', err.message);
      }

      const finalName = authenticName || session.targetAccName || `SwiggyUser_${phone.slice(-4)}`;
      const accKey = targetAcc || `acc_${phone}`;

      const tidCookie = cookies.find(c => c.name === 'tid');
      const sidCookie = cookies.find(c => c.name === '_sid');
      const deviceCookie = cookies.find(c => c.name === '_device_id');
      const jwtPayload = decodeJwtPayload(tidCookie?.value);
      const customerId = (jwtPayload && jwtPayload.user_id && jwtPayload.user_id !== '0')
        ? jwtPayload.user_id
        : (verifyResult?.data?.data?.user_id || verifyResult?.data?.data?.id || 'RegisteredUser');

      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      const savedData = {
        name: finalName,
        phone,
        customerId,
        tid: tidCookie?.value || '',
        sid: sidCookie?.value || '',
        deviceId: deviceCookie?.value || '',
        token: tidCookie?.value || '',
        isLoggedIn: true,
        cookies: cookieStr,
        savedAt: new Date().toISOString()
      };

      updateAccount(accKey, savedData);

      await browser.close().catch(() => {});
      delete activeSessions[userId];

      const exportJson = {
        account: accKey,
        name: finalName,
        phone,
        customerId,
        tid: savedData.tid,
        sid: savedData.sid,
        deviceId: savedData.deviceId,
        cookies: cookieStr,
        savedAt: savedData.savedAt
      };

      return {
        success: true,
        isNewUser: false,
        name: finalName,
        accountKey: accKey,
        phone,
        customerId,
        exportJson,
        message: 'Logged in successfully!'
      };
    } else {
      const errorMsg =
        verifyResult?.data?.statusMessage ||
        verifyResult?.error ||
        'Invalid or incorrect OTP';
      return { success: false, isNewUser: false, message: errorMsg };
    }
  } catch (err) {
    return { success: false, isNewUser: false, message: err.message };
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
    const signupResult = await safeEvaluate(page, async (mobileNumber, otpCode, name) => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/auth/signup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Referer': 'https://www.swiggy.com/',
            'Origin': 'https://www.swiggy.com'
          },
          body: JSON.stringify({
            mobile: mobileNumber,
            otp: otpCode,
            name: name,
            email: `${mobileNumber}@swiggyorder.in`
          })
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
      } catch (err) {
        return { status: 500, error: err.message };
      }
    }, phone, otp, cleanName);

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

      const savedData = {
        name: cleanName,
        phone,
        customerId,
        tid: tidCookie?.value || '',
        sid: sidCookie?.value || '',
        deviceId: deviceCookie?.value || '',
        token: tidCookie?.value || '',
        isLoggedIn: true,
        cookies: cookieStr,
        savedAt: new Date().toISOString()
      };

      updateAccount(accKey, savedData);

      await browser.close().catch(() => {});
      delete activeSessions[userId];

      const exportJson = {
        account: accKey,
        name: cleanName,
        phone,
        customerId,
        tid: savedData.tid,
        sid: savedData.sid,
        deviceId: savedData.deviceId,
        cookies: cookieStr,
        savedAt: savedData.savedAt
      };

      return {
        success: true,
        name: cleanName,
        accountKey: accKey,
        phone,
        customerId,
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
