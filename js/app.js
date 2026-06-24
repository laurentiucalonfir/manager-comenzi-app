let currentPin = '';
let currentUser = null;
let cart = {};
let lastResults = [];
let _authResolve = null;

function waitForAuth() {
  if (_authResolve) return _authResolve;
  _authResolve = new Promise(function(resolve) {
    if (authUser) { resolve(authUser); return; }
    function checkAuth() {
      if (authUser) { resolve(authUser); return; }
      setTimeout(checkAuth, 100);
    }
    checkAuth();
    // timeout 15s — dacă nu apare auth, continuă oricum
    setTimeout(function() { resolve(null); }, 15000);
  });
  return _authResolve;
}

async function hashPin(pin) {
  try {
    var enc = new TextEncoder().encode(pin);
    var buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  } catch (e) {
    return pin;
  }
}

function isAdminUid(uid) {
  return firebase.database().ref('admins/' + uid).once('value').then(function(snap) {
    return snap.val() === true;
  }).catch(function() { return false; });
}

function registerAdminUid() {
  if (!authUser) return Promise.resolve();
  return isAdminUid(authUser.uid).then(function(already) {
    if (!already) {
      return firebase.database().ref('admins/' + authUser.uid).set(true);
    }
  }).catch(function() {});
}

function loginWithEmail() {
  var email = document.getElementById('emailInput').value.trim();
  var password = document.getElementById('passwordInput').value.trim();
  if (!email || !password) { showToast('Introdu email și parolă!', true); return; }
  firebase.auth().signInWithEmailAndPassword(email, password).then(function(cred) {
    return isAdminUid(cred.user.uid).then(function(isAdm) {
      if (!isAdm) {
        return registerAdminUid();
      }
    }).then(function() {
      currentUser = { location: '', isAdmin: true };
      doLogin();
    });
  }).catch(function(e) {
    showToast('Eroare autentificare: ' + e.message, true);
  });
}

function toggleEmailLogin() {
  var section = document.getElementById('loginEmailSection');
  var pinNumpad = document.querySelector('.numpad');
  var pinHint = document.querySelector('.pin-hint');
  var toggleBtn = document.querySelector('.btn-email-toggle');
  if (!section || !pinNumpad) return;
  if (section.style.display === 'none' || section.style.display === '') {
    section.style.display = 'block';
    pinNumpad.style.display = 'none';
    if (pinHint) pinHint.style.display = 'none';
    if (toggleBtn) toggleBtn.textContent = '← Autentificare cu PIN';
  } else {
    section.style.display = 'none';
    pinNumpad.style.display = '';
    if (pinHint) pinHint.style.display = '';
    if (toggleBtn) toggleBtn.textContent = 'Autentificare admin cu email';
  }
}



// ── SESSION ──
function saveSession() {
  try {
    localStorage.setItem('sess_user', JSON.stringify(currentUser));
    localStorage.setItem('sess_cart', JSON.stringify(cart));
  } catch (e) {}
}

// ── VISIBILITY CHECK (phone wakeup) ──
function fbReadWithTimeout(path, timeoutMs = 10000) {
  return Promise.race([
    firebase.database().ref(path).once('value'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ]);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && !currentUser.isAdmin) {
    if (firebaseReady) {
      firebase.database().goOnline();
      const sanitizedKey = Sync._sanitizeFirebaseKey(currentUser.location);
      fbReadWithTimeout('grants/' + sanitizedKey, 10000).then(snap => {
        const val = snap.val();
        if (!val || !val.granted) {
          showToast('Accesul tău a fost revocat!', true);
          doLogout(true);
        }
      }).catch(() => {});
    }
  }
});

// ── STORAGE SYNC (cross-tab) ──
window.addEventListener('storage', e => {
  if (e.key === 'promenada_grants') {
    if (currentUser && !currentUser.isAdmin) {
      try {
        const grants = JSON.parse(e.newValue);
        const g = grants[currentUser.location];
        if (!g || !g.granted) {
          showToast('Accesul tău a fost revocat!', true);
          doLogout(true);
        }
      } catch (e) {}
    }
    if (currentUser && currentUser.isAdmin && e.newValue) {
      try {
        const grants = JSON.parse(e.newValue);
        Sync._grants = grants;
        Sync._localGrantsHash = JSON.stringify(grants);
        adminRenderGrants();
      } catch (e) {}
    }
  }
});

// ── EMAIL CONFIRMATION ──
async function handleConfirmation() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('confirm') || params.get('admin_confirm');
  if (!token) return false;
  if (!firebaseReady) return false;
  const isAdminConfirm = !!params.get('admin_confirm');
  const basePath = isAdminConfirm ? 'adminConfirmations' : 'confirmations';
  const paramName = isAdminConfirm ? 'admin_confirm' : 'confirm';
  try {
    const snap = await firebase.database().ref(basePath + '/' + token).once('value');
    const data = snap.val();
    if (!data || (!isAdminConfirm && !data.location)) {
      showToast('Link de confirmare invalid sau expirat!', true);
      return false;
    }
    await firebase.database().ref(basePath + '/' + token).remove();
    const url = new URL(window.location);
    url.searchParams.delete(paramName);
    window.history.replaceState({}, '', url);
    if (isAdminConfirm) {
      currentUser = { location: '', isAdmin: true };
      doLogin();
      showToast('✅ Acces Admin confirmat pe acest dispozitiv!');
    } else {
      currentUser = { location: data.location, isAdmin: false };
      doLogin();
      showToast('✅ Dispozitiv confirmat pentru ' + data.location + '!');
    }
    return true;
  } catch (e) {
    console.warn('handleConfirmation error:', e);
    return false;
  }
}

