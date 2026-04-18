/*
  refined.js — Chancellor Edwards
  Shared appearance controller for palette, DND mode, motion preference,
  and ambient tab state. Re-mountable after SPA shell swaps.
*/

(function () {
  'use strict';

  var LEGACY_THEME_KEY = 'ce-theme';
  var PALETTE_KEY = 'ce-palette';
  var MODE_KEY = 'ce-mode';
  var MOTION_KEY = 'ce-motion';

  var PALETTES = ['calm', 'aqua', 'blush'];
  var PALETTE_LABELS = {
    calm: 'Calm',
    aqua: 'Aqua',
    blush: 'Blush',
    refined: 'DND'
  };
  var MOTION_STATES = ['auto', 'reduced', 'full'];
  var MOTION_LABELS = {
    auto: 'Auto',
    reduced: 'Reduced',
    full: 'Full'
  };

  var root = document.documentElement;
  var body = document.body;
  var idleTimer = null;
  var isBound = false;

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function normalizePalette(value) {
    return PALETTES.indexOf(value) !== -1 ? value : 'calm';
  }

  function normalizeMotion(value) {
    return MOTION_STATES.indexOf(value) !== -1 ? value : 'auto';
  }

  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function getSavedPalette() {
    var palette = safeGet(PALETTE_KEY);
    var legacyTheme = safeGet(LEGACY_THEME_KEY);

    if (!palette && legacyTheme && legacyTheme !== 'refined') {
      palette = legacyTheme;
    }

    return normalizePalette(palette || 'calm');
  }

  function isDndMode() {
    var explicit = safeGet(MODE_KEY);
    if (explicit) return explicit === 'dnd';

    return root.getAttribute('data-mode') === 'dnd' || safeGet(LEGACY_THEME_KEY) === 'refined';
  }

  function getMotionPreference() {
    return normalizeMotion(safeGet(MOTION_KEY) || 'auto');
  }

  function applyPalette(palette) {
    var nextPalette = normalizePalette(palette);

    safeSet(PALETTE_KEY, nextPalette);

    if (isDndMode()) {
      root.setAttribute('data-theme', 'refined');
    } else if (nextPalette === 'calm') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', nextPalette);
    }

    syncControls();
  }

  function cyclePalette() {
    var current = getSavedPalette();
    var index = PALETTES.indexOf(current);
    var next = PALETTES[(index + 1) % PALETTES.length];
    applyPalette(next);
  }

  function applyMode(isDnd) {
    if (isDnd) {
      root.setAttribute('data-mode', 'dnd');
      root.setAttribute('data-theme', 'refined');
      safeSet(MODE_KEY, 'dnd');
      safeSet(LEGACY_THEME_KEY, 'refined');
    } else {
      root.removeAttribute('data-mode');
      safeSet(MODE_KEY, 'default');
      safeSet(LEGACY_THEME_KEY, getSavedPalette());
      applyPalette(getSavedPalette());
      return;
    }

    syncControls();
  }

  function toggleDnd() {
    applyMode(!isDndMode());
  }

  function applyMotionPreference(value) {
    var next = normalizeMotion(value);

    if (next === 'auto') {
      root.removeAttribute('data-motion');
      safeRemove(MOTION_KEY);
    } else {
      root.setAttribute('data-motion', next);
      safeSet(MOTION_KEY, next);
    }

    syncControls();
  }

  function cycleMotionPreference() {
    var current = getMotionPreference();
    var index = MOTION_STATES.indexOf(current);
    applyMotionPreference(MOTION_STATES[(index + 1) % MOTION_STATES.length]);
  }

  function setPresenceState(state) {
    if (!body) body = document.body;
    if (!body) return;

    body.classList.remove('is-active', 'is-idle', 'is-background');
    body.classList.add(state);
    syncControls();
  }

  function kickIdleTimer() {
    if (document.hidden) {
      setPresenceState('is-background');
      return;
    }

    setPresenceState('is-active');

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!document.hidden) setPresenceState('is-idle');
    }, 45000);
  }

  function handleVisibility() {
    if (document.hidden) {
      if (idleTimer) clearTimeout(idleTimer);
      setPresenceState('is-background');
      return;
    }

    kickIdleTimer();
  }

  function syncControls() {
    var palette = getSavedPalette();
    var motion = getMotionPreference();
    var dnd = isDndMode();
    var effectiveMotion = motion === 'auto' && prefersReducedMotion() ? 'Reduced' : MOTION_LABELS[motion];
    var status = body && body.classList.contains('is-background')
      ? 'Background'
      : body && body.classList.contains('is-idle')
        ? 'Idle'
        : 'Active';

    var themeButton = document.getElementById('themeCycle');
    var themeValue = document.getElementById('themeCycleValue');
    var dndButton = document.getElementById('dndToggle');
    var dndValue = document.getElementById('dndToggleValue');
    var motionButton = document.getElementById('motionToggle');
    var motionValue = document.getElementById('motionToggleValue');
    var statusLabel = document.getElementById('appearanceStatusLabel');

    if (themeValue) themeValue.textContent = PALETTE_LABELS[palette] || 'Calm';
    if (dndValue) dndValue.textContent = dnd ? 'On' : 'Off';
    if (motionValue) motionValue.textContent = effectiveMotion;
    if (statusLabel) statusLabel.textContent = status;

    if (themeButton) {
      themeButton.setAttribute('aria-label', 'Change base color palette. Current palette: ' + (PALETTE_LABELS[palette] || 'Calm'));
    }

    if (dndButton) {
      dndButton.setAttribute('aria-pressed', dnd ? 'true' : 'false');
      dndButton.classList.toggle('nav-mode-btn-active', dnd);
      dndButton.setAttribute('aria-label', (dnd ? 'Disable' : 'Enable') + ' DND mode');
    }

    if (motionButton) {
      motionButton.classList.toggle('nav-mode-btn-active', motion !== 'auto');
      motionButton.setAttribute('aria-pressed', motion === 'auto' ? 'false' : 'true');
      motionButton.setAttribute('aria-label', 'Change motion preference. Current mode: ' + effectiveMotion);
    }
  }

  function bindEvents() {
    if (isBound) return;
    isBound = true;

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target) return;

      if (target.closest && target.closest('#themeCycle')) {
        cyclePalette();
        return;
      }

      if (target.closest && target.closest('#dndToggle')) {
        toggleDnd();
        return;
      }

      if (target.closest && target.closest('#motionToggle')) {
        cycleMotionPreference();
      }
    });

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', kickIdleTimer);
    window.addEventListener('blur', function () {
      if (!document.hidden) setPresenceState('is-idle');
    });

    ['pointerdown', 'pointermove', 'touchstart', 'scroll'].forEach(function (eventName) {
      window.addEventListener(eventName, kickIdleTimer, { passive: true });
    });
    window.addEventListener('keydown', kickIdleTimer);
  }

  function mount() {
    body = document.body;

    if (isDndMode()) {
      applyMode(true);
    } else {
      applyMode(false);
    }

    applyMotionPreference(getMotionPreference());

    if (!body || (!body.classList.contains('is-active') && !body.classList.contains('is-idle') && !body.classList.contains('is-background'))) {
      kickIdleTimer();
    } else {
      syncControls();
    }
  }

  bindEvents();

  window.CE_APPEARANCE = {
    mount: mount,
    applyPalette: applyPalette,
    applyMode: applyMode,
    setPresenceState: setPresenceState,
    isDndMode: isDndMode
  };

  mount();
})();
