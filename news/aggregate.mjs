#!/usr/bin/env node
/*
  aggregate.mjs — Ambient News Surface (v1.1)

  Fetches publisher RSS feeds server-side, normalizes them into a single
  NewsItem shape, interleaves by sourceType so no publisher dominates,
  caps the mix, and writes a snapshot the homepage reads at render time.

  This is the build-time variant. The browser never hits publisher RSS;
  it only ever reads the snapshot we commit. A GitHub Actions cron
  re-runs this script on a schedule and commits the regenerated artifact
  so freshness lands without standing up a server.

  Inputs (env):
    NEWS_OUTPUT_PATH  — optional override; defaults to ../assets/news.json
    *_URL_OVERRIDE    — per-feed URL overrides for testing (see SOURCES)

  Behavior:
    - Per source: ~5s timeout, isolated try/catch, marked ok/failed.
    - At least one source returned items → write a fresh snapshot.
    - Every source failed → leave the existing snapshot untouched.
    - Always exits 0; failures are logged but never break a CI cron.

  Sister files:
    - news/lib/schema.ts      — typed mirror of the same contract
    - news/lib/fetchers.ts    — typed fetchers (documentation, not run here)
    - news/lib/normalize.ts   — typed normalizers
    - news/api/news.route.ts  — Next.js future-path mirror
    Keep them in sync when the source list or shape changes.
*/

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.NEWS_OUTPUT_PATH
  ? path.resolve(process.env.NEWS_OUTPUT_PATH)
  : path.resolve(__dirname, '..', 'assets', 'news.json');
// Sibling JS shim so the homepage works under file:// too (no fetch needed).
const OUT_JS = OUT.replace(/\.json$/, '-snapshot.js');

const ITEM_CAP         = 12;     // spec: 12–18, picked low end for calm
const FETCH_TIMEOUT_MS = 5000;   // spec: ~5s
const EXCERPT_MAX      = 180;    // spec: ≤ ~180 chars

/* ── Source registry ─────────────────────────────────────────────
   One source of truth for the publisher feeds. sourceType drives the
   interleave; source is the human-readable display label. */
const SOURCES = [
  {
    key:        'Vogue',
    source:     'Vogue',
    sourceType: 'fashion-authority',
    url: process.env.VOGUE_URL_OVERRIDE || 'https://www.vogue.com/feed/rss',
  },
  {
    key:        'BusinessOfFashion',
    source:     'Business of Fashion',
    sourceType: 'fashion-business',
    url: process.env.BOF_URL_OVERRIDE || 'https://www.businessoffashion.com/feeds/news',
  },
  {
    key:        'Hypebae',
    source:     'Hypebae',
    sourceType: 'youth-culture',
    url: process.env.HYPEBAE_URL_OVERRIDE || 'https://hypebae.com/feed',
  },
  {
    key:        'BBCWorld',
    source:     'BBC World',
    sourceType: 'global-affairs',
    url: process.env.BBC_URL_OVERRIDE || 'http://feeds.bbci.co.uk/news/world/rss.xml',
  },
  {
    key:        'NYTWorld',
    source:     'NYT World',
    sourceType: 'world-news',
    url: process.env.NYT_WORLD_URL_OVERRIDE || 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  },
  {
    key:        'NPRLifeKit',
    source:     'NPR Life Kit',
    sourceType: 'practical-life',
    url: process.env.NPR_LIFE_KIT_URL_OVERRIDE || 'https://feeds.npr.org/510338/podcast.xml',
    timeoutMs:  12000,
  },
  {
    key:        'Eater',
    source:     'Eater',
    sourceType: 'food-culture',
    url: process.env.EATER_URL_OVERRIDE || 'https://www.eater.com/rss/index.xml',
  },
  {
    key:        'ArchitecturalDigest',
    source:     'Architectural Digest',
    sourceType: 'design',
    url: process.env.ARCHITECTURAL_DIGEST_URL_OVERRIDE || 'https://www.architecturaldigest.com/feed/rss',
  },
  {
    key:        'TexasMonthly',
    source:     'Texas Monthly',
    sourceType: 'regional-culture',
    url: process.env.TEXAS_MONTHLY_URL_OVERRIDE || 'https://www.texasmonthly.com/feed/',
  },
  {
    key:        'PositiveNews',
    source:     'Positive News',
    sourceType: 'solutions-news',
    url: process.env.POSITIVE_NEWS_URL_OVERRIDE || 'https://www.positive.news/feed/',
  },
  {
    key:        'Forbes',
    source:     'Forbes',
    sourceType: 'business',
    url: process.env.FORBES_URL_OVERRIDE || 'https://www.forbes.com/business/feed/',
  },
  {
    key:        'BlackEnterprise',
    source:     'Black Enterprise',
    sourceType: 'business',
    url: process.env.BLACK_ENTERPRISE_URL_OVERRIDE || 'https://www.blackenterprise.com/feed/',
  },
  {
    key:        'NYLON',
    source:     'NYLON',
    sourceType: 'youth-culture',
    url: process.env.NYLON_URL_OVERRIDE || 'https://www.nylon.com/rss',
  },
  {
    key:        'InStyle',
    source:     'InStyle',
    sourceType: 'fashion-authority',
    url: process.env.INSTYLE_URL_OVERRIDE || 'https://feeds-api.dotdashmeredith.com/v1/rss/google/8e4da836-f458-4776-856b-0a481d6dc617',
  },
  {
    key:        'WWNO',
    source:     'WWNO',
    sourceType: 'local-news',
    url: process.env.WWNO_URL_OVERRIDE || 'https://www.wwno.org/local-regional-news.rss',
  },
];

