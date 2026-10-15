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

// Active login sessions keyed by userId: { [userId]: { browser, page, phone, targetAcc } }
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
function checkLoggedInFromCookies(cookies) {
  const tidCookie = cookies.find(c => c.name === 'tid');
  if (!tidCookie) return false;
  const payload = decodeJwtPayload(tidCookie.value);
  return Boolean(payload && payload.user_id && payload.user_id !== '0');
}

// Pre-warm browser in background so when user asks for OTP, it fires in < 1 second!
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
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Wait until AWS WAF challenge solves and token is issued
    for (let i = 0; i < 15; i++) {
      const cookies = await page.cookies();
      const waf = cookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 800));
    }

    // Freeze page background timers so it sits ready without refreshing
    await page.evaluate(() => {
      window.stop();
      for (let i = 1; i < 99999; i++) {
        window.clearInterval(i);
        window.clearTimeout(i);
      }
    }).catch(() => {});

    prewarmedBrowser = browser;
    prewarmedPage = page;
    console.log('⚡ [SwiggyBridge] Pre-warmed Chrome is primed! Next OTP will fire in < 1 second.');
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

// Do NOT prewarm on module import - prevents system hang and memory bloat
// prewarmBrowser is called strictly on-demand if needed

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
  throw new Error('Navigation in progress, please retry OTP.');
}

export async function requestSwiggyOtpViaBridge(userId, phone, targetAcc = 'ammi') {
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

  // Use prewarmed instance if available for instant <1s OTP!
  if (prewarmedPage && prewarmedBrowser?.connected) {
    browser = prewarmedBrowser;
    page = prewarmedPage;
    prewarmedBrowser = null;
    prewarmedPage = null;
    console.log(`⚡ [SwiggyBridge] Using primed Chrome for instantaneous OTP to ${cleanPhone}...`);
  } else {
    // Launch fresh if not ready
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
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
  }

  try {
    // Request SMS OTP inside browser context
    const otpResult = await safeEvaluate(page, async (mobileNumber) => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/auth/sms-otp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
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
      // Freeze page background timers so it does not reload while user waits for OTP
      try {
        await page.evaluate(() => {
          window.stop();
          for (let i = 1; i < 99999; i++) {
            window.clearInterval(i);
            window.clearTimeout(i);
          }
        });
      } catch (e) {}

      activeSessions[userId] = {
        browser,
        page,
        phone: cleanPhone,
        targetAcc
      };

      // Prime the next warm browser in background
      setTimeout(() => prewarmBrowser().catch(() => {}), 1000);

      return { success: true, phone: cleanPhone, message: 'OTP sent successfully!' };
    } else {
      await browser.close().catch(() => {});
      const errorMsg = otpResult.data?.statusMessage || otpResult.error || 'Failed to send OTP';
      setTimeout(() => prewarmBrowser().catch(() => {}), 500);
      return { success: false, message: errorMsg };
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    delete activeSessions[userId];
    setTimeout(() => prewarmBrowser().catch(() => {}), 500);
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
  const targetName = targetAcc.charAt(0).toUpperCase() + targetAcc.slice(1);

  try {
    let verifyResult = null;

    try {
      verifyResult = await safeEvaluate(page, async (mobileNumber, otpCode, accName) => {
        try {
          // 1. Try OTP Verify for registered user
          const res = await fetch('https://www.swiggy.com/dapi/auth/otp-verify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({ mobile: mobileNumber, otp: otpCode })
          });
          const data = await res.json().catch(() => ({}));

          // 2. If user is NOT registered on Swiggy, automatically sign up with this OTP!
          if (
            (data?.statusMessage && data.statusMessage.toLowerCase().includes('not registered')) ||
            data?.statusCode === 1
          ) {
            const signupRes = await fetch('https://www.swiggy.com/dapi/auth/signup', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              body: JSON.stringify({
                mobile: mobileNumber,
                otp: otpCode,
                name: accName,
                email: `${accName.toLowerCase()}${mobileNumber}@swiggycare.in`
              })
            });
            const signupData = await signupRes.json().catch(() => ({}));
            return { status: signupRes.status, data: signupData, wasSignup: true };
          }

          return { status: res.status, data, wasSignup: false };
        } catch (err) {
          return { status: 500, error: err.message };
        }
      }, phone, cleanOtp, targetName);
    } catch (evalErr) {
      console.log('[SwiggyBridge] Evaluation error during verify, checking cookies for login redirect:', evalErr.message);
    }

    // Let any redirect / cookie updates settle
    await new Promise(r => setTimeout(r, 2000));

    // Check cookies to confirm real login
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const isReallyLoggedIn = checkLoggedInFromCookies(cookies);

    if (
      isReallyLoggedIn ||
      (verifyResult?.status === 200 && verifyResult?.data?.statusCode === 0)
    ) {
      // Extract specific identifiers
      const tidCookie = cookies.find(c => c.name === 'tid');
      const sidCookie = cookies.find(c => c.name === '_sid');
      const deviceCookie = cookies.find(c => c.name === '_device_id');
      const jwtPayload = decodeJwtPayload(tidCookie?.value);
      const customerId = (jwtPayload && jwtPayload.user_id && jwtPayload.user_id !== '0')
        ? jwtPayload.user_id
        : (verifyResult?.data?.data?.user_id || verifyResult?.data?.data?.id || 'RegisteredUser');

      const savedData = {
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

      updateAccount(targetAcc, savedData);

      await browser.close().catch(() => {});
      delete activeSessions[userId];

      const exportJson = {
        account: targetAcc,
        name: targetName,
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
        targetAcc,
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
      return { success: false, message: errorMsg };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
