import type { PullRequestReference } from '../models/pull-request.ts';

export function pullRequestReferences(
  value: unknown,
  states?: unknown,
): PullRequestReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw): PullRequestReference[] => {
    if (
      !raw ||
      typeof raw.url !== 'string' ||
      !['open', 'closed', 'merged', 'draft'].includes(raw.status)
    )
      return [];
    const match =
      /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/([A-Za-z0-9_.-]{1,100}))\/pull\/([1-9]\d*)\/?$/.exec(
        raw.url.trim(),
      );
    if (!match || ['.', '..'].includes(match[2])) return [];
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number)) return [];
    const url = `https://github.com/${match[1]}/pull/${number}`;
    if (seen.has(url.toLowerCase())) return [];
    seen.add(url.toLowerCase());
    const state =
      states && typeof states === 'object'
        ? (states as Record<string, { s?: unknown }>)[raw.url]?.s
        : undefined;
    const mergeState =
      states && typeof states === 'object'
        ? (states as Record<string, { m?: unknown }>)[raw.url]?.m
        : undefined;
    const merge =
      typeof mergeState === 'string' && ['c', 'b', 'd', 'h', 'u'].includes(mergeState)
        ? (mergeState as PullRequestReference['merge'])
        : undefined;
    const ci =
      typeof state === 'string' && ['s', 'f', 'p', 'e', 'x'].includes(state)
        ? (state as PullRequestReference['ci'])
        : undefined;
    return [{ url, repository: match[1], number, status: raw.status, ci, merge }];
  });
}
