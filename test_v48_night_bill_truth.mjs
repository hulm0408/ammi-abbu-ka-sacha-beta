import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderDiscountBreakdown } from './bill-discounts.js';
import { nightOfferDiagnostic } from './checkout-eligibility.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'night-bill-'));
process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.DATA_DIR = temp;
process.env.DB_FILE = path.join(temp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(temp, 'accounts.json');
globalThis.fetch = async () => { throw new Error('Live requests prohibited'); };
let checks = 0;
const check = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++; };
try {
  const { buildBossOrderCard } = await import('./boss-panel.js');
  const renderOrderCardText = (order, db) => buildBossOrderCard(order, db).text;
  const { formatBossAccountReviewCard, formatUserOrderCardText } = await import('./index.js');
  const { applyMaxOfferToOrder } = await import('./swiggy-cart.js');
  for (const [reward, subtotal, coupon, code, fees, packing, finalPayable, deliverySaved] of [
    [25, 199, 59.7, 'SNACKIT', 45.95, 20, 161, 45],
    [40, 205.67, 120, 'TRYNEW', 27.21, 4.71, 74, 46]
  ]) {
    const order = {
      id: `ORD_REWARD_${reward}`, status: 'PENDING', userName: 'Test', userId: 123,
      items: [{ name: 'Food', price: subtotal, qty: 1 }], restaurantName: 'Test restaurant',
      subtotal, itemTotal: subtotal, couponCode: code, discountAmount: coupon,
      tradeDiscountTotal: reward, campaignFreeCash: reward, merchantTradeDiscount: 0,
      freeCashApplied: reward, walletSplitPayAmount: 0, swiggyOneMembershipFee: 1,
      deliveryFee: 0, freeDeliveryDiscount: deliverySaved, swiggyOneApplied: true,
      packingCharges: packing, taxesAndCharges: fees, finalPayable, swiggyVerified: true,
      totalSavings: coupon + reward * 2 + deliverySaved, autoOptimized: true
    };
    const expectedSavings = Math.round((coupon + reward + deliverySaved) * 100) / 100;
    const breakdown = orderDiscountBreakdown(order);
    check(breakdown.merchant, 0, 'reward not restaurant discount');
    check(breakdown.wallet, 0, 'reward not also wallet');
    check(breakdown.savings, expectedSavings, 'no duplicate savings');
    const before = JSON.stringify(order);
    const text = renderOrderCardText(order, { config: { accounts: {} } });
    check(text.includes('Restaurant Offer Discount'), false, 'boss card not double-labelled');
    check(text.includes('Campaign / Reward Discount'), true, 'campaign reward shown once');
    check(text.includes('Swiggy Money Wallet'), false, 'no invented wallet');
    check(text.includes(`₹${expectedSavings}`), true, 'correct visible savings');
    check(JSON.stringify(order), before, 'render is read-only');
    const customer = formatBossAccountReviewCard(structuredClone(order));
    check(customer.text.includes('Restaurant Offer Discount'), false, 'customer card not double-labelled');
    check(customer.text.includes('Campaign / Reward Discount'), true, 'customer reward row');
  }
  const walletOnly = { campaignFreeCash: 0, walletSplitPayAmount: 40, freeCashApplied: 40 };
  const active = { lateNight: { slotState: 'ACTIVE_NOW', offerValue: 1 } };
  const diagnostic = nightOfferDiagnostic(walletOnly, active);
  check(diagnostic.message.includes('campaign reward ₹0'), true, 'wallet does not hide missing campaign reward');
  check(diagnostic.message.includes('Wallet ₹40 alag'), true, 'wallet clearly separate');
  check(nightOfferDiagnostic({ campaignFreeCash: 25 }, active).message.includes('attribution abhi verify nahi'), true, 'generic reward not proof of Night campaign');
  check(nightOfferDiagnostic(walletOnly, { lateNight: { slotState: 'CUTOFF_PASSED_LOCKED_NEXT_14D' } }).message.includes('cutoff ke baad'), true, 'missed cutoff shown');
  check(nightOfferDiagnostic(walletOnly, null).state, 'UNVERIFIED', 'no invented booking');
  const card = renderOrderCardText({ id: 'ORD_DIAG', status: 'PENDING', subtotal: 200, finalPayable: 100,
    ...walletOnly, nightOfferDiagnostic: diagnostic }, { config: { accounts: {} } });
  check(card.includes('Night offer check'), true, 'boss sees Night diagnostic even with wallet cash');
  const shortCard = formatUserOrderCardText({ id: 'ORD_SHORT', subtotal: 200, finalPayable: 100,
    ...walletOnly, nightOfferDiagnostic: diagnostic });
  check(shortCard.includes('campaign reward ₹0'), true, 'short customer card sees independent Night diagnostic');
  const confirmed = { subtotal: 100, finalPayable: 150, swiggyVerified: true, tradeDiscountTotal: 25,
    campaignFreeCash: 25, freeCashApplied: 25, packingCharges: 50, taxesAndCharges: 25 };
  check(applyMaxOfferToOrder(confirmed).finalPayable, 150, 'authoritative fees-above-subtotal total preserved');
  check(applyMaxOfferToOrder({ subtotal: 100, finalPayable: 0, swiggyVerified: true }).finalPayable, 0, 'verified zero preserved');
  const fallback = applyMaxOfferToOrder({ subtotal: 200, tradeDiscountTotal: 25, campaignFreeCash: 25,
    freeCashApplied: 25, packingCharges: 10, taxesAndCharges: 20, discountAmount: 50 });
  check(fallback.finalPayable, 155, 'fallback reward subtracted once, packing and tax included');
  for (const file of ['swiggy-cart.js', 'bossbot/vendor/swiggy-cart.js']) {
    const source = fs.readFileSync(file, 'utf8');
    check(source.includes('liveCart.campaignFreeCash = mcpRewardCash'), false, 'no reward overlay from another cart');
    check(source.includes('options.forceEventRefresh ? null : getReusableEventOffers(account)'), true, 'force scan bypasses account snapshot');
    check(source.includes('force: Boolean(options.forceEventRefresh)'), true, 'force scan bypasses internal booking cache');
  }
  check(fs.readFileSync('forwarded-order-flow.js', 'utf8').includes('captureScreenshot: false, forceEventRefresh: true'), true, 'actual rescan callback forces fresh booking');
  console.log(`PASS: ${checks} exact bill duplication, Night-vs-wallet evidence and forced refresh regressions`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