// ── INIT ──
async function initApp() {
  try {
    await waitForAuth();
    await Sync.init();
  } catch(e) {
    console.warn('initApp error:', e);
  }
  updateFBStatus();

  // Check for email confirmation link FIRST
  if (await handleConfirmation()) { return; }

  // Wait for grants sync from Firebase so login doesn't use stale data
  try { if (Sync.grantsSync) await Promise.race([Sync.grantsSync, new Promise(function(r) { setTimeout(r, 5000); })]); } catch (e) {}

  // Register listeners BEFORE auto-login so revoke detection works everywhere
  Sync.onDBChange((db) => {
    if (currentUser) {
      initDropdowns();
      renderProducts();
      if (currentUser.isAdmin) adminRenderProducts();
      showToast('Produse actualizate de pe alt dispozitiv!');
    }
  });

  // Poll grants from Firebase every 5s (catches cross-device revoke even if on() listener fails)
  setInterval(() => {
    if (!currentUser || !firebaseReady) return;
    if (!currentUser.isAdmin) {
      const sanitizedKey = Sync._sanitizeFirebaseKey(currentUser.location);
      fbReadWithTimeout('grants/' + sanitizedKey, 10000).then(snap => {
        const val = snap.val();
        if (!val || !val.granted) {
          showToast('Accesul tău a fost revocat!', true);
          doLogout(true);
        }
      }).catch(() => {});
    } else {
      fbReadWithTimeout('grants', 10000).then(snap => {
        const val = snap.val();
        if (!val) return;
        const desanitized = {};
        for (const [k, v] of Object.entries(val)) {
          desanitized[Sync._desanitizeFirebaseKey(k)] = v;
        }
        const hash = JSON.stringify(desanitized);
        if (hash !== Sync._localGrantsHash) {
          Sync._grants = desanitized;
          localStorage.setItem('promenada_grants', JSON.stringify(Sync._grants));
          Sync._localGrantsHash = hash;
          adminRenderGrants();
        }
      }).catch(() => {});
    }
  }, 5000);

  // LocalStorage polling for admin (works across tabs even without Firebase or storage event)
  setInterval(() => {
    if (!currentUser || !currentUser.isAdmin) return;
    try {
      var ls = localStorage.getItem('promenada_grants');
      if (!ls) return;
      var localParsed = JSON.parse(ls);
      var localStr = JSON.stringify(localParsed);
      if (localStr !== Sync._localGrantsHash) {
        Sync._grants = localParsed;
        Sync._localGrantsHash = localStr;
        adminRenderGrants();
      }
    } catch (e) {}
  }, 1500);

  Sync.onGrantsChange((grants) => {
    if (!currentUser) return;
    if (currentUser.isAdmin) {
      adminRenderGrants();
    } else {
      const g = grants[currentUser.location];
      if (!g || !g.granted) {
        showToast('Accesul tău a fost revocat!', true);
        doLogout(true);
      }
    }
  });

  Sync.onOrdersChange(() => {
    if (currentUser && currentUser.isAdmin) {
      const view = document.getElementById('view-centralizator');
      if (view.classList.contains('active')) renderCentralizator();
    }
  });

  Sync.onHistoryChange(() => {
    if (currentUser) {
      const view = document.getElementById('view-history');
      if (view.classList.contains('active')) renderHistory();
    }
  });
  const savedUser = localStorage.getItem('sess_user');
  if (savedUser && savedUser !== 'null') {
    try {
      currentUser = JSON.parse(savedUser);
      cart = JSON.parse(localStorage.getItem('sess_cart') || '{}');
      doLogin();
      updateBadge();
      return;
    } catch (e) { currentUser = null; cart = {}; }
  }
  localStorage.removeItem('sess_user');
  localStorage.removeItem('sess_cart');

  if (Sync.initialized) {
    if (!document.getElementById('app').style.display || document.getElementById('app').style.display === 'none') {
      if (document.getElementById('loginScreen')) {
        document.getElementById('loginScreen').style.display = 'flex';
      }
    }
  }
}

function updateFBStatus() {
  const el = document.getElementById('fbStatus');
  if (!el) return;
  if (Sync.connected) {
    el.textContent = '●';
    el.style.color = '#2dd4bf';
    el.title = 'Firebase conectat';
  } else {
    el.textContent = '✕';
    el.style.color = '#e94560';
    el.title = 'Firebase neconectat';
  }
}

// ── LOGIN ──
function pinPress(d) {
  if (currentPin.length >= 6) return;
  currentPin += d;
  updatePinDisplay();
  if (currentPin.length === 6) setTimeout(pinOk, 150);
}

function pinDel() {
  currentPin = currentPin.slice(0, -1);
  updatePinDisplay();
}

function updatePinDisplay() {
  const el = document.getElementById('pinDisplay');
  el.classList.remove('error', 'filled');
  const dots = currentPin ? '●'.repeat(currentPin.length) + '·'.repeat(6 - currentPin.length) : '';
  el.value = dots;
  if (currentPin.length === 6) el.classList.add('filled');
}

async function pinOk() {
  if (!currentPin) return;
  const pins = Sync.getPins();
  const grants = Sync.getGrants();
  const entered = currentPin;
  currentPin = '';
  updatePinDisplay();

  var enteredHash = await hashPin(entered);
  var needsUpgrade = false;

  // Admin login - check hash first, then plaintext (backward compat)
  if (pins && pins.ADMIN) {
    if (enteredHash === pins.ADMIN || entered === pins.ADMIN) {
      if (entered === pins.ADMIN && enteredHash !== pins.ADMIN) {
        pins.ADMIN = enteredHash;
        needsUpgrade = true;
      }
      currentUser = { location: '', isAdmin: true };
      waitForAuth().then(function() { registerAdminUid(); });
      doLogin();
      if (needsUpgrade) try { await Sync.savePins(pins); } catch (e) {}
      return;
    }
  }

  // Helper to attempt login for a location
  async function tryLogin(loc) {
    const g = grants[loc];
    if (g && g.granted) {
      currentUser = { location: loc, isAdmin: false };
      doLogin();
      return true;
    }
    if (g && g.code === entered) {
      g.granted = true;
      g.code = null;
      try { await Sync.saveGrants(grants); } catch (e) {}
      currentUser = { location: loc, isAdmin: false };
      doLogin();
      return true;
    }
    return false;
  }

  // Check PIN in pins first - match by hash or plaintext
  var match = null;
  if (pins) {
    for (var loc in pins) {
      if (loc === 'ADMIN') continue;
      var stored = pins[loc];
      if (stored === enteredHash || stored === entered) {
        match = loc;
        if (stored === entered && stored !== enteredHash) {
          pins[loc] = enteredHash;
          needsUpgrade = true;
        }
        break;
      }
    }
  }
  if (match) {
    if (tryLogin(match)) {
      if (needsUpgrade) try { await Sync.savePins(pins); } catch (e) {}
      return;
    }
  }

  // Fallback: search for matching code in grants
  if (grants) {
    for (const [loc, g] of Object.entries(grants)) {
      if (g && g.code === entered && tryLogin(loc)) return;
    }
  }

  const el = document.getElementById('pinDisplay');
  el.classList.add('error');
  el.value = '✕✕✕✕';
  setTimeout(() => { el.classList.remove('error'); updatePinDisplay(); }, 800);
}

function showAdminPinModal() {
  document.getElementById('adminPinModal').style.display = 'flex';
  const inp = document.getElementById('adminPinEntry');
  inp.value = '';
  setTimeout(function() { inp.focus(); }, 100);
}

function hideAdminPinModal() {
  document.getElementById('adminPinModal').style.display = 'none';
}

async function submitAdminEmail() {
  const inp = document.getElementById('adminPinEntry');
  const email = inp.value.trim();
  if (!email || !email.includes('@')) { showToast('Introdu un email valid!', true); return; }
  if (!firebaseReady) { showToast('Firebase neconectat!', true); return; }
  const token = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
  const loc = currentUser ? currentUser.location : 'unknown';
  try {
    await firebase.database().ref('adminConfirmations/' + token).set({ email, location: loc, createdAt: Date.now() });
    const link = 'https://comenzi-corina-caffe.web.app/?admin_confirm=' + token;
    hideAdminPinModal();
    // Copy link to clipboard and show toast
    try { await navigator.clipboard.writeText(link); showToast('Link copiat! Verifică emailul pentru confirmare.'); } catch (e) {}
    // Also open mailto
    const subject = encodeURIComponent('Confirmare acces Admin');
    const body = encodeURIComponent('Accesează acest link pentru a confirma accesul Admin:\n\n' + link);
    window.open('mailto:' + email + '?subject=' + subject + '&body=' + body, '_blank');
    showToast('✉️ Email deschis. Confirmă linkul pentru acces Admin.', false, 6000);
  } catch (e) {
    showToast('Eroare: ' + e.message, true);
  }
}

