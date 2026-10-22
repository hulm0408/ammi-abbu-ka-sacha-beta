const H = require('./helpers');
const { B, C, BI, IT, LN, M, MB, q, hr, rows, map, qr, img, kb, ok, dgr, gold, url, pri, botHeader, bossHeader, inMsg, outMsg, G, R, Y, BL, DIM, OR, ORDER, ORDER2, billRows, itemsBlock } = H;

const HD = botHeader();
const BH = bossHeader();
const PIN = '★ MAX COUPON WINNER ACCOUNT LOCKED! (Order #4821)';

module.exports = [
  {
    file: '13-order-confirmed.png',
    label: 'Order confirmed: live status + OTP + tracking',
    spec: {
      mode: 'dark',
      header: HD,
      pin: PIN,
      fromTop: true,
      messages: [
        inMsg(
          [
            q([BI('✓ Order #4821 — Confirmed', G), C('  ·  '), B('ORDER PLACED ON SWIGGY')]),
            q([B('Order Status'), C('\n'), B('Order Accepted · Ready to cook', Y), C('\n'), B('ETA: 32 min'), C('  ·  '), IT('10:52 PM delivery window', DIM), C('\n'), B('Swiggy tracking: '), LN(ORDER.track.replace('https://', ''))]),
            q([B('Delivery OTP'), C('\n'), MB(ORDER.otp, Y), C('  ·  '), IT('Rider ko delivery par batana', DIM)]),
            q([B('Delivering To'), C('\n'), B(ORDER.addrName), C(' · '), MB(ORDER.addrPhone, BL), C('\n'), IT(ORDER.addr, DIM)]),
            q([B('Placed from'), C('\n'), MB(ORDER.acc, BL), C('  ·  '), IT('Swiggy account: Rahul Kumar', DIM)]),
            [IT('Support: @Its_life_001', DIM)],
          ],
          {
            time: '2:52 PM',
            keyboard: kb([url('🔗 Open Swiggy tracking'), url('💳 Pay via Swiggy (UPI/Card)')], [pri('Refresh status'), dgr('Cancel order')], [gold('📋 Copy OTP ' + ORDER.otp), url('✉ Contact support')]),
          }
        ),
      ],
    },
  },
  {
    file: '14-order-done-receipt.png',
    label: 'Order done: receipt + rider + delivered tracking',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            q([BI('★ Order #4821 — Delivered', G), C('  ·  '), IT('10:59 PM · Biryani by Nasir', DIM)]),
            map({ h: 128, label: 'Hazratganj → Al Noor Informations · 1.9 km' }),
            q([B('Rider'), C('\n'), B(ORDER.rider), C('  ·  '), MB(ORDER.riderPhone, BL), C('  ·  '), IT('Delivery recorded', G)]),
            q([B('Receipt'), C('\n'), B('Items Total'), C('  ₹608', DIM), C('\n'), BI('FESTIVE150', G), C('  −₹150  ·  '), B('Free Cash'), C(' −₹50', DIM), C('\n'), B('Paid on Swiggy'), C('  '), BI('₹534', Y), C('  ·  '), IT('saved ₹284', G)]),
            q([B('Tracking'), C('\n'), LN('r.swiggy.com/s/8301745529'), C('  ·  '), IT('order delivered', DIM)]),
          ],
          {
            time: '11:02 PM',
            read: 2,
            keyboard: kb([url('🔗 Open delivered order tracking'), gold('📋 Copy Swiggy ID 745529')], [pri('↗️ Share Order'), pri('👥 Share to Group')], [ok('▣ Naya Order Karo'), pri('📦 Orders Done')]),
          }
        ),
      ],
    },
  },
  {
    file: '15-no-tracking-yet.png',
    label: 'Swiggy link not published yet → auto-fetch promise',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('◷ Tracking link abhi nahi mila'), C('  ·  '), IT('Order #4821 · Swiggy #8301745529', DIM)]),
            q([B('Kya ho raha hai'), C('\n'), IT('Swiggy ne abhi is order ka share link publish nahi kiya. Bot har 45 sec me 6 logged-in IDs scan kar raha hai — link milte hi yahin aayega.', DIM)]),
            q([B('Tum khud bhi check kar sakte ho'), C('\n'), LN('swiggy.com/orders', { color: BL })]),
            [IT('Bot koi fake/manual tracking link nahi banata.', DIM)],
          ],
          { time: '11:04 PM', keyboard: kb([pri('↻ Abhi Scan Karo'), pri('◷ Refresh status')], [dgr('× Link Notification Band')]) }
        ),
      ],
    },
  },
  {
    file: '16-extract-prompt.png',
    label: 'Extract Tracking Link → order id maangta hai',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: 'FWD9670', placeholder: 'Enter Order ID' },
      fromTop: true,
      messages: [
        outMsg([B('🔗 Extract Tracking Link')], { time: '11:05 PM' }),
        inMsg(
          [
            q([B('🔗 Extract Tracking Link — All IDs scan')]),
            [C('Send the '), B('Order ID'), C(' (e.g. '), MB('FWD9670'), C(') or Swiggy Order ID.')],
            [IT('Main har logged-in Swiggy ID par yeh id check karunga — 6 IDs · 20 sec budget.', DIM)],
          ],
          { time: '11:05 PM', keyboard: kb([ok('📋 Paste from Clipboard')]) }
        ),
      ],
    },
  },
  {
    file: '17-extract-found.png',
    label: 'Extract success: id + phone + live tracking + OTP + rider',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        outMsg([MB('FWD9670')], { time: '11:06 PM' }),
        inMsg(
          [
            q([BI('✓ Tracking found', G)]),
            q([B('Swiggy order'), C('  '), MB('8301745529', BL), C('\n'), B('Placed from'), C('  '), MB('8127861271', BL), C('\n'), B('Status'), C('  '), MB('OUT_FOR_DELIVERY', Y), C('\n'), B('Tracking'), C('  '), LN('Open Swiggy tracking'), C('\n'), B('Delivery OTP'), C('  '), MB('6214', G), C('\n'), B('Rider'), C('  '), B('Imran Ansari · 99050 11234')]),
          ],
          { time: '11:06 PM', keyboard: kb([url('🔗 Open Swiggy tracking')], [gold('📋 Copy Link'), pri('↗️ Share Link')]) }
        ),
      ],
    },
  },
  {
    file: '18-extract-not-found.png',
    label: 'Extract fail: id kisi ID par nahi mila (no fake link)',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        outMsg([MB('9931')], { time: '11:07 PM' }),
        inMsg(
          [
            q([C('✕ ', R), B('Order 9931 not found.', R)]),
            [IT('Bot koi false order id nahi banata — sirf real Swiggy order id (numeric) scan hota hai.', DIM)],
          ],
          { time: '11:07 PM', keyboard: kb([pri('↻ Dubara Try Karo'), pri('📦 Orders Done')]) }
        ),
        inMsg(
          [
            q([C('✕ ', R), B('Swiggy order 9912003344771 kisi bhi logged-in ID par nahi mila.', R)]),
            q([B('Scanned'), C('  '), B('6 IDs'), C('  ·  '), IT('18.4 sec', DIM), C('  ·  '), IT('no timeout', G)]),
            [IT('Order id check karein (numeric, 12–18 digits). Bot koi false tracking link nahi banata.', DIM)],
          ],
          { time: '11:07 PM', keyboard: kb([pri('↻ Retry Deep Scan'), dgr('× Close')]) }
        ),
      ],
    },
  },
  {
    file: '19-orders-done.png',
    label: 'Orders Done — successful order history',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('★ Success Orders Archive'), C(' · '), IT('Today · 11 Oct 2026', DIM)]),
            q([B('1. [ #4821 ] — ₹534'), C('\n'), B('Customer: '), C('Rahul Kumar', DIM), C(' · '), B('Restaurant: '), C('Biryani by Nasir', DIM), C('\n'), B('Items: '), C('Chicken Dum Biryani x1, Butter Naan x2', DIM), C('\n'), B('Account: '), C('Rahul Kumar · 7058813196', DIM), C(' · '), B('Completed '), C('11:02 PM', DIM)]),
            q([B('2. [ #4817 ] — ₹174'), C('\n'), B('Customer: '), C('Rahul Kumar', DIM), C(' · '), B('Restaurant: '), C('Kanpur Kittan Chowk', DIM), C('\n'), B('Items: '), C('Thandai 500ml x1, Aloo Paratha x2', DIM), C('\n'), B('Account: '), C('Panu fab · 7488934840', DIM), C(' · '), B('Completed '), C('9:41 AM', DIM)]),
            [IT('...and 9 more orders this month.', DIM)],
          ],
          { time: '11:09 PM', keyboard: kb([pri('◷ Choose Another Date')], [pri('← Back to Panel'), ok('↗️ Share Receipt')]) }
        ),
      ],
    },
  },
  {
    file: '20-cancel-confirm.png',
    label: 'Cancel order confirmation (popup style)',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('● Order #4821'), C('  ·  '), IT('BILL_READY · ₹534 payable', DIM)]),
            q([B('Bill Summary'), C('\n'), B('To Pay: '), B('₹534', Y), C('  ·  '), IT('Approve pending', DIM)]),
          ],
          { time: '11:10 PM', keyboard: kb([ok('✓ Approve bill'), dgr('! Something is wrong')], [dgr('× Cancel order')]) }
        ),
      ],
      popup: {
        title: 'Order cancel karein?',
        body: [
          [C('Swiggy par order place ho chuka hai — cancel karne par '), B('₹19 convenience fee'), C(' cut sakti hai.')],
          [IT('Slot wapas release ho jayega (7/10 → 8/10).', DIM)],
        ],
        buttons: [[{ t: 'Nahi, rakho' }, { t: 'Haan, cancel karo', style: 'danger', hover: true }]],
        y: 470,
      },
    },
  },
  {
    file: '21-payment-pending-toast.png',
    label: 'Check payment status → alert: payment nahi mila',
    spec: {
      mode: 'dark',
      header: HD,
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('💳 Payment Required — Order #4821')]),
            q([B('Pay to confirm'), C('\n'), C('Amount '), B('₹534'), C(' — UPI QR, Card, or Wallet via Swiggy.')]),
            q([B('Till now'), C('\n'), IT('1 attempt · last checked 11:12 PM', DIM), C('\n'), B('Status: '), C('UNPAID', R)]),
          ],
          { time: '11:11 PM', keyboard: kb([url('₹ Pay on Swiggy (Official Link)')], [ok('Check payment status'), pri('Resend payment QR')]) }
        ),
      ],
      toast: { text: '! Payment abhi verify nahi hua — Swiggy 2-3 min leta hai', y: 120 },
    },
  },
  {
    file: '22-boss-panel-home.png',
    label: 'Boss Panel home — accounts + order counters',
    spec: {
      mode: 'dark',
      header: HD,
      pin: PIN,
      fromTop: true,
      messages: [
        inMsg(
          [
            { t: 'q', title: '★ Boss Panel', text: [B('Swiggy Accounts')] },
            q([B('Ego tio: '), BI('● Logged In (8873415879)', G), C('\n'), B('Ego fari: '), BI('● Logged In (12121145)', G), C('\n'), B('Panu one: '), BI('● Logged In (8127861271)', G), C('\n'), B('Panu fab: '), BI('● Logged In (7488934840)', G), C('\n'), B('Rahul Kumar: '), BI('● Logged In (7058813196)', G), C('\n'), B('Ego nino: '), C('○ Not Logged In', DIM)]),
            q([B('Orders'), C('\n'), B('Pending: '), B('1'), C('   '), B('In Progress: '), B('2'), C('   '), B('Completed: '), B('11')]),
            [IT('Manage orders, accounts, and offers from here.', DIM)],
          ],
          {
            time: '2:24 PM',
            keyboard: kb([pri('📊 Dashboard (ID + Tracking + Phone)')], [pri('🔗 Extract Tracking Link')], [pri('📦 Orders Done'), pri('▣ Pending Orders')], [pri('◉ Connected Accounts'), pri('↻ Refresh Panel')], [dgr('× Close')]),
          }
        ),
      ],
    },
  },
  {
    file: '23-boss-login-number.png',
    label: 'Boss: Login with Number → force reply for phone',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: '90000 12345', placeholder: 'Enter 10-digit Swiggy number...' },
      fromTop: true,
      messages: [
        outMsg([B('Login with Number')], { time: '2:26 PM' }),
        inMsg(
          [
            q([B('☎ Swiggy account number')]),
            [C('10-digit Indian number bhejo (optional +91). Bot OTP request karega aur session capture kar lega.')],
            q([B('Rule'), C('\n'), IT('Ek number = ek Swiggy account. OTP sirf 6 digits, 2 min me auto-expire.', DIM)]),
          ],
          { time: '2:26 PM', keyboard: kb([dgr('× Cancel Login')]) }
        ),
        inMsg(
          [
            q([B('💡 Preferred: Session JSON')]),
            [IT('Number + OTP wala rasta Swiggy security challenge de sakta hai. Export kiya hua session JSON 100% chalta hai.', DIM)],
          ],
          { time: '2:26 PM', keyboard: kb([pri('▤ Session JSON')], [pri('↻ Re-enter Number')]) }
        ),
      ],
    },
  },
  {
    file: '24-otp-sent-card.png',
    label: 'OTP sent card (login flow) with resend/copy',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: '4', placeholder: 'Enter 6-digit OTP...' },
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('◈ Swiggy Login OTP'), C('\n'), C('☎ '), B('Number: '), MB('9000012345', BL), C('\n'), B('OTP sent at'), C('  '), IT('11:26:41 PM · Swiggy verify API', DIM), C('\n'), B('Attempts'), C('  '), IT('1/3', Y)]),
            [IT('OTP isi chat me 6 digits me bhejo — bot auto-verify karke session save karega.', DIM)],
          ],
          { time: '11:26 PM', keyboard: kb([ok('✉ Resend OTP'), pri('Copy Number')], [pri('↻ Re-enter OTP'), dgr('× Cancel')]) }
        ),
      ],
      banner: { title: 'SMS · Swiggy', icon: '🛵', body: 'Swiggy Verification: 447192 is your one-time password. Do not share it with anyone.', time: 'now', h: 82 },
    },
  },
];
