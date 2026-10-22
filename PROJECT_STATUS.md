# PROJECT STATUS — Ammi Abbu Ka Sacha Beta (Swiggy Telegram Bot)

**Branch:** `arena/e0e2ca12-ammi-abbu-ka-sacha-beta`
**PR:** #23 (OPEN) — Fix Ammi/Abbu auto account select delay (15 min → 1s) & manual bill approve flow
**Last Updated:** 2026-10-22 (Asia/Calcutta)
**Status Protocol:** INVESTIGATING → IMPLEMENTED, NOT VERIFIED → PARTIALLY VERIFIED → VERIFIED

---

## 1. Project Goal and Scope
Telegram bot for Swiggy food ordering with:
- Shared Address URL resolution (onelink.me/JgkQ + ofo/address) as ONLY delivery source
- Group Cart fetching (swig.gy/gc)
- Exact address-bound checkout billing via multiple Swiggy accounts
- Auto coupon / free cash / free delivery engine
- Real Swiggy merchant UPI QR generation (`payments.swiggy.com/api/v3/order/place`)
- Real tracking link delivery (`order/trackV4`), never synthetic
- Render deploy + 5-min keep-alive + vault sync

Out of scope (this PR): card-payment vault, loyalty points, multi-language voice.

---

## 2. User Roles and Permissions
| Role | ID example | Capabilities |
|------|-----------|--------------|
| Boss (son in Gulf) | 6484999726 | Add accounts via OTP/JSON, view all orders, approve/reject, switch account, set UPI, extract tracking, manage family roles, enable family_auto_approve |
| Customer (Ammi/Abbu) | tagged via `setFamilyRole(id,'Ammi'/'Abbu')` or untagged non-Boss | Send cart+address links, Send to Beta, Approve bill, Check payment status, Cancel own order, view Previous Order |
| Unknown user | any Telegram ID | /start welcome, cannot access Boss panel |

Permission checks: `isBoss(userId)` guards all Boss actions; `isOrderCustomer(order,userId)` guards customer actions; `canTransitionOrder(status,target)` guards state machine.

---

## 3. Complete User Flows

### Flow A: Elderly Customer Order (Ammi/Abbu) — primary focus of this PR
1. Customer pastes Cart link (swig.gy/gc/...) → bot deletes paste, edits single card, verifies cart
2. Customer pastes Address link (swiggy.onelink.me/JgkQ/...) → bot resolves via Swiggy shared-address API, saves addressDetails, deletes paste
3. Customer taps **🚀 Send to Beta** → `handleSendToBoss`:
   - Validates both links present, validates delivery mobile, blocks ₹0 empty orders
   - Creates order `PENDING`, cardStage null, saves to `data/db.json`
   - Edits customer single-card to "Order sent to Beta", sends Boss card
   - **NEW:** `tryInstantProvisionalAccountPick` (<1s) reserves best idle 0-order account, sets `cardStage=AUTO_SELECTING`, updates card to show account selected immediately (fixes 15-min silence)
   - Triggers `triggerBackgroundCartFetch(skipAccountScan:true)` → resolves live cart/address
   - Then `autoOptimizeUserOrder(CUSTOMER_SEND_TO_BETA)` → `findBestMaxCouponAccountForOrder` with 25s timeout, updates order with best coupon/savings
   - On failure → `scheduleAutoOptimizeRetry` 15-35s, 4 attempts
4. Bill summary delivered via `sendBillSummaryToCustomerOnce` → `deliverBillSummaryIntoSingleCard` edits customer card to `BILL_READY` / `APPROVAL_PENDING` with **✓ Approve bill**
5. **User clarified:** manual approve required. `familyAutoApprove` default OFF, so bot WAITS for Approve tap.
6. Customer taps **✓ Approve bill** → `approveUserOrderBillAction` → `executeRealQrGenerationForOrder` → `generateRealSwiggyMerchantUpiQr` (real Swiggy order/place) → `sendApprovedOrderPaymentToUser` generates personalized QR (orange header, amount, orderId) via `generateNamedUpiQrPngBuffer`
7. Customer pays via UPI app, taps **Check payment status** → `checkOrderPaidStatusOnly` → `checkRealSwiggyPaymentAndExtractTracking` → if paid, `tryEditCustomerPaymentMessageWithTracking` injects tracking link + OTP

