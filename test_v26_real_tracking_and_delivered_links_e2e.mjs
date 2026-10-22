// ============================================================================
// V26 — Genuine Swiggy Tracking Links + Delivered Order Link Extraction E2E
// ============================================================================
// Verifies both parts of the production tracking fix:
//   1. Dummy / non-tracking URLs (media-assets .png icons, swiggy.onelink.me
//      download/address links, /dapi/* API routes, r.swiggy.com/swiggy/rate_app,
//      bare swiggy.com/, /track, /orders, /my-account/orders) are 100% rejected,
//      and any poisoned dummy trackingLink cached in DB is invalidated & replaced.
//   2. Real Swiggy tracking/OFO links are extracted from multi-word share
//      sentences, stringified JSON blobs, escaped slashes, deep links, and
//      secondary mobile/classic endpoints — EVEN WHEN THE ORDER IS DELIVERED!

import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import { getDb, saveDb } from './store.js';
import {
  isOfficialSwiggyTrackingUrl,
  getStoredSwiggyTrackingUrl,
  extractSwiggyProvidedTrackingUrl,
  extractOrderShareUrlDeep,
  fetchAccountOrders,
  scanOrderAcrossAccounts,
  dapiFetch
} from './swiggy-cart.js';
import {
  ensureOrderTracking,
  startOrderTrackingAuto,
  stopOrderTrackingAuto
} from './order-tracking.js';
import { buildBossOrderCard, buildBossDashboard, trackingLinkDisplay } from './boss-panel.js';
import { sendParentSmsNotification, sendDirectOrderSms } from './sms-notify.js';

console.log('› Testing V26: dummy-link rejection + real OFO & delivered order link extraction…\n');

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`❌ ${label}\n   ↳ ${err.message}`);
  }
}

const FAKE_JWT = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIn0.eyJ1c2VyX2lkIjoiMjg1NTkxODY0In0.sig';
const DELIVERED_RECENT_ID = '251144921143559';
const DELIVERED_OLDER_ID = '251099887766554';
const REAL_OFO_URL = 'http://r.swiggy.com/swiggy/ofo/track/n4b5SldB4SJx';
const REAL_OLDER_DELIVERED_URL = 'https://r.swiggy.com/swiggy/ofo/track/d9K2mLpQ8vXz';

function makeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

// ---------------------------------------------------------------------------
// 1. Dummy URL rejection & real Swiggy URL extraction unit checks
// ---------------------------------------------------------------------------
await check('Rejects every dummy / CDN / API / install / address URL in isOfficialSwiggyTrackingUrl', () => {
  const dummyUrls = [
    'https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto/portal/m/track_icon.png',
    'https://instamart-media-assets.swiggy.com/swiggy/image/upload/track_banner.webp',
    'https://web-assets.swiggy.com/swiggy/track.svg',
    'https://swiggy.onelink.me/888564224/download',
    'https://swiggy.onelink.me/JgkQ/kubail4a',
    'https://www.swiggy.com/dapi/order/download-summary?order_id=251614877199247',
    'https://www.swiggy.com/mapi/order/trackV4?order_id=251614877199247',
    'https://www.swiggy.com/',
    'https://www.swiggy.com/track',
    'https://www.swiggy.com/orders',
    'https://www.swiggy.com/my-account/orders',
    'https://www.swiggy.com/my-account/orders?order_id=251614877199247',
    'https://r.swiggy.com/',
    'https://r.swiggy.com/swiggy/rate_app',
    'https://r.swiggy.com/ofo/address/abc12345',
    'https://payments.swiggy.com/api/v3/order/confirm?order_id=251614877199247',
    'https://swig.gy/gc/1467977/Umbashiya-642855918',
    'https://ammi-abbu-ka-sacha-beta.onrender.com/track/ORD123?sig=deadbeef'
  ];
  for (const bad of dummyUrls) {
    assert.strictEqual(
      isOfficialSwiggyTrackingUrl(bad, { allowProviderShortLink: true }),
      false,
      `dummy URL must be rejected even with allowProviderShortLink: ${bad}`
    );
  }
});

