/*
  schema.ts — Ambient News Surface (v1.1)
  The single contract every part of the system reads and writes.

  Per the v1.1 spec: every item is normalized into one strict shape
  before caching or rendering. Zod validates the shape at the boundary
  so malformed feed data never reaches the homepage.

  Mirrors the runtime validator in news/aggregate.mjs. Keep them in
  sync when the source list or shape changes.
*/

import { z } from 'zod';

/* The five sourceType buckets the homepage interleaves across. The
   `source` field carries the human-readable display label
   (e.g. "Business of Fashion") and is free-form text. */
export const NewsSourceType = z.enum([
  'fashion-authority',  // Vogue
  'fashion-business',   // Business of Fashion
  'youth-culture',      // Hypebae
  'global-affairs',     // BBC World
  'world-news',         // NYT World
]);
export type NewsSourceType = z.infer<typeof NewsSourceType>;

export const NewsItem = z.object({
  title:       z.string().min(1).max(280),
  source:      z.string().min(1).max(80),
  sourceType:  NewsSourceType,
  link:        z.string().url(),
  publishedAt: z.string().datetime(),       // ISO 8601, UTC
  excerpt:     z.string().max(181),          // ≤ ~180 chars, plain text
  imageUrl:    z.string().url().nullable(), // null when missing/blocked/ambiguous
});
export type NewsItem = z.infer<typeof NewsItem>;

/* Per-source health surfaces in the snapshot so a future status panel,
   or a CI smoke test, can tell at a glance whether a feed has gone
   quiet without the homepage caring. */
export const SourceHealth = z.enum(['ok', 'empty', 'failed', 'skipped']);
export type SourceHealth = z.infer<typeof SourceHealth>;

/* The cached payload that lives on disk (assets/news.json) and is
   read by the homepage. Wrapping the array gives us a stable place
   for snapshot metadata without changing the item shape. */
export const NewsSnapshot = z.object({
  version:     z.literal('1.1'),
  generatedAt: z.string().datetime(),
  items:       z.array(NewsItem).max(18),
  sources: z.object({
    Vogue:             SourceHealth,
    BusinessOfFashion: SourceHealth,
    Hypebae:           SourceHealth,
    BBCWorld:          SourceHealth,
    NYTWorld:          SourceHealth,
  }),
});
export type NewsSnapshot = z.infer<typeof NewsSnapshot>;

/* Centralizing the cap here keeps the curation rule in one place. */
export const HOMEPAGE_ITEM_CAP = 12;
