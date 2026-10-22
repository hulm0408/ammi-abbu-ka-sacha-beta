const H = require('./helpers');
const { B, C, BI, IT, LN, M, MB, q, hr, rows, map, qr, img, kb, ok, dgr, gold, url, pri, botHeader, inMsg, outMsg, G, R, Y, BL, DIM, OR, ORDER, ORDER2, billRows } = H;
const HD = botHeader();
const qt = (title, text, o = {}) => ({ t: 'q', title, text, ...o });

module.exports = [
  {
    file: '25-otp-wrong-attempt.png',
    label: 'Wrong OTP → alert + resend timer',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: '004471', placeholder: 'Enter 6-digit OTP...' },
      fromTop: true,
      messages: [
        outMsg([MB('004471')], { time: '11:28 PM' }),
        inMsg(
          [
            qt('× OTP Verify Failed', [
              C('☎ '), B('Number: '), MB('9000012345', BL), C('\n'),
              B('Swiggy Response:'), C('\n'), IT('Invalid OTP. Please re-check the code sent to your mobile.', DIM), C('\n'),
              B('Attempt'), C(' '), MB('2/3', R), C('  ·  '), B('Resend in'), C(' '), MB('48s', Y),
            ]),
            [IT('Sahi 6-digit OTP dubara type karein ya neeche Re-enter OTP dabayein.', DIM)],
          ],
          { time: '11:28 PM', keyboard: kb([pri('↻ Re-enter OTP'), gold('✉ Resend New OTP (48s)')], [dgr('× Cancel OTP Login'), pri('▤ Paste Session JSON')]) }
        ),
      ],
      toast: { text: '✕ OTP galat tha — 1 attempt bacha', y: 130 },
    },
  },
  {
    file: '26-otp-error-security.png',
    label: 'OTP request failed — security challenge / rate limit',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('× OTP Request Failed', [
              C('☎ '), B('Number: '), MB('9000012345', BL), C('\n'),
              B('Swiggy Response:'), C('\n'), IT('HTTP 429 · We are seeing unusual activity from this device.', DIM), C('\n'),
              C('⌕ '), IT('Diagnostic: SWIGGY_RATE_LIMIT · retry_after 900s', DIM),
            ]),
            [IT('Security checks aur request limits Swiggy control karta hai — yeh bot unhe bypass nahi karega.', R)],
            [C('Is account ka valid session export hai to '), B('JSON import'), C(' use karo.')],
          ],
          { time: '11:29 PM', keyboard: kb([url('Open official Swiggy')], [pri('Paste Session JSON'), pri('Main Menu')]) }
        ),
      ],
      popup: {
        title: 'Rate limited',
        body: [[C('15 min baad try karo, warna number flag ho jayega.')], [IT('Auto-retry OFF rakha gaya hai.', DIM)]],
        buttons: [[{ t: 'Thik hai' }]],
        y: 470,
      },
    },
  },
  {
    file: '27-json-import-preview.png',
    label: 'Session JSON paste → parsed preview (tid/deviceId/sid)',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        outMsg([IT('{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", "sid": "7389288829104", "deviceId": "2f1e88a5-dac5-7b62", "savedAt": "2026-10-22T08:34:28.812Z" }', DIM)], { time: '11:30 PM' }),
        inMsg(
          [
            qt('✓ Session JSON parsed', [
              B('Phone'), C('     '), MB('9000012345', BL), C('\n'),
              B('Customer'), C('  '), B('Rahul Kumar'), C('  ·  '), MB('ID 286684769', DIM), C('\n'),
              B('Token'), C('     '), BI('valid · 2.4 MB', G), C('  ·  '), IT('jwt not expired', G), C('\n'),
              B('Device'), C('     '), IT('2f1e88a5-dac5-7b62-eaad-4136e062bfd7', DIM),
            ]),
            [C('OTP skip karke seedha account vault me add kar raha hoon...')],
          ],
          { time: '11:30 PM', keyboard: kb([ok('✓ Import & Login'), dgr('× Reject File')]) }
        ),
        inMsg(
          [
            qt('▤ Paste Session JSON here', [
              IT('File bhi bhej sakte ho (.json, max 1 file) — bot auto-detect kar lega.', DIM),
              C('Ek message me '), B('multiple JSON'), C(' objects bhi chalege (bulk import).'),
            ]),
          ],
          { time: '11:30 PM', keyboard: kb([pri('📎 Upload File'), pri('↻ Re-paste')]) }
        ),
      ],
    },
  },
  {
    file: '28-login-success-offers.png',
    label: 'Login success + auto offer claim (Swiggy-style session card)',
    spec: {
      mode: 'dark',
      header: botHeader({ title: 'Swiggy World Bot', avatarEmoji: '🤖', avatarBg: '#e0574a' }),
      fromTop: true,
      messages: [
        inMsg(
          [
            [BI('🎉 LOGIN COMPLETE — SWIGGY CLAIMING SUCCESS', G)],
            qt('Rahul Kumar', [
              C('☎ '), MB('9000012345', BL), C('  ·  '), B('#'), C(' Customer ID: '), MB('286684769', DIM), C('\n'),
              B('▣ OFFERS STATUS:'), C('\n'),
              C('• ◷ '), B('Swiggy Late-Night: '), BI('✓ CLAIMED', G), C(' (50 off on 199)'), C('\n'),
              C('• ◷ '), B('Swiggy Breakfast: '), BI('✓ CLAIMED', G), C(' (50 off on 199)'),
            ]),
            { t: 'pre', text: '{\n  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6Ik...",\n  "sid": "738928882910400001",\n  "deviceId": "2f1e88a5-dac5-7b62-eaad-4136e062bfd7",\n  "savedAt": "2026-10-22T20:05:34.812Z"\n}', size: 10.2 },
            [IT('Account DB me save ho gaya — Copy Code se 100% full code copy karo.', DIM)],
          ],
          {
            time: '2:05 PM',
            keyboard: kb([pri('Copy Code'), pri('Copy Number')], [ok('▣ Claim ₹50 Offers'), ok('₹ Claim Free Cash')], [pri('Export JSON File'), pri('Previous Orders')], [ok('Order with this Account'), dgr('↗ Logout Account')], [pri('Add Another Account'), dgr('Delete Account from Swiggy')], [pri('Main Menu'), dgr('Close')]),
          }
        ),
      ],
      toast: { text: '✓ Dono offers claim ho gaye', y: 118 },
    },
  },
  {
    file: '29-claim-partial-fail.png',
    label: 'Claim ₹50 offers → partial failure with retry',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        outMsg([B('▣ Claim ₹50 Off Offers (All Active)')], { time: '11:31 PM' }),
        inMsg(
          [
            qt('! LOGIN COMPLETE — CLAIM PARTIAL', [
              C('• ◷ '), B('Swiggy Late-Night: '), BI('× CLAIM FAILED', R), C(' (offer already claimed)'), C('\n'),
              C('• ◷ '), B('Swiggy Breakfast: '), BI('✓ CLAIMED', G), C(' (50 off on 199)'),
            ]),
            qt('Per account', [
              B('Ego tio'), C('  '), MB('8873415879', DIM), C('  '), BI('✓', G), C('\n'),
              B('Ego fari'), C('  '), MB('12121145', DIM), C('  '), BI('✓', G), C('\n'),
              B('Panu one'), C('  '), MB('8127861271', DIM), C('  '), BI('× already claimed', R), C('\n'),
              B('Panu fab'), C('  '), MB('7488934840', DIM), C('  '), BI('✓', G),
            ]),
            [IT('4 accounts scanned · 11.2s · Swiggy ne 3 offers naye diye.', DIM)],
          ],
          { time: '11:32 PM', keyboard: kb([ok('▣ Retry Panu one'), pri('₹ Claim Free Cash')], [pri('◉ Family Accounts'), dgr('× Close')]) }
        ),
      ],
    },
  },
  {
    file: '30-family-accounts.png',
    label: 'Connected accounts list with statuses',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('My Swiggy Accounts', [
              B('Ego tio'), C(' '), MB('8873415879', DIM), C(' '), BI('Saved', BL), C('\n'),
              B('Ego fari'), C(' '), MB('12121145', DIM), C(' '), BI('Saved', BL), C('\n'),
              B('Ego nino'), C(' '), MB('9348016319', DIM), C(' '), BI('Not Logged In', R), C('\n'),
              B('Panu fab'), C(' '), MB('7488934840', DIM), C(' '), BI('Saved', BL), C('\n'),
              B('Rahul Kumar'), C(' '), MB('7058813196', DIM), C(' '), BI('[Active] Order Hub', G),
            ]),
            [IT('Active account se hi naye order place honge. Cart same rahega — account badalne se order nahi bigdega.', DIM)],
          ],
          {
            time: '11:33 PM',
            keyboard: kb([ok('[Active] Rahul Kumar (7058813196)')], [pri('Ego tio (8873415879) - Saved'), pri('Ego fari (12121145) - Saved')], [dgr('Ego nino (9348016319) - Not Logged In'), pri('Panu fab (7488934840) - Saved')], [pri('Add New Account'), pri('Refresh Accounts')], [pri('Main Menu')]),
          }
        ),
      ],
    },
  },
  {
    file: '31-switch-active-account.png',
    label: 'Order account switched → both chats informed',
    spec: {
      mode: 'dark',
      header: botHeader({ title: 'Swiggy World Bot', avatarEmoji: '🤖', avatarBg: '#e0574a' }),
      fromTop: true,
      messages: [
        outMsg([B('◉ Family Accounts')], { time: '2:40 PM' }),
        inMsg(
          [
            [BI('✓ Order Account Switched', G)],
            q([C('📱 '), B('Rahul Kumar'), C('\n'), MB('7058813196', BL)]),
            [C('🛒 Cart same rahega — ab isi account se order hoga.')],
          ],
          { time: '2:40 PM', keyboard: kb([ok('🧑‍🍳 Order Hub ready')], [pri('⌖ Saved Addresses'), pri('🧾 Previous Orders')]) }
        ),
        inMsg(
          [
            qt('🔔 Customer ko bheja gaya', [
              IT('Rahul Kumar ko message gaya: "Order Hub ready — orders will now be placed from this account."', DIM),
              C('Cart id: '), MB('502858420', DIM), C('  ·  '), B('Restaurant: '), C('217019', DIM),
            ]),
          ],
          { time: '2:40 PM', keyboard: kb([pri('↩ Purana Account Wapas'), dgr('× Close')]) }
        ),
      ],
    },
  },
  {
    file: '32-boss-dashboard.png',
    label: 'Dashboard — order id, phone, tracking per order',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('📊 Dashboard — Order ID · Tracking · Phone', [
              B('Swiggy IDs: '), C('6 logged in · 1 need login', DIM), C('\n'),
              B('Orders: '), C('14 · Pending 1 · In progress 2 · Done 11', DIM), C('\n'),
              B('Tracking: '), BI('10 live', G), C(' · '), BI('1 auto-fetching', Y),
            ]),
            qt('Recent orders', [
              B('1. Swiggy #8301745529'), C('\n'),
              C('▪ '), B('Order ref: '), MB('#4821', DIM), C('\n'),
              C('▪ '), B('Placed from: '), MB('7058813196', BL), C('\n'),
              C('▪ '), B('Customer: '), C('Rahul Kumar · ₹534', DIM), C('\n'),
              C('▪ '), B('Status: '), MB('OUT_FOR_DELIVERY', Y), C('\n'),
              C('▪ '), B('Tracking: '), LN('Open live tracking'),
              C('\n\n'),
              B('2. Swiggy #8301699014'), C('\n'),
              C('▪ '), B('Order ref: '), MB('#4817', DIM), C('\n'),
              C('▪ '), B('Placed from: '), MB('7488934840', BL), C('\n'),
              C('▪ '), B('Status: '), MB('DELIVERED', G), C(' · '), B('Tracking: '), LN('Open order tracking'),
              C('\n\n'),
              B('3. Ref #4809'), C('\n'),
              C('▪ '), B('Swiggy order: '), IT('not created yet', DIM), C('\n'),
              C('▪ '), B('Placed from: '), IT('account not selected', R), C('\n'),
              C('▪ '), B('Tracking: '), IT('⏳ Waiting for Swiggy share link — auto-fetching', Y),
            ]),
          ],
          { time: '11:35 PM', keyboard: kb([url('🔗 Track #745529')], [url('🔗 Track #699014')], [pri('🔄 Fetch tracking #4809')], [ok('⚡ Fetch all missing tracking')], [pri('↻ Refresh Dashboard'), pri('★ Boss Panel')]) }
        ),
      ],
    },
  },
  {
    file: '33-pending-order-card.png',
    label: 'Boss pending order card — account pick + accept/reject',
    spec: {
      mode: 'dark',
      header: HD,
      pin: '★ 1 pending request — Reply fast, customer wait kar raha hai',
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('[ ORDER #4821 ] · '), BI('Pending', Y)]),
            qt('Ordered By', [
              B('Name: '), LN('Rahul Kumar'), C('\n'),
              B('User ID: '), MB('8 447 120 338', DIM),
            ]),
            qt('Cart & Delivery', [
              B('Cart: '), LN('Open cart link'), C('\n'),
              B('Deliver to: '), C('Al Noor Informations, Hazratganj, Lucknow - 226007', DIM), C('\n'),
              B('Time: '), C('11:36 PM', DIM), C('\n'),
              B('Auto offers: '), BI('✓ Best account + max coupon locked (7058813196)', G),
            ]),
            qt('Final Bill', [
              B('Items Total'), C('  ₹608', DIM), C('\n'),
              BI('FESTIVE150'), C('  −₹150  ·  '), B('Free Cash'), C(' −₹50', DIM), C('\n'),
              BI('FREE DEL', G), C(' (₹45 saved)  ·  '), B('One Lite'), C(' +₹19', DIM), C('\n'),
              B('Final Total '), B('₹534', Y),
            ]),
            [IT('Status: bill sent to customer — awaiting payment confirmation', DIM)],
          ],
          {
            time: '11:36 PM',
            keyboard: kb([gold('★ Auto Max Coupon (Best Acc)'), pri('⚙ Auto-Pick Account')], [ok('☎ Active Acc: 7058813196 ✓'), pri('↻ Switch Acc')], [ok('✓ Accept Order'), dgr('× Reject Order')], [pri('▤ Copy Cart'), pri('▤ Copy Address')], [pri('⌖ Select Account Address'), pri('✉ Message User')], [pri('← Back to Order Screen')]),
          }
        ),
      ],
    },
  },
  {
    file: '34-auto-coupon-scan.png',
    label: 'Auto Max Coupon (Best Account) — live scan',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        outMsg([B('★ Auto Max Coupon (Best Acc)')], { time: '11:37 PM' }),
        inMsg(
          [
            qt('◷ Scanning 6 accounts — Order #4821', [
              C('1. '), B('Ego tio'), C('   '), MB('8873415879', DIM), C('  '), C('open ₹608', DIM), C('  '), IT('no coupon', DIM), C('\n'),
              C('2. '), B('Ego fari'), C('   '), MB('12121145', DIM), C('  '), C('open ₹608', DIM), C('  '), BI('−₹100', Y), C('\n'),
              C('3. '), B('Panu one'), C(' '), MB('8127861271', DIM), C('  '), C('open ₹608', DIM), C('  '), BI('−₹149', Y), C('\n'),
              C('4. '), B('Panu fab'), C(' '), MB('7488934840', DIM), C('  '), C('open ₹608', DIM), C('  '), BI('−₹174', G), C('\n'),
              C('5. '), B('Rahul Kumar'), C(' '), MB('7058813196', DIM), C('  '), C('open ₹608', DIM), C('  '), BI('−₹284 + FREE DEL ✓', G),
            ]),
            [IT('Free cash + event offers + free delivery sab compare ho rahe hain (0-Order first).', DIM)],
          ],
          { time: '11:37 PM', keyboard: kb([pri('◷ Refresh Scan'), dgr('⏸ Stop')], [ok('✓ Lock This Bill')]) }
        ),
        inMsg(
          [
            qt('✓ Max discount locked', [
              B('Account: '), MB('7058813196', BL), C('  ·  '), B('Coupon: '), BI('FESTIVE150', G), C('\n'),
              B('Free Cash: '), C('−₹50', DIM), C('  ·  '), B('Delivery: '), BI('FREE', G), C('\n'),
              B('Payable: '), B('₹534', Y), C('  ·  '), B('Saved: '), BI('₹284', G),
            ]),
            [C('Customer ko bill summary bhej diya gaya (ek hi baar) — ab wo approve karega.')],
          ],
          { time: '11:38 PM', keyboard: kb([ok('› Send Bill & Payment QR to Customer'), pri('↻ Resend Bill Summary')]) }
        ),
      ],
    },
  },
  {
    file: '35-export-logout-picker.png',
    label: 'Export & Logout (1+ Orders) — checklist with toggles',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('⇧ Export & Logout (1+ Orders)', [
              B('47 orders'), C(' in'), C(' '), B('6'), C(' accounts · '), IT('last 30 days', DIM), C('\n'),
              C('✓ = JSON file bhi banega, logout bhi'), C('\n'),
              C('[x] '), B('Ego tio'), C(' '), MB('8873415879', DIM), C(' · '), B('12'), C(' orders  '), BI('✓', G), C('\n'),
              C('[ ] '), B('Ego fari'), C(' '), MB('12121145', DIM), C(' · '), B('9'), C(' orders  '), IT('skip', DIM), C('\n'),
              C('[x] '), B('Panu one'), C(' '), MB('8127861271', DIM), C(' · '), B('8'), C(' orders  '), BI('✓', G), C('\n'),
              C('[x] '), B('Panu fab'), C(' '), MB('7488934840', DIM), C(' · '), B('11'), C(' orders  '), BI('✓', G), C('\n'),
              C('[x] '), B('Rahul Kumar'), C(' '), MB('7058813196', DIM), C(' · '), B('7'), C(' orders  '), BI('✓', G),
            ]),
            [IT('Rahul Kumar active Order Hub hai — logout se pehle cart transfer ka option milega.', Y)],
          ],
          { time: '11:40 PM', keyboard: kb([pri('Select All'), pri('Deselect All')], [ok('⇧ Export 4 JSON Files'), dgr('↗ Logout Selected Accounts')], [dgr('! LOGOUT ALL ACCOUNTS'), pri('× Cancel')]) }
        ),
      ],
    },
  },
  {
    file: '36-swiggy-delete-otp.png',
    label: 'Delete account from Swiggy — 2-step danger with OTP',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('⚠ Delete Account from Swiggy', [
              B('Account: '), MB('9348016319', R), C('  ·  '), B('Ego nino'), C('\n'),
              B('Orders placed: '), C('0'), C('  ·  '), B('Wallet: '), C('₹0.00', DIM), C('\n'),
              IT('Yeh Swiggy ka official account-delete OTP hai — 30 min me expire.', R),
            ]),
            [C('Swiggy par jo account delete hoga, uska session yahan se bhi hat jayega.')],
          ],
          { time: '11:41 PM', keyboard: kb([dgr('★ Send Delete OTP to Swiggy')], [pri('Resend Delete OTP'), pri('× Remove from Bot Only')], [pri('◉ Back to Accounts')]) }
        ),
      ],
      popup: {
        title: 'Pakka delete karna hai?',
        body: [[C('Ego nino (9348016319) ka '), B('session, saved addresses aur 0 orders'), C(' sab hat jayenge.')], [IT('Undo possible nahi hai.', R)]],
        buttons: [[{ t: 'Cancel' }, { t: 'Delete Forever', style: 'danger', hover: true }]],
        y: 452,
      },
    },
  },
];
