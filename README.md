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

Order cards render as a compact receipt: `Order Account` → `Your Cart` → `Delivering To` → items →
`Bill Summary` → `To Pay`.

## 🧪 Tests

```bash
npm test          # 131-scenario behavioural audit suite
npm run test:guards  # URL-first address intake, receipt card, /start smoke + static undefined-reference guard
```

`test:guards` fails if any bot source references an identifier that is never declared (the class of bug behind
`setUserMiniAppButton is not defined`).
