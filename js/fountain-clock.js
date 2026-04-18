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
  - Time: Intl.DateTimeFormat, tick once per minute.
  - Sun: local NOAA-style solar calc (no extra network call).
  - Weather: Open-Meteo (keyless). sessionStorage cache, SWR:
      current   → 10 min
      forecast  →  1 hour
  - Location: defaults to Houston, TX. Browser geolocation is opt-in
    and reversible. No IP lookup. No PII persisted beyond this tab.
  - Failures degrade silently: last-known-good from cache, then default,
    then the clock alone — the core view never breaks.
  - Respects data-mode="dnd", data-motion, and prefers-reduced-motion.

  v1.0.0
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

  var CURRENT_TTL_MS   = 10 * 60 * 1000;   // 10 minutes — fresh enough
  var FORECAST_TTL_MS  = 60 * 60 * 1000;   // 1 hour — SWR ceiling

  var OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

  /* ── Weather code → human label + phase tint ─────────────── */
  /* Maps WMO weather_code to { label, mood }. "mood" feeds CSS vars. */
  var WEATHER_CODES = {
    0:  { label: 'Clear',           mood: 'clear'   },
    1:  { label: 'Mostly clear',    mood: 'clear'   },
    2:  { label: 'Partly cloudy',   mood: 'partly'  },
    3:  { label: 'Overcast',        mood: 'cloudy'  },
    45: { label: 'Fog',             mood: 'cloudy'  },
    48: { label: 'Icy fog',         mood: 'cloudy'  },
    51: { label: 'Light drizzle',   mood: 'rain'    },
    53: { label: 'Drizzle',         mood: 'rain'    },
    55: { label: 'Heavy drizzle',   mood: 'rain'    },
    56: { label: 'Freezing drizzle',mood: 'rain'    },
    57: { label: 'Freezing drizzle',mood: 'rain'    },
    61: { label: 'Light rain',      mood: 'rain'    },
    63: { label: 'Rain',            mood: 'rain'    },
    65: { label: 'Heavy rain',      mood: 'rain'    },
    66: { label: 'Freezing rain',   mood: 'rain'    },
    67: { label: 'Freezing rain',   mood: 'rain'    },
    71: { label: 'Light snow',      mood: 'snow'    },
    73: { label: 'Snow',            mood: 'snow'    },
    75: { label: 'Heavy snow',      mood: 'snow'    },
    77: { label: 'Snow grains',     mood: 'snow'    },
    80: { label: 'Rain showers',    mood: 'rain'    },
    81: { label: 'Rain showers',    mood: 'rain'    },
    82: { label: 'Heavy showers',   mood: 'rain'    },
    85: { label: 'Snow showers',    mood: 'snow'    },
    86: { label: 'Snow showers',    mood: 'snow'    },
    95: { label: 'Thunderstorm',    mood: 'storm'   },
    96: { label: 'Thunderstorm',    mood: 'storm'   },
    99: { label: 'Thunderstorm',    mood: 'storm'   }
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
      if (typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  function writeStoredLocation(loc) {
    try { sessionStorage.setItem(LOCATION_KEY, JSON.stringify(loc)); }
    catch (e) {}
  }

  function clearStoredLocation() {
    safeRemove(sessionStorage, LOCATION_KEY);
  }

  /* ── Cache (session-scoped, SWR) ─────────────────────────── */

  function cacheKey(lat, lon) {
    /* Round to ~1km grid for cache locality without over-sharing. */
    return CACHE_KEY_PREFIX + lat.toFixed(2) + ':' + lon.toFixed(2);
  }

  function readCache(lat, lon) {
    var raw = safeGet(sessionStorage, cacheKey(lat, lon));
    if (!raw) return null;
    try {
      var entry = JSON.parse(raw);
      if (entry && entry.ts && entry.data) return entry;
    } catch (e) {}
    return null;
  }

  function writeCache(lat, lon, data) {
    var entry = { ts: Date.now(), data: data };
    safeSet(sessionStorage, cacheKey(lat, lon), JSON.stringify(entry));
  }

  /* ── Solar calculation (NOAA approximation) ──────────────── */
  /* Returns { sunrise: Date, sunset: Date, dayFraction: 0..1, isDay } */

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

    /* Polar day / polar night */
    if (cosH > 1) {
      return { sunrise: null, sunset: null, dayFraction: 0, isDay: false };
    }
    if (cosH < -1) {
      return { sunrise: null, sunset: null, dayFraction: 0.5, isDay: true };
    }

    var H = Math.acos(cosH) / rad;
    var Jrise = Jtransit - H / 360;
    var Jset  = Jtransit + H / 360;

    /* Convert Julian date → ms since epoch */
    var JD_UNIX = 2440587.5;
    var riseMs = (Jrise - JD_UNIX) * 86400000;
    var setMs  = (Jset  - JD_UNIX) * 86400000;

    var sunrise = new Date(riseMs);
    var sunset  = new Date(setMs);

    var nowMs = d.getTime();
    var dayLen = setMs - riseMs;
    var frac;
    var isDay = false;

    if (nowMs <= riseMs) {
      /* pre-dawn */
      frac = 0;
    } else if (nowMs >= setMs) {
      /* post-sunset */
      frac = 1;
    } else {
      frac = (nowMs - riseMs) / dayLen;
      isDay = true;
    }

    return {
      sunrise: sunrise,
      sunset: sunset,
      dayFraction: frac,
      isDay: isDay
    };
  }

  /* ── Phase classifier ────────────────────────────────────── */
  /* dawn: 45min window around sunrise; dusk: 45min around sunset. */

  function classifyPhase(solar, now) {
    if (!solar.sunrise || !solar.sunset) {
      return solar.isDay ? 'day' : 'night';
    }
    var n = now.getTime();
    var r = solar.sunrise.getTime();
    var s = solar.sunset.getTime();
    var window = 45 * 60 * 1000;

    if (Math.abs(n - r) < window) return 'dawn';
    if (Math.abs(n - s) < window) return 'dusk';
    if (solar.isDay) return 'day';
    return 'night';
  }

  /* ── Number formatting ───────────────────────────────────── */

  var timeFmtCache = {};
  function formatHM(date, tz) {
    var key = tz || 'local';
    if (!timeFmtCache[key]) {
      try {
        timeFmtCache[key] = new Intl.DateTimeFormat(undefined, {
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: tz || undefined
        });
      } catch (e) {
        timeFmtCache[key] = new Intl.DateTimeFormat(undefined, {
          hour: 'numeric', minute: '2-digit', hour12: true
        });
      }
    }
    return timeFmtCache[key].format(date);
  }

  var dateFmtCache = null;
  function formatDate(date) {
    if (!dateFmtCache) {
      dateFmtCache = new Intl.DateTimeFormat(undefined, {
        weekday: 'long', month: 'long', day: 'numeric'
      });
    }
    return dateFmtCache.format(date);
  }

  function formatZoneLabel() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      /* Short abbreviation, e.g. "CST" */
      var parts = new Intl.DateTimeFormat(undefined, {
        timeZoneName: 'short'
      }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value;
      }
      return tz;
    } catch (e) {
      return '';
    }
  }

  function roundTemp(t) {
    if (t === null || t === undefined || isNaN(t)) return '—';
    return Math.round(t) + '°';
  }

  /* ── Fetch with timeout ──────────────────────────────────── */

  function fetchWithTimeout(url, ms) {
    if (typeof AbortController === 'function') {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, ms);
      return fetch(url, { signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); return r; })
        .catch(function (err) { clearTimeout(t); throw err; });
    }
    return fetch(url);
  }

  /* ── Open-Meteo call ─────────────────────────────────────── */

  function fetchWeather(lat, lon) {
    var url = OPEN_METEO_URL +
      '?latitude=' + lat.toFixed(4) +
      '&longitude=' + lon.toFixed(4) +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m' +
      '&hourly=temperature_2m,weather_code,is_day' +
      '&temperature_unit=fahrenheit' +
      '&wind_speed_unit=mph' +
      '&forecast_days=1' +
      '&timezone=auto';

    return fetchWithTimeout(url, 8000)
      .then(function (res) {
        if (!res.ok) throw new Error('weather http ' + res.status);
        return res.json();
      })
      .then(function (raw) {
        return normalizeWeather(raw);
      });
  }

  function normalizeWeather(raw) {
    if (!raw || !raw.current) throw new Error('weather shape invalid');
    var cur = raw.current;
    var hourly = raw.hourly || {};
    var times = hourly.time || [];
    var temps = hourly.temperature_2m || [];
    var codes = hourly.weather_code || [];
    var days  = hourly.is_day || [];

    /* Find first hourly slot that is strictly after "now". */
    var nowMs = Date.now();
    var startIdx = 0;
    for (var i = 0; i < times.length; i++) {
      if (new Date(times[i]).getTime() > nowMs) { startIdx = i; break; }
    }

    var forecast = [];
    /* Next 3 slots, spaced 2 hours apart for a lighter feel. */
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

  /* ── Weather SVG icons ───────────────────────────────────── */
  /* Compact, stroke-based glyphs that read cleanly at small size. */

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

  /* ── Mount state ─────────────────────────────────────────── */

  var state = {
    mounted: false,
    tickTimer: null,
    refetchTimer: null,
    location: DEFAULT_LOCATION,
    weather: null,
    weatherError: null,
    simplified: false
  };

  /* ── DOM helpers ─────────────────────────────────────────── */

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call(
    (root || document).querySelectorAll(sel)); }

  function rootEl() { return document.querySelector('[data-fountain-clock]'); }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  /* ── Render: time, date, zone, sun rail, phase ───────────── */

  function renderClock() {
    var root = rootEl();
    if (!root) return;

    var now = new Date();

    setText(qs('[data-fc-time-hm]', root), formatHM(now));
    var timeEl = qs('[data-fc-time]', root);
    if (timeEl) timeEl.setAttribute('datetime', now.toISOString());

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

    /* Sun dot position: clamp to [0..1]. */
    var pct = Math.max(0, Math.min(1, solar.dayFraction));
    root.style.setProperty('--fc-sun-x', (pct * 100).toFixed(2) + '%');

    /* Global phase attribute on <html>, consumed by CSS. */
    applyPhaseAttribute(phase, solar);
  }

  function phaseLabel(phase) {
    switch (phase) {
      case 'dawn':  return 'Dawn';
      case 'dusk':  return 'Dusk';
      case 'night': return 'Night';
      default:      return 'Day';
    }
  }

  function applyPhaseAttribute(phase, solar) {
    var html = document.documentElement;

    if (state.simplified) {
      html.removeAttribute('data-phase');
      html.style.removeProperty('--ambient-warmth');
      html.style.removeProperty('--ambient-light');
      return;
    }

    html.setAttribute('data-phase', phase);

    /* Warmth: high at dawn/dusk, neutral midday, cool at night. */
    var warmth;
    switch (phase) {
      case 'dawn': warmth = 0.85; break;
      case 'dusk': warmth = 0.9;  break;
      case 'day':  warmth = 0.3;  break;
      case 'night':warmth = 0.05; break;
      default:     warmth = 0.3;
    }

    /* Light level: bell-shaped around solar noon. */
    var light = 0.15;
    if (solar.isDay) {
      var x = Math.max(0, Math.min(1, solar.dayFraction));
      /* Triangular bell peaking at 0.5. */
      light = 1 - Math.abs(x - 0.5) * 2;
      light = Math.max(0.35, light);
    }

    html.style.setProperty('--ambient-warmth', warmth.toFixed(3));
    html.style.setProperty('--ambient-light',  light.toFixed(3));
  }

  /* ── Render: weather ─────────────────────────────────────── */

  function renderWeather() {
    var root = rootEl();
    if (!root) return;

    var surface = qs('[data-fc-weather]', root);
    if (!surface) return;

    if (state.weather) {
      surface.removeAttribute('data-fc-state');
      surface.setAttribute('data-fc-state', 'ready');
    } else if (state.weatherError) {
      surface.setAttribute('data-fc-state', 'error');
    } else {
      surface.setAttribute('data-fc-state', 'loading');
    }

    if (!state.weather) {
      /* Populate skeleton placeholders once. */
      if (!qs('[data-fc-weather-icon]', surface)) {
        surface.innerHTML =
          '<div class="fc-weather-now">' +
            '<div class="fc-weather-glyph" data-fc-weather-icon aria-hidden="true"></div>' +
            '<div class="fc-weather-temp" data-fc-weather-temp>—</div>' +
            '<div class="fc-weather-meta">' +
              '<div class="fc-weather-cond" data-fc-weather-cond>Listening for weather…</div>' +
              '<div class="fc-weather-feels" data-fc-weather-feels>&nbsp;</div>' +
            '</div>' +
          '</div>' +
          '<ol class="fc-forecast" data-fc-forecast>' +
            '<li class="fc-forecast-slot"></li>' +
            '<li class="fc-forecast-slot"></li>' +
            '<li class="fc-forecast-slot"></li>' +
          '</ol>';
      }
      if (state.weatherError) {
        setText(qs('[data-fc-weather-cond]', surface), 'Weather unavailable');
        setText(qs('[data-fc-weather-feels]', surface), 'Showing your clock only.');
      }
      return;
    }

    var w = state.weather.current;
    var info = weatherInfo(w.code);

    surface.innerHTML =
      '<div class="fc-weather-now">' +
        '<div class="fc-weather-glyph" data-fc-weather-icon aria-hidden="true">' +
          iconSvg(info.mood, w.isDay) +
        '</div>' +
        '<div class="fc-weather-temp" data-fc-weather-temp>' + roundTemp(w.temp) + '</div>' +
        '<div class="fc-weather-meta">' +
          '<div class="fc-weather-cond" data-fc-weather-cond>' + escapeHtml(info.label) + '</div>' +
          '<div class="fc-weather-feels" data-fc-weather-feels>Feels ' + roundTemp(w.feels) + '</div>' +
        '</div>' +
      '</div>' +
      '<ol class="fc-forecast" data-fc-forecast>' +
        state.weather.forecast.map(function (slot) {
          var si = weatherInfo(slot.code);
          return '<li class="fc-forecast-slot">' +
            '<span class="fc-forecast-time">' + escapeHtml(formatHM(slot.time)) + '</span>' +
            '<span class="fc-forecast-glyph" aria-hidden="true">' + iconSvg(si.mood, slot.isDay) + '</span>' +
            '<span class="fc-forecast-temp">' + roundTemp(slot.temp) + '</span>' +
          '</li>';
        }).join('') +
      '</ol>';

    /* Weather mood attribute: tints the ambient glow subtly. */
    if (state.simplified) {
      document.documentElement.removeAttribute('data-weather');
    } else {
      document.documentElement.setAttribute('data-weather', info.mood);
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Render: status line (location, errors, controls) ───── */

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
        setText(asOf, 'As of ' + formatHM(new Date(state.weather.fetchedAt)));
      } else {
        asOf.hidden = true;
      }
    }

    var locateBtn = qs('[data-fc-locate]', root);
    var resetBtn  = qs('[data-fc-reset]',  root);
    if (locateBtn) locateBtn.hidden = state.location.source === 'geo';
    if (resetBtn)  resetBtn.hidden  = state.location.source !== 'geo';

    var simplifyBtn = qs('[data-fc-simplify]', root);
    if (simplifyBtn) {
      simplifyBtn.setAttribute('aria-pressed', state.simplified ? 'true' : 'false');
      simplifyBtn.textContent = state.simplified ? 'Restore ambient' : 'Simplify';
    }
  }

  /* ── Weather load orchestration (SWR) ─────────────────────── */

  function loadWeather(force) {
    var loc = state.location;
    var cached = readCache(loc.lat, loc.lon);
    var age    = cached ? Date.now() - cached.ts : Infinity;

    /* 1. If we have *any* cache, show it immediately (no flash). */
    if (cached) {
      state.weather = cached.data;
      state.weatherError = null;
      renderWeather();
      renderStatus();
    }

    /* 2. Decide whether to refetch. */
    var needsRefresh = force || !cached || age > CURRENT_TTL_MS;
    if (!needsRefresh) return;

    /* 3. Fetch quietly; keep last-known-good on failure. */
    fetchWeather(loc.lat, loc.lon)
      .then(function (data) {
        state.weather = data;
        state.weatherError = null;
        writeCache(loc.lat, loc.lon, data);
        renderWeather();
        renderStatus();
      })
      .catch(function (err) {
        /* Swallow the error if we already rendered cached data. */
        if (!state.weather) {
          state.weatherError = err;
          renderWeather();
          renderStatus();
        }
      });
  }

  /* ── Geolocation (opt-in, reversible) ─────────────────────── */

  function requestGeolocation() {
    var root = rootEl();
    var note = root && qs('[data-fc-note]', root);

    if (!('geolocation' in navigator)) {
      if (note) setText(note, 'This browser does not expose geolocation.');
      return;
    }

    if (note) setText(note, 'Asking for your location…');

    navigator.geolocation.getCurrentPosition(function (pos) {
      var loc = {
        label: 'Near you',
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        source: 'geo'
      };
      state.location = loc;
      writeStoredLocation(loc);
      if (note) setText(note, '');
      loadWeather(true);
      renderClock();
      renderStatus();
    }, function (err) {
      if (note) {
        if (err && err.code === 1) {
          setText(note, 'Permission denied. Using Houston, TX.');
        } else {
          setText(note, 'Could not reach your location. Using Houston, TX.');
        }
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
    loadWeather(true);
    renderClock();
    renderStatus();

    var root = rootEl();
    var note = root && qs('[data-fc-note]', root);
    if (note) setText(note, 'Reset. Showing Houston, TX.');
  }

  /* ── Simplify toggle ─────────────────────────────────────── */

  function setSimplified(next) {
    state.simplified = !!next;
    if (state.simplified) {
      safeSet(sessionStorage, SIMPLIFY_KEY, '1');
    } else {
      safeRemove(sessionStorage, SIMPLIFY_KEY);
    }

    /* Let CSS decide the fallback values. */
    if (state.simplified) {
      document.documentElement.setAttribute('data-ambient', 'simplified');
      document.documentElement.removeAttribute('data-phase');
      document.documentElement.removeAttribute('data-weather');
    } else {
      document.documentElement.removeAttribute('data-ambient');
    }

    renderClock();
    renderWeather();
    renderStatus();
  }

  /* ── Tick scheduler ──────────────────────────────────────── */

  function scheduleTick() {
    clearTimeout(state.tickTimer);

    /* Align to the next :00 second of the next minute so hh:mm is crisp. */
    var now = new Date();
    var msToNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());

    state.tickTimer = setTimeout(function onTick() {
      renderClock();
      /* Reschedule immediately; the next beat is exactly 60s away. */
      state.tickTimer = setTimeout(onTick, 60000);
    }, Math.max(250, msToNextMinute));
  }

  function scheduleRefetch() {
    clearInterval(state.refetchTimer);
    state.refetchTimer = setInterval(function () {
      if (document.hidden) return; /* Don't hammer in background tabs. */
      loadWeather(false);
    }, CURRENT_TTL_MS);
  }

  /* ── Event binding ───────────────────────────────────────── */

  function bindControls() {
    var root = rootEl();
    if (!root) return;

    /* Delegated listener so markup can change without rebinds. */
    if (root.__fcBound) return;
    root.__fcBound = true;

    root.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;

      if (t.closest('[data-fc-locate]'))   { requestGeolocation(); return; }
      if (t.closest('[data-fc-reset]'))    { resetLocation();      return; }
      if (t.closest('[data-fc-simplify]')) { setSimplified(!state.simplified); return; }
      if (t.closest('[data-fc-refresh]'))  { loadWeather(true);    return; }
    });
  }

  function handleVisibility() {
    if (!document.hidden) {
      /* Back in view — catch up time and refresh weather if stale. */
      renderClock();
      loadWeather(false);
    }
  }

  /* ── Lifecycle ───────────────────────────────────────────── */

  function mount() {
    var root = rootEl();
    if (!root) {
      /* Page doesn't have the ambient surface — stay inert. */
      teardownTimers();
      return;
    }

    /* Restore session preferences. */
    var stored = readStoredLocation();
    state.location   = stored || DEFAULT_LOCATION;
    state.simplified = safeGet(sessionStorage, SIMPLIFY_KEY) === '1';

    if (state.simplified) {
      document.documentElement.setAttribute('data-ambient', 'simplified');
    } else {
      document.documentElement.removeAttribute('data-ambient');
    }

    renderClock();
    renderWeather();
    renderStatus();
    bindControls();

    loadWeather(false);
    scheduleTick();
    scheduleRefetch();

    state.mounted = true;
  }

  function teardownTimers() {
    clearTimeout(state.tickTimer);
    clearInterval(state.refetchTimer);
    state.tickTimer = null;
    state.refetchTimer = null;
    state.mounted = false;
  }

  function unmount() {
    teardownTimers();
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
        fetchedAt: state.weather && state.weather.fetchedAt || null
      };
    }
  };

  /* Auto-mount on first load; shell.js will call mount() again
     after SPA navigations. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