document.addEventListener('keydown', e => {
  if (document.getElementById('loginScreen').style.display === 'none') return;
  var emailSection = document.getElementById('loginEmailSection');
  if (emailSection && emailSection.style.display !== 'none') return;
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); pinPress(e.key); return; }
  if (e.key === 'Backspace') { e.preventDefault(); pinDel(); return; }
  if (e.key === 'Enter') { e.preventDefault(); pinOk(); return; }
}, true);

document.getElementById('pinDisplay').addEventListener('input', function() {
  if (!/\d/.test(this.value)) return;
  const digits = this.value.replace(/\D/g, '').slice(0, 6);
  if (digits !== currentPin) {
    currentPin = digits;
    updatePinDisplay();
  }
  if (currentPin.length === 6) setTimeout(pinOk, 150);
});

document.getElementById('adminPinEntry').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); submitAdminEmail(); }
});

function doLogin() {
  document.getElementById('loginScreen').style.display = 'none';
  const app = document.getElementById('app');
  app.style.display = 'flex';
  app.style.flexDirection = 'column';
  app.style.flex = '1';

  document.getElementById('headerLoc').textContent = currentUser.isAdmin ? 'Admin' : currentUser.location;

  const keyBtn = document.getElementById('adminKeyBtn');
  if (keyBtn) keyBtn.style.display = currentUser.isAdmin ? 'none' : 'inline-flex';
  const logoutBtn = document.getElementById('headerLogoutBtn');
  if (logoutBtn) logoutBtn.style.display = currentUser.isAdmin ? 'inline-flex' : 'none';

  if (currentUser.isAdmin) {
    document.getElementById('adminTab').style.display = '';
    document.getElementById('centralizatorTab').style.display = '';
    document.getElementById('adminLocRow').classList.add('visible');
  }

  initDropdowns();
  renderProducts();
  if (currentUser.isAdmin) { adminRenderGrants(); adminRenderProducts(); adminRenderLocations(); adminPopulateLocDropdown(); }
  saveSession();
}

async function doLogout(force) {
  if (!force && !confirm('Deconectare?')) return;
  if (!force && currentUser && currentUser.location) {
    const grants = Sync.getGrants();
    delete grants[currentUser.location];
    try { await Sync.saveGrants(grants); } catch (e) {}
    // force re-read from local storage to ensure in-memory state is clean
    try {
      const saved = localStorage.getItem('promenada_grants');
      Sync._grants = saved ? JSON.parse(saved) : {};
      Sync._localGrantsHash = JSON.stringify(Sync._grants);
    } catch (e) {}
  }
  currentUser = null;
  cart = {};
  lastResults = [];
  localStorage.removeItem('sess_user');
  localStorage.removeItem('sess_cart');
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('adminTab').style.display = 'none';
  document.getElementById('centralizatorTab').style.display = 'none';
  document.getElementById('adminLocRow').classList.remove('visible');
  const keyBtn = document.getElementById('adminKeyBtn');
  if (keyBtn) keyBtn.style.display = 'none';
  const headerLogoutBtn = document.getElementById('headerLogoutBtn');
  if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
  switchTab('order');
  updateBadge();
}

// ── DROPDOWNS ──
function initDropdowns() {
  const DB = Sync.getDB();
  const suppliers = Object.keys(DB);
  const supplierSel = document.getElementById('supplierSelect');
  supplierSel.innerHTML = '<option value="">— Toți furnizorii —</option>';
  suppliers.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    supplierSel.appendChild(o);
  });

  if (currentUser.isAdmin) {
    const locSet = new Set();
    suppliers.forEach(s => DB[s].locations.forEach(l => locSet.add(l.name)));
    const locationSel = document.getElementById('locationSelect');
    locationSel.innerHTML = '<option value="">— Toate locațiile —</option>';
    [...locSet].sort().forEach(l => {
      const o = document.createElement('option');
      o.value = l; o.textContent = l;
      locationSel.appendChild(o);
    });

    const adminProdSel = document.getElementById('adminProdSupplier');
    adminProdSel.innerHTML = '<option value="">— Selectează furnizor —</option>';
    suppliers.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      adminProdSel.appendChild(o);
    });

    const adminLocSel = document.getElementById('adminLocSupplier');
    adminLocSel.innerHTML = '<option value="">— Selectează furnizor —</option>';
    suppliers.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      adminLocSel.appendChild(o);
    });

    const adminPhoneSel = document.getElementById('adminPhoneSupplier');
    adminPhoneSel.innerHTML = '<option value="">— Selectează furnizor —</option>';
    suppliers.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      adminPhoneSel.appendChild(o);
    });
  }
}

// ── PRODUCTS ──
function getActiveLocation() {
  if (currentUser.isAdmin) return document.getElementById('locationSelect').value;
  return currentUser.location;
}

const _expandedSuppliers = new Set();

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').style.display = 'none';
  renderProducts();
  document.getElementById('searchInput').focus();
}

function renderProducts() {
  const searchInput = document.getElementById('searchInput');
  const search = searchInput.value.toLowerCase().trim();
  document.getElementById('searchClear').style.display = search ? 'block' : 'none';
  const DB = Sync.getDB();
  const supplierF = document.getElementById('supplierSelect').value;
  const activeLoc = getActiveLocation();
  const showAll = document.getElementById('showAllToggle').checked;
  const list = document.getElementById('productList');
  list.innerHTML = '';
  let total = 0;

  const suppliers = supplierF ? [supplierF] : Object.keys(DB);
  suppliers.forEach(supplier => {
    const data = DB[supplier];
    if (!currentUser.isAdmin && !data.locations.find(l => l.name === currentUser.location)) return;
    if (currentUser.isAdmin && activeLoc && !data.locations.find(l => l.name === activeLoc)) return;

    let prods = [...data.products].sort((a, b) => a.produs.localeCompare(b.produs, 'ro'));
    if (!showAll) prods = prods.filter(p => p.afiseaza === 'da');
    if (search) prods = prods.filter(p => p.produs.toLowerCase().includes(search));
    if (!prods.length) return;
    total += prods.length;

    const group = document.createElement('div');
    group.className = 'supplier-group';

    const isExpanded = _expandedSuppliers.has(supplier) || !!search;
    const header = document.createElement('div');
    header.className = 'supplier-header';
    header.innerHTML = `<span class="supplier-arrow">${isExpanded ? '▼' : '▶'}</span><span>${supplier}</span><span class="supplier-count">${prods.length}</span>`;
    header.onclick = () => {
      if (_expandedSuppliers.has(supplier)) _expandedSuppliers.delete(supplier);
      else _expandedSuppliers.add(supplier);
      renderProducts();
    };
    group.appendChild(header);

    const body = document.createElement('div');
    body.className = 'supplier-body';
    if (isExpanded) {
      body.style.display = '';
      prods.forEach(prod => {
        const key = supplier + '::' + prod.produs;
        const qty = cart[key] ? cart[key].qty : 0;
        const card = document.createElement('div');
        card.className = 'product-card' + (qty > 0 ? ' in-cart' : '');

        const info = document.createElement('div');
        info.className = 'product-info';
        info.innerHTML = `<div class="product-name">${prod.produs}</div>${prod.tip_ambalaj ? `<div class="product-meta">${prod.tip_ambalaj}</div>` : ''}`;

        const qc = document.createElement('div');
        qc.className = 'qty-control';
        const minus = document.createElement('button');
        minus.className = 'qty-btn minus'; minus.textContent = '−';
        minus.onclick = () => changeQty(supplier, prod, -1);
        const inp = document.createElement('input');
        inp.className = 'qty-input'; inp.type = 'number'; inp.min = '0'; inp.value = qty;
        inp.onchange = e => setQty(supplier, prod, parseInt(e.target.value)||0);
        inp.onclick = e => e.target.select();
        const plus = document.createElement('button');
        plus.className = 'qty-btn'; plus.textContent = '+';
        plus.onclick = () => changeQty(supplier, prod, 1);
        qc.appendChild(minus); qc.appendChild(inp); qc.appendChild(plus);

        card.appendChild(info); card.appendChild(qc);
        body.appendChild(card);
      });
    }
    group.appendChild(body);
    list.appendChild(group);
  });

  if (!total) list.innerHTML = '<div class="empty"><div class="empty-icon">&#128269;</div><div>Niciun produs găsit</div></div>';
}

