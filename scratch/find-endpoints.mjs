import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testAuthEndpoints() {
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

  // Check Swiggy bundle for auth endpoints
  const endpoints = await page.evaluate(async () => {
    // Search scripts for /dapi/auth/
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(Boolean);
    const results = [];
    for (const src of scripts) {
      try {
        const text = await (await fetch(src)).text();
        const matches = text.match(/\/dapi\/auth\/[a-zA-Z0-9_\-]+/g);
        if (matches) results.push(...matches);
      } catch (e) {}
    }
    return [...new Set(results)];
  });

  console.log('Discovered Swiggy Auth Endpoints:', endpoints);
  await browser.close();
}

testAuthEndpoints();
