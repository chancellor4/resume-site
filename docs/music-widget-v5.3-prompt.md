# Music Widget v5.3 — chancelloredwards.dev

## Goal in one line
Version the vinyl widget to v5.3 as pure resilience — auto-advance, error recovery, and stall protection that turn the player into a station that never goes dead. No new UI surface, no new modules, no new persistence. The widget feels exactly like v5.2 until something tries to break it.

## Why v5.3, not v6.0
v5.3 honors the site's own first principle from `PLAN-v2.md`: *"Don't add surface area. Make what exists more resilient, more tactile, more intentional."* A larger v6 cut was considered (Up Next eyebrow, next button, palette tinting, smart rotation with recents memory) and rejected — those are Spotify ergonomics dressed in calm language, and they trade ambient posture for player surface area. v5.3 ships only the changes that the visitor will *not* notice unless something would have gone wrong.

---

## Functional dimension

### Radio resilience — no dead air, no new surface (FEATURE_RADIO)
The widget already plays. v5.3 ensures it keeps playing when the network or SDK misbehaves, without adding anything the visitor can see.

- **Happy-path advance is delegated.** SoundCloud's natural playlist advance remains the primary path. v5.3's controller only intervenes when SC stops behaving.
- **On `ERROR`,** increment a session-scoped fault counter, `vlog`, advance to the next record via `adapter.skip(currentIndex + 1)`.
- **On stall** (no `PLAY_PROGRESS` for `SILENCE_MS`), treat as `ERROR` and advance. Reuse the existing `SILENCE_MS = 10000` constant; do not introduce a parallel timeout.
- **Fault cap.** Three consecutive faults within a session land on a paused state with `vinyl-title: signal lost`. Manual play (any user-initiated `spin`) resets the counter to zero and clears the message.
- **Explicit-pause respect.** If the user pauses mid-track, `FINISH` does not auto-resume and the watchdog does not advance. Pause is sacred.
- **Leader-only.** Only the elected owner runs the watchdog and the advance. Followers reflect the new state via `BroadcastChannel` exactly as they do today.

### Acceptance criteria — do not consider this done until all are true
- [ ] In DND mode, finishing a track plays the next with no visible empty state (SC handles this on the happy path).
- [ ] An induced `ERROR` advances to the next track within 250ms.
- [ ] A stall (no `PLAY_PROGRESS` for `SILENCE_MS`) advances to the next track.
- [ ] Three consecutive faults land on `signal lost` without a runaway loop. Manual play recovers and resets the counter.
- [ ] A user-initiated pause is never overridden by auto-advance or the watchdog.
- [ ] Cross-tab leader election unchanged; only the leader advances; followers reflect within one heartbeat.
- [ ] Toggling `FEATURE_RADIO` to `false` produces v5.2 behavior bit-for-bit (visual diff + behavioral diff = empty).
- [ ] Bundle delta ≤ 2KB minified, ≤ 700B gzipped.
- [ ] Zero new DOM elements. Zero new persistence keys. Zero new third-party scripts.
- [ ] Lighthouse on every page that mounts the widget: Performance ≥ 95, Accessibility ≥ 95, Best Practices = 100.
- [ ] Adapter boundary intact — `grep "SC.Widget"` outside the `adapter` closure returns the same lines as v5.2 plus any new lines that are also inside `adapter`.

### Out of scope — explicit on what didn't make the cut, and why
- **Up Next eyebrow.** A radio doesn't tell you what's next. It plays.
- **`next` skip button.** The crate latch already supports manual selection. A skip button turns ambient gear into a control panel.
- **Album-art palette tinting.** The SC embed suppresses artwork (`show_artwork=false&visual=false`); extracting a palette would require separate fetches for art the visitor never sees, for a flourish most people won't consciously register.
- **Smart rotation with cross-session recents memory.** A portfolio site's return-visitor traffic doesn't earn the complexity. Revisit if behavior data ever justifies it.
- **Marquee fade-edges, groove cross-fade.** Tactile polish belongs in a separate v5.4 if it earns its place. v5.3 ships nothing visible.
- **Wake-on-arrival from a fresh session.** Browser autoplay policies forbid it.
- **Any analytics on track-level listening.**

