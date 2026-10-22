# Premium Telegram Bot Mockups — 70 scenarios

Copy hamesha actual bot code se (index.js, boss-panel.js, rich-text.js, sms-notify.js, order-tracking.js, forwarded-order-flow.js).
Koi mini-app / WebApp nahi: sirf Telegram message + inline keyboard + force-reply prompt. 1080×2340 PNG, Android Telegram dark (ek light variant).
Sample data fictional: #4821 (shaam ka biryani order, ₹534) aur #4817 (subah ka thandai + aloo paratha, ₹174).
Images: `/home/user/mockups/out/` · contact sheets: `/home/user/mockups/review/`

## Customer flow

| # | File | Scenario |
|---|------|----------|
| 1 | `01-customer-welcome.png` | Customer /start → welcome + live status card |
| 2 | `02-cart-accepted.png` | Cart link paste → prompt delete + card updates |
| 3 | `03-force-reply-cart.png` | Force-reply prompt: input focused with placeholder |
| 4 | `04-duplicate-order-alert.png` | Second order attempt while one is active + toast |
| 5 | `05-address-unresolved.png` | Address link expired → asks for fresh link/pin |
| 6 | `06-missing-cart-only.png` | Send to Beta with missing data → only asks for the missing link |
| 7 | `07-empty-cart-block.png` | Tracking link pasted as cart → ₹0 empty order blocked |
| 8 | `08-recipient-mobile-required.png` | Recipient 10-digit number required (force reply) |
| 9 | `09-scan-progress.png` | Send to Beta → best account scan in progress |
| 10 | `10-bill-ready-approve.png` | Max-discount bill locked → Approve / Something is wrong |
| 11 | `11-bill-table.png` | Bill summary as readable rows (coupon + free cash + free delivery) |
| 12 | `12-payment-processing.png` | QR not ready yet → honest processing card (no fake QR) |
| 13 | `13-order-confirmed.png` | Order confirmed: live status + OTP + tracking |
| 14 | `14-order-done-receipt.png` | Order done: receipt + rider + delivered tracking |
| 15 | `15-no-tracking-yet.png` | Swiggy link not published yet → auto-fetch promise |
| 16 | `16-extract-prompt.png` | Extract Tracking Link → order id maangta hai |
| 17 | `17-extract-found.png` | Extract success: id + phone + live tracking + OTP + rider |
| 18 | `18-extract-not-found.png` | Extract fail: id kisi ID par nahi mila (no fake link) |
| 19 | `19-orders-done.png` | Orders Done — successful order history |
| 20 | `20-cancel-confirm.png` | Cancel order confirmation (popup style) |
| 21 | `21-payment-pending-toast.png` | Check payment status → alert: payment nahi mila |

## Boss panel / accounts / login

| # | File | Scenario |
|---|------|----------|
| 22 | `22-boss-panel-home.png` | Boss Panel home — accounts + order counters |
| 23 | `23-boss-login-number.png` | Boss: Login with Number → force reply for phone |
| 24 | `24-otp-sent-card.png` | OTP sent card (login flow) with resend/copy |
| 25 | `25-otp-wrong-attempt.png` | Wrong OTP → alert + resend timer |
| 26 | `26-otp-error-security.png` | OTP request failed — security challenge / rate limit |
| 27 | `27-json-import-preview.png` | Session JSON paste → parsed preview (tid/deviceId/sid) |
| 28 | `28-login-success-offers.png` | Login success + auto offer claim (Swiggy-style session card) |
| 29 | `29-claim-partial-fail.png` | Claim ₹50 offers → partial failure with retry |
| 30 | `30-family-accounts.png` | Connected accounts list with statuses |
| 31 | `31-switch-active-account.png` | Order account switched → both chats informed |
| 32 | `32-boss-dashboard.png` | Dashboard — order id, phone, tracking per order |
| 33 | `33-pending-order-card.png` | Boss pending order card — account pick + accept/reject |
| 34 | `34-auto-coupon-scan.png` | Auto Max Coupon (Best Account) — live scan |
| 35 | `35-export-logout-picker.png` | Export & Logout (1+ Orders) — checklist with toggles |
| 36 | `36-swiggy-delete-otp.png` | Delete account from Swiggy — 2-step danger with OTP |

