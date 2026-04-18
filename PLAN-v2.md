# Site v2 — Versioning Plan

> **North star.** Calm, private, always-on, and unmistakably yours.
> **Posture.** Don't add surface area. Make what exists more resilient, more tactile, more intentional.

---

## 0. Guiding principles

1. **Three rooms, one house.** Fountain Clock (ambient), Playground (proof-of-skill), Notes (personal + recurring). Nothing else lives in the top nav.
2. **One primary action per page.** Every room has a single verb the visitor can do without thinking.
3. **Local-first, network-tolerant.** Anything that depends on a network call must degrade to a cached or static state instead of an empty one.
4. **One design system.** Shared shell, tokens, type, spacing, motion. DND interactions are isolated; everything else is uniform.
5. **Soft productivity for the audience.** Visually warm, low-friction, private by default. No feeds, no follows, no comments.

---

## 1. Information architecture

| Room          | Role                          | Primary action                  | Replaces / evolves              |
| ------------- | ----------------------------- | ------------------------------- | ------------------------------- |
| Fountain Clock| Signature ambient piece       | Watch / listen / linger         | `index.html` hero + ambient art |
| Playground    | Contained proof-of-skill      | Open a project / try a demo     | `projects.html` + experiments   |
| Notes         | Personal, recurring micro-vault | Capture a note (instantly)    | `about.html` retired into Notes |

Resume remains accessible (linked from Playground and footer) but leaves the top nav. The site reads as a portfolio of *experiences*, not a CV.

---

## 2. Release phases

Each phase is independently shippable. No phase blocks the next.

### Phase 1 — Shared shell & design tokens *(foundational)*

**Goal.** Make the three rooms feel like one system before changing any of them.

- Extract typography, color, spacing, radius, motion into CSS custom properties in `css/styles.css` (or a new `css/tokens.css`).
- Unify nav, footer, page wrap, card, and button primitives.
- Standardize motion: one easing curve, two durations (fast 120ms, calm 240ms).
- Audit and remove one-off styles introduced by experiments.
- Keep DND mode and the vinyl player isolated behind a single `[data-mode="dnd"]` boundary.

**Acceptance.** Every existing page renders identically *or better*, sourced from the same tokens. No visual regressions on mobile.

---

### Phase 2 — Notes (local-first micro-vault) *(the new center of gravity)*

**Goal.** A small, durable, private capture space that loads instantly and works offline.

**Core (must-have).**
- Create, pin, archive, search, export.
- Card-based layout. Each card: title, body, optional color/mood chip, tags, timestamps.
- Local persistence via IndexedDB (with a thin wrapper); `localStorage` fallback for tiny installs.
- Instant capture: focus the input on page load; `⌘/Ctrl+Enter` saves.
- Full-text search across notes (client-side, no index server).
- JSON export / import for portability.

**Tasteful extras (only if they earn their place).**
- A handful of templates (gratitude, reading log, idea, voice memo transcript).
- Optional reminders via the browser's Notification API (permission gated, opt-in).
- Audio capture via MediaRecorder; image attachment via `<input type="file">`. Stored locally, never uploaded.

**Explicitly out.**
- Accounts, sync servers, feeds, likes, comments, follower mechanics, sharing-by-default.

**Acceptance.**
- First contentful paint < 1s on mid-range mobile.
- All core actions work offline.
- Zero network requests in the default flow.
- Data export round-trips losslessly.

---

### Phase 3 — Playground (Projects fallback hardening)

**Goal.** The room that proves skill must never look broken.

- Replace the live GitHub fetch with a build-time snapshot committed to the repo (`assets/projects.json`), refreshed by a scheduled task.
- On page load: render the snapshot first, then *quietly* attempt a live refresh. If live succeeds, swap in. If it fails, the snapshot stays and no error UI appears.
- Each project card has one primary action ("Open", "Try demo", "Read post"). No secondary clutter.
- Add a small "experiments" lane below shipped projects for short-lived demos.

**Acceptance.**
- With network disabled, the page renders a complete, attractive list.
- No empty states. Ever.

---

### Phase 4 — Fountain Clock & polish

**Goal.** Turn the homepage into the signature ambient piece.

- Promote the ambient/clock element to the landing room. Quiet typography, generous whitespace, one subtle motion loop.
- One primary action: a single line of copy + a single link into Playground or Notes.
- Reduce hero text to the essentials; move resume detail behind a secondary link.
- Pass: contrast, reduced-motion preference, prefers-color-scheme, keyboard focus rings.

**Acceptance.**
- Lighthouse: Performance ≥ 95, Accessibility ≥ 95, Best Practices = 100, SEO ≥ 95.
- `prefers-reduced-motion: reduce` disables the loop.

---

## 3. Cross-cutting workstreams

- **Routing & nav.** Three top-level links only: Fountain Clock (`/`), Playground (`/playground`), Notes (`/notes`). Resume linked from footer + Playground.
- **SEO & structured data.** Preserve the Person / WebSite / Dataset JSON-LD. Add a `WebPage` entry for each room.
- **Analytics.** None by default. If added later, privacy-preserving, no cookies.
- **Performance budget.** ≤ 60KB CSS, ≤ 80KB JS per route, no blocking third-party scripts.
- **Accessibility floor.** WCAG 2.2 AA. Every interactive element reachable by keyboard with a visible focus state.

---

## 4. File-level changes (proposed)

```
/                      → Fountain Clock (rename of index.html intent)
/playground.html       → renamed from projects.html
/notes.html            → new
/about.html            → retired; content folded into footer + Notes seed
/css/tokens.css        → new (extracted design tokens)
/css/styles.css        → trimmed, references tokens
/js/notes.js           → new (local-first store + UI)
/js/projects-cache.js  → new (snapshot-first loader)
/assets/projects.json  → new (build-time snapshot)
```

Existing files (`refined.js`, `shell.js`, `vinyl.js`) remain; DND/vinyl stays scoped behind the mode toggle.

---

## 5. Sequencing & estimate

| Phase | Scope                          | Rough effort |
| ----- | ------------------------------ | ------------ |
| 1     | Shell + tokens                 | 1 sitting    |
| 2     | Notes core                     | 2–3 sittings |
| 3     | Playground fallback            | 1 sitting    |
| 4     | Fountain Clock + polish        | 1 sitting    |

Ship Phase 1 first because everything else inherits from it. Phases 2–4 can be parallelized after that, but Notes is the highest-value bet and should land second.

---

## 6. Definition of done (whole release)

- Three rooms, one shared visual system, one primary action each.
- Notes works fully offline and exports cleanly.
- Playground never shows an empty or error state.
- Fountain Clock is the calmest page on the site.
- Lighthouse green across the board, reduced-motion respected, no third-party trackers.
