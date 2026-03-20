/*
  vinyl.js — Chancellor Edwards
  Lightweight SoundCloud player, themed as a vinyl record setup.
  Active only in DND (refined) mode. Lazy-loads the SC Widget SDK.

  ── Naming theme: "Vinyl" ──────────────────────────────────────
  The player is a vinyl record setup that lives on a *stage*.
  Records sit in a *crate*. A *needle* handles playback.
  A *dial* controls volume. The *shelf* caches metadata.

  Vocabulary reference (for future contributors):
    stage    — root container (fixed-position widget)
    sleeve   — frosted-glass bar housing the controls
    marquee  — now-playing display area
    title    — current track name
    deck     — control-button group
    spin     — play / pause (record spinning)
    lift     — pause icon (needle lifted)
    hush     — mute toggle (silence)
    dial     — volume slider (like a receiver knob)
    crate    — playlist dropdown (a crate of records)
    latch    — button that opens / closes the crate
    needle   — SC.Widget instance (now encapsulated in adapter)
    groove   — canvas waveform progress visualization
    records  — array of track metadata
    shelf    — sessionStorage cache (records on a shelf)
    cont     — cross-page continuity state (sessionStorage)
    source   — hidden SoundCloud iframe
    glyph.*  — SVG icon elements
    el.*     — DOM element references
    phase    — lifecycle state (dormant/loading/ready/playing/paused/errored)
    channel  — BroadcastChannel instance for cross-tab sync
    upnext   — "Up Next" subtitle element in marquee

  Function verb families:
    fetch*     — load a resource from network
    warm*      — prepare / activate a lazy resource
    drop*      — initialise (drop the needle)
    catalog*   — parse & store metadata
    fill*      — populate UI from data
    reflect*   — sync UI element to current state
    toggle*    — flip a boolean UI state
    on*        — event handler
    safe*      — guarded wrapper (e.g. safePlay catches autoplay rejection)
    save/restore — persist / resume playback state across pages
    raise/lower — show / hide the stage
    transition — validated lifecycle phase change
    broadcast* — send cross-tab coordination messages
    format*    — convert raw values to display strings
    overture   — boot sequence

  v5.0.0-rc — Release candidate
    Phase 1: Persistence Engine extracted (store closure)
    Phase 2: Media Adapter extracted (adapter closure)
    Phase 3: Groove visualization added (groove closure)
    Phase 4-5: Controller, Sync, UI extracted for modular decomposition
    All SC.Widget access confined to adapter. Zero direct widget
    touchpoints outside the adapter boundary.
*/