function changeQty(supplier, prod, delta) {
  const key = supplier + '::' + prod.produs;
  setQty(supplier, prod, (cart[key] ? cart[key].qty : 0) + delta);
}

function setQty(supplier, prod, qty) {
  const DB = Sync.getDB();
  const loc = getActiveLocation();
  if (!loc) { showToast('Selectează locația mai întâi!', true); return; }
  const key = supplier + '::' + prod.produs;
  qty = Math.max(0, qty);
  if (qty === 0) { delete cart[key]; }
  else {
    const locEntry = DB[supplier].locations.find(l => l.name === loc);
    cart[key] = { qty, supplier, produs: prod.produs, tip_ambalaj: prod.tip_ambalaj, location: loc, col: locEntry ? locEntry.col : null, rowIndex: DB[supplier].products.findIndex(p => p.produs === prod.produs) };
  }
  updateBadge();
  renderProducts();
  saveSession();
}

function updateBadge() {
  const n = Object.keys(cart).length;
  document.getElementById('cartBadge').textContent = n;
  document.getElementById('cartCount').textContent = n;
  document.getElementById('trimiteBtn').disabled = n === 0;
}

// ── CART ──
function renderCart() {
  const el = document.getElementById('cartList');
  const items = Object.values(cart);
  if (!items.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">&#128722;</div><div>Coșul este gol</div></div>'; return; }
  const byS = {};
  items.forEach(i => { if (!byS[i.supplier]) byS[i.supplier] = []; byS[i.supplier].push(i); });
  el.innerHTML = '';
  Object.entries(byS).forEach(([sup, prods]) => {
    const g = document.createElement('div'); g.className = 'cart-supplier';
    g.innerHTML = `<div class="cart-supplier-header"><span>${sup}</span><span style="font-size:0.75rem;opacity:0.8">${prods.length} produse</span></div>`;
    prods.forEach(item => {
      const row = document.createElement('div'); row.className = 'cart-item';
      const key = item.supplier + '::' + item.produs;
      row.innerHTML = `<div style="flex:1"><div class="cart-item-name">${item.produs}</div><div class="cart-item-detail">${item.tip_ambalaj} · ${item.location}</div></div><div class="cart-item-qty">× ${item.qty}</div><button class="cart-remove" onclick="removeItem('${key.replace(/'/g,"\\'")}')">✕</button>`;
      g.appendChild(row);
    });
    el.appendChild(g);
  });
}

function removeItem(key) { delete cart[key]; updateBadge(); renderCart(); saveSession(); }
function resetCart() { if (!Object.keys(cart).length) return; if (confirm('Golești coșul?')) { cart = {}; updateBadge(); renderProducts(); saveSession(); } }

// ── TRIMITERE ──
function generateMessages(items) {
  const loc = currentUser.location;
  const bySupplier = {};
  items.forEach(item => {
    if (!bySupplier[item.supplier]) bySupplier[item.supplier] = [];
    bySupplier[item.supplier].push(item);
  });
  return Object.entries(bySupplier).map(([supplier, prods]) => {
    const lines = prods.map(p => `✅ *${p.produs}* -> ${p.qty} ${p.tip_ambalaj}`);
    const mesaj = `Bună ziua! Aș dori să comand următoarele produse:\n\n📍 *PENTRU ${loc.toUpperCase()}:*\n${lines.join('\n')}\n\nMulțumesc!`;
    return { furnizor: supplier, mesaj };
  });
}

function filterResultsByLocation(results) {
  const loc = currentUser.location;
  if (!loc) return results;
  return results.filter(r => {
    if (!r.mesaj) return false;
    return r.mesaj.includes(`📍 *PENTRU ${loc.toUpperCase()}:`);
  }).map(r => {
    const lines = r.mesaj.split('\n');
    const header = lines.find(l => l.startsWith('📍'));
    const filtered = header
      ? [lines[0], lines[1], '', header, ...lines.filter(l => l.startsWith('✅')), '', lines[lines.length - 1]]
      : lines;
    return { ...r, mesaj: filtered.join('\n') };
  });
}

async function trimiteComanda() {
  const items = Object.values(cart);
  if (!items.length) return;
  lastResults = generateMessages(items);

  // save order to centralizator (one entry per location + supplier)
  const orders = Sync.getOrders() || {};
  // group cart items by supplier
  const bySupplier = {};
  items.forEach(item => {
    if (!bySupplier[item.supplier]) bySupplier[item.supplier] = [];
    bySupplier[item.supplier].push(item);
  });

  // migrate old-format entry (key = location name) to per-supplier entries
  const oldKey = currentUser.location;
  const oldEntry = orders[oldKey];
  if (oldEntry && oldEntry.items) {
    // keep items from old entry for suppliers NOT in current order
    oldEntry.items.forEach(item => {
      if (!bySupplier[item.supplier]) {
        if (!bySupplier[item.supplier]) bySupplier[item.supplier] = [];
        bySupplier[item.supplier].push(item);
      }
    });
    try { await Sync.removeOrderEntry(oldKey); } catch (e) {}
  }

  // save one entry per supplier (replaces previous entry for same location+supplier)
  const entries = Object.entries(bySupplier);
  for (let idx = 0; idx < entries.length; idx++) {
    const [supplier, supItems] = entries[idx];
    const key = currentUser.location + '::' + supplier;
    // clean up entries with same location+supplier but different key format
    Object.keys(Sync.getOrders()).forEach(k => {
      if (k !== key && Sync.getOrders()[k] && Sync.getOrders()[k].location === currentUser.location && Sync.getOrders()[k].supplier === supplier) {
        Sync.removeOrderEntry(k);
      }
    });
    const orderData = {
      location: currentUser.location,
      supplier: supplier,
      timestamp: Date.now(),
      items: supItems.map(item => ({
        supplier: item.supplier,
        produs: item.produs,
        qty: item.qty,
        tip_ambalaj: item.tip_ambalaj
      }))
    };
    try { await Sync.saveOrderForLocation(key, orderData); } catch (e) {}
  }

  // save to history (per location, FIFO max 10)
  const history = Sync.getHistory() || {};
  const locKey = currentUser.location;
  if (!history[locKey]) history[locKey] = {};
  const ts = Date.now().toString();
  history[locKey][ts] = {
    timestamp: Date.now(),
    items: items.map(item => ({
      supplier: item.supplier,
      produs: item.produs,
      qty: item.qty,
      tip_ambalaj: item.tip_ambalaj
    }))
  };
  // FIFO: keep max 10 entries per location
  const keys = Object.keys(history[locKey]).sort();
  while (keys.length > 10) {
    const oldest = keys.shift();
    delete history[locKey][oldest];
  }
  try { await Sync.saveHistory(history); } catch (e) {}
  cart = {}; updateBadge(); renderProducts();
  renderResults(lastResults);
  switchTab('results');
  saveSession();
  showToast('Comanda a fost trimisă! ✓');
}

// ── RESULTS ──
function renderResults(results) {
  const el = document.getElementById('resultsList');
  const valid = (results || []).filter(r => r.mesaj && r.mesaj.trim());
  if (!valid.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">&#9989;</div><div>Nu sunt comenzi de trimis</div></div>'; return; }
  el.innerHTML = '';
  valid.forEach((r, i) => {
    const wa = encodeURIComponent(r.mesaj);
    const card = document.createElement('div'); card.className = 'result-card';
    card.innerHTML = `<div class="result-header"><span class="result-supplier">📦 ${r.furnizor}</span></div><div class="result-msg">${escHtml(r.mesaj)}</div>`;
    el.appendChild(card);
  });
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function copyMsg(i) { navigator.clipboard.writeText(lastResults[i].mesaj).then(() => showToast('Copiat!')); }
function copyAllMessages() {
  if (!lastResults.length) return;
  const all = lastResults.filter(r=>r.mesaj).map(r=>`=== ${r.furnizor} ===\n${r.mesaj}`).join('\n\n');
  navigator.clipboard.writeText(all).then(() => showToast('Toate copiate!'));
}

// ── ADMIN PINS ──
// ── ADMIN GRANTS ──
function adminRenderGrants() {
  const grants = Sync.getGrants();
  const pins = Sync.getPins();
  const DB = Sync.getDB();
  const el = document.getElementById('adminGrantList');
  const allLocs = new Set();
  Object.values(DB).forEach(d => d.locations.forEach(l => allLocs.add(l.name)));
  el.innerHTML = '';
  if (!allLocs.size) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;padding:8px 0">Nu există locații în DB.</div>';
    return;
  }
  allLocs.forEach(loc => {
    const g = grants[loc];
    const granted = g && g.granted;
    const hasCode = g && g.code;
    const currentPin = pins[loc] || '';
    const row = document.createElement('div'); row.className = 'grant-row';
    const status = granted ? '<span class="grant-status on" title="Acces activ">✓</span>' : '<span class="grant-status off" title="Fără acces">✕</span>';
    let codeDisplay = '';
    if (hasCode) codeDisplay = `<span class="grant-code">Cod: <strong>${g.code}</strong></span>`;
    const loggedOutStr = g && g.loggedOutAt ? '<span class="grant-logged-out">(s-a delogat)</span>' : '';
    row.innerHTML = `${status}<span class="grant-loc">${escHtml(loc)}</span>${loggedOutStr}
      <input class="grant-pin" type="text" maxlength="6" inputmode="numeric" value="${currentPin}" data-loc="${loc}" onchange="adminSetPin(this)" placeholder="PIN">
      ${codeDisplay}<span style="flex:1"></span>`;
    if (granted) {
      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'btn-grant-revoke';
      revokeBtn.textContent = 'Revocă';
      revokeBtn.onclick = () => adminRevokeAccess(loc);
      row.appendChild(revokeBtn);
    } else if (hasCode) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-grant-cancel';
      cancelBtn.textContent = 'Anulează cod';
      cancelBtn.onclick = () => adminCancelCode(loc);
      row.appendChild(cancelBtn);
    } else {
      const grantBtn = document.createElement('button');
      grantBtn.className = 'btn-grant-add';
      grantBtn.textContent = 'Acordă acces';
      grantBtn.onclick = () => adminGrantAccess(loc);
      row.appendChild(grantBtn);
    }
    el.appendChild(row);
  });
}

async function adminGrantAccess(loc) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const grants = Sync.getGrants();
  grants[loc] = { granted: false, code };
  try {
    const ok = await Sync.saveGrants(grants);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderGrants();
    showToast(`Cod unic pentru ${loc}: ${code}`, false, 6000);
  } catch (e) {
    showToast('Eroare: ' + e.message, true);
  }
}