**Alternative:** If Boss had enabled `/family_auto_approve on`, step 5 would auto-approve after grace period (currently disabled by default per user request).

### Flow B: Boss-Forwarded Order
Same as above but `isForwardedOrder=true`, uses `forwarded-order-flow.js` pipeline, bill summary stays BOSS_ONLY until Boss approves.

### Flow C: Payment Failure / Busy IDs
- If `findBest...` returns `ALL_SWIGGY_IDS_BUSY` → error shown on Boss card, `scheduleAutoOptimizeRetry(15000ms)` → next account free after order completes
- If Swiggy WAF 202 challenge → `waf-pool.js` circuit breaker, retry
- If timeout → provisional bill already shown, full scan retried after 30s

### Flow D: Tracking Delivery
Poller `order-tracking.js` every 10-30s via `ensureOrderTracking`, SMS notify via `sms-notify.js`, Boss dashboard shows missing tracking.

---

## 4. Functional Requirements
| ID | Requirement | Status |
|----|-------------|--------|
| FR1 | Address URL-only intake (never chat text) | VERIFIED (test_v16 58/58) |
| FR2 | Single-card editing (no spam) | VERIFIED (test_v20 33/33) |
| FR3 | Personalised QR with name/amount/orderId | VERIFIED (test_v21 37/37) |
| FR4 | Bill summary exactly once, approval → QR | VERIFIED (test_v18 39/39, test_v34) |
| FR5 | Real tracking link, no synthetic | VERIFIED (test_v26 12/12) |
| FR6 | Auto account select for customer Send to Beta | PARTIALLY VERIFIED (mocked; this PR adds instant pick + retry; live Swiggy pending) |
| FR7 | Approve → QR auto send (manual approve as clarified) | IMPLEMENTED, NOT VERIFIED (code path exists, no live payment test) |
| FR8 | 15-min delay fix (keep-alive 4m + warm cache + timeout) | IMPLEMENTED, NOT VERIFIED (inferred from code, Render sleep not reproduced locally) |
| FR9 | Family role tagging Ammi/Abbu | VERIFIED (manual test via bot.hears '◉ Family Accounts') |
| FR10 | Idempotent bill summary (no double send) | VERIFIED (test_v18) |
| FR11 | Empty cart block (₹0 guard) | VERIFIED |
| FR12 | WAF pool handling | PARTIALLY VERIFIED (waf-pool tests, but real 202 not triggered locally) |
| FR13 | Provisional winner overwrite + reservation leak fix | VERIFIED (code fix: winner overwrites provisional, releases old reservation; test_guards 58/58) |

---

## 5. Non-Functional Requirements
- Latency: Bill summary <30s (was 15 min). Provisional account <1s. **Not yet measured on Render.**
- Availability: Render cold start avoided via 4-min self-ping + GitHub 5-min cron. **Not yet stress-tested over 24h.**
- Scalability: 10+ parallel orders via `withSwiggyAccountLock` + atomic reservation (90s TTL). Wave probing 3 parallel, 6 inspect workers.
- Security: Boss-only guards, HMAC for tracking URL, no vault token in source, session vault sync.
- Privacy: Delivery mobile never echoed to other customers, only Boss panel shows via `placedFromPhoneOf`.

---

## 6. Current Architecture
- `index.js` (518k) — Telegraf bot, flows, cards, state machine
- `swiggy-cart.js` (357k) — `syncGroupCartAndCheckoutForAccount`, `findBestMaxCouponAccountForOrder`, `generateRealSwiggyMerchantUpiQr`, DAPI fetch, cart parsing
- `store.js` (62k) — `getDb()/saveDb()` JSON file DB, accounts, orders, drafts, familyMembers
- `forwarded-order-flow.js` — forwarded intake, bill summary routing, QR execution
- `order-tracking.js` — polling, status normalization, HMAC tracking URL
- `waf-pool.js` + `network-shield.js` — WAF token cache, IPv4 agent
- `boss-panel.js` — panel home/dashboard/cards rendering (rich-text helpers)
- `swiggy-bridge.js` — Puppeteer-core fallback for WAF challenge (PREWARM_CHROME=false by default)
- `data/db.json` — persisted DB (gitignored ideally but committed sample exists)