(function () {
  'use strict';

  /* ── Configuration ───────────────────────────────────────── */

  var CRATE_URL      = 'https://soundcloud.com/chance-222067461/sets/website-music';
  var DEFAULT_VOLUME = 40;
  var SHELF_KEY      = 'ce-vinyl-shelf';
  var SHELF_TTL      = 30 * 60 * 1000;              // 30 min
  var SDK_URL        = 'https://w.soundcloud.com/player/api.js';
  var SILENCE_MS     = 10000;                        // "Unavailable" timeout
  var CONT_KEY       = 'ce-vinyl-cont';              // cross-page continuity
  var CONT_TTL       = 30000;                        // 30 s — stale after navigation

  /* ── Feature gates (v1.1.0) ────────────────────────────── */
  /*    Flip to false to disable all resilience enhancements   */
  /*    and restore original behaviour. Zero-regression path.  */

  var FEATURE_RESILIENCE = true;
  var SDK_MAX_RETRIES    = 2;                        // additional attempts after first failure
  var SDK_RETRY_BASE     = 2000;                     // ms — doubles each attempt (2s, 4s)

  /* ── Feature gates (v1.2.0) ────────────────────────────── */
  /*    Structured logging + performance marks. Zero output    */
  /*    at LOG_LEVEL 0. Set LOG_LEVEL via URL param for debug: */
  /*      ?vinyl-log=3  (0=silent, 1=warn, 2=info, 3=debug)   */

  var FEATURE_OBSERVABILITY = true;

  /* ── Feature gates (v1.3.0) ────────────────────────────── */
  /*    Enhanced persistence: schemaed continuity payloads     */
  /*    and versioned shelf cache. Flip to false to restore    */
  /*    original save/restore and unversioned shelf.           */

  var FEATURE_ENHANCED_PERSISTENCE = true;
  var SHELF_VERSION = 1;                               // bump to invalidate all cached shelves
  var CONT_SCHEMA   = 1;                               // continuity payload schema version

  /* ── Feature gates (v1.4.0) ────────────────────────────── */
  /*    Explicit lifecycle state machine. Governs loading,     */
  /*    ready, playing, paused, and errored transitions.       */
  /*    Flip to false to restore implicit boolean governance.  */

  var FEATURE_STATE_MACHINE = true;

  /* ── Feature gates (v2.0.0) ────────────────────────────── */
  /*    Cross-tab coordination via BroadcastChannel +          */
  /*    enhanced crate UX with "Up Next" display.              */
  /*    Flip individually to false for surgical rollback.      */

  var FEATURE_BROADCAST = true;
  var CHANNEL_NAME      = 'ce-vinyl';
  var SYNC_THROTTLE     = 5000;                      // ms between broadcast syncs
  var OWNER_STALE       = 15000;                     // ms — presume owner gone after silence

  var FEATURE_CRATE_V2 = true;

  /* ── Feature gates (v2.1.0) ────────────────────────────── */
  /*    Leadership election: formal ownership discovery,       */
  /*    heartbeat liveness, and stale-owner recovery.          */
  /*    Layers on FEATURE_BROADCAST — noop if broadcast off.   */
  /*    Flip to false to restore basic claim/yield model.      */

  var FEATURE_LEADER_ELECTION = true;
  var HEARTBEAT_MS   = 4000;                      // owner heartbeat interval
  var ELECTION_DELAY = 2000;                      // base wait before stale-owner cleanup

  /* ── Feature gates (v3.0.0) ────────────────────────────── */
  /*    Ownership hardening: stable session identity across    */
  /*    same-tab navigations, graceful yield semantics that    */
  /*    distinguish pause from tab-close, yield-grace window   */
  /*    to absorb same-tab navigation transients, and claim    */
  /*    epoch ordering for deterministic conflict resolution.  */
  /*    Layers on FEATURE_BROADCAST + FEATURE_LEADER_ELECTION. */
  /*    Flip to false to restore v2.1 coordination model.      */

  var FEATURE_OWNERSHIP_V3  = true;
  var TAB_ID_KEY            = 'ce-vinyl-tab';     // sessionStorage key for stable identity
  var YIELD_GRACE_MS        = 800;                // ms — grace period before clearing yielded owner
  var CLAIM_EPOCH_KEY       = 'ce-vinyl-epoch';   // sessionStorage key for monotonic claim counter

  /* ── Feature gates (v3.1.0) ────────────────────────────── */
  /*    Sleeve visual refresh: "future nostalgia" aesthetic    */
  /*    with glassmorphism depth, left-aligned crate text,    */
  /*    and numerical index removal. Pure CSS + minor label    */
  /*    changes — no behavioral or state machine changes.      */
  /*    Flip to false to restore v2 crate/sleeve appearance.   */

  var FEATURE_SLEEVE_V3 = true;

  /* ── Feature gates (v4.0.0) ────────────────────────────── */
  /*    Cross-page continuity hardening. Detects same-tab      */
  /*    navigation via a sessionStorage marker and suppresses  */
  /*    the ownership yield on page exit, sending an early     */
  /*    reclaim on the new page's boot instead. This closes    */
  /*    the window where other tabs might think the owner is   */
  /*    gone during a same-tab page transition.                */
  /*    Layers on FEATURE_BROADCAST + FEATURE_OWNERSHIP_V3.    */
  /*    Flip to false to restore v3.0 yield-on-exit behavior.  */

  var FEATURE_CONTINUITY_V4 = true;
  var NAV_MARKER_KEY         = 'ce-vinyl-nav';   // sessionStorage: '1' during page transition
  var V4_YIELD_GRACE_MS      = 3000;             // wider grace window for slower connections

  /* ── Feature gates (v5.0.0) ────────────────────────────── */
  /*    Groove: canvas-based waveform progress visualization.  */
  /*    Renders a seeded pseudo-random waveform per track      */
  /*    with progress fill driven by PLAY_PROGRESS events.     */
  /*    Pure visual addition — no behavioral or state changes. */
  /*    Flip to false to hide the waveform entirely.           */

  var FEATURE_GROOVE     = true;
  var GROOVE_BARS        = 48;                   // number of waveform bars
  var GROOVE_BAR_GAP     = 1;                    // px gap between bars
  var GROOVE_MIN_HEIGHT  = 0.15;                 // minimum bar height (fraction of canvas)
  var GROOVE_DPR         = (function () { try { return Math.min(window.devicePixelRatio || 1, 3); } catch (e) { return 1; } })();

  var LOG_LEVEL = (function () {
    if (!FEATURE_OBSERVABILITY) return 0;
    try {
      var m = location.search.match(/[?&]vinyl-log=(\d)/);
      return m ? parseInt(m[1], 10) : 0;
    } catch (e) { return 0; }
  })();

  /* ══════════════════════════════════════════════════════════════
     Persistence Engine (v5.0.0 — Phase 1 extraction)

     Pure data layer owning all sessionStorage reads and writes.
     No DOM access, no side effects, no network calls.
     Every function wraps in try/catch — storage unavailability
     returns null/false, never throws.

     Extracted from:
       shelfRead, shelfWrite           → store.shelfRead, store.shelfWrite
       saveState (storage portion)     → store.continuitySave
       restoreState (storage portion)  → store.continuityRestore
       initTabId                       → store.getTabId
       initClaimEpoch                  → store.getClaimEpoch
       persistClaimEpoch               → store.persistEpoch
       NAV_MARKER_KEY read/write       → store.consumeNavMarker, store.setNavMarker

     Backward compatibility:
       - All storage keys unchanged (SHELF_KEY, CONT_KEY, TAB_ID_KEY, etc.)
       - Schema versions unchanged (SHELF_VERSION, CONT_SCHEMA)
       - TTL enforcement unchanged (SHELF_TTL, CONT_TTL)
       - Feature gate behavior unchanged (FEATURE_ENHANCED_PERSISTENCE, FEATURE_OWNERSHIP_V3, etc.)
     ══════════════════════════════════════════════════════════════ */

  var store = (function () {

    /* ── Health ────────────────────────────────────────────────
       Tests sessionStorage accessibility. Returns false in
       private browsing modes or sandboxed iframes where
       sessionStorage is either absent or throws on access. */

    function isAvailable() {
      try {
        var k = '__vinyl_probe__';
        sessionStorage.setItem(k, '1');
        sessionStorage.removeItem(k);
        return true;
      } catch (e) { return false; }
    }

    /* ── Shelf: track metadata cache ─────────────────────────
       Key:  SHELF_KEY ('ce-vinyl-shelf')
       TTL:  SHELF_TTL (30 min)
       Schema: { v?: number, ts: number, data: TrackMeta[] }
       Returns: TrackMeta[] | null */

    function shelfRead() {
      try {
        var raw = sessionStorage.getItem(SHELF_KEY);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        /* v1.3.0: reject cache if shelf schema version doesn't match */
        if (FEATURE_ENHANCED_PERSISTENCE && obj.v !== SHELF_VERSION) {
          vlog(3, 'shelf:version-mismatch', { cached: obj.v, expected: SHELF_VERSION });
          return null;
        }
        if (Date.now() - obj.ts > SHELF_TTL) return null;
        return obj.data;
      } catch (e) { return null; }
    }

    function shelfWrite(data) {
      try {
        var payload = { ts: Date.now(), data: data };
        if (FEATURE_ENHANCED_PERSISTENCE) payload.v = SHELF_VERSION;
        sessionStorage.setItem(SHELF_KEY, JSON.stringify(payload));
      } catch (e) { /* quota exceeded or private mode — safe to ignore */ }
    }

    function shelfClear() {
      try { sessionStorage.removeItem(SHELF_KEY); } catch (e) {}
    }

    /* ── Continuity: cross-page playback state ───────────────
       Key:  CONT_KEY ('ce-vinyl-cont')
       TTL:  CONT_TTL (30 s)
       Schema: { v?: number, ts: number, side: number,
                 spinning: bool, pos: number, vol?: number,
                 hushed?: bool }
       continuityRestore is consume-on-read: deletes after returning.
       continuityPeek is non-destructive. */

    function continuitySave(payload) {
      try {
        sessionStorage.setItem(CONT_KEY, JSON.stringify(payload));
      } catch (e) {}
    }

    function continuityRestore() {
      try {
        var raw = sessionStorage.getItem(CONT_KEY);
        if (!raw) return null;
        var state = JSON.parse(raw);
        sessionStorage.removeItem(CONT_KEY);              // consume-on-read
        if (Date.now() - state.ts > CONT_TTL) {
          vlog(3, 'continuity:stale', { age: Date.now() - state.ts });
          return null;                                    // stale — discard
        }
        return state;
      } catch (e) { return null; }
    }

    function continuityPeek() {
      try {
        var raw = sessionStorage.getItem(CONT_KEY);
        if (!raw) return null;
        var state = JSON.parse(raw);
        if (Date.now() - state.ts > CONT_TTL) return null;
        return state;
      } catch (e) { return null; }
    }

    /* ── Identity: stable tab ID across same-tab navigations ─
       Key:  TAB_ID_KEY ('ce-vinyl-tab')
       When FEATURE_OWNERSHIP_V3 is on, persists the tabId in
       sessionStorage so navigating index→projects→about keeps
       the same identity. When off, generates a fresh ID every
       page load (v2.1 behavior). */

    function getTabId() {
      if (FEATURE_OWNERSHIP_V3) {
        try {
          var stored = sessionStorage.getItem(TAB_ID_KEY);
          if (stored) return stored;
        } catch (e) { /* private mode — fall through to fresh id */ }
      }
      var fresh = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      if (FEATURE_OWNERSHIP_V3) {
        try { sessionStorage.setItem(TAB_ID_KEY, fresh); } catch (e) {}
      }
      return fresh;
    }

    /* ── Claim epoch: monotonic counter for conflict resolution
       Key:  CLAIM_EPOCH_KEY ('ce-vinyl-epoch')
       persistEpoch writes the given value to storage.
       getClaimEpoch reads the current persisted value. */

    function getClaimEpoch() {
      if (!FEATURE_OWNERSHIP_V3) return 0;
      try {
        var stored = sessionStorage.getItem(CLAIM_EPOCH_KEY);
        return stored ? parseInt(stored, 10) || 0 : 0;
      } catch (e) { return 0; }
    }

    function persistEpoch(epoch) {
      if (!FEATURE_OWNERSHIP_V3) return;
      try { sessionStorage.setItem(CLAIM_EPOCH_KEY, String(epoch)); } catch (e) {}
    }

    /* ── Navigation marker (v4.0.0) ──────────────────────────
       Key:  NAV_MARKER_KEY ('ce-vinyl-nav')
       Set before pagehide when owner navigates within site.
       Consumed on the new page's boot to reclaim ownership
       without a gap. */

    function setNavMarker() {
      try { sessionStorage.setItem(NAV_MARKER_KEY, '1'); } catch (e) {}
    }

    function consumeNavMarker() {
      try {
        var marker = sessionStorage.getItem(NAV_MARKER_KEY);
        if (marker) {
          sessionStorage.removeItem(NAV_MARKER_KEY);
          return true;
        }
        return false;
      } catch (e) { return false; }
    }

    /* ── Public API ──────────────────────────────────────────── */

    return {
      isAvailable:       isAvailable,
      shelfRead:         shelfRead,
      shelfWrite:        shelfWrite,
      shelfClear:        shelfClear,
      continuitySave:    continuitySave,
      continuityRestore: continuityRestore,
      continuityPeek:    continuityPeek,
      getTabId:          getTabId,
      getClaimEpoch:     getClaimEpoch,
      persistEpoch:      persistEpoch,
      setNavMarker:      setNavMarker,
      consumeNavMarker:  consumeNavMarker
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     SoundCloud Adapter (v5.0.0 — Phase 2 extraction)

     Thin abstraction layer over SC.Widget. Owns the raw widget
     instance and every direct SDK call. No external code touches
     SC.Widget methods or SC.Widget.Events — only this adapter.

     Responsibilities:
       - SC.Widget interface validation (was in dropNeedle)
       - Widget instance creation and lifecycle
       - Event binding with human-readable names
       - Playback methods with null-safety guards
       - Autoplay-safe play with rejection callback (was safePlay)
       - SoundCloud embed URL construction (was warmSource body)

     NOT responsible for:
       - SDK script loading (fetchSDK — network/DOM concern)
       - Phase transitions (controller concern)
       - Broadcast coordination (sync layer concern)
       - DOM updates (UI concern)

     Backward compatibility:
       - Test mocks (createMockWidget with ._fire) work unchanged
       - SC.Widget.Events constant names preserved
       - All callback signatures preserved
     ══════════════════════════════════════════════════════════════ */

  var adapter = (function () {

    var widget = null;                               // SC.Widget instance

    /* ── Validation ──────────────────────────────────────────
       Verify SC.Widget is callable and exposes the Events map.
       Catches SDK shape changes before they surface as cryptic
       runtime errors. Mirrors the v1.1.0 validation logic. */

    function validate() {
      return window.SC && window.SC.Widget &&
        (FEATURE_RESILIENCE
          ? typeof SC.Widget === 'function' && SC.Widget.Events && SC.Widget.Events.READY
          : true);
    }

    /* ── Lifecycle ───────────────────────────────────────────
       init(iframe) creates the widget.
       Returns true on success, false if validation fails.
       destroy() tears down the reference. */

    function init(iframe) {
      if (!validate()) return false;
      widget = SC.Widget(iframe);
      return true;
    }

    function destroy() {
      widget = null;
    }

    function isInit() {
      return !!widget;
    }

    /* ── Event binding ───────────────────────────────────────
       Translates human-readable event names to SC.Widget.Events
       constants. The SC global must be available when on() is
       called — it always is, because on() runs after fetchSDK
       has loaded the SDK script.

       Supported names:
         ready, play, pause, finish, progress, error */

    function on(event, handler) {
      if (!widget) return;
      var map = {
        ready:    SC.Widget.Events.READY,
        play:     SC.Widget.Events.PLAY,
        pause:    SC.Widget.Events.PAUSE,
        finish:   SC.Widget.Events.FINISH,
        progress: SC.Widget.Events.PLAY_PROGRESS,
        error:    SC.Widget.Events.ERROR
      };
      var scEvent = map[event];
      if (scEvent) widget.bind(scEvent, handler);
    }

    /* ── Playback ────────────────────────────────────────────
       All methods are null-safe: noop if widget is absent. */

    function play() {
      if (!widget) return undefined;
      return widget.play();
    }

    function pause() {
      if (!widget) return;
      widget.pause();
    }

    function seekTo(ms) {
      if (!widget) return;
      widget.seekTo(ms);
    }

    function skip(index) {
      if (!widget) return;
      widget.skip(index);
    }

    /* ── Volume ──────────────────────────────────────────────── */

    function setVolume(level) {
      if (!widget) return;
      widget.setVolume(level);
    }

    /* ── Metadata ────────────────────────────────────────────── */

    function getSounds(cb) {
      if (!widget) { if (cb) cb([]); return; }
      widget.getSounds(cb);
    }

    function getCurrentIndex(cb) {
      if (!widget) { if (cb) cb(0); return; }
      widget.getCurrentSoundIndex(cb);
    }

    /* ── Autoplay-safe play ──────────────────────────────────
       Wraps widget.play() with Promise rejection handling.
       If autoplay is blocked, calls onBlocked() so the caller
       can revert phase and UI without knowing Promise mechanics.

       This was the standalone safePlay() function in v4.0.0. */

    function safePlay(onBlocked) {
      if (!widget) return;
      try {
        var result = widget.play();
        if (result && typeof result.catch === 'function') {
          result.catch(function () {
            if (onBlocked) onBlocked();
          });
        }
      } catch (e) {
        /* Defensive: older SC Widget versions may not return a Promise */
        if (onBlocked) onBlocked();
      }
    }

    /* ── Embed URL construction ──────────────────────────────
       Builds the SoundCloud widget embed URL for a playlist.
       Enforces auto_play=false for autoplay policy compliance. */

    function buildEmbedUrl(playlistUrl) {
      return 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(playlistUrl) +
        '&auto_play=false&show_artwork=false&visual=false' +
        '&buying=false&sharing=false&download=false' +
        '&show_playcount=false&show_comments=false&color=%237b5e7b';
    }

    /* ── Public API ──────────────────────────────────────────── */

    return {
      validate:        validate,
      init:            init,
      destroy:         destroy,
      isInit:          isInit,
      on:              on,
      play:            play,
      pause:           pause,
      seekTo:          seekTo,
      skip:            skip,
      setVolume:       setVolume,
      getSounds:       getSounds,
      getCurrentIndex: getCurrentIndex,
      safePlay:        safePlay,
      buildEmbedUrl:   buildEmbedUrl
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     Groove — waveform progress visualization (v5.0.0)

     Canvas-based progress bar that renders a seeded pseudo-random
     waveform for each track. The seed is derived from the track
     title, so the waveform is deterministic and consistent across
     page loads. Progress fill is driven by PLAY_PROGRESS events.

     No behavioral changes. No adapter/store/FSM interaction beyond
     reading lastPosition and the current record's duration.
     Fully gated behind FEATURE_GROOVE.

     Public surface:
       groove.mount(container)  — creates canvas, appends to container
       groove.seed(title)       — generates waveform data for a track
       groove.update(fraction)  — repaints with progress fill [0..1]
       groove.clear()           — resets to empty state
       groove.destroy()         — removes canvas from DOM
     ══════════════════════════════════════════════════════════════ */

  var groove = (function () {
    if (!FEATURE_GROOVE) return {
      mount: function () {},
      seed:  function () {},
      update: function () {},
      clear:  function () {},
      destroy: function () {}
    };

    var canvas  = null;
    var ctx     = null;
    var bars    = null;      // Float32Array of bar heights [0..1]
    var lastFrac = -1;       // last rendered fraction (avoids redundant paints)

    /* ── Seeded PRNG (mulberry32) ─────────────────────────── */
    /*    Deterministic per-title waveform generation.          */

    function hashTitle(str) {
      var h = 0x811c9dc5;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    }

    function mulberry32(seed) {
      return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /* ── Generate bar heights from track title ────────────── */

    function generateBars(title) {
      var rng = mulberry32(hashTitle(title || 'untitled'));
      var b   = new Float32Array(GROOVE_BARS);
      for (var i = 0; i < GROOVE_BARS; i++) {
        /* Shape: higher toward center, with randomised variance.
           Creates an organic, audio-feeling envelope.            */
        var center = (i / (GROOVE_BARS - 1)) * 2 - 1;    // [-1..1]
        var envelope = 1 - center * center * 0.4;          // parabolic falloff
        var raw = rng() * 0.6 + 0.4;                      // random component [0.4..1.0]
        b[i] = Math.max(GROOVE_MIN_HEIGHT, raw * envelope);
      }
      return b;
    }

    /* ── Render ────────────────────────────────────────────── */

    function render(frac) {
      if (!ctx || !bars) return;
      var w = canvas.width;
      var h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      var dpr      = GROOVE_DPR;
      var gap      = GROOVE_BAR_GAP * dpr;
      var total    = GROOVE_BARS;
      var barW     = Math.max(1, (w - gap * (total - 1)) / total);
      var fillX    = frac * w;

      /* Colours: filled = amber accent, unfilled = muted lavender */
      var filled   = 'rgba(186, 155, 100, 0.85)';   // --amber-ish
      var unfilled = 'rgba(192, 178, 190, 0.35)';    // --border-ish

      for (var i = 0; i < total; i++) {
        var x     = i * (barW + gap);
        var barH  = bars[i] * h;
        var y     = (h - barH) / 2;                   // vertically centred

        ctx.fillStyle = (x + barW <= fillX) ? filled
                      : (x >= fillX) ? unfilled
                      : filled;                        // partial bar → filled colour
        /* Round the bar ends with a small radius */
        var r = Math.min(barW / 2, 2 * dpr);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + barW - r, y);
        ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
        ctx.lineTo(x + barW, y + barH - r);
        ctx.quadraticCurveTo(x + barW, y + barH, x + barW - r, y + barH);
        ctx.lineTo(x + r, y + barH);
        ctx.quadraticCurveTo(x, y + barH, x, y + barH - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.fill();
      }
    }

    /* ── Public API ───────────────────────────────────────── */

    function mount(container) {
      if (canvas) return;
      canvas = document.createElement('canvas');
      canvas.className = 'vinyl-groove';
      canvas.setAttribute('aria-hidden', 'true');

      /* Defensive: canvas.getContext may not exist in headless/test envs */
      if (typeof canvas.getContext !== 'function') {
        canvas = null;
        return;
      }

      /* Size to container, respecting DPR for crisp rendering */
      var rect = container.getBoundingClientRect
        ? container.getBoundingClientRect()
        : { width: 64, height: 20 };
      var dpr = GROOVE_DPR;
      canvas.style.width  = '100%';
      canvas.style.height = '100%';
      canvas.width  = Math.round(rect.width * dpr) || 128;
      canvas.height = Math.round(rect.height * dpr) || 40;
      ctx = canvas.getContext('2d');
      container.appendChild(canvas);
    }

    function seed(title) {
      bars = generateBars(title);
      lastFrac = -1;
      render(0);
    }

    function update(frac) {
      frac = Math.max(0, Math.min(1, frac));
      /* Skip repaint if fraction didn't change enough (< 0.2% = invisible) */
      if (Math.abs(frac - lastFrac) < 0.002) return;
      lastFrac = frac;
      render(frac);
    }

    function clear() {
      bars = null;
      lastFrac = -1;
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function destroy() {
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      ctx = null;
      bars = null;
      lastFrac = -1;
    }

    return {
      mount:   mount,
      seed:    seed,
      update:  update,
      clear:   clear,
      destroy: destroy
    };
  })();

  /* ── Shared IIFE scope utilities ───────────────────────────── */

  function $(id)       { return document.getElementById(id); }
  function isDND()  { return document.documentElement.getAttribute('data-theme') === 'refined'; }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '';
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── Observability primitives (v1.2.0) ──────────────────── */
  /*    vlog(level, event, data?)  — structured console output  */
  /*    vmark(name)               — Performance Timeline marks  */
  /*    Both are noops when FEATURE_OBSERVABILITY is false or   */
  /*    LOG_LEVEL is 0, preserving zero default-mode cost.      */

  function vlog(level, event, data) {
    if (!FEATURE_OBSERVABILITY || level > LOG_LEVEL) return;
    var tag = '[vinyl] ' + event;
    if (level <= 1) console.warn(tag, data !== undefined ? data : '');
    else if (level <= 2) console.log(tag, data !== undefined ? data : '');
    else console.debug(tag, data !== undefined ? data : '');
  }

  function vmark(name) {
    if (!FEATURE_OBSERVABILITY || !LOG_LEVEL) return;
    if (window.performance && performance.mark) performance.mark('vinyl:' + name);
  }

  /* ══════════════════════════════════════════════════════════════
     Controller (v5.0.0 — Phase 4 extraction)

     Playback state machine and FSM logic. Owns:
       - Playback state (spinning, phase, currentSide, lastPosition)
       - Mute state (hushed, savedVolume)
       - Records catalog and shelf management
       - SDK/widget initialization and lifecycle
       - Playback command processing

     Wired dependencies: _sync and _ui (set via wire())
     ══════════════════════════════════════════════════════════════ */

  var controller = (function () {

    var _sync = null;                                // wired sync module
    var _ui = null;                                  // wired ui module

    var spinning      = false;
    var hushed        = false;
    var savedVolume   = DEFAULT_VOLUME;
    var records       = [];
    var currentSide   = 0;
    var sdkReady      = false;
    var sdkPending    = false;
    var sourceReady   = false;
    var needleDropped = false;
    var lastSidePoll  = 0;
    var lastPosition  = 0;
    var phase         = 'dormant';

    var LEGAL_MOVES = {
      dormant:  ['loading'],
      loading:  ['ready', 'errored'],
      ready:    ['playing', 'errored'],
      playing:  ['paused', 'ready', 'errored'],
      paused:   ['playing', 'ready', 'errored'],
      errored:  []
    };

    function wire(deps) {
      _sync = deps.sync;
      _ui = deps.ui;
    }

    function transition(to, reason) {
      if (!FEATURE_STATE_MACHINE) return true;
      var from = phase;
      if (from === to) return true;
      var legal = LEGAL_MOVES[from];
      if (!legal || legal.indexOf(to) === -1) {
        vlog(1, 'phase:rejected', { from: from, to: to, reason: reason });
        return false;
      }
      phase = to;
      vlog(3, 'phase:' + to, { from: from, reason: reason });
      vmark('phase:' + to);
      return true;
    }

    function phaseAllowsInteraction() {
      return !FEATURE_STATE_MACHINE || phase === 'ready' || phase === 'playing' || phase === 'paused';
    }

    function shelfRead() {
      return store.shelfRead();
    }

    function shelfWrite(data) {
      store.shelfWrite(data);
    }

    function saveState() {
      if (!sourceReady) return;
      var payload = {
        side: currentSide,
        spinning: spinning,
        pos: lastPosition || 0,
        ts: Date.now()
      };
      if (FEATURE_ENHANCED_PERSISTENCE) {
        payload.v = CONT_SCHEMA;
        payload.vol = _ui.getDialValue();
        payload.hushed = hushed;
      }
      store.continuitySave(payload);
      vlog(3, 'continuity:saved', { side: payload.side, pos: payload.pos, vol: payload.vol, hushed: payload.hushed });
    }

    function restoreState() {
      var state = store.continuityRestore();
      if (!state) return;

      if (typeof state.side === 'number' && state.side !== currentSide) {
        currentSide = state.side;
        adapter.skip(state.side);
      }
      if (state.pos > 0) adapter.seekTo(state.pos);

      if (FEATURE_ENHANCED_PERSISTENCE && state.v >= CONT_SCHEMA) {
        if (typeof state.vol === 'number') {
          adapter.setVolume(state.hushed ? 0 : state.vol);
          _ui.setDialValue(state.hushed ? 0 : state.vol);
          savedVolume = state.vol;
        }
        if (state.hushed) {
          hushed = true;
          _ui.reflectVolume();
        }
      } else if (FEATURE_ENHANCED_PERSISTENCE && !state.v) {
        vlog(3, 'continuity:schema-fallback', { v: state.v || 0 });
      }

      if (state.spinning) safePlay();
      vlog(2, 'continuity:restored', {
        side: state.side, pos: state.pos, spinning: state.spinning,
        vol: state.vol, hushed: state.hushed
      });
      vmark('continuity:restored');
      _ui.reflectTitle();
      _ui.reflectCrate();
    }

    function fetchSDK(cb, attempt) {
      if (sdkReady) return cb();
      if (sdkPending) return;
      sdkPending = true;
      attempt = (FEATURE_RESILIENCE && typeof attempt === 'number') ? attempt : 0;

      var s    = document.createElement('script');
      s.src    = SDK_URL;
      s.onload = function () {
        sdkReady   = true;
        sdkPending = false;
        vlog(2, 'sdk:loaded', attempt > 0 ? { attempts: attempt + 1 } : undefined);
        vmark('sdk:loaded');
        cb();
      };
      s.onerror = function () {
        sdkPending = false;
        if (FEATURE_RESILIENCE && attempt < SDK_MAX_RETRIES) {
          var delay = SDK_RETRY_BASE * Math.pow(2, attempt);
          console.warn('[vinyl] SDK load failed, retrying in ' + delay + 'ms (attempt ' + (attempt + 1) + '/' + SDK_MAX_RETRIES + ').');
          setTimeout(function () { fetchSDK(cb, attempt + 1); }, delay);
        } else {
          console.warn('[vinyl] SoundCloud Widget SDK failed to load.');
          _ui.setTitle('Unavailable');
          transition('errored', 'sdk-failed');
        }
      };
      document.head.appendChild(s);
    }

    function warmSource() {
      var source = _ui.getSource();
      if (source.src && source.src !== 'about:blank') return;
      source.src = adapter.buildEmbedUrl(CRATE_URL);
    }

    function safePlay() {
      adapter.safePlay(function onBlocked() {
        if (phase === 'playing') transition('ready', 'autoplay-blocked');
        spinning = false;
        _ui.reflectSpin();
      });
    }

    function dropNeedle() {
      if (needleDropped) return;
      if (!adapter.init(_ui.getSource())) {
        _ui.setTitle('Unavailable');
        console.warn('[vinyl] SC.Widget interface validation failed.');
        transition('errored', 'widget-invalid');
        return;
      }

      needleDropped = true;

      adapter.on('ready', function () {
        sourceReady = true;
        vlog(2, 'widget:ready');
        vmark('widget:ready');
        adapter.setVolume(DEFAULT_VOLUME);
        catalogRecords();
      });

      adapter.on('play', function () {
        if (FEATURE_STATE_MACHINE && !transition('playing', 'play-event')) return;
        spinning = true;
        _ui.reflectSpin();
        _sync.claim();
      });

      adapter.on('pause', function () {
        if (FEATURE_STATE_MACHINE && !transition('paused', 'pause-event')) return;
        spinning = false;
        _ui.reflectSpin();
        saveState();
        if (FEATURE_OWNERSHIP_V3) {
          _sync.pauseRetain();
        } else {
          _sync.yieldOwnership('pause');
        }
      });

      adapter.on('finish', function () {
        transition('ready', 'track-finished');
        spinning = false;
        _ui.reflectSpin();
        if (FEATURE_GROOVE) groove.update(1);
      });

      adapter.on('progress', function (data) {
        if (data && data.currentPosition) lastPosition = data.currentPosition;
        if (FEATURE_GROOVE && records[currentSide] && records[currentSide].duration) {
          groove.update(lastPosition / records[currentSide].duration);
        }
        _sync.broadcastSync();
        if (records.length < 2) return;
        var now = Date.now();
        if (now - lastSidePoll < 1000) return;
        lastSidePoll = now;
        adapter.getCurrentIndex(function (side) {
          if (side !== currentSide) {
            currentSide = side;
            _ui.reflectTitle();
            _ui.reflectCrate();
          }
        });
      });

      adapter.on('error', function () {
        transition('errored', 'widget-error');
        spinning = false;
        _ui.reflectSpin();
        if (FEATURE_GROOVE) groove.clear();
        _ui.setTitle('Unavailable');
        console.warn('[vinyl] SoundCloud widget encountered an error.');
      });

      setTimeout(function () {
        if (!sourceReady && _ui.getTitle() === 'Loading\u2026') {
          _ui.setTitle('Unavailable');
          transition('errored', 'ready-timeout');
        }
      }, SILENCE_MS);
    }

    function catalogRecords() {
      var cached = shelfRead();
      if (cached && cached.length) {
        records = cached;
        vlog(3, 'catalog:shelf-hit', { tracks: cached.length });
        _ui.fillCrate();
        _ui.reflectTitle();
        transition('ready', 'catalog-shelf');
        restoreState();
        return;
      }

      adapter.getSounds(function (sounds) {
        if (!sounds || !sounds.length) {
          vlog(1, 'catalog:empty');
          _ui.setTitle('Empty playlist');
          transition('errored', 'catalog-empty');
          return;
        }
        records = sounds.map(function (s, i) {
          var rec = { title: s.title || 'Track ' + (i + 1), index: i };
          if (FEATURE_CRATE_V2 && s.duration) rec.duration = s.duration;
          return rec;
        });
        vlog(2, 'catalog:fetched', { tracks: records.length });
        vmark('catalog:done');
        shelfWrite(records);
        _ui.fillCrate();
        _ui.reflectTitle();
        transition('ready', 'catalog-fetched');
        restoreState();
      });
    }

    function handleRemoteClaim() {
      if (spinning && adapter.isInit()) {
        adapter.pause();
        spinning = false;
        transition('paused', 'remote-claim');
        _ui.reflectSpin();
      }
    }

    function activate() {
      vlog(2, 'stage:raise');
      vmark('stage:raise');
      if (phase === 'dormant') transition('loading', 'sdk-bootstrap');
      warmSource();
      if (!needleDropped) fetchSDK(dropNeedle);
    }

    function deactivate() {
      if (adapter.isInit() && spinning) adapter.pause();
      if (FEATURE_OWNERSHIP_V3 && _sync.isOwner()) _sync.yieldOwnership('dnd-off');
    }

    function mute() {
      savedVolume = _ui.getDialValue() || DEFAULT_VOLUME;
      adapter.setVolume(0);
      _ui.setDialValue(0);
      hushed = true;
      _ui.reflectVolume();
    }

    function unmute() {
      adapter.setVolume(savedVolume);
      _ui.setDialValue(savedVolume);
      hushed = false;
      _ui.reflectVolume();
    }

    function setVolume(v) {
      adapter.setVolume(v);
      hushed = v === 0;
      if (v > 0) savedVolume = v;
      _ui.reflectVolume();
    }

    return {
      wire: wire,
      isSpinning: function () { return spinning; },
      isHushed: function () { return hushed; },
      getSavedVolume: function () { return savedVolume; },
      getRecords: function () { return records; },
      getCurrentSide: function () { return currentSide; },
      getCurrentRecord: function () { return records[currentSide]; },
      getLastPosition: function () { return lastPosition; },
      getPhase: function () { return phase; },
      isSourceReady: function () { return sourceReady; },
      phaseAllowsInteraction: phaseAllowsInteraction,
      isReady: function () { return adapter.isInit() && phaseAllowsInteraction(); },
      transition: transition,
      play: safePlay,
      pause: function () { adapter.pause(); },
      skip: function (index) { adapter.skip(index); },
      mute: mute,
      unmute: unmute,
      setVolume: setVolume,
      handleRemoteClaim: handleRemoteClaim,
      activate: activate,
      deactivate: deactivate,
      saveState: saveState,
      getSnapshot: function () {
        return { phase: phase, spinning: spinning, records: records, currentSide: currentSide, lastPosition: lastPosition, sourceReady: sourceReady };
      }
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     Sync (v5.0.0 — Phase 5 extraction)

     Cross-tab coordination via BroadcastChannel. Owns:
       - Ownership state and remote state tracking
       - Heartbeat and leader election
       - Message dispatch and reception
       - Yield grace window management

     Wired dependencies: _ctrl and _ui (set via wire())
     ══════════════════════════════════════════════════════════════ */

  var sync = (function () {

    var _ctrl = null;                                // wired controller module
    var _ui = null;                                  // wired ui module

    var channel       = null;
    var tabId         = '';
    var isOwner       = false;
    var lastSync      = 0;
    var ownerTabId    = '';
    var lastOwnerSeen = 0;
    var remoteState   = null;
    var heartbeatTimer  = null;
    var electionTimer   = null;
    var pendingElection = false;
    var yieldGraceTimer = null;
    var claimEpoch      = 0;

    function wire(deps) {
      _ctrl = deps.ctrl;
      _ui = deps.ui;
    }

    function initTabId() {
      var id = store.getTabId();
      vlog(3, 'identity:resolved', { tabId: id });
      return id;
    }

    function initClaimEpoch() {
      return store.getClaimEpoch();
    }

    function persistClaimEpoch() {
      store.persistEpoch(claimEpoch);
    }

    function initChannel() {
      if (!FEATURE_BROADCAST || typeof BroadcastChannel === 'undefined') return;
      try {
        tabId = initTabId();
        claimEpoch = initClaimEpoch();
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = onChannelMessage;
        vlog(3, 'broadcast:init', { tabId: tabId, epoch: claimEpoch, stableId: FEATURE_OWNERSHIP_V3 });
        vmark('broadcast:init');

        if (FEATURE_CONTINUITY_V4) {
          if (store.consumeNavMarker()) {
            vlog(2, 'continuity:nav-detected', { tabId: tabId });
            vmark('continuity:nav-reclaim');
            broadcastClaim();
            return;
          }
        }

        sendPing();
      } catch (e) {
        console.warn('[vinyl] Cross-tab sync unavailable (' + e.message + ').');
        vlog(1, 'broadcast:failed', { error: e.message });
      }
    }

    function safeBroadcast(msg) {
      if (!channel) return false;
      try {
        channel.postMessage(msg);
        return true;
      } catch (e) {
        vlog(1, 'broadcast:send-error', { type: msg.type, error: e.message });
        return false;
      }
    }

    function broadcastClaim() {
      if (!channel) return;
      if (ownerTabId && ownerTabId !== tabId && isOwnerStale()) {
        vlog(2, 'broadcast:stale-owner-cleared', { previous: ownerTabId });
      }
      isOwner = true;
      ownerTabId = tabId;
      lastOwnerSeen = Date.now();
      remoteState = null;
      cancelElection();
      cancelYieldGrace();

      if (FEATURE_OWNERSHIP_V3) {
        claimEpoch++;
        persistClaimEpoch();
      }

      safeBroadcast({ type: 'claim', tabId: tabId, ts: Date.now(), epoch: claimEpoch });
      startHeartbeat();
      vlog(3, 'broadcast:claim', { tabId: tabId, epoch: claimEpoch });
    }

    function broadcastYield(reason) {
      if (!channel) return;
      if (!isOwner) {
        vlog(3, 'broadcast:yield-skipped', { reason: 'not-owner' });
        return;
      }
      isOwner = false;
      ownerTabId = '';
      remoteState = null;
      stopHeartbeat();
      safeBroadcast({ type: 'yield', tabId: tabId, ts: Date.now(), reason: reason || 'explicit' });
      vlog(3, 'broadcast:yield', { tabId: tabId, reason: reason || 'explicit' });
    }

    function broadcastPauseRetain() {
      if (!FEATURE_OWNERSHIP_V3 || !channel || !isOwner) return;
      var rec = _ctrl.getCurrentRecord();
      var title = rec ? rec.title : '';
      lastSync = Date.now();
      safeBroadcast({
        type: 'sync',
        tabId: tabId,
        payload: {
          side: _ctrl.getCurrentSide(),
          spinning: false,
          pos: _ctrl.getLastPosition(),
          title: title,
          ts: Date.now()
        }
      });
      vlog(3, 'broadcast:pause-retain', { side: _ctrl.getCurrentSide() });
    }

    function cancelYieldGrace() {
      if (yieldGraceTimer) {
        clearTimeout(yieldGraceTimer);
        yieldGraceTimer = null;
        vlog(3, 'yield-grace:cancelled');
      }
    }

    function broadcastSync() {
      if (!channel || !isOwner) return;
      var now = Date.now();
      if (now - lastSync < SYNC_THROTTLE) return;
      lastSync = now;
      var rec = _ctrl.getCurrentRecord();
      var title = rec ? rec.title : '';
      safeBroadcast({
        type: 'sync',
        tabId: tabId,
        payload: {
          side: _ctrl.getCurrentSide(),
          spinning: _ctrl.isSpinning(),
          pos: _ctrl.getLastPosition(),
          title: title,
          ts: now
        }
      });
      vlog(3, 'broadcast:sync', { side: _ctrl.getCurrentSide(), pos: _ctrl.getLastPosition() });
    }

    function onChannelMessage(e) {
      var msg = e.data;
      if (!msg || msg.tabId === tabId) return;

      if (msg.ts && Date.now() - msg.ts > OWNER_STALE) {
        vlog(3, 'broadcast:stale', { type: msg.type, age: Date.now() - msg.ts });
        return;
      }

      if (FEATURE_LEADER_ELECTION && msg.tabId === ownerTabId) {
        lastOwnerSeen = msg.ts || Date.now();
        cancelElection();
      }

      switch (msg.type) {
        case 'claim':
          vlog(2, 'broadcast:remote-claim', { from: msg.tabId, epoch: msg.epoch });
          cancelYieldGrace();
          ownerTabId = msg.tabId;
          lastOwnerSeen = msg.ts || Date.now();
          cancelElection();
          if (isOwner) {
            isOwner = false;
            stopHeartbeat();
          }
          _ctrl.handleRemoteClaim();
          remoteState = null;
          break;
        case 'yield':
          vlog(3, 'broadcast:remote-yield', { from: msg.tabId, reason: msg.reason });
          if (ownerTabId === msg.tabId) {
            if (FEATURE_OWNERSHIP_V3) {
              cancelYieldGrace();
              var yieldFrom = msg.tabId;
              var graceMs = FEATURE_CONTINUITY_V4 ? V4_YIELD_GRACE_MS : YIELD_GRACE_MS;
              yieldGraceTimer = setTimeout(function () {
                yieldGraceTimer = null;
                if (ownerTabId === yieldFrom) {
                  vlog(2, 'yield-grace:expired', { from: yieldFrom });
                  ownerTabId = '';
                  remoteState = null;
                  _ui.reflectRemoteState();
                }
              }, graceMs);
              vlog(3, 'yield-grace:started', { from: yieldFrom, grace: graceMs });
            } else {
              ownerTabId = '';
              remoteState = null;
              _ui.reflectRemoteState();
            }
          }
          break;
        case 'sync':
          if (msg.tabId !== ownerTabId) break;
          lastOwnerSeen = (msg.payload && msg.payload.ts) || Date.now();
          remoteState = msg.payload || null;
          vlog(3, 'broadcast:remote-sync', msg.payload);
          if (!isOwner) _ui.reflectRemoteState();
          break;

        case 'heartbeat':
          if (!FEATURE_LEADER_ELECTION) break;
          if (msg.tabId === ownerTabId) {
            lastOwnerSeen = msg.ts || Date.now();
            vlog(3, 'leader:heartbeat-recv', { from: msg.tabId });
          }
          break;
        case 'ping':
          if (!FEATURE_LEADER_ELECTION) break;
          vlog(3, 'leader:ping-recv', { from: msg.tabId });
          if (isOwner) sendPong(msg.tabId);
          break;
        case 'pong':
          if (!FEATURE_LEADER_ELECTION) break;
          vlog(2, 'leader:pong-recv', { from: msg.tabId });
          ownerTabId = msg.tabId;
          lastOwnerSeen = msg.ts || Date.now();
          remoteState = msg.payload || null;
          cancelElection();
          if (!isOwner) _ui.reflectRemoteState();
          break;
      }
    }

    function isOwnerStale() {
      if (!ownerTabId || ownerTabId === tabId) return false;
      return Date.now() - lastOwnerSeen > OWNER_STALE;
    }

    function leaderElectionActive() {
      return FEATURE_LEADER_ELECTION && FEATURE_BROADCAST && !!channel;
    }

    function startHeartbeat() {
      stopHeartbeat();
      if (!leaderElectionActive()) return;
      heartbeatTimer = setInterval(function () {
        safeBroadcast({ type: 'heartbeat', tabId: tabId, ts: Date.now() });
        vlog(3, 'leader:heartbeat-sent');
      }, HEARTBEAT_MS);
      vlog(3, 'leader:heartbeat-start');
    }

    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        vlog(3, 'leader:heartbeat-stop');
      }
    }

    function electionJitter() {
      var hash = 0;
      for (var i = 0; i < tabId.length; i++) {
        hash = ((hash << 5) - hash + tabId.charCodeAt(i)) | 0;
      }
      return ELECTION_DELAY + (Math.abs(hash) % 1000);
    }

    function startElection(reason) {
      if (!leaderElectionActive() || pendingElection) return;
      pendingElection = true;
      var delay = electionJitter();
      vlog(2, 'leader:election-start', { reason: reason, delay: delay });
      vmark('leader:election-start');
      electionTimer = setTimeout(function () {
        pendingElection = false;
        electionTimer = null;
        if (!isOwnerStale()) {
          vlog(3, 'leader:election-aborted', { reason: 'owner-alive' });
          return;
        }
        vlog(2, 'leader:election-resolved', { previousOwner: ownerTabId });
        vmark('leader:election-resolved');
        ownerTabId = '';
        remoteState = null;
        _ui.reflectRemoteState();
      }, delay);
    }

    function cancelElection() {
      if (electionTimer) {
        clearTimeout(electionTimer);
        electionTimer = null;
        pendingElection = false;
        vlog(3, 'leader:election-cancelled');
      }
    }

    function sendPing() {
      if (!leaderElectionActive()) return;
      safeBroadcast({ type: 'ping', tabId: tabId, ts: Date.now() });
      vlog(3, 'leader:ping-sent');
      vmark('leader:ping');
    }

    function sendPong(toTabId) {
      if (!leaderElectionActive() || !isOwner) return;
      var rec = _ctrl.getCurrentRecord();
      var title = rec ? rec.title : '';
      safeBroadcast({
        type: 'pong',
        tabId: tabId,
        ts: Date.now(),
        payload: {
          side: _ctrl.getCurrentSide(),
          spinning: _ctrl.isSpinning(),
          pos: _ctrl.getLastPosition(),
          title: title
        }
      });
      vlog(3, 'leader:pong-sent', { to: toTabId });
    }

    return {
      wire: wire,
      init: initChannel,
      claim: broadcastClaim,
      yieldOwnership: broadcastYield,
      pauseRetain: broadcastPauseRetain,
      broadcastSync: broadcastSync,
      isOwner: function () { return isOwner; },
      getRemoteState: function () { return remoteState; },
      getOwnerTabId: function () { return ownerTabId; },
      getTabId: function () { return tabId; },
      getLastOwnerSeen: function () { return lastOwnerSeen; },
      isOwnerStale: isOwnerStale,
      startElection: startElection,
      stopHeartbeat: stopHeartbeat
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     UI (v5.0.0 — Phase 5 extraction)

     DOM interaction and rendering. Owns:
       - Element references (el.*, glyph.*)
       - Event binding and handlers
       - DOM reflection of state changes
       - Crate and marquee rendering

     Wired dependencies: _ctrl and _sync (set via wire())
     ══════════════════════════════════════════════════════════════ */

  var ui = (function () {

    var _ctrl = null;                                // wired controller module
    var _sync = null;                                // wired sync module

    var el    = {};
    var glyph = {};

    function wire(deps) {
      _ctrl = deps.ctrl;
      _sync = deps.sync;
    }

    function mount(stageEl) {
      el.stage  = stageEl;
      el.source = $('vinylSource');
      el.title  = $('vinylTitle');
      el.spin   = $('vinylSpin');
      el.hush   = $('vinylHush');
      el.dial   = $('vinylDial');
      el.latch  = $('vinylLatch');
      el.crate  = $('vinylCrate');

      glyph.spin   = el.stage.querySelector('.vinyl-icon-spin');
      glyph.lift   = el.stage.querySelector('.vinyl-icon-lift');
      glyph.loud   = el.stage.querySelector('.vinyl-icon-loud');
      glyph.hushed = el.stage.querySelector('.vinyl-icon-hushed');

      if (FEATURE_GROOVE) {
        el.groove = el.stage.querySelector('.vinyl-groove-wrap');
        if (el.groove) groove.mount(el.groove);
      }

      el.spin.addEventListener('click', onSpin);
      el.hush.addEventListener('click', onHush);
      el.dial.addEventListener('input', onDial);
      el.latch.addEventListener('click', function () { toggleCrate(); });

      document.addEventListener('click', function (e) {
        if (!el.crate.hidden && !el.stage.contains(e.target)) toggleCrate(false);
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !el.crate.hidden) toggleCrate(false);
      });

      var obs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].attributeName === 'data-theme') { onMoodShift(); break; }
        }
      });
      obs.observe(document.documentElement, { attributes: true });

      if (FEATURE_CRATE_V2) {
        var marquee = el.stage.querySelector('.vinyl-marquee');
        if (marquee) {
          el.upnext = document.createElement('span');
          el.upnext.className = 'vinyl-upnext';
          el.upnext.hidden = true;
          marquee.appendChild(el.upnext);
          marquee.style.cursor = 'pointer';
          marquee.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleCrate();
          });
        }

        el.crate.addEventListener('keydown', function (e) {
          if (el.crate.hidden) return;
          var items = el.crate.querySelectorAll('li');
          if (!items.length) return;
          var active = document.activeElement;
          var idx = -1;
          for (var j = 0; j < items.length; j++) {
            if (items[j] === active) { idx = j; break; }
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            var nxt = items[Math.min(idx + 1, items.length - 1)];
            if (nxt && nxt.focus) nxt.focus();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            var prv = items[Math.max(idx - 1, 0)];
            if (prv && prv.focus) prv.focus();
          } else if (e.key === 'Enter' && idx >= 0) {
            items[idx].click();
          }
        });

        var v2css = document.createElement('style');
        v2css.textContent =
          '.vinyl-upnext{display:block;font-size:0.55rem;color:var(--ink-lt,#999);' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.7;line-height:1.2}';
        document.head.appendChild(v2css);
      }
    }

    function reflectSpin() {
      var s = _ctrl.isSpinning();
      glyph.spin.hidden = s;
      glyph.lift.hidden = !s;
      el.spin.setAttribute('aria-label', s ? 'Pause' : 'Play');
      el.spin.title = s ? 'Pause' : 'Play';
      el.stage.classList.toggle('vinyl--spinning', s);
    }

    function reflectVolume() {
      var h = _ctrl.isHushed();
      glyph.loud.hidden = h;
      glyph.hushed.hidden = !h;
      el.hush.setAttribute('aria-label', h ? 'Unmute' : 'Mute');
      el.hush.title = h ? 'Unmute' : 'Mute';
    }

    function reflectTitle() {
      var rec = _ctrl.getCurrentRecord();
      if (rec) {
        el.title.textContent = rec.title;
        if (FEATURE_GROOVE) groove.seed(rec.title);
      }
      reflectNowPlaying();
    }

    function reflectCrate() {
      var side = _ctrl.getCurrentSide();
      var items = el.crate.querySelectorAll('li');
      for (var i = 0; i < items.length; i++) {
        var idx = parseInt(items[i].getAttribute('data-index'), 10);
        items[i].setAttribute('aria-selected', idx === side ? 'true' : 'false');
      }
      var active = el.crate.querySelector('[aria-selected="true"]');
      if (active && !el.crate.hidden) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function reflectNowPlaying() {
      if (!FEATURE_CRATE_V2 || !el.upnext) return;
      if (!_ctrl.isSpinning() && _sync.getRemoteState() && _sync.getRemoteState().title && !_sync.isOwner()) return;
      var side = _ctrl.getCurrentSide();
      var recs = _ctrl.getRecords();
      var next = side + 1;
      if (next < recs.length && recs[next]) {
        el.upnext.textContent = 'Up next \u2014 ' + recs[next].title;
        el.upnext.hidden = false;
      } else {
        el.upnext.hidden = true;
      }
    }

    function reflectRemoteState() {
      if (!FEATURE_CRATE_V2 || !el.upnext) return;
      var rs = _sync.getRemoteState();
      if (!_sync.isOwner() && !_ctrl.isSpinning() && rs && rs.title) {
        var prefix = (FEATURE_OWNERSHIP_V3 && rs.spinning === false)
          ? 'Paused elsewhere'
          : 'Playing elsewhere';
        el.upnext.textContent = prefix + ' \u2014 ' + rs.title;
        el.upnext.hidden = false;
      } else if (!rs && !_ctrl.isSpinning()) {
        reflectNowPlaying();
      }
    }

    function fillCrate() {
      el.crate.innerHTML = '';
      var recs = _ctrl.getRecords();
      var side = _ctrl.getCurrentSide();
      recs.forEach(function (rec, i) {
        var li = document.createElement('li');
        var label = rec.title;
        if (FEATURE_CRATE_V2) {
          if (FEATURE_SLEEVE_V3) {
            label = rec.title;
            if (rec.duration) label += '  ' + formatDuration(rec.duration);
          } else {
            var num = String(i + 1).padStart(2, '0');
            label = num + ' \u00b7 ' + rec.title;
            if (rec.duration) label += '  (' + formatDuration(rec.duration) + ')';
          }
          li.setAttribute('tabindex', '0');
        }
        li.textContent = label;
        li.setAttribute('role', 'option');
        li.setAttribute('data-index', rec.index);
        if (rec.index === side) li.setAttribute('aria-selected', 'true');
        li.addEventListener('click', function () {
          _ctrl.skip(rec.index);
          _ctrl.play();
          toggleCrate(false);
        });
        el.crate.appendChild(li);
      });
    }

    function toggleCrate(open) {
      var show = typeof open === 'boolean' ? open : el.crate.hidden;
      el.crate.hidden = !show;
      el.latch.setAttribute('aria-expanded', String(show));
      el.latch.setAttribute('aria-label', show ? 'Hide playlist' : 'Show playlist');
    }

    function onSpin() {
      if (!_ctrl.isReady()) return;
      _ctrl.isSpinning() ? _ctrl.pause() : _ctrl.play();
    }

    function onHush() {
      if (!_ctrl.isReady()) return;
      _ctrl.isHushed() ? _ctrl.unmute() : _ctrl.mute();
    }

    function onDial() {
      if (!_ctrl.isReady()) return;
      _ctrl.setVolume(parseInt(el.dial.value, 10));
    }

    function raiseStage() {
      el.stage.removeAttribute('aria-hidden');
      void el.stage.offsetHeight;
      el.stage.classList.add('vinyl--live');
    }

    function lowerStage() {
      vlog(2, 'stage:lower');
      el.stage.classList.remove('vinyl--live');
      el.stage.setAttribute('aria-hidden', 'true');
      toggleCrate(false);
    }

    function onMoodShift() {
      if (isDND()) {
        _ctrl.activate();
        raiseStage();
      } else {
        _ctrl.deactivate();
        lowerStage();
      }
    }

    return {
      wire: wire,
      mount: mount,
      reflectSpin: reflectSpin,
      reflectVolume: reflectVolume,
      reflectTitle: reflectTitle,
      reflectCrate: reflectCrate,
      reflectNowPlaying: reflectNowPlaying,
      reflectRemoteState: reflectRemoteState,
      fillCrate: fillCrate,
      toggleCrate: toggleCrate,
      raiseStage: raiseStage,
      lowerStage: lowerStage,
      setTitle: function (text) { el.title.textContent = text; },
      getTitle: function () { return el.title.textContent; },
      getDialValue: function () { return parseInt(el.dial.value, 10) || 0; },
      setDialValue: function (v) { el.dial.value = v; },
      getSource: function () { return el.source; }
    };
  })();

  /* ── Overture: composition root ───────────────────────────── */

  function overture() {
    var stageEl = $('vinyl');
    if (!stageEl) return;

    ui.mount(stageEl);

    controller.wire({ sync: sync, ui: ui });
    sync.wire({ ctrl: controller, ui: ui });
    ui.wire({ ctrl: controller, sync: sync });

    var onExit = function () {
      if (controller.isSourceReady() && isDND()) controller.saveState();
      sync.stopHeartbeat();
      if (FEATURE_CONTINUITY_V4 && isDND() && sync.isOwner()) {
        store.setNavMarker();
        vlog(3, 'continuity:nav-exit', { tabId: sync.getTabId() });
      } else {
        sync.yieldOwnership('tab-exit');
      }
    };
    window.addEventListener('beforeunload', onExit);
    if (FEATURE_RESILIENCE) window.addEventListener('pagehide', onExit);

    sync.init();

    if (FEATURE_LEADER_ELECTION) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (!sync.isOwner() && sync.getOwnerTabId() && sync.isOwnerStale()) {
          vlog(2, 'leader:stale-on-focus', { owner: sync.getOwnerTabId(), age: Date.now() - sync.getLastOwnerSeen() });
          sync.startElection('visibility-change');
        }
      });
    }

    if (isDND()) {
      controller.activate();
      ui.raiseStage();
    }
  }

  /* Wait for DOM */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', overture);
  } else {
    overture();
  }

})();
