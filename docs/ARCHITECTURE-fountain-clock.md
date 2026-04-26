# Fountain Clock — architecture note

> A calm, always-on ambient layer that weaves local time, sunrise/sunset,
> current weather, and near-term forecast into a single surface on the
> landing page. Designed to feel like a window left open, not a dashboard.

---

## Shape of the system

Three files carry the weight:

- `js/fountain-clock.js` — the ambient-state module. Self-contained IIFE,
  exposes `window.CE_AMBIENT` with `mount()` / `unmount()` so the SPA
  shell can re-bind after DOM swaps.
- `css/tokens.css` — adds `--ambient-warmth`, `--ambient-light`, and
  `--fc-sun-x` defaults; introduces phase (`[data-phase]`) and weather
  (`[data-weather]`) tint layers that modulate the existing ambient
  glow tokens without touching the base palette.
- `css/styles.css` — adds the `.fountain-clock` component (clock face,
  sun rail, weather block, forecast, status row) after the `.hero`
  section. All styling goes through design tokens.

The HTML surface lives inside `index.html`'s hero, marked with
`data-fountain-clock`. On any other page (`notes.html`, `playground.html`),
the module stays inert — no timers, no fetches, no DOM mutations. The
script tag is present on every real page so the module is available
after SPA navigation.

## Time

`Intl.DateTimeFormat` with the browser's default timezone. The clock
ticks once per minute, aligned to the next `:00` second so displayed
minutes are crisp. `visibilitychange` re-syncs on tab focus so a
long-backgrounded tab catches up instantly.

DST is handled for free — the formatter respects the system zone. Solar
computations run in UTC epoch milliseconds and are locale-agnostic.

## Sun

Sunrise, sunset, and day-fraction are computed locally using an
NOAA-style solar-position approximation (≤ 1 min accuracy at temperate
latitudes, polar day/night safely clamped). No extra network call.

The day-fraction drives the sun dot's horizontal position on the rail
via a CSS custom property (`--fc-sun-x`). The phase (`dawn`, `day`,
`dusk`, `night`) is written as `data-phase` on `<html>` and consumed by
CSS to shift the ambient glow.

Phase windows: 45 minutes on either side of sunrise/sunset are tagged
`dawn` / `dusk`. Everything else is `day` or `night`.

## Weather

Single provider: **Open-Meteo**
(`https://api.open-meteo.com/v1/forecast`).

Chosen because:

- No API key, no account, no billing surface.
- Generous free tier, no rate limit for low-traffic personal sites.
- Clean JSON, WMO weather codes, Fahrenheit-friendly units.
- Privacy-respecting — no tracking, no ad stack.

Request shape:

```
?latitude=…&longitude=…
&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m
&hourly=temperature_2m,weather_code,is_day
&temperature_unit=fahrenheit&wind_speed_unit=mph
&forecast_days=1&timezone=auto
```

Forecast display samples the next three 2-hour-spaced hourly slots so
the strip feels paced rather than dense.

## Cache strategy

Stale-while-revalidate in local storage, mirrored to `sessionStorage`
for fast same-tab reads:

- **Current conditions:** fresh for 10 minutes.
- **Forecast:** bundled with current; the same 10-minute SWR window
  applies, with a 1-hour ceiling before forcibly refetching.
- **Cache key:** coordinates rounded to ~1 km (`lat.toFixed(2)`) so
  moving slightly doesn't balloon entries.
- **On mount:** any cached data renders immediately to prevent flash;
  a background refresh kicks off if the cache is stale.
- **On failure:** the last-known-good cached entry is preserved and the
  "As of" marker shows the original fetch time.
- **Background tabs** skip the scheduled refetch to avoid quietly
  hammering the API while the user isn't looking.

## Location Model

Fountain Clock uses the immutable `CITY_PRESETS` list as its location
source of truth:

- New Orleans, Louisiana
- Houston, Texas (default)
- Dallas, Texas
- Williamsburg, Kentucky
- Baton Rouge, Louisiana
- New York, New York
- Los Angeles, California

The selected preset is stored in `localStorage` under `fc:location`.
No geolocation, IP lookup, account data, or personal location data is
requested or stored.

## Fallback chain

1. Stored preset location from this browser.
2. Cached weather for that location.
3. Default location: **Houston, Texas**.
4. If the weather API fails and no cache exists, the clock restores the
   last known good location state when possible; the clock and sun rail
   continue to work — the core view never goes blank.

## Privacy & safety