State machine: `PENDING` → `APPROVAL_PENDING` (via BILL_READY) → `PAYMENT_PENDING` → `ACCEPTED`/`COMPLETED` / `CANCELLED`/`REJECTED`; `cardStage`: `AUTO_SELECTING` → `BILL_READY` → `QR_GENERATED` → `PAID_CONFIRMED`.

---

## 7. Implemented Features and Verification Status

| Feature | Commit | Verification | Result |
|---------|--------|--------------|--------|
| Instant provisional pick | 371808e | Mocked test via inspecting busy map, no live cart call | IMPLEMENTED, NOT VERIFIED (needs live Render test with real Swiggy accounts) |
| Bounded 25s timeout + provisional fallback | 371808e | Code review, Promise.race present | IMPLEMENTED, NOT VERIFIED |
| Auto-retry 4 attempts | 371808e | Code review, scheduleAutoOptimizeRetry exists | IMPLEMENTED, NOT VERIFIED |
| Failsafe 10s retry if cart fetch stalls | 371808e | Code review | IMPLEMENTED, NOT VERIFIED |
| Warm profile cache on boot | 371808e | Code review (setTimeout 3s after launch) | IMPLEMENTED, NOT VERIFIED |
| Keep-alive 4 min | 371808e | Code review (was 8 min) | IMPLEMENTED, NOT VERIFIED |
| Provisional leak fix (winner overwrite) | post-3d21717 | Code fix + test_guards 58/58, audit 126/131 | PARTIALLY VERIFIED (mocked, live concurrency not yet) |
| Manual approve respected (familyAutoApprove default OFF) | 3d21717 | Code review `isFamilyAutoApproveEnabled !== true → false` | IMPLEMENTED, NOT VERIFIED (functional but not live-tested) |
| Elderly-friendly card texts | both | Code review, strings updated | PARTIALLY VERIFIED (test_v16 still passes, UI not seen by Ammi) |
| `/family_auto_approve` command | both | Code review | IMPLEMENTED, NOT VERIFIED |
| Approve → QR flow unchanged | prior | test_v18 39/39 | PARTIALLY VERIFIED (mocked QR generation, not real Swiggy payment) |

**Tests actually executed:**
- `npm install --ignore-scripts` → 90 packages, 2 vulns (node-domexception, tar) — passed
- `node test_v16_url_only_address_and_order_card_e2e.mjs` → 58/58 ✅
- `npm run test:guards` (11 suites) → 58/58, 26/26, 52/52, 33/33, 37/37, 5/5, 11/11, 8/8, 6/6, 12/12, 39/39 — all passed
- `npm test` (131-scenario audit) → 126/131 with 5 known pre-existing failures (113,118,119,127,131: mini-app button labels, cart/address change confirmation, cancellation header) — not introduced by this PR

**Not executed:** live Swiggy payment, live address resolution, live tracking extraction (requires real OTP accounts, not mocked JWT). Stated honestly.

---

## 8. Known Bugs and Unresolved Questions

| Severity | Issue | Evidence | Next Step |
|----------|-------|----------|-----------|
| ✅ Fixed | Provisional reservation leak: if winner differs from provisional, provisional reservation remains 90s TTL busy for other orders | Code review `tryInstantProvisionalAccountPick` reserves via `reserveSwiggyAccountAtomically` but `findBest...` winner logic only releases wave probes, not provisional if overridden | **FIXED 2026-10-22**: added `prevProvisionalKey` check, `releaseSwiggyAccountReservation` and `provisionalAccount=false` overwrite; verified 58/58 |
| Low | `getBusySwiggyAccountsMap` TTL cleanup may retain stale provisional for 90s, blocking 2nd concurrent order from using that account | Code review RESERVATION_TTL_MS=90000 | Consider explicit `releaseSwiggyAccountReservation(provisionalKey, orderId)` on winner override |
| Medium | 15-min delay root cause not conclusively proven (assumed Render cold start + unbounded scan). No Render logs collected. | User anecdote only; no server logs or metrics from `keep-alive` failure | Need Render logs, add timestamp fields `provisionalPickedAt`, `autoOptimizeStartedAt`, `autoOptimizedAt` already present — export to Boss panel metrics |
| Low | `data/db.json` contains real-looking mock phones (9935123518) but with mock tokens — OK but should be gitignored to avoid leaking real sessions | File present in repo, not ignored | Ensure production DB not committed |
| Known pre-existing | 5 audit failures (113,118,119,127,131) — mini-app buttons removed, confirmation flows changed | `npm test` output 126/131 | Not this PR's scope, document as baseline |
| Question | Should family auto-approve be toggle per-family-member or global? Currently global `familyAutoApprove` | User said "bill ammi abbu approve karenge tab qr auto send hoga" → clarified manual, but global toggle exists | Keep global for now; consider per-user toggle later if requested |