const ALLOWED_SOURCE_TYPES = new Set(SOURCES.map(s => s.sourceType));

/* ── Tiny utils ───────────────────────────────────────────────── */

const log = (...a) => console.log('[news]', ...a);

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: {
        'user-agent': 'fountain-clock-news/1.1 (+https://chancelloredwards.dev)',
        accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

function toIso(d) {
  if (typeof d !== 'string' || !d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function clamp(s, max) {
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function decodeXml(s) {
  if (!s) return null;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function stripHtml(s) {
  if (!s) return null;
  const out = decodeXml(s)
    .replace(/<[^>]+>/g, '')
    .replace(/\s*The post .+ appeared first on .+\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
}

function isHttpUrl(u) {
  if (typeof u !== 'string') return false;
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

/* The page is served over https; mixed-content images would be blocked
   anyway. Fall back to null for any non-https image URL — the renderer
   will gracefully draw a text-led card instead. */
function isHttpsUrl(u) {
  if (typeof u !== 'string') return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

/* ── Validator (mirrors news/lib/schema.ts NewsItem v1.1) ──────── */

function validateItem(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.title !== 'string' || !c.title || c.title.length > 280) return null;
  if (typeof c.source !== 'string' || !c.source) return null;
  if (!ALLOWED_SOURCE_TYPES.has(c.sourceType)) return null;
  if (!isHttpUrl(c.link)) return null;
  if (typeof c.publishedAt !== 'string' || Number.isNaN(Date.parse(c.publishedAt))) return null;
  if (typeof c.excerpt !== 'string') return null;
  if (c.excerpt.length > EXCERPT_MAX + 1) return null;
  if (c.imageUrl !== null && !isHttpsUrl(c.imageUrl)) return null;
  return c;
}

/* ── RSS reader ───────────────────────────────────────────────────
   Dependency-free. Pulls only the fields we need from <item> blocks.
   We never trust upstream HTML; everything routes through stripHtml
   and the validator before reaching the snapshot. */

function unwrapCdata(s) {
  if (s == null) return null;
  return s.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim() || null;
}

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? unwrapCdata(m[1]) : null;
}

function pickAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}

/* For media:content / media:thumbnail / enclosure we also need the
   element's `type` attribute when present, so we can verify it's an
   image before trusting the URL. */
function pickAttrPair(block, tag, attrA, attrB) {
  // Match the *first* tag of this name and pull two named attributes
  // in either order.
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'i');
  const m = block.match(re);
  if (!m) return { [attrA]: null, [attrB]: null };
  const open = m[1];
  const grab = (name) => {
    const r = new RegExp(`\\b${name}=["']([^"']+)["']`, 'i');
    const mm = open.match(r);
    return mm ? mm[1] : null;
  };
  return { [attrA]: grab(attrA), [attrB]: grab(attrB) };
}

function parseFeedItems(xml) {
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  const blocks = xml.match(itemRe) || [];
  return blocks.map((block) => {
    // Image extraction: media:content → media:thumbnail → enclosure[image/*] → first <img> in content:encoded
    const mc        = pickAttrPair(block, 'media:content',   'url', 'type');
    const mt        = pickAttrPair(block, 'media:thumbnail', 'url', 'type');
    const enclosure = pickAttrPair(block, 'enclosure',       'url', 'type');

    const contentEncoded = pickTag(block, 'content:encoded') || pickTag(block, 'content');
    let firstContentImg = null;
    if (contentEncoded) {
      const m = contentEncoded.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
      if (m) firstContentImg = m[1];
    }

    return {
      title:       pickTag(block, 'title'),
      link:        pickTag(block, 'link') || pickAttr(block, 'link', 'href'),
      pubDate:     pickTag(block, 'pubDate') || pickTag(block, 'dc:date') || pickTag(block, 'published') || pickTag(block, 'updated'),
      description: pickTag(block, 'description') || pickTag(block, 'summary') || contentEncoded || pickTag(block, 'content'),

      // Ordered image candidates per spec.
      imageCandidates: [
        mc.url        ? { url: mc.url,        type: mc.type        } : null,
        mt.url        ? { url: mt.url,        type: mt.type        } : null,
        enclosure.url ? { url: enclosure.url, type: enclosure.type } : null,
        firstContentImg ? { url: firstContentImg, type: 'image/*' } : null,
      ].filter(Boolean),
    };
  });
}

/* Pick the first candidate that looks like an image *and* is https.
   Anything else (http-only, missing type, weird scheme) → null and the
   renderer falls back to a text-led card. */
function pickImage(candidates) {
  for (const c of candidates) {
    if (!c || !c.url) continue;
    const url = decodeXml(c.url);
    if (!isHttpsUrl(url)) continue;
    if (c.type && c.type !== 'image/*' && !c.type.startsWith('image/')) continue;
    return url;
  }
  return null;
}

/* ── Per-source fetch + normalize ─────────────────────────────── */

async function fetchSource(spec) {
  const res = await fetchWithTimeout(spec.url, {}, spec.timeoutMs);
  if (!res.ok) throw new Error(`${spec.key} responded ${res.status}`);
  const xml = await res.text();
  if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error(`${spec.key} returned a non-feed response`);
  const raw = parseFeedItems(xml);

  const items = raw.map((e) => {
    const candidate = {
      title:       (decodeXml(e.title) || '').trim(),
      source:      spec.source,
      sourceType:  spec.sourceType,
      link:        (decodeXml(e.link) || '').trim(),
      publishedAt: toIso(e.pubDate) ?? '',
      excerpt:     clamp(stripHtml(e.description), EXCERPT_MAX) ?? '',
      imageUrl:    pickImage(e.imageCandidates),
    };
    return validateItem(candidate);
  }).filter(Boolean);

  return items;
}

/* ── Curation: interleave by sourceType ───────────────────────── */

function canonicalLink(link) {
  try {
    const url = new URL(link);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|at_|campaign$|cmpid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return link;
  }
}

function titleTokens(title) {
  const stop = new Set(['the', 'and', 'for', 'from', 'with', 'that', 'this', 'after', 'into', 'over']);
  const normalized = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/defence/g, 'defense')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return new Set(normalized.split(/\s+/).filter(word => word.length > 2 && !stop.has(word)).map((word) => {
    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
    if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) return word.slice(0, -1);
    return word;
  }));
}

function titleSimilarity(a, b) {
  const aa = titleTokens(a);
  const bb = titleTokens(b);
  if (aa.size < 3 || bb.size < 3) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection++;
  return intersection / (aa.size + bb.size - intersection);
}

function deduplicateItems(items) {
  const kept = [];
  const links = new Set();
  const windowMs = 36 * 60 * 60 * 1000;

  for (const item of items) {
    const link = canonicalLink(item.link);
    if (links.has(link)) continue;
    const duplicateTitle = kept.some(other =>
      Math.abs(+new Date(item.publishedAt) - +new Date(other.publishedAt)) <= windowMs &&
      titleSimilarity(item.title, other.title) >= 0.78
    );
    if (duplicateTitle) continue;
    links.add(link);
    kept.push(item);
  }
  return kept;
}

function interleaveBySource(items, order = SOURCES.map(s => s.source)) {
  // Bucket by sourceType, sort each bucket by recency, then round-robin.
  const buckets = new Map();
  for (const it of items) {
    if (!buckets.has(it.source)) buckets.set(it.source, []);
    buckets.get(it.source).push(it);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));
  }
  // Round-robin in the order the SOURCES registry declares so the mix
  // reads with a stable rhythm rather than alphabetic noise.
  const out = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const t of order) {
      const arr = buckets.get(t);
      if (arr && arr.length) {
        out.push(arr.shift());
        drained = false;
      }
    }
  }
  return out;
}

