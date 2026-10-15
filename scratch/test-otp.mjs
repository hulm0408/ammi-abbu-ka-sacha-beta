import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function test() {
  console.log('Launching Chrome...');
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

  console.log('Checking Swiggy cookies & csrf...');
  const cookies = await page.cookies();
  const csrfCookie = cookies.find(c => c.name === '_csrf');
  console.log('CSRF cookie:', csrfCookie?.value);

  // Test sms-otp call
  const testPhone = '6296591407';
  const result = await page.evaluate(async (phone) => {
    try {
      const res = await fetch('https://www.swiggy.com/dapi/auth/sms-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ mobile: phone })
      });
      const data = await res.json();
      return { status: res.status, data };
    } catch (e) {
      return { error: e.message };
    }
  }, testPhone);

  console.log('Result:', JSON.stringify(result, null, 2));
  await browser.close();
}

test();
