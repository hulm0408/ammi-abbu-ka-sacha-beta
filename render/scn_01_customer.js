const H = require('./helpers');
const { B, C, BI, IT, LN, M, MB, q, hr, rows, map, qr, img, kb, ok, dgr, gold, url, pri, botHeader, inMsg, outMsg, G, R, Y, BL, DIM, OR, ORDER, ORDER2, billRows, itemsBlock } = H;

const HD = botHeader();
const PIN = '★ MAX COUPON WINNER ACCOUNT LOCKED! (Order #4821)';

module.exports = [
  {
    file: '01-customer-welcome.png',
    label: 'Customer /start → welcome + live status card',
    spec: {
      mode: 'dark',
      header: HD,
      pin: PIN,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        {
          date: 'Today',
          time: '2:39 PM',
          body: [
            [C('→ ', OR), B('Welcome to Ammi Abbu Ka Sacha Beta')],
            [C('Swiggy order ke liye apna '), B('Cart link'), C(' aur '), B('Delivery Address link'), C(' share karein.')],
            [IT('Dono me se koi bhi pehle bhejo — order ek hi card me banega, no spam.', DIM)],
            [BI('› Dono link ke baad [ › Send to Beta ] dabana hai.', G)],
          ],
          keyboard: kb(['📦 Order Status', '🔗 Extract Tracking Link'], [' Support @Its_life_001']),
        },
        inMsg(
          [
            q([B('📦 Order Slots'), C('\n'), B('Available: 7/10'), C('  ·  '), IT('Order for your parents — delivered to their name & phone', DIM)]),
            q([B('Order Summary'), C(' · '), BI('Cart & address needed', Y), C('\n'), B(ORDER.restaurant), C('  (3 items · ₹608)', DIM)]),
            q([B('🛒 Swiggy Order'), C('\n'), B('Cart: '), C('Not added', DIM), C('\n'), B('Delivery: '), C('Not added', DIM)]),
            q([B('Recipient Info'), C('\n'), IT('Order recipient ke name & phone par place hoga — aapke number par nahi. Rider unhe hi call karega.', DIM)]),
            [B('Add a valid address link to continue.')],
            [IT('◈ No account allocated; QR is blocked.', DIM)],
          ],
          { time: '2:39 PM', keyboard: kb([pri('▤ Cart Link'), pri('⌖ Address Link')], [ok('› Send to Beta')], [dgr('× Cancel order'), pri('↻ Previous order')]) }
        ),
      ],
    },
  },
  {
    file: '02-cart-accepted.png',
    label: 'Cart link paste → prompt delete + card updates',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        outMsg([{ t: 'https://swig.gy/gc/9k2LmP', link: true }], { time: '2:40 PM' }),
        inMsg(
          [
            q([BI('✓ Cart link verified', G), C('  ·  '), IT('Group cart resolved live from Swiggy', DIM)]),
            q([B('Order Summary'), C(' · '), BI('Address needed', Y), C('\n'), B(ORDER.restaurant), C('\n'), ...itemsBlock(ORDER.items)]),
            q([B('Cart'), C('\n'), MB('swig.gy/gc/9k2LmP', BL)]),
            [B('Add a valid address link to continue.')],
            [IT('◈ No account allocated; QR is blocked.', DIM)],
          ],
          {
            time: '2:40 PM',
            keyboard: kb([ok('▤ Cart Added · Change'), pri('⌖ Address Link')], [ok('› Send to Beta')], [dgr('× Cancel Draft')]),
          }
        ),
        inMsg([[B('⌖ Delivery address link bhejein')], [IT('Swiggy share-address link (swiggy.onelink.me/JgkQ/...), Google Maps link, ya Telegram • Location pin.', DIM)]], { time: '2:40 PM' }),
      ],
    },
  },
  {
    file: '03-force-reply-cart.png',
    label: 'Force-reply prompt: input focused with placeholder',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: 'https://swiggy.onelink.me/JgkQ/35d', placeholder: 'Paste Swiggy address link or send Location...' },
      fromTop: true,
      messages: [
        inMsg([q([B('▤ '), B('Swiggy cart link paste karein')]), [LN('https://swig.gy/gc/...'), C('  ya  '), LN('https://www.swiggy.com/restaurants/...')]], { time: '2:41 PM' }),
        outMsg([{ t: 'https://swig.gy/gc/9k2LmP', link: true }], { time: '2:41 PM' }),
        inMsg(
          [
            q([B('⌖ Delivery address link bhejein'), C('\n'), IT('Swiggy share-address link, Google Maps link, ya Telegram • Location pin.', DIM)]),
          ],
          { time: '2:41 PM', keyboard: kb([ok('📍 Send my Location')], [dgr('× Cancel')]) }
        ),
      ],
      toast: { text: 'Reply to this message with your link', y: 1040 },
    },
  },
  {
    file: '04-duplicate-order-alert.png',
    label: 'Second order attempt while one is active + toast',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('● '), B('Order #4821 is live'), C('  ·  '), BI('BILL_READY', BL)]),
            q([B('Delivering to'), C('\n'), B(ORDER.addrName), C(' · '), MB(ORDER.addrPhone, BL), C('\n'), IT(ORDER.addr, DIM)]),
            q([B('Bill Summary'), C('\n'), B('To Pay: ₹534'), C('  ·  '), IT('Approve pending', Y)]),
            [B('! Aapka ek order pehle se chal raha hai (#4821)!')],
            [C('Jab tak purana order delivered ya cancel nahi hota, naya order nahi bhej sakte.')],
          ],
          { time: '2:42 PM', keyboard: kb([dgr('Cancel Current Order #4821')], [pri('Refresh Status'), pri('◷ Track Live Order')]) }
        ),
      ],
      toast: { text: '! Pehle wala order complete hone do', y: 120 },
    },
  },
  {
    file: '05-address-unresolved.png',
    label: 'Address link expired → asks for fresh link/pin',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        outMsg([{ t: 'https://swiggy.onelink.me/JgkQ/7xP2', link: true }], { time: '2:43 PM' }),
        inMsg(
          [
            q([C('× ', R), B('Address link resolve nahi hua.', R)]),
            q([B('Swiggy Response'), C('\n'), IT('This one-time link expired (24h) — shared address is no longer available.', DIM)]),
            [C('Naya address link bhejein, ya Telegram • '), B('Location'), C(' pin bhejein.')],
            q([B('Delivering To'), C('\n'), IT('Address not verified — main chat text ko address nahi maanta.', DIM)]),
          ],
          { time: '2:43 PM', keyboard: kb([ok('● Paste Address Link')], [pri('📍 Send Location Pin'), dgr('× Cancel Draft')]) }
        ),
      ],
    },
  },
  {
    file: '06-missing-cart-only.png',
    label: 'Send to Beta with missing data → only asks for the missing link',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Paste Swiggy cart link here...' },
      fromTop: true,
      messages: [
        outMsg([B('› Send to Beta')], { time: '2:44 PM' }),
        inMsg(
          [
            q([C('! ', Y), B('Cart missing', Y)]),
            [C('Address to ✓ mil gaya, par cart link nahi mila.')],
            q([B('Delivering To'), C('\n'), B(ORDER.addrName), C(' · '), MB(ORDER.addrPhone, BL), C('\n'), IT(ORDER.addr, DIM)]),
            [IT('Purana card delete kar diya — ab sirf cart link chahiye.', DIM)],
          ],
          { time: '2:44 PM', keyboard: kb([ok('▤ Paste Cart Link')], [dgr('× Cancel')]) }
        ),
      ],
    },
  },
  {
    file: '07-empty-cart-block.png',
    label: 'Tracking link pasted as cart → ₹0 empty order blocked',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        outMsg([{ t: 'https://www.swiggy.com/orders/8301745529', link: true }], { time: '2:45 PM' }),
        inMsg(
          [
            q([C('✕ ', R), B('Cart khali hai — order nahi ban sakta', R)]),
            q([B('Kya mila'), C('\n'), IT('Yeh tracking/order link hai, cart link nahi. Order id: 8301745529', DIM)]),
            [C('Sahi Swiggy cart link bhejein ('), LN('https://swig.gy/gc/...', { color: BL }), C(') — tracking link se order nahi banta.')],
          ],
          { time: '2:45 PM', keyboard: kb([ok('▤ Cart Link Paste Karein')], [pri('🔗 Ye Order Track Karo'), dgr('× Close')]) }
        ),
      ],
    },
  },
  {
    file: '08-recipient-mobile-required.png',
    label: 'Recipient 10-digit number required (force reply)',
    spec: {
      mode: 'dark',
      header: HD,
      input: { typing: '+91 98765 43210', placeholder: 'Enter 10 digit mobile number...' },
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('☎ Recipient mobile number required')]),
            [C('Is order ko receive karne wale ka sahi 10-digit Indian number bhejein (+91 optional).')],
            q([B('Kyun zaroori hai'), C('\n'), IT('Swiggy account ka number ya purana saved contact kabhi substitute nahi hota — rider isi number par call karega.', DIM)]),
            q([B('Detected from address link'), C('\n'), B(ORDER.addrName), C('  ·  '), IT('mobile not present in share payload', R)]),
          ],
          { time: '2:46 PM', keyboard: kb([ok('📱 Share My Contact'), pri('↻ Re-check Address Link')], [dgr('× Cancel Order')]) }
        ),
      ],
    },
  },
  {
    file: '09-scan-progress.png',
    label: 'Send to Beta → best account scan in progress',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        outMsg([B('› Send to Beta')], { time: '2:47 PM' }),
        inMsg(
          [
            q([B('◷ Order #4821 received'), C('  ·  '), IT('scanning 6 logged-in Swiggy IDs', DIM)]),
            rows(
              [
                ['Ego tio · 8873415879', BI('no coupon', DIM)],
                ['Panu one · 8127861271', BI('−₹99 / ₹149', DIM)],
                ['Panu fab · 7488934840', BI('−₹120 / ₹174', DIM)],
                [B('Rahul Kumar · 7058813196'), BI('−₹284 · FREE DEL', G)],
              ],
              { bg: 'rgba(0,0,0,0.16)', size: 13 }
            ),
            [IT('Bill lock hote hi yahi card update hoga — 2 alag message nahi.', DIM)],
          ],
          { time: '2:47 PM', keyboard: kb([pri('⏸ Cancel'), pri('◷ Refresh')]) }
        ),
      ],
    },
  },
  {
    file: '10-bill-ready-approve.png',
    label: 'Max-discount bill locked → Approve / Something is wrong',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('✓ '), B('Order #4821 — Bill Locked'), C('  ·  '), BI('BEST OFFER', G)]),
            q([B('Auto offers'), C('\n'), BI('✓ Best account + max coupon locked ', G), C('(Rahul Kumar · 7058813196)')]),
            q([B('Order Summary'), C('\n'), B(ORDER.restaurant), C('\n'), ...itemsBlock(ORDER.items)]),
            q([B('Delivering To'), C('\n'), B(ORDER.addrName), C(' · '), MB(ORDER.addrPhone, BL), C('\n'), IT(ORDER.addr, DIM)]),
            {
              t: 'rows',
              title: 'Final Bill',
              bg: 'rgba(0,0,0,0.18)',
              size: 13.4,
              rows: billRows(ORDER),
            },
            q([B('Next Step'), C('\n'), IT('Bill check karke Approve karein — approve karte hi official Swiggy payment QR/link aayega.', DIM)]),
          ],
          {
            time: '2:48 PM',
            keyboard: kb([ok('✓ Approve bill'), dgr('! Something is wrong')], [pri('↻ Recompute with other account')]),
          }
        ),
      ],
    },
  },
  {
    file: '11-bill-table.png',
    label: 'Bill summary as readable rows (coupon + free cash + free delivery)',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('₹ Final bill'), C(' · '), IT('Order #4821 · Biryani by Nasir', DIM)]),
            rows(
              [
                ['Items Total', '₹608'],
                [`Coupon ${ORDER.coupon}`, BI('−₹150', G)],
                ['Swiggy Money / Free Cash', BI('−₹50', G)],
                ['Swiggy One Lite Membership', C('+₹19', Y)],
                ['Free Delivery upto 7km', BI('FREE (₹45 saved)', G)],
                ['Packing Charges', '₹40'],
                ['GST & Other Charges', '₹96'],
                [B('Total Savings'), BI('₹284', G)],
                [B('To Pay'), B('₹534', Y)],
              ],
              { bg: 'rgba(0,0,0,0.18)', size: 13.4 }
            ),
            [IT('Pay via UPI QR, Card, or Wallet on Swiggy', DIM)],
            [IT('Kuch galat lage to [ ! Something is wrong ] dabayein — bill dobara ban jayega.', DIM)],
          ],
          { time: '2:48 PM', keyboard: kb([ok('✓ Approve bill'), dgr('! Something is wrong')]) }
        ),
      ],
    },
  },
  {
    file: '12-payment-processing.png',
    label: 'QR not ready yet → honest processing card (no fake QR)',
    spec: {
      mode: 'dark',
      header: HD,
      input: { placeholder: 'Message' },
      fromTop: true,
      messages: [
        inMsg(
          [
            q([B('◷ Swiggy Payment Link / QR Processing (Order #4821)')]),
            [C('Beta aapka cart Swiggy par open karke maximum discount & coupons verify kar raha hai.')],
            [C('Swiggy payment page se authentic link/QR aate hi yahan turant bhej diya jayega.')],
            q([B('Live status'), C('\n'), B('Cart: '), BI('✓ resolved', G), C('   '), B('Coupon: '), BI('✓ FESTIVE150 applied', G), C('\n'), B('QR: '), C('waiting for Swiggy…', Y)]),
            [IT('Koi manual/UPI-copy QR nahi bheja jayega jab tak Swiggy ka genuine link na mile.', DIM)],
          ],
          { time: '2:49 PM', keyboard: kb([pri('○ Refresh Status'), url('💳 Open Swiggy Payments')], [url('✉ Contact Support')]) }
        ),
      ],
    },
  },
];
