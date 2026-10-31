# Telegram Mini App and experimental checkout

The existing Ammi/Abbu chat flow is retained. `/pro` opens a separate Telegram Mini App with Accounts, Address, Search, Cart, Orders and Tools. Telegram-signed `initData` is required for its APIs; a regular browser can only preview the shell. The bot does not ask users to send OTPs, cookies, tokens or session files in chat.

**Important: checkout is experimental and disabled by default.** Swiggy's private API shapes, order placement, UPI deep links, payment verification, OFO, tracking and Swiggy's own recipient SMS have **not** been verified in a live transaction here. Offline tests are not proof of a real order. Do not tell a user an order, payment, tracking link or SMS succeeded unless the actual provider response and device check establish it.

## Telegram's native Open / Open App buttons

The blue **Open** button in Telegram's chat list and **Open App** on the bot profile are Telegram's **Main Mini App** entry points. They are not created by an inline keyboard or `setChatMenuButton`. The Telegram account that owns the bot must enable them:

1. Open the official [@BotFather](https://t.me/BotFather) in Telegram, send `/mybots`, and select the existing Ammi/Abbu bot.
2. Choose **Bot Settings → Configure Mini App → Enable Mini App** (or the equivalent Main Mini App settings in the BotFather Mini App).
3. When asked for the URL, enter the deployed public HTTPS URL ending in `/pro`. The repository's keep-alive workflow references `https://ammi-abbu-ka-sacha-beta.onrender.com`, so its candidate is `https://ammi-abbu-ka-sacha-beta.onrender.com/pro`; first confirm that this is the active service for the selected bot. The public shell alone does not establish that the server is configured with that bot's token or that signed Telegram sessions work.
4. Open the bot profile and tap **Open App**. Check the chat list for **Open** as well; exact presentation can vary by Telegram client/version. If needed, update or restart Telegram. Test with a real Telegram user, not just a browser preview.

The **Open** button beside the chat message field is a separate private-chat menu button, not the Main Mini App setting. In @BotFather send `/setmenubutton`, select the same bot, give the confirmed HTTPS `/pro` URL, and enter `Open` for the button text when prompted. Telegram client layouts may vary. Alternatively, after this version is deployed, setting `PRO_MINIAPP_URL` to the same URL makes the bot configure that menu on startup; `/pro` also opens the app. Neither method enables the profile/chat-list buttons. When the variable is absent or invalid, the bot leaves a manually configured menu unchanged. Use the host's secret settings for the bot token; never send it or OTPs in chat.

## Hosting and configuration

1. The checked-in `render.yaml` describes a **worker**, not an HTTPS web service. The dashboard may also contain a separately configured web service; verify which service actually serves `/pro` and `/pro/api/*`, whether it runs the same bot, and whether it has persistent storage. If there is no suitable service, a migration to a publicly reachable HTTPS **web service** running this process and exposing its assigned `PORT` is needed. That migration has not been tested. Do not run an old worker and a new web service simultaneously with the same Telegram bot token: both would compete for updates. The repository's Render deployment follows `main`, so changes on an unmerged branch are not automatically deployed there.
2. Configure the existing bot secrets through the host's secret manager and set `PRO_MINIAPP_URL` to the real public HTTPS URL ending in `/pro` for `/pro` and the in-chat menu. Use the same URL in BotFather's Main Mini App settings for the native profile/chat-list buttons. The URL must be reachable on the user's phone. Telegram accepts only HTTPS Mini App URLs. Do not put credentials or OTPs into this document, Git, or chat.
3. Set a strong, stable `PRO_VAULT_KEY` (at least 16 characters); `VAULT_ENCRYPTION_KEY` is used only if it is absent. Mini App workspaces are AES-256-GCM encrypted separately per Telegram user under `DATA_DIR/pro-workspaces`. Losing or changing the key makes existing workspaces unreadable. Back up the key securely and back up the encrypted files separately. If no key is configured the server manages a stable one itself (see the section below); the app never dead-ends on a missing key. Shared (boss-uploaded) IDs live in the bot account vault, not in a user's workspace; the Mini App only ever decrypted server-side and never sends a token to the client.
4. Set `DATA_DIR` to **private, persistent storage**. Preserve both `pro-workspaces` and `swiggy-placement-journal`, plus the bot's existing order/account data. Losing or rolling back either directory can defeat the duplicate-order barrier. The journal must be on the same durable filesystem visible to every process that can submit the *same logical checkout*; it uses exclusive creation and fsync. Run **one application instance**: workspace and account locks are in-process, and multiple replicas can overwrite workspace/cart state even when the journal is shared. Do not use ephemeral/serverless local storage or run the separate `bossbot` engine alongside this service on the same order/account. Take consistent encrypted backups; never restore an old snapshot over newer unresolved placement records.
5. In-app UPI checkout is **ON by default** since 31-10-2026 (boss: "actual payment flow apply kar"). Set `PRO_ENABLE_CHECKOUT=0` to turn the happy path off on a service; leave it unset for normal operation. `SWIGGY_BLOCK_LIVE_ORDER_PLACE=1` is the hard block and overrides everything (chat and Mini App placement alike) — remove that block only for an agreed real test. Restart the single service and verify `/pro` inside Telegram. The deployed version and device compatibility must be checked independently.

## Fix the Mini App vault error safely

The message “Mini App vault is not configured” appears **before** an OTP request is sent. It means the active `/pro` server cannot find a sufficiently long vault key; changing the phone number will not fix it.

1. In Render, identify the **web service actually serving the public `/pro` URL**, not just the worker in `render.yaml`. Check its Environment settings and any linked environment group privately. Identify the persistent `DATA_DIR` and preserve its `pro-workspaces` and `swiggy-placement-journal` directories.
2. **If encrypted workspaces already exist or might need recovery**, restore the exact existing encryption key from the trusted service configuration or a secure backup. Never generate a replacement just to dismiss the error. The app uses a non-empty `PRO_VAULT_KEY` in preference to `VAULT_ENCRYPTION_KEY`; a new or incorrect `PRO_VAULT_KEY` overrides the old fallback and makes existing workspaces unreadable. If the original key was the fallback, remove the incorrect override and restore the original fallback value. If the key is lost, preserve the files and investigate backups; there is no safe reset that recovers them.
3. **Only if no existing encrypted workspaces need to be recovered**, create a new strong random secret (for example, 32 random bytes encoded as 64 hex characters) and set it as `PRO_VAULT_KEY` on that service. Back it up securely, separately from the encrypted data. Do not paste the value, any OTP, bot token or session into chat or commit them to Git.
4. Save the environment change and redeploy/restart that one service. Open the app from Telegram and retry. The improved retry/error screen in this branch appears only after these code changes are deployed. A successful bootstrap does not by itself verify OTP delivery or real checkout.

## Checkout behavior and limits

* Resolve/select the receiver and check name, phone, street and map location. For a different receiver, the flow requires an explicit OFO flag in the live cart readback; if Swiggy does not return a recognizable flag, it stops before placement. This is a conservative guard, **not** proof that Swiggy will send an SMS. The bot does not send a recipient SMS, including payment-link SMS.
* Syncing replaces the selected account's Swiggy cart and may save the address. The app independently reads back the saved address and cart, checks item IDs, quantities, variants/add-ons and address, then displays the provider's bill. Direct menu customization, card/COD checkout, manual map pinning and automatic offer selection/claiming are not implemented.
* After reviewing a bill less than five minutes old, the user explicitly confirms the account, receiver and exact amount. Checkout requires a saved Swiggy customer ID so recovery can stay tied to that account; reconnect the account first if its identity is missing. The provider adapter rechecks the live cart, OFO marker, recipient and exact paise, then attempts **one** Swiggy placement POST. A QR is generated only from a UPI intent actually returned by that response, with the exact approved amount and an order ID. No merchant URI or success is invented. Mini App checkout currently supports only the UPI amount returned by this path; other payment/split methods require the official Swiggy app.
* A successful gateway response alone is not an accepted order. Status checking uses the original account, the exact order ID and a provider-reported payment/order state. QR details are hidden once payment is reported, even while order confirmation remains pending. Tracking is fetched only for an order in that account's history. UPI app handoff inside Telegram varies by device; the link is best effort and a second device may be needed to scan the QR. This has not been tested on a real device.
* This filesystem barrier is **not Swiggy-provided idempotency**. It protects repeated attempts for the same journaled chat order or Mini App checkout generation on that disk; it cannot prevent a user from manually placing another order, submitting a separate chat/Mini App order, using another deployment or losing/rolling back the journal. Never place the same order simultaneously through another client.

## Unknown outcome or recovery

If a request times out, returns no valid payment intent, the server restarts while submitting, or the browser loses the result, **an order may already exist**. Do not retry, switch accounts, refresh/replace the cart, pay twice or claim that the order was cancelled. The app locks draft-cart/receiver changes and account switching while a checkout is unresolved; reconnecting is permitted only for the verified original account. If an older unresolved checkout has no recoverable customer ID, reconnecting stays blocked rather than guessing; preserve the data and investigate. The in-app checkout-history button also uses that original account, including in older workspaces where another account was selected. An empty or delayed order list does not prove failure. Check **My Orders on the original Swiggy account** and its payment history. If an exact order ID is known, use the status check; only a verified paid order can be explicitly closed to start a new Mini App draft. A `SUBMITTING`/unknown state with no order ID stays blocked across restarts; there is deliberately no automatic expiry or reset. Keep the journal and workspace intact and seek operator-assisted investigation before any separate order.

## Offline tests and authorized live trial

```bash
npm ci --ignore-scripts
npm run test:pro
npm test
```

`test:pro` uses fake providers and fault-injected Swiggy-shaped HTTP responses. It checks Telegram authentication, isolation, exact cart/recipient/amount, a single POST under concurrent taps, timeout/restart replay, account failover guards, QR contents, payment/order mismatch and tracking ownership. It does **not** verify Swiggy's real private API or SMS.

A real trial requires a suitable deployed HTTPS service with persistent storage, an account controlled by the user, an actual receiver, and a real device. First verify login, link autofill, cart/bill and recipient in Swiggy without paying. Only after the user explicitly confirms the actual account, recipient, exact amount and that a real paid order is authorized should anyone submit it. Record the genuine result in Swiggy, payment app, and on the recipient's phone. Never ask the user to post OTPs, credentials or session tokens in chat.

## Shared IDs, privacy and update-safe data (31-10-2026)

* **Operator (Boss) IDs are shared, user IDs are private.** Every account uploaded to the Boss/shared vault is listed for all Mini App users so they can order from it. An account a normal user adds with OTP or JSON stays in **that user's own encrypted workspace** and is never listed for anyone else, never selectable by another user and never written into the shared vault.
* **Nothing secret is exposed.** Account tokens, cookies and sessions never reach the browser. On an operator ID the full phone number is masked for normal users; the Boss sees it in full. A shared ID cannot be removed or claimed by a normal user (`canRemove`/`canClaim`), so one user cannot wipe or claim another's ID.
* **Used IDs warn, then allow.** A used ID (orders already placed on it) returns `409 ACCOUNT_NEEDS_CONFIRM`; the app shows an in-app warning and only selects it after the user confirms (`confirmUsed: true`). Suspended, expired and busy (live order) IDs stay blocked.
* **Privacy of order history and addresses.** On a shared operator ID a normal user gets a compact order card only (no item list, no address, no tracking), and the operator's saved address book is not shown — the user adds their own address by link. The Boss sees full details. Tracking endpoints return `403 SHARED_ACCOUNT_RESTRICTED` for normal users on shared IDs.
* **Everything stays inside the Mini App.** There are no external browser links (Swiggy cart, My Orders or offer pages). Payment uses the Swiggy UPI intent as before; problems are raised through **Contact admin**, which opens a Telegram DM using `ADMIN_TELEGRAM_USERNAME` (fallback `BOSS_TELEGRAM_USERNAME`).
* **Bill breakdown** mirrors Swiggy: item total, delivery fee (`FREE` when zero), GST & other charges, coupon saving and **To Pay**. A positive unexplained difference is surfaced as `otherCharges`; a total *below* the listed lines is treated as an unlisted Swiggy discount (`unlistedDiscount`) and shown as a saving line. The old "lines aur total me farak hai" warning box is gone for good (boss rejected it on 31-10-2026).
* **Updates do not reset user data.** The server only adds fields to the workspace schema and never deletes `pro-workspaces` on a failed request. When `GITHUB_VAULT_TOKEN` is configured, each encrypted workspace blob is backed up to `vault/pro-workspaces/<hash>.json` on the `bot-vault` branch and restored before the first read on a fresh disk (set `PRO_VAULT_CLOUD_BACKUP=0` to opt out). The browser also keeps only non-secret UI state (last tab, theme, remembered ID names) so a redeploy shows a "re-login needed" reminder instead of an empty screen. Switch IDs/carts are never restored from the browser.

## Cart, claims and delete (31-10-2026, round 2)

* **Cart page** now follows the Swiggy cart layout: group-cart link, "Delivering to", "Your Order" with item steppers, "Apply coupon" (expands to the coupon + bill form), "Bill Details", and "Payment Method". Only **UPI / QR** is real; card and cash-on-delivery are shown disabled with an honest reason. The "Pay Now" bar appears when a fresh Swiggy bill exists and runs the real checkout by default (`PRO_ENABLE_CHECKOUT=0` opts out, `SWIGGY_BLOCK_LIVE_ORDER_PLACE=1` hard-blocks).
* **Progress + skeletons.** Every in-app request shows a thin top progress bar, buttons show a spinner, and the page that is loading shows skeleton rows instead of an empty screen. Menu opening and restaurant search have their own returning skeletons.
* **Offers are claimable in the app.** Tools lists every offer track (late night, breakfast, extra ₹50, weekend, Karwa Chauth) per account with the honest state, and a claim button runs the same verified `activateAllEventOffers` path the bot uses: read state first, write once, read back, never claim twice. Results are stored on the account so the icons (claimed ✓ / not claimed struck-through) survive a reload. **Operator IDs cannot be claimed** (`403 SHARED_ACCOUNT_RESTRICTED`).
* **Delete has two separate options.** "Database se hatao" only removes the ID from this app/vault. "Swiggy se delete" asks Swiggy for its **delete OTP**, and only after that 6-digit OTP is verified does it remove the account — locally and at Swiggy. A wrong OTP leaves the account untouched. Operator IDs can never be deleted by a normal user. Swiggy deletion is irreversible; no backup file is sent from the Mini App.
* **Restaurant locations and dish search.** Search results show one row per outlet with a "N locations" pill, the menu page lists the other outlets of the same restaurant as chips, and the menu has its own dish search that filters instantly.
* **No admin/support button.** The Mini App no longer opens a Telegram DM or any external link.

## Cart parity with Swiggy + real payment (31-10-2026, round 3)

* **Payment is real by default.** `checkoutEnabled()` in `swiggy-pro-api.js` returns `true` unless `PRO_ENABLE_CHECKOUT=0` or `SWIGGY_BLOCK_LIVE_ORDER_PLACE=1`. `/pro/api/bootstrap` now returns `checkoutEnabled` **and** `checkoutBlockReason`, so when payment really is blocked the app shows the actual reason instead of a silent "band hai". The `Pay Now` band is a live green button whenever a fresh bill exists.
* **Cart header matches Swiggy.** Restaurant thumbnail, name, area · ETA, and a trash button (`cart-clear`, confirm-first) sit where Swiggy puts them. Item rows carry a veg/non-veg mark, the green quantity stepper and the line total.
* **Franchise / multiple outlets.** Each cart row has an outlet row (`outlets-toggle`): it shows the current area + ETA and expands into nearby branches from `GET /pro/api/restaurants/outlets?q=<name>`, each with area, distance, ETA and open/closed state. Closed branches and the current branch are disabled; picking another branch opens that outlet's menu.
* **Group cart is a toggle**, not an always-open form.
* **Bill maths is honest and quiet.** `itemTotal`, `deliveryFee` (`FREE` when 0, with the delivery distance), `GST & other charges` and `To Pay` add up; the two reconciliation fields are `otherCharges` (positive gap) and `unlistedDiscount` (total below the listed lines). `mismatch` is always `false` — no warning box.
* **New/changed routes:** `POST /pro/api/cart/clear` (`{confirmClear:true}`) and `GET /pro/api/restaurants/outlets?q=`. `cart/sync` now also stores the restaurant's area/ETA/image/rating from the open menu so the cart header survives a reload.
* **Tests:** `test_v94_miniapp_cart_parity.mjs` (9 offline checks: payment default/opt-out/hard block, outlet list, confirm-gated clear, cart meta, cart DOM, outlet dropdown, group-cart toggle, disabled-payment reason, CSS hooks). `test_v93` now asserts the `unlistedDiscount` behaviour instead of the removed `mismatch` warning.

## Shared IDs, privacy and update-safe data (31-10-2026, round 4)

* **Boss ke upload kiye ID sabko dikhte hain, par badalna sirf boss ka haq.** `accountMap(user, ws)` shared vault (`db.config.accounts`) aur user ke private workspace ko jodta hai. Ek normal user ko shared ID `owner: 'operator'`, masked number (`98••••0001`), `canClaim: false` aur `canRemove: false` ke saath milti hai; token kabhi JSON me nahi jaata. User ka apna ID sirf usi ko dikhta hai — doosre user ko 404.
* **Used ID: pehle warning, phir select.** `POST /pro/api/accounts/select` `409 ACCOUNT_NEEDS_CONFIRM` deta hai jab ID par pehle order ho chuke hain; `{ confirmUsed: true }` ke baad wahi ID select ho jaati hai. `BUSY` (kisi chalte order ki ID), `SUSPENDED` aur `SESSION_EXPIRED` confirm ke baad bhi band rehti hain. App pehle in-app dialog dikhata hai, seedha call nahi karta.
* **Address privacy.** Shared ID par `GET /pro/api/addresses` saved address list **khaali** lauta kar ek note deta hai — doosre logon ke address kabhi nahi dikhte. User apna address link se add karta hai (uske workspace me rehta hai). Boss ko poora list dikhta hai. Fetch do baar try karta hai (350 ms gap) aur uske baad hi error deta hai, taaki ek transient Swiggy failure "address nahi mila" na bane.
* **Order history.** Shared ID ke orders normal user ko chhote card me (id, restaurant, status, amount, date) milte hain; `orders/tracking` par `403 SHARED_ACCOUNT_RESTRICTED`. Boss ko items, address aur tracking sab dikhta hai.
* **Update se data reset nahi.** Workspace schema sirf naye fields add karta hai aur failed request par file delete nahi karta. Encrypted blob per user `DATA_DIR/pro-workspaces` me rehta hai; `PRO_VAULT_CLOUD_BACKUP` (default on, `=0` se off) se wahi blob cloud vault me bhi jaata hai aur fresh disk par pehle read se pehle wapas aata hai (`ensureProWorkspaceHydrated`). Browser me sirf non-secret UI state (`pro-state-v2`: tab, theme, pehle dikhi ID ka naam) rehta hai — redeploy par khaali screen ki jagah "re-login needed" reminder.
* **App ke andar hi sab.** Koi browser link, `target="_blank"`, ya `window.open` nahi — tracking bhi app me dikhti hai. Sirf `upi:` intent (payment) allowed hai — Swiggy/BotFather ka koi link app me nahi hai.

## Checkout page + outlet picker (31-10-2026, round 5)

* **Checkout page Swiggy jaisa.** Cart tab ab `CHECKOUT` page hai: ETA strip ("Delivery in 25 min" + restaurant + "Deliver to HOME") → address tile → "Your Order" (restaurant head, items, steppers, add more) → group-cart toggle → "Apply coupon" → "Bill Details" → "Payment Method" → sticky **Pay Now** bar. Section order is asserted in `test_v93`.
* **Pay Now always live.** Bill na ho to button phir bhi dabta hai: pehle `cart/sync` se taaza Swiggy bill aata hai, phir ek Hinglish confirm dialog (`Pay ₹335 — order confirm?` with restaurant, receiver, full address) aur phir asli `POST /pro/api/checkout`. Ek hi tap me order confirm nahi hota, par koi dead end bhi nahi.
* **Restaurant kholne par outlet chunna.** Search results me same naam ke >1 outlet ho to row dabane par Swiggy jaisa bottom sheet (`CHOOSE LOCATION`) aata hai — har branch ka area, distance, ETA aur open/closed. Band branch disabled, current branch "Yahi". Ek hi outlet ho to seedha menu. Menu page par bhi outlet row ("25 min · Outlet badlein") wahi sheet kholta hai.
* **Tracking app ke andar.** `target="_blank"` / `window.open` / browser link hata diye gaye; status, ETA, partner aur OTP app me hi dikhte hain.
* `test_v93` (20 checks) aur `test_v94` (13 checks) in dono pages ko lock karte hain.

## Group cart parsing + backup truth (31-10-2026, round 6)

* **Koi dropdown nahi.** Cart page par group cart ka link box aur **"Cart parse karein"** button hamesha saamne hain (`form[data-form="group-cart"]`). Input `type="text"` + `inputmode="url"` hai taaki `swiggy://` deep link bhi paste ho sake. Khaali box par seedha message aata hai, request nahi jaati.
* **5 link shapes parse hote hain** (`extractGroupCartRef` / `resolveGroupCartLink` in `swiggy-pro-provider.js`):
  1. `https://www.swiggy.com/gc/<x>/<slug>-<cartId>` (web share)
  2. `https://www.swiggy.com/gc/<cartId>` (chhota link)
  3. `?sharedCartId=` / `?groupCartId=` / `?shared_cart_id=` query links
  4. `swiggy://gc?shared_cart_id=…` aur `swiggy://share?text=<encoded url>` deep links
  5. `swig.gy` / `swiggy.onelink.me` short links (redirect expand karke)
  URL-encoded link bhi khulta hai. Kuch match na ho to saaf wajah + jo format chahiye wo message me aata hai; jhootha cart id kabhi nahi.
* **Backup ab do jagah, aur sach dikhta hai.**
  * **DB mirror:** har workspace ka *encrypted* envelope `db.json` → `config.proWorkspaceMirror` me (debounce 1.5 s, max 300 rows, checksum ke saath). Koi token nahi chahiye.
  * **Cloud vault:** `vault/pro-workspaces/<hash>.json` (`GITHUB_VAULT_TOKEN`/git hone par).
  * Restore: local file na mile to pehle cloud, phir DB mirror (`ensureProWorkspaceHydrated`), aur `backup.restored` me `lastFrom` + count aata hai.
  * **Boss ko Tools me "Data backup" card**: mirror rows, last save time, cloud ON/OFF, cloud ki asli error, kitni baar restore hua, aur **"Abhi backup karein"** button (`POST /pro/api/backup`, sirf boss).
  * `GET /pro/api/bootstrap` ab `backup` field deta hai — boss ko poora, user ko sirf mirror ki haalat.
* **Tests:** `test_v95_miniapp_cart_import_and_backup.mjs` (11 checks: 7 link shapes, galat link par asli error, short-link expansion, mirror→restore, backup status/route permissions, no-dropdown DOM, parse request, khaali-link toast, boss backup card, user ko card nahi).

## Round 7 (31-10-2026): cart fetch, Swiggy-jaisa checkout, coupon page, tracking

* **Cart fetch ka asli fix.** Mini app sirf `GET /api/v1/shared_cart` karta tha, jisse doosre customer ka group cart `statusCode 86` (USER_ALREADY_PART_OF_GROUP_CART) ya khaali aata tha. Ab pehle bot ka proven engine chalta hai — `POST /api/v1/shared_cart/join` (ephemeral reader `user_id`) — phir read-only GET. Fail par HTTP status + Swiggy ka `statusCode`/`statusMessage` message me aata hai; band cart (`88` / GROUP_CART_NO_LONGER_EXISTS) aur place-ho-chuka cart ki alag saaf wajah.
* **Link shapes:** apna parser + `resolveSwiggyLink` fallback (AppsFlyer HTML, `swiggy://webviewV2?group_cart_id=…`, `af_dp`/`deep_link_value`). Address pin na ho to bhi cart parse hota hai (lat/lng sirf headers ke liye).
* **Navigation block khatam.** Global `state.busy` lock hata diya — sirf wahi button band hota hai jisne request bheji. Address load hote waqt bhi doosra tab turant khulta hai.
* **Cart/checkout page Swiggy jaisa:** ETA + "Deliver to", savings banner, Your Order card (rating, items, swiggy-style stepper), "Add Items / Apply coupon" chips, **Complete your meal** rail (isi restaurant ke asli menu se), **Savings Corner** (Applied/Remove), bill, payment method, aur pay bar: bada total + `View Detailed Bill` + green **Pay Now · Proceed to Pay**.
* **Coupon page** (`Apply coupon`): applied coupon ka ribbon (`₹140 OFF`, REMOVE), asli code se APPLY, aur Swiggy ke coupon tool (`fetch_food_coupons`) ki list — jo lagta nahi wo LOCKED + reason. List khaali aaye to saaf likha: "Swiggy ne list nahi di".
* **Route:** `GET /pro/api/coupons?id=<restaurantId>`; `restaurants/outlets` me ab `rating`/`ratings` bhi.
* **Pay → track:** Pay Now (bill na ho to pehle khud bill leke) → payment screen (QR + "Payment check karein") → `checkout/status` PAID → **tracking screen** (timeline, ETA, rider, delivery OTP) jo 20s me khud refresh hota hai. `orders/tracking` hi source hai — koi guess nahi.
* **Typing safe:** re-render par coupon code / group cart link ka typed text nahi udta.
* **Imaandaar:** payment band ho to pay bar ke neeche asli reason (`PRO_ENABLE_CHECKOUT=0` jaisa) dikhta hai, sirf tooltip nahi.

## Round 8 (31-10-2026): poora bill hisaab + coupon sirf APPLY

* **Coupon page: koi code type nahi — sirf APPLY.** Har coupon card par ek hi button. List kabhi khaali nahi: pehle Swiggy ke apne `fetch_food_coupons` ke coupons, phir wahi promo codes jo bot ka engine har order par test karta hai (`SNACKIT`, `TRYNEW`, `STEALDEAL`, `SWIGGYIT`, `WELCOME50`). "Coupon available nahi hai" jaisa message kabhi nahi aata.
* **APPLY = asli bill.** Dabate hi `cart/sync` chalta hai, aur card par wahin result likha aata hai: `Laga — ₹140 ki saving` ya `Swiggy ne is code par discount nahi diya — bill me 0 dikha`. Jhootha saving kabhi nahi.
* **Bill Details detailed:** Item Total (strike ke saath jab discount laga), Delivery Fee (+ distance), GST & Other Charges, Coupon, Offer saving, **To Pay** — phir `Poora hisaab dekhein` par har item (`× qty = ₹`) aur poora jod: `Items + Delivery + Packing + GST + Other − Coupon − Offer = To Pay`. Swiggy ka total hi final.
* **Checkout dead end gaya:** Pay Now / bill / coupon sabse pehle receiver check karte hain. Naam ya 10-digit mobile adhoora ho to app seedha **address page ke receiver form** par le jaata hai (pehle API error aata tha aur user ko lagta tha checkout kharab hai). `customer_id` kisi purane session me na ho to bill sync ke waqt app ek baar Swiggy se identity le kar save kar leta hai (order placement ka double-tap barrier waisa hi rehta hai).
* **Test:** `test_v97` (6 checks) + v90/v93/v96 updated. Sweep: `test:pro` 40/40, `test:guards` 65/65, `npm test` 132/132, bossbot 49/49.

## Round 9 (31-10-2026): bill summary bilkul Swiggy jaisa

Boss ka example: `Items Total ₹230 · Coupon FLASHSALE −₹160 · Extra Discount (Free Cash) −₹70 · Swiggy One Lite Membership +₹1 · Free Delivery ₹49 saved · Packing ₹5 · GST & Other ₹27.85 · Total Savings ₹279 · To Pay ₹29`.

* **Provider (`quoteCart`)** ab Swiggy ke parsed cart se yehi fields bill me bhejta hai: `itemTotal, deliveryFee, deliverySaved, deliveryFree, packingCharges, taxes, discount + coupon, freeCash, tradeDiscount, oneMembershipFee, oneApplied, totalSavings` — aur `total` wahi `meta.order_total` (jo Swiggy charge karta hai; checkout isi se match karta hai).
* **`billBreakdown`** ab `free cash` / `tradeDiscount` / `One fee` ko jod me leta hai; jo bacha wo `otherCharges`, jo kam pada wo `unlistedDiscount` (bill me "Extra saving (bill me)" line). Isliye lines ka jod **hamesha To Pay ke barabar** hota hai — koi darawne warning nahi.
* **Bill Details card** me lines: Items Total · Coupon X · Extra Discount (Free Cash) · Extra Discount (Restaurant) · Swiggy One Lite Membership (+) · Free Delivery (+ kitna saved) · Delivery Fee FREE (₹49 saved) · Packing Charges · GST & Other Charges · Extra saving · **Total Savings** · **To Pay**. `Poora hisaab dekhein` par item-wise lines + pura equation.
* **Savings Corner** me wahi rows (Coupon/Free Cash/Restaurant/Free delivery/One Lite fee) + `₹279 saved` pill, aur **banner** me Swiggy ka khud ka `totalSavings` (apna bada number nahi banate).
* **Test:** `test_v98` (2 checks, boss ka exact ₹230 → ₹29 case) — lines ka jod To Pay se match, jhootha saving nahi. Sweep: `test:pro` 40/40, `test:guards` 66/66, `npm test` 132/132, bossbot 49/49.

## Round 10 (31-10-2026): Pay ki asli wajah + naye number ka login

### "Swiggy cart, recipient/OFO, coupon or amount could not be confirmed"
Pehle **ek hi generic line** thi — user ko pata hi nahi chalta tha kya badla. Ab `provider.checkout` har check alag karta hai aur message me **dono numbers** aate hain:

| Code | Matlab | Kya hota hai |
|---|---|---|
| `CART_FETCH` / `CART_PARSE` / `CART_ID` | Swiggy ne cart/jawab/cart-id nahi diya | Order nahi, asli HTTP+statusCode message |
| `CART_ITEMS` | Swiggy ke cart me items badal gaye | Order nahi, "cart sync karein" |
| `RESTAURANT` / `ADDRESS` / `OFO` | restaurant, address ya OFO flag alag | Order nahi, saaf wajah |
| `AMOUNT` | bill ka amount badal gaya | **Order nahi** + **naya bill save** + "aapne ₹29 dekha, Swiggy ab ₹33.85 keh raha hai" |
| `COUPON` | coupon lag/hat gaya | **Order nahi** + naya bill + dono coupon naam |

* Recoverable case (`AMOUNT`/`COUPON`) me API **naya bill workspace me save** karta hai aur 409 `BILL_CHANGED` deta hai. App bootstrap karke naya total dikhata hai — user ek baar dekh kar dobara Pay dabata hai. Koi loop nahi, koi galat amount ka order nahi.
* App ab in codes par **"outcome unknown"** ka darr nahi dikhata (pehle har error par dikhta tha, jabki kuch place hi nahi hua tha).
* `cart/sync` ab `quote.couponCode` bhi save karta hai (bill me discount item-total me hone par bhi asli coupon compare hota hai).
* Items compare tolerant hai: group-cart ke raw variants/add-ons shape alag hone par bhi `item+qty` match ho to order rukta nahi; sirf sach me badla ho tab rukta hai.

### Naya number = login hi nahi hota
* `POST /accounts/send-otp` ab `signup: true` leta hai. Bina consent Swiggy account nahi banta; app pehle poochta hai **"Naya Swiggy account banayein?"** (naam + number dikha kar), phir signup ke saath OTP maangta hai. Pehle seedha "not registered" error aata tha — dead end.
* **30-second cooldown bug:** naya number par "account banayein" dabane ke baad bhi 30s tak retry block tha (cooldown fail par bhi set ho raha tha). Ab cooldown sirf success par lagta hai.
* `verify-otp`: brand-new account par Swiggy ka profile kabhi `customer_id` nahi deta → account save hi nahi hota tha. Ab OTP-verified session ke JWT se **asli** `user_id` liya jaata hai (koi invent nahi). Sirf jab wahan bhi na mile to saaf error.
* Error JSON me ab `code` aata hai (`SWIGGY_ACCOUNT_NOT_REGISTERED`, `OTP_IDENTITY_MISSING`, `BILL_CHANGED`, …) — app usi se sahi agla kadam dikhata hai.

## Round 11 (31-10-2026): OFO ka jhootha block, auto coupon bill, wallet ₹15 + UPI

### 1. "Swiggy ne order for someone else flag confirm nahi kiya" — ye block hata diya
Swiggy ka cart readback (jisse hum bill banate hain) OFO flag **deti hi nahi**, isliye `cart.forSomeoneElse` wala har order `OFO` hard-stop par ruk jaata tha — order jaata hi nahi tha. Ab:
* `OFO` ab **hard stop nahi** hai (problems list se hata diya, `hardStop` se bhi).
* OFO ka sach sirf **place-response** se aata hai: `result.ofoConfirmed` (jhooth nahi) + `result.ofoNote` (Hinglish me saaf: "Swiggy ne place-response me OFO flag nahi diya — order normal order ki tarah gaya, khana usi address par jayega").
* OFO fields (recipient name/phone, alternate_mobile, delivery instructions) ab bhi cart aur place payload me jaate hain — bas unka echo na aana order nahi rokta.

### 2. "AUTO SAARE COUPON LAG KAR AISA SUMMARY NAHI AARHA"
* `provider.quoteCart(account, address, cart, '')` — jab user ne koi code na chuna ho aur `cart.autoCoupon !== false` ho, provider Swiggy ke coupons (MCP `fetch_food_coupons` + promo list) se **top 3** codes try karta hai, har attempt ka **asli bill** padhta hai, aur **sabse kam total** wala coupon rakhta hai. Saboot bill me: `autoCoupon: true`, `couponTried: [...]`.
* User ne code chuna ho to wahi chalta hai (auto band). `Remove` dabane par `autoCoupon: false` jaata hai — jaan-boojh kar hataya hua coupon wapas nahi lagta.
* **Puraana bug:** Pay Now aur `bill-refresh` dono `coupon: ''` bhejte the — yani jaan-boojh kar coupon hata kar naya bill le rahe the. Ab dono **pehle se laga coupon** bhejte hain + `autoCoupon: true`.
* **Automatic bill:** cart kholte hi (items + poora receiver hone par) app khud `cart/sync` karta hai — Pay dabane ka intezaar nahi. Ek hi baar per cart+address (loop nahi), aur receiver adhoora ho to bilkul nahi.
* **Bill ka plain text:** `billText()` bilkul Swiggy ke summary jaisa organized block deta hai (`Paneer Kolhapuri ₹230 × 1 = ₹230` → `1 Item • Subtotal: ₹230` → `Bill Summary` → `Items Total` → `Coupon FLASHSALE: −₹160` → `Extra Discount ( Free Cash ): −₹70` → `Swiggy One Lite Membership: +₹1` → `Free Delivery upto 7km` → `Delivery Fee: FREE (₹49 saved)` → `Packing Charges: ₹5` → `GST & Other Charges: ₹27.85` → `────────` → `Total Savings: ₹279` → `To Pay: ₹29`). Card me `<pre class="bill-plain">` ke roop me dikhta hai. Koi number invent nahi — jo Swiggy ne diya wahi.

### 3. Wallet: ₹15 fee + UPI top-up (`mius@ybl`) + jitna bheja utna credit
* **Gate:** order place karne se **pehle** wallet me fee (default **₹15**) chahiye. Balance kam ho to `409 WALLET_LOW_BALANCE` + asli message: "Wallet balance ₹0 hai — order place karne ke liye ₹15 chahiye. ₹15 add karein (UPI: mius@ybl)" + `wallet` payload (balance/shortfall/upiId). Bill dekhne par kuch nahi rukta.
* **Fee kab katti hai:** checkout start hote hi (QR/order stage) `chargeServiceFee` — ek order par ek hi baar. Order place **na** ho (pre-placement failure / `BILL_CHANGED`) to `refundServiceFee` se **fee wapas**.
* **Routes:**
  * `GET /pro/api/wallet` → balance, fee, exempt, ready, shortfall, `upiId`, presets, history.
  * `POST /pro/api/wallet/topup {amountPaise|amountRupees}` → asli `upi://pay?pa=mius@ybl&am=15.00&cu=INR` intent + PNG QR (Telegram ke andar hi dikhta hai).
  * `POST /pro/api/wallet/claim {amountRupees, utr?}` → **jitna user kehta hai ki usne bheja, utna hi credit** (boss: "IF USER PAY LESS AND SAY I HAVE PAID YOU HAVE TO ADD HOW MUCH THEY PAID"). Ledger me `CLAIMED`, audit ke liye `db.config.topupClaims`. UTR diya aur provider configured hai to `AUTO_VERIFIED` (jhootha verified nahi). Response me seedha: "₹10 jama hua. Abhi balance ₹10 hai — ₹5 aur add karein."
  * `POST /pro/api/wallet/upi {upiId}` → **sirf boss**. Default `mius@ybl`; `WALLET_UPI_ID` env se bhi.
* **UI:** cart aur tools tab me **Wallet card** — balance, fee, "Low balance" pill + kitna add karna hai, ₹15/₹50/₹100 quick buttons, QR + "UPI app me ₹15 bhejein", aur **"Paisa bhej diya?"** form (amount + optional UTR). Boss ko `UPI badlein` ka option bhi wahi card me.
* **Tests:** `test_v100_miniapp_wallet_ofo_autobill.mjs` (14 checks) — OFO soft (order jaata hai, `ofoConfirmed:false`, note sach), auto coupon (best total, `couponTried`), `cart/sync` me `autoCoupon`, wallet default UPI/fee/low balance, ₹10 → ₹5 → ready, topup QR `pa=mius%40ybl`, boss-only UPI change, `WALLET_LOW_BALANCE` par provider tak baat nahi, fee charge + refund, bill text ki exact lines, auto bill.
* `test_v89` (7) aur `test_v88` (41) update kiye — OFO flag ab blocking nahi, aur checkout tests wallet funded karte hain.
* Sweep: `test:guards` **68/68 (126s)**, `test:pro` **41/41**, `npm test` **132/132**, DOM v90/v93/v94/v96/v97/v98 **58/58**, v99 **7/7**, v100 **14/14**.
