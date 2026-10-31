/**
 * Boss (31-10-2026, round 27): "ANIMATION AND FONT ... ITS LOOKS AMAZING".
 *
 * Ye ek **sirf dekhne wala** preview server hai — production ka hissa nahi.
 * Isi mini app ka asli HTML/CSS/JS serve karta hai, par API ko demo data se
 * mock karta hai, taaki bina Telegram/Swiggy ke poora look-and-feel dikhe:
 *
 *   node preview-miniapp.mjs      → http://localhost:4173
 *
 * Yahan jo dikhta hai wahi asli app hai (same swiggy-pro.css / swiggy-pro-app.js);
 * sirf data demo ka hai. Koi payment/order isse nahi hota.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const now = new Date();
const demoState = {
  ok: true,
  user: { id: '9000', name: 'Boss', firstName: 'Boss', isBoss: true },
  accounts: [
    { key: 'acc_1', name: 'skk', phone: '9031204105', active: true, isLoggedIn: true, owner: 'self', offerTracks: [] },
    { key: 'acc_2', name: 'Ammi', phone: '9876543210', active: false, isLoggedIn: true, owner: 'self', offerTracks: [] }
  ],
  activeAccount: { key: 'acc_1', name: 'skk' },
  selectedAddress: {
    id: 'addr_1', name: 'Skk', mobile: '9823305540',
    address: 'Flat no. 412, 4th floor, Parivartan Society, Dandekar Pool, Pune'
  },
  selectedAddresses: [],
  checkoutEnabled: true,
  ordersDetailAllowed: true,
  cart: {
    restaurantId: '201', restaurantName: 'Arabecue Fried Chicken', restaurantArea: 'Aliganj',
    restaurantTime: '40-50 mins', restaurantRating: '4.2',
    items: [{ lineKey: 'l1', name: 'Arabian Chicken Longer Burger', price: 171, qty: 2, isVeg: false }],
    quote: {
      itemTotal: 342, deliveryFee: 28, deliverySaved: 28, taxes: 60.28, total: 402,
      coupon: '', discount: 0, fetchedAt: now.toISOString()
    }
  },
  wallet: {
    balancePaise: 500, balance: '5', feePaise: 1500, fee: '15', ready: false, shortfall: '10',
    upiId: 'mius@ybl', presets: [1500, 5000, 10000, 20000], history: []
  },
  coupons: [
    { code: 'FLAT150', title: '₹150 OFF', description: 'Save ₹150 on this order!' },
    { code: 'TRYNEW', title: '70% OFF', description: 'Save ₹140 on this order!' },
    { code: 'DELULU4FOOD', title: '70% OFF', description: 'Save ₹140 on this order!' },
    { code: 'SAMSUNGPAY', title: '₹50 OFF', description: 'Save ₹50 on this order using Samsung Pay UPI!' }
  ],
  statement: { count: 1, totalPaise: 1500, bossPayeeCount: 1, pendingClaims: 0, recent: [] },
  durability: { cloud: true, wallets: 3, utrs: 2, line: 'Cloud backup ON — paisa aur UTR yaad rahenge.' },
  identities: {
    cloud: true, total: 2, live: 2, expired: 0, workspaceCount: 1,
    line: 'Cloud backup ON · 2 login ID · 1 mini-app workspace yaad',
    accounts: [
      { key: 'acc_1', name: 'skk', phoneMasked: '90••••4105', status: 'LOGGED_IN', savedAt: now.toISOString() },
      { key: 'acc_2', name: 'Ammi', phoneMasked: '98••••3210', status: 'LOGGED_IN', savedAt: now.toISOString() }
    ]
  }
};

const previewBoot = `<script>
(() => {
  const STATE = ${JSON.stringify(demoState)};
  window.Telegram = window.Telegram || { WebApp: { initData: 'preview=1', ready(){}, expand(){}, colorScheme: 'light', HapticFeedback: {} } };
  const realFetch = window.fetch;
  window.fetch = async (url, options) => {
    const target = String(url);
    if (!target.includes('/pro/api/')) return realFetch(url, options);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (target.includes('/bootstrap')) return json(STATE);
    if (target.includes('/coupons')) return json({ ok: true, coupons: STATE.coupons, note: '' });
    if (target.includes('/orders')) return json({ ok: true, orders: [] });
    return json({ ok: true, ...STATE });
  };
})();
</script>`;

const TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url.pathname === '/pro/style.css') return send(200, TYPES['.css'], fs.readFileSync(path.join(ROOT, 'swiggy-pro.css')));
  if (url.pathname === '/pro/app.js') return send(200, TYPES['.js'], fs.readFileSync(path.join(ROOT, 'swiggy-pro-app.js')));
  if (url.pathname === '/' || url.pathname === '/pro' || url.pathname === '/pro/' || url.pathname === '/swiggy-pro.html') {
    const html = fs.readFileSync(path.join(ROOT, 'swiggy-pro.html'), 'utf8')
      .replace('<body>', `<body>${previewBoot}`);
    return send(200, TYPES['.html'], html);
  }
  if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok');
  return send(404, 'text/plain', 'not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[preview] mini app demo → http://${HOST}:${PORT}  (asli app, demo data)`);
});