/* ── Snapshot I/O ─────────────────────────────────────────────── */

async function readPrevious() {
  try {
    const buf = await fs.readFile(OUT, 'utf8');
    const j = JSON.parse(buf);
    return j && Array.isArray(j.items) ? j : null;
  } catch { return null; }
}

async function writeSnapshot(snapshot) {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(OUT, json + '\n', 'utf8');
  const js =
    '/* generated by news/aggregate.mjs — do not edit by hand */\n' +
    'window.__NEWS_SNAPSHOT__ = ' + json + ';\n';
  await fs.writeFile(OUT_JS, js, 'utf8');
}

/* ── Main ─────────────────────────────────────────────────────── */

async function main() {
  const sourcesHealth = Object.fromEntries(SOURCES.map(s => [s.key, 'skipped']));
  const merged = [];

  const settled = await Promise.allSettled(SOURCES.map(s => fetchSource(s)));
  settled.forEach((r, i) => {
    const spec = SOURCES[i];
    if (r.status === 'fulfilled') {
      sourcesHealth[spec.key] = r.value.length > 0 ? 'ok' : 'empty';
      merged.push(...r.value);
      log(`${spec.key}: ${r.value.length} items`);
    } else {
      sourcesHealth[spec.key] = 'failed';
      log(`${spec.key} failed:`, r.reason?.message ?? r.reason);
    }
  });

  if (merged.length === 0) {
    const prev = await readPrevious();
    if (prev) { log('all sources empty/failed — keeping previous snapshot'); return; }
    const empty = {
      version:     '1.1',
      generatedAt: new Date().toISOString(),
      items:       [],
      sources:     sourcesHealth,
    };
    await writeSnapshot(empty);
    log('wrote empty snapshot →', OUT);
    return;
  }

  const items = interleaveBySource(deduplicateItems(merged)).slice(0, ITEM_CAP);
  const snapshot = {
    version:     '1.1',
    generatedAt: new Date().toISOString(),
    items,
    sources:     sourcesHealth,
  };

  await writeSnapshot(snapshot);
  log(`wrote ${items.length} items → ${OUT} + ${OUT_JS}`);
}

export { deduplicateItems, interleaveBySource, parseFeedItems };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Never break the cron; just leave the previous snapshot in place.
    console.error('[news] fatal:', err);
  });
}
