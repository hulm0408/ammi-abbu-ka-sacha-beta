import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testClaim() {
  const db = getDb();
  const acc = db.config?.accounts?.['abbu'] || db.config?.accounts?.['ammi'];
  const cookies = acc?.cookies;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  if (cookies) {
    const cookiePairs = typeof cookies === 'string' ? cookies.split(';').map(s => s.trim()).filter(Boolean) : cookies;
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    await page.setCookie(...parsedCookies).catch(() => {});
  }

  await page.goto('https://www.swiggy.com/instamart', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  const pageInfo = await page.evaluate(async () => {
    // 1. Check claimable banners or buttons
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const claimKeywords = ['claim', 'free cash', 'swiggy money', 'collect', 'opt-in', 'spin', 'claimed'];
    const matched = [];
    for (const b of buttons) {
      const text = b.innerText?.trim();
      if (text && text.length < 80) {
        const lower = text.toLowerCase();
        if (claimKeywords.some(k => lower.includes(k))) {
          matched.push({ text, tag: b.tagName });
        }
      }
    }

    // 2. Check cart/wallet API from session
    let cartData = null;
    try {
      const res = await fetch('https://www.swiggy.com/dapi/cart');
      cartData = await res.json();
    } catch (e) {}

    // 3. Check wallet opt-in or promo claim endpoint
    let optInRes = null;
    try {
      const opt = await fetch('https://www.swiggy.com/dapi/user/swiggy-money/opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      optInRes = await opt.json().catch(() => null);
    } catch (e) {}

    return {
      matched: matched.slice(0, 10),
      cartMeta: cartData?.data?.cartMeta,
      optInRes
    };
  });

  console.log('Claim elements found:', pageInfo.matched);
  console.log('CartMeta user_swiggy_money:', pageInfo.cartMeta?.user_swiggy_money);
  console.log('Opt-in response:', pageInfo.optInRes);
  await browser.close();
}

testClaim().catch(console.error);
