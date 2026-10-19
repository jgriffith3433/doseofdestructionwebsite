/* Hawkes Analytics: the player analytics SDK every Hawkes product's pages load (Hawkes Gen, docs/analytics.md).
 *
 *   <script src="https://gen.hawkesgen.com/sdk/analytics@1.js" data-product="sickofit" data-build="1.4.2" defer></script>
 *   or: import './hawkes-analytics.js'; window.hawkesAnalytics.init({ product: 'sickofit' })   (hawkes-analytics.mjs)
 *
 * No dependencies, never throws into the game, never blocks it. Page views, sessions, active time, device, load
 * timings, errors, fps, outbound links, rage clicks and an exit snapshot are captured without game code; the game
 * adds track(), screen(), setContext(), levelStart()/levelEnd(), death(), feedback(), ask() and friends.
 * Events go out in batches (every 5 s or 20 events) with sendBeacon; what can't be sent waits in localStorage.
 * No cookies, no fingerprinting: an anonymous random id in localStorage. hawkesAnalytics.optOut() stops everything.
 */
(function () {
  'use strict';
  var ANALYTICS_VERSION = 1;
  var w = typeof window !== 'undefined' ? window : null;
  var METHODS = ['init', 'config', 'track', 'screen', 'setContext', 'loadStart', 'ready', 'levelStart', 'levelEnd', 'death', 'choice', 'feature', 'video', 'feedback', 'error', 'ask', 'optOut', 'optIn', 'internal', 'flush'];
  if (!w || !w.document) {
    // Server-side rendering, workers, Node: a do-nothing stand-in so imports never fail.
    var stub = { version: ANALYTICS_VERSION, debugLog: [] };
    METHODS.forEach(function (m) { stub[m] = function () {}; });
    if (typeof globalThis !== 'undefined' && !globalThis.hawkesAnalytics) globalThis.hawkesAnalytics = stub;
    return;
  }
  if (w.hawkesAnalytics && w.hawkesAnalytics.version) return; // loaded twice

  var doc = w.document, nav = w.navigator || {}, loc = w.location;
  var ENDPOINT = 'https://gen.hawkesgen.com/v1/analytics/collect';
  var SESSION_IDLE = 30 * 60e3; // 30 minutes without activity ends a session
  var ACTIVE_IDLE = 60e3; // active time stops 60 s after the last input
  var FLUSH_MS = 5e3, FLUSH_AT = 20, MAX_BATCH = 200, MAX_BYTES = 60000;
  var OUTBOX_MAX = 40, OUTBOX_BYTES = 300000, BUFFER_MAX = 500;
  var ASK_SNOOZE = 7 * 864e5;
  var EVENT_NAME = /^[a-z][a-z0-9_]{1,39}$/;

  // ------------------------------------------------------------------ small helpers (none of them throw)
  function now() { return Date.now(); }
  function store(kind) { try { var s = w[kind]; s.getItem('hawkes.x'); return s; } catch (e) { return null; } }
  var ls = store('localStorage'), ss = store('sessionStorage');
  function get(s, k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function set(s, k, v) { try { if (s) { if (v == null) s.removeItem(k); else s.setItem(k, v); } } catch (e) { /* full or blocked */ } }
  function getJson(s, k) { try { return JSON.parse(get(s, k) || 'null'); } catch (e) { return null; } }
  function rid(prefix) {
    var a = 'abcdefghijklmnopqrstuvwxyz0123456789', out = prefix, bytes = null;
    try { bytes = w.crypto.getRandomValues(new Uint8Array(16)); } catch (e) { /* old browser */ }
    for (var i = 0; i < 16; i++) out += a[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % 36];
    return out;
  }
  function param(k) { try { return new URLSearchParams(loc.search).get(k); } catch (e) { return null; } }
  function assign(to) { for (var i = 1; i < arguments.length; i++) { var f = arguments[i]; if (f && typeof f === 'object') for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k)) to[k] = f[k]; } return to; }
  function plain(v) { return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'; }
  function str(v, n) { return v == null ? undefined : String(v).slice(0, n); }
  function hostPath(href) { try { var u = new URL(href, loc.href); return u.host + u.pathname; } catch (e) { return undefined; } }
  function quantile(xs, q) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : undefined; }
  function on(t, ev, fn, opt) { try { t.addEventListener(ev, fn, opt || { passive: true }); } catch (e) { /* no target */ } }
  function visible() { return doc.visibilityState !== 'hidden'; }

  // ------------------------------------------------------------------ config
  var script = doc.currentScript || doc.querySelector('script[data-product][src*="analytics"]');
  var attr = function (k) { return script && script.getAttribute ? script.getAttribute(k) : null; };
  var cfg = { product: attr('data-product'), endpoint: attr('data-endpoint') || ENDPOINT, build: attr('data-build'), debug: attr('data-debug') === '1' || param('hawkes-analytics-debug') === '1' };
  function build() {
    var b = w.HAWKES_BUILD || cfg.build; // the page's HAWKES_BUILD wins (the Unity bridge only gives a default)
    if (!b) return undefined;
    if (typeof b !== 'object') return { version: str(b, 40) };
    return { version: str(b.version, 40), commit: str(b.commit, 40), date: str(b.date, 40) };
  }
  function envOf(host, path) {
    host = String(host || '').toLowerCase();
    if (!host || host === 'localhost' || /^127\./.test(host) || host === '[::1]' || /\.local$/.test(host) || /^(10|192\.168)\./.test(host)) return 'local';
    if (/\.hawkesgen\.com$/.test(host)) return /^\/c\//.test(path || '') ? 'preview' : 'beta';
    return 'live';
  }

  // ------------------------------------------------------------------ identity and flags
  if (param('hawkes-internal') === '1') set(ls, 'hawkes.internal', '1');
  if (param('hawkes-internal') === '0') set(ls, 'hawkes.internal', null);
  var optedOut = get(ls, 'hawkes.optout') === '1';
  var anon = get(ls, 'hawkes.anon');
  var returning = !!anon;
  if (!anon || !/^[A-Za-z0-9_-]{8,64}$/.test(anon)) { anon = rid('a_'); set(ls, 'hawkes.anon', anon); }
  if (!get(ls, 'hawkes.first')) set(ls, 'hawkes.first', new Date().toISOString().slice(0, 10));
  var playtestParam = !!(param('playtest') || param('hawkesPlaytest') != null || get(ss, 'hawkes.playtest'));
  if (playtestParam) set(ss, 'hawkes.playtest', '1');
  function flags() {
    // Only the playtest runner calls hawkesPlaytest.start(): once it has, this tab is the bot's.
    try {
      var pt = w.hawkesPlaytest;
      if (pt && typeof pt.start === 'function' && !pt.start.hawkesWrapped) {
        var orig = pt.start;
        pt.start = function () { playtestParam = true; set(ss, 'hawkes.playtest', '1'); return orig.apply(this, arguments); };
        pt.start.hawkesWrapped = true;
      }
    } catch (e) { /* a frozen object */ }
    return { webdriver: !!nav.webdriver, playtest: playtestParam, internal: get(ls, 'hawkes.internal') === '1' };
  }

  // ------------------------------------------------------------------ device
  var gpu = get(ss, 'hawkes.gpu');
  function device() {
    var sc = w.screen || {}, conn = nav.connection || {}, tz;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* no Intl */ }
    return {
      screen: sc.width && sc.height ? sc.width + 'x' + sc.height : undefined,
      viewport: w.innerWidth ? w.innerWidth + 'x' + w.innerHeight : undefined,
      dpr: w.devicePixelRatio || 1, lang: str(nav.language, 35), tz: tz, touch: nav.maxTouchPoints || 0,
      conn: conn.effectiveType, cores: nav.hardwareConcurrency, mem: nav.deviceMemory, gpu: gpu || undefined,
    };
  }
  function readGpu() {
    if (gpu) return;
    try {
      var c = doc.createElement('canvas'), gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return;
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = str(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), 120) || null;
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      set(ss, 'hawkes.gpu', gpu);
    } catch (e) { /* no WebGL */ }
  }

  // ------------------------------------------------------------------ session and active time
  // The session lives in sessionStorage (a new tab is a new session; a reload is not), keyed by its last activity.
  var sess = null, lastInput = now(), lastTick = now(), entryNext = true, shown = visible();
  function newSession(t) {
    var u = {};
    ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (k) { var v = param('utm_' + k); if (v) u[k] = v.slice(0, 100); });
    var ref = doc.referrer && hostPath(doc.referrer);
    if (ref && ref.split('/')[0] === loc.host) ref = undefined; // same-site referrers count as direct
    sess = { id: rid('s_'), seq: 0, start: t, last: t, active: 0, entry: { referrer: ref, landing: loc.pathname, utm: u } };
    var visits = (Number(get(ls, 'hawkes.visits')) || 0) + 1;
    set(ls, 'hawkes.visits', String(visits));
    entryNext = true;
    save();
    emit('session_start', { returning: returning, visits: visits, first_seen: get(ls, 'hawkes.first'), device: device() });
    returning = true;
  }
  function save() { if (sess) set(ss, 'hawkes.session', JSON.stringify(sess)); }
  function accrue() {
    // Active time: visible and an input in the last 60 s.
    var t = now();
    if (sess && shown) sess.active += Math.max(0, Math.min(t, lastInput + ACTIVE_IDLE) - lastTick);
    lastTick = t;
    return t;
  }
  function activeSec() { accrue(); return sess ? Math.round(sess.active / 1000) : 0; }
  function touchSession(t) {
    // 30 minutes without activity end the session: close it and start a new one.
    if (sess && t - sess.last > SESSION_IDLE) {
      emit('session_end', { active: Math.round(sess.active / 1000), reason: 'idle' }, sess.last);
      flush();
      newSession(t);
    }
    if (sess) sess.last = t;
  }
  function input() {
    if (optedOut) return;
    var t = accrue();
    touchSession(t);
    lastInput = t;
  }

  // ------------------------------------------------------------------ events and the queue
  var queue = [], recent = [], ctx = {}, screenName, timer = null;
  var api = { version: ANALYTICS_VERSION, debugLog: [] };
  function emit(name, props, t) {
    if (optedOut || !sess) return;
    t = t || now();
    accrue();
    var e = { name: name, seq: sess.seq++, t: t, active: Math.round(sess.active), page: loc.pathname, screen: screenName, ctx: assign({}, ctx) };
    if (props && typeof props === 'object') e.props = props;
    save();
    queue.push({ sid: sess.id, e: e });
    if (queue.length > BUFFER_MAX) queue.splice(0, queue.length - BUFFER_MAX);
    recent.push({ name: name, t: t, screen: screenName, level: ctx.level });
    if (recent.length > 20) recent.shift();
    if (cfg.debug) {
      api.debugLog.push(e);
      if (api.debugLog.length > 1000) api.debugLog.shift();
      try { console.log('[hawkes-analytics]', name, props || ''); } catch (x) { /* no console */ }
    }
    if (queue.length >= FLUSH_AT) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }
  function header(sid) {
    var h = { product: cfg.product, build: build(), env: envOf(loc.hostname, loc.pathname), anon: anon, session: sid, flags: flags(), device: device(), sdk: 'js/' + ANALYTICS_VERSION };
    if (entryNext && sid === sess.id) h.entry = sess.entry;
    return h;
  }
  function batches(items) {
    // One session per batch, at most 200 events and about 60 KB each.
    var out = [], head = null, cur = [], size = 0;
    var close = function () { if (cur.length) out.push(assign({}, head, { events: cur })); cur = []; };
    for (var i = 0; i < items.length; i++) {
      var n = JSON.stringify(items[i].e).length + 1;
      if (n > MAX_BYTES / 2) continue; // no event is this big (the server trims props to 16 KB anyway)
      if (!head || head.session !== items[i].sid || cur.length >= MAX_BATCH || size + n > MAX_BYTES) {
        close();
        head = header(items[i].sid);
        size = JSON.stringify(head).length + 20;
      }
      cur.push(items[i].e);
      size += n;
    }
    close();
    return out;
  }
  function deliver(body) {
    if (nav.onLine === false) return outbox(body);
    var sent = false;
    try { sent = !!(nav.sendBeacon && nav.sendBeacon(cfg.endpoint, body)); } catch (e) { sent = false; }
    if (sent) return;
    try {
      w.fetch(cfg.endpoint, { method: 'POST', body: body, keepalive: body.length < 60000, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, credentials: 'omit' })
        .then(function (r) { if (r.status >= 500) outbox(body); }, function () { outbox(body); });
    } catch (e) { outbox(body); }
  }
  function outbox(body) {
    var box = getJson(ls, 'hawkes.outbox') || [];
    box.push(body);
    var total = 0;
    for (var i = box.length - 1; i >= 0; i--) { total += box[i].length; if (total > OUTBOX_BYTES || box.length - i > OUTBOX_MAX) { box = box.slice(i + 1); break; } }
    set(ls, 'hawkes.outbox', JSON.stringify(box));
  }
  function retryOutbox() {
    if (optedOut || nav.onLine === false) return;
    var box = getJson(ls, 'hawkes.outbox');
    if (!box || !box.length) return;
    set(ls, 'hawkes.outbox', null);
    for (var i = 0; i < box.length; i++) if (typeof box[i] === 'string') deliver(box[i]);
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (optedOut || !cfg.product || !queue.length || !sess) return;
    var list = batches(queue);
    queue = [];
    for (var i = 0; i < list.length; i++) {
      var body = JSON.stringify(list[i]);
      if (cfg.debug) for (var j = 0; j < list[i].events.length; j++) list[i].events[j].sent = now();
      deliver(body);
    }
    if (list.length) entryNext = false;
  }

  // ------------------------------------------------------------------ automatic capture
  var lastPath = null;
  function pageView() {
    if (loc.pathname === lastPath) return;
    lastPath = loc.pathname;
    emit('page_view', { title: str(doc.title, 120) || undefined });
  }
  function loadTimings() {
    try {
      var n = w.performance.getEntriesByType('navigation')[0];
      if (!n) return;
      var r = function (v) { return v > 0 ? Math.round(v) : undefined; };
      emit('page_load', { ttfb: r(n.responseStart), dom: r(n.domContentLoadedEventEnd), load: r(n.loadEventEnd), dns: r(n.domainLookupEnd - n.domainLookupStart), connect: r(n.connectEnd - n.connectStart), bytes: n.transferSize || undefined, type: n.type });
    } catch (e) { /* no navigation timing */ }
  }
  var seenErrors = {}, errorCount = 0;
  function reportError(message, stack, source, extra) {
    message = String(message || 'Error').slice(0, 1000);
    var key = message + '|' + String(stack || '').split('\n').slice(0, 2).join('|');
    if (seenErrors[key] || errorCount >= 25) return; // once per signature, at most 25 per page
    seenErrors[key] = 1;
    errorCount++;
    emit('error', assign({ message: message, stack: stack ? String(stack).slice(0, 4000) : undefined, source: source || 'window' }, extra));
  }
  var fps = { frames: 0, since: 0, samples: [], raf: null };
  function frame(t) {
    fps.raf = null;
    if (!visible()) { fps.since = 0; return; } // paused while hidden; visibilitychange restarts it
    if (!fps.since) { fps.since = t; fps.frames = 0; }
    fps.frames++;
    if (t - fps.since >= 1000) {
      fps.samples.push(fps.frames * 1000 / (t - fps.since));
      fps.since = t;
      fps.frames = 0;
      if (fps.samples.length >= 60) perfEvent();
    }
    startFps();
  }
  function startFps() { try { if (!fps.raf && w.requestAnimationFrame) fps.raf = w.requestAnimationFrame(frame); } catch (e) { /* none */ } }
  function perfEvent() {
    var xs = fps.samples;
    fps.samples = [];
    if (now() - lastInput > ACTIVE_IDLE) return; // a perf event per active minute
    var mem;
    try { mem = w.performance.memory ? Math.round(w.performance.memory.usedJSHeapSize / 1048576) : undefined; } catch (e) { /* none */ }
    emit('perf', { fps: Math.round(quantile(xs, 0.5)), fps_p10: Math.round(quantile(xs, 0.1)), memory: mem });
  }
  var clicks = [];
  function click(e) {
    input();
    try {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (a && /^https?:/.test(a.href) && new URL(a.href).host !== loc.host) emit('outbound', { url: hostPath(a.href), text: str((a.textContent || '').trim(), 60) || undefined });
      // Rage clicks: three or more clicks within a second in the same small spot.
      var t = now();
      clicks = clicks.filter(function (c) { return t - c.t < 1000 && Math.abs(c.x - e.clientX) < 30 && Math.abs(c.y - e.clientY) < 30; });
      clicks.push({ t: t, x: e.clientX, y: e.clientY });
      if (clicks.length === 3) {
        var el = e.target || {};
        emit('rage_click', { x: Math.round(e.clientX), y: Math.round(e.clientY), target: str((el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : ''), 80) });
      }
    } catch (x) { /* odd target */ }
  }
  function playtestState() {
    try {
      var st = w.hawkesPlaytest && w.hawkesPlaytest.state && w.hawkesPlaytest.state();
      if (!st || typeof st !== 'object') return undefined;
      if (JSON.stringify(st).length <= 12000) return st;
      var out = { _trimmed: true };
      for (var k in st) if (plain(st[k])) out[k] = typeof st[k] === 'string' ? st[k].slice(0, 200) : st[k];
      return out;
    } catch (e) { return undefined; }
  }
  var exited = false;
  function exit() {
    // The page hides or goes away: what the player last did, the game's state, then send it all.
    if (exited || optedOut || !sess) return;
    exited = true;
    var a = activeSec();
    emit('exit', { recent: recent.slice(), state: playtestState(), active: a });
    emit('session_end', { active: a });
    flush();
  }
  function visibility() {
    accrue();
    shown = visible();
    if (!shown) return exit();
    exited = false;
    lastInput = now(); // coming back to the tab counts as activity
    touchSession(lastInput);
    startFps();
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    var saved = getJson(ss, 'hawkes.session');
    if (saved && saved.id && now() - saved.last <= SESSION_IDLE) { sess = saved; entryNext = true; } else if (!optedOut) newSession(now());
    pageView();
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) { on(w, ev, input, { passive: true, capture: true }); });
    var moved = 0;
    on(w, 'mousemove', function () { var t = now(); if (t - moved > 2000) { moved = t; input(); } });
    on(doc, 'click', click, { passive: true, capture: true });
    on(doc, 'visibilitychange', visibility);
    on(w, 'pagehide', exit);
    on(w, 'pageshow', function (e) { if (e.persisted) visibility(); });
    on(w, 'online', retryOutbox);
    on(w, 'error', function (e) {
      var t = e.target;
      if (t && t !== w && (t.src || t.href)) return reportError('Failed to load ' + hostPath(t.src || t.href), null, 'asset', { tag: str(t.tagName, 20) });
      reportError(e.message, e.error && e.error.stack, 'window', { file: hostPath(e.filename || ''), line: e.lineno || undefined });
    }, { capture: true });
    on(w, 'unhandledrejection', function (e) { var r = e.reason; reportError(r && r.message || r, r && r.stack, 'promise'); });
    // SPA route changes.
    ['pushState', 'replaceState'].forEach(function (k) {
      try {
        var orig = w.history[k];
        w.history[k] = function () { var r = orig.apply(this, arguments); try { pageView(); } catch (e) { /* never break navigation */ } return r; };
      } catch (e) { /* frozen history */ }
    });
    on(w, 'popstate', pageView);
    on(w, 'hashchange', pageView);
    var later = function () { readGpu(); loadTimings(); retryOutbox(); };
    if (doc.readyState === 'complete') setTimeout(later, 1000); else on(w, 'load', function () { setTimeout(later, 1000); });
    startFps();
  }

  // ------------------------------------------------------------------ the game's API
  var loadT = null, isReady = false, levels = {};
  var levelKey = function (l) { l = l == null ? ctx.level : l; return l == null ? '' : String(l).slice(0, 100); };
  var fns = {
    init: function (o) {
      o = o || {};
      if (o.product) cfg.product = String(o.product);
      if (o.endpoint) cfg.endpoint = String(o.endpoint);
      if (o.build) cfg.build = o.build;
      if (o.debug != null) cfg.debug = !!o.debug;
      if (o.context) assign(ctx, o.context);
      start();
      flush();
    },
    config: function () { return { product: cfg.product, endpoint: cfg.endpoint, build: build(), debug: cfg.debug, env: envOf(loc.hostname, loc.pathname), anon: anon, session: sess && sess.id, optedOut: optedOut, flags: flags() }; },
    track: function (name, props) {
      name = String(name || '');
      if (!EVENT_NAME.test(name)) { if (cfg.debug) console.warn('[hawkes-analytics] bad event name', name); return; }
      touchSession(now());
      emit(name, props && typeof props === 'object' ? assign({}, props) : undefined);
    },
    screen: function (name) { screenName = str(name, 60); fns.track('screen', { name: screenName }); },
    setContext: function (o) {
      for (var k in o || {}) { if (o[k] == null) delete ctx[k]; else if (plain(o[k])) ctx[k] = typeof o[k] === 'string' ? o[k].slice(0, 100) : o[k]; }
    },
    loadStart: function () { loadT = now(); fns.track('game_load_start'); },
    ready: function (props) {
      if (isReady) return;
      isReady = true;
      var ms = loadT ? now() - loadT : (w.performance && w.performance.now ? w.performance.now() : undefined);
      fns.track('game_ready', assign({ ms: ms != null ? Math.round(ms) : undefined, since: loadT ? 'load_start' : 'navigation' }, props));
    },
    levelStart: function (level, props) {
      var k = levelKey(level), prev = levels[k];
      levels[k] = { t: now(), deaths: 0, attempt: (prev ? prev.attempt : 0) + 1 };
      if (level != null) fns.setContext({ level: String(level) });
      fns.track('level_start', assign({ level: k, attempt: levels[k].attempt }, props));
    },
    levelEnd: function (level, result, props) {
      var k = levelKey(level), l = levels[k];
      fns.track('level_end', assign({ level: k, result: result || 'complete', duration: l && l.t ? Math.round((now() - l.t) / 100) / 10 : undefined, deaths: l ? l.deaths : 0 }, props));
      if (l) { l.t = 0; l.deaths = 0; }
    },
    death: function (cause, props) {
      var l = levels[levelKey()];
      if (l && l.t) l.deaths++;
      fns.track('death', assign({ cause: str(cause, 80) }, props));
    },
    choice: function (node, option, props) { fns.track('choice', assign({ node: str(node, 100), option: str(option, 100) }, props)); },
    feature: function (name, props) { fns.track('feature', assign({ name: str(name, 100) }, props)); },
    video: function (id, action, at, props) { fns.track('video', assign({ id: str(id, 100), action: action, at: at != null ? Math.round(Number(at) * 10) / 10 : undefined }, props)); },
    feedback: function (o) { o = o || {}; fns.track('feedback', assign({}, o, { rating: o.rating, text: str(o.text, 2000), context: str(o.context, 200) })); },
    error: function (err, source, props) { reportError(err && err.message || err, err && err.stack, source || 'game', props); },
    ask: function (o) { return ask(o); },
    optOut: function () { optedOut = true; queue = []; set(ls, 'hawkes.optout', '1'); set(ls, 'hawkes.outbox', null); set(ss, 'hawkes.session', null); },
    optIn: function () { var was = optedOut; optedOut = false; set(ls, 'hawkes.optout', null); if (was && started) newSession(now()); else start(); },
    internal: function (on) { set(ls, 'hawkes.internal', on === false ? null : '1'); },
    flush: function () { flush(); },
  };
  METHODS.forEach(function (m) {
    api[m] = function () {
      try { return fns[m].apply(null, arguments); } catch (e) { if (cfg.debug) try { console.warn('[hawkes-analytics]', m, e); } catch (x) { /* none */ } }
      return m === 'ask' ? Promise.resolve(null) : undefined;
    };
  });

  // ------------------------------------------------------------------ the feedback card: ask({ id, question, kind, comment })
  function ask(o) {
    o = o || {};
    var id = String(o.id || o.question || 'feedback').slice(0, 80);
    var shown = getJson(ss, 'hawkes.asked') || [], snoozed = getJson(ls, 'hawkes.askSnoozed') || {};
    if (optedOut || shown.indexOf(id) >= 0 || (snoozed[id] && now() - snoozed[id] < ASK_SNOOZE) || !doc.body) return Promise.resolve(null);
    shown.push(id);
    set(ss, 'hawkes.asked', JSON.stringify(shown));
    var th = assign({ background: '#1d1f24', color: '#f3f3f3', accent: '#f2b33d', font: 'system-ui, sans-serif', radius: '12px' }, o.theme);
    var stars = o.kind === 'stars';
    return new Promise(function (resolve) {
      var host = doc.createElement('div');
      host.setAttribute('data-hawkes-ask', id);
      var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      var css = ':host{all:initial}.ha-c{position:fixed;z-index:2147483000;right:16px;bottom:16px;max-width:min(340px,calc(100vw - 32px));box-sizing:border-box;' +
        'background:' + th.background + ';color:' + th.color + ';font:15px/1.4 ' + th.font + ';border-radius:' + th.radius + ';padding:14px 16px;box-shadow:0 6px 24px rgba(0,0,0,.35)}' +
        '.ha-q{margin:0 28px 10px 0}.ha-r{display:flex;gap:8px;flex-wrap:wrap}.ha-c button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:8px;min-width:44px;min-height:44px;cursor:pointer;opacity:.85}' +
        '.ha-c button:hover,.ha-c button:focus-visible{opacity:1;outline:2px solid ' + th.accent + ';outline-offset:1px}.ha-c button.ha-on{background:' + th.accent + ';color:#000;border-color:' + th.accent + '}' +
        '.ha-c .ha-x{position:absolute;top:6px;right:6px;border:0;min-width:36px;min-height:36px;font-size:20px}.ha-c textarea{box-sizing:border-box;width:100%;margin-top:10px;min-height:64px;font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:8px}' +
        '.ha-s{margin-top:8px;display:flex;justify-content:flex-end;gap:8px}.ha-s button{padding:0 14px}';
      var card = '<style>' + css + '</style><div class="ha-c" role="dialog" aria-label="Feedback"><p class="ha-q"></p><button class="ha-x" aria-label="Close">×</button><div class="ha-r"></div></div>';
      root.innerHTML = card;
      var box = root.querySelector('.ha-c'), row = root.querySelector('.ha-r');
      root.querySelector('.ha-q').textContent = String(o.question || 'How was that?').slice(0, 200);
      var rating = null, done = false, close = function (result) {
        if (done) return;
        done = true;
        try { host.remove(); } catch (e) { /* gone */ }
        resolve(result);
      };
      var dismiss = function () {
        snoozed = getJson(ls, 'hawkes.askSnoozed') || {};
        snoozed[id] = now();
        set(ls, 'hawkes.askSnoozed', JSON.stringify(snoozed));
        close(null);
      };
      var sendIt = function (text) {
        var r = { id: id, rating: rating, text: text || undefined, context: o.context };
        fns.feedback(r);
        box.innerHTML = '<p class="ha-q" role="status">' + (o.thanks || 'Thanks!').replace(/</g, '&lt;') + '</p>';
        setTimeout(function () { close(r); }, 1200);
      };
      var choose = function (v, b) {
        rating = v;
        [].forEach.call(row.querySelectorAll('button'), function (x, i) { x.className = (stars ? i < v : x === b) ? 'ha-on' : ''; });
        if (!o.comment) return sendIt();
        if (root.querySelector('textarea')) return;
        var ta = doc.createElement('textarea'), s = doc.createElement('div'), skip = doc.createElement('button'), go = doc.createElement('button');
        ta.setAttribute('aria-label', 'Comment (optional)');
        ta.placeholder = o.placeholder || 'Anything to add? (optional)';
        ta.maxLength = 2000;
        s.className = 'ha-s';
        skip.textContent = 'Skip';
        go.textContent = 'Send';
        skip.onclick = function () { sendIt(); };
        go.onclick = function () { sendIt(ta.value.trim()); };
        s.appendChild(skip);
        s.appendChild(go);
        box.appendChild(ta);
        box.appendChild(s);
        ta.focus();
      };
      var opts = stars ? [1, 2, 3, 4, 5] : ['up', 'down'];
      opts.forEach(function (v) {
        var b = doc.createElement('button');
        b.textContent = stars ? '★' : v === 'up' ? '👍' : '👎';
        b.setAttribute('aria-label', stars ? v + (v === 1 ? ' star' : ' stars') : v === 'up' ? 'Thumbs up' : 'Thumbs down');
        b.onclick = function () { choose(v, b); };
        row.appendChild(b);
      });
      root.querySelector('.ha-x').onclick = dismiss;
      // Keys typed in the card are the card's, not the game's.
      ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
        host.addEventListener(ev, function (e) { e.stopPropagation(); if (ev === 'keydown' && e.key === 'Escape') dismiss(); });
      });
      doc.body.appendChild(host);
      try { row.querySelector('button').focus({ preventScroll: true }); } catch (e) { /* no focus */ }
    });
  }

  // ------------------------------------------------------------------ go
  w.hawkesAnalytics = api;
  try { start(); } catch (e) { /* never break the page */ } // capture from load; batches wait for a product
  // Calls made before the SDK loaded (the Unity bridge queues them here): [method, ...args].
  var early = w.hawkesAnalyticsQ;
  w.hawkesAnalyticsQ = [];
  if (early && early.length) for (var i = 0; i < early.length; i++) { var c = early[i]; if (c && api[c[0]]) api[c[0]].apply(null, c.slice(1)); }
})();
