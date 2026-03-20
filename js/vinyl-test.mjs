/**
 * vinyl-test.mjs — Headless validation for vinyl.js v2.0.0
 *
 * Exercises vlog/vmark, persistence, phase-machine, broadcast,
 * and crate-v2 pathways via a minimal DOM shim.
 * No external dependencies — runs on bare Node.js.
 *
 * Usage: node vinyl-test.mjs
 */

import { readFileSync } from 'fs';

// ═══════════════════════════════════════════════════════════════
//  MINIMAL DOM + BROWSER SHIM
// ═══════════════════════════════════════════════════════════════

class Element {
  constructor(tag, id) {
    this.tagName = tag;
    this.id = id || '';
    this.children = [];
    this.attributes = {};
    this.hidden = false;
    this.src = '';
    this.value = '40';
    this.textContent = '';
    this.innerHTML = '';
    this.classList = new ClassList();
    this.title = '';
    this.style = {};
    this.className = '';
    this._listeners = {};
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] || null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  querySelector(sel) {
    // Search children by class name
    if (sel.startsWith('.')) {
      var cls = sel.slice(1);
      for (var i = 0; i < this.children.length; i++) {
        if (this.children[i].classList && this.children[i].classList.contains(cls)) {
          return this.children[i];
        }
      }
    }
    // Fallback stub for icon queries
    return new Element('svg');
  }
  querySelectorAll() { return []; }
  contains() { return false; }
  scrollIntoView() {}
  remove() {}
  focus() {}
  click() {
    if (this._listeners.click) {
      this._listeners.click.forEach(fn => fn({ stopPropagation() {}, preventDefault() {} }));
    }
  }
  appendChild(child) { this.children.push(child); }
  get offsetHeight() { return 0; }
}

class ClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  toggle(c, force) {
    if (force === undefined) force = !this._set.has(c);
    force ? this._set.add(c) : this._set.delete(c);
  }
  contains(c) { return this._set.has(c); }
}

function createDocument() {
  const elements = {};
  const docListeners = {};
  const htmlAttrs = {};
  const htmlListeners = {};

  const doc = {
    readyState: 'complete',
    documentElement: {
      getAttribute(k) { return htmlAttrs[k] || null; },
      setAttribute(k, v) {
        htmlAttrs[k] = v;
        // Fire MutationObserver callbacks
        if (doc._mutObservers) {
          doc._mutObservers.forEach(({ cb }) => {
            cb([{ attributeName: k }]);
          });
        }
      },
      removeAttribute(k) { delete htmlAttrs[k]; },
      _listeners: htmlListeners,
    },
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return new Element(tag); },
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    visibilityState: 'visible',
    activeElement: null,
    head: { appendChild() {} },
    body: { appendChild() {} },
    _mutObservers: [],
    _elements: elements,
    _htmlAttrs: htmlAttrs,
    _docListeners: docListeners,
  };

  return doc;
}

function buildStage(doc) {
  const ids = ['vinyl', 'vinylSource', 'vinylTitle', 'vinylSpin', 'vinylHush', 'vinylDial', 'vinylLatch', 'vinylCrate'];
  ids.forEach(id => {
    const el = new Element('div', id);
    if (id === 'vinylTitle') el.textContent = 'Loading\u2026';
    if (id === 'vinylDial') el.value = '40';
    if (id === 'vinylCrate') el.hidden = true;
    doc._elements[id] = el;
  });
  // Add marquee as child of stage for querySelector('.vinyl-marquee')
  const marquee = new Element('div');
  marquee.classList.add('vinyl-marquee');
  doc._elements['vinyl'].children.push(marquee);
}

function createSessionStorage() {
  const store = {};
  return {
    getItem(k) { return store[k] || null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    clear() { Object.keys(store).forEach(k => delete store[k]); },
  };
}

function createPerformance() {
  const marks = [];
  return {
    marks,
    mark(name) { marks.push({ name, ts: Date.now() }); },
  };
}

// ═══════════════════════════════════════════════════════════════
//  CONSOLE INTERCEPTOR
// ═══════════════════════════════════════════════════════════════

function createConsoleCapture() {
  const captured = { warn: [], log: [], debug: [] };
  return {
    captured,
    warn(...args)  { captured.warn.push(args); },
    log(...args)   { captured.log.push(args); },
    debug(...args) { captured.debug.push(args); },
  };
}

function findCaptured(captured, channel, substr) {
  return captured[channel].filter(args =>
    args.some(a => typeof a === 'string' && a.includes(substr))
  );
}

// ═══════════════════════════════════════════════════════════════
//  MOCK BroadcastChannel
// ═══════════════════════════════════════════════════════════════

function createMockBroadcastChannel() {
  const instances = [];

  function MockBC(name) {
    this.name = name;
    this.onmessage = null;
    this._messages = [];
    this._closed = false;
    instances.push(this);
  }
  MockBC.prototype.postMessage = function (msg) {
    if (this._closed) return;
    this._messages.push(JSON.parse(JSON.stringify(msg)));
  };
  MockBC.prototype.close = function () {
    this._closed = true;
  };

  // Simulate a message arriving from "another tab"
  function simulateRemote(msg) {
    instances.forEach(ch => {
      if (ch.onmessage && !ch._closed) ch.onmessage({ data: msg });
    });
  }

  return { MockBC, instances, simulateRemote };
}

// ═══════════════════════════════════════════════════════════════
//  MOCK SC.Widget
// ═══════════════════════════════════════════════════════════════

function createMockWidget(opts = {}) {
  const handlers = {};
  return {
    bind(event, fn) { handlers[event] = fn; },
    play() {},
    pause() {},
    skip() {},
    seekTo() {},
    setVolume() {},
    getSounds(cb) {
      if (opts.empty) return cb([]);
      cb([
        { title: 'Track A', duration: 180000 },
        { title: 'Track B', duration: 210000 },
        { title: 'Track C', duration: 195000 },
      ]);
    },
    getCurrentSoundIndex(cb) { cb(0); },
    _fire(event, data) { if (handlers[event]) handlers[event](data); },
  };
}

// ═══════════════════════════════════════════════════════════════
//  VINYL.JS LOADER — rewrites source and executes in sandbox
// ═══════════════════════════════════════════════════════════════

const vinylSrc = readFileSync(new URL('./vinyl.js', import.meta.url), 'utf-8');

function execVinyl({ logLevel = 3, featureObs = true, featureSM = true, featureBroadcast = true, featureCrateV2 = true, featureLeaderElection = true, mockSdkSuccess = true, syncTimers = false, ownerStale = null } = {}) {
  let src = vinylSrc;

  // Inject LOG_LEVEL
  src = src.replace(
    /var LOG_LEVEL = \(function \(\)[\s\S]*?\}\)\(\);/,
    `var LOG_LEVEL = ${logLevel};`
  );

  // Override FEATURE_OBSERVABILITY if needed
  if (!featureObs) {
    src = src.replace('var FEATURE_OBSERVABILITY = true;', 'var FEATURE_OBSERVABILITY = false;');
    src = src.replace(/var LOG_LEVEL = \d+;/, 'var LOG_LEVEL = 0;');
  }

  // Override FEATURE_STATE_MACHINE if needed
  if (!featureSM) {
    src = src.replace('var FEATURE_STATE_MACHINE = true;', 'var FEATURE_STATE_MACHINE = false;');
  }

  // Override FEATURE_BROADCAST if needed
  if (!featureBroadcast) {
    src = src.replace('var FEATURE_BROADCAST = true;', 'var FEATURE_BROADCAST = false;');
  }

  // Override FEATURE_CRATE_V2 if needed
  if (!featureCrateV2) {
    src = src.replace('var FEATURE_CRATE_V2 = true;', 'var FEATURE_CRATE_V2 = false;');
  }

  // Override FEATURE_LEADER_ELECTION if needed
  if (!featureLeaderElection) {
    src = src.replace('var FEATURE_LEADER_ELECTION = true;', 'var FEATURE_LEADER_ELECTION = false;');
  }

  // Override OWNER_STALE for stale-owner tests (e.g., set to 1ms)
  if (ownerStale !== null) {
    src = src.replace(/var OWNER_STALE\s*=\s*\d+;/, 'var OWNER_STALE = ' + ownerStale + ';');
  }

  // Mock SDK loading — intercept document.head.appendChild
  src = src.replace(
    'document.head.appendChild(s);',
    'if (__mockSdkSuccess) { s.onload(); } else { s.onerror(); }'
  );

  // Build isolated environment
  const doc = createDocument();
  buildStage(doc);
  const ss = createSessionStorage();
  const perf = createPerformance();
  const cons = createConsoleCapture();
  let mockWidget = createMockWidget({ empty: false });
  const bc = createMockBroadcastChannel();

  // v2.1.0: track timers for heartbeat/election verification
  const _intervals = [];
  const _timeouts = [];

  const win = {
    document: doc,
    sessionStorage: ss,
    performance: perf,
    console: cons,
    location: { search: '' },
    SC: {
      Widget: function() { return mockWidget; },
    },
    MutationObserver: class {
      constructor(cb) { this._cb = cb; }
      observe() { doc._mutObservers.push({ cb: this._cb }); }
    },
    BroadcastChannel: bc.MockBC,
    addEventListener() {},
    setTimeout: syncTimers
      ? function (fn) { fn(); return 0; }
      : function (fn, delay) { var id = globalThis.setTimeout(fn, delay); _timeouts.push(id); return id; },
    clearTimeout: function (id) { globalThis.clearTimeout(id); },
    setInterval: function (fn, delay) { var id = globalThis.setInterval(fn, delay); _intervals.push(id); return id; },
    clearInterval: function (id) { globalThis.clearInterval(id); },
    __mockSdkSuccess: mockSdkSuccess,
  };
  win.SC.Widget.Events = {
    READY: 'ready', PLAY: 'play', PAUSE: 'pause',
    FINISH: 'finish', PLAY_PROGRESS: 'playProgress', ERROR: 'error',
  };
  win.window = win;

  // Execute vinyl.js in the sandbox
  const fn = new Function(
    'window', 'document', 'sessionStorage', 'performance', 'console',
    'location', 'MutationObserver', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', '__mockSdkSuccess',
    'SC', 'BroadcastChannel',
    src
  );

  return { doc, ss, perf, cons, win, mockWidget, exec, setMockWidget, bc, _intervals, _timeouts };

  function setMockWidget(opts) {
    mockWidget = createMockWidget(opts);
    win.SC.Widget = function() { return mockWidget; };
    win.SC.Widget.Events = {
      READY: 'ready', PLAY: 'play', PAUSE: 'pause',
      FINISH: 'finish', PLAY_PROGRESS: 'playProgress', ERROR: 'error',
    };
    return mockWidget;
  }

  function exec() {
    fn(win, doc, ss, perf, cons, win.location, win.MutationObserver,
       win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval,
       mockSdkSuccess, win.SC, win.BroadcastChannel);
    return mockWidget;
  }
}

