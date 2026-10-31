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
    cachedAccounts: [], busy: false, loading: 0, resultsLoading: false, deleteFlow: null, claimBusyKey: '', claimResult: null, couponOpen: false,
    outlets: null, outletsOpen: false, outletsLoading: false, backup: null, backupBusy: false,
    coupons: null, couponsNote: '', couponsLoading: false, couponBusy: '', couponView: false, couponResults: {}, billOpen: false,
    meal: null, mealFor: '', mealLoading: false, couponDraft: '', groupCartDraft: '',
    track: null, trackData: null, trackError: '', trackBusy: false,
    // Boss (31-10-2026, round 11): wallet ₹15 gate + UPI top-up.
    wallet: null, walletTopup: null, walletSheet: false, walletClaimBusy: false, walletUpiEdit: false,
    utrTrack: null, utrTrackBusy: false, walletClaimTruth: null,
    doctor: null, doctorBusy: false, doctorNote: '',
    // Boss (31-10-2026, round 13): 2 minute idle → draft order band.
    idle: null, idleClosed: null
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
    alert:'<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    coins:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
  const tile = (name, green = false) => `<span class="icon-tile${green ? ' green' : ''}">${icon(name)}</span>`;
  const cartLocked = () => Boolean(state.checkout && state.checkout.status !== 'PAID');
  const head = (eyebrow, title, sub, end = '') => `<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>${end}</div>`;
  const empty = (symbol, title, text) => `<div class="empty"><div class="large-icon">${icon(symbol)}</div><strong>${esc(title)}</strong>${esc(text)}</div>`;
  /**
   * Round 27 (boss): toast ab Swiggy jaisa — upar se drop, icon ke saath, aur
   * rang sach ke hisaab se (kaam hua = hara, nahi hua = laal). Type na diya
   * jaye to message se pata lagta hai, par jahan pakka pata ho wahan type do.
   */
  const toast = (message, type = '') => {
    // Telegram WebView band hone ke baad bhi async response aa sakta hai.
    try {
      const el = $('#toast');
      if (!el) return;
      const text = String(message ?? '');
      // Type guess nahi karte — jahan pakka pata ho wahin 'ok'/'bad' bhejte
      // hain, warna neutral 'info'. Isse jhootha hara tick kabhi nahi aata.
      const kind = type === 'ok' || type === 'bad' ? type : 'info';
      el.className = `toast-${kind}`;
      const glyph = kind === 'bad' ? '!' : kind === 'ok' ? '\u2713' : 'i';
      el.innerHTML = `<span class="toast-icon" aria-hidden="true">${glyph}</span><span class="toast-copy"></span>`;
      const copy = el.querySelector('.toast-copy');
      if (copy) copy.textContent = text; else el.textContent = text;
      el.hidden = false;
      // Dobara same message par animation phir se chale.
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4300);
    } catch { /* window band ho gaya */ }
  };
  // Tests aur manual debug ke liye — behaviour badalta nahi.
  try { window.__appToast = toast; } catch { /* no window */ }
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
      e.status = response.status; e.code = String(result.code || '');
      if (result.wallet) e.wallet = result.wallet;
      throw e;
    }
    return result;
  }
  function merge(data) {
    for (const key of ['user','accounts','activeAccount','selectedAddress','cart','checkout','checkoutEnabled','checkoutBlockReason','ordersDetailAllowed','adminContact','backup','wallet','statement','identities','liveOrder','durability']) if (Object.hasOwn(data, key)) state[key] = data[key];
    if (data.idle) { state.idle = data.idle; if (data.idle.closed) state.idleClosed = data.idle.closed; }
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
    // Boss (31-10-2026): "ADDRESS PAGE LOAD HO RAHA HAI TO KISI AUR PAGE PAR
    // SHIFT NAHI HO PAA RAHA." Ek global busy-lock tab change ko rok deta tha.
    // Ab sirf wahi button band hota hai jisne request bheji hai.
    if (button?.dataset?.busy === '1') return;
    if (button) { button.dataset.busy = '1'; button.disabled = true; }
    if (button) button.classList.add('button-busy');
    startLoading();
    try { await task(); } catch (e) {
      if (['PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED'].includes(e?.code)) {
        state.auth = false; state.authError = e.message; state.authErrorCode = e.code; render();
      } else toast(e.message || 'Something went wrong.');
    } finally {
      state.busy = false;
      if (button?.isConnected) { delete button.dataset.busy; button.disabled = false; button.classList.remove('button-busy'); }
      stopLoading();
    }
  }
  // Boss (31-10-2026, dusra round): "ADMIN SE BAAT KARO WALA BUTTON HATAO."
  // App ke andar sirf app ka kaam — koi support button nahi.
  /**
   * Round 27: jab tak Swiggy ka bill/coupon aa raha hai, khaali jagah nahi —
   * shimmer card jo sach bolta hai ("offers check ho rahe hain").
   */
  function renderFindingCoupon() {
    return `<div class="card finding-coupon-card"><div class="finding-coupon"><span class="spinner" aria-hidden="true"></span><span class="row-content"><strong>Finding the best coupon</strong><p>Checking offers for this cart…</p></span></div><div class="skeleton-list" style="margin-top:12px" aria-hidden="true"><span class="skeleton-line lg"></span><span class="skeleton-line short"></span></div></div>`;
  }
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
    // Boss (31-10-2026): Swiggy ka outlet sheet jaisa — "Current Outlet" card
    // (rating · time · distance + tick) aur "Other Outlets Around You" list.
    const detail = o => [o.rating ? `★ ${o.rating}` : '', o.time, o.distance, o.isOpen === false ? 'Closed' : ''].filter(Boolean).join(' · ');
    const current = outlets.find(o => String(o.id) === String(currentId)) || null;
    const others = outlets.filter(o => String(o.id) !== String(currentId));
    const row = (o, isCurrent) => `<button class="sheet-option${isCurrent ? ' current' : ''}" type="button" data-sheet-outlet="${esc(o.id)}" ${o.isOpen === false ? 'disabled' : ''}>
        <span class="sheet-pin">${icon('address')}</span>
        <span class="row-content"><strong>${esc(o.area || o.name)}</strong><small>${esc(detail(o))}</small></span>
        ${isCurrent ? `<span class="pill green">Yahi</span><span class="outlet-check">${icon('check')}</span>` : o.isOpen === false ? '<span class="pill grey">Closed</span>' : icon('arrow')}
      </button>`;
    sheet.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head"><div><p class="eyebrow">DELIVERING FROM</p><h2>${esc(name)}</h2><p>${outlets.length} outlet${outlets.length === 1 ? '' : 's'} aapke address ke paas</p></div><button class="icon-button" type="button" data-sheet-close aria-label="Band karein">${icon('close')}</button></div>
      <div class="sheet-list">${current ? `<p class="outlet-list-title">Current Outlet</p>${row(current, true)}` : ''}${others.length ? `<p class="outlet-list-title">Other Outlets Around You</p>${others.map(o => row(o, false)).join('')}` : ''}</div>`;
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
  /**
   * Boss (31-10-2026, round 21): "NO SMS RECEIVED" — SMS ka sach alag se.
   * Jhootha "bhej diya" nahi: jo Swiggy ke data me hai wahi.
   */
  function smsTruthBlock(sms) {
    if (!sms?.line) return '';
    const label = sms.state === 'SENT' ? 'Swiggy ne bheja' : sms.state === 'NOT_SENT' ? 'Nahi gaya' : 'Proof nahi';
    return `<div class="card"><div class="card-title">${icon('orders')} SMS ka sach</div><div class="bill-row"><span>Recipient SMS</span><strong class="${sms.state === 'SENT' ? 'free' : ''}">${esc(label)}</strong></div><p class="hint">${esc(sms.line)}</p>${sms.advice ? `<p class="hint">${esc(sms.advice)}</p>` : ''}</div>`;
  }
  function trackingDetails(t) {
    if (!t) return '<p class="hint">Swiggy ne abhi tracking detail nahi di — Refresh dabayein.</p>';
    // Boss (31-10-2026, round 19): operator ke ID par bhi tracking link mile.
    // Link Swiggy ka hai; OTP/address sirf operator ke paas.
    const swiggyLink = /^https:\/\//i.test(String(t.trackingUrl || '')) ? String(t.trackingUrl) : '';
    // Boss (31-10-2026): "AMMI ABBU KO APP SE BAHAR NAHI JAANA HAI." Tracking
    // bhi yahin dikhti hai — koi browser link nahi.
    return `<div class="bill-row"><span>Status</span><strong>${esc(t.status || 'Not returned')}</strong></div>${t.eta ? `<div class="bill-row"><span>ETA</span><strong>${esc(t.eta)}</strong></div>` : ''}${t.deliveryPartner?.name ? `<div class="bill-row"><span>Delivery partner</span><strong>${esc(t.deliveryPartner.name)}</strong></div>` : ''}${t.deliveryPartner?.phone ? `<div class="bill-row"><span>Partner phone</span><strong>${esc(t.deliveryPartner.phone)}</strong></div>` : ''}${t.deliveryOtp ? `<div class="bill-row"><span>Delivery OTP</span><strong>${esc(t.deliveryOtp)}</strong></div>` : ''}${swiggyLink ? `<a class="button soft block" href="${esc(swiggyLink)}" target="_blank" rel="noopener">Swiggy par tracking kholein</a>` : ''}${t.sms?.line ? `<div class="bill-row"><span>SMS</span><strong class="${t.sms.state === 'SENT' ? 'free' : ''}">${esc(t.sms.state === 'SENT' ? 'Swiggy ne bheja' : t.sms.state === 'NOT_SENT' ? 'Nahi gaya' : 'Proof nahi')}</strong></div><p class="hint">${esc(t.sms.line)}</p>${t.sms.advice ? `<p class="hint">${esc(t.sms.advice)}</p>` : ''}` : ''}${t.via ? `<div class="bill-row"><span>Link kahan se</span><strong>${esc(t.via === 'WEB_PAGE_SHARE' ? 'Swiggy order page' : t.via === 'ORDER_DETAILS' ? 'order/details' : t.via === 'CHECKOUT' ? 'payment confirm' : 'trackV4 cta_link')}</strong></div>` : ''}${t.note ? `<p class="hint">${esc(t.note)}</p>` : ''}${!swiggyLink && Array.isArray(t.tried) && t.tried.length ? `<p class="hint">Try hua: ${esc(t.tried.join(', '))}</p>` : ''}`;
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
    if (c.status === 'PAID') return `<div class="card"><div class="card-title">${icon('check')} Payment verified</div>${id}${warning}${trackingDetails(c.tracking ? { ...c.tracking, sms: c.sms || c.tracking.sms } : null)}${smsTruthBlock(c.sms)}<button class="button outline block" data-action="checkout-finish">Start a new draft</button></div>`;
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
  /**
   * Boss (31-10-2026, round 8): "DETAILED ... HOW THE FINAL BILL IS BEING
   * CALCULATED, SAARA CASH JAISE APP ME DIKHTA HAI." Har line wahi jo Swiggy ke
   * bill me aati hai, aur neeche poora hisaab jod kar dikhta hai.
   */
  /**
   * Boss (31-10-2026, round 11): "TEXT ORGANISE WAY ME BHI NAHI HAI ... AISE
   * AUTOMATIC BILL CALCULATE HONA CHAHIYE." Isliye wahi lines, wahi order,
   * wahi naam — jo Swiggy ke bill summary me aate hain. Number Swiggy ka.
   */
  function billText(q, cart) {
    if (!q) return 'Bill abhi Swiggy se nahi aaya.';
    const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const r = v => `₹${num(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    const lines = [];
    const items = (cart?.items || []).filter(i => num(i.qty) > 0);
    for (const i of items) lines.push(`${i.name}  ${r(i.price)} × ${num(i.qty)} = ${r(num(i.price) * num(i.qty))}`);
    if (items.length) {
      const count = items.reduce((n, i) => n + num(i.qty), 0);
      lines.push('', `${count} Item${count === 1 ? '' : 's'} • Subtotal: ${r(q.itemTotal)}`, '');
    }
    lines.push('Bill Summary');
    lines.push(`Items Total: ${r(q.itemTotal)}`);
    if (num(q.discount) > 0) lines.push(`Coupon ${String(q.coupon || '').trim()}: −${r(q.discount)}`);
    if (num(q.freeCash) > 0) lines.push(`Extra Discount ( Free Cash ): −${r(q.freeCash)}`);
    if (num(q.tradeDiscount) > 0) lines.push(`Extra Discount ( Restaurant ): −${r(q.tradeDiscount)}`);
    if (num(q.oneMembershipFee) > 0) lines.push(`Swiggy One Lite Membership: +${r(q.oneMembershipFee)}`);
    const freeDelivery = q.deliveryFee === 0 || q.deliveryFee === null || q.deliveryFee === undefined;
    if (freeDelivery && (num(q.deliverySaved) > 0 || q.deliveryDistance)) {
      lines.push(`Free Delivery${q.deliveryDistance ? ' upto ' + String(q.deliveryDistance).replace(/\s+/g, '') : ''}`);
    }
    lines.push(`Delivery Fee: ${freeDelivery ? 'FREE' : r(q.deliveryFee)}${num(q.deliverySaved) > 0 ? ` (${r(q.deliverySaved)} saved)` : ''}`);
    if (num(q.packingCharges) > 0) lines.push(`Packing Charges: ${r(q.packingCharges)}`);
    const taxOther = num(q.taxes) + num(q.otherCharges);
    if (taxOther > 0) lines.push(`GST & Other Charges: ${r(taxOther)}`);
    if (num(q.unlistedDiscount) > 0) lines.push(`Extra saving (bill me): −${r(q.unlistedDiscount)}`);
    lines.push('━━━━━━━━━━━━━━');
    const savings = num(q.totalSavings) || (num(q.discount) + num(q.freeCash) + num(q.tradeDiscount) + num(q.deliverySaved));
    if (savings > 0) lines.push(`Total Savings: ${r(savings)}`);
    lines.push(`To Pay: ${r(q.total)}`);
    return lines.join('\n');
  }
  /**
   * Wallet card — boss (31-10-2026, round 11): "WALLET MUST REACH A BALANCE OF
   * 15 OTHERWISE IT WILL SAY YOUR BALANCE IS LOW ADD AMOUNT ... DEFAULT UPI
   * mius@ybl ... I CAN CHANGE IT ALSO ... IF USER PAY LESS AND SAY I HAVE PAID
   * YOU HAVE TO ADD HOW MUCH THEY PAID."
   */
  function renderWalletCard() {
    const w = state.wallet;
    if (!w) return '';
    const ready = w.ready === true;
    const shortText = ready ? '' : `Balance ${money(w.balance)} hai — order ke liye ${money(w.fee)} chahiye. ${money(w.shortfall)} add karein.`;
    const presets = (w.presets || []).slice(0, 3).map(p => `<button class="button mini outline" type="button" data-action="wallet-topup" data-paise="${Number(p.paise)}">₹${esc(p.rupees)}</button>`).join('');
    const topup = state.walletTopup
      ? `<div class="wallet-topup"><p class="hint">${esc(state.walletTopup.note || '')}</p>${state.walletTopup.qrDataUrl ? `<img class="payment-qr" src="${esc(state.walletTopup.qrDataUrl)}" alt="Wallet top-up UPI QR">` : ''}<a class="button green block" href="${esc(state.walletTopup.upiUri || '#')}">UPI app me ₹${esc(state.walletTopup.amount)} bhejein</a><p class="hint">UPI id: <b>${esc(state.walletTopup.upiId || '')}</b></p></div>`
      : '';
    // Boss (31-10-2026, round 23): "BAS USER KO BOL SEND HOW MUCH MONEY YOU WANT
    // THAT WILL BE FETCHED AND ADDED UPON SUBMITTING UTR" — user sirf itna
    // likhta hai ki kitna paisa bhejna hai, phir UTR daalta hai. Server us UTR
    // ki asli payment detail fetch karta hai aur jitna aaya utna hi judta hai.
    const topupAmount = state.walletTopup?.amount || '';
    const suggested = topupAmount || String(w.shortfall || w.fee || '15');
    const claim = `<form data-form="wallet-claim" class="wallet-claim" novalidate><p class="section-title">Kitna paisa bhejna hai?</p><p class="hint">Jitna paisa bhejna hai utna likhein (UPI: <b>${esc(w.upiId || '')}</b>). Phir UPI app se 12-digit <b>UTR</b> daaliye — us UTR ki payment details khud fetch hongi aur <b>jitna paisa sach me aaya utna hi</b> judega.${topupAmount ? ` (Ye top-up ₹${esc(topupAmount)} ka khula hai.)` : ''}</p><div class="field-row">${field('Amount (₹)', 'amount', 'jaise 15', suggested)}${field('UTR (12 digit)', 'utr', 'jaise 123456789012', '')}</div><button class="button primary block" type="submit" ${state.walletClaimBusy ? 'disabled' : ''}>${state.walletClaimBusy ? 'UTR se payment fetch ho rahi hai…' : 'UTR se payment fetch karke add karein'}</button>${state.walletClaimNote ? `<p class="hint">${esc(state.walletClaimNote)}</p>` : ''}</form>`;
    const upiEditor = state.user?.isBoss
      ? (state.walletUpiEdit
        ? `<form data-form="wallet-upi" class="wallet-usi" novalidate>${field('Boss ka UPI id', 'upiId', 'name@bank', w.upiId || '')}<button class="button outline block" type="submit">UPI save karein</button></form>`
        : `<button class="text-button" type="button" data-action="wallet-upi-edit">UPI badlein (${esc(w.upiId || '')})</button>`)
      : '';
    return `<div class="card wallet-card"><div class="card-title">${icon('coins')} Wallet <span class="pill ${ready ? 'green' : 'amber'} right">${ready ? 'Ready' : 'Low balance'}</span></div><div class="bill-row"><span>Aapka balance</span><strong>${money(w.balance)}</strong></div><div class="bill-row"><span>Order fee</span><strong>${w.exempt ? 'Free' : money(w.fee)}</strong></div>${ready ? '<p class="hint">Balance poora hai — Pay dabate hi fee kategi aur order jayega. Order place na ho to fee wapas.</p>' : `<div class="warning">${esc(shortText)}</div>`}<div class="wallet-actions">${presets}${state.walletSheet ? '' : `<button class="button mini soft" type="button" data-action="wallet-topup">Add money</button>`}</div>${topup}${claim}${upiEditor}<p class="hint">Paisa is UPI par jata hai: <b>${esc(w.upiId || '')}</b>${w.exempt ? '' : ' · fee sirf order place hone par lagti hai'}</p></div>`;
  }
  function renderBill(q, cart) {
    if (!q) return `<div class="warning" id="bill-details">Bill abhi Swiggy se nahi aaya. Neeche <b>Pay Now</b> dabaiye — pehle asli bill aayega, phir payment.</div>`;
    const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const itemTotal = num(q.itemTotal);
    const deliveryFee = num(q.deliveryFee);
    const deliveryFree = q.deliveryFee === 0 || q.deliveryFee === null || q.deliveryFee === undefined;
    const deliverySaved = num(q.deliverySaved);
    const packing = num(q.packingCharges);
    const taxes = num(q.taxes);
    const other = num(q.otherCharges);
    const discount = num(q.discount);
    const freeCash = num(q.freeCash);
    const tradeDiscount = num(q.tradeDiscount);
    const oneFee = num(q.oneMembershipFee);
    const offer = num(q.unlistedDiscount);
    const total = num(q.total);
    const savings = num(q.totalSavings) || (discount + freeCash + tradeDiscount + deliverySaved);
    const distance = q.deliveryDistance ? ` <small>${esc(q.deliveryDistance)}</small>` : '';
    const row = (label, value, cls = '') => `<div class="bill-row${cls ? ' ' + cls : ''}"><span>${label}</span><strong>${value}</strong></div>`;
    const itemsDetail = (cart?.items || []).filter(i => num(i.qty) > 0).map(i => `<div class="bill-row breakdown"><span>${esc(i.name)} × ${num(i.qty)}</span><strong>${money(num(i.price) * num(i.qty))}</strong></div>`).join('');
    const eq = `Items ${money(itemTotal)} + Delivery ${deliveryFree ? 'FREE' : money(deliveryFee)} + Packing ${money(packing)} + GST ${money(taxes)} + One ${money(oneFee)}${other ? ` + Other ${money(other)}` : ''}${discount ? ` − Coupon ${money(discount)}` : ''}${freeCash ? ` − Free Cash ${money(freeCash)}` : ''}${tradeDiscount ? ` − Restaurant discount ${money(tradeDiscount)}` : ''}${offer ? ` − Offer ${money(offer)}` : ''} = ${money(total)}`;
    const detailed = `<div class="bill-detail-math"><p class="section-title">Poora hisaab</p>${itemsDetail}${itemsDetail ? '<div class="divider"></div>' : ''}<p class="hint bill-equation">${esc(eq)}</p><p class="hint">Ye hisaab Swiggy ke apne bill se bana hai. Farak ho to <b>Swiggy ka total hi final</b> hai — hum usi ko charge karte hain.</p></div>`;
    return `<div class="card bill-card" id="bill-details"><div class="card-title">${icon('receipt')} Bill Details <small class="title-sub">Swiggy ka bill summary</small> <button class="icon-button right" type="button" data-action="bill-refresh" aria-label="Refresh bill">${icon('refresh')}</button></div><div class="divider"></div>${row('Items Total', money(itemTotal))}${discount > 0 ? row(`Coupon ${esc(q.coupon || '')}`, `−${money(discount)}`, 'saving') : ''}${freeCash > 0 ? row('Extra Discount (Free Cash)', `−${money(freeCash)}`, 'saving') : ''}${tradeDiscount > 0 ? row('Extra Discount (Restaurant)', `−${money(tradeDiscount)}`, 'saving') : ''}${oneFee > 0 ? row('Swiggy One Lite Membership', `+${money(oneFee)}`) : ''}${deliveryFree ? `<div class="bill-row free-delivery"><span>Free Delivery</span><strong>${deliverySaved > 0 ? `${money(deliverySaved)} saved` : 'Applied'}</strong></div>` : ''}${row(`Delivery Fee${distance}`, deliveryFree ? `FREE${deliverySaved > 0 ? ` (${money(deliverySaved)} saved)` : ''}` : money(deliveryFee), deliveryFree ? 'saving' : '')}${packing > 0 ? row('Packing Charges', money(packing)) : ''}${(taxes + other) > 0 ? row('GST &amp; Other Charges', money(taxes + other)) : ''}${offer > 0 ? row('Extra saving (bill me)', `−${money(offer)}`, 'saving') : ''}${savings > 0 ? `<div class="bill-row total-savings"><span>Total Savings</span><strong>${money(savings)}</strong></div>` : ''}<div class="bill-row total"><span>To Pay</span><span>${money(total)}</span></div><pre class="bill-plain">${esc(billText(q, cart))}</pre><button class="text-button bill-toggle" type="button" data-action="bill-open">${state.billOpen ? 'Hisaab band karein' : 'Poora hisaab dekhein'}</button>${state.billOpen ? detailed : ''}<p class="hint">Swiggy se aaya bill. Coupon/free cash tabhi dikhta hai jab Swiggy deta hai.${cart?.forSomeoneElse ? ' OFO acceptance is bill se confirm nahi hota.' : ''}</p></div>`;
  }
  function renderPayment(cart) {
    const ready = Boolean(state.cart?.quote) && !cartLocked();
    return `<div class="card"><div class="card-title">${icon('receipt')} Payment Method</div><div class="divider"></div><div class="pay-option selected"><span class="icon-tile">${icon('check')}</span><span class="pay-copy"><strong>UPI / QR</strong><small>PhonePe, Paytm, CRED &amp; koi bhi UPI app</small></span><span class="pay-check">${icon('check')}</span></div><div class="pay-option disabled"><span class="icon-tile">${icon('receipt')}</span><span class="pay-copy"><strong>Credit / Debit Card</strong><small>Visa, Mastercard, RuPay · OTP bank se — app se abhi nahi hota</small></span></div><div class="pay-option disabled"><span class="icon-tile">${icon('coins')}</span><span class="pay-copy"><strong>Cash on Delivery</strong><small>Is app se nahi hota — UPI se pay karein</small></span></div><p class="hint">${ready ? 'Neeche Pay Now dabane par Swiggy ek asli order request banata hai. Payment alag se UPI se hoti hai.' : 'Pehle bill check karein — bill confirm hone ke baad hi payment step khulta hai.'}</p></div>`;
  }
  /** Kitna bacha — sirf jo Swiggy ke bill me asli me dikha. */
  function savedAmount(q) {
    if (!q) return 0;
    // Swiggy ne khud "Total Savings" diya ho to wahi sach hai (usme free
    // delivery/wallet bhi jud jaata hai) — hum apna bada number nahi banate.
    const stated = Number(q.totalSavings);
    if (Number.isFinite(stated) && stated > 0) return Math.round(stated * 100) / 100;
    const sum = (Number(q.discount) || 0) + (Number(q.unlistedDiscount) || 0) + (Number(q.freeCash) || 0) + (Number(q.tradeDiscount) || 0) + (Number(q.deliverySaved) || 0);
    return Math.round(sum * 100) / 100;
  }
  /**
   * Boss (31-10-2026): "IMAGE JAISA CHAHIYE, NORMAL NAHI." Swiggy ke cart jaisa
   * Savings Corner: jo laga hua hai wahi Applied, Remove se hat bhi sakta hai.
   */
  function renderSavingsCorner(q) {
    if (!q) return '';
    const num = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const rows = [];
    if (q.coupon && num(q.discount) > 0) {
      rows.push(`<div class="saving-row"><span class="saving-icon">%</span><span class="row-content"><strong>${money(num(q.discount))} saved with ${esc(q.coupon)}</strong><small>Coupon Swiggy ne khud lagaya</small></span><span class="saving-badge on">✓ Applied</span><button class="text-button" type="button" data-action="coupon-remove">Remove</button></div>`);
    }
    if (num(q.freeCash) > 0) {
      rows.push(`<div class="saving-row"><span class="saving-icon one">cash</span><span class="row-content"><strong>${money(num(q.freeCash))} Free Cash</strong><small>Extra discount bill me pehle se laga hai</small></span><span class="saving-badge on">✓ Applied</span></div>`);
    }
    if (num(q.tradeDiscount) > 0) {
      rows.push(`<div class="saving-row"><span class="saving-icon">%</span><span class="row-content"><strong>${money(num(q.tradeDiscount))} restaurant discount</strong><small>Restaurant ne bill me diya</small></span><span class="saving-badge on">✓ Applied</span></div>`);
    }
    if (q.deliveryFee === 0 && num(q.deliverySaved) > 0) {
      rows.push(`<div class="saving-row"><span class="saving-icon one">one</span><span class="row-content"><strong>${money(num(q.deliverySaved))} saved on delivery</strong><small>Free delivery ${q.deliveryDistance ? '· ' + esc(q.deliveryDistance) : ''}</small></span><span class="saving-badge on">✓ Applied</span></div>`);
    }
    if (num(q.oneMembershipFee) > 0) {
      rows.push(`<div class="saving-row"><span class="saving-icon one">one</span><span class="row-content"><strong>Swiggy One Lite ${money(num(q.oneMembershipFee))}</strong><small>Membership fee bill me juda hai</small></span><span class="saving-badge">Charged</span></div>`);
    }
    // Boss (31-10-2026, round 14): engine ne kya kiya — saaf dikhta hai.
    const eng = q.engine || null;
    if (eng) {
      const bits = [];
      if (eng.oneLite === 'applied') bits.push('+₹1 One Lite se delivery FREE');
      if (eng.freeCash > 0) bits.push(`₹${eng.freeCash} free cash`);
      if (Array.isArray(eng.couponTrials) && eng.couponTrials.length) bits.push(`${eng.couponTrials.length} coupon ka asli bill check hua`);
      if (eng.offersClaimed > 0) bits.push(`${eng.offersClaimed} offer claim hua`);
      if (bits.length) {
        rows.push(`<p class="hint engine-line">Engine: ${esc(bits.join(' · '))}${eng.couponTrials?.some(t => t.ok) ? ` — sabse kam bill wala coupon laga (${esc(q.coupon || '')})` : ''}</p>`);
      }
    }
    const totalSaved = num(q.totalSavings);
    return `<div class="card savings-corner"><div class="card-title">SAVINGS CORNER${totalSaved > 0 ? `<span class="pill green right">${money(totalSaved)} saved</span>` : ''}<button class="text-button coupon-open-link" type="button" data-action="coupon-open">Saare coupons</button></div>${rows.length ? rows.join('') : '<p class="hint">Is bill par abhi koi discount nahi laga. Coupons se try karein.</p>'}</div>`;
  }
  /** "Complete Your Meal" rail — isi restaurant ke asli menu se. */
  function renderMealRail(cart) {
    if (!state.meal || state.mealLoading) return '';
    const inCart = new Set((cart.items || []).map(i => String(i.id)));
    const dishes = [];
    for (const category of state.meal.categories || []) {
      for (const item of category.items || []) {
        if (dishes.length >= 8) break;
        if (!item.id || inCart.has(String(item.id))) continue;
        if (item.price === null || item.inStock === false || item.customizable) continue;
        dishes.push(item);
      }
    }
    if (!dishes.length) return '';
    return `<div class="meal-rail"><p class="section-title">Complete your meal</p><div class="meal-track">${dishes.map(i => `<article class="meal-card"><span class="meal-thumb">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy" decoding="async">` : icon('store')}</span><button class="meal-plus" type="button" data-action="dish-add" data-id="${esc(i.id)}" aria-label="Add ${esc(i.name)}">+</button><strong>${esc(i.name)}</strong><small>${money(i.price)}</small></article>`).join('')}</div></div>`;
  }
  /**
   * Coupon page (Swiggy image 2 jaisa): applied coupon ribbon ke saath, phir
   * "great deal you are missing out" aur more offers. APPLY par asli bill.
   */
  function renderCouponPage() {
    const cart = state.cart;
    const q = cart?.quote;
    const results = state.couponResults || {};
    const appliedCode = String(q?.coupon || '').toUpperCase();
    const percentOf = text => {
      const m = String(text || '').match(/(\d{1,2})\s*%\s*off/i);
      return m ? `${m[1]}% OFF` : 'OFFER';
    };
    const applied = appliedCode && Number(q.discount) > 0
      ? `<p class="section-title">Applied coupon</p><article class="coupon-tile applied"><span class="coupon-ribbon"><b>${money(q.discount)}</b><small>OFF</small></span><div class="coupon-body"><div class="coupon-head"><strong>${esc(appliedCode)}</strong><button class="coupon-cta" type="button" data-action="coupon-remove">REMOVE</button></div><p class="coupon-line">Save ${money(q.discount)} on this order!</p><p class="coupon-desc">Swiggy ke bill me ye discount pehle se laga hua hai.</p></div></article>`
      : '';
    const tile = c => {
      const isApplied = appliedCode === c.code && Number(q?.discount) > 0;
      const busy = state.couponBusy === c.code;
      const result = results[c.code];
      const action = isApplied
        ? '<span class="coupon-cta off">✓ APPLIED</span>'
        : `<button class="coupon-cta" type="button" data-action="coupon-pick" data-code="${esc(c.code)}" ${busy || cartLocked() ? 'disabled' : ''}>${busy ? 'APPLYING…' : 'APPLY'}</button>`;
      const resultLine = result
        ? `<p class="coupon-result ${result.ok ? 'ok' : 'no'}">${result.ok ? `Laga — ${money(result.saved)} ki saving` : esc(result.message || 'Swiggy ne ye code nahi liya.')}</p>`
        : '';
      return `<article class="coupon-tile${isApplied ? ' applied' : ''}"><span class="coupon-ribbon"><b>${esc(percentOf(c.title + ' ' + c.description))}</b></span><div class="coupon-body"><div class="coupon-head"><strong>${esc(c.code)}</strong>${action}</div><p class="coupon-line">${esc(c.title || c.code)}</p><p class="coupon-desc">${esc(c.description || '')}</p>${resultLine}</div></article>`;
    };
    const list = state.coupons || [];
    const body = state.couponsLoading
      ? skeletonRows(3, 2)
      : (list.length ? list.map(tile).join('') : `<div class="card"><p class="hint">Coupon list aa rahi hai — upar APPLY dabaiye.</p></div>`);
    return `<button class="back-button" data-action="coupon-back">${icon('back')} Cart</button>${head('SAVINGS', 'Coupons', `Your cart: ${q ? money(q.itemTotal ?? q.total) : '—'}`)}${applied}<div class="coupon-count">AVAILABLE COUPONS <b>${Array.isArray(list) ? list.length : 0}</b></div><p class="section-title">Aapke liye offers</p>${body}<p class="hint">${esc(state.couponsNote || 'APPLY dabaiye — asli bill Swiggy se aayega. Discount tabhi dikhega jab Swiggy deta hai.')}</p>`;
  }
  /** Payment ke baad asli tracking — status Swiggy se, guess nahi. */
  function renderTrack() {
    const t = state.track;
    const data = state.trackData;
    const status = String(data?.status || '');
    const steps = ['Order place hua', 'Restaurant ne accept kiya', 'Khana ban raha hai', 'Rider raaste me', 'Delivered'];
    const lowered = status.toLowerCase();
    let reached = 0;
    if (/deliver(ed)?/i.test(lowered) && !/out for|on the way/i.test(lowered)) reached = 5;
    else if (/out for delivery|on the way|picked|rider/i.test(lowered)) reached = 4;
    else if (/prepar|cook|kitchen|accepted|confirm/i.test(lowered)) reached = 3;
    else if (/placed|received|pending/i.test(lowered)) reached = 1;
    const timeline = status ? `<ol class="track-steps">${steps.map((label, i) => `<li class="${i < reached ? 'done' : ''}${i === reached - 1 ? ' current' : ''}"><span class="track-dot"></span><span>${esc(label)}</span></li>`).join('')}</ol>` : '';
    return `<button class="back-button" data-action="track-close">${icon('back')} Cart</button>${head('LIVE ORDER', 'Order track karein', data?.orderId || state.track?.id ? `Swiggy order #${esc(data?.orderId || state.track?.id)}` : 'Swiggy order')}<div class="card track-card"><div class="card-title">${icon('orders')} <span class="title-copy"><strong>${esc(status || (state.trackError ? 'Status nahi mila' : 'Status aa raha hai…'))}</strong><small>${esc(data?.eta ? 'ETA ' + data.eta : 'Swiggy ka taaza status')}</small></span>${state.trackBusy ? '<span class="spinner right" aria-label="Loading"></span>' : ''}</div>${timeline}${state.trackError ? `<div class="warning">${esc(state.trackError)}</div>` : ''}${trackingDetails(data)}${smsTruthBlock(state.trackSms || data?.sms)}<div class="track-actions"><button class="button primary block" type="button" data-action="track-refresh">${icon('refresh')} Status refresh</button><button class="button soft block" type="button" data-action="nav" data-tab="orders">Saare orders</button></div><p class="hint">Status khud refresh hota rehta hai. Delivery OTP rider ko dikhayein — kisi aur ko na dein.</p></div>`;
  }
  /** Payment pending: QR screen Swiggy jaisa, phir track. */
  function renderPaymentScreen(c) {
    const hasQr = Boolean(c.qrDataUrl && /^data:image\/png;base64,/.test(c.qrDataUrl) && c.upiIntentUrl && /^upi:\/\/pay\?/i.test(c.upiIntentUrl));
    // Boss (31-10-2026, round 12): "QR NAHI AYA". Ab jab Swiggy order bana de
    // par QR na de, app chhupata nahi — order ID, asli wajah, aur agla kadam.
    // Boss (31-10-2026, round 15): "kitna ganda dikh raha hai ye text, bilkul
    // style nahi kia". Purane card me heading ek flex item tha, isliye
    // "UPI se pay karein" ek patlee column me toot kar 4 line ban raha tha.
    // Ab poora block structure ke saath: heading + sach + agla kadam.
    const reasons = Array.isArray(c.qrMissingReasons) ? c.qrMissingReasons.filter(Boolean).slice(0, 3) : [];
    const qr = hasQr
      ? `<img class="payment-qr" src="${esc(c.qrDataUrl)}" alt="Swiggy UPI payment QR"><a class="button green block" href="${esc(c.upiIntentUrl)}">Open UPI app</a>`
      : `<div class="pay-hold">
          <div class="pay-hold-head">${tile('alert')}<div class="title-copy"><strong>QR Swiggy ne nahi diya</strong><small>Order ban gaya hai — paisa abhi nahi kata.</small></div></div>
          ${reasons.length ? `<ul class="pay-reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : (c.qrMissingReason ? `<p class="pay-reason-line">${esc(c.qrMissingReason)}</p>` : '')}
          <div class="pay-order-chip"><span>Order</span><b>#${esc(c.orderId || '—')}</b></div>
          <ol class="pay-steps">
            <li><b>Dobara order mat karein</b> — Swiggy par order pehle se bana hua hai.</li>
            <li>Neeche <b>Payment check karein</b> dabaiye — status Swiggy se aata hai.</li>
            <li>Swiggy unpaid order thodi der me khud cancel kar deta hai${c.orderId ? '' : ''}.</li>
          </ol>
        </div>${/^https:\/\//.test(String(c.paymentPageUrl || '')) ? `<a class="button soft block" href="${esc(c.paymentPageUrl)}">Swiggy ka payment page kholein</a>` : ''}`;
    return `${head('PAYMENT', `Pay ${money(c.amount)}`, c.orderId ? `Swiggy order #${esc(c.orderId)}` : 'Swiggy order bana hai')}<div class="card pay-screen"><div class="card-title">${tile(hasQr ? 'receipt' : 'orders')}<span class="title-copy"><strong>${hasQr ? 'UPI se pay karein' : 'Payment abhi ruka hua hai'}</strong><small>${esc(hasQr ? (c.message || 'QR Swiggy se aaya hai — scan karke pay karein.') : 'Swiggy ne order le liya, bas QR nahi diya.')}</small></span></div>${qr}<p class="hint">${hasQr ? 'Paisa sirf isi QR par dein — ek hi baar.' : ''} ${c.paymentVerified ? 'Payment report hui hai, order confirm hone ka intezaar hai — dobara na dein.' : ''}</p><button class="button primary block" type="button" data-action="checkout-status">${icon('refresh')} Payment check karein</button>${c.orderId ? `<button class="button soft block" type="button" data-action="track-open" data-id="${esc(c.orderId)}">Order track karein</button>` : ''}<button class="button soft block" type="button" data-action="checkout-orders">Original account ke orders</button></div>`;
  }
  function renderCart() {
    if (state.track) return renderTrack();
    if (state.couponView) return renderCouponPage();
    const cart = state.cart;
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    if (state.checkout?.status === 'PAYMENT_PENDING') return renderPaymentScreen(state.checkout);
    const lockedNotice = locked ? '<div class="warning">Checkout pending ya unknown hai. Cart/receiver changes band hain; pehle original account check karein.</div>' : '';
    // Boss (31-10-2026): "CART PARSE KARNE WALA BUTTON SIDHA ACTIVE KAR NAKI
    // DROP DOWN PAR CLICK KARNE KE BAAD." Isliye koi toggle nahi — input aur
    // button hamesha saamne, seedha dabao.
    const groupCard = `<div class="card group-cart-card"><div class="card-title">${tile('link')}<span class="title-copy">Add Items from Group Cart<small>Swiggy group cart ka link paste karein.</small></span></div><form data-form="group-cart" class="group-cart-form" novalidate><span class="input-wrap">${icon('link')}<input name="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.swiggy.com/gc/…" value="${esc(state.groupCartDraft || '')}" ${lockAttr}></span><button class="button primary" type="submit" ${lockAttr}>Cart parse karein ${icon('arrow')}</button></form><p class="hint">Share link, <b>swiggy.com/gc/…</b>, <b>?sharedCartId=…</b> ya app ka deep link — sab chalta hai.</p></div>`;
    // Boss (31-10-2026, round 13): 2 minute idle rule app me likha rehta hai —
    // chhupkar draft band nahi hota.
    const idleNote = (() => {
      const minutes = Math.round(Number(state.idle?.timeoutMs || 0) / 60_000);
      if (!minutes) return '';
      return `<p class="hint idle-note">${minutes} minute tak koi activity nahi hogi to ye draft order apne aap band ho jayega${cart?.quote ? ' (bill aur cart saaf, fee wapas)' : ''}.</p>`;
    })();
    const delivery = `<button class="action-tile" type="button" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><small>DELIVERING TO</small><strong>${esc(state.selectedAddress ? addressLabel(state.selectedAddress) : 'Address chunein')}</strong><small>${esc(state.selectedAddress ? (state.selectedAddress.address || '') : 'Order ke liye address zaroori hai')}</small></span>${icon('arrow')}</button>`;
    if (!cart) {
      return `${head('YOUR ORDER', 'Cart', 'Group cart se items add karein ya restaurant search karein.')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${groupCard}${state.selectedAddress ? delivery : ''}${empty('cart', 'Cart khaali hai', 'Restaurant search karein ya group cart link paste karein.')}`;
    }
    maybeLoadMeal(cart);
    const quantity = cart.items.reduce((n, i) => n + Number(i.qty || 0), 0);
    // Boss (31-10-2026): Swiggy cart jaisa item row — veg mark + naam left,
    // green stepper + item ka total right.
    const items = cart.items.map(i => {
      const veg = i.isVeg === true ? '<span class="veg-mark" aria-label="Vegetarian"></span>' : i.isVeg === false ? '<span class="veg-mark nonveg" aria-label="Non-vegetarian"></span>' : '';
      const gross = i.price === null ? null : Math.round(Number(i.price) * Number(i.qty || 1) * 100) / 100;
      const lineTotal = gross === null ? '—' : (Number.isFinite(Number(i.lineTotal)) && Number(i.lineTotal) > 0 && Number(i.lineTotal) < gross ? `<s>${money(gross)}</s> ${money(i.lineTotal)}` : money(gross));
      return `<div class="cart-item"><div class="row-content">${veg}<strong>${esc(i.name)}</strong><p>${i.price === null ? 'Price unavailable' : money(i.price) + ' each'}${(i.variants?.length || i.addons?.length) ? ' · Customised' : ''}</p></div><div class="cart-item-right"><div class="stepper"><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)-1}" aria-label="Remove one" ${lockAttr}>−</button><span>${Number(i.qty)}</span><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)+1}" aria-label="Add one" ${lockAttr}>+</button></div><strong class="line-total">${lineTotal}</strong></div></div>`;
    }).join('');
    const q = cart.quote;
    const meta = [cart.restaurantArea, cart.restaurantTime].filter(Boolean).join(' · ');
    // Ek restaurant ke kai franchise — location ka naam + dropdown.
    const outletRow = `<button class="outlet-row" type="button" data-action="outlets-toggle" aria-expanded="${state.outletsOpen ? 'true' : 'false'}"><span class="outlet-pin">${icon('address')}</span><span class="outlet-copy"><strong>${esc(cart.restaurantArea || cart.restaurantName)}</strong><small>${esc([cart.restaurantTime, 'Outlet badlein'].filter(Boolean).join(' · '))}</small></span><span class="outlet-caret">${state.outletsOpen ? '▴' : '▾'}</span></button>${state.outletsOpen ? (state.outletsLoading ? skeletonRows(2, 1) : `<div class="outlet-list-wrap"><p class="outlet-list-title">Current Outlet</p><div class="outlet-list">${(state.outlets || []).length ? state.outlets.map(o => { const current = String(o.id) === String(cart.restaurantId); const bits = [o.rating ? `★ ${o.rating}` : '', o.time, o.distance, o.isOpen === false ? 'Closed' : ''].filter(Boolean).join(' · '); return `<button class="outlet-option ${current ? 'current' : ''}" type="button" data-action="outlet-pick" data-id="${esc(o.id)}" data-name="${esc(o.name)}" ${current || o.isOpen === false ? 'disabled' : ''}><span class="row-content"><strong>${esc(o.area || o.name)}</strong><small>${esc(bits)}</small></span>${current ? `<span class="pill green">Yahi</span><span class="outlet-check">${icon('check')}</span>` : o.isOpen === false ? '<span class="pill grey">Closed</span>' : icon('arrow')}</button>`; }).join('') : '<p class="hint">Aas-paas koi doosra outlet nahi mila.</p>'}</div></div>`) : ''}`;
    const restaurantCard = `<div class="card restaurant-cart"><div class="cart-restaurant-head"><span class="cart-restaurant-thumb">${cart.restaurantImage ? `<img src="${esc(cart.restaurantImage)}" alt="" loading="lazy" decoding="async">` : icon('store')}</span><span class="row-content"><strong>${esc(cart.restaurantName)}${cart.restaurantRating ? ` <span class="rating-chip">★ ${esc(cart.restaurantRating)}</span>` : ''}</strong><p>${esc(meta || 'Restaurant')}</p></span><button class="icon-button danger" type="button" data-action="cart-clear" aria-label="Cart clear karein" ${lockAttr}>${icon('trash')}</button></div>${outletRow}${items}<div class="cart-actions-row"><button class="chip-action" type="button" data-action="nav" data-tab="search">${icon('plus')} Add Items</button><button class="chip-action" type="button" data-action="toggle-coupon">${icon('receipt')} Apply coupon</button></div></div>`;
    // Boss (31-10-2026): "JAISE SWIGGY KE APP ME DIKHTA CHECKOUT PAGE WAISA KARNA
    // SAME AND PAY NOW KA BUTTON ACTIVE KARNA." ETA strip → savings → address →
    // Your Order → coupon/savings → bill → payment → pay bar.
    const saved = savedAmount(q);
    const savingsBanner = saved > 0 ? `<div class="savings-banner">✨ ${money(saved)} saved! ${q?.coupon ? `— coupon ${esc(q.coupon)} laga hai` : '— bill me asli saving'}</div>` : '';
    const eta = `<div class="eta-strip"><span class="eta-clock">${icon('orders')}</span><span class="eta-copy"><strong>${cart.restaurantTime ? `Delivery in ${esc(cart.restaurantTime)}` : 'Delivery time Swiggy se aayega'}</strong><small>${esc([cart.restaurantName, cart.restaurantArea].filter(Boolean).join(' · '))}</small></span><span class="pill">${esc(state.selectedAddress ? 'Deliver to ' + addressLabel(state.selectedAddress) : 'Address chunein')}</span></div>`;
    // Pay bar: Swiggy jaisa — bada amount + bill link left, green pay right.
    const payBar = `<div class="pay-bar"><button class="button green pay-now" type="button" data-action="checkout-start" ${locked || !state.checkoutEnabled ? 'disabled' : ''} ${!state.checkoutEnabled ? `title="${esc(state.checkoutBlockReason || '')}"` : ''}>${state.checkoutEnabled ? `Pay Now · Proceed to Pay ${icon('arrow')}` : 'Payment band'}</button><div class="pay-left"><strong>${q ? money(q.total) : '—'}</strong><span class="link-button" role="button" tabindex="0" data-action="bill-open">${state.billOpen ? 'Bill band karein' : 'View Detailed Bill'}</span><small>${q ? 'PAY USING UPI' : 'BILL CHECK KAREIN'}</small></div></div>${state.checkoutEnabled ? '' : `<div class="warning pay-blocked">Payment abhi band hai — wahi asli wajah: ${esc(state.checkoutBlockReason || 'server ne reason nahi diya')}</div>`}`;
    return `${head('CHECKOUT', 'Checkout', 'Address, bill aur payment — sab yahin.')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${eta}${savingsBanner}${delivery}<div class="line-heading">${icon('cart')} Your Order <span class="pill right">${quantity} item${quantity === 1 ? '' : 's'}${q ? ' · ' + money(q.total) : ''}</span></div>${restaurantCard}${renderMealRail(cart)}${groupCard}${idleNote}${!q ? renderFindingCoupon() : ''}${renderSavingsCorner(q)}${renderBill(q, cart)}${renderPayment(cart)}${renderWalletCard()}${payBar}`;
  }
  function renderOrders() {
    const detailed = state.ordersDetailAllowed !== false;
    const restrictedNote = detailed ? '' : '<div class="warning">Ye operator ka ID hai. Summary aur Swiggy ka tracking link dikhta hai — address, item list, delivery OTP sirf operator ke paas rehta hai.</div>';
    if (state.order) {
      const o = state.order;
      if (!detailed) {
        return `<button class="back-button" data-action="orders-back">${icon('back')} Back to orders</button>${head('ORDER SUMMARY', o.restaurant || 'Swiggy order', 'Operator ke ID par summary + tracking link milta hai.')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div></div><div class="card"><div class="card-title">${icon('orders')} Tracking <button class="button mini soft right" data-action="order-tracking">${icon('refresh')} Refresh</button></div>${trackingDetails(state.orderTracking)}</div>${smsTruthBlock(state.orderSms || state.orderTracking?.sms)}${restrictedNote}`;
      }
      return `<button class="back-button" data-action="orders-back">${icon('back')} Back to orders</button>${head('ORDER DETAILS', o.restaurant || 'Swiggy order', 'Only information returned by Swiggy is shown.')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div>${o.address ? `<div class="bill-row"><span>Address</span><strong>${esc(o.address)}</strong></div>` : ''}</div><div class="card"><div class="card-title">${icon('cart')} Ordered items</div>${o.items.length ? o.items.map(i => `<div class="bill-row"><span>${esc(i.name)}</span><strong>× ${Number(i.qty)}</strong></div>`).join('') : '<p class="hint">Swiggy did not return item details.</p>'}</div><div class="card"><div class="card-title">${icon('orders')} Tracking <button class="button mini soft right" data-action="order-tracking">${icon('refresh')} Refresh</button></div>${trackingDetails(state.orderTracking)}</div>${smsTruthBlock(state.orderSms || state.orderTracking?.sms)}`;
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
  /**
   * Boss (31-10-2026): "DATA TO ERASE HOJATA HAI." Ab backup ki asli haalat
   * dikhti hai — cloud chalu hai ya nahi, mirror me kitne user, last save kab.
   */
  function renderBackupCard() {
    if (!state.user?.isBoss) return '';
    const b = state.backup;
    if (!b) return '';
    const cloudOn = b.cloud?.enabled === true;
    const cloudError = b.cloud?.lastError || '';
    const lastOk = b.cloud?.lastOkAt ? new Date(b.cloud.lastOkAt).toLocaleString('en-IN') : '';
    const mirrorAt = b.dbMirror?.lastAt ? new Date(b.dbMirror.lastAt).toLocaleString('en-IN') : '';
    const restored = Number(b.restored?.count || 0);
    return `<div class="card backup-card"><div class="card-title">${tile('store')}<span class="title-copy">Data backup<small>Yahan se pata chalta hai ki data sach me safe hai ya nahi.</small></span></div>
      <div class="bill-row"><span>DB mirror (token ke bina)</span><strong class="${Number(b.dbMirror?.rows || 0) > 0 ? 'free' : ''}">${Number(b.dbMirror?.rows || 0)} workspace saved</strong></div>
      <div class="bill-row"><span>Mirror last save</span><strong>${esc(mirrorAt || 'abhi nahi')}</strong></div>
      <div class="bill-row"><span>Cloud vault</span><strong class="${cloudOn ? 'free' : ''}">${cloudOn ? 'ON' : 'OFF'}</strong></div>
      ${cloudOn ? `<div class="bill-row"><span>Cloud last success</span><strong>${esc(lastOk || 'abhi nahi')}</strong></div>` : ''}
      ${cloudError ? `<div class="warning">Cloud backup fail: ${esc(cloudError)}</div>` : ''}
      ${b.blockedPush?.line ? `<div class="warning">${esc(b.blockedPush.line)}</div>` : ''}
      <div class="bill-row"><span>Restore hua</span><strong>${restored} baar</strong></div>
      ${state.durability ? `<div class="bill-row"><span>Paisa + UTR backup</span><strong class="${state.durability.cloud ? 'free' : ''}">${state.durability.cloud ? 'Cloud ON' : 'OFF'}</strong></div><div class="bill-row"><span>Wallet / UTR yaad</span><strong>${Number(state.durability.wallets || 0)} / ${Number(state.durability.utrs || 0)}</strong></div>${state.durability.restoredAt ? `<div class="bill-row"><span>Deploy ke baad restore</span><strong>${esc(new Date(state.durability.restoredAt).toLocaleString('en-IN'))}</strong></div>` : ''}${state.durability.safetyLine ? `<div class="warning">${esc(state.durability.safetyLine)}</div>` : ''}${state.durability.cloud ? '' : `<div class="warning">${esc(state.durability.line || 'Cloud backup OFF hai — deploy par wallet aur UTR bhool sakte hain.')}</div>`}` : ''}
      <button class="button primary block" type="button" data-action="backup-now" ${state.backupBusy ? 'disabled' : ''}>${state.backupBusy ? 'Backup ho raha hai…' : 'Abhi backup karein'}</button>
      <p class="hint">Mirror bot ke db.json me encrypted hi rehta hai — redeploy ke baad wahi se wapas aata hai.</p></div>`;
  }
  /**
   * Boss (31-10-2026, round 11): "AISE AUTOMATIC BILL CALCULATE HONA CHAHIYE."
   * Cart khulte hi Swiggy se asli bill aa jata hai (coupon bhi khud lagta hai)
   * — Pay dabane ka intezaar nahi. Ek hi baar per cart+address, loop nahi.
   */
  function maybeAutoBill() {
    if (!state.auth || state.tab !== 'cart' || state.couponView || state.track) return;
    if (!state.checkoutEnabled || cartLocked()) return;
    const cart = state.cart;
    const addr = state.selectedAddress;
    if (!cart?.items?.length || cart.quote) return;
    if (!String(addr?.name || '').trim() || String(addr?.mobile || '').replace(/\D/g, '').length !== 10) return;
    const signature = `${cart.restaurantId}:${cart.items.length}:${addr.id}:${cart.forSomeoneElse === true}`;
    if (state.autoBillFor === signature) return;
    state.autoBillFor = signature;
    api('cart/sync', 'POST', {
      confirmReplaceSwiggyCart: true,
      forSomeoneElse: cart.forSomeoneElse === true,
      coupon: '', autoCoupon: true
    }).then(out => {
      merge(out); render();
      if (out.cart?.quote) toast('Bill taiyar — Swiggy ka hisaab neeche hai.');
    }).catch(e => {
      // Bill na aaye to user ko wajah dikhe — chup-chaap kuch nahi hota.
      toast(e?.message || 'Swiggy ne bill nahi diya.');
    });
  }

  /**
   * Boss (31-10-2026, round 20): "UTR PAR JITNA AMOUNT JAYE AGAR WO MISBAHUL
   * ISLAM HO UTNA ADD HOJAYE" — isliye asli paisa ka sabooot: UPI/bank
   * statement. Boss apni statement (ya SMS) paste karta hai, jis UTR ka paisa
   * sach me aaya hai sirf wahi amount credit hota hai.
   */
  /**
   * Boss (31-10-2026, round 21): "NO SMS RECEIVED" — SMS ka asli rasta ya
   * pehle se band? Ye card wahi sach dikhata hai (boss only).
   */
  /**
   * Boss (31-10-2026, round 22): "JITNE BHI LOGIN ID HOTE HAIN KISKA DATA NAHI
   * BACHTA WO KISLIYE AND KYA SOLUTION HAI" — jawab yahan: har ID ka session
   * saved hai ya nahi, cloud backup chalu hai ya nahi, aur Restore/Backup buttons.
   */
  function renderIdentitiesCard() {
    if (!state.user?.isBoss) return '';
    const id = state.identities;
    if (!id) return '';
    const rows = (id.accounts || []).map(a => {
      const badge = a.status === 'LOGGED_IN' ? 'green' : a.status === 'EXPIRED' ? 'amber' : 'grey';
      const label = a.status === 'LOGGED_IN' ? 'Session saved' : a.status === 'EXPIRED' ? 'Expired' : a.status === 'NO_SESSION' ? 'Session nahi' : 'Logout';
      return `<div class="offer-row"><span class="offer-emoji">${a.status === 'LOGGED_IN' ? '✅' : '⚠️'}</span><span class="row-content"><strong>${esc(a.name || a.key)}</strong><p>${a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : 'number nahi'}${a.savedAt ? ' · saved ' + esc(new Date(a.savedAt).toLocaleString('en-IN')) : ''}${a.restoredFromSnapshot ? ' · deploy ke baad wapas aaya' : ''}</p></span><span class="pill ${badge}">${esc(label)}</span></div>`;
    }).join('') || '<p class="hint">Koi login ID saved nahi hai — pehle ID add karein.</p>';
    return `<div class="card"><div class="card-title">${tile('store')}<span class="title-copy">Login ID ka data<small>Deploy ke baad kaunsi ID bachegi — yahan sach dikhta hai.</small></span></div>
      <div class="bill-row"><span>IDs saved</span><strong>${Number(id.total || 0)} (${Number(id.live || 0)} live)</strong></div>
      <div class="bill-row"><span>Mini-app workspaces</span><strong>${Number(id.workspaceCount || 0)}</strong></div>
      <div class="bill-row"><span>Cloud backup</span><strong class="${id.cloud ? 'free' : ''}">${id.cloud ? 'ON' : 'OFF'}</strong></div>
      ${id.lastPushAt ? `<div class="bill-row"><span>Last backup</span><strong>${esc(new Date(id.lastPushAt).toLocaleString('en-IN'))}</strong></div>` : ''}
      ${id.restoredAt ? `<div class="bill-row"><span>Deploy ke baad restore</span><strong>${esc(new Date(id.restoredAt).toLocaleString('en-IN'))}</strong></div>` : ''}
      <div class="warning">${esc(id.line || '')}</div>
      ${id.safetyLine && id.safetyLine !== id.line ? `<div class="warning">${esc(id.safetyLine)}</div>` : ''}
      ${rows}
      <button class="button primary block" type="button" data-action="identities-backup" ${state.identityBusy ? 'disabled' : ''}>${state.identityBusy ? 'Backup ho raha hai…' : 'Sab ID abhi backup karein'}</button>
      <button class="button soft block" type="button" data-action="identities-verify" ${state.identityBusy ? 'disabled' : ''}>${state.identityBusy ? 'Check ho raha hai…' : 'Sessions Swiggy par check karein'}</button>
      ${state.identityNote ? `<p class="hint">${esc(state.identityNote)}</p>` : ''}
      <p class="hint">Har ID ka session encrypted hi save hota hai (cookies kahin plaintext me nahi). Deploy par disk khali ho jaye to yahi backup se wapas aata hai.</p></div>`;
  }
  function renderLiveOrderCard() {
    const live = state.liveOrder;
    if (!state.user?.isBoss || !live) return '';
    return `<div class="card"><div class="card-title">${tile('store')}<span class="title-copy">Live order + SMS<small>Swiggy ka SMS sirf asli order par aata hai.</small></span></div>
      <div class="bill-row"><span>Live order place</span><strong class="${live.blocked ? '' : 'free'}">${live.blocked ? 'BAND' : 'ON'}</strong></div>
      <div class="bill-row"><span>SMS ka rasta</span><strong>${live.smsAllowed ? 'Swiggy (live)' : 'Swiggy (normal)'}</strong></div>
      ${live.blocked ? `<div class="warning">${esc(live.line)}</div>` : `<p class="hint">${esc(live.line)}</p>`}</div>`;
  }
  function renderStatementCard() {
    if (!state.user?.isBoss) return '';
    const st = state.statement || null;
    const money = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;
    const rows = st ? `<div class="bill-row"><span>Statement entries</span><strong>${Number(st.count || 0)}</strong></div>
      <div class="bill-row"><span>Asli paisa dikha</span><strong>${money(st.totalPaise)}</strong></div>
      <div class="bill-row"><span>Misbahul Islam ke naam</span><strong>${Number(st.bossPayeeCount || 0)}</strong></div>
      <div class="bill-row"><span>Verify ka intezaar</span><strong>${Number(st.pendingClaims || 0)} claim${Number(st.pendingMatched || 0) ? ` (${Number(st.pendingMatched)} match)` : ''}</strong></div>` : '';
    const recent = st?.recent?.length
      ? st.recent.slice(0, 5).map(r => `<div class="bill-row"><span>${esc(r.utr)} · ${esc(new Date(r.at || Date.now()).toLocaleDateString('en-IN'))}</span><strong>${money(r.amountPaise)}</strong></div>`).join('')
      : '<p class="hint">Abhi koi statement entry nahi — neeche paste karein.</p>';
    return `<div class="card"><div class="card-title">${tile('receipt')}<span class="title-copy">UPI statement (asli paisa)<small>Customer khud UTR likh kar paisa nahi bana sakta.</small></span></div>
      ${rows}${recent}
      <form data-form="statement" novalidate><div class="input-wrap"><textarea name="text" rows="4" placeholder="UPI/bank statement ki lines paste karein — jaise: 31-10-2026 UPI/CR/123456789012/MISBAHUL ISLAM/₹15.00"></textarea></div><button class="button primary block" type="submit">Statement import karein ${icon('arrow')}</button></form>
      <p class="hint">Jis UTR ka paisa Misbahul Islam ke account (mius@ybl) me aaya hai, sirf utna hi amount judega — chhota ya random UTR credit nahi hoga.</p></div>`;
  }
  /**
   * Boss (31-10-2026, round 25): "UPI PAYMENT AGAR ME TRACK KARNA CHAHTA ...
   * BAS USSE UTR LUNGA AUR UTR SE SAB DETAILS NIKAALUNGA — ABHI YA OLD, KISI
   * AUR KO, AUR KITNA".
   *
   * Yahan boss koi bhi UTR daal kar poora sach dekhta hai: kitna aaya, kab
   * aaya, kisko aaya, kaun bheja, status, pehle use hua ya nahi — aur credit
   * ka faisla + kya kya chahiye.
   */
  function renderUtrTrackCard() {
    if (!state.user?.isBoss) return '';
    const t = state.utrTrack;
    const verdictPill = t?.truth?.verdict?.action === 'CREDIT' ? 'green' : t?.truth?.verdict?.action === 'REJECT' ? 'red' : 'amber';
    const verdictLabel = t?.truth?.verdict?.action === 'CREDIT' ? 'CREDIT HOGA' : t?.truth?.verdict?.action === 'REJECT' ? 'REJECT' : 'PENDING';
    const rows = (t?.truth?.rows || []).map(r => `<div class="bill-row"><span>${esc(r.label)}</span><strong class="${r.ok ? 'free' : ''}">${esc(r.value)}</strong></div>`).join('');
    const missing = (t?.truth?.missing || []).length
      ? `<div class="warning">Chahiye: ${esc((t.truth.missing || []).map(m => m.line).join('; '))}</div>` : '';
    return `<div class="card"><div class="card-title">${tile('receipt')}<span class="title-copy">UTR se payment track<small>Sirf UTR daalein — baaki sab server khud nikaalta hai.</small></span></div>
      <form data-form="utr-track" novalidate><div class="input-wrap">${icon('search')}<input name="utr" inputmode="numeric" maxlength="12" placeholder="12 digit UTR" value="${esc(t?.utr || '')}" required></div><button class="button primary block" type="submit" ${state.utrTrackBusy ? 'disabled' : ''}>${state.utrTrackBusy ? 'Details nikaal rahe hain…' : 'UTR ki poori detail nikaalein'}</button></form>
      ${t ? `<div class="divider"></div><div class="bill-row"><span>Faisla</span><strong><span class="pill ${verdictPill}">${esc(verdictLabel)}</span></strong></div>${rows}${missing}<p class="hint">${esc(t.bossLine || '')}</p>${t.claim ? `<p class="hint">Claim: ${esc(String(t.claim.status || ''))} · user ${esc(String(t.claim.userId || ''))} · ₹${(Number(t.claim.claimedPaise || 0) / 100).toFixed(2)}</p>` : ''}` : '<p class="hint">Koi bhi UTR daal kar dekhein: kitna aaya, kab aaya, kisko aaya, kaun bheja.</p>'}</div>`;
  }
  /**
   * Boss (31-10-2026, round 26): "PHIR DEPLOY HOTE HI SAB ERASE HOGAYA".
   * Yahan ek ek kadam ka asli jawab — token, branch, vault files, likhne ka
   * test — aur ek button jo vault se turant restore karta hai.
   */
  function renderDoctorCard() {
    if (!state.user?.isBoss) return '';
    const d = state.doctor;
    const rows = (d?.steps || []).map(s => `<div class="offer-row"><span class="offer-emoji">${s.ok ? '✅' : '❌'}</span><span class="row-content"><strong>${esc(s.label)}</strong><p>${esc(s.detail)}</p></span><span class="pill ${s.ok ? 'green' : 'red'}">${s.ok ? 'OK' : 'FAIL'}</span></div>`).join('');
    const need = (d?.nextStep || []).length ? `<div class="warning">Karna hai: ${esc(d.nextStep.join(' · '))}</div>` : '';
    return `<div class="card"><div class="card-title">${tile('store')}<span class="title-copy">Backup ka asli check<small>Deploy par data bachega ya nahi — ek ek kadam.</small></span></div>
      <button class="button primary block" type="button" data-action="doctor-run" ${state.doctorBusy ? 'disabled' : ''}>${state.doctorBusy ? 'Jaanch ho rahi hai…' : 'Poori jaanch karein (vault write test ke saath)'}</button>
      ${d ? `${rows}<div class="warning">${esc(d.verdictLine || '')}</div>${need}` : '<p class="hint">Abhi jaanch nahi hui — button dabayein. Ye sach me token/branch/vault check karta hai.</p>'}
      ${d ? `<button class="button soft block" type="button" data-action="doctor-restore" ${state.restoreBusy ? 'disabled' : ''}>${state.restoreBusy ? 'Restore ho raha hai…' : 'Vault se abhi restore karein'}</button>` : ''}
      ${state.doctorNote ? `<p class="hint">${esc(state.doctorNote)}</p>` : ''}</div>`;
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
    return `${head('A LITTLE EXTRA', 'Offers & tools', 'Night, breakfast, extra ₹50 aur weekend — yahin se claim.')}${result}${renderWalletCard()}${accounts}${renderIdentitiesCard()}${renderStatementCard()}${renderUtrTrackCard()}${renderLiveOrderCard()}${renderBackupCard()}${renderDoctorCard()}`;
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
  /**
   * Boss (31-10-2026, round 13): "2 minutes of activity ke baad pura order
   * band ho jayega." Server har request par yeh khud karta hai; app sirf itna
   * karta hai ki 2 minute baad khud refresh ho kar band hua order dikha de
   * (user ko button dabane ki zaroorat nahi).
   */
  let idleTimer = null;
  function scheduleIdleRefresh() {
    clearTimeout(idleTimer);
    const timeout = Number(state.idle?.timeoutMs || 0);
    if (!timeout) return;
    const hasDraft = Boolean(state.cart || (state.checkout && state.checkout.status !== 'PAID'));
    if (!hasDraft) return;
    idleTimer = setTimeout(async () => {
      try {
        const out = await api('bootstrap');
        merge(out); render();
      } catch { /* net gaya — agla render phir try karega */ }
    }, timeout + 2000);
  }
  /**
   * Boss (31-10-2026, round 19): "ORDER PAYMENT KARNE KE BAAAD AUTO FETCH BHI
   * NAHI HORAHA" — ab QR screen khud payment check karti rehti hai. Pehla check
   * 8s baad, phir har 12s, ~6 minute tak; PAID milte hi tracking khul jata hai.
   */
  let paymentPollTimer = null;
  let paymentPollCount = 0;
  function stopPaymentPoll() {
    clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
    paymentPollCount = 0;
  }
  function schedulePaymentPoll() {
    const c = state.checkout;
    const pending = c && c.status === 'PAYMENT_PENDING' && c.paymentVerified !== true;
    if (!pending) return stopPaymentPoll();
    if (paymentPollTimer || paymentPollCount >= 30) return;
    const delay = paymentPollCount === 0 ? 8000 : 12000;
    paymentPollTimer = setTimeout(async () => {
      paymentPollTimer = null;
      paymentPollCount += 1;
      try {
        const out = await api('checkout/status', 'POST', {});
        merge(out);
        render();
        if (out.checkout?.status === 'PAID' && out.checkout.orderId) {
          stopPaymentPoll();
          toast('Payment mil gayi — order track ho raha hai.', 'ok');
          startTracking(out.checkout.orderId, 'checkout');
        }
      } catch { /* net gaya — agla render phir schedule karega */ }
    }, delay);
    if (typeof paymentPollTimer?.unref === 'function') paymentPollTimer.unref();
  }

  function render() {
    // Telegram WebView band hone ke baad bhi async response aa sakta hai —
    // tab render chup-chaap rukna chahiye, window crash nahi.
    try {
      // Re-render par user ka typed text na ude (coupon code / group cart link).
      try {
        const couponInput = document.querySelector('input[name="coupon"]');
        if (couponInput) state.couponDraft = couponInput.value;
        const cartInput = document.querySelector('input[name="url"]');
        if (cartInput) state.groupCartDraft = cartInput.value;
      } catch { /* window band ho gaya */ }
      const views = { accounts: renderAccounts, address: renderAddress, search: renderSearch, cart: renderCart, orders: renderOrders, tools: renderTools };
      $('#content').innerHTML = state.auth ? views[state.tab]() : renderConnection();
      renderNav();
      $('#connection-notice').hidden = true;
      if (state.idleClosed) {
        const closed = state.idleClosed;
        state.idleClosed = null;
        toast(closed.message || 'Draft order band ho gaya (2 minute tak koi activity nahi).');
      }
      maybeAutoBill();
      scheduleIdleRefresh();
      schedulePaymentPoll();
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
  // ── Meal rail, coupons aur tracking ────────────────────────────────────────
  /** Isi restaurant ka menu ek hi baar load hota hai ("Complete your meal"). */
  function maybeLoadMeal(cart) {
    const id = String(cart?.restaurantId || '');
    if (!id || state.mealFor === id || state.mealLoading) return;
    state.mealFor = id;
    state.mealLoading = true;
    api('menu?id=' + encodeURIComponent(id))
      .then(out => { if (String(state.cart?.restaurantId || '') === id) state.meal = out; })
      // Fail hone par dobara retry nahi karte — warna render loop ban jaata hai
      // (har fail par render, har render par naya fetch).
      .catch(() => { state.meal = null; })
      .finally(() => { state.mealLoading = false; render(); });
  }
  async function loadCoupons() {
    if (state.couponsLoading) return;
    const id = String(state.cart?.restaurantId || '');
    if (!id) return;
    state.couponsLoading = true; render();
    try {
      const out = await api('coupons?id=' + encodeURIComponent(id));
      state.coupons = Array.isArray(out.coupons) ? out.coupons : [];
      state.couponsNote = out.note || '';
    } catch (e) {
      state.coupons = [];
      state.couponsNote = e.message || 'Coupon list nahi aayi.';
    } finally {
      state.couponsLoading = false; render();
    }
  }
  let trackTimer = null;
  function stopTrackPolling() { if (trackTimer) { clearTimeout(trackTimer); trackTimer = null; } }
  function scheduleTrackPolling() {
    stopTrackPolling();
    trackTimer = setTimeout(() => { trackTimer = null; if (state.track && document.getElementById('content')) loadTrack(); }, 20000);
  }
  async function loadTrack() {
    if (!state.track) return;
    const scope = state.track.scope === 'checkout' ? '&scope=checkout' : '';
    state.trackBusy = true; render();
    try {
      const out = await api('orders/tracking?id=' + encodeURIComponent(state.track.id) + scope);
      state.trackData = out.tracking || null;
      state.trackSms = out.sms || null;
      state.trackError = '';
    } catch (e) {
      state.trackError = e.message || 'Tracking nahi mili.';
    } finally {
      state.trackBusy = false; render(); scheduleTrackPolling();
    }
  }
  function startTracking(orderId, scope = 'active') {
    if (!orderId) return;
    state.track = { id: String(orderId), scope };
    state.trackData = null;
    state.trackError = '';
    state.couponView = false;
    state.tab = 'cart';
    writeCache({ tab: 'cart' });
    render(); window.scrollTo(0, 0);
    loadTrack();
  }
  /** Receiver ka naam + 10-digit mobile Swiggy maangta hai — pehle wahin bhejo. */
  function receiverReady() {
    const addr = state.selectedAddress;
    if (!addr) {
      state.tab = 'address'; writeCache({ tab: 'address' }); render();
      toast('Pehle delivery address chunein.', 'bad');
      return false;
    }
    const mobile = String(addr.mobile || '').replace(/\D/g, '').slice(-10);
    if (!String(addr.name || '').trim() || mobile.length !== 10) {
      state.tab = 'address'; state.contactEdit = true; writeCache({ tab: 'address' }); render();
      toast('Receiver ka naam aur 10-digit mobile bhar dein — Swiggy iske bina bill/order nahi deta.', 'bad');
      return false;
    }
    return true;
  }
  /** Coupon APPLY — seedha Swiggy bill. Koi code type nahi, koi extra tap nahi. */
  async function applyCoupon(code, button) {
    const value = String(code || '').trim().toUpperCase();
    if (!value || value === state.couponBusy) return;
    if (!receiverReady()) return;
    state.couponBusy = value; render();
    try {
      const out = await api('cart/sync', 'POST', {
        coupon: value,
        forSomeoneElse: state.cart?.forSomeoneElse === true,
        confirmReplaceSwiggyCart: true
      });
      merge(out);
      const applied = Number(out.cart?.quote?.discount || 0);
      state.couponResults = { ...(state.couponResults || {}), [value]: applied > 0
        ? { ok: true, saved: applied }
        : { ok: false, message: 'Swiggy ne is code par discount nahi diya — bill me 0 dikha.' } };
      render();
      toast(applied > 0 ? `${value} lag gaya — ${money(applied)} ki saving.` : `${value} par Swiggy ne discount nahi diya.`, applied > 0 ? 'ok' : 'bad');
    } catch (e) {
      state.couponResults = { ...(state.couponResults || {}), [value]: { ok: false, message: e?.message || 'Swiggy ne ye coupon nahi liya.' } };
      render();
      throw e;
    } finally {
      state.couponBusy = ''; render();
    }
  }
  /** Coupon hatana — phir se asli bill. */
  async function removeCoupon() {
    if (!receiverReady()) return;
    const out = await api('cart/sync', 'POST', {
      coupon: '',
      autoCoupon: false,
      forSomeoneElse: state.cart?.forSomeoneElse === true,
      confirmReplaceSwiggyCart: true
    });
    merge(out);
    state.couponResults = {};
    render();
    toast('Coupon hata diya — naya bill aa gaya.', 'ok');
  }
  function forms(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.form; const data = new FormData(form); const button = form.querySelector('button[type="submit"],button:not([type])');
    run(async () => {
      if (type === 'send-otp') {
        const phone = String(data.get('phone') || '').trim();
        try {
          await api('accounts/send-otp', 'POST', { phone });
        } catch (e) {
          if (e.code !== 'SWIGGY_ACCOUNT_NOT_REGISTERED') throw e;
          // Boss (31-10-2026): "NAYA ACCOUNT HAI TO LOGIN HI NAHI HOTA."
          if (!await confirmInApp({
            title: 'Naya Swiggy account banayein?',
            message: `${phone} Swiggy par naya number hai. Isi number se naya Swiggy account banega (naam: ${state.user?.name || 'aapka naam'}), phir OTP aayega. Aage ke order isi account se honge.`,
            confirmText: 'Account banayein'
          })) return;
          await api('accounts/send-otp', 'POST', { phone, signup: true });
        }
        state.otpSent = true; render(); toast('OTP request accepted by Swiggy.');
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
        const url = String(data.get('url') || state.groupCartDraft || '').trim();
        if (!url) { toast('Pehle group cart ka link paste karein.', 'bad'); return; }
        if (state.cart && !await confirmInApp({ title: 'Draft cart replace karein?', message: 'Aapka draft cart is group cart se replace ho jayega. Purana draft chala jayega.', confirmText: 'Replace karein' })) return;
        const out = await api('cart/import-group', 'POST', { url, replace: Boolean(state.cart) });
        state.groupCartDraft = '';
        merge(out);
        const count = out.cart?.items?.reduce((n, i) => n + Number(i.qty || 0), 0) || 0;
        state.tab = 'cart'; writeCache({ tab: 'cart' }); render();
        toast(`Cart parse ho gaya — ${count} item${count === 1 ? '' : 's'}. Ab bill check karein.`);
      } else if (type === 'wallet-claim') {
        const utr = String(data.get('utr') || '').trim().replace(/\s+/g, '');
        const amountRupees = Number(String(data.get('amount') || '').replace(/[^0-9.]/g, ''));
        if (!/^\d{12}$/.test(utr)) { toast('UPI app se poora 12-digit UTR daaliye.', 'bad'); return; }
        // QR khula hai to usi top-up par claim; warna jo amount user ne likha.
        const payload = state.walletTopup?.topupId
          ? { topupId: state.walletTopup.topupId, amountPaise: state.walletTopup.amountPaise, utr }
          : { amountPaise: Math.round(amountRupees * 100), utr };
        if (!state.walletTopup?.topupId && !(amountRupees >= 1)) { toast('Jitna paisa bhejna hai utna likhein (₹1 se zyada).'); return; }
        state.walletClaimBusy = true; state.walletClaimNote = ''; render();
        try {
          const out = await api('wallet/claim', 'POST', payload);
          merge(out); state.walletTopup = null; state.walletSheet = false;
          // Round 25: user ko bhi poora sach — kitna aaya, kab, kisko.
          state.walletClaimNote = out.utrTruth?.summaryLine || out.lookupLine || '';
          toast(out.message || 'UTR ki payment fetch hui — jitna aaya utna juda.', out.pending ? 'info' : 'ok');
        } finally { state.walletClaimBusy = false; render(); }
      } else if (type === 'utr-track') {
        const utr = String(data.get('utr') || '').trim().replace(/\s+/g, '');
        if (!/^\d{12}$/.test(utr)) { toast('Poora 12-digit UTR daaliye.'); return; }
        state.utrTrackBusy = true; render();
        try {
          const out = await api('boss/utr', 'POST', { utr });
          state.utrTrack = out; render();
          toast(out.truth?.summaryLine || 'UTR ki detail aa gayi.');
        } finally { state.utrTrackBusy = false; render(); }
      } else if (type === 'statement') {
        const text = String(data.get('text') || '').trim();
        if (text.length < 10) { toast('Statement ki lines paste karein (UTR + amount).'); return; }
        const out = await api('boss/statement', 'POST', { text });
        merge(out);
        const settled = Array.isArray(out.settled) ? out.settled.filter(s => s.action === 'CREDIT') : [];
        render();
        toast(settled.length
          ? `${settled.length} claim verify hua — asli amount juda.`
          : `Statement import hua (${Number(out.imported?.accepted || 0)} credit line). Koi pending claim match nahi hua.`);
      } else if (type === 'wallet-upi') {
        const out = await api('wallet/upi', 'POST', { upiId: String(data.get('upiId') || '').trim() });
        merge(out); state.walletUpiEdit = false; render();
        toast(`UPI set: ${out.upiId}`);
      } else if (type === 'delete-otp') {
        const out = await api('accounts/remove/confirm', 'POST', { key: state.deleteFlow?.key, otp: data.get('otp') });
        merge(out); state.deleteFlow = null; state.addresses = []; state.orders = null; render(); toast('Account Swiggy se delete ho gaya.');
      } else if (type === 'coupon-apply') {
        const code = String(data.get('coupon') || state.couponDraft || '').trim().toUpperCase();
        if (!code) { toast('Pehle coupon code likhein.'); return; }
        await applyCoupon(code, button);
      } else if (type === 'sync') {
        // Coupon page ka APPLY bhi yahi raasta use karta hai (ek hi sach).
        const code = String(data.get('coupon') || state.couponDraft || '').trim().toUpperCase();
        if (code && !/^[A-Z0-9_-]{3,28}$/.test(code)) throw new Error('Coupon code galat lag raha hai (3-28 letters/numbers).');
        if (!await confirmInApp({ title: 'Sync cart with Swiggy?', message: 'This replaces the current cart on your selected Swiggy account and may save the address there.', confirmText: 'Sync cart' })) return;
        if (!receiverReady()) return;
        // The prior quote is stale as soon as sync starts, including when the
        // response times out after Swiggy has changed the cart.
        state.cart.quote = null; render();
        const out = await api('cart/sync', 'POST', { coupon: code, forSomeoneElse: data.has('forSomeoneElse'), confirmReplaceSwiggyCart: true });
        state.couponDraft = '';
        merge(out); render();
        const applied = Number(out.cart?.quote?.discount || 0);
        toast(code ? (applied > 0 ? `Coupon ${code} lag gaya — ${money(applied)} bachaya.` : `Swiggy ne ${code} par discount nahi diya (bill me 0).`) : 'Bill returned by Swiggy. Check it before paying.');
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
    // Boss (31-10-2026): "ADDRESS PAGE LOAD HO RAHA HAI TO KISI AUR PAGE PAR
    // SHIFT NAHI HO PAA RAHA." Nav par koi busy-lock nahi — tab turant badalta hai.
    if (action === 'nav') {
      stopTrackPolling();
      if (button.dataset.tab !== 'cart') { state.track = null; state.couponView = false; }
      startLoading();
      // navigate apna render turant karta hai (await se pehle) — isliye seedha
      // bulate hain taaki tap ka asar usi pal dikhe.
      try {
        const pending = navigate(button.dataset.tab);
        if (pending && typeof pending.catch === 'function') {
          pending.catch(err => toast(err?.message || 'Page nahi khula. Dobara dabaiye.')).finally(() => stopLoading());
        } else stopLoading();
      } catch (err) {
        stopLoading();
        toast(err?.message || 'Page nahi khula. Dobara dabaiye.');
      }
      return;
    }
    if (action === 'theme') { document.body.classList.toggle('dark'); try { localStorage.setItem('pro-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch {} writeCache({ theme: document.body.classList.contains('dark') ? 'dark' : 'light' }); return; }
    if (action === 'account-mode') { state.mode = button.dataset.mode; state.otpSent = false; render(); return; }
    if (action === 'otp-reset') { state.otpSent = false; render(); return; }
    if (action === 'toggle-coupon' || action === 'coupon-open') { state.couponView = true; state.couponOpen = true; render(); window.scrollTo(0, 0); if (state.coupons === null) loadCoupons(); return; }
    if (action === 'coupon-back') { state.couponView = false; state.coupons = null; render(); window.scrollTo(0, 0); return; }
    if (action === 'bill-open') {
      state.billOpen = !state.billOpen;
      render();
      const bill = document.getElementById('bill-details');
      if (bill && typeof bill.scrollIntoView === 'function') bill.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'track-close') { stopTrackPolling(); state.track = null; state.trackData = null; state.trackError = ''; render(); window.scrollTo(0, 0); return; }
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
    if (action === 'order-detail') {
      state.order = state.orders?.find(o => o.id === button.dataset.id) || null;
      state.orderTracking = null; render(); window.scrollTo(0,0);
      // Boss (31-10-2026, round 21): "NO TRACKING IS AVAILABLE" — ab order
      // kholte hi tracking khud aati hai, Refresh dabana zaroori nahi.
      if (state.order?.id) {
        const scope = state.ordersScope === 'checkout' ? '&scope=checkout' : '';
        api('orders/tracking?id=' + encodeURIComponent(state.order.id) + scope)
          .then(out => { if (state.order?.id === button.dataset.id) { state.orderTracking = out.tracking || null; state.orderSms = out.sms || null; render(); } })
          .catch(e => { state.orderTracking = null; state.orderSms = e; render(); });
      }
      return;
    }
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
      } else if (action === 'identities-backup' || action === 'identities-verify') {
        const verify = action === 'identities-verify';
        state.identityBusy = true; state.identityNote = ''; render();
        try {
          const out = await api('boss/identities', 'POST', verify ? { verify: true } : {});
          if (out.identities) state.identities = out.identities;
          if (verify) {
            const rows = out.results || [];
            const dead = rows.filter(r => !r.valid);
            state.identityNote = rows.length
              ? `${rows.length} ID check hui — ${rows.length - dead.length} live, ${dead.length} ka session Swiggy par khatam.${dead.length ? ' ' + dead.map(d => d.name || d.key).join(', ') + ' ko dobara login karein.' : ''}`
              : (out.note || '');
            toast(dead.length ? `${dead.length} ID ka session khatam — dobara login karein.` : 'Saari IDs live hain.');
          } else {
            state.identityNote = out.message || '';
            toast(out.message || 'Backup ho gaya.');
          }
        } finally { state.identityBusy = false; render(); }
      } else if (action === 'doctor-run') {
        state.doctorBusy = true; state.doctorNote = ''; render();
        try {
          const out = await api('boss/durability');
          state.doctor = out.doctor; state.doctorNote = '';
          render();
          toast(out.doctor?.verdictLine || 'Jaanch poori hui.');
        } finally { state.doctorBusy = false; render(); }
      } else if (action === 'doctor-restore') {
        state.restoreBusy = true; render();
        try {
          const out = await api('boss/durability/restore', 'POST', {});
          state.doctorNote = out.message || '';
          if (out.identities) state.identities = out.identities;
          if (out.durability) state.durability = out.durability;
          merge(out);
          render();
          toast(out.message || 'Restore ho gaya.');
        } finally { state.restoreBusy = false; render(); }
      } else if (action === 'identities-refresh') {
        const out = await api('boss/identities'); state.identities = out.identities || null; render();
      } else if (action === 'backup-now') {
        state.backupBusy = true; render();
        try {
          const out = await api('backup', 'POST', {});
          merge(out);
          const cloud = out.result?.cloud;
          toast(cloud?.ok ? 'Backup ho gaya — cloud + mirror dono.' : (out.result?.mirrored ? 'Mirror me save ho gaya (cloud OFF/fail).' : 'Backup fail — wajah upar likhi hai.'));
        } finally { state.backupBusy = false; render(); }
      } else if (action === 'addresses-refresh') await loadAddresses();
      else if (action === 'cart-clear') {
        if (!await confirmInApp({ title: 'Cart clear karein?', message: 'Draft cart ke saare items hat jayenge. Swiggy cart tab tak waisa hi rahega jab tak naya sync na ho.', confirmText: 'Clear cart', danger: true })) return;
        await api('cart/clear', 'POST', { confirmClear: true });
        state.cart = null; state.outlets = null; state.outletsOpen = false; state.couponOpen = false;
        render(); toast('Cart clear ho gaya.');
      }
      else if (action === 'coupon-remove') { await removeCoupon(); }
      else if (action === 'coupon-pick') { await applyCoupon(button.dataset.code, button); }
      else if (action === 'track-refresh') { await loadTrack(); }
      else if (action === 'track-open') {
        const id = button.dataset.id || state.checkout?.orderId;
        if (!id) throw new Error('Order ID nahi mila. Orders tab me check karein.');
        startTracking(id, 'checkout');
      }
      else if (action === 'bill-refresh') {
        if (!await confirmInApp({ title: 'Fresh bill check?', message: 'Swiggy par cart dobara sync hoga aur naya bill aayega.', confirmText: 'Check bill' })) return;
        const out = await api('cart/sync', 'POST', { confirmReplaceSwiggyCart: true, forSomeoneElse: state.cart?.forSomeoneElse === true, coupon: String(state.cart?.quote?.couponCode || state.cart?.quote?.coupon || ''), autoCoupon: true });
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
      else if (action === 'wallet-topup') {
        const paise = Number(button.dataset.paise || 0) || (state.wallet?.shortfallPaise ?? 0) || 1500;
        const out = await api('wallet/topup', 'POST', { amountPaise: paise });
        state.walletTopup = out.topup; state.walletSheet = true; render();
      }
      else if (action === 'wallet-close') { state.walletTopup = null; state.walletSheet = false; render(); }
      else if (action === 'wallet-upi-edit') { state.walletUpiEdit = true; render(); }
      else if (action === 'checkout-start') {
        if (!state.activeAccount) { state.tab = 'accounts'; writeCache({ tab: 'accounts' }); render(); toast('Pehle Swiggy ID chunein.'); return; }
        if (!state.cart?.items?.length) throw new Error('Cart khaali hai — pehle koi item add karein.');
        // Address/receiver pehle — warna Swiggy bill/order deta hi nahi aur user
        // ko lagta hai "checkout kaam nahi kar raha".
        if (!receiverReady()) return;
        let quote = state.cart?.quote;
        if (!quote) {
          // Boss: "Pay Now ka button active karna" — bill na ho to yahin
          // Swiggy se taaza bill lete hain, phir seedha payment.
          const synced = await api('cart/sync', 'POST', { confirmReplaceSwiggyCart: true, forSomeoneElse: state.cart?.forSomeoneElse === true, coupon: String(state.cart?.quote?.couponCode || state.cart?.quote?.coupon || ''), autoCoupon: true });
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
          // Boss (31-10-2026): "PAY PAR CLICK KARTA HU TO ... COULD NOT BE
          // CONFIRMED" — ab har wajah alag dikhti hai. Bill badla ho to naya
          // bill save ho chuka hai; order nahi gaya, dobara Pay dabaiye.
          // Boss (31-10-2026, round 11): wallet kam hai to saaf batao aur
          // wallet card ke paas le jao — generic error nahi.
          if (e.code === 'WALLET_LOW_BALANCE') {
            state.wallet = e.wallet || state.wallet;
            state.walletSheet = true;
            try { merge(await api('bootstrap')); } catch {}
            render();
            toast(e.message || 'Wallet balance kam hai — pehle paise add karein.');
            return;
          }
          const prePlacement = ['BILL_CHANGED', 'CART_ITEMS', 'ADDRESS', 'OFO', 'CART_FETCH', 'CART_PARSE', 'COUPON', 'AMOUNT', 'AMOUNT_MISSING', 'CART_ID', 'RESTAURANT'].includes(String(e.code || ''));
          if (prePlacement) {
            try { merge(await api('bootstrap')); } catch {}
            render();
            toast(e.message || 'Order place nahi hua — naya bill dekh kar dobara Pay dabaiye.');
            return;
          }
          // A lost browser response is not proof that the server never sent the
          // request. Hide retry until an authenticated bootstrap resolves it.
          state.checkout = { status: 'OUTCOME_UNKNOWN', message: 'The response was lost. Check Swiggy My Orders; do not place another order.' };
          try { merge(await api('bootstrap')); } catch {}
          render();
          throw e;
        }
      }
      else if (action === 'checkout-status') {
        paymentPollCount = 0;
        const out = await api('checkout/status', 'POST', {});
        merge(out); render();
        if (out.checkout?.status === 'PAID' && out.checkout.orderId) {
          // Boss (31-10-2026): "WHEN WE PAY WE CAN TRACK THAT ORDER."
          toast('Payment mil gayi — order track ho raha hai.');
          startTracking(out.checkout.orderId, 'checkout');
          return;
        }
        toast(out.checkout?.status === 'PAID' ? 'Swiggy ne paid order de diya.' : 'Status check ho gaya. Paisa de diya ho to dobara na dein.');
      }
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
        const out = await api('orders/tracking?id=' + encodeURIComponent(state.order.id) + scope);
        state.orderTracking = out.tracking; state.orderSms = out.sms || null; render();
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
