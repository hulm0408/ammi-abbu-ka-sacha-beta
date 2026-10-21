// ============================================================================
// V16 COMPREHENSIVE E2E SUITE:
//  1. 100% Zero-SMS Shield (0 live POST order/place packets ever sent!)
//  2. Screen 01 + Customer Interactive Two-Box [Verify] Form (Cart -> Address)
//  3. Screen 03 Bill Confirmation ([Something is wrong] + [Approve bill] Gate)
//  4. Screen 04 Single QR Idempotency + [I've paid — check status] (No Trust Tap)
//  5. Screen 05 Paid Finality + Tracking Delayed ([Retry tracking], No 2nd QR)
//  6. Screen 02 Boss Forwarded Incomplete SMS -> Two-Box [Verify & Update Bill]
//  7. Screen 06 & 07 Owner-Only Auth (403), Masked Safe JSON, Audit Log & OTP x3 Lock
// ============================================================================

process.env.TEST_MODE = '1';
process.env.SWIGGY_TEST_SANDBOX = '1';
process.env.DISABLE_CLOUD_VAULT = '1';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '8985760874:AAFUIJFIKxaZZSbyWpHP9djf8WPzoVyLyFY';
process.env.BOSS_ID = '6484999726';
process.env.APP_BASE_URL = 'https://ammi-abbu-ka-sacha-beta.onrender.com';

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';

// Capture baseline files so real production accounts & clean empty state stay 100% pristine!
const ACCOUNTS_PATH = './accounts.json';
const DB_PATH = './data/db.json';
const origAccountsRaw = fs.existsSync(ACCOUNTS_PATH) ? fs.readFileSync(ACCOUNTS_PATH, 'utf8') : null;
const origDbRaw = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;

const { handleOrderUxPortalHttp, bot } = await import('./index.js');
const { getDb, saveDb, resetOtpLock, swiggyCartFlush } = await Promise.all([
  import('./store.js'),
  import('./swiggy-cart.js')
]).then(([s, c]) => ({ ...s, swiggyCartFlush: c.swiggyCartFlush }));
const {
  handleBossForwardedOrderInput,
  executeRealQrGenerationForOrder
} = await import('./forwarded-order-flow.js');
const {
  buildUserPortalUrl,
  buildBossOrderPortalUrl,
  buildBossAccountsPortalUrl,
  renderInteractiveSevenScreenShowcaseHtml
} = await import('./order-ux-portal.js');

// Intercept all outgoing Telegram bot calls cleanly in memory
const sentTelegramMessages = [];
bot.telegram.sendMessage = async (chatId, text, extra = {}) => {
  const msg = { message_id: 5000 + sentTelegramMessages.length, chat: { id: chatId }, text, extra };
  sentTelegramMessages.push(msg);
  return msg;
};
bot.telegram.editMessageText = async (chatId, messageId, _inlineId, text, extra = {}) => {
  const msg = { message_id: messageId, chat: { id: chatId }, text, extra, edited: true };
  sentTelegramMessages.push(msg);
  return msg;
};
bot.telegram.deleteMessage = async () => true;
bot.telegram.sendPhoto = async (chatId, _photo, extra = {}) => {
  const msg = { message_id: 6000 + sentTelegramMessages.length, chat: { id: chatId }, caption: extra.caption || '', extra, isPhoto: true };
  sentTelegramMessages.push(msg);
  return msg;
};

