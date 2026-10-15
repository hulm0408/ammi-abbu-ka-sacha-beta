# 🤖 Telegram Slot & Order Management Bot

Built exactly according to your FigJam design specifications!

---

## 🌟 Features Implemented

### 1. 👤 User Screen (`/start`)
- **Live Dynamic Banner:** Shows current `Slots Left: X/Y` (e.g. `Slots Left: 3/9`).
- **🟣 Address Button:**
  - When tapped, prompts the user to paste address or map link.
  - Updates immediately to `🟣 Address: Added ✅`.
- **🔴 Cart Button:**
  - When tapped, prompts the user to paste the cart link.
  - Updates immediately to `🔴 Cart: Added ✅`.
- **Strict Verification:**
  - If a user attaches only one item, **nothing is sent to the Boss**.
  - As soon as **both** items are attached, the **`🚀 Send to Boss`** button appears!
- **Waiting State:**
  - Once submitted, the user sees `⏳ Status: Waiting for Boss` until their order is processed.

---

### 2. 👑 Boss Screen (`/boss`)
- **New Order Card Notification:**
  - Appears automatically when a user submits both items.
  - Shows **Name of user**, `@username`, **Address link**, and **Cart link**.
  - **`📋 Copy Address`** & **`📋 Copy Cart`** buttons for 1-tap copying.
  - **`👤 Text User`** direct link to open user chat.
- **`🟢 Accept the order` Action:**
  - If slots left > 0:
    - Decrements remaining slots by 1.
    - User receives notification: *"🎉 Your order has been accepted!"*
    - Boss sees: *"✅ Order Accepted! Slots remaining: X/Y"*.
  - If slots left == 0:
    - Boss sees alert: *"⚠️ Sorry, slot has ended!"*
- **`💳 Send QR for payment` Action:**
  - Boss clicks the button $\rightarrow$ Boss directly uploads or attaches the QR code image.
  - The bot immediately delivers the QR image to the user's chat!
- **Slot Counters Control:**
  - **`🔢 Set Total Slots`**: Boss can enter a new number for total slots.
  - **`📉 Set Total Left`**: Boss can set or adjust available slots left.

---

## 🚀 How to Run

1. Open PowerShell or Terminal in this directory:
   ```bash
   cd C:\Users\HP\.gemini\antigravity-ide\scratch\telegram-slot-bot
   ```

2. Start the bot:
   ```bash
   npm start
   ```

3. Open Telegram and find your bot:
   - As a **User**: Send `/start`
   - As the **Boss**: Send `/boss` or `/boss boss123` to claim the Boss role!