## SMS / phone-level / misc

| # | File | Scenario |
|---|------|----------|
| 37 | `37-otp-sms-phone.png` | Phone home: Swiggy SMS OTP banner over Telegram chat |
| 38 | `38-order-placed-sms.png` | Parent ke phone par order-placed SMS |
| 39 | `39-payment-sms.png` | Payment-required SMS (short link + amount) |
| 40 | `40-otp-autofill.png` | OTP autofill chips above keyboard |
| 41 | `41-payment-sheet-mock.png` | Customer ka screen: QR payment sheet (personalised UPI QR) |
| 42 | `42-swiggy-app-otp.png` | Swiggy app screen jaisa: rider aaya, delivery OTP |
| 43 | `43-wallet-and-refer.png` | Wallet and refer — free cash + referral progress |
| 44 | `44-cancelled-list.png` | Cancelled / rejected orders list (honest empty state) |
| 45 | `45-rejected-bill.png` | Bill galat laga → customer ne "! Something is wrong" dabaya |
| 46 | `46-final-card-light.png` | Same order card — Telegram LIGHT theme |
| 47 | `47-bulk-json-vault.png` | Bulk Login — 8 session JSON files ek saath import |
| 48 | `48-unauthorized-lock.png` | Random user ne Boss button dabaya → unauthorized |

## Customer premium flow (batch 2)

| # | File | Scenario |
|---|------|----------|
| 49 | `49-customer-cart-received.png` | Customer → Beta: cart + address mil gaya, slot reserved |
| 50 | `50-customer-bill-approved.png` | Customer → Beta: bill galat tha, dobara banwaya, ab approve |
| 51 | `51-customer-qr-paid.png` | Customer → Beta: maine QR se pay kar diya |
| 52 | `52-customer-live-tracking.png` | Customer → Beta: live tracking puchha |
| 53 | `53-customer-delivery-otp.png` | Customer → Beta: OTP chahiye (rider gate me) |
| 54 | `54-customer-share-otp.png` | OTP share-to-group: Beta ne Ammi ke group me bhej diya |
| 55 | `55-customer-delivered.png` | Order delivered — receipt + parent ko thank-you |
| 56 | `56-customer-late-night-fallback.png` | Customer → Beta: order galat pahuncha, Beta ne galti maani |
| 57 | `57-customer-coupon-picked.png` | Customer ne coupon badalwaaya (Sir se pehle) |
| 58 | `58-customer-reorder.png` | Same order kal phir se — re-order in 1 tap |

## Boss advanced (batch 3)

| # | File | Scenario |
|---|------|----------|
| 59 | `59-boss-check-payment.png` | Boss: Check payment → Swiggy verify poll (alert) |
| 60 | `60-boss-export-json-file.png` | Boss: Export Session JSON — file + expiry warning |
| 61 | `61-logout-all-confirm.png` | Boss: LOGOUT ALL — danger confirm + active order block |
| 62 | `62-export-done-vault.png` | Boss: export + logout ho gaya — vault me 5 files |
| 63 | `63-free-cash-results.png` | Boss: Free Cash claim engine — per account result |
| 64 | `64-auto-poller-log.png` | Boss: auto tracking poller — background log card |
| 65 | `65-antibot-block.png` | Boss: Swiggy ne block kiya — bot ne brute force roka |
| 66 | `66-account-address-picker.png` | Boss: ⌖ Select Account Address — recipient override |
| 67 | `67-coupon-picker.png` | Boss: # Change Coupon — live coupon probe per account |
| 68 | `68-slot-management.png` | Boss: Slot management — limit + reason + lock |
| 69 | `69-refund-tracking.png` | Boss: refund track — customer ko status, Swiggy pe depend |
| 70 | `70-boss-no-offer-found.png` | Boss: offer nahi mila → pending rakha, customer ko bil nahi bheja |

