/**
 * vinyl-test.mjs — Headless validation for vinyl.js v1.4.0
 *
 * Exercises vlog/vmark, persistence, and phase-machine pathways
 * via a minimal DOM shim.
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
    // Minimal — return a stub element for icon queries
    return new Element('svg');
  }
  querySelectorAll() { return []; }
  contains() { return false; }
  scrollIntoView() {}
  remove() {}
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
    head: { appendChild() {} },
    body: { appendChild() {} },
    _mutObservers: [],
    _elements: elements,
    _htmlAttrs: htmlAttrs,
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
      cb([{ title: 'Track A' }, { title: 'Track B' }, { title: 'Track C' }]);
    },
    getCurrentSoundIndex(cb) { cb(0); },
    _fire(event, data) { if (handlers[event]) handlers[event](data); },
  };
}

// ═══════════════════════════════════════════════════════════════
//  VINYL.JS LOADER — rewrites source and executes in sandbox
// ═══════════════════════════════════════════════════════════════

const vinylSrc = readFileSync('/sessions/happy-serene-ramanujan/mnt/Resume website/js/vinyl.js', 'utf-8');

function execVinyl({ logLevel = 3, featureObs = true, featureSM = true, mockSdkSuccess = true, syncTimers = false } = {}) {
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
    addEventListener() {},
    setTimeout: syncTimers ? function (fn) { fn(); return 0; } : globalThis.setTimeout,
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
    'location', 'MutationObserver', 'setTimeout', '__mockSdkSuccess',
    'SC',
    src
  );

  return { doc, ss, perf, cons, win, mockWidget, exec, setMockWidget };

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
    fn(win, doc, ss, perf, cons, win.location, win.MutationObserver, win.setTimeout, mockSdkSuccess, win.SC);
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
