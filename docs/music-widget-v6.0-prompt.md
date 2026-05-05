# Music Widget v6.0 — chancelloredwards.dev

## Goal in one line
Version the vinyl music widget to v6.0 as an Apple Music / Sonos-grade surface that runs itself — a calm, always-on radio that auto-advances without dead air and rotates intelligently across sessions.

## Functional dimension

## Radio automation — always-on, no dead air
The widget behaves like a station, not a player. Two pillars:

### Auto-advance (FEATURE_RADIO)
- On `FINISH`, play the next record from the rotation immediately. Target gap: ≤ 250ms perceived.
- On `ERROR`, increment a per-record fault counter, log via `vlog`, advance to the next record. After three consecutive failed records within a single rotation, fall back to a paused state with a quiet `vinyl-title` of `signal lost` rather than spinning forever.
- On stalls (no `PLAY_PROGRESS` for ≥ `SILENCE_MS`), treat as `ERROR` and advance.
- Auto-advance never overrides an explicit user pause. If the user pauses mid-track, finishing that track does not auto-resume.
- Auto-advance must respect leader election. Only the elected owner advances; followers receive the new state via `BroadcastChannel` and reflect it.

### Smart rotation (FEATURE_ROTATION)
- A rotation is a shuffled walk over `records` with two constraints:
  1. **No immediate repeat.** A track may not replay until at least `min(records.length - 1, 6)` other tracks have played.
  2. **Recency memory.** Persist the last N played track IDs (suggest N = 12) in `localStorage` under `ce-vinyl-recents` with a versioned schema (`RECENTS_VERSION = 1`). On boot, the rotation seeds from this list so reload doesn't restart the same five favorites.
- The rotation is deterministic given (recents, current crate). The same inputs produce the same next pick — easy to test, easy to reason about.
- Manual selection from the crate inserts that track into the rotation immediately and resets the lookahead. The "no immediate repeat" rule continues to apply afterward.
- Up Next is computed from this rotation, not from the SoundCloud playlist's natural order.

### Wake & continuity
The existing v4 continuity engine already restores playback across same-tab navigation. v6.0 layers on:

- On boot, if `continuityRestore()` returns a state with `spinning: true`, the widget warms the SDK eagerly and resumes. If autoplay is rejected, fall back gracefully to `vinyl-title: tap to resume` without flashing a broken state.
- Wake-on-arrival from a *new* session is out of scope — autoplay policies forbid it and we will not fight the browser.

## Acceptance criteria — do not consider this done until all are true
- [ ] In DND mode, finishing a track plays the next within 250ms with no visible empty state.
- [ ] An induced SDK `ERROR` advances to the next track; three consecutive errors land on `signal lost` without a runaway loop.
- [ ] A track that just played does not replay for at least six other tracks (or `records.length - 1`, whichever is smaller).
- [ ] Reloading the page does not restart the same track that just played in the prior session — the recents memory honors continuity.
- [ ] Up Next renders the next track and updates exactly once per advance, in sync across tabs.
- [ ] The sleeve picks up a quiet album tone within 1.2s of a track stabilizing; toning is invisible at first glance and never breaks AA contrast against `--ink-mid` text.
- [ ] `prefers-reduced-motion: reduce` disables tinting transitions, marquee scroll, and groove cross-fade — but does not disable auto-advance.
- [ ] Toggling each new `FEATURE_*` to false individually leaves the widget functional and visually consistent.
- [ ] Toggling all new feature gates to false produces v5.2 behavior bit-for-bit (visual diff + behavioral diff = empty).
- [ ] Bundle delta ≤ 8KB min / ≤ 3KB gzip. No new third-party scripts.
- [ ] Lighthouse on every page that mounts the widget: Performance ≥ 95, Accessibility ≥ 95, Best Practices = 100.
- [ ] Cross-tab leader election unchanged; only the leader auto-advances; followers reflect within one heartbeat.
- [ ] Adapter boundary intact — `grep "SC.Widget"` outside the `adapter` closure returns nothing new.
- [ ] No regressions in `vinyl-source` offscreen positioning, focus rings, or keyboard reachability.

