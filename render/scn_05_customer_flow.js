const H = require('./helpers');
const { B, C, BI, IT, LN, MB, q, rows, map, qr, kb, ok, dgr, gold, url, pri, botHeader, inMsg, outMsg, G, R, Y, BL, DIM, OR, ORDER, ORDER2 } = H;
const HD = botHeader({ title: 'ORDER PLACER', subtitle: 'bot · @ammiabbu_beta', time: '9:12' });
const qt = (title, text, o = {}) => ({ t: 'q', title, text, ...o });
const PIN = '★ Subah 7:45 tak order karo — ₹50 breakfast offer live hai';

const T = 'Thandai 500ml x1 · Aloo Paratha x2';

module.exports = [
  {
    file: '49-customer-cart-received.png',
    label: 'Customer → Beta: cart + address mil gaya, slot reserved',
    spec: {
      mode: 'dark', header: HD, pin: PIN, fromTop: true,
      messages: [
        outMsg([B('› Send to Beta')], { time: '7:06 AM' }),
        inMsg([
          q([BI('✓ Order #4817 received', G), C('  ·  '), B('SLOT RESERVED'), C(' '), IT('(7/10 → 6/10)', DIM)]),
          qt('Aapka Order', [
            B(ORDER2.restaurant), C('\n'),
            C('1. '), B('Thandai 500ml'), C('  ·  Qty: 1  ·  ₹120', DIM), C('\n'),
            C('2. '), B('Aloo Paratha (2 pc)'), C('  ·  Qty: 2  ·  ₹165', DIM), C('\n'),
            B('Items Total: '), C('₹450', DIM),
          ]),
          qt('Delivering To', [
            B(ORDER2.addrName), C(' · '), MB(ORDER2.addrPhone, BL), C('\n'),
            IT(ORDER2.addr, DIM), C('\n'),
            IT('Rider inhi ko call karega — aapka number kahi print nahi hoga.', G),
          ]),
          qt('Ab aage', [
            IT('Main best account + max coupon dhoondh raha hoon. Bill lock hote hi yahin ek hi card me dikhaunga — 2 message nahi aayenge.', DIM),
          ]),
        ], { time: '7:06 AM', keyboard: kb([pri('◷ Refresh Status'), pri('▤ Cart Badlo')], [dgr('× Cancel Draft')]) }),
      ],
    },
  },
  {
    file: '50-customer-bill-approved.png',
    label: 'Customer → Beta: bill galat tha, dobara banwaya, ab approve',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('✓ Approve bill')], { time: '7:14 AM' }),
        inMsg([
          q([BI('✓ Bill approved — Order #4817', G), C('  ·  '), MB('₹174', Y)]),
          qt('Bill jo aapne approve kiya', [
            B('Items ₹450'), C('  ·  '), BI('BREAKFAST50 −₹50', G), C('\n'),
            B('Delivery '), BI('FREE', G), C(' (₹32 saved)  ·  '), B('Packing '), C('₹30', DIM), C(' · '), B('GST '), C('₹44', DIM), C('\n'),
            B('Total Savings '), BI('₹95', G), C('  ·  '), B('To Pay '), B('₹174', Y),
          ]),
          qt('Retry history', [
            C('1st bill '), IT('₹229 · no coupon', R), C(' → aapne "! Something is wrong" dabaya'), C('\n'),
            C('2nd bill '), BI('₹174 · BREAKFAST50 + free delivery', G), C(' ✓ approved'),
          ]),
          [IT('QR 2 min me yahin aa jayega. Koi auto-charge nahi hua hai.', DIM)],
        ], { time: '7:14 AM', keyboard: kb([pri('↻ Status Lao'), pri('✉ Beta ko Bolo')]) }),
      ],
    },
  },
  {
    file: '51-customer-qr-paid.png',
    label: 'Customer → Beta: maine QR se pay kar diya',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([C('📎 '), B('paid-screenshot.jpg'), C('  ·  '), IT('PhonePe ₹174 · 7:19 AM', DIM)], { time: '7:19 AM' }),
        inMsg([
          q([BI('✓ Payment verify ho gayi', G), C('  ·  '), MB('swiggy_txn_9f2a', DIM)]),
          qt('Verified', [
            B('Amount'), C('   '), MB('₹174', G), C('  ·  '), B('via'), C(' '), IT('PhonePe · UPI', DIM), C('\n'),
            B('Order'), C('    '), MB('#4817', BL), C(' → '), B('Order Hub par bhej diya'), C('\n'),
            B('Time'), C('    '), IT('7:19:41 AM (auto-check, 2 try)', DIM),
          ]),
          [IT('Ab order Swiggy se confirm hoga — confirm hote hi OTP + tracking yahin aayega.', DIM)],
        ], { time: '7:20 AM', keyboard: kb([ok('🔔 Notify me'), pri('📦 Order Status')], [url('💳 Swiggy Payment Page')]) }),
      ],
      toast: { text: '✓ 174 ka payment match ho gaya', y: 120 },
    },
  },
  {
    file: '52-customer-live-tracking.png',
    label: 'Customer → Beta: live tracking puchha',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('◷ Kahan aa raha hai order?')], { time: '7:44 AM' }),
        inMsg([
          q([B('● ORDER #4817 IS OUT FOR DELIVERY', Y), C('  ·  '), IT('3 min me milega', G)]),
          map({ h: 130, label: 'Rider Sonu · 480 m · Alambagh → Al Noor' }),
          qt('Live', [
            B('Status'), C('   '), MB('OUT_FOR_DELIVERY', Y), C('  ·  '), IT('updated 7:44:02 AM', DIM), C('\n'),
            B('Tracking'), C(' '), LN('r.swiggy.com/s/8301699014'), C('\n'),
            B('Rider'), C('    '), B('Sonu · 88077 44120'), C('  ·  '), url('Call', { color: BL }), C('\n'),
            B('OTP'), C('      '), MB('4471', Y),
          ]),
          [IT('Auto-refresh: har 45 sec me main khud check karke card update karunga.', DIM)],
        ], { time: '7:44 AM', keyboard: kb([url('🔗 Open Live Tracking'), gold('📋 Copy OTP 4471')], [pri('↻ Abhi Refresh'), dgr('× Track Band')]) }),
      ],
    },
  },
  {
    file: '53-customer-delivery-otp.png',
    label: 'Customer → Beta: OTP chahiye (rider gate me)',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('OTP bhej do jaldi')], { time: '7:47 AM' }),
        inMsg([
          q([BI('🔑 Delivery OTP — Order #4817', G), C('  ·  '), IT('Abhi valid', DIM)]),
          q([MB('4471', Y)]),
          qt('Ammi Bi ko batao', [
            IT('Rider: Sonu · 88077 44120 · 2 min me doorbell', DIM), C('\n'),
            C('OTP sirf '), B('rider ko'), C(' do — kisi aur ko nahi. Copy karke forward kar sakte ho.'),
          ]),
        ], { time: '7:47 AM', keyboard: kb([gold('📋 Copy OTP 4471'), ok('↗️ Share to Ammi')], [pri('📞 Call Rider'), dgr('× OTP Change')]) }),
      ],
      banner: { title: 'ORDER PLACER', icon: '🛵', time: 'now', h: 84,
        body: [[BI('4471', G), C(' is the delivery OTP for your Swiggy order 4817. Share it only with the rider.')]] },
    },
  },
  {
    file: '54-customer-share-otp.png',
    label: 'OTP share-to-group: Beta ne Ammi ke group me bhej diya',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('👥 Share to Group')], { time: '7:48 AM' }),
        inMsg([
          q([BI('✓ OTP bhej diya', G), C(' — "Ammi Abbu Ghar" group me (2 members)')]),
          qt('Kya gaya', [
            MB('4471', Y), C('  ·  '), IT('rider ko dikhana hai, 15 min me expire', DIM), C('\n'),
            B('Rider: '), C('Sonu · 88077 44120', DIM),
          ]),
          [IT('Aapke chat me kuch nahi badla — order card same rahega.', DIM)],
        ], { time: '7:48 AM', keyboard: kb([pri('📦 Order Status'), ok('↻ Status Bhejo Group me')], [dgr('× Notification Stop')]) }),
      ],
      toast: { text: '↗️ Chat me type karo: "@ 4471" — ya button dabao', y: 1000 },
    },
  },
  {
    file: '55-customer-delivered.png',
    label: 'Order delivered — receipt + parent ko thank-you',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        inMsg([
          q([BI('✓ Order #4817 delivered', G), C('  ·  '), IT('7:56 AM · 22 min total', DIM)]),
          map({ h: 110, label: 'Delivered · Al Noor Informations, Hazratganj' }),
          qt('Receipt', [
            B('Thandai 500ml'), C('  ₹120\n'),
            B('Aloo Paratha (2 pc) x2'), C('  ₹330\n'),
            BI('BREAKFAST50', G), C('  −₹50  ·  '), B('Delivery '), BI('FREE', G), C('\n'),
            B('Paid'), C(' '), BI('₹174', Y), C('  ·  '), IT('saved ₹95', G),
          ]),
          qt('Ammi Bi ka SMS', [
            IT('Mila: "Thandi thandai mil gayi, shukriya 🙏" — 7:57 AM', G),
          ]),
        ], { time: '7:57 AM', keyboard: kb([url('🔗 Delivered order tracking'), gold('📋 Copy Swiggy ID 699014')], [ok(' Receipt Bhejo'), pri('↗️ Share Receipt')], [pri('📦 Orders Done'), ok('★ Aaj ka breakfast')]) }),
      ],
    },
  },
  {
    file: '56-customer-late-night-fallback.png',
    label: 'Customer → Beta: order galat pahuncha, Beta ne galti maani',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('Paratha thande aa gaye 😑')], { time: '11:18 PM' }),
        inMsg([
          q([BI('! Sorry yaar', OR), C('  ·  '), B('Order #4821'), C(' ka record dekh liya')]),
          qt('Kya hua', [
            IT('Rider 22 min late aaya (traffic) — Swiggy ne khud "Late delivery" mark kiya.', DIM), C('\n'),
            B('Refund: '), BI('₹40 auto-initiated', G), C(' by Swiggy · 24-48 hrs'), C('\n'),
            B('Next order: '), IT('11:35 PM ke baad late-night coupon ₹50 milega', Y),
          ]),
          [C('Aap bolo to main ')  , B('Swiggy support ticket'), C(' khol dun?')],
        ], { time: '11:19 PM', keyboard: kb([ok('✓ Theek hai, chhodo'), pri('🎫 Ticket kholo')], [dgr('↻ Dobara Order Karo'), pri('💰 Refund Track')]) }),
      ],
    },
  },
  {
    file: '57-customer-coupon-picked.png',
    label: 'Customer ne coupon badalwaaya (Sir se pehle)',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('# Change Coupon')], { time: '7:11 AM' }),
        inMsg([
          qt('▣ Available coupons — Order #4817', [
            B('BREAKFAST50'), C('  '), BI('−₹50 + FREE DEL', G), C('  '), IT('✓ selected (Panu fab)', DIM), C('\n'),
            B('WELCOME150'), C('   '), C('−₹40 · min ₹399', DIM), C('  '), IT('not applicable', R), C('\n'),
            B('FREEDEL'), C('        '), C('−₹32', DIM), C('  '), IT('weaker', DIM),
          ]),
          qt('Naya bill', [
            B('Items ₹450 · '), BI('−₹50', G), C(' · '), B('Packing ₹30 · GST ₹44'), C('\n'),
            B('To Pay '), B('₹174', Y), C('  ·  '), BI('saved ₹95', G), C('  ·  '), IT('2nd best se ₹26 zyada', DIM),
          ]),
          [IT('Coupon change karte hi Boss ko notification chala jata hai — bill ek hi baar bheja jata hai.', DIM)],
        ], { time: '7:11 AM', keyboard: kb([ok('✓ Yahi Rakho'), pri('# Doosra Coupon Try')], [dgr('× Bill Cancel'), pri('↻ Recompute Max')]) }),
      ],
    },
  },
  {
    file: '58-customer-reorder.png',
    label: 'Same order kal phir se — re-order in 1 tap',
    spec: {
      mode: 'dark', header: HD, fromTop: true,
      messages: [
        outMsg([B('↻ Previous order')], { time: '7:58 AM' }),
        inMsg([
          q([B('Kal bhi yahi chahiye?')]),
          qt('Pichhla order #4817', [
            B(ORDER2.restaurant), C('\n'),
            C(T), C('  ·  '), B('₹174', Y), C('\n'),
            B('Deliver to: '), IT('Al Noor Informations, Lucknow', DIM), C('\n'),
            B('Slot: '), MB('6/10', G), C('  ·  '), B('Best account: '), MB('7488934840', BL),
          ]),
          qt('Kya same rahega', [
            IT('Cart ✓ · Address ✓ · Coupon ✓ (subah 7:30-10 ke beest) · QR sirf approve ke baad.', DIM),
          ]),
        ], { time: '7:58 AM', keyboard: kb([ok('› Kal 8 AM pe Place Karo'), gold('★ Max Coupon Try')], [pri('▤ Cart Badlo'), dgr('× Reorder Band')]) }),
      ],
    },
  },
];
