export type StreamsHttpFallbackReason = 'forced-sync' | 'snapshot-probe' | 'no-ws';

export type StreamsHttpFallbackCounts = Record<StreamsHttpFallbackReason, number>;

const counts: StreamsHttpFallbackCounts = {
  'forced-sync': 0,
  'snapshot-probe': 0,
  'no-ws': 0,
};

export function recordStreamsHttpFallback(reason: StreamsHttpFallbackReason): void {
  counts[reason] += 1;
}

export function getStreamsHttpFallbackCounts(): StreamsHttpFallbackCounts {
  return { ...counts };
}

export function resetStreamsHttpFallbackCounts(): void {
  counts['forced-sync'] = 0;
  counts['snapshot-probe'] = 0;
  counts['no-ws'] = 0;
}
