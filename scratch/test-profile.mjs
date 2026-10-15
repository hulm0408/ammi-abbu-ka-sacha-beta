import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testProfile() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-position=-32000,-32000',
      '--no-sandbox'
    ]
  });

  const page = await browser.newPage();
  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 4000));

  const res = await page.evaluate(async () => {
    try {
      const r = await fetch('https://www.swiggy.com/dapi/auth/profile', {
        headers: { 'Accept': 'application/json' }
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    } catch (e) {
      return { error: e.message };
    }
  });

  console.log('Profile result (guest):', JSON.stringify(res, null, 2));
  await browser.close();
}

testProfile();
