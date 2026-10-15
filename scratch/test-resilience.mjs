import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testResilience() {
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

  // Stop background timers/reloads
  await page.evaluate(() => {
    window.stop();
    for (let i = 1; i < 99999; i++) {
      window.clearInterval(i);
      window.clearTimeout(i);
    }
  });

  // Safe evaluate helper
  async function safeEval(fn, ...args) {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        return await page.evaluate(fn, ...args);
      } catch (err) {
        lastErr = err;
        if (err.message.includes('Execution context was destroyed') || err.message.includes('Cannot find context')) {
          console.log(`Context was destroyed/lost. Waiting 2s for page to settle (attempt ${i + 1}/4)...`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }
    throw lastErr;
  }

  // Test calling with unregistered number and wrong OTP to see response format
  console.log('Testing safe evaluate with unregistered phone...');
  const res = await safeEval(async () => {
    const r = await fetch('https://www.swiggy.com/dapi/auth/otp-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '6296591407', otp: '999999' })
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  });

  console.log('Result:', JSON.stringify(res, null, 2));

  await browser.close();
}

testResilience();
