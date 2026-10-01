/** Numeric-only diagnostics from the exact, authenticated viewer. Never accept
 * arbitrary strings, URLs, input contents, images or nested objects into reports.
 */
const fields = [
  'sourceFps',
  'sentFps',
  'sourceMbps',
  'sentMbps',
  'sentFrames',
  'idleRefreshFrames',
  'codecH264',
  'codecFallback',
  'decoderQueue',
  'encoderBitrate',
  'keyframeRequests',
  'upstreamGaps',
  'queuedFrames',
  'queuedBytes',
  'droppedFrames',
  'inFlightFrames',
  'inFlightBytes',
  'oldestFrameMs',
  'ackMs',
  'ackIdleMs',
  'rttMs',
  'targetFps',
  'baseRttMs',
  'deliveryMbps',
  'pacingMbps',
  'windowBytes',
  'scale',
  'receivedFps',
  'paintedFps',
  'receivedMbps',
  'averageFrameBytes',
  'decodeMs',
  'decodeP95Ms',
  'viewerDroppedFrames',
  'decodeErrors',
  'coalescedMoves',
  'width',
  'height',
  'inputBufferedBytes',
  'elapsedMs',
  'gatewaySampleAgeMs',
] as const;

export type IosSimulatorPerformance = Partial<Record<(typeof fields)[number], number>> & {
  connected: boolean;
  remote: boolean;
};
export type IosSimulatorPerformanceReport = {
  latest: IosSimulatorPerformance;
  samples: IosSimulatorPerformance[];
  ageMs: number;
};

export function parseIosSimulatorPerformance(value: unknown): IosSimulatorPerformance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.connected !== 'boolean' || typeof raw.remote !== 'boolean') return null;
  const result: IosSimulatorPerformance = { connected: raw.connected, remote: raw.remote };
  for (const key of fields) {
    const number = raw[key];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1e12)
      return null;
    result[key] = number;
  }
  return result;
}
