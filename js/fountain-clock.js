/*
  fountain-clock.js — Chancellor Edwards
  Ambient time + weather layer for the Fountain Clock room.

  Design intent
  -------------
  A calm, always-on surface that weaves local time, sunrise/sunset, and
  current weather into one quiet presence. The UI, motion, and tone
  respond to time-of-day and weather *subtly* — never interrupting,
  never demanding attention.

  Architecture
  ------------
  - Single IIFE; exposes window.CE_AMBIENT with mount()/unmount() so the
    SPA shell (js/shell.js) can re-bind after DOM swaps.
  - If the page lacks [data-fountain-clock], the module stays inert.
  - Time: Intl.DateTimeFormat, tick re-aligned to each wall-clock minute
    (drift-free even across tab throttling and long background spells).
  - Sun: local NOAA-style solar calc (no extra network call).
  - Weather: Open-Meteo (keyless). sessionStorage cache, SWR:
      current (soft)  → 10 min      refetch in background
      forecast (hard) →  1 hour     escalate to "stale" presentation
  - In-flight fetches are coalesced; location changes abort stale work.
  - Rendering is surgical — the weather DOM is scaffolded once and its
    text/attrs updated in place so focus, a11y hints, and animation
    continuity survive every state transition.
  - Location defaults to Houston, TX. Browser geolocation is opt-in
    and reversible. No IP lookup. No PII persisted beyond this tab.
  - Failures degrade silently: last-known-good from cache, then default,
    then the clock alone — the core view never breaks.
  - Respects data-mode="dnd", data-motion, and prefers-reduced-motion.

  v1.1.0 — vectorized pass (2026-04-19):
    • drift-free ticking, in-flight coalesce, abort-on-location-change
    • surgical weather render (no more innerHTML churn)
    • 1-hour stale ceiling with dedicated ready/stale/error/loading states
    • jittered single retry on transient failure
    • accessible sun labels + aria-busy on weather + softer error copy
    • idempotent mount with proper teardown across SPA navigations
*/
(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  /* ── Constants ───────────────────────────────────────────── */

  var DEFAULT_LOCATION = {
    label: 'Houston, TX',
    lat: 29.7604,
    lon: -95.3698,
    source: 'default'
  };

  var CACHE_KEY_PREFIX = 'fc:weather:';
  var LOCATION_KEY     = 'fc:location';
  var SIMPLIFY_KEY     = 'fc:simplify';

  var CURRENT_TTL_MS   = 10 * 60 * 1000;   // 10 min — soft freshness window
  var FORECAST_TTL_MS  = 60 * 60 * 1000;   // 1 hour — hard staleness ceiling
  var FETCH_TIMEOUT_MS = 8000;
  var RETRY_MIN_MS     = 1200;
  var RETRY_MAX_MS     = 2600;

  var OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

  /* ── Weather code → human label + mood ───────────────────── */
  /* Maps WMO weather_code to { label, mood }. "mood" feeds CSS tints. */
  var WEATHER_CODES = {
    0:  { label: 'Clear',            mood: 'clear'  },
    1:  { label: 'Mostly clear',     mood: 'clear'  },
    2:  { label: 'Partly cloudy',    mood: 'partly' },
    3:  { label: 'Overcast',         mood: 'cloudy' },
    45: { label: 'Fog',              mood: 'cloudy' },
    48: { label: 'Icy fog',          mood: 'cloudy' },
    51: { label: 'Light drizzle',    mood: 'rain'   },
    53: { label: 'Drizzle',          mood: 'rain'   },
    55: { label: 'Heavy drizzle',    mood: 'rain'   },
    56: { label: 'Freezing drizzle', mood: 'rain'   },
    57: { label: 'Freezing drizzle', mood: 'rain'   },
    61: { label: 'Light rain',       mood: 'rain'   },
    63: { label: 'Rain',             mood: 'rain'   },
    65: { label: 'Heavy rain',       mood: 'rain'   },
    66: { label: 'Freezing rain',    mood: 'rain'   },
    67: { label: 'Freezing rain',    mood: 'rain'   },
    71: { label: 'Light snow',       mood: 'snow'   },
    73: { label: 'Snow',             mood: 'snow'   },
    75: { label: 'Heavy snow',       mood: 'snow'   },
    77: { label: 'Snow grains',      mood: 'snow'   },
    80: { label: 'Rain showers',     mood: 'rain'   },
    81: { label: 'Rain showers',     mood: 'rain'   },
    82: { label: 'Heavy showers',    mood: 'rain'   },
    85: { label: 'Snow showers',     mood: 'snow'  },
    86: { label: 'Snow showers',     mood: 'snow'  },
    95: { label: 'Thunderstorm',     mood: 'storm' },
    96: { label: 'Thunderstorm',     mood: 'storm' },
    99: { label: 'Thunderstorm',     mood: 'storm' }
  };

  /* ── Safe storage wrappers ───────────────────────────────── */

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) {}
  }
  function safeRemove(storage, key) {
    try { storage.removeItem(key); } catch (e) {}
  }

  /* ── Location state (session-scoped) ─────────────────────── */

  function readStoredLocation() {
    var raw = safeGet(sessionStorage, LOCATION_KEY);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.lat === 'number' &&
          typeof parsed.lon === 'number' &&
          isFinite(parsed.lat) && isFinite(parsed.lon)) {
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  function writeStoredLocation(loc) {
    safeSet(sessionStorage, LOCATION_KEY, JSON.stringify(loc));
  }

  function clearStoredLocation() {
    safeRemove(sessionStorage, LOCATION_KEY);
  }

  /* ── Cache (session-scoped, SWR) ─────────────────────────── */

  function cacheKey(lat, lon) {
    /* Round to ~1 km grid so slight wobble doesn't spawn new entries. */
    return CACHE_KEY_PREFIX + lat.toFixed(2) + ':' + lon.toFixed(2);
  }

  function readCache(lat, lon) {
    var raw = safeGet(sessionStorage, cacheKey(lat, lon));
    if (!raw) return null;
    try {
      var entry = JSON.parse(raw);
      if (entry && typeof entry.ts === 'number' && entry.data) return entry;
    } catch (e) {}
    return null;
  }

  function writeCache(lat, lon, data) {
    var entry = { ts: Date.now(), data: data };
    safeSet(sessionStorage, cacheKey(lat, lon), JSON.stringify(entry));
  }

  /* ── Solar calculation (NOAA approximation) ──────────────── */
  /* Returns { sunrise: Date|null, sunset: Date|null, dayFraction, isDay } */

  function solarTimes(lat, lon, date) {
    var d = date || new Date();
    var rad = Math.PI / 180;

    /* Julian day */
    var year  = d.getUTCFullYear();
    var month = d.getUTCMonth() + 1;
    var day   = d.getUTCDate();

    var a = Math.floor((14 - month) / 12);
    var y = year + 4800 - a;
    var m = month + 12 * a - 3;
    var jd = day + Math.floor((153 * m + 2) / 5) + 365 * y +
             Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) -
             32045;

    var n = jd - 2451545.0 + 0.0008;
    var Jstar = n - lon / 360;

    var M = (357.5291 + 0.98560028 * Jstar) % 360;
    var C = 1.9148 * Math.sin(M * rad) +
            0.0200 * Math.sin(2 * M * rad) +
            0.0003 * Math.sin(3 * M * rad);
    var lambda = (M + C + 180 + 102.9372) % 360;
    var Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(M * rad)
                              - 0.0069 * Math.sin(2 * lambda * rad);

    var sinDelta = Math.sin(lambda * rad) * Math.sin(23.44 * rad);
    var delta    = Math.asin(sinDelta) / rad;

    var cosH = (Math.sin(-0.83 * rad) - Math.sin(lat * rad) * sinDelta) /
               (Math.cos(lat * rad) * Math.cos(delta * rad));

    /* Polar day / polar night — clamp gracefully. */
    if (cosH > 1)  return { sunrise: null, sunset: null, dayFraction: 0,   isDay: false };
    if (cosH < -1) return { sunrise: null, sunset: null, dayFraction: 0.5, isDay: true  };

    var H = Math.acos(cosH) / rad;
    var Jrise = Jtransit - H / 360;
    var Jset  = Jtransit + H / 360;

    var JD_UNIX = 2440587.5;
    var riseMs = (Jrise - JD_UNIX) * 86400000;
    var setMs  = (Jset  - JD_UNIX) * 86400000;

    var sunrise = new Date(riseMs);
    var sunset  = new Date(setMs);

    var nowMs = d.getTime();
    var dayLen = setMs - riseMs;
    var frac, isDay = false;

    if (nowMs <= riseMs) {
      frac = 0;
    } else if (nowMs >= setMs) {
      frac = 1;
    } else {
      frac = dayLen > 0 ? (nowMs - riseMs) / dayLen : 0.5;
      isDay = true;
    }

    return { sunrise: sunrise, sunset: sunset, dayFraction: frac, isDay: isDay };
  }

  /* ── Phase classifier — 45-min shoulder around sunrise/sunset ─ */

  function classifyPhase(solar, now) {
    if (!solar.sunrise || !solar.sunset) {
      return solar.isDay ? 'day' : 'night';
    }
    var n = now.getTime();
    var r = solar.sunrise.getTime();
    var s = solar.sunset.getTime();
    var w = 45 * 60 * 1000;

    if (Math.abs(n - r) < w) return 'dawn';
    if (Math.abs(n - s) < w) return 'dusk';
    return solar.isDay ? 'day' : 'night';
  }

  /* ── Formatters (cached) ─────────────────────────────────── */

  var hmFormatters = {};
  function formatHM(date, tz) {
    var key = tz || 'local';
    if (!hmFormatters[key]) {
      var opts = { hour: 'numeric', minute: '2-digit', hour12: true };
      if (tz) opts.timeZone = tz;
      try {
        hmFormatters[key] = new Intl.DateTimeFormat(undefined, opts);
      } catch (e) {
        hmFormatters[key] = new Intl.DateTimeFormat(undefined, {
          hour: 'numeric', minute: '2-digit', hour12: true
        });
      }
    }
    return hmFormatters[key].format(date);
  }

  var dateFormatter = null;
  function formatDate(date) {
    if (!dateFormatter) {
      dateFormatter = new Intl.DateTimeFormat(undefined, {
        weekday: 'long', month: 'long', day: 'numeric'
      });
    }
    return dateFormatter.format(date);
  }

  var zoneFormatter = null;
  function formatZoneLabel() {
    try {
      if (!zoneFormatter) {
        zoneFormatter = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
      }
      var parts = zoneFormatter.formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value;
      }
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  }

  function roundTemp(t) {
    if (t === null || t === undefined || isNaN(t)) return '—';
    return Math.round(t) + '°';
  }

  /* ── Fetch with timeout & external abort ─────────────────── */

  function fetchWithTimeout(url, ms, externalController) {
    var controller = externalController ||
                     (typeof AbortController === 'function' ? new AbortController() : null);
    if (!controller) return fetch(url); /* ancient browsers: graceful */

    var timedOut = false;
    var t = setTimeout(function () {
      timedOut = true;
      try { controller.abort(); } catch (e) {}
    }, ms);

    return fetch(url, { signal: controller.signal })
      .then(function (r) { clearTimeout(t); return r; })
      .catch(function (err) {
        clearTimeout(t);
        if (timedOut) {
          var timeoutErr = new Error('timeout');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        }
        throw err;
      });
  }

  /* ── Open-Meteo call + normalizer ────────────────────────── */

  function fetchWeather(lat, lon, controller) {
    var url = OPEN_METEO_URL +
      '?latitude='  + lat.toFixed(4) +
      '&longitude=' + lon.toFixed(4) +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m' +
      '&hourly=temperature_2m,weather_code,is_day' +
      '&temperature_unit=fahrenheit' +
      '&wind_speed_unit=mph' +
      '&forecast_days=1' +
      '&timezone=auto';

    return fetchWithTimeout(url, FETCH_TIMEOUT_MS, controller)
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('weather http ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then(normalizeWeather);
  }

  function normalizeWeather(raw) {
    if (!raw || !raw.current) throw new Error('weather shape invalid');
    var cur = raw.current;
    var hourly = raw.hourly || {};
    var times = hourly.time || [];
    var temps = hourly.temperature_2m || [];
    var codes = hourly.weather_code || [];
    var days  = hourly.is_day || [];

    /* Find first hourly slot strictly after "now". */
    var nowMs = Date.now();
    var startIdx = 0;
    for (var i = 0; i < times.length; i++) {
      if (new Date(times[i]).getTime() > nowMs) { startIdx = i; break; }
    }

    var forecast = [];
    for (var j = 0; j < 3; j++) {
      var idx = startIdx + j * 2;
      if (idx >= times.length) break;
      forecast.push({
        time: new Date(times[idx]),
        temp: temps[idx],
        code: codes[idx],
        isDay: days[idx] === 1
      });
    }

    return {
      current: {
        temp: cur.temperature_2m,
        feels: cur.apparent_temperature,
        code: cur.weather_code,
        isDay: cur.is_day === 1,
        wind: cur.wind_speed_10m
      },
      forecast: forecast,
      timezone: raw.timezone || null,
      fetchedAt: Date.now()
    };
  }

  function weatherInfo(code) {
    return WEATHER_CODES[code] || { label: '—', mood: 'clear' };
  }

  /* ── One-shot jittered retry on transient errors ─────────── */

  function isTransient(err) {
    if (!err) return false;
    if (err.name === 'TimeoutError') return true;
    if (err.name === 'AbortError')   return false;
    if (typeof err.status === 'number' && err.status >= 500) return true;
    /* Network errors surface as TypeError in fetch. */
    if (err.name === 'TypeError') return true;
    return false;
  }

  function fetchWeatherResilient(lat, lon, controller) {
    return fetchWeather(lat, lon, controller).catch(function (err) {
      if (!isTransient(err)) throw err;
      if (controller && controller.signal && controller.signal.aborted) throw err;
      var delay = RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS));
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (controller && controller.signal && controller.signal.aborted) {
            var abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
            return;
          }
          fetchWeather(lat, lon, controller).then(resolve, reject);
        }, delay);
      });
    });
  }

  /* ── Weather SVG glyphs (compact, stroke-based) ──────────── */

  function iconSvg(mood, isDay) {
    var cls = 'fc-glyph';
    switch (mood) {
      case 'clear':
        return isDay
          ? '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><g stroke-linecap="round"><line x1="12" y1="2"  x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2"  y1="12" x2="5"  y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5"  x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5"  x2="19.5" y2="4.5"/></g></svg>'
          : '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a8 8 0 0 1-11-11 8 8 0 1 0 11 11z"/></svg>';
      case 'partly':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="10" r="3"/><path d="M11 19h7a4 4 0 0 0 .5-7.97A5 5 0 0 0 9 12.5"/></svg>';
      case 'cloudy':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 19h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 10.5 4 4 0 0 0 7 19z"/></svg>';
      case 'rain':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 6.5 4 4 0 0 0 7 15z"/><g stroke-linecap="round"><line x1="9"  y1="18" x2="8"  y2="21"/><line x1="13" y1="18" x2="12" y2="21"/><line x1="17" y1="18" x2="16" y2="21"/></g></svg>';
      case 'snow':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 6.5 4 4 0 0 0 7 15z"/><g stroke-linecap="round"><circle cx="9"  cy="19.5" r="0.6"/><circle cx="13" cy="20"   r="0.6"/><circle cx="17" cy="19.5" r="0.6"/></g></svg>';
      case 'storm':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 5.5 4 4 0 0 0 7 14z"/><polyline points="12,15 10,19 13,19 11,22" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      default:
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>';
    }
  }

  /* ── Module state ────────────────────────────────────────── */

  var state = {
    mounted: false,
    tickTimer: null,
    refetchTimer: null,
    location: DEFAULT_LOCATION,
    weather: null,
    weatherError: null,
    simplified: false,
    pendingFetch: null,
    pendingController: null,
    pendingKey: null
  };

  /* ── DOM helpers ─────────────────────────────────────────── */

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) {
    return Array.prototype.slice.call(
      (root || document).querySelectorAll(sel)
    );
  }

  function rootEl() { return document.querySelector('[data-fountain-clock]'); }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setAttr(el, name, value) {
    if (!el) return;
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  /* ── Render: time, date, zone, sun rail, phase ───────────── */

  function renderClock() {
    var root = rootEl();
    if (!root) return;

    var now = new Date();

    setText(qs('[data-fc-time-hm]', root), formatHM(now));

    var timeEl = qs('[data-fc-time]', root);
    if (timeEl) setAttr(timeEl, 'datetime', now.toISOString());

    setText(qs('[data-fc-date]', root), formatDate(now));
    setText(qs('[data-fc-zone]', root), formatZoneLabel());

    var solar = solarTimes(state.location.lat, state.location.lon, now);
    var phase = classifyPhase(solar, now);

    setText(qs('[data-fc-phase]', root), phaseLabel(phase));

    if (solar.sunrise) {
      setText(qs('[data-fc-sunrise]', root), formatHM(solar.sunrise));
      setText(qs('[data-fc-sunset]',  root), formatHM(solar.sunset));
    } else {
      setText(qs('[data-fc-sunrise]', root), '—');
      setText(qs('[data-fc-sunset]',  root), '—');
    }

    var pct = Math.max(0, Math.min(1, solar.dayFraction));
    root.style.setProperty('--fc-sun-x', (pct * 100).toFixed(2) + '%');

    applyPhaseAttribute(phase, solar);
  }

  function phaseLabel(phase) {
    if (phase === 'dawn')  return 'Dawn';
    if (phase === 'dusk')  return 'Dusk';
    if (phase === 'night') return 'Night';
    return 'Day';
  }

  function applyPhaseAttribute(phase, solar) {
    var html = document.documentElement;

    if (state.simplified) {
      html.removeAttribute('data-phase');
      html.style.removeProperty('--ambient-warmth');
      html.style.removeProperty('--ambient-light');
      return;
    }

    setAttr(html, 'data-phase', phase);

    var warmth;
    switch (phase) {
      case 'dawn':  warmth = 0.85; break;
      case 'dusk':  warmth = 0.90; break;
      case 'night': warmth = 0.05; break;
      default:      warmth = 0.30;
    }

    var light = 0.15;
    if (solar.isDay) {
      var x = Math.max(0, Math.min(1, solar.dayFraction));
      light = Math.max(0.35, 1 - Math.abs(x - 0.5) * 2);
    }

    html.style.setProperty('--ambient-warmth', warmth.toFixed(3));
    html.style.setProperty('--ambient-light',  light.toFixed(3));
  }

  /* ── Render: weather (surgical) ──────────────────────────── */

  var WEATHER_COPY = {
    loading: {
      cond: 'Listening for weather…',
      feels: ''
    },
    error: {
      cond: 'Weather is quiet right now',
      feels: 'Your clock keeps time just the same.'
    }
  };

  function ensureWeatherScaffold(surface) {
    if (surface.__fcScaffolded) return;
    surface.__fcScaffolded = true;
    surface.innerHTML =
      '<div class="fc-weather-now">' +
        '<div class="fc-weather-glyph" data-fc-weather-icon aria-hidden="true"></div>' +
        '<div class="fc-weather-temp" data-fc-weather-temp>—</div>' +
        '<div class="fc-weather-meta">' +
          '<div class="fc-weather-cond" data-fc-weather-cond></div>' +
          '<div class="fc-weather-feels" data-fc-weather-feels></div>' +
        '</div>' +
      '</div>' +
      '<ol class="fc-forecast" data-fc-forecast>' +
        '<li class="fc-forecast-slot" data-fc-forecast-slot>' +
          '<span class="fc-forecast-time" data-fc-forecast-time></span>' +
          '<span class="fc-forecast-glyph" data-fc-forecast-glyph aria-hidden="true"></span>' +
          '<span class="fc-forecast-temp" data-fc-forecast-temp></span>' +
        '</li>' +
        '<li class="fc-forecast-slot" data-fc-forecast-slot>' +
          '<span class="fc-forecast-time" data-fc-forecast-time></span>' +
          '<span class="fc-forecast-glyph" data-fc-forecast-glyph aria-hidden="true"></span>' +
          '<span class="fc-forecast-temp" data-fc-forecast-temp></span>' +
        '</li>' +
        '<li class="fc-forecast-slot" data-fc-forecast-slot>' +
          '<span class="fc-forecast-time" data-fc-forecast-time></span>' +
          '<span class="fc-forecast-glyph" data-fc-forecast-glyph aria-hidden="true"></span>' +
          '<span class="fc-forecast-temp" data-fc-forecast-temp></span>' +
        '</li>' +
      '</ol>';
  }

  function setGlyph(el, mood, isDay) {
    if (!el) return;
    var key = mood + ':' + (isDay ? 'd' : 'n');
    if (el.__fcGlyph === key) return;
    el.__fcGlyph = key;
    el.innerHTML = iconSvg(mood, isDay);
  }

  function clearGlyph(el) {
    if (!el || el.__fcGlyph === null) return;
    el.__fcGlyph = null;
    el.innerHTML = '';
  }

  function weatherIsStale() {
    return !!(state.weather && state.weather.fetchedAt &&
              (Date.now() - state.weather.fetchedAt) > FORECAST_TTL_MS);
  }

  function weatherStateName() {
    if (state.weather) return weatherIsStale() ? 'stale' : 'ready';
    if (state.weatherError) return 'error';
    return 'loading';
  }

  function renderWeather() {
    var root = rootEl();
    if (!root) return;

    var surface = qs('[data-fc-weather]', root);
    if (!surface) return;

    ensureWeatherScaffold(surface);

    var phase = weatherStateName();
    setAttr(surface, 'data-fc-state', phase);
    setAttr(surface, 'aria-busy', phase === 'loading' ? 'true' : 'false');

    var iconEl  = qs('[data-fc-weather-icon]',  surface);
    var tempEl  = qs('[data-fc-weather-temp]',  surface);
    var condEl  = qs('[data-fc-weather-cond]',  surface);
    var feelsEl = qs('[data-fc-weather-feels]', surface);
    var slots   = qsa('[data-fc-forecast-slot]', surface);

    if (!state.weather) {
      var copy = state.weatherError ? WEATHER_COPY.error : WEATHER_COPY.loading;
      clearGlyph(iconEl);
      setText(tempEl,  '—');
      setText(condEl,  copy.cond);
      setText(feelsEl, copy.feels);

      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        s.hidden = false;
        setText(qs('[data-fc-forecast-time]', s), '');
        setText(qs('[data-fc-forecast-temp]', s), '');
        clearGlyph(qs('[data-fc-forecast-glyph]', s));
      }

      /* When we have no weather, suppress mood tint to stay calm. */
      if (document.documentElement.hasAttribute('data-weather')) {
        document.documentElement.removeAttribute('data-weather');
      }
      return;
    }

    var w = state.weather.current;
    var info = weatherInfo(w.code);

    setGlyph(iconEl, info.mood, w.isDay);
    setText(tempEl,  roundTemp(w.temp));
    setText(condEl,  info.label);
    setText(feelsEl, 'Feels ' + roundTemp(w.feels));

    for (var k = 0; k < slots.length; k++) {
      var slotEl = slots[k];
      var data   = state.weather.forecast[k];
      if (!data) {
        slotEl.hidden = true;
        continue;
      }
      slotEl.hidden = false;
      setText(qs('[data-fc-forecast-time]', slotEl), formatHM(data.time));
      setText(qs('[data-fc-forecast-temp]', slotEl), roundTemp(data.temp));
      setGlyph(qs('[data-fc-forecast-glyph]', slotEl),
               weatherInfo(data.code).mood, data.isDay);
    }

    if (state.simplified) {
      document.documentElement.removeAttribute('data-weather');
    } else {
      setAttr(document.documentElement, 'data-weather', info.mood);
    }
  }

  /* ── Render: status row (location, asof, controls, note) ─── */

  function renderStatus() {
    var root = rootEl();
    if (!root) return;

    var locEl = qs('[data-fc-location]', root);
    if (locEl) {
      var prefix = state.location.source === 'geo' ? 'Your location · ' : '';
      setText(locEl, prefix + state.location.label);
    }

    var asOf = qs('[data-fc-asof]', root);
    if (asOf) {
      if (state.weather && state.weather.fetchedAt) {
        asOf.hidden = false;
        var prefixAs = weatherIsStale() ? 'Last seen ' : 'As of ';
        setText(asOf, prefixAs + formatHM(new Date(state.weather.fetchedAt)));
      } else {
        asOf.hidden = true;
      }
    }

    var locateBtn  = qs('[data-fc-locate]',   root);
    var resetBtn   = qs('[data-fc-reset]',    root);
    var simplifyBtn = qs('[data-fc-simplify]', root);

    if (locateBtn) locateBtn.hidden = state.location.source === 'geo';
    if (resetBtn)  resetBtn.hidden  = state.location.source !== 'geo';

    if (simplifyBtn) {
      setAttr(simplifyBtn, 'aria-pressed', state.simplified ? 'true' : 'false');
      setText(simplifyBtn, state.simplified ? 'Restore ambient' : 'Simplify');
    }
  }

  /* ── Weather load orchestration (SWR + coalesce + abort) ─── */

  function loadWeather(force) {
    if (!state.mounted) return;

    var loc = state.location;
    var key = cacheKey(loc.lat, loc.lon);

    /* 1. Paint from any cache immediately so return visits don't flash. */
    var cached = readCache(loc.lat, loc.lon);
    if (cached) {
      state.weather = cached.data;
      state.weatherError = null;
      renderWeather();
      renderStatus();
    }

    var age = cached ? (Date.now() - cached.ts) : Infinity;
    var needsRefresh = force || !cached || age > CURRENT_TTL_MS;
    if (!needsRefresh) return;

    /* 2. Coalesce concurrent calls for the same location. */
    if (state.pendingFetch && state.pendingKey === key) {
      return state.pendingFetch;
    }

    /* 3. Abort any in-flight fetch for a different location. */
    abortPendingFetch();

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.pendingController = controller;
    state.pendingKey = key;

    var promise = fetchWeatherResilient(loc.lat, loc.lon, controller)
      .then(function (data) {
        if (state.pendingKey !== key) return;    /* location changed */
        state.weather = data;
        state.weatherError = null;
        writeCache(loc.lat, loc.lon, data);
        renderWeather();
        renderStatus();
      })
      .catch(function (err) {
        if (state.pendingKey !== key) return;
        if (err && err.name === 'AbortError') return;
        /* Keep last-known-good on failure; only surface error if empty. */
        if (!state.weather) {
          state.weatherError = err;
          renderWeather();
          renderStatus();
        }
      })
      .then(function () {
        if (state.pendingKey === key) {
          state.pendingFetch = null;
          state.pendingController = null;
          state.pendingKey = null;
        }
      });

    state.pendingFetch = promise;
    return promise;
  }

  function abortPendingFetch() {
    if (state.pendingController) {
      try { state.pendingController.abort(); } catch (e) {}
    }
    state.pendingFetch = null;
    state.pendingController = null;
    state.pendingKey = null;
  }

  /* ── Geolocation (opt-in, reversible) ─────────────────────── */

  function setNote(msg) {
    var root = rootEl();
    var note = root && qs('[data-fc-note]', root);
    if (note) setText(note, msg);
  }

  function requestGeolocation() {
    if (!('geolocation' in navigator)) {
      setNote('This browser does not share location.');
      return;
    }

    setNote('Asking for your location…');

    navigator.geolocation.getCurrentPosition(function (pos) {
      var loc = {
        label: 'Near you',
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        source: 'geo'
      };
      state.location = loc;
      writeStoredLocation(loc);
      setNote('');
      /* Abort any in-flight fetch for the previous location. */
      abortPendingFetch();
      loadWeather(true);
      renderClock();
      renderStatus();
    }, function (err) {
      if (err && err.code === 1) {
        setNote('No worries — staying on Houston, TX.');
      } else {
        setNote('Couldn\u2019t reach your location. Staying on Houston, TX.');
      }
    }, {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 10 * 60 * 1000
    });
  }

  function resetLocation() {
    state.location = DEFAULT_LOCATION;
    clearStoredLocation();
    abortPendingFetch();
    loadWeather(true);
    renderClock();
    renderStatus();
    setNote('Reset. Showing Houston, TX.');
  }

  /* ── Simplify toggle ─────────────────────────────────────── */

  function setSimplified(next) {
    state.simplified = !!next;
    if (state.simplified) {
      safeSet(sessionStorage, SIMPLIFY_KEY, '1');
      document.documentElement.setAttribute('data-ambient', 'simplified');
      document.documentElement.removeAttribute('data-phase');
      document.documentElement.removeAttribute('data-weather');
    } else {
      safeRemove(sessionStorage, SIMPLIFY_KEY);
      document.documentElement.removeAttribute('data-ambient');
    }

    /* Surgical re-render — no DOM replacement, no layout shift. */
    renderClock();
    renderWeather();
    renderStatus();
  }

  /* ── Tick scheduler (drift-free) ─────────────────────────── */

  function scheduleTick() {
    clearTimeout(state.tickTimer);

    function align() {
      var now = new Date();
      var ms = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
      return Math.max(250, ms);
    }

    function tick() {
      renderClock();
      /* Re-align on every beat so the clock never drifts across tab
         throttling, sleep, or long-background periods. */
      state.tickTimer = setTimeout(tick, align());
    }

    state.tickTimer = setTimeout(tick, align());
  }

  function scheduleRefetch() {
    clearInterval(state.refetchTimer);
    state.refetchTimer = setInterval(function () {
      if (document.hidden) return;          /* polite in background */
      if (!state.mounted) return;
      loadWeather(false);
    }, CURRENT_TTL_MS);
  }

  /* ── Event binding ───────────────────────────────────────── */

  function bindControls() {
    var root = rootEl();
    if (!root || root.__fcBound) return;
    root.__fcBound = true;

    root.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-fc-locate]'))   { requestGeolocation();              return; }
      if (t.closest('[data-fc-reset]'))    { resetLocation();                   return; }
      if (t.closest('[data-fc-simplify]')) { setSimplified(!state.simplified);  return; }
      if (t.closest('[data-fc-refresh]'))  { loadWeather(true);                 return; }
    });
  }

  /* Visibility handler is bound once — it no-ops when unmounted. */
  function handleVisibility() {
    if (document.hidden) return;
    if (!state.mounted) return;
    /* Returning to the tab: resync the clock face *now* and give the
       weather a quiet chance to refresh if it is stale. */
    renderClock();
    loadWeather(false);
  }

  /* ── Lifecycle ───────────────────────────────────────────── */

  function mount() {
    var root = rootEl();
    if (!root) {
      /* Page doesn't expose the ambient surface — go inert. */
      teardownTimers();
      abortPendingFetch();
      document.documentElement.removeAttribute('data-phase');
      document.documentElement.removeAttribute('data-weather');
      state.mounted = false;
      return;
    }

    /* Restore session preferences — safe to re-run on SPA navigations. */
    var stored = readStoredLocation();
    state.location   = stored || DEFAULT_LOCATION;
    state.simplified = safeGet(sessionStorage, SIMPLIFY_KEY) === '1';

    if (state.simplified) {
      document.documentElement.setAttribute('data-ambient', 'simplified');
    } else {
      document.documentElement.removeAttribute('data-ambient');
    }

    state.mounted = true;

    /* First-paint order matters: paint the clock before loading weather
       so the sanctuary is legible even if the network is slow. */
    renderClock();
    renderWeather();
    renderStatus();
    bindControls();

    loadWeather(false);
    scheduleTick();
    scheduleRefetch();
  }

  function teardownTimers() {
    if (state.tickTimer)    { clearTimeout(state.tickTimer);    state.tickTimer = null; }
    if (state.refetchTimer) { clearInterval(state.refetchTimer); state.refetchTimer = null; }
  }

  function unmount() {
    state.mounted = false;
    teardownTimers();
    abortPendingFetch();
    document.documentElement.removeAttribute('data-phase');
    document.documentElement.removeAttribute('data-weather');
  }

  /* ── Global bindings (once) ──────────────────────────────── */

  document.addEventListener('visibilitychange', handleVisibility);

  /* ── Expose public API ───────────────────────────────────── */

  window.CE_AMBIENT = {
    mount: mount,
    unmount: unmount,
    refresh: function () { loadWeather(true); },
    requestGeolocation: requestGeolocation,
    resetLocation: resetLocation,
    setSimplified: setSimplified,
    getState: function () {
      return {
        location: state.location,
        simplified: state.simplified,
        hasWeather: !!state.weather,
        weatherStage: weatherStateName(),
        fetchedAt: state.weather && state.weather.fetchedAt || null
      };
    }
  };

  /* Auto-mount on first load; shell.js re-calls mount() after SPA nav. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
