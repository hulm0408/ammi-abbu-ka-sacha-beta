import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testDrawer() {
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
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/dapi/auth/') || url.includes('/auth') || url.includes('login') || url.includes('otp')) {
      try {
        const text = await res.text();
        console.log(`\n[NETWORK API] ${res.status()} ${url}`);
        console.log('RESPONSE:', text);
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 4000));

  // Click 'Sign in'
  console.log('Clicking Sign in button...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(e => e.innerText === 'Sign in');
    if (el) el.click();
  });

  await new Promise(r => setTimeout(r, 2000));

  // Check inputs in drawer
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      placeholder: i.placeholder
    }));
  });
  console.log('Inputs found:', inputs);

  // Type phone number in mobile input
  const phone = '6296591407';
  console.log(`Typing phone ${phone}...`);
  await page.type('input#mobile', phone);
  await new Promise(r => setTimeout(r, 1000));

  // Find and click Login button
  console.log('Clicking submit/login button...');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('a, button, input[type="submit"]')).find(e => {
      const t = e.innerText?.toLowerCase() || '';
      return t === 'login' || t === 'continue' || t === 'sign up';
    });
    if (btn) {
      console.log('Found button:', btn.innerText);
      btn.click();
    }
  });

  await new Promise(r => setTimeout(r, 4000));

  // Check what message is shown in the drawer!
  const drawerText = await page.evaluate(() => {
    const drawer = document.querySelector('div#overlay-sidebar-root') || document.body;
    return drawer.innerText;
  });
  console.log('\n--- DRAWER TEXT AFTER SUBMIT ---');
  console.log(drawerText);

  await browser.close();
}

testDrawer();
