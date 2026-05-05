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
  var VOLUME_KEY     = 'fc:volume';
  var SHELF_KEY      = 'ce-vinyl-shelf';
  var SHELF_TTL      = 30 * 60 * 1000;              // 30 min
  var SDK_URL        = 'https://w.soundcloud.com/player/api.js';
  var SILENCE_MS     = 10000;                        // "Unavailable" timeout
  var CONT_KEY       = 'ce-vinyl-cont';              // cross-page continuity
  var CONT_TTL       = 30000;                        // 30 s — stale after navigation
  var QUEUE_KEY      = 'ce-vinyl-queue';             // 72-hour radio queue metadata
  var QUEUE_REFRESH_MS = 72 * 60 * 60 * 1000;
  var QUEUE_LIMIT    = 10;

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

  /* ── Feature gates (v5.1.0) ────────────────────────────── */
  /*    Interactive groove: click/drag/touch to seek within    */
  /*    the waveform progress bar. Layers on FEATURE_GROOVE.  */
  /*    Flip to false to restore passive-only waveform.       */

  var FEATURE_GROOVE_SEEK = true;

  /* ── Feature gates (v5.2.0) ────────────────────────────── */
  /*    Immersive groove: continuous progress interpolation,   */
  /*    soft waveform pulse near the playhead, elastic seek    */
  /*    feedback, and hover time preview. Layers on            */
  /*    FEATURE_GROOVE + FEATURE_GROOVE_SEEK. Adds no new     */
  /*    state to the controller — purely visual enhancement    */
  /*    driven by rAF with deterministic, time-based math.    */
  /*    Flip to false to restore discrete-update waveform.    */

  var FEATURE_GROOVE_IMMERSIVE = true;
  var GROOVE_LERP_SPEED        = 5;         // interpolation stiffness (gentler = calmer)
  var GROOVE_PULSE_RADIUS      = 3;         // bars affected on each side of playhead
  var GROOVE_PULSE_INTENSITY   = 0.06;      // max amplitude modulation [0..1] — barely visible
  var GROOVE_PULSE_SPEED       = 1.4;       // breathing frequency (Hz) — slow, ambient
  var GROOVE_ELASTIC_TENSION   = 0.2;       // spring overshoot factor on seek — softer landing
  var GROOVE_ELASTIC_DAMPING   = 0.88;      // spring decay per frame — less bounce

  /* ── Feature gates (v6.0.0) ────────────────────────────── */
  /*    abstraction.fm queue: deterministic 10-track radio     */
  /*    surface refreshed every 72 hours with persisted        */
  /*    metadata. Purely wraps catalog order; adapter indexes  */
  /*    remain the source of truth for SoundCloud playback.    */

  var FEATURE_QUEUE_V6 = true;
  var QUEUE_VERSION    = 1;

  /* ── Feature gates (v6.1.0) ────────────────────────────── */
  /*    Title strip — refines the crate-strip palette into a   */
  /*    state-signaling composition: a deep navy field with    */
  /*    bold pink bursts when audio is happening and electric  */
  /*    yellow streaks when time is moving. Layers on          */
  /*    FEATURE_QUEUE_V6 (the strip only renders when the      */
  /*    queue UI is on). Pure CSS swap — flip to false to      */
  /*    restore the v6.0 carnival palette bit-for-bit.         */

  var FEATURE_TITLE_STRIP_V1 = true;

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

    function queueStorage() {
      try {
        if (typeof localStorage !== 'undefined') return localStorage;
      } catch (e) {}
      try {
        if (typeof sessionStorage !== 'undefined') return sessionStorage;
      } catch (e) {}
      return null;
    }

    function queueRead() {
      var storage = queueStorage();
      if (!storage) return null;
      try {
        var raw = storage.getItem(QUEUE_KEY);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        if (!obj || obj.v !== QUEUE_VERSION || typeof obj.bucket !== 'number' || !obj.ids || !obj.ids.length) return null;
        if (Date.now() - obj.ts > QUEUE_REFRESH_MS) return null;
        return obj;
      } catch (e) { return null; }
    }

    function queueWrite(payload) {
      var storage = queueStorage();
      if (!storage) return;
      try {
        storage.setItem(QUEUE_KEY, JSON.stringify(payload));
      } catch (e) {}
    }

    function volumeRead() {
      try {
        var value = parseInt(localStorage.getItem(VOLUME_KEY), 10);
        return isNaN(value) ? DEFAULT_VOLUME : Math.max(0, Math.min(100, value));
      } catch (e) { return DEFAULT_VOLUME; }
    }

    function volumeWrite(value) {
      try {
        localStorage.setItem(VOLUME_KEY, String(Math.max(0, Math.min(100, value))));
      } catch (e) {}
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
      volumeRead:        volumeRead,
      volumeWrite:       volumeWrite,
      queueRead:         queueRead,
      queueWrite:        queueWrite,
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
     Groove — waveform progress visualization (v5.0.0 → v5.2.0)

     Canvas-based progress bar that renders a seeded pseudo-random
     waveform for each track. The seed is derived from the track
     title, so the waveform is deterministic and consistent across
     page loads. Progress fill is driven by PLAY_PROGRESS events.

     v5.2.0 additions (FEATURE_GROOVE_IMMERSIVE):
       - Smooth progress interpolation via rAF (no discrete jumps)
       - Soft waveform pulse near the playhead (time-based, deterministic)
       - Elastic seek feedback (spring overshoot on commit)
       - Hover time preview tooltip

     No behavioral changes. No adapter/store/FSM interaction beyond
     reading lastPosition and the current record's duration.
     Fully gated behind FEATURE_GROOVE.

     Public surface:
       groove.mount(container)  — creates canvas, appends to container
       groove.seed(title)       — generates waveform data for a track
       groove.update(fraction)  — repaints with progress fill [0..1]
       groove.clear()           — resets to empty state
       groove.destroy()         — removes canvas from DOM
       groove.startFlow()       — begin rAF interpolation loop (v5.2.0)
       groove.stopFlow()        — stop rAF loop (v5.2.0)
       groove.elasticSeek(frac) — trigger elastic snap to position (v5.2.0)
     ══════════════════════════════════════════════════════════════ */

  var groove = (function () {
    if (!FEATURE_GROOVE) return {
      mount: function () {},
      seed:  function () {},
      update: function () {},
      snap:  function () {},
      clear:  function () {},
      destroy: function () {},
      hitTest: function () { return -1; },
      preview: function () {},
      clearPreview: function () {},
      getCanvas: function () { return null; },
      startFlow: function () {},
      stopFlow: function () {},
      elasticSeek: function () {},
      setHoverTime: function () {},
      clearHoverTime: function () {}
    };

    var canvas  = null;
    var ctx     = null;
    var bars    = null;      // Float32Array of bar heights [0..1]
    var lastFrac = -1;       // last rendered fraction (avoids redundant paints)
    var hoverFrac = -1;      // hover preview position (-1 = no preview)

    /* ── v5.2.0: Interpolation state ──────────────────────── */
    var targetFrac   = 0;    // where progress should be (set by update())
    var displayFrac  = 0;    // where progress appears (smoothed toward target)
    var rafId        = null; // requestAnimationFrame handle
    var flowing      = false;// true while the rAF loop is active
    var lastFrameT   = 0;    // timestamp of last rAF frame

    /* ── v5.2.0: Elastic seek state ──────────────────────── */
    var elasticActive  = false;
    var elasticTarget  = 0;
    var elasticVel     = 0;    // spring velocity
    var elasticDisplay = 0;    // current elastic position

    /* ── v5.2.0: Hover time tooltip state ─────────────────── */
    var hoverTimeEl  = null;   // tooltip DOM element
    var hoverTimeFrac = -1;    // fraction for time display

    /* ── v5.2.0: Reduced motion detection ─────────────────── */
    var prefersReducedMotion = (function () {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch (e) { return false; }
    })();

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

    /* ── v5.2.0: Pulse calculation ────────────────────────── */
    /*    Returns a height multiplier [1.0 − intensity .. 1.0 + intensity]  */
    /*    based on bar proximity to the playhead and wall-clock time.       */
    /*    Deterministic: same (barIndex, fillFrac, time) → same result.    */
    /*    Falls back to 1.0 (no effect) when immersive is off or reduced   */
    /*    motion is preferred.                                              */

    function pulseMultiplier(barIndex, barCount, fillFrac, nowSec) {
      if (!FEATURE_GROOVE_IMMERSIVE || prefersReducedMotion) return 1.0;

      var playheadBar = fillFrac * (barCount - 1);
      var dist = Math.abs(barIndex - playheadBar);

      /* Only affect bars within GROOVE_PULSE_RADIUS of the playhead */
      if (dist > GROOVE_PULSE_RADIUS) return 1.0;

      /* Proximity falloff: closer bars pulse more */
      var proximity = 1.0 - (dist / GROOVE_PULSE_RADIUS);
      proximity = proximity * proximity;                    // quadratic falloff — gentle

      /* Sinusoidal breath, offset per-bar for organic shimmer */
      var phase = nowSec * GROOVE_PULSE_SPEED * Math.PI * 2;
      phase += barIndex * 0.4;                              // stagger by bar index
      var breath = Math.sin(phase) * 0.5 + 0.5;            // [0..1]

      return 1.0 + proximity * breath * GROOVE_PULSE_INTENSITY;
    }

    /* ── Render ────────────────────────────────────────────── */

    function render(frac, hoverAt, nowSec) {
      if (!ctx || !bars) return;
      var w = canvas.width;
      var h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      var dpr      = GROOVE_DPR;
      var gap      = GROOVE_BAR_GAP * dpr;
      var total    = GROOVE_BARS;
      var barW     = Math.max(1, (w - gap * (total - 1)) / total);
      var fillX    = frac * w;
      var hoverX   = (typeof hoverAt === 'number' && hoverAt >= 0) ? hoverAt * w : -1;

      /* Colours: filled = plum accent, unfilled = muted lavender.
         Tuned for the refined palette — restrained warmth, not loud. */
      var filled   = 'rgba(155, 126, 155, 0.55)';   // plum accent — restrained
      var unfilled = 'rgba(192, 178, 190, 0.2)';     // muted lavender — whisper
      var hovered  = 'rgba(155, 126, 155, 0.3)';     // hover preview tint — gentle

      /* v5.2.0: time for deterministic pulse (seconds since page load) */
      var pulseSec = (typeof nowSec === 'number') ? nowSec : 0;

      for (var i = 0; i < total; i++) {
        var x     = i * (barW + gap);

        /* v5.2.0: Apply pulse modulation to bar height */
        var pMul = (flowing && frac > 0) ? pulseMultiplier(i, total, frac, pulseSec) : 1.0;
        var barH  = bars[i] * h * pMul;
        var y     = (h - barH) / 2;                   // vertically centred

        /* Colour logic:
           - Bars fully before fill position → filled (played)
           - When hovering ahead: bars between fill and hover → preview tint
           - When hovering behind: bars between hover and fill → preview tint
           - Everything else → unfilled */
        var isFilled = (x + barW <= fillX);
        var isHoverZone = false;
        if (hoverX >= 0) {
          if (hoverX > fillX && !isFilled) {
            /* Hovering ahead of playback: preview zone = fill→hover */
            isHoverZone = (x + barW > fillX) && (x < hoverX);
          } else if (hoverX < fillX && isFilled) {
            /* Hovering behind playback: preview zone = hover→fill
               These bars are currently "filled" — override to preview.
               Bounded to fillX so bars beyond fill stay unfilled. */
            isHoverZone = (x >= hoverX) && (x + barW <= fillX);
          }
        }

        ctx.fillStyle = isHoverZone ? hovered
                      : isFilled ? filled
                      : unfilled;

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

      /* Hover cursor line — thin vertical indicator */
      if (hoverX >= 0) {
        ctx.fillStyle = 'rgba(155, 126, 155, 0.35)';
        var lineW = Math.max(1, 1 * dpr);
        ctx.fillRect(hoverX - lineW / 2, 0, lineW, h);
      }
    }

    /* ── v5.2.0: rAF interpolation loop ───────────────────── */
    /*    Smoothly lerps displayFrac → targetFrac each frame.  */
    /*    Drives pulse animation when playing. Deterministic:   */
    /*    same inputs produce same visual regardless of tab.    */
    /*    Falls back to discrete updates when immersive is off  */
    /*    or reduced motion is preferred.                       */

    function flowFrame(ts) {
      if (!flowing) return;
      rafId = requestAnimationFrame(flowFrame);

      var dt = lastFrameT ? Math.min((ts - lastFrameT) / 1000, 0.05) : 0.016;
      lastFrameT = ts;

      /* Elastic seek spring physics */
      if (elasticActive) {
        var elasticDelta = elasticTarget - elasticDisplay;
        elasticVel += elasticDelta * GROOVE_ELASTIC_TENSION;
        elasticVel *= GROOVE_ELASTIC_DAMPING;
        elasticDisplay += elasticVel;

        /* Settle when close enough */
        if (Math.abs(elasticDelta) < 0.001 && Math.abs(elasticVel) < 0.001) {
          elasticDisplay = elasticTarget;
          elasticActive = false;
          elasticVel = 0;
        }

        displayFrac = Math.max(0, Math.min(1, elasticDisplay));
      } else {
        /* Smooth interpolation toward target */
        var delta = targetFrac - displayFrac;
        if (Math.abs(delta) < 0.0005) {
          displayFrac = targetFrac;
        } else {
          displayFrac += delta * Math.min(1, GROOVE_LERP_SPEED * dt);
        }
      }

      /* Wall-clock seconds for deterministic pulse */
      var nowSec = ts / 1000;

      render(displayFrac, hoverFrac, nowSec);
    }

    function startFlow() {
      if (!FEATURE_GROOVE_IMMERSIVE || prefersReducedMotion) return;
      if (flowing) return;
      flowing = true;
      lastFrameT = 0;
      rafId = requestAnimationFrame(flowFrame);
      vlog(3, 'groove:flow-start');
    }

    function stopFlow() {
      flowing = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastFrameT = 0;
      /* Final snap to target */
      displayFrac = targetFrac;
      if (lastFrac >= 0) render(displayFrac, hoverFrac, 0);
      vlog(3, 'groove:flow-stop');
    }

    /* ── v5.2.0: Elastic seek ─────────────────────────────── */
    /*    Trigger a spring animation toward the seek target.    */
    /*    The overshoot is subtle — creates a "landing" feel    */
    /*    that communicates the seek has arrived.               */

    function elasticSeek(frac) {
      if (!FEATURE_GROOVE_IMMERSIVE || prefersReducedMotion) {
        /* Immediate snap fallback */
        displayFrac = frac;
        targetFrac = frac;
        lastFrac = frac;
        if (canvas && ctx) render(frac, hoverFrac, 0);
        return;
      }

      elasticTarget = Math.max(0, Math.min(1, frac));
      elasticDisplay = displayFrac;
      /* Kick velocity toward target with gentle impulse */
      var seekDelta = elasticTarget - elasticDisplay;
      elasticVel = seekDelta * 0.15;
      elasticActive = true;
      targetFrac = elasticTarget;
      lastFrac = elasticTarget;

      if (flowing) {
        /* rAF loop already running (playing) — it picks up elasticActive */
        return;
      }

      /* Paused: drive a self-terminating spring rAF chain.
         Does NOT set flowing=true so the main play/pause lifecycle
         remains unaffected. Stops itself once the spring settles. */
      var springRafId = null;
      var springLastT = 0;

      function springStep(ts) {
        var dt = springLastT ? Math.min((ts - springLastT) / 1000, 0.05) : 0.016;
        springLastT = ts;

        var delta = elasticTarget - elasticDisplay;
        elasticVel += delta * GROOVE_ELASTIC_TENSION;
        elasticVel *= GROOVE_ELASTIC_DAMPING;
        elasticDisplay += elasticVel;

        if (Math.abs(delta) < 0.001 && Math.abs(elasticVel) < 0.001) {
          elasticDisplay = elasticTarget;
          elasticActive = false;
          elasticVel = 0;
        }

        displayFrac = Math.max(0, Math.min(1, elasticDisplay));
        render(displayFrac, hoverFrac, 0);

        if (elasticActive) {
          springRafId = requestAnimationFrame(springStep);
        }
      }

      springRafId = requestAnimationFrame(springStep);
    }

    /* ── v5.2.0: Hover time tooltip ───────────────────────── */

    function ensureHoverTimeEl(container) {
      if (hoverTimeEl) return;
      hoverTimeEl = document.createElement('div');
      hoverTimeEl.className = 'vinyl-groove-time';
      hoverTimeEl.setAttribute('aria-hidden', 'true');
      container.appendChild(hoverTimeEl);
    }

    function setHoverTime(frac, durationMs, container) {
      if (!FEATURE_GROOVE_IMMERSIVE || !durationMs || durationMs <= 0) return;
      ensureHoverTimeEl(container);
      hoverTimeFrac = frac;
      var ms = Math.round(frac * durationMs);
      var s = Math.round(ms / 1000);
      var m = Math.floor(s / 60);
      s = s % 60;
      hoverTimeEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
      /* Clamp left% so the tooltip (centered via translateX(-50%)) stays
         within the groove wrap. 5% margin keeps full pill width in view. */
      var clampedPct = Math.max(5, Math.min(95, frac * 100));
      hoverTimeEl.style.left = clampedPct + '%';
      hoverTimeEl.hidden = false;
    }

    function clearHoverTime() {
      if (hoverTimeEl) hoverTimeEl.hidden = true;
      hoverTimeFrac = -1;
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
      hoverFrac = -1;
      targetFrac = 0;
      displayFrac = 0;
      elasticActive = false;
      elasticVel = 0;
      render(0);
    }

    function update(frac) {
      frac = Math.max(0, Math.min(1, frac));
      lastFrac = frac;
      targetFrac = frac;

      /* When flowing (rAF active), let the interpolation loop handle rendering.
         When not flowing, render immediately (discrete mode / fallback). */
      if (flowing && FEATURE_GROOVE_IMMERSIVE && !prefersReducedMotion) return;

      /* Skip repaint if fraction didn't change enough (< 0.2% = invisible) */
      if (Math.abs(frac - displayFrac) < 0.002 && hoverFrac < 0) return;
      displayFrac = frac;
      render(frac, hoverFrac, 0);
    }

    function clear() {
      bars = null;
      lastFrac = -1;
      hoverFrac = -1;
      targetFrac = 0;
      displayFrac = 0;
      elasticActive = false;
      elasticVel = 0;
      stopFlow();
      clearHoverTime();
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function destroy() {
      stopFlow();
      clearHoverTime();
      if (hoverTimeEl && hoverTimeEl.parentNode) hoverTimeEl.parentNode.removeChild(hoverTimeEl);
      hoverTimeEl = null;
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      ctx = null;
      bars = null;
      lastFrac = -1;
      hoverFrac = -1;
      targetFrac = 0;
      displayFrac = 0;
    }

    /* ── Hit-test: convert clientX to fraction [0..1] ────── */
    /*    Returns -1 if canvas is absent or click is outside.  */

    function hitTest(clientX) {
      if (!canvas) return -1;
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return -1;
      var frac = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(1, frac));
    }

    /* ── Hover preview ───────────────────────────────────── */
    /*    Sets a preview fraction that render() uses to draw   */
    /*    a tinted zone and cursor line. -1 clears preview.    */

    function preview(frac) {
      hoverFrac = (typeof frac === 'number' && frac >= 0) ? Math.max(0, Math.min(1, frac)) : -1;
      /* When flowing, the rAF loop picks up hoverFrac automatically on its next frame.
         When not flowing, render immediately at displayFrac — what's actually on screen. */
      if (!flowing && displayFrac >= 0) render(displayFrac, hoverFrac, 0);
    }

    function clearPreview() {
      if (hoverFrac < 0) return;
      hoverFrac = -1;
      if (!flowing && displayFrac >= 0) render(displayFrac, -1, 0);
    }

    function getCanvas() {
      return canvas;
    }

    /* ── v5.2.0 (fix): Immediate scrub snap ──────────────────
       During drag, display must track the cursor 1:1 with no
       interpolation lag. snap() sets both displayFrac and
       targetFrac so the rAF loop has nothing to chase.        */

    function snap(frac) {
      frac = Math.max(0, Math.min(1, frac));
      lastFrac = frac;
      targetFrac = frac;
      displayFrac = frac;
      elasticActive = false;
      elasticVel = 0;
      render(frac, hoverFrac, 0);
    }

    return {
      mount:          mount,
      seed:           seed,
      update:         update,
      snap:           snap,
      clear:          clear,
      destroy:        destroy,
      hitTest:        hitTest,
      preview:        preview,
      clearPreview:   clearPreview,
      getCanvas:      getCanvas,
      startFlow:      startFlow,
      stopFlow:       stopFlow,
      elasticSeek:    elasticSeek,
      setHoverTime:   setHoverTime,
      clearHoverTime: clearHoverTime
    };
  })();

  /* ── Shared IIFE scope utilities ───────────────────────────── */

  function $(id)       { return document.getElementById(id); }
  function isDND()  {
    var root = document.documentElement;
    return root.getAttribute('data-mode') === 'dnd' ||
      root.getAttribute('data-theme') === 'refined';
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '';
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function hashString(str) {
    var h = 0x811c9dc5;
    str = String(str || '');
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

  function recordKey(rec) {
    if (!rec) return '';
    return String(rec.id || rec.permalink || rec.title || rec.index);
  }

  /* ══════════════════════════════════════════════════════════════
     Queue (v6.0.0)

     Owns the radio queue projection over the SoundCloud catalog.
     The queue is deterministic per 72-hour bucket and persists
     only stable record IDs; fresh catalog metadata is always used
     at render time so titles, artists, and durations can improve
     without invalidating playback continuity.
     ══════════════════════════════════════════════════════════════ */

  var queue = (function () {

    function bucketForNow() {
      return Math.floor(Date.now() / QUEUE_REFRESH_MS);
    }

    function queueIdForBucket(bucket) {
      return 'abstraction.fm:' + bucket;
    }

    function mapRecords(records) {
      var map = {};
      for (var i = 0; i < records.length; i++) {
        map[recordKey(records[i])] = records[i];
      }
      return map;
    }

    function idsUsable(ids, records) {
      if (!ids || !ids.length || !records || !records.length) return false;
      var map = mapRecords(records);
      for (var i = 0; i < ids.length; i++) {
        if (!map[ids[i]]) return false;
      }
      return true;
    }

    function deterministicIds(records, bucket) {
      var pool = records.slice();
      var rng = mulberry32(hashString(queueIdForBucket(bucket)));
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(rng() * (i + 1));
        var tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
      }
      return pool.slice(0, Math.min(QUEUE_LIMIT, pool.length)).map(recordKey);
    }

    function materialize(ids, records) {
      var map = mapRecords(records);
      var out = [];
      for (var i = 0; i < ids.length; i++) {
        if (map[ids[i]]) out.push(map[ids[i]]);
      }
      return out;
    }

    function includeCurrent(resolved, records, currentSide) {
      if (typeof currentSide !== 'number' || currentSide < 0) return resolved;
      var current = records[currentSide];
      if (!current) return resolved;
      for (var i = 0; i < resolved.length; i++) {
        if (resolved[i].index === currentSide) return resolved;
      }
      return [current].concat(resolved).slice(0, Math.min(QUEUE_LIMIT, records.length));
    }

    function resolve(records, currentSide) {
      if (!FEATURE_QUEUE_V6 || !records || !records.length) return records || [];
      var bucket = bucketForNow();
      var cached = store.queueRead();
      var ids = cached && cached.bucket === bucket && idsUsable(cached.ids, records)
        ? cached.ids
        : deterministicIds(records, bucket);

      if (!ids || !ids.length) ids = records.slice(0, QUEUE_LIMIT).map(recordKey);

      if (!cached || cached.bucket !== bucket || cached.ids.join('|') !== ids.join('|')) {
        store.queueWrite({
          v: QUEUE_VERSION,
          ts: Date.now(),
          bucket: bucket,
          id: queueIdForBucket(bucket),
          ids: ids
        });
      }

      return includeCurrent(materialize(ids, records), records, currentSide);
    }

    function position(records, currentSide) {
      var q = resolve(records, currentSide);
      for (var i = 0; i < q.length; i++) {
        if (q[i].index === currentSide) return i;
      }
      return -1;
    }

    function next(records, currentSide) {
      var q = resolve(records, currentSide);
      if (!q.length) return null;
      var pos = position(records, currentSide);
      if (pos < 0) return q[0];
      return q[(pos + 1) % q.length] || null;
    }

    return {
      resolve: resolve,
      position: position,
      next: next
    };
  })();

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
    var savedVolume   = store.volumeRead();
    var records       = [];
    var currentSide   = 0;
    var sdkReady      = false;
    var sdkPending    = false;
    var sourceReady   = false;
    var needleDropped = false;
    var lastSidePoll  = 0;
    var lastPosition  = 0;
    var phase         = 'dormant';
    var scrubbing     = false;                    // v5.1.0: true during groove drag

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
      if (_ui && _ui.reflectStationStatus) _ui.reflectStationStatus();
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

      if (state.spinning) {
        safePlay();
        /* groove.startFlow() is NOT called here — the adapter's 'play' event
           fires asynchronously and calls startFlow() from its own handler.
           Calling it here would leave the loop running if autoplay is blocked. */
      }
      vlog(2, 'continuity:restored', {
        side: state.side, pos: state.pos, spinning: state.spinning,
        vol: state.vol, hushed: state.hushed
      });
      vmark('continuity:restored');
      _ui.reflectTitle();
      _ui.fillCrate();
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
        if (FEATURE_GROOVE_IMMERSIVE) groove.stopFlow();
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
        adapter.setVolume(savedVolume);
        _ui.setDialValue(savedVolume);
        catalogRecords();
      });

      adapter.on('play', function () {
        if (FEATURE_STATE_MACHINE && !transition('playing', 'play-event')) return;
        spinning = true;
        _ui.reflectSpin();
        _sync.claim();
        if (FEATURE_GROOVE_IMMERSIVE) groove.startFlow();
      });

      adapter.on('pause', function () {
        if (FEATURE_STATE_MACHINE && !transition('paused', 'pause-event')) return;
        spinning = false;
        _ui.reflectSpin();
        saveState();
        if (FEATURE_GROOVE_IMMERSIVE) groove.stopFlow();
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
        if (FEATURE_GROOVE_IMMERSIVE) groove.stopFlow();
        if (FEATURE_GROOVE) groove.update(1);
        advanceQueue('finish');
      });

      adapter.on('progress', function (data) {
        if (data && data.currentPosition) lastPosition = data.currentPosition;
        if (FEATURE_GROOVE && !scrubbing && records[currentSide] && records[currentSide].duration) {
          var frac = lastPosition / records[currentSide].duration;
          groove.update(frac);
          if (FEATURE_GROOVE_SEEK) _ui.updateGrooveAria(frac * 100);
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
            _ui.fillCrate();
          }
        });
      });

      adapter.on('error', function () {
        transition('errored', 'widget-error');
        spinning = false;
        _ui.reflectSpin();
        if (FEATURE_GROOVE_IMMERSIVE) groove.stopFlow();
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
          var artist = '';
          if (s.user && s.user.username) artist = s.user.username;
          else if (s.publisher_metadata && s.publisher_metadata.artist) artist = s.publisher_metadata.artist;
          else if (s.publisher_metadata && s.publisher_metadata.label_name) artist = s.publisher_metadata.label_name;
          var rec = {
            title: s.title || 'Track ' + (i + 1),
            index: i,
            source: artist || 'SoundCloud'
          };
          if (s.id) rec.id = s.id;
          if (s.permalink_url) rec.permalink = s.permalink_url;
          if (artist) rec.artist = artist;
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

    /* ── Scrub lock (v5.1.0) ───────────────────────────────── */
    /*    When true, PLAY_PROGRESS events skip groove.update()  */
    /*    so the user's drag position isn't overwritten by the  */
    /*    stream. Released when the seek commit lands.           */

    function setScrubbing(v) { scrubbing = v; }
    function isScrubbing()   { return scrubbing; }

    /* ── Seek to fraction (v5.1.0) ─────────────────────────── */
    /*    Converts a [0..1] fraction to ms using the current     */
    /*    record's duration, then seeks. Returns false if the    */
    /*    seek can't be performed (no record, no duration).      */

    function seekToFraction(frac) {
      if (!phaseAllowsInteraction()) return false;
      var rec = records[currentSide];
      if (!rec || !rec.duration) return false;
      frac = Math.max(0, Math.min(1, frac));
      var ms = Math.round(frac * rec.duration);
      adapter.seekTo(ms);
      lastPosition = ms;
      if (FEATURE_GROOVE_IMMERSIVE) {
        groove.elasticSeek(frac);
      } else if (FEATURE_GROOVE) {
        groove.update(frac);
      }
      vlog(3, 'seek:fraction', { frac: frac, ms: ms, side: currentSide });
      return true;
    }

    function selectSide(index, shouldPlay) {
      if (!phaseAllowsInteraction()) return false;
      var rec = records[index];
      if (!rec) return false;
      currentSide = index;
      lastPosition = 0;
      adapter.skip(index);
      if (FEATURE_GROOVE) groove.update(0);
      _ui.reflectTitle();
      _ui.fillCrate();
      if (shouldPlay) safePlay();
      vlog(3, 'queue:select', { side: index, play: !!shouldPlay });
      return true;
    }

    function advanceQueue(reason) {
      if (!FEATURE_QUEUE_V6 || !records.length) return false;
      var next = queue.next(records, currentSide);
      if (!next) return false;
      if (next.index === currentSide && records.length < 2) return false;
      currentSide = next.index;
      lastPosition = 0;
      adapter.skip(next.index);
      _ui.reflectTitle();
      _ui.fillCrate();
      safePlay();
      vlog(2, 'queue:advance', { reason: reason || 'next', side: next.index });
      return true;
    }

    function handleRemoteClaim() {
      if (spinning && adapter.isInit()) {
        adapter.pause();
        spinning = false;
        if (FEATURE_GROOVE_IMMERSIVE) groove.stopFlow();
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

    /* ── deactivate ────────────────────────────────────────────
       Retained for API symmetry with activate(); intentionally a
       no-op now that DND is strictly presentational. Previous
       revisions paused the adapter and yielded ownership here,
       which silently broke the persistent-player contract every
       time the user toggled DND off (or cycled palettes through
       a data-theme mutation). Audio lifecycle is now owned solely
       by explicit user input, the remote-claim handler, and the
       page-unload guard. */
    function deactivate() {
      /* no-op — DND is presentational */
    }

    function mute() {
      savedVolume = _ui.getDialValue() || DEFAULT_VOLUME;
      store.volumeWrite(savedVolume);
      adapter.setVolume(0);
      _ui.setDialValue(0);
      hushed = true;
      _ui.reflectVolume();
    }

    function unmute() {
      adapter.setVolume(savedVolume);
      _ui.setDialValue(savedVolume);
      store.volumeWrite(savedVolume);
      hushed = false;
      _ui.reflectVolume();
    }

    function setVolume(v) {
      adapter.setVolume(v);
      hushed = v === 0;
      if (v > 0) savedVolume = v;
      store.volumeWrite(v > 0 ? v : savedVolume);
      _ui.reflectVolume();
    }

    return {
      wire: wire,
      isSpinning: function () { return spinning; },
      isHushed: function () { return hushed; },
      getSavedVolume: function () { return savedVolume; },
      getRecords: function () { return records; },
      getQueue: function () { return queue.resolve(records, currentSide); },
      getQueuePosition: function () { return queue.position(records, currentSide); },
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
      skip: function (index) { return selectSide(index, false); },
      select: selectSide,
      advanceQueue: advanceQueue,
      mute: mute,
      unmute: unmute,
      setVolume: setVolume,
      seekToFraction: seekToFraction,
      setScrubbing: setScrubbing,
      isScrubbing: isScrubbing,
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

      el.dial.value = store.volumeRead();

      if (FEATURE_GROOVE) {
        el.groove = el.stage.querySelector('.vinyl-groove-wrap');
        if (el.groove) groove.mount(el.groove);
      }

      /* ── Groove seek: interactive waveform (v5.1.0) ─────── */
      if (FEATURE_GROOVE_SEEK && el.groove) {
        mountGrooveSeek(el.groove);
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
          var items = el.crate.querySelectorAll('[role="option"]');
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

      }
    }

    /* ── Groove seek interaction (v5.1.0) ───────────────────── */
    /*    Handles click-to-seek, drag-to-scrub, touch support,  */
    /*    and hover preview. All events gated behind phase       */
    /*    checks — inert when widget isn't ready.                */

    function mountGrooveSeek(wrap) {
      var dragging = false;

      /* Promote from decorative to interactive for assistive tech */
      wrap.removeAttribute('aria-hidden');
      wrap.setAttribute('role', 'slider');
      wrap.setAttribute('aria-label', 'Seek position');
      wrap.setAttribute('aria-valuemin', '0');
      wrap.setAttribute('aria-valuemax', '100');
      wrap.setAttribute('aria-valuenow', '0');
      wrap.setAttribute('tabindex', '0');

      /* Keyboard seek: left/right arrows step ±5% */
      wrap.addEventListener('keydown', function (e) {
        if (!_ctrl.isReady()) return;
        var rec = _ctrl.getCurrentRecord();
        if (!rec || !rec.duration) return;
        var current = _ctrl.getLastPosition() / rec.duration;
        var step = 0.05;
        if (e.key === 'ArrowRight' || e.key === 'Right') {
          e.preventDefault();
          _ctrl.seekToFraction(Math.min(1, current + step));
        } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
          e.preventDefault();
          _ctrl.seekToFraction(Math.max(0, current - step));
        }
      });

      /* Convert a pointer/touch event to a fraction via hit-test.
         Uses changedTouches for touchend (touches list is empty). */
      function fracFromEvent(e) {
        var clientX;
        if (e.touches && e.touches.length) {
          clientX = e.touches[0].clientX;
        } else if (e.changedTouches && e.changedTouches.length) {
          clientX = e.changedTouches[0].clientX;
        } else {
          clientX = e.clientX;
        }
        return groove.hitTest(clientX);
      }

      /* ── Pointer down: begin scrub ──────────────────────── */
      function onPointerDown(e) {
        if (!_ctrl.isReady()) return;
        if (e.button && e.button !== 0) return;      // left-click only
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        _ctrl.setScrubbing(true);
        wrap.classList.add('vinyl-groove--scrubbing');
        if (FEATURE_GROOVE_IMMERSIVE) groove.clearHoverTime(); // dismiss tooltip before drag

        var frac = fracFromEvent(e);
        if (frac >= 0) groove.snap(frac);   // immediate — no lerp lag on initial click

        /* Bind move/up to document so drag works outside the bar */
        document.addEventListener('mousemove', onPointerMove, { passive: false });
        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('touchmove', onPointerMove, { passive: false });
        document.addEventListener('touchend', onPointerUp);
        document.addEventListener('touchcancel', onPointerUp);
      }

      /* ── Pointer move: live scrub preview ───────────────── */
      function onPointerMove(e) {
        if (!dragging) return;
        e.preventDefault();
        var frac = fracFromEvent(e);
        if (frac >= 0) {
          groove.preview(-1);        // clear hover — show fill instead
          groove.snap(frac);         // immediate snap — drag must track cursor 1:1
        }
      }

      /* ── Pointer up: commit seek ────────────────────────── */
      function onPointerUp(e) {
        if (!dragging) return;
        dragging = false;
        _ctrl.setScrubbing(false);
        wrap.classList.remove('vinyl-groove--scrubbing');

        document.removeEventListener('mousemove', onPointerMove);
        document.removeEventListener('mouseup', onPointerUp);
        document.removeEventListener('touchmove', onPointerMove);
        document.removeEventListener('touchend', onPointerUp);
        document.removeEventListener('touchcancel', onPointerUp);

        var frac = fracFromEvent(e);
        if (frac >= 0) {
          _ctrl.seekToFraction(frac);
        }
        groove.clearPreview();
        if (FEATURE_GROOVE_IMMERSIVE) groove.clearHoverTime();
      }

      /* ── Hover: preview indicator + time tooltip (v5.2.0) ─ */
      function onHover(e) {
        if (dragging || !_ctrl.isReady()) return;
        var frac = fracFromEvent(e);
        if (frac >= 0) {
          groove.preview(frac);
          if (FEATURE_GROOVE_IMMERSIVE) {
            var rec = _ctrl.getCurrentRecord();
            if (rec && rec.duration) groove.setHoverTime(frac, rec.duration, wrap);
          }
        }
      }

      function onHoverLeave() {
        if (!dragging) {
          groove.clearPreview();
          if (FEATURE_GROOVE_IMMERSIVE) groove.clearHoverTime();
        }
      }

      /* ── Click: simple click-to-seek (non-drag) ─────────── */
      /*    Handled via mousedown→mouseup sequence above.        */
      /*    Standalone click fires if pointer didn't move.       */

      /* ── Bind events ────────────────────────────────────── */
      wrap.addEventListener('mousedown', onPointerDown);
      wrap.addEventListener('touchstart', onPointerDown, { passive: false });
      wrap.addEventListener('mousemove', onHover);
      wrap.addEventListener('mouseleave', onHoverLeave);
    }

    function reflectSpin() {
      var s = _ctrl.isSpinning();
      glyph.spin.hidden = s;
      glyph.lift.hidden = !s;
      el.spin.setAttribute('aria-label', s ? 'Pause' : 'Play');
      el.spin.title = s ? 'Pause' : 'Play';
      el.stage.classList.toggle('vinyl--spinning', s);
      reflectStationStatus();
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
      reflectStationStatus();
    }

    function reflectCrate() {
      var side = _ctrl.getCurrentSide();
      var items = el.crate.querySelectorAll('[role="option"]');
      for (var i = 0; i < items.length; i++) {
        var idx = parseInt(items[i].getAttribute('data-index'), 10);
        items[i].setAttribute('aria-selected', idx === side ? 'true' : 'false');
      }
      var active = el.crate.querySelector('[aria-selected="true"]');
      if (active && !el.crate.hidden) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function recordMeta(rec) {
      var parts = [];
      if (rec.artist) parts.push(rec.artist);
      else if (rec.source) parts.push(rec.source);
      else parts.push('SoundCloud');
      if (rec.duration) parts.push(formatDuration(rec.duration));
      return parts.join(' · ');
    }

    function displayQueue(recs, currentPos) {
      if (!FEATURE_QUEUE_V6 || currentPos <= 0 || currentPos >= recs.length) return recs;
      return recs.slice(currentPos).concat(recs.slice(0, currentPos));
    }

    function reflectNowPlaying() {
      if (!FEATURE_CRATE_V2 || !el.upnext) return;
      if (!_ctrl.isSpinning() && _sync.getRemoteState() && _sync.getRemoteState().title && !_sync.isOwner()) return;
      var side = _ctrl.getCurrentSide();
      var recs = (FEATURE_QUEUE_V6 && FEATURE_CRATE_V2) ? _ctrl.getQueue() : _ctrl.getRecords();
      var nextRec = null;
      if (FEATURE_QUEUE_V6) {
        var pos = _ctrl.getQueuePosition();
        if (pos >= 0 && recs.length > 1) nextRec = recs[(pos + 1) % recs.length];
        else if (recs.length) nextRec = recs[0];
      } else {
        var next = side + 1;
        if (next < recs.length) nextRec = recs[next];
      }
      if (nextRec) {
        el.upnext.textContent = 'Up next \u2014 ' + nextRec.title;
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
      reflectStationStatus();
    }

    function fillCrate() {
      el.crate.innerHTML = '';
      var queueUi = FEATURE_QUEUE_V6 && FEATURE_CRATE_V2;
      var currentPos = queueUi ? _ctrl.getQueuePosition() : -1;
      var recs = queueUi ? displayQueue(_ctrl.getQueue(), currentPos) : _ctrl.getRecords();
      var side = _ctrl.getCurrentSide();

      if (queueUi) {
        var strip = document.createElement('li');
        strip.className = 'vinyl-crate-strip' +
          (FEATURE_TITLE_STRIP_V1 ? ' vinyl-crate-strip--energized' : '');
        strip.setAttribute('role', 'presentation');
        var stationStatus = document.createElement('button');
        stationStatus.className = 'vinyl-station-status';
        stationStatus.type = 'button';
        var stationIcon = document.createElement('span');
        stationIcon.className = 'vinyl-station-orb';
        stationIcon.setAttribute('aria-hidden', 'true');
        stationStatus.appendChild(stationIcon);
        stationStatus.addEventListener('click', function (e) {
          e.stopPropagation();
          onSpin();
        });
        var stationCopy = document.createElement('span');
        stationCopy.className = 'vinyl-station-copy';
        var stationName = document.createElement('span');
        stationName.className = 'vinyl-station-name';
        stationName.textContent = 'abstraction.sound';
        var stationLabel = document.createElement('span');
        stationLabel.className = 'vinyl-station-label';
        stationLabel.textContent = 'queue rotation';
        var stationSignal = document.createElement('span');
        stationSignal.className = 'vinyl-station-signal';
        stationCopy.appendChild(stationName);
        stationCopy.appendChild(stationLabel);
        strip.appendChild(stationStatus);
        strip.appendChild(stationCopy);
        strip.appendChild(stationSignal);
        el.stationStatus = stationStatus;
        el.stationSignal = stationSignal;
        reflectStationStatus();
        el.crate.appendChild(strip);
      }

      if (!recs.length) {
        var empty = document.createElement('li');
        empty.className = 'vinyl-queue-empty';
        empty.setAttribute('role', 'presentation');
        empty.textContent = 'Signal warming';
        el.crate.appendChild(empty);
        return;
      }

      recs.forEach(function (rec, i) {
        var li = document.createElement('li');
        li.className = queueUi ? 'vinyl-queue-row' : '';
        var label = rec.title;
        if (FEATURE_CRATE_V2) {
          if (FEATURE_SLEEVE_V3) {
            label = rec.title;
            if (rec.duration && !queueUi) label += '  ' + formatDuration(rec.duration);
          } else {
            var num = String(i + 1).padStart(2, '0');
            label = num + ' \u00b7 ' + rec.title;
            if (rec.duration) label += '  (' + formatDuration(rec.duration) + ')';
          }
          li.setAttribute('tabindex', '0');
        }
        if (queueUi) {
          var status = rec.index === side ? 'on air' : (i === 1 ? 'next' : 'upcoming');
          var meta = recordMeta(rec);
          var copy = document.createElement('span');
          copy.className = 'vinyl-queue-copy';
          var title = document.createElement('span');
          title.className = 'vinyl-queue-title';
          title.textContent = label;
          var metaEl = document.createElement('span');
          metaEl.className = 'vinyl-queue-meta';
          metaEl.textContent = meta;
          var state = document.createElement('span');
          state.className = 'vinyl-queue-state';
          state.textContent = status;
          copy.appendChild(title);
          copy.appendChild(metaEl);
          li.appendChild(copy);
          li.appendChild(state);
          li.setAttribute('aria-label', label + ', ' + meta + (rec.index === side ? ', current track' : ', selectable'));
        } else {
          li.textContent = label;
        }
        li.setAttribute('role', 'option');
        li.setAttribute('data-index', rec.index);
        if (rec.index === side) li.setAttribute('aria-selected', 'true');
        li.addEventListener('click', function () {
          if (_ctrl.select) _ctrl.select(rec.index, true);
          else {
            _ctrl.skip(rec.index);
            _ctrl.play();
          }
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

    function stationState() {
      var remote = _sync && _sync.getRemoteState ? _sync.getRemoteState() : null;
      var remotePlaying = _sync && !_sync.isOwner() && !_ctrl.isSpinning() && remote && remote.spinning !== false;
      var phase = _ctrl.getPhase ? _ctrl.getPhase() : '';

      if (_ctrl.isSpinning()) {
        return { key: 'playing', signal: 'on air', label: 'Music playing. Pause playback' };
      }
      if (remotePlaying) {
        return { key: 'remote-playing', signal: 'elsewhere', label: 'Music playing in another tab. Play here' };
      }
      if (phase === 'loading' || phase === 'dormant') {
        return { key: 'loading', signal: 'warming', label: 'Music warming up' };
      }
      if (phase === 'errored') {
        return { key: 'errored', signal: 'signal lost', label: 'Music unavailable' };
      }
      return {
        key: 'idle',
        signal: 'standby',
        label: _ctrl.isReady() ? 'Music paused. Play' : 'Music standby'
      };
    }

    function reflectStationStatus() {
      if (!el.stationStatus || !el.stationSignal) return;
      var state = stationState();
      var canToggle = state.key !== 'loading' && state.key !== 'errored' && _ctrl.isReady();

      el.stationStatus.setAttribute('data-vinyl-station-state', state.key);
      el.stationStatus.setAttribute('aria-label', state.label);
      el.stationStatus.title = state.label;
      el.stationStatus.disabled = !canToggle;
      el.stationSignal.textContent = state.signal;
    }

    function raiseStage() {
      el.stage.removeAttribute('aria-hidden');
      el.stage.removeAttribute('inert');
      void el.stage.offsetHeight;
      el.stage.classList.add('vinyl--live');
    }

    function lowerStage() {
      vlog(2, 'stage:lower');
      el.stage.classList.remove('vinyl--live');
      el.stage.setAttribute('aria-hidden', 'true');
      el.stage.setAttribute('inert', '');
      toggleCrate(false);
    }

    /* ── onMoodShift ────────────────────────────────────────────
       Fires whenever `data-theme` mutates on the documentElement.
       DND is strictly presentational: entering lifts the stage and
       (idempotently) warms the SDK so the first play is instant;
       leaving simply lowers the stage. The persistent player keeps
       streaming across DND toggles, palette cycles, SPA route
       swaps, and tab visibility changes. Audio is interrupted only
       by explicit user input, a remote claim from another tab, or
       a real page unload. */
    function onMoodShift() {
      if (isDND()) {
        _ctrl.activate();   // idempotent: guarded by needleDropped + phase
        raiseStage();
      } else {
        lowerStage();       // presentational only; audio continues
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
      reflectStationStatus: reflectStationStatus,
      fillCrate: fillCrate,
      toggleCrate: toggleCrate,
      raiseStage: raiseStage,
      lowerStage: lowerStage,
      setTitle: function (text) { el.title.textContent = text; },
      getTitle: function () { return el.title.textContent; },
      getDialValue: function () { return parseInt(el.dial.value, 10) || 0; },
      setDialValue: function (v) { el.dial.value = v; },
      getSource: function () { return el.source; },
      updateGrooveAria: function (pct) {
        if (FEATURE_GROOVE_SEEK && el.groove && el.groove.hasAttribute('role')) {
          el.groove.setAttribute('aria-valuenow', String(Math.round(pct)));
        }
      }
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
