# Fountain Clock — Mini Card v1.0 · Ground-truth notes

> Recon pass before any code changes. Pairs with
> `fountain-clock-minicard-v1.0-prompt.md` and the existing
> `ARCHITECTURE-fountain-clock.md`.

## What's already here

**Module shape.** `js/fountain-clock.js` is a single IIFE, exposes
`window.CE_AMBIENT` with `mount()` / `unmount()` / `refresh()` /
`setLocation()` / `setDetailsOpen()` / `getState()`. Auto-mounts on
`DOMContentLoaded`; `js/shell.js:306–308` re-calls `mount()` after every
SPA swap. `mount()` is idempotent — it tears down its own timers and
rebinds against the fresh DOM node. Unmount clears `tickTimer`,
`refetchTimer`, aborts pending fetches, strips `data-phase` /
`data-clock-phase` / `data-weather` / `data-location` / `data-dnd`
from `<html>`. Anything new must dock into this lifecycle.

**DOM contract (lives in `index.html` hero, lines 237–286).**

```
.fountain-clock[data-fountain-clock][data-fc-details]
├─ .fc-face[data-fc-face]
│  ├─ .fc-time[data-fc-time]            ← dominant wall-clock readout
│  │  └─ .fc-time-hm[data-fc-time-hm]
│  ├─ .fc-meta                          ← date · location · weather line
│  └─ .fc-ambient-copy[data-fc-note]    ← italic microcopy, role=status
├─ .fc-sun[data-fc-sun]
│  ├─ .fc-sun-rail / .fc-sun-dot
│  └─ .fc-sun-labels (sunrise / sunset <time> elements)
├─ .fc-weather[data-fc-weather]         ← scaffolded once by JS
└─ .fc-status (.fc-phase, .fc-zone, .fc-asof, controls)
```

**Token flow.** `css/tokens.css` declares `--fc-sun-x` (default `50%`),
`--ambient-warmth`, `--ambient-light`. The clock writes `--fc-sun-x`
on the `.fountain-clock` root; CSS consumes it on `.fc-sun-rail` (gradient
stop) and `.fc-sun-dot` (left position). `data-clock-phase` / `data-phase`
/ `data-weather` / `data-mode="dnd"` / `data-motion` / `data-location` /
`data-dnd` on `<html>` drive the tints. v1.0 must reuse these — no new
phase tokens, no new color systems.

**Persistence under `fc:` prefix already exists.**

| Key                 | Owner                           |
|---------------------|---------------------------------|
| `fc:weather:LL:LL`  | weather SWR cache               |
| `fc:preferences:v2` | JSON: location, DND, details, hour24 |
| `fc:location`       | preset key                      |
| `fc:details`        | open/closed                     |
| `fc:time-format`    | `12` / `24`                     |
| `ce-mode`           | DND mode (owned by `refined.js`)|

Mini Card adds `fc:mini:v1` — namespaced under `fc:`, no collisions.

**Tick.** `scheduleTick()` aligns to wall-clock seconds (`60000 - sec*1000 - ms`)
so the minute display flips crisp. `visibilitychange` re-syncs on tab focus.
A second drift-corrected loop is needed for sub-second readouts (timer /
stopwatch); it must be `rAF`-driven and live only while running.

**Neighbors that share state.** `refined.js` (`CE_APPEARANCE`) owns DND;
clock reads it via `data-mode="dnd"` on `<html>` and a `MutationObserver`
on attributes. `news-surface.js` is independent. `vinyl.js` is DND-scoped
but doesn't talk to the clock. None of them tap the clock tick — adding
sub-second loops won't affect them.

**Sun rail today.** Position is computed inside `renderClock()` via
`solarTimes()` and written as `--fc-sun-x`. Phase classifier uses a
45-minute shoulder. Sunrise/sunset times come from local NOAA-style
calc, with daily.sunrise/sunset from Open-Meteo as a higher-confidence
override when weather is present. No isolation — the sun render is
inlined into `renderClock`. SunCycleCard's job is to consume that state,
not to redo the math.

## Decisions that fall out of recon

1. **Mini Card lives inside `.fc-face`.** Scaffold built once by JS,
   appended after `.fc-ambient-copy`. Three mode pills + a stage that
   shows readout + controls in timer/stopwatch modes. The dominant
   `.fc-time` is *never* repurposed — it always shows wall-clock time.
   The stage uses smaller mono type, lower visual weight, and shares
   chip styling with the existing controls so it reads as part of the
   already-trusted system.

2. **No layout shift.** Mini-card stage reserves a single-row min-height
   from first paint. Mode swaps update text + `data-fc-mini-mode`
   only. In `time` mode the stage stays compositionally present but
   visually quiet (the existing ambient copy stays where it is, the
   mini affordance reads like a soft footer).

3. **Drift math.** `Date.now()` deltas; `rAF` for paint; `setTimeout(0)`
   only as a fallback when the tab is hidden. Stopwatch elapsed and
   timer remaining are derived from `startTime + accumulated` — never
   from a counter that increments per frame.

4. **Completion.** Timer hitting zero swaps `data-fc-mini-state="done"`
   for ~6 seconds; CSS gives a soft pulse via the existing breathe
   keyframes. No sound regardless of DND. After 6 s it falls back to
   `idle` with the duration restored, so re-running is one tap.

5. **Persistence.** `fc:mini:v1` — JSON `{ mode, duration, phase, ts,
   accumulated }`. Running state is restored only when `now - ts` is
   plausibly continuous (< 10 minutes). On any parse failure, schema
   mismatch, or stale running state → fall back to `time`.

6. **SunCycleCard** is a renderer, not a fetcher. It consumes the
   `(now, location, weather?.daily)` triple already produced by the
   clock and exposes `--sun-progress` (alongside the existing
   `--fc-sun-x` for back-compat). Adds a single calm secondary line:
   "Next: Sunset at 7:42 PM" — picked over "Daylight: 13h 12m" because
   it changes meaningfully across the day and reads like time of day,
   not a stat.

7. **Teardown.** Every new timer (`rAF` handle, `setTimeout`,
   `addEventListener`) routes through `teardownTimers()` and
   `unmount()`. The Mini Card stores its `rAF` handle on the same
   `state` namespace so tab switch + SPA nav cleans up exactly once.

## Acceptance posture

UI on cold load is identical to today. The mini-card pills are the
only new pixels and they read as muted footer chips inside the face.
Switching to Timer or Stopwatch reveals readout + controls inline —
still inside the face, no card destruction, no DOM thrash. Sun rail
gains one short secondary line; nothing moves.
