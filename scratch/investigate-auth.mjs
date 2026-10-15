import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function investigate() {
  console.log('Launching browser...');
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

  // Intercept all requests/responses to see what Swiggy frontend does
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/dapi/auth/') || url.includes('/auth')) {
      try {
        const text = await res.text();
        console.log(`[API RESPONSE] ${res.status()} ${url}:`, text.slice(0, 300));
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/', { waitUntil: 'networkidle2' });
  console.log('Page loaded');

  // Let's test with the registered number (e.g. 6296591407 or whatever user used)
  // Let's see what happens if we call sms-otp
  const res = await page.evaluate(async () => {
    const r = await fetch('https://www.swiggy.com/dapi/auth/sms-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '6296591407' })
    });
    return { status: r.status, body: await r.text() };
  });

  console.log('SMS OTP API result:', res);
  await browser.close();
}

investigate();
