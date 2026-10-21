import assert from 'node:assert/strict';
import { discoverOpen24x7RestaurantOrder } from './test-live-open-cart-helper.mjs';
import dns from 'node:dns';
import puppeteer from 'puppeteer-core';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

let puppeteerLaunches = 0;
const origLaunch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async (...args) => {
  puppeteerLaunches++;
  return origLaunch(...args);
};
import { installBulletproofTelegramTransport } from './network-shield.js';
import { getDb } from './store.js';
import {
  getSwiggySessionAuth,
  saveAddressToAccount,
  syncGroupCartAndCheckoutForAccount,
  generateRealSwiggyMerchantUpiQr,
  swiggyCartFlush,
  dapiFetch
} from './swiggy-cart.js';
import {
  ingestForwardedContentIntoOrder,
  generateNamedUpiQrPngBuffer
} from './forwarded-order-flow.js';

console.log('🛡️ Running Render Production Incident Regression Suite (IPv4 Shield + 90s Timeout Fix + Zero-Chromium ORD2163 QR)...');

const db = getDb();
const rawAcc = db.config.accounts.acc_6296591407;
assert(rawAcc, 'Expected acc_6296591407 in db.json');

let createdAddrIds = [];
let tokenOnlyAcc = null;

try {
  // =========================================================================
  // INCIDENT 1 REPRO & VERIFICATION:
  // `api.telegram.org` Dual-Stack DNS + `answerCallbackQuery` ETIMEDOUT Shield
  // =========================================================================
  const singleLookup = await new Promise((resolve, reject) => {
    dns.lookup('api.telegram.org', (err, address, family) => {
      if (err) return reject(err);
      resolve({ address, family });
    });
  });
  const allLookup = await new Promise((resolve, reject) => {
    dns.lookup('api.telegram.org', { all: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses);
    });
  });
  assert.strictEqual(singleLookup.family, 4, `Expected IPv4 family=4 for api.telegram.org, got ${JSON.stringify(singleLookup)}`);
  assert(allLookup.length > 0 && allLookup.every(x => x.family === 4), `Expected zero blackholed IPv6 records for api.telegram.org, got ${JSON.stringify(allLookup)}`);
  console.log(`✅ [Incident 1A] Global IPv4 DNS shield verified -> api.telegram.org resolves strictly to IPv4 (${singleLookup.address})`);

  // Verify `installBulletproofTelegramTransport` absorbs `answerCallbackQuery` ETIMEDOUT & auto-retries `sendMessage`!
  let sendAttempts = 0;
  let cbAttempts = 0;
  const mockBot = {
    telegram: {
      options: {},
      async callApi(method, payload) {
        if (method === 'answerCallbackQuery') {
          cbAttempts++;
          const err = new Error('request to https://api.telegram.org/bot8985760874:REDACTED/answerCallbackQuery failed, reason: ');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        if (method === 'sendMessage') {
          sendAttempts++;
          if (sendAttempts === 1) {
            const err = new Error('request to https://api.telegram.org/bot8985760874:REDACTED/sendMessage failed, reason: ');
            err.code = 'ETIMEDOUT';
            throw err;
          }
          return { message_id: 777, text: payload.text };
        }
        return { ok: true };
      }
    }
  };
  installBulletproofTelegramTransport(mockBot);

  const cbRes = await mockBot.telegram.callApi('answerCallbackQuery', { callback_query_id: '12345' });
  assert.strictEqual(cbRes, true, 'answerCallbackQuery ETIMEDOUT must never crash callback handler!');
  assert.strictEqual(cbAttempts, 2, 'answerCallbackQuery must retry once cleanly before absorbing');

  const msgRes = await mockBot.telegram.callApi('sendMessage', { chat_id: 1, text: 'Hello Boss' });
  assert.strictEqual(msgRes.message_id, 777, 'sendMessage must succeed automatically on retry #2 after ETIMEDOUT');
  assert.strictEqual(sendAttempts, 2, 'sendMessage must retry transiently failed socket automatically');
  console.log('✅ [Incident 1B] Bulletproof Telegram transport retried ETIMEDOUT & absorbed answerCallbackQuery failure with zero [AI-DIAG] crash!');

  // =========================================================================
  // INCIDENT 2 REPRO & VERIFICATION:
  // Exact `Prinshu` Bhagalpur Bihar `JgkQ` Address Message (`<4s` vs `90000ms` p-timeout!)
  // =========================================================================
  const prinshuExactText = `Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/0dqbr4lk.

Address: Panchsheel school left gali last makan, Sabour Road, Bhagalpur, Bihar, India

It is`;

  const tPrinshu = Date.now();
  const prinshuOrder = {
    id: 'ORD2163',
    isForwardedOrder: true,
    isDirectBossOrder: true,
    fwdSenderName: 'Prinshu',
    items: []
  };
  const ingestAddrRes = await ingestForwardedContentIntoOrder(prinshuOrder, { rawText: prinshuExactText });
  const prinshuMs = Date.now() - tPrinshu;
  assert(ingestAddrRes.updatedAddress, 'Must update order address cleanly');
  assert(prinshuMs < 5000, `Expected <5s resolution for Prinshu address, got ${prinshuMs}ms!`);
  assert(prinshuOrder.addressDetails?.lat && prinshuOrder.addressDetails?.lng, 'Must geocode Bhagalpur Bihar coordinates cleanly even without pincode!');
  console.log(`✅ [Incident 2] Verbatim Prinshu Bhagalpur Bihar JgkQ address resolved in ${prinshuMs}ms (${prinshuOrder.addressDetails.lat}, ${prinshuOrder.addressDetails.lng})!`);

  // =========================================================================
  // INCIDENT 3 REPRO & VERIFICATION:
  // Pure Zero-Chromium Token-Only Account + In-Flight `ORD2163` Missing `address_id=""` Self-Heal!
  // =========================================================================
  const baseAuth = await getSwiggySessionAuth(rawAcc, true);
  tokenOnlyAcc = {
    name: 'TokenOnly_9353510170_Sim',
    phone: rawAcc.phone,
    isLoggedIn: true,
    tid: baseAuth.jwtTid,
    token: baseAuth.token,
    sid: baseAuth.sid,
    deviceId: baseAuth.deviceId,
    cookies: '' // Pure token-only JSON account with ZERO _session_tid!
  };

  // Step 3A: Verify Zero-Chromium token-only cross-city Hyderabad `POST /dapi/address` creation + Group Cart sync + self-healing QR!
  const hydAddrProbe = {
    id: 'ORD2163_HYD',
    isForwardedOrder: true,
    isDirectBossOrder: true,
    fwdSenderName: "It's Life",
    items: []
  };
  await ingestForwardedContentIntoOrder(hydAddrProbe, {
    rawText: 'Svr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India'
  });
  const hydSaved = await saveAddressToAccount(tokenOnlyAcc, hydAddrProbe.addressDetails);
  assert(hydSaved?.addressId, 'Must save cross-city Hyderabad address_id on pure token-only account with 0 Chromium!');
  createdAddrIds.push(hydSaved.addressId);

  // Also test full end-to-end Group Cart + brand-new street address save + self-healing QR (`address_id=""` recovery!) with `0` Chromium launches:
  const ord2163 = {
    id: 'ORD2163',
    isForwardedOrder: true,
    isDirectBossOrder: true,
    fwdSenderName: "It's Life",
    items: []
  };
  await ingestForwardedContentIntoOrder(ord2163, {
    rawText: 'https://swig.gy/gc/622166/Adithya-312184336\n\nSvr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India'
  });

  const tSync = Date.now();
  const syncRes = await syncGroupCartAndCheckoutForAccount(tokenOnlyAcc, ord2163);
  const syncMs = Date.now() - tSync;
  assert(syncRes.success, `Expected sync success, got ${JSON.stringify(syncRes)}`);
  assert(ord2163.addressDetails?.id, 'Must create real Swiggy address_id on token-only account via Zero-Chromium HTTP');
  createdAddrIds.push(ord2163.addressDetails.id);
  console.log(`✅ [Incident 3A] Zero-Chromium token-only sync + address creation succeeded in ${syncMs}ms (address_id=${ord2163.addressDetails.id}, total=₹${ord2163.finalPayable})`);

  // ALSO simulate an already-saved legacy `ORD2163` order whose `order.addressDetails.id` was empty (`""`) before deploy!
  delete ord2163.addressDetails.id;
  await swiggyCartFlush(tokenOnlyAcc, { lat: '17.3297', lng: '78.6041' });

  let tQr = Date.now();
  let qrOut;
  try {
    qrOut = await generateRealSwiggyMerchantUpiQr(tokenOnlyAcc, ord2163);
  } catch (closedErr) {
    if (!/closed|out of stock|unserviceable/i.test(String(closedErr?.message || ''))) throw closedErr;
    const triedIds = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const openSpec = await discoverOpen24x7RestaurantOrder(tokenOnlyAcc, {
        addressId: createdAddrIds[0] || null,
        excludeRestaurantIds: triedIds
      });
      if (!openSpec) break;
      triedIds.push(openSpec.restaurantId);
      Object.assign(ord2163, openSpec);
      delete ord2163.groupCartId;
      delete ord2163.cart;
      await syncGroupCartAndCheckoutForAccount(tokenOnlyAcc, ord2163);
      delete ord2163.addressDetails.id;
      await swiggyCartFlush(tokenOnlyAcc, { lat: '17.3297', lng: '78.6041' });
      try {
        tQr = Date.now();
        qrOut = await generateRealSwiggyMerchantUpiQr(tokenOnlyAcc, ord2163);
        break;
      } catch (retryErr) {
        if (attempt === 3 || !/closed|out of stock|unserviceable/i.test(String(retryErr?.message || ''))) throw retryErr;
      }
    }
  }
  const qrMs = Date.now() - tQr;
  if (ord2163.addressDetails?.id && !createdAddrIds.includes(ord2163.addressDetails.id)) {
    createdAddrIds.push(ord2163.addressDetails.id);
  }
  assert(qrMs < 7500, `Expected <7.5s Zero-Chromium self-healing QR generation, got ${qrMs}ms`);
  assert(qrOut.swiggyOrderId && qrOut.upiIntentUrl?.startsWith('upi://pay?'), 'Must generate real Swiggy Dynamic UPI QR');
  assert.strictEqual(Number(qrOut.amount), Number(ord2163.finalPayable), 'QR amount must match Final Bill rupee-for-rupee');

  const qrPng = await generateNamedUpiQrPngBuffer({
    upiUri: qrOut.upiIntentUrl,
    senderName: "It's Life",
    restaurantName: ord2163.restaurantName,
    amount: qrOut.amount,
    orderId: ord2163.id
  });
  const decoded = PNG.sync.read(qrPng);
  const scan = jsQR(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
  assert(scan?.data?.startsWith('upi://pay?'), 'Generated QR PNG must decode cleanly via jsQR');
  assert.strictEqual(puppeteerLaunches, 0, `Expected 0 Chromium launches across entire E2E flow, got ${puppeteerLaunches}!`);
  console.log(`✅ [Incident 3B] Legacy missing-address_id="" order self-healed & generated REAL Swiggy UPI QR in ${qrMs}ms (order_id=${qrOut.swiggyOrderId}, ₹${qrOut.amount}, Chromium launches=${puppeteerLaunches})!`);

  console.log('\n🏆 ALL 3 LIVE RENDER PRODUCTION INCIDENTS VERIFIED 100% FIXED & ZERO-CHROMIUM FAST!');
} finally {
  if (tokenOnlyAcc) {
    await swiggyCartFlush(tokenOnlyAcc, { lat: '17.3297', lng: '78.6041' }).catch(() => {});
    for (const id of createdAddrIds) {
      await dapiFetch(tokenOnlyAcc, 'address/delete', {
        method: 'POST',
        body: { id, address_id: id }
      }).catch(() => null);
    }
  }
  await swiggyCartFlush(rawAcc).catch(() => {});
}
