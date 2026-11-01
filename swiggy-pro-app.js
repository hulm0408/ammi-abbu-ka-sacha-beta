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
    poolManager: null, chatHandoff: false, chatLaunch: new URLSearchParams(window.location.search).get('from') === 'chat',
    handoffError: '', orders: null, ordersScope: 'active', order: null, orderTracking: null, busy: false
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
  const cartLocked = () => Boolean(state.checkout && state.checkout.status !== 'PAID');
  // Headings are intentionally just headings; actions and important warnings
  // live in the relevant controls rather than a second explanatory subtitle.
  const head = (_eyebrow, title, _sub, end = '') => `<div class="page-heading"><h1>${esc(title)}</h1>${end}</div>`;
  const empty = (_symbol, title, text = '') => `<div class="empty"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
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
    for (const key of ['user','accounts','activeAccount','selectedAddress','pendingAddress','cart','checkout','checkoutEnabled','poolManager','chatHandoff']) if (Object.hasOwn(data, key)) state[key] = data[key];
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
  function linkForm(action, label, placeholder, button, disabled = false) {
    const id = `${action}-url`;
    const lock = disabled ? 'disabled' : '';
    return `<div class="card link-card"><form data-form="${esc(action)}"><label class="field-label" for="${esc(id)}">${esc(label)}</label><div class="form-row"><span class="input-wrap"><input id="${esc(id)}" name="url" type="url" placeholder="${esc(placeholder)}" required ${lock}></span><button class="button primary" type="submit" ${lock}>${esc(button)}</button></div></form></div>`;
  }
  function addressLabel(a) { return a?.annotation || 'Delivery address'; }
  function renderNav() {
    const tabs = [['accounts','Accounts'],['address','Address'],['search','Search'],['cart','Cart'],['orders','Orders'],['tools','Offers']];
    $('#bottom-nav').innerHTML = tabs.map(([id, label]) => `<button type="button" data-action="nav" data-tab="${id}" class="${state.tab === id ? 'selected' : ''}" ${state.tab === id ? 'aria-current="page"' : ''} ${state.auth ? '' : 'disabled'}>${icon(id)}<span>${label}</span></button>`).join('');
    const chip = $('#account-chip');
    chip.textContent = state.auth ? (state.activeAccount?.phone ? `+91 ${state.activeAccount.phone}` : state.activeAccount?.phoneLabel || state.activeAccount?.name || 'Select ID') : 'Not connected';
    chip.disabled = !state.auth;
    const cart = state.auth ? state.cart : null;
    const quantity = cart?.items?.reduce((n, i) => n + Number(i.qty || 0), 0) || 0;
    const showDock = Boolean(cart && quantity && state.tab !== 'cart');
    document.body.classList.toggle('has-cart-dock', showDock);
    $('#cart-dock').innerHTML = showDock ? `<button type="button" class="cart-dock" data-action="nav" data-tab="cart"><span class="dock-icon">${icon('cart')}</span><span class="dock-copy"><strong>${quantity} item${quantity === 1 ? '' : 's'} · ${esc(cart.restaurantName)}</strong><small>${cart.quote ? `Swiggy bill ${money(cart.quote.total)}` : 'Bill not checked'}</small></span><span class="dock-cta">View cart →</span></button>` : '';
  }
  function checkedTime(value) {
    const d = new Date(value || '');
    return Number.isFinite(d.getTime()) ? d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'time not recorded';
  }
  function accountAvailable(a) {
    return (!a.availability || a.availability === 'NOT_CHECKED') && a.sessionState !== 'IDENTITY_MISMATCH';
  }
  function accountBrief(a) {
    if (!accountAvailable(a)) return ({ LOGGED_OUT: 'Login needs owner', SESSION_EXPIRED: 'Session expired', SUSPENDED: 'Previously flagged', BUSY: 'In use', OUTCOME_UNKNOWN: 'Order needs review' }[a.availability] || 'Needs owner');
    if (a.orderState === 'USED') return 'Previously ordered';
    if (a.orderState === 'ZERO_REPORTED') return '0 orders reported';
    return 'Status not checked';
  }
  function accountSelector() {
    if (!state.accounts.length) return '';
    const options = state.accounts.map(a => `<option value="${esc(a.key)}" ${a.active ? 'selected' : ''} ${accountAvailable(a) ? '' : 'disabled'}>${esc(a.name)} · ${esc(accountBrief(a))}</option>`).join('');
    return `<label class="field"><span class="field-label">Swiggy ID</span><span class="input-wrap"><select data-action="account-dropdown" aria-label="Choose a Swiggy ID" ${cartLocked() ? 'disabled' : ''}><option value="" ${state.activeAccount ? '' : 'selected'} disabled>Select an ID</option>${options}</select></span></label>`;
  }
  function accountStatus(a) {
    const order = a.orderState === 'USED' ? '<s>0 orders</s> · Previously ordered'
      : a.orderState === 'ZERO_REPORTED' ? '0 orders reported'
      : a.orderState === 'NONE_RETURNED' ? 'No orders returned · total unknown'
      : 'Orders unverified';
    const session = a.sessionState === 'VERIFIED' ? 'Session verified'
      : a.sessionState === 'IDENTITY_MISMATCH' ? 'Identity mismatch · ask owner'
      : a.availability === 'SUSPENDED' ? 'Previously flagged · ask owner'
      : a.availability === 'SESSION_EXPIRED' ? 'Session expired · ask owner'
      : a.availability === 'LOGGED_OUT' ? 'Login unavailable · ask owner'
      : a.availability === 'BUSY' ? 'In use'
      : a.availability === 'OUTCOME_UNKNOWN' ? 'Earlier order may exist · ask owner'
      : 'Session not checked';
    const wallet = typeof a.walletBalance === 'number' ? `Swiggy Money: ${money(a.walletBalance)} reported` : 'Free Cash unverified';
    const offers = Array.isArray(a.recordedOffers) ? a.recordedOffers.map(o => {
      const title = `${esc(o.label)}: ${esc(String(o.status).replaceAll('_', ' ').toLowerCase())}`;
      return `${o.status === 'USED' || o.status === 'EXPIRED' ? `<s>${title}</s>` : title} · ${esc(checkedTime(o.checkedAt))}`;
    }) : [];
    const facts = [session, order, wallet, ...offers];
    return `<div class="account-facts">${facts.map(value => `<span>${value}</span>`).join('')}</div>${a.checkedAt ? `<p class="status-time">Checked ${esc(checkedTime(a.checkedAt))}</p>` : ''}`;
  }
  function renderAccounts() {
    const family = state.user?.managedAccess && !state.user?.isBoss;
    const lockedNotice = cartLocked() ? '<div class="warning">Checkout is pending or unknown. Account switching is locked; only the original account can be reconnected.</div>' : '';
    const selector = state.accounts.length ? `<div class="card compact-card">${accountSelector()}${state.accounts.some(a => typeof a.walletBalance === 'number') ? '<p class="hint">Swiggy Money is not necessarily promotional Free Cash.</p>' : ''}</div>` : '';
    const controls = state.mode === 'phone'
      ? `<form data-form="${state.otpSent ? 'verify-otp' : 'send-otp'}">${state.otpSent
          ? `${field('Swiggy OTP', 'otp', '6-digit OTP', '', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required')}<p class="hint">Never share your OTP.</p><button class="button primary block" type="submit">Verify OTP</button><button class="text-button" type="button" data-action="otp-reset">Change number</button>`
          : `<label class="field"><span class="field-label">Mobile number</span><span class="input-wrap"><span class="phone-prefix">+91</span><input name="phone" placeholder="Mobile number" inputmode="tel" autocomplete="tel-national" required></span></label><button class="button primary block" type="submit">Send OTP</button>`}</form>`
      : `<form data-form="import"><label class="field"><span class="field-label">Session JSON</span><span class="input-wrap"><textarea name="session" placeholder='{"mobile":"…", "token":"…", "tid":"…"}' required></textarea></span></label><p class="hint">Use your own session; never share tokens or OTPs in chat.</p><button class="button primary block" type="submit">Add account</button></form>`;
    const addAccount = family ? '' : `<div class="card"><h2 class="card-title">Add account</h2><div class="segmented"><button type="button" data-action="account-mode" data-mode="phone" class="${state.mode === 'phone' ? 'selected' : ''}">Phone</button><button type="button" data-action="account-mode" data-mode="json" class="${state.mode === 'json' ? 'selected' : ''}">Session JSON</button></div>${controls}<p class="hint">Server login only; the Swiggy app stays unchanged.</p></div>`;
    const accounts = state.accounts.length ? state.accounts.map(a => `<div class="account-row ${a.active ? 'active' : ''}"><div class="row-content"><div class="account-heading"><strong>${esc(a.name)}</strong>${a.active ? '<span class="badge green">Selected</span>' : ''}</div>${accountStatus(a)}<div class="inline-actions"><button class="text-button" data-action="account-check" data-key="${esc(a.key)}">Check status</button>${state.user?.isBoss ? `<button class="text-button" data-action="pool-account" data-key="${esc(a.key)}" data-allowed="${a.shared ? 'false' : 'true'}">${a.shared ? 'Stop sharing' : 'Share ID'}</button>` : ''}${a.reservationCanRelease ? '<button class="text-button" data-action="account-release">Release ID</button>' : ''}</div></div><div class="row-actions">${a.active ? '' : `<button class="button mini outline" data-action="account-select" data-key="${esc(a.key)}" ${cartLocked() || !accountAvailable(a) ? 'disabled' : ''}>Use</button>`}${a.managed ? '' : `<button class="icon-button" data-action="account-remove" data-key="${esc(a.key)}" aria-label="Remove account" ${cartLocked() ? 'disabled' : ''}>${icon('trash')}</button>`}</div></div>`).join('') : empty('accounts', family ? 'No ID shared yet' : 'No accounts yet', family ? 'Ask the owner for access.' : 'Add an account or ask for access.');
    const manager = state.user?.isBoss ? `<div class="card"><h2 class="card-title">Managed access</h2><p class="hint">Ask each person for their Telegram ID via /myid.</p><form data-form="pool-user">${field('Telegram user ID', 'userId', 'e.g. 123456789', '', 'inputmode="numeric" required')}<button class="button primary block">Allow user</button></form>${(state.poolManager?.users || []).map(id => `<div class="pool-user"><span>${esc(id)}</span><button class="text-button" data-action="pool-user-revoke" data-id="${esc(id)}">Remove access</button></div>`).join('')}</div>` : '';
    return `${head('', 'Accounts', '')}${lockedNotice}${selector}<div class="line-heading">Available IDs <span class="pill right">${state.accounts.length}</span></div>${accounts}${manager}${addAccount}`;
  }
  function addressCard(a, selected = false) {
    const lockAttr = cartLocked() ? 'disabled' : '';
    return `<div class="address-row"><div class="row-content"><div class="address-heading"><strong>${esc(a.name || 'Receiver name needed')}</strong><span class="badge ${selected ? 'green' : 'blue'}">${selected ? 'Selected' : esc(addressLabel(a))}</span></div>${a.mobile ? `<p>${esc(a.mobile)}</p>` : ''}<p>${esc(a.address || 'Address not available')}</p></div>${selected ? `<button class="text-button" data-action="contact-edit" aria-label="Edit receiver contact" ${lockAttr}>Edit</button>` : `<button class="button mini outline" data-action="address-select" data-ref="${esc(a.ref)}" ${lockAttr}>Select</button>`}</div>`;
  }
  function renderAddress() {
    const locked = cartLocked();
    const lockedNotice = locked ? '<div class="warning">Receiver changes are locked while checkout is pending or unknown.</div>' : '';
    const selected = state.selectedAddress ? addressCard(state.selectedAddress, true) : '';
    const contact = !locked && state.contactEdit && state.selectedAddress ? `<div class="card"><h2 class="card-title">Receiver</h2><form data-form="contact">${field('Name', 'name', 'Receiver name', state.selectedAddress.name, 'required')}${field('Mobile', 'mobile', '10-digit mobile number', state.selectedAddress.mobile, 'inputmode="tel" required')}<button class="button primary block">Save receiver</button></form></div>` : '';
    const pending = !locked && state.pendingAddress ? `<div class="card"><h2 class="card-title">Check receiver</h2><p class="address-detail">${esc(state.pendingAddress.address)}</p><form data-form="confirm-address">${field('Name', 'name', 'Receiver name', state.pendingAddress.name, 'required')}${field('Mobile', 'mobile', '10-digit mobile number', state.pendingAddress.mobile, 'inputmode="tel" required')}<button class="button primary block">Use address</button></form></div>` : '';
    const list = state.addresses.length ? state.addresses.map(a => addressCard(a)).join('') : `<div class="empty">${esc(state.addressNote || 'No saved addresses loaded.')}</div>`;
    const saved = state.activeAccount?.managed ? '' : `<div class="line-heading">Saved addresses <button class="text-button right" data-action="addresses-refresh">${icon('refresh')} Refresh</button></div>${list}`;
    return `${head('', 'Address', '')}${lockedNotice}${pending}${selected}${contact}${linkForm('address-link', 'Address link', 'https://swiggy.onelink.me/…', 'Add', locked)}${saved}`;
  }
  function renderSearch() {
    if (state.menu) {
      const r = state.menu.restaurant;
      const avail = r.isOpen === false ? `<div class="warning">${esc(r.opens || 'Restaurant closed.')}</div>` : '';
      const customNote = state.menu.categories.some(c => c.items.some(i => i.customizable)) ? '<p class="hint">Custom choices are not supported yet.</p>' : '';
      const sections = state.menu.categories.map(c => `<div class="menu-category">${esc(c.title)} <span class="pill">${c.items.length}</span></div>${c.items.map(i => `<article class="dish-row"><div class="row-content">${i.isVeg === null ? '' : `<span class="veg-mark ${i.isVeg ? '' : 'nonveg'}" aria-label="${i.isVeg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`}<strong>${esc(i.name)}</strong><div class="dish-price">${i.price === null ? 'Price unavailable' : money(i.price)}</div>${i.description ? `<p class="dish-description">${esc(i.description)}</p>` : ''}</div><div class="dish-right">${i.image ? `<img class="food-thumb" src="${esc(i.image)}" alt="" loading="lazy">` : `<span class="food-placeholder">${icon('store')}</span>`}<button class="button mini outline" data-action="dish-add" data-id="${esc(i.id)}" ${cartLocked() || r.isOpen === false || i.inStock === false || i.customizable || i.price === null ? 'disabled' : ''}>${cartLocked() ? 'Pending' : i.inStock === false ? 'Sold out' : i.customizable ? 'Choices needed' : 'Add +'}</button></div></article>`).join('')}`).join('');
      return `<button class="back-button" data-action="menu-back">${icon('back')} Search</button><div class="menu-hero"><h1>${esc(r.name)}</h1><p>${esc([r.area, r.rating ? '★ ' + r.rating : '', r.ratings, r.time].filter(Boolean).join(' · '))}</p></div>${avail}${customNote}${sections}`;
    }
    const addr = state.selectedAddress ? `<button class="action-tile" data-action="nav" data-tab="address">${icon('address')}<span class="tile-copy"><strong>${esc(addressLabel(state.selectedAddress))}</strong><small>${esc(state.selectedAddress.address)}</small></span>${icon('arrow')}</button>` : `<button class="action-tile" data-action="nav" data-tab="address">${icon('address')}<span class="tile-copy"><strong>Select address</strong></span>${icon('arrow')}</button>`;
    let results = '';
    if (state.results === null) {
      results = `<div class="line-heading">Popular searches</div><div class="chips">${["Domino's",'KFC',"McDonald’s",'Pizza Hut','Burger King','Subway'].map(q => `<button class="chip" data-action="popular" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    } else if (!state.results.length) results = empty('search', 'No restaurants found', 'Try another search or address.');
    else results = `<div class="line-heading">${state.results.length} restaurant${state.results.length === 1 ? '' : 's'}</div>${state.results.map(r => `<button class="restaurant-row" data-action="restaurant" data-id="${esc(r.id)}">${r.image ? `<img class="food-thumb" src="${esc(r.image)}" alt="" loading="lazy">` : `<span class="food-placeholder">${icon('store')}</span>`}<span class="row-content"><strong>${esc(r.name)}</strong><p>${esc([r.rating ? '★ ' + r.rating : '', r.ratings, r.cuisines, r.area, r.distance, r.time].filter(Boolean).join(' · '))}</p><p class="${r.isOpen === true ? 'status-open' : r.isOpen === false ? 'status-closed' : 'status-unknown'}">${r.isOpen === true ? 'Open' : r.isOpen === false ? esc(r.opens || 'Closed') : 'Availability unknown'}</p></span>${icon('arrow')}</button>`).join('')}`;
    return `${head('', 'Search', '')}${addr}<form class="search-form" data-form="search"><span class="input-wrap">${icon('search')}<input name="q" value="${esc(state.searchQuery)}" placeholder="Search restaurants" aria-label="Search restaurants" required></span><button class="button primary" aria-label="Search">${icon('search')}</button></form>${results}`;
  }
  function trackingDetails(t) {
    if (!t) return '<p class="hint">Swiggy has not returned tracking details yet.</p>';
    const link = t.trackingUrl ? `<a class="button soft block" href="${esc(t.trackingUrl)}" target="_blank" rel="noopener noreferrer">Open Swiggy tracking (external) ↗</a>` : '';
    return `<div class="bill-row"><span>Status</span><strong>${esc(t.status || 'Not returned')}</strong></div>${t.eta ? `<div class="bill-row"><span>ETA</span><strong>${esc(t.eta)}</strong></div>` : ''}${t.deliveryPartner?.name ? `<div class="bill-row"><span>Delivery partner</span><strong>${esc(t.deliveryPartner.name)}</strong></div>` : ''}${t.deliveryPartner?.phone ? `<div class="bill-row"><span>Partner phone</span><strong>${esc(t.deliveryPartner.phone)}</strong></div>` : ''}${t.deliveryOtp ? `<div class="bill-row"><span>Delivery OTP</span><strong>${esc(t.deliveryOtp)}</strong></div>` : ''}${link}`;
  }
  function renderCheckout() {
    const c = state.checkout;
    if (!c) {
      if (!state.checkoutEnabled) return `<div class="card"><h2 class="card-title">Payment</h2><div class="warning">Checkout is disabled. This is only a draft.</div>${state.activeAccount?.managed ? '' : `<button class="button soft block" type="button" data-action="open-swiggy">Open Swiggy ↗</button>`}</div>`;
      return `<div class="card"><h2 class="card-title">UPI checkout</h2><p class="hint">Experimental · real order request · recipient SMS unverified.</p><button class="button green block" type="button" data-action="checkout-start" ${state.cart?.quote ? '' : 'disabled'}>Place order & get QR</button><p class="hint">UPI only. A bill is not an order.</p></div>`;
    }
    const id = `${c.accountPhone ? `<div class="bill-row"><span>Original account</span><strong>${esc(c.accountPhone)}</strong></div>` : ''}${c.orderId ? `<div class="bill-row"><span>Swiggy order ID</span><strong>#${esc(c.orderId)}</strong></div>` : ''}`;
    const warning = c.message ? `<p class="hint">${esc(c.message)}</p>` : '';
    if (c.status === 'PAID') return `<div class="card"><h2 class="card-title">Payment verified</h2>${id}${warning}${trackingDetails(c.tracking)}<button class="button outline block" data-action="checkout-finish">New draft</button></div>`;
    if (c.status === 'PAYMENT_PENDING') {
      const qr = !c.paymentVerified && c.qrDataUrl && /^data:image\/png;base64,/.test(c.qrDataUrl) && c.upiIntentUrl && /^upi:\/\/pay\?/i.test(c.upiIntentUrl)
        ? `<img class="payment-qr" src="${esc(c.qrDataUrl)}" alt="Swiggy UPI payment QR"><a class="button green block" href="${esc(c.upiIntentUrl)}">Open UPI app</a><p class="hint">Pay ${money(c.amount)} only once. You can scan the QR from another device.</p>` : '';
      const paidNote = c.paymentVerified ? '<div class="warning">Payment reported; order confirmation pending. Do not pay again.</div>' : '';
      return `<div class="card"><h2 class="card-title">Payment pending</h2>${id}${warning}${paidNote}${qr}<p class="hint">${c.ofoConfirmed ? 'OFO flag returned · recipient SMS unverified.' : 'OFO acceptance and recipient SMS unverified.'}</p><button class="button primary block" data-action="checkout-status">Check payment & order</button><button class="button soft block" data-action="checkout-orders">Check orders</button>${state.activeAccount?.managed ? '<p class="hint">Order ID unknown? Ask the owner. Do not retry.</p>' : '<button class="button outline block" data-action="open-orders">Swiggy My Orders ↗</button>'}</div>`;
    }
    return `<div class="card"><h2 class="card-title">Checkout needs checking</h2>${id}<div class="warning">${esc(c.message || 'The result is unknown. An order may exist; do not place another.')}</div>${c.orderId ? `<button class="button primary block" data-action="checkout-status">Check this order</button>` : ''}<button class="button soft block" data-action="checkout-orders">Check orders</button>${state.activeAccount?.managed ? '<p class="hint">Order ID unknown? Ask the owner. Do not retry.</p>' : '<button class="button outline block" data-action="open-orders">Swiggy My Orders ↗</button>'}</div>`;
  }
  function renderCart() {
    const cart = state.cart;
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    const lockedNotice = locked ? '<div class="warning">Checkout is pending or unknown. Draft cart changes are locked; check the original account before another order.</div>' : '';
    const importCard = linkForm('group-cart', 'Cart link', 'https://swig.gy/gc/…', 'Import', locked);
    const selectId = state.accounts.length ? `<div class="card compact-card">${accountSelector()}</div>` : '';
    if (!cart) return `${head('', 'Cart', '')}${lockedNotice}${selectId}${state.checkout ? renderCheckout() : ''}${importCard}${empty('cart', 'Cart is empty', 'Search or import a cart.')}`;
    const items = cart.items.map(i => `<div class="cart-item"><div class="row-content"><strong>${esc(i.name)}</strong><p>${i.price === null ? 'Price unavailable' : money(i.price) + ' each'}${(i.variants?.length || i.addons?.length) ? ' · Customised' : ''}</p></div><div class="stepper"><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)-1}" aria-label="Remove one" ${lockAttr}>−</button><span>${Number(i.qty)}</span><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)+1}" aria-label="Add one" ${lockAttr}>+</button></div></div>`).join('');
    const q = cart.quote;
    const bill = q ? `<div class="card"><h2 class="card-title">Swiggy bill</h2><div class="bill-row"><span>Items</span><strong>${money(q.itemTotal)}</strong></div><div class="bill-row"><span>Delivery</span><strong>${money(q.deliveryFee)}</strong></div><div class="bill-row"><span>Packing</span><strong>${money(q.packingCharges)}</strong></div><div class="bill-row"><span>Taxes & charges</span><strong>${money(q.taxes)}</strong></div>${q.discount ? `<div class="bill-row"><span>Coupon ${esc(q.coupon)}</span><strong>−${money(q.discount)}</strong></div>` : ''}${q.walletBalance !== null && q.walletBalance !== undefined ? `<div class="bill-row"><span>Swiggy Money reported</span><strong>${money(q.walletBalance)}</strong></div><p class="hint">Swiggy Money is not necessarily Free Cash or a bill deduction.</p>` : ''}<div class="bill-row total"><span>To pay</span><span>${money(q.total)}</span></div><p class="hint">Re-check the bill before paying.${cart.forSomeoneElse ? ' OFO acceptance is unconfirmed.' : ''}</p></div>` : `<div class="warning">Draft only · total, offers and delivery fee are not confirmed.</div>`;
    const contact = state.selectedAddress ? `<strong>${esc(state.selectedAddress.name || 'Name needed')}${state.selectedAddress.mobile ? ' · ' + esc(state.selectedAddress.mobile) : ' · Mobile needed'}</strong><p class="address-detail">${esc(state.selectedAddress.address)}</p>` : `<p class="hint">Select an address.</p>`;
    return `${head('', 'Cart', '')}${lockedNotice}${selectId}${importCard}<div class="card"><h2 class="card-title">${esc(cart.restaurantName)}</h2>${items}</div><div class="card"><h2 class="card-title">Delivery <button class="text-button right" data-action="nav" data-tab="address">${locked ? 'Check' : 'Change'}</button></h2>${contact}</div>${bill}<div class="card"><h2 class="card-title">Check bill</h2><p class="hint">Sync replaces the account’s Swiggy cart and may save the address.</p><form data-form="sync">${field('Coupon (optional)', 'coupon', 'Coupon code', q?.coupon || '', lockAttr)}<label class="checkbox-row"><input type="checkbox" name="forSomeoneElse" ${cart.forSomeoneElse ? 'checked' : ''} ${lockAttr}><span>Order for someone else</span></label><button class="button primary block" ${lockAttr}>Sync & check bill</button></form></div>${renderCheckout()}`;
  }
  function renderOrders() {
    if (state.order) {
      const o = state.order;
      return `<button class="back-button" data-action="orders-back">${icon('back')} Orders</button>${head('', o.restaurant || 'Swiggy order', '')}<div class="card"><h2 class="card-title">${esc(o.status)}</h2><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div>${o.address ? `<div class="bill-row"><span>Address</span><strong>${esc(o.address)}</strong></div>` : ''}</div><div class="card"><h2 class="card-title">Items</h2>${o.items.length ? o.items.map(i => `<div class="bill-row"><span>${esc(i.name)}</span><strong>× ${Number(i.qty)}</strong></div>`).join('') : '<p class="hint">Item details not returned.</p>'}</div><div class="card"><h2 class="card-title">Tracking <button class="text-button right" data-action="order-tracking">${icon('refresh')} Refresh</button></h2>${trackingDetails(state.orderTracking)}</div>`;
    }
    const rows = state.orders === null ? empty('orders', 'Orders not loaded', 'Refresh to load.') : state.orders.length ? state.orders.map(o => `<button class="restaurant-row" data-action="order-detail" data-id="${esc(o.id)}"><span class="row-content"><strong>${esc(o.restaurant || 'Swiggy order')}</strong><p>${esc([o.placedAt || 'Time not returned', o.items.map(i => i.name).join(', ')].filter(Boolean).join(' · '))}</p><span class="order-id">#${esc(o.id)}</span></span><span class="pill ${/delivered/i.test(o.status) && !/cancel/i.test(o.status) ? 'green' : ''}">${esc(o.status)}</span></button>`).join('') : empty('orders', 'No orders returned');
    const original = state.ordersScope === 'checkout';
    const note = original ? '<div class="warning">Original checkout account. An empty or delayed list does not prove failure; do not place or pay for another order while the outcome is unknown.</div>' : '';
    return `${head('', original ? 'Original account orders' : 'Orders', '', `<button class="button mini soft" data-action="orders-refresh">${icon('refresh')} Refresh</button>`)}${note}${rows}`;
  }
  function renderTools() {
    if (state.activeAccount?.managed) {
      return `${head('', 'Offers', '')}<div class="card"><h2 class="card-title">${esc(state.activeAccount.name)}</h2>${accountStatus(state.activeAccount)}<p class="hint">Offers can expire; Swiggy Money is not necessarily Free Cash.</p><button class="button primary block" data-action="account-check" data-key="${esc(state.activeAccount.key)}">Check ID status</button></div>`;
    }
    const offers = [
      ['moon','Night offer','https://events.swiggy.com/pick-your-late-night-offer'],
      ['sun','Breakfast offer','https://events.swiggy.com/book-your-offer'],
      ['tools','Extra offer','https://events.swiggy.com/pick-your-offer']
    ];
    return `${head('', 'Offers', '')}<p class="hint">Opens Swiggy · eligibility not checked.</p>${offers.map(([sym,title,url]) => `<button class="action-tile offer-card" data-action="offer" data-url="${esc(url)}">${icon(sym)}<span class="tile-copy"><strong>${esc(title)}</strong></span><span class="offer-tag">↗</span></button>`).join('')}`;
  }
  function renderConnection() {
    if (!initData) return `${head('', 'Open in Telegram', '')}<div class="card connection-card"><p>Open this Mini App from your bot.</p></div>`;
    if (state.connecting) return `${head('', 'Connecting', '')}<div class="card connection-card" role="status">Checking secure storage…</div>`;
    let title = 'Unable to connect';
    let message = state.authError || 'Try again or reopen the app in Telegram.';
    if (state.authErrorCode === 'PRO_VAULT_NOT_CONFIGURED') {
      title = 'Server setup needed';
      message = 'Server storage needs setup; your phone number is not the problem. Ask the bot owner.';
    } else if (state.authErrorCode === 'PRO_VAULT_DECRYPT_FAILED') {
      title = 'Saved account space unavailable';
      message = 'Ask the owner to restore the original vault key. Do not create or delete accounts.';
    }
    return `${head('', title, '')}<div class="card connection-card" role="alert"><p>${esc(message)}</p><button class="button primary block" type="button" data-action="retry-auth">Try again</button></div>`;
  }
  function handoffBanner() {
    if (!state.chatLaunch && !state.chatHandoff) return '';
    const message = state.handoffError || (state.chatHandoff ? 'Chat ordering is paused for this draft.' : 'Open your chat draft here.');
    return `<div class="handoff-banner"><div><strong>Chat draft</strong><p>${esc(message)}</p></div><div class="inline-actions">${state.checkout ? '' : '<button class="text-button" data-action="chat-import">Open / retry</button>'}${state.chatHandoff && !state.checkout ? '<button class="text-button" data-action="chat-release">Return to chat</button>' : ''}</div></div>`;
  }
  function render() {
    const views = { accounts: renderAccounts, address: renderAddress, search: renderSearch, cart: renderCart, orders: renderOrders, tools: renderTools };
    $('#content').innerHTML = state.auth ? handoffBanner() + views[state.tab]() : renderConnection();
    renderNav();
    $('#connection-notice').hidden = true;
  }
  function clearChatLaunch() {
    state.chatLaunch = false;
    state.handoffError = '';
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('from');
      window.history.replaceState(null, '', url.toString());
    } catch {}
  }
  async function openChatDraft() {
    state.handoffError = '';
    try {
      let out;
      try { out = await api('chat-draft', 'POST', {}); }
      catch (e) {
        if (e.code !== 'PRO_DRAFT_REPLACEMENT_REQUIRED') throw e;
        if (!await confirmInApp({ title: 'Replace draft?', message: 'The chat draft will replace this cart and address.', confirmText: 'Open chat draft' })) return;
        out = await api('chat-draft', 'POST', { replace: true });
      }
      merge(out);
      state.tab = state.pendingAddress ? 'address' : 'cart';
      state.addresses = [];
      render();
      toast(state.pendingAddress ? 'Check the receiver details returned by the link.' : 'Chat draft opened. Review your cart and receiver.');
    } catch (e) {
      // A failed import may already own the chat draft. Refresh the marker so
      // the user can safely retry or explicitly return it to chat.
      try { merge(await api('bootstrap')); } catch {}
      state.handoffError = e.message || 'Could not open this draft.';
      state.tab = state.checkout || state.cart ? 'cart' : 'accounts';
      render();
      toast(state.handoffError);
    }
  }
  let attemptedChatLaunch = false;
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
    if (state.auth && state.chatLaunch && !attemptedChatLaunch) {
      attemptedChatLaunch = true;
      await run(openChatDraft);
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
      if (type === 'pool-user') {
        const userId = String(data.get('userId') || '').trim();
        if (!await confirmInApp({ title: 'Allow managed IDs?', message: `Allow Telegram user ${userId} to use the IDs you have explicitly shared?`, confirmText: 'Allow user' })) return;
        merge(await api('pool/user', 'POST', { userId, allowed: true })); render(); toast('Access granted.');
      } else if (type === 'send-otp') {
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
        merge(out); state.pendingAddress = null; state.contactEdit = false;
        if (state.chatHandoff && type === 'confirm-address') state.tab = 'cart';
        render(); toast('Receiver details selected.');
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
        try {
          const out = await api('cart/sync', 'POST', { coupon: data.get('coupon'), forSomeoneElse: data.has('forSomeoneElse'), confirmReplaceSwiggyCart: true });
          merge(out); render(); toast('Bill returned by Swiggy. Check it before paying.');
        } catch (e) {
          try { merge(await api('bootstrap')); } catch {}
          render(); throw e;
        }
      }
    }, button);
  }
  document.addEventListener('submit', forms);
  async function chooseAccount(key) {
    try {
      let out;
      try { out = await api('accounts/select', 'POST', { key }); }
      catch (e) {
        if (e.code !== 'PRO_ACCOUNT_CHANGE_REQUIRES_CONFIRMATION') throw e;
        if (!await confirmInApp({ title: 'Change Swiggy ID?', message: 'The old account’s selected address and bill will be cleared. Your draft items will stay.', confirmText: 'Change ID' })) return;
        out = await api('accounts/select', 'POST', { key, confirmClearAddress: true });
      }
      merge(out); state.addresses = []; state.orders = null;
    } finally { render(); }
  }
  document.addEventListener('change', event => {
    const select = event.target.closest('select[data-action="account-dropdown"]');
    if (select && select.value) run(() => chooseAccount(select.value), select);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action;
    if (action === 'account-dropdown') return;
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
      if (action === 'account-select') { await chooseAccount(button.dataset.key); }
      else if (action === 'account-check') {
        merge(await api('accounts/check', 'POST', { key: button.dataset.key })); render(); toast('Account check complete. Review the timestamp.');
      }
      else if (action === 'account-release') {
        if (!await confirmInApp({ title: 'Release this ID?', message: 'The current bill will be cleared. This ID becomes available for another order.', confirmText: 'Release ID' })) return;
        merge(await api('accounts/release', 'POST', { confirmRelease: true })); render(); toast('ID released.');
      }
      else if (action === 'pool-account') {
        const allowed = button.dataset.allowed === 'true';
        if (!await confirmInApp({ title: allowed ? 'Share this ID?' : 'Stop sharing this ID?', message: allowed ? 'Only explicitly authorized Telegram users may select it. They cannot see its credentials or saved addresses.' : 'Authorized users will no longer be able to select this shared ID.', confirmText: allowed ? 'Share ID' : 'Stop sharing' })) return;
        merge(await api('pool/account', 'POST', { key: button.dataset.key, allowed })); render(); toast(allowed ? 'ID shared.' : 'ID no longer shared.');
      }
      else if (action === 'pool-user-revoke') {
        const userId = button.dataset.id;
        if (!await confirmInApp({ title: 'Remove access?', message: `Remove managed-ID access for Telegram user ${userId}?`, confirmText: 'Remove access', danger: true })) return;
        merge(await api('pool/user', 'POST', { userId, allowed: false })); render(); toast('Access removed.');
      }
      else if (action === 'chat-import') await openChatDraft();
      else if (action === 'chat-release') {
        if (!await confirmInApp({ title: 'Return draft to chat?', message: 'The imported Mini App draft will be removed and you can continue with the original links in chat.', confirmText: 'Return to chat' })) return;
        merge(await api('chat-draft/release', 'POST', { confirmRelease: true })); clearChatLaunch(); state.tab = 'accounts'; render(); toast('Draft returned to chat.');
      }
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
          message: `Send one real Swiggy order request for ${money(quote.total)}?\nAccount: ${state.activeAccount.phone || state.activeAccount.name}\nReceiver: ${state.selectedAddress.name} · ${state.selectedAddress.mobile}\nAddress: ${state.selectedAddress.address}\nPayment is separate; recipient SMS is unverified. If the result is unknown, do not place another order until ${state.activeAccount.managed ? 'the owner checks the original account' : 'you check Swiggy My Orders'}.`,
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
        const out = await api('checkout/finish', 'POST', { confirmNewDraft: true }); merge(out); state.orders = null; state.ordersScope = 'active'; if (!state.chatHandoff) clearChatLaunch(); render();
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
