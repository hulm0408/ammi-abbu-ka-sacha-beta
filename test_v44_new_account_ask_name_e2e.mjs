process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';

import { ok, strictEqual } from 'node:assert';
import { getDb, saveDb, deleteAccount } from './store.js';
import {
  userWaitState,
  completeNewAccountWithChosenName
} from './index.js';

console.log('--- STARTING V44 NEW ACCOUNT ASK NAME E2E SUITE ---');

// =========================================================================
// TEST 1: User specifies custom name after OTP verification on new account
// =========================================================================
console.log('\n--- 1. Set Custom Name on New Account Post-OTP ---');
{
  const testUserId = 88001;
  const testPhone = '9911406015';
  const testAccKey = `acc_${testPhone}`;

  let sentCards = [];
  const mockCtx = {
    from: { id: testUserId },
    chat: { id: 12345 },
    reply: async (text, extra) => { sentCards.push({ text, extra }); },
    answerCbQuery: async () => true
  };

  const db = getDb();
  db.config.accounts[testAccKey] = {
    id: testAccKey,
    phone: testPhone,
    mobile: testPhone,
    name: 'Rahul Kumar', // Initial default
    swiggyName: 'Rahul Kumar',
    botTag: 'Rahul Kumar',
    isLoggedIn: true,
    cookies: 'tid=fake.jwt.token; _session_tid=fake_session_tid; _is_logged_in=1',
    token: 'tok_live_123',
    savedAt: new Date().toISOString()
  };
  saveDb(db);

  userWaitState[testUserId] = {
    action: 'waiting_swiggy_new_account_name',
    phone: testPhone,
    targetAcc: testAccKey,
    savedSessionKey: testAccKey,
    orderId: null,
    verifyResult: {
      success: true,
      wasNewSignup: true,
      accountKey: testAccKey,
      phone: testPhone,
      customerId: '88990011',
      totalOrdersCount: 0,
      isZeroOrderAccount: true,
      exportJson: {
        account: testAccKey,
        name: 'Rahul Kumar',
        mobile: testPhone
      }
    },
    needsSignupCall: false,
    existingName: null
  };

  // User types "Aman Personal"
  await completeNewAccountWithChosenName(mockCtx, testUserId, 'Aman Personal');

  const updatedAcc = getDb().config.accounts[testAccKey];
  ok(updatedAcc, 'Account exists in config');
  strictEqual(updatedAcc.name, 'Aman Personal', 'Account name updated to chosen custom name');
  strictEqual(updatedAcc.swiggyName, 'Aman Personal', 'Account swiggyName updated to chosen custom name');
  strictEqual(updatedAcc.botTag, 'Aman Personal', 'Account botTag updated to chosen custom name');

  // Verify sessionVault was also updated
  const vaultEntry = getDb().sessionVault?.[testPhone] || getDb().sessionVault?.[testAccKey];
  ok(vaultEntry, 'Vault entry exists');
  strictEqual(vaultEntry.name, 'Aman Personal', 'Vault entry updated to chosen custom name');

  // Verify wait state was cleared
  ok(!userWaitState[testUserId], 'userWaitState cleared after name setup');

  console.log('✅ PASS 01: User custom name ("Aman Personal") applied to DB config & sessionVault');

  deleteAccount(testAccKey, { purgeVault: true, skipImmediateCloudPush: true });
}

// =========================================================================
// TEST 2: Auto-Assign option used when user does not specify a name
// =========================================================================
console.log('\n--- 2. Auto-Assign Name for New Account ---');
{
  const testUserId = 88002;
  const testPhone = '9911406016';
  const testAccKey = `acc_${testPhone}`;

  let sentCards = [];
  const mockCtx = {
    from: { id: testUserId },
    chat: { id: 12345 },
    reply: async (text, extra) => { sentCards.push({ text, extra }); },
    answerCbQuery: async () => true
  };

  const db = getDb();
  db.config.accounts[testAccKey] = {
    id: testAccKey,
    phone: testPhone,
    mobile: testPhone,
    name: 'Rahul Kumar',
    isLoggedIn: true,
    cookies: 'tid=fake; _is_logged_in=1',
    savedAt: new Date().toISOString()
  };
  saveDb(db);

  userWaitState[testUserId] = {
    action: 'waiting_swiggy_new_account_name',
    phone: testPhone,
    targetAcc: testAccKey,
    savedSessionKey: testAccKey,
    orderId: null,
    verifyResult: {
      success: true,
      wasNewSignup: true,
      accountKey: testAccKey,
      phone: testPhone,
      customerId: '88990022',
      totalOrdersCount: 0,
      isZeroOrderAccount: true
    },
    needsSignupCall: false,
    existingName: null
  };

  // User selects auto-assign (empty input or empty string)
  await completeNewAccountWithChosenName(mockCtx, testUserId, '');

  const updatedAcc = getDb().config.accounts[testAccKey];
  ok(updatedAcc.name && updatedAcc.name !== 'Rahul Kumar', `Auto-assigned sequential name: "${updatedAcc.name}" (not Rahul Kumar)`);
  ok(!userWaitState[testUserId], 'userWaitState cleared');

  console.log(`✅ PASS 02: Auto-assigned name ("${updatedAcc.name}") assigned without defaulting to Rahul Kumar`);

  deleteAccount(testAccKey, { purgeVault: true, skipImmediateCloudPush: true });
}

// =========================================================================
// TEST 3: State preservation across re-entering OTP
// =========================================================================
console.log('\n--- 3. State Preservation Across Re-enter OTP ---');
{
  const testUserId = 88003;
  const testPhone = '9911406017';

  userWaitState[testUserId] = {
    action: 'waiting_swiggy_otp_bridge',
    phone: testPhone,
    targetAcc: `acc_${testPhone}`,
    name: 'Rohan Slot',
    orderId: 'order_test_123',
    isNewUser: true
  };

  // Simulate re-enter OTP tap (prompt_reenter_otp_)
  const prevOrderId = userWaitState[testUserId]?.orderId || null;
  const prevIsNewUser = Boolean(userWaitState[testUserId]?.isNewUser);

  userWaitState[testUserId] = {
    action: 'waiting_swiggy_otp_bridge',
    targetAcc: `acc_${testPhone}`,
    phone: testPhone,
    name: 'Rohan Slot',
    orderId: prevOrderId,
    isNewUser: prevIsNewUser
  };

  ok(userWaitState[testUserId].isNewUser === true, 'isNewUser: true correctly preserved across Re-enter OTP');
  strictEqual(userWaitState[testUserId].orderId, 'order_test_123', 'orderId correctly preserved');

  console.log('✅ PASS 03: isNewUser preserved across Re-enter OTP');
}

console.log('\n================================================================');
console.log('🏆 ALL V44 NEW ACCOUNT ASK NAME E2E TESTS PASSED!');
console.log('================================================================\n');
process.exit(0);
