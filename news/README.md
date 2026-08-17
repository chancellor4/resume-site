# Ambient News Surface — v1.1

A calm, image-aware, build-time newsstand for the Fountain Clock
homepage. Twelve publisher feeds, one normalized shape, balanced by
publisher so no source dominates. Metadata-only, outbound links, no
client-side feed fetching.

## Architecture at a glance

```
                  ┌──────────────────────────┐
   GitHub Actions ─▶ │  news/aggregate.mjs    │
   (every 30 min)    │  fetch → parse →       │
                  │  normalize → validate     │
                  │  → dedupe → interleave    │
                  │  → cap 12                 │
                  └──────────┬───────────────┘
                             │ writes
                             ▼
                  /assets/news.json + /assets/news-snapshot.js
                             │ committed by the workflow
                             ▼
                       homepage (index.html)
                       js/news-surface.js
                       (renders cards; never fetches RSS)
```

The browser never hits publisher RSS. The "server-side fetch + cache"
intent of the v1.1 spec is satisfied by a build-time aggregator on a
GitHub Actions cron. Effective freshness: ~30 min, best-effort.

## Sources

| Source | sourceType | Publisher endpoint |
|---|---|---|
| New York Times | `world-news` | `https://rss.nytimes.com/services/xml/rss/nyt/World.xml` |
| NYLON | `youth-culture` | `https://www.nylon.com/rss` |
| Eater | `food-culture` | `https://www.eater.com/rss/index.xml` |
| Texas Monthly | `regional-culture` | `https://www.texasmonthly.com/feed/` |
| NPR | `practical-life` | `https://feeds.npr.org/510338/podcast.xml` |
| Positive News | `solutions-news` | `https://www.positive.news/feed/` |
| Vogue | `fashion-authority` | `https://www.vogue.com/feed/rss` |
| Architectural Digest | `design` | `https://www.architecturaldigest.com/feed/rss` |
| BBC | `global-affairs` | `http://feeds.bbci.co.uk/news/world/rss.xml` |
| Forbes | `business` | `https://www.forbes.com/business/feed/` |
| InStyle | `fashion-authority` | `https://feeds-api.dotdashmeredith.com/v1/rss/google/8e4da836-f458-4776-856b-0a481d6dc617` |
| Hypebae | `youth-culture` | `https://hypebae.com/feed` |

All endpoints are publisher-owned or publisher-operated feeds. Eater's
endpoint is Atom; the others are RSS. Forbes' Business page advertises
its publisher-owned feed in page metadata. InStyle's feed is served by
its publisher, Dotdash Meredith.

The mix is round-robin across publishers in registry order and sorted
by recency within each publisher. The homepage is capped at 12 cards;
no source repeats before every preceding healthy source has had a turn.
Canonical URLs are deduplicated after tracking parameters are removed;
near-identical titles are deduplicated only within a 36-hour window.

## Files

| File | Role |
|------|------|
| `aggregate.mjs` | The runner. Dependency-free Node ESM. Fetch → parse → normalize → validate → interleave → write snapshot. |
| `lib/schema.ts` | Typed mirror of the runtime contract (Zod). Documentation for the future Next.js path. |
| `lib/fetchers.ts` | Typed source registry + fetch helper. |
| `lib/normalize.ts` | Typed normalizers + interleave helper. |
| `api/news.route.ts` | Future-state Next.js route handler with Upstash Redis cache. Not run today. |
| `../.github/workflows/news.yml` | Cron + commit-on-change. |
| `../assets/news.json` | The committed snapshot. |
| `../assets/news-snapshot.js` | Same payload as `window.__NEWS_SNAPSHOT__`, included via `<script>` so the homepage works under `file://` and is race-free. |

## NewsItem schema (v1.1)

```ts
type NewsItem = {
  title:       string;       // ≤ 280 chars
  source:      string;       // display label, e.g. "New York Times"
  sourceType:
    | 'fashion-authority' | 'fashion-business' | 'business'
    | 'youth-culture'
    | 'global-affairs'    | 'world-news'      | 'practical-life'
    | 'food-culture'      | 'design'          | 'regional-culture'
    | 'solutions-news'    | 'local-news';
  link:        string;       // canonical publisher URL
  publishedAt: string;       // ISO 8601, UTC
  excerpt:     string;       // ≤ ~180 chars, plain text, no HTML
  imageUrl:    string | null; // null when missing/blocked/ambiguous
};
```

Image extraction order: `<media:content>` → `<media:thumbnail>` →
`<enclosure type="image/*">` → first `<img>` in `content:encoded` or
Atom `content` → `null`. Non-https image URLs are coerced to `null` so the page never
tries to render mixed content; the renderer falls back to a text-led
card without layout shift.

## Local refresh

```bash
node news/aggregate.mjs
```

You can point any feed at a local fixture for testing:

```bash
NEWS_OUTPUT_PATH=/tmp/test.json \
VOGUE_URL_OVERRIDE=http://127.0.0.1:8765/vogue.xml \
node news/aggregate.mjs
```

## Failure isolation

1. Each feed: 5 s default timeout, isolated try/catch. NPR gets
   12 s because its official podcast feed is substantially larger. Each
   source is marked `ok` / `empty` / `failed`.
2. At least one feed produced items → fresh snapshot is written.
3. Every feed empty/failed → previous snapshot is preserved.
4. The aggregator never exits non-zero, so the cron never breaks.

The homepage never waits on a live upstream request.
