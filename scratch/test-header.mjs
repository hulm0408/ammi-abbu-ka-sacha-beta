import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testHeader() {
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

  const items = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('header *, nav *, div[class*="header"] *')).map(el => ({
      tag: el.tagName,
      text: el.innerText?.trim(),
      className: el.className
    })).filter(x => x.text && (x.text.toLowerCase().includes('sign in') || x.text.toLowerCase().includes('login')));
  });

  console.log('Header items:', items);
  await browser.close();
}

testHeader();
