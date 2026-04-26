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
    lastGood: null
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

    if (solar.sunrise) {
      setText(qs('[data-fc-sunrise]', root), formatHM(solar.sunrise, state.location.tz, state.preferences.hour24));
      setText(qs('[data-fc-sunset]',  root), formatHM(solar.sunset, state.location.tz, state.preferences.hour24));
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
