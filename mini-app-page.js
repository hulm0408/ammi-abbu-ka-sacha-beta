// mini-app-page.js
// Mini app ka UI (single page, koi build step nahi). Dynamic data hamesha
// `textContent` se lagti hai — HTML injection ka rasta hi nahi.
//
// Boss (30-10-2026): "ID choose karne ka option… free cash icon… offer active
// hai ya nahi… OPEN MINI APP button direct cart page par le jaye."

export function renderMiniAppHtml({ token }) {
  const safeToken = JSON.stringify(String(token || ''));
  return `<!doctype html>
<html lang="hi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>Order Mini App</title>
<style>
  :root{--bg:#0b1120;--card:#151f33;--line:#25324a;--txt:#f1f5f9;--muted:#94a3b8;--brand:#fc8019;--ok:#34d399;--warn:#fbbf24;--bad:#f87171}
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
  body{background:var(--bg);color:var(--txt);min-height:100vh;padding:12px 12px 96px}
  .wrap{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px}
  h1{font-size:17px;font-weight:800;letter-spacing:.2px}
  .sub{color:var(--muted);font-size:12.5px;margin-top:4px;line-height:1.45}
  .step{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px}
  .step b{width:20px;height:20px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:11px}
  .row{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;background:#101a2c;cursor:pointer}
  .row.on{border-color:var(--brand);background:rgba(252,128,25,.12)}
  .row.off{opacity:.45;cursor:not-allowed}
  .row .main{flex:1;min-width:0}
  .row .phone{font-weight:800;font-size:14px}
  .row .why{color:var(--muted);font-size:12px;margin-top:3px;line-height:1.35}
  .row .icons{font-size:15px;white-space:nowrap}
  .tag{display:inline-block;font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;margin-left:6px;vertical-align:middle}
  .tag.ready{background:rgba(52,211,153,.16);color:var(--ok)}
  .tag.used{background:rgba(148,163,184,.18);color:var(--muted)}
  .tag.bad{background:rgba(248,113,113,.16);color:var(--bad)}
  .tag.warn{background:rgba(251,191,36,.16);color:var(--warn)}
  input,textarea,select{width:100%;background:#0d1626;border:1px solid var(--line);color:var(--txt);border-radius:12px;padding:12px;font-size:14px;outline:none}
  input:focus,textarea:focus{border-color:var(--brand)}
  textarea{min-height:72px;resize:vertical}
  button{border:none;border-radius:12px;padding:13px 16px;font-size:14.5px;font-weight:800;background:var(--brand);color:#fff;width:100%}
  button.ghost{background:#1d2a44;color:var(--txt)}
  button:disabled{opacity:.45}
  .btnrow{display:flex;gap:8px;margin-top:10px}
  .item{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.13)}
  .item:last-child{border-bottom:none}
  .item .nm{flex:1;font-size:13.5px}
  .item .pr{font-weight:800;font-size:13.5px;color:var(--ok)}
  .qty{display:flex;align-items:center;gap:8px}
  .qty button{width:32px;height:32px;padding:0;border-radius:9px;background:#22304a;font-size:16px}
  .qty span{min-width:18px;text-align:center;font-weight:800;font-size:13px}
  .bar{position:fixed;left:0;right:0;bottom:0;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:rgba(11,17,32,.96);border-top:1px solid var(--line);backdrop-filter:blur(8px)}
  .barin{max-width:560px;margin:0 auto;display:flex;gap:10px;align-items:center}
  .tot{flex:1;font-size:13px;color:var(--muted)}
  .tot b{display:block;font-size:17px;color:#fff}
  .bar button{width:auto;padding:13px 22px}
  .muted{color:var(--muted);font-size:12.5px}
  .ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
  .hide{display:none}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .note{background:#101a2c;border:1px dashed var(--line);border-radius:10px;padding:9px 11px;font-size:12px;color:var(--muted);line-height:1.45}
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>🛍 Apna order khud complete karo</h1>
    <div class="sub" id="hello">ID chuno → address → cart → confirm. Sab kuch yahin.</div>
  </div>

  <!-- STEP 1: ID -->
  <div class="card">
    <div class="step"><b>1</b> Swiggy ID chuno</div>
    <div id="idSummary" class="muted" style="margin-bottom:8px">Load ho raha hai…</div>
    <div id="idList"></div>
    <div class="note" id="idNote">★ = 0 order fresh · ✔ = used · ⛔ = suspend · 🔑 = re-login · 💵 = free cash · 🎁 = offer active · ⏳ = abhi order chal raha hai</div>
  </div>

  <!-- STEP 2: ADDRESS -->
  <div class="card">
    <div class="step"><b>2</b> Address</div>
    <div class="sub" style="margin-bottom:8px">Swiggy app se <b>Share Address</b> ka link paste karo — address khud bhar jayega.</div>
    <textarea id="addrInput" placeholder="https://www.swiggy.com/… ya poora address + phone"></textarea>
    <div class="btnrow">
      <button class="ghost" id="addrBtn">Address check karo</button>
    </div>
    <div id="addrOut" style="margin-top:10px"></div>
  </div>

  <!-- STEP 3: CART -->
  <div class="card">
    <div class="step"><b>3</b> Cart</div>
    <div class="sub" style="margin-bottom:8px">Swiggy app se cart ka link paste karo. Item badalna ho to neeche search karke add/remove karo.</div>
    <textarea id="cartInput" placeholder="https://www.swiggy.com/restaurants/… ya cart text"></textarea>
    <div class="btnrow">
      <button class="ghost" id="cartBtn">Cart check karo</button>
    </div>
    <div id="cartOut" style="margin-top:10px"></div>
    <div id="itemPanel" class="hide" style="margin-top:12px">
      <input id="searchInput" placeholder="Dish search karo (jaise: paneer, biryani)">
      <div class="btnrow"><button class="ghost" id="searchBtn">Search</button></div>
      <div id="searchOut" style="margin-top:10px"></div>
      <div id="itemsOut" style="margin-top:10px"></div>
    </div>
  </div>

  <!-- STEP 4: OFFERS -->
  <div class="card">
    <div class="step"><b>4</b> Offers / Free cash</div>
    <div id="offerOut" class="muted">ID chunne par is account ke offers dikhenge.</div>
  </div>

  <div id="confirmOut"></div>
</div>

<div class="bar">
  <div class="barin">
    <div class="tot">Total<b id="totalTxt">₹0</b></div>
    <button id="confirmBtn">Confirm order</button>
  </div>
</div>

<script>
const TOKEN = ${safeToken};
const $ = (id) => document.getElementById(id);
const state = { ids: [], selected: '', address: null, cart: null, items: [], total: 0 };

function esc(el, text) { el.textContent = text == null ? '' : String(text); }
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = String(text);
  return el;
}

async function api(path, body) {
  const res = await fetch('/api/app/' + path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: 'Server ne jawab nahi diya' }; }
  if (!res.ok && data && !data.error) data.error = 'HTTP ' + res.status;
  return data;
}

function renderIds(payload) {
  state.ids = payload.rows || [];
  state.selected = payload.selectedKey || state.selected || '';
  const list = $('idList');
  list.innerHTML = '';
  if (!state.ids.length) {
    list.appendChild(h('div', 'muted', 'Koi Swiggy ID vault me nahi hai — pehle bot me ID add karo.'));
  }
  for (const row of state.ids) {
    const el = h('div', 'row' + (row.key === state.selected ? ' on' : '') + (row.selectable ? '' : ' off'));
    const main = h('div', 'main');
    const phone = h('div', 'phone', row.phoneMasked);
    const tagCls = row.status === 'READY' ? 'ready' : (row.status === 'USED' ? 'used' : (row.status === 'UNVERIFIED' || row.status === 'BUSY' ? 'warn' : 'bad'));
    const tag = h('span', 'tag ' + tagCls, row.status);
    phone.appendChild(tag);
    main.appendChild(phone);
    main.appendChild(h('div', 'why', row.reason + (row.offers && row.offers.length ? ' · 🎁 ' + row.offers.map(function(o){return o.label;}).join(', ') : '') + (row.freeCash > 0 ? ' · 💵 ₹' + row.freeCash : '')));
    el.appendChild(main);
    el.appendChild(h('div', 'icons', row.icons || ''));
    if (row.selectable) {
      el.addEventListener('click', async () => {
        const out = await api('select', { key: row.key });
        if (!out.ok) { toast(out.error || 'ID select nahi hui', true); return; }
        state.selected = row.key;
        renderIds(await api('state'));
        loadOffers(row.key);
        toast('ID chuni gayi: ' + row.phoneMasked, false);
      });
    } else {
      el.addEventListener('click', () => toast(row.reason || 'Ye ID select nahi ho sakti', true));
    }
    list.appendChild(el);
  }
  $('idSummary').textContent = (payload.readyCount || 0) + ' ready · ' + (payload.usedCount || 0) + ' used · ' + (payload.blockedCount || 0) + ' blocked';
}

function toast(msg, bad) {
  const el = $('confirmOut');
  el.innerHTML = '';
  const card = h('div', 'card');
  card.appendChild(h('div', bad ? 'bad' : 'ok', msg));
  el.appendChild(card);
  setTimeout(() => { if (el.firstChild === card) el.innerHTML = ''; }, 6000);
}

async function loadOffers(key) {
  const out = await api('offers?key=' + encodeURIComponent(key));
  const box = $('offerOut');
  box.innerHTML = '';
  if (!out.ok) { box.appendChild(h('div', 'bad', out.error || 'Offers nahi mile')); return; }
  const head = h('div', '', '🎁 Offers active: ' + (out.active.length ? out.active.map(function(o){return o.emoji + ' ' + o.label;}).join(' · ') : 'koi nahi'));
  box.appendChild(head);
  if (out.preLocked && out.preLocked.length) box.appendChild(h('div', 'warn', '⏳ Pre-locked: ' + out.preLocked.map(function(o){return o.label;}).join(' · ')));
  box.appendChild(h('div', 'muted', '💵 Free cash: ₹' + (out.freeCash || 0) + ' · Orders: ' + (out.orders == null ? 'live check nahi hua' : out.orders)));
}

function renderAddress(out) {
  const box = $('addrOut');
  box.innerHTML = '';
  if (!out.ok) { box.appendChild(h('div', 'bad', out.error || 'Address nahi mila')); return; }
  state.address = out.address;
  const card = h('div', 'note');
  card.appendChild(h('div', '', '📍 ' + (out.address.label || out.address.address || '')));
  card.appendChild(h('div', 'muted', '📞 ' + (out.address.mobile || '—')));
  box.appendChild(card);
}

function renderCart(out) {
  const box = $('cartOut');
  box.innerHTML = '';
  if (!out.ok) { box.appendChild(h('div', 'bad', out.error || 'Cart nahi mila')); return; }
  state.cart = out.cart;
  state.items = out.items || [];
  state.total = out.total || 0;
  box.appendChild(h('div', '', '🏪 ' + (out.cart.restaurantName || 'Restaurant')));
  box.appendChild(h('div', 'muted', (out.cart.restaurantId ? 'ID ' + out.cart.restaurantId + ' · ' : '') + state.items.length + ' item'));
  $('itemPanel').classList.remove('hide');
  renderItems();
  updateTotal();
}

function renderItems() {
  const box = $('itemsOut');
  box.innerHTML = '';
  if (!state.items.length) { box.appendChild(h('div', 'muted', 'Cart khaali — search se item add karo.')); return; }
  state.items.forEach((it, idx) => {
    const row = h('div', 'item');
    row.appendChild(h('div', 'nm', it.name + ' · ₹' + it.price));
    const qty = h('div', 'qty');
    const minus = h('button', '', '−');
    const val = h('span', '', String(it.qty || 1));
    const plus = h('button', '', '+');
    minus.addEventListener('click', () => changeQty(idx, -1));
    plus.addEventListener('click', () => changeQty(idx, +1));
    qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus);
    row.appendChild(qty);
    box.appendChild(row);
  });
}

function changeQty(idx, delta) {
  const it = state.items[idx];
  if (!it) return;
  it.qty = Math.max(0, Number(it.qty || 1) + delta);
  if (it.qty === 0) state.items.splice(idx, 1);
  renderItems();
  updateTotal();
}

function updateTotal() {
  state.total = state.items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.qty || 1), 0);
  $('totalTxt').textContent = '₹' + state.total;
}

function renderSearch(out) {
  const box = $('searchOut');
  box.innerHTML = '';
  if (!out.ok) { box.appendChild(h('div', 'bad', out.error || 'Search fail')); return; }
  if (!out.items.length) { box.appendChild(h('div', 'muted', 'Kuch nahi mila. Dusra naam try karo.')); return; }
  out.items.forEach((it) => {
    const row = h('div', 'item');
    row.appendChild(h('div', 'nm', it.name));
    row.appendChild(h('div', 'pr', '₹' + it.price));
    const add = h('button', '', '+ Add');
    add.style.width = 'auto';
    add.style.padding = '8px 12px';
    add.style.fontSize = '12.5px';
    add.addEventListener('click', () => {
      const existing = state.items.find((x) => String(x.id || '') === String(it.id));
      if (existing) existing.qty = Number(existing.qty || 1) + 1;
      else state.items.push({ id: it.id, name: it.name, price: it.price, qty: 1 });
      renderItems();
      updateTotal();
      toast(it.name + ' add ho gaya', false);
    });
    row.appendChild(add);
    box.appendChild(row);
  });
}

$('addrBtn').addEventListener('click', async () => {
  const text = $('addrInput').value.trim();
  if (!text) { toast('Pehle address link ya address paste karo', true); return; }
  $('addrBtn').textContent = 'Check ho raha hai…';
  const out = await api('address', { text });
  $('addrBtn').textContent = 'Address check karo';
  renderAddress(out);
});

$('cartBtn').addEventListener('click', async () => {
  const text = $('cartInput').value.trim();
  if (!text) { toast('Pehle cart link paste karo', true); return; }
  $('cartBtn').textContent = 'Check ho raha hai…';
  const out = await api('cart', { text });
  $('cartBtn').textContent = 'Cart check karo';
  renderCart(out);
});

$('searchBtn').addEventListener('click', async () => {
  const q = $('searchInput').value.trim();
  $('searchBtn').textContent = 'Search…';
  const out = await api('search', { q });
  $('searchBtn').textContent = 'Search';
  renderSearch(out);
});

$('confirmBtn').addEventListener('click', async () => {
  if (!state.selected) { toast('Pehle ID chuno', true); return; }
  if (!state.address) { toast('Pehle address check karo', true); return; }
  if (!state.items.length) { toast('Cart me kam se kam ek item chahiye', true); return; }
  $('confirmBtn').disabled = true;
  $('confirmBtn').textContent = 'Confirm ho raha hai…';
  const out = await api('confirm', { items: state.items });
  $('confirmBtn').disabled = false;
  $('confirmBtn').textContent = 'Confirm order';
  const box = $('confirmOut');
  box.innerHTML = '';
  const card = h('div', 'card');
  if (out.ok) {
    card.appendChild(h('div', 'ok', '✅ Order ban gaya — bill Telegram par bheja gaya hai.'));
    card.appendChild(h('div', 'muted', 'Order #' + out.orderId + ' · ₹' + (out.total || 0)));
    if (out.billUrl) {
      const a = h('a', '', '↗ Telegram me bill kholo');
      a.href = out.billUrl;
      a.style.color = '#fc8019';
      a.style.display = 'block';
      a.style.marginTop = '8px';
      card.appendChild(a);
    }
  } else {
    card.appendChild(h('div', 'bad', out.error || 'Confirm nahi hua'));
    if (out.code) card.appendChild(h('div', 'muted', 'Code: ' + out.code));
  }
  box.appendChild(card);
});

(async function boot() {
  const out = await api('state');
  if (!out.ok) {
    $('hello').textContent = out.error || 'Mini app link valid nahi hai — bot se naya button lo.';
    $('idSummary').textContent = '';
    return;
  }
  if (out.user && out.user.name) $('hello').textContent = 'Namaste ' + out.user.name + ' — ID chuno aur order complete karo.';
  renderIds(out);
  if (out.selectedKey) loadOffers(out.selectedKey);
  if (out.addressText) $('addrInput').value = out.addressText;
  if (out.cartText) $('cartInput').value = out.cartText;
  if (out.items && out.items.length) {
    state.items = out.items;
    $('itemPanel').classList.remove('hide');
    renderItems(); updateTotal();
  }
})();
</script>
</body>
</html>`;
}