await check('Accepts genuine Swiggy OFO & order tracking URLs', () => {
  const realUrls = [
    REAL_OFO_URL,
    'https://r.swiggy.com/swiggy/ofo/track/n4b5SldB4SJx',
    'https://r.swiggy.com/abc123',
    'https://r.swiggy.com/track/TARGET123',
    'https://www.swiggy.com/ofo/track/n4b5SldB4SJx',
    'https://www.swiggy.com/track-order/shared-token-998877',
    'https://www.swiggy.com/orders/track/250070826195484',
    'https://www.swiggy.com/orders/250070826195484'
  ];
  for (const good of realUrls) {
    assert.strictEqual(
      isOfficialSwiggyTrackingUrl(good, { allowProviderShortLink: true }),
      true,
      `genuine Swiggy tracking URL must be accepted: ${good}`
    );
  }
});

await check('Extracts real OFO URL from multi-word share sentence even when payload contains dummy media/onelink URLs', () => {
  const realisticPayload = {
    order_id: DELIVERED_RECENT_ID,
    order_status: 'Delivered',
    tracking_icon: 'https://media-assets.swiggy.com/swiggy/image/upload/portal/m/track_icon.png',
    invoice_url: 'https://www.swiggy.com/dapi/order/download-summary?order_id=251144921143559',
    install_link: 'https://swiggy.onelink.me/888564224/download',
    rate_cta: 'https://r.swiggy.com/swiggy/rate_app',
    ofo_details: {
      share_message: `Fer aex has just placed an order (ID: ${DELIVERED_RECENT_ID}) for you on Swiggy. Click this link to track: ${REAL_OFO_URL}.`
    }
  };
  assert.strictEqual(extractSwiggyProvidedTrackingUrl(realisticPayload), REAL_OFO_URL);
  assert.strictEqual(extractOrderShareUrlDeep(realisticPayload), REAL_OFO_URL);
});

await check('Extracts real tracking link from stringified JSON blobs and escaped slashes', () => {
  const stringifiedPayload = {
    order_id: DELIVERED_OLDER_ID,
    app_redirection_info: JSON.stringify({
      cta_type: 'SHARE_ORDER',
      share_data: {
        whatsapp_text: `Track delivered order here: ${REAL_OLDER_DELIVERED_URL.replace(/\//g, '\\/')}`
      }
    })
  };
  assert.strictEqual(extractSwiggyProvidedTrackingUrl(stringifiedPayload), REAL_OLDER_DELIVERED_URL);
  assert.strictEqual(extractOrderShareUrlDeep(stringifiedPayload), REAL_OLDER_DELIVERED_URL);
});

await check('SMS helper never leaks dummy order.trackingLink into SMS text', async () => {
  const poisonedOrder = {
    id: 'SMS_DUMMY_GUARD',
    swiggyOrderId: DELIVERED_RECENT_ID,
    restaurantName: 'Biryani Mahal',
    finalPayable: 199,
    addressDetails: { name: 'Ammi', mobile: '9876543210' },
    trackingLink: 'https://media-assets.swiggy.com/swiggy/image/upload/track_icon.png',
    trackingLinkSource: 'SWIGGY_API'
  };
  assert.strictEqual(getStoredSwiggyTrackingUrl(poisonedOrder), '');
  const sms1 = await sendParentSmsNotification(poisonedOrder, poisonedOrder.trackingLink);
  assert.ok(!String(sms1.smsText || '').includes('media-assets.swiggy.com'), 'parent SMS must never include dummy asset link');
  const sms2 = await sendDirectOrderSms(poisonedOrder);
  assert.ok(!String(sms2.smsText || '').includes('media-assets.swiggy.com'), 'direct SMS must never include dummy asset link');
});

