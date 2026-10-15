import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { getDb } from '../store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const db = getDb();
  const acc = db.config.accounts.abbu;
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
  });
  const page = await browser.newPage();
  const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
  await page.setCookie(...cookiePairs.map(p => {
    const [name, ...val] = p.split('=');
    return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
  }));

  let captured = null;
  page.on('response', async res => {
    const u = res.url();
    if (u.includes('get-payment-options') || u.includes('payment/options')) {
      try {
        captured = await res.json();
        fs.writeFileSync('payment_options_dump.json', JSON.stringify(captured, null, 2));
        console.log('SAVED payment_options_dump.json with keys:', Object.keys(captured));
      } catch (e) {
        console.log('Error parsing payment response:', e.message);
      }
    }
  });

  console.log('Navigating to checkout...');
  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 4000));

  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 6000));

  console.log('Final URL:', page.url());
  await browser.close();
})();
