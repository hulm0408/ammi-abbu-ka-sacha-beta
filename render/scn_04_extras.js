const H = require('./helpers');
const { B, C, BI, IT, LN, M, MB, q, hr, rows, map, qr, img, kb, ok, dgr, gold, url, pri, botHeader, inMsg, outMsg, G, R, Y, BL, DIM, OR, ORDER, ORDER2, billRows } = H;
const HD = botHeader();
const qt = (title, text, o = {}) => ({ t: 'q', title, text, ...o });

module.exports = [
  {
    file: '37-otp-sms-phone.png',
    label: 'Phone home: Swiggy SMS OTP banner over Telegram chat',
    spec: {
      mode: 'dark',
      header: botHeader({ time: '11:26', title: 'ORDER PLACER' }),
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('◈ Swiggy Login OTP', [
              C('☎ '), B('Number: '), MB('9000012345', BL), C('\n'),
              B('OTP sent'), C(' '), IT('11:26:41 PM', DIM), C('  ·  '), B('Attempts '), MB('1/3', Y),
            ]),
            [IT('SMS aapke phone par aayega — bot usse auto-read nahi karta. 6 digits yahin bhejo.', DIM)],
          ],
          { time: '11:26 PM', keyboard: kb([ok('✉ Resend OTP'), pri('Copy Number')], [pri('↻ Re-enter OTP'), dgr('× Cancel')]) }
        ),
      ],
      banner: {
        title: 'Messages · Swiggy', icon: '🛵', time: 'now', h: 86,
        body: [[B('SWIGGY'), C('  11:26 PM'), C('\n'), C('Your Swiggy verification code is '), B('447192'), C('. Valid for 10 minutes. Do not share this code.')]],
      },
    },
  },
  {
    file: '38-order-placed-sms.png',
    label: 'Parent ke phone par order-placed SMS',
    spec: {
      mode: 'light',
      header: botHeader({ time: '11:53' }),
      hideInput: true,
      smsThread: {
        title: '98765 43210',
        sub: 'SMS · Messages',
        avatarBg: '#2f9e6f',
        avatarText: 'AB',
        date: 'Today',
        bubbles: [
          {
            body: [
              C('🔔 Swiggy Order Placed!'), B('\nHi Ammi Bi, aapka order #8301745529 (Biryani by Nasir, 3 items) place hua hai.'),
              B('\nAmount: ₹534'),
              C('\nTrack: https://r.swiggy.com/s/8301745529'),
              C('\nSupport: https://t.me/Its_life_001'),
            ],
            time: '11:52 PM',
          },
          { body: [C('Beta ne aapke liye Swiggy order place kiya hai. Order ID: 8301745529 for you on Swiggy. Track: https://r.swiggy.com/s/8301745529 - Reply STOP to opt out')], time: '11:52 PM' },
        ],
      },
    },
  },
  {
    file: '39-payment-sms.png',
    label: 'Payment-required SMS (short link + amount)',
    spec: {
      mode: 'dark',
      header: botHeader({ time: '11:15' }),
      hideInput: true,
      smsThread: {
        title: '90000 12345',
        sub: 'SMS · Messages',
        avatarBg: '#7a5cff',
        avatarText: '₹',
        date: 'Today',
        bubbles: [
          {
            body: [
              B('💳 Payment Required — Swiggy Order #8301745529'),
              C('\nAmount: ₹534'),
              C('\nPay Now: '), LN('swiggy.com/payments/8f2a91'),
              C('\nTrack: available after payment'),
              IT('\n- Swiggy Bot', DIM),
            ],
            time: '11:14 PM',
          },
          { body: [C('Order ka bill approve ho gaya. QR/link isi number par bheja gaya hai.')], time: '11:14 PM' },
        ],
      },
    },
  },
  {
    file: '40-otp-autofill.png',
    label: 'OTP autofill chips above keyboard',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: '', placeholder: 'Enter 6-digit OTP...' },
      keyboard: { label: 'SUGGESTIONS', chips: ['447192 · Swiggy', 'Copy', 'Paste'] },
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('☎ OTP Sent', [
              C('☎ '), B('Number: '), MB('9000012345', BL), C('\n'),
              B('Send to: '), C('Swiggy verify API', DIM), C('  ·  '), B('Resend'), C(' '), MB('59s', Y),
            ]),
            [IT('Chip tap karo — OTP field me chala jayega. Bot sirf 6 digit accept karta hai.', DIM)],
          ],
          { time: '11:27 PM', keyboard: kb([ok('✓ Auto-Verify'), pri('Paste Manually')]) }
        ),
      ],
    },
  },
  {
    file: '41-payment-sheet-mock.png',
    label: 'Customer ka screen: QR payment sheet (personalised UPI QR)',
    spec: {
      mode: 'dark',
      header: botHeader({ time: '11:13' }),
      hideInput: true,
      messages: [
        inMsg([[B('● Official Swiggy Payment QR (Order #4821)'), C('\n'), B('Payable on Swiggy: '), B('₹534', Y)]], { time: '11:12 PM' }),
      ],
      popup: {
        title: 'Pay ₹534 to Swiggy',
        width: 330,
        y: 178,
        body: [
          { t: 'qr', qrText: ORDER.upi, size: 210 },
          [MB('9000012345@ybl', G)],
          [IT('PhonePe · GPay · Paytm · BHIM se scan karo. Amount Swiggy ke hisab se hi katega.', DIM)],
        ],
        buttons: [[{ t: 'Copy UPI ID' }, { t: 'Done, Paid ✓', style: 'success', hover: true }]],
      },
    },
  },
  {
    file: '42-swiggy-app-otp.png',
    label: 'Swiggy app screen jaisa: rider aaya, delivery OTP',
    spec: {
      mode: 'dark',
      header: botHeader({ time: '10:58', title: 'ORDER PLACER' }),
      fromTop: true,
      messages: [
        inMsg(
          [
            q([BI('Rider is at your door', Y), C('  ·  '), IT('Order #4821', DIM)]),
            q([B('Delivery OTP'), C('\n'), MB(ORDER.otp, Y)]),
            map({ h: 120, label: 'Imran Ansari · 120 m away' }),
            [C('Ammi Bi ko call karne wala hai: '), MB('98765 43210', BL)],
          ],
          { time: '10:58 PM', keyboard: kb([gold('📋 Copy OTP 6214'), pri('💳 Pay Instantly', { url: true })], [url('🔗 Open Tracking')]) }
        ),
      ],
    },
  },
  {
    file: '43-wallet-and-refer.png',
    label: 'Wallet and refer — free cash + referral progress',
    spec: {
      mode: 'dark',
      header: botHeader({ title: 'Swiggy World Bot', avatarEmoji: '🤖', avatarBg: '#e0574a' }),
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('▣ SWIGGY FREE CASH & EVENT OFFERS (15-DAY AUTO-LOCK)', [
              B('Instamart Free Cash'), C('  '), BI('₹50–₹60', G), C('\n'),
              C('• '), BI('CLAIMED', G), C(': naya Free Cash add ho gaya'), C('\n'),
              C('• '), BI('ALREADY CLAIMED', Y), C(': is account pe pehle se hai'), C('\n'),
              C('• '), BI('NOT ELIGIBLE', R), C(': promo is account ke liye valid nahi'),
            ]),
            qt('Per account status', [
              B('Ego tio'), C('   '), MB('8873415879', DIM), C(' '), BI('✓ CLAIMED ₹60', G), C('\n'),
              B('Ego fari'), C('   '), MB('12121145', DIM), C(' '), BI('ALREADY CLAIMED', Y), C('\n'),
              B('Panu one'), C(' '), MB('8127861271', DIM), C(' '), BI('NOT ELIGIBLE', R), C('\n'),
              B('Panu fab'), C(' '), MB('7488934840', DIM), C(' '), BI('✓ CLAIMED ₹50', G),
            ]),
            [IT('Auto-lock: claim ke baad 15 din tak dobara claim nahi hoga — waste call nahi.', DIM)],
          ],
          { time: '11:44 PM', keyboard: kb([ok('▣ Claim For All Active')], [pri('▤ Paste / Upload Session JSON')], [pri('← Back to Main Panel')]) }
        ),
      ],
    },
  },
  {
    file: '44-cancelled-list.png',
    label: 'Cancelled / rejected orders list (honest empty state)',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            qt('× Cancelled Orders List', [
              B('Showing'), C(' 2 of 2', DIM), C('\n'),
              B('1. #4809'), C(' '), IT('rejected by Boss', R), C(' · '), C('₹0 · slot released', DIM), C('\n'),
              B('   Reason: '), IT('Cart link expired — customer se fresh link manga gaya', DIM), C('\n'),
              B('2. #4795'), C(' '), IT('cancelled by customer', Y), C(' · '), C('₹174 · refund initiated', DIM), C('\n'),
              B('   Refund: '), C('Swiggy 3-5 working days', DIM),
            ]),
            [IT('Koi bhi order auto-cancel nahi hota — hamesha pehle Boss se confirm hota hai.', DIM)],
          ],
          { time: '11:46 PM', keyboard: kb([pri('↻ Refresh List'), pri('📦 Orders Done')], [dgr('× Close')]) }
        ),
      ],
    },
  },
  {
    file: '45-rejected-bill.png',
    label: 'Bill galat laga → customer ne "! Something is wrong" dabaya',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        outMsg([B('! Something is wrong')], { time: '11:47 PM' }),
        inMsg(
          [
            qt('! Bill issue received', [
              C('Tumhara order '), B('#4821'), C(' '), BI('REJECTED', R), C(' me move ho gaya.'),
            ]),
            q([B('Ab kya hoga'), C('\n'), IT('Beta bill dobara check karega — sahi coupon/free delivery laga ke naya summary aayega. Pehle wala QR cancel maan liya jayega.', DIM)]),
            [C('Support: '), LN('@Its_life_001')],
          ],
          { time: '11:47 PM', keyboard: kb([pri('↻ Recompute Max Coupon'), ok('▤ Naya Cart Link Bhejo')], [dgr('× Cancel order')]) }
        ),
      ],
    },
  },
  {
    file: '46-final-card-light.png',
    label: 'Same order card — Telegram LIGHT theme',
    spec: {
      mode: 'light',
      header: botHeader({ time: '11:50', avatarBg: '#ff9f0a' }),
      pin: '★ MAX COUPON WINNER ACCOUNT LOCKED! (Order #4821)',
      fromTop: true,
      messages: [
        inMsg(
          [
            q([BI('✓ Order #4821 — Confirmed', '#1d8f3c'), C('  ·  '), B('Biryani by Nasir', { color: '#20303d' })]),
            qt('Order Status', [
              B('Out for delivery', { color: '#b26a00' }), C('  ·  ETA 6 min\n'),
              B('Tracking: '), LN('r.swiggy.com/s/8301745529', { color: '#1c6fae' }), C('\n'),
              B('Delivery OTP: '), MB(ORDER.otp, '#1d8f3c'),
            ]),
            qt('Delivering To', [
              B(ORDER.addrName), C(' · '), MB(ORDER.addrPhone, '#1c6fae'), C('\n'),
              IT(ORDER.addr, '#5b6b7a'),
            ]),
            qt('Bill', [
              B('Items ₹608'), C('  ·  '), B('FESTIVE150 −₹150', { color: '#1d8f3c' }), C('\n'),
              B('Free Cash −₹50', { color: '#1d8f3c' }), C('  ·  '), B('Delivery FREE', { color: '#1d8f3c' }), C('\n'),
              B('To Pay ₹534', { color: '#b26a00' }),
            ]),
          ],
          {
            time: '11:50 PM',
            keyboard: kb([ok('✓ Payment Done'), pri('↻ Refresh status')], [dgr('Cancel order'), pri('📋 Copy OTP 6214')]),
          }
        ),
      ],
    },
  },
  {
    file: '47-bulk-json-vault.png',
    label: 'Bulk Login — 8 session JSON files ek saath import',
    spec: {
      mode: 'dark',
      header: botHeader({ title: 'Swiggy World Bot', avatarEmoji: '🤖', avatarBg: '#e0574a' }),
      fromTop: true,
      messages: [
        outMsg([C('📎 '), B('session-vault-8.json'), C('  ·  '), IT('1.2 KB · forwarded from Order Collector', DIM)], { time: '2:04 PM' }),
        inMsg(
          [
            qt('▣ BULK LOGIN — 8 OBJECTS DETECTED', [
              B('1. '), MB('8873415879', BL), C(' '), BI('✓ logged in', G), C(' · 286684769\n'),
              B('2. '), MB('12121145', BL), C('   '), BI('✓ logged in', G), C('\n'),
              B('3. '), MB('7006552398', BL), C(' '), BI('✓ logged in', G), C('\n'),
              B('4. '), MB('9348016319', BL), C(' '), BI('× token expired', R), C('\n'),
              B('5. '), MB('6372185500', BL), C(' '), BI('✓ logged in', G), C('\n\n'),
              IT('3/8 pending — 10x parallel claim engine chal raha hai…', DIM),
            ]),
          ],
          { time: '2:05 PM', keyboard: kb([ok('↻ Retry Failed (1)'), pri('▣ Claim ₹50 Offers')], [pri('◉ Family Accounts'), url('📤 Export Session JSON')]) }
        ),
      ],
      toast: { text: '✓ 7 accounts live · 1 expired · OTP skip ho gaya', y: 118 },
    },
  },
  {
    file: '48-unauthorized-lock.png',
    label: 'Random user ne Boss button dabaya → unauthorized',
    spec: {
      mode: 'dark',
      header: botHeader({ title: 'ORDER PLACER' }),
      fromTop: true,
      messages: [
        outMsg([B('📊 Dashboard (ID + Tracking + Phone)')], { time: '11:55 PM' }),
        inMsg(
          [
            qt('× Not allowed', [
              C('Yeh screen sirf '), B('Boss'), C(' ke liye hai.'), C('\n'),
              IT('Aap order dekhne ke liye neeche wale buttons use karein.', DIM),
            ]),
            q([B('Aapka current order'), C('\n'), B('#4821'), C(' · '), BI('OUT_FOR_DELIVERY', Y), C(' · '), B('₹534', DIM)]),
          ],
          { time: '11:55 PM', keyboard: kb([pri('📦 Order Status'), pri('🔗 Extract Tracking Link')], [url('✉ Contact Support')]) }
        ),
      ],
      toast: { text: '⚠ Unauthorized — Boss only', y: 122 },
    },
  },
];
