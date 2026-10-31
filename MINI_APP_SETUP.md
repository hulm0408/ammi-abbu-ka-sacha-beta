# Optional Telegram Mini App (work in progress)

The existing Telegram chat flow remains available. `/pro` and the Telegram menu button open a separate mobile Mini App once a public HTTPS URL is configured. A normal browser can preview the UI, but the APIs require a signed, fresh Telegram Mini App session. The bot never asks users to send an OTP, token, or session JSON in chat.

## Deployment

1. Serve the existing bot as a **web service** with an HTTPS public domain and a `PORT` assigned by the host. The app is served by the same process at `/pro`.
2. Set `PRO_MINIAPP_URL` to the full HTTPS URL, e.g. `https://your-domain.example/pro`. Do not use localhost. If it is absent, the bot keeps the normal commands menu and `/pro` explains that the app is not configured.
3. Set a strong random `PRO_VAULT_KEY` (at least 16 characters) in the deployment's secret manager. `VAULT_ENCRYPTION_KEY` is used only if `PRO_VAULT_KEY` is not set. Keep the key stable and backed up securely; changing or losing it makes existing Mini App workspaces unreadable. Never commit it or share it in chat.
4. Set `DATA_DIR` to a private, persistent disk. Mini App workspaces are AES-256-GCM encrypted under `DATA_DIR/pro-workspaces`, separately per Telegram user. These workspaces are **not** included in the bot's existing shared-account cloud vault; arrange an encrypted backup of the persistent directory and key. A host with ephemeral storage will lose this data on redeploy. Run one service replica: the workspace and account locks are in-process, not distributed across multiple instances.
5. Restart the service. `/pro` and the default Telegram menu button become available. Telegram requires the configured HTTPS origin to be reachable from the user's device.

Only Telegram-verified boss IDs can see or modify the existing shared boss vault. Other users' sessions and selections are isolated in their own encrypted workspaces. The Mini App enforces the same service-pause and required-channel checks as the existing chat bot for non-boss users; if the channel check fails, open the bot and follow its join instructions. OTP login creates a **server-side session**, not a login on the user's Swiggy phone app. A login OTP is requested from Swiggy; the Mini App does not send the recipient an order SMS.

## Implemented surface, not live-verified

* OTP login (existing registered accounts) and single-session JSON import. JSON is saved only after Swiggy verifies the session; login does not automatically create an account or claim offers.
* Saved-address selection and share-link resolution. Receiver name/mobile are filled only when returned by Swiggy and can be confirmed or corrected. No account-number substitution is made.
* Restaurant search, menu browsing, a local draft cart and group-cart import, subject to Swiggy's response. Customizable menu dishes cannot yet be added directly.
* Explicit cart sync and a provider-returned bill, with a warning that syncing **replaces the existing cart on the selected Swiggy account** and may save the selected address there. The API checks item quantities, variants/add-ons, and address ID before showing a bill. A bill is not an order; it expires after five minutes on reopening the app. Sending OFO fields is not proof that Swiggy accepted an OFO order.
* Basic account order history and links to the official offer pages. Offer eligibility is not claimed or verified by the Mini App.

**Not implemented:** in-app order placement, UPI/QR/card/COD checkout, live tracking/OTP details, manual map pinning, automatic best-account/offer selection, and offer claiming. The payment section explicitly directs the user to review the synced cart in Swiggy. No QR, paid state, order confirmation, or recipient SMS is fabricated. In particular, real OFO placement, the receiver's contact, and whether Swiggy sends its own SMS require an authorized real-device order check.

## Tests and live verification

```bash
npm ci --ignore-scripts
npm run test:pro
```

These are **offline tests with a fake Swiggy provider**. They exercise Telegram signature validation, workspace isolation/encryption, consent to cart replacement, rejection of changed cart customizations, and honest unavailable checkout. They cannot establish that Swiggy currently accepts the requests, places an order, or sends an SMS. The sandbox cannot reach Swiggy, so no live login, live cart, payment, placement, delivery, or notification was verified here. Test on the deployed service using the owner's own account and explicit consent; do not post credentials or OTPs in chat. Do not place a real order without permission.
