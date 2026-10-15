import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testWafAndEndpoints() {
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
  
  // Robust evaluate with retry
  async function safeEvaluate(fn, ...args) {
    for (let i = 0; i < 5; i++) {
      try {
        return await page.evaluate(fn, ...args);
      } catch (err) {
        if (err.message.includes('Execution context was destroyed') || err.message.includes('Cannot find context')) {
          console.log(`Context destroyed, waiting 1.5s (attempt ${i + 1}/5)...`);
          await new Promise(r => setTimeout(r, 1500));
        } else {
          throw err;
        }
      }
    }
  }

  console.log('Navigating to Swiggy...');
  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });

  // Wait until aws-waf-token exists and page is settled!
  console.log('Waiting for AWS WAF token...');
  let hasWaf = false;
  for (let i = 0; i < 15; i++) {
    const cookies = await page.cookies();
    const wafCookie = cookies.find(c => c.name === 'aws-waf-token');
    if (wafCookie) {
      console.log('Found aws-waf-token! Token length:', wafCookie.value.length);
      hasWaf = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Let any potential reload complete
  await new Promise(r => setTimeout(r, 2000));

  // Now test sms-otp with safeEvaluate
  console.log('Calling sms-otp...');
  const res = await safeEvaluate(async (phone) => {
    const r = await fetch('https://www.swiggy.com/dapi/auth/sms-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ mobile: phone })
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }, '6296591407');

  console.log('Safe evaluate result:', JSON.stringify(res, null, 2));

  // What about user not registered? Let's test what endpoint Swiggy uses when user is new or existing!
  // Let's test with a random new number (e.g. 9111111111)
  console.log('Testing new/unregistered number:');
  const resNew = await safeEvaluate(async (phone) => {
    const r = await fetch('https://www.swiggy.com/dapi/auth/sms-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ mobile: phone })
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }, '9111111111');

  console.log('Unregistered number result:', JSON.stringify(resNew, null, 2));

  await browser.close();
}

testWafAndEndpoints();
