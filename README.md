# 👑 Ammi Abbu Ka Sacha Beta — Swiggy Live Order, Address & Cart Bot

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hulm0408/ammi-abbu-ka-sacha-beta)

Telegram bot built for seamless Swiggy food ordering with real-time **Saved Address Fetching**, **Shared/Group Cart Fetching**, **Exact Address-Bound Checkout Billing**, **Auto Coupon Engine**, and **Render Docker Cloud Deployment**.

## 🚀 1-Click Render Deployment

1. Click **[Deploy to Render](https://render.com/deploy?repo=https://github.com/hulm0408/ammi-abbu-ka-sacha-beta)** above *(or open **[Render Dashboard](https://dashboard.render.com/)** -> **New +** -> **Web Service** -> select **`hulm0408/ammi-abbu-ka-sacha-beta`**)*.
2. Enter your **`BOT_TOKEN`** (from `@BotFather`) — `BOSS_SECRET` (`boss123`) and `HEADLESS` (`true`) are already pre-configured.
3. Click **Apply / Deploy Web Service** — health check listens automatically on `0.0.0.0:$PORT` (`GET /` -> `200 OK`).

## 📍 Address intake rule (URL-first)

A Swiggy "Share address" message is the **only** source of delivery data:

* `https://swiggy.onelink.me/JgkQ/...` and `https://www.swiggy.com/ofo/address/...` are resolved through Swiggy's
  shared-address API — receiver name, phone, street, city and GPS all come from that response.
* Text pasted next to the link (order-account block, cart receipt, forwarded header, "Address: ..." line) is
  **never** parsed into the delivery address, so a forwarded bill can't hijack the recipient's number or area.
* If the link cannot be resolved, the bot asks for a fresh link/pin instead of guessing from chat text.
* A plain street address (or Telegram GPS pin) is still accepted when the message contains **no** address link.
* The delivery contact is always the receiver's number; the ordering Swiggy account's number is never substituted.
* **Only the URL is used.** Telegram keeps markdown, so a real paste often looks like
  `link:[https://swiggy.onelink.me/JgkQ/kubail4a](https://swiggy.onelink.me/JgkQ/kubail4a)` followed by
  `Address: …` and `It is a one time use link and will be valid for 24 hours.` All URL capture goes through
  `link-utils.js` (`extractSharedUrls` / `normalizeSharedUrl` / `stripSharedLinks`), so the markdown wrapper,
  the duplicated copy and every line of marketing text are dropped. The same applies to restaurant/group-cart
  links (`swig.gy/gc/...`), so a cart share message can never be read as an address and vice versa.

Order cards render as a compact receipt: `Order Account` → `Your Cart` → `Delivering To` → items →
`Bill Summary` → `To Pay`.

## 🧪 Tests

```bash
npm test          # 131-scenario behavioural audit suite
npm run test:guards  # URL-first address intake, receipt card, auto bill summary → QR → real tracking, /start smoke + static undefined-reference guard
```

`test:guards` fails if any bot source references an identifier that is never declared (the class of bug behind
`setUserMiniAppButton is not defined`).

## ⭐ Customer orders get the same auto-offer pipeline as forwarded ones

When a customer taps **Send to Beta** (or `Refresh status`), the bot now repeats the whole Boss-side pipeline
automatically, in the background:

1. resolve the live cart + delivery address,
2. scan every logged-in Swiggy account (`0-Order` first) for the best combination of coupon, free cash and
   free delivery,
3. lock that account + bill on the order (`cardStage: BILL_READY`, `autoOptimized: true`).

Nothing is charged or placed automatically. As soon as the max-discount bill is locked, the bot sends the
customer the **bill summary exactly once** (`billSummarySentAt` guard) with **✓ Approve bill** /
**! Something is wrong** buttons. Tapping *Approve* sends the official Swiggy payment QR/link straight to the
customer (no Boss step in between), consumes one slot and records `billApprovedByUser`.

After payment is verified the customer receives the **real Swiggy tracking link** that Swiggy itself returned.
The bot never substitutes its own `/track/<orderId>` page: if Swiggy has not published a link yet, the message
says so (with a plain `swiggy.com/orders` shortcut) and the tracking poller pushes the exact link later.

If no free account is available the order simply stays pending and the reason is shown on the Boss card
(`Auto offers: …`), so Boss can retry with **★ Auto Max Coupon**. Boss's *Send Bill Summary* button is now a
manual **resend** of that same summary — it can never bill the customer twice.
