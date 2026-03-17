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
    source   — hidden SoundCloud iframe
    glyph.*  — SVG icon elements
    el.*     — DOM element references

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
    raise/lower — show / hide the stage
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

  /* ── DOM refs (resolved once in overture) ────────────────── */

  var el    = {};                                    // interactive elements
  var glyph = {};                                    // SVG icon elements

  /* ── Helpers ─────────────────────────────────────────────── */

  function $(id)       { return document.getElementById(id); }
  function isDND()  { return document.documentElement.getAttribute('data-theme') === 'refined'; }

  /* ── Shelf: session-cache for record metadata ────────────── */

  function shelfRead() {
    try {
      var raw = sessionStorage.getItem(SHELF_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - obj.ts > SHELF_TTL) return null;
      return obj.data;
    } catch (e) { return null; }
  }

  function shelfWrite(data) {
    try {
      sessionStorage.setItem(SHELF_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) { /* quota exceeded or private mode — safe to ignore */ }
  }

  /* ── Fetch SoundCloud Widget SDK (lazy) ──────────────────── */

  function fetchSDK(cb) {
    if (sdkReady) return cb();
    if (sdkPending) return;                          // already in flight
    sdkPending = true;
    var s    = document.createElement('script');
    s.src    = SDK_URL;
    s.onload = function () {
      sdkReady   = true;
      sdkPending = false;
      cb();
    };
    s.onerror = function () {
      sdkPending = false;
      console.warn('[vinyl] SoundCloud Widget SDK failed to load.');
      el.title.textContent = 'Unavailable';
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
          /* Autoplay blocked — needle stays lifted, no error shown */
          spinning = false;
          reflectSpin();
        });
      }
    } catch (e) {
      /* Defensive: older SC Widget versions may not return a Promise */
      spinning = false;
      reflectSpin();
    }
  }

  /* ── Drop the needle: initialise the widget ──────────────── */

  function dropNeedle() {
    if (needleDropped) return;                       // guard: one init only
    if (!window.SC || !window.SC.Widget) {
      el.title.textContent = 'Unavailable';
      return;
    }

    needleDropped = true;
    needle = SC.Widget(el.source);

    needle.bind(SC.Widget.Events.READY, function () {
      sourceReady = true;
      needle.setVolume(DEFAULT_VOLUME);
      catalogRecords();
    });

    needle.bind(SC.Widget.Events.PLAY, function () {
      spinning = true;
      reflectSpin();
    });

    needle.bind(SC.Widget.Events.PAUSE, function () {
      spinning = false;
      reflectSpin();
    });

    needle.bind(SC.Widget.Events.FINISH, function () {
      spinning = false;
      reflectSpin();
    });

    /* Track change detection via progress events.
       Throttled: polls getCurrentSoundIndex at most once per second,
       and only when there are multiple records to track. */
    needle.bind(SC.Widget.Events.PLAY_PROGRESS, function () {
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
      spinning = false;
      reflectSpin();
      el.title.textContent = 'Unavailable';
      console.warn('[vinyl] SoundCloud widget encountered an error.');
    });

    /* Safety net: if READY never fires */
    setTimeout(function () {
      if (!sourceReady && el.title.textContent === 'Loading\u2026') {
        el.title.textContent = 'Unavailable';
      }
    }, SILENCE_MS);
  }

  /* ── Catalog records from the widget ─────────────────────── */

  function catalogRecords() {
    var cached = shelfRead();
    if (cached && cached.length) {
      records = cached;
      fillCrate();
      reflectTitle();
      return;
    }

    needle.getSounds(function (sounds) {
      if (!sounds || !sounds.length) {
        el.title.textContent = 'Empty playlist';
        return;
      }
      records = sounds.map(function (s, i) {
        return { title: s.title || 'Track ' + (i + 1), index: i };
      });
      shelfWrite(records);
      fillCrate();
      reflectTitle();
    });
  }

  /* ── Fill the crate (playlist dropdown) ──────────────────── */

  function fillCrate() {
    el.crate.innerHTML = '';
    records.forEach(function (rec) {
      var li = document.createElement('li');
      li.textContent = rec.title;
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
  }

  function reflectVolume() {
    glyph.loud.hidden   = hushed;
    glyph.hushed.hidden = !hushed;
    el.hush.setAttribute('aria-label', hushed ? 'Unmute' : 'Mute');
    el.hush.title = hushed ? 'Unmute' : 'Mute';
  }

  function reflectTitle() {
    if (records[currentSide]) el.title.textContent = records[currentSide].title;
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

  function toggleCrate(open) {
    var show = typeof open === 'boolean' ? open : el.crate.hidden;
    el.crate.hidden = !show;
    el.latch.setAttribute('aria-expanded', String(show));
    el.latch.setAttribute('aria-label', show ? 'Hide playlist' : 'Show playlist');
  }

  /* ── Event handlers ──────────────────────────────────────── */

  function onSpin() {
    if (!needle) return;
    spinning ? needle.pause() : safePlay();
  }

  function onHush() {
    if (!needle) return;
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
    if (!needle) return;
    var v = parseInt(el.dial.value, 10);
    needle.setVolume(v);
    hushed = v === 0;
    if (v > 0) savedVolume = v;
    reflectVolume();
  }

  /* ── Stage: raise / lower based on DND mode ────────────── */

  function raiseStage() {
    warmSource();
    if (!needleDropped) fetchSDK(dropNeedle);        // only bootstrap once
    el.stage.removeAttribute('aria-hidden');
    void el.stage.offsetHeight;                      // flush layout — gives browser the opacity:0 "from" frame
    el.stage.classList.add('vinyl--live');
  }

  function lowerStage() {
    el.stage.classList.remove('vinyl--live');
    el.stage.setAttribute('aria-hidden', 'true');
    if (needle && spinning) needle.pause();
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
