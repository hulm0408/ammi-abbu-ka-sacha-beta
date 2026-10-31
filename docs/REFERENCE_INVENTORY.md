# Reference Screen Inventory — Mini App (Swiggy Pro style)

Ye document **Phase 2** ka deliverable hai: har screen ka layout hierarchy, naap (spacing,
type, radius, shadow), states aur interaction. Numbers wahin se aaye hain jahan se code
chalta hai — `swiggy-pro.css` ke tokens + rendered screenshots (`screenshots/*.png`,
`npm run shots:miniapp`) se verify kiya gaya.

> **Sach pehle:** is repo me reference PNGs commit nahi hain (wo boss ke phone se aate hain
> aur yahan upload nahi hote). Jo bhi "reference" bola gaya hai wo in screenshots se aaya
> hai jo session me inspect hue + jo measurements `swiggy-*` files me already implemented
> the. Jahan reference aur implementation me farak confirm nahi ho saka, wahan
> **"unverified"** likha hai — jhoot nahi.

---

## 0. Design tokens (single source of truth)

| Token | Value | Kahan |
|---|---|---|
| `--s-1 … --s-7` | 4, 8, 12, 16, 20, 24, 32 px | `swiggy-pro.css` Round 28 |
| `--t-11 … --t-27` | 11, 12, 13, 14, 15, 16, 17, 20, 27 px | same |
| `--r-sm/md/lg/xl` | 10 / 14 / 18 / 22 px | same |
| `--shadow-card` | `0 4px 16px rgba(24,49,70,.05)` | cards |
| `--shadow-float` | `0 10px 30px rgba(20,44,63,.13)` | pay bar, sheet |
| `--ease-soft` / `--ease-spring` | `cubic-bezier(.2,.9,.28,1)` / `…(.2,.9,.28,1.12)` | motion |
| `--dur-1/2/3` | .16s / .28s / .42s | motion |
| `--green` / `--blue` | `#079b73` / `#169bc8` | brand accents (apne, Swiggy ke nahi) |
| `--nav-height` | 78 px | fixed bottom nav |
| Font | Manrope (fallback Inter → system) | `swiggy-pro.html` preconnect + `display=swap` |

---

## 1. Application shell

| Element | Measurement | Notes |
|---|---|---|
| Top bar | sticky, `min-height 76px`, padding `12px 20px`, 1px bottom border | logo tile 42×42 r15, brand 19px/850, account chip 12px/800 r13 max 145px, theme button 39×39 r50% |
| Page background | `--bg #f7f9fc`; app-shell max 720px, centered | body bg `#e8eef3` (desktop gutter) |
| Content | `padding: 24px 22px` (+ bottom clearance `nav 78 + 96`) | <390px → 16px |
| Bottom nav | fixed, 6 columns, height `78 + safe-area`, icon 23px, label 10px/800 | active = blue + `--blue-light` pill r14 + icon bump |
| Toast | fixed top, drop animation, icon `✓ / ! / i`, 4300 ms | type guess nahi hota |
| Load bar | 3px top progress | har request par |

States: loading skeleton (shimmer), empty (74px circle icon + 17px title + 14px text), error
(`.warning` amber), success (`.success-note` green).

---

## 2. Accounts screen

Hierarchy: `topbar` → eyebrow `YOUR SPACE` (11px/850, letter-spacing .1em, blue) →
H1 `Accounts` (27px/850, -.045em) → sub (14px muted) → **Add account card** (16px padding,
r18) → segmented `Phone number / Session JSON` → field `+91` + input → `Send OTP` button
(full width, 46px, r13) → hint → **Saved accounts** line-heading → account cards
(15px padding, r18, active = green tint + green border) → delete icon-button 37×37 r11.

Interactions: tab switch (segmented), OTP send → busy → success/error; account select
(updates activeAccount + cart context); delete → two-choice confirm dialog (DB only /
Swiggy too — Swiggy par OTP mandatory).

---

## 3. Cart / Checkout screen

Order of blocks (verified in rendered screenshot `04-cart.png`):

1. `eta-strip` — green tint, r14, icon 20px, title 14px/800, sub 12px
2. `savings-banner` — green tint, 13px/700, SVG spark (koi emoji nahi)
3. `select-address` row — pin tile + `DELIVERING TO` (11px/800 letterspaced) + name
   (15px/850) + address (12px, ellipsis) + chevron
4. `line-heading` — `Your Order` 17px/850 + pill `n items · ₹total`
5. Restaurant card: 48px tile, title 15px/850 + rating chip, sub 12px, trash icon-button
6. Outlet row (dropdown, `aria-expanded`), item rows with veg mark + green stepper
7. `Add Items` / `Apply coupon` chips
8. Group cart card: icon tile + title + **real `role="switch"` toggle** (46×27) + input +
   `Cart parse karein` button (hamesha visible)