## Out of scope
- Any change to the three top-nav rooms or the Fountain Clock.
- A `prev` button, history scrubbing, or seek-to-previous-track.
- Lyric display, queue editing, or per-track ratings.
- Cross-device sync, accounts, or a sync server.
- Replacing SoundCloud as the audio source.
- Wake-on-arrival from a fresh session (autoplay policies).
- Any analytics on track-level listening.

## Technical dimension

## Before writing any code — discover the ground truth
Open the repo and confirm the following before changing anything:

1. The current widget lives in `js/vinyl.js` (v5.2.0) and is mounted in every page that loads `js/refined.js` + `js/vinyl.js`. Markup lives at the foot of `index.html`, `playground.html`, `notes.html`, `about.html`. Styles begin around `css/styles.css:2990` under the comment "VINYL PLAYER — DND mode only".
2. The widget is gated behind `html[data-mode="dnd"]` and the `.vinyl--live` class. Nothing renders outside that mode. v6.0 must preserve this gating exactly.
3. The vocabulary is canonical and should not be renamed: stage / sleeve / marquee / title / deck / spin / lift / hush / dial / crate / latch / needle / groove / records / shelf / cont / source / glyph / phase / channel / upnext. Function-verb families (fetch / warm / drop / catalog / fill / reflect / toggle / on / safe / save / restore / raise / lower / transition / broadcast / format / overture) are also canon.
4. The architecture is modular by closure: `store` (persistence), `adapter` (SoundCloud SDK boundary — *no other module touches SC.Widget*), `groove` (canvas waveform), plus controller / sync / UI extracted in v5.0. Every change must respect the adapter boundary.
5. Feature gates govern every prior version (`FEATURE_RESILIENCE`, `FEATURE_OBSERVABILITY`, `FEATURE_ENHANCED_PERSISTENCE`, `FEATURE_STATE_MACHINE`, `FEATURE_BROADCAST`, `FEATURE_CRATE_V2`, `FEATURE_LEADER_ELECTION`, `FEATURE_OWNERSHIP_V3`, `FEATURE_SLEEVE_V3`, `FEATURE_CONTINUITY_V4`, `FEATURE_GROOVE`, `FEATURE_GROOVE_SEEK`, `FEATURE_GROOVE_IMMERSIVE`). Every v6.0 capability must ship behind its own gate so any subset can be disabled without touching unrelated code.
6. Persistence keys: `ce-vinyl-shelf`, `ce-vinyl-cont`, `ce-vinyl-tab`, `ce-vinyl-epoch`, `ce-vinyl-nav`, `fc:volume`. Schema versions: `SHELF_VERSION = 1`, `CONT_SCHEMA = 1`. Bump versions when payload shape changes; do not silently corrupt existing caches.
7. Design tokens already in use: `--card-surface-soft`, `--card-border`, `--card-shadow`, `--card-glow`, `--chip-surface`, `--chip-border`, `--ink-mid`, `--amber`, `--accent`, `--accent-soft`, `--font-mono`, `--radius-pill`, `--ease-out`, `--press-scale`, `--focus-ring`. v6.0 reuses these, doesn't invent parallels.

Summarize what you found in a short note before proposing the implementation. Do not refactor blind.

## Preservation invariants — v5.2 behavior that must not change
These are the hard guarantees. Any v6.0 change that breaks one of these is a regression, regardless of how cleanly the new behavior reads.