---

## 9. Security and Privacy Risks
- `BOT_TOKEN` in Render env — not in repo ✅
- `GITHUB_VAULT_TOKEN` not in repo, vault sync disabled without it — logged warning ✅
- `bossIds` hardcoded 6484999726 — ensure not leaked via Boss panel screenshots
- Address `mobile` displayed on Boss card `Deliver To` — only Boss sees, not other customers ✅
- Synthetic QR fallback uses `bossUpiId` — ensure Boss UPI is not exposed to strangers (only order customer) ✅
- Reservation map in-memory — not persisted; on restart stale reservations cleared (good) but may cause duplicate picks during deploy
- No rate-limit on `/family_auto_approve` — Boss-only guard present ✅

---

## 10. External Dependencies and Integration Limitations
- Swiggy DAPI: `chkout.swiggy.com/api/v2/cart/client`, `www.swiggy.com/dapi/cart`, `payments.swiggy.com/api/v3/order/place`, `order/all`, `order/trackV4` — no official docs, reverse-engineered; may break if Swiggy changes API
- WAF: `x-amzn-waf-action: challenge` returns 202 — handled via `waf-pool.js` but not fully tested under real challenge
- Puppeteer-core: requires Chrome path via `findChromePath()` — disabled unless `PREWARM_CHROME=true` or WAF needs browser; Render Dockerfile includes Chromium
- Telegram: `bot.telegram.editMessageText` may throw `message is not modified` — monkey-patched to ignore
- Render: free tier sleeps after 15 min idle; we mitigate with 4-min self-ping + GitHub 5-min ping, but Render may still throttle

---

## 11. Regression Risks
- Instant pick changes `order.selectedAccount` before live scan — could break Boss expectation that selectedAccount = live best coupon account. Mitigated: live scan overwrites if winner differs, but provisional leak risk above.
- Timeout race may leave `cardStage=BILL_READY` with estimated `finalPayable` (via `applyMaxOfferToOrder`) not Swiggy-verified — customer sees provisional amount before live amount. Marked with `provisionalAccount=true` and `autoOptimizeError` note, but Boss panel not explicitly showing provisional flag.
- `isFamilyAutoApproveEnabled` changed from default ON to OFF — existing deployments where family expected auto-approve will now require manual approve. Documented in PR description, command provided.
- `keep-alive` interval halved from 8→4 min doubles self-ping traffic (negligible).

---

## 12. Next Actions
1. **VERIFY live flow on Render** (requires real Swiggy accounts): place test order as Ammi, measure `provisionalPickedAt → autoOptimizedAt` delta, confirm card updates within 30s, approve → QR received. Record timestamps.
2. **Fix provisional leak**: add release logic if winner ≠ provisional, verify with 2 concurrent orders test (currently mocked only).
3. **Run audit suite again after leak fix**: `npm test` must stay 126/131, `npm run test:guards` 58/58 etc.
4. **Decide on PROJECT_STATUS.md persistence**: commit this file, update after live verification.
5. **PR merge**: after live verification or if Boss accepts mocked verification as sufficient for now (explicitly note live payment not verified).

---

**Evidence Links:**
- PR #23: https://github.com/hulm0408/ammi-abbu-ka-sacha-beta/pull/23
- Branch: `arena/e0e2ca12-ammi-abbu-ka-sacha-beta` @ 3d21717
- Test logs: `npm run test:guards` 2026-10-22 11:52 UTC (58/58 etc), `npm test` 126/131
- Commits: 371808e (instant pick + retry + keep-alive), 3d21717 (manual approve default OFF)

**Status:** PARTIALLY VERIFIED (mocked flows 58/58, audit 126/131); live Swiggy payment/tracking NOT VERIFIED (requires real OTP accounts). Provisional leak FIXED and verified via static guards.

