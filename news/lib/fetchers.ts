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
}> = [
  { key: 'Vogue',             source: 'Vogue',               sourceType: 'fashion-authority', url: 'https://www.vogue.com/feed/rss' },
  { key: 'BusinessOfFashion', source: 'Business of Fashion', sourceType: 'fashion-business',  url: 'https://www.businessoffashion.com/feeds/news' },
  { key: 'Hypebae',           source: 'Hypebae',             sourceType: 'youth-culture',     url: 'https://hypebae.com/feed' },
  { key: 'BBCWorld',          source: 'BBC World',           sourceType: 'global-affairs',    url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { key: 'NYTWorld',          source: 'NYT World',           sourceType: 'world-news',        url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
];

const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
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
  const res = await fetchWithTimeout(spec.url);
  if (!res.ok) throw new Error(`${spec.key} responded ${res.status}`);
  const text = await res.text();
  return normalizeRssFeed(spec, xml.parse(text));
}
