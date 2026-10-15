import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testClickSignIn() {
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
    if (url.includes('/dapi/auth/') || url.includes('login') || url.includes('otp')) {
      try {
        console.log(`[API RESPONSE] ${res.status()} ${url}:`, (await res.text()).slice(0, 300));
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 4000));

  console.log('Clicking Sign In...');
  const clicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('span, div, a, li')).filter(e => e.innerText?.trim() === 'Sign In');
    if (els.length > 0) {
      els[els.length - 1].click();
      return true;
    }
    return false;
  });
  console.log('Clicked Sign In:', clicked);

  await new Promise(r => setTimeout(r, 2000));

  // Find input fields
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      id: i.id,
      name: i.name,
      placeholder: i.placeholder,
      className: i.className
    }));
  });
  console.log('Inputs found after clicking Sign In:', inputs);

  // Check drawer text
  const text = await page.evaluate(() => {
    const sidebar = document.querySelector('div[class*="sidebar"], div[class*="overlay"], div[class*="drawer"]');
    return sidebar ? sidebar.innerText : document.body.innerText.slice(0, 500);
  });
  console.log('Drawer text preview:', text);

  await browser.close();
}

testClickSignIn();
