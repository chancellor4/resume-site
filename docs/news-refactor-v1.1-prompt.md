# News Refactor v1.1 — chancelloredwards.dev

## Goal in one line
Version the existing news module to v1.1 as a calm, image-aware, server-fetched newsstand that lives quietly beneath the Fountain Clock without ever competing with it.

## Before writing any code — discover the ground truth
Open the repo and confirm the following before changing anything:

1. Where the current news module lives (component, styles, data layer, build/runtime model — static? SSR? edge function? client fetch?).
2. How the Fountain Clock homepage composes the news module (slot, route, lazy boundary, scroll position).
3. The existing design tokens — type scale, color, spacing, motion timing, radius, shadow language. v1.1 must reuse these, not invent new ones.
4. The current RSS list and how feeds are fetched, parsed, and cached today.
5. Build/deploy target (Vercel, Netlify, Cloudflare, static export, etc.) so the cache strategy fits the platform.

Summarize what you found in a short note before proposing the implementation. Do not refactor blind.

## Sources (replace the existing list with exactly these five)
- Vogue — https://www.vogue.com/feed/rss
- Business of Fashion — https://www.businessoffashion.com/feeds/news
- Hypebae — https://hypebae.com/feed
- BBC World News — http://feeds.bbci.co.uk/news/world/rss.xml
- NYT World — https://rss.nytimes.com/services/xml/rss/nyt/World.xml

Each source carries a `category` so the final mix can be balanced across: fashion authority, fashion business, youth culture, global affairs, mainstream world.

## Normalized internal schema
Every feed item, regardless of publisher quirks, becomes:

```ts
type NewsItem = {
  title: string;
  source: string;          // display name, e.g. "Business of Fashion"
  sourceType: 'fashion-authority' | 'fashion-business' | 'youth-culture' | 'global-affairs' | 'world-news';
  link: string;            // canonical publisher URL
  publishedAt: string;     // ISO 8601
  excerpt: string;         // ≤ ~180 chars, plain text, no HTML
  imageUrl: string | null; // null when missing, blocked, malformed, or policy-unclear
};
```

Image extraction order: `<media:content>` → `<media:thumbnail>` → `<enclosure type="image/*">` → first `<img>` in `content:encoded` → null. Do not scrape article pages. Do not proxy or hotlink when the publisher signals restriction or when provenance is ambiguous — fall back to null.

## Architecture requirements
- **Server-side fetch + cache.** The browser never hits publisher RSS directly. Use the platform's native caching primitive (ISR, edge cache, KV, or a simple in-memory TTL on a serverless route) with a TTL of ~15 min and stale-while-revalidate on top.
- **Fault isolation.** Each feed fetch runs independently with its own try/catch and timeout (~5s). One bad feed degrades the mix, never the module.
- **No heavy client deps.** Parse RSS server-side (`fast-xml-parser` or equivalent — small, no DOM). Nothing new on the client unless absolutely necessary.
- **No render blocking.** Fountain Clock paints first. The news module loads via streaming/SSR with a graceful skeleton, or hydrates after first paint. Initial HTML must not wait on RSS.
- **Mix curation, not just concatenation.** After normalizing, interleave by sourceType so the surface reads as a balanced worldview rather than five clumps. Recency-aware but not strictly chronological.

## Card component (v1.1)
Two variants, one component:

- **Image-led card** when `imageUrl` is present and loads successfully — image with subtle warm overlay, source label, title, timestamp.
- **Text-led card** when `imageUrl` is null or fails to load — typographic composition with the source as a quiet eyebrow, generous line-height, no fake placeholder image.

Both share: source eyebrow, readable title (2–3 line clamp), compact relative timestamp, and a soft "open original" affordance. The card is a link to `link` with `target="_blank" rel="noopener noreferrer"`. Never embed full content.

Visual register: ambient, editorial, restrained. Reuse existing tokens. No new motion language — at most a slow fade-in on mount and a subtle hover lift consistent with the rest of the site. Mobile-first, single column on small screens, fluid grid on larger.

Accessibility: alt text from item title when image is decorative, semantic `<article>` + `<time datetime>`, focus ring matching site language, color contrast AA minimum.

## Suggested implementation order
1. **Inventory** — write the discovery note above.
2. **Source config** — add the five feeds with `sourceType` to a single config file. One source of truth.
3. **Aggregator** — server module that fetches all feeds in parallel with isolation, parses, normalizes, extracts images cautiously, returns `NewsItem[]`.
4. **Cache layer** — wrap the aggregator with the chosen platform cache (TTL + SWR).
5. **Curation** — interleave by `sourceType`, cap total items (suggest 12–18).
6. **Card v1.1** — image-led / text-led branches, accessible, responsive.
7. **Mount** — replace the existing news section in place; verify Fountain Clock still leads the page and isn't shifted.
8. **States** — loading skeleton, empty state, error state (per-feed and module-wide).
9. **Verify** (see checklist below).

## Acceptance criteria — do not consider this done until all are true
- [ ] Fountain Clock renders identically and is not delayed by news fetching.
- [ ] All five feeds parse and contribute when healthy.
- [ ] Killing any one feed (simulate 500 / timeout / malformed XML) leaves the module functional with the remaining four.
- [ ] Items with images render image-led; items without render text-led; broken `imageUrl` falls back to text-led without layout shift.
- [ ] No publisher full content is stored or rendered; excerpts are short and links go to originals.
- [ ] Lighthouse mobile: news module adds no measurable CLS, and TTI is unaffected vs. the prior version.
- [ ] Keyboard navigation works through cards; screen reader announces source, title, and timestamp coherently.
- [ ] Cache hits on repeat loads (verify via response headers or instrumentation log).
- [ ] No new client-side dependency > a few KB gzipped.

## Verification notes to deliver alongside the PR
A short markdown summary covering: which feeds returned content during testing, which items had images vs. fell back, a screenshot of the mobile and desktop layouts, the cache behavior observed, and any publisher quirks encountered.

## Out of scope
- Reordering or restyling Fountain Clock.
- Saving, bookmarking, or personalization beyond the curated mix.
- Search, filters, or category toggles in the UI.
- Any client-side analytics on news interactions beyond what already exists.

## Working principles
First principles. Simple architecture. Clean code. Reuse existing tokens; do not introduce a parallel design language. Leave the codebase calmer than you found it.
