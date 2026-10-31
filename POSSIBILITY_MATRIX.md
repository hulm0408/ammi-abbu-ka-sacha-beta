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

## F. Bill calculation ki har possibility (round 18, `bill-reconcile.js`)

| # | Possibility | Kya hota hai |
|---|---|---|
| F1 | Bill hi nahi aaya (null / string / number) | `BILL_MISSING`, koi number invent nahi |
| F2 | `"₹1,234.50"`, `"1 234.5"`, `"Rs 1234"` string money | parse hota hai (`toMoney`) |
| F3 | `NaN` / `abc` / khaali | us line ko chhoda jata hai + note |
| F4 | Negative value (`-20` delivery) | 0 + `BILL_NEGATIVE_VALUE` note |
| F5 | 3+ decimal (10.555) | 2 par round + note |
| F6 | `total` missing | lines se derive + `BILL_TOTAL_MISSING` (derived bata kar) |
| F7 | `itemTotal` missing | items ka jod + `BILL_ITEM_TOTAL_DERIVED` |
| F8 | Total lines se **zyada** (chhupa charge) | limit (₹20/15%) ke andar `otherCharges`, bahar `BILL_DOES_NOT_ADD_UP` |
| F9 | Total lines se **kam** (chhupi saving) | `unlistedDiscount` — darawni warning nahi (boss ka purana rule) |
| F10 | Approved total badal gaya | `BILL_TOTAL_CHANGED` + dono numbers |
| F11 | Free cash payable se zyada | clamp + `BILL_FREE_CASH_OVER_PAYABLE` (negative total nahi) |
| F12 | Coupon "laga hua" par discount 0 | coupon line hatai jati hai + note |
| F13 | Coupon ka discount item total me already shamil | alag line nahi (`discountAlreadyApplied`) |
| F14 | Packing GST ke andar | double nahi jodta + note |
| F15 | One Lite fee par delivery FREE nahi | `BILL_ONE_FEE_WITHOUT_FREE_DELIVERY` note (nuksaan saaf) |
| F16 | Delivery FREE par saving 0 | `BILL_DELIVERY_FREE_NO_SAVING` — 0 hi dikhta hai |
| F17 | Subscription item hai par fee 0 | note, One Lite line nahi |
| F18 | To Pay ₹0 | `BILL_ZERO_TOTAL` |

## G. QR generation ki har possibility (round 18, `qr-generation-plan.js`)

| # | Possibility | Kya hota hai |
|---|---|---|
| G1 | Provider ne intent nahi diya | payment page se recovery, phir bhi nahi → saaf wajah |
| G2 | Escaped/kachra (`&amp;`, `\u0026`, duplicate, space) | normalize + auto-fix warning |
| G3 | `am` + `amount` value alag | bill se match karne wala amount chuna jata hai |
| G4 | Intent `https://…` page link | block — "web page ka link hai, UPI intent nahi" |
| G5 | Placeholder/fake VPA (`swiggy@icici`) | block + wajah |
| G6 | Amount bill se alag | block + dono numbers |
| G7 | Amount missing / 0 / 3 decimal | block |
| G8 | `cu` non-INR | block |
| G9 | Duplicate param alag value | block |
| G10 | Intent bahut lamba (1200 chars) | block — QR scan nahi hoga |
| G11 | Kai sources (provider + page) | pehla valid jeetta, har reject ki wajah rakhi jati hai |
| G12 | Wahi intent do baar | duplicate skip |
| G13 | QR image bani par PNG nahi/khaali | render se pehle `isRenderableQrImage` block |
| G14 | Kuch bhi valid nahi | `ok:false` + HAR wajah (`reasons[]`, max 6) |

Bill ka poora sach quote me `checks` / `problems` / `notes` / `billState` ke roop me jaata hai;
QR ka sach `qrSource` + `qrPlan` me.

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

---

## H. Deploy-proof paisa/UTR + tracking link + auto-fetch (Round 19)

Boss: *"SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"*,
*"TRACKING LINK BHI NAHI AARAHA"*, *"ORDER PAYMENT KARNE KE BAAAD AUTO FETCH BHI NAHI HORAHA"*.

### H — paisa/UTR ka har case

| # | Case | Behaviour |
|---|---|---|
| H1 | `db.json` deploy par naya (`ensureDb` reseed) | boot par snapshot se merge — wallet + `usedUtrs` wapas |
| H2 | Cloud token nahi | local disk copy; status line **saaf** bolti hai "Cloud backup OFF" |
| H3 | Snapshot me balance kam, local me zyada | local jeetta hai — paisa **kabhi** kam nahi |
| H4 | Snapshot me UTR hai, local me nahi | UTR jud jata hai (dobara claim nahi) |
| H5 | Local me UTR hai, snapshot me nahi | local rehta hai (union, delete nahi) |
| H6 | Snapshot duplicate/again push | union idempotent — `changed:false`, jhootha "restore hua" nahi |
| H7 | Snapshot khaali | push skip (`empty`), restore kuch nahi badalta |
| H8 | Vault file encrypted | AES-256-GCM; bina `VAULT_ENCRYPTION_KEY` decrypt nahi — status me wajah |
| H9 | Cloud me UTR plaintext | **never** — test snapshot file me UTR string dhoondta hai |
| H10 | Push fail / net gaya | throttled retry, `lastError` status me; boot kabhi block nahi |
| H11 | Process `SIGTERM` | shutdown se pehle ek force flush |

### H — tracking link

| # | Case | Behaviour |
|---|---|---|
| H12 | Shared/operator ID | 200 + `trackingUrl` (Swiggy), status, ETA — `restricted: true` |
| H13 | Shared ID par private detail | `deliveryOtp` = `''`, `deliveryPartner` = `''` — leak nahi |
| H14 | Provider `swiggy://share?text=<https…>` | https link nikaal kar diya jata hai |
| H15 | Provider ne link nahi diya | `trackingUrl: ''` + saaf note "refresh se status aata rahega" |
| H16 | Doosre order ka link | `safeTrackingUrl` reject (order id mismatch) |
| H17 | Paid checkout restricted user | `publicCheckout` link deta hai, OTP/rider nahi |

### H — auto-fetch

| # | Case | Behaviour |
|---|---|---|
| H18 | Payment ke baad button nahi dabaya | app khud 8s baad `checkout/status`, phir har 12s |
| H19 | 30 try ke baad bhi pending | poller ruk jata hai (battery/net), button bacha rehta hai |
| H20 | `PAID` mil gaya | tracking khud khulta hai + toast |
| H21 | Draft idle band / naya draft | poller band, counter reset |
