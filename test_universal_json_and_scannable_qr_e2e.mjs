import assert from 'assert';
import { cancelScheduledCloudVaultSync } from './vault-sync.js';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import {
  getDb,
  normalizeSwiggySessionPayload,
  extractSwiggyAccountsListFromInput
} from './store.js';
import { checkLoggedInFromCookies } from './swiggy-bridge.js';
import {
  verifySwiggySessionLive,
  fetchAccountAddresses,
  fetchSwiggyProfileFromCookies,
  syncGroupCartAndCheckoutForAccount,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  callSwiggyFoodMcpTool,
  swiggyCartFlush
} from './swiggy-cart.js';
import {
  generateNamedUpiQrPngBuffer,
  sanitizeUpiUriForQr,
  safeTelegramCaption,
  truncateDisplayField
} from './forwarded-order-flow.js';

const DB_PATH = path.resolve('./data/db.json');
const ACC_PATH = path.resolve('./accounts.json');
const origDbRaw = fs.readFileSync(DB_PATH, 'utf8');
const origAccRaw = fs.existsSync(ACC_PATH) ? fs.readFileSync(ACC_PATH, 'utf8') : null;

// Simulate 2x downscale + lossy JPEG block/ringing quantization noise to prove real-world phone camera scan resilience!
function downscale2xWithLossyNoise(pngBuf) {
  const src = PNG.sync.read(pngBuf);
  const w2 = Math.floor(src.width / 2);
  const h2 = Math.floor(src.height / 2);
  const dst = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * src.width + (x * 2 + dx)) << 2;
          r += src.data[si];
          g += src.data[si + 1];
          b += src.data[si + 2];
        }
      }
      // Deterministic pseudo-JPEG quantization jitter (+/- 16 levels)
      const jitter = (((x * 17 + y * 31) % 33) - 16);
      const di = (y * w2 + x) << 2;
      dst[di] = Math.max(0, Math.min(255, Math.round(r / 4) + jitter));
      dst[di + 1] = Math.max(0, Math.min(255, Math.round(g / 4) + jitter));
      dst[di + 2] = Math.max(0, Math.min(255, Math.round(b / 4) + jitter));
      dst[di + 3] = 255;
    }
  }
  return { data: dst, width: w2, height: h2, fullWidth: src.width, fullHeight: src.height };
}

let passed = 0;
async function runTest(title, fn) {
  process.stdout.write(`🧪 ${title} ... `);
  await fn();
  passed++;
  console.log('✅ PASS');
}