1. **Mode gating.** The widget remains invisible and inert outside `html[data-mode="dnd"] .vinyl--live`. No surface area leaks into other modes.
2. **Adapter monopoly.** `SC.Widget` and `SC.Widget.Events` are referenced only inside the `adapter` closure. `grep -nE "SC\.Widget" js/vinyl.js` returns the same lines as v5.2 plus any *new* lines that are also inside `adapter`.
3. **Storage keys & schemas.** `ce-vinyl-shelf`, `ce-vinyl-cont`, `ce-vinyl-tab`, `ce-vinyl-epoch`, `ce-vinyl-nav`, `fc:volume` keep their existing keys and TTLs. `SHELF_VERSION` and `CONT_SCHEMA` are not bumped unless a payload field actually changes shape; new keys (e.g. `ce-vinyl-recents`) get their own version constant.
4. **Cross-tab coordination.** Leader election, heartbeat liveness, claim-epoch ordering, yield-grace, and the v4 nav-marker reclaim path all behave identically. Only the elected leader drives auto-advance; followers reflect via `BroadcastChannel` exactly as today.
5. **Continuity contract.** `continuityRestore()` remains consume-on-read. Same-tab navigation still resumes within `CONT_TTL` (30s). Stale states are discarded silently, never surfaced as broken UI.
6. **Vocabulary.** Every existing identifier — `stage`, `sleeve`, `marquee`, `title`, `deck`, `spin`, `lift`, `hush`, `dial`, `crate`, `latch`, `needle`, `groove`, `records`, `shelf`, `cont`, `source`, `glyph`, `phase`, `channel`, `upnext` — keeps its meaning. New concepts get new names; nothing is renamed in passing.
7. **Phase machine.** The `dormant / loading / ready / playing / paused / errored` lifecycle keeps its transitions. New behavior layers on top via additional events, not by adding states.
8. **Feature-gate orthogonality.** Toggling all v6.0 gates to `false` produces a binary identical to v5.2 in observable behavior — same DOM, same network calls, same persistence writes, same console output at every `LOG_LEVEL`.
9. **Markup contract.** The existing `#vinyl` element, its children, and their IDs (`vinylSource`, `vinylTitle`, `vinylSpin`, `vinylHush`, `vinylDial`, `vinylLatch`, `vinylCrate`) are not removed or renamed. New elements are added; nothing existing is repurposed.
10. **Performance ceiling.** Time-to-interactive for any page that mounts the widget does not regress beyond ±50ms vs. v5.2 measured with a cold cache.

