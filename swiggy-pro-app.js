/* Mini App client. All identity and account selection are verified server-side. */
(() => {
  'use strict';
  const tg = window.Telegram?.WebApp;
  try { tg?.ready(); tg?.expand(); } catch {}
  const initData = tg?.initData || '';
  const state = {
    tab: 'accounts', auth: false, authError: '', authErrorCode: '', connecting: false, user: null, accounts: [], activeAccount: null,
    selectedAddress: null, addresses: [], addressNote: '', pendingAddress: null, contactEdit: false, addressesLoading: false,
    cart: null, checkout: null, checkoutEnabled: false, mode: 'phone', otpSent: false, searchQuery: '', results: null, menu: null,
    menuLoading: false, orders: null, ordersScope: 'active', order: null, orderTracking: null, ordersLoading: false, ordersDetailAllowed: true,
    cachedAccounts: [], busy: false, loading: 0, resultsLoading: false, deleteFlow: null, claimBusyKey: '', claimResult: null, couponOpen: false, groupCartOpen: false,
    outlets: null, outletsOpen: false, outletsLoading: false
  };
  // Boss (31-10-2026): "ME KOI CHEEZ UPDATE KARU TO SAARA USER KA DATA RESET NA
  // HOJAYE, BAAKI RAHE UNKE PHONES ME." UI ka safe hissa (tab, theme, pehle
  // dikhe ID ke naam, search text) phone par rehta hai. Server hi asli source
  // hai; cache sirf itna batata hai ki pehle kya tha — koi secret nahi.
  const CACHE_KEY = 'pro-state-v2';
  function readCache() {
    try { const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return raw && raw.version === 2 ? raw : {}; } catch { return {}; }
  }
  function writeCache(patch) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), ...patch, version: 2, savedAt: new Date().toISOString() })); } catch {}
  }
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
    userplus:'<path d="M16 21a7 7 0 0 0-14 0"/><circle cx="9" cy="8" r="4"/><path d="M19 8v6M16 11h6"/>',
    coins:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
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
  function confirmInApp({ title, message, confirmText = 'Continue', danger = false, choices = null }) {
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
      actions.append(cancel);
      // Delete jaise case me do-teen asli option (boss 31-10-2026).
      const optionButtons = Array.isArray(choices) && choices.length
        ? choices.map(choice => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `button ${choice.danger ? 'danger' : 'primary'}`;
            btn.textContent = choice.label;
            btn.dataset.choice = choice.id;
            actions.append(btn);
            return btn;
          })
        : [];
      const confirm = document.createElement('button');
      confirm.type = 'button'; confirm.className = `button ${danger ? 'danger' : 'primary'}`; confirm.textContent = confirmText;
      if (!optionButtons.length) actions.append(confirm);
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
          const order = [cancel, ...optionButtons, ...(optionButtons.length ? [] : [confirm])];
          const at = order.indexOf(document.activeElement);
          if (at === -1) return;
          event.preventDefault();
          const next = event.shiftKey ? (at === 0 ? order.at(-1) : order[at - 1]) : (at === order.length - 1 ? order[0] : order[at + 1]);
          next.focus();
        }
      };
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      for (const btn of optionButtons) btn.addEventListener('click', () => finish(btn.dataset.choice));
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
    for (const key of ['user','accounts','activeAccount','selectedAddress','cart','checkout','checkoutEnabled','checkoutBlockReason','ordersDetailAllowed','adminContact']) if (Object.hasOwn(data, key)) state[key] = data[key];
    if (Array.isArray(data.accounts)) {
      state.cachedAccounts = data.accounts.map(a => ({ key: a.key, name: a.name, phoneMasked: a.phoneMasked || '', owner: a.owner || 'self' }));
      writeCache({ accounts: state.cachedAccounts });
    }
  }
  // Boss (31-10-2026): "JAISE YOUTUBE PAR NET NA HO" — har load par upar patli
  // progress bar, aur content me skeleton. Koi button bina feedback nahi.
  function startLoading() {
    state.loading += 1;
    try {
      const bar = document.getElementById('loadbar');
      if (bar) bar.hidden = false;
      document.body.classList.add('is-loading');
    } catch { /* window band ho gaya */ }
  }
  function stopLoading() {
    state.loading = Math.max(0, state.loading - 1);
    if (state.loading) return;
    try {
      const bar = document.getElementById('loadbar');
      if (bar) bar.hidden = true;
      document.body.classList.remove('is-loading');
    } catch { /* window band ho gaya */ }
  }
  async function run(task, button) {
    if (state.busy) return;
    state.busy = true;
    if (button) button.disabled = true;
    if (button) button.classList.add('button-busy');
    startLoading();
    try { await task(); } catch (e) {
      if (['PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED'].includes(e?.code)) {
        state.auth = false; state.authError = e.message; state.authErrorCode = e.code; render();
      } else toast(e.message || 'Something went wrong.');
    } finally {
      state.busy = false;
      if (button?.isConnected) { button.disabled = false; button.classList.remove('button-busy'); }
      stopLoading();
    }
  }
  // Boss (31-10-2026, dusra round): "ADMIN SE BAAT KARO WALA BUTTON HATAO."
  // App ke andar sirf app ka kaam — koi support button nahi.
  function skeletonRows(count = 3, lines = 2) {
    return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: count }).map(() => `<div class="skeleton-row"><span class="skeleton-tile"></span><span class="skeleton-copy">${Array.from({ length: lines }).map((_, i) => `<span class="skeleton-line${i ? ' short' : ''}"></span>`).join('')}</span></div>`).join('')}</div>`;
  }
  function field(label, name, placeholder, value = '', extra = '') {
    return `<label class="field"><span class="field-label">${esc(label)}</span><span class="input-wrap"><input name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${extra}></span></label>`;
  }
  function addressLabel(a) { return a?.annotation || 'Delivery address'; }
  const normName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  /**
   * Boss (31-10-2026): "RESTAURANT KA LOCATION CHOOSE KARNE WALA SEARCH PAR
   * CLICK KARKE RESTAURANT KHOLU TAB DENA". Swiggy jaisa: ek naam ke kai
   * outlet ho to pehle location sheet, phir menu.
   */
  function openOutletSheet(name, outlets, currentId = '') {
    document.querySelector('.sheet-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    const sheet = document.createElement('section');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Choose outlet');
    sheet.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head"><div><p class="eyebrow">CHOOSE LOCATION</p><h2>${esc(name)}</h2><p>${outlets.length} outlets aapke address ke paas — kaunsa?</p></div><button class="icon-button" type="button" data-sheet-close aria-label="Band karein">${icon('close')}</button></div>
      <div class="sheet-list">${outlets.map(o => `<button class="sheet-option${String(o.id) === String(currentId) ? ' current' : ''}" type="button" data-sheet-outlet="${esc(o.id)}" ${o.isOpen === false ? 'disabled' : ''}>
        <span class="sheet-pin">${icon('address')}</span>
        <span class="row-content"><strong>${esc(o.area || o.name)}</strong><small>${esc([o.distance, o.time, o.isOpen === false ? 'Closed' : ''].filter(Boolean).join(' · '))}</small></span>
        ${String(o.id) === String(currentId) ? '<span class="pill green">Yahi</span>' : o.isOpen === false ? '<span class="pill grey">Closed</span>' : icon('arrow')}
      </button>`).join('')}</div>`;
    overlay.append(sheet);
    document.body.append(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-sheet-close]')) { overlay.remove(); return; }
      const pick = event.target.closest('[data-sheet-outlet]');
      if (!pick) return;
      overlay.remove();
      run(() => openMenu(pick.dataset.sheetOutlet));
    });
  }
  async function openMenu(id) {
    state.menuLoading = true; render();
    try { state.menu = await api('menu?id=' + encodeURIComponent(id)); }
    finally { state.menuLoading = false; }
    state.tab = 'search'; writeCache({ tab: 'search' });
    render(); window.scrollTo(0, 0);
  }
  /** Search results me same naam ke saare outlet — sheet ke liye. */
  function outletsForName(name) {
    const target = normName(name);
    return (state.results || []).filter(r => r.id && normName(r.name) === target);
  }
  function renderNav() {
    const tabs = [['accounts','Accounts'],['address','Address'],['search','Search'],['cart','Cart'],['orders','Orders'],['tools','Tools']];
    $('#bottom-nav').innerHTML = tabs.map(([id, label]) => `<button type="button" data-action="nav" data-tab="${id}" class="${state.tab === id ? 'selected' : ''}" ${state.tab === id ? 'aria-current="page"' : ''} ${state.auth ? '' : 'disabled'}>${icon(id)}<span>${label}</span></button>`).join('');
    const chip = $('#account-chip');
    const chipPhone = state.activeAccount?.phone || state.activeAccount?.phoneMasked || '';
    chip.textContent = state.auth ? (chipPhone ? `+91 ${chipPhone}` : 'Select account') : 'Not connected';
    chip.disabled = !state.auth;
    const cart = state.auth ? state.cart : null;
    const quantity = cart?.items?.reduce((n, i) => n + Number(i.qty || 0), 0) || 0;
    $('#cart-dock').innerHTML = cart && quantity && state.tab !== 'cart' ? `<button type="button" class="cart-dock" data-action="nav" data-tab="cart"><span class="dock-icon">${icon('cart')}</span><span class="dock-copy"><strong>${quantity} item${quantity === 1 ? '' : 's'} · ${esc(cart.restaurantName)}</strong><small>${cart.quote ? `Swiggy bill ${money(cart.quote.total)}` : 'Bill not checked yet'}</small></span><span class="dock-cta">View cart →</span></button>` : '';
  }
  function renderAccounts() {
    const intro = head('YOUR SPACE', 'Accounts', 'Add a Swiggy account to start ordering.');
    const lockedNotice = cartLocked() ? '<div class="warning">Checkout pending or unknown hai. Account switching locked hai; sirf wahi original account dobara connect ho sakta hai.</div>' : '';
    const controls = state.mode === 'phone'
      ? `<form data-form="${state.otpSent ? 'verify-otp' : 'send-otp'}">${state.otpSent
          ? `${field('OTP from Swiggy', 'otp', 'Enter 6-digit OTP', '', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required')}<p class="hint">OTP Swiggy bhejta hai. Kisi ko na batayein.</p><button class="button primary block" type="submit">Verify & add account ${icon('arrow')}</button><button class="text-button" type="button" data-action="otp-reset">Change mobile number</button>`
          : `<label class="field"><span class="field-label">Mobile number</span><span class="input-wrap"><span class="phone-prefix">+91</span><input name="phone" placeholder="Enter mobile number" inputmode="tel" autocomplete="tel-national" required></span></label><button class="button primary block" type="submit">Send OTP ${icon('arrow')}</button>`}</form>`
      : `<form data-form="import"><label class="field"><span class="field-label">Session JSON</span><span class="input-wrap"><textarea name="session" placeholder='{"mobile":"…", "token":"…", "tid":"…"}' required></textarea></span></label><p class="hint">Sirf apni session use karein. Token/OTP chat me kabhi na bhejein.</p><button class="button primary block" type="submit">Login via JSON ${icon('arrow')}</button></form>`;
    const statusPill = (a) => {
      const cls = a.status === 'READY' ? 'green' : (a.status === 'USED' ? 'grey' : (a.status === 'UNVERIFIED' || a.status === 'BUSY' ? 'amber' : 'red'));
      return `<span class="pill ${cls}">${esc(a.status || '—')}</span>`;
    };
    const rows = state.accounts.length ? state.accounts.map(a => {
      const blocked = a.selectable === false;
      // Used ID: pehle warning, phir select (boss 31-10-2026). Suspended /
      // expired / busy ID band hi rehti hai.
      const needsConfirm = a.needsConfirm === true;
      // Boss (31-10-2026): "OPERATOR AND OFFER KE LIYE ICON SELECTED HO, AUR
      // AGAR NA HO TO WO CUT KARDE." Claim hua = green tick, nahi hua = kati
      // hui line.
      const trackIcons = (a.offerTracks || []).map(t => {
        const on = t.verified === true || ['CLAIMED', 'ALREADY_ACTIVE', 'ACTIVE'].includes(String(t.status || '').toUpperCase());
        return `<span class="offer-chip ${on ? 'on' : 'off'}" title="${esc(t.label)}">${t.emoji || '🎁'}${on ? ' ✓' : ''}</span>`;
      }).join('');
      const extras = [a.freeCash > 0 ? `💵 ₹${esc(a.freeCash)}` : '', trackIcons].filter(Boolean).join(' ');
      const phoneLine = a.phone ? '+91 ' + esc(a.phone) : a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : 'Number not returned';
      const ownerPill = `<span class="pill ${a.owner === 'operator' ? 'blue' : ''}">${a.owner === 'operator' ? 'Operator' : 'Aapka'}</span>`;
      const claimNote = a.canClaim === false ? '<span class="pill grey">Claim: sirf operator</span>' : '';
      const action = a.active
        ? '<span class="pill green">Active</span>'
        : (needsConfirm
            ? `<button class="button mini warn" data-action="account-select" data-key="${esc(a.key)}" data-confirm-used="1" ${cartLocked() ? 'disabled' : ''}>Use</button>`
            : (blocked
                ? '<span class="pill grey">Not available</span>'
                : `<button class="button mini outline" data-action="account-select" data-key="${esc(a.key)}" ${cartLocked() ? 'disabled' : ''}>Use</button>`));
      const remove = a.canRemove === false ? '' : `<button class="icon-button" data-action="account-remove" data-key="${esc(a.key)}" aria-label="Remove account" ${cartLocked() ? 'disabled' : ''}>${icon('trash')}</button>`;
      return `<div class="account-row ${a.active ? 'active' : ''} ${blocked && !needsConfirm ? 'is-blocked' : ''}"${blocked && !needsConfirm ? ' style="opacity:.55"' : ''}>${tile('accounts', true)}<div class="row-content"><strong>${esc(a.name)} ${a.icons ? esc(a.icons) : ''}${a.active ? '' : ' ' + statusPill(a)}</strong><p>${phoneLine}${a.reason ? ' · ' + esc(a.reason) : ''}</p><p class="pill-line">${ownerPill}${claimNote}</p>${extras ? `<p>${extras}</p>` : ''}</div><div class="row-actions">${action}${remove}</div></div>`;
    }).join('') : empty('accounts', 'No accounts yet', 'Apna account OTP se ya verified session JSON se add karein.');
    // Server par account na mile par phone par pehle dikha tha — chup-chaap
    // khaali screen nahi, seedha batao ki kya hua.
    const remembered = state.accounts.length ? '' : (state.cachedAccounts || []).map(a =>
      `<div class="account-row is-blocked">${tile('accounts', true)}<div class="row-content"><strong>${esc(a.name || 'Saved ID')} <span class="pill grey">RE-LOGIN</span></strong><p>${a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : 'Saved on this phone'} · Server par session nahi mila — ye ID dobara add karni hogi (data delete nahi hua).</p></div></div>`
    ).join('');
    const rememberedNote = remembered ? `<div class="warning">Aapke phone par pehle se saved ID mili. Session server par nahi hai — neeche wahi number daal kar OTP se dobara add karein.</div>${remembered}` : '';
    return `${intro}${lockedNotice}<div class="card"><div class="card-title">${tile('userplus')}<span class="title-copy">Add account<small>${state.user?.isBoss ? 'Shared operator vault me jata hai' : 'Sirf aapko dikhta hai — kisi doosre user ko nahi'}</small></span></div><div class="divider"></div><div class="segmented"><button type="button" data-action="account-mode" data-mode="phone" class="${state.mode === 'phone' ? 'selected' : ''}">Phone number</button><button type="button" data-action="account-mode" data-mode="json" class="${state.mode === 'json' ? 'selected' : ''}">Session JSON</button></div>${controls}<p class="hint">Ye server-side session add karta hai; aapke phone ka Swiggy app login nahi hota.</p></div><div class="line-heading">${icon('accounts')} Saved accounts <span class="pill right">${state.accounts.length}</span></div>${rememberedNote}${rows}${state.deleteFlow ? `<div class="card delete-card"><div class="card-title">${icon('trash')} Swiggy delete OTP<small>Swiggy ne ${esc(state.deleteFlow.phoneMasked || 'account phone')} par 6-digit delete OTP bheja hai. Ye account Swiggy se hamesha ke liye delete ho jayega.</small></div><form data-form="delete-otp">${field('Delete OTP', 'otp', '6-digit OTP', '', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required')}<button class="button danger block" type="submit">Swiggy se delete karein ${icon('trash')}</button><button class="text-button" type="button" data-action="delete-cancel">Cancel</button></form></div>` : ''}`;
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
    const list = state.addressesLoading ? skeletonRows(3, 2) : state.addresses.length ? state.addresses.map(a => addressCard(a)).join('') : `<div class="empty">${esc(state.addressNote || 'Refresh dabaiye — saved address Swiggy se aate hain.')}</div>`;
    return `${head('WHERE TO?', 'Delivery addresses', 'Choose the right person and place.')}${lockedNotice}${selected}${contact}<div class="card"><div class="card-title">${tile('link')}<span class="title-copy">Add by address link<small>Paste the Swiggy share-address link.</small></span></div><form data-form="address-link">${field('Swiggy address link', 'url', 'https://swiggy.onelink.me/…', '', 'type="url" required ' + lockAttr)}<button class="button primary block" ${lockAttr}>Read address ${icon('arrow')}</button></form></div>${pending}<div class="line-heading">${icon('address')} Saved addresses <button class="text-button right" data-action="addresses-refresh">${icon('refresh')} Refresh</button></div>${list}`;
  }
  function renderSearch() {
    if (state.menuLoading) {
      // Weak network par khaali screen nahi — skeleton dikhta hai (boss
      // 31-10-2026: "LAZY LOAD JAB NETWORK WEAK HO").
      return `${head('RESTAURANT', 'Menu load ho raha hai', 'Swiggy se menu aa raha hai — ruk jaayein.')}<div class="skeleton-hero" aria-hidden="true"></div>${skeletonRows(4, 2)}`;
    }
    if (state.menu) {
      const r = state.menu.restaurant;
      const avail = r.isOpen === false ? `<div class="warning">${esc(r.opens || 'This restaurant is closed right now.')}</div>` : '';
      // Boss (31-10-2026): "ITEM SEARCH KAR SAKE… AUR SO ON." Menu ke andar hi
      // dish search + same restaurant ke doosre outlets ke chips.
      const sections = state.menu.categories.map(c => `<section data-category-block><div class="menu-category">${esc(c.title)} <span class="pill">${c.items.length}</span></div>${c.items.map(i => `<article class="dish-row" data-menu-item data-name="${esc(String(i.name || '').toLowerCase())}"><div class="row-content">${i.isVeg === null ? '' : `<span class="veg-mark ${i.isVeg ? '' : 'nonveg'}" aria-label="${i.isVeg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`}<strong>${esc(i.name)}</strong><div class="dish-price">${i.price === null ? 'Price unavailable' : money(i.price)}</div><p class="dish-description">${esc(i.description)}</p></div><div class="dish-right">${i.image ? `<img class="food-thumb" src="${esc(i.image)}" alt="" loading="lazy" decoding="async">` : `<span class="food-placeholder">${icon('store')}</span>`}<button class="button mini outline" data-action="dish-add" data-id="${esc(i.id)}" ${cartLocked() || r.isOpen === false || i.inStock === false || i.customizable || i.price === null ? 'disabled' : ''}>${cartLocked() ? 'Checkout pending' : i.inStock === false ? 'Sold out' : i.customizable ? 'Choices needed' : 'ADD +'}</button></div></article>`).join('')}</section>`).join('');
      const outletKey = String(r.name || '').trim().toLowerCase();
      const outlets = (state.results || []).filter(o => String(o.name || '').trim().toLowerCase() === outletKey && String(o.id) !== String(r.id));
      const outletChips = outlets.length
        ? `<div class="card"><div class="card-title">${tile('store')}<span class="title-copy">Ye restaurant ${outlets.length + 1} location par hai<small>Doosra outlet chunein — menu alag ho sakta hai.</small></span></div><div class="chips">${outlets.map(o => `<button class="chip" data-action="restaurant" data-id="${esc(o.id)}">${esc(o.area || o.id)}${o.distance ? ' · ' + esc(o.distance) : ''}</button>`).join('')}</div></div>`
        : '';
      return `<button class="back-button" data-action="menu-back">${icon('back')} Back to search</button><div class="menu-hero"><p>RESTAURANT · ${esc(r.area)}</p><h1>${esc(r.name)}</h1><p>${esc([r.rating ? '★ ' + r.rating : '', r.ratings, r.time].filter(Boolean).join(' · '))}</p></div><button class="outlet-row menu-outlet-row" type="button" data-action="menu-outlets"><span class="outlet-pin">${icon('address')}</span><span class="outlet-copy"><strong>${esc(r.area || 'Location')}</strong><small>${esc([outlets.length ? `${outlets.length + 1} outlets` : '', 'Location badlein'].filter(Boolean).join(' · '))}</small></span><span class="outlet-caret">Change ▾</span></button>${avail}${outletChips}<div class="input-wrap menu-search">${icon('search')}<input type="search" data-input="menu-search" placeholder="Is restaurant me dish search karein…" aria-label="Search dishes"></div><p class="hint">Jo item custom choices maangta hai wo Swiggy me order karein — yahan support baad me aayega.</p>${sections}`;
    }
    const addr = state.selectedAddress ? `<button class="action-tile" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><small>DELIVER TO</small><strong>${esc(addressLabel(state.selectedAddress))}</strong><small>${esc(state.selectedAddress.address)}</small></span>${icon('arrow')}</button>` : `<button class="action-tile" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><strong>Select a delivery address</strong><small>Restaurant availability depends on your location.</small></span>${icon('arrow')}</button>`;
    let results;
    if (state.resultsLoading) {
      results = skeletonRows(4, 2);
    } else if (state.results === null) {
      results = `${empty('store', 'Find something delicious', 'Search for a restaurant to see its menu and build a cart.')}<p class="eyebrow">Popular searches</p><div class="chips">${["Domino's",'KFC',"McDonald’s",'Pizza Hut','Burger King','Subway'].map(q => `<button class="chip" data-action="popular" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    } else if (!state.results.length) {
      results = empty('search', 'No restaurants returned', 'Try another search or check the selected address.');
    } else {
      // Boss (31-10-2026): "RESTAURANT KA ALAG ALAG LOCATION HO TO CHUN SAKE."
      // Ek hi naam ke outlets alag rows rehte hain (apna area/distance ke saath)
      // aur un par "N locations" ka pill dikhta hai.
      const nameCounts = new Map();
      for (const r of state.results) {
        const name = String(r.name || '').trim().toLowerCase();
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }
      results = `<div class="line-heading">${state.results.length} restaurant${state.results.length === 1 ? '' : 's'}</div>${state.results.map(r => {
        const outlets = nameCounts.get(String(r.name || '').trim().toLowerCase()) || 1;
        return `<button class="restaurant-row" data-action="restaurant" data-id="${esc(r.id)}" data-name="${esc(r.name)}">${r.image ? `<img class="food-thumb" src="${esc(r.image)}" alt="" loading="lazy" decoding="async">` : `<span class="food-placeholder">${icon('store')}</span>`}<span class="row-content"><strong>${esc(r.name)}</strong>${outlets > 1 ? ` <span class="pill blue">${outlets} locations</span>` : ''}<p>${esc([r.rating ? '★ ' + r.rating : '',r.ratings].filter(Boolean).join(' · '))}</p><p>${esc(r.cuisines)}</p><p>${esc([r.area,r.distance,r.time].filter(Boolean).join(' · '))}</p><p class="${r.isOpen === true ? 'status-open' : r.isOpen === false ? 'status-closed' : 'status-unknown'}">${r.isOpen === true ? 'Open' : r.isOpen === false ? esc(r.opens || 'Closed') : 'Availability not returned'}</p></span>${icon('arrow')}</button>`;
      }).join('')}`;
    }
    return `${head('DISCOVER', 'Find a restaurant', 'Good food, a little closer to home.')}${addr}<form class="search-form" data-form="search"><span class="input-wrap">${icon('search')}<input name="q" value="${esc(state.searchQuery)}" placeholder="Search for restaurants…" required></span><button class="button primary" aria-label="Search">${icon('arrow')}</button></form>${results}`;
  }
  function trackingDetails(t) {
    if (!t) return '<p class="hint">Swiggy has not returned tracking details yet.</p>';
    // Boss (31-10-2026): "AMMI ABBU KO APP SE BAHAR NAHI JAANA HAI." Tracking
    // bhi yahin dikhti hai — koi browser link nahi.
    return `<div class="bill-row"><span>Status</span><strong>${esc(t.status || 'Not returned')}</strong></div>${t.eta ? `<div class="bill-row"><span>ETA</span><strong>${esc(t.eta)}</strong></div>` : ''}${t.deliveryPartner?.name ? `<div class="bill-row"><span>Delivery partner</span><strong>${esc(t.deliveryPartner.name)}</strong></div>` : ''}${t.deliveryPartner?.phone ? `<div class="bill-row"><span>Partner phone</span><strong>${esc(t.deliveryPartner.phone)}</strong></div>` : ''}${t.deliveryOtp ? `<div class="bill-row"><span>Delivery OTP</span><strong>${esc(t.deliveryOtp)}</strong></div>` : ''}<p class="hint">Tracking sab yahin — Swiggy ke bahar kuch kholne ki zaroorat nahi.</p>`;
  }
  function renderCheckout() {
    const c = state.checkout;
    if (!c) {
      // App ke andar hi rehna hai (boss 31-10-2026) — Swiggy bahar nahi kholte.
      if (!state.checkoutEnabled) return `<div class="card"><div class="card-title">${icon('cart')} Payment</div><div class="warning">In-app checkout abhi band hai, isliye ye draft order nahi hai. Bill upar se check karein — paisa nahi katega.</div></div>`;
      return `<div class="card"><div class="card-title">${icon('cart')} UPI checkout</div><p class="hint">Experimental: one real placement request is sent after your confirmation. Swiggy may notify the recipient. Check all details before continuing.</p><button class="button green block" type="button" data-action="checkout-start" ${state.cart?.quote ? '' : 'disabled'}>Place order & get UPI QR ${icon('arrow')}</button><p class="hint">A bill is not an order. Card and cash payments are not supported here.</p></div>`;
    }
    const id = `${c.accountPhone ? `<div class="bill-row"><span>Original account</span><strong>${esc(c.accountPhone)}</strong></div>` : ''}${c.orderId ? `<div class="bill-row"><span>Swiggy order ID</span><strong>#${esc(c.orderId)}</strong></div>` : ''}`;
    const warning = `<p class="hint">${esc(c.message || '')}</p>`;
    if (c.status === 'PAID') return `<div class="card"><div class="card-title">${icon('check')} Payment verified</div>${id}${warning}${trackingDetails(c.tracking)}<button class="button outline block" data-action="checkout-finish">Start a new draft</button></div>`;
    if (c.status === 'PAYMENT_PENDING') {
      const qr = c.qrDataUrl && /^data:image\/png;base64,/.test(c.qrDataUrl) && c.upiIntentUrl && /^upi:\/\/pay\?/i.test(c.upiIntentUrl)
        ? `<img class="payment-qr" src="${esc(c.qrDataUrl)}" alt="Swiggy UPI payment QR"><a class="button green block" href="${esc(c.upiIntentUrl)}">Open UPI app</a><p class="hint">Pay ${money(c.amount)} only once. If your UPI app cannot open here, scan this QR with another device.</p>` : '';
      const paidNote = c.paymentVerified ? '<div class="warning">Payment was reported, but order confirmation is still pending. Do not pay again.</div>' : '';
      return `<div class="card"><div class="card-title">${icon('receipt')} Payment pending</div>${id}${warning}${paidNote}${qr}<p class="hint">${c.ofoConfirmed ? 'Swiggy returned an OFO flag; recipient SMS is not verified.' : 'Swiggy has not confirmed OFO acceptance or recipient SMS.'}</p><button class="button primary block" data-action="checkout-status">Check payment & order ${icon('refresh')}</button><button class="button soft block" data-action="checkout-orders">Check original account's orders here</button></div>`;
    }
    return `<div class="card"><div class="card-title">${icon('receipt')} Checkout needs checking</div>${id}<div class="warning">${esc(c.message || 'The result is unknown. An order may exist; do not place another.')}</div>${c.orderId ? `<button class="button primary block" data-action="checkout-status">Check this order ${icon('refresh')}</button>` : ''}<button class="button soft block" data-action="checkout-orders">Check original account's orders here</button></div>`;
  }
  /**
   * Boss (31-10-2026): "CART WALA PAGE JAISA DIKHAYA WAISA HI — OPTION BAHUT
   * CONFUSING HAI." Ab cart Swiggy ke cart jaisa seedha hai: group cart,
   * delivering to, your order, apply coupon, bill, payment method, pay bar.
   */
  function renderBill(q, cart) {
    if (!q) return `<div class="warning">Ye sirf draft cart hai. Total, offer aur delivery fee abhi Swiggy ne confirm nahi ki — neeche <b>Check bill</b> dabaiye.</div>`;
    const deliveryFree = q.deliveryFee === 0 || q.deliveryFee === null;
    const itemBefore = q.itemTotal !== null && q.discount ? Number(q.itemTotal) + Number(q.discount) : null;
    const distance = q.deliveryDistance ? ` <small>${esc(q.deliveryDistance)}</small>` : '';
    return `<div class="card bill-card"><div class="card-title">${icon('receipt')} Bill Details <button class="icon-button right" type="button" data-action="bill-refresh" aria-label="Refresh bill">${icon('refresh')}</button></div><div class="divider"></div><div class="bill-row"><span>Item Total</span><strong>${itemBefore !== null ? `<s>${money(itemBefore)}</s> ${money(q.itemTotal)}` : money(q.itemTotal)}</strong></div><div class="bill-row"><span>Delivery Fee${distance}</span><strong class="${deliveryFree ? 'free' : ''}">${deliveryFree ? 'FREE' : money(q.deliveryFee)}</strong></div><div class="bill-row"><span>GST &amp; Other Charges</span><strong>${money(q.taxesAndCharges ?? ((Number(q.packingCharges) || 0) + (Number(q.taxes) || 0)))}</strong></div>${q.discount ? `<div class="bill-row saving"><span>Coupon ${esc(q.coupon || '')}</span><strong>−${money(q.discount)}</strong></div>` : ''}${q.unlistedDiscount ? `<div class="bill-row saving"><span>Offer saving</span><strong>−${money(q.unlistedDiscount)}</strong></div>` : ''}${q.discountAlreadyApplied ? '<p class="hint">Coupon ka fayda Item Total me pehle se hai.</p>' : ''}<div class="bill-row total"><span>To Pay</span><span>${money(q.total)}</span></div><p class="hint">Swiggy se aaya bill. Bill badal sakta hai; pay se pehle dobara check karein.${cart.forSomeoneElse ? ' OFO acceptance is bill se confirm nahi hota.' : ''}</p></div>`;
  }
  function renderPayment(cart) {
    const ready = Boolean(state.cart?.quote) && !cartLocked();
    return `<div class="card"><div class="card-title">${icon('receipt')} Payment Method</div><div class="divider"></div><div class="pay-option selected"><span class="icon-tile">${icon('check')}</span><span class="pay-copy"><strong>UPI / QR</strong><small>PhonePe, Paytm, CRED &amp; koi bhi UPI app</small></span><span class="pay-check">${icon('check')}</span></div><div class="pay-option disabled"><span class="icon-tile">${icon('receipt')}</span><span class="pay-copy"><strong>Credit / Debit Card</strong><small>Visa, Mastercard, RuPay · OTP bank se — app se abhi nahi hota</small></span></div><div class="pay-option disabled"><span class="icon-tile">${icon('coins')}</span><span class="pay-copy"><strong>Cash on Delivery</strong><small>Is app se nahi hota — UPI se pay karein</small></span></div><p class="hint">${ready ? 'Neeche Pay Now dabane par Swiggy ek asli order request banata hai. Payment alag se UPI se hoti hai.' : 'Pehle bill check karein — bill confirm hone ke baad hi payment step khulta hai.'}</p></div>`;
  }
  function renderCart() {
    const cart = state.cart;
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    const lockedNotice = locked ? '<div class="warning">Checkout pending ya unknown hai. Cart/receiver changes band hain; pehle original account check karein.</div>' : '';
    // Swiggy me ye ek patli line hoti hai — dabane par link box khulta hai.
    const groupCard = `<div class="card group-cart-card"><button class="group-cart-toggle" type="button" data-action="toggle-group-cart" aria-expanded="${state.groupCartOpen ? 'true' : 'false'}"><span class="icon-tile">${icon('link')}</span><span class="title-copy">Add Items from Group Cart<small>${state.groupCartOpen ? 'Swiggy group cart ka link paste karein.' : 'Group cart ka link hai? Yahan se add karein.'}</small></span><span class="outlet-caret">${state.groupCartOpen ? '▴' : '▾'}</span></button>${state.groupCartOpen ? `<form data-form="group-cart"><span class="input-wrap"><input name="url" type="url" placeholder="https://www.swiggy.com/…" required ${lockAttr}></span><button class="button primary" type="submit" aria-label="Import group cart" ${lockAttr}>${icon('arrow')}</button></form>` : ''}</div>`;
    const delivery = `<button class="action-tile" type="button" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><small>DELIVERING TO</small><strong>${esc(state.selectedAddress ? addressLabel(state.selectedAddress) : 'Address chunein')}</strong><small>${esc(state.selectedAddress ? (state.selectedAddress.address || '') : 'Order ke liye address zaroori hai')}</small></span>${icon('arrow')}</button>`;
    if (!cart) {
      return `${head('YOUR ORDER', 'Cart', 'Group cart se items add karein ya restaurant search karein.')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${groupCard}${state.selectedAddress ? delivery : ''}${empty('cart', 'Cart khaali hai', 'Restaurant search karein ya group cart link paste karein.')}`;
    }
    const quantity = cart.items.reduce((n, i) => n + Number(i.qty || 0), 0);
    // Boss (31-10-2026): Swiggy cart jaisa item row — veg mark + naam left,
    // green stepper + item ka total right.
    const items = cart.items.map(i => {
      const veg = i.isVeg === true ? '<span class="veg-mark" aria-label="Vegetarian"></span>' : i.isVeg === false ? '<span class="veg-mark nonveg" aria-label="Non-vegetarian"></span>' : '';
      const lineTotal = i.price === null ? '—' : money(Number(i.price) * Number(i.qty || 1));
      return `<div class="cart-item"><div class="row-content">${veg}<strong>${esc(i.name)}</strong><p>${i.price === null ? 'Price unavailable' : money(i.price) + ' each'}${(i.variants?.length || i.addons?.length) ? ' · Customised' : ''}</p></div><div class="cart-item-right"><div class="stepper"><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)-1}" aria-label="Remove one" ${lockAttr}>−</button><span>${Number(i.qty)}</span><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)+1}" aria-label="Add one" ${lockAttr}>+</button></div><strong class="line-total">${lineTotal}</strong></div></div>`;
    }).join('');
    const q = cart.quote;
    const meta = [cart.restaurantArea, cart.restaurantTime].filter(Boolean).join(' · ');
    // Ek restaurant ke kai franchise — location ka naam + dropdown.
    const outletRow = `<button class="outlet-row" type="button" data-action="outlets-toggle" aria-expanded="${state.outletsOpen ? 'true' : 'false'}"><span class="outlet-pin">${icon('address')}</span><span class="outlet-copy"><strong>${esc(cart.restaurantArea || cart.restaurantName)}</strong><small>${esc([cart.restaurantTime, 'Outlet badlein'].filter(Boolean).join(' · '))}</small></span><span class="outlet-caret">${state.outletsOpen ? '▴' : '▾'}</span></button>${state.outletsOpen ? (state.outletsLoading ? skeletonRows(2, 1) : `<div class="outlet-list">${(state.outlets || []).length ? state.outlets.map(o => `<button class="outlet-option ${String(o.id) === String(cart.restaurantId) ? 'current' : ''}" type="button" data-action="outlet-pick" data-id="${esc(o.id)}" data-name="${esc(o.name)}" ${String(o.id) === String(cart.restaurantId) || o.isOpen === false ? 'disabled' : ''}><span class="row-content"><strong>${esc(o.area || o.name)}</strong><small>${esc([o.distance, o.time, o.isOpen === false ? 'Closed' : ''].filter(Boolean).join(' · '))}</small></span>${String(o.id) === String(cart.restaurantId) ? '<span class="pill green">Yahi</span>' : o.isOpen === false ? '<span class="pill grey">Closed</span>' : '<span class="pill blue">Chunein</span>'}</button>`).join('') : '<p class="hint">Aas-paas koi doosra outlet nahi mila.</p>'}</div>`)+ '' : ''}`;
    const restaurantCard = `<div class="card restaurant-cart"><div class="cart-restaurant-head"><span class="cart-restaurant-thumb">${cart.restaurantImage ? `<img src="${esc(cart.restaurantImage)}" alt="" loading="lazy" decoding="async">` : icon('store')}</span><span class="row-content"><strong>${esc(cart.restaurantName)}</strong><p>${esc(meta || 'Restaurant')}</p></span><button class="icon-button danger" type="button" data-action="cart-clear" aria-label="Cart clear karein" ${lockAttr}>${icon('trash')}</button></div>${outletRow}${items}<button class="text-button add-more" type="button" data-action="nav" data-tab="search">${icon('plus')} Add more items</button></div>`;
    const couponCard = `<div class="card coupon-card"><button class="action-tile bare" type="button" data-action="toggle-coupon">${tile('receipt')}<span class="tile-copy"><strong>Apply coupon</strong><small>${q?.coupon ? `Laga hua: ${esc(q.coupon)}` : 'Is restaurant ke offers dekhein'}</small></span>${icon('arrow')}</button>${state.couponOpen ? `<form data-form="sync">${field('Coupon code', 'coupon', 'Enter coupon code', q?.coupon || '', lockAttr)}<label class="checkbox-row"><input type="checkbox" name="forSomeoneElse" ${cart.forSomeoneElse ? 'checked' : ''} ${lockAttr}><span>Kisi aur ke liye order (selected receiver)</span></label><button class="button primary block" ${lockAttr}>Apply &amp; check bill ${icon('refresh')}</button></form>` : ''}</div>`;
    const billCard = renderBill(q, cart);
    // Boss (31-10-2026): "JAISE SWIGGY KE APP ME DIKHTA CHECKOUT PAGE WAISA KARNA
    // SAME AND PAY NOW KA BUTTON ACTIVE KARNA." Isliye ye page ab checkout hai:
    // ETA strip → address → Your Order → coupon → bill → payment → Pay Now.
    const eta = `<div class="eta-strip"><span class="eta-clock">${icon('orders')}</span><span class="eta-copy"><strong>${cart.restaurantTime ? `Delivery in ${esc(cart.restaurantTime)}` : 'Delivery time Swiggy se aayega'}</strong><small>${esc([cart.restaurantName, cart.restaurantArea].filter(Boolean).join(' · '))}</small></span><span class="pill">${esc(state.selectedAddress ? 'Deliver to ' + addressLabel(state.selectedAddress) : 'Address chunein')}</span></div>`;
    // Pay Now hamesha maujood aur chalta hua — bill na ho to pehle bill aata hai.
    const payBar = `<div class="pay-bar"><div><small>${q ? 'PAY USING UPI' : 'TO PAY'}</small><strong>${q ? money(q.total) : '—'}</strong>${q ? '' : '<em class="pay-note">Bill check hoga</em>'}</div>${state.checkoutEnabled
      ? `<button class="button green" type="button" data-action="checkout-start" ${locked ? 'disabled' : ''}>Pay Now ${icon('arrow')}</button>`
      : `<button class="button soft" type="button" disabled title="${esc(state.checkoutBlockReason || '')}">Payment band</button>`}</div>`;
    return `${head('CHECKOUT', 'Checkout', 'Address, bill aur payment — sab yahin.')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${eta}${delivery}${groupCard}<div class="line-heading">${icon('cart')} Your Order <span class="pill right">${quantity} item${quantity === 1 ? '' : 's'}${q ? ' · ' + money(q.total) : ''}</span></div>${restaurantCard}${couponCard}${billCard}${renderPayment(cart)}${payBar}`;
  }
  function renderOrders() {
    const detailed = state.ordersDetailAllowed !== false;
    const restrictedNote = detailed ? '' : '<div class="warning">Ye operator ka ID hai. Aapko sirf chhota summary card dikhta hai — address, item list aur tracking sirf operator dekh sakta hai.</div>';
    if (state.order) {
      const o = state.order;
      if (!detailed) {
        return `<button class="back-button" data-action="orders-back">${icon('back')} Back to orders</button>${head('ORDER SUMMARY', o.restaurant || 'Swiggy order', 'Operator ke ID par sirf summary milti hai.')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div></div>${restrictedNote}`;
      }
      return `<button class="back-button" data-action="orders-back">${icon('back')} Back to orders</button>${head('ORDER DETAILS', o.restaurant || 'Swiggy order', 'Only information returned by Swiggy is shown.')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div>${o.address ? `<div class="bill-row"><span>Address</span><strong>${esc(o.address)}</strong></div>` : ''}</div><div class="card"><div class="card-title">${icon('cart')} Ordered items</div>${o.items.length ? o.items.map(i => `<div class="bill-row"><span>${esc(i.name)}</span><strong>× ${Number(i.qty)}</strong></div>`).join('') : '<p class="hint">Swiggy did not return item details.</p>'}</div><div class="card"><div class="card-title">${icon('orders')} Tracking <button class="button mini soft right" data-action="order-tracking">${icon('refresh')} Refresh</button></div>${trackingDetails(state.orderTracking)}</div>`;
    }
    let rows;
    if (state.ordersLoading) rows = skeletonRows(3, 2);
    else if (state.orders === null) rows = empty('orders', 'Your orders', 'Refresh dabaiye — order history selected account se aati hai.');
    else if (!state.orders.length) rows = empty('orders', 'No orders returned', 'Swiggy ne is account ke liye koi order nahi diya.');
    else rows = state.orders.map(o => detailed
      ? `<button class="restaurant-row" data-action="order-detail" data-id="${esc(o.id)}">${tile('orders', true)}<span class="row-content"><strong>${esc(o.restaurant || 'Swiggy order')}</strong><p>${esc(o.placedAt || 'Time not returned')}</p><p>${esc((o.items || []).map(i => i.name).join(', ') || 'Item detail not returned')}</p><span class="order-id">#${esc(o.id)}</span></span><span class="pill ${/delivered/i.test(o.status) && !/cancel/i.test(o.status) ? 'green' : ''}">${esc(o.status)}</span></button>`
      // Boss (31-10-2026): user ko bas chhota card, poora detail sirf operator ko.
      : `<button class="restaurant-row compact" data-action="order-detail" data-id="${esc(o.id)}">${tile('orders', true)}<span class="row-content"><strong>${esc(o.restaurant || 'Swiggy order')}</strong><p>${esc(o.placedAt || 'Time not returned')} · #${esc(o.id)}</p></span><span class="order-bill">${money(o.amount)}</span><span class="pill ${/delivered/i.test(o.status) && !/cancel/i.test(o.status) ? 'green' : ''}">${esc(o.status)}</span></button>`).join('');
    const original = state.ordersScope === 'checkout';
    const note = original ? '<div class="warning">Original checkout account dikh raha hai. Khaali ya der se aayi list ka matlab order fail nahi — jab tak outcome pata na chale doosra order na karein.</div>' : restrictedNote;
    return `${head('ORDER HISTORY', original ? 'Original account orders' : 'Your orders', original ? 'Checkout wale account ke recent orders.' : 'Is account ke purane aur chalte orders.', `<button class="button mini soft" data-action="orders-refresh">${icon('refresh')} Refresh</button>`)}${note}${rows}`;
  }
  function renderTools() {
    // Boss (31-10-2026): "NIGHT OFFER AND BREAKFAST AND WEEKEND WALA OFFER
    // ACTIVE KARDO CLAIM KARNE KE LIYE." Ab yahan se seedha claim hota hai —
    // jo Swiggy ne kaha wahi dikhta hai, jhootha "claimed" nahi.
    if (!state.accounts.length) return `${head('A LITTLE EXTRA', 'Offers & tools', 'Pehle apna ID add karein.')}${empty('tools', 'No account yet', 'Accounts tab me OTP ya session JSON se apna ID add karein.')}`;
    const accounts = state.accounts.map(a => {
      const canClaim = a.canClaim !== false;
      const tracks = (a.offerTracks || []).map(t => {
        const stateText = String(t.status || '').toUpperCase();
        const on = t.verified === true || ['CLAIMED', 'ALREADY_ACTIVE', 'ACTIVE'].includes(stateText);
        const label = on ? 'CLAIMED' : stateText === 'NOT_CLAIMED' ? 'NOT CLAIMED' : stateText.replace(/_/g, ' ');
        return `<div class="offer-row"><span class="offer-emoji">${t.emoji || '🎁'}</span><span class="row-content"><strong>${esc(t.label)}</strong><p>${esc(t.message || '')}</p></span><span class="pill ${on ? 'green' : stateText === 'NOT_CLAIMED' ? 'grey' : 'amber'}">${esc(label)}</span></div>`;
      }).join('');
      const claimButton = canClaim
        ? `<button class="button ${a.active ? 'green' : 'outline'} block" type="button" data-action="claim-offers" data-key="${esc(a.key)}" ${state.claimBusyKey === a.key || a.status === 'SESSION_EXPIRED' ? 'disabled' : ''}>${state.claimBusyKey === a.key ? 'Claim ho raha hai…' : (a.active ? 'Chaar offers claim karein' : 'Is ID par claim karein')}</button>`
        : '<p class="hint">Operator ka ID — claim band. Apna ID add karein.</p>';
      return `<div class="card"><div class="card-title">${tile('tools')}<span class="title-copy">${esc(a.name)}<small>${a.phone ? '+91 ' + esc(a.phone) : a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : 'Number not returned'} · ${a.owner === 'operator' ? 'Operator' : 'Aapka'}</small></span></div>${tracks}${claimButton}</div>`;
    }).join('');
    const result = state.claimResult ? `<div class="card"><div class="card-title">${icon('check')} Claim ka sach</div>${(state.claimResult.tracks || []).map(t => `<div class="offer-row"><span class="offer-emoji">${t.emoji || '🎁'}</span><span class="row-content"><strong>${esc(t.label)}</strong><p>${esc(t.message || '')}</p></span><span class="pill ${t.verified ? 'green' : 'amber'}">${esc(String(t.status || '').replace(/_/g, ' '))}</span></div>`).join('')}<p class="hint">Do baar claim nahi hota — pehle se laga ho to ALREADY ACTIVE dikhta hai.</p></div>` : '';
    return `${head('A LITTLE EXTRA', 'Offers & tools', 'Night, breakfast, extra ₹50 aur weekend — yahin se claim.')}${result}${accounts}`;
  }
  function renderConnection() {
    if (!initData) return `${head('TELEGRAM MINI APP', 'Open in Telegram', 'Your private account space needs a Telegram session.')}<div class="card connection-card"><strong>Browser preview only</strong><p>Open this app from your bot using Open App or /pro. No account data is shown here.</p></div>`;
    if (state.connecting) return `${head('CONNECTING', 'Preparing your space', 'Telegram session aur storage check ho raha hai…')}<div role="status">${skeletonRows(3, 2)}</div>`;
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
    // Telegram WebView band hone ke baad bhi async response aa sakta hai —
    // tab render chup-chaap rukna chahiye, window crash nahi.
    try {
      const views = { accounts: renderAccounts, address: renderAddress, search: renderSearch, cart: renderCart, orders: renderOrders, tools: renderTools };
      $('#content').innerHTML = state.auth ? views[state.tab]() : renderConnection();
      renderNav();
      $('#connection-notice').hidden = true;
    } catch { /* window band ho gaya */ }
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
    writeCache({ tab });
    state.order = null;
    if (tab !== 'search') state.menu = null;
    render(); window.scrollTo({ top: 0, behavior: 'auto' });
    if (state.auth && state.activeAccount && tab === 'address' && !state.addresses.length) await loadAddresses();
    if (state.auth && state.activeAccount && tab === 'orders' && state.orders === null) await loadOrders();
  }
  async function loadAddresses() {
    state.addressesLoading = true; render();
    try {
      const data = await api('addresses');
      state.addresses = data.addresses; state.addressNote = data.note || '';
    } finally { state.addressesLoading = false; render(); }
  }
  async function loadOrders() {
    state.ordersLoading = true; render();
    try {
      const data = await api('orders' + (state.ordersScope === 'checkout' ? '?scope=checkout' : ''));
      state.orders = data.orders;
      if (typeof data.detailAllowed === 'boolean') state.ordersDetailAllowed = data.detailAllowed;
    } finally { state.ordersLoading = false; render(); }
  }
  async function search(q) {
    state.searchQuery = q; state.resultsLoading = true; render();
    try {
      const data = await api('search?q=' + encodeURIComponent(q));
      state.results = data.restaurants; state.menu = null;
    } finally { state.resultsLoading = false; render(); }
  }
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
      } else if (type === 'delete-otp') {
        const out = await api('accounts/remove/confirm', 'POST', { key: state.deleteFlow?.key, otp: data.get('otp') });
        merge(out); state.deleteFlow = null; state.addresses = []; state.orders = null; render(); toast('Account Swiggy se delete ho gaya.');
      } else if (type === 'sync') {
        if (!await confirmInApp({ title: 'Sync cart with Swiggy?', message: 'This replaces the current cart on your selected Swiggy account and may save the address there.', confirmText: 'Sync cart' })) return;
        // The prior quote is stale as soon as sync starts, including when the
        // response times out after Swiggy has changed the cart.
        state.cart.quote = null; render();
        const out = await api('cart/sync', 'POST', { coupon: data.get('coupon'), forSomeoneElse: data.has('forSomeoneElse'), confirmReplaceSwiggyCart: true }); merge(out); render(); toast('Bill returned by Swiggy. Check it before paying.');
      }
    }, button);
  }
  // Menu ke andar dish search — re-render ke bina, isliye typing smooth rehti hai.
  document.addEventListener('input', event => {
    const input = event.target.closest('[data-input="menu-search"]');
    if (!input) return;
    const q = String(input.value || '').trim().toLowerCase();
    for (const row of document.querySelectorAll('[data-menu-item]')) {
      row.hidden = Boolean(q) && !String(row.dataset.name || '').includes(q);
    }
    for (const block of document.querySelectorAll('[data-category-block]')) {
      block.hidden = !Array.from(block.querySelectorAll('[data-menu-item]')).some(row => !row.hidden);
    }
  });
  document.addEventListener('submit', forms);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action;
    if (action === 'retry-auth') { reconnect(); return; }
    if (action === 'nav') { run(() => navigate(button.dataset.tab)); return; }
    if (action === 'theme') { document.body.classList.toggle('dark'); try { localStorage.setItem('pro-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch {} writeCache({ theme: document.body.classList.contains('dark') ? 'dark' : 'light' }); return; }
    if (action === 'account-mode') { state.mode = button.dataset.mode; state.otpSent = false; render(); return; }
    if (action === 'otp-reset') { state.otpSent = false; render(); return; }
    if (action === 'toggle-coupon') { state.couponOpen = !state.couponOpen; render(); return; }
    if (action === 'toggle-group-cart') { state.groupCartOpen = !state.groupCartOpen; render(); return; }
    if (action === 'outlets-toggle') {
      state.outletsOpen = !state.outletsOpen;
      render();
      if (!state.outletsOpen || state.outlets || !state.cart) return;
      // Aas-paas ke outlets — Swiggy search se, selected address ke hisaab se.
      state.outletsLoading = true; render();
      api('restaurants/outlets?q=' + encodeURIComponent(state.cart.restaurantName))
        .then(out => { state.outlets = out.outlets || []; })
        .catch(err => toast(err.message || 'Outlets nahi mile.'))
        .finally(() => { state.outletsLoading = false; render(); });
      return;
    }
    if (action === 'delete-cancel') { state.deleteFlow = null; render(); return; }
    if (action === 'contact-edit') { state.contactEdit = !state.contactEdit; render(); return; }
    if (action === 'menu-back') { state.menu = null; render(); return; }
    if (action === 'orders-back') { state.order = null; state.orderTracking = null; render(); return; }
    if (action === 'order-detail') { state.order = state.orders?.find(o => o.id === button.dataset.id) || null; state.orderTracking = null; render(); window.scrollTo(0,0); return; }
    run(async () => {
      if (action === 'account-select') {
        let out;
        try { out = await api('accounts/select', 'POST', { key: button.dataset.key }); }
        catch (e) {
          if (e.code !== 'ACCOUNT_NEEDS_CONFIRM') throw e;
          // Boss (31-10-2026): used ID par warning, phir user chaahe to select.
          if (!await confirmInApp({
            title: 'Ye ID pehle use ho chuki hai',
            message: `${e.message}\n\nPhir bhi isi ID se order karna hai? Naya order isi ID par jayega.`,
            confirmText: 'Haan, select karein'
          })) return;
          out = await api('accounts/select', 'POST', { key: button.dataset.key, confirmUsed: true });
        }
        merge(out); state.addresses = []; state.orders = null; render();
      }
      else if (action === 'account-remove') {
        // Boss (31-10-2026): DELETE par DO option — database se, ya Swiggy se
        // (Swiggy se delete par unka delete OTP jayega).
        const choice = await confirmInApp({
          title: 'Delete kaise karein?',
          message: 'Database se hatao: sirf yahan se ID hategi, Swiggy account chalta rahega.\n\nSwiggy se delete: Swiggy delete OTP bhejega aur account hamesha ke liye delete ho jayega — ye wapas nahi aata.',
          choices: [
            { id: 'local', label: 'Database se hatao' },
            { id: 'swiggy', label: 'Swiggy se delete', danger: true }
          ]
        });
        if (!choice) return;
        if (choice === 'swiggy') {
          const out = await api('accounts/remove', 'POST', { key: button.dataset.key, mode: 'swiggy' });
          state.deleteFlow = { key: button.dataset.key, phoneMasked: out.phoneMasked || '' };
          state.tab = 'accounts'; render(); toast('Swiggy delete OTP bheja gaya.');
          return;
        }
        const out = await api('accounts/remove', 'POST', { key: button.dataset.key }); merge(out); state.addresses = []; state.orders = null; render(); toast('Account hata diya (Swiggy account chalta hai).');
      }
      else if (action === 'claim-offers') {
        const key = button.dataset.key;
        state.claimBusyKey = key; render();
        try {
          const out = await api('offers/claim', 'POST', { key });
          merge(out); state.claimResult = out.claim || null; toast('Claim ka result aa gaya.');
        } finally { state.claimBusyKey = ''; render(); }
      } else if (action === 'addresses-refresh') await loadAddresses();
      else if (action === 'cart-clear') {
        if (!await confirmInApp({ title: 'Cart clear karein?', message: 'Draft cart ke saare items hat jayenge. Swiggy cart tab tak waisa hi rahega jab tak naya sync na ho.', confirmText: 'Clear cart', danger: true })) return;
        await api('cart/clear', 'POST', { confirmClear: true });
        state.cart = null; state.outlets = null; state.outletsOpen = false; state.couponOpen = false;
        render(); toast('Cart clear ho gaya.');
      }
      else if (action === 'bill-refresh') {
        if (!await confirmInApp({ title: 'Fresh bill check?', message: 'Swiggy par cart dobara sync hoga aur naya bill aayega.', confirmText: 'Check bill' })) return;
        const out = await api('cart/sync', 'POST', { confirmReplaceSwiggyCart: true, forSomeoneElse: state.cart?.forSomeoneElse === true, coupon: '' });
        merge(out); render(); toast('Bill update ho gaya.');
      }
      else if (action === 'outlet-pick') {
        if (state.cart && !await confirmInApp({ title: 'Doosra outlet?', message: 'Naye outlet ka item add karne par cart replace karna padega (Swiggy ek cart me do restaurant nahi leta).', confirmText: 'Outlet kholein' })) return;
        const out = await api('menu?id=' + encodeURIComponent(button.dataset.id));
        state.menu = out; state.outletsOpen = false; state.outlets = null; state.tab = 'search'; writeCache({ tab: 'search' }); render(); window.scrollTo(0, 0);
      }
      else if (action === 'address-select') { const out = await api('addresses/select', 'POST', { ref: button.dataset.ref }); merge(out); state.contactEdit = !out.selectedAddress?.mobile || !out.selectedAddress?.name; render(); toast('Address selected.'); }
      else if (action === 'popular') await search(button.dataset.query);
      else if (action === 'restaurant') {
        // Boss (31-10-2026): Swiggy ki tarah pehle outlet/location, phir menu.
        const sameName = outletsForName(button.dataset.name || '');
        if (sameName.length > 1) { openOutletSheet(button.dataset.name, sameName, ''); return; }
        await openMenu(button.dataset.id);
      }
      else if (action === 'menu-outlets') {
        // Menu page se bhi location badalna — wahi sheet.
        const name = state.menu?.restaurant?.name || '';
        const known = outletsForName(name);
        if (known.length > 1) { openOutletSheet(name, known, state.menu?.restaurant?.id); return; }
        const out = await api('restaurants/outlets?q=' + encodeURIComponent(name));
        const list = out.outlets || [];
        if (list.length > 1) openOutletSheet(name, list, state.menu?.restaurant?.id);
        else toast('Aas-paas koi doosra outlet nahi mila.');
      }
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
        if (!state.activeAccount) { state.tab = 'accounts'; writeCache({ tab: 'accounts' }); render(); toast('Pehle Swiggy ID chunein.'); return; }
        if (!state.selectedAddress) { state.tab = 'address'; writeCache({ tab: 'address' }); render(); toast('Pehle delivery address chunein.'); return; }
        if (!state.cart?.items?.length) throw new Error('Cart khaali hai — pehle koi item add karein.');
        let quote = state.cart?.quote;
        if (!quote) {
          // Boss: "Pay Now ka button active karna" — bill na ho to yahin
          // Swiggy se taaza bill lete hain, phir seedha payment.
          const synced = await api('cart/sync', 'POST', { confirmReplaceSwiggyCart: true, forSomeoneElse: state.cart?.forSomeoneElse === true, coupon: '' });
          merge(synced); quote = state.cart?.quote; render();
          if (!quote) throw new Error('Swiggy ne bill nahi diya. Dobara Pay Now dabayein.');
        }
        if (!await confirmInApp({
          title: `Pay ${money(quote.total)} — order confirm?`,
          message: `${state.cart.restaurantName || 'Restaurant'} · ${state.selectedAddress.name} · +91 ${state.selectedAddress.mobile}\n${state.selectedAddress.address}\n\nSwiggy par ek asli order request jayegi. Uske baad UPI QR se paisa dena hai. Agar response atak jaye to dobara order na karein — Orders tab me check karein.`,
          confirmText: `Pay ${money(quote.total)}`
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
  // Update ke baad bhi phone par jo tha wahi dikhe — theme, aakhri tab aur
  // pehle dikhi ID ki yaad (boss: "data reset na ho").
  const cached = readCache();
  try { if (localStorage.getItem('pro-theme') === 'dark' || cached.theme === 'dark') document.body.classList.add('dark'); } catch {}
  if (Array.isArray(cached.accounts)) state.cachedAccounts = cached.accounts;
  if (typeof cached.tab === 'string' && ['accounts','address','search','cart','orders','tools'].includes(cached.tab)) state.tab = cached.tab;
  if (initData) reconnect();
  else render();
})();
