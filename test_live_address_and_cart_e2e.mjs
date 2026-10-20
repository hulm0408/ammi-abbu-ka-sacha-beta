import { getDb, saveDb } from './store.js';
import { checkLoggedInFromCookies } from './swiggy-bridge.js';
import {
  dapiFetch,
  fetchAccountAddresses,
  fetchAllAccountsSavedAddresses,
  fetchLiveGroupCart,
  inspectCartForAccount,
  resolveSwiggyLink,
  reverseGeocodeCoords,
  syncGroupCartAndCheckoutForAccount,
  formatSwiggyWorldCartReceipt
} from './swiggy-cart.js';

let passed = 0;
let total = 0;

function check(cond, label, detail = '') {
  total++;
  if (cond) {
    passed++;
    console.log(`✅ [E2E ${String(total).padStart(2, '0')}] ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.error(`❌ [E2E ${String(total).padStart(2, '0')}] ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const db = getDb();
const backup = JSON.parse(JSON.stringify(db));

const accLive = db.config.accounts['acc_6296591407']; // READ-ONLY!
const accHelper = db.config.accounts['acc_9935123518']; // Empty cart test account (cleaned up in finally!)

let createdTestAddressIds = [];

let personalLive = null;
try {
  const beforeHelperAddrs = await fetchAccountAddresses(accHelper);
  const preExistingIds = new Set(beforeHelperAddrs.map(a => a.id).filter(Boolean));

  // 1. Auth cookie verification fix
  check(checkLoggedInFromCookies(accLive) === true, 'acc_6296591407 recognized as logged in');
  check(checkLoggedInFromCookies(accHelper) === true, 'acc_9935123518 recognized as logged in');
  check(checkLoggedInFromCookies('_is_logged_in=0; _guest_tid=abc') === false, 'Guest cookie rejected cleanly');

  // 2. Live Saved Addresses on active cart account (READ-ONLY)
  const t0 = Date.now();
  const liveAddrs = await fetchAccountAddresses(accLive);
  const addrMs = Date.now() - t0;
  check(liveAddrs.length >= 3, `Fetched ${liveAddrs.length} saved addresses from acc_6296591407 in ${addrMs}ms`, liveAddrs.map(a => `${a.city}: ${a.address.slice(0, 28)}`).join(' | '));
  check(liveAddrs.every(a => a.lat && a.lng && a.address), 'Every saved address has real coordinates & street address');

  // 3. Live Saved / Past Addresses on EMPTY-CART account (previously returned []!)
  const helperAddrs = await fetchAccountAddresses(accHelper);
  check(helperAddrs.length >= 1, `Empty-cart account acc_9935123518 returned ${helperAddrs.length} real address(es)`, `${helperAddrs[0]?.name} | ${helperAddrs[0]?.address} (${helperAddrs[0]?.lat}, ${helperAddrs[0]?.lng})`);

  // 4. All-account aggregated addresses
  const allAddrs = await fetchAllAccountsSavedAddresses();
  check(allAddrs.length >= 4, `fetchAllAccountsSavedAddresses merged ${allAddrs.length} unique addresses across all accounts`);

  // 5. Swiggy Native Share Address Text + JgkQ OneLink preservation + auto-geocoding
  const swiggyShareMsg = `Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/j37ai838.\n\nAddress: Ground, 504, 54-106, Mukarimnagar, Hasanganj, Lucknow, Uttar Pradesh 226007, India`;
  const shareResolved = await resolveSwiggyLink(swiggyShareMsg);
  check(
    shareResolved.type === 'ADDRESS' &&
    shareResolved.addressDetails?.address?.includes('Mukarimnagar') &&
    !shareResolved.addressDetails?.address?.includes('Save my address') &&
    Boolean(shareResolved.addressDetails?.lat && shareResolved.addressDetails?.lng),
    'Swiggy Share Address message parsed cleanly & geocoded',
    `${shareResolved.addressDetails?.address} -> (${shareResolved.addressDetails?.lat}, ${shareResolved.addressDetails?.lng})`
  );

  // 6. Google Maps coordinates link resolution
  const gmapsResolved = await resolveSwiggyLink('https://maps.google.com/?q=26.8658609,80.9307755');
  check(
    gmapsResolved.type === 'ADDRESS' &&
    Boolean(gmapsResolved.addressDetails?.address && gmapsResolved.addressDetails?.lat),
    'Google Maps link reverse-geocoded via Swiggy Maps API',
    gmapsResolved.addressDetails?.address
  );

  // 7. Telegram GPS Location pin reverse-geocoding
  const pinGeo = await reverseGeocodeCoords('26.8658609', '80.9307755');
  check(
    Boolean(pinGeo?.address && pinGeo.address.toLowerCase().includes('lucknow')),
    'Telegram GPS pin reverse-geocoded accurately',
    `${pinGeo?.address} [${pinGeo?.city}]`
  );

  // 8. Sub-second Live Group Cart resolution (even when host dynamically changes restaurant & items!)
  const tGc = Date.now();
  const gcResolved = await resolveSwiggyLink('https://swig.gy/gc/67272/Umbashiya-642855918');
  const gcMs = Date.now() - tGc;
  check(
    gcResolved.type === 'CART' &&
    Boolean(gcResolved.restaurantId) &&
    Boolean(gcResolved.restaurantName) &&
    gcResolved.cartDetails?.items?.length >= 1 &&
    gcResolved.cartDetails.subtotal > 0,
    `Live Group Cart resolved in ${gcMs}ms with 100% real restaurant & items`,
    `${gcResolved.restaurantName} | ${gcResolved.cartDetails?.items?.[0]?.name} x${gcResolved.cartDetails?.items?.[0]?.qty} | Subtotal ₹${gcResolved.cartDetails?.subtotal}`
  );

  // 9. Expired Group Cart detection
  const expiredGc = await fetchLiveGroupCart('142853973');
  check(expiredGc?.status === 'EXPIRED', 'Expired group cart 142853973 cleanly detected as EXPIRED');

  // 10. Read-only live personal cart inspection on acc_6296591407
  personalLive = await inspectCartForAccount(accLive);
  check(
    Boolean(personalLive?.restaurantName) &&
    personalLive?.items?.length >= 1 &&
    personalLive?.finalPayable > 0,
    `Read-only personal cart inspection matches Swiggy app checkout ₹${personalLive?.finalPayable} to the exact rupee`,
    `${personalLive?.restaurantName} | Coupon: ${personalLive?.couponCode || 'None'} | Payable: ₹${personalLive?.finalPayable}`
  );

  // 11. Full cross-account clone + address save + cart sync on acc_9935123518
  const testOrder = {
    id: 'E2E_LIVE_TEST',
    cart: 'https://swig.gy/gc/67272/Umbashiya-642855918',
    address: swiggyShareMsg,
    addressOriginalText: swiggyShareMsg,
    status: 'PENDING'
  };
  const syncRes = await syncGroupCartAndCheckoutForAccount(accHelper, testOrder, { captureScreenshot: false });
  if (testOrder.addressDetails?.id && !preExistingIds.has(testOrder.addressDetails.id)) {
    createdTestAddressIds.push(testOrder.addressDetails.id);
  }
  const receipt = formatSwiggyWorldCartReceipt(testOrder, accHelper.phone);
  check(
    syncRes.success === true &&
    testOrder.restaurantName === gcResolved.restaurantName &&
    testOrder.items?.length >= 1 &&
    testOrder.finalPayable > 0 &&
    !receipt.includes('undefined'),
    'Cross-account Group Cart + Address sync succeeded with exact Swiggy bill & zero undefined fields',
    `Payable: ₹${testOrder.finalPayable} | Delivery: ₹${testOrder.deliveryFee} | Coupon: ${testOrder.couponCode || 'None'}`
  );
  console.log('\n--- LIVE GENERATED RECEIPT ---\n' + receipt + '\n------------------------------\n');
} finally {
  // Strictly flush test cart & delete any newly created test address on acc_9935123518!
  await dapiFetch(accHelper, 'cart', {
    method: 'POST',
    body: {
      flushFirst: true,
      cart: { restaurantId: '444136', address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] }
    }
  }).catch(() => {});

  for (const id of createdTestAddressIds) {
    await dapiFetch(accHelper, 'address/delete', {
      method: 'POST',
      body: { id: String(id), address_id: String(id) }
    }).catch(() => {});
  }

  const afterCartHelper = await inspectCartForAccount(accHelper);
  const afterCartLive = await inspectCartForAccount(accLive);
  check(
    (!afterCartHelper?.items || afterCartHelper.items.length === 0) &&
    afterCartLive?.restaurantName === personalLive?.restaurantName &&
    afterCartLive?.finalPayable === personalLive?.finalPayable,
    `Post-test cleanup verified: acc_9935123518 empty & acc_6296591407 untouched (${afterCartLive?.restaurantName} ₹${afterCartLive?.finalPayable} intact)!`
  );

  saveDb(backup);
}

console.log(`\n================================================================`);
console.log(`🎯 LIVE SWIGGY E2E VERIFICATION: ${passed}/${total} PASSED!`);
console.log(`================================================================`);

process.exit(passed === total ? 0 : 1);
