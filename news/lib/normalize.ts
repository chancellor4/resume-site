/*
  normalize.ts — Ambient News Surface (v1.1)
  Pure functions that turn raw upstream payloads into NewsItem[].
  Validation lives at the boundary; anything malformed is dropped
  silently rather than corrupting the snapshot.

  Mirrors the runtime logic in news/aggregate.mjs. Keep them in sync.
*/

import { NewsItem, type NewsSourceType } from './schema';

const EXCERPT_MAX = 180;

/* ── Tiny utilities ─────────────────────────────────────────── */

function toIso(d: unknown): string | null {
  if (typeof d !== 'string' || !d) return null;
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString();
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    return firstString((value as Record<string, unknown>)['#text']);
  }
  return null;
}

function clamp(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function stripHtml(s: string | null): string | null {
  if (!s) return null;
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s*The post .+ appeared first on .+\.?$/i, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function isHttpsUrl(u: string | null | undefined): boolean {
  if (typeof u !== 'string') return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

/* ── RSS normalization ──────────────────────────────────────── */

interface RssRaw {
  rss?: {
    channel?: {
      item?: Array<Record<string, unknown>> | Record<string, unknown>;
    };
  };
  feed?: {
    entry?: Array<Record<string, unknown>> | Record<string, unknown>;
  };
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function pickLink(e: Record<string, unknown>): string | null {
  if (typeof e.link === 'string') return e.link;
  if (Array.isArray(e.link)) {
    const alt = (e.link as Array<Record<string, unknown>>).find((l) => l['@_rel'] !== 'self');
    return firstString((alt ?? e.link[0])?.['@_href' as keyof typeof alt]);
  }
  if (typeof e.link === 'object' && e.link) {
    return firstString((e.link as Record<string, unknown>)['@_href']);
  }
  return null;
}

/* Image extraction order (per spec):
     <media:content> → <media:thumbnail> → <enclosure type="image/*">
     → first <img> in <content:encoded> → null
   Non-https URLs and ambiguous types are nulled — the renderer falls
   back to a text-led card without layout shift. */
function pickImage(e: Record<string, unknown>): string | null {
  const candidates: Array<{ url?: unknown; type?: unknown }> = [];

  const mc = e['media:content'];
  if (Array.isArray(mc)) candidates.push(...mc as Array<{ url?: unknown; type?: unknown }>);
  else if (mc && typeof mc === 'object') candidates.push(mc as { url?: unknown; type?: unknown });

  const mt = e['media:thumbnail'];
  if (Array.isArray(mt)) candidates.push(...mt as Array<{ url?: unknown; type?: unknown }>);
  else if (mt && typeof mt === 'object') candidates.push(mt as { url?: unknown; type?: unknown });

  const enc = e.enclosure;
  if (Array.isArray(enc)) candidates.push(...enc as Array<{ url?: unknown; type?: unknown }>);
  else if (enc && typeof enc === 'object') candidates.push(enc as { url?: unknown; type?: unknown });

  for (const c of candidates) {
    const url  = (c as Record<string, unknown>)['@_url'];
    const type = (c as Record<string, unknown>)['@_type'];
    if (typeof url !== 'string' || !isHttpsUrl(url)) continue;
    if (typeof type === 'string' && !type.startsWith('image/')) continue;
    return url;
  }

  // First <img> inside content:encoded.
  const ce = e['content:encoded'] ?? e.content;
  const ceText =
    typeof ce === 'string' ? ce :
    (ce && typeof ce === 'object' && typeof (ce as Record<string, unknown>)['#text'] === 'string')
      ? (ce as Record<string, unknown>)['#text'] as string
      : null;
  if (ceText) {
    const m = ceText.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
    if (m && isHttpsUrl(m[1])) return m[1];
  }

  return null;
}

export function normalizeRssFeed(
  spec: { source: string; sourceType: NewsSourceType },
  raw: unknown,
): NewsItem[] {
  const r = raw as RssRaw;
  const entries = toArray(r?.rss?.channel?.item ?? r?.feed?.entry);

  const items = entries.map((e) => {
    const title   = textValue(e.title);
    const link    = pickLink(e);
    const pub     = firstString(e.pubDate, e.published, e.updated, e['dc:date']);
    const summary = stripHtml(firstString(
      textValue(e.description),
      textValue(e.summary),
      textValue(e.content),
      textValue(e['content:encoded']),
    ));

    const candidate = {
      title:       title ?? '',
      source:      spec.source,
      sourceType:  spec.sourceType,
      link:        link ?? '',
      publishedAt: toIso(pub) ?? '',
      excerpt:     clamp(summary, EXCERPT_MAX) ?? '',
      imageUrl:    pickImage(e),
    };

    const parsed = NewsItem.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  });

  return items.filter((x): x is NewsItem => x !== null);
}

/* ── Curation helpers ───────────────────────────────────────── */

export function sortByRecency(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));
}

function canonicalLink(link: string): string {
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

function titleTokens(title: string): Set<string> {
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

function titleSimilarity(a: string, b: string): number {
  const aa = titleTokens(a);
  const bb = titleTokens(b);
  if (aa.size < 3 || bb.size < 3) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection++;
  return intersection / (aa.size + bb.size - intersection);
}

export function deduplicateItems(items: NewsItem[]): NewsItem[] {
  const kept: NewsItem[] = [];
  const links = new Set<string>();
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

/* Round-robin by sourceType so the surface reads as a balanced
   worldview rather than five clumps. The order argument should match
   the SOURCES registry order so the rhythm is stable across rebuilds. */
export function interleaveBySource(
  items: NewsItem[],
  order: string[],
): NewsItem[] {
  const buckets = new Map<string, NewsItem[]>();
  for (const it of items) {
    if (!buckets.has(it.source)) buckets.set(it.source, []);
    buckets.get(it.source)!.push(it);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));
  }
  const out: NewsItem[] = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const t of order) {
      const arr = buckets.get(t);
      if (arr && arr.length) { out.push(arr.shift()!); drained = false; }
    }
  }
  return out;
}