---

## Technical dimension

### Before writing any code — discover the ground truth
Open the repo and confirm the following before changing anything:

1. The current widget lives in `js/vinyl.js` (v5.2.0) and is mounted in every page that loads `js/refined.js` + `js/vinyl.js`. Markup lives at the foot of `index.html`, `playground.html`, `notes.html`, `about.html`. Styles begin around `css/styles.css:2990` under the comment "VINYL PLAYER — DND mode only".
2. The widget is gated behind `html[data-mode="dnd"]` and the `.vinyl--live` class. Nothing renders outside that mode. v5.3 must preserve this gating exactly.
3. The vocabulary is canonical and should not be renamed: stage / sleeve / marquee / title / deck / spin / lift / hush / dial / crate / latch / needle / groove / records / shelf / cont / source / glyph / phase / channel / upnext. Function-verb families (fetch / warm / drop / catalog / fill / reflect / toggle / on / safe / save / restore / raise / lower / transition / broadcast / format / overture) are also canon.
4. The architecture is modular by closure: `store` (persistence), `adapter` (SoundCloud SDK boundary — *no other module touches SC.Widget*), `groove` (canvas waveform), plus controller / sync / UI extracted in v5.0. Every change must respect the adapter boundary.
5. Feature gates govern every prior version (`FEATURE_RESILIENCE`, `FEATURE_OBSERVABILITY`, `FEATURE_ENHANCED_PERSISTENCE`, `FEATURE_STATE_MACHINE`, `FEATURE_BROADCAST`, `FEATURE_CRATE_V2`, `FEATURE_LEADER_ELECTION`, `FEATURE_OWNERSHIP_V3`, `FEATURE_SLEEVE_V3`, `FEATURE_CONTINUITY_V4`, `FEATURE_GROOVE`, `FEATURE_GROOVE_SEEK`, `FEATURE_GROOVE_IMMERSIVE`). v5.3 adds exactly one: `FEATURE_RADIO`.
6. Persistence keys: `ce-vinyl-shelf`, `ce-vinyl-cont`, `ce-vinyl-tab`, `ce-vinyl-epoch`, `ce-vinyl-nav`, `fc:volume`. v5.3 introduces zero new keys and bumps zero schema versions.
7. The `errored` phase already exists in the v1.4 state machine. v5.3 reuses it for the `signal lost` terminal state — does not introduce a new phase.

Summarize what you found in a short note before proposing the implementation. Do not refactor blind.

### Preservation invariants — v5.2 behavior that must not change
1. **Mode gating.** Widget remains invisible and inert outside `html[data-mode="dnd"] .vinyl--live`.
2. **Adapter monopoly.** `SC.Widget` and `SC.Widget.Events` referenced only inside the `adapter` closure.
3. **Storage keys & schemas.** Zero new keys. Zero schema bumps.
4. **Cross-tab coordination.** Leader election, heartbeat, claim-epoch ordering, yield-grace, v4 nav-marker reclaim — all unchanged.
5. **Continuity contract.** `continuityRestore()` remains consume-on-read with the existing 30s TTL.
6. **Vocabulary.** Every existing identifier keeps its meaning. New behavior earns new names; nothing is renamed in passing.
7. **Phase machine.** `dormant / loading / ready / playing / paused / errored` keeps its transitions. v5.3 reuses `errored` for the fault-cap terminal; no new phase.
8. **Markup contract.** Zero changes to `#vinyl` or its children. No new IDs, no new classes on existing elements (except a transient state class if absolutely necessary, namespaced as `vinyl--`).
9. **Performance ceiling.** TTI on every mounting page does not regress beyond ±50ms vs. v5.2 with a cold cache.

### Architecture requirements
- **No new modules.** The fault counter and stall watchdog live inside the controller as small, well-named pieces of state. There is no `radio` closure; the behavior is too small to earn one.
- **Adapter additions only if necessary.** If the controller needs `lastProgressAt` to run the watchdog, expose it on `adapter` (e.g., `adapter.lastProgressAt()`); never reach around the boundary. Prefer maintaining the timestamp in the controller from `PLAY_PROGRESS` callbacks — adapter changes only when unavoidable.
- **One feature gate.** `FEATURE_RADIO` controls the entire v5.3 surface. Off → v5.2 bit-for-bit.
- **Performance budget.** Bundle delta ≤ 2KB minified, ≤ 700B gzipped.
- **Observability.** New `vlog` events: `radio:advance-on-finish`, `radio:advance-on-error`, `radio:advance-on-stall`, `radio:fault-cap`, `radio:reset`. `LOG_LEVEL` and `?vinyl-log=N` behavior unchanged.