async function adminRevokeAccess(loc) {
  if (!confirm(`Revoci accesul pentru „${loc}”?`)) return;
  const grants = Sync.getGrants();
  delete grants[loc];
  try {
    const ok = await Sync.saveGrants(grants);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderGrants();
    showToast(`Acces revocat pentru ${loc}!`);
  } catch (e) {
    showToast('Eroare: ' + e.message, true);
  }
}

async function adminCancelCode(loc) {
  const grants = Sync.getGrants();
  delete grants[loc];
  try {
    const ok = await Sync.saveGrants(grants);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderGrants();
    showToast(`Cod anulat pentru ${loc}!`);
  } catch (e) {
    showToast('Eroare: ' + e.message, true);
  }
}

async function adminSetPin(inp) {
  const loc = inp.dataset.loc;
  let val = inp.value.replace(/\D/g, '').slice(0, 6);
  inp.value = val;
  if (val.length !== 6) return;
  const pins = Sync.getPins();
  pins[loc] = await hashPin(val);
  try {
    await Sync.savePins(pins);
    showToast(`PIN setat pentru ${loc}!`);
  } catch (e) {
    showToast('Eroare: ' + e.message, true);
  }
}

async function adminChangePin() {
  const inp = document.getElementById('adminPinInput');
  let val = inp.value.replace(/\D/g, '').slice(0, 6);
  inp.value = val;
  if (val.length !== 6) { showToast('PIN-ul trebuie să aibă 6 cifre!', true); return; }
  const pins = Sync.getPins();
  pins.ADMIN = await hashPin(val);
  try {
    await Sync.savePins(pins);
    showToast(`PIN Admin schimbat!`);
  } catch (e) {
    showToast('Eroare: ' + e.message, true);
  }
}

function adminUpdateEmailDisplay() {
  var el = document.getElementById('adminEmailDisplay');
  if (!el) return;
  var user = firebase.auth().currentUser;
  if (user && user.email) {
    el.textContent = 'Conectat ca: ' + user.email;
  } else {
    el.textContent = 'Conectat (email nesetat)';
  }
}

function adminChangeEmail() {
  var user = firebase.auth().currentUser;
  if (!user) { showToast('Nu ești autentificat!', true); return; }
  var newEmail = document.getElementById('changeEmailInput').value.trim();
  if (!newEmail) { showToast('Introdu un email!', true); return; }
  if (newEmail === user.email) { showToast('Emailul este același!', true); return; }
  user.verifyBeforeUpdateEmail(newEmail).then(function() {
    showToast('Email de verificare trimis la ' + newEmail + '. Confirmă linkul din email pentru a finaliza schimbarea.');
    document.getElementById('changeEmailInput').value = '';
  }).catch(function(e) {
    if (e.code === 'auth/requires-recent-login') {
      showToast('Te rugăm să te reconectezi și să încerci din nou.', true);
    } else {
      showToast('Eroare: ' + e.message, true);
    }
  });
}

