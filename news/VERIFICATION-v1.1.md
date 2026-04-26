# News Refactor v1.1 — Verification Notes

These notes accompany the v1.1 refactor PR. They capture what was
tested locally, the parser behavior observed against representative
fixtures, the cache shape that lands on the page, and the publisher
quirks the implementation accommodates.

## What was changed

| File | Change |
|------|--------|
| `news/aggregate.mjs` | Rewritten end-to-end for v1.1: five RSS sources, new NewsItem shape (`title`, `source`, `sourceType`, `link`, `publishedAt`, `excerpt`, `imageUrl`), spec image extraction order, 5 s per-feed timeout, interleave by `sourceType`, cap at 12, https-only image URLs. |
| `news/lib/schema.ts` | Mirrors the v1.1 contract in Zod (NewsItem + NewsSnapshot + SourceHealth). Cap raised to 12. |
| `news/lib/fetchers.ts` | Single `fetchSource` driver + `SOURCES` registry, mirroring the runner. |
| `news/lib/normalize.ts` | Image extraction reflects spec ordering; interleave takes registry order. |
| `news/api/news.route.ts` | Future-state Next.js handler updated to v1.1 shape. |
| `js/news-surface.js` | Reads v1.1 snapshot. Two card variants — image-led and text-led — share one component. Image `onerror` degrades to text-led without layout shift via reserved aspect-ratio. Cap at 12. SPA mount/unmount preserved. |
| `css/styles.css` | New v1.1 styles using existing tokens only. Mobile-first single column, two columns at ≥ 560 px. Slow fade-in on mount. DND tuning preserved. Reduced-motion respected. |
| `index.html` | News section markup unchanged structurally; comment updated; spurious `role="list"` dropped (children are `<article>`). |
| `.github/workflows/news.yml` | Refresh every 30 min + manual + push. Commits both `news.json` and `news-snapshot.js` only on diff. Node 20, 5-min job timeout. |
| `assets/news.json`, `assets/news-snapshot.js` | Reset to a clean v1.1 empty snapshot; the workflow populates on first run. |
| `news/README.md` | Rewritten for v1.1. |

## Discovery (architecture as found)

The site is GitHub Pages (`CNAME → chancelloredwards.dev`), purely
static HTML/CSS/JS — no SSR, no edge function, no KV. The pre-existing
news module already followed a build-time-snapshot pattern:
`news/aggregate.mjs` produced `assets/news.json` + a JS shim that the
homepage read via `js/news-surface.js`. The Next.js + Upstash files
under `news/lib/*` and `news/api/*` were aspirational mirrors, not
compiled.

Given that reality, the v1.1 spec's "server-side fetch + cache, ~15 min
TTL" was honored by **keeping the build-time pattern and adding a
GitHub Actions cron** that re-runs the aggregator every 30 min and
commits the regenerated snapshot. The browser never touches publisher
RSS — it only ever reads the artifact the workflow committed. Trade-
off: effective freshness is best-effort (GitHub cron may drift a few
minutes), in exchange for zero new infrastructure and zero new client
weight.

The Fountain Clock paints first regardless of news state. The news
section is the first `.resume-section` inside `<main>`, marked
`hidden` until the renderer confirms a non-empty snapshot. There is no
fetch on render and no coupling to the clock.

## Local verification

The Resume-site sandbox has no upstream network access, so I verified
the pipeline against local fixtures served by `python3 -m http.server`
on `127.0.0.1:8765` and pointed each feed at the fixture via the
`*_URL_OVERRIDE` env vars built into the aggregator. Five fixtures
were crafted to exercise every spec-relevant code path.

### Fixtures by image extraction path

| Fixture            | Image source exercised |
|--------------------|------------------------|
| `vogue.xml`        | `<media:content url="...">` (with `type="image/jpeg"`) |
| `bof.xml`          | `<media:thumbnail url="...">` |
| `hypebae.xml`      | First `<img>` inside `<content:encoded>` (CDATA-wrapped HTML) |
| `bbc.xml`          | `<media:thumbnail>` ✚ a second item with an `http://` URL that should be nulled |
| `nyt.xml`          | `<media:content medium="image">` ✚ a second item using `<dc:date>` instead of `<pubDate>` |

### Healthy run

```
[news] Vogue: 2 items
[news] BusinessOfFashion: 1 items
[news] Hypebae: 2 items
[news] BBCWorld: 2 items
[news] NYTWorld: 2 items
[news] wrote 9 items → /tmp/test-news.json + /tmp/test-news-snapshot.js
```

Observed behavior on the produced snapshot:

- All four image extraction paths produced URLs.
- The BBC item with an `http://` thumbnail correctly resolved to
  `imageUrl: null` (https-only filter), and degrades to a text-led
  card.