### Coding standards
- **Closures over classes.** Match the existing register: ES5-flavored, IIFE-scoped, no transpilation, no `this`.
- **Pure where possible.** The fault-counter logic is a small reducer over events; write it that way. Inputs in, decision out.
- **Defensive at every boundary.** Every new SDK callback wraps in `try/catch`. Failure paths return sentinels, never throw across modules.
- **No silent corruption.** If the watchdog observes impossible state (e.g., `phase === 'paused'` but `PLAY_PROGRESS` still arriving), `vlog` at level 3 and yield to the truth on the wire.
- **Naming.** Continue the existing verb families. New verbs only when an action genuinely belongs to a new family — none expected for v5.3.
- **Comments earn their lines.** A single section banner in the existing voice for the new controller block. Inline comments explain *why*, not *what*.
- **Accessibility floor.** The `signal lost` title still passes AA contrast against `--card-surface-soft`. No new interactive elements; nothing new to focus-ring.

### Layering & rollback
- One feature gate, one commit, one-line rollback story (flip `FEATURE_RADIO` to `false`).
- Zero new persistence means zero migration risk.
- If any preservation invariant is violated mid-implementation, revert — do not patch on top.

### Suggested implementation order
Each step lands behind `FEATURE_RADIO`, default `false` until step 7's verification passes.

1. **Inventory.** Write the discovery note. *Done when:* the seven points are confirmed and committed under `docs/`.
2. **Feature-gate scaffolding.** Add `FEATURE_RADIO = false` near the existing feature-gate block. *Done when:* file compiles, no behavior change.
3. **Last-progress tracking.** In the controller, capture the `PLAY_PROGRESS` timestamp into a closure-local. *Done when:* timestamp updates on every event, doesn't leak across leader handoffs.
4. **Stall watchdog.** Single `setInterval` (cleared on `pagehide` and on leader-yield) checks `Date.now() - lastProgressAt > SILENCE_MS` while `phase === 'playing'`. *Done when:* induced silence advances within `SILENCE_MS + 1000ms`.
5. **`ERROR` and `FINISH` wiring.** Bind via `adapter.on`; route both through a single `onFault({reason})` function that decides whether to advance, cap, or no-op. *Done when:* induced `ERROR` advances, `FINISH` happy-path delegates to SC, and `phase === 'paused'` blocks both.
6. **Fault counter + cap.** Three consecutive faults → transition `phase` to `errored`, set `vinyl-title` to `signal lost`. Any user-initiated `spin` resets the counter and re-enters `ready`. *Done when:* three induced faults land on `signal lost` and a manual play recovers cleanly.
7. **Verify** — run the acceptance checklist with `FEATURE_RADIO` flipped both ways. Promote default to `true`.

### Verification notes to deliver alongside the PR
A short markdown summary covering:

- Inventory note (the seven discovery points).
- A preservation-invariant table: each invariant, the test that proves it holds, the result.
- Induced-fault traces (DevTools console at `?vinyl-log=3`) for `FINISH`, `ERROR`, stall, and the three-strike cap.
- Cross-tab check: induce a fault on the leader, confirm followers reflect within one heartbeat.
- Bundle-size diff: `js/vinyl.js` minified + gzipped, before and after.
- Feature-gate diff: a side-by-side of observable behavior with `FEATURE_RADIO` off vs. on.

---

## Conceptual dimension

### Working principles
The radio is silent about its own resilience. v5.3 makes the widget more durable without adding a single new thing the visitor can see. If it works, no one will notice — they'll just hear music that doesn't go quiet.

First principles. Simple architectures. Clean code. No new modules where existing closures suffice. Reuse the existing vocabulary, tokens, and event paths. Leave the codebase quieter than you found it.
