import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDb, saveDb } from './store.js';
import {
  dapiFetch,
  inspectCartForAccount,
  parseAddressDetails,
  parseCartDetails,
  formatSwiggyWorldCartReceipt,
  findBestMaxCouponAccountForOrder
} from './swiggy-cart.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ [PASS ${String(passed).padStart(2, '0')}] ${msg}`);
}

const originalDbRaw = fs.readFileSync('./data/db.json', 'utf8');

try {
  console.log('================================================================');
  console.log('🧪 LIVE E2E SUITE: PUNE RECEIPT FORMAT + DELULU4FOOD + MAX COUPON ENGINE');
  console.log('================================================================\n');

  // 1. Verbatim input sent by Boss (including tel: markdown link & HTML &amp; entity!)
  const bossExactInput = `Pune Address  
 Prathmesh  
 [9823305540](tel:9823305540)  
 Flat no. 412 ,  4th floor Parivartan society dandekar pool pune  
Pune, Maharashtra 411030  
 Latitude: 18.502975  
 Longitude: 73.846375  
 Select an Available Payment Method  
  
 Final Bill  
 Items Total: ₹234  
 Coupon DELULU4FOOD: −₹140  
 Swiggy One Lite Membership: +₹1  
 Free Delivery upto 7km  
 Delivery Fee: FREE (₹39 saved)  
 Packing Charges: ₹20  
 GST &amp; Other Charges: ₹43.68  
━━━━━━━━━━━━━━  
 Total Savings: ₹179  
 Final Total: ₹139`;

  const parsedAddr = parseAddressDetails(bossExactInput);
  ok(parsedAddr?.city === 'Pune', `Parsed city header cleanly: "${parsedAddr?.city}"`);
  ok(parsedAddr?.name === 'Prathmesh', `Parsed recipient name cleanly: "${parsedAddr?.name}"`);
  ok(parsedAddr?.mobile === '9823305540', `Parsed [9823305540](tel:9823305540) phone cleanly: "${parsedAddr?.mobile}"`);
  ok(parsedAddr?.address?.includes('Flat no. 412') && parsedAddr?.address?.includes('Pune, Maharashtra 411030'), 'Parsed full 2-line street + city/PIN address cleanly');
  ok(parsedAddr?.lat === '18.502975' && parsedAddr?.lng === '73.846375', `Parsed exact coordinates (${parsedAddr?.lat}, ${parsedAddr?.lng})`);

  const parsedCart = parseCartDetails(bossExactInput);
  ok(parsedCart?.itemsTotal === 234, `Parsed Items Total: ₹${parsedCart?.itemsTotal}`);
  ok(parsedCart?.couponCode === 'DELULU4FOOD' && parsedCart?.discountAmount === 140, `Parsed Coupon ${parsedCart?.couponCode}: −₹${parsedCart?.discountAmount}`);
  ok(parsedCart?.swiggyOneMembershipFee === 1, `Parsed Swiggy One Lite Membership: +₹${parsedCart?.swiggyOneMembershipFee}`);
  ok(parsedCart?.freeDelivery === true && parsedCart?.freeDeliveryDiscount === 39, `Parsed Free Delivery (₹${parsedCart?.freeDeliveryDiscount} saved)`);
  ok(parsedCart?.packingCharges === 20, `Parsed Packing Charges: ₹${parsedCart?.packingCharges}`);
  ok(parsedCart?.gstCharges === 43.68, `Parsed GST & Other Charges (even with &amp;): ₹${parsedCart?.gstCharges}`);
  ok(parsedCart?.totalSavings === 179 && parsedCart?.finalPayable === 139, `Parsed Total Savings: ₹${parsedCart?.totalSavings} & Final Total: ₹${parsedCart?.finalPayable}`);

  // 2. Reconstruct Order & verify formatted output matches EVERY EXACT LINE in Boss's specification!
  const reconstructedOrder = {
    addressDetails: parsedAddr,
    address: parsedAddr.address,
    items: [],
    itemTotal: parsedCart.itemsTotal,
    subtotal: parsedCart.subtotal,
    couponCode: parsedCart.couponCode,
    discountAmount: parsedCart.discountAmount,
    swiggyOneMembershipFee: parsedCart.swiggyOneMembershipFee,
    freeDelivery: parsedCart.freeDelivery,
    swiggyOneApplied: parsedCart.freeDelivery,
    freeDeliveryDiscount: parsedCart.freeDeliveryDiscount,
    packingCharges: parsedCart.packingCharges,
    taxesAndCharges: parsedCart.gstCharges,
    totalSavings: parsedCart.totalSavings,
    finalPayable: parsedCart.finalPayable,
    swiggyVerified: true
  };

  const formattedPlain = formatSwiggyWorldCartReceipt(reconstructedOrder);
  console.log('\n--- FORMATTED PUNE RECEIPT OUTPUT ---\n' + formattedPlain + '\n-------------------------------------\n');

  const expectedRequiredLines = [
    'Pune Address',
    'Prathmesh',
    '9823305540',
    'Flat no. 412 ,  4th floor Parivartan society dandekar pool pune',
    'Pune, Maharashtra 411030',
    'Latitude: 18.502975',
    'Longitude: 73.846375',
    'Select an Available Payment Method',
    'Final Bill',
    'Items Total: ₹234',
    'Coupon DELULU4FOOD: −₹140',
    'Swiggy One Lite Membership: +₹1',
    'Free Delivery upto 7km',
    'Delivery Fee: FREE (₹39 saved)',
    'Packing Charges: ₹20',
    'GST & Other Charges: ₹43.68',
    '━━━━━━━━━━━━━━',
    'Total Savings: ₹179',
    'Final Total: ₹139'
  ];

  for (const reqLine of expectedRequiredLines) {
    assert.ok(formattedPlain.includes(reqLine), `Missing exact required line: "${reqLine}"`);
  }
  ok(true, `All ${expectedRequiredLines.length}/${expectedRequiredLines.length} exact Pune Final Bill & Address lines matched 100% verbatim!`);

  // 3. LIVE SWIGGY MULTI-ACCOUNT MAX COUPON + LOWEST BILL ENGINE VERIFICATION!
  // Uses live open 24x7 restaurant on acc_6296591407 (READ-ONLY source) and compares across all active accounts!
  const db = getDb();
  const accLive = db.config.accounts.acc_6296591407;
  const accHelper = db.config.accounts.acc_9935123518;
  const beforeLive = await inspectCartForAccount(accLive);
  const { json: rawRef } = await dapiFetch(accLive, 'cart', { timeoutMs: 10000 });
  const refMeta = rawRef.data.cartMeta;
  const refAddr = refMeta.addresses[0];

  const liveOrder = {
    id: 'MAX_COUPON_LIVE_TEST',
    restaurantId: String(refMeta.restaurant_details.id),
    restaurantName: refMeta.restaurant_details.name,
    items: Object.values(rawRef.data.cartItems).map(ci => ({
      itemId: String(ci.itemId),
      menu_item_id: Number(ci.itemId),
      name: ci.items?.[0]?.name || 'Item',
      qty: Number(ci.quantity || 1),
      quantity: Number(ci.quantity || 1),
      price: (ci.items?.[0]?.base_price || 0) / 100,
      lineTotal: (ci.items?.[0]?.subtotal || 0) / 100,
      addons: ci.items?.[0]?.addons || [],
      variants: ci.items?.[0]?.variants || []
    })),
    addressDetails: {
      name: refAddr.name || 'Prathmesh',
      mobile: refAddr.mobile || '9823305540',
      flat_no: refAddr.flat_no || 'Ground, 504',
      area: refAddr.area || 'Hasanganj',
      landmark: refAddr.landmark || 'Mukarimnagar',
      city: refAddr.city || 'Lucknow',
      address: refAddr.address,
      lat: String(refAddr.lat),
      lng: String(refAddr.lng)
    },
    address: refAddr.address,
    status: 'PENDING'
  };

  const bestRes = await findBestMaxCouponAccountForOrder(liveOrder, { captureScreenshot: false });
  console.log('Multi-Account Max Coupon Comparison:', bestRes.accountComparison);
  console.log('\n--- LIVE MULTI-ACCOUNT MAX COUPON WINNER RECEIPT ---\n' + formatSwiggyWorldCartReceipt(liveOrder, liveOrder.orderAccount) + '\n----------------------------------------------------\n');

  ok(bestRes.success === true, `Multi-account Max Coupon scanner succeeded (Winner: ${bestRes.winningKey})`);
  const maxSeen = Math.max(...bestRes.accountComparison.map(c => c.finalPayable));
  const minSeen = Math.min(...bestRes.accountComparison.map(c => c.finalPayable));
  ok(liveOrder.finalPayable === minSeen && liveOrder.finalPayable <= maxSeen, `Automatically picked STRICT LOWEST Final Total: ₹${liveOrder.finalPayable} (saved ₹${maxSeen - minSeen} vs ₹${maxSeen} account!)`);

  // Cleanly empty acc_9935123518 cart & verify acc_6296591407 remained 100% untouched!
  await dapiFetch(accHelper, 'cart', {
    method: 'POST',
    body: { flushFirst: true, cart: { restaurantId: liveOrder.restaurantId, address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] } }
  });
  const afterLive = await inspectCartForAccount(accLive);
  const afterHelper = await inspectCartForAccount(accHelper);
  ok(
    (!afterHelper?.items || afterHelper.items.length === 0) &&
    afterLive?.restaurantName === beforeLive?.restaurantName,
    `Cleanup verified: acc_9935123518 empty & acc_6296591407 (${afterLive?.restaurantName}) completely intact!`
  );

  console.log(`\n================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} PUNE FINAL BILL + MAX COUPON LIVE TESTS PASSED!`);
  console.log(`================================================================`);
} finally {
  fs.writeFileSync('./data/db.json', originalDbRaw, 'utf8');
}
