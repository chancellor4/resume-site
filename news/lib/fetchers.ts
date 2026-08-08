/*
  fetchers.ts — Ambient News Surface (v1.1)
  Source-specific fetch logic for the typed Next.js mirror path. Each
  fetcher returns a normalized NewsItem[] or throws. The orchestrator
  catches per-source failures so one bad upstream never poisons the
  whole snapshot.

  Today's static site runs the dependency-free aggregator at
  `news/aggregate.mjs`. This module stays in lockstep so the future
  Next.js + cache deployment is a one-import change.

  No full-text mirroring. No paywall bypass. No client-side scraping.
*/

import { XMLParser } from 'fast-xml-parser';
import type { NewsItem, NewsSourceType } from './schema';
import { normalizeRssFeed } from './normalize';

/* The five v1.1 sources, mirrored from news/aggregate.mjs SOURCES. */
export const SOURCES: Array<{
  key:        string;
  source:     string;
  sourceType: NewsSourceType;
  url:        string;
  timeoutMs?: number;
}> = [
  { key: 'Vogue',             source: 'Vogue',               sourceType: 'fashion-authority', url: 'https://www.vogue.com/feed/rss' },
  { key: 'BusinessOfFashion', source: 'Business of Fashion', sourceType: 'fashion-business',  url: 'https://www.businessoffashion.com/feeds/news' },
  { key: 'Hypebae',           source: 'Hypebae',             sourceType: 'youth-culture',     url: 'https://hypebae.com/feed' },
  { key: 'BBCWorld',          source: 'BBC World',           sourceType: 'global-affairs',    url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { key: 'NYTWorld',          source: 'NYT World',           sourceType: 'world-news',        url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  { key: 'NPRLifeKit',        source: 'NPR Life Kit',        sourceType: 'practical-life',    url: 'https://feeds.npr.org/510338/podcast.xml', timeoutMs: 12000 },
  { key: 'Eater',             source: 'Eater',               sourceType: 'food-culture',      url: 'https://www.eater.com/rss/index.xml' },
  { key: 'ArchitecturalDigest', source: 'Architectural Digest', sourceType: 'design',          url: 'https://www.architecturaldigest.com/feed/rss' },
  { key: 'TexasMonthly',      source: 'Texas Monthly',       sourceType: 'regional-culture',  url: 'https://www.texasmonthly.com/feed/' },
  { key: 'PositiveNews',      source: 'Positive News',       sourceType: 'solutions-news',    url: 'https://www.positive.news/feed/' },
  { key: 'NYLON',             source: 'NYLON',               sourceType: 'youth-culture',     url: 'https://www.nylon.com/rss' },
  { key: 'InStyle',           source: 'InStyle',             sourceType: 'fashion-authority', url: 'https://feeds-api.dotdashmeredith.com/v1/rss/google/8e4da836-f458-4776-856b-0a481d6dc617' },
  { key: 'WWNO',              source: 'WWNO',                sourceType: 'local-news',         url: 'https://www.wwno.org/local-regional-news.rss' },
];

const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: {
        'user-agent': 'fountain-clock-news/1.1 (+https://chancelloredwards.dev)',
        accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

export async function fetchSource(spec: typeof SOURCES[number]): Promise<NewsItem[]> {
  const res = await fetchWithTimeout(spec.url, undefined, spec.timeoutMs);
  if (!res.ok) throw new Error(`${spec.key} responded ${res.status}`);
  const text = await res.text();
  if (!/<(?:rss|feed)\b/i.test(text)) throw new Error(`${spec.key} returned a non-feed response`);
  return normalizeRssFeed(spec, xml.parse(text));
}
