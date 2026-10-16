/* ═══════════════════════════════════════════════════════════════
   MACROME CLOUD LAYER (Firebase)  —  Phases 1-2: sign-in, roles, shops, catalogue, stock
   Plain wrapper around the Firebase SDK. It draws no screens; app.js calls it.

   Phase 2 adds the shared catalogue + per-shop stock (products, stock, stockReceipts, transfers, settings).
   Cloud.on      = a Firebase config is present in js/firebase-config.js
   Cloud.broken  = config present but the Firebase library files are missing (run tools/vendor.py)
   With no config, Cloud.on is false and the app keeps today's single-device mode.

   Sign-in: staff type a username; Firebase sees  username@<emailDomain>.
   Offline: Firebase cannot check a password without internet. After each online sign-in this phone keeps a
   salted hash of that person's password (same scheme as the old local mode). Offline sign-in is accepted only
   for the person whose Firebase session is still on this phone, so a different person must sign in online once.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const CFG = window.MACROME_CLOUD || {};
  const FB = CFG.firebase || {};
  const DOMAIN = String(CFG.emailDomain || 'macrome.app').replace(/^@/, '');
  const REC_KEY = 'macrome-cloud-device-v1';   // who last signed in on this phone (+ password hash for offline sign-in)
  const OWNER_KEY = 'macrome-cloud-owner-v1';  // remembers that the owner account exists
  const SHOPS = ['A', 'B', 'C'];

  const configured = !!(FB.apiKey && FB.projectId);
  const hasSdk = typeof firebase !== 'undefined' && !!firebase.initializeApp && !!firebase.auth && !!firebase.firestore;
  const C = { on: configured, broken: configured && !hasSdk, persistence: 'unknown' };
  window.Cloud = C;
  if (!configured || !hasSdk) return;

  /* ── start-up ───────────────────────────────────────────── */
  const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FB);
  const auth = firebase.auth(app);
  const db = firebase.firestore(app);
  try { db.settings({ cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED }); } catch (e) { /* already set */ }
  // Local copy of the data, so the till keeps working with no internet. Must be switched on before any other call.
  const dbReady = db.enablePersistence({ synchronizeTabs: true })
    .then(() => { C.persistence = 'on'; })
    .catch((e) => { C.persistence = (e && e.code) || 'failed'; });   // e.g. private browsing: works, but online only
  // resolves once Firebase has restored the saved session (works offline)
  const authReady = new Promise((res) => { const off = auth.onAuthStateChanged((u) => { off(); res(u); }); });

  const ts = () => firebase.firestore.FieldValue.serverTimestamp();
  const coded = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };
  const emailFor = (u) => String(u || '').trim().toLowerCase() + '@' + DOMAIN;
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  function prof(snap) {
    if (!snap || !snap.exists) return null;
    const d = snap.data() || {};
    return { id: snap.id, name: d.name || '', username: d.username || '', role: d.role || '', shop: d.shop || '', code: d.code || '', active: d.active === true };
  }

  /* ── errors ─────────────────────────────────────────────── */
  C.isNetwork = function (e) {
    const c = (e && e.code) || '';
    return c === 'auth/network-request-failed' || c === 'unavailable' || c === 'deadline-exceeded' || c === 'auth/timeout';
  };
  C.isBadLogin = function (e) {
    return ['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-login-credentials', 'auth/invalid-email'].includes(e && e.code);
  };
  C.friendly = function (e) {
    const c = (e && e.code) || '';
    switch (c) {
      case 'auth/invalid-credential': case 'auth/user-not-found': case 'auth/wrong-password':
      case 'auth/invalid-login-credentials': case 'auth/invalid-email': return 'Incorrect username or password.';
      case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes and try again.';
      case 'auth/user-disabled': case 'macrome/disabled': return 'This account has been switched off. Ask the owner.';
      case 'macrome/no-profile': return 'This account has no access to Macrome. Ask the owner to add you.';
      case 'macrome/offline-other': return 'No internet. Offline, only the person who last signed in on this phone can sign in. Connect once and try again.';
      case 'auth/email-already-in-use': return 'That username is already taken.';
      case 'auth/weak-password': return 'Password must be at least 6 characters.';
      case 'auth/requires-recent-login': return 'Please sign in again, then retry.';
      case 'auth/operation-not-allowed': return 'Email/password sign-in is not switched on in Firebase (Authentication → Sign-in method).';
      case 'auth/invalid-api-key': case 'auth/api-key-not-valid': case 'auth/app-not-authorized': return 'The Firebase settings in js/firebase-config.js are not correct.';
      case 'permission-denied': return 'The server refused this. You may not have permission, or the setup code is wrong.';
      case 'macrome/no-session': return 'You are not signed in to the cloud on this phone. Sign out and in again.';
      case 'unavailable': case 'auth/network-request-failed': case 'deadline-exceeded': case 'auth/timeout': return 'No internet connection.';
      default: return 'Something went wrong' + (c ? ' (' + c + ')' : '') + '.';
    }
  };

  /* ── who is on this phone ───────────────────────────────── */
  C.authReady = () => authReady;
  C.currentUid = () => (auth.currentUser ? auth.currentUser.uid : '');
  C.record = function () { try { return JSON.parse(ls(REC_KEY)) || null; } catch (e) { return null; } };
  C.remember = function (p, password) {          // call after every successful ONLINE sign-in / password change
    const salt = rndHex(16);                     // rndHex / hashPw live in app.js
    lsSet(REC_KEY, JSON.stringify({ uid: p.id, username: p.username, name: p.name, role: p.role, shop: p.shop, code: p.code, salt, hash: hashPw(password, salt), at: Date.now() }));
  };
  function refreshRecord(p) {                    // keep role/shop on this phone in step with the server
    const r = C.record();
    if (r && r.uid === p.id) { r.name = p.name; r.role = p.role; r.shop = p.shop; r.code = p.code; lsSet(REC_KEY, JSON.stringify(r)); }
  }

  /* ── sign-in ────────────────────────────────────────────── */
  async function signInOnline(username, password) {
    await dbReady;
    const cred = await auth.signInWithEmailAndPassword(emailFor(username), password);
    const p = prof(await db.doc('users/' + cred.user.uid).get());
    if (!p) { try { await auth.signOut(); } catch (e) { /* ignore */ } throw coded('macrome/no-profile'); }
    if (!p.active) { try { await auth.signOut(); } catch (e) { /* ignore */ } throw coded('macrome/disabled'); }
    C.remember(p, password);
    lsSet(OWNER_KEY, '1');
    return p;
  }
  // A bad mobile connection can hang for a long time: after 9 s treat it as "offline" so the till can fall back.
  C.signIn = function (username, password) {
    return Promise.race([signInOnline(username, password), new Promise((_, rej) => setTimeout(() => rej(coded('auth/timeout')), 9000))]);
  };
  C.offlineSignIn = async function (username, password) {
    const r = C.record();
    await authReady;
    if (!r || r.username !== String(username).trim().toLowerCase() || !auth.currentUser || auth.currentUser.uid !== r.uid) throw coded('macrome/offline-other');
    if (hashPw(password, r.salt) !== r.hash) throw coded('auth/invalid-credential');
    return { id: r.uid, name: r.name, username: r.username, role: r.role, shop: r.shop, code: r.code, active: true, offline: true };
  };
  C.signOutDevice = async function () { C.stopSession(); try { await auth.signOut(); } catch (e) { /* ignore */ } try { localStorage.removeItem(REC_KEY); } catch (e) { /* ignore */ } };

  /* ── first-time owner setup ─────────────────────────────── */
  C.ownerExists = async function () {            // true / false, or null when it cannot be checked (offline)
    await dbReady;
    try {
      const s = await db.doc('meta/owner').get({ source: 'server' });
      if (s.exists) lsSet(OWNER_KEY, '1');
      return s.exists;
    } catch (e) { return ls(OWNER_KEY) === '1' ? true : null; }
  };
  C.setupOwner = async function (o) {            // {name, username, password, code, setupCode}
    await dbReady;
    const email = emailFor(o.username);
    let cred, created = false;
    try { cred = await auth.createUserWithEmailAndPassword(email, o.password); created = true; }
    catch (e) {
      if (e.code !== 'auth/email-already-in-use') throw e;
      cred = await auth.signInWithEmailAndPassword(email, o.password);   // an earlier attempt stopped half-way
    }
    const uid = cred.user.uid;
    try {
      // one all-or-nothing write: the rules accept it only with the right setup code and only while no owner exists
      await db.runTransaction(async (t) => {
        t.set(db.doc('bootstrap/' + o.setupCode), { uid });
        t.set(db.doc('meta/owner'), { uid, at: ts() });
        t.set(db.doc('users/' + uid), { name: o.name, username: o.username, role: 'super', shop: '', code: o.code, active: true, created: ts() });
      });
    } catch (e) {
      if (created) { try { await cred.user.delete(); } catch (_) { /* ignore */ } }   // never leave a stray login behind
      throw e;
    }
    lsSet(OWNER_KEY, '1');
    const p = prof(await db.doc('users/' + uid).get());
    C.remember(p, o.password);
    return p;
  };

  /* ── staff (managers only; the rules enforce who may do what) ── */
  function secondaryAuth() {                     // a second Firebase app, so creating a login does not sign the manager out
    let a; try { a = firebase.app('staff'); } catch (e) { a = firebase.initializeApp(FB, 'staff'); }
    return a.auth();
  }
  C.createStaff = async function (o) {           // {name, username, password, role, shop, code}
    await dbReady;
    const sa = secondaryAuth();
    try { await sa.setPersistence(firebase.auth.Auth.Persistence.NONE); } catch (e) { /* ignore */ }
    const cred = await sa.createUserWithEmailAndPassword(emailFor(o.username), o.password);
    try {
      await db.runTransaction(async (t) => {    // needs the server: fails (instead of queueing) when offline
        t.set(db.doc('users/' + cred.user.uid), { name: o.name, username: o.username, role: o.role, shop: o.shop || '', code: o.code, active: true, created: ts() });
      });
    } catch (e) {
      try { await cred.user.delete(); } catch (_) { /* ignore */ }
      try { await sa.signOut(); } catch (_) { /* ignore */ }
      throw e;
    }
    try { await sa.signOut(); } catch (e) { /* ignore */ }
    return cred.user.uid;
  };
  C.updateUser = async function (uid, fields) {  // name / shop / active / code
    await dbReady;
    await db.runTransaction(async (t) => { t.update(db.doc('users/' + uid), fields); });
  };
  C.changeOwnPassword = async function (current, next) {
    const u = auth.currentUser;
    if (!u) throw coded('macrome/no-session');
    await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, current));
    await u.updatePassword(next);
  };

  /* ── live session: my own profile + (managers) the staff list ── */
  let unsubs = [];
  C.startSession = function (p, h) {             // h = {onProfile(profile|null), onUsers(list), onError(e)}
    C.stopSession();
    unsubs.push(db.doc('users/' + p.id).onSnapshot((s) => {
      const np = prof(s);
      if (np) refreshRecord(np);
      if (h.onProfile && !(s.metadata.fromCache && !np)) h.onProfile(np);   // a missing doc seen only in the cache is not proof
    }, (e) => h.onError && h.onError(e)));
    if (p.role === 'super' || p.role === 'admin') {
      const col = db.collection('users');
      const q = p.shop ? col.where('shop', '==', p.shop) : col;   // a shop manager may only list their own shop
      unsubs.push(q.onSnapshot((s) => { h.onUsers && h.onUsers(s.docs.map(prof).filter(Boolean)); }, (e) => h.onError && h.onError(e)));
    }
  };
  C.stopSession = function () { unsubs.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); unsubs = []; };


  /* ═══ PHASE 2: shared product catalogue + stock per shop ═══════════════════
     products/<id>            {n, s, c, r, w}              one per product, shared by every shop
     stock/<shop>_<id>        {shop, pid, qty}             one per shop and product
     stockReceipts/<auto>     {shop, pid, n, qty, by, byName, at}   written once
     transfers/<auto>         {pid, n, from, to, qty, by, byName, at}   written once
     settings/business        {biz:{...}, shops:[{id,name,loc}]}
     Stock is changed with increment(+/-n), never by overwriting a number, so two tills selling at once both count.
     Writes are not awaited by the screens: with persistence on, the local copy updates at once, the write waits
     in a queue while offline and is sent when the connection returns; a refused write rolls back and rejects. */
  const inc = (n) => firebase.firestore.FieldValue.increment(n);
  const pref = (id) => db.doc('products/' + id);
  const sref = (shop, id) => db.doc('stock/' + shop + '_' + id);
  const cref = (id) => db.doc('costs/' + id);
  const idStr = (id) => String(id);

  // Product ids stay plain numbers (the screens already use numbers). Two phones can never clash: time + random.
  C.newId = function () { return Date.now() * 1000 + Math.floor(Math.random() * 1000); };

  // Run a list of write steps in batches of <= 400 (Firestore's limit is 500 per batch).
  function commit(steps) {
    const jobs = [];
    for (let i = 0; i < steps.length; i += 400) {
      const b = db.batch();
      steps.slice(i, i + 400).forEach((f) => f(b));
      jobs.push(b.commit());
    }
    return Promise.all(jobs).then(() => undefined);
  }
  function productSteps(o) {                     // o = {id, isNew, fields:{n,s,c,r,w}, qs:{A,B,C} (new), delta:{A:+n} (edit)}
    const id = idStr(o.id), st = [];
    const f = Object.assign({}, o.fields), w = f.w; delete f.w;           // cost price lives in costs/<id> (managers only), never in products/
    if (w !== undefined) st.push((b) => b.set(cref(id), { w: Math.max(0, Number(w) || 0) }));
    if (o.isNew) {
      st.push((b) => b.set(pref(id), Object.assign({}, f, { created: ts() })));
      SHOPS.forEach((sh) => st.push((b) => b.set(sref(sh, id), { shop: sh, pid: id, qty: Math.round((o.qs && o.qs[sh]) || 0) })));
    } else {
      st.push((b) => b.update(pref(id), Object.assign({}, f, { w: firebase.firestore.FieldValue.delete() })));   // also scrubs an old cost field
      Object.keys(o.delta || {}).forEach((sh) => { const d = Math.round(o.delta[sh]); if (d) st.push((b) => b.set(sref(sh, id), { shop: sh, pid: id, qty: inc(d) }, { merge: true })); });
    }
    return st;
  }
  C.saveProduct = async function (o) { await dbReady; return commit(productSteps(o)); };
  C.importProducts = async function (list) { await dbReady; return commit([].concat(...list.map(productSteps))); };
  C.deleteProduct = async function (id) {
    await dbReady; id = idStr(id);
    return commit([(b) => b.delete(pref(id)), (b) => b.delete(cref(id))].concat(SHOPS.map((sh) => (b) => b.delete(sref(sh, id)))));
  };
  // a sale takes stock out of one shop (update, never create: attendants may not create stock records)
  C.sellStock = async function (shop, lines) {   // lines = [{id, qty}]
    await dbReady;
    return commit(lines.map((l) => (b) => b.update(sref(shop, idStr(l.id)), { qty: inc(-Math.round(l.qty)) })));
  };
  C.receiveStock = async function (shop, p, qty, by) {   // p = {id, n}; by = {uid, name}
    await dbReady;
    return commit([
      (b) => b.set(sref(shop, idStr(p.id)), { shop, pid: idStr(p.id), qty: inc(qty) }, { merge: true }),
      (b) => b.set(db.collection('stockReceipts').doc(), { shop, pid: idStr(p.id), n: p.n, qty, by: by.uid, byName: by.name, at: ts(), month: ymd(new Date()).slice(0, 7) })
    ]);
  };
  C.transferStock = async function (from, to, p, qty, by) {
    await dbReady;
    const id = idStr(p.id);
    return commit([
      (b) => b.set(sref(from, id), { shop: from, pid: id, qty: inc(-qty) }, { merge: true }),
      (b) => b.set(sref(to, id), { shop: to, pid: id, qty: inc(qty) }, { merge: true }),
      (b) => b.set(db.collection('transfers').doc(), { pid: id, n: p.n, from, to, qty, by: by.uid, byName: by.name, at: ts() })
    ]);
  };
  C.saveSettings = async function (obj) { await dbReady; return db.doc('settings/business').set(obj, { merge: true }); };

  // Live catalogue. h = {onProducts({id:{n,s,c,r,w}}), onStock({'A_12': qty}), onSettings(obj), onTransfers([...]), onError(e)}
  // Attendants and shop managers receive only their own shop's stock (the rules refuse anything else).
  C.startCatalog = function (p, h) {
    const err = (e) => h.onError && h.onError(e);
    unsubs.push(db.collection('products').onSnapshot((s) => {
      const out = {}; s.docs.forEach((d) => { out[d.id] = d.data(); });
      h.onProducts && h.onProducts(out);
    }, err));
    const hq = (p.role === 'super' || p.role === 'admin') && !p.shop;
    const sq = hq ? db.collection('stock') : db.collection('stock').where('shop', '==', p.shop);
    unsubs.push(sq.onSnapshot((s) => {
      const out = {}; s.docs.forEach((d) => { const x = d.data(); out[d.id] = Number(x.qty) || 0; });
      h.onStock && h.onStock(out);
    }, err));
    unsubs.push(db.doc('settings/business').onSnapshot((s) => { if (s.exists && h.onSettings) h.onSettings(s.data()); }, err));
    if (p.role === 'super' || p.role === 'admin') {            // cost prices: managers only
      unsubs.push(db.collection('costs').onSnapshot((s) => {
        const out = {}; s.docs.forEach((d) => { out[d.id] = Number((d.data() || {}).w) || 0; });
        h.onCosts && h.onCosts(out);
      }, err));
    }
    if (hq) {
      unsubs.push(db.collection('transfers').orderBy('at', 'desc').limit(15).onSnapshot((s) => {
        h.onTransfers && h.onTransfers(s.docs.map((d) => {
          const x = d.data({ serverTimestamps: 'estimate' });
          const at = x.at && x.at.toDate ? x.at.toDate().toISOString() : new Date().toISOString();
          return { id: d.id, date: at, pid: Number(x.pid), n: x.n || '', from: x.from, to: x.to, qty: Number(x.qty) || 0, by: x.byName || '' };
        }));
      }, err));
    }
  };

  // One-time tidy for catalogues made before costs moved: copy any product `w` into costs/ and remove it from products/
  C.scrubCosts = async function (list) {          // list = [{id, w}]
    await dbReady;
    return commit([].concat(...list.map((x) => [
      (b) => b.set(cref(idStr(x.id)), { w: Math.max(0, Number(x.w) || 0) }, { merge: true }),
      (b) => b.update(pref(idStr(x.id)), { w: firebase.firestore.FieldValue.delete() })
    ])));
  };

  /* ═══ PHASE 3: sales ═══════════════════════════════════════════════════════
     sales/<A-GRC-0001>   {shop, num, ts, day, month, cashierUid, cashier, items, pay, sub, tot, paid?, change?, ref?, lines:[{id,n,qty,r,t}]}
                          written once, never edited. The id IS the receipt number: shop letter - attendant code - running number.
                          A second phone using the same number is refused by the server, and the sale is re-filed as ...-2.
     counters/<uid>       {n}  the attendant's last receipt number, so a new phone carries on from where the last one stopped
     costs/<productId>    {w}  cost prices, readable by managers only (sale lines carry no cost)
     The sale, the counter and the stock deduction go in ONE batch: all happen or none do, online or offline. */
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  C.dayKey = ymd;
  C.recordSale = async function (sale, seq) {      // sale = the document fields (see above), seq = its running number
    await dbReady;
    const base = sale.num;
    const attempt = (id) => {
      const b = db.batch();
      b.set(db.doc('sales/' + id), sale);
      b.set(db.doc('counters/' + sale.cashierUid), { n: seq });
      sale.lines.forEach((l) => b.update(sref(sale.shop, idStr(l.id)), { qty: inc(-Math.round(l.qty)) }));
      return b.commit();
    };
    const tries = [base, base + '-2', base + '-3'];
    let last;
    for (let i = 0; i < tries.length; i++) {
      try { await attempt(tries[i]); return tries[i]; }
      catch (e) { last = e; if (!(e && e.code === 'permission-denied')) throw e; }   // a taken number is refused; try the next one
    }
    throw last;
  };
  C.loadSeq = async function (uid) {
    await dbReady;
    try { const s = await db.doc('counters/' + uid).get(); return s.exists ? Number((s.data() || {}).n) || 0 : 0; } catch (e) { return 0; }
  };
  // Live sales. Attendants: today's sales of their shop. All-shops managers: this and last month, all shops.
  // Shop managers: the same, their shop only. (Equality-only queries, so no extra Firebase index is needed.)
  // h = {onSales(sourceName, {id: doc}), onError(e)}
  let sunsubs = [];
  C.stopSales = function () { sunsubs.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); sunsubs = []; sctx = null; };
  let sctx = null;
  C.startSales = function (p, h) {
    C.stopSales();
    const mgr = p.role === 'super' || p.role === 'admin';
    const now = new Date();
    sctx = { p, h, mgr, loaded: {} };
    if (!mgr) {                                    // attendants: today's sales of their shop, nothing else
      sunsubs.push(db.collection('sales').where('shop', '==', p.shop).where('day', '==', ymd(now)).onSnapshot((s) => {
        const out = {}; s.docs.forEach((d) => { out[d.id] = d.data(); });
        h.onSales && h.onSales('today', out);
      }, (e) => h.onError && h.onError(e)));
      return ymd(now);
    }
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    C.ensureMonths([ymd(now).slice(0, 7), ymd(prev).slice(0, 7)]);
    return ymd(now);
  };
  // Managers: load the sales, expenses (and stock receipts, this month) of the given months ('YYYY-MM'), once each.
  C.ensureMonths = function (months) {
    if (!sctx || !sctx.mgr) return;
    const { p, h } = sctx, err = (e) => h.onError && h.onError(e);
    const cur = ymd(new Date()).slice(0, 7);
    months.forEach((mk) => {
      if (!/^\d{4}-\d{2}$/.test(mk) || sctx.loaded[mk]) return;
      sctx.loaded[mk] = 1;
      const q = (col) => (p.shop ? db.collection(col).where('shop', '==', p.shop).where('month', '==', mk) : db.collection(col).where('month', '==', mk));
      const grab = (cb) => (s) => { const out = {}; s.docs.forEach((d) => { out[d.id] = d.data(); }); cb(out); };
      sunsubs.push(q('sales').onSnapshot(grab((o) => h.onSales && h.onSales('m' + mk, o)), err));
      sunsubs.push(q('expenses').onSnapshot(grab((o) => h.onExpenses && h.onExpenses('m' + mk, o)), err));
      if (mk === cur) sunsubs.push(q('stockReceipts').onSnapshot(grab((o) => h.onReceipts && h.onReceipts(o)), err));
    });
  };
  C.addExpense = async function (id, doc) { await dbReady; return db.doc('expenses/' + id).set(doc); };
  C.deleteExpense = async function (id) { await dbReady; return db.doc('expenses/' + id).delete(); };
  const _stop = C.stopSession;
  C.stopSession = function () { _stop(); C.stopSales(); };

  /* ── helpers for the staff screen ───────────────────────── */
  C.makeCode = function (name, taken) {         // 3-letter attendant code for receipt numbers: Grace -> GRC
    const w = String(name || '').toUpperCase().replace(/[^A-Z\s]/g, '').trim().split(/\s+/)[0] || 'STF';
    let c = (w[0] + w.slice(1).replace(/[AEIOU]/g, '') + w.slice(1) + 'XX').slice(0, 3);
    const used = new Set(taken || []);
    for (let n = 2; used.has(c) && n < 10; n++) c = c.slice(0, 2) + n;
    return c;
  };
  C.shops = SHOPS;
})();