- No geolocation prompts, no IP geolocation, no fingerprinting, no
  third-party scripts.
- Only a preset city key is persisted locally. No coordinates from the
  user, cookies, or server round-trip.
- No analytics or tracking hooks.

## Performance

- Module weight: ~14 KB unminified, ~5 KB gzip-equivalent.
- Zero layout shift — skeletons reserve final layout heights via
  `min-height` and fixed grids.
- Only GPU-friendly properties animate (opacity, transform, background
  gradient transitions).
- Time ticks once per minute; weather polls at most once per 10 minutes
  while the tab is visible.
- First paint shows cached data when available; otherwise skeletons
  populate in-place the moment the API responds.

## Escape hatches

Three pressure valves, in increasing order of restraint:

1. **Reduced motion** — all animations/transitions collapse to 1 ms
   under `prefers-reduced-motion: reduce` or the site's own
   `data-motion="reduced"`.
2. **Details reveal** — a light tap/click expands humidity, wind, and
   near-term forecast context without replacing the primary clock.
3. **DND mode** — the site-wide "Do Not Disturb" palette. The
   fountain clock still shows time and weather but the phase/weather
   tints are suppressed via `:not([data-mode="dnd"])` guards so the
   refined palette reads clean. Vinyl player behavior is unchanged.

All three can be active at once; none fight.

## DND relationship

DND logic is untouched. It still lives in `js/refined.js`
(`CE_APPEARANCE.applyMode`) and is the single source of truth. The
fountain clock layer *reads* DND state via CSS (`[data-mode="dnd"]`)
but never writes to it. The vinyl player remains DND-scoped, and its
fixed bottom-right position doesn't overlap the hero-embedded clock.

## Edge cases covered

| Case | Behavior |
|------|----------|
| First load, online | Skeleton → live data, no layout shift. |
| First load, offline | Skeleton → "Weather unavailable", clock/sun still work. |
| Warm load, fresh cache | Cached data renders instantly, no refetch. |
| Warm load, stale cache | Cached data renders instantly, silent refetch. |
| Location changed | Preset city persists locally and aborts stale fetches. |
| Timezone / DST transitions | `Intl.DateTimeFormat` absorbs them. |
| Polar day / polar night | Solar calc clamps cleanly (no NaN). |
| Day/night crossings while open | Phase attribute updates on the next minute tick. |
| Tab backgrounded | Refetch loop pauses; `visibilitychange` catches up on return. |
| SPA navigation away | `mount()` tears down timers, clears phase/weather attrs. |
| SPA navigation back | `mount()` rebinds against the fresh DOM node. |
| Reduced motion | All animations and transitions collapse to 1 ms. |
| DND on | Palette suppresses phase/weather tints; clock still reads cleanly. |
| Details open | Secondary weather context appears without replacing time. |

## Trade-offs

- **Minutes only, no seconds.** A second hand is the hallmark of a
  productivity clock; here it's a distraction. A 9-second opacity
  breathe on the minute display signals liveness without motion noise.
- **Preset city storage, not personal location.** The product needs a
  remembered city but not the user's exact whereabouts.
- **No IP or browser geolocation provider.** Every guessed location adds
  a dependency or a surveillance surface. Houston, Texas is the default,
  and the user can switch among the curated presets.
- **Subtle phase tints over dramatic ones.** The calmest day looks
  like the loudest day with ±10% glow intensity. A louder design would
  compete with reading the page.
- **One upstream, not an abstraction.** Wrapping a second provider now
  would be speculative. If Open-Meteo ever changes, the normalizer in
  `normalizeWeather` is the only substitution point.

## File-level changes

```
 css/tokens.css                ± ambient vars + phase/weather tokens
 css/styles.css                + .fountain-clock component styles
 js/fountain-clock.js          + new ambient-state module
 js/shell.js                   ± PERSIST_SCRIPTS + CE_AMBIENT.mount hook
 index.html                    ± fountain-clock hero markup + preset selector + <script>
 notes.html                    + <script> for ambient module
 playground.html               + <script> for ambient module
 ARCHITECTURE-fountain-clock.md  (this file)
```

## How to disable or remove

- **Disable permanently:** remove the `<section data-fountain-clock>` block
  from `index.html`. The module auto-detects its absence and stays inert.
- **Full removal:** delete `js/fountain-clock.js`, unregister from
  `PERSIST_SCRIPTS`, drop the `<script>` tags, and the fountain-clock
  CSS sections. Nothing else in the codebase depends on it.
