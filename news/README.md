# Ambient News Surface — v1.1

A calm, image-aware, build-time newsstand for the Fountain Clock
homepage. Five RSS feeds, one normalized shape, balanced by
`sourceType` so no publisher dominates. Metadata-only, outbound links,
no client-side feed fetching.

## Architecture at a glance

```
                  ┌──────────────────────────┐
   GitHub Actions ─▶ │  news/aggregate.mjs    │
   (every 30 min)    │  fetch → parse →       │
                  │  normalize → validate     │
                  │  → interleave → cap 12    │
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

## Five sources, five buckets

| Source              | sourceType          | Feed |
|---------------------|---------------------|------|
| Vogue               | `fashion-authority` | `https://www.vogue.com/feed/rss` |
| Business of Fashion | `fashion-business`  | `https://www.businessoffashion.com/feeds/news` |
| Hypebae             | `youth-culture`     | `https://hypebae.com/feed` |
| BBC World           | `global-affairs`    | `http://feeds.bbci.co.uk/news/world/rss.xml` |
| NYT World           | `world-news`        | `https://rss.nytimes.com/services/xml/rss/nyt/World.xml` |

The mix is round-robin across `sourceType` in registry order, recency-
sorted within each bucket. The first 5 items pull one from each
bucket; subsequent items continue the rotation while any bucket has
content left.

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
  source:      string;       // display label, e.g. "Business of Fashion"
  sourceType:
    | 'fashion-authority' | 'fashion-business' | 'youth-culture'
    | 'global-affairs'    | 'world-news';
  link:        string;       // canonical publisher URL
  publishedAt: string;       // ISO 8601, UTC
  excerpt:     string;       // ≤ ~180 chars, plain text, no HTML
  imageUrl:    string | null; // null when missing/blocked/ambiguous
};
```

Image extraction order: `<media:content>` → `<media:thumbnail>` →
`<enclosure type="image/*">` → first `<img>` in `content:encoded` →
`null`. Non-https image URLs are coerced to `null` so the page never
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

1. Each feed: ~5 s timeout, isolated try/catch. Marked `ok` / `empty` / `failed`.
2. At least one feed produced items → fresh snapshot is written.
3. Every feed empty/failed → previous snapshot is preserved.
4. The aggregator never exits non-zero, so the cron never breaks.

The homepage never waits on a live upstream request.