// ═══════════════════════════════════════════════════════════════
//  TEST RUNNER
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n\x1b[90m── ${name} ──\x1b[0m`);
}

function assert(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    if (detail) console.log(`    \x1b[31m→ ${detail}\x1b[0m`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 1: Happy Path — Full Boot Sequence
// ═══════════════════════════════════════════════════════════════

suite('Happy Path — Boot Sequence (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  const logs = [...captured.log, ...captured.debug].map(a => a[0] || '').filter(s => s.includes('[vinyl]'));

  assert('stage:raise emitted', findCaptured(captured, 'log', 'stage:raise').length > 0);
  assert('sdk:loaded emitted', findCaptured(captured, 'log', 'sdk:loaded').length > 0);
  assert('widget:ready emitted', findCaptured(captured, 'log', 'widget:ready').length > 0);
  assert('catalog:fetched emitted', findCaptured(captured, 'log', 'catalog:fetched').length > 0);

  // Payload fidelity
  const catLogs = findCaptured(captured, 'log', 'catalog:fetched');
  const hasTracks = catLogs.length > 0 && catLogs[0].some(a => typeof a === 'object' && a?.tracks === 3);
  assert('catalog:fetched payload = { tracks: 3 }', hasTracks);

  // Ordering
  const si = logs.findIndex(s => s.includes('stage:raise'));
  const ki = logs.findIndex(s => s.includes('sdk:loaded'));
  const ri = logs.findIndex(s => s.includes('widget:ready'));
  const ci = logs.findIndex(s => s.includes('catalog:fetched'));
  assert('order: stage → sdk → ready → catalog', si < ki && ki < ri && ri < ci,
    `indices: ${si}, ${ki}, ${ri}, ${ci}`);

  // Performance marks
  const marks = env.perf.marks.map(m => m.name);
  assert('vmark stage:raise', marks.includes('vinyl:stage:raise'));
  assert('vmark sdk:loaded', marks.includes('vinyl:sdk:loaded'));
  assert('vmark widget:ready', marks.includes('vinyl:widget:ready'));
  assert('vmark catalog:done', marks.includes('vinyl:catalog:done'));

  const ms = marks.indexOf('vinyl:stage:raise');
  const mk = marks.indexOf('vinyl:sdk:loaded');
  const mr = marks.indexOf('vinyl:widget:ready');
  const mc = marks.indexOf('vinyl:catalog:done');
  assert('marks ordered: stage → sdk → ready → catalog',
    ms < mk && mk < mr && mr < mc,
    `indices: ${ms}, ${mk}, ${mr}, ${mc}`);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 2: Shelf Cache Hit
// ═══════════════════════════════════════════════════════════════

suite('Shelf Cache Hit (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    ts: Date.now(), v: 1, data: [{ title: 'C1', index: 0 }, { title: 'C2', index: 1 }]
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('catalog:shelf-hit emitted (debug)', findCaptured(captured, 'debug', 'catalog:shelf-hit').length > 0);
  const shelfLogs = findCaptured(captured, 'debug', 'catalog:shelf-hit');
  const hasCnt = shelfLogs.length > 0 && shelfLogs[0].some(a => typeof a === 'object' && a?.tracks === 2);
  assert('shelf-hit payload = { tracks: 2 }', hasCnt);
  assert('catalog:fetched NOT emitted', findCaptured(captured, 'log', 'catalog:fetched').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 3: Continuity Restore
// ═══════════════════════════════════════════════════════════════

suite('Continuity Restore (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    ts: Date.now(), v: 1, data: [{ title: 'T1', index: 0 }, { title: 'T2', index: 1 }]
  }));
  env.ss.setItem('ce-vinyl-cont', JSON.stringify({
    side: 1, spinning: true, pos: 12345, ts: Date.now()
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('continuity:restored emitted', findCaptured(captured, 'log', 'continuity:restored').length > 0);
  const cl = findCaptured(captured, 'log', 'continuity:restored');
  const hasPayload = cl.length > 0 && cl[0].some(a =>
    typeof a === 'object' && a?.side === 1 && a?.pos === 12345 && a?.spinning === true
  );
  assert('payload = { side:1, pos:12345, spinning:true }', hasPayload);
  assert('vmark continuity:restored', env.perf.marks.some(m => m.name === 'vinyl:continuity:restored'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 4: Stale Continuity
// ═══════════════════════════════════════════════════════════════

suite('Stale Continuity (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    ts: Date.now(), v: 1, data: [{ title: 'T1', index: 0 }]
  }));
  env.ss.setItem('ce-vinyl-cont', JSON.stringify({
    side: 0, spinning: false, pos: 500, ts: Date.now() - 60000
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('continuity:stale emitted (debug)', findCaptured(captured, 'debug', 'continuity:stale').length > 0);
  const sl = findCaptured(captured, 'debug', 'continuity:stale');
  const ageValid = sl.length > 0 && sl[0].some(a => typeof a === 'object' && a?.age >= 59000);
  assert('stale age ≥ 59s', ageValid);
  assert('continuity:restored NOT emitted', findCaptured(captured, 'log', 'continuity:restored').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 5: Empty Playlist
// ═══════════════════════════════════════════════════════════════

suite('Empty Playlist (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  const w = env.setMockWidget({ empty: true });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('catalog:empty emitted (warn)', findCaptured(captured, 'warn', 'catalog:empty').length > 0);
  assert('catalog:fetched NOT emitted', findCaptured(captured, 'log', 'catalog:fetched').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 6: SDK Load Failure
// ═══════════════════════════════════════════════════════════════

suite('SDK Load Failure (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, mockSdkSuccess: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();

  const { captured } = env.cons;
  assert('stage:raise emitted before failure', findCaptured(captured, 'log', 'stage:raise').length > 0);
  const sdkWarns = findCaptured(captured, 'warn', 'SDK').concat(findCaptured(captured, 'warn', 'sdk'));
  assert('SDK failure warn(s) emitted', sdkWarns.length > 0);
  assert('sdk:loaded NOT emitted', findCaptured(captured, 'log', 'sdk:loaded').length === 0);
  assert('widget:ready NOT emitted', findCaptured(captured, 'log', 'widget:ready').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 7: Widget ERROR Event
// ═══════════════════════════════════════════════════════════════

suite('Widget ERROR Event (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('error');

  const { captured } = env.cons;
  assert('Unconditional warn on ERROR', findCaptured(captured, 'warn', 'widget encountered an error').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 8: LOG_LEVEL=0 — Production Silent Mode
// ═══════════════════════════════════════════════════════════════

suite('Silent Mode — LOG_LEVEL=0');

{
  const env = execVinyl({ logLevel: 0 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  const vinylLogs = captured.log.filter(a => a[0]?.includes?.('[vinyl]'));
  const vinylDebugs = captured.debug.filter(a => a[0]?.includes?.('[vinyl]'));
  assert('zero console.log [vinyl] at level 0', vinylLogs.length === 0, `found ${vinylLogs.length}`);
  assert('zero console.debug [vinyl] at level 0', vinylDebugs.length === 0, `found ${vinylDebugs.length}`);
  assert('zero performance marks at level 0', env.perf.marks.length === 0, `found ${env.perf.marks.length}`);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 9: LOG_LEVEL=1 — Warn Only
// ═══════════════════════════════════════════════════════════════

suite('Warn Only — LOG_LEVEL=1');

{
  const env = execVinyl({ logLevel: 1 });
  const w = env.setMockWidget({ empty: true });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('catalog:empty emitted at level 1', findCaptured(captured, 'warn', 'catalog:empty').length > 0);
  const infoLogs = captured.log.filter(a => a[0]?.includes?.('[vinyl]'));
  assert('no info-level [vinyl] at level 1', infoLogs.length === 0, `found ${infoLogs.length}`);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 10: FEATURE_OBSERVABILITY = false
// ═══════════════════════════════════════════════════════════════

suite('Feature Gate Off — FEATURE_OBSERVABILITY=false');

{
  const env = execVinyl({ featureObs: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  const allVinyl = [...captured.log, ...captured.debug].filter(a => a[0]?.includes?.('[vinyl]'));
  assert('zero [vinyl] console with gate off', allVinyl.length === 0, `found ${allVinyl.length}`);
  assert('zero marks with gate off', env.perf.marks.length === 0, `found ${env.perf.marks.length}`);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 11: Stage Lower
// ═══════════════════════════════════════════════════════════════

suite('Stage Lower (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  // Toggle DND off → triggers MutationObserver → lowerStage
  env.doc.documentElement.setAttribute('data-theme', 'default');

  const { captured } = env.cons;
  assert('stage:lower emitted on DND off', findCaptured(captured, 'log', 'stage:lower').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 12: First-Attempt SDK — No Retry Payload
// ═══════════════════════════════════════════════════════════════

suite('SDK First-Attempt Success — No Retry Payload (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();

  const { captured } = env.cons;
  const sdkLogs = findCaptured(captured, 'log', 'sdk:loaded');
  assert('sdk:loaded emitted', sdkLogs.length > 0);
  const hasRetryData = sdkLogs.length > 0 && sdkLogs[0].some(a =>
    typeof a === 'object' && a !== null && 'attempts' in a
  );
  assert('no retry count on first-attempt (clean payload)', !hasRetryData);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 13: Event Semantic Purity — vlog vs raw console.warn
// ═══════════════════════════════════════════════════════════════

suite('Signal Separation — vlog vs Operational Warns');

{
  // Run with LOG_LEVEL=0 and trigger an error path
  // Only raw console.warns should appear, not vlogs
  const env = execVinyl({ logLevel: 0, mockSdkSuccess: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();

  const { captured } = env.cons;
  const rawWarns = captured.warn.filter(a => a[0]?.includes?.('[vinyl]'));
  assert('operational warns survive at LOG_LEVEL=0', rawWarns.length > 0);
  const vlogWarns = captured.warn.filter(a => {
    // vlog-routed warns would have the pattern "[vinyl] event-name"
    // while raw warns have free-form messages
    return a[0]?.includes?.('[vinyl] catalog:') || a[0]?.includes?.('[vinyl] continuity:') || a[0]?.includes?.('[vinyl] phase:');
  });
  assert('no vlog warns leak at LOG_LEVEL=0', vlogWarns.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 14: v1.3.0 — Schemaed Continuity Save
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Schemaed Save (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Simulate: user plays, adjusts volume to 72, then pauses
  w._fire('play');
  env.doc._elements['vinylDial'].value = '72';

  // Trigger a pause event → saveState is called from the PAUSE handler
  w._fire('pause');

  // Read back what was persisted
  const raw = env.ss.getItem('ce-vinyl-cont');
  assert('continuity payload written to sessionStorage', raw !== null);

  const payload = JSON.parse(raw);
  assert('payload has v = 1', payload.v === 1);
  assert('payload has vol = 72', payload.vol === 72);
  assert('payload has hushed = false', payload.hushed === false);
  assert('payload has side', typeof payload.side === 'number');
  assert('payload has spinning = false (paused)', payload.spinning === false);
  assert('payload has ts', typeof payload.ts === 'number');

  // Check continuity:saved vlog
  const { captured } = env.cons;
  assert('continuity:saved emitted (debug)', findCaptured(captured, 'debug', 'continuity:saved').length > 0);
  const savedLogs = findCaptured(captured, 'debug', 'continuity:saved');
  const hasVol = savedLogs.length > 0 && savedLogs[0].some(a =>
    typeof a === 'object' && a?.vol === 72 && a?.hushed === false
  );
  assert('continuity:saved payload includes vol and hushed', hasVol);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 15: v1.3.0 — Schemaed Continuity Restore (v1 payload)
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Restore v1 Payload (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    v: 1, ts: Date.now(), data: [{ title: 'T1', index: 0 }, { title: 'T2', index: 1 }]
  }));
  env.ss.setItem('ce-vinyl-cont', JSON.stringify({
    v: 1, side: 1, spinning: false, pos: 8000, vol: 65, hushed: true, ts: Date.now()
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();

  // Track setVolume calls
  let lastVolume = null;
  w.setVolume = function (v) { lastVolume = v; };
  w._fire('ready');

  // Verify volume was restored as muted (hushed=true → setVolume(0))
  assert('setVolume called with 0 (hushed)', lastVolume === 0);

  // Verify dial was set
  const dialVal = env.doc._elements['vinylDial'].value;
  assert('dial value set to 0 (hushed)', dialVal === 0 || dialVal === '0');

  // Verify restored payload in vlog
  const { captured } = env.cons;
  const cl = findCaptured(captured, 'log', 'continuity:restored');
  assert('continuity:restored includes vol and hushed', cl.length > 0 && cl[0].some(a =>
    typeof a === 'object' && a?.vol === 65 && a?.hushed === true
  ));
  assert('continuity:schema-fallback NOT emitted', findCaptured(captured, 'debug', 'continuity:schema-fallback').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 16: v1.3.0 — Schema Fallback (legacy v0 payload)
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Schema Fallback from Legacy Payload (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    v: 1, ts: Date.now(), data: [{ title: 'T1', index: 0 }]
  }));
  // Legacy payload — no v, no vol, no hushed
  env.ss.setItem('ce-vinyl-cont', JSON.stringify({
    side: 0, spinning: false, pos: 5000, ts: Date.now()
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('continuity:schema-fallback emitted (debug)', findCaptured(captured, 'debug', 'continuity:schema-fallback').length > 0);
  const fbLogs = findCaptured(captured, 'debug', 'continuity:schema-fallback');
  const hasV0 = fbLogs.length > 0 && fbLogs[0].some(a =>
    typeof a === 'object' && a?.v === 0
  );
  assert('schema-fallback reports { v: 0 }', hasV0);
  // Should still restore position and emit restored
  assert('continuity:restored still emitted', findCaptured(captured, 'log', 'continuity:restored').length > 0);
  // vol and hushed should be undefined in restored payload
  const cl = findCaptured(captured, 'log', 'continuity:restored');
  const hasUndef = cl.length > 0 && cl[0].some(a =>
    typeof a === 'object' && a?.vol === undefined && a?.hushed === undefined
  );
  assert('restored payload has vol=undefined, hushed=undefined (legacy)', hasUndef);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 17: v1.3.0 — Shelf Version Mismatch
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Shelf Version Mismatch (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  // Seed cache with a different version
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    v: 999, ts: Date.now(), data: [{ title: 'Stale', index: 0 }]
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('shelf:version-mismatch emitted (debug)', findCaptured(captured, 'debug', 'shelf:version-mismatch').length > 0);
  const mmLogs = findCaptured(captured, 'debug', 'shelf:version-mismatch');
  const hasVersions = mmLogs.length > 0 && mmLogs[0].some(a =>
    typeof a === 'object' && a?.cached === 999 && a?.expected === 1
  );
  assert('mismatch payload = { cached:999, expected:1 }', hasVersions);
  // Should fall through to getSounds, not use stale cache
  assert('catalog:fetched emitted (fresh fetch after mismatch)', findCaptured(captured, 'log', 'catalog:fetched').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 18: v1.3.0 — Shelf Without Version (pre-1.3.0 cache)
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Unversioned Shelf Rejected (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  // Pre-1.3.0 shelf: no v field
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    ts: Date.now(), data: [{ title: 'Old', index: 0 }]
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const { captured } = env.cons;
  assert('shelf:version-mismatch emitted for unversioned', findCaptured(captured, 'debug', 'shelf:version-mismatch').length > 0);
  const mmLogs = findCaptured(captured, 'debug', 'shelf:version-mismatch');
  const hasMismatch = mmLogs.length > 0 && mmLogs[0].some(a =>
    typeof a === 'object' && a?.cached === undefined
  );
  assert('cached version is undefined (no v field)', hasMismatch);
  assert('catalog:fetched emitted (refetched)', findCaptured(captured, 'log', 'catalog:fetched').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 19: v1.3.0 — Versioned Shelf Write/Read Round-Trip
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Shelf Round-Trip (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');  // This triggers catalogRecords → shelfWrite

  // Read back what shelfWrite persisted
  const raw = env.ss.getItem('ce-vinyl-shelf');
  assert('shelf written to sessionStorage', raw !== null);
  const shelf = JSON.parse(raw);
  assert('shelf has v = 1', shelf.v === 1);
  assert('shelf has ts', typeof shelf.ts === 'number');
  assert('shelf has data array', Array.isArray(shelf.data));
  assert('shelf data has 3 tracks', shelf.data.length === 3);

  // Now a second env should be able to read this shelf
  const env2 = execVinyl({ logLevel: 3 });
  // Copy the shelf from env to env2
  env2.ss.setItem('ce-vinyl-shelf', raw);
  env2.doc._htmlAttrs['data-theme'] = 'refined';
  const w2 = env2.exec();
  w2._fire('ready');

  const { captured: c2 } = env2.cons;
  assert('second boot hits shelf cache', findCaptured(c2, 'debug', 'catalog:shelf-hit').length > 0);
  assert('second boot does NOT refetch', findCaptured(c2, 'log', 'catalog:fetched').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 20: v1.3.0 — Silent at LOG_LEVEL=0
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Silent at LOG_LEVEL=0');

{
  const env = execVinyl({ logLevel: 0 });
  // Seed with legacy payload to trigger schema-fallback path
  env.ss.setItem('ce-vinyl-shelf', JSON.stringify({
    ts: Date.now(), data: [{ title: 'T1', index: 0 }]
  }));
  env.ss.setItem('ce-vinyl-cont', JSON.stringify({
    side: 0, spinning: false, pos: 1000, ts: Date.now()
  }));
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');   // ready → playing (needed for state machine)
  w._fire('pause');  // playing → paused → triggers saveState

  const { captured } = env.cons;
  const vinylLogs = captured.log.filter(a => a[0]?.includes?.('[vinyl]'));
  const vinylDebugs = captured.debug.filter(a => a[0]?.includes?.('[vinyl]'));
  assert('zero console.log [vinyl] at level 0', vinylLogs.length === 0, `found ${vinylLogs.length}`);
  assert('zero console.debug [vinyl] at level 0', vinylDebugs.length === 0, `found ${vinylDebugs.length}`);
  assert('zero performance marks at level 0', env.perf.marks.length === 0, `found ${env.perf.marks.length}`);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 21: v1.3.0 — Unconditional Warns Persist at LOG_LEVEL=0
// ═══════════════════════════════════════════════════════════════

suite('v1.3.0 — Unconditional Warns Persist at LOG_LEVEL=0');

{
  const env = execVinyl({ logLevel: 0, mockSdkSuccess: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();

  const { captured } = env.cons;
  const rawWarns = captured.warn.filter(a => a[0]?.includes?.('[vinyl]'));
  assert('operational SDK failure warns survive at level 0', rawWarns.length > 0);
  // Confirm NO vlog-routed warns leaked
  const vlogWarns = captured.warn.filter(a =>
    a[0]?.includes?.('[vinyl] shelf:') || a[0]?.includes?.('[vinyl] continuity:') || a[0]?.includes?.('[vinyl] phase:')
  );
  assert('no vlog warns leak at level 0', vlogWarns.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  HELPER: extract phase transition sequence from debug channel
// ═══════════════════════════════════════════════════════════════

function extractPhases(captured) {
  const phases = [];
  captured.debug.forEach(args => {
    const tag = args[0] || '';
    const m = tag.match(/\[vinyl\] phase:(\w+)/);
    if (m) phases.push(m[1]);
  });
  return phases;
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 22: v1.4.0 — Phase Lifecycle: Happy Path
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Phase Lifecycle: Happy Path (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');
  w._fire('pause');

  const phases = extractPhases(env.cons.captured);
  assert('phase:loading emitted', phases.includes('loading'));
  assert('phase:ready emitted', phases.includes('ready'));
  assert('phase:playing emitted', phases.includes('playing'));
  assert('phase:paused emitted', phases.includes('paused'));

  // Verify ordering: loading → ready → playing → paused
  const li = phases.indexOf('loading');
  const ri = phases.indexOf('ready');
  const pi = phases.indexOf('playing');
  const pa = phases.indexOf('paused');
  assert('order: loading → ready → playing → paused',
    li < ri && ri < pi && pi < pa,
    `indices: ${li}, ${ri}, ${pi}, ${pa}`);

  // Verify marks
  const marks = env.perf.marks.map(m => m.name);
  assert('vmark phase:loading', marks.includes('vinyl:phase:loading'));
  assert('vmark phase:ready', marks.includes('vinyl:phase:ready'));
  assert('vmark phase:playing', marks.includes('vinyl:phase:playing'));
  assert('vmark phase:paused', marks.includes('vinyl:phase:paused'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 23: v1.4.0 — SDK Failure → Errored Phase
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — SDK Failure → Errored (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, mockSdkSuccess: false, syncTimers: true });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  env.exec();

  const phases = extractPhases(env.cons.captured);
  assert('phase:loading emitted', phases.includes('loading'));
  assert('phase:errored emitted', phases.includes('errored'));
  assert('phase:ready NOT emitted', !phases.includes('ready'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 24: v1.4.0 — Widget Error → Errored Phase
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Widget Error → Errored (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('error');

  const phases = extractPhases(env.cons.captured);
  assert('phase:ready before error', phases.includes('ready'));
  assert('phase:errored after widget error', phases.includes('errored'));
  const ri = phases.indexOf('ready');
  const ei = phases.indexOf('errored');
  assert('ready precedes errored', ri < ei);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 25: v1.4.0 — FINISH Resets to Ready
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — FINISH → Ready (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');
  w._fire('finish');

  const phases = extractPhases(env.cons.captured);
  // After finish, phase should return to 'ready'
  // The sequence should be: loading, ready, playing, ready
  const readyIndices = phases.reduce((acc, p, i) => {
    if (p === 'ready') acc.push(i);
    return acc;
  }, []);
  assert('ready appears twice (catalog + finish)', readyIndices.length === 2);

  const playingIdx = phases.indexOf('playing');
  assert('second ready follows playing', readyIndices[1] > playingIdx);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 26: v1.4.0 — Rejected Transition: Spurious PAUSE
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Rejected: Spurious PAUSE in Ready (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  // Fire PAUSE without ever playing — this is a spurious event
  w._fire('pause');

  const { captured } = env.cons;
  const rejections = findCaptured(captured, 'warn', 'phase:rejected');
  assert('phase:rejected emitted for spurious PAUSE', rejections.length > 0);
  const rej = rejections[0].find(a => typeof a === 'object' && a?.from === 'ready' && a?.to === 'paused');
  assert('rejection shows from=ready, to=paused', rej !== undefined);

  // spinning should still be false (handler returned early)
  const phases = extractPhases(captured);
  assert('phase:paused NOT in sequence', !phases.includes('paused'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 27: v1.4.0 — Guard: PLAY Rejected During Loading
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Guard: PLAY Rejected During Loading (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  // Widget is created by dropNeedle (SDK loaded), but READY hasn't fired
  // Phase should be 'loading' — fire PLAY before READY
  w._fire('play');

  const { captured } = env.cons;
  const rejections = findCaptured(captured, 'warn', 'phase:rejected');
  assert('PLAY rejected in loading phase', rejections.length > 0);
  const rej = rejections[0].find(a => typeof a === 'object' && a?.from === 'loading' && a?.to === 'playing');
  assert('rejection shows from=loading, to=playing', rej !== undefined);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 28: v1.4.0 — Errored Is Terminal
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Errored Is Terminal (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('error');
  // Try to play after error — should be rejected
  w._fire('play');

  const { captured } = env.cons;
  const rejections = findCaptured(captured, 'warn', 'phase:rejected');
  const playAfterErr = rejections.filter(args =>
    args.some(a => typeof a === 'object' && a?.from === 'errored' && a?.to === 'playing')
  );
  assert('PLAY rejected after errored', playAfterErr.length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 29: v1.4.0 — Phase Silent at LOG_LEVEL=0
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Phase Silent at LOG_LEVEL=0');

{
  const env = execVinyl({ logLevel: 0 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');
  w._fire('pause');

  const phases = extractPhases(env.cons.captured);
  assert('zero phase events at LOG_LEVEL=0', phases.length === 0);

  const phaseMarks = env.perf.marks.filter(m => m.name.includes('phase:'));
  assert('zero phase marks at LOG_LEVEL=0', phaseMarks.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 30: v1.4.0 — Gate Off: No Phase Events, Normal Behavior
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Gate Off: FEATURE_STATE_MACHINE=false (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, featureSM: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');
  w._fire('pause');

  const phases = extractPhases(env.cons.captured);
  assert('zero phase events with gate off', phases.length === 0);

  // But normal observability still works
  const { captured } = env.cons;
  assert('stage:raise still emitted', findCaptured(captured, 'log', 'stage:raise').length > 0);
  assert('widget:ready still emitted', findCaptured(captured, 'log', 'widget:ready').length > 0);
  assert('catalog:fetched still emitted', findCaptured(captured, 'log', 'catalog:fetched').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 31: v1.4.0 — Re-raise After Lower Preserves Phase
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Re-raise Preserves Phase (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Toggle DND off → lowerStage → needle.pause() would fire PAUSE
  // In our test, MutationObserver triggers lowerStage via setAttribute
  env.doc.documentElement.setAttribute('data-theme', 'default');

  // Count phase transitions before re-raise
  const phasesBeforeReraise = extractPhases(env.cons.captured);
  const loadingCount = phasesBeforeReraise.filter(p => p === 'loading').length;

  // Toggle DND back on → raiseStage (should NOT transition to loading again)
  env.doc.documentElement.setAttribute('data-theme', 'refined');

  const phasesAfter = extractPhases(env.cons.captured);
  const loadingCountAfter = phasesAfter.filter(p => p === 'loading').length;
  assert('no duplicate loading on re-raise', loadingCountAfter === loadingCount);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 32: v1.4.0 — Autoplay-Blocked Phase Recovery
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Autoplay-Blocked Phase Recovery (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });

  // Seed continuity with spinning=true so restoreState calls safePlay
  env.ss.setItem('ce-vinyl-cont', JSON.stringify({
    v: 1, side: 0, spinning: true, vol: 40, hushed: false, pos: 0, ts: Date.now()
  }));

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();

  // Replace mock widget's play() to simulate autoplay block:
  // fires PLAY handler (promoting phase to playing), then rejects via thenable
  w.play = function () {
    w._fire('play');
    return { catch: function (fn) { fn(new Error('Autoplay blocked')); } };
  };

  // Fire ready → catalogRecords → restoreState → safePlay → play() → PLAY event → reject → recovery
  w._fire('ready');

  const phases = extractPhases(env.cons.captured);
  // Sequence: loading, ready (catalog), playing (PLAY event), ready (autoplay-blocked recovery)
  assert('phase:playing appears before recovery', phases.includes('playing'));

  const readyCount = phases.filter(p => p === 'ready').length;
  assert('phase:ready appears twice (catalog + recovery)', readyCount === 2);

  // Verify the autoplay-blocked reason is logged at debug level
  const { captured } = env.cons;
  const recoveryLogs = captured.debug.filter(a =>
    a[0]?.includes?.('[vinyl] phase:ready') && a[1]?.reason === 'autoplay-blocked'
  );
  assert('autoplay-blocked recovery reason logged', recoveryLogs.length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 33: v1.4.0 — Empty Catalog → Errored Phase
// ═══════════════════════════════════════════════════════════════

suite('v1.4.0 — Empty Catalog → Errored Phase (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.setMockWidget({ empty: true });
  env.exec();
  w._fire('ready');

  const phases = extractPhases(env.cons.captured);
  assert('phase:loading emitted', phases.includes('loading'));
  assert('phase:errored emitted for empty catalog', phases.includes('errored'));

  // Verify errored is terminal — no further transitions
  const lastPhase = phases[phases.length - 1];
  assert('errored is the final phase', lastPhase === 'errored');

  // Verify catalog:empty was also logged at warn level
  const { captured } = env.cons;
  assert('catalog:empty warn emitted', findCaptured(captured, 'warn', 'catalog:empty').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 34: v2.0.0 — Broadcast Init + Claim on Play
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Broadcast Init + Claim on Play (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();

  // Channel should have been created during overture → initChannel
  assert('BroadcastChannel instance created', env.bc.instances.length === 1);
  const ch = env.bc.instances[0];
  assert('channel name is ce-vinyl', ch.name === 'ce-vinyl');
  assert('broadcast:init logged', findCaptured(env.cons.captured, 'debug', 'broadcast:init').length > 0);

  // Play → should broadcast claim
  w._fire('ready');
  w._fire('play');
  const claims = ch._messages.filter(m => m.type === 'claim');
  assert('claim message posted on play', claims.length === 1);
  assert('claim has tabId', typeof claims[0].tabId === 'string' && claims[0].tabId.length > 0);
  assert('broadcast:claim logged', findCaptured(env.cons.captured, 'debug', 'broadcast:claim').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 35: v2.0.0 — Remote Claim Pauses Local Playback
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Remote Claim Pauses Local (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Verify we're in playing phase
  let phases = extractPhases(env.cons.captured);
  assert('local tab is playing', phases.includes('playing'));

  // Simulate remote tab claiming ownership
  env.bc.simulateRemote({ type: 'claim', tabId: 'remote-tab-xyz', ts: Date.now() });

  // The onChannelMessage handler calls needle.pause()
  // In our mock, pause() doesn't fire the PAUSE event handler automatically,
  // but the remote-claim log should appear
  assert('broadcast:remote-claim logged', findCaptured(env.cons.captured, 'log', 'broadcast:remote-claim').length > 0);

  // Yield should NOT have been posted (only owner yields, and remote-claim sets isOwner=false)
  const ch = env.bc.instances[0];
  const yields = ch._messages.filter(m => m.type === 'yield');
  // The pause will fire a yield via the PAUSE handler ONLY if needle.pause() triggers
  // the PAUSE event. In our mock, pause() is a no-op, so no yield is posted here.
  // But the broadcastYield guard checks isOwner — since remote-claim set it to false, yield won't fire.
  assert('no yield posted after remote claim (isOwner=false)', yields.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 36: v2.0.0 — Broadcast Yield on Pause
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Pause-Retain on Pause (v3.0 semantics) (LOG_LEVEL=3)');

{
  // v3.0.0: FEATURE_OWNERSHIP_V3 changes pause behavior — tab retains
  // ownership and broadcasts a sync with spinning=false (pause-retain)
  // instead of yielding. This is the correct v3+ behavior.
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');   // sets isOwner=true via broadcastClaim
  w._fire('pause');  // v3+: broadcastPauseRetain (not yield)

  const ch = env.bc.instances[0];
  const syncs = ch._messages.filter(m => m.type === 'sync');
  const pauseRetain = syncs.find(m => m.payload && m.payload.spinning === false);
  assert('pause-retain sync posted on pause', !!pauseRetain);
  assert('broadcast:pause-retain logged', findCaptured(env.cons.captured, 'debug', 'broadcast:pause-retain').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 37: v2.0.0 — Broadcast Sync Throttled via PLAY_PROGRESS
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Broadcast Sync on Progress (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');  // isOwner=true

  // Fire progress events — sync is throttled to SYNC_THROTTLE (5000ms)
  // First progress fires broadcastSync, but lastSync starts at 0 and
  // Date.now() > 0 + 5000 is true, so the first call should post
  w._fire('playProgress', { currentPosition: 5000 });

  const ch = env.bc.instances[0];
  const syncs = ch._messages.filter(m => m.type === 'sync');
  assert('sync message posted on first progress', syncs.length === 1);
  assert('sync payload has side', typeof syncs[0].payload.side === 'number');
  assert('sync payload has pos', syncs[0].payload.pos === 5000);

  // Second immediate progress — should be throttled (same millisecond)
  w._fire('playProgress', { currentPosition: 5500 });
  const syncs2 = ch._messages.filter(m => m.type === 'sync');
  assert('sync throttled on rapid progress', syncs2.length === 1);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 38: v2.0.0 — Broadcast Gate Off
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — FEATURE_BROADCAST=false (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, featureBroadcast: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  assert('no BroadcastChannel instances', env.bc.instances.length === 0);
  assert('no broadcast:init logged', findCaptured(env.cons.captured, 'debug', 'broadcast:init').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 39: v2.0.0 — BroadcastChannel Absent (Graceful Fallback)
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — BroadcastChannel Absent (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  // Remove BroadcastChannel from the window before exec
  delete env.win.BroadcastChannel;
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // initChannel should have bailed (typeof BroadcastChannel === 'undefined')
  assert('no channel instances created', env.bc.instances.length === 0);
  assert('no broadcast:init', findCaptured(env.cons.captured, 'debug', 'broadcast:init').length === 0);
  // But everything else works normally
  assert('widget:ready still emitted', findCaptured(env.cons.captured, 'log', 'widget:ready').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 40: v2.0.0 — Up Next Reflects Correctly
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Up Next Display (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // After catalogRecords + reflectTitle, upnext should show Track B
  const stage = env.doc._elements['vinyl'];
  const marquee = stage.children.find(c => c.classList.contains('vinyl-marquee'));
  assert('marquee found on stage', marquee !== undefined);

  const upnext = marquee.children.find(c => c.className === 'vinyl-upnext');
  assert('upnext element created', upnext !== undefined);
  assert('upnext shows Track B', upnext.textContent.includes('Track B'));
  assert('upnext is visible', upnext.hidden === false);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 41: v2.0.0 — Crate V2 Track Numbering + Duration
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Crate V2 Numbering & Duration (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Crate items are appended as children of el.crate
  const crate = env.doc._elements['vinylCrate'];
  assert('crate has 3 children', crate.children.length === 3);

  const first = crate.children[0];
  // v3.1.0: FEATURE_SLEEVE_V3 drops the "01 · Title" numerical prefix.
  // Crate items now show "Title  3:00" format (title-only, left-aligned).
  assert('first item starts with track title', first.textContent.startsWith('Track A'));
  assert('first item contains Track A', first.textContent.includes('Track A'));
  assert('first item contains duration (3:00)', first.textContent.includes('3:00'));
  assert('first item has tabindex=0', first.attributes.tabindex === '0');

  const second = crate.children[1];
  assert('second item starts with track title', second.textContent.startsWith('Track B'));
  assert('second item contains duration (3:30)', second.textContent.includes('3:30'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 42: v2.0.0 — FEATURE_CRATE_V2=false (Original Behavior)
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — FEATURE_CRATE_V2=false (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, featureCrateV2: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // No upnext element should exist
  const stage = env.doc._elements['vinyl'];
  const marquee = stage.children.find(c => c.classList.contains('vinyl-marquee'));
  const upnext = marquee ? marquee.children.find(c => c.className === 'vinyl-upnext') : null;
  assert('no upnext element when gate off', upnext === undefined || upnext === null);

  // Crate items should NOT have track numbers
  const crate = env.doc._elements['vinylCrate'];
  if (crate.children.length > 0) {
    assert('crate item has plain title (no numbering)', crate.children[0].textContent === 'Track A');
    assert('no tabindex on crate items', crate.children[0].attributes.tabindex === undefined);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 43: v2.0.0 — Duration Captured in Records
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Duration in Shelf (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Read the shelf — records should include duration
  const raw = env.ss.getItem('ce-vinyl-shelf');
  assert('shelf written', raw !== null);
  const shelf = JSON.parse(raw);
  assert('shelf has 3 tracks', shelf.data.length === 3);
  assert('shelf track has duration', shelf.data[0].duration === 180000);

  // Second boot reads from shelf — duration preserved
  const env2 = execVinyl({ logLevel: 3 });
  env2.ss.setItem('ce-vinyl-shelf', raw);
  env2.doc._htmlAttrs['data-theme'] = 'refined';
  const w2 = env2.exec();
  w2._fire('ready');

  const crate2 = env2.doc._elements['vinylCrate'];
  assert('shelf-cached crate shows duration', crate2.children[0].textContent.includes('3:00'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 44: v2.0.0 — safeBroadcast Error Handling
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — safeBroadcast Error Handling (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Close the channel to make postMessage throw
  const ch = env.bc.instances[0];
  const origPost = ch.postMessage.bind(ch);
  ch.postMessage = function () { throw new Error('channel closed'); };

  // Play should still succeed without crashing — safeBroadcast catches the error
  w._fire('play');
  assert('broadcast:send-error logged', findCaptured(env.cons.captured, 'warn', 'broadcast:send-error').length > 0);

  // Widget is still in playing state (claim failed but play event still processed)
  const phases = extractPhases(env.cons.captured);
  assert('playing phase reached despite send error', phases.includes('playing'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 45: v2.0.0 — Stale Message Rejection
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Stale Message Rejection (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Simulate a remote claim with a very old timestamp (>15s ago)
  const staleTs = Date.now() - 20000;
  env.bc.simulateRemote({ type: 'claim', tabId: 'stale-tab', ts: staleTs });

  // The stale claim should be dropped — no remote-claim log
  assert('stale claim dropped', findCaptured(env.cons.captured, 'log', 'broadcast:remote-claim').length === 0);
  assert('broadcast:stale logged', findCaptured(env.cons.captured, 'debug', 'broadcast:stale').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 46: v2.0.0 — Yield on Exit (pagehide)
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Nav Marker on Exit via pagehide (v4.0 semantics) (LOG_LEVEL=3)');

{
  // v4.0.0: FEATURE_CONTINUITY_V4 changes exit behavior for DND owners.
  // Instead of yielding on pagehide, the owner sets a nav marker so the
  // new page can reclaim immediately (avoiding ownership gaps during
  // same-tab navigation). This is correct v4+ behavior.
  const env = execVinyl({ logLevel: 3 });

  // Capture addEventListener calls on window
  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Simulate pagehide — v4+: should set nav marker instead of yielding
  if (winListeners.pagehide) {
    winListeners.pagehide.forEach(fn => fn());
  }

  // v4.0: nav marker set in sessionStorage (consumed by next page load)
  const navMarker = env.ss.getItem('ce-vinyl-nav');
  assert('nav marker set on pagehide', navMarker === '1');
  assert('continuity:nav-exit logged', findCaptured(env.cons.captured, 'debug', 'continuity:nav-exit').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 47: v2.0.0 — Observer Tracks Remote State via Sync
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Observer Remote State Tracking (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Tab receives remote claim — enters observer mode
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });

  // Owner sends sync with track info
  env.bc.simulateRemote({
    type: 'sync',
    tabId: 'owner-tab',
    payload: { side: 1, spinning: true, pos: 42000, title: 'Remote Track X', ts: Date.now() }
  });

  assert('remote-sync logged', findCaptured(env.cons.captured, 'debug', 'broadcast:remote-sync').length > 0);

  // Check upnext reflects remote state
  const stage = env.doc._elements['vinyl'];
  const marquee = stage.children.find(c => c.classList.contains('vinyl-marquee'));
  const upnext = marquee ? marquee.children.find(c => c.className === 'vinyl-upnext') : null;
  if (upnext) {
    assert('upnext shows remote track', upnext.textContent.includes('Playing elsewhere'));
    assert('upnext shows remote title', upnext.textContent.includes('Remote Track X'));
  } else {
    assert('upnext element exists for observer', false);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 48: v2.0.0 — Remote Yield Clears Observer State
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Remote Yield Starts Grace Window (v3.0 semantics) (LOG_LEVEL=3)');

{
  // v3.0.0: FEATURE_OWNERSHIP_V3 introduces a yield-grace window.
  // When a remote yield arrives, the observer does NOT clear immediately.
  // Instead, it starts a grace timer (V4_YIELD_GRACE_MS = 3000ms).
  // If the same tabId reclaims within the grace window (same-tab nav),
  // the yield is absorbed transparently. The clear only happens when
  // the timer expires.
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Remote claim + sync
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });
  env.bc.simulateRemote({
    type: 'sync',
    tabId: 'owner-tab',
    payload: { side: 0, spinning: true, pos: 10000, title: 'Some Track', ts: Date.now() }
  });

  // Verify observer state is set
  const stage = env.doc._elements['vinyl'];
  const marquee = stage.children.find(c => c.classList.contains('vinyl-marquee'));
  const upnext = marquee ? marquee.children.find(c => c.className === 'vinyl-upnext') : null;
  assert('upnext shows remote state before yield', upnext && upnext.textContent.includes('Playing elsewhere'));

  // Remote yield — v3+: starts grace timer, does NOT clear immediately
  env.bc.simulateRemote({ type: 'yield', tabId: 'owner-tab', ts: Date.now() });

  assert('remote-yield logged', findCaptured(env.cons.captured, 'debug', 'broadcast:remote-yield').length > 0);
  // v3.0+: yield-grace window is active — remote state persists until grace expires
  assert('yield-grace started', findCaptured(env.cons.captured, 'debug', 'yield-grace:started').length > 0);
  // Remote state still visible during grace window (not yet cleared)
  assert('remote state persists during grace window', upnext && upnext.textContent.includes('Playing elsewhere'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 49: v2.0.0 — Sync from Non-Owner Ignored
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Sync from Non-Owner Ignored (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Remote claim from tab A
  env.bc.simulateRemote({ type: 'claim', tabId: 'tab-A', ts: Date.now() });

  // Sync from tab B (not the owner) — should be ignored
  env.bc.simulateRemote({
    type: 'sync',
    tabId: 'tab-B',
    payload: { side: 2, spinning: true, pos: 99000, title: 'Imposter Track', ts: Date.now() }
  });

  // remote-sync should NOT be logged for the tab-B message
  const syncLogs = findCaptured(env.cons.captured, 'debug', 'broadcast:remote-sync');
  assert('sync from non-owner ignored', syncLogs.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 50: v2.0.0 — Rapid Claim Resolution (Last Writer Wins)
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Rapid Claim Resolution (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  const ch = env.bc.instances[0];

  // Rapid successive remote claims from different tabs
  env.bc.simulateRemote({ type: 'claim', tabId: 'tab-X', ts: Date.now() });
  env.bc.simulateRemote({ type: 'claim', tabId: 'tab-Y', ts: Date.now() });
  env.bc.simulateRemote({ type: 'claim', tabId: 'tab-Z', ts: Date.now() });

  const claimLogs = findCaptured(env.cons.captured, 'log', 'broadcast:remote-claim');
  assert('all three remote claims logged', claimLogs.length === 3);

  // No yield should be posted — local tab had isOwner set to false by first claim
  const yields = ch._messages.filter(m => m.type === 'yield');
  assert('no yield posted (isOwner was false after first remote claim)', yields.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 51: v2.0.0 — Sync Payload Includes Title
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Sync Payload Includes Title (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  w._fire('playProgress', { currentPosition: 5000 });

  const ch = env.bc.instances[0];
  const syncs = ch._messages.filter(m => m.type === 'sync');
  assert('sync has title field', syncs.length > 0 && typeof syncs[0].payload.title === 'string');
  assert('sync title matches Track A', syncs[0].payload.title === 'Track A');
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 52: v2.0.0 — Remote Claim Transitions Phase to Paused
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Remote Claim Phase Transition (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  let phases = extractPhases(env.cons.captured);
  assert('local tab in playing phase', phases.includes('playing'));

  // Simulate remote claim — should transition phase to paused
  env.bc.simulateRemote({ type: 'claim', tabId: 'remote-tab', ts: Date.now() });

  phases = extractPhases(env.cons.captured);
  assert('phase:paused emitted with reason remote-claim', phases.includes('paused'));

  // Verify the reason is 'remote-claim'
  const pausedLogs = findCaptured(env.cons.captured, 'debug', 'phase:paused');
  const hasRemoteReason = pausedLogs.some(args =>
    args.some(a => typeof a === 'object' && a !== null && a.reason === 'remote-claim')
  );
  assert('paused reason is remote-claim', hasRemoteReason);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 53: v2.0.0 — Cross-Tab Play→Claim→Re-Play Lifecycle
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Cross-Tab Play→Claim→Re-Play (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  let phases = extractPhases(env.cons.captured);
  assert('initial play: phase=playing', phases[phases.length - 1] === 'playing');

  // Remote tab claims — local tab is paused
  env.bc.simulateRemote({ type: 'claim', tabId: 'tab-B', ts: Date.now() });
  phases = extractPhases(env.cons.captured);
  assert('after remote claim: phase=paused', phases[phases.length - 1] === 'paused');

  // Remote tab yields (user paused or tab closed)
  env.bc.simulateRemote({ type: 'yield', tabId: 'tab-B', ts: Date.now() });

  // User re-plays on local tab — should succeed
  w._fire('play');
  phases = extractPhases(env.cons.captured);
  assert('after re-play: phase=playing', phases[phases.length - 1] === 'playing');

  // Claim should be posted again
  const ch = env.bc.instances[0];
  const claims = ch._messages.filter(m => m.type === 'claim');
  assert('second claim posted on re-play', claims.length === 2);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 54: v2.0.0 — Non-Playing Tab Receives Claim (No Crash)
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Non-Playing Tab Receives Claim (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Tab is in ready phase, not playing — receive a remote claim
  env.bc.simulateRemote({ type: 'claim', tabId: 'tab-X', ts: Date.now() });

  let phases = extractPhases(env.cons.captured);
  assert('phase stays ready (no spurious paused)', phases[phases.length - 1] === 'ready');
  assert('remote-claim logged', findCaptured(env.cons.captured, 'log', 'broadcast:remote-claim').length > 0);

  // Now local tab can still play
  w._fire('play');
  phases = extractPhases(env.cons.captured);
  assert('local tab can play after non-playing claim', phases[phases.length - 1] === 'playing');
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 55: v2.0.0 — BroadcastChannel Constructor Failure
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — BroadcastChannel Constructor Failure (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  // Make BroadcastChannel throw (simulates file:// or opaque origin)
  env.win.BroadcastChannel = function () { throw new DOMException('opaque origin'); };
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // broadcast:failed should be logged at warn level
  assert('broadcast:failed logged', findCaptured(env.cons.captured, 'warn', 'broadcast:failed').length > 0);

  // Operational warn should fire unconditionally
  const opWarn = env.cons.captured.warn.filter(args =>
    args.some(a => typeof a === 'string' && a.includes('Cross-tab sync unavailable'))
  );
  assert('operational warn emitted for init failure', opWarn.length > 0);

  // Player should still function normally
  w._fire('play');
  const phases = extractPhases(env.cons.captured);
  assert('playing phase reached despite no channel', phases.includes('playing'));
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 56: v2.0.0 — Yield-Skipped Diagnostic on Non-Owner Exit
// ═══════════════════════════════════════════════════════════════

suite('v2.0.0 — Yield-Skipped on Non-Owner (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Tab never played — isOwner=false. Trigger pagehide.
  if (winListeners.pagehide) {
    winListeners.pagehide.forEach(fn => fn());
  }

  const ch = env.bc.instances[0];
  const yields = ch._messages.filter(m => m.type === 'yield');
  assert('no yield posted by non-owner', yields.length === 0);
  assert('yield-skipped diagnostic logged', findCaptured(env.cons.captured, 'debug', 'broadcast:yield-skipped').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 57: v2.1.0 — Ping Sent on initChannel
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Ping Sent on Init (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();

  const ch = env.bc.instances[0];
  const pings = ch._messages.filter(m => m.type === 'ping');
  assert('ping sent on initChannel', pings.length === 1);
  assert('ping has tabId', typeof pings[0].tabId === 'string' && pings[0].tabId.length > 0);
  assert('leader:ping-sent logged', findCaptured(env.cons.captured, 'debug', 'leader:ping-sent').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 58: v2.1.0 — Owner Replies to Ping with Pong
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Owner Pong Reply (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');  // becomes owner

  const ch = env.bc.instances[0];
  const msgsBefore = ch._messages.length;

  // Simulate a ping from a new tab
  env.bc.simulateRemote({ type: 'ping', tabId: 'new-tab-abc', ts: Date.now() });

  const pongs = ch._messages.slice(msgsBefore).filter(m => m.type === 'pong');
  assert('pong sent in reply to ping', pongs.length === 1);
  assert('pong has payload with title', typeof pongs[0].payload.title === 'string');
  assert('pong has spinning state', typeof pongs[0].payload.spinning === 'boolean');
  assert('leader:pong-sent logged', findCaptured(env.cons.captured, 'debug', 'leader:pong-sent').length > 0);
  assert('leader:ping-recv logged', findCaptured(env.cons.captured, 'debug', 'leader:ping-recv').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 59: v2.1.0 — Non-Owner Ignores Ping (No Pong)
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Non-Owner Ignores Ping (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  // NOT playing — not owner

  const ch = env.bc.instances[0];
  const msgsBefore = ch._messages.length;

  env.bc.simulateRemote({ type: 'ping', tabId: 'new-tab-xyz', ts: Date.now() });

  const pongs = ch._messages.slice(msgsBefore).filter(m => m.type === 'pong');
  assert('no pong from non-owner', pongs.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 60: v2.1.0 — Pong Sets Remote State on Observer
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Pong Sets Observer State (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  // Simulate receiving a pong from an existing owner
  env.bc.simulateRemote({
    type: 'pong',
    tabId: 'owner-tab-123',
    ts: Date.now(),
    payload: { side: 2, spinning: true, pos: 55000, title: 'Discovered Track' }
  });

  assert('leader:pong-recv logged', findCaptured(env.cons.captured, 'log', 'leader:pong-recv').length > 0);

  // Check upnext reflects the remote state
  const stage = env.doc._elements['vinyl'];
  const marquee = stage.children.find(c => c.classList.contains('vinyl-marquee'));
  const upnext = marquee ? marquee.children.find(c => c.className === 'vinyl-upnext') : null;
  if (upnext) {
    assert('upnext shows discovered remote state', upnext.textContent.includes('Playing elsewhere'));
    assert('upnext shows discovered title', upnext.textContent.includes('Discovered Track'));
  } else {
    assert('upnext element exists for pong', false);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 61: v2.1.0 — Heartbeat Starts on Claim
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Heartbeat Starts on Claim (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  const intervalsBefore = env._intervals.length;
  w._fire('play');  // claim → starts heartbeat

  assert('setInterval called for heartbeat', env._intervals.length > intervalsBefore);
  assert('leader:heartbeat-start logged', findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-start').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 62: v2.1.0 — Heartbeat Stops on Yield
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Heartbeat Continues on Pause (v3.0 pause-retain) (LOG_LEVEL=3)');

{
  // v3.0.0: Pause no longer yields ownership — it broadcasts pause-retain.
  // The tab retains ownership, so the heartbeat correctly continues.
  // Heartbeat only stops on explicit yield (DND off, tab close, remote claim).
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');   // starts heartbeat

  assert('leader:heartbeat-start logged', findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-start').length > 0);

  w._fire('pause');  // v3+: pause-retain, heartbeat stays active

  // v3.0+: heartbeat should NOT stop on pause (ownership retained)
  const stops = findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-stop');
  assert('heartbeat continues after pause (no stop logged)', stops.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 63: v2.1.0 — Heartbeat Stops on Remote Claim
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Heartbeat Stops on Remote Claim (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');  // owner, heartbeat running

  // Remote tab claims — should stop local heartbeat
  env.bc.simulateRemote({ type: 'claim', tabId: 'remote-owner', ts: Date.now() });

  const stopLogs = findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-stop');
  assert('heartbeat stopped on remote claim', stopLogs.length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 64: v2.1.0 — Election Triggered by Stale Owner on Visibility Change
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Stale Owner Election on Focus (LOG_LEVEL=3)');

{
  // Use ownerStale=1 so the owner becomes stale almost instantly after claim
  const env = execVinyl({ logLevel: 3, ownerStale: 1 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Remote claim with fresh timestamp (passes stale message protection)
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });

  // Wait a tiny bit so ownerStale=1ms is exceeded
  // (In practice, Date.now() > lastOwnerSeen + 1 after any JS execution)
  const busyWait = Date.now() + 5;
  while (Date.now() < busyWait) { /* spin */ }

  // Simulate visibilitychange — tab comes back into focus
  env.doc.visibilityState = 'visible';
  if (env.doc._docListeners.visibilitychange) {
    env.doc._docListeners.visibilitychange.forEach(fn => fn());
  }

  assert('leader:stale-on-focus logged', findCaptured(env.cons.captured, 'log', 'leader:stale-on-focus').length > 0);
  assert('leader:election-start logged', findCaptured(env.cons.captured, 'log', 'leader:election-start').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 65: v2.1.0 — Election Cancelled by Fresh Owner Message
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Election Cancelled by Owner Message (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, ownerStale: 1 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Fresh claim to establish owner
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });

  // Spin until stale
  const busyWait = Date.now() + 5;
  while (Date.now() < busyWait) { /* spin */ }

  // Trigger election via visibility change
  env.doc.visibilityState = 'visible';
  if (env.doc._docListeners.visibilitychange) {
    env.doc._docListeners.visibilitychange.forEach(fn => fn());
  }

  assert('election started', findCaptured(env.cons.captured, 'log', 'leader:election-start').length > 0);

  // Now owner sends a fresh heartbeat — should cancel the election
  env.bc.simulateRemote({ type: 'heartbeat', tabId: 'owner-tab', ts: Date.now() });

  assert('leader:election-cancelled logged', findCaptured(env.cons.captured, 'debug', 'leader:election-cancelled').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 66: v2.1.0 — No Election When Visible and Owner is Fresh
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — No Election When Owner is Fresh (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Remote claim with FRESH timestamp
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });

  // Simulate visibilitychange
  env.doc.visibilityState = 'visible';
  if (env.doc._docListeners.visibilitychange) {
    env.doc._docListeners.visibilitychange.forEach(fn => fn());
  }

  assert('no election when owner is fresh', findCaptured(env.cons.captured, 'log', 'leader:election-start').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 67: v2.1.0 — FEATURE_LEADER_ELECTION=false (No Heartbeat/Ping)
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — FEATURE_LEADER_ELECTION=false (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, featureLeaderElection: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  const ch = env.bc.instances[0];
  const pings = ch._messages.filter(m => m.type === 'ping');
  const heartbeats = ch._messages.filter(m => m.type === 'heartbeat');

  assert('no ping when election gate off', pings.length === 0);
  assert('no heartbeat when election gate off', heartbeats.length === 0);
  assert('no leader:ping-sent logged', findCaptured(env.cons.captured, 'debug', 'leader:ping-sent').length === 0);
  assert('no leader:heartbeat-start logged', findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-start').length === 0);

  // Existing broadcast still works
  const claims = ch._messages.filter(m => m.type === 'claim');
  assert('claim still posted with election off', claims.length === 1);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 68: v2.1.0 — Heartbeat Received Updates Liveness
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Heartbeat Updates Liveness (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Become observer
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });

  // Simulate heartbeat from owner
  env.bc.simulateRemote({ type: 'heartbeat', tabId: 'owner-tab', ts: Date.now() });

  assert('leader:heartbeat-recv logged', findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-recv').length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 69: v2.1.0 — Heartbeat from Non-Owner Ignored
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Heartbeat from Non-Owner Ignored (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Owner is 'owner-A'
  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-A', ts: Date.now() });

  // Heartbeat from different tab
  env.bc.simulateRemote({ type: 'heartbeat', tabId: 'impostor-B', ts: Date.now() });

  const recvLogs = findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-recv');
  assert('heartbeat from non-owner not logged as recv', recvLogs.length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 70: v2.1.0 — Rapid Open/Close: No Split-Brain
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Rapid Claims Resolve Cleanly (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  const ch = env.bc.instances[0];

  // Rapid-fire claims from 5 different tabs (simulating tabs opening and playing)
  for (let i = 0; i < 5; i++) {
    env.bc.simulateRemote({ type: 'claim', tabId: 'rapid-tab-' + i, ts: Date.now() });
  }

  const claimLogs = findCaptured(env.cons.captured, 'log', 'broadcast:remote-claim');
  assert('all 5 rapid claims processed', claimLogs.length === 5);

  // No yields — local tab lost ownership on first claim
  const yields = ch._messages.filter(m => m.type === 'yield');
  assert('no yields during rapid claims (isOwner was false)', yields.length === 0);

  // Heartbeat should have stopped after first remote claim
  const stopLogs = findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-stop');
  assert('heartbeat stopped during rapid claims', stopLogs.length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 71: v2.1.0 — Election Jitter Determinism
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Election Jitter is Deterministic (LOG_LEVEL=3)');

{
  // Use ownerStale=1 so stale detection triggers instantly
  const env1 = execVinyl({ logLevel: 3, ownerStale: 1 });
  const winListeners1 = {};
  env1.win.addEventListener = function (type, fn) {
    if (!winListeners1[type]) winListeners1[type] = [];
    winListeners1[type].push(fn);
  };
  env1.doc._htmlAttrs['data-theme'] = 'refined';
  const w1 = env1.exec();
  w1._fire('ready');

  const env2 = execVinyl({ logLevel: 3, ownerStale: 1 });
  const winListeners2 = {};
  env2.win.addEventListener = function (type, fn) {
    if (!winListeners2[type]) winListeners2[type] = [];
    winListeners2[type].push(fn);
  };
  env2.doc._htmlAttrs['data-theme'] = 'refined';
  const w2 = env2.exec();
  w2._fire('ready');

  // Establish owner with fresh claim on both, then let it go stale
  env1.bc.simulateRemote({ type: 'claim', tabId: 'dead-owner', ts: Date.now() });
  env2.bc.simulateRemote({ type: 'claim', tabId: 'dead-owner', ts: Date.now() });

  const busyWait = Date.now() + 5;
  while (Date.now() < busyWait) { /* spin */ }

  env1.doc.visibilityState = 'visible';
  env2.doc.visibilityState = 'visible';
  if (env1.doc._docListeners.visibilitychange) {
    env1.doc._docListeners.visibilitychange.forEach(fn => fn());
  }
  if (env2.doc._docListeners.visibilitychange) {
    env2.doc._docListeners.visibilitychange.forEach(fn => fn());
  }

  const e1Logs = findCaptured(env1.cons.captured, 'log', 'leader:election-start');
  const e2Logs = findCaptured(env2.cons.captured, 'log', 'leader:election-start');
  assert('env1 started election', e1Logs.length > 0);
  assert('env2 started election', e2Logs.length > 0);

  // Extract delay values from logs
  const delay1 = e1Logs[0].find(a => typeof a === 'object' && a !== null && 'delay' in a);
  const delay2 = e2Logs[0].find(a => typeof a === 'object' && a !== null && 'delay' in a);
  assert('delays are numbers', typeof delay1.delay === 'number' && typeof delay2.delay === 'number');
  assert('delays are within expected range (2000-3000)', delay1.delay >= 2000 && delay1.delay <= 3000);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 72: v2.1.0 — No Ping When FEATURE_BROADCAST=false
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — No Ping When Broadcast Off (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, featureBroadcast: false });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');

  assert('no BroadcastChannel instances', env.bc.instances.length === 0);
  assert('no leader:ping-sent', findCaptured(env.cons.captured, 'debug', 'leader:ping-sent').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 73: v2.1.0 — Owner Re-Claim After Stale Recovery
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Re-Claim After Stale Recovery (LOG_LEVEL=3)');

{
  /* Validates that after a stale owner is cleared — whether by
     election or yield — the local tab can re-claim ownership.
     Uses yield to simulate what the election resolution does
     (clearing ownerTabId), because syncTimers conflicts with
     the boot sequence's SILENCE_MS timeout. The election
     mechanism itself is validated in Suites 64, 65, and 71. */
  const env = execVinyl({ logLevel: 3 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Remote tab claims ownership
  env.bc.simulateRemote({ type: 'claim', tabId: 'remote-owner', ts: Date.now() });

  let phases = extractPhases(env.cons.captured);
  assert('paused after remote claim', phases[phases.length - 1] === 'paused');

  // Remote owner crashes — simulate recovery via yield
  // (in real usage, the election timer would clear ownerTabId)
  env.bc.simulateRemote({ type: 'yield', tabId: 'remote-owner', ts: Date.now() });

  // User re-plays — should succeed and reclaim ownership
  w._fire('play');
  phases = extractPhases(env.cons.captured);
  assert('playing again after recovery', phases[phases.length - 1] === 'playing');

  const ch = env.bc.instances[0];
  const claims = ch._messages.filter(m => m.type === 'claim');
  assert('new claim posted on re-play', claims.length >= 2);

  // Heartbeat should restart
  const hbStarts = findCaptured(env.cons.captured, 'debug', 'leader:heartbeat-start');
  assert('heartbeat restarted after re-claim', hbStarts.length >= 2);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 74: v2.1.0 — Hidden Tab Visibility Change Ignored
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Hidden Tab Ignored (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, ownerStale: 1 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  env.bc.simulateRemote({ type: 'claim', tabId: 'owner-tab', ts: Date.now() });

  const busyWait = Date.now() + 5;
  while (Date.now() < busyWait) { /* spin */ }

  // Tab becomes hidden (not visible) — should NOT trigger election
  env.doc.visibilityState = 'hidden';
  if (env.doc._docListeners.visibilitychange) {
    env.doc._docListeners.visibilitychange.forEach(fn => fn());
  }

  assert('no election on hidden', findCaptured(env.cons.captured, 'log', 'leader:election-start').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 75: v2.1.0 — Duplicate Election Prevention
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Duplicate Election Prevention (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3, ownerStale: 1 });

  const winListeners = {};
  env.win.addEventListener = function (type, fn) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };

  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');

  // Establish then stale the owner
  env.bc.simulateRemote({ type: 'claim', tabId: 'dead-owner', ts: Date.now() });
  const busyWait = Date.now() + 5;
  while (Date.now() < busyWait) { /* spin */ }

  // Trigger visibility change twice rapidly
  env.doc.visibilityState = 'visible';
  if (env.doc._docListeners.visibilitychange) {
    env.doc._docListeners.visibilitychange.forEach(fn => fn());
    env.doc._docListeners.visibilitychange.forEach(fn => fn());
  }

  const electionStarts = findCaptured(env.cons.captured, 'log', 'leader:election-start');
  assert('only one election started (pendingElection guard)', electionStarts.length === 1);
}

// ═══════════════════════════════════════════════════════════════
//  SUITE 76: v2.1.0 — Pong from Non-Owner During Claim is Ignored
// ═══════════════════════════════════════════════════════════════

suite('v2.1.0 — Stale Pong Dropped (LOG_LEVEL=3)');

{
  const env = execVinyl({ logLevel: 3 });
  env.doc._htmlAttrs['data-theme'] = 'refined';
  const w = env.exec();
  w._fire('ready');
  w._fire('play');  // local tab is owner

  // Simulate a pong from a very old timestamp (>15s)
  env.bc.simulateRemote({
    type: 'pong',
    tabId: 'ancient-tab',
    ts: Date.now() - 20000,
    payload: { side: 0, spinning: true, pos: 0, title: 'Old Track' }
  });

  // Stale message protection should drop it
  assert('stale pong dropped', findCaptured(env.cons.captured, 'debug', 'broadcast:stale').length > 0);
  assert('no pong-recv logged', findCaptured(env.cons.captured, 'log', 'leader:pong-recv').length === 0);
}

// ═══════════════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(56));
if (failed === 0) {
  console.log(`\x1b[32m  All ${passed} assertions passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m  ${failed} of ${passed + failed} assertions failed.\x1b[0m`);
}
console.log('═'.repeat(56));

process.exit(failed > 0 ? 1 : 0);
