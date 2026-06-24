const Sync = {
  _db: null,
  _pins: null,
  _grants: null,
  _orders: {},
  _history: {},
  _emails: {},
  _dbListeners: [],
  _pinsListeners: [],
  _grantsListeners: [],
  _ordersListeners: [],
  _historyListeners: [],
  _emailsListeners: [],
  _localDBHash: '',
  _localPinsHash: '',
  _localGrantsHash: '',
  _localOrdersHash: '',
  _localHistoryHash: '',
  _localEmailsHash: '',
  _unsubDB: null,
  _unsubPins: null,
  _unsubGrants: null,
  _unsubOrders: null,
  _unsubHistory: null,
  _unsubEmails: null,
  initialized: false,
  connected: false,
  _grantsSyncResolve: null,
  grantsSync: null,
  _pendingGrantsHash: null,

  async init() {
    this._loadLocal();
    this._migratePinsToGrants();
    this.grantsSync = new Promise(resolve => { this._grantsSyncResolve = resolve; });
    this.initialized = true;
    if (firebaseReady) {
      this._listenFirebase();
      this.connected = true;
    } else {
      this._grantsSyncResolve();
    }
    this._notifyDBListeners();
    this._notifyPinsListeners();
    this._notifyGrantsListeners();
    this._notifyOrdersListeners();
    this._notifyHistoryListeners();
  },

  _loadLocal() {
    try {
      const saved = localStorage.getItem('promenada_db');
      this._db = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(DEFAULT_DB));
    } catch {
      this._db = JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    try {
      const saved = localStorage.getItem('promenada_pins');
      let parsed = saved ? JSON.parse(saved) : null;
      this._pins = parsed || {};
    } catch {
      this._pins = {};
    }
    if (this._pins && this._pins.ADMIN === '0000') {
      this._pins.ADMIN = 'c97909806a8582002b51e51c9b44c7c077d3afbff6b6133c76ec05a042ab1e1d';
      localStorage.setItem('promenada_pins', JSON.stringify(this._pins));
    }
    try {
      const saved = localStorage.getItem('promenada_grants');
      let parsed = saved ? JSON.parse(saved) : null;
      this._grants = parsed || {};
    } catch {
      this._grants = {};
    }
    try {
      const saved = localStorage.getItem('promenada_emails');
      let parsed = saved ? JSON.parse(saved) : null;
      this._emails = parsed || {};
    } catch {
      this._emails = {};
    }
    try {
      const saved = localStorage.getItem('promenada_orders');
      let parsed = saved ? JSON.parse(saved) : null;
      this._orders = parsed || {};
    } catch {
      this._orders = {};
    }
    try {
      const saved = localStorage.getItem('promenada_history');
      let parsed = saved ? JSON.parse(saved) : null;
      this._history = parsed || {};
    } catch {
      this._history = {};
    }
    this._updateHashes();
  },

  _migratePinsToGrants() {
    if (!this._pins) return;
    try {
      if (localStorage.getItem('promenada_grants_migrated')) return;
    } catch (e) {}
    if (!this._grants || Object.keys(this._grants).length === 0) {
      for (const [loc, pin] of Object.entries(this._pins)) {
        if (loc === 'ADMIN') continue;
        this._grants[loc] = { granted: true, code: null };
      }
      if (Object.keys(this._grants).length > 0) {
        this._saveLocal();
        try { localStorage.setItem('promenada_grants_migrated', '1'); } catch (e) {}
      }
    }
  },

  _saveLocal() {
    localStorage.setItem('promenada_db', JSON.stringify(this._db));
    localStorage.setItem('promenada_pins', JSON.stringify(this._pins));
    localStorage.setItem('promenada_grants', JSON.stringify(this._grants));
    localStorage.setItem('promenada_orders', JSON.stringify(this._orders));
    localStorage.setItem('promenada_history', JSON.stringify(this._history));
    localStorage.setItem('promenada_emails', JSON.stringify(this._emails));
    this._updateHashes();
  },

  _updateHashes() {
    this._localDBHash = JSON.stringify(this._db);
    this._localPinsHash = JSON.stringify(this._pins);
    this._localGrantsHash = JSON.stringify(this._grants);
    this._localOrdersHash = JSON.stringify(this._orders);
    this._localHistoryHash = JSON.stringify(this._history);
    this._localEmailsHash = JSON.stringify(this._emails);
  },

  _listenFirebase() {
    const rootRef = firebase.database().ref();
    console.log('📡 _listenFirebase called');
    this._unsubDB = rootRef.child('db').on('value', snap => {
      const val = snap.val();
      console.log('📡 FB db.on value:', val ? 'data' : 'null');
      if (!val) return;
      const hash = JSON.stringify(val);
      if (hash === this._localDBHash) return;
      this._db = val;
      localStorage.setItem('promenada_db', JSON.stringify(this._db));
      this._localDBHash = hash;
      this._notifyDBListeners();
    });
    this._unsubPins = rootRef.child('pins').on('value', snap => {
      const val = snap.val();
      console.log('📡 FB pins.on value:', val ? 'data' : 'null');
      if (!val) return;
      const desanitized = this._desanitizePinKeys(val);
      const hash = JSON.stringify(desanitized);
      if (hash === this._localPinsHash) return;
      this._pins = desanitized;
      if (this._pins.ADMIN === '0000') {
        this._pins.ADMIN = 'c97909806a8582002b51e51c9b44c7c077d3afbff6b6133c76ec05a042ab1e1d';
        this._saveLocal();
        if (firebaseReady) {
          firebase.database().ref('pins').set(this._sanitizePinKeys(this._pins));
        }
      }
      localStorage.setItem('promenada_pins', JSON.stringify(this._pins));
      this._localPinsHash = JSON.stringify(this._pins);
      this._notifyPinsListeners();
    });
    this._unsubGrants = rootRef.child('grants').on('value', snap => {
      const val = snap.val();
      console.log('📡 FB grants.on value:', val ? 'data' : 'null', 'localHash:', this._localGrantsHash);
      if (val) {
        const desanitized = {};
        for (const [k, v] of Object.entries(val)) {
          desanitized[this._desanitizeFirebaseKey(k)] = v;
        }
        const hash = JSON.stringify(desanitized);
        console.log('📡 grants hash:', hash, 'match:', hash === this._localGrantsHash, 'pending:', hash === this._pendingGrantsHash);
        if (hash === this._pendingGrantsHash) return;
        if (hash !== this._localGrantsHash) {
          this._grants = desanitized;
          localStorage.setItem('promenada_grants', JSON.stringify(this._grants));
          this._localGrantsHash = hash;
          console.log('📡 grants updated, notifying');
          this._notifyGrantsListeners();
        }
      } else {
        console.log('📡 grants val is null');
        if (this._grants && Object.keys(this._grants).length > 0) {
          this._grants = {};
          localStorage.setItem('promenada_grants', '{}');
          this._localGrantsHash = '{}';
          console.log('📡 grants cleared, notifying');
          this._notifyGrantsListeners();
        }
      }
      if (this._grantsSyncResolve) { this._grantsSyncResolve(); this._grantsSyncResolve = null; }
    });
    this._unsubOrders = rootRef.child('orders').on('value', snap => {
      const val = snap.val();
      console.log('📡 FB orders.on value:', val ? 'data' : 'null');
      if (!val) return;
      const desanitized = {};
      Object.entries(val).forEach(([k, v]) => { desanitized[this._desanitizeOrderKey(k)] = v; });
      const hash = JSON.stringify(desanitized);
      if (hash === this._localOrdersHash) return;
      this._orders = desanitized;
      localStorage.setItem('promenada_orders', JSON.stringify(this._orders));
      this._localOrdersHash = hash;
      this._notifyOrdersListeners();
    });
    this._unsubHistory = rootRef.child('history').on('value', snap => {
      const val = snap.val();
      if (!val) return;
      const desanitized = {};
      Object.entries(val).forEach(([k, v]) => { desanitized[this._desanitizeFirebaseKey(k)] = v; });
      const hash = JSON.stringify(desanitized);
      if (hash === this._localHistoryHash) return;
      this._history = desanitized;
      localStorage.setItem('promenada_history', JSON.stringify(this._history));
      this._localHistoryHash = hash;
    this._notifyHistoryListeners();
    this._notifyEmailsListeners();
    });
    this._unsubEmails = rootRef.child('emails').on('value', snap => {
      const val = snap.val();
      if (!val) return;
      const hash = JSON.stringify(val);
      if (hash === this._localEmailsHash) return;
      this._emails = val;
      localStorage.setItem('promenada_emails', JSON.stringify(this._emails));
      this._localEmailsHash = hash;
      this._notifyEmailsListeners();
    });
  },

  getDB() { return this._db; },

  _sanitizeFirebaseKey(k) {
    return String(k).replace(/[.$#\[\]\/]/g, '·');
  },
  _desanitizeFirebaseKey(k) {
    return String(k).replace(/·/g, '.');
  },

  _sanitizePinKeys(pins) {
    const out = {};
    for (const [k, v] of Object.entries(pins)) {
      const sk = this._sanitizeFirebaseKey(k);
      if (sk) out[sk] = v;
    }
    return out;
  },
  _desanitizePinKeys(pins) {
    const out = {};
    for (const [k, v] of Object.entries(pins)) {
      out[this._desanitizeFirebaseKey(k)] = v;
    }
    return out;
  },

  async saveDB(data) {
    this._db = data;
    this._saveLocal();
    if (!firebaseReady) { return false; }
    try {
      await firebase.database().ref('db').set(data);
      return true;
    } catch (e) {
      console.warn('Firebase save error (db):', e);
      throw e;
    }
  },

  getOrders() { return this._orders; },

  getHistory() { return this._history; },

  async saveHistory(data) {
    this._history = data;
    this._saveLocal();
    if (!firebaseReady) return false;
    try {
      const sanitized = {};
      Object.entries(data).forEach(([k, v]) => { sanitized[this._sanitizeFirebaseKey(k)] = v; });
      await firebase.database().ref('history').set(sanitized);
      return true;
    } catch (e) {
      console.warn('Firebase save error (history):', e);
      throw e;
    }
  },

  onHistoryChange(fn) { this._historyListeners.push(fn); },

  onEmailsChange(fn) { this._emailsListeners.push(fn); },
  _sanitizeOrderKey(k) { return this._sanitizeFirebaseKey(k); },
  _desanitizeOrderKey(k) { return this._desanitizeFirebaseKey(k); },

  async saveOrders(data) {
    this._orders = data;
    this._saveLocal();
    if (!firebaseReady) { return false; }
    try {
      const sanitized = {};
      Object.entries(data).forEach(([k, v]) => { sanitized[this._sanitizeOrderKey(k)] = v; });
      await firebase.database().ref('orders').set(sanitized);
      return true;
    } catch (e) {
      console.warn('Firebase save error (orders):', e);
      throw e;
    }
  },

  async saveOrderForLocation(location, data) {
    this._orders[location] = data;
    this._saveLocal();
    if (!firebaseReady) return false;
    try {
      const sanitized = this._sanitizeOrderKey(location);
      await firebase.database().ref('orders/' + sanitized).set(data);
      return true;
    } catch (e) {
      console.warn('Firebase save error (order location):', e);
      throw e;
    }
  },

  async removeOrderEntry(key) {
    delete this._orders[key];
    this._saveLocal();
    if (!firebaseReady) return false;
    try {
      const sanitized = this._sanitizeOrderKey(key);
      await firebase.database().ref('orders/' + sanitized).remove();
      return true;
    } catch (e) {
      console.warn('Firebase remove error (order entry):', e);
      throw e;
    }
  },

  getPins() { return this._pins; },

  getGrants() { return this._grants || {}; },

  getEmails() { return this._emails || {}; },

  async saveEmails(data) {
    this._emails = data;
    this._saveLocal();
    if (!firebaseReady) return false;
    try {
      const sanitized = {};
      for (const [k, v] of Object.entries(data)) {
        const sk = this._sanitizeFirebaseKey(k);
        if (sk) sanitized[sk] = v;
      }
      await firebase.database().ref('emails').set(sanitized);
      return true;
    } catch (e) {
      console.warn('Firebase save error (emails):', e);
      throw e;
    }
  },

  async saveGrants(data) {
    this._pendingGrantsHash = this._localGrantsHash;
    this._grants = data;
    this._saveLocal();
    if (!firebaseReady) { this._pendingGrantsHash = null; return false; }
    try {
      const sanitized = {};
      for (const [k, v] of Object.entries(data)) {
        const sk = this._sanitizeFirebaseKey(k);
        if (sk) sanitized[sk] = v;
      }
      await firebase.database().ref('grants').set(sanitized);
      return true;
    } catch (e) {
      console.warn('Firebase save error (grants):', e);
      throw e;
    } finally {
      setTimeout(() => { this._pendingGrantsHash = null; }, 60000);
    }
  },

  async savePins(data) {
    console.log('💾 savePins called', data, 'firebaseReady:', firebaseReady);
    this._pins = data;
    this._saveLocal();
    if (!firebaseReady) { return false; }
    try {
      const ref = firebase.database().ref('pins');
      const sanitized = this._sanitizePinKeys(data);
      console.log('🔍 Sanitized keys:', Object.keys(sanitized));
      await ref.set(sanitized);
      const snap = await ref.once('value');
      const readback = snap.val();
      console.log('💾 Readback:', readback);
      if (!readback) return false;
      const desanitized = this._desanitizePinKeys(readback);
      console.log('💾 Desanitized:', desanitized);
      console.log('💾 Firebase write OK');
      return true;
    } catch (e) {
      console.warn('Firebase save error (pins):', e);
      throw e;
    }
  },

  onDBChange(fn) { this._dbListeners.push(fn); },

  onPinsChange(fn) { this._pinsListeners.push(fn); },

  onGrantsChange(fn) { this._grantsListeners.push(fn); },

  onOrdersChange(fn) { this._ordersListeners.push(fn); },

  _notifyDBListeners() {
    this._dbListeners.forEach(fn => { try { fn(this._db); } catch (e) { console.warn(e); } });
  },

  _notifyPinsListeners() {
    this._pinsListeners.forEach(fn => { try { fn(this._pins); } catch (e) { console.warn(e); } });
  },

  _notifyGrantsListeners() {
    this._grantsListeners.forEach(fn => { try { fn(this._grants); } catch (e) { console.warn(e); } });
  },

  _notifyOrdersListeners() {
    this._ordersListeners.forEach(fn => { try { fn(this._orders); } catch (e) { console.warn(e); } });
  },

  _notifyHistoryListeners() {
    this._historyListeners.forEach(fn => { try { fn(this._history); } catch (e) { console.warn(e); } });
  },

  _notifyEmailsListeners() {
    this._emailsListeners.forEach(fn => { try { fn(this._emails); } catch (e) { console.warn(e); } });
  }
};

console.log('Sync loaded - fix applied');
