import { getDb } from '../store.js';

async function testFreeCash() {
  const db = getDb();
  const acc = db.config?.accounts?.['abbu'] || db.config?.accounts?.['ammi'] || db.config?.accounts?.['dada'];
  if (!acc?.cookies) {
    console.log('No cookies found for test');
    return;
  }

  const cookieHeader = typeof acc.cookies === 'string'
    ? acc.cookies
    : acc.cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Cookie': cookieHeader,
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.swiggy.com/'
  };

  const endpoints = [
    'https://www.swiggy.com/dapi/wallet/balance',
    'https://www.swiggy.com/dapi/cart',
    'https://www.swiggy.com/dapi/user/profile',
    'https://www.swiggy.com/dapi/user/swiggy-money'
  ];

  for (const ep of endpoints) {
    try {
      console.log(`\n--- Probing ${ep} ---`);
      const res = await fetch(ep, { headers });
      console.log('Status:', res.status);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        console.log('JSON:', JSON.stringify(json).slice(0, 300));
      } catch {
        console.log('Non-JSON (first 150 chars):', text.slice(0, 150));
      }
    } catch (e) {
      console.error('Error probing', ep, e.message);
    }
  }
}

testFreeCash();
