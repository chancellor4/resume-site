/*
  app/api/news/route.ts — Ambient News Surface (canonical Next.js mirror, v1.1)

  This is the future-state deployment shape: a Next.js App Router route
  handler running on the Node runtime, refreshed by Vercel Cron, cached
  in Upstash Redis. The static homepage in this repo currently reads
  `/assets/news.json` (built by news/aggregate.mjs on a schedule), but
  every line of business logic — fetch → normalize → validate →
  cache-with-fallback — lives in the same shared modules under
  `news/lib/*`, so swapping in this handler is a one-import change.

  Failure isolation:
    1. render the current cached payload
    2. if the cache is empty, render nothing
    3. if one source fails, omit only that source
    4. if all sources fail, keep the previous good snapshot
*/

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import {
  NewsSnapshot,
  HOMEPAGE_ITEM_CAP,
  type NewsItem,
  type SourceHealth,
} from '../../news/lib/schema';
import { fetchSource, SOURCES } from '../../news/lib/fetchers';
import { deduplicateItems, interleaveBySource } from '../../news/lib/normalize';

export const runtime = 'nodejs';
export const revalidate = 900; // 15 min — soft freshness window

const CACHE_KEY    = 'news:snapshot:v1.1';
const FALLBACK_KEY = 'news:snapshot:v1.1:fallback';
const CACHE_TTL_S  = 60 * 60; // 1 hour hard ceiling on the live cache

const redis = Redis.fromEnv();

/* ── GET: read-only homepage endpoint ─────────────────────────── */

export async function GET() {
  const snapshot = await redis.get<unknown>(CACHE_KEY);
  const parsed = NewsSnapshot.safeParse(snapshot);
  if (parsed.success) return NextResponse.json(parsed.data);

  const fallback = await redis.get<unknown>(FALLBACK_KEY);
  const parsedFb = NewsSnapshot.safeParse(fallback);
  if (parsedFb.success) return NextResponse.json(parsedFb.data);

  return NextResponse.json(
    { version: '1.1', items: [] },
    { status: 200 },
  );
}

/* ── POST: refresh, called by Vercel Cron ─────────────────────── */

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sources = Object.fromEntries(
    SOURCES.map(s => [s.key, 'skipped' as SourceHealth]),
  ) as Record<string, SourceHealth>;

  const settled = await Promise.allSettled(SOURCES.map(s => fetchSource(s)));
  const merged: NewsItem[] = [];
  settled.forEach((r, i) => {
    const spec = SOURCES[i];
    if (r.status === 'fulfilled') {
      sources[spec.key] = r.value.length > 0 ? 'ok' : 'empty';
      merged.push(...r.value);
    } else {
      sources[spec.key] = 'failed';
    }
  });

  if (merged.length === 0) {
    return NextResponse.json(
      { refreshed: false, reason: 'all sources failed' },
      { status: 200 },
    );
  }

  const order = SOURCES.map(s => s.source);
  const items = interleaveBySource(deduplicateItems(merged), order).slice(0, HOMEPAGE_ITEM_CAP);

  const snapshot = NewsSnapshot.parse({
    version:     '1.1',
    generatedAt: new Date().toISOString(),
    items,
    sources,
  });

  // Live + fallback. Fallback never expires until the next successful
  // refresh overwrites it, so the homepage always has a last-known-good.
  await Promise.all([
    redis.set(CACHE_KEY, snapshot, { ex: CACHE_TTL_S }),
    redis.set(FALLBACK_KEY, snapshot),
  ]);

  return NextResponse.json({ refreshed: true, count: items.length });
}
