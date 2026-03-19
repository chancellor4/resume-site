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
    needle   — SC.Widget instance (the stylus reading the groove)
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

  var LOG_LEVEL = (function () {
    if (!FEATURE_OBSERVABILITY) return 0;
    try {
      var m = location.search.match(/[?&]vinyl-log=(\d)/);
      return m ? parseInt(m[1], 10) : 0;
    } catch (e) { return 0; }
  })();

  /* ── State ───────────────────────────────────────────────── */

  var needle        = null;                          // SC.Widget instance
  var spinning      = false;                         // is a record playing?
  var hushed        = false;                         // is the volume muted?
  var savedVolume   = DEFAULT_VOLUME;
  var records       = [];                            // [{title, index}, …]
  var currentSide   = 0;                             // active track index
  var sdkReady      = false;
  var sdkPending    = false;                         // prevents duplicate <script>
  var sourceReady   = false;
  var needleDropped = false;                         // prevents double init
  var lastSidePoll  = 0;                             // throttle for progress events
  var lastPosition  = 0;                             // ms, from PLAY_PROGRESS
  var channel       = null;                          // BroadcastChannel instance
  var tabId         = '';                             // unique per page load (set in initChannel)
  var isOwner       = false;                         // playback ownership flag
  var lastSync      = 0;                             // throttle for broadcastSync
  var ownerTabId    = '';                             // tabId of current playback owner
  var lastOwnerSeen = 0;                             // timestamp of last owner message
  var remoteState   = null;                          // { side, title, pos, spinning }
  var heartbeatTimer  = null;                         // setInterval: owner heartbeat
  var electionTimer   = null;                         // setTimeout: stale-owner recovery
  var pendingElection = false;                        // true while election timer runs
  var yieldGraceTimer = null;                         // v3.0.0: setTimeout for yield grace window
  var claimEpoch      = 0;                            // v3.0.0: monotonic claim counter (per session)

  /* ── DOM refs (resolved once in overture) ────────────────── */

  var el    = {};                                    // interactive elements
  var glyph = {};                                    // SVG icon elements

  /* ── Helpers ─────────────────────────────────────────────── */

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

  /* ── Lifecycle state machine (v1.4.0) ───────────────────── */
  /*    `phase` is the single source of truth for operational   */
  /*    lifecycle. `transition(to)` validates legal moves and   */
  /*    logs rejected attempts at warn level for triage.        */
  /*    Stage visibility is orthogonal — lowerStage hides the   */
  /*    UI without altering the phase.                          */

  var phase = 'dormant';

  var LEGAL_MOVES = {
    dormant:  ['loading'],
    loading:  ['ready', 'errored'],
    ready:    ['playing', 'errored'],
    playing:  ['paused', 'ready', 'errored'],
    paused:   ['playing', 'ready', 'errored'],
    errored:  []
  };

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

  /* ── Cross-tab coordination (v2.0.0) ──────────────────── */
  /*    Single-owner model via BroadcastChannel: last tab to   */
  /*    play claims ownership; other tabs pause and enter      */
  /*    observer mode, reflecting the owner's playback state.  */
  /*    Messages are coordination hints — no tab takes remote  */
  /*    control of another's playback.                         */
  /*                                                           */
  /*    Message vocabulary:                                     */
  /*      claim — "I am now playing"                           */
  /*      yield — "I have stopped playing"                     */
  /*      sync  — periodic owner state (doubles as heartbeat)  */
  /*                                                           */
  /*    Resilience:                                            */
  /*      - safeBroadcast wraps postMessage in try/catch       */
  /*      - stale messages (>OWNER_STALE ms old) are dropped   */
  /*      - owner yields on pagehide for clean tab-close       */
  /*      - observers detect stale owners via lastOwnerSeen    */

  /* v3.0.0: stable session identity — persists tabId across same-tab navigations
     via sessionStorage so the user's "tab" keeps a single identity as they move
     between index → projects → about. Different tabs get different sessionStorage
     instances, providing natural isolation without coordination.                  */

  function initTabId() {
    if (FEATURE_OWNERSHIP_V3) {
      try {
        var stored = sessionStorage.getItem(TAB_ID_KEY);
        if (stored) {
          vlog(3, 'identity:restored', { tabId: stored });
          return stored;
        }
      } catch (e) { /* private mode — fall through to fresh id */ }
    }
    var fresh = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (FEATURE_OWNERSHIP_V3) {
      try { sessionStorage.setItem(TAB_ID_KEY, fresh); } catch (e) {}
    }
    vlog(3, 'identity:created', { tabId: fresh });
    return fresh;
  }

  function initClaimEpoch() {
    if (!FEATURE_OWNERSHIP_V3) return 0;
    try {
      var stored = sessionStorage.getItem(CLAIM_EPOCH_KEY);
      return stored ? parseInt(stored, 10) || 0 : 0;
    } catch (e) { return 0; }
  }

  function persistClaimEpoch() {
    if (!FEATURE_OWNERSHIP_V3) return;
    try { sessionStorage.setItem(CLAIM_EPOCH_KEY, String(claimEpoch)); } catch (e) {}
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

      /* v4.0.0: detect same-tab navigation via the nav marker.
         If present, this page load is a continuation of a previous
         owner session (same tab navigated between pages). Reclaim
         ownership immediately — before the widget loads — so other
         tabs never see an ownership gap.                            */
      if (FEATURE_CONTINUITY_V4) {
        try {
          var navMarker = sessionStorage.getItem(NAV_MARKER_KEY);
          if (navMarker) {
            sessionStorage.removeItem(NAV_MARKER_KEY);
            vlog(2, 'continuity:nav-detected', { tabId: tabId });
            vmark('continuity:nav-reclaim');
            broadcastClaim();                          // early reclaim — pre-widget
            return;                                    // skip ping — we ARE the owner
          }
        } catch (e) { /* private mode — fall through to normal boot */ }
      }

      sendPing();                                    // v2.1.0: discover existing owner
    } catch (e) {
      /* BroadcastChannel throws on opaque origins (file://, sandboxed iframes).
         Emit an operational warn so this is visible even at LOG_LEVEL=0.       */
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
    /* Clear stale remote owner tracking before claiming */
    if (ownerTabId && ownerTabId !== tabId && isOwnerStale()) {
      vlog(2, 'broadcast:stale-owner-cleared', { previous: ownerTabId });
    }
    isOwner = true;
    ownerTabId = tabId;
    lastOwnerSeen = Date.now();
    remoteState = null;
    cancelElection();                                  // v2.1.0: cancel any pending election
    cancelYieldGrace();                                // v3.0.0: cancel any pending yield grace

    /* v3.0.0: increment claim epoch for deterministic ordering */
    if (FEATURE_OWNERSHIP_V3) {
      claimEpoch++;
      persistClaimEpoch();
    }

    safeBroadcast({ type: 'claim', tabId: tabId, ts: Date.now(), epoch: claimEpoch });
    startHeartbeat();                                  // v2.1.0: begin liveness signals
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
    stopHeartbeat();                                   // v2.1.0: stop liveness signals
    safeBroadcast({ type: 'yield', tabId: tabId, ts: Date.now(), reason: reason || 'explicit' });
    vlog(3, 'broadcast:yield', { tabId: tabId, reason: reason || 'explicit' });
  }

  /* v3.0.0: broadcast a pause-state sync instead of yielding ownership.
     When the user pauses playback, the tab retains conceptual ownership —
     other tabs see "Paused" rather than "no owner". Yield only fires on
     tab close or DND deactivation.                                        */

  function broadcastPauseRetain() {
    if (!FEATURE_OWNERSHIP_V3 || !channel || !isOwner) return;
    var title = records[currentSide] ? records[currentSide].title : '';
    lastSync = Date.now();
    safeBroadcast({
      type: 'sync',
      tabId: tabId,
      payload: {
        side: currentSide,
        spinning: false,
        pos: lastPosition,
        title: title,
        ts: Date.now()
      }
    });
    vlog(3, 'broadcast:pause-retain', { side: currentSide });
  }

  /* v3.0.0: yield-grace window management.
     When a yield is received from the current owner's tabId, start a
     grace timer instead of clearing immediately. If the same tabId
     reclaims within YIELD_GRACE_MS (same-tab navigation), the yield
     is absorbed transparently. If the timer expires, process the yield. */

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
    var title = records[currentSide] ? records[currentSide].title : '';
    safeBroadcast({
      type: 'sync',
      tabId: tabId,
      payload: {
        side: currentSide,
        spinning: spinning,
        pos: lastPosition,
        title: title,
        ts: now
      }
    });
    vlog(3, 'broadcast:sync', { side: currentSide, pos: lastPosition });
  }

  function onChannelMessage(e) {
    var msg = e.data;
    if (!msg || msg.tabId === tabId) return;

    /* Stale message protection — drop messages older than OWNER_STALE */
    if (msg.ts && Date.now() - msg.ts > OWNER_STALE) {
      vlog(3, 'broadcast:stale', { type: msg.type, age: Date.now() - msg.ts });
      return;
    }

    /* v2.1.0: any fresh message from the current owner resets liveness
       tracking and cancels any pending stale-owner recovery. */
    if (FEATURE_LEADER_ELECTION && msg.tabId === ownerTabId) {
      lastOwnerSeen = msg.ts || Date.now();
      cancelElection();
    }

    switch (msg.type) {
      case 'claim':
        vlog(2, 'broadcast:remote-claim', { from: msg.tabId, epoch: msg.epoch });
        cancelYieldGrace();                            // v3.0.0: incoming claim supersedes grace
        ownerTabId = msg.tabId;
        lastOwnerSeen = msg.ts || Date.now();
        cancelElection();                              // v2.1.0: new owner supersedes election
        if (isOwner) {
          isOwner = false;
          stopHeartbeat();                             // v2.1.0: relinquish heartbeat
        }
        if (spinning && needle) {
          needle.pause();
          spinning = false;                            // reflect immediately; PAUSE event is async
          transition('paused', 'remote-claim');         // keep phase consistent with spinning
          reflectSpin();
        }
        remoteState = null;                            // populated by first sync
        break;
      case 'yield':
        vlog(3, 'broadcast:remote-yield', { from: msg.tabId, reason: msg.reason });
        if (ownerTabId === msg.tabId) {
          /* v3.0.0: yield-grace window — delay clearing to absorb same-tab navigation.
             If the same tabId reclaims within YIELD_GRACE_MS, the yield is transparent.
             When v3 is off, yield clears immediately (v2.1 behavior).                  */
          if (FEATURE_OWNERSHIP_V3) {
            cancelYieldGrace();
            var yieldFrom = msg.tabId;
            /* v4.0.0: use wider grace window when continuity hardening is on */
            var graceMs = FEATURE_CONTINUITY_V4 ? V4_YIELD_GRACE_MS : YIELD_GRACE_MS;
            yieldGraceTimer = setTimeout(function () {
              yieldGraceTimer = null;
              if (ownerTabId === yieldFrom) {
                vlog(2, 'yield-grace:expired', { from: yieldFrom });
                ownerTabId = '';
                remoteState = null;
                reflectRemoteState();
              }
            }, graceMs);
            vlog(3, 'yield-grace:started', { from: yieldFrom, grace: graceMs });
          } else {
            ownerTabId = '';
            remoteState = null;
            reflectRemoteState();
          }
        }
        break;
      case 'sync':
        if (msg.tabId !== ownerTabId) break;           // ignore syncs from non-owner
        lastOwnerSeen = (msg.payload && msg.payload.ts) || Date.now();
        remoteState = msg.payload || null;
        vlog(3, 'broadcast:remote-sync', msg.payload);
        if (!isOwner) reflectRemoteState();
        break;

      /* v2.1.0: leadership election messages */
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
        if (!isOwner) reflectRemoteState();
        break;
    }
  }

  function isOwnerStale() {
    if (!ownerTabId || ownerTabId === tabId) return false;
    return Date.now() - lastOwnerSeen > OWNER_STALE;
  }

  function reflectRemoteState() {
    if (!FEATURE_CRATE_V2 || !el.upnext) return;
    if (!isOwner && !spinning && remoteState && remoteState.title) {
      /* v3.0.0: distinguish playing vs paused remote state */
      var prefix = (FEATURE_OWNERSHIP_V3 && remoteState.spinning === false)
        ? 'Paused elsewhere'
        : 'Playing elsewhere';
      el.upnext.textContent = prefix + ' \u2014 ' + remoteState.title;
      el.upnext.hidden = false;
    } else if (!remoteState && !spinning) {
      /* Remote owner gone — revert to normal "Up next" display */
      reflectNowPlaying();
    }
  }

  /* ── Leadership election (v2.1.0) ────────────────────────
     Heartbeat: owner sends periodic liveness signals so
     observers can detect a dead owner (closed tab, crash).
     Discovery: new tabs send a `ping`; the owner replies
     with a `pong` carrying current playback state.
     Recovery: when no heartbeat arrives for OWNER_STALE ms,
     observers clear stale ownership and update UI.
     Election jitter prevents simultaneous claims.
     ────────────────────────────────────────────────────── */

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
    /* Deterministic jitter from tabId so concurrent observers
       stagger their recovery, avoiding simultaneous claims. */
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
      reflectRemoteState();
      /* Don't auto-claim — let the user initiate play.
         This avoids unwanted audio and respects user intent. */
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
    var title = records[currentSide] ? records[currentSide].title : '';
    safeBroadcast({
      type: 'pong',
      tabId: tabId,
      ts: Date.now(),
      payload: {
        side: currentSide,
        spinning: spinning,
        pos: lastPosition,
        title: title
      }
    });
    vlog(3, 'leader:pong-sent', { to: toTabId });
  }

  /* ── Shelf: session-cache for record metadata ────────────── */

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

  /* ── Continuity: persist playback across page navigation ─── */

  function saveState() {
    if (!sourceReady) return;
    try {
      var payload = {
        side: currentSide,
        spinning: spinning,
        pos: lastPosition || 0,
        ts: Date.now()
      };
      /* v1.3.0: enrich payload with schema version and audio state */
      if (FEATURE_ENHANCED_PERSISTENCE) {
        payload.v = CONT_SCHEMA;
        payload.vol = parseInt(el.dial.value, 10) || DEFAULT_VOLUME;
        payload.hushed = hushed;
      }
      sessionStorage.setItem(CONT_KEY, JSON.stringify(payload));
      vlog(3, 'continuity:saved', { side: payload.side, pos: payload.pos, vol: payload.vol, hushed: payload.hushed });
    } catch (e) {}
  }

  function restoreState() {
    try {
      var raw = sessionStorage.getItem(CONT_KEY);
      if (!raw) return;
      var state = JSON.parse(raw);
      sessionStorage.removeItem(CONT_KEY);
      if (Date.now() - state.ts > CONT_TTL) {
        vlog(3, 'continuity:stale', { age: Date.now() - state.ts });
        return;                                      // stale — discard
      }
      if (typeof state.side === 'number' && state.side !== currentSide) {
        currentSide = state.side;
        needle.skip(state.side);
      }
      if (state.pos > 0) needle.seekTo(state.pos);

      /* v1.3.0: restore volume and mute state from schemaed payloads */
      if (FEATURE_ENHANCED_PERSISTENCE && state.v >= CONT_SCHEMA) {
        if (typeof state.vol === 'number') {
          needle.setVolume(state.hushed ? 0 : state.vol);
          el.dial.value = state.hushed ? 0 : state.vol;
          savedVolume = state.vol;
        }
        if (state.hushed) {
          hushed = true;
          reflectVolume();
        }
      } else if (FEATURE_ENHANCED_PERSISTENCE && !state.v) {
        /* Pre-v1.3.0 payload — no schema version present */
        vlog(3, 'continuity:schema-fallback', { v: state.v || 0 });
      }

      if (state.spinning) safePlay();
      vlog(2, 'continuity:restored', {
        side: state.side, pos: state.pos, spinning: state.spinning,
        vol: state.vol, hushed: state.hushed
      });
      vmark('continuity:restored');
      reflectTitle();
      reflectCrate();
    } catch (e) {}
  }

  /* ── Fetch SoundCloud Widget SDK (lazy) ──────────────────── */
  /*    v1.1.0: optional retry with exponential backoff.       */
  /*    The `attempt` parameter is internal — callers still    */
  /*    invoke fetchSDK(cb) with the same signature.           */

  function fetchSDK(cb, attempt) {
    if (sdkReady) return cb();
    if (sdkPending) return;                          // already in flight
    sdkPending = true;                               // reset in onerror before retry delay;
                                                     // single-caller guarantee via needleDropped
                                                     // prevents concurrent attempts during backoff
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
        el.title.textContent = 'Unavailable';
        transition('errored', 'sdk-failed');
      }
    };
    document.head.appendChild(s);
  }

  /* ── Warm up the hidden iframe source ────────────────────── */

  function warmSource() {
    if (el.source.src && el.source.src !== 'about:blank') return;
    el.source.src =
      'https://w.soundcloud.com/player/?url=' + encodeURIComponent(CRATE_URL) +
      '&auto_play=false&show_artwork=false&visual=false' +
      '&buying=false&sharing=false&download=false' +
      '&show_playcount=false&show_comments=false&color=%237b5e7b';
  }

  /* ── Autoplay-safe play wrapper ────────────────────────────
     Browsers may reject play() if no user gesture preceded it.
     The SC Widget may return a Promise from play(); we catch
     rejections silently so the UI stays consistent.
     ────────────────────────────────────────────────────────── */

  function safePlay() {
    if (!needle) return;
    try {
      var result = needle.play();
      if (result && typeof result.catch === 'function') {
        result.catch(function () {
          /* Autoplay blocked — needle stays lifted, no error shown.
             v1.4.0: revert phase if PLAY event already promoted us. */
          if (phase === 'playing') transition('ready', 'autoplay-blocked');
          spinning = false;
          reflectSpin();
        });
      }
    } catch (e) {
      /* Defensive: older SC Widget versions may not return a Promise.
         v1.4.0: revert phase if PLAY event preceded the exception. */
      if (phase === 'playing') transition('ready', 'autoplay-blocked');
      spinning = false;
      reflectSpin();
    }
  }

  /* ── Drop the needle: initialise the widget ──────────────── */

  function dropNeedle() {
    if (needleDropped) return;                       // guard: one init only
    /* v1.1.0: strict interface validation — verify SC.Widget is callable   */
    /*         and exposes the Events map we depend on. Catches SDK shape   */
    /*         changes before they surface as cryptic runtime errors.       */
    var valid = window.SC && window.SC.Widget &&
      (FEATURE_RESILIENCE
        ? typeof SC.Widget === 'function' && SC.Widget.Events && SC.Widget.Events.READY
        : true);
    if (!valid) {
      el.title.textContent = 'Unavailable';
      console.warn('[vinyl] SC.Widget interface validation failed.');
      transition('errored', 'widget-invalid');
      return;
    }

    needleDropped = true;
    needle = SC.Widget(el.source);

    needle.bind(SC.Widget.Events.READY, function () {
      sourceReady = true;
      vlog(2, 'widget:ready');
      vmark('widget:ready');
      needle.setVolume(DEFAULT_VOLUME);
      catalogRecords();
    });

    needle.bind(SC.Widget.Events.PLAY, function () {
      if (FEATURE_STATE_MACHINE && !transition('playing', 'play-event')) return;
      spinning = true;
      reflectSpin();
      broadcastClaim();
    });

    needle.bind(SC.Widget.Events.PAUSE, function () {
      if (FEATURE_STATE_MACHINE && !transition('paused', 'pause-event')) return;
      spinning = false;
      reflectSpin();
      saveState();
      /* v3.0.0: retain ownership on pause — broadcast paused state instead of
         yielding. Other tabs see "Paused — Track Name" rather than losing the
         owner entirely. Yield only fires on tab close or DND deactivation.
         When v3 is off, fall back to v2.1 yield-on-pause behavior.            */
      if (FEATURE_OWNERSHIP_V3) {
        broadcastPauseRetain();
      } else {
        broadcastYield();
      }
    });

    needle.bind(SC.Widget.Events.FINISH, function () {
      transition('ready', 'track-finished');
      spinning = false;
      reflectSpin();
    });

    /* Track change detection via progress events.
       Throttled: polls getCurrentSoundIndex at most once per second,
       and only when there are multiple records to track. */
    needle.bind(SC.Widget.Events.PLAY_PROGRESS, function (data) {
      if (data && data.currentPosition) lastPosition = data.currentPosition;
      broadcastSync();
      if (records.length < 2) return;                // single track — nothing to detect
      var now = Date.now();
      if (now - lastSidePoll < 1000) return;         // throttle: 1 s
      lastSidePoll = now;
      needle.getCurrentSoundIndex(function (side) {
        if (side !== currentSide) {
          currentSide = side;
          reflectTitle();
          reflectCrate();
        }
      });
    });

    /* Error event: bad URL, geo-blocked track, or network failure */
    needle.bind(SC.Widget.Events.ERROR, function () {
      transition('errored', 'widget-error');
      spinning = false;
      reflectSpin();
      el.title.textContent = 'Unavailable';
      console.warn('[vinyl] SoundCloud widget encountered an error.');
    });

    /* Safety net: if READY never fires */
    setTimeout(function () {
      if (!sourceReady && el.title.textContent === 'Loading\u2026') {
        el.title.textContent = 'Unavailable';
        transition('errored', 'ready-timeout');
      }
    }, SILENCE_MS);
  }

  /* ── Catalog records from the widget ─────────────────────── */

  function catalogRecords() {
    var cached = shelfRead();
    if (cached && cached.length) {
      records = cached;
      vlog(3, 'catalog:shelf-hit', { tracks: cached.length });
      fillCrate();
      reflectTitle();
      transition('ready', 'catalog-shelf');
      restoreState();
      return;
    }

    needle.getSounds(function (sounds) {
      if (!sounds || !sounds.length) {
        vlog(1, 'catalog:empty');
        el.title.textContent = 'Empty playlist';
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
      fillCrate();
      reflectTitle();
      transition('ready', 'catalog-fetched');
      restoreState();
    });
  }

  /* ── Fill the crate (playlist dropdown) ──────────────────── */

  function fillCrate() {
    el.crate.innerHTML = '';
    records.forEach(function (rec, i) {
      var li = document.createElement('li');
      var label = rec.title;
      if (FEATURE_CRATE_V2) {
        /* v3.1.0: drop numerical index — title only, with optional duration.
           When FEATURE_SLEEVE_V3 is off, retain the "01 · Title" format.    */
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
      if (rec.index === currentSide) li.setAttribute('aria-selected', 'true');
      li.addEventListener('click', function () {
        needle.skip(rec.index);
        safePlay();
        toggleCrate(false);
      });
      el.crate.appendChild(li);
    });
  }

  /* ── Reflect: sync UI elements to current state ──────────── */

  function reflectSpin() {
    glyph.spin.hidden = spinning;
    glyph.lift.hidden = !spinning;
    el.spin.setAttribute('aria-label', spinning ? 'Pause' : 'Play');
    el.spin.title = spinning ? 'Pause' : 'Play';
    el.stage.classList.toggle('vinyl--spinning', spinning);
  }

  function reflectVolume() {
    glyph.loud.hidden   = hushed;
    glyph.hushed.hidden = !hushed;
    el.hush.setAttribute('aria-label', hushed ? 'Unmute' : 'Mute');
    el.hush.title = hushed ? 'Unmute' : 'Mute';
  }

  function reflectTitle() {
    if (records[currentSide]) el.title.textContent = records[currentSide].title;
    reflectNowPlaying();
  }

  function reflectCrate() {
    var items = el.crate.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      var idx = parseInt(items[i].getAttribute('data-index'), 10);
      items[i].setAttribute('aria-selected', idx === currentSide ? 'true' : 'false');
    }
    var active = el.crate.querySelector('[aria-selected="true"]');
    if (active && !el.crate.hidden) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function reflectNowPlaying() {
    if (!FEATURE_CRATE_V2 || !el.upnext) return;
    /* If observing remote playback and not playing locally, defer to reflectRemoteState */
    if (!spinning && remoteState && remoteState.title && !isOwner) return;
    var next = currentSide + 1;
    if (next < records.length && records[next]) {
      el.upnext.textContent = 'Up next \u2014 ' + records[next].title;
      el.upnext.hidden = false;
    } else {
      el.upnext.hidden = true;
    }
  }

  function toggleCrate(open) {
    var show = typeof open === 'boolean' ? open : el.crate.hidden;
    el.crate.hidden = !show;
    el.latch.setAttribute('aria-expanded', String(show));
    el.latch.setAttribute('aria-label', show ? 'Hide playlist' : 'Show playlist');
  }

  /* ── Event handlers ──────────────────────────────────────── */

  function onSpin() {
    if (!needle || !phaseAllowsInteraction()) return;
    spinning ? needle.pause() : safePlay();
  }

  function onHush() {
    if (!needle || !phaseAllowsInteraction()) return;
    if (hushed) {
      needle.setVolume(savedVolume);
      el.dial.value = savedVolume;
      hushed = false;
    } else {
      savedVolume = parseInt(el.dial.value, 10) || DEFAULT_VOLUME;
      needle.setVolume(0);
      el.dial.value = 0;
      hushed = true;
    }
    reflectVolume();
  }

  function onDial() {
    if (!needle || !phaseAllowsInteraction()) return;
    var v = parseInt(el.dial.value, 10);
    needle.setVolume(v);
    hushed = v === 0;
    if (v > 0) savedVolume = v;
    reflectVolume();
  }

  /* ── Stage: raise / lower based on DND mode ────────────── */

  function raiseStage() {
    vlog(2, 'stage:raise');
    vmark('stage:raise');
    if (phase === 'dormant') transition('loading', 'sdk-bootstrap');
    warmSource();
    if (!needleDropped) fetchSDK(dropNeedle);        // only bootstrap once
    el.stage.removeAttribute('aria-hidden');
    void el.stage.offsetHeight;                      // flush layout — gives browser the opacity:0 "from" frame
    el.stage.classList.add('vinyl--live');
  }

  function lowerStage() {
    vlog(2, 'stage:lower');
    el.stage.classList.remove('vinyl--live');
    el.stage.setAttribute('aria-hidden', 'true');
    if (needle && spinning) needle.pause();
    /* v3.0.0: explicitly yield on DND deactivation (not just pause).
       When v3 is on, the PAUSE handler retains ownership, so we need
       a direct yield here to release it when the stage goes down.     */
    if (FEATURE_OWNERSHIP_V3 && isOwner) broadcastYield('dnd-off');
    toggleCrate(false);
  }

  function onMoodShift() {
    isDND() ? raiseStage() : lowerStage();
  }

  /* ── Overture: boot sequence ─────────────────────────────── */

  function overture() {
    el.stage  = $('vinyl');
    el.source = $('vinylSource');
    el.title  = $('vinylTitle');
    el.spin   = $('vinylSpin');
    el.hush   = $('vinylHush');
    el.dial   = $('vinylDial');
    el.latch  = $('vinylLatch');
    el.crate  = $('vinylCrate');

    if (!el.stage) return;                           // bail if markup absent

    glyph.spin   = el.stage.querySelector('.vinyl-icon-spin');
    glyph.lift   = el.stage.querySelector('.vinyl-icon-lift');
    glyph.loud   = el.stage.querySelector('.vinyl-icon-loud');
    glyph.hushed = el.stage.querySelector('.vinyl-icon-hushed');

    /* Bind controls */
    el.spin.addEventListener('click', onSpin);
    el.hush.addEventListener('click', onHush);
    el.dial.addEventListener('input', onDial);
    el.latch.addEventListener('click', function () { toggleCrate(); });

    /* Close crate on outside click */
    document.addEventListener('click', function (e) {
      if (!el.crate.hidden && !el.stage.contains(e.target)) toggleCrate(false);
    });

    /* Escape key closes crate */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.crate.hidden) toggleCrate(false);
    });

    /* Watch data-theme for DND mood shifts */
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === 'data-theme') { onMoodShift(); break; }
      }
    });
    obs.observe(document.documentElement, { attributes: true });

    /* Save playback state on page unload for cross-page continuity */
    var onExit = function () {
      if (sourceReady && isDND()) saveState();
      stopHeartbeat();                                   // v2.1.0: clean timer teardown

      /* v4.0.0: navigation-aware exit. When the owner is in DND mode,
         assume this unload is a same-tab navigation (Resume → Projects)
         rather than a tab close. Set a nav marker so the new page can
         reclaim immediately, and suppress the yield to avoid an
         ownership gap. If the tab is actually closing, the nav marker
         persists in sessionStorage but is harmless — the next session
         in this tab slot will consume and discard it, and other tabs
         detect the stale owner via heartbeat timeout.                 */
      if (FEATURE_CONTINUITY_V4 && isDND() && isOwner) {
        try { sessionStorage.setItem(NAV_MARKER_KEY, '1'); } catch (e) {}
        vlog(3, 'continuity:nav-exit', { tabId: tabId });
      } else {
        broadcastYield('tab-exit');                       // clean ownership release
      }
    };
    window.addEventListener('beforeunload', onExit);
    /* v1.1.0: pagehide fires on mobile Safari and bfcache navigations    */
    /*         where beforeunload is often suppressed. Additive listener  */
    /*         — saveState is idempotent so double-fire is harmless.      */
    if (FEATURE_RESILIENCE) window.addEventListener('pagehide', onExit);

    /* v2.0.0: initialise cross-tab coordination channel */
    initChannel();

    /* v2.1.0: detect stale owner when tab regains focus.
       If the user switches back to a tab whose owner has gone
       silent, trigger election to clear stale ownership. */
    if (FEATURE_LEADER_ELECTION) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (!isOwner && ownerTabId && isOwnerStale()) {
          vlog(2, 'leader:stale-on-focus', { owner: ownerTabId, age: Date.now() - lastOwnerSeen });
          startElection('visibility-change');
        }
      });
    }

    /* v2.0.0: enhanced crate — "Up Next" display + marquee click + keyboard nav */
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

      /* Keyboard navigation in crate */
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

      /* Inject v2.0 styles — zero CSS cost when gate is off */
      var v2css = document.createElement('style');
      v2css.textContent =
        '.vinyl-upnext{display:block;font-size:0.55rem;color:var(--ink-lt,#999);' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.7;line-height:1.2}';
      document.head.appendChild(v2css);
    }

    /* If DND was already saved, raise immediately */
    if (isDND()) raiseStage();
  }

  /* Wait for DOM */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', overture);
  } else {
    overture();
  }

})();
