// ============================================================================
// v50 — NO FAKE "INCOGNITO / AUTO DELETE" CLAIMS, ORDER HISTORY IS KEPT
// ----------------------------------------------------------------------------
// The order card used to print two lines that were never implemented:
//
//   🕶 Incognito: ON — order disappears from order history after 3 hrs
//   Auto Delete: ON — all saved addresses auto-deleted after order
//
// Nothing in the bot purges `db.orders` on a timer, and saved addresses are
// never auto-deleted. Those lines only made customers believe their order
// history was about to vanish. The card must show the delivery address and
// nothing else, and history must stay exactly as it works today.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';
process.env.WAF_KEEPWARM = 'false';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

globalThis.fetch = async (u) => {
  const url = String(u);
  const body = { statusCode: 0, data: { orders: [] } };
  return {
    ok: true, status: 200, url,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
};

const { formatUserOrderCardText, bot } = await import('./index.js');
const { getDb, mutateDb, upsertOrder } = await import('./store.js');

const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  return { message_id: apiLog.length, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' }, text: payload.text || '' };
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const ORDER_ID = 'ORD_V50_KEEP';
const USER_ID = 7270001;

mutateDb((d) => {
  d.orders = d.orders || {};
  d.drafts = d.drafts || {};
  d.config.accounts = {
    acc_v50: { account: 'acc_v50', name: 'Ammi', phone: '9000000999', isLoggedIn: true, cookies: '_session_tid=x', tid: 'x' }
  };
  d.orders[ORDER_ID] = {
    id: ORDER_ID,
    userId: USER_ID,
    userName: 'Ammi',
    type: 'SWIGGY_ORDER',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    selectedAccount: 'acc_v50',
    orderAccount: '9000000999',
    restaurantName: 'Mouj Mela',
    items: [{ name: 'Paneer Butter Masala', qty: 2, price: 210, lineTotal: 420 }],
    itemTotal: 420,
    subtotal: 420,
    finalPayable: 468,
    swiggyOrderId: '251838950110925',
    address: 'Flat 4, Gomti Nagar, Lucknow 226010',
    addressDetails: {
      name: 'AMMI', mobile: '9876543210', city: 'Lucknow', area: 'Gomti Nagar',
      address: 'Flat 4, Gomti Nagar, Lucknow 226010', lat: '26.8523', lng: '80.9462'
    },
    // Well past the "3 hours" the old card used to threaten.
    createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 29 * 60 * 60 * 1000).toISOString()
  };
});

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: the card makes no incognito / auto-delete claim ---');
{
  const customerText = formatUserOrderCardText(getDb().orders[ORDER_ID], false);
  const bossText = formatUserOrderCardText(getDb().orders[ORDER_ID], true);

  for (const [label, text] of [['customer', customerText], ['boss', bossText]]) {
    check(`${label} card has no "Incognito: ON"`, !/incognito/i.test(text));
    check(`${label} card has no "Auto Delete: ON"`, !/auto\s*delete/i.test(text));
    check(`${label} card has no "disappears ... 3 hrs" promise`, !/disappear|3\s*hrs/i.test(text));
  }
}

console.log('\n--- Scenario 2: the rest of the card is unchanged ---');
{
  const text = formatUserOrderCardText(getDb().orders[ORDER_ID], true);
  check('delivery address block still renders', /Delivering To/i.test(text));
  check('recipient mobile still renders', /9876543210/.test(text));
  check('street address still renders', /Gomti Nagar/.test(text));
  check('items still render', /Paneer Butter Masala/.test(text));
  check('bill total still renders', /468/.test(text));
  check('order account still shows on the boss card only', /9000000999/.test(text));
  const customer = formatUserOrderCardText(getDb().orders[ORDER_ID], false);
  check('customer card does NOT leak the order account number', !/9000000999/.test(customer));
}

console.log('\n--- Scenario 3: a 30-hour-old order is still in history ---');
{
  const before = Boolean(getDb().orders?.[ORDER_ID]);
  formatUserOrderCardText(getDb().orders[ORDER_ID], false);
  formatUserOrderCardText(getDb().orders[ORDER_ID], true);
  const after = Boolean(getDb().orders?.[ORDER_ID]);
  check('the order existed before the card render', before);
  check('the order is still stored after the card render', after);
  check('its createdAt was not rewritten', /T/.test(String(getDb().orders[ORDER_ID].createdAt)));
  check('its address was not auto-deleted', Boolean(getDb().orders[ORDER_ID].addressDetails?.address));
}

console.log('\n--- Scenario 4: nothing purges orders on a timer ---');
{
  const src = fs.readFileSync('index.js', 'utf8');
  const store = fs.readFileSync('store.js', 'utf8');
  check('no incognito string is left in the source', !/Incognito: ON/i.test(src));
  check('no auto-delete string is left in the source', !/Auto Delete: ON/i.test(src));
  check('no "3 hrs" history promise is left', !/after 3 hrs/i.test(src));
  check('store exposes no timer-based order purge', !/setInterval\([^)]*delete\s+db\.orders/.test(store));
  check('order deletion happens only through explicit calls',
    /delete db\.orders\[orderId\]/.test(store) && !/expireAt|purgeAt|deleteAfter/i.test(store));
  check('Orders Done reads completed orders with no age window',
    !/dbCompletedOrders\s*=\s*[^\n]*filter\([^\n]*(days|hours|hrs|age)/i.test(src));
}

console.log('\n--- Scenario 5: the address lines survive a re-render round trip ---');
{
  upsertOrder(ORDER_ID, { updatedAt: new Date().toISOString() });
  const text = formatUserOrderCardText(getDb().orders[ORDER_ID], false);
  check('re-render still shows the address', /Gomti Nagar/.test(text));
  check('re-render still shows no incognito claim', !/incognito|auto\s*delete/i.test(text));
  check('the record survived the upsert', Boolean(getDb().orders?.[ORDER_ID]));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
