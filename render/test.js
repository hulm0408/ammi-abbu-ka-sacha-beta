const path = require('path');
const L = require('./lib');

async function main() {
  await L.preloadWallpaper();
  const spec = {
    mode: 'dark',
    header: { title: 'ORDER PLACER', subtitle: 'bot · @ammiabbu_beta · last seen recently', avatarEmoji: '🛵', avatarBg: '#ff9f0a', search: true },
    pin: '★ MAX COUPON WINNER ACCOUNT LOCKED! (Order #4821)',
    input: { placeholder: 'Message' },
    messages: [
      {
        date: 'Today',
        time: '2:39 PM',
        body: [
          [{ t: '→ ', b: true, color: '#ffb454' }, { t: 'Welcome to Swiggy Slot Bot!', b: true }],
          [{ t: 'Swiggy order ke liye apna ' }, { t: 'Cart link', b: true }, { t: ' aur ' }, { t: 'Delivery Address link', b: true }, { t: ' share karein:' }],
          [{ t: '› Pehle Cart link bhejein ya Address link, fir [ › Send to Beta ] daba dein!', b: true, color: '#9fd08f' }],
        ],
        keyboard: [[{ t: '● Paste Cart Link' }], [{ t: '● Paste Address Link' }], [{ t: '› Send to Beta', style: 'success' }]],
      },
      { out: true, time: '2:40 PM', read: 2, body: [{ t: 'https://swig.gy/gc/9k2LmP', link: true }] },
      {
        time: '2:41 PM',
        body: [
          { t: 'q', text: [{ t: '📦 Order Slots', b: true }, '\n', { t: 'Available: 7/10', b: true }, { t: ' · ', color: '#8fa2b5' }, { t: 'Order for your parents — delivered to their name & phone', i: true, color: '#8fa2b5' }] },
          { t: 'q', text: [{ t: 'Order Summary', b: true }, '\n', { t: 'Order #4821 — Summary', b: true }, { t: ' · ' }, { t: 'Ready to validate', b: true, color: '#8fd694' }, '\n', { t: '🛒 ' }, { t: 'Biryani by Nasir, Hazratganj', b: true }, { t: ' (3 items · ₹608)' }] },
          { t: 'q', text: [{ t: '🛒 Swiggy Order', b: true }, '\n', { t: 'Cart: ', b: true }, { t: '✓ Added', color: '#8fd694' }, '\n', { t: 'Delivery: ', b: true }, { t: '✓ Added', color: '#8fd694' }] },
          [{ t: 'Dono links verified hain! 🎉', b: true, color: '#8fd694' }],
          [{ t: 'Niche [ › Send to Beta ] dabayein:', i: true, color: '#8fa2b5' }],
        ],
        keyboard: [
          [{ t: '▤ Change Cart Link' }, { t: '⌖ Change Address Link' }],
          [{ t: '› Send to Beta', style: 'success' }],
          [{ t: '× Cancel order', style: 'danger' }, { t: '↻ Previous order' }],
        ],
      },
      {
        time: '2:44 PM',
        body: [
          { t: 'q', text: [{ t: '● Official Swiggy Payment QR (Order #4821)', b: true }] },
          { t: 'qr', qrText: 'upi://pay?pa=9000012345@ybl&pn=Swiggy&am=534&cu=INR&tn=Swiggy_Order_4821', size: 200 },
          [{ t: '▣ Restaurant: ', }, { t: 'Biryani by Nasir', b: true }],
          [{ t: '₹ Payable on Swiggy: ' }, { t: '₹534', b: true, color: '#ffd27d' }],
          [{ t: 'PhonePe / GPay / Paytm / BHIM se scan karke seedha Swiggy ko pay karein ', i: true, color: '#8fa2b5' }],
        ],
        keyboard: [[{ t: 'Check payment status', style: 'success' }], [{ t: '💳 Pay Link', url: true }]],
      },
    ],
  };
  await L.preloadAssets(spec);
  const buf = await L.renderChat(spec);
  require('fs').writeFileSync('path.join(__dirname, '..', 'images', '_test.png')', buf);
  console.log('written', buf.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
