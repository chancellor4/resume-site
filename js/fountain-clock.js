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
  - Weather: Open-Meteo (keyless). localStorage + sessionStorage cache, SWR:
      current (soft)  → 10 min      refetch in background
      forecast (hard) →  1 hour     escalate to "stale" presentation
  - In-flight fetches are coalesced; location changes abort stale work.
  - Rendering is surgical — the weather DOM is scaffolded once and its
    text/attrs updated in place so focus, a11y hints, and animation
    continuity survive every state transition.
  - Location defaults to Houston, TX. Location is limited to curated
    preset cities and persists locally. No IP lookup, geolocation, or PII.
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

  var CITY_PRESETS = Object.freeze([
    Object.freeze({
      label: 'New Orleans, Louisiana',
      query: 'New Orleans, LA',
      lat: 29.9511,
      lon: -90.0715,
      timezone: 'America/Chicago'
    }),
    Object.freeze({
      label: 'Houston, Texas',
      query: 'Houston, TX',
      lat: 29.7604,
      lon: -95.3698,
      timezone: 'America/Chicago'
    }),
    Object.freeze({
      label: 'Dallas, Texas',
      query: 'Dallas, TX',
      lat: 32.7767,
      lon: -96.7970,
      timezone: 'America/Chicago'
    }),
    Object.freeze({
      label: 'Williamsburg, Kentucky',
      query: 'Williamsburg, KY',
      lat: 36.7434,
      lon: -84.1597,
      timezone: 'America/New_York'
    }),
    Object.freeze({
      label: 'Baton Rouge, Louisiana',
      query: 'Baton Rouge, LA',
      lat: 30.4515,
      lon: -91.1871,
      timezone: 'America/Chicago'
    }),
    Object.freeze({
      label: 'New York, New York',
      query: 'New York, NY',
      lat: 40.7128,
      lon: -74.0060,
      timezone: 'America/New_York'
    }),
    Object.freeze({
      label: 'Los Angeles, California',
      query: 'Los Angeles, CA',
      lat: 34.0522,
      lon: -118.2437,
      timezone: 'America/Los_Angeles'
    })
  ]);

  var LOCATION_MICROCOPY = Object.freeze({
    'new-orleans-louisiana': 'Soft start, jazz-air steady.',
    'houston-texas': 'Warm glass, big-sky focus.',
    'dallas-texas': 'Clear grid, bright focus.',
    'williamsburg-kentucky': 'Green hills, steady hands.',
    'baton-rouge-louisiana': 'River light, calm pace.',
    'new-york-new-york': 'Bright pace, steady center.',
    'los-angeles-california': 'Wide light, quiet momentum.'
  });

  var LOCATION_ALIASES = Object.freeze({
    'New Orleans': 'new-orleans-louisiana',
    'New Orleans, LA': 'new-orleans-louisiana',
    'New Orleans, Louisiana': 'new-orleans-louisiana',
    'Houston': 'houston-texas',
    'Houston, TX': 'houston-texas',
    'Houston, Texas': 'houston-texas',
    'Dallas': 'dallas-texas',
    'Dallas, TX': 'dallas-texas',
    'Dallas, Texas': 'dallas-texas',
    'Williamsburg': 'williamsburg-kentucky',
    'Williamsburg, KY': 'williamsburg-kentucky',
    'Williamsburg, Kentucky': 'williamsburg-kentucky',
    'Baton Rouge': 'baton-rouge-louisiana',
    'Baton Rouge, LA': 'baton-rouge-louisiana',
    'Baton Rouge, Louisiana': 'baton-rouge-louisiana',
    'New York': 'new-york-new-york',
    'New York, NY': 'new-york-new-york',
    'New York, New York': 'new-york-new-york',
    'Los Angeles': 'los-angeles-california',
    'Los Angeles, CA': 'los-angeles-california',
    'Los Angeles, California': 'los-angeles-california',
    'new-orleans': 'new-orleans-louisiana',
    'houston': 'houston-texas',
    'new-york': 'new-york-new-york',
    'nyc': 'new-york-new-york',
    'los-angeles': 'los-angeles-california'
  });

  function locationKey(label) {
    return String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isValidTimezone(tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      return true;
    } catch (e) {
      return false;
    }
  }

  function isValidPreset(city) {
    return !!(city &&
      typeof city.label === 'string' &&
      typeof city.query === 'string' &&
      typeof city.lat === 'number' &&
      typeof city.lon === 'number' &&
      city.lat >= -90 && city.lat <= 90 &&
      city.lon >= -180 && city.lon <= 180 &&
      isValidTimezone(city.timezone));
  }

  function buildLocations() {
    var locations = {};
    for (var i = 0; i < CITY_PRESETS.length; i++) {
      var city = CITY_PRESETS[i];
      if (!isValidPreset(city)) continue;
      var key = locationKey(city.label);
      locations[key] = Object.freeze({
        key: key,
        attr: key,
        label: city.label,
        query: city.query,
        microcopy: LOCATION_MICROCOPY[key],
        lat: city.lat,
        lon: city.lon,
        timezone: city.timezone,
        tz: city.timezone
      });
    }
    return Object.freeze(locations);
  }

  var LOCATIONS = buildLocations();
  var DEFAULT_LOCATION = LOCATIONS['houston-texas'] || LOCATIONS[Object.keys(LOCATIONS)[0]];

  var CACHE_KEY_PREFIX = 'fc:weather:';
  var GREETING_TEXT    = 'Hi, welcome to my site';
  var PREFS_KEY        = 'fc:preferences:v2';
  var LOCATION_KEY     = 'fc:location';
  var DETAILS_KEY      = 'fc:details';
  var TIME_FORMAT_KEY  = 'fc:time-format';
  var DND_KEY          = 'ce-mode';

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
    2:  { label: 'Partly cloudy',    mood: 'cloudy' },
    3:  { label: 'Overcast',         mood: 'cloudy' },
    45: { label: 'Fog',              mood: 'fog'    },
    48: { label: 'Icy fog',          mood: 'fog'    },
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
    71: { label: 'Light snow',       mood: 'cold'   },
    73: { label: 'Snow',             mood: 'cold'   },
    75: { label: 'Heavy snow',       mood: 'cold'   },
    77: { label: 'Snow grains',      mood: 'cold'   },
    80: { label: 'Rain showers',     mood: 'rain'   },
    81: { label: 'Rain showers',     mood: 'rain'   },
    82: { label: 'Heavy showers',    mood: 'rain'   },
    85: { label: 'Snow showers',     mood: 'cold'  },
    86: { label: 'Snow showers',     mood: 'cold'  },
    95: { label: 'Thunderstorm',     mood: 'storm' },
    96: { label: 'Thunderstorm',     mood: 'storm' },
    99: { label: 'Thunderstorm',     mood: 'storm' }
  };

  /* ── Safe storage wrappers ───────────────────────────────── */

  function safeGet(storage, key) {
    try { return storage && storage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (e) {}
  }
  /* ── Location state (session-scoped) ─────────────────────── */

  function readStoredLocation() {
    var raw = safeGet(localStorage, LOCATION_KEY);
    if (!raw) return null;
    if (LOCATIONS[raw]) return LOCATIONS[raw];
    if (LOCATION_ALIASES[raw] && LOCATIONS[LOCATION_ALIASES[raw]]) {
      return LOCATIONS[LOCATION_ALIASES[raw]];
    }
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.key && LOCATIONS[parsed.key]) return LOCATIONS[parsed.key];
      if (parsed && parsed.key && LOCATION_ALIASES[parsed.key]) {
        return LOCATIONS[LOCATION_ALIASES[parsed.key]];
      }
      if (parsed && parsed.label && LOCATION_ALIASES[parsed.label]) {
        return LOCATIONS[LOCATION_ALIASES[parsed.label]];
      }
      if (parsed && parsed.query && LOCATION_ALIASES[parsed.query]) {
        return LOCATIONS[LOCATION_ALIASES[parsed.query]];
      }
    } catch (e) {}
    return null;
  }

  function writeStoredLocation(loc) {
    safeSet(localStorage, LOCATION_KEY, loc.key || DEFAULT_LOCATION.key);
  }

  function readPreferences() {
    var prefs = {
      location: DEFAULT_LOCATION.key,
      DND: false,
      detailsOpen: false,
      volume: 40,
      hour24: false
    };

    try {
      var raw = safeGet(localStorage, PREFS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (LOCATIONS[parsed.location]) prefs.location = parsed.location;
          if (LOCATION_ALIASES[parsed.location] && LOCATIONS[LOCATION_ALIASES[parsed.location]]) {
            prefs.location = LOCATION_ALIASES[parsed.location];
          }
          if (typeof parsed.DND === 'boolean') prefs.DND = parsed.DND;
          if (typeof parsed.detailsOpen === 'boolean') prefs.detailsOpen = parsed.detailsOpen;
          if (typeof parsed.volume === 'number') prefs.volume = Math.max(0, Math.min(100, parsed.volume));
          if (typeof parsed.hour24 === 'boolean') prefs.hour24 = parsed.hour24;
        }
      }
    } catch (e) {}

    var storedLocation = readStoredLocation();
    if (storedLocation) prefs.location = storedLocation.key;

    var storedDetails = safeGet(localStorage, DETAILS_KEY);
    if (storedDetails === 'open' || storedDetails === 'true') prefs.detailsOpen = true;
    if (storedDetails === 'closed' || storedDetails === 'false') prefs.detailsOpen = false;

    var storedFormat = safeGet(localStorage, TIME_FORMAT_KEY);
    if (storedFormat === '24') prefs.hour24 = true;
    if (storedFormat === '12') prefs.hour24 = false;

    var storedDnd = safeGet(localStorage, DND_KEY);
    if (storedDnd) prefs.DND = storedDnd === 'dnd';

    return prefs;
  }

  function writePreferences(patch) {
    var prefs = state && state.preferences ? state.preferences : readPreferences();
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) prefs[key] = patch[key];
    }
    safeSet(localStorage, PREFS_KEY, JSON.stringify(prefs));
    if (patch.location) writeStoredLocation(LOCATIONS[patch.location] || DEFAULT_LOCATION);
    if (Object.prototype.hasOwnProperty.call(patch, 'detailsOpen')) {
      safeSet(localStorage, DETAILS_KEY, patch.detailsOpen ? 'open' : 'closed');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'hour24')) {
      safeSet(localStorage, TIME_FORMAT_KEY, patch.hour24 ? '24' : '12');
    }
    state.preferences = prefs;
  }

  /* ── Cache (session-scoped, SWR) ─────────────────────────── */

  function cacheKey(lat, lon) {
    /* Round to ~1 km grid so slight wobble doesn't spawn new entries. */
    return CACHE_KEY_PREFIX + lat.toFixed(2) + ':' + lon.toFixed(2);
  }

  function readCache(lat, lon) {
    var raw = safeGet(localStorage, cacheKey(lat, lon)) ||
              safeGet(sessionStorage, cacheKey(lat, lon));
    if (!raw) return null;
    try {
      var entry = JSON.parse(raw);
      if (entry && typeof entry.ts === 'number' && entry.data) {
        reviveWeatherDates(entry.data);
        return entry;
      }
    } catch (e) {}
    return null;
  }

  function writeCache(lat, lon, data) {
    var entry = { ts: Date.now(), data: data };
    var value = JSON.stringify(entry);
    safeSet(localStorage, cacheKey(lat, lon), value);
    safeSet(sessionStorage, cacheKey(lat, lon), value);
  }

  function reviveWeatherDates(data) {
    if (!data) return;
    if (data.daily) {
      if (data.daily.sunrise && !(data.daily.sunrise instanceof Date)) {
        data.daily.sunrise = new Date(data.daily.sunrise);
      }
      if (data.daily.sunset && !(data.daily.sunset instanceof Date)) {
        data.daily.sunset = new Date(data.daily.sunset);
      }
    }
    if (data.forecast) {
      for (var i = 0; i < data.forecast.length; i++) {
        if (data.forecast[i] && !(data.forecast[i].time instanceof Date)) {
          data.forecast[i].time = new Date(data.forecast[i].time);
        }
      }
    }
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
  function formatHM(date, tz, hour24) {
    var key = (tz || 'local') + ':' + (hour24 ? '24' : '12');
    if (!hmFormatters[key]) {
      var opts = { hour: 'numeric', minute: '2-digit', hour12: !hour24 };
      if (tz) opts.timeZone = tz;
      try {
        hmFormatters[key] = new Intl.DateTimeFormat(undefined, opts);
      } catch (e) {
        hmFormatters[key] = new Intl.DateTimeFormat(undefined, {
          hour: 'numeric', minute: '2-digit', hour12: !hour24
        });
      }
    }
    return hmFormatters[key].format(date);
  }

  var dateFormatters = {};
  function formatDate(date, tz) {
    var key = tz || 'local';
    if (!dateFormatters[key]) {
      var opts = { weekday: 'long', month: 'long', day: 'numeric' };
      if (tz) opts.timeZone = tz;
      try {
        dateFormatters[key] = new Intl.DateTimeFormat(undefined, opts);
      } catch (e) {
        dateFormatters[key] = new Intl.DateTimeFormat(undefined, {
          weekday: 'long', month: 'long', day: 'numeric'
        });
      }
    }
    return dateFormatters[key].format(date);
  }

  function formatDateISO(date, tz) {
    try {
      var opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
      if (tz) opts.timeZone = tz;
      var parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(date);
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      return map.year + '-' + map.month + '-' + map.day;
    } catch (e) {
      return date.toISOString().slice(0, 10);
    }
  }

  var zoneFormatters = {};
  function formatZoneLabel(tz) {
    var key = tz || 'local';
    try {
      if (!zoneFormatters[key]) {
        var opts = { timeZoneName: 'short' };
        if (tz) opts.timeZone = tz;
        zoneFormatters[key] = new Intl.DateTimeFormat(undefined, opts);
      }
      var parts = zoneFormatters[key].formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value;
      }
      return tz || Intl.DateTimeFormat().resolvedOptions().timeZone || '';
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
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m' +
      '&hourly=temperature_2m,weather_code,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset' +
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
    var daily = raw.daily || {};
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
      var slotTime = new Date(times[idx]);
      if (isNaN(slotTime.getTime())) continue;
      forecast.push({
        time: slotTime,
        temp: temps[idx],
        code: codes[idx],
        isDay: days[idx] === 1
      });
    }

    return {
      current: {
        temp: cur.temperature_2m,
        feels: cur.apparent_temperature,
        humidity: cur.relative_humidity_2m,
        code: cur.weather_code,
        isDay: cur.is_day === 1,
        wind: cur.wind_speed_10m
      },
      daily: {
        high: daily.temperature_2m_max && daily.temperature_2m_max[0],
        low: daily.temperature_2m_min && daily.temperature_2m_min[0],
        sunrise: daily.sunrise && daily.sunrise[0] ? new Date(daily.sunrise[0]) : null,
        sunset: daily.sunset && daily.sunset[0] ? new Date(daily.sunset[0]) : null
      },
      forecast: forecast,
      source: 'Open-Meteo',
      fallback: false,
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
      case 'fog':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 6.5 4 4 0 0 0 7 15z"/><g stroke-linecap="round"><line x1="5" y1="18" x2="19" y2="18"/><line x1="7" y1="21" x2="17" y2="21"/></g></svg>';
      case 'rain':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 6.5 4 4 0 0 0 7 15z"/><g stroke-linecap="round"><line x1="9"  y1="18" x2="8"  y2="21"/><line x1="13" y1="18" x2="12" y2="21"/><line x1="17" y1="18" x2="16" y2="21"/></g></svg>';
      case 'cold':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15h10a4 4 0 0 0 .5-7.97A5 5 0 0 0 8 6.5 4 4 0 0 0 7 15z"/><g stroke-linecap="round"><circle cx="9"  cy="19.5" r="0.6"/><circle cx="13" cy="20"   r="0.6"/><circle cx="17" cy="19.5" r="0.6"/></g></svg>';
      case 'hot':
        return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><g stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/></g></svg>';
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
    timeOfDay: 'day',
    location: DEFAULT_LOCATION,
    weather: null,
    sun: null,
    DND: false,
    reducedMotion: false,
    weatherError: null,
    detailsOpen: false,
    preferences: {
      location: DEFAULT_LOCATION.key,
      DND: false,
      detailsOpen: false,
      volume: 40,
      hour24: false
    },
    pendingFetch: null,
    pendingController: null,
    pendingKey: null,
    lastGood: null,

    /* Mini Card — single source of truth for mode/timer/stopwatch.
       The dominant .fc-time clock readout is never repurposed; the
       Mini Card stage hosts secondary timer/stopwatch readouts only. */
    mini: {
      mode: 'time',           // 'time' | 'timer' | 'stopwatch'
      isRunning: false,
      startTime: null,        // epoch ms when last started
      accumulated: 0,         // ms accumulated across pause/resume
      duration: 5 * 60 * 1000,// timer target, ms
      lastFinishedAt: null,   // for the brief "done" window
      rafHandle: null,        // requestAnimationFrame id while running
      tailTimer: null,        // settle-back timer after completion
      hasPainted: false       // first-paint guard for ARIA noise
    },

    /* Sun Cycle Card — renderer-only, consumes state. */
    sunCard: {
      lastPhase: null,
      lastNextEvent: null,
      asideEl: null
    }
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

  function removeAttr(el, name) {
    if (el && el.hasAttribute(name)) el.removeAttribute(name);
  }

  function homeTitleFor(location) {
    var label = location && location.label ? location.label : DEFAULT_LOCATION.label;
    return 'Home — ' + label + ' — Chancellor Edwards (Chance Edwards)';
  }

  function syncHomeTitle() {
    var title = homeTitleFor(state.location);
    if (document.title !== title) document.title = title;

    var ogTitle = qs('meta[property="og:title"]');
    var twitterTitle = qs('meta[name="twitter:title"]');
    setAttr(ogTitle, 'content', title);
    setAttr(twitterTitle, 'content', title);
  }

  function rememberGoodState() {
    if (!state.location) return;
    state.lastGood = {
      location: state.location,
      weather: state.weather || null
    };
  }

  function restoreLastGoodState(err) {
    if (!state.lastGood || !state.lastGood.location) {
      state.weatherError = err;
      renderWeather();
      renderStatus();
      return;
    }
    state.location = state.lastGood.location;
    state.preferences.location = state.location.key;
    state.weather = state.lastGood.weather || null;
    state.weatherError = state.weather ? null : err;
    writePreferences({ location: state.location.key });
    renderClock();
    renderWeather();
    renderStatus();
  }

  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function readDnd() {
    return document.documentElement.getAttribute('data-mode') === 'dnd' ||
      safeGet(localStorage, DND_KEY) === 'dnd';
  }

  function clockPhase(phase) {
    if (phase === 'dawn') return 'morning';
    if (phase === 'dusk') return 'evening';
    if (phase === 'night') return 'night';
    return 'day';
  }

  function weatherMood(info, current) {
    if (!current) return null;
    if (typeof current.temp === 'number' && current.temp >= 92) return 'hot';
    if (typeof current.temp === 'number' && current.temp <= 38) return 'cold';
    return info.mood;
  }

  /* ── Render: time, date, zone, sun rail, phase ───────────── */

  function renderClock() {
    var root = rootEl();
    if (!root) return;

    var now = new Date();

    setText(qs('[data-fc-greeting]', root), GREETING_TEXT);
    setText(qs('[data-fc-time-hm]', root), formatHM(now, state.location.tz, state.preferences.hour24));

    var timeEl = qs('[data-fc-time]', root);
    if (timeEl) setAttr(timeEl, 'datetime', now.toISOString());

    var dateEl = qs('[data-fc-date]', root);
    setText(dateEl, formatDate(now, state.location.tz));
    if (dateEl) setAttr(dateEl, 'datetime', formatDateISO(now, state.location.tz));
    setText(qs('[data-fc-zone]', root), formatZoneLabel(state.location.tz));

    var solar = solarTimes(state.location.lat, state.location.lon, now);
    var phase = classifyPhase(solar, now);
    state.sun = solar;
    state.timeOfDay = clockPhase(phase);
    state.DND = readDnd();
    state.reducedMotion = prefersReducedMotion();

    setText(qs('[data-fc-phase]', root), phaseLabel(phase));

    /* Sun rail rendering is owned by SunCycleCard now — it consumes
       (now, solar, phase, location) and writes its own DOM + tokens.
       The clock remains the single source of state. */
    SunCycleCard.render(now, solar, phase);

    applyPhaseAttribute(phase, solar);

    /* Mini Card paints once per tick to keep its readouts fresh in
       'time' mode (where the wall-clock minute drives it). When the
       Mini Card is running a timer/stopwatch, its rAF loop already
       owns the cadence; this tick is a safe no-op there. */
    MiniCard.onClockTick(now);
  }

  function phaseLabel(phase) {
    if (phase === 'dawn')  return 'Dawn';
    if (phase === 'dusk')  return 'Dusk';
    if (phase === 'night') return 'Night';
    return 'Day';
  }

  function applyPhaseAttribute(phase, solar) {
    var html = document.documentElement;

    setAttr(html, 'data-phase', phase);
    setAttr(html, 'data-clock-phase', state.timeOfDay);
    setAttr(html, 'data-location', state.location.attr || state.location.key);
    setAttr(html, 'data-dnd', state.DND ? 'true' : 'false');

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
      '<div class="fc-weather-details" id="fcWeatherDetails" data-fc-weather-details>' +
        '<span data-fc-weather-feels-detail>Feels like —</span>' +
        '<span data-fc-weather-highlow>High / low —</span>' +
        '<span data-fc-weather-wind>Wind —</span>' +
        '<span data-fc-weather-humidity>Humidity —</span>' +
        '<time data-fc-weather-sunrise datetime="">Sunrise —</time>' +
        '<time data-fc-weather-sunset datetime="">Sunset —</time>' +
        '<time data-fc-weather-updated datetime="">Updated —</time>' +
        '<span data-fc-weather-source>Source —</span>' +
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
    var feelsDetailEl = qs('[data-fc-weather-feels-detail]', surface);
    var highLowEl = qs('[data-fc-weather-highlow]', surface);
    var humidityEl = qs('[data-fc-weather-humidity]', surface);
    var windEl = qs('[data-fc-weather-wind]', surface);
    var sunriseEl = qs('[data-fc-weather-sunrise]', surface);
    var sunsetEl = qs('[data-fc-weather-sunset]', surface);
    var updatedEl = qs('[data-fc-weather-updated]', surface);
    var sourceEl = qs('[data-fc-weather-source]', surface);
    var slots   = qsa('[data-fc-forecast-slot]', surface);

    if (!state.weather) {
      var copy = state.weatherError ? WEATHER_COPY.error : WEATHER_COPY.loading;
      clearGlyph(iconEl);
      setText(tempEl,  '—');
      setText(condEl,  copy.cond);
      setText(feelsEl, copy.feels);
      setText(feelsDetailEl, 'Feels like —');
      setText(highLowEl, 'High / low —');
      setText(humidityEl, 'Humidity —');
      setText(windEl, 'Wind —');
      setText(sunriseEl, 'Sunrise —');
      setText(sunsetEl, 'Sunset —');
      setText(updatedEl, 'Updated —');
      removeAttr(sunriseEl, 'datetime');
      removeAttr(sunsetEl, 'datetime');
      removeAttr(updatedEl, 'datetime');
      setText(sourceEl, state.weatherError ? 'Fallback clock only' : 'Source pending');
      setText(qs('[data-fc-weather-line]', root), state.weatherError ? 'Weather quiet, clock steady' : 'Weather warming up');

    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      s.hidden = false;
      setText(qs('[data-fc-forecast-time]', s), state.detailsOpen ? 'Soon' : '');
      setText(qs('[data-fc-forecast-temp]', s), '');
      clearGlyph(qs('[data-fc-forecast-glyph]', s));
      }

      /* When we have no weather, suppress mood tint to stay calm. */
      setAttr(document.documentElement, 'data-weather', 'clear');
      return;
    }

    var w = state.weather.current;
    var info = weatherInfo(w.code);
    var mood = weatherMood(info, w);
    var daily = state.weather.daily || {};
    var sunrise = daily.sunrise || (state.sun && state.sun.sunrise);
    var sunset = daily.sunset || (state.sun && state.sun.sunset);

    setGlyph(iconEl, mood, w.isDay);
    setText(tempEl,  roundTemp(w.temp));
    setText(condEl,  info.label);
    setText(feelsEl, 'Feels ' + roundTemp(w.feels));
    setText(feelsDetailEl, 'Feels like ' + roundTemp(w.feels));
    setText(highLowEl, 'High ' + roundTemp(daily.high) + ' / Low ' + roundTemp(daily.low));
    setText(humidityEl, 'Humidity ' + (isNaN(w.humidity) ? '—' : Math.round(w.humidity) + '%'));
    setText(windEl, 'Wind ' + (isNaN(w.wind) ? '—' : Math.round(w.wind) + ' mph'));
    setText(sunriseEl, 'Sunrise ' + (sunrise ? formatHM(new Date(sunrise), state.location.tz, state.preferences.hour24) : '—'));
    setText(sunsetEl, 'Sunset ' + (sunset ? formatHM(new Date(sunset), state.location.tz, state.preferences.hour24) : '—'));
    setText(updatedEl, 'Updated ' + formatHM(new Date(state.weather.fetchedAt), state.location.tz, state.preferences.hour24));
    setAttr(sunriseEl, 'datetime', sunrise ? new Date(sunrise).toISOString() : '');
    setAttr(sunsetEl, 'datetime', sunset ? new Date(sunset).toISOString() : '');
    setAttr(updatedEl, 'datetime', new Date(state.weather.fetchedAt).toISOString());
    setText(sourceEl, (state.weather.fallback ? 'Fallback' : 'Source') + ' ' + (state.weather.source || 'Open-Meteo'));
    setText(qs('[data-fc-weather-line]', root), roundTemp(w.temp) + ' and ' + info.label.toLowerCase());

    for (var k = 0; k < slots.length; k++) {
      var slotEl = slots[k];
      var data   = state.weather.forecast[k];
      if (!data) {
        slotEl.hidden = true;
        continue;
      }
      slotEl.hidden = false;
      var slotTime = data.time instanceof Date ? data.time : new Date(data.time);
      setText(qs('[data-fc-forecast-time]', slotEl),
              slotTime && !isNaN(slotTime.getTime()) ? formatHM(slotTime, state.location.tz, state.preferences.hour24) : 'Soon');
      setText(qs('[data-fc-forecast-temp]', slotEl), roundTemp(data.temp));
      setGlyph(qs('[data-fc-forecast-glyph]', slotEl),
               weatherMood(weatherInfo(data.code), data), data.isDay);
    }

    setAttr(document.documentElement, 'data-weather', mood);
  }

  /* ── Render: status row (location, asof, controls, note) ─── */

  function syncLocationOptions(select) {
    if (!select) return;
    if (select.__fcPresetSignature === CITY_PRESETS.length + ':' + DEFAULT_LOCATION.key) return;
    while (select.firstChild) select.removeChild(select.firstChild);
    for (var i = 0; i < CITY_PRESETS.length; i++) {
      var city = CITY_PRESETS[i];
      if (!isValidPreset(city)) continue;
      var option = document.createElement('option');
      option.value = locationKey(city.label);
      option.textContent = city.label;
      select.appendChild(option);
    }
    select.__fcPresetSignature = CITY_PRESETS.length + ':' + DEFAULT_LOCATION.key;
  }

  function renderStatus() {
    var root = rootEl();
    if (!root) return;

    setAttr(root, 'data-fc-details', state.detailsOpen ? 'open' : 'closed');

    syncHomeTitle();

    var locEl = qs('[data-fc-location]', root);
    setText(locEl, state.location.label);
    setText(qs('[data-fc-note]', root), state.location.microcopy || 'Steady clock, soft room.');

    var asOf = qs('[data-fc-asof]', root);
    if (asOf) {
      if (state.weather && state.weather.fetchedAt) {
        asOf.hidden = false;
        var prefixAs = weatherIsStale() ? 'Stale cache ' : 'As of ';
        setText(asOf, prefixAs + formatHM(new Date(state.weather.fetchedAt), state.location.tz, state.preferences.hour24));
      } else {
        asOf.hidden = false;
        setText(asOf, state.weatherError ? 'Weather fallback' : 'Weather warming up');
      }
    }

    var select = qs('[data-fc-location-select]', root);
    syncLocationOptions(select);
    if (select && select.value !== state.location.key) {
      select.value = state.location.key;
    }

    var detailsBtn = qs('[data-fc-details-toggle]', root);
    if (detailsBtn) {
      setAttr(detailsBtn, 'aria-expanded', state.detailsOpen ? 'true' : 'false');
      setText(detailsBtn, state.detailsOpen ? 'Less' : 'Details');
    }

    var timeFormatBtn = qs('[data-fc-time-format]', root);
    if (timeFormatBtn) {
      setAttr(timeFormatBtn, 'aria-pressed', state.preferences.hour24 ? 'true' : 'false');
      setAttr(timeFormatBtn, 'aria-label', state.preferences.hour24 ? 'Use 12-hour time' : 'Use 24-hour time');
      setText(timeFormatBtn, state.preferences.hour24 ? '24h' : '12h');
    }
  }

  /* ── Sun Cycle Card (renderer; consumes state, never owns it) ──── */
  /*
     Scope: .fc-sun, .fc-sun-rail, .fc-sun-dot, [data-fc-sunrise],
            [data-fc-sunset], plus a calm secondary line.

     Public surface:
       SunCycleCard.render(now, solar, phase)
         · writes [data-fc-sunrise]/[data-fc-sunset] text + datetime
         · writes --fc-sun-x (existing) and --sun-progress (new)
         · scaffolds and updates [data-fc-sun-aside] if room allows
         · sets data-fc-sun-phase / data-fc-sun-next on the .fc-sun root
         · emits aria-live updates only on phase / next-event flips

       SunCycleCard.unmount()
         · clears its own state pointers; never destroys the DOM.

     The Fountain Clock owns: solar math, location, time formatting,
     and phase classification. SunCycleCard is a presentational layer.
  */
  var SunCycleCard = (function () {

    function ensureAside(sunRoot) {
      if (state.sunCard.asideEl && state.sunCard.asideEl.isConnected) {
        return state.sunCard.asideEl;
      }
      var aside = qs('[data-fc-sun-aside]', sunRoot);
      if (!aside) {
        aside = document.createElement('p');
        aside.className = 'fc-sun-aside';
        aside.setAttribute('data-fc-sun-aside', '');
        aside.setAttribute('role', 'status');
        aside.setAttribute('aria-live', 'polite');
        aside.textContent = '';
        sunRoot.appendChild(aside);
      }
      state.sunCard.asideEl = aside;
      return aside;
    }

    function nextEventDescriptor(now, solar, phase) {
      var nMs = now.getTime();
      var rise = solar.sunrise ? solar.sunrise.getTime() : null;
      var set  = solar.sunset  ? solar.sunset.getTime()  : null;

      /* Polar edge cases: solar may have no rise/set today. Surface a
         calm "Daylight" reading instead of a phantom next-event. */
      if (rise == null || set == null) {
        return { kind: 'daylight', minutes: null };
      }

      if (nMs < rise) return { kind: 'sunrise', at: solar.sunrise };
      if (nMs < set)  return { kind: 'sunset',  at: solar.sunset  };
      return { kind: 'sunrise-tomorrow', at: null };
    }

    function asideLine(now, solar, phase) {
      var ev = nextEventDescriptor(now, solar, phase);
      var tz = state.location.tz;
      var h24 = state.preferences.hour24;

      if (ev.kind === 'sunrise' && ev.at) {
        return 'Next · sunrise at ' + formatHM(ev.at, tz, h24);
      }
      if (ev.kind === 'sunset' && ev.at) {
        return 'Next · sunset at ' + formatHM(ev.at, tz, h24);
      }
      if (ev.kind === 'sunrise-tomorrow') {
        /* After today's sunset, the most legible read is daylight length. */
        if (solar.sunrise && solar.sunset) {
          var mins = Math.round((solar.sunset.getTime() - solar.sunrise.getTime()) / 60000);
          if (mins > 0) {
            var h = Math.floor(mins / 60);
            var m = mins % 60;
            return 'Daylight · ' + h + 'h ' + (m < 10 ? '0' + m : m) + 'm';
          }
        }
        return 'Resting · sun is down';
      }
      if (ev.kind === 'daylight') {
        return solar.isDay ? 'Long light · sun stays up' : 'Long night · sun stays down';
      }
      return '';
    }

    function render(now, solar, phase) {
      var root = rootEl();
      if (!root) return;
      var sunRoot = qs('[data-fc-sun]', root);
      if (!sunRoot) return;

      var sunriseEl = qs('[data-fc-sunrise]', sunRoot);
      var sunsetEl  = qs('[data-fc-sunset]',  sunRoot);

      if (solar.sunrise) {
        setText(sunriseEl, formatHM(solar.sunrise, state.location.tz, state.preferences.hour24));
        setAttr(sunriseEl, 'datetime', solar.sunrise.toISOString());
      } else {
        setText(sunriseEl, '—');
        removeAttr(sunriseEl, 'datetime');
      }
      if (solar.sunset) {
        setText(sunsetEl, formatHM(solar.sunset, state.location.tz, state.preferences.hour24));
        setAttr(sunsetEl, 'datetime', solar.sunset.toISOString());
      } else {
        setText(sunsetEl, '—');
        removeAttr(sunsetEl, 'datetime');
      }

      /* Clamped 0..1 — before sunrise → 0, after sunset → 1, day → fraction. */
      var pct = Math.max(0, Math.min(1, solar.dayFraction));

      /* Existing public token, kept for back-compat with current CSS. */
      root.style.setProperty('--fc-sun-x', (pct * 100).toFixed(2) + '%');
      /* New token — mirrors the same value as a 0..1 normalized form so
         CSS authors don't need to slice the percentage substring. */
      sunRoot.style.setProperty('--sun-progress', pct.toFixed(4));

      setAttr(sunRoot, 'data-fc-sun-phase', phase);

      var ev = nextEventDescriptor(now, solar, phase);
      setAttr(sunRoot, 'data-fc-sun-next', ev.kind);

      var aside = ensureAside(sunRoot);
      var line  = asideLine(now, solar, phase);

      /* Only push aria-live updates on meaningful flips. The minute
         tick can't be aria-live — that would be screen-reader noise. */
      var phaseFlipped = state.sunCard.lastPhase !== phase;
      var eventFlipped = state.sunCard.lastNextEvent !== ev.kind;
      if (!phaseFlipped && !eventFlipped) {
        aside.setAttribute('aria-live', 'off');
      } else {
        aside.setAttribute('aria-live', 'polite');
      }
      setText(aside, line);

      state.sunCard.lastPhase = phase;
      state.sunCard.lastNextEvent = ev.kind;
    }

    function unmount() {
      state.sunCard.asideEl = null;
      state.sunCard.lastPhase = null;
      state.sunCard.lastNextEvent = null;
    }

    return { render: render, unmount: unmount };
  })();

  /* ── Mini Card (polymorphic time / timer / stopwatch) ──────────── */
  /*
     Design intent
     -------------
     The Fountain Clock quietly learns Timer and Stopwatch. The Mini
     Card is additive: a small affordance docked inside .fc-face after
     the ambient copy line. The dominant .fc-time wall-clock readout
     is *never* repurposed. Mode swaps update text + data-* only.

     State (single source of truth)
       state.mini = {
         mode: 'time' | 'timer' | 'stopwatch',
         isRunning, startTime, accumulated, duration,
         lastFinishedAt, rafHandle, tailTimer, hasPainted
       }
     Derived (via getters)
       elapsed   — for stopwatch
       remaining — for timer

     Drift correction
       All readouts are derived from (Date.now() - startTime + accumulated).
       The rAF loop only paints; it never accumulates.

     Persistence
       fc:mini:v1 — { mode, duration }. Running state is restored only
       when the gap between save and now is <= 10 minutes; otherwise we
       degrade to idle in the saved mode.

     DND
       Completion is silent regardless. A subtle data-fc-mini-state="done"
       window of ~6s lets CSS pulse the existing breathe keyframe;
       reduced-motion users get only a static label change.

     Teardown
       unmount() cancels rAF, clears tailTimer, and frees DOM pointers.
       SPA navigation hits unmount → mount, so nothing leaks.
  */
  var MiniCard = (function () {
    var MINI_KEY = 'fc:mini:v1';
    var DEFAULT_DURATION = 5 * 60 * 1000;
    var MAX_DURATION = 24 * 60 * 60 * 1000 - 1000; // 23:59:59
    var MIN_DURATION = 1000;
    var DONE_WINDOW_MS = 6000;
    var RUN_RESTORE_GRACE_MS = 10 * 60 * 1000;

    /* ── Dial constants (precision-safe integer minutes) ─────────
       The dial replaces the fixed preset pills. State lives in
       integer minutes; the on-belt translateX is derived. Any
       float drift can only enter via px math, never the value. */
    var DIAL_MIN_MIN = 1;
    var DIAL_MAX_MIN = 90;
    var DIAL_STEP_PX = 14;          // pixels per minute on the belt
    var DIAL_FRICTION = 0.92;       // momentum decay per frame
    var DIAL_SETTLE_PX_PER_FRAME = 0.35;
    var DIAL_SNAP_MS = 220;

    /* ── persistence ───────────────────────────────────────── */

    function readPersisted() {
      /* Per spec: any parse failure or schema mismatch degrades the
         Mini Card to 'time' mode. We surface that as null and the
         mount() code keeps the in-memory defaults (mode='time'). */
      try {
        var raw = safeGet(localStorage, MINI_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        var modes = { time: 1, timer: 1, stopwatch: 1 };
        if (!modes[parsed.mode]) return null;
        var dur = Number(parsed.duration);
        if (!isFinite(dur) || dur < MIN_DURATION || dur > MAX_DURATION) return null;
        var acc = Number(parsed.accumulated);
        if (!isFinite(acc) || acc < 0 || acc > MAX_DURATION * 2) return null;
        var ts = Number(parsed.ts);
        if (!isFinite(ts) || ts < 0) return null;
        var phase = parsed.phase === 'running' ? 'running' : 'idle';
        return {
          mode: parsed.mode,
          duration: dur,
          phase: phase,
          accumulated: acc,
          ts: ts
        };
      } catch (e) { return null; }
    }

    function writePersisted() {
      try {
        var m = state.mini;
        var payload = {
          mode: m.mode,
          duration: m.duration,
          phase: m.isRunning ? 'running' : 'idle',
          accumulated: m.accumulated,
          ts: Date.now()
        };
        safeSet(localStorage, MINI_KEY, JSON.stringify(payload));
      } catch (e) {}
    }

    /* ── time math ─────────────────────────────────────────── */

    function elapsedMs() {
      var m = state.mini;
      var base = m.accumulated || 0;
      if (m.isRunning && m.startTime != null) {
        base += Date.now() - m.startTime;
      }
      return base < 0 ? 0 : base;
    }

    function remainingMs() {
      var m = state.mini;
      var rem = m.duration - elapsedMs();
      return rem < 0 ? 0 : rem;
    }

    /* ── formatting ────────────────────────────────────────── */

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function formatTimerMs(ms) {
      /* Timer shows the largest meaningful unit. Below 1h: MM:SS;
         above 1h: H:MM:SS. Sub-second precision is a distraction —
         and would invite per-frame text churn. */
      var totalSec = Math.ceil(ms / 1000);
      var h = Math.floor(totalSec / 3600);
      var m = Math.floor((totalSec % 3600) / 60);
      var s = totalSec % 60;
      if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
      return pad(m) + ':' + pad(s);
    }

    function formatStopwatchMs(ms) {
      /* Stopwatch shows tenths under one minute, MM:SS otherwise.
         Tenths only — hundredths are visual jitter at this scale. */
      var totalMs = Math.max(0, Math.floor(ms));
      var h = Math.floor(totalMs / 3600000);
      var m = Math.floor((totalMs % 3600000) / 60000);
      var s = Math.floor((totalMs % 60000) / 1000);
      var t = Math.floor((totalMs % 1000) / 100);
      if (h > 0)             return h + ':' + pad(m) + ':' + pad(s);
      if (m > 0 || s >= 10)  return pad(m) + ':' + pad(s);
      return pad(m) + ':' + pad(s) + '.' + t;
    }

    function ariaLabelFor(mode, ms, isRunning) {
      if (mode === 'timer') {
        var s = Math.ceil(ms / 1000);
        var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
        var parts = [];
        if (hh) parts.push(hh + ' hour' + (hh === 1 ? '' : 's'));
        if (mm) parts.push(mm + ' minute' + (mm === 1 ? '' : 's'));
        if (ss || !parts.length) parts.push(ss + ' second' + (ss === 1 ? '' : 's'));
        return (isRunning ? 'Timer running, ' : 'Timer paused, ') +
               parts.join(' ') + ' remaining';
      }
      if (mode === 'stopwatch') {
        var totalSec = Math.floor(ms / 1000);
        var hhh = Math.floor(totalSec / 3600);
        var mmm = Math.floor((totalSec % 3600) / 60);
        var sss = totalSec % 60;
        var p2 = [];
        if (hhh) p2.push(hhh + ' hour' + (hhh === 1 ? '' : 's'));
        if (mmm) p2.push(mmm + ' minute' + (mmm === 1 ? '' : 's'));
        p2.push(sss + ' second' + (sss === 1 ? '' : 's'));
        return (isRunning ? 'Stopwatch running, ' : 'Stopwatch paused, ') +
               p2.join(' ');
      }
      return '';
    }

    /* ── Mini Dial — momentum-based scrollable selector ───────────
       Replaces the fixed preset pills (1m / 5m / 10m / 25m) with a
       continuous, accessible scrubber styled to rhyme with the sun
       rail above it. The belt is wider than the track and translates
       under a fixed center needle; on settle the dial snaps to the
       nearest integer minute and commits via setDuration().

       Inputs to the dial value: pointer drag (with momentum), wheel,
       and keyboard. Reduced-motion users skip momentum and snap-anim
       and get a direct settle. The dial is inert while the timer is
       running — it becomes editable again on pause / reset.

       State invariant: dial.value is always an integer in [DIAL_MIN_MIN,
       DIAL_MAX_MIN]; translateX is derived. We never accumulate the
       value in float space.
     ────────────────────────────────────────────────────────────── */
    var dial = {
      el: null,
      track: null,
      belt: null,
      readout: null,
      hintEl: null,
      value: 5,
      trackWidth: 0,
      translateX: 0,
      isDragging: false,
      pointerId: null,
      startClientX: 0,
      startTranslateX: 0,
      velocity: 0,
      lastMoveAt: 0,
      lastMoveX: 0,
      rafHandle: null,
      resizeObserver: null,
      bound: false
    };

    function dialClampValue(v) {
      v = Math.round(v);
      if (!isFinite(v)) v = DIAL_MIN_MIN;
      if (v < DIAL_MIN_MIN) v = DIAL_MIN_MIN;
      if (v > DIAL_MAX_MIN) v = DIAL_MAX_MIN;
      return v;
    }

    function dialClampTranslate(tx) {
      var halfW = dial.trackWidth / 2;
      var txMax = halfW - DIAL_MIN_MIN * DIAL_STEP_PX; /* lowest value visible */
      var txMin = halfW - DIAL_MAX_MIN * DIAL_STEP_PX; /* highest value visible */
      if (tx > txMax) tx = txMax;
      if (tx < txMin) tx = txMin;
      return tx;
    }

    function dialTranslateForValue(v) {
      return (dial.trackWidth / 2) - v * DIAL_STEP_PX;
    }

    function dialValueFromTranslate(tx) {
      var v = ((dial.trackWidth / 2) - tx) / DIAL_STEP_PX;
      return dialClampValue(v);
    }

    function dialMeasure() {
      if (!dial.track) return;
      var rect = dial.track.getBoundingClientRect();
      dial.trackWidth = rect.width || 0;
    }

    function dialPaint() {
      if (!dial.el) return;
      dial.el.style.setProperty('--fc-dial-x', dial.translateX.toFixed(2) + 'px');
      dial.el.style.setProperty('--fc-dial-step', DIAL_STEP_PX + 'px');
      /* Fix the tick origin to the center so the value-1 tick visibly
         lands under the needle when translateX = halfW - step. */
      dial.el.style.setProperty('--fc-dial-origin', '0px');
      setAttr(dial.el, 'aria-valuenow', String(dial.value));
      setAttr(dial.el, 'aria-valuetext', dial.value + ' minute' + (dial.value === 1 ? '' : 's'));
      if (dial.readout) {
        setText(dial.readout, dial.value + ' min');
      }
    }

    function dialCancelAnim() {
      if (dial.rafHandle != null) {
        if (typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(dial.rafHandle); } catch (e) {}
        } else {
          try { clearTimeout(dial.rafHandle); } catch (e) {}
        }
        dial.rafHandle = null;
      }
    }

    function dialAnimateTo(targetTx) {
      dialCancelAnim();
      if (state.reducedMotion) {
        dial.translateX = targetTx;
        dialPaint();
        return;
      }
      var startTx = dial.translateX;
      var startedAt = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      function step(now) {
        var ts = (typeof now === 'number') ? now :
          (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
        var t = Math.min(1, (ts - startedAt) / DIAL_SNAP_MS);
        var eased = 1 - Math.pow(1 - t, 3);
        dial.translateX = startTx + (targetTx - startTx) * eased;
        dialPaint();
        if (t < 1 && state.mounted) {
          dial.rafHandle = requestAnimationFrame(step);
        } else {
          dial.rafHandle = null;
        }
      }
      dial.rafHandle = requestAnimationFrame(step);
    }

    function dialSettleToValue(animate) {
      var target = dialTranslateForValue(dial.value);
      if (animate && !state.reducedMotion) {
        dialAnimateTo(target);
      } else {
        dialCancelAnim();
        dial.translateX = target;
        dialPaint();
      }
    }

    function dialCommitValue(opts) {
      dialSettleToValue(!(opts && opts.silent));
      var ms = dial.value * 60 * 1000;
      if (state.mini.duration !== ms) setDuration(ms);
    }

    function dialSetValue(v, opts) {
      var clamped = dialClampValue(v);
      if (clamped === dial.value && !(opts && opts.force)) {
        dialSettleToValue(true);
        return;
      }
      dial.value = clamped;
      dialCommitValue(opts);
    }

    function dialOnPointerDown(e) {
      if (!dial.el) return;
      if (state.mini.isRunning) return; /* inert while running */
      try { dial.el.setPointerCapture(e.pointerId); } catch (_) {}
      dialMeasure();
      dialCancelAnim();
      dial.isDragging = true;
      dial.pointerId = e.pointerId;
      dial.startClientX = e.clientX;
      dial.startTranslateX = dial.translateX;
      dial.velocity = 0;
      dial.lastMoveAt = e.timeStamp || Date.now();
      dial.lastMoveX = e.clientX;
      setAttr(dial.el, 'data-dragging', 'true');
      e.preventDefault();
    }

    function dialOnPointerMove(e) {
      if (!dial.isDragging || e.pointerId !== dial.pointerId) return;
      var dx = e.clientX - dial.startClientX;
      var newTx = dialClampTranslate(dial.startTranslateX + dx);
      dial.translateX = newTx;

      /* Sample velocity in px-per-frame (≈ px/16ms). */
      var now = e.timeStamp || Date.now();
      var dt = now - dial.lastMoveAt;
      if (dt > 0 && dt < 250) {
        dial.velocity = ((e.clientX - dial.lastMoveX) / dt) * 16;
      }
      dial.lastMoveAt = now;
      dial.lastMoveX = e.clientX;

      var v = dialValueFromTranslate(newTx);
      if (v !== dial.value) dial.value = v;
      dialPaint();
    }

    function dialOnPointerUp(e) {
      if (!dial.isDragging) return;
      if (dial.pointerId != null && e.pointerId !== dial.pointerId) return;
      dial.isDragging = false;
      removeAttr(dial.el, 'data-dragging');
      try { dial.el.releasePointerCapture(dial.pointerId); } catch (_) {}
      dial.pointerId = null;

      if (Math.abs(dial.velocity) > DIAL_SETTLE_PX_PER_FRAME && !state.reducedMotion) {
        dialMomentumLoop();
      } else {
        dial.value = dialValueFromTranslate(dial.translateX);
        dialCommitValue();
      }
    }

    function dialMomentumLoop() {
      dialCancelAnim();
      function step() {
        if (!state.mounted) { dial.rafHandle = null; return; }
        dial.translateX = dialClampTranslate(dial.translateX + dial.velocity);
        dial.velocity *= DIAL_FRICTION;
        var v = dialValueFromTranslate(dial.translateX);
        if (v !== dial.value) dial.value = v;
        dialPaint();

        var hitEdge =
          dial.translateX === dialClampTranslate(dial.translateX + dial.velocity) ?
          false : true;
        if (Math.abs(dial.velocity) > DIAL_SETTLE_PX_PER_FRAME && !hitEdge) {
          dial.rafHandle = requestAnimationFrame(step);
        } else {
          dial.rafHandle = null;
          dialCommitValue();
        }
      }
      dial.rafHandle = requestAnimationFrame(step);
    }

    function dialOnWheel(e) {
      if (state.mini.isRunning) return;
      var d = (Math.abs(e.deltaX) > Math.abs(e.deltaY)) ? e.deltaX : e.deltaY;
      if (d === 0) return;
      e.preventDefault();
      var dir = d > 0 ? 1 : -1;
      var mag = Math.max(1, Math.min(5, Math.round(Math.abs(d) / 30)));
      dialSetValue(dial.value + dir * mag);
    }

    function dialOnKey(e) {
      if (state.mini.isRunning) return;
      var k = e.key, delta = 0;
      if (k === 'ArrowLeft' || k === 'ArrowDown')      delta = -1;
      else if (k === 'ArrowRight' || k === 'ArrowUp')  delta =  1;
      else if (k === 'PageDown')                       delta = -5;
      else if (k === 'PageUp')                         delta =  5;
      else if (k === 'Home') { e.preventDefault(); dialSetValue(DIAL_MIN_MIN); return; }
      else if (k === 'End')  { e.preventDefault(); dialSetValue(DIAL_MAX_MIN); return; }
      else return;
      e.preventDefault();
      dialSetValue(dial.value + delta);
    }

    function dialBuild() {
      var el = document.createElement('div');
      el.className = 'fc-dial';
      el.setAttribute('data-fc-mini-dial', '');
      el.setAttribute('role', 'slider');
      el.setAttribute('aria-label', 'Timer minutes');
      el.setAttribute('aria-valuemin', String(DIAL_MIN_MIN));
      el.setAttribute('aria-valuemax', String(DIAL_MAX_MIN));
      el.setAttribute('aria-orientation', 'horizontal');
      el.setAttribute('tabindex', '0');
      el.innerHTML =
        '<div class="fc-dial-track" data-fc-dial-track>' +
          '<div class="fc-dial-belt" data-fc-dial-belt></div>' +
          '<div class="fc-dial-needle" aria-hidden="true"></div>' +
        '</div>' +
        '<div class="fc-dial-readout">' +
          '<span class="fc-dial-value" data-fc-dial-readout>5 min</span>' +
          '<span class="fc-dial-hint" data-fc-dial-hint>Drag · scroll · arrows</span>' +
        '</div>';
      return el;
    }

    function dialBind(el) {
      if (dial.bound) return;
      dial.bound = true;
      dial.el = el;
      dial.track = qs('[data-fc-dial-track]', el);
      dial.belt = qs('[data-fc-dial-belt]', el);
      dial.readout = qs('[data-fc-dial-readout]', el);
      dial.hintEl = qs('[data-fc-dial-hint]', el);

      /* Sync initial value from the persisted timer duration. */
      dial.value = dialClampValue(Math.round((state.mini.duration || (5 * 60 * 1000)) / 60000));

      /* Track width may not be measurable until after layout; defer
         the first paint to after a microtask so the dial doesn't
         flash at the wrong position on mount. */
      dialMeasure();
      dialSettleToValue(false);
      requestAnimationFrame(function () {
        dialMeasure();
        dialSettleToValue(false);
      });

      if (typeof ResizeObserver === 'function') {
        try {
          dial.resizeObserver = new ResizeObserver(function () {
            if (!state.mounted) return;
            dialMeasure();
            dialSettleToValue(false);
          });
          dial.resizeObserver.observe(dial.track);
        } catch (_) {}
      }

      el.addEventListener('pointerdown',   dialOnPointerDown);
      el.addEventListener('pointermove',   dialOnPointerMove);
      el.addEventListener('pointerup',     dialOnPointerUp);
      el.addEventListener('pointercancel', dialOnPointerUp);
      el.addEventListener('lostpointercapture', dialOnPointerUp);
      el.addEventListener('wheel',         dialOnWheel, { passive: false });
      el.addEventListener('keydown',       dialOnKey);
    }

    function dialUnbind() {
      dialCancelAnim();
      if (dial.resizeObserver) {
        try { dial.resizeObserver.disconnect(); } catch (_) {}
      }
      dial.resizeObserver = null;
      dial.bound = false;
      dial.el = null;
      dial.track = null;
      dial.belt = null;
      dial.readout = null;
      dial.hintEl = null;
    }

    /* Sync dial when external code (mode flip, persistence restore,
       reset) changed the canonical duration. Idempotent. We re-measure
       on every sync because the dial may have been hidden until now —
       a 0-width track yields a meaningless translateX. */
    function dialSyncFromState() {
      if (!dial.el) return;
      var v = dialClampValue(Math.round((state.mini.duration || 0) / 60000));
      var changed = v !== dial.value;
      dial.value = v;
      dialMeasure();
      if (dial.trackWidth === 0) {
        /* Layout not ready yet — defer one frame and retry. */
        requestAnimationFrame(function () {
          if (!state.mounted || !dial.el) return;
          dialMeasure();
          dialSettleToValue(false);
        });
        return;
      }
      dialSettleToValue(changed);
    }

    /* ── DOM scaffold (built once per mount) ──────────────── */

    function ensureScaffold(face) {
      if (face.__fcMiniScaffolded) return qs('[data-fc-mini-card]', face);
      face.__fcMiniScaffolded = true;

      var card = document.createElement('div');
      card.className = 'fc-mini-card';
      card.setAttribute('data-fc-mini-card', '');
      card.setAttribute('data-fc-mini-mode', 'time');
      card.setAttribute('data-fc-mini-state', 'idle');

      /* Mode pills — segmented, role=tablist for AT clarity. */
      var tabs = document.createElement('div');
      tabs.className = 'fc-mini-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Clock mode');
      tabs.setAttribute('data-fc-mini-tabs', '');

      var modes = [
        { key: 'time',      label: 'Time'      },
        { key: 'timer',     label: 'Timer'     },
        { key: 'stopwatch', label: 'Stopwatch' }
      ];
      for (var i = 0; i < modes.length; i++) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fc-mini-tab';
        b.setAttribute('role', 'tab');
        b.setAttribute('data-fc-mini-tab', modes[i].key);
        b.setAttribute('aria-selected', modes[i].key === 'time' ? 'true' : 'false');
        b.setAttribute('tabindex', modes[i].key === 'time' ? '0' : '-1');
        b.textContent = modes[i].label;
        tabs.appendChild(b);
      }

      /* Stage — hosts readout, controls, and (for timer) presets. */
      var stage = document.createElement('div');
      stage.className = 'fc-mini-stage';
      stage.setAttribute('data-fc-mini-stage', '');

      var readout = document.createElement('div');
      readout.className = 'fc-mini-readout';
      readout.setAttribute('data-fc-mini-readout', '');
      readout.setAttribute('aria-live', 'off');
      readout.setAttribute('aria-atomic', 'true');
      readout.textContent = '';

      var controls = document.createElement('div');
      controls.className = 'fc-mini-controls';
      controls.setAttribute('data-fc-mini-controls', '');

      var btnStart = document.createElement('button');
      btnStart.type = 'button';
      btnStart.className = 'fc-mini-btn fc-mini-btn-primary';
      btnStart.setAttribute('data-fc-mini-action', 'toggle');
      btnStart.setAttribute('aria-pressed', 'false');
      btnStart.textContent = 'Start';

      var btnReset = document.createElement('button');
      btnReset.type = 'button';
      btnReset.className = 'fc-mini-btn';
      btnReset.setAttribute('data-fc-mini-action', 'reset');
      btnReset.textContent = 'Reset';

      controls.appendChild(btnStart);
      controls.appendChild(btnReset);

      /* The momentum dial replaces the preset-pill row. It sits
         alongside the readout / controls in the stage and is shown
         only in timer mode (controlled in render()). */
      var dialEl = dialBuild();

      stage.appendChild(readout);
      stage.appendChild(controls);
      stage.appendChild(dialEl);

      card.appendChild(tabs);
      card.appendChild(stage);

      /* Append after .fc-ambient-copy if present, else end of face. */
      var copy = qs('.fc-ambient-copy', face);
      if (copy && copy.nextSibling) {
        face.insertBefore(card, copy.nextSibling);
      } else {
        face.appendChild(card);
      }
      return card;
    }

    /* ── render ───────────────────────────────────────────── */

    function render() {
      var root = rootEl();
      if (!root) return;
      var face = qs('[data-fc-face]', root);
      if (!face) return;
      var card = ensureScaffold(face);
      if (!card) return;

      var m = state.mini;
      setAttr(card, 'data-fc-mini-mode', m.mode);

      /* Compute current state class — idle | running | paused | done. */
      var miniState;
      if (m.lastFinishedAt && (Date.now() - m.lastFinishedAt) < DONE_WINDOW_MS) {
        miniState = 'done';
      } else if (m.isRunning) {
        miniState = 'running';
      } else if (m.mode !== 'time' && (m.accumulated > 0)) {
        miniState = 'paused';
      } else {
        miniState = 'idle';
      }
      setAttr(card, 'data-fc-mini-state', miniState);

      /* Tab pressed states — single source of truth. */
      var tabs = qsa('[data-fc-mini-tab]', card);
      for (var i = 0; i < tabs.length; i++) {
        var key = tabs[i].getAttribute('data-fc-mini-tab');
        var sel = key === m.mode;
        setAttr(tabs[i], 'aria-selected', sel ? 'true' : 'false');
        setAttr(tabs[i], 'tabindex', sel ? '0' : '-1');
      }

      var readout = qs('[data-fc-mini-readout]', card);
      var btnToggle = qs('[data-fc-mini-action="toggle"]', card);
      var btnReset  = qs('[data-fc-mini-action="reset"]',  card);
      var dialEl    = qs('[data-fc-mini-dial]', card);

      /* Lazy-bind the dial — its track width can only be measured
         after the scaffold is in the document. */
      if (dialEl && !dial.bound) dialBind(dialEl);

      /* In time mode the stage stays calm and decorative. */
      if (m.mode === 'time') {
        setText(readout, '');
        setAttr(readout, 'aria-label', '');
        setAttr(readout, 'aria-live', 'off');
        if (btnToggle) {
          setText(btnToggle, 'Start');
          setAttr(btnToggle, 'aria-pressed', 'false');
          btnToggle.disabled = true;
        }
        if (btnReset) btnReset.disabled = true;
        if (dialEl)   dialEl.hidden = true;
        return;
      }

      /* Timer / Stopwatch readouts. */
      var ms = m.mode === 'timer' ? remainingMs() : elapsedMs();
      var label = m.mode === 'timer'
        ? formatTimerMs(ms)
        : formatStopwatchMs(ms);
      setText(readout, label);

      /* aria-live: announce only meaningful transitions. We flip from
         "off" to "polite" only at the moment the user interacts, then
         back. Per-frame paint never re-announces. */
      if (!m.hasPainted) {
        setAttr(readout, 'aria-live', 'off');
        setAttr(readout, 'aria-atomic', 'true');
        m.hasPainted = true;
      }
      setAttr(readout, 'aria-label', ariaLabelFor(m.mode, ms, m.isRunning));

      if (btnToggle) {
        setText(btnToggle, m.isRunning ? 'Pause' : (m.accumulated > 0 ? 'Resume' : 'Start'));
        setAttr(btnToggle, 'aria-pressed', m.isRunning ? 'true' : 'false');
        btnToggle.disabled = false;
      }
      if (btnReset) {
        btnReset.disabled = !m.isRunning && m.accumulated === 0;
      }
      if (dialEl) {
        dialEl.hidden = (m.mode !== 'timer');
        if (!dialEl.hidden) dialSyncFromState();
      }
    }

    /* ── rAF loop (only when needed) ──────────────────────── */

    function shouldAnimate() {
      var m = state.mini;
      return m.mode !== 'time' && m.isRunning && !document.hidden;
    }

    function loop() {
      state.mini.rafHandle = null;
      if (!state.mounted) return;

      /* Timer completion check first — avoids painting a "0:00" frame
         and then a separate "done" frame. */
      var m = state.mini;
      if (m.mode === 'timer' && m.isRunning && remainingMs() <= 0) {
        completeTimer();
        return;
      }

      render();

      if (shouldAnimate()) {
        scheduleFrame();
      }
    }

    function scheduleFrame() {
      if (state.mini.rafHandle != null) return;
      if (typeof requestAnimationFrame !== 'function') {
        /* Ancient fallback — unlikely to hit, but keeps the contract. */
        state.mini.rafHandle = setTimeout(loop, 100);
      } else {
        state.mini.rafHandle = requestAnimationFrame(loop);
      }
    }

    function cancelFrame() {
      if (state.mini.rafHandle != null) {
        if (typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(state.mini.rafHandle); } catch (e) {}
        } else {
          try { clearTimeout(state.mini.rafHandle); } catch (e) {}
        }
        state.mini.rafHandle = null;
      }
    }

    /* ── transitions ──────────────────────────────────────── */

    function setMode(next) {
      var m = state.mini;
      if (next !== 'time' && next !== 'timer' && next !== 'stopwatch') return;
      if (m.mode === next) return;
      /* Switching modes resets transient running state but keeps
         duration so the user's last timer setup survives mode flips. */
      cancelFrame();
      clearTail();
      m.mode = next;
      m.isRunning = false;
      m.startTime = null;
      m.accumulated = 0;
      m.lastFinishedAt = null;
      writePersisted();
      render();
    }

    function start() {
      var m = state.mini;
      if (m.mode === 'time') return;
      if (m.isRunning) return;
      if (m.mode === 'timer' && remainingMs() <= 0) {
        /* Restart from full duration on a stale completion. */
        m.accumulated = 0;
        m.lastFinishedAt = null;
      }
      m.isRunning = true;
      m.startTime = Date.now();
      writePersisted();
      scheduleFrame();
      render();
    }

    function pause() {
      var m = state.mini;
      if (!m.isRunning) return;
      m.accumulated += Date.now() - (m.startTime || Date.now());
      m.isRunning = false;
      m.startTime = null;
      cancelFrame();
      writePersisted();
      render();
    }

    function reset() {
      var m = state.mini;
      cancelFrame();
      clearTail();
      m.isRunning = false;
      m.startTime = null;
      m.accumulated = 0;
      m.lastFinishedAt = null;
      writePersisted();
      render();
    }

    function setDuration(ms) {
      var m = state.mini;
      var clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Number(ms) || 0));
      if (clamped === m.duration) return;
      m.duration = clamped;
      /* If timer was idle, applying a new duration also resets accumulated. */
      if (m.mode === 'timer' && !m.isRunning) {
        m.accumulated = 0;
        m.lastFinishedAt = null;
      }
      writePersisted();
      render();
    }

    function clearTail() {
      if (state.mini.tailTimer) {
        clearTimeout(state.mini.tailTimer);
        state.mini.tailTimer = null;
      }
    }

    function completeTimer() {
      var m = state.mini;
      cancelFrame();
      m.isRunning = false;
      m.startTime = null;
      m.accumulated = m.duration;
      m.lastFinishedAt = Date.now();
      writePersisted();

      /* Subtle visual feedback — completion is silent, regardless of
         DND. The CSS keys off data-fc-mini-state="done". */
      render();

      clearTail();
      state.mini.tailTimer = setTimeout(function () {
        if (!state.mounted) return;
        /* Settle back to idle and reset accumulated so re-running is
           a single tap. */
        m.lastFinishedAt = null;
        m.accumulated = 0;
        writePersisted();
        render();
      }, DONE_WINDOW_MS);
    }

    /* Called from the per-minute clock tick — keeps the time-mode
       footer synced and (when paused) keeps timer/stopwatch readouts
       fresh once a minute even without a rAF loop. */
    function onClockTick(/* now */) {
      if (!state.mounted) return;
      /* Only repaint if the card is in a static-but-displayed state. */
      var m = state.mini;
      if (m.mode === 'time' || !m.isRunning) {
        render();
      }
    }

    function onVisibilityChange() {
      if (!state.mounted) return;
      if (document.hidden) {
        /* Pause the rAF; keep state running. Math is timestamp-based,
           so when the tab returns the readout snaps back accurate. */
        cancelFrame();
        return;
      }
      var m = state.mini;
      /* On return: if timer already crossed zero in the background,
         complete now (silent visual). */
      if (m.mode === 'timer' && m.isRunning && remainingMs() <= 0) {
        completeTimer();
        return;
      }
      if (shouldAnimate()) scheduleFrame();
      render();
    }

    /* ── event binding ─────────────────────────────────────── */

    function bind(card) {
      if (card.__fcMiniBound) return;
      card.__fcMiniBound = true;

      card.addEventListener('click', function (event) {
        var t = event.target;
        if (!t || !t.closest) return;

        var tab = t.closest('[data-fc-mini-tab]');
        if (tab && card.contains(tab)) {
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          setMode(tab.getAttribute('data-fc-mini-tab'));
          return;
        }

        /* Stop event bubbling for dial interactions so the parent
           face-click-to-toggle-details handler doesn't double-fire. */
        if (t.closest('[data-fc-mini-dial]')) {
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          return;
        }

        var action = t.closest('[data-fc-mini-action]');
        if (action && card.contains(action)) {
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          var k = action.getAttribute('data-fc-mini-action');
          if (k === 'toggle') {
            if (state.mini.isRunning) pause(); else start();
          } else if (k === 'reset') {
            reset();
          }
          return;
        }
      });

      /* Tablist keyboard model: ←/→ moves selection, Home/End jump. */
      card.addEventListener('keydown', function (event) {
        var t = event.target;
        if (!t || !t.closest) return;
        var tab = t.closest('[data-fc-mini-tab]');
        if (!tab || !card.contains(tab)) return;

        var keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (keys.indexOf(event.key) === -1) return;
        event.preventDefault();
        var tabs = qsa('[data-fc-mini-tab]', card);
        var idx = tabs.indexOf(tab);
        var nextIdx = idx;
        if (event.key === 'ArrowLeft')  nextIdx = (idx - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
        if (event.key === 'Home') nextIdx = 0;
        if (event.key === 'End')  nextIdx = tabs.length - 1;
        var nextTab = tabs[nextIdx];
        if (nextTab) {
          setMode(nextTab.getAttribute('data-fc-mini-tab'));
          try { nextTab.focus(); } catch (e) {}
        }
      });
    }

    /* ── lifecycle ─────────────────────────────────────────── */

    function mount() {
      var m = state.mini;
      var saved = readPersisted();
      if (saved) {
        m.mode = saved.mode;
        m.duration = saved.duration;
        m.accumulated = saved.accumulated;
        /* Only restore running state if the gap is plausibly
           continuous. Browser refresh, SPA nav, or quick tab return
           all fit comfortably under 10 minutes; anything longer is
           safer to surface as "paused" so the user opts in again. */
        var gap = saved.ts ? (Date.now() - saved.ts) : Infinity;
        if (saved.phase === 'running' && gap >= 0 && gap < RUN_RESTORE_GRACE_MS) {
          if (m.mode === 'timer') {
            var rolled = saved.accumulated + gap;
            if (rolled >= m.duration) {
              m.accumulated = m.duration;
              m.lastFinishedAt = Date.now();
              m.isRunning = false;
            } else {
              m.accumulated = rolled;
              m.startTime = Date.now();
              m.isRunning = true;
            }
          } else if (m.mode === 'stopwatch') {
            m.accumulated = saved.accumulated + gap;
            m.startTime = Date.now();
            m.isRunning = true;
          }
        } else {
          /* Stale running state — degrade to paused with the work preserved. */
          m.isRunning = false;
          m.startTime = null;
        }
      }

      var root = rootEl();
      if (!root) return;
      var face = qs('[data-fc-face]', root);
      if (!face) return;
      var card = ensureScaffold(face);
      if (card) bind(card);

      render();
      if (shouldAnimate()) scheduleFrame();
    }

    function unmount() {
      cancelFrame();
      clearTail();
      dialUnbind();
      /* Retain mode + duration in memory so re-mount paints continuous,
         but don't keep ticking. */
    }

    return {
      mount: mount,
      unmount: unmount,
      onClockTick: onClockTick,
      onVisibilityChange: onVisibilityChange,
      /* Exposed for diagnostics / external triggers; not part of CE_AMBIENT. */
      _internals: {
        setMode: setMode,
        start: start,
        pause: pause,
        reset: reset,
        setDuration: setDuration
      }
    };
  })();

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
      rememberGoodState();
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
        rememberGoodState();
        renderWeather();
        renderStatus();
      })
      .catch(function (err) {
        if (state.pendingKey !== key) return;
        if (err && err.name === 'AbortError') return;
        /* Keep last-known-good on failure; only surface error if empty. */
        if (!state.weather) {
          restoreLastGoodState(err);
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

  /* ── Preset location + details controls ───────────────────── */

  function setLocationByKey(key) {
    var nextKey = LOCATIONS[key] ? key : LOCATION_ALIASES[key];
    var next = LOCATIONS[nextKey] || DEFAULT_LOCATION;
    if (state.location && state.location.key === next.key) return;
    rememberGoodState();
    state.location = next;
    state.preferences.location = next.key;
    state.weather = null;
    state.weatherError = null;
    writePreferences({ location: next.key });
    abortPendingFetch();
    renderClock();
    renderWeather();
    renderStatus();
    loadWeather(true);
  }

  function setDetailsOpen(open) {
    state.detailsOpen = !!open;
    writePreferences({ detailsOpen: state.detailsOpen });
    renderWeather();
    renderStatus();
    setTimeout(function () {
      if (state.mounted) renderStatus();
    }, 0);
  }

  function setHour24(hour24) {
    state.preferences.hour24 = !!hour24;
    writePreferences({ hour24: state.preferences.hour24 });
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

    var detailsBtn = qs('[data-fc-details-toggle]', root);
    if (detailsBtn) {
      detailsBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        setDetailsOpen(!state.detailsOpen);
      });
    }

    root.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-fc-details-toggle]')) {
        setDetailsOpen(!state.detailsOpen);
        return;
      }
      if (t.closest('[data-fc-time-format]')) {
        setHour24(!state.preferences.hour24);
        return;
      }
      /* Mini Card lives inside .fc-face. Its own handler stopped
         propagation, but in case anything bubbles, swallow here so the
         face-click-to-open-details affordance doesn't double-fire. */
      if (t.closest('[data-fc-mini-card]')) return;
      if (t.closest('[data-fc-face]') || t.closest('[data-fc-weather]') ||
          t.closest('[data-fc-sun]')) {
        setDetailsOpen(!state.detailsOpen);
        return;
      }
      if (t.closest('[data-fc-refresh]')) { loadWeather(true); return; }
    });

    root.addEventListener('change', function (event) {
      var t = event.target;
      if (t && t.matches && t.matches('[data-fc-location-select]')) {
        setLocationByKey(t.value);
      }
    });
  }

  /* Visibility handler is bound once — it no-ops when unmounted. */
  function handleVisibility() {
    /* Mini Card cares about both directions of the visibility flip
       (pause its rAF when hidden, snap back when visible). */
    MiniCard.onVisibilityChange();
    if (document.hidden) return;
    if (!state.mounted) return;
    /* Returning to the tab: resync the clock face *now* and give the
       weather a quiet chance to refresh if it is stale. */
    renderClock();
    loadWeather(false);
  }

  function handleAmbientAttributeChange() {
    if (!state.mounted) return;
    state.DND = readDnd();
    writePreferences({ DND: state.DND });
    renderClock();
  }

  /* ── Lifecycle ───────────────────────────────────────────── */

  function mount() {
    var root = rootEl();
    if (!root) {
      /* Page doesn't expose the ambient surface — go inert. */
      teardownTimers();
      abortPendingFetch();
      MiniCard.unmount();
      SunCycleCard.unmount();
      removeAttr(document.documentElement, 'data-phase');
      removeAttr(document.documentElement, 'data-clock-phase');
      removeAttr(document.documentElement, 'data-weather');
      removeAttr(document.documentElement, 'data-location');
      removeAttr(document.documentElement, 'data-dnd');
      state.mounted = false;
      return;
    }

    /* Restore local preferences — safe to re-run on SPA navigations. */
    state.preferences = readPreferences();
    state.location = LOCATIONS[state.preferences.location] || DEFAULT_LOCATION;
    state.detailsOpen = !!state.preferences.detailsOpen;
    state.DND = readDnd();
    state.reducedMotion = prefersReducedMotion();
    document.documentElement.removeAttribute('data-ambient');

    state.mounted = true;

    /* First-paint order matters: paint the clock before loading weather
       so the sanctuary is legible even if the network is slow. */
    renderClock();
    renderWeather();
    renderStatus();
    /* Mini Card mounts after the clock has painted so its scaffold
       slots into a settled .fc-face — no layout shift on first paint. */
    MiniCard.mount();
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
    /* Tear down the additive subsystems before the clock root may be
       swapped out by the SPA shell. They retain memory state but
       release timers, rAF, and DOM pointers. */
    MiniCard.unmount();
    SunCycleCard.unmount();
    removeAttr(document.documentElement, 'data-phase');
    removeAttr(document.documentElement, 'data-clock-phase');
    removeAttr(document.documentElement, 'data-weather');
    removeAttr(document.documentElement, 'data-location');
    removeAttr(document.documentElement, 'data-dnd');
  }

  /* ── Global bindings (once) ──────────────────────────────── */

  document.addEventListener('visibilitychange', handleVisibility);
  if (typeof MutationObserver === 'function') {
    var ambientObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === 'data-mode' || mutations[i].attributeName === 'data-motion') {
          handleAmbientAttributeChange();
          break;
        }
      }
    });
    ambientObserver.observe(document.documentElement, { attributes: true });
  }

  /* ── Expose public API ───────────────────────────────────── */

  window.CE_AMBIENT = {
    mount: mount,
    unmount: unmount,
    refresh: function () { loadWeather(true); },
    setLocation: setLocationByKey,
    setDetailsOpen: setDetailsOpen,
    getState: function () {
      return {
        location: state.location,
        detailsOpen: state.detailsOpen,
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