// ---------------------------------------------------------------------------
// 2. End-to-end Delivered order extraction across Swiggy endpoints
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const capturedRequests = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  capturedRequests.push({ url: target, headers: init?.headers || {} });

  if (target.includes('/dapi/order/all')) {
    return makeResponse({
      statusCode: 0,
      tid: FAKE_JWT,
      sid: 'test-sid',
      deviceId: 'test-device',
      data: {
        orders: [
          {
            order_id: DELIVERED_RECENT_ID,
            order_status: 'Delivered',
            restaurant_name: 'Royal Darbar',
            order_total: 245,
            // Polluted with a media icon to prove dummy links never win:
            status_icon: 'https://media-assets.swiggy.com/swiggy/image/upload/portal/m/track_delivered.png'
          }
        ]
      }
    });
  }

  // Simulate Swiggy's post-delivery desktop trackV4 where live tracking cards are
  // replaced by "Delivered / Rate order", so share link is NOT in dapi/order/trackV4:
  if (target.includes('/dapi/order/trackV4')) {
    return makeResponse({
      statusCode: 0,
      data: {
        order_status_details: { status_message: 'Delivered' },
        rate_cta: { link: 'https://r.swiggy.com/swiggy/rate_app' }
      }
    });
  }

  if (target.includes('order/trackV2/de')) {
    return makeResponse({
      statusCode: 0,
      data: { name: 'Raju Rider', mobile: '9811223344', otp: '7391' }
    });
  }

  // Secondary classic/mobile endpoint retains the real OFO tracking link for the delivered order!
  if (target.includes('/dapi/order/track?') && target.includes(DELIVERED_RECENT_ID)) {
    return makeResponse({
      statusCode: 0,
      data: {
        order_id: DELIVERED_RECENT_ID,
        order_status: 'Delivered',
        share_details: {
          message: `Fer aex has just placed an order (ID: ${DELIVERED_RECENT_ID}) for you on Swiggy. Click this link to track: ${REAL_OFO_URL}`
        }
      }
    });
  }

  // Older delivered order (not in order/all page 1!) — found via Phase 2 order/details + mapi/order/trackV4:
  if (target.includes('/dapi/order/details') && target.includes(DELIVERED_OLDER_ID)) {
    return makeResponse({
      statusCode: 0,
      data: {
        orders: [{
          order_id: DELIVERED_OLDER_ID,
          order_status: 'Delivered',
          post_status: 'delivered',
          restaurant_name: 'Tunday Kababi',
          order_total: 310
        }]
      }
    });
  }

  if (target.includes('/mapi/order/trackV4') && target.includes(DELIVERED_OLDER_ID)) {
    return makeResponse({
      statusCode: 0,
      data: {
        order_status_details: { status_message: 'Delivered' },
        comms: {
          app_redirection_info: JSON.stringify({ shareable_url: REAL_OLDER_DELIVERED_URL })
        }
      }
    });
  }

  return makeResponse({ statusCode: 0, data: {} });
};

const testAcc = {
  account: 'acc_v26',
  phone: '6376531847',
  name: 'Panu none',
  customerId: '285591864',
  token: 'tok-v26',
  tid: FAKE_JWT,
  sid: 'test-sid',
  deviceId: 'test-device',
  cookies: `_session_tid=abc; token=tok-v26; _sid=test-sid; _swuid=test-device; tid=${FAKE_JWT}`,
  isLoggedIn: true
};
const getAccountsFn = () => ({ acc_v26: testAcc });
const dbBackup = JSON.parse(JSON.stringify(getDb()));
const rawDbDiskBackup = fs.existsSync('data/db.json') ? fs.readFileSync('data/db.json', 'utf8') : null;

