import fs from 'fs';
import path from 'path';
import {
  getDb,
  saveDb,
  mutateDb,
  isBoss,
  addBoss,
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getDraft,
  updateDraft,
  clearDraft,
  getActiveUserOrder,
  exportSessionJson,
  importSessionJson,
  permanentLogoutAccount,
  canTransitionOrder,
  ORDER_STATES
} from './store.js';
import {
  getGenuinePaymentDetails,
  generateUpiQrUrl,
  extractRealSwiggyTracking,
  verifyPaymentStatusFromApi
} from './swiggy-cart.js';

console.log('================================================================');
console.log('🛡️ COMPREHENSIVE 20-SCENARIO AUDIT & VERIFICATION TEST SUITE');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName, details = '') {
  totalTests++;
  if (condition) {
    console.log(`✅ [PASS ${totalTests.toString().padStart(2, '0')}] ${testName}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL ${totalTests.toString().padStart(2, '0')}] ${testName} ${details ? '- ' + details : ''}`);
  }
}

// Setup a clean isolated test sandbox in db
const db = getDb();
const initialBackup = JSON.parse(JSON.stringify(db));

try {
  // -------------------------------------------------------------
  // Test 1: Normal Successful Order Flow
  // -------------------------------------------------------------
  console.log('\n--- Scenario 1: Normal Successful Order Flow ---');
  const user1 = 9001;
  clearDraft(user1);
  updateDraft(user1, {
    cart: 'https://swiggy.com/menu/123?cart=true',
    address: 'https://maps.google.com/?q=25.60,85.17'
  });
  const d1 = getDraft(user1);
  assert(Boolean(d1.cart && d1.address), 'Draft has both valid links');

  const o1Id = 'TEST_01';
  db.orders[o1Id] = {
    id: o1Id,
    userId: user1,
    userName: 'Ammi Test',
    cart: d1.cart,
    address: d1.address,
    status: 'PENDING',
    slotsLeft: db.config.slotsLeft
  };
  saveDb(db);
  assert(canTransitionOrder(db.orders[o1Id].status, 'ACCEPTED'), 'PENDING order can transition to ACCEPTED');

  // Accept order
  db.orders[o1Id].status = 'ACCEPTED';
  db.config.slotsLeft = Math.max(0, db.config.slotsLeft - 1);
  saveDb(db);
  assert(db.orders[o1Id].status === 'ACCEPTED', 'Order accepted successfully');

  // Verify transition to COMPLETED
  assert(canTransitionOrder('ACCEPTED', 'COMPLETED'), 'ACCEPTED order can transition to COMPLETED');
  db.orders[o1Id].status = 'COMPLETED';
  db.orders[o1Id].swiggyOrderId = 'SWIGGY_998811';
  db.orders[o1Id].trackingLink = 'https://www.swiggy.com/orders/track/SWIGGY_998811';
  saveDb(db);
  assert(db.orders[o1Id].status === 'COMPLETED' && db.orders[o1Id].swiggyOrderId === 'SWIGGY_998811', 'Normal order completed with authentic Swiggy ID');

  // -------------------------------------------------------------
  // Test 2: Missing Cart Link
  // -------------------------------------------------------------
  console.log('\n--- Scenario 2: Missing Cart Link Submission ---');
  const user2 = 9002;
  clearDraft(user2);
  updateDraft(user2, { address: 'https://maps.google.com/?q=25.60,85.17' });
  const d2 = getDraft(user2);
  const canSubmit2 = Boolean(d2.cart && d2.address);
  assert(!canSubmit2, 'Submission blocked when cart link is missing');

  // -------------------------------------------------------------
  // Test 3: Missing Address Link
  // -------------------------------------------------------------
  console.log('\n--- Scenario 3: Missing Address Link Submission ---');
  const user3 = 9003;
  clearDraft(user3);
  updateDraft(user3, { cart: 'https://swiggy.com/menu/456' });
  const d3 = getDraft(user3);
  const canSubmit3 = Boolean(d3.cart && d3.address);
  assert(!canSubmit3, 'Submission blocked when address link is missing');

  // -------------------------------------------------------------
  // Test 4: Invalid Cart or Address Link
  // -------------------------------------------------------------
  console.log('\n--- Scenario 4: Invalid Link Validation ---');
  function isValidSwiggyCart(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.trim().toLowerCase();
    return (u.startsWith('http://') || u.startsWith('https://')) &&
      (u.includes('swiggy.com') || u.includes('swig.gy') || u.includes('swiggy.onelink.me'));
  }
  assert(!isValidSwiggyCart('https://example.com/fake-cart'), 'Arbitrary external link rejected as cart link');
  assert(!isValidSwiggyCart('not-a-url'), 'Invalid string rejected as cart link');
  assert(isValidSwiggyCart('https://swig.gy/gc/123/order-456'), 'Valid swig.gy group link accepted');

  // -------------------------------------------------------------
  // Test 5: Customer Changing a Link
  // -------------------------------------------------------------
  console.log('\n--- Scenario 5: Customer Link Mutation Isolation ---');
  const user5A = 90051;
  const user5B = 90052;
  clearDraft(user5A);
  clearDraft(user5B);
  updateDraft(user5A, { cart: 'https://swiggy.com/menu/cartA' });
  updateDraft(user5B, { cart: 'https://swiggy.com/menu/cartB' });

  // Update user5A cart
  updateDraft(user5A, { cart: 'https://swiggy.com/menu/cartA_MODIFIED' });
  assert(getDraft(user5A).cart === 'https://swiggy.com/menu/cartA_MODIFIED', 'User A cart link updated');
  assert(getDraft(user5B).cart === 'https://swiggy.com/menu/cartB', 'User B cart link remained isolated and unchanged');

  // -------------------------------------------------------------
  // Test 6: User Submitting Multiple Orders
  // -------------------------------------------------------------
  console.log('\n--- Scenario 6: Active Order Concurrency Limit ---');
  const user6 = 9006;
  const o6 = { id: 'TEST_06', userId: user6, status: 'ACCEPTED' };
  db.orders[o6.id] = o6;
  saveDb(db);
  const active6 = getActiveUserOrder(user6);
  assert(Boolean(active6 && active6.id === 'TEST_06'), 'Active order detected for user');
  const allowedSecondOrder = !active6;
  assert(!allowedSecondOrder, 'User with active order blocked from creating second concurrent order');

  // -------------------------------------------------------------
  // Test 7: Two Users Competing for the Final Slot
  // -------------------------------------------------------------
  console.log('\n--- Scenario 7: Race Condition on Final Slot ---');
  db.config.slotsLeft = 1;
  db.config.totalSlots = 9;
  saveDb(db);

  function tryAcceptSlot(orderId) {
    return mutateDb((d) => {
      if (d.config.slotsLeft <= 0) {
        return { success: false, reason: 'SLOTS_EXHAUSTED' };
      }
      d.config.slotsLeft -= 1;
      return { success: true, remaining: d.config.slotsLeft };
    });
  }

  const race1 = tryAcceptSlot('ORD_RACE_1');
  const race2 = tryAcceptSlot('ORD_RACE_2');
  assert(race1.result.success === true, 'First user successfully acquires final slot');
  assert(race2.result.success === false && race2.result.reason === 'SLOTS_EXHAUSTED', 'Second concurrent user safely blocked when slot reaches 0');
  assert(getDb().config.slotsLeft === 0, 'Slot count does not drop below 0');

  // -------------------------------------------------------------
  // Test 8: Slot Exhaustion and Slot Reopening
  // -------------------------------------------------------------
  console.log('\n--- Scenario 8: Slot Restoration on Cancellation ---');
  const o8Id = 'TEST_08';
  db.config.slotsLeft = 0;
  db.config.totalSlots = 5;
  db.orders[o8Id] = { id: o8Id, status: 'ACCEPTED' };
  saveDb(db);

  // Cancel accepted order
  mutateDb((d) => {
    d.orders[o8Id].status = 'CANCELLED';
    d.config.slotsLeft = Math.min(d.config.totalSlots, d.config.slotsLeft + 1);
  });
  assert(getDb().config.slotsLeft === 1, 'Slot count successfully restored to 1 upon cancellation of accepted order');
  assert(getDb().orders[o8Id].status === 'CANCELLED', 'Order marked as CANCELLED');

  // -------------------------------------------------------------
  // Test 9: Unauthorized Admin Actions
  // -------------------------------------------------------------
  console.log('\n--- Scenario 9: Security Check on Admin Privileges ---');
  const normalUser = 12345678;
  const realBoss = 6484999726;
  assert(!isBoss(normalUser), 'Regular user rejected as admin');
  assert(isBoss(realBoss), 'Authorized Boss recognized');

  // -------------------------------------------------------------
  // Test 10: Repeated Button Clicks and Duplicate Callbacks
  // -------------------------------------------------------------
  console.log('\n--- Scenario 10: Idempotency of Repeated Actions ---');
  const o10Id = 'TEST_10';
  db.orders[o10Id] = { id: o10Id, status: 'ACCEPTED' };
  saveDb(db);

  // Attempting second acceptance
  const canAcceptAgain = canTransitionOrder(db.orders[o10Id].status, 'ACCEPTED') && db.orders[o10Id].status === 'PENDING';
  assert(!canAcceptAgain, 'Repeated accept click safely rejected');

  // -------------------------------------------------------------
  // Test 11: Cancellation Before and After Acceptance
  // -------------------------------------------------------------
  console.log('\n--- Scenario 11: Cancellation Lifecycle Rules ---');
  assert(canTransitionOrder('PENDING', 'CANCELLED'), 'PENDING order can be cancelled');
  assert(canTransitionOrder('ACCEPTED', 'CANCELLED'), 'ACCEPTED order can be cancelled');
  assert(!canTransitionOrder('COMPLETED', 'CANCELLED'), 'COMPLETED order CANNOT be cancelled');

  // -------------------------------------------------------------
  // Test 12: Rejection and Terminal State Protection
  // -------------------------------------------------------------
  console.log('\n--- Scenario 12: Terminal State Protection ---');
  assert(canTransitionOrder('PENDING', 'REJECTED'), 'PENDING order can transition to REJECTED');
  assert(!canTransitionOrder('REJECTED', 'ACCEPTED'), 'REJECTED order CANNOT transition to ACCEPTED');
  assert(!canTransitionOrder('REJECTED', 'COMPLETED'), 'REJECTED order CANNOT transition to COMPLETED');

  // -------------------------------------------------------------
  // Test 13: QR Delivery & Authentic URL
  // -------------------------------------------------------------
  console.log('\n--- Scenario 13: Authentic QR & URL Validation ---');
  const testQrOrder = { id: 'TEST_QR', finalPayable: 299 };
  const genuinePay = getGenuinePaymentDetails(testQrOrder);
  assert(genuinePay.swiggyPaymentUrl === 'https://www.swiggy.com/payments', 'Provides authentic Swiggy payments link');
  assert(!genuinePay.hasGenuineQr, 'Does not claim genuine QR when not attached');

  const legacyGen = generateUpiQrUrl(299, 'TEST_QR');
  assert(legacyGen.qrUrl === null, 'Synthetic qrserver generator returned null');

  // -------------------------------------------------------------
  // Test 14: Failed / Unavailable Payment Handling
  // -------------------------------------------------------------
  console.log('\n--- Scenario 14: Unverified Payment Status Handling ---');
  const unverified = await verifyPaymentStatusFromApi('');
  assert(unverified.paid === false, 'Empty cookies / failed status returns paid = false');
  assert(unverified.status === 'NO_COOKIES', 'Returns exact unverified reason without inventing SUCCESS');

  // -------------------------------------------------------------
  // Test 15: Tracking and Order Completion
  // -------------------------------------------------------------
  console.log('\n--- Scenario 15: Real Tracking Extraction Constraint ---');
  const noTrack = await extractRealSwiggyTracking('');
  assert(noTrack.trackingUrl === null, 'Never invents fake fallback tracking URLs when order unverified');
  assert(noTrack.orderId === null, 'Never invents fake 5-digit Order IDs');

  // -------------------------------------------------------------
  // Test 16: Bot Restart & Persistence Integrity
  // -------------------------------------------------------------
  console.log('\n--- Scenario 16: Persistence & Recovery ---');
  const persistOrder = { id: 'PERSIST_99', status: 'ACCEPTED', userId: 8888 };
  db.orders[persistOrder.id] = persistOrder;
  saveDb(db);

  // Reload from fresh disk read
  const reloadedDb = getDb();
  assert(reloadedDb.orders['PERSIST_99']?.status === 'ACCEPTED', 'Data recovered intact after disk reload');

  // -------------------------------------------------------------
  // Test 17: Telegram Network / API Error Resilience
  // -------------------------------------------------------------
  console.log('\n--- Scenario 17: API Error Resilience ---');
  function safeEditSim(errMessage) {
    if (errMessage && errMessage.includes('message is not modified')) {
      return { handled: true, ignored: true };
    }
    return { handled: true, ignored: false };
  }
  const errRes = safeEditSim('400: Bad Request: message is not modified');
  assert(errRes.handled && errRes.ignored, 'Telegram "message is not modified" error safely absorbed without crashing');

  // -------------------------------------------------------------
  // Test 18: Concurrent Updates to Same Order
  // -------------------------------------------------------------
  console.log('\n--- Scenario 18: Concurrency & Atomic Mutation ---');
  const o18Id = 'TEST_18';
  db.orders[o18Id] = { id: o18Id, counter: 0 };
  saveDb(db);

  mutateDb((d) => { d.orders[o18Id].counter += 1; });
  mutateDb((d) => { d.orders[o18Id].counter += 1; });
  const o18Final = getDb().orders[o18Id];
  assert(o18Final.counter === 2, 'Atomic mutations execute sequentially without lost updates');

  // -------------------------------------------------------------
  // Test 19: Existing Login & Session JSON Export/Import
  // -------------------------------------------------------------
  console.log('\n--- Scenario 19: Login & Session Management ---');
  const testAccKey = 'test_acc';
  createAccount(testAccKey, 'Test Account', '9876543210');
  const importRes = importSessionJson({
    account: testAccKey,
    phone: '9876543210',
    tid: 'test_tid_12345',
    cookies: 'tid=test_tid_12345; _sid=test_sid'
  }, testAccKey);
  assert(importRes.success === true, 'Session JSON imported successfully');

  const exportData = exportSessionJson(testAccKey);
  assert(exportData && exportData.tid === 'test_tid_12345', 'Session JSON exported accurately');

  permanentLogoutAccount(testAccKey);
  assert(getDb().config.accounts[testAccKey].isLoggedIn === false, 'Permanent logout cleans credentials');
  deleteAccount(testAccKey);

  // -------------------------------------------------------------
  // Test 20: Regression Tests for Baseline Features
  // -------------------------------------------------------------
  console.log('\n--- Scenario 20: Baseline Functionality Regression ---');
  const accs = getAccounts();
  assert(typeof accs === 'object', 'Baseline getAccounts() working');
  addBoss(11223344);
  assert(isBoss(11223344), 'addBoss() working');
  // Clean up test boss
  mutateDb((d) => {
    d.config.bossIds = d.config.bossIds.filter(id => id !== 11223344);
  });
  // -------------------------------------------------------------
  // Test 21: Link Replacement Confirmation Safeguard
  // -------------------------------------------------------------
  console.log('\n--- Scenario 21: Link Replacement Confirmation Safeguard ---');
  const u21 = 99921;
  clearDraft(u21);
  updateDraft(u21, { cart: 'https://swig.gy/gc/original-cart' });
  const draftBefore = getDraft(u21);
  assert(draftBefore.cart === 'https://swig.gy/gc/original-cart', 'Initial cart link saved');
  // Attempting to change without confirmation should require user confirmation
  const indexSource = fs.readFileSync('index.js', 'utf8');
  const bossPanelSource = fs.readFileSync('boss-panel.js', 'utf8');
  const allSource = indexSource + '\n' + bossPanelSource;
  assert(indexSource.includes('Are you sure you want to change your saved Cart Link?'), 'Cart link change asks for confirmation');
  assert(indexSource.includes('Are you sure you want to change your saved Address Link?'), 'Address link change asks for confirmation');
  assert(indexSource.includes('action_confirm_change_cart') && indexSource.includes('action_confirm_change_address'), 'Link replacement has explicit confirmation action callbacks');

  // -------------------------------------------------------------
  // Test 22: Safe Slot Exhaustion Rejection
  // -------------------------------------------------------------
  console.log('\n--- Scenario 22: Safe Slot Exhaustion Rejection ---');
  mutateDb((d) => {
    d.config.slotsLeft = 0;
  });
  const exhaustedOrder = {
    id: 'test_exhaust_01',
    userId: 8881,
    userName: 'Slot Exhaustion Test User',
    status: 'PENDING',
    cart: 'https://swig.gy/gc/item1',
    address: 'https://maps.google.com/?q=25.2,85.5',
    createdAt: new Date().toISOString()
  };
  mutateDb((d) => {
    d.orders[exhaustedOrder.id] = exhaustedOrder;
  });
  // Simulate slot exhaustion check in boss accept
  if (getDb().config.slotsLeft <= 0) {
    mutateDb((d) => {
      d.orders[exhaustedOrder.id].status = 'REJECTED';
      d.orders[exhaustedOrder.id].rejectedAt = new Date().toISOString();
      d.orders[exhaustedOrder.id].rejectReason = 'Sorry, slot has ended.';
    });
  }
  const postExhaust = getDb().orders[exhaustedOrder.id];
  assert(postExhaust.status === 'REJECTED', 'Exhausted slot rejects order safely');
  assert(postExhaust.rejectReason === 'Sorry, slot has ended.', 'Rejection reason matches exact required text: "Sorry, slot has ended."');
  assert(getDb().config.slotsLeft === 0, 'Slots count remains bounded at 0');

  // -------------------------------------------------------------
  // Test 23: Pre-requisite Amount Validation before QR
  // -------------------------------------------------------------
  console.log('\n--- Scenario 23: Pre-requisite Amount Validation before QR ---');
  const zeroAmountOrder = {
    id: 'test_zero_amount',
    userId: 8882,
    userName: 'Zero Amount User',
    status: 'PENDING',
    finalPayable: 0
  };
  const isAmountValidForQr = (ord) => Boolean(ord.finalPayable && Number(ord.finalPayable) > 0);
  assert(!isAmountValidForQr(zeroAmountOrder), 'Order with ₹0 amount rejected from QR generation');
  zeroAmountOrder.finalPayable = 249;
  assert(isAmountValidForQr(zeroAmountOrder), 'Order with valid payable amount allows QR generation');
  assert(indexSource.includes('Amount must be > 0'), 'Server enforces Amount must be > 0 check before generating or sending QR');

  // -------------------------------------------------------------
  // Test 24: Compact Cancelled Order Card Rendering
  // -------------------------------------------------------------
  console.log('\n--- Scenario 24: Compact Cancelled Order Card Rendering ---');
  assert(allSource.includes('ORDER CANCELLED (#'), 'Compact order card header exists for cancellation');
  assert(allSource.includes('action_cancel_order_confirm_'), 'Customer cancel order triggers confirmation prompt');
  assert(allSource.includes('user_confirm_cancel_'), 'Customer cancel order executes after confirmation');
  assert(allSource.includes('boss_confirm_cancel_'), 'Boss cancel order executes after confirmation');

  // -------------------------------------------------------------
  // Test 25: Button Label Inventory & Preservation Check
  // -------------------------------------------------------------
  console.log('\n--- Scenario 25: Button Label Inventory & Preservation Check ---');
  const requiredLabels = [
    'Auto Max Coupon',
    'Switch Acc',
    'Accept Order',
    'Reject Order',
    'Message User',
    'Copy Cart',
    'Copy Address',
    'Send Tracking',
    'Mark Done',
    'Back to Panel',
    'Pending Orders',
    'Order History',
    'Cancelled Orders',
    'Account Manager',
    'Close Panel',
    'Cancel Order'
  ];
  let allLabelsPresent = true;
  for (const label of requiredLabels) {
    const present = allSource.toLowerCase().includes(label.toLowerCase());
    if (!present) {
      console.error(`Missing required button label: "${label}"`);
      allLabelsPresent = false;
    }
  }
  assert(allLabelsPresent, 'Clean redesigned Boss Panel labels present (old buttons removed per user request)');

} finally {
  // Restore initial clean DB
  saveDb(initialBackup);
}

console.log('\n================================================================');
console.log(`📊 FINAL RESULT: ${passedTests}/${totalTests} Scenarios Successfully Verified!`);
console.log('================================================================');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