## Architecture requirements
- **Adapter boundary holds.** All new SDK touchpoints (next-track scheduling, error introspection, current-sound metadata for palette/upnext) go through `adapter`. If the SDK lacks something needed, expose it on `adapter` first; never reach around it.
- **New module: `rotation`.** A pure, deterministic closure that owns the shuffle, the recents list, and the "next track" decision. Zero DOM access. Zero SDK access. Inputs in, ID out. Trivially unit-testable in a Node REPL with no shims.
- **New module: `palette`.** A pure closure that takes an artwork URL and returns `{ tone: hsl, ready: bool }`. Caches per URL in a `Map`. Falls back to a neutral tone on CORS failure. Never blocks the UI thread for more than ~16ms; samples at low resolution (32×32 canvas) inside `requestIdleCallback` where available, `setTimeout(_, 0)` fallback otherwise.
- **Controller orchestrates, never decides.** The controller asks `rotation` for the next ID, asks `adapter` to skip, asks `palette` for the tone, and tells `ui` to apply state. The decision logic stays in the pure modules. This is the single most important architectural rule of v6.0.
- **Feature gates.** Every v6.0 capability ships behind its own boolean: `FEATURE_RADIO`, `FEATURE_ROTATION`, `FEATURE_PALETTE`, `FEATURE_UPNEXT`, `FEATURE_NEXT_BTN`, `FEATURE_MARQUEE_FADE`. Each gate is independently flippable; combinations behave reasonably (e.g. `FEATURE_UPNEXT` without `FEATURE_ROTATION` falls back to the SoundCloud playlist's natural order).
- **Performance budget.** Total bundle delta ≤ 8KB minified, ≤ 3KB gzipped. No new third-party scripts. No new event listeners on `window` or `document` outside what `requestIdleCallback` requires.
- **Observability.** New `vlog` events: `radio:advance`, `radio:fault`, `radio:fault-cap`, `rotation:pick`, `rotation:seed`, `palette:extract`, `palette:cache-hit`, `palette:cors-fallback`, `upnext:reflect`. `LOG_LEVEL` gating and `?vinyl-log=N` URL param behavior unchanged.

## Coding standards
The widget is hand-written ES5-flavored JS by design (matches the existing file). v6.0 keeps that register.

- **Closures over classes.** Each module is an IIFE returning a frozen public API object. No `this`, no `class`, no transpilation.
- **Pure where possible.** `rotation`, `palette`, and any new helper inside `store` are pure functions of their inputs. No hidden state, no module-level mutables outside the cache `Map`s.
- **Defensive at every boundary.** Every SDK callback, every storage read, every `BroadcastChannel` message wraps in `try/catch`. Failure paths return sentinel values (`null`, `false`, `[]`) — never throw across the module boundary.
- **No silent corruption.** When schema versions mismatch or payloads are malformed, discard and `vlog` at level 3. Never partially repair.
- **Naming.** Continue the existing verb families (`fetch*`, `warm*`, `drop*`, `catalog*`, `fill*`, `reflect*`, `toggle*`, `on*`, `safe*`, `save/restore`, `raise/lower`, `transition`, `broadcast*`, `format*`). New verbs only when an action genuinely belongs to a new family.
- **Comments earn their lines.** Section banners (`╔═╗`-style or `── ──`) for new modules in the existing voice. Inline comments explain *why*, not *what*. No JSDoc-as-decoration.
- **CSS additions.** Use existing tokens. New custom properties live under `--vinyl-*`. No new ad-hoc colors, no inline styles in JS except the dynamically-set `--vinyl-tint`.
- **DOM hygiene.** New elements get classes that follow `vinyl-*` BEM-ish convention (`vinyl-upnext`, `vinyl-btn-next`). No utility soup, no IDs that aren't already needed for ARIA wiring.
- **Accessibility floor.** Every new interactive element has a visible focus ring (`var(--focus-ring)`), a real `aria-label`, and is reachable in DOM order. Motion respects `prefers-reduced-motion`. Color additions tested against AA on the `--ink-mid` text.

## Layering & rollback
v6.0 is layered, not destructive. The reviewer should be able to read each commit independently and understand what it adds.

- One feature gate per commit where possible. Squash-merge into a single tagged release.
- Each gate has a one-line rollback story: flipping it to `false` is the rollback. No hidden migrations, no irreversible storage writes.
- The `ce-vinyl-recents` key is the only new persisted state. Its absence is treated as a cold start; its presence at an unexpected schema version is discarded silently.
- If any preservation invariant is violated mid-implementation, the offending commit is reverted before merging — not patched on top of.

## Suggested implementation order
Each step lands behind its feature gate, with the gate defaulting to `true` only after the step's done-criteria are met.

1. **Inventory** — write the discovery note. *Done when:* the note covers all seven discovery points and is committed under `docs/`.
2. **Feature-gate scaffolding** — add the six new constants near the existing feature-gate block; all default `false`. *Done when:* file compiles, no behavior change.
3. **`rotation` module** — pure shuffle + recents memory + "no immediate repeat" rule. *Done when:* a deterministic test harness (in-file `if (typeof module !== 'undefined')` block, no test framework) proves same-input/same-output and the no-repeat invariant over 1000 picks.
4. **Recents persistence** — `store.recentsRead` / `store.recentsWrite` with `RECENTS_VERSION = 1`. *Done when:* round-trip works, version mismatch discards cleanly, quota errors are swallowed.
5. **Auto-advance wiring** — controller binds `FINISH` and `ERROR` via `adapter.on`; stall watchdog uses the existing `SILENCE_MS`; respects `phase === 'paused'` set by user. *Done when:* induced finish/error/stall each advance correctly, three consecutive faults land on `signal lost`, leader election is unchanged.
6. **`next` button** — markup in `index.html` et al., styles reusing `.vinyl-btn`, controller wiring via the same path as auto-advance. *Done when:* button is keyboard-reachable, focus-ringed, and works in followers via broadcast.
7. **Up Next surface** — eyebrow element, content from `rotation.peek()`, sync via existing `BroadcastChannel`. *Done when:* all open tabs reflect the same Up Next within one heartbeat.
8. **Marquee fade-edges + slow scroll** — pure CSS via mask-image; JS only sets a `vinyl-title--truncated` class when measurement shows overflow. *Done when:* short titles don't scroll, long titles scroll smoothly, reduced-motion disables scroll.
9. **`palette` module** — sample, derive `hsl(...)`, apply via `--vinyl-tint` on the sleeve. *Done when:* extraction completes off-thread, CORS-failed images fall back without flicker, AA contrast is preserved on every sample in the current crate.
10. **Groove cross-fade on track change** — extend `groove.startFlow` to accept a transition phase; reuse existing rAF loop. *Done when:* track change shows a 600ms waveform cross-fade, reduced-motion shows an instant swap.
11. **Verify** — run the acceptance checklist end-to-end with each gate flipped both ways.

## Verification notes to deliver alongside the PR
A short markdown summary covering:

- Inventory note (the seven discovery points).
- A preservation-invariant table: each invariant, the test that proves it holds, the result.
- Rotation determinism proof: a tiny script log showing same inputs → same next pick over 1000 iterations, and the no-repeat constraint never violated.
- Induced-error and stall traces (browser DevTools console excerpts at `?vinyl-log=3`).
- Palette extraction timings on five sample tracks (`palette:extract` durations from `vlog`).
- Before/after screenshots: light mode, dark mode, reduced-motion, a tinted state, the Up Next eyebrow visible.
- A feature-gate matrix: for each of the six new gates, observable diff vs. v5.2 with that gate alone enabled.
- Bundle-size diff: `js/vinyl.js` minified + gzipped, before and after.

## Conceptual dimension

## Visual register — Apple Music / Sonos
Calm, editorial, ambient. The sleeve is a glass surface that quietly absorbs the color of what's playing. Motion is slow (≥ 400ms calm transitions, 120ms tactile presses). Type stays mono, lowercase, restrained. Nothing strobes, nothing demands attention. The widget reads as a living object that knows the room.

Concretely:

- **Album-art ambience.** When a track has artwork, extract a single dominant tone (server-free; canvas + small color quantizer or `Image` + average sample) and warm the sleeve toward it via `color-mix` against `--card-surface-soft`. Transition over 800–1200ms. Never overpower the page; keep saturation capped and lightness within ±8% of the base token.
- **Marquee.** Title scrolls only when truncated, slowly (≥ 12s per cycle), with a soft fade on both edges. No bounce, no marching ticker.
- **Up Next eyebrow.** Below the title, render a quiet 0.5rem mono line: `up next · {next track}`. Fades in 240ms after the current track stabilizes; fades out 240ms before transition. This is the most visible radio cue.
- **Groove.** Keep the v5.2 immersive groove. On track change, cross-fade the seeded waveform over 600ms instead of snapping.
- **Deck.** Add a `next` button (skip-forward glyph) to the deck, sitting between `spin` and `hush`. The `crate` latch retains its position. No `prev` button — the radio is forward-only.
- **Sleeve states.** Preserve the existing `vinyl--live`, `vinyl--spinning` classes. Add `vinyl--tinted` (carries the album tone) and `vinyl--transitioning` (briefly applied during auto-advance to coordinate the cross-fade).
- **Reduced motion.** Respect `prefers-reduced-motion: reduce` everywhere new motion is introduced. Tone transitions still happen but instantly; marquee never scrolls; groove cross-fades become instant swaps.

## Working principles
First principles. Simple architectures. Clean code. Reuse the existing vocabulary, the existing tokens, the existing modular boundaries. Every new behavior earns its feature gate. The widget should feel like an old radio that quietly knows what to play next — not a dashboard. Leave the codebase and the people around it better than you found them.