try {
  await check('dapiFetch sends full Swiggy Android version-code & session headers', async () => {
    capturedRequests.length = 0;
    await dapiFetch(testAcc, `order/trackV4?order_id=${DELIVERED_RECENT_ID}&type=full&version=V2`);
    const req = capturedRequests[0];
    assert.ok(req, 'request must be captured');
    assert.strictEqual(req.headers['version-code'], '1800');
    assert.strictEqual(req.headers['app-version'], '4.99.0');
    assert.strictEqual(req.headers['platform'], 'swiggy-android');
    assert.strictEqual(req.headers['tid'], FAKE_JWT);
    assert.strictEqual(req.headers['token'], 'tok-v26');
  });

  await check('fetchAccountOrders (Orders Done) extracts tracking link for a Delivered order via secondary endpoint', async () => {
    const orders = await fetchAccountOrders(testAcc);
    const delivered = orders.find(o => String(o.orderId) === DELIVERED_RECENT_ID);
    assert.ok(delivered, 'delivered order returned');
    assert.strictEqual(delivered.status, 'Delivered');
    assert.strictEqual(delivered.trackingUrl, REAL_OFO_URL, 'real OFO link extracted for delivered order');
    assert.strictEqual(delivered.deliveryOtp, '7391');
  });

  await check('Poisoned dummy trackingLink in DB is invalidated and replaced with real link on Delivered order', async () => {
    const db = getDb();
    db.orders = db.orders || {};
    db.config.accounts = db.config.accounts || {};
    db.config.accounts.acc_v26 = testAcc;
    db.orders.V26_DELIVERED = {
      id: 'V26_DELIVERED',
      status: 'COMPLETED',
      swiggyOrderId: DELIVERED_RECENT_ID,
      pendingSwiggyOrderId: DELIVERED_RECENT_ID,
      liveOrderStatus: 'Delivered',
      selectedAccount: 'acc_v26',
      // Simulate previously saved dummy URL:
      trackingLink: 'https://www.swiggy.com/track',
      trackingLinkSource: 'SWIGGY_API',
      createdAt: new Date().toISOString()
    };
    saveDb(db);

    assert.strictEqual(getStoredSwiggyTrackingUrl(getDb().orders.V26_DELIVERED), '', 'dummy /track URL must be invalidated');

    // Auto-tracker runs 1 pass even though status is already Delivered:
    const autoState = startOrderTrackingAuto('V26_DELIVERED', { budgetMs: 6000 });
    assert.ok(autoState, 'delivered order without valid link gets 1 extraction pass');
    await new Promise(resolve => setTimeout(resolve, 120));
    stopOrderTrackingAuto('V26_DELIVERED');

    const updated = getDb().orders.V26_DELIVERED;
    assert.strictEqual(updated.trackingLink, REAL_OFO_URL, 'real OFO tracking URL saved for delivered order');
    assert.strictEqual(updated.liveOrderStatus, 'Delivered');
    assert.strictEqual(updated.deliveryOtp, '7391');

    // Boss card & Dashboard display the real tracking link on the Delivered order:
    const card = buildBossOrderCard(updated, getDb());
    assert.ok(card.text.includes(REAL_OFO_URL), 'Boss order card includes real tracking URL on delivered order');
    assert.ok(!card.text.includes('publish nahi karta'), 'Boss order card never claims delivered order has no link');
    const dash = buildBossDashboard(getDb());
    assert.ok(dash.text.includes('Open live tracking'), 'Dashboard displays clickable tracking link for delivered order');
    assert.ok(trackingLinkDisplay({ url: REAL_OFO_URL, status: 'Delivered' }).includes(REAL_OFO_URL));
  });

  await check('Older Delivered order beyond page 1 of order/all is found via Phase 2 order/details + mapi/order/trackV4', async () => {
    const scan = await scanOrderAcrossAccounts(DELIVERED_OLDER_ID, {
      getAccountsFn,
      budgetMs: 8000,
      deep: true
    });
    assert.strictEqual(scan.status, 'TRACKING_FOUND');
    assert.strictEqual(scan.hasOrder, true);
    assert.strictEqual(scan.orderStatus, 'Delivered');
    assert.strictEqual(scan.trackingUrl, REAL_OLDER_DELIVERED_URL);
    assert.strictEqual(scan.scanned, 1, 'scanned count reflects unique accounts, not double-counted phases');

    const ensured = await ensureOrderTracking(
      {
        id: DELIVERED_OLDER_ID,
        swiggyOrderId: DELIVERED_OLDER_ID,
        pendingSwiggyOrderId: DELIVERED_OLDER_ID,
        status: 'UNVERIFIED',
        isSwiggyIdLookup: true
      },
      { force: true, budgetMs: 8000, deep: true, getAccountsFn }
    );
    assert.strictEqual(ensured.trackingUrl, REAL_OLDER_DELIVERED_URL);
    assert.strictEqual(getDb().orders[DELIVERED_OLDER_ID]?.trackingLink, REAL_OLDER_DELIVERED_URL);
  });
} finally {
  globalThis.fetch = realFetch;
  saveDb(dbBackup);
  if (rawDbDiskBackup !== null) {
    try { fs.writeFileSync('data/db.json', rawDbDiskBackup); } catch {}
  }
}

console.log('\n================================================================');
console.log(`📊 RESULT: ${passed}/${passed + failed} V26 tracking & delivered-order checks passed`);
console.log('================================================================');
if (failed > 0) process.exitCode = 1;
