/* Mini App client. All identity and account selection are verified server-side. */
(() => {
  'use strict';
  const tg = window.Telegram?.WebApp;
  try { tg?.ready(); tg?.expand(); } catch {}
  const initData = tg?.initData || '';
  const state = {
    tab: 'accounts', auth: false, authError: '', authErrorCode: '', connecting: false, user: null, accounts: [], activeAccount: null,
    selectedAddress: null, addresses: [], addressNote: '', pendingAddress: null, contactEdit: false,
    cart: null, checkout: null, checkoutEnabled: false, mode: 'phone', otpSent: false, searchQuery: '', results: null, menu: null,
    orders: null, ordersScope: 'active', order: null, orderTracking: null, busy: false
  };
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const money = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
  const iconPaths = {
    accounts:'<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
    address:'<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    search:'<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 4 4"/>',
    cart:'<path d="M3 4h2l2 11h11l2-8H6"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>',
    orders:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    tools:'<path d="m13 2-8 12h6l-1 8 9-12h-6z"/>',
    link:'<path d="M10 13a5 5 0 0 0 7 .4l2-2a5 5 0 0 0-7-7l-1.2 1.1"/><path d="M14 11a5 5 0 0 0-7-.4l-2 2a5 5 0 0 0 7 7l1.2-1.1"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7 7 0 0 1 12-2l3 5M4 12l3 5a7 7 0 0 0 12-2"/>',
    arrow:'<path d="M5 12h14M14 7l5 5-5 5"/>',
    back:'<path d="M19 12H5M10 7l-5 5 5 5"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    close:'<path d="M18 6 6 18M6 6l12 12"/>',
    trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    store:'<path d="M4 10v10h16V10M3 8l2-5h14l2 5-2 3-3-2-4 2-4-2-3 2zM9 20v-6h6v6"/>',
    moon:'<path d="M20.7 14a8 8 0 0 1-10.7-10.7A8.5 8.5 0 1 0 20.7 14Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
    receipt:'<path d="M5 3h14v18l-2-1-2 1-3-1-3 1-2-1-2 1zM8 8h8M8 12h8M8 16h5"/>',
    userplus:'<path d="M16 21a7 7 0 0 0-14 0"/><circle cx="9" cy="8" r="4"/><path d="M19 8v6M16 11h6"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
  const tile = (name, green = false) => `<span class="icon-tile${green ? ' green' : ''}">${icon(name)}</span>`;
  const cartLocked = () => Boolean(state.checkout && state.checkout.status !== 'PAID');
  const head = (eyebrow, title, sub, end = '') => `<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>${end}</div>`;
  const empty = (symbol, title, text) => `<div class="empty"><div class="large-icon">${icon(symbol)}</div><strong>${esc(title)}</strong>${esc(text)}</div>`;
  const toast = message => {
    const el = $('#toast'); el.textContent = message; el.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4300);
  };
  // Browser confirm() can be blocked in Telegram WebViews. Keep every consent
  // inside the Mini App, preserve the full recipient/amount text, and default
  // to cancellation on dismissal. Only one prompt can be open at a time.
  let confirmationOpen = false;
  function confirmInApp({ title, message, confirmText = 'Continue', danger = false }) {
    if (confirmationOpen) return Promise.resolve(false);
    confirmationOpen = true;
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      const dialog = document.createElement('section');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      dialog.setAttribute('aria-describedby', 'confirm-message');
      const heading = document.createElement('h2');
      heading.id = 'confirm-title';
      heading.textContent = title;
      const body = document.createElement('p');
      body.id = 'confirm-message';
      body.className = 'confirm-message';
      body.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'confirm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'button soft'; cancel.textContent = 'Cancel';
      const confirm = document.createElement('button');
      confirm.type = 'button'; confirm.className = `button ${danger ? 'danger' : 'primary'}`; confirm.textContent = confirmText;
      actions.append(cancel, confirm);
      dialog.append(heading, body, actions);
      overlay.append(dialog);
      let settled = false;
      const finish = approved => {
        if (settled) return;
        settled = true;
        confirmationOpen = false;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
          try { previousFocus.focus({ preventScroll: true }); } catch { previousFocus.focus(); }
        }
        resolve(approved);
      };
      const onKeyDown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        if (event.key === 'Tab') {
          if (event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
          else if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
        }
      };
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
      document.addEventListener('keydown', onKeyDown);
      document.body.append(overlay);
      cancel.focus();
    });
  }
  async function api(path, method = 'GET', body) {
    if (!initData) throw new Error('Open the Mini App from your bot in Telegram.');
    const headers = { 'X-Telegram-Init-Data': initData };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch('/pro/api/' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const e = new Error(result.error || 'Request failed. Please try again.');
      e.status = response.status; e.code = String(result.code || ''); throw e;
    }
    return result;
  }
  function merge(data) {
    for (const key of ['user','accounts','activeAccount','selectedAddress','cart','checkout','checkoutEnabled']) if (Object.hasOwn(data, key)) state[key] = data[key];
  }
  async function run(task, button) {
    if (state.busy) return;
    state.busy = true;
    if (button) button.disabled = true;
    try { await task(); } catch (e) {
      if (['PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED'].includes(e?.code)) {
        state.auth = false; state.authError = e.message; state.authErrorCode = e.code; render();
      } else toast(e.message || 'Something went wrong.');
    } finally { state.busy = false; if (button?.isConnected) button.disabled = false; }
  }
  function openExternal(url) {
    if (tg?.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
  function field(label, name, placeholder, value = '', extra = '') {
    return `<label class="field"><span class="field-label">${esc(label)}</span><span class="input-wrap"><input name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${extra}></span></label>`;
  }
  function addressLabel(a) { return a?.annotation || 'Delivery address'; }
  function renderNav() {
    const tabs = [['accounts','Accounts'],['address','Address'],['search','Search'],['cart','Cart'],['orders','Orders'],['tools','Tools']];
    $('#bottom-nav').innerHTML = tabs.map(([id, label]) => `<button type="button" data-action="nav" data-tab="${id}" class="${state.tab === id ? 'selected' : ''}" ${state.tab === id ? 'aria-current="page"' : ''} ${state.auth ? '' : 'disabled'}>${icon(id)}<span>${label}</span></button>`).join('');
    const chip = $('#account-chip');
    chip.textContent = state.auth ? (state.activeAccount?.phone ? `+91 ${state.activeAccount.phone}` : 'Select account') : 'Not connected';
    chip.disabled = !state.auth;
    const cart = state.auth ? state.cart : null;
    const quantity = cart?.items?.reduce((n, i) => n + Number(i.qty || 0), 0) || 0;
    $('#cart-dock').innerHTML = cart && quantity && state.tab !== 'cart' ? `<button type="button" class="cart-dock" data-action="nav" data-tab="cart"><span class="dock-icon">${icon('cart')}</span><span class="dock-copy"><strong>${quantity} item${quantity === 1 ? '' : 's'} · ${esc(cart.restaurantName)}</strong><small>${cart.quote ? `Swiggy bill ${money(cart.quote.total)}` : 'Bill not checked yet'}</small></span><span class="dock-cta">View cart →</span></button>` : '';
  }
  function renderAccounts() {
    const intro = head('YOUR SPACE', 'Accounts', 'Add a Swiggy account to start ordering.');
    const lockedNotice = cartLocked() ? '<div class="warning">Checkout is pending or unknown. Account switching is locked; only the original account can be reconnected.</div>' : '';
    const controls = state.mode === 'phone'
      ? `<form data-form="${state.otpSent ? 'verify-otp' : 'send-otp'}">${state.otpSent
          ? `${field('OTP from Swiggy', 'otp', 'Enter 6-digit OTP', '', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required')}<p class="hint">The OTP is sent by Swiggy. Don’t share it with anyone else.</p><button class="button primary block" type="submit">Verify & add account ${icon('arrow')}</button><button class="text-button" type="button" data-action="otp-reset">Change mobile number</button>`
          : `<label class="field"><span class="field-label">Mobile number</span><span class="input-wrap"><span class="phone-prefix">+91</span><input name="phone" placeholder="Enter mobile number" inputmode="tel" autocomplete="tel-national" required></span></label><button class="button primary block" type="submit">Send OTP ${icon('arrow')}</button>`}</form>`
      : `<form data-form="import"><label class="field"><span class="field-label">Session JSON</span><span class="input-wrap"><textarea name="session" placeholder='{"mobile":"…", "token":"…", "tid":"…"}' required></textarea></span></label><p class="hint">Only use a session you own. Never send tokens or OTPs in chat.</p><button class="button primary block" type="submit">Login via JSON ${icon('arrow')}</button></form>`;
    // Boss (30-10-2026): har ID ke saamne sach — 0-order / used (kaat diya) /
    // suspend / re-login / busy, plus 💵 free cash aur 🎁 offers.
    const statusPill = (a) => {
      const cls = a.status === 'READY' ? 'green' : (a.status === 'USED' ? 'grey' : (a.status === 'UNVERIFIED' || a.status === 'BUSY' ? 'amber' : 'red'));
      return `<span class="pill ${cls}">${esc(a.status || '—')}</span>`;
    };
    const accounts = state.accounts.length ? state.accounts.map(a => {
      const blocked = a.selectable === false;
      const extras = [a.freeCash > 0 ? `💵 ₹${esc(a.freeCash)}` : '', (a.offers && a.offers.length) ? '🎁 ' + esc(a.offers.map(o => o.label).join(', ')) : ''].filter(Boolean).join(' · ');
      return `<div class="account-row ${a.active ? 'active' : ''} ${blocked ? 'is-blocked' : ''}"${blocked ? ' style="opacity:.55"' : ''}>${tile('accounts', true)}<div class="row-content"><strong>${esc(a.name)} ${a.icons ? esc(a.icons) : ''}${a.active ? '' : ' ' + statusPill(a)}</strong><p>${a.phone ? '+91 ' + esc(a.phone) : 'Number not returned'}${a.reason ? ' · ' + esc(a.reason) : ''}</p>${extras ? `<p>${extras}</p>` : ''}</div><div class="row-actions">${a.active ? '<span class="pill green">Active</span>' : blocked ? '<span class="pill grey">Not available</span>' : `<button class="button mini outline" data-action="account-select" data-key="${esc(a.key)}" ${cartLocked() ? 'disabled' : ''}>Use</button>`}<button class="icon-button" data-action="account-remove" data-key="${esc(a.key)}" aria-label="Remove account" ${cartLocked() ? 'disabled' : ''}>${icon('trash')}</button></div></div>`;
    }).join('') : empty('accounts', 'No accounts yet', 'Add your own account with OTP or a verified session.');
    return `${intro}${lockedNotice}<div class="card"><div class="card-title">${tile('userplus')}<span class="title-copy">Add account<small>${state.user?.isBoss ? 'Uses the shared boss vault' : 'Private to your Telegram user'}</small></span></div><div class="divider"></div><div class="segmented"><button type="button" data-action="account-mode" data-mode="phone" class="${state.mode === 'phone' ? 'selected' : ''}">Phone number</button><button type="button" data-action="account-mode" data-mode="json" class="${state.mode === 'json' ? 'selected' : ''}">Session JSON</button></div>${controls}<p class="hint">This adds a server-side session; it does not log the Swiggy app in on your phone.</p></div><div class="line-heading">${icon('accounts')} Saved accounts <span class="pill right">${state.accounts.length}</span></div>${accounts}`;
  }
  function addressCard(a, selected = false) {
    const lockAttr = cartLocked() ? 'disabled' : '';
    return `<div class="address-row"><div class="row-content"><span class="badge ${selected ? 'green' : 'blue'}">${selected ? 'SELECTED' : esc(addressLabel(a))}</span><strong>${esc(a.name || 'Receiver name needed')}${a.mobile ? ' · +91 ' + esc(a.mobile) : ''}</strong><p>${esc(a.address || 'Address not available')}</p></div>${selected ? `<button class="icon-button" data-action="contact-edit" aria-label="Edit receiver contact" ${lockAttr}>${icon('accounts')}</button>` : `<button class="button mini outline" data-action="address-select" data-ref="${esc(a.ref)}" ${lockAttr}>Select</button>`}</div>`;
  }
  function renderAddress() {
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    const lockedNotice = locked ? '<div class="warning">Receiver changes are locked while checkout is pending or unknown.</div>' : '';
    const selected = state.selectedAddress ? addressCard(state.selectedAddress, true) : '';
    const contact = !locked && state.contactEdit && state.selectedAddress ? `<div class="card"><h2 class="card-title">Receiver details</h2><form data-form="contact">${field('Receiver name', 'name', 'Full name', state.selectedAddress.name, 'required')}${field('Receiver mobile', 'mobile', '10-digit mobile number', state.selectedAddress.mobile, 'inputmode="tel" required')}<p class="hint">Use the person who should receive this order; no account-number substitution.</p><button class="button primary block">Confirm receiver</button></form></div>` : '';
    const pending = !locked && state.pendingAddress ? `<div class="card"><h2 class="card-title">Confirm link details</h2><p class="hint">${esc(state.pendingAddress.address)}</p><form data-form="confirm-address">${field('Receiver name', 'name', 'Receiver name', state.pendingAddress.name, 'required')}${field('Receiver mobile', 'mobile', '10-digit mobile number', state.pendingAddress.mobile, 'inputmode="tel" required')}<p class="hint">Name and mobile are filled from the link when Swiggy provides them. Check them before continuing.</p><button class="button primary block">Use this address ${icon('arrow')}</button></form></div>` : '';
    const list = state.addresses.length ? state.addresses.map(a => addressCard(a)).join('') : `<div class="empty">${esc(state.addressNote || 'Refresh to fetch saved addresses from Swiggy.')}</div>`;
    return `${head('WHERE TO?', 'Delivery addresses', 'Choose the right person and place.')}${lockedNotice}${selected}${contact}<div class="card"><div class="card-title">${tile('link')}<span class="title-copy">Add by address link<small>Paste the Swiggy share-address link.</small></span></div><form data-form="address-link">${field('Swiggy address link', 'url', 'https://swiggy.onelink.me/…', '', 'type="url" required ' + lockAttr)}<button class="button primary block" ${lockAttr}>Read address ${icon('arrow')}</button></form></div>${pending}<div class="action-tile">${tile('address', true)}<span class="tile-copy"><strong>Pin on map</strong><small>Manual map entry is not available yet.</small></span><span class="pill">Soon</span></div><div class="line-heading">${icon('address')} Saved addresses <button class="text-button right" data-action="addresses-refresh">${icon('refresh')} Refresh</button></div>${list}`;
  }
  function renderSearch() {
    if (state.menu) {
      const r = state.menu.restaurant;
      const avail = r.isOpen === false ? `<div class="warning">${esc(r.opens || 'This restaurant is closed right now.')}</div>` : '';
      const sections = state.menu.categories.map(c => `<div class="menu-category">${esc(c.title)} <span class="pill">${c.items.length}</span></div>${c.items.map(i => `<article class="dish-row"><div class="row-content">${i.isVeg === null ? '' : `<span class="veg-mark ${i.isVeg ? '' : 'nonveg'}" aria-label="${i.isVeg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`}<strong>${esc(i.name)}</strong><div class="dish-price">${i.price === null ? 'Price unavailable' : money(i.price)}</div><p class="dish-description">${esc(i.description)}</p></div><div class="dish-right">${i.image ? `<img class="food-thumb" src="${esc(i.image)}" alt="" loading="lazy">` : `<span class="food-placeholder">${icon('store')}</span>`}<button class="button mini outline" data-action="dish-add" data-id="${esc(i.id)}" ${cartLocked() || r.isOpen === false || i.inStock === false || i.customizable || i.price === null ? 'disabled' : ''}>${cartLocked() ? 'Checkout pending' : i.inStock === false ? 'Sold out' : i.customizable ? 'Choices needed' : 'ADD +'}</button></div></article>`).join('')}`).join('');
      return `<button class="back-button" data-action="menu-back">${icon('back')} Back to search</button><div class="menu-hero"><p>RESTAURANT · ${esc(r.area)}</p><h1>${esc(r.name)}</h1><p>${esc([r.rating ? '★ ' + r.rating : '', r.ratings, r.time].filter(Boolean).join(' · '))}</p></div>${avail}<p class="hint">Items that require custom choices can be ordered in Swiggy; support here is coming later.</p>${sections}`;
    }
    const addr = state.selectedAddress ? `<button class="action-tile" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><small>DELIVER TO</small><strong>${esc(addressLabel(state.selectedAddress))}</strong><small>${esc(state.selectedAddress.address)}</small></span>${icon('arrow')}</button>` : `<button class="action-tile" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><strong>Select a delivery address</strong><small>Restaurant availability depends on your location.</small></span>${icon('arrow')}</button>`;
    let results = '';
    if (state.results === null) {
      results = `${empty('store', 'Find something delicious', 'Search for a restaurant to see its menu and build a cart.')}<p class="eyebrow">Popular searches</p><div class="chips">${["Domino's",'KFC',"McDonald’s",'Pizza Hut','Burger King','Subway'].map(q => `<button class="chip" data-action="popular" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    } else if (!state.results.length) results = empty('search', 'No restaurants returned', 'Try another search or check the selected address.');
    else results = `<div class="line-heading">${state.results.length} restaurant${state.results.length === 1 ? '' : 's'}</div>${state.results.map(r => `<button class="restaurant-row" data-action="restaurant" data-id="${esc(r.id)}">${r.image ? `<img class="food-thumb" src="${esc(r.image)}" alt="" loading="lazy">` : `<span class="food-placeholder">${icon('store')}</span>`}<span class="row-content"><strong>${esc(r.name)}</strong><p>${esc([r.rating ? '★ ' + r.rating : '',r.ratings].filter(Boolean).join(' · '))}</p><p>${esc(r.cuisines)}</p><p>${esc([r.area,r.distance,r.time].filter(Boolean).join(' · '))}</p><p class="${r.isOpen === true ? 'status-open' : r.isOpen === false ? 'status-closed' : 'status-unknown'}">${r.isOpen === true ? 'Open' : r.isOpen === false ? esc(r.opens || 'Closed') : 'Availability not returned'}</p></span>${icon('arrow')}</button>`).join('')}`;
    return `${head('DISCOVER', 'Find a restaurant', 'Good food, a little closer to home.')}${addr}<form class="search-form" data-form="search"><span class="input-wrap">${icon('search')}<input name="q" value="${esc(state.searchQuery)}" placeholder="Search for restaurants…" required></span><button class="button primary" aria-label="Search">${icon('arrow')}</button></form>${results}`;
  }
  function trackingDetails(t) {
    if (!t) return '<p class="hint">Swiggy has not returned tracking details yet.</p>';
    const link = t.trackingUrl ? `<a class="button soft block" href="${esc(t.trackingUrl)}" target="_blank" rel="noopener noreferrer">Open Swiggy tracking (external) ↗</a>` : '';
    return `<div class="bill-row"><span>Status</span><strong>${esc(t.status || 'Not returned')}</strong></div>${t.eta ? `<div class="bill-row"><span>ETA</span><strong>${esc(t.eta)}</strong></div>` : ''}${t.deliveryPartner?.name ? `<div class="bill-row"><span>Delivery partner</span><strong>${esc(t.deliveryPartner.name)}</strong></div>` : ''}${t.deliveryPartner?.phone ? `<div class="bill-row"><span>Partner phone</span><strong>${esc(t.deliveryPartner.phone)}</strong></div>` : ''}${t.deliveryOtp ? `<div class="bill-row"><span>Delivery OTP</span><strong>${esc(t.deliveryOtp)}</strong></div>` : ''}${link}`;
  }
  function renderCheckout() {
    const c = state.checkout;
    if (!c) {
      if (!state.checkoutEnabled) return `<div class="card"><div class="card-title">${icon('cart')} Payment</div><div class="warning">In-app checkout is not enabled yet; this draft is not an order. The optional button below opens Swiggy outside this Mini App.</div><button class="button soft block" type="button" data-action="open-swiggy">Open Swiggy (external) ${icon('arrow')}</button></div>`;
      return `<div class="card"><div class="card-title">${icon('cart')} UPI checkout</div><p class="hint">Experimental: one real placement request is sent after your confirmation. Swiggy may notify the recipient. Check all details before continuing.</p><button class="button green block" type="button" data-action="checkout-start" ${state.cart?.quote ? '' : 'disabled'}>Place order & get UPI QR ${icon('arrow')}</button><p class="hint">A bill is not an order. Card and cash payments are not supported here.</p></div>`;
    }
    const id = `${c.accountPhone ? `<div class="bill-row"><span>Original account</span><strong>${esc(c.accountPhone)}</strong></div>` : ''}${c.orderId ? `<div class="bill-row"><span>Swiggy order ID</span><strong>#${esc(c.orderId)}</strong></div>` : ''}`;
    const warning = `<p class="hint">${esc(c.message || '')}</p>`;
    if (c.status === 'PAID') return `<div class="card"><div class="card-title">${icon('check')} Payment verified</div>${id}${warning}${trackingDetails(c.tracking)}<button class="button outline block" data-action="checkout-finish">Start a new draft</button></div>`;
    if (c.status === 'PAYMENT_PENDING') {
      const qr = c.qrDataUrl && /^data:image\/png;base64,/.test(c.qrDataUrl) && c.upiIntentUrl && /^upi:\/\/pay\?/i.test(c.upiIntentUrl)
        ? `<img class="payment-qr" src="${esc(c.qrDataUrl)}" alt="Swiggy UPI payment QR"><a class="button green block" href="${esc(c.upiIntentUrl)}">Open UPI app</a><p class="hint">Pay ${money(c.amount)} only once. If your UPI app cannot open here, scan this QR with another device.</p>` : '';
      const paidNote = c.paymentVerified ? '<div class="warning">Payment was reported, but order confirmation is still pending. Do not pay again.</div>' : '';
      return `<div class="card"><div class="card-title">${icon('receipt')} Payment pending</div>${id}${warning}${paidNote}${qr}<p class="hint">${c.ofoConfirmed ? 'Swiggy returned an OFO flag; recipient SMS is not verified.' : 'Swiggy has not confirmed OFO acceptance or recipient SMS.'}</p><button class="button primary block" data-action="checkout-status">Check payment & order ${icon('refresh')}</button><button class="button soft block" data-action="checkout-orders">Check original account's orders here</button><button class="button outline block" data-action="open-orders">Open Swiggy My Orders (external)</button></div>`;
    }
    return `<div class="card"><div class="card-title">${icon('receipt')} Checkout needs checking</div>${id}<div class="warning">${esc(c.message || 'The result is unknown. An order may exist; do not place another.')}</div>${c.orderId ? `<button class="button primary block" data-action="checkout-status">Check this order ${icon('refresh')}</button>` : ''}<button class="button soft block" data-action="checkout-orders">Check original account's orders here</button><button class="button outline block" data-action="open-orders">Open Swiggy My Orders (external) ↗</button></div>`;
  }
  function renderCart() {
    const cart = state.cart;
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    const lockedNotice = locked ? '<div class="warning">Checkout is pending or unknown. Draft cart changes are locked; check the original account before another order.</div>' : '';
    const importCard = `<div class="card"><div class="card-title">${tile('link')}<span class="title-copy">Add from group cart<small>Use a Swiggy group-cart link.</small></span></div><form data-form="group-cart">${field('Group cart link', 'url', 'https://swig.gy/gc/…', '', 'type="url" required ' + lockAttr)}<button class="button soft block" ${lockAttr}>Import items ${icon('arrow')}</button></form></div>`;
    if (!cart) return `${head('YOUR ORDER', 'Cart', 'Everything for your next meal.')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${importCard}${empty('cart', 'Your cart is empty', 'Search for a restaurant or import a group cart.')}`;
    const items = cart.items.map(i => `<div class="cart-item"><div class="row-content"><strong>${esc(i.name)}</strong><p>${i.price === null ? 'Price unavailable' : money(i.price) + ' each'}${(i.variants?.length || i.addons?.length) ? ' · Customised' : ''}</p></div><div class="stepper"><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)-1}" aria-label="Remove one" ${lockAttr}>−</button><span>${Number(i.qty)}</span><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)+1}" aria-label="Add one" ${lockAttr}>+</button></div></div>`).join('');
    const q = cart.quote;
    const bill = q ? `<div class="card"><div class="card-title">${icon('receipt')} Swiggy bill</div><div class="bill-row"><span>Item total</span><strong>${money(q.itemTotal)}</strong></div><div class="bill-row"><span>Delivery fee</span><strong>${money(q.deliveryFee)}</strong></div><div class="bill-row"><span>Packing</span><strong>${money(q.packingCharges)}</strong></div><div class="bill-row"><span>Taxes & charges</span><strong>${money(q.taxes)}</strong></div>${q.discount ? `<div class="bill-row"><span>Coupon ${esc(q.coupon)}</span><strong>−${money(q.discount)}</strong></div>` : ''}<div class="bill-row total"><span>To pay</span><span>${money(q.total)}</span></div><p class="hint">Fetched from Swiggy. Bill can change; re-check it before paying.${cart.forSomeoneElse ? ' OFO acceptance is not confirmed by this bill.' : ''}</p></div>` : `<div class="warning">Cart items are a draft. The total, offers and delivery fee have not been confirmed by Swiggy yet.</div>`;
    const contact = state.selectedAddress ? `<strong>${esc(state.selectedAddress.name || 'Name needed')}${state.selectedAddress.mobile ? ' · ' + esc(state.selectedAddress.mobile) : ' · Mobile needed'}</strong><p class="hint">${esc(state.selectedAddress.address)}</p>` : `<p class="hint">Choose a delivery address first.</p>`;
    return `${head('YOUR ORDER', 'Cart', 'Review before doing anything on Swiggy.')}${lockedNotice}${importCard}<div class="card"><div class="card-title">${icon('store')} ${esc(cart.restaurantName)}</div>${items}</div><div class="card"><div class="card-title">${icon('address')} Delivery to</div>${contact}<button class="button mini outline" data-action="nav" data-tab="address">${locked ? 'Check receiver' : 'Change / check receiver'}</button></div>${bill}<div class="card"><div class="card-title">${icon('receipt')} Get live bill</div><p class="hint">Sync replaces the current cart on the selected Swiggy account and may save the delivery address there.</p><form data-form="sync">${field('Coupon (optional)', 'coupon', 'Enter coupon code', q?.coupon || '', lockAttr)}<label class="checkbox-row"><input type="checkbox" name="forSomeoneElse" ${cart.forSomeoneElse ? 'checked' : ''} ${lockAttr}><span>Order for someone else (use the selected receiver)</span></label><button class="button primary block" ${lockAttr}>Sync & check bill ${icon('refresh')}</button></form></div>${renderCheckout()}`;
  }
  function renderOrders() {
    if (state.order) {
      const o = state.order;
      return `<button class="back-button" data-action="orders-back">${icon('back')} Back to orders</button>${head('ORDER DETAILS', o.restaurant || 'Swiggy order', 'Only information returned by Swiggy is shown.')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div>${o.address ? `<div class="bill-row"><span>Address</span><strong>${esc(o.address)}</strong></div>` : ''}</div><div class="card"><div class="card-title">${icon('cart')} Ordered items</div>${o.items.length ? o.items.map(i => `<div class="bill-row"><span>${esc(i.name)}</span><strong>× ${Number(i.qty)}</strong></div>`).join('') : '<p class="hint">Swiggy did not return item details.</p>'}</div><div class="card"><div class="card-title">${icon('orders')} Tracking <button class="button mini soft right" data-action="order-tracking">${icon('refresh')} Refresh</button></div>${trackingDetails(state.orderTracking)}</div>`;
    }
    const rows = state.orders === null ? empty('orders', 'Your orders', 'Refresh to load order history from the selected account.') : state.orders.length ? state.orders.map(o => `<button class="restaurant-row" data-action="order-detail" data-id="${esc(o.id)}">${tile('orders', true)}<span class="row-content"><strong>${esc(o.restaurant || 'Swiggy order')}</strong><p>${esc(o.placedAt || 'Time not returned')}</p><p>${esc(o.items.map(i => i.name).join(', '))}</p><span class="order-id">#${esc(o.id)}</span></span><span class="pill ${/delivered/i.test(o.status) && !/cancel/i.test(o.status) ? 'green' : ''}">${esc(o.status)}</span></button>`).join('') : empty('orders', 'No orders returned', 'Swiggy did not return any orders for this account.');
    const original = state.ordersScope === 'checkout';
    const note = original ? '<div class="warning">Showing the original checkout account. An empty or delayed list does not prove the order failed; do not place or pay for another order while the outcome is unknown.</div>' : '';
    return `${head('ORDER HISTORY', original ? 'Original account orders' : 'Your orders', original ? 'Recent orders returned for the account used at checkout.' : 'Past and current orders on this account.', `<button class="button mini soft" data-action="orders-refresh">${icon('refresh')} Refresh</button>`)}${note}${rows}`;
  }
  function renderTools() {
    const offers = [
      ['moon','Night offer','Check eligibility and timing on Swiggy.','https://events.swiggy.com/pick-your-late-night-offer'],
      ['sun','Breakfast offer','Check eligibility and timing on Swiggy.','https://events.swiggy.com/book-your-offer'],
      ['tools','Extra offer','Check availability on Swiggy.','https://events.swiggy.com/pick-your-offer']
    ];
    return `${head('A LITTLE EXTRA', 'Offers & tools', 'Explore offers without guessing eligibility.')}<div class="warning">Offer status is not checked here yet. These links open Swiggy outside this Mini App and do not mean an offer is claimed.</div>${offers.map(([sym,title,sub,url]) => `<button class="action-tile offer-card" data-action="offer" data-url="${esc(url)}">${tile(sym)}<span class="tile-copy"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span><span class="offer-tag">External ↗</span></button>`).join('')}`;
  }
  function renderConnection() {
    if (!initData) return `${head('TELEGRAM MINI APP', 'Open in Telegram', 'Your private account space needs a Telegram session.')}<div class="card connection-card"><strong>Browser preview only</strong><p>Open this app from your bot using Open App or /pro. No account data is shown here.</p></div>`;
    if (state.connecting) return `${head('CONNECTING', 'Preparing your space', 'Checking your Telegram session and secure storage…')}<div class="card connection-card" role="status">Connecting securely…</div>`;
    let title = 'Unable to connect';
    let message = state.authError || 'Please retry, or reopen the app from your Telegram bot.';
    if (state.authErrorCode === 'PRO_VAULT_NOT_CONFIGURED') {
      // 31-10-2026: ye haalat ab normally nahi aati — server khud stable key
      // bana leta hai. Phir bhi aaye to dead-end nahi, seedha next step.
      title = 'Ek baar retry karein';
      message = 'Server ne storage key abhi taiyar ki hai. Neeche "Try again" dabaiye — data safe hai.';
    } else if (state.authErrorCode === 'PRO_VAULT_DECRYPT_FAILED') {
      title = 'Purana data is key se nahi khul raha';
      message = 'Aapka saved data waisa hi rakha hai (kuch delete nahi hua). Bot owner ko batayein: server par wahi purana PRO_VAULT_KEY wapas lagana hoga.';
    }
    return `${head('CONNECTION', title, 'Your account data has not been changed.')}<div class="card connection-card" role="alert"><strong>${esc(title)}</strong><p>${esc(message)}</p><button class="button primary block" type="button" data-action="retry-auth">Try again ${icon('refresh')}</button></div>`;
  }
  function render() {
    const views = { accounts: renderAccounts, address: renderAddress, search: renderSearch, cart: renderCart, orders: renderOrders, tools: renderTools };
    $('#content').innerHTML = state.auth ? views[state.tab]() : renderConnection();
    renderNav();
    $('#connection-notice').hidden = true;
  }
  async function reconnect() {
    if (!initData || state.connecting) return;
    state.connecting = true;
    state.auth = false;
    state.authError = '';
    state.authErrorCode = '';
    render();
    try {
      merge(await api('bootstrap'));
      state.auth = true;
    } catch (err) {
      state.authError = err?.message || 'Could not connect. Please retry.';
      state.authErrorCode = err?.code || '';
    } finally {
      state.connecting = false;
      render();
    }
  }
  async function navigate(tab) {
    if (tab === 'orders' && state.ordersScope !== 'active') {
      state.ordersScope = 'active';
      state.orders = null;
    }
    state.tab = tab;
    state.order = null;
    if (tab !== 'search') state.menu = null;
    render(); window.scrollTo({ top: 0, behavior: 'auto' });
    if (state.auth && state.activeAccount && tab === 'address' && !state.addresses.length) await loadAddresses();
    if (state.auth && state.activeAccount && tab === 'orders' && state.orders === null) await loadOrders();
  }
  async function loadAddresses() {
    const data = await api('addresses'); state.addresses = data.addresses; state.addressNote = data.note; render();
  }
  async function loadOrders() {
    const data = await api('orders' + (state.ordersScope === 'checkout' ? '?scope=checkout' : ''));
    state.orders = data.orders; render();
  }
  async function search(q) { state.searchQuery = q; const data = await api('search?q=' + encodeURIComponent(q)); state.results = data.restaurants; state.menu = null; render(); }
  function forms(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.form; const data = new FormData(form); const button = form.querySelector('button[type="submit"],button:not([type])');
    run(async () => {
      if (type === 'send-otp') {
        await api('accounts/send-otp', 'POST', { phone: data.get('phone') }); state.otpSent = true; render(); toast('OTP request accepted by Swiggy.');
      } else if (type === 'verify-otp') {
        const out = await api('accounts/verify-otp', 'POST', { otp: data.get('otp') }); merge(out); state.otpSent = false; state.addresses = []; state.orders = null; render(); toast('Account added.');
      } else if (type === 'import') {
        const raw = String(data.get('session') || ''); let session;
        try { session = JSON.parse(raw); } catch { throw new Error('Please paste valid JSON.'); }
        const out = await api('accounts/import', 'POST', { session }); merge(out); state.addresses = []; state.orders = null; render(); toast('Session verified and added.');
      } else if (type === 'address-link') {
        const out = await api('addresses/resolve', 'POST', { url: data.get('url') }); state.pendingAddress = out.address; render();
      } else if (type === 'confirm-address' || type === 'contact') {
        const out = await api(type === 'contact' ? 'addresses/update-contact' : 'addresses/confirm', 'POST', { name: data.get('name'), mobile: data.get('mobile') });
        merge(out); state.pendingAddress = null; state.contactEdit = false; render(); toast('Receiver details selected.');
      } else if (type === 'search') {
        await search(String(data.get('q') || '').trim());
      } else if (type === 'group-cart') {
        if (state.cart && !await confirmInApp({ title: 'Replace draft cart?', message: 'Your current draft cart will be replaced by the imported group cart.', confirmText: 'Replace draft' })) return;
        const out = await api('cart/import-group', 'POST', { url: data.get('url'), replace: Boolean(state.cart) }); merge(out); render(); toast('Group cart imported as a draft.');
      } else if (type === 'sync') {
        if (!await confirmInApp({ title: 'Sync cart with Swiggy?', message: 'This replaces the current cart on your selected Swiggy account and may save the address there.', confirmText: 'Sync cart' })) return;
        // The prior quote is stale as soon as sync starts, including when the
        // response times out after Swiggy has changed the cart.
        state.cart.quote = null; render();
        const out = await api('cart/sync', 'POST', { coupon: data.get('coupon'), forSomeoneElse: data.has('forSomeoneElse'), confirmReplaceSwiggyCart: true }); merge(out); render(); toast('Bill returned by Swiggy. Check it before paying.');
      }
    }, button);
  }
  document.addEventListener('submit', forms);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action;
    if (action === 'retry-auth') { reconnect(); return; }
    if (action === 'nav') { run(() => navigate(button.dataset.tab)); return; }
    if (action === 'theme') { document.body.classList.toggle('dark'); try { localStorage.setItem('pro-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch {} return; }
    if (action === 'account-mode') { state.mode = button.dataset.mode; state.otpSent = false; render(); return; }
    if (action === 'otp-reset') { state.otpSent = false; render(); return; }
    if (action === 'contact-edit') { state.contactEdit = !state.contactEdit; render(); return; }
    if (action === 'menu-back') { state.menu = null; render(); return; }
    if (action === 'orders-back') { state.order = null; state.orderTracking = null; render(); return; }
    if (action === 'order-detail') { state.order = state.orders?.find(o => o.id === button.dataset.id) || null; state.orderTracking = null; render(); window.scrollTo(0,0); return; }
    if (action === 'open-swiggy') { openExternal('https://www.swiggy.com/cart'); return; }
    if (action === 'open-orders') { openExternal('https://www.swiggy.com/my-account/orders'); return; }
    if (action === 'offer') { openExternal(button.dataset.url); return; }
    run(async () => {
      if (action === 'account-select') { const out = await api('accounts/select', 'POST', { key: button.dataset.key }); merge(out); state.addresses = []; state.orders = null; render(); }
      else if (action === 'account-remove') {
        if (!await confirmInApp({
          title: 'Remove account?',
          message: state.user?.isBoss ? 'This will log out and remove the account from the shared boss vault.' : 'This will remove the account from your private Mini App vault.',
          confirmText: 'Remove account', danger: true
        })) return;
        const out = await api('accounts/remove', 'POST', { key: button.dataset.key }); merge(out); state.addresses = []; state.orders = null; render(); toast('Account removed.');
      } else if (action === 'addresses-refresh') await loadAddresses();
      else if (action === 'address-select') { const out = await api('addresses/select', 'POST', { ref: button.dataset.ref }); merge(out); state.contactEdit = !out.selectedAddress?.mobile || !out.selectedAddress?.name; render(); toast('Address selected.'); }
      else if (action === 'popular') await search(button.dataset.query);
      else if (action === 'restaurant') { const out = await api('menu?id=' + encodeURIComponent(button.dataset.id)); state.menu = out; render(); window.scrollTo(0,0); }
      else if (action === 'dish-add') {
        let out;
        try { out = await api('cart/add', 'POST', { itemId: button.dataset.id }); }
        catch (e) {
          if (e.status !== 409 || (state.checkout && state.checkout.status !== 'PAID')) throw e;
          if (!await confirmInApp({ title: 'Replace draft cart?', message: 'The existing draft will be replaced with items from this restaurant.', confirmText: 'Replace draft' })) return;
          out = await api('cart/add', 'POST', { itemId: button.dataset.id, replace: true });
        }
        merge(out); render(); toast('Added to draft cart.');
      } else if (action === 'qty') { const out = await api('cart/quantity', 'POST', { lineKey: button.dataset.key, qty: Number(button.dataset.qty) }); merge(out); render(); }
      else if (action === 'checkout-start') {
        const quote = state.cart?.quote;
        if (!quote || !state.selectedAddress || !state.activeAccount) throw new Error('Select an account and recipient, then sync a fresh bill.');
        if (!await confirmInApp({
          title: 'Confirm real order request',
          message: `Send ONE real Swiggy order request for ${money(quote.total)}?\n\nAccount: ${state.activeAccount.phone || state.activeAccount.name}\nReceiver: ${state.selectedAddress.name} · ${state.selectedAddress.mobile}\nAddress: ${state.selectedAddress.address}\n\nSwiggy may notify the receiver; SMS is not verified. Payment is separate. If the request times out, do not place another order until you check Swiggy My Orders.`,
          confirmText: 'Send order request'
        })) return;
        try {
          const out = await api('checkout', 'POST', { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt });
          merge(out); render();
          toast(out.checkout?.status === 'PAYMENT_PENDING' ? 'Payment details returned. Verify before paying.' : 'Check Swiggy My Orders; do not retry.');
        } catch (e) {
          // A lost browser response is not proof that the server never sent the
          // request. Hide retry until an authenticated bootstrap resolves it.
          state.checkout = { status: 'OUTCOME_UNKNOWN', message: 'The response was lost. Check Swiggy My Orders; do not place another order.' };
          try { merge(await api('bootstrap')); } catch {}
          render();
          throw e;
        }
      }
      else if (action === 'checkout-status') { const out = await api('checkout/status', 'POST', {}); merge(out); render(); toast(out.checkout?.status === 'PAID' ? 'Swiggy returned the paid order.' : 'Status checked. If you already paid, do not pay again.'); }
      else if (action === 'checkout-finish') {
        if (!await confirmInApp({ title: 'Start a new draft?', message: 'The paid order remains in Swiggy order history.', confirmText: 'Start new draft' })) return;
        const out = await api('checkout/finish', 'POST', { confirmNewDraft: true }); merge(out); state.orders = null; state.ordersScope = 'active'; render();
      }
      else if (action === 'checkout-orders') {
        state.ordersScope = 'checkout'; state.orders = null; state.order = null; state.orderTracking = null; state.tab = 'orders';
        render(); window.scrollTo(0, 0); await loadOrders();
      }
      else if (action === 'order-tracking') {
        const scope = state.ordersScope === 'checkout' ? '&scope=checkout' : '';
        const out = await api('orders/tracking?id=' + encodeURIComponent(state.order.id) + scope); state.orderTracking = out.tracking; render();
      }
      else if (action === 'orders-refresh') await loadOrders();
    }, button);
  });
  try { if (localStorage.getItem('pro-theme') === 'dark') document.body.classList.add('dark'); } catch {}
  if (initData) reconnect();
  else render();
})();
