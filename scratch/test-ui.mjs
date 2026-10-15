import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testUi() {
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
    if (url.includes('/dapi/auth/') || url.includes('/auth') || url.includes('/login') || url.includes('/sms-otp')) {
      try {
        const text = await res.text();
        console.log(`[AUTH API] ${res.status()} ${url} ->`, text);
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 4000));

  // Find sign in link or button
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a, button, span, div')).map(el => ({
      tag: el.tagName,
      text: el.innerText?.trim(),
      href: el.getAttribute('href')
    })).filter(x => x.text && (x.text.toLowerCase().includes('sign in') || x.text.toLowerCase().includes('login')));
  });

  console.log('Login elements on homepage:', buttons.slice(0, 10));

  await browser.close();
}

testUi();