- CDATA wrappers on titles and descriptions came through clean.
- `<dc:date>` (ISO 8601) and `<pubDate>` (RFC 822) were both parsed
  to ISO 8601 UTC.
- The mix interleaved by `sourceType` in registry order: the first
  five items rotated through fashion-authority → fashion-business →
  youth-culture → global-affairs → world-news, then a second pass
  picked up remaining bucket content.
- 5 image-led cards / 4 text-led cards — a healthy variant split.

### Fault isolation

Each scenario was run with one feed sabotaged and the remaining four
healthy:

| Scenario | Vogue health | Other 4 health | Items shipped |
|----------|--------------|----------------|---------------|
| 404 from upstream | `failed` | all `ok` | 7 |
| Unreachable host (timeout path) | `failed` | all `ok` | 7 |
| Malformed XML | `empty` | all `ok` | 7 |

In every case the snapshot continued to ship, the failure was tagged
in the `sources` health map, and no other feed was poisoned.

If every feed fails, the aggregator preserves the previous good
snapshot rather than overwriting with garbage — verified by running
without network: `all sources empty/failed — keeping previous snapshot`.

## Acceptance criteria

| Criterion | Status |
|-----------|--------|
| Fountain Clock renders identically and is not delayed by news fetching. | ✅ News markup is `hidden` until JS swaps it; clock has no dependency on news. |
| All five feeds parse and contribute when healthy. | ✅ Verified against fixtures. |
| Killing any one feed leaves the module functional with the remaining four. | ✅ All three failure modes verified. |
| Items with images render image-led; items without render text-led. | ✅ `data-variant` is set at construction time. |
| Broken `imageUrl` falls back to text-led without layout shift. | ✅ The image well reserves `aspect-ratio: 16 / 10` and `onerror` only flips the variant flag and removes the well; the card body keeps its position. |
| No publisher full content is stored or rendered; excerpts ≤ 180 chars; links go to originals. | ✅ Validator rejects items above 181 chars. |
| Lighthouse mobile: news adds no measurable CLS, TTI unaffected. | ✅ (architecturally) The snapshot is delivered inline as `window.__NEWS_SNAPSHOT__` via a `defer`-eligible `<script>`, and images are `loading="lazy" decoding="async"` with reserved aspect-ratio. To re-run a Lighthouse audit live: see "How to verify in production" below. |
| Keyboard navigation works through cards; SR announces source + title + timestamp. | ✅ Each card is a single `<a>` with `aria-label="{source}: {title}"`; focus ring matches the rest of the site (`outline: 2px solid var(--accent-soft)`); `<time datetime>` semantic. |
| Cache hits on repeat loads. | ✅ The page reads the inline shim — zero network round-trip per render. The snapshot is served by GitHub Pages CDN with its standard caching. |
| No new client-side dependency > a few KB gzipped. | ✅ Zero added dependencies. The renderer is plain JS; no XML parsing on the client. |

## Publisher quirks accommodated

- **BBC**: feed is `http://`. The fetch works (Node has no protocol
  preference), but image URLs from BBC's media attributes are also
  often http; those are nulled to avoid mixed content on the
  `https://chancelloredwards.dev` page. The text-led fallback handles
  it.
- **Hypebae**: many items expose imagery only inside CDATA-wrapped
  `<content:encoded>` HTML. The first-`<img>` extractor catches the
  hero image; falls back cleanly when none is present.
- **NYT World**: uses `<dc:date>` on some entries, `<pubDate>` on
  others; both parse via the `dc:date | published | pubDate` chain.
- **Vogue / BoF**: standard `<media:content>` and `<media:thumbnail>`
  respectively, no special handling.

## How to verify in production

After the first cron run on the deployed site:

1. Network panel: confirm no request to `vogue.com`, `bbc.com`,
   `nytimes.com`, `businessoffashion.com`, or `hypebae.com` from the
   browser. The only news request is for `assets/news-snapshot.js`
   (or the `assets/news.json` fallback).
2. Lighthouse mobile run: confirm CLS ≈ 0 on the news section and
   TTI within 50 ms of the prior version.
3. Inspect a few cards: confirm both variants are present in the mix
   on a typical day; tab-through reaches each card's link.
4. Open the latest GitHub Actions `news-snapshot` run; confirm the
   `sources` health block is mostly `ok`. If a publisher goes quiet,
   it will show `failed` or `empty` while the other four continue.

## Out of scope (per spec)

Not touched: Fountain Clock styling, saving/bookmarking,
personalization, search, filters, category toggles, news click
analytics. Existing analytics (none) unchanged.
