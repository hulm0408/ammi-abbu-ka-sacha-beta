const H = require('./helpers');
const { B, C, BI, IT, LN, MB, q, rows, map, qr, kb, ok, dgr, gold, url, pri, botHeader, inMsg, outMsg, G, R, Y, BL, DIM, OR, ORDER, ORDER2, billRows } = H;
const HD = botHeader({ title: 'ORDER PLACER', subtitle: 'bot · Boss mode · @ammiabbu_beta', time: '12:04' });
const qt = (title, text, o = {}) => ({ t: 'q', title, text, ...o });
const PIN = '★ 1 order Boss ka wait kar raha hai (#4821 · BILL_READY)';

module.exports = [
  {
    file: '59-boss-check-payment.png',
    label: 'Boss: Check payment → Swiggy verify poll (alert)',
    spec: {
      mode: 'dark', header: HD, pin: PIN, fromTop: true,
      messages: [
        outMsg([B('Check payment status')], { time: '12:02 PM' }),
        inMsg([
          qt('◷ Payment poll — Order #4821', [
            B('Swiggy txn'), C('   '), IT('not settled yet (75s)', Y), C('\n'),
            B('Customer'), C('    '), B('Rahul Kumar'), C(' · '), MB('₹534 sent', BL), C('\n'),
            B('Polls'), C('       '), IT('#1 manual → #2 auto (30s) → #3 auto (60s)', DIM), C('\n'),
            B('Status'), C('      '), MB('UNPAID → VERIFYING', Y),
          ]),
          [IT('3 auto-polls ke baad bhi nahi mila to main customer ko sirf remind karunga — order cancel nahi.', DIM)],
        ], { time: '12:02 PM', keyboard: kb([ok('✓ Manually Confirm Paid'), pri('↻ Poll Now')], [pri('✉ Remind Customer'), dgr('× Bill Recall')]) }),
      ],
      popup: {
        title: 'Beta alert',
        body: [[C('Payment abhi Swiggy par settle nahi hua. Customer ka QR 4 min purana hai — QR 10 min me expire hota hai.')], [IT('Resend QR safe hai, double-charge nahi hoga.', DIM)]],
        buttons: [[{ t: 'Resend QR' }, { t: 'Wait karo', hover: true }]],
        y: 470,
      },
    },
  },
  {
    file: '60-boss-export-json-file.png',
    label: 'Boss: Export Session JSON — file + expiry warning',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('Export JSON File')], { time: '12:00 PM' }),
        inMsg([
          q([B('📤 '), B('rahul-kumar-7058813196.json'), C('  ·  '), IT('1.2 KB · 22 Oct 12:00 PM', DIM)]),
          qt('File me kya hai', [
            B('token'), C('   '), BI('present · jwt valid · expires in 26d', G), C('\n'),
            B('sid'), C('     '), MB('738928882910400001', DIM), C('\n'),
            B('deviceId'), C(' '), IT('2f1e88a5-dac5-7b62-eaad-4136e062bfd7', DIM), C('\n'),
            B('cookies'), C(' '), BI('present', G), C('  ·  '), B('savedAt'), C(' '), IT('auto-refreshed', DIM),
          ]),
          [C('⚠ Yeh file kisi ko '), B('mat bhejo'), C(' — jiske paas yeh hai uske paas account hai.')],
          [IT('Auto-claim on import: file wapas paste karne par OTP skip + ₹50 offers + Free Cash try hoga.', DIM)],
        ], { time: '12:00 PM', keyboard: kb([pri('📋 Copy Code (full)'), ok('▣ Claim ₹50 Offers')], [dgr('↗ Logout Account'), pri('◉ Family Accounts')]) }),
        outMsg([C('📎 '), B('rahul-kumar-7058813196.json')], { time: '12:01 PM' }),
      ],
    },
  },
  {
    file: '61-logout-all-confirm.png',
    label: 'Boss: LOGOUT ALL — danger confirm + active order block',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([dgr('! LOGOUT ALL ACCOUNTS')], { time: '12:01 PM' }),
        inMsg([
          qt('⚠ 6 accounts logout hone wale hain', [
            B('Rahul Kumar'), C(' '), MB('7058813196', DIM), C(' '), BI('● ACTIVE ORDER HAI', R), C('\n'),
            B('Ego tio'), C('    '), MB('8873415879', DIM), C(' ✓'), C('\n'),
            B('Ego fari'), C('    '), MB('12121145', DIM), C(' ✓'), C('\n'),
            B('Panu fab'), C('    '), MB('7488934840', DIM), C(' ✓'), C('\n'),
            B('Ego nino'), C('   '), MB('9348016319', DIM), C(' '), IT('already dead', DIM),
          ]),
          [C('Active order ke saath logout = bill/QR pending rahenge. '), BI('Pehle #4821 resolve karo.', Y)],
        ], { time: '12:01 PM', keyboard: kb([dgr('⚠ LOGOUT 5 (skip active)'), pri('↻ Refresh List')], [ok('⇥ Logout & Export 5'), dgr('× Cancel')]) }),
      ],
      popup: {
        title: 'Dobara confirm',
        body: [[C('5 accounts ka session hatega. JSON export nahi kiya to '), B('login dobara OTP se'), C(' hi hoga.')], [IT('Rahul Kumar (active order) safe rahega.', G)]],
        buttons: [[{ t: 'Cancel' }, { t: 'LOGOUT 5 ACCOUNTS', style: 'danger', hover: true }]],
        y: 452,
      },
    },
  },
  {
    file: '62-export-done-vault.png',
    label: 'Boss: export + logout ho gaya — vault me 5 files',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        inMsg([
          qt('✓ Export & Logout done', [
            C('1. '), B('ego-tio-8873415879.json'), C('  '), IT('1.1 KB · 12:03 PM', DIM), C('\n'),
            C('2. '), B('ego-fari-12121145.json'), C('    '), IT('1.1 KB · 12:03 PM', DIM), C('\n'),
            C('3. '), B('panu-one-8127861271.json'), C('  '), IT('1.2 KB · 12:03 PM', DIM), C('\n'),
            C('4. '), B('panu-fab-7488934840.json'), C('   '), IT('1.0 KB · 12:03 PM', DIM), C('\n'),
            C('5. '), B('ego-nino-9348016319.json'), C('   '), BI('token expired — skip', R),
          ]),
          qt('Vault', [
            B('Files in vault: '), MB('11', BL), C('  ·  '), B('Live accounts: '), MB('1', G), C(' (Rahul Kumar)'), C('\n'),
            IT('Order Collector me forward kar do — wahan se bulk import me wapas aayega.', DIM),
          ]),
          [BI('5 sessions removed from bot DB.', G)],
        ], { time: '12:03 PM', keyboard: kb([ok('📤 Send All 4 Valid Files'), pri('◉ Family Accounts')], [gold('▣ Claim ₹50 (Active)'), pri('★ Boss Panel')]) }),
      ],
      toast: { text: '⚠ Ego nino ka token 3 din pehle mar chuka tha — export skip', y: 122 },
    },
  },
  {
    file: '63-free-cash-results.png',
    label: 'Boss: Free Cash claim engine — per account result',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([ok('₹ Claim Free Cash')], { time: '11:56 PM' }),
        inMsg([
          qt('▣ SWIGGY FREE CASH — 6 accounts', [
            B('Ego tio'), C('    '), MB('8873415879', DIM), C('  '), BI('✓ CLAIMED ₹60', G), C('  ·  '), IT('freebie: 100 off on 599', DIM), C('\n'),
            B('Ego fari'), C('    '), MB('12121145', DIM), C('  '), BI('ALREADY CLAIMED', Y), C('  ·  '), IT('lock 9 din', DIM), C('\n'),
            B('Ego nino'), C('   '), MB('9348016319', DIM), C('  '), BI('NOT ELIGIBLE', R), C('  ·  '), IT('new-account promo only', DIM), C('\n'),
            B('Panu one'), C('   '), MB('8127861271', DIM), C('  '), BI('✓ CLAIMED ₹50', G), C('\n'),
            B('Panu fab'), C('    '), MB('7488934840', DIM), C('  '), BI('✓ CLAIMED ₹60', G), C('\n'),
            B('Rahul Kumar'), C('  '), MB('7058813196', DIM), C('  '), BI('✓ CLAIMED ₹50', G), C('  ·  '), IT('₹50 auto-lag on next bill', DIM),
          ]),
          q([B('Aaj ka total: ₹220 credited'), C('  ·  '), IT('15-day auto-lock ON — yeh accounts 15 din tak dobara try nahi honge.', DIM)]),
        ], { time: '11:57 PM', keyboard: kb([ok('▣ Claim ₹50 Offers'), pri('▤ Paste / Upload Session JSON')], [pri('↻ Re-scan (24h)'), pri('← Back to Main Panel')]) }),
      ],
    },
  },
  {
    file: '64-auto-poller-log.png',
    label: 'Boss: auto tracking poller — background log card',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        inMsg([
          qt('⟳ Auto-Tracking Poller', [
            IT('chalu · 45s interval · 6 accounts · 20s budget/scan', DIM), C('\n'),
            C('12:04:11 '), IT('#4821 scan → link found', G), C('  ·  '), IT('r.swiggy.com pushed to customer', DIM), C('\n'),
            C('12:03:26 '), IT('#4817 scan → delivered, receipt link built (signed, zero-login)', DIM), C('\n'),
            C('12:02:41 '), IT('#4809 scan → no swiggy id yet (order not placed)', Y), C('\n'),
            C('12:01:56 '), IT('#4795 cancel detected → tracking disabled, slot released', DIM),
          ]),
          q([B('Is hour me'), C('  '), B('9 scans · 2 links found · 0 fake links · 0 duplicate messages', G)]),
          [IT('Fake/manual link kabhi nahi bheja jata — sirf Swiggy ka published link hi customer tak jata hai.', DIM)],
        ], { time: '12:04 PM', keyboard: kb([pri('⏸ Pause Poller'), pri('↻ Scan Now (deep)')], [dgr('× Poller Band'), ok('⚡ Fetch all missing tracking')]) }),
      ],
    },
  },
  {
    file: '65-antibot-block.png',
    label: 'Boss: Swiggy ne block kiya — bot ne brute force roka',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('↻ Refresh All Accounts')], { time: '11:58 PM' }),
        inMsg([
          qt('⚠ Swiggy rate limit — 3 dead', [
            B('Ego tio'), C('    '), BI('✓ ok', G), C('\n'),
            B('Ego fari'), C('    '), BI('✓ ok', G), C('\n'),
            B('Ego nino'), C('   '), BI('× HTTP 429', R), C('  ·  '), IT('cooldown 14:42', DIM), C('\n'),
            B('Panu one'), C('   '), BI('× security challenge', R), C('  ·  '), IT('app me solve karo', DIM), C('\n'),
            B('Panu fab'), C('    '), BI('✓ ok', G), C('\n'),
            B('Rahul Kumar'), C('  '), BI('× 1 retry left', Y),
          ]),
          [B('Auto-retry OFF rakha hai', R), C(' — 2 baad ek hi account par 4 try karna flag karwata hai.')],
        ], { time: '11:58 PM', keyboard: kb([pri('↻ Retry Dead (3)'), dgr('⏸ Sab Retry Band')], [ok('◉ Family Accounts'), url('Open official Swiggy')]) }),
      ],
      toast: { text: '! 429s se bachne ke liye 900s wait', y: 120 },
    },
  },
  {
    file: '66-account-address-picker.png',
    label: 'Boss: ⌖ Select Account Address — recipient override',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([pri('⌖ Select Account Address')], { time: '11:59 PM' }),
        inMsg([
          qt('⌖ Address history & target delivery', [
            IT('Rahul Kumar (7058813196) ke Swiggy account se 3 saved address mile.', DIM), C('\n'),
            B('1. '), BI('✓ ACTIVE · Al Noor Informations', G), C(' '), MB('#4821', DIM), C('\n'),
            C('     '), IT('Ground Floor, Hazratganj, Lucknow - 226007 · 98765 43210', DIM), C('\n'),
            B('2. '), C('Gomti Nagar  ·  Sector 15'), C(' '), IT('not used', DIM), C('\n'),
            B('3. '), C('Chaupl  ·  Faizabad Road'), C(' '), IT('out of 7km → delivery fee aayegi', Y),
          ]),
          [C('Rule: chat text se address kabhi nahi banta — share link ya pin hi valid hai.')],
        ], { time: '11:59 PM', keyboard: kb([ok('✓ Yahi Rakho (1)'), pri('2. Gomti Nagar')], [pri('3. Chaupl (fee check)'), dgr('× Paste Fresh Address Link')]) }),
      ],
    },
  },
  {
    file: '67-coupon-picker.png',
    label: 'Boss: # Change Coupon — live coupon probe per account',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([pri('# Change Coupon')], { time: '12:00 PM' }),
        inMsg([
          qt('◷ Coupon probe — Order #4821 · ₹608 items', [
            B('FESTIVE150'), C('   '), BI('−₹150 ✓ applied', G), C('  ·  '), IT('Rahul Kumar', DIM), C('\n'),
            B('SUPER60'), C('     '), BI('−₹180', G), C('  '), IT('not applicable (biryani excluded)', R), C('\n'),
            B('WELCOME150'), C(' '), C('−₹150', DIM), C(' '), BI('✓ works here too', G), C('  ·  '), IT('but 1 order/account', DIM), C('\n'),
            B('FREEDEL'), C('      '), C('−₹45', DIM), C('  '), BI('already free via One Lite', Y),
          ]),
          q([B('Best combo'), C(' '), BI('FESTIVE150 + ₹50 Free Cash + FREE DEL', G), C(' '), B('→ ₹534 payable · ₹284 saved')]),
        ], { time: '12:00 PM', keyboard: kb([ok('✓ Lock This Bill'), pri('# WELCOME150 Try')], [pri('↻ Re-probe (24s)'), dgr('× No Coupon')]) }),
      ],
    },
  },
  {
    file: '68-slot-management.png',
    label: 'Boss: Slot management — limit + reason + lock',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('slots')], { time: '12:05 PM' }),
        inMsg([
          qt('📦 Order Slots', [
            B('Available: '), B('6/10', Y), C('  ·  '), B('Today placed: '), MB('4', BL), C('\n'),
            B('Pending: '), C('1 (#4821)', DIM), C('  ·  '), B('Delivered: '), MB('3', G), C('  ·  '), B('Cancelled: '), MB('0', DIM), C('\n'),
            B('Auto-lock'), C(': '), IT('har order ke baad slot ghat-ta hai, delivered/cancel par wapas', DIM),
          ]),
          qt('Limits', [
            B('Per customer/day: '), MB('1 active + 2 done', DIM), C('\n'),
            B('Boss override: '), IT('reset kar sakta hai, reason log hota hai', DIM), C('\n'),
            B('Last reset'), C(': '), IT('19 Oct · "ammi biwi ka birthday" · by Boss', DIM),
          ]),
          [IT('0 slot = customer ko seedha reason dikhega, order accept nahi hoga.', DIM)],
        ], { time: '12:05 PM', keyboard: kb([gold('+1 Slot Do'), ok('↻ Reset Slots (10/10)')], [dgr('🔒 Aaj ke liye Band'), pri('◷ Kal 7 AM Auto-Open')]) }),
      ],
    },
  },
  {
    file: '69-refund-tracking.png',
    label: 'Boss: refund track — customer ko status, Swiggy pe depend',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('📦 Orders Done')], { time: '12:06 PM' }),
        inMsg([
          qt('★ Order History (All Completed)', [
            B('1. #4817'), C(' '), BI('₹174', G), C('  ·  '), IT('delivered 7:56 AM · Thandai + Aloo Paratha', DIM), C('\n'),
            B('2. #4795'), C(' '), BI('₹174 → ₹134 refund', Y), C('  ·  '), IT('late delivery, auto-refund by Swiggy', DIM), C('\n'),
            B('3. #4780'), C(' '), BI('₹534', G), C('  ·  '), IT('delivered 20 Oct · Biryani by Nasir', DIM),
          ]),
          qt('Refund #4795', [
            B('Initiated'), C('  '), IT('20 Oct 11:44 PM · ₹40', DIM), C('\n'),
            B('Swiggy ETA'), C(' '), MB('24-48 hrs', Y), C('  ·  '), B('To'), C(' '), IT('PhonePe 90000@ybl', DIM), C('\n'),
            B('Status'), C('     '), BI('PROCESSING (not fake-promised)', DIM),
          ]),
        ], { time: '12:06 PM', keyboard: kb([pri('↻ Refund Dobara Check'), ok('✉ Customer ko Batao')], [pri('📄 Export Receipt'), dgr('× Close')]) }),
      ],
    },
  },
  {
    file: '70-boss-no-offer-found.png',
    label: 'Boss: offer nahi mila → pending rakha, customer ko bil nahi bheja',
    spec: {
      mode: 'dark', header: HD, pin: PIN, fromTop: true,
      messages: [
        inMsg([
          qt('! Auto offers: no eligible offer confirmed by Swiggy', [
            B('Order'), C(' '), MB('#4823', BL), C('  ·  '), B('Items ₹412'), C('  ·  '), B('6 accounts scanned', DIM), C('\n'),
            C('▪ '), B('Coupon: '), IT('SUPER60 excluded (ice-cream items)', R), C('\n'),
            C('▪ '), B('Free delivery: '), IT('restaurant 8.4 km → FREE DEL upto 7km fail', R), C('\n'),
            C('▪ '), B('Free cash: '), IT('₹50 available but min ₹499 (order ₹412)', Y),
          ]),
          q([B('Decision'), C('\n'), B('Bill customer ko nahi bheja '), IT('(avoid double billing)', DIM), C('\n'), C('Order '), BI('PENDING', Y), C(' me rakha — customer ko sirf status dikhaya.')]),
        ], { time: '12:07 PM', keyboard: kb([gold('★ Auto Max Coupon (Retry)'), pri('# Manual Coupon Lagao')], [ok('✓ ₹412 pe Hi Bhejo'), dgr('× Sorry bolo + Slot Free')]) }),
      ],
    },
  },
];
