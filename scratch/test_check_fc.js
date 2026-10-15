import puppeteer from 'puppeteer-core';
import { getDb } from '../store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function checkAccountFreeCash(cookies) {
  if (!cookies) return { eligible: false, balance: 0, reason: 'No cookies provided', status: 'NOT_ELIGIBLE' };

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
        '--no-sandbox'
      ]
    });

    const page = await browser.newPage();
    const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    await page.setCookie(...parsedCookies).catch(() => {});

    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 10; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 1500));

    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        const fc = cm.user_swiggy_money || cm.swiggy_money || 0;
        const swiggyOne = Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super);
        return {
          statusCode: json.statusCode,
          freeCash: fc,
          swiggyOne,
          eligible: fc > 0
        };
      } catch (err) {
        return { error: err.message, freeCash: 0, eligible: false };
      }
    });

    return {
      eligible: Boolean(result?.freeCash > 0),
      balance: result?.freeCash || 0,
      swiggyOne: Boolean(result?.swiggyOne),
      freebieAvailable: Boolean(result?.freeCash > 0),
      status: result?.freeCash > 0 ? 'ELIGIBLE' : 'NOT_ELIGIBLE'
    };
  } catch (err) {
    return {
      eligible: false,
      balance: 0,
      error: err.message,
      status: 'NOT_ELIGIBLE'
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function run() {
  const db = getDb();
  const acc = db.config?.accounts?.['abbu'];
  if (!acc?.cookies) {
    console.log('No cookies for abbu');
    return;
  }
  console.log('Checking Free Cash for abbu...');
  const res = await checkAccountFreeCash(acc.cookies);
  console.log('Result:', res);
}

run();
