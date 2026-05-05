# Fountain Clock — Mini Card + Sun Cycle Refactor (v1.0 Implementation Prompt)

> Status: Draft v1.0 · Target: `chancelloredwards.dev` · Owner: Fountain Clock subsystem
> Companion docs: `ARCHITECTURE-fountain-clock.md`, `news-refactor-v1.1-prompt.md`

## Goal in one line
Teach the Fountain Clock two new skills — Timer and Stopwatch — and quietly clarify the sunrise/sunset rail, without changing how the clock looks or feels at first glance.

## Before writing any code — discover the ground truth
Open the repo and confirm the following before changing anything:

1. How `js/fountain-clock.js` mounts, ticks, and exposes `window.CE_AMBIENT` (mount/unmount lifecycle, SPA re-binding).
2. The current DOM contract for the clock face, the inner orb, and the sun rail (`.fc-sun`, `[data-fc-sun]`, `[data-fc-sunrise]`, `[data-fc-sunset]`, `.fc-sun-rail`, `.fc-sun-dot`).
3. How tokens flow through `css/tokens.css` and `css/styles.css` — phase tints, ambient warmth/light, `--fc-sun-x`. v1.0 must reuse these, not invent new ones.
4. Which neighboring systems share state with the clock or piggyback on its tick: weather, news, DND, vinyl/audio, SPA shell.
5. Where local persistence already lives (if anywhere) so the mini-card's `localStorage` keys don't collide.

Write a short note summarizing what was found before proposing the implementation. Do not refactor blind.

## Implementation principle (north star)
The Fountain Clock must feel unchanged at first glance — only more capable over time. The Mini Card and Sun Cycle should behave like quiet intelligence layered into an already trusted system, not new features competing for attention.

This is a **functional enhancement, not a redesign.**

---

## Global constraints (non-negotiable)

Preserve 100% of the existing UI: colors, typography, spacing, layout, dimensions, visual hierarchy, ambient behavior.

Do not modify: navigation, hero structure, weather system, news surface, DND system, vinyl/audio system, SPA shell behavior.

No layout shift. No DOM destruction or recreation of the Fountain Clock root. All enhancements must be additive, minimal, and reversible.

JavaScript owns state; CSS owns atmosphere via `data-*` attributes.

---

## Part 1 — Clock Mini Card system

### Concept
Introduce a polymorphic mini-card controller embedded within the existing clock that supports three modes:

- `time` (default)
- `timer`
- `stopwatch`

The feature must feel like *"the Fountain Clock quietly learned a new skill."*

### State model — single source of truth

```js
ClockMiniCardState = {
  mode: 'time' | 'timer' | 'stopwatch',
  isRunning: boolean,
  startTime: number | null,
  elapsed: number,
  duration: number | null,
  remaining: number | null,
  lastUpdated: number,
}
```

### Behavior

**General**
- Default mode: `time`.
- Switching modes must not re-render or remount the Fountain Clock — only update text nodes, ARIA attributes, and `data-*` attributes.
- Use drift-corrected time math (timestamp deltas, not naive `setInterval` accumulation).

**Timer**
- Set duration · Start · Pause · Reset · Completion state.
- On completion: respect DND (no sound). Subtle visual feedback only — express completion through the existing design language, not a new visual element.

**Stopwatch**
- Start · Pause · Reset.
- Optional laps, only if they introduce zero visual clutter. If they don't fit cleanly, skip them.

### Rendering rules
- Drive updates via `requestAnimationFrame` or timestamp-delta correction.
- Update only text nodes, ARIA attributes, and `data-*` attributes.
- Never trigger full component reflow. Never replace DOM nodes.

### UI integration
- The existing time display remains dominant.
- The inner orb represents mode subtly — through behavior, motion, and state shifts within the existing design language. No new visual elements.

### Persistence (`localStorage`)
Persist only:
- `mode`
- `timer duration`
- Running state, only when safe to restore.

Always degrade to `time` mode on any parse failure or schema mismatch. Namespace the key under the existing clock prefix to avoid collisions.

### Resilience
Handle gracefully:
- Tab switching (`visibilitychange`)
- SPA navigation (re-bind via existing `mount()` / `unmount()`)
- Reloads
- Background throttling

Failure behavior: fall back to stable `time` mode immediately, with no visual break.

### Accessibility
- Semantic controls (`<button>`).
- `aria-pressed` for toggles.
- `aria-live="polite"` for meaningful updates only — never tick-by-tick.
- Full keyboard support, including focus visibility consistent with the rest of the site.

---

## Part 2 — Sun Cycle Card (sunrise/sunset refactor)

### Concept
Isolate the sunrise/sunset rail into a self-contained module:

```js
SunCycleCard
```

This is a data and rendering refinement, not a UI change.

### Scope
- `.fc-sun`
- `[data-fc-sun]`
- `[data-fc-sunrise]`
- `[data-fc-sunset]`
- `.fc-sun-rail`
- `.fc-sun-dot`

### State contract

```js
SunCycleState = {
  now,
  timezone,
  latitude,
  longitude,
  sunrise,
  sunset,
  sunProgress,        // 0–1
  phase,              // night | dawn | day | dusk
  nextEvent,          // sunrise | sunset
  daylightDuration,
  status,             // ok | fallback
}
```

### Derived logic
- Clamp `sunProgress` between `0` and `1`.
- Before sunrise → `0`.
- After sunset → `1`.
- During day → normalized progression.

### Rendering
- Expose progress as a CSS variable: `--sun-progress`.
- Move `.fc-sun-dot` along the rail using this value.
- No animation loops beyond the existing clock tick.

### UX enhancements (non-disruptive)
Only if they introduce no layout shift, add a secondary line:
- *"Next: Sunset at 7:42 PM"*, **or**
- *"Daylight: 13h 12m"*

Pick one — whichever reads more calmly in context. Do not stack both.

### Accessibility
- `<time>` elements for sunrise and sunset.
- Rail carries a descriptive label.
- `aria-live="polite"` only for meaningful transitions (phase change, next-event flip), never for sub-minute drift.

### Data ownership
- `SunCycleCard` consumes state. It never fetches and never owns global state.
- The Fountain Clock remains the single source of truth.

### Failure handling
If data is missing: preserve UI structure, show fallback text, keep the rail visually stable. Never collapse the rail to zero height.

---

## Performance rules (critical)
No layout thrashing. No unnecessary reflows. No redundant renders. No timers that drift. Zero memory leaks.

Every `setInterval`/`requestAnimationFrame`/event listener added must have a matching teardown path through the existing `unmount()` lifecycle.

---

## Acceptance criteria

**Visual integrity**
- UI is identical before any interaction.
- No layout shift.
- No added clutter.

**Functional integrity**
- Time mode remains accurate and dominant.
- Timer and Stopwatch are reliable, precise, and non-intrusive.

**System integrity**
- No regression in weather, DND, audio player, SPA navigation, or news system.

**Architectural integrity**
- Fully removable without breaking the parent system.
- Strict state isolation.
- Minimal surface-area changes to existing files.

---

## Versioning
- v1.0 — this document. Mini Card (`time` / `timer` / `stopwatch`) + Sun Cycle Card extraction.
- Future versions reserved for: lap support if it earns its space, alarm mode, and a richer `phase` palette tied to weather.

## Definition of done
A reviewer landing on `chancelloredwards.dev` should not notice anything has changed — until they look closer, find the mini-card affordance, and discover the clock now keeps timers too. The sun rail should read more clearly without anyone being able to point to what moved.