9. Coupon strip (`SAVINGS CORNER` + 3 inline coupons with APPLY + `Saare coupons (n)`)
10. `Bill Details` card — rows 14px, total 17px/900, `Poora hisaab` disclosure
11. `Payment Method` card — 3 tiles (UPI selected green radio, Card/COD faded), `Updating`
    spinner pill jab quote na ho
12. Wallet card (fee gate, UTR form)
13. **Sticky pay bar** — `PAY USING UPI` 10px/800 + amount 20px/900 + `Pay Now · Proceed to
    Pay` (green, 50px, r14), `position: sticky; bottom: nav+8`

Interactions aur rules: qty ± (min 1, 0 se remove confirm), remove item, refresh bill,
coupon APPLY → asli `cart/sync` → bill badalta hai, Pay → checkout, 2-minute idle chip.

---

## 4. Coupon sheet (bottom sheet — Rule 3C)

| Item | Measurement |
|---|---|
| Backdrop | `rgba(15,23,42,.45)`, `backdrop-in` .28s |
| Sheet | fixed bottom, `max-height 88dvh`, r22 top, `shadow-float`, `sheet-rise` spring .42s |
| Grip | 42×4 r99 |
| Head | 48px tile + `Apply Coupon` 20px/850 + close icon-button 37×37 |
| Count | `AVAILABLE COUPONS n` 12px/800 letterspaced |
| Tiles | white card r18, ribbon 96×118 orange (percent ya OFFER), code 15px/850, title 13px green, desc 12px muted, `APPLY` pill (blue tint, r99) |

States: loading skeletons, applied ribbon (`REMOVE`), per-tile result line
(`Laga — ₹140 saving` / honest error), busy `APPLYING…`. Close: X, backdrop, back button.
**Coupon code input jaan-boojh kar nahi** (boss rule #49: list + APPLY only).

---

## 5. Orders screen

| Element | Measurement |
|---|---|
| Header | `ORDER HISTORY` eyebrow + H1 + sub + `Refresh` mini soft |
| Segmented | `This Account` / `Last 1 Hour · n` — count **sirf** jab time parse ho; warna disabled + `title` me asli wajah |
| Order card | r18, 15px padding, tile + restaurant 15px/850 + time 13px + items 13px + `#id` mono 11px + status pill (green = delivered) |

Order detail: top action pills (`Back to Orders`, `Refresh`) → delivered hero (green check
88px + `Order Delivered` 27px + pill + placed line) → `ORDER DETAILS` head → status card
(status, order ID, placed, amount, address) → ordered items → `Payment & bill`
(payment method, receiver, delivery partner **jab** provider de, line items **jab** provider
de, `Total paid`) → tracking + SMS truth.

Rule: jo field Swiggy nahi deta wo row banti hi nahi — "line-by-line bill nahi diya" likha
jata hai. Delivery partner/OTP kabhi invent nahi.

---

## 6. Incognito mode

Reference me toggle hai. **Yahan implement nahi kiya** — Swiggy ke andar ka feature hai,
hum usse chala nahi sakte, aur "history 3 ghante me delete" ka dawa jhooth hota
(DB/vault/backups me data rehta hai). Isliye UI me fake toggle nahi hai. (Guard:
`test_v50_no_fake_incognito_e2e.mjs`.)

---

## 7. Transient states (Rule 3G)

`searching` (skeleton rows), `finding coupons` (shimmer card), `updating bill` (spinner
pill + skeleton), `QR generate` (spinner + deadline line), `switching account` (busy + toast),
`OTP send` (button busy → `Sent`/error), `orders refresh` (skeleton), `processing` (load
bar). Har async ka end: success / error / retry — koi infinite spinner nahi.

---

## 8. Deviations (honest list)

| Cheez | Reference | Yahan | Kyun |
|---|---|---|---|
| Coupon code input | hai | nahi | boss rule #49 — list + APPLY only (galat code se "coupon nahi laga" ka shor) |
| Incognito toggle | hai | nahi | Swiggy ka andar ka feature; jhooth nahi bolte |
| Card / COD | chalta hai | fade + "Not available" | hum sirf UPI lete hain |
| Logo / brand font | Swiggy | apna (Sacha Beta + Manrope) | brand identity clone nahi karni (standing rule) |
| Restaurant image | photo | icon tile (jab image na aaye) | demo data me image nahi; asli data me `<img>` aata hai |
| Coupon sheet ka exact height | ~86% | 88dvh max | 390×844 par same feel, chhote phone par scroll |
| Swiggy ka exact 12px grid | ~4px grid | 4px grid | naap match, values tokenized |
