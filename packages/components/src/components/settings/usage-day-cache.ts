import { atom } from 'jotai';
import { z } from 'zod';
import { createLocalStorageCache } from '@/lib/local-storage-cache';
import type { SettingsUsageDayData } from './settings-data-cache';

export const USAGE_DAY_CACHE_TTL_MS = 60 * 60 * 1000;
export const MAX_CACHED_USAGE_DAYS = 128;

const usageDaySchema: z.ZodType<SettingsUsageDayData> = z.object({
  workspaceId: z.string(),
  dayStartMs: z.number(),
  date: z.string(),
  totals: z.object({
    tokens: z.number(),
    costUSD: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    reasoningOutputTokens: z.number(),
    webSearchRequests: z.number(),
  }),
  byModel: z.array(z.object({ modelId: z.string(), tokens: z.number(), costUSD: z.number() })),
  byUser: z.array(z.object({ userId: z.string(), tokens: z.number(), costUSD: z.number() })),
  users: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      image: z.string().nullable().optional(),
    })
  ),
});

const cacheSchema = z.object({
  authSessionId: z.string().nullable(),
  days: z
    .array(z.object({ fetchedAt: z.number(), day: usageDaySchema }))
    .max(MAX_CACHED_USAGE_DAYS),
});

export type UsageDayCache = z.infer<typeof cacheSchema>;
export const EMPTY_USAGE_DAY_CACHE: UsageDayCache = { authSessionId: null, days: [] };

const storage = createLocalStorageCache('lody:usageDayDetails', cacheSchema);

// Consumers read disk before querying when this atom is null. App-store
// recreation must not turn a fresh disk hit into a request.
export const usageDayCacheAtom = atom<UsageDayCache | null>(null);

export function readUsageDayCache(): UsageDayCache {
  return storage.get('current') ?? EMPTY_USAGE_DAY_CACHE;
}

export function writeUsageDayCache(cache: UsageDayCache): void {
  if (cache.authSessionId) storage.set('current', cache);
  else storage.remove('current');
}