function adminChangePassword() {
  var user = firebase.auth().currentUser;
  if (!user) { showToast('Nu ești autentificat!', true); return; }
  var newPass = document.getElementById('changePassInput').value.trim();
  if (!newPass || newPass.length < 6) { showToast('Parola trebuie să aibă cel puțin 6 caractere!', true); return; }
  user.updatePassword(newPass).then(function() {
    showToast('Parola a fost schimbată!');
    document.getElementById('changePassInput').value = '';
  }).catch(function(e) {
    if (e.code === 'auth/requires-recent-login') {
      showToast('Te rugăm să te reconectezi și să încerci din nou.', true);
    } else {
      showToast('Eroare: ' + e.message, true);
    }
  });
}

// ── ADMIN PRODUCTS ──
function adminRenderProducts() {
  const DB = Sync.getDB();
  const sel = document.getElementById('adminProdSupplier');
  const supplier = sel.value;
  const list = document.getElementById('adminProductList');
  if (!supplier || !DB[supplier]) { list.innerHTML = '<div style="color:var(--text-muted);padding:12px;font-size:0.82rem">Selectează un furnizor</div>'; return; }
  const prods = DB[supplier].products;
  list.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'admin-supplier-header';
  header.textContent = supplier;
  list.appendChild(header);
  prods.forEach(p => {
    const div = document.createElement('div'); div.className = 'admin-prod-item';
    const tag = p.afiseaza === 'da' ? '<span class="prod-tag">Activ</span>' : '<span class="prod-tag inactive">Ascuns</span>';
    div.innerHTML = `<div style="flex:1"><div class="prod-name">${escHtml(p.produs)}</div><div class="prod-meta">${p.tip_ambalaj} × ${p.ambalaj}</div></div>${tag}<button class="btn-edit-prod" onclick="adminEditProduct('${supplier.replace(/'/g,"\\'")}','${p.produs.replace(/'/g,"\\'")}')" title="Editează">✎</button><button class="btn-del-prod" onclick="adminDeleteProduct('${supplier.replace(/'/g,"\\'")}','${p.produs.replace(/'/g,"\\'")}')" title="Șterge">✕</button>`;
    list.appendChild(div);
  });
}

