# Possibility Matrix — "pehle saari possibilities block karo"

Boss (31-10-2026, round 17):

> "BHAI DEKH KOI BHI KAAM KARNE SE PEHLE KITNI POSSIBILITIES HOSAKTI SABKO IDENTIFY KARKE BLOCK KARDIA KAR NA"

Ye file wahi list hai: **kaun kaun si galat cheez ho sakti hai, uska block kahan hai, aur
kaunsa test use pakadta hai.** Naya kaam karne se pehle `node test_v106_possibility_matrix.mjs`
chalta hai — koi purana darwaza khula na reh jaye.

Legend: ✅ = block + test · ⚠️ = block hai par provider/bank par depend karta hai (sach likha jata hai)

---

## A. Paisa (wallet / UTR)

| # | Possibility (kya galat ho sakta hai) | Block | Kahan |
|---|---|---|---|
| A1 | UTR khaali chhod kar "paisa bhej diya" | `UTR_REQUIRED` — koi credit nahi | `swiggy-pro-api.js` claimWalletTopup |
| A2 | UTR ka format galat (3 digit / letters only) | `UTR_INVALID` (12 digit UPI UTR) | same |
| A3 | Wahi UTR dobara, usi user se | `DUPLICATE_UTR` | `user-wallet.js` `usedUtrs` ledger |
| A4 | Wahi UTR dobara, **dusre user** se | `DUPLICATE_UTR` + "kisi aur ke top-up me use ho chuka" | same (global ledger) |
| A5 | Purane topup records prune hone ke baad wahi UTR | permanent ledger prune nahi hota | `user-wallet.js` `cfg()` / `markUtrUsed` |
| A6 | "Jitna bol raha" — amount khud likhna | credit **sirf top-up intent ke amount** par; alag amount → `TOPUP_AMOUNT_MISMATCH` (dono numbers) | `swiggy-pro-api.js` |
| A7 | Bina top-up QR ke claim | `NO_TOPUP_INTENT` | same |
| A8 | Ek top-up QR se kai claims | intent `usedAt` par band, ek baar | same |
| A9 | Bada amount bina bank verify auto-credit | ₹15 (fee) se zyada → **PENDING**, boss approve karega; `creditedPaise: 0` (jhootha credit nahi) | `WALLET_AUTO_CREDIT_MAX_PAISE` (default 1500) |
| A10 | Claim spam / UTR guessing | rate limit 10/hour → `RATE_LIMITED` + kitne minute baad | `pro-rate-limit.js` |
| A11 | Top-up spam / ek user ke kai khule intent | 20/hour + naya top-up purana band karta hai | same |
| A12 | Negative / zero / NaN amount | ₹1–₹500 clamp, `amountPaiseFromBody` | `swiggy-pro-api.js` |
| A13 | ₹0.005 jaisa fractional paise | `exactPaise()` integer-paise check | `swiggy-cart-integrity.js` |
| A14 | ⚠️ Paisa sach me aaya ya nahi (bina bank/provider API) | provider verify set hone par wahi source of truth; warna ledger me **`verifiedBy: 'user-claim'`** sach likha jata hai | `submitTopupRequest` |

## B. Order / payment QR