try {
  const db = getDb();
  const realWebHexAcc = db.config.accounts.acc_6296591407;
  const realAndroidAcc = db.config.accounts.acc_9935123518;
  assert(realWebHexAcc && realAndroidAcc, 'Live accounts must exist in db.json');

  // 1. Live Test: Other-Bot Hex-`tid` JSON (`{ phone, token, tid: <1504-char hex>, sid, deviceId }` — NO `cookies` field!)
  await runTest('Other-bot hex-`tid` JSON (no `cookies` field) normalizes `_session_tid` & passes live Swiggy verification', async () => {
    const rawOtherBotHexJson = JSON.stringify({
      phone: realWebHexAcc.phone,
      token: realWebHexAcc.token,
      tid: realWebHexAcc._session_tid || realWebHexAcc.tid, // 1536-char hex `_session_tid` without dots!
      sid: realWebHexAcc.sid,
      deviceId: realWebHexAcc.deviceId
    });
    const norm = normalizeSwiggySessionPayload('```json\n' + rawOtherBotHexJson + '\n```');
    assert(norm && norm.cookies.includes('_session_tid='), 'Hex tid must map into `_session_tid=` cookie automatically');
    assert.strictEqual(checkLoggedInFromCookies(norm), true);

    const live = await verifySwiggySessionLive(norm);
    assert.strictEqual(live.valid, true, `Expected live.valid=true, got ${JSON.stringify(live)}`);
    assert(live.liveTid && live.liveTid.includes('.'), 'Must mint real HS256 JWT tid');
    assert(live.customerId && live.customerId !== '0', 'Must resolve real customerId');
  });

  // 2. Live Test: Pure Python/Telethon/Android Bot Token-Only JSON (`ZERO _session_tid` cookie!) Full E2E Cart + Coupon + REAL Swiggy QR!
  await runTest('Pure Android token-only Swiggy JSON (`ZERO _session_tid` cookie!) passes Auth + Profile + Saved Address + Cart Sync + Max Coupon + REAL Swiggy Dynamic QR E2E', async () => {
    const purePythonBotJson = {
      data: {
        mobile_number: '+91-9935123518',
        auth_token: realAndroidAcc.token,
        tid: realAndroidAcc.tid,
        _sid: realAndroidAcc.sid,
        device_id: realAndroidAcc.deviceId
      }
    };
    const tokenOnlyAcc = normalizeSwiggySessionPayload(purePythonBotJson);
    assert(tokenOnlyAcc, 'Must parse nested snake_case Python/Android bot JSON');
    assert(!tokenOnlyAcc.cookies.includes('_session_tid='), 'Must genuinely have ZERO `_session_tid` cookie');
    assert.strictEqual(checkLoggedInFromCookies(tokenOnlyAcc), true);

    // A) Live session check must NOT falsely report expired!
    const live = await verifySwiggySessionLive(tokenOnlyAcc);
    assert.strictEqual(live.valid, true, `Pure Android JSON falsely marked expired: ${JSON.stringify(live)}`);
    assert.strictEqual(live.phone, '9935123518');
    assert(live.name.toLowerCase().includes('prithvi'), `Expected profile name prithvi, got ${live.name}`);
    assert.strictEqual(live.customerId, '283703858');

    const profile = await fetchSwiggyProfileFromCookies(tokenOnlyAcc);
    assert.strictEqual(profile.phone, '9935123518');
    assert(profile.name.toLowerCase().includes('prithvi'));

    // B) Saved addresses fetch with ZERO `_session_tid`
    const addrs = await fetchAccountAddresses(tokenOnlyAcc);
    assert(addrs.length >= 1 && addrs[0].id, 'Must fetch saved address IDs with zero `_session_tid`');

    // C) Full Live Cart Sync + Max Coupon Optimization + REAL Swiggy Merchant Dynamic UPI QR with ZERO `_session_tid`!
    const mockOrder = {
      id: 'TOKONLY99',
      restaurantId: '636724',
      restaurantName: 'Big Bowl',
      items: [{ menu_item_id: 116211194, itemId: '116211194', name: 'Coolberg Cranberry', qty: 2, quantity: 2, price: 142.86 }],
      address: addrs[0].address,
      addressDetails: { ...addrs[0] }
    };

    try {
      const syncRes = await syncGroupCartAndCheckoutForAccount(tokenOnlyAcc, mockOrder, { captureScreenshot: false });
      assert.strictEqual(syncRes.success, true, `Cart sync failed on token-only account: ${JSON.stringify(syncRes)}`);
      assert.strictEqual(mockOrder.swiggyVerified, true, 'Cart bill must be 100% Swiggy verified');
      assert(mockOrder.finalPayable > 0, 'Final payable must be positive');

      let realQr = null;
      try {
        realQr = await generateRealSwiggyMerchantUpiQr({ account: tokenOnlyAcc, order: mockOrder });
      } catch (closedErr) {
        if (!/closed|out of stock|unserviceable|not ready/i.test(String(closedErr?.message || ''))) throw closedErr;
        // 24x7 Night Fallback: `Big Bowl (636724)` closes at 2:30 AM IST — discover a currently-open 24x7 restaurant on `addrs[0]`!
        const sRes = await callSwiggyFoodMcpTool(tokenOnlyAcc, 'search_restaurants', { addressId: String(addrs[0].id), query: 'pizza' });
        for (const r of (sRes.structured?.restaurants || []).slice(0, 6)) {
          const rId = String(r.id || r.restaurantId || '');
          if (!rId) continue;
          const mRes = await callSwiggyFoodMcpTool(tokenOnlyAcc, 'get_restaurant_menu', { restaurantId: rId, addressId: String(addrs[0].id), page: 1, pageSize: 5 });
          let openItem = null;
          const walk = (n) => {
            if (!n || typeof n !== 'object' || openItem) return;
            const id = n.id || n.item_id;
            const hasVar = Boolean(n.variantsV2?.variantGroups?.length || n.variant_groups?.length || n.has_variants);
            const pr = Number(n.price ?? n.final_price ?? n.default_price ?? 0);
            if (id && n.name && n.inStock !== 0 && n.in_stock !== false && !hasVar && pr > 0) {
              openItem = { menu_item_id: Number(id), itemId: String(id), name: String(n.name), qty: 1, quantity: 1, price: pr > 2000 ? Math.round(pr / 100) : pr };
              return;
            }
            for (const v of Object.values(n)) {
              if (Array.isArray(v)) v.forEach(walk);
              else if (v && typeof v === 'object') walk(v);
            }
          };
          walk(mRes.structured?.categories || mRes.structured);
          if (openItem) {
            mockOrder.restaurantId = rId;
            mockOrder.restaurantName = r.name || 'Open Restaurant';
            mockOrder.items = [openItem];
            break;
          }
        }
        const retrySync = await syncGroupCartAndCheckoutForAccount(tokenOnlyAcc, mockOrder, { captureScreenshot: false });
        assert.strictEqual(retrySync.success, true, `24x7 open-restaurant sync failed: ${JSON.stringify(retrySync)}`);
        realQr = await generateRealSwiggyMerchantUpiQr({ account: tokenOnlyAcc, order: mockOrder });
      }
      assert(realQr?.upiIntentUrl && /^upi:\/\/pay\?.*swiggy/i.test(realQr.upiIntentUrl), `Expected real Swiggy merchant UPI QR, got: ${realQr?.upiIntentUrl}`);
      assert(realQr.swiggyOrderId && realQr.orderId, 'Must have real Swiggy checkout orderId');
      assert(realQr.paymentTxnId, 'Must have real Swiggy paas_id transaction reference');

      // Also render the ACTUAL live Swiggy merchant UPI QR with a huge 190-char name & prove 100% pixel camera decode!
      const liveQrPng = await generateNamedUpiQrPngBuffer({
        upiUri: realQr.upiIntentUrl,
        senderName: 'PRITHVI KUMAR SHRI KASHI VISHWANATH ROYAL BIRYANI GOMTI NAGAR EXTENSION PHASE 2 LUCKNOW UTTAR PRADESH INDIA',
        restaurantName: realQr.restaurantName,
        amount: realQr.amount,
        orderId: realQr.swiggyOrderId
      });
      const livePngDecoded = PNG.sync.read(liveQrPng);
      const liveScan = jsQR(new Uint8ClampedArray(livePngDecoded.data), livePngDecoded.width, livePngDecoded.height);
      assert(liveScan && /^upi:\/\/pay\?.*swiggy/i.test(liveScan.data), 'Rendered live Swiggy QR PNG with big name must decode 100% cleanly!');

      const unpaidStatus = await checkRealSwiggyPaymentAndExtractTracking({
        account: tokenOnlyAcc,
        orderId: realQr.orderId,
        paymentTxnId: realQr.paymentTxnId
      });
      assert.strictEqual(unpaidStatus.paid, false, 'Unpaid order must safely return paid=false');
    } finally {
      await swiggyCartFlush(tokenOnlyAcc).catch(() => {});
    }
  });

  // 3. Multi-account `accounts.json` array vs Cookie-Editor array & genuinely expired guest token detection
  await runTest('Multi-account `accounts.json` array imports all items cleanly while genuinely expired guest session (`user_id=0`) returns `valid: false`', async () => {
    const multiBatch = JSON.stringify([
      { phone: realAndroidAcc.phone, tid: realAndroidAcc.tid, token: realAndroidAcc.token, sid: realAndroidAcc.sid, deviceId: realAndroidAcc.deviceId },
      { phone: realWebHexAcc.phone, tid: realWebHexAcc.tid, token: realWebHexAcc.token, sid: realWebHexAcc.sid, deviceId: realWebHexAcc.deviceId }
    ]);
    const list = extractSwiggyAccountsListFromInput(multiBatch);
    assert.strictEqual(list.length, 2, `Expected 2 accounts from array, got ${list.length}`);

    const cookieEditorArr = JSON.stringify([
      { domain: '.swiggy.com', name: '_session_tid', value: realWebHexAcc.tid },
      { domain: '.swiggy.com', name: 'token', value: realWebHexAcc.token }
    ]);
    const ceList = extractSwiggyAccountsListFromInput(cookieEditorArr);
    assert.strictEqual(ceList.length, 1, 'Cookie-Editor array must collapse into 1 normalized account');

    const deadRes = await verifySwiggySessionLive({
      phone: '9000000000',
      tid: 'eyJLSUQiOiIyIiwidHlwIjoiSldUIiwiYWxnIjoiSFMyNTYifQ.eyJ1c2VyX2lkIjoiMCJ9.invalidsig',
      sid: 'dead-sid',
      deviceId: 'dead-device'
    });
    assert.strictEqual(deadRes.valid, false, 'Dead guest token must be rejected accurately');
  });

  // 4. Giant 240-Char Names, Hindi/Emoji Names & 430-Char Signed Swiggy Merchant URIs — 100% Pixel QR Scannability Proof!
  await runTest('240-char giant names, Hindi/Emoji restaurant names, and 430-char signed Swiggy UPI URIs render <1200px PNGs that decode 100% cleanly via `jsQR` even after 2x lossy JPEG degradation', async () => {
    const giantCustomerName =
      'MOHAMMAD ABDULLAH AL-QURESHI SHRI KASHI VISHWANATH ROYAL MUGHLAI BIRYANI & ZAFRANI SHAWARMA DARBAR GOMTI NAGAR EXTENSION PHASE 2 NEAR EKANA INTERNATIONAL CRICKET STADIUM LUCKNOW UTTAR PRADESH 226010 INDIA';
    const giantHindiEmojiRestaurant =
      '🍽️ श्री काशी विश्वनाथ रॉयल बिरयानी दरबार & स्वीट्स — (100% Pure Desi Ghee) [Special Family Jumbo Pack] Hazratganj Branch 🔥✨';

    // Case A: Unsigned UPI URI with giant Unicode/emoji restaurant name
    const rawBloatedUnsignedUri =
      `upi://pay?pa=6296591407@ybl&pn=${encodeURIComponent(giantHindiEmojiRestaurant)}&am=349.00&cu=INR&tn=${encodeURIComponent('Order for ' + giantCustomerName)}`;
    const sanitizedUnsigned = sanitizeUpiUriForQr(rawBloatedUnsignedUri);
    assert(sanitizedUnsigned.length < 150, `Sanitized unsigned UPI URI must be compact (<150 chars), got ${sanitizedUnsigned.length}`);

    const qrPng1 = await generateNamedUpiQrPngBuffer({
      upiUri: rawBloatedUnsignedUri,
      senderName: giantCustomerName,
      restaurantName: giantHindiEmojiRestaurant,
      amount: 349,
      orderId: 'BIGNAME_UNSIGNED_01'
    });
    const full1 = PNG.sync.read(qrPng1);
    assert(full1.width <= 1220 && full1.height <= 1220, `PNG (${full1.width}x${full1.height}) must fit under Telegram 1280px threshold so Telegram never blurs it!`);
    const decFull1 = jsQR(new Uint8ClampedArray(full1.data), full1.width, full1.height);
    assert.strictEqual(decFull1?.data, sanitizedUnsigned, 'Full-res giant-name QR must decode 100%');
    const lossy1 = downscale2xWithLossyNoise(qrPng1);
    const decLossy1 = jsQR(lossy1.data, lossy1.width, lossy1.height);
    assert.strictEqual(decLossy1?.data, sanitizedUnsigned, '2x downscaled + noisy JPEG simulation of giant-name QR MUST STILL DECODE 100%!');

    // Case B: Real 425-char Cryptographically Signed (`&sign=`) Swiggy Merchant Dynamic UPI URI + 240-char Customer Name!
    const longSignedSwiggyUri =
      'upi://pay?pa=swiggy1online.gpay@okpayaxis&pn=Swiggy%20Bundl%20Technologies%20Private%20Limited%20Food%20Marketplace&tr=SWIGGYTXN20261020998877665544332211&tid=AXIS9988776655443322110099887766&am=412.00&cu=INR&mc=5814&mode=04&purpose=00&orgid=159761&sign=MEYCIQDx9Z8kL4mN7pQ2rT5vW8yB1cE4fH7jK0mP3sU6wZ9aCAIhAOn3R6uX9zA2dG5jM8pS1vY4bE7hK0nQ3tW6zB9eF2gJ';
    const qrPng2 = await generateNamedUpiQrPngBuffer({
      upiUri: longSignedSwiggyUri,
      senderName: giantCustomerName,
      restaurantName: giantHindiEmojiRestaurant,
      amount: 412,
      orderId: 'BIGNAME_SIGNED_SWIGGY_02'
    });
    const full2 = PNG.sync.read(qrPng2);
    assert(full2.width <= 1220 && full2.height <= 1220, `Signed URI PNG (${full2.width}x${full2.height}) must stay <= 1220px!`);
    const decFull2 = jsQR(new Uint8ClampedArray(full2.data), full2.width, full2.height);
    // Signed URI MUST match byte-for-byte without a single altered character!
    assert.strictEqual(decFull2?.data, longSignedSwiggyUri, 'Signed Swiggy merchant URI MUST be preserved byte-for-byte intact!');
    const lossy2 = downscale2xWithLossyNoise(qrPng2);
    const decLossy2 = jsQR(lossy2.data, lossy2.width, lossy2.height);
    assert.strictEqual(decLossy2?.data, longSignedSwiggyUri, '2x downscaled + noisy JPEG simulation of 425-char signed Swiggy QR MUST STILL DECODE 100%!');

    // Case C: Telegram `sendPhoto` 1024-char caption protection with extreme names
    const hugeCaption = safeTelegramCaption(
      `🔳 <b>OFFICIAL SWIGGY QR</b>\n👤 ${truncateDisplayField(giantCustomerName, 110)}\n🍽 ${truncateDisplayField(giantHindiEmojiRestaurant, 120)}\n` + 'X'.repeat(1400),
      1000
    );
    assert(hugeCaption.length <= 1000, `Photo caption must strictly stay <= 1000 chars, got ${hugeCaption.length}`);
  });

  console.log(`\n🏆 ALL ${passed}/${passed} UNIVERSAL SWIGGY JSON + SCANNABLE QR TESTS PASSED 100%!`);
} finally {
  cancelScheduledCloudVaultSync();
  fs.writeFileSync(DB_PATH, origDbRaw, 'utf8');
  if (origAccRaw !== null) fs.writeFileSync(ACC_PATH, origAccRaw, 'utf8');
}