async function adminAddProduct() {
  const DB = Sync.getDB();
  const sel = document.getElementById('adminProdSupplier');
  const supplier = sel.value;
  if (!supplier) { showToast('Selectează un furnizor!', true); return; }
  const name = document.getElementById('newProdName').value.trim();
  if (!name) { showToast('Introdu numele produsului!', true); return; }
  if (DB[supplier].products.some(p => p.produs.toLowerCase() === name.toLowerCase())) { showToast('Produsul există deja!', true); return; }
  const tip = document.getElementById('newProdTip').value;
  const ambalaj = parseInt(document.getElementById('newProdAmbalaj').value) || 1;
  const afiseaza = document.getElementById('newProdAfiseaza').checked ? 'da' : 'nu';
  DB[supplier].products.push({ produs: name, afiseaza, ambalaj, tip_ambalaj: tip });
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    document.getElementById('newProdName').value = '';
    adminRenderProducts();
    renderProducts();
    showToast('Produs adăugat! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

async function adminDeleteProduct(supplier, produs) {
  const DB = Sync.getDB();
  if (!confirm(`Ștergi „${produs}” de la ${supplier}?`)) return;
  DB[supplier].products = DB[supplier].products.filter(p => p.produs !== produs);
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderProducts();
    renderProducts();
    showToast('Produs șters! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

let _editSupplier = '';
let _editOldName = '';

function adminEditProduct(supplier, produs) {
  const DB = Sync.getDB();
  const p = DB[supplier]?.products?.find(x => x.produs === produs);
  if (!p) return;
  _editSupplier = supplier;
  _editOldName = produs;
  document.getElementById('editProdName').value = p.produs;
  document.getElementById('editProdTip').value = p.tip_ambalaj;
  document.getElementById('editProdAmbalaj').value = p.ambalaj;
  document.getElementById('editProdAfiseaza').checked = p.afiseaza === 'da';
  document.getElementById('editProdModal').style.display = 'flex';
}

async function adminSaveEditProduct() {
  const DB = Sync.getDB();
  const supplier = _editSupplier;
  const oldName = _editOldName;
  const name = document.getElementById('editProdName').value.trim();
  if (!name) { showToast('Introdu numele produsului!', true); return; }
  const tip = document.getElementById('editProdTip').value;
  const ambalaj = parseInt(document.getElementById('editProdAmbalaj').value) || 1;
  const afiseaza = document.getElementById('editProdAfiseaza').checked ? 'da' : 'nu';
  const prods = DB[supplier].products;
  const idx = prods.findIndex(p => p.produs === oldName);
  if (idx === -1) return;
  const dup = prods.findIndex(p => p.produs.toLowerCase() === name.toLowerCase() && p.produs !== oldName);
  if (dup !== -1) { showToast('Produsul există deja!', true); return; }
  prods[idx] = { produs: name, afiseaza, ambalaj, tip_ambalaj: tip };
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    closeEditModal();
    adminRenderProducts();
    renderProducts();
    showToast('Produs salvat! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

function closeEditModal(e) {
  if (e && e.target !== document.getElementById('editProdModal')) return;
  document.getElementById('editProdModal').style.display = 'none';
}

// ── ADMIN LOCATIONS ──
async function adminDeleteGlobalLoc(name, count) {
  if (!confirm(`Ștergi „${name}” din toți cei ${count} furnizori?`)) return;
  const DB = Sync.getDB();
  Object.keys(DB).forEach(supplier => {
    DB[supplier].locations = DB[supplier].locations.filter(l => l.name !== name);
  });
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderLocations();
    adminPopulateLocDropdown();
    initDropdowns();
    renderProducts();
    showToast('Gestiune ștearsă din toți furnizorii! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}


function adminRenderLocations() {
  const DB = Sync.getDB();
  const sel = document.getElementById('adminLocSupplier');
  const supplier = sel.value;
  const list = document.getElementById('adminLocationList');
  if (!supplier || !DB[supplier]) { list.innerHTML = '<div style="color:var(--text-muted);padding:12px;font-size:0.82rem">Selectează un furnizor</div>'; return; }
  const locs = DB[supplier].locations;
  list.innerHTML = '';
  locs.forEach((loc, i) => {
    const row = document.createElement('div'); row.className = 'pin-row';
    const count = Object.values(DB).filter(d => d.locations.some(l => l.name === loc.name)).length;
    row.innerHTML = `<div class="pin-loc">${escHtml(loc.name)}</div>
      ${count > 1 ? `<span style="font-size:0.65rem;color:var(--text-muted);cursor:pointer;padding:0 6px" onclick="adminDeleteGlobalLoc('${loc.name.replace(/'/g,"\\'")}',${count})" title="Șterge din toți furnizorii">🌐</span>` : ''}
      <button class="btn-del-prod" onclick="adminDeleteLocation('${supplier.replace(/'/g,"\\'")}','${loc.name.replace(/'/g,"\\'")}')" title="Șterge" style="background:none;border:none;color:#e94560;font-size:1.2rem;cursor:pointer;padding:4px 10px">✕</button>`;
    list.appendChild(row);
  });
}

function adminPopulateLocDropdown() {
  const DB = Sync.getDB();
  const sel = document.getElementById('addLocSelect');
  const cur = sel.value;
  const names = new Set();
  Object.values(DB).forEach(d => d.locations.forEach(l => names.add(l.name)));
  sel.innerHTML = '<option value="">— Selectează gestiune —</option>';
  [...names].sort((a, b) => a.localeCompare(b, 'ro')).forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    sel.appendChild(o);
  });
  if (cur && names.has(cur)) sel.value = cur;
}

async function adminAddLocationSelected() {
  const selSup = document.getElementById('adminLocSupplier');
  const supplier = selSup.value;
  if (!supplier) { showToast('Selectează un furnizor!', true); return; }
  const selLoc = document.getElementById('addLocSelect');
  const name = selLoc.value;
  if (!name) { showToast('Selectează o gestiune!', true); return; }
  const DB = Sync.getDB();
  if (DB[supplier].locations.some(l => l.name.toLowerCase() === name.toLowerCase())) { showToast('Gestiunea există deja la acest furnizor!', true); return; }
  const maxCol = DB[supplier].locations.reduce((m, l) => Math.max(m, l.col || 0), 0);
  DB[supplier].locations.push({ name, col: maxCol + 1 });
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    selLoc.value = '';
    adminRenderLocations();
    initDropdowns();
    renderProducts();
    showToast('Gestiune adăugată! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

async function adminAddLocation() {
  const DB = Sync.getDB();
  const sel = document.getElementById('adminLocSupplier');
  const supplier = sel.value;
  if (!supplier) { showToast('Selectează un furnizor!', true); return; }
  const name = document.getElementById('newLocName').value.trim();
  if (!name) { showToast('Introdu numele locației!', true); return; }
  if (DB[supplier].locations.some(l => l.name.toLowerCase() === name.toLowerCase())) { showToast('Locația există deja!', true); return; }
  const maxCol = DB[supplier].locations.reduce((m, l) => Math.max(m, l.col || 0), 0);
  DB[supplier].locations.push({ name, col: maxCol + 1 });
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    document.getElementById('newLocName').value = '';
    adminRenderLocations();
    initDropdowns();
    renderProducts();
    showToast('Locație adăugată! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

async function adminDeleteLocation(supplier, name) {
  const DB = Sync.getDB();
  if (!confirm(`Ștergi locația „${name}” de la ${supplier}?`)) return;
  DB[supplier].locations = DB[supplier].locations.filter(l => l.name !== name);
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderLocations();
    initDropdowns();
    renderProducts();
    showToast('Locație ștearsă! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

// ── ADMIN SUPPLIER CONTACT ──
function adminRenderSupplierContact() {
  const DB = Sync.getDB();
  const sel = document.getElementById('adminPhoneSupplier');
  const supplier = sel.value;
  const el = document.getElementById('adminPhoneList');
  if (!supplier || !DB[supplier]) { el.innerHTML = '<div style="color:var(--text-muted);padding:12px;font-size:0.82rem">Selectează un furnizor</div>'; return; }
  const phone = DB[supplier].phone || '';
  const site = DB[supplier].site || '';
  const linkHtml = site ? `<a href="${site}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;color:var(--accent);font-size:0.82rem">🔗 Deschide site</a>` : '';
  el.innerHTML = `<div class="pin-row"><input class="search-input" id="adminPhoneInput" value="${phone}" placeholder="ex: 40712345678" style="flex:1"></div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px">Nr. telefon cu codul țării, fără + sau spații (ex: 407XXXXXXXX)</div>
<div class="pin-row" style="margin-top:10px"><input class="search-input" id="adminSiteInput" value="${site}" placeholder="https://exemplu.ro" style="flex:1"></div>${linkHtml}`;
}

async function adminSaveSupplierContact() {
  const DB = Sync.getDB();
  const sel = document.getElementById('adminPhoneSupplier');
  const supplier = sel.value;
  if (!supplier) { showToast('Selectează un furnizor!', true); return; }
  const phone = document.getElementById('adminPhoneInput').value.trim();
  const site = document.getElementById('adminSiteInput').value.trim();
  DB[supplier].phone = phone;
  DB[supplier].site = site;
  try {
    const ok = await Sync.saveDB(DB);
    if (ok === false) { showToast('Firebase neconectat!', true); return; }
    adminRenderSupplierContact();
    showToast('Contact salvat! ✓');
  } catch (e) {
    showToast('Eroare Firebase: ' + e.message, true);
  }
}

// ── CENTRALIZATOR ──
const _expandedCentralizator = new Set();
const _sentCentralizatorSuppliers = new Set();

function renderCentralizator() {
  const el = document.getElementById('centralizatorList');
  const raw = Sync.getOrders() || {};

  // cleanup orders older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;
  const orders = {};
  Object.entries(raw).forEach(([id, order]) => {
    if (order.timestamp && order.timestamp >= cutoff) {
      orders[id] = order;
    } else {
      changed = true;
    }
  });
  if (changed) {
    Sync.saveOrders(orders).catch(() => {});
  }

  const entries = Object.values(orders);
  if (!entries.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📊</div><div>Nicio comandă în ultimele 24h</div></div>';
    document.getElementById('centralizatorTrimiteBtn').disabled = true;
    return;
  }
  document.getElementById('centralizatorTrimiteBtn').disabled = false;

  // group by supplier then location
  const bySupplier = {};
  entries.forEach(order => {
    (order.items || []).forEach(item => {
      const sup = item.supplier;
      if (!bySupplier[sup]) bySupplier[sup] = {};
      const loc = order.location || '?';
      if (!bySupplier[sup][loc]) bySupplier[sup][loc] = [];
      bySupplier[sup][loc].push({
        produs: item.produs,
        qty: item.qty,
        tip_ambalaj: item.tip_ambalaj || ''
      });
    });
  });

  el.innerHTML = '';
  // expand all suppliers by default on fresh render
  const allSup = Object.keys(bySupplier);
  if (!_expandedCentralizator.size) allSup.forEach(s => _expandedCentralizator.add(s));

  Object.entries(bySupplier).forEach(([supplier, locs]) => {
    const group = document.createElement('div');
    group.className = 'supplier-group';

    const isExpanded = _expandedCentralizator.has(supplier);
    const header = document.createElement('div');
    header.className = 'supplier-header';
    const totalItems = Object.values(locs).reduce((s, v) => s + v.length, 0);
    header.innerHTML = `<span class="supplier-arrow">${isExpanded ? '▼' : '▶'}</span><span>${supplier}</span><span class="supplier-count">${totalItems}</span>`;
    header.onclick = () => {
      if (_expandedCentralizator.has(supplier)) _expandedCentralizator.delete(supplier);
      else _expandedCentralizator.add(supplier);
      renderCentralizator();
    };
    group.appendChild(header);

    const body = document.createElement('div');
    body.className = 'supplier-body';
    if (!isExpanded) { body.style.display = 'none'; }

    Object.entries(locs).forEach(([location, prods]) => {
      const locBlock = document.createElement('div');
      locBlock.className = 'centralizator-loc';

      const locHeader = document.createElement('div');
      locHeader.className = 'centralizator-loc-header';
      locHeader.textContent = `📍 ${location}`;
      locBlock.appendChild(locHeader);

      const list = document.createElement('div');
      list.className = 'centralizator-loc-list';
      prods.forEach(p => {
        const row = document.createElement('div');
        row.className = 'centralizator-item';
        row.innerHTML = `<span>✅ ${p.produs}</span><span class="centralizator-qty">× ${p.qty} ${p.tip_ambalaj}</span>`;
        list.appendChild(row);
      });
      locBlock.appendChild(list);
      body.appendChild(locBlock);
    });

    const DB = Sync.getDB();
    const phone = DB[supplier] ? DB[supplier].phone : '';
    const site = DB[supplier] ? DB[supplier].site : '';
    const waBtn = document.createElement('button');
    const sent = _sentCentralizatorSuppliers.has(supplier);
    waBtn.className = sent ? 'btn-wa sent' : 'btn-wa';
    waBtn.style.margin = '8px 0 4px 0';
    waBtn.textContent = sent ? '✅ Comanda trimisă' : (phone ? '📤 Trimite comanda' : '📋 Copiază comanda');
    waBtn.disabled = sent;
    if (!sent) {
      waBtn.onclick = () => {
        const msg = centralizatorBuildMessage(supplier, locs);
        if (phone) {
          window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(msg), '_blank');
        }
        if (site) {
          window.open(site, '_blank');
        }
        navigator.clipboard.writeText(msg).then(() => {});
        showToast('Comanda a fost copiată!');
        _sentCentralizatorSuppliers.add(supplier);
        renderCentralizator();
      };
    }
    body.appendChild(waBtn);

    group.appendChild(body);
    el.appendChild(group);
  });
}

function centralizatorBuildMessage(supplier, locs) {
  const lines = [];
  Object.entries(locs).forEach(([location, prods]) => {
    lines.push(`📍 *PENTRU ${location.toUpperCase()}:*`);
    prods.forEach(p => {
      lines.push(`✅ *${p.produs}* -> ${p.qty} ${p.tip_ambalaj}`);
    });
    lines.push('');
  });
  const mesaj = `Bună ziua! Aș dori să comand următoarele produse:\n\n${lines.join('\n')}\nMulțumesc!`;
  return mesaj;
}

function centralizatorReset() {
  if (!confirm('Resetezi toate comenzile din centralizator?')) return;
  Sync.saveOrders({}).then(() => {
    renderCentralizator();
    showToast('Centralizator resetat!');
  }).catch(() => {});
}

function centralizatorTrimite() {
  const raw = Sync.getOrders() || {};
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const orders = Object.values(raw).filter(o => o.timestamp && o.timestamp >= cutoff);
  if (!orders.length) return;

  // group by supplier then location for messages
  const bySupplier = {};
  orders.forEach(order => {
    (order.items || []).forEach(item => {
      const sup = item.supplier;
      if (!bySupplier[sup]) bySupplier[sup] = {};
      const loc = order.location || '?';
      if (!bySupplier[sup][loc]) bySupplier[sup][loc] = [];
      bySupplier[sup][loc].push({
        produs: item.produs,
        qty: item.qty,
        tip_ambalaj: item.tip_ambalaj || ''
      });
    });
  });

  const results = Object.entries(bySupplier).map(([supplier, locs]) => {
    const lines = [];
    Object.entries(locs).forEach(([location, prods]) => {
      lines.push(`📍 *PENTRU ${location.toUpperCase()}:*`);
      prods.forEach(p => {
        lines.push(`✅ *${p.produs}* -> ${p.qty} ${p.tip_ambalaj}`);
      });
      lines.push('');
    });
    const mesaj = `Bună ziua! Aș dori să comand următoarele produse:\n\n${lines.join('\n')}\nMulțumesc!`;
    return { furnizor: supplier, mesaj };
  });

  lastResults = results;
  renderResults(results);
  switchTab('results');

  // copy all messages to clipboard
  const all = results.filter(r => r.mesaj).map(r => r.mesaj).join('\n\n');
  navigator.clipboard.writeText(all).then(() => showToast('Comanda a fost copiată!'));
}

// ── HISTORY ──
function renderHistory() {
  const el = document.getElementById('historyList');
  const history = Sync.getHistory() || {};
  let entries = [];

  if (currentUser && currentUser.isAdmin) {
    // admin: show all locations
    Object.entries(history).forEach(([loc, locEntries]) => {
      Object.values(locEntries).forEach(e => {
        entries.push({ ...e, location: loc });
      });
    });
  } else {
    // user: show only own location
    const loc = currentUser ? currentUser.location : '';
    const locEntries = history[loc] || {};
    entries = Object.values(locEntries).map(e => ({ ...e, location: loc }));
  }

  // sort newest first
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  if (!entries.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📜</div><div>Nicio comandă în istoric</div></div>';
    return;
  }

  el.innerHTML = '';
  entries.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'history-entry';

    const date = entry.timestamp ? new Date(entry.timestamp).toLocaleString('ro-RO') : '?';
    const header = document.createElement('div');
    header.className = 'history-header';
    header.innerHTML = `<span class="history-loc">📍 ${entry.location}</span><span class="history-date">${date}</span>`;
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'history-body';

    // group items by supplier
    const bySup = {};
    (entry.items || []).forEach(item => {
      if (!bySup[item.supplier]) bySup[item.supplier] = [];
      bySup[item.supplier].push(item);
    });

    Object.entries(bySup).forEach(([supplier, prods]) => {
      const supEl = document.createElement('div');
      supEl.className = 'history-supplier';
      supEl.textContent = supplier;
      body.appendChild(supEl);

      prods.forEach(p => {
        const row = document.createElement('div');
        row.className = 'history-item';
        row.innerHTML = `<span>${p.produs}</span><span class="history-qty">× ${p.qty} ${p.tip_ambalaj || ''}</span>`;
        body.appendChild(row);
      });
    });

    card.appendChild(body);
    el.appendChild(card);
  });
}

// ── NAV ──
function switchTab(tab) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('view-' + tab).classList.add('active');
  const tabEl = document.querySelector(`[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add('active');
  if (tab === 'cart') renderCart();
  if (tab === 'admin') { adminRenderGrants(); adminRenderProducts(); adminRenderLocations(); adminPopulateLocDropdown(); adminUpdateEmailDisplay(); }
  if (tab === 'results') renderResults(lastResults);
  if (tab === 'centralizator') renderCentralizator();
  if (tab === 'history') renderHistory();
}

// ── HELPERS ──
function showLoading(t, p) { document.getElementById('loadingOverlay').style.display='flex'; document.getElementById('loadingText').textContent=t; document.getElementById('progressFill').style.width=(p||0)+'%'; }
function setProgress(p) { document.getElementById('progressFill').style.width=p+'%'; }
function setLoadingText(t) { document.getElementById('loadingText').textContent=t; }
function hideLoading() { document.getElementById('loadingOverlay').style.display='none'; }
function showToast(msg, err, duration) { const t=document.getElementById('toast'); t.textContent=msg; t.className='toast'+(err?' error':'')+' show'; setTimeout(()=>t.className='toast', duration||2500); }

initApp();