| # | Possibility | Block | Kahan |
|---|---|---|---|
| B1 | Fake/placeholder QR (`swiggy@icici` etc.) | exact fake handles blocked | `payment-qr-guard.js` |
| B2 | QR amount ≠ bill | block + dono numbers ("QR ₹58, bill ₹48") | same |
| B3 | Swiggy `am` + `amount` ka jhagda (QR hi na aaye) | `amount` drop / bill wala amount chuna jata hai | round 16 |
| B4 | Gandi encoding (`&amp;`, duplicate param, space) | auto-fix + warning, QR nahi rukta | round 15 |
| B5 | Order place ho gaya par QR nahi | Swiggy ke apne payment page se ek baar recovery; warna `PAYMENT_PENDING` + asli wajah, dobara place nahi | `swiggy-pro-provider.js` |
| B6 | Double order place (retry) | placement journal, `executeSingleSwiggyPlacement` | `swiggy-placement-journal.js` |
| B7 | Bar-bar place / checkout spam | 6 per 15 min → `RATE_LIMITED` | `pro-rate-limit.js` |
| B8 | Cart tampering (price/qty) | server cart + Swiggy live cart compare | `sameCartItems` |
| B9 | Coupon bill me alag, Swiggy par alag | `COUPON` mismatch par order nahi | `swiggy-pro-provider.js` checkout |
| B10 | Address/receiver badalna | same receiver phone + near coordinates, warna block | `sameDeliveryRecipient` |
| B11 | Wallet balance ke bina order | `WALLET_LOW_BALANCE`, provider tak baat nahi jati | `swiggy-pro-api.js` |
| B12 | Fee double charge | idempotent `chargeServiceFee` | `user-wallet.js` |
| B13 | Place na hone par fee na wapas | `refundServiceFee` sirf place-not-done par | same |
| B14 | Ek ID se do order (do log) | per-account lock + ID lock until deliver/cancel | `order-account-lock.js` |
| B15 | Draft hamesha ke liye ID pakde rehna | 2 minute idle sweep | `order-idle-expiry.js` |

## C. Swiggy ID / session

| # | Possibility | Block | Kahan |
|---|---|---|---|
| C1 | Vault (operator) ka ID private workspace me copy | `ACCOUNT_ALREADY_MANAGED` (ek ID = ek order) | `swiggy-pro-api.js` import |
| C2 | Import spam / galat session JSON | 8 per hour → `RATE_LIMITED` | `pro-rate-limit.js` |
| C3 | OTP spam (Swiggy SMS) | 8/hour request, 15/15min verify | same |
| C4 | JSON me phone badal kar doosra account | verified phone mismatch → 400 | import/verify |
| C5 | Busy/suspended ID se order | select hi block | `accounts/select` |
| C6 | Order ke beech ID switch | checkout pending hone tak switch band | same |
| C7 | Delete without Swiggy OTP | delete-OTP zaroori (DB only / Swiggy dono raste) | `accounts/remove*` |
| C8 | Boss ka UPI user badal de | 403 boss-only | `wallet/upi` |
| C9 | Doosre user ka tracking/address | `SHARED_ACCOUNT_RESTRICTED` | `orders/tracking` |
| C10 | Backup ka jhootha dawa | sirf boss backup kar sakta hai, sach status | `backup` |

## D. Offers / coupons

| # | Possibility | Block | Kahan |
|---|---|---|---|
| D1 | Ek offer do baar claim | `ensureCampaignClaim` ledger (read-back verified) | `event-offers.js` |
| D2 | Offer claim spam | 20/hour | `pro-rate-limit.js` |
| D3 | Coupon jhootha "lag gaya" | winner sirf jab asli bill kam ho; warna asli reason | `swiggy-pro-provider.js` |
| D4 | One Lite mehnga pad jaye | net-savings check + revert | same |

## E. Data / truth

| # | Possibility | Block | Kahan |
|---|---|---|---|
| E1 | Rate limit chhup jaye | bootstrap me `rateLimits` snapshot | `swiggy-pro-api.js` |
| E2 | Generic "kuch galat ho gaya" | har error me code + asli wajah | `KNOWN_CODES` |
| E3 | QR intent ka kachra dobara na pata chale | `diag.intentRaw` (400 chars) | `swiggy-pro-provider.js` |

---

## Kaise chalte hain

```bash
node test_v106_possibility_matrix.mjs     # matrix ka smoke
npm run test:guards                       # poora sweep (73+ suites)
```

Limit badalni ho to ek hi jagah: `pro-rate-limit.js` → `RATE_LIMITS`.
Auto-credit cap: env `WALLET_AUTO_CREDIT_MAX_PAISE` (default `1500` = ₹15).

## Jo abhi bhi provider par depend karta hai (chhupaya nahi)

* Paisa bank me aaya ya nahi — bina `UPI_UTR_VERIFY_URL` provider ke confirm nahi hota; tab
  ledger me `verifiedBy: 'user-claim'` likha jata hai aur bada amount boss approval par jata hai.
* Swiggy kabhi-kabhi place-response me intent hi nahi bhejta — tab payment page se recovery,
  warna `PAYMENT_PENDING` + order ID (order cancel Swiggy khud karta hai).
