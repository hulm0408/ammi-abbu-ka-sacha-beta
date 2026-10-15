import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testSignupApi() {
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

  // Test sign-up / register endpoints with OPTIONS or dummy POST
  const results = await page.evaluate(async () => {
    const list = [
      'https://www.swiggy.com/dapi/auth/sign-up',
      'https://www.swiggy.com/dapi/auth/signup',
      'https://www.swiggy.com/dapi/auth/register',
      'https://www.swiggy.com/dapi/auth/create-account',
      'https://www.swiggy.com/dapi/auth/otp-verify'
    ];

    const out = {};
    for (const u of list) {
      try {
        const res = await fetch(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobile: '9111111111', otp: '123456', name: 'Family User', email: 'familyuser@gmail.com' })
        });
        out[u] = { status: res.status, data: await res.json().catch(() => ({})) };
      } catch (e) {
        out[u] = { error: e.message };
      }
    }
    return out;
  });

  console.log('Endpoint test results:\n', JSON.stringify(results, null, 2));
  await browser.close();
}

testSignupApi();
