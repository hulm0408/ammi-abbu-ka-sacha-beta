// Shared design helpers for all mockups
const B = (t) => ({ t, b: true });
const C = (t, c, extra = {}) => ({ t, color: c, ...extra });
const BI = (t, c) => ({ t, b: true, color: c });
const IT = (t, c) => ({ t, i: true, color: c || '#8fa2b5' });
const LN = (t, u) => ({ t, link: true, ...(u || {}) });
const M = (t, c) => ({ t, m: true, ...(c ? { color: c } : {}) });
const MB = (t, c) => ({ t, m: true, b: true, ...(c ? { color: c } : {}) });
const run = (...xs) => (Array.isArray(xs[0]) ? xs[0] : xs);

const G = '#8fd694'; // green ok
const R = '#f28b82'; // red
const Y = '#ffd27d'; // amber
const BL = '#7fb2e0'; // blue
const DIM = '#8fa2b5';
const OR = '#ffb454';

const q = (text, o = {}) => ({ t: 'q', text: run(text), ...o });
const hr = () => ({ t: 'hr' });
const rows = (r, o = {}) => ({ t: 'rows', rows: r, ...o });
const map = (o = {}) => ({ t: 'map', ...o });
const qr = (text, size = 190, o = {}) => ({ t: 'qr', qrText: text, size, ...o });
const img = (id, o = {}) => ({ t: 'img', id, ...o });

// inline keyboard builders
const kb = (...rowsIn) =>
  rowsIn.map((r) =>
    (Array.isArray(r) ? r : [r]).map((x) => (typeof x === 'string' ? { t: x } : x))
  );
const pri = (t) => ({ t });
const ok = (t) => ({ t, style: 'success' });
const dgr = (t) => ({ t, style: 'danger' });
const gold = (t) => ({ t, style: 'gold' });
const url = (t) => ({ t, url: true });

const botHeader = (o = {}) => ({
  title: 'ORDER PLACER',
  subtitle: 'bot · @ammiabbu_beta',
  avatarEmoji: '🛵',
  avatarBg: '#ff9f0a',
  search: true,
  time: '2:40',
  ...o,
});
const bossHeader = (o = {}) => ({
  title: 'Swiggy World Bot',
  subtitle: 'bot · @swiggy_world_beta',
  avatarEmoji: '🤖',
  avatarBg: '#e0574a',
  search: true,
  time: '2:40',
  ...o,
});

const inMsg = (body, o = {}) => ({ body: Array.isArray(body) ? body : [body], ...o });
const outMsg = (body, o = {}) => ({ body: Array.isArray(body) ? body : [body], out: true, read: 2, ...o });

// bill table rendered as mono-ish rows
const billRows = (o) => {
  const r = [];
  r.push(['Items Total', `₹${o.items}`]);
  if (o.disc) r.push([`Coupon ${o.coupon}`, `−₹${o.disc}`]);
  if (o.fc) r.push(['Swiggy Money / Free Cash', `−₹${o.fc}`]);
  if (o.oneFee) r.push(['Swiggy One Lite Membership', `+₹${o.oneFee}`]);
  r.push(['Delivery Fee', o.freeDel ? `FREE${o.delSaved ? ` (₹${o.delSaved} saved)` : ''}` : `₹${o.del}`]);
  if (o.packing) r.push(['Packing Charges', `₹${o.packing}`]);
  if (o.gst) r.push(['GST & Other Charges', `₹${o.gst}`]);
  if (o.saved) r.push(['Total Savings', BI(`₹${o.saved}`, G)]);
  r.push([B('Final Total'), B(`₹${o.pay}`, Y)]);
  return r;
};

const itemsBlock = (items) =>
  items.map((it, i) => [C(`${i + 1}. `, DIM), B(it.n), C(`  ·  Qty: ${it.q}  ·  ₹${it.p}`, DIM)]);

const ORDER = {
  id: '4821',
  swiggyId: '8301745529',
  restaurant: 'Biryani by Nasir, Hazratganj',
  items: [
    { n: 'Chicken Dum Biryani', q: 1, p: 329 },
    { n: 'Butter Naan', q: 2, p: 65 },
    { n: 'Gulab Jamun (2 pc)', q: 1, p: 149 },
  ],
  itemTot: 608,
  disc: 150,
  coupon: 'FESTIVE150',
  fc: 50,
  del: 45,
  delSaved: 45,
  freeDel: true,
  packing: 40,
  gst: 96,
  oneFee: 19,
  saved: 284,
  pay: 534,
  otp: '6214',
  rider: 'Imran Ansari',
  riderPhone: '99050 11234',
  addr: 'Al Noor Informations, Ground Floor, Hazratganj, Lucknow - 226007',
  addrName: 'Ammi Bi',
  addrPhone: '98765 43210',
  acc: '7058813196',
  track: 'https://r.swiggy.com/s/8301745529',
  upi: 'upi://pay?pa=9000012345@ybl&pn=Swiggy&am=534&cu=INR&tn=Swiggy_Order_4821',
};
const ORDER2 = {
  id: '4817',
  swiggyId: '8301699014',
  restaurant: 'Kanpur Kittan Chowk, Alambagh',
  items: [
    { n: 'Thandai 500ml', q: 1, p: 120 },
    { n: 'Aloo Paratha (2 pc)', q: 2, p: 165 },
  ],
  itemTot: 450,
  disc: 50,
  coupon: 'BREAKFAST50',
  fc: 0,
  del: 0,
  freeDel: true,
  packing: 30,
  gst: 44,
  saved: 95,
  pay: 174,
  otp: '4471',
  rider: 'Sonu',
  riderPhone: '88077 44120',
  addr: 'Al Noor Informations, Ground Floor, Lucknow - 226007',
  addrName: 'Abbu Ji',
  addrPhone: '91234 56780',
  acc: '7488934840',
  track: 'https://r.swiggy.com/s/8301699014',
};

const ACCS = [
  ['ego_tio', 'Ego tio', '8873415879'],
  ['ego_fari', 'Ego fari', '12121145'],
  ['ego_thiri', 'Ego thiri', '7006552398'],
  ['panu_one', 'Panu one', '8127861271'],
  ['panu_fab', 'Panu fab', '7488934840'],
  ['rahul', 'Rahul Kumar', '7058813196'],
];

module.exports = {
  B, C, BI, IT, LN, M, MB, run, q, hr, rows, map, qr, img, kb, pri, ok, dgr, gold, url,
  botHeader, bossHeader, inMsg, outMsg, billRows, itemsBlock,
  G, R, Y, BL, DIM, OR,
  ORDER, ORDER2, ACCS,
};