// Spin up ephemeral local HTTP server wired to the REAL `handleOrderUxPortalHttp`
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const handled = await handleOrderUxPortalHttp(req, res, reqUrl);
  if (!handled) {
    res.writeHead(404);
    res.end('Not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseHttp = `http://127.0.0.1:${port}`;

async function portalGet(pathAndQuery) {
  const r = await fetch(`${baseHttp}${pathAndQuery}`);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

async function portalPost(path, body) {
  const r = await fetch(`${baseHttp}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

const LIVE_CART_LINK = 'https://swig.gy/gc/622166/Adithya-312184336';
const LIVE_HYD_ADDR = `Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/j37ai838.

Address: Svr arcade plot no 628, IPM Blood Bank Colony, Hayathnagar_Khalsa, Hyderabad, Telangana 501505, India`;

try {
  console.log('================================================================');
  console.log('🧪 V16 E2E: ZERO-SMS SHIELD + 7-SCREEN ONE-CARD + TWO-BOX VERIFY');
  console.log('================================================================\n');

  // Write fresh standalone HTML preview file for instant browser viewing as well!
  fs.writeFileSync('./order-ux-preview.html', renderInteractiveSevenScreenShowcaseHtml(), 'utf8');

  // ------------------------------------------------------------------
  // PASS 01: Interactive 7-Screen Showcase & Security Role Gate Check
  // ------------------------------------------------------------------
  const showcaseRes = await portalGet('/showcase');
  assert.equal(showcaseRes.status, 200);
  assert.match(showcaseRes.text, /01 · User Intake \+ 2-Box Verify/);
  assert.match(showcaseRes.text, /06 · Owner Account Manager/);
  assert.match(showcaseRes.text, /Zero-SMS Shield Active/);
  console.log('✅ [PASS 01] 7-Screen Apple-Clean Interactive Showcase live at GET /showcase!');

  // ------------------------------------------------------------------
  // PASS 02: Customer Screen 01 + Interactive Two-Box [Verify] Form
  // ------------------------------------------------------------------
  const testUid = '77889900';
  const userUrl = new URL(buildUserPortalUrl(testUid));
  const userPage = await portalGet(userUrl.pathname + userUrl.search);
  assert.equal(userPage.status, 200);
  assert.match(userPage.text, /uCartInput/);
  assert.match(userPage.text, /uAddrInput/);
  assert.match(userPage.text, /✓ Verify/);

  const userSig = userUrl.searchParams.get('sig');

  // Step 2A: Enter ONLY Cart Link in Box #1 & Click [Verify] -> Screen 01 ("Address needed", QR blocked!)
  const verifyCartOnly = await portalPost('/api/portal/user-verify', {
    userId: testUid,
    sig: userSig,
    cart: LIVE_CART_LINK,
    address: ''
  });
  assert.equal(verifyCartOnly.status, 200);
  assert.equal(verifyCartOnly.json.ok, true);
  assert.ok(verifyCartOnly.json.state.draft.cart.includes('swig.gy/gc/622166'));
  assert.equal(verifyCartOnly.json.state.draft.address, '');
  assert.equal(verifyCartOnly.json.state.activeOrder, null, 'No account allocated or QR created when address is missing!');
  const userIntakeTgCard = sentTelegramMessages.find(m => m.chat.id === testUid && m.text?.includes('ORDER SUMMARY'));
  assert.ok(userIntakeTgCard, 'Single clean #ORDER SUMMARY card sent to Customer in Telegram!');
  assert.match(userIntakeTgCard.text, /Address needed/);
  assert.match(userIntakeTgCard.text, /No account allocated; QR is blocked\./);

  // Step 2B: Now fill Box #2 (Delivery Address) & Click [Verify] -> Both Cart ✓ & Address ✓ verified!
  const verifyBoth = await portalPost('/api/portal/user-verify', {
    userId: testUid,
    sig: userSig,
    cart: LIVE_CART_LINK,
    address: LIVE_HYD_ADDR
  });
  assert.equal(verifyBoth.status, 200);
  assert.equal(verifyBoth.json.ok, true);
  assert.ok(verifyBoth.json.state.draft.address.length > 10);
  console.log('✅ [PASS 02] Customer Two-Box [Verify] Form verified Cart first ("Address needed") -> then Address ✓ cleanly!');

  // ------------------------------------------------------------------
  // PASS 03: Submit -> Screen 03 Bill Confirmation -> "Something is wrong" + "Approve bill"
  // ------------------------------------------------------------------
  const submitRes = await portalPost('/api/portal/user-submit', {
    userId: testUid,
    sig: userSig
  });
  assert.equal(submitRes.status, 200);
  assert.equal(submitRes.json.ok, true);
  const createdOrderId = submitRes.json.orderId;
  assert.equal(submitRes.json.state.activeOrder.uxStage, 'SCREEN_03_BILL_CONFIRMATION');
  assert.equal(submitRes.json.state.activeOrder.hasQr, false, 'STRICT RULE: ZERO QR created before explicit user approval!');

  // Test "Something is wrong" -> returns cleanly to draft with ZERO QR created!
  const rejectRes = await portalPost('/api/portal/user-approve', {
    userId: testUid,
    orderId: createdOrderId,
    sig: userSig,
    decision: 'reject'
  });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.json.state.activeOrder, null);
  assert.ok(rejectRes.json.state.draft.cart, 'Draft preserved in Two-Box form so customer can edit cleanly!');

  // Re-submit & explicitly click [Approve bill] -> Issues SINGLE QR (`2599...` Zero-SMS Sandbox ID!)
  const resubmit = await portalPost('/api/portal/user-submit', { userId: testUid, sig: userSig });
  const approvedOrderId = resubmit.json.orderId;
  const approveRes = await portalPost('/api/portal/user-approve', {
    userId: testUid,
    orderId: approvedOrderId,
    sig: userSig,
    decision: 'approve'
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.json.state.activeOrder.uxStage, 'SCREEN_04_PAYMENT_PENDING');
  assert.equal(approveRes.json.state.activeOrder.hasQr, true);
  const dbAfterApprove = getDb();
  const approvedOrd = dbAfterApprove.orders[approvedOrderId];
  assert.ok(String(approvedOrd.pendingSwiggyOrderId).startsWith('2599'), 'Zero-SMS Sandbox order ID `2599...` used -> 0 real Swiggy SMS messages!');
  const firstQrTxn = approvedOrd.pendingSwiggyPaasId;

  // Clicking Approve a second time MUST reuse the exact same QR (Idempotent Single-QR Rule!)
  await portalPost('/api/portal/user-approve', {
    userId: testUid,
    orderId: approvedOrderId,
    sig: userSig,
    decision: 'approve'
  });
  assert.equal(getDb().orders[approvedOrderId].pendingSwiggyPaasId, firstQrTxn, 'Single QR strictly reused — zero duplicate QR!');
  console.log(`✅ [PASS 03] Screen 03 -> Screen 04 Verified: No QR before approval, single QR (${approvedOrd.pendingSwiggyOrderId}), 0 SMS!`);

  // ------------------------------------------------------------------
  // PASS 04: Screen 04 ("I've paid — check status") + Screen 05 ("Paid is final — Never 2nd QR")
  // ------------------------------------------------------------------
  const unpaidTap = await portalPost('/api/portal/user-check-paid', {
    userId: testUid,
    orderId: approvedOrderId,
    sig: userSig
  });
  assert.equal(unpaidTap.status, 200);
  assert.equal(unpaidTap.json.paid, false, 'STRICT RULE: Button tap NEVER marks order paid without gateway confirmation!');
  assert.equal(getDb().orders[approvedOrderId].pendingSwiggyPaasId, firstQrTxn, 'Status check NEVER creates a 2nd QR!');

  // Simulate provider-confirmed payment with delayed tracking (Exact Screen 05)
  const dbPaid = getDb();
  dbPaid.orders[approvedOrderId].status = 'COMPLETED';
  dbPaid.orders[approvedOrderId].trackingLink = '';
  dbPaid.orders[approvedOrderId].shareTrackUrl = '';
  saveDb(dbPaid);

  const paidDelayedState = await portalPost('/api/portal/user-check-paid', {
    userId: testUid,
    orderId: approvedOrderId,
    sig: userSig
  });
  assert.equal(paidDelayedState.json.paid, true);
  assert.equal(paidDelayedState.json.state.activeOrder.uxStage, 'SCREEN_05_PAID_TRACKING_DELAYED');

  // Verify attempting to generate another QR on a COMPLETED order strictly throws PAID_IS_FINAL_NO_NEW_QR!
  await assert.rejects(
    () => executeRealQrGenerationForOrder({
      telegram: bot.telegram,
      chatId: 6484999726,
      orderId: approvedOrderId,
      formatOrderBodyFn: () => ''
    }),
    /Paid is final/i
  );
  console.log('✅ [PASS 04] Screen 04 & Screen 05 Verified: Status check never trusts button tap & Paid blocks 2nd QR forever!');

  // ------------------------------------------------------------------
  // PASS 05: Boss Forwarded Incomplete SMS -> Two-Box [Verify & Update Bill] Form
  // ------------------------------------------------------------------
  const fakeBossCtx = {
    from: { id: 6484999726, first_name: 'Rahul Boss' },
    chat: { id: 6484999726 },
    message: {
      message_id: 9100,
      forward_sender_name: 'Ayesha Sister',
      text: `Bhaiya ye cart order kar do please: ${LIVE_CART_LINK}`
    },
    telegram: bot.telegram
  };

  await handleBossForwardedOrderInput(fakeBossCtx, {
    rawText: fakeBossCtx.message.text,
    formatOrderBodyFn: (o) => `${o.restaurantName || ''} - ₹${o.finalTotal || 0}`
  });

  const ayeshaOrder = Object.values(getDb().orders).find(o => o.fwdSenderName === 'Ayesha Sister');
  assert.ok(ayeshaOrder, 'Incomplete forwarded SMS card created for Ayesha Sister');
  assert.equal(Boolean(ayeshaOrder.cart), true);
  assert.equal(Boolean(ayeshaOrder.address), false);

  // Verify Boss's Telegram card has the `[📍 Enter Missing Address & Verify ›]` Mini App button!
  const bossIncompleteCard = [...sentTelegramMessages].reverse().find(m => m.text?.includes(ayeshaOrder.id));
  const bossBtnFlat = JSON.stringify(bossIncompleteCard?.extra?.reply_markup || {});
  assert.match(bossBtnFlat, /Enter Missing Address & Verify/);

  // Open Boss's Two-Box Verify Portal (`GET /portal/boss-order/:orderId`) & fill missing Address box!
  const bossPortalUrl = new URL(buildBossOrderPortalUrl(ayeshaOrder.id));
  const bossPortalHtml = await portalGet(bossPortalUrl.pathname + bossPortalUrl.search);
  assert.equal(bossPortalHtml.status, 200);
  assert.match(bossPortalHtml.text, /Ayesha Sister/);
  assert.match(bossPortalHtml.text, /Verify &amp; Update Bill/);

  const bossVerifyRes = await portalPost('/api/portal/boss-verify', {
    orderId: ayeshaOrder.id,
    sig: bossPortalUrl.searchParams.get('sig'),
    cart: ayeshaOrder.cart,
    address: LIVE_HYD_ADDR
  });
  assert.equal(bossVerifyRes.status, 200);
  assert.equal(bossVerifyRes.json.ok, true);
  assert.equal(bossVerifyRes.json.state.hasCart, true);
  assert.equal(bossVerifyRes.json.state.hasAddress, true);
  assert.equal(bossVerifyRes.json.state.cardStage, 'BILL_READY');
  assert.ok(bossVerifyRes.json.state.finalTotal > 0, `Real Swiggy bill fetched: ₹${bossVerifyRes.json.state.finalTotal}!`);
  console.log(`✅ [PASS 05] Boss Forwarded Incomplete SMS -> Two-Box [Verify] upgraded #${ayeshaOrder.id} directly to BILL_READY (₹${bossVerifyRes.json.state.finalTotal})!`);

  // ------------------------------------------------------------------
  // PASS 06: Screen 06 & 07 Owner-Only Auth (403), Masked Safe JSON & Wrong OTP x3 Lock
  // ------------------------------------------------------------------
  const unauthPage = await portalGet('/portal/accounts?bid=999999&sig=badtoken');
  assert.equal(unauthPage.status, 403, 'Non-owner strictly blocked from Account Manager with HTTP 403!');

  const unauthApi = await portalPost('/api/portal/accounts', { bossId: '999999', sig: 'bad', action: 'delete' });
  assert.equal(unauthApi.status, 403, 'Non-owner POST action strictly blocked with HTTP 403!');

  const bossAccUrl = new URL(buildBossAccountsPortalUrl('6484999726'));
  const bossAccSig = bossAccUrl.searchParams.get('sig');
  const bossAccPage = await portalGet(bossAccUrl.pathname + bossAccUrl.search);
  assert.equal(bossAccPage.status, 200);
  assert.match(bossAccPage.text, /Account manager · owner-only · secure actions/);
  assert.match(bossAccPage.text, /AC-3518/);
  assert.match(bossAccPage.text, /\*\*\*\*3518/);
  assert.doesNotMatch(bossAccPage.text, /_session_tid=[^"\s]{8,}/, 'Zero raw session tokens leaked in Safe JSON HTML!');

  // Test Wrong OTP x3 -> Immediate 15-minute Lockout!
  const dummyPhone = '9876500123';
  resetOtpLock(dummyPhone);
  const s1 = await portalPost('/api/portal/accounts', { bossId: '6484999726', sig: bossAccSig, action: 'verify_otp', phone: dummyPhone, otp: '000001' });
  const s2 = await portalPost('/api/portal/accounts', { bossId: '6484999726', sig: bossAccSig, action: 'verify_otp', phone: dummyPhone, otp: '000002' });
  const s3 = await portalPost('/api/portal/accounts', { bossId: '6484999726', sig: bossAccSig, action: 'verify_otp', phone: dummyPhone, otp: '000003' });
  assert.equal(s1.status, 400);
  assert.equal(s2.status, 400);
  assert.equal(s3.status, 429, '3rd wrong OTP triggers HTTP 429 Lockout!');
  assert.equal(s3.json.locked, true);

  // Check structured audit log recorded all sensitive security actions cleanly with redacted fields
  const auditActions = (getDb().auditLog || []).map(a => a.action);
  assert.ok(auditActions.includes('qr_created'), 'Audit log tracks qr_created');
  assert.ok(auditActions.includes('otp_locked'), 'Audit log tracks otp_locked');
  assert.ok(auditActions.includes('unauthorized_account_mgr_attempt'), 'Audit log tracks unauthorized access attempts');
  resetOtpLock(dummyPhone);

  console.log('✅ [PASS 06] Screen 06 & Screen 07 Security Verified: 403 Auth, Masked AC-3518 / ****3518, Redacted Secrets, Audit Log & Wrong OTP ×3 Lock!');

  console.log('\n================================================================');
  console.log('🏆 ALL 6/6 V16 ZERO-SMS + ONE-CARD + TWO-BOX VERIFY TESTS PASSED!');
  console.log('================================================================');
} finally {
  server.close();
  // Cleanly flush real Swiggy test carts & restore pristine production DB / accounts.json!
  try {
    const dbClean = getDb();
    for (const acc of Object.values(dbClean?.config?.accounts || {})) {
      if (acc?.isLoggedIn) await swiggyCartFlush(acc).catch(() => {});
    }
  } catch {}
  if (origAccountsRaw !== null) fs.writeFileSync(ACCOUNTS_PATH, origAccountsRaw, 'utf8');
  if (origDbRaw !== null) fs.writeFileSync(DB_PATH, origDbRaw, 'utf8');
}
